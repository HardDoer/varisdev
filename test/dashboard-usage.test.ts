import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from '@earendil-works/pi-coding-agent';
import type {AgentSessionController} from '../src/agents/team.ts';
import {observeDashboardSession} from '../src/dashboard/observe.ts';
import type {DashboardState} from '../src/dashboard/state.ts';

type Handler = (event: never, ctx: ExtensionContext) => unknown;
const epoch = Date.parse('2026-01-01T12:00:00Z');
const text = (value: string) => ({type: 'text', text: value});
const tool = (name: string) => ({
  type: 'toolCall',
  id: `call-${name}`,
  name,
  arguments: {},
});
const assistant = (offset: number, usage?: unknown, extra = {}) => ({
  role: 'assistant',
  timestamp: epoch + offset,
  provider: 'fixture',
  model: 'model-a',
  content: [text('Reply')],
  usage,
  stopReason: 'stop',
  ...extra,
});

function observer() {
  const handlers = new Map<string, Handler[]>();
  let branch: SessionEntry[] = [];
  let state!: DashboardState;
  const ctx = {
    cwd: '/fixture',
    model: {provider: 'fixture', id: 'model-a'},
    isIdle: () => true,
    getContextUsage: () => ({tokens: 450, contextWindow: 1000, percent: 45}),
    sessionManager: {
      getSessionName: () => 'Usage fixture',
      getSessionId: () => 'usage-fixture',
      getSessionFile: () => '/fixture/session.jsonl',
      getHeader: () => undefined,
      getBranch: () => branch,
    },
  } as unknown as ExtensionContext;
  const sessionObserver = observeDashboardSession(
    {
      getThinkingLevel: () => 'off',
      on(name: string, handler: Handler) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
    } as unknown as ExtensionAPI,
    {
      snapshot: () => undefined,
      subscribe: () => () => {},
    } as unknown as AgentSessionController,
    current => {
      state = current;
    },
  );
  return {
    get state() {
      return state;
    },
    async emit(type: string, event: object = {}) {
      for (const handler of handlers.get(type) ?? [])
        await handler({...event, type} as never, ctx);
    },
    restoreUsage() {
      sessionObserver.restoreUsage(ctx);
    },
    append(entry: object) {
      branch.push(entry as SessionEntry);
    },
    history(messages: object[]) {
      branch = messages.map((message, index) => ({
        type: 'message',
        id: `entry-${index}`,
        parentId: index ? `entry-${index - 1}` : null,
        timestamp: new Date(epoch + index).toISOString(),
        message,
      })) as unknown as SessionEntry[];
    },
  };
}

