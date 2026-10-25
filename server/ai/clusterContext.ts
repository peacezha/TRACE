import type { ClusterSnapshot, FileEntry, JobEntry, QuotaInfo, SnapshotDepth } from './types';
import { fileRecognizer } from './fileRecognizer';

export function parseLsOutput(raw: string): FileEntry[] {
  const lines = raw.split('\n').filter(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('total ')) return false;
    return /^[-dl]/.test(trimmed);
  });

  const entries: FileEntry[] = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    // 兼容两种 ls 输出格式：
    //   标准 ls -l：  perms links owner group size month day time/year name → 9 列
    //   long-iso：    perms links owner group size yyyy-mm-dd hh:mm name    → 8 列
    const isLongIso = /^\d{4}-\d{2}-\d{2}$/.test(parts[5] ?? '');
    const minParts = isLongIso ? 8 : 9;
    if (parts.length < minParts) continue;

    const perms = parts[0];
    const sizeStr = parts[4];
    const dateStr = isLongIso
      ? `${parts[5]} ${parts[6]}`
      : `${parts[5]} ${parts[6]} ${parts[7]}`;
    const name = parts.slice(isLongIso ? 7 : 8).join(' ');

    const size = parseSize(sizeStr);
    const modified = Date.parse(dateStr) || Date.now();

    if (perms.startsWith('d')) {
      entries.push({ name, size: 0, modified, type: 'directory', recognizedSkillHints: [] });
    } else {
      const entry = fileRecognizer.analyze(name, size, modified);
      entries.push(entry);
    }
  }

  return entries;
}

function parseSize(raw: string): number {
  const num = parseFloat(raw);
  if (!raw) return 0;
  const upper = raw.slice(-1).toUpperCase();
  if (upper === 'T') return num * 1024 * 1024 * 1024 * 1024;
  if (upper === 'G') return num * 1024 * 1024 * 1024;
  if (upper === 'M') return num * 1024 * 1024;
  if (upper === 'K') return num * 1024;
  return num || 0;
}

export function parseBjobsOutput(raw: string): JobEntry[] {
  const lines = raw.split('\n');
  if (lines.length < 2) return [];
  const header = lines[0];
  const dataLines = lines.slice(1).filter(l => l.trim());

  // bjobs 输出是定宽对齐的表格（列宽 = 该列最宽单元格），因此用表头记录
  // 各列起始位置做切片解析。直接按空白切分会在以下场景整体错位：
  //   - 并行作业的 EXEC_HOST 含空格（如 "8*hostA 2*hostB"）
  //   - JOB_NAME 含空格
  //   - 某列为空（\s+ 切分后后续字段全部左移）
  const pos = {
    jobId: header.indexOf('JOBID'),
    user: header.indexOf('USER'),
    stat: header.indexOf('STAT'),
    queue: header.indexOf('QUEUE'),
    fromHost: header.indexOf('FROM_HOST'),
    jobName: header.indexOf('JOB_NAME'),
    submitTime: header.indexOf('SUBMIT_TIME'),
  };
  const headerOk =
    pos.jobId >= 0 && pos.user > pos.jobId && pos.stat > pos.user &&
    pos.queue > pos.stat && pos.jobName > pos.queue && pos.submitTime > pos.jobName;

  return dataLines.map(line => {
    // 逐行校验是否真与表头定宽对齐（长度需达到 SUBMIT_TIME 列，且首列切片等于首 token），
    // 否则按空白切分回退——兼容非补齐格式的 bjobs 输出
    const firstToken = line.trim().split(/\s+/)[0] ?? '';
    const aligned = headerOk && line.length > pos.submitTime && line.slice(pos.jobId, pos.user).trim() === firstToken;
    if (aligned) {
      const slice = (from: number, to?: number) => line.slice(from, to).trim();
      const jobId = slice(pos.jobId, pos.user);
      const name = slice(pos.jobName, pos.submitTime);
      return {
        jobId,
        name: name || jobId,
        status: normalizeJobStatus(slice(pos.stat, pos.queue) || 'UNKNOWN'),
        cores: 0, // not in default bjobs -w output
        queue: slice(pos.queue, pos.fromHost > pos.queue ? pos.fromHost : pos.jobName),
        runtime: '',
      };
    }
    // 表头不符合预期或该行未按列补齐时回退到空白切分
    const parts = line.trim().split(/\s+/);
    return {
      jobId: parts[0] ?? '',
      name: parts[6] ?? parts[0] ?? '',
      status: normalizeJobStatus(parts[2] ?? 'UNKNOWN'),
      cores: 0,
      queue: parts[3] ?? '',
      runtime: '',
    };
  });
}

