import express, { type Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobSubmissionGuard } from '../ai/jobSubmissionGuard';
import {
  registerBridgeRoutes,
  setJobPollIntervalMs,
  waitForLsfJob,
  type BridgeClusterSession,
  type BridgeRouteDeps,
} from './bridgeRoutes';

const TOKEN = 'test-bridge-token';
const DSH_SESSION = 'dsh-1';

function makeSession(overrides: { exec?: (cmd: string, to?: number) => Promise<string>; state?: string; host?: string } = {}): BridgeClusterSession {
  return {
    cluster: {
      exec: overrides.exec || (async () => 'ok\n'),
      state: overrides.state ?? 'connected',
    },
    info: overrides.host === undefined ? { host: 'hpc.test' } : { host: overrides.host },
  };
}

function makeDeps(overrides: Partial<BridgeRouteDeps> = {}): BridgeRouteDeps {
  return {
    getSession: () => undefined,
    getDshSessionBinding: () => ({
      dshSessionId: DSH_SESSION,
      sshSessionId: 'ssh-1',
      workspaceRoot: process.cwd(),
      conversationKey: 'ssh-1:chat',
      confirmationPolicy: 'dangerous',
      updatedAt: Date.now(),
    }),
    getBridgeToken: () => TOKEN,
    ...overrides,
  };
}

const servers: Server[] = [];
const ledgerRoots: string[] = [];

function makeGuard(): JobSubmissionGuard {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-submit-guard-'));
  ledgerRoots.push(root);
  return new JobSubmissionGuard(root);
}

