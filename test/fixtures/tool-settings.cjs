/* global process, __dirname, document, window, Event, setTimeout, getComputedStyle, requestAnimationFrame */
const assert = require('node:assert/strict');
const {existsSync, mkdirSync, writeFileSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {pathToFileURL} = require('node:url');
const {app, BrowserWindow, ipcMain} = require('electron');
const [directory, reportPath] = process.argv.slice(2);
const screenshotDirectory = process.env.VARISDEV_TOOL_MODELS_SCREENSHOTS;
const report = {cases: [], rendererErrors: []};
process.env.VARISDEV_CODING_AGENT_DIR = join(directory, 'agent');
process.env.PI_CODING_AGENT_DIR = join(directory, 'agent');
process.env.OPENAI_IMAGE_MODEL = 'gpt-image-1-mini';
const imageModelPath = join(
  directory,
  'agent',
  'varisdev',
  'tool-models',
  'openai-image.json',
);
let browser;
const reads = [];
const writes = [];
const imageWrites = [];
let settings = {
  agents: {allowedModels: []},
};
const models = [
  {provider: 'alpha', id: 'small', name: 'Swift model'},
  {provider: 'beta', id: 'large', name: 'Deep model'},
];
let acknowledged = false;
let acknowledgments = 0;
let noticeReads = 0;
let releaseNotice;
let noticeError = '';
let saveError = '';
let loadError = '';
let scopedModels;
let ackError = '';
const prompts = [];
const initialNotice = new Promise(resolve => {
  releaseNotice = resolve;
});
const at = new Date().toISOString();
function parent(id) {
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
  };
}
function agent() {
  return {
    id: 'worker',
    name: 'Review agent',
    agentMode: 'subagent',
    task: 'Review project',
    cwd: directory,
    model: 'alpha/small',
    status: 'running',
    activity: 'Reviewing',
    createdAt: at,
    startedAt: at,
    output: '',
    conversation: [],
    conversationTruncated: false,
  };
}
const hub = {
  sessions: [parent('project'), parent('other')],
  selectedSessionId: 'project',
  launchCwd: directory,
};
app.setPath('userData', join(directory, 'profile'));
app.setPath('sessionData', join(directory, 'session'));
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
function handle(channel, action) {
  ipcMain.handle(channel, async (event, ...args) => {
    assert.equal(event.sender, browser.webContents);
    try {
      return {ok: true, value: await action(...args)};
    } catch (error) {
      return {ok: false, error: error.message};
    }
  });
}
const evaluate = (fn, arg) =>
  browser.webContents.executeJavaScript(
    `(${fn.toString()})(${JSON.stringify(arg)})`,
  );
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await evaluate(fn)) return;
    await delay(20);
  }
  const state = await evaluate(() => ({
    ready: document.readyState,
    visibility: document.visibilityState,
    error: document.getElementById('app-error')?.textContent,
  }));
  throw new Error(
    `Timed out: ${fn}\nRenderer: ${JSON.stringify(state)}\n${report.rendererErrors.join('\n')}`,
  );
}
async function click(id) {
  await evaluate(id => document.getElementById(id).click(), id);
}
async function change(id, value) {
  await evaluate(
    ({id, value}) => {
      const element = document.getElementById(id);
      element.value = value;
      element.dispatchEvent(new Event('change', {bubbles: true}));
    },
    {id, value},
  );
}
async function search(value) {
  await evaluate(value => {
    const element = document.getElementById('tool-settings-search');
    element.value = value;
    element.dispatchEvent(new Event('input', {bubbles: true}));
  }, value);
}
async function selectModel(value) {
  await evaluate(
    value =>
      [...document.querySelectorAll('#tool-settings-models input')]
        .find(input => input.value === value)
        .click(),
    value,
  );
}
async function open() {
  await click('app-menu-button');
  await click('open-model-settings');
  await waitFor(
    () =>
      document.getElementById('tool-settings-dialog').open &&
      !document.getElementById('tool-settings-content').hidden,
  );
}
async function assertCombinedVisible() {
  const structure = await evaluate(() => ({
    title: document.getElementById('tool-settings-title').textContent.trim(),
    sections: ['agent-model-settings', 'image-model-settings'].map(id => {
      const element = document.getElementById(id);
      return {
        heading: document
          .getElementById(element.getAttribute('aria-labelledby'))
          .textContent.trim(),
        visible: element.checkVisibility(),
      };
    }),
  }));
  assert.deepEqual(structure, {
    title: 'Tool models',
    sections: [
      {heading: 'Agent models', visible: true},
      {heading: 'OpenAI images', visible: true},
    ],
  });
}
async function auditThemeContrast() {
  return evaluate(() => {
    const parseColor = value => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d', {willReadFrequently: true});
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)].map(
        channel => channel / 255,
      );
    };
    const luminance = value =>
      parseColor(value)
        .map(channel =>
          channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4,
        )
        .reduce(
          (total, channel, index) =>
            total + channel * [0.2126, 0.7152, 0.0722][index],
          0,
        );
    const contrast = (first, second) => {
      const values = [luminance(first), luminance(second)].sort(
        (left, right) => right - left,
      );
      return (values[0] + 0.05) / (values[1] + 0.05);
    };
    const root = document.documentElement;
    const original = root.dataset.theme;
    const themeIds = [...document.getElementById('factory-theme').options].map(
      option => option.value,
    );
    const results = themeIds.map(theme => {
      root.dataset.theme = theme;
      const card = id => {
        const element = document.getElementById(id);
        const heading = element.querySelector('h3');
        const style = getComputedStyle(element);
        return {
          background: style.backgroundColor,
          heading: contrast(
            getComputedStyle(heading).color,
            style.backgroundColor,
          ),
          border: contrast(style.borderTopColor, style.backgroundColor),
        };
      };
      const control = (id, cardId) => {
        const style = getComputedStyle(document.getElementById(id));
        const cardStyle = getComputedStyle(document.getElementById(cardId));
        return {
          text: contrast(style.color, style.backgroundColor),
          boundary: contrast(style.borderTopColor, cardStyle.backgroundColor),
        };
      };
      return {
        theme,
        agents: card('agent-model-settings'),
        image: card('image-model-settings'),
        search: control('tool-settings-search', 'agent-model-settings'),
        imageModel: control('image-model', 'image-model-settings'),
        environmentLabel: contrast(
          getComputedStyle(document.getElementById('image-model-environment'))
            .color,
          getComputedStyle(document.getElementById('image-model-settings'))
            .backgroundColor,
        ),
      };
    });
    root.dataset.theme = original;
    return results;
  });
}
async function captureScreenshots(themes) {
  if (!screenshotDirectory) return;
  mkdirSync(screenshotDirectory, {recursive: true});
  for (const {theme} of themes) {
    await evaluate(async theme => {
      document.documentElement.dataset.theme = theme;
      await new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    }, theme);
    await delay(80);
    writeFileSync(
      join(screenshotDirectory, `${theme}.png`),
      (await browser.webContents.capturePage()).toPNG(),
    );
  }
  await evaluate(() => {
    document.documentElement.dataset.theme = 'factory';
  });
}
async function readDraft() {
  return evaluate(() => ({
    agents: {
      allowedModels: [
        ...document.querySelectorAll('#tool-settings-models input:checked'),
      ].map(input => input.value),
    },
  }));
}
async function submit(prompt) {
  await evaluate(prompt => {
    const input = document.getElementById('parent-prompt');
    input.value = prompt;
    input.dispatchEvent(new Event('input', {bubbles: true}));
    document.getElementById('prompt-form').requestSubmit();
  }, prompt);
}
async function escape() {
  browser.focus();
  browser.webContents.focus();
  browser.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Escape'});
  browser.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Escape'});
}
async function save() {
  await click('tool-settings-save');
  await waitFor(() => !document.getElementById('tool-settings-dialog').open);
}
function snapshot() {
  browser.webContents.send('pidev:snapshot', hub);
}
async function reload() {
  const loaded = new Promise(resolve =>
    browser.webContents.once('did-finish-load', resolve),
  );
  browser.reload();
  await loaded;
  await waitFor(() => !document.getElementById('factory-workspace').hidden);
}
async function main() {
  const {getToolModels, saveToolModel} = await import(
    pathToFileURL(
      resolve(__dirname, '../../desktop/build/src/tools/model-selection.js'),
    ).href
  );
  await app.whenReady();
  browser = new BrowserWindow({
    show: true,
    width: 1100,
    height: 760,
    webPreferences: {
      preload: resolve(__dirname, '../../assets/desktop/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  browser.webContents.on('console-message', details => {
    if (details.level === 'error') report.rendererErrors.push(details.message);
  });
  handle('pidev:get-state', () => hub);
  handle('pidev:recent-projects', () => []);
  handle('pidev:prompt-session', (id, input) => {
    prompts.push({id, input, settings: JSON.parse(JSON.stringify(settings))});
    return {steering: [], followUp: []};
  });
  handle('varisdev:get-update-status', () => ({
    phase: 'idle',
    currentVersion: '0.1.0',
    restartRequired: false,
  }));
  handle('varisdev:app-themes', () => ({themes: [], errors: []}));
  const features = () => ({
    commands: [],
    tools: [],
    models,
    diagnostics: [],
    thinkingLevel: 'off',
    thinkingLevels: ['off'],
  });
  handle('pidev:session-features', features);
  handle('pidev:agent-session', (_id, request) => {
    assert.equal(request.action, 'features');
    return features();
  });
  handle('varisdev:get-tool-models', getToolModels);
  handle('varisdev:save-tool-model', async (...args) => {
    imageWrites.push(args);
    await saveToolModel(...args);
  });
  handle('varisdev:get-tool-settings', id => {
    reads.push(id);
    if (loadError) throw new Error(loadError);
    return {settings, models: scopedModels ?? models};
  });
  handle('varisdev:save-tool-settings', (section, value, id) => {
    writes.push({section, value, id});
    assert.equal(section, 'all');
    assert.deepEqual(Object.keys(value).sort(), ['agents']);
    if (saveError) throw new Error(saveError);
    settings = JSON.parse(JSON.stringify(value));
    return {settings, models: scopedModels ?? models};
  });
  handle('varisdev:get-agent-notice', async () => {
    noticeReads++;
    if (noticeReads === 1) await initialNotice;
    if (noticeError) throw new Error(noticeError);
    return {acknowledged};
  });
  handle('varisdev:acknowledge-agent-notice', () => {
    if (ackError) throw new Error(ackError);
    acknowledged = true;
    acknowledgments++;
  });
  await browser.loadFile(
    resolve(__dirname, '../../assets/dashboard/index.html'),
  );
  await waitFor(() => !document.getElementById('factory-workspace').hidden);
  assert.equal(reads.length, 0, 'catalog is lazy');
  assert.equal(
    await evaluate(() => document.getElementById('agent-notice-dialog').open),
    false,
  );

  loadError = 'Catalog temporarily unavailable';
  await click('app-menu-button');
  assert.deepEqual(
    await evaluate(() =>
      [
        ...document.querySelectorAll(
          '#app-menu-panel button[aria-controls="tool-settings-dialog"]',
        ),
      ].map(button => ({id: button.id, text: button.textContent.trim()})),
    ),
    [{id: 'open-model-settings', text: 'Tool models'}],
    'the menu has one entry for the combined settings',
  );
  await click('open-model-settings');
  await waitFor(() => !document.getElementById('tool-settings-error').hidden);
  assert.match(
    await evaluate(
      () => document.getElementById('tool-settings-error').textContent,
    ),
    /Catalog temporarily/,
  );
  assert.equal(
    await evaluate(
      () => document.getElementById('tool-settings-save').disabled,
    ),
    true,
  );
  loadError = '';
  await click('tool-settings-retry');
  await waitFor(() => !document.getElementById('tool-settings-content').hidden);
  assert.equal(reads.at(-1), 'project');
  await assertCombinedVisible();
  const desktopLayout = await evaluate(() => {
    const ids = [
      'agent-model-settings',
      'image-model-settings',
      'image-model',
      'tool-settings-save',
    ];
    const rects = ids.map(id =>
      document.getElementById(id).getBoundingClientRect(),
    );
    return {
      beside: rects[0].right < rects[1].left,
      visibleTogether: rects.every(
        rect => rect.top >= 0 && rect.bottom <= window.innerHeight,
      ),
    };
  });
  assert.deepEqual(desktopLayout, {beside: true, visibleTogether: true});
  const environmentControl = await evaluate(() => {
    const select = document.getElementById('image-model');
    const source = document.getElementById('image-model-environment');
    return {
      value: select.value,
      option: select.selectedOptions[0].textContent,
      fallbackSource: select.selectedOptions[0].parentElement.label,
      disabled: select.disabled,
      source: source.textContent,
      sourceVisible: source.checkVisibility(),
      muted: select.classList.contains('environment-fallback'),
      matchesMutedLabel:
        getComputedStyle(select).color === getComputedStyle(source).color,
    };
  });
  assert.deepEqual(environmentControl, {
    value: '',
    option: 'gpt-image-1-mini',
    fallbackSource: 'OPENAI_IMAGE_MODEL',
    disabled: false,
    source: 'From OPENAI_IMAGE_MODEL',
    sourceVisible: true,
    muted: true,
    matchesMutedLabel: true,
  });
  assert.equal(
    existsSync(imageModelPath),
    false,
    'viewing does not save fallback',
  );
  assert.deepEqual(imageWrites, []);
  const themeContrast = await auditThemeContrast();
  for (const result of themeContrast) {
    assert.ok(
      result.environmentLabel >= 4.5,
      `${result.theme} environment source contrast is ${result.environmentLabel}`,
    );
    assert.notEqual(
      result.agents.background,
      result.image.background,
      `${result.theme} gives the cards distinct backgrounds`,
    );
    for (const [section, values] of [
      ['Agent models', result.agents],
      ['OpenAI images', result.image],
    ]) {
      assert.ok(
        values.heading >= 4.5,
        `${result.theme} ${section} heading contrast is ${values.heading}`,
      );
      assert.ok(
        values.border >= 3,
        `${result.theme} ${section} border contrast is ${values.border}`,
      );
    }
    for (const [control, values] of [
      ['Agent search', result.search],
      ['Image model', result.imageModel],
    ]) {
      assert.ok(
        values.text >= 4.5,
        `${result.theme} ${control} text contrast is ${values.text}`,
      );
      assert.ok(
        values.boundary >= 3,
        `${result.theme} ${control} boundary contrast is ${values.boundary}`,
      );
    }
  }
  await captureScreenshots(themeContrast);
  assert.deepEqual(
    await evaluate(() => ({
      choices: [
        ...document.querySelectorAll('#tool-settings-models input'),
      ].map(input => ({
        type: input.type,
        checked: input.checked,
        disabled: input.disabled,
      })),
      saveDisabled: document.getElementById('tool-settings-save').disabled,
    })),
    {
      choices: [
        {type: 'checkbox', checked: false, disabled: false},
        {type: 'checkbox', checked: false, disabled: false},
      ],
      saveDisabled: false,
    },
  );
  assert.equal(
    await evaluate(() => document.getElementById('commit-model-settings')),
    null,
  );
  assert.equal(
    await evaluate(() => document.getElementById('commit-notice-dialog')),
    null,
  );
  await search('swift');
  await selectModel('alpha/small');
  await search('no-match');
  assert.equal(
    await evaluate(() => document.getElementById('tool-settings-empty').hidden),
    false,
  );
  await search('');
  await change('image-model', 'gpt-image-2');
  const initialSettings = {agents: {allowedModels: ['alpha/small']}};
  assert.deepEqual(await readDraft(), initialSettings);
  await save();
  assert.deepEqual(writes[0], {
    section: 'all',
    value: initialSettings,
    id: 'project',
  });
  assert.equal(
    (await getToolModels()).find(model => model.id === 'openai-image').model,
    'gpt-image-2',
  );
  report.cases.push(
    'agent search and image choices save through the production preload',
  );

  await open();
  assert.deepEqual(
    await evaluate(() => ({
      value: document.getElementById('image-model').value,
      muted: document
        .getElementById('image-model')
        .classList.contains('environment-fallback'),
      sourceHidden: document.getElementById('image-model-environment').hidden,
    })),
    {value: 'gpt-image-2', muted: false, sourceHidden: true},
  );
  await change('image-model', '');
  await click('tool-settings-close');
  assert.equal((await getToolModels())[0].model, 'gpt-image-2');
  assert.deepEqual(imageWrites, [['openai-image', 'gpt-image-2']]);

  await open();
  await change('image-model', '');
  await save();
  assert.equal(
    existsSync(imageModelPath),
    false,
    'removal deletes saved model',
  );
  assert.equal((await getToolModels())[0].model, '');
  const removedWrites = imageWrites.length;
  await open();
  await save();
  assert.equal(
    imageWrites.length,
    removedWrites,
    'saving unchanged environment fallback does not persist it',
  );
  assert.equal(existsSync(imageModelPath), false);

  await open();
  await change('image-model', 'gpt-image-1-mini');
  await save();
  assert.equal(
    (await getToolModels())[0].model,
    'gpt-image-1-mini',
    'explicitly selecting the environment model saves a user choice',
  );
  await open();
  assert.equal(
    await evaluate(() =>
      document
        .getElementById('image-model')
        .classList.contains('environment-fallback'),
    ),
    false,
  );
  await change('image-model', '');
  await save();
  report.cases.push(
    'environment fallback is muted and labeled; only explicit image changes save and removal restores it',
  );

  await open();
  await selectModel('alpha/small');
  await selectModel('beta/large');
  const changedSettings = {agents: {allowedModels: ['beta/large']}};
  saveError = 'Disk is read only';
  await click('tool-settings-save');
  await waitFor(() => !document.getElementById('tool-settings-error').hidden);
  assert.deepEqual(settings, initialSettings);
  assert.deepEqual(await readDraft(), changedSettings);
  saveError = '';
  await save();
  assert.deepEqual(settings, changedSettings);
  for (const close of [() => click('tool-settings-close'), escape]) {
    await open();
    await selectModel('beta/large');
    await close();
    await waitFor(() => !document.getElementById('tool-settings-dialog').open);
    assert.deepEqual(settings, changedSettings);
  }
  report.cases.push(
    'save retry preserves drafts and cancellation discards them',
  );
  await open();
  hub.sessions[1].agents = [agent()];
  hub.sessions[1].totalAgents = 1;
  snapshot();
  await delay(80);
  assert.equal(
    await evaluate(() => document.getElementById('agent-notice-dialog').open),
    false,
  );
  releaseNotice();
  await delay(100);
  assert.equal(
    await evaluate(() => document.getElementById('agent-notice-dialog').open),
    false,
    'notice queues behind settings',
  );
  await click('tool-settings-close');
  await waitFor(() => document.getElementById('agent-notice-dialog').open);
  assert.equal(
    await evaluate(() => document.activeElement.id),
    'agent-notice-acknowledge',
  );
  assert.equal(hub.sessions[1].agents[0].status, 'running');
  ackError = 'Preference write failed';
  await click('agent-notice-configure');
  await waitFor(() => !document.getElementById('agent-notice-error').hidden);
  assert.equal(acknowledged, false);
  assert.equal(
    await evaluate(() => document.getElementById('tool-settings-dialog').open),
    false,
  );
  ackError = '';
  await click('agent-notice-configure');
  await waitFor(
    () =>
      document.getElementById('tool-settings-dialog').open &&
      !document.getElementById('tool-settings-content').hidden,
  );
  assert.equal(acknowledged, true);
  assert.equal(acknowledgments, 1);
  await assertCombinedVisible();
  assert.equal(
    await evaluate(() => document.activeElement.id),
    'tool-settings-search',
    'Agent Configure focuses the allowlist search',
  );
  assert.equal(
    await evaluate(() => document.getElementById('agent-notice-dialog').open),
    false,
  );
  await click('tool-settings-close');
  const before = reads.length;
  await reload();
  await delay(100);
  assert.equal(reads.length, before);
  assert.equal(
    await evaluate(() => document.getElementById('agent-notice-dialog').open),
    false,
  );
  report.cases.push(
    'first observed spawn in another session survives delayed preference read, queues and acknowledges before Configure; reload remembers',
  );

  hub.sessions[0].agents = [agent()];
  hub.sessions[0].totalAgents = 1;
  snapshot();
  await waitFor(() => document.querySelector('.worker-card, .history-row'));
  await evaluate(() =>
    document.querySelector('.worker-card, .history-row').click(),
  );
  await waitFor(
    () =>
      document.getElementById('inspector').dataset.conversationKind ===
      'subagent',
  );
  settings.agents.allowedModels = ['alpha/small', 'lost/old'];
  await open();
  assert.equal(reads.at(-1), 'project');
  assert.match(
    await evaluate(
      () => document.getElementById('tool-settings-models').textContent,
    ),
    /Unavailable in Pi/,
  );
  await selectModel('lost/old');
  await save();
  assert.deepEqual(settings.agents.allowedModels, ['alpha/small']);
  scopedModels = [models[1]];
  await open();
  await selectModel('alpha/small');
  await selectModel('beta/large');
  await save();
  assert.deepEqual(settings.agents.allowedModels, ['beta/large']);
  scopedModels = undefined;
  settings.agents.allowedModels = null;
  await open();
  assert.deepEqual(await readDraft(), {agents: {allowedModels: []}});
  await save();
  assert.deepEqual(settings.agents.allowedModels, []);
  report.cases.push(
    'worker selection uses the parent scope; unavailable choices and legacy selections remain editable',
  );

  acknowledged = false;
  noticeError = 'Preference read failed';
  hub.sessions.forEach(session => {
    session.agents = [];
    session.totalAgents = 0;
  });
  await reload();
  await delay(80);
  assert.equal(
    await evaluate(() => document.getElementById('agent-notice-dialog').open),
    false,
    'read error stays quiet before spawn',
  );
  hub.sessions[0].agents = [agent()];
  hub.sessions[0].totalAgents = 1;
  snapshot();
  await waitFor(() => document.getElementById('agent-notice-dialog').open);
  assert.match(
    await evaluate(
      () => document.getElementById('agent-notice-error').textContent,
    ),
    /Preference read failed/,
  );
  assert.equal(
    await evaluate(
      () => document.getElementById('agent-notice-acknowledge').disabled,
    ),
    true,
  );
  noticeError = '';
  await click('agent-notice-retry');
  await waitFor(
    () => !document.getElementById('agent-notice-acknowledge').disabled,
  );
  browser.focus();
  browser.webContents.focus();
  browser.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Escape'});
  browser.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Escape'});
  await waitFor(() => !document.getElementById('agent-notice-dialog').open);
  assert.equal(acknowledged, true);
  assert.equal(acknowledgments, 2);
  snapshot();
  await delay(80);
  assert.equal(
    await evaluate(() => document.getElementById('agent-notice-dialog').open),
    false,
  );
  report.cases.push(
    'notice read failure retries after spawn; Escape persists acknowledgment once',
  );

  await submit('Review the working tree');
  await waitFor(() => document.getElementById('parent-prompt').value === '');
  assert.equal(prompts.length, 1);
  assert.deepEqual(prompts[0].input, {prompt: 'Review the working tree'});
  report.cases.push('ordinary prompts dispatch directly');

  for (const zoom of [1, 1.25]) {
    browser.setContentSize(440, 600);
    browser.webContents.setZoomFactor(zoom);
    await open();
    await assertCombinedVisible();
    const geometry = await evaluate(() => {
      const dialog = document.getElementById('tool-settings-dialog');
      const rect = dialog.getBoundingClientRect();
      const save = document
        .getElementById('tool-settings-save')
        .getBoundingClientRect();
      const close = document
        .getElementById('tool-settings-close')
        .getBoundingClientRect();
      const body = document.querySelector('.tool-settings-body');
      return {
        fits:
          rect.left >= 0 &&
          rect.right <= window.innerWidth &&
          rect.top >= 0 &&
          rect.bottom <= window.innerHeight,
        noHorizontalScroll:
          dialog.scrollWidth <= dialog.clientWidth &&
          body.scrollWidth <= body.clientWidth,
        actionsVisible: [save, close].every(
          rect => rect.top >= 0 && rect.bottom <= window.innerHeight,
        ),
      };
    });
    assert.deepEqual(geometry, {
      fits: true,
      noHorizontalScroll: true,
      actionsVisible: true,
    });
    const imageVisible = await evaluate(() => {
      document
        .getElementById('image-model-settings')
        .scrollIntoView({block: 'nearest'});
      const body = document
        .querySelector('.tool-settings-body')
        .getBoundingClientRect();
      return ['image-model', 'image-model-environment'].every(id => {
        const element = document.getElementById(id);
        const rect = element.getBoundingClientRect();
        return (
          element.checkVisibility() &&
          rect.top >= body.top &&
          rect.bottom <= body.bottom
        );
      });
    });
    assert.equal(
      imageVisible,
      true,
      'environment model and source are accessible',
    );
    if (screenshotDirectory) {
      for (const {theme} of themeContrast) {
        await evaluate(theme => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        await delay(80);
        writeFileSync(
          join(screenshotDirectory, `${theme}-compact-${zoom}.png`),
          (await browser.webContents.capturePage()).toPNG(),
        );
      }
    }
    await click('tool-settings-close');
  }
  report.cases.push(
    'settings and actions remain accessible in compact windows and zoom',
  );
}
main()
  .catch(error => {
    report.error = error.stack || String(error);
  })
  .finally(() => {
    writeFileSync(reportPath, JSON.stringify(report));
    browser?.destroy();
    app.exit(report.error ? 1 : 0);
  });
