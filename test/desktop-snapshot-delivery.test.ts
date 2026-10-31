import assert from 'node:assert/strict';
import type {ChildProcess} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {runRuntimeCommand} from '../src/runtime/manager.ts';
import {test} from 'node:test';
import {DashboardHub, type DashboardHubSnapshot} from '../src/dashboard/hub.ts';
import {DesktopSnapshotDelivery} from '../src/desktop/snapshot-delivery.ts';
import {
  DashboardState,
  type DashboardSnapshot,
} from '../src/dashboard/state.ts';
import {
  createFactoryBridge,
  type FactoryControl,
} from '../src/desktop/launcher.ts';

class SnapshotWindow extends EventEmitter {
  visible = true;
  minimized = false;
  destroyed = false;
  contentsDestroyed = false;
  readonly snapshots: DashboardHubSnapshot[] = [];
  readonly webContents = {
    isDestroyed: () => this.contentsDestroyed,
    send: (channel: string, snapshot: DashboardHubSnapshot) => {
      assert.equal(channel, 'pidev:snapshot');
      this.snapshots.push(snapshot);
    },
  };

  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible;
  }
  isMinimized() {
    return this.minimized;
  }
}

class BackpressuredChild extends EventEmitter {
  connected = true;
  readonly snapshots: DashboardSnapshot[] = [];
  readonly acknowledgements: Array<() => void> = [];

  send(
    message: {type: string; snapshot?: DashboardSnapshot},
    done: () => void,
  ) {
    if (message.type === 'snapshot') {
      this.snapshots.push(message.snapshot!);
      this.acknowledgements.push(done);
    } else done();
    return false;
  }

  acknowledge() {
    const done = this.acknowledgements.shift();
    assert.ok(done, 'A snapshot must be in flight');
    done();
  }
}

function state() {
  const at = '2026-01-01T12:00:00.000Z';
  return new DashboardState({
    id: 'parent',
    name: 'Parent',
    cwd: process.cwd(),
    status: 'idle',
    activity: 'Ready',
    startedAt: at,
    updatedAt: at,
  });
}

const control: FactoryControl = {
  prompt: async () => {},
  abort: async () => ({steering: [], followUp: []}),
  cancelAgent: async () => {},
  features: async () => ({
    commands: [],
    models: [],
    thinkingLevel: 'off',
    thinkingLevels: [],
    tools: [],
    diagnostics: [],
  }),
  configure: async () => {},
  compact: async () => {},
  reload: async () => {},
};

void test('a prompt snapshot resumed after backpressure consumes the pending flush', t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const child = new BackpressuredChild();
  const bridge = createFactoryBridge(child as unknown as ChildProcess);
  t.after(() => bridge.detach());
  const current = state();
  current.updateConversation({
    id: 'retained-tool',
    role: 'tool',
    toolName: 'read',
    text: 'Retained tool output\n'.repeat(100_000),
    at: '2026-01-01T12:00:00.000Z',
    status: 'completed',
  });
  bridge.attach(current, control);
  bridge.ready();
  assert.equal(child.snapshots.length, 1);

  current.updateConversation({
    id: 'submitted-prompt',
    role: 'user',
    text: 'Continue the work',
    at: '2026-01-01T12:00:01.000Z',
  });
  t.mock.timers.tick(80); // The first flush encounters the busy transport.
  current.updateSession({status: 'running', activity: 'Thinking'});
  child.acknowledge(); // Resume with the latest state, including the prompt.
  assert.equal(child.snapshots.length, 2);
  assert.equal(child.snapshots[1].conversation.at(-1)?.id, 'submitted-prompt');
  assert.equal(child.snapshots[1].session.activity, 'Thinking');
  child.acknowledge();
  t.mock.timers.tick(80);
  assert.equal(
    child.snapshots.length,
    2,
    'The pending timer must not serialize the same complete thread again',
  );

  current.updateSession({activity: 'Responding'});
  t.mock.timers.tick(80);
  assert.equal(child.snapshots.length, 3);
  assert.equal(child.snapshots[2].session.activity, 'Responding');
  child.acknowledge();
});

void test('changes arriving before an in-flight snapshot flush retain their scheduled delivery', t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const child = new BackpressuredChild();
  const bridge = createFactoryBridge(child as unknown as ChildProcess);
  t.after(() => bridge.detach());
  const current = state();
  bridge.attach(current, control);
  bridge.ready();
  current.updateSession({activity: 'Starting'});
  t.mock.timers.tick(40);
  child.acknowledge();
  assert.equal(child.snapshots.length, 1);
  t.mock.timers.tick(40);
  assert.equal(child.snapshots.length, 2);
  assert.equal(child.snapshots[1].session.activity, 'Starting');
  child.acknowledge();
});

