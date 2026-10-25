// Add verified platform assets to the existing release; never replace its Windows installer/feed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error('GITHUB_TOKEN is required');
const directory = path.resolve(process.argv[2] || 'platform-artifacts');
const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const tag = process.env.TRACE_RELEASE_TAG || 'v' + version;
const prefix = 'TRACE-' + tag.slice(1) + '-';
const repository = 'peacezha/TRACE';
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'trace-platform-release' };
const response = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${tag}`, { headers });
let release;
if (response.ok) release = await response.json();
else if (response.status === 404) {
  const listed = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=100`, { headers });
  if (!listed.ok) throw new Error('Could not list draft releases: ' + listed.status);
  const drafts = (await listed.json()).filter(item => item.tag_name === tag && item.draft);
  if (drafts.length !== 1) throw new Error('Expected exactly one matching draft release');
  release = drafts[0];
} else throw new Error('Existing release not found: ' + response.status);
const files = fs.readdirSync(directory).filter(name => name.startsWith(prefix)
  && /^(?:mac-(?:arm64|x64)\.(?:dmg|zip)|web-linux-x64\.tar\.gz(?:\.sha256)?|public-web-linux-x64-node20\.tar\.gz(?:\.sha256)?|platforms-[\w.-]+\.json)$/.test(name.slice(prefix.length)));
for (const needed of [prefix + 'mac-arm64.dmg', prefix + 'mac-x64.dmg']) {
  if (!files.includes(needed)) throw new Error('Incomplete platform build: ' + needed);
}
const hashes = new Map();
for (const name of files) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(path.join(directory, name))) hash.update(chunk);
  hashes.set(name, hash.digest('hex'));
}
const sumsName = prefix + 'platforms-SHA256SUMS.txt';
fs.writeFileSync(path.join(directory, sumsName), [...hashes].map(([name, hash]) => `${hash}  ${name}`).join('\n') + '\n');
hashes.set(sumsName, crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, sumsName))).digest('hex'));
files.push(sumsName);
for (const name of files) {
  const file = path.join(directory, name);
  const size = fs.statSync(file).size;
  const existing = release.assets.find(asset => asset.name === name);
  if (existing) {
    if (existing.size === size && existing.digest === `sha256:${hashes.get(name)}`) { console.log('already verified:', name); continue; }
    throw new Error('Refusing to overwrite a different existing release asset: ' + name);
  }
  const upload = await fetch(release.upload_url.replace(/\{.*$/, '') + '?name=' + encodeURIComponent(name), {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
    body: Readable.toWeb(fs.createReadStream(file)), duplex: 'half',
  });
  if (!upload.ok) throw new Error(`Upload failed: ${name} HTTP ${upload.status}`);
  const asset = await upload.json();
  if (asset.state !== 'uploaded' || asset.size !== size || asset.digest !== `sha256:${hashes.get(name)}`) {
    throw new Error('Uploaded asset checksum or size mismatch: ' + name);
  }
  console.log('uploaded and verified:', name, size);
}
const heading = '## Mac 安装包与 Linux 网页部署（扩展发布）';
if (!release.body?.includes(heading)) {
  const body = (release.body || '') + '\n\n' + heading + '\n\n'
    + '- Apple 芯片：' + prefix + 'mac-arm64.dmg；Intel：' + prefix + 'mac-x64.dmg。未配置 Apple 签名/公证；首次打开须按系统提示确认，当前手动更新。\n'
    + (files.includes(prefix + 'web-linux-x64.tar.gz') ? '- Linux 私有网页部署：' + prefix + 'web-linux-x64.tar.gz，单用户工作台；面向大众请用 public-web 包。\n' : '')
    + '- Linux 公共网页部署：' + prefix + 'public-web-linux-x64-node20.tar.gz，Node.js 20 部署包。\n'
    + '- [安装与部署说明](https://github.com/peacezha/TRACE/blob/main/docs/MAC_WEB_DEPLOYMENT.md)。公网须使用 HTTPS 或 SSH 隧道。\n'
    + '- Windows 安装包和 latest.yml 保持不变；附平台产物 SHA-256 与构建来源。\n';
  const updated = await fetch(`https://api.github.com/repos/${repository}/releases/${release.id}`, {
    method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ body, tag_name: tag, target_commitish: release.target_commitish }),
  });
  if (!updated.ok) throw new Error('Release notes update failed: ' + updated.status);
}
console.log('Platform release completed:', release.html_url);
