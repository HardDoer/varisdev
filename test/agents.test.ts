import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  setImmediate as nextTick,
  setTimeout as delay,
} from 'node:timers/promises';
import {test, type TestContext} from 'node:test';
import {Check} from 'typebox/value';
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  AgentOrchestrator,
  type AgentContextUsage,
  type AgentRecord,
  type AgentSpec,
  type AgentWorker,
} from '../src/agents/orchestrator.ts';
import {
  sessionWorker,
  type createSessionWorker,
} from '../src/agents/session.ts';
import {registerAgentTools} from '../src/tools/agents.ts';
import {saveToolSettings} from '../src/tools/settings.ts';
import {saveAgentTemplate} from '../src/agents/templates.ts';
import type {SessionFeatures} from '../src/dashboard/features.ts';

type AgentEventHandler = (
  event: {reason?: string},
  ctx: ExtensionContext,
) => Promise<void> | void;

function toolContext(ctx: ExtensionContext): ExtensionToolContext {
  return Object.assign(ctx, {
    tools: [],
    async executeTool(): Promise<never> {
      throw new Error('Nested tool calls are not configured for this fixture.');
    },
  });
}

const spec: AgentSpec = {
  name: 'worker',
  task: 'Inspect the project',
  cwd: process.cwd(),
  model: 'test/model',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {promise, resolve, reject};
}

function controlledWorker(cooperative = true, directory = '') {
  const runs: Array<{
    message: string;
    signal: AbortSignal;
    finish: (output: string) => void;
    fail: (error: unknown) => void;
    onActivity: Parameters<AgentWorker['run']>[2];
    onUsage: Parameters<AgentWorker['run']>[3];
    onConversation: Parameters<AgentWorker['run']>[4];
  }> = [];
  let disposed = 0;
  const steering: string[] = [];
  const worker: AgentWorker = {
    sessionFile: `${directory}/transcript.jsonl`,
    resultFile: `${directory}/result.txt`,
    async steer(message) {
      steering.push(message);
      return true;
    },
    async run(message, signal, onActivity, onUsage, onConversation) {
      const result = deferred<string>();
      const abort = () => result.reject(signal.reason);
      if (cooperative) signal.addEventListener('abort', abort, {once: true});
      runs.push({
        message,
        signal,
        finish: result.resolve,
        fail: result.reject,
        onActivity,
        onUsage,
        onConversation,
      });
      onActivity('Using read');
      try {
        signal.throwIfAborted();
        return await result.promise;
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
    dispose() {
      disposed++;
    },
  };
  return {
    worker,
    runs,
    steering,
    get disposed() {
      return disposed;
    },
  };
}

async function until(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await nextTick();
  }
  assert.fail('Expected state was not reached');
}

void test('five background agents plus the main conversation fill the default limit and drain queued work', async t => {
  const manager = new AgentOrchestrator();
  t.after(() => manager.close());
  const workers = Array.from({length: 8}, () => controlledWorker());
  let created = 0;
  const records = workers.map(({worker}) =>
    manager.spawn(spec, async () => {
      created++;
      return worker;
    }),
  );
  await until(() => workers[4].runs.length === 1);
  assert.equal(created, 5);
  assert.equal(manager.get(records[5].id).status, 'queued');
  manager.cancel(records[7].id);
  workers[0].runs[0].finish('result 0');
  await until(() => workers[5].runs.length === 1);
  assert.equal(created, 6);
  for (let index = 1; index < 7; index++) {
    await until(() => workers[index].runs.length === 1);
    workers[index].runs[0].finish(`result ${index}`);
  }
  const results = await manager.wait(records.map(record => record.id));
  assert.deepEqual(
    results.map(result => result.status),
    [...Array(7).fill('completed'), 'cancelled'],
  );
  assert.deepEqual(
    results.slice(0, 7).map(result => result.output),
    Array.from({length: 7}, (_, index) => `result ${index}`),
  );
  assert.equal(workers[7].runs.length, 0);
});

void test('messages steer active workers and completed workers retain their conversation', async t => {
  const manager = new AgentOrchestrator(2);
  t.after(() => manager.close());
  const controlled = controlledWorker();
  let created = 0;
  const {id} = manager.spawn(spec, async () => {
    created++;
    return controlled.worker;
  });
  await until(() => controlled.runs.length === 1);
  await manager.send(id, 'Change the approach');
  await manager.send(id, 'Inspect the tests first');
  assert.deepEqual(controlled.steering, [
    'Change the approach',
    'Inspect the tests first',
  ]);
  assert.equal(controlled.runs.length, 1);
  assert.equal(controlled.runs[0].signal.aborted, false);
  controlled.runs[0].finish('steered result');
  await manager.wait([id]);
  await manager.send(id, 'Apply the fix');
  await until(() => controlled.runs.length === 2);
  controlled.runs[1].finish('fixed');
  const [result] = await manager.wait([id]);
  assert.equal(result.output, 'fixed');
  assert.equal(created, 1);
  assert.equal(controlled.disposed, 0);
  assert.deepEqual(
    controlled.runs.map(run => run.message),
    [spec.task, 'Apply the fix'],
  );
});

void test('messages sent before a worker slot opens use native steering without starting a run', async t => {
  const manager = new AgentOrchestrator(2);
  t.after(() => manager.close());
  const busy = controlledWorker();
  const next = controlledWorker();
  manager.spawn(spec, async () => busy.worker);
  const {id} = manager.spawn(spec, async () => next.worker);
  await until(() => busy.runs.length === 1);
  await manager.send(id, 'Use the updated scope');
  assert.equal(manager.get(id).status, 'queued');
  assert.equal(next.runs.length, 0);
  assert.deepEqual(next.steering, ['Use the updated scope']);
  busy.runs[0].finish('done');
  await until(() => next.runs.length === 1);
  next.runs[0].finish('updated work');
  await manager.wait([id]);
});

for (const action of ['cancel', 'timeout'] as const) {
  void test(`${action} discards pending messages and waits for active tools to stop`, async t => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const manager = new AgentOrchestrator(2);
    const first = controlledWorker(false);
    const other = controlledWorker();
    t.after(() => {
      first.runs[0]?.finish('cleanup');
      return manager.close();
    });
    let created = 0;
    const {id} = manager.spawn({...spec, timeoutMs: 100}, async () => {
      created++;
      return first.worker;
    });
    const queued = manager.spawn(spec, async () => other.worker);
    await until(() => first.runs.length === 1);
    t.mock.timers.tick(60);
    await manager.send(id, 'Discard this message');
    if (action === 'cancel') manager.cancel(id);
    else t.mock.timers.tick(40);
    assert.equal(first.runs[0].signal.aborted, true);
    assert.equal(first.disposed, 0);
    assert.equal(other.runs.length, 0);
    first.runs[0].finish('late result');
    await until(() => other.runs.length === 1);
    const result = manager.get(id);
    assert.equal(result.status, action === 'cancel' ? 'cancelled' : 'failed');
    assert.match(
      result.error!,
      action === 'cancel'
        ? /Agent cancelled/
        : /Timed out after 100 milliseconds/,
    );
    assert.equal(result.output, undefined);
    assert.equal(created, 1);
    assert.equal(first.disposed, 0);
    other.runs[0].finish('done');
    await manager.wait([queued.id]);
  });
}

void test('timeouts exclude queue time and reset when completed agents resume', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const manager = new AgentOrchestrator(2);
  const busy = controlledWorker();
  const controlled = controlledWorker();
  const initializing = deferred<AgentWorker>();
  t.after(() => {
    initializing.resolve(controlled.worker);
    return manager.close();
  });
  manager.spawn(spec, async () => busy.worker);
  let created = 0;
  const {id} = manager.spawn({...spec, timeoutMs: 100}, async () => {
    created++;
    return initializing.promise;
  });
  await until(() => busy.runs.length === 1);
  t.mock.timers.tick(1000);
  assert.equal(manager.get(id).status, 'queued');
  busy.runs[0].finish('done');
  await until(() => created === 1);
  t.mock.timers.tick(60);
  initializing.resolve(controlled.worker);
  await until(() => controlled.runs.length === 1);
  t.mock.timers.tick(39);
  assert.equal(controlled.runs[0].signal.aborted, false);
  controlled.runs[0].finish('initial result');
  await manager.wait([id]);
  t.mock.timers.tick(1000);
  await manager.send(id, 'Resume the conversation');
  await until(() => controlled.runs.length === 2);
  t.mock.timers.tick(99);
  assert.equal(controlled.runs[1].signal.aborted, false);
  t.mock.timers.tick(1);
  const [result] = await manager.wait([id]);
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /Timed out after 100 milliseconds/);
  assert.equal(created, 1);
  assert.equal(controlled.disposed, 0);
});

void test('cancellation retains the worker slot until active work has stopped', async t => {
  const manager = new AgentOrchestrator(2);
  const first = controlledWorker(false);
  const second = controlledWorker();
  t.after(() => manager.close());
  const a = manager.spawn(spec, async () => first.worker);
  const b = manager.spawn(spec, async () => second.worker);
  await until(() => first.runs.length === 1);
  await manager.send(a.id, 'Discard this follow-up');
  assert.equal(manager.cancel(a.id).status, 'cancelling');
  assert.equal(first.runs[0].signal.aborted, true);
  await nextTick();
  assert.equal(second.runs.length, 0);
  first.runs[0].finish('late output');
  await until(() => second.runs.length === 1);
  assert.equal(manager.get(a.id).status, 'cancelled');
  assert.equal(manager.get(a.id).output, undefined);
  assert.equal(first.disposed, 0);
  second.runs[0].finish('done');
  await manager.wait([b.id]);
});

void test('startup failures and timeouts release slots and preserve errors', async t => {
  const manager = new AgentOrchestrator(2);
  t.after(() => manager.close());
  const broken = manager.spawn(spec, async () => {
    throw new Error('Missing credentials');
  });
  const slow = controlledWorker();
  const timed = manager.spawn({...spec, timeoutMs: 20}, async () => ({
    ...slow.worker,
    async run(message, signal, onActivity) {
      try {
        return await slow.worker.run(message, signal, onActivity);
      } catch {
        // Providers may return a generic abort error when a deadline expires.
        throw new Error('Request was aborted');
      }
    },
  }));
  const results = await manager.wait([broken.id, timed.id], {timeoutMs: 1000});
  assert.deepEqual(
    results.map(result => result.status),
    ['failed', 'failed'],
  );
  assert.equal(results[0].error, 'Missing credentials');
  assert.deepEqual(
    manager
      .conversation(broken.id)
      .conversation.map(message => [message.role, message.text, message.error]),
    [
      ['user', spec.task, undefined],
      ['assistant', '', 'Missing credentials'],
    ],
  );
  assert.match(results[1].error ?? '', /Timed out after 20 milliseconds/);
  assert.match(results[1].activity, /Timed out after 20 milliseconds/);
  assert.equal(slow.disposed, 0);
  assert.equal(manager.get(timed.id).resumable, true);
  await manager.send(timed.id, 'retry');
  await until(() => slow.runs.length === 2);
  slow.runs[1].finish('Recovered');
  assert.equal((await manager.wait([timed.id]))[0].output, 'Recovered');
});

void test('wait supports any, all, polling, and interruption without cancelling agents', async t => {
  const manager = new AgentOrchestrator(3);
  t.after(() => manager.close());
  const a = controlledWorker();
  const b = controlledWorker();
  const first = manager.spawn(spec, async () => a.worker);
  const second = manager.spawn(spec, async () => b.worker);
  const ids = [first.id, second.id];
  await until(() => b.runs.length === 1);
  assert.equal((await manager.wait(ids, {timeoutMs: 0}))[0].status, 'running');
  assert.equal((await manager.wait(ids, {timeoutMs: 5}))[1].status, 'running');
  const any = manager.wait(ids, {mode: 'any'});
  a.runs[0].finish('A');
  assert.deepEqual(
    (await any).map(record => record.status),
    ['completed', 'running'],
  );
  const controller = new AbortController();
  const interrupted = manager.wait(ids, {signal: controller.signal});
  controller.abort(new Error('Stop waiting'));
  await assert.rejects(interrupted, /Stop waiting/);
  assert.equal(b.runs[0].signal.aborted, false);
  b.runs[0].finish('B');
  assert.deepEqual(
    (await manager.wait(ids)).map(record => record.status),
    ['completed', 'completed'],
  );
  assert.deepEqual(await manager.wait([]), []);
  await assert.rejects(manager.wait(['missing']), /Unknown agent/);
});

void test('closing during worker initialization disposes it and never starts queued agents', async () => {
  const manager = new AgentOrchestrator(2);
  const initializing = deferred<AgentWorker>();
  const cleanup = deferred<void>();
  const controlled = controlledWorker();
  const worker = {
    ...controlled.worker,
    async dispose() {
      await controlled.worker.dispose();
      await cleanup.promise;
      throw new Error('Cleanup failed');
    },
  };
  let created = 0;
  const first = manager.spawn(spec, async () => {
    created++;
    return initializing.promise;
  });
  const second = manager.spawn(spec, async () => {
    created++;
    return controlled.worker;
  });
  await until(() => created === 1);
  const closing = manager.close();
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  initializing.resolve(worker);
  await until(() => controlled.disposed === 1);
  assert.equal(closed, false);
  cleanup.resolve();
  await closing;
  await manager.close();
  assert.equal(controlled.disposed, 1);
  assert.equal(controlled.runs.length, 0);
  assert.equal(created, 1);
  assert.equal(manager.get(first.id).status, 'cancelled');
  assert.equal(manager.get(second.id).status, 'cancelled');
  assert.throws(
    () => manager.spawn(spec, async () => controlled.worker),
    /closed/,
  );
});

