import { useState, useEffect } from 'react';
import { isPublicWeb } from '../services/publicWeb';
import { MessageSquare, Trash2, Search, Loader2, RefreshCw, X, HardDriveUpload, HardDriveDownload, Check, AlertCircle } from 'lucide-react';
import { getStoredLocale } from '../i18n';

interface ConvSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** 来源标记：'cluster' = 仅集群存档（GET /api/conversations/cluster）；本地条目无此字段 */
  origin?: 'cluster' | 'local';
  /** 集群条目是否已导入本地库（同 id 已存在）；未导入的远程条目无删除/同步按钮 */
  imported?: boolean;
  /** 聚合列表(/api/conversations/all):条目来源会话 id 与可读集群标签 */
  originSessionId?: string;
  clusterLabel?: string;
}

interface ConversationListProps {
  isOpen: boolean;
  onClose: () => void;
  onLoad: (id: string, sessionId?: string) => void;
  activeConversationId: string | null;
  loadingConversationId?: string | null;
  onNewConversation: () => void;
  refreshTrigger?: number;
  /** 多集群标签页：对话存档按集群隔离 */
  sessionId?: string | null;
  /** 作为左侧工作台导航嵌入时，不显示重复边框和关闭按钮。 */
  embedded?: boolean;
}


function SyncButton({ convId, convTitle, sessionId }: { convId: string; convTitle: string; sessionId?: string | null }) {
  const [state, setState] = useState<'idle' | 'syncing' | 'done' | 'error'>('idle');

  const handleSync = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setState('syncing');
    try {
      const res = await fetch(`/api/conversations/${convId}/sync`, {
        method: 'POST',
        credentials: 'include' as RequestCredentials,
        headers: {
          'Content-Type': 'application/json',
          ...(sessionId ? { 'X-SSH-Session-Id': sessionId } : {}),
        },
        body: JSON.stringify({ title: convTitle }),
      });
      if (!res.ok) throw new Error('sync failed');
      setState('done');
      setTimeout(() => setState('idle'), 1500);
    } catch {
      setState('error');
      setTimeout(() => setState('idle'), 1500);
    }
  };

  if (!sessionId) return null;

  return (
    <button
      onClick={handleSync}
      disabled={state === 'syncing'}
      className="p-1 text-scholar-500 hover:text-accent opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-all"
      title={state === 'done' ? '已同步' : state === 'error' ? '同步失败' : '同步到计算资源'}
    >
      {state === 'syncing' ? <Loader2 className="w-3 h-3 animate-spin" /> :
       state === 'done' ? <Check className="w-3 h-3 text-emerald-600" /> :
       state === 'error' ? <AlertCircle className="w-3 h-3 text-red-600" /> :
       <HardDriveUpload className="w-3 h-3" />}
    </button>
  );
}

