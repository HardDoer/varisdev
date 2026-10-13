import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as nextTick} from 'node:timers/promises';
import {test} from 'node:test';
import {promisify} from 'node:util';
import type {AgentRecord} from '../src/agents/orchestrator.ts';
import {
  DashboardHub,
  queuedPrompt,
  type DashboardParent,
} from '../src/dashboard/hub.ts';
import {DashboardState} from '../src/dashboard/state.ts';
import {DesktopExtensionUI} from '../src/dashboard/extension-ui.ts';
import type {SessionFeatures} from '../src/dashboard/features.ts';
import {readWorkspaceDiff} from '../src/dashboard/workspace.ts';

const execFile = promisify(execFileCallback);

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
  features: async () => features(),
  configure: async () => {},
  compact: async () => {},
  reload: async () => {},
};

function state(id: string, cwd = process.cwd()) {
  const now = new Date().toISOString();
  return new DashboardState({
    id,
    cwd,
    name: id,
    status: 'idle',
    activity: 'Ready',
    startedAt: now,
    updatedAt: now,
  });
}

async function until(predicate: () => boolean): Promise<void> {
  for (let count = 0; count < 200; count++) {
    if (predicate()) return;
    await nextTick();
  }
  assert.fail('Expected state was not reached');
}

function controlledParent(id: string, cwd: string) {
  const current = state(id, cwd);
  const runs: Array<{text: string; resolve: () => void}> = [];
  let closed = false;
  let active = 0;
  let maximum = 0;
  const parent: DashboardParent = {
    ...featureControls,
    state: current,
    async prompt(text, delivery) {
      if (!delivery.isQueued()) return;
      delivery.submitted();
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => runs.push({text, resolve}));
      active--;
      current.updateSession({
        status: 'idle',
        activity: 'Done',
        response: `Result for ${text}`,
      });
    },
    async abort() {
      runs.at(-1)?.resolve();
    },
    async close() {
      await parent.abort();
      closed = true;
    },
  };
  return {
    parent,
    runs,
    get closed() {
      return closed;
    },
    get maximum() {
      return maximum;
    },
  };
}

void test('dashboard keeps parallel parents isolated, serializes each prompt queue and stops pending work', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varisdev-hub-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const folders = [join(directory, 'one'), join(directory, 'two')];
  await Promise.all(folders.map(path => mkdir(path)));
  const parents: ReturnType<typeof controlledParent>[] = [];
  const hub = new DashboardHub(state('terminal', directory), async request => {
    const entry = controlledParent(`parent-${parents.length}`, request.cwd);
    parents.push(entry);
    return entry.parent;
  });
  t.after(() => hub.close());
  let notifications = 0;
  const unsubscribe = hub.subscribe(() => notifications++);
  const one = await hub.createSession({cwd: folders[0], prompt: 'Task 0'});
  const two = await hub.createSession({cwd: folders[1], prompt: 'Task 1'});
  await until(() => parents.every(parent => parent.runs.length === 1));
  assert.equal(hub.snapshot().sessions.length, 3);
  assert.deepEqual(
    hub.snapshot().sessions.map(item => item.session.owned),
    [false, true, true],
  );
  assert.equal(
    new Set(hub.snapshot().sessions.map(item => item.session.cwd)).size,
    3,
  );
  await hub.promptSession(one.id, {prompt: 'Follow up'});
  await hub.promptSession(one.id, {prompt: 'Never run'});
  assert.equal(parents[0].runs.length, 1);
  assert.equal(hub.snapshot().sessions[1].session.pendingPrompts, 2);
  parents[0].runs[0].resolve();
  await until(() => parents[0].runs.length === 2);
  assert.equal(parents[0].runs[1].text, 'Follow up');
  await hub.abortSession(one.id);
  assert.equal(parents[0].runs.length, 2);
  assert.equal(parents[0].maximum, 1);
  assert.equal(hub.snapshot().sessions[1].session.pendingPrompts, 0);
  assert.equal(hub.snapshot().sessions[2].session.status, 'running');
  assert.ok(notifications > 5);
  await assert.rejects(
    hub.promptSession('terminal', {prompt: 'No'}),
    /terminal/,
  );
  await assert.rejects(hub.promptSession('missing', {prompt: 'No'}), /Unknown/);
  await assert.rejects(hub.createSession({cwd: '.', prompt: 'No'}), /absolute/);
  await assert.rejects(
    hub.createSession({cwd: directory, prompt: ' '}),
    /Prompt/,
  );
  await hub.abortSession(two.id);
  unsubscribe();
  await hub.close();
  assert.ok(parents.every(parent => parent.closed));
  await assert.rejects(
    hub.createSession({cwd: directory, prompt: 'No'}),
    /closed/,
  );
});

