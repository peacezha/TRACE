import { describe, expect, it, vi } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { TransferEngine, type TransferAdapter } from './transferEngine';
import type { TransferTask } from '../../shared/fileTransfer';

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function defaultAdapter(): TransferAdapter {
  return {
    remoteSize: async () => 0,
    localSize: async () => 0,
    remoteFingerprint: async () => ({ size: 4096, mtime: 1000 }),
    localFingerprint: async () => ({ size: 4096, mtime: 1000 }),
    openLocalRead: (_path, _offset) => Readable.from(Buffer.alloc(10)),
    openRemoteWrite: (_path, _offset) => new Writable({
      write(_chunk, _encoding, cb) { cb(); },
    }),
    openRemoteRead: (_path, _offset) => Readable.from(Buffer.alloc(10)),
    openLocalWrite: (_path, _offset) => new Writable({
      write(_chunk, _encoding, cb) { cb(); },
    }),
    verify: async () => {},
    remoteRename: async () => {},
    localRename: async () => {},
    remoteUnlink: async () => {},
    localUnlink: async () => {},
  };
}

function failingVerifyAdapter(error: Error): TransferAdapter {
  const base = defaultAdapter();
  base.openRemoteWrite = () => new Writable({
    write(chunk, _encoding, cb) { cb(); },
  });
  base.verify = async () => { throw error; };
  return base;
}

function enqueueFixture(engine: TransferEngine): TransferTask {
  return engine.enqueue({
    profileId: 'p1',
    direction: 'upload',
    localPath: 'D:\\a.bin',
    remotePath: '/data/a.bin',
    temporaryPath: '/data/.a.bin.trace-t1.part',
    totalBytes: 4096,
    transferredBytes: 0,
    conflictPolicy: 'overwrite',
    verificationMode: 'size',
    retryCount: 0,
  });
}

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

