import assert from 'node:assert/strict';
import type {ChildProcess} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import type {
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type {AgentSessionController} from '../src/agents/team.ts';
import type {AgentToolsOptions} from '../src/tools/agents.ts';
import {
  createDefaultAgentProfile,
  saveAgentTemplate,
  type AgentTemplate,
} from '../src/agents/templates.ts';
import {registerFactory} from '../src/dashboard/index.ts';
import type {SessionFeatures} from '../src/dashboard/features.ts';
import {DashboardState} from '../src/dashboard/state.ts';
import {
  ExternalSessionRequests,
  type FactoryRequest,
} from '../src/desktop/ipc.ts';
import {
  createFactoryBridge,
  FactoryLauncher,
  type FactoryControl,
  type FactoryWindow,
} from '../src/desktop/launcher.ts';

function features(): SessionFeatures {
  return {
    commands: [],
    models: [],
    thinkingLevel: 'off',
    thinkingLevels: ['off'],
    tools: [],
    diagnostics: [],
  };
}

const featureControls = {
  cancelAgent: async () => {},
  features: async () => features(),
  configure: async () => {},
  compact: async () => {},
  reload: async () => {},
};

function state(id: string): DashboardState {
  const now = new Date().toISOString();
  return new DashboardState({
    id,
    name: id,
    cwd: process.cwd(),
    status: 'idle',
    activity: 'Ready',
    startedAt: now,
    updatedAt: now,
  });
}

class FakeChild extends EventEmitter {
  connected = true;
  sent: Array<Record<string, unknown>> = [];
  deliver?: (message: Record<string, unknown>) => void;
  send(
    message: Record<string, unknown>,
    callback?: (error: Error | null) => void,
  ): boolean {
    this.sent.push(message);
    this.deliver?.(message);
    callback?.(null);
    return true;
  }
  disconnect() {
    this.connected = false;
    this.emit('disconnect');
  }
}

void test('desktop IPC controls only the attached session and rejects stale or invalid requests', async () => {
  const child = new FakeChild();
  const bridge = createFactoryBridge(child as unknown as ChildProcess);
  const prompts: string[] = [];
  let aborts = 0;
  const cancellations: string[] = [];
  const current = state('primary');
  bridge.attach(current, {
    ...featureControls,
    cancelAgent: agentId => {
      cancellations.push(agentId);
    },
    prompt: text => {
      prompts.push(text);
    },
    abort: () => {
      aborts++;
      return {steering: ['Queued correction'], followUp: []};
    },
  });
  bridge.ready();
  assert.equal(child.sent.at(-1)?.controllable, true);
  const requests = new ExternalSessionRequests(
    async message => {
      child.emit('message', message);
    },
    () => child.connected,
  );
  child.deliver = message => {
    requests.reply(message);
  };
  await requests.request('prompt', 'primary', '  Continue the conversation  ');
  assert.deepEqual(prompts, ['Continue the conversation']);
  assert.deepEqual(await requests.request('abort', 'primary'), {
    steering: ['Queued correction'],
    followUp: [],
  });
  assert.equal(aborts, 1);
  assert.equal(cancellations.length, 0);
  await requests.request('cancelAgent', 'primary', 'worker');
  await requests.request('cancelAgent', 'primary', 'all');
  assert.deepEqual(cancellations, ['worker', 'all']);
  await assert.rejects(
    requests.request('cancelAgent', 'other', 'all'),
    /no longer attached/,
  );
  await assert.rejects(
    requests.request('cancelAgent', 'primary', {}),
    /Agent ID/,
  );
  assert.deepEqual(cancellations, ['worker', 'all']);
  await assert.rejects(
    requests.request('prompt', 'previous-session', 'Do not run'),
    /no longer attached/,
  );
  await assert.rejects(requests.request('prompt', 'primary', ' '), /Prompt/);
  child.emit('message', {
    type: 'request',
    id: 'bad-action',
    sessionId: 'primary',
    action: 'eval',
    input: 'danger',
  });
  assert.match(String(child.sent.at(-1)?.error), /Unknown/);
  const sent = child.sent.length;
  child.emit('message', {
    type: 'request',
    id: 'x'.repeat(97),
    sessionId: 'primary',
    action: 'abort',
  });
  assert.equal(child.sent.length, sent);
  assert.equal(aborts, 1);

  // Detaching between request receipt and callback execution invalidates it.
  const pending = requests.request(
    'prompt',
    'primary',
    'Must not reach old context',
  );
  const rejected = assert.rejects(pending, /changed/);
  bridge.detach(current);
  await rejected;
  assert.deepEqual(prompts, ['Continue the conversation']);
  bridge.attach(state('replacement'), {
    ...featureControls,
    cancelAgent: agentId => {
      cancellations.push(agentId);
    },
    prompt: text => {
      prompts.push(text);
    },
    abort: () => {
      aborts++;
      return {steering: [], followUp: []};
    },
  });
  bridge.detach(current);
  await requests.request('prompt', 'replacement', 'New session');
  assert.deepEqual(prompts, ['Continue the conversation', 'New session']);
  child.disconnect();
  await tick();
  assert.equal(
    aborts,
    2,
    'losing the GUI stops work in its active conversation',
  );
  assert.equal(
    cancellations.at(-1),
    'all',
    'GUI loss cancels its attached agents',
  );
  assert.equal(bridge.connected, false);
  await assert.rejects(
    requests.request('abort', 'replacement'),
    /disconnected/,
  );
});

void test('desktop pending requests are bounded, time out and reject on disconnect or reattachment', async () => {
  const sent: FactoryRequest[] = [];
  let connected = true;
  const requests = new ExternalSessionRequests(
    async message => {
      sent.push(message);
    },
    () => connected,
    1000,
  );
  const pending = Array.from({length: 32}, () =>
    requests.request('prompt', 'primary', 'Queued'),
  );
  const rejected = pending.map(operation =>
    assert.rejects(operation, /changed/),
  );
  await assert.rejects(requests.request('abort', 'primary'), /32 pending/);
  requests.disconnect('The attached Pi session changed.');
  await Promise.all(rejected);
  requests.reply({type: 'reply', id: sent[0].id, ok: true});
  const disconnecting = requests.request('abort', 'primary');
  const disconnected = assert.rejects(disconnecting, /disconnected/);
  connected = false;
  requests.disconnect();
  await disconnected;
  await assert.rejects(requests.request('abort', 'primary'), /disconnected/);
  const timed = new ExternalSessionRequests(
    async () => {},
    () => true,
    10,
  );
  await assert.rejects(timed.request('abort', 'primary'), /did not answer/);
  const failed = new ExternalSessionRequests(
    async () => {
      throw new Error('IPC pipe closed');
    },
    () => true,
  );
  await assert.rejects(failed.request('abort', 'primary'), /IPC pipe closed/);
});

function extensionFixture(
  mode: ExtensionContext['mode'],
  id: string,
  launcher: FactoryLauncher,
  cwd = process.cwd(),
  agentTools: AgentToolsOptions = {},
) {
  const handlers = new Map<
    string,
    Array<(event: unknown, context: ExtensionContext) => unknown>
  >();
  const commands = new Map<
    string,
    {handler: (args: string, context: ExtensionContext) => Promise<void>}
  >();
  const messages: Array<{prompt: unknown; options: unknown}> = [];
  const notifications: string[] = [];
  let aborts = 0;
  let idle = true;
  let thinkingLevel = 'off';
  const compacted: Array<string | undefined> = [];
  const models = [
    {provider: 'fixture', id: 'model', name: 'Fixture model', reasoning: true},
    {provider: 'fixture', id: 'other', name: 'Other model', reasoning: false},
  ];
  const worker = {id: 'worker', status: 'running'};
  const manager = {
    list: () => [worker],
    cancel: () => {
      worker.status = 'cancelled';
    },
    subscribe: () => () => {},
  };
  const control = {
    snapshot: (): object | undefined => undefined,
    subscribe: () => () => {},
    getTeam: () => ({getManager: () => manager}),
  };
  const confirmations: Array<{title: string; message: string}> = [];
  const events = new EventEmitter();
  let activeTools = ['fixture_tool'];
  const entries: ReturnType<ExtensionContext['sessionManager']['getEntries']> =
    [];
  const pi = {
    events: {
      on(name: string, handler: (value: unknown) => void) {
        events.on(name, handler);
        return () => events.off(name, handler);
      },
      emit(name: string, value: unknown) {
        events.emit(name, value);
      },
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools = [...names];
    },
    appendEntry(customType: string, data: unknown) {
      const entry = {
        type: 'custom' as const,
        id: `entry-${entries.length}`,
        parentId: null,
        timestamp: new Date().toISOString(),
        customType,
        data: structuredClone(data),
      };
      entries.push(entry);
      return entry.id;
    },
    on(
      event: string,
      handler: (event: unknown, context: ExtensionContext) => unknown,
    ) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const index = list.indexOf(handler);
        if (index !== -1) list.splice(index, 1);
      };
    },
    registerCommand(
      name: string,
      command: {
        handler: (args: string, context: ExtensionContext) => Promise<void>;
      },
    ) {
      commands.set(name, command);
    },
    getCommands: () => [
      {
        name: 'skill:fixture',
        description: 'Fixture skill',
        source: 'skill',
        sourceInfo: {path: '/fixture/SKILL.md'},
      },
      {
        name: 'template',
        description: 'Fixture template',
        source: 'prompt',
        sourceInfo: {path: '/fixture/prompt.md'},
      },
    ],
    getAllTools: () => [{name: 'fixture_tool', description: 'Fixture tool'}],
    getThinkingLevel: () => thinkingLevel,
    setThinkingLevel: (value: string) => {
      thinkingLevel = value;
    },
    async setModel(model: ExtensionContext['model']) {
      ctx.model = model;
      return true;
    },
    sendUserMessage(prompt: unknown, options: unknown) {
      messages.push({prompt, options});
    },
  };
  let systemPromptOptions: BuildSystemPromptOptions = {
    cwd,
    contextFiles: [
      {path: '/fixture/AGENTS.md', content: 'ATTACHED INSTRUCTIONS'},
    ],
    skills: [],
  };
  const ctx = {
    getSystemPromptOptions: () => systemPromptOptions,
    hasUI: true,
    mode,
    cwd,
    model: models[0],
    scopedModels: [],
    compact: (options: {customInstructions?: string; onComplete(): void}) => {
      compacted.push(options.customInstructions);
      options.onComplete();
    },
    modelRegistry: {
      getAvailable: () => models,
      getError: () => undefined,
      getApiKeyAndHeaders: async () => ({ok: true, apiKey: 'fixture-key'}),
    },
    getContextUsage: () => undefined,
    isIdle: () => idle,
    abort: () => {
      aborts++;
    },
    ui: {
      async confirm(title: string, message: string) {
        confirmations.push({title, message});
        return true;
      },
      notify: (message: string) => {
        notifications.push(message);
      },
    },
    sessionManager: {
      getSessionId: () => id,
      getSessionName: () => id,
      getSessionFile: () => undefined,
      getHeader: () => undefined,
      getEntries: () => entries,
      getBranch: () => entries,
      buildContextEntries: () => [],
    },
  } as unknown as ExtensionContext;
  registerFactory(
    pi as unknown as ExtensionAPI,
    control as unknown as AgentSessionController,
    {
      isOpen: () => launcher.isOpen,
      launch: (state, callbacks) => launcher.launch(state, callbacks),
      detach: (state, quit) => launcher.detach(state, quit),
    },
    agentTools,
  );
  return {
    ctx,
    pi,
    messages,
    compacted,
    notifications,
    confirmations,
    worker,
    control,
    get aborts() {
      return aborts;
    },
    setIdle(value: boolean) {
      idle = value;
    },
    setSystemPromptOptions(options: BuildSystemPromptOptions) {
      systemPromptOptions = options;
    },
    async emit(event: string, payload: unknown = {}) {
      const results = [];
      for (const handler of handlers.get(event) ?? [])
        results.push(await handler(payload, ctx));
      await tick();
      return results;
    },
    show: () => commands.get('factory')!.handler('', ctx),
  };
}

