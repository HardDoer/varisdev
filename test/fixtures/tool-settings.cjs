/* global process, __dirname, document, window, Event, setTimeout */
const assert = require('node:assert/strict');
const {writeFileSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {app, BrowserWindow, ipcMain} = require('electron');
const [directory, reportPath] = process.argv.slice(2);
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
async function open(section) {
  await click('app-menu-button');
  await click(
    section === 'agents' ? 'open-agent-models' : 'open-commit-settings',
  );
  await waitFor(
    () =>
      document.getElementById('tool-settings-dialog').open &&
      !document.getElementById('tool-settings-content').hidden,
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
    commands: [],
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
    if (saveError) throw new Error(saveError);
    assert.ok(['agents', 'commit'].includes(section));
    settings = {...settings, [section]: value};
    return {settings, models};
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
  await click('open-agent-models');
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
  assert.deepEqual(
    await evaluate(() => ({
      mode: Boolean(document.getElementById('agent-model-mode')),
      choices: [
        ...document.querySelectorAll('#tool-settings-models input'),
      ].map(input => ({checked: input.checked, disabled: input.disabled})),
      saveDisabled: document.getElementById('tool-settings-save').disabled,
    })),
    {
      mode: false,
      choices: [
        {checked: false, disabled: false},
        {checked: false, disabled: false},
      ],
      saveDisabled: false,
    },
  );
  await search('swift');
  assert.equal(
    await evaluate(
      () => document.querySelectorAll('#tool-settings-models input').length,
    ),
    1,
  );
  await selectModel('alpha/small');
  await search('beta/large');
  assert.equal(
    await evaluate(
      () => document.querySelector('#tool-settings-models strong').textContent,
    ),
    'Deep model',
  );
  await search('no-match');
  assert.equal(
    await evaluate(() => document.getElementById('tool-settings-empty').hidden),
    false,
  );
  await search('');
  assert.equal(
    await evaluate(
      () => document.querySelector('#tool-settings-models input').checked,
    ),
    true,
  );
  saveError = 'Disk is read only';
  await click('tool-settings-save');
  await waitFor(() => !document.getElementById('tool-settings-error').hidden);
  assert.deepEqual(settings.agents, {allowedModels: []});
  assert.equal(
    await evaluate(
      () => document.querySelector('#tool-settings-models input').checked,
    ),
    true,
  );
  saveError = '';
  await save();
  assert.deepEqual(settings.agents.allowedModels, ['alpha/small']);
  await open('agents');
  assert.equal(
    await evaluate(
      () => document.querySelector('#tool-settings-models input').checked,
    ),
    true,
  );
  report.cases.push(
    'lazy catalog, load retry, explicit deselected defaults, search and save failure preservation',
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
  assert.equal(
    await evaluate(
      () => document.getElementById('tool-settings-title').textContent,
    ),
    'Agent models',
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
  settings.commit = {model: 'beta/large', thinkingLevel: 'medium'};
  await open('commit');
  assert.equal(reads.at(-1), 'project');
  assert.equal(
    await evaluate(
      () => document.getElementById('tool-settings-save').disabled,
    ),
    true,
  );
  assert.equal(
    await evaluate(
      () =>
        document.querySelector(
          '#tool-settings-models input[value="beta/large"]',
        ).disabled,
    ),
    true,
  );
  assert.match(
    await evaluate(
      () => document.getElementById('tool-settings-models').textContent,
    ),
    /Disabled by Agent models/,
  );
  await selectModel('alpha/small');
  await change('commit-thinking', 'xhigh');
  await save();
  assert.deepEqual(settings.commit, {
    model: 'alpha/small',
    thinkingLevel: 'xhigh',
  });
  assert.equal(writes.at(-1).id, 'project');
  await open('commit');
  assert.equal(
    await evaluate(() => document.getElementById('commit-thinking').value),
    'xhigh',
  );
  assert.deepEqual(
    await evaluate(() =>
      [...document.getElementById('commit-thinking').options].map(
        option => option.value,
      ),
    ),
    ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  );
  await click('commit-inherit-model');
  await change('commit-thinking', '');
  await save();
  assert.deepEqual(settings.commit, {model: null, thinkingLevel: null});
  report.cases.push(
    'commit filters by allowlist, preserves disabled saved model, supports thinking and parent inheritance with worker selected',
  );

  settings.agents.allowedModels.push('lost/old');
  await open('agents');
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
  await selectModel('lost/old');
  await save();
  assert.deepEqual(settings.agents.allowedModels, ['alpha/small']);
  settings.commit.model = 'lost/old';
  await open('commit');
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
  await click('commit-inherit-model');
  await save();
  await open('agents');
  await selectModel('alpha/small');
  await save();
  assert.deepEqual(settings.agents, {allowedModels: []});
  await open('commit');
  assert.equal(
    await evaluate(
      () =>
        document.querySelector(
          '#tool-settings-models input[value="beta/large"]',
        ).disabled,
    ),
    true,
  );
  await click('tool-settings-close');
  settings.agents.allowedModels = null;
  await open('agents');
  assert.equal(
    await evaluate(
      () =>
        document.querySelectorAll('#tool-settings-models input:checked').length,
    ),
    0,
    'Legacy all-model settings open as an explicit empty draft',
  );
  await save();
  assert.deepEqual(settings.agents, {allowedModels: []});
  report.cases.push(
    'unavailable saved models stay removable; empty and legacy selections require explicit choices',
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

  await open('agents');
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
  await submit('/commit review changes');
  await waitFor(() => document.getElementById('commit-notice-dialog').open);
  assert.equal(prompts.length, 1, 'first commit waits before dispatch');
  assert.equal(commitAcknowledged, false);
  await escape();
  await waitFor(() => !document.getElementById('commit-notice-dialog').open);
  assert.equal(commitAcknowledged, false);
  assert.equal(
    await evaluate(() => document.getElementById('parent-prompt').value),
    '/commit review changes',
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
  assert.equal(
    await evaluate(
      () => document.getElementById('tool-settings-title').textContent,
    ),
    'Commit settings',
  );
  await selectModel('beta/large');
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
  await submit('/commit');
  await waitFor(() => document.getElementById('parent-prompt').value === '');
  assert.equal(prompts.length, 3);
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

  // The backend supplies the active Pi scope; globally saved selections stay
  // visible and removable when a session offers a narrower model list.
  settings.agents.allowedModels = ['alpha/small', 'beta/large'];
  settings.commit = {model: 'beta/large', thinkingLevel: null};
  scopedModels = [models[0]];
  await open('agents');
  assert.deepEqual(settings.agents.allowedModels, [
    'alpha/small',
    'beta/large',
  ]);
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
  );
  assert.match(
    await evaluate(
      () => document.getElementById('tool-settings-models').textContent,
    ),
    /current model list.*Scoped models/,
  );
  await click('tool-settings-close');
  await open('commit');
  assert.equal(
    await evaluate(
      () => document.getElementById('tool-settings-save').disabled,
    ),
    true,
  );
  assert.equal(
    await evaluate(
      () =>
        document.querySelector(
          '#tool-settings-models input[value="beta/large"]',
        ).disabled,
    ),
    true,
  );
  await click('commit-inherit-model');
  await save();
  assert.deepEqual(settings.commit, {model: null, thinkingLevel: null});
  await open('agents');
  await selectModel('beta/large');
  await save();
  assert.deepEqual(settings.agents.allowedModels, ['alpha/small']);
  await open('agents');
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
  await open('agents');
  assert.equal(
    await evaluate(
      () => document.querySelectorAll('#tool-settings-models input').length,
    ),
    2,
  );
  await click('tool-settings-close');
  report.cases.push(
    'scoped choices preserve global preferences, allow removal and Commit parent inheritance; clearing scope restores choices',
  );

  browser.setContentSize(440, 600);
  await open('agents');
  const geometry = await evaluate(() => {
    const dialog = document.getElementById('tool-settings-dialog');
    const rect = dialog.getBoundingClientRect();
    return {
      fits:
        rect.left >= 0 &&
        rect.right <= window.innerWidth &&
        rect.top >= 0 &&
        rect.bottom <= window.innerHeight,
      noHorizontalScroll: dialog.scrollWidth <= dialog.clientWidth,
    };
  });
  assert.deepEqual(geometry, {fits: true, noHorizontalScroll: true});
  report.cases.push('settings fit a narrow desktop window');
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
