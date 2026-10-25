import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotifyConfig } from './notifyService';

const ENCRYPTION_KEY = '11'.repeat(32);
const secrets = {
  sendKey: 'sctp-secret',
  token: 'pushplus-secret',
  webhook: 'https://example.org/hook/secret',
  smtpPass: 'smtp-secret',
};

let dataRoot: string;
let previousKey: string | undefined;
let previousDataRoot: string | undefined;

async function loadService() {
  vi.resetModules();
  const service = await import('./notifyService');
  return { ...service, configPath: path.join(dataRoot, 'notify-config.json') };
}

beforeEach(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-notify-'));
  previousKey = process.env.TRACE_ENCRYPTION_KEY;
  previousDataRoot = process.env.TRACE_DATA_ROOT;
  process.env.TRACE_ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.TRACE_DATA_ROOT = dataRoot;
});

afterEach(async () => {
  if (previousKey === undefined) delete process.env.TRACE_ENCRYPTION_KEY;
  else process.env.TRACE_ENCRYPTION_KEY = previousKey;
  if (previousDataRoot === undefined) delete process.env.TRACE_DATA_ROOT;
  else process.env.TRACE_DATA_ROOT = previousDataRoot;
  await fs.rm(dataRoot, { recursive: true, force: true });
});

describe('notifyService secret storage', () => {
  it('encrypts every secret, writes mode 0600, and decrypts for internal use', async () => {
    const { saveNotifyConfig, loadNotifyConfig, configPath } = await loadService();
    const config: NotifyConfig = { enabled: true, channel: 'email', ...secrets };
    await saveNotifyConfig(config);

    const raw = await fs.readFile(configPath, 'utf8');
    for (const value of Object.values(secrets)) expect(raw).not.toContain(value);
    const stored = JSON.parse(raw);
    for (const field of Object.keys(secrets)) expect(stored[field]).toMatch(/^enc:v1:/);
    expect(await loadNotifyConfig()).toMatchObject(config);
    if (process.platform !== 'win32') {
      expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
    }
  });

  it('migrates all historical plaintext secrets on load', async () => {
    const { loadNotifyConfig, configPath } = await loadService();
    await fs.writeFile(configPath, JSON.stringify({ enabled: true, channel: 'wecom', ...secrets }), 'utf8');

    expect(await loadNotifyConfig()).toMatchObject(secrets);
    const raw = await fs.readFile(configPath, 'utf8');
    for (const value of Object.values(secrets)) expect(raw).not.toContain(value);
    const stored = JSON.parse(raw);
    for (const field of Object.keys(secrets)) expect(stored[field]).toMatch(/^enc:v1:/);
  });
});
