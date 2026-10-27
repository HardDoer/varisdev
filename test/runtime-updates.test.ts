import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import fs, {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {
  defaultDataDir,
  RuntimeManager,
  runRuntimeCommand,
  type RuntimeHooks,
  type RuntimeManagerOptions,
  type UpdateStatus,
} from '../src/runtime/manager.ts';

const sdk = '@earendil-works/pi-coding-agent';
const execute = promisify(execFile);
const initialRevision = 'a'.repeat(40);
const nextRevision = 'b'.repeat(40);
const runtimeHelpers = ['environment.mjs', 'node-version.mjs'] as const;
async function updateReady(manager: RuntimeManager): Promise<void> {
  const state = await manager.update();
  assert.equal(state.phase, 'ready', state.error);
}
async function put(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, contents);
}
async function appFiles(
  root: string,
  version: string,
  sdkVersion: string,
): Promise<void> {
  await put(
    join(root, 'package.json'),
    JSON.stringify({name: 'varisdev', type: 'module', version}),
  );
  for (const name of runtimeHelpers)
    await put(
      join(root, 'src/runtime', name),
      await readFile(
        new URL(`../src/runtime/${name}`, import.meta.url),
        'utf8',
      ),
    );
  await put(
    join(root, 'src/dashboard/parent.ts'),
    `export const version = '${version}';`,
  );
  await put(
    join(root, 'desktop/node_modules', sdk, 'package.json'),
    JSON.stringify({version: sdkVersion}),
  );
  await put(
    join(root, 'node_modules/npm/package.json'),
    '{"exports":{"./package.json":"./package.json"}}',
  );
  await put(join(root, 'node_modules/npm/bin/npm-cli.js'), '');
  await put(
    join(root, 'node_modules/app-dependency/package.json'),
    JSON.stringify({version}),
  );
  for (const name of [
    'bin/varisdev.mjs',
    'assets/dashboard/index.html',
    'assets/desktop/preload.cjs',
    'desktop/build/src/desktop/main.js',
  ])
    await put(join(root, name), '');
  await put(
    join(root, 'desktop/build/src/dashboard/parent.js'),
    'export const ready = true;',
  );
  await put(
    join(root, 'desktop/build/src/runtime/cli.js'),
    `export async function runCli() { console.log('VarisDev ${version}'); return 0; }`,
  );
}
async function fixture(t: {after: (fn: () => Promise<void>) => void}) {
  const temp = await realpath(
    await mkdtemp(join(tmpdir(), 'varisdev-update-test-')),
  );
  const previousNodeExecutable = process.env.VARISDEV_NODE_EXECUTABLE;
  process.env.VARISDEV_NODE_EXECUTABLE = process.execPath;
  t.after(async () => {
    if (previousNodeExecutable === undefined)
      delete process.env.VARISDEV_NODE_EXECUTABLE;
    else process.env.VARISDEV_NODE_EXECUTABLE = previousNodeExecutable;
    await rm(temp, {recursive: true, force: true});
  });
  const installRoot = join(temp, 'package');
  const dataDir = join(temp, 'data');
  await appFiles(installRoot, '0.1.0', '0.85.1');
  await put(
    join(installRoot, 'build-info.json'),
    JSON.stringify({
      revision: initialRevision,
      source: 'ssh://git@github.com/HardDoer/varisdev.git',
    }),
  );
  await put(
    join(installRoot, 'bin/varisdev.mjs'),
    await readFile(new URL('../bin/varisdev.mjs', import.meta.url), 'utf8'),
  );
  await put(
    join(installRoot, 'desktop/build/src/runtime/manager.js'),
    `export {RuntimeManager} from ${JSON.stringify(new URL('../src/runtime/manager.ts', import.meta.url).href)};`,
  );
  let latest = '0.2.0';
  let revision = nextRevision;
  let offline = false;
  let failure = '';
  let environmentHelper: string | undefined;
  let installs = 0;
  let smokeImports = 0;
  const urls: string[] = [];
  const hooks: RuntimeHooks = {
    now: () => new Date('2026-10-14T12:00:00.000Z'),
    run: async (command, args, options) => {
      if (command === 'git') {
        if (args[0] === 'ls-remote') {
          urls.push(args[2]);
          if (offline) throw new Error('Network unavailable');
          return `${revision}\tHEAD\n`;
        }
        if (args[0] === 'fetch' && failure === 'git')
          throw new Error('Git fetch failed');
        if (args[0] === 'init') await appFiles(args[1], latest, '0.86.0');
        return;
      }
      assert.equal(command, process.execPath);
      if (args[0].endsWith('npm-cli.js')) {
        if (args[1] === 'pack') return;
        installs++;
        assert.deepEqual(args.slice(1), [
          'install',
          '--global=true',
          '--prefix',
          options.cwd,
          '--omit=dev',
          '--legacy-peer-deps',
          '--no-audit',
          '--no-fund',
          join(options.cwd, `varisdev-${latest}.tgz`),
        ]);
        if (failure === 'npm') throw new Error('Package installation failed');
        await delay(30);
        const root = join(
          options.cwd,
          process.platform === 'win32'
            ? 'node_modules/varisdev'
            : 'lib/node_modules/varisdev',
        );
        await appFiles(root, latest, '0.86.0');
        if (environmentHelper !== undefined)
          await put(
            join(root, 'src/runtime/environment.mjs'),
            environmentHelper,
          );
        if (failure === 'environment.mjs' || failure === 'node-version.mjs')
          await rm(join(root, 'src/runtime', failure));
        if (failure === 'compile')
          await rm(join(root, 'desktop/build'), {recursive: true});
        if (failure === 'import')
          await put(
            join(root, 'desktop/build/src/dashboard/parent.js'),
            "throw new Error('App import failed');",
          );
      } else {
        smokeImports++;
        await execute(command, args, {cwd: options.cwd, env: options.env});
      }
      return;
    },
  };
  const options: RuntimeManagerOptions = {installRoot, dataDir, hooks};
  return {
    installRoot,
    dataDir,
    temp,
    hooks,
    options,
    urls,
    manager: new RuntimeManager(options),
    get installs() {
      return installs;
    },
    get smokeImports() {
      return smokeImports;
    },
    set latest(value: string) {
      latest = value;
    },
    set revision(value: string) {
      revision = value;
    },
    set offline(value: boolean) {
      offline = value;
    },
    set failure(value: string) {
      failure = value;
    },
    set environmentHelper(value: string | undefined) {
      environmentHelper = value;
    },
  };
}

