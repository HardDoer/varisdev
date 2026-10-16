import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  ProjectTrustStore,
  SettingsManager,
  type AgentSession,
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
    setCacheWarmingMode: (value: 'off' | 'streaming' | 'idle') => {
      mutations.push({name: 'cacheWarming', value});
      settings.setCacheWarmingMode(value);
    },
  };
  const ui = {
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
    state,
    settings,
    dialogs,
    notices,
    shown,
    configurations,
    mutations,
    refreshes,
    modelSelections,
    modelReplies,
    thinkingSelections,
    thinkingReplies,
    setScopes: (value: AgentSession['scopedModels']) => {
      scopes = value;
    },
  };
}

const choose =
  (prefix: string): Reply =>
  dialog => {
    const option = dialog.options.find(option => option.startsWith(prefix));
    assert.ok(option, `Missing ${prefix} in ${dialog.title}`);
    return option;
  };

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

void test('settings is a native menu of session controls; cancellation/current option leave settings unchanged', async () => {
  for (const replies of [
    [undefined],
    [choose('Auto compaction:'), undefined, undefined],
    [choose('Auto compaction:'), 'on', undefined],
  ]) {
    const h = harness(replies);
    const before = h.settings.getSettings();
    await runSettingsCommand('settings', '', h.ctx);
    assert.equal(h.dialogs[0].title, 'Session settings');
    for (const name of [
      'Model:',
      'Thinking level:',
      'Auto compaction:',
      'Auto retry:',
      'Steering queue:',
      'Follow-up queue:',
      'Transport:',
      'Cache warming:',
      'Skill commands:',
    ])
      assert.ok(
        h.dialogs[0].options.some(option => option.startsWith(name)),
        name,
      );
    assert.deepEqual(h.settings.getSettings(), before);
    assert.deepEqual(h.mutations, []);
    assert.deepEqual(h.configurations, []);
  }
});

void test('native settings choices call actual Pi runtime and persistence setters', async () => {
  const cases = [
    [
      'Auto compaction:',
      'off',
      (h: ReturnType<typeof harness>) => h.state.autoCompactionEnabled,
      false,
    ],
    [
      'Auto retry:',
      'off',
      (h: ReturnType<typeof harness>) => h.state.autoRetryEnabled,
      false,
    ],
    [
      'Steering queue:',
      'all',
      (h: ReturnType<typeof harness>) => h.state.steeringMode,
      'all',
    ],
    [
      'Follow-up queue:',
      'all',
      (h: ReturnType<typeof harness>) => h.state.followUpMode,
      'all',
    ],
    [
      'Transport:',
      'websocket-cached',
      (h: ReturnType<typeof harness>) => h.state.agent.transport,
      'websocket-cached',
    ],
    [
      'Cache warming:',
      'idle',
      (h: ReturnType<typeof harness>) => h.settings.getCacheWarmingMode(),
      'idle',
    ],
    [
      'Skill commands:',
      'off',
      (h: ReturnType<typeof harness>) => h.settings.getEnableSkillCommands(),
      false,
    ],
    [
      'Auto-resize images:',
      'off',
      (h: ReturnType<typeof harness>) => h.settings.getImageAutoResize(),
      false,
    ],
    [
      'Block images:',
      'on',
      (h: ReturnType<typeof harness>) => h.settings.getBlockImages(),
      true,
    ],
    [
      'Cache miss notices:',
      'on',
      (h: ReturnType<typeof harness>) => h.settings.getShowCacheMissNotices(),
      true,
    ],
    [
      'Session share destination:',
      'gist',
      (h: ReturnType<typeof harness>) =>
        h.settings.getSessionShareDestination(),
      'gist',
    ],
    [
      'Default project trust:',
      'never',
      (h: ReturnType<typeof harness>) => h.settings.getDefaultProjectTrust(),
      'never',
    ],
    [
      'Install telemetry:',
      'off',
      (h: ReturnType<typeof harness>) => h.settings.getEnableInstallTelemetry(),
      false,
    ],
  ] as const;
  for (const [name, value, read, expected] of cases) {
    const h = harness([choose(name), value, undefined]);
    await runSettingsCommand('settings', '', h.ctx);
    assert.equal(read(h), expected, name);
    assert.deepEqual(
      h.configurations,
      [{}],
      'notify host without changing model defaults',
    );
    assert.equal(h.settings.getDefaultModel(), undefined);
    assert.equal(h.settings.getDefaultThinkingLevel(), undefined);
  }
});

