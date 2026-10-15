import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {mkdtemp, readFile, readdir, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {promisify} from 'node:util';

void test(
  'shell installer creates a working macOS app with the VarisDev name and current icon',
  {skip: process.platform !== 'darwin', timeout: 180000},
  async t => {
    const home = await mkdtemp(join(tmpdir(), 'varisdev-mac-app-'));
    t.after(() => rm(home, {recursive: true, force: true}));
    const root = fileURLToPath(new URL('../', import.meta.url));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      PI_OFFLINE: '1',
      VARISDEV_SETTINGS_DIR: join(home, 'settings'),
      PI_CODING_AGENT_DIR: join(home, 'regular-pi'),
      VARISDEV_DATA_DIR: join(home, 'data'),
      PIDEV_DESKTOP_DATA_DIR: join(home, 'profile'),
      VARISDEV_NODE_EXECUTABLE: process.execPath,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.VARISDEV_INSTALL_ROOT;
    const release = join(home, 'release');
    await promisify(execFile)(
      process.execPath,
      [join(root, 'scripts/release-web.mjs'), release],
      {timeout: 30000},
    );
    const archive = (await readdir(release)).find(name =>
      name.endsWith('.tgz'),
    )!;
    const server = createServer((request, response) => {
      void readFile(
        join(
          release,
          request.url === '/download'
            ? archive
            : new URL(request.url || '/', 'http://localhost').pathname,
        ),
      )
        .then(bytes => response.end(bytes))
        .catch(() => {
          response.statusCode = 404;
          response.end();
        });
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
    const base = `http://127.0.0.1:${address.port}`;
    const prefix = join(home, 'install space');
    await promisify(execFile)(
      '/bin/sh',
      [
        join(root, 'scripts/install.sh'),
        '--prefix',
        prefix,
        '--feed',
        `${base}/latest.json`,
        '--no-path',
      ],
      {
        env: {...env, VARISDEV_INSTALLER_URL: `${base}/install.mjs`},
        timeout: 120000,
      },
    );
    const bundle = join(home, 'Applications/VarisDev.app');
    for (const key of [
      'CFBundleExecutable',
      'CFBundleName',
      'CFBundleDisplayName',
    ]) {
      const {stdout} = await promisify(execFile)('/usr/libexec/PlistBuddy', [
        '-c',
        `Print :${key}`,
        join(bundle, 'Contents/Info.plist'),
      ]);
      assert.equal(stdout.trim(), 'VarisDev');
    }
    assert.deepEqual(
      await readFile(join(bundle, 'Contents/Resources/varisdev.icns')),
      await readFile(join(root, 'assets/desktop/robot-crow.icns')),
    );
    const config = JSON.parse(
      await readFile(
        join(bundle, 'Contents/Resources/app/launch.json'),
        'utf8',
      ),
    ) as {installRoot: string; runtimeRoot: string; settingsDir: string};
    assert.equal(
      config.installRoot,
      await realpath(join(prefix, 'lib/node_modules/varisdev')),
    );
    assert.equal(config.runtimeRoot, config.installRoot);
    assert.equal(config.settingsDir, env.VARISDEV_SETTINGS_DIR);
    assert.equal(Object.hasOwn(config, 'agentDir'), false);
    const child = spawn(join(bundle, 'Contents/MacOS/VarisDev'), [], {
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    t.after(() => {
      child.kill();
    });
    let output = '';
    child.stdout!.on('data', data => {
      output += String(data);
    });
    child.stderr!.on('data', data => {
      output += String(data);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('App startup timed out: ' + output)),
        30000,
      );
      child.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', code => {
        clearTimeout(timer);
        reject(new Error(`App exited (${code}): ${output}`));
      });
      child.on('message', (message: {type?: string; error?: string}) => {
        if (message.type === 'ready') {
          clearTimeout(timer);
          resolve();
        } else if (message.type === 'startup-error') {
          clearTimeout(timer);
          reject(new Error(message.error));
        }
      });
    });
    assert.doesNotMatch(output, /Received an instance of Object/);
    child.kill();
    await new Promise<void>(resolve => child.once('exit', () => resolve()));
  },
);
