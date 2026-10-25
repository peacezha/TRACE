import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTransferAdapter, hasActiveTransfersForSession, registerTransferRoutes } from './registerTransferRoutes';
import { loadTasks } from './transferStore';

vi.mock('./transferStore', () => ({
  loadTasks: vi.fn(async () => []),
  saveTasks: vi.fn(async () => {}),
}));

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'trace-transfer-routes-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.mocked(loadTasks).mockResolvedValue([]);
  await Promise.all(tempDirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })));
});

describe('createTransferAdapter', () => {
  it('verifies downloaded temporary files against remote SFTP size', async () => {
    const dir = await makeTempDir();
    const localTemp = path.join(dir, 'filecan.out.part');
    await fs.promises.writeFile(localTemp, Buffer.alloc(1525));

    const sftp = {
      stat: (remotePath: string, callback: (err: Error | null, attrs?: { size: number }) => void) => {
        expect(remotePath).toBe('/public/home/hpzhang/filecan.out');
        callback(null, { size: 1525 });
      },
    };
    const adapter = createTransferAdapter(() => ({
      cluster: { getSftp: () => sftp },
      home: '/public/home/hpzhang',
    } as any));

    await expect(adapter.verify(
      localTemp,
      '/public/home/hpzhang/filecan.out',
      'size',
      { direction: 'download', sessionId: 'ssh-1' },
    )).resolves.toBeUndefined();
  });

  it('replaces an existing remote destination when upload rename cannot overwrite it', async () => {
    const calls: string[] = [];
    let renameAttempts = 0;
    const sftp = {
      stat: (remotePath: string, callback: (err: Error | null, attrs?: { size: number }) => void) => {
        calls.push(`stat:${remotePath}`);
        callback(null, { size: 1513 });
      },
      rename: (from: string, to: string, callback: (err?: Error) => void) => {
        calls.push(`rename:${from}->${to}`);
        renameAttempts += 1;
        callback(renameAttempts === 1 ? new Error('Failure') : undefined);
      },
      unlink: (remotePath: string, callback: (err?: Error) => void) => {
        calls.push(`unlink:${remotePath}`);
        callback();
      },
    };
    const adapter = createTransferAdapter(() => ({
      cluster: { getSftp: () => sftp },
      home: '/public/home/hpzhang',
    } as any));

    await expect(adapter.remoteRename(
      '/public/home/hpzhang/.minimap.err.trace-test.part',
      '/public/home/hpzhang/minimap.err',
      'ssh-1',
    )).resolves.toBeUndefined();

    expect(calls).toEqual([
      'rename:/public/home/hpzhang/.minimap.err.trace-test.part->/public/home/hpzhang/minimap.err',
      'stat:/public/home/hpzhang/minimap.err',
      'unlink:/public/home/hpzhang/minimap.err',
      'rename:/public/home/hpzhang/.minimap.err.trace-test.part->/public/home/hpzhang/minimap.err',
    ]);
  });

  it('hashes both remote-copy endpoints with SHA256 and rejects different content', async () => {
    const reads: string[] = [];
    const adapter = createTransferAdapter((sessionId) => ({
      cluster: {
        getSftp: () => ({
          createReadStream: (remotePath: string) => {
            reads.push(`${remotePath}@${sessionId}`);
            return Readable.from(sessionId === 'source' ? 'same-content' : 'same-content');
          },
        }),
      },
      home: '/home/user',
    } as any));

    await expect(adapter.verifyRemoteCopy!('/src/a.bin', '/dest/.a.bin.part', 'sha256', {
      sourceSessionId: 'source', destinationSessionId: 'destination',
    })).resolves.toBeUndefined();
    expect(reads).toEqual(['/src/a.bin@source', '/dest/.a.bin.part@destination']);

    const mismatch = createTransferAdapter((sessionId) => ({
      cluster: {
        getSftp: () => ({
          createReadStream: () => Readable.from(sessionId === 'source' ? 'old' : 'new'),
        }),
      },
      home: '/home/user',
    } as any));
    await expect(mismatch.verifyRemoteCopy!('/src/a.bin', '/dest/.a.bin.part', 'sha256', {
      sourceSessionId: 'source', destinationSessionId: 'destination',
    })).rejects.toThrow('checksum mismatch');
  });

  it('preflights both clusters and repairs only current-user source/parent permissions', async () => {
    const sourceExec = vi.fn(async () => '');
    const destinationExec = vi.fn(async () => '');
    const adapter = createTransferAdapter((sessionId) => ({
      cluster: {
        exec: sessionId === 'source' ? sourceExec : destinationExec,
        getSftp: () => ({}),
      },
      home: sessionId === 'source' ? '/home/alice' : '/home/bob',
    } as any));

    await adapter.prepareRemoteCopy!({
      sourcePath: '/private/alice/project/a.fa',
      destinationPath: '/scratch/bob/results/.a.fa.trace.part',
      sourceSessionId: 'source',
      destinationSessionId: 'destination',
    });

    expect(sourceExec).toHaveBeenCalledOnce();
    expect(destinationExec).toHaveBeenCalledOnce();
    const sourceCommand = String(sourceExec.mock.calls[0][0]);
    const destinationCommand = String(destinationExec.mock.calls[0][0]);
    expect(sourceCommand).toContain('chmod u+r "$f"');
    expect(sourceCommand).toContain('chmod u+x "$p"');
    expect(destinationCommand).toContain('chmod u+rwx "$p"');
    expect(destinationCommand).toContain('/scratch/bob/results');
    expect(`${sourceCommand}\n${destinationCommand}`).not.toMatch(/chmod\s+(?:777|a\+|o\+)/);
  });
});

