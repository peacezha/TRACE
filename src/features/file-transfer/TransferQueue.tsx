import { memo, useState, useCallback, useMemo } from 'react';
import {
  ArrowUp,
  ArrowDown,
  ArrowLeftRight,
  Pause,
  Play,
  X,
  RotateCcw,
  ChevronUp,
  ChevronDown,
  Trash2,
} from 'lucide-react';
import type { TransferTask, TransferState, TransferDirection } from '@/shared/fileTransfer';
import type { TransferSummary } from './controller';

export interface TransferQueueProps {
  tasks: TransferTask[];
  summary: TransferSummary;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onPauseAll: () => void;
  onResumeAll: () => void;
  onCancelAll: () => void;
  onClearCompleted: () => void;
}

type FilterTab = 'all' | 'active' | 'completed' | 'failed';

const FILTER_LABELS: Record<FilterTab, string> = {
  all: '全部',
  active: '进行中',
  completed: '已完成',
  failed: '失败',
};

const ACTIVE_STATES: TransferState[] = ['queued', 'running', 'paused', 'retrying'];

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatEta(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return '--';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function getSourceDisplay(task: TransferTask): string {
  if (task.direction === 'upload') {
    return task.localPath.split(/[/\\]/).pop() || task.localPath;
  }
  return task.remotePath.split('/').pop() || task.remotePath;
}

function getDestDisplay(task: TransferTask): string {
  if (task.direction === 'upload') {
    return task.remotePath;
  }
  return task.localPath;
}

/** 方向徽标：上传 / 下载 / 集群互传 */
function directionLabel(task: TransferTask): string {
  if (task.direction === 'upload') return '上传';
  if (task.direction === 'remote-copy') return '互传';
  return '下载';
}

interface TaskRowProps {
  task: TransferTask;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
}

// 任务行 memo 化：传输进度推送只重渲染对应任务行，而非整个队列
const TaskRow = memo(function TaskRow({ task, onPause, onResume, onCancel, onRetry }: TaskRowProps) {
  const progressPct =
    task.totalBytes > 0
      ? Math.min(100, Math.round((task.transferredBytes / task.totalBytes) * 100))
      : 0;
  const eta =
    task.bytesPerSecond > 0 && task.state === 'running'
      ? (task.totalBytes - task.transferredBytes) / task.bytesPerSecond
      : 0;

  const showPause = task.state === 'running' || task.state === 'queued' || task.state === 'retrying';
  const showResume = task.state === 'paused';
  const showRetry = task.state === 'failed';
  const showCancel = ACTIVE_STATES.includes(task.state);

  const stateLabels: Record<TransferState, string> = {
    queued: '排队中',
    running: '传输中',
    paused: '已暂停',
    retrying: '重试中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };

  return (
    <div
      className="file-transfer-queue-row"
      data-testid={`task-row-${task.id}`}
    >
      {/* Direction icon */}
      <div className="queue-col queue-col-direction" data-testid={`direction-icon-${task.id}`} title={directionLabel(task)}>
        {task.direction === 'upload' ? (
          <ArrowUp size={14} className="text-yellow-400" />
        ) : task.direction === 'remote-copy' ? (
          <ArrowLeftRight size={14} className="text-purple-400" />
        ) : (
          <ArrowDown size={14} className="text-blue-400" />
        )}
      </div>

      {/* Source filename */}
      <div className="queue-col queue-col-source" data-testid={`task-source-${task.id}`}>
        <span className="queue-filename" title={getSourceDisplay(task)}>
          {getSourceDisplay(task)}
        </span>
        {task.error && <span className="block truncate text-[10px] text-red-400" role="alert" title={task.error}>{task.error}</span>}
      </div>

      {/* Destination */}
      <div className="queue-col queue-col-dest" data-testid={`task-dest-${task.id}`}>
        <span className="queue-dest" title={getDestDisplay(task)}>
          {getDestDisplay(task)}
        </span>
      </div>

      {/* Progress bar */}
      <div className="queue-col queue-col-progress" data-testid={`progress-bar-${task.id}`}>
        <div className="queue-progress-bar">
          <div
            className="queue-progress-inner"
            data-testid={`progress-inner-${task.id}`}
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <span className="queue-progress-text">
          {formatBytes(task.transferredBytes)} / {formatBytes(task.totalBytes)} ({progressPct}%)
        </span>
      </div>

      {/* Rate and ETA */}
      <div className="queue-col queue-col-eta" data-testid={`eta-${task.id}`}>
        {task.bytesPerSecond > 0 && (
          <span className="queue-rate">{formatBytes(task.bytesPerSecond)}/s</span>
        )}
        {eta > 0 && <span className="queue-eta">{formatEta(eta)}</span>}
      </div>

      {/* State badge */}
      <div className="queue-col queue-col-state">
        <span
          className={`queue-state-badge queue-state-${task.state}`}
          data-testid={`state-badge-${task.id}`}
        >
          {stateLabels[task.state] || task.state}
        </span>
      </div>

      {/* Action buttons */}
      <div className="queue-col queue-col-actions">
        {showPause && (
          <button
            className="queue-action-btn"
            data-testid={`pause-btn-${task.id}`}
            onClick={() => onPause(task.id)}
            title="暂停"
          >
            <Pause size={14} />
          </button>
        )}
        {showResume && (
          <button
            className="queue-action-btn"
            data-testid={`resume-btn-${task.id}`}
            onClick={() => onResume(task.id)}
            title="继续"
          >
            <Play size={14} />
          </button>
        )}
        {showCancel && (
          <button
            className="queue-action-btn"
            data-testid={`cancel-btn-${task.id}`}
            onClick={() => onCancel(task.id)}
            title="停止此任务"
          >
            <X size={14} />
          </button>
        )}
        {showRetry && (
          <button
            className="queue-action-btn"
            data-testid={`retry-btn-${task.id}`}
            onClick={() => onRetry(task.id)}
            title="重试"
          >
            <RotateCcw size={14} />
          </button>
        )}
      </div>
    </div>
  );
});

export default function TransferQueue({
  tasks,
  summary,
  onPause,
  onResume,
  onCancel,
  onRetry,
  onPauseAll,
  onResumeAll,
  onCancelAll,
  onClearCompleted,
}: TransferQueueProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [filter, setFilter] = useState<FilterTab>('all');

  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), []);

  const filteredTasks = useMemo(() => {
    switch (filter) {
      case 'active':
        return tasks.filter((t) => ACTIVE_STATES.includes(t.state));
      case 'completed':
        return tasks.filter((t) => t.state === 'completed');
      case 'failed':
        return tasks.filter((t) => t.state === 'failed');
      default:
        return tasks;
    }
  }, [tasks, filter]);

  const completedCount = tasks.filter(
    (t) => t.state === 'completed' || t.state === 'cancelled',
  ).length;

  const hasCompleted = completedCount > 0;
  const canPauseAll = tasks.some((task) =>
    task.state === 'running' || task.state === 'queued' || task.state === 'retrying');
  const canResumeAll = tasks.some((task) => task.state === 'paused');
  const canCancelAll = tasks.some((task) => ACTIVE_STATES.includes(task.state));
  const statusText = tasks.length === 0
    ? '暂无传输任务'
    : summary.active > 0
      ? `${summary.active} 个进行中`
      : summary.failed > 0
        ? `${summary.failed} 个失败`
        : tasks.some(task => task.state === 'paused')
          ? '传输已暂停'
          : tasks.some(task => task.state === 'queued' || task.state === 'running' || task.state === 'retrying')
            ? '传输进行中'
            : '传输完成';

  if (collapsed) {
    return (
      <div className="file-transfer-queue file-transfer-queue-collapsed" data-testid="queue-collapsed">
        <button
          className="queue-toggle"
          data-testid="queue-toggle"
          onClick={toggleCollapsed}
        >
          <ChevronUp size={14} />
        </button>
        <span className="queue-status-strip">
          {statusText}
          {summary.progress > 0 && (
            <span className="queue-status-progress">
              {' '}— {Math.round(summary.progress * 100)}%
            </span>
          )}
        </span>
      </div>
    );
  }

  return (
    <div className="file-transfer-queue" data-testid="transfer-queue">
      {/* Header */}
      <div className="queue-header">
        <div className="queue-header-left">
          <button
            className="queue-toggle"
            data-testid="queue-toggle"
            onClick={toggleCollapsed}
          >
            <ChevronDown size={14} />
          </button>
          <span className="queue-title">传输队列</span>
          <span className="queue-count">{tasks.length} 个任务</span>
        </div>
        <div className="queue-header-right">
          <button
            className="queue-bulk-btn"
            data-testid="pause-all-btn"
            onClick={onPauseAll}
            disabled={!canPauseAll}
            title="暂停全部进行中和排队中的任务"
          >
            <Pause size={12} />
            全部暂停
          </button>
          <button
            className="queue-bulk-btn"
            data-testid="resume-all-btn"
            onClick={onResumeAll}
            disabled={!canResumeAll}
            title="继续全部已暂停任务"
          >
            <Play size={12} />
            全部继续
          </button>
          <button
            className="queue-bulk-btn queue-bulk-danger"
            data-testid="cancel-all-btn"
            onClick={onCancelAll}
            disabled={!canCancelAll}
            title="停止全部未完成任务"
          >
            <X size={12} />
            全部停止
          </button>
          {hasCompleted && (
            <button
              className="queue-clear-btn"
              data-testid="clear-completed-btn"
              onClick={onClearCompleted}
            >
              <Trash2 size={12} />
              清除已完成
            </button>
          )}
        </div>
      </div>

      {/* Filter tabs */}
      <div className="queue-filter-tabs">
        {(Object.keys(FILTER_LABELS) as FilterTab[]).map((tab) => (
          <button
            key={tab}
            className={`queue-filter-tab ${filter === tab ? 'queue-filter-tab-active' : ''}`}
            data-testid={`filter-tab-${tab}`}
            onClick={() => setFilter(tab)}
          >
            {FILTER_LABELS[tab]}
          </button>
        ))}
      </div>

      {/* Task rows */}
      <div className="queue-rows">
        {filteredTasks.length === 0 ? (
          <div className="queue-empty" data-testid="queue-empty">
            <span>无传输任务</span>
          </div>
        ) : (
          filteredTasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              onPause={onPause}
              onResume={onResume}
              onCancel={onCancel}
              onRetry={onRetry}
            />
          ))
        )}
      </div>
    </div>
  );
}
