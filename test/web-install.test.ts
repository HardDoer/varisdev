import assert from 'node:assert/strict';
import {exec} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  access,
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {
  downloadRelease,
  install,
  readRelease,
} from '../src/runtime/distribution.mjs';

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
