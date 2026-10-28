# ENCODE 生物信息分析与质控流程

本文整理 ENCODE 官方统一分析流程（Uniform Analysis Pipelines）中 12 个生信分析与质控流程，
每个流程给出用途、分析步骤（含关键参数）、质控指标与达标/警告阈值、产出文件。

文中每个流程同时以**内置流程**形式登记在 HPClaw 流程库（`server/workflows/workflowStore.ts` 的
`builtinWorkflows()`，分类“转录组与表观调控”），内置流程 id 见各节标题；流程步骤中的
`{{QUEUE}}`/`{{THREADS}}`/`{{INPUT_DIR}}` 等为运行参数占位，QC 步骤产出的 `qc/qc.json`
与各步骤备注中的阈值一一对应。

## 总览

| 内置流程 id | 流程 | 核心工具 | 关键质控 |
|---|---|---|---|
| `encode-chipseq-tf` | TF ChIP-seq | BWA MEM、Picard、MACS2、IDR、hotspot2（可选） | NSC/RSC、NRF/PBC、FRiP、SPOT、IDR Np/Nt、RPKM 轨迹与峰快照 |
| `encode-chipseq-histone` | 组蛋白 ChIP-seq | BWA MEM、Picard、SPP（宽峰）、IDR、hotspot2（可选） | 同上（含 SPOT、RPKM 轨迹与峰快照） |
| `encode-rnaseq-bulk` | bulk RNA-seq | STAR、RSEM | 比对率、rRNA 占比、duplication、重复间 Spearman |
| `encode-atacseq` | ATAC-seq | Bowtie2、MACS2、deepTools | TSS 富集、FRiP、SPOT、NRF、细胞器（线粒体+叶绿体）占比、片段周期性 |
| `encode-dnaseseq` | DNase-seq | Bowtie2/BWA、hotspot2/F-seq | SPOT、FRiP、库复杂度 |
| `encode-wgbs` | WGBS | Bismark | 亚硫酸盐转化率、比对效率、CpG 覆盖度 |
| `encode-hic` | Hi-C | HiC-Pro、cooler/juicer | valid pairs 率、顺式互作占比、重复率 |
| `encode-chiapet` | ChIA-PET | BWA、Mango/ChIA-PET2 | 有效连接率、PET cluster 可信度 |
| `encode-mirnaseq` | miRNA-seq | cutadapt、miRDeep2 | 15–35 nt 占比、miRNA 映射率、rRNA/tRNA 污染 |
| `encode-eclip` | eCLIP | cutadapt、STAR、umi_tools、CLIPper | PCR 重复率、input 归一化富集、重复间可重复峰 |
| `encode-longread-rnaseq` | 长读长 RNA-seq | minimap2、TALON/FLAIR | 比对率、全长转录本比例、novel isoform 比例 |

---

## HPClaw 在 ENCODE 基线上的改进（v0.4.10+，本文档与实装同步）

ENCODE 统一流程是金标准基线，但按我们的实际使用场景做了以下有据可依的改进：

1. **环境检查步骤**：每条流程第 1 步固定为可执行的环境检查脚本（钉死版本的软件逐个试加载、输入/参考数据确认），
   必需项缺失直接阻断——ENCODE 只给流程定义，不管你的集群装没装。
2. **细胞器 reads 去除扩展到叶绿体**：ENCODE 面向动物只去线粒体（chrM）；植物样本叶绿体（chrC/plastid）
   是高拷贝污染源，不去除会污染开放区域峰。ATAC-seq 与 DNase-seq 的过滤步骤通过 `ORGANELLE_REGEX`
   全局参数同时去除线粒体+叶绿体（默认覆盖常见命名，可清空保留），并分别统计两类占比进 qc.json。
3. **SPOT 扩展到 ATAC-seq 与 ChIP-seq**：SPOT（hotspot 内 reads 占比）原本是 ENCODE DNase-seq 的指标；
   我们在 ATAC-seq、TF/组蛋白 ChIP-seq 上也计算（hotspot2 可用时自动启用，缺失明确 SKIP 不阻断）。
