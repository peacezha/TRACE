import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, ChevronRight, Loader2, RefreshCw, Server } from 'lucide-react';

interface JobEntry {
  jobId: string;
  name: string;
  status: 'RUN' | 'PEND' | 'DONE' | 'EXIT' | 'UNKNOWN';
  queue?: string;
  runtime?: string;
}

type SchedulerType = 'lsf' | 'slurm' | 'pbs' | 'donau' | 'none' | 'unknown';

interface ClusterJobStatusBarProps {
  sessionId?: string | null;
  targetLabel?: string;
  onOpenDetails: () => void;
  pollIntervalMs?: number;
}

const STATUS_STYLES: Record<JobEntry['status'], string> = {
  RUN: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-500',
  PEND: 'border-amber-500/25 bg-amber-500/10 text-amber-500',
  DONE: 'border-scholar-600 bg-scholar-800/70 text-scholar-300',
  EXIT: 'border-red-500/25 bg-red-500/10 text-red-500',
  UNKNOWN: 'border-scholar-600 bg-scholar-800/70 text-scholar-400',
};

const SCHEDULER_LABEL: Record<SchedulerType, string> = {
  lsf: 'LSF',
  slurm: 'Slurm',
  pbs: 'PBS',
  donau: 'Donau',
  none: '无调度器',
  unknown: '调度器未知',
};

function normalizeJobs(value: unknown): JobEntry[] {
  if (!Array.isArray(value)) return [];
  const validStatuses = new Set<JobEntry['status']>(['RUN', 'PEND', 'DONE', 'EXIT', 'UNKNOWN']);
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as Partial<JobEntry>;
    const jobId = String(raw.jobId || '').trim();
    if (!jobId) return [];
    const status = validStatuses.has(raw.status as JobEntry['status'])
      ? raw.status as JobEntry['status']
      : 'UNKNOWN';
    return [{
      jobId,
      name: String(raw.name || `Job ${jobId}`),
      status,
      queue: raw.queue ? String(raw.queue) : undefined,
      runtime: raw.runtime ? String(raw.runtime) : undefined,
    }];
  });
}

/** 主对话顶部的轻量集群作业概览；详细设置仍由 JobsPanel 负责。 */
export default function ClusterJobStatusBar({
  sessionId,
  targetLabel,
  onOpenDetails,
  pollIntervalMs = 30_000,
}: ClusterJobStatusBarProps) {
  const [jobs, setJobs] = useState<JobEntry[]>([]);
  const [scheduler, setScheduler] = useState<SchedulerType>('lsf');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/jobs/summary', {
        headers: { 'X-SSH-Session-Id': sessionId },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || '获取集群任务失败');
      setJobs(normalizeJobs(body?.jobs));
      setScheduler(['slurm', 'pbs', 'donau', 'none', 'unknown'].includes(body?.scheduler) ? body.scheduler : 'lsf');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setJobs([]);
      setError('');
      setLoading(false);
      return;
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [pollIntervalMs, refresh, sessionId]);

  const activeJobs = useMemo(
    () => jobs.filter(job => job.status === 'RUN' || job.status === 'PEND'),
    [jobs],
  );
  const running = activeJobs.filter(job => job.status === 'RUN').length;
  const pending = activeJobs.filter(job => job.status === 'PEND').length;

  if (!sessionId) {
    return (
      <div data-cluster-job-status className="flex min-h-11 shrink-0 items-center gap-3 border-b border-scholar-700 bg-scholar-950/35 px-5 py-2">
        <span className="flex items-center gap-2 text-xs font-medium text-scholar-300">
          <Server className="h-3.5 w-3.5 text-scholar-500" /> 集群任务
        </span>
        <span className="text-[11px] text-scholar-500">未连接计算资源</span>
        <button type="button" onClick={onOpenDetails} className="ml-auto flex items-center gap-1 text-[11px] text-accent hover:underline">
          配置计算资源 <ChevronRight className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <div data-cluster-job-status className="flex min-h-11 shrink-0 items-center gap-2.5 border-b border-scholar-700 bg-scholar-950/35 px-5 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <Activity className="h-3.5 w-3.5 shrink-0 text-accent" />
        <span className="shrink-0 text-xs font-medium text-scholar-200">集群任务</span>
        <span className="max-w-44 truncate text-[10px] text-scholar-500" title={targetLabel}>{targetLabel || '当前集群'} · {SCHEDULER_LABEL[scheduler]}</span>
      </div>

      <div className="flex shrink-0 items-center gap-1.5" aria-label={`运行 ${running}，排队 ${pending}`}>
        <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-500">运行 {running}</span>
        <span className="rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500">排队 {pending}</span>
      </div>

      <div className="hidden min-w-0 flex-1 items-center gap-1.5 lg:flex">
        {error ? (
          <span className="truncate text-[10px] text-red-500" title={error}>刷新失败：{error}</span>
        ) : activeJobs.length === 0 ? (
          <span className="text-[10px] text-scholar-500">当前没有运行或排队任务</span>
        ) : (
          activeJobs.slice(0, 3).map(job => (
            <span
              key={`${job.jobId}-${job.status}`}
              className={`flex min-w-0 max-w-48 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${STATUS_STYLES[job.status]}`}
              title={`${job.name} · ${job.jobId}${job.queue ? ` · ${job.queue}` : ''}`}
            >
              <span className="font-medium">{job.status}</span>
              <span className="truncate text-scholar-300">{job.name}</span>
              <span className="text-scholar-500">#{job.jobId}</span>
            </span>
          ))
        )}
        {activeJobs.length > 3 && <span className="shrink-0 text-[10px] text-scholar-500">+{activeJobs.length - 3}</span>}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="btn-icon !h-7 !w-7"
          aria-label="刷新集群任务"
          title="刷新集群任务"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </button>
        <button type="button" onClick={onOpenDetails} className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-accent hover:bg-scholar-800/70">
          详情 <ChevronRight className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
