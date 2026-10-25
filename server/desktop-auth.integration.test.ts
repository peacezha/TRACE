import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { io as connectSocket } from 'socket.io-client';

const TOKEN = 'desktop-auth-integration-token';
const appRoot = process.cwd();
let child: ChildProcess;
let exited: Promise<unknown>;
let dataRoot = '';
let base = '';
let log = '';

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('No TCP port available')));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

beforeAll(async () => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-desktop-auth-'));
  base = `http://127.0.0.1:${await reservePort()}`;
  child = spawn(process.execPath, [path.join(appRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'server.ts'], {
    cwd: appRoot,
    env: {
      ...process.env,
      PORT: new URL(base).port,
      TRACE_APP_ROOT: appRoot,
      TRACE_STATIC_ROOT: appRoot,
      TRACE_DATA_ROOT: dataRoot,
      TRACE_DESKTOP_TOKEN: TOKEN,
      TRACE_PARENT_PID: '',
      TRACE_WEB_MODE: '',
      TRACE_PUBLIC_WORKER: '',
      TRACE_AI_ENGINE: 'legacy',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', chunk => { log += chunk; });
  child.stderr?.on('data', chunk => { log += chunk; });
  exited = new Promise(resolve => child.once('exit', resolve));

  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch { /* Backend is still starting. */ }
    if (child.exitCode !== null) throw new Error(`Desktop backend exited: ${log.slice(-4000)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Desktop backend did not become ready: ${log.slice(-4000)}`);
}, 45_000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
  if (dataRoot) fs.rmSync(dataRoot, { recursive: true, force: true });
}, 15_000);

describe.sequential('desktop unified authentication over HTTP', () => {
  it('rejects JSON and form API requests without a token before route handling', async () => {
    const json = await fetch(`${base}/api/ai/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(json.status).toBe(403);
    expect(await json.json()).toEqual({ error: 'Forbidden: invalid desktop token' });

    const form = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'host=localhost',
    });
    expect(form.status).toBe(403);
    expect((await fetch(`${base}/api/app-info`)).status).toBe(403);
    expect((await fetch(`${base}/api/app-info`, {
      headers: { 'X-TRACE-Desktop-Token': 'wrong-token' },
    })).status).toBe(403);
  });

  it('allows valid-token API requests while keeping health and static assets public', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/`)).status).not.toBe(403);
    expect((await fetch(`${base}/api/app-info`, {
      headers: { 'X-TRACE-Desktop-Token': TOKEN },
    })).status).toBe(200);

    for (const [contentType, body] of [
      ['application/json', '{}'],
      ['application/x-www-form-urlencoded', ''],
    ]) {
      const response = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': contentType, 'X-TRACE-Desktop-Token': TOKEN },
        body,
      });
      expect(response.status).toBe(400);
    }
  });

  it('rejects unauthenticated Socket.IO handshakes and accepts a valid token', async () => {
    await new Promise<void>((resolve, reject) => {
      const socket = connectSocket(base, {
        transports: ['websocket'], reconnection: false, timeout: 3000,
      });
      const timer = setTimeout(() => { socket.close(); reject(new Error('Missing-token handshake timed out')); }, 5000);
      socket.on('connect', () => {
        clearTimeout(timer); socket.close(); reject(new Error('Missing-token handshake was accepted'));
      });
      socket.on('connect_error', () => { clearTimeout(timer); socket.close(); resolve(); });
    });

    await new Promise<void>((resolve, reject) => {
      const socket = connectSocket(base, {
        transports: ['websocket'], reconnection: false, timeout: 3000,
        extraHeaders: { 'X-TRACE-Desktop-Token': TOKEN },
      });
      const timer = setTimeout(() => { socket.close(); reject(new Error('Valid-token handshake timed out')); }, 5000);
      socket.on('connect', () => { clearTimeout(timer); socket.close(); resolve(); });
      socket.on('connect_error', error => { clearTimeout(timer); socket.close(); reject(error); });
    });
  }, 15_000);
});