async function legacyBaseFixture(t: TestContext) {
  const f = await fixture(t);
  for (const name of runtimeHelpers)
    await rm(join(f.installRoot, 'src/runtime', name));
  await put(
    join(f.installRoot, 'bin/varisdev.mjs'),
    `#!/usr/bin/env node
import {fileURLToPath, pathToFileURL, URL} from 'node:url';
import {join} from 'node:path';
import process from 'node:process';
import console from 'node:console';
const installRoot = fileURLToPath(new URL('../', import.meta.url));
try {
  const {RuntimeManager} = await import('../desktop/build/src/runtime/manager.js');
  const root = await new RuntimeManager({installRoot}).currentRoot();
  const {runCli} = await import(pathToFileURL(join(root, 'desktop/build/src/runtime/cli.js')).href);
  process.exitCode = await runCli(process.argv.slice(2), installRoot);
} catch (error) {
  console.error(\`VarisDev: \${error.message || String(error)}\`);
  process.exitCode = 1;
}
`,
  );
  return f;
}
async function baseSnapshot(root: string) {
  return Promise.all(
    ['', ...(await readdir(root, {recursive: true})).sort()].map(async name => {
      const path = join(root, name);
      const info = await stat(path);
      return {
        name,
        mtimeMs: info.mtimeMs,
        mode: info.mode,
        contents: info.isFile() ? await readFile(path) : undefined,
      };
    }),
  );
}

const environmentFile = 'src/runtime/environment.mjs';
const legacyEnvironment = `export async function initializeEnvironment() {
  console.warn('VarisDev: Could not start Zsh to load .zshrc.');
}
`;
async function currentEnvironment(): Promise<string> {
  return readFile(
    new URL('../src/runtime/environment.mjs', import.meta.url),
    'utf8',
  );
}
async function legacyEnvironmentFixture(t: TestContext) {
  const f = await fixture(t);
  await put(join(f.installRoot, environmentFile), legacyEnvironment);
  f.environmentHelper = legacyEnvironment;
  await updateReady(f.manager);
  const active = await f.manager.currentRoot();
  assert.notEqual(active, f.installRoot);
  assert.equal(
    await readFile(join(active, environmentFile), 'utf8'),
    legacyEnvironment,
  );
  await put(join(active, environmentFile), await currentEnvironment());
  f.environmentHelper = undefined;
  return Object.assign(f, {active});
}
function restoreBuiltinMock(
  t: TestContext,
  mocked: {mock: {restore(): void}},
): () => void {
  syncBuiltinESMExports();
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    mocked.mock.restore();
    syncBuiltinESMExports();
  };
  t.after(restore);
  return restore;
}
function mockRename(t: TestContext, replacement: typeof fs.rename): () => void {
  return restoreBuiltinMock(t, t.mock.method(fs, 'rename', replacement));
}
async function assertEnvironmentCleanup(f: {
  installRoot: string;
  dataDir: string;
}) {
  assert.deepEqual(
    (await readdir(f.installRoot)).filter(name =>
      name.startsWith('.environment-'),
    ),
    [],
  );
  assert.deepEqual(
    (await readdir(f.dataDir)).filter(name => /^active-.*\.tmp$/.test(name)),
    [],
  );
  await assert.rejects(stat(join(f.dataDir, 'update.lock')), {code: 'ENOENT'});
}

void test('updates from a legacy base without helpers remain usable by its bootstrap and leave the base unchanged', async t => {
  const f = await legacyBaseFixture(t);
  const base = await baseSnapshot(f.installRoot);
  const warning = t.mock.method(console, 'warn', () => {});
  let previousRoot = f.installRoot;
  let installs = 0;
  for (const [revision, version] of [
    [nextRevision, '0.2.0'],
    ['c'.repeat(40), '0.3.0'],
  ]) {
    f.revision = revision;
    f.latest = version;
    await updateReady(f.manager);
    const active = await f.manager.currentRoot();
    assert.notEqual(active, previousRoot);
    assert.equal(await new RuntimeManager(f.options).currentRoot(), active);
    const output = await runRuntimeCommand(
      process.execPath,
      [join(f.installRoot, 'bin/varisdev.mjs'), '--version'],
      {
        cwd: f.temp,
        timeoutMs: 10_000,
        env: {...process.env, VARISDEV_DATA_DIR: f.dataDir},
      },
    );
    assert.equal(output.trim(), `VarisDev ${version}`);
    const pointer = join(f.dataDir, 'active.json');
    const selected = await readFile(pointer, 'utf8');
    const old = new Date('2020-01-01T00:00:00.000Z');
    await utimes(pointer, old, old);
    const before = await stat(pointer);
    const startup = new RuntimeManager({...f.options, runningRoot: active});
    await startup.refreshEnvironment();
    await new RuntimeManager(f.options).refreshEnvironment();
    const repeated = await startup.update();
    assert.equal(repeated.phase, 'idle', repeated.error);
    assert.equal(repeated.restartRequired, false);
    assert.equal(f.installs, ++installs);
    assert.equal(await readFile(pointer, 'utf8'), selected);
    assert.equal((await stat(pointer)).mtimeMs, before.mtimeMs);
    assert.deepEqual(await baseSnapshot(f.installRoot), base);
    assert.equal(warning.mock.callCount(), 0);
    assert.equal(await new RuntimeManager(f.options).currentRoot(), active);
    await assertEnvironmentCleanup(f);
    previousRoot = active;
  }
});

