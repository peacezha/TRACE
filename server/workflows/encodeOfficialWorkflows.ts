import type { Workflow, WorkflowStep } from './workflowTypes';

const CHIP_REPO = 'https://github.com/ENCODE-DCC/chip-seq-pipeline2.git';
const CHIP_REF = '26eeda81a0540dc793fc69b0c390d232ca7ca50a'; // v2.2.2
const RNA_REPO = 'https://github.com/ENCODE-DCC/rna-seq-pipeline.git';
const RNA_REF = '53d8c96a112bfa1079f21e680a7bfc3df3a6f031'; // dev, audited 2026-09-22

function command(...lines: string[]): string {
  return lines.join('\n');
}

function repositoryStep(
  id: string,
  title: string,
  dependsOn: string[],
  phase: string,
  shell: string,
  evidence: string,
  outputs: string[],
  optional = false,
): WorkflowStep {
  return {
    id,
    title,
    dependsOn,
    phase,
    command: shell,
    optional,
    agent: {
      kind: phase === 'QC' ? 'qc' : phase === 'Report' ? 'report' : 'compute',
      sourceType: 'repository',
      sourceSection: `official WDL · ${phase}`,
      evidence,
      confidence: 'high',
      outputs,
      contractVersion: 'encode-official-wrapper-v1',
    },
  };
}

function findManifest(name: string, findArgs: string, required = true, searchRoot = '<RUN>/results/caper'): string {
  return command(
    'mkdir -p <RUN>/results/manifests',
    `find ${searchRoot} -type f ${findArgs} -print 2>/dev/null | sort -u > <RUN>/results/manifests/${name}.txt`,
    required
      ? `test -s <RUN>/results/manifests/${name}.txt || { echo "Official task outputs not found: ${name}" >&2; exit 1; }`
      : `if [ ! -s <RUN>/results/manifests/${name}.txt ]; then echo "SKIP: the official run did not produce ${name}" | tee <RUN>/results/manifests/${name}.skip.txt; fi`,
    `wc -l <RUN>/results/manifests/${name}.txt 2>/dev/null || true`,
  );
}

function officialPreflight(pipeline: 'chip' | 'rna'): string {
  return command(
    `#BSUB -J encode_${pipeline}_env -n 1 -q {{QUEUE}}`,
    'set -euo pipefail',
    'command -v git >/dev/null',
    'command -v python3 >/dev/null',
    'command -v java >/dev/null',
    'command -v caper >/dev/null',
    'command -v croo >/dev/null',
    'case "{{EXECUTION_ENV}}" in singularity) command -v singularity >/dev/null ;; conda) command -v conda >/dev/null ;; *) echo "EXECUTION_ENV must be singularity or conda" >&2; exit 2 ;; esac',
    'test -s "{{SAMPLE_SHEET}}"',
    'CAPER_CONF="{{CAPER_CONFIG}}"',
    'if [ "$CAPER_CONF" = "~/.caper/default.conf" ]; then CAPER_CONF="$HOME/.caper/default.conf"; fi',
    'test -s "$CAPER_CONF"',
    'grep -Eq "^[[:space:]]*backend[[:space:]]*=[[:space:]]*lsf" "$CAPER_CONF" || { echo "Caper config is not an LSF backend" >&2; exit 2; }',
    'java -version 2>&1 | head -1',
    'caper --version',
  );
}

