import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  SettingsManager,
  type AgentSession,
  type SettingsConfig,
  type SettingsCallbacks,
} from '@earendil-works/pi-coding-agent';
import type {DesktopExtensionUI} from '../src/dashboard/extension-ui.ts';
import type {SessionConfiguration} from '../src/dashboard/features.ts';
import {
  runSettingsCommand,
  type SettingsCommandContext,
} from '../src/dashboard/settings-commands.ts';

type Model = NonNullable<AgentSession['model']>;
type Dialog = {
  title: string;
  options: string[];
  selected?: string;
  message?: string;
  searchable?: boolean;
};
type Reply = string | undefined | ((dialog: Dialog) => string | undefined);
const model = (provider: string, id: string): Model =>
  ({
    provider,
    id,
    name: id,
    reasoning: true,
  }) as Model;
const first = model('one', 'first');
const second = model('one', 'nested/second');
const third = model('two', 'third');

function harness(replies: Reply[] = [], models = [first, second, third]) {
  const settings = SettingsManager.inMemory();
  const dialogs: Dialog[] = [];
  const notices: string[] = [];
  const shown: Array<{title: string; message: string}> = [];
  const configurations: SessionConfiguration[] = [];
  const mutations: Array<{name: string; value: unknown}> = [];
  const refreshes: unknown[] = [];
  const modelSelections: Array<
    Parameters<DesktopExtensionUI['selectModel']>[0]
  > = [];
  const modelReplies: Array<
    Awaited<ReturnType<DesktopExtensionUI['selectModel']>>
  > = [];
  const thinkingSelections: Array<
    Parameters<DesktopExtensionUI['selectThinking']>[0]
  > = [];
  const thinkingReplies: Array<
    Awaited<ReturnType<DesktopExtensionUI['selectThinking']>>
  > = [];
  let scopes: AgentSession['scopedModels'] = [];
  const state = {
    model: models[0] as Model | undefined,
    thinkingLevel: 'medium',
    agent: {transport: 'auto'},
    settingsManager: settings,
    sessionManager: {getCwd: () => process.cwd()},
    modelRuntime: {
      refresh: async (options: unknown) => {
        refreshes.push(options);
        return {aborted: false, errors: new Map<string, Error>()};
      },
      getError: () => undefined as string | undefined,
      getAvailableSnapshot: () => models,
      getAvailable: async () => models,
    },
    getAvailableThinkingLevels: () => ['off', 'low', 'medium', 'high'],
    get scopedModels() {
      return scopes;
    },
    setScopedModels: (value: AgentSession['scopedModels']) => {
      mutations.push({name: 'scopedModels', value});
      scopes = value;
    },
    get autoCompactionEnabled() {
      return settings.getCompactionEnabled();
    },
    get autoRetryEnabled() {
      return settings.getRetryEnabled();
    },
    get steeringMode() {
      return settings.getSteeringMode();
    },
    get followUpMode() {
      return settings.getFollowUpMode();
    },
    setAutoCompactionEnabled: (value: boolean) => {
      mutations.push({name: 'compaction', value});
      settings.setCompactionEnabled(value);
    },
    setAutoRetryEnabled: (value: boolean) => {
      mutations.push({name: 'retry', value});
      settings.setRetryEnabled(value);
    },
    setSteeringMode: (value: 'all' | 'one-at-a-time') => {
      mutations.push({name: 'steering', value});
      settings.setSteeringMode(value);
    },
    setFollowUpMode: (value: 'all' | 'one-at-a-time') => {
      mutations.push({name: 'followUp', value});
      settings.setFollowUpMode(value);
    },
    setThinkingLevel: (value: string) => {
      mutations.push({name: 'thinking', value});
      state.thinkingLevel = value;
    },
    setCacheWarmingMode: (value: 'off' | 'streaming' | 'idle') => {
      mutations.push({name: 'cacheWarming', value});
      settings.setCacheWarmingMode(value);
    },
  };
  const sessionSelections: Array<
    Parameters<DesktopExtensionUI['selectSessionSettings']>[0]
  > = [];
  const settingsSelections: SettingsConfig[] = [];
  let settingsReply:
    | ((
        config: SettingsConfig,
        callbacks: Omit<SettingsCallbacks, 'onCancel'>,
      ) => void | Promise<void>)
    | undefined;
  const previews: string[] = [];
  const ui = {
    forCommand: () => ui,
    previewTheme: (theme: string) => previews.push(theme),
    selectSettings: async (
      config: SettingsConfig,
      callbacks: Omit<SettingsCallbacks, 'onCancel'>,
    ) => {
      settingsSelections.push(config);
      await settingsReply?.(config, callbacks);
    },
    selectSessionSettings: async (
      options: Parameters<DesktopExtensionUI['selectSessionSettings']>[0],
    ) => {
      sessionSelections.push(options);
      if (options.activeTab === 'thinking') {
        const result = await ui.selectThinking(options.thinking);
        return result ? {kind: 'thinking' as const, ...result} : undefined;
      }
      const result = await ui.selectModel(options.model);
      return result ? {kind: 'model' as const, ...result} : undefined;
    },
    selectThinking: async (
      options: Parameters<DesktopExtensionUI['selectThinking']>[0],
    ) => {
      thinkingSelections.push(options);
      return thinkingReplies.shift();
    },
    selectModel: async (
      options: Parameters<DesktopExtensionUI['selectModel']>[0],
    ) => {
      modelSelections.push(options);
      return modelReplies.shift();
    },
    select: async (
      title: string,
      options: string[],
      config: Omit<Dialog, 'title' | 'options'> = {},
    ) => {
      const dialog = {title, options: [...options], ...config};
      dialogs.push(dialog);
      assert.ok(
        config.selected === undefined || options.includes(config.selected),
        'current option must be offered',
      );
      const reply = replies.shift();
      return typeof reply === 'function' ? reply(dialog) : reply;
    },
    show: async (title: string, message: string) => {
      shown.push({title, message});
    },
    context: {
      theme: {appearance: 'dark'},
      getAllThemes: () => [{name: 'system'}, {name: 'dark'}, {name: 'light'}],
      notify: (message: string) => {
        notices.push(message);
      },
    },
  } as unknown as DesktopExtensionUI;
  const ctx: SettingsCommandContext = {
    session: state as unknown as AgentSession,
    ui,
    configure: async options => {
      configurations.push(options);
      if (options.provider && options.modelId)
        state.model = models.find(
          model =>
            model.provider === options.provider && model.id === options.modelId,
        );
      if (options.thinkingLevel) state.thinkingLevel = options.thinkingLevel;
    },
  };
  return {
    ctx,
    settingsSelections,
    previews,
    onSettings: (reply: NonNullable<typeof settingsReply>) => {
      settingsReply = reply;
    },
    state,
    settings,
    dialogs,
    notices,
    shown,
    configurations,
    mutations,
    refreshes,
    sessionSelections,
    modelSelections,
    modelReplies,
    thinkingSelections,
    thinkingReplies,
    setScopes: (value: AgentSession['scopedModels']) => {
      scopes = value;
    },
  };
}

