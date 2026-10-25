// 调度器画像：登录后探测一次集群的作业调度系统（LSF/Slurm/PBS/Donau/无），
// 按账号（username@host:port）持久化打标签，之后不再重复探测。
// 不同调度器的命令/流程逻辑差异由 notifications/scheduler.ts 的命令映射承接。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dataPath } from '../paths';

export type SchedulerKind = 'lsf' | 'slurm' | 'pbs' | 'donau' | 'none' | 'unknown';

export const SCHEDULER_LABELS: Record<SchedulerKind, string> = {
  lsf: 'LSF',
  slurm: 'Slurm',
  pbs: 'PBS',
  donau: 'Donau',
  none: '无调度器',
  unknown: '调度器未知',
};

export interface SchedulerTag {
  kind: SchedulerKind;
  detectedAt: number;
  /** 是否有 Environment Modules/Lmod；无则软件一律直装（conda/mamba/pip/二进制） */
  hasModule?: boolean;
  /** 探测到的直装包管理器（mamba/conda/uv/pip3），供 AI 选最快的安装路径 */
  installers?: string[];
  /** 生成该标签的探测逻辑版本；与当前版本不一致时下次登录自动重探(见 resolveAccountScheduler)。 */
  probeVersion?: number;
}

/** 探测逻辑版本:探测命令/判定规则变化时 +1,旧版本缓存标签自动失效重探。
 *  v2:新增 Donau(dsub/djob)探测。
 *  v3:unknown 不再缓存为 none，旧版误标全部失效重探。 */
export const SCHEDULER_PROBE_VERSION = 3;

const TAGS_PATH = () => dataPath('scheduler-tags.json');

/** 账号级标签键：同一账号换机登录另一台集群互不串扰。 */
export function schedulerTagKey(info: { username: string; host: string; port?: string | number }): string {
  return `${info.username}@${info.host}:${info.port ?? ''}`.toLowerCase();
}

export function normalizeSchedulerKind(value: unknown): SchedulerKind | null {
  return value === 'lsf' || value === 'slurm' || value === 'pbs' || value === 'donau' || value === 'none' || value === 'unknown' ? value : null;
}

export async function loadSchedulerTag(key: string): Promise<SchedulerTag | null> {
  try {
    const raw = await fs.readFile(TAGS_PATH(), 'utf-8');
    const all = JSON.parse(raw);
    const tag = all?.[key];
    const kind = normalizeSchedulerKind(tag?.kind);
    return kind ? { kind, detectedAt: Number(tag.detectedAt) || 0, hasModule: tag.hasModule, installers: tag.installers, probeVersion: Number(tag.probeVersion) || undefined } : null;
  } catch {
    return null;
  }
}

export async function saveSchedulerTag(key: string, tag: Omit<SchedulerTag, 'detectedAt'>): Promise<SchedulerTag> {
  let all: Record<string, SchedulerTag> = {};
  try {
    all = JSON.parse(await fs.readFile(TAGS_PATH(), 'utf-8'));
  } catch { /* 首次或损坏：重建 */ }
  const saved: SchedulerTag = { ...tag, detectedAt: Date.now(), probeVersion: SCHEDULER_PROBE_VERSION };
  all[key] = saved;
  const file = TAGS_PATH();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(all, null, 2), 'utf-8');
  await fs.rename(tmp, file);
  return saved;
}

// 探测命令：一次 SSH 调用完成。调度器优先级 LSF > Slurm > PBS > Donau（同一登录节点多套
// 命令共存极少见；真共存时以 LSF 为准——它通常是主调度）。同时探测 module 系统
//（含 profile.d 初始化兜底）与直装包管理器。
export const SCHEDULER_PROBE_COMMAND = [
  'if command -v bjobs >/dev/null 2>&1 && command -v bsub >/dev/null 2>&1; then echo SCHED:LSF',
  'elif command -v squeue >/dev/null 2>&1 && command -v sbatch >/dev/null 2>&1; then echo SCHED:SLURM',
  'elif command -v qstat >/dev/null 2>&1 && command -v qsub >/dev/null 2>&1; then echo SCHED:PBS',
  'elif command -v djob >/dev/null 2>&1 && command -v dsub >/dev/null 2>&1; then echo SCHED:DONAU',
  'else echo SCHED:NONE; fi',
  'if ! type module >/dev/null 2>&1; then for f in /etc/profile.d/modules.sh /etc/profile.d/lmod.sh /usr/share/Modules/init/bash /usr/share/lmod/lmod/init/bash; do [ -r "$f" ] && . "$f" >/dev/null 2>&1 && type module >/dev/null 2>&1 && break || true; done; fi',
  'if type module >/dev/null 2>&1; then echo MODULE:YES; else echo MODULE:NO; fi',
  'for c in mamba conda uv pip3; do command -v $c >/dev/null 2>&1 && echo "PKG:$c"; done',
  'true',
].join('; ');