void test('records are snapshots and large results link to the full result file', async t => {
  const manager = new AgentOrchestrator();
  const controlled = controlledWorker();
  t.after(() => manager.close());
  const record = manager.spawn(spec, async () => controlled.worker);
  record.name = 'mutated';
  assert.equal(manager.get(record.id).name, spec.name);
  await until(() => controlled.runs.length === 1);
  controlled.runs[0].finish('x'.repeat(20000));
  const [result] = await manager.wait([record.id]);
  assert.ok(result.output!.length < 13000);
  assert.equal(result.outputTruncated, true);
  assert.equal(result.resultFile, '/result.txt');
  await manager.close();
  assert.equal(controlled.disposed, 1);
});

function fakeSession() {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const messages: AgentSession['messages'] = [];
  let disposed = 0;
  let aborts = 0;
  const customEntries: Array<{customType: string; data: unknown}> = [];
  const session = {
    messages,
    extensionRunner: {emit: async () => {}},
    sessionManager: {
      getSessionFile: () => '/saved/session.jsonl',
      appendCustomEntry(customType: string, data: unknown) {
        customEntries.push({customType, data: structuredClone(data)});
      },
    },
    subscribe(listener: (event: AgentSessionEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: (async () => {}) as AgentSession['prompt'],
    abort: async () => {
      aborts++;
    },
    clearQueue() {},
    steer: async () => {},
    abortCompaction() {},
    abortBash() {},
    dispose() {
      disposed++;
    },
  };
  return {
    session,
    emit(event: AgentSessionEvent) {
      for (const listener of listeners) listener(event);
    },
    respond(message: AgentSession['messages'][number]) {
      messages.push(message);
      for (const listener of listeners)
        listener({type: 'message_end', message});
    },
    listeners,
    customEntries,
    get disposed() {
      return disposed;
    },
    get aborts() {
      return aborts;
    },
  };
}

function assistant(text: string, stopReason = 'stop', errorMessage?: string) {
  return {
    role: 'assistant',
    content: [{type: 'text', text}],
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  } as AgentSession['messages'][number];
}

void test('session workers save the final answer, track tools, and detect API failures', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varisdev-agents-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const fake = fakeSession();
  const resultFile = join(directory, 'result.txt');
  const worker = sessionWorker(
    fake.session as unknown as AgentSession,
    resultFile,
  );
  assert.equal(fake.customEntries[0].customType, 'varisdev.agent-profile');
  const defaultProfile = fake.customEntries[0].data as {
    id: string;
    name: string;
    instructions: string;
    permissions: unknown[];
    mode: string;
    model?: string;
    thinkingLevel?: string;
    steps?: number;
  };
  assert.equal(defaultProfile.id, 'default');
  assert.equal(defaultProfile.name, 'Default');
  assert.equal(defaultProfile.instructions, '');
  assert.deepEqual(defaultProfile.permissions, []);
  assert.equal(defaultProfile.mode, 'all');
  assert.equal(defaultProfile.model, undefined);
  assert.equal(defaultProfile.thinkingLevel, undefined);
  assert.equal(defaultProfile.steps, undefined);
  const activities: string[] = [];
  fake.session.prompt = async (message, options) => {
    assert.equal(message, 'Do the work');
    assert.equal(options?.expandPromptTemplates, true);
    assert.equal(typeof options?.preflightResult, 'function');
    fake.emit({
      type: 'tool_execution_start',
      toolName: 'read',
      toolCallId: 'call',
      args: {path: 'file'},
    });
    fake.respond(assistant('intermediate'));
    fake.respond(assistant('complete answer'));
  };
  assert.equal(
    await worker.run('Do the work', new AbortController().signal, activity =>
      activities.push(activity),
    ),
    'complete answer',
  );
  assert.equal(await readFile(resultFile, 'utf8'), 'complete answer');
  assert.deepEqual(activities, ['Using read']);
  // Only the lifetime usage listener remains between runs.
  assert.equal(fake.listeners.size, 1);
  fake.session.prompt = async () => {
    fake.respond(assistant('', 'error', 'Provider failed'));
  };
  await assert.rejects(
    worker.run('retry', new AbortController().signal, () => {}),
    /Provider failed/,
  );
  assert.equal(fake.listeners.size, 1);
  assert.equal(
    worker.conversation?.conversation.at(-1)?.error,
    'Provider failed',
  );
  fake.session.prompt = async () => {
    fake.respond(assistant('Incomplete response', 'length'));
  };
  await assert.rejects(
    worker.run('summarize', new AbortController().signal, () => {}),
    /Agent length/,
  );
  assert.equal(await readFile(resultFile, 'utf8'), 'complete answer');
  assert.equal(fake.listeners.size, 1);
  const cleanup: string[] = [];
  fake.session.abort = async () => {
    cleanup.push('abort');
    throw new Error('SDK abort failed');
  };
  fake.session.extensionRunner.emit = async () => {
    cleanup.push('shutdown');
  };
  const dispose = fake.session.dispose;
  fake.session.dispose = () => {
    cleanup.push('dispose');
    dispose();
  };
  await assert.rejects(async () => worker.dispose(), /SDK abort failed/);
  await assert.rejects(async () => worker.dispose(), /SDK abort failed/);
  assert.deepEqual(cleanup, ['abort', 'shutdown', 'dispose']);
  assert.equal(fake.listeners.size, 0);
  assert.equal(fake.disposed, 1);
});

void test('session workers never reuse an older answer for handled commands or empty turns', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varisdev-agent-command-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const fake = fakeSession();
  const resultFile = join(directory, 'result.txt');
  const worker = sessionWorker(
    fake.session as unknown as AgentSession,
    resultFile,
  );
  t.after(() => worker.dispose());
  fake.session.prompt = async () => {
    fake.respond(assistant('Previous answer'));
  };
  assert.equal(
    await worker.run('Initial task', new AbortController().signal, () => {}),
    'Previous answer',
  );
  fake.session.prompt = async (_message, options) => {
    options?.preflightResult?.('handled');
  };
  assert.equal(
    await worker.run('/agents history', new AbortController().signal, () => {}),
    '',
  );
  assert.equal(await readFile(resultFile, 'utf8'), '');
  fake.session.prompt = async () => {};
  await assert.rejects(
    worker.run('Missing response', new AbortController().signal, () => {}),
    /without an assistant response/,
  );
  fake.session.prompt = async (_message, options) => {
    fake.respond(assistant('Current command answer'));
    options?.preflightResult?.('handled');
  };
  assert.equal(
    await worker.run(
      '/fixture-command',
      new AbortController().signal,
      () => {},
    ),
    'Current command answer',
  );
});

void test('session workers cancel manual compaction during SDK preflight and await its settlement', async t => {
  const fake = fakeSession();
  const preflight = deferred<void>();
  const settling = deferred<void>();
  const cancelled = deferred<void>();
  let compactAborted = false;
  const session = {
    ...fake.session,
    async compact() {
      await preflight.promise;
      fake.emit({type: 'compaction_start', reason: 'manual'});
      await cancelled.promise;
      await settling.promise;
      throw new Error('Compaction cancelled');
    },
    abortCompaction() {
      // Match SDK preflight: there is no compaction controller until the start event.
      if (!started) return;
      compactAborted = true;
      cancelled.resolve();
    },
  };
  let started = false;
  fake.session.subscribe(event => {
    if (event.type === 'compaction_start') started = true;
  });
  const worker = sessionWorker(
    session as unknown as AgentSession,
    '/unused-result.txt',
  );
  t.after(() => worker.dispose());
  const compacting = assert.rejects(worker.compact!(), /Compaction cancelled/);
  let stopped = false;
  const stopping = worker.abort!().then(() => {
    stopped = true;
  });
  assert.equal(started, false);
  preflight.resolve();
  await until(() => compactAborted);
  assert.equal(stopped, false);
  settling.resolve();
  await Promise.all([compacting, stopping]);
  assert.equal(stopped, true);
});

void test('session workers cancel again if a prompt starts after cancellation during preflight', async () => {
  const fake = fakeSession();
  const preflight = deferred<void>();
  const worker = sessionWorker(
    fake.session as unknown as AgentSession,
    '/unused-result.txt',
  );
  const controller = new AbortController();
  fake.session.prompt = async () => {
    await preflight.promise;
    fake.emit({type: 'agent_start'});
    fake.respond(assistant('', 'aborted'));
  };
  const running = worker.run('task', controller.signal, () => {});
  controller.abort(new Error('Cancelled during setup'));
  assert.equal(fake.aborts, 1);
  preflight.resolve();
  await assert.rejects(running, /Cancelled during setup/);
  assert.equal(fake.aborts, 2);
  assert.equal(fake.listeners.size, 1);
  await worker.dispose();
  assert.equal(fake.listeners.size, 0);
});

