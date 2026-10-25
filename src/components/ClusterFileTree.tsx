import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown, ChevronRight, ClipboardPaste, Copy, Download, ExternalLink,
  File, Folder, FolderOpen, Loader2, Pencil, RefreshCw, Scissors, Trash2,
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import type { FileEntry, PickPathKind } from '@/shared/fileTransfer';
import { makeTemporaryTransferName } from '@/shared/fileTransfer';
import {
  copyRemote,
  enqueueTransfer,
  listRemoteFiles,
  removePreviewRemote,
  removeRemote,
  renameRemote,
  statRemote,
  walkRemote,
} from '../features/file-transfer/api';
import { expandForDownload } from '../features/file-transfer/folderTransfer';
import { planClipboardMoves } from '../features/file-transfer/FilePane';
import { resolveTransferProfileId } from '../features/file-transfer/sessionIdentity';
import FilePreview from '../features/file-transfer/FilePreview';
import { useContextMenuPosition } from './useContextMenuPosition';
import { writeClipboardText } from '../services/clipboard';
import '../features/file-transfer/fileTransfer.css';

interface TreeNode extends FileEntry {
  depth: number;
}

interface ClusterFileTreeProps {
  sessionId?: string | null;
  home?: string;
  selectedPath?: string | null;
  onSelect: (entry: FileEntry) => void;
  pickMode?: boolean;
  /** 选取模式下可选的条目类型：只选文件 / 只选目录 / 均可（默认 folder，维持旧行为） */
  pickKind?: PickPathKind;
  onConfirmPick?: (path: string) => void;
  onCancelPick?: () => void;
}

/** 树内剪贴板：copy=复制粘贴；cut=剪切粘贴（粘贴时执行移动并清空剪贴板） */
interface TreeClipboard {
  paths: string[];
  mode: 'copy' | 'cut';
}

function parentPath(remotePath: string): string {
  if (!remotePath || remotePath === '/') return '/';
  return remotePath.replace(/\/+$/, '').replace(/\/[^/]+$/, '') || '/';
}

function joinRemotePath(directory: string, name: string): string {
  return directory.endsWith('/') ? directory + name : `${directory}/${name}`;
}

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind === 'directory' && b.kind !== 'directory') return -1;
    if (a.kind !== 'directory' && b.kind !== 'directory') return 1;
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
  });
}