describe('registerTransferRoutes', () => {
  it('ends preflight with 401 when the destination session is stale', async () => {
    let preflight: ((req: any, res: any) => Promise<void>) | undefined;
    const app = {
      get: vi.fn(),
      post: vi.fn((route: string, handler: (req: any, res: any) => Promise<void>) => {
        if (route === '/api/transfers/preflight-remote-copy') preflight = handler;
      }),
      put: vi.fn(),
      delete: vi.fn(),
    };
    const io = { emit: vi.fn() };
    await registerTransferRoutes(app as any, io as any, () => undefined);

    const response = {
      status: vi.fn(),
      json: vi.fn(),
    } as any;
    response.status.mockReturnValue(response);
    await preflight!({ session: {}, get: vi.fn(() => 'stale-session') }, response);

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'SSH_SESSION_REQUIRED' }),
    }));
  });
});

describe('registerTransferRoutes restart rebind', () => {
  it('rebinds a session-less restored task only through an explicit resume', async () => {
    const localPath = fileURLToPath(import.meta.url);
    const stat = await fs.promises.stat(localPath);
    vi.mocked(loadTasks).mockResolvedValueOnce([{
      id: 'restored-task', profileId: 'profile-a', direction: 'upload', localPath,
      remotePath: '/data/a.bin', temporaryPath: '/data/.a.bin.trace-restored.part',
      sourceFingerprint: { size: stat.size, mtime: stat.mtimeMs }, totalBytes: stat.size,
      transferredBytes: 0, bytesPerSecond: 0, state: 'paused', conflictPolicy: 'overwrite',
      verificationMode: 'size', retryCount: 0, createdAt: 1, updatedAt: 1,
    }]);
    const session = {
      cluster: {
        getSftp: () => ({
          stat: (_path: string, callback: (error: Error | null, attrs?: unknown) => void) =>
            callback(null, { size: stat.size, mtime: stat.mtimeMs / 1000 }),
          createWriteStream: () => new Writable({ write(_c, _e, callback) { callback(); } }),
          rename: (_from: string, _to: string, callback: (error?: Error) => void) => callback(),
        }),
        exec: async () => '',
      },
      home: '/home/alice',
    };
    const handlers = new Map<string, (req: any, res: any) => unknown>();
    const app = {
      get: vi.fn(),
      post: vi.fn((route: string, handler: (req: any, res: any) => unknown) => { handlers.set(route, handler); }),
      put: vi.fn(), delete: vi.fn(),
    };
    const io = { emit: vi.fn() };
    await registerTransferRoutes(app as any, io as any, (id) => (id === 'ssh-new' ? session : undefined) as any);
    const resume = handlers.get('/api/transfers/:id/resume')!;
    const request = (profileId: string) => ({
      session: {}, body: { profileId }, params: { id: 'restored-task' },
      get: (name: string) => (name === 'X-SSH-Session-Id' ? 'ssh-new' : undefined),
    });
    const response = () => {
      const res: any = { status: vi.fn(), json: vi.fn() };
      res.status.mockReturnValue(res);
      return res;
    };

    const wrongProfile = response();
    await resume(request('profile-b'), wrongProfile);
    expect(wrongProfile.status).toHaveBeenCalledWith(403);

    const rebound = response();
    await resume(request('profile-a'), rebound);
    expect(rebound.json).toHaveBeenCalledWith({ ok: true });
    expect(io.emit).toHaveBeenCalledWith('transfer:updated', expect.objectContaining({
      id: 'restored-task', sessionId: 'ssh-new',
    }));
  });
});

