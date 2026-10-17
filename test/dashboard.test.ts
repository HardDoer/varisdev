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
import {ModelRuntime, SessionManager} from '@earendil-works/pi-coding-agent';
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

void test('closing an owned session awaits parent cleanup and active prompts exactly once', async t => {
  const promptGate = Promise.withResolvers<void>();
  const closeGate = Promise.withResolvers<void>();
  const current = state('closable');
  let promptStarted = false;
  let closeCalls = 0;
  const parent: DashboardParent = {
    ...featureControls,
    state: current,
    restartSnapshot() {
      throw new Error('This test parent cannot restart.');
    },
    async prompt() {
      promptStarted = true;
      await promptGate.promise;
    },
    async abort() {
      return {steering: [], followUp: []};
    },
    async close() {
      closeCalls++;
      await closeGate.promise;
    },
  };
  const hub = new DashboardHub(undefined, async () => parent);
  t.after(async () => {
    promptGate.resolve();
    closeGate.resolve();
    await hub.close();
  });
  await hub.createSession({cwd: process.cwd()});
  await hub.promptSession('closable', {prompt: 'Keep working'});
  await until(() => promptStarted);
  let changes = 0;
  hub.subscribe(() => changes++);
  const first = hub.closeSession('closable');
  const second = hub.closeSession('closable');
  await until(() => closeCalls === 1);
  assert.equal(hub.snapshot().sessions.length, 1);
  assert.equal(hub.snapshot().sessions[0].session.activity, 'Closing');
  assert.equal(hub.snapshot().sessions[0].session.controllable, false);
  assert.equal(hub.snapshot().selectedSessionId, 'closable');
  await assert.rejects(
    hub.promptSession('closable', {prompt: 'Too late'}),
    /closing/,
  );
  await assert.rejects(hub.reloadSession('closable'), /closing/);
  await assert.rejects(hub.abortSession('closable'), /closing/);
  await assert.rejects(hub.cancelAgent('closable', 'all'), /closing/);
  current.updateSession({activity: 'Late parent update'});
  assert.equal(hub.snapshot().sessions[0].session.activity, 'Closing');
  let closed = false;
  void first.then(() => {
    closed = true;
  });
  closeGate.resolve();
  await nextTick();
  assert.equal(closed, false);
  promptGate.resolve();
  await Promise.all([first, second]);
  assert.equal(closed, true);
  assert.equal(closeCalls, 1);
  assert.deepEqual(hub.snapshot().sessions, []);
  assert.equal(hub.snapshot().selectedSessionId, undefined);
  const afterRemoval = changes;
  current.updateSession({activity: 'Update after removal'});
  assert.equal(changes, afterRemoval);
});

void test('a failed close remains visible and can be retried', async t => {
  const current = controlledParent('retry-close', process.cwd());
  let attempts = 0;
  current.parent.close = async () => {
    attempts++;
    if (attempts === 1) throw new Error('cleanup is busy');
  };
  const hub = new DashboardHub(undefined, async () => current.parent);
  t.after(() => hub.close());
  await hub.createSession({cwd: process.cwd()});
  await assert.rejects(hub.closeSession('retry-close'), /cleanup is busy/);
  const failed = hub.snapshot().sessions[0].session;
  assert.equal(failed.id, 'retry-close');
  assert.equal(failed.status, 'idle');
  assert.equal(failed.controllable, true);
  assert.match(failed.activity, /Close failed: cleanup is busy/);
  await hub.closeSession('retry-close');
  assert.equal(attempts, 2);
  assert.deepEqual(hub.snapshot().sessions, []);
});

