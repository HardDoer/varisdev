import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import type {
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  TurnEndEvent,
} from '@earendil-works/pi-coding-agent';
import type {
  createHandoverAgent,
  HandoverAgent,
} from '../src/handover-agent.ts';
import {registerAutoHandover} from '../src/auto-handover.ts';
import type {HandoverSettings} from '../src/handover-settings.ts';
import type {registerSessionHandover} from '../src/session-handover.ts';

type Sessions = ReturnType<typeof registerSessionHandover>;
type Assistant = Extract<TurnEndEvent['message'], {role: 'assistant'}>;
type Handler = (event: object, ctx: ExtensionContext) => unknown;
type Sent = Parameters<ExtensionAPI['sendMessage']>[0];

function answer(
  text = 'Goal: finish review. Plan: tasks.md. Verified: read file. Next: run checks.',
  stopReason: Assistant['stopReason'] = 'stop',
  tools = false,
) {
  return {
    role: 'assistant',
    stopReason,
    content: [
      {type: 'text', text},
      ...(tools
        ? [
            {
              type: 'toolCall',
              id: 'read-1',
              name: 'read',
              arguments: {path: 'tasks.md'},
            },
          ]
        : []),
    ],
  };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'varisdev-auto-handover-'));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(join(cwd, '.pi'), {recursive: true});
  await mkdir(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, {recursive: true, force: true});
  });
  const events = new Map<string, Handler[]>();
  const commands = new Map<
    string,
    Parameters<ExtensionAPI['registerCommand']>[1]
  >();
  const sent: Array<{
    message: Sent;
    options: Parameters<ExtensionAPI['sendMessage']>[1];
  }> = [];
  const entries: Array<{type: 'custom'; customType: string; data: unknown}> =
    [];
  const notices: string[] = [];
  const workingMessages: Array<string | undefined> = [];
  const scheduled: string[] = [];
  const cancelled: string[] = [];
  const toolChanges: unknown[] = [];
  const abort = new AbortController();
  const agents: Array<{disposed: boolean; signal?: AbortSignal}> = [];
  const drafts: Array<{handover: string}> = [];
  let output = 'Summary from the dedicated agent';
  let factory: typeof createHandoverAgent = async () => {
    const state: (typeof agents)[number] = {disposed: false};
    agents.push(state);
    return {
      prompt: 'Read the source conversation',
      worker: {
        async run(prompt, signal) {
          assert.equal(prompt, 'Read the source conversation');
          state.signal = signal;
          return output;
        },
        dispose() {
          state.disposed = true;
        },
      },
    };
  };
  let percent: number | null | undefined = 0;
  let sessionId = 'source';
  let pending = false;
  let outcome = 'scheduled';
  let scheduleError: Error | undefined;
  const ctx = {
    cwd,
    signal: abort.signal,
    getContextUsage: () => (percent === undefined ? undefined : {percent}),
    sessionManager: {
      getBranch: () => entries,
      getSessionFile: () => join(root, `${sessionId}.jsonl`),
      getSessionId: () => sessionId,
    },
    ui: {
      notify: (text: string) => notices.push(text),
      setWorkingMessage: (text?: string) => workingMessages.push(text),
    },
  } as unknown as ExtensionContext;
  const sessions: Sessions = {
    hasPending: () => pending,
    cancelPending(id: string, context: ExtensionContext, reason: string) {
      assert.equal(id, 'change-1');
      assert.equal(context, ctx);
      assert.ok(reason.trim());
      assert.equal(pending, true);
      pending = false;
      cancelled.push(id);
      return true;
    },
    async schedule(handover, context) {
      assert.equal(context, ctx);
      scheduled.push(handover);
      if (scheduleError) throw scheduleError;
      pending = outcome === 'scheduled';
      return {
        content: [],
        details: {
          outcome,
          handover: {
            id: 'change-1',
            state: pending ? 'scheduled' : 'failed',
            handover,
            revision: 1,
            sourceSessionId: sessionId,
            requestedAt: '',
            updatedAt: '',
            pendingReason: 'Dispatch failed',
            canUpdate: pending,
            canCancel: pending,
          },
        },
      };
    },
  };
  const pi = {
    on(name: string, handler: Handler) {
      events.set(name, [...(events.get(name) ?? []), handler]);
    },
    registerCommand(
      name: string,
      command: Parameters<ExtensionAPI['registerCommand']>[1],
    ) {
      commands.set(name, command);
    },
    registerEntryRenderer() {},
    appendEntry(customType: string, data: unknown) {
      entries.push({type: 'custom', customType, data: structuredClone(data)});
      if (customType === 'varisdev_handover_draft')
        drafts.push(data as {handover: string});
    },
    sendMessage(
      message: Sent,
      options: Parameters<ExtensionAPI['sendMessage']>[1],
    ) {
      sent.push({message, options});
    },
    registerTool: (tool: unknown) => toolChanges.push(tool),
    setActiveTools: (tools: unknown) => toolChanges.push(tools),
  } as unknown as ExtensionAPI;
  async function emit(name: string, event: object = {}) {
    const results: unknown[] = [];
    for (const handler of events.get(name) ?? [])
      results.push(await handler(event, ctx));
    return results;
  }
  async function reload() {
    await emit('session_shutdown');
    events.clear();
    commands.clear();
    registerAutoHandover(pi, sessions, (ctx, id) => factory(ctx, id));
    await emit('session_start');
  }
  await reload();
  return {
    sent,
    agents,
    drafts,
    factory: (value: typeof factory) => {
      factory = value;
    },
    entries,
    notices,
    workingMessages,
    scheduled,
    cancelled,
    isPending: () => pending,
    toolChanges,
    abort,
    emit,
    reload,
    async freshSession() {
      entries.length = 0;
      sessionId = 'destination';
      pending = false;
      await emit('session_start');
    },
    usage: (value: typeof percent) => {
      percent = value;
    },
    pending: (value: boolean) => {
      pending = value;
    },
    result: (value: string) => {
      outcome = value;
    },
    error: (value?: Error) => {
      scheduleError = value;
    },
    settings: (value: Partial<HandoverSettings> | string) =>
      writeFile(
        join(cwd, '.pi', 'varisdev.json'),
        typeof value === 'string' ? value : JSON.stringify(value),
      ),
    turn: (message = answer()) => emit('turn_end', {message}),
    complete: (text: string) => {
      output = text;
      return emit('turn_end', {message: answer('Parent paused')});
    },
    deliver: (details = sent.at(-1)!.message.details) =>
      emit('message_start', {
        message: {role: 'custom', ...sent.at(-1)!.message, details},
      }),
    manual: (args = '') =>
      commands.get('handover')!.handler(args, ctx as ExtensionCommandContext),
  };
}

