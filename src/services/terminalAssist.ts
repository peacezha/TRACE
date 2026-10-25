/**
 * 终端划词 AI 辅助的本地分析：纯函数、不联网、毫秒级。
 * - analyzeTerminalSelection：识别选区里的路径 / 作业号 / 报错，给出摘要与快捷命令；
 * - resolveAssistIntent：把小窗输入框里的自然语言操作映射成确定命令，识别不了返回 ai 兜底。
 */

export interface AssistAction {
  id: string;
  /** 按钮文案（中文界面短语，走全局 i18n 短语表） */
  label: string;
  /** 有 → 在终端里直接执行 */
  command?: string;
  /** 有 → 转交 AI（explain=解读，analyze=深度分析报错） */
  ai?: 'explain' | 'analyze';
}

export interface AssistAnalysis {
  kind: 'path' | 'job' | 'error' | 'text';
  /** 命中的第一个绝对路径（kind=path） */
  path?: string;
  /** cd 目标：选中的是文件路径时取其所在目录（kind=path） */
  directory?: string;
  /** 压缩包的解压命令（kind=path 且命中压缩包扩展名） */
  extractCommand?: string;
  /** 作业号（kind=job：整段选区是 5–9 位纯数字） */
  jobId?: string;
  /** 命中错误关键词的行（kind=error，最多 3 行，单行截断） */
  errorLines?: string[];
  /** 选区字符数（kind=text） */
  charCount?: number;
  actions: AssistAction[];
}