function chipWorkflow(now: number): Workflow {
  const steps: WorkflowStep[] = [
    repositoryStep('preflight', 'Preflight: official runtime and sample sheet', [], 'Prepare', officialPreflight('chip'), 'Caper LSF, container runtime, Java, Croo and the sample sheet must be ready.', [], false),
    repositoryStep('source', 'Fetch and pin official chip-seq-pipeline2 v2.2.2', ['preflight'], 'Prepare', command(
      'mkdir -p <RUN>/code',
      `if [ ! -d <RUN>/code/chip-seq-pipeline2/.git ]; then git clone --filter=blob:none --no-checkout ${CHIP_REPO} <RUN>/code/chip-seq-pipeline2; fi`,
      `git -C <RUN>/code/chip-seq-pipeline2 fetch --depth 1 origin ${CHIP_REF}`,
      `git -C <RUN>/code/chip-seq-pipeline2 checkout --detach ${CHIP_REF}`,
      `test "$(git -C <RUN>/code/chip-seq-pipeline2 rev-parse HEAD)" = "${CHIP_REF}"`,
    ), 'Locked by both the official v2.2.2 tag and the commit SHA.', ['<RUN>/code/chip-seq-pipeline2/chip.wdl']),
    repositoryStep('input-json', 'Sample lanes/technical replicates → official input JSON', ['preflight'], 'Prepare', command(
      'mkdir -p <RUN>/config',
      'python3 <RUN>/tools/build_chip_input.py --sample-sheet "{{SAMPLE_SHEET}}" --genome-tsv "{{GENOME_TSV}}" --genome-name "{{GENOME_NAME}}" --title "{{TITLE}}" --output <RUN>/config/encode-chip.json',
      'python3 -m json.tool <RUN>/config/encode-chip.json >/dev/null',
    ), 'The sample sheet is grouped by biological replicate; multiple rows of the same replicate are handed to the official pipeline as technical replicates for merging.', ['<RUN>/config/encode-chip.json']),
    repositoryStep('align-filter', 'Run official WDL: ChIP alignment, filtering, dedup', ['source', 'input-json'], 'Alignment', command(
      '#BSUB -J trace_encode_chip -n 1 -q {{QUEUE}}',
      'mkdir -p <RUN>/results/caper',
      'CAPER_CONF="{{CAPER_CONFIG}}"',
      'if [ "$CAPER_CONF" = "~/.caper/default.conf" ]; then CAPER_CONF="$HOME/.caper/default.conf"; fi',
      'case "{{EXECUTION_ENV}}" in singularity) ENV_FLAG=--singularity ;; conda) ENV_FLAG=--conda ;; *) exit 2 ;; esac',
      'cd <RUN>/results/caper',
      'caper -c "$CAPER_CONF" run <RUN>/code/chip-seq-pipeline2/chip.wdl -i <RUN>/config/encode-chip.json "$ENV_FLAG" --lsf-queue "{{QUEUE}}" --local-out-dir <RUN>/results/caper --metadata-output <RUN>/results/caper/metadata.json | tee <RUN>/results/caper/run.log',
    ), 'TRACE submits this script as the LSF leader job; caper run blocks inside the leader until the official WDL reaches a terminal state, avoiding false completion after an async submit returns. Later nodes only verify official task outputs.', ['<RUN>/results/caper/run.log', '<RUN>/results/caper/metadata.json']),
    repositoryStep('control-filter', 'Control alignment, filtering and depth matching', ['input-json', 'align-filter'], 'Alignment', findManifest('control-filter', "\\( -path '*call-align_ctl*' -o -path '*call-filter_ctl*' -o -name '*ctl*.nodup.bam' \\)"), 'The official pipeline picks the same-index or pooled control for each replicate and subsamples it per depth rules.', ['<RUN>/results/manifests/control-filter.txt']),
    repositoryStep('xcor', 'Cross-correlation and fragment length (NSC/RSC)', ['align-filter'], 'QC', findManifest('xcor', "\\( -path '*call-xcor*' -o -name '*.cc.qc' -o -name '*.cc.plot.pdf' \\)"), 'Official xcor results feed the TF peak-calling fragment length and NSC/RSC metrics.', ['<RUN>/results/manifests/xcor.txt']),
    repositoryStep('signals', 'p-value / fold-change signal tracks', ['align-filter', 'control-filter'], 'Signal', findManifest('signal-tracks', "\\( -name '*.pval.signal.bigwig' -o -name '*.fc.signal.bigwig' -o -name '*.bw' \\)"), 'The official WDL generates signal tracks for each replicate and the pooled replicate.', ['<RUN>/results/manifests/signal-tracks.txt']),
    repositoryStep('replicate-peaks', 'SPP peaks on true biological replicates', ['xcor', 'control-filter'], 'Peak Calling', findManifest('true-replicate-peaks', "\\( -path '*call-call_peak/*' -o -name '*.regionPeak.gz' -o -name '*.narrowPeak.gz' \\)"), 'TF defaults to peak_caller=spp; these candidate peaks are not the final consensus peaks.', ['<RUN>/results/manifests/true-replicate-peaks.txt']),
    repositoryStep('self-pseudoreps', 'Self-pseudoreplicate splitting and peak calling per replicate', ['align-filter', 'xcor', 'control-filter'], 'Pseudoreplicates', findManifest('self-pseudoreplicates', "\\( -path '*call-spr*' -o -path '*call-call_peak_pr1*' -o -path '*call-call_peak_pr2*' \\)"), 'Official spr shuffles/splits each biological replicate into two self-pseudoreplicates.', ['<RUN>/results/manifests/self-pseudoreplicates.txt']),
    repositoryStep('pooled-pseudoreps', 'Pooled-replicate and pooled-pseudoreplicate peaks', ['align-filter', 'xcor', 'control-filter'], 'Pseudoreplicates', findManifest('pooled-pseudoreplicates', "\\( -path '*call-pool_ta*' -o -path '*call-call_peak_pooled*' -o -path '*call-call_peak_ppr*' \\)"), 'The official pipeline builds the pooled true replicate plus pooled PR1/PR2.', ['<RUN>/results/manifests/pooled-pseudoreplicates.txt']),
    repositoryStep('true-idr', 'Pairwise IDR on true replicates (Nt)', ['replicate-peaks'], 'IDR', findManifest('true-replicate-idr', "\\( -path '*call-idr/execution*' -o -name '*.idr0.05.*' \\)"), 'The official WDL runs IDR on all true-replicate pairs with chip.idr_thresh=0.05.', ['<RUN>/results/manifests/true-replicate-idr.txt']),
    repositoryStep('self-idr', 'Self-pseudoreplicate IDR (N1, N2…)', ['self-pseudoreps'], 'IDR', findManifest('self-pseudoreplicate-idr', "\\( -path '*call-idr_pr*' -o -name '*pr1*pr2*idr*' \\)"), 'Self-consistency IDR peak counts are computed per biological replicate.', ['<RUN>/results/manifests/self-pseudoreplicate-idr.txt']),
    repositoryStep('pooled-idr', 'Pooled-pseudoreplicate IDR (Np)', ['pooled-pseudoreps'], 'IDR', findManifest('pooled-pseudoreplicate-idr', "\\( -path '*call-idr_ppr*' -o -name '*pooled*idr*' \\)"), 'The IDR peak count of pooled PR1 vs pooled PR2 is Np.', ['<RUN>/results/manifests/pooled-pseudoreplicate-idr.txt']),
    repositoryStep('reproducibility', 'Reproducibility assessment and optimal/conservative peaks', ['true-idr', 'self-idr', 'pooled-idr'], 'QC', findManifest('reproducibility', "\\( -path '*call-reproducibility_idr*' -o -name '*optimal_peak*' -o -name '*conservative_peak*' -o -name '*reproducibility*qc*' \\)"), 'The official script computes rescue ratio=max(Np,Nt)/min(Np,Nt) and self-consistency ratio=max(Ni)/min(Ni), then selects the optimal/conservative peak sets.', ['<RUN>/results/manifests/reproducibility.txt']),
    repositoryStep('report', 'Croo summary of official outputs and QC report', ['signals', 'reproducibility'], 'Report', command(
      'mkdir -p <RUN>/results/croo',
      'META=$(find <RUN>/results/caper -type f -name metadata.json -print 2>/dev/null | sort | tail -1)',
      'test -n "$META" && test -s "$META"',
      'cd <RUN>/results/croo && croo "$META"',
      `printf '%s\n' 'source=${CHIP_REPO}' 'ref=${CHIP_REF}' 'pipeline=chip-seq-pipeline2 v2.2.2' > <RUN>/results/ENCODE_PROVENANCE.txt`,
    ), 'Croo reads Caper metadata.json, preserving traceability of official tasks, files and QC.', ['<RUN>/results/croo', '<RUN>/results/ENCODE_PROVENANCE.txt']),
  ];
  return {
    id: 'encode-chipseq-tf',
    name: 'ENCODE-DCC TF ChIP-seq v2.2.2 (official WDL)',
    description: 'Directly wraps ENCODE-DCC chip-seq-pipeline2 v2.2.2. The official WDL performs alignment/filtering, xcor, SPP, three-way IDR across true/self-pseudoreplicate/pooled-pseudoreplicate branches, rescue/self-consistency assessment, and optimal/conservative peaks; TRACE only generates the official input JSON, submits via Caper, and verifies the outputs.',
    keywords: ['encode', 'chipseq', 'chip-seq', '转录因子', 'tf', 'spp', 'idr', 'pseudoreplicate', 'optimal peaks', 'conservative peaks'],
    params: [
      { name: 'SAMPLE_SHEET', label: 'Sample sheet TSV (type, replicate, read1, read2)', type: 'path', help: 'type=chip/control; multiple rows of the same replicate are technical replicate lanes; use absolute FASTQ paths.' },
      { name: 'GENOME_TSV', label: 'Official ENCODE genome TSV', type: 'path', help: 'Includes ref_fa, indices, chrom sizes, blacklist and other official references.' },
      { name: 'GENOME_NAME', label: 'Genome name in the genome TSV', defaultValue: 'GRCh38', type: 'text' },
      { name: 'TITLE', label: 'Experiment title', defaultValue: 'TRACE ENCODE TF ChIP-seq', type: 'text' },
      { name: 'CAPER_CONFIG', label: 'Caper LSF config', defaultValue: '~/.caper/default.conf', type: 'path' },
      { name: 'EXECUTION_ENV', label: 'Official task runtime', defaultValue: 'singularity', type: 'select', options: ['singularity', 'conda'] },
      { name: 'QUEUE', label: 'LSF queue', defaultValue: 'normal', type: 'text' },
    ],
    steps,
    assets: [{ source: 'encode/build_chip_input.py', remotePath: 'tools/build_chip_input.py', label: 'ENCODE ChIP official input JSON generator' }],
    manifest: {
      software: [
        { name: 'Git', checkCmd: 'command -v git', required: true },
        { name: 'Python 3', checkCmd: 'command -v python3', required: true },
        { name: 'Java 11+', checkCmd: 'java -version 2>&1 | grep -Eq "version \\"(1[1-9]|[2-9][0-9])"', required: true },
        { name: 'Caper', checkCmd: 'command -v caper', versionCmd: 'caper --version', required: true },
        { name: 'Singularity (or conda)', checkCmd: 'command -v singularity || command -v conda', required: true },
        { name: 'Croo', checkCmd: 'command -v croo', required: true },
      ],
      references: [{ name: 'ENCODE genome TSV', path: '{{GENOME_TSV}}', type: 'other', source: 'chip-seq-pipeline2 genome TSV', required: true }],
      inputHint: 'TSV header: type<TAB>replicate<TAB>read1<TAB>read2; technical replicates use multiple rows with the same replicate.',
      qcGates: [
        { afterStep: 6, metric: 'NSC/RSC and fragment length', pass: 'Judged by the official qc.json per assay/organism standards' },
        { afterStep: 13, metric: 'IDR reproducibility', pass: 'rescue ratio ≤2 and self-consistency ratio ≤2', warn: 'either ratio >2; both >2 indicates severe inconsistency' },
      ],
    },
    provenance: {
      provider: 'encode-dcc', sourceName: 'ENCODE-DCC chip-seq-pipeline2', sourceUrl: 'https://github.com/ENCODE-DCC/chip-seq-pipeline2',
      sourceRef: `v2.2.2 (${CHIP_REF})`, upstreamWorkflow: 'chip.wdl', implementation: 'official-wrapper', importerVersion: 'encode-wrapper-v1',
    },
    source: 'builtin', createdAt: now, updatedAt: now,
  };
}