describe('TransferEngine', () => {
  describe('enqueue / list', () => {
    it('creates a queued task with generated id and timestamps', () => {
      const engine = new TransferEngine(defaultAdapter(), { concurrency: 1, emit: () => {} });
      const task = enqueueFixture(engine);

      expect(task.id).toBeTruthy();
      expect(task.state).toBe('queued');
      expect(task.createdAt).toBeGreaterThan(0);
      expect(task.updatedAt).toBeGreaterThan(0);

      const listed = engine.list();
      expect(listed).toHaveLength(1);
      expect(listed[0].id).toBe(task.id);
    });
  });

  describe('upload flow', () => {
    it('resumes an upload at the confirmed remote temporary-file size and atomically renames it', async () => {
      const calls: string[] = [];
      const adapter = defaultAdapter();
      adapter.remoteSize = async () => 1024;
      adapter.openLocalRead = vi.fn((_path, offset) => {
        expect(offset).toBe(1024);
        return Readable.from(Buffer.alloc(3072));
      });
      adapter.openRemoteWrite = vi.fn((_path, offset) => {
        expect(offset).toBe(1024);
        return new Writable({ write(chunk, _encoding, cb) { cb(); } });
      });
      adapter.verify = async () => { calls.push('verify'); };
      adapter.remoteRename = async () => { calls.push('rename'); };

      const engine = new TransferEngine(adapter as any, { concurrency: 1, emit: () => {} });
      const task = engine.enqueue({
        profileId: 'p1', direction: 'upload', localPath: 'D:\\a.bin', remotePath: '/data/a.bin',
        temporaryPath: '/data/.a.bin.trace-t1.part', totalBytes: 4096, transferredBytes: 1024,
        conflictPolicy: 'resume', verificationMode: 'size', retryCount: 0,
      });
      await engine.resume(task.id, 'session-1');
      await engine.waitForIdle();
      expect(calls).toEqual(['verify', 'rename']);
      expect(engine.list()[0].state).toBe('completed');
    });

    it('completes a fresh upload with verification and atomic rename', async () => {
      const calls: string[] = [];
      const adapter = defaultAdapter();
      adapter.openLocalRead = vi.fn((_path, _offset) => Readable.from(Buffer.alloc(4096)));
      adapter.openRemoteWrite = vi.fn((_path, _offset) => new Writable({
        write(chunk, _encoding, cb) { cb(); },
      }));
      adapter.verify = async () => { calls.push('verify'); };
      adapter.remoteRename = async () => { calls.push('rename'); };

      const engine = new TransferEngine(adapter as any, { concurrency: 1, emit: () => {} });
      const task = enqueueFixture(engine);
      await engine.resume(task.id, 'session-1');
      await engine.waitForIdle();
      expect(calls).toEqual(['verify', 'rename']);
      expect(engine.list()[0].state).toBe('completed');
    });
  });

  describe('download flow', () => {
    it('downloads a file from remote to local with verification and atomic rename', async () => {
      const calls: string[] = [];
      const adapter = defaultAdapter();
      adapter.openRemoteRead = vi.fn((_path, offset) => {
        expect(offset).toBe(0);
        return Readable.from(Buffer.alloc(4096));
      });
      adapter.openLocalWrite = vi.fn((_path, offset) => {
        expect(offset).toBe(0);
        return new Writable({ write(chunk, _encoding, cb) { cb(); } });
      });
      adapter.verify = async () => { calls.push('verify'); };
      adapter.localRename = async () => { calls.push('rename'); };

      const engine = new TransferEngine(adapter as any, { concurrency: 1, emit: () => {} });
      const task = engine.enqueue({
        profileId: 'p1', direction: 'download', localPath: 'D:\\a.bin', remotePath: '/data/a.bin',
        temporaryPath: 'D:\\.a.bin.trace-t1.part', totalBytes: 4096, transferredBytes: 0,
        conflictPolicy: 'overwrite', verificationMode: 'size', retryCount: 0,
      });
      await engine.resume(task.id, 'session-1');
      await engine.waitForIdle();
      expect(calls).toEqual(['verify', 'rename']);
      expect(engine.list()[0].state).toBe('completed');
    });
  });

  describe('error handling', () => {
    it.each([
      ['size mismatch', 'failed'],
      ['checksum mismatch', 'failed'],
      ['permission denied', 'failed'],
    ])('does not mark %s as complete', async (message, expectedState) => {
      const engine = new TransferEngine(failingVerifyAdapter(new Error(message)), { concurrency: 1, emit: () => {} });
      const task = enqueueFixture(engine);
      await engine.resume(task.id, 'session-1');
      await engine.waitForIdle();
      expect(engine.list()[0].state).toBe(expectedState);
    });
  });

  describe('pause / resume', () => {
    it('pauses a running upload and resumes it', async () => {
      const adapter = defaultAdapter();

      // Use a writable that blocks the first chunk so we can pause
      let writeBlocked = true;
      let writeStarted = false;
      adapter.openLocalRead = vi.fn(() => Readable.from(Buffer.alloc(4096)));
      adapter.openRemoteWrite = vi.fn(() => new Writable({
        write(chunk, _encoding, cb) {
          writeStarted = true;
          if (writeBlocked) {
            // Don't call cb — keep the pipeline alive so we can abort it
            return;
          }
          cb();
        },
      }));

      const engine = new TransferEngine(adapter as any, { concurrency: 1, emit: () => {} });
      const task = enqueueFixture(engine);
      // Resume to start the queued task
      await engine.resume(task.id, 'session-1');

      // Wait for the pipeline to reach the blocked write
      await vi.waitFor(() => expect(writeStarted).toBe(true), { timeout: 2000 });

      // Pause — this must abort the controller signal to break the pipeline
      await engine.pause(task.id);
      expect(engine.list()[0].state).toBe('paused');
      expect(engine.list()[0].transferredBytes).toBeGreaterThan(0);

      // Unblock for resume
      writeBlocked = false;
      adapter.openLocalRead = vi.fn((_path, offset) => {
        const remaining = Math.max(0, 4096 - offset);
        return Readable.from(remaining > 0 ? Buffer.alloc(remaining) : Buffer.alloc(0));
      });
      adapter.openRemoteWrite = vi.fn(() => new Writable({
        write(chunk, _encoding, cb) { cb(); },
      }));

      await engine.resume(task.id, 'session-1');
      await engine.waitForIdle();
      expect(engine.list()[0].state).toBe('completed');
    });
  });

  describe('cancel', () => {
    it('cancels a running upload and leaves it in cancelled state', async () => {
      const adapter = defaultAdapter();
      let writeStarted = false;
      adapter.openLocalRead = vi.fn(() => Readable.from(Buffer.alloc(10000)));
      adapter.openRemoteWrite = vi.fn(() => new Writable({
        write(chunk, _encoding, cb) {
          writeStarted = true;
          // Slow write to keep the transfer running
          setTimeout(cb, 50);
        },
      }));

      const engine = new TransferEngine(adapter as any, { concurrency: 1, emit: () => {} });
      const task = enqueueFixture(engine);
      await engine.resume(task.id, 'session-1');

      // Wait for write to start
      await vi.waitFor(() => expect(writeStarted).toBe(true), { timeout: 2000 });

      await engine.cancel(task.id);
      expect(engine.list()[0].state).toBe('cancelled');
    });
  });

  describe('remove / clearCompleted', () => {
    it('removes a terminal-state task and rejects removing an active one', async () => {
      const engine = new TransferEngine(defaultAdapter(), { concurrency: 1, emit: () => {} });
      const task = enqueueFixture(engine);

      // queued is active — cannot be removed
      expect(() => engine.remove(task.id)).toThrow(/Cannot remove/);
      expect(engine.list()).toHaveLength(1);

      // after completion the task can be removed
      await engine.resume(task.id, 'session-1');
      await vi.waitFor(() => expect(engine.list()[0]?.state).toBe('completed'), { timeout: 2000 });
      engine.remove(task.id);
      expect(engine.list()).toHaveLength(0);
    });

    it('clearCompleted drops completed and cancelled tasks but keeps failed and paused', async () => {
      const adapter = defaultAdapter();
      const engine = new TransferEngine(adapter, { concurrency: 1, emit: () => {} });

      const done = enqueueFixture(engine);
      await engine.resume(done.id, 'session-1');
      await vi.waitFor(() => expect(engine.list()[0]?.state).toBe('completed'), { timeout: 2000 });

      const failing = enqueueFixture(engine);
      (engine as any).tasks.get(failing.id)!.state = 'failed';
      const paused = enqueueFixture(engine);
      (engine as any).tasks.get(paused.id)!.state = 'paused';

      const removed = engine.clearCompleted();
      expect(removed).toEqual([done.id]);
      expect(engine.list().map(t => t.id).sort()).toEqual([failing.id, paused.id].sort());
    });
  });

  describe('retry', () => {
    it('retries network errors up to three times', async () => {
      let attempts = 0;
      const adapter = defaultAdapter();
      adapter.openRemoteWrite = vi.fn(() => new Writable({
        write(_chunk, _encoding, cb) {
          attempts++;
          cb(new Error('connection reset'));
        },
      }));

      const engine = new TransferEngine(adapter as any, { concurrency: 1, emit: () => {} });
      const task = enqueueFixture(engine);
      await engine.resume(task.id, 'session-1');
      await engine.waitForIdle();

      // Initial attempt + 3 retries = 4 total
      expect(attempts).toBe(4);
      expect(engine.list()[0].state).toBe('failed');
      expect(engine.list()[0].retryCount).toBe(3);
    });

    it('does not retry authentication or permission errors', async () => {
      const adapter = defaultAdapter();
      adapter.openRemoteWrite = vi.fn(() => new Writable({
        write(_chunk, _encoding, cb) {
          cb(new Error('Permission denied'));
        },
      }));

      const engine = new TransferEngine(adapter as any, { concurrency: 1, emit: () => {} });
      const task = enqueueFixture(engine);
      await engine.resume(task.id, 'session-1');
      await engine.waitForIdle();

      expect(engine.list()[0].state).toBe('failed');
      expect(engine.list()[0].retryCount).toBe(0);
    });

    it('resets retryCount and error on explicit retry after failure', async () => {
      const adapter = defaultAdapter();
      adapter.openRemoteWrite = vi.fn(() => new Writable({
        write(_chunk, _encoding, cb) { cb(new Error('connection reset')); },
      }));

      const engine = new TransferEngine(adapter as any, { concurrency: 1, emit: () => {} });
      const task = enqueueFixture(engine);
      await engine.resume(task.id, 'session-1');
      await engine.waitForIdle();
      expect(engine.list()[0].state).toBe('failed');

      // Replace with working adapter
      adapter.openRemoteWrite = vi.fn(() => new Writable({
        write(chunk, _encoding, cb) { cb(); },
      }));
      adapter.verify = async () => {};
      adapter.remoteRename = async () => {};

      await engine.retry(task.id, 'session-1');
      await engine.waitForIdle();
      expect(engine.list()[0].state).toBe('completed');
    });
  });

  describe('concurrency', () => {
    it('limits concurrent transfers to the configured concurrency level', async () => {
      let runningCount = 0;
      let maxConcurrent = 0;
      const adapter = defaultAdapter();

      adapter.openLocalRead = vi.fn(() => Readable.from(Buffer.alloc(100)));
      adapter.openRemoteWrite = vi.fn(() => new Writable({
        write(chunk, _encoding, cb) {
          runningCount++;
          maxConcurrent = Math.max(maxConcurrent, runningCount);
          setImmediate(() => {
            runningCount--;
            cb();
          });
        },
      }));

      const engine = new TransferEngine(adapter as any, { concurrency: 2, emit: () => {} });

      const t1 = enqueueFixture(engine);
      const t2 = enqueueFixture(engine);
      const t3 = enqueueFixture(engine);

      await engine.resume(t1.id, 'session-1');
      await engine.resume(t2.id, 'session-1');

      // Let t1 and t2 start, then resume t3 (which must wait for capacity)
      await new Promise(resolve => setTimeout(resolve, 10));
      await engine.resume(t3.id, 'session-1');

      await engine.waitForIdle();

      // Max concurrent should not exceed 2
      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });
  });

  describe('progress events', () => {
    it('emits transfer:updated events during transfer', async () => {
      const events: any[] = [];
      const adapter = defaultAdapter();
      adapter.openLocalRead = vi.fn(() => Readable.from(Buffer.alloc(4096)));
      adapter.openRemoteWrite = vi.fn(() => new Writable({
        write(chunk, _encoding, cb) { cb(); },
      }));

      const engine = new TransferEngine(adapter as any, {
        concurrency: 1,
        emit: (event: string, data: any) => {
          if (event === 'transfer:updated') events.push(data);
        },
      });
      const task = enqueueFixture(engine);
      await engine.resume(task.id, 'session-1');
      await engine.waitForIdle();

      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[events.length - 1].state).toBe('completed');
    });
  });

  describe('session keepalive（断线保活）', () => {
    it('calls ensureSessionAlive when a transfer hits a dropped session and completes once revived', async () => {
      const adapter = defaultAdapter();
      const ensureSessionAlive = vi.fn(async () => true);
      adapter.ensureSessionAlive = ensureSessionAlive;
      let writeAttempts = 0;
      adapter.openRemoteWrite = vi.fn(() => {
        writeAttempts++;
        if (writeAttempts === 1) throw new Error('SSH session not found');
        return new Writable({ write(_chunk, _encoding, cb) { cb(); } });
      });

      const engine = new TransferEngine(adapter, { concurrency: 1, emit: () => {} });
      const task = enqueueFixture(engine);
      await engine.resume(task.id, 'session-1');
      await engine.waitForIdle();

      expect(engine.list()[0].state).toBe('completed');
      expect(writeAttempts).toBe(2);
      expect(ensureSessionAlive).toHaveBeenCalledWith('session-1');
    });

    it('retries "SSH session not found" up to three times (断连错误进重试名单)', async () => {
      const adapter = defaultAdapter();
      adapter.verify = vi.fn(async () => { throw new Error('SSH session not found'); });

      const engine = new TransferEngine(adapter, { concurrency: 1, emit: () => {} });
      const task = enqueueFixture(engine);
      await engine.resume(task.id, 'session-1');
      await engine.waitForIdle();

      // 首次 + 3 次重试
      expect(adapter.verify).toHaveBeenCalledTimes(4);
      expect(engine.list()[0].state).toBe('failed');
      expect(engine.list()[0].retryCount).toBe(3);
    });

    it('fails through the normal retry-exhaustion path when the session cannot be revived', async () => {
      const adapter = defaultAdapter();
      const ensureSessionAlive = vi.fn(async () => false);
      adapter.ensureSessionAlive = ensureSessionAlive;
      adapter.openRemoteWrite = vi.fn(() => new Writable({
        write(_chunk, _encoding, cb) { cb(); },
      }));

      const engine = new TransferEngine(adapter, { concurrency: 1, emit: () => {} });
      const task = enqueueFixture(engine);
      await engine.resume(task.id, 'session-1');
      await engine.waitForIdle();

      // 阶段预检抛 "SSH session not found"，传输体从未执行；重试耗尽后按原逻辑失败
      expect(adapter.openRemoteWrite).not.toHaveBeenCalled();
      expect(ensureSessionAlive).toHaveBeenCalledWith('session-1');
      expect(engine.list()[0].state).toBe('failed');
      expect(engine.list()[0].retryCount).toBe(3);
      expect(engine.list()[0].error).toContain('SSH session not found');
    });

    it('keeps permission errors non-retryable even with a keepalive hook installed', async () => {
      const adapter = defaultAdapter();
      adapter.ensureSessionAlive = vi.fn(async () => true);
      adapter.openRemoteWrite = vi.fn(() => new Writable({
        write(_chunk, _encoding, cb) { cb(new Error('Permission denied')); },
      }));

      const engine = new TransferEngine(adapter, { concurrency: 1, emit: () => {} });
      const task = enqueueFixture(engine);
      await engine.resume(task.id, 'session-1');
      await engine.waitForIdle();

      expect(engine.list()[0].state).toBe('failed');
      expect(engine.list()[0].retryCount).toBe(0);
    });
  });

  describe('hasSessionActivity（会话淘汰保护）', () => {
    it('reports queued/running/retrying/paused tasks on sessionId and remote-copy sourceSessionId', () => {
      const engine = new TransferEngine(defaultAdapter(), { concurrency: 1, emit: () => {} });
      const task = enqueueFixture(engine);
      const stored = (engine as any).tasks.get(task.id)!;
      stored.sessionId = 'session-1';

      // queued 即算活跃；无关会话不受影响
      expect(engine.hasSessionActivity('session-1')).toBe(true);
      expect(engine.hasSessionActivity('other-session')).toBe(false);

      for (const state of ['running', 'retrying', 'paused'] as const) {
        stored.state = state;
        expect(engine.hasSessionActivity('session-1')).toBe(true);
      }
      for (const state of ['completed', 'failed', 'cancelled'] as const) {
        stored.state = state;
        expect(engine.hasSessionActivity('session-1')).toBe(false);
      }

      // remote-copy 的源侧（读取端）会话同样受保护
      stored.state = 'paused';
      stored.sessionId = 'dest-session';
      stored.sourceSessionId = 'source-session';
      expect(engine.hasSessionActivity('source-session')).toBe(true);
      expect(engine.hasSessionActivity('dest-session')).toBe(true);
    });
  });
});