4. **RPKM 标准化信号轨迹**：ATAC-seq 与 ChIP-seq 的 QC 步骤产出 `qc/tracks/*.rpkm.bw`
   （deepTools bamCoverage --normalizeUsing RPKM），可直接拖入 IGV 或基因组浏览器。
5. **IGV 风格峰快照**：QC 步骤对每个样本固定随机种子抽 5 个峰，绘制峰区 ±1.5kb 的覆盖深度图
   （峰区高亮）到 `qc/igv/*.png`，无需登录集群图形界面即可抽查峰质量（需 matplotlib，缺失自动 SKIP）。

## 1. TF ChIP-seq（`encode-chipseq-tf`）

**用途**：定位转录因子在全基因组上的结合位点（窄峰），并评估实验可重复性。

**分析步骤**：

1. FastQC 原始数据质控。
2. BWA MEM 比对（`-t 线程`，双端；单端只传 R1），samtools 排序。
3. 过滤：`samtools view -q 30 -f 2 -F 1804`（MAPQ≥30、保留正确配对、去未比对/次要比对/QC 失败/重复标记）；
   `samtools fixmate -m` + Picard `MarkDuplicates REMOVE_DUPLICATES=true` 去 PCR 重复，产出 dup_metrics。
4. 链相关分析：`run_spp.R`（phantompeakqualtools）计算 NSC/RSC；由 dup_metrics 计算 NRF（PBC 可用 preseq 补充）。
5. MACS2 窄峰调用：`macs2 callpeak -g <有效基因组大小> -q 0.05`（有 Input/IgG 对照时 `-c`）；
   `bedtools intersect -v` 去除 ENCODE 黑名单区域。
6. 信号轨迹与峰快照（HPClaw 扩展）：`bamCoverage --normalizeUsing RPKM` 产出 bigWig；
   SPOT（hotspot2 可用时）；随机 5 个峰的 IGV 风格覆盖图（qc/igv/）。
7. 重复间 IDR 一致性：对真重复与自我伪重复（pseudoreplicate）分别跑 IDR，合并池峰为 oracle，
   `idr --rank p.value`，阈值 IDR<0.05。
8. FRiP：落入最终峰的 reads 占比。

**质控指标与阈值**：

| 指标 | 达标 | 警告 |
|---|---|---|
| 链相关 NSC | ≥1.05 | 1.0–1.05 |
| 链相关 RSC | ≥0.8 | 0.5–0.8 |
| 库复杂度 NRF / PBC | ≥0.8 | 0.6–0.8 |
| FRiP | ≥1% | 0.5–1% |
| SPOT（需 hotspot2） | ≥0.3 | 0.2–0.3 |
| 重复间 IDR | Np/Nt < 2（IDR<0.05 峰数） | Np/Nt ≥ 2 判不一致 |
| FastQC | Q30>80%，接头<5% | Q30 70–80% 或接头 5–15% |

**产出文件**：`*.dedup.bam`（+`.bai`）、`qc/*.cc.qc`、`qc/*.dup_metrics.txt`、`peaks/*_peaks.narrowPeak`、
`peaks/*.peaks.final.bed`、`idr/idr.txt(+plot)`、`qc/tracks/*.rpkm.bw`、`qc/igv/*.png`、`qc/spot.tsv`（有 hotspot2 时）、`qc/qc.json`、`qc/idr_qc.json`。

## 2. 组蛋白 ChIP-seq（`encode-chipseq-histone`）

**用途**：定位组蛋白修饰（H3K27ac、H3K4me3、H3K36me3 等）的宽域富集区域。