async function startApp(deps: BridgeRouteDeps): Promise<string> {
  const app: Express = express();
  app.use(express.json());
  registerBridgeRoutes(app, deps);
  const server = await new Promise<Server>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const root of ledgerRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function post(base: string, urlPath: string, body: unknown, token?: string, dshSession = DSH_SESSION): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${urlPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-TRACE-Bridge': token } : {}),
      ...(dshSession ? { 'X-TRACE-Dsh-Session': dshSession } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

describe('bridgeRoutes', () => {
  it('enforces explanation-only mode even when a command is marked confirmed', async () => {
    const exec = vi.fn(async () => 'read-only log');
    const binding = makeDeps().getDshSessionBinding(DSH_SESSION)!;
    const base = await startApp(makeDeps({ getSession: () => makeSession({ exec }), getDshSessionBinding: () => ({ ...binding, readOnly: true }) }));
    for (const command of ['bsub < job.sh', 'bkill 75741556', 'echo changed > /home/u/config']) {
      expect((await post(base, '/api/bridge/exec', { command, confirmed: true }, TOKEN)).body.error).toBe('clarification_read_only');
    }
    expect(exec).not.toHaveBeenCalled();
    expect((await post(base, '/api/bridge/exec', { command: 'bjobs -l 75741556' }, TOKEN)).body.ok).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it('rejects requests without the bridge token with 403', async () => {
    const base = await startApp(makeDeps());
    const missing = await post(base, '/api/bridge/exec', { command: 'ls' });
    expect(missing.status).toBe(403);
    expect(missing.body).toEqual({ error: 'forbidden' });

    const wrong = await post(base, '/api/bridge/exec', { command: 'ls' }, 'wrong-token');
    expect(wrong.status).toBe(403);

    const status = await fetch(`${base}/api/bridge/status`);
    expect(status.status).toBe(403);
  });

  it('rejects a non-string or empty command with 400', async () => {
    const base = await startApp(makeDeps());
    expect((await post(base, '/api/bridge/exec', {}, TOKEN)).status).toBe(400);
    const blank = await post(base, '/api/bridge/exec', { command: '   ' }, TOKEN);
    expect(blank.status).toBe(400);
    expect(blank.body).toEqual({ error: 'invalid_request' });
  });

  it('rejects an unbound dsh session instead of falling back to another cluster', async () => {
    const base = await startApp(makeDeps({ getDshSessionBinding: () => undefined }));
    const res = await post(base, '/api/bridge/exec', { command: 'hostname' }, TOKEN, 'unknown-dsh');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'dsh_session_not_bound' });
  });

  it('allows an rm command only after destructive confirmation', async () => {
    const exec = vi.fn(async () => 'ok\n');
    const base = await startApp(makeDeps({ getSession: () => makeSession({ exec }) }));
    const pending = await post(base, '/api/bridge/exec', { command: 'rm -rf /tmp/x' }, TOKEN);
    expect(pending.status).toBe(428);
    expect(pending.body).toEqual({ error: 'confirmation_required', risk: 'destructive' });
    const confirmed = await post(base, '/api/bridge/exec', { command: 'rm -rf /tmp/x', confirmed: true }, TOKEN);
    expect(confirmed.status).toBe(200);
    expect(exec).toHaveBeenCalledWith('rm -rf /tmp/x', 30_000);
  });

  it('requires confirmation for destructive commands but runs ordinary network commands directly', async () => {
    const exec = vi.fn(async () => 'ok\n');
    const base = await startApp(makeDeps({ getSession: () => makeSession({ exec }) }));

    const destructive = await post(base, '/api/bridge/exec', { command: 'bkill 123' }, TOKEN);
    expect(destructive.status).toBe(428);
    expect(destructive.body).toEqual({ error: 'confirmation_required', risk: 'destructive' });

    const network = await post(base, '/api/bridge/exec', { command: 'curl -O https://example.com/a.sh' }, TOKEN);
    expect(network.status).toBe(200);

    expect(exec).toHaveBeenCalledWith('curl -O https://example.com/a.sh', 30_000);

    const confirmed = await post(base, '/api/bridge/exec', { command: 'bkill 123', confirmed: true }, TOKEN);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.ok).toBe(true);
    expect(exec).toHaveBeenCalledWith('bkill 123', 30_000);
  });

  it('honors state_changes and every_command policies from the bound dsh session', async () => {
    const exec = vi.fn(async () => 'ok\n');
    const binding = (confirmationPolicy: 'state_changes' | 'every_command') => ({
      dshSessionId: DSH_SESSION, sshSessionId: 'ssh-1', workspaceRoot: process.cwd(),
      conversationKey: 'ssh-1:chat', confirmationPolicy, updatedAt: Date.now(),
    });
    const stateChanges = await startApp(makeDeps({
      getSession: () => makeSession({ exec }),
      getDshSessionBinding: () => binding('state_changes'),
    }));
    expect((await post(stateChanges, '/api/bridge/exec', { command: 'echo x > out.txt' }, TOKEN)).status).toBe(428);
    expect((await post(stateChanges, '/api/bridge/exec', { command: 'pwd' }, TOKEN)).status).toBe(200);

    const every = await startApp(makeDeps({
      getSession: () => makeSession({ exec }),
      getDshSessionBinding: () => binding('every_command'),
    }));
    expect((await post(every, '/api/bridge/exec', { command: 'pwd' }, TOKEN)).status).toBe(428);
  });

  it('runs task-level cleanup without confirmation in never mode but blocks machine destruction', async () => {
    const exec = vi.fn(async () => 'ok\n');
    const base = await startApp(makeDeps({
      getSession: () => makeSession({ exec }),
      getDshSessionBinding: () => ({
        dshSessionId: DSH_SESSION, sshSessionId: 'ssh-1', workspaceRoot: process.cwd(),
        conversationKey: 'ssh-1:chat', confirmationPolicy: 'never', updatedAt: Date.now(),
      }),
    }));

    const cleanup = await post(base, '/api/bridge/exec', { command: 'rm -rf /tmp/trace-old-output' }, TOKEN);
    expect(cleanup.status).toBe(200);
    expect(exec).toHaveBeenCalledWith('rm -rf /tmp/trace-old-output', 30_000);
    for (const command of ['bkill 123', 'scancel 123', 'qdel 123']) {
      expect((await post(base, '/api/bridge/exec', { command }, TOKEN)).status).toBe(428);
      expect(exec).not.toHaveBeenCalledWith(command, 30_000);
    }

    const catastrophic = await post(base, '/api/bridge/exec', { command: 'mkfs.ext4 /dev/sdb' }, TOKEN);
    expect(catastrophic.status).toBe(422);
    expect(catastrophic.body).toEqual({ error: 'catastrophic_command_blocked' });
    expect(exec).not.toHaveBeenCalledWith('mkfs.ext4 /dev/sdb', 30_000);
  });

  it('returns 409 when there is no connected cluster session', async () => {
    const noSession = await startApp(makeDeps({ getSession: () => undefined }));
    expect((await post(noSession, '/api/bridge/exec', { command: 'ls -la' }, TOKEN)).status).toBe(409);

    const disconnected = await startApp(makeDeps({ getSession: () => makeSession({ state: 'disconnected' }) }));
    const res = await post(disconnected, '/api/bridge/exec', { command: 'ls -la' }, TOKEN);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'no_cluster_session' });
  });

  it('executes the command on the SSH session bound to this dsh session and truncates long output', async () => {
    const exec = vi.fn(async () => 'line\n'.repeat(5000));
    const getSession = vi.fn(() => makeSession({ exec }));
    const getDshSessionBinding = vi.fn(() => ({
      dshSessionId: DSH_SESSION, sshSessionId: 'ssh-9', workspaceRoot: process.cwd(),
      conversationKey: 'ssh-9:chat', confirmationPolicy: 'dangerous' as const, updatedAt: Date.now(),
    }));
    const base = await startApp(makeDeps({ getSession, getDshSessionBinding }));

    const res = await post(base, '/api/bridge/exec', { command: 'ls -la', timeoutMs: 5_000 }, TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.exitCode).toBe(0);
    expect(res.body.output).toContain('[trunc');
    expect(getDshSessionBinding).toHaveBeenCalledWith(DSH_SESSION);
    expect(getSession).toHaveBeenCalledWith('ssh-9');
    expect(exec).toHaveBeenCalledWith('ls -la', 5_000);
  });

  it('returns ok:false with the error message when exec rejects', async () => {
    const exec = vi.fn(async () => {
      throw new Error('Command timed out after 1000 ms');
    });
    const base = await startApp(makeDeps({ getSession: () => makeSession({ exec }) }));

    const res = await post(base, '/api/bridge/exec', { command: 'sleep 60', timeoutMs: 1_000 }, TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.output).toBe('');
    expect(res.body.error).toContain('Command timed out');
  });

  it('reports SSH connectivity on the status endpoint', async () => {
    const connected = await startApp(makeDeps({ getSession: () => makeSession() }));
    const okRes = await fetch(`${connected}/api/bridge/status`, { headers: { 'X-TRACE-Bridge': TOKEN, 'X-TRACE-Dsh-Session': DSH_SESSION } });
    expect(await okRes.json()).toEqual({ ok: true, sshConnected: true, host: 'hpc.test' });

    const none = await startApp(makeDeps());
    const noRes = await fetch(`${none}/api/bridge/status`, { headers: { 'X-TRACE-Bridge': TOKEN, 'X-TRACE-Dsh-Session': DSH_SESSION } });
    expect(await noRes.json()).toEqual({ ok: true, sshConnected: false });
  });
});