void test('agent tools select registered models and effort without adding parent prompts', async t => {
  await isolateToolSettings(t, null);
  t.mock.timers.enable({apis: ['setTimeout']});
  const tools = new Map<string, ToolDefinition>();
  const events = new Map<string, AgentEventHandler>();
  const notifications: unknown[] = [];
  const commands = new Map<
    string,
    Parameters<ExtensionAPI['registerCommand']>[1]
  >();
  const notices: string[] = [];
  const controlled = controlledWorker();
  const optionsSeen: Array<Parameters<typeof createSessionWorker>[0]> = [];
  let inheritedEffort = 'high';
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: AgentEventHandler) {
      events.set(event, handler);
    },
    registerCommand(
      name: string,
      command: Parameters<ExtensionAPI['registerCommand']>[1],
    ) {
      commands.set(name, command);
    },
    getThinkingLevel: () => inheritedEffort,
    sendMessage(message: unknown) {
      notifications.push(message);
    },
  } as unknown as ExtensionAPI;
  registerAgentTools(pi, async options => {
    if (options.name === 'Broken') throw new Error('Missing credentials');
    optionsSeen.push(options);
    return controlled.worker;
  });
  const registeredModels = [
    ...['gpt-5.5', 'gpt-5.6-sol', 'gpt-6.1-sol', 'gpt-6-astra'].map(id => ({
      provider: 'openai-codex',
      id,
    })),
    {provider: 'anthropic', id: 'claude-sonnet-4-5'},
    {provider: 'custom', id: 'organization/model'},
  ];
  const selectedModel = registeredModels[1];
  let parentModel: (typeof registeredModels)[number] | undefined =
    selectedModel;
  let modelsAvailable = true;
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    ui: {notify: (message: string) => notices.push(message)},
    isIdle: () => true,
    isProjectTrusted: () => false,
    get model() {
      return parentModel;
    },
    modelRegistry: {
      find: (provider: string, id: string) =>
        modelsAvailable
          ? registeredModels.find(
              model => model.provider === provider && model.id === id,
            )
          : undefined,
    },
    sessionManager: {getSessionId: () => 'parent-session'},
  } as unknown as ExtensionContext;
  const executeCtx = toolContext(ctx);
  const execute = (name: string, params: Record<string, unknown>) =>
    tools.get(name)!.execute('call', params, undefined, undefined, executeCtx);
  const list = async (view?: string) => {
    const result = await execute('agent_list', view ? {view} : {});
    const content = result.content[0];
    assert.ok(content.type === 'text');
    return JSON.parse(content.text) as {
      agents: Array<{id: string; activity: string}>;
      summary: Record<string, number>;
    };
  };
  const command = (args: string) =>
    commands.get('agents')!.handler(args, ctx as ExtensionCommandContext);
  await events.get('before_agent_start')!({}, ctx);
  try {
    const spawned = await execute('agent_spawn', {
      name: 'Review',
      task: 'Review code',
    });
    const spawnedRecord = (spawned.details as {agents: AgentRecord[]})
      .agents[0];
    const id = spawnedRecord.id;
    assert.equal(spawnedRecord.agentMode, 'all');
    await until(() => controlled.runs.length === 1);
    t.mock.timers.tick(3600001);
    await nextTick();
    assert.equal(controlled.runs[0].signal.aborted, false);
    const {agentToolsExtension, agentProfile, ...workerOptions} =
      optionsSeen[0];
    assert.equal(typeof agentToolsExtension, 'function');
    assert.equal(agentProfile?.id, 'default');
    assert.equal(agentProfile?.model, undefined);
    assert.deepEqual(workerOptions, {
      cwd: ctx.cwd,
      projectTrustOverride: false,
      name: 'Review',
      instructions: undefined,
      approval: undefined,
      approvalUI: undefined,
      ui: undefined,
      context: 'workspace',
      model: selectedModel,
      modelRegistry: ctx.modelRegistry,
      thinkingLevel: 'high',
      parentSessionId: 'parent-session',
      id,
    });
    controlled.runs[0].finish('review result');
    const waited = await execute('agent_wait', {ids: [id]});
    assert.match(JSON.stringify(waited.content), /review result/);
    assert.equal(notifications.length, 0);
    const active = await list();
    assert.deepEqual(active.agents, []);
    assert.equal(active.summary.completed, 1);
    assert.deepEqual(
      (await list('history')).agents.map(agent => agent.id),
      [id],
    );
    const status = await execute('agent_status', {id});
    assert.match(JSON.stringify(status.content), /review result/);
    await events.get('agent_start')?.({}, ctx);
    await events.get('agent_settled')?.({}, ctx);
    assert.equal(notifications.length, 0);

    const broken = await execute('agent_spawn', {
      name: 'Broken',
      task: 'Cannot start',
    });
    const brokenId = (broken.details as {agents: AgentRecord[]}).agents[0].id;
    const failed = await execute('agent_wait', {ids: [brokenId]});
    assert.match(JSON.stringify(failed.content), /Missing credentials/);
    await events.get('agent_start')?.({}, ctx);
    await events.get('agent_settled')?.({}, ctx);
    assert.equal(notifications.length, 0);
    assert.equal((await list()).summary.failed, 1);
    assert.equal(
      (await list('history')).agents.find(agent => agent.id === brokenId)
        ?.activity,
      'Missing credentials',
    );
    await command('');
    assert.match(notices.at(-1)!, /No active agents/);
    assert.match(notices.at(-1)!, /2 finished agents.*\/agents history/);
    assert.doesNotMatch(notices.at(-1)!, /Broken|Review/);
    await command('history');
    assert.match(notices.at(-1)!, /Broken: failed — Missing credentials/);
    assert.match(notices.at(-1)!, /Review: completed/);

    await execute('agent_send', {id, message: 'Review the fix'});
    await until(() => controlled.runs.length === 2);
    t.mock.timers.tick(3600001);
    await nextTick();
    assert.equal(controlled.runs[1].signal.aborted, false);
    assert.deepEqual(
      (await list()).agents.map(agent => agent.id),
      [id],
    );
    assert.deepEqual(
      (await list('history')).agents.map(agent => agent.id),
      [brokenId],
    );
    assert.deepEqual(
      (await list('all')).agents.map(agent => agent.id),
      [id, brokenId],
    );
    await events.get('session_shutdown')!({reason: 'new'}, ctx);
    assert.equal(controlled.runs[1].signal.aborted, true);
    assert.equal(controlled.disposed, 1);
    assert.equal(notifications.length, 0);
    await events.get('session_start')!({reason: 'new'}, ctx);
    await assert.rejects(execute('agent_status', {id}), /Unknown agent/);
    const listed = await list('all');
    assert.deepEqual(listed.agents, []);
    assert.ok(Object.values(listed.summary).every(count => count === 0));
    const spawnDescription = tools.get('agent_spawn')!.description;
    assert.match(spawnDescription, /any model from the current model registry/);
    for (const model of ['', 'gpt-5.6-sol', '/model', 'provider/']) {
      await assert.rejects(
        execute('agent_spawn', {name: 'bad model', task: 'test', model}),
        /model must use provider\/model format/i,
      );
    }
    for (const model of [
      'openai-codex/missing-model',
      'unknown-provider/gpt-5.6-sol',
    ]) {
      await assert.rejects(
        execute('agent_spawn', {name: 'missing model', task: 'test', model}),
        /model is unavailable/i,
      );
    }
    await assert.rejects(
      execute('agent_spawn', {
        name: 'bad effort',
        task: 'test',
        model: 'openai-codex/gpt-5.6-sol',
        thinkingLevel: 'invalid',
      }),
      /thinkingLevel must be off, minimal, low, medium, high, xhigh, or max/,
    );
    inheritedEffort = 'invalid';
    await assert.rejects(
      execute('agent_spawn', {name: 'bad inherited effort', task: 'test'}),
      /thinkingLevel must be off, minimal, low, medium, high, xhigh, or max/,
    );
    inheritedEffort = 'high';
    const beforeMissingModel = optionsSeen.length;
    parentModel = undefined;
    await assert.rejects(
      execute('agent_spawn', {name: 'no selection', task: 'test'}),
      /Choose a model or specify the agent model/,
    );
    assert.equal(optionsSeen.length, beforeMissingModel);
    parentModel = selectedModel;

    const routine = await execute('agent_spawn', {
      name: 'Routine checks',
      task: 'Run the required checks and report results.',
      model: 'openai-codex/gpt-5.6-sol',
      thinkingLevel: 'xhigh',
      autoCleanup: true,
    });
    const routineId = (routine.details as {agents: AgentRecord[]}).agents[0].id;
    await until(() => controlled.runs.length === 3);
    assert.equal(optionsSeen.at(-1)!.model, selectedModel);
    assert.equal(optionsSeen.at(-1)!.thinkingLevel, 'xhigh');
    controlled.runs[2].finish('Checks passed');
    const cleaned = await execute('agent_wait', {ids: [routineId]});
    assert.match(JSON.stringify(cleaned.content), /Checks passed/);
    assert.equal(visibleAgentResult(cleaned).agents[0].resumable, false);
    assert.equal(controlled.disposed, 2);
    assert.equal(notifications.length, 0);

    for (const inherit of [false, true]) {
      inheritedEffort = inherit ? 'max' : 'high';
      const params = {
        name: 'Max reasoning',
        task: 'Verify max reasoning delegation.',
        ...(inherit ? {} : {thinkingLevel: 'max'}),
        autoCleanup: true,
      };
      assert.ok(Check(tools.get('agent_spawn')!.parameters, params));
      const beforeRuns = controlled.runs.length;
      const spawned = await execute('agent_spawn', params);
      const record = (spawned.details as {agents: AgentRecord[]}).agents[0];
      await until(() => controlled.runs.length === beforeRuns + 1);
      assert.equal(optionsSeen.at(-1)!.thinkingLevel, 'max');
      controlled.runs.at(-1)!.finish('Max reasoning completed');
      await execute('agent_wait', {ids: [record.id]});
    }
    inheritedEffort = 'high';

    for (const model of registeredModels) {
      const fullName = `${model.provider}/${model.id}`;
      for (const inherit of [false, true]) {
        parentModel = inherit ? model : selectedModel;
        // Inherited models are already resolved by the parent session.
        modelsAvailable = !inherit;
        const beforeRuns = controlled.runs.length;
        const params = {
          name: model.id,
          task: 'Verify model selection and inheritance.',
          ...(inherit ? {} : {model: fullName}),
          autoCleanup: true,
        };
        assert.ok(Check(tools.get('agent_spawn')!.parameters, params));
        const spawned = await execute('agent_spawn', params);
        const record = (spawned.details as {agents: AgentRecord[]}).agents[0];
        assert.equal(record.model, fullName);
        await until(() => controlled.runs.length === beforeRuns + 1);
        assert.equal(optionsSeen.at(-1)!.model, model);
        controlled.runs.at(-1)!.finish(fullName);
        const result = await execute('agent_wait', {ids: [record.id]});
        assert.match(JSON.stringify(result.content), new RegExp(model.id));
      }
    }
    assert.equal(notifications.length, 0);
  } finally {
    await events.get('session_shutdown')!({reason: 'new'}, ctx);
  }
});

void test('worker messaging identifies senders, validates recipients, and stays in its parent session', async t => {
  await isolateToolSettings(t, ['openai-codex/gpt-5.5']);
  const tools = new Map<string, ToolDefinition>();
  const events = new Map<string, AgentEventHandler>();
  const notifications: Array<{
    message: unknown;
    options: unknown;
  }> = [];
  const workers = new Map<
    string,
    {
      tools: Map<string, ToolDefinition>;
      controlled: ReturnType<typeof controlledWorker>;
    }
  >();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: AgentEventHandler) {
      events.set(event, handler);
    },
    registerCommand() {},
    getThinkingLevel: () => 'off',
    sendMessage(message: unknown, options: unknown) {
      notifications.push({message, options});
    },
  } as unknown as ExtensionAPI;
  registerAgentTools(pi, async options => {
    const workerTools = new Map<string, ToolDefinition>();
    await options.agentToolsExtension({
      on() {},
      registerCommand() {},
      registerTool(tool: ToolDefinition) {
        workerTools.set(tool.name, tool);
      },
    } as unknown as ExtensionAPI);
    const controlled = controlledWorker();
    workers.set(options.id, {tools: workerTools, controlled});
    return controlled.worker;
  });
  const model = {provider: 'openai-codex', id: 'gpt-5.5'};
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    isIdle: () => true,
    isProjectTrusted: () => false,
    model,
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === model.provider && id === model.id ? model : undefined,
    },
    sessionManager: {getSessionId: () => 'parent-session'},
  } as unknown as ExtensionContext;
  const executeCtx = toolContext(ctx);
  const execute = (
    source: Map<string, ToolDefinition>,
    name: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => source.get(name)!.execute('call', params, signal, undefined, executeCtx);
  const spawn = async (name: string) => {
    const result = await execute(tools, 'agent_spawn', {
      name,
      task: `Work for ${name}`,
    });
    const id = (result.details as {agents: AgentRecord[]}).agents[0].id;
    await until(() => workers.get(id)?.controlled.runs.length === 1);
    return {id, ...workers.get(id)!};
  };
  t.after(() => events.get('session_shutdown')!({reason: 'new'}, ctx));
  const sender = await spawn('Designer');
  const receiver = await spawn('Builder');
  assert.deepEqual([...sender.tools.keys()].sort(), [
    'agent_cancel',
    'agent_inbox',
    'agent_list',
    'agent_send',
    'agent_spawn',
    'agent_status',
    'agent_templates',
    'agent_wait',
  ]);
  const listed = await execute(sender.tools, 'agent_list', {});
  const listing = listed.details as {selfId: string; agents: AgentRecord[]};
  assert.equal(listing.selfId, sender.id);
  assert.deepEqual(
    listing.agents.map(agent => agent.id),
    [sender.id, receiver.id],
  );

  const send = (id: string, message: string, signal?: AbortSignal) =>
    execute(sender.tools, 'agent_send', {id, message}, signal);
  await send(receiver.id, 'Use a 32-pixel grid.');
  assert.equal(receiver.controlled.runs.length, 1);
  assert.deepEqual(receiver.controlled.steering, [
    'Message from agent "Designer" (' + sender.id + '):\nUse a 32-pixel grid.',
  ]);
  const parentSend = await send('parent', 'The grid is ready.');
  const firstParentMessageId = (
    parentSend.details as {
      messageId: string;
      recipient: string;
      stored: boolean;
    }
  ).messageId;
  assert.deepEqual(parentSend.details, {
    recipient: 'parent',
    stored: true,
    messageId: firstParentMessageId,
  });
  assert.deepEqual(notifications, []);
  const firstInbox = await execute(tools, 'agent_inbox', {});
  assert.deepEqual(
    (
      firstInbox.details as {
        messages: Array<{id: string; from: unknown; preview: string}>;
      }
    ).messages,
    [
      {
        id: firstParentMessageId,
        createdAt: (
          firstInbox.details as {messages: Array<{createdAt: string}>}
        ).messages[0].createdAt,
        from: {id: sender.id, name: 'Designer'},
        length: 18,
        preview: 'The grid is ready.',
      },
    ],
  );
  await assert.rejects(send(sender.id, 'Loop'), /itself/);
  await assert.rejects(send('missing', 'Unknown'), /Unknown agent/);
  await assert.rejects(send(receiver.id, '   '), /cannot be empty/);
  await assert.rejects(send('parent', '   '), /cannot be empty/);
  await assert.rejects(
    send('parent', 'Aborted', AbortSignal.abort(new Error('Stop sending'))),
    /Stop sending/,
  );
  assert.equal(notifications.length, 0);
  await execute(tools, 'agent_cancel', {id: receiver.id});
  await send(receiver.id, 'Resume after cancellation');
  await until(() => receiver.controlled.runs.length === 2);
  assert.equal(
    receiver.controlled.runs[1].message.includes('Resume after cancellation'),
    true,
  );
  receiver.controlled.runs[1].finish('Resumed');
  await execute(tools, 'agent_wait', {ids: [receiver.id]});
  const parentMessageIds: string[] = [];
  for (let i = 0; i < 105; i++) {
    const message = i === 104 ? 'z'.repeat(700) : `Parent update ${i}`;
    const result = await send('parent', message);
    parentMessageIds.push((result.details as {messageId: string}).messageId);
  }
  const newest = await execute(tools, 'agent_inbox', {limit: 2});
  const newestDetails = newest.details as {
    total: number;
    nextOffset: number;
    messages: Array<{
      id: string;
      from: {id: string; name: string};
      preview: string;
      length: number;
    }>;
  };
  assert.equal(newestDetails.total, 100);
  assert.equal(newestDetails.nextOffset, 2);
  assert.deepEqual(
    newestDetails.messages.map(message => message.id),
    [parentMessageIds[104], parentMessageIds[103]],
  );
  assert.equal(newestDetails.messages[0].preview.length, 500);
  assert.equal(newestDetails.messages[0].length, 700);
  newestDetails.messages[0].from.name = 'Mutated result';
  const fullParentMessage = await execute(tools, 'agent_inbox', {
    messageId: parentMessageIds[104],
  });
  assert.deepEqual(
    (fullParentMessage.details as {message: {from: unknown}}).message.from,
    {id: sender.id, name: 'Designer'},
  );
  assert.equal(
    (fullParentMessage.details as {message: {message: string}}).message.message,
    'z'.repeat(700),
  );
  const oldestRetained = await execute(tools, 'agent_inbox', {
    offset: 99,
    limit: 1,
  });
  assert.deepEqual(
    (oldestRetained.details as {messages: Array<{id: string}>}).messages.map(
      message => message.id,
    ),
    [parentMessageIds[5]],
  );
  await assert.rejects(
    execute(tools, 'agent_inbox', {messageId: firstParentMessageId}),
    /Unknown main agent inbox message/,
  );
  assert.equal(notifications.length, 0);

  await execute(tools, 'agent_cancel', {id: sender.id});
  await assert.rejects(
    send('parent', 'After cancellation'),
    /Only running agents/,
  );
  await events.get('session_shutdown')!({reason: 'new'}, ctx);
  await events.get('session_start')!({reason: 'new'}, ctx);
  await spawn('New session worker');
  const freshInbox = await execute(tools, 'agent_inbox', {});
  assert.deepEqual(freshInbox.details, {
    total: 0,
    offset: 0,
    nextOffset: undefined,
    messages: [],
  });
  await assert.rejects(send('parent', 'Stale sender'), /session has closed/);
  await assert.rejects(
    execute(sender.tools, 'agent_list', {}),
    /session has closed/,
  );
  assert.equal(notifications.length, 0);
});