export interface EnvProbeResult {
  kind: SchedulerKind;
  hasModule: boolean;
  installers: string[];
}

export function parseSchedulerProbe(output: string): EnvProbeResult {
  const text = output.trim().toLowerCase();
  let kind: SchedulerKind = 'unknown';
  if (/sched:lsf/.test(text)) kind = 'lsf';
  else if (/sched:slurm/.test(text)) kind = 'slurm';
  else if (/sched:pbs/.test(text)) kind = 'pbs';
  else if (/sched:donau/.test(text)) kind = 'donau';
  else if (/sched:none/.test(text)) kind = 'none';
  const hasModule = /module:yes/.test(text);
  const installers = [...text.matchAll(/pkg:(mamba|conda|uv|pip3)/g)].map(m => m[1]);
  return { kind, hasModule, installers: [...new Set(installers)] };
}

type Exec = (cmd: string, timeout?: number) => Promise<string>;

/** 登录后解析该账号的调度器画像：命中缓存直接用，否则探测一次并打标签。 */
export async function resolveAccountScheduler(
  info: { username: string; host: string; port?: string | number },
  exec: Exec,
): Promise<SchedulerTag> {
  const key = schedulerTagKey(info);
  const cached = await loadSchedulerTag(key);
  // 只有明确探测结果才缓存；unknown 必须在下次登录重探，不能固化为 none。
  if (cached && cached.kind !== 'unknown' && cached.probeVersion === SCHEDULER_PROBE_VERSION) return cached;
  let probe: EnvProbeResult;
  try {
    probe = parseSchedulerProbe(await exec(SCHEDULER_PROBE_COMMAND, 20_000));
  } catch {
    probe = { kind: 'unknown', hasModule: false, installers: [] };
  }
  if (probe.kind === 'unknown') return { ...probe, detectedAt: Date.now() };
  return saveSchedulerTag(key, probe);
}

/** 用户手动重探（调度器可能后来才装）：清掉标签下次登录重新探测。 */
export async function clearSchedulerTag(key: string): Promise<void> {
  let all: Record<string, SchedulerTag> = {};
  try {
    all = JSON.parse(await fs.readFile(TAGS_PATH(), 'utf-8'));
  } catch { /* ignore */ }
  if (!(key in all)) return;
  delete all[key];
  const file = TAGS_PATH();
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(all, null, 2), 'utf-8');
  await fs.rename(tmp, file);
}