void test('closing sessions frees capacity and keeps the selected session valid through the last removal', async t => {
  const parents: ReturnType<typeof controlledParent>[] = [];
  const initial = state('terminal');
  const hub = new DashboardHub(initial, async request => {
    const parent = controlledParent(`owned-${parents.length}`, request.cwd);
    parents.push(parent);
    return parent.parent;
  });
  t.after(() => hub.close());
  const opened = await Promise.all(
    Array.from({length: 8}, () => hub.createSession({cwd: process.cwd()})),
  );
  await assert.rejects(
    hub.createSession({cwd: process.cwd()}),
    /eight parent sessions/,
  );
  const closeGate = Promise.withResolvers<void>();
  const closeFirst = parents[0].parent.close.bind(parents[0].parent);
  parents[0].parent.close = async () => {
    await closeGate.promise;
    await closeFirst();
  };
  assert.equal(hub.snapshot().selectedSessionId, 'terminal');
  let changes = 0;
  hub.subscribe(() => changes++);
  await hub.closeSession('terminal');
  assert.equal(hub.snapshot().selectedSessionId, opened[0].id);
  const afterInitialRemoval = changes;
  initial.record('session', 'Late terminal update');
  assert.equal(changes, afterInitialRemoval);
  const closing = hub.closeSession(opened[0].id);
  await assert.rejects(
    hub.createSession({cwd: process.cwd()}),
    /eight parent sessions/,
  );
  assert.equal(hub.snapshot().sessions[0].session.id, opened[0].id);
  assert.equal(hub.snapshot().sessions[0].session.activity, 'Closing');
  closeGate.resolve();
  await closing;
  const afterClose = hub.snapshot();
  assert.ok(
    afterClose.sessions.some(
      item => item.session.id === afterClose.selectedSessionId,
    ),
  );
  assert.notEqual(afterClose.selectedSessionId, opened[0].id);
  const replacement = await hub.createSession({cwd: process.cwd()});
  assert.equal(replacement.id, 'owned-8');
  assert.equal(
    hub.snapshot().sessions.filter(item => item.session.owned).length,
    8,
  );
  await Promise.all(
    hub.snapshot().sessions.map(item => hub.closeSession(item.session.id)),
  );
  assert.deepEqual(hub.snapshot().sessions, []);
  assert.equal(hub.snapshot().selectedSessionId, undefined);
  assert.ok(parents.every(parent => parent.closed));
});

void test('resuming a saved session waits for its successful close and preserves the saved file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varisdev-close-resume-'));
  const savedPath = join(directory, 'saved-session.jsonl');
  const id = 'saved-session';
  await writeFile(savedPath, 'saved history\n');
  let listed = false;
  t.mock.method(SessionManager, 'list', async () => {
    listed = true;
    return [
      {
        id,
        name: 'Saved work',
        firstMessage: 'Saved prompt',
        modified: new Date(),
        messageCount: 1,
        path: savedPath,
      },
    ];
  });
  const closeGate = Promise.withResolvers<void>();
  const first = controlledParent(id, directory);
  let closeCalls = 0;
  first.parent.close = async () => {
    closeCalls++;
    await closeGate.promise;
  };
  const reopened = controlledParent(id, directory);
  const requests: Array<{cwd: string; resume?: {id: string; path: string}}> =
    [];
  const hub = new DashboardHub(undefined, async request => {
    requests.push(request);
    return reopened.parent;
  });
  t.after(async () => {
    closeGate.resolve();
    await hub.close();
    await rm(directory, {recursive: true, force: true});
  });
  hub.adoptSession(first.parent);
  const closing = hub.closeSession(id);
  const resuming = hub.createSession({cwd: directory, sessionId: id});
  await until(() => listed);
  assert.equal(requests.length, 0);
  assert.equal(hub.snapshot().sessions[0].session.activity, 'Closing');
  closeGate.resolve();
  await closing;
  assert.deepEqual(await resuming, {id});
  assert.equal(closeCalls, 1);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].resume, {id, path: savedPath});
  assert.equal(await readFile(savedPath, 'utf8'), 'saved history\n');
  assert.equal(hub.snapshot().sessions[0].session.id, id);
  assert.equal(hub.snapshot().sessions[0].session.owned, true);
});

void test('resuming history replaces only other sessions from the same folder', async t => {
  const root = await mkdtemp(join(tmpdir(), 'varisdev-resume-replace-'));
  const project = join(root, 'project');
  const otherProject = join(root, 'other');
  await Promise.all([mkdir(project), mkdir(otherProject)]);
  const savedPath = join(project, 'saved.jsonl');
  await writeFile(savedPath, 'saved history\n');
  t.mock.method(SessionManager, 'list', async () => [
    {
      id: 'saved',
      name: 'Saved',
      firstMessage: 'Earlier work',
      modified: new Date(),
      messageCount: 1,
      path: savedPath,
    },
  ]);
  const sameFolder = controlledParent('same-folder', project);
  const otherFolder = controlledParent('other-folder', otherProject);
  const resumed = controlledParent('saved', project);
  const hub = new DashboardHub(undefined, async request => {
    assert.deepEqual(request.resume, {id: 'saved', path: savedPath});
    return resumed.parent;
  });
  t.after(async () => {
    await hub.close();
    await rm(root, {recursive: true, force: true});
  });
  hub.adoptSession(sameFolder.parent);
  hub.adoptSession(otherFolder.parent);
  await hub.promptSession('same-folder', {prompt: 'Busy work'});
  await until(() => sameFolder.runs.length === 1);

  assert.deepEqual(
    await hub.createSession({cwd: project, sessionId: 'saved'}),
    {
      id: 'saved',
    },
  );
  assert.equal(sameFolder.closed, true);
  assert.equal(otherFolder.closed, false);
  assert.equal(resumed.closed, false);
  assert.deepEqual(
    hub.snapshot().sessions.map(item => item.session.id),
    ['other-folder', 'saved'],
  );

  // Selecting the resumed session again keeps that target but still replaces
  // another session subsequently opened in the same folder.
  const anotherSameFolder = controlledParent('another-same-folder', project);
  hub.adoptSession(anotherSameFolder.parent);
  assert.deepEqual(
    await hub.createSession({cwd: project, sessionId: 'saved'}),
    {
      id: 'saved',
    },
  );
  assert.equal(resumed.closed, false);
  assert.equal(anotherSameFolder.closed, true);
  assert.equal(otherFolder.closed, false);
});