function agentParent(
  sessionId: string,
  createWorker: typeof createSessionWorker,
  cwd = process.cwd(),
) {
  const tools = new Map<string, ToolDefinition>();
  const events = new Map<string, AgentEventHandler>();
  const notifications: Array<{
    message: {customType: string; content: string; details: unknown};
    options: unknown;
  }> = [];
  const statuses: Array<string | undefined> = [];
  let idle = true;
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: AgentEventHandler) {
      events.set(event, handler);
    },
    registerCommand() {},
    getThinkingLevel: () => 'off',
    sendMessage(
      message: (typeof notifications)[number]['message'],
      options: unknown,
    ) {
      notifications.push({message, options});
    },
  } as unknown as ExtensionAPI;
  const model = {provider: 'openai-codex', id: 'gpt-5.6-sol'};
  const ctx = {
    cwd,
    hasUI: true,
    ui: {setStatus: (_key: string, status?: string) => statuses.push(status)},
    isIdle: () => idle,
    isProjectTrusted: () => false,
    model,
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === model.provider && id === model.id ? model : undefined,
    },
    sessionManager: {getSessionId: () => sessionId},
  } as unknown as ExtensionContext;
  const executeCtx = toolContext(ctx);
  const control = registerAgentTools(pi, createWorker);
  async function emit(event: string, reason?: string) {
    if (event === 'agent_start') idle = false;
    if (event === 'agent_settled') idle = true;
    await events.get(event)?.({reason}, ctx);
  }
  const execute = async (
    name: string,
    params: Record<string, unknown> = {},
  ) => {
    const result = await tools
      .get(name)!
      .execute('call', params, undefined, undefined, executeCtx);
    return {...result, details: result.details as {agents: AgentRecord[]}};
  };
  return {
    pi,
    ctx,
    tools,
    control,
    execute,
    notifications,
    statuses,
    emit,
    shutdown: (reason = 'quit') =>
      events.get('session_shutdown')!({reason}, ctx),
    async spawn(name: string) {
      const result = await execute('agent_spawn', {name, task: name});
      return (result.details as {agents: AgentRecord[]}).agents[0].id;
    },
  };
}

function teamWorkers() {
  const created: Array<{
    options: Parameters<typeof createSessionWorker>[0];
    controlled: ReturnType<typeof controlledWorker>;
    execute: (
      name: string,
      params?: Record<string, unknown>,
    ) => ReturnType<ToolDefinition['execute']>;
  }> = [];
  const byId = new Map<string, (typeof created)[number]>();
  const create: typeof createSessionWorker = async options => {
    const tools = new Map<string, ToolDefinition>();
    await options.agentToolsExtension({
      on() {},
      registerCommand() {},
      registerTool(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
      getThinkingLevel: () => options.thinkingLevel,
    } as unknown as ExtensionAPI);
    const worker = {
      options,
      controlled: controlledWorker(true, `/worker/${created.length}`),
      execute: (name: string, params: Record<string, unknown> = {}) =>
        tools.get(name)!.execute(
          'call',
          params,
          undefined,
          undefined,
          toolContext({
            cwd: options.cwd,
            hasUI: false,
            model: options.model,
            modelRegistry: options.modelRegistry,
            isProjectTrusted: () => false,
            sessionManager: {getSessionId: () => options.id},
          } as unknown as ExtensionContext),
        ),
    };
    created.push(worker);
    byId.set(options.id, worker);
    return worker.controlled.worker;
  };
  return {created, byId, create};
}

void test('parent activity and interruption never turn inbox messages into prompts', async t => {
  await isolateToolSettings(t, ['openai-codex/gpt-5.6-sol']);
  const workers = teamWorkers();
  const parent = agentParent('interrupted-parent', workers.create);
  t.after(() => parent.shutdown());
  const id = await parent.spawn('Reporter');
  await until(() => workers.byId.get(id)?.controlled.runs.length === 1);
  const reporter = workers.byId.get(id)!;
  const abort = new AbortController();
  parent.ctx.signal = abort.signal;
  await parent.emit('agent_start');
  await reporter.execute('agent_send', {
    id: 'parent',
    message: 'During work',
  });
  abort.abort();
  parent.ctx.signal = undefined;
  await parent.emit('agent_settled');
  await reporter.execute('agent_send', {
    id: 'parent',
    message: 'After interruption',
  });
  await parent.emit('agent_start');
  await parent.emit('agent_settled');
  assert.equal(parent.notifications.length, 0);
  const inbox = await parent.execute('agent_inbox');
  assert.deepEqual(
    (
      inbox.details as unknown as {messages: Array<{preview: string}>}
    ).messages.map(message => message.preview),
    ['After interruption', 'During work'],
  );
  reporter.controlled.runs[0].finish('Completed without a parent prompt');
  const result = await parent.execute('agent_wait', {ids: [id]});
  assert.equal(
    result.details.agents[0].output,
    'Completed without a parent prompt',
  );
  await parent.emit('agent_start');
  await parent.emit('agent_settled');
  assert.equal(parent.notifications.length, 0);
});

void test('every session shutdown closes running and queued workers', async t => {
  await isolateToolSettings(t, ['openai-codex/gpt-5.6-sol']);
  for (const reason of ['quit', 'reload', 'new', 'resume', 'fork']) {
    const workers = teamWorkers();
    const parent = agentParent(`ordinary-${reason}`, workers.create);
    t.after(() => parent.shutdown());
    for (let i = 0; i < 7; i++) await parent.spawn(`Worker ${i}`);
    await until(
      () =>
        workers.created.length === 5 &&
        workers.created.every(w => w.controlled.runs.length === 1),
    );
    await parent.shutdown(reason);
    assert.equal(workers.created.length, 5);
    assert.ok(
      workers.created.every(
        w => w.controlled.disposed === 1 && w.controlled.runs[0].signal.aborted,
      ),
    );
    assert.equal(parent.statuses.at(-1), undefined);
    assert.equal(parent.notifications.length, 0);
    await assert.rejects(parent.execute('agent_list'), /shutting down/);
    await assert.rejects(
      workers.created[0].execute('agent_list'),
      /session has closed/,
    );
    const destination = agentParent(
      `ordinary-destination-${reason}`,
      workers.create,
    );
    t.after(() => destination.shutdown());
    assert.deepEqual(
      (await destination.execute('agent_list')).details.agents,
      [],
    );
  }
});

void test('automatic cleanup retains steering through the active run and disposes once', async t => {
  const manager = new AgentOrchestrator(2);
  t.after(() => manager.close());
  const controlled = controlledWorker();
  const {id} = manager.spawn(
    {...spec, autoCleanup: true},
    async () => controlled.worker,
  );
  await until(() => controlled.runs.length === 1);
  await manager.send(id, 'Include the final push result');
  assert.deepEqual(controlled.steering, ['Include the final push result']);
  assert.equal(controlled.disposed, 0);
  controlled.runs[0].finish('Committed and pushed');
  const [result] = await manager.wait([id]);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'Committed and pushed');
  assert.equal(result.sessionFile, controlled.worker.sessionFile);
  assert.equal(result.resultFile, controlled.worker.resultFile);
  assert.equal(controlled.disposed, 1);
  await assert.rejects(manager.send(id, 'More work'), /cleaned up/);
  await manager.close();
  assert.equal(controlled.disposed, 1);
});

void test('automatic cleanup waits for cancellation to settle and handles failures', async t => {
  for (const outcome of ['cancelled', 'failed'] as const) {
    await t.test(outcome, async t => {
      const manager = new AgentOrchestrator(2);
      t.after(() => manager.close());
      const controlled = controlledWorker(false);
      const {id} = manager.spawn({...spec, autoCleanup: true}, async () => ({
        ...controlled.worker,
        async run(...args) {
          await controlled.worker.run(...args);
          throw new Error('Push failed');
        },
      }));
      await until(() => controlled.runs.length === 1);
      if (outcome === 'cancelled') manager.cancel(id);
      assert.equal(controlled.disposed, 0);
      controlled.runs[0].finish('Tools stopped');
      const [result] = await manager.wait([id]);
      assert.equal(result.status, outcome);
      assert.match(
        result.error!,
        outcome === 'failed' ? /Push failed/ : /cancelled/,
      );
      assert.equal(controlled.disposed, 1);
      await manager.close();
      assert.equal(controlled.disposed, 1);
    });
  }
});

void test('cleaned agents release the session capacity for later commands', async t => {
  const manager = new AgentOrchestrator(2);
  t.after(() => manager.close());
  let disposed = 0;
  for (let index = 0; index < 65; index++) {
    const {id} = manager.spawn({...spec, autoCleanup: true}, async () => ({
      async steer() {
        return true;
      },
      async run() {
        return `Result ${index}`;
      },
      dispose() {
        disposed++;
      },
    }));
    const [result] = await manager.wait([id]);
    assert.equal(result.output, `Result ${index}`);
  }
  assert.equal(disposed, 65);
  assert.equal(manager.list().length, 65);
});

void test('64 closed default agents release capacity while retained conversations consume it', async t => {
  const manager = new AgentOrchestrator();
  t.after(() => manager.close());
  let disposed = 0;
  const createWorker = async (): Promise<AgentWorker> => ({
    async steer() {
      return true;
    },
    async run() {
      return 'Retained result';
    },
    dispose() {
      disposed++;
    },
  });
  for (let index = 0; index < 64; index++) {
    const {id} = manager.spawn(spec, createWorker);
    await manager.wait([id]);
  }
  assert.throws(() => manager.spawn(spec, createWorker), /limit of 64/);
  await Promise.all(
    manager.list().map(record => manager.closeAgent(record.id)),
  );
  assert.equal(disposed, 64);
  const {id} = manager.spawn(spec, createWorker);
  assert.equal((await manager.wait([id]))[0].output, 'Retained result');
  assert.equal(manager.list().length, 65);
  assert.equal(manager.list().filter(record => record.resumable).length, 1);
});

void test('controller observes activity and inbox with copied state and resets without stale workers', async t => {
  await isolateToolSettings(t, ['openai-codex/gpt-5.6-sol']);
  const workers = teamWorkers();
  const parent = agentParent('observed-parent', workers.create);
  t.after(() => parent.shutdown());
  const observed: ReturnType<typeof parent.control.snapshot>[] = [];
  const unsubscribe = parent.control.subscribe(() => {
    observed.push(parent.control.snapshot());
  });
  assert.equal(parent.control.snapshot(), undefined);
  assert.equal(observed.length, 0);

  const id = await parent.spawn('Reporter');
  await until(() => workers.byId.get(id)?.controlled.runs.length === 1);
  const reporter = workers.byId.get(id)!;
  assert.ok(observed.some(state => state?.agents[0]?.id === id));
  assert.ok(
    observed.some(state => state?.agents[0]?.activity === 'Using read'),
  );
  const firstDelivery = parent.control.deliverySnapshot()!;
  assert.equal(parent.control.deliverySnapshot(), firstDelivery);
  await reporter.execute('agent_send', {id: 'parent', message: 'Findings'});
  assert.notEqual(parent.control.deliverySnapshot(), firstDelivery);
  const state = observed.at(-1)!;
  assert.equal(state.sessionId, 'observed-parent');
  assert.equal(state.messages[0].message, 'Findings');
  state.agents[0].name = 'Changed';
  state.messages[0].from.name = 'Changed';
  state.messages[0].message = 'Changed';
  state.agents.length = 0;
  state.messages.push({...state.messages[0]});
  const fresh = parent.control.snapshot()!;
  assert.equal(fresh.agents[0].name, 'Reporter');
  assert.equal(fresh.messages[0].from.name, 'Reporter');
  assert.equal(fresh.messages[0].message, 'Findings');
  assert.equal(fresh.messages.length, 1);

  reporter.controlled.runs[0].finish('Done');
  await until(
    () => parent.control.snapshot()?.agents[0].status === 'completed',
  );
  await parent.shutdown('new');
  assert.equal(observed.at(-1), undefined);
  assert.equal(parent.control.snapshot(), undefined);
  assert.equal(parent.control.deliverySnapshot()?.sessionId, 'observed-parent');
  assert.equal(reporter.controlled.disposed, 1);
  await assert.rejects(parent.spawn('During shutdown'), /shutting down/);
  await parent.emit('session_start');
  assert.equal(parent.control.snapshot(), undefined);
  assert.equal(parent.control.deliverySnapshot(), undefined);
  const nextId = await parent.spawn('Next');
  await until(() => workers.byId.get(nextId)?.controlled.runs.length === 1);
  assert.deepEqual(
    parent.control.snapshot()!.agents.map(agent => agent.id),
    [nextId],
  );
  assert.deepEqual(parent.control.snapshot()!.messages, []);
  const count = observed.length;
  await assert.rejects(
    reporter.execute('agent_send', {id: 'parent', message: 'Stale'}),
    /closed/,
  );
  assert.equal(observed.length, count);
  unsubscribe();
  await workers.byId
    .get(nextId)!
    .execute('agent_send', {id: 'parent', message: 'Fresh'});
  assert.equal(observed.length, count);
  assert.equal(parent.control.snapshot()!.messages[0].message, 'Fresh');
});