void test('standalone factory accepts terminal observations without giving them desktop controls', async t => {
  const parent = controlledParent('desktop', process.cwd());
  const hub = new DashboardHub(
    undefined,
    async () => parent.parent,
    process.cwd(),
  );
  t.after(() => hub.close());
  assert.equal(hub.snapshot().sessions.length, 0);
  assert.equal(hub.snapshot().selectedSessionId, undefined);
  await hub.createSession({cwd: process.cwd(), prompt: 'Work here'});
  await until(() => parent.runs.length === 1);
  const terminal = state('terminal').snapshot();
  terminal.session.status = 'running';
  hub.updateExternal(terminal);
  terminal.session.name = 'External mutation';
  assert.equal(hub.snapshot().sessions[0].session.name, 'terminal');
  assert.equal(hub.snapshot().sessions[0].session.owned, false);
  await assert.rejects(hub.abortSession('terminal'), /connected/);
  hub.closeExternal();
  assert.equal(hub.snapshot().sessions[0].session.status, 'closed');
  assert.equal(hub.snapshot().sessions[1].session.status, 'running');
  await hub.close();
  assert.equal(parent.closed, true);
});

void test('attached Pi conversations accept GUI prompts and aborts while ownership remains separate', async t => {
  const owned = controlledParent('owned', process.cwd());
  const hub = new DashboardHub(undefined, async () => owned.parent);
  t.after(() => hub.close());
  const actions: string[] = [];
  const original = state('attached');
  original.updateSession({sessionFile: '/fixture/primary.jsonl'});
  original.replaceConversation([
    {
      id: 'answer',
      role: 'assistant',
      text: 'Existing public answer',
      at: new Date().toISOString(),
    },
  ]);
  hub.updateExternal(original.snapshot(), [
    queuedPrompt('one'),
    queuedPrompt('two'),
    queuedPrompt('three'),
  ]);
  hub.setExternalControl({
    ...featureControls,
    async prompt(id, prompt) {
      actions.push(`prompt:${id}:${prompt}`);
    },
    async removeQueuedPrompt(id, promptId) {
      actions.push(`remove:${id}:${promptId}`);
    },
    async abort(id) {
      actions.push(`abort:${id}`);
    },
  });
  const attached = hub.snapshot().sessions[0].session;
  assert.equal(attached.owned, false);
  assert.equal(attached.controllable, true);
  assert.equal(attached.pendingPrompts, 3);
  assert.equal(attached.sessionFile, '/fixture/primary.jsonl');
  assert.deepEqual(
    hub.snapshot().sessions[0].conversation,
    original.snapshot().conversation,
  );
  await hub.promptSession('attached', {prompt: ' Follow up '});
  const promptId = attached.queuedPrompts[0].id;
  await hub.removeQueuedPrompt('attached', promptId);
  await hub.abortSession('attached');
  assert.deepEqual(actions, [
    'prompt:attached:Follow up',
    `remove:attached:${promptId}`,
    'abort:attached',
  ]);
  await assert.rejects(hub.promptSession('attached', {prompt: ' '}), /Prompt/);
  await hub.createSession({cwd: process.cwd(), prompt: 'Owned work'});
  await until(() => owned.runs.length === 1);
  assert.equal(hub.snapshot().sessions[1].session.controllable, true);
  hub.closeExternal();
  assert.equal(hub.snapshot().sessions[0].session.controllable, false);
  assert.equal(hub.snapshot().sessions[0].session.pendingPrompts, 0);
  await assert.rejects(
    hub.promptSession('attached', {prompt: 'Stale'}),
    /connected/,
  );
  await assert.rejects(hub.abortSession('attached'), /connected/);
  assert.equal(hub.snapshot().sessions[1].session.status, 'running');
  assert.equal(owned.closed, false);
  await hub.abortSession('owned');
  await hub.close();
  assert.deepEqual(actions, [
    'prompt:attached:Follow up',
    `remove:attached:${promptId}`,
    'abort:attached',
  ]);
  assert.equal(owned.closed, true);
});