function rnaWorkflow(now: number): Workflow {
  const steps: WorkflowStep[] = [
    repositoryStep('preflight', 'Preflight: official runtime and sample sheet', [], 'Prepare', officialPreflight('rna'), 'Strictly scoped to ENCPL002LPE: paired-end, stranded; Caper LSF and the container runtime must be ready.', []),
    repositoryStep('source', 'Fetch and pin the current official rna-seq-pipeline', ['preflight'], 'Prepare', command(
      'mkdir -p <RUN>/code',
      `if [ ! -d <RUN>/code/rna-seq-pipeline/.git ]; then git clone --filter=blob:none --no-checkout ${RNA_REPO} <RUN>/code/rna-seq-pipeline; fi`,
      `git -C <RUN>/code/rna-seq-pipeline fetch --depth 1 origin ${RNA_REF}`,
      `git -C <RUN>/code/rna-seq-pipeline checkout --detach ${RNA_REF}`,
      `test "$(git -C <RUN>/code/rna-seq-pipeline rev-parse HEAD)" = "${RNA_REF}"`,
    ), 'Pinned to the audited upstream commit to prevent drift from dev branch changes.', ['<RUN>/code/rna-seq-pipeline/rna-seq-pipeline.wdl']),
    repositoryStep('input-json', 'Technical replicate lanes → ENCPL002LPE official input JSON', ['preflight'], 'Prepare', command(
      'mkdir -p <RUN>/config',
      'python3 <RUN>/tools/build_rna_input.py --sample-sheet "{{SAMPLE_SHEET}}" --star-index "{{STAR_INDEX}}" --rsem-index "{{RSEM_INDEX}}" --kallisto-index "{{KALLISTO_INDEX}}" --chrom-sizes "{{CHROM_SIZES}}" --gene-type-map "{{GENE_TYPE_MAP}}" --strand-direction "{{STRAND_DIRECTION}}" --bam-root "{{BAM_ROOT}}" --threads "{{THREADS}}" --align-ram-gb "{{ALIGN_RAM_GB}}" --rsem-ram-gb "{{RSEM_RAM_GB}}" --kallisto-ram-gb "{{KALLISTO_RAM_GB}}" --signals-ram-gb "{{SIGNALS_RAM_GB}}" --task-disk "{{TASK_DISK}}" --output <RUN>/config/encode-rna.json',
      'python3 -m json.tool <RUN>/config/encode-rna.json >/dev/null',
    ), 'Generates nested FASTQ arrays; multiple lanes of the same biological replicate are merged automatically by the official pipeline.', ['<RUN>/config/encode-rna.json']),
    repositoryStep('star', 'Run official WDL: STAR genomic/transcriptomic alignment', ['source', 'input-json'], 'RNA-seq', command(
      '#BSUB -J trace_encode_rna -n 1 -q {{QUEUE}}',
      'mkdir -p <RUN>/results/caper',
      'CAPER_CONF="{{CAPER_CONFIG}}"',
      'if [ "$CAPER_CONF" = "~/.caper/default.conf" ]; then CAPER_CONF="$HOME/.caper/default.conf"; fi',
      'case "{{EXECUTION_ENV}}" in singularity) ENV_FLAG=--singularity ;; conda) ENV_FLAG=--conda ;; *) exit 2 ;; esac',
      'cd <RUN>/results/caper',
      'caper -c "$CAPER_CONF" run <RUN>/code/rna-seq-pipeline/rna-seq-pipeline.wdl -i <RUN>/config/encode-rna.json "$ENV_FLAG" --lsf-queue "{{QUEUE}}" --local-out-dir <RUN>/results/caper --metadata-output <RUN>/results/caper/metadata.json | tee <RUN>/results/caper/run.log',
    ), 'TRACE submits this script as the LSF leader job; caper run blocks inside the leader until the official WDL terminates. This node corresponds to the STAR main branch; later nodes verify the real outputs of the parallel tasks.', ['<RUN>/results/caper/run.log', '<RUN>/results/caper/metadata.json']),
    repositoryStep('kallisto', 'Kallisto transcript quantification in parallel', ['input-json', 'star'], 'RNA-seq', findManifest('kallisto', "\\( -name 'abundance.tsv' -o -name 'abundance.h5' -o -path '*call-kallisto*' \\)"), 'Kallisto is the default branch of the official long RNA-seq pipeline and is not omitted.', ['<RUN>/results/manifests/kallisto.txt']),
    repositoryStep('signals', 'unique/all × plus/minus bigWig signals (4 tracks)', ['star'], 'RNA-seq', findManifest('signal-tracks', "\\( -name '*.bw' -o -name '*.bigWig' -o -name '*.bigwig' \\)"), 'Stranded data should contain unique/all-mapped plus/minus signal tracks.', ['<RUN>/results/manifests/signal-tracks.txt']),
    repositoryStep('rsem', 'RSEM gene/isoform quantification and detected genes', ['star'], 'RNA-seq', findManifest('rsem', "\\( -name '*.genes.results' -o -name '*.isoforms.results' -o -name '*detected*gene*' -o -path '*call-rsem*' \\)"), 'The official RSEM branch outputs gene/isoform tables and counts detected genes with TPM>1.', ['<RUN>/results/manifests/rsem.txt']),
    repositoryStep('rna-qc', 'flagstat and reads-by-gene-type QC', ['star'], 'QC', findManifest('rna-qc', "\\( -name '*flagstat*' -o -name '*gene_type*' -o -path '*call-rna_qc*' \\)"), 'RNA QC uses the transcript_id→gene_type mapping, covering rRNA, protein-coding, non-coding and spike-in.', ['<RUN>/results/manifests/rna-qc.txt']),
    repositoryStep('mad-qc', 'Two-replicate MAD expression consistency QC', ['rsem'], 'QC', findManifest('mad-qc', "\\( -path '*call-mad_qc*' -o -iname '*mad*qc*' \\)", false), 'The official MAD QC runs only with exactly two biological replicates; other replicate counts get an explicit SKIP record.', ['<RUN>/results/manifests/mad-qc.txt'], true),
    repositoryStep('report', 'Croo summary of official outputs and traceable report', ['kallisto', 'signals', 'rsem', 'rna-qc', 'mad-qc'], 'Report', command(
      'mkdir -p <RUN>/results/croo',
      'META=$(find <RUN>/results/caper -type f -name metadata.json -print 2>/dev/null | sort | tail -1)',
      'test -n "$META" && test -s "$META"',
      'cd <RUN>/results/croo && croo "$META"',
      `printf '%s\n' 'source=${RNA_REPO}' 'ref=${RNA_REF}' 'portal=ENCPL002LPE' > <RUN>/results/ENCODE_PROVENANCE.txt`,
    ), 'Croo organizes official outputs from metadata.json; the report keeps the portal accession, source repository and exact commit.', ['<RUN>/results/croo', '<RUN>/results/ENCODE_PROVENANCE.txt']),
  ];
  return {
    id: 'encode-rnaseq-bulk',
    name: 'ENCODE ENCPL002LPE · Long RNA-seq (PE stranded, official WDL)',
    description: 'Faithfully mirrors ENCODE Portal ENCPL002LPE paired-end, stranded long RNA-seq. Runs the official ENCODE-DCC rna-seq-pipeline WDL, including technical replicate merging, STAR, Kallisto, RSEM, unique/all plus/minus signals, reads-by-gene-type, detected genes and two-replicate MAD QC.',
    keywords: ['encode', 'ENCPL002LPE', 'rnaseq', 'rna-seq', 'long RNA', 'paired-end', 'stranded', 'star', 'rsem', 'kallisto', 'MAD QC'],
    params: [
      { name: 'SAMPLE_SHEET', label: 'Sample sheet TSV (replicate, read1, read2)', type: 'path', help: 'Multiple rows of the same replicate are technical replicate lanes; this pipeline is strictly paired-end.' },
      { name: 'STAR_INDEX', label: 'ENCODE STAR index (tgz/path)', type: 'path' },
      { name: 'RSEM_INDEX', label: 'ENCODE RSEM index (tgz/path)', type: 'path' },
      { name: 'KALLISTO_INDEX', label: 'ENCODE Kallisto index', type: 'path' },
      { name: 'CHROM_SIZES', label: 'Chromosome sizes file', type: 'path' },
      { name: 'GENE_TYPE_MAP', label: 'transcript_id → gene_type TSV', type: 'path', help: 'Required input of the official RNA QC reads-by-gene-type.' },
      { name: 'STRAND_DIRECTION', label: 'Strand direction', defaultValue: 'reverse', type: 'select', options: ['reverse', 'forward'] },
      { name: 'BAM_ROOT', label: 'Output file prefix', defaultValue: 'ENCODE_PE_stranded', type: 'text', pattern: '[A-Za-z0-9._-]+' },
      { name: 'THREADS', label: 'CPU cores per official task', defaultValue: '8', type: 'number', min: 1 },
      { name: 'ALIGN_RAM_GB', label: 'STAR memory (GB)', defaultValue: '60', type: 'number', min: 1 },
      { name: 'RSEM_RAM_GB', label: 'RSEM memory (GB)', defaultValue: '60', type: 'number', min: 1 },
      { name: 'KALLISTO_RAM_GB', label: 'Kallisto memory (GB)', defaultValue: '30', type: 'number', min: 1 },
      { name: 'SIGNALS_RAM_GB', label: 'Signal track memory (GB)', defaultValue: '30', type: 'number', min: 1 },
      { name: 'TASK_DISK', label: 'Cromwell task disk spec', defaultValue: 'local-disk 200 HDD', type: 'text' },
      { name: 'CAPER_CONFIG', label: 'Caper LSF config', defaultValue: '~/.caper/default.conf', type: 'path' },
      { name: 'EXECUTION_ENV', label: 'Official task runtime', defaultValue: 'singularity', type: 'select', options: ['singularity', 'conda'] },
      { name: 'QUEUE', label: 'LSF queue', defaultValue: 'normal', type: 'text' },
    ],
    steps,
    assets: [{ source: 'encode/build_rna_input.py', remotePath: 'tools/build_rna_input.py', label: 'ENCPL002LPE official input JSON generator' }],
    manifest: {
      software: [
        { name: 'Git', checkCmd: 'command -v git', required: true },
        { name: 'Python 3', checkCmd: 'command -v python3', required: true },
        { name: 'Java 11+', checkCmd: 'java -version 2>&1 | grep -Eq "version \\"(1[1-9]|[2-9][0-9])"', required: true },
        { name: 'Caper', checkCmd: 'command -v caper', versionCmd: 'caper --version', required: true },
        { name: 'Singularity (or conda)', checkCmd: 'command -v singularity || command -v conda', required: true },
        { name: 'Croo', checkCmd: 'command -v croo', required: true },
      ],
      references: [
        { name: 'STAR index', path: '{{STAR_INDEX}}', type: 'index', source: 'ENCODE reference files', required: true },
        { name: 'RSEM index', path: '{{RSEM_INDEX}}', type: 'index', source: 'ENCODE reference files', required: true },
        { name: 'Kallisto index', path: '{{KALLISTO_INDEX}}', type: 'index', source: 'ENCODE reference files', required: true },
        { name: 'Chromosome sizes', path: '{{CHROM_SIZES}}', type: 'other', source: 'ENCODE reference files', required: true },
        { name: 'Transcript/gene-type mapping', path: '{{GENE_TYPE_MAP}}', type: 'annotation', source: 'ENCODE-DCC rna-seq-pipeline', required: true },
      ],
      inputHint: 'TSV header: replicate<TAB>read1<TAB>read2; multiple rows of the same replicate are merged as technical replicates.',
      qcGates: [
        { afterStep: 8, metric: 'STAR mapping / reads-by-gene-type', pass: 'Judged by official qc.json/output definitions; no locally fabricated rRNA intervals as substitutes' },
        { afterStep: 9, metric: 'MAD QC', pass: 'The official MAD task produces results only with exactly two biological replicates', warn: 'Non-two-replicate cases are explicitly marked SKIP; no fabricated correlation thresholds' },
      ],
    },
    provenance: {
      provider: 'encode-dcc', sourceName: 'ENCODE-DCC rna-seq-pipeline', sourceUrl: 'https://github.com/ENCODE-DCC/rna-seq-pipeline',
      sourceRef: RNA_REF, upstreamWorkflow: 'rna-seq-pipeline.wdl · portal ENCPL002LPE', implementation: 'official-wrapper', importerVersion: 'encode-wrapper-v1',
    },
    source: 'builtin', createdAt: now, updatedAt: now,
  };
}

