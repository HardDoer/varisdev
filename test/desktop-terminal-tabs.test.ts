import assert from 'node:assert/strict';
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import vm from 'node:vm';
import ts from 'typescript';
import type {IPty} from '@lydell/node-pty';
import {DashboardInputError} from '../src/dashboard/errors.ts';
import type {
  AgentSessionRequest,
  AgentSessionResult,
} from '../src/dashboard/hub.ts';
import {DesktopPreferences} from '../src/desktop/preferences.ts';
import {
  DesktopTerminals,
  type TerminalSnapshot,
} from '../src/desktop/terminal.ts';
import {
  DesktopTerminalProfiles,
  detectTerminalProfiles,
} from '../src/desktop/terminal-profiles.ts';

type PtyModule = typeof import('@lydell/node-pty');

async function temporary(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'varisdev-terminal-tabs-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(fulfill => {
    resolve = fulfill;
  });
  return {promise, resolve};
}

function fakePty() {
  let data: ((value: string) => void) | undefined;
  let exit: ((event: {exitCode: number}) => void) | undefined;
  const writes: string[] = [];
  const sizes: number[][] = [];
  let kills = 0;
  const pty = {
    onData: (listener: typeof data) => {
      data = listener;
      return {
        dispose: () => {
          data = undefined;
        },
      };
    },
    onExit: (listener: typeof exit) => {
      exit = listener;
      return {
        dispose: () => {
          exit = undefined;
        },
      };
    },
    write: (value: string) => {
      writes.push(value);
    },
    resize: (cols: number, rows: number) => {
      sizes.push([cols, rows]);
    },
    kill: () => {
      kills++;
    },
  } as unknown as IPty;
  return {
    pty,
    writes,
    sizes,
    output: (value: string) => data?.(value),
    exit: (exitCode: number) => exit?.({exitCode}),
    kills: () => kills,
  };
}

function ptyLoader() {
  const shells: Array<
    ReturnType<typeof fakePty> & {
      file: string;
      args: string[];
      options: Record<string, unknown>;
    }
  > = [];
  const module = {
    spawn: (file: string, args: string[], options: Record<string, unknown>) => {
      const shell = {...fakePty(), file, args, options};
      shells.push(shell);
      return shell.pty;
    },
  } as unknown as PtyModule;
  return {shells, module, load: async () => module};
}

function windowsProfiles(preferences?: DesktopPreferences) {
  const files = new Set([
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Windows\\System32\\cmd.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe',
  ]);
  const env = {
    Path: 'C:\\Windows\\System32',
    SYSTEMROOT: 'C:\\Windows',
    PSMODULEPATH: 'PS7-modules',
  };
  const options = {
    env,
    platform: 'win32' as const,
    exists: (path: string) => files.has(path),
  };
  const profiles = new DesktopTerminalProfiles(preferences, options);
  return {files, env, options, profiles};
}

void test('detected Windows profiles contain installed native shells and Git Bash', () => {
  const {profiles, files} = windowsProfiles();
  const state = profiles.get();
  assert.deepEqual(
    state.profiles.map(profile => profile.label),
    ['PowerShell 7', 'Windows PowerShell', 'Command Prompt', 'Git Bash'],
  );
  assert.equal(state.defaultProfileId, state.profiles[0].id);
  assert.equal(new Set(state.profiles.map(profile => profile.id)).size, 4);
  files.clear();
  assert.deepEqual(profiles.get(), {
    profiles: [],
    customProfiles: [],
    defaultProfileId: '',
  });
  assert.throws(() => profiles.resolve(), /installed shell/);
  assert.throws(() => profiles.setDefault('wsl'), /installed shell/);
});

void test('Unix discovery prefers the installed user shell and finds common shells through PATH and OS paths', () => {
  const files = new Set([
    '/usr/local/bin/fish',
    '/custom/zsh',
    '/bin/bash',
    '/bin/sh',
    '/opt/homebrew/bin/nu',
  ]);
  const state = detectTerminalProfiles({
    platform: 'darwin',
    env: {SHELL: '/usr/local/bin/fish', PATH: 'relative:/custom'},
    userShell: () => '/bin/bash',
    exists: path => files.has(path),
  });
  assert.equal(state.defaultProfileId, state.profiles[0].id);
  assert.deepEqual(
    state.profiles.map(profile => profile.path),
    [
      '/usr/local/bin/fish',
      '/bin/bash',
      '/custom/zsh',
      '/opt/homebrew/bin/nu',
      '/bin/sh',
    ],
  );
  const account = detectTerminalProfiles({
    platform: 'linux',
    env: {SHELL: '/removed/shell'},
    userShell: () => '/usr/local/bin/fish',
    exists: path => files.has(path),
  });
  assert.equal(account.profiles[0].path, '/usr/local/bin/fish');
  assert.equal(account.defaultProfileId, account.profiles[0].id);
});