void test('resuming at 90% pauses the parent and schedules the dedicated agent summary', async t => {
  const f = await fixture(t);
  f.usage(90);
  await f.reload();
  const start = async () => {
    const [result] = await f.emit('before_agent_start', {
      systemPrompt: 'Existing system instructions',
      prompt: 'Continue the current plan',
    });
    return result as BeforeAgentStartEventResult;
  };
  const {message, systemPrompt} = await start();
  assert.ok(message);
  assert.equal(message.customType, 'varisdev_handover_request');
  assert.match(String(message.content), /90\.0%/);
  assert.match(systemPrompt!, /^Existing system instructions/);
  assert.equal(f.sent.length, 0, 'The existing prompt delivers the request');
  await f.turn(answer('A response before inline request delivery'));
  assert.equal(f.scheduled.length, 0);
  await f.emit('message_start', {message: {role: 'custom', ...message}});
  await f.complete('Resume tasks.md with its remaining verification step.');
  assert.deepEqual(f.scheduled, [
    'Resume tasks.md with its remaining verification step.',
  ]);
  assert.equal((await start()).message, undefined);
  await f.turn();
  assert.equal(f.scheduled.length, 1);
  assert.equal(f.sent.length, 0);
});

void test('89.99% and unknown usage wait; exactly 90% pauses the parent once', async t => {
  const f = await fixture(t);
  await f.emit('agent_start');
  for (const value of [80, 89.99, undefined, null, NaN, Infinity]) {
    f.usage(value);
    await f.turn();
  }
  assert.equal(f.sent.length, 0);
  f.usage(90);
  await f.turn(answer('Preparing work', 'toolUse', true));
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].options, {deliverAs: 'steer', triggerTurn: true});
  assert.match(String(f.sent[0].message.content), /90\.0%/);
  assert.match(
    String(f.sent[0].message.content),
    /dedicated Codex GPT-5\.6 Sol agent with high reasoning/,
  );
  assert.match(String(f.sent[0].message.content), /read/i);
  assert.match(String(f.sent[0].message.content), /final response/);
  assert.match(String(f.sent[0].message.content), /source\.jsonl/);
  await f.turn(answer('An answer from before request delivery'));
  await f.deliver({id: 'different-request'});
  await f.turn();
  assert.equal(f.scheduled.length, 0);
  await f.deliver();
  await f.turn(answer('Read the plan first', 'toolUse', true));
  await f.turn(
    answer('Even a stop with a tool call is not final', 'stop', true),
  );
  assert.equal(f.sent.length, 1);
  assert.equal(f.scheduled.length, 0);
  await f.complete('  Verified plan in tasks.md. Continue with checks.  ');
  assert.deepEqual(f.scheduled, [
    'Verified plan in tasks.md. Continue with checks.',
  ]);
  await f.turn();
  await f.reload();
  await f.turn();
  assert.equal(f.sent.length, 1);
  assert.equal(f.scheduled.length, 1);
  assert.deepEqual(
    f.toolChanges,
    [],
    'The working parent keeps its existing tools',
  );
});