void test('an existing app generation without helpers remains selected from a legacy base', async t => {
  const f = await legacyBaseFixture(t);
  await updateReady(f.manager);
  const active = await f.manager.currentRoot();
  for (const name of runtimeHelpers)
    await rm(join(active, 'src/runtime', name));
  const pointer = join(f.dataDir, 'active.json');
  const previousPointer = await readFile(pointer, 'utf8');
  const old = new Date('2020-01-01T00:00:00.000Z');
  await utimes(pointer, old, old);
  const before = await stat(pointer);
  const warning = t.mock.method(console, 'warn', () => {});
  const startup = new RuntimeManager({...f.options, runningRoot: active});
  assert.equal(await startup.currentRoot(), active);
  await startup.refreshEnvironment();
  assert.equal(await new RuntimeManager(f.options).currentRoot(), active);
  assert.equal(warning.mock.callCount(), 0);
  assert.equal(await readFile(pointer, 'utf8'), previousPointer);
  assert.equal((await stat(pointer)).mtimeMs, before.mtimeMs);
  await assertEnvironmentCleanup(f);
});

for (const helper of runtimeHelpers) {
  void test(`a candidate missing ${helper} preserves the legacy base selection and can retry`, async t => {
    const f = await legacyBaseFixture(t);
    await updateReady(f.manager);
    const previous = await f.manager.currentRoot();
    const pointer = join(f.dataDir, 'active.json');
    const previousPointer = await readFile(pointer, 'utf8');
    f.revision = 'c'.repeat(40);
    f.latest = '0.3.0';
    f.failure = helper;
    const result = await f.manager.update();
    assert.equal(result.phase, 'error');
    assert.ok(result.error?.includes(helper), result.error);
    assert.equal(await f.manager.currentRoot(), previous);
    assert.equal(await new RuntimeManager(f.options).currentRoot(), previous);
    assert.equal(await readFile(pointer, 'utf8'), previousPointer);
    assert.deepEqual(await readdir(join(f.dataDir, 'runtimes')), [
      JSON.parse(previousPointer).generation,
    ]);
    await assertEnvironmentCleanup(f);
    f.failure = '';
    await updateReady(f.manager);
    const active = await f.manager.currentRoot();
    assert.notEqual(active, previous);
    assert.notEqual(active, f.installRoot);
    assert.equal(await new RuntimeManager(f.options).currentRoot(), active);
    assert.equal(f.manager.status().currentRevision, 'c'.repeat(40));
    for (const name of runtimeHelpers) {
      await stat(join(active, 'src/runtime', name));
      await assert.rejects(stat(join(f.installRoot, 'src/runtime', name)), {
        code: 'ENOENT',
      });
    }
    await assertEnvironmentCleanup(f);
  });
}

void test('activation refreshes a stale base environment helper and binds the new selection to it', async t => {
  const f = await fixture(t);
  await put(join(f.installRoot, environmentFile), legacyEnvironment);
  await updateReady(f.manager);
  const active = await f.manager.currentRoot();
  assert.notEqual(active, f.installRoot);
  assert.equal(
    await readFile(join(f.installRoot, environmentFile), 'utf8'),
    await currentEnvironment(),
  );
  assert.equal(await new RuntimeManager(f.options).currentRoot(), active);
  assert.equal(
    JSON.parse(await readFile(join(f.installRoot, 'package.json'), 'utf8'))
      .version,
    '0.1.0',
  );
  assert.equal(
    await readFile(join(f.installRoot, 'src/dashboard/parent.ts'), 'utf8'),
    "export const version = '0.1.0';",
  );
  await assertEnvironmentCleanup(f);
});

void test('activation with identical helpers rejects a base source edit before committing the pointer', async t => {
  const f = await fixture(t);
  await updateReady(f.manager);
  const active = await f.manager.currentRoot();
  const pointer = join(f.dataDir, 'active.json');
  const previousPointer = await readFile(pointer, 'utf8');
  const helper = await readFile(join(f.installRoot, environmentFile), 'utf8');
  assert.equal(await readFile(join(active, environmentFile), 'utf8'), helper);
  f.revision = 'c'.repeat(40);
  const edited = join(f.installRoot, 'src/dashboard/parent.ts');
  const write = fs.writeFile;
  let changed = false;
  const restore = restoreBuiltinMock(
    t,
    t.mock.method(
      fs,
      'writeFile',
      async (...args: Parameters<typeof fs.writeFile>) => {
        await write(...args);
        if (String(args[0]).startsWith(join(f.dataDir, 'active-'))) {
          changed = true;
          await write(edited, 'External edit before pointer commit');
        }
      },
    ),
  );
  try {
    const result = await f.manager.update();
    assert.equal(result.phase, 'error');
    assert.match(result.error || '', /app files changed/);
  } finally {
    restore();
  }
  assert.equal(changed, true);
  assert.equal(await readFile(pointer, 'utf8'), previousPointer);
  assert.equal(
    await readFile(edited, 'utf8'),
    'External edit before pointer commit',
  );
  assert.equal(
    await readFile(join(f.installRoot, environmentFile), 'utf8'),
    helper,
  );
  assert.equal(
    await new RuntimeManager(f.options).currentRoot(),
    f.installRoot,
  );
  await stat(active);
  assert.deepEqual(await readdir(join(f.dataDir, 'runtimes')), [
    JSON.parse(previousPointer).generation,
  ]);
  await assertEnvironmentCleanup(f);
});

void test('refreshEnvironment migrates an older updater and preserves its selection without repeated writes', async t => {
  const f = await legacyEnvironmentFixture(t);
  const helper = join(f.installRoot, environmentFile);
  const pointer = join(f.dataDir, 'active.json');
  const previous = JSON.parse(await readFile(pointer, 'utf8'));
  if (process.platform !== 'win32') await chmod(helper, 0o640);
  const manager = new RuntimeManager({...f.options, runningRoot: f.active});
  await manager.refreshEnvironment();
  assert.equal(await readFile(helper, 'utf8'), await currentEnvironment());
  const migrated = JSON.parse(await readFile(pointer, 'utf8'));
  assert.notEqual(migrated.fingerprint, previous.fingerprint);
  assert.deepEqual({...migrated, fingerprint: previous.fingerprint}, previous);
  assert.equal(await manager.currentRoot(), f.active);
  assert.equal(manager.status().restartRequired, false);
  assert.equal(await new RuntimeManager(f.options).currentRoot(), f.active);
  if (process.platform !== 'win32')
    assert.equal((await stat(helper)).mode & 0o777, 0o640);
  const old = new Date('2020-01-01T00:00:00.000Z');
  await utimes(helper, old, old);
  await utimes(pointer, old, old);
  const helperBefore = await stat(helper);
  const pointerBefore = await stat(pointer);
  await manager.refreshEnvironment();
  await new RuntimeManager(f.options).refreshEnvironment();
  assert.equal((await stat(helper)).mtimeMs, helperBefore.mtimeMs);
  assert.equal((await stat(pointer)).mtimeMs, pointerBefore.mtimeMs);
  assert.deepEqual(JSON.parse(await readFile(pointer, 'utf8')), migrated);
  await assertEnvironmentCleanup(f);
});