function fakeWindow() {
  let callbacks: FactoryControl | undefined;
  let current: DashboardState | undefined;
  let connected = true;
  let shows = 0;
  let closes = 0;
  const window: FactoryWindow = {
    attach(state, control) {
      current = state;
      callbacks = control;
    },
    detach(state) {
      if (!state || state === current) {
        current = undefined;
        callbacks = undefined;
      }
    },
    show() {
      shows++;
    },
    close() {
      connected = false;
      closes++;
    },
    get connected() {
      return connected;
    },
  };
  return {
    window,
    get callbacks() {
      return callbacks!;
    },
    get current() {
      return current;
    },
    get shows() {
      return shows;
    },
    get closes() {
      return closes;
    },
  };
}

void test('attached context reads live command options and resource metadata through factory controls', async () => {
  const desktop = fakeWindow();
  const launcher = new FactoryLauncher(async () => desktop.window);
  const source = extensionFixture('tui', 'context', launcher);
  await source.emit('session_start');
  await source.show();
  const files = (await desktop.callbacks.features()).contextFiles!;
  assert.equal(
    files.find(file => file.path === '/fixture/AGENTS.md')?.content,
    'ATTACHED INSTRUCTIONS',
  );
  assert.equal(
    files.find(file => file.path === '/fixture/SKILL.md')?.status,
    'available',
  );
  assert.equal(
    files.find(file => file.path === '/fixture/SKILL.md')?.content,
    undefined,
  );
  assert.equal(
    files.find(file => file.path === '/fixture/prompt.md')?.kind,
    'template',
  );
  source.setSystemPromptOptions({
    cwd: source.ctx.cwd,
    contextFiles: [{path: '/fixture/NEW.md', content: 'NEW LOADED CONTENT'}],
    skills: [],
  });
  const refreshed = (await desktop.callbacks.features()).contextFiles!;
  assert.ok(!refreshed.some(file => file.path === '/fixture/AGENTS.md'));
  assert.equal(
    refreshed.find(file => file.path === '/fixture/NEW.md')?.content,
    'NEW LOADED CONTENT',
  );
});