void test('settings model/thinking entries use session configuration, not startup defaults', async () => {
  const h = harness([choose('Thinking level:'), choose('Model:'), undefined]);
  h.modelReplies.push({model: third, persist: false});
  h.thinkingReplies.push({thinkingLevel: 'high', persist: false});
  await runSettingsCommand('settings', '', h.ctx);
  assert.deepEqual(h.configurations, [
    {thinkingLevel: 'high', persist: false},
    {provider: 'two', modelId: 'third', persist: false},
  ]);
  assert.equal(h.settings.getDefaultModel(), undefined);
  assert.equal(h.settings.getDefaultThinkingLevel(), undefined);
});

void test('invalid selections, setter failures, configure failures and settings persistence errors surface', async t => {
  const invalid = harness([choose('Transport:'), 'made-up']);
  await assert.rejects(
    runSettingsCommand('settings', '', invalid.ctx),
    /Invalid settings selection/,
  );
  assert.equal(invalid.settings.getTransport(), 'auto');
  const setter = harness([choose('Auto retry:'), 'off']);
  setter.state.setAutoRetryEnabled = () => {
    throw new Error('setter failed');
  };
  await assert.rejects(
    runSettingsCommand('settings', '', setter.ctx),
    /setter failed/,
  );
  const config = harness();
  config.thinkingReplies.push({thinkingLevel: 'high', persist: false});
  config.ctx.configure = async () => {
    throw new Error('configuration failed');
  };
  await assert.rejects(
    runSettingsCommand('thinking', '', config.ctx),
    /configuration failed/,
  );
  const persist = harness([choose('Skill commands:'), 'off']);
  t.mock.method(persist.settings, 'drainErrors', () => [
    {scope: 'global', error: new Error('disk is read-only')},
  ]);
  await assert.rejects(
    runSettingsCommand('settings', '', persist.ctx),
    /global settings: disk is read-only/,
  );
  assert.deepEqual(persist.configurations, []);
});

void test('scoped model edits are drafts; cancelling does not change Pi scope or enabledModels', async () => {
  const h = harness([
    'Toggle a model',
    'one',
    '[✓] one/nested/second',
    'Cancel',
  ]);
  h.settings.setEnabledModels(['one/**:high']);
  const before = h.settings.getEnabledModels();
  await runSettingsCommand('scoped-models', '', h.ctx);
  assert.deepEqual(h.settings.getEnabledModels(), before);
  assert.deepEqual(h.mutations, []);
  assert.deepEqual(h.configurations, []);
});

void test('scope Apply configures actual session scope; save writes Pi enabledModels separately', async () => {
  const sessionOnly = harness([
    'Enable only current model',
    'Apply to this session',
  ]);
  await runSettingsCommand('scoped-models', '', sessionOnly.ctx);
  assert.deepEqual(
    sessionOnly.ctx.session.scopedModels.map(scoped => scoped.model),
    [first],
  );
  assert.equal(sessionOnly.settings.getEnabledModels(), undefined);
  const save = harness([
    'Enable only current model',
    'Apply and save to Pi settings',
  ]);
  save.setScopes([{model: first, thinkingLevel: 'high'}, {model: third}]);
  await runSettingsCommand('scoped-models', '', save.ctx);
  assert.deepEqual(save.settings.getEnabledModels(), ['one/first:high']);
  assert.deepEqual(save.ctx.session.scopedModels, [
    {model: first, thinkingLevel: 'high'},
  ]);
  assert.deepEqual(save.configurations, [{}]);
  const all = harness(['Enable all models', 'Apply and save to Pi settings']);
  all.setScopes([{model: first}]);
  all.settings.setEnabledModels(['one/first']);
  await runSettingsCommand('scoped-models', '', all.ctx);
  assert.deepEqual(all.ctx.session.scopedModels, []);
  assert.equal(all.settings.getEnabledModels(), undefined);
});