void test('default selection persists with other preferences, validates installed shells, and does not save fallbacks', async t => {
  const directory = await temporary(t);
  const preferences = new DesktopPreferences(directory);
  const {profiles, options, files} = windowsProfiles(preferences);
  profiles.get();
  await assert.rejects(readFile(join(directory, 'settings.json')), {
    code: 'ENOENT',
  });
  const selected = profiles
    .get()
    .profiles.find(profile => profile.label === 'Git Bash')!;
  profiles.setDefault(selected.id);
  preferences.rememberFolder(directory);
  preferences.acknowledgeAgentNotice();
  preferences.markWhatsNewSeen('1.2.3');
  const restartedPreferences = new DesktopPreferences(directory);
  const restarted = new DesktopTerminalProfiles(restartedPreferences, options);
  assert.equal(restarted.get().defaultProfileId, selected.id);
  assert.equal(restartedPreferences.agentNoticeAcknowledged(), true);
  assert.equal(restartedPreferences.whatsNewSeen('1.2.3'), true);
  const saved = await readFile(join(directory, 'settings.json'), 'utf8');
  files.delete(selected.path);
  assert.notEqual(restarted.get().defaultProfileId, selected.id);
  assert.throws(() => restarted.setDefault(selected.id), /installed shell/);
  assert.throws(
    () => restarted.setDefault({path: 'anything'}),
    /installed shell/,
  );
  assert.equal(await readFile(join(directory, 'settings.json'), 'utf8'), saved);
  await rm(join(directory, 'settings.json'));
  await mkdir(join(directory, 'settings.json'));
  assert.throws(() => restarted.setDefault(restarted.get().profiles[0].id));
  assert.equal(restartedPreferences.defaultTerminalProfile(), selected.id);
});

void test('custom profiles preserve defaults and existing tabs through edits, missing files and removal', async t => {
  const directory = await temporary(t);
  const preferences = new DesktopPreferences(directory);
  const {profiles, files, options, env} = windowsProfiles(preferences);
  const originalPath = 'C:\\Tools\\custom-shell.exe';
  const editedPath = 'C:\\Tools\\renamed-shell.com';
  files.add(originalPath).add(editedPath);
  const added = profiles.save({label: '  My terminal  ', path: originalPath});
  const custom = added.customProfiles[0];
  assert.equal(custom.label, 'My terminal');
  assert.match(custom.id, /^custom-[a-f0-9]{32}$/);
  assert.equal(
    added.profiles.find(profile => profile.id === custom.id)?.custom,
    true,
  );
  profiles.setDefault(custom.id);
  preferences.rememberFolder(directory);
  preferences.acknowledgeAgentNotice();
  preferences.markWhatsNewSeen('1.2.3');
  const restartedPreferences = new DesktopPreferences(directory);
  const restarted = new DesktopTerminalProfiles(restartedPreferences, options);
  assert.equal(restarted.get().defaultProfileId, custom.id);
  assert.equal(restartedPreferences.whatsNewSeen('1.2.3'), true);
  assert.equal(restartedPreferences.agentNoticeAcknowledged(), true);
  assert.equal(restartedPreferences.folder('/unused'), directory);
  const loader = ptyLoader();
  const terminals = new DesktopTerminals(() => {}, loader.load, {
    profiles: restarted,
    env,
    platform: 'win32',
  });
  t.after(() => terminals.dispose());
  const first = await terminals.create('workspace', directory);
  loader.shells[0].output('old history');
  const edited = restarted.save({
    id: custom.id,
    label: 'Updated terminal',
    path: editedPath,
  });
  assert.equal(edited.defaultProfileId, custom.id);
  assert.equal(edited.customProfiles.length, 1);
  const existing = await terminals.open(
    'workspace',
    directory,
    first.sessionId,
  );
  assert.equal(existing.title, 'My terminal');
  assert.equal(existing.data, 'old history');
  assert.equal(existing.generation, first.generation);
  const second = await terminals.create('workspace', directory);
  assert.equal(second.title, 'Updated terminal');
  assert.equal(second.profileId, custom.id);
  assert.equal(loader.shells[0].file, originalPath);
  assert.equal(loader.shells[1].file, editedPath);
  assert.deepEqual(loader.shells[0].args, []);
  assert.deepEqual(loader.shells[1].args, []);
  const saved = await readFile(join(directory, 'settings.json'), 'utf8');
  files.delete(editedPath);
  const missing = restarted.get();
  assert.equal(missing.customProfiles[0].path, editedPath);
  assert.ok(!missing.profiles.some(profile => profile.id === custom.id));
  assert.notEqual(missing.defaultProfileId, custom.id);
  await assert.rejects(
    terminals.create('workspace', directory, custom.id),
    /installed shell/,
  );
  const fallback = await terminals.create('workspace', directory);
  assert.equal(fallback.profileId, missing.defaultProfileId);
  assert.equal(await readFile(join(directory, 'settings.json'), 'utf8'), saved);
  files.add(editedPath);
  assert.equal(restarted.get().defaultProfileId, custom.id);
  const copy = restarted.get().customProfiles;
  copy[0].label = 'Unpersisted';
  assert.equal(restarted.get().customProfiles[0].label, 'Updated terminal');
  const removed = restarted.remove(custom.id);
  assert.deepEqual(removed.customProfiles, []);
  assert.equal(restartedPreferences.defaultTerminalProfile(), undefined);
  assert.equal(
    new DesktopPreferences(directory).defaultTerminalProfile(),
    undefined,
  );
  assert.equal(
    'defaultTerminalProfileId' in
      JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')),
    false,
  );
  assert.equal(
    (await terminals.open('workspace', directory, second.sessionId)).generation,
    second.generation,
  );
  assert.equal(loader.shells[1].kills(), 0);
  assert.equal(
    (await terminals.create('workspace', directory)).profileId,
    removed.defaultProfileId,
  );
});