void test('the explicit factory command attaches the existing conversation, controls it and reuses one GUI across reloads', async () => {
  const desktop = fakeWindow();
  let launches = 0;
  const launcher = new FactoryLauncher(async () => {
    launches++;
    return desktop.window;
  });
  for (const mode of ['rpc', 'json', 'print'] as const) {
    const headless = extensionFixture(mode, mode, launcher);
    await headless.emit('session_start');
    assert.equal(launches, 0);
    await headless.emit('session_shutdown', {reason: 'quit'});
  }
  const first = extensionFixture('tui', 'first', launcher);
  await first.emit('session_start');
  assert.equal(launches, 0);
  await first.show();
  assert.equal(launches, 1);
  assert.equal(desktop.current?.snapshot().session.id, 'first');
  assert.equal(desktop.current?.snapshot().session.thinkingLevel, 'off');
  first.pi.setThinkingLevel('high');
  await first.emit('thinking_level_select', {
    level: 'high',
    previousLevel: 'off',
  });
  assert.equal(desktop.current?.snapshot().session.thinkingLevel, 'high');
  const old = desktop.callbacks;
  await old.prompt('Continue through the GUI');
  assert.deepEqual(first.messages, [
    {
      prompt: 'Continue through the GUI',
      options: {deliverAs: 'steer', expandPromptTemplates: true},
    },
  ]);
  first.control.snapshot = () => ({});
  await old.abort();
  assert.equal(first.aborts, 1);
  assert.equal(first.worker.status, 'running');
  await old.cancelAgent('worker');
  assert.equal(first.worker.status, 'cancelled');
  await first.show();
  assert.equal(launches, 1);
  assert.equal(desktop.shows, 2);
  await first.emit('session_shutdown', {reason: 'reload'});
  assert.equal(desktop.closes, 0);
  await assert.rejects(
    Promise.resolve().then(() => old.prompt('Stale context')),
    /no longer attached/,
  );
  const second = extensionFixture('tui', 'second', launcher);
  await second.emit('session_start');
  assert.equal(launches, 1);
  assert.equal(desktop.current?.snapshot().session.id, 'second');
  assert.equal(desktop.current?.snapshot().session.thinkingLevel, 'off');
  await desktop.callbacks.prompt('New conversation');
  assert.equal(second.messages.length, 1);
  assert.equal(first.messages.length, 1);
  await first.emit('session_shutdown', {reason: 'quit'});
  assert.equal(desktop.current?.snapshot().session.id, 'second');
  await second.emit('session_shutdown', {reason: 'quit'});
  assert.equal(desktop.closes, 1);
});

