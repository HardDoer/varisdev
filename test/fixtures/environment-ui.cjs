/* global process, __dirname, document, window, Event, localStorage, getComputedStyle, requestAnimationFrame, setTimeout */
const assert = require('node:assert/strict');
const {mkdirSync, writeFileSync, readFileSync, existsSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {app, BrowserWindow, ipcMain} = require('electron');

const [directory, reportPath] = process.argv.slice(2);
const screenshots = process.env.VARISDEV_ENVIRONMENT_SCREENSHOTS;
const report = {cases: [], contrast: []};
const file = join(directory, 'environment.json');
const environment = {
  OPENAI_API_KEY: 'fixture-machine-private-key',
  LLAMA_BASE_URL: 'http://localhost:8080/v1',
  PATH: '/fixture/bin:/usr/bin:/bin',
  TEST_TOKEN: 'fixture-machine-private-token',
};
const saved = {};
let browser;
let loadError = '';
let stateError = '';
let saveError = '';
let saveFailureState = false;
let releaseLoad;
let releaseSave;
let nextLoad;
let nextSave;
const writes = [];
const errors = [];
const at = '2026-01-01T12:00:00.000Z';
const hub = {
  sessions: [
    {
      session: {
        id: 'project',
        name: 'Environment settings',
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
    },
  ],
  selectedSessionId: 'project',
  launchCwd: directory,
};

app.setPath('userData', join(directory, 'profile'));
app.setPath('sessionData', join(directory, 'session'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (fn, arg) =>
  browser.webContents.executeJavaScript(
    `(${fn.toString()})(${JSON.stringify(arg)})`,
  );
async function waitFor(fn) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await evaluate(fn)) return;
    await delay(20);
  }
  throw new Error(`Renderer stalled: ${fn}\n${JSON.stringify(errors)}`);
}
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
function state() {
  return {
    values: {...environment, ...saved},
    names: [
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'LLAMA_BASE_URL',
      'CUSTOM_SECRET',
    ],
    savedNames: Object.keys(saved),
    ...(stateError ? {error: stateError} : {}),
  };
}
async function click(id) {
  await evaluate(id => document.getElementById(id).click(), id);
}
async function input(id, value, event = 'input') {
  await evaluate(
    ({id, value, event}) => {
      const element = document.getElementById(id);
      element.value = value;
      element.dispatchEvent(new Event(event, {bubbles: true}));
    },
    {id, value, event},
  );
}
async function select(name) {
  await input('environment-variable', name, 'change');
}
async function open(loaded = true) {
  await click('app-menu-button');
  await evaluate(() =>
    document.getElementById('open-environment').scrollIntoView(),
  );
  await click('open-environment');
  await waitFor(() => document.getElementById('environment-dialog').open);
  if (loaded)
    await waitFor(
      () => !document.getElementById('environment-variable').disabled,
    );
}
async function close() {
  await click('environment-close');
  await waitFor(() => !document.getElementById('environment-dialog').open);
}
async function escape() {
  browser.focus();
  browser.webContents.focus();
  browser.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Escape'});
  browser.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Escape'});
}
async function save() {
  await click('environment-save');
  await waitFor(
    () =>
      document.getElementById('environment-status').textContent === 'Saved.',
  );
}
async function presentation() {
  return evaluate(() => ({
    type: document.getElementById('environment-value').type,
    value: document.getElementById('environment-value').value,
    gray: document
      .getElementById('environment-value')
      .classList.contains('environment-read-value'),
    note: !document.getElementById('environment-value-note').hidden,
    toggle: !document.getElementById('environment-show').hidden,
    remove: !document.getElementById('environment-remove').hidden,
  }));
}
async function capture(name) {
  if (!screenshots) return;
  await evaluate(
    () =>
      new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  writeFileSync(
    join(screenshots, `${name}.png`),
    (await browser.webContents.capturePage()).toPNG(),
  );
}
async function geometry() {
  return evaluate(() => {
    const dialog = document.getElementById('environment-dialog');
    const body = document.querySelector('.environment-body');
    const rect = dialog.getBoundingClientRect();
    const visible = id => {
      const element = document.getElementById(id);
      if (element.hidden) return true;
      const box = element.getBoundingClientRect();
      return (
        box.width > 0 &&
        box.height > 0 &&
        box.left >= rect.left &&
        box.right <= rect.right &&
        box.top >= rect.top &&
        box.bottom <= rect.bottom
      );
    };
    return {
      fits:
        rect.left >= 0 &&
        rect.right <= window.innerWidth &&
        rect.top >= 0 &&
        rect.bottom <= window.innerHeight,
      noHorizontalScroll:
        dialog.scrollWidth <= dialog.clientWidth &&
        body.scrollWidth <= body.clientWidth,
      noPageScroll: document.documentElement.scrollHeight <= window.innerHeight,
      actionsVisible: [
        'environment-close',
        'environment-save',
        'environment-remove',
      ].every(visible),
      bodyUsable: body.clientHeight >= 64,
    };
  });
}
async function themeContrast() {
  return evaluate(() => {
    const color = css => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d', {willReadFrequently: true});
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data]
        .slice(0, 3)
        .map(channel => channel / 255);
    };
    const luminance = css =>
      color(css)
        .map(value =>
          value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
        )
        .reduce(
          (sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index],
          0,
        );
    const contrast = (a, b) => {
      const [high, low] = [luminance(a), luminance(b)].sort((a, b) => b - a);
      return (high + 0.05) / (low + 0.05);
    };
    const panel = getComputedStyle(
      document.getElementById('environment-dialog'),
    ).backgroundColor;
    return [
      'environment-variable',
      'environment-value',
      'environment-value-note',
      'environment-show',
      'environment-save',
      'environment-close',
      'environment-remove',
    ]
      .filter(id => !document.getElementById(id).hidden)
      .map(id => {
        const style = getComputedStyle(document.getElementById(id));
        const background =
          style.backgroundColor === 'rgba(0, 0, 0, 0)'
            ? panel
            : style.backgroundColor;
        return {
          id,
          text: contrast(style.color, background),
          boundary: contrast(style.borderTopColor, panel),
        };
      });
  });
}

