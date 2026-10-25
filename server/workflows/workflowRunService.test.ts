import { describe, expect, it } from 'vitest';
import {
  assertWorkflowStepTransition,
  buildWorkflowRunSummary,
  buildWorkflowStepScript,
  createWorkflowRun,
  readWorkflowRun,
  resolveWorkflowRunDir,
  sanitizeRunConfig,
  workflowStepScriptPath,
  updateWorkflowRun,
  reconcileWorkflowRunWithScheduler,
} from './workflowRunService';
import type { WorkflowRun } from '../../shared/workflowRun';
import type { Workflow } from './workflowTypes';
import { needsAutomaticOutputReview } from './runAnnotate';

describe('workflowRunService', () => {
  it('hands each job off as waiting_jobs and progresses three steps from completion events without another user request', async () => {
    const runDir = '/home/u/trace_flows/wf/03_workspace/runs/r1';
    let stored: WorkflowRun = {
      runId: 'r1', workflowId: 'wf', workflowName: 'Test', workflowVersion: 1, revision: 1,
      runDir, status: 'running', startedAt: 1, updatedAt: 1, heartbeatAt: 1,
      currentStep: 1, totalSteps: 3,
      config: sanitizeRunConfig({}),
      steps: [1, 2, 3].map(n => ({ n, stepId: 's' + n, title: 'Step ' + n, status: 'pending' })),
    };
    const exec = async (command: string) => {
      if (command.startsWith(`cat '${runDir}/run.json'`)) return JSON.stringify(stored);
      const encoded = command.match(/printf %s '([^']+)' \| base64 -d/)?.[1];
      if (encoded && command.includes('/run.json')) stored = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      return '';
    };
    for (const n of [1, 2, 3]) {
      const submitted = await updateWorkflowRun(exec, '/home/u', runDir, {
        status: 'waiting_jobs', step: { n, status: 'running', jobIds: [String(100 + n)] },
      });
      expect(submitted.status).toBe('waiting_jobs'); // Regression: step.running used to overwrite this.
      const finished = await reconcileWorkflowRunWithScheduler(exec, '/home/u', runDir, new Map([[String(100 + n), 'DONE']]));
      expect(needsAutomaticOutputReview(finished)).toBe(true);
      expect(finished.steps[n - 1].status).toBe('running'); // No false QC success from scheduler DONE.
      await updateWorkflowRun(exec, '/home/u', runDir, {
        status: 'running', step: { n, status: 'done', summary: 'Output checked', evidence: ['results/log.txt'], qc: { status: 'pass' } },
      });
    }
    expect(stored.status).toBe('done');
    expect(stored.steps.every(step => step.status === 'done')).toBe(true);
  });
  it('续跑对账链路可放宽 SSH 超时：read/reconcile/update 透传自定义超时，默认不变', async () => {
    const runDir = '/home/u/trace_flows/wf/03_workspace/runs/r-timeout';
    let stored: WorkflowRun = {
      runId: 'r-timeout', workflowId: 'wf', workflowName: 'T', workflowVersion: 1, revision: 1,
      runDir, status: 'waiting_jobs', startedAt: 1, updatedAt: 1, heartbeatAt: 1,
      currentStep: 1, totalSteps: 1,
      config: sanitizeRunConfig({}),
      steps: [{ n: 1, stepId: 's1', title: 'S', status: 'running', jobIds: ['42'] }],
    };
    const seen: Array<{ command: string; timeout?: number }> = [];
    const exec = async (command: string, timeout?: number) => {
      seen.push({ command, timeout });
      if (command.startsWith(`cat '${runDir}/run.json'`)) return JSON.stringify(stored);
      const encoded = command.match(/printf %s '([^']+)' \| base64 -d/)?.[1];
      if (encoded && command.includes('/run.json')) stored = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      return '';
    };

    await readWorkflowRun(exec, '/home/u', runDir, 90_000);
    expect(seen[seen.length - 1].timeout).toBe(90_000);
    await readWorkflowRun(exec, '/home/u', runDir);
    expect(seen[seen.length - 1].timeout).toBe(15_000); // 默认 15s 不变

    await reconcileWorkflowRunWithScheduler(exec, '/home/u', runDir, new Map([['42', 'DONE']]), { readTimeoutMs: 90_000, writeTimeoutMs: 90_000 });
    expect(seen[seen.length - 2].timeout).toBe(90_000); // reconcile 内部读
    expect(seen[seen.length - 1].timeout).toBe(90_000); // reconcile 内部写
    expect(stored.status).toBe('waiting_user'); // DONE → 等待 Agent 验收

    const updated = await updateWorkflowRun(exec, '/home/u', runDir, { error: '等待调度器核实其余 1 个作业状态' }, { readTimeoutMs: 90_000, writeTimeoutMs: 90_000 });
    expect(seen[seen.length - 2].timeout).toBe(90_000);
    expect(seen[seen.length - 1].timeout).toBe(90_000);
    expect(updated.error).toContain('等待调度器核实');
  });

  it('只允许流程运行工作区路径', () => {    const home = '/public/home/u';
    expect(resolveWorkflowRunDir(home, '~/trace_flows/rna/03_workspace/runs/r1'))
      .toBe('/public/home/u/trace_flows/rna/03_workspace/runs/r1');
    expect(resolveWorkflowRunDir(home, '/public/home/u/trace_flows/rna/03_workspace/runs/r1'))
      .toBe('/public/home/u/trace_flows/rna/03_workspace/runs/r1');
    expect(resolveWorkflowRunDir(home, '/public/home/u/trace_flows/rna/04_results/r1')).toBeNull();
    expect(resolveWorkflowRunDir(home, '~/trace_flows/../../etc')).toBeNull();
  });

  it('清洗运行配置并保留步骤参数', () => {
    expect(sanitizeRunConfig({
      inputs: ['/data/a', '', '/data/b'],
      params: { THREADS: 8, QUEUE: 'normal' },
      stepParams: { 1: { Q: 30 }, bad: { X: 1 } },
      referenceOverrides: { GTF: '/ref/a.gtf' },
      skippedSteps: [2, 2, '3', -1],
      stepCommandOverrides: { 1: 'echo custom', bad: 'ignore' },
    })).toEqual({
      inputs: ['/data/a', '/data/b'],
      params: { THREADS: '8', QUEUE: 'normal' },
      stepParams: { 1: { Q: '30' } },
      referenceOverrides: { GTF: '/ref/a.gtf' },
      skippedSteps: [2, 3],
      stepCommandOverrides: { 1: 'echo custom' },
    });
  });

  it('强制步骤按运行状态机推进', () => {
    expect(() => assertWorkflowStepTransition('pending', 'running')).not.toThrow();
    expect(() => assertWorkflowStepTransition('running', 'done')).not.toThrow();
    expect(() => assertWorkflowStepTransition('pending', 'done')).toThrow('非法流程步骤状态转换');
    expect(() => assertWorkflowStepTransition('done', 'running')).toThrow('非法流程步骤状态转换');
  });

  it('为每个步骤生成固定、可编辑的代码路径并渲染本次参数', () => {
    const workflow: Workflow = {
      id: 'wf-code', name: 'RNA 流程', description: '', keywords: [],
      params: [],
      steps: [
        { title: '质控', command: 'fastqc {{INPUT_DIR}} -t {{THREADS}}' },
        { title: '比对', command: 'STAR --genomeDir {{INDEX}}' },
      ],
      source: 'user', createdAt: 1, updatedAt: 1,
    };
    const config = sanitizeRunConfig({
      inputs: ['/data/reads'],
      params: { THREADS: 8 },
      referenceOverrides: { INDEX: '/ref/star' },
      stepCommandOverrides: { 1: 'fastqc {{INPUT_DIR}} --threads {{THREADS}}' },
    });
    const runDir = '/public/home/u/trace_flows/rna/03_workspace/runs/run-1';
    expect(workflowStepScriptPath(runDir, 1)).toBe(`${runDir}/code/step-01.sh`);
    const script = buildWorkflowStepScript(workflow, config, 1, runDir);
    expect(script).toContain('步骤 1/2：质控');
    expect(script).toContain('fastqc /data/reads --threads 8');
    expect(script).toContain('可以在流程面板中查看和修改');
    expect(script).not.toContain('TRACE_REVIEW_REQUIRED');
  });

  it('把 LSF 指令放在首个 shell 命令之前，确保 bsub 能读取资源参数', () => {
    const workflow: Workflow = {
      id: 'wf-lsf', name: 'LSF 流程', description: '', keywords: [], params: [],
      steps: [{ title: '集群计算', command: '#BSUB -J test_job\n#BSUB -n {{THREADS}}\n#BSUB -q {{QUEUE}}\necho run' }],
      source: 'user', createdAt: 1, updatedAt: 1,
    };
    const script = buildWorkflowStepScript(
      workflow,
      sanitizeRunConfig({ params: { THREADS: 8, QUEUE: 'normal' } }),
      1,
      '/home/u/trace_flows/w/03_workspace/runs/r1',
    );
    expect(script.indexOf('#BSUB -J test_job')).toBeLessThan(script.indexOf('set -eo pipefail'));
    expect(script.match(/#BSUB -J test_job/g)).toHaveLength(1);
    expect(script).toContain('#BSUB -n 8');
    expect(script).toContain('#BSUB -q normal');
  });

  it('未补齐的占位参数会在步骤脚本中明确标记需要确认', () => {
    const workflow: Workflow = {
      id: 'wf-review', name: '流程', description: '', keywords: [], params: [],
      steps: [{ title: '定量', command: 'kallisto quant -i {{INDEX}} {{READS}}' }],
      source: 'user', createdAt: 1, updatedAt: 1,
    };
    const script = buildWorkflowStepScript(workflow, sanitizeRunConfig({}), 1, '/home/u/trace_flows/w/03_workspace/runs/r1');
    expect(script).toContain('TRACE_REVIEW_REQUIRED');
    expect(script).toContain('INDEX, READS');
  });

  it('创建 RUN 时一次性建立 code 目录、README 和全部步骤脚本', async () => {
    const workflow: Workflow = {
      id: 'wf-create', name: '创建代码目录', description: '', keywords: [], params: [],
      steps: [{ title: '步骤一', command: 'echo one' }, { title: '步骤二', command: 'echo two' }],
      source: 'user', createdAt: 1, updatedAt: 1,
    };
    const exec = async (command: string) => {
      expect(command).toContain('/code');
      expect(command).toContain('/code/README.md');
      expect(command).toContain('/code/step-01.sh');
      expect(command).toContain('/code/step-02.sh');
      expect(command).toContain('chmod u+x');
      return '';
    };
    const run = await createWorkflowRun(exec, '/home/u', workflow, {}, true);
    expect(run.codeDir).toBe(`${run.runDir}/code`);
    expect(run.steps.map(step => step.scriptPath)).toEqual([
      `${run.runDir}/code/step-01.sh`,
      `${run.runDir}/code/step-02.sh`,
    ]);
  });

  it('从运行证据生成不消耗模型 Token 的报告', () => {
    const run = {
      runId: 'r1', workflowId: 'wf', workflowName: 'RNA 流程', workflowVersion: 1,
      revision: 2, runDir: '/home/u/trace_flows/rna/03_workspace/runs/r1',
      status: 'done', startedAt: 1, updatedAt: 2, endedAt: 2, heartbeatAt: 2,
      currentStep: 1, totalSteps: 1,
      config: { inputs: [], params: {}, stepParams: {}, referenceOverrides: {}, skippedSteps: [], stepCommandOverrides: {} },
      steps: [{ n: 1, stepId: 's1', title: '质控', status: 'done', summary: 'reads 通过质控', outputs: ['results/qc.html'], qc: { status: 'pass' } }],
    } satisfies WorkflowRun;
    const report = buildWorkflowRunSummary(run);
    expect(report).toContain('# RNA 流程 — 运行报告');
    expect(report).toContain('reads 通过质控');
    expect(report).toContain('results/qc.html');
    expect(report).toContain('不额外调用 AI 模型');
  });

  it('用户要求重跑时原子重置目标步骤及后续步骤，并保留已有脚本', async () => {
    const runDir = '/home/u/trace_flows/rna/03_workspace/runs/rerun-1';
    let stored = {
      runId: 'rerun-1', workflowId: 'wf-rna', workflowName: 'RNA', workflowVersion: 1,
      revision: 4, runDir, workspacePolicy: 'isolated-run-v1' as const,
      status: 'done' as const, startedAt: 1, updatedAt: 2, endedAt: 2, heartbeatAt: 2,
      currentStep: 4, totalSteps: 4,
      config: { inputs: ['/data/rna'], params: {}, stepParams: {}, referenceOverrides: {}, skippedSteps: [], stepCommandOverrides: {} },
      steps: [
        { n: 1, stepId: 's1', title: 'QC', status: 'done' as const, summary: 'ok', evidence: ['qc'] },
        { n: 2, stepId: 's2', title: '比对', status: 'done' as const, summary: 'old', evidence: ['job'], jobIds: ['123'], scriptPath: `${runDir}/code/step-02.sh`, submittedScriptHash: 'abc' },
        { n: 3, stepId: 's3', title: '定量', status: 'done' as const, summary: 'old', evidence: ['out'], outputs: ['old.txt'] },
        { n: 4, stepId: 's4', title: '报告', status: 'done' as const, summary: 'old', evidence: ['report'] },
      ],
      jobStates: { '123': 'DONE' }, reportPath: `${runDir}/results/run-summary.md`,
    } satisfies WorkflowRun;
    const exec = async (command: string) => {
      if (command.startsWith(`cat '${runDir}/run.json'`)) return JSON.stringify(stored);
      if (command.includes('bjobs -a')) return 'DONE';
      const encoded = command.match(/printf %s '([^']+)' \| base64 -d/)?.[1];
      if (encoded) stored = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      return '';
    };

    const restarted = await updateWorkflowRun(exec, '/home/u', runDir, { restartFromStep: 2 }, { scheduler: 'lsf' });

    expect(restarted.status).toBe('running');
    expect(restarted.currentStep).toBe(2);
    expect(restarted.steps[0].status).toBe('done');
    expect(restarted.steps.slice(1).map(step => step.status)).toEqual(['pending', 'pending', 'pending']);
    expect(restarted.steps[1].scriptPath).toBe(`${runDir}/code/step-02.sh`);
    expect(restarted.steps[1].jobIds).toBeUndefined();
    expect(restarted.steps[1].submittedScriptHash).toBeUndefined();
    expect(restarted.jobStates).toEqual({});
    expect(restarted.reportPath).toBeUndefined();
    expect(restarted.endedAt).toBeUndefined();
  });

  it('RUN/PEND/UNKNOWN 作业禁止重跑且不清空任何状态', async () => {
    for (const schedulerState of ['RUN', 'PEND', 'UNKNOWN'] as const) {
      const runDir = `/home/u/trace_flows/wf/03_workspace/runs/reject-${schedulerState}`;
      const stored = {
        runId: 'r', workflowId: 'wf', workflowName: 'W', workflowVersion: 1, revision: 1,
        runDir, status: 'running', startedAt: 1, updatedAt: 1, heartbeatAt: 1,
        currentStep: 1, totalSteps: 1, config: sanitizeRunConfig({}),
        steps: [{ n: 1, stepId: 's1', title: 'S', status: 'running', jobIds: ['123'], summary: 'keep' }],
        jobStates: { '123': schedulerState },
      } satisfies WorkflowRun;
      const before = JSON.stringify(stored);
      const exec = async (command: string) => {
        if (command.startsWith(`cat '${runDir}/run.json'`)) return JSON.stringify(stored);
        if (command.includes('bjobs -a')) return schedulerState === 'UNKNOWN' ? '' : schedulerState;
        throw new Error('状态拒绝后不应写入');
      };
      await expect(updateWorkflowRun(exec, '/home/u', runDir, { restartFromStep: 1 }, { scheduler: 'lsf' }))
        .rejects.toThrow('RUN/PEND/UNKNOWN');
      expect(JSON.stringify(stored)).toBe(before);
    }
  });

  it('重跑涉及作业但未传 scheduler 时 fail closed', async () => {
    const runDir = '/home/u/trace_flows/wf/03_workspace/runs/no-scheduler';
    const stored = {
      runId: 'r', workflowId: 'wf', workflowName: 'W', workflowVersion: 1, revision: 1,
      runDir, status: 'done', startedAt: 1, updatedAt: 1, heartbeatAt: 1,
      currentStep: 1, totalSteps: 1, config: sanitizeRunConfig({}),
      steps: [{ n: 1, stepId: 's1', title: 'S', status: 'done', jobIds: ['123'], summary: 'keep' }],
    } satisfies WorkflowRun;
    const exec = async () => JSON.stringify(stored);
    await expect(updateWorkflowRun(exec, '/home/u', runDir, { restartFromStep: 1 }))
      .rejects.toThrow('当前调度器无法核实');
    expect(stored.steps[0].status).toBe('done');
  });

  it('取消前核实全部作业，活跃时拒绝，全部终态后才标记 cancelled', async () => {
    const runDir = '/home/u/trace_flows/wf/03_workspace/runs/cancel-1';
    let secondState = 'RUN';
    const stored = {
      runId: 'r', workflowId: 'wf', workflowName: 'W', workflowVersion: 1, revision: 1,
      runDir, status: 'running', startedAt: 1, updatedAt: 1, heartbeatAt: 1,
      currentStep: 2, totalSteps: 2, config: sanitizeRunConfig({}),
      steps: [
        { n: 1, stepId: 's1', title: 'S1', status: 'done', jobIds: ['123'], summary: 'done' },
        { n: 2, stepId: 's2', title: 'S2', status: 'running', jobIds: ['456'] },
      ],
    } satisfies WorkflowRun;
    const exec = async (command: string) => {
      if (command.startsWith(`cat '${runDir}/run.json'`)) return JSON.stringify(stored);
      if (command.includes('bjobs -a') && command.includes(' 123 ')) return 'DONE';
      if (command.includes('bjobs -a') && command.includes(' 456 ')) return secondState;
      const encoded = command.match(/printf %s '([^']+)' \| base64 -d/)?.[1];
      if (encoded) Object.assign(stored, JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')));
      return '';
    };
    await expect(updateWorkflowRun(exec, '/home/u', runDir, { status: 'cancelled' }, { scheduler: 'lsf' }))
      .rejects.toThrow('456=RUN');
    expect(stored.status).toBe('running');
    secondState = 'EXIT';
    const cancelled = await updateWorkflowRun(exec, '/home/u', runDir, { status: 'cancelled' }, { scheduler: 'lsf' });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.steps[1].status).toBe('running');
  });

  it('DAG 分支只等待声明的依赖，不被无关的前序步骤阻塞', async () => {
    const runDir = '/home/u/trace_flows/dag/03_workspace/runs/dag-1';
    let stored = {
      runId: 'dag-1', workflowId: 'wf-dag', workflowName: 'DAG', workflowVersion: 1,
      revision: 1, runDir, workspacePolicy: 'isolated-run-v1' as const,
      status: 'running' as const, startedAt: 1, updatedAt: 1, heartbeatAt: 1,
      currentStep: 2, totalSteps: 4,
      config: { inputs: [], params: {}, stepParams: {}, referenceOverrides: {}, skippedSteps: [], stepCommandOverrides: {} },
      steps: [
        { n: 1, stepId: 'prepare', dependsOn: [], title: '准备', status: 'done' as const, summary: 'ready', evidence: ['log'] },
        { n: 2, stepId: 'star', dependsOn: ['prepare'], title: 'STAR', status: 'pending' as const },
        { n: 3, stepId: 'kallisto', dependsOn: ['prepare'], title: 'Kallisto', status: 'pending' as const },
        { n: 4, stepId: 'report', dependsOn: ['star', 'kallisto'], title: '报告', status: 'pending' as const },
      ],
    } satisfies WorkflowRun;
    const exec = async (command: string) => {
      if (command.startsWith(`cat '${runDir}/run.json'`)) return JSON.stringify(stored);
      const encoded = command.match(/printf %s '([^']+)' \| base64 -d/)?.[1];
      if (encoded) stored = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      return '';
    };

    const branch = await updateWorkflowRun(exec, '/home/u', runDir, { step: { n: 3, status: 'running' } });
    expect(branch.steps[1].status).toBe('pending');
    expect(branch.steps[2].status).toBe('running');
    await expect(updateWorkflowRun(exec, '/home/u', runDir, { step: { n: 4, status: 'running' } }))
      .rejects.toThrow('前置步骤 2（STAR）尚未完成');
  });
});