void test('a source switch during startup binds the new context to the single pending window', async () => {
  const desktop = fakeWindow();
  const opening = Promise.withResolvers<FactoryWindow>();
  let launches = 0;
  const launcher = new FactoryLauncher(async () => {
    launches++;
    return opening.promise;
  });
  const first = extensionFixture('tui', 'old', launcher);
  await first.emit('session_start');
  const showing = first.show();
  await first.emit('session_shutdown', {reason: 'new'});
  const next = extensionFixture('tui', 'new', launcher);
  await next.emit('session_start');
  opening.resolve(desktop.window);
  await showing;
  await tick();
  assert.equal(launches, 1);
  assert.equal(desktop.current?.snapshot().session.id, 'new');
  await desktop.callbacks.prompt('Use current binding');
  assert.equal(first.messages.length, 0);
  assert.equal(next.messages.length, 1);
  await next.emit('session_shutdown', {reason: 'quit'});
});

void test('GUI follow-ups steer immediately while Stop preserves agents until explicit cancellation', async () => {
  const desktop = fakeWindow();
  const launcher = new FactoryLauncher(async () => desktop.window);
  const source = extensionFixture('tui', 'steer-primary', launcher);
  await source.emit('session_start');
  await source.show();
  source.setIdle(false);
  await desktop.callbacks.prompt('First steer');
  await desktop.callbacks.prompt('Second steer');
  assert.deepEqual(
    source.messages.map(message => message.prompt),
    ['First steer', 'Second steer'],
  );
  assert.deepEqual(
    source.messages.map(message => message.options),
    [
      {deliverAs: 'steer', expandPromptTemplates: true},
      {deliverAs: 'steer', expandPromptTemplates: true},
    ],
  );
  source.control.snapshot = () => ({});
  await desktop.callbacks.abort();
  assert.equal(source.aborts, 1);
  assert.equal(source.worker.status, 'running');
  await desktop.callbacks.cancelAgent('all');
  assert.equal(source.worker.status, 'cancelled');
  await source.emit('session_shutdown', {reason: 'quit'});
});