// POSIX 绝对路径（≥1 段，允许结尾 /）；前置边界避免把 "a/b" 这类相对串误当绝对路径
const ABS_PATH_REGEX = /(?:^|[\s"'(=|:])((?:\/[\w.~+-]+)+\/?)/;
// Windows 绝对路径（C:\… 或 C:/…）：终端虽在 Linux 上，但选区可能是日志里打印的 Windows 路径
const WIN_PATH_REGEX = /(?:^|[\s"'(=|:])([A-Za-z]:[\\/][\w.~+\\/:-]+)/;
const JOB_ID_REGEX = /^\d{5,9}$/;
const ERROR_KEYWORD = /error|failed|fatal|exception|traceback|报错|失败|错误/i;

const MAX_ERROR_LINES = 3;
const MAX_ERROR_LINE_LENGTH = 120;

/** shell 参数统一双引号包裹（JSON.stringify 恰好产出合法的双引号转义） */
function quote(path: string): string {
  return JSON.stringify(path);
}

/** 路径看起来像文件（最后一段含非开头的点）：cd 目标应取其所在目录 */
function looksLikeFile(path: string): boolean {
  const segments = path.split(/[/\\]/).filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  return /^[^.]+\.[^.]+/.test(last);
}

function dirnameOf(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx <= 0) return path.startsWith('/') ? '/' : trimmed;
  return trimmed.slice(0, idx);
}

function extractCommandFor(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith('.zip')) return `unzip -q ${quote(path)}`;
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return `tar -xzf ${quote(path)}`;
  if (lower.endsWith('.tar')) return `tar -xf ${quote(path)}`;
  return undefined;
}

/** 选区内容 → 本地分析结果（类别、摘要数据、快捷操作按钮） */
export type TerminalScheduler = 'lsf' | 'slurm' | 'pbs' | 'donau' | 'none' | 'unknown';

function normalizeScheduler(scheduler?: string | null): TerminalScheduler {
  const value = (scheduler || '').toLowerCase();
  if (value.includes('slurm')) return 'slurm';
  if (value.includes('pbs') || value.includes('torque')) return 'pbs';
  if (value.includes('donau') || value.includes('多瑙')) return 'donau';
  if (value.includes('lsf')) return 'lsf';
  if (value.includes('unknown') || value.includes('未知')) return 'unknown';
  if (value.includes('none') || value.includes('无调度')) return 'none';
  return value ? 'unknown' : 'lsf';
}

function jobCommands(jobId: string, scheduler?: string | null): [string, string, string] | null {
  switch (normalizeScheduler(scheduler)) {
    case 'slurm': return [`squeue -j ${jobId}`, `scontrol show job ${jobId}`, `scancel ${jobId}`];
    case 'pbs': return [`qstat ${jobId}`, `tracejob ${jobId}`, `qdel ${jobId}`];
    case 'donau': return [`djob ${jobId}`, `dpeek ${jobId}`, `dkill ${jobId}`];
    case 'none': return [`ps -p ${jobId} -f`, `ps -p ${jobId} -f`, `kill ${jobId}`];
    case 'lsf': return [`bjobs ${jobId}`, `bpeek ${jobId}`, `bkill ${jobId}`];
    default: return null;
  }
}

export function analyzeTerminalSelection(rawText: string, scheduler?: string | null): AssistAnalysis {
  const text = rawText ?? '';
  const trimmed = text.trim();
  if (!trimmed) {
    return { kind: 'text', charCount: 0, actions: [{ id: 'ai-explain', label: '发给 AI 解读', ai: 'explain' }] };
  }

  // 1) 整段是 5–9 位纯数字 → 疑似作业号，命令跟随当前集群调度器；未知时不猜 LSF。
  if (JOB_ID_REGEX.test(trimmed)) {
    const commands = jobCommands(trimmed, scheduler);
    return {
      kind: 'job',
      jobId: trimmed,
      actions: commands ? [
        { id: 'job-status', label: '查看作业', command: commands[0] },
        { id: 'job-output', label: '查看输出', command: commands[1] },
        { id: 'job-kill', label: '终止作业', command: commands[2] },
      ] : [{ id: 'ai-explain', label: '发给 AI 解读', ai: 'explain' }],
    };
  }

  // 2) 错误关键词 → 报错分析（先于路径：报错输出里常夹带路径，用户更关心错误本身）
  if (ERROR_KEYWORD.test(text)) {
    const errorLines = text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && ERROR_KEYWORD.test(line))
      .slice(0, MAX_ERROR_LINES)
      .map(line => (line.length > MAX_ERROR_LINE_LENGTH ? `${line.slice(0, MAX_ERROR_LINE_LENGTH)}…` : line));
    return {
      kind: 'error',
      errorLines,
      actions: [{ id: 'ai-analyze', label: '发给 AI 深度分析', ai: 'analyze' }],
    };
  }

  // 3) 绝对路径 → 目录跳转 / 查看 / 解压
  const pathMatch = text.match(ABS_PATH_REGEX) ?? text.match(WIN_PATH_REGEX);
  const path = pathMatch?.[1];
  if (path) {
    const directory = looksLikeFile(path) ? dirnameOf(path) : path.replace(/[/\\]+$/, '') || path;
    const extractCommand = extractCommandFor(path);
    const actions: AssistAction[] = [
      { id: 'path-cd', label: '进入该目录', command: `cd ${quote(directory)}` },
      { id: 'path-ls', label: '查看内容', command: `ls -la ${quote(path)}` },
    ];
    if (extractCommand) {
      actions.push({ id: 'path-extract', label: '解压', command: extractCommand });
    }
    return { kind: 'path', path, directory, extractCommand, actions };
  }

  // 4) 普通文本 → 字符数摘要 + 发给 AI 解读
  return {
    kind: 'text',
    charCount: trimmed.length,
    actions: [{ id: 'ai-explain', label: '发给 AI 解读', ai: 'explain' }],
  };
}

export type AssistIntent =
  | { kind: 'command'; command: string }
  | { kind: 'ai' };

/**
 * 小窗输入框的自然语言操作 → 确定命令。
 * 每条规则都要求选区分析具备对应能力（如"解压"要求选中压缩包），否则落到 ai 兜底。
 */
export function resolveAssistIntent(input: string, analysis: AssistAnalysis, scheduler?: string | null): AssistIntent {
  const text = input.trim().toLowerCase();
  if (!text) return { kind: 'ai' };

  if (/解压|extract|unzip|untar/.test(text) && analysis.extractCommand) {
    return { kind: 'command', command: analysis.extractCommand };
  }
  const commands = analysis.jobId ? jobCommands(analysis.jobId, scheduler) : null;
  if (/终止|杀掉|杀|结束|kill|bkill|scancel|qdel/.test(text) && commands) {
    return { kind: 'command', command: commands[2] };
  }
  if (/输出|bpeek|tracejob/.test(text) && commands) {
    return { kind: 'command', command: commands[1] };
  }
  if (/查看|状态|看看|status|bjobs|squeue|qstat/.test(text)) {
    if (commands) return { kind: 'command', command: commands[0] };
    if (analysis.path) return { kind: 'command', command: `ls -la ${quote(analysis.path)}` };
  }
  if (/进入|跳转|打开|\bcd\b/.test(text) && analysis.directory) {
    return { kind: 'command', command: `cd ${quote(analysis.directory)}` };
  }
  if (/列表|内容|ls\b/.test(text) && analysis.path) {
    return { kind: 'command', command: `ls -la ${quote(analysis.path)}` };
  }
  return { kind: 'ai' };
}
