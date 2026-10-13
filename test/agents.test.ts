import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as nextTick} from 'node:timers/promises';
import {test} from 'node:test';
import {Check} from 'typebox/value';
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  AgentOrchestrator,
  type AgentRecord,
  type AgentSpec,
  type AgentWorker,
} from '../src/agents/orchestrator.ts';
import {
  sessionWorker,
  type createSessionWorker,
} from '../src/agents/session.ts';
import {registerAgentTools} from '../src/tools/agents.ts';

type AgentEventHandler = (
  event: {reason?: string},
  ctx: ExtensionContext,
) => Promise<void> | void;

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
  }> = [];
  let disposed = 0;
  const worker: AgentWorker = {
    sessionFile: `${directory}/transcript.jsonl`,
    resultFile: `${directory}/result.txt`,
    async run(message, signal, onActivity) {
      const result = deferred<string>();
      const abort = () => result.reject(signal.reason);
      if (cooperative) signal.addEventListener('abort', abort, {once: true});
      runs.push({message, signal, finish: result.resolve});
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
    get disposed() {
      return disposed;
    },
  };
}

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await nextTick();
  }
  assert.fail('Expected state was not reached');
}

void test('agents respect concurrency, drain their queue, and skip cancelled work', async t => {
  const manager = new AgentOrchestrator(2);
  t.after(() => manager.close());
  const workers = Array.from({length: 4}, () => controlledWorker());
  let created = 0;
  const records = workers.map(({worker}) =>
    manager.spawn(spec, async () => {
      created++;
      return worker;
    }),
  );
  await until(() => workers[1].runs.length === 1);
  assert.equal(created, 2);
  assert.equal(manager.get(records[2].id).status, 'queued');
  manager.cancel(records[3].id);
  workers[0].runs[0].finish('first result');
  await until(() => workers[2].runs.length === 1);
  assert.equal(created, 3);
  workers[1].runs[0].finish('second result');
  workers[2].runs[0].finish('third result');
  const results = await manager.wait(records.map(record => record.id));
  assert.deepEqual(
    results.map(result => result.status),
    ['completed', 'completed', 'completed', 'cancelled'],
  );
  assert.deepEqual(
    results.slice(0, 3).map(result => result.output),
    ['first result', 'second result', 'third result'],
  );
  assert.equal(workers[3].runs.length, 0);
});

void test('follow-up messages are ordered and completed agents retain their conversation', async t => {
  const manager = new AgentOrchestrator(1);
  t.after(() => manager.close());
  const controlled = controlledWorker();
  let created = 0;
  const {id} = manager.spawn(spec, async () => {
    created++;
    return controlled.worker;
  });
  manager.send(id, 'Then inspect tests');
  await until(() => controlled.runs.length === 1);
  manager.send(id, 'Then report findings');
  assert.equal(manager.get(id).pendingMessages, 2);
  controlled.runs[0].finish('initial');
  await until(() => controlled.runs.length === 2);
  controlled.runs[1].finish('tests');
  await until(() => controlled.runs.length === 3);
  controlled.runs[2].finish('findings');
  await manager.wait([id]);
  manager.send(id, 'Apply the fix');
  assert.equal(manager.get(id).output, undefined);
  await until(() => controlled.runs.length === 4);
  controlled.runs[3].finish('fixed');
  const [result] = await manager.wait([id]);
  assert.equal(result.output, 'fixed');
  assert.equal(created, 1);
  assert.equal(controlled.disposed, 0);
  assert.deepEqual(
    controlled.runs.map(run => run.message),
    [spec.task, 'Then inspect tests', 'Then report findings', 'Apply the fix'],
  );
});

