import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
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
  type RuntimeHooks,
  type RuntimeManagerOptions,
} from '../src/runtime/manager.ts';

const sdk = '@earendil-works/pi-coding-agent';
const execute = promisify(execFile);

async function put(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, contents);
}

async function fixture(t: {after: (fn: () => Promise<void>) => void}) {
  const temp = await mkdtemp(join(tmpdir(), 'varisdev-runtime-test-'));
  t.after(() => rm(temp, {recursive: true, force: true}));
  const installRoot = join(temp, 'package');
  const dataDir = join(temp, 'data');
  await put(join(installRoot, 'package.json'), '{"type":"module"}');
  await put(
    join(installRoot, 'src', 'dashboard', 'parent.ts'),
    'export const ready = true;',
  );
  await put(
    join(installRoot, 'assets', 'dashboard', 'index.html'),
    '<main>VarisDev</main>',
  );
  await put(join(installRoot, 'tsconfig.desktop.json'), '{}');
  await put(
    join(installRoot, 'desktop', 'package.json'),
    JSON.stringify({
      type: 'module',
      dependencies: {
        [sdk]: '0.85.1',
        '@earendil-works/pi-ai': '0.85.1',
        '@earendil-works/pi-tui': '0.85.1',
        typebox: '1.3.7',
      },
    }),
  );
  await put(join(installRoot, 'desktop', 'package-lock.json'), 'old SDK lock');
  await put(
    join(installRoot, 'desktop', 'node_modules', sdk, 'package.json'),
    '{"version":"0.85.1"}',
  );
  await put(
    join(installRoot, 'node_modules', 'npm', 'package.json'),
    '{"exports":{"./package.json":"./package.json"}}',
  );
  await put(join(installRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '');
  await put(
    join(installRoot, 'node_modules', 'typescript', 'package.json'),
    '{}',
  );
  await put(join(installRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '');

  let latest = '0.86.0';
  let offline = false;
  let failure = '';
  let installs = 0;
  let smokeImports = 0;
  let networkUrl = '';
  const hooks: RuntimeHooks = {
    now: () => new Date('2026-10-14T12:00:00.000Z'),
    fetch: async url => {
      networkUrl = String(url);
      if (offline) throw new Error('Network unavailable');
      return Response.json({
        version: latest,
        dependencies: {typebox: '^1.4.0'},
      });
    },
    run: async (command, args, options) => {
      assert.equal(command, process.execPath);
      if (args[0].endsWith('npm-cli.js')) {
        installs++;
        assert.deepEqual(args.slice(1), [
          'install',
          '--global=false',
          '--prefix',
          options.cwd,
          '--omit=dev',
          '--legacy-peer-deps',
          '--no-audit',
          '--no-fund',
        ]);
        await assert.rejects(stat(join(options.cwd, 'package-lock.json')));
        if (failure === 'npm') throw new Error('Package installation failed');
        const manifest = JSON.parse(
          await readFile(join(options.cwd, 'package.json'), 'utf8'),
        );
        for (const name of [
          sdk,
          '@earendil-works/pi-ai',
          '@earendil-works/pi-tui',
        ])
          assert.equal(manifest.dependencies[name], latest);
        assert.equal(manifest.dependencies.typebox, '^1.4.0');
        await delay(30);
        await put(
          join(options.cwd, 'node_modules', sdk, 'package.json'),
          JSON.stringify({version: latest}),
        );
      } else if (args[0].endsWith('tsc')) {
        if (failure === 'compile') throw new Error('App compilation failed');
        await put(
          join(
            options.cwd,
            'desktop',
            'build',
            'src',
            'dashboard',
            'parent.js',
          ),
          failure === 'import'
            ? "throw new Error('App import failed');"
            : 'export const ready = true;',
        );
      } else {
        smokeImports++;
        await execute(command, args, {cwd: options.cwd, env: options.env});
      }
    },
  };
  const options: RuntimeManagerOptions = {
    installRoot,
    dataDir,
    hooks,
    registryUrl: 'https://registry.example/npm/',
  };
  return {
    installRoot,
    dataDir,
    temp,
    hooks,
    options,
    manager: new RuntimeManager(options),
    get installs() {
      return installs;
    },
    get smokeImports() {
      return smokeImports;
    },
    get networkUrl() {
      return networkUrl;
    },
    set latest(value: string) {
      latest = value;
    },
    set offline(value: boolean) {
      offline = value;
    },
    set failure(value: string) {
      failure = value;
    },
  };
}

void test('successful staging activates a complete source generation and preserves installed package', async t => {
  const f = await fixture(t);
  const phases: string[] = [];
  const unsubscribe = f.manager.subscribe(status => phases.push(status.phase));
  assert.equal(await f.manager.currentRoot(), f.installRoot);
  assert.equal(await f.manager.currentPiVersion(), '0.85.1');
  const checked = await f.manager.check();
  assert.equal(checked.phase, 'available');
  assert.equal(checked.checkedAt, '2026-10-14T12:00:00.000Z');
  assert.equal(
    f.networkUrl,
    'https://registry.example/npm/%40earendil-works%2Fpi-coding-agent/latest',
  );
  const updated = await f.manager.update();
  assert.equal(updated.phase, 'ready', updated.error);
  assert.equal(updated.restartRequired, true);
  assert.equal(updated.currentVersion, '0.86.0');
  const active = await f.manager.currentRoot();
  assert.notEqual(active, f.installRoot);
  assert.equal(await f.manager.currentPiVersion(), '0.86.0');
  assert.equal(await new RuntimeManager(f.options).currentRoot(), active);
  assert.equal(
    await readlink(join(active, 'node_modules')),
    join(f.installRoot, 'node_modules'),
  );
  assert.equal(
    await readFile(join(active, 'src', 'dashboard', 'parent.ts'), 'utf8'),
    'export const ready = true;',
  );
  assert.equal(
    JSON.parse(
      await readFile(
        join(f.installRoot, 'desktop', 'node_modules', sdk, 'package.json'),
        'utf8',
      ),
    ).version,
    '0.85.1',
  );
  assert.equal(
    await readFile(join(f.installRoot, 'desktop', 'package-lock.json'), 'utf8'),
    'old SDK lock',
  );
  assert.equal(f.installs, 1);
  assert.equal(f.smokeImports, 1);
  assert.ok(phases.includes('checking'));
  assert.ok(phases.includes('updating'));
  assert.equal(phases.at(-1), 'ready');
  unsubscribe();
  const count = phases.length;
  await f.manager.check();
  assert.equal(phases.length, count);
  await assert.rejects(stat(join(f.dataDir, 'update.lock')));
});

for (const failure of ['npm', 'compile', 'import']) {
  void test(`failed ${failure} preserves the previous active generation and cleans staging`, async t => {
    const f = await fixture(t);
    assert.equal((await f.manager.update()).phase, 'ready');
    const previous = await f.manager.currentRoot();
    const pointer = await readFile(join(f.dataDir, 'active.json'), 'utf8');
    f.latest = '0.87.0';
    f.failure = failure;
    const result = await f.manager.update();
    assert.equal(result.phase, 'error');
    assert.equal(result.currentVersion, '0.86.0');
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

void test('checking retains known availability offline and refuses older or prerelease latest versions', async t => {
  const f = await fixture(t);
  assert.equal((await f.manager.check()).phase, 'available');
  f.offline = true;
  const offline = await f.manager.check();
  assert.equal(offline.phase, 'error');
  assert.match(offline.error || '', /VarisDev runtime.*Network unavailable/);
  assert.equal(offline.latestVersion, '0.86.0');
  assert.equal(offline.checkedAt, '2026-10-14T12:00:00.000Z');
  f.offline = false;
  f.latest = '0.84.9';
  assert.equal((await f.manager.check()).phase, 'idle');
  assert.equal((await f.manager.update()).phase, 'idle');
  assert.equal(f.installs, 0);
  f.latest = '0.87.0-beta.1';
  assert.equal((await f.manager.update()).phase, 'error');
  assert.equal(f.installs, 0);
});

void test('registry check has a bounded timeout even when a fetch hook ignores abort', async t => {
  const f = await fixture(t);
  const manager = new RuntimeManager({
    ...f.options,
    requestTimeoutMs: 20,
    hooks: {
      ...f.hooks,
      fetch: () => new Promise(() => {}),
    },
  });
  const result = await manager.check();
  assert.equal(result.phase, 'error');
  assert.match(result.error || '', /timed out/);
});

void test('same-process concurrent updates install once and select the same generation', async t => {
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

void test('cross-process updates serialize installation and both use the active generation', async t => {
  const f = await fixture(t);
  const log = join(f.temp, 'install.log');
  const childCode = `
    import {RuntimeManager} from ${JSON.stringify(new URL('../src/runtime/manager.ts', import.meta.url).href)};
    import {mkdir,writeFile,readFile,appendFile} from 'node:fs/promises';
    import {dirname,join} from 'node:path';
    const put=async(p,s)=>{await mkdir(dirname(p),{recursive:true});await writeFile(p,s)};
    const manager=new RuntimeManager({installRoot:${JSON.stringify(f.installRoot)},dataDir:${JSON.stringify(f.dataDir)},hooks:{
      fetch:async()=>Response.json({version:'0.86.0'}),
      run:async(command,args,options)=>{
        if(args[0].endsWith('npm-cli.js')){
          await appendFile(${JSON.stringify(log)},'install\\n');
          await new Promise(r=>setTimeout(r,150));
          await put(join(options.cwd,'node_modules',${JSON.stringify(sdk)},'package.json'),'{"version":"0.86.0"}');
        }else if(args[0].endsWith('tsc')){
          await put(join(options.cwd,'desktop/build/src/dashboard/parent.js'),'export const ready=true');
        }
      },smokeImport:async()=>{}
    }});
    const result=await manager.update();
    if(result.phase==='error')throw new Error(result.error);
    console.log(await manager.currentRoot());
  `;
  const results = await Promise.all([
    execute(process.execPath, ['--input-type=module', '--eval', childCode]),
    execute(process.execPath, ['--input-type=module', '--eval', childCode]),
  ]);
  assert.equal(results[0].stdout.trim(), results[1].stdout.trim());
  assert.equal(await readFile(log, 'utf8'), 'install\n');
});

void test('live update lock times out and a dead owner lock is recovered', async t => {
  const f = await fixture(t);
  await put(
    join(f.dataDir, 'update.lock', 'owner.json'),
    JSON.stringify({pid: process.pid, token: 'live'}),
  );
  const manager = new RuntimeManager({...f.options, lockTimeoutMs: 20});
  const blocked = await manager.update();
  assert.equal(blocked.phase, 'error');
  assert.match(blocked.error || '', /still running/);
  assert.equal(f.installs, 0);
  const child = spawn(process.execPath, ['--eval', 'process.exit(0)']);
  const pid = child.pid;
  await new Promise<void>((fulfill, reject) => {
    child.on('error', reject);
    child.on('close', () => fulfill());
  });
  await writeFile(
    join(f.dataDir, 'update.lock', 'owner.json'),
    JSON.stringify({pid, token: 'dead'}),
  );
  const recovered = await new RuntimeManager(f.options).update();
  assert.equal(recovered.phase, 'ready', recovered.error);
  assert.equal(f.installs, 1);
});

void test('corrupt or traversing pointers fall back; source changes invalidate an otherwise valid generation', async t => {
  const f = await fixture(t);
  await put(join(f.dataDir, 'active.json'), '{bad json');
  assert.equal(await f.manager.currentRoot(), f.installRoot);
  await writeFile(
    join(f.dataDir, 'active.json'),
    JSON.stringify({
      generation: '../../package',
      baseRoot: f.installRoot,
      version: '0.86.0',
    }),
  );
  assert.equal(await f.manager.currentRoot(), f.installRoot);
  assert.equal((await f.manager.update()).phase, 'ready');
  const active = await f.manager.currentRoot();
  await put(join(f.installRoot, 'test', 'ignored.test.ts'), 'irrelevant');
  await put(join(f.installRoot, 'README.md'), 'irrelevant');
  assert.equal(await f.manager.currentRoot(), active);
  await writeFile(
    join(f.installRoot, 'src', 'dashboard', 'parent.ts'),
    'export const changed = true;',
  );
  assert.equal(await f.manager.currentRoot(), f.installRoot);
  assert.equal(await f.manager.currentPiVersion(), '0.85.1');
  await stat(active); // Live processes may still need the old tree.
});

void test('a running desktop notices an externally installed generation and clears restart after relaunch', async t => {
  const f = await fixture(t);
  const desktop = new RuntimeManager({
    ...f.options,
    runningRoot: f.installRoot,
  });
  assert.equal((await desktop.check()).restartRequired, false);
  assert.equal((await f.manager.update()).phase, 'ready');
  const status = await desktop.check();
  assert.equal(status.phase, 'ready');
  assert.equal(status.restartRequired, true);
  const relaunched = new RuntimeManager({
    ...f.options,
    runningRoot: await f.manager.currentRoot(),
  });
  assert.equal(relaunched.status().currentVersion, '0.86.0');
  assert.equal((await relaunched.check()).restartRequired, false);
});

void test('an abandoned lock without complete owner metadata is recovered', async t => {
  const f = await fixture(t);
  const lock = join(f.dataDir, 'update.lock');
  await put(join(lock, 'owner.json'), '{partial');
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  const manager = new RuntimeManager({...f.options, lockTimeoutMs: 1_000});
  const result = await manager.update();
  assert.equal(result.phase, 'ready', result.error);
});

void test('a timed out installer terminates its process tree and cleans its partial generation', async t => {
  const f = await fixture(t);
  const marker = join(f.temp, 'descendant-ran');
  const childCode = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'), 300)`;
  await writeFile(
    join(f.installRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    `require('node:child_process').spawn(process.execPath, ['--eval', ${JSON.stringify(childCode)}]); setTimeout(() => {}, 1000);`,
  );
  const manager = new RuntimeManager({
    ...f.options,
    commandTimeoutMs: 100,
    hooks: {...f.hooks, run: undefined},
  });
  const result = await manager.update();
  assert.equal(result.phase, 'error');
  assert.match(result.error || '', /timed out/);
  assert.deepEqual(await readdir(join(f.dataDir, 'runtimes')), []);
  await assert.rejects(stat(join(f.dataDir, 'active.json')));
  await assert.rejects(stat(join(f.dataDir, 'update.lock')));
  await delay(350);
  await assert.rejects(stat(marker));
});

void test('data directory override is separate from normal agent settings', () => {
  const directory = join(tmpdir(), 'varisdev-isolated');
  assert.equal(defaultDataDir({VARISDEV_DATA_DIR: directory}), directory);
});
