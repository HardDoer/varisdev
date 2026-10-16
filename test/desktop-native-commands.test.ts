import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import type {MessageBoxOptions} from 'electron';
import {
  DesktopCommands,
  desktopCopyTextLimit,
} from '../src/desktop/commands.ts';

function fakeElectron() {
  const copied: string[] = [];
  const confirmations: MessageBoxOptions[] = [];
  const sessionTexts = new Map<string, string>();
  const requestedSessions: string[] = [];
  const lastAssistantText = (sessionId: string) => {
    requestedSessions.push(sessionId);
    const text = sessionTexts.get(sessionId);
    if (text === undefined)
      throw new Error('No assistant text for this session.');
    return text;
  };
  let response = 0;
  let quits = 0;
  const clipboard = {writeText: (text: string) => void copied.push(text)};
  const app = {quit: () => void quits++};
  const dialog = {
    showMessageBox: async (_window: unknown, options: MessageBoxOptions) => {
      confirmations.push(options);
      return {response};
    },
  };
  const commands = new DesktopCommands({
    clipboard,
    lastAssistantText,
    showQuitConfirmation: options => dialog.showMessageBox(undefined, options),
    quit: app.quit,
  });
  return {
    commands,
    clipboard,
    dialog,
    app,
    copied,
    confirmations,
    sessionTexts,
    requestedSessions,
    lastAssistantText,
    get quits() {
      return quits;
    },
    setResponse(value: number) {
      response = value;
    },
  };
}

void test('native copy preserves bounded text and rejects malformed or unknown commands without side effects', async () => {
  const native = fakeElectron();
  for (const text of [
    '',
    'Unicode 🪶\n  keep whitespace  ',
    'x'.repeat(desktopCopyTextLimit),
  ]) {
    assert.deepEqual(await native.commands.execute('copy', {text}), {ok: true});
    assert.equal(native.copied.at(-1), text);
  }
  for (const input of [
    undefined,
    null,
    [],
    'text',
    42,
    new Date(),
    {},
    {text: 42},
    {sessionId: ''},
    {sessionId: 42},
    {sessionId: 'x'.repeat(257)},
    {sessionId: 'parent', text: 'preview'},
    {sessionId: 'parent', force: true},
    {text: 'ok', url: 'https://example.com'},
    {text: 'x'.repeat(desktopCopyTextLimit + 1)},
  ])
    await assert.rejects(
      native.commands.execute('copy', input),
      /input object|Copy requires/,
    );
  for (const action of [
    undefined,
    {},
    'shell',
    'openExternal',
    '__proto__',
    'COPY',
  ])
    await assert.rejects(
      native.commands.execute(action, {}),
      /Unknown desktop command/,
    );
  assert.equal(native.copied.length, 3);
  assert.equal(native.confirmations.length, 0);
  assert.equal(native.quits, 0);
});

void test('session copy reads the full native assistant text without preview truncation', async () => {
  const native = fakeElectron();
  const fullText =
    'Full assistant response 🪶\n' + 'x'.repeat(desktopCopyTextLimit + 1);
  const sessionId = 's'.repeat(256);
  native.sessionTexts.set(sessionId, fullText);
  assert.deepEqual(await native.commands.execute('copy', {sessionId}), {
    ok: true,
  });
  assert.equal(native.copied[0], fullText);
  assert.deepEqual(native.requestedSessions, [sessionId]);
  await assert.rejects(
    native.commands.execute('copy', {sessionId: 'stale'}),
    /No assistant text/,
  );
  assert.equal(native.copied.length, 1);
});

void test('native quit requires empty input and affirmative cancel-default confirmation', async () => {
  const native = fakeElectron();
  for (const input of [
    undefined,
    null,
    [],
    new Date(),
    {force: true},
    {text: ''},
  ])
    await assert.rejects(
      native.commands.execute('quit', input),
      /input object|empty input/,
    );
  assert.equal(native.confirmations.length, 0);
  assert.deepEqual(await native.commands.execute('quit', {}), {
    cancelled: true,
  });
  const options = native.confirmations[0];
  assert.deepEqual(options.buttons, ['Cancel', 'Quit VarisDev']);
  assert.equal(options.defaultId, 0);
  assert.equal(options.cancelId, 0);
  assert.equal(native.quits, 0);
  native.setResponse(1);
  assert.deepEqual(await native.commands.execute('quit', {}), {
    cancelled: false,
  });
  assert.equal(native.quits, 1);
  native.setResponse(2);
  assert.deepEqual(await native.commands.execute('quit', {}), {
    cancelled: true,
  });
  assert.equal(native.quits, 1);
  assert.deepEqual(native.copied, []);
});

void test('quit coalesces pending confirmations and allows retry after dialog errors', async () => {
  let settle!: (value: {response: number}) => void;
  let prompts = 0;
  let quits = 0;
  const commands = new DesktopCommands({
    clipboard: {writeText: () => assert.fail('Unexpected clipboard access')},
    lastAssistantText: () => assert.fail('Unexpected transcript access'),
    showQuitConfirmation: () => {
      prompts++;
      return new Promise(resolve => {
        settle = resolve;
      });
    },
    quit: () => void quits++,
  });
  const first = commands.execute('quit', {});
  const second = commands.execute('quit', {});
  assert.equal(prompts, 1);
  settle({response: 1});
  assert.deepEqual(await Promise.all([first, second]), [
    {cancelled: false},
    {cancelled: false},
  ]);
  assert.equal(quits, 1);

  let attempts = 0;
  const failing = new DesktopCommands({
    clipboard: {
      writeText: () => {
        throw new Error('Clipboard unavailable');
      },
    },
    lastAssistantText: () => assert.fail('Unexpected transcript access'),
    showQuitConfirmation: async () => {
      if (++attempts === 1) throw new Error('Dialog unavailable');
      return {response: 0};
    },
    quit: () => assert.fail('Unexpected quit'),
  });
  await assert.rejects(
    failing.execute('copy', {text: 'hello'}),
    /Clipboard unavailable/,
  );
  await assert.rejects(failing.execute('quit', {}), /Dialog unavailable/);
  assert.deepEqual(await failing.execute('quit', {}), {cancelled: true});
});

