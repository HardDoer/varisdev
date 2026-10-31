import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test, type TestContext} from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {publicUpdateStatus} from '../src/desktop/updates.ts';
import {releaseURL} from '../src/runtime/distribution.mjs';
import {RuntimeManager, type UpdateStatus} from '../src/runtime/manager.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(fulfill => {
    resolve = fulfill;
  });
  return {promise, resolve};
}

async function put(path: string, value = '') {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, value);
}

async function updatingRuntime(t: TestContext, fail: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-update-shutdown-'));
  const installRoot = join(directory, 'install');
  const dataDir = join(directory, 'data');
  const installing = deferred();
  const finishInstall = deferred();
  let installs = 0;
  t.after(async () => {
    finishInstall.resolve();
    await runtime.waitForUpdate();
    await rm(directory, {recursive: true, force: true});
  });
  await put(
    join(installRoot, 'package.json'),
    JSON.stringify({name: 'varisdev', version: '0.1.0'}),
  );
  await put(
    join(installRoot, 'build-info.json'),
    JSON.stringify({revision: 'a'.repeat(40), source: releaseURL}),
  );
  await put(
    join(installRoot, 'node_modules/npm/package.json'),
    '{"exports":{"./package.json":"./package.json"}}',
  );
  const revision = 'b'.repeat(40);
  const runtime = new RuntimeManager({
    installRoot,
    dataDir,
    hooks: {
      readRelease: async () => ({
        version: '0.2.0',
        revision,
        url: 'https://example.com/varisdev.tgz',
        sha256: 'a'.repeat(64),
      }),
      downloadRelease: async (_release, destination) => put(destination),
      run: async (_command, args, options) => {
        if (args[1] !== 'install') return;
        installs++;
        installing.resolve();
        await finishInstall.promise;
        if (fail) throw new Error('Fixture installer failed');
        const root = join(
          options.cwd,
          process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
          'varisdev',
        );
        await put(
          join(root, 'package.json'),
          JSON.stringify({name: 'varisdev', version: '0.2.0'}),
        );
        await put(join(root, 'build-info.json'), JSON.stringify({revision}));
        await put(
          join(
            root,
            'desktop/node_modules/@earendil-works/pi-coding-agent/package.json',
          ),
          '{"version":"1.4.0"}',
        );
        for (const file of [
          'bin/varisdev.mjs',
          'src/runtime/environment.mjs',
          'src/runtime/node-version.mjs',
          'assets/dashboard/index.html',
          'assets/desktop/preload.cjs',
          'desktop/build/src/runtime/cli.js',
          'desktop/build/src/desktop/main.js',
          'desktop/build/src/dashboard/parent.js',
        ])
          await put(join(root, file));
      },
      smokeImport: async () => {},
    },
  });
  return {
    runtime,
    installing,
    finishInstall,
    lock: join(dataDir, 'update.lock'),
    installs: () => installs,
  };
}

async function desktopLifecycle(runtime: RuntimeManager, closeError?: Error) {
  const source = await readFile(
    new URL('../src/desktop/application.ts', import.meta.url),
    'utf8',
  );
  const parsed = ts.createSourceFile(
    'application.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const pieces: string[] = [];
  for (const statement of parsed.statements) {
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        declaration =>
          declaration.name.getText(parsed) === 'unsubscribeUpdates',
      )
    )
      pieces.push(statement.getText(parsed));
    if (statement.getText(parsed).startsWith("app.on('before-quit',"))
      pieces.push(statement.getText(parsed));
    if (!ts.isFunctionDeclaration(statement)) continue;
    const name = statement.name?.text;
    if (name && ['isLocalPage', 'trusted', 'handle', 'shutdown'].includes(name))
      pieces.push(statement.getText(parsed));
    const handler = statement.body?.statements.find(item =>
      item
        .getText(parsed)
        .startsWith(
          name === 'createWindow'
            ? "mainWindow.on('close',"
            : "handle('varisdev:install-update',",
        ),
    );
    if (handler && ['createWindow', 'installHandlers'].includes(name!))
      pieces.push(handler.getText(parsed));
  }
  assert.equal(
    pieces.length,
    8,
    'Load the production quit and update adapters',
  );

  const exited = deferred();
  const closingSessions = deferred();
  const finishSessions = deferred();
  const app = new EventEmitter() as EventEmitter & {quit(): void};
  let didExit = false;
  app.quit = () => {
    let prevented = false;
    app.emit('before-quit', {
      preventDefault: () => {
        prevented = true;
      },
    });
    if (!prevented) {
      didExit = true;
      exited.resolve();
    }
  };
  const window = new EventEmitter();
  const pageUrl = new URL('file:///varisdev/index.html');
  const updates: UpdateStatus[] = [];
  const errors: unknown[][] = [];
  let updateUnsubscribes = 0;
  const webContents = {
    mainFrame: {url: pageUrl.href},
    isDestroyed: () => false,
    send: (channel: string, status: UpdateStatus) => {
      assert.equal(channel, 'varisdev:update-status');
      updates.push(status);
    },
  };
  Object.assign(window, {webContents, isDestroyed: () => false});
  const handlers = new Map<
    string,
    (event: unknown) => Promise<{ok: boolean; value?: {phase: string}}>
  >();
  let sessionCloses = 0;
  let snapshotDisposals = 0;
  const context = {
    app,
    mainWindow: window,
    runtime: {
      update: () => runtime.update(),
      waitForUpdate: () => runtime.waitForUpdate(),
      subscribe: (listener: (status: UpdateStatus) => void) => {
        const unsubscribe = runtime.subscribe(listener);
        return () => {
          updateUnsubscribes++;
          unsubscribe();
        };
      },
    },
    pageUrl,
    URL,
    publicUpdateStatus,
    ipcMain: {
      handle: (channel: string, action: (event: unknown) => Promise<never>) =>
        handlers.set(channel, action),
    },
    shuttingDown: false,
    cleanupFinished: false,
    restarting: false,
    snapshotDelivery: {dispose: () => snapshotDisposals++},
    updateTimer: undefined,
    sessionActions: new Set(),
    sessionOperations: 0,
    attachedSessionId: undefined,
    clearTimeout,
    clearInterval,
    unsubscribe: () => {},
    completionSound: {dispose: () => {}},
    terminals: {dispose: () => {}},
    accounts: {dispose: async () => {}},
    requests: {disconnect: () => {}},
    console: {error: (...args: unknown[]) => errors.push(args)},
    hub: {
      close: async () => {
        sessionCloses++;
        closingSessions.resolve();
        await finishSessions.promise;
        if (closeError) throw closeError;
      },
    },
  };
  vm.runInNewContext(
    ts.transpileModule(pieces.join('\n'), {
      compilerOptions: {target: ts.ScriptTarget.ES2024},
    }).outputText,
    context,
  );
  return {
    app,
    window,
    exited,
    closingSessions,
    finishSessions,
    updates,
    errors,
    updateUnsubscribes: () => updateUnsubscribes,
    didExit: () => didExit,
    sessionCloses: () => sessionCloses,
    snapshotDisposals: () => snapshotDisposals,
    install: () =>
      handlers.get('varisdev:install-update')!({
        sender: webContents,
        senderFrame: webContents.mainFrame,
      }),
  };
}