void test('resume creation and replacement-close failures preserve the old session', async t => {
  const project = await mkdtemp(join(tmpdir(), 'varisdev-resume-failure-'));
  const savedPath = join(project, 'saved.jsonl');
  await writeFile(savedPath, 'saved history\n');
  t.mock.method(SessionManager, 'list', async () => [
    {
      id: 'saved',
      name: 'Saved',
      firstMessage: 'Earlier work',
      modified: new Date(),
      messageCount: 1,
      path: savedPath,
    },
  ]);
  const old = controlledParent('old', project);
  let failCreation = true;
  const resumed = controlledParent('saved', project);
  const hub = new DashboardHub(undefined, async () => {
    if (failCreation) throw new Error('resume initialization failed');
    return resumed.parent;
  });
  t.after(async () => {
    await hub.close();
    await rm(project, {recursive: true, force: true});
  });
  hub.adoptSession(old.parent);

  await assert.rejects(
    hub.createSession({cwd: project, sessionId: 'saved'}),
    /resume initialization failed/,
  );
  assert.equal(old.closed, false);
  assert.deepEqual(
    hub.snapshot().sessions.map(item => item.session.id),
    ['old'],
  );

  failCreation = false;
  old.parent.close = async () => {
    throw new Error('old session cleanup failed');
  };
  await assert.rejects(
    hub.createSession({cwd: project, sessionId: 'saved'}),
    /old session cleanup failed/,
  );
  assert.equal(resumed.closed, true);
  assert.deepEqual(
    hub.snapshot().sessions.map(item => item.session.id),
    ['old'],
  );
  assert.match(
    hub.snapshot().sessions[0].session.activity,
    /Close failed: old session cleanup failed/,
  );
});

void test('same-folder resumes serialize concurrent replacement choices', async t => {
  const project = await mkdtemp(join(tmpdir(), 'varisdev-resume-concurrent-'));
  const paths = {
    first: join(project, 'first.jsonl'),
    second: join(project, 'second.jsonl'),
  };
  await Promise.all(
    Object.values(paths).map(path => writeFile(path, 'saved\n')),
  );
  t.mock.method(SessionManager, 'list', async () =>
    Object.entries(paths).map(([id, path]) => ({
      id,
      name: id,
      firstMessage: id,
      modified: new Date(),
      messageCount: 1,
      path,
    })),
  );
  const old = controlledParent('old', project);
  const parents = {
    first: controlledParent('first', project),
    second: controlledParent('second', project),
  };
  let active = 0;
  let maximum = 0;
  const hub = new DashboardHub(undefined, async request => {
    active++;
    maximum = Math.max(maximum, active);
    await nextTick();
    active--;
    return parents[request.resume!.id as keyof typeof parents].parent;
  });
  t.after(async () => {
    await hub.close();
    await rm(project, {recursive: true, force: true});
  });
  hub.adoptSession(old.parent);

  const [first, second] = await Promise.all([
    hub.createSession({cwd: project, sessionId: 'first'}),
    hub.createSession({cwd: project, sessionId: 'second'}),
  ]);
  assert.deepEqual(first, {id: 'first'});
  assert.deepEqual(second, {id: 'second'});
  assert.equal(maximum, 1);
  assert.equal(old.closed, true);
  assert.equal(Number(parents.first.closed) + Number(parents.second.closed), 1);
  const remaining = hub.snapshot().sessions.map(item => item.session.id);
  assert.equal(remaining.length, 1);
  assert.ok(remaining[0] === 'first' || remaining[0] === 'second');
});