void test('session callbacks publish pending tool output and settle cancellation and prompt failures before rejecting', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varisdev-agent-live-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  for (const outcome of ['cancelled', 'failed'] as const) {
    await t.test(outcome, async () => {
      const fake = fakeSession();
      const gate = deferred<void>();
      const worker = sessionWorker(
        fake.session as unknown as AgentSession,
        join(directory, 'result.txt'),
      );
      const updates: Array<NonNullable<AgentWorker['conversation']>> = [];
      fake.session.prompt = async () => {
        fake.emit({
          type: 'tool_execution_start',
          toolCallId: 'pending',
          toolName: 'bash',
          args: {command: 'sleep 60'},
        });
        fake.emit({
          type: 'tool_execution_update',
          toolCallId: 'pending',
          toolName: 'bash',
          args: {},
          partialResult: {
            content: [{type: 'text', text: 'Working output'}],
            details: {},
          },
        });
        await gate.promise;
        throw new Error('Prompt execution failed');
      };
      const controller = new AbortController();
      const running = worker.run(
        'Run the task',
        controller.signal,
        () => {},
        undefined,
        snapshot => updates.push(snapshot),
      );
      assert.equal(updates.at(-1)?.conversation[0].text, 'Working output');
      assert.equal(updates.at(-1)?.conversation[0].status, 'running');
      updates.at(-1)!.conversation[0].text = 'Mutated callback';
      assert.equal(worker.conversation?.conversation[0].text, 'Working output');
      if (outcome === 'cancelled')
        controller.abort(new Error('Cancel pending work'));
      gate.resolve();
      await assert.rejects(running, /Prompt execution failed/);
      const last = updates.at(-1)!;
      assert.equal(last.conversation[0].status, outcome);
      assert.equal(last.conversation[0].streaming, false);
      assert.ok(last.conversation[0].finishedAt);
      assert.ok(last.conversation.every(message => !message.streaming));
      if (outcome === 'failed')
        assert.equal(
          last.conversation.at(-1)?.error,
          'Prompt execution failed',
        );
      assert.equal(fake.listeners.size, 1);
      await worker.dispose();
      assert.equal(fake.listeners.size, 0);
      assert.deepEqual(worker.conversation, last);
    });
  }
});

void test('simultaneous worker callbacks keep separate histories after cleanup and ignore caller mutations', async t => {
  const manager = new AgentOrchestrator(3);
  t.after(() => manager.close());
  const callbacks: Array<
    (snapshot: NonNullable<AgentWorker['conversation']>) => void
  > = [];
  const finishes = [deferred<string>(), deferred<string>()];
  const records = finishes.map((finish, index) =>
    manager.spawn(
      {
        ...spec,
        name: `Worker ${index}`,
        task: `Task ${index}`,
        autoCleanup: true,
      },
      async () => ({
        async steer() {
          return true;
        },
        async run(_message, _signal, onActivity, _usage, onConversation) {
          callbacks[index] = onConversation!;
          onActivity('Responding');
          return finish.promise;
        },
        dispose() {},
      }),
    ),
  );
  await until(() => callbacks.filter(Boolean).length === 2);
  let notifications = 0;
  manager.subscribe(() => notifications++);
  const snapshot = (text: string) => ({
    conversation: [
      {
        id: 'same-message-id',
        role: 'assistant' as const,
        text,
        at: new Date().toISOString(),
        streaming: true,
      },
    ],
    conversationTruncated: false,
  });
  const source = snapshot('Agent A partial');
  callbacks[0](source);
  callbacks[1](snapshot('Agent B partial'));
  callbacks[0](snapshot('Agent A updated'));
  source.conversation[0].text = 'Mutated callback input';
  assert.equal(notifications, 3);
  assert.equal(
    manager.conversation(records[0].id).conversation[0].text,
    'Agent A updated',
  );
  assert.equal(
    manager.conversation(records[1].id).conversation[0].text,
    'Agent B partial',
  );
  manager.conversation(records[0].id).conversation[0].text = 'Mutated accessor';
  finishes[0].resolve('A final');
  finishes[1].resolve('B final');
  await manager.wait(records.map(record => record.id));
  assert.equal(
    manager.conversation(records[0].id).conversation[0].text,
    'Agent A updated',
  );
  assert.equal(
    manager.conversation(records[1].id).conversation[0].text,
    'Agent B partial',
  );
  assert.ok(
    records.every(record =>
      manager
        .conversation(record.id)
        .conversation.every(message => !message.streaming),
    ),
  );
});

async function untilPolicy(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'Expected worker state was not reached');
    await delay(5);
  }
}

async function isolateToolSettings(
  t: TestContext,
  allowedModels?: string[] | null,
) {
  const directory = await mkdtemp(join(tmpdir(), 'varisdev-agent-policy-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, {recursive: true, force: true});
  });
  if (allowedModels !== undefined)
    await saveToolSettings('agents', {allowedModels});
  return directory;
}

void test('agent tools enforce live allowed models and refresh schemas between turns without a new prompt', async t => {
  await isolateToolSettings(t);
  const workers = teamWorkers();
  const parent = agentParent('policy-live', workers.create);
  t.after(() => parent.shutdown());
  const fullName = 'openai-codex/gpt-5.6-sol';
  const params = {name: 'Allowed', task: 'Inspect', model: fullName};
  await saveToolSettings('agents', {allowedModels: ['other/model']});
  await parent.emit('before_agent_start');
  assert.equal(
    JSON.stringify(parent.tools.get('agent_spawn')).split('other/model')
      .length - 1,
    1,
    'Allowed model choices are advertised once in the schema',
  );
  assert.equal(
    Check(parent.tools.get('agent_spawn')!.parameters, params),
    true,
    'Runtime policy validates inherited choices without blocking pinned overrides',
  );
  assert.equal(
    Check(parent.tools.get('agent_spawn')!.parameters, {
      ...params,
      model: 'other/model',
    }),
    true,
  );
  // Execute also enforces policy even when callers bypass schema validation.
  await assert.rejects(
    parent.spawn('Inherited denied'),
    /Menu → Tool models.*other\/model/,
  );
  await assert.rejects(parent.execute('agent_spawn', params), /not allowed/);
  assert.equal(workers.created.length, 0);
  const newlyAllowed = 'openai-codex/gpt-6.1-sol';
  await saveToolSettings('agents', {allowedModels: [fullName, newlyAllowed]});
  await parent.emit('turn_end');
  assert.ok(Check(parent.tools.get('agent_spawn')!.parameters, params));
  assert.ok(
    Check(parent.tools.get('agent_spawn')!.parameters, {
      ...params,
      model: newlyAllowed,
    }),
  );
  assert.equal(
    JSON.stringify(parent.tools.get('agent_spawn')).split(newlyAllowed).length -
      1,
    1,
  );
  const unchanged = parent.tools.get('agent_spawn');
  await parent.emit('turn_end');
  assert.equal(
    parent.tools.get('agent_spawn'),
    unchanged,
    'Unchanged settings do not churn the tool registry',
  );
  assert.equal(
    JSON.stringify(parent.tools.get('agent_spawn')).split(fullName).length - 1,
    1,
  );
  const id = await parent.spawn('Inherited allowed');
  await untilPolicy(() => workers.byId.get(id)?.controlled.runs.length === 1);
  assert.equal(workers.byId.get(id)!.options.model, parent.ctx.model);
  await saveToolSettings('agents', {allowedModels: ['other/model']});
  await assert.rejects(
    parent.spawn('Changed during open session'),
    /not allowed/,
  );
  assert.equal(workers.byId.get(id)!.controlled.runs[0].signal.aborted, false);
  await parent.emit('turn_end');
  assert.equal(
    Check(parent.tools.get('agent_spawn')!.parameters, params),
    true,
  );
  await assert.rejects(parent.execute('agent_spawn', params), /not allowed/);
  await saveToolSettings('agents', {allowedModels: null});
  await parent.emit('turn_end');
  assert.match(
    parent.tools.get('agent_spawn')!.description,
    /any model from the current model registry/,
  );
  assert.ok(
    Check(parent.tools.get('agent_spawn')!.parameters, {
      ...params,
      model: 'custom/organization/model',
    }),
  );
  // The controller's session_start handler must still reset the team.
  await parent.shutdown('new');
  await parent.emit('session_start');
  assert.deepEqual((await parent.execute('agent_list')).details.agents, []);
});

void test('model policy is checked when queued workers start, including initialized and resumed workers', async t => {
  await isolateToolSettings(t, ['openai-codex/gpt-5.6-sol']);
  const workers = teamWorkers();
  const parent = agentParent('policy-queue', workers.create);
  t.after(() => parent.shutdown());
  const resumed = await parent.spawn('Will resume');
  await untilPolicy(
    () => workers.byId.get(resumed)?.controlled.runs.length === 1,
  );
  workers.byId.get(resumed)!.controlled.runs[0].finish('First result');
  await parent.execute('agent_wait', {ids: [resumed]});
  const busy: string[] = [];
  for (let i = 0; i < 5; i++) busy.push(await parent.spawn(`Busy ${i}`));
  await untilPolicy(() =>
    busy.every(id => workers.byId.get(id)?.controlled.runs.length === 1),
  );
  const uninitialized = await parent.spawn('Uninitialized queued');
  const initialized = await parent.spawn('Initialized queued');
  await parent.execute('agent_send', {
    id: initialized,
    message: 'Steer before queue opens',
  });
  assert.equal(workers.byId.get(initialized)!.controlled.runs.length, 0);
  await parent.execute('agent_send', {
    id: resumed,
    message: 'Resume after queue opens',
  });
  await saveToolSettings('agents', {allowedModels: ['other/model']});
  for (const id of busy)
    workers.byId.get(id)!.controlled.runs[0].finish('Done');
  const result = await parent.execute('agent_wait', {
    ids: [uninitialized, initialized, resumed],
  });
  assert.ok(
    result.details.agents.every(
      agent =>
        agent.status === 'failed' &&
        agent.error?.includes('Menu → Tool models'),
    ),
  );
  assert.equal(workers.byId.has(uninitialized), false);
  assert.equal(workers.byId.get(initialized)!.controlled.runs.length, 0);
  assert.equal(workers.byId.get(resumed)!.controlled.runs.length, 1);
});

void test('pinned model snapshots survive queueing, initialization, cancellation, and resume after policy and configuration changes', async t => {
  const model = 'openai-codex/gpt-5.6-sol';
  const directory = await isolateToolSettings(t, [model]);
  const cwd = join(directory, 'project');
  await mkdir(cwd);
  const profile = {id: 'pinned', scope: 'workspace', mode: 'subagent'};
  await saveAgentTemplate(cwd, {...profile, model});
  const workers = teamWorkers();
  const parent = agentParent('pinned-queue', workers.create, cwd);
  t.after(() => parent.shutdown());
  const spawnPinned = async (name: string) => {
    const result = await parent.execute('agent_spawn', {
      name,
      template: 'pinned',
      task: name,
      model: 'other/ignored',
    });
    const record = result.details.agents[0];
    assert.equal(record.model, model);
    assert.equal(record.pinnedModel, model);
    assert.equal(record.agentMode, 'subagent');
    return record.id;
  };
  const resumed = await spawnPinned('Retained pinned worker');
  await untilPolicy(
    () => workers.byId.get(resumed)?.controlled.runs.length === 1,
  );
  workers.byId.get(resumed)!.controlled.runs[0].finish('Initial result');
  await parent.execute('agent_wait', {ids: [resumed]});
  const busy: string[] = [];
  for (let index = 0; index < 5; index++)
    busy.push(await parent.spawn(`Busy ${index}`));
  await untilPolicy(() =>
    busy.every(id => workers.byId.get(id)?.controlled.runs.length === 1),
  );
  const uninitialized = await spawnPinned('Uninitialized pin');
  const initialized = await spawnPinned('Initialized pin');
  const cancelled = await spawnPinned('Cancelled pin');
  await parent.execute('agent_send', {
    id: initialized,
    message: 'Initialize while queued',
  });
  await parent.execute('agent_cancel', {id: cancelled});
  assert.equal(workers.byId.has(uninitialized), false);
  assert.equal(workers.byId.has(cancelled), false);
  await saveAgentTemplate(cwd, {
    ...profile,
    model: 'other/changed',
    mode: 'all',
  });
  await saveToolSettings('agents', {allowedModels: []});
  for (const id of [resumed, cancelled])
    await parent.execute('agent_send', {
      id,
      message: 'Resume with the saved pin',
    });
  for (const id of busy)
    workers.byId.get(id)!.controlled.runs[0].finish('Done');
  const ids = [uninitialized, initialized, cancelled, resumed];
  await untilPolicy(() =>
    ids.every(
      id =>
        workers.byId.get(id)?.controlled.runs.length ===
        (id === resumed ? 2 : 1),
    ),
  );
  for (const id of ids) {
    const worker = workers.byId.get(id)!;
    assert.equal(worker.options.agentProfile?.model, model);
    assert.equal(
      `${worker.options.model.provider}/${worker.options.model.id}`,
      model,
    );
    worker.controlled.runs.at(-1)!.finish('Pinned result');
  }
  const result = await parent.execute('agent_wait', {ids});
  assert.ok(
    result.details.agents.every(
      record =>
        record.status === 'completed' &&
        record.model === model &&
        record.pinnedModel === model &&
        record.agentMode === 'subagent',
    ),
  );
});

