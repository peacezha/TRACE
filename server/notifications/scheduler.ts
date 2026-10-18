// 调度器配置与采集：LSF / Slurm / PBS / Donau 命令映射、输出解析、当前用户进程采集。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dataPath } from '../paths';
import { parseBjobsOutput, parseSqueueOutput } from '../ai/clusterContext';
import type { JobEntry } from '../ai/types';
import type { SchedulerKind } from '../cluster/schedulerProfile';

// 兼容旧名；现在覆盖 lsf / slurm / pbs / donau / none
export type SchedulerType = SchedulerKind;

const CONFIG_PATH = dataPath('scheduler-config.json');
const DEFAULT_SCHEDULER: SchedulerType = 'lsf';

export async function loadSchedulerType(): Promise<SchedulerType> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return normalizeScheduler(parsed?.scheduler);
  } catch {
    return DEFAULT_SCHEDULER;
  }
}

function normalizeScheduler(value: unknown): SchedulerType {
  return value === 'slurm' || value === 'pbs' || value === 'donau' || value === 'none' ? value : 'lsf';
}

export async function saveSchedulerType(scheduler: SchedulerType): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ scheduler }, null, 2), 'utf-8');
  await fs.rename(tmp, CONFIG_PATH);
}

// 远端自杀包装：本地 exec 超时放弃后，远端查询进程也会在给定秒数内退出，
// 避免大 LSF 集群上每 45s 一轮的慢 bjobs/sacct 在登录节点堆积。
// LSF/Slurm 登录节点是 Linux，coreutils timeout 必有，直接包即可。
const REMOTE_POLL_TIMEOUT_S = 50;
const REMOTE_FINAL_STATE_TIMEOUT_S = 25;

const JOBS_COMMANDS: Record<SchedulerType, string> = {
  lsf: `timeout ${REMOTE_POLL_TIMEOUT_S} bjobs -w 2>/dev/null`,
  // 管道分隔避免空白切分问题；%M = 已运行时间
  slurm: `timeout ${REMOTE_POLL_TIMEOUT_S} squeue -u "$(whoami)" -o "%i|%j|%T|%P|%M" --noheader 2>/dev/null`,
  // PBS/Torque 默认定宽表：JobID Name User TimeUse State Queue
  pbs: `timeout ${REMOTE_POLL_TIMEOUT_S} qstat -u "$(whoami)" 2>/dev/null`,
  // Donau（多瑙）：djob 无参数时列出当前用户全部作业
  donau: `timeout ${REMOTE_POLL_TIMEOUT_S} djob 2>/dev/null`,
  // 无调度器：只能按当前用户进程近似
  none: 'true',
};

export function jobsCommand(scheduler: SchedulerType): string {
  return JOBS_COMMANDS[scheduler];
}

/**
 * LSF 按 ID 定点查询：一条命令查全部已跟踪作业，替代大集群上动辄超时的全量 bjobs -w。
 * 已结束/被清理的作业不在输出中（等同消失，由调用方按补查流程确认终态）；
 * 个别 ID 未知时 bjobs 退出码非零，`; true` 保住其余 ID 的部分输出。
 */
export function lsfJobsByIdsCommand(jobIds: string[]): string {
  const safe = jobIds.map(id => String(id).trim()).filter(id => /^[\d._]+$/.test(id)).slice(0, 100);
  return safe.length
    ? `timeout ${REMOTE_POLL_TIMEOUT_S} bjobs -noheader -o "jobid stat" ${safe.join(' ')} 2>/dev/null; true`
    : 'true';
}

/** 解析 `bjobs -noheader -o "jobid stat"` 输出；name/queue 由调用方按上轮快照补齐。 */
export function parseLsfJobsByIdsOutput(raw: string): Array<{ jobId: string; status: JobEntry['status'] }> {
  const out: Array<{ jobId: string; status: JobEntry['status'] }> = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)(?:[._]\S+)?\s+(\w+)/);
    if (!m) continue;
    const stat = m[2].toUpperCase();
    out.push({
      jobId: m[1],
      status: stat === 'RUN' ? 'RUN' : stat === 'PEND' ? 'PEND' : stat === 'DONE' ? 'DONE' : stat === 'EXIT' ? 'EXIT' : 'UNKNOWN',
    });
  }
  return out;
}