void test('usage counts finalized model calls once and keeps context occupancy and local tools separate', async () => {
  const fixture = observer();
  await fixture.emit('session_start');
  const message = assistant(
    1,
    {
      input: 100,
      output: 20,
      cacheRead: 30,
      cacheWrite: 5,
      totalTokens: 155,
      reasoning: 10,
      cacheWrite1h: 2,
      cost: {
        input: 0.5,
        output: 0.5,
        cacheRead: 0.1,
        cacheWrite: 0.15,
        total: 1.25,
      },
    },
    {content: [text('Call tools'), tool('bash'), tool('read'), tool('bash')]},
  );
  await fixture.emit('message_start', {message});
  await fixture.emit('message_update', {message});
  await fixture.emit('message_update', {message});
  assert.equal(fixture.state.snapshot().usage.calls.length, 0);
  await fixture.emit('message_end', {message});
  const measured = fixture.state.snapshot().usage;
  assert.deepEqual(measured, {
    source: 'provider',
    input: 100,
    output: 20,
    cacheRead: 30,
    cacheWrite: 5,
    totalTokens: 155,
    cost: 1.25,
    truncated: false,
    calls: [
      {
        id: 'message-assistant-1767268800001-1',
        at: new Date(epoch + 1).toISOString(),
        model: 'fixture/model-a',
        input: 100,
        output: 20,
        cacheRead: 30,
        cacheWrite: 5,
        totalTokens: 155,
        cost: 1.25,
        toolNames: ['bash', 'read'],
        stopReason: 'stop',
      },
    ],
  });
  await fixture.emit('message_end', {message});
  await fixture.emit('tool_execution_start', {
    toolCallId: 'call-bash',
    toolName: 'bash',
    args: {command: 'pwd'},
  });
  await fixture.emit('tool_execution_update', {
    toolCallId: 'call-bash',
    toolName: 'bash',
    args: {},
    partialResult: {content: [text('Local output')], usage: {input: 9999}},
  });
  await fixture.emit('tool_execution_end', {
    toolCallId: 'call-bash',
    toolName: 'bash',
    isError: false,
    result: {content: [text('Local output')], usage: {input: 9999}},
  });
  await fixture.emit('message_end', {
    message: {
      role: 'toolResult',
      timestamp: epoch + 2,
      toolCallId: 'call-bash',
      toolName: 'bash',
      isError: false,
      content: [text('Local output')],
      usage: {input: 9999, output: 9999},
    },
  });
  await fixture.emit('message_start', {
    message: {
      role: 'user',
      timestamp: epoch + 3,
      content: 'Long prompt '.repeat(1000),
    },
  });
  assert.deepEqual(fixture.state.snapshot().usage, measured);
  assert.deepEqual(fixture.state.snapshot().session.context, {
    tokens: 450,
    window: 1000,
    percent: 45,
  });
  const next = assistant(
    4,
    {input: 200, output: 40, cacheRead: 50, cacheWrite: 10, totalTokens: 300},
    {model: 'configured-alias', responseModel: 'actual-model'},
  );
  await fixture.emit('message_start', {message: next});
  await fixture.emit('message_end', {message: next});
  const usage = fixture.state.snapshot().usage;
  assert.equal(usage.totalTokens, 455);
  assert.equal(usage.calls[1].model, 'fixture/actual-model');
  assert.equal(usage.calls[1].cost, 0);
  assert.equal(usage.cost, 1.25);
});

void test('restores usage for errors and aborted calls and reconciles same-millisecond completions', async () => {
  const fixture = observer();
  const messages = [
    assistant(
      1,
      {input: 10, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 16},
      {stopReason: 'error', errorMessage: 'Provider failed'},
    ),
    assistant(
      1,
      {input: 4, output: 1, totalTokens: 5, cost: {total: 0}},
      {stopReason: 'aborted', errorMessage: 'Operation aborted'},
    ),
    assistant(2, undefined, {stopReason: 'error'}),
  ];
  fixture.history(messages);
  await fixture.emit('session_start');
  const restored = fixture.state.snapshot().usage;
  assert.equal(restored.calls.length, 2);
  assert.equal(restored.totalTokens, 21);
  assert.equal(new Set(restored.calls.map(call => call.id)).size, 2);
  assert.deepEqual(
    restored.calls.map(call => call.stopReason),
    ['error', 'aborted'],
  );
  for (const message of messages) await fixture.emit('message_end', {message});
  assert.deepEqual(fixture.state.snapshot().usage, restored);
  await fixture.emit('session_tree');
  assert.deepEqual(fixture.state.snapshot().usage, restored);
  await fixture.emit('agent_settled');
  assert.deepEqual(fixture.state.snapshot().usage, restored);
  fixture.history([messages[1]]);
  await fixture.emit('session_tree');
  assert.equal(fixture.state.snapshot().usage.totalTokens, 5);
  assert.equal(fixture.state.snapshot().usage.calls.length, 1);
});

void test('missing numeric usage creates no call and missing costs normalize without inventing rates', async () => {
  const fixture = observer();
  fixture.history([
    assistant(1),
    assistant(2, {}),
    assistant(3, {input: '12'}),
    assistant(4, {cost: {total: 9}}),
    assistant(5, {input: NaN, output: Infinity, cacheRead: -1}),
    assistant(6, {input: 0}),
    assistant(7, {
      input: 3,
      output: 2,
      cacheRead: 1,
      cacheWrite: 4,
      cost: {input: 0.2, output: 0.3, cacheRead: NaN, cacheWrite: -1},
    }),
    assistant(8, {input: 1, cost: {input: 100, total: 0}}),
  ]);
  await fixture.emit('session_start');
  const usage = fixture.state.snapshot().usage;
  assert.equal(usage.calls.length, 3);
  assert.deepEqual(
    usage.calls.map(call => call.totalTokens),
    [0, 10, 1],
  );
  assert.deepEqual(
    usage.calls.map(call => call.cost),
    [0, 0.5, 0],
  );
  assert.equal(usage.totalTokens, 11);
  assert.equal(usage.cost, 0.5);
});