void test('custom profile validation rejects unregistered ids and invalid applications, and bounds saved entries', async t => {
  const directory = await temporary(t);
  const preferences = new DesktopPreferences(directory);
  const {profiles, files} = windowsProfiles(preferences);
  const path = 'C:\\Tools\\terminal.exe';
  files.add(path).add('C:\\Tools\\script.cmd').add('C:\\Tools\\script.bat');
  for (const input of [
    null,
    [],
    'shell',
    {},
    {label: '', path},
    {label: '  ', path},
    {label: 'a'.repeat(129), path},
    {label: 'bad\0name', path},
    {label: 'Name', path: 'relative.exe'},
    {label: 'Name', path: 'C:\\missing.exe'},
    {label: 'Name', path: 'C:\\Tools\\script.cmd'},
    {label: 'Name', path: 'C:\\Tools\\script.bat'},
    {label: 'Name', path: 'C:\\' + 'a'.repeat(4096)},
    {label: 'Name', path, args: ['--command', 'do-something']},
    {id: '__proto__', label: 'Name', path},
    {id: `custom-${'a'.repeat(32)}`, label: 'Name', path},
    {id: profiles.get().profiles[0].id, label: 'Name', path},
  ])
    assert.throws(() => profiles.save(input));
  await assert.rejects(readFile(join(directory, 'settings.json')), {
    code: 'ENOENT',
  });
  assert.throws(() => profiles.remove('__proto__'), /saved terminal/);
  assert.throws(
    () => profiles.remove(profiles.get().profiles[0].id),
    /saved terminal/,
  );
  for (let index = 0; index < 32; index++)
    profiles.save({label: `Terminal ${index}`, path});
  assert.equal(profiles.get().customProfiles.length, 32);
  assert.throws(
    () => profiles.save({label: 'Overflow', path}),
    /Remove a terminal profile/,
  );
  const first = profiles.get().customProfiles[0];
  profiles.save({...first, label: 'Edited'});
  assert.equal(profiles.get().customProfiles[0].label, 'Edited');
  profiles.remove(first.id);
  assert.equal(
    profiles.save({label: 'Space available', path}).customProfiles.length,
    32,
  );
});

void test('custom executable validation checks native files and executable permission', async t => {
  const directory = await temporary(t);
  const preferences = new DesktopPreferences(directory);
  const profiles = new DesktopTerminalProfiles(preferences);
  assert.throws(
    () => profiles.save({label: 'Directory', path: directory}),
    /executable terminal/,
  );
  const application = join(
    directory,
    process.platform === 'win32' ? 'terminal.exe' : 'terminal',
  );
  await writeFile(application, '#!/bin/sh\n');
  if (process.platform !== 'win32') {
    assert.throws(
      () => profiles.save({label: 'Unexecutable', path: application}),
      /executable terminal/,
    );
    await chmod(application, 0o700);
  }
  const state = profiles.save({label: 'Custom application', path: application});
  assert.equal(state.customProfiles[0].path, application);
  assert.ok(
    state.profiles.some(profile => profile.id === state.customProfiles[0].id),
  );
  const loader = ptyLoader();
  const terminals = new DesktopTerminals(() => {}, loader.load, {profiles});
  t.after(() => terminals.dispose());
  await terminals.create('custom', directory, state.customProfiles[0].id);
  assert.equal(loader.shells[0].file, application);
  assert.deepEqual(loader.shells[0].args, []);
  await rm(application);
  assert.equal(profiles.get().customProfiles.length, 1);
  assert.ok(
    !profiles
      .get()
      .profiles.some(profile => profile.id === state.customProfiles[0].id),
  );
});

void test('detected account shells retain login flags and custom known shells use normal profiles', async t => {
  const directory = await temporary(t);
  const preferences = new DesktopPreferences(directory);
  const env = {SHELL: '/custom/xonsh'};
  const options = {
    env,
    platform: 'linux' as const,
    exists: (path: string) => ['/custom/xonsh', '/custom/bash'].includes(path),
    userShell: () => undefined,
  };
  const profiles = new DesktopTerminalProfiles(preferences, options);
  const custom = profiles.save({label: 'Custom Bash', path: '/custom/bash'})
    .customProfiles[0];
  const loader = ptyLoader();
  const terminals = new DesktopTerminals(() => {}, loader.load, {
    profiles,
    env,
    platform: 'linux',
  });
  t.after(() => terminals.dispose());
  await terminals.create('detected', directory);
  await terminals.create('known', directory, custom.id);
  assert.equal(loader.shells[0].file, '/custom/xonsh');
  assert.deepEqual(loader.shells[0].args, ['-l']);
  assert.equal(loader.shells[1].file, '/custom/bash');
  assert.deepEqual(loader.shells[1].args, ['-l']);
});

