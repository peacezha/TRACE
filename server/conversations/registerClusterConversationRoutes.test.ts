// 集群对话端点：GET /api/conversations/cluster（列表 + 导入标记）、
// POST /api/conversations/:id/import（从集群导回本地权威库）。
// 集群侧用内存假 SFTP + 真实 ClusterConversationStore；本地侧用临时目录真实
// LocalConversationStore；会话解析（什么请求算"有会话"）由 server.ts 注入，这里
// 只覆盖"有/无 store"两种注入结果。
import http from 'node:http';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerClusterConversationRoutes,
  type ClusterConversationRouteDeps,
} from './registerClusterConversationRoutes';
import { ClusterConversationStore, type ConversationRecordLike } from './clusterConversations';
import { LocalConversationStore } from './localConversations';
import type { SftpFileService } from '../files/sftpFileService';

const servers: http.Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// 内存版假 SFTP 文件系统（与 clusterConversations.test.ts 同款）
function makeFakeService() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const service = {
    async mkdir(dir: string) {
      if (dirs.has(dir)) throw new Error('mkdir: File exists');
      dirs.add(dir);
    },
    async chmod() {},
    async list(dir: string) {
      if (!dirs.has(dir)) throw new Error('No such directory');
      const prefix = dir.endsWith('/') ? dir : dir + '/';
      return [...files.keys()]
        .filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map(p => ({
          name: p.slice(prefix.length),
          path: p,
          kind: 'file' as const,
          size: files.get(p)!.length,
          modifiedAt: 0,
        }));
    },
    async readPreview(p: string) {
      const content = files.get(p);
      if (content === undefined) throw new Error('No such file');
      return Buffer.from(content, 'utf8');
    },
    async writeFile(p: string, content: string) {
      files.set(p, content);
    },
    async remove(p: string) {
      if (!files.delete(p)) throw new Error('No such file');
      return { removed: 1 };
    },
  };
  return { files, dirs, service: service as unknown as SftpFileService };
}

const HOME = '/home/tester';

function sample(id: string, title: string, updatedAt: number): ConversationRecordLike {
  return {
    id,
    title,
    messages: [{ role: 'user', content: `来自 ${title}` }],
    createdAt: updatedAt - 100,
    updatedAt,
  };
}

function makeLocalStore(): LocalConversationStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-local-conv-'));
  tempDirs.push(dir);
  return new LocalConversationStore(dir);
}

async function startRoutes(deps: ClusterConversationRouteDeps) {
  const app = express();
  app.use(express.json());
  registerClusterConversationRoutes(app, deps);
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

describe('cluster conversation routes', () => {
  it('无活跃会话：GET cluster 返回 connected:false 与空列表，import 返回 401', async () => {
    const localStore = makeLocalStore();
    const baseUrl = await startRoutes({ clusterConversationStoreFor: () => undefined, localStore });

    const listRes = await fetch(`${baseUrl}/api/conversations/cluster`);
    expect(listRes.status).toBe(200);
    await expect(listRes.json()).resolves.toEqual({ success: true, connected: false, conversations: [] });

    const importRes = await fetch(`${baseUrl}/api/conversations/x-1/import`, { method: 'POST' });
    expect(importRes.status).toBe(401);
    expect((await importRes.json()).success).toBe(false);
  });

  it('有会话：GET cluster 列出集群存档，标注 origin 与 imported', async () => {
    const { service } = makeFakeService();
    const clusterStore = new ClusterConversationStore(service, HOME);
    await clusterStore.save(sample('remote-only', '仅集群对话', 300));
    await clusterStore.save(sample('already-local', '已在本地', 200));
    const localStore = makeLocalStore();
    await localStore.save(sample('already-local', '已在本地', 200));

    const baseUrl = await startRoutes({ clusterConversationStoreFor: () => clusterStore, localStore });
    const res = await fetch(`${baseUrl}/api/conversations/cluster`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.connected).toBe(true);
    expect(body.conversations).toHaveLength(2);
    const byId = new Map(body.conversations.map((c: any) => [c.id, c]));
    expect(byId.get('remote-only')).toMatchObject({ origin: 'cluster', imported: false, messageCount: 1 });
    expect(byId.get('already-local')).toMatchObject({ origin: 'cluster', imported: true });
    // 摘要不含消息体
    expect(byId.get('remote-only').messages).toBeUndefined();
  });

  it('import 成功：集群记录写入本地库并原样返回', async () => {
    const { service } = makeFakeService();
    const clusterStore = new ClusterConversationStore(service, HOME);
    await clusterStore.save(sample('qq-bot-1', 'QQ 对话', 300));
    const localStore = makeLocalStore();

    const baseUrl = await startRoutes({ clusterConversationStoreFor: () => clusterStore, localStore });
    const res = await fetch(`${baseUrl}/api/conversations/qq-bot-1/import`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.conversation).toMatchObject({ id: 'qq-bot-1', title: 'QQ 对话' });

    const imported = await localStore.get('qq-bot-1');
    expect(imported).toMatchObject({ id: 'qq-bot-1', title: 'QQ 对话' });
    expect((await localStore.list()).map(s => s.id)).toEqual(['qq-bot-1']);
  });

  it('import 404：集群库中不存在该对话', async () => {
    const { service } = makeFakeService();
    const clusterStore = new ClusterConversationStore(service, HOME);
    const localStore = makeLocalStore();

    const baseUrl = await startRoutes({ clusterConversationStoreFor: () => clusterStore, localStore });
    const res = await fetch(`${baseUrl}/api/conversations/missing/import`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect((await res.json()).success).toBe(false);
  });
});
