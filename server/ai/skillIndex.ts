import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import type { SkillIndex, SkillMetadata } from './types';

export interface SkillIndexOptions {
  skillsDir: string;
  lsfSkillDir?: string;
  /** Bundled Donau (多瑙) scheduler skill pack directory (SKILL.md + references/). */
  donauSkillDir?: string;
  /** Optional writable directory for user-installed skills, scanned in addition to skillsDir. */
  userSkillsDir?: string;
  indexPath?: string;
  clusterSkills?: SkillMetadata[];
}

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.rst',
  '.adoc',
  '.org',
  '.yml',
  '.yaml',
  '.json',
  '.toml',
  '.ini',
  '.conf',
  '.cfg',
  '.sh',
  '.bash',
  '.zsh',
  '.py',
  '.r',
  '.pl',
  '.rb',
  '.jl',
  '.lsf',
  '.sbatch',
  '.csv',
  '.tsv',
  '.log',
  '.out',
  '.err',
]);

export function isTextSkillFile(file: string): boolean {
  return file === 'SKILL.md' || TEXT_EXTENSIONS.has(path.extname(file).toLowerCase());
}

const LOCAL_INDEX_RECHECK_MS = 5_000;
const localIndexCache = new Map<string, {
  checkedAt: number;
  indexMtime: number;
  index: SkillIndex;
}>();
const mergedClusterCache = new WeakMap<SkillIndex, {
  clusterSkills: SkillMetadata[];
  index: SkillIndex;
}>();

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function categoryFor(relativePath: string, source: SkillMetadata['source']): string {
  if (source === 'lsf' || source === 'donau') return 'system';
  if (source === 'cluster') return 'cluster';
  if (relativePath.startsWith('bio/')) return 'bio';
  if (relativePath.startsWith('nature/') || relativePath.includes('nature-')) return 'nature';
  if (relativePath.startsWith('ai/')) return 'ai';
  if (relativePath.startsWith('hpc/')) return 'hpc';
  return source === 'system' ? 'system' : 'user';
}

function normalizeSkillFilename(relativePath: string, source: SkillMetadata['source']): string {
  const filename = relativePath
    .replace(/\/SKILL\.md$/i, '')
    .replace(/\.[^/.]+$/i, '');
  return source === 'cluster' ? `cluster/${filename.replace(/^cluster\//, '')}` : filename;
}

function cleanExcerpt(content: string, maxChars = 1600): string {
  return content
    .replace(/^---[\s\S]*?---\s*/, '')
    .trim()
    .slice(0, maxChars);
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(v => v.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map(v => v.trim()).filter(Boolean);
  return [];
}

function skillFromFile(filePath: string, relativePath: string, source: SkillMetadata['source']): SkillMetadata | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = matter(raw);
    const filename = normalizeSkillFilename(relativePath, source);
    const name = String(parsed.data.name || path.basename(filename) || filename);
    const description = String(parsed.data.description || parsed.data.summary || cleanExcerpt(parsed.content, 240)).slice(0, 500);

    return {
      filename,
      name,
      description,
      tags: normalizeTags(parsed.data.tags),
      trigger: parsed.data.trigger ? String(parsed.data.trigger) : undefined,
      category: categoryFor(relativePath, source),
      content: raw,
      excerpt: cleanExcerpt(parsed.content),
      size: Buffer.byteLength(raw),
      isSystem: source === 'system' || source === 'lsf' || source === 'donau',
      source,
      sourcePath: filePath,
      dependsOn: Array.isArray(parsed.data.depends_on) ? parsed.data.depends_on.map(String) : undefined,
      relatedTo: Array.isArray(parsed.data.related_to) ? parsed.data.related_to.map(String) : undefined,
      usedWith: Array.isArray(parsed.data.used_with) ? parsed.data.used_with.map(String) : undefined,
      solves: Array.isArray(parsed.data.solves) ? parsed.data.solves.map(String) : undefined,
    };
  } catch {
    return null;
  }
}

