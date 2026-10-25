import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build, Platform, Arch } from 'electron-builder';
import { signApp } from '@electron/osx-sign';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

// @electron/osx-sign probes every file concurrently before applying signIgnore.
// Move the large text-only DSH tree out during the ad-hoc pass, then restore it
// and sign only its two native PTY files before sealing the app again.
async function signAdHocWithoutDsh(configuration) {
  const app = configuration.app;
  const dsh = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'vendor', 'dsh');
  const backup = path.join(path.dirname(app), 'TRACE-dsh-signing-backup');
  if (!fs.existsSync(dsh)) return signApp(configuration);
  await fs.promises.rename(dsh, backup);
  try {
    await signApp(configuration);
    await fs.promises.rename(backup, dsh);
    const nativeDir = path.join(dsh, 'node_modules', 'node-pty', 'prebuilds', `darwin-${arch}`);
    for (const file of ['pty.node', 'spawn-helper']) {
      const binary = path.join(nativeDir, file);
      if (fs.existsSync(binary)) await execFileAsync('codesign', ['--sign', '-', '--force', binary]);
    }
    const options = configuration.optionsForFile?.(app) || {};
    const args = ['--sign', '-', '--force'];
    if (options.hardenedRuntime) args.push('--options', 'runtime');
    if (options.entitlements) args.push('--entitlements', options.entitlements);
    await execFileAsync('codesign', [...args, app]);
    await execFileAsync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  } finally {
    if (fs.existsSync(backup)) await fs.promises.rename(backup, dsh);
  }
}

if (process.platform !== 'darwin') throw new Error('DMG must be built on macOS; use the GitHub macOS packaging workflow');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const arch = process.arch;
if (!['arm64', 'x64'].includes(arch)) throw new Error('Unsupported Mac architecture');
if (!fs.existsSync(path.join(root, 'vendor/node-runtime/node'))) throw new Error('Run npm run prepare:platform first');
const files = pkg.build.files.filter(file => !file.includes('node-pty/prebuilds/darwin-'));
files.push('!vendor/node-runtime/node.exe', '!vendor/**/*.exe', '!vendor/**/*.dll',
  '!vendor/dsh/node_modules/node-pty/build/**/*', '!vendor/dsh/node_modules/node-pty/third_party/**/*',
  '!vendor/dsh/node_modules/node-pty/prebuilds/win32-*/**/*',
  '!vendor/dsh/node_modules/node-pty/prebuilds/linux-*/**/*',
  `!vendor/dsh/node_modules/node-pty/prebuilds/darwin-${arch === 'arm64' ? 'x64' : 'arm64'}/**/*`,
  '!vendor/dsh/node_modules/**/*win32*/**/*');
const signed = Boolean(process.env.CSC_LINK);
await build({
  targets: Platform.MAC.createTarget(['dmg', 'zip'], arch === 'arm64' ? Arch.arm64 : Arch.x64),
  config: {
    files,
    directories: { output: `release-mac-${arch}` },
    mac: {
      category: 'public.app-category.productivity',
      artifactName: 'TRACE-${version}-mac-${arch}.${ext}',
      // An ad-hoc signature preserves Apple Silicon executable integrity, but is not Developer ID / notarization.
      ...(signed ? {} : { identity: '-', sign: signAdHocWithoutDsh }),
      hardenedRuntime: signed,
      notarize: signed && Boolean(process.env.APPLE_API_KEY || process.env.APPLE_ID),
    },
    dmg: { title: `TRACE ${pkg.version}` },
    publish: null,
  },
});
console.log(`[mac] ${pkg.version} ${arch} built; Apple signed: ${signed}. Unsigned builds require manual updates.`);