void test('queue supersession at capacity preserves unrelated work and records delivery', async t => {
  const manager = new AgentOrchestrator(1);
  t.after(() => manager.close());
  const controlled = controlledWorker();
  const {id} = manager.spawn(spec, async () => controlled.worker);
  await until(() => controlled.runs.length === 1);
  const initial = manager.listMessages(id, {view: 'history'}).messages[0];
  assert.equal(initial.state, 'delivered');
  assert.ok(initial.deliveredAt);
  const pending = Array.from(
    {length: 32},
    (_, index) => manager.send(id, `Instruction ${index}`).message!,
  );
  assert.throws(() => manager.send(id, 'Overflow'), /32 pending messages/);
  const sender = {kind: 'agent' as const, id: 'reviewer', name: 'Reviewer'};
  const result = manager.send(id, 'Consolidated review', {
    sender,
    reference: 'src/main.ts',
    supersedes: [pending[3].id, pending[1].id],
  });
  assert.equal(result.outcome, 'superseded');
  assert.equal(result.agent.pendingMessages, 31);
  assert.deepEqual(
    result.affected.map(message => message.replacedBy),
    [result.message!.id, result.message!.id],
  );
  assert.equal(controlled.runs[0].signal.aborted, false);
  assert.equal(controlled.disposed, 0);
  const page = manager.listMessages(id, {limit: 3});
  assert.equal(page.total, 31);
  assert.equal(page.nextOffset, 3);
  assert.deepEqual(
    page.messages.map(message => message.message),
    ['Instruction 0', 'Consolidated review', 'Instruction 2'],
  );
  assert.equal(
    manager.listMessages(id, {offset: 3, limit: 1}).messages[0].id,
    pending[4].id,
  );
  sender.name = 'Changed outside';
  page.messages[1].sender.name = 'Changed snapshot';
  assert.deepEqual(manager.getMessage(id, result.message!.id).sender, {
    kind: 'agent',
    id: 'reviewer',
    name: 'Reviewer',
  });
  assert.equal(
    manager.getMessage(id, result.message!.id).reference,
    'src/main.ts',
  );
  assert.ok(Date.parse(result.message!.createdAt));
  controlled.runs[0].finish('initial done');
  await until(() => controlled.runs.length === 2);
  controlled.runs[1].finish('instruction 0 done');
  await until(() => controlled.runs.length === 3);
  assert.equal(
    controlled.runs[2].message,
    'Message from agent "Reviewer" (reviewer):\nConsolidated review',
  );
  assert.equal(manager.getMessage(id, result.message!.id).state, 'delivered');
  assert.equal(manager.getMessage(id, pending[1].id).state, 'superseded');
  manager.cancel(id);
  assert.equal(manager.getMessage(id, pending[2].id).state, 'discarded');
});

void test('stale message edits are atomic and removal leaves the active conversation running', async t => {
  const manager = new AgentOrchestrator(1);
  t.after(() => manager.close());
  const controlled = controlledWorker();
  const {id} = manager.spawn(spec, async () => controlled.worker);
  await until(() => controlled.runs.length === 1);
  const first = manager.send(id, 'First follow-up').message!;
  const second = manager.send(id, 'Second follow-up').message!;
  controlled.runs[0].finish('done');
  await until(() => controlled.runs.length === 2);
  const stale = manager.send(id, 'Obsolete replacement', {
    supersedes: [first.id, second.id],
  });
  assert.equal(stale.outcome, 'not_pending');
  assert.equal(stale.message, undefined);
  assert.deepEqual(
    stale.affected.map(message => message.state),
    ['delivered', 'pending'],
  );
  assert.equal(
    manager.removeMessages(id, [first.id, second.id]).outcome,
    'not_pending',
  );
  assert.throws(
    () => manager.removeMessages(id, [second.id, 'missing']),
    /Unknown agent message/,
  );
  assert.throws(
    () => manager.send(id, 'Replacement', {supersedes: [second.id, second.id]}),
    /unique message IDs/,
  );
  assert.equal(manager.get(id).pendingMessages, 1);
  assert.equal(manager.removeMessages(id, [second.id]).outcome, 'removed');
  assert.equal(manager.removeMessages(id, [second.id]).outcome, 'not_pending');
  assert.equal(controlled.runs[1].signal.aborted, false);
  controlled.runs[1].finish('finished');
  await manager.wait([id]);
  assert.equal(controlled.runs.length, 2);
  manager.send(id, 'New work');
  await until(() => controlled.runs.length === 3);
  assert.equal(controlled.disposed, 0);
});

