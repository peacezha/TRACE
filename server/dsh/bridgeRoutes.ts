// dsh → TRACE 桥路由：dsh 插件（trace-dsh-plugin）通过这些端点在用户集群上执行
// 命令 / 探测 SSH 连通性 / 读写集群文件。鉴权头 X-TRACE-Bridge 必须等于桥 token
// （见 bridgeState）。安全策略与 server/ai/agentRunner 对齐：高风险命令确认后可执行；
// 确认策略来自每个 dsh 会话绑定；远程文件限制在该 SSH 用户 home，
// 本地传输限制在该 dsh 会话选择的工作区。

import fs from 'node:fs';
import type { Express, NextFunction, Request, Response } from 'express';
import type { SFTPWrapper } from 'ssh2';
import { classifyCommandRisk, isCatastrophicCommand, isJobTerminationCommand } from '../ai/commandSafety';
import { invokeWebApi } from '../webapis/invoke';
import { SftpFileService } from '../files/sftpFileService';
import { assertRemotePathWithinRoot } from '../files/pathSafety';
import { extractSubmittedJobIds, isSubmissionCommand } from './jobAgentBindings';
import { getDshInteractionHandler, type DshBridgeBinding, type DshInteractionHandler } from './bridgeState';
import { resolveWorkspaceFilePath } from './workspace';
import {
  isDefiniteSubmissionRejection,
  preflightJobSubmission,
  SUBMISSION_UNKNOWN_GUIDANCE,
  type JobSubmissionClaim,
  type JobSubmissionGuard,
} from '../ai/jobSubmissionGuard';
import type { SchedulerKind } from '../cluster/schedulerProfile';

export interface BridgeClusterSession {
  cluster: {
    exec(command: string, timeoutMs?: number): Promise<string>;
    state: string;
    /** SFTP 未就绪时会 throw（见 ClusterSession.getSftp） */
    getSftp?: () => SFTPWrapper;
    scheduler?: SchedulerKind;
  };
  home?: string;
  info?: { host?: string };
}

/** 文件端点实际用到的 SftpFileService 子集（便于测试注入 mock）。 */
export interface BridgeFsService {
  list(remotePath: string): Promise<unknown[]>;
  stat(remotePath: string): Promise<{ size?: number; kind?: string }>;
  readPreview(remotePath: string, maxBytes: number): Promise<Buffer>;
  writeFile(remotePath: string, content: string): Promise<void>;
}

export interface BridgeRouteDeps {
  getSession: (id: string | undefined) => BridgeClusterSession | undefined;
  getDshSessionBinding: (dshSessionId: string | undefined) => DshBridgeBinding | undefined;
  getBridgeToken: () => string;
  /** 测试注入用；缺省 new SftpFileService(sftp, home, exec) */
  createSftpService?: (
    sftp: SFTPWrapper,
    home: string,
    exec: (command: string, timeoutMs?: number) => Promise<string>,
  ) => BridgeFsService;
  /** 所有 Agent 执行入口共享，防止前台、自动续跑与 dsh 重复提交同一脚本。 */
  jobSubmissionGuard?: JobSubmissionGuard;
  onJobsSubmitted?: (binding: DshBridgeBinding, jobIds: string[]) => void;
  /** sdk 通道的人机交互（审批/反问）处理器查询；缺省直接用 bridgeState 注册表。 */
  getDshInteractionHandler?: (dshSessionId: string | undefined) => DshInteractionHandler | undefined;
}

const FS_LIST_MAX_ENTRIES = 500;
const FS_READ_DEFAULT_BYTES = 256 * 1024;
const FS_READ_MAX_BYTES = 1024 * 1024;
const FS_WRITE_MAX_BYTES = 1024 * 1024;
const FS_TRANSFER_MAX_BYTES = 512 * 1024 * 1024;
const FS_TRANSFER_TIMEOUT_MS = 10 * 60_000;
const DSH_SESSION_HEADER = 'X-TRACE-Dsh-Session';

// 与 server/ai/agentRunner.ts 的 16k 首尾截断等效，避免超长输出灌回 dsh 上下文。
function trunc(s: string, max = 16000): string {
  if (!s) return '(no output)';
  if (s.length <= max) return s;
  return s.slice(0, max / 2) + '\n...[trunc ' + s.length + ' chars]...\n' + s.slice(-max / 2);
}

function errText(err: unknown): string {
  return String(err instanceof Error ? err.message : err).slice(0, 2000);
}

