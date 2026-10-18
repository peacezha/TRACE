import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import type { SkillIndex } from './types';
import { refreshSkillIndex } from './skillIndex';

export type SkillInstallSource =
  | { type: 'local'; path?: string; filename?: string; content?: string }
  | { type: 'url'; url: string }
  | { type: 'git'; url: string; ref?: string; subdir?: string };

export interface SkillInstallOptions {
  /** Bundled read-only system skill directory. */
  skillsDir: string;
  lsfSkillDir?: string;
  donauSkillDir?: string;
  /** Writable user-data skill directory. */
  userSkillsDir?: string;
  /** @deprecated compatibility alias for userSkillsDir. */
  appSkillsDir?: string;
}

const ALLOWED_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.toml',
  '.py', '.js', '.ts', '.sh', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.pdf',
]);

export function classifySkillSource(source: SkillInstallSource): SkillInstallSource['type'] {
  if (source.type === 'git') return 'git';
  if (source.type === 'url') return 'url';
  return 'local';
}

export function slugifySource(value: string): string {
  const slug = value
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .pop()
    ?.replace(/\.(git|zip|tar|tgz|gz|md|txt)$/i, '') || 'skill';
  return slug.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'skill';
}

export function assertSafeArchivePath(entryPath: string): void {
  const normalized = path.posix.normalize(entryPath.replace(/\\/g, '/'));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../') || path.isAbsolute(normalized)) {
    throw new Error(`Unsafe archive path: ${entryPath}`);
  }
}

function ensureUniqueDir(parent: string, slug: string): string {
  fs.mkdirSync(parent, { recursive: true });
  let candidate = path.join(parent, slug);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(parent, `${slug}-${index}`);
    index++;
  }
  fs.mkdirSync(candidate, { recursive: true });
  return candidate;
}

function isAllowedFile(filePath: string): boolean {
  return ALLOWED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function copyAllowedTree(sourceDir: string, targetDir: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const src = path.join(sourceDir, entry.name);
    const dst = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      count += copyAllowedTree(src, dst);
    } else if (entry.isFile() && isAllowedFile(entry.name)) {
      fs.copyFileSync(src, dst);
      count++;
    }
  }
  return count;
}

async function extractArchive(archivePath: string, targetDir: string): Promise<number> {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith('.zip')) {
    const zip = new AdmZip(archivePath);
    let count = 0;
    for (const entry of zip.getEntries()) {
      assertSafeArchivePath(entry.entryName);
      if (entry.isDirectory) continue;
      if (!isAllowedFile(entry.entryName)) continue;
      const target = path.join(targetDir, entry.entryName);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.getData());
      count++;
    }
    return count;
  }

  let count = 0;
  await tar.x({
    file: archivePath,
    cwd: targetDir,
    filter: (entryPath, entry) => {
      assertSafeArchivePath(entryPath);
      if (process.env.TRACE_PUBLIC_WORKER === '1' && !['File', 'Directory'].includes((entry as { type?: string }).type || '')) return false;
      const allowed = isAllowedFile(entryPath);
      if (allowed) count++;
      return allowed;
    },
  });
  return count;
}

async function downloadFile(url: string, target: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(target, buffer);
}

function runGitClone(url: string, targetDir: string, ref?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['clone', '--depth', '1'];
    if (ref) args.push('--branch', ref);
    args.push(url, targetDir);
    const child = spawn('git', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `git clone failed with exit code ${code}`));
    });
  });
}

export async function installSkillFromSource(
  source: SkillInstallSource,
  options: SkillInstallOptions,
): Promise<{ success: true; installedPath: string; fileCount: number; index: SkillIndex }> {
  if (process.env.TRACE_PUBLIC_WORKER === '1' && (source.type === 'git' || source.type === 'local' && !source.content)) {
    throw new Error('公共网页不读取部署服务器本地技能或执行 Git；请使用技能文本或 HTTPS 归档链接');
  }
  const writableRoot = options.userSkillsDir || options.appSkillsDir || options.skillsDir;
  const importedRoot = path.join(writableRoot, 'imported');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-skill-'));
  let installedPath = '';
  let fileCount = 0;

  try {
    if (source.type === 'local' && source.content) {
      const slug = slugifySource(source.filename || 'local-skill');
      installedPath = ensureUniqueDir(importedRoot, slug);
      const filename = (source.filename || 'SKILL.md').replace(/[^a-zA-Z0-9_.-]/g, '-') || 'SKILL.md';
      fs.writeFileSync(path.join(installedPath, filename.endsWith('.md') ? filename : `${filename}.md`), source.content);
      fileCount = 1;
    } else if (source.type === 'local' && source.path) {
      const sourcePath = path.resolve(source.path);
      if (!fs.existsSync(sourcePath)) throw new Error(`Local source not found: ${source.path}`);
      installedPath = ensureUniqueDir(importedRoot, slugifySource(sourcePath));
      const stats = fs.statSync(sourcePath);
      if (stats.isDirectory()) {
        fileCount = copyAllowedTree(sourcePath, installedPath);
      } else if (/\.(zip|tar|tgz|tar\.gz)$/i.test(sourcePath)) {
        fileCount = await extractArchive(sourcePath, installedPath);
      } else if (isAllowedFile(sourcePath)) {
        fs.copyFileSync(sourcePath, path.join(installedPath, path.basename(sourcePath)));
        fileCount = 1;
      } else {
        throw new Error('Unsupported local skill file type');
      }
    } else if (source.type === 'url') {
      const slug = slugifySource(source.url);
      installedPath = ensureUniqueDir(importedRoot, slug);
      const archivePath = path.join(tempRoot, path.basename(new URL(source.url).pathname) || 'skill.zip');
      await downloadFile(source.url, archivePath);
      fileCount = await extractArchive(archivePath, installedPath);
    } else if (source.type === 'git') {
      const slug = slugifySource(source.url);
      installedPath = ensureUniqueDir(importedRoot, slug);
      const cloneDir = path.join(tempRoot, 'repo');
      await runGitClone(source.url, cloneDir, source.ref);
      const tree = source.subdir ? path.join(cloneDir, source.subdir) : cloneDir;
      if (!fs.existsSync(tree)) throw new Error(`Git subdir not found: ${source.subdir}`);
      fileCount = copyAllowedTree(tree, installedPath);
    } else {
      throw new Error('Invalid skill install source');
    }

    if (fileCount === 0) throw new Error('No supported skill files were installed');

    const index = refreshSkillIndex({
      skillsDir: options.skillsDir,
      lsfSkillDir: options.lsfSkillDir,
      donauSkillDir: options.donauSkillDir,
      userSkillsDir: writableRoot,
      indexPath: path.join(writableRoot, '.skill-index.json'),
    });
    return { success: true, installedPath, fileCount, index };
  } catch (error) {
    if (installedPath && fs.existsSync(installedPath)) {
      fs.rmSync(installedPath, { recursive: true, force: true });
    }
    throw error;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