describe('bridgeRoutes exec waitForJobs', () => {
  afterEach(() => {
    setJobPollIntervalMs(15_000);
  });

  it('returns a receipt immediately even when the model requests a 30-minute inline wait', async () => {
    const exec = vi.fn(async () => 'Job <424242> is submitted to queue <normal>.\n');
    const onJobsSubmitted = vi.fn();
    const base = await startApp(makeDeps({ getSession: () => makeSession({ exec }), onJobsSubmitted }));
    const res = await post(base, '/api/bridge/exec', { command: 'bsub sleep 300', waitForJobs: 30 }, TOKEN);
    expect(res.status).toBe(200); expect(res.body.ok).toBe(true);
    expect(res.body.output).toContain('TRACE_BACKGROUND_JOB');
    expect(res.body.output).toContain('Submitted does not mean completed');
    expect(res.body.waitedJobs).toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(onJobsSubmitted).toHaveBeenCalledWith(expect.objectContaining({ sshSessionId: 'ssh-1' }), ['424242']);
  });

  it('does not poll another scheduler after a submission receipt', async () => {
    const exec = vi.fn(async () => 'Submitted batch job 777\n');
    const base = await startApp(makeDeps({ getSession: () => makeSession({ exec }) }));

    const res = await post(base, '/api/bridge/exec', { command: 'bsub < job.sh', waitForJobs: 1 }, TOKEN);

    expect(res.body.output).toContain('777');
    expect(res.body.waitedJobs).toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('does not wait when no job id appears in the output', async () => {
    const exec = vi.fn(async () => 'no jobs here\n');
    const base = await startApp(makeDeps({ getSession: () => makeSession({ exec }) }));

    const res = await post(base, '/api/bridge/exec', { command: 'ls -la', waitForJobs: 5 }, TOKEN);

    expect(res.body).toEqual({ ok: true, exitCode: 0, output: 'no jobs here\n' });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('waitForLsfJob reports timeout without a tail', async () => {
    const exec = vi.fn(async () => 'JOBID USER STAT\n111 u RUN');
    const waited = await waitForLsfJob(exec, '111', { timeoutMs: 20, pollIntervalMs: 2 });
    expect(waited).toEqual({ jobId: '111', finalState: 'timeout' });
    expect(exec).not.toHaveBeenCalledWith(expect.stringContaining('bpeek'), expect.anything());
  });

  it('waitForLsfJob detects EXIT as a terminal state', async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce('JOBID USER STAT\n222 u EXIT')
      .mockResolvedValueOnce('exit tail\n');
    const waited = await waitForLsfJob(exec, '222', { timeoutMs: 1_000, pollIntervalMs: 2 });
    expect(waited).toEqual({ jobId: '222', finalState: 'EXIT', tail: 'exit tail\n' });
  });
});

describe('bridge /api/bridge/webapi', () => {
  let upstreamMock: ReturnType<typeof vi.fn>;
  let restoreFetch: (() => void) | undefined;

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
  });

  function stubUpstream() {
    upstreamMock = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: any, init?: any) => {
      const url = String(input?.url || input);
      if (url.startsWith('http://127.0.0.1') || url.startsWith('http://[::1]')) {
        return realFetch(input, init);
      }
      return upstreamMock(input, init);
    }));
    restoreFetch = () => vi.unstubAllGlobals();
  }

  it('requires the bridge token and a valid body', async () => {
    const base = await startApp(makeDeps());
    const missing = await post(base, '/api/bridge/webapi', { service: 'uniprot', endpoint: 'entry' });
    expect(missing.status).toBe(403);

    stubUpstream();
    const bad = await post(base, '/api/bridge/webapi', {}, TOKEN);
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'invalid_request' });
  });

  it('invokes the registry web API without requiring a cluster session', async () => {
    stubUpstream();
    upstreamMock.mockResolvedValue(new Response(JSON.stringify({ accession: 'P69905' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    // 无 dsh 会话绑定、无集群会话也应可用（公共只读数据，token 守卫即可）。
    const base = await startApp(makeDeps({
      getDshSessionBinding: () => undefined,
      getSession: () => undefined,
    }));
    const res = await post(base, '/api/bridge/webapi', {
      service: 'uniprot',
      endpoint: 'entry',
      params: { accession: 'P69905' },
    }, TOKEN, '');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      service: 'uniprot',
      endpoint: 'entry',
      data: { accession: 'P69905' },
    });
    expect(String(upstreamMock.mock.calls[0][0])).toBe('https://rest.uniprot.org/uniprotkb/P69905');
  });

  it('passes invoke-layer errors through as ok:false payloads', async () => {
    stubUpstream();
    const base = await startApp(makeDeps());
    const unknown = await post(base, '/api/bridge/webapi', { service: 'nope', endpoint: 'x' }, TOKEN);
    expect(unknown.status).toBe(200);
    expect(unknown.body).toMatchObject({ ok: false, error: { code: 'unknown_service' } });
    expect(upstreamMock).not.toHaveBeenCalled();

    upstreamMock.mockResolvedValue(new Response('boom', { status: 500 }));
    const upstream = await post(base, '/api/bridge/webapi', {
      service: 'uniprot', endpoint: 'entry', params: { accession: 'P69905' },
    }, TOKEN);
    expect(upstream.body).toMatchObject({ ok: false, status: 500, error: { code: 'http_server_error' } });
  });
});

