import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity, RefreshCw, Loader2, X, Bell, BellOff, CheckCircle2, XCircle,
  ChevronDown, ChevronRight, Send, Settings,
} from 'lucide-react';
import { getStoredLocale } from '../i18n';

interface JobEntry {
  jobId: string;
  name: string;
  status: 'RUN' | 'PEND' | 'DONE' | 'EXIT' | 'UNKNOWN';
  queue: string;
}

interface JobEvent {
  jobId: string;
  name: string;
  status: 'DONE' | 'EXIT';
  queue: string;
  time: number;
  notified: boolean;
  notifyError?: string;
  /** 作业输出尾部摘要（服务端采集，可能缺失） */
  excerpt?: string;
}

interface ProcessEntry {
  pid: string;
  stat: string;
  etime: string;
  cpu: string;
  mem: string;
  command: string;
}

type SchedulerType = 'lsf' | 'slurm' | 'pbs' | 'donau' | 'none' | 'unknown';

const SCHEDULER_LABELS: Record<SchedulerType, string> = {
  lsf: 'LSF',
  slurm: 'Slurm',
  pbs: 'PBS',
  donau: 'Donau',
  none: '无调度器',
  unknown: '调度器未知',
};

/** 未识别或探测失败不得回退成 LSF；legacy 空值才保留旧默认。 */
function normalizeSchedulerType(value: unknown): SchedulerType {
  return value === 'slurm' || value === 'pbs' || value === 'donau' || value === 'none' || value === 'unknown' ? value : 'lsf';
}

interface NotifyConfig {
  enabled: boolean;
  channel: 'serverchan' | 'pushplus' | 'wecom' | 'feishu' | 'email';
  sendKey?: string;
  token?: string;
  webhook?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  mailTo?: string;
}

interface JobsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** 多集群标签页：作业查询路由到对应集群 */
  sessionId?: string | null;
}

// 深浅主题通用：500 级文字 + 同色相低透明底（参照 FlowRunnerDrawer 的 emerald 用法）
const STATUS_STYLES: Record<string, string> = {
  RUN: 'bg-emerald-500/15 text-emerald-500',
  PEND: 'bg-amber-500/15 text-amber-500',
  DONE: 'bg-scholar-700/50 text-scholar-300',
  EXIT: 'bg-red-500/15 text-red-500',
  UNKNOWN: 'bg-scholar-700/50 text-scholar-400',
};

const CHANNEL_LABELS: Record<string, string> = {
  serverchan: 'Server酱（微信推送）',
  pushplus: 'PushPlus（微信推送）',
  wecom: '企业微信群机器人',
  feishu: '飞书群机器人',
  email: '邮件（SMTP）',
};

async function api(path: string, options: RequestInit = {}, sessionId?: string | null) {
  const res = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(sessionId ? { 'X-SSH-Session-Id': sessionId } : {}),
    },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** 是否已有可用的通知渠道：总开关打开且当前所选渠道的必填项已填写 */
function notifyChannelReady(config: NotifyConfig): boolean {
  if (!config.enabled) return false;
  switch (config.channel) {
    case 'serverchan': return !!config.sendKey;
    case 'pushplus': return !!config.token;
    case 'wecom':
    case 'feishu': return !!config.webhook;
    case 'email': return !!(config.smtpHost && config.smtpUser && config.mailTo);
    default: return false;
  }
}

