import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import process from 'node:process';
import {dirname, join} from 'node:path';
import {fileURLToPath, URL} from 'node:url';

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
