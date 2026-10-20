/* global process, __dirname, setTimeout */
const {app, BrowserWindow, ipcMain} = require('electron');
const assert = require('node:assert/strict');
const {writeFileSync, mkdirSync} = require('node:fs');
const {resolve, join} = require('node:path');
const {pathToFileURL} = require('node:url');
const openedFiles = [];
const [profile, reportPath] = process.argv.slice(2);
app.setPath('userData', profile);
let browser;
let terminals;
const report = {cases: []};
const calls = [];
let fail = false;
const closedSessions = new Set();
const openSessions = () =>
  ['first', 'second'].filter(name => !closedSessions.has(name));
const projectDirectory = name =>
  join(profile, name === 'first' ? "project's files & $work" : name);
for (const name of ['first', 'second']) mkdirSync(projectDirectory(name));
const snapshot = id => ({
  sessions: openSessions().map(name => ({
    session: {
      id: name,
      name,
      cwd: projectDirectory(name),
      status: 'idle',
      owned: true,
      controllable: true,
      updatedAt: new Date().toISOString(),
    },
    agents: [],
    events: [],
    changes: [],
    conversation: [
      {
        id: 'reply',
        role: 'assistant',
        at: new Date().toISOString(),
        text: `[Play%20Instant%20Action.command](${pathToFileURL(join(profile, 'Play Instant Action.command')).href})`,
      },
      {
        id: 'command',
        role: 'tool',
        toolName: 'bash',
        at: new Date().toISOString(),
        input: '{"command":"pwd"}',
        text: 'Output\n'.repeat(100),
        status: 'completed',
      },
    ],
    queue: {steering: [], followUp: []},
  })),
  selectedSessionId: id,
  launchCwd: profile,
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
const evaluate = source => browser.webContents.executeJavaScript(source);
async function until(source) {
  for (let i = 0; i < 200; i++) {
    if (await evaluate(source)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out: ' + source);
}
app
  .whenReady()
  .then(async () => {
    const {DesktopTerminals} = await import(
      pathToFileURL(
        resolve(__dirname, '../../desktop/build/src/desktop/terminal.js'),
      ).href
    );
    terminals = new DesktopTerminals(event =>
      browser.webContents.send('pidev:terminal', event),
    );
    handle('pidev:get-state', () => snapshot('first'));
    handle('pidev:recent-projects', () => []);
    handle('pidev:open-file', (id, path) => openedFiles.push([id, path]));
    handle('varisdev:get-update-status', () => ({
      phase: 'idle',
      currentVersion: '',
      restartRequired: false,
    }));
    handle('pidev:open-terminal', id => {
      calls.push(id);
      if (fail) throw new Error('Shell could not start.');
      return terminals.open(id, projectDirectory(id));
    });
    handle('pidev:terminal-write', (id, data) => terminals.write(id, data));
    handle('pidev:terminal-resize', (id, cols, rows) =>
      terminals.resize(id, cols, rows),
    );
    handle('pidev:terminal-close', id => terminals.close(id));
    handle('pidev:close-session', id => {
      closedSessions.add(id);
      terminals.close(id);
      browser.webContents.send('pidev:snapshot', snapshot());
    });
    handle('pidev:prompt-session', () => {
      throw new Error('Terminal input must not submit the draft');
    });
    browser = new BrowserWindow({
      width: 1600,
      height: 1000,
      show: false,
      webPreferences: {
        preload: resolve(__dirname, '../../assets/desktop/preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    await browser.loadFile(
      resolve(__dirname, '../../assets/dashboard/index.html'),
    );
    await until("!document.getElementById('parent-controls').hidden");
    await evaluate(
      "document.getElementById('parent-prompt').value = 'Keep this draft'; document.getElementById('parent-prompt').dispatchEvent(new Event('input')); document.getElementById('terminal-tab').click()",
    );
    await until(
      "!document.getElementById('terminal-close').disabled && !!document.querySelector('.project-terminal .xterm')",
    );
    assert.deepEqual(calls, ['first']);
    assert.equal(
      await evaluate("document.getElementById('prompt-panel').hidden"),
      true,
    );
    assert.equal(
      await evaluate("document.getElementById('terminal-panel').hidden"),
      false,
    );
    // Check the project launch through Electron and the real Windows PTY.
    // Split markers ensure echoed commands cannot satisfy the output checks.
    if (process.platform === 'win32') terminals.resize('first', 93, 31);
    await browser.webContents.insertText(
      process.platform === 'win32'
        ? `if ((Get-Location).ProviderPath -eq '${projectDirectory('first').replaceAll("'", "''")}') { 'cwd-' + 'ready' } else { throw 'Wrong project directory' }; if ($Host.UI.RawUI.WindowSize.Width -eq 93 -and $Host.UI.RawUI.WindowSize.Height -eq 31) { 'size-' + 'ready' } else { throw 'Wrong terminal size' }; if (Get-Module PSReadLine) { 'embedded-' + 'ready' } else { throw 'PSReadLine unavailable' }`
        : "printf 'embedded-%s\\n' 'ready'",
    );
    browser.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Return'});
    browser.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Return'});
    await until(
      "document.querySelector('.project-terminal').textContent.includes('embedded-ready')",
    );
    if (process.platform === 'win32') {
      const output = (await terminals.open('first', projectDirectory('first')))
        .data;
      assert.match(output, /cwd-ready/);
      assert.match(output, /size-ready/);
      assert.doesNotMatch(
        output,
        /Cannot load PSReadLine|Modules_InsufficientPowerShellVersion/i,
      );
    }
    await evaluate("document.getElementById('prompt-tab').click()");
    assert.equal(await evaluate('document.activeElement.id'), 'parent-prompt');
    assert.equal(
      await evaluate("document.getElementById('parent-prompt').value"),
      'Keep this draft',
    );
    await evaluate("document.getElementById('terminal-tab').click()");
    assert.deepEqual(calls, ['first']);
    assert.equal(
      await evaluate(
        "document.querySelector('.project-terminal').textContent.includes('embedded-ready')",
      ),
      true,
    );
    report.cases.push(
      'Native shell input and output stay inside the composer and preserve the prompt',
    );
    fail = true;
    await evaluate(
      "[...document.querySelectorAll('#parents button')].find(button => button.textContent.includes('second')).click()",
    );
    await until("!document.getElementById('terminal-error').hidden");
    assert.deepEqual(calls, ['first', 'second']);
    assert.match(
      await evaluate("document.getElementById('terminal-error').textContent"),
      /Shell could not start/,
    );
    fail = false;
    await evaluate("document.getElementById('terminal-tab').click()");
    await until(
      "!document.getElementById('terminal-close').disabled && document.getElementById('terminal-error').hidden",
    );
    assert.deepEqual(calls, ['first', 'second', 'second']);
    await browser.webContents.insertText(
      process.platform === 'win32'
        ? "'second-' + 'ready'"
        : "printf 'second-%s\\n' 'ready'",
    );
    browser.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Return'});
    browser.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Return'});
    await until(
      "document.querySelector('.project-terminal:not([hidden])').textContent.includes('second-ready')",
    );
    assert.doesNotMatch(
      (await terminals.open('first', projectDirectory('first'))).data,
      /second-ready/,
    );
    await evaluate(
      "[...document.querySelectorAll('#parents button')].find(button => button.textContent.includes('first')).click()",
    );
    await until(
      "document.getElementById('factory-title').textContent.includes('first')",
    );
    assert.equal(
      await evaluate(
        "document.querySelector('.project-terminal:not([hidden])').textContent.includes('embedded-ready')",
      ),
      true,
    );
    report.cases.push(
      'Shells follow the selected project and recover from startup errors',
    );
    await evaluate("document.getElementById('terminal-close').click()");
    await until("document.getElementById('terminal-panel').hidden");
    assert.throws(() => terminals.write('first', 'pwd\r'), /Open a terminal/);
    report.cases.push('Closing the embedded terminal closes its shell');
    assert.equal(
      await evaluate("document.querySelector('#conversation a').textContent"),
      'Play Instant Action.command',
    );
    await evaluate("document.querySelector('#conversation a').click()");
    assert.deepEqual(
      openedFiles.map(([id, path]) => [id, resolve(path)]),
      [['first', join(profile, 'Play Instant Action.command')]],
    );
    assert.equal(
      await evaluate("document.querySelector('#conversation details').open"),
      false,
    );
    await evaluate("document.querySelector('#conversation summary').click()");
    browser.webContents.send('pidev:snapshot', snapshot('first'));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(
      await evaluate("document.querySelector('#conversation details').open"),
      true,
    );
    await evaluate("document.querySelector('#conversation summary').click()");
    browser.webContents.send('pidev:snapshot', snapshot('first'));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(
      await evaluate("document.querySelector('#conversation details').open"),
      false,
    );
    report.cases.push(
      'File links display decoded names and command disclosures preserve user choices',
    );
    await evaluate("document.getElementById('terminal-tab').click()");
    await until("!document.getElementById('terminal-close').disabled");
    assert.equal(
      await evaluate("document.querySelectorAll('.project-terminal').length"),
      2,
    );
    await evaluate("document.getElementById('close-parent-session').click()");
    await until("document.querySelectorAll('#parents button').length === 1");
    assert.throws(() => terminals.write('first', 'pwd\r'), /Open a terminal/);
    assert.equal(
      await evaluate("document.querySelectorAll('.project-terminal').length"),
      1,
    );
    assert.equal(
      await evaluate("document.getElementById('prompt-panel').hidden"),
      false,
    );
    await evaluate("document.getElementById('close-session').click()");
    await until("!document.getElementById('welcome').hidden");
    assert.throws(() => terminals.write('second', 'pwd\r'), /Open a terminal/);
    assert.equal(
      await evaluate("document.querySelectorAll('.project-terminal').length"),
      0,
    );
    report.cases.push(
      'Closing parents removes their terminal views and shells',
    );
  })
  .catch(error => {
    report.error = error.stack;
    process.exitCode = 1;
  })
  .finally(() => {
    terminals?.dispose();
    writeFileSync(reportPath, JSON.stringify(report));
    app.quit();
  });
