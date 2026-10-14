import {spawnSync} from 'node:child_process';
import process from 'node:process';
import {fileURLToPath, URL} from 'node:url';

// Pi supplies the extension's peers. Electron needs its own SDK on disk,
// installed here during `pi install` and `pi update`.
const npm = process.env.npm_execpath;
if (!npm)
  throw new Error('Desktop dependencies must be installed through npm.');
const result = spawnSync(
  process.execPath,
  [npm, 'ci', '--omit=dev', '--legacy-peer-deps'],
  {
    cwd: fileURLToPath(new URL('../desktop/', import.meta.url)),
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