void test('closing during parent initialization disposes it before any prompt runs', async t => {
  const gate = Promise.withResolvers<DashboardParent>();
  const parent = controlledParent('pending', process.cwd());
  let creating = false;
  const hub = new DashboardHub(state('terminal'), async () => {
    creating = true;
    return gate.promise;
  });
  t.after(() => hub.close());
  const starting = hub.createSession({
    cwd: process.cwd(),
    prompt: 'Must not run',
  });
  // Register rejection before the initializer is released.
  const rejected = assert.rejects(starting, /closed/);
  await until(() => creating);
  const closing = hub.close();
  gate.resolve(parent.parent);
  await Promise.all([closing, rejected]);
  assert.equal(parent.closed, true);
  assert.equal(parent.runs.length, 0);
});

void test('dashboard snapshots keep transitions, cap history and never mutate source records', () => {
  const view = state('terminal');
  const record: AgentRecord = {
    id: 'drone',
    name: 'Drone',
    cwd: '/project',
    model: 'test/model',
    task: 'x'.repeat(20000),
    createdAt: new Date().toISOString(),
    status: 'queued',
    activity: 'Queued',
    pendingMessages: 1,
  };
  view.updateTeam([record], []);
  view.updateTeam([{...record, status: 'running', activity: 'Using edit'}], []);
  view.updateTeam(
    [
      {
        ...record,
        status: 'completed',
        activity: 'Completed',
        output: 'Finished',
      },
    ],
    [],
  );
  const snapshot = view.snapshot();
  assert.ok(
    snapshot.events.some(event => event.message.startsWith('Dispatched:')),
  );
  assert.equal(snapshot.agents[0].taskTruncated, true);
  snapshot.agents[0].name = 'Mutated';
  snapshot.session.name = 'Mutated';
  assert.equal(view.snapshot().agents[0].name, 'Drone');
  assert.equal(record.name, 'Drone');
  for (let count = 0; count < 200; count++) view.record('tool', String(count));
  assert.equal(view.snapshot().events.length, 160);
  assert.equal(view.snapshot().events.at(-1)?.message, '199');
});

void test('workspace diff includes staged, unstaged and untracked files without following symlinks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varisdev-workspace-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const cwd = join(directory, 'repo');
  await mkdir(cwd);
  assert.equal((await readWorkspaceDiff(cwd)).git, false);
  await execFile('git', ['init', cwd]);
  await writeFile(join(cwd, 'tracked.txt'), 'before\n');
  await execFile('git', ['-C', cwd, 'add', '.']);
  const unborn = await readWorkspaceDiff(cwd);
  assert.match(unborn.diff, /\+before/);
  await execFile('git', [
    '-C',
    cwd,
    '-c',
    'user.name=Dashboard Test',
    '-c',
    'user.email=dashboard@test.invalid',
    'commit',
    '-m',
    'Initial',
  ]);
  await writeFile(join(cwd, 'tracked.txt'), 'staged\n');
  await execFile('git', ['-C', cwd, 'add', '.']);
  await writeFile(join(cwd, 'tracked.txt'), 'working\n');
  await writeFile(join(cwd, 'new.txt'), 'new content\n');
  await writeFile(join(directory, 'outside.txt'), 'outside secret marker');
  await symlink(join(directory, 'outside.txt'), join(cwd, 'link.txt'));
  const diff = await readWorkspaceDiff(cwd);
  assert.equal(diff.git, true);
  assert.ok(
    diff.files.some(
      file => file.path === 'tracked.txt' && file.status === 'MM',
    ),
  );
  assert.match(diff.diff, /-before/);
  assert.match(diff.diff, /\+working/);
  assert.match(diff.diff, /\+new content/);
  assert.doesNotMatch(diff.diff, /outside secret marker/);
  assert.match(diff.diff, /symlink/);
  assert.equal(await readFile(join(cwd, 'tracked.txt'), 'utf8'), 'working\n');
});

