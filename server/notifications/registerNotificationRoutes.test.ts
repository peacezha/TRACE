// GET /api/jobs/summary/all：多集群并发聚合（LSF + Slurm 各自选命令与解析）、
// 单集群失败/超时降级为条目 error、跳过本地工作台哨兵与未连接会话；
// 另验证 /api/jobs/summary 重构后仍走同一采集逻辑（会话调度器标签优先）。
// 测试方式对齐 registerClusterConversationRoutes.test.ts：真实 express 监听临时端口 + fetch。
import http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerNotificationRoutes,
  type ListedClusterSession,
} from './registerNotificationRoutes';

const notifyMocks = vi.hoisted(() => ({
  config: {
    enabled: true,
    channel: 'email',
    sendKey: 'send-secret',
    token: 'token-secret',
    webhook: 'https://example.org/secret',
    smtpPass: 'smtp-secret',
  },
  save: vi.fn(async () => {}),
}));

vi.mock('./notifyService', () => ({
  loadNotifyConfig: async () => ({ ...notifyMocks.config }),
  saveNotifyConfig: notifyMocks.save,
  sendNotification: vi.fn(),
}));

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

// 非定宽补齐的 bjobs 输出：触发解析器的空白切分回退路径
const BJOBS_OUTPUT = [
  'JOBID USER STAT QUEUE FROM_HOST EXEC_HOST JOB_NAME SUBMIT_TIME',
  '101 tester RUN normal login01 node01 blastx Oct15',
  '102 tester PEND normal login01 - prep Oct15',
  '103 tester DONE normal login01 node02 oldjob Oct14',
].join('\n');

// squeue -o "%i|%j|%T|%P|%M" --noheader
const SQUEUE_OUTPUT = [
  '201|sim|RUNNING|gpu|12:01',
  '202|qc|PENDING|gpu|0:00',
].join('\n');

interface FakeSessionOptions {
  sessionId: string;
  exec: (cmd: string, timeout?: number) => Promise<string>;
  scheduler?: ListedClusterSession['cluster']['scheduler'];
  host?: string;
  username?: string;
  state?: string;
}

function makeSession(options: FakeSessionOptions): ListedClusterSession {
  return {
    sessionId: options.sessionId,
    host: options.host ?? 'hpc.example.edu',
    username: options.username ?? 'tester',
    state: options.state ?? 'connected',
    cluster: { exec: options.exec, scheduler: options.scheduler },
  };
}

