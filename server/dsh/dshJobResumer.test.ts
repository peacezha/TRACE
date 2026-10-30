import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  maybeResumeAgent,
  type DshSdkClientLike,
  type ResumeAgentDeps,
} from './dshJobResumer';
import type { JobAgentBinding } from './jobAgentBindings';
import type { EnsureSidecarResult } from './dshSidecar';

function makeBinding(overrides: Partial<JobAgentBinding> = {}): JobAgentBinding {
  return {
    jobId: '424242',
    sshSessionId: 'ssh-1',
    conversationKey: 'ssh-1',
    dshSessionId: 'dsh-sess-1',
    conversationId: 'conv-1',
    workspace: '/data/work',
    profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-test' },
    locale: 'zh-CN',
    submittedAt: Date.now(),
    resumeCount: 0,
    ...overrides,
  };
}

interface FakeClient extends DshSdkClientLike {
  resume: ReturnType<typeof vi.fn>;
  setWorkingDirectory: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  probeSession: ReturnType<typeof vi.fn>;
  emit: (sessionId: string, event: any) => void;
  subCount: () => number;
}

function makeClient(): FakeClient {
  const subs = new Set<(n: { sessionId: string; event: any }) => void>();
  return {
    resume: vi.fn(async () => {}),
    setWorkingDirectory: vi.fn(async (_s: string, dir: string) => dir),
    prompt: vi.fn(async () => ({ messageId: 'msg-1' })),
    probeSession: vi.fn(async () => 'idle' as const),
    onSessionEvent: (cb) => { subs.add(cb); return () => { subs.delete(cb); }; },
    emit: (sessionId, event) => { for (const cb of [...subs]) cb({ sessionId, event }); },
    subCount: () => subs.size,
  };
}

function makeDeps(overrides: Partial<ResumeAgentDeps> = {}): ResumeAgentDeps & { client: FakeClient } {
  const client = makeClient();
  const deps: ResumeAgentDeps = {
    dataRoot: '/data/root',
    pluginSourceDir: '/plugin',
    skillDirs: ['/skills'],
    getBinding: vi.fn(() => makeBinding()),
    markResumed: vi.fn(),
    exec: vi.fn(async () => 'job output tail line'),
    appendConversation: vi.fn(async () => true),
    emitToUi: vi.fn(),
    notify: vi.fn(async () => undefined),
    ensureSidecar: vi.fn(async (): Promise<EnsureSidecarResult> => ({ ok: true, baseUrl: 'sdk+stdio://local' })),
    createClient: vi.fn(() => client),
    ...overrides,
  };
  return Object.assign(deps, { client });
}

afterEach(() => {
  delete process.env.TRACE_JOB_RESUME;
  vi.useRealTimers();
});