void test('persisted request suppresses repeats after reload; a fresh session can request again above 90%', async t => {
  const f = await fixture(t);
  f.usage(91);
  await f.turn();
  const firstId = f.sent[0].message.details;
  await f.reload();
  await f.turn();
  assert.equal(f.sent.length, 1);
  await f.emit('session_shutdown');
  await f.freshSession();
  await f.turn();
  assert.equal(f.sent.length, 2);
  assert.notDeepEqual(f.sent[1].message.details, firstId);
});

void test('failed, aborted and truncated parent responses never start the summarizer', async t => {
  const f = await fixture(t);
  for (const [text, stop] of [
    ['Partial draft', 'error'],
    ['Stopped draft', 'aborted'],
    ['Truncated draft', 'length'],
    ['Preparation never reached a final answer', 'toolUse'],
  ] as const) {
    await f.freshSession();
    f.usage(90);
    await f.turn();
    await f.deliver();
    await f.turn(answer(text, stop, stop === 'toolUse'));
    await f.emit('agent_settled');
    await f.turn(answer('Unrelated later answer'));
    assert.equal(f.scheduled.length, 0, stop);
  }
  await f.freshSession();
  await f.turn();
  await f.deliver();
  f.abort.abort();
  await f.turn();
  assert.equal(f.scheduled.length, 0);
});

void test('a new user instruction invalidates drafting and cancels a scheduled replacement', async t => {
  const f = await fixture(t);
  f.usage(90);
  await f.turn();
  await f.deliver();
  await f.emit('message_start', {
    message: {role: 'user', content: 'Change the plan'},
  });
  await f.turn(answer('Here is the changed plan'));
  await f.manual('continue');
  assert.equal(f.scheduled.length, 0);
  assert.match(f.notices.at(-1)!, /No completed handover/);
  await f.freshSession();
  await f.turn();
  await f.deliver();
  await f.complete('Captured draft awaiting replacement');
  assert.equal(f.isPending(), true);
  await f.emit('message_start', {
    message: {
      role: 'user',
      content: 'Include this new requirement before continuing',
    },
  });
  assert.deepEqual(f.cancelled, ['change-1']);
  assert.equal(f.isPending(), false);
  await f.manual('continue');
  assert.equal(f.scheduled.length, 1);
  assert.match(f.notices.at(-1)!, /No completed handover/);
});

