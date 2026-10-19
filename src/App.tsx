import React, { useState, useRef, useCallback, useEffect, useMemo, lazy, Suspense, memo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Socket } from 'socket.io-client';

import LoginForm from './components/LoginForm';
import TerminalAI from './components/TerminalAI';
import { TerminalHandle } from './components/Terminal';
import AIChat from './components/AIChat';
import ClusterJobStatusBar from './components/ClusterJobStatusBar';
import JobsPanel from './components/JobsPanel';
import WorkbenchSidebar, { type WorkbenchSidebarTab } from './components/WorkbenchSidebar';
import ComputeBackendDrawer from './components/ComputeBackendDrawer';
import ClusterConsole from './components/ClusterConsole';
import FlowRunnerDrawer from './components/FlowRunnerDrawer';
import WorkflowPanel from './components/WorkflowPanel';
import WebApisPanel from './components/WebApisPanel';
import QQBotSettingsDialog from './components/QQBotSettingsDialog';
import UpdateCenterDialog from './components/UpdateCenterDialog';
import WebPanelDrawer, { type WebPanelRequest } from './components/WebPanelDrawer';
import {
  addWebPanelTab,
  removeWebPanelTab,
  EMPTY_WEB_PANEL_TABS,
  type WebPanelTabsState,
} from './services/webPanelTabs';
import JobToastStack from './components/JobToastStack';
import FilePreview from './features/file-transfer/FilePreview';
import { statRemote } from './features/file-transfer/api';
import type { EndpointOption } from './features/file-transfer/FileTransferWorkspace';
import type { FileEntry, PickPathKind } from '@/shared/fileTransfer';
import type { Workflow } from '@/shared/workflow';
import { WORKFLOW_CATALOG_CHANGED } from '@/shared/workflowCatalog';
import {
  createConversationContextId,
  deriveConversationTitle,
  seedWorkflowRunConversation,
  type WorkflowRunConversationSeed,
} from './features/workflows/runConversation';
import { useI18n } from './i18n';
import { loadAIProfile, saveAIProfile } from './services/aiProfile';
import { isPublicWeb, setPublicCluster, hydratePublicPreferences } from './services/publicWeb';
import PublicClusterFiles from './components/PublicClusterFiles';
import { useJobNotificationCenter } from './hooks/useJobNotificationCenter';
import {
  getStoredFingerprint,
  loginWithFingerprintConfirmation,
  storeTrustedFingerprint,
  type LoginCredentials,
  type LoginResponse,
} from './loginTrust';

const FileTransferWorkspace = lazy(() => import('./features/file-transfer/FileTransferWorkspace'));

// memo 包 lazy 组件是合法的：配合渲染处稳定化的 props，
// AI 消息流（每个 SSE 事件）触发 App 重渲染时，常驻挂载的传输工作区整棵树不再跟着重渲染
const MemoFileTransferWorkspace = memo(FileTransferWorkspace);

/** 空操作占位（模块级常量，引用稳定）：AIChat 的 onSkillsChange 目前无需消费 */
const noopSkillsChange = () => {};

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
  thoughtSteps?: { step: number; content: string }[];
}

/** 一个集群标签页：独立的 SSH 会话、终端、AI 对话 */
interface ClusterTab {
  kind: 'local' | 'cluster';
  sessionId: string;
  connInfo: { host: string; port: string; username: string };
  home: string;
  /** 登录时探测并打标签的调度器（LSF/Slurm/PBS/无调度器），用于界面展示 */
  schedulerLabel?: string;
  messages: Message[];
  activeConversationId: string | null;
  /** 独立于 SSH 会话的 AI 上下文键；新对话在首次保存前也必须有自己的键。 */
  conversationContextId: string;
  conversationSummary: string;
}

const LOCAL_WORKBENCH_ID = 'local-workbench';

function createLocalWorkbenchTab(): ClusterTab {
  return {
    kind: 'local',
    sessionId: LOCAL_WORKBENCH_ID,
    connInfo: { host: '本地工作台', port: '', username: 'AI' },
    home: '',
    messages: [],
    activeConversationId: null,
    conversationContextId: createConversationContextId(),
    conversationSummary: '',
  };
}

function conversationStorageKey(tab: Pick<ClusterTab, 'sessionId' | 'conversationContextId'>): string {
  return `${tab.sessionId}\u0000${tab.conversationContextId}`;
}

/** 按标签缓存的 AIChat 回调：引用不随 tabs/messages 更新变化，供 memo 化子组件使用 */
interface TabCallbacks {
  executeCommand: (cmd: string, waitAndCapture?: boolean, silent?: boolean) => Promise<string>;
  onMessagesChange: (msgs: Message[]) => void;
}

