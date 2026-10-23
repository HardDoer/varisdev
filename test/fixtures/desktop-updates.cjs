/* global process, __dirname, document, window, setTimeout, getComputedStyle */
const assert = require('node:assert/strict');
const {mkdirSync, writeFileSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {app, BrowserWindow, ipcMain} = require('electron');
const [directory, reportPath, screenshotDirectory] = process.argv.slice(2);
const report = {cases: []};
let browser;
let status = {phase: 'idle', currentVersion: '0.85.1', restartRequired: false};
let installs = 0;
let restarts = 0;
let updatePending;
let checkPending;
let initialPending;
let installFails = true;
const initialStatus = new Promise(resolve => {
  initialPending = resolve;
});
let restartBlocked = true;
app.setPath('userData', join(directory, 'profile'));
app.setPath('sessionData', join(directory, 'session'));
function broadcast(next) {
  status = {...status, ...next};
  browser.webContents.send('varisdev:update-status', status);
}
function handle(channel, action) {
  ipcMain.handle(channel, async event => {
    assert.equal(event.sender, browser.webContents);
    assert.equal(event.senderFrame, browser.webContents.mainFrame);
    try {
      return {ok: true, value: await action()};
    } catch (error) {
      return {ok: false, error: error.message};
    }
  });
}
const evaluate = fn =>
  browser.webContents.executeJavaScript(`(${fn.toString()})()`);
async function waitFor(fn) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate(fn)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${fn}`);
}
async function captureDialog(name) {
  if (!screenshotDirectory) return;
  mkdirSync(screenshotDirectory, {recursive: true});
  await browser.webContents.executeJavaScript(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );
  const bounds = await evaluate(() => {
    const rect = document
      .getElementById('updates-dialog')
      .getBoundingClientRect();
    return {
      x: Math.floor(rect.x),
      y: Math.floor(rect.y),
      width: Math.ceil(rect.width),
      height: Math.ceil(rect.height),
    };
  });
  const image = await browser.webContents.capturePage(bounds);
  writeFileSync(join(screenshotDirectory, `${name}.png`), image.toPNG());
}
async function main() {
  await app.whenReady();
  browser = new BrowserWindow({
    show: false,
    width: 1300,
    height: 900,
    webPreferences: {
      preload: resolve(__dirname, '../../assets/desktop/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  handle('pidev:get-state', () => ({sessions: [], launchCwd: directory}));
  handle('pidev:recent-projects', () => []);
  handle('varisdev:app-themes', () => ({themes: [], errors: []}));
  handle('varisdev:get-update-status', () => initialStatus);
  handle('varisdev:check-updates', async () => {
    broadcast({phase: 'checking', error: undefined, progress: undefined});
    await new Promise(resolve => {
      checkPending = resolve;
    });
    broadcast({phase: 'idle', checkedAt: new Date().toISOString()});
    return status;
  });
  handle('varisdev:install-update', async () => {
    installs++;
    broadcast({phase: 'updating', error: undefined, progress: undefined});
    await new Promise(resolve => {
      updatePending = resolve;
    });
    if (installFails) throw new Error('Download interrupted.');
    broadcast({phase: 'ready', restartRequired: true, progress: undefined});
    return status;
  });
  handle('varisdev:restart-update', () => {
    restarts++;
    if (restartBlocked)
      throw new Error(
        'Wait for parent sessions and agents to finish, then retry restarting.',
      );
  });
  await browser.loadFile(
    resolve(__dirname, '../../assets/dashboard/index.html'),
  );
  await waitFor(
    () =>
      document.getElementById('updates-message').textContent ===
      'Loading update status…',
  );
  browser.webContents.send('varisdev:show-updates');
  await waitFor(() => document.getElementById('updates-dialog').open);
  assert.deepEqual(
    await evaluate(() => ({
      visible: !document.getElementById('updates-progress').hidden,
      indeterminate: document
        .getElementById('updates-progress-bar')
        .matches(':indeterminate'),
      busy: document.getElementById('updates-dialog').getAttribute('aria-busy'),
    })),
    {visible: true, indeterminate: true, busy: 'true'},
  );
  const position = await evaluate(
    () =>
      getComputedStyle(document.getElementById('updates-progress-bar'))
        .backgroundPosition,
  );
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.notEqual(
    await evaluate(
      () =>
        getComputedStyle(document.getElementById('updates-progress-bar'))
          .backgroundPosition,
    ),
    position,
  );
  await captureDialog('initial');
  initialPending(status);
  await waitFor(() => document.getElementById('updates-progress').hidden);
  assert.equal(
    await evaluate(() => document.getElementById('updates-button').hidden),
    true,
  );
  browser.webContents.send('varisdev:show-updates');
  await waitFor(() => document.getElementById('updates-dialog').open);
  await evaluate(() => document.getElementById('updates-check').click());
  await waitFor(
    () =>
      document.getElementById('updates-message').textContent ===
      'Checking for updates…',
  );
  assert.equal(
    await evaluate(
      () =>
        !document.getElementById('updates-progress').hidden &&
        document
          .getElementById('updates-progress-bar')
          .matches(':indeterminate'),
    ),
    true,
  );
  checkPending();
  await waitFor(
    () =>
      document.getElementById('updates-message').textContent ===
      'VarisDev is up to date.',
  );
  assert.equal(
    await evaluate(() => document.getElementById('updates-progress').hidden),
    true,
  );
  report.cases.push(
    'initial status loading and checking show indeterminate progress',
  );
  assert.equal(
    await evaluate(() => document.getElementById('updates-button').hidden),
    true,
  );
  report.cases.push('menu checks updates with no header badge');

  broadcast({phase: 'available', latestVersion: '0.86.0'});
  await waitFor(
    () =>
      document.getElementById('updates-button').textContent ===
      'Updates available',
  );
  await evaluate(() => {
    document.getElementById('updates-close').click();
    document.getElementById('updates-button').click();
    document.getElementById('updates-action').click();
    document.getElementById('updates-action').click();
  });
  await waitFor(
    () =>
      document.getElementById('updates-button').textContent ===
      'Updating VarisDev…',
  );
  assert.equal(installs, 1);
  assert.equal(
    await evaluate(() => document.getElementById('updates-action').disabled),
    true,
  );
  assert.equal(
    await evaluate(() => document.getElementById('updates-check').disabled),
    true,
  );
  assert.equal(
    await evaluate(
      () =>
        !document.getElementById('updates-progress').hidden &&
        document
          .getElementById('updates-progress-bar')
          .matches(':indeterminate'),
    ),
    true,
  );
  broadcast({
    progress: {stage: 'downloading', transferredBytes: 4096, totalBytes: 10240},
  });
  await waitFor(
    () => document.getElementById('updates-progress-bar').value === 40,
  );
  assert.equal(
    await evaluate(
      () => document.getElementById('updates-progress-detail').textContent,
    ),
    '40% · 4 KB of 10 KB',
  );
  assert.equal(
    await evaluate(
      () => document.getElementById('updates-message').textContent,
    ),
    'Downloading update…',
  );
  if (screenshotDirectory) {
    const themes = await evaluate(async () =>
      (await import('./themes.js')).THEMES.map(theme => theme.id),
    );
    for (const theme of themes) {
      await browser.webContents.executeJavaScript(
        `document.getElementById('factory-theme').value = ${JSON.stringify(theme)}; document.getElementById('factory-theme').dispatchEvent(new Event('change'));`,
      );
      await captureDialog(theme);
    }
    browser.setContentSize(640, 480);
    browser.webContents.setZoomFactor(1.5);
    await new Promise(resolve => setTimeout(resolve, 100));
    const compact = await browser.webContents.capturePage();
    writeFileSync(join(screenshotDirectory, 'compact.png'), compact.toPNG());
    browser.webContents.setZoomFactor(1);
    browser.setContentSize(1300, 900);
  }
  broadcast({progress: {stage: 'downloading', transferredBytes: 8192}});
  await waitFor(() =>
    document.getElementById('updates-progress-bar').matches(':indeterminate'),
  );
  assert.equal(
    await evaluate(
      () => document.getElementById('updates-progress-detail').textContent,
    ),
    '8 KB downloaded',
  );
  broadcast({progress: {stage: 'installing'}});
  await waitFor(
    () =>
      document.getElementById('updates-message').textContent ===
      'Installing update…',
  );
  assert.equal(
    await evaluate(
      () => document.getElementById('updates-progress-detail').hidden,
    ),
    true,
  );
  await captureDialog('installing');
  updatePending();
  await waitFor(
    () =>
      document.getElementById('updates-action').textContent === 'Retry update',
  );
  assert.equal(
    await evaluate(() => document.getElementById('updates-progress').hidden),
    true,
  );
  assert.equal(
    await evaluate(() => document.getElementById('updates-error').textContent),
    'Download interrupted.',
  );
  installFails = false;
  await evaluate(() => document.getElementById('updates-action').click());
  await waitFor(
    () =>
      document.getElementById('updates-button').textContent ===
      'Updating VarisDev…',
  );
  assert.equal(installs, 2);
  updatePending();
  await waitFor(
    () =>
      document.getElementById('updates-button').textContent ===
      'Restart to finish update',
  );
  await waitFor(() => document.getElementById('updates-progress').hidden);
  await evaluate(() => document.getElementById('updates-action').click());
  await waitFor(() => !document.getElementById('updates-error').hidden);
  assert.equal(restarts, 1);
  assert.match(
    await evaluate(() => document.getElementById('updates-error').textContent),
    /Wait for parent sessions/,
  );
  assert.equal(
    await evaluate(() => document.getElementById('updates-action').disabled),
    false,
  );
  restartBlocked = false;
  await evaluate(() => document.getElementById('updates-action').click());
  await waitFor(() => document.getElementById('updates-error').hidden);
  assert.equal(restarts, 2);
  report.cases.push(
    'update progress, duplicate clicks, restart blocking and retry use production IPC',
  );

  await evaluate(async () => {
    const {createDraftStore} = await import('./draft-storage.js');
    window.fixtureDraftStore = createDraftStore('fixture-recovery', {
      validate: () => true,
      onError: () => {},
    });
    window.originalSetItem = window.Storage.prototype.setItem;
    window.Storage.prototype.setItem = function (key, value) {
      if (key === 'fixture-recovery') throw new Error('Storage unavailable');
      return window.originalSetItem.call(this, key, value);
    };
    window.fixtureDraftStore.save('draft', 'Retain my draft');
    document.getElementById('updates-action').click();
  });
  await waitFor(() =>
    document
      .getElementById('updates-error')
      .textContent.includes('Unsaved drafts'),
  );
  assert.equal(
    restarts,
    2,
    'Failed draft persistence must not restart the app',
  );
  await evaluate(() => {
    window.Storage.prototype.setItem = window.originalSetItem;
    document.getElementById('updates-action').click();
  });
  await waitFor(() => document.getElementById('updates-error').hidden);
  assert.equal(restarts, 3);
  assert.match(
    await evaluate(() => window.localStorage.getItem('fixture-recovery')),
    /Retain my draft/,
  );
  await evaluate(() => window.fixtureDraftStore.save('draft', undefined));
  report.cases.push(
    'restart waits for draft recovery storage and retries without losing text',
  );

  broadcast({
    phase: 'error',
    restartRequired: false,
    error: 'The update server is unavailable.',
  });
  await waitFor(
    () =>
      document.getElementById('updates-error').textContent ===
      'The update server is unavailable.',
  );
  assert.equal(
    await evaluate(() => document.getElementById('updates-button').hidden),
    false,
  );
  assert.equal(
    await evaluate(() => document.getElementById('updates-action').textContent),
    'Retry update',
  );
  await evaluate(() => document.getElementById('updates-check').click());
  await waitFor(() => document.getElementById('updates-error').hidden);
  checkPending();
  await waitFor(() => document.getElementById('updates-progress').hidden);
  assert.equal(
    await evaluate(() => document.getElementById('updates-button').hidden),
    true,
  );
  assert.doesNotMatch(
    await evaluate(() => document.getElementById('updates-dialog').textContent),
    /\bPi\b|0\.85|0\.86/,
  );
  report.cases.push('offline errors are visible and checks remain retryable');

  const callbacks = await evaluate(async () => {
    let calls = 0;
    const remove = window.pidev.onUpdateStatus(() => calls++);
    remove();
    let rejected = false;
    try {
      window.pidev.onUpdateStatus(null);
    } catch {
      rejected = true;
    }
    window.updateCallbackCount = () => calls;
    return {rejected};
  });
  assert.equal(callbacks.rejected, true);
  broadcast({phase: 'available'});
  await waitFor(
    () =>
      document.getElementById('updates-button').textContent ===
      'Updates available',
  );
  assert.equal(await evaluate(() => window.updateCallbackCount()), 0);
  report.cases.push('preload validates subscriptions and removes listeners');
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