void test('removing initial instructions during startup or while queued never delivers an empty prompt', async t => {
  const manager = new AgentOrchestrator(1);
  const starting = deferred<AgentWorker>();
  const controlled = controlledWorker();
  let queuedCreated = false;
  const active = manager.spawn(spec, () => starting.promise);
  const queued = manager.spawn(spec, async () => {
    queuedCreated = true;
    return controlled.worker;
  });
  t.after(() => manager.close());
  await nextTick();
  for (const {id} of [active, queued]) {
    manager.removeMessages(id, [manager.listMessages(id).messages[0].id]);
  }
  starting.resolve(controlled.worker);
  const results = await manager.wait([active.id, queued.id]);
  assert.deepEqual(
    results.map(result => result.status),
    ['completed', 'completed'],
  );
  assert.equal(queuedCreated, false);
  assert.equal(controlled.runs.length, 0);
  manager.send(active.id, 'Resume startup');
  await until(() => controlled.runs.length === 1);
  assert.equal(controlled.runs[0].message, 'Resume startup');
});

for (const action of ['cancel', 'timeout'] as const) {
  void test(`${action} discards pending messages and waits for active tools to stop`, async t => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const manager = new AgentOrchestrator(1);
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
    manager.send(id, 'Discard this message');
    if (action === 'cancel') manager.cancel(id);
    else t.mock.timers.tick(40);
    assert.equal(manager.get(id).pendingMessages, 0);
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
    assert.equal(first.disposed, 1);
    other.runs[0].finish('done');
    await manager.wait([queued.id]);
  });
}

void test('timeouts exclude queue time and reset when completed agents resume', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const manager = new AgentOrchestrator(1);
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
  manager.send(id, 'Resume the conversation');
  await until(() => controlled.runs.length === 2);
  t.mock.timers.tick(99);
  assert.equal(controlled.runs[1].signal.aborted, false);
  t.mock.timers.tick(1);
  const [result] = await manager.wait([id]);
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /Timed out after 100 milliseconds/);
  assert.equal(created, 1);
  assert.equal(controlled.disposed, 1);
});

void test('cancellation retains the worker slot until active work has stopped', async t => {
  const manager = new AgentOrchestrator(1);
  const first = controlledWorker(false);
  const second = controlledWorker();
  t.after(() => manager.close());
  const a = manager.spawn(spec, async () => first.worker);
  const b = manager.spawn(spec, async () => second.worker);
  await until(() => first.runs.length === 1);
  manager.send(a.id, 'Discard this follow-up');
  assert.equal(manager.cancel(a.id).status, 'cancelling');
  assert.equal(first.runs[0].signal.aborted, true);
  await nextTick();
  assert.equal(second.runs.length, 0);
  first.runs[0].finish('late output');
  await until(() => second.runs.length === 1);
  assert.equal(manager.get(a.id).status, 'cancelled');
  assert.equal(manager.get(a.id).output, undefined);
  assert.equal(manager.get(a.id).pendingMessages, 0);
  assert.equal(first.disposed, 1);
  second.runs[0].finish('done');
  await manager.wait([b.id]);
});

void test('startup failures and timeouts release slots and preserve errors', async t => {
  const manager = new AgentOrchestrator(1);
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
  assert.match(results[1].error ?? '', /Timed out after 20 milliseconds/);
  assert.match(results[1].activity, /Timed out after 20 milliseconds/);
  assert.equal(slow.disposed, 1);
  assert.throws(
    () => manager.send(timed.id, 'retry'),
    /Cannot message a failed/,
  );
});

void test('wait supports any, all, polling, and interruption without cancelling agents', async t => {
  const manager = new AgentOrchestrator(2);
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
  const manager = new AgentOrchestrator(1);
  const initializing = deferred<AgentWorker>();
  const controlled = controlledWorker();
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
  initializing.resolve(controlled.worker);
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
  assert.match(result.output!, /Read resultFile/);
  assert.equal(result.resultFile, '/result.txt');
  await manager.close();
  assert.equal(controlled.disposed, 1);
});