void test('nested launches and peer resume checks use the recipient configuration pin', async t => {
  const model = 'openai-codex/gpt-5.6-sol';
  const directory = await isolateToolSettings(t, [model]);
  const cwd = join(directory, 'project');
  await mkdir(cwd);
  await saveAgentTemplate(cwd, {
    id: 'pinned',
    scope: 'workspace',
    mode: 'subagent',
    model,
  });
  const workers = teamWorkers();
  const parent = agentParent('pinned-peers', workers.create, cwd);
  t.after(() => parent.shutdown());
  const sender = await parent.spawn('Inherited sender');
  const inherited = await parent.spawn('Inherited recipient');
  const pinnedSender = (
    await parent.execute('agent_spawn', {
      template: 'pinned',
      task: 'Coordinate peers',
    })
  ).details.agents[0].id;
  await untilPolicy(
    () => workers.byId.get(pinnedSender)?.controlled.runs.length === 1,
  );
  const nested = await workers.byId.get(sender)!.execute('agent_spawn', {
    template: 'pinned',
    task: 'Use the child configuration pin',
    model: 'other/ignored',
  });
  const recipient = (nested.details as {agents: AgentRecord[]}).agents[0];
  assert.equal(recipient.pinnedModel, model);
  assert.equal(recipient.agentMode, 'subagent');
  await untilPolicy(
    () => workers.byId.get(recipient.id)?.controlled.runs.length === 1,
  );
  for (const id of [inherited, recipient.id])
    workers.byId.get(id)!.controlled.runs[0].finish('Initial result');
  await parent.execute('agent_wait', {ids: [inherited, recipient.id]});
  await saveToolSettings('agents', {allowedModels: []});
  await parent.execute('agent_send', {
    id: recipient.id,
    message: 'Parent resumes pin',
  });
  await untilPolicy(
    () => workers.byId.get(recipient.id)!.controlled.runs.length === 2,
  );
  workers.byId.get(recipient.id)!.controlled.runs[1].finish('Parent result');
  await parent.execute('agent_wait', {ids: [recipient.id]});
  await workers.byId.get(sender)!.execute('agent_send', {
    id: recipient.id,
    message: 'Inherited peer resumes pin',
  });
  await untilPolicy(
    () => workers.byId.get(recipient.id)!.controlled.runs.length === 3,
  );
  for (const id of [sender, pinnedSender])
    await assert.rejects(
      workers.byId
        .get(id)!
        .execute('agent_send', {id: inherited, message: 'Denied resume'}),
      /No agent models selected/,
    );
  await assert.rejects(
    workers.byId
      .get(pinnedSender)!
      .execute('agent_spawn', {task: 'Inherited child is restricted'}),
    /No agent models selected/,
  );
  const pinnedChild = await workers.byId
    .get(pinnedSender)!
    .execute('agent_spawn', {
      template: 'pinned',
      task: 'Pinned child is allowed',
      model: 'other/ignored',
    });
  const child = (pinnedChild.details as {agents: AgentRecord[]}).agents[0];
  await untilPolicy(
    () => workers.byId.get(child.id)?.controlled.runs.length === 1,
  );
  assert.equal(child.model, model);
  assert.equal(child.pinnedModel, model);
  assert.equal(workers.byId.get(child.id)!.options.agentProfile?.model, model);
});

void test('parent and peer messages cannot resume completed agents with disallowed models', async t => {
  await isolateToolSettings(t, ['openai-codex/gpt-5.6-sol']);
  const workers = teamWorkers();
  const parent = agentParent('policy-resume', workers.create);
  t.after(() => parent.shutdown());
  const recipient = await parent.spawn('Recipient');
  const sender = await parent.spawn('Sender');
  await untilPolicy(
    () => workers.byId.get(sender)?.controlled.runs.length === 1,
  );
  workers.byId.get(recipient)!.controlled.runs[0].finish('Done');
  await parent.execute('agent_wait', {ids: [recipient]});
  await saveToolSettings('agents', {allowedModels: ['other/model']});
  await assert.rejects(
    parent.execute('agent_send', {id: recipient, message: 'More work'}),
    /not allowed/,
  );
  await assert.rejects(
    workers.byId
      .get(sender)!
      .execute('agent_send', {id: recipient, message: 'More work'}),
    /not allowed/,
  );
  assert.equal(
    (await parent.execute('agent_status', {id: recipient})).details.agents[0]
      .status,
    'completed',
  );
  await parent.execute('agent_send', {
    id: sender,
    message: 'Finish in-flight work',
  });
  assert.equal(workers.byId.get(sender)!.controlled.steering.length, 1);
  await saveToolSettings('agents', {allowedModels: null});
  await parent.execute('agent_send', {id: recipient, message: 'Allowed again'});
  await untilPolicy(
    () => workers.byId.get(recipient)!.controlled.runs.length === 2,
  );
});

void test('fresh and cleared agent policies deny explicit and inherited models without an empty schema enum', async t => {
  await isolateToolSettings(t);
  const workers = teamWorkers();
  const parent = agentParent('policy-empty', workers.create);
  t.after(() => parent.shutdown());
  const model = 'openai-codex/gpt-5.6-sol';
  const params = {name: 'Explicit', task: 'Must not start', model};
  const assertEmptyPolicy = async () => {
    const tool = parent.tools.get('agent_spawn')!;
    assert.match(tool.description, /No models enabled.*Menu → Tool models/);
    const schema = tool.parameters as {
      properties: {model: {enum?: string[]; description: string}};
    };
    assert.equal(Object.hasOwn(schema.properties.model, 'enum'), false);
    assert.doesNotMatch(
      schema.properties.model.description,
      /Menu → Tool models/,
    );
    await assert.rejects(
      parent.spawn('Inherited denied'),
      /No agent models selected.*Choose a model in Menu → Tool models/,
    );
    await assert.rejects(
      parent.execute('agent_spawn', params),
      /No agent models selected.*Choose a model in Menu → Tool models/,
    );
    assert.equal(workers.created.length, 0);
  };
  await parent.emit('before_agent_start');
  await assertEmptyPolicy();
  await saveToolSettings('agents', {allowedModels: [model]});
  await parent.emit('turn_end');
  assert.match(
    (
      parent.tools.get('agent_spawn')!.parameters as {
        properties: {model: {description: string}};
      }
    ).properties.model.description,
    /Allowed when inheriting: openai-codex\/gpt-5\.6-sol/,
  );
  await saveToolSettings('agents', {allowedModels: []});
  await parent.emit('turn_end');
  await assertEmptyPolicy();
});

function visibleAgentResult(
  result: Awaited<ReturnType<ToolDefinition['execute']>>,
) {
  const text = result.content.find(item => item.type === 'text');
  assert.ok(text?.type === 'text');
  return JSON.parse(text.text) as {
    agents: Array<Partial<AgentRecord> & {resumable?: boolean}>;
  };
}

void test('agent acknowledgements stay compact while status metadata remains available on request', async t => {
  await isolateToolSettings(t, ['openai-codex/gpt-5.6-sol']);
  const workers = teamWorkers();
  const parent = agentParent('compact-agent-output', workers.create);
  t.after(() => parent.shutdown());
  const spawned = await parent.execute('agent_spawn', {
    name: 'Review',
    task: 'Inspect the change',
  });
  const id = spawned.details.agents[0].id;
  assert.deepEqual(visibleAgentResult(spawned).agents, [
    {id, name: 'Review', status: 'running'},
  ]);
  assert.equal(spawned.details.agents[0].cwd, parent.ctx.cwd);
  await until(() => workers.byId.get(id)?.controlled.runs.length === 1);
  const status = visibleAgentResult(await parent.execute('agent_status', {id}))
    .agents[0];
  assert.equal(status.activity, 'Using read');
  for (const field of [
    'cwd',
    'model',
    'sessionFile',
    'resultFile',
    'createdAt',
    'startedAt',
    'agentProfile',
  ])
    assert.equal(Object.hasOwn(status, field), false, field);
  const detail = visibleAgentResult(
    await parent.execute('agent_status', {id, details: true}),
  ).agents[0];
  assert.equal(detail.cwd, parent.ctx.cwd);
  assert.equal(detail.model, 'openai-codex/gpt-5.6-sol');
  assert.deepEqual(detail.agentProfile, {
    id: 'default',
    name: 'Default',
    mode: 'all',
  });
  assert.equal(detail.sessionFile, '/worker/0/transcript.jsonl');
  assert.equal(detail.resultFile, '/worker/0/result.txt');
  const sent = await parent.execute('agent_send', {
    id,
    message: 'Check the integration too',
  });
  assert.deepEqual(visibleAgentResult(sent).agents, [
    {id, name: 'Review', status: 'running'},
  ]);
  const cancelled = await parent.execute('agent_cancel', {id});
  assert.deepEqual(visibleAgentResult(cancelled).agents, [
    {id, name: 'Review', status: 'cancelling'},
  ]);
  const finished = await parent.execute('agent_wait', {ids: [id]});
  const failure = visibleAgentResult(finished).agents[0];
  assert.equal(failure.status, 'cancelled');
  assert.match(failure.error!, /cancelled/i);
  assert.equal(
    Object.hasOwn(failure, 'activity'),
    false,
    'Do not echo the error as activity',
  );
});

void test('fast results remain retrievable and truncation always provides a path, including across resumes', async t => {
  await isolateToolSettings(t, ['openai-codex/gpt-5.6-sol']);
  const workers = teamWorkers();
  const parent = agentParent('compact-agent-results', workers.create);
  t.after(() => parent.shutdown());
  const id = await parent.spawn('Fast worker');
  await until(() => workers.byId.get(id)?.controlled.runs.length === 1);
  const worker = workers.byId.get(id)!.controlled;
  worker.runs[0].finish('x'.repeat(20000));
  await until(
    () => parent.control.snapshot()?.agents[0].status === 'completed',
  );
  const first = visibleAgentResult(await parent.execute('agent_wait'))
    .agents[0];
  assert.equal(first.status, 'completed');
  assert.equal(first.output?.length, 12000);
  assert.equal(first.outputTruncated, true);
  assert.equal(first.resultFile, '/worker/0/result.txt');
  assert.equal(Object.hasOwn(first, 'sessionFile'), false);
  const repeated = visibleAgentResult(
    await parent.execute('agent_status', {id}),
  ).agents[0];
  assert.deepEqual(repeated, first, 'Reading results must not consume them');
  await parent.execute('agent_send', {id, message: 'A short follow-up'});
  await until(() => worker.runs.length === 2);
  worker.runs[1].finish('Done');
  const resumed = visibleAgentResult(
    await parent.execute('agent_wait', {ids: [id]}),
  ).agents[0];
  assert.equal(resumed.output, 'Done');
  assert.equal(resumed.outputTruncated, undefined);
  assert.equal(resumed.resultFile, undefined);
});

void test('bulk waits bound result text and identify only outputs requiring a full file read', async t => {
  await isolateToolSettings(t, ['openai-codex/gpt-5.6-sol']);
  const workers = teamWorkers();
  const parent = agentParent('bounded-agent-results', workers.create);
  t.after(() => parent.shutdown());
  const ids = [];
  for (const name of ['Long', 'Short', 'Shorter'])
    ids.push(await parent.spawn(name));
  await until(
    () =>
      workers.created.length === ids.length &&
      workers.created.every(worker => worker.controlled.runs.length === 1),
  );
  for (const [index, id] of ids.entries())
    workers.byId
      .get(id)!
      .controlled.runs[0].finish(index ? 'Done' : 'x'.repeat(10000));
  const {agents} = visibleAgentResult(
    await parent.execute('agent_wait', {ids}),
  );
  assert.ok(
    agents.reduce((length, agent) => length + (agent.output?.length || 0), 0) <=
      20000,
  );
  assert.equal(agents[0].outputTruncated, true);
  assert.equal(agents[0].resultFile, '/worker/0/result.txt');
  assert.equal(agents[1].outputTruncated, undefined);
  assert.equal(agents[1].resultFile, undefined);
});

void test('inbox tool forwards incremental cursors and message lookup still retrieves full text', async t => {
  await isolateToolSettings(t, ['openai-codex/gpt-5.6-sol']);
  const workers = teamWorkers();
  const parent = agentParent('inbox-tool-cursor', workers.create);
  t.after(() => parent.shutdown());
  const id = await parent.spawn('Reporter');
  await until(() => workers.byId.get(id)?.controlled.runs.length === 1);
  const reporter = workers.byId.get(id)!;
  await reporter.execute('agent_send', {id: 'parent', message: 'First report'});
  const first = await parent.execute('agent_inbox', {after: 0});
  const content = first.content[0];
  assert.ok(content.type === 'text');
  const page = JSON.parse(content.text) as {
    nextAfter: number;
    hasMore: boolean;
    messages: Array<{id: string; preview: string}>;
  };
  assert.equal(page.nextAfter, 1);
  assert.equal(page.hasMore, false);
  assert.equal(page.messages[0].preview, 'First report');
  const empty = (await parent.execute('agent_inbox', {after: page.nextAfter}))
    .content[0];
  assert.ok(empty.type === 'text');
  assert.deepEqual(JSON.parse(empty.text).messages, []);
  const full = (
    await parent.execute('agent_inbox', {
      messageId: page.messages[0].id,
      after: 0,
      offset: 0,
    })
  ).content[0];
  assert.ok(full.type === 'text');
  assert.equal(JSON.parse(full.text).message.message, 'First report');
});

