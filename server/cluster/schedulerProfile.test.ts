import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 与 workflowStore.test.ts 同款隔离：临时数据目录 + 模块重置，避免读写真实数据目录
const { state } = vi.hoisted(() => ({ state: { tmpRoot: '' } }));

vi.mock('../paths', () => ({
  appPath: (...segments: string[]) => path.join(process.cwd(), ...segments),
  dataPath: (...segments: string[]) => path.join(state.tmpRoot, ...segments),
}));

async function freshModule(): Promise<typeof import('./schedulerProfile')> {
  state.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-sched-'));
  vi.resetModules();
  return import('./schedulerProfile');
}

describe('schedulerProfile（账号级调度器标签）', () => {
  it('parses probe output into scheduler kind + module/installer availability', async () => {
    const { parseSchedulerProbe } = await freshModule();
    expect(parseSchedulerProbe('SCHED:LSF\nMODULE:YES\nPKG:mamba\nPKG:conda')).toEqual({ kind: 'lsf', hasModule: true, installers: ['mamba', 'conda'] });
    expect(parseSchedulerProbe('SCHED:SLURM\nMODULE:NO').kind).toBe('slurm');
    expect(parseSchedulerProbe('SCHED:SLURM\nMODULE:NO').hasModule).toBe(false);
    expect(parseSchedulerProbe('SCHED:PBS\nMODULE:YES')).toMatchObject({ kind: 'pbs', hasModule: true });
    expect(parseSchedulerProbe('SCHED:DONAU\nMODULE:YES')).toMatchObject({ kind: 'donau', hasModule: true });
    // 多套命令共存时按探测优先级取值：LSF > Slurm > PBS > Donau
    expect(parseSchedulerProbe('SCHED:LSF\nSCHED:DONAU').kind).toBe('lsf');
    expect(parseSchedulerProbe('SCHED:PBS\nSCHED:DONAU').kind).toBe('pbs');
    expect(parseSchedulerProbe('SCHED:NONE\nMODULE:NO\nPKG:pip3')).toEqual({ kind: 'none', hasModule: false, installers: ['pip3'] });
    expect(parseSchedulerProbe('').kind).toBe('none');
  });

  it('caches the detected tag per account and never re-probes', async () => {
    const { resolveAccountScheduler, loadSchedulerTag, schedulerTagKey } = await freshModule();
    const info = { username: 'alice', host: 'hpc.example.edu', port: 22 };
    let probes = 0;
    const exec = async () => { probes += 1; return 'SCHED:SLURM\nMODULE:YES'; };
    const first = await resolveAccountScheduler(info, exec);
    expect(first.kind).toBe('slurm');
    const second = await resolveAccountScheduler(info, exec);
    expect(second.kind).toBe('slurm');
    expect(probes).toBe(1); // 第二次直接命中缓存
    expect((await loadSchedulerTag(schedulerTagKey(info)))?.kind).toBe('slurm');
  });

  it('re-probes once when the cached tag predates the current probe version', async () => {
    const mod = await freshModule();
    const info = { username: 'che24', host: 'hpc2.example.edu', port: 18082 };
    // 先正常存一个标签,再把 probeVersion 抹掉,模拟旧版本留下的历史标签
    await mod.saveSchedulerTag(mod.schedulerTagKey(info), { kind: 'none' });
    const tagFile = path.join(state.tmpRoot, 'scheduler-tags.json');
    const all = JSON.parse(await fs.readFile(tagFile, 'utf8'));
    delete all[mod.schedulerTagKey(info)].probeVersion;
    await fs.writeFile(tagFile, JSON.stringify(all));
    let probes = 0;
    const exec = async () => { probes += 1; return 'SCHED:DONAU\nMODULE:YES'; };
    const re = await mod.resolveAccountScheduler(info, exec);
    expect(re.kind).toBe('donau');
    expect(probes).toBe(1);
    // 重探后的新标签带当前探测版本,之后命中缓存不再重探
    const cached = await mod.loadSchedulerTag(mod.schedulerTagKey(info));
    expect(cached?.probeVersion).toBe(mod.SCHEDULER_PROBE_VERSION);
    await mod.resolveAccountScheduler(info, exec);
    expect(probes).toBe(1);
  });

  it('different accounts on different clusters do not share tags', async () => {
    const { resolveAccountScheduler, schedulerTagKey } = await freshModule();
    const a = await resolveAccountScheduler({ username: 'bob', host: 'a.edu', port: 22 }, async () => 'SCHED:LSF\nMODULE:YES');
    const b = await resolveAccountScheduler({ username: 'bob', host: 'b.edu', port: 22 }, async () => 'SCHED:NONE\nMODULE:NO');
    expect(a.kind).toBe('lsf');
    expect(b.kind).toBe('none');
    expect(schedulerTagKey({ username: 'bob', host: 'a.edu', port: 22 }))
      .not.toBe(schedulerTagKey({ username: 'bob', host: 'b.edu', port: 22 }));
  });

  it('probe failure falls back to none without blocking login', async () => {
    const { resolveAccountScheduler } = await freshModule();
    const tag = await resolveAccountScheduler({ username: 'c', host: 'c.edu', port: 22 }, async () => { throw new Error('ssh down'); });
    expect(tag.kind).toBe('none');
  });

  it('manual redetect clears the tag so next resolve probes again', async () => {
    const { resolveAccountScheduler, clearSchedulerTag, schedulerTagKey } = await freshModule();
    const info = { username: 'd', host: 'd.edu', port: 22 };
    let probes = 0;
    const exec = async () => { probes += 1; return 'PBS'; };
    await resolveAccountScheduler(info, exec);
    await clearSchedulerTag(schedulerTagKey(info));
    await resolveAccountScheduler(info, exec);
    expect(probes).toBe(2);
  });
});