void test('Stop during GUI credential setup prevents submission and configuration errors appear in snapshots', async t => {
  const desktop = fakeWindow();
  const launcher = new FactoryLauncher(async () => desktop.window);
  const source = extensionFixture('tui', 'credential-primary', launcher);
  await source.emit('session_start');
  await source.show();
  const credentials = Promise.withResolvers<{ok: true; apiKey: string}>();
  t.mock.method(
    source.ctx.modelRegistry,
    'getApiKeyAndHeaders',
    () => credentials.promise,
  );
  const prompting = desktop.callbacks.prompt(
    'Must be cancelled before submission',
  );
  await source.emit('agent_settled');
  await desktop.callbacks.abort();
  credentials.resolve({ok: true, apiKey: 'private-fixture-key'});
  await prompting;
  await tick();
  assert.equal(source.messages.length, 0);
  source.ctx.model = undefined;
  await assert.rejects(
    Promise.resolve().then(() => desktop.callbacks.prompt('Needs a model')),
    /Choose a model before sending a task\./,
  );
  assert.equal(source.messages.length, 0);
  assert.doesNotMatch(
    JSON.stringify(desktop.current!.snapshot()),
    /private-fixture-key/,
  );
  await source.emit('session_shutdown', {reason: 'quit'});
});

void test('source IPC snapshots preserve public conversation without queue payloads', () => {
  const child = new FakeChild();
  const bridge = createFactoryBridge(child as unknown as ChildProcess);
  const current = state('history-primary');
  current.updateSession({sessionFile: '/fixture/history.jsonl'});
  current.replaceConversation([
    {
      id: 'message',
      role: 'assistant',
      text: 'Public answer',
      at: new Date().toISOString(),
    },
  ]);
  bridge.attach(current, {
    ...featureControls,
    prompt: () => {},
    abort: () => ({steering: [], followUp: []}),
  });
  bridge.ready();
  assert.deepEqual(child.sent.at(-1)?.snapshot, current.snapshot());
  assert.equal('queuedPrompts' in child.sent.at(-1)!, false);
  bridge.detach();
});