interface OfficialStageSpec {
  id: string;
  title: string;
  dependsOn: string[];
  phase: string;
  findArgs: string;
  evidence: string;
  optional?: boolean;
}

interface OfficialWdlSpec {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  repo: string;
  ref: string;
  refLabel: string;
  checkoutDir: string;
  wdl: string;
  launch: { id: string; title: string; phase: string; evidence: string };
  stages: OfficialStageSpec[];
  inputAssertion?: string;
  portal?: string;
  croo?: boolean;
}

function officialJsonPreflight(job: string): string {
  return command(
    `#BSUB -J ${job}_env -n 1 -q {{QUEUE}}`,
    'set -euo pipefail',
    'command -v git >/dev/null',
    'command -v python3 >/dev/null',
    'command -v java >/dev/null',
    'command -v caper >/dev/null',
    'case "{{EXECUTION_ENV}}" in singularity) command -v singularity >/dev/null ;; conda) command -v conda >/dev/null ;; *) echo "EXECUTION_ENV must be singularity or conda" >&2; exit 2 ;; esac',
    'test -s "{{INPUT_JSON}}"',
    'python3 -m json.tool "{{INPUT_JSON}}" >/dev/null',
    'CAPER_CONF="{{CAPER_CONFIG}}"',
    'if [ "$CAPER_CONF" = "~/.caper/default.conf" ]; then CAPER_CONF="$HOME/.caper/default.conf"; fi',
    'test -s "$CAPER_CONF"',
    'grep -Eq "^[[:space:]]*backend[[:space:]]*=[[:space:]]*lsf" "$CAPER_CONF" || { echo "Caper config is not an LSF backend" >&2; exit 2; }',
    'caper --version',
  );
}

function buildOfficialWdlWorkflow(spec: OfficialWdlSpec, now: number): Workflow {
  const sourcePath = `<RUN>/code/${spec.checkoutDir}`;
  const steps: WorkflowStep[] = [
    repositoryStep('preflight', 'Preflight: official runtime and input JSON', [], 'Prepare', officialJsonPreflight(spec.id.replace(/^encode-/, '')), 'Only a complete input JSON following the upstream official schema is accepted; TRACE no longer guesses missing parameters.', []),
    repositoryStep('source', `Fetch and pin ${spec.refLabel}`, ['preflight'], 'Prepare', command(
      'mkdir -p <RUN>/code',
      `if [ ! -d ${sourcePath}/.git ]; then git clone --filter=blob:none --no-checkout ${spec.repo} ${sourcePath}; fi`,
      `git -C ${sourcePath} fetch --depth 1 origin ${spec.ref}`,
      `git -C ${sourcePath} checkout --detach ${spec.ref}`,
      `test "$(git -C ${sourcePath} rev-parse HEAD)" = "${spec.ref}"`,
      `test -s ${sourcePath}/${spec.wdl}`,
    ), 'Repository and commit SHA pinned; run snapshots are reproducible.', [`${sourcePath}/${spec.wdl}`]),
    repositoryStep('input-json', 'Validate official input JSON contract', ['preflight'], 'Prepare', command(
      'mkdir -p <RUN>/config',
      'cp "{{INPUT_JSON}}" <RUN>/config/official-input.json',
      'python3 -m json.tool <RUN>/config/official-input.json >/dev/null',
      ...(spec.inputAssertion ? [spec.inputAssertion] : []),
    ), 'Keeps a copy of the original official input JSON; a wrong assay/pipeline_type is blocked before submission.', ['<RUN>/config/official-input.json']),
    repositoryStep(spec.launch.id, spec.launch.title, ['source', 'input-json'], spec.launch.phase, command(
      `#BSUB -J trace_${spec.id.replace(/[^A-Za-z0-9]+/g, '_')} -n 1 -q {{QUEUE}}`,
      'mkdir -p <RUN>/results/caper',
      'CAPER_CONF="{{CAPER_CONFIG}}"',
      'if [ "$CAPER_CONF" = "~/.caper/default.conf" ]; then CAPER_CONF="$HOME/.caper/default.conf"; fi',
      'case "{{EXECUTION_ENV}}" in singularity) ENV_FLAG=--singularity ;; conda) ENV_FLAG=--conda ;; *) exit 2 ;; esac',
      'cd <RUN>/results/caper',
      `caper -c "$CAPER_CONF" run ${sourcePath}/${spec.wdl} -i <RUN>/config/official-input.json "$ENV_FLAG" --lsf-queue "{{QUEUE}}" --local-out-dir <RUN>/results/caper --metadata-output <RUN>/results/caper/metadata.json | tee <RUN>/results/caper/run.log`,
    ), `${spec.launch.evidence} TRACE submits this script as the LSF leader job; caper run blocks until the WDL terminal state before output verification is allowed.`, ['<RUN>/results/caper/run.log', '<RUN>/results/caper/metadata.json']),
    ...spec.stages.map(stage => repositoryStep(
      stage.id,
      stage.title,
      stage.dependsOn,
      stage.phase,
      findManifest(stage.id, stage.findArgs, !stage.optional),
      stage.evidence,
      [`<RUN>/results/manifests/${stage.id}.txt`],
      Boolean(stage.optional),
    )),
  ];
  const dependedUpon = new Set(steps.flatMap(step => step.dependsOn || []));
  const terminalIds = steps.filter(step => step.id && !dependedUpon.has(step.id)).map(step => step.id!);
  steps.push(repositoryStep('report', 'Summarize official metadata, outputs and source version', terminalIds, 'Report', command(
    'mkdir -p <RUN>/results/final',
    'META=$(find <RUN>/results/caper -type f -name metadata.json -print 2>/dev/null | sort | tail -1)',
    'test -n "$META" && test -s "$META"',
    'cp "$META" <RUN>/results/final/metadata.json',
    ...(spec.croo ? ['command -v croo >/dev/null', 'cd <RUN>/results/final && croo metadata.json'] : []),
    `printf '%s\n' 'source=${spec.repo}' 'ref=${spec.ref}' 'workflow=${spec.wdl}' '${spec.portal ? `portal=${spec.portal}` : ''}' > <RUN>/results/ENCODE_PROVENANCE.txt`,
  ), 'The final report is organized directly from Caper metadata and upstream outputs, without model-guessed file meanings.', ['<RUN>/results/final/metadata.json', '<RUN>/results/ENCODE_PROVENANCE.txt']));

  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    keywords: spec.keywords,
    params: [
      { name: 'INPUT_JSON', label: 'Official pipeline input JSON', type: 'path', help: `Must follow the input schema of ${spec.wdl} in ${spec.repo}; use absolute paths.` },
      { name: 'CAPER_CONFIG', label: 'Caper LSF config', defaultValue: '~/.caper/default.conf', type: 'path' },
      { name: 'EXECUTION_ENV', label: 'Official task runtime', defaultValue: 'singularity', type: 'select', options: ['singularity', 'conda'] },
      { name: 'QUEUE', label: 'LSF queue', defaultValue: 'normal', type: 'text' },
    ],
    steps,
    manifest: {
      software: [
        { name: 'Git', checkCmd: 'command -v git', required: true },
        { name: 'Python 3', checkCmd: 'command -v python3', required: true },
        { name: 'Java 11+', checkCmd: 'java -version 2>&1 | grep -Eq "version \\"(1[1-9]|[2-9][0-9])"', required: true },
        { name: 'Caper', checkCmd: 'command -v caper', versionCmd: 'caper --version', required: true },
        { name: 'Singularity (or conda)', checkCmd: 'command -v singularity || command -v conda', required: true },
        ...(spec.croo ? [{ name: 'Croo', checkCmd: 'command -v croo', required: true as const }] : []),
      ],
      references: [{ name: 'Official input JSON', path: '{{INPUT_JSON}}', type: 'other', source: `${spec.repo}/blob/${spec.ref}/${spec.wdl}`, required: true }],
      inputHint: `Prepare a complete input JSON per the ${spec.repo} docs first; the pipeline saves it into the run snapshot together with the pinned source version.`,
      qcGates: [{ afterStep: steps.length, metric: 'Official pipeline completeness', pass: 'Caper metadata is Succeeded and all required output manifests are non-empty' }],
    },
    provenance: {
      provider: 'encode-dcc', sourceName: spec.name, sourceUrl: spec.repo.replace(/\.git$/, ''), sourceRef: `${spec.refLabel} (${spec.ref})`,
      upstreamWorkflow: `${spec.wdl}${spec.portal ? ` · ${spec.portal}` : ''}`, implementation: 'official-wrapper', importerVersion: 'encode-wrapper-v1',
    },
    source: 'builtin', createdAt: now, updatedAt: now,
  };
}