function normalizeJobStatus(raw: string): JobEntry['status'] {
  const upper = raw.toUpperCase();
  if (upper === 'RUN') return 'RUN';
  if (upper === 'PEND') return 'PEND';
  if (upper === 'DONE') return 'DONE';
  if (upper === 'EXIT') return 'EXIT';
  return 'UNKNOWN';
}

/** 解析 `squeue -o "%i|%j|%T|%P|%M" --noheader` 的管道分隔输出 */
export function parseSqueueOutput(raw: string): JobEntry[] {
  return raw
    .split('\n')
    .filter(l => l.trim())
    .map(line => {
      const parts = line.trim().split('|');
      return {
        jobId: parts[0] ?? '',
        name: parts[1] ?? parts[0] ?? '',
        status: normalizeSlurmStatus(parts[2] ?? 'UNKNOWN'),
        cores: 0,
        queue: parts[3] ?? '',
        runtime: parts[4] ?? '',
      };
    })
    .filter(j => j.jobId);
}

function normalizeSlurmStatus(raw: string): JobEntry['status'] {
  const upper = raw.toUpperCase();
  if (upper === 'RUNNING') return 'RUN';
  if (upper === 'PENDING' || upper === 'CONFIGURING' || upper === 'SUSPENDED') return 'PEND';
  if (upper === 'COMPLETED') return 'DONE';
  if (
    upper === 'FAILED' || upper === 'CANCELLED' || upper === 'TIMEOUT' ||
    upper === 'NODE_FAIL' || upper === 'PREEMPTED' || upper === 'BOOT_FAIL' ||
    upper === 'DEADLINE' || upper === 'OUT_OF_MEMORY'
  ) return 'EXIT';
  return 'UNKNOWN';
}

export function parseQuotaOutput(raw: string): QuotaInfo | null {
  const match = raw.match(/(\S+)\s+([\d.]+[TGMK]?)\s+([\d.]+[TGMK]?)\s+(\d+)%/);
  if (!match) return null;
  return {
    filesystem: match[1],
    used: match[2],
    total: match[3],
    percent: match[4] + '%',
  };
}

// 快照按调度器选命令:LSF bjobs/bqueues、Slurm squeue/sinfo、PBS qstat、Donau djob/dqueue、无调度器跳过。
type SnapshotScheduler = 'lsf' | 'slurm' | 'pbs' | 'donau' | 'none' | 'unknown';
const SNAPSHOT_JOB_QUEUE_COMMANDS: Record<SnapshotScheduler, { jobs: string; queues: string }> = {
  lsf: { jobs: 'bjobs -w 2>/dev/null | head -30', queues: 'bqueues 2>/dev/null | head -20' },
  slurm: { jobs: 'squeue -u "$(whoami)" 2>/dev/null | head -30', queues: 'sinfo -s 2>/dev/null | head -20' },
  pbs: { jobs: 'qstat -u "$(whoami)" 2>/dev/null | head -30', queues: 'qstat -q 2>/dev/null | head -20' },
  donau: { jobs: 'djob 2>/dev/null | head -30', queues: 'dqueue 2>/dev/null | head -20' },
  none: { jobs: 'true', queues: 'true' },
  unknown: { jobs: 'true', queues: 'true' },
};

function snapshotScheduler(scheduler?: string): SnapshotScheduler {
  return scheduler === 'slurm' || scheduler === 'pbs' || scheduler === 'donau' || scheduler === 'none' || scheduler === 'unknown' ? scheduler : 'lsf';
}

function buildSnapshotCommand(depth: SnapshotDepth, scheduler?: string): string {
  const jq = SNAPSHOT_JOB_QUEUE_COMMANDS[snapshotScheduler(scheduler)];
  if (depth === 'full') {
    return `echo "===PWD==="; pwd; echo "===FILES==="; ls -lhR --time-style=long-iso 2>/dev/null | head -500; echo "===JOBS==="; ${jq.jobs}; echo "===QUEUES==="; ${jq.queues}; echo "===MODULES==="; module list 2>/dev/null; echo "===QUOTA==="; quota -s 2>/dev/null | head -10; true`;
  }
  // 默认快照不读取文件列表。需要文件时由用户明确选择目录,Agent 再定点读取。
  return `echo "===PWD==="; pwd; echo "===JOBS==="; ${jq.jobs}; echo "===QUOTA==="; quota -s 2>/dev/null | head -5; true`;
}

