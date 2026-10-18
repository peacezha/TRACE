import type { Express, Response } from 'express';
import { resolveRequestSessionId } from '../cluster/sessionRequest';
import type { JobEntry } from '../ai/types';
import { loadJobEvents } from './jobWatcher';
import {
  loadSchedulerType, saveSchedulerType, jobsCommand, parseJobsOutput,
  PROCESSES_COMMAND, parseProcessesOutput, type SchedulerType,
} from './scheduler';
import { loadNotifyConfig, saveNotifyConfig, sendNotification, type NotifyConfig } from './notifyService';

interface NotifyRouteSession {
  cluster: {
    exec: (cmd: string, timeout?: number) => Promise<string>;
    /** 登录探测打标签的调度器；旧会话可能缺省 */
    scheduler?: SchedulerType;
  };
}

type ResolveSession = (sessionId: string | undefined) => NotifyRouteSession | undefined;

/** 聚合接口（/api/jobs/summary/all）需要的会话视图：由 server.ts 遍历 sessions Map 注入 */
export interface ListedClusterSession {
  sessionId: string;
  host: string;
  username: string;
  /** 连接状态（ConnectionState）；只采集 connected */
  state: string;
  cluster: NotifyRouteSession['cluster'];
}

export type ListClusterSessions = () => ListedClusterSession[];

/** 聚合接口的单集群条目：字段命名对齐 /api/jobs/summary 响应（jobs/scheduler/updatedAt） */
export interface ClusterJobsSummaryEntry {
  sessionId: string;
  host: string;
  username: string;
  /** 采集成功时为实际使用的调度器；失败时退回登录探测标签（可能为 null） */
  scheduler: SchedulerType | null;
  running: number;
  pending: number;
  jobs: JobEntry[];
  updatedAt: number;
  /** 单集群采集失败/超时时降级到条目级 error，不影响其他集群 */
  error?: string;
}

// 本地工作台哨兵不是 SSH 会话，聚合时跳过（与 sessionRequest 的哨兵表保持一致）
const LOCAL_WORKBENCH_SENTINELS = new Set(['local-workbench', 'local', 'none']);

// 聚合接口整体 15s 上限：各集群并发采集，单条 exec 自带 15s 超时，这里再兜一层
const ALL_SUMMARY_TIMEOUT_MS = 15_000;

/** 单会话作业采集：/api/jobs/summary 与 /api/jobs/summary/all 共用，
 *  会话登录探测打标签的调度器优先，旧会话回退全局配置。 */
async function collectJobsSummary(
  cluster: NotifyRouteSession['cluster'],
): Promise<{ scheduler: SchedulerType; jobs: JobEntry[] }> {
  const scheduler = cluster.scheduler ?? await loadSchedulerType();
  const jobsRaw = await cluster.exec(jobsCommand(scheduler), 15_000);
  return { scheduler, jobs: parseJobsOutput(scheduler, jobsRaw) };
}

function countByStatus(jobs: JobEntry[], status: JobEntry['status']): number {
  return jobs.filter(job => job.status === status).length;
}

async function collectClusterSummary(listed: ListedClusterSession): Promise<ClusterJobsSummaryEntry> {
  try {
    const { scheduler, jobs } = await collectJobsSummary(listed.cluster);
    return {
      sessionId: listed.sessionId,
      host: listed.host,
      username: listed.username,
      scheduler,
      running: countByStatus(jobs, 'RUN'),
      pending: countByStatus(jobs, 'PEND'),
      jobs,
      updatedAt: Date.now(),
    };
  } catch (err: any) {
    return {
      sessionId: listed.sessionId,
      host: listed.host,
      username: listed.username,
      scheduler: listed.cluster.scheduler ?? null,
      running: 0,
      pending: 0,
      jobs: [],
      updatedAt: Date.now(),
      error: err?.message || String(err),
    };
  }
}

