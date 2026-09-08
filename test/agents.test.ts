import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as nextTick} from 'node:timers/promises';
import {test} from 'node:test';
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  AgentOrchestrator,
  type AgentSpec,
  type AgentWorker,
} from '../src/agents/orchestrator.ts';
import {sessionWorker} from '../src/agents/session.ts';
import {registerAgentTools} from '../src/tools/agents.ts';

const spec: AgentSpec = {
  name: 'worker',
  task: 'Inspect the project',
  cwd: process.cwd(),
  model: 'test/model',
  timeoutMs: 10000,
  notify: false,
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

function controlledWorker(cooperative = true) {
  const runs: Array<{
    message: string;
    signal: AbortSignal;
    finish: (output: string) => void;
  }> = [];
  let disposed = 0;
  const worker: AgentWorker = {
    sessionFile: '/transcript.jsonl',
    resultFile: '/result.txt',
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
  const timed = manager.spawn(
    {...spec, timeoutMs: 20},
    async () => slow.worker,
  );
  const results = await manager.wait([broken.id, timed.id], {timeoutMs: 1000});
  assert.deepEqual(
    results.map(result => result.status),
    ['failed', 'failed'],
  );
  assert.equal(results[0].error, 'Missing credentials');
  assert.match(results[1].error ?? '', /exceeded 20 ms/);
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

void test('agent tools inherit context, notify on completion, and clean up on session replacement', async () => {
  const tools = new Map<string, ToolDefinition>();
  const events = new Map<string, () => Promise<void> | void>();
  const notifications: unknown[] = [];
  const controlled = controlledWorker();
  const optionsSeen: unknown[] = [];
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: () => Promise<void> | void) {
      events.set(event, handler);
    },
    registerCommand() {},
    getThinkingLevel: () => 'high',
    sendMessage(message: unknown) {
      notifications.push(message);
    },
  } as unknown as ExtensionAPI;
  registerAgentTools(pi, async options => {
    optionsSeen.push(options);
    return controlled.worker;
  });
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    model: {provider: 'test', id: 'parent-model'},
    modelRegistry: {find: () => undefined},
    sessionManager: {getSessionId: () => 'parent-session'},
  } as unknown as ExtensionContext;
  const execute = (name: string, params: Record<string, unknown>) =>
    tools.get(name)!.execute('call', params, undefined, undefined, ctx);
  try {
    const spawned = await execute('agent_spawn', {
      name: 'Review',
      task: 'Review code',
    });
    const id = (spawned.details as {agents: Array<{id: string}>}).agents[0].id;
    await until(() => controlled.runs.length === 1);
    assert.deepEqual(optionsSeen[0], {
      cwd: ctx.cwd,
      name: 'Review',
      instructions: undefined,
      model: ctx.model,
      modelRegistry: ctx.modelRegistry,
      thinkingLevel: 'high',
      parentSessionId: 'parent-session',
      id,
    });
    controlled.runs[0].finish('review result');
    const waited = await execute('agent_wait', {ids: [id]});
    assert.match(JSON.stringify(waited.content), /review result/);
    assert.equal(notifications.length, 1);
    await execute('agent_status', {id});
    assert.equal(notifications.length, 1);
    await execute('agent_send', {id, message: 'Review the fix'});
    await until(() => controlled.runs.length === 2);
    await events.get('session_shutdown')!();
    assert.equal(controlled.runs[1].signal.aborted, true);
    assert.equal(controlled.disposed, 1);
    assert.equal(notifications.length, 1);
    await events.get('session_start')!();
    await assert.rejects(execute('agent_status', {id}), /Unknown agent/);
    const listed = await execute('agent_list', {});
    assert.deepEqual(listed.details, {agents: []});
    await assert.rejects(
      execute('agent_spawn', {
        name: 'bad',
        task: 'test',
        model: 'missing/model',
      }),
      /model is unavailable/,
    );
  } finally {
    await events.get('session_shutdown')!();
  }
});