function otherOfficialWdlWorkflows(now: number): Workflow[] {
  const specs: OfficialWdlSpec[] = [
    {
      id: 'encode-chipseq-histone', name: 'ENCODE-DCC Histone ChIP-seq v2.2.2 (official WDL)',
      description: 'Runs the histone branch of chip-seq-pipeline2 v2.2.2 directly: official alignment/filtering, MACS2, pseudoreplicates, overlap reproducibility, signal tracks and QC. The official WDL disables TF-specific IDR for histone marks; no simplified TF scripts are reused.',
      keywords: ['encode', 'histone', 'chip-seq', 'macs2', 'narrowPeak', 'overlap'], repo: CHIP_REPO, ref: CHIP_REF, refLabel: 'chip-seq-pipeline2 v2.2.2', checkoutDir: 'chip-seq-pipeline2-histone', wdl: 'chip.wdl',
      inputAssertion: 'python3 -c \'import json; p=json.load(open("<RUN>/config/official-input.json")); assert p.get("chip.pipeline_type")=="histone", "chip.pipeline_type must be histone"\'',
      launch: { id: 'align-filter', title: 'Run official WDL: alignment, filtering and dedup', phase: 'Alignment', evidence: 'Histone shares the official WDL with TF, but pipeline_type and the default peak caller differ.' },
      stages: [
        { id: 'xcor', title: 'xcor and library complexity QC', dependsOn: ['align-filter'], phase: 'QC', findArgs: "\\( -path '*call-xcor*' -o -name '*.cc.qc' \\)", evidence: 'Cross-correlation and complexity metrics from the official WDL.' },
        { id: 'signals', title: 'p-value / fold-change signal tracks', dependsOn: ['align-filter'], phase: 'Signal', findArgs: "\\( -name '*.bigwig' -o -name '*.bigWig' -o -name '*.bw' \\)", evidence: 'Per-replicate and pooled signals.' },
        { id: 'true-peaks', title: 'MACS2 narrowPeak on true replicates', dependsOn: ['xcor'], phase: 'Peak Calling', findArgs: "\\( -path '*call-call_peak*' -o -name '*.narrowPeak.gz' \\)", evidence: 'The v2.2.2 WDL histone branch defaults to peak_caller=macs2, peak_type=narrowPeak.' },
        { id: 'pseudoreps', title: 'Self- and pooled-pseudoreplicate peaks', dependsOn: ['align-filter', 'xcor'], phase: 'Pseudoreplicates', findArgs: "\\( -path '*call-spr*' -o -path '*call-call_peak_pr*' -o -path '*call-call_peak_ppr*' \\)", evidence: 'Official spr and pooled PR1/PR2 branches.' },
        { id: 'reproducibility', title: 'overlap reproducibility and optimal/conservative peaks', dependsOn: ['true-peaks', 'pseudoreps'], phase: 'QC', findArgs: "\\( -path '*call-overlap*' -o -path '*call-reproducibility_overlap*' -o -name '*optimal_peak*' -o -name '*conservative_peak*' \\)", evidence: 'The histone branch sets enable_idr=false; the official WDL computes reproducibility via overlap and selects the final peak sets.' },
      ], croo: true,
    },
    {
      id: 'encode-atacseq', name: 'ENCODE-DCC ATAC-seq v2.2.3 (official WDL)',
      description: 'Runs ENCODE-DCC atac-seq-pipeline v2.2.3 directly, covering technical replicate merging, alignment filtering, Tn5/fragment QC, true/pseudoreplicate peaks, IDR/overlap, signal tracks and the final report.',
      keywords: ['encode', 'atac-seq', 'atac', 'tss enrichment', 'idr', 'pseudoreplicate'], repo: 'https://github.com/ENCODE-DCC/atac-seq-pipeline.git', ref: '47ba8dff9c332e24b48e767303e9fcac98589cf2', refLabel: 'atac-seq-pipeline v2.2.3', checkoutDir: 'atac-seq-pipeline', wdl: 'atac.wdl',
      inputAssertion: 'python3 -c \'import json; p=json.load(open("<RUN>/config/official-input.json")); assert p.get("atac.pipeline_type","atac")=="atac", "atac.pipeline_type must be atac"\'',
      launch: { id: 'align-filter', title: 'Run official WDL: trim, align, filter', phase: 'Alignment', evidence: 'The official WDL runs end-to-end; Tn5 and mitochondrial/blacklist handling are controlled by the upstream version.' },
      stages: [
        { id: 'fragment-qc', title: 'Fragment distribution, TSS enrichment and xcor', dependsOn: ['align-filter'], phase: 'QC', findArgs: "\\( -path '*call-xcor*' -o -iname '*tss*enrich*' -o -iname '*insert*size*' \\)", evidence: 'ATAC-specific QC computed by official tasks.' },
        { id: 'signals', title: 'Replicate and pooled signal tracks', dependsOn: ['align-filter'], phase: 'Signal', findArgs: "\\( -name '*.bigwig' -o -name '*.bigWig' -o -name '*.bw' \\)", evidence: 'Official p-value/fold-change/count signals.' },
        { id: 'true-peaks', title: 'True replicate and pooled peaks', dependsOn: ['fragment-qc'], phase: 'Peak Calling', findArgs: "\\( -path '*call-call_peak*' -o -name '*.narrowPeak.gz' \\)", evidence: 'Candidate peaks feed the IDR/overlap branches.' },
        { id: 'pseudoreps', title: 'Self- and pooled-pseudoreplicate peaks', dependsOn: ['align-filter', 'fragment-qc'], phase: 'Pseudoreplicates', findArgs: "\\( -path '*call-spr*' -o -path '*call-call_peak_pr*' -o -path '*call-call_peak_ppr*' \\)", evidence: 'Official pseudo-replication branches.' },
        { id: 'reproducibility', title: 'IDR/overlap and final peak sets', dependsOn: ['true-peaks', 'pseudoreps'], phase: 'QC', findArgs: "\\( -path '*call-idr*' -o -path '*call-overlap*' -o -path '*call-reproducibility*' -o -name '*optimal_peak*' \\)", evidence: 'Official reproducibility assessment and final peak sets.' },
      ], croo: true,
    },
    {
      id: 'encode-dnaseseq', name: 'ENCODE-DCC DNase-seq v3.0.0-beta (official WDL)',
      description: 'Runs ENCODE-DCC dnase-seq-pipeline directly: FASTQ merge/trim/BWA, BAM merge/mark/filter, Hotspot1/2, SPOT, footprints, QC, normalization and format conversion.',
      keywords: ['encode', 'dnase-seq', 'hotspot2', 'footprint', 'SPOT'], repo: 'https://github.com/ENCODE-DCC/dnase-seq-pipeline.git', ref: 'ea8ce64a036ea34865277959788d870c494e17a0', refLabel: 'dnase-seq-pipeline v3.0.0-beta', checkoutDir: 'dnase-seq-pipeline', wdl: 'dnase.wdl',
      launch: { id: 'align', title: 'Run official WDL: concat, trim and BWA align', phase: 'Alignment', evidence: 'The official pipeline allows SE/PE lanes, merged per replicate.' },
      stages: [
        { id: 'merge-filter', title: 'Merge, mark duplicates and nuclear filter', dependsOn: ['align'], phase: 'Filtering', findArgs: "\\( -path '*call-merge*' -o -path '*call-mark*' -o -path '*call-filter*' -o -name '*nuclear*.bam' \\)", evidence: 'Keeps the official nuclear BAM and duplication/preseq metrics.' },
        { id: 'hotspots', title: 'Hotspot1/2, peaks and SPOT', dependsOn: ['merge-filter'], phase: 'Peak Calling', findArgs: "\\( -path '*call-hotspot*' -o -iname '*hotspot*' -o -iname '*narrowpeak*' -o -iname '*spot*' \\)", evidence: 'The 5%/0.1% peak sets and SPOT are produced by official tasks.' },
        { id: 'footprints', title: 'Footprint model and 1% footprints', dependsOn: ['hotspots'], phase: 'Footprints', findArgs: "\\( -path '*call-footprint*' -o -iname '*footprint*' \\)", evidence: 'Official footprint model and thresholded results.' },
        { id: 'normalize-convert', title: 'Density normalization and bigWig/bigBed conversion', dependsOn: ['hotspots'], phase: 'Signal', findArgs: "\\( -path '*call-normalize*' -o -path '*call-convert*' -o -name '*.bw' -o -name '*.bb' \\)", evidence: 'Official normalized density and browser formats.' },
        { id: 'qc', title: 'Summarize flagstats, duplication, preseq and peak QC', dependsOn: ['merge-filter', 'hotspots', 'footprints'], phase: 'QC', findArgs: "\\( -path '*call-qc*' -o -iname '*flagstat*' -o -iname '*preseq*' -o -iname '*metrics*' \\)", evidence: 'Verified against the official DNase output contract.' },
      ],
    },
    {
      id: 'encode-wgbs', name: 'ENCODE-DCC WGBS/RRBS v1.1.8 (official WDL)',
      description: 'Runs ENCODE-DCC wgbs-pipeline Git tag 1.1.8 (gemBS) directly: reference index, per-biological-replicate map/bscaller, mean coverage, CpG/CHG/CHH extraction, bedMethyl/bigBed, coverage bigWig and QC; pipeline_type selects WGBS or RRBS.',
      keywords: ['encode', 'wgbs', 'rrbs', 'gembs', 'methylation', 'bedMethyl'], repo: 'https://github.com/ENCODE-DCC/wgbs-pipeline.git', ref: '48afda6300b06a9f1b7c2156482f8caa6f49ee51', refLabel: 'wgbs-pipeline 1.1.8', checkoutDir: 'wgbs-pipeline', wdl: 'wgbs-pipeline.wdl',
      launch: { id: 'prepare-map', title: 'Run official WDL: metadata/config, gemBS index, prepare and map', phase: 'Alignment', evidence: 'Scattered per biological replicate; technical FASTQs within one replicate are handled by official metadata/prepare, either building the index or reusing a prebuilt gemBS index.' },
      stages: [
        { id: 'bscaller', title: 'gemBS methylation calling (BCF)', dependsOn: ['prepare-map'], phase: 'Methylation', findArgs: "\\( -path '*call-bscaller*' -o -name '*.bcf' -o -name '*.bcf.csi' \\)", evidence: 'Each biological replicate runs the official gemBS bscaller on its map BAM.' },
        { id: 'coverage', title: 'Per-replicate mean coverage QC', dependsOn: ['prepare-map'], phase: 'QC', findArgs: "\\( -path '*call-calculate_average_coverage*' -o -name 'average_coverage_qc.json' \\)", evidence: 'The official WDL computes mean coverage per map BAM independently; no fabricated replicate merge.' },
        { id: 'extract', title: 'CpG/CHG/CHH methylation extraction, bedMethyl/bigBed', dependsOn: ['bscaller'], phase: 'Methylation', findArgs: "\\( -path '*call-extract*' -o -iname '*_cpg.bed.gz' -o -iname '*_chg.bed.gz' -o -iname '*_chh.bed.gz' -o -name '*.bb' \\)", evidence: 'Official gemBS extract outputs CpG/CHG/CHH bedMethyl, bigBed and strand bigWig.' },
        { id: 'signals', title: 'CpG coverage bigWig', dependsOn: ['extract'], phase: 'Signal', findArgs: "\\( -path '*call-make_coverage_bigwig*' -o -name 'coverage.bw' -o -name '*_pos.bw' -o -name '*_neg.bw' \\)", evidence: 'Browser signals come from extract and make_coverage_bigwig.' },
        { id: 'qc', title: 'Mapping QC and two-replicate Pearson (exactly two replicates)', dependsOn: ['coverage', 'extract'], phase: 'QC', findArgs: "\\( -path '*call-qc_report*' -o -name 'gembs_map_qc.json' -o -path '*call-calculate_bed_pearson_correlation*' -o -name 'bed_pearson_correlation_qc.json' \\)", evidence: 'Per-replicate mapping QC; the official WDL computes Pearson correlation only with exactly two bedMethyl files.' },
      ], croo: true,
    },
    {
      id: 'encode-hic', name: 'ENCODE-DCC Hi-C v1.15.1 (official WDL)',
      description: 'Runs the ENCODE Hi-C uniform processing pipeline v1.15.1 (Juicer-based) directly: alignment, chimeric/ligation handling, merge/dedup, contact matrix, normalization, feature calls and QC.',
      keywords: ['encode', 'hi-c', 'hic', 'juicer', 'contact matrix', 'hiccups'], repo: 'https://github.com/ENCODE-DCC/hic-pipeline.git', ref: 'a66963c676ebce7971b68241457cbb003d3f255f', refLabel: 'hic-pipeline v1.15.1', checkoutDir: 'hic-pipeline', wdl: 'hic.wdl',
      launch: { id: 'align', title: 'Run official WDL: read pairing and alignment', phase: 'Alignment', evidence: 'Official Juicer-based mapping branch.' },
      stages: [
        { id: 'merge-dedup', title: 'Chimeric handling, merge and dedup', dependsOn: ['align'], phase: 'Filtering', findArgs: "\\( -path '*call-merge*' -o -path '*call-dedup*' -o -iname '*merged*' \\)", evidence: 'Pairing, chimeric reads and duplicate filtering all follow official tasks.' },
        { id: 'matrix', title: 'Multi-resolution contact matrix / .hic', dependsOn: ['merge-dedup'], phase: 'Matrix', findArgs: "\\( -name '*.hic' -o -path '*call-create_hic*' \\)", evidence: 'Official multi-resolution contact matrix.' },
        { id: 'normalization', title: 'Matrix normalization and eigenvector', dependsOn: ['matrix'], phase: 'Matrix', findArgs: "\\( -path '*call-add_norm*' -o -path '*call-create_eigenvector*' -o -iname '*eigenvector*' \\)", evidence: 'Juicer normalization and compartment eigenvectors.' },
        { id: 'features', title: 'Feature calls: loops/domains etc.', dependsOn: ['normalization'], phase: 'Features', findArgs: "\\( -path '*call-hiccups*' -o -path '*call-arrowhead*' -o -iname '*loop*' -o -iname '*domain*' \\)", evidence: 'Whether GPU/feature tasks run is controlled by the official input JSON.', optional: true },
        { id: 'qc', title: 'Mapping, ligation and contact QC', dependsOn: ['merge-dedup', 'matrix'], phase: 'QC', findArgs: "\\( -iname '*qc*' -o -iname '*stats*' -o -iname '*metrics*' \\)", evidence: 'Official mapping/ligation/contact quality metrics.' },
      ], croo: true,
    },
    {
      id: 'encode-mirnaseq', name: 'ENCODE-DCC microRNA-seq v1.2.2 (official WDL)',
      description: 'Runs ENCODE-DCC mirna-seq-pipeline v1.2.2 directly: adapter trimming, STAR alignment, miRNA counts, unique/all-mapped plus/minus strand signals and QC; corresponds to Portal ENCPL280YDY.',
      keywords: ['encode', 'mirna-seq', 'microRNA', 'ENCPL280YDY', 'STAR', 'counts'], repo: 'https://github.com/ENCODE-DCC/mirna-seq-pipeline.git', ref: 'b6bd6698975872ced77fc6b73137bc09b5c89e84', refLabel: 'mirna-seq-pipeline 1.2.2', checkoutDir: 'mirna-seq-pipeline', wdl: 'mirna_seq_pipeline.wdl', portal: 'ENCPL280YDY',
      launch: { id: 'trim-align', title: 'Run official WDL: adapter trim and STAR align', phase: 'Alignment', evidence: 'The official pipeline restricts to single-end, insert≤30 bp; validated by the input JSON/upstream tasks.' },
      stages: [
        { id: 'quantification', title: 'miRNA ReadsPerGene counts', dependsOn: ['trim-align'], phase: 'Quantification', findArgs: "\\( -path '*call-star*/*.tsv' -o -name 'rep*.tsv' \\)", evidence: 'STAR --quantMode TranscriptomeSAM GeneCounts outputs ReadsPerGene TSV with the miRNA annotation.' },
        { id: 'signals', title: 'unique/all × plus/minus signals', dependsOn: ['trim-align'], phase: 'Signal', findArgs: "\\( -name '*.bw' -o -name '*.bigWig' -o -name '*.bigwig' \\)", evidence: 'Plus/minus strands, unique and unique+multi-mapped tracks.' },
        { id: 'qc', title: 'STAR mapping and quantification QC', dependsOn: ['quantification', 'signals'], phase: 'QC', findArgs: "\\( -name '*_star_qc.json' -o -name '*Log.final.out' -o -iname '*qc*' \\)", evidence: 'Official make_star_qc.py summarizes STAR logs and ReadsPerGene quantification.' },
        { id: 'correlation', title: 'Two-replicate Spearman correlation', dependsOn: ['quantification'], phase: 'QC', findArgs: "\\( -path '*call-spearman_correlation*' -o -name '*_spearman.json' \\)", evidence: 'The official WDL computes Spearman correlation only with exactly two biological replicates.', optional: true },
      ], croo: true,
    },
    {
      id: 'encode-longread-rnaseq', name: 'ENCODE-DCC Long-read RNA-seq v2.1.0 (official WDL)',
      description: 'Runs ENCODE-DCC long-read-rna-pipeline v2.1.0 directly, supporting PacBio/ONT: long-read alignment, mismatch/micro-indel/non-canonical splice correction, transcript quantification and QC.',
      keywords: ['encode', 'long-read RNA-seq', 'PacBio', 'Oxford Nanopore', 'transcript'], repo: 'https://github.com/ENCODE-DCC/long-read-rna-pipeline.git', ref: 'd89647ef40618fd6a17cc807a9b853c3da58de98', refLabel: 'long-read-rna-pipeline v2.1.0', checkoutDir: 'long-read-rna-pipeline', wdl: 'long-read-rna-pipeline.wdl',
      launch: { id: 'reference-prep', title: 'Run official WDL: reference/spike-in/annotation preparation', phase: 'Prepare', evidence: 'The official WDL first merges optional spike-ins, reference/annotation and generates splice-junction inputs.' },
      stages: [
        { id: 'minimap2', title: 'PacBio/ONT minimap2 alignment', dependsOn: ['reference-prep'], phase: 'Alignment', findArgs: "\\( -path '*call-minimap2*' -o -name '*_minimap2.log' -o -name '*_mapping_qc.json' -o -name '*.bam' \\)", evidence: 'input_type=pacbio/nanopore selects the official minimap2 parameter branch.' },
        { id: 'transcriptclean', title: 'TranscriptClean mismatch/indel/splice-junction correction', dependsOn: ['minimap2'], phase: 'Correction', findArgs: "\\( -path '*call-transcriptclean*' -o -name '*_clean.bam' -o -name '*_clean.fa' -o -name '*_report.pdf' \\)", evidence: 'Official TranscriptClean corrects long reads with annotation splice junctions.' },
        { id: 'talon', title: 'TALON label and transcript discovery', dependsOn: ['transcriptclean'], phase: 'Annotation', findArgs: "\\( -path '*call-talon*' -o -name '*_talon.db' -o -name '*_QC.log' \\)", evidence: 'Each replicate labels reads first, then enters the shared TALON database.' },
        { id: 'abundance', title: 'TALON abundance, GTF and detected genes', dependsOn: ['talon'], phase: 'Quantification', findArgs: "\\( -path '*call-create_abundance*' -o -path '*call-create_gtf*' -o -name '*_talon_abundance.tsv' -o -name '*_talon.gtf.gz' -o -name '*_number_of_genes_detected.json' \\)", evidence: 'The official database exports abundance, annotated GTF and detected genes.' },
        { id: 'correlation', title: 'Two-replicate Spearman correlation', dependsOn: ['abundance'], phase: 'QC', findArgs: "\\( -path '*call-calculate_spearman*' -o -name '*_spearman.json' \\)", evidence: 'The official WDL runs only when fastqs contain exactly two biological replicates.', optional: true },
      ], croo: true,
    },
  ];
  return specs.map(spec => buildOfficialWdlWorkflow(spec, now));
}