void test('standalone queued prompts retain stable IDs through preflight and removal prevents handoff', async t => {
  const credentials = Promise.withResolvers<void>();
  let validating = false;
  const submitted: string[] = [];
  const parent: DashboardParent = {
    ...featureControls,
    state: state('preflight'),
    async prompt(text, delivery) {
      validating = true;
      await credentials.promise;
      if (!delivery.isQueued()) return;
      delivery.submitted();
      submitted.push(text);
    },
    async abort() {
      credentials.resolve();
    },
    async close() {
      credentials.resolve();
    },
  };
  const hub = new DashboardHub(undefined, async () => parent);
  t.after(() => hub.close());
  const {id} = await hub.createSession({
    cwd: process.cwd(),
    prompt: 'Await credentials',
  });
  await until(() => validating);
  await hub.promptSession(id, {prompt: 'Next task'});
  const snapshot = hub.snapshot().sessions[0].session;
  assert.deepEqual(
    snapshot.queuedPrompts.map(item => item.text),
    ['Await credentials', 'Next task'],
  );
  const firstId = snapshot.queuedPrompts[0].id;
  const nextId = snapshot.queuedPrompts[1].id;
  assert.notEqual(firstId, nextId);
  assert.ok(Number.isFinite(Date.parse(snapshot.queuedPrompts[0].queuedAt)));
  snapshot.queuedPrompts[0].text = 'Snapshot mutation';
  snapshot.queuedPrompts.pop();
  assert.equal(
    hub.snapshot().sessions[0].session.queuedPrompts[0].text,
    'Await credentials',
  );
  assert.equal(hub.snapshot().sessions[0].session.pendingPrompts, 2);
  await assert.rejects(hub.removeQueuedPrompt('missing', firstId), /Unknown/);
  await hub.removeQueuedPrompt(id, firstId);
  await assert.rejects(hub.removeQueuedPrompt(id, firstId), /no longer queued/);
  assert.equal(hub.snapshot().sessions[0].session.queuedPrompts[0].id, nextId);
  credentials.resolve();
  await until(() => submitted.length === 1);
  assert.deepEqual(submitted, ['Next task']);
  assert.equal(hub.snapshot().sessions[0].session.pendingPrompts, 0);
  await assert.rejects(hub.removeQueuedPrompt(id, nextId), /no longer queued/);
});

void test('queued prompt removal preserves the active run and other sessions and queues are bounded', async t => {
  const parents = [
    controlledParent('one', process.cwd()),
    controlledParent('two', process.cwd()),
  ];
  let created = 0;
  const hub = new DashboardHub(
    undefined,
    async () => parents[created++].parent,
  );
  t.after(() => hub.close());
  await hub.createSession({cwd: process.cwd(), prompt: 'Active one'});
  await hub.createSession({cwd: process.cwd(), prompt: 'Active two'});
  await until(() => parents.every(parent => parent.runs.length === 1));
  await hub.promptSession('two', {prompt: 'Two later'});
  for (let index = 0; index < 32; index++)
    await hub.promptSession('one', {prompt: `${index}:${'x'.repeat(63997)}`});
  await assert.rejects(
    hub.promptSession('one', {prompt: 'overflow'}),
    /32 queued/,
  );
  await assert.rejects(
    hub.promptSession('two', {prompt: 'x'.repeat(64001)}),
    /64000/,
  );
  const one = hub.snapshot().sessions[0].session.queuedPrompts;
  const otherId = hub.snapshot().sessions[1].session.queuedPrompts[0].id;
  await assert.rejects(
    hub.removeQueuedPrompt('one', otherId),
    /no longer queued/,
  );
  await hub.removeQueuedPrompt('one', one[5].id);
  assert.equal(hub.snapshot().sessions[0].session.pendingPrompts, 31);
  assert.equal(hub.snapshot().sessions[1].session.queuedPrompts[0].id, otherId);
  assert.equal(parents[0].runs.length, 1);
  assert.equal(hub.snapshot().sessions[0].session.status, 'running');
  await hub.abortSession('one');
  assert.equal(hub.snapshot().sessions[0].session.pendingPrompts, 0);
  assert.equal(hub.snapshot().sessions[1].session.pendingPrompts, 1);
});