for (const operation of ['activation', 'migration'] as const) {
  void test(
    `a fresh base CLI loads Bash profile and rc exports after ${operation} without a Zsh warning`,
    {skip: process.platform !== 'linux'},
    async t => {
      const f =
        operation === 'migration'
          ? await legacyEnvironmentFixture(t)
          : await fixture(t);
      if (operation === 'migration') await f.manager.refreshEnvironment();
      else {
        await put(join(f.installRoot, environmentFile), legacyEnvironment);
        await updateReady(f.manager);
      }
      const active = await f.manager.currentRoot();
      assert.notEqual(active, f.installRoot);
      await put(
        join(f.temp, '.bash_profile'),
        'export BOOTSTRAP_PROFILE_SETTING="profile-value"\n',
      );
      await put(
        join(f.temp, '.bashrc'),
        'export BOOTSTRAP_RC_SETTING="rc-value"\n',
      );
      await put(
        join(active, 'desktop/build/src/runtime/cli.js'),
        `
      import assert from 'node:assert/strict';
      export async function runCli() {
        assert.equal(process.env.BOOTSTRAP_PROFILE_SETTING, 'profile-value');
        assert.equal(process.env.BOOTSTRAP_RC_SETTING, 'rc-value');
        console.log('Bash environment loaded by active CLI');
        return 0;
      }
    `,
      );
      const output = await runRuntimeCommand(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `
      import console from 'node:console';
      console.warn = message => { throw new Error(String(message)); };
      await import(${JSON.stringify(pathToFileURL(join(f.installRoot, 'bin/varisdev.mjs')).href)});
    `,
        ],
        {
          cwd: f.temp,
          timeoutMs: 10_000,
          env: {
            ...process.env,
            HOME: f.temp,
            USERPROFILE: f.temp,
            XDG_CONFIG_HOME: join(f.temp, 'config'),
            XDG_DATA_HOME: join(f.temp, 'user-data'),
            ZDOTDIR: f.temp,
            SHELL: '/bin/bash',
            PATH: '/usr/bin:/bin',
            BASH_ENV: undefined,
            ENV: undefined,
            BOOTSTRAP_PROFILE_SETTING: undefined,
            BOOTSTRAP_RC_SETTING: undefined,
            VARISDEV_DATA_DIR: f.dataDir,
          },
        },
      );
      assert.equal(output.trim(), 'Bash environment loaded by active CLI');
      assert.equal(await new RuntimeManager(f.options).currentRoot(), active);
    },
  );

  void test(`${operation} rolls the helper back when committing the active pointer fails and can retry`, async t => {
    const f = await legacyEnvironmentFixture(t);
    const helper = join(f.installRoot, environmentFile);
    const pointer = join(f.dataDir, 'active.json');
    const previousPointer = await readFile(pointer, 'utf8');
    if (operation === 'activation') f.revision = 'c'.repeat(40);
    const warning = t.mock.method(console, 'warn', () => {});
    let helperAtCommit: string | undefined;
    const rename = fs.rename;
    const restore = mockRename(t, async (source, destination) => {
      if (String(destination) === pointer) {
        helperAtCommit = await readFile(helper, 'utf8');
        throw new Error('Injected active pointer rename failure');
      }
      return rename(source, destination);
    });
    try {
      if (operation === 'activation') {
        const result = await f.manager.update();
        assert.equal(result.phase, 'error');
        assert.match(
          result.error || '',
          /Injected active pointer rename failure/,
        );
      } else await f.manager.refreshEnvironment();
    } finally {
      restore();
    }
    assert.equal(warning.mock.callCount(), operation === 'migration' ? 1 : 0);
    if (operation === 'migration')
      assert.match(
        String(warning.mock.calls[0].arguments[0]),
        /startup environment reader.*Reinstall/,
      );
    assert.equal(helperAtCommit, await currentEnvironment());
    assert.equal(await readFile(helper, 'utf8'), legacyEnvironment);
    assert.equal(await readFile(pointer, 'utf8'), previousPointer);
    assert.equal(await new RuntimeManager(f.options).currentRoot(), f.active);
    assert.deepEqual(await readdir(join(f.dataDir, 'runtimes')), [
      JSON.parse(previousPointer).generation,
    ]);
    await assertEnvironmentCleanup(f);
    if (operation === 'activation') await updateReady(f.manager);
    else await f.manager.refreshEnvironment();
    assert.equal(await readFile(helper, 'utf8'), await currentEnvironment());
    assert.notEqual(
      await new RuntimeManager(f.options).currentRoot(),
      f.installRoot,
    );
  });

  void test(`${operation} restores the previous helper without writes when the pointer runs out of disk space`, async t => {
    const f = await legacyEnvironmentFixture(t);
    const helper = join(f.installRoot, environmentFile);
    const pointer = join(f.dataDir, 'active.json');
    const previousPointer = await readFile(pointer, 'utf8');
    if (operation === 'activation') f.revision = 'c'.repeat(40);
    const warning = t.mock.method(console, 'warn', () => {});
    const write = fs.writeFile;
    let diskFull = false;
    let helperAtCommit: string | undefined;
    const restore = restoreBuiltinMock(
      t,
      t.mock.method(
        fs,
        'writeFile',
        async (...args: Parameters<typeof write>) => {
          if (String(args[0]).startsWith(join(f.dataDir, 'active-'))) {
            helperAtCommit = await readFile(helper, 'utf8');
            diskFull = true;
          }
          if (diskFull)
            throw Object.assign(new Error('Injected disk full'), {
              code: 'ENOSPC',
            });
          return write(...args);
        },
      ),
    );
    try {
      if (operation === 'activation') {
        const result = await f.manager.update();
        assert.equal(result.phase, 'error');
        assert.match(result.error || '', /Injected disk full/);
      } else await f.manager.refreshEnvironment();
    } finally {
      restore();
    }
    assert.equal(diskFull, true);
    assert.equal(helperAtCommit, await currentEnvironment());
    assert.equal(warning.mock.callCount(), operation === 'migration' ? 1 : 0);
    assert.equal(await readFile(helper, 'utf8'), legacyEnvironment);
    assert.equal(await readFile(pointer, 'utf8'), previousPointer);
    assert.equal(await new RuntimeManager(f.options).currentRoot(), f.active);
    await assertEnvironmentCleanup(f);
  });

  for (const code of ['EACCES', 'EPERM', 'EROFS']) {
    void test(`${operation} keeps a valid selection when helper replacement gets ${code} and recovers when writable`, async t => {
      const f = await legacyEnvironmentFixture(t);
      const helper = join(f.installRoot, environmentFile);
      const previousPointer = JSON.parse(
        await readFile(join(f.dataDir, 'active.json'), 'utf8'),
      );
      if (operation === 'activation') f.revision = 'c'.repeat(40);
      const warning = t.mock.method(console, 'warn', () => {});
      const rename = fs.rename;
      const restore = mockRename(t, async (source, destination) => {
        if (String(destination) === helper)
          throw Object.assign(new Error('Installation is read only'), {code});
        return rename(source, destination);
      });
      try {
        if (operation === 'activation') await updateReady(f.manager);
        else await f.manager.refreshEnvironment();
      } finally {
        restore();
      }
      assert.equal(warning.mock.callCount(), 1);
      assert.match(
        String(warning.mock.calls[0].arguments[0]),
        /write access.*original installation/,
      );
      assert.equal(await readFile(helper, 'utf8'), legacyEnvironment);
      const selected = await new RuntimeManager(f.options).currentRoot();
      assert.notEqual(selected, f.installRoot);
      if (operation === 'migration') assert.equal(selected, f.active);
      assert.equal(
        JSON.parse(await readFile(join(f.dataDir, 'active.json'), 'utf8'))
          .fingerprint,
        previousPointer.fingerprint,
      );
      await assertEnvironmentCleanup(f);
      await f.manager.refreshEnvironment();
      assert.equal(await readFile(helper, 'utf8'), await currentEnvironment());
      assert.equal(await new RuntimeManager(f.options).currentRoot(), selected);
      assert.equal(warning.mock.callCount(), 1);
    });
  }
}