function partnerPreflight(commands: string[]): string {
  return command('#BSUB -J encode_partner_env -n 1 -q {{QUEUE}}', 'set -euo pipefail', 'command -v git >/dev/null', ...commands);
}

function chipPetPartnerWorkflow(now: number): Workflow {
  const repo = 'https://github.com/TheJacksonLaboratory/ChIA-PIPE.git';
  const ref = 'da1e47b42411ea98285e5ccf630848a115b735a6';
  const steps: WorkflowStep[] = [
    repositoryStep('preflight', 'Preflight: ChIA-PIPE config and runtime', [], 'Prepare', partnerPreflight([
      'command -v bash >/dev/null',
      'test -s "{{CONFIG_FILE}}"',
    ]), 'The ChIA-PIPE config is executable shell config; a copy is kept before the run and the upstream source is pinned.', []),
    repositoryStep('source', 'Fetch and pin ChIA-PIPE v1.0 source', ['preflight'], 'Prepare', command(
      'mkdir -p <RUN>/code',
      `if [ ! -d <RUN>/code/ChIA-PIPE/.git ]; then git clone --filter=blob:none --no-checkout ${repo} <RUN>/code/ChIA-PIPE; fi`,
      `git -C <RUN>/code/ChIA-PIPE fetch --depth 1 origin ${ref}`,
      `git -C <RUN>/code/ChIA-PIPE checkout --detach ${ref}`,
      `test "$(git -C <RUN>/code/ChIA-PIPE rev-parse HEAD)" = "${ref}"`,
    ), 'Uses the Jackson Laboratory ChIA-PIPE referenced by the ENCODE ChIA-PET protocol.', ['<RUN>/code/ChIA-PIPE/0.chia_pipe_shell.sh']),
    repositoryStep('config', 'Freeze ChIA-PIPE config', ['preflight'], 'Prepare', command(
      'mkdir -p <RUN>/config',
      'cp "{{CONFIG_FILE}}" <RUN>/config/chia-pipe.conf',
      'bash -n <RUN>/config/chia-pipe.conf',
    ), 'The config must specify FASTQ, BWA reference, chrom sizes, IP factor and run type.', ['<RUN>/config/chia-pipe.conf']),
    repositoryStep('linker-filter', 'Run ChIA-PIPE: linker filtering', ['source', 'config'], 'Linker', command(
      '#BSUB -J chia_pipe -n {{THREADS}} -q {{QUEUE}}',
      'mkdir -p <RUN>/results/chia-pipe',
      'cd <RUN>/results/chia-pipe',
      'bash <RUN>/code/ChIA-PIPE/0.chia_pipe_shell.sh -c <RUN>/config/chia-pipe.conf | tee chia-pipe.log',
    ), 'Runs the upstream 0.chia_pipe_shell.sh; later nodes verify outputs of the same official partner pipeline run.', ['<RUN>/results/chia-pipe/chia-pipe.log']),
    repositoryStep('mapping', 'Paired-end tag mapping and classification', ['linker-filter'], 'Alignment', findManifest('chia-mapping', "\\( -name '*.bam' -o -iname '*mapping*stat*' -o -iname '*bedpe*' \\)", true, '<RUN>/results/chia-pipe'), 'ChIA-PIPE mapping/PET classification.', ['<RUN>/results/manifests/chia-mapping.txt']),
    repositoryStep('peaks', 'ChIP enrichment peaks', ['mapping'], 'Peak Calling', findManifest('chia-peaks', "\\( -iname '*peak*' -o -iname '*spp*' \\)", true, '<RUN>/results/chia-pipe'), 'The peak caller is controlled by the spp/macs2 choice in the official config.', ['<RUN>/results/manifests/chia-peaks.txt']),
    repositoryStep('loops', 'chromatin interaction loops', ['mapping', 'peaks'], 'Interactions', findManifest('chia-loops', "\\( -iname '*loop*' -o -iname '*interaction*' -o -iname '*cluster*' \\)", true, '<RUN>/results/chia-pipe'), 'ChIA-PIPE interaction calling and loop outputs.', ['<RUN>/results/manifests/chia-loops.txt']),
    repositoryStep('phase-qc', 'Summary statistics and optional phased loops', ['loops'], 'QC', findManifest('chia-qc', "\\( -iname '*summary*' -o -iname '*qc*' -o -iname '*stat*' -o -iname '*phase*' \\)", true, '<RUN>/results/chia-pipe'), 'Uses upstream summary/QC; Hi-C quality thresholds are not applied.', ['<RUN>/results/manifests/chia-qc.txt']),
    repositoryStep('report', 'Save ChIA-PIPE results and protocol provenance', ['phase-qc'], 'Report', command(
      `printf '%s\n' 'source=${repo}' 'ref=${ref}' 'protocol=ENCODE ChIA-PET / ChIA-PIPE v1.0' > <RUN>/results/ENCODE_PROVENANCE.txt`,
      'test -s <RUN>/results/manifests/chia-loops.txt',
    ), 'This pipeline is a laboratory partner protocol adopted by ENCODE; it is not labeled as an ENCODE-DCC WDL.', ['<RUN>/results/ENCODE_PROVENANCE.txt']),
  ];
  return {
    id: 'encode-chiapet', name: 'ENCODE partner protocol · ChIA-PET (ChIA-PIPE v1.0)',
    description: 'Runs Jackson Laboratory ChIA-PIPE v1.0 as specified by the ENCODE ChIA-PET protocol. This upstream is not an ENCODE-DCC/Caper WDL; TRACE explicitly wraps it as the partner shell pipeline instead of relabeling self-written simplified commands as an official ENCODE pipeline.',
    keywords: ['encode', 'chia-pet', 'ChIA-PIPE', 'chromatin interaction', 'loops'],
    params: [
      { name: 'CONFIG_FILE', label: 'ChIA-PIPE official config file', type: 'path', help: 'Copy from the upstream example_config_file.sh and fill it in; the config uses shell syntax.' },
      { name: 'THREADS', label: 'LSF leader cores', defaultValue: '8', type: 'number', min: 1 },
      { name: 'QUEUE', label: 'LSF queue', defaultValue: 'normal', type: 'text' },
    ], steps,
    manifest: {
      software: [{ name: 'Git', checkCmd: 'command -v git', required: true }, { name: 'Bash', checkCmd: 'command -v bash', required: true }],
      references: [{ name: 'ChIA-PIPE config', path: '{{CONFIG_FILE}}', type: 'other', source: `${repo}/blob/${ref}/example_config_file.sh`, required: true }],
      inputHint: 'Start from the upstream example_config_file.sh, specifying data_dir, genome, fasta/BWA index, chrom_sizes, ip_factor and run_type.',
      qcGates: [{ afterStep: 8, metric: 'ChIA-PIPE summary/QC', pass: 'Judged by the upstream example_qc_table and protocol metrics' }],
    },
    provenance: { provider: 'encode-partner', sourceName: 'Jackson Laboratory ChIA-PIPE', sourceUrl: repo.replace(/\.git$/, ''), sourceRef: ref, upstreamWorkflow: '0.chia_pipe_shell.sh · ENCODE ChIA-PET protocol', implementation: 'reference-extension', importerVersion: 'encode-wrapper-v1' },
    source: 'builtin', createdAt: now, updatedAt: now,
  };
}

