import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addBindings,
  extractSubmittedJobIds,
  getBinding,
  initJobAgentBindings,
  isSubmissionCommand,
  listBindings,
  markResumed,
  removeBinding,
  type JobBindingContext,
} from './jobAgentBindings';

let tmpDir = '';

function makeCtx(overrides: Partial<JobBindingContext> = {}): JobBindingContext {
  return {
    sshSessionId: 'ssh-1',
    conversationKey: 'conv-key-1',
    dshSessionId: 'dsh-sess-1',
    conversationId: 'conv-1',
    workspace: '/data/work',
    profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'k' },
    locale: 'zh-CN',
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-bindings-test-'));
  initJobAgentBindings(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('extractSubmittedJobIds', () => {
  it('registers a new child job without inheriting the parent job ID or resume count', () => {
    const parent = { ...makeCtx(), jobId: '100', resumeCount: 2, submittedAt: 1 };
    addBindings(['101'], parent);
    expect(getBinding('101', 'ssh-1')).toMatchObject({ jobId: '101', resumeCount: 0 });
    expect(getBinding('100', 'ssh-1')).toBeUndefined();
  });
  it('extracts LSF, Slurm, PBS and conservative Donau submit receipts', () => {
    expect(extractSubmittedJobIds('Job <424242> is submitted to queue <normal>.')).toEqual(['424242']);
    expect(extractSubmittedJobIds('Submitted batch job 7890')).toEqual(['7890']);
    expect(extractSubmittedJobIds('Job <123.4> is submitted to default queue.')).toEqual(['123.4']);
    expect(extractSubmittedJobIds('12345.pbs01.example\n')).toEqual(['12345.pbs01.example']);
    expect(extractSubmittedJobIds('jobId: 2048\n')).toEqual(['2048']);
    expect(extractSubmittedJobIds('JobId = 4096')).toEqual(['4096']);
  });

  it('does not match unrelated output', () => {
    expect(extractSubmittedJobIds('Job <123> is not found')).toEqual([]);
    expect(extractSubmittedJobIds('bjobs: no unfinished job found')).toEqual([]);
    expect(extractSubmittedJobIds('')).toEqual([]);
    expect(extractSubmittedJobIds('total 0\ndrwxr-xr-x 2 u g 4096 Jan 1 .')).toEqual([]);
    expect(extractSubmittedJobIds('previous jobId: 123\njobId: not-a-number\n2048')).toEqual([]);
    expect(extractSubmittedJobIds('12345.pbs01.example extra-columns')).toEqual([]);
  });

  it('dedupes and preserves first-appearance order across both patterns', () => {
    const text = [
      'Submitted batch job 555',
      'Job <111> is submitted to queue <normal>.',
      'Job <111> is submitted to queue <normal>.',
      'Submitted batch job 222',
    ].join('\n');
    expect(extractSubmittedJobIds(text)).toEqual(['555', '111', '222']);
  });
});

describe('isSubmissionCommand（v0.4.31：只有提交命令的输出才可信）', () => {
  it('bsub/sbatch/qsub/dsub -s 判定为提交命令', () => {
    expect(isSubmissionCommand('bsub < code/step-03.sh')).toBe(true);
    expect(isSubmissionCommand('sbatch run.slurm')).toBe(true);
    expect(isSubmissionCommand('cd /x && qsub job.pbs')).toBe(true);
    expect(isSubmissionCommand('chmod +x step.dsub && dsub -s step.dsub')).toBe(true);
    expect(isSubmissionCommand('dsub -q arm -aa -s step.dsub')).toBe(true);
    expect(isSubmissionCommand('dsub step.dsub')).toBe(false);
    expect(isSubmissionCommand('djob -s 123')).toBe(false);
  });

  it('读日志/查状态/普通命令不判定为提交', () => {
    expect(isSubmissionCommand('cat logs/step-03.submit.txt')).toBe(false);
    expect(isSubmissionCommand('bjobs -l 75572737')).toBe(false);
    expect(isSubmissionCommand('bhist -l 75572737')).toBe(false);
    expect(isSubmissionCommand('echo "bsub 是提交命令"')).toBe(true); // 边界：含 bsub 字样的 echo 也放行——其输出不含真实回执格式
    expect(isSubmissionCommand('')).toBe(false);
  });
});

describe('jobAgentBindings store', () => {
  it('adds, reads and removes bindings', () => {
    expect(addBindings(['123', '456'], makeCtx())).toBe(2);

    const binding = getBinding('123', 'ssh-1');
    expect(binding).toMatchObject({
      jobId: '123',
      sshSessionId: 'ssh-1',
      conversationKey: 'conv-key-1',
      dshSessionId: 'dsh-sess-1',
      conversationId: 'conv-1',
      resumeCount: 0,
    });
    expect(typeof binding?.submittedAt).toBe('number');
    expect(listBindings()).toHaveLength(2);

    expect(removeBinding('123', 'ssh-1')).toBe(true);
    expect(getBinding('123', 'ssh-1')).toBeUndefined();
    expect(removeBinding('123', 'ssh-1')).toBe(false);
    expect(listBindings()).toHaveLength(1);
  });

  it('dedupes by jobId+sshSessionId, refreshing context without resetting resumeCount', () => {
    expect(addBindings(['123'], makeCtx())).toBe(1);
    markResumed('123', 'ssh-1');
    const before = getBinding('123', 'ssh-1')!;

    expect(addBindings(['123'], makeCtx({ conversationKey: 'conv-key-2', dshSessionId: 'dsh-sess-2' }))).toBe(0);

    const after = getBinding('123', 'ssh-1')!;
    expect(after.conversationKey).toBe('conv-key-2');
    expect(after.dshSessionId).toBe('dsh-sess-2');
    expect(after.resumeCount).toBe(1);
    expect(after.submittedAt).toBe(before.submittedAt);

    // 同一作业号在另一个 SSH 会话下算新绑定
    expect(addBindings(['123'], makeCtx({ sshSessionId: 'ssh-2' }))).toBe(1);
    expect(listBindings()).toHaveLength(2);
  });

  it('persists to disk and reloads after re-init', () => {
    addBindings(['123'], makeCtx());
    markResumed('123', 'ssh-1');
    markResumed('123', 'ssh-1');

    initJobAgentBindings(tmpDir); // 强制从文件重读
    expect(getBinding('123', 'ssh-1')?.resumeCount).toBe(2);

    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'job-agent-bindings.json'), 'utf8'));
    expect(raw).toHaveLength(1);
    expect(raw[0].jobId).toBe('123');
  });

  it('evicts the oldest bindings beyond the 200 entry LRU cap', () => {
    for (let i = 0; i < 205; i += 1) {
      addBindings([`job-${i}`], makeCtx());
    }
    const all = listBindings();
    expect(all).toHaveLength(200);
    expect(getBinding('job-0', 'ssh-1')).toBeUndefined();
    expect(getBinding('job-4', 'ssh-1')).toBeUndefined();
    expect(getBinding('job-5', 'ssh-1')).toBeDefined();
    expect(getBinding('job-204', 'ssh-1')).toBeDefined();
  });

  it('tolerates a corrupted store file', () => {
    fs.writeFileSync(path.join(tmpDir, 'job-agent-bindings.json'), '{broken json', 'utf8');
    initJobAgentBindings(tmpDir);
    expect(listBindings()).toEqual([]);
    expect(addBindings(['1'], makeCtx())).toBe(1);
    expect(listBindings()).toHaveLength(1);
  });

  it('stores the engine marker and refreshes it on rebind', () => {
    // legacy(内置)引擎绑定：dshSessionId 为空串，engine='legacy'
    expect(addBindings(['123'], makeCtx({ dshSessionId: '', engine: 'legacy' }))).toBe(1);
    expect(getBinding('123', 'ssh-1')).toMatchObject({ engine: 'legacy', dshSessionId: '' });

    initJobAgentBindings(tmpDir); // 落盘后重读仍在
    expect(getBinding('123', 'ssh-1')?.engine).toBe('legacy');

    // 同作业号改由 dsh 提交：刷新 engine，不重置 resumeCount
    expect(addBindings(['123'], makeCtx({ engine: 'dsh', dshSessionId: 'dsh-sess-9' }))).toBe(0);
    expect(getBinding('123', 'ssh-1')).toMatchObject({ engine: 'dsh', dshSessionId: 'dsh-sess-9' });
  });
});
