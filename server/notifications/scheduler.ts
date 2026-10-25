// 调度器配置与采集：LSF / Slurm / PBS / Donau 命令映射、输出解析、当前用户进程采集。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dataPath } from '../paths';
import { parseBjobsOutput, parseSqueueOutput, parseQstatOutput, parseDjobOutput, parseDjobFinalState } from '../ai/clusterContext';
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
  return value === 'slurm' || value === 'pbs' || value === 'donau' || value === 'none' || value === 'unknown' ? value : 'lsf';
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
  // 探测未知时禁止退回 LSF 或把空列表当作真实作业状态。
  unknown: 'false',
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

// 解析器已上移到 ../ai/clusterContext(快照与监控共用,打破 import 环);此处再导出保持兼容。
export { parseDjobOutput, parseDonauJobsByIdsOutput, parseDjobFinalState, parseQstatOutput } from '../ai/clusterContext';
export { normalizeDonauStatus } from '../ai/clusterContext';

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


export function parseJobsOutput(scheduler: SchedulerType, raw: string): JobEntry[] {
  if (scheduler === 'slurm') return parseSqueueOutput(raw);
  if (scheduler === 'pbs') return parseQstatOutput(raw);
  if (scheduler === 'donau') return parseDjobOutput(raw);
  if (scheduler === 'none' || scheduler === 'unknown') return [];
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
  if (scheduler === 'none' || scheduler === 'unknown') return 'false';
  return lsfFinalStateCommand(jobId);
}

export type SchedulerJobState = 'RUN' | 'PEND' | 'DONE' | 'EXIT' | 'UNKNOWN';

/** PBS C/F 只是结束外观；只有同一份 accounting 输出里的 Exit_status 能判定成败。 */
export function parsePbsAccountingState(raw: string): SchedulerJobState {
  const state = raw.match(/\bjob_state\s*=\s*([A-Z])\b/i)?.[1]?.toUpperCase();
  if (state === 'R' || state === 'E') return 'RUN';
  if (state === 'Q' || state === 'H' || state === 'W' || state === 'T' || state === 'S') return 'PEND';
  if (state !== 'C' && state !== 'F') return 'UNKNOWN';
  const exit = raw.match(/\bExit_status\s*=\s*(-?\d+)\b/i);
  if (!exit) return 'UNKNOWN';
  return Number(exit[1]) === 0 ? 'DONE' : 'EXIT';
}

export function parseSchedulerJobState(scheduler: SchedulerType, raw: string): SchedulerJobState {
  if (scheduler === 'pbs') return parsePbsAccountingState(raw);
  if (scheduler === 'donau') {
    const final = parseDjobFinalState(raw);
    if (final) return final;
    if (/\bRUNNING\b/i.test(raw)) return 'RUN';
    if (/\b(?:WAITING|PENDING)\b/i.test(raw)) return 'PEND';
    return 'UNKNOWN';
  }
  const state = raw.trim().split(/\s+/)[0]?.toUpperCase() || '';
  if (scheduler === 'slurm') {
    if (state === 'RUNNING') return 'RUN';
    if (/^(PENDING|CONFIGURING|SUSPENDED|COMPLETING)/.test(state)) return 'PEND';
    if (state === 'COMPLETED') return 'DONE';
    if (/^(FAILED|CANCELLED|TIMEOUT|OUT_OF_MEMORY|NODE_FAIL|PREEMPTED|BOOT_FAIL|DEADLINE|REVOKED)(?:[+]|$)/.test(state)) return 'EXIT';
    return 'UNKNOWN';
  }
  if (scheduler === 'lsf') {
    if (state === 'RUN') return 'RUN';
    if (state === 'PEND') return 'PEND';
    if (state === 'DONE' || state === 'EXIT') return state;
  }
  return 'UNKNOWN';
}

/** 重跑/取消前按当前调度器逐 ID 核实；任何异常或缺失记录都保持 UNKNOWN。 */
export async function querySchedulerJobStates(
  exec: (command: string, timeoutMs?: number) => Promise<string>,
  scheduler: SchedulerType | undefined,
  jobIds: string[],
): Promise<Record<string, SchedulerJobState>> {
  const ids = [...new Set(jobIds)];
  const entries = await Promise.all(ids.map(async jobId => {
    if (!scheduler || scheduler === 'none' || scheduler === 'unknown') return [jobId, 'UNKNOWN'] as const;
    try {
      const raw = await exec(finalStateCommand(scheduler, jobId), 30_000);
      return [jobId, parseSchedulerJobState(scheduler, raw)] as const;
    } catch {
      return [jobId, 'UNKNOWN'] as const;
    }
  }));
  return Object.fromEntries(entries);
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
    case 'unknown': throw new Error('调度器未知，禁止提交作业');
    default: return `bsub < ${safe}`;
  }
}