void test('refreshEnvironment defers immediately while another updater owns the lock', async t => {
  const f = await legacyEnvironmentFixture(t);
  const lock = join(f.dataDir, 'update.lock');
  const owner = JSON.stringify({pid: process.pid, token: 'busy-updater'});
  await put(join(lock, 'owner.json'), owner);
  const pointer = await readFile(join(f.dataDir, 'active.json'), 'utf8');
  const warning = t.mock.method(console, 'warn', () => {});
  const manager = new RuntimeManager({...f.options, lockTimeoutMs: 2000});
  const started = Date.now();
  await manager.refreshEnvironment();
  assert.ok(
    Date.now() - started < 750,
    'startup repair should not wait for the update lock',
  );
  assert.equal(
    await readFile(join(f.installRoot, environmentFile), 'utf8'),
    legacyEnvironment,
  );
  assert.equal(await readFile(join(f.dataDir, 'active.json'), 'utf8'), pointer);
  assert.equal(await readFile(join(lock, 'owner.json'), 'utf8'), owner);
  assert.equal(await manager.currentRoot(), f.active);
  assert.equal(warning.mock.callCount(), 0);
  await rm(lock, {recursive: true});
  await manager.refreshEnvironment();
  assert.equal(
    await readFile(join(f.installRoot, environmentFile), 'utf8'),
    await currentEnvironment(),
  );
  assert.equal(await manager.currentRoot(), f.active);
  await assertEnvironmentCleanup(f);
});

void test('refreshEnvironment respects a base source edit that invalidates the active selection', async t => {
  const f = await legacyEnvironmentFixture(t);
  const pointer = await readFile(join(f.dataDir, 'active.json'), 'utf8');
  await put(
    join(f.installRoot, 'src/dashboard/parent.ts'),
    'External source edit',
  );
  await f.manager.refreshEnvironment();
  assert.equal(await f.manager.currentRoot(), f.installRoot);
  assert.equal(
    await readFile(join(f.installRoot, environmentFile), 'utf8'),
    legacyEnvironment,
  );
  assert.equal(await readFile(join(f.dataDir, 'active.json'), 'utf8'), pointer);
  await assertEnvironmentCleanup(f);
});

void test('refreshEnvironment restores the helper when another base source file changes during replacement', async t => {
  const f = await legacyEnvironmentFixture(t);
  const helper = join(f.installRoot, environmentFile);
  const pointer = await readFile(join(f.dataDir, 'active.json'), 'utf8');
  const edited = join(f.installRoot, 'src/dashboard/parent.ts');
  const warning = t.mock.method(console, 'warn', () => {});
  const rename = fs.rename;
  let changed = false;
  const restore = mockRename(t, async (source, destination) => {
    await rename(source, destination);
    if (String(destination) === helper && !changed) {
      changed = true;
      await writeFile(edited, 'External edit during replacement');
    }
  });
  try {
    await f.manager.refreshEnvironment();
  } finally {
    restore();
  }
  assert.equal(warning.mock.callCount(), 1);
  assert.match(
    String(warning.mock.calls[0].arguments[0]),
    /startup environment reader.*Reinstall/,
  );
  assert.equal(changed, true);
  assert.equal(await readFile(helper, 'utf8'), legacyEnvironment);
  assert.equal(
    await readFile(edited, 'utf8'),
    'External edit during replacement',
  );
  assert.equal(await readFile(join(f.dataDir, 'active.json'), 'utf8'), pointer);
  assert.equal(
    await new RuntimeManager(f.options).currentRoot(),
    f.installRoot,
  );
  await assertEnvironmentCleanup(f);
});

