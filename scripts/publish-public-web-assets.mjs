import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error('Missing GitHub token');
const directory = path.resolve(process.argv[2] || 'public-web-artifacts');
const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const archiveName = `TRACE-${version}-public-web-linux-x64-node20.tar.gz`;
const names = [archiveName, archiveName + '.sha256'];
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'trace-public-web-release', 'X-GitHub-Api-Version': '2022-11-28' };
const base = 'https://api.github.com/repos/peacezha/TRACE/releases';
const response = await fetch(base + '/tags/v' + version, { headers });
let release;
if (response.ok) release = await response.json();
else if (response.status === 404) {
  const listed = await fetch(base + '?per_page=100', { headers });
  if (!listed.ok) throw new Error('Could not list draft releases: ' + listed.status);
  const drafts = (await listed.json()).filter(item => item.tag_name === 'v' + version && item.draft);
  if (drafts.length !== 1) throw new Error('Expected exactly one matching draft release');
  release = drafts[0];
} else throw new Error('Existing release unavailable: ' + response.status);
for (const name of names) {
  const file = path.join(directory, name);
  const size = fs.statSync(file).size;
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const existing = release.assets.find(asset => asset.name === name);
  if (existing) {
    if (existing.size === size && existing.digest === `sha256:${hash}`) continue;
    throw new Error('Refusing to replace an existing different asset: ' + name);
  }
  const upload = await fetch(release.upload_url.replace(/\{.*$/, '') + '?name=' + encodeURIComponent(name), {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
    body: Readable.toWeb(fs.createReadStream(file)), duplex: 'half',
  });
  if (!upload.ok) throw new Error('Upload failed: ' + upload.status);
  const asset = await upload.json();
  if (asset.state !== 'uploaded' || asset.size !== size || asset.digest !== `sha256:${hash}`) throw new Error('Uploaded checksum mismatch');
  console.log('Uploaded and checksum verified:', name, size);
}
const heading = '## 公共网页 Node.js 20 兼容更新';
if (!release.body?.includes(heading)) {
  const body = (release.body || '') + '\n\n' + heading + '\n\n'
    + '- 新包：' + archiveName + '。最低 Node.js 20.19.5，仍支持 Node.js 22；包含 v0.5.15 的桌面认证、提交防重、调度器、传输、敏感配置与完整答复修复。\n'
    + '- 解压后运行 `npm ci --omit=dev --ignore-scripts`，再 `npm start -- --url https://你的域名`。公网须配置 HTTPS 反向代理。\n'
    + '- [公共网页部署说明](https://github.com/peacezha/TRACE/blob/main/docs/PUBLIC_WEB_DEPLOYMENT.md)。旧 web-linux-x64 包是单用户版，不能移除口令后直接公开。\n'
    + '- 公共网页按访客隔离工作进程，私人对话和配置保存在用户自己的集群；不开放部署服务器本地命令。Node.js 20 已结束官方维护，长期公网部署建议使用受支持的 LTS。\n';
  const updated = await fetch(base + '/' + release.id, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ body, tag_name: 'v' + version, target_commitish: release.target_commitish }) });
  if (!updated.ok) throw new Error('Release notes update failed: ' + updated.status);
}
console.log('Public web assets published:', release.html_url);
