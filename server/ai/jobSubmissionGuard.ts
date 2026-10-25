import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from '../paths';
import { writeFileAtomic0600 } from '../dsh/fileUtils';
import type { SchedulerKind } from '../cluster/schedulerProfile';

export interface JobSubmissionScope {
  sessionId: string;
  conversationKey?: string;
  workflowRunDir?: string;
}

export interface JobSubmissionRecord {
  key: string;
  sessionId: string;
  scopeKey: string;
  intent: string;
  commandHash: string;
  state: 'submitting' | 'submitted' | 'unknown';
  claimId?: string;
  jobIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface JobSubmissionClaim {
  key: string;
  claimId: string;
}

export type JobSubmissionDecision =
  | { kind: 'execute'; claim: JobSubmissionClaim }
  | { kind: 'reuse'; record: JobSubmissionRecord; states: Record<string, string>; reason: 'active' | 'recent_unknown' }
  | { kind: 'unknown'; record: JobSubmissionRecord }
  | { kind: 'busy'; record: JobSubmissionRecord };

interface PrepareOptions extends JobSubmissionScope {
  command: string;
  scheduler?: SchedulerKind;
  exec: (command: string, timeoutMs?: number) => Promise<string>;
  now?: number;
}

export const SUBMISSION_UNKNOWN_GUIDANCE = '提交结果未知：调度器可能已经接收作业。请先用调度器作业列表/历史记录核实，不能盲目重试或重新提交。';

/** 只有远端进程明确以非零状态退出，才能认定提交命令被拒绝并释放防重记录。 */
export function isDefiniteSubmissionRejection(error: unknown): boolean {
  const text = String(error instanceof Error ? error.message : error);
  if (/timed? ?out|socket|reset|refused|unreach|transport|econn|network|ssh|connection|channel|handshake/i.test(text)) {
    return false;
  }
  return /(?:exited with code|exit code|exit status)\s*:?\s*\d+/i.test(text);
}

const MAX_RECORDS = 500;
const SUBMITTING_LEASE_MS = 2 * 60_000;
const UNKNOWN_STATE_GRACE_MS = 10 * 60_000;
const ACTIVE_LSF_STATES = new Set(['PEND', 'RUN', 'WAIT', 'PROV', 'PSUSP', 'USUSP', 'SSUSP', 'ZOMBI']);
const ACTIVE_SLURM_STATES = new Set([
  'PENDING', 'RUNNING', 'CONFIGURING', 'COMPLETING', 'RESIZING', 'SUSPENDED', 'STAGE_OUT',
]);
const TERMINAL_DONAU_STATES = new Set(['SUCCEEDED', 'FAILED', 'STOPPED', 'SSTOPPED']);

function stableHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function shellUnquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith("'") && trimmed.endsWith("'"))
    || (trimmed.startsWith('"') && trimmed.endsWith('"')))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function explicitWorkingDirectory(command: string): string | undefined {
  const matches = [...command.matchAll(/(?:^|&&|;|\n)\s*cd\s+((?:'[^']+'|"[^"]+"|[^;&|\n]+?))\s*(?=&&|;|\n|$)/g)];
  const last = matches.at(-1)?.[1];
  return last ? shellUnquote(last) : undefined;
}

function submissionScript(command: string): { scheduler: string; script?: string } | undefined {
  const schedulerMatch = command.match(/\b(bsub|sbatch|qsub|dsub)\b/i);
  if (!schedulerMatch) return undefined;
  const scheduler = schedulerMatch[1].toLowerCase();
  const tail = command.slice((schedulerMatch.index ?? 0) + schedulerMatch[0].length);
  if (scheduler === 'dsub' && !/^\s*(?:[^\n;&|]*\s)?-s(?:\s|$)/.test(tail)) return undefined;

  if (scheduler === 'bsub') {
    // A single '< file' is the common LSF script form. Do not treat a heredoc
    // ('<<EOF') as a path; heredocs are fingerprinted from their full content.
    const redirected = tail.match(/(?<!<)<(?!<)\s*((?:'[^']+'|"[^"]+"|[^\s;&|]+))/);
    return { scheduler, script: redirected ? shellUnquote(redirected[1]) : undefined };
  }

  // sbatch/qsub conventionally take the script as the final positional token.
  // Taking the last positional token also skips common option values such as
  // `--partition normal`; discard a harmless follow-up command first.
  const submitSegment = tail.split(/(?:&&|;|\n)/, 1)[0];
  const tokens: string[] = submitSegment.match(/(?:'[^']*'|"[^"]*"|\S+)/g) ?? [];
  const script = tokens.filter(token => !token.startsWith('-')).at(-1);
  return { scheduler, script: script ? shellUnquote(script) : undefined };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Resolve the submitted script path using the same rules as the idempotency key. */
export function resolveSubmissionScriptPath(
  command: string,
  scope: Omit<JobSubmissionScope, 'sessionId'>,
): string | undefined {
  const submit = submissionScript(command);
  if (!submit?.script) return undefined;
  const cwd = scope.workflowRunDir || explicitWorkingDirectory(command);
  return submit.script.startsWith('/')
    ? path.posix.normalize(submit.script)
    : cwd
      ? path.posix.normalize(path.posix.join(cwd.replace(/\\/g, '/'), submit.script))
      : submit.script;
}

export interface SubmissionPreflightResult {
  checked: boolean;
  ok: boolean;
  output: string;
  scriptPath?: string;
}

/**
 * Cheap deterministic gate before a scheduler side effect: verify the script,
 * shell syntax, and every literal `module load` token. This catches the common
 * Picard/picard case mismatch before it consumes a queue slot.
 */
export async function preflightJobSubmission(
  command: string,
  scope: Omit<JobSubmissionScope, 'sessionId'>,
  exec: (command: string, timeoutMs?: number) => Promise<string>,
): Promise<SubmissionPreflightResult> {
  const scriptPath = resolveSubmissionScriptPath(command, scope);
  if (!scriptPath) return { checked: false, ok: true, output: '' };
  const quoted = shellQuote(scriptPath);
  const check = [
    `hp_script=${quoted}`,
    'test -s "$hp_script" || { echo "[TRACE_PREFLIGHT] missing or empty script: $hp_script" >&2; exit 41; }',
    'bash -n "$hp_script" || { echo "[TRACE_PREFLIGHT] shell syntax check failed" >&2; exit 42; }',
    "hp_modules=$(awk '/^[[:space:]]*module[[:space:]]+load[[:space:]]+/ { sub(/^[[:space:]]*module[[:space:]]+load[[:space:]]+/, \"\"); sub(/[[:space:]]*(#|&&|[|][|]|;).*$/, \"\"); for (i=1;i<=NF;i++) print $i }' \"$hp_script\")",
    'if test -n "$hp_modules"; then type module >/dev/null 2>&1 || { echo "[TRACE_PREFLIGHT] script requires Environment Modules, but module is unavailable" >&2; exit 43; }; fi',
    'for hp_module in $hp_modules; do module load "$hp_module" >/dev/null 2>&1 || { echo "[TRACE_PREFLIGHT] unavailable module: $hp_module" >&2; module avail "${hp_module%%/*}" 2>&1 | tail -30 >&2; exit 44; }; done',
    'echo "[TRACE_PREFLIGHT] OK: $hp_script"',
  ].join('; ');
  try {
    const output = await exec(check, 20_000);
    return { checked: true, ok: true, output, scriptPath };
  } catch (err) {
    return {
      checked: true,
      ok: false,
      output: err instanceof Error ? err.message : String(err),
      scriptPath,
    };
  }
}

/**
 * Build the caller-provided idempotency intent. Prefer the submitted script's
 * resolved path over the whole shell command so harmless status checks appended
 * after `bsub` do not turn the same submission into a different request.
 */
export function canonicalSubmissionIntent(command: string, scope: Omit<JobSubmissionScope, 'sessionId'>): {
  scopeKey: string;
  intent: string;
} {
  const normalized = String(command || '').trim().replace(/\s+/g, ' ');
  const submit = submissionScript(command);
  const explicitCwd = explicitWorkingDirectory(command);
  const scopeKey = scope.workflowRunDir || explicitCwd || scope.conversationKey || 'session';

  if (submit?.script) {
    const resolved = resolveSubmissionScriptPath(command, scope) || submit.script;
    return { scopeKey, intent: `${submit.scheduler}:script:${resolved}` };
  }
  return { scopeKey, intent: `${submit?.scheduler || 'submit'}:command:${stableHash(normalized)}` };
}

function cloneRecord(record: JobSubmissionRecord): JobSubmissionRecord {
  return { ...record, jobIds: [...record.jobIds] };
}

export class JobSubmissionGuard {
  private records: JobSubmissionRecord[] | undefined;

  constructor(private readonly root = DATA_ROOT) {}

  private storeFile(): string {
    return path.join(this.root, 'job-submission-ledger.json');
  }

  private load(): JobSubmissionRecord[] {
    if (this.records) return this.records;
    this.records = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storeFile(), 'utf8'));
      if (Array.isArray(parsed)) {
        this.records = parsed.filter((item): item is JobSubmissionRecord => Boolean(
          item && typeof item.key === 'string' && typeof item.sessionId === 'string'
          && typeof item.scopeKey === 'string' && typeof item.intent === 'string'
          && (item.state === 'submitting' || item.state === 'submitted' || item.state === 'unknown')
          && Array.isArray(item.jobIds) && typeof item.updatedAt === 'number',
        ));
      }
    } catch { /* first run or a damaged optional ledger starts empty */ }
    return this.records;
  }

  private persist(): void {
    const records = this.load().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_RECORDS);
    this.records = records;
    writeFileAtomic0600(this.storeFile(), JSON.stringify(records, null, 2));
  }

  private begin(scope: JobSubmissionScope, command: string, now: number):
    | { kind: 'execute'; claim: JobSubmissionClaim }
    | { kind: 'existing'; record: JobSubmissionRecord }
    | { kind: 'unknown'; record: JobSubmissionRecord }
    | { kind: 'busy'; record: JobSubmissionRecord } {
    const canonical = canonicalSubmissionIntent(command, scope);
    const key = stableHash(`${scope.sessionId}\0${canonical.scopeKey}\0${canonical.intent}`);
    const records = this.load();
    const existing = records.find(record => record.key === key);
    if (existing?.state === 'unknown') {
      return { kind: 'unknown', record: cloneRecord(existing) };
    }
    if (existing?.state === 'submitting' && now - existing.updatedAt < SUBMITTING_LEASE_MS) {
      return { kind: 'busy', record: cloneRecord(existing) };
    }
    if (existing?.state === 'submitted' && existing.jobIds.length > 0) {
      return { kind: 'existing', record: cloneRecord(existing) };
    }

    const claimId = crypto.randomUUID();
    const next: JobSubmissionRecord = existing ?? {
      key,
      sessionId: scope.sessionId,
      scopeKey: canonical.scopeKey,
      intent: canonical.intent,
      commandHash: stableHash(String(command || '').trim().replace(/\s+/g, ' ')),
      state: 'submitting',
      jobIds: [],
      createdAt: now,
      updatedAt: now,
    };
    next.state = 'submitting';
    next.claimId = claimId;
    next.jobIds = [];
    next.updatedAt = now;
    if (!existing) records.push(next);
    this.persist();
    return { kind: 'execute', claim: { key, claimId } };
  }

  private retry(record: JobSubmissionRecord, now: number): JobSubmissionDecision {
    const current = this.load().find(item => item.key === record.key);
    if (!current || current.updatedAt !== record.updatedAt || current.state !== 'submitted') {
      return { kind: 'busy', record: cloneRecord(current ?? record) };
    }
    const claimId = crypto.randomUUID();
    current.state = 'submitting';
    current.claimId = claimId;
    current.jobIds = [];
    current.updatedAt = now;
    this.persist();
    return { kind: 'execute', claim: { key: current.key, claimId } };
  }

  async prepare(options: PrepareOptions): Promise<JobSubmissionDecision> {
    const now = options.now ?? Date.now();
    const first = this.begin(options, options.command, now);
    if (first.kind === 'execute' || first.kind === 'busy' || first.kind === 'unknown') return first;

    const states = await probeSchedulerJobStates(options.exec, options.scheduler, first.record.jobIds);
    const active = first.record.jobIds.some(jobId => isActiveSchedulerState(options.scheduler, states[jobId]));
    if (active) return { kind: 'reuse', record: first.record, states, reason: 'active' };

    const allUnknown = first.record.jobIds.every(jobId => !states[jobId]);
    if (allUnknown && now - first.record.updatedAt < UNKNOWN_STATE_GRACE_MS) {
      return { kind: 'reuse', record: first.record, states, reason: 'recent_unknown' };
    }
    return this.retry(first.record, now);
  }

  complete(claim: JobSubmissionClaim, jobIds: string[], now = Date.now()): void {
    const record = this.load().find(item => item.key === claim.key && item.claimId === claim.claimId);
    if (!record) return;
    record.jobIds = [...new Set(jobIds.filter(Boolean))];
    record.state = record.jobIds.length > 0 ? 'submitted' : 'unknown';
    record.claimId = undefined;
    record.updatedAt = now;
    this.persist();
  }

  /** 网络/超时/无回执均调用这里；持久 unknown 不参与 submitting 租约重试。 */
  markUnknown(claim: JobSubmissionClaim, now = Date.now()): void {
    const record = this.load().find(item => item.key === claim.key && item.claimId === claim.claimId);
    if (!record) return;
    record.state = 'unknown';
    record.claimId = undefined;
    record.updatedAt = now;
    this.persist();
  }

  /** 仅在用户明确确认“已核实未提交并允许重试”后解除 unknown，绝不按时间自动解锁。 */
  retryUnknown(record: JobSubmissionRecord, now = Date.now()): JobSubmissionClaim {
    const current = this.load().find(item => item.key === record.key);
    if (!current || current.state !== 'unknown' || current.updatedAt !== record.updatedAt) {
      throw new Error('提交未知状态已变化，请重新核实后再试');
    }
    const claimId = crypto.randomUUID();
    current.state = 'submitting';
    current.claimId = claimId;
    current.updatedAt = now;
    this.persist();
    return { key: current.key, claimId };
  }

  /** 仅在调度器明确拒绝命令时调用；其他失败必须保留 unknown。 */
  fail(claim: JobSubmissionClaim): void {
    const records = this.load();
    const index = records.findIndex(item => item.key === claim.key && item.claimId === claim.claimId);
    if (index < 0) return;
    records.splice(index, 1);
    this.persist();
  }

  list(): JobSubmissionRecord[] {
    return this.load().map(cloneRecord);
  }
}

function isActiveSchedulerState(scheduler: SchedulerKind | undefined, state: string | undefined): boolean {
  const normalized = String(state || '').trim().toUpperCase();
  if (!normalized) return false;
  if (scheduler === 'slurm') return ACTIVE_SLURM_STATES.has(normalized);
  if (scheduler === 'pbs') return !['C', 'F', 'E', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(normalized);
  if (scheduler === 'donau') return !TERMINAL_DONAU_STATES.has(normalized);
  return ACTIVE_LSF_STATES.has(normalized);
}

export async function probeSchedulerJobStates(
  exec: (command: string, timeoutMs?: number) => Promise<string>,
  scheduler: SchedulerKind | undefined,
  jobIds: string[],
): Promise<Record<string, string>> {
  const idPattern = scheduler === 'donau' ? /^\d+$/ : /^[\w.-]+$/;
  const safeIds = [...new Set(jobIds.filter(id => idPattern.test(id)))];
  if (safeIds.length === 0) return {};
  let command: string;
  if (scheduler === 'slurm') {
    command = `squeue -h -j ${safeIds.join(',')} -o "%A %T" 2>/dev/null; sacct -n -X -j ${safeIds.join(',')} -o JobIDRaw,State 2>/dev/null; true`;
  } else if (scheduler === 'pbs') {
    command = `qstat ${safeIds.join(' ')} 2>/dev/null; true`;
  } else if (scheduler === 'donau') {
    command = `${safeIds.map(id => `djob ${id}`).join('; ')} 2>/dev/null; true`;
  } else {
    command = `bjobs -a -noheader -o "jobid stat" ${safeIds.join(' ')} 2>/dev/null; true`;
  }
  const output = await exec(command, 15_000).catch(() => '');
  const states: Record<string, string> = {};
  for (const line of String(output || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = scheduler === 'pbs'
      ? trimmed.match(/^([\w.-]+)\s+\S+\s+\S+\s+\S+\s+([A-Za-z])(?:\s|$)/)
      : scheduler === 'donau'
        ? trimmed.match(/^(\d+)\s+\S+\s+\S+\s+([A-Za-z_]+)(?:\s|$)/)
        : trimmed.match(/^(\d+(?:[._-]\d+)?)\s+([A-Za-z_]+)/);
    if (match) states[match[1]] = match[2].toUpperCase();
  }
  return states;
}