void test('full application update installs new code, dependencies and runtime and dispatches the updated CLI', async t => {
  const f = await fixture(t);
  const events: UpdateStatus[] = [];
  f.manager.subscribe(next => events.push(next));
  const checked = await f.manager.check();
  assert.equal(checked.phase, 'available');
  assert.equal(checked.currentVersion, '0.1.0');
  assert.equal(checked.latestRevision, nextRevision);
  assert.deepEqual(f.urls, ['ssh://git@github.com/HardDoer/varisdev.git']);
  const updated = await f.manager.update();
  assert.equal(updated.phase, 'ready', updated.error);
  assert.equal(updated.currentVersion, '0.2.0');
  assert.equal(updated.restartRequired, true);
  assert.equal(updated.progress, undefined);
  assert.deepEqual(
    [
      ...new Set(
        events.flatMap(next => (next.progress ? [next.progress.stage] : [])),
      ),
    ],
    [
      'checking',
      'waiting',
      'preparing',
      'downloading',
      'installing',
      'verifying',
      'activating',
    ],
  );
  assert.ok(events.every(next => next.progress?.totalBytes === undefined));
  const active = await f.manager.currentRoot();
  assert.notEqual(active, f.installRoot);
  assert.match(
    await readFile(join(active, 'src/dashboard/parent.ts'), 'utf8'),
    /0.2.0/,
  );
  assert.equal(
    JSON.parse(
      await readFile(
        join(active, 'node_modules/app-dependency/package.json'),
        'utf8',
      ),
    ).version,
    '0.2.0',
  );
  assert.equal(await f.manager.currentPiVersion(), '0.86.0');
  assert.equal(await new RuntimeManager(f.options).currentRoot(), active);
  assert.equal(
    JSON.parse(await readFile(join(f.installRoot, 'package.json'), 'utf8'))
      .version,
    '0.1.0',
  );
  assert.equal(f.installs, 1);
  assert.equal(f.smokeImports, 1);
  const cli = await execute(
    process.execPath,
    [join(f.installRoot, 'bin/varisdev.mjs'), '--version'],
    {
      env: {
        ...process.env,
        HOME: f.temp,
        ZDOTDIR: f.temp,
        VARISDEV_DATA_DIR: f.dataDir,
      },
    },
  );
  assert.equal(cli.stdout.trim(), 'VarisDev 0.2.0');
  await assert.rejects(stat(join(f.dataDir, 'update.lock')));
});

void test(
  'archive update forwards download bytes, clears failed progress and can retry',
  {timeout: 15_000},
  async t => {
    const f = await fixture(t);
    const {releaseURL} = await import('../src/runtime/distribution.mjs');
    await put(
      join(f.installRoot, 'build-info.json'),
      JSON.stringify({revision: initialRevision, source: releaseURL}),
    );
    let failDownload = true;
    const events: UpdateStatus[] = [];
    const manager = new RuntimeManager({
      ...f.options,
      hooks: {
        ...f.hooks,
        readRelease: async () => ({
          version: '0.2.0',
          revision: nextRevision,
          url: `${releaseURL}/app.tgz`,
          sha256: '0'.repeat(64),
        }),
        downloadRelease: async (_release, destination, _timeout, progress) => {
          progress?.({transferredBytes: 0, totalBytes: 100});
          progress?.({transferredBytes: 40, totalBytes: 100});
          if (failDownload) throw new Error('Download interrupted');
          progress?.({transferredBytes: 100, totalBytes: 100});
          await put(destination, 'archive');
        },
        run: async (command, args, options) => {
          if (args[0].endsWith('install-desktop.mjs')) return;
          const result = await f.hooks.run!(
            command,
            args.filter(arg => arg !== '--ignore-scripts'),
            options,
          );
          if (args[1] === 'install') {
            const root = join(
              options.cwd,
              process.platform === 'win32'
                ? 'node_modules/varisdev'
                : 'lib/node_modules/varisdev',
            );
            await put(
              join(root, 'build-info.json'),
              JSON.stringify({revision: nextRevision, source: releaseURL}),
            );
          }
          return result;
        },
      },
    });
    manager.subscribe(next => events.push(next));
    const failed = await manager.update();
    assert.equal(failed.phase, 'error');
    assert.match(failed.error || '', /Download interrupted/);
    assert.equal(failed.progress, undefined);
    assert.ok(
      events.some(
        next =>
          next.progress?.stage === 'downloading' &&
          next.progress.transferredBytes === 40 &&
          next.progress.totalBytes === 100,
      ),
    );
    assert.equal(await manager.currentRoot(), f.installRoot);
    failDownload = false;
    events.length = 0;
    const completed = await manager.update();
    assert.equal(completed.phase, 'ready', completed.error);
    assert.equal(completed.progress, undefined);
    assert.equal(completed.error, undefined);
    const installing = events.find(
      next => next.progress?.stage === 'installing',
    );
    assert.ok(installing);
    assert.equal(installing.progress?.transferredBytes, undefined);
    assert.equal(installing.progress?.totalBytes, undefined);
  },
);