void test('malformed saved custom profiles are discarded and missing applications remain editable without writes', async t => {
  const directory = await temporary(t);
  const custom = {
    id: `custom-${'a'.repeat(32)}`,
    label: 'Missing',
    path: 'C:\\Missing\\terminal.exe',
  };
  const saved = JSON.stringify({
    customTerminalProfiles: [
      {id: '__proto__', label: 'Bad', path: custom.path},
      {id: `custom-${'b'.repeat(32)}`, label: 'Bad', path: 'relative'},
      {id: `custom-${'c'.repeat(32)}`, label: '', path: custom.path},
      custom,
      {...custom, label: 'Duplicate'},
    ],
    defaultTerminalProfileId: custom.id,
  });
  await writeFile(join(directory, 'settings.json'), saved);
  const preferences = new DesktopPreferences(directory);
  const {profiles} = windowsProfiles(preferences);
  assert.deepEqual(profiles.get().customProfiles, [custom]);
  assert.notEqual(profiles.get().defaultProfileId, custom.id);
  assert.equal(preferences.defaultTerminalProfile(), custom.id);
  assert.equal(await readFile(join(directory, 'settings.json'), 'utf8'), saved);
  profiles.remove(custom.id);
  assert.equal(preferences.defaultTerminalProfile(), undefined);
});

void test('failed custom profile saves and removals preserve both profiles and the saved default', async t => {
  const directory = await temporary(t);
  const preferences = new DesktopPreferences(directory);
  const {profiles, files} = windowsProfiles(preferences);
  const path = 'C:\\Tools\\custom.exe';
  files.add(path);
  const custom = profiles.save({label: 'Original', path}).customProfiles[0];
  profiles.setDefault(custom.id);
  await rm(join(directory, 'settings.json'));
  await mkdir(join(directory, 'settings.json'));
  assert.throws(() => profiles.save({...custom, label: 'Failed edit'}));
  assert.throws(() => profiles.remove(custom.id));
  assert.equal(profiles.get().customProfiles[0].label, 'Original');
  assert.equal(profiles.get().defaultProfileId, custom.id);
});

void test('tabs keep independent state and shell selection across default changes and renderer reloads', async t => {
  const directory = await temporary(t);
  const preferences = new DesktopPreferences(directory);
  const {profiles, env} = windowsProfiles(preferences);
  const loader = ptyLoader();
  const events: TerminalSnapshot[] = [];
  const terminals = new DesktopTerminals(
    event => events.push(event),
    loader.load,
    {profiles, env, platform: 'win32'},
  );
  t.after(() => terminals.dispose());
  const first = await terminals.open('workspace', directory);
  const cmd = profiles
    .get()
    .profiles.find(profile => profile.label === 'Command Prompt')!;
  const git = profiles
    .get()
    .profiles.find(profile => profile.label === 'Git Bash')!;
  profiles.setDefault(cmd.id);
  const second = await terminals.create('workspace', directory);
  const third = await terminals.create('other', directory, git.id);
  assert.equal(first.sessionId, 'workspace');
  assert.equal(first.title, 'PowerShell 7');
  assert.equal(second.title, 'Command Prompt');
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal(second.workspaceId, 'workspace');
  assert.equal(second.profileId, cmd.id);
  assert.equal(third.profileId, git.id);
  assert.deepEqual(loader.shells[0].args, ['-NoLogo']);
  assert.deepEqual(loader.shells[1].args, []);
  assert.deepEqual(loader.shells[2].args, ['--login', '-i']);
  assert.equal(
    (loader.shells[2].options.env as NodeJS.ProcessEnv).CHERE_INVOKING,
    '1',
  );
  assert.equal(loader.shells[2].options.cwd, directory);
  loader.shells[0].output('first history');
  loader.shells[1].output('second history');
  assert.deepEqual(
    terminals.list('workspace').map(tab => tab.data),
    ['first history', 'second history'],
  );
  const reloaded = await terminals.open(
    'workspace',
    directory,
    second.sessionId,
  );
  assert.equal(reloaded.data, 'second history');
  assert.equal(reloaded.generation, second.generation);
  assert.equal(
    (await terminals.open('workspace', directory)).generation,
    first.generation,
  );
  assert.equal(loader.shells.length, 3);
  assert.equal(events[1].sessionId, second.sessionId);
  assert.equal(events[1].workspaceId, 'workspace');
  assert.equal(events[1].profileId, cmd.id);
  terminals.write(second.sessionId, 'selected');
  terminals.resize(second.sessionId, 100, 40);
  assert.deepEqual(loader.shells[1].writes, ['selected']);
  assert.deepEqual(loader.shells[0].writes, []);
  assert.deepEqual(loader.shells[1].sizes, [[100, 40]]);
  await assert.rejects(
    terminals.open('workspace', directory, third.sessionId),
    /this workspace/,
  );
  const alias = await terminals.open(third.sessionId, directory);
  assert.notEqual(alias.sessionId, third.sessionId);
  assert.equal(terminals.workspaceFor(third.sessionId), 'other');
  assert.equal(terminals.list('other')[0].generation, third.generation);
  terminals.close(first.sessionId);
  assert.equal(loader.shells[0].kills(), 1);
  assert.deepEqual(
    terminals.list('workspace').map(tab => tab.sessionId),
    [second.sessionId],
  );
  loader.shells[1].exit(7);
  assert.equal(terminals.list('workspace')[0].exitCode, 7);
  assert.equal(events.at(-1)?.exitCode, 7);
  terminals.closeWorkspace('workspace');
  assert.deepEqual(terminals.list('workspace'), []);
  assert.equal(terminals.list('other').length, 1);
  assert.equal(loader.shells[2].kills(), 0);
});

