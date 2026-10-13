import assert from 'node:assert/strict';
import type {ChildProcess} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type {AgentSessionController} from '../src/agents/team.ts';
import {registerFactory} from '../src/dashboard/index.ts';
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
  const current = state('primary');
  bridge.attach(current, {
    prompt: text => {
      prompts.push(text);
    },
    abort: () => {
      aborts++;
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
  await requests.request('abort', 'primary');
  assert.equal(aborts, 1);
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
    prompt: 'danger',
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
    prompt: text => {
      prompts.push(text);
    },
    abort: () => {
      aborts++;
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
  const pi = {
    on(
      event: string,
      handler: (event: unknown, context: ExtensionContext) => unknown,
    ) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(
      name: string,
      command: {
        handler: (args: string, context: ExtensionContext) => Promise<void>;
      },
    ) {
      commands.set(name, command);
    },
    sendUserMessage(prompt: unknown, options: unknown) {
      messages.push({prompt, options});
    },
  };
  const ctx = {
    mode,
    cwd: process.cwd(),
    model: {provider: 'fixture', id: 'model'},
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ok: true, apiKey: 'fixture-key'}),
    },
    getContextUsage: () => undefined,
    isIdle: () => idle,
    abort: () => {
      aborts++;
    },
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
    },
    sessionManager: {
      getSessionId: () => id,
      getSessionName: () => id,
      getSessionFile: () => undefined,
      getHeader: () => undefined,
      getBranch: () => [],
    },
  } as unknown as ExtensionContext;
  registerFactory(
    pi as unknown as ExtensionAPI,
    control as unknown as AgentSessionController,
    {
      launch: (state, callbacks) => launcher.launch(state, callbacks),
      detach: (state, quit) => launcher.detach(state, quit),
    },
  );
  return {
    ctx,
    messages,
    notifications,
    worker,
    control,
    get aborts() {
      return aborts;
    },
    setIdle(value: boolean) {
      idle = value;
    },
    async emit(event: string, payload: unknown = {}) {
      for (const handler of handlers.get(event) ?? [])
        await handler(payload, ctx);
      await tick();
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

void test('interactive startup attaches the existing conversation, controls it and reuses one GUI across reloads', async () => {
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
  assert.equal(launches, 1);
  assert.equal(desktop.current?.snapshot().session.id, 'first');
  const old = desktop.callbacks;
  await old.prompt('Continue through the GUI');
  assert.deepEqual(first.messages, [
    {
      prompt: 'Continue through the GUI',
      options: {deliverAs: 'followUp', expandPromptTemplates: false},
    },
  ]);
  first.control.snapshot = () => ({});
  await old.abort();
  assert.equal(first.aborts, 1);
  assert.equal(first.worker.status, 'cancelled');
  await first.show();
  assert.equal(launches, 1);
  assert.equal(desktop.shows, 1);
  await first.emit('session_shutdown', {reason: 'reload'});
  assert.equal(desktop.closes, 0);
  assert.throws(() => old.prompt('Stale context'), /no longer attached/);
  const second = extensionFixture('tui', 'second', launcher);
  await second.emit('session_start');
  assert.equal(launches, 1);
  assert.equal(desktop.current?.snapshot().session.id, 'second');
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
  await first.emit('session_shutdown', {reason: 'new'});
  const next = extensionFixture('tui', 'new', launcher);
  await next.emit('session_start');
  opening.resolve(desktop.window);
  await tick();
  assert.equal(launches, 1);
  assert.equal(desktop.current?.snapshot().session.id, 'new');
  await desktop.callbacks.prompt('Use current binding');
  assert.equal(first.messages.length, 0);
  assert.equal(next.messages.length, 1);
  await next.emit('session_shutdown', {reason: 'quit'});
});

void test('GUI follow-ups wait for settled idle runs and Stop clears only their unsubmitted queue', async () => {
  const desktop = fakeWindow();
  const launcher = new FactoryLauncher(async () => desktop.window);
  const source = extensionFixture('tui', 'queued-primary', launcher);
  await source.emit('session_start');
  source.setIdle(false);
  await desktop.callbacks.prompt('First follow-up');
  await desktop.callbacks.prompt('Second follow-up');
  assert.equal(desktop.callbacks.pendingPrompts, 2);
  assert.equal(
    source.messages.length,
    0,
    'busy prompts remain outside the native SDK queue',
  );
  await source.emit('agent_settled');
  assert.equal(
    source.messages.length,
    0,
    'settled events only drain when the SDK is idle',
  );
  source.setIdle(true);
  await source.emit('agent_settled');
  assert.equal(source.messages.length, 1);
  assert.equal(source.messages[0].prompt, 'First follow-up');
  assert.equal(desktop.callbacks.pendingPrompts, 1);
  await desktop.callbacks.prompt('Third follow-up');
  await tick();
  assert.equal(
    source.messages.length,
    1,
    'SDK preflight reserves the runner even while isIdle is still true',
  );
  assert.equal(desktop.callbacks.pendingPrompts, 2);
  source.setIdle(false);
  await source.emit('agent_start');
  source.setIdle(true);
  await source.emit('agent_settled');
  assert.equal(source.messages.length, 2);
  assert.equal(source.messages[1].prompt, 'Second follow-up');
  await desktop.callbacks.abort();
  assert.equal(desktop.callbacks.pendingPrompts, 0);
  await source.emit('agent_settled');
  assert.equal(
    source.messages.length,
    2,
    'Stop prevents the third follow-up from ever entering the SDK',
  );
  source.setIdle(false);
  for (let index = 0; index < 32; index++)
    await desktop.callbacks.prompt(`Queued ${index}`);
  assert.throws(() => desktop.callbacks.prompt('Overflow'), /32 queued/);
  assert.equal(desktop.callbacks.pendingPrompts, 32);
  await desktop.callbacks.abort();
  source.setIdle(true);
  await source.emit('agent_settled');
  assert.equal(source.messages.length, 2);
  await source.emit('session_shutdown', {reason: 'quit'});
});

void test('Stop during GUI credential setup prevents submission and configuration errors appear in snapshots', async t => {
  const desktop = fakeWindow();
  const launcher = new FactoryLauncher(async () => desktop.window);
  const source = extensionFixture('tui', 'credential-primary', launcher);
  await source.emit('session_start');
  const credentials = Promise.withResolvers<{ok: true; apiKey: string}>();
  t.mock.method(
    source.ctx.modelRegistry,
    'getApiKeyAndHeaders',
    () => credentials.promise,
  );
  await desktop.callbacks.prompt('Must be cancelled before submission');
  await desktop.callbacks.prompt('Must also be cleared');
  await source.emit('agent_settled');
  assert.equal(
    desktop.callbacks.pendingPrompts,
    1,
    'a concurrent native settlement keeps credential setup reserved',
  );
  await desktop.callbacks.abort();
  credentials.resolve({ok: true, apiKey: 'private-fixture-key'});
  await tick();
  assert.equal(source.messages.length, 0);
  assert.equal(desktop.callbacks.pendingPrompts, 0);
  source.ctx.model = undefined;
  await desktop.callbacks.prompt('Needs a model');
  await tick();
  assert.match(desktop.current!.snapshot().session.error!, /No model selected/);
  assert.equal(source.messages.length, 0);
  assert.doesNotMatch(
    JSON.stringify(desktop.current!.snapshot()),
    /private-fixture-key/,
  );
  await source.emit('session_shutdown', {reason: 'quit'});
});

void test('source IPC snapshots preserve public conversation and session file alongside queued prompt counts', () => {
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
    pendingPrompts: 3,
    prompt: () => {},
    abort: () => {},
  });
  bridge.ready();
  assert.deepEqual(child.sent.at(-1)?.snapshot, current.snapshot());
  assert.equal(child.sent.at(-1)?.pendingPrompts, 3);
  bridge.detach();
});

void test('delayed extension input cannot clear Stop before a cancelled GUI prompt starts', async () => {
  const desktop = fakeWindow();
  const launcher = new FactoryLauncher(async () => desktop.window);
  const source = extensionFixture('tui', 'delayed-input-primary', launcher);
  await source.emit('session_start');
  await desktop.callbacks.prompt('Cancelled during SDK preflight');
  await desktop.callbacks.prompt('Queued GUI task must be discarded');
  assert.equal(source.messages.length, 1);
  assert.equal(desktop.callbacks.pendingPrompts, 1);
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
  source.setIdle(true);
  await source.emit('agent_settled');
  assert.equal(desktop.callbacks.pendingPrompts, 0);
  assert.equal(
    source.messages.length,
    1,
    'cleared GUI follow-ups do not resume',
  );
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