function eclipPartnerWorkflow(now: number): Workflow {
  const repo = 'https://github.com/YeoLab/eCLIP.git';
  const ref = '4022036fbef80c63d0c8b25232aea2b5de58a619';
  const mergeRepo = 'https://github.com/YeoLab/merge_peaks.git';
  const mergeRef = 'aedc0a14d4ba109ee65678a3201a52c5bb6ad473';
  const steps: WorkflowStep[] = [
    repositoryStep('preflight', 'Preflight: YeoLab eCLIP CWL environment and inputs', [], 'Prepare', partnerPreflight([
      'command -v cwltool >/dev/null',
      'command -v singularity >/dev/null',
      'test -s "{{INPUT_YAML}}"',
    ]), 'eCLIP is an ENCODE partner-lab CWL; Caper/WDL is not used.', []),
    repositoryStep('source', 'Pin eCLIP v0.7.1 and merge_peaks source', ['preflight'], 'Prepare', command(
      'mkdir -p <RUN>/code',
      `if [ ! -d <RUN>/code/eCLIP/.git ]; then git clone --filter=blob:none --no-checkout ${repo} <RUN>/code/eCLIP; fi`,
      `git -C <RUN>/code/eCLIP fetch --depth 1 origin ${ref}`,
      `git -C <RUN>/code/eCLIP checkout --detach ${ref}`,
      `if [ ! -d <RUN>/code/merge_peaks/.git ]; then git clone --filter=blob:none --no-checkout ${mergeRepo} <RUN>/code/merge_peaks; fi`,
      `git -C <RUN>/code/merge_peaks fetch --depth 1 origin ${mergeRef}`,
      `git -C <RUN>/code/merge_peaks checkout --detach ${mergeRef}`,
    ), 'The core peak pipeline and the replicate/input normalization pipeline are pinned separately.', ['<RUN>/code/eCLIP/cwl', '<RUN>/code/merge_peaks/cwl']),
    repositoryStep('input', 'Freeze CWL input manifest', ['preflight'], 'Prepare', command(
      'mkdir -p <RUN>/config',
      'cp "{{INPUT_YAML}}" <RUN>/config/eclip-input.yaml',
      'if [ "{{MERGE_INPUT_YAML}}" != "NONE" ]; then cp "{{MERGE_INPUT_YAML}}" <RUN>/config/merge-peaks-input.yaml; fi',
    ), 'Inputs must follow the YeoLab example/paired_end_clip.yaml or single_end_clip.yaml.', ['<RUN>/config/eclip-input.yaml']),
    repositoryStep('demux-trim', 'Run eCLIP CWL: demultiplex, UMI and adapter trim', ['source', 'input'], 'Preprocessing', command(
      '#BSUB -J eclip_cwl -n {{THREADS}} -q {{QUEUE}}',
      'mkdir -p <RUN>/results/eclip',
      'cwltool --singularity --outdir <RUN>/results/eclip <RUN>/code/eCLIP/{{CWL_WORKFLOW}} "{{INPUT_YAML}}" | tee <RUN>/results/eclip/cwltool.log',
    ), 'Runs the upstream CWL; choose the PE or SE workflow to avoid mixing the two protocols.', ['<RUN>/results/eclip/cwltool.log']),
    repositoryStep('mapping', 'Repeat-element and genome STAR mapping', ['demux-trim'], 'Alignment', findManifest('eclip-mapping', "\\( -name '*.bam' -o -iname '*repeat*map*' -o -iname '*star*log*' \\)", true, '<RUN>/results/eclip'), 'The CWL contains repeat-mapping and genome-mapping branches.', ['<RUN>/results/manifests/eclip-mapping.txt']),
    repositoryStep('dedup-peaks', 'UMI dedup, Clipper peaks and blacklist', ['mapping'], 'Peak Calling', findManifest('eclip-peaks', "\\( -iname '*rmdup*' -o -iname '*peak*' -o -name '*.bb' \\)", true, '<RUN>/results/eclip'), 'Clipper candidate peaks go through blacklist filtering and format conversion.', ['<RUN>/results/manifests/eclip-peaks.txt']),
    repositoryStep('normalize-idr', 'SMInput normalization, replicate merge and IDR', ['dedup-peaks', 'source', 'input'], 'Reproducibility', command(
      'mkdir -p <RUN>/results/merge-peaks',
      'if [ "{{MERGE_INPUT_YAML}}" = "NONE" ]; then echo "SKIP: no merge_peaks manifest provided; results contain only core peaks and must not be called final ENCODE normalized peaks" | tee <RUN>/results/merge-peaks/SKIPPED.txt; else cwltool --singularity --outdir <RUN>/results/merge-peaks <RUN>/code/merge_peaks/{{MERGE_WORKFLOW}} "{{MERGE_INPUT_YAML}}" | tee <RUN>/results/merge-peaks/cwltool.log; fi',
    ), 'The input-normalized/reproducible peaks of an ENCODE release come from the standalone merge_peaks/IDR pipeline; a SKIP must be explicit when no manifest is provided.', ['<RUN>/results/merge-peaks']),
    repositoryStep('report', 'Summarize eCLIP core and normalization provenance', ['normalize-idr'], 'Report', command(
      `printf '%s\n' 'core_source=${repo}' 'core_ref=${ref}' 'merge_source=${mergeRepo}' 'merge_ref=${mergeRef}' > <RUN>/results/ENCODE_PROVENANCE.txt`,
      'test -s <RUN>/results/manifests/eclip-peaks.txt',
    ), 'This pipeline follows the YeoLab implementation of the ENCODE eCLIP SOP; it is not labeled as an ENCODE-DCC WDL.', ['<RUN>/results/ENCODE_PROVENANCE.txt']),
  ];
  return {
    id: 'encode-eclip', name: 'ENCODE partner protocol · eCLIP (YeoLab CWL v0.7.1)',
    description: 'Runs YeoLab CWL v0.7.1 per the ENCODE eCLIP SOP, with the standalone merge_peaks / SMInput normalization / IDR as an explicit branch. This is not an ENCODE-DCC WDL, and the UI no longer mislabels it.',
    keywords: ['encode', 'eclip', 'YeoLab', 'CWL', 'Clipper', 'SMInput', 'IDR'],
    params: [
      { name: 'INPUT_YAML', label: 'eCLIP core CWL input YAML', type: 'path' },
      { name: 'CWL_WORKFLOW', label: 'eCLIP core workflow', defaultValue: 'cwl/wf_get_peaks_scatter_pe.cwl', type: 'select', options: ['cwl/wf_get_peaks_scatter_pe.cwl', 'cwl/wf_encode_se_full_scatter.cwl', 'cwl/wf_encode_se_full_scatter_nostats.cwl'] },
      { name: 'MERGE_INPUT_YAML', label: 'merge_peaks/IDR input YAML (NONE = explicit skip)', defaultValue: 'NONE', type: 'path', required: false },
      { name: 'MERGE_WORKFLOW', label: 'merge_peaks workflow', defaultValue: 'cwl/wf_full_IDR_pipeline_2inputs.cwl', type: 'select', options: ['cwl/wf_full_IDR_pipeline_2inputs.cwl', 'cwl/wf_full_IDR_pipeline_1input.cwl'] },
      { name: 'THREADS', label: 'LSF leader cores', defaultValue: '8', type: 'number', min: 1 },
      { name: 'QUEUE', label: 'LSF queue', defaultValue: 'normal', type: 'text' },
    ], steps,
    manifest: {
      software: [{ name: 'Git', checkCmd: 'command -v git', required: true }, { name: 'cwltool', checkCmd: 'command -v cwltool', required: true }, { name: 'Singularity', checkCmd: 'command -v singularity', required: true }],
      references: [{ name: 'eCLIP CWL input YAML', path: '{{INPUT_YAML}}', type: 'other', source: `${repo}/tree/v0.7.1/example`, required: true }],
      inputHint: 'Start from a YeoLab/eCLIP example manifest; PE/SE must use the corresponding workflow. Final ENCODE peaks also need the merge_peaks manifest.',
      qcGates: [{ afterStep: 7, metric: 'SMInput-normalized reproducible peaks', pass: 'merge_peaks/IDR completed', warn: 'only core candidate peaks when MERGE_INPUT_YAML=NONE' }],
    },
    provenance: { provider: 'encode-partner', sourceName: 'YeoLab eCLIP + merge_peaks', sourceUrl: repo.replace(/\.git$/, ''), sourceRef: `v0.7.1 (${ref})`, upstreamWorkflow: 'CWL · ENCODE eCLIP SOP', implementation: 'reference-extension', importerVersion: 'encode-wrapper-v1' },
    source: 'builtin', createdAt: now, updatedAt: now,
  };
}

/**
 * 官方 WDL 包装器（7 条）：dnase/wgbs/hic/chiapet/mirna/eclip/longread。
 * chip-tf/chip-histone/atac/rnaseq 四条不在此构建——它们恢复为 workflowStore.ts 里的
 * TRACE 原生参数式流程（逐个指定参考文件，不走 genome TSV + Caper）。
 */
export function buildOfficialEncodeWorkflows(now: number): Workflow[] {
  return [
    ...otherOfficialWdlWorkflows(now),
    chipPetPartnerWorkflow(now),
    eclipPartnerWorkflow(now),
  ];
}