void test('external queued prompt snapshots are isolated and reject invalid or excessive data', async t => {
  const hub = new DashboardHub(undefined, async () => {
    throw new Error('Unused');
  });
  t.after(() => hub.close());
  const external = state('external');
  external.updateSession({context: {tokens: 1, window: 100, percent: 1}});
  const prompts = [queuedPrompt('Visible task')];
  hub.updateExternal(external.snapshot(), prompts);
  prompts[0].text = 'Input mutation';
  const snapshot = hub.snapshot();
  snapshot.sessions[0].session.queuedPrompts[0].text = 'Output mutation';
  snapshot.sessions[0].session.context!.tokens = 99;
  assert.equal(
    hub.snapshot().sessions[0].session.queuedPrompts[0].text,
    'Visible task',
  );
  assert.equal(hub.snapshot().sessions[0].session.context!.tokens, 1);
  const valid = queuedPrompt('Valid');
  for (const invalid of [
    [valid, valid],
    Array.from({length: 33}, () => queuedPrompt('Overflow')),
    [{...valid, text: 'x'.repeat(64001)}],
    [{...valid, queuedAt: 'invalid'}],
    [{...valid, id: '!invalid'}],
  ])
    assert.throws(
      () => hub.updateExternal(external.snapshot(), invalid),
      /Invalid queued/,
    );
  assert.equal(hub.snapshot().sessions[0].session.pendingPrompts, 1);
  hub.closeExternal();
  assert.deepEqual(hub.snapshot().sessions[0].session.queuedPrompts, []);
});

void test('native feature controls preserve catalog isolation and serialize changes against queued work', async t => {
  const current = controlledParent('features', process.cwd());
  const catalog = features();
  catalog.commands.push({
    name: 'skill:build',
    description: 'Build it',
    source: 'skill',
    path: '/fixture/SKILL.md',
  });
  catalog.models.push({
    provider: 'fixture',
    id: 'model',
    name: 'Fixture model',
  });
  const actions: unknown[] = [];
  const compacting = Promise.withResolvers<void>();
  current.parent.features = async () => catalog;
  current.parent.configure = async input => {
    actions.push(input);
  };
  current.parent.compact = async instructions => {
    actions.push(instructions);
    await compacting.promise;
  };
  current.parent.reload = async () => {
    actions.push('reload');
  };
  const hub = new DashboardHub(undefined, async () => current.parent);
  t.after(() => hub.close());
  await hub.createSession({cwd: process.cwd(), prompt: 'Initial work'});
  await until(() => current.runs.length === 1);
  const snapshot = await hub.sessionFeatures('features');
  snapshot.commands[0].name = 'Mutation';
  assert.equal(
    (await hub.sessionFeatures('features')).commands[0].name,
    'skill:build',
  );
  await assert.rejects(
    hub.configureSession('features', {thinkingLevel: 'high'}),
    /idle/,
  );
  current.runs[0].resolve();
  await until(() => hub.snapshot().sessions[0].session.status === 'idle');
  await hub.configureSession('features', {
    provider: 'fixture',
    modelId: 'model',
    thinkingLevel: 'high',
  });
  await assert.rejects(
    hub.configureSession('features', {provider: 'fixture'}),
    /Model/,
  );
  await assert.rejects(
    hub.configureSession('features', {unknown: true}),
    /Unknown/,
  );
  const compact = hub.compactSession('features', ' Keep decisions ');
  await assert.rejects(
    hub.promptSession('features', {prompt: 'During compaction'}),
    /updating/,
  );
  await assert.rejects(hub.reloadSession('features'), /idle/);
  compacting.resolve();
  await compact;
  await hub.reloadSession('features');
  assert.deepEqual(actions, [
    {provider: 'fixture', modelId: 'model', thinkingLevel: 'high'},
    'Keep decisions',
    'reload',
  ]);
  await assert.rejects(hub.sessionFeatures('missing'), /Unknown/);
});

