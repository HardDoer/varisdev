import assert from 'node:assert/strict';
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import {
  runSessionCommand,
  type SessionCommandResult,
  type SessionCommandUI,
} from '../src/dashboard/session-commands.ts';

function nativeUI() {
  const inputs: Array<string | undefined> = [];
  const confirmations: boolean[] = [];
  const shows: Array<{title: string; message: string}> = [];
  const selects: Array<{title: string; options: string[]; selected?: string}> =
    [];
  const prompts: string[] = [];
  const confirms: Array<{title: string; message: string}> = [];
  let editorText = 'existing draft';
  let choose: (options: string[]) => string | undefined = () => undefined;
  const ui: SessionCommandUI = {
    show: async (title, message) => {
      shows.push({title, message});
    },
    select: async (title, options, config) => {
      selects.push({title, options, selected: config?.selected});
      return choose(options);
    },
    context: {
      input: async title => {
        prompts.push(title);
        return inputs.shift();
      },
      confirm: async (title, message) => {
        confirms.push({title, message});
        return confirmations.shift() ?? false;
      },
      setEditorText: text => {
        editorText = text;
      },
    },
  };
  return {
    ui,
    inputs,
    confirmations,
    shows,
    selects,
    prompts,
    confirms,
    choose: (callback: typeof choose) => {
      choose = callback;
    },
    editor: () => editorText,
  };
}

