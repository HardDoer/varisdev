/* global process, __dirname, document, window, Event, localStorage, setTimeout, innerHeight, innerWidth, requestAnimationFrame */
const assert = require('node:assert/strict');
const {existsSync, mkdirSync, readFileSync, writeFileSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {pathToFileURL} = require('node:url');
const {app, BrowserWindow, ipcMain} = require('electron');
const [directory, reportPath] = process.argv.slice(2);
const standalonePiDir = process.env.PI_CODING_AGENT_DIR;
const root = resolve(
  process.env.VARISDEV_TEST_PACKAGE_DIR || join(__dirname, '../..'),
);
const report = {cases: []};
let browser;
let accounts;
let hub = {sessions: [], launchCwd: directory};
const opened = [];
const errors = [];
app.setPath('userData', join(directory, 'profile'));
app.setPath('sessionData', join(directory, 'profile'));
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
const evaluate = fn =>
  browser.webContents.executeJavaScript(`(${fn.toString()})()`);
async function waitFor(fn) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await evaluate(fn)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${fn}`);
}
function handle(channel, action) {
  ipcMain.handle(channel, async (event, ...args) => {
    assert.equal(event.sender, browser.webContents);
    assert.equal(event.senderFrame, browser.webContents.mainFrame);
    try {
      return {ok: true, value: await action(...args)};
    } catch (error) {
      return {ok: false, error: error.message};
    }
  });
}
async function select(provider) {
  await browser.webContents.executeJavaScript(
    `document.getElementById('accounts-provider').value = ${JSON.stringify(provider)}; document.getElementById('accounts-provider').dispatchEvent(new Event('change'));`,
  );
}
async function main() {
  const {DesktopAccounts} = await import(
    pathToFileURL(join(root, 'desktop/build/src/desktop/accounts.js')).href
  );
  const {getToolModels, saveToolModel} = await import(
    pathToFileURL(join(root, 'desktop/build/src/tools/model-selection.js')).href
  );
  const {DesktopToolSettings} = await import(
    pathToFileURL(join(root, 'desktop/build/src/desktop/tool-settings.js')).href
  );
  const {ModelRuntime} = await import(
    pathToFileURL(
      join(
        root,
        'desktop/node_modules/@earendil-works/pi-coding-agent/dist/index.js',
      ),
    ).href
  );
  const agentDir = process.env.VARISDEV_SETTINGS_DIR;
  mkdirSync(agentDir, {recursive: true});
  const authPath = join(agentDir, 'auth.json');
  const other = {other: {type: 'api_key', key: 'keep-other-account'}};
  writeFileSync(authPath, JSON.stringify(other));
  const runtime = await ModelRuntime.create({
    authPath,
    modelsPath: null,
    allowModelNetwork: false,
  });
  const provider = runtime.getProvider('openai-codex');
  runtime.registerNativeProvider({
    ...provider,
    auth: {
      oauth: {
        ...provider.auth.oauth,
        async login(interaction, options) {
          assert.equal(options.agentName, 'VarisDev');
          const id = options.getDeviceId();
          assert.match(id, /^[0-9a-f-]{36}$/i);
          assert.equal(options.getDeviceId(), id);
          interaction.notify({
            type: 'device_code',
            userCode: 'ABCD-EFGH',
            verificationUri: 'https://provider.invalid/device',
          });
          const code = await interaction.prompt({
            type: 'manual_code',
            message: 'Authorization code',
          });
          if (code !== 'valid-private-code')
            throw new Error(`Rejected code ${code}`);
          return {
            type: 'oauth',
            access: 'private-access',
            refresh: 'private-refresh',
            expires: Date.now() + 3600000,
          };
        },
        async toAuth(credential) {
          return {apiKey: credential.access};
        },
      },
    },
  });
  accounts = new DesktopAccounts({
    createRuntime: async () => runtime,
    openBrowser: async url => {
      opened.push(url);
    },
    changed: state => browser?.webContents.send('varisdev:accounts', state),
  });
  await app.whenReady();
  browser = new BrowserWindow({
    show: false,
    width: 1100,
    height: 760,
    webPreferences: {
      preload: join(root, 'assets/desktop/preload.cjs'),
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
  handle('varisdev:app-themes', () => ({themes: [], errors: []}));
  handle('varisdev:get-update-status', () => ({phase: 'idle'}));
  const toolSettings = new DesktopToolSettings({
    createRuntime: async () => runtime,
    sessionFeatures: async () => ({models: []}),
  });
  handle('varisdev:get-tool-settings', id => toolSettings.getToolSettings(id));
  handle('varisdev:save-tool-settings', (section, value, id) =>
    toolSettings.saveToolSettings(section, value, id),
  );
  handle('varisdev:get-tool-models', getToolModels);
  handle('varisdev:save-tool-model', saveToolModel);
  handle('varisdev:get-accounts', () => accounts.get());
  handle('varisdev:account-start', (provider, method) =>
    accounts.start(provider, method),
  );
  handle('varisdev:account-respond', (attempt, prompt, value) =>
    accounts.respond(attempt, prompt, value),
  );
  handle('varisdev:account-cancel', attempt => accounts.cancel(attempt));
  handle('varisdev:account-link', (attempt, index) =>
    accounts.openLink(attempt, index),
  );
  handle('pidev:session-features', () => ({
    commands: [],
    models: [],
    thinkingLevel: 'off',
    thinkingLevels: ['off'],
    tools: [],
    diagnostics: [],
  }));
  await browser.loadFile(join(root, 'assets/dashboard/index.html'));
  await waitFor(() => !document.getElementById('welcome').hidden);
  await evaluate(() => document.getElementById('welcome-accounts').click());
  await waitFor(
    () =>
      document.getElementById('accounts-provider').options.length > 0 &&
      !document.getElementById('accounts-provider').disabled,
  );
  browser.webContents.send('varisdev:accounts', {
    ...accounts.snapshot(),
    diagnostics: ['Fixture extension could not be loaded.'],
  });
  await waitFor(() =>
    document
      .getElementById('accounts-error')
      .textContent.includes('Fixture extension could not be loaded.'),
  );
  assert.equal(
    await evaluate(() => document.getElementById('accounts-provider').disabled),
    false,
  );
  await accounts.get();
  await select('openai');
  await evaluate(() => document.getElementById('accounts-key').click());
  await waitFor(() => !document.getElementById('accounts-form').hidden);
  assert.equal(
    await evaluate(() => document.getElementById('accounts-input').type),
    'password',
  );
  await evaluate(() => {
    document.getElementById('accounts-input').value = 'gui-private-key';
    document.getElementById('accounts-form').requestSubmit();
  });
  await waitFor(
    () =>
      document.getElementById('accounts-status').textContent ===
        'API key saved' && document.getElementById('accounts-cancel').hidden,
  );
  assert.equal(
    JSON.parse(readFileSync(authPath, 'utf8')).openai.key,
    'gui-private-key',
  );
  assert.equal(
    await evaluate(() => document.getElementById('accounts-input').value),
    '',
  );
  assert.equal(
    await evaluate(() =>
      JSON.stringify(localStorage).includes('gui-private-key'),
    ),
    false,
  );
  assert.equal(
    await evaluate(() => document.body.textContent.includes('gui-private-key')),
    false,
  );
  report.cases.push(
    'welcome screen saves API key using real credential storage without terminal commands',
  );

  await evaluate(() => document.getElementById('accounts-close').click());
  await new Promise(resolve => {
    browser.webContents.once('did-finish-load', resolve);
    browser.reload();
  });
  await waitFor(() => !document.getElementById('welcome').hidden);
  await evaluate(() => {
    document.getElementById('app-menu-button').click();
    document.getElementById('open-accounts').click();
  });
  await waitFor(
    () =>
      document.getElementById('accounts-provider').options.length > 0 &&
      !document.getElementById('accounts-provider').disabled,
  );
  await select('openai');
  assert.equal(
    await evaluate(
      () => document.getElementById('accounts-status').textContent,
    ),
    'API key saved',
  );
  assert.equal(
    await evaluate(() =>
      document.getElementById('app-menu-panel').matches(':popover-open'),
    ),
    false,
  );
  await evaluate(() => document.getElementById('accounts-logout').click());
  await waitFor(
    () => !document.getElementById('accounts-logout-confirm').hidden,
  );
  assert.notDeepEqual(JSON.parse(readFileSync(authPath, 'utf8')), other);
  await evaluate(() =>
    document.getElementById('accounts-logout-confirm').click(),
  );
  await waitFor(
    () =>
      document.getElementById('accounts-cancel').hidden &&
      document.getElementById('accounts-logout').hidden,
  );
  assert.deepEqual(JSON.parse(readFileSync(authPath, 'utf8')), other);
  report.cases.push(
    'app menu restores account status after reload and signs out without deleting other accounts',
  );

  await select('openai-codex');
  await evaluate(() => document.getElementById('accounts-oauth').click());
  await waitFor(() => !document.getElementById('accounts-form').hidden);
  assert.equal(
    await evaluate(() => document.getElementById('accounts-device-code').value),
    'ABCD-EFGH',
  );
  assert.deepEqual(opened, []);
  await evaluate(() =>
    document.getElementById('accounts-links').firstElementChild.click(),
  );
  await waitFor(() => !document.getElementById('accounts-submit').disabled);
  assert.deepEqual(opened, ['https://provider.invalid/device']);
  await evaluate(() => {
    document.getElementById('accounts-input').value = 'invalid-private-code';
    document.getElementById('accounts-form').requestSubmit();
  });
  await waitFor(
    () =>
      !document.getElementById('accounts-error').hidden &&
      document.getElementById('accounts-cancel').hidden,
  );
  assert.match(
    await evaluate(() => document.getElementById('accounts-error').textContent),
    /Rejected code \[redacted\]/,
  );
  await evaluate(() => document.getElementById('accounts-oauth').click());
  await waitFor(() => !document.getElementById('accounts-form').hidden);
  await evaluate(() => {
    document.getElementById('accounts-input').value = 'valid-private-code';
    document.getElementById('accounts-form').requestSubmit();
  });
  await waitFor(
    () =>
      document.getElementById('accounts-status').textContent === 'Signed in' &&
      document.getElementById('accounts-cancel').hidden,
  );
  assert.equal(
    JSON.parse(readFileSync(authPath, 'utf8'))['openai-codex'].access,
    'private-access',
  );
  const installationId = JSON.parse(
    readFileSync(join(agentDir, 'settings.json'), 'utf8'),
  ).deviceId;
  assert.match(installationId, /^[0-9a-f-]{36}$/i);
  assert.equal(existsSync(join(standalonePiDir, 'settings.json')), false);
  assert.equal(existsSync(join(standalonePiDir, 'auth.json')), false);
  report.cases.push(
    'browser sign-in shows device code, provider errors and retry without exposing credentials',
  );

  await evaluate(() => document.getElementById('accounts-oauth').click());
  await waitFor(() => !document.getElementById('accounts-form').hidden);
  await evaluate(() => document.getElementById('accounts-cancel').click());
  await waitFor(() => document.getElementById('accounts-cancel').hidden);
  assert.equal(accounts.snapshot().message, 'Cancelled.');
  await evaluate(() => document.getElementById('accounts-oauth').click());
  await waitFor(() => !document.getElementById('accounts-form').hidden);
  await evaluate(() =>
    document
      .getElementById('accounts-dialog')
      .dispatchEvent(new Event('cancel', {cancelable: true})),
  );
  await waitFor(
    () =>
      !document.getElementById('accounts-dialog').open &&
      document.getElementById('accounts-cancel').hidden,
  );
  assert.equal(accounts.snapshot().prompt, undefined);
  assert.equal(
    JSON.parse(readFileSync(authPath, 'utf8'))['openai-codex'].access,
    'private-access',
  );
  report.cases.push(
    'Cancel and dialog Escape cancel pending authentication while preserving saved credentials',
  );

  hub = {
    launchCwd: directory,
    selectedSessionId: 'parent',
    sessions: [
      {
        session: {
          id: 'parent',
          name: 'Project',
          cwd: directory,
          status: 'idle',
          activity: 'Ready',
          owned: true,
          controllable: true,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        agents: [],
        totalAgents: 0,
        events: [],
        changes: [],
        conversation: [],
        queue: {steering: [], followUp: []},
      },
    ],
  };
  browser.webContents.send('pidev:snapshot', hub);
  await waitFor(() => !document.getElementById('factory-workspace').hidden);
  await evaluate(() => {
    document.getElementById('app-menu-button').click();
    document.getElementById('open-accounts').click();
  });
  await waitFor(
    () =>
      document.getElementById('accounts-dialog').open &&
      !document.getElementById('accounts-provider').disabled,
  );
  assert.equal(
    await evaluate(
      () =>
        document.getElementById('accounts-dialog').getBoundingClientRect()
          .bottom <= innerHeight,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  report.cases.push(
    'account controls remain reachable from the app menu in an open parent session',
  );
  assert.equal(
    await evaluate(() =>
      document.querySelector('#accounts-dialog #tool-models'),
    ),
    null,
  );
  await evaluate(() => {
    document.getElementById('accounts-close').click();
    document.getElementById('app-menu-button').click();
    document.getElementById('open-model-settings').click();
  });
  await waitFor(
    () => document.getElementById('image-model').options.length === 7,
  );
  assert.equal(
    await evaluate(() => document.getElementById('image-model').tagName),
    'SELECT',
  );
  assert.equal(
    await evaluate(
      () => document.getElementById('image-model').options[0].textContent,
    ),
    'Ask on first use',
  );
  assert.deepEqual(
    await evaluate(() =>
      [...document.getElementById('image-model').options]
        .slice(1)
        .map(option => option.value),
    ),
    [
      'gpt-image-2.5-sunburst',
      'gpt-image-2.5-flare',
      'gpt-image-2',
      'gpt-image-1.5',
      'gpt-image-1',
      'gpt-image-1-mini',
    ],
  );
  await evaluate(() => {
    const field = document.getElementById('image-model');
    field.value = 'gpt-image-2.5-flare';
    field.dispatchEvent(new Event('change', {bubbles: true}));
    document.getElementById('tool-settings-form').requestSubmit();
  });
  await waitFor(() => !document.getElementById('tool-settings-dialog').open);
  assert.equal(
    (await getToolModels()).find(item => item.id === 'openai-image').model,
    'gpt-image-2.5-flare',
  );
  await evaluate(() => {
    document.getElementById('app-menu-button').click();
    document.getElementById('open-model-settings').click();
  });
  await waitFor(
    () =>
      !document.getElementById('tool-settings-content').hidden &&
      !document.getElementById('tool-settings-close').disabled &&
      document.getElementById('image-model').value === 'gpt-image-2.5-flare',
  );
  for (const [width, height, zoom] of [
    [1100, 760, 1],
    [680, 540, 1.25],
  ]) {
    browser.setSize(width, height);
    await browser.webContents.executeJavaScript(
      `window.pidev.setZoom(${zoom})`,
    );
    await new Promise(resolve => setTimeout(resolve, 100));
    const imageControl = await evaluate(() => {
      document.getElementById('image-model').scrollIntoView({block: 'center'});
      const rect = document
        .getElementById('image-model')
        .getBoundingClientRect();
      return {left: rect.left, right: rect.right, width: innerWidth};
    });
    assert.ok(
      imageControl.left >= 0 && imageControl.right <= imageControl.width,
    );
    await evaluate(
      () =>
        new Promise(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const screenshot = await browser.webContents.capturePage();
    writeFileSync(
      join(directory, `tool-models-${width}.png`),
      screenshot.toPNG(),
    );
  }
  await evaluate(() => {
    document.getElementById('tool-settings-close').click();
    window.pidev.setZoom(1);
    document.getElementById('app-menu-button').click();
    document.getElementById('open-accounts').click();
  });
  browser.setSize(1100, 760);
  await waitFor(() => document.getElementById('accounts-dialog').open);
  report.cases.push(
    'OpenAI preset choices live in Tool models, persist, and remain reachable in compact layouts',
  );
  runtime.registerNativeProvider({
    ...runtime.getProvider('openai'),
    id: 'llama.cpp',
    name: 'llama.cpp',
    getModels: () => [],
    refreshModels: undefined,
    auth: {
      apiKey: {
        name: 'llama.cpp server',
        async login(interaction) {
          const url = await interaction.prompt({
            type: 'text',
            message: 'llama.cpp server URL',
            placeholder: 'http://127.0.0.1:8080',
          });
          const key = await interaction.prompt({
            type: 'secret',
            message: 'API key (optional)',
          });
          return {
            type: 'api_key',
            key: key || undefined,
            env: {LLAMA_BASE_URL: url || 'http://127.0.0.1:8080'},
          };
        },
        async check({credential}) {
          return credential ? {type: 'api_key'} : undefined;
        },
        async resolve({credential}) {
          return credential
            ? {auth: {apiKey: credential.key || 'local'}}
            : undefined;
        },
      },
    },
  });
  await accounts.get();
  await waitFor(() =>
    [...document.getElementById('accounts-provider').options].some(
      item => item.value === 'llama.cpp',
    ),
  );
  await select('llama.cpp');
  assert.equal(
    await evaluate(() => document.getElementById('accounts-key').textContent),
    'Connect server',
  );
  await evaluate(() => document.getElementById('accounts-key').click());
  await waitFor(
    () =>
      document.getElementById('accounts-prompt-label').textContent ===
      'llama.cpp server URL',
  );
  assert.equal(
    await evaluate(() => document.getElementById('accounts-input').required),
    false,
  );
  await evaluate(() =>
    document.getElementById('accounts-form').requestSubmit(),
  );
  await waitFor(
    () =>
      document.getElementById('accounts-prompt-label').textContent ===
      'API key (optional)',
  );
  assert.equal(
    await evaluate(() => document.getElementById('accounts-input').required),
    false,
  );
  await evaluate(() =>
    document.getElementById('accounts-form').requestSubmit(),
  );
  await waitFor(
    () =>
      document.getElementById('accounts-message').textContent ===
      'Connected to llama.cpp.',
  );
  assert.deepEqual(JSON.parse(readFileSync(authPath, 'utf8'))['llama.cpp'], {
    type: 'api_key',
    env: {LLAMA_BASE_URL: 'http://127.0.0.1:8080'},
  });
  report.cases.push(
    'llama.cpp server setup accepts the default URL and an empty optional key',
  );
}
main()
  .catch(error => {
    report.error = error.stack || String(error);
  })
  .finally(async () => {
    await accounts?.dispose();
    writeFileSync(reportPath, JSON.stringify(report));
    browser?.destroy();
    app.exit(report.error ? 1 : 0);
  });