const defaultCreateSftpService = (
  sftp: SFTPWrapper,
  home: string,
  exec: (command: string, timeoutMs?: number) => Promise<string>,
): BridgeFsService => new SftpFileService(sftp, home, exec);

function requiresConfirmation(
  risk: ReturnType<typeof classifyCommandRisk>,
  policy: DshBridgeBinding['confirmationPolicy'],
): boolean {
  if (policy === 'never') return false;
  if (policy === 'every_command') return true;
  if (risk === 'destructive') return true;
  return policy === 'state_changes' && risk !== 'read';
}

/** fastPut/fastGet 的 10 分钟兜底：SFTP 卡死时 reject 而不是挂死请求。 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function fastPutAsync(sftp: SFTPWrapper, localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (err?: Error | null) => (err ? reject(err) : resolve()));
  });
}

function fastGetAsync(sftp: SFTPWrapper, remotePath: string, localPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (err?: Error | null) => (err ? reject(err) : resolve()));
  });
}

/* ---------------- waitForJobs：等待 LSF 作业终态 ---------------- */

export interface WaitedJob {
  jobId: string;
  finalState: 'DONE' | 'EXIT' | 'disappeared' | 'timeout';
  tail?: string;
}

let jobPollIntervalMs = 15_000;

/** 测试钩子：调整 waitForJobs 的 bjobs 轮询间隔（生产保持默认 15s）。 */
export function setJobPollIntervalMs(ms: number): void {
  jobPollIntervalMs = Math.max(1, Math.floor(ms) || 15_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

type LsfPollState = 'RUNNING' | WaitedJob['finalState'];

/** 单次 bjobs 探测：作业从列表消失或状态 DONE/EXIT 即终态（与 jobWatcher 判定一致）。 */
async function pollJobState(
  exec: (command: string, timeoutMs?: number) => Promise<string>,
  jobId: string,
): Promise<LsfPollState> {
  let output: string;
  try {
    output = await exec(`bjobs ${jobId}`, 15_000);
  } catch (err) {
    // bjobs 对已完成作业报错 "Job <id> is not found"：离开调度列表即终态。
    if (/not found|no unfinished job/i.test(String(err instanceof Error ? err.message : err))) {
      return 'disappeared';
    }
    return 'RUNNING'; // 其余错误按仍在运行处理，交给外层超时兜底
  }
  if (!output.split(/\s+/).includes(jobId)) return 'disappeared';
  if (/\bDONE\b/.test(output)) return 'DONE';
  if (/\bEXIT\b/.test(output)) return 'EXIT';
  return 'RUNNING';
}

/** 轮询等待作业终态；终态后取 bpeek 末尾输出；超时返回 finalState='timeout'（无 tail）。 */
export async function waitForLsfJob(
  exec: (command: string, timeoutMs?: number) => Promise<string>,
  jobId: string,
  opts: { timeoutMs: number; pollIntervalMs: number },
): Promise<WaitedJob> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const state = await pollJobState(exec, jobId);
    if (state !== 'RUNNING') {
      const tail = await exec(`bpeek ${jobId} | tail -60`, 20_000).catch(() => '');
      return { jobId, finalState: state, tail };
    }
    if (Date.now() >= deadline) return { jobId, finalState: 'timeout' };
    await sleep(opts.pollIntervalMs);
  }
}

