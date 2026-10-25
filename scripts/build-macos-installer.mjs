import fs from 'node:fs';
import path from 'node:path';
import { build, Platform, Arch } from 'electron-builder';
import { fileURLToPath } from 'node:url';

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
      ...(signed ? {} : { identity: '-' }),
      // codesign must not be invoked for every text file in the bundled DSH dependency tree.
      // Keep the architecture-specific PTY native binary and spawn-helper signed.
      signIgnore: [`app\\.asar\\.unpacked/vendor/dsh/(?!node_modules/node-pty/prebuilds/darwin-${arch}/(?:pty\\.node|spawn-helper)$)`],
      hardenedRuntime: signed,
      notarize: signed && Boolean(process.env.APPLE_API_KEY || process.env.APPLE_ID),
    },
    dmg: { title: `TRACE ${pkg.version}` },
    publish: null,
  },
});
console.log(`[mac] ${pkg.version} ${arch} built; Apple signed: ${signed}. Unsigned builds require manual updates.`);
