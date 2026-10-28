import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRemoteEditSessionManager } from './remote-edit-sessions.cjs';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

function createHarness(existingRoot?: string) {
  const root = existingRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'trace-edit-test-'));
  if (!existingRoot) roots.push(root);
  const watchers = new Map<string, () => void>();
  let finishLaunch!: () => void;
  const launch = vi.fn((_filePath: string, onOpened: () => Promise<void>) =>
    new Promise<void>((resolve, reject) => {
      void onOpened().then(() => { finishLaunch = resolve; }, reject);
    }));
  const onEvent = vi.fn();
  const manager = createRemoteEditSessionManager({
    root,
    files: fs.promises,
    watchFile: (filePath: string, callback: () => void) => {
      watchers.set(filePath, callback);
      return { close: vi.fn() };
    },
    hashFile: async (filePath: string) => crypto.createHash('sha256').update(await fs.promises.readFile(filePath)).digest('hex'),
    launch,
    onEvent,
    debounceMs: 25,
  });
  return { root, watchers, launch, onEvent, manager, finishLaunch: () => finishLaunch() };
}

const metadata = {
  profileId: 'profile-1',
  sshSessionId: 'ssh-1',
  remotePath: '/work/reports/a.docx',
  fileName: 'a.docx',
};

describe('remote edit sessions', () => {
  it('allocates a contained cache path and reuses an active remote path', async () => {
    const { root, manager } = createHarness();

    const session = await manager.prepare(metadata);
    const repeated = await manager.prepare(metadata);

    expect(path.relative(path.join(root, 'remote-edit-sessions'), session.localPath)).not.toMatch(/^\.\./);
    expect(path.basename(session.localPath)).toBe('a.docx');
    expect(repeated.id).toBe(session.id);
    expect(manager.list()).toHaveLength(1);
  });

  it('refreshes the SSH session id when a cached edit is reopened after reconnect', async () => {
    const { manager } = createHarness();
    const first = await manager.prepare(metadata);

    const reconnected = await manager.prepare({ ...metadata, sshSessionId: 'ssh-2' });

    expect(reconnected.id).toBe(first.id);
    expect(reconnected.sshSessionId).toBe('ssh-2');
  });

  it('rejects traversal in the display filename', async () => {
    const { manager } = createHarness();

    const session = await manager.prepare({ ...metadata, fileName: '..\\..\\escape.docx' });

    expect(path.basename(session.localPath)).toBe('escape.docx');
    expect(session.localPath).not.toContain('..');
  });

  it('emits one dirty event for a stable changed file and a closed event when the launcher exits', async () => {
    const harness = createHarness();
    const session = await harness.manager.prepare(metadata);
    await fs.promises.writeFile(session.localPath, 'version one');
    await harness.manager.markDownloaded(session.id);
    await harness.manager.open(session.id);

    await fs.promises.writeFile(session.localPath, 'version two');
    harness.watchers.get(session.localPath)!();
    harness.watchers.get(session.localPath)!();
    await vi.waitFor(() => {
      const dirtyEvents = harness.onEvent.mock.calls.filter(([event]) => event === 'dirty');
      expect(dirtyEvents).toHaveLength(1);
      expect(dirtyEvents[0][1]).toMatchObject({ id: session.id, dirty: true });
    });

    harness.finishLaunch();
    await vi.waitFor(() => {
      expect(harness.onEvent).toHaveBeenCalledWith('closed', expect.objectContaining({ id: session.id }));
    });
  });

  it('detects a final saved change when the file watcher misses the event', async () => {
    const harness = createHarness();
    const session = await harness.manager.prepare(metadata);
    await fs.promises.writeFile(session.localPath, 'downloaded version');
    await harness.manager.markDownloaded(session.id);
    await harness.manager.open(session.id);

    await fs.promises.writeFile(session.localPath, 'saved before close');
    harness.finishLaunch();
    await vi.waitFor(() => {
      expect(harness.onEvent).toHaveBeenCalledWith(
        'closed',
        expect.objectContaining({ id: session.id, dirty: true }),
      );
    });

    const dirtyEvents = harness.onEvent.mock.calls.filter(([event]) => event === 'dirty');
    expect(dirtyEvents).toHaveLength(1);
    expect(dirtyEvents[0][1]).toMatchObject({
      id: session.id,
      dirty: true,
      lastLocalFingerprint: crypto.createHash('sha256').update('saved before close').digest('hex'),
    });
  });

  it('does not report editing when the operating system rejects the open request', async () => {
    const harness = createHarness();
    const session = await harness.manager.prepare(metadata);
    await fs.promises.writeFile(session.localPath, 'downloaded version');
    await harness.manager.markDownloaded(session.id);
    harness.launch.mockImplementationOnce(async () => {
      throw new Error('No application is associated with this file');
    });

    const failed = await harness.manager.open(session.id);

    expect(failed).toMatchObject({
      state: 'failed',
      dirty: false,
      error: 'No application is associated with this file',
    });
    expect(harness.onEvent).not.toHaveBeenCalledWith(
      'changed',
      expect.objectContaining({ state: 'editing' }),
    );
  });

  it('keeps a failed dirty cache and reports it as unsynced', async () => {
    const { manager } = createHarness();
    const session = await manager.prepare(metadata);
    await fs.promises.writeFile(session.localPath, 'edited');

    await manager.markFailed(session.id, 'network unavailable');

    expect(manager.list()[0]).toMatchObject({ state: 'failed', dirty: true, error: 'network unavailable' });
    expect(manager.hasUnsynced()).toBe(true);
    expect(fs.existsSync(session.localPath)).toBe(true);
  });

  it('clears the unsynced flag only after the uploaded fingerprint is recorded', async () => {
    const { manager } = createHarness();
    const session = await manager.prepare(metadata);

    await manager.markUploading(session.id, 'hash-1');
    expect(manager.hasUnsynced()).toBe(true);
    await manager.markSynced(session.id, 'hash-1');
    expect(manager.hasUnsynced()).toBe(false);
  });

  it('keeps a newer save dirty when an older upload finishes', async () => {
    const harness = createHarness();
    const session = await harness.manager.prepare(metadata);
    await fs.promises.writeFile(session.localPath, 'version one');
    await harness.manager.markDownloaded(session.id);
    await harness.manager.open(session.id);
    const firstFingerprint = crypto.createHash('sha256').update('version one').digest('hex');
    await harness.manager.markUploading(session.id, firstFingerprint);

    await fs.promises.writeFile(session.localPath, 'version two');
    harness.watchers.get(session.localPath)!();
    await new Promise(resolve => setTimeout(resolve, 60));
    const beforeCompletion = harness.manager.list()[0];
    expect(beforeCompletion.lastLocalFingerprint).not.toBe(firstFingerprint);

    const completed = await harness.manager.markSynced(session.id, firstFingerprint);

    expect(completed).toMatchObject({
      state: 'editing',
      dirty: true,
      lastUploadedFingerprint: firstFingerprint,
    });
    expect(harness.manager.hasUnsynced()).toBe(true);
  });

  it('restores failed sessions after an application restart', async () => {
    const first = createHarness();
    const session = await first.manager.prepare(metadata);
    await fs.promises.writeFile(session.localPath, 'recover me');
    await first.manager.markFailed(session.id, 'offline');
    first.manager.dispose();

    const restarted = createHarness(first.root);
    await restarted.manager.restore();

    expect(restarted.manager.list()).toEqual([
      expect.objectContaining({
        id: session.id,
        state: 'failed',
        dirty: true,
        error: 'offline',
      }),
    ]);
    expect(restarted.manager.hasUnsynced()).toBe(true);
  });

  it('turns an interrupted upload into a retryable failed session on restart', async () => {
    const first = createHarness();
    const session = await first.manager.prepare(metadata);
    await fs.promises.writeFile(session.localPath, 'edited');
    await first.manager.markUploading(session.id, 'hash-before-crash');
    first.manager.dispose();

    const restarted = createHarness(first.root);
    await restarted.manager.restore();

    expect(restarted.manager.list()[0]).toMatchObject({
      state: 'failed',
      dirty: true,
      error: expect.stringContaining('中断'),
    });
  });

  it('fingerprints an interrupted editing cache before offering upload recovery', async () => {
    const first = createHarness();
    const session = await first.manager.prepare(metadata);
    await fs.promises.writeFile(session.localPath, 'unsaved watcher state');
    await first.manager.markDownloaded(session.id);
    await first.manager.open(session.id);
    first.manager.dispose();

    const restarted = createHarness(first.root);
    await restarted.manager.restore();

    expect(restarted.manager.list()[0]).toMatchObject({
      state: 'failed',
      dirty: true,
      lastLocalFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('discard removes the session and emits a discarded event but keeps the local cache file', async () => {
    const harness = createHarness();
    const session = await harness.manager.prepare(metadata);
    await fs.promises.writeFile(session.localPath, 'recover me');
    await harness.manager.markFailed(session.id, 'offline');

    await harness.manager.discard(session.id);

    expect(harness.manager.list()).toHaveLength(0);
    expect(harness.manager.hasUnsynced()).toBe(false);
    expect(fs.existsSync(session.localPath)).toBe(true);
    expect(harness.onEvent).toHaveBeenCalledWith('discarded', expect.objectContaining({ id: session.id }));
  });

  it('restore skips fully synced sessions so the strip does not accumulate', async () => {
    const first = createHarness();
    const synced = await first.manager.prepare(metadata);
    await fs.promises.writeFile(synced.localPath, 'done');
    await first.manager.markSynced(synced.id, 'hash-1');
    const failed = await first.manager.prepare({ ...metadata, remotePath: '/work/reports/b.docx', fileName: 'b.docx' });
    await fs.promises.writeFile(failed.localPath, 'not done');
    await first.manager.markFailed(failed.id, 'offline');
    first.manager.dispose();

    const restarted = createHarness(first.root);
    await restarted.manager.restore();

    expect(restarted.manager.list().map(s => s.id)).toEqual([failed.id]);
  });
});