describe('bridge interaction endpoints (sdk channel)', () => {
  it('forwards approvals to the registered session handler and fails closed without one', async () => {
    const onApproval = vi.fn(async () => 'allowed-once' as const);
    const base = await startApp(makeDeps({
      getDshInteractionHandler: id => (id === 'dsh-1' ? { onApproval, onQuestions: async () => null } : undefined),
    }));
    const granted = await post(base, '/api/bridge/interaction/approval', {
      sessionId: 'dsh-1', requestId: 'r-1', toolName: 'run_command', callId: 'c-1', reason: 'HPClaw 命令确认\n风险级: destructive\n命令: bkill 1',
    }, TOKEN);
    expect(granted.status).toBe(200);
    expect(granted.body).toEqual({ outcome: 'allowed-once' });
    expect(onApproval).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'dsh-1', toolName: 'run_command' }));

    const orphan = await post(base, '/api/bridge/interaction/approval', { sessionId: 'dsh-orphan', requestId: 'r-2', toolName: 'pwsh' }, TOKEN);
    expect(orphan.body).toEqual({ outcome: 'unavailable' });

    const forbidden = await post(base, '/api/bridge/interaction/approval', { sessionId: 'dsh-1', requestId: 'r-3' }, 'wrong-token');
    expect(forbidden.status).toBe(403);
  });

  it('fails closed when the approval handler throws', async () => {
    const base = await startApp(makeDeps({
      getDshInteractionHandler: () => ({ onApproval: async () => { throw new Error('ui gone'); }, onQuestions: async () => null }),
    }));
    const res = await post(base, '/api/bridge/interaction/approval', { sessionId: 'dsh-1', requestId: 'r-x', toolName: 'pwsh' }, TOKEN);
    expect(res.body).toEqual({ outcome: 'unavailable' });
  });

  it('forwards questions and maps a null answer to 409 (plugin falls through the waterfall)', async () => {
    const onQuestions = vi.fn(async () => ({ answers: [{ id: 'q1', selected: ['A'] }] }));
    const base = await startApp(makeDeps({
      getDshInteractionHandler: id => (id === 'dsh-1' ? { onApproval: async () => 'unavailable' as const, onQuestions } : undefined),
    }));
    const answered = await post(base, '/api/bridge/interaction/questions', {
      sessionId: 'dsh-1', requestId: 'q-1', callId: 'c-9',
      questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }] }],
    }, TOKEN);
    expect(answered.status).toBe(200);
    expect(answered.body).toEqual({ answer: { answers: [{ id: 'q1', selected: ['A'] }] } });
    expect(onQuestions).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'dsh-1',
      questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }] }],
    }));

    const orphan = await post(base, '/api/bridge/interaction/questions', { sessionId: 'dsh-orphan', requestId: 'q-2', questions: [] }, TOKEN);
    expect(orphan.status).toBe(409);
  });

  it('maps a null handler answer (user dismissed) to 409', async () => {
    const base = await startApp(makeDeps({
      getDshInteractionHandler: () => ({ onApproval: async () => 'unavailable' as const, onQuestions: async () => null }),
    }));
    const res = await post(base, '/api/bridge/interaction/questions', { sessionId: 'dsh-1', requestId: 'q-3', questions: [{ id: 'x', question: '?' }] }, TOKEN);
    expect(res.status).toBe(409);
  });
});