describe('remote-copy flow (集群↔集群)', () => {
  it('streams source-cluster SFTP to dest-cluster SFTP and renames on dest', async () => {
    const io: string[] = [];
    const adapter = defaultAdapter();
    adapter.remoteSize = async () => 4096; // verify: src == dst
    adapter.openRemoteRead = (path, _offset, sessionId) => {
      io.push(`read:${path}@${sessionId}`);
      return Readable.from(Buffer.alloc(4096));
    };
    adapter.openRemoteWrite = (path, _offset, sessionId) => {
      io.push(`write:${path}@${sessionId}`);
      return new Writable({ write(_c, _e, cb) { cb(); } });
    };
    adapter.remoteRename = async (from, to, sessionId) => {
      io.push(`rename:${from}->${to}@${sessionId}`);
    };

    const engine = new TransferEngine(adapter, { concurrency: 1, emit: () => {} });
    const task = engine.enqueue({
      profileId: 'p1',
      direction: 'remote-copy',
      sourceSessionId: 'sess-A',
      localPath: '/dest/f.bin',
      remotePath: '/src/f.bin',
      temporaryPath: '/dest/.f.bin.trace-t1.part',
      totalBytes: 4096,
      transferredBytes: 0,
      conflictPolicy: 'overwrite',
      verificationMode: 'size',
      retryCount: 0,
    });
    await engine.resume(task.id, 'sess-B');
    await engine.waitForIdle();

    const done = engine.list().find(t => t.id === task.id);
    expect(done?.state).toBe('completed');
    expect(io).toContain('read:/src/f.bin@sess-A');
    expect(io).toContain('write:/dest/.f.bin.trace-t1.part@sess-B');
    expect(io).toContain('rename:/dest/.f.bin.trace-t1.part->/dest/f.bin@sess-B');
  });

  it('runs permission preflight before opening either remote stream', async () => {
    const order: string[] = [];
    const adapter = defaultAdapter();
    adapter.prepareRemoteCopy = async () => { order.push('preflight'); };
    adapter.remoteSize = async () => 10;
    adapter.openRemoteRead = () => {
      order.push('read');
      return Readable.from(Buffer.alloc(10));
    };
    adapter.openRemoteWrite = () => {
      order.push('write');
      return new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    };
    const engine = new TransferEngine(adapter, { concurrency: 1, emit: () => {} });
    const task = engine.enqueue({
      profileId: 'p1', direction: 'remote-copy', sourceSessionId: 'source',
      localPath: '/dest/a.fa', remotePath: '/source/a.fa', temporaryPath: '/dest/.a.fa.part',
      totalBytes: 10, transferredBytes: 0, conflictPolicy: 'overwrite', verificationMode: 'size', retryCount: 0,
    });
    await engine.resume(task.id, 'destination');
    await engine.waitForIdle();

    expect(order.slice(0, 3)).toEqual(['preflight', 'read', 'write']);
    expect(engine.list().find(item => item.id === task.id)?.state).toBe('completed');
  });
});

