import assert from 'node:assert/strict';
import {access, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {runRuntimeCommand} from '../src/runtime/manager.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

void test(
  'the release package builds with only production dependencies outside the checkout',
  {timeout: 360_000},
  async t => {
    // Prevent TypeScript from finding development dependencies in the checkout.
    const temporary = await mkdtemp(
      join(tmpdir(), 'varisdev-production-build-'),
    );
    t.after(() => rm(temporary, {recursive: true, force: true, maxRetries: 5}));
    const run = (args: string[], cwd: string, timeoutMs: number) =>
      runRuntimeCommand(process.execPath, args, {
        cwd,
        env: process.env,
        timeoutMs,
      });
    const release = join(temporary, 'release');
    await run(['scripts/release-web.mjs', release], root, 30_000);
    const {version, revision} = JSON.parse(
      await readFile(join(release, 'latest.json'), 'utf8'),
    ) as {version: string; revision: string};
    const prefix = join(temporary, 'installation');
    const directory = join(
      prefix,
      process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
      'varisdev',
    );
    // Skip installation hooks so this check needs no Electron download or display.
    await run(
      [
        join(root, 'node_modules/npm/bin/npm-cli.js'),
        'install',
        '--global=true',
        '--prefix',
        prefix,
        '--omit=dev',
        '--legacy-peer-deps',
        '--ignore-scripts',
        '--prefer-offline',
        '--no-audit',
        '--no-fund',
        join(release, `varisdev-${version}-${revision}.tgz`),
      ],
      temporary,
      120_000,
    );
    const npm = join(directory, 'node_modules/npm/bin/npm-cli.js');
    const desktop = join(directory, 'desktop');
    await run(
      [
        npm,
        'ci',
        '--global=false',
        '--prefix',
        desktop,
        '--omit=dev',
        '--legacy-peer-deps',
        '--ignore-scripts',
        '--prefer-offline',
        '--no-audit',
        '--no-fund',
      ],
      desktop,
      120_000,
    );
    await assert.rejects(access(join(directory, 'node_modules/gts')), {
      code: 'ENOENT',
    });
    await run([npm, 'run', 'desktop:build'], directory, 60_000);
    for (const entry of ['desktop/main.js', 'runtime/cli.js'])
      await access(join(directory, 'desktop/build/src', entry));
  },
);