void test('cancelled operations settle before concurrent messages reuse the retained worker', async t => {
  const manager = new AgentOrchestrator(3);
  const controlled = controlledWorker(false);
  t.after(() => {
    controlled.runs.at(-1)?.finish('Cleanup');
    return manager.close();
  });
  let created = 0;
  const {id} = manager.spawn(spec, async () => {
    created++;
    return controlled.worker;
  });
  await until(() => controlled.runs.length === 1);
  manager.cancel(id);
  const first = manager.send(id, 'Resume after stop');
  const second = manager.send(id, 'Include the tests');
  await nextTick();
  assert.equal(controlled.runs.length, 1);
  controlled.runs[0].finish('Discard this late output');
  await Promise.all([first, second]);
  await until(() => controlled.runs.length === 2);
  assert.equal(created, 1);
  assert.equal(controlled.disposed, 0);
  assert.equal(controlled.runs[1].message, 'Resume after stop');
  assert.deepEqual(controlled.steering, ['Include the tests']);
  assert.equal(manager.get(id).error, undefined);
  controlled.runs[1].finish('Recovered response');
  const [record] = await manager.wait([id]);
  assert.equal(record.output, 'Recovered response');
  assert.equal(record.resumable, true);
});

void test('a finishing prompt resumes only after its operation settles and model errors stay reusable', async t => {
  const manager = new AgentOrchestrator(3);
  const controlled = controlledWorker();
  controlled.worker.steer = async () => false;
  t.after(() => manager.close());
  const {id} = manager.spawn(spec, async () => controlled.worker);
  await until(() => controlled.runs.length === 1);
  const sending = manager.send(id, 'Next request');
  await nextTick();
  assert.equal(controlled.runs.length, 1);
  controlled.runs[0].finish('Original response');
  await sending;
  await until(() => controlled.runs.length === 2);
  controlled.runs[1].fail(new Error('Provider failed'));
  await manager.wait([id]);
  assert.equal(manager.get(id).status, 'failed');
  assert.equal(manager.get(id).resumable, true);
  assert.equal(controlled.disposed, 0);
  await manager.send(id, 'Recover from provider error');
  await until(() => controlled.runs.length === 3);
  controlled.runs[2].finish('Recovered');
  assert.equal((await manager.wait([id]))[0].output, 'Recovered');
});

void test('cancellation before initialization retains the factory and closing makes the conversation disposable', async t => {
  const manager = new AgentOrchestrator(2);
  t.after(() => manager.close());
  const busy = controlledWorker();
  const controlled = controlledWorker();
  manager.spawn(spec, async () => busy.worker);
  let created = 0;
  const {id} = manager.spawn(spec, async () => {
    created++;
    return controlled.worker;
  });
  await until(() => busy.runs.length === 1);
  manager.cancel(id);
  assert.equal(manager.get(id).resumable, true);
  assert.equal(created, 0);
  await manager.send(id, 'Replace the cancelled initial task');
  assert.equal(manager.get(id).status, 'queued');
  busy.runs[0].finish('Done');
  await until(() => controlled.runs.length === 1);
  assert.equal(
    controlled.runs[0].message,
    'Replace the cancelled initial task',
  );
  controlled.runs[0].finish('Retained result');
  await manager.wait([id]);
  const history = manager.conversation(id);
  await manager.closeAgent(id);
  assert.equal(controlled.disposed, 1);
  assert.equal(manager.get(id).resumable, false);
  assert.equal(manager.get(id).output, 'Retained result');
  assert.deepEqual(manager.conversation(id), history);
  await assert.rejects(manager.send(id, 'Cannot reopen'), /cleaned up/);
  await manager.close();
  assert.equal(controlled.disposed, 1);
});

void test('abort recovers and clears queued messages while preserving a worker for reuse', async t => {
  const manager = new AgentOrchestrator(2);
  const busy = controlledWorker();
  const controlled = controlledWorker();
  const pending: string[] = [];
  controlled.worker.steer = async message => {
    pending.push(message);
    return true;
  };
  controlled.worker.clearQueue = () => ({
    steering: pending.splice(0),
    followUp: [],
  });
  t.after(() => manager.close());
  manager.spawn(spec, async () => busy.worker);
  const {id} = manager.spawn(spec, async () => controlled.worker);
  await until(() => busy.runs.length === 1);
  await manager.send(id, 'Pending scope');
  assert.deepEqual(await manager.abort(id), {
    steering: ['Pending scope'],
    followUp: [],
  });
  assert.deepEqual(pending, []);
  assert.equal(controlled.disposed, 0);
  await manager.send(id, 'Fresh scope');
  busy.runs[0].finish('Done');
  await until(() => controlled.runs.length === 1);
  assert.equal(controlled.runs[0].message, 'Fresh scope');
  controlled.runs[0].finish('Fresh result');
  await manager.wait([id]);
});

void test('close cancels finished worker interactions before disposal and rejects queued maintenance', async t => {
  for (const scope of ['agent', 'session'] as const) {
    await t.test(scope, async t => {
      const manager = new AgentOrchestrator();
      const controlled = controlledWorker();
      const cancelled = deferred<void>();
      const settling = deferred<void>();
      const actions: string[] = [];
      controlled.worker.command = async () => {
        actions.push('command');
        await cancelled.promise;
        actions.push('cancelled');
        await settling.promise;
        throw new Error('Dialog cancelled');
      };
      controlled.worker.abort = async () => {
        cancelled.resolve();
      };
      controlled.worker.reload = async () => {
        actions.push('reload');
      };
      t.after(() => {
        settling.resolve();
        return manager.close();
      });
      const {id} = manager.spawn(spec, async () => controlled.worker);
      await until(() => controlled.runs.length === 1);
      controlled.runs[0].finish('Retained result');
      await manager.wait([id]);
      const command = assert.rejects(
        manager.command(id, '/model'),
        /Dialog cancelled/,
      );
      await until(() => actions.includes('command'));
      const queued = assert.rejects(
        manager.reload(id),
        /closed|cleaned up|cancelled/,
      );
      let closed = false;
      const closing = (
        scope === 'agent' ? manager.closeAgent(id) : manager.close()
      ).then(() => {
        closed = true;
      });
      await until(() => actions.includes('cancelled'));
      assert.equal(controlled.disposed, 0);
      assert.equal(closed, false);
      settling.resolve();
      await Promise.all([command, queued, closing]);
      assert.deepEqual(actions, ['command', 'cancelled']);
      assert.equal(controlled.disposed, 1);
      assert.equal(manager.get(id).output, 'Retained result');
      assert.equal(manager.get(id).resumable, false);
      await manager.close();
      assert.equal(controlled.disposed, 1);
    });
  }
});

void test('abort cancels idle maintenance, waits for it, and invalidates queued operations', async t => {
  const manager = new AgentOrchestrator();
  const controlled = controlledWorker();
  const cancelled = deferred<void>();
  const settling = deferred<void>();
  const actions: string[] = [];
  controlled.worker.compact = async () => {
    actions.push('compact');
    await cancelled.promise;
    actions.push('cancelled');
    await settling.promise;
    throw new Error('Compaction cancelled');
  };
  controlled.worker.abort = async () => {
    cancelled.resolve();
  };
  controlled.worker.reload = async () => {
    actions.push('reload');
  };
  t.after(() => {
    settling.resolve();
    return manager.close();
  });
  const {id} = manager.spawn(spec, async () => controlled.worker);
  await until(() => controlled.runs.length === 1);
  controlled.runs[0].finish('Retained result');
  await manager.wait([id]);
  const compacting = assert.rejects(
    manager.compact(id),
    /Compaction cancelled/,
  );
  await until(() => actions.includes('compact'));
  const queued = assert.rejects(manager.reload(id), /operation cancelled/);
  const pendingMessage = assert.rejects(
    manager.send(id, 'Discard this message'),
    /message cancelled/,
  );
  let stopped = false;
  const stopping = manager.abort(id).then(() => {
    stopped = true;
  });
  await until(() => actions.includes('cancelled'));
  assert.equal(stopped, false);
  assert.equal(controlled.disposed, 0);
  settling.resolve();
  await Promise.all([compacting, queued, pendingMessage, stopping]);
  assert.deepEqual(actions, ['compact', 'cancelled']);
  assert.equal(manager.get(id).resumable, true);
  await manager.send(id, 'Resume after compaction cancellation');
  await until(() => controlled.runs.length === 2);
  controlled.runs[1].finish('Recovered result');
  assert.equal((await manager.wait([id]))[0].output, 'Recovered result');
});

void test('worker context updates through run callbacks, clears unavailable data, and retains isolated snapshots after disposal', async t => {
  const manager = new AgentOrchestrator(2);
  t.after(() => manager.close());
  const busy = controlledWorker();
  const controlled = controlledWorker();
  let context: AgentContextUsage | undefined = {
    tokens: 100,
    window: 1000,
    percent: 10,
  };
  manager.spawn(spec, async () => busy.worker);
  const {id} = manager.spawn({...spec, autoCleanup: true}, async () => ({
    ...controlled.worker,
    get context() {
      return context;
    },
    dispose() {
      context = undefined;
      return controlled.worker.dispose();
    },
  }));
  await until(() => busy.runs.length === 1);
  const prepared = await manager.send(id, 'Initialize before a slot opens');
  assert.deepEqual(prepared.context, {tokens: 100, window: 1000, percent: 10});
  context.tokens = 200;
  assert.equal(
    manager.get(id).context?.tokens,
    100,
    'Copy context from the worker getter',
  );
  busy.runs[0].finish('Done');
  await until(() => controlled.runs.length === 1);
  assert.equal(manager.get(id).context?.tokens, 200);
  const run = controlled.runs[0];
  let updates = 0;
  manager.subscribe(() => updates++);
  context = {tokens: 300, window: 1000, percent: 30};
  run.onActivity('Using read');
  assert.equal(updates, 1, 'Repeated activity still publishes changed context');
  assert.deepEqual(manager.get(id).context, context);
  manager.get(id).context!.tokens = 999;
  manager.list().find(record => record.id === id)!.context!.window = 999;
  assert.deepEqual(manager.get(id).context, context);
  context = {tokens: 400, window: 1000, percent: 40};
  run.onConversation!({conversation: [], conversationTruncated: false});
  assert.deepEqual(manager.get(id).context, context);
  context = {tokens: null, window: 1000, percent: null};
  run.onUsage!({
    source: 'provider',
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
    calls: [],
    truncated: false,
  });
  assert.deepEqual(manager.get(id).context, {
    tokens: null,
    window: 1000,
    percent: null,
  });
  context = undefined;
  run.onActivity('Using read');
  assert.equal(
    manager.get(id).context,
    undefined,
    'Unavailable live context clears the prior estimate',
  );
  const final = {tokens: 500, window: 1000, percent: 50};
  context = final;
  run.finish('Finished');
  const [completed] = await manager.wait([id]);
  assert.equal(controlled.disposed, 1);
  assert.deepEqual(completed.context, final);
  completed.context!.percent = 99;
  assert.deepEqual(manager.get(id).context, final);
  await manager.close();
  assert.deepEqual(
    manager.get(id).context,
    final,
    'Disposal preserves the last captured context',
  );
});

void test('agent tool wrappers forward live worker context into isolated team snapshots', async t => {
  await isolateToolSettings(t, ['openai-codex/gpt-5.6-sol']);
  const controlled = controlledWorker();
  let context: AgentContextUsage | undefined = {
    tokens: 1000,
    window: 10000,
    percent: 10,
  };
  const parent = agentParent('worker-context', async () => ({
    ...controlled.worker,
    get context() {
      return context;
    },
  }));
  t.after(() => parent.shutdown());
  const id = await parent.spawn('Context worker');
  await until(() => controlled.runs.length === 1);
  const original = parent.control.snapshot()!;
  assert.deepEqual(original.agents[0].context, context);
  context = {tokens: 2500, window: 10000, percent: 25};
  controlled.runs[0].onConversation!({
    conversation: [],
    conversationTruncated: false,
  });
  const current = parent.control.snapshot()!;
  assert.deepEqual(current.agents[0].context, context);
  assert.equal(original.agents[0].context?.tokens, 1000);
  current.agents[0].context!.tokens = 9999;
  const status = await parent.execute('agent_status', {id});
  assert.deepEqual(status.details.agents[0].context, context);
  context = undefined;
  controlled.runs[0].onActivity('Using read');
  assert.equal(parent.control.snapshot()!.agents[0].context, undefined);
});

void test('worker configuration updates records and serializes queued maintenance before a prompt starts', async t => {
  const manager = new AgentOrchestrator(2);
  t.after(() => manager.close());
  const busy = controlledWorker();
  const controlled = controlledWorker();
  const configuration = deferred<void>();
  const actions: string[] = [];
  let context: AgentContextUsage | undefined = {
    tokens: 3000,
    window: 10000,
    percent: 30,
  };
  const features: SessionFeatures = {
    commands: [],
    models: [{provider: 'test', id: 'updated', name: 'Updated'}],
    model: {provider: 'test', id: 'updated'},
    thinkingLevel: 'high',
    thinkingLevels: ['off', 'high'],
    tools: [],
    diagnostics: [],
  };
  controlled.worker.features = async () => structuredClone(features);
  controlled.worker.configure = async input => {
    actions.push(JSON.stringify(input));
    await configuration.promise;
    context = {tokens: 3000, window: 20000, percent: 15};
    return structuredClone(features);
  };
  controlled.worker.compact = async instructions => {
    actions.push(`compact:${instructions}`);
    context = {tokens: 1000, window: 20000, percent: 5};
  };
  controlled.worker.reload = async () => {
    actions.push('reload');
    context = undefined;
  };
  manager.spawn(spec, async () => busy.worker);
  const {id} = manager.spawn(spec, async () => ({
    ...controlled.worker,
    get context() {
      return context;
    },
  }));
  await until(() => busy.runs.length === 1);
  assert.deepEqual(await manager.features(id), features);
  assert.deepEqual(manager.get(id).context, context);
  const changing = manager.configure(id, {
    provider: 'test',
    modelId: 'updated',
    thinkingLevel: 'high',
    persist: false,
  });
  await until(() => actions.length === 1);
  busy.runs[0].finish('Done');
  await nextTick();
  assert.equal(controlled.runs.length, 0);
  configuration.resolve();
  const record = await changing;
  assert.equal(record.model, 'test/updated');
  assert.equal(record.thinkingLevel, 'high');
  assert.deepEqual(record.context, {tokens: 3000, window: 20000, percent: 15});
  await until(() => controlled.runs.length === 1);
  controlled.runs[0].finish('Configured result');
  await manager.wait([id]);
  await manager.compact(id, 'Keep findings');
  assert.deepEqual(manager.get(id).context, {
    tokens: 1000,
    window: 20000,
    percent: 5,
  });
  assert.equal(
    record.context?.tokens,
    3000,
    'Older snapshots keep their context',
  );
  await manager.reload(id);
  assert.equal(manager.get(id).context, undefined);
  assert.deepEqual(actions.slice(1), ['compact:Keep findings', 'reload']);
  await manager.close();
  await assert.rejects(manager.features(id), /closed/);
});

