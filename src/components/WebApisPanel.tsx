// 网络数据资源面板：浏览后端注册的公共生信数据库/网站 API。
// 目录挂载时一次性加载（GET /api/webapis，探针为后端 10 分钟缓存，不触发真实探测）；
// 卡片展开端点列表时按需取单服务详情（参数说明只在详情接口里，避免 55 个服务一次性拉全量）；
// 「全部测试」走 POST /api/webapis/probe 全量探针（并发 6，约 20–60s），结果合并进状态灯。
// 探针结果不做自动轮询，只随手动测试更新。

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Database,
  ExternalLink,
  Loader2,
  MessageSquare,
  Play,
  RefreshCw,
  Search,
} from 'lucide-react';

/** 与后端 server/webapis/health.ts 的缓存周期一致：超过视为过期，状态灯回退为“未测试” */
const PROBE_TTL_MS = 10 * 60_000;
/** 「试一下」结果在卡片内展示的字符上限（后端自身截断到 200k，这里只截展示） */
const TRY_RESULT_DISPLAY_LIMIT = 500;

type WebApiCategory =
  | 'genes-genomes'
  | 'proteins'
  | 'pathways'
  | 'compounds'
  | 'variants'
  | 'expression'
  | 'literature'
  | 'taxonomy'
  | 'plants'
  | 'microbes';

interface CatalogEndpoint {
  id: string;
  name: string;
  method: 'GET' | 'POST';
  path: string;
}

interface ProbeState {
  ok: boolean;
  status?: number;
  durationMs?: number;
  error?: string;
}

interface CatalogService {
  id: string;
  name: string;
  category: WebApiCategory;
  categoryLabel: { zh: string; en: string };
  description: string;
  homepage: string;
  docsUrl: string;
  authNote?: string;
  endpointCount: number;
  endpoints: CatalogEndpoint[];
  probe: ProbeState | null;
}

interface CatalogResponse {
  total: number;
  categories: Record<string, { count: number; label: { zh: string; en: string } }>;
  probeCache: { at: number; ttlMs: number } | null;
  services: CatalogService[];
}

interface DetailParam {
  name: string;
  required?: boolean;
  description: string;
  in?: 'path' | 'query' | 'body';
}

interface DetailEndpoint extends CatalogEndpoint {
  description: string;
  params?: DetailParam[];
}

/** GET /api/webapis/:id 的响应：详情端点含参数说明；probe 为探针定义（含默认参数） */
interface ServiceDetail {
  id: string;
  baseUrl: string;
  endpoints: DetailEndpoint[];
  probe?: { endpoint: string; params?: Record<string, string> };
}

interface InvokeSuccess {
  ok: true;
  url: string;
  status: number;
  durationMs: number;
  contentType: string;
  data?: unknown;
  text?: string;
  truncated: boolean;
}

interface InvokeFailure {
  ok: false;
  status?: number;
  durationMs?: number;
  error: { code: string; message: string };
}

type InvokeResult = InvokeSuccess | InvokeFailure;

type StatusLevel = 'ok' | 'fail' | 'unknown';

/** 状态灯语义：绿=最近探测可用；红=探测失败；黄=未测试或缓存已过期（超过 10 分钟） */
/** 「试一下」结果 → 发给 AI 的正文(项目 tsconfig 非 strict,union 收窄不生效,用显式断言) */
function tryBodyForAi(result: InvokeResult): string {
  if (result.ok === true) return formatTryBody(result as InvokeSuccess).slice(0, 4000);
  const failure = result as InvokeFailure;
  return `调用失败:${failure.error.code} ${failure.error.message}`;
}

function statusOf(probe: ProbeState | undefined, stale: boolean): StatusLevel {
  if (!probe || stale) return 'unknown';
  return probe.ok ? 'ok' : 'fail';
}

