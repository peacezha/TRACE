// 流程存储：JSON 文件持久化（userData），首次启动写入内置示例流程。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { appPath, dataPath } from '../paths';
import { WORKFLOW_CATEGORIES } from '../../shared/workflow';
import { currentProductText, currentProvider } from '../../shared/branding';
import { classifyWorkflowCatalog, isPendingDisposal } from '../../shared/workflowCatalog';
import { BIOSKILLS_IMPORTER_VERSION, generateBioskillsWorkflows } from './bioskillsSeed';
import { buildEnvCheckCommand } from './envCheckScript';
import { buildOfficialEncodeWorkflows } from './encodeOfficialWorkflows';
import { addChromatinWorkflowVariants } from './chromatinWorkflowVariants';
import type { Workflow, WorkflowStep } from './workflowTypes';

const STORE_PATH = dataPath('workflows', 'workflows.json');
const SEED_MARKER_PATH = dataPath('workflows', '.bioskills-seed-version');
/**
 * 用户删除过的内置种子 id 清单（独立于 workflows.json 的小文件，
 * 保持 workflows.json 仍是纯 Workflow[] 数组格式）。load/merge 时跳过这些种子，
 * 避免删除的内置流程在下次启动时“复活”。
 */
const DELETED_SEEDS_PATH = dataPath('workflows', 'deleted-builtin-seeds.json');
const CATALOGUE_CLEANUP_PATH = dataPath('workflows', '.catalogue-cleanup-v0.5.16.json');
export const REQUESTED_KEEP_IDS = new Set(['bioskills-atacseq-pipeline', 'bioskills-chipseq-pipeline']);
export const REQUESTED_REMOVE_IDS = new Set(['bioskills-hic-pipeline', 'bioskills-clip-pipeline', 'bioskills-causal-genomics-pipeline', 'bioskills-crispr-editing-pipeline', 'encode-rampage']);
let requestedCleanupEnabled = false;
export function enableRequestedCatalogueCleanup(): void { requestedCleanupEnabled = true; }
/** bioSkills 种子版本：提取规则变化时递增，触发老库重新生成 */
const BIOSKILLS_SEED_VERSION = BIOSKILLS_IMPORTER_VERSION;
/** 旧版曾入库、现已由无 blacklist 的中英文原生流程取代的系统种子。 */

const [
  CATEGORY_GENOMICS,
  CATEGORY_TRANSCRIPTOME,
  CATEGORY_SINGLE_CELL,
  CATEGORY_PROTEOM_METAB,
  CATEGORY_MICROBE,
  CATEGORY_CRISPR,
  CATEGORY_OPS,
] = WORKFLOW_CATEGORIES;

/**
 * 内置流程（硬编码流程 + BioSkills 种子）的分类映射。
 * 硬编码种子对象与 workflows/workflows.json 都不存 category（保持二者对齐）：
 * 内置流程的 category 由 loadWorkflows 在读取时按此表派生（applyDerivedCategories，不落盘）；
 * BioSkills 生成器（generateBioskillsWorkflows 的 categories 参数）则在新行入库时注入。
 * v4 按用户清单恢复 ATAC/ChIP，移除 causal-genomics/CRISPR editing；
 * rnaseq-to-de/hic/clip/smrna 继续不生成（BIOSKILLS_RETIRED）。
 */
export const BUILTIN_CATEGORIES: Record<string, string> = {
  // 基因组与变异分析
  'bioskills-cnv-pipeline': CATEGORY_GENOMICS,
  'bioskills-fastq-to-variants': CATEGORY_GENOMICS,
  'bioskills-genome-annotation-pipeline': CATEGORY_GENOMICS,
  'bioskills-genome-assembly-pipeline': CATEGORY_GENOMICS,
  'bioskills-gwas-pipeline': CATEGORY_GENOMICS,
  'bioskills-longread-sv-pipeline': CATEGORY_GENOMICS,
  'bioskills-somatic-variant-pipeline': CATEGORY_GENOMICS,
  'bioskills-liquid-biopsy-pipeline': CATEGORY_GENOMICS,
  // 转录组与表观调控
  'builtin-rnaseq-qc-align': CATEGORY_TRANSCRIPTOME,
  'encode-chipseq-tf': CATEGORY_TRANSCRIPTOME,
  'encode-chipseq-tf-dag': CATEGORY_TRANSCRIPTOME,
  'builtin-dapseq-tf': CATEGORY_TRANSCRIPTOME,
  'builtin-dapseq-tf-en': CATEGORY_TRANSCRIPTOME,
  'encode-chipseq-histone': CATEGORY_TRANSCRIPTOME,
  'encode-chipseq-tf-en': CATEGORY_TRANSCRIPTOME,
  'encode-chipseq-histone-en': CATEGORY_TRANSCRIPTOME,
  'encode-rnaseq-bulk': CATEGORY_TRANSCRIPTOME,
  'encode-atacseq': CATEGORY_TRANSCRIPTOME,
  'encode-atacseq-en': CATEGORY_TRANSCRIPTOME,
  'encode-dnaseseq': CATEGORY_TRANSCRIPTOME,
  'encode-wgbs': CATEGORY_TRANSCRIPTOME,
  'encode-hic': CATEGORY_TRANSCRIPTOME,
  'encode-chiapet': CATEGORY_TRANSCRIPTOME,
  'encode-mirnaseq': CATEGORY_TRANSCRIPTOME,
  'encode-eclip': CATEGORY_TRANSCRIPTOME,
  'encode-longread-rnaseq': CATEGORY_TRANSCRIPTOME,
  'bioskills-expression-to-pathways': CATEGORY_TRANSCRIPTOME,
  'bioskills-atacseq-pipeline': CATEGORY_TRANSCRIPTOME,
  'bioskills-chipseq-pipeline': CATEGORY_TRANSCRIPTOME,
  'bioskills-grn-pipeline': CATEGORY_TRANSCRIPTOME,
  'bioskills-merip-pipeline': CATEGORY_TRANSCRIPTOME,
  'bioskills-methylation-pipeline': CATEGORY_TRANSCRIPTOME,
  'bioskills-riboseq-pipeline': CATEGORY_TRANSCRIPTOME,
  'bioskills-spatial-pipeline': CATEGORY_TRANSCRIPTOME,
  'bioskills-splicing-pipeline': CATEGORY_TRANSCRIPTOME,
  'bioskills-timecourse-pipeline': CATEGORY_TRANSCRIPTOME,
  // 单细胞与免疫分析
  'bioskills-multiome-pipeline': CATEGORY_SINGLE_CELL,
  'bioskills-scrnaseq-pipeline': CATEGORY_SINGLE_CELL,
  'bioskills-tcr-pipeline': CATEGORY_SINGLE_CELL,
  'bioskills-cytometry-pipeline': CATEGORY_SINGLE_CELL,
  'bioskills-imc-pipeline': CATEGORY_SINGLE_CELL,
  'bioskills-neoantigen-pipeline': CATEGORY_SINGLE_CELL,
  // 蛋白代谢与多组学
  'bioskills-proteomics-pipeline': CATEGORY_PROTEOM_METAB,
  'bioskills-metabolomics-pipeline': CATEGORY_PROTEOM_METAB,
  'bioskills-metabolic-modeling-pipeline': CATEGORY_PROTEOM_METAB,
  'bioskills-multi-omics-pipeline': CATEGORY_PROTEOM_METAB,
  'bioskills-biomarker-pipeline': CATEGORY_PROTEOM_METAB,
  'bioskills-clinical-trial-pipeline': CATEGORY_PROTEOM_METAB,
  // 微生物与病原分析
  'bioskills-metagenomics-pipeline': CATEGORY_MICROBE,
  'bioskills-microbiome-pipeline': CATEGORY_MICROBE,
  'bioskills-edna-pipeline': CATEGORY_MICROBE,
  'bioskills-outbreak-pipeline': CATEGORY_MICROBE,
  // 基因编辑与 CRISPR
  'builtin-hidog-vector-trace': CATEGORY_CRISPR,
  'builtin-hidog-amplicon': CATEGORY_CRISPR,
  'bioskills-crispr-screen-pipeline': CATEGORY_CRISPR,
  // 任务管理与通用工具
  'builtin-job-troubleshoot': CATEGORY_OPS,
  'builtin-disk-cleanup': CATEGORY_OPS,
  'builtin-blast': CATEGORY_OPS,
};

