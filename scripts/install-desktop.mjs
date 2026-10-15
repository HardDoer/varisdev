import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import process from 'node:process';
import {dirname, join} from 'node:path';
import {fileURLToPath, URL} from 'node:url';
import {applyLinuxSandboxFix} from './linux-sandbox.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const npm = join(
  dirname(require.resolve('npm/package.json')),
  'bin/npm-cli.js',
);

// Keep the app's runtime separate from modules provided by an extension host.
function run(args, cwd) {
  const result = spawnSync(process.execPath, args, {cwd, stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Electron 44 downloads lazily when required. Install its executable now so
// first launch works offline and never blocks an extension host on a download.
run([require.resolve('electron/install.js')], root);
if (process.platform === 'linux')
  await applyLinuxSandboxFix(require('electron'));

const desktop = fileURLToPath(new URL('../desktop/', import.meta.url));
run(
  [
    npm,
    'ci',
    '--global=false',
    '--prefix',
    desktop,
    '--omit=dev',
    '--legacy-peer-deps',
    '--no-audit',
    '--no-fund',
  ],
  desktop,
);
run(
  [require.resolve('typescript/bin/tsc'), '--project', 'tsconfig.desktop.json'],
  root,
);
