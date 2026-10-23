import assert from 'node:assert/strict';
import {
  execFile as execFileCallback,
  spawn,
  type ChildProcess,
} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {promisify} from 'node:util';
import type {DashboardHubSnapshot} from '../src/dashboard/hub.ts';
import type {UpdateStatus} from '../src/runtime/manager.ts';
import {
  publicUpdateStatus,
  requireUpdateRestart,
  updateRestartCommand,
  updateMessage,
} from '../src/desktop/updates.ts';

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const ready: UpdateStatus = {
  phase: 'ready',
  currentVersion: '0.85.1',
  latestVersion: '0.86.0',
  restartRequired: true,
};
const empty: DashboardHubSnapshot = {launchCwd: '/project', sessions: []};

void test('update restart requires completed staging and idle parent sessions and agents', () => {
  for (const phase of ['idle', 'checking', 'available', 'updating'] as const)
    assert.throws(
      () => requireUpdateRestart({...ready, phase}, empty),
      /Finish updating/,
    );
  assert.throws(
    () => requireUpdateRestart({...ready, restartRequired: false}, empty),
    /Finish updating/,
  );
  assert.throws(
    () => requireUpdateRestart(ready, empty, 1),
    /Wait for workspaces/,
  );
  for (const parentStatus of ['running', 'compacting']) {
    const snapshot = {
      sessions: [{session: {status: parentStatus}, agents: []}],
    } as unknown as DashboardHubSnapshot;
    assert.throws(
      () => requireUpdateRestart(ready, snapshot),
      /Wait for workspaces/,
    );
  }
  for (const agentStatus of ['queued', 'running', 'cancelling']) {
    const snapshot = {
      sessions: [{session: {status: 'idle'}, agents: [{status: agentStatus}]}],
    } as unknown as DashboardHubSnapshot;
    assert.throws(
      () => requireUpdateRestart(ready, snapshot),
      /Wait for workspaces/,
    );
  }
  const queued = {
    sessions: [
      {
        session: {status: 'idle'},
        agents: [],
        queue: {steering: ['pending'], followUp: []},
      },
    ],
  } as unknown as DashboardHubSnapshot;
  assert.throws(
    () => requireUpdateRestart(ready, queued),
    /Wait for workspaces/,
  );
  assert.doesNotThrow(() => requireUpdateRestart(ready, empty));
  assert.doesNotThrow(() =>
    requireUpdateRestart({...ready, phase: 'error'}, empty),
  );
  assert.throws(
    () =>
      requireUpdateRestart(
        {...ready, phase: 'error', restartRequired: false},
        empty,
      ),
    /Finish updating/,
  );
  assert.equal(
    publicUpdateStatus({...ready, phase: 'error', error: 'Offline'}).phase,
    'ready',
  );
});

void test('restart resolves the active generation through the original installation CLI', () => {
  const command = updateRestartCommand(
    '/original root',
    '/node/24',
    '/electron',
    '/project folder',
  );
  assert.equal(command.executable, '/node/24');
  assert.deepEqual(command.args, [
    join('/original root', 'bin', 'varisdev.mjs'),
    '/project folder',
  ]);
  assert.equal(command.env.ELECTRON_RUN_AS_NODE, undefined);
  const development = updateRestartCommand('/original', undefined, '/electron');
  assert.equal(development.executable, '/electron');
  assert.equal(development.env.ELECTRON_RUN_AS_NODE, '1');
  assert.deepEqual(development.args, [
    join('/original', 'bin', 'varisdev.mjs'),
    '--overview',
  ]);
  const publicStatus = publicUpdateStatus({
    ...ready,
    phase: 'error',
    error: 'Pi update failed for @earendil-works/pi-coding-agent',
  });
  assert.equal(
    publicStatus.error,
    'VarisDev update failed for @earendil-works/pi-coding-agent',
  );
  assert.equal(
    updateMessage(
      'Pi session failed: /project/.pi/settings.json and node_modules/@earendil-works/pi-coding-agent/dist/index.js',
    ),
    'VarisDev session failed: /project/.pi/settings.json and node_modules/@earendil-works/pi-coding-agent/dist/index.js',
  );
  assert.equal(
    updateMessage('C:\\Users\\test\\.pi\\auth.json: Pi.'),
    'C:\\Users\\test\\.pi\\auth.json: VarisDev.',
  );
});

