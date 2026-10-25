import { describe, expect, it } from 'vitest';
import { ClusterConversationStore } from './clusterConversations';
import type { SftpFileService } from '../files/sftpFileService';

// 内存版假 SFTP 文件系统：Map<路径, 文件内容>，目录仅记录存在性
function makeFakeService() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const modes = new Map<string, number>();
  const service = {
    async mkdir(dir: string) {
      if (dirs.has(dir)) throw new Error('mkdir: File exists');
      dirs.add(dir);
    },
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
    async chmod(p: string, mode: number) {
      modes.set(p, mode);
    },
  };
  return { files, dirs, modes, service: service as unknown as SftpFileService };
}

const HOME = '/home/tester';
const sample = (id: string, title = '测试对话') => ({
  id,
  title,
  messages: [{ role: 'user', content: '你好' }],
  createdAt: 1000,
  updatedAt: 2000,
});

describe('ClusterConversationStore', () => {
  it('reads legacy archives, writes updated copies to TRACE, and does not resurrect an explicitly deleted record', async () => {
    const { files, dirs, service } = makeFakeService();
    dirs.add(`${HOME}/hpclaw_conversations`);
    files.set(`${HOME}/hpclaw_conversations/old-1.json`, JSON.stringify(sample('old-1', 'Original archive')));
    const store = new ClusterConversationStore(service, HOME);
    expect((await store.list()).map(item => item.id)).toEqual(['old-1']);
    expect((await store.get('old-1'))?.title).toBe('Original archive');
    await store.save({ ...sample('old-1', 'Updated in TRACE'), updatedAt: 3000 });
    expect((await store.list()).map(item => item.id)).toEqual(['old-1']);
    expect((await store.get('old-1'))?.title).toBe('Updated in TRACE');
    expect(JSON.parse(files.get(`${HOME}/hpclaw_conversations/old-1.json`)!).title).toBe('Original archive');
    await store.remove('old-1'); expect(await store.list()).toEqual([]); expect(await store.get('old-1')).toBeUndefined();
  });

  it('save 后可 get 读取完整记录，且所有模式均限制目录和文件权限', async () => {
    const { files, modes, service } = makeFakeService();
    const store = new ClusterConversationStore(service, HOME);
    await store.save(sample('abc-1'));
    const record = await store.get('abc-1');
    expect(record?.title).toBe('测试对话');
    expect(files.has(`${HOME}/trace_conversations/abc-1.json`)).toBe(true);
    expect(files.has(`${HOME}/trace_conversations/index.json`)).toBe(true);
    expect(modes.get(`${HOME}/trace_conversations`)).toBe(0o700);
    expect(modes.get(`${HOME}/trace_conversations/abc-1.json`)).toBe(0o600);
    expect(modes.get(`${HOME}/trace_conversations/index.json`)).toBe(0o600);
  });

  it('list 返回摘要（倒序），不含消息体', async () => {
    const { service } = makeFakeService();
    const store = new ClusterConversationStore(service, HOME);
    await store.save({ ...sample('a-1', '旧对话'), updatedAt: 100 });
    await store.save({ ...sample('b-2', '新对话'), updatedAt: 300 });
    await store.save({ ...sample('c-3', '中间'), updatedAt: 200 });
    const list = await store.list();
    expect(list.map(s => s.id)).toEqual(['b-2', 'c-3', 'a-1']);
    expect(list[0]).toMatchObject({ title: '新对话', messageCount: 1 });
    expect((list[0] as any).messages).toBeUndefined();
  });

  it('索引损坏时扫描目录重建列表', async () => {
    const { files, service } = makeFakeService();
    const store = new ClusterConversationStore(service, HOME);
    await store.save(sample('x-1'));
    await store.save(sample('y-2'));
    files.set(`${HOME}/trace_conversations/index.json`, '{corrupted');
    const list = await store.list();
    expect(list.map(s => s.id).sort()).toEqual(['x-1', 'y-2']);
  });

  it('集群目录不存在时 list 返回空数组', async () => {
    const { service } = makeFakeService();
    const store = new ClusterConversationStore(service, HOME);
    expect(await store.list()).toEqual([]);
    expect(await store.get('missing')).toBeUndefined();
  });

  it('remove 删除记录并更新索引', async () => {
    const { service } = makeFakeService();
    const store = new ClusterConversationStore(service, HOME);
    await store.save(sample('d-1'));
    await store.save(sample('d-2'));
    await store.remove('d-1');
    expect(await store.get('d-1')).toBeUndefined();
    expect((await store.list()).map(s => s.id)).toEqual(['d-2']);
  });

  it('拒绝非法对话 ID（防路径穿越）', async () => {
    const { service } = makeFakeService();
    const store = new ClusterConversationStore(service, HOME);
    await expect(store.get('../../etc/passwd')).rejects.toThrow('非法的对话 ID');
    await expect(store.remove('../../etc/passwd')).rejects.toThrow('非法的对话 ID');
    await expect(store.save({ ...sample('../../x'), messages: [] })).rejects.toThrow('非法的对话 ID');
  });

  it('does not turn a permission or connection failure into a missing archive', async () => {
    const { service } = makeFakeService();
    service.readPreview = async () => { throw new Error('Permission denied'); };
    await expect(new ClusterConversationStore(service, HOME).get('safe-id')).rejects.toThrow('Permission denied');
  });
});