describe('bridgeRoutes submission outcome guard', () => {
  it('persists SSH timeout as unknown and unlocks only after explicit confirmation', async () => {
    const guard = makeGuard();
    const exec = vi.fn()
      .mockRejectedValueOnce(new Error('SSH connection timed out'))
      .mockResolvedValueOnce('Job <12345> is submitted to queue <normal>.');
    const base = await startApp(makeDeps({
      getSession: () => makeSession({ exec }), jobSubmissionGuard: guard,
    }));
    const command = 'bsub -q normal "sleep 300"';
    const first = await post(base, '/api/bridge/exec', { command }, TOKEN);
    expect(first.body).toMatchObject({ ok: false, code: 'submission_result_unknown' });
    expect(first.body.error).toContain('先用调度器');
    expect(first.body.error).toContain('不能盲目重试');
    expect(guard.list()[0]?.state).toBe('unknown');

    const retry = await post(base, '/api/bridge/exec', { command }, TOKEN);
    expect(retry.status).toBe(428);
    expect(retry.body).toMatchObject({ error: 'confirmation_required', code: 'submission_result_unknown' });
    expect(exec).toHaveBeenCalledTimes(1);

    const confirmed = await post(base, '/api/bridge/exec', { command, confirmed: true }, TOKEN);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.ok).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(guard.list()[0]?.state).toBe('submitted');
  });

  it('keeps a successful command without a recognizable receipt unknown', async () => {
    const guard = makeGuard();
    const exec = vi.fn(async () => 'submission accepted, id unavailable\n');
    const base = await startApp(makeDeps({
      getSession: () => makeSession({ exec }), jobSubmissionGuard: guard,
    }));
    const command = 'bsub -q normal "sleep 300"';
    const first = await post(base, '/api/bridge/exec', { command }, TOKEN);
    expect(first.body).toMatchObject({ ok: false, code: 'submission_result_unknown' });
    expect(first.body.output).toContain('id unavailable');
    expect(guard.list()[0]?.state).toBe('unknown');
    await post(base, '/api/bridge/exec', { command }, TOKEN);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('releases only a definite scheduler rejection so a corrected retry can execute', async () => {
    const guard = makeGuard();
    const exec = vi.fn()
      .mockRejectedValueOnce(new Error('Command exited with code 1: bsub: queue does not exist'))
      .mockResolvedValueOnce('Job <12345> is submitted to queue <normal>.');
    const base = await startApp(makeDeps({
      getSession: () => makeSession({ exec }), jobSubmissionGuard: guard,
    }));
    const command = 'bsub -q normal "sleep 300"';
    const rejected = await post(base, '/api/bridge/exec', { command }, TOKEN);
    expect(rejected.body).toMatchObject({ ok: false, code: 'submission_rejected' });
    expect(rejected.body.error).toContain('尚未提交作业');
    expect(guard.list()).toEqual([]);

    const retry = await post(base, '/api/bridge/exec', { command }, TOKEN);
    expect(retry.body.ok).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