function collectSkillFiles(root: string, sourceRoot: string, source: SkillMetadata['source'], out: SkillMetadata[]) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.skill-index.json') continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      collectSkillFiles(fullPath, sourceRoot, source, out);
      continue;
    }
    if (!entry.isFile() || !isTextSkillFile(entry.name)) continue;
    const rel = toPosixPath(path.relative(sourceRoot, fullPath));
    const item = skillFromFile(fullPath, rel, source);
    if (item) out.push(item);
  }
}

export function refreshSkillIndex(options: SkillIndexOptions): SkillIndex {
  const skills: SkillMetadata[] = [];

  if (fs.existsSync(options.skillsDir)) {
    for (const entry of fs.readdirSync(options.skillsDir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.skill-index.json') continue;
      const fullPath = path.join(options.skillsDir, entry.name);
      if (entry.isDirectory()) {
        collectSkillFiles(fullPath, options.skillsDir, 'system', skills);
      } else if (entry.isFile() && isTextSkillFile(entry.name)) {
        const item = skillFromFile(fullPath, toPosixPath(entry.name), 'user');
        if (item) skills.push(item);
      }
    }
  }

  if (options.donauSkillDir && fs.existsSync(options.donauSkillDir)) {
    const skillPath = path.join(options.donauSkillDir, 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      const item = skillFromFile(skillPath, 'donau-hpc.md', 'donau');
      if (item) skills.push({ ...item, filename: 'donau-hpc' });
    }
    const refs = path.join(options.donauSkillDir, 'references');
    if (fs.existsSync(refs)) {
      collectSkillFiles(refs, refs, 'donau', skills);
    }
  }

  if (options.lsfSkillDir && fs.existsSync(options.lsfSkillDir)) {
    const skillPath = path.join(options.lsfSkillDir, 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      const item = skillFromFile(skillPath, 'lsf-ncpgr.md', 'lsf');
      if (item) skills.push({ ...item, filename: 'lsf-ncpgr' });
    }
    const refs = path.join(options.lsfSkillDir, 'references');
    if (fs.existsSync(refs)) {
      collectSkillFiles(refs, refs, 'lsf', skills);
    }
  }

  // Merge cluster skills when provided
  if (options.clusterSkills && options.clusterSkills.length > 0) {
    skills.push(...options.clusterSkills);
  }

  if (options.userSkillsDir
    && path.resolve(options.userSkillsDir) !== path.resolve(options.skillsDir)
    && fs.existsSync(options.userSkillsDir)) {
    collectSkillFiles(options.userSkillsDir, options.userSkillsDir, 'user', skills);
  }

  const index = {
    generatedAt: new Date().toISOString(),
    skills: skills.sort((a, b) => a.filename.localeCompare(b.filename)),
  };

  const indexPath = options.indexPath || path.join(options.skillsDir, '.skill-index.json');
  try {
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  } catch {
    // Index cache is an optimization; route responses can still use the in-memory index.
  }
  return index;
}

/** 目录树下最新的文件修改时间（用于缓存失效判定；目录不存在返回 0） */
function newestMtimeMs(root: string): number {
  let newest = 0;
  if (!fs.existsSync(root)) return 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.skill-index.json') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile()) {
        const mt = fs.statSync(fullPath).mtimeMs;
        if (mt > newest) newest = mt;
      }
    }
  }
  return newest;
}