void test('unknown commands remain unhandled and argumentless commands validate extra arguments', async () => {
  const h = harness();
  assert.equal(await runSettingsCommand('other', '', h.ctx), false);
  for (const name of ['settings', 'scoped-models', 'trust'])
    await assert.rejects(
      runSettingsCommand(name, 'unexpected', h.ctx),
      /without arguments/,
    );
  assert.equal(h.dialogs.length, 0);
});

void test('thinking command delegates current, available and default levels to the SDK selector', async () => {
  const h = harness();
  h.thinkingReplies.push({thinkingLevel: 'high', persist: false});
  h.settings.setDefaultThinkingLevel('low');
  assert.equal(await runSettingsCommand('thinking', '', h.ctx), true);
  assert.deepEqual(h.thinkingSelections, [
    {
      currentLevel: 'medium',
      availableLevels: ['off', 'low', 'medium', 'high'],
      defaultLevel: 'low',
    },
  ]);
  assert.deepEqual(h.configurations, [{thinkingLevel: 'high', persist: false}]);
  assert.equal(h.settings.getDefaultThinkingLevel(), 'low');
});

void test('thinking selector cancellation does not configure; Make as default persists the current level', async () => {
  const cancelled = harness();
  await runSettingsCommand('thinking', '', cancelled.ctx);
  assert.deepEqual(cancelled.configurations, []);
  assert.equal(cancelled.thinkingSelections[0].defaultLevel, 'medium');
  const saved = harness();
  saved.thinkingReplies.push({thinkingLevel: 'medium', persist: true});
  await runSettingsCommand('thinking', '', saved.ctx);
  assert.deepEqual(saved.configurations, [
    {thinkingLevel: 'medium', persist: true},
  ]);
});

