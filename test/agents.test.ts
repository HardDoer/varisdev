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

void test('an in-task handover replaces the session and preserves follow-up messages', async t => {
  const manager = new AgentOrchestrator(1);
  t.after(() => manager.close());
  const first = controlledWorker(true, '/first');
  const fresh = controlledWorker(true, '/fresh');
  const request = deferred<void>();
  const factories: Array<{id: string; previousSessionFile?: string}> = [];
  const record = manager.spawn(
    {...spec, notify: true},
    async (id, previousSessionFile) => {
      factories.push({id, previousSessionFile});
      if (factories.length > 1) return fresh.worker;
      return {
        ...first.worker,
        async run(message, signal, onActivity) {
          const running = first.worker.run(message, signal, onActivity);
          await request.promise;
          manager.newSession(id, 'The files are reviewed. Apply the fix.');
          return running;
        },
      };
    },
  );
  assert.equal(record.sessionCount, 0);
  const statuses: string[] = [];
  manager.subscribe(() => statuses.push(manager.get(record.id).status));
  manager.send(record.id, 'Then inspect tests');
  await until(() => first.runs.length === 1);
  request.resolve();
  await until(() => fresh.runs.length === 1);
  manager.send(record.id, 'Then report findings');
  assert.equal(first.runs[0].signal.aborted, true);
  assert.equal(first.disposed, 1);
  assert.equal(manager.get(record.id).pendingMessages, 2);
  assert.equal(manager.get(record.id).output, undefined);
  assert.equal(manager.get(record.id).finishedAt, undefined);
  assert.ok(statuses.every(status => status === 'running'));
  assert.deepEqual(factories, [
    {id: record.id, previousSessionFile: undefined},
    {id: record.id, previousSessionFile: '/first/transcript.jsonl'},
  ]);
  assert.equal(
    fresh.runs[0].message,
    'Continue the delegated task in this fresh session.\n\n' +
      'Previous session transcript: /first/transcript.jsonl\n\n' +
      'Handover:\nThe files are reviewed. Apply the fix.',
  );
  fresh.runs[0].finish('fix applied');
  await until(() => fresh.runs.length === 2);
  fresh.runs[1].finish('tests checked');
  await until(() => fresh.runs.length === 3);
  fresh.runs[2].finish('findings');
  const [result] = await manager.wait([record.id]);
  assert.deepEqual(
    fresh.runs.slice(1).map(run => run.message),
    ['Then inspect tests', 'Then report findings'],
  );
  assert.deepEqual(result, {
    ...record,
    status: 'completed',
    activity: 'Completed',
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    sessionCount: 2,
    previousSessionFile: '/first/transcript.jsonl',
    sessionFile: '/fresh/transcript.jsonl',
    resultFile: '/fresh/result.txt',
    pendingMessages: 0,
    output: 'findings',
  });
});

void test('rollover keeps its slot and old worker until uncooperative work stops', async t => {
  const manager = new AgentOrchestrator(1);
  const first = controlledWorker(false);
  const fresh = controlledWorker();
  const other = controlledWorker();
  t.after(() => {
    first.runs[0]?.finish('cleanup');
    return manager.close();
  });
  let created = 0;
  const {id} = manager.spawn(spec, async () =>
    ++created === 1 ? first.worker : fresh.worker,
  );
  const queued = manager.spawn(spec, async () => other.worker);
  await until(() => first.runs.length === 1);
  manager.send(id, 'Follow-up');
  assert.equal(manager.newSession(id, 'Continue here').pendingMessages, 2);
  assert.equal(first.runs[0].signal.aborted, true);
  await nextTick();
  assert.equal(first.disposed, 0);
  assert.equal(created, 1);
  assert.equal(other.runs.length, 0);
  assert.equal(manager.get(id).status, 'running');
  first.runs[0].finish('discard this late output');
  await until(() => fresh.runs.length === 1);
  assert.equal(first.disposed, 1);
  assert.equal(other.runs.length, 0);
  assert.equal(manager.get(id).output, undefined);
  fresh.runs[0].finish('handover done');
  await until(() => fresh.runs.length === 2);
  assert.equal(fresh.runs[1].message, 'Follow-up');
  fresh.runs[1].finish('done');
  await until(() => other.runs.length === 1);
  other.runs[0].finish('other done');
  await manager.wait([id, queued.id]);
});

