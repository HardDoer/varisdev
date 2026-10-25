/* global process, __dirname, document, window, setTimeout */
const assert = require('node:assert/strict');
const {writeFileSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {app, BrowserWindow, ipcMain} = require('electron');
const [directory, reportPath, screenshots] = process.argv.slice(2);
const report = {cases: [], themes: [], screenshots: []};
function saveReport() {
  writeFileSync(reportPath, JSON.stringify(report));
  writeFileSync(
    join(screenshots, 'report.json'),
    JSON.stringify(report, null, 2),
  );
}
const at = '2026-01-01T12:00:00.000Z';
let browser;
let hub;
let calls = [];
let rendererErrors = [];
let failures = new Map();
let stateRequests = 0;

app.setPath('userData', join(directory, 'profile'));
app.setPath('sessionData', join(directory, 'session'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.on('window-all-closed', () => {});

function agent(id, name, status, extra = {}) {
  return {
    id,
    name,
    task: 'Review the workspace and report the result.',
    cwd: directory,
    model: 'fixture/local',
    status,
    activity: status === 'running' ? 'Reviewing the project' : status,
    createdAt: at,
    startedAt: at,
    ...(['completed', 'failed', 'cancelled'].includes(status)
      ? {finishedAt: at}
      : {}),
    output: status === 'completed' ? 'Review complete.' : '',
    conversation: [],
    conversationTruncated: false,
    ...extra,
  };
}
function parent(id, name) {
  const agents = [
    agent('review', 'Review agent', 'running', {agentMode: 'subagent'}),
    agent('queued', 'Queued agent', 'queued', {agentMode: 'subagent'}),
    agent('finished', 'Finished agent', 'completed'),
    agent('failed', 'Failed agent', 'failed'),
    agent('stopping', 'Stopping agent', 'cancelling', {agentMode: 'subagent'}),
  ];
  return {
    session: {
      id,
      name,
      cwd: join(directory, id),
      model: 'fixture/local',
      status: 'running',
      activity: 'Reviewing workspace changes',
      startedAt: at,
      updatedAt: at,
      owned: true,
      controllable: true,
    },
    agents,
    totalAgents: agents.length,
    events: [],
    changes: [],
    conversation: [
      {
        id: `${id}-user`,
        role: 'user',
        text: 'Review the workspace changes.',
        at,
      },
      {
        id: `${id}-assistant`,
        role: 'assistant',
        text: 'I am reviewing the changes and coordinating the agents.',
        at,
      },
    ],
    conversationTruncated: false,
    queue: {steering: [], followUp: []},
  };
}
function initialHub() {
  return {
    selectedSessionId: 'alpha',
    launchCwd: directory,
    sessions: [
      parent('alpha', 'Orchard workspace'),
      parent('beta', 'Harbor workspace'),
    ],
  };
}
function handle(channel, action) {
  ipcMain.handle(channel, async (event, ...args) => {
    assert.equal(event.sender, browser.webContents);
    try {
      return {ok: true, value: await action(...args)};
    } catch (error) {
      return {ok: false, error: error.message || String(error)};
    }
  });
}
function record(action, ...args) {
  calls.push([action, ...args]);
  if (failures.has(action)) throw new Error(failures.get(action));
}
async function evaluate(fn, arg) {
  const result = await browser.webContents.executeJavaScript(`(async () => {
    try { return {value: await (${fn.toString()})(${JSON.stringify(arg)})}; }
    catch (error) { return {error: error.stack || String(error)}; }
  })()`);
  if (result.error) throw new Error(result.error);
  return result.value;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, arg, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(fn, arg)) return;
    await delay(20);
  }
  const state = await evaluate(() => ({
    title: document.getElementById('inspector-title')?.textContent,
    menu: document.getElementById('item-context-menu')?.outerHTML,
    error: document.getElementById('app-error')?.textContent,
    selected: document.querySelector('.parent-card.selected')?.dataset
      .sessionId,
    active: {
      tag: document.activeElement?.tagName,
      id: document.activeElement?.id,
      data: {...document.activeElement?.dataset},
    },
    layout: window.localStorage.getItem('varisdev.panel-layout.v1'),
  }));
  throw new Error(
    `Timed out: ${fn}\n${JSON.stringify({state, calls, stateRequests, rendererErrors})}`,
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
async function key(keyCode, modifiers = []) {
  keyCode =
    {ArrowDown: 'Down', ArrowUp: 'Up', Enter: 'Return'}[keyCode] || keyCode;
  browser.focus();
  browser.webContents.focus();
  browser.webContents.sendInputEvent({type: 'keyDown', keyCode, modifiers});
  if (
    (/^[a-z0-9]$/i.test(keyCode) || keyCode === 'Return') &&
    modifiers.length === 0
  )
    browser.webContents.sendInputEvent({type: 'char', keyCode});
  browser.webContents.sendInputEvent({type: 'keyUp', keyCode, modifiers});
  await delay(35);
}
async function click(selector, button = 'left') {
  const point = await evaluate(selector => {
    const target = document.querySelector(selector);
    if (!target) throw new Error(`Missing click target: ${selector}`);
    target.scrollIntoView({block: 'nearest', inline: 'nearest'});
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height)
      throw new Error(`Hidden click target: ${selector}`);
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    };
  }, selector);
  const zoom = browser.webContents.getZoomFactor();
  const position = {
    x: Math.round(point.x * zoom),
    y: Math.round(point.y * zoom),
  };
  browser.webContents.sendInputEvent({
    type: 'mouseDown',
    button,
    clickCount: 1,
    ...position,
  });
  browser.webContents.sendInputEvent({
    type: 'mouseUp',
    button,
    clickCount: 1,
    ...position,
  });
  await delay(35);
}
async function openMenu(selector = '#item-actions-button') {
  await click(selector, selector === '#item-actions-button' ? 'left' : 'right');
  await waitFor(() =>
    document.getElementById('item-context-menu').matches(':popover-open'),
  );
}
async function closed() {
  await waitFor(
    () =>
      !document.getElementById('item-context-menu').matches(':popover-open'),
  );
}
async function selected(id, name) {
  await waitFor(
    id =>
      document
        .querySelector(`.parent-card[data-context-session="${id}"]`)
        ?.classList.contains('selected'),
    id,
  );
  if (name)
    await waitFor(
      name => document.getElementById('inspector-title').textContent === name,
      name,
    );
}
async function act(id) {
  await click(`#${id}`);
  await closed();
  await settle();
}
async function reload() {
  await browser.loadFile(
    resolve(__dirname, '../../assets/dashboard/index.html'),
  );
  await waitFor(() => document.querySelectorAll('.parent-card').length === 2);
  await settle();
}
async function check(name, fn) {
  report.activeCase = name;
  saveReport();
  try {
    hub = initialHub();
    calls = [];
    failures = new Map();
    rendererErrors = [];
    await evaluate(() => {
      window.localStorage.clear();
      window.pidev.setZoom(1);
    });
    browser.setContentSize(1500, 1000);
    await reload();
    await fn();
    assert.deepEqual(rendererErrors, [], 'Renderer has no unhandled errors');
    report.cases.push({name});
  } catch (error) {
    report.cases.push({name, error: error.stack || String(error)});
  }
  delete report.activeCase;
  saveReport();
}
async function capture(name) {
  report.capture = name;
  saveReport();
  await delay(100);
  await settle();
  const path = join(screenshots, name);
  writeFileSync(path, (await browser.webContents.capturePage()).toPNG());
  report.screenshots.push(path);
  delete report.capture;
  saveReport();
}
function createBrowser() {
  const result = new BrowserWindow({
    show: true,
    width: 1500,
    height: 1000,
    webPreferences: {
      preload: resolve(__dirname, '../../assets/desktop/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  result.webContents.on('console-message', details => {
    if (details.level === 'error') rendererErrors.push(details.message);
  });
  return result;
}
async function main() {
  await app.whenReady();
  browser = createBrowser();
  handle('pidev:get-state', () => {
    stateRequests++;
    return hub;
  });
  handle('pidev:recent-projects', () => []);
  handle('varisdev:get-agent-notice', () => ({acknowledged: true}));
  handle('varisdev:get-update-status', () => ({
    phase: 'idle',
    currentVersion: '1.6.0',
    restartRequired: false,
  }));
  handle('varisdev:app-themes', () => ({themes: [], errors: []}));
  handle('pidev:session-features', () => ({
    commands: [],
    tools: [],
    models: [],
    diagnostics: [],
    thinkingLevel: 'off',
    thinkingLevels: ['off'],
  }));
  handle('pidev:close-session', id => {
    record('close', id);
    hub.sessions = hub.sessions.filter(item => item.session.id !== id);
    return {id};
  });
  handle('pidev:create-session', input => {
    record('create', input);
    const replacement = parent('replacement', 'Replacement workspace');
    replacement.session.cwd = input.cwd;
    hub.sessions.push(replacement);
    return {id: 'replacement'};
  });
  handle('pidev:agent-session', (ownerId, request) => {
    if (request.action === 'features')
      return {
        commands: [],
        tools: [],
        models: [],
        diagnostics: [],
        thinkingLevel: 'off',
        thinkingLevels: ['off'],
      };
    record('agent-session', ownerId, request);
    assert.equal(request.action, 'close');
    const data = hub.sessions.find(item => item.session.id === ownerId);
    data.agents = data.agents.filter(item => item.id !== request.agentId);
    data.totalAgents = data.agents.length;
    return {agentId: request.agentId};
  });
  handle('pidev:cancel-agent', (ownerId, agentId) => {
    record('cancel', ownerId, agentId);
    const data = hub.sessions.find(item => item.session.id === ownerId);
    for (const item of data.agents) {
      if (
        (agentId === 'all' || item.id === agentId) &&
        ['running', 'queued'].includes(item.status)
      ) {
        item.status = 'cancelled';
        item.activity = 'Cancelled';
        item.finishedAt = at;
      }
    }
    browser.webContents.send('pidev:snapshot', hub);
    return {};
  });
  handle('pidev:abort-session', id => {
    record('abort', id);
    return {steering: [], followUp: []};
  });
  hub = initialHub();
  await reload();

  await check(
    'right click selects another workspace before closing its target',
    async () => {
      await selected('alpha', 'Orchard workspace');
      await openMenu('.parent-card[data-context-session="beta"]');
      await selected('beta', 'Harbor workspace');
      assert.deepEqual(
        await evaluate(() => ({
          role: document
            .getElementById('item-context-menu')
            .getAttribute('role'),
          title: document.getElementById('item-context-menu-title').textContent,
          close: document.getElementById('close-session').textContent.trim(),
          closeInContext: document
            .getElementById('item-context-menu')
            .contains(document.getElementById('close-session')),
          closeInApp: document
            .getElementById('app-menu-panel')
            .contains(document.getElementById('close-session')),
          oldClose: document.getElementById('close-parent-session') !== null,
          resetInApp: document
            .getElementById('app-menu-panel')
            .contains(document.getElementById('start-session')),
          resetVisible: !document.getElementById('reset-item-session').hidden,
          cancelAllVisible:
            !document.getElementById('cancel-all-agents').hidden,
          cancelOneHidden: document.getElementById('cancel-agent').hidden,
          removeHidden: document.getElementById('remove-agent').hidden,
        })),
        {
          role: 'menu',
          title: 'Harbor workspace',
          close: 'Close workspace',
          closeInContext: true,
          closeInApp: false,
          oldClose: false,
          resetInApp: true,
          resetVisible: true,
          cancelAllVisible: true,
          cancelOneHidden: true,
          removeHidden: true,
        },
      );
      await act('close-session');
      await selected('alpha', 'Orchard workspace');
      assert.deepEqual(calls, [['close', 'beta']]);
      assert.equal(
        await evaluate(
          () =>
            document.querySelector(
              '.parent-card[data-context-session="beta"]',
            ) === null,
        ),
        true,
      );
    },
  );

  await check(
    'agent close routes the selected card through owner and agent ids',
    async () => {
      await click('.parent-card[data-context-session="beta"]');
      await openMenu('.worker-card[data-context-unit="review"]');
      await waitFor(
        () =>
          document.getElementById('inspector-title').textContent ===
          'Review agent',
      );
      assert.deepEqual(
        await evaluate(() => ({
          title: document.getElementById('item-context-menu-title').textContent,
          close: document.getElementById('close-session').textContent.trim(),
          resetHidden: document.getElementById('reset-item-session').hidden,
          cancelAllHidden: document.getElementById('cancel-all-agents').hidden,
          cancelEnabled: !document.getElementById('cancel-agent').disabled,
          removeHidden: document.getElementById('remove-agent').hidden,
        })),
        {
          title: 'Review agent',
          close: 'Close agent',
          resetHidden: true,
          cancelAllHidden: true,
          cancelEnabled: true,
          removeHidden: true,
        },
      );
      await act('close-session');
      await selected('beta', 'Harbor workspace');
      assert.deepEqual(calls, [
        ['agent-session', 'beta', {agentId: 'review', action: 'close'}],
      ]);
      assert.equal(
        await evaluate(
          () =>
            document.querySelector(
              '.worker-card[data-context-unit="review"]',
            ) === null,
        ),
        true,
      );
    },
  );

  await check(
    'workspace and individual cancellation reuse the selected owner',
    async () => {
      await openMenu('.parent-card[data-context-session="beta"]');
      await act('cancel-all-agents');
      await waitFor(() =>
        document.querySelector('.history-row[data-context-unit="review"]'),
      );
      assert.deepEqual(calls, [['cancel', 'beta', 'all']]);
      assert.equal(
        hub.sessions[0].agents.find(item => item.id === 'review').status,
        'running',
      );
      await click('.parent-card[data-context-session="alpha"]');
      await openMenu('.worker-card[data-context-unit="queued"]');
      await act('cancel-agent');
      await waitFor(() =>
        document.querySelector('.history-row[data-context-unit="queued"]'),
      );
      assert.deepEqual(calls, [
        ['cancel', 'beta', 'all'],
        ['cancel', 'alpha', 'queued'],
      ]);
    },
  );

  await check(
    'removing finished history persists per workspace across renderer reload',
    async () => {
      await click('.parent-card[data-context-session="beta"]');
      await openMenu('.history-row[data-context-unit="finished"]');
      assert.equal(
        await evaluate(
          () =>
            !document.getElementById('remove-agent').hidden &&
            !document.getElementById('remove-agent').disabled,
        ),
        true,
      );
      await act('remove-agent');
      await waitFor(
        () =>
          document.querySelector(
            '.history-row[data-context-unit="finished"]',
          ) === null,
      );
      assert.deepEqual(
        await evaluate(() =>
          JSON.parse(
            window.localStorage.getItem('varisdev.dismissed-agents.v1'),
          ),
        ),
        [['beta', ['finished']]],
      );
      assert.deepEqual(calls, []);
      assert.ok(
        hub.sessions[1].agents.some(item => item.id === 'finished'),
        'Removal filters saved display state',
      );
      await reload();
      await click('.parent-card[data-context-session="beta"]');
      assert.equal(
        await evaluate(
          () =>
            document.querySelector(
              '.history-row[data-context-unit="finished"]',
            ) === null,
        ),
        true,
      );
      await click('.parent-card[data-context-session="alpha"]');
      assert.equal(
        await evaluate(
          () =>
            document.querySelector(
              '.history-row[data-context-unit="finished"]',
            ) !== null,
        ),
        true,
      );
    },
  );

  await check(
    'close and cancel failures remain visible after the menu dismisses',
    async () => {
      failures.set('close', 'Workspace close failed');
      await openMenu('.parent-card[data-context-session="beta"]');
      await act('close-session');
      await waitFor(
        () =>
          !document.getElementById('app-error').hidden &&
          document
            .getElementById('app-error')
            .textContent.includes('Workspace close failed'),
      );
      assert.equal(
        await evaluate(
          () =>
            document.querySelector(
              '.parent-card[data-context-session="beta"]',
            ) !== null,
        ),
        true,
      );
      failures.set('agent-session', 'Agent close failed');
      await openMenu('.worker-card[data-context-unit="review"]');
      await act('close-session');
      await waitFor(
        () =>
          !document.getElementById('app-error').hidden &&
          document
            .getElementById('app-error')
            .textContent.includes('Agent close failed'),
      );
      failures.set('cancel', 'Agent cancellation failed');
      await openMenu();
      await act('cancel-agent');
      await waitFor(
        () =>
          !document.getElementById('cancel-agent-error').hidden &&
          document.getElementById('cancel-agent-error').textContent ===
            'Agent cancellation failed',
      );
      assert.equal(
        await evaluate(
          () =>
            document
              .getElementById('cancel-agent-error')
              .getBoundingClientRect().height > 0,
        ),
        true,
      );
      await openMenu('.parent-card[data-context-session="beta"]');
      await act('cancel-all-agents');
      await waitFor(
        () =>
          !document.getElementById('cancel-all-agents-error').hidden &&
          document.getElementById('cancel-all-agents-error').textContent ===
            'Agent cancellation failed',
      );
      assert.equal(
        await evaluate(
          () =>
            document
              .getElementById('cancel-all-agents-error')
              .getBoundingClientRect().height > 0,
        ),
        true,
      );
      assert.deepEqual(calls, [
        ['close', 'beta'],
        ['agent-session', 'beta', {agentId: 'review', action: 'close'}],
        ['cancel', 'beta', 'review'],
        ['cancel', 'beta', 'all'],
      ]);
    },
  );

  await check(
    'card keyboard menus navigate all enabled actions and Escape performs no action',
    async () => {
      await evaluate(() =>
        document
          .querySelector('.parent-card[data-context-session="beta"]')
          .focus(),
      );
      await key('F10', ['shift']);
      await waitFor(() =>
        document.getElementById('item-context-menu').matches(':popover-open'),
      );
      await selected('beta', 'Harbor workspace');
      const ids = await evaluate(() =>
        [...document.querySelectorAll('#item-context-menu [role="menuitem"]')]
          .filter(
            item =>
              !item.hidden && !item.disabled && item.getClientRects().length,
          )
          .map(item => item.id),
      );
      assert.ok(ids.length >= 3, JSON.stringify(ids));
      assert.equal(await evaluate(() => document.activeElement.id), ids[0]);
      await key('ArrowDown');
      assert.equal(await evaluate(() => document.activeElement.id), ids[1]);
      await key('End');
      assert.equal(await evaluate(() => document.activeElement.id), ids.at(-1));
      await key('ArrowDown');
      assert.equal(await evaluate(() => document.activeElement.id), ids[0]);
      await key('ArrowUp');
      assert.equal(await evaluate(() => document.activeElement.id), ids.at(-1));
      await key('Home');
      assert.equal(await evaluate(() => document.activeElement.id), ids[0]);
      await key('Escape');
      await closed();
      assert.equal(
        await evaluate(() => document.activeElement.dataset.contextSession),
        'beta',
      );
      await evaluate(() =>
        document
          .querySelector('.worker-card[data-context-unit="review"]')
          .focus(),
      );
      await evaluate(() =>
        document.activeElement.dispatchEvent(
          new window.KeyboardEvent('keydown', {
            key: 'ContextMenu',
            code: 'ContextMenu',
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      await waitFor(() =>
        document.getElementById('item-context-menu').matches(':popover-open'),
      );
      await waitFor(
        () =>
          document.getElementById('inspector-title').textContent ===
          'Review agent',
      );
      await key('Escape');
      await closed();
      assert.equal(
        await evaluate(() => document.activeElement.dataset.contextUnit),
        'review',
      );
      assert.deepEqual(
        calls,
        [],
        'Escape must not close or stop a conversation',
      );
    },
  );

  await check(
    'Actions supports keyboard activation and outside click dismisses without an action',
    async () => {
      assert.equal(
        await evaluate(() =>
          document.getElementById('item-actions-button').textContent.trim(),
        ),
        'Actions',
      );
      await evaluate(() =>
        document.getElementById('item-actions-button').focus(),
      );
      await key('Space');
      await waitFor(() =>
        document.getElementById('item-context-menu').matches(':popover-open'),
      );
      assert.equal(
        await evaluate(() =>
          document
            .getElementById('item-actions-button')
            .getAttribute('aria-expanded'),
        ),
        'true',
      );
      await key('Escape');
      await closed();
      assert.equal(
        await evaluate(() => document.activeElement.id),
        'item-actions-button',
      );
      await key('Enter');
      await waitFor(() =>
        document.getElementById('item-context-menu').matches(':popover-open'),
      );
      await click('#parent-prompt');
      await closed();
      assert.equal(
        await evaluate(() =>
          document
            .getElementById('item-actions-button')
            .getAttribute('aria-expanded'),
        ),
        'false',
      );
      assert.deepEqual(calls, []);
    },
  );

  await check(
    'selection and hidden panels dismiss menus and retain Actions access',
    async () => {
      await openMenu('.worker-card[data-context-unit="review"]');
      await evaluate(() =>
        document
          .querySelector('.history-row[data-context-unit="finished"]')
          .click(),
      );
      await closed();
      await waitFor(
        () =>
          document.getElementById('inspector-title').textContent ===
          'Finished agent',
      );
      await openMenu();
      browser.webContents.send('varisdev:select-session', 'beta');
      await selected('beta', 'Harbor workspace');
      await closed();
      await openMenu();
      await evaluate(() =>
        document.getElementById('layout-visualization').click(),
      );
      await closed();
      await waitFor(() => document.getElementById('factory-panel').hidden);
      await openMenu('.parent-card[data-context-session="alpha"]');
      await selected('alpha', 'Orchard workspace');
      await key('Escape');
      await openMenu();
      await capture('hidden-visualization-actions.png');
      await act('close-session');
      await selected('beta', 'Harbor workspace');
      await openMenu('.parent-card[data-context-session="beta"]');
      await act('close-session');
      await waitFor(() => !document.getElementById('welcome').hidden);
      assert.deepEqual(calls, [
        ['close', 'alpha'],
        ['close', 'beta'],
      ]);
    },
  );

  await check(
    'a snapshot selection change blocks stale menu activation before the next render',
    async () => {
      await openMenu('.parent-card[data-context-session="alpha"]');
      await evaluate(() => {
        window.itemMenuRace = {called: false};
        window.itemMenuRace.dispose = window.pidev.onSnapshot(() => {
          window.itemMenuRace.called = true;
          window.itemMenuRace.openAtClick = document
            .getElementById('item-context-menu')
            .matches(':popover-open');
          window.itemMenuRace.titleAtClick = document.getElementById(
            'item-context-menu-title',
          ).textContent;
          document.getElementById('close-session').click();
        });
      });
      try {
        hub.sessions = hub.sessions.filter(item => item.session.id !== 'alpha');
        hub.selectedSessionId = 'beta';
        browser.webContents.send('pidev:snapshot', hub);
        await waitFor(() => window.itemMenuRace.called);
        await selected('beta', 'Harbor workspace');
        await closed();
        assert.deepEqual(
          await evaluate(() => ({
            open: window.itemMenuRace.openAtClick,
            title: window.itemMenuRace.titleAtClick,
          })),
          {open: true, title: 'Orchard workspace'},
        );
        assert.deepEqual(
          calls,
          [],
          'A stale action cannot close the replacement selection',
        );
        assert.deepEqual(
          hub.sessions.map(item => item.session.id),
          ['beta'],
        );
      } finally {
        await evaluate(() => {
          window.itemMenuRace.dispose();
          delete window.itemMenuRace;
        });
      }
    },
  );

  for (const kind of ['workspace', 'agent']) {
    await check(
      `stale ${kind} cards and inspector controls cannot open another workspace's menu before paint`,
      async () => {
        const selector =
          kind === 'workspace'
            ? '.parent-card[data-context-session="alpha"]'
            : '.worker-card[data-context-unit="review"]';
        if (kind === 'agent') await click(selector);
        await closed();
        await evaluate(selector => {
          const sources = [
            document.querySelector(selector),
            document.getElementById('inspector-title'),
            document.getElementById('item-actions-button'),
          ];
          window.staleMenuOpening = {called: false, results: []};
          window.staleMenuOpening.dispose = window.pidev.onSnapshot(() => {
            const result = window.staleMenuOpening;
            result.called = true;
            for (const source of sources) {
              const bounds = source.getBoundingClientRect();
              const before = {
                connected: source.isConnected,
                owner: source.dataset.contextSession,
              };
              source.dispatchEvent(
                new window.MouseEvent('contextmenu', {
                  bubbles: true,
                  cancelable: true,
                  clientX: bounds.left + bounds.width / 2,
                  clientY: bounds.top + bounds.height / 2,
                }),
              );
              result.results.push({
                ...before,
                opened: document
                  .getElementById('item-context-menu')
                  .matches(':popover-open'),
              });
            }
            sources[2].click();
            result.actionsOpened = document
              .getElementById('item-context-menu')
              .matches(':popover-open');
          });
        }, selector);
        try {
          hub.sessions = hub.sessions.filter(
            item => item.session.id !== 'alpha',
          );
          hub.selectedSessionId = 'beta';
          assert.ok(hub.sessions[0].agents.some(item => item.id === 'review'));
          browser.webContents.send('pidev:snapshot', hub);
          await waitFor(() => window.staleMenuOpening.called);
          await selected('beta', 'Harbor workspace');
          await closed();
          assert.deepEqual(
            await evaluate(() => ({
              results: window.staleMenuOpening.results,
              actionsOpened: window.staleMenuOpening.actionsOpened,
            })),
            {
              results: Array.from({length: 3}, () => ({
                connected: true,
                owner: 'alpha',
                opened: false,
              })),
              actionsOpened: false,
            },
          );
          assert.deepEqual(
            calls,
            [],
            'A lingering source cannot act on the replacement workspace',
          );
          assert.deepEqual(
            hub.sessions.map(item => item.session.id),
            ['beta'],
          );
        } finally {
          await evaluate(() => {
            window.staleMenuOpening.dispose();
            delete window.staleMenuOpening;
          });
        }
      },
    );
  }

  await check(
    'scene labels and inspector title open the selected agent actions',
    async () => {
      await waitFor(() =>
        document.querySelector(
          '.scene-label[data-context-unit="review"], .fallback-station[data-context-unit="review"]',
        ),
      );
      const selector = await evaluate(() =>
        document.querySelector('.scene-label[data-context-unit="review"]')
          ? '.scene-label[data-context-unit="review"]'
          : '.fallback-station[data-context-unit="review"]',
      );
      await openMenu(selector);
      await waitFor(
        () =>
          document.getElementById('inspector-title').textContent ===
          'Review agent',
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('item-context-menu-title').textContent,
        ),
        'Review agent',
      );
      await key('Escape');
      await openMenu('#inspector-title');
      assert.equal(
        await evaluate(() =>
          document.getElementById('close-session').textContent.trim(),
        ),
        'Close agent',
      );
      await key('Escape');
      assert.equal(
        await evaluate(() => document.activeElement.id),
        'item-actions-button',
      );
      assert.deepEqual(calls, []);
    },
  );

  await check(
    'context reset uses the target workspace id and keeps reset recovery in the app menu',
    async () => {
      await openMenu('.parent-card[data-context-session="beta"]');
      await act('reset-item-session');
      await waitFor(
        () =>
          document.getElementById('inspector-title').textContent ===
          'Replacement workspace',
      );
      assert.deepEqual(calls, [
        ['close', 'beta'],
        ['create', {cwd: join(directory, 'beta')}],
      ]);
      assert.ok(hub.sessions.some(item => item.session.id === 'alpha'));
      assert.equal(
        await evaluate(() =>
          document
            .getElementById('app-menu-panel')
            .contains(document.getElementById('start-session')),
        ),
        true,
      );
    },
  );

  await check(
    'every shipped theme renders workspace menus and compact zoomed agent menus',
    async () => {
      report.themes = await evaluate(() =>
        [...document.getElementById('factory-theme').options].map(
          option => option.value,
        ),
      );
      for (const theme of report.themes) {
        browser.setContentSize(1500, 1000);
        await evaluate(theme => {
          window.pidev.setZoom(1);
          const picker = document.getElementById('factory-theme');
          picker.value = theme;
          picker.dispatchEvent(new window.Event('change', {bubbles: true}));
        }, theme);
        await waitFor(
          theme => document.documentElement.dataset.theme === theme,
          theme,
        );
        await click('.parent-card[data-context-session="alpha"]');
        await openMenu();
        await assertMenuFits();
        await capture(`${theme}-workspace.png`);
        await key('Escape');
        browser.setContentSize(1100, 760);
        await evaluate(() => window.pidev.setZoom(1.5));
        await settle();
        if (
          await evaluate(
            () =>
              !document
                .querySelector('.worker-card[data-context-unit="review"]')
                .checkVisibility(),
          )
        )
          await click('#factory-agents-button');
        await openMenu('.worker-card[data-context-unit="review"]');
        await waitFor(
          () =>
            document.getElementById('inspector-title').textContent ===
              'Review agent' &&
            !document
              .getElementById('factory-agents-drawer')
              .matches(':popover-open') &&
            document
              .getElementById('item-context-menu')
              .matches(':popover-open'),
        );
        await assertMenuFits();
        await capture(`${theme}-compact-zoom-agent.png`);
        await key('Escape');
      }
    },
  );

  await check(
    'fallback station context menu selects its agent and routes close',
    async () => {
      browser.webContents.debugger.attach('1.3');
      await browser.webContents.debugger.sendCommand('Page.enable');
      await browser.webContents.debugger.sendCommand(
        'Page.addScriptToEvaluateOnNewDocument',
        {
          source: 'HTMLCanvasElement.prototype.getContext = () => null;',
        },
      );
      await reload();
      browser.webContents.debugger.detach();
      await waitFor(() => !document.getElementById('fallback').hidden);
      await openMenu('.fallback-station[data-context-unit="review"]');
      await waitFor(
        () =>
          document.getElementById('inspector-title').textContent ===
          'Review agent',
      );
      await act('close-session');
      assert.deepEqual(calls, [
        ['agent-session', 'alpha', {agentId: 'review', action: 'close'}],
      ]);
    },
  );
}
async function assertMenuFits() {
  const geometry = await evaluate(() => {
    const menu = document.getElementById('item-context-menu');
    const rect = menu.getBoundingClientRect();
    const button = document
      .getElementById('item-actions-button')
      .getBoundingClientRect();
    const page = document.scrollingElement;
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: window.innerWidth,
      height: window.innerHeight,
      actionsVisible:
        button.width > 0 &&
        button.height > 0 &&
        button.left >= 0 &&
        button.right <= window.innerWidth &&
        button.top >= 0 &&
        button.bottom <= window.innerHeight,
      pageFits:
        page.scrollHeight <= page.clientHeight &&
        page.scrollWidth <= page.clientWidth,
      itemsFit: [...menu.querySelectorAll('[role="menuitem"]')]
        .filter(item => !item.hidden)
        .every(item => {
          const bounds = item.getBoundingClientRect();
          return (
            bounds.width > 0 &&
            bounds.height > 0 &&
            bounds.left >= rect.left &&
            bounds.right <= rect.right + 1 &&
            bounds.top >= rect.top &&
            bounds.bottom <= rect.bottom + 1
          );
        }),
    };
  });
  assert.ok(
    geometry.left >= 0 &&
      geometry.top >= 0 &&
      geometry.right <= geometry.width + 1 &&
      geometry.bottom <= geometry.height + 1,
    JSON.stringify(geometry),
  );
  assert.equal(geometry.actionsVisible, true, JSON.stringify(geometry));
  assert.equal(geometry.pageFits, true, JSON.stringify(geometry));
  assert.equal(geometry.itemsFit, true, JSON.stringify(geometry));
}
main()
  .catch(error => {
    report.error = error.stack || String(error);
  })
  .finally(() => {
    saveReport();
    browser?.destroy();
    app.exit(report.error || report.cases.some(item => item.error) ? 1 : 0);
  });
