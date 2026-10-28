// 流程存储迁移与种子生命周期测试：临时数据目录 + 真实 skills 源。
// 每个用例用全新的临时 TRACE_DATA_ROOT（经 vi.mock('../paths') 注入）并 resetModules，
// 模拟独立进程启动，避免模块级缓存（storeCache / bioskillsSeedsReady）串扰。
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WORKFLOW_CATEGORIES } from '../../shared/workflow';
import type { Workflow } from './workflowTypes';
import { resolveWorkflowStepGraph } from './workflowRunService';
import { translateUiText } from '../../src/i18n';
import { buildDataPrepGuide } from '../../src/features/workflows/dataPrepGuide';

const { state } = vi.hoisted(() => ({ state: { tmpRoot: '' } }));

vi.mock('../paths', () => ({
  appPath: (...segments: string[]) => path.join(process.cwd(), ...segments),
  dataPath: (...segments: string[]) => path.join(state.tmpRoot, ...segments),
}));

/** 新临时数据目录 + 全新模块实例（等价于一次全新的应用启动） */
async function freshStore(): Promise<typeof import('./workflowStore')> {
  state.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-workflow-store-'));
  vi.resetModules();
  return import('./workflowStore');
}

/** 同一数据目录“重启”：重置模块状态但保留磁盘内容 */
async function restartStore(): Promise<typeof import('./workflowStore')> {
  vi.resetModules();
  return import('./workflowStore');
}

const storeFile = () => path.join(state.tmpRoot, 'workflows', 'workflows.json');
const deletedFile = () => path.join(state.tmpRoot, 'workflows', 'deleted-builtin-seeds.json');

describe('内置流程分类映射', () => {
  it('covers every built-in metadata field in English without modifying scientific definitions', async () => {
    const store = await freshStore();
    const workflows = (await store.loadWorkflows()).filter(w => w.source === 'builtin');
    const before = JSON.stringify(workflows);
    const missing: string[] = [];
    const check = (value?: string) => { if (value && /[\u3400-\u9fff]/.test(translateUiText(value, 'en-US'))) missing.push(value); };
    for (const w of workflows) {
      const guide = buildDataPrepGuide(w, 'en-US');
      check(guide.summary);
      expect(JSON.stringify({ points: guide.points, labels: guide.templates.map(t => t.label) })).not.toMatch(/[\u3400-\u9fff]/);
      check(w.name); check(w.description); check(w.manifest?.inputHint);
      w.keywords.forEach(check);
      for (const p of [...w.params, ...w.steps.flatMap(s => s.params || [])]) { check(p.label); check(p.help); check(p.placeholder); }
      for (const s of w.steps) { check(s.title); check(s.notes); check(s.phase); }
      for (const r of w.manifest?.references || []) { check(r.name); check(r.source); }
      for (const q of w.manifest?.qcGates || []) { check(q.metric); check(q.pass); check(q.warn); check(q.onFail); }
    }
    expect(workflows.length).toBeGreaterThanOrEqual(56);
    expect([...new Set(missing)]).toEqual([]);
    expect(JSON.stringify(workflows)).toBe(before);
  });
  it('58 个内置流程全部有映射，且分类名都在 WORKFLOW_CATEGORIES 内', async () => {
    const store = await freshStore();
    const keys = Object.keys(store.BUILTIN_CATEGORIES);
    expect(keys).toHaveLength(58);
    for (const category of Object.values(store.BUILTIN_CATEGORIES)) {
      expect(WORKFLOW_CATEGORIES).toContain(category);
    }
    // 硬编码种子 id 全部覆盖
    for (const seed of store.builtinWorkflows()) {
      expect(store.BUILTIN_CATEGORIES[seed.id]).toBeTruthy();
    }
    // 35 个 BioSkills 种子 id 全部覆盖（6 条与 ENCODE 金标准重复的已退役）
    const { generateBioskillsWorkflows } = await import('./bioskillsSeed');
    const generated = await generateBioskillsWorkflows(path.join(process.cwd(), 'skills'));
    expect(generated.length).toBe(35);
    for (const workflow of generated) {
      expect(store.BUILTIN_CATEGORIES[workflow.id]).toBeTruthy();
    }
  });

  it('ENCODE 中英文内置流程全部映射到转录组与表观调控', async () => {
    const store = await freshStore();
    const encodeIds = [
      'encode-chipseq-tf-dag', 'encode-chipseq-histone', 'encode-rnaseq-bulk', 'encode-atacseq',
      'encode-dnaseseq', 'encode-wgbs', 'encode-hic', 'encode-chiapet', 'encode-mirnaseq',
      'encode-eclip', 'encode-longread-rnaseq',
      'encode-chipseq-histone-en', 'encode-atacseq-en',
    ];
    const seedIds = store.builtinWorkflows().map(w => w.id);
    for (const id of encodeIds) {
      expect(seedIds).toContain(id);
      expect(store.BUILTIN_CATEGORIES[id]).toBe('转录组与表观调控');
    }
  });

  it('抽查：代表性 id 映射到正确分类', async () => {
    const store = await freshStore();
    expect(store.BUILTIN_CATEGORIES['bioskills-gwas-pipeline']).toBe('基因组与变异分析');
    expect(store.BUILTIN_CATEGORIES['bioskills-tcr-pipeline']).toBe('单细胞与免疫分析');
    expect(store.BUILTIN_CATEGORIES['builtin-hidog-vector-trace']).toBe('基因编辑与 CRISPR');
    expect(store.BUILTIN_CATEGORIES['builtin-blast']).toBe('任务管理与通用工具');
    expect(store.BUILTIN_CATEGORIES['encode-chipseq-tf']).toBe('转录组与表观调控');
    expect(store.BUILTIN_CATEGORIES['encode-rampage']).toBeUndefined();
    expect(store.builtinWorkflows().some(workflow => workflow.id === 'encode-rampage')).toBe(false);
  });

  it('BioSkills 生成器接受映射并注入 category', async () => {
    const { generateBioskillsWorkflows } = await import('./bioskillsSeed');
    const generated = await generateBioskillsWorkflows(
      path.join(process.cwd(), 'skills'),
      { 'bioskills-metagenomics-pipeline': '微生物与病原分析', 'bioskills-splicing-pipeline': '转录组与表观调控' },
    );
    expect(generated.find(w => w.id === 'bioskills-metagenomics-pipeline')?.category).toBe('微生物与病原分析');
    expect(generated.find(w => w.id === 'bioskills-splicing-pipeline')?.category).toBe('转录组与表观调控');
    expect(generated.find(w => w.id === 'bioskills-gwas-pipeline')?.category).toBeUndefined();
  });
});