function fakeSession() {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const messages: AgentSession['messages'] = [];
  let disposed = 0;
  let aborts = 0;
  const session = {
    messages,
    sessionManager: {getSessionFile: () => '/saved/session.jsonl'},
    subscribe(listener: (event: AgentSessionEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: (async () => {}) as AgentSession['prompt'],
    abort: async () => {
      aborts++;
    },
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
    listeners,
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
  const activities: string[] = [];
  fake.session.prompt = async (message, options) => {
    assert.equal(message, 'Do the work');
    assert.deepEqual(options, {expandPromptTemplates: false});
    fake.emit({
      type: 'tool_execution_start',
      toolName: 'read',
      toolCallId: 'call',
      args: {path: 'file'},
    });
    fake.session.messages.push(assistant('intermediate'));
    fake.session.messages.push(assistant('complete answer'));
  };
  assert.equal(
    await worker.run('Do the work', new AbortController().signal, activity =>
      activities.push(activity),
    ),
    'complete answer',
  );
  assert.equal(await readFile(resultFile, 'utf8'), 'complete answer');
  assert.deepEqual(activities, ['Using read']);
  assert.equal(fake.listeners.size, 0);
  fake.session.prompt = async () => {
    fake.session.messages.push(assistant('', 'error', 'Provider failed'));
  };
  await assert.rejects(
    worker.run('retry', new AbortController().signal, () => {}),
    /Provider failed/,
  );
  assert.equal(fake.listeners.size, 0);
  fake.session.prompt = async () => {
    fake.session.messages.push(assistant('Incomplete response', 'length'));
  };
  await assert.rejects(
    worker.run('summarize', new AbortController().signal, () => {}),
    /Agent length/,
  );
  assert.equal(await readFile(resultFile, 'utf8'), 'complete answer');
  assert.equal(fake.listeners.size, 0);
  worker.dispose();
  assert.equal(fake.disposed, 1);
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
    fake.session.messages.push(assistant('', 'aborted'));
  };
  const running = worker.run('task', controller.signal, () => {});
  controller.abort(new Error('Cancelled during setup'));
  assert.equal(fake.aborts, 1);
  preflight.resolve();
  await assert.rejects(running, /Cancelled during setup/);
  assert.equal(fake.aborts, 2);
  assert.equal(fake.listeners.size, 0);
});

void test('agent tools select registered models and effort without adding parent prompts', async t => {
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
  const fallbackModel = registeredModels[1];
  let parentModel: (typeof registeredModels)[number] | undefined;
  let modelsAvailable = true;
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    ui: {notify: (message: string) => notices.push(message)},
    isIdle: () => true,
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
  const execute = (name: string, params: Record<string, unknown>) =>
    tools.get(name)!.execute('call', params, undefined, undefined, ctx);
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
  try {
    const spawned = await execute('agent_spawn', {
      name: 'Review',
      task: 'Review code',
    });
    const id = (spawned.details as {agents: Array<{id: string}>}).agents[0].id;
    await until(() => controlled.runs.length === 1);
    t.mock.timers.tick(3600001);
    await nextTick();
    assert.equal(controlled.runs[0].signal.aborted, false);
    const {agentToolsExtension, ...workerOptions} = optionsSeen[0];
    assert.equal(typeof agentToolsExtension, 'function');
    assert.deepEqual(workerOptions, {
      cwd: ctx.cwd,
      name: 'Review',
      instructions: undefined,
      model: fallbackModel,
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
    assert.match(spawnDescription, /any model from the parent model registry/);
    assert.match(spawnDescription, /Maximum thinkingLevel: xhigh/);
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
        thinkingLevel: 'max',
      }),
      /thinkingLevel must be off, minimal, low, medium, high, or xhigh/,
    );
    inheritedEffort = 'max';
    await assert.rejects(
      execute('agent_spawn', {name: 'bad inherited effort', task: 'test'}),
      /thinkingLevel must be off, minimal, low, medium, high, or xhigh/,
    );
    inheritedEffort = 'high';
    modelsAvailable = false;
    await assert.rejects(
      execute('agent_spawn', {name: 'missing fallback', task: 'test'}),
      /model is unavailable: openai-codex\/gpt-5\.6-sol/,
    );
    modelsAvailable = true;

    const routine = await execute('agent_spawn', {
      name: 'Routine checks',
      task: 'Run the required checks and report results.',
      model: 'openai-codex/gpt-5.6-sol',
      thinkingLevel: 'xhigh',
      autoCleanup: true,
    });
    const routineId = (routine.details as {agents: AgentRecord[]}).agents[0].id;
    await until(() => controlled.runs.length === 3);
    assert.equal(optionsSeen.at(-1)!.model, fallbackModel);
    assert.equal(optionsSeen.at(-1)!.thinkingLevel, 'xhigh');
    controlled.runs[2].finish('Checks passed');
    const cleaned = await execute('agent_wait', {ids: [routineId]});
    assert.match(JSON.stringify(cleaned.content), /Checks passed/);
    assert.equal(controlled.disposed, 2);
    assert.equal(notifications.length, 0);

    for (const model of registeredModels) {
      const fullName = `${model.provider}/${model.id}`;
      for (const inherit of [false, true]) {
        parentModel = inherit ? model : fallbackModel;
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
    model,
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === model.provider && id === model.id ? model : undefined,
    },
    sessionManager: {getSessionId: () => 'parent-session'},
  } as unknown as ExtensionContext;
  const execute = (
    source: Map<string, ToolDefinition>,
    name: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => source.get(name)!.execute('call', params, signal, undefined, ctx);
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
  assert.deepEqual(
    [...sender.tools.keys()],
    ['agent_list', 'agent_send', 'agent_messages', 'agent_message_remove'],
  );
  const listed = await execute(sender.tools, 'agent_list', {});
  const listing = listed.details as {selfId: string; agents: AgentRecord[]};
  assert.equal(listing.selfId, sender.id);
  assert.deepEqual(
    listing.agents.map(agent => agent.id),
    [sender.id, receiver.id],
  );

  const send = (id: string, message: string, signal?: AbortSignal) =>
    execute(sender.tools, 'agent_send', {id, message}, signal);
  const sent = await send(receiver.id, 'Use a 32-pixel grid.');
  const sentMessage = (sent.details as {message: {id: string; sender: unknown}})
    .message;
  assert.deepEqual(sentMessage.sender, {
    kind: 'agent',
    id: sender.id,
    name: 'Designer',
  });
  const listingResult = await execute(tools, 'agent_messages', {
    id: receiver.id,
  });
  const queue = listingResult.details as {
    messages: Array<{id: string; preview: string; state: string}>;
  };
  assert.deepEqual(
    queue.messages.map(message => message.id),
    [sentMessage.id],
  );
  assert.equal(queue.messages[0].state, 'pending');
  const full = await execute(sender.tools, 'agent_messages', {
    id: receiver.id,
    messageId: sentMessage.id,
  });
  assert.equal(
    (full.details as {message: {message: string}}).message.message,
    'Use a 32-pixel grid.',
  );
  assert.equal(receiver.controlled.runs.length, 1);
  receiver.controlled.runs[0].finish('Initial work');
  await until(() => receiver.controlled.runs.length === 2);
  assert.equal(
    receiver.controlled.runs[1].message,
    `Message from agent "Designer" (${sender.id}):\nUse a 32-pixel grid.`,
  );
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
  for (let i = 0; i < 32; i++) await send(receiver.id, `Update ${i}`);
  await assert.rejects(send(receiver.id, 'Overflow'), /32 pending messages/);
  const pageResult = await execute(tools, 'agent_messages', {
    id: receiver.id,
    limit: 2,
  });
  const page = pageResult.details as {
    messages: Array<{id: string}>;
    total: number;
    nextOffset: number;
  };
  assert.equal(page.messages.length, 2);
  assert.equal(page.total, 32);
  assert.equal(page.nextOffset, 2);
  const replacement = await execute(tools, 'agent_send', {
    id: receiver.id,
    message: 'x'.repeat(2000),
    reference: 'Build #4',
    supersedes: page.messages.map(message => message.id),
  });
  const replaced = replacement.details as {
    outcome: string;
    message: {id: string; preview: string; length: number; sender: unknown};
  };
  assert.equal(replaced.outcome, 'superseded');
  assert.equal(replaced.message.preview.length, 500);
  assert.equal(replaced.message.length, 2000);
  assert.deepEqual(replaced.message.sender, {
    kind: 'parent',
    id: 'parent-session',
  });
  const removed = await execute(tools, 'agent_message_remove', {
    id: receiver.id,
    messageIds: [replaced.message.id],
  });
  assert.equal((removed.details as {outcome: string}).outcome, 'removed');
  const readRemoved = await execute(tools, 'agent_messages', {
    id: receiver.id,
    messageId: replaced.message.id,
  });
  assert.equal(
    (readRemoved.details as {message: {message: string; state: string}}).message
      .message.length,
    2000,
  );
  assert.equal(
    (readRemoved.details as {message: {state: string}}).message.state,
    'removed',
  );
  await execute(tools, 'agent_cancel', {id: receiver.id});
  await assert.rejects(
    send(receiver.id, 'Too late'),
    /Cannot message a cancel/,
  );
  await execute(tools, 'agent_wait', {ids: [receiver.id]});
  assert.equal(receiver.controlled.runs.length, 2);
  await assert.rejects(
    send(receiver.id, 'Too late'),
    /Cannot message a cancelled/,
  );
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
    /Unknown parent inbox message/,
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
    cwd: process.cwd(),
    hasUI: true,
    ui: {setStatus: (_key: string, status?: string) => statuses.push(status)},
    isIdle: () => idle,
    model,
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === model.provider && id === model.id ? model : undefined,
    },
    sessionManager: {getSessionId: () => sessionId},
  } as unknown as ExtensionContext;
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
      .execute('call', params, undefined, undefined, ctx);
    return {...result, details: result.details as {agents: AgentRecord[]}};
  };
  return {
    pi,
    ctx,
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
      registerTool(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
    } as unknown as ExtensionAPI);
    const worker = {
      options,
      controlled: controlledWorker(true, `/worker/${created.length}`),
      execute: (name: string, params: Record<string, unknown> = {}) =>
        tools.get(name)!.execute('call', params, undefined, undefined, {
          sessionManager: {getSessionId: () => options.id},
        } as unknown as ExtensionContext),
    };
    created.push(worker);
    byId.set(options.id, worker);
    return worker.controlled.worker;
  };
  return {created, byId, create};
}

