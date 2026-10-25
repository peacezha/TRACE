import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

const { mockStreamText, mockInvokeWebApi, mockSearchWebApis, mockSpawn } = vi.hoisted(() => ({
  mockStreamText: vi.fn(),
  mockInvokeWebApi: vi.fn(),
  mockSearchWebApis: vi.fn(),
  mockSpawn: vi.fn(),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: () => () => 'openai-model',
}));

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: () => ({
    chatModel: () => 'compatible-model',
  }),
}));

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: () => () => 'google-model',
}));

vi.mock('ai', () => ({
  streamText: mockStreamText,
  tool: (definition: any) => definition,
  stepCountIs: () => () => false,
  zodSchema: (schema: any) => schema,
}));

// 只替换 spawn（wheatomics_query / github_mirror_scout 的本机子进程），
// 其余 child_process 能力（如 localWorkspace 的 exec）保持真实实现。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: mockSpawn };
});
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: mockSpawn };
});

vi.mock('../webapis/invoke', () => ({
  invokeWebApi: mockInvokeWebApi,
  searchWebApis: mockSearchWebApis,
}));

import {
  buildAgentSystemPrompt,
  buildLocalWorkspacePromptSection,
  buildWorkflowExecutorPrompt,
  buildWorkflowInspectorPrompt,
  extractUserAuthorizedPaths,
  normalizeAgentRuntimeConfig,
  planNeedsReview,
  runAgent,
  selectCurrentWorkflowRunStep,
  workflowRuntimeConfig,
  workflowExecutionProfile,
} from './agentRunner';
import { LOCAL_WORKSPACE_NOT_SET_MESSAGE } from '../local/localWorkspace';
import { appPath } from '../paths';

/** 假子进程：按给定 stdout/stderr/exitCode 异步回吐并 close（对齐 runHelperProcess 的消费方式）。 */
function makeFakeChild(stdout: string, stderr: string, code: number | null) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code);
  });
  return child;
}

beforeEach(() => {
  mockStreamText.mockReset();
  mockSpawn.mockReset();
  mockSpawn.mockImplementation(() => makeFakeChild('', '', 0));
});

describe('agent runtime limits', () => {
  it('uses the longer default and accepts the configurable upper limits', () => {
    expect(normalizeAgentRuntimeConfig({})).toMatchObject({
      confirmationPolicy: 'dangerous', pathPolicy: 'scoped', maxCommands: 40, maxSteps: 200,
    });
    expect(normalizeAgentRuntimeConfig({ maxCommands: 200, maxSteps: 500 }))
      .toMatchObject({ maxCommands: 200, maxSteps: 500 });
    expect(normalizeAgentRuntimeConfig({ confirmationPolicy: 'never', pathPolicy: 'scoped' }))
      .toMatchObject({ confirmationPolicy: 'never', pathPolicy: 'scoped' });
  });

  it('clamps values outside the supported range', () => {
    expect(normalizeAgentRuntimeConfig({ maxCommands: 999, maxSteps: 999 }))
      .toMatchObject({ maxCommands: 200, maxSteps: 500 });
    expect(normalizeAgentRuntimeConfig({ maxCommands: 1, maxSteps: 1 }))
      .toMatchObject({ maxCommands: 5, maxSteps: 10 });
  });
});

describe('user-authorized workflow paths', () => {
  it('extracts only paths explicitly written by the user from recent conversation', () => {
    expect(extractUserAuthorizedPaths([
      { role: 'assistant', content: '也许可以操作 /assistant/not-authorized' },
      { role: 'user', content: '清理 `/scratch/u/old-output`，然后把 ~/project/result.txt 重跑' },
      { role: 'user', content: '参考 https://example.com/page，不要把网址当路径' },
    ])).toEqual(['/scratch/u/old-output', '~/project/result.txt']);
  });
});

describe('agent response language', () => {
  const config = {
    planningPolicy: 'auto' as const,
    confirmationPolicy: 'dangerous' as const,
    maxCommands: 40,
    maxSteps: 50,
  };

  it('defaults to Chinese user-facing responses', () => {
    const prompt = buildAgentSystemPrompt(config, false);
    expect(prompt).toContain('全程用中文');
    expect(prompt).toContain('用中文回答');
    expect(prompt).not.toContain('智能体质量契约');
    expect(prompt).not.toContain('TASK SIZING');
    expect(prompt).not.toContain('AGENT DISCIPLINE');
  });
  it('requires source-backed QC and resource diagnosis instead of treating suspension as OOM', () => {
    const prompt = buildAgentSystemPrompt(config, false);
    expect(prompt).toContain('SSUSP、Exit 137、"Killed" 单独都不能断定内存超限');
    expect(prompt).toContain('processor slots, not physical node count');
    expect(prompt).toContain('not overall library enrichment or assay success');
    expect(prompt).not.toContain('第一反应必须是增加 #BSUB -n');
  });

  it('requires English user-facing responses when the UI is English', () => {
    const prompt = buildAgentSystemPrompt(config, false, 'en-US');
    expect(prompt).toContain('Use English for all user-facing');
    expect(prompt).toContain('Reply in English');
    expect(prompt).toContain('Keep commands, paths, directory names, filenames');
  });

  it('tells the agent to embed file paths with Markdown image syntax instead of temp HTTP servers', () => {
    const prompt = buildAgentSystemPrompt(config, false);
    expect(prompt).toContain('![描述](路径)');
    expect(prompt).toContain('临时 HTTP 服务');
    expect(prompt).toContain('base64');
  });
});

describe('lightweight workflow execution mode', () => {
  const config = normalizeAgentRuntimeConfig({});
  const workflowRun = {
    workflowId: 'wf-1', runId: 'run-1',
    runDir: '/home/u/trace_flows/w/03_workspace/runs/run-1',
    policy: 'isolated-run-v1' as const,
  };

  it('respects the user-selected reasoning model and sampling profile for saved workflow steps', () => {
    const reasoning = {
      provider: 'deepseek', model: 'deepseek-reasoner', apiKey: 'x', temperature: 0.65,
    };
    expect(workflowExecutionProfile(reasoning)).toEqual(reasoning);
    expect(workflowExecutionProfile({
      provider: 'deepseek', model: 'deepseek-v4-pro', apiKey: 'x', temperature: 0.4,
    })).toMatchObject({ model: 'deepseek-v4-pro', temperature: 0.4 });
    expect(workflowExecutionProfile({
      provider: 'openai', model: 'gpt-4o', apiKey: 'x',
    }).model).toBe('gpt-4o');
  });

  it('drops the numeric command cap for workflows but keeps the model-step guard', () => {
    // 正式流程不再压缩命令数上限（数值上限曾让模型自行宣布"额度用完"中途暂停）；
    // 死循环防护交给同命令重复/连续失败/无进展停滞判定，模型步数上限仅作兜底。
    expect(workflowRuntimeConfig(normalizeAgentRuntimeConfig({ maxCommands: 200, maxSteps: 500 })))
      .toMatchObject({ maxCommands: 200, maxSteps: 200 });
    expect(workflowRuntimeConfig(normalizeAgentRuntimeConfig({ maxCommands: 6, maxSteps: 20 })))
      .toMatchObject({ maxCommands: 6, maxSteps: 20 });
  });

  it('builds a compact current-step executor prompt instead of a second plan', () => {
    const prompt = buildWorkflowExecutorPrompt(config, workflowRun, {
      ...workflowRun, status: 'running', currentStep: 2, totalSteps: 5,
      steps: [{ n: 2, title: '比对', status: 'running', scriptPath: `${workflowRun.runDir}/code/step-02.sh` }],
    });
    expect(prompt).toContain('workflow executor');
    expect(prompt).toContain('step-02.sh');
    expect(prompt).toContain('restartFromStep');
    expect(prompt).toContain('Do not hand shell commands back to the user');
    // 提交未知状态和调度器安全提示增加后仍保持紧凑单步提示。
    expect(prompt.length).toBeLessThan(6_500);
  });

  it('adds an environment-repair mode section only when the run starts blocked_env', () => {
    // v0.4.25：修复轮被停止门一轮掐断的根因修复——提示词必须显式告诉模型
    // 直接修、修完显式翻回 running、修不了带精确 error 重新断言 blocked_env。
    const blocked = buildWorkflowExecutorPrompt(config, workflowRun, {
      ...workflowRun, status: 'blocked_env', error: 'phantompeakqualtools 未就绪',
    });
    expect(blocked).toContain('ENVIRONMENT REPAIR MODE');
    expect(blocked).toContain('update_workflow_run(status=running)');
    expect(blocked).toContain('登录节点');
    const running = buildWorkflowExecutorPrompt(config, workflowRun, {
      ...workflowRun, status: 'running', currentStep: 1, totalSteps: 5,
      steps: [{ n: 1, title: '预检', status: 'pending' }],
    });
    expect(running).not.toContain('ENVIRONMENT REPAIR MODE');
  });

  it('keeps the saved report language even when background continuation has a different UI locale', () => {
    const prompt = buildWorkflowExecutorPrompt(config, workflowRun, {
      ...workflowRun, status: 'running', config: { reportLanguage: 'en' }, steps: [],
    }, 'zh-CN');
    expect(prompt).toContain('REPORT LANGUAGE: en');
    expect(prompt).toContain('--language en');
  });

  it('builds a read-only inspector prompt that forbids workflow mutations and fake ETA claims', () => {
    const prompt = buildWorkflowInspectorPrompt(workflowRun, {
      ...workflowRun, status: 'waiting_jobs', currentStep: 3, totalSteps: 5,
      steps: [{ n: 3, title: 'STAR 比对', status: 'running', jobIds: ['75512132'] }],
      jobStates: { '75512132': 'PEND' },
    });
    expect(prompt).toContain('conversational HPC assistant');
    expect(prompt).toContain('75512132');
    expect(prompt).toContain('never resubmit');
    expect(prompt).toContain('RUN/PEND totals alone cannot establish a reliable start time');
  });

  it('uses run.currentStep before a stale earlier running step', () => {
    const selected = selectCurrentWorkflowRunStep({
      currentStep: 3,
      steps: [
        { n: 2, status: 'running', title: 'stale FastQC' },
        { n: 3, status: 'running', title: 'STAR', jobIds: ['75512132'] },
      ],
    });
    expect(selected?.n).toBe(3);
  });

  it('falls forward when run.currentStep already points to a completed step', () => {
    const selected = selectCurrentWorkflowRunStep({
      currentStep: 2,
      steps: [
        { n: 2, status: 'done', title: 'FastQC' },
        { n: 3, status: 'pending', title: 'STAR' },
      ],
    });
    expect(selected?.n).toBe(3);
  });
});

