import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import * as asar from '@electron/asar';

if (process.platform !== 'darwin' || !process.env.CI) throw new Error('Run the Mac package smoke test only on the isolated CI runner');
const output = path.resolve(`release-mac-${process.arch}`);
const app = path.join(output, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'TRACE.app');
const resources = path.join(app, 'Contents', 'Resources');
const bundledNode = path.join(resources, 'app.asar.unpacked', 'vendor', 'node-runtime', 'node');
const dshBin = path.join(resources, 'app.asar.unpacked', 'vendor', 'dsh', 'lib', 'bin.js');
assert(fs.existsSync(bundledNode), 'Packaged standalone Node missing');
const archive = path.join(resources, 'app.asar');
const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
const frontend = asar.listPackage(archive).filter(name => /dist[\\/]assets[\\/].*\.js$/.test(name)).map(name => asar.extractFile(archive, name.replace(/^[\\/]/, '')).toString('utf8')).join('\n');
if (Number(packaged.version.split('.')[2]) >= 51) {
  assert(frontend.includes('records · complete history'));
  assert(frontend.includes('Expand execution details'));
  assert(frontend.includes('Validating outputs automatically'));
  assert(!asar.listPackage(archive).some(name => /[\\/]qa[\\/]/.test(name)));
  assert(asar.extractFile(archive, path.join('third-party', 'elkjs', 'LICENSE.md')).length > 0);
}
const cli = spawnSync(bundledNode, [dshBin, '--help'], { encoding: 'utf8', timeout: 60000 });
assert.equal(cli.status, 0, cli.stderr);
const port = await new Promise(resolve => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
});
const appEnv = { ...process.env, PORT: String(port), TRACE_WEB_MODE: '', TRACE_HOST: '' };
delete appEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(path.join(app, 'Contents', 'MacOS', 'TRACE'), [], {
  env: appEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', value => { log += value; });
child.stderr.on('data', value => { log += value; });
const exited = new Promise(resolve => child.once('exit', resolve));
try {
  let ready = false;
  for (let index = 0; index < 120; index++) {
    try {
      // The public liveness route is callable without the random per-boot desktop token.
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) { ready = true; break; }
    } catch {}
    if (child.exitCode !== null) throw new Error('Packaged Mac app exited: ' + log.slice(-4000));
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert(ready, 'Packaged Mac app backend did not start: ' + log.slice(-4000));
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/app-info`)).status, 403);
  const html = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(html.status, 200);
  assert((await html.text()).includes('/assets/index-'));
  console.log('[mac smoke] Packaged Electron backend, frontend and bundled DSH CLI passed:', process.arch);
} finally {
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
  if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
}