void test('parent activity and interruption never turn inbox messages into prompts', async t => {
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
  for (const reason of ['quit', 'reload', 'new', 'resume', 'fork']) {
    const workers = teamWorkers();
    const parent = agentParent(`ordinary-${reason}`, workers.create);
    t.after(() => parent.shutdown());
    for (let i = 0; i < 5; i++) await parent.spawn(`Worker ${i}`);
    await until(
      () =>
        workers.created.length === 4 &&
        workers.created.every(w => w.controlled.runs.length === 1),
    );
    await parent.shutdown(reason);
    assert.equal(workers.created.length, 4);
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

void test('automatic cleanup waits for queued work, disposes once, and keeps the final result', async t => {
  const manager = new AgentOrchestrator(1);
  t.after(() => manager.close());
  const controlled = controlledWorker();
  const {id} = manager.spawn(
    {...spec, autoCleanup: true},
    async () => controlled.worker,
  );
  await until(() => controlled.runs.length === 1);
  manager.send(id, 'Include the final push result');
  controlled.runs[0].finish('Committed');
  await until(() => controlled.runs.length === 2);
  assert.equal(controlled.disposed, 0);
  controlled.runs[1].finish('Committed and pushed');
  const [result] = await manager.wait([id]);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'Committed and pushed');
  assert.equal(result.sessionFile, controlled.worker.sessionFile);
  assert.equal(result.resultFile, controlled.worker.resultFile);
  assert.equal(controlled.disposed, 1);
  assert.throws(() => manager.send(id, 'More work'), /cleaned up/);
  await manager.close();
  assert.equal(controlled.disposed, 1);
});

void test('automatic cleanup waits for cancellation to settle and handles failures', async t => {
  for (const outcome of ['cancelled', 'failed'] as const) {
    await t.test(outcome, async t => {
      const manager = new AgentOrchestrator(1);
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
  const manager = new AgentOrchestrator(1);
  t.after(() => manager.close());
  let disposed = 0;
  for (let index = 0; index < 65; index++) {
    const {id} = manager.spawn({...spec, autoCleanup: true}, async () => ({
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

void test('controller observes activity and inbox with copied state and resets without stale workers', async t => {
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
  await reporter.execute('agent_send', {id: 'parent', message: 'Findings'});
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
  assert.equal(reporter.controlled.disposed, 1);
  await assert.rejects(parent.spawn('During shutdown'), /shutting down/);
  await parent.emit('session_start');
  assert.equal(parent.control.snapshot(), undefined);
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