describe('runAgent ask_user handling', () => {
  it('answers the screenshot follow-up without offering ask_user or allowing mutations', async () => {
    const run = vi.fn(async () => 'evidence'); const onAsk = vi.fn(); const onDone = vi.fn();
    mockStreamText.mockImplementation((options: any) => ({ fullStream: (async function* () {
      expect(options.tools.ask_user).toBeUndefined();
      expect(options.system).toContain('TRACE_CLARIFICATION_ONLY');
      const blocked = await options.tools.run_command.execute({ command: 'bsub < step-03.sh' });
      expect(blocked).toContain('Read-only');
      yield { type: 'text-delta', text: '方案 A：保留已有结果并修复索引；方案 B：只有文件损坏时才重算。推荐先检查 A，未执行任何操作。' };
    })() }));
    await runAgent({ sid: 'question-test', run, profile: { provider: 'deepseek', model: 'test', apiKey: 'test' } },
      { onText: vi.fn(), onReason: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn(), onStep: vi.fn(), onAsk, onDone, onErr: vi.fn(), sig: () => undefined },
      [{ role: 'assistant', content: '❓ step-03 失败，如何修复并继续？' }, { role: 'user', content: '有哪些修复方案？' }]);
    expect(onAsk).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(onDone).toHaveBeenCalledWith(expect.stringContaining('方案 A'));
  });
  it('rejects the same answered question and lets the model continue with the existing choice', async () => {
    const onAsk = vi.fn();
    mockStreamText.mockImplementation((options: any) => ({ fullStream: (async function* () {
      const feedback = await options.tools.ask_user.execute({ question: '选择参考版本？', options: ['IWGSC v1.0', 'IWGSC v2.1'] });
      expect(feedback).toContain('TRACE_REPEAT_QUESTION_BLOCKED'); expect(feedback).toContain('IWGSC v1.0');
      yield { type: 'text-delta', text: '将使用你已指定的 IWGSC v1.0；不会再问同一版本问题。' };
    })() }));
    await runAgent({ sid: 'question-test', run: vi.fn(), profile: { provider: 'deepseek', model: 'test', apiKey: 'test' } },
      { onText: vi.fn(), onReason: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn(), onStep: vi.fn(), onAsk, onDone: vi.fn(), onErr: vi.fn(), sig: () => undefined },
      [{ role: 'assistant', content: '❓ 选择参考版本？' }, { role: 'user', content: 'IWGSC v1.0' }]);
    expect(onAsk).not.toHaveBeenCalled();
  });

  it('converts a plain-text choice question into a real ask with options', async () => {
    const onAsk = vi.fn(); const onDone = vi.fn();
    mockStreamText.mockImplementation((options: any) => ({ fullStream: (async function* () {
      yield { type: 'text-delta', text: '文献侧只有 peak BED，无法给你 bw/BAM。比对请选一个方向，我按你选的提交作业：' };
    })() }));
    await runAgent({ sid: 'question-test', run: vi.fn(), profile: { provider: 'deepseek', model: 'test', apiKey: 'test' } },
      { onText: vi.fn(), onReason: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn(), onStep: vi.fn(), onAsk, onDone, onErr: vi.fn(), sig: () => undefined },
      [{ role: 'user', content: '文献里有没有 bam 或 bw 文件，我要和我的做比对' }]);
    expect(onAsk).toHaveBeenCalledTimes(1);
    const [question, options] = onAsk.mock.calls[0] as unknown as [string, string[]];
    expect(question).toContain('请选一个方向');
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(onDone).toHaveBeenCalledWith('__ASK__');
  });
  it('keeps formal RUN tools out of a general cluster conversation', async () => {
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        expect(Object.keys(options.tools)).not.toContain('get_workflow_run');
        expect(Object.keys(options.tools)).not.toContain('get_workflow_step');
        expect(Object.keys(options.tools)).not.toContain('update_workflow_run');
        expect(Object.keys(options.tools)).toContain('run_command');
        yield { type: 'text-delta', text: '普通分析目录不会被误当成正式 RUN。' };
      })(),
    }));

    await runAgent(
      { sid: 'session-1', run: vi.fn(), profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key' } },
      {
        onText: vi.fn(), onReason: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn(), onStep: vi.fn(),
        onAsk: vi.fn(), onDone: vi.fn(), onErr: vi.fn(), sig: () => undefined,
      },
      [{ role: 'user', content: '检查 /public/home/u/project' }],
    );
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });

  it('stops repeated read-only diagnosis with a precise stagnation reason instead of the old three-continuation error', async () => {
    let round = 0;
    mockStreamText.mockImplementation((options: any) => {
      const current = round++;
      return {
        fullStream: (async function* () {
          await options.tools.run_command.execute({ command: `sed -n '${current + 1}p' reference.sh` });
          yield { type: 'text-delta', text: `第 ${current + 1} 轮只检查。` };
        })(),
      };
    });
    const visible: string[] = [];
    await runAgent(
      {
        sid: 'session-1', run: vi.fn().mockResolvedValue('reference line'),
        resumePlan: {
          goal: '生成并提交质控脚本', createdAt: 1, updatedAt: 1,
          steps: [{ id: '7', title: '生成并提交 06_valuation.lsf', verification: '看到作业号及结果文件', status: 'running' }],
        },
        profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key' },
      },
      {
        onText: text => visible.push(text), onReason: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn(),
        onStep: vi.fn(), onAsk: vi.fn(), onDone: vi.fn(), onErr: vi.fn(), sig: () => undefined,
      },
      [{ role: 'user', content: '继续执行，不要只检查' }],
    );

    expect(mockStreamText).toHaveBeenCalledTimes(3);
    expect(mockStreamText.mock.calls[1][0].messages.at(-1).content).toContain('先用已有证据作结论');
    expect(mockStreamText.mock.calls[2][0].messages.at(-1).content).toContain('强制推进');
    expect(visible.join('')).toContain('连续 3 个执行阶段只有只读诊断');
    expect(visible.join('')).not.toContain('Agent 已自动续跑 3 次');
  });

  it('finishes the turn as an ask when ask_user is called without provider aborting the stream', async () => {
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        await options.tools.ask_user.execute({ question: '是否重新提交这个作业？' });
      })(),
    }));

    const asks: string[] = [];
    const askOptions: string[][] = [];
    const dones: string[] = [];

    await runAgent(
      {
        sid: 'session-1',
        run: vi.fn(),
        profile: {
          provider: 'deepseek',
          model: 'deepseek-chat',
          apiKey: 'test-key',
        },
      },
      {
        onText: vi.fn(),
        onReason: vi.fn(),
        onToolCall: vi.fn(),
        onToolResult: vi.fn(),
        onStep: vi.fn(),
        onAsk: (question, options) => {
          asks.push(question);
          askOptions.push(options || []);
        },
        onDone: (text) => dones.push(text),
        onErr: vi.fn(),
        sig: () => undefined,
      },
      [{ role: 'user', content: '帮我检查任务状态' }],
    );

    expect(asks).toEqual(['是否重新提交这个作业？']);
    expect(askOptions).toEqual([['是，继续', '否，先不做', '先暂停任务']]);
    expect(dones).toEqual(['__ASK__']);
  });

  it('stops after repeated command timeouts instead of continuing the agent loop', async () => {
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        for (let i = 0; i < 5; i++) {
          await options.tools.run_command.execute({ command: `zcat huge_${i}.fq.gz | wc -l` });
          if (options.abortSignal.aborted) return;
        }
        yield { type: 'text-delta', text: 'kept going after repeated failures' };
      })(),
    }));

    const dones: string[] = [];
    const errors: string[] = [];
    const toolResults: string[] = [];

    await runAgent(
      {
        sid: 'session-1',
        run: vi.fn().mockRejectedValue(new Error('Command execution timed out')),
        profile: {
          provider: 'deepseek',
          model: 'deepseek-chat',
          apiKey: 'test-key',
        },
      },
      {
        onText: vi.fn(),
        onReason: vi.fn(),
        onToolCall: vi.fn(),
        onToolResult: (_name, result) => toolResults.push(result),
        onStep: vi.fn(),
        onAsk: vi.fn(),
        onDone: (text) => dones.push(text),
        onErr: (err) => errors.push(err),
        sig: () => undefined,
      },
      [{ role: 'user', content: '统计一批 ATAC fastq 的 reads 数' }],
    );

    expect(errors).toEqual([]);
    expect(toolResults.at(-1)).toContain('连续 5 次命令失败，已暂停以防空转');
    expect(dones).toEqual([expect.stringContaining('连续 5 次命令失败，已暂停以防空转')]);
  });

  it('stops before running the same command for a third time', async () => {
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        for (let i = 0; i < 3; i++) {
          await options.tools.run_command.execute({ command: 'date; hostname' });
          if (options.abortSignal.aborted) return;
        }
      })(),
    }));

    const run = vi.fn().mockResolvedValue('ok');
    const dones: string[] = [];

    await runAgent(
      {
        sid: 'session-1',
        run,
        profile: {
          provider: 'deepseek',
          model: 'deepseek-chat',
          apiKey: 'test-key',
        },
      },
      {
        onText: vi.fn(),
        onReason: vi.fn(),
        onToolCall: vi.fn(),
        onToolResult: vi.fn(),
        onStep: vi.fn(),
        onAsk: vi.fn(),
        onDone: (text) => dones.push(text),
        onErr: vi.fn(),
        sig: () => undefined,
      },
      [{ role: 'user', content: '检查集群状态' }],
    );

    expect(run).toHaveBeenCalledTimes(2);
    expect(dones).toEqual([expect.stringContaining('Agent stopped after repeating the same command')]);
  });

  it('requires a verified plan before changing cluster state', async () => {
    const toolResults: string[] = [];
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        await options.tools.run_command.execute({ command: 'echo report > report.txt' });
        await options.tools.set_plan.execute({
          goal: '生成报告',
          steps: [{ title: '写入报告', verification: '检查 report.txt 内容' }],
        });
        await options.tools.update_plan_step.execute({ id: '1', status: 'running' });
        await options.tools.run_command.execute({ command: 'echo report > report.txt' });
      })(),
    }));
    const run = vi.fn().mockResolvedValue('ok');

    await runAgent(
      {
        sid: 'session-1',
        run,
        profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key' },
      },
      {
        onText: vi.fn(), onReason: vi.fn(), onToolCall: vi.fn(), onStep: vi.fn(), onAsk: vi.fn(), onDone: vi.fn(), onErr: vi.fn(),
        onToolResult: (_name, result) => toolResults.push(result),
        sig: () => undefined,
      },
      [{ role: 'user', content: '生成报告' }],
    );

    expect(toolResults[0]).toContain('requires set_plan');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('binds a formal workflow to its RUN directory and blocks state-changing unauthorized scans without a duplicate plan', async () => {
    const runDir = '/public/home/u/trace_flows/rna/03_workspace/runs/run-1';
    let authoritativeRun: any = {
      runId: 'run-1', workflowId: 'wf-rna', workflowName: 'RNA', workflowVersion: 1,
      runDir, workspacePolicy: 'isolated-run-v1', status: 'running', startedAt: 1,
      updatedAt: 1, heartbeatAt: 1, currentStep: 1, totalSteps: 1,
      config: {
        inputs: ['/public/home/u/data/fastq'], params: {}, stepParams: {},
        referenceOverrides: {}, skippedSteps: [], stepCommandOverrides: {},
      },
      steps: [{ n: 1, stepId: 'step-01', title: 'QC', status: 'running' }],
    };
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        await options.tools.get_workflow_run.execute({ runDir });
        // 只读的环境探查：新语义下允许（不拦截）
        await options.tools.run_command.execute({ command: 'ls /public/home/u/.local/share/mamba/envs | head' });
        // 改变状态的未授权遍历：仍应被拦截
        await options.tools.run_command.execute({ command: 'ls /public/home/u > results/homescan.txt' });
        await options.tools.run_command.execute({ command: 'echo ok > results/status.txt' });
        await options.tools.update_workflow_run.execute({ runDir, status: 'waiting_user', error: '测试已暂停' });
      })(),
    }));
    const clusterRun = vi.fn(async (_sid: string, command: string) => {
      if (command.startsWith(`cat '${runDir}/run.json'`)) return JSON.stringify(authoritativeRun);
      const encoded = command.match(/printf %s '([^']+)' \| base64 -d/)?.[1];
      if (encoded) {
        authoritativeRun = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
        return '';
      }
      return 'ok';
    });
    const results: string[] = [];

    await runAgent(
      {
        sid: 'session-1', home: '/public/home/u', run: clusterRun,
        workflowRun: { workflowId: 'wf-rna', runId: 'run-1', runDir, policy: 'isolated-run-v1' },
        runtimeConfig: { pathPolicy: 'scoped' },
        profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key' },
      },
      {
        onText: vi.fn(), onReason: vi.fn(), onToolCall: vi.fn(), onStep: vi.fn(), onAsk: vi.fn(), onDone: vi.fn(), onErr: vi.fn(),
        onToolResult: (_name, result) => results.push(result),
        sig: () => undefined,
      },
      [{ role: 'user', content: '运行正式流程' }],
    );

    // 只读探查实际执行了（固定在 RUN 目录包装后发出）
    expect(clusterRun.mock.calls.map(call => call[1]))
      .toContain(`cd '${runDir}' && ls /public/home/u/.local/share/mamba/envs | head`);
    // 写向重定向的未授权扫描被拦截
    expect(results).toContainEqual(expect.stringContaining('Workflow command blocked'));
    expect(clusterRun.mock.calls.map(call => call[1]))
      .toContain(`cd '${runDir}' && echo ok > results/status.txt`);
    expect(clusterRun.mock.calls.map(call => call[1]).join('\n')).not.toContain(`ls /public/home/u > results/homescan.txt`);
    expect(mockStreamText.mock.calls[0][0].system).toContain('workflow executor');
    expect(mockStreamText.mock.calls[0][0].system).toContain('Default to doing the work with tools');
    expect(Object.keys(mockStreamText.mock.calls[0][0].tools)).not.toContain('set_plan');
  });

  it('answers a workflow status question once with read-only tools and cannot ask, submit, or update', async () => {
    const runDir = '/public/home/u/trace_flows/rna/03_workspace/runs/run-inspect';
    const authoritativeRun = {
      runId: 'run-inspect', workflowId: 'wf-rna', workflowName: 'RNA', workflowVersion: 1,
      runDir, workspacePolicy: 'isolated-run-v1', status: 'waiting_jobs', startedAt: 1,
      updatedAt: 1, heartbeatAt: 1, currentStep: 3, totalSteps: 5,
      config: { inputs: [], params: {}, stepParams: {}, referenceOverrides: {}, skippedSteps: [], stepCommandOverrides: {} },
      steps: [
        { n: 2, stepId: 'step-02', title: 'FastQC', status: 'done', summary: '质控完成' },
        { n: 3, stepId: 'step-03', title: 'STAR', status: 'running', jobIds: ['75512132'] },
      ],
      jobStates: { '75512132': 'PEND' },
    };
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        expect(Object.keys(options.tools).sort()).toEqual(['get_workflow_run', 'run_command']);
        await options.tools.run_command.execute({ command: 'bjobs -l 75512132' });
        yield { type: 'text-delta', text: '75512132 正在排队；当前证据不足以给出可靠 ETA。' };
      })(),
    }));
    const clusterRun = vi.fn(async (_sid: string, command: string) => {
      if (command.startsWith(`cat '${runDir}/run.json'`)) return JSON.stringify(authoritativeRun);
      if (command.includes('bjobs -l 75512132')) return 'Job <75512132>, Status <PEND>, PENDING REASONS: Not enough hosts';
      return '';
    });
    const visibleText: string[] = [];
    const dones: string[] = [];

    await runAgent(
      {
        sid: 'session-1', home: '/public/home/u', run: clusterRun,
        workflowRun: { workflowId: 'wf-rna', runId: 'run-inspect', runDir, policy: 'isolated-run-v1' },
        workflowTurnMode: 'inspect',
        profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key' },
      },
      {
        onText: text => visibleText.push(text), onReason: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn(),
        onStep: vi.fn(), onAsk: vi.fn(), onDone: text => dones.push(text), onErr: vi.fn(), sig: () => undefined,
      },
      [
        { role: 'user', content: 'STAR 作业还在排队' },
        { role: 'assistant', content: '作业号是 75512132。' },
        { role: 'user', content: '大概还要多久？' },
      ],
    );

    expect(mockStreamText).toHaveBeenCalledTimes(1);
    expect(mockStreamText.mock.calls[0][0].system).toContain('conversational HPC assistant');
    expect(mockStreamText.mock.calls[0][0].messages).toHaveLength(3);
    expect(visibleText.join('')).toContain('不足以给出可靠 ETA');
    expect(dones).toEqual([expect.stringContaining('不足以给出可靠 ETA')]);
    expect(clusterRun.mock.calls.map(call => call[1]).join('\n')).not.toMatch(/bsub|bkill|run\.json\.tmp/);
  });

  it('detaches the conversation instead of erroring forever when RUN/run.json is gone on the cluster', async () => {
    const runDir = '/public/home/u/trace_flows/atac/03_workspace/runs/run-deleted';
    const clusterRun = vi.fn(async (_sid: string, command: string) => {
      if (command.startsWith(`cat '${runDir}/run.json'`)) {
        throw new Error(`cat: ${runDir}/run.json: No such file or directory`);
      }
      return '';
    });
    const errors: string[] = [];
    const missing: string[] = [];

    await runAgent(
      {
        sid: 'session-1', home: '/public/home/u', run: clusterRun,
        workflowRun: { workflowId: 'wf-atac', runId: 'run-deleted', runDir, policy: 'isolated-run-v1' },
        profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key' },
      },
      {
        onText: vi.fn(), onReason: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn(),
        onStep: vi.fn(), onAsk: vi.fn(), onDone: vi.fn(),
        onErr: error => errors.push(error),
        onWorkflowRunMissing: wf => missing.push(wf.runDir),
        sig: () => undefined,
      },
      [{ role: 'user', content: '回到这个文件夹：/public/home/u/RNA-seq' }],
    );

    // run.json 丢失是终态：只发解绑事件，不再走会刷屏卡死的通用错误
    expect(missing).toEqual([runDir]);
    expect(errors).toEqual([]);
    expect(mockStreamText).not.toHaveBeenCalled();
  });

  it('keeps a formal workflow in the same request when the model tries to finish early', async () => {
    const runDir = '/public/home/u/trace_flows/troubleshoot/03_workspace/runs/run-early';
    let authoritativeRun: any = {
      runId: 'run-early', workflowId: 'wf-troubleshoot', workflowName: '排查', workflowVersion: 1,
      runDir, workspacePolicy: 'isolated-run-v1', status: 'running', startedAt: 1,
      updatedAt: 1, heartbeatAt: 1, currentStep: 1, totalSteps: 1,
      config: { inputs: [], params: {}, stepParams: {}, referenceOverrides: {}, skippedSteps: [], stepCommandOverrides: {} },
      steps: [{ n: 1, stepId: 'step-01', title: '检查状态', status: 'running' }],
    };
    let round = 0;
    mockStreamText.mockImplementation((options: any) => {
      const currentRound = round++;
      return {
        fullStream: (async function* () {
          await options.tools.get_workflow_run.execute({ runDir });
          if (currentRound === 0) {
            await options.tools.run_command.execute({ command: 'printf status-ok > results/status.txt' });
            yield { type: 'text-delta', text: '我先汇报到这里，下一步再继续。' };
            return;
          }
          await options.tools.update_workflow_run.execute({
            runDir,
            status: 'done',
            step: { n: 1, status: 'done', summary: 'status-ok 已写入并验证' },
          });
          yield { type: 'text-delta', text: '流程已经完成。' };
        })(),
      };
    });

    const clusterRun = vi.fn(async (_sid: string, command: string) => {
      if (command.startsWith(`cat '${runDir}/run.json'`)) return JSON.stringify(authoritativeRun);
      const encoded = command.match(/printf %s '([^']+)' \| base64 -d/)?.[1];
      if (encoded) {
        authoritativeRun = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
        return '';
      }
      return 'status-ok';
    });
    const visibleText: string[] = [];
    const dones: string[] = [];

    await runAgent(
      {
        sid: 'session-1', home: '/public/home/u', run: clusterRun,
        workflowRun: { workflowId: 'wf-troubleshoot', runId: 'run-early', runDir, policy: 'isolated-run-v1' },
        profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key' },
      },
      {
        onText: text => visibleText.push(text), onReason: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn(),
        onStep: vi.fn(), onAsk: vi.fn(), onDone: text => dones.push(text), onErr: vi.fn(), sig: () => undefined,
      },
      [{ role: 'user', content: '运行正式排查流程' }],
    );

    expect(mockStreamText).toHaveBeenCalledTimes(2);
    expect(mockStreamText.mock.calls[1][0].messages.at(-1).content).toContain('服务端自动续跑校验');
    expect(visibleText.join('')).toBe('流程已经完成。');
    expect(visibleText.join('')).not.toContain('下一步再继续');
    expect(dones).toEqual(['流程已经完成。']);
    expect(authoritativeRun.status).toBe('done');
  });

  it('reports a real external cancellation instead of an ask sentinel', async () => {
    const controller = new AbortController();
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        await new Promise<void>(resolve => options.abortSignal.addEventListener('abort', () => resolve(), { once: true }));
        throw new Error('aborted');
        yield { type: 'text-delta', text: 'unreachable' };
      })(),
    }));
    const dones: string[] = [];
    const promise = runAgent(
      {
        sid: 'session-1',
        run: vi.fn(),
        profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key' },
      },
      {
        onText: vi.fn(), onReason: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn(), onStep: vi.fn(), onAsk: vi.fn(), onErr: vi.fn(),
        onDone: text => dones.push(text),
        sig: () => controller.signal,
      },
      [{ role: 'user', content: '检查集群' }],
    );
    controller.abort();
    await promise;
    expect(dones).toEqual(['__CANCELLED__']);
  });

  it('hands a submitted batch job to the watcher and ends the Agent turn immediately', async () => {
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        await options.tools.set_plan.execute({
          goal: '提交比对作业',
          steps: [{ title: '运行比对', verification: '检查调度器状态和 BAM' }],
        });
        await options.tools.update_plan_step.execute({ id: '1', status: 'running' });
        await options.tools.run_command.execute({ command: 'bsub -q normal "hisat2 -x ref -U reads.fq"' });
        // 模拟真实供应商忽略 AbortSignal、iterator.next() 永不收尾。
        // runAgent 仍必须在作业交接后立即返回。
        await new Promise<void>(() => {});
        yield { type: 'text-delta', text: '不应继续循环查询' };
      })(),
    }));
    const dones: string[] = [];
    const planStatuses: string[] = [];
    const run = vi.fn().mockResolvedValue('Job <12345> is submitted to queue <normal>.');

    await runAgent(
      {
        sid: 'session-1',
        run,
        profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key' },
      },
      {
        onText: vi.fn(), onReason: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn(), onStep: vi.fn(), onAsk: vi.fn(), onErr: vi.fn(),
        onPlanUpdate: (plan) => planStatuses.push(plan.steps[0].status),
        onDone: text => dones.push(text),
        sig: () => undefined,
      },
      [{ role: 'user', content: '提交比对流程' }],
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(planStatuses).toContain('waiting');
    expect(dones).toEqual([expect.stringContaining('已交给后台监控')]);
    expect(dones[0]).not.toContain('不应继续循环查询');
  });

  it('does not treat an LSF not-found query as a newly submitted job', async () => {
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        await options.tools.set_plan.execute({
          goal: '查询作业',
          steps: [{ title: '查询', verification: '读取 bjobs 输出' }],
        });
        await options.tools.update_plan_step.execute({ id: '1', status: 'running' });
        await options.tools.run_command.execute({ command: 'bjobs -l 12345' });
        yield { type: 'text-delta', text: '该作业不存在。' };
      })(),
    }));
    const toolResults: string[] = [];
    const dones: string[] = [];

    await runAgent(
      {
        sid: 'session-1',
        run: vi.fn().mockResolvedValue('Job <12345> is not found'),
        profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key' },
      },
      {
        onText: vi.fn(), onReason: vi.fn(), onToolCall: vi.fn(), onStep: vi.fn(), onAsk: vi.fn(), onErr: vi.fn(),
        onToolResult: (_name, result) => toolResults.push(result),
        onDone: text => dones.push(text), sig: () => undefined,
      },
      [{ role: 'user', content: '查询 12345' }],
    );

    expect(toolResults.join('\n')).not.toContain('[JOB_SUBMITTED]');
    expect(dones).toEqual([expect.stringContaining('该作业不存在')]);
  });

  it('does not treat reading an old submit receipt as a fresh submission (v0.4.31 root fix)', async () => {
    // 真实事故：AI 执行 cat logs/step-03.submit.txt，输出里的 "Job <75572737> is submitted"
    // 被当成新提交，运行时宣布「交后台监控、本轮结束」——而该作业早已被 bkill，流程假死。
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        await options.tools.set_plan.execute({
          goal: '排查作业',
          steps: [{ title: '读取历史提交记录', verification: 'cat 输出可见' }],
        });
        await options.tools.update_plan_step.execute({ id: '1', status: 'running' });
        await options.tools.run_command.execute({ command: 'cat logs/step-03.submit.txt' });
        await options.tools.update_plan_step.execute({ id: '1', status: 'done', summary: '读完了' });
        yield { type: 'text-delta', text: '这是 9/28 的旧回执，作业已被属主杀掉。' };
      })(),
    }));
    const toolResults: string[] = [];
    const dones: string[] = [];
    const submitted: string[][] = [];

    await runAgent(
      {
        sid: 'session-1',
        run: vi.fn().mockResolvedValue('Job <75572737> is submitted to queue <q2680v2>.'),
        profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key' },
        onJobsSubmitted: ids => submitted.push(ids),
      },
      {
        onText: vi.fn(), onReason: vi.fn(), onToolCall: vi.fn(), onStep: vi.fn(), onAsk: vi.fn(), onErr: vi.fn(),
        onToolResult: (_name, result) => toolResults.push(result),
        onDone: text => dones.push(text), sig: () => undefined,
      },
      [{ role: 'user', content: '看看 step-03 的提交记录' }],
    );

    expect(toolResults.join('\n')).not.toContain('[JOB_SUBMITTED]');
    expect(submitted).toEqual([]);
    expect(dones).toEqual([expect.stringContaining('旧回执')]);
  });

  it('still hands off to the watcher when the command is a real bsub submission', async () => {
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        await options.tools.set_plan.execute({
          goal: '提交作业',
          steps: [{ title: '提交', verification: '拿到作业号' }],
        });
        await options.tools.update_plan_step.execute({ id: '1', status: 'running' });
        await options.tools.run_command.execute({ command: 'bsub < code/step-03.sh' });
        yield { type: 'text-delta', text: '已提交。' };
      })(),
    }));
    const toolResults: string[] = [];
    const dones: string[] = [];

    await runAgent(
      {
        sid: 'session-1',
        run: vi.fn().mockResolvedValue('Job <88888> is submitted to queue <normal>.'),
        profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key' },
      },
      {
        onText: vi.fn(), onReason: vi.fn(), onToolCall: vi.fn(), onStep: vi.fn(), onAsk: vi.fn(), onErr: vi.fn(),
        onToolResult: (_name, result) => toolResults.push(result),
        onDone: text => dones.push(text), sig: () => undefined,
      },
      [{ role: 'user', content: '提交 step-03' }],
    );

    expect(toolResults.join('\n')).toContain('[JOB_SUBMITTED]');
    expect(dones[0]).toContain('88888');
  });

  it('reuses a live job from the shared ledger without issuing a second bsub', async () => {
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        await options.tools.set_plan.execute({
          goal: '恢复提交',
          steps: [{ title: '提交', verification: '拿到作业号' }],
        });
        await options.tools.update_plan_step.execute({ id: '1', status: 'running' });
        await options.tools.run_command.execute({ command: 'bsub < /home/u/run/code/step-04.sh' });
        yield { type: 'text-delta', text: '不应继续' };
      })(),
    }));
    const run = vi.fn().mockResolvedValue('[TRACE_PREFLIGHT] OK');
    const submitted: string[][] = [];
    const dones: string[] = [];
    const guard = {
      prepare: vi.fn(async () => ({
        kind: 'reuse',
        record: { jobIds: ['75598506'] },
        states: { '75598506': 'RUN' },
        reason: 'active',
      })),
      complete: vi.fn(),
      fail: vi.fn(),
    } as any;

    await runAgent(
      {
        sid: 'session-1',
        run,
        profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key' },
        jobSubmissionGuard: guard,
        onJobsSubmitted: ids => submitted.push(ids),
      },
      {
        onText: vi.fn(), onReason: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn(), onStep: vi.fn(), onAsk: vi.fn(), onErr: vi.fn(),
        onDone: text => dones.push(text), sig: () => undefined,
      },
      [{ role: 'user', content: '继续 step-04' }],
    );

    expect(run).toHaveBeenCalledTimes(1); // only deterministic preflight, never bsub
    expect(run.mock.calls[0][1]).toContain('[TRACE_PREFLIGHT]');
    expect(run.mock.calls[0][2]).toBe(20_000);
    expect(submitted).toEqual([['75598506']]);
    expect(dones[0]).toContain('没有重复提交');
  });

  it.each([
    { name: 'missing receipt', result: 'accepted without an id', rejected: false },
    { name: 'SSH timeout', error: 'SSH connection timed out', rejected: false },
    { name: 'definite rejection', error: 'Command exited with code 1: invalid queue', rejected: true },
  ])('classifies native submission $name without enabling a blind retry', async ({ result, error, rejected }) => {
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        await options.tools.set_plan.execute({
          goal: '提交作业', steps: [{ title: '提交', verification: '拿到作业号' }],
        });
        await options.tools.update_plan_step.execute({ id: '1', status: 'running' });
        await options.tools.run_command.execute({ command: 'bsub -q normal "sleep 300"' });
        await options.tools.update_plan_step.execute({ id: '1', status: 'done', summary: '命令结果已分类' });
        yield { type: 'text-delta', text: 'finished' };
      })(),
    }));
    const run = error
      ? vi.fn().mockRejectedValue(new Error(error))
      : vi.fn().mockResolvedValue(result);
    const guard = {
      prepare: vi.fn(async () => ({ kind: 'execute', claim: { key: 'k', claimId: 'c' } })),
      complete: vi.fn(), markUnknown: vi.fn(), fail: vi.fn(),
    } as any;
    const toolResults: string[] = [];
    await runAgent(
      {
        sid: 'session-1', run,
        profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key' },
        jobSubmissionGuard: guard,
      },
      {
        onText: vi.fn(), onReason: vi.fn(), onToolCall: vi.fn(), onStep: vi.fn(), onAsk: vi.fn(), onErr: vi.fn(),
        onToolResult: (_name, value) => toolResults.push(value), onDone: vi.fn(), sig: () => undefined,
      },
      [{ role: 'user', content: '提交作业' }],
    );
    expect(guard.fail).toHaveBeenCalledTimes(rejected ? 1 : 0);
    expect(guard.markUnknown).toHaveBeenCalledTimes(rejected ? 0 : 1);
    expect(toolResults.join('\n')).toContain(rejected ? '尚未提交作业' : '不能盲目重试');
    expect(toolResults.join('\n')).not.toContain('可换个更小的命令重试');
  });

  it('allows an unknown submission retry only after explicit user confirmation', async () => {
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        await options.tools.set_plan.execute({
          goal: '重试作业', steps: [{ title: '重新提交', verification: '核实作业号' }],
        });
        await options.tools.update_plan_step.execute({ id: '1', status: 'running' });
        await options.tools.run_command.execute({ command: 'bsub < code/step-03.sh' });
        yield { type: 'text-delta', text: '已重新提交并核实。' };
      })(),
    }));
    const record = { key: 'k', state: 'unknown', updatedAt: 1, jobIds: [] };
    const claim = { key: 'k', claimId: 'new-claim' };
    const guard = {
      prepare: vi.fn(async () => ({ kind: 'unknown', record })),
      retryUnknown: vi.fn(() => claim), complete: vi.fn(), markUnknown: vi.fn(), fail: vi.fn(),
    } as any;
    const confirmCommand = vi.fn(async () => true);
    const run = vi.fn().mockResolvedValue('Job <12345> is submitted to queue <normal>.');
    await runAgent(
      {
        sid: 'session-1', run, confirmCommand,
        profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key' },
        jobSubmissionGuard: guard,
      },
      {
        onText: vi.fn(), onReason: vi.fn(), onToolCall: vi.fn(), onStep: vi.fn(), onAsk: vi.fn(), onErr: vi.fn(),
        onToolResult: vi.fn(), onDone: vi.fn(), sig: () => undefined,
      },
      [{ role: 'user', content: '已核实未提交，允许重试' }],
    );
    expect(confirmCommand).toHaveBeenCalledOnce();
    expect(guard.retryUnknown).toHaveBeenCalledWith(record);
    expect(guard.complete).toHaveBeenCalledWith(claim, ['12345']);
    // 一次提交前检查 + 一次真实提交，不允许额外盲目重试。
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.at(-1)?.[1]).toBe('bsub < code/step-03.sh');
  });
});

