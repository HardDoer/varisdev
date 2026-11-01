import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, readdir, realpath, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {runCommand} from '../scripts/test-installer.mjs';
import {runTerminalProcess} from './fixtures/terminal-process.mjs';

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
    await runCommand(
      process.execPath,
      [join(root, 'scripts/release-web.mjs'), release],
      {timeoutMs: 30000},
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
    const installStartedAt = Date.now();
    await runCommand(
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
        timeoutMs: 120000,
      },
    );
    const bundle = join(home, 'Applications/VarisDev.app');
    for (const key of [
      'CFBundleExecutable',
      'CFBundleName',
      'CFBundleDisplayName',
    ]) {
      const {stdout} = await runTerminalProcess(
        '/usr/libexec/PlistBuddy',
        ['-c', `Print :${key}`, join(bundle, 'Contents/Info.plist')],
        {timeoutMs: 5000},
      );
      assert.equal(stdout.trim(), 'VarisDev');
    }
    assert.ok(
      (await stat(bundle)).mtimeMs >= installStartedAt - 1000,
      'The installed bundle must have a fresh modification time for macOS icon updates.',
    );
    const {stdout: iconFile} = await runTerminalProcess(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleIconFile', join(bundle, 'Contents/Info.plist')],
      {timeoutMs: 5000},
    );
    assert.equal(iconFile.trim(), 'varisdev.icns');
    await runTerminalProcess(
      '/usr/bin/codesign',
      ['--verify', '--deep', '--strict', bundle],
      {timeoutMs: 15000},
    );
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
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    };
    // Register exit observation before startup so an early exit cannot be missed.
    const closed = new Promise<void>(resolve =>
      child.once('close', () => resolve()),
    );
    const cleanup = async () => {
      stop();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              process.stderr.write('App cleanup timed out after 5000 ms\n');
              reject(new Error('App cleanup timed out'));
            }, 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    t.after(cleanup);
    let output = '';
    child.stdout!.on('data', data => {
      output += String(data);
    });
    child.stderr!.on('data', data => {
      output += String(data);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        process.stderr.write('App startup timed out after 30000 ms\n');
        stop();
        reject(new Error('App startup timed out: ' + output));
      }, 30000);
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
    await cleanup();
  },
);