void test('completed agents can start successive fresh sessions with the same ID', async t => {
  const manager = new AgentOrchestrator(1);
  t.after(() => manager.close());
  const workers = ['/one', '/two', '/three'].map(path =>
    controlledWorker(true, path),
  );
  const previous: Array<string | undefined> = [];
  const {id} = manager.spawn(spec, async (workerId, previousSessionFile) => {
    assert.equal(workerId, id);
    previous.push(previousSessionFile);
    return workers[previous.length - 1].worker;
  });
  for (let i = 0; i < workers.length; i++) {
    if (i > 0) {
      const restarting = manager.newSession(id, `Continue session ${i + 1}`);
      assert.equal(restarting.output, undefined);
      assert.equal(restarting.finishedAt, undefined);
      assert.equal(restarting.pendingMessages, 1);
      assert.equal(restarting.status, 'running');
    }
    await until(() => workers[i].runs.length === 1);
    workers[i].runs[0].finish(`result ${i + 1}`);
    const [result] = await manager.wait([id]);
    assert.equal(result.sessionCount, i + 1);
    assert.equal(result.sessionFile, workers[i].worker.sessionFile);
    assert.equal(result.resultFile, workers[i].worker.resultFile);
    assert.equal(
      result.previousSessionFile,
      workers[i - 1]?.worker.sessionFile,
    );
    assert.equal(result.output, `result ${i + 1}`);
    assert.equal(workers[i].disposed, 0);
    if (i > 0) assert.equal(workers[i - 1].disposed, 1);
  }
  assert.deepEqual(previous, [
    undefined,
    '/one/transcript.jsonl',
    '/two/transcript.jsonl',
  ]);
});

void test('queued handovers run before the preserved initial task and messages', async t => {
  const manager = new AgentOrchestrator(1);
  t.after(() => manager.close());
  const busy = controlledWorker();
  const fresh = controlledWorker();
  const blocker = manager.spawn(spec, async () => busy.worker);
  const {id} = manager.spawn(spec, async (_id, previous) => {
    assert.equal(previous, undefined);
    return fresh.worker;
  });
  manager.send(id, 'Follow-up');
  const queued = manager.newSession(id, 'Start with this context');
  assert.equal(queued.status, 'queued');
  assert.equal(queued.sessionCount, 0);
  assert.equal(queued.pendingMessages, 3);
  assert.throws(() => manager.newSession(id, 'Duplicate'), /pending handover/);
  await until(() => busy.runs.length === 1);
  busy.runs[0].finish('done');
  const expected = [
    'Continue the delegated task in this fresh session.\n\nHandover:\nStart with this context',
    spec.task,
    'Follow-up',
  ];
  for (const [i, message] of expected.entries()) {
    await until(() => fresh.runs.length === i + 1);
    assert.equal(fresh.runs[i].message, message);
    assert.equal(manager.get(id).pendingMessages, expected.length - i - 1);
    fresh.runs[i].finish('done');
  }
  await manager.wait([id, blocker.id]);
  assert.equal(manager.get(id).sessionCount, 1);
});

for (const action of ['cancel', 'timeout'] as const) {
  void test(`${action} overrides a handover while old tools are stopping`, async t => {
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
    manager.newSession(id, 'Discard this handover');
    if (action === 'cancel') manager.cancel(id);
    else t.mock.timers.tick(40);
    assert.equal(manager.get(id).pendingMessages, 0);
    assert.throws(
      () => manager.newSession(id, 'Too late'),
      action === 'cancel' ? /cancelling/ : /Timed out/,
    );
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
    assert.equal(result.sessionCount, 1);
    assert.equal(created, 1);
    assert.equal(first.disposed, 1);
    other.runs[0].finish('done');
    await manager.wait([queued.id]);
  });
}

void test('a fresh timeout starts after tools stop and includes replacement initialization', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const manager = new AgentOrchestrator(1);
  const first = controlledWorker(false);
  const fresh = controlledWorker();
  const initializing = deferred<AgentWorker>();
  t.after(() => {
    first.runs[0]?.finish('cleanup');
    initializing.resolve(fresh.worker);
    return manager.close();
  });
  let created = 0;
  const {id} = manager.spawn({...spec, timeoutMs: 100}, async () =>
    ++created === 1 ? first.worker : initializing.promise,
  );
  await until(() => first.runs.length === 1);
  t.mock.timers.tick(60);
  manager.newSession(id, 'Continue');
  t.mock.timers.tick(30);
  first.runs[0].finish('stopped');
  await until(() => created === 2);
  t.mock.timers.tick(90);
  assert.equal(manager.get(id).status, 'running');
  assert.equal(manager.get(id).sessionCount, 1);
  initializing.resolve(fresh.worker);
  await until(() => fresh.runs.length === 1);
  t.mock.timers.tick(9);
  assert.equal(fresh.runs[0].signal.aborted, false);
  t.mock.timers.tick(1);
  const [result] = await manager.wait([id]);
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /Timed out after 100 milliseconds/);
  assert.equal(result.sessionCount, 2);
  assert.equal(fresh.disposed, 1);
});