void test('saving untouched model patterns preserves thinking suffixes and unavailable configured patterns', async () => {
  const h = harness(['Apply and save to Pi settings']);
  h.settings.setEnabledModels(['one/**:high', 'offline/not-loaded']);
  await runSettingsCommand('scoped-models', '', h.ctx);
  assert.deepEqual(h.settings.getEnabledModels(), [
    'one/**:high',
    'offline/not-loaded',
  ]);
  assert.deepEqual(
    h.ctx.session.scopedModels.map(scoped => scoped.thinkingLevel),
    ['high', 'high'],
  );
});

void test('editing a scope retains unavailable saved patterns unless explicitly resetting the selection', async () => {
  const h = harness([
    'Toggle a model',
    'one',
    '[ ] one/nested/second',
    'Apply and save to Pi settings',
  ]);
  h.settings.setEnabledModels(['one/first:high', 'offline/not-loaded']);
  await runSettingsCommand('scoped-models', '', h.ctx);
  assert.deepEqual(h.settings.getEnabledModels(), [
    'one/first:high',
    'one/nested/second',
    'offline/not-loaded',
  ]);
  assert.deepEqual(
    h.ctx.session.scopedModels.map(scoped => scoped.model),
    [first, second],
  );
  assert.equal(h.ctx.session.scopedModels[0].thinkingLevel, 'high');
  assert.match(h.notices[0], /No models match/);
});

void test('unavailable scoped models are retained and an empty draft is not misinterpreted as enable all', async () => {
  const unavailable = model('offline', 'saved');
  const h = harness(['Apply to this session']);
  h.setScopes([{model: first}, {model: unavailable}]);
  await runSettingsCommand('scoped-models', '', h.ctx);
  assert.deepEqual(
    h.ctx.session.scopedModels.map(scoped => scoped.model),
    [first, unavailable],
  );
  const empty = harness(
    ['Toggle a model', 'one', '[✓] one/first', 'Apply to this session'],
    [first],
  );
  empty.setScopes([{model: first}]);
  await assert.rejects(
    runSettingsCommand('scoped-models', '', empty.ctx),
    /Select at least one model/,
  );
  assert.deepEqual(empty.mutations, []);
});

void test('trust uses Pi store and parent-folder update semantics; decisions affect future processes only', async t => {
  let updates: unknown;
  t.mock.method(ProjectTrustStore.prototype, 'getEntry', () => ({
    path: process.cwd(),
    decision: false,
  }));
  t.mock.method(ProjectTrustStore.prototype, 'setMany', (value: unknown) => {
    updates = value;
  });
  const h = harness([choose('Trust parent folder')]);
  const trustedBefore = h.settings.isProjectTrusted();
  await runSettingsCommand('trust', '', h.ctx);
  assert.equal(h.dialogs[0].selected, 'Do not trust');
  assert.match(h.dialogs[0].message!, /Saved decision: untrusted/);
  assert.match(h.dialogs[0].message!, /does not sandbox/);
  const written = updates as Array<{path: string; decision: boolean | null}>;
  assert.equal(written[0].decision, true);
  assert.deepEqual(written[1], {path: process.cwd(), decision: null});
  assert.equal(h.settings.isProjectTrusted(), trustedBefore);
  assert.match(h.shown[0].message, /Restart VarisDev/);
  assert.deepEqual(h.configurations, []);
});