**分析步骤**：映射、过滤、去重、黑名单去除、链相关与库复杂度评估同 TF ChIP-seq；峰调用改用
**SPP 宽峰**（`run_spp.R -npeak=300000` 输出 regionPeak）或 GEM / `macs2 callpeak --broad --broad-cutoff 0.1`；
信号轨迹（RPKM bigWig）、SPOT 与峰快照 QC 同 TF ChIP-seq；重复间一致性同样走 IDR（broadPeak 输入）。

**质控指标与阈值**：与 TF ChIP-seq 相同（NSC≥1.05、RSC≥0.8、NRF/PBC≥0.8、FRiP≥1%、IDR Np/Nt<2）。

**产出文件**：`*.dedup.bam`、`peaks/*.regionPeak(.final.bed)` 或 `*_peaks.broadPeak`、
`idr/idr.txt`、`qc/qc.json`、`qc/idr_qc.json`。

## 3. bulk RNA-seq（`encode-rnaseq-bulk`）

**用途**：基因与转录本表达定量（TPM/FPKM），支持双端/单端、链特异性/非链特异性文库。

**分析步骤**：

1. FastQC 原始数据质控。
2. STAR 比对：`--outSAMtype BAM SortedByCoordinate --quantMode TranscriptomeSAM GeneCounts`，
   `--outFilterMultimapNmax 20 --outFilterMismatchNoverLmax 0.04 --alignIntronMin 20 --alignIntronMax 1000000`。
3. RSEM 定量：`rsem-calculate-expression --bam --estimate-rspd --calc-ci --seed 12345`；
   链特异性按 `--forward-prob 1/0`（unstranded 为 0.5 缺省），产出 gene/isoform 级 TPM/FPKM。
4. QC：Picard `CollectRnaSeqMetrics`（rRNA 占比、duplication）+ `samtools flagstat`（比对率）；
   `geneBody_coverage.py`（RSeQC）评估覆盖均一性；重复间按 RSEM TPM 计算 Spearman 相关。

**质控指标与阈值**：

| 指标 | 达标 | 警告 |
|---|---|---|
| 总比对率 | >70% | 50–70%；<50% 检查污染/建库 |
| rRNA 占比 | <10% | 10–30% |
| duplication rate | 尽量低（文库类型相关） | 异常升高时结合 NRF 评估 |
| 重复间表达 Spearman | >0.9 | 0.8–0.9 |
| gene body coverage | 5′–3′ 覆盖均匀 | 明显 3′/5′ 偏倚 |

**产出文件**：`*.Aligned.sortedByCoord.out.bam`、`*.Aligned.toTranscriptome.out.bam`、
`*.rsem.genes.results` / `*.rsem.isoforms.results`、`*.ReadsPerGene.out.tab`、
`qc/*.rnaseq_metrics.txt`、`qc/genebody.*`、`qc/qc.json`、`qc/rep_qc.json`。

## 4. ATAC-seq（`encode-atacseq`）

**用途**：全基因组染色质可及性检测（开放区域峰、TSS 富集）。

**分析步骤**：

1. FastQC 原始数据质控。
2. Bowtie2 比对：`-X 2000 --very-sensitive`，samtools 排序。
3. 过滤：去细胞器 reads——线粒体（chrM）**和叶绿体（chrC/plastid）**（ENCODE 原版只去线粒体，
   植物样本必须同时去叶绿体；模式由 `ORGANELLE_REGEX` 全局参数控制，可清空保留）、MAPQ≥30、`-F 1804`、
   Picard MarkDuplicates 去重、bedtools 去黑名单；`qc/organelle.tsv` 分别统计线粒体/叶绿体/合计占比。
4. Tn5 偏移校正：+链 +4 bp、−链 −5 bp（`alignmentSieve --ATACshift` 或 BED 层平移）。
5. MACS2 峰调用：`--nomodel --shift -75 --extsize 150 -q 0.01`（双端 `-f BAMPE`）。
6. QC：deepTools `computeMatrix reference-point` + `plotProfile` 计算 TSS 富集分数；FRiP；
   **SPOT**（hotspot2 可用时自动计算，缺失则 SKIP 并在日志注明）；Picard `CollectInsertSizeMetrics`
   看核小体片段周期性；NRF 由 dup_metrics 计算。

