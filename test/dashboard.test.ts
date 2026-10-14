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
import {DashboardHub, type DashboardParent} from '../src/dashboard/hub.ts';
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
  cancelAgent: async () => {},
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
  const cancellations: string[] = [];
  let closed = false;
  let active = 0;
  let maximum = 0;
  const parent: DashboardParent = {
    ...featureControls,
    state: current,
    restartSnapshot() {
      throw new Error('This test parent cannot restart.');
    },
    async cancelAgent(agentId) {
      cancellations.push(agentId);
    },
    async prompt(text) {
      current.updateSession({status: 'running', activity: 'Working'});
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
      for (const run of runs) run.resolve();
      return {steering: [], followUp: []};
    },
    async close() {
      await parent.abort();
      closed = true;
    },
  };
  return {
    parent,
    runs,
    cancellations,
    get closed() {
      return closed;
    },
    get maximum() {
      return maximum;
    },
  };
}

void test('dashboard keeps parallel parents isolated, forwards prompts immediately and stops active work', async t => {
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
  const one = await hub.createSession({cwd: folders[0]});
  const two = await hub.createSession({cwd: folders[1]});
  assert.ok(parents.every(parent => parent.runs.length === 0));
  assert.ok(
    hub
      .snapshot()
      .sessions.filter(item => item.session.owned)
      .every(item => item.session.status === 'idle'),
  );
  await hub.promptSession(one.id, {prompt: 'Task 0'});
  await hub.promptSession(two.id, {prompt: 'Task 1'});
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
  await until(() => parents[0].runs.length === 3);
  assert.deepEqual(
    parents[0].runs.map(run => run.text),
    ['Task 0', 'Follow up', 'Never run'],
  );
  await hub.cancelAgent(one.id, 'worker');
  assert.deepEqual(parents[0].cancellations, ['worker']);
  assert.deepEqual(parents[1].cancellations, []);
  await assert.rejects(hub.cancelAgent(one.id, {}), /Agent ID/);
  await assert.rejects(hub.cancelAgent('missing', 'all'), /Unknown parent/);
  await hub.abortSession(one.id);
  assert.equal(parents[0].runs.length, 3);
  assert.equal(parents[0].maximum, 3);
  assert.equal(hub.snapshot().sessions[2].session.status, 'running');
  assert.ok(notifications > 5);
  await assert.rejects(
    hub.promptSession('terminal', {prompt: 'No'}),
    /terminal/,
  );
  await assert.rejects(hub.promptSession('missing', {prompt: 'No'}), /Unknown/);
  await assert.rejects(hub.createSession({cwd: '.'}), /absolute/);
  await assert.rejects(hub.createSession({cwd: ' '}), /Folder/);
  await hub.abortSession(two.id);
  unsubscribe();
  await hub.close();
  assert.ok(parents.every(parent => parent.closed));
  await assert.rejects(hub.createSession({cwd: directory}), /closed/);
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
  await hub.createSession({cwd: process.cwd()});
  await hub.promptSession('desktop', {prompt: 'Work here'});
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
  hub.updateExternal(original.snapshot());
  hub.setExternalControl({
    ...featureControls,
    async prompt(id, prompt) {
      actions.push(`prompt:${id}:${prompt}`);
    },
    async cancelAgent(id, agentId) {
      actions.push(`cancel:${id}:${agentId}`);
    },
    async abort(id) {
      actions.push(`abort:${id}`);
      return {steering: [], followUp: []};
    },
  });
  const attached = hub.snapshot().sessions[0].session;
  assert.equal(attached.owned, false);
  assert.equal(attached.controllable, true);
  assert.equal(attached.sessionFile, '/fixture/primary.jsonl');
  assert.deepEqual(
    hub.snapshot().sessions[0].conversation,
    original.snapshot().conversation,
  );
  await hub.promptSession('attached', {prompt: ' Follow up '});
  await hub.abortSession('attached');
  await hub.cancelAgent('attached', 'all');
  assert.deepEqual(actions, [
    'prompt:attached:Follow up',
    'abort:attached',
    'cancel:attached:all',
  ]);
  await assert.rejects(hub.promptSession('attached', {prompt: ' '}), /Prompt/);
  await hub.createSession({cwd: process.cwd()});
  await hub.promptSession('owned', {prompt: 'Owned work'});
  await until(() => owned.runs.length === 1);
  assert.equal(hub.snapshot().sessions[1].session.controllable, true);
  hub.closeExternal();
  assert.equal(hub.snapshot().sessions[0].session.controllable, false);
  await assert.rejects(
    hub.promptSession('attached', {prompt: 'Stale'}),
    /connected/,
  );
  await assert.rejects(hub.abortSession('attached'), /connected/);
  await assert.rejects(hub.cancelAgent('attached', 'all'), /connected/);
  assert.equal(hub.snapshot().sessions[1].session.status, 'running');
  assert.equal(owned.closed, false);
  await hub.abortSession('owned');
  await hub.close();
  await assert.rejects(hub.cancelAgent('attached', 'all'), /closed/);
  assert.deepEqual(actions, [
    'prompt:attached:Follow up',
    'abort:attached',
    'cancel:attached:all',
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
    id: 'agent',
    name: 'Agent',
    cwd: '/project',
    model: 'test/model',
    task: 'x'.repeat(20000),
    createdAt: new Date().toISOString(),
    status: 'queued',
    activity: 'Queued',
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
  assert.equal(view.snapshot().agents[0].name, 'Agent');
  assert.equal(record.name, 'Agent');
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

void test('native feature controls allow live configuration and keep maintenance idle-only', async t => {
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
  await hub.createSession({cwd: process.cwd()});
  await hub.promptSession('features', {prompt: 'Initial work'});
  await until(() => current.runs.length === 1);
  const snapshot = await hub.sessionFeatures('features');
  snapshot.commands[0].name = 'Mutation';
  assert.equal(
    (await hub.sessionFeatures('features')).commands[0].name,
    'skill:build',
  );
  await hub.configureSession('features', {thinkingLevel: 'high'});
  await assert.rejects(hub.compactSession('features'), /idle/);
  await assert.rejects(hub.reloadSession('features'), /idle/);
  assert.equal(hub.snapshot().sessions[0].session.status, 'running');
  current.runs[0].resolve();
  await until(() => hub.snapshot().sessions[0].session.status === 'idle');
  await nextTick();
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
  await assert.rejects(
    hub.configureSession('features', {thinkingLevel: 'high'}),
    /idle/,
  );
  compacting.resolve();
  await compact;
  await hub.reloadSession('features');
  assert.deepEqual(actions, [
    {thinkingLevel: 'high'},
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
  await hub.createSession({cwd: process.cwd()});
  await hub.promptSession('dialogs', {prompt: 'Wait for input'});
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
  await hub.createSession({cwd: process.cwd()});
  await hub.promptSession('reloaded', {prompt: 'Initial'});
  await until(() => current.runs.length === 1);
  current.runs[0].resolve();
  await until(() => hub.snapshot().sessions[0].session.status === 'idle');
  await nextTick();
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
