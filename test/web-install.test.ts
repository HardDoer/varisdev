import assert from 'node:assert/strict';
import {exec} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  access,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {
  acquireUpdateLock,
  downloadRelease,
  install,
  readRelease,
  releaseURL,
  type Release,
} from '../src/runtime/distribution.mjs';
import {environmentPath} from '../src/runtime/environment.mjs';
import {RuntimeManager, runRuntimeCommand} from '../src/runtime/manager.ts';

void test('release downloads validate metadata and checksums and clean up failed installation downloads', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'web-feed-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const contents = Buffer.from('package bytes');
  const valid = {
    version: '0.1.0',
    revision: 'a'.repeat(40),
    url: './app.tgz',
    sha256: createHash('sha256').update(contents).digest('hex'),
  };
  let manifest = valid;
  let status = 200;
  const server = createServer((request, response) => {
    response.writeHead(status);
    response.end(
      request.url === '/latest.json' ? JSON.stringify(manifest) : contents,
    );
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/latest.json`;
  const release = await readRelease(url);
  assert.equal(release.url, `http://127.0.0.1:${address.port}/app.tgz`);
  const archive = join(directory, 'app.tgz');
  await downloadRelease(release, archive);
  assert.deepEqual(await readFile(archive), contents);
  await rm(archive);
  await assert.rejects(
    downloadRelease({...release, sha256: '0'.repeat(64)}, archive),
    /checksum/,
  );
  await assert.rejects(access(archive));
  for (const invalid of [
    {revision: '../invalid'},
    {version: '../../0.1.0'},
    {sha256: 'invalid'},
  ]) {
    manifest = {...valid, ...invalid};
    await assert.rejects(readRelease(url), /Invalid.*manifest/);
  }
  manifest = {...valid, url: 'http://example.com/app.tgz'};
  await assert.rejects(readRelease(url), /HTTPS/);
  status = 503;
  await assert.rejects(readRelease(url), /503/);
  await assert.rejects(downloadRelease(release, archive), /503/);
  await assert.rejects(readRelease('http://example.com/latest.json'), /HTTPS/);

  // No package installation or PATH edits can run after a corrupt download.
  status = 200;
  manifest = {...valid, sha256: '0'.repeat(64)};
  const prefix = join(directory, 'install space');
  await assert.rejects(
    install(['--prefix', prefix, '--feed', url, '--no-path']),
    /checksum/,
  );
  assert.deepEqual(await readdir(prefix), []);
});

void test(
  'release download progress reports received bytes and only known totals',
  {timeout: 10_000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'web-progress-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const contents = Buffer.from('a release archive delivered in chunks');
    const server = createServer((request, response) => {
      if (request.url === '/known')
        response.setHeader('Content-Length', contents.length);
      response.write(contents.subarray(0, 4));
      setTimeout(() => response.end(contents.subarray(4)), 150);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(
      () =>
        new Promise<void>(resolve => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    for (const kind of ['known', 'unknown']) {
      const progress: {transferredBytes: number; totalBytes?: number}[] = [];
      const archive = join(directory, `${kind}.tgz`);
      await downloadRelease(
        {
          version: '0.1.0',
          revision: 'a'.repeat(40),
          url: `http://127.0.0.1:${address.port}/${kind}`,
          sha256: createHash('sha256').update(contents).digest('hex'),
        },
        archive,
        2_000,
        next => progress.push(next),
      );
      assert.equal(progress[0].transferredBytes, 0);
      assert.ok(
        progress.some(
          next =>
            next.transferredBytes > 0 &&
            next.transferredBytes < contents.length,
        ),
      );
      assert.equal(progress.at(-1)?.transferredBytes, contents.length);
      assert.ok(
        progress.every(
          next =>
            next.totalBytes ===
            (kind === 'known' ? contents.length : undefined),
        ),
      );
      assert.deepEqual(await readFile(archive), contents);
    }
  },
);

void test('installer rejects missing values and unknown options before doing any work', async () => {
  await assert.rejects(install(['--prefix']), /Missing value/);
  await assert.rejects(install(['--unknown', 'value']), /Unknown option/);
});

void test(
  'CMD installer detects npm, forwards quoted arguments and propagates failures',
  {skip: process.platform !== 'win32'},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'cmd-installer-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    let status = 200;
    let exitCode = 0;
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(status);
      response.end(
        `export function install(args) { console.log(JSON.stringify(args)); process.exitCode = ${exitCode}; }`,
      );
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(
      () =>
        new Promise<void>(resolve => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const script = fileURLToPath(
      new URL('../scripts/install.cmd', import.meta.url),
    );
    const prefix = join(directory, 'app space');
    const command = `"${script}" --prefix "${prefix}" --no-path`;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      VARISDEV_INSTALLER_URL: `http://127.0.0.1:${address.port}/install.mjs`,
    };
    for (const key of Object.keys(env))
      if (key.toLowerCase() === 'path') delete env[key];
    env.PATH = directory;
    const node = join(directory, 'node.exe');
    const npm = join(directory, 'npm.cmd');
    const npmBatch = '@echo off\r\necho 11.6.1\r\nexit /b 0\r\n';
    await copyFile(process.execPath, node);
    await writeFile(npm, npmBatch);
    const options = {
      cwd: directory,
      env,
      shell: process.env.ComSpec,
      timeout: 10000,
    };
    const run = promisify(exec);
    const result = await run(command, options);
    assert.deepEqual(JSON.parse(result.stdout), [
      '--prefix',
      prefix,
      '--no-path',
    ]);
    exitCode = 7;
    await assert.rejects(run(command, options), {code: 7});
    status = 503;
    await assert.rejects(run(command, options), error => {
      assert.equal((error as {code?: number}).code, 1);
      assert.match(
        (error as {stderr: string}).stderr,
        /download failed \(503\)/,
      );
      return true;
    });
    status = 200;
    exitCode = 0;
    await rm(npm);
    for (const name of ['npm.bat', 'npm.exe']) {
      await t.test(`accepts ${name} without npm.cmd`, async () => {
        const shim = join(directory, name);
        // Node provides a native executable accepting --version for the probe.
        if (name.endsWith('.exe')) await copyFile(process.execPath, shim);
        else await writeFile(shim, npmBatch);
        const result = await run(command, options);
        assert.deepEqual(JSON.parse(result.stdout), [
          '--prefix',
          prefix,
          '--no-path',
        ]);
        await rm(shim);
      });
    }
    const requested = requests;
    for (const broken of [false, true]) {
      await t.test(`rejects ${broken ? 'broken' : 'missing'} npm`, async () => {
        if (broken) await writeFile(npm, '@exit /b 7\r\n');
        await assert.rejects(run(command, options), error => {
          assert.equal((error as {code?: number}).code, 1);
          assert.match((error as {stderr: string}).stderr, /requires npm/);
          return true;
        });
        assert.equal(requests, requested);
        if (broken) await rm(npm);
      });
    }
    await rm(node);
    await assert.rejects(run(command, options), error => {
      assert.equal((error as {code?: number}).code, 1);
      assert.match((error as {stderr: string}).stderr, /requires Node.js 24/);
      return true;
    });
    assert.equal(requests, requested);
    assert.deepEqual(await readdir(directory), []);
  },
);

const appRoot = (prefix: string) =>
  join(
    prefix,
    process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
    'varisdev',
  );
const appBin = (prefix: string) =>
  process.platform === 'win32' ? prefix : join(prefix, 'bin');
const appShims =
  process.platform === 'win32'
    ? ['varisdev', 'varisdev.cmd', 'varisdev.ps1']
    : ['varisdev'];

async function put(path: string, contents: string) {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, contents);
}

async function snapshot(directory: string) {
  const files: Record<string, string> = {};
  async function visit(relative: string) {
    const path = join(directory, relative);
    const info = await lstat(path);
    if (info.isSymbolicLink()) files[relative] = `link:${await readlink(path)}`;
    else if (info.isDirectory()) {
      files[relative] = 'directory';
      for (const name of (await readdir(path)).sort())
        await visit(join(relative, name));
    } else
      files[relative] =
        `${info.mode}:${(await readFile(path)).toString('base64')}`;
  }
  await visit('');
  return files;
}

async function installerFixture(t: TestContext, savedDataDir = false) {
  const directory = await mkdtemp(join(tmpdir(), 'web-install space-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const source = join(directory, 'source');
  const prefix = join(directory, 'shared prefix');
  const dataDir = join(directory, 'selected data');
  const home = join(directory, 'home');
  await mkdir(home);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, 'AppData/Local'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    SHELL: join(home, 'missing-shell'),
    VARISDEV_DATA_DIR: savedDataDir
      ? join(directory, 'fallback data')
      : dataDir,
    VARISDEV_TEST_LOCK_DIR: dataDir,
    VARISDEV_TEST_LAUNCHER: join(directory, 'launcher.json'),
    npm_config_cache: join(directory, 'npm-cache'),
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
  };
  const settings = environmentPath(env);
  if (savedDataDir)
    await put(settings, JSON.stringify({VARISDEV_DATA_DIR: dataDir}));
  const installer = join(directory, 'released/install.mjs');
  await mkdir(dirname(installer));
  await copyFile(
    new URL('../src/runtime/distribution.mjs', import.meta.url),
    installer,
  );
  for (const file of ['environment.mjs', 'node-version.mjs'])
    await put(
      join(source, 'src/runtime', file),
      await readFile(
        new URL(`../src/runtime/${file}`, import.meta.url),
        'utf8',
      ),
    );
  await put(
    join(source, 'bin/varisdev.mjs'),
    `#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
if (process.env.VARISDEV_TEST_FAIL === 'version') process.exit(7);
console.log(JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version);
`,
  );
  await put(
    join(source, 'scripts/install-desktop.mjs'),
    `import {existsSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {setTimeout} from 'node:timers/promises';
if (!existsSync(join(process.env.VARISDEV_TEST_LOCK_DIR, 'update.lock/owner.json')))
  throw new Error('Preparation must hold the update lock');
await writeFile('prepared.json', JSON.stringify({root: process.cwd(), fallback: process.env.VARISDEV_DATA_DIR}));
if (process.env.VARISDEV_TEST_PREPARING) {
  await writeFile(process.env.VARISDEV_TEST_PREPARING, 'preparing');
  while (!existsSync(process.env.VARISDEV_TEST_PREPARE_GATE)) await setTimeout(20);
}
if (process.env.VARISDEV_TEST_FAIL === 'prepare') process.exit(7);
for (const file of [
  'desktop/build/src/dashboard/parent.js',
  'desktop/build/src/runtime/cli.js',
  'desktop/build/src/desktop/main.js',
  'assets/dashboard/index.html',
  'assets/desktop/preload.cjs',
]) {
  await mkdir(dirname(file), {recursive: true});
  await writeFile(file, '');
}
for (const [file, value] of [
  ['desktop/node_modules/@earendil-works/pi-coding-agent/package.json', {version: '1.0.0'}],
  ['node_modules/npm/package.json', {exports: {'./package.json': './package.json'}}],
]) {
  await mkdir(dirname(file), {recursive: true});
  await writeFile(file, JSON.stringify(value));
}
await mkdir('node_modules/npm/bin', {recursive: true});
await writeFile('node_modules/npm/bin/npm-cli.js', '');
const manifest = JSON.parse(await readFile('package.json'));
if (process.env.VARISDEV_TEST_FAIL === 'manifest') {
  manifest.version = '9.9.9';
  await writeFile('package.json', JSON.stringify(manifest));
}
if (process.env.VARISDEV_TEST_FAIL === 'revision')
  await writeFile('build-info.json', JSON.stringify({revision: 'f'.repeat(40)}));
`,
  );
  await put(
    join(source, 'scripts/desktop-app.mjs'),
    `import {writeFile} from 'node:fs/promises';
if (process.env.VARISDEV_TEST_FAIL === 'launcher') process.exit(7);
await writeFile(process.env.VARISDEV_TEST_LAUNCHER, JSON.stringify({root: process.cwd(), installRoot: process.env.VARISDEV_INSTALL_ROOT}));
`,
  );
  const npm = fileURLToPath(
    new URL('../node_modules/npm/bin/npm-cli.js', import.meta.url),
  );
  const archives: Buffer[] = [];
  const releases: Release[] = [];
  for (const [version, revision] of [
    ['0.1.0', 'a'.repeat(40)],
    ['0.2.0', 'b'.repeat(40)],
  ]) {
    await put(
      join(source, 'package.json'),
      JSON.stringify({
        name: 'varisdev',
        version,
        type: 'module',
        bin: {varisdev: 'bin/varisdev.mjs'},
      }),
    );
    await put(
      join(source, 'build-info.json'),
      JSON.stringify({revision, source: releaseURL}),
    );
    await runRuntimeCommand(
      process.execPath,
      [npm, 'pack', '--ignore-scripts', '--pack-destination', directory],
      {
        cwd: source,
        env,
        timeoutMs: 30_000,
      },
    );
    const contents = await readFile(join(directory, `varisdev-${version}.tgz`));
    archives.push(contents);
    releases.push({
      version,
      revision,
      url: './app.tgz',
      sha256: createHash('sha256').update(contents).digest('hex'),
    });
  }
  let selected = 0;
  let corruptPackage = false;
  const brokenArchive = Buffer.from('not an npm archive');
  const server = createServer((request, response) => {
    response.end(
      request.url === '/latest.json'
        ? JSON.stringify(
            corruptPackage
              ? {
                  ...releases[selected],
                  sha256: createHash('sha256')
                    .update(brokenArchive)
                    .digest('hex'),
                }
              : releases[selected],
          )
        : corruptPackage
          ? brokenArchive
          : archives[selected],
    );
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/latest.json`;
  const runner = fileURLToPath(
    new URL('./fixtures/web-install.mjs', import.meta.url),
  );
  const runInstall = (extraEnv: NodeJS.ProcessEnv = {}) =>
    runRuntimeCommand(
      process.execPath,
      [runner, installer, '--prefix', prefix, '--feed', url, '--no-path'],
      {
        cwd: directory,
        env: {...env, ...extraEnv},
        timeoutMs: 30_000,
      },
    );
  await runInstall();
  selected = 1;
  const root = appRoot(prefix);
  const manager = new RuntimeManager({
    installRoot: root,
    dataDir,
    hooks: {
      readRelease: async () => ({
        ...releases[1],
        version: '0.3.0',
        revision: 'c'.repeat(40),
      }),
      downloadRelease: async (_release, archive) => {
        await writeFile(archive, 'unused');
      },
      run: async (_command, args) => {
        if (args[0].endsWith('npm-cli.js')) {
          const target = appRoot(args[args.indexOf('--prefix') + 1]);
          await cp(root, target, {recursive: true});
          const manifest = JSON.parse(
            await readFile(join(target, 'package.json'), 'utf8'),
          );
          manifest.version = '0.3.0';
          await writeFile(
            join(target, 'package.json'),
            JSON.stringify(manifest),
          );
          await writeFile(
            join(target, 'build-info.json'),
            JSON.stringify({revision: 'c'.repeat(40)}),
          );
        }
      },
      smokeImport: async () => {},
    },
  });
  assert.equal((await manager.update()).phase, 'ready');
  const active = await manager.currentRoot();
  assert.notEqual(active, root);
  await put(
    join(dirname(root), 'unrelated/package.json'),
    '{"name":"unrelated"}',
  );
  await put(join(dirname(root), '.package-lock.json'), 'shared npm metadata');
  await put(join(appBin(prefix), 'unrelated'), 'unrelated command');
  return {
    directory,
    prefix,
    dataDir,
    env,
    root,
    active,
    manager,
    settings,
    runInstall,
    corruptPackage(value: boolean) {
      corruptPackage = value;
    },
  };
}

void test(
  'failed reinstall preserves the base, selected runtime, shared prefix and launcher; retry promotes verified package and shims',
  {timeout: 180_000},
  async t => {
    const f = await installerFixture(t);
    const original = await snapshot(f.prefix);
    const pointer = await readFile(join(f.dataDir, 'active.json'), 'utf8');
    const launcher =
      process.platform === 'linux'
        ? undefined
        : await readFile(f.env.VARISDEV_TEST_LAUNCHER!);
    const failures = [
      {name: 'npm install', env: {}, npm: true},
      ...['prepare', 'manifest', 'revision', 'version'].map(name => ({
        name,
        env: {VARISDEV_TEST_FAIL: name},
        npm: false,
      })),
      ...['package', ...appShims].map(name => ({
        name: `promoting ${name}`,
        env: {VARISDEV_TEST_PROMOTION_FAILURE: name},
        npm: false,
      })),
      ...(process.platform === 'linux'
        ? []
        : [
            {
              name: 'launcher',
              env: {VARISDEV_TEST_FAIL: 'launcher'},
              npm: false,
            },
          ]),
    ];
    for (const failure of failures) {
      await t.test(failure.name, async () => {
        f.corruptPackage(failure.npm);
        await assert.rejects(
          f.runInstall(failure.env),
          /Installation command failed|does not match|Injected promotion failure/,
        );
        f.corruptPackage(false);
        assert.deepEqual(await snapshot(f.prefix), original);
        assert.equal(
          await readFile(join(f.dataDir, 'active.json'), 'utf8'),
          pointer,
        );
        assert.equal(await f.manager.currentRoot(), f.active);
        await assert.rejects(access(join(f.dataDir, 'update.lock')));
        if (launcher)
          assert.deepEqual(
            await readFile(f.env.VARISDEV_TEST_LAUNCHER!),
            launcher,
          );
      });
    }
    await f.runInstall();
    assert.equal(
      JSON.parse(await readFile(join(f.root, 'package.json'), 'utf8')).version,
      '0.2.0',
    );
    assert.equal(await f.manager.currentRoot(), f.root);
    assert.equal(
      await readFile(join(f.dataDir, 'active.json'), 'utf8'),
      pointer,
    );
    assert.equal(
      await readFile(join(dirname(f.root), 'unrelated/package.json'), 'utf8'),
      '{"name":"unrelated"}',
    );
    assert.equal(
      await readFile(join(dirname(f.root), '.package-lock.json'), 'utf8'),
      'shared npm metadata',
    );
    assert.equal(
      await readFile(join(appBin(f.prefix), 'unrelated'), 'utf8'),
      'unrelated command',
    );
    assert.ok(
      (await readdir(f.prefix)).every(
        name => !name.startsWith('.varisdev-install-'),
      ),
    );
    if (process.platform === 'win32') {
      for (const name of appShims)
        assert.doesNotMatch(
          await readFile(join(appBin(f.prefix), name), 'utf8'),
          /varisdev-install-/,
        );
      assert.equal(
        (
          await runRuntimeCommand(
            'cmd.exe',
            ['/d', '/c', join(f.prefix, 'varisdev.cmd'), '--version'],
            {cwd: f.directory, env: f.env, timeoutMs: 10_000},
          )
        ).trim(),
        '0.2.0',
      );
    } else {
      assert.equal(
        await realpath(join(appBin(f.prefix), 'varisdev')),
        join(f.root, 'bin/varisdev.mjs'),
      );
      assert.equal(
        (
          await runRuntimeCommand(
            join(appBin(f.prefix), 'varisdev'),
            ['--version'],
            {cwd: f.directory, env: f.env, timeoutMs: 10_000},
          )
        ).trim(),
        '0.2.0',
      );
    }
    if (process.platform !== 'linux')
      assert.deepEqual(
        JSON.parse(await readFile(f.env.VARISDEV_TEST_LAUNCHER!, 'utf8')),
        {root: f.root, installRoot: await realpath(f.root)},
      );
  },
);

async function waitForFile(path: string) {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() >= deadline)
        throw new Error(`Timed out waiting for ${path}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}

void test(
  'installer and updater share the saved data directory lock through preparation and promotion without persisting fallbacks',
  {timeout: 90_000},
  async t => {
    const f = await installerFixture(t, true);
    const saved = await readFile(f.settings, 'utf8');
    const before = await snapshot(f.root);
    const preparing = join(f.directory, 'preparing');
    const gate = join(f.directory, 'prepare-gate');
    const unlock = await acquireUpdateLock(f.dataDir);
    assert.ok(unlock);
    t.after(unlock);
    const installing = f.runInstall({
      VARISDEV_TEST_PREPARING: preparing,
      VARISDEV_TEST_PREPARE_GATE: gate,
    });
    // Find the unpacked helper so the check does not depend on npm startup speed.
    const deadline = Date.now() + 10_000;
    while (true) {
      const temporary = (await readdir(f.prefix)).find(name =>
        name.startsWith('.varisdev-install-'),
      );
      if (temporary) {
        try {
          await access(
            join(
              appRoot(join(f.prefix, temporary, 'stage')),
              'src/runtime/environment.mjs',
            ),
          );
          break;
        } catch {
          // npm has not finished unpacking the helper yet.
        }
      }
      if (Date.now() >= deadline)
        throw new Error('Timed out waiting for staged npm install');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await new Promise(resolve => setTimeout(resolve, 250));
    await assert.rejects(access(preparing));
    assert.deepEqual(await snapshot(f.root), before);
    assert.equal(await f.manager.currentRoot(), f.active);
    await unlock();
    await waitForFile(preparing);
    assert.equal(await acquireUpdateLock(f.dataDir, {wait: false}), undefined);
    const updating = f.manager.update();
    assert.equal(f.manager.status().progress?.stage, 'waiting');
    await put(gate, 'continue');
    await installing;
    assert.equal((await updating).phase, 'ready');
    await assert.rejects(access(join(f.dataDir, 'update.lock')));
    await assert.rejects(access(f.env.VARISDEV_DATA_DIR!));
    assert.equal(await readFile(f.settings, 'utf8'), saved);
    const prepared = JSON.parse(
      await readFile(join(f.root, 'prepared.json'), 'utf8'),
    );
    assert.equal(prepared.fallback, f.env.VARISDEV_DATA_DIR);
    assert.match(prepared.root, /varisdev-install-/);
  },
);

void test(
  'a failed rollback keeps the previous package available for recovery and releases the update lock',
  {timeout: 90_000},
  async t => {
    const f = await installerFixture(t);
    await assert.rejects(
      f.runInstall({
        VARISDEV_TEST_PROMOTION_FAILURE: appShims.at(-1),
        VARISDEV_TEST_ROLLBACK_FAILURE: '1',
      }),
      /Could not restore the previous installation\. Recovery files remain in/,
    );
    const recovery = (await readdir(f.prefix)).filter(name =>
      name.startsWith('.varisdev-install-'),
    );
    assert.equal(recovery.length, 1);
    const previous = join(f.prefix, recovery[0], 'previous/0');
    assert.equal(
      JSON.parse(await readFile(join(previous, 'package.json'), 'utf8'))
        .version,
      '0.1.0',
    );
    await assert.rejects(access(join(f.dataDir, 'update.lock')));
    await assert.rejects(access(f.root));
    await rename(previous, f.root);
    await rm(join(f.prefix, recovery[0]), {recursive: true, force: true});
    assert.equal(await f.manager.currentRoot(), f.active);
    await f.runInstall();
    assert.equal(
      JSON.parse(await readFile(join(f.root, 'package.json'), 'utf8')).version,
      '0.2.0',
    );
  },
);