void test('automatic prompts off still permit manual handover and manual continuation with refresh off', async t => {
  const f = await fixture(t);
  await f.settings({'auto-handover': 'off', 'auto-session-refresh': 'off'});
  f.usage(95);
  await f.turn();
  assert.deepEqual(
    await f.emit('session_before_compact', {reason: 'threshold'}),
    [{cancel: true}],
  );
  assert.equal(f.sent.length, 0);
  await f.manual();
  assert.equal(f.sent.length, 1);
  assert.match(String(f.sent[0].message.content), /refresh is off/);
  await f.deliver();
  await f.complete('Saved manual handover');
  await f.emit('agent_settled');
  assert.equal(f.scheduled.length, 0);
  assert.ok(JSON.stringify(f.entries).includes('Saved manual handover'));
  await f.reload();
  await f.manual('continue');
  assert.deepEqual(f.scheduled, ['Saved manual handover']);
});

void test('settings changes apply at request and completion, independently', async t => {
  const f = await fixture(t);
  f.usage(95);
  await f.settings({'auto-handover': 'off'});
  await f.turn();
  assert.equal(f.sent.length, 0);
  await f.settings({'auto-handover': 'on'});
  await f.turn();
  await f.deliver();
  await f.settings({'auto-session-refresh': 'off'});
  await f.complete('Draft retained after disabling refresh');
  assert.equal(f.scheduled.length, 0);
  await f.manual();
  await f.deliver();
  await f.settings({'auto-handover': 'off', 'auto-session-refresh': 'on'});
  await f.complete('Draft completed after enabling refresh');
  assert.deepEqual(f.scheduled, ['Draft completed after enabling refresh']);
});

void test('native compaction stays blocked below 90%, with unknown usage, and throughout a handover', async t => {
  const f = await fixture(t);
  const blocked = async () => {
    for (const reason of ['threshold', 'manual', 'overflow']) {
      assert.deepEqual(await f.emit('session_before_compact', {reason}), [
        {cancel: true},
      ]);
    }
  };
  for (const usage of [0, 80, 89.99, undefined, null, NaN, Infinity]) {
    f.usage(usage);
    await blocked();
    assert.equal(f.sent.length, 0);
  }
  f.usage(90);
  await blocked();
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].options, {
    deliverAs: 'nextTurn',
    triggerTurn: true,
  });
  await f.deliver();
  await blocked();
  await f.complete('Draft survives attempted compaction');
  assert.deepEqual(f.scheduled, ['Draft survives attempted compaction']);
  await blocked();
  assert.equal(f.sent.length, 1);

  await f.freshSession();
  await f.emit('agent_start');
  await blocked();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].options?.deliverAs, 'steer');
});

void test('failed or interrupted handovers never enable native compaction', async t => {
  const f = await fixture(t);
  f.usage(95);
  await f.turn();
  await f.deliver();
  await f.complete('');
  for (const reason of ['threshold', 'manual', 'overflow']) {
    assert.deepEqual(await f.emit('session_before_compact', {reason}), [
      {cancel: true},
    ]);
  }
  assert.equal(f.scheduled.length, 0);
  assert.equal(f.sent.length, 1);
  await f.manual();
  assert.equal(f.sent.length, 2, 'Manual retry is still available');
  f.abort.abort();
  for (const reason of ['threshold', 'manual', 'overflow']) {
    assert.deepEqual(await f.emit('session_before_compact', {reason}), [
      {cancel: true},
    ]);
  }
});

void test('disabled or invalid handover settings never enable native compaction', async t => {
  const f = await fixture(t);
  f.usage(95);
  for (const settings of [
    {'auto-handover': 'off', 'auto-session-refresh': 'off'} as const,
    '{invalid json',
  ]) {
    await f.settings(settings);
    for (const reason of ['threshold', 'manual', 'overflow']) {
      assert.deepEqual(await f.emit('session_before_compact', {reason}), [
        {cancel: true},
      ]);
    }
    assert.equal(f.sent.length, 0);
  }
  assert.match(f.notices.at(-1)!, /Handover:/);
});

