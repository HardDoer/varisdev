import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {existsSync} from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test, {type TestContext} from 'node:test';
import {
  agentHistoryCutoff,
  claimAgentHistory,
  pruneAgentHistory,
} from '../src/agents/retention.ts';
import {
  AgentOrchestrator,
  type AgentRecord,
  type AgentWorker,
} from '../src/agents/orchestrator.ts';

import {AgentHistoryStore, type AgentHistory} from '../src/agents/history.ts';
import {createDefaultAgentProfile} from '../src/agents/templates.ts';
import type {ConversationSnapshot} from '../src/conversation.ts';

const day = 86400000;
const now = Date.now();
const old = now - 10 * day;
const recent = now - day;

async function fixture(t: TestContext) {
  const output = fileURLToPath(
    new URL('../.varisdev/tool-output/', import.meta.url),
  );
  await mkdir(output, {recursive: true});
  const root = await mkdtemp(join(output, 'agent-retention-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}

function record(
  id: string,
  timestamp = old,
  status: AgentRecord['status'] = 'completed',
): AgentRecord & ConversationSnapshot {
  return {
    id,
    status,
    name: id,
    task: 'task',
    cwd: '.',
    model: 'fixture/model',
    createdAt: new Date(timestamp).toISOString(),
    finishedAt: new Date(timestamp).toISOString(),
    activity: 'Completed',
    conversation: [],
    conversationTruncated: false,
    resumable: false,
    agentMode: 'subagent' as const,
  };
}

async function worker(
  root: string,
  parent: string,
  id: string,
  timestamp: number,
) {
  const path = join(root, 'varisdev', 'agents', parent, id);
  await mkdir(path, {recursive: true});
  for (const name of ['session.jsonl', 'result.txt', 'auth.json']) {
    const file = join(path, name);
    await writeFile(file, 'saved data');
    await utimes(file, timestamp / 1000, timestamp / 1000);
  }
  return path;
}

async function history(
  root: string,
  parent: string,
  agents: ReturnType<typeof record>[],
) {
  const path = join(root, 'varisdev', 'agents', parent, 'history.json');
  await mkdir(join(path, '..'), {recursive: true});
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      sessionId: parent,
      agents,
      messages: [],
      changes: [],
      messageSequence: 0,
      configurations: Object.fromEntries(
        agents.map(agent => [
          agent.id,
          {instructions: 'retained configuration'},
        ]),
      ),
    }),
  );
  return path;
}

void test('retention removes expired worker data and saved rows and preserves recent agents and other profile data', async t => {
  const root = await fixture(t);
  const expired = await worker(root, 'parent', 'expired', old);
  const kept = await worker(root, 'parent', 'recent', recent);
  const file = await history(root, 'parent', [
    record('expired'),
    record('recent', recent),
  ]);
  const credentials = join(root, 'auth.json');
  await writeFile(credentials, 'global configuration');
  const main = join(root, 'sessions', 'main.jsonl');
  await mkdir(join(root, 'sessions'));
  await writeFile(main, 'main conversation');
  assert.deepEqual(await pruneAgentHistory(root, 7, {now}), {
    workers: 1,
    parents: 0,
  });
  assert.equal(existsSync(expired), false);
  assert.equal(existsSync(kept), true);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(
    saved.agents.map((agent: AgentRecord) => agent.id),
    ['recent'],
  );
  assert.deepEqual(Object.keys(saved.configurations), ['recent']);
  assert.equal(await readFile(credentials, 'utf8'), 'global configuration');
  assert.equal(await readFile(main, 'utf8'), 'main conversation');
  assert.deepEqual(await pruneAgentHistory(root, 7, {now}), {
    workers: 0,
    parents: 0,
  });
});