describe('新装（无存储）种子注入', () => {
  it('cleans the requested catalogue once with recoverable definitions and no changes to run results', async () => {
    const store = await freshStore();
    await store.loadWorkflows();
    const retired = { id: 'bioskills-hic-pipeline', name: 'Hi-C 三维基因组分析全流程', source: 'builtin', params: [], steps: [], keywords: [], description: '', createdAt: 0, updatedAt: 0 } as Workflow;
    const pending = { ...retired, id: 'old-paper', name: '旧文献流程', source: 'user' as const,
      lifecycle: { state: 'pending_disposal' as const, origin: 'user' as const, updatedAt: 0 } };
    const list = await store.loadWorkflows();
    list.find(w => w.id === 'bioskills-atacseq-pipeline')!.lifecycle = pending.lifecycle;
    await store.saveWorkflows([...list, retired, pending]);
    await fs.writeFile(deletedFile(), JSON.stringify(['bioskills-chipseq-pipeline']));
    const resultDir = path.join(state.tmpRoot, 'runs', 'existing');
    await fs.mkdir(resultDir, { recursive: true });
    await fs.writeFile(path.join(resultDir, 'result.tsv'), 'unaltered');
    store.enableRequestedCatalogueCleanup();
    const kept = await store.loadWorkflows();
    expect(kept.every(w => w.lifecycle?.state !== 'pending_disposal')).toBe(true);
    for (const id of store.REQUESTED_KEEP_IDS) expect(kept.find(w => w.id === id)?.lifecycle?.state).toBe('active');
    for (const id of store.REQUESTED_REMOVE_IDS) expect(kept.some(w => w.id === id)).toBe(false);
    expect(kept.some(w => w.id === 'encode-hic')).toBe(true);
    expect(kept.some(w => w.id === 'encode-eclip')).toBe(true);
    expect(kept.some(w => w.id === 'old-paper')).toBe(false);
    const marker = JSON.parse(await fs.readFile(path.join(state.tmpRoot, 'workflows', '.catalogue-cleanup-v0.5.16.json'), 'utf-8'));
    const backup = JSON.parse(await fs.readFile(path.join(marker.backupDir, 'workflows.json'), 'utf-8'));
    expect(backup.some((w: Workflow) => w.id === 'old-paper')).toBe(true);
    expect(await fs.readFile(path.join(resultDir, 'result.tsv'), 'utf-8')).toBe('unaltered');
    const draft = await store.upsertWorkflow({ name: 'New review draft', steps: [{ title: 'Review', command: '# REVIEW_REQUIRED' }] });
    const restarted = await restartStore(); restarted.enableRequestedCatalogueCleanup();
    const reloaded = await restarted.loadWorkflows();
    expect(reloaded.find(w => w.id === draft.id)?.lifecycle?.state).toBe('pending_disposal');
    for (const id of restarted.REQUESTED_REMOVE_IDS) expect(reloaded.some(w => w.id === id)).toBe(false);
    expect(JSON.parse(await fs.readFile(deletedFile(), 'utf-8'))).toEqual(expect.arrayContaining([...restarted.REQUESTED_REMOVE_IDS]));
  });
  it('retires only untouched duplicate TF ChIP definitions, saves recoverable backups and preserves customized workflows', async () => {
    const store = await freshStore();
    const linear = store.builtinWorkflows(true).filter(w => ['encode-chipseq-tf', 'encode-chipseq-tf-en'].includes(w.id));
    const customized = { ...linear[1], name: 'My edited TF pipeline',
      provenance: { ...linear[1].provenance!, customized: true } };
    await fs.mkdir(path.dirname(storeFile()), { recursive: true });
    await fs.writeFile(storeFile(), JSON.stringify([linear[0], customized]), 'utf-8');
    const migrated = await store.loadWorkflows();
    expect(migrated.some(w => w.id === 'encode-chipseq-tf')).toBe(false);
    expect(migrated.find(w => w.id === customized.id)?.name).toBe(customized.name);
    expect(migrated.some(w => w.id === 'encode-chipseq-tf-dag')).toBe(true);
    const backupDir = path.join(state.tmpRoot, 'workflows', 'deleted-definitions');
    const backups = await fs.readdir(backupDir);
    expect(backups).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(path.join(backupDir, backups[0]), 'utf-8'))).toEqual(linear[0]);
    const restarted = await (await restartStore()).loadWorkflows();
    expect(restarted.some(w => w.id === 'encode-chipseq-tf')).toBe(false);
    expect(restarted.find(w => w.id === customized.id)?.provenance?.customized).toBe(true);
  });
  it('56 个内置流程照常入库且全部带分类', async () => {
    const store = await freshStore();
    const list = await store.loadWorkflows();
    const builtins = list.filter(w => w.source === 'builtin');
    expect(builtins).toHaveLength(56);
    expect(builtins.every(w => Boolean(w.category))).toBe(true);
    expect(builtins.find(w => w.id === 'builtin-rnaseq-qc-align')?.category).toBe('转录组与表观调控');
    expect(builtins.find(w => w.id === 'bioskills-metagenomics-pipeline')?.category).toBe('微生物与病原分析');
    // 13 个 ENCODE 内置流程（含 2 个英文版）一并入库
    const encodeBuiltins = builtins.filter(w => w.id.startsWith('encode-'));
    expect(encodeBuiltins).toHaveLength(13);
    expect(encodeBuiltins.every(w => w.category === '转录组与表观调控')).toBe(true);
    const chipseq = builtins.find(w => w.id === 'encode-chipseq-tf-dag');
    // chip/atac/rnaseq 四条已恢复为 TRACE 原生参数式流程（串行 9 步，无 caper/genome TSV）
    expect(chipseq?.steps.length).toBe(10);
    expect(chipseq?.steps[0]?.title).toContain('运行前检查');
    expect(chipseq?.steps[0]?.command).toContain('command -v hotspot2.sh');
    expect(chipseq?.steps[0]?.command).not.toContain('caper');
    expect(chipseq?.manifest?.qcGates.length).toBeGreaterThan(0);
  });

  it('13 条 ENCODE 定义都有固定来源、可解析 DAG 与真实上游入口', async () => {
    const store = await freshStore();
    const encode = store.builtinWorkflows().filter(workflow => workflow.id.startsWith('encode-'));
    expect(encode).toHaveLength(13);
    for (const workflow of encode) {
      expect(workflow.provenance?.sourceUrl).toMatch(/^https:\/\//);
      expect(workflow.provenance?.sourceRef).toBeTruthy();
      expect(workflow.provenance?.upstreamWorkflow).toBeTruthy();
      expect(['encode-dcc', 'encode-partner', 'trace-native']).toContain(workflow.provenance?.provider);
      expect(['official-wrapper', 'reference-extension']).toContain(workflow.provenance?.implementation);
      const graph = resolveWorkflowStepGraph(workflow);
      expect(graph).toHaveLength(workflow.steps.length);
      expect(new Set(graph.map(step => step.stepId)).size).toBe(graph.length);
    }

    // 原生参数式四条：直接指定参考文件路径，不走 genome TSV / caper
    const tf = encode.find(workflow => workflow.id === 'encode-chipseq-tf-dag')!;
    expect(tf.provenance?.provider).toBe('trace-native');
    expect(tf.steps.map(step => step.title).join(' ')).toContain('MACS2 窄峰调用');
    expect(tf.steps.map(step => step.title).join(' ')).toContain('IDR');
    expect(tf.params.map(param => param.name)).toEqual(expect.arrayContaining(['INPUT_DIR', 'CONTROL_DIR', 'BWA_INDEX', 'REF_FA', 'TSS_BED', 'GENOME_SIZE']));
    expect(tf.params.map(param => param.name)).not.toContain('BLACKLIST');

    const histone = encode.find(workflow => workflow.id === 'encode-chipseq-histone')!;
    expect(histone.steps.map(step => step.title).join(' ')).toContain('SPP 宽峰调用');

    const rna = encode.find(workflow => workflow.id === 'encode-rnaseq-bulk')!;
    expect(rna.steps.map(step => step.title).join(' ')).toContain('STAR alignment');
    expect(rna.steps.map(step => step.title).join(' ')).toContain('RSEM gene and isoform quantification');
    expect(rna.params.map(param => param.name)).toEqual(expect.arrayContaining([
      'INPUT_DIR', 'STAR_INDEX', 'RSEM_INDEX', 'GTF', 'LAYOUT', 'STRANDEDNESS',
    ]));

    const wgbs = encode.find(workflow => workflow.id === 'encode-wgbs')!;
    expect(wgbs.provenance?.sourceRef).toContain('48afda6300b06a9f1b7c2156482f8caa6f49ee51');
    expect(wgbs.steps.map(step => step.id)).toEqual(expect.arrayContaining(['prepare-map', 'bscaller', 'coverage', 'extract', 'signals', 'qc']));
    expect(wgbs.steps.map(step => step.id)).not.toContain('pool');

    expect(encode.find(workflow => workflow.id === 'encode-chiapet')?.provenance?.provider).toBe('encode-partner');
    expect(encode.find(workflow => workflow.id === 'encode-eclip')?.provenance?.provider).toBe('encode-partner');
    expect(encode.some(workflow => workflow.id === 'encode-rampage')).toBe(false);
  });
});