export function loadOrRefreshSkillIndex(options: SkillIndexOptions): SkillIndex {
  const indexPath = options.indexPath || path.join(options.skillsDir, '.skill-index.json');
  const cacheKey = path.resolve(indexPath);
  const now = Date.now();
  let localIndex: SkillIndex | undefined;
  const memoryCached = localIndexCache.get(cacheKey);

  if (memoryCached && now - memoryCached.checkedAt < LOCAL_INDEX_RECHECK_MS) {
    localIndex = memoryCached.index;
  }

  try {
    if (!localIndex && fs.existsSync(indexPath)) {
      // 缓存失效判定：任一技能目录里有文件比缓存更新 → 重建，否则新技能永远不被索引
      const cacheMtime = fs.statSync(indexPath).mtimeMs;
      const freshest = Math.max(
        newestMtimeMs(options.skillsDir),
        options.lsfSkillDir ? newestMtimeMs(options.lsfSkillDir) : 0,
        options.donauSkillDir ? newestMtimeMs(options.donauSkillDir) : 0,
        options.userSkillsDir ? newestMtimeMs(options.userSkillsDir) : 0,
      );
      if (freshest <= cacheMtime) {
        if (memoryCached?.index && memoryCached.indexMtime === cacheMtime) {
          memoryCached.checkedAt = now;
          localIndex = memoryCached.index;
        } else {
          const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as SkillIndex;
          if (Array.isArray(index.skills)) {
            localIndex = index;
            localIndexCache.set(cacheKey, { checkedAt: now, indexMtime: cacheMtime, index });
          }
        }
      }
    }
  } catch {
    // Fall through and rebuild.
  }

  if (!localIndex) {
    // 远程技能不能写入本地索引文件，否则每轮对话都会把整个 1958 项技能库重建一遍。
    localIndex = refreshSkillIndex({ ...options, clusterSkills: undefined });
    let indexMtime = 0;
    try { indexMtime = fs.statSync(indexPath).mtimeMs; } catch { /* writable cache is optional */ }
    localIndexCache.set(cacheKey, { checkedAt: now, indexMtime, index: localIndex });
  }

  const clusterSkills = options.clusterSkills;
  if (!clusterSkills || clusterSkills.length === 0) return localIndex;

  const mergedCached = mergedClusterCache.get(localIndex);
  if (mergedCached?.clusterSkills === clusterSkills) return mergedCached.index;

  const byFilename = new Map(localIndex.skills.map(skill => [skill.filename, skill]));
  for (const skill of clusterSkills) byFilename.set(skill.filename, skill);
  const merged: SkillIndex = {
    generatedAt: new Date().toISOString(),
    skills: [...byFilename.values()].sort((a, b) => a.filename.localeCompare(b.filename)),
  };
  mergedClusterCache.set(localIndex, { clusterSkills, index: merged });
  return merged;
}

function tokenize(query: string): string[] {
  // 中文检索：连续 CJK 字符切 bigram（单字保留）；非 CJK 按分隔符切词。
  // 旧实现把 CJK 拆成单字后又过滤掉 length<=1 的 token，导致中文查询恒为空。
  const terms: string[] = [];
  const cjkRun = /[一-鿿㐀-䶿぀-ヿ豈-﫿]+/g;
  const pushLatin = (text: string) => {
    for (const tok of text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
      const t = tok.trim();
      if (t.length > 1) terms.push(t);
    }
  };
  let last = 0;
  for (const m of query.matchAll(cjkRun)) {
    pushLatin(query.slice(last, m.index));
    const run = m[0];
    if (run.length === 1) {
      terms.push(run);
    } else {
      for (let i = 0; i < run.length - 1; i++) terms.push(run.slice(i, i + 2));
    }
    last = (m.index ?? 0) + run.length;
  }
  pushLatin(query.slice(last));
  return terms;
}

export function scoreSkill(skill: SkillMetadata, query: string): number {
  const terms = tokenize(query);
  if (terms.length === 0) return 0;

  const filename = skill.filename.toLowerCase();
  const name = skill.name.toLowerCase();
  const desc = skill.description.toLowerCase();
  const tags = skill.tags.join(' ').toLowerCase();
  const content = `${skill.trigger || ''}\n${skill.excerpt}`.toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (filename.includes(term)) score += 8;
    if (name.includes(term)) score += 7;
    if (tags.includes(term)) score += 6;
    if (desc.includes(term)) score += 4;
    if (content.includes(term)) score += 2;
  }
  if (skill.source === 'imported') score += 1;
  return score;
}

