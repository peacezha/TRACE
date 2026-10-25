// 对话记录双来源合并：本地权威库 + 集群存档（QQ Bot 等写入的远程对话）。
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import ConversationList from './ConversationList';

const localConv = { id: 'conv-local', title: '本地对话', createdAt: 100, updatedAt: 300, messageCount: 2 };
// 与本地同 id 的集群副本（已导入）：合并时应被本地条目覆盖
const clusterDup = { id: 'conv-local', title: '本地对话（集群副本）', createdAt: 100, updatedAt: 300, messageCount: 2, origin: 'cluster', imported: true };
const clusterRemote = { id: 'conv-remote', title: 'QQ 远程对话', createdAt: 50, updatedAt: 200, messageCount: 4, origin: 'cluster', imported: false };

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

let fetchMock: ReturnType<typeof vi.fn>;
let clusterHandler: () => Promise<Response>;

beforeEach(() => {
  clusterHandler = () => jsonResponse({ success: true, connected: true, conversations: [clusterDup, clusterRemote] });
  fetchMock = vi.fn((input: unknown) => {
    const url = String(input);
    if (String(url).startsWith('/api/conversations?') || url === '/api/conversations') return jsonResponse({ success: true, conversations: [localConv] });
    if (url === '/api/conversations/cluster') return clusterHandler();
    if (url.endsWith('/import')) return jsonResponse({ success: true, conversation: { id: 'conv-remote' } });
    return jsonResponse({ success: false, error: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderList(onLoad = vi.fn()) {
  render(
    <ConversationList
      isOpen
      embedded
      onClose={() => {}}
      onLoad={onLoad}
      activeConversationId={null}
      loadingConversationId={null}
      onNewConversation={() => {}}
      sessionId="sess-1"
    />,
  );
  return onLoad;
}

function rowOf(title: string): HTMLElement {
  const row = screen.getByText(title).closest('div[class*="cursor-pointer"]');
  if (!row) throw new Error(`row not found: ${title}`);
  return row as HTMLElement;
}

describe('ConversationList 双来源合并', () => {
  it('合并本地与集群列表，按 id 去重（本地优先），按 updatedAt 倒序', async () => {
    renderList();
    await screen.findByText('本地对话');
    const localRow = rowOf('本地对话');
    // 同 id 集群副本被去重，不显示副本标题
    expect(screen.queryByText('本地对话（集群副本）')).toBeNull();
    const remoteRow = rowOf('QQ 远程对话');
    // updatedAt 300 > 200：本地条目排在前面
    expect(localRow.compareDocumentPosition(remoteRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('远程未导入条目带"计算资源"徽标与导入按钮，无删除/同步按钮；本地条目相反', async () => {
    renderList();
    await screen.findByText('QQ 远程对话');
    const remoteRow = rowOf('QQ 远程对话');
    expect(within(remoteRow).getByText('计算资源')).toBeInTheDocument();
    expect(within(remoteRow).getByTitle('从计算资源导入')).toBeInTheDocument();
    expect(within(remoteRow).queryByTitle('删除')).toBeNull();
    expect(within(remoteRow).queryByTitle('同步到计算资源')).toBeNull();

    const localRow = rowOf('本地对话');
    expect(within(localRow).queryByText('计算资源')).toBeNull();
    expect(within(localRow).getByTitle('删除')).toBeInTheDocument();
    expect(within(localRow).getByTitle('同步到计算资源')).toBeInTheDocument();
  });

  it('集群来源失败不影响本地列表', async () => {
    clusterHandler = () => Promise.reject(new Error('SFTP down'));
    renderList();
    expect(await screen.findByText('本地对话')).toBeInTheDocument();
    expect(screen.queryByText('QQ 远程对话')).toBeNull();
  });

  it('集群未连接（connected:false）只显示本地列表', async () => {
    clusterHandler = () => jsonResponse({ success: true, connected: false, conversations: [] });
    renderList();
    expect(await screen.findByText('本地对话')).toBeInTheDocument();
    expect(screen.queryByText('QQ 远程对话')).toBeNull();
  });

  it('点击远程未导入条目：先 import 成功再走 onLoad，导入后徽标消失', async () => {
    const onLoad = renderList();
    fireEvent.click(await screen.findByText('QQ 远程对话'));

    await waitFor(() => expect(onLoad).toHaveBeenCalledWith('conv-remote'));
    const importCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/conversations/conv-remote/import'));
    expect(importCall).toBeDefined();
    expect(importCall![1]?.method).toBe('POST');
    expect((importCall![1]?.headers as Record<string, string>)['X-SSH-Session-Id']).toBe('sess-1');
    // 导入后变为本地条目：徽标消失、删除按钮出现
    await waitFor(() => expect(screen.queryByText('计算资源')).toBeNull());
    expect(within(rowOf('QQ 远程对话')).getByTitle('删除')).toBeInTheDocument();
  });

  it('点击本地条目：直接 onLoad，不触发 import', async () => {
    const onLoad = renderList();
    fireEvent.click(await screen.findByText('本地对话'));
    expect(onLoad).toHaveBeenCalledWith('conv-local', undefined);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/import'))).toBe(false);
  });

  it('删除前确认包含标题，取消确认不发请求', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    renderList();
    await screen.findByText('本地对话');
    fireEvent.click(within(rowOf('本地对话')).getByTitle('删除'));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('本地对话'));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    expect(screen.getByText('本地对话')).toBeInTheDocument();
  });

  it('任意 HTTP 删除失败都保留条目并显示错误', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    fetchMock.mockImplementation((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'DELETE') return jsonResponse({ success: false, error: 'permission denied' }, 500);
      if (url.startsWith('/api/conversations?')) return jsonResponse({ success: true, conversations: [localConv] });
      if (url === '/api/conversations/cluster') return clusterHandler();
      return jsonResponse({ success: false }, 404);
    });
    renderList();
    await screen.findByText('本地对话');
    fireEvent.click(within(rowOf('本地对话')).getByTitle('删除'));
    expect(await screen.findByText('permission denied')).toBeInTheDocument();
    expect(screen.getByText('本地对话')).toBeInTheDocument();
  });

  it('只有删除成功后才从列表移除', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    fetchMock.mockImplementation((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'DELETE') return jsonResponse({ success: true });
      if (url.startsWith('/api/conversations?')) return jsonResponse({ success: true, conversations: [localConv] });
      if (url === '/api/conversations/cluster') return clusterHandler();
      return jsonResponse({ success: false }, 404);
    });
    renderList();
    await screen.findByText('本地对话');
    fireEvent.click(within(rowOf('本地对话')).getByTitle('删除'));
    await waitFor(() => expect(screen.queryByText('本地对话')).not.toBeInTheDocument());
  });
});