**质控指标与阈值**：

| 指标 | 达标 | 警告 |
|---|---|---|
| TSS enrichment | >6（>10 理想） | 4–6 |
| FRiP | ≥0.2 | 0.1–0.2 |
| SPOT（有 hotspot2 时） | ≥0.3 | 0.2–0.3 |
| NRF | >0.8 | 0.6–0.8 |
| 细胞器 reads 占比（线粒体+叶绿体） | <20% | 20–50% |
| 片段分布 | 核小体单/双/三体周期性清晰 | 周期性缺失（过度消化或降解） |

**产出文件**：`*.final.bam`（去 chrM/去重/去黑名单）、`*.shifted.bam`、
`peaks/*_peaks.narrowPeak`、`qc/*.dup_metrics.txt`、`qc/*.insert_size_metrics.txt`、
`qc/tss_enrichment.png`、`qc/qc.json`。

## 5. DNase-seq（`encode-dnaseseq`）

**用途**：DNase I 超敏感位点（开放染色质区域）检测。

**分析步骤**：

1. FastQC 质控。
2. Bowtie2（或 BWA MEM）比对，samtools 排序。
3. 过滤：MAPQ≥30、去细胞器 reads（线粒体+叶绿体，`ORGANELLE_REGEX` 控制，植物样本必去叶绿体）、
   去重（Picard MarkDuplicates）、去黑名单。
4. 开放区域调用：**hotspot2**（`hotspot2` 输出 hotspots/peaks，附带 SPOT score）；
   无 hotspot2 时用 F-seq（`fseq -b 600 -f 0`）备选。
5. QC：SPOT/FRiP（落入 hotspot 的 reads 占比）、库复杂度 NRF。

**质控指标与阈值**：

| 指标 | 达标 | 警告 |
|---|---|---|
| SPOT score / FRiP | ≥0.3（细胞系理想 ≥0.4） | 0.2–0.3 |
| 库复杂度 NRF | ≥0.8 | 0.6–0.8 |
| 比对率 | >80% | 60–80% |
| 细胞器 reads 占比（线粒体+叶绿体） | <20% | 20–50% |

**产出文件**：`*.dedup.bam`、`hotspots/*.hotspots.fdr0.05.bed(.starch)`、
`hotspots/*.peaks.bed`、`qc/spot.txt`、`qc/qc.json`。

## 6. WGBS（`encode-wgbs`）

**用途**：全基因组单碱基分辨率 DNA 甲基化图谱（CpG/CHG/CHH）。

**分析步骤**：

1. FastQC 质控。
2. Bismark（bowtie2 引擎）比对：`bismark --parallel N -p 线程 --genome <bismark 索引目录> -1 R1 -2 R2`。
3. `deduplicate_bismark --paired` 去重。
4. `bismark_methylation_extractor --paired-end --bedGraph --counts --cytosine_report --CX_context`
   提取 CpG/CHG/CHH 甲基化，生成 bedGraph/coverage/cytosine report。
5. QC：比对效率（Bismark report）、亚硫酸盐转化率（lambda spike-in 或未甲基化胞嘧啶的 CHH 背景）、
   CpG 覆盖度（bedGraph 覆盖的 CpG 数与深度）。

**质控指标与阈值**：

| 指标 | 达标 | 警告 |
|---|---|---|
| 亚硫酸盐转化率 | >99% | 97–99%；<97% 实验失败 |
| 比对效率 | >70% | 50–70% |
| CpG 覆盖度 | 基因组 CpG ≥80% 被覆盖，平均深度 ≥10× | 覆盖 60–80% 或深度 5–10× |
| 去重率（重复占比） | <30% | 30–50% |

