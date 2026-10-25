import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {runRuntimeCommand} from '../src/runtime/manager.ts';

void test('desktop preparation supplies Node to nested npm lifecycle scripts when an older updater omits it from PATH', async t => {
  const root = await mkdtemp(join(tmpdir(), 'varisdev-prepare space-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const put = async (path: string, contents: string) => {
    await mkdir(dirname(join(root, path)), {recursive: true});
    await writeFile(join(root, path), contents);
  };
  for (const path of [
    'scripts/install-desktop.mjs',
    'src/runtime/environment.mjs',
    'src/runtime/node-version.mjs',
  ]) {
    await put(
      path,
      await readFile(new URL(`../${path}`, import.meta.url), 'utf8'),
    );
  }
  await put('package.json', JSON.stringify({type: 'module'}));
  // Keep downloads, Pi patching and compilation outside this installer check.
  await put(
    'scripts/linux-sandbox.mjs',
    'export async function applyLinuxSandboxFix() {}',
  );
  await put(
    'scripts/configure-pi.mjs',
    'export async function configureBundledPi() {}',
  );
  await put(
    'node_modules/electron/package.json',
    JSON.stringify({main: 'index.js'}),
  );
  await put('node_modules/electron/index.js', "module.exports = 'unused';");
  await put('node_modules/electron/install.js', '');
  await put('node_modules/typescript/bin/tsc', '');
  await symlink(
    fileURLToPath(new URL('../node_modules/npm', import.meta.url)),
    join(root, 'node_modules/npm'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await put(
    'desktop/package.json',
    JSON.stringify({
      name: 'desktop-lifecycle-fixture',
      version: '1.0.0',
      scripts: {postinstall: 'node lifecycle.cjs'},
    }),
  );
  await put(
    'desktop/lifecycle.cjs',
    "require('node:fs').writeFileSync('lifecycle.json', JSON.stringify({node: process.execPath, custom: process.env.VARISDEV_TEST_CUSTOM}));",
  );
  const env: NodeJS.ProcessEnv = {...process.env};
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key];
  }
  const tools = join(root, 'tools');
  await mkdir(tools);
  if (process.platform !== 'win32') await symlink('/bin/sh', join(tools, 'sh'));
  env.PATH =
    process.platform === 'win32'
      ? join(process.env.SystemRoot || 'C:\\Windows', 'System32')
      : tools;
  env.VARISDEV_TEST_CUSTOM = 'preserved';
  const desktop = join(root, 'desktop');
  await runRuntimeCommand(
    process.execPath,
    [
      join(root, 'node_modules/npm/bin/npm-cli.js'),
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--offline',
      '--no-audit',
      '--no-fund',
    ],
    {cwd: desktop, env, timeoutMs: 10000},
  );
  await runRuntimeCommand(
    process.execPath,
    [join(root, 'scripts/install-desktop.mjs')],
    {
      cwd: root,
      env,
      timeoutMs: 10000,
    },
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(desktop, 'lifecycle.json'), 'utf8')),
    {
      node: process.execPath,
      custom: 'preserved',
    },
  );
});
