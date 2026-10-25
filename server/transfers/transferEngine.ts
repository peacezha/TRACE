import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PassThrough, Readable, Writable } from 'node:stream';
import { getTransferCredentials } from './transferCredentials';
import type {
  TransferTask,
  TransferDirection,
  ConflictPolicy,
  VerificationMode,
  TransferSourceFingerprint,
} from '../../shared/fileTransfer';
import { canTransitionTransfer } from '../../shared/fileTransfer';
import { saveTasks } from './transferStore';

// ---------------------------------------------------------------------------
//  Adapter interface -- all I/O is injected for testability
// ---------------------------------------------------------------------------

export interface TransferAdapter {
  remoteSize(remotePath: string, sessionId: string): Promise<number>;
  localSize(localPath: string): Promise<number>;
  remoteFingerprint(remotePath: string, sessionId: string): Promise<TransferSourceFingerprint>;
  localFingerprint(localPath: string): Promise<TransferSourceFingerprint>;
  openLocalRead(localPath: string, offset: number): Readable;
  openRemoteWrite(remotePath: string, offset: number, sessionId: string): Writable;
  openRemoteRead(remotePath: string, offset: number, sessionId: string): Readable;
  openLocalWrite(localPath: string, offset: number): Writable;
  verify(
    localPath: string,
    referencePath: string,
    mode: VerificationMode,
    context: { direction: TransferDirection; sessionId: string },
  ): Promise<void>;
  /** 双远端校验；sha256 模式缺少此能力时必须失败，禁止降级成 size。 */
  verifyRemoteCopy?(
    sourcePath: string,
    destinationPath: string,
    mode: VerificationMode,
    context: { sourceSessionId: string; destinationSessionId: string },
  ): Promise<void>;
  remoteRename(from: string, to: string, sessionId: string): Promise<void>;
  localRename(from: string, to: string): Promise<void>;
  remoteUnlink(path: string, sessionId: string): Promise<void>;
  localUnlink(path: string): Promise<void>;
  /** 在指定集群会话上执行 shell（直连互传用）；可选，缺失时互传走本机中转 */
  execRemote?(command: string, sessionId: string, timeoutMs?: number): Promise<string>;
  /** 会话的主机信息（直连互传探测用） */
  getSessionInfo?(sessionId: string): { host: string; port: number; username: string } | undefined;
  /** 集群互传前检查源可读与目标父目录可写，并仅补当前用户位。 */
  prepareRemoteCopy?(opts: {
    sourcePath: string;
    destinationPath: string;
    sourceSessionId: string;
    destinationSessionId: string;
  }): Promise<void>;
  /**
   * 会话保活：会话在且 connected → true；已知但断开 → 尝试静默重连，成功 true 失败 false；
   * 完全未知的会话 → false。注入后引擎在每个传输阶段开始前调用，
   * 避免大文件传到一半 SSH 断开直接判失败。
   */
  ensureSessionAlive?(sessionId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
//  Internal bookkeeping
// ---------------------------------------------------------------------------

/** 直连通道：目标主机信息 + 可用的 ssh 前缀（公钥 BatchMode 或 OTP wrapper） */
interface DirectLink {
  host: string;
  port: number;
  username: string;
  sshPrefix: string;
  /** OTP 路线在源集群落盘的临时文件（含明文凭据，任务终态必须清理）；公钥路线无 */
  otpTempFiles?: { credsFile: string; wrapper: string };
}

/**
 * 源集群上的 OTP 应答脚本（stdlib only）：
 * pty 驱动 ssh，见到 Password:/Verification code: 提示时从凭据文件取密码/现场算 TOTP 应答。
 */
const OTP_SSH_PY = `#!/usr/bin/env python3
import os, sys, pty, select, time, hmac, hashlib, base64, struct, tty

def b32decode(s):
    s = s.upper().replace('=', '').replace(' ', '')
    pad = (8 - len(s) % 8) % 8
    return base64.b32decode(s + '=' * pad)

def totp(secret):
    key = b32decode(secret)
    counter = int(time.time() // 30)
    digest = hmac.new(key, struct.pack('>Q', counter), hashlib.sha1).digest()
    off = digest[-1] & 0x0f
    return '%06d' % ((struct.unpack('>I', digest[off:off+4])[0] & 0x7fffffff) % 1000000)

def main():
    password = secret = ''
    try:
        for line in open(os.environ.get('TRACE_OTP_CREDS', '')):
            line = line.rstrip('\\n')
            if line.startswith('password='):
                password = line[len('password='):]
            elif line.startswith('secret='):
                secret = line[len('secret='):]
    except OSError:
        pass
    args = ['ssh'] + sys.argv[1:]
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(args[0], args)
    # 关键：pty 置 raw——默认行纪律（ICANON/ECHO/ICRNL/ONLCR）会改坏 rsync 二进制协议
    try:
        tty.setraw(fd)
    except Exception:
        pass
    buf = b''
    pw_sent = otp_sent = 0
    exitcode = 1
    last_io = time.time()
    while True:
        # 双向桥接：pty 输出 → 自己的 stdout；自己的 stdin → pty（rsync/scp 协议数据）
        r, _, _ = select.select([fd, 0], [], [], 1.0)
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            last_io = time.time()
            os.write(1, data)
            # 只在认证阶段做提示应答（协议开始后不再匹配）
            if pw_sent + otp_sent < 8:
                buf = (buf + data)[-400:]
                low = buf.lower()
                if (b'verification code' in low or '验证码'.encode('utf-8') in low or '动态码'.encode('utf-8') in low) and secret and otp_sent < 6:
                    time.sleep(0.3)
                    os.write(fd, (totp(secret) + '\\n').encode())
                    otp_sent += 1
                    buf = b''
                elif b'password:' in low:
                    time.sleep(0.3)
                    if pw_sent == 0 and password:
                        os.write(fd, (password + '\\n').encode())
                        pw_sent += 1
                    elif secret and otp_sent < 6:
                        os.write(fd, (totp(secret) + '\\n').encode())
                        otp_sent += 1
                    buf = b''
        if 0 in r:
            try:
                data = os.read(0, 65536)
            except OSError:
                data = b''
            if data:
                last_io = time.time()
                try:
                    os.write(fd, data)
                except OSError:
                    break
        try:
            done, status = os.waitpid(pid, os.WNOHANG)
            if done == pid:
                exitcode = os.waitstatus_to_exitcode(status)
                break
        except ChildProcessError:
            break
        # 空闲 10 分钟才超时（大文件传输不能用硬性短超时）
        if time.time() - last_io > 600:
            break
    # 子进程先结束时补取真实退出码
    try:
        _, status = os.waitpid(pid, 0)
        exitcode = os.waitstatus_to_exitcode(status)
    except (ChildProcessError, OSError):
        pass
    try:
        os.close(fd)
    except OSError:
        pass
    sys.exit(exitcode)
    try:
        os.close(fd)
    except OSError:
        pass
    sys.exit(exitcode)

if __name__ == '__main__':
    main()
`;

interface RunningTask {
  controller: AbortController;
  sessionId: string;
  /** 包含 executeTransfer 及执行额度结算；pause/cancel 必须等待它。 */
  done: Promise<void>;
}

// ---------------------------------------------------------------------------
//  TransferEngine
// ---------------------------------------------------------------------------

export class TransferEngine {
  private tasks = new Map<string, TransferTask>();
  private running = new Map<string, RunningTask>();
  private queue: string[] = [];
  private concurrency: number;
  private activeCount = 0;
  private idleResolve: (() => void) | null = null;
  private emit: (event: string, ...args: unknown[]) => void;

  constructor(
    private readonly adapter: TransferAdapter,
    options: {
      concurrency: number;
      emit: (event: string, ...args: unknown[]) => void;
    },
  ) {
    this.concurrency = options.concurrency;
    this.emit = options.emit;
  }

  // -----------------------------------------------------------------------
  //  Public API
  // -----------------------------------------------------------------------

  enqueue(
    input: Omit<TransferTask, 'id' | 'state' | 'createdAt' | 'updatedAt' | 'bytesPerSecond'>,
  ): TransferTask {
    const now = Date.now();
    const task: TransferTask = {
      ...input,
      id: randomUUID(),
      state: 'queued',
      bytesPerSecond: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    this.emitTaskUpdated(task);
    void this.persist();
    return task;
  }

  /** 新建任务时固定源 size/mtime，防止把另一个同名文件续接到旧 .part。 */
  async enqueueWithSourceFingerprint(
    input: Omit<TransferTask, 'id' | 'state' | 'createdAt' | 'updatedAt' | 'bytesPerSecond'>,
    sessionId: string,
  ): Promise<TransferTask> {
    const sourceFingerprint = input.direction === 'upload'
      ? await this.adapter.localFingerprint(input.localPath)
      : await this.adapter.remoteFingerprint(
          input.remotePath,
          input.direction === 'remote-copy' ? input.sourceSessionId! : sessionId,
        );
    return this.enqueue({
      ...input,
      sourceFingerprint,
      totalBytes: sourceFingerprint.size,
      transferredBytes: 0,
    });
  }

  list(): TransferTask[] {
    return [...this.tasks.values()];
  }

  getTask(id: string): TransferTask | undefined {
    return this.tasks.get(id);
  }

  /**
   * 该会话是否还有活跃（queued/running/retrying）或暂停待续传的传输。
   * 会话淘汰循环据此跳过有传输的会话；remote-copy 的源侧会话（sourceSessionId）一并算入。
   */
  hasSessionActivity(sessionId: string): boolean {
    for (const task of this.tasks.values()) {
      if (task.sessionId !== sessionId && task.sourceSessionId !== sessionId) continue;
      if (task.state === 'queued' || task.state === 'running'
        || task.state === 'retrying' || task.state === 'paused') {
        return true;
      }
    }
    return false;
  }

  async pause(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) throw new Error('Task not found');
    if (!canTransitionTransfer(task.state, 'paused')) {
      throw new Error(`Cannot pause from state ${task.state}`);
    }

    const run = this.running.get(id);
    task.state = 'paused';
    task.bytesPerSecond = 0;
    task.updatedAt = Date.now();
    this.emitTaskUpdated(task);
    void this.persist();

    if (run) {
      run.controller.abort();
      // 不在此处结算 activeCount：只有本轮 I/O 的 finally 能结算。
      await run.done;
    } else {
      this.checkIdle();
      this.processQueue();
    }
  }

  async resume(id: string, sessionId: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) throw new Error('Task not found');

    if (task.state === 'running' || task.state === 'retrying') {
      // 原执行仍持有流/退避定时器，不能再启动第二轮或跨会话换绑。
      if (task.sessionId !== sessionId) throw new Error('Cannot rebind an active transfer');
      return;
    }

    if (task.state === 'completed' || task.state === 'cancelled') {
      throw new Error(`Cannot resume from state ${task.state}`);
    }

    // queued / paused / failed -> transition to queued, start or queue
    if (task.state === 'queued' || task.state === 'paused' || task.state === 'failed') {
      task.state = 'queued';
      task.sessionId = sessionId;
      task.updatedAt = Date.now();
      this.emitTaskUpdated(task);

      if (this.activeCount < this.concurrency) {
        // Spare capacity -- start immediately
        task.state = 'running';
        task.updatedAt = Date.now();
        this.emitTaskUpdated(task);
        this.startTask(id);
      } else {
        this.queue.push(id);
      }
      void this.persist();
      return;
    }

    throw new Error(`Cannot resume from state ${task.state}`);
  }

  async cancel(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) throw new Error('Task not found');
    if (!canTransitionTransfer(task.state, 'cancelled')) {
      throw new Error(`Cannot cancel from state ${task.state}`);
    }

    const run = this.running.get(id);
    task.state = 'cancelled';
    task.bytesPerSecond = 0;
    task.updatedAt = Date.now();
    this.emitTaskUpdated(task);
    void this.persist();

    if (run) {
      run.controller.abort();
      await run.done;
    }
    // 只有底层 pipeline/直连进程退出后才能删除 .part，避免迟到的写句柄重建文件。
    await this.cleanupTempFile(task);
    this.checkIdle();
    this.processQueue();
  }