describe('formal workflow command budget', () => {
  const runDir = '/public/home/u/trace_flows/rna/03_workspace/runs/run-budget';

  function setup(
    rounds: (round: number, options: any) => AsyncGenerator<unknown, void, unknown>,
    profile = { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key' },
  ) {
    let authoritativeRun: any = {
      runId: 'run-budget', workflowId: 'wf-rna', workflowName: 'RNA', workflowVersion: 1,
      runDir, workspacePolicy: 'isolated-run-v1', status: 'running', startedAt: 1,
      updatedAt: 1, heartbeatAt: 1, currentStep: 1, totalSteps: 1,
      config: { inputs: [], params: {}, stepParams: {}, referenceOverrides: {}, skippedSteps: [], stepCommandOverrides: {} },
      steps: [{ n: 1, stepId: 'step-01', title: '执行', status: 'running' }],
    };
    let round = 0;
    mockStreamText.mockImplementation((options: any) => {
      const currentRound = round++;
      return { fullStream: (async function* () { yield* rounds(currentRound, options); })() };
    });
    const clusterRun = vi.fn(async (_sid: string, command: string) => {
      if (command.startsWith(`cat '${runDir}/run.json'`)) return JSON.stringify(authoritativeRun);
      const encoded = command.match(/printf %s '([^']+)' \| base64 -d/)?.[1];
      if (encoded) {
        authoritativeRun = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
        return '';
      }
      return 'ok';
    });
    const toolResults: string[] = [];
    const dones: string[] = [];
    const errors: string[] = [];
    const start = () => runAgent(
      {
        sid: 'session-1', home: '/public/home/u', run: clusterRun,
        workflowRun: { workflowId: 'wf-rna', runId: 'run-budget', runDir, policy: 'isolated-run-v1' },
        profile,
      },
      {
        onText: vi.fn(), onReason: vi.fn(), onToolCall: vi.fn(),
        onToolResult: (_name, result) => toolResults.push(result),
        onStep: vi.fn(), onAsk: vi.fn(),
        onDone: text => dones.push(text),
        onErr: err => errors.push(err),
        sig: () => undefined,
      },
      [{ role: 'user', content: '运行正式流程' }],
    );
    const workflowCommands = () => clusterRun.mock.calls.map(call => call[1])
      .filter((command: string) => command.startsWith(`cd '${runDir}'`));
    return { clusterRun, toolResults, dones, errors, start, workflowCommands, getRun: () => authoritativeRun };
  }

  it('passes the user execution profile temperature to streamText in a formal workflow', async () => {
    const env = setup(async function* () {
      yield { type: 'text-delta', text: 'done' };
    }, { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key', temperature: 0.73 });
    await env.start();
    expect(mockStreamText.mock.calls[0][0].temperature).toBe(0.73);
  });

  it('blocks new submissions in the same model round after failed QC, while allowing read-only diagnostics', async () => {
    const env = setup(async function* (_round, options) {
      await options.tools.update_workflow_run.execute({ runDir, step: { n: 1, qc: { status: 'fail', metrics: { FRiP: '0.005' } } } });
      await options.tools.run_command.execute({ command: 'bsub < code/step-01.sh' });
      await options.tools.run_command.execute({ command: 'cat results/qc.tsv' });
      yield { type: 'text-delta', text: 'QC failed; downstream analysis is not recommended.' };
    });
    await env.start();
    expect(env.getRun().status).toBe('waiting_user');
    expect(env.workflowCommands().some(command => command.includes('bsub'))).toBe(false);
    expect(env.workflowCommands().some(command => command.includes('cat results/qc.tsv'))).toBe(true);
    expect(env.toolResults.join('\n')).toContain('Workflow submission blocked');
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });

  it('resets the per-round command budget across auto-continuations', async () => {
    const env = setup(async function* (round, options) {
      if (round === 0) {
        // 第一轮打满 12 条命令预算但不停（第 13 条才会触发）。
        for (let i = 0; i < 12; i++) {
          await options.tools.run_command.execute({ command: `printf ok > results/f${i}.txt` });
        }
        yield { type: 'text-delta', text: '第一轮先汇报到这里。' };
        return;
      }
      // 续跑第二轮预算重置，仍能继续执行命令。
      for (let i = 12; i < 15; i++) {
        await options.tools.run_command.execute({ command: `printf ok > results/f${i}.txt` });
      }
      await options.tools.update_workflow_run.execute({
        runDir, status: 'done',
        step: { n: 1, status: 'done', summary: '全部产物已写入并验证' },
      });
      yield { type: 'text-delta', text: '流程已经完成。' };
    });

    await env.start();

    expect(mockStreamText).toHaveBeenCalledTimes(2);
    expect(mockStreamText.mock.calls[1][0].messages.at(-1).content).toContain('服务端自动续跑校验');
    expect(env.workflowCommands()).toHaveLength(15);
    expect(env.toolResults.join('\n')).not.toContain('safety budget');
    expect(env.errors).toEqual([]);
    expect(env.dones).toEqual(['流程已经完成。']);
    expect(env.getRun().status).toBe('done');
  });

  it('pauses with the existing semantics after the eighth continuation while allowing over 12 commands in total', async () => {
    const env = setup(async function* (round, options) {
      for (let i = 0; i < 4; i++) {
        await options.tools.run_command.execute({ command: `cat results/part-${round}-${i}.txt` });
      }
      yield { type: 'text-delta', text: `第 ${round + 1} 轮先到这里。` };
    });

    await env.start();

    // 初始轮 + 8 次续跑；累计 36 条命令证明没有数值命令上限（只读命令也照常执行）。
    expect(mockStreamText).toHaveBeenCalledTimes(9);
    expect(env.workflowCommands()).toHaveLength(36);
    expect(env.toolResults.join('\n')).not.toContain('safety budget');
    expect(env.errors).toEqual([]);
    expect(env.getRun().status).toBe('waiting_user');
    expect(env.dones).toHaveLength(1);
    expect(env.dones[0]).toContain('本轮安全上限');
    expect(env.dones[0]).toContain('续跑 8 次');
  });

  it('pauses via the stagnation detector when two rounds produce no commands and no run progress', async () => {
    // 模型每轮只说"继续中"但不执行任何命令、run.json 也不推进 → 死循环判定暂停
    const env = setup(async function* (_round, _options) {
      yield { type: 'text-delta', text: '还在继续处理中。' };
    });

    await env.start();

    expect(env.errors).toEqual([]);
    expect(env.getRun().status).toBe('waiting_user');
    expect(env.dones).toHaveLength(1);
    expect(env.dones[0]).toContain('没有新进展');
    expect(env.dones[0]).toContain('死循环保护');
    // 初始轮 + 2 轮停滞即暂停,不会跑到 8 次续跑上限
    expect(mockStreamText.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('keeps the cross-round anti-loop guards global while the budget resets', async () => {
    const env = setup(async function* (round, options) {
      if (round === 0) {
        await options.tools.run_command.execute({ command: 'printf stamp > results/stamp.txt' });
        await options.tools.run_command.execute({ command: 'cat results/stamp.txt' });
        await options.tools.run_command.execute({ command: 'cat results/stamp.txt' });
        yield { type: 'text-delta', text: '第一轮先到这里。' };
        return;
      }
      // 跨轮仍命中“已成功变更不重复执行”。
      await options.tools.run_command.execute({ command: 'printf stamp > results/stamp.txt' });
      // 跨轮仍命中“同命令重复”全局防护。
      await options.tools.run_command.execute({ command: 'cat results/stamp.txt' });
      if (options.abortSignal.aborted) return;
      yield { type: 'text-delta', text: '不应到达。' };
    });

    await env.start();

    expect(mockStreamText).toHaveBeenCalledTimes(2);
    expect(env.toolResults.join('\n')).toContain('already succeeded during the current Agent turn');
    expect(env.dones).toEqual([expect.stringContaining('Agent stopped after repeating the same command')]);
    expect(env.dones[0]).not.toContain('safety budget');
    const stampWrites = env.clusterRun.mock.calls.map(call => call[1])
      .filter((command: string) => command.includes('printf stamp'));
    expect(stampWrites).toHaveLength(1);
  });
});

describe('formal workflow environment repair turn (blocked_env at turn start)', () => {
  // v0.4.25 根因回归：run 以 blocked_env 进入本轮时，停止门不得把“仍是 blocked_env”
  // 当结束信号（修复要多轮），只有 Agent 重新断言 blocked_env 或翻回 running 才收尾。
  const runDir = '/public/home/u/trace_flows/chip/03_workspace/runs/run-repair';

  function setup(rounds: (round: number, options: any) => AsyncGenerator<unknown, void, unknown>) {
    let authoritativeRun: any = {
      runId: 'run-repair', workflowId: 'wf-chip', workflowName: 'ChIP', workflowVersion: 1,
      runDir, workspacePolicy: 'isolated-run-v1', status: 'blocked_env', startedAt: 1,
      updatedAt: 1, heartbeatAt: 1, currentStep: 1, totalSteps: 1,
      error: 'phantompeakqualtools 未就绪',
      config: { inputs: [], params: {}, stepParams: {}, referenceOverrides: {}, skippedSteps: [], stepCommandOverrides: {} },
      steps: [{ n: 1, stepId: 'step-01', title: '预检', status: 'pending' }],
    };
    let round = 0;
    mockStreamText.mockImplementation((options: any) => {
      const currentRound = round++;
      return { fullStream: (async function* () { yield* rounds(currentRound, options); })() };
    });
    const clusterRun = vi.fn(async (_sid: string, command: string) => {
      if (command.startsWith(`cat '${runDir}/run.json'`)) return JSON.stringify(authoritativeRun);
      const encoded = command.match(/printf %s '([^']+)' \| base64 -d/)?.[1];
      if (encoded) {
        authoritativeRun = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
        return '';
      }
      return 'ok';
    });
    const dones: string[] = [];
    const errors: string[] = [];
    const start = () => runAgent(
      {
        sid: 'session-1', home: '/public/home/u', run: clusterRun,
        workflowRun: { workflowId: 'wf-chip', runId: 'run-repair', runDir, policy: 'isolated-run-v1' },
        profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key' },
      },
      {
        onText: vi.fn(), onReason: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn(),
        onStep: vi.fn(), onAsk: vi.fn(),
        onDone: text => dones.push(text),
        onErr: err => errors.push(err),
        sig: () => undefined,
      },
      [{ role: 'user', content: '请直接修复 phantompeakqualtools 并继续流程。' }],
    );
    return { dones, errors, start, getRun: () => authoritativeRun };
  }

  it('auto-continues a repair turn instead of cutting it off after one probing round', async () => {
    const env = setup(async function* (round, options) {
      if (round === 0) {
        // 第一轮只做修复动作，run 仍是 blocked_env——旧逻辑会在这里直接掐断本轮。
        await options.tools.run_command.execute({ command: 'module load R/4.3.2' });
        await options.tools.run_command.execute({ command: 'Rscript -e "install.packages(\'spp\')"' });
        yield { type: 'text-delta', text: '依赖已安装，正在验证。' };
        return;
      }
      // 第二轮验证通过，显式翻回 running 并完成当前步骤，流程自动判 done。
      await options.tools.run_command.execute({ command: 'test -s run_spp.R && echo ready' });
      await options.tools.update_workflow_run.execute({
        runDir, status: 'running', step: { n: 1, status: 'running' },
      });
      await options.tools.update_workflow_run.execute({
        runDir, step: { n: 1, status: 'done', summary: '环境修复并预检通过', evidence: ['test -s run_spp.R -> ready'] },
      });
      yield { type: 'text-delta', text: '环境已修复，流程已完成。' };
    });

    await env.start();

    expect(env.errors).toEqual([]);
    expect(mockStreamText).toHaveBeenCalledTimes(2);
    expect(mockStreamText.mock.calls[1][0].messages.at(-1).content).toContain('环境修复仍在进行');
    expect(env.getRun().status).toBe('done');
    expect(env.dones).toEqual(['环境已修复，流程已完成。']);
    expect(env.dones[0]).not.toContain('已明确暂停');
  });

  it('ends the turn immediately when the agent re-asserts blocked_env with a precise error', async () => {
    const env = setup(async function* (_round, options) {
      await options.tools.run_command.execute({ command: 'timeout 8 curl -sI https://github.com' });
      await options.tools.update_workflow_run.execute({
        runDir, status: 'blocked_env', error: '登录节点无外网，需管理员预装 R 包 spp',
      });
      yield { type: 'text-delta', text: '无法自动修复：登录节点无外网，需管理员预装 R 包 spp。' };
    });

    await env.start();

    expect(env.errors).toEqual([]);
    expect(mockStreamText).toHaveBeenCalledTimes(1);
    expect(env.getRun().status).toBe('blocked_env');
    expect(env.getRun().error).toContain('无外网');
    expect(env.dones).toHaveLength(1);
    expect(env.dones[0]).toContain('无法自动修复');
  });
});

describe('waiting_jobs reconcile on turn start (v0.4.30)', () => {
  // 监控器错过作业终态时 run 永远卡在 waiting_jobs（用户问什么都只收到罐头回复）。
  // 每轮对话开始必须先向调度器核实真实状态，全部终态就翻回 running 继续执行。
  const runDir = '/public/home/u/trace_flows/dap/03_workspace/runs/run-stuck';

  function setup(
    bjobsAnswer: string,
    rounds: (round: number, options: any) => AsyncGenerator<unknown, void, unknown>,
  ) {
    let authoritativeRun: any = {
      runId: 'run-stuck', workflowId: 'wf-dap', workflowName: 'DAP', workflowVersion: 1,
      runDir, workspacePolicy: 'isolated-run-v1', status: 'waiting_jobs', startedAt: 1,
      updatedAt: 1, heartbeatAt: 1, currentStep: 2, totalSteps: 2,
      jobStates: { '12345': 'RUN' },
      config: { inputs: [], params: {}, stepParams: {}, referenceOverrides: {}, skippedSteps: [], stepCommandOverrides: {} },
      steps: [
        { n: 1, stepId: 'step-01', title: '比对', status: 'done', summary: '已完成' },
        { n: 2, stepId: 'step-02', title: '峰调用', status: 'running', jobIds: ['12345'] },
      ],
    };
    let round = 0;
    mockStreamText.mockImplementation((options: any) => {
      const currentRound = round++;
      return { fullStream: (async function* () { yield* rounds(currentRound, options); })() };
    });
    const clusterRun = vi.fn(async (_sid: string, command: string) => {
      if (command.startsWith(`cat '${runDir}/run.json'`)) return JSON.stringify(authoritativeRun);
      const encoded = command.match(/printf %s '([^']+)' \| base64 -d/)?.[1];
      if (encoded) {
        authoritativeRun = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
        return '';
      }
      if (command.includes('bjobs -a') && command.includes('12345')) return bjobsAnswer;
      return 'ok';
    });
    const dones: string[] = [];
    const errors: string[] = [];
    const start = () => runAgent(
      {
        sid: 'session-1', home: '/public/home/u', run: clusterRun, scheduler: 'lsf',
        workflowRun: { workflowId: 'wf-dap', runId: 'run-stuck', runDir, policy: 'isolated-run-v1' },
        profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key' },
      },
      {
        onText: vi.fn(), onReason: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn(),
        onStep: vi.fn(), onAsk: vi.fn(),
        onDone: text => dones.push(text),
        onErr: err => errors.push(err),
        sig: () => undefined,
      },
      [{ role: 'user', content: '现在进展怎么样了？继续吧' }],
    );
    return { dones, errors, start, clusterRun, getRun: () => authoritativeRun };
  }

  it('queries the scheduler for ground truth and resumes instead of replying with the canned waiting message', async () => {
    const env = setup('DONE', async function* (_round, options) {
      // 对账后 run 已翻回 running：执行器验证产物并完成当前步骤
      await options.tools.run_command.execute({ command: 'ls -la peaks/' });
      await options.tools.update_workflow_run.execute({
        runDir, step: { n: 2, status: 'done', summary: '峰文件齐全', evidence: ['ls peaks: 2 个峰文件'] },
      });
      yield { type: 'text-delta', text: '作业其实已完成，流程已收尾。' };
    });

    await env.start();

    expect(env.errors).toEqual([]);
    const commands = env.clusterRun.mock.calls.map(call => call[1]);
    expect(commands.some(c => c.includes('bjobs -a') && c.includes('12345'))).toBe(true);
    expect(env.getRun().status).toBe('done');
    expect(env.dones).toEqual(['作业其实已完成，流程已收尾。']);
    expect(env.dones[0]).not.toContain('后台监控已经接管');
  });

  it('keeps waiting_jobs when the scheduler says the job is still running', async () => {
    const env = setup('RUN', async function* (_round, _options) {
      yield { type: 'text-delta', text: '还在运行。' };
    });

    await env.start();

    expect(env.errors).toEqual([]);
    // 核实过真实状态：作业仍在跑，run 维持 waiting_jobs，不重提不改写
    const commands = env.clusterRun.mock.calls.map(call => call[1]);
    expect(commands.some(c => c.includes('bjobs -a') && c.includes('12345'))).toBe(true);
    expect(env.getRun().status).toBe('waiting_jobs');
    expect(env.getRun().steps[1].status).toBe('running');
    expect(env.dones).toEqual(['还在运行。']);
  });
});

describe('failed run recovery turn (v0.4.34)', () => {
  // run 判 failed 后停止门把它当永久终态：用户说「继续」也只收到罐头句。
  // 修复：failed + 存活作业 → 翻回 waiting_jobs；failed + 全终态 → 恢复轮可多轮续跑。
  const runDir = '/public/home/u/trace_flows/dap/03_workspace/runs/run-failed';

  function setup(
    bjobsAnswer: string,
    rounds: (round: number, options: any) => AsyncGenerator<unknown, void, unknown>,
  ) {
    let authoritativeRun: any = {
      runId: 'run-failed', workflowId: 'wf-dap', workflowName: 'DAP', workflowVersion: 1,
      runDir, workspacePolicy: 'isolated-run-v1', status: 'failed', startedAt: 1,
      updatedAt: 1, heartbeatAt: 1, currentStep: 3, totalSteps: 3, endedAt: 2,
      error: '步骤 3 失败：内存超限',
      jobStates: { '75593097': 'UNKNOWN' },
      config: { inputs: [], params: {}, stepParams: {}, referenceOverrides: {}, skippedSteps: [], stepCommandOverrides: {} },
      steps: [
        { n: 1, stepId: 'step-01', title: '预检', status: 'done', summary: 'ok' },
        { n: 2, stepId: 'step-02', title: 'FastQC', status: 'done', summary: 'ok' },
        { n: 3, stepId: 'step-03', title: '比对', status: 'failed', jobIds: ['75593097'], error: 'OOM' },
      ],
    };
    let round = 0;
    mockStreamText.mockImplementation((options: any) => {
      const currentRound = round++;
      return { fullStream: (async function* () { yield* rounds(currentRound, options); })() };
    });
    const clusterRun = vi.fn(async (_sid: string, command: string) => {
      if (command.startsWith(`cat '${runDir}/run.json'`)) return JSON.stringify(authoritativeRun);
      const encoded = command.match(/printf %s '([^']+)' \| base64 -d/)?.[1];
      if (encoded) {
        authoritativeRun = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
        return '';
      }
      if (command.includes('bjobs -a') && command.includes('75593097')) return bjobsAnswer;
      return 'ok';
    });
    const dones: string[] = [];
    const errors: string[] = [];
    const start = () => runAgent(
      {
        sid: 'session-1', home: '/public/home/u', run: clusterRun, scheduler: 'lsf',
        workflowRun: { workflowId: 'wf-dap', runId: 'run-failed', runDir, policy: 'isolated-run-v1' },
        profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key' },
      },
      {
        onText: vi.fn(), onReason: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn(),
        onStep: vi.fn(), onAsk: vi.fn(),
        onDone: text => dones.push(text),
        onErr: err => errors.push(err),
        sig: () => undefined,
      },
      [{ role: 'user', content: '继续说下去，把失败的步骤跑完' }],
    );
    return { dones, errors, start, clusterRun, getRun: () => authoritativeRun };
  }

  it('flips failed back to waiting_jobs when a resubmitted job is still alive', async () => {
    const env = setup('PEND', async function* (_round, _options) {
      yield { type: 'text-delta', text: '作业在排队。' };
    });

    await env.start();

    expect(env.errors).toEqual([]);
    const commands = env.clusterRun.mock.calls.map(call => call[1]);
    expect(commands.some(c => c.includes('bjobs -a') && c.includes('75593097'))).toBe(true);
    expect(env.getRun().status).toBe('waiting_jobs');
    expect(env.getRun().error).toContain('交还后台监控');
  });

  it('lets a recovery turn run multiple rounds and flip back to running instead of cutting off after one', async () => {
    const env = setup('EXIT', async function* (round, options) {
      if (round === 0) {
        // 第一轮只诊断：读日志、确认原因，run 仍是 failed——旧逻辑会在这里直接掐断
        await options.tools.run_command.execute({ command: 'tail -50 logs/step-03.lsf.out' });
        yield { type: 'text-delta', text: '原因是内存超限，改队列重跑。' };
        return;
      }
      // 第二轮：翻回 running、重跑失败步并以真实产物证据完成
      //（状态机要求 pending→running→done 逐级转换，restartFromStep 后先置 running 再置 done）
      await options.tools.run_command.execute({ command: 'bsub < code/step-03.sh' });
      await options.tools.update_workflow_run.execute({ runDir, status: 'running', restartFromStep: 3 });
      await options.tools.update_workflow_run.execute({ runDir, step: { n: 3, status: 'running' } });
      await options.tools.update_workflow_run.execute({
        runDir, step: { n: 3, status: 'done', summary: '换 smp 队列重跑完成，5 个 BAM 齐全', evidence: ['ls results/bam: 5 个 .sorted.bam 非空'] },
      });
      yield { type: 'text-delta', text: '已换队列重跑并完成第 3 步。' };
    });

    await env.start();

    expect(env.errors).toEqual([]);
    expect(mockStreamText).toHaveBeenCalledTimes(2);
    expect(mockStreamText.mock.calls[1][0].messages.at(-1).content).toContain('失败恢复仍在进行');
    expect(env.getRun().status).toBe('done');
    expect(env.dones[0]).toContain('已换队列重跑并完成');
    expect(env.dones[0]).not.toContain('流程已进入 failed');
  });

  it('ends the turn when the agent re-asserts failed with a precise reason', async () => {
    const env = setup('EXIT', async function* (_round, options) {
      await options.tools.run_command.execute({ command: 'tail -50 logs/step-03.lsf.out' });
      await options.tools.update_workflow_run.execute({
        runDir, status: 'failed', error: '参考基因组索引损坏，需要管理员重建',
      });
      yield { type: 'text-delta', text: '无法自动恢复：索引损坏。' };
    });

    await env.start();

    expect(env.errors).toEqual([]);
    expect(mockStreamText).toHaveBeenCalledTimes(1);
    expect(env.getRun().status).toBe('failed');
    expect(env.getRun().error).toContain('索引损坏');
    expect(env.dones).toEqual(['无法自动恢复：索引损坏。']);
  });
});

describe('web API tools (search_web_apis / call_web_api)', () => {
  const ctx = {
    sid: 'session-1',
    run: vi.fn(),
    profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key' },
  } as const;
  const cbs = (toolResults: string[]) => ({
    onText: vi.fn(),
    onReason: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: (_name: string, result: string) => toolResults.push(result),
    onStep: vi.fn(),
    onAsk: vi.fn(),
    onDone: vi.fn(),
    onErr: vi.fn(),
    sig: () => undefined,
  });

  beforeEach(() => {
    mockInvokeWebApi.mockReset();
    mockSearchWebApis.mockReset();
  });

  it('documents the public data APIs in the system prompt', () => {
    const prompt = buildAgentSystemPrompt(normalizeAgentRuntimeConfig({}), false);
    expect(prompt).toContain('search_web_apis');
    expect(prompt).toContain('call_web_api');
    expect(prompt).toContain('PUBLIC DATA APIS');
    expect(prompt).toContain('标注来源');
  });

  it('keeps the native prompt close to the less rigid 0.2.9 behavior', () => {
    const prompt = buildAgentSystemPrompt(normalizeAgentRuntimeConfig({}), false);
    expect(prompt).not.toContain('TASK SIZING');
    expect(prompt).not.toContain('AGENT DISCIPLINE');
    expect(prompt).not.toContain('智能体质量契约');
    expect(prompt).toContain('SAFETY & TRUST');
    expect(prompt).toContain('INTENT');
    const localZh = buildLocalWorkspacePromptSection('D:\\ws', 'zh-CN');
    expect(localZh).toContain('任务分级');
    expect(localZh).toContain('不要写校验脚本');
    const localEn = buildLocalWorkspacePromptSection('D:\\ws', 'en-US');
    expect(localEn).toContain('Task sizing');
  });

  it('registers both tools for the general agent alongside the existing ones', async () => {
    let capturedTools: any;
    mockStreamText.mockImplementation((options: any) => {
      capturedTools = options.tools;
      return { fullStream: (async function* () { /* no stream parts */ })() };
    });
    await runAgent(ctx as any, cbs([]) as any, [{ role: 'user', content: '查一下 BRCA1 的 UniProt 条目' }]);
    expect(capturedTools.search_web_apis).toBeTruthy();
    expect(capturedTools.call_web_api).toBeTruthy();
    expect(capturedTools.run_command).toBeTruthy();
    expect(capturedTools.search_web).toBeTruthy();
  });

  it('search_web_apis returns formatted service summaries', async () => {
    mockSearchWebApis.mockReturnValue({
      query: 'uniprot',
      total: 1,
      services: [{
        id: 'uniprot',
        name: 'UniProtKB REST',
        category: 'proteins',
        categoryLabel: { zh: '蛋白与结构', en: 'Proteins' },
        description: 'UniProt 蛋白知识库',
        homepage: 'https://www.uniprot.org/',
        docsUrl: 'https://www.uniprot.org/help/programmatic_access',
        endpoints: [{ id: 'entry', name: '按登录号取条目', method: 'GET', path: '/uniprotkb/{accession}', description: '按 UniProt 登录号取完整蛋白条目' }],
      }],
    });
    let payload = '';
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        payload = await options.tools.search_web_apis.execute({ query: 'uniprot' });
      })(),
    }));
    await runAgent(ctx as any, cbs([]) as any, [{ role: 'user', content: 'x' }]);
    expect(mockSearchWebApis).toHaveBeenCalledWith('uniprot', undefined);
    expect(payload).toContain('uniprot');
    expect(payload).toContain('entry[GET /uniprotkb/{accession}]');
  });

  it('call_web_api chains into invokeWebApi and clips large payloads', async () => {
    mockInvokeWebApi.mockResolvedValue({
      ok: true,
      service: 'uniprot',
      endpoint: 'entry',
      url: 'https://rest.uniprot.org/uniprotkb/P69905',
      status: 200,
      durationMs: 12,
      contentType: 'application/json',
      truncated: false,
      data: { accession: 'P69905' },
    });
    let payload = '';
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        payload = await options.tools.call_web_api.execute({
          service: 'uniprot', endpoint: 'entry', params: { accession: 'P69905' },
        });
      })(),
    }));
    await runAgent(ctx as any, cbs([]) as any, [{ role: 'user', content: 'x' }]);
    expect(mockInvokeWebApi).toHaveBeenCalledWith('uniprot', 'entry', { accession: 'P69905' });
    expect(payload).toContain('P69905');
    expect(payload).toContain('"status":200');
  });

  it('call_web_api surfaces invoke errors as plain messages', async () => {
    mockInvokeWebApi.mockResolvedValue({
      ok: false,
      error: { code: 'http_client_error', message: '上游返回 4xx：HTTP 400' },
    });
    const toolResults: string[] = [];
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        await options.tools.call_web_api.execute({ service: 'uniprot', endpoint: 'entry', params: {} });
      })(),
    }));
    await runAgent(ctx as any, cbs(toolResults) as any, [{ role: 'user', content: 'x' }]);
    expect(toolResults.at(-1)).toContain('数据服务调用失败（http_client_error）');
  });

  it('search_web_apis output includes per-endpoint param names so the model does not guess', async () => {
    mockSearchWebApis.mockReturnValue({
      query: 'uniprot',
      total: 1,
      services: [{
        id: 'uniprot',
        name: 'UniProtKB REST',
        category: 'proteins',
        categoryLabel: { zh: '蛋白与结构', en: 'Proteins' },
        description: 'UniProt 蛋白知识库',
        homepage: 'https://www.uniprot.org/',
        docsUrl: 'https://www.uniprot.org/help/programmatic_access',
        endpoints: [{
          id: 'search', name: '蛋白检索', method: 'GET', path: '/uniprotkb/search', description: '按查询语法检索',
          params: [{ name: 'query', required: true, description: '查询式' }, { name: 'size', description: '条数' }],
        }],
      }],
    });
    let payload = '';
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        payload = await options.tools.search_web_apis.execute({ query: 'uniprot' });
      })(),
    }));
    await runAgent(ctx as any, cbs([]) as any, [{ role: 'user', content: 'x' }]);
    expect(payload).toContain('参数: query（必填）、size');
    expect(payload).toContain('不要猜参数名');
  });

  it('identical call_web_api invocations in one turn hit the cache instead of re-calling', async () => {
    mockInvokeWebApi.mockResolvedValue({
      ok: true, service: 'uniprot', endpoint: 'entry', url: 'https://rest.uniprot.org/uniprotkb/P69905',
      status: 200, durationMs: 12, contentType: 'application/json', truncated: false, data: { accession: 'P69905' },
    });
    let first = '';
    let second = '';
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        first = await options.tools.call_web_api.execute({ service: 'uniprot', endpoint: 'entry', params: { accession: 'P69905' } });
        second = await options.tools.call_web_api.execute({ service: 'uniprot', endpoint: 'entry', params: { accession: 'P69905' } });
      })(),
    }));
    await runAgent(ctx as any, cbs([]) as any, [{ role: 'user', content: 'x' }]);
    expect(mockInvokeWebApi).toHaveBeenCalledTimes(1);
    expect(second).toContain('缓存复用');
    expect(second).toContain('P69905');
  });

  it('search_web_apis identical queries in one turn hit the cache', async () => {
    mockSearchWebApis.mockReturnValue({ query: 'uniprot', total: 0, services: [] });
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        await options.tools.search_web_apis.execute({ query: 'uniprot' });
        await options.tools.search_web_apis.execute({ query: 'uniprot' });
      })(),
    }));
    await runAgent(ctx as any, cbs([]) as any, [{ role: 'user', content: 'x' }]);
    expect(mockSearchWebApis).toHaveBeenCalledTimes(1);
  });
});