describe('registerTransferRoutes batch enqueue', () => {
  // SFTP 桩：传输启动后会在后台失败，路由响应在此之前已发出，互不影响
  const session = {
    cluster: {
      getSftp: () => ({
        stat: (_path: string, cb: (err?: Error) => void) => cb(new Error('no sftp in test')),
        fastPut: (_l: string, _r: string, _o: unknown, cb: (err?: Error) => void) => cb(new Error('no sftp in test')),
        fastGet: (_r: string, _l: string, _o: unknown, cb: (err?: Error) => void) => cb(new Error('no sftp in test')),
      }),
      exec: async () => '',
    },
    home: '/home/alice',
  };

  const validItem = {
    profileId: 'p1',
    direction: 'upload',
    localPath: fileURLToPath(import.meta.url),
    remotePath: '/data/a.bin',
    temporaryPath: '/data/.a.bin.trace-t1.part',
    totalBytes: 4096,
    transferredBytes: 0,
    conflictPolicy: 'overwrite',
    verificationMode: 'size',
  };

  async function setup() {
    const handlers = new Map<string, (req: any, res: any) => unknown>();
    const app = {
      get: vi.fn(),
      post: vi.fn((route: string, handler: (req: any, res: any) => unknown) => { handlers.set(route, handler); }),
      put: vi.fn((route: string, handler: (req: any, res: any) => unknown) => { handlers.set(route, handler); }),
      delete: vi.fn(),
    };
    const io = { emit: vi.fn() };
    await registerTransferRoutes(
      app as any,
      io as any,
      ((id: string) => (id === 'ssh-1' ? session : undefined)) as any,
    );
    return {
      batch: handlers.get('/api/transfers/batch')!,
      settings: handlers.get('/api/transfers/settings')!,
      io,
    };
  }

  function makeReq(body: unknown, sessionId = 'ssh-1'): any {
    return {
      session: {},
      get: (name: string) => (name === 'X-SSH-Session-Id' ? sessionId : undefined),
      body,
    };
  }

  function makeRes(): any {
    const res: any = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    return res;
  }

  it('rejects batch enqueue without an SSH session (401)', async () => {
    const { batch } = await setup();
    const res = makeRes();
    await batch(makeReq([validItem], 'stale-session'), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects a non-array or empty batch (400)', async () => {
    const { batch } = await setup();
    for (const body of [[], { transfers: [] }, { nope: true }]) {
      const res = makeRes();
      await batch(makeReq(body), res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
  });

  it('rejects batches over 500 items (400)', async () => {
    const { batch } = await setup();
    const res = makeRes();
    await batch(makeReq(Array(501).fill(validItem)), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ message: expect.stringContaining('500') }),
    }));
  });

  it('rejects the whole batch with the offending index when one item is invalid', async () => {
    const { batch } = await setup();
    const res = makeRes();
    await batch(makeReq([validItem, { ...validItem, localPath: '' }]), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ message: expect.stringContaining('transfers[1]') }),
    }));
  });

  it('enqueues every item and returns all tasks (201)', async () => {
    const { batch, io } = await setup();
    const res = makeRes();
    const second = {
      ...validItem,
      remotePath: '/data/b.bin',
      temporaryPath: '/data/.b.bin.trace-t2.part',
    };
    await batch(makeReq([validItem, second]), res);

    expect(res.status).toHaveBeenCalledWith(201);
    const payload = res.json.mock.calls[0][0];
    expect(payload.transfers).toHaveLength(2);
    expect(payload.transfers[0].id).toBeTruthy();
    expect(payload.transfers[0].sessionId).toBe('ssh-1');
    expect(payload.transfers[0].sourceFingerprint.size).toBeGreaterThan(0);
    expect(payload.transfers[0].sourceFingerprint.mtime).toBeGreaterThan(0);
    expect(payload.transfers[1].remotePath).toBe('/data/b.bin');
    expect(io.emit).toHaveBeenCalledWith(
      'transfer:summary',
      expect.objectContaining({ total: expect.any(Number) }),
    );
  });

  it('accepts concurrency up to 8 and rejects higher values', async () => {
    const { settings } = await setup();
    const okRes = makeRes();
    await settings(makeReq({ concurrency: 8 }), okRes);
    expect(okRes.json).toHaveBeenCalledWith({ ok: true });

    const badRes = makeRes();
    await settings(makeReq({ concurrency: 9 }), badRes);
    expect(badRes.status).toHaveBeenCalledWith(400);
  });

  it('rejects bandwidthLimit because throttling is not implemented', async () => {
    const { settings } = await setup();
    const res = makeRes();
    await settings(makeReq({ bandwidthLimit: 1024 * 1024 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ message: expect.stringContaining('not implemented') }),
    }));
  });
});