describe('maybeResumeAgent (sdk channel)', () => {
  it('waits for an existing DSH turn before sending a resume prompt', async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      deps.client.probeSession
        .mockResolvedValueOnce('running')
        .mockResolvedValue('idle');
      const running = maybeResumeAgent({ sessionId: 'ssh-1', jobId: '424242', status: 'DONE' }, deps);
      await vi.advanceTimersByTimeAsync(0);
      expect(deps.client.prompt).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(deps.client.prompt).toHaveBeenCalledTimes(1);
      deps.client.emit('dsh-sess-1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Only the resume turn is collected.' }] } } });
      deps.client.emit('dsh-sess-1', { type: 'turn/end', data: { reason: { kind: 'completed' } } });
      await running;
      expect(deps.markResumed).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('does not acknowledge an empty completed turn and explains uncertainty in English', async () => {
    const deps = makeDeps({ getBinding: () => makeBinding({ locale: 'en-US' }) });
    const running = maybeResumeAgent({ sessionId: 'ssh-1', jobId: '424242', status: 'DONE' }, deps);
    await vi.waitFor(() => expect(deps.client.prompt).toHaveBeenCalled());
    deps.client.emit('dsh-sess-1', { type: 'turn/end', data: { reason: { kind: 'completed' } } });
    await running;
    expect(deps.markResumed).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledWith('Auto-resume unverified', expect.stringContaining('results have not been verified'));
  });

  it('does nothing when TRACE_JOB_RESUME=off', async () => {
    const deps = makeDeps();
    process.env.TRACE_JOB_RESUME = 'off';
    await maybeResumeAgent({ sessionId: 'ssh-1', jobId: '424242', status: 'DONE' }, deps);
    expect(deps.getBinding).not.toHaveBeenCalled();
    expect(deps.ensureSidecar).not.toHaveBeenCalled();
  });

  it('does nothing when there is no binding for the job', async () => {
    const deps = makeDeps({ getBinding: vi.fn(() => undefined) });
    await maybeResumeAgent({ sessionId: 'ssh-1', jobId: '424242', status: 'DONE' }, deps);
    expect(deps.ensureSidecar).not.toHaveBeenCalled();
    expect(deps.markResumed).not.toHaveBeenCalled();
  });

  it('leaves legacy bindings to the legacy resumer', async () => {
    const deps = makeDeps({ getBinding: vi.fn(() => makeBinding({ engine: 'legacy', dshSessionId: '' })) });
    await maybeResumeAgent({ sessionId: 'ssh-1', jobId: '424242', status: 'DONE' }, deps);
    expect(deps.ensureSidecar).not.toHaveBeenCalled();
    expect(deps.createClient).not.toHaveBeenCalled();
    expect(deps.markResumed).not.toHaveBeenCalled();
  });

  it('stops at the per-job resume cap', async () => {
    const deps = makeDeps({ getBinding: vi.fn(() => makeBinding({ resumeCount: 3 })) });
    await maybeResumeAgent({ sessionId: 'ssh-1', jobId: '424242', status: 'DONE' }, deps);
    expect(deps.ensureSidecar).not.toHaveBeenCalled();
    expect(deps.markResumed).not.toHaveBeenCalled();
  });

  it('returns quietly when the sidecar is unavailable', async () => {
    const deps = makeDeps({
      ensureSidecar: vi.fn(async (): Promise<EnsureSidecarResult> => ({ ok: false, reason: 'no dsh' })),
    });
    await maybeResumeAgent({ sessionId: 'ssh-1', jobId: '424242', status: 'DONE' }, deps);
    expect(deps.createClient).not.toHaveBeenCalled();
    expect(deps.markResumed).not.toHaveBeenCalled();
  });

  it('runs the full wake-up flow and echoes results', async () => {
    const deps = makeDeps();
    const running = maybeResumeAgent({ sessionId: 'ssh-1', jobId: '424242', status: 'DONE' }, deps);
    await vi.waitFor(() => expect(deps.client.prompt).toHaveBeenCalled());

    expect(deps.exec).toHaveBeenCalledWith('ssh-1', 'bpeek 424242 | tail -60', 20_000);
    expect(deps.ensureSidecar).toHaveBeenCalledWith(expect.objectContaining({
      pluginSourceDir: '/plugin',
      skillDirs: ['/skills'],
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      extraEnv: { DEEPSEEK_API_KEY: 'sk-test', DEEPSEEK_BASE_URL: 'https://api.deepseek.com' },
    }));
    expect(deps.client.resume).toHaveBeenCalledWith('dsh-sess-1');
    expect(deps.client.setWorkingDirectory).toHaveBeenCalledWith('dsh-sess-1', '/data/work');
    const promptText = deps.client.prompt.mock.calls[0][0].text as string;
    expect(promptText).toContain('424242');
    expect(promptText).toContain('DONE');
    expect(promptText).toContain('job output tail line');
    expect(promptText).toContain('请读取完整输出并继续之前的任务');

    // 其他会话的事件被忽略；本会话最后一条 assistant 结论用于 turn/end 收尾
    deps.client.emit('other-sess', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'noise' }] } } });
    deps.client.emit('dsh-sess-1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '任务完成，' }] } } });
    deps.client.emit('dsh-sess-1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '表达量正常。' }] } } });
    deps.client.emit('dsh-sess-1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    await running;

    expect(deps.appendConversation).toHaveBeenCalledWith('conv-1', [
      { role: 'user', content: '【系统】作业 424242 已结束（DONE），已自动继续处理。' },
      { role: 'assistant', content: '表达量正常。' },
    ], 'ssh-1');
    expect(deps.emitToUi).toHaveBeenCalledWith('ssh-1', {
      type: 'ai:resumed',
      conversationId: 'conv-1',
      jobId: '424242',
      preview: '表达量正常。',
    });
    expect(deps.notify).toHaveBeenCalledWith('作业完成，AI 已继续处理', '表达量正常。');
    expect(deps.markResumed).toHaveBeenCalledWith('424242', 'ssh-1');
    expect(deps.client.subCount()).toBe(0);
  });

  it('uses the default model and skips conversation echo when profile/conversationId are absent', async () => {
    const deps = makeDeps({
      getBinding: vi.fn(() => makeBinding({ profile: undefined, conversationId: undefined })),
      exec: vi.fn(async () => { throw new Error('bpeek failed'); }),
    });
    const running = maybeResumeAgent({ sessionId: 'ssh-1', jobId: '424242', status: 'EXIT' }, deps);
    await vi.waitFor(() => expect(deps.client.prompt).toHaveBeenCalled());
    deps.client.emit('dsh-sess-1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '任务已核验。' }] } } });
    deps.client.emit('dsh-sess-1', { type: 'turn/end', data: { reason: { kind: 'completed' } } });
    await running;

    expect(deps.ensureSidecar).toHaveBeenCalledWith(expect.objectContaining({ model: 'deepseek-v4-pro' }));
    expect(deps.ensureSidecar).toHaveBeenCalledWith(expect.objectContaining({ extraEnv: {} }));
    const promptText = deps.client.prompt.mock.calls[0][0].text as string;
    expect(promptText).not.toContain('输出摘要');
    expect(deps.appendConversation).not.toHaveBeenCalled();
    expect(deps.markResumed).toHaveBeenCalledWith('424242', 'ssh-1');
  });

  it('serializes concurrent resumes for the same dsh session', async () => {
    const deps = makeDeps();
    const first = maybeResumeAgent({ sessionId: 'ssh-1', jobId: '424242', status: 'DONE' }, deps);
    await vi.waitFor(() => expect(deps.client.prompt).toHaveBeenCalledTimes(1));

    // 第二个唤醒撞上互斥锁：直接返回，不再触达 dsh
    await maybeResumeAgent({ sessionId: 'ssh-1', jobId: '424242', status: 'DONE' }, deps);
    expect(deps.client.prompt).toHaveBeenCalledTimes(1);
    expect(deps.markResumed).not.toHaveBeenCalled();

    deps.client.emit('dsh-sess-1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '任务已核验。' }] } } });
    deps.client.emit('dsh-sess-1', { type: 'turn/end', data: { reason: { kind: 'completed' } } });
    await first;
    expect(deps.markResumed).toHaveBeenCalledTimes(1);
  });

  it('never throws even when a step blows up', async () => {
    const deps = makeDeps({
      getBinding: vi.fn(() => { throw new Error('store corrupted'); }),
    });
    await expect(maybeResumeAgent({ sessionId: 'ssh-1', jobId: '424242', status: 'DONE' }, deps))
      .resolves.toBeUndefined();
  });

  it('monitors new jobs submitted during the resumed turn', async () => {
    const deps = makeDeps({ onJobsSubmitted: vi.fn() });
    const running = maybeResumeAgent({ sessionId: 'ssh-1', jobId: '424242', status: 'DONE' }, deps);
    await vi.waitFor(() => expect(deps.client.prompt).toHaveBeenCalledTimes(1));
    deps.client.emit('dsh-sess-1', { type: 'tool/call', data: { name: 'run_command', callId: 'submit', arguments: '{"command":"bsub < next.lsf"}' } });
    deps.client.emit('dsh-sess-1', { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'submit', content: [{ type: 'text', text: 'Job <777> is submitted to queue <normal>.' }] } } });
    expect(deps.onJobsSubmitted).toHaveBeenCalledWith(expect.objectContaining({ dshSessionId: 'dsh-sess-1' }), ['777']);
    deps.client.emit('dsh-sess-1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '后续作业已交接监控。' }] } } });
    deps.client.emit('dsh-sess-1', { type: 'turn/end', data: { reason: { kind: 'completed' } } });
    await running;
    expect(deps.markResumed).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge a failed wake prompt submission', async () => {
    const deps = makeDeps();
    deps.client.prompt.mockRejectedValue(new Error('stream closed'));
    await maybeResumeAgent({ sessionId: 'ssh-1', jobId: '424242', status: 'DONE' }, deps);
    expect(deps.markResumed).not.toHaveBeenCalled();
    expect(deps.appendConversation).toHaveBeenCalledWith('conv-1', expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: expect.stringContaining('未完成') }),
    ]), 'ssh-1');
  });
});