export function registerBridgeRoutes(app: Express, deps: BridgeRouteDeps): void {
  const auth = (req: Request, res: Response, next: NextFunction): void => {
    if (req.get('X-TRACE-Bridge') !== deps.getBridgeToken()) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  };

  const bodyOf = (req: Request): Record<string, unknown> =>
    req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};

  const readString = (body: Record<string, unknown>, key: string): string =>
    typeof body[key] === 'string' ? body[key] as string : '';

  const requireBinding = (req: Request, res: Response): DshBridgeBinding | undefined => {
    const dshSessionId = req.get(DSH_SESSION_HEADER)?.trim();
    const binding = deps.getDshSessionBinding(dshSessionId);
    if (!binding) {
      res.status(409).json({ error: 'dsh_session_not_bound' });
      return undefined;
    }
    return binding;
  };

  // 交互处理器注册表是模块级单例（bridgeState），server.ts 的既有装配不需要改动；
  // 测试可经 deps 注入替身。
  const lookupInteractionHandler = deps.getDshInteractionHandler ?? getDshInteractionHandler;

  const requireCluster = (
    req: Request,
    res: Response,
  ): { binding: DshBridgeBinding; session: BridgeClusterSession } | undefined => {
    const binding = requireBinding(req, res);
    if (!binding) return undefined;
    const session = deps.getSession(binding.sshSessionId);
    if (!session || session.cluster.state !== 'connected') {
      res.status(409).json({ error: 'no_cluster_session' });
      return undefined;
    }
    return { binding, session };
  };

  /** fs 端点公共前置：会话连接判定 + getSftp（未就绪 409 sftp_not_ready）+ service 工厂。 */
  const requireFs = (
    req: Request,
    res: Response,
  ): { binding: DshBridgeBinding; sftp: SFTPWrapper; home: string; service: BridgeFsService } | undefined => {
    const cluster = requireCluster(req, res);
    if (!cluster) return undefined;
    const { binding, session } = cluster;
    if (typeof session.cluster.getSftp !== 'function') {
      res.status(409).json({ error: 'sftp_not_ready' });
      return undefined;
    }
    let sftp: SFTPWrapper;
    try {
      sftp = session.cluster.getSftp();
    } catch (err) {
      res.status(409).json({ error: 'sftp_not_ready', message: errText(err) });
      return undefined;
    }
    const home = session.home || '/';
    const createService = deps.createSftpService || defaultCreateSftpService;
    return { binding, sftp, home, service: createService(sftp, home, session.cluster.exec.bind(session.cluster)) };
  };

  app.post('/api/bridge/exec', auth, async (req: Request, res: Response) => {
    const body = bodyOf(req);
    const command = readString(body, 'command');
    if (!command.trim()) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    if (isCatastrophicCommand(command)) {
      res.status(422).json({ error: 'catastrophic_command_blocked' });
      return;
    }
    const cluster = requireCluster(req, res);
    if (!cluster) return;
    const risk = classifyCommandRisk(command);
    if (cluster.binding.readOnly && risk !== 'read') {
      res.status(409).json({ error: 'clarification_read_only', message: 'The user requested an explanation, not execution permission.' });
      return;
    }
    if ((isJobTerminationCommand(command) || requiresConfirmation(risk, cluster.binding.confirmationPolicy)) && body.confirmed !== true) {
      res.status(428).json({ error: 'confirmation_required', risk });
      return;
    }
    const { session, binding } = cluster;
    const rawTimeout = Number(body.timeoutMs);
    const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 30_000;
    let submissionClaim: JobSubmissionClaim | undefined;
    const submission = isSubmissionCommand(command);
    try {
      if (submission && deps.jobSubmissionGuard) {
        const preflight = await preflightJobSubmission(
          command,
          { conversationKey: binding.conversationKey },
          session.cluster.exec.bind(session.cluster),
        );
        if (!preflight.ok) {
          res.json({
            ok: false,
            output: '',
            error: `[提交前检查未通过，尚未提交作业]\n${preflight.output}`,
            code: 'submission_preflight_failed',
          });
          return;
        }
        const decision = await deps.jobSubmissionGuard.prepare({
          sessionId: binding.sshSessionId,
          conversationKey: binding.conversationKey,
          command,
          scheduler: session.cluster.scheduler,
          exec: session.cluster.exec.bind(session.cluster),
        });
        if (decision.kind === 'busy') {
          res.json({
            ok: false,
            output: '',
            error: '相同作业提交正在由另一个 Agent 执行；本次已拦截，避免重复提交。',
            code: 'duplicate_submission_in_progress',
          });
          return;
        }
        if (decision.kind === 'unknown') {
          if (body.confirmed !== true) {
            res.status(428).json({
              error: 'confirmation_required',
              code: 'submission_result_unknown',
              risk: 'destructive',
              message: SUBMISSION_UNKNOWN_GUIDANCE,
            });
            return;
          }
          submissionClaim = deps.jobSubmissionGuard.retryUnknown(decision.record);
        }
        if (decision.kind === 'reuse') {
          const reusedOutput = decision.record.jobIds
            .map(jobId => `Job <${jobId}> is submitted. [IDEMPOTENT_REUSE: no new submission]`)
            .join('\n');
          res.json({ ok: true, exitCode: 0, output: reusedOutput, reused: true });
          return;
        }
        if (decision.kind === 'execute') submissionClaim = decision.claim;
      }
      const output = await session.cluster.exec(command, timeoutMs);
      const jobIds = submission ? extractSubmittedJobIds(output) : [];
      if (submission && jobIds.length === 0) {
        if (submissionClaim) {
          try { deps.jobSubmissionGuard?.markUnknown(submissionClaim); } catch { /* 保留原始提交结果 */ }
        }
        res.json({ ok: false, output: trunc(output), error: SUBMISSION_UNKNOWN_GUIDANCE, code: 'submission_result_unknown' });
        return;
      }
      if (submissionClaim) {
        try {
          deps.jobSubmissionGuard?.complete(submissionClaim, jobIds);
        } catch (ledgerError) {
          // 已有调度器回执时保持成功语义，避免 dsh 因本地落盘错误重试提交。
          console.error('[submit-guard] dsh 提交账本落盘失败:', ledgerError);
        }
      }
      // Return the submission receipt immediately; never wait for an HPC job
      // inside an Agent RPC with a shorter execution deadline.
      if (jobIds.length) {
        try { deps.onJobsSubmitted?.(binding, jobIds); } catch (error) {
          console.error('[dsh-bridge] watcher registration failed:', errText(error));
        }
      }
      const rawWait = Number(body.waitForJobs);
      if (Number.isFinite(rawWait) && rawWait > 0 && jobIds.length) {
        res.json({ ok: true, exitCode: 0, output: trunc(output) + '\n[TRACE_BACKGROUND_JOB] Submission acknowledged for ' + jobIds.join(', ')
          + '. Inline waiting is disabled; use background monitoring and mark the workflow waiting_jobs. Submitted does not mean completed or QC-passed. Do not resubmit or poll in the Agent turn.' });
        return;
      }
      res.json({ ok: true, exitCode: 0, output: trunc(output) });
    } catch (err) {
      const rejected = submission && isDefiniteSubmissionRejection(err);
      if (submissionClaim) {
        try {
          if (rejected) deps.jobSubmissionGuard?.fail(submissionClaim);
          else deps.jobSubmissionGuard?.markUnknown(submissionClaim);
        } catch { /* 保留原始命令错误 */ }
      }
      const message = errText(err);
      // 执行失败也回 200：让 dsh 侧把错误信息当工具结果读出来，由模型自行调整。
      res.json({
        ok: false,
        exitCode: undefined,
        output: '',
        error: submission
          ? `${rejected ? '[调度器明确拒绝提交，尚未提交作业]' : `[${SUBMISSION_UNKNOWN_GUIDANCE}]`}\n${message}`
          : message,
        ...(submission ? { code: rejected ? 'submission_rejected' : 'submission_result_unknown' } : {}),
      });
    }
  });

  app.get('/api/bridge/status', auth, (req: Request, res: Response) => {
    const binding = requireBinding(req, res);
    if (!binding) return;
    const session = deps.getSession(binding.sshSessionId);
    const sshConnected = Boolean(session && session.cluster.state === 'connected');
    const payload: Record<string, unknown> = { ok: true, sshConnected };
    if (sshConnected && session?.info?.host) payload.host = session.info.host;
    res.json(payload);
  });

  /* ---------------- 公共生信数据 API（不经集群，服务端本机网络） ---------------- */

  // body { service, endpoint, params } → invokeWebApi。只查公共只读数据，
  // 不涉及集群会话，因此不要求 dsh 会话绑定/集群连接（token 守卫即可）。
  app.post('/api/bridge/webapi', auth, async (req: Request, res: Response) => {
    const body = bodyOf(req);
    const service = readString(body, 'service');
    const endpoint = readString(body, 'endpoint');
    if (!service.trim() || !endpoint.trim()) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const params = body.params && typeof body.params === 'object' && !Array.isArray(body.params)
      ? body.params as Record<string, unknown>
      : {};
    try {
      const result = await invokeWebApi(service.trim(), endpoint.trim(), params);
      res.json(result);
    } catch (err) {
      res.json({ ok: false, error: { code: 'internal_error', message: errText(err) } });
    }
  });

  /* ---------------- 集群文件互通 ---------------- */

  app.post('/api/bridge/fs/list', auth, async (req: Request, res: Response) => {
    const body = bodyOf(req);
    const remotePath = readString(body, 'path');
    if (!remotePath.trim()) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const ctx = requireFs(req, res);
    if (!ctx) return;
    if (requiresConfirmation('read', ctx.binding.confirmationPolicy) && body.confirmed !== true) {
      res.status(428).json({ error: 'confirmation_required', risk: 'read', action: 'list' });
      return;
    }
    try {
      const safeRemote = assertRemotePathWithinRoot(remotePath, ctx.home, { allowRoot: true });
      const entries = await ctx.service.list(safeRemote);
      const truncated = entries.length > FS_LIST_MAX_ENTRIES;
      res.json({
        ok: true,
        path: safeRemote,
        entries: truncated ? entries.slice(0, FS_LIST_MAX_ENTRIES) : entries,
        ...(truncated ? { truncated: true } : {}),
      });
    } catch (err) {
      res.json({ ok: false, error: errText(err) });
    }
  });

  app.post('/api/bridge/fs/read', auth, async (req: Request, res: Response) => {
    const body = bodyOf(req);
    const remotePath = readString(body, 'path');
    if (!remotePath.trim()) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const ctx = requireFs(req, res);
    if (!ctx) return;
    if (requiresConfirmation('read', ctx.binding.confirmationPolicy) && body.confirmed !== true) {
      res.status(428).json({ error: 'confirmation_required', risk: 'read', action: 'read' });
      return;
    }
    const rawMax = Number(body.maxBytes);
    const maxBytes = Number.isFinite(rawMax) && rawMax > 0
      ? Math.min(Math.floor(rawMax), FS_READ_MAX_BYTES)
      : FS_READ_DEFAULT_BYTES;
    try {
      const safeRemote = assertRemotePathWithinRoot(remotePath, ctx.home, { allowRoot: true });
      const content = await ctx.service.readPreview(safeRemote, maxBytes);
      // 优先用 stat 的真实大小判断截断；stat 失败退化为"读满上限即截断"启发式。
      let truncated = content.length >= maxBytes;
      try {
        const stat = await ctx.service.stat(safeRemote);
        if (typeof stat.size === 'number') truncated = stat.size > content.length;
      } catch { /* 用长度启发式即可 */ }
      res.json({
        ok: true,
        path: safeRemote,
        content: content.toString('utf8'),
        ...(truncated ? { truncated: true } : {}),
      });
    } catch (err) {
      res.json({ ok: false, error: errText(err) });
    }
  });

  app.post('/api/bridge/fs/write', auth, async (req: Request, res: Response) => {
    const body = bodyOf(req);
    const remotePath = readString(body, 'path');
    if (!remotePath.trim() || typeof body.content !== 'string') {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const content = body.content;
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > FS_WRITE_MAX_BYTES) {
      res.status(413).json({ error: 'too_large' });
      return;
    }
    const ctx = requireFs(req, res);
    if (!ctx) return;
    if (ctx.binding.readOnly) { res.status(409).json({ error: 'clarification_read_only' }); return; }
    if (requiresConfirmation('write', ctx.binding.confirmationPolicy) && body.confirmed !== true) {
      res.status(428).json({ error: 'confirmation_required', risk: 'write', action: 'write' });
      return;
    }
    try {
      const safeRemote = assertRemotePathWithinRoot(remotePath, ctx.home);
      await ctx.service.writeFile(safeRemote, content);
      res.json({ ok: true, path: safeRemote, bytes });
    } catch (err) {
      res.json({ ok: false, error: errText(err) });
    }
  });

  app.post('/api/bridge/fs/push', auth, async (req: Request, res: Response) => {
    const body = bodyOf(req);
    const localPath = readString(body, 'localPath');
    const remotePath = readString(body, 'remotePath');
    if (!localPath.trim() || !remotePath.trim()) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const ctx = requireFs(req, res);
    if (!ctx) return;
    if (ctx.binding.readOnly) { res.status(409).json({ error: 'clarification_read_only' }); return; }
    if (requiresConfirmation('write', ctx.binding.confirmationPolicy) && body.confirmed !== true) {
      res.status(428).json({ error: 'confirmation_required', risk: 'write', action: 'push' });
      return;
    }
    try {
      const safeLocal = resolveWorkspaceFilePath(ctx.binding.workspaceRoot, localPath, { mustExist: true });
      const localStat = fs.statSync(safeLocal);
      if (!localStat.isFile()) {
        res.status(400).json({ error: 'invalid_request', message: 'local path is not a file' });
        return;
      }
      if (localStat.size > FS_TRANSFER_MAX_BYTES) {
        res.status(413).json({ error: 'too_large' });
        return;
      }
      const safeRemote = assertRemotePathWithinRoot(remotePath, ctx.home);
      await withTimeout(fastPutAsync(ctx.sftp, safeLocal, safeRemote), FS_TRANSFER_TIMEOUT_MS, 'sftp fastPut');
      res.json({ ok: true, localPath: safeLocal, remotePath: safeRemote, bytes: localStat.size });
    } catch (err) {
      const message = errText(err);
      if (message === 'local file not found') {
        res.status(400).json({ error: 'invalid_request', message });
        return;
      }
      res.json({ ok: false, error: message });
    }
  });

  app.post('/api/bridge/fs/pull', auth, async (req: Request, res: Response) => {
    const body = bodyOf(req);
    const remotePath = readString(body, 'remotePath');
    const localPath = readString(body, 'localPath');
    if (!remotePath.trim() || !localPath.trim()) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const ctx = requireFs(req, res);
    if (!ctx) return;
    if (ctx.binding.readOnly) { res.status(409).json({ error: 'clarification_read_only' }); return; }
    if (requiresConfirmation('write', ctx.binding.confirmationPolicy) && body.confirmed !== true) {
      res.status(428).json({ error: 'confirmation_required', risk: 'write', action: 'pull' });
      return;
    }
    try {
      const safeLocal = resolveWorkspaceFilePath(ctx.binding.workspaceRoot, localPath);
      if (body.overwrite !== true && fs.existsSync(safeLocal)) {
        res.status(409).json({ error: 'exists' });
        return;
      }
      const safeRemote = assertRemotePathWithinRoot(remotePath, ctx.home, { allowRoot: true });
      const stat = await ctx.service.stat(safeRemote);
      if (stat.kind && stat.kind !== 'file') {
        res.status(400).json({ error: 'invalid_request', message: 'remote path is not a file' });
        return;
      }
      const size = typeof stat.size === 'number' ? stat.size : 0;
      if (size > FS_TRANSFER_MAX_BYTES) {
        res.status(413).json({ error: 'too_large' });
        return;
      }
      await withTimeout(fastGetAsync(ctx.sftp, safeRemote, safeLocal), FS_TRANSFER_TIMEOUT_MS, 'sftp fastGet');
      res.json({ ok: true, remotePath: safeRemote, localPath: safeLocal, bytes: size });
    } catch (err) {
      res.json({ ok: false, error: errText(err) });
    }
  });

  /* ---------------- 人机交互回桥（sdk 通道的审批/反问应答） ----------------
   * sdk profile 里 approval/request 与 user-questions/request 瀑布没有官方
   * 客户端应答器；插件内 HTTP 应答器把请求 POST 到这里，由当前持有该 dsh 会话的
   * runner（registerDshInteractionHandler）给出用户裁决。长时间挂起属正常
   * （等待用户操作），插件侧自带超时与 signal 取消。 */

  app.post('/api/bridge/interaction/approval', auth, async (req: Request, res: Response) => {
    const body = bodyOf(req);
    const sessionId = readString(body, 'sessionId');
    const handler = lookupInteractionHandler(sessionId);
    if (!handler) {
      res.json({ outcome: 'unavailable' });
      return;
    }
    try {
      const outcome = await handler.onApproval({
        requestId: readString(body, 'requestId'),
        sessionId,
        toolName: readString(body, 'toolName'),
        ...(readString(body, 'callId') ? { callId: readString(body, 'callId') } : {}),
        ...(readString(body, 'reason') ? { reason: readString(body, 'reason') } : {}),
      });
      res.json({ outcome });
    } catch (err) {
      console.warn('[dsh-bridge] 审批应答处理失败（fail-closed）: %s', errText(err));
      res.json({ outcome: 'unavailable' });
    }
  });

  app.post('/api/bridge/interaction/questions', auth, async (req: Request, res: Response) => {
    const body = bodyOf(req);
    const sessionId = readString(body, 'sessionId');
    const handler = lookupInteractionHandler(sessionId);
    if (!handler) {
      res.status(409).json({ error: 'no_answerer' });
      return;
    }
    try {
      const questions = Array.isArray(body.questions) ? body.questions : [];
      const answer = await handler.onQuestions({
        requestId: readString(body, 'requestId'),
        sessionId,
        ...(readString(body, 'callId') ? { callId: readString(body, 'callId') } : {}),
        questions,
      });
      if (!answer) {
        res.status(409).json({ error: 'no_answerer' });
        return;
      }
      res.json({ answer });
    } catch (err) {
      console.warn('[dsh-bridge] 反问应答处理失败: %s', errText(err));
      res.status(500).json({ error: 'answerer_failed', message: errText(err) });
    }
  });
}