describe('ported dsh tools (cluster_fs / wheatomics_query / github_mirror_scout)', () => {
  const toolResults: string[] = [];
  const cbs = {
    onText: vi.fn(),
    onReason: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: (_name: string, result: string) => toolResults.push(result),
    onStep: vi.fn(),
    onAsk: vi.fn(),
    onDone: vi.fn(),
    onErr: vi.fn(),
    sig: () => undefined,
  };

  const makeFakeSftp = (overrides: Record<string, unknown> = {}) => {
    const state = { written: '' };
    const sftp = {
      readdir: (_p: string, cb: any) => cb(null, [
        { filename: 'sub', longname: 'drwxr-xr-x 2 u g 4096 Jan  1  2025 sub', attrs: { size: 4096, mtime: 0, mode: 0o040755 } },
        { filename: 'a.txt', longname: '-rw-r--r-- 1 u g 5 Jan  1  2025 a.txt', attrs: { size: 5, mtime: 0, mode: 0o100644 } },
      ]),
      stat: vi.fn((_p: string, cb: any) => cb(null, { size: 5, mtime: 0, mode: 0o100644 })),
      lstat: (_p: string, cb: any) => cb(null, { size: 5, mtime: 0, mode: 0o100644 }),
      createReadStream: () => Readable.from([Buffer.from('hello')]),
      createWriteStream: () => new Writable({
        write(chunk: Buffer, _enc: string, done: () => void) { state.written += chunk.toString(); done(); },
      }),
      fastPut: vi.fn((_l: string, _r: string, cb: any) => cb(null)),
      fastGet: vi.fn((_r: string, _l: string, cb: any) => cb(null)),
      ...overrides,
    };
    return { sftp, state };
  };

  const clusterCtx = (sftp: any, overrides: Record<string, unknown> = {}) => ({
    sid: 'session-1',
    run: vi.fn(async () => ''),
    getSftp: () => sftp,
    home: '/home/u',
    profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key' },
    ...overrides,
  });

  const runWithTools = async (ctx: any, invoke: (tools: any) => Promise<void>) => {
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        await invoke(options.tools);
      })(),
    }));
    await runAgent(ctx as any, cbs as any, [{ role: 'user', content: 'x' }]);
  };

  beforeEach(() => {
    toolResults.length = 0;
  });

  it('documents the ported tools in the TOOLS section of the system prompt', () => {
    const prompt = buildAgentSystemPrompt(normalizeAgentRuntimeConfig({}), false);
    expect(prompt).toContain('cluster_fs');
    expect(prompt).toContain('wheatomics_query');
    expect(prompt).toContain('github_mirror_scout');
  });

  it('registers the three tools only when a cluster home is present', async () => {
    const captured: any[] = [];
    mockStreamText.mockImplementation((options: any) => {
      captured.push(options.tools);
      return { fullStream: (async function* () { /* no stream parts */ })() };
    });
    const { sftp } = makeFakeSftp();
    await runAgent(clusterCtx(sftp) as any, cbs as any, [{ role: 'user', content: 'x' }]);
    // 无 HOME 的调用方（如 QQ bot）：三个移植工具一律不挂。
    await runAgent(
      { sid: 'qq-bot', run: vi.fn(), profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'k' } } as any,
      cbs as any,
      [{ role: 'user', content: 'x' }],
    );
    expect(Object.keys(captured[0])).toEqual(expect.arrayContaining(['cluster_fs', 'wheatomics_query', 'github_mirror_scout']));
    expect(Object.keys(captured[1])).not.toContain('cluster_fs');
    expect(Object.keys(captured[1])).not.toContain('wheatomics_query');
    expect(Object.keys(captured[1])).not.toContain('github_mirror_scout');
  });

  it('cluster_fs list formats directory entries like the dsh render', async () => {
    const { sftp } = makeFakeSftp();
    await runWithTools(clusterCtx(sftp), async (tools) => {
      const result = await tools.cluster_fs.execute({ action: 'list', path: '/home/u/data' });
      expect(result).toContain('/home/u/data (2 entries)');
      expect(result).toContain('directory');
      expect(result).toContain('sub');
      expect(result).toContain('a.txt');
    });
  });

  it('cluster_fs read returns file content and flags server-side truncation', async () => {
    const { sftp } = makeFakeSftp();
    await runWithTools(clusterCtx(sftp), async (tools) => {
      const full = await tools.cluster_fs.execute({ action: 'read', path: '/home/u/a.txt' });
      expect(full).toBe('hello');
      const capped = await tools.cluster_fs.execute({ action: 'read', path: '/home/u/a.txt', maxBytes: 3 });
      expect(capped).toContain('hel');
      expect(capped).toContain('...[truncated by server]');
    });
  });

  it('cluster_fs write requires confirmation under state_changes and writes via SFTP once approved', async () => {
    const { sftp, state } = makeFakeSftp();
    const confirmCommand = vi.fn(async () => true);
    const ctx = clusterCtx(sftp, { confirmCommand, runtimeConfig: { confirmationPolicy: 'state_changes' as const } });
    await runWithTools(ctx, async (tools) => {
      const result = await tools.cluster_fs.execute({ action: 'write', path: '/home/u/scripts/step.sh', content: 'echo hi' });
      expect(result).toBe('wrote 7 bytes to /home/u/scripts/step.sh');
    });
    expect(confirmCommand).toHaveBeenCalledWith(
      'cluster_fs write /home/u/scripts/step.sh',
      expect.objectContaining({ risk: 'write' }),
    );
    expect(state.written).toBe('echo hi');
  });

  it('cluster_fs write does not prompt under the default dangerous policy but still enforces the home guard', async () => {
    const { sftp, state } = makeFakeSftp();
    const confirmCommand = vi.fn(async () => true);
    await runWithTools(clusterCtx(sftp, { confirmCommand }), async (tools) => {
      const result = await tools.cluster_fs.execute({ action: 'write', path: '/home/u/ok.txt', content: 'x' });
      expect(result).toBe('wrote 1 bytes to /home/u/ok.txt');
      const escaped = await tools.cluster_fs.execute({ action: 'write', path: '/etc/evil.sh', content: 'x' });
      expect(escaped).toContain('cluster_fs write failed');
      expect(escaped).toContain('outside the authorized root');
      const escapedRead = await tools.cluster_fs.execute({ action: 'read', path: '/etc/passwd' });
      expect(escapedRead).toContain('outside the authorized root');
    });
    // 默认 dangerous 策略：write 级操作与 run_command 一致，不额外打扰用户。
    expect(confirmCommand).not.toHaveBeenCalled();
    expect(state.written).toBe('x');
  });

  it('cluster_fs write stops without executing when confirmation is rejected', async () => {
    const { sftp, state } = makeFakeSftp();
    const confirmCommand = vi.fn(async () => false);
    const ctx = clusterCtx(sftp, { confirmCommand, runtimeConfig: { confirmationPolicy: 'every_command' as const } });
    await runWithTools(ctx, async (tools) => {
      const result = await tools.cluster_fs.execute({ action: 'write', path: '/home/u/a.txt', content: 'nope' });
      expect(result).toContain('not authorized');
    });
    expect(state.written).toBe('');
  });

  it('cluster_fs reports sftp_not_ready honestly instead of retrying', async () => {
    const ctx = clusterCtx(null, { getSftp: () => { throw new Error('SFTP is not ready'); } });
    await runWithTools(ctx, async (tools) => {
      const result = await tools.cluster_fs.execute({ action: 'list', path: '/home/u' });
      expect(result).toContain('sftp_not_ready');
    });
  });

  it('cluster_fs push uploads a workspace file and refuses paths outside the workspaces', async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-agent-fs-')));
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-agent-fs-out-')));
    try {
      fs.writeFileSync(path.join(tmp, 'in.txt'), 'LOCAL');
      fs.writeFileSync(path.join(outside, 'evil.txt'), 'NOPE');
      const { sftp } = makeFakeSftp();
      await runWithTools(clusterCtx(sftp, { workspaces: [tmp] }), async (tools) => {
        const result = await tools.cluster_fs.execute({ action: 'push', path: '/home/u/in.txt', destPath: path.join(tmp, 'in.txt') });
        expect(result).toContain('pushed');
        expect(result).toContain('-> /home/u/in.txt (5 bytes)');
        const escaped = await tools.cluster_fs.execute({ action: 'push', path: '/home/u/evil.txt', destPath: path.join(outside, 'evil.txt') });
        expect(escaped).toContain('outside the selected workspace');
      });
      expect(sftp.fastPut).toHaveBeenCalledTimes(1);
      expect((sftp.fastPut as any).mock.calls[0][1]).toBe('/home/u/in.txt');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('cluster_fs push explains the missing local workspace instead of guessing a local root', async () => {
    const { sftp } = makeFakeSftp();
    await runWithTools(clusterCtx(sftp), async (tools) => {
      const result = await tools.cluster_fs.execute({ action: 'push', path: '/home/u/in.txt', destPath: 'D:\\nowhere\\in.txt' });
      expect(result).toContain('no_local_workspace');
    });
    expect(sftp.fastPut).not.toHaveBeenCalled();
  });

  it('cluster_fs pull refuses to overwrite an existing local file unless overwrite=true', async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-agent-fs-')));
    try {
      fs.writeFileSync(path.join(tmp, 'out.txt'), 'OLD');
      const { sftp } = makeFakeSftp();
      await runWithTools(clusterCtx(sftp, { workspaces: [tmp] }), async (tools) => {
        const refused = await tools.cluster_fs.execute({ action: 'pull', path: '/home/u/a.txt', destPath: path.join(tmp, 'out.txt') });
        expect(refused).toContain('already exists');
        expect(sftp.fastGet).not.toHaveBeenCalled();
        const pulled = await tools.cluster_fs.execute({ action: 'pull', path: '/home/u/a.txt', destPath: path.join(tmp, 'out.txt'), overwrite: true });
        expect(pulled).toContain('pulled /home/u/a.txt ->');
        expect(sftp.fastGet).toHaveBeenCalledTimes(1);
        const escaped = await tools.cluster_fs.execute({ action: 'pull', path: '/etc/passwd', destPath: path.join(tmp, 'p.txt'), overwrite: true });
        expect(escaped).toContain('outside the authorized root');
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('wheatomics_query runs the bundled CLI with subcommand args and returns stdout', async () => {
    mockSpawn.mockImplementation(() => makeFakeChild('VRN1 cloned gene record', '', 0));
    const { sftp } = makeFakeSftp();
    await runWithTools(clusterCtx(sftp, { skillsDir: appPath('skills') }), async (tools) => {
      const result = await tools.wheatomics_query.execute({ subcommand: 'known-search', args: ['VRN1'] });
      expect(result).toContain('VRN1 cloned gene record');
    });
    expect(mockSpawn).toHaveBeenCalledWith('python', [
      expect.stringContaining(path.join('wheatomics-query', 'scripts', 'wheatomics.py')),
      'known-search',
      'VRN1',
    ], expect.anything());
  });

  it('wheatomics_query surfaces non-zero exits in the dsh render format', async () => {
    mockSpawn.mockImplementation(() => makeFakeChild('partial', 'boom', 2));
    const { sftp } = makeFakeSftp();
    await runWithTools(clusterCtx(sftp, { skillsDir: appPath('skills') }), async (tools) => {
      const result = await tools.wheatomics_query.execute({ subcommand: 'known-gene', args: ['X'] });
      expect(result).toContain('wheatomics_query exited with code 2');
      expect(result).toContain('stderr: boom');
      expect(result).toContain('stdout: partial');
    });
  });

  it('wheatomics_query reports honestly when the bundled script is missing', async () => {
    const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-agent-noskills-')));
    try {
      const { sftp } = makeFakeSftp();
      const ctx = clusterCtx(sftp, { skillsDir: empty, userSkillsDir: empty, lsfSkillDir: empty });
      await runWithTools(ctx, async (tools) => {
        const result = await tools.wheatomics_query.execute({ subcommand: 'health' });
        expect(result).toContain('不可用');
        expect(result).toContain('wheatomics.py');
      });
      expect(mockSpawn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('github_mirror_scout always prepends --github and defaults to top 5', async () => {
    mockSpawn.mockImplementation(() => makeFakeChild('1. https://ghproxy.net 12.3 MB/s', '', 0));
    const { sftp } = makeFakeSftp();
    await runWithTools(clusterCtx(sftp, { skillsDir: appPath('skills') }), async (tools) => {
      const result = await tools.github_mirror_scout.execute({});
      expect(result).toContain('ghproxy.net');
      await tools.github_mirror_scout.execute({ args: ['--top', '3'] });
    });
    expect(mockSpawn).toHaveBeenNthCalledWith(1, 'python', [
      expect.stringContaining(path.join('github-mirror', 'scripts', 'mirror-scout.py')),
      '--github', '--top', '5',
    ], expect.anything());
    expect(mockSpawn).toHaveBeenNthCalledWith(2, 'python', [
      expect.stringContaining(path.join('github-mirror', 'scripts', 'mirror-scout.py')),
      '--github', '--top', '3',
    ], expect.anything());
  });
});

describe('local mode (no cluster session)', () => {
  let tmpWorkspace = '';

  beforeEach(() => {
    tmpWorkspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-agent-local-')));
  });

  afterEach(() => {
    if (tmpWorkspace) fs.rmSync(tmpWorkspace, { recursive: true, force: true });
    tmpWorkspace = '';
  });

  const localCtx = (workspace?: string, confirmCommand?: ReturnType<typeof vi.fn>) => ({
    sid: 'local-workspace',
    run: vi.fn(),
    profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key' },
    localOnly: true,
    workspace,
    confirmCommand,
    runtimeConfig: { pathPolicy: 'scoped' as const },
  });

  const localCbs = (toolResults: string[]) => ({
    onText: vi.fn(),
    onReason: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: (_name: string, result: string) => toolResults.push(result),
    onStep: vi.fn(),
    onAsk: vi.fn(),
    onDone: vi.fn(),
    onErr: vi.fn(),
    sig: () => undefined,
  });

  it('exposes the local workspace toolset instead of cluster tools and documents the constraints', async () => {
    let capturedTools: any;
    let capturedSystem = '';
    mockStreamText.mockImplementation((options: any) => {
      capturedTools = options.tools;
      capturedSystem = options.system;
      return { fullStream: (async function* () { /* no stream parts */ })() };
    });

    await runAgent(localCtx(tmpWorkspace) as any, localCbs([]) as any, [{ role: 'user', content: '分析我的本地文件' }]);

    expect(Object.keys(capturedTools).sort()).toEqual([
      'ask_user',
      'call_web_api',
      'list_local_files',
      'read_local_file',
      'reset_plan',
      'run_local_command',
      'search_skills',
      'search_web_apis',
      'set_plan',
      'update_plan_step',
      'write_local_file',
    ]);
    // 集群工具一律不可用
    expect(capturedTools.run_command).toBeUndefined();
    expect(capturedTools.get_workflow_run).toBeUndefined();
    expect(capturedTools.save_skill).toBeUndefined();
    // 系统提示含本地工作区约束段与真实工作区路径
    expect(capturedSystem).toContain('LOCAL MODE');
    expect(capturedSystem).toContain(tmpWorkspace);
    expect(capturedSystem).toContain('已配置工作区根目录');
    expect(capturedSystem).toContain('write_local_file');
  });

  it('write_local_file creates a new file, then refuses to overwrite it', async () => {
    const toolResults: string[] = [];
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        const first = await options.tools.write_local_file.execute({ path: 'result.txt', content: 'alpha' });
        expect(first).toContain('已写入本地文件');
        const second = await options.tools.write_local_file.execute({ path: 'result.txt', content: 'beta' });
        expect(second).toContain('文件已存在，不允许覆盖');
      })(),
    }));

    await runAgent(localCtx(tmpWorkspace) as any, localCbs(toolResults) as any, [{ role: 'user', content: '写入分析结果' }]);

    expect(fs.readFileSync(path.join(tmpWorkspace, 'result.txt'), 'utf8')).toBe('alpha');
    expect(toolResults.some(result => result.includes('文件已存在，不允许覆盖'))).toBe(true);
  });

  it('full access can select another configured root, overwrite files, and clean task outputs without prompting', async () => {
    const secondWorkspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-agent-local-second-')));
    const confirmCommand = vi.fn();
    fs.writeFileSync(path.join(secondWorkspace, 'result.txt'), 'old');
    fs.writeFileSync(path.join(secondWorkspace, 'cleanup.txt'), 'remove me');
    try {
      mockStreamText.mockImplementation((options: any) => ({
        fullStream: (async function* () {
          const writeResult = await options.tools.write_local_file.execute({
            workspace: secondWorkspace, path: 'result.txt', content: 'new',
          });
          expect(writeResult).toContain(secondWorkspace);
          const cleanupCommand = process.platform === 'win32' ? 'del /q cleanup.txt' : 'rm -f cleanup.txt';
          const cleanupResult = await options.tools.run_local_command.execute({
            workspace: secondWorkspace, command: cleanupCommand,
          });
          expect(cleanupResult).toContain('命令执行成功');
        })(),
      }));

      await runAgent({
        ...localCtx(tmpWorkspace, confirmCommand),
        workspaces: [tmpWorkspace, secondWorkspace],
        runtimeConfig: { pathPolicy: 'full_access' as const, confirmationPolicy: 'never' as const },
      } as any, localCbs([]) as any, [{ role: 'user', content: '覆盖结果并清理旧文件' }]);

      expect(fs.readFileSync(path.join(secondWorkspace, 'result.txt'), 'utf8')).toBe('new');
      expect(fs.existsSync(path.join(secondWorkspace, 'cleanup.txt'))).toBe(false);
      expect(confirmCommand).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(secondWorkspace, { recursive: true, force: true });
    }
  });

  it('write_local_file rejects escape paths outside the workspace', async () => {
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        const escaped = await options.tools.write_local_file.execute({ path: '../evil.txt', content: 'x' });
        expect(escaped).toContain('路径不允许包含 ..');
      })(),
    }));

    await runAgent(localCtx(tmpWorkspace) as any, localCbs([]) as any, [{ role: 'user', content: 'x' }]);

    expect(fs.existsSync(path.join(tmpWorkspace, '..', 'evil.txt'))).toBe(false);
  });

  it('every local tool returns the workspace-required guidance when no workspace is set', async () => {
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        expect(await options.tools.list_local_files.execute({})).toBe(LOCAL_WORKSPACE_NOT_SET_MESSAGE);
        expect(await options.tools.read_local_file.execute({ path: 'a.txt' })).toBe(LOCAL_WORKSPACE_NOT_SET_MESSAGE);
        expect(await options.tools.write_local_file.execute({ path: 'a.txt', content: 'x' })).toBe(LOCAL_WORKSPACE_NOT_SET_MESSAGE);
        expect(await options.tools.run_local_command.execute({ command: 'dir' })).toBe(LOCAL_WORKSPACE_NOT_SET_MESSAGE);
      })(),
    }));

    await runAgent(localCtx(undefined) as any, localCbs([]) as any, [{ role: 'user', content: '看看本地文件' }]);
  });

  it('run_local_command executes inside the workspace and reports output', async () => {
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        const result = await options.tools.run_local_command.execute({ command: 'node -e "console.log(40+2)"' });
        expect(result).toContain('命令执行成功');
        expect(result).toContain('42');
      })(),
    }));

    await runAgent(localCtx(tmpWorkspace) as any, localCbs([]) as any, [{ role: 'user', content: '算个数' }]);
  });

  it('run_local_command hard-rejects blacklisted commands without asking for confirmation', async () => {
    const confirmCommand = vi.fn();
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        const result = await options.tools.run_local_command.execute({ command: 'rm -rf data' });
        expect(result).toContain('黑名单');
      })(),
    }));

    await runAgent(localCtx(tmpWorkspace, confirmCommand) as any, localCbs([]) as any, [{ role: 'user', content: '删掉数据' }]);

    // 黑名单是硬拒绝：不该走到用户确认环节
    expect(confirmCommand).not.toHaveBeenCalled();
  });

  it('buildLocalWorkspacePromptSection renders both locales', () => {
    const zh = buildLocalWorkspacePromptSection('D:\data', 'zh-CN');
    expect(zh).toContain('D:\data');
    expect(zh).toContain('完全路径权限下允许覆盖已有文件');
    const en = buildLocalWorkspacePromptSection(undefined, 'en-US');
    expect(en).toContain('(not set)');
    expect(en).toContain('existing files may be overwritten');
  });
});