/** 「试一下」结果正文：JSON 美化，文本原样，展示截断到 500 字符 */
function formatTryBody(result: InvokeSuccess): string {
  const raw = result.data !== undefined ? JSON.stringify(result.data, null, 2) : (result.text ?? '');
  if (raw.length <= TRY_RESULT_DISPLAY_LIMIT) return raw;
  return `${raw.slice(0, TRY_RESULT_DISPLAY_LIMIT)}\n…（已截断，完整结果由后端返回）`;
}

export default function WebApisPanel({ onAskAi }: { onAskAi?: (text: string) => void }) {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});
  const [probedAt, setProbedAt] = useState<number | null>(null);
  const [probeAllRunning, setProbeAllRunning] = useState(false);
  const [probeAllSummary, setProbeAllSummary] = useState<{ okCount: number; total: number } | null>(null);
  const [probeAllError, setProbeAllError] = useState('');

  const loadCatalog = useCallback(async () => {
    setLoadingCatalog(true);
    setCatalogError('');
    try {
      const res = await fetch('/api/webapis');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as CatalogResponse;
      setCatalog(data);
      // 目录里的探针是后端 10 分钟缓存结果（可能为空），只作为状态灯初始值
      const initial: Record<string, ProbeState> = {};
      for (const service of data.services) {
        if (service.probe) initial[service.id] = service.probe;
      }
      setProbes(initial);
      setProbedAt(data.probeCache?.at ?? null);
    } catch (cause) {
      setCatalogError(cause instanceof Error ? cause.message : '目录加载失败');
    } finally {
      setLoadingCatalog(false);
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const runProbeAll = useCallback(async () => {
    setProbeAllRunning(true);
    setProbeAllError('');
    setProbeAllSummary(null);
    try {
      const res = await fetch('/api/webapis/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
      const results = Array.isArray(data.results) ? (data.results as Array<ProbeState & { serviceId: string }>) : [];
      setProbes(prev => {
        const next = { ...prev };
        for (const result of results) next[result.serviceId] = result;
        return next;
      });
      setProbedAt(Date.now());
      setProbeAllSummary({ okCount: data.okCount ?? results.filter(r => r.ok).length, total: data.total ?? results.length });
    } catch (cause) {
      setProbeAllError(cause instanceof Error ? cause.message : '全量测试失败');
    } finally {
      setProbeAllRunning(false);
    }
  }, []);

  const probesStale = probedAt !== null && Date.now() - probedAt > PROBE_TTL_MS;

  const categoryChips = useMemo(() => {
    if (!catalog) return [];
    return Object.entries(catalog.categories).map(([id, info]) => ({ id, count: info.count, label: info.label.zh }));
  }, [catalog]);

  const visibleServices = useMemo(() => {
    if (!catalog) return [];
    const query = search.trim().toLowerCase();
    return catalog.services.filter(service => {
      if (activeCategory !== 'all' && service.category !== activeCategory) return false;
      if (!query) return true;
      return `${service.id} ${service.name} ${service.description} ${service.authNote || ''}`
        .toLowerCase()
        .includes(query);
    });
  }, [catalog, search, activeCategory]);

  return (
    <div className="h-full overflow-y-auto bg-scholar-900 p-4" data-testid="webapis-panel">
      <div className="mx-auto flex max-w-6xl flex-col gap-3">
        {/* 页头：标题 + 说明 + 搜索 + 全部测试 */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
              <Database className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <h1 className="text-sm font-semibold text-scholar-50">网络数据资源</h1>
              <p className="mt-0.5 text-[10px] text-scholar-500">
                这些公开生信数据库的 API 已被 Agent 集成，提问即可调用；这里可浏览接口并手动测试连通性
              </p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <label className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-scholar-400" />
              <input
                value={search}
                onChange={event => setSearch(event.target.value)}
                className="w-52 rounded-md border border-scholar-700 bg-scholar-950 py-1.5 pl-7 pr-2 text-xs text-scholar-100 focus:outline-none focus:ring-1 focus:ring-accent/50"
                placeholder="搜索数据资源..."
              />
            </label>
            <button
              type="button"
              onClick={() => void runProbeAll()}
              disabled={probeAllRunning || loadingCatalog || !!catalogError}
              className="btn-primary !px-2.5 !py-1.5 text-xs"
            >
              {probeAllRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              {probeAllRunning ? '测试中...' : '全部测试'}
            </button>
          </div>
        </div>

        {/* 全量测试进度/结果：后端一次性返回（并发 6，约 20–60s），进行中只显示 spinner */}
        {(probeAllRunning || probeAllSummary || probeAllError) && (
          <div className="flex items-center gap-2 text-[11px]" data-testid="webapis-probe-all-status">
            {probeAllRunning && (
              <span className="flex items-center gap-1.5 text-scholar-400">
                <Loader2 className="h-3 w-3 animate-spin text-accent" />
                正在测试全部服务连通性（约 20–60 秒）…
              </span>
            )}
            {!probeAllRunning && probeAllSummary && (
              <span className="text-scholar-300">
                测试完成：<span className="text-emerald-500">{probeAllSummary.okCount}</span>/{probeAllSummary.total} 个可用
              </span>
            )}
            {!probeAllRunning && probeAllError && <span className="text-red-500">全量测试失败：{probeAllError}</span>}
          </div>
        )}

        {/* 类别筛选 chips：全部 + 10 类（带计数） */}
        {catalog && (
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="按类别筛选">
            <button
              type="button"
              aria-pressed={activeCategory === 'all'}
              onClick={() => setActiveCategory('all')}
              className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                activeCategory === 'all'
                  ? 'border-accent/40 bg-accent/15 text-scholar-50'
                  : 'border-scholar-700 text-scholar-400 hover:border-scholar-600 hover:text-scholar-200'
              }`}
            >
              全部（{catalog.total}）
            </button>
            {categoryChips.map(chip => (
              <button
                key={chip.id}
                type="button"
                aria-pressed={activeCategory === chip.id}
                onClick={() => setActiveCategory(chip.id)}
                className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                  activeCategory === chip.id
                    ? 'border-accent/40 bg-accent/15 text-scholar-50'
                    : 'border-scholar-700 text-scholar-400 hover:border-scholar-600 hover:text-scholar-200'
                }`}
              >
                {chip.label}（{chip.count}）
              </button>
            ))}
          </div>
        )}

        {/* 目录主体：加载 / 失败 / 卡片网格 */}
        {loadingCatalog && (
          <div className="flex items-center justify-center gap-2 py-16 text-xs text-scholar-400">
            <Loader2 className="h-4 w-4 animate-spin text-accent" /> 加载中…
          </div>
        )}
        {!loadingCatalog && catalogError && (
          <div className="flex flex-col items-center gap-2 py-16">
            <p className="text-xs text-red-500">目录加载失败：{catalogError}</p>
            <button type="button" onClick={() => void loadCatalog()} className="btn-ghost !px-2.5 !py-1.5 text-xs">
              <RefreshCw className="h-3.5 w-3.5" /> 重试
            </button>
          </div>
        )}
        {!loadingCatalog && !catalogError && catalog && visibleServices.length === 0 && (
          <p className="py-16 text-center text-xs text-scholar-500">没有匹配的数据资源</p>
        )}
        {!loadingCatalog && !catalogError && visibleServices.length > 0 && (
          <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
            {visibleServices.map(service => (
              <WebApiServiceCard
                key={service.id}
                service={service}
                status={statusOf(probes[service.id], probesStale)}
                probe={probes[service.id]}
                onAskAi={onAskAi}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 「试一下」结果视图：成功显示状态码/耗时/JSON 美化（截断 500 字符），失败显示错误码与信息 */
function TryResultView({ result }: { result: InvokeResult }) {
  if ('error' in result) {
    return (
      <p className="text-[10px] leading-4 text-red-500">
        {result.error.code}: {result.error.message}
        {result.durationMs !== undefined ? ` · ${result.durationMs}ms` : ''}
      </p>
    );
  }
  return (
    <>
      <p className="text-[10px] text-scholar-400">
        HTTP <span className="text-emerald-500">{result.status}</span> · {result.durationMs}ms
        {result.truncated ? ' · 后端已截断' : ''}
      </p>
      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-4 text-scholar-300">
        {formatTryBody(result)}
      </pre>
    </>
  );
}

function WebApiServiceCard({
  service,
  status,
  probe,
  onAskAi,
}: {
  service: CatalogService;
  status: StatusLevel;
  probe?: ProbeState;
  onAskAi?: (text: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<ServiceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [trying, setTrying] = useState<Record<string, boolean>>({});
  const [tryResults, setTryResults] = useState<Record<string, InvokeResult>>({});

  // 展开时才拉详情（端点参数说明与探针默认参数只在详情接口里）；失败可再次展开重试
  const toggleExpanded = useCallback(async () => {
    const next = !expanded;
    setExpanded(next);
    if (!next || detail || detailLoading) return;
    setDetailLoading(true);
    setDetailError('');
    try {
      const res = await fetch(`/api/webapis/${encodeURIComponent(service.id)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDetail((await res.json()) as ServiceDetail);
    } catch (cause) {
      setDetailError(cause instanceof Error ? cause.message : '详情加载失败');
    } finally {
      setDetailLoading(false);
    }
  }, [expanded, detail, detailLoading, service.id]);

  const tryEndpoint = useCallback(async (endpointId: string) => {
    setTrying(prev => ({ ...prev, [endpointId]: true }));
    try {
      // 探针端点用注册表的默认参数（保证能跑通）；其余端点没有默认参数，留空由后端校验并提示
      const params = detail?.probe?.endpoint === endpointId ? (detail.probe.params || {}) : {};
      const res = await fetch('/api/webapis/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: service.id, endpoint: endpointId, params }),
      });
      const data = (await res.json()) as InvokeResult;
      setTryResults(prev => ({ ...prev, [endpointId]: data }));
    } catch (cause) {
      setTryResults(prev => ({
        ...prev,
        [endpointId]: {
          ok: false,
          error: { code: 'network_error', message: cause instanceof Error ? cause.message : '请求失败' },
        },
      }));
    } finally {
      setTrying(prev => ({ ...prev, [endpointId]: false }));
    }
  }, [detail, service.id]);

  // 详情就绪前先用目录里的摘要端点（无参数说明），保证展开即有内容
  const endpoints: Array<CatalogEndpoint & { description?: string; params?: DetailParam[] }> =
    detail?.endpoints ?? service.endpoints;

  const statusLabel = status === 'ok' ? '可用' : status === 'fail' ? '不可用' : '未测试';
  const statusTitle =
    status === 'ok'
      ? `可用${probe?.durationMs !== undefined ? ` · ${probe.durationMs}ms` : ''}`
      : status === 'fail'
        ? `不可用${probe?.error ? ` · ${probe.error}` : ''}`
        : '未测试或结果已过期';

  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-scholar-700/70 bg-scholar-950/60 p-3"
      data-testid={`webapi-card-${service.id}`}
    >
      <div className="flex items-center gap-2">
        <span
          data-testid={`webapi-status-${service.id}`}
          data-state={status}
          title={statusTitle}
          aria-label={statusTitle}
          className={`h-2 w-2 shrink-0 rounded-full ${
            status === 'ok' ? 'bg-emerald-500' : status === 'fail' ? 'bg-red-500' : 'bg-amber-500'
          }`}
        />
        <h2 className="min-w-0 truncate text-xs font-medium text-scholar-100" title={service.name}>
          {service.name}
        </h2>
        <span className="shrink-0 rounded bg-scholar-800 px-1.5 py-0.5 text-[9px] leading-none text-scholar-400">
          {service.categoryLabel.zh}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <span className="text-[9px] text-scholar-500">{statusLabel}</span>
          {status === 'ok' && probe?.durationMs !== undefined && (
            <span className="text-[9px] text-scholar-500">{probe.durationMs}ms</span>
          )}
        </span>
      </div>

      <p className="text-[11px] leading-4 text-scholar-400">{service.description}</p>
      {service.authNote && <p className="text-[10px] leading-4 text-amber-500/90">{service.authNote}</p>}

      <div className="flex items-center gap-2 text-[10px]">
        <a
          href={service.homepage}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-0.5 text-accent hover:underline"
        >
          <ExternalLink className="h-3 w-3" /> 主页
        </a>
        <a
          href={service.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-0.5 text-accent hover:underline"
        >
          <ExternalLink className="h-3 w-3" /> 文档
        </a>
        {onAskAi && (
          <button
            type="button"
            title="把该服务交给 AI,让 AI 告诉你它能查什么、怎么查"
            onClick={() => onAskAi(`请使用数据资源板块已集成的 ${service.name} 服务(服务 id:${service.id})。先用 search_web_apis 找到它的端点,告诉我它能查什么、需要哪些参数;我随后补充要查的具体内容。`)}
            className="flex items-center gap-0.5 text-accent hover:underline"
          >
            <MessageSquare className="h-3 w-3" /> 问 AI
          </button>
        )}
        <button
          type="button"
          onClick={() => void toggleExpanded()}
          aria-expanded={expanded}
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-scholar-400 transition-colors hover:bg-scholar-800 hover:text-scholar-200"
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          端点（{service.endpointCount}）
        </button>
      </div>

      {expanded && (
        <div className="flex flex-col gap-1.5 border-t border-scholar-700/60 pt-2">
          {detailLoading && (
            <p className="flex items-center gap-1.5 py-1 text-[10px] text-scholar-500">
              <Loader2 className="h-3 w-3 animate-spin text-accent" /> 正在加载端点参数…
            </p>
          )}
          {detailError && <p className="py-1 text-[10px] text-red-500">端点详情加载失败：{detailError}</p>}
          <ul className="flex flex-col gap-1.5">
            {endpoints.map(endpoint => {
              const result = tryResults[endpoint.id];
              const running = !!trying[endpoint.id];
              return (
                <li key={endpoint.id} className="rounded-md border border-scholar-700/50 bg-scholar-900/60 p-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`shrink-0 font-mono text-[10px] font-semibold ${
                        endpoint.method === 'GET' ? 'text-emerald-500' : 'text-sky-500'
                      }`}
                    >
                      {endpoint.method}
                    </span>
                    <code className="min-w-0 flex-1 truncate font-mono text-[10px] text-scholar-300" title={endpoint.path}>
                      {endpoint.path}
                    </code>
                    <button
                      type="button"
                      onClick={() => void tryEndpoint(endpoint.id)}
                      disabled={running}
                      className="btn-ghost shrink-0 !px-1.5 !py-0.5 text-[10px]"
                    >
                      {running && <Loader2 className="h-3 w-3 animate-spin" />}
                      {running ? '调用中...' : '试一下'}
                    </button>
                  </div>
                  <p className="mt-1 text-[10px] leading-4 text-scholar-500">
                    {endpoint.name}
                    {endpoint.description ? ` · ${endpoint.description}` : ''}
                  </p>
                  {endpoint.params && endpoint.params.length > 0 && (
                    <p className="mt-0.5 text-[10px] leading-4 text-scholar-500">
                      参数：
                      {endpoint.params
                        .map(param => `${param.name}${param.required ? '（必填）' : ''}`)
                        .join('、')}
                    </p>
                  )}
                  {result && (
                    <div
                      className="mt-1.5 rounded border border-scholar-700/50 bg-scholar-950 p-1.5"
                      data-testid={`webapi-try-result-${service.id}-${endpoint.id}`}
                    >
                      <TryResultView result={result} />
                      {onAskAi && (
                        <button
                          type="button"
                          title="把这次调用的返回发给 AI 解读"
                          onClick={() => onAskAi(`这是数据资源板块里 ${service.name} 的 ${endpoint.name} 端点(${endpoint.method} ${endpoint.path})的返回结果,帮我解读并给出结论:\n\n${tryBodyForAi(result)}`)}
                          className="mt-1 flex items-center gap-1 text-[10px] text-accent hover:underline"
                        >
                          <MessageSquare className="h-3 w-3" /> 发给 AI 解读
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