describe('remote-copy direct rsync (集群直连)', () => {
  it('probes link, runs rsync on source cluster, verifies and renames on dest', async () => {
    const adapter = defaultAdapter();
    adapter.execRemote = async (cmd: string) => {
      if (cmd.includes('echo trace-ok')) return 'trace-ok';
      if (cmd.includes('nohup')) return '12345';
      if (cmd.includes('kill -0')) return ''; // 进程已结束
      return '';
    };
    adapter.getSessionInfo = (sid: string) =>
      sid === 'sess-B' ? { host: 'clusterB', port: 22, username: 'u' } : undefined;
    adapter.remoteSize = async () => 4096;
    let renamed = '';
    adapter.remoteRename = async (from, to, sessionId) => { renamed = `${from}->${to}@${sessionId}`; };

    const engine = new TransferEngine(adapter, { concurrency: 1, emit: () => {} });
    const task = engine.enqueue({
      profileId: 'p1',
      direction: 'remote-copy',
      sourceSessionId: 'sess-A',
      localPath: '/dest/f.bin',
      remotePath: '/src/f.bin',
      temporaryPath: '/dest/.f.bin.trace-t1.part',
      totalBytes: 4096,
      transferredBytes: 0,
      conflictPolicy: 'overwrite',
      verificationMode: 'size',
      retryCount: 0,
    });
    await engine.resume(task.id, 'sess-B');
    await engine.waitForIdle();

    expect(engine.list().find(t => t.id === task.id)?.state).toBe('completed');
    expect(renamed).toBe('/dest/.f.bin.trace-t1.part->/dest/f.bin@sess-B');
  });

  it('does not rename the destination when cancelled during verification', async () => {
    const adapter = defaultAdapter();
    adapter.execRemote = async (cmd: string) => {
      if (cmd.includes('echo trace-ok')) return 'trace-ok';
      if (cmd.includes('nohup')) return '12345';
      if (cmd.includes('kill -0')) return '';
      return '';
    };
    adapter.getSessionInfo = (sid: string) =>
      sid === 'sess-B' ? { host: 'clusterB', port: 22, username: 'u' } : undefined;
    adapter.remoteSize = async () => 4096;
    const rename = vi.fn(async () => {});
    adapter.remoteRename = rename;

    const engine = new TransferEngine(adapter, { concurrency: 1, emit: () => {} });
    const task = engine.enqueue({
      profileId: 'p1', direction: 'remote-copy', sourceSessionId: 'sess-A',
      localPath: '/dest/f.bin', remotePath: '/src/f.bin', temporaryPath: '/dest/.f.bin.trace-t1.part',
      totalBytes: 4096, transferredBytes: 0, conflictPolicy: 'overwrite', verificationMode: 'size', retryCount: 0,
    });
    adapter.verifyRemoteCopy = async () => {
      void engine.cancel(task.id);
      await new Promise(resolve => setTimeout(resolve, 10));
    };

    await engine.resume(task.id, 'sess-B');
    await engine.waitForIdle();

    expect(engine.list().find(t => t.id === task.id)?.state).toBe('cancelled');
    expect(rename).not.toHaveBeenCalled();
  });

  it('falls back to pipe-through-local when direct link unavailable', async () => {
    const io: string[] = [];
    const adapter = defaultAdapter();
    adapter.remoteSize = async () => 4096;
    adapter.openRemoteRead = (_p, _o, sid) => { io.push(`read@${sid}`); return Readable.from(Buffer.alloc(4096)); };
    adapter.openRemoteWrite = (_p, _o, sid) => { io.push(`write@${sid}`); return new Writable({ write(_c, _e, cb) { cb(); } }); };
    adapter.execRemote = async () => { throw new Error('ssh unavailable'); };
    adapter.getSessionInfo = () => ({ host: 'h', port: 22, username: 'u' });

    const engine = new TransferEngine(adapter, { concurrency: 1, emit: () => {} });
    const task = engine.enqueue({
      profileId: 'p1',
      direction: 'remote-copy',
      sourceSessionId: 'sess-A',
      localPath: '/dest/f.bin',
      remotePath: '/src/f.bin',
      temporaryPath: '/dest/.f.bin.trace-t1.part',
      totalBytes: 4096,
      transferredBytes: 0,
      conflictPolicy: 'overwrite',
      verificationMode: 'size',
      retryCount: 0,
    });
    await engine.resume(task.id, 'sess-B');
    await engine.waitForIdle();

    expect(engine.list().find(t => t.id === task.id)?.state).toBe('completed');
    expect(io).toContain('read@sess-A');
    expect(io).toContain('write@sess-B');
  });
});