void test('legacy, corrupt, interrupted and orphan history expire from stable content age', async t => {
  const root = await fixture(t);
  await worker(root, 'legacy', 'old-worker', old);
  await worker(root, 'legacy', 'last-worker', old);
  await worker(root, 'corrupt', 'old-worker', old);
  await worker(root, 'corrupt', 'last-worker', old);
  const corrupt = join(root, 'varisdev', 'agents', 'corrupt', 'history.json');
  await writeFile(corrupt, 'null');
  await utimes(corrupt, old / 1000, old / 1000);
  const queued = await history(root, 'interrupted', [
    {...record('queued'), status: 'queued'},
  ]);
  const saved = JSON.parse(await readFile(queued, 'utf8'));
  delete saved.agents[0].finishedAt;
  await writeFile(queued, JSON.stringify(saved));
  const orphan = await worker(root, 'mixed', 'orphan', old);
  await worker(root, 'mixed', 'kept', recent);
  await history(root, 'mixed', [record('kept', recent)]);
  const result = await pruneAgentHistory(root, 7, {now});
  assert.equal(result.workers, 3);
  assert.equal(result.parents, 1);
  assert.equal(existsSync(orphan), false);
  assert.equal(
    existsSync(join(root, 'varisdev', 'agents', 'interrupted')),
    false,
  );
  // Without a readable manifest, keep a possible last primary in each parent.
  for (const name of ['legacy', 'corrupt'])
    assert.equal(existsSync(join(root, 'varisdev', 'agents', name)), true);
});

void test('live owner leases protect parents and only an exclusive owner can delete its expired workers', async t => {
  const root = await fixture(t);
  const path = await worker(root, 'parent', 'expired', old);
  await history(root, 'parent', [record('expired')]);
  const first = claimAgentHistory(root, 'parent');
  const second = claimAgentHistory(root, 'parent');
  t.after(() => {
    second.release();
    first.release();
  });
  assert.equal(
    await first.prune(async () =>
      assert.fail('Another owner must prevent cleanup'),
    ),
    false,
  );
  assert.equal((await pruneAgentHistory(root, 7, {now})).workers, 0);
  assert.equal(existsSync(path), true);
  second.release();
  assert.equal(await first.prune(async () => {}), true);
  first.release();
  assert.equal((await pruneAgentHistory(root, 7, {now})).workers, 1);
});