void test('restores persisted cache-warming usage and reconciles live appends without double counting', async () => {
  const fixture = observer();
  const response = assistant(1, {
    input: 10,
    output: 2,
    cacheRead: 3,
    cacheWrite: 1,
    totalTokens: 16,
    cost: {total: 0.25},
  });
  fixture.history([response]);
  const warm = {
    type: 'usage',
    id: 'warm-one',
    parentId: 'entry-0',
    timestamp: new Date(epoch + 2).toISOString(),
    kind: 'cache_warm',
    provider: 'fixture',
    model: 'model-a',
    usage: {
      input: 0,
      output: 1,
      cacheRead: 120,
      cacheWrite: 4,
      totalTokens: 125,
      cost: {cacheRead: 0.12, cacheWrite: 0.04, total: 0.16},
    },
  };
  fixture.append(warm);
  await fixture.emit('session_start');
  const restored = fixture.state.snapshot().usage;
  assert.equal(restored.calls.length, 2);
  assert.equal(restored.totalTokens, 141);
  assert.ok(Math.abs(restored.cost - 0.41) < 1e-12);
  assert.deepEqual(restored.calls[1], {
    id: 'usage-warm-one',
    at: warm.timestamp,
    model: 'fixture/model-a',
    input: 0,
    output: 1,
    cacheRead: 120,
    cacheWrite: 4,
    totalTokens: 125,
    cost: 0.16,
    toolNames: [],
    stopReason: undefined,
    kind: 'usage',
    usageKind: 'cache_warm',
  });

  const other = {
    ...warm,
    id: 'warm-two',
    parentId: 'warm-one',
    timestamp: new Date(epoch + 3).toISOString(),
    kind: 'provider_housekeeping',
    usage: {input: 7, output: 0, totalTokens: 7, cost: {total: 0.02}},
  };
  fixture.append(other);
  // AgentSession exposes cache-warm appends through a session-only event. The
  // desktop parent asks the extension observer to reconcile its canonical branch.
  fixture.restoreUsage();
  const live = fixture.state.snapshot().usage;
  assert.equal(live.calls.length, 3);
  assert.equal(live.totalTokens, 148);
  assert.ok(Math.abs(live.cost - 0.43) < 1e-12);
  assert.equal(live.calls[2].usageKind, 'provider_housekeeping');
  await fixture.emit('agent_settled', {aborted: false});
  await fixture.emit('session_tree');
  assert.deepEqual(fixture.state.snapshot().usage, live);
});

void test('recent usage rows are bounded while all-call totals survive trimming and old repeated completions', async () => {
  const fixture = observer();
  const messages = Array.from({length: 250}, (_, index) =>
    assistant(
      index,
      {
        input: 10,
        output: 2,
        cacheRead: 3,
        cacheWrite: 1,
        totalTokens: 16,
        cost: {total: 0.25},
      },
      {content: [text('Call'), tool('bash')]},
    ),
  );
  fixture.history(messages);
  await fixture.emit('session_start');
  const usage = fixture.state.snapshot().usage;
  assert.equal(usage.calls.length, 100);
  assert.equal(usage.truncated, true);
  assert.equal(usage.input, 2500);
  assert.equal(usage.output, 500);
  assert.equal(usage.cacheRead, 750);
  assert.equal(usage.cacheWrite, 250);
  assert.equal(usage.totalTokens, 4000);
  assert.equal(usage.cost, 62.5);
  assert.equal(usage.calls[0].at, new Date(epoch + 150).toISOString());
  await fixture.emit('message_end', {message: messages[0]});
  assert.deepEqual(fixture.state.snapshot().usage, usage);
  const next = assistant(300, {input: 1, output: 1, totalTokens: 2});
  await fixture.emit('message_start', {message: next});
  await fixture.emit('message_end', {message: next});
  await fixture.emit('message_end', {message: next});
  assert.equal(fixture.state.snapshot().usage.calls.length, 100);
  assert.equal(fixture.state.snapshot().usage.totalTokens, 4002);
  usage.calls[0].input = 9999;
  usage.calls[0].toolNames.push('mutated');
  const fresh = fixture.state.snapshot().usage;
  assert.equal(fresh.calls[0].input, 10);
  assert.deepEqual(fresh.calls[0].toolNames, ['bash']);
  assert.equal(fresh.input, 2501);
});