export default function App() {
  const { isEnglish, t } = useI18n();
  // ─── 多集群标签页 ─────────────────────────────────────────────
  const publicWeb = isPublicWeb();
  const [tabs, setTabs] = useState<ClusterTab[]>(() => publicWeb ? [] : [createLocalWorkbenchTab()]);
  const [activeTabId, setActiveTabId] = useState<string | null>(publicWeb ? null : LOCAL_WORKBENCH_ID);
  const [addingCluster, setAddingCluster] = useState(publicWeb);
  setPublicCluster(publicWeb ? activeTabId : undefined);
  // 对话按计算目标隔离：本地工作台与每个集群各自持有自己的对话，
  // 切换目标即切换到该目标的对话（本地任务与集群任务不再共用上下文）。
  const activeTab = tabs.find(t => t.sessionId === activeTabId) ?? tabs.find(t => t.kind === 'local') ?? null;
  const activeComputeTab = activeTab;
  const activeClusterTab = activeComputeTab?.kind === 'cluster' ? activeComputeTab : null;
  const tabsRef = useRef<ClusterTab[]>(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef<string | null>(activeTabId);
  activeTabIdRef.current = activeTabId;
  // 聚合对话列表跨集群加载：先切到来源集群标签,激活后再加载对话(见 effect)
  const pendingConversationLoadRef = useRef<string | null>(null);

  // ─── Auth State ────────────────────────────────────────────────
  const [loginError, setLoginError] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  // ─── Terminal（每标签一个，隐藏保活）─────────────────────────────
  const terminalRefs = useRef<Map<string, TerminalHandle>>(new Map());
  const [sockets, setSockets] = useState<Record<string, Socket>>({});

  const registerTerminal = useCallback((sessionId: string, handle: TerminalHandle | null) => {
    if (handle) terminalRefs.current.set(sessionId, handle);
    else terminalRefs.current.delete(sessionId);
  }, []);

  // ─── Panel State ───────────────────────────────────────────────
  const [computeBackendOpen, setComputeBackendOpen] = useState(false);
  const [clusterJobsOpen, setClusterJobsOpen] = useState(true);
  const [aiClusterControl, setAiClusterControl] = useState(true); // AI cluster command execution toggle (default ON)
  const [fileTransferOpen, setFileTransferOpen] = useState(false);
  const [fileTransferMaximized, setFileTransferMaximized] = useState(false);
  const [fileTransferLocation, setFileTransferLocation] = useState<{
    sessionId: string;
    path: string;
    requestId: number;
  }>();
  const [showQQBotSettings, setShowQQBotSettings] = useState(false);
  const [showUpdateCenter, setShowUpdateCenter] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<'chat' | 'workflow' | 'workflowManage' | 'cluster' | 'webapis'>('chat');
  const [workbenchSidebarTab, setWorkbenchSidebarTab] = useState<WorkbenchSidebarTab>('conversations');
  // 主导航切换：对话回 chat、计算资源进 cluster 控制台、数据资源进 webapis 页；文件/流程不动主区（保持现状语义）
  const handleSidebarTabChange = useCallback((tab: WorkbenchSidebarTab) => {
    setWorkbenchSidebarTab(tab);
    if (tab === 'conversations') setWorkspaceView('chat');
    else if (tab === 'compute') setWorkspaceView('cluster');
    else if (tab === 'webapis') setWorkspaceView('webapis');
  }, []);
  const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(null);
  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ workflow?: Workflow; deletedId?: string }>).detail;
      if (!detail) return;
      setSelectedWorkflow(current => current?.id === detail.deletedId ? null : current?.id === detail.workflow?.id ? detail.workflow! : current);
    };
    window.addEventListener(WORKFLOW_CATALOG_CHANGED, changed);
    return () => window.removeEventListener(WORKFLOW_CATALOG_CHANGED, changed);
  }, []);
  const [selectedRemoteEntry, setSelectedRemoteEntry] = useState<FileEntry | null>(null);
  // 流程面板的"选择路径"请求：resolve 回传选中的集群文件/目录（取消回传 null）
  const [pathPick, setPathPick] = useState<{ kind: PickPathKind; resolve: (path: string | null) => void } | null>(null);
  const requestRemotePath = useCallback((kind: PickPathKind = 'any'): Promise<string | null> => {
    return new Promise(resolve => {
      setPathPick({ kind, resolve });
      setWorkbenchSidebarTab('files');
    });
  }, []);
  const finishPathPick = useCallback((path: string | null) => {
    setPathPick(prev => {
      prev?.resolve(path);
      return null;
    });
  }, []);
  const openRemoteFolder = useCallback((path: string, targetSessionId?: string | null) => {
    const destinationSessionId = targetSessionId || activeClusterTab?.sessionId;
    const destination = tabsRef.current.find(tab => tab.sessionId === destinationSessionId && tab.kind === 'cluster');
    if (!destination || !path.trim()) return;
    setActiveTabId(destination.sessionId);
    setFileTransferLocation({
      sessionId: destination.sessionId,
      path: path.trim(),
      requestId: Date.now(),
    });
    setFileTransferOpen(true);
  }, [activeClusterTab?.sessionId]);

  // ─── 主题（白天/黑夜）───
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    localStorage.getItem('trace_theme') === 'light' ? 'light' : 'dark');
  useEffect(() => {
    const notify = (event: Event) => window.alert((event as CustomEvent).detail || '集群设置保存失败，请重新登录后重试');
    window.addEventListener('trace-persistence-error', notify);
    return () => window.removeEventListener('trace-persistence-error', notify);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : '';
    localStorage.setItem('trace_theme', theme);
  }, [theme]);
  const handleToggleTheme = useCallback(() => {
    setTheme(t => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  // ─── 终端路径点击：文件 → 预览；目录 → cd 进入并 ls ───
  const [previewTarget, setPreviewTarget] = useState<FileEntry | null>(null);
  // ─── 侧边网页栏：AI 答复的 http(s) 链接 / 集群远程 HTML（report.html 等），多标签 ───
  const [webPanel, setWebPanel] = useState<WebPanelTabsState>(EMPTY_WEB_PANEL_TABS);
  const openWebPanel = useCallback((request: WebPanelRequest) => {
    setWebPanel(prev => addWebPanelTab(prev, request));
  }, []);
  const selectWebPanelTab = useCallback((index: number) => {
    setWebPanel(prev => (index >= 0 && index < prev.tabs.length ? { ...prev, active: index } : prev));
  }, []);
  const closeWebPanelTab = useCallback((index: number) => {
    setWebPanel(prev => removeWebPanelTab(prev, index));
  }, []);
  const closeWebPanel = useCallback(() => setWebPanel(EMPTY_WEB_PANEL_TABS), []);
  const handleTerminalFileClick = useCallback(async (pathText: string) => {
    if (!activeTabId) return;
    let remotePath = pathText.trim();
    if (!remotePath.startsWith('/')) {
      // 相对路径：取当前工作目录拼接（静默探测且不回显，终端不显示 pwd）
      try {
        const pwd = (await terminalRefs.current.get(activeTabId)?.executeCommand('pwd', true, true, true))?.trim();
        if (pwd && pwd.startsWith('/')) {
          remotePath = pwd.replace(/\/+$/, '') + '/' + remotePath;
        }
      } catch { /* 取不到 pwd 就按原路径尝试 */ }
    }
    // stat 判定类型：目录 → 终端 cd 进入并 ls；文件 → 打开预览；不存在 → 静默忽略
    let entry: FileEntry;
    try {
      entry = (await statRemote(activeTabId, remotePath)).entry;
    } catch {
      return; // 点到的可能是普通单词而非真实路径，忽略即可
    }
    if (entry.kind === 'directory') {
      // 点击目录 → 静默 cd 进入并自动 ls：命令本身不显示，只呈现跳转后的内容
      terminalRefs.current.get(activeTabId)?.executeCommand(`cd ${JSON.stringify(remotePath)} && ls`, false, true);
      return;
    }
    setPreviewTarget(entry);
  }, [activeTabId]);

  // 面板/覆盖层状态变化后把焦点还给终端，避免"输入不进去"。
  // 只有集群控制台（终端整页视图）在前台时才抢回终端焦点。
  useEffect(() => {
    if (workspaceView === 'cluster' && !fileTransferOpen && !previewTarget && !addingCluster) {
      const timer = setTimeout(() => {
        if (activeTabId) terminalRefs.current.get(activeTabId)?.focus();
      }, 80);
      return () => clearTimeout(timer);
    }
  }, [workspaceView, fileTransferOpen, previewTarget, addingCluster, activeTabId]);

  // ─── Conversation ──────────────────────────────────────────────
  const [loadingConversationId, setLoadingConversationId] = useState<string | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);
  const [convListRefresh, setConvListRefresh] = useState(0);
  const lastConvListRefreshAtRef = useRef(0);
  const autoSaveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const autoSaveQueuesRef = useRef<Map<string, Promise<void>>>(new Map());
  const autoSaveConversationIdsRef = useRef<Map<string, string | null>>(new Map());
  const autoSaveSeenMessagesRef = useRef<Map<string, Message[]>>(new Map());
  const autoSaveEpochRef = useRef<Map<string, number>>(new Map());

  // External AI trigger —increments when toolbar sends text to AI
  // 按标签作用域：tabId 标识属于哪个集群的触发，切换标签不会误触发其他标签的 AI
  const [triggerAI, setTriggerAI] = useState<{ tabId: string; count: number }>({ tabId: '', count: 0 });

  const updateTab = useCallback((sessionId: string, patch: Partial<ClusterTab>) => {
    setTabs(prev => prev.map(t => (t.sessionId === sessionId ? { ...t, ...patch } : t)));
  }, []);

  const updateConversationTab = useCallback((sessionId: string, contextId: string, patch: Partial<ClusterTab>) => {
    setTabs(prev => prev.map(t => (
      t.sessionId === sessionId && t.conversationContextId === contextId ? { ...t, ...patch } : t
    )));
  }, []);

  /** 数据资源等板块"问 AI"通道:在当前对话追加用户消息并触发 AI 作答,同时切回对话视图。 */
  const askAi = useCallback((text: string) => {
    const content = String(text || '').trim();
    const tab = activeTab;
    if (!content || !tab) return;
    setWorkspaceView('chat');
    setWorkbenchSidebarTab('conversations');
    updateConversationTab(tab.sessionId, tab.conversationContextId, {
      messages: [...tab.messages, { role: 'user', content }],
    });
    setTriggerAI(prev => ({ tabId: tab.sessionId, count: prev.count + 1 }));
  }, [activeTab, updateConversationTab]);

  // ─── Auto-save conversation + backup to cluster ─────────────────
  // Retry helper: retry fetch on network errors with exponential backoff
  const fetchWithRetry = async (url: string, options: RequestInit, maxRetries = 3): Promise<Response> => {
    let lastErr: any;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const res = await fetch(url, options);
        return res; // HTTP errors (4xx, 5xx) are NOT retried — only network failures
      } catch (e: any) {
        lastErr = e;
        // Only retry on TypeError (network failure / Failed to fetch)
        if (e instanceof TypeError && attempt < maxRetries - 1) {
          const delay = 500 * Math.pow(2, attempt); // 500ms, 1000ms, 2000ms
          console.warn(`[saveConversation] Retry ${attempt + 1}/${maxRetries} after ${delay}ms:`, e.message);
          await new Promise(r => setTimeout(r, delay));
        } else {
          throw e;
        }
      }
    }
    throw lastErr;
  };

  const sessionHeaders = (sessionId: string): Record<string, string> => ({
    'Content-Type': 'application/json',
    'X-SSH-Session-Id': sessionId,
  });

  const saveConversation = useCallback(async (
    msgs: Message[],
    id: string | null,
    sessionId: string,
    contextId: string,
  ): Promise<string | null> => {
    if (msgs.length === 0) return id;
    try {
      let savedId = id;
      if (id) {
        const title = deriveConversationTitle(msgs, '对话');
        const res = await fetchWithRetry(`/api/conversations/${id}`, {
          method: 'PUT',
          credentials: 'include' as RequestCredentials,
          headers: sessionHeaders(sessionId),
          body: JSON.stringify({ messages: msgs, title, contextKey: contextId }),
        });
        if (!res.ok) throw new Error(`保存失败 (${res.status})`);
        const data = await res.json();
        if (data.success && data.conversation?.summary !== undefined) {
          updateConversationTab(sessionId, contextId, { conversationSummary: data.conversation.summary || '' });
        }
      } else {
        const title = deriveConversationTitle(msgs, '新对话');
        const res = await fetchWithRetry('/api/conversations', {
          method: 'POST',
          credentials: 'include' as RequestCredentials,
          headers: sessionHeaders(sessionId),
          body: JSON.stringify({ messages: msgs, title, contextKey: contextId }),
        });
        if (!res.ok) throw new Error(`保存失败 (${res.status})`);
        const data = await res.json();
        if (data.success) {
          updateConversationTab(sessionId, contextId, {
            activeConversationId: data.conversation.id,
            conversationSummary: data.conversation.summary || '',
          });
          savedId = data.conversation.id;
        }
      }

      // Refresh conversation list after save
      // v0.5.4:自动保存在流式期间高频触发,每次都全量刷新列表导致侧栏闪烁;
      // 刷新节流为 3 秒一次,且新对话创建时必定刷新(让新条目立刻出现)。
      const now = Date.now();
      if (!id || now - lastConvListRefreshAtRef.current > 3000) {
        lastConvListRefreshAtRef.current = now;
        setConvListRefresh(k => k + 1);
      }
      return savedId;
    } catch (e) {
      console.error('[saveConversation]', e);
      throw e;
    }
  }, [updateConversationTab]);

  // 对话与隐藏的 Agent 计划检查点自动保存到集群。按标签串行写入，避免首次
  // 创建对话时多个并发请求各自生成不同 ID；连续工具事件合并为一次写入。
  useEffect(() => {
    const liveStorageKeys = new Set(tabs.map(conversationStorageKey));
    for (const [storageKey, timer] of autoSaveTimersRef.current) {
      if (!liveStorageKeys.has(storageKey)) {
        clearTimeout(timer);
        autoSaveTimersRef.current.delete(storageKey);
        autoSaveSeenMessagesRef.current.delete(storageKey);
        autoSaveConversationIdsRef.current.delete(storageKey);
        autoSaveEpochRef.current.delete(storageKey);
        autoSaveQueuesRef.current.delete(storageKey);
      }
    }

    for (const tab of tabs) {
      const storageKey = conversationStorageKey(tab);
      if (tab.messages.length === 0 || autoSaveSeenMessagesRef.current.get(storageKey) === tab.messages) continue;
      autoSaveSeenMessagesRef.current.set(storageKey, tab.messages);
      const previousTimer = autoSaveTimersRef.current.get(storageKey);
      if (previousTimer) clearTimeout(previousTimer);
      const scheduledEpoch = autoSaveEpochRef.current.get(storageKey) || 0;

      const timer = setTimeout(() => {
        autoSaveTimersRef.current.delete(storageKey);
        const previousWrite = autoSaveQueuesRef.current.get(storageKey) || Promise.resolve();
        const nextWrite = previousWrite
          .catch(() => { /* 上一次失败不阻断新快照 */ })
          .then(async () => {
            if ((autoSaveEpochRef.current.get(storageKey) || 0) !== scheduledEpoch) return;
            const latest = tabsRef.current.find(item => (
              item.sessionId === tab.sessionId && item.conversationContextId === tab.conversationContextId
            ));
            if (!latest || latest.messages.length === 0) return;
            const knownId = autoSaveConversationIdsRef.current.has(storageKey)
              ? autoSaveConversationIdsRef.current.get(storageKey) ?? null
              : latest.activeConversationId;
            const savedId = await saveConversation(
              latest.messages,
              knownId,
              tab.sessionId,
              tab.conversationContextId,
            );
            autoSaveConversationIdsRef.current.set(storageKey, savedId);
          })
          .catch(error => console.error('[autoSaveConversation]', error));
        autoSaveQueuesRef.current.set(storageKey, nextWrite);
      }, 1_200);
      autoSaveTimersRef.current.set(storageKey, timer);
    }
  }, [tabs, saveConversation]);

  useEffect(() => () => {
    for (const timer of autoSaveTimersRef.current.values()) clearTimeout(timer);
    autoSaveTimersRef.current.clear();
  }, []);

  // ─── Login ─────────────────────────────────────────────────────
  // 建立集群连接并新增标签页；返回错误信息（null = 成功）
  const connectCluster = async (info: LoginCredentials): Promise<string | null> => {
    setLoginError('');
    setIsLoggingIn(true);
    try {
      const storedFingerprint = getStoredFingerprint(info);
      const loginInfo = storedFingerprint ? { ...info, expectedFingerprint: storedFingerprint } : info;
      const { ok, data, trustedFingerprint } = await loginWithFingerprintConfirmation(loginInfo, {
        request: async (credentials): Promise<LoginResponse> => {
          const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(credentials),
          });
          return { ok: res.ok, data: await res.json() };
        },
        confirmFingerprint: fingerprint => window.confirm(
          `${t('首次连接该主机。请确认主机指纹无误后再信任：')}\n\n${fingerprint}\n\n${t('确认后将使用此指纹重试登录。')}`,
        ),
      });
      if (ok && data.success) {
        if (publicWeb) {
          setPublicCluster(data.sessionId);
          try {
            const response = await fetch('/api/public/profile', { headers: { 'X-SSH-Session-Id': data.sessionId } });
            const saved = await response.json();
            if (!response.ok) throw new Error(saved.error || '集群设置加载失败');
            saveAIProfile(saved.profile || {}, data.sessionId);
            hydratePublicPreferences(data.sessionId, saved.preferences);
          } catch (error) { window.alert(`集群已连接，但设置加载失败：${error instanceof Error ? error.message : '网络错误'}。请重新连接后恢复设置。`); }
        }
        if (trustedFingerprint) storeTrustedFingerprint(info, trustedFingerprint);
        const tab: ClusterTab = {
          kind: 'cluster',
          sessionId: data.sessionId,
          connInfo: { host: info.host, port: String(info.port), username: info.username },
          home: data.home || '',
          messages: [],
          activeConversationId: null,
          conversationContextId: createConversationContextId(),
          conversationSummary: '',
          schedulerLabel: data.schedulerLabel,
        };
        setTabs(prev => [...prev, tab]);
        setActiveTabId(data.sessionId);
        setWorkspaceView('chat');
        return null;
      }
      const error = data.error || (data.code === 'HOST_FINGERPRINT_REQUIRED' ? '未确认主机指纹，登录已取消' : '登录失败');
      setLoginError(error);
      return error;
    } catch {
      setLoginError('网络错误，请重试');
      return '网络错误，请重试';
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleAddCluster = async (info: LoginCredentials) => {
    const error = await connectCluster(info);
    if (!error) setAddingCluster(false);
    return error;
  };

  // ─── Close tab（断开单个集群）───────────────────────────────────
  const handleCloseTab = useCallback(async (sessionId: string) => {
    const tab = tabsRef.current.find(t => t.sessionId === sessionId);
    if (!tab || tab.kind === 'local') return;
    // 关闭前保存该标签的对话到其所属集群
    if (tab && tab.messages.length > 0) {
      try {
        await saveConversation(tab.messages, tab.activeConversationId, sessionId, tab.conversationContextId);
      } catch (e) {
        console.error('[handleCloseTab] save failed:', e);
      }
    }
    try {
      await fetch('/api/logout', {
        method: 'POST',
        headers: sessionHeaders(sessionId),
        body: JSON.stringify({ sessionId }),
      });
    } catch { /* 网络失败也继续本地清理 */ }

    terminalRefs.current.delete(sessionId);
    setSockets(prev => {
      const next = { ...prev };
      next[sessionId]?.disconnect();
      delete next[sessionId];
      return next;
    });
    setTabs(prev => {
      const next = prev.filter(t => t.sessionId !== sessionId);
      if (sessionId === activeTabId) {
        const neighbor = next.find(item => item.kind === 'cluster') ?? next.find(item => item.kind === 'local');
        setActiveTabId(neighbor ? neighbor.sessionId : null);
      }
      return next;
    });
  }, [activeTabId, saveConversation]);

  // ─── 集群标签排序（集群控制台标签条；from/to 是集群子数组下标）─────────
  // tabs 固定本地工作台在首位，ClusterTabStrip 只展示集群子数组：
  // 这里只重排集群之间的相对顺序，本地与其他槽位不动。
  const reorderClusterTabs = useCallback((from: number, to: number) => {
    setTabs(prev => {
      const clusters = prev.filter(t => t.kind === 'cluster');
      if (from === to || from < 0 || to < 0 || from >= clusters.length || to >= clusters.length) return prev;
      const reordered = [...clusters];
      const [moved] = reordered.splice(from, 1);
      reordered.splice(to, 0, moved);
      let i = 0;
      return prev.map(t => (t.kind === 'cluster' ? reordered[i++]! : t));
    });
  }, []);

  // ─── Conversation handlers ─────────────────────────────────────
  // seed：用给定内容直接替换出一个新对话（流程运行专属对话走这里）；不传则是空对话
  // 新建在当前选中的计算目标下进行（本地工作台 / 某集群各自独立的对话）
  const handleNewConversation = useCallback((seed?: WorkflowRunConversationSeed) => {
    if (loadAbortRef.current) loadAbortRef.current.abort();
    const conversationTabId = activeTabIdRef.current || LOCAL_WORKBENCH_ID;
    const current = tabsRef.current.find(tab => tab.sessionId === conversationTabId);
    if (!current) return;
    const storageKey = conversationStorageKey(current);
    const timer = autoSaveTimersRef.current.get(storageKey);
    if (timer) clearTimeout(timer);
    autoSaveTimersRef.current.delete(storageKey);
    autoSaveEpochRef.current.set(storageKey, (autoSaveEpochRef.current.get(storageKey) || 0) + 1);
    updateTab(conversationTabId, seed ?? {
      activeConversationId: null,
      conversationContextId: createConversationContextId(),
      conversationSummary: '',
      messages: [],
    });
    setLoadingConversationId(null);
  }, [updateTab]);

  const handleLoadConversation = useCallback(async (id: string) => {
    const tabId = activeTabIdRef.current || LOCAL_WORKBENCH_ID;
    const current = tabsRef.current.find(tab => tab.sessionId === tabId);
    if (!current) return;
    const currentStorageKey = conversationStorageKey(current);
    const pendingSave = autoSaveTimersRef.current.get(currentStorageKey);
    if (pendingSave) clearTimeout(pendingSave);
    autoSaveTimersRef.current.delete(currentStorageKey);
    autoSaveEpochRef.current.set(currentStorageKey, (autoSaveEpochRef.current.get(currentStorageKey) || 0) + 1);
    // Abort any in-flight load
    if (loadAbortRef.current) {
      loadAbortRef.current.abort();
    }
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoadingConversationId(id);
    // Immediately change the context key so an in-flight response from the old
    // conversation can no longer write into this tab while the archive loads.
    updateTab(tabId, {
      activeConversationId: id,
      conversationContextId: `saved-${id}`,
      conversationSummary: '',
      messages: [],
    });
    // Frontend timeout prevents UI from hanging if backend is stuck
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetchWithRetry(`/api/conversations/${id}`, {
        credentials: 'include' as RequestCredentials,
        headers: { 'X-SSH-Session-Id': tabId },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const data = await res.json();
      // Ignore stale response from aborted request
      if (controller.signal.aborted) return;
      if (data.success && data.conversation?.messages) {
        const loadedContextId = String(data.conversation.contextKey || `saved-${id}`);
        const loadedStorageKey = `${tabId}\u0000${loadedContextId}`;
        autoSaveConversationIdsRef.current.set(loadedStorageKey, id);
        autoSaveSeenMessagesRef.current.set(loadedStorageKey, data.conversation.messages);
        updateTab(tabId, {
          activeConversationId: id,
          conversationContextId: loadedContextId,
          conversationSummary: data.conversation.summary || '',
          messages: data.conversation.messages,
        });
      } else {
        console.warn('[loadConversation] No messages in response, success:', data.success);
      }
    } catch (e: any) {
      clearTimeout(timeout);
      if (e.name !== 'AbortError') {
        console.error('[loadConversation] Failed to load:', id, e);
        updateTab(tabId, {
          messages: [{ role: 'system', content: `加载对话失败: ${e.message || '未知错误'}` }],
          activeConversationId: id,
        });
      }
    } finally {
      if (loadAbortRef.current === controller) {
        loadAbortRef.current = null;
      }
      setLoadingConversationId(null);
    }
  }, [updateTab]);

  // ─── 作业完成 / AI 续跑提醒中枢：socket 监听 → toast + 桌面通知 + 未读角标 ───
  // toast/桌面通知的点击动作：跳到计算资源视图并展开作业面板 / 打开对应对话
  const openJobsView = useCallback(() => {
    handleSidebarTabChange('compute');
    setClusterJobsOpen(true);
  }, [handleSidebarTabChange]);

  const openConversationFromNotification = useCallback((conversationId: string) => {
    setWorkspaceView('chat');
    setWorkbenchSidebarTab('conversations');
    // 先查出对话归属的计算目标并切换过去，再加载，避免跨目标错载
    void (async () => {
      try {
        const res = await fetch(`/api/conversations/${conversationId}`, { credentials: 'include' as RequestCredentials });
        const data = await res.json();
        const scope = data?.conversation?.scopeKey;
        if (scope && scope !== activeTabIdRef.current && tabsRef.current.some(t => t.sessionId === scope)) {
          setActiveTabId(scope);
        }
      } catch { /* 查不到就按当前目标加载 */ }
      void handleLoadConversation(conversationId);
    })();
  }, [handleLoadConversation]);

  // 聚合对话列表跨集群加载：等目标标签激活后再加载,避免错载到当前标签
  useEffect(() => {
    const pending = pendingConversationLoadRef.current;
    if (!pending) return;
    pendingConversationLoadRef.current = null;
    void handleLoadConversation(pending);
  }, [activeTabId, handleLoadConversation]);

  const jobNotificationCenter = useJobNotificationCenter({
    sockets,
    workbenchSidebarTab,
    activeConversationId: activeTab?.activeConversationId ?? null,
    onOpenJobsView: openJobsView,
    onOpenConversation: openConversationFromNotification,
    t,
  });

  // ─── Terminal AI callbacks ──────────────────────────────────────
  const handleAnalyzeError = useCallback((selectedText: string) => {
    if (!activeTabId) return;
    const text = selectedText.length > 5000
      ? selectedText.slice(0, 5000) + '\n...[truncated]'
      : selectedText;
    const targetTabId = activeTabIdRef.current || LOCAL_WORKBENCH_ID;
    const tab = tabsRef.current.find(t => t.sessionId === targetTabId);
    const msg: Message = {
      role: 'user',
      content: isEnglish
        ? `I encountered the following terminal output. Analyze it and suggest a solution:\n\`\`\`\n${text}\n\`\`\`\n(The current context is an HPC cluster terminal.)`
        : `我在终端遇到了以下终端输出，请分析并给出建议：\n\`\`\`\n${text}\n\`\`\`\n（当前在 HPC 计算资源终端中操作）`,
    };
    if (tab) updateTab(targetTabId, { messages: [...tab.messages, msg] });
    setWorkspaceView('chat');
    setWorkbenchSidebarTab('conversations');
    setTimeout(() => setTriggerAI(prev => ({ tabId: activeTabId, count: prev.count + 1 })), 0);
  }, [activeTabId, updateTab, isEnglish]);

  const handleSendToAI = useCallback((selectedText: string) => {
    if (!activeTabId) return;
    const text = selectedText.length > 5000
      ? selectedText.slice(0, 5000) + '\n...[truncated]'
      : selectedText;
    const targetTabId = activeTabIdRef.current || LOCAL_WORKBENCH_ID;
    const tab = tabsRef.current.find(t => t.sessionId === targetTabId);
    const msg: Message = {
      role: 'user',
      content: isEnglish
        ? `Please explain the following terminal output:\n\`\`\`\n${text}\n\`\`\`\n(The current context is an HPC cluster terminal.)`
        : `我在终端看到了以下输出，请帮我解读：\n\`\`\`\n${text}\n\`\`\`\n（当前在 HPC 计算资源终端中操作）`,
    };
    if (tab) updateTab(targetTabId, { messages: [...tab.messages, msg] });
    setWorkspaceView('chat');
    setWorkbenchSidebarTab('conversations');
    setTimeout(() => setTriggerAI(prev => ({ tabId: activeTabId, count: prev.count + 1 })), 0);
  }, [activeTabId, updateTab, isEnglish]);

  /** 启动流程运行：自动开一个该次运行专属的对话（标题由协议派生「流程：<名>」），
   *  运行协议与 AI 执行过程都落在专属对话里，不串进当前聊天；每次运行各自独立。 */
  const startWorkflowRunConversation = useCallback((message: string) => {
    if (!activeTabId) return;
    // 复用新建对话的收尾（中止挂起的自动保存/加载），直接以运行协议为首条消息
    handleNewConversation(seedWorkflowRunConversation(message));
    // 切到对话视图 + 对话记录导航，让用户看到新对话正在跑
    setWorkspaceView('chat');
    setWorkbenchSidebarTab('conversations');
    setTimeout(() => setTriggerAI(previous => ({ tabId: activeTabId, count: previous.count + 1 })), 0);
  }, [activeTabId, handleNewConversation]);

  /** 流程主页面创建/恢复运行后，把执行协议交给后台 AI。
   *  dedicatedConversation=true（启动/恢复正式运行）→ 开专属对话；
   *  缺省（环境补齐等讨论消息）→ 留在当前对话。 */
  const handleRunWorkflow = useCallback((message: string, options?: { dedicatedConversation?: boolean }) => {
    if (!activeTabId) return;
    if (options?.dedicatedConversation) {
      startWorkflowRunConversation(message);
      return;
    }
    const targetTabId = activeTabIdRef.current || LOCAL_WORKBENCH_ID;
    const tab = tabsRef.current.find(item => item.sessionId === targetTabId);
    if (!tab) return;
    updateTab(targetTabId, { messages: [...tab.messages, { role: 'user', content: message }] });
    // 与终端“发给 AI/分析错误”一致：消息进对话后立即切到对话视图，
    // 否则用户停在流程页看不到任何反应，会误以为没有点成功（v0.4.26 修复）。
    setWorkspaceView('chat');
    setWorkbenchSidebarTab('conversations');
    setTimeout(() => setTriggerAI(previous => ({ tabId: activeTabId, count: previous.count + 1 })), 0);
  }, [activeTabId, updateTab, startWorkflowRunConversation]);

  // ─── 稳定 props：配合 memo 挡住 AI 消息流引发的 App 重渲染扇出 ─────────
  // 每个“集群 + 对话上下文”的 AIChat 回调缓存一次。旧请求即使在切换后
  // 才完成，也只能写回自己的 contextId，不能污染当前对话。
  const tabCallbacksRef = useRef<Map<string, TabCallbacks>>(new Map());
  const getTabCallbacks = useCallback((executionSessionId: string, contextId: string, storageSessionId = executionSessionId): TabCallbacks => {
    const callbackKey = `${storageSessionId}\u0000${contextId}\u0000execute:${executionSessionId}`;
    let cbs = tabCallbacksRef.current.get(callbackKey);
    if (!cbs) {
      cbs = {
        executeCommand: (cmd, waitAndCapture = true, silent = false) => {
          const handle = terminalRefs.current.get(executionSessionId);
          return handle
            ? handle.executeCommand(cmd, waitAndCapture, silent)
            : Promise.resolve(executionSessionId === LOCAL_WORKBENCH_ID ? '[提示]: 当前使用本地 AI 模式，未选择计算资源' : '[错误]: 计算资源终端未就绪');
        },
        onMessagesChange: msgs => updateConversationTab(storageSessionId, contextId, { messages: msgs }),
      };
      tabCallbacksRef.current.set(callbackKey, cbs);
    }
    return cbs;
  }, [updateConversationTab]);

  useEffect(() => {
    if (tabCallbacksRef.current.size > 24) tabCallbacksRef.current.clear();
  }, [tabs, activeTabId]);

  // 传输工作区回调：关闭（路径选取中则视为取消）/ 最大化切换
  const handleCloseFileTransfer = useCallback(() => {
    if (pathPick) finishPathPick(null);
    else setFileTransferOpen(false);
  }, [pathPick, finishPathPick]);
  const handleToggleFileTransferMaximize = useCallback(() => setFileTransferMaximized(prev => !prev), []);
  const pickFolderProp = useMemo(
    () => (pathPick
      ? { kind: pathPick.kind, onPick: (p: string) => finishPathPick(p), onCancel: () => finishPathPick(null) }
      : undefined),
    [pathPick, finishPathPick],
  );
  // 端点列表只用到 tabs 的连接字段：依赖收敛为字段签名，
  // 消息流刷新 tabs（messages 变化）时数组引用保持稳定（tabs 数组本身每次都换引用，不能直接做依赖）
  const endpointsKey = tabs.map(t => `${t.sessionId}\t${t.connInfo.username}\t${t.connInfo.host}\t${t.home}`).join('\n');
  const endpoints = useMemo<EndpointOption[]>(
    () => [
      ...(!publicWeb ? [{ id: 'local', label: '本地' }] : []),
      ...tabs.filter(t => t.kind === 'cluster').map(t => ({
        id: t.sessionId,
        label: `${t.connInfo.username}@${t.connInfo.host}`,
        home: t.home || undefined,
      })),
    ],
    [endpointsKey], // eslint-disable-line react-hooks/exhaustive-deps -- 依赖已收敛为字段签名
  );

  // ─── Render ─────────────────────────────────────────────────────
  const computeTargets = tabs.map(t => ({
    id: t.sessionId,
    label: t.kind === 'local' ? '本地 AI 工作台' : `${t.connInfo.username}@${t.connInfo.host}`,
    detail: t.kind === 'local'
      ? '无需服务器，可本地分析'
      : `${t.connInfo.host}:${t.connInfo.port} · SSH 已连接${t.schedulerLabel ? ` · ${t.schedulerLabel}` : ''}`,
    kind: t.kind,
  }));
  const activeComputeLabel = activeClusterTab
    ? `${activeClusterTab.connInfo.username}@${activeClusterTab.connInfo.host}`
    : publicWeb ? '请登录自己的集群' : '本地 AI · 未使用计算资源';
  const connectedComputeCount = computeTargets.filter(target => target.kind === 'cluster').length;
  const conversationTab = activeTab;
  // 对话在哪个计算目标上打开，就在哪里执行：本地工作台 = 本地模式，集群 = 该集群
  const executionSessionId = conversationTab?.sessionId ?? LOCAL_WORKBENCH_ID;
  const chatCallbacks = conversationTab
    ? getTabCallbacks(executionSessionId, conversationTab.conversationContextId, conversationTab.sessionId)
    : null;

  return (
    <div className="h-[100dvh] w-screen bg-scholar-950 flex font-sans text-scholar-50 overflow-hidden">
      <WorkbenchSidebar
        activeTab={workbenchSidebarTab}
        onActiveTabChange={handleSidebarTabChange}
        connectedComputeCount={connectedComputeCount}
        unreadCounts={{ compute: jobNotificationCenter.jobUnread, conversations: jobNotificationCenter.conversationUnread }}
        onOpenQQBotSettings={() => setShowQQBotSettings(true)}
        onOpenUpdateCenter={() => setShowUpdateCenter(true)}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        sessionId={activeTab?.sessionId}
        home={activeClusterTab?.home}
        activeConversationId={conversationTab?.activeConversationId}
        loadingConversationId={loadingConversationId}
        conversationRefresh={convListRefresh}
        onLoadConversation={(id, sessionId) => {
          setWorkspaceView('chat');
          // 聚合列表条目按来源切换标签:本地条目切回本地工作台,集群条目切到对应集群,
          // 激活后由 effect 完成加载(避免错载到当前标签)
          const targetTab = sessionId === 'local-workbench' ? LOCAL_WORKBENCH_ID : sessionId;
          if (targetTab && targetTab !== activeTabIdRef.current
            && tabsRef.current.some(t => t.sessionId === targetTab)) {
            pendingConversationLoadRef.current = id;
            setActiveTabId(targetTab);
            return;
          }
          void handleLoadConversation(id);
        }}
        onNewConversation={() => {
          setWorkspaceView('chat');
          handleNewConversation();
        }}
        selectedWorkflowId={selectedWorkflow?.id}
        onSelectWorkflow={workflow => {
          setSelectedWorkflow(workflow);
          setWorkspaceView('workflow');
        }}
        onManageWorkflows={() => setWorkspaceView('workflowManage')}
        selectedPath={selectedRemoteEntry?.path}
        onSelectPath={entry => setSelectedRemoteEntry(entry)}
        pickMode={!!pathPick}
        pickKind={pathPick?.kind}
        onConfirmPick={path => finishPathPick(path)}
        onCancelPick={() => finishPathPick(null)}
        computeTargets={computeTargets}
        activeComputeTargetId={activeComputeTab?.sessionId ?? LOCAL_WORKBENCH_ID}
        onSelectComputeTarget={id => {
          setActiveTabId(id);
          // 集群目标进控制台；本地 AI 工作台回对话（与资源管理抽屉的选择语义一致）
          setWorkspaceView(id === LOCAL_WORKBENCH_ID ? 'chat' : 'cluster');
        }}
        onAddCluster={() => {
          setComputeBackendOpen(false);
          setAddingCluster(true);
        }}
        onOpenComputeBackend={() => setComputeBackendOpen(true)}
      />

      <main className="flex-1 min-w-0 h-full relative overflow-hidden bg-scholar-900">
          {publicWeb && !conversationTab && (
            <div className="h-full flex flex-col items-center justify-center gap-4 p-6 text-center">
              <h1 className="text-xl text-scholar-100">连接你的集群，开始分析</h1>
              <p className="text-sm text-scholar-400">使用自己的集群账号和 AI API Key。对话与私人流程保存在你的集群用户目录。</p>
              <button className="btn-primary" onClick={() => setAddingCluster(true)}>登录集群</button>
            </div>
          )}
          {/* 全局对话常驻挂载；切换计算目标、流程或打开算力后台都不会中断。 */}
          {conversationTab && chatCallbacks && (
            <div
              key={conversationTab.conversationContextId}
              className={workspaceView === 'chat' ? 'h-full' : 'hidden'}
            >
              <AIChat
                isOpen
                executeCommand={chatCallbacks.executeCommand}
                socket={activeClusterTab ? (sockets[activeClusterTab.sessionId] ?? null) : null}
                sessionId={executionSessionId}
                onSkillsChange={noopSkillsChange}
                messages={conversationTab.messages}
                onMessagesChange={chatCallbacks.onMessagesChange}
                onNewChat={handleNewConversation}
                triggerAI={triggerAI}
                aiClusterControl={!!activeClusterTab && aiClusterControl}
                activeConversationId={conversationTab.activeConversationId}
                conversationContextId={conversationTab.conversationContextId}
                loadingConversationId={loadingConversationId}
                conversationSummary={conversationTab.conversationSummary}
                onPickRemoteFolder={activeClusterTab ? requestRemotePath : undefined}
                onOpenRemoteFolder={openRemoteFolder}
                workspaceLayout
                workspaceTargetLabel={activeComputeLabel}
                workspaceTargetConnected={!!activeClusterTab}
                onOpenComputeBackend={() => setWorkspaceView('cluster')}
                jobStatusBar={(
                  <ClusterJobStatusBar
                    sessionId={activeClusterTab?.sessionId}
                    targetLabel={activeComputeLabel}
                    onOpenDetails={() => {
                      if (!activeClusterTab) {
                        setComputeBackendOpen(true);
                        return;
                      }
                      setClusterJobsOpen(true);
                      setWorkspaceView('cluster');
                    }}
                  />
                )}
                onOpenWebPanel={openWebPanel}
                onStartWorkflowRun={startWorkflowRunConversation}
                onEnsureConversation={async (msgs) => {
                  const targetTabId = activeTabIdRef.current || LOCAL_WORKBENCH_ID;
                  const tab = tabsRef.current.find(t => t.sessionId === targetTabId);
                  if (!tab) return null;
                  if (tab.activeConversationId) return tab.activeConversationId;
                  return saveConversation(msgs, null, tab.sessionId, tab.conversationContextId);
                }}
              />
            </div>
          )}

          {/* 流程运行面板常驻挂载（hidden 保活）：切去对话再回来，已选输入/参数/预检结果不丢失。
              与集群终端的保活策略一致；换个流程时靠 key 重置。 */}
          {selectedWorkflow && (
            <div className={workspaceView === 'workflow' ? 'h-full' : 'hidden'}>
              <FlowRunnerDrawer
                key={selectedWorkflow.id}
                embedded
                workflow={selectedWorkflow}
                sessionId={activeClusterTab?.sessionId}
                socket={activeClusterTab ? (sockets[activeClusterTab.sessionId] ?? null) : null}
                onClose={() => setWorkspaceView('chat')}
                onRun={handleRunWorkflow}
                onPickFolder={activeClusterTab ? requestRemotePath : undefined}
                onOpenRunFolder={path => openRemoteFolder(path, activeClusterTab?.sessionId)}
              />
            </div>
          )}

          {workspaceView === 'workflow' && !selectedWorkflow && (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-center text-scholar-400 px-6">
              <p className="text-sm text-scholar-200">从左侧“流程”选择一个正式流程</p>
              <button type="button" className="btn-primary" onClick={() => setWorkbenchSidebarTab('workflows')}>浏览流程</button>
            </div>
          )}

          {/* 流程管理页：新建/编辑/AI 生成/文献学习；运行入口回到流程主页面 */}
          {workspaceView === 'workflowManage' && (
            <div className="h-full flex flex-col bg-scholar-900">
              <div className="h-14 px-5 border-b border-scholar-700 flex items-center gap-3 shrink-0">
                <button type="button" onClick={() => setWorkspaceView('chat')} className="text-xs text-accent hover:underline shrink-0">返回对话</button>
                <div className="min-w-0">
                  <h1 className="text-sm font-semibold text-scholar-50">流程管理</h1>
                  <p className="mt-0.5 text-[10px] text-scholar-500">新建、编辑、AI 生成与文献学习正式流程</p>
                </div>
              </div>
              <WorkflowPanel
                onUseWorkflow={message => {
                  setWorkspaceView('chat');
                  handleRunWorkflow(message);
                }}
                onOpenRunner={workflow => {
                  setSelectedWorkflow(workflow);
                  setWorkspaceView('workflow');
                }}
                aiProfile={loadAIProfile()}
                sessionId={activeClusterTab?.sessionId}
                socket={activeClusterTab ? (sockets[activeClusterTab.sessionId] ?? null) : null}
              />
            </div>
          )}

          {/* 集群控制台：整页终端视图。始终挂载（hidden 保活），
              终端会话与 AI 后台执行不随视图切换中断。 */}
          <div className={workspaceView === 'cluster' ? 'h-full' : 'hidden'}>
            <ClusterConsole
              tabs={tabs.filter(tab => tab.kind === 'cluster').map(tab => ({
                id: tab.sessionId,
                label: `${tab.connInfo.username}@${tab.connInfo.host}`,
                sublabel: `${tab.connInfo.host}:${tab.connInfo.port} · SSH`,
              }))}
              activeId={activeClusterTab?.sessionId ?? null}
              onSelectTab={id => setActiveTabId(id)}
              onReorderTabs={reorderClusterTabs}
              onCloseTab={id => void handleCloseTab(id)}
              onAddCluster={() => setAddingCluster(true)}
              jobsOpen={clusterJobsOpen}
              onToggleJobs={() => setClusterJobsOpen(open => !open)}
              onOpenFileTransfer={() => {
                if (activeClusterTab) setFileTransferOpen(true);
              }}
              onOpenBackend={() => setComputeBackendOpen(true)}
              hasCluster={tabs.some(tab => tab.kind === 'cluster')}
              terminalContent={(
                <>
                  {tabs.filter(tab => tab.kind === 'cluster').map(tab => (
                    <div key={`terminal-${tab.sessionId}`} className={tab.sessionId === activeClusterTab?.sessionId ? 'h-full min-w-0 flex flex-col' : 'hidden'}>
                      <TabTerminal
                        tab={tab}
                        isActive={workspaceView === 'cluster' && tab.sessionId === activeClusterTab?.sessionId}
                        isSidebarOpen
                        registerTerminal={registerTerminal}
                        onSocketReady={sock => setSockets(prev => ({ ...prev, [tab.sessionId]: sock }))}
                        onAnalyzeError={handleAnalyzeError}
                        onSendToAI={handleSendToAI}
                        onFileLinkClick={handleTerminalFileClick}
                      />
                    </div>
                  ))}
                </>
              )}
              jobsContent={(
                <JobsPanel
                  isOpen={workspaceView === 'cluster' && clusterJobsOpen}
                  onClose={() => setClusterJobsOpen(false)}
                  sessionId={activeClusterTab?.sessionId ?? null}
                />
              )}
            />
          </div>

          {/* 数据资源页：公共生信数据库 API 目录与连通性测试。
              始终挂载（hidden 保活），卡片展开/搜索结果不随视图切换丢失。 */}
          <div className={workspaceView === 'webapis' ? 'h-full' : 'hidden'}>
            <WebApisPanel onAskAi={askAi} />
          </div>

        </main>

      <ComputeBackendDrawer
        open={computeBackendOpen}
        targets={computeTargets}
        activeTargetId={activeComputeTab?.sessionId ?? LOCAL_WORKBENCH_ID}
        aiClusterControl={aiClusterControl}
        onClose={() => setComputeBackendOpen(false)}
        onSelectTarget={id => {
          setActiveTabId(id);
          if (id !== LOCAL_WORKBENCH_ID) setWorkspaceView('cluster');
          setComputeBackendOpen(false);
        }}
        onAddCluster={() => {
          setComputeBackendOpen(false);
          setAddingCluster(true);
        }}
        onDisconnect={id => void handleCloseTab(id)}
        onToggleAiCluster={() => setAiClusterControl(value => !value)}
        onOpenFileTransfer={() => {
          if (activeClusterTab) setFileTransferOpen(true);
        }}
        onOpenTerminal={() => {
          setWorkspaceView('cluster');
          setComputeBackendOpen(false);
        }}
      />

      {/* ── File Transfer Workspace (overlay)：常驻挂载，关闭只是隐藏 ──
          关闭后传输在后台继续，面板路径/队列/编辑会话全部保留；左右面板各自可切换端点 ── */}
      {!publicWeb && <Suspense fallback={fileTransferOpen ? <div className="fixed inset-0 z-30 bg-scholar-950/80 flex items-center justify-center text-scholar-400 text-sm">加载中…</div> : null}>
        <MemoFileTransferWorkspace
          sessionId={activeClusterTab?.sessionId ?? null}
          connectionState={activeClusterTab ? 'connected' : 'disconnected'}
          username={activeClusterTab?.connInfo.username ?? ''}
          socket={activeClusterTab ? (sockets[activeClusterTab.sessionId] ?? null) : null}
          onClose={handleCloseFileTransfer}
          onToggleMaximize={handleToggleFileTransferMaximize}
          visible={fileTransferOpen}
          pickFolder={pickFolderProp}
          endpoints={endpoints}
          openLocation={fileTransferLocation}
        />
      </Suspense>}

      {/* ── 添加集群（登录弹窗，不影响已有会话）── */}
      {publicWeb && fileTransferOpen && activeClusterTab && <PublicClusterFiles
        key={`${activeClusterTab.sessionId}:${fileTransferLocation?.requestId || ''}`}
        sessionId={activeClusterTab.sessionId} home={activeClusterTab.home}
        initialPath={fileTransferLocation?.path} onClose={handleCloseFileTransfer}
        pick={pathPick ? { kind: pathPick.kind, onConfirm: finishPathPick } : undefined}
      />}
      <AnimatePresence>
        {addingCluster && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-[80] bg-scholar-950/80 flex items-center justify-center p-4 backdrop-blur-sm"
            onClick={() => setAddingCluster(false)}
          >
            {/* 内容超高时可滚动，否则下方的账号下拉/输入框够不到 */}
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 12 }}
              transition={{ duration: 0.18 }}
              className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-lg"
              onClick={e => e.stopPropagation()}
            >
              <LoginForm
                onLogin={handleAddCluster}
                isLoggingIn={isLoggingIn}
                loginError={loginError}
                embedded
                onCancel={() => setAddingCluster(false)}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── 终端文件名点击预览 (overlay) ── */}
      {previewTarget && (
        <FilePreview
          file={previewTarget}
          source="remote"
          sessionId={activeClusterTab?.sessionId}
          onClose={() => setPreviewTarget(null)}
        />
      )}

      {/* ── 侧边网页栏：AI 答复链接 / 集群远程 HTML ── */}
      <WebPanelDrawer
        panels={webPanel.tabs}
        activeIndex={webPanel.active}
        onSelectTab={selectWebPanelTab}
        onCloseTab={closeWebPanelTab}
        onClose={closeWebPanel}
      />

      {/* ── QQ 机器人配置 (overlay) ── */}
      {showQQBotSettings && (
        <QQBotSettingsDialog onClose={() => setShowQQBotSettings(false)} />
      )}

      {showUpdateCenter && (
        <UpdateCenterDialog onClose={() => setShowUpdateCenter(false)} />
      )}

      {/* ── 作业完成 / AI 续跑的应用内浮层提醒（右下角，点击跳转）── */}
      <JobToastStack
        toasts={jobNotificationCenter.toasts}
        onActivate={jobNotificationCenter.activateToast}
        onDismiss={jobNotificationCenter.dismissToast}
      />
    </div>
  );
}

