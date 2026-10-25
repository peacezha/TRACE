export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'awaiting-fingerprint'
  | 'authenticating'
  | 'connected'
  | 'reconnecting'
  | 'failed';

export type FileSide = 'local' | 'remote';
export type EntryKind = 'file' | 'directory' | 'symlink';
/** 远程路径选取模式：只选文件 / 只选目录 / 文件或目录均可 */
export type PickPathKind = 'file' | 'folder' | 'any';
export type TransferDirection = 'upload' | 'download' | 'remote-copy';
export type TransferState =
  | 'queued'
  | 'running'
  | 'paused'
  | 'retrying'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type ConflictPolicy = 'ask' | 'overwrite' | 'resume' | 'skip' | 'rename';
export type VerificationMode = 'size' | 'sha256';

export interface FileEntry {
  name: string;
  path: string;
  kind: EntryKind;
  size: number;
  modifiedAt: number;
  permissions?: number;
  owner?: string;
  group?: string;
}

export interface HostProfileMetadata {
  id: string;
  name: string;
  group: string;
  host: string;
  port: number;
  username: string;
  favorite: boolean;
  defaultLocalPath?: string;
  defaultRemotePath?: string;
  fingerprint?: string;
  hasSavedPassword: boolean;
  hasSavedTotp: boolean;
  lastUsedAt?: number;
}

export interface TransferSourceFingerprint {
  size: number;
  /** 本地使用 mtimeMs；SFTP 的秒级 mtime 统一换算为毫秒。 */
  mtime: number;
}

export interface TransferTask {
  id: string;
  profileId: string;
  sessionId?: string;
  /** remote-copy 的源集群会话；sessionId 为目标（写入侧）集群 */
  sourceSessionId?: string;
  direction: TransferDirection;
  localPath: string;
  remotePath: string;
  temporaryPath: string;
  /** 创建传输时固定的源文件身份；旧版本持久记录可能缺失。 */
  sourceFingerprint?: TransferSourceFingerprint;
  totalBytes: number;
  transferredBytes: number;
  bytesPerSecond: number;
  state: TransferState;
  conflictPolicy: ConflictPolicy;
  verificationMode: VerificationMode;
  retryCount: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const allowedTransitions: Record<TransferState, TransferState[]> = {
  queued: ['running', 'paused', 'cancelled'],
  running: ['paused', 'retrying', 'completed', 'failed', 'cancelled'],
  paused: ['queued', 'cancelled'],
  retrying: ['running', 'paused', 'failed', 'cancelled'],
  failed: ['queued', 'cancelled'],
  completed: [],
  cancelled: [],
};

export function canTransitionTransfer(from: TransferState, to: TransferState): boolean {
  return allowedTransitions[from].includes(to);
}

export function makeTemporaryTransferName(
  targetPath: string,
  taskId: string,
  side: FileSide,
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw new Error('task ID is invalid');
  if (side !== 'local' && side !== 'remote') throw new Error('file side is required');

  const separatorIndex = side === 'remote'
    ? targetPath.lastIndexOf('/')
    : Math.max(targetPath.lastIndexOf('/'), targetPath.lastIndexOf('\\'));
  const parent = targetPath.slice(0, separatorIndex + 1);
  const name = targetPath.slice(separatorIndex + 1) || 'transfer';
  return `${parent}.${name}.trace-${taskId}.part`;
}