export function searchSkillIndex(index: SkillIndex, query: string, limit = 5): SkillMetadata[] {
  return index.skills
    .map(skill => ({ ...skill, score: scoreSkill(skill, query) }))
    .filter(skill => (skill.score || 0) > 0)
    .sort((a, b) => (b.score || 0) - (a.score || 0) || a.filename.localeCompare(b.filename))
    .slice(0, limit);
}

export function formatSkillSearchResults(results: SkillMetadata[], maxSnippetChars = 3000): string[] {
  return results.map(skill => {
    const snippet = (skill.excerpt || skill.content).slice(0, maxSnippetChars);
    return `[${skill.filename}]\n${snippet}${(skill.excerpt || skill.content).length > maxSnippetChars ? '\n...(truncated)' : ''}`;
  });
}

// ── Bible Chunking ──

export interface BibleChunk {
  chapter: string;
  content: string;
  tokenCount: number;
  relevanceScore: number;
}


// Cluster skill parser. Works from content strings, not the local filesystem.

export function skillFromContent(
  relativePath: string,
  raw: string,
  source: SkillMetadata['source'],
  size: number,
): SkillMetadata | null {
  try {
    const parsed = matter(raw);
    const filename = normalizeSkillFilename(relativePath, source);
    const name = String(parsed.data.name || path.basename(filename) || filename);
    const description = String(parsed.data.description || parsed.data.summary || cleanExcerpt(parsed.content, 240)).slice(0, 500);
    return {
      filename,
      name,
      description,
      tags: normalizeTags(parsed.data.tags),
      trigger: parsed.data.trigger ? String(parsed.data.trigger) : undefined,
      category: categoryFor(relativePath, source),
      content: raw,
      excerpt: cleanExcerpt(parsed.content),
      size,
      isSystem: false,
      source,
      sourcePath: source === 'cluster' ? `cluster:~/trace_skills/${relativePath}` : relativePath,
      dependsOn: Array.isArray(parsed.data.depends_on) ? parsed.data.depends_on.map(String) : undefined,
      relatedTo: Array.isArray(parsed.data.related_to) ? parsed.data.related_to.map(String) : undefined,
      usedWith: Array.isArray(parsed.data.used_with) ? parsed.data.used_with.map(String) : undefined,
      solves: Array.isArray(parsed.data.solves) ? parsed.data.solves.map(String) : undefined,
    };
  } catch {
    return null;
  }
}

export function buildBibleChunks(content: string): BibleChunk[] {
  const body = content.replace(/^---[\s\S]*?---\s*/, '').trim();
  const sections = body.split(/^## /m);
  const chunks: BibleChunk[] = [];

  for (const section of sections) {
    if (!section.trim()) continue;
    const newlineIdx = section.indexOf('\n');
    const chapter = newlineIdx > 0 ? section.slice(0, newlineIdx).trim() : section.trim();
    const text = newlineIdx > 0 ? section.slice(newlineIdx + 1).trim() : '';
    if (!text) continue;

    chunks.push({
      chapter,
      content: `## ${chapter}\n${text}`,
      tokenCount: estimateTokenCount(text),
      relevanceScore: 0,
    });
  }

  return chunks;
}

function estimateTokenCount(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3040 && code <= 0x30FF)) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk / 1.5) + Math.ceil(other / 4);
}

export function searchBibleChunks(chunks: BibleChunk[], query: string, limit = 3): BibleChunk[] {
  const terms = tokenize(query);
  if (terms.length === 0) return chunks.slice(0, limit);

  const scored = chunks.map(chunk => {
    const lower = chunk.content.toLowerCase();
    let score = 0;
    for (const term of terms) {
      const count = lower.split(term).length - 1;
      score += count * 5;
      if (chunk.chapter.toLowerCase().includes(term)) score += 10;
    }
    return { ...chunk, relevanceScore: score };
  });

  const matched = scored.filter(c => c.relevanceScore > 0);
  if (matched.length > 0) return matched.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, limit);

  // No matches — return first chunks sorted by token count so the caller can
  // fit at least some general context into its budget.
  return [...scored].sort((a, b) => a.tokenCount - b.tokenCount).slice(0, limit);
}