void test('a same-folder resume can replace one of eight parents without exceeding capacity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'varisdev-resume-capacity-'));
  const project = join(root, 'project');
  await mkdir(project);
  const savedPath = join(project, 'saved.jsonl');
  await writeFile(savedPath, 'saved\n');
  t.mock.method(SessionManager, 'list', async () => [
    {
      id: 'saved',
      name: 'Saved',
      firstMessage: 'Saved',
      modified: new Date(),
      messageCount: 1,
      path: savedPath,
    },
  ]);
  const existing = controlledParent('replace-me', project);
  const unrelated: ReturnType<typeof controlledParent>[] = [];
  for (let index = 0; index < 7; index++) {
    const cwd = join(root, `other-${index}`);
    await mkdir(cwd);
    unrelated.push(controlledParent(`other-${index}`, cwd));
  }
  const resumed = controlledParent('saved', project);
  const hub = new DashboardHub(undefined, async () => resumed.parent);
  t.after(async () => {
    await hub.close();
    await rm(root, {recursive: true, force: true});
  });
  hub.adoptSession(existing.parent);
  for (const parent of unrelated) hub.adoptSession(parent.parent);

  assert.equal(hub.snapshot().sessions.length, 8);
  assert.deepEqual(
    await hub.createSession({cwd: project, sessionId: 'saved'}),
    {
      id: 'saved',
    },
  );
  assert.equal(existing.closed, true);
  assert.equal(hub.snapshot().sessions.length, 8);
  assert.ok(unrelated.every(parent => !parent.closed));
  assert.equal(resumed.closed, false);
});

void test('closing during reload and abort waits for each operation without restoring removed sessions', async () => {
  for (const action of ['reload', 'abort'] as const) {
    const gate = Promise.withResolvers<void>();
    const current = controlledParent(action, process.cwd());
    const replacement = state(`${action}-replacement`);
    let started = false;
    current.parent.close = async () => {};
    if (action === 'reload') {
      current.parent.reload = async () => {
        started = true;
        await gate.promise;
        current.parent.state = replacement;
      };
    } else {
      current.parent.abort = async () => {
        started = true;
        await gate.promise;
        return {steering: [], followUp: []};
      };
    }
    const hub = new DashboardHub(undefined, async () => current.parent);
    await hub.createSession({cwd: process.cwd()});
    const pending =
      action === 'reload'
        ? hub.reloadSession(action)
        : hub.abortSession(action);
    await until(() => started);
    const closing = hub.closeSession(action);
    assert.equal(hub.snapshot().sessions.length, 1);
    assert.equal(hub.snapshot().sessions[0].session.activity, 'Closing');
    assert.equal(hub.snapshot().sessions[0].session.controllable, false);
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await nextTick();
    assert.equal(closed, false);
    gate.resolve();
    await Promise.all([pending, closing]);
    replacement.record('session', 'Update after removal');
    assert.deepEqual(hub.snapshot().sessions, []);
    await hub.close();
  }
});

void test('dismissing external sessions ignores stale updates but allows fresh IDs and deliberate reopening', async t => {
  const reopened = controlledParent('external-b', process.cwd());
  const hub = new DashboardHub(undefined, async () => reopened.parent);
  t.after(() => hub.close());
  const actions: string[] = [];
  hub.updateExternal(state('external-a').snapshot());
  hub.setExternalControl({
    ...featureControls,
    async prompt(id) {
      actions.push(`prompt:${id}`);
    },
    async abort(id) {
      actions.push(`abort:${id}`);
      return {steering: [], followUp: []};
    },
  });
  await Promise.all([
    hub.closeSession('external-a'),
    hub.closeSession('external-a'),
  ]);
  assert.deepEqual(hub.snapshot().sessions, []);
  hub.updateExternal(state('external-a').snapshot());
  assert.deepEqual(hub.snapshot().sessions, []);
  hub.updateExternal(state('external-b').snapshot());
  assert.equal(hub.snapshot().sessions[0].session.id, 'external-b');
  assert.equal(hub.snapshot().sessions[0].session.owned, false);
  await hub.closeSession('external-b');
  const opened = await hub.createSession({cwd: process.cwd()});
  assert.equal(opened.id, 'external-b');
  assert.equal(hub.snapshot().sessions[0].session.owned, true);
  await hub.closeSession('external-b');
  hub.updateExternal(state('external-b').snapshot());
  assert.equal(hub.snapshot().sessions[0].session.owned, false);
  assert.deepEqual(actions, []);
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
        output: 'x'.repeat(12000),
        outputTruncated: true,
        resultFile: '/project/result.txt',
      },
    ],
    [],
  );
  const snapshot = view.snapshot();
  assert.ok(
    snapshot.events.some(event => event.message.startsWith('Dispatched:')),
  );
  assert.equal(snapshot.agents[0].taskTruncated, true);
  assert.equal(snapshot.agents[0].outputTruncated, true);
  assert.equal(snapshot.agents[0].resultFile, '/project/result.txt');
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
  // A custom temporary directory may itself live inside a Git checkout.
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = directory;
  t.after(() => {
    if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = ceiling;
  });
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