void test('workspace closure cancels pending starts, concurrent legacy opens coalesce, and capacity includes pending tabs', async t => {
  const directory = await temporary(t);
  const {profiles} = windowsProfiles();
  const loader = ptyLoader();
  let release!: (value: PtyModule) => void;
  const loading = new Promise<PtyModule>(resolve => {
    release = resolve;
  });
  const terminals = new DesktopTerminals(
    () => {},
    () => loading,
    {profiles},
  );
  t.after(() => terminals.dispose());
  const first = terminals.open('closing', directory);
  const duplicate = terminals.open('closing', directory);
  const extra = terminals.create('closing', directory);
  const failures = [first, duplicate, extra].map(start =>
    assert.rejects(start, /workspace has closed/),
  );
  terminals.closeWorkspace('closing');
  release(loader.module);
  await Promise.all(failures);
  assert.equal(loader.shells.length, 0);
  const opened = await Promise.all([
    terminals.open('active', directory),
    terminals.open('active', directory),
  ]);
  assert.equal(opened[0].generation, opened[1].generation);
  assert.equal(loader.shells.length, 1);
  terminals.closeWorkspace('active');
  const pending = Array.from({length: 16}, () =>
    terminals.create('many', directory),
  );
  await assert.rejects(
    terminals.create('overflow', directory),
    /Close a terminal/,
  );
  terminals.dispose();
  await Promise.all(
    pending.map(start => assert.rejects(start, /workspace has closed/)),
  );
  assert.equal(loader.shells.length, 1);
});

void test('terminal restoration waits for starts added while listing and tolerates failed starts', async t => {
  const directory = await temporary(t);
  const {profiles} = windowsProfiles();
  const loader = ptyLoader();
  const firstGate = deferred<PtyModule>();
  const secondGate = deferred<PtyModule>();
  const firstEntered = deferred<void>();
  const secondEntered = deferred<void>();
  let loads = 0;
  const terminals = new DesktopTerminals(
    () => {},
    async () => {
      loads++;
      if (loads === 2) {
        firstEntered.resolve();
        return firstGate.promise;
      }
      if (loads === 3) {
        secondEntered.resolve();
        return secondGate.promise;
      }
      return loader.module;
    },
    {profiles},
  );
  t.after(() => terminals.dispose());
  const first = await terminals.create('workspace', directory);
  const second = terminals.create('workspace', directory);
  await firstEntered.promise;
  let restored = false;
  const listing = terminals.listReady('workspace').then(snapshots => {
    restored = true;
    return snapshots;
  });
  const third = terminals.create('workspace', directory);
  await secondEntered.promise;
  firstGate.resolve(loader.module);
  await tick();
  assert.equal(restored, false);
  const failed = terminals.create('workspace', directory, 'removed-profile');
  const rejected = assert.rejects(failed, /installed shell/);
  secondGate.resolve(loader.module);
  const [secondSnapshot, thirdSnapshot, snapshots] = await Promise.all([
    second,
    third,
    listing,
  ]);
  await rejected;
  assert.deepEqual(
    snapshots.map(snapshot => snapshot.sessionId),
    [first.sessionId, secondSnapshot.sessionId, thirdSnapshot.sessionId],
  );
  assert.equal(loader.shells.length, 3);
});