void test('delayed extension input cannot clear Stop before a cancelled GUI prompt starts', async () => {
  const desktop = fakeWindow();
  const launcher = new FactoryLauncher(async () => desktop.window);
  const source = extensionFixture('tui', 'delayed-input-primary', launcher);
  await source.emit('session_start');
  await source.show();
  const credentials = Promise.withResolvers<{ok: true; apiKey: string}>();
  const originalAuth = source.ctx.modelRegistry.getApiKeyAndHeaders;
  source.ctx.modelRegistry.getApiKeyAndHeaders = () => credentials.promise;
  const prompting = desktop.callbacks.prompt('Cancelled during SDK preflight');
  assert.equal(source.messages.length, 0);
  await desktop.callbacks.abort();
  assert.equal(source.aborts, 1);
  await source.emit('input', {
    source: 'extension',
    text: 'Cancelled during SDK preflight',
  });
  source.setIdle(false);
  await source.emit('agent_start');
  assert.equal(
    source.aborts,
    2,
    'agent_start still cancels the stopped SDK preflight',
  );
  credentials.resolve({ok: true, apiKey: 'fixture'});
  await prompting;
  source.ctx.modelRegistry.getApiKeyAndHeaders = originalAuth;
  source.setIdle(true);
  await source.emit('agent_settled');
  assert.equal(source.messages.length, 0, 'stopped GUI prompts do not resume');
  for (const inputSource of ['interactive', 'rpc']) {
    await desktop.callbacks.abort();
    const abortsBeforeInput: number = source.aborts;
    await source.emit('input', {source: inputSource, text: 'A new user task'});
    source.setIdle(false);
    await source.emit('agent_start');
    assert.equal(
      source.aborts,
      abortsBeforeInput,
      `${inputSource} input can start a new task after Stop`,
    );
    source.setIdle(true);
    await source.emit('agent_settled');
  }
  await source.emit('session_shutdown', {reason: 'quit'});
});

void test('feature catalogs and configuration results cross source IPC with session and input validation', async t => {
  const desktop = fakeWindow();
  const launcher = new FactoryLauncher(async () => desktop.window);
  const source = extensionFixture('tui', 'features-primary', launcher);
  await source.emit('session_start');
  await source.show();
  const child = new FakeChild();
  const bridge = createFactoryBridge(child as unknown as ChildProcess);
  const requests = new ExternalSessionRequests(
    async message => {
      child.emit('message', message);
    },
    () => child.connected,
  );
  child.deliver = message => {
    requests.reply(message);
  };
  bridge.attach(desktop.current!, desktop.callbacks);
  bridge.ready();
  t.after(() => bridge.detach());
  const catalog = await requests.request<SessionFeatures>(
    'features',
    'features-primary',
  );
  assert.deepEqual(catalog.agentProfile, {
    id: 'default',
    name: 'Default',
    mode: 'all',
  });
  assert.equal(catalog.commands[0].name, 'skill:fixture');
  assert.equal(catalog.commands[1].source, 'prompt');
  assert.equal(catalog.models[1].id, 'other');
  assert.equal(catalog.tools[0].name, 'fixture_tool');
  catalog.commands[0].name = 'Mutation';
  assert.equal(
    (await requests.request<SessionFeatures>('features', 'features-primary'))
      .commands[0].name,
    'skill:fixture',
  );
  await assert.rejects(
    requests.request('configure', 'features-primary', {provider: 'fixture'}),
    /Model/,
  );
  await assert.rejects(
    requests.request('configure', 'features-primary', {
      thinkingLevel: 'invalid',
    }),
    /thinking level/,
  );
  await assert.rejects(
    requests.request('compact', 'features-primary', 123),
    /Compaction instructions/,
  );
  await requests.request('configure', 'features-primary', {
    provider: 'fixture',
    modelId: 'other',
    thinkingLevel: 'off',
  });
  const changed = await requests.request<SessionFeatures>(
    'features',
    'features-primary',
  );
  assert.equal(changed.model?.id, 'other');
  assert.equal(changed.thinkingLevel, 'off');
  await requests.request('compact', 'features-primary', ' Keep the plan ');
  assert.deepEqual(source.compacted, ['Keep the plan']);
  await assert.rejects(
    requests.request('reload', 'features-primary'),
    /\/reload in its terminal/,
  );
  source.setIdle(false);
  await source.emit('agent_start');
  await requests.request('prompt', 'features-primary', '/skill:fixture');
  await requests.request('configure', 'features-primary', {
    provider: 'fixture',
    modelId: 'model',
    thinkingLevel: 'high',
  });
  await requests.request('configure', 'features-primary', {
    thinkingLevel: 'low',
  });
  const live = await requests.request<SessionFeatures>(
    'features',
    'features-primary',
  );
  assert.equal(live.model?.id, 'model');
  assert.equal(live.thinkingLevel, 'low');
  assert.equal(desktop.current!.snapshot().session.status, 'running');
  await requests.request('compact', 'features-primary');
  assert.deepEqual(source.compacted, ['Keep the plan', undefined]);
  source.setIdle(true);
  await source.emit('agent_settled');
  assert.deepEqual(source.messages.at(-1), {
    prompt: '/skill:fixture',
    options: {deliverAs: 'steer', expandPromptTemplates: true},
  });
  await requests.request('abort', 'features-primary');
  await assert.rejects(
    requests.request('features', 'previous'),
    /no longer attached/,
  );
  await source.emit('session_shutdown', {reason: 'quit'});
});