function parseSnapshotOutput(raw: string, scheduler?: string): ClusterSnapshot {
  const sections: Record<string, string> = {};
  let currentSection = '__preamble__';

  for (const line of raw.split('\n')) {
    const sectionMatch = line.match(/^===(\w+)===$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].toLowerCase();
      sections[currentSection] = '';
    } else {
      sections[currentSection] = (sections[currentSection] ?? '') + line + '\n';
    }
  }

  const files = parseLsOutput(sections['files'] ?? '');
  const sched = snapshotScheduler(scheduler);
  const jobs = sched === 'slurm' ? parseSqueueOutput(sections['jobs'] ?? '')
    : sched === 'pbs' ? parseQstatOutput(sections['jobs'] ?? '')
    : sched === 'donau' ? parseDjobOutput(sections['jobs'] ?? '')
    : sched === 'none' || sched === 'unknown' ? []
    : parseBjobsOutput(sections['jobs'] ?? '');
  const quota = parseQuotaOutput(sections['quota'] ?? '');
  const modulesStr = sections['modules'] ?? '';
  const modules = modulesStr
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('Currently') && !l.startsWith('No modules'));

  return {
    workingDir: (sections['pwd'] ?? '').trim(),
    files,
    jobs,
    quota,
    modules,
    queueStatus: [],
    timestamp: Date.now(),
  };
}

export class ClusterContextProvider {
  private cache: Map<string, { snapshot: ClusterSnapshot; timestamp: number }> = new Map();
  private cacheTTL = 120000;

  buildSnapshotCommand(depth: SnapshotDepth, scheduler?: string): string {
    return buildSnapshotCommand(depth, scheduler);
  }

  parse(rawOutput: string, scheduler?: string): ClusterSnapshot {
    return parseSnapshotOutput(rawOutput, scheduler);
  }

  getCached(key: string): ClusterSnapshot | null {
    const entry = this.cache.get(key);
    if (entry && Date.now() - entry.timestamp < this.cacheTTL) {
      return entry.snapshot;
    }
    return null;
  }

  setCache(key: string, snapshot: ClusterSnapshot): void {
    this.cache.set(key, { snapshot, timestamp: Date.now() });
  }

  summarizeForAI(snapshot: ClusterSnapshot, fileHints?: { phase: string; skills: string[] }): string {
    const lines: string[] = [];
    lines.push('## 集群实时状态');
    lines.push(`### 当前位置\n${snapshot.workingDir || '(未知)'}`);

    if (snapshot.files.length > 0) {
      lines.push(`### 目录内容 (${snapshot.files.length} 个条目)`);
      for (const f of snapshot.files.slice(0, 30)) {
        const skillTag = f.recognizedSkillHints.length > 0
          ? ` → 关联技能: ${f.recognizedSkillHints.join(', ')}`
          : '';
        lines.push(`  ${f.name} (${formatSize(f.size)})${skillTag}`);
      }
      if (snapshot.files.length > 30) {
        lines.push(`  ... 还有 ${snapshot.files.length - 30} 个文件`);
      }
    }

    if (fileHints) {
      lines.push(`### 分析阶段推断\n${fileHints.phase}\n关联技能: ${fileHints.skills.join(', ')}`);
    }

    if (snapshot.jobs.length > 0) {
      lines.push('### 集群作业');
      for (const j of snapshot.jobs) {
        lines.push(`  Job ${j.jobId} | ${j.name} | ${j.status} | ${j.queue}`);
      }
    }

    if (snapshot.quota) {
      lines.push(`### 磁盘配额\n${snapshot.quota.filesystem}: ${snapshot.quota.used}/${snapshot.quota.total} (${snapshot.quota.percent})`);
    }

    if (snapshot.modules.length > 0) {
      lines.push(`### 已加载模块\n${snapshot.modules.slice(0, 10).join(', ')}`);
    }

    return lines.join('\n');
  }
}

function formatSize(bytes: number): string {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + 'G';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + 'M';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + 'K';
  return bytes + 'B';
}

export const clusterContext = new ClusterContextProvider();

// ── Donau(多瑙)/ PBS 作业解析:从 notifications/scheduler.ts 上移,
// 保持本模块为最底层解析器,供快照与监控共用,scheduler.ts 里为再导出。 ──

// ── Donau（多瑙）────────────────────────────────────────────────────
// 状态机（按技能文档）：WAITING 等待调度 / PENDING 排队 / RUNNING 运行 /
// STOPPED 已停止 / SSTOPPED 系统停止 / FAILED 失败 / SUCCEEDED 成功。
// SSTOPPED 含子串 STOPPED，交替匹配必须把长词放前面（\b 已保证不互串，顺序是双保险）。
const DONAU_STATUS_RE = /\b(SSTOPPED|WAITING|PENDING|RUNNING|STOPPED|FAILED|SUCCEEDED)\b/i;

export function normalizeDonauStatus(raw: string): JobEntry['status'] {
  switch (raw.trim().toUpperCase()) {
    case 'RUNNING': return 'RUN';
    case 'WAITING':
    case 'PENDING': return 'PEND';
    case 'SUCCEEDED': return 'DONE';
    case 'FAILED':
    case 'STOPPED':
    case 'SSTOPPED': return 'EXIT';
    default: return 'UNKNOWN';
  }
}