for (const configuredNode of [false, true]) {
  void test(`updates expose ${configuredNode ? 'the configured' : 'the current'} Node to lifecycle scripts without an inherited Node PATH`, async t => {
    const f = await fixture(t);
    const inheritedPath = process.env.PATH;
    const runAsNode = process.env.ELECTRON_RUN_AS_NODE;
    t.after(() => {
      if (inheritedPath === undefined) delete process.env.PATH;
      else process.env.PATH = inheritedPath;
      if (runAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = runAsNode;
    });
    let executable = process.execPath;
    if (configuredNode) {
      executable = join(
        f.temp,
        'Node runtime',
        process.platform === 'win32' ? 'node.exe' : 'node',
      );
      await mkdir(dirname(executable), {recursive: true});
      await copyFile(process.execPath, executable);
      process.env.VARISDEV_NODE_EXECUTABLE = executable;
    } else delete process.env.VARISDEV_NODE_EXECUTABLE;
    process.env.PATH = f.temp;
    process.env.ELECTRON_RUN_AS_NODE = '1';
    let lifecycleChecks = 0;
    const manager = new RuntimeManager({
      ...f.options,
      hooks: {
        ...f.hooks,
        run: async (command, args, options) => {
          if (command !== 'git') {
            assert.equal(command, executable);
            assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
            if (args[0].endsWith('npm-cli.js')) {
              const resolved = await runRuntimeCommand(
                process.platform === 'win32' ? process.env.ComSpec! : '/bin/sh',
                process.platform === 'win32'
                  ? ['/d', '/s', '/c', 'node -p process.execPath']
                  : ['-c', 'node -p process.execPath'],
                {...options, timeoutMs: 5000},
              );
              assert.equal(
                await realpath(resolved.trim()),
                await realpath(executable),
              );
              lifecycleChecks++;
            }
          }
          return f.hooks.run!(
            command === executable ? process.execPath : command,
            args,
            options,
          );
        },
      },
    });
    await updateReady(manager);
    assert.equal(lifecycleChecks, 2);
    assert.equal(process.env.PATH, f.temp);
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1');
  });
}

for (const failure of ['git', 'npm', 'compile', 'import']) {
  void test(`failed ${failure} preserves the active application and removes its partial install`, async t => {
    const f = await fixture(t);
    await updateReady(f.manager);
    const previous = await f.manager.currentRoot();
    const pointer = await readFile(join(f.dataDir, 'active.json'), 'utf8');
    f.revision = 'c'.repeat(40);
    f.failure = failure;
    const result = await f.manager.update();
    assert.equal(result.phase, 'error');
    assert.equal(await f.manager.currentRoot(), previous);
    assert.equal(
      await readFile(join(f.dataDir, 'active.json'), 'utf8'),
      pointer,
    );
    assert.deepEqual(await readdir(join(f.dataDir, 'runtimes')), [
      JSON.parse(pointer).generation,
    ]);
    await assert.rejects(stat(join(f.dataDir, 'update.lock')));
  });
}

void test('checks compare Git revisions even without a version bump and retain known availability offline', async t => {
  const f = await fixture(t);
  f.latest = '0.1.0';
  assert.equal((await f.manager.check()).phase, 'available');
  await updateReady(f.manager);
  const relaunched = new RuntimeManager({
    ...f.options,
    runningRoot: await f.manager.currentRoot(),
  });
  assert.equal((await relaunched.check()).phase, 'idle');
  f.offline = true;
  const offline = await relaunched.check();
  assert.equal(offline.phase, 'error');
  assert.match(offline.error || '', /Network unavailable/);
  assert.equal(offline.latestRevision, nextRevision);
  f.offline = false;
  f.revision = '../malformed';
  assert.equal((await relaunched.update()).phase, 'error');
  assert.equal(f.installs, 1);
});

void test('archive installations can check public updates without SSH configuration', async t => {
  const f = await fixture(t);
  await rm(join(f.installRoot, 'build-info.json'));
  assert.equal((await f.manager.check()).phase, 'available');
  assert.deepEqual(f.urls, ['https://github.com/HardDoer/varisdev.git']);
});

void test('updates remember Git access and fall back to HTTPS when SSH is unavailable', async t => {
  const f = await fixture(t);
  const sources: string[] = [];
  const hooks: RuntimeHooks = {
    ...f.hooks,
    run: async (command, args, options) => {
      if (command === 'git' && args[0] === 'ls-remote') {
        sources.push(args[2]);
        if (args[2].startsWith('ssh:')) throw new Error('SSH unavailable');
      }
      return f.hooks.run!(command, args, options);
    },
  };
  const manager = new RuntimeManager({...f.options, hooks});
  await updateReady(manager);
  assert.deepEqual(sources, [
    'ssh://git@github.com/HardDoer/varisdev.git',
    'https://github.com/HardDoer/varisdev.git',
  ]);
  sources.length = 0;
  await new RuntimeManager({...f.options, hooks}).check();
  assert.deepEqual(sources, ['https://github.com/HardDoer/varisdev.git']);
});

void test('Git check times out even when a command hook ignores its timeout', async t => {
  const f = await fixture(t);
  const result = await new RuntimeManager({
    ...f.options,
    requestTimeoutMs: 20,
    hooks: {...f.hooks, run: () => new Promise(() => {})},
  }).check();
  assert.equal(result.phase, 'error');
  assert.match(result.error || '', /timed out/);
});

void test('concurrent updates install once and activate the same application', async t => {
  const f = await fixture(t);
  const other = new RuntimeManager(f.options);
  const results = await Promise.all([
    f.manager.update(),
    f.manager.update(),
    other.update(),
  ]);
  for (const result of results)
    assert.equal(result.phase, 'ready', result.error);
  assert.equal(f.installs, 1);
  assert.equal(await other.currentRoot(), await f.manager.currentRoot());
});

void test('cross-process updates serialize full application installation', async t => {
  const f = await fixture(t);
  const log = join(f.temp, 'install.log');
  const template = join(f.temp, 'candidate');
  await appFiles(template, '0.2.0', '0.86.0');
  const code = `
    import {RuntimeManager} from ${JSON.stringify(new URL('../src/runtime/manager.ts', import.meta.url).href)};
    import {cp,appendFile} from 'node:fs/promises'; import {join} from 'node:path';
    const manager=new RuntimeManager({installRoot:${JSON.stringify(f.installRoot)},dataDir:${JSON.stringify(f.dataDir)},hooks:{
      run:async(command,args,options)=>{
        if(command==='git'){
          if(args[0]==='ls-remote') return ${JSON.stringify(nextRevision + '\tHEAD\n')};
          if(args[0]==='init') await cp(${JSON.stringify(template)},args[1],{recursive:true});
          return;
        }
        if(args[1]==='pack') return;
        await appendFile(${JSON.stringify(log)},'install\\n');await new Promise(r=>setTimeout(r,150));await cp(${JSON.stringify(template)},join(options.cwd,process.platform==='win32'?'node_modules/varisdev':'lib/node_modules/varisdev'),{recursive:true});
      },
      smokeImport:async()=>{}
    }});
    const status=await manager.update();if(status.error)throw new Error(status.error);console.log(await manager.currentRoot());
  `;
  const results = await Promise.all([
    execute(process.execPath, ['--input-type=module', '--eval', code]),
    execute(process.execPath, ['--input-type=module', '--eval', code]),
  ]);
  assert.equal(results[0].stdout.trim(), results[1].stdout.trim());
  assert.equal(await readFile(log, 'utf8'), 'install\n');
});

void test('live locks time out, and dead or incomplete owners are recovered', async t => {
  const f = await fixture(t);
  const lock = join(f.dataDir, 'update.lock');
  await put(
    join(lock, 'owner.json'),
    JSON.stringify({pid: process.pid, token: 'live'}),
  );
  const blocked = await new RuntimeManager({
    ...f.options,
    lockTimeoutMs: 20,
  }).update();
  assert.equal(blocked.phase, 'error');
  assert.match(blocked.error || '', /still running/);
  const child = spawn(process.execPath, ['--eval', 'process.exit(0)']);
  const pid = child.pid;
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', () => resolve());
  });
  await writeFile(
    join(lock, 'owner.json'),
    JSON.stringify({pid, token: 'dead'}),
  );
  const recovered = await f.manager.update();
  assert.equal(recovered.phase, 'ready', recovered.error);
  f.revision = 'c'.repeat(40);
  await put(join(lock, 'owner.json'), '{partial');
  const old = new Date(Date.now() - 60000);
  await utimes(lock, old, old);
  await updateReady(f.manager);
});