describe('cancellable stream channels', () => {
  it('uses the AbortSignal pipeline for a fresh upload even when legacy fastPut exists', async () => {
    const adapter = defaultAdapter() as TransferAdapter & { fastPut?: ReturnType<typeof vi.fn> };
    adapter.fastPut = vi.fn(async () => { throw new Error('fastPut must not be called'); });
    adapter.openLocalRead = vi.fn(() => Readable.from(Buffer.alloc(4096)));
    const engine = new TransferEngine(adapter, { concurrency: 1, emit: () => {} });
    const task = enqueueFixture(engine);
    await engine.resume(task.id, 'session-1');
    await engine.waitForIdle();

    expect(adapter.fastPut).not.toHaveBeenCalled();
    expect(adapter.openLocalRead).toHaveBeenCalledWith('D:\\a.bin', 0);
    expect(engine.list()[0].state).toBe('completed');
  });

  it('uses the AbortSignal pipeline for a fresh download even when legacy fastGet exists', async () => {
    const adapter = defaultAdapter() as TransferAdapter & { fastGet?: ReturnType<typeof vi.fn> };
    adapter.fastGet = vi.fn(async () => { throw new Error('fastGet must not be called'); });
    adapter.openRemoteRead = vi.fn(() => Readable.from(Buffer.alloc(4096)));
    const engine = new TransferEngine(adapter, { concurrency: 1, emit: () => {} });
    const task = engine.enqueue({
      profileId: 'p1', direction: 'download', localPath: 'D:\\a.bin', remotePath: '/data/a.bin',
      temporaryPath: 'D:\\.a.bin.trace-t1.part', totalBytes: 4096, transferredBytes: 0,
      conflictPolicy: 'overwrite', verificationMode: 'size', retryCount: 0,
    });
    await engine.resume(task.id, 'session-1');
    await engine.waitForIdle();

    expect(adapter.fastGet).not.toHaveBeenCalled();
    expect(adapter.openRemoteRead).toHaveBeenCalledWith('/data/a.bin', 0, 'session-1');
    expect(engine.list()[0].state).toBe('completed');
  });

  it('reconciles resume from the actual .part size instead of persisted progress', async () => {
    const adapter = defaultAdapter();
    adapter.remoteSize = async () => 1024;
    adapter.openLocalRead = vi.fn((_path, offset) => {
      expect(offset).toBe(1024);
      return Readable.from(Buffer.alloc(3072));
    });
    adapter.openRemoteWrite = vi.fn((_path, offset) => {
      expect(offset).toBe(1024);
      return new Writable({ write(_chunk, _encoding, cb) { cb(); } });
    });

    const engine = new TransferEngine(adapter, { concurrency: 1, emit: () => {} });
    const task = engine.enqueue({
      profileId: 'p1', direction: 'upload', localPath: 'D:\\a.bin', remotePath: '/data/a.bin',
      temporaryPath: '/data/.a.bin.trace-t1.part', totalBytes: 4096, transferredBytes: 2048,
      conflictPolicy: 'resume', verificationMode: 'size', retryCount: 0,
    });
    await engine.resume(task.id, 'session-1');
    await engine.waitForIdle();

    expect(engine.list()[0].state).toBe('completed');
  });
});

