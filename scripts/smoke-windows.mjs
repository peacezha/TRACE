import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as asar from '@electron/asar';
const expectedVersion = process.env.TRACE_SMOKE_VERSION || '0.4.43';
const resources = path.resolve(process.env.TRACE_SMOKE_RESOURCES || 'release-v0.4.43-final/win-unpacked/resources');
const archive = path.join(resources, 'app.asar');
const packagedNode = path.join(resources, 'app.asar.unpacked/vendor/node-runtime/node.exe');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-package-smoke-'));
const appRoot = path.join(temporary, 'app');
const dataRoot = path.join(temporary, 'data');
for (const entry of asar.listPackage(archive)) {
  const filename = entry.replaceAll('\\', '/').replace(/^\//, '');
  if (!(filename === 'package.json' || /^(?:electron\/|dist\/|dist-electron\/|skills\/|lsf_skills\/|pipelines\/|demo-assets\/|node_modules\/(?:ssh2|asn1|safer-buffer|bcrypt-pbkdf|tweetnacl)\/)/.test(filename))) continue;
  const archivePath = path.normalize(filename);
  const stat = asar.statFile(archive, archivePath);
  if (stat.files || stat.link) continue;
  const target = path.join(appRoot, filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, asar.extractFile(archive, archivePath));
}
const packagedPackage = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
assert.equal(packagedPackage.version, expectedVersion);
if (Number(expectedVersion.split('.')[2]) >= 53) {
  assert.equal(packagedPackage.productName, 'TRACE');
  assert.equal(packagedPackage.name, 'trace');
  const updater = fs.readFileSync(path.join(appRoot, 'electron/update-manager.cjs'), 'utf8');
  assert(updater.includes("repo: 'TRACE'"));
  assert(fs.readFileSync(path.join(appRoot, 'dist/index.html'), 'utf8').includes('<title>TRACE</title>'));
  const { resolveDesktopIdentity } = await import(pathToFileURL(path.join(appRoot, 'electron/app-identity.cjs')).href);
  const old = path.join(temporary, 'legacy-data', 'HPClaw');
  const identity = resolveDesktopIdentity({ appData: path.dirname(old), platform: 'win32', exists: p => p === old });
  assert.equal(identity.userData, path.join(path.dirname(old), 'TRACE'));
  assert.equal(identity.runtimeName, 'TRACE');
  console.log('Packaged TRACE naming, renamed update repository and legacy data compatibility verified.');
}
const backend = fs.readFileSync(path.join(appRoot, 'dist-electron/server.cjs'), 'utf8');
if (Number(expectedVersion.split('.')[2]) >= 56) {
  const frontend = fs.readdirSync(path.join(appRoot, 'dist/assets')).filter(file => file.endsWith('.js')).map(file => fs.readFileSync(path.join(appRoot, 'dist/assets', file), 'utf8')).join('\n');
  for (const marker of ['traceDesktop', 'trace_flows', 'trace_uploads', 'trace_agent_settings']) assert(frontend.includes(marker), marker);
  for (const marker of ['TRACE_DATA_ROOT', 'X-TRACE-Bridge', 'trace_conversations', 'trace-dsh-plugin', 'TRACE_REPORT_LANGUAGE']) assert(backend.includes(marker), marker);
  for (const marker of ['hpclawDesktop', 'hpclaw:locale:', 'application/x-hpclaw-files', 'HPCLAW_REVIEW_REQUIRED']) assert(!frontend.includes(marker), marker);
  assert(!asar.listPackage(archive).some(filename => /(?:^|[\\/])(?:electron|pipelines|skills|lsf_skills)[\\/]/.test(filename)
    && /hpclaw.*\.py|electron[\\/].*\.test\.[cm]?[jt]sx?$|skills[\\/]\.skill-index\.json/i.test(filename)));
  const { migrateDesktopProfile } = await import(pathToFileURL(path.join(appRoot, 'electron/app-identity.cjs')).href);
  const profileRoot = path.join(temporary, 'profile-upgrade');
  fs.mkdirSync(path.join(profileRoot, 'HPClaw'), { recursive: true });
  fs.writeFileSync(path.join(profileRoot, 'HPClaw', 'profiles.json'), 'isolated-encrypted-bytes');
  const migrated = migrateDesktopProfile({ appData: profileRoot, platform: 'win32' });
  assert.equal(fs.readFileSync(path.join(migrated.userData, 'profiles.json'), 'utf8'), 'isolated-encrypted-bytes');
  assert(fs.existsSync(path.join(profileRoot, 'HPClaw', 'profiles.json')));
  assert(fs.readFileSync(path.join(appRoot, 'electron/preload.cjs'), 'utf8').includes("'traceDesktop'"));
  const plugin = fs.readFileSync(path.join(resources, 'app.asar.unpacked/vendor/dsh-plugin/package.json'), 'utf8');
  assert.equal(JSON.parse(plugin).name, 'trace-dsh-plugin');
  console.log('Packaged complete TRACE namespaces, new folder/report/plugin names and lossless profile upgrade verified; no production profile touched.');
}
if (Number(expectedVersion.split('.')[2]) >= 55) {
  for (const marker of ['TRACE_CLARIFICATION_ONLY', 'TRACE_REPEAT_QUESTION_BLOCKED', 'TRACE_VAGUE_CHOICE_BLOCKED',
    'TRACE_BACKGROUND_JOB', 'clarification_read_only', 'timeoutDiagnostics', '15-minute active-execution limit']) assert(backend.includes(marker), marker);
  const frontend = fs.readdirSync(path.join(appRoot, 'dist/assets')).filter(file => file.endsWith('.js')).map(file => fs.readFileSync(path.join(appRoot, 'dist/assets', file), 'utf8')).join('\n');
  assert(frontend.includes('Explain options first'));
  assert(frontend.includes('未授权执行'));
  const plugin = fs.readFileSync(path.join(resources, 'app.asar.unpacked/vendor/dsh-plugin/index.js'), 'utf8');
  assert(plugin.includes('Deprecated compatibility parameter'));
  assert(!plugin.includes('wait: 5-10'));
  assert(plugin.includes('所有后台作业'));
  console.log('Packaged clarification/no-consent handling, repeated-question guard, immediate background submission and active-execution timeout diagnostics verified.');
}
if (Number(expectedVersion.split('.')[2]) >= 54) {
  const main = fs.readFileSync(path.join(appRoot, 'electron/main.cjs'), 'utf8');
  const editing = fs.readFileSync(path.join(appRoot, 'electron/editing.cjs'), 'utf8');
  assert(main.includes('editingController.refreshMenu()'));
  assert(main.includes('autoHideMenuBar: true'));
  for (const role of ['copy', 'paste', 'cut', 'selectAll']) assert(editing.includes("role: '" + role + "'"));
  assert(editing.includes('before-input-event'));
  assert(fs.readFileSync(path.join(appRoot, 'electron/preload.cjs'), 'utf8').includes('trace:editing-focus'));
  const frontend = fs.readdirSync(path.join(appRoot, 'dist/assets')).filter(file => file.endsWith('.js')).map(file => fs.readFileSync(path.join(appRoot, 'dist/assets', file), 'utf8')).join('\n');
  assert(frontend.includes('How do I prepare my data? (Formats, templates and AI assistance)'));
  assert(frontend.includes('Copy template'));
  assert(frontend.includes('data-shortcut-scope'));
  assert(backend.includes('.catalogue-cleanup-v0.4.54.json'));
  console.log('Packaged native Edit-menu restoration, pane-scoped keyboard routing and explicit English data-preparation guide verified.');
}
if (Number(expectedVersion.split('.')[2]) >= 51) {
  const frontend = fs.readdirSync(path.join(appRoot, 'dist/assets')).filter(file => file.endsWith('.js')).map(file => fs.readFileSync(path.join(appRoot, 'dist/assets', file), 'utf8')).join('\n');
  assert(frontend.includes('records · complete history'));
  assert(frontend.includes('Expand execution details'));
  assert(frontend.includes('Validating outputs automatically'));
  assert(!fs.existsSync(path.join(appRoot, 'dist/qa/chat-continuity.html')));
  assert(backend.includes('Engine availability could not be verified'));
  console.log('Packaged full conversation view, automatic output review and safe background wake code verified; QA fixture is not shipped.');
}
if (Number(expectedVersion.split('.')[2]) >= 49) {
  assert(backend.includes('pending_disposal'));
  assert(backend.includes('deleted-definitions'));
  const frontend = fs.readdirSync(path.join(appRoot, 'dist/assets')).filter(file => file.endsWith('.js')).map(file => fs.readFileSync(path.join(appRoot, 'dist/assets', file), 'utf8')).join('\n');
  assert(frontend.includes('Pending disposal'));
  assert(frontend.includes('Confirm definition deletion'));
  assert(frontend.includes('Restore to saved workflows'));
  console.log('Packaged pending-disposal, bilingual actions and definition backup code verified.');
}
if (Number(expectedVersion.split('.')[2]) >= 48) {
  assert(backend.includes('invalid_question_answer'));
  assert(backend.includes('question_no_longer_pending'));
  assert(backend.includes('optionDetails'));
  const frontend = fs.readdirSync(path.join(appRoot, 'dist/assets')).filter(file => file.endsWith('.js')).map(file => fs.readFileSync(path.join(appRoot, 'dist/assets', file), 'utf8')).join('\n');
  assert(frontend.includes('ai-question-dialog'));
  assert(frontend.includes('The agent needs your answer'));
  assert(frontend.includes('Answer later'));
  assert(frontend.includes('Answer delivery is unverified'));
  assert(frontend.includes('Select one or more options'));
  assert(frontend.includes('/api/ai/question'));
  console.log('Packaged question dialog, structured answer, expiry receipt and delivery safeguards verified.');
}
if (Number(expectedVersion.split('.')[2]) >= 47) {
  assert(backend.includes('confirm_resolved'));
  if (Number(expectedVersion.split('.')[2]) < 51) assert(backend.includes('TRACE display truncated'));
  else assert(!backend.includes('TRACE display truncated'));
  assert(backend.includes('This was not a user rejection.'));
  const plugin = fs.readFileSync(path.join(resources, 'app.asar.unpacked/vendor/dsh-plugin/index.js'), 'utf8');
  assert(plugin.includes("approval.setPolicy(exec.agent, 'ask')"));
  assert(plugin.includes('authoritative server FIRST'));
  const frontend = fs.readdirSync(path.join(appRoot, 'dist/assets')).filter(file => file.endsWith('.js')).map(file => fs.readFileSync(path.join(appRoot, 'dist/assets', file), 'utf8')).join('\n');
  assert(frontend.includes('Approval delivery is unverified'));
  assert(frontend.includes('Approval delivered. Awaiting the actual execution result.'));
  console.log('Packaged approval receipts and one-shot rejection safeguards verified.');
}
assert(backend.includes('Step batch truncated: '));
assert(backend.includes('Download failed after 3 attempts: '));
if (Number(expectedVersion.split('.')[2]) >= 44) {
  assert(backend.includes('session.history'));
  assert(backend.includes('DSH history recovery limit reached; output not verified'));
  assert(backend.includes('no automatic rerun was attempted'));
  const readableBackend = backend.replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
  assert(readableBackend.includes('查不到不等于 DONE 也不等于失败'));
  assert(backend.includes('This turn was not resubmitted'));
  assert(backend.includes('authoritative'));
  // electron-builder strips its development-only build configuration from app.asar.
  const builderDebug = fs.readFileSync(path.resolve(resources, '../../builder-debug.yml'), 'utf8');
  assert(builderDebug.includes('MUI_LANGUAGE "English"'));
  assert(builderDebug.includes('MUI_LANGUAGE "SimpChinese"'));
  const sourcePackage = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(sourcePackage.version, expectedVersion);
  // v0.5.2 起安装器不再弹语言选择框(提权会弹两遍),改用系统区域设置自动定语言;
  // 双语 MUI_LANGUAGE 仍需保留(安装界面本地化),displayLanguageSelector 必须为 false/缺省。
  assert.notEqual(sourcePackage.build.nsis.displayLanguageSelector, true);
  const { createLocaleStore } = await import(pathToFileURL(path.join(appRoot, 'electron/locale-store.cjs')).href);
  const installDir = path.join(temporary, 'isolated-install');
  fs.mkdirSync(installDir);
  fs.writeFileSync(path.join(installDir, Number(expectedVersion.split('.')[2]) >= 53 ? 'trace-install-locale.json' : 'trace-install-locale.json'), JSON.stringify({ locale: 'en-US' }));
  const locale = createLocaleStore({ installDir, userData: dataRoot });
  assert.equal(locale.get(), 'en-US');
  locale.set('zh-CN');
  assert.equal(createLocaleStore({ installDir, userData: dataRoot }).get(), 'zh-CN');
  assert(fs.readFileSync(path.join(appRoot, 'electron/preload.cjs'), 'utf8').includes('trace:locale:set'));
  console.log('Packaged Windows language seed, persistent override, IPC and DSH recovery code verified.');
}
if (Number(expectedVersion.split('.')[2]) >= 45) {
  assert(backend.includes('REMOTE_REPORT_AMBIGUOUS'));
  assert(backend.includes('Report not found in the supplied project directories'));
  const frontend = fs.readdirSync(path.join(appRoot, 'dist/assets')).filter(file => file.endsWith('.js')).map(file => fs.readFileSync(path.join(appRoot, 'dist/assets', file), 'utf8')).join('\n');
  assert(frontend.includes('High-quality alignment filtering and PCR duplicate removal'));
  assert(frontend.includes('Source section: '));
  assert(frontend.includes('basePaths'));
  console.log('Packaged report path resolution and reviewed workflow translations verified.');
}
const dsh = spawnSync(packagedNode, [path.join(resources, 'app.asar.unpacked/vendor/dsh/lib/bin.js'), '--help'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
if (Number(expectedVersion.split('.')[2]) >= 46) {
  assert(backend.includes('acknowledgeFailedQc'));
  assert(backend.includes('qcCriteria'));
  assert(backend.includes('Workflow submission blocked'));
  const frontend = fs.readdirSync(path.join(appRoot, 'dist/assets')).filter(file => file.endsWith('.js')).map(file => fs.readFileSync(path.join(appRoot, 'dist/assets', file), 'utf8')).join('\n');
  assert(frontend.includes('QC failed: poor quality; downstream analysis is not recommended'));
  assert(frontend.includes('Acknowledge risk and continue'));
  assert(frontend.includes('workflow-qc-notice'));
  console.log('Packaged QC pause guard, retained failure acknowledgement and bilingual warnings verified.');
}
assert.equal(dsh.status, 0, JSON.stringify({ stderr: dsh.stderr, error: dsh.error?.message, signal: dsh.signal }));
const port = await new Promise(resolve => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const child = spawn(packagedNode, [path.join(appRoot, 'dist-electron/server.cjs')], {
  cwd: appRoot, windowsHide: true, stdio: ['ignore','pipe','pipe'], env: { ...process.env, NODE_ENV: 'production',
    PORT: String(port), TRACE_APP_ROOT: appRoot, TRACE_STATIC_ROOT: appRoot, TRACE_DATA_ROOT: dataRoot,
    TRACE_HOST: '127.0.0.1', TRACE_WEB_MODE: '', TRACE_AI_ENGINE: 'legacy', TRACE_PARENT_PID: String(process.pid),
    TRACE_DESKTOP_TOKEN: 'isolated-package-smoke-only', TRACE_PUBLIC_WORKER: '', TRACE_WEB_ACCESS_ENABLED: '' },
});
let log = '';
child.stdout.on('data', data => { log += data; });
child.stderr.on('data', data => { log += data; });
const exited = new Promise(resolve => child.once('exit', resolve));
let modelServer;
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error('Packaged backend exited: ' + log.slice(-3000));
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/api/app-info', {
        headers: { 'X-TRACE-Desktop-Token': 'isolated-package-smoke-only' },
      });
      if (response.ok) { assert((await response.json()).capabilities.cluster); ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert(ready, 'Packaged backend did not start: ' + log.slice(-3000));
  const unauthenticated = await fetch('http://127.0.0.1:' + port + '/api/app-info');
  assert.equal(unauthenticated.status, 403, 'Desktop API must reject requests without a desktop token');
  const html = await fetch('http://127.0.0.1:' + port + '/');
  assert.equal(html.status, 200);
  assert((await html.text()).includes('/assets/index-'));
  if (Number(expectedVersion.split('.')[2]) >= 49) {
    const catalogue = async (url, method = 'GET', body) => {
      const response = await fetch('http://127.0.0.1:' + port + '/api/workflows' + url, { method,
        headers: { 'Content-Type': 'application/json', 'X-TRACE-Desktop-Token': 'isolated-package-smoke-only' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result = await response.json();
      assert(response.ok, JSON.stringify(result));
      return result;
    };
    const initial = (await catalogue('')).workflows;
      const cleanedCatalogue = Number(expectedVersion.split('.')[2]) >= 54;
      if (cleanedCatalogue) {
        for (const id of ['bioskills-hic-pipeline', 'bioskills-clip-pipeline', 'bioskills-causal-genomics-pipeline', 'bioskills-crispr-editing-pipeline', 'builtin-dapseq-tf-en', 'encode-chipseq-histone-en', 'encode-atacseq-en']) assert(!initial.some(w => w.id === id));
        for (const id of ['bioskills-atacseq-pipeline', 'bioskills-chipseq-pipeline']) assert.equal(initial.find(w => w.id === id)?.lifecycle?.state, 'active');
        assert(!initial.some(w => w.lifecycle?.state === 'pending_disposal'));
        assert(initial.some(w => w.id === 'encode-hic'));
        assert(initial.some(w => w.id === 'encode-eclip'));
        console.log('Packaged v0.4.54 requested cleanup verified; retained workflows active, no pending definitions and independent ENCODE pipelines preserved.');
      }
      for (const id of cleanedCatalogue ? [] : ['builtin-dapseq-tf-en', ...(Number(expectedVersion.split('.')[2]) < 52 ? ['encode-chipseq-tf-en'] : []), 'encode-chipseq-histone-en', 'encode-atacseq-en', ...(Number(expectedVersion.split('.')[2]) < 50 ? ['encode-chipseq-tf-dag'] : [])]) {
        assert.equal(initial.find(workflow => workflow.id === id)?.lifecycle?.state, 'pending_disposal');
      }
      if (Number(expectedVersion.split('.')[2]) >= 50) {
        const dag = initial.find(workflow => workflow.id === 'encode-chipseq-tf-dag');
        assert.notEqual(dag.lifecycle?.state, 'pending_disposal');
        assert.equal(dag.provenance.importerVersion, 'chipseq-dag-v2');
        assert(dag.steps.some(step => step.dependsOn?.length > 1));
        assert(fs.existsSync(path.join(appRoot, 'pipelines/encode/chipseq_dag.py')));
      }
      if (Number(expectedVersion.split('.')[2]) >= 52) {
        assert(!initial.some(workflow => ['encode-chipseq-tf', 'encode-chipseq-tf-en'].includes(workflow.id)));
        const dap = initial.find(workflow => workflow.id === 'builtin-dapseq-tf');
        assert.equal(dap.steps[6].id, 'idr');
        assert(dap.steps[7].command.includes('idr/final/*.peaks.final.bed'));
        assert(fs.existsSync(path.join(appRoot, 'pipelines/encode/dapseq_idr.py')));
      }
    const id = 'encode-atacseq';
    const original = initial.find(workflow => workflow.id === id);
    const moved = (await catalogue('/' + id + '/lifecycle', 'PATCH', { state: 'pending_disposal', reason: 'isolated-smoke-fixture' })).workflow;
    assert.deepEqual(moved.steps, original.steps);
    assert.equal(moved.lifecycle.reason, 'isolated-smoke-fixture');
    assert(!(await catalogue('/match', 'POST', { query: 'atacseq' })).matches.some(workflow => workflow.id === id));
    const restored = (await catalogue('/' + id + '/lifecycle', 'PATCH', { state: 'active' })).workflow;
    assert.equal(restored.lifecycle.origin, 'user');
    assert.deepEqual(restored.steps, original.steps);
    const created = (await catalogue('', 'POST', { name: 'isolated-catalogue-fixture', keywords: ['isolatedcatalogue'],
      steps: [{ title: 'No execution', command: 'echo isolated-catalogue-fixture' }] })).workflow;
    const deletedBuiltin = Number(expectedVersion.split('.')[2]) >= 54 ? 'builtin-blast' : 'encode-atacseq-en';
    const deletedIds = [created.id, deletedBuiltin];
    for (const deletedId of deletedIds) await catalogue('/' + deletedId, 'DELETE');
    assert(!(await catalogue('')).workflows.some(workflow => deletedIds.includes(workflow.id)));
    const stored = JSON.parse(fs.readFileSync(path.join(dataRoot, 'workflows/workflows.json'), 'utf8'));
    assert.equal(stored.find(workflow => workflow.id === id)?.lifecycle?.state, 'active');
    assert(!stored.some(workflow => deletedIds.includes(workflow.id)));
    const backupDir = path.join(dataRoot, 'workflows/deleted-definitions');
    const backups = fs.readdirSync(backupDir).filter(file => fs.statSync(path.join(backupDir, file)).isFile()).map(file => JSON.parse(fs.readFileSync(path.join(backupDir, file), 'utf8')));
    assert.deepEqual(backups.map(workflow => workflow.id).sort(), deletedIds.sort());
    assert(JSON.parse(fs.readFileSync(path.join(dataRoot, 'workflows/deleted-builtin-seeds.json'), 'utf8')).includes(deletedBuiltin));
    console.log('Packaged real catalogue API passed: conservative migration, archive/restore, recommendation exclusion, builtin/user deletion and persistent backups; no SSH session or job created.');
  }
  if (Number(expectedVersion.split('.')[2]) >= 48) {
    const question = async body => fetch('http://127.0.0.1:' + port + '/api/ai/question', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TRACE-Desktop-Token': 'isolated-package-smoke-only' }, body: JSON.stringify(body) });
    assert.equal((await question({ answer: 'fixture' })).status, 400);
    assert.equal((await question({ id: 'fixture', cancelled: 'false' })).status, 400);
    const missing = await question({ id: 'isolated-missing-question', answer: { selected: [], custom: 'fixture' } });
    assert.equal(missing.status, 409); assert.equal((await missing.json()).reason, 'unavailable');
    console.log('Packaged real question endpoint rejects invalid and stale IDs without accepting an answer or starting a task.');
  }
  if (Number(expectedVersion.split('.')[2]) >= 55) {
    let explanationRequests = 0;
    modelServer = http.createServer(async (request, response) => {
      try {
        let body = ''; for await (const chunk of request) body += chunk;
        const value = JSON.parse(body);
        assert(JSON.stringify(value.messages).includes('TRACE_CLARIFICATION_ONLY'));
        assert(!(value.tools || []).some(tool => /ask_user|write|edit|set_plan/.test(tool.function?.name || '')));
        explanationRequests++;
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const frame = (delta, finish_reason = null) => 'data: ' + JSON.stringify({ id: 'isolated-agent-fixture',
          object: 'chat.completion.chunk', created: 1, model: value.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
        response.end(frame({ role: 'assistant', content: 'ISOLATED_OPTIONS_EXPLAINED: inspect the existing BAM before choosing a recovery; no command was executed.' })
          + frame({}, 'stop') + 'data: [DONE]\n\n');
      } catch (err) { response.writeHead(500); response.end(String(err)); }
    });
    await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
    const response = await fetch('http://127.0.0.1:' + port + '/api/ai/stream', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TRACE-Desktop-Token': 'isolated-package-smoke-only' },
      body: JSON.stringify({ mode: 'agent', locale: 'zh-CN', workspace: temporary,
        agentConfig: { engine: 'native', planningPolicy: 'auto', confirmationPolicy: 'always' },
        messages: [{ role: 'assistant', content: '❓ 如何修复并继续？' }, { role: 'user', content: '有哪些修复方案？' }],
        profile: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'isolated-fixture-only',
          baseUrl: 'http://127.0.0.1:' + modelServer.address().port + '/v1' } }), signal: AbortSignal.timeout(60_000) });
    assert.equal(response.status, 200);
    const stream = await response.text();
    const events = stream.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    assert(events.some(event => event.type === 'done' && event.content.includes('ISOLATED_OPTIONS_EXPLAINED')), JSON.stringify(events).slice(-2000));
    assert(!events.some(event => ['ask', 'confirm', 'error', 'tool_call'].includes(event.type)), JSON.stringify(events).slice(-2000));
    assert.equal(explanationRequests, 1);
    modelServer.closeAllConnections(); await new Promise(resolve => modelServer.close(resolve)); modelServer = undefined;
    console.log('Packaged real AI stream passed the screenshot explanation follow-up: one local mock model request, no repeated question, command, approval or external AI call.');
  }
  if (process.env.TRACE_SMOKE_SKIP_NETWORK === '1') {
    console.log('Live literature-metadata network probe skipped explicitly (not counted as passed).');
  } else {
  const sentences = ['Reads were cleaned using fastp (version 0.20.0) with minimum length 20.',
    'Reads were mapped using BWA (version 0.7.17-r1188).', 'Peaks were called using MACS2 (version 2.2.6).'];
  const paperText = 'Methods\n' + sentences.join(' ') + '\nData availability\n'
    + 'Raw data were deposited under GSE192815 for use by the research community. '
    + 'The associated metadata describe samples and sequencing runs for this study.';
  let modelRequests = 0, batches = 0;
  modelServer = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const value = JSON.parse(body);
    assert.equal(value.reasoning_effort, 'none');
    assert.equal(value.model, 'deepseek-flash');
    modelRequests++;
    const prompt = value.messages.at(-1).content;
    let output, truncated = false;
    if (prompt.includes('STAGE: OUTLINE')) output = { name: 'Isolated model fixture, not a real analysis',
      steps: sentences.map((sentence, index) => ({ title: ['QC','Mapping','Peaks'][index], evidenceIds: ['E' + (index + 1)], agent: { evidence: sentence } })) };
    else if (prompt.includes('STAGE: STEPS')) {
      batches++;
      const nodes = JSON.parse(prompt.split('【本批节点与原文】\n')[1].split('\n【已声明参数】')[0]);
      truncated = batches === 1;
      output = { params: [{ name: 'OUTPUT_DIR', label: 'Fixture output', type: 'path', required: true }],
        steps: nodes.slice(0, truncated ? 2 : nodes.length).map(node => ({ ...node,
          command: 'echo isolated-model-fixture > {{OUTPUT_DIR}}/fixture-' + node.id + '.txt',
          agent: { ...node.agent, kind: 'compute', sourceType: 'paper', confidence: 'high',
            inputs: ['raw_data_manifest.tsv'], outputs: ['fixture-' + node.id + '.txt'] } })) };
    } else output = { stepsMentioned: sentences.map((sentence, index) => ({ id: 'E' + (index + 1), what: ['QC','Mapping','Peaks'][index], sentence })) };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: 'fixture', created: 1, model: 'deepseek-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: truncated ? 'length' : 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  const learned = await fetch('http://127.0.0.1:' + port + '/api/workflows/learn', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TRACE-Desktop-Token': 'isolated-package-smoke-only' },
    body: JSON.stringify({ paperText, profile: { provider: 'deepseek', model: 'deepseek-flash',
      apiKey: 'isolated-fixture-only', baseUrl: 'http://127.0.0.1:' + modelServer.address().port + '/v1' } }),
    signal: AbortSignal.timeout(60000),
  });
  const learnedBody = await learned.json();
  assert.equal(learned.status, 200, JSON.stringify(learnedBody).slice(0, 1000));
  assert.equal(learnedBody.draft.steps.length, 4, JSON.stringify({
    stepTitles: learnedBody.draft.steps.map(step => step.title), paperImport: learnedBody.paperImport,
  }).slice(0, 4500));
  assert.equal(learnedBody.paperImport.rawData.length, 196);
  assert(learnedBody.draft.steps[0].command.includes('urllib.request.urlopen'));
  assert(learnedBody.draft.steps.some(step => step.title === 'Peaks'));
  assert.equal(batches, 2);
  assert.equal(modelRequests, 4);
  console.log('Packaged literature-learning API passed with real 196-run metadata and local model fixture: truncation retried, all three analysis nodes and real downloader retained; no paid model or raw downloads.');
  }
  console.log('Windows v' + expectedVersion + ' packaged backend, frontend and DSH CLI verified in isolated data directory.');
} finally {
  if (modelServer) { modelServer.closeAllConnections(); await new Promise(resolve => modelServer.close(resolve)); }
  child.kill();
  await exited;
  console.log('Isolated smoke fixtures retained at ' + temporary);
}