describe('createTransferAdapter stream buffers', () => {
  it('passes a 512KB highWaterMark to SFTP read/write streams（续传单流提速）', () => {
    const writeOptions: unknown[] = [];
    const readOptions: unknown[] = [];
    const sftp = {
      createWriteStream: (_path: string, options: unknown) => {
        writeOptions.push(options);
        return new Writable({ write(_chunk, _encoding, cb) { cb(); } });
      },
      createReadStream: (_path: string, options: unknown) => {
        readOptions.push(options);
        return Readable.from(Buffer.alloc(0));
      },
    };
    const adapter = createTransferAdapter(() => ({
      cluster: { getSftp: () => sftp },
      home: '/home/alice',
    } as any));

    adapter.openRemoteWrite('/data/.a.bin.part', 1024, 'ssh-1');
    adapter.openRemoteRead('/data/a.bin', 2048, 'ssh-1');

    expect(writeOptions[0]).toEqual({ flags: 'r+', start: 1024, highWaterMark: 512 * 1024 });
    expect(readOptions[0]).toEqual({ start: 2048, highWaterMark: 512 * 1024 });
  });

  it('uses 512KB buffers for local read/write streams too', async () => {
    const dir = await makeTempDir();
    const localPath = path.join(dir, 'a.bin');
    await fs.promises.writeFile(localPath, 'content');
    const adapter = createTransferAdapter(() => undefined);
    const reader = adapter.openLocalRead(localPath, 0);
    const partPath = path.join(dir, '.a.bin.part');
    await fs.promises.writeFile(partPath, 'partial');
    const writer = adapter.openLocalWrite(partPath, 0);
    const resumeWriter = adapter.openLocalWrite(partPath, 7);

    expect(reader.readableHighWaterMark).toBe(512 * 1024);
    expect(writer.writableHighWaterMark).toBe(512 * 1024);
    expect(resumeWriter.flags).toBe('r+');
    reader.destroy();
    writer.destroy();
    resumeWriter.destroy();
  });

  it('exposes the injected ensureSessionAlive hook on the adapter', () => {
    const ensure = vi.fn(async () => true);
    const adapter = createTransferAdapter(() => undefined, ensure);
    expect(adapter.ensureSessionAlive).toBe(ensure);
  });
});

describe('hasActiveTransfersForSession', () => {
  it('reports sessions with in-flight transfers so the eviction loop can skip them', async () => {
    // 写入回调永不完成：pipeline 稳定停在 running
    const hangingSession = {
      cluster: {
        getSftp: () => ({
          stat: (_path: string, cb: (err?: Error) => void) => cb(new Error('no sftp in test')),
          createWriteStream: () => new Writable({ write() {} }),
        }),
        exec: async () => '',
      },
      home: '/home/alice',
    };
    const handlers = new Map<string, (req: any, res: any) => unknown>();
    const app = {
      get: vi.fn(),
      post: vi.fn((route: string, handler: (req: any, res: any) => unknown) => { handlers.set(route, handler); }),
      put: vi.fn(),
      delete: vi.fn(),
    };
    const io = { emit: vi.fn() };
    await registerTransferRoutes(
      app as any,
      io as any,
      ((id: string) => (id === 'ssh-hang' ? hangingSession : undefined)) as any,
    );

    expect(hasActiveTransfersForSession('ssh-hang')).toBe(false);

    const create = handlers.get('/api/transfers')!;
    const res: any = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    await create({
      session: {},
      get: (name: string) => (name === 'X-SSH-Session-Id' ? 'ssh-hang' : undefined),
      body: {
        profileId: 'p1',
        direction: 'upload',
        localPath: fileURLToPath(import.meta.url),
        remotePath: '/data/a.bin',
        temporaryPath: '/data/.a.bin.trace-hang.part',
        totalBytes: 4096,
        transferredBytes: 0,
        conflictPolicy: 'overwrite',
        verificationMode: 'size',
      },
    }, res);

    expect(res.status).toHaveBeenCalledWith(201);
    // 路由内部 await engine.resume → 此时任务已是 running
    expect(hasActiveTransfersForSession('ssh-hang')).toBe(true);
    expect(hasActiveTransfersForSession('ssh-other')).toBe(false);
  });
});