void test(
  'another process protects history while alive and a crash releases it for retention',
  {timeout: 15000},
  async t => {
    const root = await fixture(t);
    const path = await worker(root, 'parent', 'expired', old);
    await history(root, 'parent', [record('expired')]);
    const moduleUrl = new URL('../src/agents/retention.ts', import.meta.url)
      .href;
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {claimAgentHistory} from ${JSON.stringify(moduleUrl)}; claimAgentHistory(${JSON.stringify(root)}, 'parent'); process.stdout.write('ready'); setInterval(()=>{},1000);`,
      ],
      {stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000},
    );
    const exited = once(child, 'exit');
    t.after(async () => {
      child.kill('SIGKILL');
      await exited;
    });
    const [chunk] = await once(child.stdout, 'data');
    assert.equal(String(chunk), 'ready');
    assert.equal((await pruneAgentHistory(root, 7, {now})).workers, 0);
    assert.equal(existsSync(path), true);
    child.kill('SIGKILL');
    await exited;
    assert.equal((await pruneAgentHistory(root, 7, {now})).workers, 1);
  },
);

void test('cleanup does not traverse linked directories or paths supplied by stored records', async t => {
  const root = await fixture(t);
  const outside = join(root, 'outside');
  await mkdir(outside);
  const protectedFile = join(outside, 'keep.txt');
  await writeFile(protectedFile, 'keep');
  await utimes(protectedFile, old / 1000, old / 1000);
  const path = await worker(root, 'parent', 'linked', old);
  await symlink(
    outside,
    join(path, 'linked-directory'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await history(root, 'parent', [record('linked')]);
  assert.equal((await pruneAgentHistory(root, 7, {now})).workers, 0);
  assert.equal(await readFile(protectedFile, 'utf8'), 'keep');
  const lease = claimAgentHistory(root, 'parent');
  t.after(() => lease.release());
  await lease.prune(async files => {
    assert.equal(files.remove('../../outside', now), false);
  });
  assert.equal(existsSync(outside), true);
});

void test('interrupted agents keep their last activity age when restored and cannot be resumed during expiry', async t => {
  const manager = new AgentOrchestrator();
  t.after(() => manager.close());
  manager.restore([
    {...record('interrupted', old, 'running'), finishedAt: undefined},
  ]);
  assert.equal(
    manager.get('interrupted').finishedAt,
    new Date(old).toISOString(),
  );
  const removing = manager.expireFinished(agentHistoryCutoff(7, now));
  assert.throws(() => manager.get('interrupted'), /Unknown agent/);
  assert.deepEqual(await removing, ['interrupted']);
});

void test('expiry waits for pending interactions and never disposes a worker being restored', async t => {
  const manager = new AgentOrchestrator();
  t.after(() => manager.close());
  const prepared = Promise.withResolvers<AgentWorker>();
  let disposed = 0;
  manager.restore(
    [{...record('old'), resumable: true, sessionFile: 'saved.jsonl'}],
    () => prepared.promise,
  );
  const viewing = manager.features('old');
  await Promise.resolve();
  assert.deepEqual(
    await manager.expireFinished(agentHistoryCutoff(7, now)),
    [],
  );
  prepared.resolve({
    run: async () => '',
    steer: async () => true,
    features: async () => ({models: []}) as never,
    dispose: () => {
      disposed++;
    },
  });
  await viewing;
  assert.deepEqual(
    await manager.expireFinished(agentHistoryCutoff(7, now)),
    [],
  );
  assert.deepEqual(
    await manager.expireFinished(agentHistoryCutoff(7, Date.now() + 8 * day)),
    ['old'],
  );
  assert.equal(disposed, 1);
});

void test('a wait combining old finished and running agents survives retention', async t => {
  const manager = new AgentOrchestrator();
  t.after(() => manager.close());
  manager.restore([record('old'), record('unused')]);
  const running = Promise.withResolvers<string>();
  const active = manager.spawn(
    {name: 'active', task: 'task', cwd: '.', model: 'fixture/model'},
    async () => ({
      run: () => running.promise,
      steer: async () => true,
      dispose() {},
    }),
  );
  const waiting = manager.wait(['old', active.id], {timeoutMs: 1000});
  assert.deepEqual(await manager.expireFinished(agentHistoryCutoff(7, now)), [
    'unused',
  ]);
  running.resolve('done');
  assert.equal((await waiting).length, 2);
  assert.deepEqual(
    await manager.expireFinished(agentHistoryCutoff(7, now)),
    [],
  );
  assert.ok(Date.parse(manager.get('old').lastUsedAt!) >= now);
  assert.equal(manager.get(active.id).status, 'completed');
});

void test('disk retention keeps the final primary and honors last use after an old completion', async t => {
  const root = await fixture(t);
  const last = {
    ...record('primary', old),
    agentMode: 'primary' as const,
    resumable: true,
  };
  const earlier = {
    ...record('earlier', old - day),
    agentMode: 'all' as const,
    resumable: true,
  };
  const used = {
    ...record('used', old),
    lastUsedAt: new Date(recent).toISOString(),
  };
  const file = await history(root, 'parent', [
    earlier,
    last,
    used,
    record('expired'),
  ]);
  for (const id of ['primary', 'earlier', 'used', 'expired'])
    await worker(root, 'parent', id, old);
  assert.equal((await pruneAgentHistory(root, 7, {now})).workers, 2);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(
    saved.agents.map((agent: AgentRecord) => agent.id),
    ['primary', 'used'],
  );
  assert.equal(
    (await pruneAgentHistory(root, 7, {now: now + 20 * day})).workers,
    1,
  );
  assert.deepEqual(
    JSON.parse(await readFile(file, 'utf8')).agents.map(
      (agent: AgentRecord) => agent.id,
    ),
    ['primary'],
  );
  assert.equal(
    existsSync(join(root, 'varisdev', 'agents', 'parent', 'primary')),
    true,
  );
});

void test(
  'concurrent stale history saves preserve omitted workers and their use through disk cleanup',
  {timeout: 10000},
  async t => {
    const root = await fixture(t);
    const first = await worker(root, 'parent', 'first', old);
    const second = await worker(root, 'parent', 'second', old);
    const firstStore = new AgentHistoryStore(root, 'parent');
    firstStore.save(() => ({
      version: 1,
      sessionId: 'parent',
      agents: ['first', 'second'].map(id => ({
        ...record(id),
        lastUsedAt: new Date(old).toISOString(),
      })),
      messages: [],
      changes: [],
      messageSequence: 0,
      configurations: Object.fromEntries(
        ['first', 'second'].map(id => [
          id,
          {agentProfile: createDefaultAgentProfile(), context: 'task'},
        ]),
      ),
    }));
    await firstStore.flush();
    const secondStore = new AgentHistoryStore(root, 'parent');
    const staleStore = new AgentHistoryStore(root, 'parent');
    const stale = staleStore.read()!;
    const firstUse = new Date(recent).toISOString();
    const secondUse = new Date(now).toISOString();
    const firstSnapshot = structuredClone(stale);
    firstSnapshot.agents[0].lastUsedAt = firstUse;
    const secondSnapshot = structuredClone(stale);
    secondSnapshot.agents[1].lastUsedAt = secondUse;
    firstStore.save(() => firstSnapshot);
    secondStore.save(() => secondSnapshot);
    staleStore.save(() => structuredClone(stale));
    // Neither owner's snapshot contains the other owner's recent use.
    await Promise.all([
      firstStore.flush(),
      secondStore.flush(),
      staleStore.flush(),
    ]);
    const saved = () => new AgentHistoryStore(root, 'parent').read()!;
    const savedUse = () =>
      saved()
        .agents.toSorted((a, b) => a.id.localeCompare(b.id))
        .map(agent => [agent.id, agent.lastUsedAt]);
    assert.deepEqual(savedUse(), [
      ['first', firstUse],
      ['second', secondUse],
    ]);

    staleStore.save(() => ({
      ...structuredClone(stale),
      agents: [structuredClone(stale.agents[1])],
      configurations: {second: structuredClone(stale.configurations.second)},
    }));
    await staleStore.flush();
    assert.deepEqual(savedUse(), [
      ['first', firstUse],
      ['second', secondUse],
    ]);
    assert.deepEqual(saved().configurations, stale.configurations);
    assert.deepEqual(await pruneAgentHistory(root, 7, {now}), {
      workers: 0,
      parents: 0,
    });
    assert.equal(existsSync(first), true);
    assert.equal(existsSync(second), true);
    assert.deepEqual(savedUse(), [
      ['first', firstUse],
      ['second', secondUse],
    ]);
    assert.deepEqual(saved().configurations, stale.configurations);

    // A later stale snapshot must also retain both saved use timestamps.
    staleStore.save(() => structuredClone(stale));
    await staleStore.flush();
    assert.deepEqual(savedUse(), [
      ['first', firstUse],
      ['second', secondUse],
    ]);
    assert.equal(
      (await pruneAgentHistory(root, 7, {now: recent + 7 * day + 1})).workers,
      1,
    );
    assert.equal(existsSync(first), false);
    assert.equal(existsSync(second), true);
    assert.deepEqual(savedUse(), [['second', secondUse]]);
    assert.deepEqual(Object.keys(saved().configurations), ['second']);
    assert.equal(
      (await pruneAgentHistory(root, 7, {now: now + 7 * day + 1})).workers,
      1,
    );
    assert.equal(existsSync(second), false);
    assert.deepEqual(
      new AgentHistoryStore(root, 'parent').read()?.agents ?? [],
      [],
    );
  },
);

void test(
  'a stale empty history save preserves the sole primary and its configuration beyond retention',
  {timeout: 10000},
  async t => {
    const root = await fixture(t);
    const writer = new AgentHistoryStore(root, 'parent');
    const empty: AgentHistory = {
      version: 1,
      sessionId: 'parent',
      agents: [],
      messages: [],
      changes: [],
      messageSequence: 0,
      configurations: {},
    };
    writer.save(() => structuredClone(empty));
    await writer.flush();
    const staleStore = new AgentHistoryStore(root, 'parent');
    const stale = staleStore.read()!;
    assert.deepEqual(stale.agents, []);
    const path = await worker(root, 'parent', 'primary', now);
    const sessionFile = join(path, 'session.jsonl');
    const configuration: AgentHistory['configurations'][string] = {
      agentProfile: createDefaultAgentProfile(),
      context: 'task',
      instructions: 'Keep the primary workspace instructions',
    };
    writer.save(() => ({
      ...structuredClone(empty),
      agents: [
        {
          ...record('primary', now),
          agentMode: 'primary',
          resumable: true,
          sessionFile,
        },
      ],
      configurations: {primary: configuration},
    }));
    await writer.flush();
    staleStore.save(() => structuredClone(stale));
    await staleStore.flush();
    const assertRetained = async () => {
      const saved = new AgentHistoryStore(root, 'parent').read()!;
      assert.deepEqual(
        saved.agents.map(agent => agent.id),
        ['primary'],
      );
      assert.equal(saved.agents[0].agentMode, 'primary');
      assert.equal(saved.agents[0].resumable, true);
      assert.equal(saved.agents[0].sessionFile, sessionFile);
      assert.deepEqual(saved.configurations, {primary: configuration});
      assert.equal(await readFile(sessionFile, 'utf8'), 'saved data');
      assert.equal(
        await readFile(join(path, 'result.txt'), 'utf8'),
        'saved data',
      );
    };
    await assertRetained();
    const known = staleStore.read()!;
    staleStore.save(() => ({
      ...structuredClone(known),
      configurations: {},
    }));
    await staleStore.flush();
    await assertRetained();
    assert.deepEqual(await pruneAgentHistory(root, 7, {now: now + 8 * day}), {
      workers: 0,
      parents: 0,
    });
    await assertRetained();
    staleStore.save(() => structuredClone(stale));
    await staleStore.flush();
    assert.deepEqual(await pruneAgentHistory(root, 7, {now: now + 30 * day}), {
      workers: 0,
      parents: 0,
    });
    await assertRetained();
  },
);

void test('live expiry preserves the final retained primary conversation', async t => {
  const manager = new AgentOrchestrator();
  t.after(() => manager.close());
  manager.restore([
    {...record('earlier', old - day), agentMode: 'all'},
    {...record('primary', old), agentMode: 'primary'},
    record('subagent'),
  ]);
  assert.deepEqual(await manager.expireFinished(agentHistoryCutoff(7, now)), [
    'earlier',
    'subagent',
  ]);
  assert.deepEqual(
    manager.list().map(agent => agent.id),
    ['primary'],
  );
  assert.deepEqual(
    await manager.expireFinished(agentHistoryCutoff(7, now + 365 * day)),
    [],
  );
});

void test('viewing a finished conversation resets inactivity without starting a worker', async t => {
  const manager = new AgentOrchestrator();
  t.after(() => manager.close());
  manager.restore([record('viewed'), record('expired')]);
  const {runAgentSessionRequest} =
    await import('../src/dashboard/agent-session.ts');
  await runAgentSessionRequest(manager, {agentId: 'viewed', action: 'view'});
  assert.deepEqual(await manager.expireFinished(agentHistoryCutoff(7, now)), [
    'expired',
  ]);
  assert.equal(manager.get('viewed').status, 'completed');
  assert.ok(Date.parse(manager.get('viewed').lastUsedAt!) >= now);
});

void test('the hourly service expires inactive history while the application remains open', async t => {
  const root = await fixture(t);
  const path = await worker(root, 'parent', 'worker', recent);
  await history(root, 'parent', [record('worker', recent)]);
  await writeFile(
    join(root, 'varisdev', 'tool-settings.json'),
    JSON.stringify({agents: {allowedModels: [], historyRetentionDays: 7}}),
  );
  const {watchAgentHistory, agentRetentionIntervalMs} =
    await import('../src/agents/retention.ts');
  t.mock.timers.enable({apis: ['Date', 'setInterval'], now});
  const watcher = watchAgentHistory(root, async () => {});
  t.after(() => watcher.close());
  await watcher.ready;
  assert.equal(existsSync(path), true);
  t.mock.timers.setTime(now + 8 * day);
  t.mock.timers.tick(agentRetentionIntervalMs);
  const {setTimeout: delay} = await import('node:timers/promises');
  for (let attempts = 0; attempts < 100 && existsSync(path); attempts++)
    await delay(10);
  await watcher.close();
  assert.equal(existsSync(path), false);
});

void test(
  'new owners wait for the complete cleanup transaction and later use protects their files',
  {timeout: 10000},
  async t => {
    const root = await fixture(t);
    const path = await worker(root, 'parent', 'worker', old);
    const file = await history(root, 'parent', [record('worker')]);
    const {claimAgentHistoryAsync} = await import('../src/agents/retention.ts');
    const first = await claimAgentHistoryAsync(root, 'parent');
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    t.after(() => {
      finish.resolve();
      first.release();
    });
    const cleaning = first.prune(async files => {
      assert.equal(files.isExpired('worker', agentHistoryCutoff(7, now)), true);
      entered.resolve();
      await finish.promise;
      await writeFile(file, await readFile(file, 'utf8'));
    });
    await entered.promise;
    let claimed = false;
    const opening = claimAgentHistoryAsync(root, 'parent').then(lease => {
      claimed = true;
      return lease;
    });
    const {setTimeout: delay} = await import('node:timers/promises');
    await delay(75);
    assert.equal(
      claimed,
      false,
      'Restoration must not begin during disposal or publication',
    );
    finish.resolve();
    await cleaning;
    const second = await opening;
    t.after(() => second.release());
    assert.equal(
      await first.prune(async () =>
        assert.fail('An active peer owns this history'),
      ),
      false,
    );
    await writeFile(join(path, 'session.jsonl'), 'recent continuation');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    saved.agents[0].lastUsedAt = new Date().toISOString();
    await writeFile(file, JSON.stringify(saved));
    second.release();
    await first.prune(async files => {
      assert.equal(
        files.isExpired('worker', agentHistoryCutoff(7, now)),
        false,
      );
      assert.equal(files.remove('worker', agentHistoryCutoff(7, now)), false);
    });
    assert.equal(
      await readFile(join(path, 'session.jsonl'), 'utf8'),
      'recent continuation',
    );
  },
);

void test(
  'desktop retention saves reach a terminal-owned workspace across processes',
  {timeout: 15000},
  async t => {
    const root = await fixture(t);
    const path = await worker(root, 'parent', 'worker', old);
    await history(root, 'parent', [record('worker')]);
    await writeFile(
      join(root, 'varisdev', 'tool-settings.json'),
      JSON.stringify({agents: {allowedModels: [], historyRetentionDays: 30}}),
    );
    const controllerUrl = new URL('../src/agents/team.ts', import.meta.url)
      .href;
    const code = `import {AgentSessionController} from ${JSON.stringify(controllerUrl)};
    const handlers=new Map(); const controller=new AgentSessionController({on(name,handler){handlers.set(name,handler)}});
    const ctx={hasUI:false,sessionManager:{getSessionId:()=> 'parent',getSessionFile:()=> 'parent.jsonl',getEntries:()=>[]}};
    controller.subscribe(()=>{if(process.connected)process.send({type:'agents',ids:controller.snapshot()?.agents.map(a=>a.id)??[]})});
    await handlers.get('session_start')({},ctx);process.send({type:'ready',ids:controller.snapshot().agents.map(a=>a.id)});
    process.on('message',async message=>{if(message==='stop'){await handlers.get('session_shutdown')();process.exit(0)}});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: {...process.env, PI_CODING_AGENT_DIR: root},
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      timeout: 12000,
    });
    const exited = once(child, 'exit');
    const ready = Promise.withResolvers<string[]>();
    const expired = Promise.withResolvers<void>();
    let started = false;
    child.on('message', (message: {type: string; ids: string[]}) => {
      if (message.type === 'ready') {
        started = true;
        ready.resolve(message.ids);
      } else if (started && message.type === 'agents' && !message.ids.length)
        expired.resolve();
    });
    t.after(async () => {
      child.kill('SIGKILL');
      await exited;
    });
    const unexpectedExit = exited.then(([code]) => {
      throw new Error(
        `Terminal fixture exited before reporting completion (${code}).`,
      );
    });
    assert.deepEqual(await Promise.race([ready.promise, unexpectedExit]), [
      'worker',
    ]);
    assert.equal(
      (await pruneAgentHistory(root, 7, {now})).workers,
      0,
      'The desktop must respect the terminal owner',
    );
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    t.after(() => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    });
    const {DesktopToolSettings} =
      await import('../src/desktop/tool-settings.ts');
    const settings = new DesktopToolSettings({
      sessionFeatures: async () => ({models: []}),
    });
    await settings.saveToolSettings(
      'agents',
      {allowedModels: [], historyRetentionDays: 7},
      'attached-workspace',
    );
    await Promise.race([expired.promise, unexpectedExit]);
    child.send('stop');
    await exited;
    assert.equal(existsSync(path), false);
  },
);