void test('production preload and trusted main IPC route only native allowlisted commands', async () => {
  const native = fakeElectron();
  const source = await readFile(
    new URL('../src/desktop/main.ts', import.meta.url),
    'utf8',
  );
  const parsed = ts.createSourceFile(
    'main.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  // Execute the actual production adapter, trust checks and handler in isolation:
  // no Electron process, OS clipboard, filesystem profile or application quit.
  const pieces: string[] = [];
  for (const statement of parsed.statements) {
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        declaration => declaration.name.getText(parsed) === 'desktopCommands',
      )
    )
      pieces.push(statement.getText(parsed));
    if (!ts.isFunctionDeclaration(statement)) continue;
    const name = statement.name?.text;
    if (name && ['isLocalPage', 'trusted', 'handle', 'id'].includes(name))
      pieces.push(statement.getText(parsed));
    if (name === 'installHandlers') {
      const handler = statement.body?.statements.find(item =>
        item.getText(parsed).startsWith("handle('pidev:desktop-command',"),
      );
      assert.ok(handler, 'Native command must use the trusted IPC wrapper');
      pieces.push(handler.getText(parsed));
    }
  }
  assert.equal(pieces.length, 6);
  const handlers = new Map<
    string,
    (event: unknown, ...args: unknown[]) => Promise<unknown>
  >();
  const pageUrl = new URL('file:///app/assets/dashboard/index.html');
  const frame = {url: pageUrl.href};
  const webContents = {mainFrame: frame};
  const mainWindow = {webContents, isDestroyed: () => false};
  const context = vm.createContext({
    DesktopCommands,
    clipboard: native.clipboard,
    dialog: native.dialog,
    app: native.app,
    hub: {lastAssistantText: native.lastAssistantText},
    DashboardInputError: Error,
    mainWindow,
    pageUrl,
    URL,
    Error,
    shuttingDown: false,
    restarting: false,
    sessionActions: new Set(),
    sessionOperations: 0,
    updateMessage: (message: string) => message,
    ipcMain: {
      handle: (
        channel: string,
        handler: (event: unknown, ...args: unknown[]) => Promise<unknown>,
      ) => handlers.set(channel, handler),
    },
  });
  vm.runInContext(
    ts.transpileModule(pieces.join('\n'), {
      compilerOptions: {target: ts.ScriptTarget.ES2022},
    }).outputText,
    context,
  );
  const handler = handlers.get('pidev:desktop-command');
  assert.ok(handler);
  let event = {sender: webContents, senderFrame: frame};
  const invocations: string[] = [];
  let api!: {
    desktopCommand: (action: unknown, input: unknown) => Promise<unknown>;
  };
  vm.runInNewContext(
    await readFile(
      new URL('../assets/desktop/preload.cjs', import.meta.url),
      'utf8',
    ),
    {
      require: (name: string) => {
        assert.equal(name, 'electron');
        return {
          contextBridge: {
            exposeInMainWorld: (name: string, value: typeof api) => {
              assert.equal(name, 'pidev');
              api = value;
            },
          },
          ipcRenderer: {
            invoke: (channel: string, ...args: unknown[]) => {
              invocations.push(channel);
              assert.equal(channel, 'pidev:desktop-command');
              return handler(event, ...args);
            },
          },
          webFrame: {},
        };
      },
    },
  );
  assert.deepEqual(await api.desktopCommand('copy', {text: 'clipboard text'}), {
    ok: true,
  });
  native.sessionTexts.set('native-parent', 'Full real native assistant text');
  assert.deepEqual(
    await api.desktopCommand('copy', {sessionId: 'native-parent'}),
    {ok: true},
  );
  assert.deepEqual(native.requestedSessions, ['native-parent']);
  await assert.rejects(
    api.desktopCommand('copy', {sessionId: 'stale'}),
    /No assistant text/,
  );
  assert.deepEqual(await api.desktopCommand('quit', {}), {cancelled: true});
  native.setResponse(1);
  assert.deepEqual(await api.desktopCommand('quit', {}), {cancelled: false});
  assert.equal(native.quits, 1);
  await assert.rejects(
    api.desktopCommand('shell', {command: 'rm -rf /'}),
    /Unknown desktop command/,
  );
  await assert.rejects(api.desktopCommand('copy', {text: 42}), /Copy requires/);

  for (const invalid of [
    {sender: {}, senderFrame: frame},
    {sender: webContents, senderFrame: {url: pageUrl.href}},
  ]) {
    event = invalid as typeof event;
    await assert.rejects(
      api.desktopCommand('copy', {text: 'untrusted'}),
      /unavailable/,
    );
  }
  event = {sender: webContents, senderFrame: frame};
  frame.url = 'https://example.com/';
  await assert.rejects(api.desktopCommand('quit', {}), /unavailable/);
  frame.url = pageUrl.href;
  for (const flag of ['shuttingDown', 'restarting']) {
    context[flag] = true;
    await assert.rejects(api.desktopCommand('quit', {}), /unavailable/);
    context[flag] = false;
  }
  assert.deepEqual(native.copied, [
    'clipboard text',
    'Full real native assistant text',
  ]);
  assert.equal(native.confirmations.length, 2);
  assert.ok(invocations.length > 5);
  assert.match(source, /app\.on\('before-quit',[\s\S]*?void shutdown\(\)/);
});
