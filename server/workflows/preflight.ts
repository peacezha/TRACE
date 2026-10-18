// 流程预检服务：通过 SSH 在集群上核查流程的必要软件与参考数据是否就绪。
// 所有检查命令均为只读。module load 仅在隔离子 shell 中验证可加载性，不修改登录环境、不安装。
// 目录约定：~/trace_flows/<slug>/{01_software,02_reference,03_workspace,04_results}
import type { Workflow } from './workflowTypes';
import { createHash } from 'node:crypto';
import type {
  FlowManifest,
  PreflightItemResult,
  PreflightResult,
  ReferenceItem,
  SoftwareItem,
} from '../../shared/flowManifest';
import { workflowSlug } from '../../shared/flowManifest';

export type ExecFn = (cmd: string, timeout?: number) => Promise<string>;

/** 单项校验过滤器：按 name 指定只检查哪些项 */
export interface PreflightFilter {
  software?: string[];
  references?: string[];
}

export function workflowPreflightFingerprint(workflow: Workflow): string {
  return createHash('sha256').update(JSON.stringify({
    workflowId: workflow.id,
    workflowVersion: workflow.updatedAt,
    manifest: workflow.manifest ?? { software: [], references: [], qcGates: [] },
  })).digest('hex');
}

/** shell 单引号转义 */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 路径里带 {{参数}} 占位：无法自动检查，需运行时由用户指定 */
function isPlaceholderPath(p: string): boolean {
  return /\{\{[^}]+\}\}/.test(p);
}

/** shell 路径引用：~ 开头的路径展开为 "$HOME/..."（单引号内 ~ 不展开，会导致检查永远失败） */
function shqPath(p: string): string {
  if (p.startsWith('~/')) return `"$HOME/${p.slice(2).replace(/"/g, '')}"`;
  return shq(p);
}

const MODULE_INIT = [
  'if ! type module >/dev/null 2>&1; then',
  '  for trace_module_init in /etc/profile.d/modules.sh /etc/profile.d/lmod.sh /usr/share/Modules/init/bash /usr/share/lmod/lmod/init/bash; do',
  '    if [ -r "$trace_module_init" ]; then . "$trace_module_init" >/dev/null 2>&1; type module >/dev/null 2>&1 && break; fi',
  '  done',
  'fi',
  'if type module >/dev/null 2>&1; then echo "MODULESYS|ready|Module/Lmod 已初始化"; else echo "MODULESYS|unavailable|非交互 SSH 未找到 module 命令"; fi',
].join('\n');

function executableCandidates(name: string): string[] {
  const aliases: Record<string, string[]> = {
    'blast+': ['blastn', 'blastp'],
    fastqc: ['fastqc'],
    samtools: ['samtools'],
    bcftools: ['bcftools'],
    bedtools: ['bedtools'],
    trimmomatic: ['trimmomatic'],
    trim_galore: ['trim_galore'],
    humann: ['humann'],
    metaphlan: ['metaphlan'],
    r: ['R'],
  };
  const lower = name.trim().toLowerCase();
  const generic = lower.replace(/[^a-z0-9._+-]+/g, '').replace(/\+$/, '');
  return [...new Set([...(aliases[lower] ?? []), name.trim(), lower, generic].filter(Boolean))].slice(0, 6);
}