  /** Remove a terminal-state task from the queue (and from the persisted store). */
  remove(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    if (task.state === 'running' || task.state === 'queued' || task.state === 'retrying') {
      throw new Error(`Cannot remove task in state ${task.state}`);
    }
    this.tasks.delete(id);
    this.emit('transfer:removed', { id });
    void this.persist();
  }

  /** Remove all completed/cancelled tasks. Returns the removed ids. */
  clearCompleted(predicate: (task: TransferTask) => boolean = () => true): string[] {
    const removed: string[] = [];
    for (const task of [...this.tasks.values()]) {
      if ((task.state === 'completed' || task.state === 'cancelled') && predicate(task)) {
        this.tasks.delete(task.id);
        removed.push(task.id);
        this.emit('transfer:removed', { id: task.id });
      }
    }
    if (removed.length > 0) void this.persist();
    return removed;
  }

  async retry(id: string, sessionId: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) throw new Error('Task not found');
    if (task.state !== 'failed') {
      throw new Error(`Cannot retry from state ${task.state}`);
    }

    task.retryCount = 0;
    task.error = undefined;
    task.transferredBytes = 0;
    task.updatedAt = Date.now();
    void this.persist();

    await this.resume(id, sessionId);
  }

  setConcurrency(value: number): void {
    this.concurrency = Math.max(1, Math.min(8, Math.trunc(value)));
    this.processQueue();
  }

  setBandwidthLimit(_bytesPerSecond: number | null): void {
    throw new Error('Bandwidth limit is not implemented');
  }

  async waitForIdle(): Promise<void> {
    if (this.activeCount === 0) return;
    return new Promise(resolve => {
      this.idleResolve = resolve;
    });
  }

  async shutdown(): Promise<void> {
    const runs = [...this.running.values()];
    for (const run of runs) run.controller.abort();
    this.queue = [];
    await Promise.all(runs.map(run => run.done));
    this.tasks.clear();
  }

  // -----------------------------------------------------------------------
  //  Queue management
  // -----------------------------------------------------------------------

  private processQueue(): void {
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const id = this.queue.shift();
      if (!id) break;
      const task = this.tasks.get(id);
      if (!task || task.state !== 'queued') continue;

      task.state = 'running';
      task.updatedAt = Date.now();
      this.emitTaskUpdated(task);
      void this.persist();
      this.startTask(id);
    }
  }

  private startTask(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;

    this.activeCount++;
    const controller = new AbortController();
    const run: RunningTask = {
      controller,
      sessionId: task.sessionId!,
      done: Promise.resolve(),
    };
    this.running.set(id, run);

    run.done = this.executeTransfer(id, controller)
      .catch(() => { /* errors handled inside */ })
      .finally(() => {
        if (this.running.get(id)?.controller === controller) {
          this.running.delete(id);
          this.activeCount = Math.max(0, this.activeCount - 1);
        }
        this.checkIdle();
        this.processQueue();
      });
  }

  // -----------------------------------------------------------------------
  //  Transfer lifecycle
  // -----------------------------------------------------------------------

  private async executeTransfer(id: string, controller: AbortController): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) return;
    const signal = controller.signal;

    try {
      // 每个阶段开始前先确认会话存活（注入 ensureSessionAlive 时断开会话会被静默重连），
      // 避免几小时的大文件传输因中途断线/会话被淘汰而直接失败
      await this.ensureTaskSessionsAlive(task);
      await this.validateSourceFingerprint(task);
      if (task.direction === 'remote-copy' && this.adapter.prepareRemoteCopy) {
        await this.adapter.prepareRemoteCopy({
          sourcePath: task.remotePath,
          destinationPath: task.temporaryPath,
          sourceSessionId: task.sourceSessionId!,
          destinationSessionId: task.sessionId!,
        });
      }
      // 集群↔集群优先走直连 rsync（数据不过本机），不可用时回退本机中转
      const directDone = task.direction === 'remote-copy'
        ? await this.tryDirectCopy(id, signal)
        : false;
      if (signal.aborted) return;

      if (!directDone) {
        // Phase 1: stream the file data
        await this.streamFile(id, signal);
        if (signal.aborted) return;

        // Phase 2: verify the temporary file
        await this.ensureTaskSessionsAlive(task);
        if (task.direction === 'remote-copy') {
          await this.verifyRemoteCopy(task);
        } else {
          const verifyLocal = task.direction === 'upload' ? task.localPath : task.temporaryPath;
          const verifyRemote = task.direction === 'upload' ? task.temporaryPath : task.remotePath;
          await this.adapter.verify(verifyLocal, verifyRemote, task.verificationMode, {
            direction: task.direction,
            sessionId: task.sessionId!,
          });
        }
        if (signal.aborted) return;

        // Phase 3: atomic rename。保活/重连也可耗时，等待结束必须再次响应取消。
        await this.ensureTaskSessionsAlive(task);
        if (signal.aborted) return;
        if (task.direction === 'upload') {
          await this.adapter.remoteRename(task.temporaryPath, task.remotePath, task.sessionId!);
        } else if (task.direction === 'remote-copy') {
          // remote-copy：localPath 存目标集群的最终路径
          await this.adapter.remoteRename(task.temporaryPath, task.localPath, task.sessionId!);
        } else {
          await this.adapter.localRename(task.temporaryPath, task.localPath);
        }
      }
      if (signal.aborted) return;

      task.state = 'completed';
      task.transferredBytes = task.totalBytes;
      task.bytesPerSecond = 0;
      task.updatedAt = Date.now();
      this.emitTaskUpdated(task);
      void this.persist();
    } catch (error) {
      if (signal.aborted) return;

      const message = error instanceof Error ? error.message : String(error);
      const isRetryable = this.isRetryableError(message);

      if (isRetryable && task.retryCount < 3) {
        // 断连类错误：先尽力静默重连（复用 /api/reconnect 的同一实现），再进入既有退避重试。
        // 连不上也不阻断重试——下次尝试的阶段预检会再次抛出，重试次数照常累计。
        await this.ensureTaskSessionsAlive(task).catch(() => {});
        // 保活等待期间用户可能已暂停/取消：不得把 paused/cancelled 覆盖回 retrying
        if (signal.aborted) return;
        task.retryCount++;
        task.state = 'retrying';
        task.bytesPerSecond = 0;
        task.error = message;
        task.updatedAt = Date.now();
        this.emitTaskUpdated(task);
        void this.persist();

        // Wait briefly before retry
        await new Promise(resolve => setTimeout(resolve, 500));
        if (signal.aborted) return;

        // Continue retrying with the same controller (not aborted by pause/cancel)
        return this.executeTransfer(id, controller);
      }

      task.state = 'failed';
      task.bytesPerSecond = 0;
      task.error = message;
      task.updatedAt = Date.now();
      this.emitTaskUpdated(task);
      void this.persist();
    } finally {
      // 单个任务终态（成功/失败/取消）必经此处：清理直连互传落盘的临时文件
      // （OTP 凭据、wrapper、传输日志）。递归重试时内层先清，外层再清一次，均幂等
      await this.cleanupDirectTempFiles(task);
    }
  }

  // -----------------------------------------------------------------------
  //  Session keepalive
  // -----------------------------------------------------------------------

  /**
   * 确认传输用到的会话还活着；适配器注入 ensureSessionAlive 时，断开的会话会在此
   * 被静默重连。连不上抛 "SSH session not found"——该错误在 isRetryableError 名单里，
   * 由 executeTransfer 的退避重试接管。
   */
  private async ensureSessionAlive(sessionId: string | undefined): Promise<void> {
    const ensure = this.adapter.ensureSessionAlive;
    if (!ensure || !sessionId) return;
    if (!await ensure(sessionId)) {
      throw new Error('SSH session not found');
    }
  }

  /** remote-copy 同时依赖源（读）与目标（写）两个会话，任一断开都无法继续 */
  private async ensureTaskSessionsAlive(task: TransferTask): Promise<void> {
    await this.ensureSessionAlive(task.sessionId);
    if (task.direction === 'remote-copy') {
      await this.ensureSessionAlive(task.sourceSessionId);
    }
  }

  private async validateSourceFingerprint(task: TransferTask): Promise<void> {
    const expected = task.sourceFingerprint;
    if (!expected) return; // 兼容 v0.5.13 及更早的持久记录
    const actual = task.direction === 'upload'
      ? await this.adapter.localFingerprint(task.localPath)
      : await this.adapter.remoteFingerprint(
          task.remotePath,
          task.direction === 'remote-copy' ? task.sourceSessionId! : task.sessionId!,
        );
    if (actual.size !== expected.size || actual.mtime !== expected.mtime) {
      throw new Error(
        `Source file changed since transfer creation; refusing resume `
        + `(expected size=${expected.size}, mtime=${expected.mtime}; `
        + `actual size=${actual.size}, mtime=${actual.mtime})`,
      );
    }
  }

  private async verifyRemoteCopy(task: TransferTask): Promise<void> {
    const context = {
      sourceSessionId: task.sourceSessionId!,
      destinationSessionId: task.sessionId!,
    };
    if (this.adapter.verifyRemoteCopy) {
      await this.adapter.verifyRemoteCopy(
        task.remotePath,
        task.temporaryPath,
        task.verificationMode,
        context,
      );
      return;
    }
    if (task.verificationMode === 'sha256') {
      throw new Error('remote-copy sha256 verification is unavailable');
    }
    const [srcSize, dstSize] = await Promise.all([
      this.adapter.remoteSize(task.remotePath, context.sourceSessionId),
      this.adapter.remoteSize(task.temporaryPath, context.destinationSessionId),
    ]);
    if (srcSize !== dstSize) throw new Error('size mismatch');
  }

  private async streamFile(id: string, signal: AbortSignal): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) return;

    if (task.direction === 'upload') {
      await this.uploadFile(id, signal);
    } else if (task.direction === 'remote-copy') {
      await this.remoteCopyFile(id, signal);
    } else {
      await this.downloadFile(id, signal);
    }
  }

  /** 集群↔集群直传：源集群 SFTP 读 → 目标集群 SFTP 写（不经过本地磁盘） */
  private async remoteCopyFile(id: string, signal: AbortSignal): Promise<void> {
    const task = this.tasks.get(id)!;
    const destSessionId = task.sessionId!;
    const sourceSessionId = task.sourceSessionId!;

    const offset = task.conflictPolicy === 'resume'
      ? await this.reconcileRemotePart(task, destSessionId)
      : 0;
    task.transferredBytes = offset;

    const readStream = this.adapter.openRemoteRead(task.remotePath, offset, sourceSessionId);
    const writeStream = this.adapter.openRemoteWrite(task.temporaryPath, offset, destSessionId);
    const counter = this.progressCounter(task, offset);

    await pipeline(readStream, counter, writeStream, { signal });
    task.updatedAt = Date.now();
  }

  // ── 集群直连互传（rsync over 内网，数据不经过本机）─────────────────

  private directLinkCache = new Map<string, DirectLink | null>();
  private lastDirectFailReason = '';

  /** shell 单引号包裹 */
  private static sq(s: string): string {
    return `'${s.replace(/'/g, `'"'"'`)}'`;
  }

  /**
   * 探测并（必要时自动）建立源集群 → 目标集群的免密直连。
   * 优先公钥（自动装 key）；集群无 publickey 时退到 OTP 喂码
   * （源端 expect 脚本自动应答 Password:/Verification code:）。
   */
  private async ensureDirectLink(srcSessionId: string, dstSessionId: string): Promise<DirectLink | null> {
    const cacheKey = `${srcSessionId}->${dstSessionId}`;
    if (this.directLinkCache.has(cacheKey)) return this.directLinkCache.get(cacheKey) ?? null;

    const exec = this.adapter.execRemote;
    const info = this.adapter.getSessionInfo?.(dstSessionId);
    if (!exec || !info) {
      this.directLinkCache.set(cacheKey, null);
      this.lastDirectFailReason = '适配器缺少 execRemote 或目标会话主机信息';
      return null;
    }
    // StrictHostKeyChecking=accept-new：首次连接接受新主机指纹并写入默认 known_hosts，
    // 之后指纹变更即拒绝（堵住已知主机被替换的中间人攻击）；需 OpenSSH 7.6+（2017 年后），
    // UserKnownHostsFile 保持默认（~/.ssh/known_hosts），不再使用 no（等于放弃主机校验）
    const keySshPrefix = `ssh -p ${info.port} -o BatchMode=yes -o ConnectTimeout=6 -o StrictHostKeyChecking=accept-new`;
    const probe = `${keySshPrefix} ${TransferEngine.sq(`${info.username}@${info.host}`)} echo trace-ok`;
    let probeErr = '';
    const tryProbe = async (): Promise<boolean> => {
      try {
        const out = await exec(probe, srcSessionId, 20_000);
        return out.includes('trace-ok');
      } catch (e: any) {
        probeErr = (e?.message || String(e)).slice(0, 200);
        return false;
      }
    };

    let ok = await tryProbe();
    if (ok) {
      const link: DirectLink = { ...info, sshPrefix: keySshPrefix };
      this.directLinkCache.set(cacheKey, link);
      this.lastDirectFailReason = '';
      return link;
    }

    // 公钥路线失败：先尝试自动装公钥（多数集群 publickey 可走）
    // 传输工具（rsync/scp）的选择在 tryDirectCopy 里做，这里只建立 ssh 通道
    try {
      const pub = await exec(
        '[ -f ~/.ssh/id_ed25519.pub ] || ssh-keygen -t ed25519 -N "" -C "trace-direct" -f ~/.ssh/id_ed25519 -q; cat ~/.ssh/id_ed25519.pub',
        srcSessionId, 20_000,
      );
      const pubkey = pub.trim().split('\n').pop() || '';
      if (!pubkey.startsWith('ssh-')) throw new Error('no pubkey');
      await exec(
        `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && ` +
        `grep -q 'trace-direct' ~/.ssh/authorized_keys || echo ${TransferEngine.sq(pubkey)} >> ~/.ssh/authorized_keys`,
        dstSessionId, 20_000,
      );
      ok = await tryProbe();
      if (ok) {
        const link: DirectLink = { ...info, sshPrefix: keySshPrefix };
        this.directLinkCache.set(cacheKey, link);
        this.lastDirectFailReason = '';
        return link;
      }
    } catch { /* 继续走 OTP 路线 */ }

    // OTP 喂码路线：源端 expect 脚本自动应答 Password:/Verification code:
    const creds = getTransferCredentials(info.host, info.port, info.username);
    if (!creds || (!creds.password && !creds.totpSecret)) {
      // 不缓存：凭据可能稍后才同步进来，下次传输应重试
      this.lastDirectFailReason = `公钥不可用（${probeErr || '未知'}），且未同步到目标账号的凭据（密码/验证码种子）`;
      return null;
    }
    try {
      const link = await this.installOtpWrapper(srcSessionId, info, creds);
      if (link) {
        this.directLinkCache.set(cacheKey, link);
        this.lastDirectFailReason = '';
        return link;
      }
      // installOtpWrapper 已写入详细原因（探测回显），不覆盖；为空时才给通用文案
      if (!this.lastDirectFailReason) {
        this.lastDirectFailReason = 'OTP 喂码探测失败（密码或验证码不正确，或提示格式不匹配）';
      }
      return null;
    } catch (e: any) {
      this.lastDirectFailReason = `OTP 喂码部署失败: ${(e?.message || String(e)).slice(0, 200)}`;
      return null;
    }
  }

  /** 在源集群安装 OTP 应答脚本与凭据文件，探测成功返回带 wrapper 的 DirectLink */
  private async installOtpWrapper(
    srcSessionId: string,
    info: { host: string; port: number; username: string },
    creds: { password: string; totpSecret: string },
  ): Promise<DirectLink | null> {
    const exec = this.adapter.execRemote!;
    const safe = `${info.username}@${info.host}:${info.port}`.replace(/[^A-Za-z0-9@._-]/g, '_');
    const credsFile = `~/.trace/.creds-${safe}`;
    const wrapper = `~/.trace/otp-ssh-${safe}`;

    // 1) 共享 python 应答脚本（每次覆盖写入，保证逻辑为最新版）
    const scriptB64 = Buffer.from(OTP_SSH_PY, 'utf8').toString('base64');
    await exec(
      `mkdir -p ~/.trace && chmod 700 ~/.trace && ` +
      `echo ${TransferEngine.sq(scriptB64)} | base64 -d > ~/.trace/otp-ssh.py`,
      srcSessionId, 20_000,
    );

    // 2) 凭据文件（600 权限，含密码与 TOTP 种子；任务终态由 cleanupDirectTempFiles 删除）
    // umask 077 只影响新建文件，对已有文件重定向不重置权限，故再显式 chmod 600 兜底
    const credsContent = Buffer.from(`password=${creds.password}\nsecret=${creds.totpSecret}\n`, 'utf8').toString('base64');
    await exec(
      `umask 077; echo ${TransferEngine.sq(credsContent)} | base64 -d > ${credsFile} && chmod 600 ${credsFile}`,
      srcSessionId, 15_000,
    );

    // 3) 每个目标账号一个 wrapper（绑定对应凭据文件）
    const credsName = `.creds-${safe}`;
    const wrapperContent = [
      '#!/bin/sh',
      `export TRACE_OTP_CREDS="$HOME/.trace/${credsName}"`,
      'exec python3 "$HOME/.trace/otp-ssh.py" "$@"',
      '',
    ].join('\n');
    await exec(
      `echo ${TransferEngine.sq(Buffer.from(wrapperContent, 'utf8').toString('base64'))} | base64 -d > ${wrapper} && chmod 700 ${wrapper}`,
      srcSessionId, 15_000,
    );

    // 4) 探测（整段回显 + 退出码，不因非零退出丢输出）
    // 注意：只保留 -p 与 host key 选项，与手动验证一致的调用方式；
    // PreferredAuthentications/NumberOfPasswordPrompts 等附加选项实测会导致 255
    // host key 用 accept-new（同公钥路线，首次接受、之后变更拒绝）
    const sshPrefix = `${wrapper} -p ${info.port} -o StrictHostKeyChecking=accept-new`;
    try {
      const probeCmd = `out=$(${sshPrefix} ${TransferEngine.sq(`${info.username}@${info.host}`)} echo trace-ok 2>&1); rc=$?; printf 'RC=%s\\n' "$rc"; printf '%s\\n' "$out" | tail -4`;
      const out = await exec(probeCmd, srcSessionId, 60_000);
      if (out.includes('trace-ok')) return { ...info, sshPrefix, otpTempFiles: { credsFile, wrapper } };
      this.lastDirectFailReason = `OTP 探测失败: ${out.trim().slice(-240)}`;
    } catch (e: any) {
      this.lastDirectFailReason = `OTP 探测异常: ${(e?.message || String(e)).slice(0, 300)}`;
    }
    // 探测未通过：凭据/wrapper 含明文密码与 TOTP 种子，立即删除不留存
    // （safe 已经过白名单字符过滤，直接拼接以便 ~ 展开）
    await exec(`rm -f ${credsFile} ${wrapper}`, srcSessionId, 10_000).catch(() => {});
    return null;
  }

  /**
   * 直连互传：同一主机时直接在目标端本地复制；跨集群时 rsync/scp over ssh。
   * 返回 true = 已完成（含校验与改名）；返回 false = 不可用，调用方回退本机中转。
   */
  private async tryDirectCopy(id: string, signal: AbortSignal): Promise<boolean> {
    const task = this.tasks.get(id);
    if (!task) return false;
    const exec = this.adapter.execRemote;
    if (!exec) return false;
    const src = task.sourceSessionId!;
    const dst = task.sessionId!;
    const logPath = `/tmp/trace-direct-${task.id}.log`;

    const hasCmd = async (sid: string, cmd: string): Promise<boolean> => {
      try {
        const out = await exec(`command -v ${cmd} >/dev/null && echo y`, sid, 10_000);
        return out.includes('y');
      } catch {
        return false;
      }
    };

    // 判定：两端是否同一主机（同集群不同账号的"互传"其实是本机复制）
    const srcInfo = this.adapter.getSessionInfo?.(src);
    const dstInfo = this.adapter.getSessionInfo?.(dst);
    const sameHost = !!(srcInfo && dstInfo && srcInfo.host === dstInfo.host && srcInfo.port === dstInfo.port);

    let workSid: string;
    let transferCmd: string;
    let preClean = '';

    if (sameHost) {
      if (!await this.ensureSameHostReadAccess(task.remotePath, src, dst)) {
        // 不扩大 other 权限；ACL 不可用时改走双 SFTP 中转，两个账号各自读/写。
        console.log('[transfer] 同主机目标账号无源文件读权限，ACL 补权不可用，回退双 SFTP 中转');
        return false;
      }
      // 同一主机：无需 ssh/OTP，直接在目标端会话本地复制（源文件需可读）
      workSid = dst;
      const useRsync = await hasCmd(dst, 'rsync');
      transferCmd = useRsync
        ? `rsync -a --partial --inplace ${TransferEngine.sq(task.remotePath)} ${TransferEngine.sq(task.temporaryPath)}`
        : `cp -f ${TransferEngine.sq(task.remotePath)} ${TransferEngine.sq(task.temporaryPath)}`;
      console.log(`[transfer] 同主机互传：目标端本地复制（${dstInfo!.host}）`);
    } else {
      const info = await this.ensureDirectLink(src, dst).catch(() => null);
      if (!info) {
        // 直连不可用的具体原因写入服务端日志，便于定位
        console.log(`[transfer] 直连不可用，回退中转模式: ${src} -> ${dst}；原因: ${this.lastDirectFailReason || '未知'}`);
        return false;
      }
      workSid = src;

      // 选择传输工具：rsync 优先（可断点续传），没有则用 scp（Linux 必带）
      const useRsync = (await hasCmd(src, 'rsync')) && (await hasCmd(dst, 'rsync'));
      const useScp = !useRsync && (await hasCmd(src, 'scp')) && (await hasCmd(dst, 'scp'));
      if (!useRsync && !useScp) {
        console.log(`[transfer] 直连不可用，回退中转模式: ${src} -> ${dst}；原因: 两端都没有 rsync/scp`);
        this.lastDirectFailReason = '两端都没有 rsync/scp';
        return false;
      }

      const target = TransferEngine.sq(`${info.username}@${info.host}:${task.temporaryPath}`);
      // scp 无法续传，先把残留临时文件删掉重来
      preClean = useScp ? `rm -f ${TransferEngine.sq(task.temporaryPath)} 2>/dev/null; ` : '';
      // scp -S 指定 ssh 程序：OTP 模式用 wrapper，公钥模式用系统 ssh + BatchMode
      const isOtpLink = info.sshPrefix.includes('otp-ssh');
      const scpProgram = isOtpLink ? info.sshPrefix.split(' ')[0] : 'ssh';
      const scpOpts = isOtpLink ? '-o StrictHostKeyChecking=accept-new' : '-o BatchMode=yes -o StrictHostKeyChecking=accept-new';
      transferCmd = useRsync
        ? `rsync -az --partial --inplace -e ${TransferEngine.sq(info.sshPrefix)} ` +
          `${TransferEngine.sq(task.remotePath)} ${target}`
        : `scp -q -S ${TransferEngine.sq(scpProgram)} -P ${info.port} ${scpOpts} ` +
          `${TransferEngine.sq(task.remotePath)} ${target}`;
    }

    const launcher = `${preClean}rm -f ${TransferEngine.sq(logPath)}; nohup sh -c ${TransferEngine.sq(transferCmd)} > ${TransferEngine.sq(logPath)} 2>&1 & echo $!`;

    if (signal.aborted) return true;
    let pid: string;
    try {
      pid = (await exec(launcher, workSid, 15_000)).trim().split('\n').pop() || '';
      if (!/^\d+$/.test(pid)) throw new Error('传输进程启动失败');
    } catch {
      return false; // 启动都失败就回退中转
    }

    // 取消/暂停时杀掉传输进程，并由 run.done 等待 kill 请求完成。
    let abortDone = Promise.resolve();
    const onAbort = () => {
      abortDone = exec(`kill ${pid} 2>/dev/null; true`, workSid, 10_000)
        .then(() => undefined)
        .catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    const waitIfAborted = async (): Promise<boolean> => {
      if (!signal.aborted) return false;
      await abortDone;
      return true;
    };

    try {
      // 轮询：进程存活 + 目标端临时文件大小 → 进度与速度（差值/间隔）
      let lastPollBytes = task.transferredBytes;
      let lastPollTime = Date.now();
      for (;;) {
        if (await waitIfAborted()) return true;
        await new Promise(r => setTimeout(r, 2000));
        let alive = false;
        try {
          await exec(`kill -0 ${pid} 2>/dev/null && echo alive`, workSid, 10_000).then(o => { alive = o.includes('alive'); });
        } catch { alive = false; }
        const size = await this.adapter.remoteSize(task.temporaryPath, dst).catch(() => 0);
        if (size !== task.transferredBytes) {
          const now = Date.now();
          this.applySpeedSample(task, size, now - lastPollTime, lastPollBytes);
          lastPollBytes = size;
          lastPollTime = now;
          task.transferredBytes = size;
          task.updatedAt = now;
          this.emitTaskUpdated(task);
        }
        if (!alive) break;
      }

      if (await waitIfAborted()) return true;

      try {
        await this.verifyRemoteCopy(task);
      } catch (error) {
        let tail = '';
        try {
          tail = (await exec(`tail -6 ${TransferEngine.sq(logPath)} 2>/dev/null; true`, workSid, 10_000)).trim();
        } catch { /* ignore */ }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}${tail ? `；传输日志: ${tail.slice(-220)}` : ''}`);
      }

      // 校验可能耗时很长；最终改名前再次响应取消，避免 cancelled 仍覆盖目标。
      if (await waitIfAborted()) return true;
      await this.adapter.remoteRename(task.temporaryPath, task.localPath, dst);
      return true;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * 同一 Linux 主机上的不同账号互传：优先为“目标账号”设置精确 POSIX ACL。
   * 只给源文件 r、实际不可穿越的父目录 x，不使用 chmod 777/o+r。
   */
  private async ensureSameHostReadAccess(sourcePath: string, sourceSessionId: string, destinationSessionId: string): Promise<boolean> {
    const exec = this.adapter.execRemote;
    const sourceInfo = this.adapter.getSessionInfo?.(sourceSessionId);
    const destinationInfo = this.adapter.getSessionInfo?.(destinationSessionId);
    if (!exec || !destinationInfo) return false;
    if (sourceInfo?.username === destinationInfo.username) return true;
    try {
      await exec(`test -r ${TransferEngine.sq(sourcePath)}`, destinationSessionId, 10_000);
      return true;
    } catch { /* 需要精确补权 */ }

    const username = destinationInfo.username;
    if (!/^[A-Za-z0-9._-]+$/.test(username)) return false;
    const ancestors: string[] = [];
    let current = path.posix.dirname(sourcePath);
    while (current && current !== '/') {
      ancestors.push(current);
      const parent = path.posix.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    try {
      const inaccessible = ancestors.length > 0
        ? await exec(
            `for p in ${ancestors.map(item => TransferEngine.sq(item)).join(' ')}; do `
              + `[ -x "$p" ] || printf '%s\\n' "$p"; done`,
            destinationSessionId,
            15_000,
          )
        : '';
      const needed = new Set(inaccessible.split(/\r?\n/).map(item => item.trim()).filter(item => ancestors.includes(item)));
      const aclParts = [
        'command -v setfacl >/dev/null',
        `setfacl -m u:${username}:r-- ${TransferEngine.sq(sourcePath)}`,
        ...[...needed].map(item => `setfacl -m u:${username}:--x ${TransferEngine.sq(item)}`),
      ];
      await exec(aclParts.join(' && '), sourceSessionId, 20_000);
      await exec(`test -r ${TransferEngine.sq(sourcePath)}`, destinationSessionId, 10_000);
      console.log('[transfer] 已用用户级 ACL 为 %s 补足源文件及父目录穿越权限', username);
      return true;
    } catch {
      return false;
    }
  }

  private async uploadFile(id: string, signal: AbortSignal): Promise<void> {
    const task = this.tasks.get(id)!;
    const sessionId = task.sessionId!;
    const offset = task.conflictPolicy === 'resume'
      ? await this.reconcileRemotePart(task, sessionId)
      : 0;
    task.transferredBytes = offset;

    const readStream = this.adapter.openLocalRead(task.localPath, offset);
    const writeStream = this.adapter.openRemoteWrite(task.temporaryPath, offset, sessionId);
    const counter = this.progressCounter(task, offset);
    await pipeline(readStream, counter, writeStream, { signal });
    task.updatedAt = Date.now();
  }

  private async downloadFile(id: string, signal: AbortSignal): Promise<void> {
    const task = this.tasks.get(id)!;
    const sessionId = task.sessionId!;
    const offset = task.conflictPolicy === 'resume'
      ? await this.reconcileLocalPart(task)
      : 0;
    task.transferredBytes = offset;

    const readStream = this.adapter.openRemoteRead(task.remotePath, offset, sessionId);
    const writeStream = this.adapter.openLocalWrite(task.temporaryPath, offset);
    const counter = this.progressCounter(task, offset);
    await pipeline(readStream, counter, writeStream, { signal });
    task.updatedAt = Date.now();
  }

  private async reconcileRemotePart(task: TransferTask, sessionId: string): Promise<number> {
    try {
      return this.checkedPartSize(task, await this.adapter.remoteSize(task.temporaryPath, sessionId));
    } catch (error) {
      if (this.isMissingPartError(error)) return 0;
      throw error;
    }
  }

  private async reconcileLocalPart(task: TransferTask): Promise<number> {
    try {
      return this.checkedPartSize(task, await this.adapter.localSize(task.temporaryPath));
    } catch (error) {
      if (this.isMissingPartError(error)) return 0;
      throw error;
    }
  }

  private isMissingPartError(error: unknown): boolean {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
    const message = error instanceof Error ? error.message : String(error);
    return code === 2 || code === 'ENOENT' || /no such file|not found|does not exist/i.test(message);
  }

  private checkedPartSize(task: TransferTask, size: number): number {
    if (!Number.isFinite(size) || size < 0) throw new Error('Invalid .part size');
    if (task.totalBytes > 0 && size > task.totalBytes) {
      throw new Error('.part is larger than the source file; restart with overwrite');
    }
    return size;
  }

  // -----------------------------------------------------------------------
  //  Progress
  // -----------------------------------------------------------------------

  /** 指数移动平均速度：0.7 × 本次瞬时值（字节差/时间差）+ 0.3 × 历史值 */
  private applySpeedSample(
    task: TransferTask,
    transferred: number,
    elapsedMs: number,
    previousBytes: number,
  ): void {
    if (elapsedMs <= 0) return;
    const instant = Math.max(0, ((transferred - previousBytes) * 1000) / elapsedMs);
    task.bytesPerSecond = task.bytesPerSecond > 0
      ? Math.round(0.7 * instant + 0.3 * task.bytesPerSecond)
      : Math.round(instant);
  }

  /**
   * 250ms 节流的进度回调：更新已传字节并发射 transfer:updated，
   * 发射点顺带计算 EMA 速度（任务进入终态时由外层清零）。
   */
  private createProgressTracker(
    task: TransferTask,
    initialOffset: number,
  ): (transferred: number) => void {
    let lastEmit = 0;
    let lastSampleBytes = initialOffset;
    let lastSampleTime = 0;

    return (transferred: number) => {
      task.transferredBytes = transferred;
      const now = Date.now();
      if (now - lastEmit < 250) return;
      lastEmit = now;
      // 首个样本只建立基准，没有可参照的时间差，不产生速度
      if (lastSampleTime > 0) {
        this.applySpeedSample(task, transferred, now - lastSampleTime, lastSampleBytes);
      }
      lastSampleBytes = transferred;
      lastSampleTime = now;
      this.emitTaskUpdated(task);
    };
  }

  private progressCounter(task: TransferTask, initialOffset: number): PassThrough {
    let bytesSoFar = initialOffset;
    const trackProgress = this.createProgressTracker(task, initialOffset);

    const counter = new PassThrough({ highWaterMark: 512 * 1024 });
    counter.on('data', (chunk: Buffer) => {
      bytesSoFar += chunk.length;
      trackProgress(bytesSoFar);
    });
    return counter;
  }

  // -----------------------------------------------------------------------
  //  Error classification
  // -----------------------------------------------------------------------

  /** Errors that indicate a transient network issue worth retrying. */
  private isRetryableError(message: string): boolean {
    const lower = message.toLowerCase();
    const patterns = [
      'connection reset',
      'connection refused',
      'connection timed out',
      'timed out',
      'timeout',
      'econnreset',
      'econnrefused',
      'etimedout',
      'enetunreach',
      'eof',
      'end of file',
      'socket',
      'write epipe',
      'read econnreset',
      'transport closed',
      // SSH 会话中断/被淘汰类：配合 ensureSessionAlive 静默重连后重试。
      // 权限类错误（permission denied / EACCES / 权限不足）不含这些字样，不会被误吞。
      'ssh session not found',
      'not connected',
      'channel',
    ];
    return patterns.some(p => lower.includes(p));
  }

  // -----------------------------------------------------------------------
  //  Cleanup
  // -----------------------------------------------------------------------

  /**
   * 直连互传的任务终态清理（在 executeTransfer 的 finally 调用，成功/失败/取消/回退中转都会经过）。
   * 覆盖两条直连路径落盘的临时文件：
   * - OTP 喂码路径：源集群 ~/.trace/.creds-*（明文密码+TOTP 种子，必须删除）与
   *   ~/.trace/otp-ssh-* wrapper；删除后同步失效直连缓存，否则后续任务会引用已删凭据。
   *   共享应答脚本 ~/.trace/otp-ssh.py 无敏感数据且被多目标复用，保留。
   * - 传输日志 /tmp/trace-direct-<id>.log：同主机时写在目标端、跨集群时写在源端，两端幂等删除。
   * 公钥免密路径生成的 ~/.ssh/id_ed25519 与 authorized_keys 条目属于持久免密配置，不在此清理。
   * 全部尽力而为：清理失败（如文件已不存在）不影响任务本身的状态报告。
   */
  private async cleanupDirectTempFiles(task: TransferTask): Promise<void> {
    const exec = this.adapter.execRemote;
    if (!exec || task.direction !== 'remote-copy') return;
    const src = task.sourceSessionId!;
    const dst = task.sessionId!;
    const logPath = `/tmp/trace-direct-${task.id}.log`;

    const cacheKey = `${src}->${dst}`;
    const link = this.directLinkCache.get(cacheKey);
    if (link?.otpTempFiles) {
      this.directLinkCache.delete(cacheKey);
      const { credsFile, wrapper } = link.otpTempFiles;
      // 路径字符已经过白名单过滤（见 installOtpWrapper），直接拼接以便 ~ 展开
      await exec(`rm -f ${credsFile} ${wrapper}`, src, 10_000).catch(() => {});
    }
    await Promise.all([
      exec(`rm -f ${TransferEngine.sq(logPath)} 2>/dev/null; true`, src, 10_000).catch(() => {}),
      exec(`rm -f ${TransferEngine.sq(logPath)} 2>/dev/null; true`, dst, 10_000).catch(() => {}),
    ]);
  }

  private async cleanupTempFile(task: TransferTask): Promise<void> {
    try {
      if (task.direction === 'upload' || task.direction === 'remote-copy') {
        // upload 与 remote-copy 的临时文件都在远端（remote-copy 在目标集群）
        await this.adapter.remoteUnlink(task.temporaryPath, task.sessionId!);
      } else {
        await this.adapter.localUnlink(task.temporaryPath);
      }
    } catch {
      // Best-effort cleanup
    }
  }

  // -----------------------------------------------------------------------
  //  Helpers
  // -----------------------------------------------------------------------

  private emitTaskUpdated(task: TransferTask): void {
    this.emit('transfer:updated', { ...task });
  }

  private checkIdle(): void {
    if (this.activeCount === 0 && this.idleResolve) {
      const resolve = this.idleResolve;
      this.idleResolve = null;
      resolve();
    }
  }

  private persist(): Promise<void> {
    return saveTasks([...this.tasks.values()]).catch(() => { /* swallow */ });
  }
}
