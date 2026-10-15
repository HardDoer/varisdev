import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {
  AgentSession,
  AgentSessionEvent,
  SessionEntry,
} from '@earendil-works/pi-coding-agent';
import {sessionWorker} from '../src/agents/session.ts';
import type {ModelUsage} from '../src/usage.ts';

const usageEntry = (id: string, tokens: number): SessionEntry =>
  ({
    type: 'usage',
    id,
    parentId: null,
    timestamp: new Date(
      `2026-01-01T00:00:0${id === 'warm-one' ? 1 : 2}Z`,
    ).toISOString(),
    kind: 'cache_warm',
    provider: 'fixture',
    model: 'worker-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: tokens,
      cacheWrite: 0,
      totalTokens: tokens,
      cost: {
        input: 0,
        output: 0,
        cacheRead: tokens / 1000,
        cacheWrite: 0,
        total: tokens / 1000,
      },
    },
  }) as SessionEntry;

void test('worker usage reports live and idle persisted cache-warming entries once', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varisdev-usage-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const resultFile = join(directory, 'result.txt');
  const branch: SessionEntry[] = [];
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const assistant = {
    role: 'assistant',
    timestamp: Date.parse('2026-01-01T00:00:03Z'),
    provider: 'fixture',
    model: 'worker-model',
    content: [{type: 'text', text: 'Worker result'}],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: 'stop',
  };
  const session = {
    sessionManager: {
      getBranch: () => branch,
      getCwd: () => directory,
      getSessionFile: () => join(directory, 'session.jsonl'),
    },
    messages: [assistant],
    subscribe(listener: (event: AgentSessionEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      const entry = usageEntry('warm-one', 5);
      branch.push(entry);
      for (const listener of listeners)
        listener({type: 'entry_appended', entry} as AgentSessionEvent);
    },
    clearQueue: () => ({steering: [], followUp: []}),
    abortCompaction() {},
    abortBash() {},
    async abort() {},
    dispose() {},
  } as unknown as AgentSession;
  const worker = sessionWorker(session, resultFile);
  const updates: ModelUsage[] = [];

  assert.equal(
    await worker.run(
      'Run the fixture.',
      new AbortController().signal,
      () => {},
      usage => updates.push(usage),
    ),
    'Worker result',
  );
  assert.equal(await readFile(resultFile, 'utf8'), 'Worker result');
  assert.ok(updates.length >= 1);
  assert.ok(updates.every(usage => usage.totalTokens === 5));
  assert.equal(worker.usage?.calls.length, 1);
  assert.equal(worker.usage?.totalTokens, 5);
  assert.equal(worker.usage?.calls[0].usageKind, 'cache_warm');

  // Idle warming can happen after the per-run subscription has been removed.
  // The worker-lifetime listener must update the orchestrator callback too.
  const idleEntry = usageEntry('warm-two', 7);
  branch.push(idleEntry);
  for (const listener of listeners)
    listener({type: 'entry_appended', entry: idleEntry} as AgentSessionEvent);
  assert.equal(updates.at(-1)?.calls.length, 2);
  assert.equal(updates.at(-1)?.totalTokens, 12);
  assert.equal(worker.usage?.calls.length, 2);
  assert.equal(worker.usage?.totalTokens, 12);
  assert.equal(worker.usage?.cost, 0.012);
  worker.dispose();
  assert.equal(listeners.size, 0);
});