/** 单个标签的终端：持有自己的 TerminalHandle 并注册到 App 的映射表 */
function TabTerminal({
  tab,
  isActive,
  isSidebarOpen,
  registerTerminal,
  onSocketReady,
  onAnalyzeError,
  onSendToAI,
  onFileLinkClick,
}: {
  tab: ClusterTab;
  isActive: boolean;
  isSidebarOpen: boolean;
  registerTerminal: (sessionId: string, handle: TerminalHandle | null) => void;
  onSocketReady: (socket: Socket) => void;
  onAnalyzeError: (text: string) => void;
  onSendToAI: (text: string) => void;
  onFileLinkClick: (pathText: string) => void;
}) {
  const ref = useRef<TerminalHandle>(null);

  useEffect(() => {
    registerTerminal(tab.sessionId, ref.current);
    return () => registerTerminal(tab.sessionId, null);
  }, [tab.sessionId, registerTerminal]);

  return (
    <TerminalAI
      terminalRef={ref}
      isSidebarOpen={isSidebarOpen}
      isLoggedIn={true}
      isActive={isActive}
      sshSessionId={tab.sessionId}
      onSocketReady={onSocketReady}
      onAnalyzeError={onAnalyzeError}
      onSendToAI={onSendToAI}
      onFileLinkClick={onFileLinkClick}
    />
  );
}