void test('trust cancellation has no write; store read/write errors are not swallowed', async t => {
  let writes = 0;
  const read = t.mock.method(
    ProjectTrustStore.prototype,
    'getEntry',
    () => null,
  );
  const write = t.mock.method(ProjectTrustStore.prototype, 'setMany', () => {
    writes++;
  });
  const h = harness([undefined]);
  await runSettingsCommand('trust', '', h.ctx);
  assert.equal(writes, 0);
  assert.deepEqual(h.shown, []);
  read.mock.mockImplementation(() => {
    throw new Error('invalid trust file');
  });
  await assert.rejects(
    runSettingsCommand('trust', '', h.ctx),
    /invalid trust file/,
  );
  read.mock.mockImplementation(() => null);
  write.mock.mockImplementation(() => {
    throw new Error('trust write failed');
  });
  const failed = harness(['Trust']);
  await assert.rejects(
    runSettingsCommand('trust', '', failed.ctx),
    /trust write failed/,
  );
});

void test('aborted commands open no dialogs, and abort after a dialog prevents mutations or reopened settings', async () => {
  for (const name of [
    'thinking',
    'model',
    'settings',
    'scoped-models',
    'trust',
  ]) {
    const h = harness();
    h.ctx.signal = AbortSignal.abort();
    assert.equal(await runSettingsCommand(name, '', h.ctx), true);
    assert.deepEqual(h.dialogs, []);
    assert.deepEqual(h.modelSelections, []);
    assert.deepEqual(h.thinkingSelections, []);
    assert.deepEqual(h.refreshes, []);
  }
  for (const command of ['settings', 'scoped-models']) {
    const abort = new AbortController();
    const h = harness([
      dialog => {
        abort.abort();
        return dialog.options[0];
      },
    ]);
    h.ctx.signal = abort.signal;
    await runSettingsCommand(command, '', h.ctx);
    assert.equal(h.dialogs.length, 1);
    assert.deepEqual(h.configurations, []);
    assert.deepEqual(h.mutations, []);
  }
  const thinkingAbort = new AbortController();
  const thinking = harness();
  thinking.ctx.signal = thinkingAbort.signal;
  thinking.ctx.ui.selectThinking = async () => {
    thinkingAbort.abort();
    return {thinkingLevel: 'high', persist: true};
  };
  await runSettingsCommand('thinking', '', thinking.ctx);
  assert.deepEqual(thinking.configurations, []);
  const abort = new AbortController();
  const h = harness([
    choose('Auto retry:'),
    () => {
      abort.abort();
      return 'off';
    },
  ]);
  h.ctx.signal = abort.signal;
  await runSettingsCommand('settings', '', h.ctx);
  assert.equal(h.dialogs.length, 2);
  assert.equal(h.settings.getRetryEnabled(), true);
  assert.deepEqual(h.configurations, []);
});

void test('abort during catalog refresh/model selection and trust selection prevents subsequent work', async t => {
  const abort = new AbortController();
  const h = harness();
  h.ctx.signal = abort.signal;
  h.state.modelRuntime.refresh = async options => {
    const signal = (options as {signal: AbortSignal}).signal;
    abort.abort();
    assert.equal(signal.aborted, true);
    return {aborted: true, errors: new Map()};
  };
  await runSettingsCommand('model', 'unknown', h.ctx);
  assert.deepEqual(h.modelSelections, []);
  assert.deepEqual(h.configurations, []);
  const modelAbort = new AbortController();
  const picker = harness();
  picker.ctx.ui.selectModel = async () => {
    modelAbort.abort();
    return {model: third, persist: true};
  };
  picker.ctx.signal = modelAbort.signal;
  await runSettingsCommand('model', '', picker.ctx);
  assert.deepEqual(picker.configurations, []);
  t.mock.method(ProjectTrustStore.prototype, 'getEntry', () => null);
  const write = t.mock.method(ProjectTrustStore.prototype, 'setMany', () => {});
  const trustAbort = new AbortController();
  const trust = harness([
    () => {
      trustAbort.abort();
      return 'Trust';
    },
  ]);
  trust.ctx.signal = trustAbort.signal;
  await runSettingsCommand('trust', '', trust.ctx);
  assert.equal(write.mock.callCount(), 0);
});