describe('plan review gate', () => {
  const makePlan = (titles: string[]) => ({
    goal: '测试计划',
    steps: titles.map((title, index) => ({
      id: String(index + 1), title, verification: `验证 ${title}`, status: 'pending' as const,
    })),
    createdAt: 1,
    updatedAt: 1,
  });

  it('auto policy reviews plans with 3+ steps or job/write-like steps only', () => {
    expect(planNeedsReview(makePlan(['读目录', '看日志']), 'auto')).toBe(false);
    expect(planNeedsReview(makePlan(['读目录', '看日志', '汇总']), 'auto')).toBe(true);
    expect(planNeedsReview(makePlan(['提交 fastqc 作业']), 'auto')).toBe(true);
    expect(planNeedsReview(makePlan(['写入 step-01.sh 脚本']), 'auto')).toBe(true);
    expect(planNeedsReview(makePlan(['查看目录']), 'always')).toBe(true);
  });

  const reviewCtx = (reviewPlan: (plan: any) => Promise<any>, runtimeConfig?: Record<string, unknown>) => ({
    sid: 'session-1',
    run: vi.fn(),
    profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key' },
    reviewPlan,
    runtimeConfig,
  });
  const reviewCbs = (collected: { plans: any[]; dones: string[]; toolResults: string[] }) => ({
    onText: vi.fn(),
    onReason: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: (_name: string, result: string) => collected.toolResults.push(result),
    onStep: vi.fn(),
    onAsk: vi.fn(),
    onPlan: (plan: any) => collected.plans.push(plan),
    onPlanUpdate: vi.fn(),
    onDone: (text: string) => collected.dones.push(text),
    onErr: vi.fn(),
    sig: () => undefined,
  });
  const twoRiskySteps = [
    { title: '生成并提交 bsub 作业', verification: '调度器返回 Job ID' },
    { title: '核实输出文件', verification: '结果文件存在且非空' },
  ];

  it('approve continues with the original plan', async () => {
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        const created = await options.tools.set_plan.execute({ goal: '质控', steps: twoRiskySteps });
        expect(created).toContain('经用户批准');
        await options.tools.update_plan_step.execute({ id: '1', status: 'running' });
        await options.tools.update_plan_step.execute({ id: '1', status: 'done', summary: '已提交 12345' });
        await options.tools.update_plan_step.execute({ id: '2', status: 'running' });
        await options.tools.update_plan_step.execute({ id: '2', status: 'done', summary: 'fastqc.html 存在' });
        yield { type: 'text-delta', text: '已完成。' };
      })(),
    }));
    const reviewPlan = vi.fn(async (plan: any) => ({ action: 'approve' as const, reason: 'approved' as const }));
    const collected = { plans: [] as any[], dones: [] as string[], toolResults: [] as string[] };
    await runAgent(reviewCtx(reviewPlan) as any, reviewCbs(collected) as any, [{ role: 'user', content: '跑质控' }]);
    expect(reviewPlan).toHaveBeenCalledTimes(1);
    expect(reviewPlan.mock.calls[0][0].steps).toHaveLength(2);
    expect(collected.dones[0]).toContain('已完成');
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });

  it('edit replaces the plan steps with the user-edited ones', async () => {
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        const created = await options.tools.set_plan.execute({ goal: '质控', steps: twoRiskySteps });
        expect(created).toContain('修改后批准');
        await options.tools.update_plan_step.execute({ id: '1', status: 'running' });
        await options.tools.update_plan_step.execute({ id: '1', status: 'done', summary: '只看了一个目录' });
        yield { type: 'text-delta', text: '按修改后的计划完成。' };
      })(),
    }));
    const reviewPlan = vi.fn(async () => ({
      action: 'edit' as const,
      reason: 'edited' as const,
      steps: [{ title: '只查看目录', verification: 'ls 输出可见' }],
    }));
    const collected = { plans: [] as any[], dones: [] as string[], toolResults: [] as string[] };
    await runAgent(reviewCtx(reviewPlan) as any, reviewCbs(collected) as any, [{ role: 'user', content: '跑质控' }]);
    // 第一次 onPlan 是原始计划，第二次是用户编辑后的计划
    expect(collected.plans).toHaveLength(2);
    expect(collected.plans[1].steps).toEqual([
      expect.objectContaining({ id: '1', title: '只查看目录', verification: 'ls 输出可见' }),
    ]);
    expect(collected.dones[0]).toContain('按修改后的计划完成');
  });

  it('cancel marks the plan cancelled and ends the turn without executing', async () => {
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        const created = await options.tools.set_plan.execute({ goal: '质控', steps: twoRiskySteps });
        expect(created).toContain('已取消');
        yield { type: 'text-delta', text: '不应继续执行。' };
      })(),
    }));
    const reviewPlan = vi.fn(async () => ({ action: 'cancel' as const, reason: 'cancelled' as const }));
    const collected = { plans: [] as any[], dones: [] as string[], toolResults: [] as string[] };
    await runAgent(reviewCtx(reviewPlan) as any, reviewCbs(collected) as any, [{ role: 'user', content: '跑质控' }]);
    expect(collected.plans.at(-1)?.status).toBe('cancelled');
    expect(collected.dones[0]).toContain('计划已被用户取消');
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });

  it('pauses the turn (without cancelling the plan) when the review is unanswered', async () => {
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        const created = await options.tools.set_plan.execute({ goal: '质控', steps: twoRiskySteps });
        expect(created).toContain('审批未确认');
        yield { type: 'text-delta', text: 'x' };
      })(),
    }));
    const reviewPlan = vi.fn(async () => null); // 超时/断线：不是用户拒绝
    const collected = { plans: [] as any[], dones: [] as string[], toolResults: [] as string[] };
    await runAgent(reviewCtx(reviewPlan) as any, reviewCbs(collected) as any, [{ role: 'user', content: '跑质控' }]);
    expect(collected.plans.at(-1)?.status).not.toBe('cancelled');
    expect(collected.dones[0]).toContain('审批未确认');
  });

  it('skips review for small read-only plans under auto, and for formal workflows', async () => {
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        const created = await options.tools.set_plan.execute({
          goal: '看一眼', steps: [{ title: '读取日志', verification: '看到日志末尾' }],
        });
        expect(created).toContain('计划已创建');
        expect(created).not.toContain('批准');
        await options.tools.update_plan_step.execute({ id: '1', status: 'running' });
        await options.tools.update_plan_step.execute({ id: '1', status: 'done', summary: '日志已读' });
        yield { type: 'text-delta', text: '看完。' };
      })(),
    }));
    const reviewPlan = vi.fn(async () => ({ action: 'approve' as const, reason: 'approved' as const }));
    const collected = { plans: [] as any[], dones: [] as string[], toolResults: [] as string[] };
    await runAgent(reviewCtx(reviewPlan, { planReview: 'auto' }) as any, reviewCbs(collected) as any, [{ role: 'user', content: '看日志' }]);
    expect(reviewPlan).not.toHaveBeenCalled();
  });

  it('always policy reviews even a single read-only step', async () => {
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        const created = await options.tools.set_plan.execute({
          goal: '看一眼', steps: [{ title: '读取日志', verification: '看到日志末尾' }],
        });
        expect(created).toContain('经用户批准');
        await options.tools.update_plan_step.execute({ id: '1', status: 'running' });
        await options.tools.update_plan_step.execute({ id: '1', status: 'done', summary: '日志已读' });
        yield { type: 'text-delta', text: '看完。' };
      })(),
    }));
    const reviewPlan = vi.fn(async () => ({ action: 'approve' as const, reason: 'approved' as const }));
    const collected = { plans: [] as any[], dones: [] as string[], toolResults: [] as string[] };
    await runAgent(reviewCtx(reviewPlan, { planReview: 'always' }) as any, reviewCbs(collected) as any, [{ role: 'user', content: '看日志' }]);
    expect(reviewPlan).toHaveBeenCalledTimes(1);
  });

  it('documents plan approval in the chat-mode system prompt only', () => {
    const prompt = buildAgentSystemPrompt(normalizeAgentRuntimeConfig({}), false);
    expect(prompt).toContain('计划会先交给用户审批');
    const workflowPrompt = buildAgentSystemPrompt(normalizeAgentRuntimeConfig({}), true);
    expect(workflowPrompt).not.toContain('计划会先交给用户审批');
  });
});

