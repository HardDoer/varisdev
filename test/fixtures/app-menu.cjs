/* global process, __dirname, document, window, getComputedStyle, setTimeout */
const assert = require('node:assert/strict');
const {writeFileSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {app, BrowserWindow, ipcMain} = require('electron');
const [directory, reportPath] = process.argv.slice(2);
const report = {cases: []};
let browser;
let chosen = 0;
let aborted = 0;
let hub = {sessions: [], launchCwd: directory};
app.setPath('userData', join(directory, 'profile'));
app.setPath('sessionData', join(directory, 'session'));
function handle(channel, action) {
  ipcMain.handle(channel, async (event, ...args) => {
    assert.equal(event.sender, browser.webContents);
    return {ok: true, value: await action(...args)};
  });
}
const evaluate = (fn, arg) =>
  browser.webContents.executeJavaScript(
    `(${fn.toString()})(${JSON.stringify(arg)})`,
  );
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate(fn)) return;
    await delay(20);
  }
  throw new Error(`Timed out: ${fn}`);
}
async function key(code) {
  browser.focus();
  browser.webContents.focus();
  browser.webContents.sendInputEvent({type: 'keyDown', keyCode: code});
  if (/^[a-z0-9]$/i.test(code))
    browser.webContents.sendInputEvent({type: 'char', keyCode: code});
  browser.webContents.sendInputEvent({type: 'keyUp', keyCode: code});
  await delay(40);
}
async function menu() {
  await evaluate(() => document.getElementById('app-menu-button').focus());
  await key('Space');
  await waitFor(() =>
    document.getElementById('app-menu-panel').matches(':popover-open'),
  );
}
function parent() {
  const at = new Date().toISOString();
  return {
    session: {
      id: 'project',
      name: 'Project',
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
  handle('varisdev:get-agent-notice', () => ({acknowledged: true}));
  handle('varisdev:get-update-status', () => ({
    phase: 'idle',
    currentVersion: '0.85.1',
    restartRequired: false,
  }));
  handle('pidev:choose-folder', () => {
    chosen++;
    return directory;
  });
  handle('pidev:create-session', input => {
    assert.equal(input.cwd, directory);
    hub = {
      launchCwd: directory,
      sessions: [parent()],
      selectedSessionId: 'project',
    };
    browser.webContents.send('pidev:snapshot', hub);
    return {id: 'project'};
  });
  handle('pidev:abort-session', () => {
    aborted++;
    return {steering: [], followUp: []};
  });
  handle('varisdev:app-themes', () => ({themes: [], errors: []}));
  handle('pidev:session-features', () => ({
    commands: [],
    tools: [],
    models: [],
    diagnostics: [],
    thinkingLevel: 'off',
    thinkingLevels: ['off'],
  }));
  await browser.loadFile(
    resolve(__dirname, '../../assets/dashboard/index.html'),
  );
  await waitFor(() => !document.getElementById('welcome').hidden);
  assert.equal(
    await evaluate(
      () => document.getElementById('application-controls').parentElement.id,
    ),
    'welcome-actions',
  );
  assert.equal(
    await evaluate(
      () => document.querySelector('main > .app-controls') !== null,
    ),
    false,
  );
  assert.equal(
    await evaluate(
      () => document.getElementById('app-zoom').getBoundingClientRect().height,
    ),
    0,
  );
  await menu();
  assert.equal(
    await evaluate(() =>
      document.getElementById('app-menu-button').getAttribute('aria-expanded'),
    ),
    'true',
  );
  const popup = await evaluate(() => {
    const panel = document
      .getElementById('app-menu-panel')
      .getBoundingClientRect();
    const button = document
      .getElementById('app-menu-button')
      .getBoundingClientRect();
    return {
      left: panel.left,
      right: panel.right,
      top: panel.top,
      bottom: panel.bottom,
      buttonBottom: button.bottom,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  });
  assert.ok(
    popup.left >= 0 &&
      popup.right <= popup.width &&
      popup.bottom <= popup.height,
    JSON.stringify(popup),
  );
  assert.ok(popup.top >= popup.buttonBottom, JSON.stringify(popup));

  assert.deepEqual(
    await evaluate(() => ({
      headings: [...document.querySelectorAll('.app-menu-group > h2')].map(
        heading => heading.textContent.trim(),
      ),
      project: [...document.querySelectorAll('.app-menu-project button')].map(
        button => button.id,
      ),
      appearance: [
        ...document.querySelectorAll(
          '#app-menu-appearance-controls select, #app-menu-appearance-controls button',
        ),
      ].map(control => control.id),
      settings: [...document.querySelectorAll('.app-menu-settings button')].map(
        button => button.id,
      ),
      maintenance: [
        ...document.querySelectorAll('.app-menu-maintenance button'),
      ].map(button => button.id),
      destructive:
        document
          .getElementById('close-session')
          .classList.contains('danger-button') &&
        document
          .getElementById('close-session')
          .parentElement.classList.contains('app-menu-danger-zone'),
      destructiveSeparated:
        getComputedStyle(document.getElementById('close-session').parentElement)
          .borderTopStyle === 'solid',
      labelled: [...document.querySelectorAll('.app-menu-group')].every(group =>
        document.getElementById(group.getAttribute('aria-labelledby')),
      ),
    })),
    {
      headings: ['Workspaces', 'Appearance', 'Tools & settings', 'Maintenance'],
      project: [
        'menu-new-agent',
        'open-workspace-config',
        'open-agent-templates',
        'new-session',
        'start-session',
        'resume-session',
        'close-session',
      ],
      appearance: ['app-zoom', 'factory-theme', 'motion-toggle'],
      settings: [
        'open-session-settings',
        'open-approvals',
        'open-model-settings',
        'open-accounts',
      ],
      maintenance: ['open-about'],
      destructive: true,
      destructiveSeparated: true,
      labelled: true,
    },
  );
  await key('Tab');
  assert.equal(
    await evaluate(() => document.activeElement.id),
    'menu-new-agent',
  );
  await evaluate(() => document.getElementById('app-zoom').focus());
  await key('2');
  await waitFor(() => window.pidev.getZoom() !== 1);
  assert.equal(
    await evaluate(() =>
      document.getElementById('app-menu-panel').matches(':popover-open'),
    ),
    true,
  );
  await key('Tab');
  assert.equal(
    await evaluate(() => document.activeElement.id),
    'factory-theme',
  );
  await key('N');
  await waitFor(() => document.documentElement.dataset.theme !== 'factory');
  assert.equal(
    await evaluate(() =>
      document.getElementById('app-menu-panel').matches(':popover-open'),
    ),
    true,
  );
  const beforeMotion = await evaluate(() =>
    document.getElementById('motion-toggle').getAttribute('aria-pressed'),
  );
  await key('Tab');
  assert.equal(
    await evaluate(() => document.activeElement.id),
    'motion-toggle',
  );
  await key('Space');
  assert.notEqual(
    await evaluate(() =>
      document.getElementById('motion-toggle').getAttribute('aria-pressed'),
    ),
    beforeMotion,
  );
  assert.equal(
    await evaluate(() =>
      document.getElementById('app-menu-panel').matches(':popover-open'),
    ),
    true,
  );
  await key('Escape');
  await waitFor(
    () =>
      document
        .getElementById('app-menu-button')
        .getAttribute('aria-expanded') === 'false',
  );
  assert.equal(
    await evaluate(() => document.activeElement.id),
    'app-menu-button',
  );
  report.cases.push(
    'grouped welcome menu supports keyboard zoom theme motion and Escape',
  );

  await menu();
  const outside = await evaluate(() => {
    const rect = document
      .getElementById('welcome-title')
      .getBoundingClientRect();
    return {x: Math.round(rect.left + 5), y: Math.round(rect.top + 5)};
  });
  browser.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...outside,
  });
  browser.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    clickCount: 1,
    ...outside,
  });
  await waitFor(
    () => !document.getElementById('app-menu-panel').matches(':popover-open'),
  );
  await menu();
  await evaluate(() => document.getElementById('new-session').focus());
  await key('Space');
  await waitFor(() => !document.getElementById('factory-workspace').hidden);
  assert.equal(chosen, 1);
  assert.equal(
    await evaluate(
      () => document.getElementById('application-controls').parentElement.id,
    ),
    'inspector-actions',
  );
  assert.equal(
    await evaluate(() =>
      document.getElementById('app-menu-panel').matches(':popover-open'),
    ),
    false,
  );
  await evaluate(() => window.pidev.setZoom(1));
  report.cases.push(
    'outside click dismisses menu and Open folder moves actions into the inspector',
  );

  for (const size of [
    [1100, 760],
    [1600, 1000],
  ]) {
    browser.setContentSize(...size);
    await delay(100);
    await evaluate(
      () =>
        new Promise(resolve =>
          window.requestAnimationFrame(() =>
            window.requestAnimationFrame(resolve),
          ),
        ),
    );
    const geometry = await evaluate(() => {
      const main = document.querySelector('main');
      const workspace = document.getElementById('factory-workspace');
      const output = document.getElementById('panel-conversation');
      const before = output.getBoundingClientRect().height;
      const top = workspace.getBoundingClientRect().top;
      const expectedTop =
        main.getBoundingClientRect().top +
        parseFloat(getComputedStyle(main).paddingTop);
      const oldToolbar = document.createElement('div');
      oldToolbar.style.cssText = 'height:40px;flex:0 0 40px';
      main.insertBefore(oldToolbar, workspace);
      const previous = output.getBoundingClientRect().height;
      oldToolbar.remove();
      return {top, expectedTop, before, previous, gained: before - previous};
    });
    assert.ok(
      Math.abs(geometry.top - geometry.expectedTop) <= 1,
      JSON.stringify(geometry),
    );
    assert.ok(geometry.gained >= 40, JSON.stringify({size, ...geometry}));
    await menu();
    assert.equal(
      await evaluate(
        () =>
          document.getElementById('panel-conversation').getBoundingClientRect()
            .height,
      ),
      geometry.before,
    );
    await key('Escape');
    browser.webContents.send('varisdev:update-status', {
      phase: 'available',
      currentVersion: '0.85.1',
      latestVersion: '0.86.0',
      restartRequired: false,
    });
    await waitFor(() => !document.getElementById('updates-button').hidden);
    const badge = await evaluate(() => {
      const badge = document.getElementById('updates-button');
      const row = document
        .querySelector('.inspector-title-row')
        .getBoundingClientRect();
      const rect = badge.getBoundingClientRect();
      return {
        outside: !document.getElementById('app-menu-panel').contains(badge),
        inHeader: badge.closest('.inspector-title-row') !== null,
        fits:
          rect.left >= row.left &&
          rect.right <= row.right &&
          rect.top >= row.top &&
          rect.bottom <= row.bottom,
        output: document
          .getElementById('panel-conversation')
          .getBoundingClientRect().height,
      };
    });
    assert.equal(badge.outside, true);
    assert.equal(badge.inHeader, true);
    assert.equal(badge.fits, true);
    assert.equal(badge.output, geometry.before);
    browser.webContents.send('varisdev:update-status', {
      phase: 'idle',
      currentVersion: '0.85.1',
      restartRequired: false,
    });
    await waitFor(() => document.getElementById('updates-button').hidden);
  }
  report.cases.push(
    '1100 and 1600 layouts reclaim output height and keep updates outside the overlay',
  );

  browser.setContentSize(1100, 760);
  await evaluate(() => window.pidev.setZoom(1.5));
  const at = new Date().toISOString();
  hub.sessions[0].agents = [
    {
      id: 'long-name',
      name: 'Repository maintenance and application update verification specialist',
      task: 'Review the update controls and project files.',
      cwd: directory,
      model: 'fixture/local',
      status: 'completed',
      activity: 'Review complete',
      createdAt: at,
      startedAt: at,
      finishedAt: at,
      output: 'Review complete.',
      conversation: [],
      conversationTruncated: false,
    },
  ];
  hub.sessions[0].totalAgents = 1;
  browser.webContents.send('pidev:snapshot', hub);
  browser.webContents.send('varisdev:update-status', {
    phase: 'available',
    currentVersion: '0.85.1',
    latestVersion: '0.86.0',
    restartRequired: false,
  });
  await waitFor(() => document.querySelector('.history-row'));
  await evaluate(() => document.querySelector('.history-row').click());
  await waitFor(
    () =>
      document.getElementById('inspector').dataset.conversationKind ===
      'primary',
  );
  const narrow = await evaluate(() => {
    const title = document.getElementById('inspector-title');
    const row = document
      .querySelector('.inspector-title-row')
      .getBoundingClientRect();
    const role = document.getElementById('conversation-kind-label');
    const activity = document.querySelector('.inspector-activity-row');
    return {
      titleWidth: title.getBoundingClientRect().width,
      titleFits: title.getBoundingClientRect().right <= row.right,
      roleText: role.textContent,
      roleFits: role.scrollWidth <= role.clientWidth,
      activityFits: activity.scrollWidth <= activity.clientWidth,
      badgeVisible: !document.getElementById('updates-button').hidden,
    };
  });
  assert.ok(narrow.titleWidth >= 80, JSON.stringify(narrow));
  assert.equal(narrow.titleFits, true);
  assert.equal(narrow.roleText, 'Primary agent');
  assert.equal(narrow.roleFits, true);
  assert.equal(narrow.activityFits, true);
  assert.equal(narrow.badgeVisible, true);
  await evaluate(() => document.getElementById('back-to-parent').click());
  await evaluate(() => window.pidev.setZoom(1));
  report.cases.push(
    'long agent names and visible updates remain readable at 1100 pixels with 150 percent zoom',
  );

  hub.sessions[0].session.status = 'running';
  hub.sessions[0].session.activity = 'Working';
  browser.webContents.send('pidev:snapshot', hub);
  await menu();
  await key('Escape');
  assert.equal(aborted, 0, 'Escape closes the menu before the Stop shortcut');
  report.cases.push('menu Escape does not stop a running parent session');
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