**产出文件**：`*_bismark_bt2_pe.deduplicated.bam`、`*.deduplicated.bedGraph.gz(.bw)`、
`*.CpG_report.txt.gz`、`*.CHG/CHH_context_*.txt.gz`、`*.M-bias.txt`、`qc/qc.json`。

## 7. Hi-C（`encode-hic`）

**用途**：三维基因组互作图谱（compartment、TAD、loop）。

**分析步骤**：

1. HiC-Pro：`bowtie2` 双端独立比对 → 配对重建 → 有效互作对筛选
   （去 dangling end、自连 self-circle、religation、单端比对、PCR 重复），产出 `*.allValidPairs` 与 `*.stat`。
2. 分辨率矩阵：`cooler cload pairs` + `cooler zoomify` 生成多分辨率 `.cool/.mcool`
   （或 `juicer_tools pre` 生成 `.hic`）；bin 大小如 10 kb/40 kb/100 kb。
3. QC：解析 HiC-Pro `*.stat`：valid pairs 率、顺式互作占比、顺/反比、重复率、互作距离分布。
4. 互作图谱与结构调用（可选）：HiCExplorer `hicFindTADs`、juicer HiCCUPS loops、
   `hicPlotMatrix` 可视化。

**质控指标与阈值**：

| 指标 | 达标 | 警告 |
|---|---|---|
| valid pairs 率（valid/总 reads） | ≥40% | 25–40% |
| 顺式互作占比 | >40% | 25–40% |
| 顺/反互作比 | >1（长程顺式富集更佳） | ≈1 提示随机连接 |
| PCR 重复率 | <30% | 30–50% |
| 互作距离分布 | 短程峰 + 长程尾巴，无异常尖峰 | dangling/自连峰未清除 |

**产出文件**：`hicpro_out/hic_results/data/*/*.allValidPairs`、
`hic_results/matrix/*/{raw,iced}/*/*.matrix(.bed)`、`*.mcool`/`.hic`、
`hic_results/pic`、`*_allValidPairs.mergestat` 等 `*.stat`、`qc/qc.json`。

## 8. ChIA-PET（`encode-chiapet`）

**用途**：特定蛋白介导的远程染色质互作（enhancer–promoter 环）。

**分析步骤**：

1. 连接子（linker）鉴定与接头处理：按 linker 序列拆分/过滤 reads。
2. BWA MEM 比对，配对为 PET（paired-end tag）。
3. PET 分类与去重：区分自连 PET（同片段、短距离）与互连 PET（inter-ligation），去 PCR 重复。
4. 环调用：Mango 或 ChIA-PET2 聚类 PET cluster，按锚点重叠与统计显著性（FDR）筛可信环。
5. QC：有效连接率（inter-ligation PET 占比）、重复率、PET cluster 数量与可信度分层。

**质控指标与阈值**：

| 指标 | 达标 | 警告 |
|---|---|---|
| 有效连接率（inter-ligation PET/总 PET） | >10%（蛋白依赖，越高越好） | 5–10% |
| PCR 重复率 | <30% | 30–50% |
| PET cluster | 高可信（≥3 PET 支持）cluster 数千以上且重复间可重复 | cluster 稀少或重复间不可重复 |

**产出文件**：`*.linker_filtered.fastq`、`*.mapped.pet(.bedpe)`、
`*_interactions.fdr*.bedpe`（Mango/ChIA-PET2）、`qc/qc.json`。

## 9. miRNA-seq（`encode-mirnaseq`）

**用途**：小 RNA（miRNA）表达定量。

**分析步骤**：

1. FastQC 质控。
2. cutadapt 去接头与长度筛选：`cutadapt -a <接头> -m 15 -M 35`，保留 15–35 nt reads。
3. miRNA 定量：miRDeep2 `mapper.pl`（collapse）+ `quantifier.pl`（对 miRBase hairpin/mature 定量），
   或直接 bowtie2 比对 miRBase 后按 miRNA 计数，产出 counts per miRNA。