void test('dispatch errors retain a draft and allow a manual retry', async t => {
  const f = await fixture(t);
  f.usage(90);
  await f.turn();
  await f.deliver();
  f.result('failed');
  await f.complete('Recoverable draft');
  assert.match(f.notices.at(-1)!, /Dispatch failed/);
  f.error(new Error('Replacement unavailable'));
  await f.manual('continue');
  assert.match(f.notices.at(-1)!, /Replacement unavailable/);
  f.error();
  f.result('scheduled');
  await f.manual('continue');
  assert.deepEqual(f.scheduled, Array(3).fill('Recoverable draft'));
  await f.manual('continue');
  assert.equal(f.scheduled.length, 3);
});

void test('a cancelled or vetoed scheduled replacement leaves its draft available to retry', async t => {
  const f = await fixture(t);
  f.usage(90);
  await f.turn();
  await f.deliver();
  await f.complete('Draft survives cancellation');
  assert.equal(f.scheduled.length, 1);
  // The session controller releases its pending request after cancellation or veto.
  f.pending(false);
  await f.emit('agent_settled');
  await f.manual('continue');
  assert.deepEqual(f.scheduled, [
    'Draft survives cancellation',
    'Draft survives cancellation',
  ]);
});

void test('new work invalidates a saved draft and an existing session change blocks requests', async t => {
  const f = await fixture(t);
  await f.settings({'auto-session-refresh': 'off'});
  f.usage(90);
  f.pending(true);
  await f.turn();
  await f.manual();
  assert.equal(f.sent.length, 0);
  f.pending(false);
  await f.turn();
  await f.deliver();
  await f.complete('Now stale draft');
  await f.emit('message_start', {
    message: {role: 'user', content: 'Do more work'},
  });
  await f.manual('continue');
  assert.equal(f.scheduled.length, 0);
});

void test('empty and oversized summaries never schedule; agent errors allow manual retry', async t => {
  const f = await fixture(t);
  for (const output of ['', 'x'.repeat(64001)]) {
    await f.freshSession();
    await f.manual();
    await f.deliver();
    await f.complete(output);
    assert.equal(f.scheduled.length, 0);
    assert.equal(f.agents.at(-1)!.disposed, true);
  }
  f.factory(async () => {
    throw new Error('Model unavailable');
  });
  await f.manual();
  await f.deliver();
  await f.turn();
  assert.match(f.notices.at(-1)!, /Model unavailable/);
  assert.equal(f.scheduled.length, 0);
  await f.manual();
  assert.equal(f.sent.length, 4);
});

void test('completed summarizer is disposed on session change and the next session gets a new agent', async t => {
  const f = await fixture(t);
  await f.manual();
  await f.deliver();
  await f.complete('Dedicated summary');
  assert.deepEqual(f.scheduled, ['Dedicated summary']);
  assert.equal(f.drafts[0].handover, 'Dedicated summary');
  assert.equal(f.agents[0].disposed, false);
  await f.emit('session_shutdown');
  assert.equal(f.agents[0].disposed, true);
  await f.freshSession();
  await f.manual();
  await f.deliver();
  await f.complete('Next dedicated summary');
  assert.equal(f.agents.length, 2);
  assert.equal(f.agents[1].disposed, false);
  await f.freshSession();
  assert.equal(f.agents[1].disposed, true);
});