void test('attached extension commands reach SDK command dispatch without credentials', async t => {
  const desktop = fakeWindow();
  const launcher = new FactoryLauncher(async () => desktop.window);
  const source = extensionFixture('tui', 'commands-primary', launcher);
  await source.emit('session_start');
  await source.show();
  t.mock.method(source.pi, 'getCommands', () => [
    {
      name: 'fixture-command',
      description: 'Fixture extension',
      source: 'extension',
      sourceInfo: {path: '/fixture/extension.ts'},
    },
  ]);
  source.ctx.model = undefined;
  await desktop.callbacks.prompt('/fixture-command first');
  await tick();
  await desktop.callbacks.prompt('/fixture-command second');
  await tick();
  assert.deepEqual(source.messages, [
    {
      prompt: '/fixture-command first',
      options: {deliverAs: 'steer', expandPromptTemplates: true},
    },
    {
      prompt: '/fixture-command second',
      options: {deliverAs: 'steer', expandPromptTemplates: true},
    },
  ]);
  assert.equal(desktop.current!.snapshot().session.status, 'idle');
  await source.emit('session_shutdown', {reason: 'quit'});
});

void test('native attached sessions persist neutral selection and compose shared rules once', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varisdev-attached-profile-'));
  const agentDir = join(directory, 'settings');
  const cwd = join(directory, 'project');
  await mkdir(agentDir);
  await mkdir(cwd);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, {recursive: true, force: true});
  });
  const sharedRule = {
    action: 'shell',
    resource: 'blocked-native-command',
    effect: 'deny',
  } as const;
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({default_agent: 'replacement', permissions: [sharedRule]}),
  );
  for (const id of ['default', 'replacement'])
    await saveAgentTemplate(cwd, {
      scope: 'global',
      id,
      mode: 'primary',
      instructions: 'Never inject this replacement into native Pi.',
      model: 'fixture/other',
      thinkingLevel: 'off',
    });
  const launcher = new FactoryLauncher(async () => fakeWindow().window);
  const source = extensionFixture('tui', 'native-neutral', launcher, cwd);
  const originalModel = source.ctx.model;
  await source.emit('session_start');
  const profiles = () =>
    source.ctx.sessionManager
      .getEntries()
      .filter(
        entry =>
          entry.type === 'custom' &&
          entry.customType === 'varisdev.agent-profile',
      );
  assert.equal(profiles().length, 1);
  const entry = profiles()[0];
  assert.equal(entry.type, 'custom');
  const profile =
    entry.type === 'custom' ? (entry.data as AgentTemplate) : undefined;
  assert.equal(profile?.id, 'default');
  assert.equal(profile?.key, 'builtin:default');
  assert.equal(profile?.instructions, '');
  assert.equal(profile?.model, undefined);
  assert.equal(profile?.thinkingLevel, undefined);
  assert.equal(profile?.permissionsVersion, 1);
  assert.deepEqual(profile?.permissions, [sharedRule]);
  assert.equal(source.ctx.model, originalModel);
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      permissions: [{action: 'shell', resource: '*', effect: 'deny'}],
    }),
  );
  await source.emit('session_start');
  assert.equal(
    profiles().length,
    1,
    'an already composed snapshot is retained',
  );
  assert.deepEqual(profiles()[0], entry);

  const explicit = extensionFixture('tui', 'native-explicit', launcher, cwd);
  const saved = {
    ...createDefaultAgentProfile(),
    id: 'saved',
    key: 'global:saved',
    name: 'Saved',
    instructions: 'Original saved body.',
    model: 'fixture/saved-model',
    thinkingLevel: 'off' as const,
    permissions: [
      {action: 'shell', resource: 'allowed-command', effect: 'allow'} as const,
    ],
  };
  explicit.pi.appendEntry('varisdev.agent-profile', saved);
  await explicit.emit('session_start');
  const upgraded = explicit.ctx.sessionManager.getEntries().at(-1);
  assert.equal(upgraded?.type, 'custom');
  const snapshot =
    upgraded?.type === 'custom' ? (upgraded.data as AgentTemplate) : undefined;
  assert.equal(snapshot?.id, 'saved');
  assert.equal(snapshot?.instructions, saved.instructions);
  assert.equal(snapshot?.model, saved.model);
  assert.deepEqual(snapshot?.permissions, [
    {action: 'shell', resource: '*', effect: 'deny'},
    ...saved.permissions,
  ]);
  const count = explicit.ctx.sessionManager.getEntries().length;
  await explicit.emit('session_start');
  assert.equal(explicit.ctx.sessionManager.getEntries().length, count);
});

