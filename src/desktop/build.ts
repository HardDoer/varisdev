import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));

/** Build in Pi's installed package, independently of the active project. */
export async function buildDesktop(signal?: AbortSignal): Promise<void> {
  try {
    await promisify(execFile)(
      process.execPath,
      [
        require.resolve('typescript/bin/tsc'),
        '--project',
        join(root, 'tsconfig.desktop.json'),
      ],
      {cwd: root, maxBuffer: 1024 * 1024, signal},
    );
  } catch (error) {
    signal?.throwIfAborted();
    const failure = error as Error & {stdout?: string; stderr?: string};
    // tsc writes diagnostics to stdout; execFile's message only includes stderr.
    const details = [failure.stdout, failure.stderr].filter(Boolean).join('\n');
    throw new Error(
      `Desktop build failed:\n${details.trim() || failure.message}`,
      {cause: error},
    );
  }
}