async function applicationBridge(
  terminals: DesktopTerminals,
  terminalProfiles: DesktopTerminalProfiles,
  preferences: DesktopPreferences,
  cwd: string,
  agentSession: (
    id: string,
    request: AgentSessionRequest,
  ) => Promise<AgentSessionResult> = async () => {},
) {
  const source = await readFile(
    new URL('../src/desktop/application.ts', import.meta.url),
    'utf8',
  );
  const parsed = ts.createSourceFile(
    'application.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set([
    'id',
    'isLocalPage',
    'trusted',
    'handle',
    'terminalWorkspace',
    'ownedTerminal',
    'openWorkspaceTerminal',
    'installHandlers',
  ]);
  const pieces = parsed.statements.filter(
    statement =>
      (ts.isFunctionDeclaration(statement) &&
        !!statement.name &&
        names.has(statement.name.text)) ||
      (ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(declaration =>
          ['terminalWorkspaceIds', 'unsubscribe'].includes(
            declaration.name.getText(parsed),
          ),
        )),
  );
  assert.equal(pieces.length, names.size + 2);
  let changed = () => {};
  let fileSelection = {canceled: true, filePaths: [] as string[]};
  let chooserOptions: {properties?: string[]} | undefined;
  let sessions = ['first', 'second'].map(id => ({session: {id, cwd}}));
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const pageUrl = new URL('file:///varisdev/index.html');
  const webContents = {mainFrame: {url: pageUrl.href}};
  const context = {
    URL,
    Error,
    pageUrl,
    mainWindow: {isDestroyed: () => false, webContents},
    ipcMain: {
      handle: (
        name: string,
        handler: (...args: unknown[]) => Promise<unknown>,
      ) => {
        handlers.set(name, handler);
      },
    },
    terminals,
    terminalProfiles,
    preferences,
    process: {platform: process.platform},
    dialog: {
      showOpenDialog: async (
        _window: unknown,
        options: typeof chooserOptions,
      ) => {
        chooserOptions = options;
        return fileSelection;
      },
    },
    DashboardInputError,
    shuttingDown: false,
    restarting: false,
    transferringStartup: false,
    sessionOperations: 0,
    closingSessions: new Set(),
    sessionActions: new Set([
      'pidev:create-session',
      'pidev:close-session',
      'pidev:agent-session',
    ]),
    updateMessage: (message: string) => message,
    getToolModels: () => {},
    saveToolModel: () => {},
    restartForUpdate: () => {},
    hub: {
      agentSession,
      deliverySnapshot: () => ({sessions}),
      subscribe: (listener: () => void) => {
        changed = listener;
        return () => {};
      },
      closeSession: async (id: string) => {
        sessions = sessions.filter(item => item.session.id !== id);
        changed();
      },
      createSession: async () => {
        sessions = [{session: {id: 'replacement', cwd}}];
        changed();
        return {id: 'replacement'};
      },
    },
    console,
  };
  vm.runInNewContext(
    ts.transpileModule(pieces.map(piece => piece.getText(parsed)).join('\n'), {
      compilerOptions: {target: ts.ScriptTarget.ES2024},
    }).outputText + '\ninstallHandlers();',
    context,
  );
  let bridge!: {
    getTerminalProfiles(): Promise<ReturnType<DesktopTerminalProfiles['get']>>;
    setDefaultTerminalProfile(
      id: string,
    ): Promise<ReturnType<DesktopTerminalProfiles['get']>>;
    saveTerminalProfile(
      input: unknown,
    ): Promise<ReturnType<DesktopTerminalProfiles['get']>>;
    removeTerminalProfile(
      id: string,
    ): Promise<ReturnType<DesktopTerminalProfiles['get']>>;
    chooseTerminalExecutable(): Promise<string | undefined>;
    listTerminals(id: string): Promise<TerminalSnapshot[]>;
    createTerminal(id: string, profileId?: string): Promise<TerminalSnapshot>;
    openTerminal(
      workspace: string,
      terminal?: string,
    ): Promise<TerminalSnapshot>;
    writeTerminal(id: string, data: string): Promise<void>;
    resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
    closeTerminal(id: string): Promise<void>;
    closeSession(id: string): Promise<void>;
    agentSession(
      id: string,
      request: AgentSessionRequest,
    ): Promise<AgentSessionResult>;
    createSession(input: unknown): Promise<{id: string}>;
  };
  vm.runInNewContext(
    await readFile(
      new URL('../assets/desktop/preload.cjs', import.meta.url),
      'utf8',
    ),
    {
      require: () => ({
        contextBridge: {
          exposeInMainWorld: (_name: string, value: typeof bridge) => {
            bridge = value;
          },
        },
        ipcRenderer: {
          invoke: (name: string, ...args: unknown[]) => {
            assert.ok(handlers.has(name), name);
            return handlers.get(name)!(
              {sender: webContents, senderFrame: webContents.mainFrame},
              ...args,
            );
          },
        },
      }),
    },
  );
  return {
    bridge,
    chooseFile: (path?: string) => {
      fileSelection = {
        canceled: path === undefined,
        filePaths: path ? [path] : [],
      };
    },
    chooserOptions: () => chooserOptions,
    removeWorkspace: (id: string) => {
      sessions = sessions.filter(item => item.session.id !== id);
      changed();
    },
  };
}

void test('preload and application validate workspace ownership and manage every tab through close and resume', async t => {
  const directory = await temporary(t);
  const preferences = new DesktopPreferences(directory);
  const {profiles, env} = windowsProfiles(preferences);
  const loader = ptyLoader();
  const terminals = new DesktopTerminals(() => {}, loader.load, {
    profiles,
    env,
    platform: 'win32',
  });
  t.after(() => terminals.dispose());
  const {bridge, removeWorkspace} = await applicationBridge(
    terminals,
    profiles,
    preferences,
    directory,
  );
  const shells = await bridge.getTerminalProfiles();
  assert.equal(shells.profiles.length, 4);
  await bridge.setDefaultTerminalProfile(shells.profiles[2].id);
  const one = await bridge.createTerminal('first');
  const two = await bridge.createTerminal('first', shells.profiles[3].id);
  await bridge.openTerminal('second');
  assert.equal(one.profileId, shells.profiles[2].id);
  assert.equal(two.profileId, shells.profiles[3].id);
  assert.equal((await bridge.listTerminals('first')).length, 2);
  assert.equal(
    (await bridge.openTerminal('first', two.sessionId)).generation,
    two.generation,
  );
  assert.equal((await bridge.openTerminal('first')).sessionId, one.sessionId);
  await assert.rejects(
    bridge.openTerminal('second', one.sessionId),
    /this workspace/,
  );
  await assert.rejects(bridge.createTerminal('missing'), /open workspace/);
  await assert.rejects(
    bridge.createTerminal('first', 'unknown'),
    /installed shell/,
  );
  await bridge.writeTerminal(two.sessionId, 'hello');
  await bridge.resizeTerminal(two.sessionId, 99, 22);
  await bridge.closeTerminal(two.sessionId);
  assert.equal((await bridge.listTerminals('first')).length, 1);
  assert.equal(loader.shells[0].kills(), 0);
  assert.equal(loader.shells[1].kills(), 1);
  await bridge.closeSession('first');
  assert.equal(loader.shells[0].kills(), 1);
  assert.equal(loader.shells[2].kills(), 0);
  await assert.rejects(
    bridge.writeTerminal(one.sessionId, 'stale'),
    /open terminal/,
  );
  await bridge.createTerminal('second');
  assert.equal((await bridge.createSession({})).id, 'replacement');
  assert.equal(loader.shells[2].kills(), 1);
  assert.equal(loader.shells[3].kills(), 1);
  assert.deepEqual(terminals.list('second'), []);
  const added = await bridge.createTerminal('replacement');
  removeWorkspace('replacement');
  assert.equal(loader.shells[4].kills(), 1);
  assert.deepEqual(terminals.list('replacement'), []);
  await assert.rejects(
    bridge.writeTerminal(added.sessionId, 'stale'),
    /open terminal/,
  );
  await assert.rejects(
    bridge.resizeTerminal(added.sessionId, 80, 24),
    /open terminal/,
  );
  await assert.rejects(bridge.listTerminals('replacement'), /open workspace/);
});