void test('compaction aggregates restore and reconcile live events alongside future response calls', async () => {
  const fixture = observer();
  const response = assistant(1, {
    input: 10,
    output: 2,
    cacheRead: 3,
    cacheWrite: 1,
    totalTokens: 16,
    cost: {total: 0.25},
  });
  fixture.history([response]);
  fixture.append({
    type: 'model_change',
    id: 'selected-model',
    parentId: 'entry-0',
    timestamp: new Date(epoch + 2).toISOString(),
    provider: 'fixture',
    modelId: 'model-a',
  });
  const summary = {
    type: 'compaction',
    id: 'summary-one',
    parentId: 'selected-model',
    timestamp: new Date(epoch + 3).toISOString(),
    summary: 'Combined summary',
    firstKeptEntryId: 'entry-0',
    tokensBefore: 999,
    usage: {
      input: 100,
      output: 30,
      cacheRead: 40,
      cacheWrite: 10,
      totalTokens: 180,
      cost: {
        input: 0.2,
        output: 0.3,
        cacheRead: 0.01,
        cacheWrite: 0.02,
        total: 0.53,
      },
    },
  };
  fixture.append(summary);
  await fixture.emit('session_start');
  const restored = fixture.state.snapshot().usage;
  assert.equal(restored.totalTokens, 196);
  assert.equal(restored.calls.length, 2);
  assert.deepEqual(restored.calls[1], {
    id: 'compaction-summary-one',
    at: summary.timestamp,
    model: 'fixture/model-a',
    input: 100,
    output: 30,
    cacheRead: 40,
    cacheWrite: 10,
    totalTokens: 180,
    cost: 0.53,
    toolNames: [],
    stopReason: undefined,
    kind: 'compaction',
  });
  await fixture.emit('session_compact', {
    compactionEntry: summary,
    reason: 'manual',
  });
  await fixture.emit('session_compact', {
    compactionEntry: summary,
    reason: 'manual',
  });
  assert.deepEqual(fixture.state.snapshot().usage, restored);
  const automatic = {
    ...summary,
    id: 'summary-two',
    parentId: 'summary-one',
    timestamp: new Date(epoch + 4).toISOString(),
    usage: {output: 4},
  };
  fixture.append(automatic);
  // SDK summary lookup can return the earlier entry when summary texts repeat.
  await fixture.emit('session_compact', {
    compactionEntry: summary,
    reason: 'threshold',
  });
  assert.equal(fixture.state.snapshot().usage.calls[2].input, 0);
  assert.equal(fixture.state.snapshot().usage.calls[2].cost, 0);
  const next = assistant(5, {input: 20, output: 5, totalTokens: 25});
  await fixture.emit('message_start', {message: next});
  await fixture.emit('message_end', {message: next});
  fixture.append({
    type: 'message',
    id: 'next-response',
    parentId: 'summary-two',
    timestamp: new Date(epoch + 5).toISOString(),
    message: next,
  });
  const completed = fixture.state.snapshot().usage;
  assert.equal(completed.calls.length, 4);
  assert.equal(completed.totalTokens, 225);
  assert.ok(Math.abs(completed.cost - 0.78) < 1e-12);
  const unavailable = {
    ...summary,
    id: 'unreported-summary',
    parentId: 'next-response',
    usage: {},
  };
  fixture.append(unavailable);
  await fixture.emit('session_compact', {
    compactionEntry: unavailable,
    reason: 'manual',
  });
  await fixture.emit('session_compact_failed', {
    errorMessage: 'Summary attempt failed',
    aborted: false,
  });
  assert.deepEqual(fixture.state.snapshot().usage, completed);
  await fixture.emit('session_tree');
  assert.deepEqual(fixture.state.snapshot().usage, completed);
  const unknown = observer();
  unknown.append(summary);
  await unknown.emit('session_start');
  assert.equal(unknown.state.snapshot().usage.calls[0].model, 'Compaction');
});