void test('saving existing session scope preserves matching patterns and unavailable entries', async () => {
  const h = harness(['Apply and save to Pi settings']);
  h.setScopes([
    {model: first, thinkingLevel: 'high'},
    {model: second, thinkingLevel: 'high'},
  ]);
  h.settings.setEnabledModels(['one/**:high', 'offline/not-loaded:low']);
  await runSettingsCommand('scoped-models', '', h.ctx);
  assert.deepEqual(h.settings.getEnabledModels(), [
    'one/**:high',
    'offline/not-loaded:low',
  ]);
  assert.deepEqual(h.ctx.session.scopedModels, [
    {model: first, thinkingLevel: 'high'},
    {model: second, thinkingLevel: 'high'},
  ]);
});

void test('editing existing session scope retains model efforts and unavailable saved patterns', async () => {
  const h = harness([
    'Toggle a model',
    'one',
    '[ ] one/nested/second',
    'Apply and save to Pi settings',
  ]);
  h.setScopes([{model: first, thinkingLevel: 'off'}]);
  h.settings.setEnabledModels(['one/first:off', 'offline/not-loaded:high']);
  await runSettingsCommand('scoped-models', '', h.ctx);
  assert.deepEqual(h.settings.getEnabledModels(), [
    'one/first:off',
    'one/nested/second',
    'offline/not-loaded:high',
  ]);
  assert.deepEqual(h.ctx.session.scopedModels, [
    {model: first, thinkingLevel: 'off'},
    {model: second},
  ]);
});

void test('saving a session scope different from saved patterns persists its own efforts', async () => {
  const h = harness(['Apply and save to Pi settings']);
  h.setScopes([{model: first, thinkingLevel: 'low'}]);
  h.settings.setEnabledModels(['one/**:high', 'offline/not-loaded']);
  await runSettingsCommand('scoped-models', '', h.ctx);
  assert.deepEqual(h.settings.getEnabledModels(), [
    'one/first:low',
    'offline/not-loaded',
  ]);
  assert.deepEqual(h.ctx.session.scopedModels, [
    {model: first, thinkingLevel: 'low'},
  ]);
});

void test('selecting every available scoped model retains explicit thinking levels', async () => {
  const h = harness(['Apply and save to Pi settings'], [first, second]);
  const scoped = [
    {model: first, thinkingLevel: 'high' as const},
    {model: second, thinkingLevel: 'off' as const},
  ];
  h.setScopes(scoped);
  await runSettingsCommand('scoped-models', '', h.ctx);
  assert.deepEqual(h.settings.getEnabledModels(), [
    'one/first:high',
    'one/nested/second:off',
  ]);
  assert.deepEqual(h.ctx.session.scopedModels, scoped);
});

void test('an unconfigured scope draft starts deselected and requires an explicit choice', async () => {
  const h = harness([
    'Toggle a model',
    'one',
    dialog => {
      assert.deepEqual(dialog.options, [
        '[ ] one/first',
        '[ ] one/nested/second',
      ]);
      return '[ ] one/first';
    },
    'Apply and save to Pi settings',
  ]);
  await runSettingsCommand('scoped-models', '', h.ctx);
  assert.match(h.dialogs[0].message!, /0 models selected/);
  assert.deepEqual(h.settings.getEnabledModels(), ['one/first']);
  assert.deepEqual(h.ctx.session.scopedModels, [{model: first}]);

  const empty = harness(['Apply and save to Pi settings']);
  await assert.rejects(
    runSettingsCommand('scoped-models', '', empty.ctx),
    /Pi treats an empty scope as all models/,
  );
  assert.equal(empty.settings.getEnabledModels(), undefined);
  assert.deepEqual(empty.mutations, []);
});
