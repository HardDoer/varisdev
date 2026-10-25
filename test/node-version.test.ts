import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {runRuntimeCommand} from '../src/runtime/manager.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'varisdev-node-version-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  async function put(relative: string, contents: string) {
    const path = join(root, relative);
    await mkdir(dirname(path), {recursive: true});
    await writeFile(path, contents);
    return path;
  }
  await put('package.json', '{"type":"module"}');
  for (const relative of [
    'bin/varisdev.mjs',
    'src/runtime/node-version.mjs',
    'scripts/install-desktop.mjs',
    'scripts/desktop-app.mjs',
    'assets/desktop/app-main.cjs',
    'assets/desktop/windows-main.cjs',
    'assets/desktop/windows-install.cjs',
  ])
    await put(
      relative,
      await readFile(new URL(`../${relative}`, import.meta.url), 'utf8'),
    );
  // Use the JS form shipped by the desktop build, which older Node can parse.
  for (const relative of ['src/desktop/main', 'src/runtime/headless'])
    await put(
      `${relative}.js`,
      await readFile(new URL(`../${relative}.ts`, import.meta.url), 'utf8'),
    );
  await put(
    'install.mjs',
    await readFile(
      new URL('../src/runtime/distribution.mjs', import.meta.url),
      'utf8',
    ),
  );
  // Linking this module fails before any module bodies run. A static import
  // ahead of the guard would therefore hide the Node requirement.
  const incompatible = "import {varisdevMissingExport} from 'node:util';\n";
  for (const relative of [
    'src/runtime/environment.mjs',
    'src/runtime/settings.mjs',
    'scripts/linux-sandbox.mjs',
    'scripts/configure-pi.mjs',
    'desktop/build/src/runtime/manager.js',
    'desktop/build/src/runtime/cli.js',
  ])
    await put(relative, incompatible);
  await put(
    'node_modules/electron/index.js',
    "throw new Error('Electron imported before the Node guard');",
  );
  return {root, put};
}

const entries = [
  'bin/varisdev.mjs',
  'scripts/install-desktop.mjs',
  'scripts/desktop-app.mjs',
  'src/desktop/main.js',
  'src/runtime/headless.js',
  'assets/desktop/app-main.cjs',
  'assets/desktop/windows-main.cjs',
  'assets/desktop/windows-install.cjs',
  'install.mjs',
];

async function rejectsOldNode(
  root: string,
  executable: string,
  prefix: string[] = [],
) {
  for (const entry of entries)
    await assert.rejects(
      runRuntimeCommand(executable, [...prefix, join(root, entry)], {
        cwd: root,
        env: process.env,
        timeoutMs: 5000,
      }),
      error => {
        assert.match(String(error), /failed \(1\)/, entry);
        assert.match(String(error), /VarisDev requires Node 24\+/, entry);
        assert.doesNotMatch(
          String(error),
          /varisdevMissingExport|Electron imported|ERR_UNKNOWN_FILE_EXTENSION|SyntaxError/,
          entry,
        );
        return true;
      },
    );
}

void test(
  'launchers reject unsupported Node before linking application imports',
  {timeout: 30000},
  async t => {
    const f = await fixture(t);
    for (const major of [18, 23]) {
      const preload = await f.put(
        `node-${major}.cjs`,
        `Object.defineProperty(process.versions, 'node', {value: '${major}.0.0'});`,
      );
      await rejectsOldNode(f.root, process.execPath, ['--require', preload]);
    }
  },
);

void test(
  'installed entrypoints reject an actual older Node binary',
  {
    timeout: 30000,
    skip:
      !process.env.VARISDEV_TEST_OLD_NODE &&
      'Set VARISDEV_TEST_OLD_NODE to an older Node executable',
  },
  async t => {
    const executable = process.env.VARISDEV_TEST_OLD_NODE!;
    const version = await runRuntimeCommand(executable, ['--version'], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5000,
    });
    assert.ok(Number.parseInt(version.trim().slice(1), 10) < 24, version);
    const f = await fixture(t);
    await rejectsOldNode(f.root, executable);
  },
);

void test(
  'supported Node proceeds through the installed CLI bootstrap',
  {timeout: 10000},
  async t => {
    const f = await fixture(t);
    await f.put(
      'src/runtime/environment.mjs',
      'export async function initializeEnvironment() {}',
    );
    await f.put(
      'desktop/build/src/runtime/manager.js',
      `export class RuntimeManager { async currentRoot() { return ${JSON.stringify(f.root)}; } }`,
    );
    await f.put(
      'desktop/build/src/runtime/cli.js',
      "export async function runCli() { console.log('supported-node-ready'); return 0; }",
    );
    assert.match(
      await runRuntimeCommand(
        process.execPath,
        [join(f.root, 'bin/varisdev.mjs')],
        {
          cwd: f.root,
          env: process.env,
          timeoutMs: 5000,
        },
      ),
      /supported-node-ready/,
    );
  },
);
