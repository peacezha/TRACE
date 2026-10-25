import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appPath } from '../paths';
import { renderWorkflowCommand, type Workflow } from './workflowTypes';
import { querySchedulerJobStates, translateSchedulerDirectives } from '../notifications/scheduler';
import type { SchedulerKind } from '../cluster/schedulerProfile';
import { reconcileRunsWithScheduler } from './runAnnotate';
import { workflowSlug } from '../../shared/flowManifest';
import { localizeWorkflowMetadata, normalizeReportLanguage, reportCommandForLanguage } from '../../shared/workflowLocale';
import { qcPauseReason, unresolvedQcFailures, QC_FAILURE_MESSAGE, QC_WARNING_MESSAGE } from '../../shared/workflowQc';
import type {
  WorkflowRun,
  WorkflowRunConfig,
  WorkflowRunPatch,
  WorkflowRunStatus,
  WorkflowRunStepStatus,
} from '../../shared/workflowRun';

export type RunExec = (command: string, timeout?: number) => Promise<string>;

/**
 * 解析流程资产的本地路径：先 pipelines/ 目录（hidog 等既有资产约定），
 * 再应用根（skills/ 下的技能脚本，如 wheatomics.py）。
 */
export function resolveAssetLocalPath(source: string): string {
  const candidates = [appPath('pipelines', source), appPath(source)];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
  }
  throw new Error(`资产文件不存在: ${source}`);
}

/** createWorkflowRun 的可选部署上下文：有 sftp 时把 workflow.assets 上传进 RUN 目录。 */
export interface CreateRunDeployContext {
  sftp?: { fastPut: (localPath: string, remotePath: string, cb: (err?: Error) => void) => void } | undefined;
  /** 目标集群调度器：非 LSF 时步骤脚本里的 #BSUB 指令会被翻译；未知或不支持的资源约束会拒绝创建。 */
  scheduler?: SchedulerKind;
}

const RUN_STATUSES = new Set<WorkflowRunStatus>([
  'blocked_env', 'running', 'waiting_user', 'waiting_jobs', 'done', 'failed', 'cancelled', 'unknown',
]);
const STEP_STATUSES = new Set<WorkflowRunStepStatus>(['pending', 'running', 'done', 'failed', 'skipped']);
const STEP_TRANSITIONS: Record<WorkflowRunStepStatus, WorkflowRunStepStatus[]> = {
  pending: ['running', 'skipped'],
  running: ['done', 'failed'],
  failed: ['running', 'skipped'],
  done: [],
  skipped: [],
};

const runUpdateLocks = new Map<string, Promise<void>>();

async function withRunUpdateLock<T>(runDir: string, operation: () => Promise<T>): Promise<T> {
  const previous = runUpdateLocks.get(runDir) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => gate);
  runUpdateLocks.set(runDir, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (runUpdateLocks.get(runDir) === queued) runUpdateLocks.delete(runDir);
  }
}

function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function assertWorkflowStepTransition(from: WorkflowRunStepStatus, to: WorkflowRunStepStatus): void {
  if (from === to) return;
  if (!STEP_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`非法流程步骤状态转换: ${from} -> ${to}`);
  }
}

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function cleanRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .slice(0, 200)
    .map(([k, v]) => [String(k).slice(0, 100), String(v ?? '').slice(0, 4000)]));
}

function cleanStepParams(value: unknown): Record<number, Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<number, Record<string, string>> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    const n = Number(key);
    if (Number.isInteger(n) && n > 0) out[n] = cleanRecord(raw);
  }
  return out;
}

function cleanStepCommands(value: unknown): Record<number, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<number, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    const n = Number(key);
    const command = String(raw ?? '').trim();
    if (Number.isInteger(n) && n > 0 && command) out[n] = command.slice(0, 20_000);
  }
  return out;
}

export function sanitizeRunConfig(value: unknown): WorkflowRunConfig {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    ...(v.reportLanguage === 'zh' || v.reportLanguage === 'en' ? { reportLanguage: v.reportLanguage } : {}),
    inputs: Array.isArray(v.inputs) ? v.inputs.map(String).map(s => s.trim()).filter(Boolean).slice(0, 200) : [],
    params: cleanRecord(v.params),
    stepParams: cleanStepParams(v.stepParams),
    referenceOverrides: cleanRecord(v.referenceOverrides),
    skippedSteps: Array.isArray(v.skippedSteps)
      ? [...new Set(v.skippedSteps.map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 100)
      : [],
    stepCommandOverrides: cleanStepCommands(v.stepCommandOverrides),
  };
}