void test('application agent closure preserves native tabs until the backend confirms workspace closure', async t => {
  const directory = await temporary(t);
  const preferences = new DesktopPreferences(directory);
  const {profiles, env} = windowsProfiles(preferences);
  const loader = ptyLoader();
  const terminals = new DesktopTerminals(() => {}, loader.load, {
    profiles,
    env,
    platform: 'win32',
  });
  t.after(() => terminals.dispose());
  const requests: Array<{id: string; request: AgentSessionRequest}> = [];
  const results: AgentSessionResult[] = [
    undefined,
    {requiresWorkspaceCloseConfirmation: true},
    {workspaceClosed: true},
  ];
  const {bridge} = await applicationBridge(
    terminals,
    profiles,
    preferences,
    directory,
    async (id, request) => {
      requests.push({id, request});
      // The close reply can arrive before the snapshot removes the workspace.
      return results.shift();
    },
  );
  const first = await bridge.createTerminal('first');
  const second = await bridge.createTerminal('first');
  const other = await bridge.createTerminal('second');
  loader.shells[0].output('workspace history');
  assert.equal(
    await bridge.agentSession('first', {agentId: 'parent', action: 'close'}),
    undefined,
  );
  assert.deepEqual(
    (await bridge.listTerminals('first')).map(terminal => terminal.sessionId),
    [first.sessionId, second.sessionId],
  );
  assert.deepEqual(
    loader.shells.map(shell => shell.kills()),
    [0, 0, 0],
  );
  assert.deepEqual(
    await bridge.agentSession('first', {agentId: 'primary', action: 'close'}),
    {requiresWorkspaceCloseConfirmation: true},
  );
  assert.deepEqual(
    loader.shells.map(shell => shell.kills()),
    [0, 0, 0],
  );
  const restored = await bridge.openTerminal('first', first.sessionId);
  assert.equal(restored.generation, first.generation);
  assert.equal(restored.data, 'workspace history');
  assert.deepEqual(
    await bridge.agentSession('first', {
      agentId: 'primary',
      action: 'close',
      confirmWorkspaceClose: true,
    }),
    {workspaceClosed: true},
  );
  assert.deepEqual(requests, [
    {id: 'first', request: {agentId: 'parent', action: 'close'}},
    {id: 'first', request: {agentId: 'primary', action: 'close'}},
    {
      id: 'first',
      request: {
        agentId: 'primary',
        action: 'close',
        confirmWorkspaceClose: true,
      },
    },
  ]);
  assert.deepEqual(
    loader.shells.map(shell => shell.kills()),
    [1, 1, 0],
  );
  assert.deepEqual(terminals.list('first'), []);
  await assert.rejects(
    bridge.writeTerminal(first.sessionId, 'stale'),
    /open terminal/,
  );
  await assert.rejects(
    bridge.writeTerminal(second.sessionId, 'stale'),
    /open terminal/,
  );
  assert.equal(
    (await bridge.openTerminal('second', other.sessionId)).generation,
    other.generation,
  );
});

