/* global process, __dirname, setTimeout */
const {app, BrowserWindow, ipcMain} = require('electron');
const assert = require('node:assert/strict');
const {
  writeFileSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  unlinkSync,
} = require('node:fs');
const {resolve, join} = require('node:path');
const {pathToFileURL} = require('node:url');
const openedFiles = [];
const [profile, reportPath] = process.argv.slice(2);
app.setPath('userData', profile);
let browser;
let terminals;
let profiles;
let nextPty;
let listRequested;
const creates = [];
let failCreate = false;
let failClose = false;
let failDefault = false;
let failProfileLoad = false;
let failProfileSave = false;
let failProfileRemove = false;
let failBrowse = false;
let chosenExecutable;
const report = {cases: []};
const calls = [];
const terminalOutput = new Map();
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
const captureTerminals = () =>
  evaluate(`
      window.fixtureTerminals = [];
      const Terminal = window.Terminal;
      window.Terminal = class extends Terminal {
        constructor(options) {
          super(options);
          window.fixtureTerminal = this;
          window.fixtureTerminals.push(this);
        }
      };
      void 0;
    `);
async function until(source) {
  for (let i = 0; i < 200; i++) {
    const value = await evaluate(source);
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out: ' + source);
}
app
  .whenReady()
  .then(async () => {
    const {initializeEnvironment} = await import(
      pathToFileURL(
        resolve(__dirname, '../../desktop/build/src/runtime/environment.mjs'),
      ).href
    );
    await initializeEnvironment();
    const {DesktopTerminals} = await import(
      pathToFileURL(
        resolve(__dirname, '../../desktop/build/src/desktop/terminal.js'),
      ).href
    );
    const {DesktopTerminalProfiles} = await import(
      pathToFileURL(
        resolve(
          __dirname,
          '../../desktop/build/src/desktop/terminal-profiles.js',
        ),
      ).href
    );
    const {DesktopPreferences} = await import(
      pathToFileURL(
        resolve(__dirname, '../../desktop/build/src/desktop/preferences.js'),
      ).href
    );
    const restartedProfiles = () =>
      new DesktopTerminalProfiles(new DesktopPreferences(profile));
    profiles = restartedProfiles();
    const nativePtyPath = require.resolve('@lydell/node-pty', {
      paths: [resolve(__dirname, '../../desktop/build/src/desktop')],
    });
    terminals = new DesktopTerminals(
      event => {
        terminalOutput.set(
          event.sessionId,
          ((terminalOutput.get(event.sessionId) || '') + event.data).slice(
            -16384,
          ),
        );
        browser.webContents.send('pidev:terminal', event);
      },
      async () => {
        if (!nextPty) return import(pathToFileURL(nativePtyPath).href);
        const pending = nextPty;
        nextPty = undefined;
        pending.started();
        await pending.ready;
        return pending.module;
      },
      {profiles},
    );
    handle('pidev:get-state', () => snapshot('first'));
    handle('pidev:recent-projects', () => []);
    handle('pidev:open-file', (id, path) => openedFiles.push([id, path]));
    handle('varisdev:get-update-status', () => ({
      phase: 'idle',
      currentVersion: '',
      restartRequired: false,
    }));
    handle('pidev:terminal-profiles', () => {
      if (failProfileLoad) throw new Error('Terminal profiles could not load.');
      return profiles.get();
    });
    handle('pidev:save-terminal-profile', input => {
      if (failProfileSave) throw new Error('Terminal profile could not save.');
      return profiles.save(input);
    });
    handle('pidev:remove-terminal-profile', id => {
      if (failProfileRemove)
        throw new Error('Terminal profile could not remove.');
      return profiles.remove(id);
    });
    handle('pidev:choose-terminal-executable', () => {
      if (failBrowse) throw new Error('File chooser could not open.');
      return chosenExecutable;
    });
    handle('pidev:default-terminal-profile', id => {
      if (failDefault) throw new Error('Default shell could not be saved.');
      return profiles.setDefault(id);
    });
    handle('pidev:list-terminals', id => {
      listRequested?.();
      listRequested = undefined;
      return terminals.listReady(id);
    });
    handle('pidev:create-terminal', (id, profileId) => {
      if (failCreate) throw new Error('New shell could not start.');
      creates.push([id, profileId]);
      return terminals.create(id, projectDirectory(id), profileId);
    });
    handle('pidev:open-terminal', (id, terminalId) => {
      calls.push(id);
      if (fail) throw new Error('Shell could not start.');
      return terminals.open(id, projectDirectory(id), terminalId);
    });
    handle('pidev:terminal-write', (id, data) => terminals.write(id, data));
    handle('pidev:terminal-resize', (id, cols, rows) =>
      terminals.resize(id, cols, rows),
    );
    handle('pidev:terminal-close', id => {
      if (failClose) throw new Error('Shell could not close.');
      return terminals.close(id);
    });
    handle('pidev:close-session', id => {
      closedSessions.add(id);
      terminals.closeWorkspace(id);
      browser.webContents.send('pidev:snapshot', snapshot());
    });
    handle('pidev:prompt-session', () => {
      throw new Error('Terminal input must not submit the draft');
    });
    browser = new BrowserWindow({
      width: 1600,
      height: 1000,
      show: false,
      enableLargerThanScreen: true,
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
    await captureTerminals();
    await evaluate(
      "document.getElementById('parent-prompt').value = 'Keep this draft'; document.getElementById('parent-prompt').dispatchEvent(new Event('input')); document.getElementById('terminal-tab').click()",
    );
    await until(
      "document.getElementById('terminal-close') && !document.getElementById('terminal-new').disabled && !!document.querySelector('.project-terminal .xterm')",
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
    // Check the renderer's fitted size instead of racing its resize with a
    // separate manual PTY resize. Split markers exclude echoed commands.
    const terminalSize = await evaluate(`(async () => {
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {cols: window.fixtureTerminal.cols, rows: window.fixtureTerminal.rows};
    })()`);
    await browser.webContents.insertText(
      process.platform === 'win32'
        ? `if ((Get-Location).ProviderPath -eq '${projectDirectory('first').replaceAll("'", "''")}') { 'cwd-' + 'ready' } else { throw 'Wrong project directory' }; if ($Host.UI.RawUI.WindowSize.Width -eq ${terminalSize.cols} -and $Host.UI.RawUI.WindowSize.Height -eq ${terminalSize.rows}) { 'size-' + 'ready' } else { throw 'Wrong terminal size' }; if (Get-Module PSReadLine) { 'embedded-' + 'ready' } else { throw 'PSReadLine unavailable' }`
        : "printf 'embedded-%s\\n' 'ready'",
    );
    browser.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Return'});
    browser.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Return'});
    await until(
      "document.querySelector('.project-terminal').textContent.includes('embedded-ready')",
    );
    if (
      process.platform === 'win32' &&
      profiles.resolve().label === 'PowerShell 7'
    ) {
      terminals.write(
        'first',
        "Import-Module VarisDevFixture; Get-VarisDevFixtureValue; if ($env:PSModulePath.Split(';') -contains $env:VARISDEV_FIXTURE_MODULE_PATH) { 'module-path-' + 'ready' }\r",
      );
      await until(
        "document.querySelector('.project-terminal').textContent.includes('custom-module-ready') && document.querySelector('.project-terminal').textContent.includes('module-path-ready')",
      );
    }
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
    await browser.webContents.insertText(
      process.platform === 'win32'
        ? `git --version; git init --quiet; if ((git rev-parse --show-toplevel) -eq '${projectDirectory('first').replaceAll('\\', '/').replaceAll("'", "''")}') { 'git-project-' + 'ready' }; 'git-' + 'checked'`
        : "git --version; git init --quiet; test \"$(git rev-parse --show-toplevel)\" = \"$PWD\" && printf 'git-project-%s\\n' 'ready'; printf 'git-%s\\n' 'checked'",
    );
    browser.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Return'});
    browser.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Return'});
    await until(
      "document.querySelector('.project-terminal').textContent.includes('git-checked')",
    );
    const gitOutput = (await terminals.open('first', projectDirectory('first')))
      .data;
    assert.match(gitOutput, /git version \d+\./);
    assert.match(gitOutput, /git-project-ready/);
    report.cases.push(
      'Git runs inside the embedded terminal with the project as its working directory',
    );
    browser.showInactive();
    terminals.write(
      'first',
      process.platform === 'win32'
        ? "1..80 | ForEach-Object { Write-Output ('Scroll row ' + $_) }; 'bottom-' + 'visible'\r"
        : "i=0; while [ $i -lt 80 ]; do printf 'Scroll row %s\\n' $i; i=$((i+1)); done; printf 'bottom-%s\\n' 'visible'\r",
    );
    await until(
      "window.fixtureTerminal.buffer.active.baseY > 0 && document.querySelector('.project-terminal').textContent.includes('bottom-visible')",
    );
    for (const [width, height, zoom, terminalHeight] of [
      [1600, 1000, 1, 120],
      [1600, 1000, 1, 137],
      [1600, 1000, 1, 239],
      [1600, 1000, 1, 240],
      [1600, 1000, 1, 241],
      [1100, 760, 1.25, 121],
      [1100, 760, 1.5, 137],
    ]) {
      browser.setContentSize(width, height);
      await evaluate(`
        window.pidev.setZoom(${zoom});
        document.getElementById('terminal-sessions').style.height = '${terminalHeight}px';
      `);
      // Let the application's ResizeObserver and scheduled fit finish.
      await evaluate(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      );
      const bounds = await evaluate(`(() => {
        const host = document.getElementById('terminal-sessions').getBoundingClientRect();
        const screen = document.querySelector('.project-terminal .xterm-screen').getBoundingClientRect();
        return {host: host.toJSON(), screen: screen.toJSON()};
      })()`);
      assert.ok(
        bounds.screen.bottom <= bounds.host.bottom &&
          bounds.screen.right <= bounds.host.right,
        `Terminal rows must fit after resize to ${terminalHeight}px at ${zoom}: ${JSON.stringify(bounds)}`,
      );
      await evaluate(`
        window.fixtureTerminal.scrollToTop();
        new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      `);
      browser.webContents.sendInputEvent({
        type: 'mouseWheel',
        x: Math.round((bounds.screen.x + 30) * zoom),
        y: Math.round((bounds.screen.y + 30) * zoom),
        deltaY: -100000,
        deltaX: 0,
        wheelTicksY: -2500,
      });
      await until(`
        window.fixtureTerminal.buffer.active.viewportY === window.fixtureTerminal.buffer.active.baseY &&
        document.querySelector('.project-terminal .xterm-rows').textContent.includes('bottom-visible')
      `);
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR) {
        mkdirSync(process.env.DESKTOP_UI_SCREENSHOT_DIR, {recursive: true});
        writeFileSync(
          join(
            process.env.DESKTOP_UI_SCREENSHOT_DIR,
            `terminal-${terminalHeight}-${zoom}.png`,
          ),
          (await browser.webContents.capturePage()).toPNG(),
        );
      }
    }
    browser.setContentSize(1600, 1000);
    await evaluate(
      "window.pidev.setZoom(1); document.getElementById('terminal-sessions').style.height = ''",
    );
    report.cases.push(
      'Resizing and zooming keep the final terminal rows visible after scrolling to the bottom',
    );
    await evaluate("document.getElementById('prompt-tab').click()");
    assert.equal(await evaluate('document.activeElement.id'), 'parent-prompt');
    assert.equal(
      await evaluate("document.getElementById('parent-prompt').value"),
      'Keep this draft',
    );
    await evaluate("document.getElementById('terminal-tab').click()");
    assert.deepEqual(calls, ['first']);
    await until(
      "document.querySelector('.project-terminal').textContent.includes('bottom-visible')",
    );
    report.cases.push(
      'Native shell input and output stay inside the composer and preserve the prompt',
    );
    const original = terminals.list('first')[0];
    const availableProfiles = profiles.get();
    const selectedProfile =
      availableProfiles.profiles.find(
        entry => entry.id !== availableProfiles.defaultProfileId,
      ) || availableProfiles.profiles[0];
    await evaluate(
      "document.getElementById('terminal-profiles').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true}))",
    );
    await until(
      "document.getElementById('terminal-profiles').getAttribute('aria-expanded') === 'true'",
    );
    await evaluate(
      `document.querySelector('#terminal-profile-menu [data-profile-id="${selectedProfile.id}"]').click()`,
    );
    await until(
      "document.querySelectorAll('#terminal-tabs [role=tab]').length === 2 && !document.getElementById('terminal-new').disabled",
    );
    const added = terminals
      .list('first')
      .find(entry => entry.sessionId !== 'first');
    assert.equal(added.profileId, selectedProfile.id);
    assert.deepEqual(creates, [['first', selectedProfile.id]]);
    await evaluate(
      "document.querySelector('#terminal-tabs [role=tab]').dispatchEvent(new KeyboardEvent('keydown', {key:'Home', bubbles:true}))",
    );
    assert.equal(
      await evaluate(
        "document.querySelector('#terminal-tabs [aria-selected=true]').getAttribute('data-terminal-id')",
      ),
      'first',
    );
    assert.equal(
      await evaluate("document.activeElement.getAttribute('data-terminal-id')"),
      'first',
    );
    assert.equal(
      await evaluate(
        "document.querySelector('.project-terminal:not([hidden])').textContent.includes('bottom-visible')",
      ),
      true,
    );
    await evaluate(
      "document.querySelector('#terminal-tabs [role=tab]').dispatchEvent(new KeyboardEvent('keydown', {key:'End', bubbles:true}))",
    );
    assert.equal(
      await evaluate(
        "document.querySelector('#terminal-tabs [aria-selected=true]').getAttribute('data-terminal-id')",
      ),
      added.sessionId,
    );
    report.cases.push(
      'The shell menu creates a tab and keyboard navigation switches retained terminals',
    );

    await evaluate("document.getElementById('terminal-profiles').click()");
    await until(
      "document.getElementById('terminal-profiles').getAttribute('aria-expanded') === 'true'",
    );
    await evaluate(
      "document.querySelector('#terminal-profile-menu [data-select-default]').click()",
    );
    assert.equal(
      await evaluate(
        "document.querySelector('#terminal-profile-menu .terminal-menu-heading').textContent",
      ),
      'Default shell for new terminals',
    );
    await evaluate(
      `document.querySelector('#terminal-profile-menu [data-profile-id="${selectedProfile.id}"]').click()`,
    );
    await until(
      "document.getElementById('terminal-profiles').getAttribute('aria-expanded') === 'false'",
    );
    assert.equal(profiles.get().defaultProfileId, selectedProfile.id);
    assert.equal(
      terminals.list('first').find(entry => entry.sessionId === 'first')
        .generation,
      original.generation,
    );
    await evaluate("document.getElementById('terminal-new').click()");
    await until(
      "document.querySelectorAll('#terminal-tabs [role=tab]').length === 3 && !document.getElementById('terminal-new').disabled",
    );
    const newest = terminals.list('first').at(-1);
    assert.equal(newest.profileId, selectedProfile.id);
    await evaluate("document.getElementById('terminal-close').click()");
    await until(
      "document.querySelectorAll('#terminal-tabs [role=tab]').length === 2",
    );
    assert.throws(
      () => terminals.write(newest.sessionId, 'x'),
      /Open a terminal/,
    );
    assert.equal(
      await evaluate("document.getElementById('terminal-panel').hidden"),
      false,
    );
    report.cases.push(
      'Selecting a default shell affects new terminals and closing a tab selects its neighbor',
    );

    failCreate = true;
    await evaluate("document.getElementById('terminal-new').click()");
    await until(
      "!document.getElementById('terminal-error').hidden && !document.getElementById('terminal-new').disabled",
    );
    assert.match(
      await evaluate("document.getElementById('terminal-error').textContent"),
      /New shell could not start/,
    );
    assert.equal(terminals.list('first').length, 2);
    failCreate = false;
    failClose = true;
    await evaluate("document.getElementById('terminal-close').click()");
    await until(
      "document.getElementById('terminal-error').textContent.includes('Shell could not close') && !document.getElementById('terminal-close').disabled",
    );
    assert.equal(terminals.list('first').length, 2);
    failClose = false;
    failDefault = true;
    await evaluate("document.getElementById('terminal-profiles').click()");
    await until(
      "document.getElementById('terminal-profiles').getAttribute('aria-expanded') === 'true'",
    );
    await evaluate(
      "document.querySelector('#terminal-profile-menu [data-select-default]').click()",
    );
    await evaluate(
      `document.querySelector('#terminal-profile-menu [data-profile-id="${original.profileId}"]').click()`,
    );
    await until(
      "document.getElementById('terminal-error').textContent.includes('could not be saved') && !document.querySelector('#terminal-profile-menu button').disabled",
    );
    assert.equal(profiles.get().defaultProfileId, selectedProfile.id);
    failDefault = false;
    await evaluate(
      "document.getElementById('terminal-profile-menu').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))",
    );
    assert.equal(
      await evaluate('document.activeElement.id'),
      'terminal-profiles',
    );
    report.cases.push(
      'Create, close and default selection failures preserve running terminals and allow recovery',
    );

    failProfileLoad = true;
    await evaluate(
      "document.getElementById('app-menu-button').click();document.getElementById('open-terminal-settings').click()",
    );
    await until(
      "document.getElementById('terminal-settings-dialog').open && !document.getElementById('terminal-settings-error').hidden",
    );
    assert.match(
      await evaluate(
        "document.getElementById('terminal-settings-error').textContent",
      ),
      /could not load/,
    );
    failProfileLoad = false;
    await evaluate(
      "document.getElementById('terminal-settings-retry').click()",
    );
    await until("!document.getElementById('terminal-settings-name').disabled");
    const settingsFields = (label, path) =>
      evaluate(`(() => {
      for (const [id,value] of [['terminal-settings-name',${JSON.stringify(label)}],['terminal-settings-path',${JSON.stringify(path)}]]) {
        const field=document.getElementById(id);field.value=value;field.dispatchEvent(new Event('input',{bubbles:true}));
      }
    })()`);
    const customExecutable = profiles.get().profiles[0].path;
    await settingsFields('Custom shell', customExecutable);
    await evaluate(
      "document.getElementById('terminal-settings-browse').click()",
    );
    await until(
      "!document.getElementById('terminal-settings-browse').disabled",
    );
    assert.equal(
      await evaluate("document.getElementById('terminal-settings-path').value"),
      customExecutable,
    );
    failBrowse = true;
    await evaluate(
      "document.getElementById('terminal-settings-browse').click()",
    );
    await until(
      "document.getElementById('terminal-settings-error').textContent.includes('File chooser')",
    );
    assert.equal(
      await evaluate("document.getElementById('terminal-settings-name').value"),
      'Custom shell',
    );
    failBrowse = false;
    chosenExecutable = customExecutable;
    await evaluate(
      "document.getElementById('terminal-settings-path').value = '';document.getElementById('terminal-settings-path').dispatchEvent(new Event('input'));document.getElementById('terminal-settings-browse').click()",
    );
    await until(
      "document.getElementById('terminal-settings-path').value !== '' && !document.getElementById('terminal-settings-browse').disabled",
    );
    failProfileSave = true;
    await evaluate("document.getElementById('terminal-settings-save').click()");
    await until(
      "document.getElementById('terminal-settings-error').textContent.includes('could not save') && !document.getElementById('terminal-settings-save').disabled",
    );
    assert.equal(
      await evaluate("document.getElementById('terminal-settings-name').value"),
      'Custom shell',
    );
    assert.equal(
      await evaluate("document.getElementById('terminal-settings-path').value"),
      customExecutable,
    );
    failProfileSave = false;
    await evaluate("document.getElementById('terminal-settings-save').click()");
    await until(
      "document.getElementById('terminal-settings-status').textContent === 'Saved.'",
    );
    const customId = profiles.get().customProfiles[0].id;
    await settingsFields('Renamed shell', customExecutable);
    assert.equal(
      await evaluate(
        "document.getElementById('terminal-settings-error').hidden",
      ),
      true,
    );
    await evaluate("document.getElementById('terminal-settings-save').click()");
    await until(
      "document.getElementById('terminal-settings-status').textContent === 'Saved.'",
    );
    assert.equal(profiles.get().customProfiles[0].id, customId);
    assert.equal(profiles.get().customProfiles[0].label, 'Renamed shell');
    await evaluate("document.getElementById('terminal-settings-add').click()");
    await settingsFields('Discard this draft', '/unsaved/location');
    await evaluate(
      "document.getElementById('terminal-settings-dialog').dispatchEvent(new Event('cancel',{cancelable:true}))",
    );
    assert.equal(profiles.get().customProfiles.length, 1);
    assert.equal(
      await evaluate('document.activeElement.id'),
      'app-menu-button',
    );
    report.cases.push(
      'Terminal settings supports browsing, cancelled edits, saved edits, and recoverable load, browse and save errors',
    );

    await evaluate("document.getElementById('terminal-profiles').click()");
    await until(
      "document.querySelector('#terminal-profile-menu [data-terminal-settings]') && document.getElementById('terminal-profile-menu').matches(':popover-open')",
    );
    assert.equal(
      await evaluate(
        `document.querySelector('#terminal-profile-menu [data-profile-id="${customId}"]').textContent`,
      ),
      'Renamed shell',
    );
    await evaluate(
      `document.querySelector('#terminal-profile-menu [data-profile-id="${customId}"]').click()`,
    );
    await until(
      "document.querySelectorAll('#terminal-tabs [role=tab]').length === 3 && !document.getElementById('terminal-new').disabled",
    );
    const customTerminal = terminals
      .list('first')
      .find(entry => entry.profileId === customId);
    assert.equal(customTerminal.title, 'Renamed shell');
    await evaluate("document.getElementById('terminal-profiles').click()");
    await until(
      "document.getElementById('terminal-profile-menu').matches(':popover-open')",
    );
    await evaluate(
      "document.querySelector('#terminal-profile-menu [data-select-default]').click()",
    );
    await evaluate(
      `document.querySelector('#terminal-profile-menu [data-profile-id="${customId}"]').click()`,
    );
    await until(
      "document.getElementById('terminal-profiles').getAttribute('aria-expanded') === 'false'",
    );
    assert.equal(restartedProfiles().get().defaultProfileId, customId);
    assert.deepEqual(
      restartedProfiles().get().customProfiles,
      profiles.get().customProfiles,
    );
    report.cases.push(
      'Saved custom shells launch from the shell menu and their edits and default survive a preferences restart',
    );

    await evaluate("document.getElementById('terminal-profiles').click()");
    await until(
      "document.getElementById('terminal-profile-menu').matches(':popover-open')",
    );
    await evaluate(
      "document.querySelector('#terminal-profile-menu [data-terminal-settings]').click()",
    );
    await until(
      "document.getElementById('terminal-settings-dialog').open && !document.getElementById('terminal-settings-name').disabled",
    );
    const movedExecutable = join(
      profile,
      process.platform === 'win32' ? 'moved-shell.exe' : 'moved-shell',
    );
    copyFileSync(customExecutable, movedExecutable);
    chmodSync(movedExecutable, 0o755);
    await evaluate("document.getElementById('terminal-settings-add').click()");
    await settingsFields('Moved shell', movedExecutable);
    await evaluate("document.getElementById('terminal-settings-save').click()");
    await until(
      "document.getElementById('terminal-settings-status').textContent === 'Saved.'",
    );
    const movedId = profiles
      .get()
      .customProfiles.find(entry => entry.label === 'Moved shell').id;
    unlinkSync(movedExecutable);
    await evaluate(
      "document.getElementById('terminal-settings-close').click()",
    );
    await evaluate(
      "document.getElementById('app-menu-button').click();document.getElementById('open-terminal-settings').click()",
    );
    await until("!document.getElementById('terminal-settings-name').disabled");
    await evaluate(
      `document.getElementById('terminal-settings-profile').value='${movedId}';document.getElementById('terminal-settings-profile').dispatchEvent(new Event('change'))`,
    );
    assert.equal(
      await evaluate(
        "document.getElementById('terminal-settings-unavailable').hidden",
      ),
      false,
    );
    assert.equal(
      await evaluate("document.getElementById('terminal-settings-path').value"),
      movedExecutable,
    );
    assert.equal(
      profiles.get().profiles.some(entry => entry.id === movedId),
      false,
    );
    await evaluate(
      "document.getElementById('terminal-settings-close').click()",
    );

    const beforePendingStartup = terminals.list('first');
    let releaseStartup;
    let startupReached;
    const startupStarted = new Promise(resolve => {
      startupReached = resolve;
    });
    const startupReady = new Promise(resolve => {
      releaseStartup = resolve;
    });
    let silentKilled = false;
    nextPty = {
      started: startupReached,
      ready: startupReady,
      module: {
        spawn: () => ({
          write() {},
          resize() {},
          kill() {
            silentKilled = true;
          },
          onData() {
            return {dispose() {}};
          },
          onExit() {
            return {dispose() {}};
          },
        }),
      },
    };
    await evaluate("document.getElementById('terminal-new').click()");
    await startupStarted;
    assert.equal(terminals.list('first').length, beforePendingStartup.length);
    const rendererListing = new Promise(resolve => {
      listRequested = resolve;
    });
    browser.webContents.reload();
    await new Promise(resolve =>
      browser.webContents.once('did-finish-load', resolve),
    );
    await until("!document.getElementById('parent-controls').hidden");
    await captureTerminals();
    await evaluate("document.getElementById('terminal-tab').click()");
    await rendererListing;
    releaseStartup();
    await until(
      "document.querySelectorAll('#terminal-tabs [role=tab]').length === 4 && !document.getElementById('terminal-new').disabled",
    );
    const restored = terminals.list('first');
    const silent = restored.find(
      entry =>
        !beforePendingStartup.some(
          previous => previous.sessionId === entry.sessionId,
        ),
    );
    assert.ok(silent);
    assert.equal(silent.data, '');
    assert.equal(silent.sequence, 0);
    assert.equal(
      terminalOutput.has(silent.sessionId),
      false,
      'The new shell emits no terminal events to discover it',
    );
    assert.deepEqual(
      await evaluate(
        "[...document.querySelectorAll('#terminal-tabs [role=tab]')].map(tab=>tab.getAttribute('data-terminal-id'))",
      ),
      restored.map(entry => entry.sessionId),
    );
    assert.deepEqual(
      restored
        .filter(entry => entry.sessionId !== silent.sessionId)
        .map(entry => [entry.sessionId, entry.generation]),
      beforePendingStartup.map(entry => [entry.sessionId, entry.generation]),
    );
    await evaluate(
      `document.getElementById('terminal-label-${silent.sessionId}').click()`,
    );
    assert.equal(
      await evaluate(
        `document.getElementById('terminal-view-${silent.sessionId}').hidden`,
      ),
      false,
    );
    await evaluate("document.getElementById('terminal-close').click()");
    await until(
      "document.querySelectorAll('#terminal-tabs [role=tab]').length === 3",
    );
    assert.equal(silentKilled, true);
    await evaluate("document.getElementById('terminal-label-first').click()");
    report.cases.push(
      'A single reload restores existing tabs and a silent terminal whose startup was pending',
    );
    assert.equal(
      terminals.list('first').find(entry => entry.sessionId === 'first')
        .generation,
      original.generation,
    );
    assert.deepEqual(calls, ['first']);
    await until(
      "document.querySelector('.project-terminal:not([hidden])').textContent.includes('bottom-visible')",
    );
    report.cases.push(
      'Renderer reload restores existing terminal tabs and output without launching another shell',
    );

    await evaluate(
      "document.getElementById('app-menu-button').click();document.getElementById('open-terminal-settings').click()",
    );
    await until(
      "!document.getElementById('terminal-settings-profile').disabled",
    );
    assert.equal(
      await evaluate(
        `document.querySelector('#terminal-settings-profile option[value="${customId}"]').textContent`,
      ),
      'Renamed shell',
    );
    await evaluate(
      "document.getElementById('terminal-settings-close').click()",
    );

    const coloredText = 'WHITE YELLOW ANSI256 TRUECOLOR';
    terminals.write(
      'first',
      process.platform === 'win32'
        ? '[Console]::Write("$([char]27)[97mWHITE $([char]27)[93mYELLOW $([char]27)[38;5;231mANSI256 $([char]27)[38;2;255;255;255mTRUECOLOR$([char]27)[0m`r`n")' +
            String.fromCharCode(13)
        : "printf '\\033[97mWHITE \\033[93mYELLOW \\033[38;5;231mANSI256 \\033[38;2;255;255;255mTRUECOLOR\\033[0m\\n'" +
            String.fromCharCode(13),
    );
    await until(
      `document.querySelector('.project-terminal:not([hidden]) .xterm-rows').textContent.includes('${coloredText}')`,
    );
    assert.equal(
      await evaluate('window.fixtureTerminals[0].options.minimumContrastRatio'),
      4.5,
    );

    const themeIds = await evaluate(
      "[...document.getElementById('factory-theme').options].map(option => option.value)",
    );
    for (const themeId of themeIds) {
      await evaluate(
        `document.getElementById('factory-theme').value = '${themeId}'; document.getElementById('factory-theme').dispatchEvent(new Event('change'))`,
      );
      for (const [width, height, zoom] of [
        [1600, 1000, 1],
        [1100, 760, 1.5],
      ]) {
        browser.setContentSize(width, height);
        await evaluate(`window.pidev.setZoom(${zoom})`);
        await evaluate(
          'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
        );
        await until(
          `document.querySelector('.project-terminal:not([hidden]) .xterm-rows').textContent.includes('${coloredText}')`,
        );
        const coloredRuns = await until(`(() => {
          const row=[...document.querySelectorAll('.project-terminal:not([hidden]) .xterm-rows > div')].find(row=>row.textContent.replaceAll('\u00a0',' ').includes('${coloredText}'));
          if(!row) return null;
          const runs = ['WHITE','YELLOW','ANSI256','TRUECOLOR'].map(label=>{
            const span=[...row.querySelectorAll('span')].find(span=>span.textContent.includes(label));
            return {label,text:span?.textContent,color:span?getComputedStyle(span).color:null,background:getComputedStyle(document.getElementById('terminal-sessions')).backgroundColor};
          });
          return runs.every(run=>run.color) ? runs : null;
        })()`);
        await evaluate("document.getElementById('terminal-profiles').click()");
        await until(
          "document.getElementById('terminal-profile-menu').matches(':popover-open')",
        );
        await evaluate(
          'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
        );
        const bounds = await evaluate(`(() => {
          const rect = id => document.getElementById(id).getBoundingClientRect().toJSON();
          const styles = getComputedStyle(document.querySelector('.project-terminal:not([hidden]) .xterm'));
          const theme = window.fixtureTerminals[0].options.theme;
          return {toolbar:rect('terminal-tabs'), launcher:rect('terminal-profiles'), menu:rect('terminal-profile-menu'), body:rect('terminal-sessions'), width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollHeight>innerHeight,foreground:styles.color,theme};
        })()`);
        for (const name of ['toolbar', 'launcher', 'menu', 'body']) {
          assert.ok(
            bounds[name].left >= 0 &&
              bounds[name].right <= bounds.width + 1 &&
              bounds[name].top >= 0 &&
              bounds[name].bottom <= bounds.height + 1,
            `${themeId} at ${zoom}: ${name} clipped ${JSON.stringify(bounds)}`,
          );
        }
        const luminance = color => {
          const channels = color.startsWith('#')
            ? color
                .slice(1)
                .match(/../g)
                .map(value => parseInt(value, 16))
            : color
                .match(/[0-9.]+/g)
                .slice(0, 3)
                .map(Number);
          return channels
            .map(value => {
              const channel = value / 255;
              return channel <= 0.04045
                ? channel / 12.92
                : ((channel + 0.055) / 1.055) ** 2.4;
            })
            .reduce(
              (sum, value, index) =>
                sum + value * [0.2126, 0.7152, 0.0722][index],
              0,
            );
        };
        assert.equal(
          coloredRuns.length,
          4,
          `${themeId}: colored shell output must be rendered`,
        );
        for (const run of coloredRuns) {
          assert.ok(
            run.color,
            `${themeId}: ${run.label} must be visible in the rendered row`,
          );
          const foreground = luminance(run.color);
          const background = luminance(run.background);
          const ratio =
            (Math.max(foreground, background) + 0.05) /
            (Math.min(foreground, background) + 0.05);
          assert.ok(
            ratio >= 4.45,
            `${themeId} ${run.label} rendered contrast ${ratio}: ${JSON.stringify(run)}`,
          );
        }
        const foreground = luminance(bounds.theme.foreground);
        const background = luminance(bounds.theme.background);
        const contrast =
          (Math.max(foreground, background) + 0.05) /
          (Math.min(foreground, background) + 0.05);
        assert.ok(
          contrast >= 4.5,
          `${themeId} terminal contrast ${contrast}: ${JSON.stringify(bounds.theme)}`,
        );
        assert.equal(bounds.overflow, false);
        assert.ok(
          bounds.body.height >= 80 && bounds.body.width >= 180,
          JSON.stringify(bounds),
        );
        if (process.env.DESKTOP_UI_SCREENSHOT_DIR) {
          await new Promise(resolve => setTimeout(resolve, 100));
          mkdirSync(process.env.DESKTOP_UI_SCREENSHOT_DIR, {recursive: true});
          writeFileSync(
            join(
              process.env.DESKTOP_UI_SCREENSHOT_DIR,
              `terminal-tabs-${themeId}-${zoom}.png`,
            ),
            (await browser.webContents.capturePage()).toPNG(),
          );
        }
        await evaluate(
          "document.getElementById('terminal-profile-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
        );
        await evaluate(
          "document.getElementById('app-menu-button').click();document.getElementById('open-terminal-settings').click()",
        );
        await until(
          "document.getElementById('terminal-settings-dialog').open && !document.getElementById('terminal-settings-profile').disabled",
        );
        await evaluate(
          `document.getElementById('terminal-settings-profile').value='${movedId}';document.getElementById('terminal-settings-profile').dispatchEvent(new Event('change'))`,
        );
        await evaluate(
          'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
        );
        const settingsBounds = await evaluate(`(() => {
          const ids=['terminal-settings-dialog','terminal-settings-profile','terminal-settings-name','terminal-settings-path','terminal-settings-browse','terminal-settings-save','terminal-settings-remove','terminal-settings-close'];
          return {width:innerWidth,height:innerHeight,rects:ids.map(id=>[id,document.getElementById(id).getBoundingClientRect().toJSON()])};
        })()`);
        for (const [id, rect] of settingsBounds.rects)
          assert.ok(
            rect.width > 0 &&
              rect.height > 0 &&
              rect.left >= 0 &&
              rect.top >= 0 &&
              rect.right <= settingsBounds.width + 1 &&
              rect.bottom <= settingsBounds.height + 1,
            `${themeId} at ${zoom}: settings ${id} clipped ${JSON.stringify(settingsBounds)}`,
          );
        if (process.env.DESKTOP_UI_SCREENSHOT_DIR) {
          await new Promise(resolve => setTimeout(resolve, 100));
          writeFileSync(
            join(
              process.env.DESKTOP_UI_SCREENSHOT_DIR,
              `terminal-settings-${themeId}-${zoom}.png`,
            ),
            (await browser.webContents.capturePage()).toPNG(),
          );
        }
        await evaluate(
          "document.getElementById('terminal-settings-close').click()",
        );
      }
    }
    browser.setContentSize(1600, 1000);
    await evaluate(
      "window.pidev.setZoom(1);document.getElementById('factory-theme').value='factory';document.getElementById('factory-theme').dispatchEvent(new Event('change'))",
    );
    report.cases.push(
      'Terminal tabs and the shell menu fit compact and full layouts in every shipped theme',
    );
    report.cases.push(
      'Real shell ANSI, 256-color and truecolor text remains readable across all light and dark themes',
    );

    async function checkOpenMenu(stage) {
      await evaluate(
        'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
      );
      const bounds = await evaluate(`(() => {
        const menu=document.getElementById('terminal-profile-menu');
        const rect=element=>element.getBoundingClientRect().toJSON();
        const actions=[...menu.querySelectorAll('button')].map(button=>{
          const box=rect(button);
          const top=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);
          return {text:button.textContent,box,reachable:button.contains(top)};
        });
        return {open:menu.matches(':popover-open'),menu:rect(menu),anchor:rect(document.getElementById('terminal-profiles')),width:innerWidth,height:innerHeight,actions};
      })()`);
      assert.equal(bounds.open, true, stage);
      assert.ok(
        bounds.menu.left >= 0 &&
          bounds.menu.top >= 0 &&
          bounds.menu.right <= bounds.width + 1 &&
          bounds.menu.bottom <= bounds.height + 1,
        `${stage}: ${JSON.stringify(bounds)}`,
      );
      assert.ok(
        Math.abs(bounds.menu.right - bounds.anchor.right) <= 2,
        `${stage}: menu must follow its toolbar ${JSON.stringify(bounds)}`,
      );
      assert.ok(
        bounds.actions.length > 0 &&
          bounds.actions.every(action => action.reachable),
        `${stage}: menu actions must be clickable ${JSON.stringify(bounds)}`,
      );
      return bounds;
    }
    for (const view of ['launch', 'default']) {
      browser.setContentSize(1600, 1000);
      await evaluate('window.pidev.setZoom(1)');
      await evaluate(
        'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
      );
      await evaluate("document.getElementById('terminal-profiles').click()");
      await until(
        "document.getElementById('terminal-profile-menu').matches(':popover-open')",
      );
      if (view === 'default')
        await evaluate(
          "document.querySelector('#terminal-profile-menu [data-select-default]').click()",
        );
      await checkOpenMenu(view + ' initial');
      browser.setContentSize(1100, 760);
      await checkOpenMenu(view + ' resized');
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR) {
        await new Promise(resolve => setTimeout(resolve, 100));
        writeFileSync(
          join(
            process.env.DESKTOP_UI_SCREENSHOT_DIR,
            `terminal-menu-${view}-resized.png`,
          ),
          (await browser.webContents.capturePage()).toPNG(),
        );
      }
      await evaluate(
        "document.getElementById('app-zoom').value='1.5';document.getElementById('app-zoom').dispatchEvent(new Event('change'))",
      );
      await checkOpenMenu(view + ' zoomed');
      const anchorBefore = await evaluate(
        "document.getElementById('terminal-profiles').getBoundingClientRect().right",
      );
      await evaluate(
        "document.getElementById('terminal-panel').style.width='70%'",
      );
      const narrowed = await checkOpenMenu(view + ' toolbar resized');
      assert.ok(
        narrowed.anchor.right < anchorBefore - 20,
        'The toolbar must move independently of the viewport',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR) {
        await new Promise(resolve => setTimeout(resolve, 100));
        writeFileSync(
          join(
            process.env.DESKTOP_UI_SCREENSHOT_DIR,
            `terminal-menu-${view}-zoom-container.png`,
          ),
          (await browser.webContents.capturePage()).toPNG(),
        );
      }
      const action = await evaluate(`(() => {
        const button=document.querySelector('#terminal-profile-menu ${view === 'launch' ? '[data-terminal-settings]' : '[aria-checked="true"]'}');
        const rect=button.getBoundingClientRect();
        return {x:Math.round((rect.x+rect.width/2)*window.pidev.getZoom()),y:Math.round((rect.y+rect.height/2)*window.pidev.getZoom())};
      })()`);
      browser.webContents.sendInputEvent({
        type: 'mouseDown',
        ...action,
        button: 'left',
        clickCount: 1,
      });
      browser.webContents.sendInputEvent({
        type: 'mouseUp',
        ...action,
        button: 'left',
        clickCount: 1,
      });
      if (view === 'launch') {
        await until("document.getElementById('terminal-settings-dialog').open");
        await evaluate(
          "document.getElementById('terminal-settings-close').click()",
        );
      } else
        await until(
          "!document.getElementById('terminal-profile-menu').matches(':popover-open')",
        );
      await evaluate(
        "document.getElementById('terminal-panel').style.width=''",
      );
    }
    browser.setContentSize(1600, 1000);
    await evaluate('window.pidev.setZoom(1)');
    report.cases.push(
      'Open launch and default shell menus follow window resizing, app zoom and toolbar resizing with clickable actions',
    );

    await evaluate(
      "document.getElementById('app-menu-button').click();document.getElementById('open-terminal-settings').click()",
    );
    await until(
      "!document.getElementById('terminal-settings-profile').disabled",
    );
    await evaluate(
      `document.getElementById('terminal-settings-profile').value='${movedId}';document.getElementById('terminal-settings-profile').dispatchEvent(new Event('change'))`,
    );
    await settingsFields('Moved shell', customExecutable);
    await evaluate("document.getElementById('terminal-settings-save').click()");
    await until(
      "document.getElementById('terminal-settings-status').textContent === 'Saved.'",
    );
    assert.equal(
      profiles.get().profiles.some(entry => entry.id === movedId),
      true,
    );
    failProfileRemove = true;
    await evaluate(
      "document.getElementById('terminal-settings-remove').click()",
    );
    await until(
      "document.getElementById('terminal-settings-error').textContent.includes('could not remove') && !document.getElementById('terminal-settings-remove').disabled",
    );
    assert.equal(
      await evaluate("document.getElementById('terminal-settings-name').value"),
      'Moved shell',
    );
    failProfileRemove = false;
    await evaluate(
      "document.getElementById('terminal-settings-remove').click()",
    );
    await until(
      "document.getElementById('terminal-settings-status').textContent === 'Removed.'",
    );
    assert.equal(profiles.get().customProfiles.length, 1);
    await evaluate(
      "document.getElementById('terminal-settings-remove').click()",
    );
    await until(
      "document.getElementById('terminal-settings-status').textContent === 'Removed.' && document.getElementById('terminal-settings-profile').value === ''",
    );
    assert.equal(profiles.get().customProfiles.length, 0);
    assert.notEqual(profiles.get().defaultProfileId, customId);
    assert.equal(
      terminals
        .list('first')
        .find(entry => entry.sessionId === customTerminal.sessionId).generation,
      customTerminal.generation,
    );
    await evaluate(
      "document.getElementById('terminal-settings-close').click();document.getElementById('terminal-profiles').click()",
    );
    await until(
      "document.getElementById('terminal-profile-menu').matches(':popover-open')",
    );
    assert.equal(
      await evaluate(
        `!!document.querySelector('#terminal-profile-menu [data-profile-id="${customId}"]')`,
      ),
      false,
    );
    await evaluate(
      "document.getElementById('terminal-profile-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
    );
    await evaluate(
      `document.getElementById('terminal-label-${customTerminal.sessionId}').click();document.getElementById('terminal-close').click()`,
    );
    await until(
      "document.querySelectorAll('#terminal-tabs [role=tab]').length === 2",
    );
    await evaluate("document.getElementById('terminal-label-first').click()");
    report.cases.push(
      'Unavailable custom shells remain editable and removal refreshes defaults and menus without closing running tabs',
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
      "document.getElementById('terminal-close') && !document.getElementById('terminal-new').disabled && document.getElementById('terminal-error').hidden",
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
    await until(
      `document.querySelector('.project-terminal:not([hidden])').textContent.includes('${coloredText}')`,
    );
    report.cases.push(
      'Shells follow the selected project and recover from startup errors',
    );
    assert.equal(
      await evaluate(
        "document.querySelectorAll('#terminal-tabs [role=tab]').length",
      ),
      2,
    );
    await evaluate(
      `document.querySelector('#terminal-tabs [data-close-terminal][data-terminal-id="${added.sessionId}"]').click()`,
    );
    await until(
      "document.querySelectorAll('#terminal-tabs [role=tab]').length === 1",
    );
    assert.equal(terminals.list('first')[0].generation, original.generation);
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
    await until(
      "document.getElementById('terminal-close') && !document.getElementById('terminal-new').disabled",
    );
    assert.equal(
      await evaluate("document.querySelectorAll('.project-terminal').length"),
      2,
    );
    await evaluate("document.getElementById('item-actions-button').click()");
    await evaluate("document.getElementById('close-session').click()");
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
    report.error = `${error.stack}\nTerminal output: ${JSON.stringify(Object.fromEntries(terminalOutput))}`;
    process.exitCode = 1;
  })
  .finally(() => {
    terminals?.dispose();
    writeFileSync(reportPath, JSON.stringify(report));
    app.quit();
  });