async function main() {
  if (screenshots) mkdirSync(screenshots, {recursive: true});
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
  browser.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });
  handle('pidev:get-state', () => hub);
  handle('pidev:recent-projects', () => []);
  handle('varisdev:app-themes', () => ({themes: [], errors: []}));
  handle('varisdev:get-update-status', () => ({
    phase: 'idle',
    currentVersion: '1.0.0',
    restartRequired: false,
  }));
  handle('varisdev:get-agent-notice', () => ({acknowledged: true}));
  handle('pidev:session-features', () => ({
    commands: [],
    models: [],
    tools: [],
    diagnostics: [],
    thinkingLevel: 'off',
    thinkingLevels: ['off'],
  }));
  handle('varisdev:get-environment', async () => {
    if (nextLoad) {
      const pending = nextLoad;
      nextLoad = undefined;
      await pending;
    }
    if (loadError) throw new Error(loadError);
    return state();
  });
  handle('varisdev:save-environment', async (name, value) => {
    writes.push({name, value});
    assert.equal(typeof name, 'string');
    assert.ok(typeof value === 'string' || value === null);
    if (nextSave) {
      const pending = nextSave;
      nextSave = undefined;
      await pending;
    }
    if (saveError) {
      if (saveFailureState) return {...state(), error: saveError};
      throw new Error(saveError);
    }
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name))
      return {...state(), error: 'Invalid variable name.'};
    if (value === null) delete saved[name];
    else saved[name] = value;
    writeFileSync(file, JSON.stringify(saved));
    return state();
  });
  await browser.loadFile(
    resolve(__dirname, '../../assets/dashboard/index.html'),
  );
  await waitFor(() => !document.getElementById('factory-workspace').hidden);
  assert.equal(existsSync(file), false);
  await open();
  await select('OPENAI_API_KEY');
  assert.deepEqual(await presentation(), {
    type: 'password',
    value: environment.OPENAI_API_KEY,
    gray: true,
    note: true,
    toggle: true,
    remove: false,
  });
  assert.equal(
    await evaluate(() =>
      document.getElementById('app-menu-panel').matches(':popover-open'),
    ),
    false,
  );
  assert.equal(
    await evaluate(() =>
      document.getElementById('environment-value-note').textContent.trim(),
    ),
    'Value read from environment variables.',
  );
  assert.equal(existsSync(file), false);
  assert.equal(writes.length, 0);
  await click('environment-show');
  assert.equal((await presentation()).type, 'text');
  await select('LLAMA_BASE_URL');
  assert.equal(
    (await presentation()).type,
    'password',
    'nonsecret values also start hidden',
  );
  await click('environment-show');
  assert.equal((await presentation()).type, 'text');
  await close();
  assert.equal(
    await evaluate(() => document.getElementById('environment-value').value),
    '',
  );
  await open();
  assert.equal((await presentation()).type, 'password');
  report.cases.push(
    'every environment value is masked by default and on selection/open; reading does not save',
  );

  await select('OPENAI_API_KEY');
  await input('environment-value', 'fixture-edited-private-key');
  assert.deepEqual(await presentation(), {
    type: 'password',
    value: 'fixture-edited-private-key',
    gray: false,
    note: false,
    toggle: true,
    remove: false,
  });
  await save();
  assert.deepEqual(writes.at(-1), {
    name: 'OPENAI_API_KEY',
    value: 'fixture-edited-private-key',
  });
  assert.deepEqual(JSON.parse(readFileSync(file)), {
    OPENAI_API_KEY: 'fixture-edited-private-key',
  });
  assert.equal((await presentation()).remove, true);
  await click('environment-show');
  assert.equal((await presentation()).type, 'text');
  await close();
  await open();
  await select('OPENAI_API_KEY');
  assert.deepEqual(await presentation(), {
    type: 'password',
    value: 'fixture-edited-private-key',
    gray: false,
    note: false,
    toggle: true,
    remove: true,
  });
  await click('environment-remove');
  await waitFor(
    () =>
      document.getElementById('environment-status').textContent ===
      'Saved value removed.',
  );
  assert.deepEqual(writes.at(-1), {name: 'OPENAI_API_KEY', value: null});
  assert.deepEqual(JSON.parse(readFileSync(file)), {});
  assert.deepEqual(await presentation(), {
    type: 'password',
    value: environment.OPENAI_API_KEY,
    gray: true,
    note: true,
    toggle: true,
    remove: false,
  });
  report.cases.push(
    'saving writes only the edited variable; null removes it and restores the effective environment value',
  );

  await select('LLAMA_BASE_URL');
  await input('environment-value', 'http://localhost:9000/v1');
  await save();
  assert.equal(
    (await presentation()).type,
    'password',
    'saved nonsecret remains hidden',
  );
  await click('environment-show');
  assert.equal((await presentation()).type, 'text');
  await select('OPENAI_API_KEY');
  await select('LLAMA_BASE_URL');
  assert.equal((await presentation()).type, 'password');
  const selectors = await evaluate(() =>
    [...document.getElementById('environment-variable').options].map(
      option => option.textContent,
    ),
  );
  assert.ok(
    selectors.includes('OPENAI_BASE_URL'),
    'supported suggestion present',
  );
  assert.ok(
    selectors.includes('PATH'),
    'effective name outside suggestions selectable',
  );
  assert.ok(
    selectors.every(
      text => !text.includes('fixture-') && !text.includes('localhost:'),
    ),
    'selector only shows names',
  );
  await select('OPENAI_BASE_URL');
  assert.equal((await presentation()).value, '');
  await select('');
  await input('environment-name', 'CUSTOM_SECRET');
  await input('environment-value', 'fixture-custom-private-secret');
  await save();
  assert.deepEqual(writes.at(-1), {
    name: 'CUSTOM_SECRET',
    value: 'fixture-custom-private-secret',
  });
  assert.equal(
    await evaluate(
      () =>
        document.body.textContent.includes('fixture-custom-private-secret') ||
        JSON.stringify(localStorage).includes('fixture-custom-private-secret'),
    ),
    false,
  );
  await input('environment-value', '');
  await save();
  assert.equal(saved.CUSTOM_SECRET, '');
  assert.equal((await presentation()).gray, false);
  report.cases.push(
    'saved ordinary values are masked; suggestions, custom names, and explicit empty strings work without dumping values',
  );

  await input('environment-value', 'retry-draft');
  for (const returnedError of [false, true]) {
    saveError = 'Cannot write environment.json.';
    saveFailureState = returnedError;
    await click('environment-save');
    await waitFor(() => !document.getElementById('environment-error').hidden);
    assert.equal((await presentation()).value, 'retry-draft');
    assert.equal(saved.CUSTOM_SECRET, '');
    assert.equal(
      await evaluate(() => document.getElementById('environment-dialog').open),
      true,
    );
  }
  saveError = '';
  await save();
  assert.equal(saved.CUSTOM_SECRET, 'retry-draft');
  await select('');
  await input('environment-name', 'INVALID NAME');
  await input('environment-value', 'invalid-draft');
  await click('environment-save');
  await waitFor(
    () =>
      document.getElementById('environment-error').textContent ===
      'Invalid variable name.',
  );
  assert.equal((await presentation()).value, 'invalid-draft');
  const beforeCancel = writes.length;
  await escape();
  await waitFor(() => !document.getElementById('environment-dialog').open);
  assert.equal(writes.length, beforeCancel);
  assert.equal(
    await evaluate(() => document.activeElement.id),
    'app-menu-button',
  );
  assert.equal(
    await evaluate(() => document.getElementById('environment-value').value),
    '',
  );
  report.cases.push(
    'backend validation and thrown/returned save errors preserve drafts; Escape discards unsaved input',
  );

  loadError = 'Cannot read environment.json.';
  await open(false);
  await waitFor(() => !document.getElementById('environment-error').hidden);
  assert.equal(
    await evaluate(() => document.getElementById('environment-save').disabled),
    true,
  );
  loadError = '';
  await click('environment-retry');
  await waitFor(
    () => !document.getElementById('environment-variable').disabled,
  );
  await close();
  stateError = 'One startup value could not be read.';
  await open();
  assert.equal(
    await evaluate(
      () => document.getElementById('environment-error').textContent,
    ),
    stateError,
  );
  stateError = '';
  await close();
  nextLoad = new Promise(resolve => {
    releaseLoad = resolve;
  });
  await open(false);
  await waitFor(
    () =>
      document.getElementById('environment-status').textContent === 'Loading…',
  );
  await close();
  releaseLoad();
  await open();
  assert.equal(
    await evaluate(() => document.getElementById('environment-error').hidden),
    true,
  );
  await select('LLAMA_BASE_URL');
  await input('environment-value', 'http://localhost:9001/v1');
  nextSave = new Promise(resolve => {
    releaseSave = resolve;
  });
  await click('environment-save');
  await waitFor(
    () =>
      document.getElementById('environment-status').textContent === 'Saving…',
  );
  await escape();
  assert.deepEqual(
    await evaluate(() => ({
      open: document.getElementById('environment-dialog').open,
      disabled: document.getElementById('environment-close').disabled,
      status: document.getElementById('environment-status').textContent,
    })),
    {open: true, disabled: true, status: 'Saving…'},
  );
  releaseSave();
  await waitFor(
    () =>
      document.getElementById('environment-status').textContent === 'Saved.',
  );
  report.cases.push(
    'load failure retries; late loads cannot refill a closed dialog; pending save blocks duplicate writes and cancellation',
  );

  const themes = await evaluate(() =>
    [...document.getElementById('factory-theme').options].map(
      option => option.value,
    ),
  );
  assert.ok(themes.length >= 6);
  await select('PATH');
  for (const theme of themes) {
    await evaluate(theme => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    const ratios = await themeContrast();
    report.contrast.push({theme, ratios});
    for (const ratio of ratios) {
      assert.ok(ratio.text >= 4.5, `${theme} ${ratio.id} text ${ratio.text}`);
      if (ratio.id !== 'environment-value-note')
        assert.ok(
          ratio.boundary >= 3,
          `${theme} ${ratio.id} boundary ${ratio.boundary}`,
        );
    }
    await capture(`${theme}-environment`);
    await select('LLAMA_BASE_URL');
    await click('environment-show');
    await capture(`${theme}-saved-shown`);
    await select('PATH');
  }
  report.cases.push(
    'all shipped themes keep environment text and control boundaries legible; regular screenshots captured',
  );

  for (const {label, width, height, zoom} of [
    {label: 'compact-125', width: 440, height: 600, zoom: 1.25},
    {label: 'short-150', width: 800, height: 520, zoom: 1.5},
  ]) {
    browser.setContentSize(width, height);
    browser.webContents.setZoomFactor(zoom);
    await select('LLAMA_BASE_URL');
    for (const theme of themes) {
      await evaluate(theme => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      assert.deepEqual(
        await geometry(),
        {
          fits: true,
          noHorizontalScroll: true,
          noPageScroll: true,
          actionsVisible: true,
          bodyUsable: true,
        },
        `${theme} ${label}`,
      );
      await capture(`${theme}-${label}`);
    }
    await select('');
    await input(
      'environment-name',
      'CUSTOM_ENVIRONMENT_VARIABLE_WITH_A_LONG_NAME',
    );
    await input('environment-value', 'fixture-custom-value');
    await evaluate(() => {
      document.querySelector('.environment-body').scrollTop = 10000;
    });
    await capture(`custom-${label}`);
    const visible = await evaluate(() => {
      const body = document
        .querySelector('.environment-body')
        .getBoundingClientRect();
      const value = document
        .getElementById('environment-value')
        .getBoundingClientRect();
      return (
        value.left >= body.left - 1 &&
        value.right <= body.right + 1 &&
        value.top >= body.top - 1 &&
        value.bottom <= body.bottom + 1
      );
    });
    assert.equal(
      visible,
      true,
      'custom value reachable with internal scrolling',
    );
  }
  report.cases.push(
    'compact and zoomed layouts keep actions visible, avoid page scrolling, and allow internal field scrolling',
  );
  await close();
  assert.equal(errors.length, 0, errors.join('\n'));
  report.cases.push(
    'dashboard integration leaves no renderer errors and clears values when closed',
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