void test('application and preload save, edit, remove and choose custom terminal executables', async t => {
  const directory = await temporary(t);
  const preferences = new DesktopPreferences(directory);
  const {profiles, files, env} = windowsProfiles(preferences);
  const path = 'C:\\Tools\\custom.exe';
  const updated = 'C:\\Tools\\updated.exe';
  files.add(path).add(updated);
  const loader = ptyLoader();
  const terminals = new DesktopTerminals(() => {}, loader.load, {
    profiles,
    env,
    platform: 'win32',
  });
  t.after(() => terminals.dispose());
  const {bridge, chooseFile, chooserOptions} = await applicationBridge(
    terminals,
    profiles,
    preferences,
    directory,
  );
  assert.equal(await bridge.chooseTerminalExecutable(), undefined);
  chooseFile(path);
  assert.equal(await bridge.chooseTerminalExecutable(), path);
  assert.equal(chooserOptions()?.properties?.join(','), 'openFile');
  const added = await bridge.saveTerminalProfile({label: 'Original', path});
  const custom = added.customProfiles[0];
  await bridge.setDefaultTerminalProfile(custom.id);
  const first = await bridge.createTerminal('first');
  assert.equal(first.profileId, custom.id);
  assert.equal(loader.shells[0].file, path);
  await bridge.saveTerminalProfile({
    id: custom.id,
    label: 'Updated',
    path: updated,
  });
  const second = await bridge.createTerminal('first');
  assert.equal(second.profileId, custom.id);
  assert.equal(loader.shells[1].file, updated);
  assert.equal(
    (await bridge.openTerminal('first', first.sessionId)).title,
    'Original',
  );
  const removed = await bridge.removeTerminalProfile(custom.id);
  assert.equal(removed.customProfiles.length, 0);
  assert.equal(preferences.defaultTerminalProfile(), undefined);
  assert.equal((await bridge.listTerminals('first')).length, 2);
  await assert.rejects(
    bridge.createTerminal('first', custom.id),
    /installed shell/,
  );
  await assert.rejects(
    bridge.saveTerminalProfile({id: custom.id, label: 'Unknown', path}),
    /saved terminal/,
  );
  assert.equal(
    (await bridge.createTerminal('first')).profileId,
    removed.defaultProfileId,
  );
});

void test('renderer restoration lists an additional silent terminal that was starting during reload', async t => {
  const directory = await temporary(t);
  const preferences = new DesktopPreferences(directory);
  const {profiles} = windowsProfiles(preferences);
  const loader = ptyLoader();
  const gate = deferred<PtyModule>();
  const entered = deferred<void>();
  let delay = false;
  const terminals = new DesktopTerminals(
    () => {},
    async () => {
      if (!delay) return loader.module;
      entered.resolve();
      return gate.promise;
    },
    {profiles},
  );
  t.after(() => terminals.dispose());
  const {bridge} = await applicationBridge(
    terminals,
    profiles,
    preferences,
    directory,
  );
  const first = await bridge.createTerminal('first');
  delay = true;
  const starting = bridge.createTerminal('first');
  await entered.promise;
  let restored = false;
  const listing = bridge.listTerminals('first').then(snapshots => {
    restored = true;
    return snapshots;
  });
  await tick();
  assert.equal(restored, false);
  assert.equal(terminals.list('first').length, 1);
  gate.resolve(loader.module);
  const [second, snapshots] = await Promise.all([starting, listing]);
  assert.deepEqual(
    snapshots.map(snapshot => snapshot.sessionId),
    [first.sessionId, second.sessionId],
  );
  assert.equal(snapshots[1].data, '');
  assert.equal(loader.shells.length, 2);
  assert.equal(
    (await bridge.openTerminal('first', second.sessionId)).generation,
    second.generation,
  );
});

void test('workspace closure while restoring cancels pending starts and rejects the stale listing', async t => {
  const directory = await temporary(t);
  const preferences = new DesktopPreferences(directory);
  const {profiles} = windowsProfiles(preferences);
  const loader = ptyLoader();
  const gate = deferred<PtyModule>();
  const entered = deferred<void>();
  let delay = false;
  const terminals = new DesktopTerminals(
    () => {},
    async () => {
      if (!delay) return loader.module;
      entered.resolve();
      return gate.promise;
    },
    {profiles},
  );
  t.after(() => terminals.dispose());
  const {bridge} = await applicationBridge(
    terminals,
    profiles,
    preferences,
    directory,
  );
  await bridge.createTerminal('first');
  delay = true;
  const starting = bridge.createTerminal('first');
  const rejectedStart = assert.rejects(starting, /workspace has closed/);
  await entered.promise;
  const listing = bridge.listTerminals('first');
  const rejectedList = assert.rejects(listing, /open workspace/);
  await bridge.closeSession('first');
  gate.resolve(loader.module);
  await Promise.all([rejectedStart, rejectedList]);
  assert.equal(loader.shells.length, 1);
  assert.equal(loader.shells[0].kills(), 1);
  assert.deepEqual(terminals.list('first'), []);
});

void test('application close racing native startup cannot leave a shell behind', async t => {
  const directory = await temporary(t);
  const preferences = new DesktopPreferences(directory);
  const {profiles} = windowsProfiles(preferences);
  const loader = ptyLoader();
  let release!: (value: PtyModule) => void;
  const loading = new Promise<PtyModule>(resolve => {
    release = resolve;
  });
  const terminals = new DesktopTerminals(
    () => {},
    () => loading,
    {profiles},
  );
  t.after(() => terminals.dispose());
  const {bridge} = await applicationBridge(
    terminals,
    profiles,
    preferences,
    directory,
  );
  const starting = bridge.createTerminal('first');
  const rejected = assert.rejects(starting, /workspace has closed/);
  await bridge.closeSession('first');
  release(loader.module);
  await rejected;
  assert.equal(loader.shells.length, 0);
  assert.deepEqual(terminals.list('first'), []);
});