void test('explicit thinking levels normalize and apply to this session; invalid levels do not configure', async () => {
  const h = harness();
  await runSettingsCommand('thinking', ' HIGH ', h.ctx);
  assert.deepEqual(h.configurations, [{thinkingLevel: 'high', persist: false}]);
  assert.deepEqual(h.thinkingSelections, []);
  await assert.rejects(
    runSettingsCommand('thinking', 'xhigh', h.ctx),
    /off, low, medium, high/,
  );
  const invalid = harness();
  invalid.ctx.ui.selectThinking = async () =>
    ({thinkingLevel: 'not-an-option', persist: false}) as never;
  await assert.rejects(
    runSettingsCommand('thinking', '', invalid.ctx),
    /off, low, medium, high/,
  );
  assert.deepEqual(invalid.configurations, []);
});

void test('model command delegates current model, scope, runtime and saved default to the SDK selector', async () => {
  const h = harness();
  const scope = [{model: third, thinkingLevel: 'high' as const}];
  h.setScopes(scope);
  h.settings.setDefaultModelAndProvider('two', 'startup');
  h.modelReplies.push({model: second, persist: false});
  await runSettingsCommand('model', '', h.ctx);
  assert.deepEqual(h.modelSelections, [
    {
      currentModel: first,
      modelRuntime: h.state.modelRuntime,
      scopedModels: scope,
      defaultModel: {provider: 'two', id: 'startup'},
      initialSearch: undefined,
    },
  ]);
  assert.deepEqual(h.configurations, [
    {provider: 'one', modelId: 'nested/second', persist: false},
  ]);
  assert.deepEqual(h.dialogs, []);
  assert.deepEqual(h.refreshes, []);
  assert.equal(h.settings.getDefaultModel(), 'startup');
});

void test('model selector cancellation does not configure and Make as default persists even the current model', async () => {
  const cancelled = harness();
  await runSettingsCommand('model', '', cancelled.ctx);
  assert.deepEqual(cancelled.configurations, []);
  const saved = harness();
  saved.modelReplies.push({model: first, persist: true});
  await runSettingsCommand('model', '', saved.ctx);
  assert.deepEqual(saved.configurations, [
    {provider: 'one', modelId: 'first', persist: true},
  ]);
});

void test('exact model references and bare IDs apply directly to the session', async () => {
  for (const reference of ['one/nested/second', 'nested/second']) {
    const h = harness();
    await runSettingsCommand('model', reference, h.ctx);
    assert.deepEqual(h.configurations, [
      {provider: 'one', modelId: 'nested/second', persist: false},
    ]);
    assert.deepEqual(h.modelSelections, []);
    assert.deepEqual(h.refreshes, []);
  }
});

void test('nonexact model arguments open the SDK selector with the original search', async () => {
  for (const search of ['second', 'one/', '/first', 'unknown/model']) {
    const h = harness();
    await runSettingsCommand('model', search, h.ctx);
    assert.equal(h.modelSelections[0].initialSearch, search);
    assert.deepEqual(h.configurations, []);
    assert.equal(h.refreshes.length, 1);
  }
});

void test('direct model arguments honor session scope and leave scope switching to the SDK selector', async () => {
  const h = harness();
  h.setScopes([{model: third}]);
  await runSettingsCommand('model', 'one/first', h.ctx);
  assert.equal(h.modelSelections[0].initialSearch, 'one/first');
  assert.deepEqual(h.configurations, []);
  assert.deepEqual(h.refreshes, []);
  await runSettingsCommand('model', 'third', h.ctx);
  assert.deepEqual(h.configurations, [
    {provider: 'two', modelId: 'third', persist: false},
  ]);
});

void test('exact model lookup refreshes a missing catalog entry before opening the selector', async () => {
  const models = [first];
  const h = harness([], models);
  h.state.modelRuntime.refresh = async options => {
    h.refreshes.push(options);
    models.push(second);
    return {aborted: false, errors: new Map()};
  };
  await runSettingsCommand('model', 'nested/second', h.ctx);
  assert.deepEqual(h.configurations, [
    {provider: 'one', modelId: 'nested/second', persist: false},
  ]);
  assert.deepEqual(h.modelSelections, []);
});