function moduleCheckBody(item: SoftwareItem, idx: number, requestedModule: string): string {
  const tag = `ITEM|sw|${idx}`;
  const base = requestedModule.split('/')[0] || item.name;
  const exactVersion = requestedModule.includes('/');
  const prerequisites = item.prerequisiteModules ?? [];
  const prerequisiteLoad = prerequisites.length > 0
    ? [
      `  for prerequisite_module in ${prerequisites.map(shq).join(' ')}; do`,
      '    module load "$prerequisite_module" >/dev/null 2>&1; prerequisite_rc=$?',
      '    if [ $prerequisite_rc -ne 0 ]; then prerequisite_failed="$prerequisite_module"; break; fi',
      '  done',
    ]
    : [];
  const versionProbe = item.versionCmd
    ? `version_out=$( ( ${item.versionCmd} ) 2>&1 ); version_rc=$?; version_first=$(printf '%s\\n' "$version_out" | head -1); ` +
      `if [ $version_rc -ne 0 ]; then echo "${tag}|0|module 可加载: $loaded_module，但版本检查失败: $version_first"; ` +
      `else echo "${tag}|1|module 可加载: $loaded_module; $version_first"; fi`
    : `echo "${tag}|1|module 可加载: $loaded_module"`;
  // 无 module 系统的直装回退：在 PATH 里按常见可执行名直接探测，装过（conda/pip 直装）即算就绪
  const directCandidates = executableCandidates(item.name).map(shq).join(' ');
  const directFallback = [
    'elif ! type module >/dev/null 2>&1; then',
    `  direct_found=""; for trace_tool in ${directCandidates}; do`,
    '    if command -v "$trace_tool" >/dev/null 2>&1; then direct_found=$(command -v "$trace_tool"); break; fi; done',
    `  if [ -n "$direct_found" ]; then echo "${tag}|1|无 module，直装可用: $direct_found"; `,
    `  else echo "${tag}|0|无 module 系统且 PATH 未找到: ${base}（需要直接安装，不走 module）"; fi`,
  ].join('\n');
  return [
    `requested_module=${shq(requestedModule)}`,
    `module_base=${shq(base)}`,
    'loaded_module="$requested_module"',
    'candidate=""',
    'avail_out=""',
    'load_rc=1',
    'prerequisite_failed=""',
    'if type module >/dev/null 2>&1; then',
    ...prerequisiteLoad,
    '  if [ -z "$prerequisite_failed" ]; then module load "$loaded_module" >/dev/null 2>&1; load_rc=$?; fi',
    '  if [ $load_rc -ne 0 ]; then',
    '    module_base_lower=$(printf "%s" "$module_base" | tr "[:upper:]" "[:lower:]")',
    '    avail_out=$( { module -t avail "$module_base"; [ "$module_base_lower" = "$module_base" ] || module -t avail "$module_base_lower"; } 2>&1 | sed -E "s/\\x1B\\[[0-9;]*[[:alpha:]]//g")',
    '    candidate=$(printf "%s\\n" "$avail_out" | grep -iF "$module_base" | grep -vE "^(Where:|If the avail|No module|[-[:space:]]*$)" | head -1 | awk "{print \\$1}" | sed -E "s/\\((default|D)\\)//g")',
    '    if [ -n "$candidate" ]; then',
    '      requested_lower=$(printf "%s" "$requested_module" | tr "[:upper:]" "[:lower:]")',
    '      candidate_lower=$(printf "%s" "$candidate" | tr "[:upper:]" "[:lower:]")',
    `      if ${exactVersion ? '[ "$requested_lower" = "$candidate_lower" ]' : 'true'}; then`,
    '        loaded_module="$candidate"',
    '        module load "$loaded_module" >/dev/null 2>&1; load_rc=$?',
    '      fi',
    '    fi',
    '  fi',
    'fi',
    `if [ $load_rc -eq 0 ]; then ${versionProbe}; ` +
      directFallback +
      ` elif [ -n "$prerequisite_failed" ]; then echo "${tag}|0|前置 module 加载失败: $prerequisite_failed"; ` +
      `elif [ -n "$candidate" ]; then echo "${tag}|0|找到 module 候选 $candidate，但无法加载要求的 $requested_module${exactVersion ? '（可能版本不匹配或缺少前置模块）' : '（可能缺少前置模块）'}"; ` +
      `else spider_out=$(module spider "$module_base" 2>&1 | head -12); ` +
      `if printf '%s' "$spider_out" | grep -qiF "$module_base"; then echo "${tag}|0|module spider 找到 $module_base，但当前层级不可直接加载（请查看前置模块）"; ` +
      `else echo "${tag}|0|module avail/spider 均未找到: $module_base"; fi; fi`,
  ].join('\n');
}