export default function JobsPanel({ isOpen, onClose, sessionId }: JobsPanelProps) {
  const [jobs, setJobs] = useState<JobEntry[]>([]);
  const [processes, setProcesses] = useState<ProcessEntry[]>([]);
  const [scheduler, setScheduler] = useState<SchedulerType>('lsf');
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [config, setConfig] = useState<NotifyConfig | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState('');
  // 完成事件展开状态：key 为 jobId-time 序号组合，值是否展开输出摘要
  const [expandedEvents, setExpandedEvents] = useState<Record<string, boolean>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [jobsRes, eventsRes, configRes, schedulerRes] = await Promise.all([
        api('/api/jobs', {}, sessionId),
        api('/api/jobs/events', {}, sessionId),
        api('/api/notify/config', {}, sessionId),
        api('/api/jobs/scheduler', {}, sessionId),
      ]);
      if (jobsRes.ok) {
        setJobs(jobsRes.data.jobs || []);
        setProcesses(jobsRes.data.processes || []);
      } else setError(jobsRes.data?.error || '获取作业失败');
      if (eventsRes.ok) setEvents(eventsRes.data.events || []);
      if (configRes.ok) setConfig(configRes.data.config);
      if (schedulerRes.ok) setScheduler(normalizeSchedulerType(schedulerRes.data.scheduler));
    } catch (e: any) {
      setError(e.message || '网络错误');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  const handleSchedulerChange = async (next: SchedulerType) => {
    setScheduler(next);
    const { ok } = await api('/api/jobs/scheduler', {
      method: 'PUT',
      body: JSON.stringify({ scheduler: next }),
    }, sessionId);
    if (ok) void refresh();
  };

  useEffect(() => {
    if (!isOpen) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [isOpen, refresh]);

  const handleSaveConfig = async () => {
    if (!config) return;
    setSaving(true);
    setNotice('');
    const { ok, data } = await api('/api/notify/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    }, sessionId);
    setSaving(false);
    setNotice(ok ? '已保存' : (data?.error || '保存失败'));
  };

  const handleTest = async () => {
    setTesting(true);
    setNotice('');
    // 先保存再测试，保证测试用的是最新配置
    if (config) {
      await api('/api/notify/config', { method: 'PUT', body: JSON.stringify(config) }, sessionId);
    }
    const { ok, data } = await api('/api/notify/test', { method: 'POST' }, sessionId);
    setTesting(false);
    setNotice(ok ? '测试消息已发送，请查收' : (data?.error || '发送失败'));
  };

  if (!isOpen) return null;

  const dateLocale = getStoredLocale();

  const field = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    placeholder = '',
    type = 'text',
  ) => (
    <div>
      <label className="block text-[11px] text-scholar-400 mb-0.5">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-scholar-950 border border-scholar-600 rounded px-2 py-1.5 text-xs text-scholar-100 focus:outline-none focus:ring-2 focus:ring-accent/50"
      />
    </div>
  );

  return (
    <div className="h-full flex flex-col bg-scholar-900/80 border-l border-scholar-700">
      {/* 头部 */}
      <div className="p-3 border-b border-scholar-700 shrink-0">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-scholar-100 flex items-center gap-2">
            <Activity className="w-4 h-4 text-accent" /> 作业监控
          </h3>
          <div className="flex gap-1">
            <button onClick={refresh} className="p-1 text-scholar-400 hover:text-scholar-200" title="刷新">
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            </button>
            <button onClick={onClose} className="p-1 text-scholar-400 hover:text-scholar-200" aria-label="关闭">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
        {/* 调度器选择 */}
        <div className="mt-2 flex items-center gap-2">
          <label className="text-[11px] text-scholar-400 shrink-0">调度器</label>
          <select
            value={scheduler}
            onChange={e => void handleSchedulerChange(e.target.value as SchedulerType)}
            className="flex-1 bg-scholar-950 border border-scholar-600 rounded px-2 py-1 text-xs text-scholar-100 focus:outline-none focus:ring-2 focus:ring-accent/50"
          >
            {Object.entries(SCHEDULER_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto" ref={scrollRef}>
        {/* 通知开关与设置 */}
        {config && (
          <div className="p-3 border-b border-scholar-700">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 cursor-pointer text-xs text-scholar-200 select-none">
                <input
                  type="checkbox"
                  checked={config.enabled}
                  onChange={e => setConfig({ ...config, enabled: e.target.checked })}
                  className="w-3.5 h-3.5 accent-accent"
                />
                {config.enabled ? (
                  <span className="flex items-center gap-1 text-emerald-600"><Bell className="w-3.5 h-3.5" /> 完成时提醒我</span>
                ) : (
                  <span className="flex items-center gap-1 text-scholar-400"><BellOff className="w-3.5 h-3.5" /> 提醒已关闭</span>
                )}
              </label>
              <button
                onClick={() => setShowSettings(s => !s)}
                className="flex items-center gap-1 text-xs text-accent hover:underline"
              >
                <Settings className="w-3.5 h-3.5" />
                {showSettings ? '收起' : '通知设置'}
                {showSettings ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              </button>
            </div>

            {showSettings && (
              <div className="mt-2.5 space-y-2">
                <div>
                  <label className="block text-[11px] text-scholar-400 mb-0.5">通知渠道</label>
                  <select
                    value={config.channel}
                    onChange={e => setConfig({ ...config, channel: e.target.value as NotifyConfig['channel'] })}
                    className="w-full bg-scholar-950 border border-scholar-600 rounded px-2 py-1.5 text-xs text-scholar-100 focus:outline-none focus:ring-2 focus:ring-accent/50"
                  >
                    {Object.entries(CHANNEL_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>

                {config.channel === 'serverchan' && field('SendKey（sct.ftqq.com 登录后获取）', config.sendKey || '', v => setConfig({ ...config, sendKey: v }), 'SCU 或 sctp 开头')}
                {config.channel === 'pushplus' && field('Token（pushplus.plus 获取）', config.token || '', v => setConfig({ ...config, token: v }))}
                {config.channel === 'wecom' && field('群机器人 Webhook 地址', config.webhook || '', v => setConfig({ ...config, webhook: v }), 'https://qyapi.weixin.qq.com/...')}
                {config.channel === 'feishu' && field('飞书机器人 Webhook 地址', config.webhook || '', v => setConfig({ ...config, webhook: v }), 'https://open.feishu.cn/open-apis/bot/v2/hook/...')}
                {config.channel === 'email' && (
                  <>
                    {field('SMTP 服务器', config.smtpHost || '', v => setConfig({ ...config, smtpHost: v }), 'smtp.qq.com')}
                    {field('端口', String(config.smtpPort ?? 465), v => setConfig({ ...config, smtpPort: Number(v) || 465 }), '465')}
                    {field('邮箱账号', config.smtpUser || '', v => setConfig({ ...config, smtpUser: v }), 'you@qq.com')}
                    {field('授权码（非登录密码）', config.smtpPass || '', v => setConfig({ ...config, smtpPass: v }), '', 'password')}
                    {field('收件人', config.mailTo || '', v => setConfig({ ...config, mailTo: v }), 'you@qq.com')}
                  </>
                )}

                <div className="flex gap-2 pt-1">
                  <button onClick={handleSaveConfig} disabled={saving} className="btn-primary flex-1 !text-xs">
                    {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} 保存
                  </button>
                  <button onClick={handleTest} disabled={testing} className="btn-ghost flex-1 !text-xs border border-scholar-600">
                    {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3 h-3" />} 测试发送
                  </button>
                </div>
              </div>
            )}
            {notice && <p className="mt-2 text-xs text-accent">{notice}</p>}
          </div>
        )}

        {error && <p className="mx-3 mt-2 text-xs text-red-600">{error}</p>}

        {/* 在跑作业 */}
        <div className="p-3 pb-2">
          <h4 className="text-xs font-medium text-scholar-300 mb-2">在跑作业 · {SCHEDULER_LABELS[scheduler]} ({jobs.filter(j => j.status === 'RUN' || j.status === 'PEND').length})</h4>
          {!loading && jobs.filter(j => j.status === 'RUN' || j.status === 'PEND').length === 0 ? (
            <p className="text-xs text-scholar-500 py-3 text-center">没有在跑或排队的作业</p>
          ) : (
            <div className="space-y-1">
              {jobs.filter(j => j.status === 'RUN' || j.status === 'PEND').map(j => (
                <div key={j.jobId} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-scholar-800/60 text-xs">
                  <span className={`w-16 text-center px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${STATUS_STYLES[j.status] || STATUS_STYLES.UNKNOWN}`}>{j.status}</span>
                  <span className="flex-1 min-w-0 truncate text-scholar-100" title={j.name}>{j.name}</span>
                  <span className="text-scholar-500 shrink-0">{j.jobId}</span>
                  <span className="text-scholar-500 shrink-0 w-16 text-right truncate" title={j.queue}>{j.queue}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 我的进程（登录节点当前用户） */}
        <div className="p-3 pt-1 pb-2">
          <h4 className="text-xs font-medium text-scholar-300 mb-2">我的进程 ({processes.length})</h4>
          {processes.length === 0 ? (
            <p className="text-xs text-scholar-500 py-3 text-center">没有正在运行的进程</p>
          ) : (
            <div className="space-y-1">
              {processes.map(p => (
                <div key={p.pid} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-scholar-800/60 text-xs">
                  <span className="w-12 text-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-sky-500/15 text-sky-500 shrink-0">{p.stat}</span>
                  <span className="flex-1 min-w-0 truncate text-scholar-100" title={p.command}>{p.command}</span>
                  <span className="text-scholar-500 shrink-0">{p.pid}</span>
                  <span className="text-scholar-500 shrink-0 w-16 text-right">{p.etime}</span>
                  <span className="text-scholar-500 shrink-0 w-20 text-right" title="CPU% · MEM%">{p.cpu}%·{p.mem}%</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 完成事件 */}
        <div className="p-3 pt-1">
          <h4 className="text-xs font-medium text-scholar-300 mb-2">完成事件 ({events.length})</h4>
          {/* 未启用任何通知渠道时，提示可配置飞书/邮件推送（桌面 toast 不受此开关影响） */}
          {config && !notifyChannelReady(config) && (
            <div className="mb-2 flex items-center gap-2 rounded-lg border border-scholar-700 bg-scholar-800/40 px-2 py-1.5">
              <p className="flex-1 text-[10px] leading-4 text-scholar-400">可在通知设置里配置飞书/邮件推送作业完成消息</p>
              <button
                type="button"
                onClick={() => {
                  setShowSettings(true);
                  // jsdom 等环境没有 scrollTo 实现，可选调用兜底
                  scrollRef.current?.scrollTo?.({ top: 0, behavior: 'smooth' });
                }}
                className="shrink-0 text-[10px] text-accent hover:underline"
              >
                通知设置
              </button>
            </div>
          )}
          {events.length === 0 ? (
            <p className="text-xs text-scholar-500 py-3 text-center">暂无完成的作业</p>
          ) : (
            <div className="space-y-1">
              {events.slice(0, 20).map((e, i) => {
                const eventKey = `${e.jobId}-${e.time}-${i}`;
                const expanded = !!expandedEvents[eventKey];
                return (
                  <div key={eventKey} className="rounded-lg bg-scholar-800/60 text-xs">
                    <button
                      type="button"
                      onClick={() => setExpandedEvents(prev => ({ ...prev, [eventKey]: !prev[eventKey] }))}
                      aria-expanded={expanded}
                      className="flex w-full items-start gap-2 px-2 py-1.5 text-left"
                    >
                      {e.status === 'DONE' ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
                      ) : (
                        <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-scholar-100" title={e.name}>{e.name}</span>
                          <span className="text-scholar-500 shrink-0">{e.jobId}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-scholar-500">
                          <span>{new Date(e.time).toLocaleString(dateLocale)}</span>
                          {e.notified && <span className="text-emerald-600">已提醒</span>}
                          {e.notifyError && <span className="text-red-500" title={e.notifyError}>提醒失败</span>}
                        </div>
                      </div>
                      {expanded
                        ? <ChevronDown className="w-3.5 h-3.5 shrink-0 mt-0.5 text-scholar-500" />
                        : <ChevronRight className="w-3.5 h-3.5 shrink-0 mt-0.5 text-scholar-500" />}
                    </button>
                    {expanded && (
                      e.excerpt ? (
                        <pre className="mx-2 mb-2 max-h-80 overflow-y-auto whitespace-pre-wrap break-all rounded bg-scholar-950/70 p-2 font-mono text-[11px] leading-4 text-scholar-300">{e.excerpt}</pre>
                      ) : (
                        <p className="mx-2 mb-2 rounded bg-scholar-950/40 px-2 py-1.5 text-[11px] text-scholar-500">无输出摘要</p>
                      )
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