describe('scheduler command maps（LSF/Slurm/PBS/none）', () => {
  it('maps submit commands per scheduler', async () => {
    const { submitCommand } = await import('../notifications/scheduler');
    expect(submitCommand('lsf', '/r/code/step-01.sh')).toBe("bsub < '/r/code/step-01.sh'");
    expect(submitCommand('slurm', '/r/code/step-01.sh')).toBe("sbatch '/r/code/step-01.sh'");
    expect(submitCommand('pbs', '/r/code/step-01.sh')).toBe("qsub '/r/code/step-01.sh'");
    expect(submitCommand('none', '/r/code/step-01.sh')).toContain('nohup bash');
  });

  it('parses PBS qstat output', async () => {
    const { parseQstatOutput } = await import('../notifications/scheduler');
    const raw = [
      'Job ID            Name        User      Time Use S Queue',
      '----------------  ----------- --------- -------- - -----',
      '12345.mgr         myjob       alice     00:00:01 R batch',
      '12346.mgr         queued      alice     00:00:00 Q batch',
    ].join('\n');
    const jobs = parseQstatOutput(raw);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ jobId: '12345', name: 'myjob', status: 'RUN', queue: 'batch' });
    expect(jobs[1].status).toBe('PEND');
  });

  it('translates #BSUB directives to #SBATCH/#PBS and strips them for none', async () => {
    const { translateSchedulerDirectives } = await import('../notifications/scheduler');
    const script = ['#!/usr/bin/env bash', '#BSUB -J encode_rna', '#BSUB -n 8', '#BSUB -q normal', '#BSUB -W 120', '', 'set -e', 'echo hi'].join('\n');
    const slurm = translateSchedulerDirectives(script, 'slurm');
    expect(slurm).toContain('#SBATCH --job-name=encode_rna');
    expect(slurm).toContain('#SBATCH --ntasks=8');
    expect(slurm).toContain('#SBATCH --partition=normal');
    expect(slurm).toContain('#SBATCH --time=120');
    expect(slurm).not.toContain('#BSUB');
    const pbs = translateSchedulerDirectives(script, 'pbs');
    expect(pbs).toContain('#PBS -N encode_rna');
    expect(pbs).toContain('#PBS -l nodes=1:ppn=8');
    const none = translateSchedulerDirectives(script, 'none');
    expect(none).not.toContain('#BSUB');
    expect(none).not.toContain('#SBATCH');
    expect(none).toContain('echo hi');
  });

  it('keeps LSF scripts untouched', async () => {
    const { translateSchedulerDirectives } = await import('../notifications/scheduler');
    const script = '#!/bin/bash\n#BSUB -J x\necho hi\n';
    expect(translateSchedulerDirectives(script, 'lsf')).toBe(script);
  });
});

describe('Donau（多瑙）探测与 prompt 注入', () => {
  it('normalizeSchedulerKind 放行 donau，SCHEDULER_LABELS 含 Donau', async () => {
    const { normalizeSchedulerKind, SCHEDULER_LABELS } = await freshModule();
    expect(normalizeSchedulerKind('donau')).toBe('donau');
    expect(normalizeSchedulerKind('donau2')).toBeNull();
    expect(SCHEDULER_LABELS.donau).toBe('Donau');
  });

  it('中文 prompt 段落包含 dsub/djob/dkill 与 -aa 规则', async () => {
    const { buildSchedulerPromptSection } = await freshModule();
    const zh = buildSchedulerPromptSection('donau', 'zh-CN');
    expect(zh).toContain('多瑙');
    expect(zh).toContain('dsub -s');
    expect(zh).toContain('#DSUB');
    expect(zh).toContain('-aa');
    expect(zh).toContain("-R 'cpu=N'");
    expect(zh).toContain('djob -l');
    expect(zh).toContain('dkill');
    expect(zh).toContain('dqueue');
    expect(zh).toContain('search_skills');
  });

  it('英文 prompt 段落同样包含关键命令与 -aa 规则', async () => {
    const { buildSchedulerPromptSection } = await freshModule();
    const en = buildSchedulerPromptSection('donau', 'en-US');
    expect(en).toContain('Donau');
    expect(en).toContain('dsub -s');
    expect(en).toContain('#DSUB');
    expect(en).toContain('-aa');
    expect(en).toContain('djob -l');
    expect(en).toContain('dkill');
    expect(en).toContain('dqueue');
    expect(en).toContain('search_skills');
  });
});
