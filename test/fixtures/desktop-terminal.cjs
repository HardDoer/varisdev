/* global document, window */
const {app, BrowserWindow, ipcMain} = require('electron');
const assert = require('node:assert/strict');
const {writeFileSync} = require('node:fs');
const {resolve} = require('node:path');
const [profile, reportPath] = process.argv.slice(2);
app.setPath('userData', profile);
let browser;
const report = {cases: []};
const calls = [];
let fail = false;
const snapshot = id => ({
  sessions: [
    {
      session: {
        id,
        name: id,
        cwd: '/projects/' + id,
        status: 'idle',
        owned: true,
        controllable: true,
        updatedAt: new Date().toISOString(),
      },
      agents: [],
      events: [],
      changes: [],
      conversation: [],
      queue: {steering: [], followUp: []},
    },
  ],
  selectedSessionId: id,
  launchCwd: '/projects/first',
});
function handle(channel, action) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return {ok: true, value: await action(...args)};
    } catch (error) {
      return {ok: false, error: error.message};
    }
  });
}
async function until(source) {
  for (let i = 0; i < 100; i++) {
    if (await browser.webContents.executeJavaScript(source)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out: ' + source);
}
app
  .whenReady()
  .then(async () => {
    handle('pidev:get-state', () => snapshot('first'));
    handle('varisdev:get-update-status', () => ({
      phase: 'idle',
      currentVersion: '',
      restartRequired: false,
    }));
    handle('pidev:open-terminal', id => {
      calls.push(id);
      if (fail) throw new Error('No terminal application was found.');
      return {name: 'Terminal'};
    });
    handle('pidev:prompt-session', () => {
      throw new Error('Opening a terminal must not submit the draft');
    });
    browser = new BrowserWindow({
      width: 1600,
      height: 1000,
      show: false,
      webPreferences: {
        preload: resolve(__dirname, '../../assets/desktop/preload.cjs'),
        contextIsolation: true,
        sandbox: true,
      },
    });
    await browser.loadFile(
      resolve(__dirname, '../../assets/dashboard/index.html'),
    );
    await until("!document.getElementById('parent-controls').hidden");
    await browser.webContents.executeJavaScript(
      "document.getElementById('parent-prompt').value = 'Keep this draft'; document.getElementById('parent-prompt').dispatchEvent(new Event('input')); document.getElementById('terminal-tab').click()",
    );
    await until("!document.getElementById('terminal-tab').disabled");
    assert.deepEqual(calls, ['first']);
    assert.equal(
      await browser.webContents.executeJavaScript(
        "document.getElementById('parent-prompt').value",
      ),
      'Keep this draft',
    );
    await browser.webContents.executeJavaScript(
      "document.getElementById('prompt-tab').click()",
    );
    assert.equal(
      await browser.webContents.executeJavaScript('document.activeElement.id'),
      'parent-prompt',
    );
    report.cases.push(
      'Terminal opens the selected project without submitting or discarding its draft',
    );
    browser.webContents.send('pidev:snapshot', snapshot('second'));
    await until(
      "document.getElementById('factory-title').textContent.includes('second')",
    );
    fail = true;
    await browser.webContents.executeJavaScript(
      "document.getElementById('terminal-tab').click()",
    );
    await until("!document.getElementById('terminal-error').hidden");
    assert.deepEqual(calls, ['first', 'second']);
    assert.match(
      await browser.webContents.executeJavaScript(
        "document.getElementById('terminal-error').textContent",
      ),
      /No terminal application/,
    );
    assert.equal(
      await browser.webContents.executeJavaScript(
        "document.getElementById('terminal-tab').disabled",
      ),
      false,
    );
    report.cases.push(
      'Terminal follows conversation selection and reports launch errors',
    );
  })
  .catch(error => {
    report.error = error.stack;
    process.exitCode = 1;
  })
  .finally(() => {
    writeFileSync(reportPath, JSON.stringify(report));
    app.quit();
  });
