/* global process, __dirname, document, window, getComputedStyle, setTimeout */
const assert = require('node:assert/strict');
const {writeFileSync, mkdirSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {app, BrowserWindow, ipcMain} = require('electron');
const [directory, reportPath] = process.argv.slice(2);
const report = {cases: []};
let browser;
let chosen = 0;
let aborted = 0;
let stateRequests = 0;
const rendererErrors = [];
let hub = {sessions: [], launchCwd: directory};
app.setPath('userData', join(directory, 'profile'));
app.setPath('sessionData', join(directory, 'session'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
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
async function waitFor(fn, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(fn)) return;
    await delay(20);
  }
  const state = await evaluate(() => ({
    hidden: document.hidden,
    readyState: document.readyState,
    workspaceHidden: document.getElementById('factory-workspace')?.hidden,
    columnHidden: document.getElementById('factory-column')?.hidden,
    layout: window.localStorage.getItem('varisdev.panel-layout.v1'),
    error: document.getElementById('app-error')?.textContent,
    url: window.location.href,
  }));
  throw new Error(
    `Timed out: ${fn}\n${JSON.stringify({state, stateRequests, rendererErrors})}`,
  );
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
async function settle() {
  await evaluate(
    () =>
      new Promise(resolve =>
        window.requestAnimationFrame(() =>
          window.requestAnimationFrame(resolve),
        ),
      ),
  );
}
async function reloadPage() {
  const loaded = new Promise(resolve =>
    browser.webContents.once('did-finish-load', resolve),
  );
  browser.reload();
  await loaded;
  await waitFor(
    () => !document.getElementById('factory-workspace').hidden,
    5000,
  );
  await settle();
}
function layoutState() {
  const style = (id, property) =>
    document.getElementById(id).style.getPropertyValue(property);
  return {
    visible: ['factory-panel', 'workspaces-panel', 'worker-panels'].map(
      id => !document.getElementById(id).hidden,
    ),
    checked: ['visualization', 'workspaces', 'agents'].map(
      key => document.getElementById(`layout-${key}`).checked,
    ),
    sizes: [
      style('factory-workspace', '--factory-width'),
      style('factory-column', '--workspaces-height'),
      style('factory-column', '--agents-height'),
      style('worker-panels', '--active-agents-width'),
    ],
    resized: document
      .getElementById('workspaces-panel')
      .classList.contains('resized'),
    promptHeight: style('parent-prompt', 'height'),
    promptValue: document.getElementById('parent-prompt').value,
    terminalHeight: style('terminal-sessions', '--composer-terminal-height'),
    terminalMax: style('terminal-sessions', '--composer-terminal-max-height'),
    saved: Object.fromEntries(
      [
        'panel-layout.v1',
        'panel-sizes.v1',
        'composer-heights.v1',
        'composer-terminal-height.v1',
      ].map(key => [key, window.localStorage.getItem(`varisdev.${key}`)]),
    ),
    drafts: JSON.parse(
      window.localStorage.getItem('varisdev.composer-drafts.v1') || '[]',
    ),
    theme: document.documentElement.dataset.theme,
    savedTheme: window.localStorage.getItem('varisdev.factory.theme'),
    zoom: window.pidev.getZoom(),
    savedZoom: window.localStorage.getItem('varisdev.factory.zoom'),
  };
}
async function assertResetLayout(before) {
  const state = await evaluate(layoutState);
  assert.deepEqual(state.visible, [true, true, true]);
  assert.deepEqual(state.checked, [true, true, true]);
  assert.deepEqual(state.sizes, ['', '', '', '']);
  assert.equal(state.resized, false);
  assert.equal(state.promptHeight, '');
  assert.equal(state.terminalHeight, '');
  assert.equal(state.terminalMax, '');
  for (const [key, value] of Object.entries(state.saved))
    assert.equal(value, null, `${key} must be removed`);
  assert.deepEqual(
    state.drafts,
    before.drafts.map(([id, draft]) => [id, {...draft, height: ''}]),
    'Reset preserves every unsent draft and its cursor position',
  );
  for (const key of ['theme', 'savedTheme', 'zoom', 'savedZoom'])
    assert.equal(state[key], before[key], `${key} must be preserved`);
}
async function startDrag(id, dx, dy) {
  const point = await evaluate(id => {
    const rect = document.getElementById(id).getBoundingClientRect();
    return {
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
    };
  }, id);
  browser.webContents.sendInputEvent({type: 'mouseMove', ...point});
  browser.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...point,
  });
  const end = {x: point.x + dx, y: point.y + dy};
  browser.webContents.sendInputEvent({type: 'mouseMove', ...end});
  await waitFor(() => Boolean(document.body.dataset.panelResizing));
  return async () => {
    browser.webContents.sendInputEvent({
      type: 'mouseUp',
      button: 'left',
      clickCount: 1,
      ...end,
    });
    await settle();
  };
}
function parent(id = 'project', name = 'Project') {
  const at = new Date().toISOString();
  return {
    session: {
      id,
      name,
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
  browser.webContents.on('console-message', details => {
    if (details.level === 'error') rendererErrors.push(details.message);
  });
  handle('pidev:get-state', () => {
    stateRequests++;
    return hub;
  });
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
  handle('pidev:open-terminal', () => ({generation: 1, sequence: 0, data: ''}));
  handle('pidev:terminal-resize', () => {});
  handle('pidev:terminal-write', () => {});
  handle('pidev:terminal-close', () => {});
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
      reset: {
        label: document.getElementById('layout-reset').textContent.trim(),
        direct: document
          .getElementById('layout-reset')
          .parentElement.classList.contains('app-menu-appearance'),
        inDetails:
          document.getElementById('layout-reset').closest('details') !== null,
      },
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
      ],
      appearance: ['app-zoom', 'factory-theme', 'motion-toggle'],
      settings: [
        'open-session-settings',
        'open-approvals',
        'open-model-settings',
        'open-environment',
        'open-accounts',
      ],
      maintenance: ['open-about'],
      reset: {label: 'Reset panel layout', direct: true, inDetails: false},
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

  const screenshots = resolve(__dirname, '../../.pi/tmp/panel-layout');
  mkdirSync(screenshots, {recursive: true});
  await menu();
  await evaluate(() => {
    document.querySelector('#app-menu-weapons summary').click();
    document.querySelector('.factory-gun-holster').focus();
  });
  await key('Space');
  assert.equal(
    await evaluate(() =>
      document
        .querySelector('.factory-gun-holster')
        .getAttribute('aria-pressed'),
    ),
    'true',
  );
  assert.equal(
    await evaluate(() =>
      document.getElementById('app-menu-panel').matches(':popover-open'),
    ),
    false,
  );
  await key('Escape');
  await menu();
  await evaluate(() => {
    document.querySelector('#app-menu-layout summary').click();
    document.getElementById('layout-visualization').focus();
  });
  await key('Space');
  await waitFor(() => document.getElementById('factory-panel').hidden);
  assert.equal(
    await evaluate(() => document.getElementById('app-menu-weapons').hidden),
    true,
  );
  await key('Escape');
  await evaluate(() => document.getElementById('factory-info-button').click());
  await waitFor(() =>
    document.getElementById('factory-info').matches(':popover-open'),
  );
  await key('Escape');
  assert.equal(
    await evaluate(
      () => document.getElementById('factory-info').getClientRects().length,
    ),
    0,
  );
  const themes = await evaluate(() =>
    [...document.getElementById('factory-theme').options].map(
      option => option.value,
    ),
  );
  for (const theme of themes) {
    await evaluate(theme => {
      const picker = document.getElementById('factory-theme');
      picker.value = theme;
      picker.dispatchEvent(new window.Event('change', {bubbles: true}));
    }, theme);
    await delay(70);
    writeFileSync(
      join(screenshots, `${theme}-hidden.png`),
      (await browser.webContents.capturePage()).toPNG(),
    );
    await menu();
    writeFileSync(
      join(screenshots, `${theme}-menu.png`),
      (await browser.webContents.capturePage()).toPNG(),
    );
    await key('Escape');
  }
  report.cases.push(
    'menu weapons support keyboard selection and hiding the scene preserves session info',
  );

  await menu();
  await evaluate(() => {
    document.getElementById('layout-workspaces').click();
    document.getElementById('layout-agents').click();
  });
  await key('Escape');
  await waitFor(() => document.getElementById('factory-column').hidden);
  assert.equal(
    await evaluate(() => {
      const workspace = document
        .getElementById('factory-workspace')
        .getBoundingClientRect();
      const inspector = document
        .getElementById('inspector')
        .getBoundingClientRect();
      return Math.abs(workspace.width - inspector.width) < 2;
    }),
    true,
  );
  await evaluate(() => document.querySelector('.skip-link').focus());
  await key('Enter');
  assert.equal(await evaluate(() => document.activeElement.id), 'inspector');
  const loaded = new Promise(resolve =>
    browser.webContents.once('did-finish-load', resolve),
  );
  browser.reload();
  await loaded;
  await waitFor(
    () =>
      !document.getElementById('factory-workspace').hidden &&
      document.getElementById('factory-column').hidden,
    5000,
  );
  assert.equal(
    await evaluate(
      () => document.getElementById('layout-visualization').checked,
    ),
    false,
  );
  browser.setContentSize(1100, 760);
  await evaluate(() => window.pidev.setZoom(1.5));
  await delay(100);
  writeFileSync(
    join(screenshots, 'conversation-only-zoom.png'),
    (await browser.webContents.capturePage()).toPNG(),
  );
  await menu();
  await evaluate(() => document.getElementById('layout-reset').click());
  await key('Escape');
  await waitFor(() => !document.getElementById('factory-panel').hidden);
  assert.equal(
    await evaluate(
      () =>
        document.getElementById('factory-info').closest('#factory-panel') !==
        null,
    ),
    true,
  );
  assert.equal(
    await evaluate(() => {
      const page = document.scrollingElement;
      return (
        page.scrollHeight <= page.clientHeight &&
        page.scrollWidth <= page.clientWidth
      );
    }),
    true,
  );
  await evaluate(() => window.pidev.setZoom(1));
  for (const flags of [
    [true, false, true],
    [true, true, false],
    [true, false, false],
    [false, true, false],
    [false, false, true],
  ]) {
    await menu();
    await evaluate(flags => {
      for (const [index, key] of [
        'visualization',
        'workspaces',
        'agents',
      ].entries()) {
        const input = document.getElementById(`layout-${key}`);
        if (input.checked !== flags[index]) input.click();
      }
    }, flags);
    await key('Escape');
    await delay(60);
    const layout = await evaluate(() => {
      const page = document.scrollingElement;
      return {
        fits:
          page.scrollHeight <= page.clientHeight &&
          page.scrollWidth <= page.clientWidth,
        panels: ['factory-panel', 'workspaces-panel', 'worker-panels'].map(
          id => {
            const element = document.getElementById(id);
            const rect = element.getBoundingClientRect();
            return {
              hidden: element.hidden,
              height: rect.height,
              bottom: rect.bottom,
            };
          },
        ),
        bottom: window.innerHeight,
      };
    });
    assert.equal(layout.fits, true, JSON.stringify({flags, layout}));
    for (const panel of layout.panels)
      if (!panel.hidden)
        assert.ok(
          panel.height > 50 && panel.bottom <= layout.bottom,
          JSON.stringify({flags, layout}),
        );
  }
  await menu();
  await evaluate(() => document.getElementById('layout-reset').click());
  await key('Escape');
  report.cases.push(
    'panel layout persists across reload and can restore every panel at compact zoom',
  );

  browser.setContentSize(1600, 1000);
  hub.sessions.push(parent('other-project', 'Other project'));
  browser.webContents.send('pidev:snapshot', hub);
  await waitFor(() => document.querySelectorAll('.parent-card').length === 2);
  await settle();
  for (const [id, keyCode] of [
    ['conversation', 'Left'],
    ['workspaces', 'Home'],
    ['agents', 'Home'],
    ['history', 'Home'],
  ]) {
    await evaluate(id => document.getElementById(`${id}-resize`).focus(), id);
    await key(keyCode);
  }
  const drafts = {
    project: 'Keep the current unsent draft\nwith its selection.',
    'other-project': 'Keep the other conversation draft.',
  };
  for (const id of ['project', 'other-project']) {
    await evaluate(
      id =>
        document
          .querySelector(`.parent-card[data-context-session="${id}"]`)
          .click(),
      id,
    );
    await evaluate(value => {
      const editor = document.getElementById('parent-prompt');
      editor.value = value;
      editor.setSelectionRange(5, 12);
      editor.dispatchEvent(new window.Event('input', {bubbles: true}));
      document.getElementById('composer-resize').focus();
    }, drafts[id]);
    await key('Up');
    await key('Up');
  }
  await evaluate(() =>
    document
      .querySelector('.parent-card[data-context-session="project"]')
      .click(),
  );
  await evaluate(() => document.getElementById('terminal-tab').click());
  await waitFor(
    () =>
      document.querySelector('#terminal-sessions .xterm') &&
      document
        .getElementById('composer-resize')
        .getAttribute('aria-controls') === 'terminal-sessions',
  );
  await evaluate(() => document.getElementById('composer-resize').focus());
  await key('Up');
  await key('Up');
  await evaluate(() => document.getElementById('prompt-tab').click());
  await waitFor(
    () =>
      document
        .getElementById('composer-resize')
        .getAttribute('aria-controls') === 'parent-prompt',
  );
  const resized = await evaluate(layoutState);
  assert.ok(resized.sizes.every(Boolean), JSON.stringify(resized));
  assert.deepEqual(
    Object.keys(JSON.parse(resized.saved['panel-sizes.v1'])).sort(),
    ['agents', 'conversation', 'history', 'workspaces'],
  );
  assert.ok(resized.terminalHeight && resized.terminalMax);
  assert.equal(resized.drafts.length, 2);
  assert.ok(resized.drafts.every(([, draft]) => draft.height));
  assert.equal(JSON.parse(resized.saved['composer-heights.v1']).length, 2);

  await menu();
  await evaluate(() => {
    for (const key of ['visualization', 'workspaces', 'agents'])
      document.getElementById(`layout-${key}`).click();
  });
  await key('Escape');
  await waitFor(() => document.getElementById('factory-column').hidden);
  browser.setContentSize(1100, 760);
  await evaluate(() => window.pidev.setZoom(1.5));
  await settle();
  await menu();
  await evaluate(() => {
    document.getElementById('app-menu-layout').open = false;
    document.getElementById('layout-reset').scrollIntoView({block: 'nearest'});
  });
  const resetAccess = await evaluate(() => {
    const rect = id => document.getElementById(id).getBoundingClientRect();
    const menu = rect('app-menu-panel');
    const button = rect('app-menu-button');
    const reset = rect('layout-reset');
    const page = document.scrollingElement;
    return {
      fits: [button, menu].every(
        rect =>
          rect.left >= 0 &&
          rect.top >= 0 &&
          rect.right <= window.innerWidth &&
          rect.bottom <= window.innerHeight,
      ),
      resetFits: reset.top >= menu.top && reset.bottom <= menu.bottom,
      pageFits:
        page.scrollWidth <= page.clientWidth &&
        page.scrollHeight <= page.clientHeight,
    };
  });
  assert.deepEqual(resetAccess, {fits: true, resetFits: true, pageFits: true});
  writeFileSync(
    join(screenshots, 'reset-all-hidden-menu-zoom.png'),
    (await browser.webContents.capturePage()).toPNG(),
  );
  const beforeReset = await evaluate(layoutState);
  assert.ok(
    beforeReset.sizes.every(Boolean),
    'Hidden panels retain stale inline dimensions before reset',
  );
  await evaluate(() => document.getElementById('layout-reset').focus());
  await key('Space');
  await assertResetLayout(beforeReset);
  await key('Escape');
  await settle();
  writeFileSync(
    join(screenshots, 'reset-defaults-zoom.png'),
    (await browser.webContents.capturePage()).toPNG(),
  );
  await reloadPage();
  await assertResetLayout(beforeReset);
  assert.equal(
    await evaluate(() => document.getElementById('parent-prompt').value),
    drafts.project,
  );
  await evaluate(() =>
    document
      .querySelector('.parent-card[data-context-session="other-project"]')
      .click(),
  );
  assert.equal(
    await evaluate(() => document.getElementById('parent-prompt').value),
    drafts['other-project'],
  );
  await assertResetLayout(beforeReset);
  await evaluate(() =>
    document
      .querySelector('.parent-card[data-context-session="project"]')
      .click(),
  );
  await assertResetLayout(beforeReset);
  report.cases.push(
    'Reset panel layout clears hidden split sizes terminal and all draft heights immediately and across reload while preserving drafts theme and zoom',
  );

  browser.setContentSize(1600, 1000);
  await evaluate(() => window.pidev.setZoom(1));
  await settle();
  for (const [id, keyCode, dx, dy] of [
    ['conversation-resize', 'Left', 36, 0],
    ['composer-resize', 'Up', 0, -36],
  ]) {
    await evaluate(id => document.getElementById(id).focus(), id);
    await key(keyCode);
    const before = await evaluate(layoutState);
    const release = await startDrag(id, dx, dy);
    await evaluate(() => document.getElementById('layout-reset').click());
    assert.equal(
      await evaluate(() => document.body.dataset.panelResizing),
      undefined,
    );
    await assertResetLayout(before);
    await release();
    await assertResetLayout(before);
  }
  report.cases.push(
    'layout reset cancels active panel and composer drags before clearing their saved sizes',
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