describe('steering injection', () => {
  const baseCtx = (steer?: { take: () => string[] }) => ({
    sid: 'session-1',
    run: vi.fn(),
    profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key' },
    steer,
  });

  it('prepareStep injects queued steer text as the latest user message with a system note', async () => {
    let consumed = false;
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        const step = await options.prepareStep({
          messages: [{ role: 'user', content: '原始任务' }],
          stepNumber: 1, steps: [], model: undefined, experimental_context: undefined,
        });
        expect(step.messages.at(-2).role).toBe('system');
        expect(step.messages.at(-2).content).toContain('插话');
        expect(step.messages.at(-1)).toEqual({ role: 'user', content: '先别 bsub，改看日志' });
        expect(options.allowSystemInMessages).toBe(true);
        yield { type: 'text-delta', text: '收到，先看日志。' };
      })(),
    }));
    const onSteer = vi.fn();
    const steer = { take: () => (consumed ? [] : (consumed = true, ['先别 bsub，改看日志'])) };
    const onDone = vi.fn();
    await runAgent(
      baseCtx(steer) as any,
      { onText: vi.fn(), onReason: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn(), onStep: vi.fn(), onAsk: vi.fn(), onSteer, onDone, onErr: vi.fn(), sig: () => undefined } as any,
      [{ role: 'user', content: '原始任务' }],
    );
    expect(onSteer).toHaveBeenCalledWith(['先别 bsub，改看日志']);
    expect(onDone).toHaveBeenCalledWith('收到，先看日志。');
  });

  it('prepareStep returns undefined when the queue is empty, and is absent without a steer channel', async () => {
    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        const step = await options.prepareStep({ messages: [], stepNumber: 0, steps: [], model: undefined, experimental_context: undefined });
        expect(step).toBeUndefined();
        yield { type: 'text-delta', text: '正常回复' };
      })(),
    }));
    const onSteer = vi.fn();
    await runAgent(
      baseCtx({ take: () => [] }) as any,
      { onText: vi.fn(), onReason: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn(), onStep: vi.fn(), onAsk: vi.fn(), onSteer, onDone: vi.fn(), onErr: vi.fn(), sig: () => undefined } as any,
      [{ role: 'user', content: 'x' }],
    );
    expect(onSteer).not.toHaveBeenCalled();

    mockStreamText.mockImplementation((options: any) => ({
      fullStream: (async function* () {
        expect(options.prepareStep).toBeUndefined();
        yield { type: 'text-delta', text: '无插话通道' };
      })(),
    }));
    await runAgent(
      baseCtx() as any,
      { onText: vi.fn(), onReason: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn(), onStep: vi.fn(), onAsk: vi.fn(), onDone: vi.fn(), onErr: vi.fn(), sig: () => undefined } as any,
      [{ role: 'user', content: 'x' }],
    );
  });
});