void test('native extension dialogs appear in hub snapshots and receive validated responses during active work', async t => {
  const current = controlledParent('dialogs', process.cwd());
  const hub = new DashboardHub(undefined, async () => current.parent);
  let changes = 0;
  current.parent.ui = new DesktopExtensionUI(() => {
    changes++;
    current.parent.state.record('session', 'Extension UI changed');
  });
  t.after(async () => {
    current.parent.ui!.dispose();
    await hub.close();
  });
  await hub.createSession({cwd: process.cwd(), prompt: 'Wait for input'});
  await until(() => current.runs.length === 1);
  const response = current.parent.ui.context.select('Choose one', [
    'One',
    'Two',
  ]);
  const snapshot = hub.snapshot().sessions[0];
  const dialogId = snapshot.ui!.dialogs[0].id;
  assert.equal(snapshot.ui!.dialogs[0].title, 'Choose one');
  snapshot.ui!.dialogs[0].options![0] = 'Snapshot mutation';
  assert.equal(hub.snapshot().sessions[0].ui!.dialogs[0].options![0], 'One');
  await assert.rejects(
    hub.respondToDialog('missing', dialogId, 'One'),
    /Unknown/,
  );
  await assert.rejects(
    hub.respondToDialog('dialogs', dialogId, true),
    /Invalid/,
  );
  await assert.rejects(
    hub.respondToDialog('dialogs', dialogId, 'Other'),
    /options/,
  );
  await hub.respondToDialog('dialogs', dialogId, 'Two');
  assert.equal(await response, 'Two');
  assert.deepEqual(hub.snapshot().sessions[0].ui!.dialogs, []);
  await assert.rejects(
    hub.respondToDialog('dialogs', dialogId, 'One'),
    /no longer waiting/,
  );
  assert.ok(changes >= 2);
  assert.equal(current.runs.length, 1);
  current.parent.ui.context.addAutocompleteProvider(provider => provider);
  const editorId = hub.snapshot().sessions[0].ui!.extensionEditor!.id;
  await hub.respondToDialog('dialogs', editorId, 'Current draft');
  await until(
    () =>
      hub
        .snapshot()
        .sessions[0].ui!.dialogs[0]?.terminal?.output.includes(
          'Current draft',
        ) === true,
  );
  const terminalId = hub.snapshot().sessions[0].ui!.dialogs[0].id;
  await hub.respondToDialog('dialogs', terminalId, undefined);
  assert.deepEqual(hub.snapshot().sessions[0].ui!.dialogs, []);
});

void test('native reload reconnects hub observation when the SDK replaces its dashboard state', async t => {
  const current = controlledParent('reloaded', process.cwd());
  const hub = new DashboardHub(undefined, async () => current.parent);
  t.after(() => hub.close());
  await hub.createSession({cwd: process.cwd(), prompt: 'Initial'});
  await until(() => current.runs.length === 1);
  current.runs[0].resolve();
  await until(() => hub.snapshot().sessions[0].session.status === 'idle');
  const replacement = state('reloaded');
  current.parent.reload = async () => {
    current.parent.state = replacement;
  };
  let changes = 0;
  hub.subscribe(() => {
    changes++;
  });
  await hub.reloadSession('reloaded');
  const before = changes;
  replacement.record('message', 'Observed after reload');
  assert.ok(changes > before);
  assert.equal(
    hub.snapshot().sessions[0].events.at(-1)?.message,
    'Observed after reload',
  );
});
