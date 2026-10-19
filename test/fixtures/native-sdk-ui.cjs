/* global process, __dirname, document, window, Event, requestAnimationFrame, innerWidth, innerHeight */
const assert = require('node:assert/strict');
const {mkdirSync, writeFileSync} = require('node:fs');
const {writeFile} = require('node:fs/promises');
const {join, resolve} = require('node:path');
const {pathToFileURL} = require('node:url');
const {app, BrowserWindow, ipcMain} = require('electron');

const [directory, reportPath] = process.argv.slice(2);
const report = {cases: []};
const responses = [];
const errors = [];
const renderStates = [];
let browser;
let hub;
let ui;
let settingsController;
let settingsTask;
let modelController;
let modelTask;
let forkController;
let forkTask;
let runtime;
let currentModel;
let settings;
let authKind;
let runSettingsCommand;
let UserMessageSelectorComponent;

app.setPath('userData', join(directory, 'profile'));
app.setPath('sessionData', join(directory, 'session'));
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const evaluate = (fn, arg) =>
  browser.webContents.executeJavaScript(
    `(${fn.toString()})(${JSON.stringify(arg)})`,
  );
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, message) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await check()) return;
    await delay(15);
  }
  throw new Error(message);
}
function handle(channel, action) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return {ok: true, value: await action(...args)};
    } catch (error) {
      return {ok: false, error: error.message || String(error)};
    }
  });
}
function parent() {
  const at = new Date().toISOString();
  return {
    session: {
      id: 'actual-sdk',
      name: 'Actual SDK widgets',
      cwd: directory,
      model: 'native-fixture/model-01',
      thinkingLevel: 'medium',
      status: 'idle',
      activity: 'Ready',
      startedAt: at,
      updatedAt: at,
      owned: true,
      controllable: true,
    },
    agents: [
      {
        id: 'sdk-worker',
        name: 'SDK model worker',
        cwd: directory,
        task: 'Render the stock model selector',
        model: 'native-fixture/model-01',
        thinkingLevel: 'medium',
        status: 'running',
        activity: 'Ready',
        resumable: true,
        createdAt: at,
        startedAt: at,
        conversation: [],
        queue: {steering: [], followUp: []},
      },
    ],
    totalAgents: 1,
    events: [],
    changes: [],
    conversation: [],
    conversationTruncated: false,
    queue: {steering: [], followUp: []},
    ui: {dialogs: [], notifications: [], statuses: []},
  };
}
function publish() {
  if (!ui || !hub) return;
  hub.sessions[0].ui = ui.snapshot();
  if (browser && !browser.isDestroyed())
    browser.webContents.send('pidev:snapshot', hub);
}
function features(profile = {id: 'default', name: 'Default', mode: 'all'}) {
  return {
    commands: [],
    tools: [],
    models: runtime.getAvailableSnapshot().map(model => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
    })),
    model: {provider: currentModel.provider, id: currentModel.id},
    thinkingLevel: 'medium',
    thinkingLevels: ['off', 'low', 'medium', 'high'],
    diagnostics: [],
    agentProfile: profile,
  };
}
function sessionState() {
  return {
    model: currentModel,
    thinkingLevel: 'medium',
    agent: {transport: 'auto'},
    settingsManager: settings,
    sessionManager: {getCwd: () => directory},
    modelRuntime: runtime,
    scopedModels: [],
    getAvailableThinkingLevels: () => ['off', 'low', 'medium', 'high'],
    get autoCompactionEnabled() {
      return settings.getCompactionEnabled();
    },
    get steeringMode() {
      return settings.getSteeringMode();
    },
    get followUpMode() {
      return settings.getFollowUpMode();
    },
    setAutoCompactionEnabled: value => settings.setCompactionEnabled(value),
    setSteeringMode: value => settings.setSteeringMode(value),
    setFollowUpMode: value => settings.setFollowUpMode(value),
    setThinkingLevel(value) {
      this.thinkingLevel = value;
    },
    setCacheWarmingMode: value => settings.setCacheWarmingMode(value),
  };
}
function modelOptions() {
  return {
    activeTab: 'model',
    model: {
      currentModel,
      modelRuntime: runtime,
      scopedModels: [],
      defaultModel: {provider: currentModel.provider, id: currentModel.id},
    },
    thinking: {
      currentLevel: 'medium',
      availableLevels: ['off', 'low', 'medium', 'high'],
      defaultLevel: 'medium',
    },
  };
}
function startSettings() {
  if (settingsTask) return;
  settingsController = new AbortController();
  const state = sessionState();
  settingsTask = runSettingsCommand('settings', '', {
    session: state,
    ui,
    signal: settingsController.signal,
    configure: async options => {
      if (options.provider && options.modelId)
        currentModel = runtime.getModel(options.provider, options.modelId);
      if (options.thinkingLevel) state.setThinkingLevel(options.thinkingLevel);
    },
  }).finally(() => {
    settingsTask = undefined;
  });
}
function startModel() {
  if (modelTask) return;
  modelController = new AbortController();
  modelTask = ui
    .forCommand(modelController.signal)
    .selectSessionSettings(modelOptions())
    .finally(() => {
      modelTask = undefined;
    });
}
function startFork() {
  if (forkTask) return;
  forkController = new AbortController();
  const messages = Array.from({length: 64}, (_, index) => ({
    id: `entry-${index}`,
    text:
      `User request ${index + 1}: ` +
      `inspect package ${String(index + 1).padStart(2, '0')} and preserve its detailed constraints. `.repeat(
        2,
      ),
  }));
  forkTask = ui
    .forCommand(forkController.signal)
    .native(
      'Fork session',
      (_screen, _theme, _keys, done) => {
        const selector = new UserMessageSelectorComponent(
          messages,
          done,
          () => done(undefined),
          messages.at(-1).id,
        );
        return {component: selector, focus: selector.getMessageList()};
      },
      {signal: forkController.signal},
    )
    .finally(() => {
      forkTask = undefined;
    });
}
async function submit(prompt) {
  await evaluate(prompt => {
    const editor = document.getElementById('parent-prompt');
    editor.value = prompt;
    editor.dispatchEvent(new Event('input', {bubbles: true}));
    document.getElementById('prompt-form').requestSubmit();
  }, prompt);
}
async function press(keyCode, modifiers = []) {
  browser.webContents.sendInputEvent({type: 'keyDown', keyCode, modifiers});
  browser.webContents.sendInputEvent({type: 'keyUp', keyCode, modifiers});
  await delay(20);
}
async function typeTerminal(value) {
  for (const character of value) {
    if (character === '\r') await press('Return');
    else if (character === '\u0015') await press('U', ['control']);
    else if (character === '\u001b') await press('Escape');
    else {
      browser.webContents.sendInputEvent({type: 'char', keyCode: character});
      await delay(4);
    }
  }
}
async function settle() {
  await evaluate(
    () =>
      new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}
async function terminalState() {
  return {
    ...(await evaluate(() => {
      const terminal = window.actualSDKTerminal;
      const panel = document.getElementById('extension-dialog-terminal');
      const buffer = terminal?.buffer.active;
      const visible = terminal
        ? Array.from(
            {length: terminal.rows},
            (_, index) =>
              buffer
                .getLine(buffer.viewportY + index)
                ?.translateToString(true) || '',
          )
        : [];
      return {
        title: document.getElementById('extension-dialog-title').textContent,
        open: document.getElementById('extension-dialog').open,
        visible,
        columns: terminal?.cols,
        rows: terminal?.rows,
        viewportY: buffer?.viewportY,
        baseY: buffer?.baseY,
        panelWidth: panel.clientWidth,
        panelHeight: panel.clientHeight,
        proposedColumns: Number(panel.dataset.proposedColumns),
        proposedRows: Number(panel.dataset.proposedRows),
        fittedColumns: Number(panel.dataset.terminalColumns),
        fittedRows: Number(panel.dataset.terminalRows),
        cellHeight:
          terminal?._core?._renderService?.dimensions?.css?.cell?.height,
        innerWidth,
        innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      };
    })),
    zoom: browser.webContents.getZoomFactor(),
  };
}
async function screenshot(name) {
  const output = process.env.DESKTOP_UI_SCREENSHOT_DIR;
  if (!output) return;
  mkdirSync(output, {recursive: true});
  renderStates.push({name, ...(await terminalState())});
  writeFileSync(
    join(output, `${name}.png`),
    (await browser.capturePage()).toPNG(),
  );
  writeFileSync(
    join(output, 'native-widget-states.json'),
    JSON.stringify(
      {
        availableModels: runtime.getAvailableSnapshot().length,
        catalogModels: runtime.getModels('native-fixture').length,
        authKind,
        states: renderStates,
      },
      null,
      2,
    ),
  );
}
async function waitForTerminal(marker) {
  let state;
  let previous = '';
  let stable = 0;
  for (let attempt = 0; attempt < 300; attempt++) {
    state = await terminalState();
    const text = state.visible.join('\n');
    const frame = ui.snapshot().dialogs[0]?.terminal;
    const matched =
      marker instanceof RegExp ? marker.test(text) : text.includes(marker);
    const current =
      matched && state.columns === frame?.columns && state.rows === frame?.rows;
    stable = current && text === previous ? stable + 1 : 0;
    if (stable >= 3) {
      await settle();
      return;
    }
    previous = text;
    await delay(15);
  }
  throw new Error(
    `xterm did not paint ${String(marker)}: ${JSON.stringify(state)}`,
  );
}
async function proveCompactPageUp(
  name,
  initialMarker,
  targetMarker,
  furtherMarker,
) {
  const resizeCount = responses.filter(response =>
    Number.isInteger(response.value?.columns),
  ).length;
  browser.setContentSize(900, 760);
  browser.webContents.setZoomFactor(2);
  await waitFor(
    () =>
      responses.filter(response => Number.isInteger(response.value?.columns))
        .length > resizeCount,
    `${name} did not report its compact viewport`,
  );
  await waitForTerminal(initialMarker);
  const before = (await terminalState()).visible.join('\n');
  await press('PageUp');
  await waitForTerminal(targetMarker);
  const after = (await terminalState()).visible.join('\n');
  assert.notEqual(after, before, `${name} PageUp did not move native content`);
  await screenshot(`${name}-pageup-900-2`);
  if (furtherMarker) {
    await press('PageUp');
    await waitForTerminal(furtherMarker);
    await screenshot(`${name}-pageup-search-900-2`);
  }
  browser.setContentSize(1600, 1000);
  browser.webContents.setZoomFactor(1);
  await settle();
}
async function assertCompact(name, marker) {
  for (const [width, height, zoom] of [
    [900, 760, 1.5],
    [900, 760, 2],
  ]) {
    const resizeCount = responses.filter(response =>
      Number.isInteger(response.value?.columns),
    ).length;
    browser.setContentSize(width, height);
    browser.webContents.setZoomFactor(zoom);
    await waitFor(
      () =>
        responses.filter(response => Number.isInteger(response.value?.columns))
          .length > resizeCount,
      `${name} did not report its compact viewport`,
    );
    const frame = ui.snapshot().dialogs[0].terminal;
    await waitFor(
      () =>
        evaluate(
          frame =>
            window.actualSDKTerminal?.cols === frame.columns &&
            window.actualSDKTerminal?.rows === frame.rows,
          frame,
        ),
      `${name} did not apply its compact viewport`,
    );
    await waitForTerminal(marker);
    assert.deepEqual(
      await evaluate(() => {
        const dialog = document
          .getElementById('extension-dialog')
          .getBoundingClientRect();
        const terminal = document
          .getElementById('extension-dialog-terminal')
          .getBoundingClientRect();
        const cancel = document
          .getElementById('cancel-extension-dialog')
          .getBoundingClientRect();
        const actionButtons = [
          ...document.querySelectorAll('#extension-dialog-actions button'),
        ].filter(button => !button.hidden);
        return {
          dialogFits:
            dialog.left >= 0 &&
            dialog.right <= innerWidth &&
            dialog.top >= 0 &&
            dialog.bottom <= innerHeight,
          terminalVisible: terminal.width > 120 && terminal.height > 60,
          cancelVisible:
            cancel.top >= dialog.top && cancel.bottom <= dialog.bottom,
          controlsSeparate: actionButtons.every(button => {
            const action = button.getBoundingClientRect();
            return !(
              action.left < cancel.right &&
              action.right > cancel.left &&
              action.top < cancel.bottom &&
              action.bottom > cancel.top
            );
          }),
        };
      }),
      {
        dialogFits: true,
        terminalVisible: true,
        cancelVisible: true,
        controlsSeparate: true,
      },
    );
    await screenshot(`${name}-900-${zoom}`);
  }
  browser.setContentSize(1600, 1000);
  browser.webContents.setZoomFactor(1);
  await settle();
}
async function main() {
  await app.whenReady();
  const [{DesktopExtensionUI}, settingsCommands, sdk] = await Promise.all([
    import(pathToFileURL(resolve('src/dashboard/extension-ui.ts')).href),
    import(pathToFileURL(resolve('src/dashboard/settings-commands.ts')).href),
    import('@earendil-works/pi-coding-agent'),
  ]);
  runSettingsCommand = settingsCommands.runSettingsCommand;
  UserMessageSelectorComponent = sdk.UserMessageSelectorComponent;
  settings = sdk.SettingsManager.inMemory();
  settings.setTheme('dark');
  const modelsPath = join(directory, 'models.json');
  await writeFile(
    modelsPath,
    JSON.stringify({
      providers: {
        'native-fixture': {
          api: 'openai-completions',
          baseUrl: 'http://127.0.0.1:1/v1',
          apiKey: 'local-fixture',
          models: Array.from({length: 36}, (_, index) => ({
            id: `model-${String(index + 1).padStart(2, '0')}`,
            name: `Native fixture model ${String(index + 1).padStart(2, '0')}`,
            reasoning: index % 2 === 0,
            input: ['text'],
            cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
            contextWindow: 8192,
            maxTokens: 1024,
          })),
        },
      },
    }),
  );
  runtime = await sdk.ModelRuntime.create({
    authPath: join(directory, 'auth.json'),
    modelsPath,
    allowModelNetwork: false,
  });
  assert.equal(runtime.getModels('native-fixture').length, 36);
  assert.equal((await runtime.getAvailable('native-fixture')).length, 36);
  assert.equal(runtime.getAvailableSnapshot().length, 36);
  const auth = await runtime.checkAuth('native-fixture');
  assert.notEqual(auth, undefined);
  authKind = typeof auth;
  currentModel = runtime.getModel('native-fixture', 'model-01');
  assert.ok(currentModel);
  for (let index = 1; index <= 24; index++)
    settings.setModelThinkingLevel(
      'native-fixture',
      `model-${String(index).padStart(2, '0')}`,
      index % 2 === 0 ? 'high' : 'medium',
    );
  hub = {
    sessions: [parent()],
    selectedSessionId: 'actual-sdk',
    launchCwd: directory,
  };
  ui = new DesktopExtensionUI(publish);
  assert.equal(ui.context.setTheme('dark').success, true);

  browser = new BrowserWindow({
    show: false,
    width: 1600,
    height: 1000,
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
  handle('varisdev:get-accounts', () => ({
    revision: 1,
    providers: [],
    links: [],
    message: '',
  }));
  handle('pidev:session-features', () => features());
  handle('pidev:agent-session', (_id, request) => {
    if (request.action === 'features')
      return features({
        id: 'worker-profile',
        name: 'Worker profile',
        mode: 'subagent',
      });
    if (request.action === 'command' && request.command === '/model') {
      startModel();
      return;
    }
    throw new Error(`Unsupported worker action: ${request.action}`);
  });
  handle('pidev:prompt-session', (_id, input) => {
    if (input.prompt === '/settings') startSettings();
    else if (input.prompt === '/fork') startFork();
    else throw new Error(`Unexpected prompt: ${input.prompt}`);
  });
  handle('pidev:respond-to-dialog', (_id, dialogId, value) => {
    responses.push({dialogId, value});
    ui.respond(dialogId, value);
  });
  handle('pidev:desktop-command', () => ({cancelled: true}));
  handle('pidev:list-sessions', () => []);
  handle('pidev:list-agent-templates', () => ({
    templates: [],
    allTemplates: [],
    sources: [],
    diagnostics: [],
    defaultAgentId: 'builtin:default',
  }));
  await browser.loadFile(
    resolve(__dirname, '../../assets/dashboard/index.html'),
  );
  await waitFor(
    () =>
      evaluate(
        () =>
          document.getElementById('prompt-recipient').textContent ===
          'Actual SDK widgets',
      ),
    'Dashboard did not select the SDK fixture session',
  );
  await evaluate(() => {
    const Terminal = window.Terminal;
    window.Terminal = class extends Terminal {
      constructor(options) {
        super(options);
        window.actualSDKTerminal = this;
      }
    };
  });

  await submit('/settings');
  await waitFor(
    () =>
      ui.snapshot().dialogs[0]?.terminal?.output.includes('Auto-compact') ===
      true,
    'Stock Settings selector did not render',
  );
  await waitFor(
    () =>
      evaluate(
        () =>
          document.getElementById('extension-dialog').open &&
          document.getElementById('extension-dialog-title').textContent ===
            'Settings',
      ),
    'Stock Settings selector did not reach the renderer',
  );
  await waitForTerminal('Auto-compact');
  assert.equal(ui.snapshot().dialogs[0].terminal.appearance, 'dark');
  await screenshot('actual-settings-dark');
  await assertCompact('actual-settings-dark', 'Type to search');
  await proveCompactPageUp(
    'actual-settings-dark',
    'Type to search',
    'Auto-compact',
  );
  const mermaidMode = settings.getMermaidRenderingMode();
  await typeTerminal('mermaid');
  await waitForTerminal('mermaid');
  await press('Return');
  await waitFor(
    () => settings.getMermaidRenderingMode() !== mermaidMode,
    'Stock Settings search did not round-trip through xterm',
  );
  await typeTerminal('\u0015per model\r');
  await waitFor(
    () =>
      ui
        .snapshot()
        .dialogs[0]?.terminal?.output.includes('Per-Model Thinking Level') ===
      true,
    'Stock Settings submenu did not render',
  );
  browser.setContentSize(900, 760);
  browser.webContents.setZoomFactor(2);
  await waitForTerminal(/model-\d{2}.*\[native-fixture\].*(?:medium|high)/);
  await screenshot('actual-settings-submenu-900-2');
  const settingsResize = responses
    .filter(
      response =>
        Number.isInteger(response.value?.columns) &&
        Number.isInteger(response.value?.rows),
    )
    .at(-1);
  assert.ok(
    settingsResize,
    'Renderer did not resize the real Settings terminal',
  );
  assert.deepEqual(
    {
      columns: ui.snapshot().dialogs[0].terminal.columns,
      rows: ui.snapshot().dialogs[0].terminal.rows,
    },
    settingsResize.value,
  );
  settingsController.abort();
  await settingsTask;
  await waitFor(
    () => ui.snapshot().dialogs.length === 0,
    'Settings selector did not cancel',
  );
  report.cases.push(
    'actual stock Settings selector renders, searches, resizes and opens its submenu',
  );

  browser.setContentSize(1600, 1000);
  browser.webContents.setZoomFactor(1);
  assert.equal(ui.context.setTheme('light').success, true);
  await evaluate(() =>
    [...document.querySelectorAll('#active-workers button')]
      .find(button => button.textContent.includes('SDK model worker'))
      .click(),
  );
  await waitFor(
    () =>
      evaluate(
        () => document.getElementById('prompt-recipient').textContent,
      ).then(value => value === 'SDK model worker'),
    'Worker conversation was not selected',
  );
  await evaluate(() => {
    document.getElementById('app-menu-button').click();
    document.getElementById('open-session-settings').click();
  });
  await waitFor(
    () =>
      ui
        .snapshot()
        .dialogs[0]?.terminal?.output.includes('Native fixture model') === true,
    'Stock worker Model selector did not render',
  );
  await waitFor(
    () =>
      evaluate(
        () =>
          document.getElementById('extension-dialog').open &&
          document.getElementById('extension-dialog-title').textContent ===
            'Model & thinking',
      ),
    'Stock worker Model selector did not reach the renderer',
  );
  await waitForTerminal(/model-\d{2}.*\[native-fixture\]/);
  assert.equal(ui.snapshot().dialogs[0].terminal.appearance, 'light');
  await screenshot('actual-worker-model-light');
  await assertCompact(
    'actual-worker-model-light',
    /model-\d{2}.*\[native-fixture\]/,
  );
  await proveCompactPageUp(
    'actual-worker-model-light',
    /model-\d{2}.*\[native-fixture\]/,
    /model-01.*\[native-fixture\]/,
    'Only showing models',
  );
  await typeTerminal('model-2');
  await waitFor(
    () =>
      responses.some(
        response =>
          response.dialogId === ui.snapshot().dialogs[0]?.id &&
          typeof response.value?.input === 'string',
      ),
    'Worker Model input did not round-trip',
  );
  modelController.abort();
  await modelTask;
  await waitFor(
    () => ui.snapshot().dialogs.length === 0,
    'Worker Model selector did not cancel',
  );
  report.cases.push(
    'actual stock worker Model selector renders many models with light appearance',
  );

  browser.setContentSize(1600, 1000);
  browser.webContents.setZoomFactor(1);
  assert.equal(ui.context.setTheme('dark').success, true);
  await evaluate(() => document.getElementById('back-to-parent').click());
  await waitFor(
    () =>
      evaluate(
        () => document.getElementById('prompt-recipient').textContent,
      ).then(value => value === 'Actual SDK widgets'),
    'Parent conversation was not restored',
  );
  await submit('/fork');
  await waitFor(
    () =>
      ui.snapshot().dialogs[0]?.terminal?.output.includes('User request 64') ===
      true,
    'Stock long Fork selector did not render',
  );
  await waitForTerminal('User request 64');
  assert.equal(ui.snapshot().dialogs[0].terminal.appearance, 'dark');
  await screenshot('actual-fork-dark');
  await assertCompact('actual-fork-dark', 'User request 64');
  await proveCompactPageUp(
    'actual-fork-dark',
    'User request 64',
    /User request 5\d/,
  );
  await press('Down');
  await waitFor(
    () =>
      responses.filter(
        response =>
          response.dialogId === ui.snapshot().dialogs[0]?.id &&
          typeof response.value?.input === 'string',
      ).length >= 2,
    'Fork viewport keys did not round-trip',
  );
  forkController.abort();
  await forkTask;
  await waitFor(
    () => ui.snapshot().dialogs.length === 0,
    'Fork selector did not cancel',
  );
  report.cases.push(
    'actual stock long Fork selector remains accessible at compact zoom',
  );

  assert.deepEqual(errors, []);
}

main()
  .then(async () => {
    writeFileSync(reportPath, JSON.stringify(report));
    settingsController?.abort();
    modelController?.abort();
    forkController?.abort();
    await Promise.allSettled(
      [settingsTask, modelTask, forkTask].filter(Boolean),
    );
    ui?.dispose();
    runtime?.dispose?.();
    browser?.destroy();
    app.exit(0);
  })
  .catch(async error => {
    report.error = error.stack || String(error);
    writeFileSync(reportPath, JSON.stringify(report));
    settingsController?.abort();
    modelController?.abort();
    forkController?.abort();
    await Promise.allSettled(
      [settingsTask, modelTask, forkTask].filter(Boolean),
    );
    ui?.dispose();
    runtime?.dispose?.();
    browser?.destroy();
    app.exit(1);
  });