for (const outcome of ['success', 'failure'] as const)
  for (const quit of ['app', 'window'] as const)
    void test(
      `${quit} quit waits for a pending installer and session shutdown after update ${outcome}`,
      {timeout: 10_000},
      async t => {
        const update = await updatingRuntime(t, outcome === 'failure');
        const desktop = await desktopLifecycle(update.runtime);
        t.after(() => desktop.finishSessions.resolve());
        const installing = desktop.install();
        await update.installing.promise;
        const owner = await readFile(join(update.lock, 'owner.json'), 'utf8');
        assert.equal(JSON.parse(owner).pid, process.pid);
        const beforeQuit = desktop.updates.length;

        if (quit === 'app') desktop.app.quit();
        else {
          let prevented = false;
          desktop.window.emit('close', {
            preventDefault: () => {
              prevented = true;
            },
          });
          assert.equal(prevented, true);
        }
        desktop.app.quit();
        assert.equal((await desktop.install()).ok, false);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(
          desktop.didExit(),
          false,
          'The updater owner must stay alive',
        );
        assert.equal(desktop.sessionCloses(), 0);
        assert.equal(desktop.snapshotDisposals(), 1);
        assert.equal(desktop.updateUnsubscribes(), 0);
        assert.equal(update.installs(), 1);
        assert.equal(
          await readFile(join(update.lock, 'owner.json'), 'utf8'),
          owner,
        );

        update.finishInstall.resolve();
        const result = await installing;
        assert.equal(result.ok, true);
        assert.equal(
          result.value?.phase,
          outcome === 'success' ? 'ready' : 'error',
        );
        await desktop.closingSessions.promise;
        await assert.rejects(stat(update.lock), {code: 'ENOENT'});
        const closingUpdates = desktop.updates.slice(beforeQuit);
        assert.equal(
          closingUpdates.at(-1)?.phase,
          outcome === 'success' ? 'ready' : 'error',
          'Keep forwarding update status while the visible window waits to quit',
        );
        if (outcome === 'success')
          assert.ok(
            closingUpdates.some(
              status => status.progress?.stage === 'verifying',
            ),
          );
        assert.equal(desktop.sessionCloses(), 1);
        assert.equal(
          desktop.didExit(),
          false,
          'Session shutdown must still finish',
        );

        desktop.finishSessions.resolve();
        await desktop.exited.promise;
        assert.equal(desktop.sessionCloses(), 1);
        assert.equal(desktop.updateUnsubscribes(), 1);
        assert.deepEqual(desktop.errors, []);
      },
    );

void test(
  'unexpected session shutdown failure still unsubscribes from updates and quits',
  {timeout: 10_000},
  async t => {
    const update = await updatingRuntime(t, false);
    const error = new Error('Fixture session shutdown failed');
    const desktop = await desktopLifecycle(update.runtime, error);
    t.after(() => desktop.finishSessions.resolve());
    desktop.app.quit();
    await desktop.closingSessions.promise;
    desktop.finishSessions.resolve();
    await desktop.exited.promise;
    assert.equal(desktop.updateUnsubscribes(), 1);
    assert.equal(desktop.snapshotDisposals(), 1);
    assert.equal(desktop.errors.length, 1);
    assert.equal(desktop.errors[0][1], error);
    await update.runtime.check();
    assert.equal(
      desktop.updates.length,
      0,
      'The update subscription must be removed',
    );
  },
);
