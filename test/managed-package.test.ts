import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {cp, mkdtemp, readFile, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);

void test(
  'managed production install builds and opens the desktop without checkout dependencies',
  {timeout: 180_000},
  async t => {
    // Outside the checkout: Node and TypeScript cannot find its node_modules.
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-package-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    for (const name of [
      '.npmrc',
      'package.json',
      'package-lock.json',
      'tsconfig.desktop.json',
      'desktop/package.json',
      'desktop/package-lock.json',
      'src',
      'extensions',
      'scripts',
      'assets',
      'themes',
    ]) {
      await cp(join(root, name), join(directory, name), {recursive: true});
    }
    const npm = process.env.npm_execpath;
    assert.ok(npm, 'Run this installation check through npm test.');
    // Match Pi's Git install, including the package's postinstall script.
    await run(
      process.execPath,
      [npm, 'install', '--omit=dev', '--offline', '--no-audit', '--no-fund'],
      {
        cwd: directory,
        maxBuffer: 1024 * 1024,
        env: {...process.env, npm_config_offline: 'true'},
      },
    );
    const manifest = JSON.parse(
      await readFile(join(directory, 'package.json'), 'utf8'),
    );
    for (const name of Object.keys(manifest.peerDependencies)) {
      assert.equal(manifest.peerDependencies[name], '*');
      assert.equal(manifest.dependencies[name], undefined);
      await assert.rejects(access(join(directory, 'node_modules', name)), {
        code: 'ENOENT',
      });
      await access(join(directory, 'desktop/node_modules', name));
    }
    const {buildDesktop} = (await import(
      pathToFileURL(join(directory, 'src/desktop/build.ts')).href
    )) as {
      buildDesktop(): Promise<void>;
    };
    await buildDesktop();
    // Exercise the entire session runtime import graph, even without a display.
    await run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(pathToFileURL(join(directory, 'desktop/build/src/dashboard/parent.js')).href)})`,
      ],
      {cwd: directory},
    );
    const env = {...process.env, PI_TEST_PACKAGE_DIR: directory};
    delete (env as NodeJS.ProcessEnv).NODE_TEST_CONTEXT;
    const result = await run(
      process.execPath,
      [
        '--test',
        '--test-reporter=tap',
        join(root, 'test/desktop-startup.test.ts'),
      ],
      {
        cwd: directory,
        env,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.match(result.stdout, /# fail 0/);
  },
);