for (const phase of ['initializing', 'running']) {
  for (const interruption of [
    'session_shutdown',
    'session_start',
    'user',
    'abort',
  ]) {
    void test(`${interruption} during summarizer ${phase} discards late output and disposes the agent`, async t => {
      const f = await fixture(t);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let disposed = 0;
      let signal: AbortSignal | undefined;
      f.factory(async () => {
        if (phase === 'initializing') {
          entered.resolve();
          await release.promise;
        }
        return {
          prompt: 'Snapshot',
          worker: {
            async run(_prompt, runSignal) {
              signal = runSignal;
              entered.resolve();
              await release.promise;
              runSignal.throwIfAborted();
              return 'Obsolete summary';
            },
            dispose() {
              disposed++;
            },
          },
        } satisfies HandoverAgent;
      });
      await f.manual();
      await f.deliver();
      const turn = f.turn();
      await entered.promise;
      if (interruption === 'user') {
        await f.emit('message_start', {
          message: {role: 'user', content: 'New requirement'},
        });
      } else if (interruption === 'abort') {
        f.abort.abort();
      } else {
        await f.emit(interruption);
      }
      if (phase === 'running') assert.equal(signal!.aborted, true);
      release.resolve();
      await turn;
      assert.equal(disposed, 1);
      assert.equal(f.scheduled.length, 0);
      assert.equal(f.drafts.length, 0);
      assert.deepEqual(f.notices, []);
    });
  }
}

void test('summary activity and elapsed time replace Processing and clear on completion', async t => {
  const f = await fixture(t);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.factory(async () => ({
    prompt: 'Snapshot',
    worker: {
      async run(_prompt, _signal, activity) {
        activity('Using read');
        entered.resolve();
        await release.promise;
        return 'Completed summary';
      },
      dispose() {},
    },
  }));
  await f.manual();
  await f.deliver();
  t.mock.timers.enable({apis: ['Date', 'setInterval', 'setTimeout']});
  const turn = f.turn();
  await entered.promise;
  assert.match(f.workingMessages[0]!, /Handover: Starting summary agent/);
  assert.match(f.workingMessages.at(-1)!, /Using read.*0m 0s.*Esc to cancel/);
  t.mock.timers.tick(61000);
  assert.match(f.workingMessages.at(-1)!, /Using read.*1m 1s/);
  release.resolve();
  await turn;
  assert.deepEqual(f.scheduled, ['Completed summary']);
  assert.equal(f.workingMessages.at(-1), '');
  const updates = f.workingMessages.length;
  t.mock.timers.tick(5 * 60 * 1000);
  assert.equal(f.workingMessages.length, updates);
  assert.deepEqual(f.notices, []);
});

for (const phase of ['initializing', 'running']) {
  for (const interruption of ['timeout', 'abort']) {
    void test(
      `${interruption} releases a stuck summarizer ${phase} and discards late output`,
      {timeout: 10000},
      async t => {
        const f = await fixture(t);
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let disposed = 0;
        let runSignal: AbortSignal | undefined;
        f.factory(async () => {
          if (phase === 'initializing') {
            entered.resolve();
            await release.promise;
          }
          return {
            prompt: 'Snapshot',
            worker: {
              async run(_prompt, signal) {
                runSignal = signal;
                entered.resolve();
                // Simulate a provider that ignores cancellation.
                await release.promise;
                return 'Late summary';
              },
              dispose() {
                disposed++;
              },
            },
          };
        });
        await f.manual();
        await f.deliver();
        t.mock.timers.enable({apis: ['setTimeout', 'setInterval']});
        const turn = f.turn();
        await entered.promise;
        if (interruption === 'timeout') t.mock.timers.tick(5 * 60 * 1000);
        else f.abort.abort();
        // Neither initialization nor the provider has returned yet.
        await turn;
        if (phase === 'running') assert.equal(runSignal!.aborted, true);
        assert.equal(f.workingMessages.at(-1), '');
        assert.equal(disposed, phase === 'running' ? 1 : 0);
        if (interruption === 'timeout')
          assert.match(f.notices.at(-1)!, /exceeded 5 minutes.*\/handover/);
        else assert.deepEqual(f.notices, []);
        const updates = f.workingMessages.length;
        release.resolve();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(disposed, 1);
        assert.equal(f.scheduled.length, 0);
        assert.equal(f.drafts.length, 0);
        t.mock.timers.tick(1000);
        assert.equal(f.workingMessages.length, updates);
        if (interruption === 'timeout') {
          await f.manual();
          assert.equal(
            f.sent.length,
            2,
            'Timed out preparation can be retried',
          );
        }
      },
    );
  }
}