4. QC：长度分布（15–35 nt 占比）、miRNA 映射率、rRNA/tRNA/snRNA 等污染率（对污染序列库比对评估）。

**质控指标与阈值**：

| 指标 | 达标 | 警告 |
|---|---|---|
| 接头去除率 | >95% | 80–95% |
| 15–35 nt reads 占比 | >70% | 50–70% |
| miRNA 映射率 | >50%（组织/细胞系） | 30–50% |
| rRNA/tRNA 污染率 | <10% | 10–20% |

**产出文件**：`trimmed/*.trimmed.fq.gz`、`miRNAs_expressed_all_samples_*.csv`（miRDeep2）、
`counts_per_mirna.tsv`、`qc/qc.json`。

## 10. eCLIP（`encode-eclip`）

**用途**：RNA 结合蛋白（RBP）在转录组上的结合位点（单核苷酸分辨率）。

**分析步骤**：

1. cutadapt 去接头（双轮去接头可降低接头二聚体）。
2. STAR 比对到参考基因组（`--outFilterMultimapNmax 1` 或按重复元件策略放宽）。
3. UMI 去 PCR 重复：`umi_tools dedup`（eCLIP  reads 5′ 端带随机条形码）。
4. 峰调用与 input 归一化：CLIPper（或 PureCLIP）在 IP 样本上调用峰，
   以 size-matched input（SMInput）对照做归一化富集（log2 fold-enrichment 与 -log10 p 阈值过滤）。
5. QC：PCR 重复率、input 归一化富集倍数分布、重复间可重复峰（IDR 或重叠率）。

**质控指标与阈值**：

| 指标 | 达标 | 警告 |
|---|---|---|
| PCR 重复率 | <60%（eCLIP 文库复杂度相关） | 60–80% |
| input 归一化富集 | 峰区 log2FC≥3 且 p≤0.001 的峰数达标 | 富集峰稀少 |
| 重复间可重复峰 | 可重复峰占比 ≥50% | 30–50% |

**产出文件**：`*.Aligned.sortedByCoord.out.bam`、`*.dedup.bam`、
`*.peak_clusters.bed`（CLIPper）、`*.normalized_peaks.bed`、`qc/qc.json`。

## 11. 长读长 RNA-seq（`encode-longread-rnaseq`）

**用途**：PacBio/ONT 全长转录本测序的转录本组装、定量与 novel isoform 发现。

**分析步骤**：

1. minimap2 比对：PacBio `-ax splice:hq -uf --secondary=no`，ONT `-ax splice -uf --secondary=no`，
   samtools 排序。
2. 转录本组装与定量：TALON 或 FLAIR（参考 GTF 引导），注释 known/novel isoform，产出转录本定量矩阵。
3. QC：比对率、全长转录本比例（与已知注释 5′/3′ 端匹配）、novel isoform 比例、
   饱和度曲线（抽稀 reads 看 isoform 发现是否饱和）。

**质控指标与阈值**：

| 指标 | 达标 | 警告 |
|---|---|---|
| 比对率 | >80% | 60–80% |
| 全长转录本比例 | >50%（PacBio CCS 理想更高） | 30–50% |
| novel isoform 比例 | 合理范围（组织/细胞系相关，一般 <40%） | 异常高提示注释不全或组装噪声 |
| 饱和度 | 曲线进入平台期 | 未饱和提示需加测 |

**产出文件**：`*.sorted.bam`、`*_talon.gtf`/`flair.collapse.isoforms.gtf`、
`*_abundance.tsv`、`*_talon_read_annot.tsv`、`qc/qc.json`。

## 参考来源

- ENCODE 官方统一流程清单：<https://www.encodeproject.org/pipelines/>
- Hitz BC, et al. *The ENCODE Uniform Analysis Pipelines*. 2023
  （ENCODE 统一分析流程方法学论文，bioRxiv 2023.04.04.535623）。
- 各流程阈值同时参考 ENCODE 数据质量标准：<https://www.encodeproject.org/data-standards/>