async function fixture(t: TestContext, memory = false) {
  const root = await mkdtemp(join(tmpdir(), 'varisdev-session-command-'));
  const cwd = join(root, 'project');
  const config = join(root, 'config');
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = config;
  const originalTitle = process.title;
  let session: AgentSession | undefined = undefined;
  t.after(async () => {
    session?.dispose();
    process.title = originalTitle;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, {recursive: true, force: true});
  });
  await mkdir(cwd, {recursive: true});
  await mkdir(config, {recursive: true});
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Session commands must not request a model or network.');
  });
  const control = {cancelTree: false, cancelFork: false, cancelSwitch: false};
  const events: Array<{type: string; entryId?: string; position?: string}> = [];
  const modelRuntime = await ModelRuntime.create({
    authPath: join(config, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const services = await createAgentSessionServices({
    cwd,
    agentDir: config,
    modelRuntime,
    settingsManager: SettingsManager.inMemory({compaction: {enabled: false}}),
    resourceLoaderOptions: {
      noExtensions: true,
      noThemes: true,
      noSkills: true,
      noPromptTemplates: true,
      extensionFactories: [
        pi => {
          pi.on('session_before_tree', event => {
            events.push(event);
            return {cancel: control.cancelTree};
          });
          pi.on('session_before_fork', event => {
            events.push(event);
            return {cancel: control.cancelFork};
          });
          pi.on('session_before_switch', event => {
            events.push(event);
            return {cancel: control.cancelSwitch};
          });
        },
      ],
    },
  });
  const manager = memory
    ? SessionManager.inMemory(cwd)
    : SessionManager.create(cwd, join(root, 'live'));
  const first = manager.appendMessage({
    role: 'user',
    content: 'First user request\nwith detail',
    timestamp: 1,
  });
  const answer = manager.appendMessage({
    role: 'assistant',
    content: [{type: 'text', text: 'First answer'}],
    api: 'openai-responses',
    provider: 'fixture',
    model: 'fixture',
    stopReason: 'stop',
    timestamp: 2,
    usage: {
      input: 12,
      output: 3,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 18,
      cost: {
        input: 0.01,
        output: 0.02,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.03,
      },
    },
  });
  const second = manager.appendMessage({
    role: 'user',
    content: [
      {type: 'text', text: 'Second request\n'},
      {type: 'image', data: 'AA==', mimeType: 'image/png'},
      {type: 'text', text: 'with image'},
    ],
    timestamp: 3,
  });
  session = (
    await createAgentSessionFromServices({services, sessionManager: manager})
  ).session;
  await session.bindExtensions({mode: 'print'});
  const native = nativeUI();
  const run = (name: string, args = '') =>
    runSessionCommand(name, args, {session: session!, ui: native.ui});
  return {
    root,
    cwd,
    session,
    manager,
    first,
    answer,
    second,
    control,
    events,
    native,
    run,
  };
}

function replacement(result: SessionCommandResult | undefined) {
  assert.equal(result?.kind, 'replace');
  if (result?.kind !== 'replace') throw new Error('Expected replacement');
  return result.replacement;
}

void test('unhandled names remain unhandled; /session is a read-only native modal', async t => {
  const {run, native, session, manager} = await fixture(t);
  const entries = structuredClone(manager.getEntries());
  assert.equal(await run('not-a-native-command'), undefined);
  assert.deepEqual(await run('session'), {kind: 'done'});
  assert.equal(native.shows.length, 1);
  assert.equal(native.shows[0].title, 'Session information');
  for (const value of [
    session.sessionId,
    session.sessionFile!,
    'Tokens:',
    'Cost:',
    'Working directory:',
  ])
    assert.ok(native.shows[0].message.includes(value));
  assert.deepEqual(manager.getEntries(), entries);
  assert.equal(native.prompts.length, 0);
});

void test('/name supports native input, explicit args, and cancellation without blank renames', async t => {
  const {run, native, manager} = await fixture(t);
  assert.deepEqual(await run('name'), {kind: 'cancelled'});
  assert.equal(manager.getSessionName(), undefined);
  native.inputs.push('  Readable name  ');
  assert.equal((await run('name'))?.kind, 'done');
  assert.equal(manager.getSessionName(), 'Readable name');
  assert.equal((await run('name', 'Explicit name with spaces'))?.kind, 'done');
  assert.equal(manager.getSessionName(), 'Explicit name with spaces');
  native.inputs.push('   ');
  assert.deepEqual(await run('name'), {kind: 'cancelled'});
  assert.equal(manager.getSessionName(), 'Explicit name with spaces');
});

void test('/tree uses native navigation without a model or summary and restores full user text', async t => {
  const {run, native, session, manager, first, second, events} =
    await fixture(t);
  t.mock.getter(session, 'model', () => undefined);
  const id = session.sessionId;
  const file = session.sessionFile;
  const entries = structuredClone(manager.getEntries());
  native.choose(options =>
    options.find(option => option.includes(`[${first}]`)),
  );
  assert.equal((await run('tree'))?.kind, 'done');
  assert.equal(manager.getLeafId(), null);
  assert.equal(native.editor(), 'First user request\nwith detail');
  assert.equal(session.sessionId, id);
  assert.equal(session.sessionFile, file);
  assert.deepEqual(manager.getEntries(), entries);
  assert.equal(
    manager.getEntries().some(entry => entry.type === 'branch_summary'),
    false,
  );
  assert.ok(events.some(event => event.type === 'session_before_tree'));
  native.choose(options =>
    options.find(option => option.includes(`[${second}]`)),
  );
  await run('tree');
  assert.equal(native.editor(), 'Second request\nwith image');
  assert.equal(session.model, undefined);
});

void test('/tree clears editor on assistant selection and respects native extension cancellation', async t => {
  const {run, native, manager, answer, first, control} = await fixture(t);
  native.choose(options =>
    options.find(option => option.includes(`[${answer}]`)),
  );
  await run('tree');
  assert.equal(manager.getLeafId(), answer);
  assert.equal(native.editor(), '');
  control.cancelTree = true;
  native.choose(options =>
    options.find(option => option.includes(`[${first}]`)),
  );
  assert.deepEqual(await run('tree'), {kind: 'cancelled'});
  assert.equal(manager.getLeafId(), answer);
  native.choose(() => undefined);
  assert.deepEqual(await run('tree'), {kind: 'cancelled'});
});

for (const memory of [false, true]) {
  void test(`/fork prepares an independent discoverable branch (${memory ? 'ephemeral' : 'persisted'} live session)`, async t => {
    const {run, native, session, manager, first, second, cwd, events} =
      await fixture(t, memory);
    const id = session.sessionId;
    const file = session.sessionFile;
    const entries = structuredClone(manager.getEntries());
    const source = file ? await readFile(file, 'utf8') : undefined;
    native.choose(options =>
      options.find(option => option.includes(`[${second}]`)),
    );
    const prepared = replacement(await run('fork'));
    assert.equal(prepared.cwd, cwd);
    assert.equal(prepared.editorText, 'Second request\nwith image');
    const forked = SessionManager.open(prepared.sessionFile);
    assert.notEqual(forked.getSessionId(), id);
    assert.ok(forked.getEntry(first));
    assert.equal(forked.getEntry(second), undefined);
    assert.equal(forked.getHeader()?.parentSession, file);
    assert.ok(
      (await SessionManager.list(cwd)).some(
        item => item.path === prepared.sessionFile,
      ),
    );
    assert.equal(session.sessionId, id);
    assert.equal(session.sessionFile, file);
    assert.deepEqual(manager.getEntries(), entries);
    if (file) assert.equal(await readFile(file, 'utf8'), source);
    assert.ok(
      events.some(
        event =>
          event.type === 'session_before_fork' && event.position === 'before',
      ),
    );
  });
}

void test('/fork before the first user persists a header-only session ready for hub resume', async t => {
  const {run, native, first, cwd} = await fixture(t);
  native.choose(options =>
    options.find(option => option.includes(`[${first}]`)),
  );
  const prepared = replacement(await run('fork'));
  assert.equal(prepared.editorText, 'First user request\nwith detail');
  assert.equal(
    SessionManager.open(prepared.sessionFile).getEntries().length,
    0,
  );
  assert.ok(
    (await SessionManager.list(cwd)).some(
      item => item.path === prepared.sessionFile,
    ),
  );
});

void test('/clone copies only the selected active path and retains canonical labels/context edits', async t => {
  const {run, session, manager, first, second, answer, cwd, events} =
    await fixture(t);
  const label = manager.appendLabelChange(answer, 'Decision');
  manager.appendContextEdit(first, {content: 'Edited context'});
  const activeLeaf = manager.getLeafId();
  const sourceContext = structuredClone(
    manager.buildSessionProjection().messages,
  );
  manager.branch(answer);
  const abandoned = manager.appendMessage({
    role: 'user',
    content: 'Another branch',
    timestamp: 4,
  });
  manager.branch(activeLeaf!);
  const liveId = session.sessionId;
  const liveEntries = structuredClone(manager.getEntries());
  const prepared = replacement(await run('clone'));
  const clone = SessionManager.open(prepared.sessionFile);
  assert.equal(prepared.editorText, '');
  assert.equal(prepared.cwd, cwd);
  assert.ok(clone.getEntry(second));
  assert.equal(clone.getEntry(abandoned), undefined);
  assert.equal(clone.getEntry(label), undefined, 'SDK recreates label entries');
  assert.equal(clone.getLabel(answer), 'Decision');
  assert.deepEqual(clone.buildSessionProjection().messages, sourceContext);
  assert.equal(session.sessionId, liveId);
  assert.equal(manager.getLeafId(), activeLeaf);
  assert.deepEqual(manager.getEntries(), liveEntries);
  assert.ok(
    events.some(
      event => event.type === 'session_before_fork' && event.position === 'at',
    ),
  );
});

void test('/fork and /clone honor native fork veto without preparing files', async t => {
  const {run, native, first, control, cwd} = await fixture(t);
  control.cancelFork = true;
  native.choose(options =>
    options.find(option => option.includes(`[${first}]`)),
  );
  assert.deepEqual(await run('fork'), {kind: 'cancelled'});
  assert.deepEqual(await run('clone'), {kind: 'cancelled'});
  assert.deepEqual(await SessionManager.list(cwd), []);
});

void test('/import validates through Pi and prepares a new discoverable identity without touching sources', async t => {
  const {run, native, session, manager, cwd, root} = await fixture(t);
  const source = join(root, 'external session.jsonl');
  await copyFile(session.sessionFile!, source);
  const original = await readFile(source, 'utf8');
  const id = session.sessionId;
  const entries = structuredClone(manager.getEntries());
  native.inputs.push(source);
  native.confirmations.push(true);
  const prepared = replacement(await run('import'));
  assert.equal(native.prompts[0], 'Import session');
  assert.equal(prepared.cwd, cwd);
  assert.notEqual(prepared.sessionFile, source);
  assert.notEqual(SessionManager.open(prepared.sessionFile).getSessionId(), id);
  assert.equal(await readFile(source, 'utf8'), original);
  assert.equal(session.sessionId, id);
  assert.deepEqual(manager.getEntries(), entries);
  assert.ok(
    (await SessionManager.list(cwd)).some(
      item => item.path === prepared.sessionFile,
    ),
  );
});

void test('/import handles cancellation, overwrite avoidance, missing cwd, and native switch veto', async t => {
  const {run, native, session, root, cwd, control} = await fixture(t);
  assert.deepEqual(await run('import'), {kind: 'cancelled'});
  const source = join(root, 'import.jsonl');
  const missing = SessionManager.create(
    join(root, 'missing'),
    join(root, 'external'),
  );
  missing.appendMessage({role: 'user', content: 'Imported', timestamp: 1});
  await copyFile(missing.getSessionFile()!, source);
  native.confirmations.push(false);
  assert.deepEqual(await run('import', source), {kind: 'cancelled'});
  native.confirmations.push(true, true);
  control.cancelSwitch = true;
  assert.deepEqual(await run('import', source), {kind: 'cancelled'});
  assert.deepEqual(await SessionManager.list(cwd), []);
  control.cancelSwitch = false;
  native.confirmations.push(true, true);
  const prepared = replacement(await run('import', `"${source}"`));
  assert.equal(prepared.cwd, cwd);
  assert.notEqual(
    SessionManager.open(prepared.sessionFile).getSessionId(),
    session.sessionId,
  );
  assert.equal((await readdir(dirname(source))).includes('import.jsonl'), true);
});

void test('/import rejects invalid JSONL, missing headers, future versions, and cyclic entry links before writing', async t => {
  const {run, native, root, cwd} = await fixture(t);
  const source = join(root, 'invalid.jsonl');
  const header = {
    type: 'session',
    id: 'source',
    version: 3,
    timestamp: new Date().toISOString(),
    cwd,
  };
  for (const content of [
    'not json',
    JSON.stringify({type: 'message', id: 'x'}),
    JSON.stringify({...header, version: 999}),
    JSON.stringify(header) + '\n{broken json',
    JSON.stringify(header) +
      '\n' +
      JSON.stringify({
        type: 'custom',
        id: 'cycle',
        parentId: 'cycle',
        timestamp: header.timestamp,
      }),
  ]) {
    await writeFile(source, content);
    await assert.rejects(run('import', source), /valid|header|links/);
    assert.equal(await readFile(source, 'utf8'), content);
  }
  assert.equal(native.confirms.length, 0);
  assert.deepEqual(await SessionManager.list(cwd), []);
});

void test('/export opens native path input, uses SDK JSONL, and asks about sensitivity and overwrites', async t => {
  const {run, native, session, root, manager} = await fixture(t);
  const output = join(root, 'session export.jsonl');
  assert.deepEqual(await run('export'), {kind: 'cancelled'});
  await writeFile(output, 'existing contents');
  native.inputs.push(output);
  native.confirmations.push(true, false);
  assert.deepEqual(await run('export'), {kind: 'cancelled'});
  assert.equal(await readFile(output, 'utf8'), 'existing contents');
  native.confirmations.push(true, true);
  const result = await run('export', `"${output}"`);
  assert.equal(result?.kind, 'done');
  assert.deepEqual(
    SessionManager.open(output).getEntries(),
    manager.getBranch(),
  );
  assert.ok(native.confirms.some(item => item.message.includes('secrets')));
  assert.ok(native.confirms.some(item => item.title.includes('Overwrite')));
  assert.notEqual(output, session.sessionFile);
});

void test('/export HTML delegates to SDK and never overwrites the live transcript', async t => {
  const {run, native, root, session} = await fixture(t);
  const output = join(root, 'session.html');
  // The SDK renderer depends on its bundled theme/assets. Verify delegation
  // without making a terminal renderer part of this native-command unit test.
  const calls: string[] = [];
  t.mock.method(session, 'exportToHtml', async (path?: string) => {
    calls.push(path!);
    await writeFile(path!, '<!doctype html>');
    return path!;
  });
  native.confirmations.push(true);
  assert.equal((await run('export', output))?.kind, 'done');
  assert.deepEqual(calls, [output]);
  await assert.rejects(run('export', session.sessionFile!), /live session/);
  await assert.rejects(
    run('export', join(root, 'unsafe.txt')),
    /html or .jsonl/,
  );
  native.confirmations.push(false);
  assert.deepEqual(await run('export', output), {kind: 'cancelled'});
  assert.deepEqual(calls, [output]);
});

void test('session selectors paginate large histories instead of silently dropping entries', async t => {
  const {run, native, session, first} = await fixture(t);
  const messages = Array.from({length: 1002}, (_, index) => ({
    entryId: `entry-${index}`,
    text: 'Duplicate message',
  }));
  messages[0].entryId = first;
  t.mock.method(session, 'getUserMessagesForForking', () => messages);
  let turn = 0;
  native.choose(options => {
    turn++;
    if (turn === 1) return options.find(option => option === '← Previous page');
    return options.find(option => option.includes(`[${first}]`));
  });
  assert.equal((await run('fork'))?.kind, 'replace');
  assert.equal(native.selects.length, 2);
  assert.ok(native.selects.every(select => select.options.length <= 1002));
});

void test('argument-free commands reject unsupported arguments instead of opening dialogs', async t => {
  const {run, native} = await fixture(t);
  for (const name of ['session', 'tree', 'fork', 'clone'])
    await assert.rejects(run(name, 'unsupported'), /Usage:|arguments/);
  assert.deepEqual(native.shows, []);
  assert.deepEqual(native.selects, []);
});

void test('/name remains safe while the session is running and abort signals prevent stale renames', async t => {
  const {run, session, native, manager} = await fixture(t);
  t.mock.getter(session, 'isIdle', () => false);
  assert.equal((await run('name', 'Live display name'))?.kind, 'done');
  const controller = new AbortController();
  native.ui.context.input = async (_title, _placeholder, options) => {
    assert.equal(options?.signal, controller.signal);
    controller.abort();
    return 'Stale display name';
  };
  assert.deepEqual(
    await runSessionCommand('name', '', {
      session,
      ui: native.ui,
      signal: controller.signal,
    }),
    {kind: 'cancelled'},
  );
  assert.equal(manager.getSessionName(), 'Live display name');
});

void test('fork/import cancellation signals prevent prepared files after asynchronous hooks or dialogs', async t => {
  const {session, native, cwd, root} = await fixture(t);
  const controller = new AbortController();
  t.mock.method(session.extensionRunner, 'emit', async () => {
    controller.abort();
    return undefined;
  });
  assert.deepEqual(
    await runSessionCommand('clone', '', {
      session,
      ui: native.ui,
      signal: controller.signal,
    }),
    {kind: 'cancelled'},
  );
  assert.deepEqual(await SessionManager.list(cwd), []);
  const importController = new AbortController();
  const source = join(root, 'abort-import.jsonl');
  await copyFile(session.sessionFile!, source);
  native.ui.context.confirm = async (_title, _message, options) => {
    assert.equal(options?.signal, importController.signal);
    importController.abort();
    return true;
  };
  assert.deepEqual(
    await runSessionCommand('import', source, {
      session,
      ui: native.ui,
      signal: importController.signal,
    }),
    {kind: 'cancelled'},
  );
  assert.deepEqual(await SessionManager.list(cwd), []);
});

void test('/import persists the already validated snapshot even if the source changes during confirmation', async t => {
  const {run, session, native, manager, root} = await fixture(t);
  const source = join(root, 'changing-source.jsonl');
  await copyFile(session.sessionFile!, source);
  const originalEntries = structuredClone(manager.getEntries());
  native.ui.context.confirm = async () => {
    await writeFile(source, 'replaced with invalid content');
    return true;
  };
  const prepared = replacement(await run('import', source));
  assert.deepEqual(
    SessionManager.open(prepared.sessionFile).getEntries(),
    originalEntries,
  );
  assert.equal(await readFile(source, 'utf8'), 'replaced with invalid content');
});

void test('/import uses SDK migrations for legacy sessions and rejects oversized files before loading', async t => {
  const {run, native, root, cwd} = await fixture(t);
  const source = join(root, 'legacy.jsonl');
  const content = [
    {
      type: 'session',
      version: 1,
      id: 'legacy-id',
      cwd,
      timestamp: new Date().toISOString(),
    },
    {
      type: 'message',
      timestamp: new Date().toISOString(),
      message: {role: 'user', content: 'Legacy request', timestamp: 1},
    },
  ]
    .map(entry => JSON.stringify(entry))
    .join('\n');
  await writeFile(source, content);
  native.confirmations.push(true);
  const prepared = replacement(await run('import', source));
  const imported = SessionManager.open(prepared.sessionFile);
  assert.equal(imported.getHeader()?.version, 3);
  assert.ok(imported.getEntries()[0].id);
  assert.equal(imported.getEntries()[0].parentId, null);
  assert.equal(imported.buildSessionProjection().messages[0].role, 'user');
  assert.equal(await readFile(source, 'utf8'), content);
  const huge = join(root, 'too-large.jsonl');
  const handle = await open(huge, 'w');
  try {
    await handle.truncate(128 * 1024 * 1024 + 1);
  } finally {
    await handle.close();
  }
  await assert.rejects(run('import', huge), /128 MiB/);
});

void test('/export detects symlink and hardlink aliases of the live transcript', async t => {
  const {run, session, root} = await fixture(t);
  const original = await readFile(session.sessionFile!, 'utf8');
  const symbolic = join(root, 'live-symlink.jsonl');
  const hard = join(root, 'live-hardlink.jsonl');
  await symlink(session.sessionFile!, symbolic);
  await link(session.sessionFile!, hard);
  await assert.rejects(run('export', symbolic), /live session/);
  await assert.rejects(run('export', hard), /live session/);
  assert.equal(await readFile(session.sessionFile!, 'utf8'), original);
});

void test('/clone preserves the SDK compaction anchor when label entries are canonicalized', async t => {
  const {run, manager, answer} = await fixture(t);
  manager.branch(answer);
  const label = manager.appendLabelChange(answer, 'Kept boundary');
  const kept = manager.appendMessage({
    role: 'user',
    content: 'Kept after label',
    timestamp: 10,
  });
  const compaction = manager.appendCompaction('Saved summary', label, 1000);
  const original = structuredClone(manager.getEntries());
  const projection = structuredClone(manager.buildSessionProjection().messages);
  const prepared = replacement(await run('clone'));
  const clone = SessionManager.open(prepared.sessionFile);
  const canonicalCompaction = clone.getEntry(compaction);
  assert.equal(canonicalCompaction?.type, 'compaction');
  if (canonicalCompaction?.type !== 'compaction')
    throw new Error('Missing compaction');
  assert.equal(canonicalCompaction.firstKeptEntryId, kept);
  assert.deepEqual(clone.buildSessionProjection().messages, projection);
  assert.deepEqual(manager.getEntries(), original);
});

void test('/export HTML produces a real Pi SDK document without any network access', async t => {
  const {run, native, root} = await fixture(t);
  const output = join(root, 'actual-sdk.html');
  native.confirmations.push(true);
  assert.equal((await run('export', output))?.kind, 'done');
  const html = await readFile(output, 'utf8');
  assert.match(html, /<!doctype html>/i);
  const encoded = html.match(
    /<script id="session-data"[^>]*>([^<]+)<\/script>/,
  )?.[1];
  assert.ok(encoded, 'Pi embeds the session payload in the exported document');
  assert.match(
    Buffer.from(encoded, 'base64').toString('utf8'),
    /First user request/,
  );
});
