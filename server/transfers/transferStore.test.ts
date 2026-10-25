import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TransferTask } from '../../shared/fileTransfer';
import { normalizeRestoredTasks, saveTasks } from './transferStore';

afterEach(() => vi.restoreAllMocks());

function taskFixture(id: string): TransferTask {
  return {
    id, profileId: 'p1', direction: 'upload', localPath: 'D:\\a.bin',
    remotePath: '/data/a.bin', temporaryPath: '/data/.a.bin.part',
    sourceFingerprint: { size: 100, mtime: 1234 }, totalBytes: 100,
    transferredBytes: 42, bytesPerSecond: 0, state: 'paused', conflictPolicy: 'resume',
    verificationMode: 'size', retryCount: 0, createdAt: 1, updatedAt: 2,
  };
}

describe('normalizeRestoredTasks', () => {
  it('restores incomplete work as paused without credentials or session ids', () => {
    const [task] = normalizeRestoredTasks([{
      id: 't1',
      state: 'running',
      sessionId: 'old',
      transferredBytes: 42,
      totalBytes: 100,
      bytesPerSecond: 5000,
      profileId: 'p1',
    } as any]);
    expect(task.state).toBe('paused');
    expect(task.sessionId).toBeUndefined();
    expect(JSON.stringify(task)).not.toContain('password');
  });

  it('drops completed and cancelled tasks, keeps failed for retry', () => {
    const tasks = normalizeRestoredTasks([
      { id: 't1', state: 'completed', profileId: 'p1' } as any,
      { id: 't2', state: 'cancelled', profileId: 'p1' } as any,
      { id: 't3', state: 'failed', profileId: 'p1' } as any,
      { id: 't4', state: 'paused', profileId: 'p1' } as any,
    ]);
    expect(tasks.map(t => t.id)).toEqual(['t3', 't4']);
    expect(tasks[0].state).toBe('failed');
    expect(tasks[1].state).toBe('paused');
  });

  it('resets bytesPerSecond and forces actual .part reconciliation', () => {
    const [task] = normalizeRestoredTasks([{
      id: 't1', state: 'paused', bytesPerSecond: 999, profileId: 'p1', conflictPolicy: 'overwrite',
    } as any]);
    expect(task.bytesPerSecond).toBe(0);
    expect(task.conflictPolicy).toBe('resume');
  });

  it('does not expose error for completed tasks', () => {
    const [task] = normalizeRestoredTasks([{
      id: 't1', state: 'failed', error: 'disk full', profileId: 'p1',
    } as any]);
    expect(task.state).toBe('failed');
    expect(task.error).toBe('disk full');
  });
});

describe('saveTasks serialization', () => {
  it('serializes concurrent atomic writes and persists the source fingerprint', async () => {
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const snapshots: string[] = [];
    vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);
    vi.spyOn(fs.promises, 'rename').mockResolvedValue(undefined);
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (_path, data) => {
      activeWrites++;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      await new Promise(resolve => setTimeout(resolve, 5));
      snapshots.push(String(data));
      activeWrites--;
    });

    await Promise.all([
      saveTasks([taskFixture('first')]),
      saveTasks([taskFixture('second')]),
      saveTasks([taskFixture('third')]),
    ]);

    expect(maxActiveWrites).toBe(1);
    expect(snapshots.map(data => JSON.parse(data)[0].id)).toEqual(['first', 'second', 'third']);
    expect(JSON.parse(snapshots[2])[0].sourceFingerprint).toEqual({ size: 100, mtime: 1234 });
  });
});