void test('stop clears messages awaiting session initialization and retained startup failures can retry', async t => {
  const manager = new AgentOrchestrator(2);
  const controlled = controlledWorker();
  const initializing = deferred<AgentWorker>();
  t.after(() => {
    initializing.resolve(controlled.worker);
    return manager.close();
  });
  let created = 0;
  const {id} = manager.spawn(spec, async () => {
    created++;
    return initializing.promise;
  });
  await until(() => created === 1);
  const oldMessage = manager.send(id, 'Discard pending preflight message');
  const rejected = assert.rejects(oldMessage, /message cancelled/);
  await nextTick();
  manager.cancel(id);
  initializing.resolve(controlled.worker);
  await rejected;
  await manager.wait([id]);
  assert.deepEqual(controlled.steering, []);
  assert.equal(controlled.runs.length, 0);
  await manager.send(id, 'Resume initialized session');
  await until(() => controlled.runs.length === 1);
  controlled.runs[0].finish('Ready');
  await manager.wait([id]);
  assert.equal(created, 1);

  let attempts = 0;
  const recovered = controlledWorker();
  const startup = manager.spawn(spec, async () => {
    if (++attempts === 1) throw new Error('Credentials missing');
    return recovered.worker;
  });
  await manager.wait([startup.id]);
  assert.equal(manager.get(startup.id).resumable, true);
  await manager.send(startup.id, 'Retry after credentials are restored');
  await until(() => recovered.runs.length === 1);
  recovered.runs[0].finish('Authenticated');
  assert.equal((await manager.wait([startup.id]))[0].output, 'Authenticated');
  assert.equal(attempts, 2);
});

void test('abort waits for queued automatic cleanup to dispose its initialized worker', async t => {
  const manager = new AgentOrchestrator(2);
  const busy = controlledWorker();
  const controlled = controlledWorker();
  const cleanup = deferred<void>();
  t.after(() => {
    cleanup.resolve();
    return manager.close();
  });
  manager.spawn(spec, async () => busy.worker);
  const {id} = manager.spawn({...spec, autoCleanup: true}, async () => ({
    ...controlled.worker,
    async dispose() {
      await controlled.worker.dispose();
      await cleanup.promise;
    },
  }));
  await until(() => busy.runs.length === 1);
  await manager.send(id, 'Initialize before a slot opens');
  let stopped = false;
  const stopping = manager.abort(id).then(() => {
    stopped = true;
  });
  await until(() => controlled.disposed === 1);
  await nextTick();
  assert.equal(stopped, false);
  cleanup.resolve();
  await stopping;
  assert.equal(manager.get(id).resumable, false);
  assert.equal(controlled.runs.length, 0);
});

void test('nested waits yield a single worker slot to children and restore it before starting queued work', async t => {
  const manager = new AgentOrchestrator(2);
  t.after(() => {
    parentFinish.resolve();
    return manager.close();
  });
  const child = controlledWorker();
  const sibling = controlledWorker();
  const parentFinish = deferred<void>();
  let childId = '';
  let returned = false;
  const parent = manager.spawn(spec, async id => ({
    async steer() {
      return true;
    },
    async run(_message, signal) {
      childId = manager.spawn(
        {...spec, name: 'Child'},
        async () => child.worker,
      ).id;
      const [record] = await manager.wait([childId], {
        callerId: id,
        signal,
        timeoutMs: 1000,
      });
      assert.equal(record.output, 'Child output');
      returned = true;
      await parentFinish.promise;
      return 'Parent output';
    },
    dispose() {},
  }));
  await until(() => child.runs.length === 1);
  const queued = manager.spawn(
    {...spec, name: 'Sibling'},
    async () => sibling.worker,
  );
  await assert.rejects(
    manager.wait([parent.id], {callerId: parent.id}),
    /cannot wait for itself/,
  );
  child.runs[0].finish('Child output');
  await until(() => returned);
  assert.equal(sibling.runs.length, 0);
  assert.equal(manager.get(parent.id).status, 'running');
  parentFinish.resolve();
  await until(() => sibling.runs.length === 1);
  sibling.runs[0].finish('Sibling output');
  assert.deepEqual(
    (await manager.wait([parent.id, queued.id])).map(record => record.output),
    ['Parent output', 'Sibling output'],
  );
});

void test('waiting agents reacquire slots after a wait timeout without exceeding concurrency', async t => {
  const manager = new AgentOrchestrator(2);
  t.after(() => manager.close());
  const child = controlledWorker();
  const sibling = controlledWorker();
  let timedOut = false;
  const parent = manager.spawn(spec, async id => ({
    async steer() {
      return true;
    },
    async run() {
      const childId = manager.spawn(spec, async () => child.worker).id;
      const [record] = await manager.wait([childId], {
        callerId: id,
        timeoutMs: 10,
      });
      assert.equal(record.status, 'completed');
      timedOut = true;
      return 'Parent resumed';
    },
    dispose() {},
  }));
  await until(() => child.runs.length === 1);
  const queued = manager.spawn(spec, async () => sibling.worker);
  await delay(30);
  assert.equal(
    timedOut,
    false,
    'A timed out wait still reacquires its slot before returning',
  );
  assert.equal(sibling.runs.length, 0);
  child.runs[0].finish('Child result');
  await until(() => sibling.runs.length === 1);
  assert.equal(timedOut, true);
  sibling.runs[0].finish('Sibling result');
  await manager.wait([parent.id, queued.id]);
});

void test('cancelling a waiting agent releases no extra slots and leaves its children running', async t => {
  const manager = new AgentOrchestrator(2);
  t.after(() => manager.close());
  const child = controlledWorker();
  const next = controlledWorker();
  const parent = manager.spawn(spec, async id => ({
    async steer() {
      return true;
    },
    async run() {
      const childId = manager.spawn(spec, async () => child.worker).id;
      await manager.wait([childId], {callerId: id, timeoutMs: 1000});
      return 'Should not return';
    },
    dispose() {},
  }));
  await until(() => child.runs.length === 1);
  const queued = manager.spawn(spec, async () => next.worker);
  await manager.abort(parent.id);
  assert.equal(manager.get(parent.id).status, 'cancelled');
  assert.equal(child.runs[0].signal.aborted, false);
  assert.equal(next.runs.length, 0);
  child.runs[0].finish('Child continued');
  await until(() => next.runs.length === 1);
  next.runs[0].finish('Next result');
  await manager.wait([queued.id]);
});

void test('a limit of one reserves the only slot for the main conversation and rejects background work', async t => {
  const manager = new AgentOrchestrator(1);
  t.after(() => manager.close());
  let created = 0;
  const worker = controlledWorker();
  assert.throws(
    () =>
      manager.spawn(spec, async () => {
        created++;
        return worker.worker;
      }),
    /Additional agents are disabled/,
  );
  assert.deepEqual(manager.list(), []);
  assert.equal(created, 0);
  for (const invalid of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(
      () => manager.setMaxConcurrentAgents(invalid),
      /whole number of at least 1/,
    );
  manager.setMaxConcurrentAgents(2);
  const {id} = manager.spawn(spec, async () => worker.worker);
  await until(() => worker.runs.length === 1);
  worker.runs[0].finish('Done');
  await manager.wait([id]);
  manager.setMaxConcurrentAgents(1);
  await assert.rejects(
    manager.send(id, 'More work'),
    /Additional agents are disabled/,
  );
  assert.equal(manager.get(id).status, 'completed');
  assert.equal(worker.runs.length, 1);
});

void test('saved concurrency governs live teams, nested launches, queue draining, and resumed agents', async t => {
  const model = 'openai-codex/gpt-5.6-sol';
  await isolateToolSettings(t, [model]);
  await saveToolSettings('agents', {
    allowedModels: [model],
    maxConcurrentAgents: 2,
  });
  const workers = teamWorkers();
  const parent = agentParent('concurrency-live', workers.create);
  t.after(() => parent.shutdown());
  await parent.emit('before_agent_start');
  assert.match(
    parent.tools.get('agent_spawn')!.description,
    /Maximum 2 concurrent agents including the main conversation \(1 background agent\)/,
  );
  const first = await parent.spawn('First');
  await untilPolicy(
    () => workers.byId.get(first)?.controlled.runs.length === 1,
  );
  const nested = await workers.byId
    .get(first)!
    .execute('agent_spawn', {name: 'Nested', task: 'Nested task'});
  const second = (nested.details as {agents: AgentRecord[]}).agents[0].id;
  assert.equal(
    parent.control.getTeam(parent.ctx).getManager().get(second).status,
    'queued',
  );
  assert.equal(workers.created.length, 1);
  // Raising the saved limit starts queued work without another tool call.
  await saveToolSettings('agents', {
    allowedModels: [model],
    maxConcurrentAgents: 3,
  });
  await untilPolicy(
    () => workers.byId.get(second)?.controlled.runs.length === 1,
  );
  const third = await parent.spawn('Third');
  await saveToolSettings('agents', {
    allowedModels: [model],
    maxConcurrentAgents: 1,
  });
  await parent.emit('turn_end');
  assert.match(
    parent.tools.get('agent_spawn')!.description,
    /Additional agents are disabled/,
  );
  await assert.rejects(
    parent.spawn('Blocked'),
    /Additional agents are disabled/,
  );
  await assert.rejects(
    workers.byId
      .get(first)!
      .execute('agent_spawn', {task: 'Blocked nested task'}),
    /Additional agents are disabled/,
  );
  workers.byId.get(first)!.controlled.runs[0].finish('First finished');
  workers.byId.get(second)!.controlled.runs[0].finish('Second finished');
  await parent.execute('agent_wait', {ids: [first, second]});
  const manager = parent.control.getTeam(parent.ctx).getManager();
  assert.equal(manager.get(third).status, 'queued');
  assert.equal(workers.created.length, 2);
  await assert.rejects(
    parent.execute('agent_send', {id: first, message: 'Resume disabled'}),
    /Additional agents are disabled/,
  );
  await saveToolSettings('agents', {
    allowedModels: [model],
    maxConcurrentAgents: 2,
  });
  await untilPolicy(
    () => workers.byId.get(third)?.controlled.runs.length === 1,
  );
  await parent.execute('agent_send', {id: first, message: 'Resume queued'});
  assert.equal(manager.get(first).status, 'queued');
  workers.byId.get(third)!.controlled.runs[0].finish('Third finished');
  await untilPolicy(
    () => workers.byId.get(first)!.controlled.runs.length === 2,
  );
  workers.byId.get(first)!.controlled.runs[1].finish('Resumed');
  await parent.execute('agent_wait', {ids: [first, second, third]});
});

void test('switching to main only lets a running nested waiter finish while queued and completed agents stay stopped', async t => {
  const manager = new AgentOrchestrator(2);
  t.after(() => manager.close());
  const child = controlledWorker();
  const queued = controlledWorker();
  let childId: string | undefined;
  let queuedId: string | undefined;
  let queuedCreated = 0;
  let continued = false;
  const parent = manager.spawn({...spec, name: 'Parent worker'}, async id => ({
    async run(_task, signal) {
      childId = manager.spawn(
        {...spec, name: 'Child worker'},
        async () => child.worker,
      ).id;
      queuedId = manager.spawn({...spec, name: 'Queued worker'}, async () => {
        queuedCreated++;
        return queued.worker;
      }).id;
      const [result] = await manager.wait([childId], {
        callerId: id,
        timeoutMs: 1000,
      });
      signal.throwIfAborted();
      assert.equal(result.output, 'Child finished');
      continued = true;
      return 'Parent finished after child';
    },
    async steer() {
      return true;
    },
    dispose() {},
  }));
  await until(() => child.runs.length === 1);
  assert.equal(manager.get(parent.id).status, 'running');
  assert.equal(manager.get(queuedId!).status, 'queued');
  manager.setMaxConcurrentAgents(1);
  child.runs[0].finish('Child finished');
  const results = await manager.wait([parent.id, childId!], {timeoutMs: 1000});
  assert.equal(
    continued,
    true,
    'The active parent returns from its nested wait',
  );
  assert.deepEqual(
    results.map(result => result.status),
    ['completed', 'completed'],
  );
  assert.equal(results[0].output, 'Parent finished after child');
  assert.equal(manager.get(queuedId!).status, 'queued');
  assert.equal(queuedCreated, 0);
  assert.equal(queued.runs.length, 0);
  await assert.rejects(
    manager.send(childId!, 'Resume child'),
    /Additional agents are disabled/,
  );
  assert.throws(
    () => manager.spawn(spec, async () => queued.worker),
    /Additional agents are disabled/,
  );
});