export default function ConversationList({
  isOpen, onClose, onLoad, activeConversationId, loadingConversationId, onNewConversation, refreshTrigger, sessionId, embedded = false
}: ConversationListProps) {
  const [conversations, setConversations] = useState<ConvSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  const sessionHeaders = (): Record<string, string> =>
    sessionId ? { 'X-SSH-Session-Id': sessionId } : {};

  // 本地权威库 + 集群存档双来源合并：集群对话（如 QQ Bot 写入的）此前完全不可见。
  // 远程失败（无会话/网络问题）不影响本地列表；按 id 去重时本地优先。
  const fetchConversations = async () => {
    if (isPublicWeb() && !sessionId) { setConversations([]); setError(null); setLoading(false); return; }
    setLoading(true);
    setError(null);
    const requestInit: RequestInit = { credentials: 'include' as RequestCredentials, headers: sessionHeaders() };
    // v0.5.2:桌面端优先聚合列表(本地+所有已连接集群,逐条标注来源集群),
    // 避免按活跃标签过滤导致"刚跑的流程对话在列表里看不到";接口异常回退旧双源合并。
    if (!isPublicWeb()) {
      try {
        const res = await fetch('/api/conversations/all', requestInit);
        const data = await res.json();
        if (data?.success && Array.isArray(data.conversations)) {
          setConversations(data.conversations as ConvSummary[]);
          setLoading(false);
          return;
        }
      } catch { /* 回退旧路径 */ }
    }
    const [localResult, clusterResult] = await Promise.allSettled([
      fetch('/api/conversations?scope=' + encodeURIComponent(sessionId || 'local-workbench'), requestInit).then(res => res.json()),
      isPublicWeb() ? Promise.resolve({ success: true, conversations: [] }) : fetch('/api/conversations/cluster', requestInit).then(res => res.json()),
    ]);
    try {
      if (localResult.status === 'fulfilled' && localResult.value?.success) {
        const localItems = (localResult.value.conversations || []) as ConvSummary[];
        const clusterItems = clusterResult.status === 'fulfilled' && clusterResult.value?.success
          ? (clusterResult.value.conversations || []) as ConvSummary[]
          : [];
        const merged = new Map<string, ConvSummary>();
        for (const item of [...localItems, ...clusterItems]) {
          if (item && typeof item.id === 'string' && !merged.has(item.id)) merged.set(item.id, item);
        }
        const toTime=(v:unknown)=>{const n=Number(v);if(Number.isFinite(n)&&n>0)return n;const p=Date.parse(String(v??""));return Number.isFinite(p)?p:0;};
        setConversations([...merged.values()].sort((a, b) => toTime(b.updatedAt) - toTime(a.updatedAt)));
      } else {
        setError(localResult.status === 'fulfilled'
          ? (localResult.value?.error || 'Failed to load conversations')
          : (localResult.reason?.message || 'Network error'));
      }
    } finally { setLoading(false); }
  };

  useEffect(() => { if (isOpen) fetchConversations(); }, [isOpen, sessionId]);
  useEffect(() => { if (isOpen && refreshTrigger) fetchConversations(); }, [refreshTrigger]);

  const handleDelete = async (id: string) => {
    try {
      const target = conversations.find(c => c.id === id);
      if (!target || !window.confirm(`确定删除对话“${target.title}”吗？此操作不可撤销。`)) return;
      setError(null);
      const targetSession = target?.originSessionId && target.originSessionId !== 'local-workbench' ? target.originSessionId : sessionId;
      const response = await fetch(`/api/conversations/${id}`, { method: 'DELETE', credentials: 'include' as RequestCredentials, headers: targetSession ? { 'X-SSH-Session-Id': targetSession } : sessionHeaders() });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) throw new Error(data.error || `删除失败 (${response.status})`);
      setConversations(prev => prev.filter(c => c.id !== id));
    } catch (e) { console.error(e); setError(e instanceof Error ? e.message : '删除失败'); }
  };

  const [importingId, setImportingId] = useState<string | null>(null);
  /** 仅在集群存档、本地还没有副本的条目：显示"计算资源"徽标，点击先导入再加载 */
  const isRemoteOnly = (conv: ConvSummary) => conv.origin === 'cluster' && !conv.imported && !conv.originSessionId;

  const handleSelect = async (conv: ConvSummary) => {
    if (!isRemoteOnly(conv)) { onLoad(conv.id, conv.originSessionId || undefined); return; }
    if (importingId) return; // 导入期间忽略重复点击
    setImportingId(conv.id);
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${conv.id}/import`, {
        method: 'POST',
        credentials: 'include' as RequestCredentials,
        headers: sessionHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || '导入失败');
      // 导入后即本地条目：去掉徽标、恢复删除/同步按钮
      setConversations(prev => prev.map(item => item.id === conv.id ? { ...item, imported: true } : item));
      onLoad(conv.id);
    } catch (e: any) {
      setError(e.message || '导入失败');
    } finally {
      setImportingId(null);
    }
  };

  const filtered = conversations.filter(c =>
    c.title.toLowerCase().includes(search.toLowerCase())
  );

  if (!isOpen) return null;

  const dateLocale = getStoredLocale();

  return (
    <div className={`h-full flex flex-col bg-scholar-900/80 ${embedded ? '' : 'border-l border-scholar-700'}`}>
      <div className="p-3 border-b border-scholar-700 shrink-0">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-scholar-100 flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-accent" /> 对话记录
          </h3>
          <div className="flex gap-1">
            <button onClick={fetchConversations} className="p-1 text-scholar-400 hover:text-scholar-200" title="刷新">
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            {!embedded && <button onClick={onClose} className="p-1 text-scholar-400 hover:text-scholar-200" aria-label="关闭"><X className="w-3.5 h-3.5" /></button>}
          </div>
        </div>
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-scholar-400" />
          <input
            type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="搜索对话..."
            className="w-full bg-scholar-950 border border-scholar-700 rounded pl-7 pr-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && filtered.length === 0 ? (
          <div className="flex items-center justify-center p-8 text-scholar-400">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-6 text-center text-xs">
            {error ? (
              <div>
                <p className="text-red-600 mb-1">加载失败</p>
                <p className="text-scholar-400">{error}</p>
                <button onClick={fetchConversations} className="mt-2 text-accent hover:underline">重试</button>
              </div>
            ) : (
              <span className="text-scholar-400">{isPublicWeb() && !sessionId ? '登录集群后显示个人对话记录' : search ? '无匹配对话' : '暂无历史对话'}</span>
            )}
          </div>
        ) : (
          <div className="p-2 space-y-1">
            {error && (
              <div className="mb-1 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs text-red-500">{error}</div>
            )}
            {filtered.map(conv => {
              const remoteOnly = isRemoteOnly(conv);
              return (
              <div
                key={conv.id}
                onClick={() => { void handleSelect(conv); }}
                className={`p-2.5 rounded-lg group transition-colors cursor-pointer ${
                  conv.id === loadingConversationId || conv.id === importingId
                    ? 'opacity-50'
                    : conv.id === activeConversationId
                    ? 'bg-scholar-600/20 border border-accent/30'
                    : 'hover:bg-scholar-700/60 border border-transparent'
                }`}
              >
                <div className="flex justify-between items-start">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p data-user-content="true" className="text-xs font-medium text-scholar-100 truncate">{conv.title}</p>
                      {conv.originSessionId && conv.originSessionId !== 'local-workbench' && conv.clusterLabel && (
                        <span className="shrink-0 inline-flex items-center rounded border border-emerald-600/50 bg-emerald-500/10 px-1 text-[10px] leading-4 text-emerald-400" title={conv.clusterLabel}>{conv.clusterLabel.split('@')[0]}</span>
                      )}
                      {conv.origin === 'local' && (
                        <span className="shrink-0 inline-flex items-center rounded border border-scholar-600 px-1 text-[10px] leading-4 text-scholar-400">本地</span>
                      )}
                      {remoteOnly && (
                        <span className="shrink-0 inline-flex items-center rounded border border-accent/40 bg-accent/10 px-1 text-[10px] leading-4 text-accent">计算资源</span>
                      )}
                      {conv.id === importingId && <Loader2 className="w-3 h-3 shrink-0 animate-spin text-accent" />}
                    </div>
                    <p className="text-xs text-scholar-400 mt-0.5">
                      {conv.messageCount} 条消息 · {new Date(conv.updatedAt).toLocaleDateString(dateLocale)}
                    </p>
                  </div>
                  {remoteOnly && (
                    <button
                      onClick={(e) => { e.stopPropagation(); void handleSelect(conv); }}
                      disabled={conv.id === importingId}
                      className="p-1 text-accent/80 hover:text-accent transition-all"
                      title="从计算资源导入"
                    >
                      <HardDriveDownload className="w-3 h-3" />
                    </button>
                  )}
                  {!isPublicWeb() && !remoteOnly && <SyncButton convId={conv.id} convTitle={conv.title} sessionId={sessionId} />}
                  {!remoteOnly && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(conv.id); }}
                      className="p-1 text-scholar-500 hover:text-red-600 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-all"
                      title="删除"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>

      {!embedded && <div className="p-3 border-t border-scholar-700 shrink-0">
        <button
          onClick={onNewConversation}
          className="btn-primary w-full"
        >
          + 新对话
        </button>
      </div>}
    </div>
  );
}
