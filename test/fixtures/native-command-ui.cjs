/* global process, __dirname, document, Event, setTimeout, localStorage */
const assert = require('node:assert/strict');
const {writeFileSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {app, BrowserWindow, ipcMain} = require('electron');
const [directory, reportPath] = process.argv.slice(2);
const report = {cases: []};
let browser;
let hub;
let accountStarts = 0;
let accountRevision = 1;
let closeGate;
let copyGate;
const prompts = [];
const responses = [];
const desktop = [];
const created = [];
const navigationOrder = [];
const errors = [];
app.setPath('userData', join(directory, 'profile'));
app.setPath('sessionData', join(directory, 'session'));
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
const evaluate = (fn, arg) =>
  browser.webContents.executeJavaScript(
    `(${fn.toString()})(${JSON.stringify(arg)})`,
  );
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await delay(15);
  }
  throw new Error(`Timed out: ${check}`);
}
function handle(channel, action) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return {ok: true, value: await action(...args)};
    } catch (error) {
      return {ok: false, error: error.message};
    }
  });
}
function parent(id) {
  const at = new Date().toISOString();
  return {
    session: {
      id,
      name: id,
      cwd: directory,
      status: 'idle',
      activity: 'Ready',
      startedAt: at,
      updatedAt: at,
      owned: true,
      controllable: true,
    },
    agents: [],
    totalAgents: 0,
    events: [],
    changes: [],
    conversation: [],
    conversationTruncated: false,
    queue: {steering: [], followUp: []},
    ui: {dialogs: []},
  };
}
function publish() {
  browser.webContents.send('pidev:snapshot', hub);
}
function accounts() {
  return {
    revision: accountRevision,
    providers: [
      {
        id: 'openai',
        name: 'OpenAI',
        status: 'API key saved',
        stored: true,
        oauth: false,
        apiKey: true,
      },
      {
        id: 'anthropic',
        name: 'Anthropic',
        status: 'Not connected',
        stored: false,
        oauth: false,
        apiKey: true,
      },
    ],
    links: [],
    message: '',
  };
}
async function submit(value) {
  await evaluate(value => {
    const editor = document.getElementById('parent-prompt');
    editor.value = value;
    editor.dispatchEvent(new Event('input', {bubbles: true}));
    document.getElementById('prompt-form').requestSubmit();
  }, value);
  await delay(50);
}
async function draft(value) {
  await evaluate(value => {
    const editor = document.getElementById('parent-prompt');
    editor.value = value;
    editor.dispatchEvent(new Event('input', {bubbles: true}));
  }, value);
}
async function select(id) {
  browser.webContents.send('varisdev:select-session', id);
  await waitFor(() =>
    evaluate(
      id => document.getElementById('prompt-recipient').textContent === id,
      id,
    ),
  );
}
async function main() {
  await app.whenReady();
  hub = {
    sessions: [parent('origin'), parent('other')],
    selectedSessionId: 'origin',
    launchCwd: directory,
  };
  browser = new BrowserWindow({
    show: false,
    width: 1200,
    height: 850,
    webPreferences: {
      preload: resolve(__dirname, '../../assets/desktop/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  browser.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });
  handle('pidev:get-state', () => hub);
  handle('pidev:recent-projects', () => []);
  handle('varisdev:get-agent-notice', () => ({acknowledged: true}));
  handle('varisdev:get-update-status', () => ({phase: 'idle'}));
  handle('varisdev:app-themes', () => ({themes: [], errors: []}));
  handle('varisdev:get-accounts', accounts);
  handle('varisdev:account-start', () => {
    accountStarts++;
    accountRevision++;
    return accounts();
  });
  handle('pidev:session-features', () => ({
    commands: [],
    tools: [],
    models: [],
    diagnostics: [],
    thinkingLevel: 'off',
    thinkingLevels: ['off'],
  }));
  handle('pidev:desktop-command', async (name, input) => {
    desktop.push([name, input]);
    if (name === 'copy') {
      await copyGate?.promise;
      return {ok: true};
    }
    return {cancelled: true};
  });
  handle('pidev:prompt-session', (id, input) => {
    prompts.push([id, input.prompt]);
    const data = hub.sessions.find(item => item.session.id === id);
    if (input.prompt === '/thinking')
      data.ui.dialogs = [
        {
          id: 'thinking',
          kind: 'select',
          title: 'Thinking',
          options: ['Off', 'Low', 'High'],
          selected: 'High',
          searchable: true,
        },
      ];
    if (input.prompt === '/session')
      data.ui.dialogs = [
        {
          id: 'info',
          kind: 'info',
          title: 'Session information',
          message: 'Read-only session statistics\nNo prompt is required.',
        },
      ];
    publish();
  });
  handle('pidev:respond-to-dialog', (id, dialogId, value) => {
    responses.push([id, dialogId, value]);
    const data = hub.sessions.find(item => item.session.id === id);
    if (dialogId === 'navigation') {
      navigationOrder.push('ack');
      delete data.ui.navigation;
    } else data.ui.dialogs = [];
    publish();
  });
  handle('pidev:list-sessions', () => [
    {
      id: 'saved-session',
      name: 'Saved fixture',
      modified: new Date().toISOString(),
      messageCount: 2,
    },
  ]);
  handle('pidev:close-session', async id => {
    if (closeGate) {
      closeGate.id = id;
      await closeGate.promise;
    }
    hub.sessions = hub.sessions.filter(item => item.session.id !== id);
    publish();
  });
  handle('pidev:create-session', input => {
    created.push(input);
    const id =
      input.sessionId === 'saved-session'
        ? 'resumed'
        : input.sessionId === 'prepared-fork'
          ? 'navigated'
          : 'fresh';
    if (id === 'navigated') {
      navigationOrder.push('create');
      assert.deepEqual(navigationOrder, ['ack', 'create']);
      hub.sessions = hub.sessions.filter(item => item.session.id !== 'other');
    }
    hub.sessions.push(parent(id));
    publish();
    return {id};
  });
  await browser.loadFile(
    resolve(__dirname, '../../assets/dashboard/index.html'),
  );
  await waitFor(() =>
    evaluate(
      () =>
        document.getElementById('prompt-recipient').textContent === 'origin',
    ),
  );

  await submit('/login anthropic');
  assert.equal(
    await evaluate(() => document.getElementById('accounts-dialog').open),
    true,
  );
  assert.equal(
    await evaluate(() => document.getElementById('accounts-provider').value),
    'anthropic',
  );
  await evaluate(() => document.getElementById('accounts-close').click());
  await submit('/logout openai');
  assert.equal(
    await evaluate(
      () => document.getElementById('accounts-logout-confirmation').hidden,
    ),
    false,
  );
  assert.equal(accountStarts, 0);
  await evaluate(() =>
    document.getElementById('accounts-logout-cancel').click(),
  );
  assert.equal(accountStarts, 0);
  await evaluate(() => document.getElementById('accounts-logout').click());
  await evaluate(() =>
    document.getElementById('accounts-logout-confirm').click(),
  );
  await waitFor(() => accountStarts === 1);
  await evaluate(() => document.getElementById('accounts-close').click());
  await submit('/login unknown-provider');
  assert.match(
    await evaluate(() => document.getElementById('accounts-error').textContent),
    /Unknown account provider/,
  );
  assert.equal(
    await evaluate(() => document.getElementById('parent-prompt').value),
    '/login unknown-provider',
  );
  await evaluate(() => document.getElementById('accounts-close').click());
  report.cases.push(
    'account slash commands choose real providers and require explicit sign-out confirmation',
  );

  for (const command of [
    '/settings',
    '/model openai/test',
    '/thinking low',
    '/extension-fixture',
  ])
    await submit(command);
  await submit('/thinking');
  await waitFor(() =>
    evaluate(() => document.getElementById('extension-dialog').open),
  );
  assert.equal(
    await evaluate(
      () => document.getElementById('extension-dialog-select').value,
    ),
    'High',
  );
  assert.equal(
    await evaluate(
      () => document.getElementById('extension-dialog-current').textContent,
    ),
    'Current: High',
  );
  await evaluate(() => {
    const search = document.getElementById('extension-dialog-search');
    search.value = 'low';
    search.dispatchEvent(new Event('input'));
  });
  assert.equal(
    await evaluate(
      () => document.getElementById('extension-dialog-select').options.length,
    ),
    1,
  );
  await evaluate(() =>
    document.getElementById('extension-dialog-form').requestSubmit(),
  );
  await waitFor(() => responses.some(item => item[1] === 'thinking'));
  assert.deepEqual(
    responses.find(item => item[1] === 'thinking'),
    ['origin', 'thinking', 'Low'],
  );
  await submit('/session');
  await waitFor(() =>
    evaluate(() => document.getElementById('extension-dialog').open),
  );
  assert.equal(
    await evaluate(
      () => document.getElementById('extension-dialog-input').hidden,
    ),
    true,
  );
  assert.equal(
    await evaluate(
      () => document.getElementById('submit-extension-dialog').textContent,
    ),
    'OK',
  );
  assert.equal(
    await evaluate(
      () => document.getElementById('cancel-extension-dialog').textContent,
    ),
    'Close',
  );
  await evaluate(() =>
    document.getElementById('extension-dialog-form').requestSubmit(),
  );
  await waitFor(() => responses.some(item => item[1] === 'info'));
  assert.equal(prompts.length, 6);
  report.cases.push(
    'SDK commands reach promptSession and selected searchable/read-only dialogs render natively',
  );

  for (const command of ['new', 'resume', 'copy', 'hotkeys', 'quit']) {
    await submit(`/${command} unexpected`);
    assert.equal(
      await evaluate(() => document.getElementById('prompt-error').textContent),
      `Usage: /${command}`,
    );
    assert.equal(
      await evaluate(() => document.getElementById('parent-prompt').value),
      `/${command} unexpected`,
    );
  }
  assert.equal(
    prompts.length,
    6,
    'invalid native arguments never become a model prompt',
  );
  assert.equal(desktop.length, 0);
  await submit('/hotkeys');
  assert.equal(
    await evaluate(() => document.getElementById('hotkeys-dialog').open),
    true,
  );
  assert.match(
    await evaluate(() => document.getElementById('hotkeys-dialog').textContent),
    /Shift|Markdown/,
  );
  await evaluate(() => document.getElementById('hotkeys-close').click());
  copyGate = Promise.withResolvers();
  await submit('/copy');
  await draft('New text typed while copy is pending');
  copyGate.resolve();
  await waitFor(() =>
    evaluate(() => !document.getElementById('send-prompt').disabled),
  );
  assert.equal(
    await evaluate(() => document.getElementById('parent-prompt').value),
    'New text typed while copy is pending',
  );
  assert.deepEqual(desktop[0], ['copy', {sessionId: 'origin'}]);
  await submit('/quit');
  assert.equal(
    await evaluate(() => document.getElementById('parent-prompt').value),
    '/quit',
  );
  assert.deepEqual(desktop.at(-1), ['quit', {}]);
  report.cases.push(
    'hotkeys are readable, copy uses the real parent source and cancelled quit preserves its draft',
  );

  await submit('/resume');
  await waitFor(() =>
    evaluate(
      () => document.querySelector('#session-history-list button') !== null,
    ),
  );
  await evaluate(() =>
    document.querySelector('#session-history-list button').click(),
  );
  await waitFor(() =>
    evaluate(
      () =>
        document.getElementById('prompt-recipient').textContent === 'resumed',
    ),
  );
  assert.deepEqual(created[0], {cwd: directory, sessionId: 'saved-session'});
  report.cases.push(
    'resume uses the existing saved-session picker and native open action',
  );

  await select('origin');
  closeGate = Promise.withResolvers();
  await submit('/new');
  await waitFor(() => closeGate.id === 'origin');
  await draft('Newer original draft must survive');
  await select('other');
  await draft('Unrelated session draft must survive');
  closeGate.resolve();
  await waitFor(() =>
    evaluate(
      () => document.getElementById('prompt-recipient').textContent === 'fresh',
    ),
  );
  assert.deepEqual(created[1], {cwd: directory});
  await select('other');
  assert.equal(
    await evaluate(() => document.getElementById('parent-prompt').value),
    'Unrelated session draft must survive',
  );
  assert.equal(
    await evaluate(() =>
      JSON.stringify(localStorage).includes(
        'Newer original draft must survive',
      ),
    ),
    true,
  );
  await select('fresh');
  report.cases.push(
    'new retains its original target and preserves edited and switched-session drafts',
  );

  await draft('Selected draft before unselected navigation');
  hub.sessions.find(item => item.session.id === 'other').ui.navigation = {
    id: 'navigation',
    cwd: directory,
    sessionId: 'prepared-fork',
    draft: 'Prepared fork user message',
  };
  publish();
  await waitFor(() =>
    evaluate(
      () =>
        document.getElementById('prompt-recipient').textContent === 'navigated',
    ),
  );
  assert.equal(
    await evaluate(() => document.getElementById('parent-prompt').value),
    'Prepared fork user message',
  );
  assert.deepEqual(navigationOrder, ['ack', 'create']);
  await select('fresh');
  assert.equal(
    await evaluate(() => document.getElementById('parent-prompt').value),
    'Selected draft before unselected navigation',
  );
  assert.equal(prompts.length, 6, 'desktop commands never reach promptSession');
  assert.deepEqual(errors, []);
  report.cases.push(
    'unselected prepared navigation acknowledges before replacement and safely seeds only its destination draft',
  );
}
main()
  .then(() => {
    writeFileSync(reportPath, JSON.stringify(report));
    browser?.destroy();
    app.exit(0);
  })
  .catch(error => {
    report.error = error.stack || String(error);
    writeFileSync(reportPath, JSON.stringify(report));
    browser?.destroy();
    app.exit(1);
  });
