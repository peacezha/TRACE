import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalSubmissionIntent,
  isDefiniteSubmissionRejection,
  JobSubmissionGuard,
  preflightJobSubmission,
  resolveSubmissionScriptPath,
} from './jobSubmissionGuard';

const roots: string[] = [];

function createGuard(): JobSubmissionGuard {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-submit-guard-'));
  roots.push(root);
  return new JobSubmissionGuard(root);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('job submission guard', () => {
  it('uses the resolved script path as the stable idempotency intent', () => {
    const first = canonicalSubmissionIntent(
      'cd /home/u/run && bsub < code/step-04.sh; echo done; bjobs -w',
      { conversationKey: 'conv-1' },
    );
    const second = canonicalSubmissionIntent(
      'cd /home/u/run && bsub < code/step-04.sh',
      { conversationKey: 'conv-1' },
    );
    expect(first).toEqual(second);
    expect(first.intent).toBe('bsub:script:/home/u/run/code/step-04.sh');
    expect(resolveSubmissionScriptPath('cd /home/u/run && bsub < code/step-04.sh', {}))
      .toBe('/home/u/run/code/step-04.sh');
    expect(resolveSubmissionScriptPath('sbatch --partition normal /home/u/run/code/step-04.sh; squeue', {}))
      .toBe('/home/u/run/code/step-04.sh');
  });

  it('checks script syntax and exact module loads before submission', async () => {
    const exec = vi.fn(async () => '[TRACE_PREFLIGHT] OK');
    const result = await preflightJobSubmission(
      'cd /home/u/run && bsub < code/step-04.sh',
      {},
      exec,
    );
    expect(result.ok).toBe(true);
    expect(result.scriptPath).toBe('/home/u/run/code/step-04.sh');
    expect(exec).toHaveBeenCalledOnce();
    const command = exec.mock.calls[0][0];
    expect(command).toContain('bash -n "$hp_script"');
    expect(command).toContain('module load "$hp_module"');
  });

  it('reports a repairable preflight failure without submitting', async () => {
    const result = await preflightJobSubmission(
      'bsub < /home/u/run/code/step-04.sh',
      {},
      async () => { throw new Error('[TRACE_PREFLIGHT] unavailable module: Picard/2.23.9'); },
    );
    expect(result).toMatchObject({ checked: true, ok: false });
    expect(result.output).toContain('unavailable module: Picard/2.23.9');
  });

  it('serializes concurrent attempts before a scheduler job id exists', async () => {
    const guard = createGuard();
    const input = {
      sessionId: 'ssh-1',
      conversationKey: 'conv-1',
      command: 'bsub < /home/u/run/code/step-04.sh',
      scheduler: 'lsf' as const,
      exec: vi.fn(async () => ''),
      now: 1000,
    };
    const first = await guard.prepare(input);
    const second = await guard.prepare({ ...input, now: 1001 });
    expect(first.kind).toBe('execute');
    expect(second.kind).toBe('busy');
  });

  it('returns the existing live job instead of submitting the same script twice', async () => {
    const guard = createGuard();
    const base = {
      sessionId: 'ssh-1',
      conversationKey: 'conv-1',
      command: 'cd /home/u/run && bsub < code/step-04.sh',
      scheduler: 'lsf' as const,
    };
    const first = await guard.prepare({ ...base, exec: async () => '', now: 1000 });
    expect(first.kind).toBe('execute');
    if (first.kind !== 'execute') return;
    guard.complete(first.claim, ['75598502'], 1010);

    const probe = vi.fn(async () => '75598502 PEND\n');
    const retry = await guard.prepare({ ...base, exec: probe, now: 2000 });
    expect(retry.kind).toBe('reuse');
    if (retry.kind === 'reuse') expect(retry.record.jobIds).toEqual(['75598502']);
    expect(probe).toHaveBeenCalledOnce();
  });

  it('allows a new attempt after the previous scheduler job is terminal', async () => {
    const guard = createGuard();
    const base = {
      sessionId: 'ssh-1',
      workflowRunDir: '/home/u/run',
      command: 'bsub < code/step-04.sh',
      scheduler: 'lsf' as const,
    };
    const first = await guard.prepare({ ...base, exec: async () => '', now: 1000 });
    expect(first.kind).toBe('execute');
    if (first.kind !== 'execute') return;
    guard.complete(first.claim, ['75598502'], 1010);

    const retry = await guard.prepare({ ...base, exec: async () => '75598502 EXIT\n', now: 2000 });
    expect(retry.kind).toBe('execute');
    expect(retry.kind === 'execute' ? retry.claim.claimId : '').not.toBe(first.claim.claimId);
  });

  it('supports dsub -s script identity without treating plain dsub as script submission', () => {
    expect(resolveSubmissionScriptPath('cd /home/u/run && dsub -s code/step.dsub', {}))
      .toBe('/home/u/run/code/step.dsub');
    expect(resolveSubmissionScriptPath('dsub --help', {})).toBeUndefined();
    expect(canonicalSubmissionIntent('dsub -s code/step.dsub', { workflowRunDir: '/home/u/run' }).intent)
      .toBe('dsub:script:/home/u/run/code/step.dsub');
  });

  it('keeps unknown durable across lease expiry and guard restart', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-submit-guard-'));
    roots.push(root);
    const base = {
      sessionId: 'ssh-1', conversationKey: 'conv-1',
      command: 'dsub -s /home/u/run/step.dsub', scheduler: 'donau' as const,
    };
    const guard = new JobSubmissionGuard(root);
    const first = await guard.prepare({ ...base, exec: async () => '', now: 1000 });
    expect(first.kind).toBe('execute');
    if (first.kind !== 'execute') return;
    guard.markUnknown(first.claim, 1010);

    const probe = vi.fn(async () => '999 x u RUNNING q');
    const restarted = new JobSubmissionGuard(root);
    const retry = await restarted.prepare({ ...base, exec: probe, now: 10_000_000 });
    expect(retry.kind).toBe('unknown');
    expect(retry.kind === 'unknown' ? retry.record.state : '').toBe('unknown');
    expect(probe).not.toHaveBeenCalled();
    expect(restarted.list()).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'job-submission-ledger.json'), 'utf8'))[0].state)
      .toBe('unknown');
  });

  it('unlocks unknown only through an explicit retry decision', async () => {
    const guard = createGuard();
    const base = {
      sessionId: 'ssh-1', conversationKey: 'conv-1',
      command: 'bsub < /home/u/run/step.sh', scheduler: 'lsf' as const,
      exec: async () => '',
    };
    const first = await guard.prepare({ ...base, now: 1000 });
    expect(first.kind).toBe('execute');
    if (first.kind !== 'execute') return;
    guard.markUnknown(first.claim, 1010);
    const unknown = await guard.prepare({ ...base, now: 2000 });
    expect(unknown.kind).toBe('unknown');
    if (unknown.kind !== 'unknown') return;

    const claim = guard.retryUnknown(unknown.record, 3000);
    expect(claim.claimId).not.toBe(first.claim.claimId);
    expect(guard.list()[0]).toMatchObject({ state: 'submitting', claimId: claim.claimId });
    expect(() => guard.retryUnknown(unknown.record, 3001)).toThrow('已变化');
  });

  it('turns an empty completion into unknown and releases only an explicit rejection', async () => {
    const guard = createGuard();
    const base = {
      sessionId: 'ssh-1', conversationKey: 'conv-1',
      command: 'qsub /home/u/run/job.pbs', scheduler: 'pbs' as const,
      exec: async () => '',
    };
    const first = await guard.prepare({ ...base, now: 1000 });
    expect(first.kind).toBe('execute');
    if (first.kind !== 'execute') return;
    guard.complete(first.claim, [], 1001);
    expect((await guard.prepare({ ...base, now: 999_999 })).kind).toBe('unknown');

    const rejected = await guard.prepare({
      ...base, command: 'qsub /home/u/run/other.pbs', now: 2000,
    });
    expect(rejected.kind).toBe('execute');
    if (rejected.kind !== 'execute') return;
    guard.fail(rejected.claim);
    expect(guard.list().filter(record => record.intent.includes('other.pbs'))).toEqual([]);
  });

  it('does not misclassify SSH failure text containing an exit code as definite rejection', () => {
    expect(isDefiniteSubmissionRejection(new Error('Command exited with code 1: queue does not exist'))).toBe(true);
    expect(isDefiniteSubmissionRejection(new Error('SSH connection reset; remote exited with code 255'))).toBe(false);
    expect(isDefiniteSubmissionRejection(new Error('Command timed out after 30000 ms'))).toBe(false);
    expect(isDefiniteSubmissionRejection(new Error('channel closed'))).toBe(false);
  });
});