void test('native feature controls stay live during compaction and keep reload idle-only', async t => {
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
    current.parent.state.updateSession({status: 'compacting'});
    await compacting.promise;
    current.parent.state.updateSession({status: 'idle'});
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
  await assert.rejects(
    hub.configureSession('features', {persist: true}),
    /Choose/,
  );
  await assert.rejects(
    hub.configureSession('features', {thinkingLevel: 'high', persist: 'yes'}),
    /boolean/,
  );

  const compact = hub.compactSession('features', ' Keep decisions ');
  await hub.promptSession('features', {prompt: '/model fixture/model'});
  await until(() => current.runs.length === 2);
  current.runs[1].resolve();
  current.parent.state.updateSession({status: 'compacting'});
  await assert.rejects(hub.reloadSession('features'), /idle/);
  await hub.configureSession('features', {thinkingLevel: 'high'});
  compacting.resolve();
  await compact;
  await hub.reloadSession('features');
  assert.deepEqual(actions, [
    {thinkingLevel: 'high'},
    {provider: 'fixture', modelId: 'model', thinkingLevel: 'high'},
    'Keep decisions',
    {thinkingLevel: 'high'},
    'reload',
  ]);
  await assert.rejects(hub.sessionFeatures('missing'), /Unknown/);
});

void test('native extension dialogs appear in hub snapshots and receive validated responses during active work', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varisdev-dialogs-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const modelsPath = join(directory, 'models.json');
  await writeFile(
    modelsPath,
    JSON.stringify({
      providers: {
        fixture: {
          api: 'openai-completions',
          baseUrl: 'https://fixture.invalid/v1',
          apiKey: 'fixture-key',
          models: [{id: 'alpha', name: 'Alpha model'}],
        },
      },
    }),
  );
  const modelRuntime = await ModelRuntime.create({
    authPath: join(directory, 'auth.json'),
    modelsPath,
    allowModelNetwork: false,
  });
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
  const thinking = current.parent.ui.selectThinking({
    currentLevel: 'off',
    availableLevels: ['off', 'high'],
    defaultLevel: 'high',
  });
  await until(
    () => !!hub.snapshot().sessions[0].ui!.dialogs[0]?.actions?.length,
  );
  const selector = hub.snapshot().sessions[0].ui!.dialogs[0];
  assert.deepEqual(
    selector.actions?.map(action => action.id),
    ['default', 'session'],
  );
  for (const invalid of [
    {action: 'unknown'},
    {action: 'default', extra: true},
    {action: 1},
  ])
    await assert.rejects(
      hub.respondToDialog('dialogs', selector.id, invalid),
      /action/,
    );
  await hub.respondToDialog('dialogs', selector.id, {action: 'default'});
  assert.deepEqual(await thinking, {thinkingLevel: 'off', persist: true});
  const settings = current.parent.ui.selectSessionSettings({
    activeTab: 'model',
    model: {
      currentModel: modelRuntime.getModel('fixture', 'alpha')!,
      modelRuntime,
      scopedModels: [],
    },
    thinking: {
      currentLevel: 'off',
      availableLevels: ['off', 'high'],
    },
  });
  await until(
    () =>
      hub
        .snapshot()
        .sessions[0].ui!.dialogs[0]?.terminal?.output.includes(
          'Alpha model',
        ) === true,
  );
  const settingsDialog = hub.snapshot().sessions[0].ui!.dialogs[0];
  await assert.rejects(
    hub.respondToDialog('dialogs', settingsDialog.id, {
      action: 'tab:unknown',
    }),
    /action/,
  );
  await hub.respondToDialog('dialogs', settingsDialog.id, {
    action: 'tab:thinking',
  });
  await until(
    () =>
      hub.snapshot().sessions[0].ui!.dialogs[0]?.activeTab === 'thinking' &&
      hub
        .snapshot()
        .sessions[0].ui!.dialogs[0]?.terminal?.output.includes(
          'Thinking Level',
        ) === true,
  );
  await hub.respondToDialog('dialogs', settingsDialog.id, {action: 'session'});
  assert.deepEqual(await settings, {
    kind: 'thinking',
    thinkingLevel: 'off',
    persist: false,
  });
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