/** 读取用户删除过的内置种子 id（文件缺失/损坏时视为空）。 */
async function loadDeletedBuiltinSeeds(): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await fs.readFile(DELETED_SEEDS_PATH, 'utf-8'));
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map(item => String(item)).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** 记录一个被用户删除的内置种子 id（原子写入，去重）。 */
async function rememberDeletedBuiltinSeed(id: string): Promise<void> {
  const deleted = await loadDeletedBuiltinSeeds();
  if (deleted.has(id)) return;
  deleted.add(id);
  await fs.mkdir(path.dirname(DELETED_SEEDS_PATH), { recursive: true });
  const tmp = `${DELETED_SEEDS_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify([...deleted], null, 2), 'utf-8');
  await fs.rename(tmp, DELETED_SEEDS_PATH);
}

/**
 * ENCODE TF ChIP-seq 官方结构版（分支 DAG · 原生直接文件参数，不要 genome TSV/Caper）。
 * 与线性版同参数同命令体系，但按官方依赖关系组织：峰调用只依赖过滤去重（不依赖
 * 链相关 QC），链相关/信号轨迹/峰+IDR 三条支路并行，报告汇聚所有 QC。
 * 步骤数组顺序仍是合法拓扑序，执行器按序推进与依赖门禁天然兼容。
 */
function buildChipseqTfDagVariant(linear: Workflow, now: number): Workflow {
  const L = linear.steps;
  const command = (action: string) => `#BSUB -J chipseq_${action} -n {{THREADS}} -q {{QUEUE}}
set -euo pipefail
module load SAMtools/1.17 MACS2/2.2.7.1
${action === 'idr' ? 'module load IDR/2.0.4.2\n' : ''}python3 <FLOW>/01_software/tools/chipseq_dag.py ${action} --input-dir "{{INPUT_DIR}}" --control-dir "{{CONTROL_DIR}}" --genome-size "{{GENOME_SIZE}}" --threads {{THREADS}}`;
  const steps: WorkflowStep[] = [
    { ...L[0], id: 'preflight', dependsOn: [], phase: 'Prepare', command: L[0].command + '\ncommand -v python3\ncommand -v idr\ntest -s <FLOW>/01_software/tools/chipseq_dag.py' },
    { ...L[1], id: 'fastqc', dependsOn: ['preflight'], phase: 'Prepare' },
    { ...L[2], id: 'align', dependsOn: ['fastqc'], phase: 'Alignment' },
    { ...L[3], id: 'filter-dedup', dependsOn: ['align'], phase: 'Alignment', command: L[3].command.replace(/\bsamtools index(?!\s+-c)\b/g, 'samtools index -c') },
    { ...L[4], id: 'xcor', dependsOn: ['filter-dedup'], phase: 'QC' },
    { ...L[5], id: 'rep-peaks', dependsOn: ['filter-dedup'], phase: 'Peak Calling', command: command('peaks') },
    {
      id: 'pseudorep-peaks', title: '互补自伪重复与池化伪重复峰调用',
      dependsOn: ['filter-dedup'], phase: 'Pseudoreplicates', command: command('pseudoreplicates'),
      notes: '按模板名与 read group 哈希分成互补且不重叠的两份，保留双端配对；分别合并各重复的 pr1 和 pr2，所有峰采用 BAMPE 模式。仅处理同一靶标、同一条件的生物学重复。',
    },
    { ...L[6], id: 'signals-spot', dependsOn: ['rep-peaks'], phase: 'QC' },
    {
      ...L[7], id: 'idr-frip', title: '三路 IDR 可重复性评估',
      dependsOn: ['rep-peaks', 'pseudorep-peaks'], phase: 'IDR', command: command('idr'),
      notes: '全局 IDR 使用第 12 列的 -log10 分数；评估真重复、自伪重复和池化伪重复，同时输出 rescue ratio 与 self-consistency ratio。缺失、零峰或仅单重复不能标记为通过。',
    },
    { ...L[8], id: 'report', dependsOn: ['xcor', 'signals-spot', 'idr-frip'], phase: 'Report' },
  ];
  const manifest = linear.manifest ? structuredClone(linear.manifest) : undefined;
  if (manifest) {
    manifest.inputHint = '同一转录因子与条件的双端 ChIP-seq 生物学重复目录，以及一个处理完成的 matched Input 对照 BAM 目录';
    manifest.qcGates = manifest.qcGates.map(gate => ({ ...gate, afterStep: gate.afterStep >= 7 ? gate.afterStep + 1 : gate.afterStep }));
    manifest.qcGates.push({ afterStep: 9, metric: '三路 IDR 可重复性', pass: 'rescue ratio 与 self-consistency ratio 均≤2，且峰数非零', warn: '任一比值>2 或不可计算时不建议继续下游分析' });
  }
  return {
    ...linear, id: 'encode-chipseq-tf-dag', name: 'ENCODE TF ChIP-seq 官方结构流程（分支 DAG）',
    description: '参照 ENCODE 依赖结构的原生双端 TF ChIP-seq 流程：链交叉相关性、真重复峰与互补伪重复分支，三路 IDR 与信号质控汇入报告。使用直接文件参数；这是 TRACE 扩展实现，不是官方 WDL。',
    keywords: [...linear.keywords, '官方结构', 'dag', '分支', 'pseudoreplicate', '三路idr'],
    params: linear.params.map(param => param.name === 'CONTROL_DIR' ? { ...param, required: true } : param),
    manifest, assets: [...(linear.assets || []), { source: 'encode/chipseq_dag.py', remotePath: 'tools/chipseq_dag.py', label: 'TF ChIP-seq DAG reproducibility helper' }],
    provenance: { ...linear.provenance, importerVersion: 'chipseq-dag-v2' },
    steps, createdAt: now, updatedAt: now,
  };
}

/** Retired templates are internal construction inputs for the canonical DAG;
 * they are never returned to the live catalogue. Tests may inspect them. */
export function builtinWorkflows(includeRetired = false): Workflow[] {
  const now = Date.now();
  const workflows: Workflow[] = [
    {
      id: 'builtin-hidog-vector-trace',
      name: 'HiDOG V11 载体追踪（vector-trace）',
      description: '按 HiDOG V11 原生参数执行 pooled-vector sgRNA 追踪；自动校验二选一参考、生成 Excel/TSV，并输出确定性 QC 报告。',
      keywords: ['hidog', 'vector-trace', '载体追踪', 'sgRNA', 'spacer', 'pooled', '文库', 'guide', 'crispr screen'],
      params: [
        { name: 'READ1', label: 'R1 FASTQ（.fastq/.fq，可 gzip）', type: 'path', help: '集群上的完整文件路径' },
        { name: 'READ2', label: 'R2 FASTQ（.fastq/.fq，可 gzip）', type: 'path', help: '必须与 R1 成对' },
        { name: 'BARCODE', label: 'barcode 表（sample_id barcode_R1 barcode_R2）', type: 'path' },
        { name: 'ANCHOR', label: 'spacer 邻接的载体恒定序列', type: 'text', pattern: '[ACGTNacgtn]+' },
        { name: 'SPACER_REF', label: 'spacer FASTA/文本（不用填 NONE）', defaultValue: 'NONE', type: 'path', required: false, help: '与 guide manifest 必须且只能使用一个；推荐使用本项' },
        { name: 'GUIDE_MANIFEST', label: '旧版 guide manifest TSV（不用填 NONE）', defaultValue: 'NONE', type: 'path', required: false, help: '兼容输入：vector_id、guide_id、spacer_seq、gene_name、reference_group' },
      ],
      steps: [
        { title: '校验已部署的 HiDOG V11', command: 'test -s <FLOW>/01_software/hidog/hidogV11.py\ntest -s <FLOW>/01_software/hidog/hidogV11_packages.py\ntest -s <FLOW>/01_software/hidog/hidogV11_vector_trace.py\ntest -s <FLOW>/01_software/hidog/hidogV11_trace_runner.py\ntest -s <FLOW>/01_software/hidog/hidogV11_trace_report.py\npython3 <FLOW>/01_software/hidog/hidogV11.py --version\npython3 <FLOW>/01_software/hidog/hidogV11.py vector-trace --help >/dev/null', notes: '运行面板会自动部署 5 个文件；本步骤只做版本与完整性校验' },
        { title: '检查 vector-trace 最小环境', command: 'python3 -c "import sys; assert sys.version_info >= (3, 8); import openpyxl; print(sys.version.split()[0], openpyxl.__version__)"', notes: 'vector-trace 不调用 BWA、SAMtools 或 pysam；只要求 Python 3.8+ 与 openpyxl' },
        { title: '运行 HiDOG V11 vector-trace', command: 'python3 <FLOW>/01_software/hidog/hidogV11_trace_runner.py --hidog <FLOW>/01_software/hidog/hidogV11.py --run-dir <RUN> vector-trace \\\n  --read1 "{{READ1}}" --read2 "{{READ2}}" --barcode "{{BARCODE}}" \\\n  --anchor "{{ANCHOR}}" --spacer-ref "{{SPACER_REF}}" --guide-manifest "{{GUIDE_MANIFEST}}" \\\n  --anchor-read "{{ANCHOR_READ}}" --anchor-max-mismatches "{{ANCHOR_MAX_MISMATCHES}}" \\\n  --spacer-side "{{SPACER_SIDE}}" --spacer-length "{{SPACER_LENGTH}}" \\\n  --barcode-spacer-length "{{BARCODE_SPACER_LENGTH}}" --barcode-length "{{BARCODE_LENGTH}}" \\\n  --barcode-q30 "{{BARCODE_Q30}}" --min-guide-fraction "{{MIN_GUIDE_FRACTION}}" \\\n  --min-sample-anchor-reads "{{MIN_SAMPLE_ANCHOR_READS}}" \\\n  --allow-reverse-complement "{{ALLOW_REVERSE_COMPLEMENT}}" --allow-unique-1mm "{{ALLOW_UNIQUE_1MM}}"', notes: '命令由随包启动器按 argv 数组构造，不再让 AI 临时改写；输出固定在本次运行的 results/vt_results', params: [
          { name: 'ANCHOR_READ', label: '锚定序列所在 read（--anchor-read）', defaultValue: 'r1', type: 'select', options: ['r1', 'r2'] },
          { name: 'SPACER_SIDE', label: 'spacer 相对锚点位置（--spacer-side）', defaultValue: 'after', type: 'select', options: ['before', 'after'] },
          { name: 'SPACER_LENGTH', label: 'spacer 长度（--spacer-length）', defaultValue: '20', type: 'number', required: false },
          { name: 'ANCHOR_MAX_MISMATCHES', label: '锚点最大错配（V11 默认 0）', defaultValue: '0', type: 'number', min: 0, max: 10, required: false },
          { name: 'BARCODE_SPACER_LENGTH', label: 'barcode 前 spacer 长度', defaultValue: '4', type: 'number', min: 0, required: false },
          { name: 'BARCODE_LENGTH', label: 'barcode 长度', defaultValue: '4', type: 'number', min: 1, required: false },
          { name: 'BARCODE_Q30', label: 'barcode Q30 阈值（--barcode-q30）', defaultValue: '30', type: 'number', required: false },
          { name: 'MIN_GUIDE_FRACTION', label: 'guide 最小比例（--min-guide-fraction）', defaultValue: '0.05', type: 'text', required: false },
          { name: 'MIN_SAMPLE_ANCHOR_READS', label: '样本最少 anchor reads', defaultValue: '4000', type: 'number', min: 1, required: false, help: '低于该值时 V11 标记 LOW_ANCHOR_READS' },
          { name: 'ALLOW_UNIQUE_1MM', label: '保留唯一 1-mismatch 辅助证据', defaultValue: 'true', type: 'boolean', required: false },
          { name: 'ALLOW_REVERSE_COMPLEMENT', label: '同时匹配反向互补 spacer', defaultValue: 'false', type: 'boolean', required: false },
        ] },
        { title: '生成确定性 QC 与报告', command: 'python3 <FLOW>/01_software/hidog/hidogV11_trace_report.py --mode vector-trace --input-dir <RUN>/results/vt_results --report-dir <RUN>/results/report\ntest -s <RUN>/results/report/qc_summary.json\ntest -s <RUN>/results/report/report.html', notes: '直接读取 V11 的 spacer_detection.tsv 与 run_parameters.json，生成 JSON、Markdown、HTML；不再把结果整段交给 AI 猜测' },
      ],
      manifest: {
        software: [
          { name: 'Python 3.8+', checkCmd: 'python3 -c "import sys; assert sys.version_info >= (3, 8)"', required: true },
          { name: 'openpyxl（V11 Excel 输出）', checkCmd: 'python3 -c "import openpyxl"', required: true },
        ],
        references: [
          { name: 'HiDOG V11 管线与 TRACE 启动器', path: '{{FLOW_HOME}}/01_software/hidog/hidogV11_trace_runner.py', type: 'other', source: '随 TRACE 分发并自动部署', required: true },
        ],
        inputHint: '双端 FASTQ（R1/R2）+ barcode 文件 + 载体锚定序列 + spacer 参考（FASTA 或 TSV）',
        qcGates: [
          { afterStep: 4, metric: 'V11 样本调用与 anchor reads', pass: '全部样本为 SGRNA_DETECTED', warn: '存在 LOW_ANCHOR_READS 或 NO_TARGET_SGRNA' },
        ],
      },
      assets: [
        { source: 'hidog/hidogV11.py', remotePath: 'hidog/hidogV11.py', label: 'HiDOG 主入口' },
        { source: 'hidog/hidogV11_packages.py', remotePath: 'hidog/hidogV11_packages.py', label: '编辑效率分析核心' },
        { source: 'hidog/hidogV11_vector_trace.py', remotePath: 'hidog/hidogV11_vector_trace.py', label: '载体追踪核心' },
        { source: 'hidog/hidogV11_trace_runner.py', remotePath: 'hidog/hidogV11_trace_runner.py', label: 'TRACE 参数校验与启动器' },
        { source: 'hidog/hidogV11_trace_report.py', remotePath: 'hidog/hidogV11_trace_report.py', label: '自动 QC 与报告生成器' },
      ],
      source: 'builtin',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'builtin-hidog-amplicon',
      name: 'HiDOG V11 扩增子编辑效率分析',
      description: '按 HiDOG V11 原生参数执行扩增子分析；支持 FASTQ/Hi-TOM、常规编辑/Prime Editing、dual-primer UMI，并自动生成确定性 QC 报告。',
      keywords: ['hidog', '基因编辑', '编辑效率', 'crispr', 'cas9', 'prime editing', 'pegrna', 'amplicon', 'indel', '扩增子'],
      params: [
        { name: 'INPUT_MODE', label: '输入模式', defaultValue: 'fastq', type: 'select', options: ['fastq', 'hitom'], help: 'fastq 使用 R1/R2/barcode；hitom 只使用 Sequence.xls' },
        { name: 'READ1', label: 'R1 FASTQ（hitom 模式填 NONE）', defaultValue: 'NONE', type: 'path', required: false },
        { name: 'READ2', label: 'R2 FASTQ（hitom 模式填 NONE）', defaultValue: 'NONE', type: 'path', required: false },
        { name: 'BARCODE', label: 'barcode 文件（hitom 模式填 NONE）', defaultValue: 'NONE', type: 'path', required: false },
        { name: 'HITOM_XLS', label: 'Hi-TOM Sequence.xls（fastq 模式填 NONE）', defaultValue: 'NONE', type: 'path', required: false },
        { name: 'REF_FASTA', label: '参考序列 FASTA（文件或目录）', type: 'path' },
        { name: 'ANALYSIS_TYPE', label: '分析模式', defaultValue: 'disjoint', type: 'select', options: ['disjoint', 'overlap'] },
        { name: 'EDITING_TOOL', label: '编辑工具', defaultValue: 'cas9', type: 'select', options: ['cas9', 'cpf1', 'base_editor', 'prime_editor', 'custom'] },
        { name: 'UMI_MODE', label: 'UMI 模式', defaultValue: 'off', type: 'select', options: ['off', 'dual-primer'], help: 'dual-primer 只支持 FASTQ，且 sample ratio 必须为 1.0' },
        { name: 'GUIDE_SEQ', label: 'sgRNA（Prime Editing 填 NONE）', defaultValue: 'NONE', type: 'text', required: false, help: '不含 PAM；多个序列可用空格或逗号分隔' },
        { name: 'TARGET_GENE', label: '目标基因 key（不用填 NONE）', defaultValue: 'NONE', type: 'text', required: false },
        { name: 'PEGRNA_SPACER_SEQ', label: 'Prime Editing：pegRNA spacer', defaultValue: 'NONE', type: 'text', required: false },
        { name: 'PEGRNA_EXTENSION_SEQ', label: 'Prime Editing：pegRNA RTT+PBS extension', defaultValue: 'NONE', type: 'text', required: false },
        { name: 'PEGRNA_SCAFFOLD_SEQ', label: 'Prime Editing：pegRNA scaffold', defaultValue: 'NONE', type: 'text', required: false },
        { name: 'NICKING_GUIDE_SEQ', label: 'Prime Editing：nicking guide（可选）', defaultValue: 'NONE', type: 'text', required: false },
        { name: 'THREADS', label: 'Threads', defaultValue: '8', type: 'number', min: 1, max: 128 },
      ],
      steps: [
        { title: '校验已部署的 HiDOG V11', command: 'test -s <FLOW>/01_software/hidog/hidogV11.py\ntest -s <FLOW>/01_software/hidog/hidogV11_packages.py\ntest -s <FLOW>/01_software/hidog/hidogV11_vector_trace.py\ntest -s <FLOW>/01_software/hidog/hidogV11_trace_runner.py\ntest -s <FLOW>/01_software/hidog/hidogV11_trace_report.py\npython3 <FLOW>/01_software/hidog/hidogV11.py --version\npython3 <FLOW>/01_software/hidog/hidogV11.py --help >/dev/null', notes: '运行面板会自动部署 5 个文件；本步骤只做版本与完整性校验' },
        { title: '检查 V11 扩增子环境', command: 'command -v bwa\ncommand -v samtools\ncommand -v trimmomatic\npython3 -c "import pysam, openpyxl, matplotlib; print(\'HiDOG Python dependencies OK\')"', notes: '缺少的模块或 Python 包会在环境检查卡中明确显示；流程不会在计算任务中临时 pip 安装' },
        { title: '运行 HiDOG V11 扩增子分析', command: 'python3 <FLOW>/01_software/hidog/hidogV11_trace_runner.py --hidog <FLOW>/01_software/hidog/hidogV11.py --run-dir <RUN> amplicon \\\n  --input-mode "{{INPUT_MODE}}" --read1 "{{READ1}}" --read2 "{{READ2}}" --barcode "{{BARCODE}}" --hitom-xls "{{HITOM_XLS}}" \\\n  --reference "{{REF_FASTA}}" --analysis-type "{{ANALYSIS_TYPE}}" --editing-tool "{{EDITING_TOOL}}" --umi-mode "{{UMI_MODE}}" \\\n  --guide-seq "{{GUIDE_SEQ}}" --target-gene "{{TARGET_GENE}}" \\\n  --pegrna-spacer-seq "{{PEGRNA_SPACER_SEQ}}" --pegrna-extension-seq "{{PEGRNA_EXTENSION_SEQ}}" \\\n  --pegrna-scaffold-seq "{{PEGRNA_SCAFFOLD_SEQ}}" --nicking-guide-seq "{{NICKING_GUIDE_SEQ}}" --threads "{{THREADS}}" \\\n  --bwa-profile "{{BWA_PROFILE}}" --min-ratio "{{MIN_RATIO}}" --min-genotype-depth "{{MIN_GENOTYPE_DEPTH}}" \\\n  --low-depth-warning-threshold "{{LOW_DEPTH_WARNING_THRESHOLD}}" --q30 "{{Q30}}" --sample-ratio "{{SAMPLE_RATIO}}" --sample-seed "{{SAMPLE_SEED}}" \\\n  --quant-window-size "{{QUANT_WINDOW_SIZE}}" --quant-window-center "{{QUANT_WINDOW_CENTER}}" \\\n  --quant-window-coordinates "{{QUANT_WINDOW_COORDINATES}}" --cleavage-offset "{{CLEAVAGE_OFFSET}}" \\\n  --spacer-length "{{SPACER_LENGTH}}" --barcode-length "{{BARCODE_LENGTH}}" --bridge-length "{{BRIDGE_LENGTH}}" \\\n  --post-barcode-spacer-length "{{POST_BARCODE_SPACER_LENGTH}}" --umi-length-r1 "{{UMI_LENGTH_R1}}" --umi-length-r2 "{{UMI_LENGTH_R2}}" \\\n  --min-umi-base-quality "{{MIN_UMI_BASE_QUALITY}}" --amplicon-primer-tsv "{{AMPLICON_PRIMER_TSV}}" \\\n  --amplicon-primer-max-mismatches "{{AMPLICON_PRIMER_MAX_MISMATCHES}}" --umi-consensus-min-family-size "{{UMI_CONSENSUS_MIN_FAMILY_SIZE}}" \\\n  --umi-consensus-min-fraction "{{UMI_CONSENSUS_MIN_FRACTION}}" --min-umi-family-genotype-depth "{{MIN_UMI_FAMILY_GENOTYPE_DEPTH}}" \\\n  --min-umi-variant-family-support "{{MIN_UMI_VARIANT_FAMILY_SUPPORT}}" --enable-umi-family-analysis "{{ENABLE_UMI_FAMILY_ANALYSIS}}" \\\n  --fast-bwa "{{FAST_BWA}}" --enable-cas9-nw-rescue "{{ENABLE_CAS9_NW_RESCUE}}" --disable-homoeolog-analysis "{{DISABLE_HOMOEOLOG_ANALYSIS}}" \\\n  --allow-multiple-guides "{{ALLOW_MULTIPLE_GUIDES}}" --force-rerun "{{FORCE_RERUN}}" --extra-args "{{EXTRA_ARGS}}"', notes: '启动器按 argv 数组构造命令，并在运行前验证输入模式、编辑工具和 UMI 参数组合；输出固定在 results/hidog_run', params: [
          { name: 'BWA_PROFILE', label: 'BWA 配置', defaultValue: 'auto', type: 'select', options: ['auto', 'default', 'cas9-sensitive'], required: false },
          { name: 'MIN_RATIO', label: '最小等位基因比例（AUTO=V11 自动）', defaultValue: 'AUTO', type: 'text', required: false },
          { name: 'MIN_GENOTYPE_DEPTH', label: '基因型最小深度', defaultValue: '50', type: 'number', min: 1, required: false },
          { name: 'LOW_DEPTH_WARNING_THRESHOLD', label: '低深度警告阈值', defaultValue: '100', type: 'number', min: 1, required: false },
          { name: 'Q30', label: 'barcode/UMI Q30 阈值', defaultValue: '30', type: 'number', min: 0, required: false },
          { name: 'SAMPLE_RATIO', label: 'FASTQ 抽样比例', defaultValue: '1.0', type: 'number', min: 0.01, max: 1, step: 0.05, required: false, help: 'dual-primer UMI 必须为 1.0' },
          { name: 'SAMPLE_SEED', label: '抽样随机种子', defaultValue: '12345', type: 'number', required: false },
          { name: 'QUANT_WINDOW_SIZE', label: '定量窗口半径（AUTO=按工具推导）', defaultValue: 'AUTO', type: 'text', required: false },
          { name: 'QUANT_WINDOW_CENTER', label: '定量窗口中心（AUTO=按工具推导）', defaultValue: 'AUTO', type: 'text', required: false },
          { name: 'QUANT_WINDOW_COORDINATES', label: '显式定量窗口坐标（如 44-45）', defaultValue: 'AUTO', type: 'text', required: false },
          { name: 'CLEAVAGE_OFFSET', label: '切点偏移（AUTO=按工具推导）', defaultValue: 'AUTO', type: 'text', required: false },
          { name: 'SPACER_LENGTH', label: 'barcode 前 spacer 长度', defaultValue: '4', type: 'number', min: 0, required: false },
          { name: 'BARCODE_LENGTH', label: '每端 barcode 长度', defaultValue: '4', type: 'number', min: 1, required: false },
          { name: 'BRIDGE_LENGTH', label: 'dual-primer bridge 长度', defaultValue: '18', type: 'number', min: 0, required: false },
          { name: 'POST_BARCODE_SPACER_LENGTH', label: 'barcode 后 spacer 长度', defaultValue: '1', type: 'number', min: 0, required: false },
          { name: 'UMI_LENGTH_R1', label: 'R1 UMI 长度', defaultValue: '8', type: 'number', min: 1, required: false },
          { name: 'UMI_LENGTH_R2', label: 'R2 UMI 长度', defaultValue: '8', type: 'number', min: 1, required: false },
          { name: 'MIN_UMI_BASE_QUALITY', label: 'UMI 最低碱基质量', defaultValue: '30', type: 'number', min: 0, required: false },
          { name: 'AMPLICON_PRIMER_TSV', label: 'amplicon primer TSV（不用填 NONE）', defaultValue: 'NONE', type: 'path', required: false },
          { name: 'AMPLICON_PRIMER_MAX_MISMATCHES', label: 'primer 最大错配', defaultValue: '1', type: 'number', min: 0, required: false },
          { name: 'UMI_CONSENSUS_MIN_FAMILY_SIZE', label: 'UMI consensus 最小 family size', defaultValue: '2', type: 'number', min: 1, required: false },
          { name: 'UMI_CONSENSUS_MIN_FRACTION', label: 'UMI consensus 最小主导比例', defaultValue: '0.8', type: 'number', min: 0, max: 1, step: 0.05, required: false },
          { name: 'MIN_UMI_FAMILY_GENOTYPE_DEPTH', label: 'UMI family 基因型最小深度', defaultValue: '50', type: 'number', min: 1, required: false },
          { name: 'MIN_UMI_VARIANT_FAMILY_SUPPORT', label: '变异最少独立 UMI family 支持', defaultValue: '2', type: 'number', min: 1, required: false },
          { name: 'ENABLE_UMI_FAMILY_ANALYSIS', label: '启用 UMI family 共识分析', defaultValue: 'false', type: 'boolean', required: false },
          { name: 'FAST_BWA', label: '启用轻量 BWA 快速路径', defaultValue: 'false', type: 'boolean', required: false },
          { name: 'ENABLE_CAS9_NW_RESCUE', label: '启用 Cas9 大 indel NW rescue', defaultValue: 'false', type: 'boolean', required: false },
          { name: 'DISABLE_HOMOEOLOG_ANALYSIS', label: '关闭同源拷贝联合分析', defaultValue: 'false', type: 'boolean', required: false },
          { name: 'ALLOW_MULTIPLE_GUIDES', label: '允许每条参考多个 guide', defaultValue: 'false', type: 'boolean', required: false },
          { name: 'FORCE_RERUN', label: '忽略断点并强制重跑', defaultValue: 'false', type: 'boolean', required: false },
          { name: 'EXTRA_ARGS', label: 'V11 额外参数（不用填 NONE）', defaultValue: 'NONE', type: 'text', required: false, help: '启动器使用 shlex 拆分，不经 shell 执行' },
        ] },
        { title: '生成确定性 QC 与报告', command: 'python3 <FLOW>/01_software/hidog/hidogV11_trace_report.py --mode amplicon --input-dir <RUN>/results/hidog_run --report-dir <RUN>/results/report\ntest -s <RUN>/results/report/qc_summary.json\ntest -s <RUN>/results/report/report.html', notes: '直接读取 V11 的 *.stats.tsv 与 resume_state.json，生成 JSON、Markdown、HTML；不再把大段结果交给 AI 临时总结' },
      ],
      manifest: {
        software: [
          { name: 'BWA', module: 'BWA', required: true },
          { name: 'SAMtools', module: 'SAMtools', required: true },
          { name: 'Trimmomatic', module: 'Trimmomatic', required: true },
          { name: 'Python3 + pysam/openpyxl/matplotlib', checkCmd: 'python3 -c "import pysam, openpyxl, matplotlib"', required: true },
        ],
        references: [
          { name: 'HiDOG V11 管线与 TRACE 启动器', path: '{{FLOW_HOME}}/01_software/hidog/hidogV11_trace_runner.py', type: 'other', source: '随 TRACE 分发并自动部署', required: true },
          { name: '扩增子参考序列', path: '{{REF_FASTA}}', type: 'genome', source: '用户提供的 FASTA 文件或目录', required: true },
        ],
        inputHint: 'fastq：R1/R2 + barcode + 参考 FASTA；hitom：Sequence.xls + 参考 FASTA。普通编辑需 guide，Prime Editing 需 pegRNA spacer/extension/scaffold。',
        qcGates: [
          { afterStep: 4, metric: 'V11 Assigned reads 与编辑频率可定量性', pass: '全部结果行 Assigned reads ≥100 且编辑频率可定量', warn: '50-99 reads 为低深度警告；<50 reads 或不可定量为失败' },
        ],
      },
      assets: [
        { source: 'hidog/hidogV11.py', remotePath: 'hidog/hidogV11.py', label: 'HiDOG 主入口' },
        { source: 'hidog/hidogV11_packages.py', remotePath: 'hidog/hidogV11_packages.py', label: '编辑效率分析核心' },
        { source: 'hidog/hidogV11_vector_trace.py', remotePath: 'hidog/hidogV11_vector_trace.py', label: '载体追踪核心' },
        { source: 'hidog/hidogV11_trace_runner.py', remotePath: 'hidog/hidogV11_trace_runner.py', label: 'TRACE 参数校验与启动器' },
        { source: 'hidog/hidogV11_trace_report.py', remotePath: 'hidog/hidogV11_trace_report.py', label: '自动 QC 与报告生成器' },
      ],
      source: 'builtin',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'builtin-rnaseq-qc-align',
      name: 'RNA-seq 质控与定量流程',
      description: '从原始 FASTQ 到表达定量的标准上游流程：FastQC 质控 → Trimmomatic 修剪 → kallisto 定量。',
      keywords: ['转录组', 'rnaseq', 'rna-seq', 'rna', '质控', 'fastq', 'fastqc', 'trimmomatic', 'kallisto', '定量', '表达量'],
      params: [
        { name: 'INPUT_DIR', label: 'FASTQ directory (*_R1.fq.gz / *_R2.fq.gz)', type: 'path' },
        { name: 'SAMPLE_LIST', label: '样本列表文件（cut -f 1 逐行读）', type: 'path', required: false, placeholder: '可留空，AI 运行时协助生成' },
        { name: 'KALLISTO_INDEX', label: 'kallisto 索引（.idx）路径', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找或构建' },
        { name: 'GTF', label: 'Gene annotation GTF path', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找' },
        { name: 'CHROM_TABLE', label: '染色体长度表路径', type: 'path', required: false, placeholder: '可留空，AI 运行时协助生成' },
        { name: 'QUEUE', label: 'Queue', defaultValue: 'q2680v2', type: 'select', options: ['q2680v2', 'normal', 'smp', 'high'] },
        { name: 'THREADS', label: 'Threads', defaultValue: '8', type: 'number' },
      ],
      steps: [
        { title: 'Read-only preflight: software, inputs and references', command: 'module av FastQC/Trimmomatic/kallisto 确认可加载；ls -ld {{INPUT_DIR}}；ls -l {{SAMPLE_LIST}} {{KALLISTO_INDEX}} {{GTF}} {{CHROM_TABLE}}；缺失先问用户' },
        { title: 'FastQC raw read QC', command: '#BSUB -J rnaseq_qc -n 1 -q {{QUEUE}}\nmodule load FastQC/0.11.9\ncd {{INPUT_DIR}} && mkdir -p fastqc_results\nfastqc *.fq.gz -o ./fastqc_results -t {{THREADS}}', notes: '写成 rnaseq_qc.lsf 后 bsub 提交；先看报告再决定后续' },
        { title: 'Trimmomatic 去接头与低质量修剪', command: '#BSUB -J rnaseq_trim -n {{THREADS}} -q {{QUEUE}}\ncd {{INPUT_DIR}}\nmodule load Trimmomatic/0.32-Java-1.8.0_92\ncut -f 1 {{SAMPLE_LIST}} | while read i; do\njava -jar $EBROOTTRIMMOMATIC/trimmomatic-0.32.jar PE -phred33 "$i"_R1.fq.gz "$i"_R2.fq.gz "$i"_R1_paired.fq.gz "$i"_R1_unpaired.fq.gz "$i"_R2_paired.fq.gz "$i"_R2_unpaired.fq.gz ILLUMINACLIP:$EBROOTTRIMMOMATIC/adapters/NexteraPE-PE.fa:2:30:10:8:TRUE LEADING:3 TRAILING:3 SLIDINGWINDOW:4:15 MINLEN:36 2>trim_"$i".log\ndone', notes: '写成 rnaseq_trim.lsf 后 bsub 提交' },
        { title: 'kallisto 转录本定量', command: '#BSUB -J rnaseq_kallisto -n {{THREADS}} -q {{QUEUE}}\nmodule load GCCcore/6.4.0\nmodule load kallisto/0.48.0\ncut -f 1 {{SAMPLE_LIST}} | while read i; do\n  kallisto quant -i {{KALLISTO_INDEX}} -o ${i} -t {{THREADS}} -b 100 -l 150 -s 50 --genomebam --gtf {{GTF}} --chromosomes {{CHROM_TABLE}} {{INPUT_DIR}}/${i}_R1.fq.gz {{INPUT_DIR}}/${i}_R2.fq.gz\ndone', notes: '写成 rnaseq_kallisto.lsf 后 bsub 提交；按参考脚本用原始 reads 定量' },
        { title: 'Generate analysis report', command: 'python3 <RUN>/tools/encode_native_report.py --run-dir <RUN> --input-dir {{INPUT_DIR}} --report-dir <RUN>/reports/final-report\ntest -s <RUN>/reports/final-report/report.html', notes: '确定性报告生成器直接读取真实产物（QC 指标/峰文件/图）生成图文并茂的 HTML+MD 报告；AI 只需在回复里补充一段结论解读并给出报告绝对路径，不要重写报告文件' },
      ],
      manifest: {
        software: [
          { name: 'FastQC', module: 'FastQC/0.11.9', required: true },
          { name: 'Trimmomatic', module: 'Trimmomatic/0.32-Java-1.8.0_92', required: true },
          { name: 'kallisto', module: 'kallisto/0.48.0', prerequisiteModules: ['GCCcore/6.4.0'], versionCmd: 'kallisto version', required: true },
        ],
        references: [
          { name: 'kallisto 索引', path: '{{KALLISTO_INDEX}}', type: 'index', source: '可留空：AI 运行时协助查找或在 02_reference/ 下构建（kallisto index）', required: false },
          { name: 'Gene annotation GTF', path: '{{GTF}}', type: 'annotation', source: '可留空：AI 运行时协助从集群公共库 /share/database/ 匹配', required: false },
          { name: '染色体长度表', path: '{{CHROM_TABLE}}', type: 'other', source: '可留空：AI 运行时协助由基因组生成', required: false },
        ],
        inputHint: '双端 FASTQ 目录（*_R1.fq.gz / *_R2.fq.gz）与样本列表文件',
        qcGates: [
          { afterStep: 2, metric: 'FastQC 碱基质量与接头含量', pass: 'Q30 >80%，接头含量 <5%', warn: 'Q30 70-80% 或接头 5-15%' },
          { afterStep: 3, metric: '修剪后 reads 保留率', pass: '双端保留率 >70%', warn: '50-70%' },
          { afterStep: 4, metric: 'kallisto 比对率', pass: 'pseudoalignment 率 >70%', warn: '50-70%' },
        ],
      },
      source: 'builtin',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'encode-chipseq-tf',
      name: 'ENCODE TF ChIP-seq Analysis & QC Pipeline',
      description: 'ENCODE TF ChIP-seq pipeline: BWA MEM alignment → filter/dedup (MAPQ≥30, fixmate, MarkDuplicates) → blacklist removal → MACS2 narrow peaks → cross-replicate IDR consistency.',
      keywords: ['encode', 'chipseq', 'chip-seq', '转录因子', 'tf', 'bwa', 'macs2', 'idr', 'frip', '质控', '表观'],
      params: [
        { name: 'INPUT_DIR', label: 'FASTQ directory (*_R1.fq.gz / *_R2.fq.gz)', type: 'path' },
        { name: 'CONTROL_DIR', label: 'Control FASTQ directory (Input/IgG)', type: 'path', required: false, placeholder: '可留空，AI 运行时协助确认' },
        { name: 'BWA_INDEX', label: 'BWA index prefix', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找或构建' },
        { name: 'REF_FA', label: 'Reference genome FASTA', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找' },
        { name: 'BLACKLIST', label: 'ENCODE blacklist BED', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找' },
        { name: 'GENOME_SIZE', label: 'MACS2 effective genome size', defaultValue: 'hs', type: 'text', required: false, help: 'hs=人、mm=小鼠，或直接给数值如 2.7e9' },
        { name: 'QUEUE', label: 'Queue', defaultValue: 'q2680v2', type: 'select', options: ['q2680v2', 'normal', 'smp', 'high'] },
        { name: 'THREADS', label: 'Threads', defaultValue: '8', type: 'number' },
      ],
      steps: [
        { title: 'Read-only preflight: software, inputs and references', command: 'module av BWA SAMtools Picard MACS2 FastQC BEDTools 确认可加载；ls -ld {{INPUT_DIR}} {{CONTROL_DIR}}；ls -l {{BWA_INDEX}}.sa {{REF_FA}} {{BLACKLIST}}；缺失先问用户' },
        { title: 'FastQC raw read QC', command: '#BSUB -J chipseq_qc -n 1 -q {{QUEUE}}\nmodule load FastQC/0.11.9\ncd {{INPUT_DIR}} && mkdir -p fastqc_results\nfastqc *.fq.gz -o ./fastqc_results -t {{THREADS}}', notes: '写成 chipseq_qc.lsf 后 bsub 提交；先看报告再决定后续' },
        { title: 'BWA MEM alignment and sorting', command: '#BSUB -J chipseq_align -n {{THREADS}} -q {{QUEUE}}\nmodule load BWA/0.7.17 SAMtools/1.17\ncd {{INPUT_DIR}}\nfor i in *_R1.fq.gz; do\n  s=${i%_R1.fq.gz}\n  bwa mem -t {{THREADS}} {{BWA_INDEX}} "$i" "${s}_R2.fq.gz" | samtools sort -@ {{THREADS}} -o "${s}.sorted.bam" -\ndone', notes: '写成 chipseq_align.lsf 后 bsub 提交；单端数据只传 R1 一个文件' },
        { title: 'Alignment filtering and PCR dedup', command: '#BSUB -J chipseq_filter -n {{THREADS}} -q {{QUEUE}}\nmodule load SAMtools/1.17 Picard/2.27.4\ncd {{INPUT_DIR}} && mkdir -p qc\nfor b in *.sorted.bam; do\n  s=${b%.sorted.bam}\n  samtools view -@ {{THREADS}} -b -q 30 -f 2 -F 1804 "$b" > "${s}.filt.bam"\n  samtools sort -@ {{THREADS}} -n "${s}.filt.bam" -o "${s}.filt.nsrt.bam"\n  samtools fixmate -@ {{THREADS}} -m "${s}.filt.nsrt.bam" "${s}.fixmate.bam"\n  samtools sort -@ {{THREADS}} "${s}.fixmate.bam" -o "${s}.fixmate.sorted.bam"\n  java -jar $EBROOTPICARD/picard.jar MarkDuplicates I="${s}.fixmate.sorted.bam" O="${s}.dedup.bam" M=qc/"${s}".dup_metrics.txt REMOVE_DUPLICATES=true\n  samtools index "${s}.dedup.bam"\ndone', notes: 'MAPQ≥30、保留正确配对、去未比对/次要比对/QC 失败 reads；fixmate + MarkDuplicates 去 PCR 重复，dup_metrics 纳入库复杂度评估' },
        { title: 'QC: strand cross-correlation and library complexity', command: '#BSUB -J chipseq_libqc -n 1 -q {{QUEUE}}\nmodule load SAMtools/1.17\ncd {{INPUT_DIR}} && mkdir -p qc\nfor b in *.dedup.bam; do\n  s=${b%.dedup.bam}\n  run_spp.R -c="$b" -savp -p {{THREADS}} -out=qc/"${s}".cc.qc\ndone\npython3 - <<\'PY\'\nimport glob, json, os\nqc = {}\nfor cc in glob.glob("qc/*.cc.qc"):\n    s = os.path.basename(cc).replace(".cc.qc", "")\n    with open(cc) as fh:\n        header = fh.readline().rstrip("\\n").split("\\t")\n        row = fh.readline().rstrip("\\n").split("\\t")\n    rec = dict(zip(header, row))\n    nrf = None\n    dup = os.path.join("qc", s + ".dup_metrics.txt")\n    if os.path.exists(dup):\n        with open(dup) as fh:\n            for line in fh:\n                if line.startswith("#") or line.startswith("LIBRARY") or not line.strip():\n                    continue\n                cols = line.rstrip("\\n").split("\\t")\n                examined = int(cols[1]) + 2 * int(cols[2])\n                duplicates = int(cols[5]) + 2 * int(cols[6])\n                nrf = round(1 - duplicates / examined, 4) if examined else None\n                break\n    qc[s] = {"NSC": rec.get("NSC"), "RSC": rec.get("RSC"), "NRF": nrf}\nwith open("qc/qc.json", "w") as out:\n    json.dump(qc, out, indent=2, ensure_ascii=False)\nPY', notes: '达标：NSC≥1.05、RSC≥0.8、NRF≥0.8；警告：NSC 1.0-1.05、RSC 0.5-0.8、NRF 0.6-0.8；PBC≥0.8 可用 preseq 补充评估' },
        { title: 'MACS2 narrow-peak calling and blacklist filtering', command: '#BSUB -J chipseq_peak -n {{THREADS}} -q {{QUEUE}}\nmodule load MACS2/2.2.7.1 BEDTools/2.30.0\ncd {{INPUT_DIR}} && mkdir -p peaks\nCTRL=$(ls {{CONTROL_DIR}}/*.dedup.bam 2>/dev/null | head -1 || true)\nfor b in *.dedup.bam; do\n  s=${b%.dedup.bam}\n  macs2 callpeak -t "$b" ${CTRL:+-c "$CTRL"} -n "${s}" -g {{GENOME_SIZE}} -q 0.05 --outdir peaks\n  bedtools intersect -a peaks/"${s}"_peaks.narrowPeak -b {{BLACKLIST}} -v > peaks/"${s}".peaks.final.bed\ndone', notes: '写成 chipseq_peak.lsf 后 bsub 提交；q=0.05 为候选峰，最终集以 IDR 筛选为准；CONTROL_DIR 有去重 BAM 时自动启用对照' },
        { title: 'QC: RPKM bigWig tracks, SPOT and peak snapshots', command: '#BSUB -J chipseq_track_qc -n {{THREADS}} -q {{QUEUE}}\nmodule load deepTools/3.5.1 SAMtools/1.17 BEDTools/2.30.0\ncd {{INPUT_DIR}} && mkdir -p qc/tracks qc/igv\nfor b in *.dedup.bam; do\n  s=${b%.dedup.bam}\n  bamCoverage -b "$b" -o qc/tracks/"${s}".rpkm.bw -p {{THREADS}} --normalizeUsing RPKM\ndone\nfor b in *.dedup.bam; do\n  s=${b%.dedup.bam}\n  if command -v hotspot2 >/dev/null 2>&1; then\n    mkdir -p hotspots\n    samtools view -H "$b" | awk -F\'\\t\' \'/^@SQ/{split($2,a,":");split($3,c,":");print a[2]"\\t"c[2]}\' > qc/chrom.sizes\n    hotspot2 -c qc/chrom.sizes "$b" hotspots/"${s}"\n    total=$(samtools view -c "$b")\n    inhot=$(bedtools intersect -a "$b" -b hotspots/"${s}".hotspots.fdr0.05.bed -u | samtools view -c - || true)\n    echo -e "${s}\\t${total}\\t${inhot}" >> qc/spot.tsv\n  else\n    echo "SKIP: hotspot2 不可用，跳过 SPOT（module load 或一键部署 hotspot2 即可启用）"\n  fi\ndone\npython3 - <<\'PY\'\nBAM_GLOB = "*.dedup.bam"\nBAM_SUFFIX = ".dedup.bam"\nPEAK_DIR = "peaks/"\nPEAK_SUFFIX = ".peaks.final.bed"\nimport glob, os, random, subprocess, sys\ntry:\n    import matplotlib\n    matplotlib.use("Agg")\n    import matplotlib.pyplot as plt\nexcept Exception as exc:\n    print("SKIP: 无 matplotlib，跳过峰快照绘图（%s）" % exc)\n    sys.exit(0)\nos.makedirs("qc/igv", exist_ok=True)\nmade = 0\nfor bam in sorted(glob.glob(BAM_GLOB)):\n    s = bam[: -len(BAM_SUFFIX)]\n    peak_file = PEAK_DIR + s + PEAK_SUFFIX\n    if not os.path.exists(peak_file):\n        continue\n    peaks = []\n    with open(peak_file) as fh:\n        for line in fh:\n            if line.startswith("#"):\n                continue\n            f = line.rstrip("\\n").split("\\t")\n            if len(f) >= 3:\n                try:\n                    peaks.append((f[0], int(f[1]), int(f[2])))\n                except ValueError:\n                    pass\n    if not peaks:\n        continue\n    random.seed(42)\n    for chrom, start, end in random.sample(peaks, min(5, len(peaks))):\n        a, b = max(0, start - 1500), end + 1500\n        out = subprocess.run(["samtools", "depth", "-a", "-r", "%s:%d-%d" % (chrom, a, b), bam], capture_output=True, text=True)\n        cov = {}\n        for line in out.stdout.splitlines():\n            f = line.split("\\t")\n            if len(f) >= 3:\n                cov[int(f[1])] = int(f[2])\n        xs = list(range(a, b + 1))\n        ys = [cov.get(x, 0) for x in xs]\n        fig, ax = plt.subplots(figsize=(8, 2.4))\n        ax.fill_between(xs, ys, color="#3b82f6", lw=0)\n        ax.axvspan(start, end, color="#f59e0b", alpha=0.25)\n        ax.set_title("%s  %s:%d-%d" % (s, chrom, start, end))\n        ax.set_xlabel(chrom)\n        ax.set_ylabel("depth")\n        ax.margins(x=0)\n        fig.tight_layout()\n        fig.savefig("qc/igv/%s_%s_%d.png" % (s, chrom, start), dpi=120)\n        plt.close(fig)\n        made += 1\nprint("IGV 风格峰快照产出 %d 张 → qc/igv/" % made)\nPY', notes: 'TRACE 对 ENCODE 基线的扩展：RPKM 标准化 bigWig（qc/tracks/*.rpkm.bw）可直接拖进 IGV/基因组浏览器；SPOT 需 hotspot2（缺失自动 SKIP）；随机抽 5 个峰画 IGV 风格覆盖图到 qc/igv/（需 matplotlib，缺失自动 SKIP；固定随机种子 42 可复现）' },
        { title: 'QC: FRiP and cross-replicate IDR consistency', command: '#BSUB -J chipseq_idr -n {{THREADS}} -q {{QUEUE}}\nmodule load SAMtools/1.17 BEDTools/2.30.0\ncd {{INPUT_DIR}} && mkdir -p idr qc\nfor b in *.dedup.bam; do\n  s=${b%.dedup.bam}\n  total=$(samtools view -c "$b")\n  inpeak=$(bedtools intersect -a "$b" -b peaks/"${s}".peaks.final.bed -u | samtools view -c -)\n  echo -e "${s}\\t${total}\\t${inpeak}" >> qc/frip.tsv\ndone\n# 重复≥2 时对真重复跑 IDR（合并池峰为 oracle）；单重复改用自我伪重复 IDR\nmapfile -t PK < <(ls peaks/*.peaks.final.bed 2>/dev/null || ls *.peaks.final.bed 2>/dev/null)\nif [ "${#PK[@]}" -lt 2 ]; then\n  echo "SKIP: 需要至少 2 个重复 peaks 才能算 IDR"\nelse\n  POOL=$(ls peaks/*pool*.peaks.final.bed 2>/dev/null | head -1 || true)\n  idr --samples "${PK[0]}" "${PK[1]}" ${POOL:+--peak-list "$POOL"} --input-file-type narrowPeak --rank p.value -o idr/idr.txt --plot\nfi\npython3 - <<\'PY\'\nimport json, os\nqc = {}\nif os.path.exists("qc/frip.tsv"):\n    with open("qc/frip.tsv") as fh:\n        for line in fh:\n            s, total, inpeak = line.rstrip("\\n").split("\\t")\n            qc[s] = {"FRiP": round(int(inpeak) / int(total), 4) if int(total) else None}\nn_idr = None\nif os.path.exists("idr/idr.txt"):\n    n_idr = 0\n    with open("idr/idr.txt") as fh:\n        for line in fh:\n            cols = line.rstrip("\\n").split("\\t")\n            try:\n                if float(cols[10]) < 0.05:\n                    n_idr += 1\n            except (IndexError, ValueError):\n                continue\nqc["_idr"] = {"peaks_global_idr_lt_0.05": n_idr, "rule": "Np(伪重复)/Nt(真重复) < 2 达标，>= 2 判重复间不一致"}\nwith open("qc/idr_qc.json", "w") as out:\n    json.dump(qc, out, indent=2, ensure_ascii=False)\nPY', notes: '达标：FRiP≥1%、IDR Np/Nt<2（global IDR<0.05 计 Nt）；警告：FRiP 0.5-1%；idr 包缺失时先 module av 或问用户安装方式' },
        { title: 'Generate analysis report', command: 'python3 <RUN>/tools/encode_native_report.py --run-dir <RUN> --input-dir {{INPUT_DIR}} --report-dir <RUN>/reports/final-report\ntest -s <RUN>/reports/final-report/report.html', notes: '确定性报告生成器直接读取真实产物（QC 指标/峰文件/图）生成图文并茂的 HTML+MD 报告；AI 只需在回复里补充一段结论解读并给出报告绝对路径，不要重写报告文件' },
      ],
      manifest: {
        software: [
          { name: 'FastQC', module: 'FastQC/0.11.9', required: true },
          { name: 'BWA', module: 'BWA/0.7.17', required: true },
          { name: 'SAMtools', module: 'SAMtools/1.17', required: true },
          { name: 'Picard', module: 'Picard/2.27.4', required: true },
          { name: 'MACS2', module: 'MACS2/2.2.7.1', required: true },
          { name: 'BEDTools', module: 'BEDTools/2.30.0', required: true },
          { name: 'deepTools', module: 'deepTools/3.5.1', required: true },
          { name: 'hotspot2', checkCmd: 'command -v hotspot2', required: false },
          { name: 'phantompeakqualtools (run_spp.R)', checkCmd: 'command -v run_spp.R', required: true },
          { name: 'IDR', checkCmd: 'command -v idr', required: false },
        ],
        references: [
          { name: 'BWA index', path: '{{BWA_INDEX}}', type: 'index', source: '可留空：AI 运行时协助查找或在 02_reference/ 下构建（bwa index）', required: false },
          { name: 'Reference genome FASTA', path: '{{REF_FA}}', type: 'genome', source: '可留空：AI 运行时协助从集群公共库 /share/database/ 匹配', required: false },
          { name: 'ENCODE blacklist BED', path: '{{BLACKLIST}}', type: 'other', source: '可留空：AI 运行时协助按基因组版本下载（ENCODE blacklist）', required: false },
        ],
        inputHint: 'Paired-end ChIP-seq FASTQ directory, plus an Input/IgG control directory',
        qcGates: [
          { afterStep: 2, metric: 'FastQC 碱基质量与接头含量', pass: 'Q30 >80%，接头含量 <5%', warn: 'Q30 70-80% 或接头 5-15%' },
          { afterStep: 4, metric: '比对率与去重后保留率', pass: '比对率 >80%，去重后保留 >50%', warn: '比对率 60-80% 或重复率 >70%' },
          { afterStep: 5, metric: '链相关与库复杂度', pass: 'NSC≥1.05、RSC≥0.8、NRF≥0.8', warn: 'NSC 1.0-1.05、RSC 0.5-0.8 或 NRF 0.6-0.8' },
          { afterStep: 8, metric: 'FRiP 与重复间 IDR', pass: 'FRiP≥1%，Np/Nt<2', warn: 'FRiP 0.5-1%' },
        ],
      },
      provenance: { provider: 'trace-native', sourceName: 'ENCODE TF ChIP-seq protocol (TRACE native implementation)', sourceUrl: 'https://github.com/peacezha/TRACE',
        sourceRef: 'native-encode-v1', upstreamWorkflow: 'trace-native', implementation: 'reference-extension', importerVersion: 'native-encode-v1' },
      source: 'builtin',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'builtin-dapseq-tf',
      name: 'DAP-seq 转录因子结合分析流程',
      description: 'DAP-seq（DNA 亲和纯化测序）标准分析：FastQC → BWA MEM 比对 → 过滤去重（MAPQ≥30、MarkDuplicates）→ MACS2 窄峰（以裸 gDNA 文库为对照）→ 黑名单过滤 → FRiP/指纹图 QC → 基序富集与峰基因注释。',
      keywords: ['dapseq', 'dap-seq', 'dap', '转录因子', 'tf', '转录因子结合', 'macs2', 'motif', '基序', 'frip', '植物', 'wheat', '体外亲和'],
      params: [
        { name: 'INPUT_DIR', label: 'DAP 文库 FASTQ 目录（*_R1.fq.gz / *_R2.fq.gz）', type: 'path' },
        { name: 'CONTROL_DIR', label: '裸 gDNA 对照文库目录（不加 TF 的阴性对照）', type: 'path', required: false, placeholder: '强烈建议提供；可留空由 AI 运行时确认' },
        { name: 'BWA_INDEX', label: 'BWA index prefix', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找或构建' },
        { name: 'REF_FA', label: 'Reference genome FASTA', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找' },
        { name: 'BLACKLIST', label: '黑名单区域 BED（可选）', type: 'path', required: false, placeholder: '可留空跳过黑名单过滤' },
        { name: 'GENES_BED', label: '基因注释 BED/GFF（峰到基因注释用）', type: 'path', required: false, placeholder: '可留空，AI 运行时协助从公共库匹配' },
        { name: 'GENOME_SIZE', label: 'MACS2 effective genome size', defaultValue: 'hs', type: 'text', required: false, help: '小麦约 1.4e10（可按亚基因组调整），或 hs/mm/数值' },
        { name: 'MOTIF_DB', label: '基序数据库（MEME 格式，如 JASPAR 植物）', type: 'path', required: false, placeholder: '可留空跳过 AME 基序富集' },
        { name: 'QUEUE', label: 'Queue', defaultValue: 'q2680v2', type: 'select', options: ['q2680v2', 'normal', 'smp', 'high'] },
        { name: 'THREADS', label: 'Threads', defaultValue: '8', type: 'number' },
      ],
      steps: [
        { title: 'Read-only preflight: software, inputs and references', command: 'module av BWA SAMtools Picard MACS2 FastQC BEDTools deepTools 确认可加载；ls -ld {{INPUT_DIR}} {{CONTROL_DIR}}；ls -l {{BWA_INDEX}}.sa {{REF_FA}} {{GENES_BED}}；缺失先问用户' },
        { title: 'FastQC raw read QC', command: '#BSUB -J dapseq_qc -n 1 -q {{QUEUE}}\nmodule load FastQC/0.11.9\ncd {{INPUT_DIR}} && mkdir -p fastqc_results\nfastqc *.fq.gz -o ./fastqc_results -t {{THREADS}}', notes: '写成 dapseq_qc.lsf 后 bsub 提交；先看报告再决定后续' },
        { title: 'BWA MEM alignment and sorting', command: '#BSUB -J dapseq_align -n {{THREADS}} -q {{QUEUE}}\nmodule load BWA/0.7.17 SAMtools/1.17\ncd {{INPUT_DIR}}\nfor i in *_R1.fq.gz; do\n  s=${i%_R1.fq.gz}\n  bwa mem -t {{THREADS}} {{BWA_INDEX}} "$i" "${s}_R2.fq.gz" | samtools sort -@ {{THREADS}} -o "${s}.sorted.bam" -\ndone', notes: '写成 dapseq_align.lsf 后 bsub 提交；单端数据只传 R1 一个文件；对照文库（CONTROL_DIR）同样跑一遍本步' },
        { title: 'Alignment filtering and PCR dedup', command: '#BSUB -J dapseq_filter -n {{THREADS}} -q {{QUEUE}}\nmodule load SAMtools/1.17 Picard/2.27.4\ncd {{INPUT_DIR}} && mkdir -p qc\nfor b in *.sorted.bam; do\n  s=${b%.sorted.bam}\n  samtools view -@ {{THREADS}} -b -q 30 -f 2 -F 1804 "$b" > "${s}.filt.bam"\n  samtools sort -@ {{THREADS}} -n "${s}.filt.bam" -o "${s}.filt.nsrt.bam"\n  samtools fixmate -@ {{THREADS}} -m "${s}.filt.nsrt.bam" "${s}.fixmate.bam"\n  samtools sort -@ {{THREADS}} "${s}.fixmate.bam" -o "${s}.fixmate.sorted.bam"\n  java -jar $EBROOTPICARD/picard.jar MarkDuplicates I="${s}.fixmate.sorted.bam" O="${s}.dedup.bam" M=qc/"${s}".dup_metrics.txt REMOVE_DUPLICATES=true\n  samtools index "${s}.dedup.bam"\ndone', notes: 'MAPQ≥30、保留正确配对；DAP-seq 文库 PCR 重复率通常高于 ChIP-seq，dup_metrics 纳入评估' },
        { title: 'MACS2 narrow-peak calling（裸 gDNA 对照）and blacklist filtering', command: '#BSUB -J dapseq_peak -n {{THREADS}} -q {{QUEUE}}\nmodule load MACS2/2.2.7.1 BEDTools/2.30.0\ncd {{INPUT_DIR}} && mkdir -p peaks\nCTRL=$(ls {{CONTROL_DIR}}/*.dedup.bam 2>/dev/null | head -1 || true)\nfor b in *.dedup.bam; do\n  s=${b%.dedup.bam}\n  macs2 callpeak -t "$b" ${CTRL:+-c "$CTRL"} -n "${s}" -g {{GENOME_SIZE}} -q 0.05 --outdir peaks\n  if [ -s {{BLACKLIST}} ]; then\n    bedtools intersect -a peaks/"${s}"_peaks.narrowPeak -b {{BLACKLIST}} -v > peaks/"${s}".peaks.final.bed\n  else\n    cp peaks/"${s}"_peaks.narrowPeak peaks/"${s}".peaks.final.bed\n  fi\ndone', notes: 'DAP-seq 必须以未加 TF 的裸 gDNA 文库为对照；无对照时结果仅供探索，报告中必须注明' },
        { title: 'QC: FRiP、RPKM bigWig tracks 与对照指纹图', command: '#BSUB -J dapseq_track_qc -n {{THREADS}} -q {{QUEUE}}\nmodule load deepTools/3.5.1 SAMtools/1.17 BEDTools/2.30.0\ncd {{INPUT_DIR}} && mkdir -p qc/tracks\nfor b in *.dedup.bam; do\n  s=${b%.dedup.bam}\n  bamCoverage -b "$b" -o qc/tracks/"${s}".rpkm.bw -p {{THREADS}} --normalizeUsing RPKM\n  total=$(samtools view -c "$b")\n  inpeak=$(bedtools intersect -a "$b" -b peaks/"${s}".peaks.final.bed -u | samtools view -c - || true)\n  echo -e "${s}\\t${total}\\t${inpeak}" >> qc/frip.tsv\ndone\nCTRL_BAM=$(ls {{CONTROL_DIR}}/*.dedup.bam 2>/dev/null | head -1 || true)\nif [ -n "$CTRL_BAM" ]; then\n  plotFingerprint -b *.dedup.bam "$CTRL_BAM" -p {{THREADS}} -o qc/fingerprint.png --plotFileFormat png\nfi\npython3 - <<\'PY\'\nimport json, os\nqc = {}\nif os.path.exists("qc/frip.tsv"):\n    with open("qc/frip.tsv") as fh:\n        for line in fh:\n            s, total, inpeak = line.rstrip("\\n").split("\\t")\n            qc[s] = {"FRiP": round(int(inpeak) / int(total), 4) if int(total) else None}\nwith open("qc/frip_qc.json", "w") as out:\n    json.dump(qc, out, indent=2, ensure_ascii=False)\nPY', notes: 'DAP-seq 的 FRiP 通常显著高于 ChIP-seq（无染色质背景）；指纹图用于确认处理与裸 DNA 对照的富集分离' },
        { title: '基序富集与峰基因注释', command: '#BSUB -J dapseq_motif -n {{THREADS}} -q {{QUEUE}}\nmodule load BEDTools/2.30.0 SAMtools/1.17\ncd {{INPUT_DIR}} && mkdir -p motif annotation\nfor p in peaks/*.peaks.final.bed; do\n  s=$(basename "$p" .peaks.final.bed)\n  awk -F\'\\t\' \'{c=$2+int(($3-$2)/2); print $1"\\t"(c-100>0?c-100:0)"\\t"c+100}\' "$p" > motif/"${s}".summits200.bed\n  bedtools getfasta -fi {{REF_FA}} -bed motif/"${s}".summits200.bed -fo motif/"${s}".summits200.fa\n  if [ -s {{MOTIF_DB}} ] && command -v ame >/dev/null 2>&1; then\n    ame --oc motif/"${s}"_ame --control --shuffle-- {{MOTIF_DB}} motif/"${s}".summits200.fa\n  else\n    echo "SKIP: 未提供 MOTIF_DB 或无 MEME Suite（ame），跳过基序富集"\n  fi\n  if [ -s {{GENES_BED}} ]; then\n    bedtools closest -a "$p" -b {{GENES_BED}} -D ref > annotation/"${s}".nearest_gene.tsv\n  else\n    echo "SKIP: 未提供 GENES_BED，跳过峰基因注释"\n  fi\ndone', notes: '取峰中心 ±100bp 做基序富集（AME，对照用打乱序列）；AME 依赖 MEME Suite（可选）；注释用 bedtools closest 找最近基因及距离' },
        { title: 'Generate analysis report', command: 'python3 <RUN>/tools/encode_native_report.py --run-dir <RUN> --input-dir {{INPUT_DIR}} --report-dir <RUN>/reports/final-report\ntest -s <RUN>/reports/final-report/report.html', notes: '确定性报告生成器直接读取真实产物（QC 指标/峰文件/图）生成图文并茂的 HTML+MD 报告；AI 只需在回复里补充一段结论解读并给出报告绝对路径，不要重写报告文件' },
      ],
      manifest: {
        software: [
          { name: 'FastQC', module: 'FastQC/0.11.9', required: true },
          { name: 'BWA', module: 'BWA/0.7.17', required: true },
          { name: 'SAMtools', module: 'SAMtools/1.17', required: true },
          { name: 'Picard', module: 'Picard/2.27.4', required: true },
          { name: 'MACS2', module: 'MACS2/2.2.7.1', required: true },
          { name: 'BEDTools', module: 'BEDTools/2.30.0', required: true },
          { name: 'deepTools', module: 'deepTools/3.5.1', required: true },
          { name: 'MEME Suite (ame)', checkCmd: 'command -v ame', required: false },
        ],
        references: [
          { name: 'BWA index', path: '{{BWA_INDEX}}', type: 'index', source: '可留空：AI 运行时协助查找或在 02_reference/ 下构建（bwa index）', required: false },
          { name: 'Reference genome FASTA', path: '{{REF_FA}}', type: 'genome', source: '可留空：AI 运行时协助从集群公共库 /share/database/ 匹配', required: false },
          { name: '黑名单 BED（可选）', path: '{{BLACKLIST}}', type: 'other', source: '可留空跳过黑名单过滤', required: false },
          { name: '基因注释 BED/GFF', path: '{{GENES_BED}}', type: 'annotation', source: '可留空：AI 运行时协助从公共库匹配或由 GFF 转换', required: false },
          { name: 'MEME 基序数据库（可选）', path: '{{MOTIF_DB}}', type: 'other', source: '可留空跳过基序富集；植物推荐 JASPAR CORE Plants', required: false },
        ],
        inputHint: 'DAP 文库双端 FASTQ 目录 + 裸 gDNA 对照文库目录（未加 TF 的阴性对照）',
        qcGates: [
          { afterStep: 2, metric: 'FastQC 碱基质量与接头含量', pass: 'Q30 >80%，接头含量 <5%', warn: 'Q30 70-80% 或接头 5-15%' },
          { afterStep: 4, metric: '比对率与去重后保留率', pass: '比对率 >80%，去重后保留 >40%', warn: '比对率 60-80% 或重复率 >80%（DAP 文库重复率偏高需关注）' },
          { afterStep: 6, metric: 'FRiP 与指纹图分离', pass: 'FRiP≥5% 且指纹图处理/对照明显分离', warn: 'FRiP 1-5% 或指纹图分离不清' },
        ],
      },
      provenance: { provider: 'trace-native', sourceName: 'DAP-seq protocol (O’Malley et al. 2016 / Bartlett et al. 2017, TRACE native implementation)', sourceUrl: 'https://github.com/peacezha/TRACE',
        sourceRef: 'native-dapseq-v1', upstreamWorkflow: 'trace-native', implementation: 'reference-extension', importerVersion: 'native-dapseq-v1' },
      source: 'builtin',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'encode-chipseq-histone',
      name: 'ENCODE Histone ChIP-seq Analysis & QC Pipeline',
      description: 'ENCODE histone ChIP-seq pipeline: BWA MEM alignment → filter/dedup → SPP/GEM broad peaks → blacklist removal → cross-replicate IDR consistency.',
      keywords: ['encode', 'chipseq', 'chip-seq', '组蛋白', 'histone', 'h3k27ac', 'h3k4me3', '宽峰', 'spp', 'idr', '质控'],
      params: [
        { name: 'INPUT_DIR', label: 'FASTQ directory (*_R1.fq.gz / *_R2.fq.gz)', type: 'path' },
        { name: 'CONTROL_DIR', label: 'Control FASTQ directory (Input/IgG)', type: 'path', required: false, placeholder: '可留空，AI 运行时协助确认' },
        { name: 'BWA_INDEX', label: 'BWA index prefix', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找或构建' },
        { name: 'REF_FA', label: 'Reference genome FASTA', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找' },
        { name: 'BLACKLIST', label: 'ENCODE blacklist BED', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找' },
        { name: 'GENOME_SIZE', label: 'MACS2 effective genome size (used by the broad-peak path)', defaultValue: 'hs', type: 'text', required: false },
        { name: 'QUEUE', label: 'Queue', defaultValue: 'q2680v2', type: 'select', options: ['q2680v2', 'normal', 'smp', 'high'] },
        { name: 'THREADS', label: 'Threads', defaultValue: '8', type: 'number' },
      ],
      steps: [
        { title: 'Read-only preflight: software, inputs and references', command: 'module av BWA SAMtools Picard FastQC BEDTools 确认可加载；ls -ld {{INPUT_DIR}} {{CONTROL_DIR}}；ls -l {{BWA_INDEX}}.sa {{REF_FA}} {{BLACKLIST}}；缺失先问用户' },
        { title: 'FastQC raw read QC', command: '#BSUB -J histone_qc -n 1 -q {{QUEUE}}\nmodule load FastQC/0.11.9\ncd {{INPUT_DIR}} && mkdir -p fastqc_results\nfastqc *.fq.gz -o ./fastqc_results -t {{THREADS}}', notes: '写成 histone_qc.lsf 后 bsub 提交；先看报告再决定后续' },
        { title: 'BWA MEM alignment and sorting', command: '#BSUB -J histone_align -n {{THREADS}} -q {{QUEUE}}\nmodule load BWA/0.7.17 SAMtools/1.17\ncd {{INPUT_DIR}}\nfor i in *_R1.fq.gz; do\n  s=${i%_R1.fq.gz}\n  bwa mem -t {{THREADS}} {{BWA_INDEX}} "$i" "${s}_R2.fq.gz" | samtools sort -@ {{THREADS}} -o "${s}.sorted.bam" -\ndone', notes: '写成 histone_align.lsf 后 bsub 提交；单端数据只传 R1 一个文件' },
        { title: 'Alignment filtering and PCR dedup', command: '#BSUB -J histone_filter -n {{THREADS}} -q {{QUEUE}}\nmodule load SAMtools/1.17 Picard/2.27.4\ncd {{INPUT_DIR}} && mkdir -p qc\nfor b in *.sorted.bam; do\n  s=${b%.sorted.bam}\n  samtools view -@ {{THREADS}} -b -q 30 -f 2 -F 1804 "$b" > "${s}.filt.bam"\n  samtools sort -@ {{THREADS}} -n "${s}.filt.bam" -o "${s}.filt.nsrt.bam"\n  samtools fixmate -@ {{THREADS}} -m "${s}.filt.nsrt.bam" "${s}.fixmate.bam"\n  samtools sort -@ {{THREADS}} "${s}.fixmate.bam" -o "${s}.fixmate.sorted.bam"\n  java -jar $EBROOTPICARD/picard.jar MarkDuplicates I="${s}.fixmate.sorted.bam" O="${s}.dedup.bam" M=qc/"${s}".dup_metrics.txt REMOVE_DUPLICATES=true\n  samtools index "${s}.dedup.bam"\ndone', notes: 'MAPQ≥30、保留正确配对、去未比对/次要比对/QC 失败 reads；fixmate + MarkDuplicates 去 PCR 重复' },
        { title: 'QC: strand cross-correlation and library complexity', command: '#BSUB -J histone_libqc -n 1 -q {{QUEUE}}\nmodule load SAMtools/1.17\ncd {{INPUT_DIR}} && mkdir -p qc\nfor b in *.dedup.bam; do\n  s=${b%.dedup.bam}\n  run_spp.R -c="$b" -savp -p {{THREADS}} -out=qc/"${s}".cc.qc\ndone\npython3 - <<\'PY\'\nimport glob, json, os\nqc = {}\nfor cc in glob.glob("qc/*.cc.qc"):\n    s = os.path.basename(cc).replace(".cc.qc", "")\n    with open(cc) as fh:\n        header = fh.readline().rstrip("\\n").split("\\t")\n        row = fh.readline().rstrip("\\n").split("\\t")\n    rec = dict(zip(header, row))\n    nrf = None\n    dup = os.path.join("qc", s + ".dup_metrics.txt")\n    if os.path.exists(dup):\n        with open(dup) as fh:\n            for line in fh:\n                if line.startswith("#") or line.startswith("LIBRARY") or not line.strip():\n                    continue\n                cols = line.rstrip("\\n").split("\\t")\n                examined = int(cols[1]) + 2 * int(cols[2])\n                duplicates = int(cols[5]) + 2 * int(cols[6])\n                nrf = round(1 - duplicates / examined, 4) if examined else None\n                break\n    qc[s] = {"NSC": rec.get("NSC"), "RSC": rec.get("RSC"), "NRF": nrf}\nwith open("qc/qc.json", "w") as out:\n    json.dump(qc, out, indent=2, ensure_ascii=False)\nPY', notes: '达标：NSC≥1.05、RSC≥0.8、NRF≥0.8；警告：NSC 1.0-1.05、RSC 0.5-0.8、NRF 0.6-0.8' },
        { title: 'SPP broad-peak calling and blacklist filtering', command: '#BSUB -J histone_peak -n {{THREADS}} -q {{QUEUE}}\nmodule load BEDTools/2.30.0\ncd {{INPUT_DIR}} && mkdir -p peaks\nCTRL=$(ls {{CONTROL_DIR}}/*.dedup.bam 2>/dev/null | head -1 || true)\nfor b in *.dedup.bam; do\n  s=${b%.dedup.bam}\n  run_spp.R -c="$b" ${CTRL:+-i="$CTRL"} -npeak=300000 -odir=peaks -speak=peaks/"${s}" -savp -rf\n  zcat peaks/"${s}".regionPeak.gz > peaks/"${s}".regionPeak\n  bedtools intersect -a peaks/"${s}".regionPeak -b {{BLACKLIST}} -v > peaks/"${s}".peaks.final.bed\ndone', notes: '写成 histone_peak.lsf 后 bsub 提交；SPP 宽峰适合 H3K27ac/H3K36me3 等宽域修饰；备选：macs2 callpeak --broad --broad-cutoff 0.1（需 MACS2 与 {{GENOME_SIZE}}）或 GEM' },
        { title: 'QC: RPKM bigWig tracks, SPOT and peak snapshots', command: '#BSUB -J chipseq_track_qc -n {{THREADS}} -q {{QUEUE}}\nmodule load deepTools/3.5.1 SAMtools/1.17 BEDTools/2.30.0\ncd {{INPUT_DIR}} && mkdir -p qc/tracks qc/igv\nfor b in *.dedup.bam; do\n  s=${b%.dedup.bam}\n  bamCoverage -b "$b" -o qc/tracks/"${s}".rpkm.bw -p {{THREADS}} --normalizeUsing RPKM\ndone\nfor b in *.dedup.bam; do\n  s=${b%.dedup.bam}\n  if command -v hotspot2 >/dev/null 2>&1; then\n    mkdir -p hotspots\n    samtools view -H "$b" | awk -F\'\\t\' \'/^@SQ/{split($2,a,":");split($3,c,":");print a[2]"\\t"c[2]}\' > qc/chrom.sizes\n    hotspot2 -c qc/chrom.sizes "$b" hotspots/"${s}"\n    total=$(samtools view -c "$b")\n    inhot=$(bedtools intersect -a "$b" -b hotspots/"${s}".hotspots.fdr0.05.bed -u | samtools view -c - || true)\n    echo -e "${s}\\t${total}\\t${inhot}" >> qc/spot.tsv\n  else\n    echo "SKIP: hotspot2 不可用，跳过 SPOT（module load 或一键部署 hotspot2 即可启用）"\n  fi\ndone\npython3 - <<\'PY\'\nBAM_GLOB = "*.dedup.bam"\nBAM_SUFFIX = ".dedup.bam"\nPEAK_DIR = "peaks/"\nPEAK_SUFFIX = ".peaks.final.bed"\nimport glob, os, random, subprocess, sys\ntry:\n    import matplotlib\n    matplotlib.use("Agg")\n    import matplotlib.pyplot as plt\nexcept Exception as exc:\n    print("SKIP: 无 matplotlib，跳过峰快照绘图（%s）" % exc)\n    sys.exit(0)\nos.makedirs("qc/igv", exist_ok=True)\nmade = 0\nfor bam in sorted(glob.glob(BAM_GLOB)):\n    s = bam[: -len(BAM_SUFFIX)]\n    peak_file = PEAK_DIR + s + PEAK_SUFFIX\n    if not os.path.exists(peak_file):\n        continue\n    peaks = []\n    with open(peak_file) as fh:\n        for line in fh:\n            if line.startswith("#"):\n                continue\n            f = line.rstrip("\\n").split("\\t")\n            if len(f) >= 3:\n                try:\n                    peaks.append((f[0], int(f[1]), int(f[2])))\n                except ValueError:\n                    pass\n    if not peaks:\n        continue\n    random.seed(42)\n    for chrom, start, end in random.sample(peaks, min(5, len(peaks))):\n        a, b = max(0, start - 1500), end + 1500\n        out = subprocess.run(["samtools", "depth", "-a", "-r", "%s:%d-%d" % (chrom, a, b), bam], capture_output=True, text=True)\n        cov = {}\n        for line in out.stdout.splitlines():\n            f = line.split("\\t")\n            if len(f) >= 3:\n                cov[int(f[1])] = int(f[2])\n        xs = list(range(a, b + 1))\n        ys = [cov.get(x, 0) for x in xs]\n        fig, ax = plt.subplots(figsize=(8, 2.4))\n        ax.fill_between(xs, ys, color="#3b82f6", lw=0)\n        ax.axvspan(start, end, color="#f59e0b", alpha=0.25)\n        ax.set_title("%s  %s:%d-%d" % (s, chrom, start, end))\n        ax.set_xlabel(chrom)\n        ax.set_ylabel("depth")\n        ax.margins(x=0)\n        fig.tight_layout()\n        fig.savefig("qc/igv/%s_%s_%d.png" % (s, chrom, start), dpi=120)\n        plt.close(fig)\n        made += 1\nprint("IGV 风格峰快照产出 %d 张 → qc/igv/" % made)\nPY', notes: 'TRACE 对 ENCODE 基线的扩展：RPKM 标准化 bigWig（qc/tracks/*.rpkm.bw）可直接拖进 IGV/基因组浏览器；SPOT 需 hotspot2（缺失自动 SKIP）；随机抽 5 个峰画 IGV 风格覆盖图到 qc/igv/（需 matplotlib，缺失自动 SKIP；固定随机种子 42 可复现）' },
        { title: 'QC: FRiP and cross-replicate IDR consistency', command: '#BSUB -J histone_idr -n {{THREADS}} -q {{QUEUE}}\nmodule load SAMtools/1.17 BEDTools/2.30.0\ncd {{INPUT_DIR}} && mkdir -p idr qc\nfor b in *.dedup.bam; do\n  s=${b%.dedup.bam}\n  total=$(samtools view -c "$b")\n  inpeak=$(bedtools intersect -a "$b" -b peaks/"${s}".peaks.final.bed -u | samtools view -c -)\n  echo -e "${s}\\t${total}\\t${inpeak}" >> qc/frip.tsv\ndone\nmapfile -t PK < <(ls peaks/*.peaks.final.bed 2>/dev/null || ls *.peaks.final.bed 2>/dev/null)\nif [ "${#PK[@]}" -lt 2 ]; then\n  echo "SKIP: 需要至少 2 个重复 peaks 才能算 IDR"\nelse\n  POOL=$(ls peaks/*pool*.peaks.final.bed 2>/dev/null | head -1 || true)\n  idr --samples "${PK[0]}" "${PK[1]}" ${POOL:+--peak-list "$POOL"} --input-file-type broadPeak --rank p.value -o idr/idr.txt --plot\nfi\npython3 - <<\'PY\'\nimport json, os\nqc = {}\nif os.path.exists("qc/frip.tsv"):\n    with open("qc/frip.tsv") as fh:\n        for line in fh:\n            s, total, inpeak = line.rstrip("\\n").split("\\t")\n            qc[s] = {"FRiP": round(int(inpeak) / int(total), 4) if int(total) else None}\nn_idr = None\nif os.path.exists("idr/idr.txt"):\n    n_idr = 0\n    with open("idr/idr.txt") as fh:\n        for line in fh:\n            cols = line.rstrip("\\n").split("\\t")\n            try:\n                if float(cols[10]) < 0.05:\n                    n_idr += 1\n            except (IndexError, ValueError):\n                continue\nqc["_idr"] = {"peaks_global_idr_lt_0.05": n_idr, "rule": "Np(伪重复)/Nt(真重复) < 2 达标，>= 2 判重复间不一致"}\nwith open("qc/idr_qc.json", "w") as out:\n    json.dump(qc, out, indent=2, ensure_ascii=False)\nPY', notes: '达标：FRiP≥1%、IDR Np/Nt<2；警告：FRiP 0.5-1%；重复≥2 用真重复 IDR，单重复用伪重复 IDR' },
        { title: 'Generate analysis report', command: 'python3 <RUN>/tools/encode_native_report.py --run-dir <RUN> --input-dir {{INPUT_DIR}} --report-dir <RUN>/reports/final-report\ntest -s <RUN>/reports/final-report/report.html', notes: '确定性报告生成器直接读取真实产物（QC 指标/峰文件/图）生成图文并茂的 HTML+MD 报告；AI 只需在回复里补充一段结论解读并给出报告绝对路径，不要重写报告文件' },
      ],
      manifest: {
        software: [
          { name: 'FastQC', module: 'FastQC/0.11.9', required: true },
          { name: 'BWA', module: 'BWA/0.7.17', required: true },
          { name: 'SAMtools', module: 'SAMtools/1.17', required: true },
          { name: 'Picard', module: 'Picard/2.27.4', required: true },
          { name: 'BEDTools', module: 'BEDTools/2.30.0', required: true },
          { name: 'deepTools', module: 'deepTools/3.5.1', required: true },
          { name: 'hotspot2', checkCmd: 'command -v hotspot2', required: false },
          { name: 'phantompeakqualtools (run_spp.R, broad mode)', checkCmd: 'command -v run_spp.R', required: true },
          { name: 'MACS2 (broad-peak fallback)', module: 'MACS2/2.2.7.1', required: false },
          { name: 'GEM (broad-peak fallback)', checkCmd: 'command -v gem', required: false },
          { name: 'IDR', checkCmd: 'command -v idr', required: false },
        ],
        references: [
          { name: 'BWA index', path: '{{BWA_INDEX}}', type: 'index', source: '可留空：AI 运行时协助查找或在 02_reference/ 下构建（bwa index）', required: false },
          { name: 'Reference genome FASTA', path: '{{REF_FA}}', type: 'genome', source: '可留空：AI 运行时协助从集群公共库 /share/database/ 匹配', required: false },
          { name: 'ENCODE blacklist BED', path: '{{BLACKLIST}}', type: 'other', source: '可留空：AI 运行时协助按基因组版本下载（ENCODE blacklist）', required: false },
        ],
        inputHint: 'Paired-end histone ChIP-seq FASTQ directory, plus an Input/IgG control directory',
        qcGates: [
          { afterStep: 2, metric: 'FastQC 碱基质量与接头含量', pass: 'Q30 >80%，接头含量 <5%', warn: 'Q30 70-80% 或接头 5-15%' },
          { afterStep: 4, metric: '比对率与去重后保留率', pass: '比对率 >80%，去重后保留 >50%', warn: '比对率 60-80% 或重复率 >70%' },
          { afterStep: 5, metric: '链相关与库复杂度', pass: 'NSC≥1.05、RSC≥0.8、NRF≥0.8', warn: 'NSC 1.0-1.05、RSC 0.5-0.8 或 NRF 0.6-0.8' },
          { afterStep: 8, metric: 'FRiP 与重复间 IDR', pass: 'FRiP≥1%，Np/Nt<2', warn: 'FRiP 0.5-1%' },
        ],
      },
      provenance: { provider: 'trace-native', sourceName: 'ENCODE histone ChIP-seq protocol (TRACE native implementation)', sourceUrl: 'https://github.com/peacezha/TRACE',
        sourceRef: 'native-encode-v1', upstreamWorkflow: 'trace-native', implementation: 'reference-extension', importerVersion: 'native-encode-v1' },
      source: 'builtin',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'encode-rnaseq-bulk',
      name: 'ENCODE Bulk RNA-seq Analysis & QC Pipeline',
      description: 'ENCODE bulk RNA-seq pipeline: FastQC → STAR alignment (PE/SE, stranded/unstranded) → RSEM quantification (gene/isoform TPM/FPKM) → alignment rate, rRNA fraction and cross-replicate correlation.',
      keywords: ['encode', 'rnaseq', 'rna-seq', 'bulk', '转录组', 'star', 'rsem', 'tpm', 'fpkm', '定量', '质控'],
      params: [
        { name: 'INPUT_DIR', label: 'FASTQ directory (*_R1.fq.gz / *_R2.fq.gz)', type: 'path' },
        { name: 'STAR_INDEX', label: 'STAR genome index directory', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找或构建' },
        { name: 'RSEM_INDEX', label: 'RSEM index prefix', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找或构建' },
        { name: 'GTF', label: 'Gene annotation GTF path', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找' },
        { name: 'LAYOUT', label: 'Layout', defaultValue: 'paired', type: 'select', options: ['paired', 'single'] },
        { name: 'STRANDEDNESS', label: 'Strandedness', defaultValue: 'unstranded', type: 'select', options: ['unstranded', 'forward', 'reverse'] },
        { name: 'QUEUE', label: 'Queue', defaultValue: 'q2680v2', type: 'select', options: ['q2680v2', 'normal', 'smp', 'high'] },
        { name: 'THREADS', label: 'Threads', defaultValue: '8', type: 'number' },
      ],
      steps: [
        { title: 'Read-only preflight: software, inputs and references', command: 'module av STAR RSEM FastQC SAMtools Picard RSeQC 确认可加载；ls -ld {{INPUT_DIR}}；ls -d {{STAR_INDEX}} {{RSEM_INDEX}}；ls -l {{GTF}}；缺失先问用户' },
        { title: 'FastQC raw read QC', command: '#BSUB -J rnaseq_qc -n 1 -q {{QUEUE}}\nmodule load FastQC/0.11.9\ncd {{INPUT_DIR}} && mkdir -p fastqc_results\nfastqc *.fq.gz -o ./fastqc_results -t {{THREADS}}', notes: '写成 rnaseq_qc.lsf 后 bsub 提交；先看报告再决定后续' },
        { title: 'STAR alignment', command: '#BSUB -J rnaseq_star -n {{THREADS}} -q {{QUEUE}}\nmodule load STAR/2.7.10b\ncd {{INPUT_DIR}}\nfor i in *_R1.fq.gz; do\n  s=${i%_R1.fq.gz}\n  STAR --runThreadN {{THREADS}} --genomeDir {{STAR_INDEX}} --readFilesIn "$i" "${s}_R2.fq.gz" --readFilesCommand zcat --outSAMtype BAM SortedByCoordinate --quantMode TranscriptomeSAM GeneCounts --outFilterMultimapNmax 20 --outFilterMismatchNmax 999 --outFilterMismatchNoverLmax 0.04 --alignIntronMin 20 --alignIntronMax 1000000 --alignMatesGapMax 1000000 --outFileNamePrefix "${s}."\ndone', notes: '写成 rnaseq_star.lsf 后 bsub 提交；{{LAYOUT}}=single 时 --readFilesIn 只传 R1；链特异性由 {{STRANDEDNESS}} 决定 RSEM 参数' },
        { title: 'RSEM gene and isoform quantification', command: '#BSUB -J rnaseq_rsem -n {{THREADS}} -q {{QUEUE}}\nmodule load RSEM/1.3.3\ncd {{INPUT_DIR}}\nfor t in *.Aligned.toTranscriptome.out.bam; do\n  s=${t%.Aligned.toTranscriptome.out.bam}\n  rsem-calculate-expression --bam --estimate-rspd --calc-ci --seed 12345 -p {{THREADS}} --paired-end "$t" {{RSEM_INDEX}} "${s}.rsem"\ndone', notes: '写成 rnaseq_rsem.lsf 后 bsub 提交；{{STRANDEDNESS}}=forward/reverse 时分别加 --forward-prob 1/0；{{LAYOUT}}=single 时去掉 --paired-end；产出 gene/isoform 级 TPM/FPKM' },
        { title: 'QC: alignment rate, rRNA fraction and duplication', command: '#BSUB -J rnaseq_align_qc -n 1 -q {{QUEUE}}\nmodule load SAMtools/1.17 Picard/2.27.4\ncd {{INPUT_DIR}} && mkdir -p qc\nfor b in *.Aligned.sortedByCoord.out.bam; do\n  s=${b%.Aligned.sortedByCoord.out.bam}\n  samtools flagstat "$b" > qc/"${s}".flagstat.txt\n  REFFLAT=qc/genes.refFlat\n  if [ ! -s "$REFFLAT" ] && command -v gtfToGenePred >/dev/null 2>&1; then\n    gtfToGenePred -genePredExt {{GTF}} "$REFFLAT" || true\n  fi\n  if [ ! -s "$REFFLAT" ]; then\n    echo "SKIP: 无 refFlat，跳过 RnaSeqMetrics"\n    continue\n  fi\n  RIBO=""\n  [ -s qc/rrna.intervals ] && RIBO="RIBOSOMAL_INTERVALS=qc/rrna.intervals"\n  java -jar $EBROOTPICARD/picard.jar CollectRnaSeqMetrics I="$b" O=qc/"${s}".rnaseq_metrics.txt REF_FLAT="$REFFLAT" $RIBO\ndone\npython3 - <<\'PY\'\nimport glob, json, os\nqc = {}\nfor f in glob.glob("qc/*.flagstat.txt"):\n    s = os.path.basename(f).replace(".flagstat.txt", "")\n    total = mapped = 0\n    with open(f) as fh:\n        for line in fh:\n            if "in total" in line:\n                total = int(line.split()[0])\n            elif "mapped (" in line and "primary" not in line:\n                mapped = int(line.split()[0])\n    qc[s] = {"total_reads": total, "mapped": mapped, "mapping_rate": round(mapped / total, 4) if total else None}\nwith open("qc/qc.json", "w") as out:\n    json.dump(qc, out, indent=2, ensure_ascii=False)\nPY', notes: '达标：总比对率 >70%；警告：50-70%；<50% 检查污染或建库失败；rRNA 占比 <10% 为理想；REF_FLAT 用 gtfToGenePred 由 GTF 生成' },
        { title: 'QC: cross-replicate expression correlation and gene-body coverage', command: '#BSUB -J rnaseq_rep_qc -n 1 -q {{QUEUE}}\nmodule load RSeQC\ncd {{INPUT_DIR}} && mkdir -p qc\nBAMS=$(ls *.Aligned.sortedByCoord.out.bam 2>/dev/null | tr \'\\n\' \',\' | sed \'s/,$//\' || true)\nBED12=qc/genes.bed12\nif [ ! -s "$BED12" ] && command -v gtfToGenePred >/dev/null 2>&1 && command -v genePredToBed >/dev/null 2>&1; then\n  gtfToGenePred -genePredExt {{GTF}} qc/genes.genePred && genePredToBed qc/genes.genePred "$BED12" || true\nfi\nif [ -z "$BAMS" ] || [ ! -s "$BED12" ]; then\n  echo "SKIP: 缺少比对 BAM 或基因注释 BED12，跳过 geneBody 覆盖评估"\nelse\n  geneBody_coverage.py -i "$BAMS" -r "$BED12" -o qc/genebody\nfi\npython3 - <<\'PY\'\nimport glob, json\n\ndef tpm_col(path):\n    vals = []\n    with open(path) as fh:\n        fh.readline()\n        for line in fh:\n            vals.append(float(line.split("\\t")[5]))\n    return vals\n\ndef rank(xs):\n    order = sorted(range(len(xs)), key=lambda i: xs[i])\n    r = [0.0] * len(xs)\n    for pos, i in enumerate(order):\n        r[i] = pos + 1\n    return r\n\ndef pearson(a, b):\n    n = len(a)\n    ma, mb = sum(a) / n, sum(b) / n\n    num = sum((x - ma) * (y - mb) for x, y in zip(a, b))\n    den = (sum((x - ma) ** 2 for x in a) * sum((y - mb) ** 2 for y in b)) ** 0.5\n    return num / den if den else 0.0\n\nfiles = sorted(glob.glob("*.rsem.genes.results"))\nqc = {"spearman": {}}\nfor i in range(len(files)):\n    for j in range(i + 1, len(files)):\n        a, b = tpm_col(files[i]), tpm_col(files[j])\n        qc["spearman"][files[i] + " vs " + files[j]] = round(pearson(rank(a), rank(b)), 4)\nwith open("qc/rep_qc.json", "w") as out:\n    json.dump(qc, out, indent=2, ensure_ascii=False)\nPY', notes: '达标：重复间 Spearman >0.9、gene body 覆盖均匀无 5\'/3\' 明显偏倚；警告：Spearman 0.8-0.9' },
        { title: 'Generate analysis report', command: 'python3 <RUN>/tools/encode_native_report.py --run-dir <RUN> --input-dir {{INPUT_DIR}} --report-dir <RUN>/reports/final-report\ntest -s <RUN>/reports/final-report/report.html', notes: '确定性报告生成器直接读取真实产物（QC 指标/峰文件/图）生成图文并茂的 HTML+MD 报告；AI 只需在回复里补充一段结论解读并给出报告绝对路径，不要重写报告文件' },
      ],
      manifest: {
        software: [
          { name: 'FastQC', module: 'FastQC/0.11.9', required: true },
          { name: 'STAR', module: 'STAR/2.7.10b', required: true },
          { name: 'RSEM', module: 'RSEM/1.3.3', required: true },
          { name: 'SAMtools', module: 'SAMtools/1.17', required: true },
          { name: 'Picard', module: 'Picard/2.27.4', required: true },
          { name: 'RSeQC', checkCmd: 'command -v geneBody_coverage.py', required: false },
        ],
        references: [
          { name: 'STAR genome index', path: '{{STAR_INDEX}}', type: 'index', source: '可留空：AI 运行时协助查找或在 02_reference/ 下构建（STAR --runMode genomeGenerate）', required: false },
          { name: 'RSEM index', path: '{{RSEM_INDEX}}', type: 'index', source: '可留空：AI 运行时协助查找或构建（rsem-prepare-reference）', required: false },
          { name: 'Gene annotation GTF', path: '{{GTF}}', type: 'annotation', source: '可留空：AI 运行时协助从集群公共库 /share/database/ 匹配', required: false },
        ],
        inputHint: 'Bulk RNA-seq FASTQ directory (paired *_R1.fq.gz / *_R2.fq.gz or single-end *.fq.gz)',
        qcGates: [
          { afterStep: 2, metric: 'FastQC 碱基质量与接头含量', pass: 'Q30 >80%，接头含量 <5%', warn: 'Q30 70-80% 或接头 5-15%' },
          { afterStep: 5, metric: '比对率与 rRNA 占比', pass: '比对率 >70%，rRNA 占比 <10%', warn: '比对率 50-70% 或 rRNA 10-30%' },
          { afterStep: 6, metric: '重复间表达一致性', pass: 'Spearman >0.9', warn: '0.8-0.9' },
        ],
      },
      provenance: { provider: 'trace-native', sourceName: 'ENCODE bulk RNA-seq protocol (TRACE native implementation)', sourceUrl: 'https://github.com/peacezha/TRACE',
        sourceRef: 'native-encode-v1', upstreamWorkflow: 'trace-native', implementation: 'reference-extension', importerVersion: 'native-encode-v1' },
      source: 'builtin',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'encode-atacseq',
      name: 'ENCODE ATAC-seq Analysis & QC Pipeline',
      description: 'ENCODE ATAC-seq pipeline: FastQC → Bowtie2 alignment → filtering (organelle removal, MAPQ≥30, dedup, blacklist) → Tn5 shift correction → MACS2 peaks → TSS enrichment and fragment-size distribution.',
      keywords: ['encode', 'atacseq', 'atac-seq', '染色质可及性', 'bowtie2', 'macs2', 'tss富集', 'frip', 'tn5', '质控'],
      params: [
        { name: 'INPUT_DIR', label: 'FASTQ directory (*_R1.fq.gz / *_R2.fq.gz)', type: 'path' },
        { name: 'BOWTIE2_INDEX', label: 'Bowtie2 index prefix', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找或构建' },
        { name: 'REF_FA', label: 'Reference genome FASTA', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找' },
        { name: 'BLACKLIST', label: 'ENCODE blacklist BED', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找' },
        { name: 'TSS_BED', label: 'TSS annotation BED (for TSS enrichment)', type: 'path', required: false, placeholder: '可留空，AI 运行时协助由 GTF 生成' },
        { name: 'GENOME_SIZE', label: 'MACS2 effective genome size', defaultValue: 'hs', type: 'text', required: false },
        { name: 'ORGANELLE_REGEX', label: 'Organelle chromosome pattern (mitochondria + chloroplast)', defaultValue: 'chrM|chrMT|chrC|chrPt|ChrM|ChrMt|ChrC|ChrPt|mitochondria|chloroplast|plastid', type: 'text', required: false, help: 'ENCODE 原版只去线粒体；植物样本必须同时去叶绿体。按参考基因组的细胞器染色体命名调整；清空则保留细胞器 reads' },
        { name: 'QUEUE', label: 'Queue', defaultValue: 'q2680v2', type: 'select', options: ['q2680v2', 'normal', 'smp', 'high'] },
        { name: 'THREADS', label: 'Threads', defaultValue: '8', type: 'number' },
      ],
      steps: [
        { title: 'Read-only preflight: software, inputs and references', command: 'module av FastQC Bowtie2 MACS2 SAMtools Picard deepTools BEDTools 确认可加载；ls -ld {{INPUT_DIR}}；ls -l {{BOWTIE2_INDEX}}.1.bt2 {{REF_FA}} {{BLACKLIST}} {{TSS_BED}}；缺失先问用户' },
        { title: 'FastQC raw read QC', command: '#BSUB -J atac_qc -n 1 -q {{QUEUE}}\nmodule load FastQC/0.11.9\ncd {{INPUT_DIR}} && mkdir -p fastqc_results\nfastqc *.fq.gz -o ./fastqc_results -t {{THREADS}}', notes: '写成 atac_qc.lsf 后 bsub 提交；先看报告再决定后续' },
        { title: 'Bowtie2 alignment and sorting', command: '#BSUB -J atac_align -n {{THREADS}} -q {{QUEUE}}\nmodule load Bowtie2/2.4.5 SAMtools/1.17\ncd {{INPUT_DIR}}\nfor i in *_R1.fq.gz; do\n  s=${i%_R1.fq.gz}\n  bowtie2 -p {{THREADS}} -X 2000 --very-sensitive -x {{BOWTIE2_INDEX}} -1 "$i" -2 "${s}_R2.fq.gz" | samtools sort -@ {{THREADS}} -o "${s}.sorted.bam" -\ndone', notes: '写成 atac_align.lsf 后 bsub 提交；-X 2000 允许长片段' },
        { title: 'Filtering (organelle/mito+chloroplast removal, MAPQ≥30, dedup, blacklist)', command: '#BSUB -J atac_filter -n {{THREADS}} -q {{QUEUE}}\nmodule load SAMtools/1.17 Picard/2.27.4 BEDTools/2.30.0\ncd {{INPUT_DIR}} && mkdir -p qc\nfor b in *.sorted.bam; do\n  s=${b%.sorted.bam}\n  total=$(samtools view -c "$b")\n  mito=$(samtools view "$b" | grep -cE \'chrM|chrMT|ChrM|ChrMt|mitochondria\' || true)\n  chloro=$(samtools view "$b" | grep -cE \'chrC|chrPt|ChrC|ChrPt|chloroplast|plastid\' || true)\n  if [ -n "{{ORGANELLE_REGEX}}" ]; then org=$(samtools view "$b" | grep -cE "{{ORGANELLE_REGEX}}" || true); else org=0; fi\n  echo -e "${s}\\t${total}\\t${mito}\\t${chloro}\\t${org}" >> qc/organelle.tsv\n  if [ -n "{{ORGANELLE_REGEX}}" ]; then\n    samtools view -@ {{THREADS}} -h -q 30 -F 1804 "$b" | { grep -vE "{{ORGANELLE_REGEX}}" || true; } | samtools view -@ {{THREADS}} -b - > "${s}.noorg.bam"\n  else\n    samtools view -@ {{THREADS}} -b -q 30 -F 1804 "$b" > "${s}.noorg.bam"\n  fi\n  java -jar $EBROOTPICARD/picard.jar MarkDuplicates I="${s}.noorg.bam" O="${s}.dedup.bam" M=qc/"${s}".dup_metrics.txt REMOVE_DUPLICATES=true\n  bedtools intersect -a "${s}.dedup.bam" -b {{BLACKLIST}} -v > "${s}.final.bam"\n  samtools index "${s}.final.bam"\ndone', notes: 'ENCODE 原版只去线粒体（chrM）；植物样本必须同时去叶绿体——去除模式由 ORGANELLE_REGEX 全局参数控制（默认覆盖线粒体/叶绿体常见命名，清空则保留细胞器 reads）。MAPQ≥30、去未比对/次要/QC 失败 reads；MarkDuplicates 去重；bedtools 去黑名单；organelle.tsv 记录线粒体/叶绿体/合计占比' },
        { title: 'Tn5 shift correction and MACS2 peak calling', command: '#BSUB -J atac_peak -n {{THREADS}} -q {{QUEUE}}\nmodule load deepTools/3.5.1 MACS2/2.2.7.1 SAMtools/1.17\ncd {{INPUT_DIR}} && mkdir -p peaks\nfor b in *.final.bam; do\n  s=${b%.final.bam}\n  alignmentSieve -b "$b" -o "${s}.shifted.bam" --ATACshift --numberOfProcessors {{THREADS}}\n  samtools index "${s}.shifted.bam"\n  macs2 callpeak -t "${s}.shifted.bam" -f BAMPE -n "${s}" -g {{GENOME_SIZE}} --nomodel --shift -75 --extsize 150 -q 0.01 --outdir peaks\ndone', notes: 'Tn5 偏移 +4/-5 bp 由 alignmentSieve --ATACshift 完成；无 deepTools 时在 BED 层平移替代' },
        { title: 'QC: TSS enrichment, FRiP, SPOT, signal tracks and peak snapshots', command: '#BSUB -J atac_tss_qc -n {{THREADS}} -q {{QUEUE}}\nmodule load deepTools/3.5.1 Picard/2.27.4 SAMtools/1.17 BEDTools/2.30.0\ncd {{INPUT_DIR}} && mkdir -p qc qc/tracks qc/igv\nfor b in *.final.bam; do\n  s=${b%.final.bam}\n  bamCoverage -b "$b" -o qc/tracks/"${s}".rpkm.bw -p {{THREADS}} --normalizeUsing RPKM\n  computeMatrix reference-point -S "${s}".bw -R {{TSS_BED}} -a 2000 -b 2000 -p {{THREADS}} -o qc/"${s}".tss.mat.gz\n  plotProfile -m qc/"${s}".tss.mat.gz -o qc/"${s}".tss_enrichment.png\n  java -jar $EBROOTPICARD/picard.jar CollectInsertSizeMetrics I="$b" O=qc/"${s}".insert_size_metrics.txt H=qc/"${s}".insert_size.png\n  total=$(samtools view -c "$b")\n  inpeak=$(bedtools intersect -a "$b" -b peaks/"${s}"_peaks.narrowPeak -u | samtools view -c - || true)\n  echo -e "${s}\\t${total}\\t${inpeak}" >> qc/frip.tsv\n  if command -v hotspot2 >/dev/null 2>&1; then\n    mkdir -p hotspots\n    samtools view -H "$b" | awk -F\'\\t\' \'/^@SQ/{split($2,a,":");split($3,c,":");print a[2]"\\t"c[2]}\' > qc/chrom.sizes\n    hotspot2 -c qc/chrom.sizes "$b" hotspots/"${s}"\n    inhot=$(bedtools intersect -a "$b" -b hotspots/"${s}".hotspots.fdr0.05.bed -u | samtools view -c - || true)\n    echo -e "${s}\\t${total}\\t${inhot}" >> qc/spot.tsv\n  else\n    echo "SKIP: hotspot2 不可用，跳过 SPOT（FRiP 已覆盖类似信息；module load 或一键部署 hotspot2 即可启用）"\n  fi\ndone\npython3 - <<\'PY\'\nBAM_GLOB = "*.final.bam"\nBAM_SUFFIX = ".final.bam"\nPEAK_DIR = "peaks/"\nPEAK_SUFFIX = "_peaks.narrowPeak"\nimport glob, os, random, subprocess, sys\ntry:\n    import matplotlib\n    matplotlib.use("Agg")\n    import matplotlib.pyplot as plt\nexcept Exception as exc:\n    print("SKIP: 无 matplotlib，跳过峰快照绘图（%s）" % exc)\n    sys.exit(0)\nos.makedirs("qc/igv", exist_ok=True)\nmade = 0\nfor bam in sorted(glob.glob(BAM_GLOB)):\n    s = bam[: -len(BAM_SUFFIX)]\n    peak_file = PEAK_DIR + s + PEAK_SUFFIX\n    if not os.path.exists(peak_file):\n        continue\n    peaks = []\n    with open(peak_file) as fh:\n        for line in fh:\n            if line.startswith("#"):\n                continue\n            f = line.rstrip("\\n").split("\\t")\n            if len(f) >= 3:\n                try:\n                    peaks.append((f[0], int(f[1]), int(f[2])))\n                except ValueError:\n                    pass\n    if not peaks:\n        continue\n    random.seed(42)\n    for chrom, start, end in random.sample(peaks, min(5, len(peaks))):\n        a, b = max(0, start - 1500), end + 1500\n        out = subprocess.run(["samtools", "depth", "-a", "-r", "%s:%d-%d" % (chrom, a, b), bam], capture_output=True, text=True)\n        cov = {}\n        for line in out.stdout.splitlines():\n            f = line.split("\\t")\n            if len(f) >= 3:\n                cov[int(f[1])] = int(f[2])\n        xs = list(range(a, b + 1))\n        ys = [cov.get(x, 0) for x in xs]\n        fig, ax = plt.subplots(figsize=(8, 2.4))\n        ax.fill_between(xs, ys, color="#3b82f6", lw=0)\n        ax.axvspan(start, end, color="#f59e0b", alpha=0.25)\n        ax.set_title("%s  %s:%d-%d" % (s, chrom, start, end))\n        ax.set_xlabel(chrom)\n        ax.set_ylabel("depth")\n        ax.margins(x=0)\n        fig.tight_layout()\n        fig.savefig("qc/igv/%s_%s_%d.png" % (s, chrom, start), dpi=120)\n        plt.close(fig)\n        made += 1\nprint("IGV 风格峰快照产出 %d 张 → qc/igv/" % made)\nPY\npython3 - <<\'PY\'\nimport json, os\nqc = {}\nif os.path.exists("qc/organelle.tsv"):\n    with open("qc/organelle.tsv") as fh:\n        for line in fh:\n            parts = line.rstrip("\\n").split("\\t")\n            if len(parts) < 5:\n                continue\n            s, total, mito, chloro, org = parts[:5]\n            if int(total):\n                entry = qc.setdefault(s, {})\n                entry["mito_rate"] = round(int(mito) / int(total), 4)\n                entry["chloro_rate"] = round(int(chloro) / int(total), 4)\n                entry["organelle_rate"] = round(int(org) / int(total), 4)\nif os.path.exists("qc/frip.tsv"):\n    with open("qc/frip.tsv") as fh:\n        for line in fh:\n            s, total, inpeak = line.rstrip("\\n").split("\\t")\n            qc.setdefault(s, {})["FRiP"] = round(int(inpeak) / int(total), 4) if int(total) else None\nif os.path.exists("qc/spot.tsv"):\n    with open("qc/spot.tsv") as fh:\n        for line in fh:\n            s, total, inhot = line.rstrip("\\n").split("\\t")\n            qc.setdefault(s, {})["SPOT"] = round(int(inhot) / int(total), 4) if int(total) else None\nwith open("qc/qc.json", "w") as out:\n    json.dump(qc, out, indent=2, ensure_ascii=False)\nPY', notes: '达标：TSS enrichment >6（>10 理想）、FRiP≥0.2、SPOT≥0.3（hotspot2 可用时才计算，缺失自动 SKIP）、NRF>0.8、细胞器（线粒体+叶绿体）占比 <20%；TSS 分数取 tss.mat.gz 中心/侧翼均值比；insert_size 图应呈核小体周期性；RPKM bigWig 在 qc/tracks/，随机 5 个峰的 IGV 风格快照在 qc/igv/（需 matplotlib，缺失自动 SKIP）' },
        { title: 'Generate analysis report', command: 'python3 <RUN>/tools/encode_native_report.py --run-dir <RUN> --input-dir {{INPUT_DIR}} --report-dir <RUN>/reports/final-report\ntest -s <RUN>/reports/final-report/report.html', notes: '确定性报告生成器直接读取真实产物（QC 指标/峰文件/图）生成图文并茂的 HTML+MD 报告；AI 只需在回复里补充一段结论解读并给出报告绝对路径，不要重写报告文件' },
      ],
      manifest: {
        software: [
          { name: 'FastQC', module: 'FastQC/0.11.9', required: true },
          { name: 'Bowtie2', module: 'Bowtie2/2.4.5', required: true },
          { name: 'SAMtools', module: 'SAMtools/1.17', required: true },
          { name: 'Picard', module: 'Picard/2.27.4', required: true },
          { name: 'MACS2', module: 'MACS2/2.2.7.1', required: true },
          { name: 'deepTools', module: 'deepTools/3.5.1', required: true },
          { name: 'BEDTools', module: 'BEDTools/2.30.0', required: true },
          { name: 'hotspot2', checkCmd: 'command -v hotspot2', required: false },
        ],
        references: [
          { name: 'Bowtie2 index', path: '{{BOWTIE2_INDEX}}', type: 'index', source: '可留空：AI 运行时协助查找或在 02_reference/ 下构建（bowtie2-build）', required: false },
          { name: 'Reference genome FASTA', path: '{{REF_FA}}', type: 'genome', source: '可留空：AI 运行时协助从集群公共库 /share/database/ 匹配', required: false },
          { name: 'ENCODE blacklist BED', path: '{{BLACKLIST}}', type: 'other', source: '可留空：AI 运行时协助按基因组版本下载（ENCODE blacklist）', required: false },
          { name: 'TSS annotation BED', path: '{{TSS_BED}}', type: 'annotation', source: '可留空：AI 运行时协助由基因注释 GTF 生成', required: false },
        ],
        inputHint: 'Paired-end ATAC-seq FASTQ directory',
        qcGates: [
          { afterStep: 2, metric: 'FastQC 碱基质量与接头含量', pass: 'Q30 >80%，接头含量 <5%', warn: 'Q30 70-80% 或接头 5-15%' },
          { afterStep: 4, metric: '比对率与细胞器 reads 占比', pass: '比对率 >80%，线粒体+叶绿体占比 <20%', warn: '细胞器占比 20-50%（植物样本叶绿体高时先确认 ORGANELLE_REGEX 已覆盖）' },
          { afterStep: 6, metric: 'TSS 富集、FRiP 与 SPOT', pass: 'TSS enrichment >6，FRiP≥0.2，SPOT≥0.3（需 hotspot2）', warn: 'TSS 4-6 或 FRiP 0.1-0.2 或 SPOT 0.2-0.3' },
        ],
      },
      provenance: { provider: 'trace-native', sourceName: 'ENCODE ATAC-seq protocol (TRACE native implementation)', sourceUrl: 'https://github.com/peacezha/TRACE',
        sourceRef: 'native-encode-v1', upstreamWorkflow: 'trace-native', implementation: 'reference-extension', importerVersion: 'native-encode-v1' },
      source: 'builtin',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'encode-dnaseseq',
      name: 'ENCODE DNase-seq 分析与质控流程',
      description: 'ENCODE DNase-seq 统一流程：FastQC → Bowtie2/BWA 比对 → 过滤去重 → hotspot2/F-seq 开放区域调用 → SPOT/FRiP 与库复杂度评估。',
      keywords: ['encode', 'dnaseseq', 'dnase-seq', 'dnase', '开放染色质', 'hotspot2', 'f-seq', 'spot', 'frip', '质控'],
      params: [
        { name: 'INPUT_DIR', label: 'FASTQ 目录（*.fq.gz，多为单端）', type: 'path' },
        { name: 'BOWTIE2_INDEX', label: 'Bowtie2 index prefix', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找或构建' },
        { name: 'REF_FA', label: 'Reference genome FASTA', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找' },
        { name: 'BLACKLIST', label: 'ENCODE blacklist BED', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找' },
        { name: 'CHROM_SIZES', label: '染色体长度表', type: 'path', required: false, placeholder: '可留空，AI 运行时协助生成' },
        { name: 'ORGANELLE_REGEX', label: 'Organelle chromosome pattern (mitochondria + chloroplast)', defaultValue: 'chrM|chrMT|chrC|chrPt|ChrM|ChrMt|ChrC|ChrPt|mitochondria|chloroplast|plastid', type: 'text', required: false, help: '植物样本必须同时去叶绿体；清空则保留细胞器 reads' },
        { name: 'QUEUE', label: 'Queue', defaultValue: 'q2680v2', type: 'select', options: ['q2680v2', 'normal', 'smp', 'high'] },
        { name: 'THREADS', label: 'Threads', defaultValue: '8', type: 'number' },
      ],
      steps: [
        { title: 'Read-only preflight: software, inputs and references', command: 'module av FastQC Bowtie2 SAMtools Picard hotspot2 F-seq BEDTools 确认可加载；ls -ld {{INPUT_DIR}}；ls -l {{BOWTIE2_INDEX}}.1.bt2 {{REF_FA}} {{BLACKLIST}} {{CHROM_SIZES}}；缺失先问用户' },
        { title: 'FastQC raw read QC', command: '#BSUB -J dnase_qc -n 1 -q {{QUEUE}}\nmodule load FastQC/0.11.9\ncd {{INPUT_DIR}} && mkdir -p fastqc_results\nfastqc *.fq.gz -o ./fastqc_results -t {{THREADS}}', notes: '写成 dnase_qc.lsf 后 bsub 提交；先看报告再决定后续' },
        { title: 'Bowtie2 比对、去细胞器与过滤去重', command: '#BSUB -J dnase_align -n {{THREADS}} -q {{QUEUE}}\nmodule load Bowtie2/2.4.5 SAMtools/1.17 Picard/2.27.4\ncd {{INPUT_DIR}} && mkdir -p qc\nfor i in *.fq.gz; do\n  s=${i%.fq.gz}\n  bowtie2 -p {{THREADS}} --very-sensitive -x {{BOWTIE2_INDEX}} -U "$i" | samtools view -@ {{THREADS}} -b -q 30 -F 1804 - | samtools sort -@ {{THREADS}} -o "${s}.sorted.bam" -\n  total=$(samtools view -c "${s}.sorted.bam")\n  mito=$(samtools view "${s}.sorted.bam" | grep -cE \'chrM|chrMT|ChrM|ChrMt|mitochondria\' || true)\n  chloro=$(samtools view "${s}.sorted.bam" | grep -cE \'chrC|chrPt|ChrC|ChrPt|chloroplast|plastid\' || true)\n  if [ -n "{{ORGANELLE_REGEX}}" ]; then org=$(samtools view "${s}.sorted.bam" | grep -cE "{{ORGANELLE_REGEX}}" || true); else org=0; fi\n  echo -e "${s}\\t${total}\\t${mito}\\t${chloro}\\t${org}" >> qc/organelle.tsv\n  if [ -n "{{ORGANELLE_REGEX}}" ]; then\n    samtools view -@ {{THREADS}} -h "${s}.sorted.bam" | { grep -vE "{{ORGANELLE_REGEX}}" || true; } | samtools view -@ {{THREADS}} -b - > "${s}.filt.bam"\n  else\n    mv "${s}.sorted.bam" "${s}.filt.bam"\n  fi\n  java -jar $EBROOTPICARD/picard.jar MarkDuplicates I="${s}.filt.bam" O="${s}.dedup.bam" M=qc/"${s}".dup_metrics.txt REMOVE_DUPLICATES=true\n  samtools index "${s}.dedup.bam"\ndone', notes: '写成 dnase_align.lsf 后 bsub 提交；双端数据改 -1/-2；MAPQ≥30 过滤后去细胞器 reads（线粒体+叶绿体，植物样本必去，由 ORGANELLE_REGEX 控制，清空则保留）再 MarkDuplicates 去重；BWA MEM 可作备选比对器；organelle.tsv 记录线粒体/叶绿体/合计占比' },
        { title: 'hotspot2 开放区域调用', command: '#BSUB -J dnase_hotspot -n 1 -q {{QUEUE}}\ncd {{INPUT_DIR}} && mkdir -p hotspots\nfor b in *.dedup.bam; do\n  s=${b%.dedup.bam}\n  MOPT=""\n  [ -s mappability.bed ] && MOPT="-M mappability.bed"\n  COPT=""\n  case "{{BLACKLIST}}" in *{{*}) ;; *) [ -s "{{BLACKLIST}}" ] && COPT="-C {{BLACKLIST}}" ;; esac\n  hotspot2 -c {{CHROM_SIZES}} $MOPT $COPT "$b" hotspots/"${s}"\ndone\nls hotspots/', notes: 'hotspot2 输出 *.hotspots.fdr0.05 与 peaks；无 hotspot2 时用 F-seq 备选：fseq -b 600 -f 0；mappability 文件缺失先问用户' },
        { title: 'QC：SPOT/FRiP 与库复杂度评估', command: '#BSUB -J dnase_spot_qc -n 1 -q {{QUEUE}}\nmodule load SAMtools/1.17 BEDTools/2.30.0\ncd {{INPUT_DIR}} && mkdir -p qc\nfor b in *.dedup.bam; do\n  s=${b%.dedup.bam}\n  total=$(samtools view -c "$b")\n  inhot=$(bedtools intersect -a "$b" -b hotspots/"${s}".hotspots.fdr0.05.bed -u | samtools view -c -)\n  echo -e "${s}\\t${total}\\t${inhot}" >> qc/spot.tsv\ndone\npython3 - <<\'PY\'\nimport json, os\nqc = {}\nif os.path.exists("qc/organelle.tsv"):\n    with open("qc/organelle.tsv") as fh:\n        for line in fh:\n            parts = line.rstrip("\\n").split("\\t")\n            if len(parts) < 5:\n                continue\n            s, total, mito, chloro, org = parts[:5]\n            if int(total):\n                entry = qc.setdefault(s, {})\n                entry["mito_rate"] = round(int(mito) / int(total), 4)\n                entry["chloro_rate"] = round(int(chloro) / int(total), 4)\n                entry["organelle_rate"] = round(int(org) / int(total), 4)\nif os.path.exists("qc/spot.tsv"):\n    with open("qc/spot.tsv") as fh:\n        for line in fh:\n            s, total, inhot = line.rstrip("\\n").split("\\t")\n            qc.setdefault(s, {})["SPOT"] = round(int(inhot) / int(total), 4) if int(total) else None\nwith open("qc/qc.json", "w") as out:\n    json.dump(qc, out, indent=2, ensure_ascii=False)\nPY', notes: '达标：SPOT/FRiP≥0.3（细胞系理想 ≥0.4）、NRF≥0.8；警告：0.2-0.3；hotspot2 自带 SPOT score 与 bedtools 估算互为印证' },
        { title: 'Generate analysis report', command: 'python3 <RUN>/tools/encode_native_report.py --run-dir <RUN> --input-dir {{INPUT_DIR}} --report-dir <RUN>/reports/final-report\ntest -s <RUN>/reports/final-report/report.html', notes: '确定性报告生成器直接读取真实产物（QC 指标/峰文件/图）生成图文并茂的 HTML+MD 报告；AI 只需在回复里补充一段结论解读并给出报告绝对路径，不要重写报告文件' },
      ],
      manifest: {
        software: [
          { name: 'FastQC', module: 'FastQC/0.11.9', required: true },
          { name: 'Bowtie2', module: 'Bowtie2/2.4.5', required: true },
          { name: 'SAMtools', module: 'SAMtools/1.17', required: true },
          { name: 'Picard', module: 'Picard/2.27.4', required: true },
          { name: 'hotspot2', checkCmd: 'command -v hotspot2', required: true },
          { name: 'BEDTools', module: 'BEDTools/2.30.0', required: true },
          { name: 'F-seq（备选）', checkCmd: 'command -v fseq', required: false },
        ],
        references: [
          { name: 'Bowtie2 index', path: '{{BOWTIE2_INDEX}}', type: 'index', source: '可留空：AI 运行时协助查找或在 02_reference/ 下构建（bowtie2-build）', required: false },
          { name: 'Reference genome FASTA', path: '{{REF_FA}}', type: 'genome', source: '可留空：AI 运行时协助从集群公共库 /share/database/ 匹配', required: false },
          { name: 'ENCODE blacklist BED', path: '{{BLACKLIST}}', type: 'other', source: '可留空：AI 运行时协助按基因组版本下载（ENCODE blacklist）', required: false },
          { name: '染色体长度表', path: '{{CHROM_SIZES}}', type: 'other', source: '可留空：AI 运行时协助由基因组生成', required: false },
        ],
        inputHint: 'DNase-seq FASTQ 目录（多为单端 *.fq.gz）',
        qcGates: [
          { afterStep: 2, metric: 'FastQC 碱基质量与接头含量', pass: 'Q30 >80%，接头含量 <5%', warn: 'Q30 70-80% 或接头 5-15%' },
          { afterStep: 3, metric: '比对率与细胞器 reads 占比', pass: '比对率 >80%，线粒体+叶绿体占比 <20%', warn: '比对率 60-80% 或细胞器占比 20-50%' },
          { afterStep: 5, metric: 'SPOT/FRiP 与库复杂度', pass: 'SPOT≥0.3，NRF≥0.8', warn: 'SPOT 0.2-0.3' },
        ],
      },
      source: 'builtin',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'encode-wgbs',
      name: 'ENCODE WGBS 甲基化分析与质控流程',
      description: 'ENCODE WGBS 统一流程：FastQC → Bismark（bowtie2）比对 → 去重 → 甲基化提取（CpG/CHG/CHH）→ 亚硫酸盐转化率与覆盖度评估。',
      keywords: ['encode', 'wgbs', '甲基化', 'bisulfite', 'bismark', 'cpg', 'dna methylation', '转化率', '质控'],
      params: [
        { name: 'INPUT_DIR', label: 'FASTQ directory (*_R1.fq.gz / *_R2.fq.gz)', type: 'path' },
        { name: 'BISMARK_INDEX', label: 'Bismark 基因组索引目录', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找或构建' },
        { name: 'SPIKEIN', label: 'lambda DNA spike-in 参考（转化率评估）', type: 'path', required: false, placeholder: '可留空，用 CHH 背景估算转化率' },
        { name: 'QUEUE', label: 'Queue', defaultValue: 'q2680v2', type: 'select', options: ['q2680v2', 'normal', 'smp', 'high'] },
        { name: 'THREADS', label: 'Threads', defaultValue: '8', type: 'number' },
      ],
      steps: [
        { title: 'Read-only preflight: software, inputs and references', command: 'module av FastQC Bismark SAMtools Bowtie2 确认可加载；ls -ld {{INPUT_DIR}}；ls -d {{BISMARK_INDEX}}；ls -l {{SPIKEIN}}；缺失先问用户' },
        { title: 'FastQC raw read QC', command: '#BSUB -J wgbs_qc -n 1 -q {{QUEUE}}\nmodule load FastQC/0.11.9\ncd {{INPUT_DIR}} && mkdir -p fastqc_results\nfastqc *.fq.gz -o ./fastqc_results -t {{THREADS}}', notes: '写成 wgbs_qc.lsf 后 bsub 提交；先看报告再决定后续' },
        { title: 'Bismark 比对', command: '#BSUB -J wgbs_align -n {{THREADS}} -q {{QUEUE}}\nmodule load Bismark/0.23.1\ncd {{INPUT_DIR}} && mkdir -p bam\nfor i in *_R1.fq.gz; do\n  s=${i%_R1.fq.gz}\n  bismark --parallel 2 -p {{THREADS}} --genome {{BISMARK_INDEX}} -1 "$i" -2 "${s}_R2.fq.gz" -o bam --temp_dir bam/tmp --basename "${s}"\ndone', notes: '写成 wgbs_align.lsf 后 bsub 提交；Bismark 默认调 bowtie2；--parallel 为并行样本数、-p 为每样本线程；单端数据只传 R1' },
        { title: '去重与甲基化提取', command: '#BSUB -J wgbs_extract -n {{THREADS}} -q {{QUEUE}}\nmodule load Bismark/0.23.1\ncd {{INPUT_DIR}}/bam\nfor b in *_bismark_bt2_pe.bam; do\n  deduplicate_bismark --paired --bam "$b"\ndone\nfor d in *_bismark_bt2_pe.deduplicated.bam; do\n  bismark_methylation_extractor --paired-end --bedGraph --counts --cytosine_report --CX_context --genome_folder {{BISMARK_INDEX}} -p --multicore {{THREADS}} "$d"\ndone\nbismark2report\nbismark2summary', notes: '提取 CpG/CHG/CHH 三种 context；产出 bedGraph/coverage/cytosine report 与 HTML 汇总报告' },
        { title: 'QC：转化率、比对效率与覆盖度评估', command: '#BSUB -J wgbs_conv_qc -n 1 -q {{QUEUE}}\ncd {{INPUT_DIR}}/bam && mkdir -p ../qc\npython3 - <<\'PY\'\nimport glob, json, os, re\nqc = {}\nfor rep in glob.glob("*_PE_report.txt") + glob.glob("*_SE_report.txt"):\n    s = os.path.basename(rep).replace("_PE_report.txt", "").replace("_SE_report.txt", "")\n    text = open(rep).read()\n    m = re.search(r"Mapping efficiency:\\s*([\\d.]+)%", text)\n    qc[s] = {"mapping_efficiency_pct": float(m.group(1)) if m else None}\nqc["_conversion"] = {"rule": "转化率 = 1 - 非 CpG 背景甲基化率；优先用 lambda spike-in（{{SPIKEIN}}）比对结果，无 spike-in 用 CHH 背景", "pass": ">99%", "warn": "97-99%"}\nfor bg in glob.glob("*.deduplicated.bedGraph.gz"):\n    qc.setdefault("_coverage", {})[os.path.basename(bg)] = "zcat 统计非零覆盖 CpG 数，与基因组总 CpG 数比较得覆盖度"\nwith open("../qc/qc.json", "w") as out:\n    json.dump(qc, out, indent=2, ensure_ascii=False)\nPY', notes: '达标：亚硫酸盐转化率 >99%、比对效率 >70%、CpG 覆盖 ≥80% 且平均深度 ≥10×；警告：转化率 97-99%、比对效率 50-70%' },
        { title: 'Generate analysis report', command: 'python3 <RUN>/tools/encode_native_report.py --run-dir <RUN> --input-dir {{INPUT_DIR}} --report-dir <RUN>/reports/final-report\ntest -s <RUN>/reports/final-report/report.html', notes: '确定性报告生成器直接读取真实产物（QC 指标/峰文件/图）生成图文并茂的 HTML+MD 报告；AI 只需在回复里补充一段结论解读并给出报告绝对路径，不要重写报告文件' },
      ],
      manifest: {
        software: [
          { name: 'FastQC', module: 'FastQC/0.11.9', required: true },
          { name: 'Bismark', module: 'Bismark/0.23.1', required: true },
          { name: 'Bowtie2', module: 'Bowtie2/2.4.5', required: true },
          { name: 'SAMtools', module: 'SAMtools/1.17', required: true },
        ],
        references: [
          { name: 'Bismark 基因组索引', path: '{{BISMARK_INDEX}}', type: 'index', source: '可留空：AI 运行时协助查找或构建（bismark_genome_preparation）', required: false },
          { name: 'lambda DNA spike-in 参考', path: '{{SPIKEIN}}', type: 'genome', source: '可留空：无 spike-in 时用 CHH 背景估算转化率', required: false },
        ],
        inputHint: 'WGBS 双端 FASTQ 目录',
        qcGates: [
          { afterStep: 2, metric: 'FastQC 碱基质量与接头含量', pass: 'Q30 >80%，接头含量 <5%', warn: 'Q30 70-80% 或接头 5-15%' },
          { afterStep: 3, metric: '比对效率', pass: '>70%', warn: '50-70%' },
          { afterStep: 5, metric: '亚硫酸盐转化率与 CpG 覆盖', pass: '转化率 >99%，CpG 覆盖 ≥80%', warn: '转化率 97-99%' },
        ],
      },
      source: 'builtin',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'encode-hic',
      name: 'ENCODE Hi-C 分析与质控流程',
      description: 'ENCODE Hi-C 统一流程：HiC-Pro（bowtie2 比对 → 有效互作对筛选）→ 分辨率矩阵（.cool/.hic）→ 互作图谱 → 有效互作统计评估。',
      keywords: ['encode', 'hic', 'hi-c', '三维基因组', 'hicpro', 'cooler', 'tad', 'loop', '互作', '质控'],
      params: [
        { name: 'INPUT_DIR', label: 'FASTQ directory (*_R1.fq.gz / *_R2.fq.gz)', type: 'path' },
        { name: 'BOWTIE2_INDEX', label: 'Bowtie2 index prefix', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找或构建' },
        { name: 'REF_FA', label: 'Reference genome FASTA', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找' },
        { name: 'RESTRICTION_SITE', label: '限制性内切酶位点', defaultValue: 'GATC', type: 'text', help: 'MboI/DpnII=GATC；HindIII=AAGCTT' },
        { name: 'CHROM_SIZES', label: '染色体长度表', type: 'path', required: false, placeholder: '可留空，AI 运行时协助生成' },
        { name: 'BIN_SIZES', label: '矩阵分辨率（bp，逗号分隔）', defaultValue: '10000,40000,100000', type: 'text' },
        { name: 'QUEUE', label: 'Queue', defaultValue: 'q2680v2', type: 'select', options: ['q2680v2', 'normal', 'smp', 'high'] },
        { name: 'THREADS', label: 'Threads', defaultValue: '8', type: 'number' },
      ],
      steps: [
        { title: 'Read-only preflight: software, inputs and references', command: 'module av HiC-Pro Bowtie2 SAMtools cooler juicer 确认可加载；ls -ld {{INPUT_DIR}}；ls -l {{BOWTIE2_INDEX}}.1.bt2 {{REF_FA}} {{CHROM_SIZES}}；缺失先问用户' },
        { title: 'HiC-Pro 比对与有效互作对筛选', command: '#BSUB -J hicpro -n {{THREADS}} -q {{QUEUE}}\nmodule load HiC-Pro/3.1.0\n# 先用 HiC-Pro 自带 digest_genome.py 由 {{RESTRICTION_SITE}} 生成基因组酶切 BED，再写配置\nDIGEST=$(ls *digest*.bed *digestion*.bed 2>/dev/null | head -1 || true)\nif [ -z "$DIGEST" ]; then\n  echo "SKIP: 缺少酶切位点 BED（由 HiC-Pro 的 digest_genome.py 生成）"\nelse\ncat > hicpro_config.txt <<EOF\nBOWTIE2_IDX_PATH = {{BOWTIE2_INDEX}}\nREFERENCE_GENOME = {{REF_FA}}\nGENOME_FRAGMENT = $DIGEST\nLIGATION_SITE = ${LIGATION_SITE:-{{RESTRICTION_SITE}}{{RESTRICTION_SITE}}}\nCHROM_SIZE = {{CHROM_SIZES}}\nBIN_SIZE = {{BIN_SIZES}}\nN_CPU = {{THREADS}}\nEOF\nHiC-Pro -i {{INPUT_DIR}} -o hicpro_out -c hicpro_config.txt\nfi', notes: '写成 hicpro.lsf 后 bsub 提交；产出 allValidPairs（已去自连/dangling end/去重）与各阶段 *.stat 统计' },
        { title: '分辨率矩阵构建（.cool/.hic）', command: '#BSUB -J hic_matrix -n {{THREADS}} -q {{QUEUE}}\nmodule load cooler\ncd hicpro_out/hic_results/data\nfor d in */; do\n  v=$(ls "$d"*.allValidPairs | head -1)\n  cooler cload pairs -c1 2 -p1 3 -c2 4 -p2 5 {{CHROM_SIZES}}:1000 "$v" "${d%/}.1000.cool"\n  cooler zoomify --balance -p {{THREADS}} -o "${d%/}.mcool" "${d%/}.1000.cool"\ndone', notes: '备选：juicer_tools pre 生成 .hic 供 Juicebox 查看；zoomify 默认按 2 的幂生成多分辨率，覆盖 {{BIN_SIZES}} 档位即可' },
        { title: 'QC：有效互作统计评估', command: '#BSUB -J hic_valid_qc -n 1 -q {{QUEUE}}\ncd hicpro_out/hic_results && mkdir -p qc\npython3 - <<\'PY\'\nimport glob, json, os\nqc = {}\nfor stat in glob.glob("**/*stat", recursive=True):\n    s = os.path.basename(stat)\n    rec = {}\n    with open(stat, errors="ignore") as fh:\n        for line in fh:\n            parts = line.replace(":", " ").split()\n            if len(parts) >= 2 and not parts[0].startswith("#"):\n                rec[parts[0]] = " ".join(parts[1:])\n    if rec:\n        qc[s] = rec\nwith open("qc/qc.json", "w") as out:\n    json.dump(qc, out, indent=2, ensure_ascii=False)\nPY\nls qc/qc.json', notes: '达标：valid pairs 率 ≥40%、顺式互作占比 >40%、重复率 <30%、顺/反比 >1；同时检查互作距离分布无 dangling/自连残留峰' },
        { title: '互作图谱与 TAD/loop 调用（可选）', command: '#BSUB -J hic_tad -n {{THREADS}} -q {{QUEUE}}\nmodule load HiCExplorer\ncd hicpro_out/hic_results/data && mkdir -p tad\nif ! ls *.mcool >/dev/null 2>&1; then\n  echo "SKIP: 缺少 .mcool 矩阵文件，跳过 TAD/loop 调用"\nelse\n  for mc in *.mcool; do\n    sm=${mc%.mcool}\n    hicConvertFormat -m "$mc::/resolutions/40000" --inputFormat cool --outputFormat h5 -o "${sm}".40kb.h5\n    hicFindTADs -m "${sm}".40kb.h5 --outPrefix tad/"${sm}" --correctForMultipleTesting fdr\n    hicPlotMatrix -m "${sm}".40kb.h5 -o tad/"${sm}".matrix.png --log1p --dpi 200\n  done\nfi', optional: true, notes: '可选步骤；loop 调用用 juicer HiCCUPS（需 .hic）；TAD 边界重复间 Jaccard 指数可作一致性指标' },
        { title: 'Generate analysis report', command: 'python3 <RUN>/tools/encode_native_report.py --run-dir <RUN> --input-dir {{INPUT_DIR}} --report-dir <RUN>/reports/final-report\ntest -s <RUN>/reports/final-report/report.html', notes: '确定性报告生成器直接读取真实产物（QC 指标/峰文件/图）生成图文并茂的 HTML+MD 报告；AI 只需在回复里补充一段结论解读并给出报告绝对路径，不要重写报告文件' },
      ],
      manifest: {
        software: [
          { name: 'HiC-Pro', module: 'HiC-Pro/3.1.0', required: true },
          { name: 'Bowtie2', module: 'Bowtie2/2.4.5', required: true },
          { name: 'SAMtools', module: 'SAMtools/1.17', required: true },
          { name: 'cooler', checkCmd: 'command -v cooler', required: true },
          { name: 'HiCExplorer', checkCmd: 'command -v hicFindTADs', required: false },
          { name: 'juicer_tools', checkCmd: 'command -v juicer_tools || ls juicer_tools.jar 2>/dev/null', required: false },
        ],
        references: [
          { name: 'Bowtie2 index', path: '{{BOWTIE2_INDEX}}', type: 'index', source: '可留空：AI 运行时协助查找或在 02_reference/ 下构建（bowtie2-build）', required: false },
          { name: 'Reference genome FASTA', path: '{{REF_FA}}', type: 'genome', source: '可留空：AI 运行时协助从集群公共库 /share/database/ 匹配', required: false },
          { name: '染色体长度表', path: '{{CHROM_SIZES}}', type: 'other', source: '可留空：AI 运行时协助由基因组生成', required: false },
        ],
        inputHint: 'Hi-C 双端 FASTQ 目录与所用限制性内切酶',
        qcGates: [
          { afterStep: 2, metric: '有效互作对产出', pass: '产出 allValidPairs 且各阶段 *.stat 齐全', warn: '有效对比例异常低时先查酶切配置' },
          { afterStep: 4, metric: 'valid pairs 率与顺式占比', pass: 'valid pairs ≥40%，顺式 >40%，重复率 <30%', warn: 'valid pairs 25-40% 或重复率 30-50%' },
        ],
      },
      source: 'builtin',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'encode-chiapet',
      name: 'ENCODE ChIA-PET 分析与质控流程',
      description: 'ENCODE ChIA-PET 统一流程：linker 鉴定与接头处理 → BWA 比对 → PET 分类与去重 → 环（PET cluster）调用 → 有效连接率与可信度评估。',
      keywords: ['encode', 'chiapet', 'chia-pet', '染色质互作', '环', 'loop', 'pet', 'mango', '增强子启动子', '质控'],
      params: [
        { name: 'INPUT_DIR', label: 'FASTQ directory (*_R1.fq.gz / *_R2.fq.gz)', type: 'path' },
        { name: 'BWA_INDEX', label: 'BWA index prefix', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找或构建' },
        { name: 'REF_FA', label: 'Reference genome FASTA', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找' },
        { name: 'LINKER', label: 'linker 序列', type: 'text', required: false, placeholder: '可留空，AI 运行时协助确认 linker 序列' },
        { name: 'QUEUE', label: 'Queue', defaultValue: 'q2680v2', type: 'select', options: ['q2680v2', 'normal', 'smp', 'high'] },
        { name: 'THREADS', label: 'Threads', defaultValue: '8', type: 'number' },
      ],
      steps: [
        { title: 'Read-only preflight: software, inputs and references', command: 'module av FastQC BWA SAMtools Mango ChIA-PET2 确认可加载；ls -ld {{INPUT_DIR}}；ls -l {{BWA_INDEX}}.sa {{REF_FA}}；缺失先问用户' },
        { title: 'FastQC raw read QC', command: '#BSUB -J chiapet_qc -n 1 -q {{QUEUE}}\nmodule load FastQC/0.11.9\ncd {{INPUT_DIR}} && mkdir -p fastqc_results\nfastqc *.fq.gz -o ./fastqc_results -t {{THREADS}}', notes: '写成 chiapet_qc.lsf 后 bsub 提交；先看报告再决定后续' },
        { title: 'linker 鉴定与 BWA 比对', command: '#BSUB -J chiapet_map -n {{THREADS}} -q {{QUEUE}}\nmodule load BWA/0.7.17 SAMtools/1.17\ncd {{INPUT_DIR}}\n# 先按 {{LINKER}} 序列鉴定并去除 linker（ChIA-PET Tool 或自写脚本）；linker 未确认前不要直接比对\nfor i in *_R1.fq.gz; do\n  s=${i%_R1.fq.gz}\n  bwa mem -t {{THREADS}} {{BWA_INDEX}} "$i" "${s}_R2.fq.gz" | samtools sort -@ {{THREADS}} -o "${s}.sorted.bam" -\ndone', notes: 'linker 鉴定结果（半 linker 组成）同时是文库质量指标；比对用 linker 处理后的 clean reads' },
        { title: 'PET 分类、去重与环调用', command: '#BSUB -J chiapet_loop -n {{THREADS}} -q {{QUEUE}}\ncd {{INPUT_DIR}} && mkdir -p loops\n# Mango 流程：PET 分类（自连/互连）→ 去 PCR 重复 → 峰调用 → PET cluster 显著性检验（stage 1-5 按 Mango 手册串行执行）\nMANGO_JAR=${MANGO_JAR:-${EBROOTMANGO:+$EBROOTMANGO/Mango.jar}}\nfor b in *.sorted.bam; do\n  s=${b%.sorted.bam}\n  java -jar "${MANGO_JAR:?需要设置 MANGO_JAR 环境变量指向 Mango.jar（module load Mango 后通常在 $EBROOTMANGO 下）}" "$b" {{REF_FA}} loops/"${s}"\ndone\nls loops/', notes: '自连 PET（同片段短距离）剔除，互连 PET 聚类成环；FDR 默认 0.05；备选 ChIA-PET2 全流程；Mango/ChIA-PET2 缺失时先问用户安装方式' },
        { title: 'QC：有效连接率与 PET cluster 可信度', command: '#BSUB -J chiapet_link_qc -n 1 -q {{QUEUE}}\ncd {{INPUT_DIR}} && mkdir -p qc\npython3 - <<\'PY\'\nimport glob, json, os\nqc = {}\nfor log in glob.glob("loops/*.log") + glob.glob("loops/*.stat*"):\n    with open(log, errors="ignore") as fh:\n        qc[os.path.basename(log)] = fh.read()[:4000]\nfor bedpe in glob.glob("loops/*interactions*.bedpe"):\n    n_fdr = total = 0\n    with open(bedpe) as fh:\n        for line in fh:\n            if line.startswith("#") or not line.strip():\n                continue\n            total += 1\n            cols = line.rstrip("\\n").split("\\t")\n            try:\n                if float(cols[-1]) <= 0.05:\n                    n_fdr += 1\n            except ValueError:\n                continue\n    qc[os.path.basename(bedpe)] = {"total_clusters": total, "fdr_le_0.05": n_fdr}\nwith open("qc/qc.json", "w") as out:\n    json.dump(qc, out, indent=2, ensure_ascii=False)\nPY', notes: '达标：有效连接率（互连 PET 占比）>10%、重复率 <30%、高可信 cluster（≥3 PET 支持）重复间可重复；警告：连接率 5-10%、重复率 30-50%' },
        { title: 'Generate analysis report', command: 'python3 <RUN>/tools/encode_native_report.py --run-dir <RUN> --input-dir {{INPUT_DIR}} --report-dir <RUN>/reports/final-report\ntest -s <RUN>/reports/final-report/report.html', notes: '确定性报告生成器直接读取真实产物（QC 指标/峰文件/图）生成图文并茂的 HTML+MD 报告；AI 只需在回复里补充一段结论解读并给出报告绝对路径，不要重写报告文件' },
      ],
      manifest: {
        software: [
          { name: 'FastQC', module: 'FastQC/0.11.9', required: true },
          { name: 'BWA', module: 'BWA/0.7.17', required: true },
          { name: 'SAMtools', module: 'SAMtools/1.17', required: true },
          { name: 'Mango', checkCmd: 'command -v mango || ls Mango*.jar 2>/dev/null', required: true },
          { name: 'ChIA-PET2（备选）', checkCmd: 'command -v ChIA-PET2', required: false },
        ],
        references: [
          { name: 'BWA index', path: '{{BWA_INDEX}}', type: 'index', source: '可留空：AI 运行时协助查找或在 02_reference/ 下构建（bwa index）', required: false },
          { name: 'Reference genome FASTA', path: '{{REF_FA}}', type: 'genome', source: '可留空：AI 运行时协助从集群公共库 /share/database/ 匹配', required: false },
        ],
        inputHint: 'ChIA-PET 双端 FASTQ 目录与 linker 序列',
        qcGates: [
          { afterStep: 2, metric: 'FastQC 碱基质量与接头含量', pass: 'Q30 >80%，接头含量 <5%', warn: 'Q30 70-80% 或接头 5-15%' },
          { afterStep: 5, metric: '有效连接率与环可信度', pass: '互连 PET 占比 >10%，重复率 <30%', warn: '连接率 5-10% 或重复率 30-50%' },
        ],
      },
      source: 'builtin',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'encode-mirnaseq',
      name: 'ENCODE miRNA-seq 分析与质控流程',
      description: 'ENCODE miRNA-seq 统一流程：FastQC → cutadapt 去接头与长度筛选（15-35nt）→ miRDeep2/miRBase 定量（counts per miRNA）→ 长度分布与映射率评估。',
      keywords: ['encode', 'mirnaseq', 'mirna-seq', 'mirna', '小rna', 'cutadapt', 'mirdeep2', 'mirbase', '定量', '质控'],
      params: [
        { name: 'INPUT_DIR', label: '小 RNA FASTQ 目录（*.fq.gz，单端）', type: 'path' },
        { name: 'ADAPTER', label: '3\' 接头序列', defaultValue: 'TGGAATTCTCGGGTGCCAAGG', type: 'text', help: 'Illumina 小 RNA 接头；按实际建库试剂盒调整' },
        { name: 'MIRBASE', label: 'miRBase 目录（hairpin.fa / mature.fa）', type: 'path', required: false, placeholder: '可留空，AI 运行时协助下载' },
        { name: 'REF_FA', label: 'Reference genome FASTA', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找' },
        { name: 'QUEUE', label: 'Queue', defaultValue: 'q2680v2', type: 'select', options: ['q2680v2', 'normal', 'smp', 'high'] },
        { name: 'THREADS', label: 'Threads', defaultValue: '8', type: 'number' },
        { name: 'SPECIES', label: 'miRBase 物种缩写', defaultValue: 'hsa', type: 'text', required: false },
      ],
      steps: [
        { title: 'Read-only preflight: software, inputs and references', command: 'module av FastQC cutadapt miRDeep2 Bowtie2 确认可加载；ls -ld {{INPUT_DIR}}；ls -l {{MIRBASE}}/hairpin.fa {{MIRBASE}}/mature.fa {{REF_FA}}；缺失先问用户' },
        { title: 'FastQC raw read QC', command: '#BSUB -J mirna_qc -n 1 -q {{QUEUE}}\nmodule load FastQC/0.11.9\ncd {{INPUT_DIR}} && mkdir -p fastqc_results\nfastqc *.fq.gz -o ./fastqc_results -t {{THREADS}}', notes: '写成 mirna_qc.lsf 后 bsub 提交；重点看过量序列（接头）与长度分布' },
        { title: 'cutadapt 去接头与长度筛选', command: '#BSUB -J mirna_trim -n {{THREADS}} -q {{QUEUE}}\nmodule load cutadapt/4.4\ncd {{INPUT_DIR}} && mkdir -p trimmed\nfor i in *.fq.gz; do\n  s=${i%.fq.gz}\n  cutadapt -j {{THREADS}} -a {{ADAPTER}} -m 15 -M 35 -o trimmed/"${s}".trimmed.fq.gz "$i" > trimmed/"${s}".cutadapt.log\ndone', notes: '保留 15-35nt；cutadapt.log 含接头去除率，纳入 QC' },
        { title: 'miRNA 定量（miRDeep2/miRBase）', command: '#BSUB -J mirna_quant -n {{THREADS}} -q {{QUEUE}}\nmodule load miRDeep2 Bowtie2/2.4.5\ncd {{INPUT_DIR}} && mkdir -p mirdeep2\nfor i in trimmed/*.trimmed.fq.gz; do\n  s=$(basename "$i" .trimmed.fq.gz)\n  zcat "$i" > mirdeep2/"${s}".fq\n  mapper.pl mirdeep2/"${s}".fq -e -h -m -s mirdeep2/"${s}"_collapsed.fa\n  quantifier.pl -p {{MIRBASE}}/hairpin.fa -m {{MIRBASE}}/mature.fa -r mirdeep2/"${s}"_collapsed.fa -t {{SPECIES}} -y "${s}"\ndone\nls mirdeep2/', notes: '产出 counts per miRNA（miRNAs_expressed_all_samples_*.csv）；备选：bowtie2 比对 mature.fa 后按 miRNA 计数' },
        { title: 'QC：长度分布、映射率与污染评估', command: '#BSUB -J mirna_len_qc -n 1 -q {{QUEUE}}\ncd {{INPUT_DIR}} && mkdir -p qc\npython3 - <<\'PY\'\nimport glob, gzip, json, os\nqc = {}\nfor fq in glob.glob("trimmed/*.trimmed.fq.gz"):\n    s = os.path.basename(fq).replace(".trimmed.fq.gz", "")\n    total = inrange = 0\n    with gzip.open(fq, "rt") as fh:\n        for i, line in enumerate(fh):\n            if i % 4 == 1:\n                total += 1\n                if 15 <= len(line.rstrip("\\n")) <= 35:\n                    inrange += 1\n    adapter = None\n    log = os.path.join("trimmed", s + ".cutadapt.log")\n    if os.path.exists(log):\n        with open(log) as fh:\n            for line in fh:\n                if line.startswith("Reads with adapters"):\n                    adapter = line.strip()\n    qc[s] = {"total_reads": total, "len_15_35": inrange, "len_15_35_rate": round(inrange / total, 4) if total else None, "cutadapt_adapters": adapter}\nwith open("qc/qc.json", "w") as out:\n    json.dump(qc, out, indent=2, ensure_ascii=False)\nPY', notes: '达标：15-35nt 占比 >70%、miRNA 映射率 >50%、rRNA/tRNA 污染 <10%、接头去除率 >95%；污染率用 bowtie2 对 rRNA/tRNA 库比对评估' },
        { title: 'Generate analysis report', command: 'python3 <RUN>/tools/encode_native_report.py --run-dir <RUN> --input-dir {{INPUT_DIR}} --report-dir <RUN>/reports/final-report\ntest -s <RUN>/reports/final-report/report.html', notes: '确定性报告生成器直接读取真实产物（QC 指标/峰文件/图）生成图文并茂的 HTML+MD 报告；AI 只需在回复里补充一段结论解读并给出报告绝对路径，不要重写报告文件' },
      ],
      manifest: {
        software: [
          { name: 'FastQC', module: 'FastQC/0.11.9', required: true },
          { name: 'cutadapt', module: 'cutadapt/4.4', required: true },
          { name: 'miRDeep2', checkCmd: 'command -v quantifier.pl', required: true },
          { name: 'Bowtie2（备选定量/污染评估）', module: 'Bowtie2/2.4.5', required: false },
        ],
        references: [
          { name: 'miRBase（hairpin.fa / mature.fa）', path: '{{MIRBASE}}', type: 'database', source: '可留空：AI 运行时协助从 miRBase 下载对应物种版本', required: false },
          { name: 'Reference genome FASTA', path: '{{REF_FA}}', type: 'genome', source: '可留空：AI 运行时协助从集群公共库 /share/database/ 匹配', required: false },
        ],
        inputHint: '小 RNA 单端 FASTQ 目录与建库接头序列',
        qcGates: [
          { afterStep: 2, metric: 'FastQC 碱基质量与接头含量', pass: 'Q30 >80%', warn: 'Q30 70-80%' },
          { afterStep: 3, metric: '接头去除率与长度分布', pass: '接头去除率 >95%，15-35nt 占比 >70%', warn: '15-35nt 占比 50-70%' },
          { afterStep: 5, metric: 'miRNA 映射率与污染', pass: '映射率 >50%，rRNA/tRNA 污染 <10%', warn: '映射率 30-50%' },
        ],
      },
      source: 'builtin',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'encode-eclip',
      name: 'ENCODE eCLIP 分析与质控流程',
      description: 'ENCODE eCLIP 统一流程：cutadapt 去接头 → STAR 比对 → UMI 去 PCR 重复 → CLIPper 峰调用（input 对照归一化）→ 重复间可重复峰评估。',
      keywords: ['encode', 'eclip', 'clip-seq', 'rbp', 'rna结合蛋白', 'star', 'umi', 'clipper', '峰调用', '质控'],
      params: [
        { name: 'INPUT_DIR', label: 'IP 样本 FASTQ 目录（*.fq.gz，单端）', type: 'path' },
        { name: 'CONTROL_DIR', label: 'SMInput 对照 FASTQ 目录', type: 'path', required: false, placeholder: '可留空，AI 运行时协助确认' },
        { name: 'STAR_INDEX', label: 'STAR genome index directory', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找或构建' },
        { name: 'GTF', label: 'Gene annotation GTF path', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找' },
        { name: 'ADAPTER', label: '3\' 接头序列', defaultValue: 'AGATCGGAAGAGC', type: 'text' },
        { name: 'QUEUE', label: 'Queue', defaultValue: 'q2680v2', type: 'select', options: ['q2680v2', 'normal', 'smp', 'high'] },
        { name: 'THREADS', label: 'Threads', defaultValue: '8', type: 'number' },
        { name: 'SPECIES', label: '物种（CLIPper --species）', defaultValue: 'hg38', type: 'text', required: false },
      ],
      steps: [
        { title: 'Read-only preflight: software, inputs and references', command: 'module av cutadapt STAR SAMtools umi_tools CLIPper 确认可加载；ls -ld {{INPUT_DIR}} {{CONTROL_DIR}}；ls -d {{STAR_INDEX}}；ls -l {{GTF}}；缺失先问用户' },
        { title: 'cutadapt 去接头（双轮）', command: '#BSUB -J eclip_trim -n {{THREADS}} -q {{QUEUE}}\nmodule load cutadapt/4.4\ncd {{INPUT_DIR}} && mkdir -p trimmed\nfor i in *.fq.gz; do\n  s=${i%.fq.gz}\n  cutadapt -j {{THREADS}} -a {{ADAPTER}} -m 18 --times 2 -o trimmed/"${s}".trimmed.fq.gz "$i" > trimmed/"${s}".cutadapt.log\ndone', notes: '双轮去接头降低接头二聚体；UMI 在 reads 5\' 端，比对后由 umi_tools 处理' },
        { title: 'STAR alignment', command: '#BSUB -J eclip_align -n {{THREADS}} -q {{QUEUE}}\nmodule load STAR/2.7.10b\ncd {{INPUT_DIR}}\nfor i in trimmed/*.trimmed.fq.gz; do\n  s=$(basename "$i" .trimmed.fq.gz)\n  STAR --runThreadN {{THREADS}} --genomeDir {{STAR_INDEX}} --readFilesIn "$i" --readFilesCommand zcat --outSAMtype BAM SortedByCoordinate --outFilterMultimapNmax 1 --outFilterMismatchNmax 2 --outFileNamePrefix "${s}."\ndone', notes: '--outFilterMultimapNmax 1 保留唯一比对；重复元件相关 RBP 可放宽并按家族统计' },
        { title: 'UMI 去 PCR 重复', command: '#BSUB -J eclip_dedup -n 1 -q {{QUEUE}}\nmodule load SAMtools/1.17 umi_tools\ncd {{INPUT_DIR}} && mkdir -p qc\nfor b in *.Aligned.sortedByCoord.out.bam; do\n  s=${b%.Aligned.sortedByCoord.out.bam}\n  samtools index "$b"\n  umi_tools dedup --stdin="$b" --stdout="${s}.dedup.bam" --log=qc/"${s}".umi_dedup.log\n  samtools index "${s}.dedup.bam"\ndone', notes: '若 UMI 未在 read name 中，先 umi_tools extract --bc-pattern=NNNNNNNNNN；dedup log 给出 PCR 重复率' },
        { title: 'CLIPper 峰调用与 input 归一化', command: '#BSUB -J eclip_peak -n {{THREADS}} -q {{QUEUE}}\ncd {{INPUT_DIR}} && mkdir -p peaks\nCTRL=$(ls {{CONTROL_DIR}}/*.dedup.bam 2>/dev/null | head -1 || true)\nfor b in *.dedup.bam; do\n  s=${b%.dedup.bam}\n  clipper --bam "$b" --species {{SPECIES}} --outfile peaks/"${s}".peak_clusters.bed\n  if [ -n "$CTRL" ] && command -v overlap_peakfi_with_bam.pl >/dev/null 2>&1; then\n    overlap_peakfi_with_bam.pl "$b" "$CTRL" peaks/"${s}".peak_clusters.bed peaks/"${s}".normalized_peaks.bed\n  else\n    echo "SKIP: 未找到 ENCODE eCLIP 归一化脚本 overlap_peakfi_with_bam.pl 或无 SMInput 对照，以未归一化峰代替（${s}）"\n    cp peaks/"${s}".peak_clusters.bed peaks/"${s}".normalized_peaks.bed\n  fi\ndone', notes: '归一化过滤阈值：log2 fold enrichment ≥3 且 -log10(p) ≥3；无 SMInput 对照时只给 IP 峰并显式标注' },
        { title: 'QC：PCR 重复率、富集倍数与重复可重复峰', command: '#BSUB -J eclip_rep_qc -n 1 -q {{QUEUE}}\nmodule load BEDTools/2.30.0\ncd {{INPUT_DIR}} && mkdir -p qc\nmapfile -t NP < <(ls peaks/*.normalized_peaks.bed 2>/dev/null || ls *.normalized_peaks.bed 2>/dev/null)\nif [ "${#NP[@]}" -lt 2 ]; then\n  echo "SKIP: 需要至少 2 个重复的 normalized_peaks 才能做一致性统计"\nelse\n  bedtools intersect -a "${NP[0]}" -b "${NP[1]}" -f 0.5 -r -u | wc -l > qc/rep_overlap.txt\nfi\npython3 - <<\'PY\'\nimport glob, json, os\nqc = {}\nfor log in glob.glob("qc/*.umi_dedup.log"):\n    s = os.path.basename(log).replace(".umi_dedup.log", "")\n    with open(log) as fh:\n        lines = fh.read().strip().splitlines()\n    qc[s] = {"umi_dedup_last_line": lines[-1] if lines else None}\nfor bed in glob.glob("peaks/*.normalized_peaks.bed"):\n    with open(bed) as fh:\n        qc.setdefault("_peaks", {})[os.path.basename(bed)] = sum(1 for line in fh if line.strip())\nwith open("qc/qc.json", "w") as out:\n    json.dump(qc, out, indent=2, ensure_ascii=False)\nPY', notes: '达标：PCR 重复率 <60%、归一化富集峰数充足、重复间可重复峰占比 ≥50%；警告：重复率 60-80%、可重复 30-50%' },
        { title: 'Generate analysis report', command: 'python3 <RUN>/tools/encode_native_report.py --run-dir <RUN> --input-dir {{INPUT_DIR}} --report-dir <RUN>/reports/final-report\ntest -s <RUN>/reports/final-report/report.html', notes: '确定性报告生成器直接读取真实产物（QC 指标/峰文件/图）生成图文并茂的 HTML+MD 报告；AI 只需在回复里补充一段结论解读并给出报告绝对路径，不要重写报告文件' },
      ],
      manifest: {
        software: [
          { name: 'cutadapt', module: 'cutadapt/4.4', required: true },
          { name: 'STAR', module: 'STAR/2.7.10b', required: true },
          { name: 'SAMtools', module: 'SAMtools/1.17', required: true },
          { name: 'umi_tools', checkCmd: 'command -v umi_tools', required: true },
          { name: 'CLIPper', checkCmd: 'command -v clipper', required: true },
          { name: 'BEDTools', module: 'BEDTools/2.30.0', required: true },
        ],
        references: [
          { name: 'STAR genome index', path: '{{STAR_INDEX}}', type: 'index', source: '可留空：AI 运行时协助查找或在 02_reference/ 下构建（STAR --runMode genomeGenerate）', required: false },
          { name: 'Gene annotation GTF', path: '{{GTF}}', type: 'annotation', source: '可留空：AI 运行时协助从集群公共库 /share/database/ 匹配', required: false },
        ],
        inputHint: 'eCLIP IP 样本单端 FASTQ 目录与 size-matched input（SMInput）对照目录',
        qcGates: [
          { afterStep: 3, metric: '比对率', pass: '>60%', warn: '40-60%' },
          { afterStep: 4, metric: 'PCR 重复率', pass: '<60%', warn: '60-80%' },
          { afterStep: 6, metric: '重复间可重复峰', pass: '可重复峰占比 ≥50%', warn: '30-50%' },
        ],
      },
      source: 'builtin',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'encode-longread-rnaseq',
      name: 'ENCODE 长读长 RNA-seq 分析与质控流程',
      description: 'ENCODE 长读长 RNA-seq 统一流程：minimap2 比对（PacBio/ONT）→ TALON/FLAIR 转录本组装 → 定量与 novel isoform 注释 → 比对率、全长比例与饱和度评估。',
      keywords: ['encode', 'long read', '长读长', 'pacbio', 'ont', 'minimap2', 'talon', 'flair', 'isoform', '转录本', '质控'],
      params: [
        { name: 'INPUT_DIR', label: '长读长 FASTQ 目录（*.fq.gz）', type: 'path' },
        { name: 'PLATFORM', label: '测序平台', defaultValue: 'pacbio', type: 'select', options: ['pacbio', 'ont'] },
        { name: 'REF_FA', label: 'Reference genome FASTA', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找' },
        { name: 'GTF', label: 'Gene annotation GTF path', type: 'path', required: false, placeholder: '可留空，AI 运行时协助查找' },
        { name: 'QUEUE', label: 'Queue', defaultValue: 'q2680v2', type: 'select', options: ['q2680v2', 'normal', 'smp', 'high'] },
        { name: 'THREADS', label: 'Threads', defaultValue: '8', type: 'number' },
        { name: 'GENOME_BUILD', label: '基因组 build 名（如 hg38）', defaultValue: 'hg38', type: 'text', required: false },
        { name: 'ANNOTATION_NAME', label: '注释名（如 gencode）', defaultValue: 'gencode', type: 'text', required: false },
      ],
      steps: [
        { title: 'Read-only preflight: software, inputs and references', command: 'module av minimap2 SAMtools TALON FLAIR 确认可加载；ls -ld {{INPUT_DIR}}；ls -l {{REF_FA}} {{GTF}}；缺失先问用户' },
        { title: 'minimap2 比对与排序', command: '#BSUB -J lrrna_align -n {{THREADS}} -q {{QUEUE}}\nmodule load minimap2/2.26 SAMtools/1.17\ncd {{INPUT_DIR}}\nfor i in *.fq.gz; do\n  s=${i%.fq.gz}\n  minimap2 -t {{THREADS}} -ax splice -uf --secondary=no {{REF_FA}} "$i" | samtools sort -@ {{THREADS}} -o "${s}.sorted.bam" -\n  samtools index "${s}.sorted.bam"\ndone', notes: '{{PLATFORM}}=pacbio 且为 HiFi/CCS 时用 -ax splice:hq；ONT 用 -ax splice；输入为 BAM 时先 samtools fastq 转换' },
        { title: 'TALON/FLAIR 转录本组装与定量', command: '#BSUB -J lrrna_talon -n {{THREADS}} -q {{QUEUE}}\nmodule load SAMtools/1.17\ncd {{INPUT_DIR}} && mkdir -p talon\ntalon_initialize_database --f {{GTF}} --g {{GENOME_BUILD}} --a {{ANNOTATION_NAME}} --o talon/talon_db\nrm -f talon/config.csv\nfor b in *.sorted.bam; do\n  s=${b%.sorted.bam}\n  samtools view -h -o talon/"${s}".sam "$b"\n  case "{{PLATFORM}}" in [Oo][Nn][Tt]) PLAT=ONT ;; *) PLAT=PacBio ;; esac\n  printf \'%s,%s,%s,%s\\n\' "${s}" "${s}" "$PLAT" talon/"${s}".sam >> talon/config.csv\ndone\ntalon --f talon/config.csv --db talon/talon_db.db --build {{GENOME_BUILD}} --threads {{THREADS}} --o talon/run\ntalon_create_abundance_file --db talon/talon_db.db -a {{ANNOTATION_NAME}} --build {{GENOME_BUILD}} --o talon/abundance\nls talon/', notes: 'novel isoform 由 TALON 自动注释（Known/ISM/NIC/NNC）；备选：flair collapse；build/注释名与 {{REF_FA}}/{{GTF}} 版本一致' },
        { title: 'QC：比对率、全长比例与 novel isoform 评估', command: '#BSUB -J lrrna_full_qc -n 1 -q {{QUEUE}}\nmodule load SAMtools/1.17\ncd {{INPUT_DIR}} && mkdir -p qc\nfor b in *.sorted.bam; do\n  s=${b%.sorted.bam}\n  samtools flagstat "$b" > qc/"${s}".flagstat.txt\ndone\npython3 - <<\'PY\'\nimport glob, json, os\nqc = {}\nfor f in glob.glob("qc/*.flagstat.txt"):\n    s = os.path.basename(f).replace(".flagstat.txt", "")\n    total = mapped = 0\n    with open(f) as fh:\n        for line in fh:\n            if "in total" in line:\n                total = int(line.split()[0])\n            elif "mapped (" in line and "primary" not in line:\n                mapped = int(line.split()[0])\n    qc[s] = {"total_reads": total, "mapped": mapped, "mapping_rate": round(mapped / total, 4) if total else None}\nannot = glob.glob("talon/*_talon_read_annot.tsv")\nif annot:\n    known = novel = 0\n    with open(annot[0]) as fh:\n        header = fh.readline().rstrip("\\n").split("\\t")\n        idx = header.index("transcript_novelty") if "transcript_novelty" in header else -1\n        for line in fh:\n            if idx < 0:\n                break\n            if line.rstrip("\\n").split("\\t")[idx] == "Known":\n                known += 1\n            else:\n                novel += 1\n    qc["_isoform"] = {"known": known, "novel": novel, "novel_rate": round(novel / (known + novel), 4) if known + novel else None}\nwith open("qc/qc.json", "w") as out:\n    json.dump(qc, out, indent=2, ensure_ascii=False)\nPY', notes: '达标：比对率 >80%、全长转录本比例 >50%、novel isoform 比例合理（一般 <40%）；饱和度曲线用抽稀 reads 重跑 TALON 评估' },
        { title: 'Generate analysis report', command: 'python3 <RUN>/tools/encode_native_report.py --run-dir <RUN> --input-dir {{INPUT_DIR}} --report-dir <RUN>/reports/final-report\ntest -s <RUN>/reports/final-report/report.html', notes: '确定性报告生成器直接读取真实产物（QC 指标/峰文件/图）生成图文并茂的 HTML+MD 报告；AI 只需在回复里补充一段结论解读并给出报告绝对路径，不要重写报告文件' },
      ],
      manifest: {
        software: [
          { name: 'minimap2', module: 'minimap2/2.26', required: true },
          { name: 'SAMtools', module: 'SAMtools/1.17', required: true },
          { name: 'TALON', checkCmd: 'command -v talon_initialize_database', required: true },
          { name: 'FLAIR（备选）', checkCmd: 'command -v flair', required: false },
        ],
        references: [
          { name: 'Reference genome FASTA', path: '{{REF_FA}}', type: 'genome', source: '可留空：AI 运行时协助从集群公共库 /share/database/ 匹配', required: false },
          { name: 'Gene annotation GTF', path: '{{GTF}}', type: 'annotation', source: '可留空：AI 运行时协助从集群公共库 /share/database/ 匹配', required: false },
        ],
        inputHint: 'PacBio/ONT 长读长 FASTQ 目录，并说明测序平台',
        qcGates: [
          { afterStep: 2, metric: '比对率', pass: '>80%', warn: '60-80%' },
          { afterStep: 4, metric: '全长比例与 novel isoform', pass: '全长 >50%，novel <40%', warn: '全长 30-50%' },
        ],
      },
      source: 'builtin',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'builtin-job-troubleshoot',
      name: '集群作业排查流程',
      description: '作业失败或卡住时的标准排查路径：状态 → 日志 → 资源 → 重投。',
      keywords: ['作业', '排查', '失败', '报错', '卡住', 'bjobs', '挂起', 'pend', 'exit', '排障'],
      params: [{ name: 'JOBID', label: '作业号' }],
      steps: [
        { title: '查询当前作业状态', command: 'bjobs -l {{JOBID}} 2>&1', notes: '只查询这个作业号；不存在时进入下一步查历史，不扫描目录。' },
        { title: '查询作业历史', command: 'bhist -l {{JOBID}} 2>&1 | head -160', notes: '用于已结束或已离开活动队列的作业。' },
        { title: '读取调度器实时输出', command: 'bpeek {{JOBID}} 2>&1 | tail -80', optional: true, notes: '仅从 LSF 读取该作业输出，不在用户目录搜索 *.out/*.err。' },
        { title: '读取作业资源核算', command: 'bacct -l {{JOBID}} 2>&1 | head -180', optional: true, notes: '只分析该作业实际 CPU、内存与退出原因，不盘点全局队列或磁盘。' },
        { title: '形成排查结论', command: ':', notes: '安全空操作；仅根据前四步真实输出判断：运行中、排队、正常结束、退出失败或作业号不存在；写入步骤 summary，不生成额外报告。' },
      ],
      manifest: {
        software: [],
        references: [],
        qcGates: [],
      },
      source: 'builtin',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'builtin-blast',
      name: 'BLAST 同源比对流程',
      description: '建库 → 比对 → 结果整理的最小 BLAST 流程。',
      keywords: ['blast', '比对', '同源', '序列', 'makeblastdb', 'blastn', '相似'],
      params: [
        { name: 'QUERY', label: '查询序列文件（fasta）' },
        { name: 'DB', label: '数据库 fasta 路径' },
      ],
      steps: [
        { title: '构建比对数据库', command: 'bsub -q normal -n 4 "makeblastdb -in {{DB}} -dbtype nucl -out mydb"' },
        { title: '执行 blastn 比对', command: 'bsub -q normal -n 8 "blastn -query {{QUERY}} -db mydb -out blast_result.txt -evalue 1e-5 -outfmt 6 -num_threads 8"' },
        { title: '查看前 20 条结果', command: 'head -20 blast_result.txt' },
      ],
      manifest: {
        software: [
          { name: 'BLAST+', module: 'BLAST+/2.9.0', checkCmd: 'module av BLAST 2>&1 | grep -i blast || command -v blastn', required: true },
        ],
        references: [
          { name: '比对数据库 fasta', path: '{{DB}}', type: 'database', source: '用户自备，或公共库 /share/database/（NR/NT 等）', required: true },
        ],
        inputHint: '查询序列文件（fasta 格式）',
        qcGates: [],
      },
      source: 'builtin',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'builtin-disk-cleanup',
      name: '磁盘空间排查与清理流程',
      description: '磁盘写满/配额不足时：定位大目录 → 确认可删项 → 移到 /tmp 或清理。',
      keywords: ['磁盘', '空间', '清理', '配额', 'quota', 'du', '满', '不足'],
      params: [],
      steps: [
        { title: '查看配额使用', command: 'quota -s 2>/dev/null || diskquota' },
        { title: '定位大目录', command: 'du -sh .[!.]* * 2>/dev/null | sort -rh | head -20' },
        { title: '查看大文件', command: 'find . -type f -size +2G -exec ls -lh {} \\; 2>/dev/null | head -20', optional: true },
        { title: '待确认后移走到 /tmp（不要 rm）', command: 'echo "等待用户确认后执行：mv <目录> /tmp/"', notes: '需要用户确认后再执行' },
      ],
      manifest: {
        software: [],
        references: [],
        inputHint: '需要排查的目录（默认当前目录）',
        qcGates: [],
      },
      source: 'builtin',
      createdAt: now,
      updatedAt: now,
    },
  ];

  // ENCODE 流程分两类：chip/atac/rnaseq 用 TRACE 原生参数式定义（下方手写版，
  // 逐个指定参考文件路径，符合软件自己的参数模型）；其余 8 条用带固定上游版本
  // 与依赖图的官方 WDL 包装器覆盖。保留旧对象仅用于历史迁移定位。
  const NATIVE_ENCODE_IDS = new Set([
    'encode-chipseq-tf', 'encode-chipseq-histone', 'encode-rnaseq-bulk', 'encode-atacseq',
  ]);
  const officialAll = buildOfficialEncodeWorkflows(now);
  const officialEncode = new Map(officialAll
    .filter(workflow => !NATIVE_ENCODE_IDS.has(workflow.id))
    .map(workflow => [workflow.id, workflow]));
  for (let index = 0; index < workflows.length; index += 1) {
    const replacement = officialEncode.get(workflows[index].id);
    if (replacement) workflows[index] = replacement;
  }

  // DAP/ChIP/ATAC 统一质控契约：去除 blacklist，必产 SPOT + TSS 曲线，
  // 并在保留旧 ID 便于无感升级的前提下新增完整英文版。
  addChromatinWorkflowVariants(workflows, now);

  // The corrected DAG is the canonical TF ChIP-seq workflow. Keep the linear
  // template solely as its construction input; do not expose duplicate rows.
  const linearChipTf = workflows.find(workflow => workflow.id === 'encode-chipseq-tf');
  if (linearChipTf && !workflows.some(workflow => workflow.id === 'encode-chipseq-tf-dag')) {
    workflows.push(buildChipseqTfDagVariant(linearChipTf, now));
  }

  /**
   * ENCODE 金标准流程：第一步统一替换为可执行的环境检查脚本（软件/输入/参考），
   * 软件版本直接取 manifest.software（单一来源，避免与命令里的钉版漂移）。
   * 只读；必需软件缺失或必填输入目录不存在时 exit 1；可选参考未指定只提示。
   */
  const encodeEnvInputs: Record<string, string[]> = {
    'encode-chipseq-tf': ['INPUT_DIR', 'CONTROL_DIR'],
    'encode-chipseq-histone': ['INPUT_DIR', 'CONTROL_DIR'],
    'encode-eclip': ['INPUT_DIR', 'CONTROL_DIR'],
  };
  for (const workflow of workflows) {
    if (!workflow.id.startsWith('encode-')) continue;
    if (workflow.provenance?.implementation) continue;
    const manifest = workflow.manifest;
    if (!manifest?.software?.length || !workflow.steps.length) continue;
    const references = (manifest.references || [])
      .map(ref => {
        const match = String(ref.path || '').match(/^\{\{(\w+)\}\}$/);
        return match ? { param: match[1], label: ref.name, required: ref.required === true } : null;
      })
      .filter((ref): ref is { param: string; label: string; required: boolean } => Boolean(ref));
    workflow.steps[0] = {
      ...workflow.steps[0],
      title: '环境检查（软件、输入与参考）',
      command: buildEnvCheckCommand({
        job: workflow.id.replace(/^encode-/, '').replace(/[^A-Za-z0-9]+/g, '_'),
        software: manifest.software,
        inputs: encodeEnvInputs[workflow.id] || ['INPUT_DIR'],
        references,
      }),
      notes: '只读检查：必需软件缺失或输入目录不存在时以非 0 退出；先补齐环境（流程面板支持一键部署）再继续。可选参考留空时由 AI 在后续步骤协助补齐。',
    };
  }
  // 报告步骤引用确定性报告生成器的流程，自动携带该资产（创建 RUN 时部署进 RUN/tools/），
  // 避免逐条流程手写 assets 漏配（v0.4.27：报告简陋根因修复的配套）。
  for (const workflow of workflows) {
    const usesReport = workflow.steps.some(s => (s.command || '').includes('encode_native_report.py'));
    if (!usesReport) continue;
    const assets = workflow.assets || [];
    if (!assets.some(a => a.remotePath === 'tools/encode_native_report.py')) {
      workflow.assets = [...assets, {
        source: 'encode/encode_native_report.py', remotePath: 'tools/encode_native_report.py',
        label: workflow.id.endsWith('-en') ? 'Deterministic analysis and QC report generator' : '确定性分析与质控报告生成器',
      }];
    }
  }
  return includeRetired ? workflows : workflows.filter(w => !RETIRED_DUPLICATE_CHIP_IDS.has(w.id));
}

const RETIRED_DUPLICATE_CHIP_IDS = new Set(['encode-chipseq-tf', 'encode-chipseq-tf-en']);

/** Preserve edited/user workflows and all cluster runs. Remove only untouched
 * duplicate definitions, after saving a recoverable backup. */
async function retireDuplicateChipDefinitions(workflows: Workflow[]): Promise<boolean> {
  let changed = false;
  for (let index = workflows.length - 1; index >= 0; index--) {
    const row = workflows[index];
    if (!RETIRED_DUPLICATE_CHIP_IDS.has(row.id) || row.source !== 'builtin' || row.provenance?.customized) continue;
    const backup = dataPath('workflows', 'deleted-definitions', `retired-${row.id}-${Date.now()}-${crypto.randomUUID()}.json`);
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.writeFile(backup, JSON.stringify(row, null, 2), { encoding: 'utf-8', flag: 'wx' });
    workflows.splice(index, 1);
    changed = true;
  }
  return changed;
}

/**
 * loadWorkflows 磁盘缓存：get_workflow 等 Agent 工具每轮都会调用，避免反复全量读盘与种子深比较。
 * 以 mtimeMs+size 双判据命中（部分文件系统 mtime 精度低，同毫秒内重写时靠 size 兜底）；
 * 本模块所有写操作经 saveWorkflows 落盘并同步失效缓存。
 */
let storeCache: { mtimeMs: number; size: number; workflows: Workflow[] } | null = null;

// Serialize complete read/migrate/write cycles; catalogue actions cannot lose
// each other's changes or restore a concurrently deleted definition.
let storeQueue: Promise<unknown> = Promise.resolve();
function withStoreLock<T>(action: () => Promise<T>): Promise<T> {
  const pending = storeQueue.then(action);
  storeQueue = pending.catch(() => undefined);
  return pending;
}

/** 读盘完成后按最新文件状态写入缓存；stat 失败（如文件刚被删除）仅跳过本次缓存 */
async function updateStoreCache(workflows: Workflow[]): Promise<void> {
  try {
    const stat = await fs.stat(STORE_PATH);
    storeCache = { mtimeMs: stat.mtimeMs, size: stat.size, workflows };
  } catch { /* 无法 stat 时保持不缓存 */ }
}

/**
 * 读取时派生内置流程分类：未被用户自定义（provenance.customized）的内置流程
 * 一律按 BUILTIN_CATEGORIES 现算 category（内存内覆盖，不写回文件），
 * 映射表未来调整时老库自动跟随；用户自定义过的内置流程与用户/AI 流程保留库存值。
 * 分类不写盘是关键：workflows.json 必须与种子管线产出保持一致，
 * 任何派生字段落盘都会让 dev 环境（DATA_ROOT=cwd）下的库文件被迁移改写。
 */
function applyDerivedCategories(workflows: Workflow[]): void {
  for (const workflow of workflows) {
    if (workflow.source !== 'builtin' || workflow.provenance?.customized) continue;
    const category = BUILTIN_CATEGORIES[workflow.id];
    if (category) workflow.category = category;
  }
}

export async function loadWorkflows(): Promise<Workflow[]> {
  return withStoreLock(async () => {
    if (requestedCleanupEnabled) await cleanupRequestedCatalogueUnlocked();
    return loadWorkflowsUnlocked();
  });
}

/** One-time, user-requested definition cleanup. Never touches RUNs or results.
 * The marker prevents deleting subsequently created review drafts on restart. */
export async function cleanupRequestedWorkflowCatalogue(): Promise<void> {
  return withStoreLock(cleanupRequestedCatalogueUnlocked);
}

async function cleanupRequestedCatalogueUnlocked(): Promise<void> {
  try { await fs.access(CATALOGUE_CLEANUP_PATH); return; } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
  }
  const now = Date.now();
  const backupDir = dataPath('workflows', 'deleted-definitions', `catalogue-v0.5.16-${now}-${crypto.randomUUID()}`);
  await fs.mkdir(backupDir, { recursive: true });
  try {
    const original = await fs.readFile(STORE_PATH);
    await fs.writeFile(path.join(backupDir, 'original-catalogue.json'), original, { flag: 'wx' });
  } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const deleted = await loadDeletedBuiltinSeeds();
  for (const id of REQUESTED_KEEP_IDS) deleted.delete(id);
  await fs.mkdir(path.dirname(DELETED_SEEDS_PATH), { recursive: true });
  // Explicit retention overrides an earlier seed deletion only during this migration.
  const tombstoneTmp = `${DELETED_SEEDS_PATH}.tmp`;
  await fs.writeFile(tombstoneTmp, JSON.stringify([...deleted], null, 2), 'utf-8');
  await fs.rename(tombstoneTmp, DELETED_SEEDS_PATH);
  storeCache = null;
  bioskillsSeedsReady = false;
  const workflows = await loadWorkflowsUnlocked();
  if (![...REQUESTED_KEEP_IDS].every(id => workflows.some(w => w.id === id))) {
    throw new Error('Catalogue cleanup deferred: retained BioSkills definitions are unavailable');
  }
  for (const workflow of workflows) {
    if (REQUESTED_KEEP_IDS.has(workflow.id)) {
      workflow.lifecycle = { state: 'active', origin: 'user', updatedAt: now };
    }
  }
  const removed = workflows.filter(w => REQUESTED_REMOVE_IDS.has(w.id) || isPendingDisposal(w));
  // Persist the complete removed definitions before any removal/tombstone writes.
  await fs.writeFile(path.join(backupDir, 'workflows.json'), JSON.stringify(removed, null, 2), { encoding: 'utf-8', flag: 'wx' });
  for (const workflow of removed) if (workflow.source === 'builtin') deleted.add(workflow.id);
  for (const id of REQUESTED_REMOVE_IDS) deleted.add(id);
  // Prevent an older still-installed version from resurrecting the retired TF
  // aliases after reading this catalogue. Respect active customized definitions.
  for (const id of RETIRED_DUPLICATE_CHIP_IDS) if (!keptCustomizedId(id)) deleted.add(id);
  function keptCustomizedId(id: string): boolean {
    return workflows.some(w => w.id === id && w.provenance?.customized && !isPendingDisposal(w));
  }
  await fs.writeFile(tombstoneTmp, JSON.stringify([...deleted], null, 2), 'utf-8');
  await fs.rename(tombstoneTmp, DELETED_SEEDS_PATH);
  const removedIds = new Set(removed.map(w => w.id));
  const kept = workflows.filter(w => !removedIds.has(w.id));
  await writeWorkflows(kept);
  const markerTmp = `${CATALOGUE_CLEANUP_PATH}.tmp`;
  await fs.writeFile(markerTmp, JSON.stringify({ version: '0.5.16', at: now, removedIds: [...removedIds], retainedIds: [...REQUESTED_KEEP_IDS], backupDir }, null, 2), 'utf-8');
  await fs.rename(markerTmp, CATALOGUE_CLEANUP_PATH);
  await updateStoreCache(kept);
}

async function loadWorkflowsUnlocked(): Promise<Workflow[]> {
  try {
    const stat = await fs.stat(STORE_PATH);
    // bioSkills 种子校验未完成时不走缓存，保留下次读盘重试刷新的原行为
    if (bioskillsSeedsReady && storeCache
      && storeCache.mtimeMs === stat.mtimeMs && storeCache.size === stat.size) {
      // 现有调用方均只读（find/map/序列化），仅模块内 upsertWorkflow 会对返回数组
      // push/下标赋值，返回浅拷贝即可避免缓存数组被顺带改写
      return [...storeCache.workflows];
    }
  } catch { /* stat 失败走下方原读盘/重建逻辑 */ }
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      let workflows = parsed as Workflow[];
      // 迁移：内置流程为系统所有，params/manifest 随版本升级总是刷新为当前内置定义
      // （用户自建与 AI 生成的流程不受影响）；版本新增的内置流程自动入库
      let migrated = await retireDuplicateChipDefinitions(workflows);
      for (const workflow of workflows) {
        if (!workflow.provenance) continue;
        const before = JSON.stringify(workflow.provenance);
        workflow.provenance.provider = currentProvider(workflow.provenance.provider) as NonNullable<Workflow['provenance']>['provider'];
        workflow.provenance.upstreamWorkflow = currentProvider(workflow.provenance.upstreamWorkflow);
        workflow.provenance.sourceName = currentProductText(workflow.provenance.sourceName);
        if (workflow.provenance.sourceUrl) workflow.provenance.sourceUrl = currentProductText(workflow.provenance.sourceUrl);
        if (JSON.stringify(workflow.provenance) !== before) migrated = true;
      }
      // 用户删除过的内置种子：清出库存且不再注入，避免删除后“复活”
      const deletedSeedIds = await loadDeletedBuiltinSeeds();
      if (deletedSeedIds.size > 0) {
        const kept = workflows.filter(w => !(w.source === 'builtin' && deletedSeedIds.has(w.id)));
        if (kept.length !== workflows.length) { workflows = kept; migrated = true; }
      }
      for (const seed of builtinWorkflows()) {
        if (deletedSeedIds.has(seed.id)) continue;
        const stored = workflows.find(w => w.id === seed.id);
        if (!stored) {
          workflows.push(seed);
          migrated = true;
          continue;
        }
        // 用户在编辑器改过的内置流程（含 6 个硬编码种子）不再被种子迁移覆盖
        if (stored.provenance?.customized) continue;
        if (JSON.stringify(stored.manifest) !== JSON.stringify(seed.manifest)) {
          stored.manifest = seed.manifest;
          migrated = true;
        }
        if (stored.name !== seed.name) {
          stored.name = seed.name;
          migrated = true;
        }
        if (stored.description !== seed.description) {
          stored.description = seed.description;
          migrated = true;
        }
        if (JSON.stringify(stored.keywords) !== JSON.stringify(seed.keywords)) {
          stored.keywords = seed.keywords;
          migrated = true;
        }
        if (JSON.stringify(stored.params) !== JSON.stringify(seed.params)) {
          stored.params = seed.params;
          migrated = true;
        }
        if (JSON.stringify(stored.steps) !== JSON.stringify(seed.steps)) {
          stored.steps = seed.steps;
          migrated = true;
        }
        if (JSON.stringify(stored.assets) !== JSON.stringify(seed.assets)) {
          stored.assets = seed.assets;
          migrated = true;
        }
        if (JSON.stringify(stored.provenance) !== JSON.stringify(seed.provenance)) {
          stored.provenance = seed.provenance;
          migrated = true;
        }
      }
      if (migrated) await writeWorkflows(workflows);
      await ensureBioskillsSeeds(workflows);
      if (classifyWorkflowCatalog(workflows)) await writeWorkflows(workflows);
      // 分类不落盘派生：内置流程 category 每次读取时按 BUILTIN_CATEGORIES 现算，
      // 避免迁移把派生字段写回持久化文件（workflows.json 与 builtinWorkflows() 保持对齐）
      applyDerivedCategories(workflows);
      await updateStoreCache(workflows);
      return workflows;
    }
    throw new SyntaxError('Workflow store must be an array');
  } catch (err: any) {
    if (err?.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
    if (err instanceof SyntaxError) {
      // 文件损坏时备份后重建，避免流程全部丢失
      try { await fs.rename(STORE_PATH, `${STORE_PATH}.broken-${Date.now()}`); } catch { /* ignore */ }
    }
  }
  const deletedSeedIds = await loadDeletedBuiltinSeeds();
  const seeds = builtinWorkflows().filter(seed => !deletedSeedIds.has(seed.id));
  await writeWorkflows(seeds);
  await ensureBioskillsSeeds(seeds);
  if (classifyWorkflowCatalog(seeds)) await writeWorkflows(seeds);
  applyDerivedCategories(seeds);
  await updateStoreCache(seeds);
  return seeds;
}

/**
 * bioSkills 流水线种子：从打包的 skills/bioSkills/workflows/ 生成流程并入库。
 * 新装用户首次启动自动获得全部 bioSkills 流程；版本号变化时刷新既有条目
 * （manifest/steps/params 为系统生成内容，用户自改的名称/关键词保留）。
 */
let bioskillsSeedsReady = false;
let bioskillsSeedPromise: Promise<boolean> | null = null;

async function refreshBioskillsSeeds(workflows: Workflow[]): Promise<boolean> {
  try {
    let marker = '';
    try { marker = (await fs.readFile(SEED_MARKER_PATH, 'utf-8')).trim(); } catch { /* 无标记 */ }
    const generated = await generateBioskillsWorkflows(appPath('skills'), BUILTIN_CATEGORIES);
    if (generated.length === 0) return false;
    const expectedIds = new Set(generated.map(workflow => workflow.id));
    // 用户删除过的种子视为“已满足”，不再注入也不再触发重复全量刷新
    const deletedSeedIds = await loadDeletedBuiltinSeeds();
    const complete = generated.every(gen => {
      if (deletedSeedIds.has(gen.id)) return true;
      const stored = workflows.find(workflow => workflow.id === gen.id);
      return stored && (stored.provenance?.customized || stored.provenance?.importerVersion === BIOSKILLS_SEED_VERSION);
    });
    const hasObsolete = workflows.some(workflow => workflow.id.startsWith('bioskills-') && workflow.source === 'builtin' && !expectedIds.has(workflow.id) && !deletedSeedIds.has(workflow.id) && !workflow.lifecycle && !workflow.provenance?.customized);
    if (marker === BIOSKILLS_SEED_VERSION && complete && !hasObsolete) return true;

    const result = mergeGeneratedBioskills(workflows, generated, deletedSeedIds);
    if (result.changed) await writeWorkflows(workflows);
    await fs.mkdir(path.dirname(SEED_MARKER_PATH), { recursive: true });
    await fs.writeFile(SEED_MARKER_PATH, BIOSKILLS_SEED_VERSION, 'utf-8');
    return true;
  } catch (error) {
    // 全量生成失败时保留旧库，禁止静默写入一个残缺的 BioSkills 子集。
    console.warn('[workflows] BioSkills seed refresh skipped:', error);
    return false;
  }
}

/**
 * BioSkill 来源目录很大，生成器会读取并解析每个 SKILL.md。一个进程生命周期内
 * 只做一次完整校验；并发请求共享同一个 Promise，避免流程页打开时重复扫描磁盘。
 */
async function ensureBioskillsSeeds(workflows: Workflow[]): Promise<void> {
  if (bioskillsSeedsReady) return;
  if (bioskillsSeedPromise) {
    await bioskillsSeedPromise;
    // 若本请求在首次校验进行中读到了旧文件，使用首次校验写回后的最新内容。
    try {
      const latest = JSON.parse(await fs.readFile(STORE_PATH, 'utf-8'));
      if (Array.isArray(latest)) workflows.splice(0, workflows.length, ...latest as Workflow[]);
    } catch { /* 首次请求仍会返回它已经加载到的安全副本 */ }
    return;
  }

  const pending = refreshBioskillsSeeds(workflows);
  bioskillsSeedPromise = pending;
  try {
    bioskillsSeedsReady = await pending;
  } finally {
    if (bioskillsSeedPromise === pending) bioskillsSeedPromise = null;
  }
}

/**
 * 合并系统生成的 BioSkills 流程：
 * - 旧版/未自定义条目全字段刷新；
 * - 用户编辑过的条目保留；
 * - 删除来源中已不存在的系统条目；用户复制/自建流程不受影响；
 * - deletedSeedIds 中的条目（用户删除过的内置种子）不再注入，残留项直接移除。
 */
export function mergeGeneratedBioskills(workflows: Workflow[], generated: Workflow[], deletedSeedIds?: Set<string>): {
  changed: boolean;
  added: number;
  updated: number;
  removed: number;
  preserved: number;
} {
  const expectedIds = new Set(generated.map(workflow => workflow.id));
  let added = 0;
  let updated = 0;
  let removed = 0;
  let preserved = 0;

  for (let index = workflows.length - 1; index >= 0; index--) {
    const workflow = workflows[index];
    if (workflow.id.startsWith('bioskills-') && workflow.source === 'builtin' && !expectedIds.has(workflow.id)
      && !workflow.lifecycle && !workflow.provenance?.customized) {
      workflow.lifecycle = { state: 'pending_disposal', origin: 'automatic', reasonCode: 'retired_seed', updatedAt: Date.now() };
      updated++;
    }
  }

  // category 不在受管字段内：内置分类读取时派生（applyDerivedCategories），
  // 避免因生成器注入 category 而对既有库存产生“伪差异”触发整库重写
  const managedKeys: Array<keyof Workflow> = [
    'name', 'description', 'keywords', 'params', 'steps', 'manifest', 'assets', 'provenance', 'source',
  ];
  for (const generatedWorkflow of generated) {
    if (deletedSeedIds?.has(generatedWorkflow.id)) {
      // 用户删除过的种子不再复活；若因外部改写残留则移除
      const staleIndex = workflows.findIndex(workflow => workflow.id === generatedWorkflow.id);
      if (staleIndex >= 0) {
        workflows.splice(staleIndex, 1);
        removed++;
      }
      continue;
    }
    const existing = workflows.find(workflow => workflow.id === generatedWorkflow.id);
    if (!existing) {
      workflows.push(generatedWorkflow);
      added++;
      continue;
    }
    if (existing.provenance?.provider === 'bioskills' && existing.provenance.customized) {
      preserved++;
      continue;
    }
    const differs = managedKeys.some(key => JSON.stringify(existing[key]) !== JSON.stringify(generatedWorkflow[key]));
    if (!differs) continue;
    for (const key of managedKeys) (existing as any)[key] = generatedWorkflow[key];
    existing.updatedAt = Date.now();
    updated++;
  }
  return { changed: added + updated + removed > 0, added, updated, removed, preserved };
}

export async function saveWorkflows(workflows: Workflow[]): Promise<void> {
  return withStoreLock(() => writeWorkflows(workflows));
}

async function writeWorkflows(workflows: Workflow[]): Promise<void> {
  storeCache = null; // 写盘即失效读缓存，下一次 loadWorkflows 重新读文件
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(workflows, null, 2), 'utf-8');
  await fs.rename(tmp, STORE_PATH);
}

export async function upsertWorkflow(input: Partial<Workflow> & { name: string }): Promise<Workflow> {
  return withStoreLock(() => upsertWorkflowUnlocked(input));
}

async function upsertWorkflowUnlocked(input: Partial<Workflow> & { name: string }): Promise<Workflow> {
  const workflows = await loadWorkflowsUnlocked();
  const now = Date.now();
  if (input.id) {
    const idx = workflows.findIndex(w => w.id === input.id);
    if (idx >= 0) {
      const previous = workflows[idx];
      const merged = { ...previous, ...input, id: input.id, updatedAt: now } as Workflow;
      // 编辑未携带 manifest/assets 时保留原值，避免被 undefined 覆盖
      if (input.manifest === undefined) merged.manifest = workflows[idx].manifest;
      if (input.assets === undefined) merged.assets = workflows[idx].assets;
      if (input.paperImport === undefined) merged.paperImport = workflows[idx].paperImport;
      // category：未携带保持原值；空串表示用户在编辑器里清除分类
      if (input.category === undefined) merged.category = previous.category;
      else if (input.category === '') delete merged.category;
      // 用户编辑内置流程（BioSkills 与 6 个硬编码种子）后打标，
      // 后续种子迁移/刷新尊重 customized，不再回滚用户内容
      if (previous.source === 'builtin') {
        merged.provenance = { ...previous.provenance, customized: true };
      }
      workflows[idx] = merged;
      classifyWorkflowCatalog(workflows);
      await writeWorkflows(workflows);
      return workflows[idx];
    }
  }
  const workflow: Workflow = {
    id: crypto.randomUUID(),
    name: input.name,
    description: input.description || '',
    keywords: input.keywords || [],
    params: input.params || [],
    steps: input.steps || [],
    source: input.source || 'user',
    createdAt: now,
    updatedAt: now,
  };
  if (input.category) workflow.category = input.category;
  if (input.manifest) workflow.manifest = input.manifest;
  if (input.assets) workflow.assets = input.assets;
  if (input.paperImport) workflow.paperImport = input.paperImport;
  workflows.push(workflow);
  classifyWorkflowCatalog(workflows);
  await writeWorkflows(workflows);
  return workflow;
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  return withStoreLock(() => deleteWorkflowUnlocked(id));
}

async function deleteWorkflowUnlocked(id: string): Promise<boolean> {
  const workflows = await loadWorkflowsUnlocked();
  const target = workflows.find(w => w.id === id);
  if (!target) return false;
  const next = workflows.filter(w => w.id !== id);
  const backup = dataPath('workflows', 'deleted-definitions', `${Date.now()}-${crypto.randomUUID()}.json`);
  await fs.mkdir(path.dirname(backup), { recursive: true });
  await fs.writeFile(backup, JSON.stringify(target, null, 2), 'utf-8');
  // 内置种子删除后登记，load/merge 不再复活；用户/AI 流程不会被种子注入，无需记录
  if (target.source === 'builtin') await rememberDeletedBuiltinSeed(id);
  await writeWorkflows(next);
  return true;
}

export async function setWorkflowLifecycle(id: string, state: 'active' | 'pending_disposal', reason = ''): Promise<Workflow | null> {
  return withStoreLock(async () => {
    const workflows = await loadWorkflowsUnlocked();
    const index = workflows.findIndex(w => w.id === id);
    if (index < 0) return null;
    const previous = workflows[index];
    const workflow: Workflow = { ...previous, lifecycle: {
      state, origin: 'user', updatedAt: Date.now(),
      ...(state === 'pending_disposal' ? { reasonCode: 'manual' as const, ...(reason ? { reason } : {}) } : {}),
    } };
    workflows[index] = workflow;
    // Visibility is not a scientific customization; seed upgrades still work.
    await writeWorkflows(workflows);
    return workflow;
  });
}