/**
 * 容错解析 `djob` 列表输出。没有真实 djob 输出样例可参照（文档只给出状态名与
 * --output 可用列名），因此不写死列位置：
 * 1. 优先按文档 alias 的列序 `jobId name user state queue …` 整行匹配；
 * 2. 否则退化为"行内含状态关键词 + 首个纯数字 token 作为作业号"。
 */
export function parseDjobOutput(raw: string): JobEntry[] {
  const out: JobEntry[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = line.match(/^\s*(\d+)\s+(\S+)\s+\S+\s+(SSTOPPED|WAITING|PENDING|RUNNING|STOPPED|FAILED|SUCCEEDED)\s+(\S+)/i);
    if (row) {
      if (seen.has(row[1])) continue;
      seen.add(row[1]);
      out.push({ jobId: row[1], name: row[2], status: normalizeDonauStatus(row[3]), cores: 0, queue: row[4], runtime: '' });
      continue;
    }
    const statusMatch = line.match(DONAU_STATUS_RE);
    if (!statusMatch) continue;
    const tokens = line.trim().split(/\s+/);
    const idIdx = tokens.findIndex(t => /^\d+$/.test(t));
    if (idIdx < 0) continue;
    const jobId = tokens[idIdx];
    if (seen.has(jobId)) continue;
    seen.add(jobId);
    const statusToken = statusMatch[1].toUpperCase();
    const name = tokens.slice(idIdx + 1).find(t => t.toUpperCase() !== statusToken && !/^\d+$/.test(t) && !/[:=]/.test(t));
    out.push({ jobId, name: name || `Job ${jobId}`, status: normalizeDonauStatus(statusToken), cores: 0, queue: '', runtime: '' });
  }
  return out;
}


/** 解析 donauJobsByIdsCommand 的输出：按 DJOB_ID: 标记分节，节内第一个状态关键词即该作业状态。 */
export function parseDonauJobsByIdsOutput(raw: string): Array<{ jobId: string; status: JobEntry['status'] }> {
  const out: Array<{ jobId: string; status: JobEntry['status'] }> = [];
  let currentId = '';
  let currentStatus: JobEntry['status'] | null = null;
  const flush = () => {
    if (currentId && currentStatus) out.push({ jobId: currentId, status: currentStatus });
    currentStatus = null;
  };
  for (const line of raw.split(/\r?\n/)) {
    const marker = line.match(/^\s*DJOB_ID:(\d+)\s*$/);
    if (marker) {
      flush();
      currentId = marker[1];
      continue;
    }
    if (!currentId || currentStatus) continue;
    const statusMatch = line.match(DONAU_STATUS_RE);
    if (statusMatch) currentStatus = normalizeDonauStatus(statusMatch[1]);
  }
  flush();
  return out;
}

/**
 * `djob -l <id>` 输出的终态判定：SUCCEEDED → DONE，FAILED/STOPPED/SSTOPPED → EXIT；
 * 活跃态（WAITING/PENDING/RUNNING）或查无关键词 → undefined（由调用方按下轮再查处理）。
 */
export function parseDjobFinalState(raw: string): 'DONE' | 'EXIT' | undefined {
  const m = raw.match(/\b(SUCCEEDED|FAILED|SSTOPPED|STOPPED)\b/i);
  if (!m) return undefined;
  return m[1].toUpperCase() === 'SUCCEEDED' ? 'DONE' : 'EXIT';
}

/** PBS qstat 状态字母 → TRACE 作业状态 */
function normalizePbsStatus(letter: string): JobEntry['status'] {
  const s = letter.trim().toUpperCase();
  if (s === 'R' || s === 'E') return 'RUN';
  if (s === 'Q' || s === 'H' || s === 'W' || s === 'T' || s === 'S') return 'PEND';
  // C/F 没有 Exit_status，必须保持 UNKNOWN 并由 qstat -x -f 补查。
  if (s === 'C' || s === 'F') return 'UNKNOWN';
  return 'UNKNOWN';
}

export function parseQstatOutput(raw: string): JobEntry[] {
  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('-') && !/^job\s*id/i.test(l) && !/^job_id/i.test(l))
    .map(line => {
      const parts = line.split(/\s+/);
      return {
        jobId: (parts[0] ?? '').split('.')[0],
        name: parts[1] ?? parts[0] ?? '',
        status: normalizePbsStatus(parts[4] ?? ''),
        cores: 0,
        queue: parts[5] ?? '',
        runtime: parts[3] ?? '',
      };
    })
    .filter(j => j.jobId);
}