describe('内置流程编辑保护（provenance.customized）', () => {
  it('升级时将旧官方包装流程移入待弃置，不丢失定义', async () => {
    const store = await freshStore();
    await store.loadWorkflows();
    const raw = JSON.parse(await fs.readFile(storeFile(), 'utf-8')) as Workflow[];
    raw.push({
      id: 'encode-chipseq-tf-official', name: 'legacy', description: '', keywords: [], params: [],
      steps: [{ title: 'legacy', command: 'legacy' }], source: 'builtin', createdAt: 1, updatedAt: 1,
      provenance: { provider: 'encode-dcc', implementation: 'official-wrapper' },
    });
    await fs.writeFile(storeFile(), JSON.stringify(raw, null, 2), 'utf-8');
    const restarted = await restartStore();
    const migrated = await restarted.loadWorkflows();
    expect(migrated.find(workflow => workflow.id === 'encode-chipseq-tf-official')?.lifecycle).toMatchObject({ state: 'pending_disposal', reasonCode: 'retired_seed' });
  });

  it('编辑硬编码内置流程后 reload 字段不回滚，并补 customized 标记', async () => {
    const store = await freshStore();
    const list = await store.loadWorkflows();
    const seed = list.find(w => w.id === 'builtin-blast')!;
    expect(seed.provenance?.customized).toBeUndefined();

    const edited = await store.upsertWorkflow({ ...seed, name: '我的 BLAST 定制版' });
    expect(edited.provenance?.customized).toBe(true);

    const reloaded = await store.loadWorkflows();
    const blast = reloaded.find(w => w.id === 'builtin-blast')!;
    expect(blast.name).toBe('我的 BLAST 定制版');
    expect(blast.provenance?.customized).toBe(true);
    expect(blast.category).toBe('任务管理与通用工具');
  });

  it('编辑 BioSkills 流程后 reload 不回滚', async () => {
    const store = await freshStore();
    const list = await store.loadWorkflows();
    const seed = list.find(w => w.id === 'bioskills-gwas-pipeline')!;
    await store.upsertWorkflow({ ...seed, name: '我的 GWAS 笔记版' });

    const reloaded = await store.loadWorkflows();
    const gwas = reloaded.find(w => w.id === 'bioskills-gwas-pipeline')!;
    expect(gwas.name).toBe('我的 GWAS 笔记版');
    expect(gwas.provenance?.provider).toBe('bioskills');
    expect(gwas.provenance?.customized).toBe(true);
  });

  it('未自定义的内置流程仍随种子迁移刷新（含分类纠正）', async () => {
    const store = await freshStore();
    await store.loadWorkflows();
    // 模拟外部篡改库存：名称与分类都被改写
    const raw = JSON.parse(await fs.readFile(storeFile(), 'utf-8')) as Workflow[];
    const blast = raw.find(w => w.id === 'builtin-blast')!;
    blast.name = '被外部篡改';
    blast.category = '错误分类';
    await fs.writeFile(storeFile(), JSON.stringify(raw, null, 2), 'utf-8');

    const reloaded = await store.loadWorkflows();
    const migrated = reloaded.find(w => w.id === 'builtin-blast')!;
    expect(migrated.name).toBe('BLAST 同源比对流程');
    expect(migrated.category).toBe('任务管理与通用工具');
  });
});

