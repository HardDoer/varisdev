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

void test('thinking picker offers supported levels and selects current without rewriting startup defaults', async () => {
  const h = harness(['high']);
  h.settings.setDefaultThinkingLevel('low');
  assert.equal(await runSettingsCommand('thinking', '', h.ctx), true);
  assert.deepEqual(h.dialogs[0].options, ['off', 'low', 'medium', 'high']);
  assert.equal(h.dialogs[0].selected, 'medium');
  assert.deepEqual(h.configurations, [{thinkingLevel: 'high'}]);
  assert.equal(h.settings.getDefaultThinkingLevel(), 'low');
});

void test('thinking cancellation/current choice are no-ops; explicit levels normalize and validate', async () => {
  for (const reply of [undefined, 'medium']) {
    const h = harness([reply]);
    await runSettingsCommand('thinking', '', h.ctx);
    assert.deepEqual(h.configurations, []);
  }
  const h = harness();
  await runSettingsCommand('thinking', ' HIGH ', h.ctx);
  assert.deepEqual(h.configurations, [{thinkingLevel: 'high'}]);
  await assert.rejects(
    runSettingsCommand('thinking', 'xhigh', h.ctx),
    /off, low, medium, high/,
  );
  const badUI = harness(['not-an-option']);
  await assert.rejects(
    runSettingsCommand('thinking', '', badUI.ctx),
    /Invalid settings selection/,
  );
  assert.deepEqual(badUI.configurations, []);
});

void test('model picker is provider-first and uses real available models, including slash-containing IDs', async () => {
  const h = harness(['one', 'one/nested/second']);
  h.settings.setDefaultModelAndProvider('two', 'startup');
  await runSettingsCommand('model', '', h.ctx);
  assert.deepEqual(h.dialogs[0].options, ['one', 'two']);
  assert.equal(h.dialogs[0].selected, 'one');
  assert.deepEqual(h.dialogs[1].options, ['one/first', 'one/nested/second']);
  assert.equal(h.dialogs[1].selected, 'one/first');
  assert.deepEqual(h.configurations, [
    {provider: 'one', modelId: 'nested/second'},
  ]);
  assert.deepEqual(h.refreshes, [{allowNetwork: false, signal: undefined}]);
  assert.equal(h.settings.getDefaultProvider(), 'two');
  assert.equal(h.settings.getDefaultModel(), 'startup');
});

void test('model explicit references validate availability; cancellation and current selection do not mutate', async () => {
  const h = harness();
  await runSettingsCommand('model', 'one/nested/second', h.ctx);
  assert.deepEqual(h.configurations, [
    {provider: 'one', modelId: 'nested/second'},
  ]);
  await assert.rejects(
    runSettingsCommand('model', 'one/missing', h.ctx),
    /unavailable/,
  );
  for (const value of ['one', '/first', 'one/'])
    await assert.rejects(
      runSettingsCommand('model', value, h.ctx),
      /provider\/model/,
    );
  for (const replies of [
    [undefined],
    ['one', undefined],
    ['one', 'one/first'],
  ]) {
    const cancelled = harness(replies);
    await runSettingsCommand('model', '', cancelled.ctx);
    assert.deepEqual(cancelled.configurations, []);
  }
  const none = harness([], []);
  await runSettingsCommand('model', '', none.ctx);
  assert.match(none.shown[0].message, /No authenticated chat models/);
});

void test('model scope is real Pi session scope, with an escape to all authenticated models', async () => {
  const scoped = harness(['Scoped models', 'two', 'two/third']);
  scoped.setScopes([{model: third, thinkingLevel: 'high'}]);
  await runSettingsCommand('model', '', scoped.ctx);
  assert.equal(scoped.dialogs[0].selected, 'Scoped models');
  assert.deepEqual(scoped.dialogs[1].options, ['two']);
  assert.deepEqual(scoped.configurations, [
    {provider: 'two', modelId: 'third'},
  ]);
  const all = harness(['All available models', 'one', 'one/nested/second']);
  all.setScopes([{model: third}]);
  await runSettingsCommand('model', '', all.ctx);
  assert.deepEqual(all.dialogs[1].options, ['one', 'two']);
  assert.deepEqual(all.configurations, [
    {provider: 'one', modelId: 'nested/second'},
  ]);
});

void test('thousands of models are paginated, with current model page preselected and later entries reachable', async () => {
  const models = Array.from({length: 2501}, (_, i) =>
    model('many', `m-${String(i).padStart(4, '0')}`),
  );
  const h = harness(['many', 'Next page →', 'many/m-2010'], models);
  h.state.model = models[1999];
  await runSettingsCommand('model', '', h.ctx);
  assert.equal(h.dialogs[1].selected, 'many/m-1999');
  assert.match(h.dialogs[1].title, /10\/13/);
  assert.deepEqual(h.configurations, [{provider: 'many', modelId: 'm-2010'}]);
  for (const dialog of h.dialogs) {
    assert.ok(dialog.options.length <= 202);
    assert.ok(Buffer.byteLength(JSON.stringify(dialog.options)) < 1024 * 1024);
  }
});

void test('catalog pagination also bounds bytes, not only entry count', async () => {
  const models = Array.from({length: 210}, (_, i) =>
    model('big', `${String(i).padStart(3, '0')}-${'x'.repeat(9000)}`),
  );
  const h = harness(
    ['big', 'Next page →', dialog => dialog.options[0]],
    models,
  );
  await runSettingsCommand('model', '', h.ctx);
  assert.ok(h.dialogs[1].options.length < 100);
  assert.equal(h.configurations.length, 1);
  for (const dialog of h.dialogs)
    assert.ok(Buffer.byteLength(JSON.stringify(dialog.options)) < 1024 * 1024);
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
  const h = harness([
    choose('Thinking level:'),
    'high',
    choose('Model:'),
    'two',
    'two/third',
    undefined,
  ]);
  await runSettingsCommand('settings', '', h.ctx);
  assert.deepEqual(h.configurations, [
    {thinkingLevel: 'high'},
    {provider: 'two', modelId: 'third'},
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
  const config = harness(['high']);
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
  assert.deepEqual(save.settings.getEnabledModels(), ['one/first']);
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
    'one/first',
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
    assert.deepEqual(h.refreshes, []);
  }
  for (const command of ['thinking', 'settings', 'scoped-models']) {
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
    assert.equal((options as {signal: AbortSignal}).signal, abort.signal);
    abort.abort();
    return {aborted: true, errors: new Map()};
  };
  await runSettingsCommand('model', '', h.ctx);
  assert.deepEqual(h.dialogs, []);
  const modelAbort = new AbortController();
  const picker = harness([
    'two',
    () => {
      modelAbort.abort();
      return 'two/third';
    },
  ]);
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