void test('desktop delivery batches streaming updates and suspends snapshot construction while hidden', t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const current = state();
  const hub = new DashboardHub(current, async () => {
    throw new Error('No workspace creation expected');
  });
  t.after(() => hub.close());
  const snapshots = t.mock.method(hub, 'deliverySnapshot');
  const delivery = new DesktopSnapshotDelivery(hub);
  t.after(() => delivery.dispose());
  const window = new SnapshotWindow();
  delivery.attach(window);
  t.mock.timers.tick(80);
  assert.equal(window.snapshots.length, 1);
  assert.equal(snapshots.mock.callCount(), 1);

  const stream = (count: number) => {
    for (let i = 1; i <= count; i++)
      current.updateConversation({
        id: 'stream',
        role: 'assistant',
        at: '2026-01-01T12:00:00.000Z',
        text: 'x'.repeat(i),
        streaming: true,
      });
  };
  stream(100);
  t.mock.timers.tick(79);
  assert.equal(snapshots.mock.callCount(), 1);
  t.mock.timers.tick(1);
  assert.equal(window.snapshots.length, 2);
  assert.equal(
    window.snapshots[1].sessions[0].conversation[0].text.length,
    100,
  );

  stream(101);
  window.visible = false;
  window.emit('hide');
  for (let i = 0; i < 10; i++) {
    stream(110 + i);
    t.mock.timers.tick(80);
  }
  assert.equal(snapshots.mock.callCount(), 2);
  assert.equal(window.snapshots.length, 2);
  window.visible = true;
  window.emit('show');
  t.mock.timers.tick(80);
  assert.equal(window.snapshots.length, 3);
  assert.equal(
    window.snapshots[2].sessions[0].conversation[0].text.length,
    119,
  );
  t.mock.timers.tick(800);
  assert.equal(window.snapshots.length, 3);
});

void test('minimize, window replacement and shutdown retain only deliverable updates', t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const current = state();
  const hub = new DashboardHub(current, async () => {
    throw new Error('No workspace creation expected');
  });
  t.after(() => hub.close());
  const delivery = new DesktopSnapshotDelivery(hub);
  t.after(() => delivery.dispose());
  const window = new SnapshotWindow();
  delivery.attach(window);
  window.minimized = true;
  window.emit('minimize');
  current.updateSession({activity: 'Working in the background'});
  t.mock.timers.tick(800);
  assert.equal(window.snapshots.length, 0);
  window.minimized = false;
  window.emit('restore');
  window.emit('show');
  t.mock.timers.tick(80);
  assert.equal(window.snapshots.length, 1);
  assert.equal(
    window.snapshots[0].sessions[0].session.activity,
    'Working in the background',
  );

  current.updateSession({activity: 'Next update'});
  const replacement = new SnapshotWindow();
  delivery.attach(replacement);
  assert.equal(window.eventNames().length, 0);
  t.mock.timers.tick(80);
  assert.equal(window.snapshots.length, 1);
  assert.equal(replacement.snapshots.length, 1);
  assert.equal(
    replacement.snapshots[0].sessions[0].session.activity,
    'Next update',
  );

  current.updateSession({activity: 'Pending at close'});
  replacement.destroyed = true;
  replacement.emit('closed');
  t.mock.timers.tick(80);
  assert.equal(replacement.snapshots.length, 1);
  assert.equal(replacement.eventNames().length, 0);
  const reopened = new SnapshotWindow();
  delivery.attach(reopened);
  t.mock.timers.tick(80);
  assert.equal(
    reopened.snapshots[0].sessions[0].session.activity,
    'Pending at close',
  );

  current.updateSession({activity: 'Pending at shutdown'});
  delivery.dispose();
  current.updateSession({activity: 'Closed'});
  reopened.emit('show');
  t.mock.timers.tick(800);
  assert.equal(reopened.snapshots.length, 1);
  assert.equal(reopened.eventNames().length, 0);
});

void test(
  'real Electron hide and show deliver the latest state without hidden snapshot builds',
  {
    timeout: 90_000,
    skip:
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY
        ? 'Electron requires a Linux display (run with xvfb-run)'
        : false,
  },
  async t => {
    const directory = await mkdtemp(
      join(tmpdir(), 'varisdev-snapshot-delivery-'),
    );
    t.after(() => rm(directory, {recursive: true, force: true}));
    const modulePath = join(directory, 'snapshot-delivery.mjs');
    const reportPath = join(directory, 'report.json');
    const source = await readFile(
      new URL('../src/desktop/snapshot-delivery.ts', import.meta.url),
      'utf8',
    );
    await writeFile(
      modulePath,
      ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
        },
      }).outputText,
    );
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    let launchError: unknown;
    try {
      await runRuntimeCommand(
        createRequire(import.meta.url)('electron') as string,
        [
          fileURLToPath(
            new URL(
              './fixtures/desktop-snapshot-delivery.cjs',
              import.meta.url,
            ),
          ),
          directory,
          modulePath,
          reportPath,
        ],
        {cwd: process.cwd(), env, timeoutMs: 60_000},
      );
    } catch (error) {
      launchError = error;
    }
    const report = await readFile(reportPath, 'utf8')
      .then(value => JSON.parse(value))
      .catch(() => {
        throw launchError || new Error('No snapshot delivery report');
      });
    assert.ifError(report.error);
    assert.ifError(launchError);
    assert.equal(report.builds, 2);
    assert.deepEqual(report.received, [100, 200]);
  },
);