/** 注入 Agent 系统提示的调度器段落：明确当前集群的作业系统与正确命令。 */
export function buildSchedulerPromptSection(
  kind: SchedulerKind | undefined,
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
  env?: { hasModule?: boolean; installers?: string[] },
): string {
  if (!kind) return '';
  const en = locale === 'en-US';
  let section: string;
  switch (kind) {
    case 'slurm':
      section = en
        ? '\n- SCHEDULER: this cluster uses Slurm. Submit jobs with `sbatch script.sh` (never bsub), monitor with `squeue -u $(whoami)`, final state via `sacct -j <id> --format=State --noheader -X`, cancel with `scancel`. Script directives are `#SBATCH`.'
        : '\n- 调度器：本集群是 Slurm。提交作业用 `sbatch script.sh`（不是 bsub），查看用 `squeue -u $(whoami)`，终态用 `sacct -j <id> --format=State --noheader -X` 补查，取消用 `scancel`。脚本指令写作 `#SBATCH`。';
      break;
    case 'pbs':
      section = en
        ? '\n- SCHEDULER: this cluster uses PBS/Torque. Submit jobs with `qsub script.sh` (never bsub), monitor with `qstat -u $(whoami)`, cancel with `qdel`. Script directives are `#PBS`.'
        : '\n- 调度器：本集群是 PBS/Torque。提交作业用 `qsub script.sh`（不是 bsub），查看用 `qstat -u $(whoami)`，取消用 `qdel`。脚本指令写作 `#PBS`。';
      break;
    case 'donau':
      section = en
        ? "\n- SCHEDULER: this cluster uses the Donau (多瑙) scheduler. Submit jobs with `dsub -s script.dsub` (the script must be chmod +x first; directives are written as `#DSUB`; `-q <queue>` MUST be paired with `-aa`, otherwise the job never gets scheduled to a compute node; request cores with `-R 'cpu=N'`, NPU/GPU with `-R 'npu=N'`/`-R 'gpu=N'`). Monitor with `djob` / `djob <id>`; check queueing/failure reasons and confirm final states with `djob -l <id>`; cancel with `dkill <id>`; list queues with `dqueue`. A complete hpc-donau guide is available in the skill library — run search_skills before writing job scripts."
        : "\n- 调度器：本集群是多瑙（Donau）调度系统。提交作业用 `dsub -s script.dsub`（脚本必须先 chmod +x；指令写作 `#DSUB`；`-q <队列>` 必须和 `-aa` 一起用，缺了 -aa 作业调度不到计算节点；核数用 `-R 'cpu=N'`，NPU/GPU 用 `-R 'npu=N'`/`-R 'gpu=N'`）。查看作业用 `djob` 或 `djob <id>`，排队/失败原因与终态确认用 `djob -l <id>`，取消作业用 `dkill <id>`，查看队列用 `dqueue`。技能库里有完整的 hpc-donau 使用规范，写作业脚本前先用 search_skills 查询。";
      break;
    case 'unknown':
      section = en
        ? '\n- SCHEDULER: detection failed or has not completed. Do not submit, cancel, rerun, or infer job states until scheduler detection succeeds.'
        : '\n- 调度器：探测失败或尚未完成。探测成功前不要提交、取消、重跑作业，也不要推断作业状态。';
      break;
    case 'none':
      section = en
        ? '\n- SCHEDULER: no job scheduler is installed on this host. Do NOT use bsub/sbatch/qsub. Run long tasks in the background with `nohup bash script.sh > log 2>&1 &` and record the PID; keep foreground commands short.'
        : '\n- 调度器：这台机器没有装作业调度系统。不要用 bsub/sbatch/qsub；长任务用 `nohup bash script.sh > log 2>&1 &` 后台跑并记住 PID，前台命令保持短平快。';
      break;
    default:
      section = en
        ? '\n- SCHEDULER: this cluster uses LSF. Submit with `bsub < script.sh`, monitor with `bjobs -w`, cancel with `bkill`. Script directives are `#BSUB`.'
        : '\n- 调度器：本集群是 LSF。提交用 `bsub < script.sh`，查看用 `bjobs -w`，取消用 `bkill`。脚本指令写作 `#BSUB`。';
  }
  if (env?.hasModule === false) {
    const via = env.installers?.length ? env.installers.join('/') : 'conda/pip';
    section += en
      ? `\n- NO Environment Modules on this host: never use module avail/load. Install software directly with ${via} (e.g. mamba create -p ./envs/<name> -c bioconda <pkg>) or prebuilt binaries into the workspace, then call the binaries by absolute path.`
      : `\n- 本机没有 Environment Modules：不要用 module avail/load。装软件直接直装（${via}，如 mamba create -p ./envs/<名> -c bioconda <包>）或把预编译二进制放进工作区，之后用绝对路径调用。`;
  } else if (env?.installers?.length) {
    section += en
      ? `\n- Package managers available alongside modules: ${env.installers.join(', ')}. Prefer \`module load\` for software the site provides; install into the workspace only when no module exists.`
      : `\n- 除 module 外还检测到包管理器：${env.installers.join('、')}。站点已有的软件优先 module load；没有的软件才装到工作区。`;
  }
  return section;
}