void test('replacement startup failures discard pending work and release the slot', async t => {
  const manager = new AgentOrchestrator(1);
  const first = controlledWorker();
  const other = controlledWorker();
  const initializing = deferred<AgentWorker>();
  t.after(() => {
    initializing.resolve(other.worker);
    return manager.close();
  });
  let created = 0;
  const {id} = manager.spawn(spec, async () =>
    ++created === 1 ? first.worker : initializing.promise,
  );
  const queued = manager.spawn(spec, async () => other.worker);
  await until(() => first.runs.length === 1);
  manager.send(id, 'Pending task');
  manager.newSession(id, 'Continue');
  await until(() => created === 2);
  assert.equal(first.disposed, 1);
  assert.equal(manager.get(id).pendingMessages, 2);
  assert.equal(other.runs.length, 0);
  assert.throws(() => manager.newSession(id, 'Duplicate'), /pending handover/);
  initializing.reject(new Error('Replacement failed'));
  await until(() => other.runs.length === 1);
  const result = manager.get(id);
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'Replacement failed');
  assert.equal(result.sessionCount, 1);
  assert.equal(result.previousSessionFile, first.worker.sessionFile);
  assert.equal(result.sessionFile, undefined);
  assert.equal(result.resultFile, undefined);
  assert.equal(result.pendingMessages, 0);
  other.runs[0].finish('done');
  await manager.wait([queued.id]);
});

void test('handover validation rejects invalid text and unavailable agents', async t => {
  const manager = new AgentOrchestrator(1);
  const first = controlledWorker(false);
  t.after(() => {
    first.runs[0]?.finish('cleanup');
    return manager.close();
  });
  const {id} = manager.spawn(spec, async () => first.worker);
  assert.throws(
    () => manager.newSession('missing', 'Context'),
    /Unknown agent/,
  );
  assert.throws(() => manager.newSession(id, ' \n '), /cannot be empty/);
  assert.throws(
    () => manager.newSession(id, 'x'.repeat(64001)),
    /64000 characters/,
  );
  await until(() => first.runs.length === 1);
  assert.equal(manager.newSession(id, 'x'.repeat(64000)).pendingMessages, 1);
  assert.throws(() => manager.newSession(id, 'Duplicate'), /pending handover/);
  manager.cancel(id);
  assert.throws(() => manager.newSession(id, 'Context'), /cancelling agent/);
  first.runs[0].finish('stopped');
  await manager.wait([id]);
  assert.throws(() => manager.newSession(id, 'Context'), /cancelled agent/);
  const failed = manager.spawn(spec, async () => {
    throw new Error('Startup failed');
  });
  await manager.wait([failed.id]);
  assert.throws(() => manager.newSession(failed.id, 'Context'), /failed agent/);
  await manager.close();
  assert.throws(() => manager.newSession(id, 'Context'), /closed/);
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
  const commands = new Map<
    string,
    Parameters<ExtensionAPI['registerCommand']>[1]
  >();
  const notices: string[] = [];
  const controlled = controlledWorker();
  const optionsSeen: Array<Parameters<typeof createSessionWorker>[0]> = [];
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: () => Promise<void> | void) {
      events.set(event, handler);
    },
    registerCommand(
      name: string,
      command: Parameters<ExtensionAPI['registerCommand']>[1],
    ) {
      commands.set(name, command);
    },
    getThinkingLevel: () => 'high',
    sendMessage(message: unknown) {
      notifications.push(message);
    },
  } as unknown as ExtensionAPI;
  registerAgentTools(pi, async options => {
    if (options.name === 'Broken') throw new Error('Missing credentials');
    optionsSeen.push(options);
    return controlled.worker;
  });
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    ui: {notify: (message: string) => notices.push(message)},
    model: {provider: 'test', id: 'parent-model'},
    modelRegistry: {find: () => undefined},
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
    const {agentToolsExtension, ...workerOptions} = optionsSeen[0];
    assert.equal(typeof agentToolsExtension, 'function');
    assert.deepEqual(workerOptions, {
      cwd: ctx.cwd,
      name: 'Review',
      instructions: undefined,
      model: ctx.model,
      modelRegistry: ctx.modelRegistry,
      thinkingLevel: 'high',
      parentSessionId: 'parent-session',
      id,
      previousSessionFile: undefined,
    });
    controlled.runs[0].finish('review result');
    const waited = await execute('agent_wait', {ids: [id]});
    assert.match(JSON.stringify(waited.content), /review result/);
    assert.equal(notifications.length, 1);
    const active = await list();
    assert.deepEqual(active.agents, []);
    assert.equal(active.summary.completed, 1);
    assert.deepEqual(
      (await list('history')).agents.map(agent => agent.id),
      [id],
    );
    await execute('agent_status', {id});
    assert.equal(notifications.length, 1);

    const broken = await execute('agent_spawn', {
      name: 'Broken',
      task: 'Cannot start',
      notify: false,
    });
    const brokenId = (broken.details as {agents: AgentRecord[]}).agents[0].id;
    await execute('agent_wait', {ids: [brokenId]});
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
    await events.get('session_shutdown')!();
    assert.equal(controlled.runs[1].signal.aborted, true);
    assert.equal(controlled.disposed, 1);
    assert.equal(notifications.length, 1);
    await events.get('session_start')!();
    await assert.rejects(execute('agent_status', {id}), /Unknown agent/);
    const listed = await list('all');
    assert.deepEqual(listed.agents, []);
    assert.ok(Object.values(listed.summary).every(count => count === 0));
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