void test('catalog refresh failures warn and keep model search available', async () => {
  const h = harness();
  h.state.modelRuntime.refresh = async () => {
    throw new Error('catalog offline');
  };
  await runSettingsCommand('model', 'unknown/model', h.ctx);
  assert.match(h.notices[0], /catalog offline/);
  assert.equal(h.modelSelections[0].initialSearch, 'unknown/model');
  assert.deepEqual(h.configurations, []);
});

void test('both session settings entry tabs receive current model-specific thinking levels', async () => {
  const h = harness();
  await runSettingsCommand('model', '', h.ctx);
  assert.equal(h.sessionSelections[0].activeTab, 'model');
  assert.deepEqual(h.sessionSelections[0].thinking.availableLevels, [
    'off',
    'low',
    'medium',
    'high',
  ]);
  h.state.getAvailableThinkingLevels = () => ['off'];
  await runSettingsCommand('thinking', '', h.ctx);
  assert.equal(h.sessionSelections[1].activeTab, 'thinking');
  assert.deepEqual(h.sessionSelections[1].thinking.availableLevels, ['off']);
  assert.equal(h.sessionSelections[1].model.currentModel, first);
  h.ctx.ui.selectSessionSettings = async () => ({
    kind: 'thinking',
    thinkingLevel: 'off',
    persist: true,
  });
  await runSettingsCommand('model', '', h.ctx);
  assert.deepEqual(h.configurations, [{thinkingLevel: 'off', persist: true}]);
});

