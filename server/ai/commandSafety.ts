// 危险命令检测：命中时需要用户确认后才允许在集群上执行。
// 高风险操作统一进入确认流程；默认模式不再把普通写入、作业提交或联网操作都交给用户手工执行。

const DANGEROUS_PATTERNS: RegExp[] = [
  /\b(bkill|scancel|qdel|dkill)\b/, // Terminate LSF / Slurm / PBS / Donau jobs.
  /\bkill\s+-9\b/,
  /\bpkill\b/,
  /\bkillall\b/,
  /\bmkfs\./, // 格式化
  /\bfdisk\b/,
  /\bdd\s+[^|]*\bof=/, // dd 写盘
  /:\(\)\s*\{/, // fork 炸弹
  /\bchmod\s+(-[a-zA-Z]+\s+)*777\b/, // 777 放权
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\|\s*(sudo\s+)?(sh|bash|zsh)\b/, // curl/wget 管道进 shell
  /\bgit\s+clone\b[^|]*\|\s*(sh|bash)\b/,
];

const CATASTROPHIC_PATTERNS: RegExp[] = [
  /\bmkfs(?:\.|\s)/i,
  /\bfdisk\b/i,
  /\bdd\s+[^|]*\bof=\s*\/dev\//i,
  /:\(\)\s*\{/,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
];

export type CommandRisk = 'read' | 'write' | 'job' | 'network' | 'destructive' | 'unknown';

const READ_ONLY_COMMANDS = new Set([
  'ls', 'pwd', 'find', 'head', 'tail', 'cat', 'zcat', 'bzcat', 'xzcat', 'less',
  'wc', 'file', 'stat', 'namei', 'which', 'whereis', 'type', 'module', 'bjobs',
  'bhosts', 'bqueues', 'bacct', 'bhist', 'bpeek', 'quota', 'df', 'du', 'whoami',
  'hostname', 'date', 'env', 'printenv', 'uname', 'id', 'groups', 'grep', 'egrep',
  'fgrep', 'awk', 'cut', 'sort', 'uniq', 'tr', 'paste', 'column', 'realpath',
  'readlink', 'md5sum', 'sha1sum', 'sha256sum', 'diff', 'cmp', 'comm', 'test', '[',
  'echo', 'printf', 'sed', 'cd', 'export', 'true', 'false',
  'djob', 'dqueue', 'dnode', 'dpeek', 'dacct', 'duser', 'dcluster', 'drespool',
]);

const WRITE_COMMANDS = new Set([
  'mkdir', 'touch', 'cp', 'mv', 'install', 'tee', 'chmod', 'chown', 'chgrp',
  'perl', 'python', 'python3', 'rscript', 'tar', 'gzip', 'gunzip', 'bgzip',
]);

const JOB_COMMANDS = new Set(['bsub', 'bmod', 'bstop', 'bresume', 'brequeue', 'dsub', 'djctl', 'dmod']);
const NETWORK_COMMANDS = new Set(['curl', 'wget', 'scp', 'sftp', 'rsync', 'ssh', 'git']);

function commandWords(command: string): string[] {
  return command
    .split(/(?:&&|\|\||[;|\n])/)
    .map(part => part.trim().match(/^(?:command\s+|sudo\s+|env\s+[^\s=]+=[^\s]+\s+)*([^\s]+)/)?.[1] || '')
    .map(word => word.replace(/^.*\//, '').toLowerCase())
    .filter(Boolean);
}

export function isDangerousCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) return false;
  if (/\brm\b/.test(normalized)) return true;
  return DANGEROUS_PATTERNS.some(pattern => pattern.test(normalized));
}

/** 即使完全自动模式也不允许的机器/磁盘级破坏操作。rm、bkill 等任务级操作不在此列。 */
export function isCatastrophicCommand(command: string): boolean {
  const normalized = command.trim();
  return Boolean(normalized) && CATASTROPHIC_PATTERNS.some(pattern => pattern.test(normalized));
}

/** Job termination always requires an exact, one-shot user decision. */
export function isJobTerminationCommand(command: string): boolean {
  return /\b(?:bkill|scancel|qdel|dkill|djctl)\b/i.test(command);
}

/**
 * Classify the effect of a shell command. This is deliberately conservative:
 * unknown programs are not silently treated as read-only.
 */
const INDIRECT_EXECUTION_PATTERNS = [
  /\b(?:bash|sh|zsh|ksh|dash)\b[^;\n|&]*(?:\s|^)-c(?:\s|$)/i,
  /\beval\b/i,
  /\b(?:awk|gawk|mawk|nawk|perl|python|python3)\b[^\n]*(?:\bsystem\s*\(|\bexec\s*\(|\bqx\s*\b|\bos\s*\.\s*(?:system|popen)\s*\(|\bsubprocess\s*\.)/i,
];

const SUBSTITUTION_RISKS: CommandRisk[] = ['read', 'unknown', 'network', 'job', 'write', 'destructive'];

function classifySubstitutionRisk(command: string): CommandRisk | undefined {
  if (!/\$\(|`/.test(command)) return undefined;
  let risk: CommandRisk = 'unknown';
  const innerCommands = [
    ...[...command.matchAll(/\$\(([\s\S]*?)\)/g)].map(match => match[1]),
    ...[...command.matchAll(/`([^`]*)`/g)].map(match => match[1]),
  ];
  for (const inner of innerCommands) {
    const innerRisk = classifyCommandRisk(inner);
    if (SUBSTITUTION_RISKS.indexOf(innerRisk) > SUBSTITUTION_RISKS.indexOf(risk)) risk = innerRisk;
  }
  return risk;
}

export function classifyCommandRisk(command: string): CommandRisk {
  const normalized = command.trim();
  if (!normalized) return 'read';
  if (isDangerousCommand(normalized)) return 'destructive';
  if (INDIRECT_EXECUTION_PATTERNS.some(pattern => pattern.test(normalized))) return 'unknown';

  const substitutionRisk = classifySubstitutionRisk(normalized);
  if (substitutionRisk) return substitutionRisk;

  const words = commandWords(normalized);
  if (words.some(word => JOB_COMMANDS.has(word))) return 'job';
  if (words.some(word => NETWORK_COMMANDS.has(word))) return 'network';

  // Shell redirection changes state, except the common stderr-to-/dev/null probe.
  const withoutDevNullProbe = normalized.replace(/\d*>\s*\/dev\/null/g, '');
  if (/(^|[^<])>{1,2}[^>]/.test(withoutDevNullProbe) || /<<-?\s*['"]?\w+/.test(normalized)) return 'write';
  if (/\b(?:sed|perl)\b[^\n]*\s-i(?:\s|$)/i.test(normalized)) return 'write';
  if (words.some(word => WRITE_COMMANDS.has(word))) return 'write';
  if (words.length > 0 && words.every(word => READ_ONLY_COMMANDS.has(word))) return 'read';
  return 'unknown';
}
