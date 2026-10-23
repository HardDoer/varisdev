import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {
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
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
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
  await put(
    join(root, 'src/runtime/environment.mjs'),
    await readFile(
      new URL('../src/runtime/environment.mjs', import.meta.url),
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
  };
}

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

void test('a timed-out installer terminates its process tree and removes staging', async t => {
  const f = await fixture(t);
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