void test('worker messaging identifies senders, validates recipients, and stays in its parent session', async t => {
  const tools = new Map<string, ToolDefinition>();
  const events = new Map<string, () => Promise<void> | void>();
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
    on(event: string, handler: () => Promise<void> | void) {
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
      registerTool(tool: ToolDefinition) {
        workerTools.set(tool.name, tool);
      },
    } as unknown as ExtensionAPI);
    const controlled = controlledWorker();
    workers.set(options.id, {tools: workerTools, controlled});
    return controlled.worker;
  });
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    model: {provider: 'test', id: 'model'},
    modelRegistry: {},
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
      notify: false,
    });
    const id = (result.details as {agents: AgentRecord[]}).agents[0].id;
    await until(() => workers.get(id)?.controlled.runs.length === 1);
    return {id, ...workers.get(id)!};
  };
  t.after(() => events.get('session_shutdown')!());
  const sender = await spawn('Designer');
  const receiver = await spawn('Builder');
  assert.deepEqual(
    [...sender.tools.keys()],
    ['agent_list', 'agent_send', 'agent_new_session'],
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
  await send(receiver.id, 'Use a 32-pixel grid.');
  assert.equal(receiver.controlled.runs.length, 1);
  receiver.controlled.runs[0].finish('Initial work');
  await until(() => receiver.controlled.runs.length === 2);
  assert.equal(
    receiver.controlled.runs[1].message,
    `Message from agent "Designer" (${sender.id}):\nUse a 32-pixel grid.`,
  );
  await send('parent', 'The grid is ready.');
  assert.deepEqual(notifications, [
    {
      message: {
        customType: 'agent_message',
        content: `Message from agent "Designer" (${sender.id}):\nThe grid is ready.`,
        display: true,
        details: {
          from: {id: sender.id, name: 'Designer'},
          message: 'The grid is ready.',
        },
      },
      options: {deliverAs: 'followUp', triggerTurn: true},
    },
  ]);
  await assert.rejects(send(sender.id, 'Loop'), /itself/);
  await assert.rejects(send('missing', 'Unknown'), /Unknown agent/);
  await assert.rejects(send(receiver.id, '   '), /cannot be empty/);
  await assert.rejects(send('parent', '   '), /cannot be empty/);
  await assert.rejects(
    send('parent', 'Aborted', AbortSignal.abort(new Error('Stop sending'))),
    /Stop sending/,
  );
  assert.equal(notifications.length, 1);
  for (let i = 0; i < 32; i++) await send(receiver.id, `Update ${i}`);
  await assert.rejects(send(receiver.id, 'Overflow'), /32 pending messages/);
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
  await execute(tools, 'agent_cancel', {id: sender.id});
  await assert.rejects(
    send('parent', 'After cancellation'),
    /Only running agents/,
  );
  await events.get('session_shutdown')!();
  await events.get('session_start')!();
  await spawn('New session worker');
  await assert.rejects(send('parent', 'Stale sender'), /session has closed/);
  await assert.rejects(
    execute(sender.tools, 'agent_list', {}),
    /session has closed/,
  );
  assert.equal(notifications.length, 1);
});