function softwareCheckScript(item: SoftwareItem, idx: number): string {
  const tag = `ITEM|sw|${idx}`;
  if (item.checkCmd) {
    return `( out=$( ( ${item.checkCmd} ) 2>&1 ); rc=$?; first=$(echo "$out" | head -1); ` +
      `if [ $rc -eq 0 ]; then echo "${tag}|1|$first"; else echo "${tag}|0|check failed: $first"; fi )`;
  }
  if (item.module) return `( ${moduleCheckBody(item, idx, item.module)} )`;

  const candidates = executableCandidates(item.name);
  const commandArgs = candidates.map(shq).join(' ');
  return `( found_command=""; for trace_tool in ${commandArgs}; do ` +
    `if command -v "$trace_tool" >/dev/null 2>&1; then found_command=$(command -v "$trace_tool"); break; fi; done; ` +
    `if [ -n "$found_command" ]; then echo "${tag}|1|命令可用: $found_command"; else ` +
    `${moduleCheckBody(item, idx, item.name)}; fi )`;
}

function referenceCheckScript(item: ReferenceItem, idx: number): string {
  const tag = `ITEM|ref|${idx}`;
  if (isPlaceholderPath(item.path)) {
    return `echo "${tag}|0|待用户指定路径（运行时参数）"`;
  }
  if (item.checkCmd) {
    return `out=$( ( ${item.checkCmd} ) 2>&1 ); rc=$?; first=$(echo "$out" | head -1); ` +
      `if [ $rc -eq 0 ]; then echo "${tag}|1|$first"; else echo "${tag}|0|check failed: $first"; fi`;
  }
  return `if [ -e ${shqPath(item.path)} ]; then sz=$(du -sh ${shqPath(item.path)} 2>/dev/null | cut -f1); ` +
    `echo "${tag}|1|存在（${item.path}，$sz）"; else echo "${tag}|0|不存在: ${item.path}"; fi`;
}

/** 把 JSON 经 base64 写到集群文件（避免 heredoc 引号问题） */
function writeJsonScript(remotePath: string, value: unknown): string {
  const b64 = Buffer.from(JSON.stringify(value, null, 2), 'utf-8').toString('base64');
  // 注意：~ 在单引号内不展开，会写到字面量 "~" 目录导致缓存静默丢失；
  // 统一展开为 "$HOME/..." 再用双引号包住
  const target = remotePath.startsWith('~/') ? `"$HOME/${remotePath.slice(2)}"` : shq(remotePath);
  return `echo ${shq(b64)} | base64 -d > ${target} 2>/dev/null || true`;
}

const SCHED_DETECT =
  'if command -v bsub >/dev/null 2>&1; then echo "SCHED|lsf"; ' +
  'elif command -v sbatch >/dev/null 2>&1; then echo "SCHED|slurm"; ' +
  'elif command -v qsub >/dev/null 2>&1; then echo "SCHED|pbs"; ' +
  'elif command -v dsub >/dev/null 2>&1; then echo "SCHED|donau"; ' +
  'else echo "SCHED|none"; fi';

interface ParsedChecks {
  scheduler?: PreflightResult['scheduler'];
  moduleSystem?: PreflightResult['moduleSystem'];
  moduleSystemDetail?: string;
  sw: Map<number, PreflightItemResult>;
  ref: Map<number, PreflightItemResult>;
}