export default function ClusterFileTree({
  sessionId: requestedSessionId,
  home = '/',
  selectedPath,
  onSelect,
  pickMode = false,
  pickKind = 'folder',
  onConfirmPick,
  onCancelPick,
}: ClusterFileTreeProps) {
  const sessionId = requestedSessionId === 'local-workbench' ? null : requestedSessionId;
  const rootPath = home || '/';
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([rootPath]));
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    entry: FileEntry;
  } | null>(null);
  const [clipboard, setClipboard] = useState<TreeClipboard | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<{
    path: string;
    name: string;
    total: number;
  } | null>(null);
  const [previewEntry, setPreviewEntry] = useState<FileEntry | null>(null);
  // 地址栏跳转：直接输入路径回车，逐级展开祖先链并选中目标
  const [addressValue, setAddressValue] = useState('');
  const [jumping, setJumping] = useState(false);
  const treeContainerRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  // 右键菜单视口收拢：实测菜单宽高后修正 left/top，避免在窗口右/下沿被裁
  const contextMenuStyle = useContextMenuPosition(
    contextMenuRef,
    contextMenu?.x ?? null,
    contextMenu?.y ?? null,
  );

  const loadDirectory = useCallback(async (remotePath: string, force = false) => {
    if (!sessionId || (!force && children[remotePath])) return;
    setLoading(current => new Set(current).add(remotePath));
    setError('');
    try {
      const result = await listRemoteFiles(sessionId, remotePath);
      setChildren(current => ({ ...current, [remotePath]: sortEntries(result.entries) }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '目录读取失败');
    } finally {
      setLoading(current => {
        const next = new Set(current);
        next.delete(remotePath);
        return next;
      });
    }
  }, [children, sessionId]);

  useEffect(() => {
    setExpanded(new Set([rootPath]));
    setChildren({});
    if (sessionId) void loadDirectory(rootPath, true);
  // loadDirectory deliberately omitted: changing its identity after a directory load
  // must not reset the tree.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, rootPath]);

  const toggleDirectory = useCallback((entry: FileEntry) => {
    if (entry.kind !== 'directory') return;
    const isExpanded = expanded.has(entry.path);
    setExpanded(current => {
      const next = new Set(current);
      if (isExpanded) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
    if (!isExpanded) void loadDirectory(entry.path);
  }, [expanded, loadDirectory]);

  /** 地址栏跳转：`~` 与相对路径按家目录解析；目录展开自身，文件定位到父级并选中 */
  const jumpToAddress = useCallback(async () => {
    if (!sessionId || jumping) return;
    const raw = addressValue.trim();
    if (!raw) return;
    const normalized = (raw === '~' ? rootPath : raw.startsWith('~/') ? rootPath.replace(/\/+$/, '') + raw.slice(1) : raw.startsWith('/') ? raw : `${rootPath.replace(/\/+$/, '')}/${raw}`).replace(/\/+$/, '') || '/';
    if (normalized !== '/' && !normalized.startsWith(`${rootPath.replace(/\/+$/, '')}/`)) {
      setError('目标路径不在当前根目录（家目录）下');
      return;
    }
    setJumping(true);
    setError('');
    try {
      const stat = await statRemote(sessionId, normalized);
      const entry = stat.entry;
      const targetDir = entry.kind === 'directory' ? entry.path : parentPath(entry.path);
      // 逐级加载并展开 rootPath → targetDir 的祖先链（跳过已展开的层级，强制刷新目标层）
      const chain: string[] = [];
      let cursor = targetDir;
      while (cursor && cursor !== rootPath && cursor.startsWith(`${rootPath.replace(/\/+$/, '')}/`)) {
        chain.unshift(cursor);
        cursor = parentPath(cursor);
      }
      for (const dir of chain) {
        await loadDirectory(dir, true);
      }
      setExpanded(current => new Set([...current, ...chain]));
      onSelect(entry);
      // 状态提交后滚动到目标行
      setTimeout(() => {
        treeContainerRef.current
          ?.querySelector(`[data-tree-path="${CSS.escape(entry.path)}"]`)
          ?.scrollIntoView({ block: 'center' });
      }, 50);
    } catch (cause) {
      setError(cause instanceof Error ? `跳转失败：${cause.message}` : '路径不存在或不可访问');
    } finally {
      setJumping(false);
    }
  }, [addressValue, jumping, sessionId, rootPath, loadDirectory, onSelect]);

  /** 目录被移走/删除/改名后，丢弃以其为根的展开状态与子树缓存 */
  const dropSubtree = useCallback((remotePath: string) => {
    setExpanded(current => {
      const next = new Set<string>();
      current.forEach(p => {
        if (p !== remotePath && !p.startsWith(`${remotePath}/`)) next.add(p);
      });
      return next;
    });
    setChildren(current => {
      const next: Record<string, FileEntry[]> = {};
      for (const [key, value] of Object.entries(current)) {
        if (key !== remotePath && !key.startsWith(`${remotePath}/`)) next[key] = value;
      }
      return next;
    });
  }, []);

  const refreshDirectories = useCallback((paths: string[]) => {
    for (const dir of new Set(paths)) void loadDirectory(dir, true);
  }, [loadDirectory]);

  // 右键菜单：外点关闭
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = (event: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(event.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [contextMenu]);

  // 右键菜单：Esc 关闭
  useEffect(() => {
    if (!contextMenu) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [contextMenu]);

  // 重命名输入框聚焦并选中
  useEffect(() => {
    if (renaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renaming]);

  const handleContextMenu = useCallback((event: React.MouseEvent, entry: FileEntry) => {
    // 路径选取模式保持选取语义纯净，不弹文件操作菜单
    if (pickMode) return;
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, entry });
  }, [pickMode]);

  // 打开：目录 → 展开/收起；文件 → 预览
  const openEntry = useCallback((entry: FileEntry) => {
    if (entry.kind === 'directory') toggleDirectory(entry);
    else setPreviewEntry(entry);
  }, [toggleDirectory]);

  const copyPathOf = useCallback((entry: FileEntry) => {
    void writeClipboardText(entry.path).catch(() => {});
  }, []);

  const copyEntries = useCallback((entry: FileEntry) => {
    setClipboard({ paths: [entry.path], mode: 'copy' });
  }, []);

  const cutEntries = useCallback((entry: FileEntry) => {
    setClipboard({ paths: [entry.path], mode: 'cut' });
  }, []);

  const pasteInto = useCallback(async (targetDirectory: string) => {
    if (!sessionId || !clipboard || clipboard.paths.length === 0) return;
    setError('');
    try {
      if (clipboard.mode === 'cut') {
        const moves = planClipboardMoves(clipboard.paths, targetDirectory);
        for (const move of moves) await renameRemote(sessionId, move.from, move.to);
        setClipboard(null);
        refreshDirectories([
          targetDirectory,
          ...moves.map(move => parentPath(move.from)),
        ]);
        return;
      }
      await copyRemote(sessionId, clipboard.paths, targetDirectory);
      refreshDirectories([targetDirectory]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '粘贴失败');
    }
  }, [sessionId, clipboard, refreshDirectories]);

  const startRename = useCallback((entry: FileEntry) => {
    setRenaming(entry.path);
    setRenameValue(entry.name);
  }, []);

  const submitRename = useCallback(async () => {
    const from = renaming;
    const name = renameValue.trim();
    if (!from || !sessionId) {
      setRenaming(null);
      return;
    }
    if (!name || name === from.split('/').pop()) {
      setRenaming(null);
      return;
    }
    const parent = parentPath(from);
    setError('');
    try {
      await renameRemote(sessionId, from, joinRemotePath(parent, name));
      dropSubtree(from);
      refreshDirectories([parent]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重命名失败');
    } finally {
      setRenaming(null);
    }
  }, [renaming, renameValue, sessionId, dropSubtree, refreshDirectories]);

  const requestDelete = useCallback(async (entry: FileEntry) => {
    if (!sessionId) return;
    try {
      const preview = await removePreviewRemote(sessionId, entry.path, true);
      setDeleteConfirm({ path: entry.path, name: entry.name, total: preview.total });
    } catch {
      setDeleteConfirm({ path: entry.path, name: entry.name, total: 1 });
    }
  }, [sessionId]);

  const confirmDelete = useCallback(async () => {
    if (!deleteConfirm || !sessionId) return;
    setError('');
    try {
      await removeRemote(sessionId, deleteConfirm.path, true);
      dropSubtree(deleteConfirm.path);
      refreshDirectories([parentPath(deleteConfirm.path)]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败');
    } finally {
      setDeleteConfirm(null);
    }
  }, [deleteConfirm, sessionId, dropSubtree, refreshDirectories]);

  const downloadEntry = useCallback(async (entry: FileEntry) => {
    const desktop = window.traceDesktop;
    if (!sessionId || !desktop?.dialog) return;
    setError('');
    try {
      const targetDirectory = await desktop.dialog.pickDirectory();
      if (!targetDirectory) return;
      const expansion = await expandForDownload([entry.path], targetDirectory, {
        statRemote: async p => (await statRemote(sessionId, p)).entry,
        walkRemote: p => walkRemote(sessionId, p),
      });
      for (const dir of expansion.targetDirs) {
        try { await desktop.localFiles.mkdir(dir); } catch { /* 已存在则忽略 */ }
      }
      for (const file of expansion.files) {
        await enqueueTransfer(sessionId, {
          profileId: resolveTransferProfileId({ sessionId }),
          sessionId,
          direction: 'download' as const,
          localPath: file.localPath,
          remotePath: file.remotePath,
          temporaryPath: makeTemporaryTransferName(file.localPath, uuidv4(), 'local'),
          totalBytes: file.totalBytes,
          transferredBytes: 0,
          conflictPolicy: 'overwrite' as const,
          verificationMode: 'size' as const,
          retryCount: 0,
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '下载失败');
    }
  }, [sessionId]);

  const visible = useMemo(() => {
    const rows: TreeNode[] = [];
    const visit = (remotePath: string, depth: number, lineage: Set<string>) => {
      for (const entry of children[remotePath] || []) {
        rows.push({ ...entry, depth });
        // 防循环：symlink 环（或异常数据）会导致目录成为自身祖先，递归必须终止
        if (entry.kind === 'directory' && expanded.has(entry.path) && !lineage.has(entry.path)) {
          visit(entry.path, depth + 1, new Set([...lineage, entry.path]));
        }
      }
    };
    rows.push({
      name: rootPath === '/' ? '/' : rootPath.split('/').filter(Boolean).pop() || rootPath,
      path: rootPath,
      kind: 'directory',
      size: 0,
      modifiedAt: 0,
      depth: 0,
    });
    if (expanded.has(rootPath)) visit(rootPath, 1, new Set([rootPath]));
    return rows;
  }, [children, expanded, rootPath]);

  if (!sessionId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 px-4 text-center text-xs text-scholar-400">
        <Folder className="w-7 h-7 opacity-40" />
        <p>连接计算资源后，这里会显示远程文件树。</p>
      </div>
    );
  }

  const selected = visible.find(entry => entry.path === selectedPath);
  const selectedDirectory = selected?.kind === 'directory'
    ? selected.path
    : selected ? parentPath(selected.path) : '';
  // 确认路径按 kind 收敛：folder 维持旧行为（选中文件时取其所在目录）；
  // file 仅接受文件类条目（symlink 按文件处理）；any 文件/目录条目均可
  const pickedPath = !selected
    ? ''
    : pickKind === 'folder'
      ? selectedDirectory
      : pickKind === 'file'
        ? (selected.kind === 'directory' ? '' : selected.path)
        : selected.path;
  const pickHint = pickKind === 'file'
    ? '请选择一个文件'
    : pickKind === 'any' ? '请选择文件或目录' : '请选择一个目录';
  const pickConfirmLabel = pickKind === 'file'
    ? '选择此文件'
    : pickKind === 'any' ? '选择选中项' : '选择此目录';

  // 视图根（家目录）只允许浏览类操作，禁止剪切/重命名/删除
  const menuEntry = contextMenu?.entry ?? null;
  const menuEntryIsRoot = menuEntry?.path === rootPath;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-2 py-2 border-b border-scholar-700/60">
        <div className="min-w-0">
          <p className="text-xs font-medium text-scholar-100">计算资源文件</p>
          <p className="text-[10px] text-scholar-400 truncate" title={rootPath}>{rootPath}</p>
        </div>
        <button
          type="button"
          onClick={() => void loadDirectory(rootPath, true)}
          className="btn-icon shrink-0"
          title="刷新文件树"
          aria-label="刷新文件树"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading.has(rootPath) ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && <p className="mx-2 mt-2 text-[11px] text-red-500 break-words">{error}</p>}

      {/* 地址栏：直接输入路径回车跳转（支持 ~ 与相对路径） */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-scholar-700/60">
        <input
          value={addressValue}
          onChange={e => setAddressValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void jumpToAddress(); }}
          placeholder="输入路径，回车跳转"
          aria-label="输入路径，回车跳转"
          spellCheck={false}
          className="min-w-0 flex-1 bg-scholar-950 border border-scholar-600 rounded px-2 py-1 text-[11px] font-mono text-scholar-100 placeholder:text-scholar-500 focus:outline-none focus:ring-1 focus:ring-accent/50"
        />
        <button
          type="button"
          onClick={() => void jumpToAddress()}
          disabled={jumping || !addressValue.trim()}
          className="btn-ghost !text-[11px] !px-2 shrink-0"
          title="跳转到输入的路径"
          aria-label="跳转到输入的路径"
        >
          {jumping ? <Loader2 className="w-3 h-3 animate-spin" /> : '跳转'}
        </button>
      </div>

      <div
        ref={treeContainerRef}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain py-1 [scrollbar-gutter:stable]"
        role="tree"
        aria-label="远程文件树"
        tabIndex={0}
      >
        {visible.map(entry => {
          const isDirectory = entry.kind === 'directory';
          const isExpanded = isDirectory && expanded.has(entry.path);
          const isSelected = entry.path === selectedPath;
          return (
            <button
              type="button"
              key={entry.path}
              role="treeitem"
              data-tree-path={entry.path}
              aria-expanded={isDirectory ? isExpanded : undefined}
              aria-selected={isSelected}
              onClick={() => onSelect(entry)}
              onDoubleClick={() => toggleDirectory(entry)}
              onContextMenu={event => handleContextMenu(event, entry)}
              className={`group w-full min-w-0 flex items-center gap-1.5 py-1.5 pr-2 text-left text-xs transition-colors ${
                isSelected ? 'bg-accent/10 text-accent' : 'text-scholar-200 hover:bg-scholar-800'
              }`}
              style={{ paddingLeft: `${8 + Math.min(entry.depth, 8) * 14}px` }}
              title={entry.path}
            >
              <span
                className="w-4 h-4 shrink-0 grid place-items-center text-scholar-400"
                onClick={event => { event.stopPropagation(); toggleDirectory(entry); }}
              >
                {isDirectory
                  ? loading.has(entry.path) ? <Loader2 className="w-3 h-3 animate-spin" />
                    : isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />
                  : null}
              </span>
              {isDirectory
                ? isExpanded ? <FolderOpen className="w-3.5 h-3.5 shrink-0" /> : <Folder className="w-3.5 h-3.5 shrink-0" />
                : <File className="w-3.5 h-3.5 shrink-0 text-scholar-400" />}
              {renaming === entry.path ? (
                <input
                  ref={renameInputRef}
                  className="file-transfer-inline-input min-w-0 flex-1 !text-xs !py-0.5"
                  value={renameValue}
                  onChange={event => setRenameValue(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') void submitRename();
                    if (event.key === 'Escape') setRenaming(null);
                  }}
                  onBlur={() => void submitRename()}
                  onClick={event => event.stopPropagation()}
                  data-testid="tree-rename-input"
                />
              ) : (
                <span className="truncate">{entry.name}</span>
              )}
            </button>
          );
        })}
      </div>

      {pickMode && (
        <div className="p-2 border-t border-scholar-700 bg-scholar-900 space-y-2">
          <p className="text-[10px] text-scholar-400 truncate" title={pickedPath || pickHint}>
            {pickedPath || pickHint}
          </p>
          <div className="flex gap-1.5">
            <button type="button" className="btn-ghost flex-1" onClick={onCancelPick}>取消</button>
            <button
              type="button"
              className="btn-primary flex-1"
              disabled={!pickedPath}
              onClick={() => pickedPath && onConfirmPick?.(pickedPath)}
            >
              {pickConfirmLabel}
            </button>
          </div>
        </div>
      )}

      {/* 右键菜单 — portal 到 body：侧栏 overflow hidden，直接渲染会被裁剪 */}
      {contextMenu && menuEntry && createPortal(
        <div
          ref={contextMenuRef}
          className="file-transfer-context-menu"
          style={contextMenuStyle}
          data-testid="tree-context-menu"
          role="menu"
        >
          <button
            type="button"
            onClick={() => { setContextMenu(null); openEntry(menuEntry); }}
            className="context-menu-item"
            role="menuitem"
          >
            <ExternalLink className="w-4 h-4" />
            <span>打开</span>
          </button>
          <div className="context-menu-divider" />
          <button
            type="button"
            onClick={() => { setContextMenu(null); copyEntries(menuEntry); }}
            className="context-menu-item"
            role="menuitem"
          >
            <Copy className="w-4 h-4" />
            <span>复制</span>
          </button>
          {!menuEntryIsRoot && (
            <button
              type="button"
              onClick={() => { setContextMenu(null); cutEntries(menuEntry); }}
              className="context-menu-item"
              role="menuitem"
            >
              <Scissors className="w-4 h-4" />
              <span>剪切</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setContextMenu(null);
              void pasteInto(menuEntry.kind === 'directory' ? menuEntry.path : parentPath(menuEntry.path));
            }}
            className="context-menu-item"
            role="menuitem"
            disabled={!clipboard}
            title={clipboard ? '粘贴到此目录' : '请先复制或剪切文件'}
          >
            <ClipboardPaste className="w-4 h-4" />
            <span>粘贴</span>
          </button>
          <button
            type="button"
            onClick={() => { setContextMenu(null); copyPathOf(menuEntry); }}
            className="context-menu-item"
            role="menuitem"
          >
            <Copy className="w-4 h-4" />
            <span>复制路径</span>
          </button>
          <div className="context-menu-divider" />
          {!menuEntryIsRoot && (
            <button
              type="button"
              onClick={() => { setContextMenu(null); startRename(menuEntry); }}
              className="context-menu-item"
              role="menuitem"
            >
              <Pencil className="w-4 h-4" />
              <span>重命名</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => { setContextMenu(null); void downloadEntry(menuEntry); }}
            className="context-menu-item"
            role="menuitem"
            disabled={!window.traceDesktop?.dialog}
            title={window.traceDesktop?.dialog ? '下载到本地' : '桌面应用模式下可用'}
          >
            <Download className="w-4 h-4" />
            <span>下载到本地</span>
          </button>
          {!menuEntryIsRoot && (
            <>
              <div className="context-menu-divider" />
              <button
                type="button"
                onClick={() => { setContextMenu(null); void requestDelete(menuEntry); }}
                className="context-menu-item context-menu-item-danger"
                role="menuitem"
              >
                <Trash2 className="w-4 h-4" />
                <span>删除</span>
              </button>
            </>
          )}
        </div>,
        document.body,
      )}

      {/* 删除确认弹窗 */}
      {deleteConfirm && (
        <div
          className="file-transfer-dialog-overlay"
          data-testid="tree-delete-confirm-dialog"
        >
          <div
            className="file-transfer-dialog"
            role="dialog"
            aria-label="确认删除"
          >
            <h3 className="dialog-title">确认删除</h3>
            <p className="dialog-body">
              确定要删除 {deleteConfirm.total} 个项目吗？（包括子目录）
            </p>
            <div className="file-transfer-dialog-actions">
              <button
                type="button"
                onClick={() => setDeleteConfirm(null)}
                className="file-transfer-btn-cancel"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                className="file-transfer-btn-danger"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* “打开”文件：预览浮层 */}
      {previewEntry && (
        <FilePreview
          file={previewEntry}
          source="remote"
          sessionId={sessionId}
          onClose={() => setPreviewEntry(null)}
        />
      )}
    </div>
  );
}