void test(
  'desktop update controls and production preload in Electron',
  {
    timeout: 30_000,
    skip:
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY
        ? 'Electron requires a display'
        : false,
  },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-updates-'));
    t.after(() =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      }),
    );
    const reportPath = join(directory, 'report.json');
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    let launchError;
    try {
      await execFile(
        require('electron') as string,
        [
          fileURLToPath(
            new URL('./fixtures/desktop-updates.cjs', import.meta.url),
          ),
          directory,
          reportPath,
          ...(process.env.VARISDEV_TEST_UPDATE_SCREENSHOTS
            ? [process.env.VARISDEV_TEST_UPDATE_SCREENSHOTS]
            : []),
        ],
        {env, timeout: 25_000},
      );
    } catch (error) {
      launchError = error;
    }
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
      error?: string;
      cases: string[];
    };
    assert.ifError(report.error);
    assert.ifError(launchError);
    assert.equal(report.cases.length, 6);
  },
);

void test(
  'standalone desktop secondary launch signals ready and reuses the primary app',
  {
    timeout: 30_000,
    skip:
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY
        ? 'Electron requires a display'
        : false,
  },
  async t => {
    const directory = await mkdtemp(
      join(tmpdir(), 'varisdev-single-instance-'),
    );
    const env = {
      ...process.env,
      PI_OFFLINE: '1',
      PIDEV_DESKTOP_DATA_DIR: join(directory, 'desktop'),
      VARISDEV_SETTINGS_DIR: join(directory, 'agent'),
      PI_CODING_AGENT_DIR: join(directory, 'regular-pi'),
      VARISDEV_DATA_DIR: join(directory, 'data'),
      VARISDEV_INSTALL_ROOT: fileURLToPath(new URL('../', import.meta.url)),
    };
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    const children: ChildProcess[] = [];
    t.after(async () => {
      await Promise.all(
        children.map(
          child =>
            new Promise<void>(resolve => {
              if (child.exitCode !== null || child.signalCode !== null)
                return resolve();
              child.once('close', () => resolve());
              child.kill();
            }),
        ),
      );
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      });
    });
    function launch(): {
      child: ChildProcess;
      ready: Promise<void>;
      exited: Promise<number | null>;
    } {
      const child = spawn(
        require('electron') as string,
        [
          fileURLToPath(
            new URL('../desktop/build/src/desktop/main.js', import.meta.url),
          ),
          '--varisdev-launcher',
        ],
        {env, stdio: ['ignore', 'ignore', 'pipe', 'ipc']},
      );
      children.push(child);
      let errors = '';
      child.stderr?.on('data', value => {
        errors += String(value);
      });
      const exited = new Promise<number | null>(resolve =>
        child.once('exit', resolve),
      );
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Desktop startup timed out: ${errors}`)),
          20_000,
        );
        child.once('error', error => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', code => {
          clearTimeout(timer);
          reject(new Error(`Desktop exited before ready (${code}): ${errors}`));
        });
        child.on('message', message => {
          if (
            message &&
            typeof message === 'object' &&
            'type' in message &&
            message.type === 'ready'
          ) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      return {child, ready, exited};
    }
    const first = launch();
    await first.ready;
    const second = launch();
    await second.ready;
    assert.equal(await second.exited, 0);
    assert.equal(first.child.exitCode, null);
    assert.equal(first.child.signalCode, null);
  },
);

for (const mode of ['node', 'electron'] as const)
  void test(
    `Desktop restart with ${mode} waits for session shutdown and process exit`,
    {
      timeout: 30_000,
      skip:
        process.platform === 'linux' &&
        !process.env.DISPLAY &&
        !process.env.WAYLAND_DISPLAY
          ? 'Electron requires a display'
          : false,
    },
    async t => {
      const directory = await mkdtemp(join(tmpdir(), 'varisdev-relaunch-'));
      t.after(() =>
        rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 20,
          retryDelay: 100,
        }),
      );
      const reportPath = join(directory, 'report.json');
      const env = {...process.env};
      delete env.ELECTRON_RUN_AS_NODE;
      await execFile(
        require('electron') as string,
        [
          fileURLToPath(
            new URL('./fixtures/desktop-relaunch.cjs', import.meta.url),
          ),
          directory,
          reportPath,
          process.execPath,
          mode,
        ],
        {env, timeout: 20_000},
      );
      let result:
        | {
            oldAlive: boolean;
            shutdown: string;
            restore: string;
            runAsNode?: string;
          }
        | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          result = JSON.parse(
            await readFile(reportPath, 'utf8'),
          ) as typeof result;
          break;
        } catch {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      assert.ok(result, 'The replacement must produce a report');
      assert.equal(result.oldAlive, false);
      assert.equal(result.shutdown, 'sessions closed\nprocess exited\n');
      assert.equal(result.restore, join(directory, 'update-restart.json'));
      assert.equal(result.runAsNode, mode === 'electron' ? '1' : undefined);
    },
  );
