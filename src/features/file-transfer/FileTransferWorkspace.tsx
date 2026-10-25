import { useReducer, useEffect, useCallback, useRef, useState, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { Socket } from 'socket.io-client';
import { reduceFileTransfer, initialFileTransferState } from './controller';
import type { ConnectionState, TransferTask, FileEntry, PickPathKind } from '@/shared/fileTransfer';
import type { FileSide } from '@/shared/fileTransfer';
import type { RemoteEditEvent, RemoteEditSession } from '@/shared/remoteEdit';
import { makeTemporaryTransferName } from '@/shared/fileTransfer';
import FileTransferDrawer from './FileTransferDrawer';
import HostManager from './HostManager';
import LocalFilePane from './LocalFilePane';
import RemoteFilePane from './RemoteFilePane';
import ConflictDialog from './ConflictDialog';
import TransferQueue from './TransferQueue';
import SearchPanel from './SearchPanel';
import SyncPlannerDialog from './SyncPlannerDialog';
import FilePreview from './FilePreview';
import PickConfirmBar from './PickConfirmBar';
import { createDroppedTransfer, planClipboardMoves } from './FilePane';
import { enqueueTransfer, enqueueTransfersBatch, pauseTransfer, resumeTransfer, cancelTransfer, retryTransfer, clearCompletedTransfers, copyRemote, renameRemote, mkdirRemote, statRemote, walkRemote, preflightRemoteCopy } from './api';
import { expandForUpload, expandForDownload, expandForRemoteCopy } from './folderTransfer';
import {
  canOpenCachedEditSession,
  createEditDownloadTask,
  createEditUploadTask,
} from './editSessionController';
import { resolveTransferProfileId } from './sessionIdentity';
import { endpointPathOrDefault, rememberEndpointPath, rememberResolvedEndpointPath } from './endpointPathMemory';
import { LOCAL_DRIVES_ROOT, isLocalDrivesRoot } from './localDrives';
import { toDisplayError } from '../../utils/displayError';

/** 传输面板端点：本地 或 某个已连接集群 */
export interface EndpointOption {
  id: string; // 'local' 或 sessionId
  label: string; // 显示名，如 本地 / user@login.example.edu
  home?: string; // 集群端点的家目录（本地端点无）
}

/** 服务端批量入队单次上限（与 /api/transfers/batch 一致） */
const TRANSFER_BATCH_SIZE = 500;

/** 文件夹展开后的批量入队：按服务端单次上限分片，一次请求代替逐条 POST */
async function enqueueInBatches(
  sessionId: string,
  inputs: Parameters<typeof enqueueTransfersBatch>[1],
): Promise<TransferTask[]> {
  const tasks: TransferTask[] = [];
  for (let i = 0; i < inputs.length; i += TRANSFER_BATCH_SIZE) {
    tasks.push(...await enqueueTransfersBatch(sessionId, inputs.slice(i, i + TRANSFER_BATCH_SIZE)));
  }
  return tasks;
}

interface FileTransferWorkspaceProps {
  sessionId: string | null;
  connectionState: ConnectionState;
  profileId?: string;
  username?: string;
  socket?: Socket | null;
  onClose: () => void;
  onToggleMaximize: () => void;
  /** 多集群标签：本实例是否为当前可见的工作区（不可见时保持挂载，传输不中断） */
  visible?: boolean;
  /** 可选端点列表（本地 + 各已连接集群）；左右面板各自可切换，实现集群↔集群互传 */
  endpoints?: EndpointOption[];
  /** "选择路径"模式：只显示远程窗格 + 底部确认栏（流程面板选输入文件/目录用） */
  pickFolder?: {
    onPick: (path: string) => void;
    onCancel: () => void;
    /** 可选条目类型：只选文件 / 只选目录 / 均可（默认 any，维持旧行为） */
    kind?: PickPathKind;
  };
  /** 从流程运行记录等入口直接定位到指定集群目录。 */
  openLocation?: {
    sessionId: string;
    path: string;
    requestId: number;
  };
  /** 向主导航报告后台传输活动/失败数量。 */
  onTransferIndicatorsChange?: (indicators: { active: number; failed: number }) => void;
}

export default function FileTransferWorkspace({
  sessionId,
  connectionState,
  profileId,
  username = '',
  socket,
  onClose,
  onToggleMaximize,
  visible = true,
  endpoints: endpointsProp,
  pickFolder,
  openLocation,
  onTransferIndicatorsChange,
}: FileTransferWorkspaceProps) {
  const [state, dispatch] = useReducer(
    reduceFileTransfer,
    initialFileTransferState,
  );

  // Additional UI state
  const [searchOpen, setSearchOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [paneRefreshToken, setPaneRefreshToken] = useState(0);
  const [transferError, setTransferError] = useState('');
  const [previewTarget, setPreviewTarget] = useState<{
    file: FileEntry;
    source: FileSide;
    endpoint?: string;
  } | null>(null);
  const [editSessions, setEditSessions] = useState<RemoteEditSession[]>([]);
  const editSessionsRef = useRef(new Map<string, RemoteEditSession>());
  const editTransferLinksRef = useRef(new Map<string, {
    editSessionId: string;
    phase: 'download' | 'upload';
    fingerprint?: string;
  }>());
  const handledEditTransfersRef = useRef(new Set<string>());
  const uploadingEditSessionsRef = useRef(new Set<string>());
  const editSessionFilesRef = useRef(new Map<string, FileEntry>());
  const terminalTransfersRef = useRef(new Set<string>());
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 每个端点有自己的最后访问路径。面板左/右只是显示槽位，不应把
  // A 集群的路径当成 B 集群的状态，也不应在切回 A 时丢失。
  const endpointPathsRef = useRef(new Map<string, string>());
  const endpointForPaneRef = useRef({ left: 'local', right: sessionId ?? 'local' });

  // Open drawer on mount
  useEffect(() => {
    dispatch({ type: 'drawer/open' });
  }, []);

  // Sync connection state from parent
  useEffect(() => {
    dispatch({ type: 'connection/state', connectionState });
  }, [connectionState]);

  // Connect if a profile id or an already authenticated SSH session is provided
  useEffect(() => {
    const activeProfileId = resolveTransferProfileId({
      activeProfileId: '',
      profileId,
      sessionId,
    });
    if (activeProfileId && sessionId) {
      dispatch({
        type: 'profile/connected',
        profileId: activeProfileId,
        sessionId,
      });
    }
  }, [profileId, sessionId]);

  // Subscribe to Socket.IO transfer updates
  useEffect(() => {
    if (!socket) return;
    const onTransferUpdated = (task: TransferTask) => {
      dispatch({ type: 'transfer/upsert', task });
      if (task.state === 'completed' && !terminalTransfersRef.current.has(task.id)) {
        terminalTransfersRef.current.add(task.id);
        if (refreshTimerRef.current !== null) clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(() => {
          refreshTimerRef.current = null;
          setPaneRefreshToken(token => token + 1);
        }, 250);
      }
    };
    const onTransferSummary = (summary: { total: number }) => {
      // Summary received — transfers are being tracked server-side
    };
    socket.on('transfer:updated', onTransferUpdated);
    socket.on('transfer:summary', onTransferSummary);
    return () => {
      socket.off('transfer:updated', onTransferUpdated);
      socket.off('transfer:summary', onTransferSummary);
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [socket]);

  const handleClose = useCallback(() => {
    // 只通知外层隐藏（visible=false），不 dispatch drawer/close：
    // 工作区常驻挂载，关闭后传输在后台继续，面板路径/队列/编辑会话全部保留
    onClose();
  }, [onClose]);

  const handleToggleMaximize = useCallback(() => {
    dispatch({ type: 'drawer/toggleMaximize' });
    onToggleMaximize();
  }, [onToggleMaximize]);

  const handleConnect = useCallback(
    (id: string) => {
      if (sessionId) {
        dispatch({
          type: 'profile/connected',
          profileId: id,
          sessionId,
        });
      }
    },
    [sessionId],
  );

  const handleLocalNavigate = useCallback(
    (path: string, entries: any[], loading?: boolean, error?: string) => {
      rememberResolvedEndpointPath(
        endpointPathsRef.current,
        endpointForPaneRef.current.left,
        path,
        loading,
        error,
      );
      dispatch({
        type: 'pane/navigate',
        side: 'local',
        path,
        entries,
        loading,
        error,
      });
    },
    [],
  );

  const handleRemoteNavigate = useCallback(
    (path: string, entries: any[], loading?: boolean, error?: string) => {
      rememberResolvedEndpointPath(
        endpointPathsRef.current,
        endpointForPaneRef.current.right,
        path,
        loading,
        error,
      );
      dispatch({
        type: 'pane/navigate',
        side: 'remote',
        path,
        entries,
        loading,
        error,
      });
    },
    [],
  );

  const handleLocalSelect = useCallback((paths: string[]) => {
    dispatch({ type: 'pane/select', side: 'local', paths });
  }, []);

  const handleRemoteSelect = useCallback((paths: string[]) => {
    dispatch({ type: 'pane/select', side: 'remote', paths });
  }, []);

  const handleLocalDeselectAll = useCallback(() => {
    dispatch({ type: 'pane/deselectAll', side: 'local' });
  }, []);

  const handleRemoteDeselectAll = useCallback(() => {
    dispatch({ type: 'pane/deselectAll', side: 'remote' });
  }, []);

  // ─── 面板端点（本地 / 各集群）：左右两侧各自可切换，支持集群↔集群互传 ───
  const endpoints = useMemo<EndpointOption[]>(() => {
    if (endpointsProp && endpointsProp.length > 0) return endpointsProp;
    const list: EndpointOption[] = [{ id: 'local', label: '本地' }];
    if (sessionId) list.push({ id: sessionId, label: username || '计算资源' });
    return list;
  }, [endpointsProp, sessionId, username]);

  const [leftEndpoint, setLeftEndpoint] = useState<string>('local');
  const [rightEndpoint, setRightEndpoint] = useState<string>(sessionId ?? 'local');
  endpointForPaneRef.current = { left: leftEndpoint, right: rightEndpoint };
  const [fileClipboard, setFileClipboard] = useState<{
    endpoint: string;
    paths: string[];
    /** copy=复制粘贴；cut=剪切粘贴（同端点粘贴时执行移动并清空剪贴板） */
    mode: 'copy' | 'cut';
  } | null>(null);

  // 端点失效（标签关闭）时回退；两侧不允许同一端点
  useEffect(() => {
    if (!endpoints.some(e => e.id === leftEndpoint)) setLeftEndpoint('local');
  }, [endpoints, leftEndpoint]);
  useEffect(() => {
    if (!endpoints.some(e => e.id === rightEndpoint)) {
      const fallback = sessionId && endpoints.some(e => e.id === sessionId)
        ? sessionId
        : (endpoints.find(e => e.id !== leftEndpoint)?.id ?? 'local');
      setRightEndpoint(fallback);
    }
  }, [endpoints, sessionId, rightEndpoint, leftEndpoint]);

  const endpointHome = (id: string): string =>
    endpoints.find(e => e.id === id)?.home || '/home';

  useEffect(() => {
    if (!openLocation?.path || !endpoints.some(endpoint => endpoint.id === openLocation.sessionId)) return;
    if (leftEndpoint === openLocation.sessionId) setLeftEndpoint('local');
    setRightEndpoint(openLocation.sessionId);
    rememberEndpointPath(endpointPathsRef.current, openLocation.sessionId, openLocation.path);
    dispatch({
      type: 'pane/navigate',
      side: 'remote',
      path: openLocation.path,
      entries: [],
      loading: true,
    });
  }, [openLocation?.requestId]); // eslint-disable-line react-hooks/exhaustive-deps -- requestId 是一次明确导航事件

  // 统一的跨端点传输：src/dst 各自可以是 local 或任一集群
  const transferBetween = useCallback(
    async (srcEndpoint: string, sourcePaths: string[], dstEndpoint: string, targetPath: string) => {
      if (!srcEndpoint || !dstEndpoint || srcEndpoint === dstEndpoint || sourcePaths.length === 0) return;
      const desktop = window.traceDesktop;
      const profileFor = (sid: string) => resolveTransferProfileId({
        activeProfileId: state.activeProfileId,
        profileId,
        sessionId: sid,
      });
      try {
        setTransferError('');
        if (srcEndpoint === 'local') {
          if (!desktop) return;
          // 上传：本地 → dstEndpoint 集群
          const expansion = await expandForUpload(sourcePaths, targetPath, {
            statLocal: p => desktop.localFiles.stat(p),
            walkLocal: p => desktop.localFiles.walk(p),
          });
          if (expansion.truncated) console.warn('[transfer] 文件夹条目过多，已按 5000 项上限截断');
          for (const dir of expansion.targetDirs) {
            try { await mkdirRemote(dstEndpoint, dir); } catch { /* 已存在则忽略 */ }
          }
          try {
            const tasks = await enqueueInBatches(dstEndpoint, expansion.files.map(f => ({
              profileId: profileFor(dstEndpoint),
              sessionId: dstEndpoint,
              direction: 'upload' as const,
              localPath: f.localPath,
              remotePath: f.remotePath,
              temporaryPath: makeTemporaryTransferName(f.remotePath, uuidv4(), 'remote'),
              totalBytes: f.totalBytes,
              transferredBytes: 0,
              conflictPolicy: 'overwrite' as const,
              verificationMode: 'size' as const,
              retryCount: 0,
            })));
            for (const task of tasks) dispatch({ type: 'transfer/upsert', task });
          } catch (err) { console.error('Failed to enqueue uploads:', err); throw err; }
          return;
        }

        // 源为集群：按目标端类型展开（下载必须走 Windows 本地路径映射，互传走 posix 映射）
        const remoteDeps = {
          statRemote: async (p: string) => (await statRemote(srcEndpoint, p)).entry,
          walkRemote: (p: string) => walkRemote(srcEndpoint, p),
        };

        if (dstEndpoint === 'local') {
          if (!desktop) return;
          // 下载：srcEndpoint 集群 → 本地（expandForDownload 产出 Windows 本地路径）
          const expansion = await expandForDownload(sourcePaths, targetPath, remoteDeps);
          if (expansion.truncated) console.warn('[transfer] 文件夹条目过多，已按 5000 项上限截断');
          for (const dir of expansion.targetDirs) {
            try { await desktop.localFiles.mkdir(dir); } catch { /* 已存在则忽略 */ }
          }
          try {
            const tasks = await enqueueInBatches(srcEndpoint, expansion.files.map(f => ({
              profileId: profileFor(srcEndpoint),
              sessionId: srcEndpoint,
              direction: 'download' as const,
              localPath: f.localPath,
              remotePath: f.remotePath,
              temporaryPath: makeTemporaryTransferName(f.localPath, uuidv4(), 'local'),
              totalBytes: f.totalBytes,
              transferredBytes: 0,
              conflictPolicy: 'overwrite' as const,
              verificationMode: 'size' as const,
              retryCount: 0,
            })));
            for (const task of tasks) dispatch({ type: 'transfer/upsert', task });
          } catch (err) { console.error('Failed to enqueue downloads:', err); throw err; }
          return;
        }

        // 集群互传：srcEndpoint → dstEndpoint（SFTP 直传，不经过本地磁盘）
        // 展开目录与创建目标层级之前先检查/补足源、目标及父目录权限。
        await preflightRemoteCopy(srcEndpoint, sourcePaths[0], dstEndpoint, targetPath);
        const expansion = await expandForRemoteCopy(sourcePaths, targetPath, remoteDeps);
        if (expansion.truncated) console.warn('[transfer] 文件夹条目过多，已按 5000 项上限截断');
        for (const dir of expansion.targetDirs) {
          try { await mkdirRemote(dstEndpoint, dir); } catch { /* 已存在则忽略 */ }
        }
        try {
          const tasks = await enqueueInBatches(dstEndpoint, expansion.files.map(f => ({
            profileId: profileFor(dstEndpoint),
            sessionId: dstEndpoint,
            sourceSessionId: srcEndpoint,
            direction: 'remote-copy' as const,
            // 字段约定（与引擎一致）：remotePath=源集群读取路径，localPath=目标集群最终路径
            localPath: f.remotePath,
            remotePath: f.localPath,
            temporaryPath: makeTemporaryTransferName(f.remotePath, uuidv4(), 'remote'),
            totalBytes: f.totalBytes,
            transferredBytes: 0,
            conflictPolicy: 'overwrite' as const,
            verificationMode: 'size' as const,
            retryCount: 0,
          })));
          for (const task of tasks) dispatch({ type: 'transfer/upsert', task });
        } catch (err) { console.error('Failed to enqueue remote-copies:', err); throw err; }
      } catch (err) {
        console.error('Failed to expand transfer sources:', err);
        setTransferError(toDisplayError(err, '文件传输准备失败'));
      }
    },
    [state.activeProfileId, profileId],
  );

  // 面板拖放：目标面板收到源面板的拖拽
  const handleDropOnLeft = useCallback(
    (sourcePaths: string[], targetPath: string) => {
      void transferBetween(rightEndpoint, sourcePaths, leftEndpoint, targetPath);
    },
    [transferBetween, rightEndpoint, leftEndpoint],
  );
  const handleDropOnRight = useCallback(
    (sourcePaths: string[], targetPath: string) => {
      void transferBetween(leftEndpoint, sourcePaths, rightEndpoint, targetPath);
    },
    [transferBetween, leftEndpoint, rightEndpoint],
  );

  const copyFromLeft = useCallback((paths: string[]) => {
    setFileClipboard({ endpoint: leftEndpoint, paths: [...paths], mode: 'copy' });
  }, [leftEndpoint]);

  const copyFromRight = useCallback((paths: string[]) => {
    setFileClipboard({ endpoint: rightEndpoint, paths: [...paths], mode: 'copy' });
  }, [rightEndpoint]);

  const cutFromLeft = useCallback((paths: string[]) => {
    setFileClipboard({ endpoint: leftEndpoint, paths: [...paths], mode: 'cut' });
  }, [leftEndpoint]);

  const cutFromRight = useCallback((paths: string[]) => {
    setFileClipboard({ endpoint: rightEndpoint, paths: [...paths], mode: 'cut' });
  }, [rightEndpoint]);

  const pasteClipboard = useCallback(async (targetEndpoint: string, targetDirectory: string) => {
    if (!fileClipboard || fileClipboard.paths.length === 0) return;
    if (fileClipboard.endpoint !== targetEndpoint) {
      // 跨端点剪切暂不支持：按复制处理（源端保留，剪贴板不清空）
      await transferBetween(
        fileClipboard.endpoint,
        fileClipboard.paths,
        targetEndpoint,
        targetDirectory,
      );
      return;
    }

    if (fileClipboard.mode === 'cut') {
      const moves = planClipboardMoves(fileClipboard.paths, targetDirectory);
      if (targetEndpoint === 'local') {
        const desktop = window.traceDesktop;
        if (!desktop) throw new Error('桌面应用模式下可用');
        for (const move of moves) await desktop.localFiles.rename(move.from, move.to);
      } else {
        for (const move of moves) await renameRemote(targetEndpoint, move.from, move.to);
      }
      setFileClipboard(null);
      return;
    }

    if (targetEndpoint === 'local') {
      const desktop = window.traceDesktop;
      if (!desktop) throw new Error('桌面应用模式下可用');
      await desktop.localFiles.copy(fileClipboard.paths, targetDirectory);
      return;
    }
    await copyRemote(targetEndpoint, fileClipboard.paths, targetDirectory);
  }, [fileClipboard, transferBetween]);

  const pasteIntoLeft = useCallback(
    (targetDirectory: string) => pasteClipboard(leftEndpoint, targetDirectory),
    [leftEndpoint, pasteClipboard],
  );

  const pasteIntoRight = useCallback(
    (targetDirectory: string) => pasteClipboard(rightEndpoint, targetDirectory),
    [pasteClipboard, rightEndpoint],
  );

  // 右键"传输到另一侧"
  const handleLeftTransfer = useCallback(
    (paths: string[]) => {
      void transferBetween(leftEndpoint, paths, rightEndpoint, state.remote.path || endpointHome(rightEndpoint));
    },
    [transferBetween, leftEndpoint, rightEndpoint, state.remote.path],
  );
  const handleRightTransfer = useCallback(
    (paths: string[]) => {
      const target = leftEndpoint === 'local' ? (state.local.path || 'C:\\') : (state.local.path || endpointHome(leftEndpoint));
      void transferBetween(rightEndpoint, paths, leftEndpoint, target);
    },
    [transferBetween, rightEndpoint, leftEndpoint, state.local.path],
  );

  const upsertEditSession = useCallback((session: RemoteEditSession) => {
    editSessionsRef.current.set(session.id, session);
    setEditSessions([...editSessionsRef.current.values()]);
  }, []);

  const queueEditUpload = useCallback(async (session: RemoteEditSession) => {
    const desktop = window.traceDesktop;
    const fingerprint = session.lastLocalFingerprint;
    const activeSessionId = session.sshSessionId || sessionId;
    const activeProfileId = resolveTransferProfileId({
      activeProfileId: state.activeProfileId,
      profileId: profileId || session.profileId,
      sessionId: activeSessionId,
    });
    if (!desktop?.remoteEdits || !fingerprint || !activeSessionId || !activeProfileId) return;
    if (fingerprint === session.lastUploadedFingerprint) return;
    if (uploadingEditSessionsRef.current.has(session.id)) return;

    uploadingEditSessionsRef.current.add(session.id);
    try {
      const uploading = await desktop.remoteEdits.markUploading(session.id, fingerprint);
      upsertEditSession(uploading);
      const localEntry = await desktop.localFiles.stat(session.localPath);
      const input = {
        ...createEditUploadTask(uploading, localEntry.size, activeProfileId, uuidv4()),
        sessionId: activeSessionId,
      };
      const task = await enqueueTransfer(activeSessionId, input);
      editTransferLinksRef.current.set(task.id, {
        editSessionId: session.id,
        phase: 'upload',
        fingerprint,
      });
      dispatch({ type: 'transfer/upsert', task });
    } catch (cause) {
      uploadingEditSessionsRef.current.delete(session.id);
      const message = cause instanceof Error ? cause.message : String(cause);
      const failed = await desktop.remoteEdits.markFailed(session.id, message);
      upsertEditSession(failed);
    }
  }, [profileId, sessionId, state.activeProfileId, upsertEditSession]);

  const handleLocalOpen = useCallback((file: FileEntry) => {
    void window.traceDesktop?.localFiles.open(file.path);
  }, []);

  const handleRemoteOpen = useCallback(async (file: FileEntry, remoteSessionId: string) => {
    const desktop = window.traceDesktop;
    const activeProfileId = resolveTransferProfileId({
      activeProfileId: state.activeProfileId,
      profileId,
      sessionId: remoteSessionId,
    });
    if (!desktop?.remoteEdits || !remoteSessionId || !activeProfileId) return;
    try {
      const editSession = await desktop.remoteEdits.prepare({
        profileId: activeProfileId,
        sshSessionId: remoteSessionId,
        remotePath: file.path,
        fileName: file.name,
      });
      upsertEditSession(editSession);
      editSessionFilesRef.current.set(editSession.id, file);

      if (canOpenCachedEditSession(editSession)) {
        upsertEditSession(await desktop.remoteEdits.open(editSession.id));
        return;
      }

      const input = createEditDownloadTask(editSession, file, activeProfileId, uuidv4());
      const task = await enqueueTransfer(remoteSessionId, input);
      editTransferLinksRef.current.set(task.id, {
        editSessionId: editSession.id,
        phase: 'download',
      });
      dispatch({ type: 'transfer/upsert', task });
    } catch (cause) {
      console.error('Failed to open remote file:', cause);
    }
  }, [profileId, state.activeProfileId, upsertEditSession]);

  const handlePreviewFile = useCallback((file: FileEntry, source: FileSide, endpoint?: string) => {
    setPreviewTarget({ file, source, endpoint });
  }, []);

  // 稳定的面板回调：避免每次渲染新建内联箭头函数，
  // 穿透 FilePane 内 memo 化的文件行（onOpenFile 会经 handleDoubleClick 传给每一行）
  const handleLeftRemoteOpenFile = useCallback(
    (file: FileEntry) => {
      void handleRemoteOpen(file, leftEndpoint);
    },
    [handleRemoteOpen, leftEndpoint],
  );
  const handleRightRemoteOpenFile = useCallback(
    (file: FileEntry) => {
      void handleRemoteOpen(file, rightEndpoint);
    },
    [handleRemoteOpen, rightEndpoint],
  );
  const handleLocalPreviewFile = useCallback(
    (file: FileEntry) => handlePreviewFile(file, 'local'),
    [handlePreviewFile],
  );
  const handleLeftRemotePreviewFile = useCallback(
    (file: FileEntry) => handlePreviewFile(file, 'remote', leftEndpoint),
    [handlePreviewFile, leftEndpoint],
  );
  const handleRightRemotePreviewFile = useCallback(
    (file: FileEntry) => handlePreviewFile(file, 'remote', rightEndpoint),
    [handlePreviewFile, rightEndpoint],
  );

  // 路径选取模式：双击文件的行为按 kind 收敛——允许选文件时直接确认选取；
  // 只允许目录时双击文件仅预览（不触发编辑会话，也不弹传输流程）
  const handlePickFileDoubleClick = useCallback(
    (file: FileEntry) => {
      if (!pickFolder) return;
      if ((pickFolder.kind ?? 'any') !== 'folder') pickFolder.onPick(file.path);
      else handlePreviewFile(file, 'remote', rightEndpoint);
    },
    [pickFolder, handlePreviewFile, rightEndpoint],
  );

  // 底部确认栏的单选条目：跨目录残留的选中路径可能不在当前列表中（kind 置 null 兜底）
  const pickSelectedEntry = useMemo(() => {
    if (state.remote.selected.size !== 1) return null;
    const path = [...state.remote.selected][0];
    const entry = state.remote.entries.find(e => e.path === path);
    return { path, kind: entry?.kind ?? null };
  }, [state.remote.selected, state.remote.entries]);

  const retryEditSession = useCallback(async (editSession: RemoteEditSession) => {
    const desktop = window.traceDesktop;
    if (!desktop?.remoteEdits) return;
    const retrying = await desktop.remoteEdits.retry(editSession.id);
    upsertEditSession(retrying);
    if (retrying.dirty && retrying.lastLocalFingerprint) {
      await queueEditUpload(retrying);
      return;
    }
    if (retrying.lastLocalFingerprint) {
      upsertEditSession(await desktop.remoteEdits.open(retrying.id));
      return;
    }
    const file = editSessionFilesRef.current.get(retrying.id) || {
      name: retrying.remotePath.split('/').pop() || 'remote-file',
      path: retrying.remotePath,
      kind: 'file' as const,
      size: 0,
      modifiedAt: 0,
    };
    await handleRemoteOpen(file, retrying.sshSessionId);
  }, [handleRemoteOpen, queueEditUpload, upsertEditSession]);

  // 移除编辑会话（本地缓存文件仍保留在磁盘恢复目录中）
  const discardEditSession = useCallback(async (editSession: RemoteEditSession) => {
    const desktop = window.traceDesktop;
    if (!desktop?.remoteEdits) return;
    if (editSession.dirty) {
      const name = editSession.remotePath.split('/').pop() || editSession.remotePath;
      if (!window.confirm(`移除 ${name} 的编辑会话？未同步的修改将不再自动上传（本地缓存副本仍保留在磁盘上）。`)) {
        return;
      }
    }
    await desktop.remoteEdits.discard(editSession.id);
    editSessionsRef.current.delete(editSession.id);
    setEditSessions([...editSessionsRef.current.values()]);
  }, []);

  useEffect(() => {
    const desktop = window.traceDesktop;
    if (!desktop?.remoteEdits) return;
    void desktop.remoteEdits.list().then(sessions => {
      for (const editSession of sessions) editSessionsRef.current.set(editSession.id, editSession);
      setEditSessions([...editSessionsRef.current.values()]);
    });
    return desktop.remoteEdits.onEvent((event: RemoteEditEvent) => {
      if (event.type === 'discarded') {
        editSessionsRef.current.delete(event.session.id);
        setEditSessions([...editSessionsRef.current.values()]);
        return;
      }
      upsertEditSession(event.session);
      if (event.type === 'dirty' || event.type === 'closed') {
        void queueEditUpload(event.session);
      }
    });
  }, [queueEditUpload, upsertEditSession]);

  useEffect(() => {
    const desktop = window.traceDesktop;
    if (!desktop?.remoteEdits) return;
    for (const task of Object.values(state.transfers)) {
      const link = editTransferLinksRef.current.get(task.id);
      if (!link || handledEditTransfersRef.current.has(task.id)) continue;
      if (task.state !== 'completed' && task.state !== 'failed') continue;
      handledEditTransfersRef.current.add(task.id);
      const editSession = editSessionsRef.current.get(link.editSessionId);
      if (!editSession) continue;

      if (task.state === 'failed') {
        uploadingEditSessionsRef.current.delete(editSession.id);
        void desktop.remoteEdits
          .markFailed(editSession.id, task.error || '传输失败')
          .then(upsertEditSession);
        continue;
      }

      if (link.phase === 'download') {
        void desktop.remoteEdits.markDownloaded(editSession.id)
          .then(upsertEditSession)
          .then(() => desktop.remoteEdits.open(editSession.id))
          .then(upsertEditSession)
          .catch(async cause => {
            const message = cause instanceof Error ? cause.message : String(cause);
            upsertEditSession(await desktop.remoteEdits.markFailed(editSession.id, message));
          });
      } else {
        uploadingEditSessionsRef.current.delete(editSession.id);
        void desktop.remoteEdits
          .markSynced(editSession.id, link.fingerprint || editSession.lastLocalFingerprint || '')
          .then(syncedSession => {
            upsertEditSession(syncedSession);
            if (syncedSession.dirty) void queueEditUpload(syncedSession);
          });
      }
    }
  }, [queueEditUpload, state.transfers, upsertEditSession]);

  const handleConflictResolve = useCallback(
    (taskId: string, policy: 'ask' | 'overwrite' | 'resume' | 'skip' | 'rename') => {
      dispatch({ type: 'conflict/resolve', taskId, policy });
    },
    [],
  );

  const handleConflictClose = useCallback(() => {
    dispatch({ type: 'conflict/close' });
  }, []);

  // 最新 transfers 放入 ref：队列操作回调引用保持稳定，
  // 进度推送时配合 TaskRow 的 memo 只重渲染对应任务行
  const transfersRef = useRef(state.transfers);
  useEffect(() => {
    transfersRef.current = state.transfers;
  }, [state.transfers]);

  // Queue handlers — 乐观更新；请求失败必须回滚并给出可见错误，不能假成功。
  const runQueueOperation = useCallback(async (
    id: string,
    patch: Partial<TransferTask>,
    operation: (ownerSessionId: string, taskId: string) => Promise<unknown>,
    label: string,
  ) => {
    const task = transfersRef.current[id];
    if (!task) return;
    dispatch({ type: 'transfer/upsert', task: { ...task, ...patch } });
    const ownerSessionId = task.sessionId || sessionId;
    if (!ownerSessionId) {
      dispatch({ type: 'transfer/upsert', task });
      return;
    }
    try {
      await operation(ownerSessionId, id);
    } catch (err) {
      console.error(`Failed to ${label} transfer:`, err);
      dispatch({ type: 'transfer/upsert', task });
      setTransferError(`${label}失败：${toDisplayError(err, '请稍后重试')}`);
      setPaneRefreshToken(token => token + 1);
    }
  }, [sessionId]);

  const handlePause = useCallback(
    (id: string) => runQueueOperation(id, { state: 'paused' }, pauseTransfer, '暂停'),
    [runQueueOperation],
  );
  const handleResume = useCallback(
    (id: string) => runQueueOperation(id, { state: 'queued' }, resumeTransfer, '继续'),
    [runQueueOperation],
  );
  const handleCancel = useCallback(
    (id: string) => runQueueOperation(id, { state: 'cancelled' }, cancelTransfer, '停止'),
    [runQueueOperation],
  );
  const handleRetry = useCallback(
    (id: string) => runQueueOperation(id, { state: 'queued', transferredBytes: 0, bytesPerSecond: 0 }, retryTransfer, '重试'),
    [runQueueOperation],
  );

  const handlePauseAll = useCallback(() => {
    const ids = Object.values(transfersRef.current)
      .filter(task => task.state === 'running' || task.state === 'queued' || task.state === 'retrying')
      .map(task => task.id);
    void Promise.allSettled(ids.map(handlePause));
  }, [handlePause]);

  const handleResumeAll = useCallback(() => {
    const ids = Object.values(transfersRef.current)
      .filter(task => task.state === 'paused')
      .map(task => task.id);
    void Promise.allSettled(ids.map(handleResume));
  }, [handleResume]);

  const handleCancelAll = useCallback(() => {
    const ids = Object.values(transfersRef.current)
      .filter(task => ['queued', 'running', 'paused', 'retrying'].includes(task.state))
      .map(task => task.id);
    if (ids.length === 0) return;
    if (!window.confirm(`确定停止全部 ${ids.length} 个未完成的传输任务吗？已完成的数据不会删除。`)) return;
    void Promise.allSettled(ids.map(handleCancel));
  }, [handleCancel]);

  const handleClearCompleted = useCallback(async () => {
    const completed = Object.values(state.transfers)
      .filter(task => task.state === 'completed' || task.state === 'cancelled');
    for (const task of completed) dispatch({ type: 'transfer/removed', id: task.id });
    const sessionIds = new Set(completed.map(task => task.sessionId || sessionId).filter(Boolean) as string[]);
    try {
      await Promise.all([...sessionIds].map(ownerSessionId => clearCompletedTransfers(ownerSessionId)));
    } catch (err) {
      for (const task of completed) dispatch({ type: 'transfer/upsert', task });
      setTransferError(`清除失败：${toDisplayError(err, '请稍后重试')}`);
      setPaneRefreshToken(token => token + 1);
    }
  }, [state.transfers, sessionId]);

  const handleSyncApply = useCallback(
    (actions: any[]) => {
      // Enqueue transfer tasks for each action
      for (const action of actions) {
        if (action.kind === 'upload' || action.kind === 'download') {
          const direction = action.kind as 'upload' | 'download';
          const task: TransferTask = {
            id: uuidv4(),
            profileId: resolveTransferProfileId({
              activeProfileId: state.activeProfileId,
              profileId,
              sessionId,
            }),
            sessionId: sessionId ?? undefined,
            direction,
            localPath: direction === 'upload' ? action.sourcePath : action.targetPath,
            remotePath: direction === 'upload' ? action.targetPath : action.sourcePath,
            temporaryPath: '',
            totalBytes: action.size,
            transferredBytes: 0,
            bytesPerSecond: 0,
            state: 'queued',
            conflictPolicy: 'ask',
            verificationMode: 'size',
            retryCount: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          dispatch({ type: 'transfer/upsert', task });
        }
      }
    },
    [state.activeProfileId, profileId, sessionId],
  );

  // SearchPanel onNavigate wrappers (only passes path, pane handlers need more args)
  const handleSearchNavigateLocal = useCallback(
    (path: string) => handleLocalNavigate(path, [], true),
    [handleLocalNavigate],
  );

  const handleSearchNavigateRemote = useCallback(
    (path: string) => handleRemoteNavigate(path, [], true),
    [handleRemoteNavigate],
  );

  // 本地工作台没有 SSH 会话，但本地文件窗格仍应直接可用。
  const connected = Boolean(state.activeProfileId || sessionId || endpoints.some(endpoint => endpoint.id === 'local'));

  // 任务数组 memo：仅 transfers 变化时重建，
  // 保证 TransferQueue 的过滤 useMemo 与 TaskRow 的 React.memo 生效
  const transferTasks = useMemo(
    () => Object.values(state.transfers),
    [state.transfers],
  );

  useEffect(() => {
    onTransferIndicatorsChange?.({ active: state.summary.active, failed: state.summary.failed });
  }, [onTransferIndicatorsChange, state.summary.active, state.summary.failed]);

  // Auto-navigate panes to default paths when connected / endpoint switched
  useEffect(() => {
    if (!connected) return;
    if (!state.local.path) {
      dispatch({
        type: 'pane/navigate',
        side: 'local',
        path: endpointPathOrDefault(
          endpointPathsRef.current,
          leftEndpoint,
          leftEndpoint === 'local' ? LOCAL_DRIVES_ROOT : endpointHome(leftEndpoint),
        ),
        entries: [],
        loading: true,
      });
    }
    if (!state.remote.path) {
      dispatch({
        type: 'pane/navigate',
        side: 'remote',
        path: endpointPathOrDefault(
          endpointPathsRef.current,
          rightEndpoint,
          rightEndpoint === 'local' ? LOCAL_DRIVES_ROOT : endpointHome(rightEndpoint),
        ),
        entries: [],
        loading: true,
      });
    }
  }, [connected, state.local.path, state.remote.path, leftEndpoint, rightEndpoint]);

  // 端点切换时先保存离开端点的路径，再恢复进入端点的上次路径。
  const prevEndpointsRef = useRef({ left: leftEndpoint, right: rightEndpoint });
  useEffect(() => {
    const prev = prevEndpointsRef.current;
    if (prev.left !== leftEndpoint) {
      rememberEndpointPath(endpointPathsRef.current, prev.left, state.local.path);
      dispatch({
        type: 'pane/navigate',
        side: 'local',
        path: endpointPathOrDefault(
          endpointPathsRef.current,
          leftEndpoint,
          leftEndpoint === 'local' ? LOCAL_DRIVES_ROOT : endpointHome(leftEndpoint),
        ),
        entries: [],
        loading: true,
      });
    }
    if (prev.right !== rightEndpoint) {
      rememberEndpointPath(endpointPathsRef.current, prev.right, state.remote.path);
      dispatch({
        type: 'pane/navigate',
        side: 'remote',
        path: endpointPathOrDefault(
          endpointPathsRef.current,
          rightEndpoint,
          rightEndpoint === 'local' ? LOCAL_DRIVES_ROOT : endpointHome(rightEndpoint),
        ),
        entries: [],
        loading: true,
      });
    }
    prevEndpointsRef.current = { left: leftEndpoint, right: rightEndpoint };
  }, [leftEndpoint, rightEndpoint]);

  // 盘符列表层级（此电脑）没有可搜索的本地目录，禁用搜索入口
  const searchBlocked =
    (leftEndpoint === 'local' && isLocalDrivesRoot(state.local.path))
    || (rightEndpoint === 'local' && isLocalDrivesRoot(state.remote.path));

  return (
    <FileTransferDrawer
      open={state.drawerOpen}
      maximized={state.maximized}
      visible={visible}
      onClose={handleClose}
      onToggleMaximize={handleToggleMaximize}
    >
      <div className="flex flex-col h-full">
        {/* Status bar */}
        <div className="px-4 py-2 border-b border-scholar-700/50 flex items-center justify-between shrink-0">
          <span className="text-xs text-scholar-400">
            {state.activeProfileId
              ? `\u5DF2\u8FDE\u63A5: ${state.activeProfileId}`
              : '\u672A\u8FDE\u63A5'}
          </span>
          <span className="text-xs text-scholar-500">
            {state.summary.active > 0
              ? `${state.summary.active} \u4E2A\u8FDB\u884C\u4E2D`
              : ''}
          </span>
        </div>
        {transferError && (
          <div className="px-4 py-2 border-b border-red-500/30 bg-red-500/10 text-xs text-red-300 flex items-center justify-between gap-3">
            <span className="break-words" role="alert">{transferError}</span>
            <button type="button" className="shrink-0 hover:text-white" onClick={() => setTransferError('')} aria-label="关闭错误">×</button>
          </div>
        )}

        {/* Toolbar for search/sync（选择路径模式下隐藏） */}
        {connected && !pickFolder && (
          <div className="file-transfer-toolbar">
            <button
              className="toolbar-btn"
              onClick={() => setSearchOpen((o) => !o)}
              disabled={searchBlocked}
              data-testid="toolbar-search-btn"
            >
              搜索
            </button>
            <button
              className="toolbar-btn"
              onClick={() => setSyncOpen((o) => !o)}
              data-testid="toolbar-sync-btn"
            >
              同步
            </button>
          </div>
        )}

        {editSessions.length > 0 && (
          <div className="remote-edit-session-strip" aria-label="远程编辑会话">
            {editSessions.map(editSession => (
              <div
                key={editSession.id}
                className="remote-edit-session-item"
                data-state={editSession.state}
              >
                <span className="remote-edit-session-name" title={editSession.remotePath}>
                  {editSession.remotePath.split('/').pop() || editSession.remotePath}
                </span>
                <span className="remote-edit-session-state">
                  {{
                    downloading: '正在下载',
                    opening: '正在打开',
                    editing: editSession.dirty ? '有修改' : '编辑中',
                    uploading: '正在同步',
                    synced: '已同步',
                    failed: editSession.dirty ? '同步失败' : '打开失败',
                  }[editSession.state]}
                </span>
                {editSession.state === 'failed' && (
                  <>
                    <button type="button" onClick={() => void retryEditSession(editSession)}>
                      {editSession.dirty ? '重试上传' : '重试打开'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void window.traceDesktop?.localFiles.open(editSession.localPath)}
                    >打开本地副本</button>
                  </>
                )}
                <button
                  type="button"
                  className="remote-edit-session-dismiss"
                  title="移除会话"
                  aria-label="移除会话"
                  onClick={() => void discardEditSession(editSession)}
                >×</button>
              </div>
            ))}
          </div>
        )}

        {/* Main content area */}
        <div className="flex-1 flex min-h-0">
          {connected ? (
            pickFolder ? (
              /* 选择路径模式：仅远程窗格 */
              <div className="flex-1 relative flex flex-col">
                <RemoteFilePane
                  key={rightEndpoint}
                  sessionId={rightEndpoint}
                  fallbackPath={endpointHome(rightEndpoint)}
                  paneState={state.remote}
                  onNavigate={handleRemoteNavigate}
                  onSelect={handleRemoteSelect}
                  onDeselectAll={handleRemoteDeselectAll}
                  onDrop={handleDropOnRight}
                  onTransfer={handleRightTransfer}
                  onCopyFiles={copyFromRight}
                  onPasteFiles={pasteIntoRight}
                  clipboardAvailable={Boolean(fileClipboard)}
                  onOpenFile={handleRightRemoteOpenFile}
                  onPreviewFile={handleRightRemotePreviewFile}
                  onFileDoubleClick={handlePickFileDoubleClick}
                  refreshToken={paneRefreshToken}
                />
              </div>
            ) : (
            <>
              {/* Dual panes - side by side，各自可切换端点（本地/任一集群） */}
              <div className="flex-1 min-w-[320px] border-r border-scholar-700/50 relative flex flex-col">
                <EndpointTabs
                  endpoints={endpoints}
                  value={leftEndpoint}
                  exclude={rightEndpoint}
                  onChange={setLeftEndpoint}
                />
                <div className="flex-1 min-h-0 relative">
                  {leftEndpoint === 'local' ? (
                    <LocalFilePane
                      paneState={state.local}
                      onNavigate={handleLocalNavigate}
                      onSelect={handleLocalSelect}
                      onDeselectAll={handleLocalDeselectAll}
                      onDrop={handleDropOnLeft}
                      onTransfer={handleLeftTransfer}
                      onCopyFiles={copyFromLeft}
                      onCutFiles={cutFromLeft}
                      onPasteFiles={pasteIntoLeft}
                      clipboardAvailable={Boolean(fileClipboard)}
                      onOpenFile={handleLocalOpen}
                      onPreviewFile={handleLocalPreviewFile}
                      refreshToken={paneRefreshToken}
                    />
                  ) : (
                    <RemoteFilePane
                      key={leftEndpoint}
                      sessionId={leftEndpoint}
                      fallbackPath={endpointHome(leftEndpoint)}
                      paneState={state.local}
                      onNavigate={handleLocalNavigate}
                      onSelect={handleLocalSelect}
                      onDeselectAll={handleLocalDeselectAll}
                      onDrop={handleDropOnLeft}
                      onTransfer={handleLeftTransfer}
                      onCopyFiles={copyFromLeft}
                      onCutFiles={cutFromLeft}
                      onPasteFiles={pasteIntoLeft}
                      clipboardAvailable={Boolean(fileClipboard)}
                      onOpenFile={handleLeftRemoteOpenFile}
                      onPreviewFile={handleLeftRemotePreviewFile}
                      refreshToken={paneRefreshToken}
                    />
                  )}
                  {/* Search panel overlaid on left pane */}
                  {searchOpen && (
                    <SearchPanel
                      open={searchOpen}
                      root={state.local.path}
                      side="local"
                      sessionId={leftEndpoint === 'local' ? undefined : leftEndpoint}
                      onClose={() => setSearchOpen(false)}
                      onNavigate={handleSearchNavigateLocal}
                    />
                  )}
                </div>
              </div>
              <div className="flex-1 min-w-[320px] relative flex flex-col">
                <EndpointTabs
                  endpoints={endpoints}
                  value={rightEndpoint}
                  exclude={leftEndpoint}
                  onChange={setRightEndpoint}
                />
                <div className="flex-1 min-h-0 relative">
                  {rightEndpoint === 'local' ? (
                    <LocalFilePane
                      paneState={state.remote}
                      onNavigate={handleRemoteNavigate}
                      onSelect={handleRemoteSelect}
                      onDeselectAll={handleRemoteDeselectAll}
                      onDrop={handleDropOnRight}
                      onTransfer={handleRightTransfer}
                      onCopyFiles={copyFromRight}
                      onCutFiles={cutFromRight}
                      onPasteFiles={pasteIntoRight}
                      clipboardAvailable={Boolean(fileClipboard)}
                      onOpenFile={handleLocalOpen}
                      onPreviewFile={handleLocalPreviewFile}
                      refreshToken={paneRefreshToken}
                    />
                  ) : (
                    <RemoteFilePane
                      key={rightEndpoint}
                      sessionId={rightEndpoint}
                      fallbackPath={endpointHome(rightEndpoint)}
                      paneState={state.remote}
                      onNavigate={handleRemoteNavigate}
                      onSelect={handleRemoteSelect}
                      onDeselectAll={handleRemoteDeselectAll}
                      onDrop={handleDropOnRight}
                      onTransfer={handleRightTransfer}
                      onCopyFiles={copyFromRight}
                      onCutFiles={cutFromRight}
                      onPasteFiles={pasteIntoRight}
                      clipboardAvailable={Boolean(fileClipboard)}
                      onOpenFile={handleRightRemoteOpenFile}
                      onPreviewFile={handleRightRemotePreviewFile}
                      refreshToken={paneRefreshToken}
                    />
                  )}
                  {/* Search panel overlaid on right pane */}
                  {searchOpen && (
                    <SearchPanel
                      open={searchOpen}
                      root={state.remote.path}
                      side="remote"
                      sessionId={rightEndpoint === 'local' ? undefined : rightEndpoint}
                      onClose={() => setSearchOpen(false)}
                      onNavigate={handleSearchNavigateRemote}
                    />
                  )}
                </div>
              </div>
            </>
            )
          ) : (
            /* Not connected — show host manager */
            <div className="flex-1">
              <HostManager
                onConnect={handleConnect}
                connectionState={state.connectionState}
              />
            </div>
          )}
        </div>

        {/* 选择路径模式的底部确认栏（按 kind 限制可选条目类型） */}
        {pickFolder && connected && (
          <PickConfirmBar
            kind={pickFolder.kind ?? 'any'}
            currentPath={state.remote.path}
            selectedEntry={pickSelectedEntry}
            onPick={pickFolder.onPick}
            onCancel={pickFolder.onCancel}
          />
        )}

        {/* Transfer Queue（选择路径模式下隐藏） */}
        {!pickFolder && (
        <TransferQueue
          tasks={transferTasks}
          summary={state.summary}
          onPause={handlePause}
          onResume={handleResume}
          onCancel={handleCancel}
          onRetry={handleRetry}
          onPauseAll={handlePauseAll}
          onResumeAll={handleResumeAll}
          onCancelAll={handleCancelAll}
          onClearCompleted={handleClearCompleted}
        />
        )}

        {/* Conflict dialog */}
        <ConflictDialog
          conflict={state.conflict}
          onResolve={handleConflictResolve}
          onClose={handleConflictClose}
        />

        {/* Sync Planner */}
        {syncOpen && (
          <SyncPlannerDialog
            open={syncOpen}
            onClose={() => setSyncOpen(false)}
            onApply={handleSyncApply}
            sourceEntries={state.local.entries}
            targetEntries={state.remote.entries}
            sourceLabel="本地目录"
            targetLabel="远程目录"
            sourceSide="local"
          />
        )}

        {/* File Preview */}
        {previewTarget && (
          <FilePreview
            file={previewTarget.file}
            source={previewTarget.source}
            sessionId={previewTarget.endpoint ?? sessionId ?? undefined}
            onClose={() => setPreviewTarget(null)}
            onOpen={() => {
              if (previewTarget.source === 'remote') {
                void handleRemoteOpen(
                  previewTarget.file,
                  previewTarget.endpoint ?? sessionId ?? '',
                );
              }
              else handleLocalOpen(previewTarget.file);
            }}
          />
        )}
      </div>
    </FileTransferDrawer>
  );
}

/** 面板端点选择器：本地 / 各已连接集群；禁用另一侧已选的端点 */
function EndpointTabs({
  endpoints,
  value,
  exclude,
  onChange,
}: {
  endpoints: EndpointOption[];
  value: string;
  exclude?: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-1 px-2 py-1 border-b border-scholar-700/50 overflow-x-auto shrink-0">
      {endpoints.map(ep => {
        const active = ep.id === value;
        const disabled = ep.id === exclude;
        return (
          <button
            key={ep.id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(ep.id)}
            title={disabled ? '另一侧正在使用该端点' : ep.label}
            className={`px-2 py-0.5 rounded text-[11px] whitespace-nowrap transition-colors ${
              active
                ? 'bg-accent/15 text-accent border border-accent/30 font-medium'
                : disabled
                ? 'text-scholar-600 cursor-not-allowed'
                : 'text-scholar-400 hover:text-scholar-200 hover:bg-scholar-800/60 border border-transparent'
            }`}
          >
            {ep.label}
          </button>
        );
      })}
    </div>
  );
}