/** 流程模板的 #BSUB 指令翻译到目标调度器；不能无损翻译时必须拒绝创建/提交。 */
export function translateSchedulerDirectives(script: string, target: SchedulerKind): string {
  if (target === 'lsf') return script;
  if (target === 'unknown') throw new Error('调度器未知，不能安全翻译流程脚本');
  const out: string[] = [];
  for (const line of script.split('\n')) {
    const match = line.match(/^\s*#BSUB\s+(.+)$/);
    if (!match) {
      out.push(line);
      continue;
    }
    if (target === 'none') continue;
    out.push(translateBsubLine(match[1].trim(), target));
  }
  return out.join('\n');
}

function lsfWalltime(value: string): string {
  const match = value.match(/^(?:(\d+):)?(\d+)$/);
  if (!match) throw new Error(`无法翻译 LSF walltime: ${value}`);
  const hours = Number(match[1] ?? 0) + Math.floor(Number(match[2]) / 60);
  const minutes = Number(match[2]) % 60;
  if (match[1] !== undefined && Number(match[2]) >= 60) throw new Error(`无法翻译 LSF walltime: ${value}`);
  const hhmm = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  // Slurm 的 MM:SS 不是 HH:MM；统一输出 HH:MM:SS，避免两小时缩成两分钟。
  return `${hhmm}:00`;
}

function memoryWithUnit(value: string, numericUnit: 'KB' | 'MB'): string {
  if (!/^\d+(?:\.\d+)?(?:[A-Za-z]+)?$/.test(value)) throw new Error(`无法翻译内存限制: ${value}`);
  if (/[A-Za-z]/.test(value)) return value;
  // LSF -M 默认是 KB，rusage[mem] 默认是 MB；目标 Slurm/PBS 统一显式 MB。
  const megabytes = numericUnit === 'KB' ? Number(value) / 1024 : Number(value);
  if (!Number.isFinite(megabytes) || megabytes <= 0) throw new Error(`无法翻译内存限制: ${value}`);
  return `${megabytes}MB`;
}

function translateBsubLine(args: string, target: 'slurm' | 'pbs' | 'donau'): string {
  const tokens = args.split(/\s+/);
  const flag = tokens[0];
  const value = tokens.slice(1).join(' ');
  if (!value) throw new Error(`#BSUB ${flag} 缺少参数，不能安全翻译`);
  const one = (slurm: string, pbs: string) => (target === 'slurm' ? `#SBATCH ${slurm}` : `#PBS ${pbs}`);
  switch (flag) {
    case '-J':
      return target === 'donau' ? `#DSUB -n ${value}` : one(`--job-name=${value}`, `-N ${value.replace(/[^\w.-]/g, '_').slice(0, 60)}`);
    case '-n':
      if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`无效的 LSF 核数: ${value}`);
      return target === 'donau' ? `#DSUB -R cpu=${value}` : one(`--ntasks=${value}`, `-l nodes=1:ppn=${value}`);
    case '-q':
      return target === 'donau' ? `#DSUB -q ${value}\n#DSUB -aa` : one(`--partition=${value}`, `-q ${value}`);
    case '-o':
      return target === 'donau' ? `#DSUB -o ${value}` : one(`--output=${value}`, `-o ${value}`);
    case '-e':
      if (target === 'donau') break;
      return one(`--error=${value}`, `-e ${value}`);
    case '-W':
      if (target === 'donau') break;
      return one(`--time=${lsfWalltime(value)}`, `-l walltime=${lsfWalltime(value)}`);
    case '-M':
      if (target === 'donau') break;
      return one(`--mem=${memoryWithUnit(value, 'KB')}`, `-l mem=${memoryWithUnit(value, 'KB')}`);
    case '-R': {
      if (target === 'donau') break;
      const mem = /rusage\[mem=([\d.]+[A-Za-z]*)\]/.exec(value)?.[1];
      if (mem) return one(`--mem=${memoryWithUnit(mem, 'MB')}`, `-l mem=${memoryWithUnit(mem, 'MB')}`);
      break;
    }
  }
  throw new Error(`#BSUB ${flag} 无法安全翻译到 ${target}，已拒绝静默丢弃资源或节点约束`);
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