describe('内置流程删除持久化', () => {
  it('删除硬编码内置流程后 reload 不复活，且写入 deleted 清单', async () => {
    const store = await freshStore();
    await store.loadWorkflows();
    expect(await store.deleteWorkflow('builtin-blast')).toBe(true);

    const deletedIds = JSON.parse(await fs.readFile(deletedFile(), 'utf-8')) as string[];
    expect(deletedIds).toContain('builtin-blast');

    const reloaded = await store.loadWorkflows();
    expect(reloaded.some(w => w.id === 'builtin-blast')).toBe(false);
    // 缓存命中路径（第二次 load 走 storeCache）同样不复活
    const cached = await store.loadWorkflows();
    expect(cached.some(w => w.id === 'builtin-blast')).toBe(false);
    // 其余内置流程不受影响
    expect(reloaded.filter(w => w.source === 'builtin')).toHaveLength(55);
  });

  it('删除 BioSkills 流程后“重启”也不复活', async () => {
    let store = await freshStore();
    await store.loadWorkflows();
    expect(await store.deleteWorkflow('bioskills-gwas-pipeline')).toBe(true);

    store = await restartStore();
    const reloaded = await store.loadWorkflows();
    expect(reloaded.some(w => w.id === 'bioskills-gwas-pipeline')).toBe(false);
    expect(reloaded.some(w => w.id === 'bioskills-cnv-pipeline')).toBe(true);
    expect(reloaded.filter(w => w.source === 'builtin')).toHaveLength(55);
  });

  it('删除用户自建流程不登记 deleted 清单', async () => {
    const store = await freshStore();
    await store.loadWorkflows();
    const created = await store.upsertWorkflow({ name: '用户流程', steps: [{ title: 't', command: 'c' }] });
    expect(await store.deleteWorkflow(created.id)).toBe(true);
    await expect(fs.readFile(deletedFile(), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
    const reloaded = await store.loadWorkflows();
    expect(reloaded.some(w => w.id === created.id)).toBe(false);
    expect(reloaded.filter(w => w.source === 'builtin')).toHaveLength(56);
  });

  it('mergeGeneratedBioskills 不复活 deleted 清单中的种子（残留项直接移除）', async () => {
    const store = await freshStore();
    const generated = (id: string): Workflow => ({
      id,
      name: id,
      description: '',
      keywords: [],
      params: [],
      steps: [{ title: 's', command: 'c' }],
      provenance: {
        provider: 'bioskills', sourcePath: 'bioSkills/workflows/x/SKILL.md', sourceName: 'x',
        sourceDigest: 'd', importerVersion: '2',
      },
      source: 'builtin',
      createdAt: 1,
      updatedAt: 1,
    });
    const list = [generated('bioskills-deleted')]; // 已删除但因外部改写残留
    const result = store.mergeGeneratedBioskills(
      list,
      [generated('bioskills-deleted'), generated('bioskills-new')],
      new Set(['bioskills-deleted']),
    );
    expect(result.added).toBe(1); // 只有 bioskills-new
    expect(list.some(w => w.id === 'bioskills-new')).toBe(true);
    expect(list.some(w => w.id === 'bioskills-deleted')).toBe(false);
  });
});

describe('upsertWorkflow 分类合并语义', () => {
  it('待弃置状态和用户恢复跨重启保留，移动不改科学定义', async () => {
    const store = await freshStore();
    const original = (await store.loadWorkflows()).find(w => w.id === 'encode-atacseq')!;
    const moved = await store.setWorkflowLifecycle(original.id, 'pending_disposal', '仅收起');
    expect(moved?.steps).toEqual(original.steps);
    expect(moved?.provenance?.customized).not.toBe(true);
    let restarted = await restartStore();
    expect((await restarted.loadWorkflows()).find(w => w.id === original.id)?.lifecycle?.reason).toBe('仅收起');
    await restarted.setWorkflowLifecycle('encode-atacseq-en', 'active');
    restarted = await restartStore();
    expect((await restarted.loadWorkflows()).find(w => w.id === 'encode-atacseq-en')?.lifecycle?.state).toBe('active');
  });
  it('内置、用户、AI 和待弃置均可删除，留定义备份且不复活', async () => {
    const store = await freshStore();
    await store.loadWorkflows();
    const user = await store.upsertWorkflow({ name: 'user', source: 'user', steps: [{ title: 'u', command: 'echo user' }] });
    const ai = await store.upsertWorkflow({ name: 'ai', source: 'ai', steps: [{ title: 'a', command: 'echo ai' }] });
    const ids = ['encode-atacseq', 'encode-chipseq-histone-en', user.id, ai.id];
    await Promise.all(ids.map(id => store.deleteWorkflow(id)));
    const restarted = await restartStore();
    expect((await restarted.loadWorkflows()).filter(w => ids.includes(w.id))).toEqual([]);
    const backupDir = path.join(state.tmpRoot, 'workflows', 'deleted-definitions');
    const snapshots = await Promise.all((await fs.readdir(backupDir)).map(async file => JSON.parse(await fs.readFile(path.join(backupDir, file), 'utf-8'))));
    expect(snapshots.map(w => w.id).sort()).toEqual(ids.sort());
  });
  it('并发移入和恢复不会互相覆盖，未知 ID 不生成新流程', async () => {
    const store = await freshStore();
    await store.loadWorkflows();
    await Promise.all([store.setWorkflowLifecycle('encode-atacseq', 'pending_disposal'), store.setWorkflowLifecycle('encode-chipseq-histone-en', 'active')]);
    const list = await store.loadWorkflows();
    expect(list.find(w => w.id === 'encode-atacseq')?.lifecycle?.state).toBe('pending_disposal');
    expect(list.find(w => w.id === 'encode-chipseq-histone-en')?.lifecycle?.state).toBe('active');
    expect(await store.setWorkflowLifecycle('unknown', 'active')).toBeNull();
  });
  it('未携带 category 保持原值，空串清除，值正常更新', async () => {
    const store = await freshStore();
    const created = await store.upsertWorkflow({
      name: '带分类流程', category: '基因组与变异分析', steps: [{ title: 't', command: 'c' }],
    });
    expect(created.category).toBe('基因组与变异分析');

    // 未携带 category → 保持
    const kept = await store.upsertWorkflow({ id: created.id, name: '带分类流程', steps: [{ title: 't', command: 'c' }] });
    expect(kept.category).toBe('基因组与变异分析');

    // 空串 → 清除
    const cleared = await store.upsertWorkflow({ id: created.id, name: '带分类流程', category: '', steps: [{ title: 't', command: 'c' }] });
    expect(cleared.category).toBeUndefined();

    // 自定义分类 → 更新
    const custom = await store.upsertWorkflow({ id: created.id, name: '带分类流程', category: '我的实验流程', steps: [{ title: 't', command: 'c' }] });
    expect(custom.category).toBe('我的实验流程');
  });
});
