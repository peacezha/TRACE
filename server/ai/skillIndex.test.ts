import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refreshSkillIndex, scoreSkill, searchSkillIndex } from './skillIndex';
import type { SkillIndex, SkillMetadata } from './types';

function makeSkill(overrides: Partial<SkillMetadata>): SkillMetadata {
  return {
    filename: 'fastqc',
    name: 'fastqc',
    description: '',
    tags: [],
    category: 'bio',
    content: '',
    excerpt: '',
    size: 0,
    isSystem: false,
    source: 'system',
    ...overrides,
  } as SkillMetadata;
}

const index: SkillIndex = {
  generatedAt: '2026-01-01',
  skills: [
    makeSkill({
      filename: 'bio/fastqc',
      name: 'FASTQ 质控',
      description: '对 FASTQ 测序数据做质量控制分析',
      tags: ['qc', 'fastq'],
      excerpt: '使用 fastqc 对原始测序 reads 进行质控',
    }),
    makeSkill({
      filename: 'hpc/bsub',
      name: 'LSF 作业提交',
      description: '用 bsub 提交集群作业',
      tags: ['lsf', 'bsub'],
      excerpt: 'bsub -q normal -n 8 提交并行作业',
    }),
  ],
};

describe('skillIndex 中文检索', () => {
  it('中文查询能命中中文技能（bigram 分词）', () => {
    const results = searchSkillIndex(index, '帮我做转录组测序质控', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].filename).toBe('bio/fastqc');
  });

  it('纯中文两二字词也有得分', () => {
    expect(scoreSkill(index.skills[0], '质控')).toBeGreaterThan(0);
  });

  it('英文查询行为保持不变', () => {
    const results = searchSkillIndex(index, 'bsub submit job', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].filename).toBe('hpc/bsub');
  });

  it('中英混合查询可命中', () => {
    const results = searchSkillIndex(index, '用 fastqc 做质控', 5);
    expect(results.map(r => r.filename)).toContain('bio/fastqc');
  });
});

describe('donauSkillDir 技能包接入', () => {
  it('加载 donau_skills 包进索引：source=donau，按系统技能处理', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-donau-skills-'));
    const skillsDir = path.join(root, 'skills');
    const donauDir = path.join(root, 'donau_skills');
    await fs.mkdir(path.join(donauDir, 'references'), { recursive: true });
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(
      path.join(donauDir, 'SKILL.md'),
      '---\nname: hpc-donau\ndescription: 多瑙调度系统使用指南\n---\n\n# Donau\n\ndsub -s job.dsub\n',
    );
    await fs.writeFile(
      path.join(donauDir, 'references', 'djob.md'),
      '# djob\n\n状态：WAITING RUNNING SUCCEEDED FAILED\n',
    );
    const idx = refreshSkillIndex({ skillsDir, donauSkillDir: donauDir, indexPath: path.join(root, '.skill-index.json') });
    const main = idx.skills.find(s => s.filename === 'donau-hpc');
    expect(main).toMatchObject({ source: 'donau', isSystem: true, category: 'system', name: 'hpc-donau' });
    const ref = idx.skills.find(s => s.filename === 'djob');
    expect(ref).toMatchObject({ source: 'donau', isSystem: true, category: 'system' });
    // 不提供 donauSkillDir 时索引不含 donau 技能
    const without = refreshSkillIndex({ skillsDir, indexPath: path.join(root, '.skill-index.json') });
    expect(without.skills.some(s => s.source === 'donau')).toBe(false);
  });
});