// ── Donau（多瑙）────────────────────────────────────────────────────
// 状态机（按技能文档）：WAITING 等待调度 / PENDING 排队 / RUNNING 运行 /
// STOPPED 已停止 / SSTOPPED 系统停止 / FAILED 失败 / SUCCEEDED 成功。
// SSTOPPED 含子串 STOPPED，交替匹配必须把长词放前面（\b 已保证不互串，顺序是双保险）。
const DONAU_STATUS_RE = /\b(SSTOPPED|WAITING|PENDING|RUNNING|STOPPED|FAILED|SUCCEEDED)\b/i;

function normalizeDonauStatus(raw: string): JobEntry['status'] {
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

/**
 * Donau 按 ID 定点查询：djob 没有多 ID 参数，循环逐个 `djob <id>` 串成一条命令。
 * 每个 ID 前打 DJOB_ID: 标记，解析侧按标记分节（djob 输出列格式未固定，按节内首个
 * 状态关键词判定）；个别 ID 未知时 djob 报错进 /dev/null，该节为空，等同消失。
 */
export function donauJobsByIdsCommand(jobIds: string[]): string {
  const safe = jobIds.map(id => String(id).trim()).filter(id => /^\d+$/.test(id)).slice(0, 100);
  return safe.length
    ? `timeout ${REMOTE_POLL_TIMEOUT_S} sh -c 'for id in ${safe.join(' ')}; do echo "DJOB_ID:$id"; djob $id 2>/dev/null; done'; true`
    : 'true';
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
  if (s === 'C' || s === 'F') return 'DONE';
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

export function parseJobsOutput(scheduler: SchedulerType, raw: string): JobEntry[] {
  if (scheduler === 'slurm') return parseSqueueOutput(raw);
  if (scheduler === 'pbs') return parseQstatOutput(raw);
  if (scheduler === 'donau') return parseDjobOutput(raw);
  if (scheduler === 'none') return [];
  return parseBjobsOutput(raw);
}

/** sacct 补查 Slurm 作业最终状态（squeue 中作业一结束即消失，无法区分成功/失败） */
export function slurmFinalStateCommand(jobId: string): string {
  // jobId 只可能是数字（来自 squeue %i），无注入风险
  return `timeout ${REMOTE_FINAL_STATE_TIMEOUT_S} sacct -j ${jobId} --format=State --noheader -X 2>/dev/null | head -1`;
}

/** PBS 作业离开 qstat 后补查：-x 含历史，Exit_status=0 判 DONE。 */
export function pbsFinalStateCommand(jobId: string): string {
  const safe = /^[\d._]+$/.test(jobId) ? jobId : '';
  return safe
    ? `timeout ${REMOTE_FINAL_STATE_TIMEOUT_S} qstat -x -f ${safe} 2>/dev/null | grep -E 'job_state|Exit_status' | tr '\\n' ' '`
    : 'false';
}

export function finalStateCommand(scheduler: SchedulerType, jobId: string): string {
  if (scheduler === 'slurm') return slurmFinalStateCommand(jobId);
  if (scheduler === 'pbs') return pbsFinalStateCommand(jobId);
  if (scheduler === 'donau') return donauFinalStateCommand(jobId);
  if (scheduler === 'none') return 'false';
  return lsfFinalStateCommand(jobId);
}

/** 各调度器的脚本提交命令；none 退化登录节点后台执行并回显 PID。 */
export function submitCommand(scheduler: SchedulerType, scriptPath: string): string {
  const safe = `'${scriptPath.replace(/'/g, `'\\''`)}'`;
  switch (scheduler) {
    case 'slurm': return `sbatch ${safe}`;
    case 'pbs': return `qsub ${safe}`;
    // Donau：dsub -s 要求脚本有可执行权限
    case 'donau': return `chmod +x ${safe} && dsub -s ${safe}`;
    case 'none': return `nohup bash ${safe} > ${safe}.nohup.log 2>&1 & echo "NOHUP_PID:$!"`;
    default: return `bsub < ${safe}`;
  }
}

/** 流程模板的 #BSUB 指令翻译到目标调度器；none 直接剥掉。 */
export function translateSchedulerDirectives(script: string, target: SchedulerKind): string {
  if (target === 'lsf') return script;
  const lines = script.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*#BSUB\s+(.+)$/);
    if (!match) {
      out.push(line);
      continue;
    }
    if (target === 'none' || target === 'donau') continue; // 无调度器：去掉调度指令；Donau 的 #DSUB 翻译未接入（流程模板部署暂不支持 donau），剥掉避免误带 #BSUB
    const translated = translateBsubLine(match[1].trim(), target);
    if (translated) out.push(translated);
  }
  return out.join('\n');
}

function translateBsubLine(args: string, target: 'slurm' | 'pbs'): string | null {
  const tokens = args.split(/\s+/);
  const flag = tokens[0];
  const value = tokens.slice(1).join(' ');
  const one = (lsf: string, slurm: string, pbs: string) => (target === 'slurm' ? `#SBATCH ${slurm}` : `#PBS ${pbs}`);
  switch (flag) {
    case '-J': return one('-J', `--job-name=${value}`, `-N ${value.replace(/[^\w.-]/g, '_').slice(0, 60)}`);
    case '-n': return one('-n', `--ntasks=${value}`, `-l nodes=1:ppn=${value}`);
    case '-q': return one('-q', `--partition=${value}`, `-q ${value}`);
    case '-o': return one('-o', `--output=${value}`, `-o ${value}`);
    case '-e': return one('-e', `--error=${value}`, `-e ${value}`);
    case '-W': return one('-W', `--time=${value}`, `-l walltime=${/^\d+$/.test(value) ? `${value}:00` : value}`);
    case '-M': return one('-M', `--mem=${/\d/.test(value) && !/[A-Za-z]/.test(value) ? `${value}MB` : value}`, `-l mem=${value}`);
    case '-R': {
      const mem = /rusage\[mem=([\d.]+[A-Za-z]*)\]/.exec(value)?.[1];
      return mem ? one('-R', `--mem=${mem}`, `-l mem=${mem}`) : null;
    }
    default: return null; // 无法对应的指令丢弃（总比提交一个调度器不认识的脚本强）
  }
}

/** LSF 作业从默认 bjobs 列表消失后，用历史列表确认 DONE/EXIT。 */
export function lsfFinalStateCommand(jobId: string): string {
  // jobId 来自调度器解析或提交回执，只允许数字及数组任务分隔符。
  const safe = /^[\d._]+$/.test(jobId) ? jobId : '';
  return safe ? `timeout ${REMOTE_FINAL_STATE_TIMEOUT_S} bjobs -a -noheader -o stat ${safe} 2>/dev/null | head -1` : 'false';
}

/** Donau 作业终态补查：`djob -l` 含调度/失败详情；作业查不到时输出为空，由解析侧按未知处理。 */
export function donauFinalStateCommand(jobId: string): string {
  // Donau 作业号为纯数字（来自 djob 解析或提交回执），其余一律拒查。
  const safe = /^\d+$/.test(jobId) ? jobId : '';
  return safe ? `timeout ${REMOTE_FINAL_STATE_TIMEOUT_S} djob -l ${safe} 2>/dev/null` : 'false';
}

/** LSF 作业输出尾部摘要：bpeek 对已结束作业仍可读；无输出时为空。 */
export function lsfOutputTailCommand(jobId: string): string {
  const safe = /^[\d._]+$/.test(jobId) ? jobId : '';
  return safe ? `bpeek ${safe} 2>/dev/null | tail -n 30` : 'false';
}

/** Slurm 默认输出文件（slurm-<jobId>.out）尾部摘要；自定义输出路径时查不到则留空。 */
export function slurmOutputTailCommand(jobId: string): string {
  const safe = /^[\d._]+$/.test(jobId) ? jobId : '';
  return safe ? `tail -q -n 30 "slurm-${safe}.out" "$HOME/slurm-${safe}.out" 2>/dev/null` : 'false';
}

/** Donau 作业输出尾部摘要：dpeek 等价于 bpeek，读运行中作业输出；失败或无输出时为空。 */
export function donauOutputTailCommand(jobId: string): string {
  const safe = /^\d+$/.test(jobId) ? jobId : '';
  return safe ? `dpeek ${safe} 2>/dev/null | tail -n 30` : 'false';
}

export interface ProcessEntry {
  pid: string;
  stat: string;
  etime: string;
  cpu: string;
  mem: string;
  command: string;
}

export const PROCESSES_COMMAND =
  'ps -u "$(whoami)" -o pid,stat,etime,pcpu,pmem,args --sort=-pcpu 2>/dev/null | head -26';

export function parseProcessesOutput(raw: string): ProcessEntry[] {
  const lines = raw.split('\n');
  if (lines.length < 2) return [];
  return lines
    .slice(1)
    .filter(l => l.trim())
    .map(line => {
      const parts = line.trim().split(/\s+/);
      const command = parts.slice(5).join(' ');
      return {
        pid: parts[0] ?? '',
        stat: parts[1] ?? '',
        etime: parts[2] ?? '',
        cpu: parts[3] ?? '',
        mem: parts[4] ?? '',
        command: command.length > 120 ? `${command.slice(0, 120)}…` : command,
      };
    })
    .filter(p => p.pid);
}