/** 解析组合检查命令输出中的 ITEM/SCHED 行 */
function parseItemLines(raw: string, manifest: FlowManifest): ParsedChecks {
  const out: ParsedChecks = { sw: new Map(), ref: new Map() };
  for (const line of raw.split(/\r?\n/)) {
    const cols = line.split('|');
    if (cols[0] === 'MODULESYS' && cols[1]) {
      out.moduleSystem = (['ready', 'unavailable', 'unknown'].includes(cols[1]) ? cols[1] : 'unknown') as PreflightResult['moduleSystem'];
      out.moduleSystemDetail = cols.slice(2).join('|').trim() || undefined;
      continue;
    }
    if (cols[0] === 'SCHED' && cols[1]) {
      out.scheduler = (['lsf', 'slurm', 'pbs', 'donau', 'none'].includes(cols[1]) ? cols[1] : 'unknown') as PreflightResult['scheduler'];
      continue;
    }
    if (cols[0] !== 'ITEM' || cols.length < 4) continue;
    const idx = Number(cols[2]);
    if (!Number.isInteger(idx)) continue;
    if (cols[1] === 'sw' && manifest.software[idx]) {
      out.sw.set(idx, {
        name: manifest.software[idx].name,
        ok: cols[3] === '1',
        required: manifest.software[idx].required,
        detail: cols.slice(4).join('|').trim() || undefined,
      });
    }
    if (cols[1] === 'ref' && manifest.references[idx]) {
      out.ref.set(idx, {
        name: manifest.references[idx].name,
        ok: cols[3] === '1',
        required: manifest.references[idx].required,
        detail: cols.slice(4).join('|').trim() || undefined,
      });
    }
  }
  return out;
}

function emptyResult(workflow: Workflow, manifest: FlowManifest): PreflightResult {
  return {
    workflowId: workflow.id,
    workflowVersion: workflow.updatedAt,
    manifestHash: workflowPreflightFingerprint(workflow),
    checkedAt: Date.now(),
    scheduler: 'unknown',
    moduleSystem: 'unknown',
    software: manifest.software.map(item => ({ name: item.name, ok: false, required: item.required, detail: '未检查' })),
    references: manifest.references.map(item => ({ name: item.name, ok: false, required: item.required, detail: '未检查' })),
    ready: false,
  };
}

function finalizeReady(result: PreflightResult): void {
  result.ready = [...result.software, ...result.references].every(item => item.ok || !item.required);
}

/**
 * 执行预检：
 * 1. 幂等创建流程四板块目录；2. 同步 flow.json / manifest.json；
 * 3. 一条组合命令完成调度器探测 + 全部软件/参考数据检查；
 * 4. 解析结果并写回 env-check.json / ref-check.json。
 *
 * 传入 filter 时只检查指定项，并与集群缓存的上次结果合并后回写（单项"校验"按钮）。
 * options.persist === false 时不写 flow.json/manifest.json，也不回写 env-check 缓存——
 * 供"启动前整体检查"按本次运行配置解析占位符后临时核查，避免把运行级解析结果污染集群缓存。
 */