void test('/settings supplies the complete native configuration and leaves cancelled preferences unchanged', async () => {
  const h = harness();
  h.settings.setDefaultModelAndProvider('two', 'startup');
  h.settings.setDefaultThinkingLevel('low');
  h.settings.setModelThinkingLevel('one', 'first', 'high');
  const before = h.settings.getSettings();
  await runSettingsCommand('settings', '', h.ctx);
  const config = h.settingsSelections[0];
  assert.equal(config.defaultModel, 'two/startup');
  assert.equal(config.currentModel, first);
  assert.deepEqual(config.availableDefaultModels, [first, second, third]);
  assert.equal(config.thinkingLevel, 'low');
  assert.deepEqual(config.availableThinkingLevels, [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  assert.deepEqual(config.modelThinkingLevels, {'one/first': 'high'});
  assert.equal(config.httpIdleTimeoutMs, h.settings.getHttpIdleTimeoutMs());
  assert.equal(
    config.mermaidRenderingMode,
    h.settings.getMermaidRenderingMode(),
  );
  assert.equal(config.fullscreenScrollbar, h.settings.getFullscreenScrollbar());
  assert.deepEqual(config.warnings, h.settings.getWarnings());
  assert.deepEqual(h.settings.getSettings(), before);
  assert.deepEqual(h.configurations, []);
});

void test('native settings callbacks apply runtime changes and persist Pi preferences', async () => {
  const h = harness();
  h.onSettings((_config, callbacks) => {
    callbacks.onAutoCompactChange(false);
    callbacks.onSteeringModeChange('all');
    callbacks.onFollowUpModeChange('all');
    callbacks.onTransportChange('websocket-cached');
    callbacks.onCacheWarmingModeChange('idle');
    callbacks.onEnableSkillCommandsChange(false);
    callbacks.onMermaidRenderingModeChange('streaming');
    callbacks.onFullscreenCopyOnSelectChange(false);
    callbacks.onOutputPadChange(0);
    callbacks.onWarningsChange({anthropicExtraUsage: false});
    callbacks.onThemeChange('light');
  });
  await runSettingsCommand('settings', '', h.ctx);
  assert.equal(h.state.autoCompactionEnabled, false);
  assert.equal(h.state.steeringMode, 'all');
  assert.equal(h.state.followUpMode, 'all');
  assert.equal(h.state.agent.transport, 'websocket-cached');
  assert.equal(h.settings.getCacheWarmingMode(), 'idle');
  assert.equal(h.settings.getEnableSkillCommands(), false);
  assert.equal(h.settings.getMermaidRenderingMode(), 'streaming');
  assert.equal(h.settings.getFullscreenCopyOnSelect(), false);
  assert.equal(h.settings.getOutputPad(), 0);
  assert.deepEqual(h.settings.getWarnings(), {anthropicExtraUsage: false});
  assert.equal(h.settings.getThemeSetting(), 'light');
  assert.deepEqual(h.previews, ['system', 'light', 'light']);
  assert.equal(h.configurations.length, 11);
  assert.ok(h.configurations.every(config => Object.keys(config).length === 0));
});

void test('per-model thinking callbacks update current runtime and restore its global default on removal', async () => {
  const h = harness();
  h.settings.setDefaultThinkingLevel('low');
  h.onSettings((_config, callbacks) => {
    callbacks.onModelThinkingLevelChange('two', 'third', 'high');
    assert.equal(h.state.thinkingLevel, 'medium');
    callbacks.onModelThinkingLevelChange('one', 'first', 'high');
    assert.equal(h.state.thinkingLevel, 'high');
    callbacks.onModelThinkingLevelRemove('one', 'first');
    assert.equal(h.state.thinkingLevel, 'low');
  });
  await runSettingsCommand('settings', '', h.ctx);
  assert.deepEqual(h.settings.getAllModelThinkingLevels(), {
    'two/third': 'high',
  });
  assert.equal(h.settings.getDefaultThinkingLevel(), 'low');
});

void test('native settings report persistence failures and suppress callbacks after command abort', async t => {
  const h = harness();
  t.mock.method(h.settings, 'drainErrors', () => [
    {scope: 'global', error: new Error('disk is read-only')},
  ]);
  h.onSettings((_config, callbacks) =>
    callbacks.onEnableSkillCommandsChange(false),
  );
  await assert.rejects(
    runSettingsCommand('settings', '', h.ctx),
    /global settings: disk is read-only/,
  );
  assert.deepEqual(h.configurations, []);
  const aborted = harness();
  const controller = new AbortController();
  aborted.ctx.signal = controller.signal;
  aborted.onSettings((_config, callbacks) => {
    controller.abort();
    callbacks.onAutoCompactChange(false);
  });
  await runSettingsCommand('settings', '', aborted.ctx);
  assert.equal(aborted.state.autoCompactionEnabled, true);
  assert.deepEqual(aborted.configurations, []);
  const closed = harness();
  closed.ctx.signal = AbortSignal.abort();
  await runSettingsCommand('settings', '', closed.ctx);
  assert.deepEqual(closed.settingsSelections, []);
});

void test('/settings runs the stock terminal selector with search, live persistence, submenus and abort', async () => {
  const {DesktopExtensionUI} = await import('../src/dashboard/extension-ui.ts');
  const {setTimeout: delay} = await import('node:timers/promises');
  const adapter = new DesktopExtensionUI(() => {});
  const h = harness();
  h.ctx.ui = adapter;
  const abort = new AbortController();
  h.ctx.signal = abort.signal;
  const running = runSettingsCommand('settings', '', h.ctx);
  async function waitFor(check: () => boolean) {
    const deadline = Date.now() + 2000;
    while (!check() && Date.now() < deadline) await delay(5);
    assert.ok(
      check(),
      `Expected native settings state: ${JSON.stringify(adapter.snapshot())}`,
    );
  }
  try {
    await waitFor(
      () =>
        adapter
          .snapshot()
          .dialogs[0]?.terminal?.output.includes('Auto-compact') === true,
    );
    const dialog = adapter.snapshot().dialogs[0];
    assert.equal(dialog.kind, 'terminal');
    assert.equal(dialog.title, 'Settings');
    const mermaid = h.settings.getMermaidRenderingMode();
    adapter.respond(dialog.id, {input: 'mermaid\r'});
    await waitFor(() => h.settings.getMermaidRenderingMode() !== mermaid);
    await waitFor(() => h.configurations.length > 0);
    // Clear the stock search input, then enter its model-thinking submenu.
    adapter.respond(dialog.id, {input: '\x15per model\r'});
    await waitFor(
      () =>
        adapter
          .snapshot()
          .dialogs[0]?.terminal?.output.includes('Per-Model Thinking Level') ===
        true,
    );
    abort.abort();
    assert.equal(await running, true);
    assert.deepEqual(adapter.snapshot().dialogs, []);
    assert.equal(h.refreshes.length, 0);
    assert.ok(
      h.configurations.every(config => Object.keys(config).length === 0),
    );
  } finally {
    abort.abort();
    await running;
    adapter.dispose();
  }
});