void test('native attached policies enforce shared rules and respect session-scoped host management', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varisdev-native-policy-'));
  const agentDir = join(directory, 'settings');
  const cwd = join(directory, 'project');
  await mkdir(agentDir);
  await mkdir(cwd);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, {recursive: true, force: true});
  });
  const permissions = [
    {action: 'shell', resource: 'blocked-native-command', effect: 'deny'},
    {action: 'shell', resource: 'approved-native-command', effect: 'ask'},
    {action: 'skill', resource: 'fixture', effect: 'deny'},
  ] as const;
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({permissions}),
  );
  const window = fakeWindow();
  const launcher = new FactoryLauncher(async () => window.window);
  const shared: AgentToolsOptions = {};
  const source = extensionFixture(
    'tui',
    'native-policy',
    launcher,
    cwd,
    shared,
  );
  source.pi.events.emit('varisdev:agent-profile-managed', {
    sessionId: 'other-session',
    profile: {...createDefaultAgentProfile(), permissionsVersion: 1},
  });
  await source.emit('session_start');
  assert.deepEqual(shared.agentProfile?.permissions, permissions);
  await source.show();
  assert.ok(
    !(await window.callbacks!.features!()).commands.some(
      command => command.name === 'skill:fixture',
    ),
  );
  const denied = await source.emit('tool_call', {
    toolName: 'bash',
    input: {command: 'blocked-native-command'},
  });
  assert.ok(
    denied.some(result =>
      JSON.stringify(result)?.includes(
        'Agent permission denied: shell blocked-native-command',
      ),
    ),
  );
  const read = await source.emit('tool_call', {
    toolName: 'read',
    input: {path: '/fixture/SKILL.md'},
  });
  assert.ok(
    read.some(result =>
      JSON.stringify(result)?.includes(
        'Agent permission denied: skill fixture',
      ),
    ),
  );
  const skill = await source.emit('input', {
    source: 'interactive',
    text: '/skill:fixture',
  });
  assert.ok(
    skill.some(result => JSON.stringify(result) === '{"action":"handled"}'),
  );
  assert.match(
    source.notifications.at(-1)!,
    /permission denied: skill fixture/,
  );
  await source.emit('tool_call', {
    toolName: 'bash',
    input: {command: 'approved-native-command'},
  });
  assert.equal(source.confirmations.length, 1);
  await source.emit('session_start');
  await source.emit('tool_call', {
    toolName: 'bash',
    input: {command: 'approved-native-command'},
  });
  assert.equal(
    source.confirmations.length,
    2,
    'repeated session start installs one policy',
  );

  const hostShared: AgentToolsOptions = {};
  const managed = extensionFixture(
    'tui',
    'managed-policy',
    launcher,
    cwd,
    hostShared,
  );
  const hostProfile: AgentTemplate = {
    ...createDefaultAgentProfile(),
    id: 'host-selected',
    name: 'Host selected',
    permissions: [...permissions],
    permissionsVersion: 1,
  };
  managed.pi.events.emit('varisdev:agent-profile-managed', {
    sessionId: 'managed-policy',
    profile: hostProfile,
  });
  await managed.emit('session_start');
  assert.equal(hostShared.agentProfile?.id, 'host-selected');
  const forwarded = await managed.emit('tool_call', {
    toolName: 'bash',
    input: {command: 'blocked-native-command'},
  });
  assert.ok(
    forwarded.every(
      result => !JSON.stringify(result)?.includes('"block":true'),
    ),
  );
  await managed.emit('tool_call', {
    toolName: 'bash',
    input: {command: 'approved-native-command'},
  });
  assert.equal(
    managed.confirmations.length,
    0,
    'the host owns permission approvals',
  );

  await writeFile(join(agentDir, 'settings.json'), '{}');
  const neutral = extensionFixture('tui', 'native-no-policy', launcher, cwd);
  await neutral.emit('session_start');
  const input = await neutral.emit('input', {
    source: 'interactive',
    text: '/skill:fixture',
  });
  assert.ok(
    input.every(result => !JSON.stringify(result)?.includes('handled')),
  );
  assert.equal(neutral.confirmations.length, 0);
});