function formatRunStamp(now: number): string {
  const d = new Date(now);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

export function resolveWorkflowRunDir(home: string, runDir: string): string | null {
  const normalizedHome = home.replace(/\/+$/, '');
  const trimmed = String(runDir || '').trim();
  if (!trimmed || trimmed.includes('..') || /[\r\n\0]/.test(trimmed)) return null;
  const expanded = trimmed.startsWith('~/') ? `${normalizedHome}/${trimmed.slice(2)}` : trimmed;
  if (![`${normalizedHome}/trace_flows/`, `${normalizedHome}/hpclaw_flows/`].some(root => expanded.startsWith(root))) return null;
  if (!expanded.includes('/03_workspace/runs/')) return null;
  return expanded.replace(/\/+$/, '');
}

function atomicJsonCommand(filePath: string, value: unknown): string {
  const payload = Buffer.from(JSON.stringify(value, null, 2), 'utf8').toString('base64');
  const tmp = `${filePath}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  return `printf %s ${shq(payload)} | base64 -d > ${shq(tmp)} && mv ${shq(tmp)} ${shq(filePath)}`;
}

function atomicTextCommand(filePath: string, content: string): string {
  const payload = Buffer.from(content, 'utf8').toString('base64');
  const tmp = `${filePath}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  return `printf %s ${shq(payload)} | base64 -d > ${shq(tmp)} && mv ${shq(tmp)} ${shq(filePath)}`;
}

export function workflowStepScriptPath(runDir: string, stepNumber: number): string {
  return `${runDir.replace(/\/+$/, '')}/code/step-${String(stepNumber).padStart(2, '0')}.sh`;
}

function workflowRunValues(
  config: WorkflowRunConfig,
  stepNumber: number,
  runDir: string,
  flowDir: string,
): Record<string, string> {
  const values: Record<string, string> = {
    ...config.params,
    ...config.referenceOverrides,
    ...(config.stepParams[stepNumber] || {}),
    RUN: runDir,
    RUN_DIR: runDir,
    FLOW: flowDir,
    FLOW_HOME: flowDir,
  };
  if (!values.INPUT_DIR && config.inputs[0]) values.INPUT_DIR = config.inputs[0];
  return values;
}

export function buildWorkflowStepScript(
  workflow: Workflow,
  config: WorkflowRunConfig,
  stepNumber: number,
  runDir: string,
  scheduler: SchedulerKind = 'lsf',
): string {
  const step = workflow.steps[stepNumber - 1];
  if (!step) throw new Error(`步骤不存在: ${stepNumber}`);
  const flowDir = runDir.split('/03_workspace/runs/')[0] || runDir;
  const language = normalizeReportLanguage(config.reportLanguage, workflow.id.endsWith('-en') ? 'en' : 'zh');
  const template = reportCommandForLanguage(config.stepCommandOverrides[stepNumber] || step.command || '', language);
  const rendered = translateSchedulerDirectives(
    renderWorkflowCommand(template, workflowRunValues(config, stepNumber, runDir, flowDir))
      .replaceAll('<RUN>', runDir)
      .replaceAll('<FLOW>', flowDir)
      .trim(),
    scheduler,
  );
  // 调度器只识别脚本首个可执行语句之前的指令，统一放到 shebang 后、set 命令前。
  const renderedLines = rendered.split(/\r?\n/);
  const schedulerDirectives = renderedLines.filter(line => /^\s*#(?:BSUB|SBATCH|DSUB|PBS)\b/.test(line));
  const renderedBody = renderedLines.filter(line => !/^\s*#(?:BSUB|SBATCH|DSUB|PBS)\b/.test(line)).join('\n').trim();
  const unresolved = [...rendered.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map(match => match[1]);
  const uniqueUnresolved = [...new Set(unresolved)];
  return [
    '#!/usr/bin/env bash',
    ...schedulerDirectives,
    'set -eo pipefail',
    '',
    `# TRACE ${language === 'en' ? 'workflow: ' : '流程：'}${workflow.name}`,
    `# ${language === 'en' ? 'Step ' : '步骤 '}${stepNumber}/${workflow.steps.length}${language === 'en' ? ': ' : '：'}${step.title}`,
    language === 'en' ? '# This is the executable step script. Saved edits apply only to steps not yet submitted.' : '# 这是本步骤实际运行脚本。可以在流程面板中查看和修改；保存后，尚未提交的步骤会使用修改内容。',
    language === 'en' ? '# Submitted scheduler jobs are not changed. Check their status before rerunning.' : '# 已经提交到调度器的作业不会被修改；需要重跑时请先确认作业状态。',
    ...(step.notes ? [`# ${language === 'en' ? 'Note: ' : '注意：'}${step.notes.replace(/\r?\n/g, ' ')}`] : []),
    ...(uniqueUnresolved.length > 0
      ? [`# TRACE_REVIEW_REQUIRED: ${language === 'en' ? 'Resolve these parameters before running: ' : '以下参数尚未确定，请在运行前补齐：'}${uniqueUnresolved.join(', ')}`]
      : []),
    '',
    `export TRACE_REPORT_LANGUAGE=${language}`,
    renderedBody || (language === 'en' ? '# No executable command is defined; add it here.' : '# 当前步骤没有可直接执行的命令，请在此处补充。'),
    '',
  ].join('\n');
}

function buildCodeReadme(workflow: Workflow, runDir: string, language: 'zh' | 'en' = 'zh'): string {
  const en = language === 'en';
  const graph = resolveWorkflowStepGraph(workflow);
  const stepLines = workflow.steps.map((step, index) => {
    const deps = graph[index].dependsOn.length
      ? `${en ? '; depends on ' : '；依赖 '}${graph[index].dependsOn.join(en ? ', ' : '、')}`
      : (en ? '; no prerequisite' : '；无前置依赖');
    return `- ${en ? 'Step ' : '步骤 '}${index + 1} [${graph[index].stepId}]${en ? ': ' : '：'}\`step-${String(index + 1).padStart(2, '0')}.sh\` — ${step.title}${deps}`;
  });
  return [
    `# ${workflow.name} — ${en ? 'Run scripts' : '本次运行代码'}`,
    '',
    `${en ? 'Run directory: ' : '运行目录：'}\`${runDir}\``,
    '',
    en ? 'These are the executable scripts for this run, one per workflow step.' : '这里保存本次运行真正使用的脚本，一个流程步骤对应一个脚本。',
    en ? 'Edit them in TRACE using View/edit code. The agent reads each script before executing a step that has not yet been submitted.' : '你可以在 TRACE 的“查看/修改代码”中编辑；Agent 在执行尚未提交的步骤前会读取对应脚本。',
    en ? 'Edits do not change submitted scheduler jobs. Running a script manually does not automatically update step states in run.json.' : '修改脚本不会改变已经提交到调度器的作业。手动在终端执行脚本时，run.json 的步骤状态不会自动更新。',
    '',
    ...stepLines,
    '',
    en ? 'Logs: `../logs/`. Results: `../results/`. Run state: `../run.json`.' : '日志保存在 `../logs/`，结果保存在 `../results/`，运行状态保存在 `../run.json`。',
    '',
  ].join('\n');
}

export interface ResolvedWorkflowGraphStep {
  stepId: string;
  dependsOn: string[];
}

/**
 * 把旧版串行步骤和新版显式 DAG 统一成稳定依赖图。
 * 显式依赖必须指向排在当前步骤之前的节点，保证现有逐步执行器可安全执行。
 */
export function resolveWorkflowStepGraph(workflow: Pick<Workflow, 'steps'>): ResolvedWorkflowGraphStep[] {
  const graph: ResolvedWorkflowGraphStep[] = [];
  const seen = new Set<string>();
  workflow.steps.forEach((step, index) => {
    const fallback = `step-${String(index + 1).padStart(2, '0')}`;
    const stepId = String(step.id || fallback).trim();
    if (!stepId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(stepId)) {
      throw new Error(`步骤 ${index + 1} 的 id 无效: ${stepId || '(空)'}`);
    }
    if (seen.has(stepId)) throw new Error(`流程步骤 id 重复: ${stepId}`);
    const dependsOn = step.dependsOn === undefined
      ? (index > 0 ? [graph[index - 1].stepId] : [])
      : [...new Set(step.dependsOn.map(String).map(id => id.trim()).filter(Boolean))];
    for (const dependency of dependsOn) {
      if (!seen.has(dependency)) {
        throw new Error(`步骤 ${stepId} 的依赖 ${dependency} 不存在或未排在它之前`);
      }
    }
    graph.push({ stepId, dependsOn });
    seen.add(stepId);
  });
  return graph;
}

export async function writeWorkflowRun(exec: RunExec, home: string, run: WorkflowRun, timeoutMs = 20_000): Promise<void> {
  const safeDir = resolveWorkflowRunDir(home, run.runDir);
  if (!safeDir) throw new Error('非法流程运行目录');
  await exec(atomicJsonCommand(`${safeDir}/run.json`, run), timeoutMs);
}

/** reconcile 链路（读 + 条件写）的 SSH 超时：大 LSF 集群上 cat/写 run.json 可能远超 15s。 */
export interface RunIoTimeouts {
  readTimeoutMs?: number;
  writeTimeoutMs?: number;
}

/** Scheduler reconciliation shares the same lock as Agent/user writes: never overwrite a newer step. */
export async function reconcileWorkflowRunWithScheduler(
  exec: RunExec,
  home: string,
  runDir: string,
  states: Map<string, string>,
  timeouts: RunIoTimeouts = {},
): Promise<WorkflowRun> {
  const safeDir = resolveWorkflowRunDir(home, runDir);
  if (!safeDir) throw new Error('流程运行目录无效');
  return withRunUpdateLock(safeDir, async () => {
    const before = await readWorkflowRun(exec, home, safeDir, timeouts.readTimeoutMs ?? 15_000);
    const after = reconcileRunsWithScheduler([before], states)[0];
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      after.revision = (before.revision || 0) + 1;
      await writeWorkflowRun(exec, home, after, timeouts.writeTimeoutMs ?? 20_000);
    }
    return after;
  });
}

export async function readWorkflowRun(exec: RunExec, home: string, runDir: string, timeoutMs = 15_000): Promise<WorkflowRun> {
  const safeDir = resolveWorkflowRunDir(home, runDir);
  if (!safeDir) throw new Error('非法流程运行目录');
  const raw = await exec(`cat ${shq(`${safeDir}/run.json`)}`, timeoutMs);
  const parsed = JSON.parse(raw) as WorkflowRun;
  if (!parsed || !parsed.runId || !Array.isArray(parsed.steps)) throw new Error('运行记录格式无效');
  parsed.runDir = safeDir;
  parsed.revision = Number.isInteger(parsed.revision) ? parsed.revision : 0;
  return parsed;
}

function markdownCell(value: unknown): string {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/** 不调用模型，直接从已验证的运行证据生成轻量报告，避免额外 Token。 */
export function buildWorkflowRunSummary(run: WorkflowRun): string {
  const en = normalizeReportLanguage(run.config?.reportLanguage, run.workflowId.endsWith('-en') ? 'en' : 'zh') === 'en';
  const issues = run.steps.filter(step => step.qc?.status === 'fail' || step.qc?.status === 'warn');
  const stepRows = run.steps.map(step => [
    step.n,
    markdownCell(step.title),
    step.status,
    markdownCell(step.summary || ''),
    markdownCell((step.outputs || []).join('、')),
    step.qc?.status || '',
  ].join(' | '));
  return [
    `# ${run.workflowName} — ${en ? 'Run report' : '运行报告'}`,
    '',
    `- ${en ? 'Run ID: ' : '运行 ID：'}\`${run.runId}\``,
    `- ${en ? 'Status: ' : '状态：'}${run.status}`,
    `- ${en ? 'Started: ' : '开始时间：'}${new Date(run.startedAt).toISOString()}`,
    `- ${en ? 'Completed: ' : '完成时间：'}${new Date(run.endedAt || run.updatedAt).toISOString()}`,
    `- ${en ? 'Working directory: ' : '工作目录：'}\`${run.runDir}\``,
    '',
    ...(issues.length ? [en ? '## QC risk warnings' : '## 质控风险提醒', '', ...issues.flatMap(step => [
      `### ${step.n}. ${step.title} — QC ${step.qc!.status}`,
      '',
      en ? (step.qc!.status === 'fail' ? 'QC failed: poor quality; downstream analysis is not recommended.' : 'QC warning: review the metrics before proceeding.') : step.qc!.status === 'fail' ? QC_FAILURE_MESSAGE.replace('；自动推进已暂停。', '。') : QC_WARNING_MESSAGE,
      ...(step.qcOverride ? [en ? `The user acknowledged continuation at ${new Date(step.qcOverride.approvedAt).toISOString()}; this does not establish a QC pass.` : `用户已于 ${new Date(step.qcOverride.approvedAt).toISOString()} 明确确认继续；这不代表质控通过。`] : []),
      ...Object.entries(step.qc!.metrics || {}).map(([key, value]) => `- ${markdownCell(key)}: ${markdownCell(value)}`),
      ...(step.summary ? [markdownCell(step.summary)] : []),
      '',
    ])] : []),
    en ? '## Steps and evidence' : '## 步骤与证据',
    '',
    en ? 'No. | Step | Status | Summary | Outputs | QC' : '序号 | 步骤 | 状态 | 结果摘要 | 输出 | QC',
    '--- | --- | --- | --- | --- | ---',
    ...stepRows,
    '',
    en ? '> TRACE generated this report from verified step states, outputs and QC evidence in run.json, without an additional AI call.' : '> 本报告由 TRACE 根据 run.json 中已经验证的步骤状态、输出和 QC 证据自动生成，不额外调用 AI 模型。',
    '',
  ].join('\n');
}

export async function createWorkflowRun(
  exec: RunExec,
  home: string,
  workflow: Workflow,
  rawConfig: unknown,
  preflightReady?: boolean,
  deploy?: CreateRunDeployContext,
): Promise<WorkflowRun> {
  const now = Date.now();
  const slug = workflowSlug(workflow.name);
  const runId = `${slug}-${formatRunStamp(now)}-${crypto.randomBytes(2).toString('hex')}`;
  const runDir = `${home.replace(/\/+$/, '')}/trace_flows/${slug}/03_workspace/runs/${runId}`;
  const codeDir = `${runDir}/code`;
  const config = sanitizeRunConfig(rawConfig);
  config.reportLanguage = normalizeReportLanguage(config.reportLanguage, workflow.id.endsWith('-en') ? 'en' : 'zh');
  workflow = localizeWorkflowMetadata(workflow, config.reportLanguage);
  workflow.steps = workflow.steps.map(step => ({ ...step, command: reportCommandForLanguage(step.command, config.reportLanguage!) }));
  const graph = resolveWorkflowStepGraph(workflow);
  const stepScripts = workflow.steps.map((_step, index) =>
    buildWorkflowStepScript(workflow, config, index + 1, runDir, deploy?.scheduler ?? 'lsf'));
  const run: WorkflowRun = {
    runId,
    workflowId: workflow.id,
    workflowName: workflow.name,
    workflowVersion: workflow.updatedAt,
    revision: 1,
    runDir,
    codeDir,
    workspacePolicy: 'isolated-run-v1',
    status: preflightReady === false ? 'blocked_env' : 'running',
    startedAt: now,
    updatedAt: now,
    heartbeatAt: now,
    currentStep: 0,
    totalSteps: workflow.steps.length,
    config,
    steps: workflow.steps.map((step, index) => ({
      n: index + 1,
      stepId: graph[index].stepId,
      dependsOn: graph[index].dependsOn,
      phase: step.phase,
      title: step.title,
      qcCriteria: workflow.manifest?.qcGates.filter(gate => gate.afterStep === index + 1),
      status: config.skippedSteps.includes(index + 1) ? 'skipped' : 'pending',
      scriptPath: workflowStepScriptPath(runDir, index + 1),
      scriptUpdatedAt: now,
      scriptUserModified: false,
      scriptHash: contentHash(stepScripts[index]),
    })),
  };

  const safeDir = resolveWorkflowRunDir(home, runDir);
  if (!safeDir) throw new Error('无法创建流程运行目录');
  const commands = [
    `mkdir -p ${shq(codeDir)} ${shq(`${safeDir}/logs`)} ${shq(`${safeDir}/results`)}`,
    atomicTextCommand(`${codeDir}/README.md`, buildCodeReadme(workflow, safeDir, config.reportLanguage)),
    ...workflow.steps.map((_step, index) => atomicTextCommand(
      workflowStepScriptPath(safeDir, index + 1),
      stepScripts[index],
    )),
    `chmod u+x ${shq(codeDir)}/step-*.sh`,
    atomicJsonCommand(`${safeDir}/config.json`, config),
    atomicJsonCommand(`${safeDir}/workspace.json`, {
      policy: 'isolated-run-v1',
      writableRoot: safeDir,
      allowedReadPaths: [...config.inputs, ...Object.values(config.referenceOverrides)],
      createdAt: now,
    }),
    atomicJsonCommand(`${safeDir}/workflow.snapshot.json`, workflow),
    atomicJsonCommand(`${safeDir}/run.json`, run),
    `mkdir -p ${shq(`${home.replace(/\/+$/, '')}/trace_flows/.trace`)}`,
    `printf '%s\\n' ${shq(safeDir)} >> ${shq(`${home.replace(/\/+$/, '')}/trace_flows/.trace/run-index.txt`)}`,
  ];
  await exec(commands.join('\n'), 30_000);

  // 流程资产自动部署（如 wheatomics.py）：创建 RUN 即就位，避免 Agent 满世界找脚本
  // 空转几十步（v0.2.2 用户实测踩中）。部署失败不阻断 RUN 创建，步骤执行时如实暴露。
  if (deploy?.sftp && Array.isArray(workflow.assets) && workflow.assets.length > 0) {
    for (const asset of workflow.assets) {
      try {
        const localPath = resolveAssetLocalPath(asset.source);
        const remote = `${safeDir}/${String(asset.remotePath || path.basename(asset.source))}`;
        await exec(`mkdir -p ${shq(path.posix.dirname(remote))}`, 15_000);
        await new Promise<void>((resolve, reject) => {
          deploy.sftp!.fastPut(localPath, remote, err => (err ? reject(err) : resolve()));
        });
      } catch (err) {
        console.warn('[workflow] 资产部署失败 %s: %s', asset.source, err instanceof Error ? err.message : String(err));
      }
    }
  }
  return run;
}

export interface WorkflowStepCode {
  run: WorkflowRun;
  step: WorkflowRun['steps'][number];
  codeDir: string;
  scriptPath: string;
  content: string;
}

export async function readWorkflowStepCode(
  exec: RunExec,
  home: string,
  runDir: string,
  stepNumber: number,
): Promise<WorkflowStepCode> {
  const run = await readWorkflowRun(exec, home, runDir);
  const step = run.steps.find(item => item.n === stepNumber);
  if (!step) throw new Error(`步骤不存在: ${stepNumber}`);
  const scriptPath = workflowStepScriptPath(run.runDir, stepNumber);
  const content = await exec(
    `if [ -f ${shq(scriptPath)} ]; then head -c 200000 ${shq(scriptPath)}; else printf %s ${shq('步骤脚本不存在')}; exit 2; fi`,
    15_000,
  );
  return { run, step, codeDir: `${run.runDir}/code`, scriptPath, content };
}

export async function writeWorkflowStepCode(
  exec: RunExec,
  home: string,
  runDir: string,
  stepNumber: number,
  rawContent: unknown,
): Promise<WorkflowStepCode> {
  const content = String(rawContent ?? '').replace(/\0/g, '');
  if (!content.trim()) throw new Error('步骤脚本不能为空');
  if (Buffer.byteLength(content, 'utf8') > 200_000) throw new Error('步骤脚本不能超过 200 KB');
  const safeDir = resolveWorkflowRunDir(home, runDir);
  if (!safeDir) throw new Error('非法流程运行目录');
  return withRunUpdateLock(safeDir, async () => {
    const run = await readWorkflowRun(exec, home, safeDir);
    const step = run.steps.find(item => item.n === stepNumber);
    if (!step) throw new Error(`步骤不存在: ${stepNumber}`);
    if (step.status === 'running' || step.status === 'done' || step.status === 'skipped' || (step.jobIds?.length || 0) > 0) {
      throw new Error('该步骤已经运行或提交，不能直接修改脚本；请创建新的运行或按失败重试流程生成修订。');
    }
    const scriptPath = workflowStepScriptPath(run.runDir, stepNumber);
    await exec(`${atomicTextCommand(scriptPath, content)} && chmod u+x ${shq(scriptPath)}`, 20_000);
    const now = Date.now();
    step.scriptPath = scriptPath;
    step.scriptUpdatedAt = now;
    step.scriptUserModified = true;
    step.scriptHash = contentHash(content);
    run.codeDir = `${run.runDir}/code`;
    run.updatedAt = now;
    run.heartbeatAt = now;
    run.revision = (run.revision || 0) + 1;
    await writeWorkflowRun(exec, home, run);
    return { run, step, codeDir: run.codeDir, scriptPath, content };
  });
}

function cleanStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(String).map(s => s.trim()).filter(Boolean).slice(0, 200);
}

async function assertLifecycleJobsTerminal(
  exec: RunExec,
  scheduler: SchedulerKind | undefined,
  jobIds: string[],
  action: '重跑' | '取消',
): Promise<void> {
  const ids = [...new Set(jobIds)];
  if (ids.length === 0) return;
  if (!scheduler || scheduler === 'unknown' || scheduler === 'none') {
    throw new Error(`无法${action}：当前调度器无法核实 ${ids.length} 个作业状态，已保持原运行状态`);
  }
  const states = await querySchedulerJobStates(exec, scheduler, ids);
  const unsafe = ids.map(jobId => ({ jobId, state: states[jobId] ?? 'UNKNOWN' }))
    .filter(item => item.state !== 'DONE' && item.state !== 'EXIT');
  if (unsafe.length > 0) {
    const detail = unsafe.map(item => `${item.jobId}=${item.state}`).join('、');
    throw new Error(`无法${action}：作业仍为 RUN/PEND/UNKNOWN 或无法核实（${detail}），已保持原运行状态`);
  }
}

export async function updateWorkflowRun(
  exec: RunExec,
  home: string,
  runDir: string,
  patch: WorkflowRunPatch,
  options: { acknowledgeFailedQc?: boolean; scheduler?: SchedulerKind } & RunIoTimeouts = {},
): Promise<WorkflowRun> {
  const safeDir = resolveWorkflowRunDir(home, runDir);
  if (!safeDir) throw new Error('非法流程运行目录');
  return withRunUpdateLock(safeDir, async () => {
  const run = await readWorkflowRun(exec, home, safeDir, options.readTimeoutMs ?? 15_000);
  if (Number.isInteger(patch.expectedRevision) && patch.expectedRevision !== run.revision) {
    throw new Error(`流程状态已被其他操作更新（期望 revision ${patch.expectedRevision}，当前 ${run.revision}），请刷新后重试`);
  }
  const now = Date.now();

  const restarting = Number.isInteger(patch.restartFromStep);
  const cancelling = patch.status === 'cancelled';
  if (restarting || cancelling) {
    const affectedSteps = restarting
      ? run.steps.filter(step => step.n >= Number(patch.restartFromStep))
      : run.steps;
    await assertLifecycleJobsTerminal(
      exec,
      options.scheduler,
      affectedSteps.flatMap(step => step.jobIds || []),
      restarting ? '重跑' : '取消',
    );
  }

  if (Number.isInteger(patch.restartFromStep)) {
    const restartFromStep = Number(patch.restartFromStep);
    if (restartFromStep < 1 || restartFromStep > run.totalSteps) {
      throw new Error(`重跑起始步骤无效: ${restartFromStep}`);
    }
    const resetSteps = run.steps.filter(step => step.n >= restartFromStep);
    if (resetSteps.length === 0) throw new Error(`找不到重跑起始步骤: ${restartFromStep}`);
    const resetJobIds = new Set(resetSteps.flatMap(step => step.jobIds || []));
    for (const step of resetSteps) {
      step.status = 'pending';
      delete step.startedAt;
      delete step.finishedAt;
      delete step.jobIds;
      delete step.summary;
      delete step.qc;
      delete step.qcOverride;
      delete step.outputs;
      delete step.evidence;
      delete step.submittedScriptHash;
    }
    if (run.jobStates) {
      for (const jobId of resetJobIds) delete run.jobStates[jobId];
    }
    run.currentStep = restartFromStep;
    run.status = 'running';
    delete run.endedAt;
    delete run.error;
    delete run.reportPath;
  }

  if (options.acknowledgeFailedQc) {
    if (!Number.isInteger(patch.expectedRevision)) throw new Error('确认质控风险前必须刷新运行状态并提供 revision');
    for (const step of unresolvedQcFailures(run)) step.qcOverride = { approvedAt: now, revision: run.revision };
  }

  if (patch.status && RUN_STATUSES.has(patch.status)) run.status = patch.status;
  if (patch.status === 'running' || patch.status === 'waiting_user' || patch.status === 'waiting_jobs' || patch.status === 'blocked_env') {
    delete run.endedAt;
  }
  if (Number.isInteger(patch.currentStep) && Number(patch.currentStep) >= 0 && Number(patch.currentStep) <= run.totalSteps) {
    run.currentStep = Number(patch.currentStep);
  }
  if (typeof patch.error === 'string') run.error = patch.error.slice(0, 4000);
  if (typeof patch.reportPath === 'string') run.reportPath = patch.reportPath.slice(0, 2000);

  if (patch.step && Number.isInteger(patch.step.n)) {
    const step = run.steps.find(s => s.n === patch.step!.n);
    if (!step) throw new Error(`步骤不存在: ${patch.step.n}`);
    if (patch.step.status && STEP_STATUSES.has(patch.step.status)) {
      assertWorkflowStepTransition(step.status, patch.step.status);
      if (patch.step.status === 'running') {
        if (unresolvedQcFailures(run).length) throw new Error(qcPauseReason(run));
        const dependencies = Array.isArray(step.dependsOn)
          ? step.dependsOn
          : run.steps.filter(s => s.n < step.n).map(s => s.stepId);
        const unfinishedDependency = dependencies
          .map(id => run.steps.find(s => s.stepId === id))
          .find((candidate): candidate is WorkflowRun['steps'][number] => Boolean(candidate && candidate.status !== 'done' && candidate.status !== 'skipped'));
        if (unfinishedDependency) {
          throw new Error(`前置步骤 ${unfinishedDependency.n}（${unfinishedDependency.title}）尚未完成，不能启动步骤 ${step.n}`);
        }
      }
      const completionSummary = typeof patch.step.summary === 'string' ? patch.step.summary.trim() : step.summary?.trim();
      if (patch.step.status === 'done' && !completionSummary) {
        throw new Error(`步骤 ${step.n} 完成时必须提供基于真实输出的 summary`);
      }
      const completionQc = patch.step.qc ?? step.qc;
      const validCompletionQc = completionQc && ['pass', 'warn', 'fail'].includes(completionQc.status);
      if (patch.step.status === 'done' && step.qcCriteria?.length && !validCompletionQc) {
        throw new Error(`步骤 ${step.n} 声明了质控标准，完成前必须读取实际指标并记录 qc（pass/warn/fail），不能把命令退出成功当作质控通过`);
      }
      const completionEvidence = [
        ...(Array.isArray(patch.step.evidence) ? patch.step.evidence : step.evidence || []),
        ...(Array.isArray(patch.step.outputs) ? patch.step.outputs : step.outputs || []),
        ...(Array.isArray(patch.step.jobIds) ? patch.step.jobIds : step.jobIds || []),
        ...(validCompletionQc ? ['QC'] : []),
      ].map(String).map(item => item.trim()).filter(Boolean);
      if (patch.step.status === 'done' && completionEvidence.length === 0) {
        throw new Error(`步骤 ${step.n} 完成时必须提供命令、日志、输出文件、作业号或 QC 证据`);
      }
      step.status = patch.step.status;
    }
    if (typeof patch.step.summary === 'string') step.summary = patch.step.summary.slice(0, 8000);
    const jobIds = cleanStringList(patch.step.jobIds);
    if (jobIds) step.jobIds = jobIds.filter(id => /^\d+(?:[._]\d+)?$/.test(id));
    const outputs = cleanStringList(patch.step.outputs);
    if (outputs) step.outputs = outputs;
    const evidence = cleanStringList(patch.step.evidence);
    if (evidence) step.evidence = evidence.map(item => item.slice(0, 4000));
    if (patch.step.qc && ['pass', 'warn', 'fail'].includes(patch.step.qc.status)) {
      // A fresh QC verdict must be reviewed anew, even after an earlier override.
      delete step.qcOverride;
      step.qc = {
        status: patch.step.qc.status,
        metrics: patch.step.qc.metrics ? cleanRecord(patch.step.qc.metrics) : undefined,
      };
    }
    if (step.status === 'running') {
      step.startedAt ??= now;
      step.submittedScriptHash ??= step.scriptHash;
      run.currentStep = step.n;
      // A submitted step is running, but the Agent must yield to the watcher.
      // Do not overwrite an explicit waiting_jobs/waiting_user hand-off.
      if (run.status !== 'blocked_env' && (!patch.status || patch.status === 'running')) run.status = 'running';
    }
    if (step.status === 'done' || step.status === 'failed' || step.status === 'skipped') step.finishedAt ??= now;
    if (step.status === 'failed') {
      run.status = 'failed';
      run.endedAt = now;
    }
  }

  if (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled') run.endedAt ??= now;
  const qcBlocked = unresolvedQcFailures(run).length > 0;
  if (!qcBlocked && run.error?.startsWith(QC_FAILURE_MESSAGE)) delete run.error;
  if (qcBlocked && !['failed', 'cancelled', 'blocked_env'].includes(run.status)) {
    run.status = 'waiting_user';
    run.error = qcPauseReason(run);
    delete run.endedAt;
  }
  if (run.status !== 'cancelled' && !qcBlocked && run.steps.length > 0 && run.steps.every(s => s.status === 'done' || s.status === 'skipped')) {
    run.status = 'done';
    run.currentStep = run.totalSteps;
    run.endedAt ??= now;
  }
  if (patch.status === 'done' && run.steps.some(s => s.status !== 'done' && s.status !== 'skipped')) {
    throw new Error('仍有未完成步骤，不能把整个流程标记为 done');
  }
  if (run.status === 'done' && !run.reportPath) {
    const reportPath = `${safeDir}/results/run-summary.md`;
    try {
      await exec(`mkdir -p ${shq(`${safeDir}/results`)} && ${atomicTextCommand(reportPath, buildWorkflowRunSummary(run))}`, options.writeTimeoutMs ?? 20_000);
      run.reportPath = reportPath;
    } catch {
      // 报告生成失败不能反向抹掉已经验证完成的流程；运行记录仍会正常落盘。
    }
  }
  run.updatedAt = now;
  run.heartbeatAt = now;
  run.revision = (run.revision || 0) + 1;
  await writeWorkflowRun(exec, home, run, options.writeTimeoutMs ?? 20_000);
  return run;
  });
}