void test('invalid pointers and changed base installations fall back safely; legacy runtime pointers still load', async t => {
  const f = await fixture(t);
  await put(join(f.dataDir, 'active.json'), '{bad json');
  assert.equal(await f.manager.currentRoot(), f.installRoot);
  await put(
    join(f.dataDir, 'active.json'),
    JSON.stringify({
      generation: '../../package',
      baseRoot: f.installRoot,
      version: '0.2.0',
    }),
  );
  assert.equal(await f.manager.currentRoot(), f.installRoot);
  await updateReady(f.manager);
  const active = await f.manager.currentRoot();
  const pointer = JSON.parse(
    await readFile(join(f.dataDir, 'active.json'), 'utf8'),
  );
  const generation = 'runtime-0.86.0-12345678';
  const legacy = join(f.dataDir, 'runtimes', generation);
  await cp(active, legacy, {recursive: true});
  await writeFile(
    join(f.dataDir, 'active.json'),
    JSON.stringify({
      ...pointer,
      generation,
      version: '0.86.0',
      revision: undefined,
    }),
  );
  assert.equal(await f.manager.currentRoot(), legacy);
  await writeFile(join(f.dataDir, 'active.json'), JSON.stringify(pointer));
  await put(join(f.installRoot, 'README.md'), 'Documentation only');
  assert.equal(await f.manager.currentRoot(), active);
  await put(
    join(f.installRoot, 'src/dashboard/parent.ts'),
    'Changed base application',
  );
  assert.equal(await f.manager.currentRoot(), f.installRoot);
  await stat(active);
});

void test('a running app detects external updates and clears restart status after relaunch', async t => {
  const f = await fixture(t);
  const desktop = new RuntimeManager({
    ...f.options,
    runningRoot: f.installRoot,
  });
  assert.equal((await desktop.check()).restartRequired, false);
  await updateReady(f.manager);
  assert.equal((await desktop.check()).restartRequired, true);
  const relaunched = new RuntimeManager({
    ...f.options,
    runningRoot: await f.manager.currentRoot(),
  });
  assert.equal(relaunched.status().currentVersion, '0.2.0');
  assert.equal((await relaunched.check()).restartRequired, false);
});

void test('a timed-out installer terminates its process tree without system tools on PATH and removes staging', async t => {
  const f = await fixture(t);
  const inheritedPath = process.env.PATH;
  t.after(() => {
    if (inheritedPath === undefined) delete process.env.PATH;
    else process.env.PATH = inheritedPath;
  });
  process.env.PATH = f.temp;
  const marker = join(f.temp, 'descendant-ran');
  const childCode = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'), 300)`;
  await writeFile(
    join(f.installRoot, 'node_modules/npm/bin/npm-cli.js'),
    `require('node:child_process').spawn(process.execPath, ['--eval', ${JSON.stringify(childCode)}]); setTimeout(() => {}, 1000);`,
  );
  const result = await new RuntimeManager({
    ...f.options,
    commandTimeoutMs: 100,
    hooks: {
      ...f.hooks,
      run: async (command, args, options) => {
        if (command === 'git') return f.hooks.run!(command, args, options);
        return runRuntimeCommand(command, args, options);
      },
    },
  }).update();
  assert.equal(result.phase, 'error');
  assert.match(result.error || '', /timed out/);
  assert.deepEqual(await readdir(join(f.dataDir, 'runtimes')), []);
  await assert.rejects(stat(join(f.dataDir, 'active.json')));
  await delay(350);
  await assert.rejects(stat(marker));
});

void test('data directory override is separate from agent settings', () => {
  const directory = join(tmpdir(), 'varisdev-isolated');
  assert.equal(defaultDataDir({VARISDEV_DATA_DIR: directory}), directory);
});

void test('application updates refresh only the Finder launcher belonging to that installation', async t => {
  const {refreshMacLauncher} = await import('../src/runtime/mac-launcher.ts');
  const f = await fixture(t);
  const bundle = join(f.temp, 'VarisDev.app');
  const directory = join(bundle, 'Contents/Resources/app');
  await put(
    join(directory, 'launch.json'),
    JSON.stringify({installRoot: '/another-install'}),
  );
  await put(join(directory, 'main.cjs'), 'other launcher');
  await put(
    join(f.installRoot, 'assets/desktop/app-main.cjs'),
    'updated launcher',
  );
  await put(
    join(f.installRoot, 'src/runtime/environment.mjs'),
    'updated environment loader',
  );
  await refreshMacLauncher(f.installRoot, f.installRoot, bundle);
  assert.equal(
    await readFile(join(directory, 'main.cjs'), 'utf8'),
    'other launcher',
  );
  await put(
    join(directory, 'launch.json'),
    JSON.stringify({installRoot: f.installRoot}),
  );
  await refreshMacLauncher(f.installRoot, f.installRoot, bundle);
  assert.equal(
    await readFile(join(directory, 'main.cjs'), 'utf8'),
    'updated launcher',
  );
  assert.equal(
    await readFile(join(directory, 'environment.mjs'), 'utf8'),
    'updated environment loader',
  );
  assert.deepEqual((await readdir(directory)).sort(), [
    'environment.mjs',
    'launch.json',
    'main.cjs',
  ]);
});
