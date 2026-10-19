import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  initTheme,
  ProjectTrustStore,
  SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import {
  DesktopExtensionUI,
  type DesktopNativeFactory,
} from '../src/dashboard/extension-ui.ts';
import {setTimeout as delay} from 'node:timers/promises';
import type {SettingsCommandContext} from '../src/dashboard/settings-commands.ts';
import {
  runScopedModelsSettings,
  runTrustSettings,
} from '../src/dashboard/native-resource-settings.ts';

type Model = NonNullable<AgentSession['model']>;
type NativeResult = Awaited<ReturnType<DesktopNativeFactory<unknown>>>;
type ScopeCallbacks = {
  onChange(ids: string[] | null): void;
  onPersist(ids: string[] | null): void;
  onCancel(): void;
};
const first = {provider: 'one', id: 'first', name: 'First'} as Model;
const second = {provider: 'one', id: 'second', name: 'Second'} as Model;
const third = {provider: 'two', id: 'third', name: 'Third'} as Model;

function harness() {
  initTheme('dark');
  const settings = SettingsManager.inMemory();
  const notices: string[] = [];
  const mutations: AgentSession['scopedModels'][] = [];
  const configurations: unknown[] = [];
  const dialogs: string[] = [];
  let available = [first, second, third];
  let scope: AgentSession['scopedModels'] = [];
  let refreshSignal: AbortSignal | undefined;
  let finishRefresh: (() => void) | undefined;
  let interact: (component: NativeResult) => void | Promise<void> = () => {};
  const session = {
    settingsManager: settings,
    sessionManager: {getCwd: () => process.cwd()},
    modelRuntime: {
      getAvailableSnapshot: () => available,
      refresh: ({signal}: {signal: AbortSignal}) => {
        refreshSignal = signal;
        return new Promise(resolve => {
          finishRefresh = () =>
            resolve({aborted: signal.aborted, errors: new Map()});
          signal.addEventListener('abort', finishRefresh, {once: true});
        });
      },
    },
    get scopedModels() {
      return scope;
    },
    setScopedModels(value: AgentSession['scopedModels']) {
      mutations.push(value);
      scope = value;
    },
  };
  const ui = {
    context: {notify: (message: string) => notices.push(message)},
    native: async <T>(title: string, factory: DesktopNativeFactory<T>) => {
      dialogs.push(title);
      let complete!: (value: T) => void;
      const completion = new Promise<T>(resolve => {
        complete = resolve;
      });
      const created = await factory(
        {requestRender() {}} as Parameters<DesktopNativeFactory<T>>[0],
        {} as Parameters<DesktopNativeFactory<T>>[1],
        {} as Parameters<DesktopNativeFactory<T>>[2],
        complete,
      );
      try {
        await interact(created);
        return await completion;
      } finally {
        const component = 'component' in created ? created.component : created;
        component.dispose?.();
      }
    },
  };
  const ctx: SettingsCommandContext = {
    session: session as unknown as AgentSession,
    ui: ui as unknown as DesktopExtensionUI,
    configure: async options => {
      configurations.push(options);
    },
  };
  return {
    ctx,
    settings,
    notices,
    mutations,
    configurations,
    dialogs,
    scope: () => scope,
    refreshSignal: () => refreshSignal,
    setAvailable: (models: Model[]) => {
      available = models;
    },
    finishRefresh: () => finishRefresh?.(),
    interact: (action: typeof interact) => {
      interact = action;
    },
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await delay(5);
  assert.ok(check(), 'Expected native terminal state before deadline');
}

function scopeCallbacks(created: NativeResult): ScopeCallbacks {
  assert.ok('focus' in created);
  assert.equal(created.focus.constructor.name, 'ScopedModelsSelectorComponent');
  return (created.focus as unknown as {callbacks: ScopeCallbacks}).callbacks;
}

void test('native scoped selector applies session order live and persists only on its save callback', async () => {
  const h = harness();
  h.interact(created => {
    const callbacks = scopeCallbacks(created);
    callbacks.onChange(['two/third', 'one/first']);
    assert.deepEqual(
      h.scope().map(item => item.model.id),
      ['third', 'first'],
    );
    assert.equal(h.settings.getEnabledModels(), undefined);
    callbacks.onPersist(['two/third', 'one/first']);
    callbacks.onCancel();
  });
  await runScopedModelsSettings(h.ctx);
  assert.deepEqual(h.settings.getEnabledModels(), ['two/third', 'one/first']);
  assert.deepEqual(h.configurations, [{}]);
  assert.deepEqual(h.notices, ['Model selection saved to settings']);
  assert.equal(h.refreshSignal()?.aborted, true);
});

void test('closing native scoped selector preserves live changes without saving settings', async () => {
  const h = harness();
  h.settings.setEnabledModels(['one/first']);
  h.interact(created => {
    const callbacks = scopeCallbacks(created);
    callbacks.onChange(['two/third', 'one/first']);
    callbacks.onCancel();
  });
  await runScopedModelsSettings(h.ctx);
  assert.deepEqual(
    h.scope().map(item => item.model.id),
    ['third', 'first'],
  );
  assert.deepEqual(h.settings.getEnabledModels(), ['one/first']);
  assert.deepEqual(h.notices, []);
});

void test('native scoped selector refresh resolves configured patterns and retains unavailable settings', async () => {
  const h = harness();
  h.settings.setEnabledModels(['two/*', 'missing/model']);
  h.setAvailable([first]);
  h.interact(async created => {
    const callbacks = scopeCallbacks(created);
    h.setAvailable([first, third]);
    h.finishRefresh();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(
      h.scope().map(item => item.model.id),
      ['third'],
    );
    callbacks.onCancel();
  });
  await runScopedModelsSettings(h.ctx);
  assert.deepEqual(h.settings.getEnabledModels(), ['two/*', 'missing/model']);
  assert.deepEqual(h.configurations, [{}]);
});

void test('native scoped selector ignores callbacks and refresh results after disposal', async () => {
  const h = harness();
  let callbacks!: ScopeCallbacks;
  h.interact(created => {
    callbacks = scopeCallbacks(created);
    callbacks.onCancel();
  });
  await runScopedModelsSettings(h.ctx);
  callbacks.onChange(['one/first']);
  callbacks.onPersist(['one/first']);
  h.finishRefresh();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(h.mutations, []);
  assert.equal(h.settings.getEnabledModels(), undefined);
  assert.deepEqual(h.notices, []);
});

void test('native trust selector persists the SDK selection without changing active session trust', async t => {
  const h = harness();
  const reads: string[] = [];
  const writes: unknown[] = [];
  const updates = [{path: process.cwd(), decision: true}];
  t.mock.method(ProjectTrustStore.prototype, 'getEntry', (cwd: string) => {
    reads.push(cwd);
    return null;
  });
  t.mock.method(ProjectTrustStore.prototype, 'setMany', (value: unknown) =>
    writes.push(value),
  );
  const before = h.settings.isProjectTrusted();
  h.interact(created => {
    assert.equal(created.constructor.name, 'TrustSelectorComponent');
    (
      created as unknown as {onSelectCallback(value: unknown): void}
    ).onSelectCallback({trusted: true, updates});
  });
  await runTrustSettings(h.ctx);
  assert.deepEqual(reads, [process.cwd()]);
  assert.deepEqual(writes, [updates]);
  assert.equal(h.settings.isProjectTrusted(), before);
  assert.match(h.notices[0] ?? '', /Saved trust decision: trusted/);
});

void test('native trust selector cancellation and pre-aborted commands do not persist', async t => {
  const h = harness();
  const writes: unknown[] = [];
  t.mock.method(ProjectTrustStore.prototype, 'getEntry', () => null);
  t.mock.method(ProjectTrustStore.prototype, 'setMany', (value: unknown) =>
    writes.push(value),
  );
  h.interact(created => {
    (created as unknown as {onCancelCallback(): void}).onCancelCallback();
  });
  await runTrustSettings(h.ctx);
  assert.deepEqual(writes, []);
  h.ctx.signal = AbortSignal.abort();
  await runTrustSettings(h.ctx);
  await runScopedModelsSettings(h.ctx);
  assert.deepEqual(h.dialogs, ['Project trust']);
  assert.deepEqual(h.notices, []);
});

void test(
  'scoped model command uses real desktop terminal keys for live order and global saving',
  {timeout: 5000},
  async t => {
    const h = harness();
    const adapter = new DesktopExtensionUI(() => {});
    t.after(() => adapter.dispose());
    h.ctx.ui = adapter;
    const result = runScopedModelsSettings(h.ctx);
    await waitFor(
      () =>
        adapter
          .snapshot()
          .dialogs[0]?.terminal?.output.includes('Model Configuration') ===
        true,
    );
    const id = adapter.snapshot().dialogs[0].id;
    adapter.respond(id, {columns: 62, rows: 18});
    await waitFor(
      () => adapter.snapshot().dialogs[0]?.terminal?.columns === 62,
    );
    adapter.respond(id, {input: '\r'});
    await waitFor(
      () =>
        h
          .scope()
          .map(item => item.model.id)
          .join(',') === 'second,third',
    );
    assert.equal(h.settings.getEnabledModels(), undefined);
    adapter.respond(id, {input: '\x1b[1;3B'});
    await waitFor(
      () =>
        h
          .scope()
          .map(item => item.model.id)
          .join(',') === 'third,second',
    );
    adapter.respond(id, {input: '\x13'});
    await waitFor(
      () => h.settings.getEnabledModels()?.join(',') === 'two/third,one/second',
    );
    adapter.respond(id, {input: '\x1b'});
    await result;
    assert.deepEqual(h.settings.getGlobalSettings().enabledModels, [
      'two/third',
      'one/second',
    ]);
    assert.deepEqual(h.configurations, [{}, {}]);
    assert.ok(
      adapter
        .snapshot()
        .notifications.some(
          item => item.message === 'Model selection saved to settings',
        ),
    );
    assert.equal(h.refreshSignal()?.aborted, true);
    assert.deepEqual(adapter.snapshot().dialogs, []);
  },
);

void test(
  'trust command renders native desktop terminal and routes cancel and save keys safely',
  {timeout: 5000},
  async t => {
    const h = harness();
    const adapter = new DesktopExtensionUI(() => {});
    t.after(() => adapter.dispose());
    h.ctx.ui = adapter;
    const writes: Parameters<ProjectTrustStore['setMany']>[0][] = [];
    t.mock.method(ProjectTrustStore.prototype, 'getEntry', () => null);
    t.mock.method(
      ProjectTrustStore.prototype,
      'setMany',
      (updates: Parameters<ProjectTrustStore['setMany']>[0]) =>
        writes.push(updates),
    );
    const before = h.settings.isProjectTrusted();
    const cancelled = runTrustSettings(h.ctx);
    await waitFor(
      () =>
        adapter
          .snapshot()
          .dialogs[0]?.terminal?.output.includes('Project trust') === true,
    );
    const id = adapter.snapshot().dialogs[0].id;
    adapter.respond(id, {columns: 62, rows: 18});
    await waitFor(
      () => adapter.snapshot().dialogs[0]?.terminal?.columns === 62,
    );
    adapter.respond(id, {input: '\x1b'});
    await cancelled;
    assert.equal(writes.length, 0);
    assert.deepEqual(adapter.snapshot().dialogs, []);
    const saved = runTrustSettings(h.ctx);
    await waitFor(
      () =>
        adapter
          .snapshot()
          .dialogs[0]?.terminal?.output.includes('Project trust') === true,
    );
    adapter.respond(adapter.snapshot().dialogs[0].id, {input: '\r'});
    await saved;
    assert.equal(writes.length, 1);
    assert.ok(writes[0].length > 0);
    assert.equal(h.settings.isProjectTrusted(), before);
    assert.deepEqual(adapter.snapshot().dialogs, []);
  },
);