async function startRoutes(listSessions: () => ListedClusterSession[]) {
  const app = express();
  app.use(express.json());
  registerNotificationRoutes(app, () => undefined, listSessions);
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

async function fetchSummaryAll(baseUrl: string) {
  const res = await fetch(`${baseUrl}/api/jobs/summary/all`);
  return { status: res.status, body: await res.json() };
}

describe('GET /api/jobs/summary/all', () => {
  it('多集群并发聚合：LSF 用 bjobs、Slurm 用 squeue，各自统计 running/pending', async () => {
    const commands = new Map<string, string>();
    const baseUrl = await startRoutes(() => [
      makeSession({
        sessionId: 'sess-lsf',
        scheduler: 'lsf',
        host: 'lsf.example.edu',
        exec: async (cmd) => { commands.set('sess-lsf', cmd); return BJOBS_OUTPUT; },
      }),
      makeSession({
        sessionId: 'sess-slurm',
        scheduler: 'slurm',
        host: 'slurm.example.edu',
        username: 'alice',
        exec: async (cmd) => { commands.set('sess-slurm', cmd); return SQUEUE_OUTPUT; },
      }),
    ]);

    const { status, body } = await fetchSummaryAll(baseUrl);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.clusters).toHaveLength(2);

    const lsf = body.clusters.find((c: any) => c.sessionId === 'sess-lsf');
    expect(commands.get('sess-lsf')).toContain('bjobs');
    expect(lsf).toMatchObject({ host: 'lsf.example.edu', username: 'tester', scheduler: 'lsf', running: 1, pending: 1 });
    expect(lsf.jobs).toHaveLength(3);
    expect(lsf.error).toBeUndefined();
    expect(typeof lsf.updatedAt).toBe('number');

    const slurm = body.clusters.find((c: any) => c.sessionId === 'sess-slurm');
    expect(commands.get('sess-slurm')).toContain('squeue');
    expect(slurm).toMatchObject({ host: 'slurm.example.edu', username: 'alice', scheduler: 'slurm', running: 1, pending: 1 });
    expect(slurm.jobs).toHaveLength(2);
  });

  it('单集群 exec 失败降级为该条目 error，其他集群不受影响', async () => {
    const baseUrl = await startRoutes(() => [
      makeSession({
        sessionId: 'sess-dead',
        scheduler: 'slurm',
        exec: async () => { throw new Error('SSH is not connected'); },
      }),
      makeSession({
        sessionId: 'sess-ok',
        scheduler: 'lsf',
        exec: async () => BJOBS_OUTPUT,
      }),
    ]);

    const { status, body } = await fetchSummaryAll(baseUrl);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.clusters).toHaveLength(2);

    const dead = body.clusters.find((c: any) => c.sessionId === 'sess-dead');
    expect(dead.error).toContain('SSH is not connected');
    expect(dead).toMatchObject({ running: 0, pending: 0, jobs: [], scheduler: 'slurm' });

    const ok = body.clusters.find((c: any) => c.sessionId === 'sess-ok');
    expect(ok.error).toBeUndefined();
    expect(ok.running).toBe(1);
  });

  it('跳过本地工作台哨兵与未连接会话（不对其执行任何命令）', async () => {
    const forbiddenExec = async () => { throw new Error('不应被调用'); };
    const baseUrl = await startRoutes(() => [
      makeSession({ sessionId: 'local-workbench', state: 'connected', exec: forbiddenExec }),
      makeSession({ sessionId: 'sess-connecting', state: 'connecting', exec: forbiddenExec }),
      makeSession({ sessionId: 'sess-ok', scheduler: 'slurm', exec: async () => SQUEUE_OUTPUT }),
    ]);

    const { status, body } = await fetchSummaryAll(baseUrl);
    expect(status).toBe(200);
    expect(body.clusters).toHaveLength(1);
    expect(body.clusters[0].sessionId).toBe('sess-ok');
  });

  it('无会话注入时返回空列表而不是报错', async () => {
    const app = express();
    app.use(express.json());
    registerNotificationRoutes(app, () => undefined);
    const server = http.createServer(app);
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');

    const res = await fetch(`http://127.0.0.1:${address.port}/api/jobs/summary/all`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, clusters: [] });
  });
});

describe('GET /api/jobs/summary（重构后共用采集逻辑）', () => {
  it('按 X-SSH-Session-Id 选会话，用会话调度器标签解析', async () => {
    const session = makeSession({
      sessionId: 'sess-slurm',
      scheduler: 'slurm',
      exec: async () => SQUEUE_OUTPUT,
    });
    const app = express();
    app.use(express.json());
    registerNotificationRoutes(
      app,
      sessionId => (sessionId === 'sess-slurm' ? { cluster: session.cluster } : undefined),
      () => [],
    );
    const server = http.createServer(app);
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');

    const res = await fetch(`http://127.0.0.1:${address.port}/api/jobs/summary`, {
      headers: { 'X-SSH-Session-Id': 'sess-slurm' },
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.scheduler).toBe('slurm');
    expect(body.jobs).toHaveLength(2);
    expect(body.jobs[0]).toMatchObject({ jobId: '201', status: 'RUN' });
    expect(typeof body.updatedAt).toBe('number');
  });
});

describe('notification config secret masking', () => {
  it('masks every secret and preserves masked values on save', async () => {
    const baseUrl = await startRoutes(() => []);
    const getRes = await fetch(`${baseUrl}/api/notify/config`);
    const getBody = await getRes.json();
    expect(getRes.status).toBe(200);
    expect(getBody.config).toMatchObject({
      sendKey: '******', token: '******', webhook: '******', smtpPass: '******',
    });
    expect(JSON.stringify(getBody)).not.toContain('secret');

    notifyMocks.save.mockClear();
    const putRes = await fetch(`${baseUrl}/api/notify/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        channel: 'email',
        sendKey: '******',
        token: '******',
        webhook: '******',
        smtpPass: '******',
      }),
    });
    expect(putRes.status).toBe(200);
    expect(notifyMocks.save).toHaveBeenCalledWith(expect.objectContaining(notifyMocks.config));
  });
});
