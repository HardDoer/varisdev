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
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {stripVTControlCharacters} from 'node:util';
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
import {saveToolSettings} from '../src/tools/settings.ts';
import {sessionWorker} from '../src/agents/session.ts';
import {DesktopExtensionUI} from '../src/dashboard/extension-ui.ts';
import {createDirectoryLink, createFileSymlinkOrSkip} from './filesystem.ts';

function nativeUI() {
  const inputs: Array<string | undefined> = [];
  const confirmations: boolean[] = [];
  const shows: Array<{title: string; message: string}> = [];
  const selects: Array<{title: string; options: string[]; selected?: string}> =
    [];
  const nativeDialogs: string[] = [];
  let nativeSelected: string | undefined;
  const prompts: string[] = [];
  const confirms: Array<{title: string; message: string}> = [];
  let editorText = 'existing draft';
  let choose: (options: string[]) => string | undefined = () => undefined;
  const ui: SessionCommandUI = {
    native: async <T>(title: string) => {
      nativeDialogs.push(title);
      return nativeSelected as T;
    },
    show: async (title, message) => {
      shows.push({title, message});
    },
    select: async (title, options, config) => {
      selects.push({title, options, selected: config?.selected});
      return choose(options);
    },
    context: {
      theme: {name: 'dark'},
      editor: async () => inputs.shift(),
      notify: () => {},
      getEditorText: () => editorText,
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
    nativeDialogs,
    chooseNative: (id: string | undefined) => {
      nativeSelected = id;
    },
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
    settingsManager: SettingsManager.inMemory({
      compaction: {enabled: false},
      branchSummary: {skipPrompt: true},
    }),
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

void test(
  'unhandled names remain unhandled; /session renders the shipped Pi view',
  {timeout: 6000},
  async t => {
    const {session, manager} = await fixture(t);
    const ui = new DesktopExtensionUI(() => {});
    t.after(() => ui.dispose());
    const entries = structuredClone(manager.getEntries());
    assert.equal(
      await runSessionCommand('not-a-native-command', '', {session, ui}),
      undefined,
    );
    const viewing = runSessionCommand('session', '', {session, ui});
    const dialog = await terminalDialog(ui, 'Session');
    assert.match(dialog.terminal!.output, /Session Info/);
    const rendered = stripVTControlCharacters(dialog.terminal!.output).replace(
      /\s/g,
      '',
    );
    for (const value of [
      session.sessionId,
      session.sessionFile!,
      'Tokens',
      'Cost',
    ])
      assert.ok(
        rendered.includes(value),
        `Expected Pi view to include ${value}`,
      );
    ui.respond(dialog.id, {input: '\x1b'});
    assert.deepEqual(await viewing, {kind: 'done'});
    assert.deepEqual(manager.getEntries(), entries);
  },
);

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
  native.ui.context.setEditorText('');
  native.chooseNative(first);
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
  native.ui.context.setEditorText('');
  native.chooseNative(second);
  await run('tree');
  assert.equal(native.editor(), 'Second request\nwith image');
  assert.equal(session.model, undefined);
});

void test('/tree clears editor on assistant selection and respects native extension cancellation', async t => {
  const {run, native, manager, answer, first, control} = await fixture(t);
  native.ui.context.setEditorText('');
  native.chooseNative(answer);
  await run('tree');
  assert.equal(manager.getLeafId(), answer);
  assert.equal(native.editor(), '');
  control.cancelTree = true;
  native.chooseNative(first);
  assert.deepEqual(await run('tree'), {kind: 'cancelled'});
  assert.equal(manager.getLeafId(), answer);
  native.chooseNative(undefined);
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
    native.chooseNative(second);
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
  native.chooseNative(first);
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
  native.chooseNative(first);
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
  const calls: Array<{path: string; themeName?: string}> = [];
  t.mock.method(
    session,
    'exportToHtml',
    async (path?: string, options?: {themeName?: string}) => {
      calls.push({path: path!, themeName: options?.themeName});
      await writeFile(path!, '<!doctype html>');
      return path!;
    },
  );
  native.confirmations.push(true);
  assert.equal((await run('export', output))?.kind, 'done');
  assert.deepEqual(calls, [{path: output, themeName: 'dark'}]);
  await assert.rejects(run('export', session.sessionFile!), /live session/);
  await assert.rejects(
    run('export', join(root, 'unsafe.txt')),
    /html or .jsonl/,
  );
  native.confirmations.push(false);
  assert.deepEqual(await run('export', output), {kind: 'cancelled'});
  assert.deepEqual(calls, [{path: output, themeName: 'dark'}]);
});

void test('argument-free commands reject unsupported arguments instead of opening dialogs', async t => {
  const {run, native} = await fixture(t);
  for (const name of ['resume', 'session', 'tree', 'fork', 'clone'])
    await assert.rejects(run(name, 'unsupported'), /Usage:|arguments/);
  assert.deepEqual(native.shows, []);
  assert.deepEqual(native.selects, []);
  assert.deepEqual(native.nativeDialogs, []);
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

void test('/export detects directory and hardlink aliases of the live transcript', async t => {
  const {run, session, root} = await fixture(t);
  const live = session.sessionFile!;
  const original = await readFile(live, 'utf8');
  const directoryAlias = join(root, 'live-directory-alias');
  const hard = join(root, 'live-hardlink.jsonl');
  await createDirectoryLink(dirname(live), directoryAlias);
  await link(live, hard);
  await assert.rejects(
    run('export', join(directoryAlias, basename(live))),
    /live session/,
  );
  await assert.rejects(run('export', hard), /live session/);
  assert.equal(await readFile(live, 'utf8'), original);
});

void test('/export detects file symlink aliases of the live transcript when supported', async t => {
  const {run, session, root} = await fixture(t);
  const live = session.sessionFile!;
  const original = await readFile(live, 'utf8');
  const symbolic = join(root, 'live-symlink.jsonl');
  if (!(await createFileSymlinkOrSkip(t, live, symbolic))) return;
  await assert.rejects(run('export', symbolic), /live session/);
  assert.equal(await readFile(live, 'utf8'), original);
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
async function terminalDialog(ui: DesktopExtensionUI, title: string) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const dialog = ui.snapshot().dialogs.find(dialog => dialog.title === title);
    if (
      dialog?.terminal?.output &&
      /[A-Za-z]{4}/.test(stripVTControlCharacters(dialog.terminal.output))
    )
      return dialog;
    await delay(5);
  }
  throw new Error(`Expected rendered terminal dialog: ${title}`);
}

void test(
  'native tree component persists labels, preserves drafts, and cancels browsing without aborting',
  {timeout: 6000},
  async t => {
    const {session, manager, second, answer} = await fixture(t);
    const ui = new DesktopExtensionUI(() => {});
    t.after(() => ui.dispose());
    ui.context.setEditorText('Keep this draft');
    const abort = t.mock.method(session, 'abort', async () => {});
    const browsing = runSessionCommand('tree', '', {session, ui});
    const firstDialog = await terminalDialog(ui, 'Session tree');
    assert.match(firstDialog.terminal!.output, /Second request/);
    ui.respond(firstDialog.id, {input: 'LCheckpoint\r'});
    const deadline = Date.now() + 2000;
    while (manager.getLabel(second) !== 'Checkpoint' && Date.now() < deadline)
      await delay(5);
    assert.equal(manager.getLabel(second), 'Checkpoint');
    ui.respond(firstDialog.id, {input: '\x1b'});
    assert.deepEqual(await browsing, {kind: 'cancelled'});
    assert.equal(abort.mock.callCount(), 0);
    const moving = runSessionCommand('tree', '', {session, ui});
    const nextDialog = await terminalDialog(ui, 'Session tree');
    ui.respond(nextDialog.id, {input: 'First answer\r'});
    assert.equal((await moving)?.kind, 'done');
    assert.equal(manager.getLeafId(), answer);
    assert.equal(ui.context.getEditorText(), 'Keep this draft');
  },
);

void test(
  'native fork component keeps the entire history selectable',
  {timeout: 6000},
  async t => {
    const {session, first} = await fixture(t);
    const ui = new DesktopExtensionUI(() => {});
    t.after(() => ui.dispose());
    const messages = Array.from({length: 1002}, (_, index) => ({
      entryId: index === 0 ? first : `entry-${index}`,
      text: `Message ${index}`,
    }));
    t.mock.method(session, 'getUserMessagesForForking', () => messages);
    const selecting = runSessionCommand('fork', '', {session, ui});
    const dialog = await terminalDialog(ui, 'Fork session');
    ui.respond(dialog.id, {input: '\x1b[A'.repeat(1001) + '\r'});
    assert.equal(
      replacement(await selecting).editorText,
      'First user request\nwith detail',
    );
    assert.equal(ui.snapshot().dialogs.length, 0);
  },
);

void test('tree summary dialogs return to the selected tree and pass custom instructions without model calls', async t => {
  const {session, native, first} = await fixture(t);
  t.mock.method(
    session.settingsManager,
    'getBranchSummarySkipPrompt',
    () => false,
  );
  native.chooseNative(first);
  const choices = [
    undefined,
    'Summarize with custom prompt',
    'Summarize with custom prompt',
  ];
  native.choose(() => choices.shift());
  native.inputs.push(undefined, 'Keep decisions');
  const navigate = t.mock.method(session, 'navigateTree', async () => ({
    cancelled: false,
    editorText: 'Restored',
  }));
  assert.equal(
    (await runSessionCommand('tree', '', {session, ui: native.ui}))?.kind,
    'done',
  );
  assert.deepEqual(native.nativeDialogs, [
    'Session tree',
    'Session tree',
    'Branch summary',
  ]);
  assert.deepEqual(navigate.mock.calls[0].arguments, [
    first,
    {summarize: true, customInstructions: 'Keep decisions'},
  ]);
});

void test(
  'native branch summary Escape returns to tree, while Stop cancels navigation',
  {timeout: 6000},
  async t => {
    const {session, first} = await fixture(t);
    const ui = new DesktopExtensionUI(() => {});
    t.after(() => ui.dispose());
    t.mock.method(
      session.settingsManager,
      'getBranchSummarySkipPrompt',
      () => false,
    );
    let finish:
      ((value: {aborted: true; cancelled: false}) => void) | undefined;
    t.mock.method(
      session,
      'navigateTree',
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const abort = t.mock.method(session, 'abortBranchSummary', () =>
      finish?.({aborted: true, cancelled: false}),
    );
    const controller = new AbortController();
    const browsing = runSessionCommand('tree', '', {
      session,
      ui: ui.forCommand(controller.signal),
      signal: controller.signal,
    });
    const tree = await terminalDialog(ui, 'Session tree');
    ui.respond(tree.id, {input: 'First user\r'});
    const choice = await terminalDialog(ui, 'Summarize branch?');
    ui.respond(choice.id, 'Summarize');
    const summary = await terminalDialog(ui, 'Branch summary');
    ui.respond(summary.id, {input: '\x1b'});
    const reopened = await terminalDialog(ui, 'Session tree');
    assert.notEqual(reopened.id, tree.id);
    assert.equal(abort.mock.callCount(), 1);
    ui.respond(reopened.id, {input: '\r'});
    const secondChoice = await terminalDialog(ui, 'Summarize branch?');
    ui.respond(secondChoice.id, 'Summarize');
    await terminalDialog(ui, 'Branch summary');
    controller.abort();
    assert.deepEqual(await browsing, {kind: 'cancelled'});
    assert.equal(abort.mock.callCount(), 2);
    assert.equal(session.sessionManager.getEntry(first)?.type, 'message');
    assert.equal(ui.snapshot().dialogs.length, 0);
  },
);

void test('resume prepares the selected native session after switch veto and missing-directory decisions', async t => {
  const {session, native, cwd, root, manager} = await fixture(t);
  const target = SessionManager.create(
    join(root, 'removed-workspace'),
    join(root, 'history'),
  );
  target.appendMessage({role: 'user', content: 'Saved session', timestamp: 1});
  target.appendMessage({
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'fixture',
    model: 'fixture',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
    },
    stopReason: 'stop',
    timestamp: 2,
  });
  const path = target.getSessionFile()!;
  native.chooseNative(path);
  native.confirmations.push(false);
  assert.deepEqual(
    await runSessionCommand('resume', '', {session, ui: native.ui}),
    {kind: 'cancelled'},
  );
  native.confirmations.push(true);
  const veto = t.mock.method(session.extensionRunner, 'emit', async () => ({
    cancel: true,
  }));
  assert.deepEqual(
    await runSessionCommand('resume', '', {session, ui: native.ui}),
    {kind: 'cancelled'},
  );
  veto.mock.restore();
  native.confirmations.push(true);
  assert.deepEqual(
    replacement(
      await runSessionCommand('resume', '', {session, ui: native.ui}),
    ),
    {sessionFile: path, cwd, editorText: ''},
  );
  assert.notEqual(manager.getSessionFile(), path);
});

void test(
  'native resume selector renames saved sessions and selects through the owning command',
  {timeout: 6000},
  async t => {
    const {session, manager} = await fixture(t);
    const ui = new DesktopExtensionUI(() => {});
    t.after(() => ui.dispose());
    const controller = new AbortController();
    const selecting = runSessionCommand('resume', '', {
      session,
      ui,
      signal: controller.signal,
    });
    const dialog = await terminalDialog(ui, 'Resume session');
    const deadline = Date.now() + 2000;
    while (
      !ui
        .snapshot()
        .dialogs[0].terminal!.output.includes('First user request') &&
      Date.now() < deadline
    )
      await delay(5);
    ui.respond(dialog.id, {input: '\x12'});
    const renameDeadline = Date.now() + 2000;
    while (
      !ui.snapshot().dialogs[0].terminal!.output.includes('Rename Session') &&
      Date.now() < renameDeadline
    )
      await delay(5);
    ui.respond(dialog.id, {input: 'Renamed native session\r'});
    const renamedDeadline = Date.now() + 2000;
    while (
      manager.getSessionName() !== 'Renamed native session' &&
      Date.now() < renamedDeadline
    )
      await delay(5);
    assert.equal(manager.getSessionName(), 'Renamed native session');
    const listDeadline = Date.now() + 2000;
    while (Date.now() < listDeadline) {
      const output = ui.snapshot().dialogs[0].terminal!.output;
      if (
        output.lastIndexOf('Resume Session') >
        output.lastIndexOf('Rename Session')
      )
        break;
      await delay(5);
    }
    ui.respond(dialog.id, {input: '\r'});
    assert.equal((await selecting)?.kind, 'done');
  },
);

void test(
  'worker native commands use the selected SDK session and owning terminal UI without prompting a model',
  {timeout: 6000},
  async t => {
    const {session, root} = await fixture(t);
    const ui = new DesktopExtensionUI(() => {});
    t.after(() => ui.dispose());
    session.modelRuntime.registerProvider('worker-native', {
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'local-fixture',
      models: [
        {
          id: 'one',
          name: 'Worker native model',
          reasoning: true,
          input: ['text'],
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          contextWindow: 8192,
          maxTokens: 1024,
        },
      ],
    });
    const prompt = t.mock.method(session, 'prompt', async () => {
      throw new Error('Native commands must not call session.prompt');
    });
    await saveToolSettings('agents', {allowedModels: ['worker-native/one']});
    const worker = sessionWorker(
      session,
      join(root, 'worker-result.txt'),
      undefined,
      {},
      ui,
    );
    await worker.configure!({provider: 'worker-native', modelId: 'one'});
    const selecting = worker.command!('/model');
    const dialog = await terminalDialog(ui, 'Model & thinking');
    assert.match(dialog.terminal!.output, /Worker native model/);
    ui.respond(dialog.id, {input: '\x1b'});
    await selecting;
    await worker.run('/thinking high', AbortSignal.timeout(2000), () => {});
    assert.equal(session.thinkingLevel, 'high');
    assert.equal((await worker.features!()).thinkingLevel, 'high');
    const settings = worker.command!('/settings');
    const settingsDialog = await terminalDialog(ui, 'Settings');
    worker.clearQueue!();
    await settings;
    assert.equal(
      ui.snapshot().dialogs.some(item => item.id === settingsDialog.id),
      false,
    );
    for (const command of ['/resume', '/tree', '/fork'])
      await assert.rejects(
        worker.run(command, AbortSignal.timeout(2000), () => {}),
        /unavailable in worker/,
      );
    assert.equal(prompt.mock.callCount(), 0);
  },
);