export async function runPreflight(
  exec: ExecFn,
  workflow: Workflow,
  filter?: PreflightFilter,
  options?: { persist?: boolean },
): Promise<PreflightResult> {
  const persist = options?.persist !== false;
  const slug = workflowSlug(workflow.name);
  const home = `~/trace_flows/${slug}`;
  const rawManifest: FlowManifest = workflow.manifest ?? { software: [], references: [], qcGates: [] };
  // {{FLOW_HOME}} 模板变量：参考数据可声明位于流程家目录内的路径（如随包分发的管线代码）
  const manifest: FlowManifest = {
    ...rawManifest,
    references: rawManifest.references.map(r => ({
      ...r,
      path: r.path.replace(/\{\{FLOW_HOME\}\}/g, home),
      checkCmd: r.checkCmd?.replace(/\{\{FLOW_HOME\}\}/g, home),
    })),
  };

  // 有 filter 时未指定的类别不检查；无 filter 时全部检查
  const swIdx = filter
    ? (filter.software ? manifest.software.map((s, i) => i).filter(i => filter.software!.includes(manifest.software[i].name)) : [])
    : manifest.software.map((_, i) => i);
  const refIdx = filter
    ? (filter.references ? manifest.references.map((r, i) => i).filter(i => filter.references!.includes(manifest.references[i].name)) : [])
    : manifest.references.map((_, i) => i);

  const parts: string[] = [];
  // 目录创建与清单同步总是执行（单项校验也要靠 env-check.json 缓存做合并，
  // 否则第一次单项校验的结果写不进集群，下一项校验时前一项会"回退"成未通过）；
  // persist=false（启动前整体检查的临时核查）只建目录，不同步清单。
  parts.push(`mkdir -p ${home}/01_software ${home}/02_reference ${home}/03_workspace/runs ${home}/04_results`);
  if (persist) {
    parts.push(writeJsonScript(`${home}/flow.json`, {
      workflowId: workflow.id,
      name: workflow.name,
      description: workflow.description,
      manifest,
      syncedAt: Date.now(),
    }));
    parts.push(writeJsonScript(`${home}/01_software/manifest.json`, manifest.software));
    parts.push(writeJsonScript(`${home}/02_reference/manifest.json`, manifest.references));
  }

  parts.push(MODULE_INIT);
  parts.push(SCHED_DETECT);
  swIdx.forEach(i => parts.push(softwareCheckScript(manifest.software[i], i)));
  refIdx.forEach(i => parts.push(referenceCheckScript(manifest.references[i], i)));

  const raw = await exec(parts.join('\n'), 120_000);
  const checks = parseItemLines(raw, manifest);

  let result: PreflightResult;
  if (!filter) {
    result = emptyResult(workflow, manifest);
  } else {
    // 单项校验：以上次缓存为基底做合并
    result = (await readCachedPreflight(exec, workflow)) ?? emptyResult(workflow, manifest);
    result.workflowId = workflow.id;
    result.workflowVersion = workflow.updatedAt;
    result.manifestHash = workflowPreflightFingerprint(workflow);
  }
  checks.sw.forEach((v, i) => { result.software[i] = v; });
  checks.ref.forEach((v, i) => { result.references[i] = v; });
  if (checks.scheduler) result.scheduler = checks.scheduler;
  if (checks.moduleSystem) result.moduleSystem = checks.moduleSystem;
  if (checks.moduleSystemDetail) result.moduleSystemDetail = checks.moduleSystemDetail;
  result.checkedAt = Date.now();
  finalizeReady(result);

  // 结果回写集群（全量进 env-check.json，参考数据部分进 ref-check.json）；
  // persist=false 的临时核查不回写，避免运行级占位符解析结果污染集群缓存。
  if (persist) {
    await exec(
      writeJsonScript(`${home}/01_software/env-check.json`, result) + '\n' +
      writeJsonScript(`${home}/02_reference/ref-check.json`, {
        workflowId: result.workflowId,
        checkedAt: result.checkedAt,
        references: result.references,
      }),
      20_000,
    ).catch(() => { /* 回写失败不影响返回结果 */ });
  }

  return result;
}

/** 解析预检组合命令的输出（独立导出便于测试） */
export function parsePreflightOutput(raw: string, workflow: Workflow, manifest: FlowManifest): PreflightResult {
  const result = emptyResult(workflow, manifest);
  const checks = parseItemLines(raw, manifest);
  checks.sw.forEach((v, i) => { result.software[i] = v; });
  checks.ref.forEach((v, i) => { result.references[i] = v; });
  if (checks.scheduler) result.scheduler = checks.scheduler;
  if (checks.moduleSystem) result.moduleSystem = checks.moduleSystem;
  if (checks.moduleSystemDetail) result.moduleSystemDetail = checks.moduleSystemDetail;
  finalizeReady(result);
  return result;
}

/** 读取集群上缓存的上次预检结果；从未预检返回 null */
export async function readCachedPreflight(exec: ExecFn, workflow: Workflow): Promise<PreflightResult | null> {
  const slug = workflowSlug(workflow.name);
  try {
    const raw = await exec(`cat ~/trace_flows/${slug}/01_software/env-check.json 2>/dev/null || true`, 15_000);
    const text = raw.trim();
    if (!text) return null;
    const parsed = JSON.parse(text) as PreflightResult;
    if (!parsed || typeof parsed.checkedAt !== 'number') return null;
    if (parsed.workflowId !== workflow.id
      || parsed.workflowVersion !== workflow.updatedAt
      || parsed.manifestHash !== workflowPreflightFingerprint(workflow)) return null;
    return parsed;
  } catch {
    return null;
  }
}