describe('transfer speed (bytesPerSecond)', () => {
  it('computes EMA speed on throttled progress emissions and clears it on completion', async () => {
    const events: any[] = [];
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const adapter = defaultAdapter();
      adapter.openLocalRead = () => Readable.from((async function* () {
        yield Buffer.alloc(1000); // 首个样本只建立基准
        now += 250;
        yield Buffer.alloc(2000); // → 8000 B/s
        now += 1000;
        yield Buffer.alloc(1000); // → EMA 3100
      })());
      const engine = new TransferEngine(adapter, {
        concurrency: 1,
        emit: (event: string, data: any) => {
          if (event === 'transfer:updated') events.push({ ...data });
        },
      });
      const task = enqueueFixture(engine);
      await engine.resume(task.id, 'session-1');
      await engine.waitForIdle();
    } finally {
      nowSpy.mockRestore();
    }

    const speeds = events.filter(e => e.bytesPerSecond > 0).map(e => e.bytesPerSecond);
    expect(speeds).toEqual([8000, 3100]);
    const last = events[events.length - 1];
    expect(last.state).toBe('completed');
    expect(last.bytesPerSecond).toBe(0);
  });

  it('resets bytesPerSecond when a running transfer is paused', async () => {
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const adapter = defaultAdapter();
      adapter.openLocalRead = () => Readable.from((async function* () {
        yield Buffer.alloc(1000);
        now += 250;
        yield Buffer.alloc(2000); // → 8000 B/s
        yield Buffer.alloc(1000); // 第三次写阻塞，保持 running
      })());
      let writes = 0;
      adapter.openRemoteWrite = () => new Writable({
        write(_chunk, _encoding, callback) {
          writes++;
          if (writes < 3) callback();
        },
      });
      const engine = new TransferEngine(adapter, { concurrency: 1, emit: () => {} });
      const task = enqueueFixture(engine);
      await engine.resume(task.id, 'session-1');
      await vi.waitFor(() => expect(engine.list()[0].bytesPerSecond).toBe(8000), { timeout: 2000 });

      await engine.pause(task.id);
      expect(engine.list()[0].state).toBe('paused');
      expect(engine.list()[0].bytesPerSecond).toBe(0);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('transfer reliability', () => {
  it('does not delete .part on cancel until the aborted stream has closed', async () => {
    const adapter = defaultAdapter();
    let writeStarted = false;
    let streamClosed = false;
    adapter.openLocalRead = () => Readable.from(Buffer.alloc(4096));
    adapter.openRemoteWrite = () => new Writable({
      write(_chunk, _encoding, _callback) { writeStarted = true; },
      destroy(error, callback) {
        setTimeout(() => {
          streamClosed = true;
          callback(error);
        }, 20);
      },
    });
    adapter.remoteUnlink = vi.fn(async () => {
      expect(streamClosed).toBe(true);
    });
    const engine = new TransferEngine(adapter, { concurrency: 1, emit: () => {} });
    const task = enqueueFixture(engine);
    await engine.resume(task.id, 'session-1');
    await vi.waitFor(() => expect(writeStarted).toBe(true));

    await engine.cancel(task.id);
    expect(adapter.remoteUnlink).toHaveBeenCalledOnce();
    expect((engine as any).activeCount).toBe(0);
    expect((engine as any).running.size).toBe(0);
  });

  it('does not rename an upload when cancelled during the final keepalive wait', async () => {
    const adapter = defaultAdapter();
    adapter.openLocalRead = () => Readable.from(Buffer.alloc(4096));
    const rename = vi.fn(async () => {});
    adapter.remoteRename = rename;

    const engine = new TransferEngine(adapter, { concurrency: 1, emit: () => {} });
    const task = enqueueFixture(engine);
    let keepaliveCalls = 0;
    adapter.ensureSessionAlive = async () => {
      keepaliveCalls++;
      if (keepaliveCalls === 2) {
        void engine.cancel(task.id);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return true;
    };

    await engine.resume(task.id, 'session-1');
    await engine.waitForIdle();

    expect(keepaliveCalls).toBe(2);
    expect(engine.list()[0].state).toBe('cancelled');
    expect(rename).not.toHaveBeenCalled();
  });

  it.each(['upload', 'download'] as const)('rejects a replaced %s source before opening a stream', async direction => {
    const adapter = defaultAdapter();
    const original = { size: 4096, mtime: 1000 };
    const changed = { size: 4096, mtime: 2000 };
    adapter.localFingerprint = vi.fn()
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(changed);
    adapter.remoteFingerprint = vi.fn()
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(changed);
    adapter.openLocalRead = vi.fn(() => Readable.from(Buffer.alloc(4096)));
    adapter.openRemoteRead = vi.fn(() => Readable.from(Buffer.alloc(4096)));
    const engine = new TransferEngine(adapter, { concurrency: 1, emit: () => {} });
    const task = await engine.enqueueWithSourceFingerprint({
      profileId: 'p1', direction, localPath: 'D:\\a.bin', remotePath: '/data/a.bin',
      temporaryPath: direction === 'upload' ? '/data/.a.bin.part' : 'D:\\.a.bin.part',
      totalBytes: 0, transferredBytes: 0, conflictPolicy: 'resume', verificationMode: 'size', retryCount: 0,
    }, 'session-1');

    expect(task.sourceFingerprint).toEqual(original);
    await engine.resume(task.id, 'session-1');
    await engine.waitForIdle();
    expect(engine.list()[0].state).toBe('failed');
    expect(engine.list()[0].error).toContain('Source file changed');
    if (direction === 'upload') expect(adapter.openLocalRead).not.toHaveBeenCalled();
    else expect(adapter.openRemoteRead).not.toHaveBeenCalled();
  });

  it('performs remote-copy sha256 verification through both remote endpoints', async () => {
    const adapter = defaultAdapter();
    adapter.openRemoteRead = () => Readable.from(Buffer.alloc(4096));
    adapter.verifyRemoteCopy = vi.fn(async () => {});
    const engine = new TransferEngine(adapter, { concurrency: 1, emit: () => {} });
    const task = engine.enqueue({
      profileId: 'p1', direction: 'remote-copy', sourceSessionId: 'source',
      localPath: '/dest/a.bin', remotePath: '/source/a.bin', temporaryPath: '/dest/.a.bin.part',
      totalBytes: 4096, transferredBytes: 0, conflictPolicy: 'overwrite', verificationMode: 'sha256', retryCount: 0,
    });
    await engine.resume(task.id, 'destination');
    await engine.waitForIdle();

    expect(adapter.verifyRemoteCopy).toHaveBeenCalledWith(
      '/source/a.bin', '/dest/.a.bin.part', 'sha256',
      { sourceSessionId: 'source', destinationSessionId: 'destination' },
    );
    expect(engine.list()[0].state).toBe('completed');
  });

  it('blocks remote-copy sha256 when verification is unavailable', async () => {
    const adapter = defaultAdapter();
    adapter.remoteRename = vi.fn(async () => {});
    const engine = new TransferEngine(adapter, { concurrency: 1, emit: () => {} });
    const task = engine.enqueue({
      profileId: 'p1', direction: 'remote-copy', sourceSessionId: 'source',
      localPath: '/dest/a.bin', remotePath: '/source/a.bin', temporaryPath: '/dest/.a.bin.part',
      totalBytes: 10, transferredBytes: 0, conflictPolicy: 'overwrite', verificationMode: 'sha256', retryCount: 0,
    });
    await engine.resume(task.id, 'destination');
    await engine.waitForIdle();

    expect(engine.list()[0].state).toBe('failed');
    expect(engine.list()[0].error).toContain('sha256 verification is unavailable');
    expect(adapter.remoteRename).not.toHaveBeenCalled();
  });

  it('reports bandwidth limiting as unsupported instead of acknowledging it', () => {
    const engine = new TransferEngine(defaultAdapter(), { concurrency: 1, emit: () => {} });
    expect(() => engine.setBandwidthLimit(1024)).toThrow('not implemented');
  });
});

describe('setConcurrency', () => {
  it('clamps the value between 1 and 8', () => {
    const engine = new TransferEngine(defaultAdapter(), { concurrency: 4, emit: () => {} });
    engine.setConcurrency(16);
    expect((engine as any).concurrency).toBe(8);
    engine.setConcurrency(0);
    expect((engine as any).concurrency).toBe(1);
    engine.setConcurrency(6);
    expect((engine as any).concurrency).toBe(6);
  });
});