/** 单集群采集加 15s 上限：超时降级为该条目 error，Promise.all 整体因此也在 15s 内返回 */
function collectClusterSummaryWithTimeout(listed: ListedClusterSession): Promise<ClusterJobsSummaryEntry> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ClusterJobsSummaryEntry>(resolve => {
    timer = setTimeout(() => {
      resolve({
        sessionId: listed.sessionId,
        host: listed.host,
        username: listed.username,
        scheduler: listed.cluster.scheduler ?? null,
        running: 0,
        pending: 0,
        jobs: [],
        updatedAt: Date.now(),
        error: `查询超时（${ALL_SUMMARY_TIMEOUT_MS / 1000} 秒无响应）`,
      });
    }, ALL_SUMMARY_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([collectClusterSummary(listed), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ success: false, error: message });
}

const CHANNELS = ['serverchan', 'pushplus', 'wecom', 'feishu', 'email'];

export function registerNotificationRoutes(
  app: Express,
  resolveSession: ResolveSession,
  listSessions?: ListClusterSessions,
): void {
  const withSession = (req: any, res: Response): NotifyRouteSession | undefined => {
    const sessionId = resolveRequestSessionId({
      cookie: req.session?.sshSessionId,
      header: req.get('X-SSH-Session-Id'),
      auth: undefined,
    }, id => Boolean(resolveSession(id)));
    const session = sessionId ? resolveSession(sessionId) : undefined;
    if (!session) {
      sendError(res, 401, '需要活跃的 SSH 会话');
      return undefined;
    }
    return session;
  };

  // 对话工作台顶部的轻量状态条只需要调度器作业，不应每次轮询都额外执行 ps。
  app.get('/api/jobs/summary', async (req, res) => {
    const session = withSession(req, res);
    if (!session) return;
    try {
      const { scheduler, jobs } = await collectJobsSummary(session.cluster);
      res.json({
        success: true,
        jobs,
        scheduler,
        updatedAt: Date.now(),
      });
    } catch (err: any) {
      sendError(res, 500, err.message || String(err));
    }
  });

  // 全部已连接集群的作业概况（左侧边栏多集群状态行）：无需会话头，遍历注入的会话表；
  // 单集群失败/超时降级为该条目 error，本地工作台哨兵与未连接会话跳过。
  app.get('/api/jobs/summary/all', async (_req, res) => {
    try {
      const listed = (listSessions?.() ?? []).filter(
        session => session.state === 'connected' && !LOCAL_WORKBENCH_SENTINELS.has(session.sessionId),
      );
      const clusters = await Promise.all(listed.map(collectClusterSummaryWithTimeout));
      res.json({ success: true, clusters });
    } catch (err: any) {
      sendError(res, 500, err.message || String(err));
    }
  });

  // 当前作业列表 + 当前用户的 Linux 进程
  app.get('/api/jobs', async (req, res) => {
    const session = withSession(req, res);
    if (!session) return;
    try {
      // 会话登录时已探测打标签的调度器优先；旧会话回退全局配置
      const scheduler = session.cluster.scheduler ?? await loadSchedulerType();
      const [jobsRaw, psRaw] = await Promise.all([
        session.cluster.exec(jobsCommand(scheduler), 15_000),
        // ps 失败不阻塞作业列表
        session.cluster.exec(PROCESSES_COMMAND, 15_000).catch(() => ''),
      ]);
      res.json({
        success: true,
        jobs: parseJobsOutput(scheduler, jobsRaw),
        processes: parseProcessesOutput(psRaw),
        scheduler,
      });
    } catch (err: any) {
      sendError(res, 500, err.message || String(err));
    }
  });

  // 当前调度器（lsf / slurm）
  app.get('/api/jobs/scheduler', async (_req, res) => {
    try {
      res.json({ success: true, scheduler: await loadSchedulerType() });
    } catch (err: any) {
      sendError(res, 500, err.message || String(err));
    }
  });

  // 切换调度器
  app.put('/api/jobs/scheduler', async (req, res) => {
    try {
      const scheduler = req.body?.scheduler;
      if (!['lsf', 'slurm', 'pbs', 'donau', 'none'].includes(scheduler)) {
        sendError(res, 400, 'scheduler 必须是 lsf/slurm/pbs/donau/none 之一');
        return;
      }
      await saveSchedulerType(scheduler as SchedulerType);
      res.json({ success: true, scheduler });
    } catch (err: any) {
      sendError(res, 500, err.message || String(err));
    }
  });

  // 作业完成事件（最近 50 条）
  app.get('/api/jobs/events', async (_req, res) => {
    try {
      res.json({ success: true, events: await loadJobEvents() });
    } catch (err: any) {
      sendError(res, 500, err.message || String(err));
    }
  });

  // 通知配置（脱敏返回）
  app.get('/api/notify/config', async (_req, res) => {
    try {
      const config = await loadNotifyConfig();
      res.json({
        success: true,
        config: {
          ...config,
          smtpPass: config.smtpPass ? '******' : '',
        },
      });
    } catch (err: any) {
      sendError(res, 500, err.message || String(err));
    }
  });

  // 保存通知配置
  app.put('/api/notify/config', async (req, res) => {
    try {
      const body = req.body || {};
      const channel = CHANNELS.includes(body.channel) ? body.channel : 'serverchan';
      const current = await loadNotifyConfig();
      const next: NotifyConfig = {
        enabled: Boolean(body.enabled),
        channel,
        sendKey: body.sendKey !== undefined ? String(body.sendKey || '').trim() : current.sendKey,
        token: body.token !== undefined ? String(body.token || '').trim() : current.token,
        webhook: body.webhook !== undefined ? String(body.webhook || '').trim() : current.webhook,
        smtpHost: body.smtpHost !== undefined ? String(body.smtpHost || '').trim() : current.smtpHost,
        smtpPort: body.smtpPort !== undefined ? Number(body.smtpPort) || 465 : current.smtpPort,
        smtpUser: body.smtpUser !== undefined ? String(body.smtpUser || '').trim() : current.smtpUser,
        // '******' 表示未修改，保留原值
        smtpPass: body.smtpPass === '******' ? current.smtpPass
          : body.smtpPass !== undefined ? String(body.smtpPass || '').trim()
          : current.smtpPass,
        mailTo: body.mailTo !== undefined ? String(body.mailTo || '').trim() : current.mailTo,
      };
      await saveNotifyConfig(next);
      res.json({ success: true });
    } catch (err: any) {
      sendError(res, 500, err.message || String(err));
    }
  });

  // 发送测试通知
  app.post('/api/notify/test', async (_req, res) => {
    try {
      const config = await loadNotifyConfig();
      const result = await sendNotification(
        config,
        '🔔 TRACE 通知测试',
        `这是一条来自 TRACE 的测试消息。\n如果你看到它，说明作业完成提醒已经可以正常工作。\n时间：${new Date().toLocaleString('zh-CN')}`,
      );
      if (result.ok) res.json({ success: true });
      else sendError(res, 400, result.error || '发送失败');
    } catch (err: any) {
      sendError(res, 500, err.message || String(err));
    }
  });
}
