/* global process, __dirname, document, window, Event, setTimeout, getComputedStyle, requestAnimationFrame */
const assert = require('node:assert/strict');
const {mkdirSync, writeFileSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {app, BrowserWindow, ipcMain} = require('electron');
const [directory, reportPath] = process.argv.slice(2);
const screenshotDirectory = process.env.VARISDEV_TOOL_MODELS_SCREENSHOTS;
const report = {cases: []};
let browser;
const reads = [];
const writes = [];
let settings = {
  agents: {allowedModels: []},
  commit: {model: null, thinkingLevel: null},
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
let commitAcknowledged = false;
let commitNoticeReads = 0;
let commitNoticeError = '';
let commitAckError = '';
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
  throw new Error(`Timed out: ${fn}`);
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
    sections: ['agent-model-settings', 'commit-model-settings'].map(id => {
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
      {heading: 'Commit', visible: true},
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
        commit: card('commit-model-settings'),
        search: control('tool-settings-search', 'agent-model-settings'),
        commitModel: control('commit-model', 'commit-model-settings'),
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
    commit: {
      model: document.getElementById('commit-model').value || null,
      thinkingLevel: document.getElementById('commit-thinking').value || null,
    },
  }));
}
async function commitChoices() {
  return evaluate(() =>
    [...document.getElementById('commit-model').options].map(option => ({
      value: option.value,
      disabled: option.disabled,
    })),
  );
}
async function submit(prompt) {
  await evaluate(prompt => {
    const input = document.getElementById('parent-prompt');
    input.value = prompt;
    input.dispatchEvent(new Event('input', {bubbles: true}));
    document.getElementById('prompt-form').requestSubmit();
  }, prompt);
}
async function enterCommand(prompt) {
  await evaluate(prompt => {
    const input = document.getElementById('parent-prompt');
    input.value = prompt;
    input.focus();
    input.dispatchEvent(new Event('input', {bubbles: true}));
  }, prompt);
  await waitFor(() => !document.getElementById('command-suggestions').hidden);
  browser.focus();
  browser.webContents.focus();
  browser.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Return'});
  browser.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Return'});
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
  handle('pidev:get-state', () => hub);
  handle('pidev:recent-projects', () => []);
  handle('pidev:prompt-session', (id, input) => {
    prompts.push({id, input, settings: JSON.parse(JSON.stringify(settings))});
    return {steering: [], followUp: []};
  });
  handle('varisdev:get-commit-notice', () => {
    commitNoticeReads++;
    if (commitNoticeError) throw new Error(commitNoticeError);
    return {acknowledged: commitAcknowledged};
  });
  handle('varisdev:acknowledge-commit-notice', () => {
    if (commitAckError) throw new Error(commitAckError);
    commitAcknowledged = true;
  });
  handle('varisdev:get-update-status', () => ({
    phase: 'idle',
    currentVersion: '0.1.0',
    restartRequired: false,
  }));
  handle('varisdev:app-themes', () => ({themes: [], errors: []}));
  handle('pidev:session-features', () => ({
    commands: [
      {name: 'commit', description: 'Commit and push', source: 'extension'},
    ],
    tools: [],
    models,
    diagnostics: [],
    thinkingLevel: 'off',
    thinkingLevels: ['off'],
  }));
  handle('varisdev:get-tool-settings', id => {
    reads.push(id);
    if (loadError) throw new Error(loadError);
    return {settings, models: scopedModels ?? models};
  });
  handle('varisdev:save-tool-settings', (section, value, id) => {
    writes.push({section, value, id});
    assert.equal(section, 'all');
    assert.deepEqual(Object.keys(value).sort(), ['agents', 'commit']);
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
      'commit-model-settings',
      'commit-model',
      'commit-thinking',
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
  const themeContrast = await auditThemeContrast();
  for (const result of themeContrast) {
    assert.notEqual(
      result.agents.background,
      result.commit.background,
      `${result.theme} gives the cards distinct backgrounds`,
    );
    for (const [section, values] of [
      ['Agent models', result.agents],
      ['Commit', result.commit],
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
      ['Commit model', result.commitModel],
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
  assert.deepEqual(await commitChoices(), [{value: '', disabled: false}]);
  await search('swift');
  assert.equal(
    await evaluate(
      () => document.querySelectorAll('#tool-settings-models input').length,
    ),
    1,
  );
  await selectModel('alpha/small');
  assert.deepEqual(await commitChoices(), [
    {value: '', disabled: false},
    {value: 'alpha/small', disabled: false},
  ]);
  await change('commit-model', 'alpha/small');
  await change('commit-thinking', 'medium');
  const selectedCommit = {model: 'alpha/small', thinkingLevel: 'medium'};
  for (const query of ['beta/large', 'no-match']) {
    await search(query);
    await assertCombinedVisible();
    assert.deepEqual(
      await evaluate(() => ({
        model: document.getElementById('commit-model').value,
        thinkingLevel: document.getElementById('commit-thinking').value,
      })),
      selectedCommit,
      'agent search preserves the Commit selection',
    );
    assert.deepEqual(await commitChoices(), [
      {value: '', disabled: false},
      {value: 'alpha/small', disabled: false},
    ]);
  }
  assert.equal(
    await evaluate(() => document.getElementById('tool-settings-empty').hidden),
    false,
  );
  await search('');
  const initialSettings = {
    agents: {allowedModels: ['alpha/small']},
    commit: selectedCommit,
  };
  assert.deepEqual(await readDraft(), initialSettings);
  await save();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    section: 'all',
    value: initialSettings,
    id: 'project',
  });
  assert.deepEqual(settings, initialSettings);
  report.cases.push(
    'one combined menu and visible sections, lazy catalog retry, checkbox defaults and independent agent search',
  );

  await open();
  await selectModel('alpha/small');
  assert.deepEqual(await commitChoices(), [
    {value: '', disabled: false},
    {value: 'alpha/small', disabled: true},
  ]);
  assert.equal(
    await evaluate(
      () => document.getElementById('tool-settings-save').disabled,
    ),
    true,
    'removing the selected Commit model from the allowlist blocks Save',
  );
  await selectModel('beta/large');
  assert.deepEqual(await commitChoices(), [
    {value: '', disabled: false},
    {value: 'alpha/small', disabled: true},
    {value: 'beta/large', disabled: false},
  ]);
  await change('commit-model', 'beta/large');
  await change('commit-thinking', 'max');
  const changedSettings = {
    agents: {allowedModels: ['beta/large']},
    commit: {model: 'beta/large', thinkingLevel: 'max'},
  };
  assert.deepEqual(await readDraft(), changedSettings);
  const beforeFailure = writes.length;
  saveError = 'Disk is read only';
  await click('tool-settings-save');
  await waitFor(() => !document.getElementById('tool-settings-error').hidden);
  assert.match(
    await evaluate(
      () => document.getElementById('tool-settings-error').textContent,
    ),
    /Disk is read only/,
  );
  assert.equal(writes.length, beforeFailure + 1);
  assert.deepEqual(writes.at(-1), {
    section: 'all',
    value: changedSettings,
    id: 'project',
  });
  assert.deepEqual(
    settings,
    initialSettings,
    'a failed save preserves both stored sections',
  );
  assert.deepEqual(
    await readDraft(),
    changedSettings,
    'a failed save preserves both drafts',
  );
  await assertCombinedVisible();
  saveError = '';
  await save();
  assert.equal(
    writes.length,
    beforeFailure + 2,
    'each Save sends one IPC request',
  );
  assert.deepEqual(
    settings,
    changedSettings,
    'disjoint allowlists and Commit models change together',
  );
  report.cases.push(
    'allowlist updates Commit choices immediately; one atomic save changes disjoint selections and preserves both drafts on failure',
  );

  const beforeDiscard = writes.length;
  for (const close of [() => click('tool-settings-close'), escape]) {
    await open();
    await selectModel('beta/large');
    await selectModel('alpha/small');
    await change('commit-model', 'alpha/small');
    await change('commit-thinking', 'off');
    assert.deepEqual(await readDraft(), {
      agents: {allowedModels: ['alpha/small']},
      commit: {model: 'alpha/small', thinkingLevel: 'off'},
    });
    await close();
    await waitFor(() => !document.getElementById('tool-settings-dialog').open);
    assert.equal(writes.length, beforeDiscard);
    assert.deepEqual(settings, changedSettings);
    await open();
    assert.deepEqual(
      await readDraft(),
      changedSettings,
      'closing discards both drafts',
    );
    await click('tool-settings-close');
  }
  await open();
  report.cases.push(
    'Close and Escape discard agent and Commit drafts together',
  );

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
  // Selecting a worker must still send the parent session ID to the model catalog.
  await evaluate(() =>
    document.querySelector('.worker-card, .history-row').click(),
  );
  await waitFor(
    () =>
      document.getElementById('inspector').dataset.conversationKind === 'agent',
  );
  settings.agents.allowedModels = ['alpha/small'];
  settings.commit = {model: 'beta/large', thinkingLevel: 'medium'};
  await open();
  assert.equal(reads.at(-1), 'project');
  await assertCombinedVisible();
  assert.equal(
    await evaluate(
      () => document.getElementById('tool-settings-save').disabled,
    ),
    true,
  );
  assert.deepEqual(await commitChoices(), [
    {value: '', disabled: false},
    {value: 'alpha/small', disabled: false},
    {value: 'beta/large', disabled: true},
  ]);
  assert.equal(
    await evaluate(() => document.getElementById('commit-model').value),
    'beta/large',
    'a saved disallowed model stays selected',
  );
  assert.match(
    await evaluate(
      () => document.querySelector('#commit-model option:checked').textContent,
    ),
    /not allowed/,
  );
  assert.equal(
    await evaluate(
      () =>
        document.querySelector(
          '#tool-settings-models input[value="beta/large"]',
        ).disabled,
    ),
    false,
    'available models can be added to the allowlist',
  );
  await selectModel('beta/large');
  assert.deepEqual(await commitChoices(), [
    {value: '', disabled: false},
    {value: 'alpha/small', disabled: false},
    {value: 'beta/large', disabled: false},
  ]);
  assert.equal(
    await evaluate(
      () => document.getElementById('tool-settings-save').disabled,
    ),
    false,
    'allowing the selected Commit model enables Save immediately',
  );
  await selectModel('beta/large');
  assert.equal(
    await evaluate(
      () => document.getElementById('tool-settings-save').disabled,
    ),
    true,
  );
  await change('commit-model', 'alpha/small');
  assert.equal(
    await evaluate(
      () => document.getElementById('tool-settings-save').disabled,
    ),
    false,
    'choosing an allowed Commit model enables Save',
  );
  await change('commit-thinking', 'max');
  await save();
  assert.deepEqual(settings, {
    agents: {allowedModels: ['alpha/small']},
    commit: {model: 'alpha/small', thinkingLevel: 'max'},
  });
  assert.equal(writes.at(-1).id, 'project');
  await open();
  assert.equal(
    await evaluate(() => document.getElementById('commit-thinking').value),
    'max',
  );
  assert.deepEqual(
    await evaluate(() =>
      [...document.getElementById('commit-thinking').options].map(
        option => option.value,
      ),
    ),
    ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  );
  await change('commit-model', '');
  await change('commit-thinking', '');
  await save();
  assert.deepEqual(settings.commit, {model: null, thinkingLevel: null});
  report.cases.push(
    'selected disallowed Commit model resolves by allowing or changing it; thinking and inheritance use the parent session with a worker selected',
  );

  settings.agents.allowedModels.push('lost/old');
  await open();
  assert.match(
    await evaluate(
      () => document.getElementById('tool-settings-models').textContent,
    ),
    /Unavailable in Pi/,
  );
  assert.equal(
    await evaluate(
      () =>
        document.querySelector('#tool-settings-models input[value="lost/old"]')
          .checked,
    ),
    true,
  );
  assert.deepEqual(await commitChoices(), [
    {value: '', disabled: false},
    {value: 'alpha/small', disabled: false},
    {value: 'lost/old', disabled: true},
  ]);
  await selectModel('lost/old');
  await save();
  assert.deepEqual(settings.agents.allowedModels, ['alpha/small']);
  settings.commit.model = 'lost/old';
  await open();
  assert.equal(
    await evaluate(
      () => document.getElementById('tool-settings-save').disabled,
    ),
    true,
  );
  assert.equal(
    await evaluate(
      () =>
        document.querySelector('#tool-settings-models input[value="lost/old"]')
          .disabled,
    ),
    true,
  );
  assert.deepEqual(await commitChoices(), [
    {value: '', disabled: false},
    {value: 'alpha/small', disabled: false},
    {value: 'lost/old', disabled: true},
  ]);
  assert.equal(
    await evaluate(() => document.getElementById('commit-model').value),
    'lost/old',
  );
  assert.match(
    await evaluate(
      () => document.querySelector('#commit-model option:checked').textContent,
    ),
    /unavailable/,
  );
  await change('commit-model', '');
  assert.equal(
    await evaluate(
      () => document.getElementById('tool-settings-save').disabled,
    ),
    false,
    'inheritance clears an unavailable Commit model',
  );
  await save();
  await open();
  await selectModel('alpha/small');
  await save();
  assert.deepEqual(settings.agents, {allowedModels: []});
  await open();
  assert.deepEqual(await commitChoices(), [{value: '', disabled: false}]);
  assert.equal(
    await evaluate(
      () =>
        document.querySelectorAll('#tool-settings-models input:disabled')
          .length,
    ),
    0,
    'an empty allowlist still permits selecting available agent models',
  );
  await click('tool-settings-close');
  settings.agents.allowedModels = null;
  await open();
  assert.deepEqual(
    await readDraft(),
    {
      agents: {allowedModels: []},
      commit: {model: null, thinkingLevel: null},
    },
    'legacy all-model settings open as an explicit empty draft',
  );
  await save();
  assert.deepEqual(settings.agents, {allowedModels: []});
  report.cases.push(
    'unavailable saved models stay removable and invalid Commit choices require inheritance; empty and legacy allowlists stay explicit',
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

  await open();
  await selectModel('beta/large');
  await save();
  await submit('/commitment inspect');
  await waitFor(() => document.getElementById('parent-prompt').value === '');
  assert.equal(prompts.length, 1);
  assert.equal(
    commitNoticeReads,
    0,
    'normal prompts do not read commit preferences',
  );
  await enterCommand('/commit');
  await waitFor(() => document.getElementById('commit-notice-dialog').open);
  assert.equal(prompts.length, 1, 'first commit waits before dispatch');
  assert.equal(commitAcknowledged, false);
  await escape();
  await waitFor(() => !document.getElementById('commit-notice-dialog').open);
  assert.equal(commitAcknowledged, false);
  assert.equal(
    await evaluate(() => document.getElementById('parent-prompt').value),
    '/commit',
  );
  await submit('/commit review changes');
  await waitFor(() => document.getElementById('commit-notice-dialog').open);
  commitAckError = 'Cannot write commit preference';
  await click('commit-notice-configure');
  await waitFor(() => !document.getElementById('commit-notice-error').hidden);
  assert.equal(prompts.length, 1);
  assert.equal(commitAcknowledged, false);
  commitAckError = '';
  await click('commit-notice-configure');
  await waitFor(
    () =>
      document.getElementById('tool-settings-dialog').open &&
      !document.getElementById('tool-settings-content').hidden,
  );
  assert.equal(commitAcknowledged, true);
  assert.equal(acknowledged, true, 'agent acknowledgment is independent');
  assert.equal(prompts.length, 1);
  assert.equal(
    await evaluate(() => document.getElementById('parent-prompt').value),
    '/commit review changes',
  );
  await assertCombinedVisible();
  assert.equal(
    await evaluate(() => document.activeElement.id),
    'commit-model',
    'Commit Configure focuses the Commit model selector',
  );
  await change('commit-model', 'beta/large');
  await change('commit-thinking', 'high');
  await save();
  await submit('/commit review changes');
  await waitFor(() => document.getElementById('parent-prompt').value === '');
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts.at(-1).settings.commit, {
    model: 'beta/large',
    thinkingLevel: 'high',
  });
  await reload();
  await enterCommand('/comm');
  await waitFor(
    () => document.getElementById('parent-prompt').value === '/commit ',
  );
  assert.equal(prompts.length, 2, 'partial command completion keeps the draft');
  await enterCommand('/commit');
  await waitFor(() => document.getElementById('parent-prompt').value === '');
  assert.equal(prompts.length, 3);
  assert.deepEqual(prompts.at(-1).input, {prompt: '/commit'});
  assert.equal(
    await evaluate(() => document.getElementById('commit-notice-dialog').open),
    false,
  );
  report.cases.push(
    'commit notice gates dispatch; Escape preserves draft; Configure acknowledges and saves choices for next send; reload remembers',
  );

  acknowledged = false;
  commitAcknowledged = false;
  commitNoticeError = 'Commit preferences unavailable';
  hub.sessions.forEach(session => {
    session.agents = [];
    session.totalAgents = 0;
  });
  await reload();
  await submit('/commit');
  await waitFor(() => document.getElementById('commit-notice-dialog').open);
  assert.equal(prompts.length, 3);
  assert.match(
    await evaluate(
      () => document.getElementById('commit-notice-error').textContent,
    ),
    /Commit preferences unavailable/,
  );
  assert.equal(
    await evaluate(
      () => document.getElementById('commit-notice-continue').disabled,
    ),
    true,
  );
  hub.sessions[0].agents = [agent()];
  hub.sessions[0].totalAgents = 1;
  snapshot();
  await delay(100);
  assert.equal(
    await evaluate(() => document.getElementById('agent-notice-dialog').open),
    false,
  );
  commitNoticeError = '';
  await click('commit-notice-retry');
  await waitFor(
    () => !document.getElementById('commit-notice-continue').disabled,
  );
  assert.equal(prompts.length, 3);
  await click('commit-notice-continue');
  await waitFor(() => document.getElementById('parent-prompt').value === '');
  assert.equal(prompts.length, 4);
  assert.equal(commitAcknowledged, true);
  assert.equal(acknowledged, false);
  await waitFor(() => document.getElementById('agent-notice-dialog').open);
  await click('agent-notice-acknowledge');
  await waitFor(() => !document.getElementById('agent-notice-dialog').open);
  assert.equal(acknowledged, true);
  report.cases.push(
    'commit read retry and Continue dispatch; agent notice queues independently behind commit notice',
  );

  scopedModels = [models[0]];
  settings.agents.allowedModels = ['alpha/small'];
  settings.commit = {model: null, thinkingLevel: null};
  await open();
  await assertCombinedVisible();
  assert.deepEqual(
    await evaluate(() =>
      [...document.querySelectorAll('#tool-settings-models input')].map(
        input => input.value,
      ),
    ),
    ['alpha/small'],
    'the allowlist only offers models from the active Pi scope',
  );
  assert.deepEqual(await commitChoices(), [
    {value: '', disabled: false},
    {value: 'alpha/small', disabled: false},
  ]);
  await click('tool-settings-close');

  settings.agents.allowedModels = ['alpha/small', 'beta/large'];
  settings.commit = {model: 'beta/large', thinkingLevel: null};
  await open();
  assert.deepEqual(
    settings.agents.allowedModels,
    ['alpha/small', 'beta/large'],
    'opening scoped settings preserves stored preferences',
  );
  assert.deepEqual(
    await evaluate(() =>
      [...document.querySelectorAll('#tool-settings-models input')].map(
        input => ({
          value: input.value,
          checked: input.checked,
          disabled: input.disabled,
        }),
      ),
    ),
    [
      {value: 'alpha/small', checked: true, disabled: false},
      {value: 'beta/large', checked: true, disabled: false},
    ],
    'saved unavailable agent choices remain removable',
  );
  assert.match(
    await evaluate(
      () => document.getElementById('tool-settings-models').textContent,
    ),
    /current model list.*Scoped models/,
  );
  assert.deepEqual(await commitChoices(), [
    {value: '', disabled: false},
    {value: 'alpha/small', disabled: false},
    {value: 'beta/large', disabled: true},
  ]);
  assert.equal(
    await evaluate(
      () => document.getElementById('tool-settings-save').disabled,
    ),
    true,
  );
  await selectModel('beta/large');
  assert.equal(
    await evaluate(() => document.getElementById('commit-model').value),
    'beta/large',
    'removing an unavailable allowlist entry preserves the selected invalid Commit model',
  );
  assert.equal(
    await evaluate(
      () => document.getElementById('tool-settings-save').disabled,
    ),
    true,
  );
  await change('commit-model', '');
  await save();
  assert.deepEqual(settings, {
    agents: {allowedModels: ['alpha/small']},
    commit: {model: null, thinkingLevel: null},
  });
  await open();
  assert.deepEqual(
    await evaluate(() =>
      [...document.querySelectorAll('#tool-settings-models input')].map(
        input => input.value,
      ),
    ),
    ['alpha/small'],
  );
  await click('tool-settings-close');
  scopedModels = undefined;
  await open();
  assert.equal(
    await evaluate(
      () => document.querySelectorAll('#tool-settings-models input').length,
    ),
    2,
  );
  await click('tool-settings-close');
  report.cases.push(
    'scoped choices preserve preferences and allow unavailable allowlist removal with Commit inheritance in one save',
  );

  browser.setContentSize(440, 600);
  await open();
  await assertCombinedVisible();
  const geometry = await evaluate(() => {
    const dialog = document.getElementById('tool-settings-dialog');
    const agents = document
      .getElementById('agent-model-settings')
      .getBoundingClientRect();
    const commit = document
      .getElementById('commit-model-settings')
      .getBoundingClientRect();
    const model = document
      .getElementById('commit-model')
      .parentElement.getBoundingClientRect();
    const thinking = document
      .getElementById('commit-thinking')
      .parentElement.getBoundingClientRect();
    const rect = dialog.getBoundingClientRect();
    return {
      fits:
        rect.left >= 0 &&
        rect.right <= window.innerWidth &&
        rect.top >= 0 &&
        rect.bottom <= window.innerHeight,
      noHorizontalScroll: dialog.scrollWidth <= dialog.clientWidth,
      separateCards: agents.bottom < commit.top,
      stackedCommitControls:
        model.bottom < thinking.top && Math.abs(model.left - thinking.left) < 1,
      controlsFitCards:
        model.left >= commit.left &&
        model.right <= commit.right &&
        thinking.left >= commit.left &&
        thinking.right <= commit.right,
    };
  });
  assert.deepEqual(geometry, {
    fits: true,
    noHorizontalScroll: true,
    separateCards: true,
    stackedCommitControls: true,
    controlsFitCards: true,
  });
  report.cases.push(
    'separate settings cards and stacked Commit controls fit a narrow desktop window',
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
