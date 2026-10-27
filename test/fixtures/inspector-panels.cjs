/* global process, __dirname, document, window, setTimeout, Event, getComputedStyle */
const assert = require('node:assert/strict');
const {writeFileSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {app, BrowserWindow, ipcMain} = require('electron');
const [directory, reportPath, screenshots] = process.argv.slice(2);
const report = {cases: [], themes: [], screenshots: []};
const at = '2026-01-01T12:00:00.000Z';
let browser;
let hub;
let calls = [];
let stops = [];
const errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function save() {
  writeFileSync(reportPath, JSON.stringify(report));
  writeFileSync(
    join(screenshots, 'report.json'),
    JSON.stringify(report, null, 2),
  );
}
function snapshot() {
  return {
    selectedSessionId: 'alpha',
    launchCwd: directory,
    sessions: ['alpha', 'beta'].map(id => ({
      session: {
        id,
        name: `${id} workspace`,
        cwd: directory,
        model: 'fixture/local',
        status: 'running',
        activity: 'Reviewing workspace changes',
        startedAt: at,
        updatedAt: at,
        owned: true,
        controllable: true,
      },
      agents: [
        {
          id: 'review',
          name: 'Review agent',
          task: 'Review the project',
          cwd: directory,
          model: 'fixture/local',
          status: 'running',
          activity: 'Reading project files',
          createdAt: at,
          startedAt: at,
          conversation: [
            {
              id: 'agent-msg',
              role: 'assistant',
              text: 'Agent conversation marker',
              at,
            },
          ],
        },
        {
          id: 'finished',
          name: 'Finished agent',
          task: 'Check changes',
          cwd: directory,
          model: 'fixture/local',
          status: 'completed',
          activity: 'Done',
          output: 'All done',
          createdAt: at,
          startedAt: at,
          finishedAt: at,
          conversation: [],
        },
      ],
      totalAgents: 2,
      events: [
        {
          id: `${id}-event`,
          at,
          kind: 'message',
          sourceName: 'Starting agent',
          sourceId: 'parent',
          message: `${id} live feed marker`,
        },
      ],
      changes: [
        {
          id: `${id}-change`,
          unitId: 'parent',
          unitName: 'Starting agent',
          at,
          tool: 'edit',
          path: 'example.ts',
          summary: `${id} change marker`,
          diff: '+ added line',
        },
      ],
      conversation: [
        {id: `${id}-user`, role: 'user', text: `${id} conversation marker`, at},
        {
          id: `${id}-assistant`,
          role: 'assistant',
          text: 'Reviewing the files with a worker agent.',
          at,
        },
      ],
      conversationTruncated: false,
      queue: {steering: [], followUp: []},
    })),
  };
}
const features = () => ({
  commands: [],
  tools: [],
  models: [],
  diagnostics: [],
  thinkingLevel: 'off',
  thinkingLevels: ['off'],
  speedMode: 'regular',
  speedModes: ['regular'],
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
async function evaluate(fn, arg) {
  const result = await browser.webContents.executeJavaScript(`(async () => {
    try { return {value: await (${fn.toString()})(${JSON.stringify(arg)})}; }
    catch (error) { return {error: error.stack || String(error)}; }
  })()`);
  if (result.error) throw new Error(result.error);
  return result.value;
}
async function waitFor(fn, arg) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await evaluate(fn, arg)) return;
    await delay(20);
  }
  throw new Error(
    `Timed out: ${fn}\n${JSON.stringify(await evaluate(() => ({error: document.getElementById('app-error').textContent, layout: window.localStorage.getItem('varisdev.inspector-panels.v1')})))}`,
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
async function reload() {
  await browser.loadFile(
    resolve(__dirname, '../../assets/dashboard/index.html'),
  );
  await waitFor(() => document.querySelectorAll('.parent-card').length === 2);
  await settle();
}
async function point(selector, offset = 0.5) {
  return evaluate(
    ({selector, offset}) => {
      const target = document.querySelector(selector);
      if (!target) throw new Error(`Missing target ${selector}`);
      target.scrollIntoView({block: 'nearest', inline: 'nearest'});
      const rect = target.getBoundingClientRect();
      if (!rect.width || !rect.height)
        throw new Error(`Hidden target ${selector}`);
      return {
        x: Math.round(rect.left + rect.width * offset),
        y: Math.round(rect.top + rect.height / 2),
      };
    },
    {selector, offset},
  );
}
function mouse(type, position, button = 'left') {
  const zoom = browser.webContents.getZoomFactor();
  browser.webContents.sendInputEvent({
    type,
    x: Math.round(position.x * zoom),
    y: Math.round(position.y * zoom),
    button,
    clickCount: 1,
  });
}
async function click(selector, button = 'left') {
  const position = await point(selector);
  browser.focus();
  browser.webContents.focus();
  mouse('mouseDown', position, button);
  mouse('mouseUp', position, button);
  await delay(40);
}
async function drag(selector, target, offset = 0.25) {
  const start = await point(selector);
  const end = await point(target, offset);
  browser.focus();
  browser.webContents.focus();
  mouse('mouseDown', start);
  for (let step = 1; step <= 6; step++) {
    mouse('mouseMove', {
      x: Math.round(start.x + ((end.x - start.x) * step) / 6),
      y: Math.round(start.y + ((end.y - start.y) * step) / 6),
    });
    await delay(15);
  }
  mouse('mouseUp', end);
  await settle();
}
async function option(key, checked = true) {
  await evaluate(
    ({key, checked}) => {
      const input = document.getElementById(`layout-${key}`);
      input.checked = checked;
      input.dispatchEvent(new Event('change', {bubbles: true}));
    },
    {key, checked},
  );
  await settle();
}
async function minify(selector) {
  await click(selector, 'right');
  await waitFor(() =>
    document.getElementById('panel-context-menu').matches(':popover-open'),
  );
  await click('#panel-context-menu button');
  await settle();
}
async function layout() {
  return evaluate(() => ({
    order: [...document.querySelectorAll('.inspector-tabs [role="tab"]')].map(
      tab => tab.id.replace('tab-', ''),
    ),
    detached: [
      ...document.querySelectorAll('#inspector-panel-rack > :not([hidden])'),
    ].map(panel => panel.dataset.inspectorPanel),
    saved: JSON.parse(
      window.localStorage.getItem('varisdev.inspector-panels.v1'),
    ),
  }));
}
async function check(name, fn) {
  report.activeCase = name;
  save();
  try {
    hub = snapshot();
    calls = [];
    stops = [];
    errors.length = 0;
    await evaluate(() => window.localStorage.clear());
    browser.setContentSize(1680, 1000);
    await reload();
    await fn();
    assert.deepEqual(errors, [], 'No renderer errors');
    report.cases.push({name});
  } catch (error) {
    report.cases.push({name, error: error.stack || String(error)});
  }
  delete report.activeCase;
  save();
}
async function capture(name) {
  await delay(100);
  await settle();
  const path = join(screenshots, name);
  writeFileSync(path, (await browser.webContents.capturePage()).toPNG());
  report.screenshots.push(path);
  save();
}
async function bounds(compact, drawer = false) {
  const result = await evaluate(
    ({compact, drawer}) => {
      const visible = selector => {
        const element = document.querySelector(selector);
        const rect = element.getBoundingClientRect();
        return {
          visible:
            rect.width > 0 &&
            rect.height > 0 &&
            getComputedStyle(element).visibility !== 'hidden',
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        };
      };
      return {
        scroll: document.documentElement.scrollHeight - window.innerHeight,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        scene: visible('#scene'),
        inspector: visible('#inspector'),
        composer: visible('#composer-slot'),
        rack: visible('#inspector-panel-rack'),
        open: visible('#open-panel-feed'),
        body: drawer ? visible('#panel-feed') : visible('#panel-details'),
        compact,
      };
    },
    {compact, drawer},
  );
  assert.ok(result.scroll <= 1, `No page scrolling: ${JSON.stringify(result)}`);
  for (const key of ['scene', 'inspector', 'composer']) {
    assert.ok(
      result[key].visible &&
        result[key].bottom <= result.viewportHeight + 1 &&
        result[key].left >= 0,
      `${key} remains accessible: ${JSON.stringify(result)}`,
    );
  }
  assert.ok(
    result.scene.width >= 200 && result.scene.height >= 120,
    `Scene remains usable: ${JSON.stringify(result)}`,
  );
  assert.equal(result.rack.visible, !compact);
  assert.equal(result.open.visible, compact);
  if (drawer || !compact)
    assert.ok(result.body.visible && result.body.height >= 100);
}
app.setPath('userData', join(directory, 'profile'));
app.setPath('sessionData', join(directory, 'session'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.on('window-all-closed', () => {});
async function main() {
  await app.whenReady();
  browser = new BrowserWindow({
    show: true,
    width: 1680,
    height: 1000,
    webPreferences: {
      preload: resolve(__dirname, '../../assets/desktop/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  browser.webContents.on('console-message', details => {
    if (details.level === 'error') errors.push(details.message);
  });
  handle('pidev:get-state', () => hub);
  handle('pidev:recent-projects', () => []);
  handle('varisdev:get-agent-notice', () => ({acknowledged: true}));
  handle('varisdev:get-update-status', () => ({
    phase: 'idle',
    currentVersion: '1.8.2',
    restartRequired: false,
  }));
  handle('varisdev:app-themes', () => ({themes: [], errors: []}));
  handle('pidev:session-features', features);
  handle('pidev:agent-session', (sessionId, request) => {
    if (request.action === 'features') return features();
    if (['abort', 'cancel'].includes(request.action))
      stops.push([sessionId, request.agentId]);
    return {};
  });
  handle('pidev:abort-session', sessionId => {
    stops.push([sessionId, 'parent']);
    return {steering: [], followUp: []};
  });
  handle('pidev:prompt-session', (id, input) => {
    calls.push([id, input]);
    return {steering: [], followUp: []};
  });
  handle('pidev:close-session', id => {
    calls.push(['close', id]);
    hub.sessions = hub.sessions.filter(item => item.session.id !== id);
    hub.selectedSessionId = hub.sessions[0]?.session.id;
    browser.webContents.send('pidev:snapshot', hub);
  });
  hub = snapshot();
  await reload();
  await check(
    'pointer dragging reorders tabs and keyboard traversal follows the saved order',
    async () => {
      await drag('#tab-details', '#tab-conversation');
      assert.deepEqual((await layout()).order.slice(0, 3), [
        'details',
        'conversation',
        'feed',
      ]);
      await evaluate(() => document.getElementById('tab-details').focus());
      browser.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Right'});
      browser.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Right'});
      await waitFor(() => document.activeElement.id === 'tab-conversation');
      await reload();
      assert.deepEqual((await layout()).order.slice(0, 3), [
        'details',
        'conversation',
        'feed',
      ]);
    },
  );
  await check(
    'workspace drop detaches the original live body; Minify returns it with composer draft intact',
    async () => {
      await evaluate(() => {
        window.originalPanelBody = document.getElementById('panel-details');
        const editor = document.getElementById('parent-prompt');
        editor.value = 'Draft survives panel changes';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
      });
      await drag('#tab-details', '#scene');
      assert.deepEqual((await layout()).detached, ['details']);
      assert.equal(
        await evaluate(() =>
          document
            .querySelector('[data-inspector-panel="details"]')
            .contains(window.originalPanelBody),
        ),
        true,
      );
      await waitFor(
        () => document.getElementById('unit-task').textContent.length > 0,
      );
      await minify('[data-inspector-panel="details"] .detached-panel-heading');
      assert.deepEqual((await layout()).detached, []);
      assert.equal(
        await evaluate(() =>
          document
            .getElementById('inspector')
            .contains(window.originalPanelBody),
        ),
        true,
      );
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        'Draft survives panel changes',
      );
      assert.equal(
        await evaluate(
          () =>
            document.getElementById('panel-details').getBoundingClientRect()
              .bottom <=
            document.getElementById('composer-resize').getBoundingClientRect()
              .top +
              1,
        ),
        true,
        'Returned tabs stay above the composer divider',
      );
    },
  );
  await check(
    'Appearance options detach every view; panels update for snapshots and selected agents',
    async () => {
      for (const key of [
        'conversation',
        'details',
        'feed',
        'changes',
        'tokens',
        'context',
        'speed',
      ])
        await option(key);
      assert.equal((await layout()).detached.length, 7);
      const beforeResize = await evaluate(() => {
        document.getElementById('composer-resize').focus();
        return document.getElementById('parent-prompt').getBoundingClientRect()
          .height;
      });
      browser.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Up'});
      browser.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Up'});
      await settle();
      assert.ok(
        (await evaluate(
          () =>
            document.getElementById('parent-prompt').getBoundingClientRect()
              .height,
        )) > beforeResize,
        'Composer can grow when every inspector view is detached',
      );
      hub.sessions[0].conversation.push({
        id: 'new-message',
        role: 'assistant',
        text: 'New detached conversation output',
        at,
      });
      hub.sessions[0].events.push({
        id: 'new-event',
        kind: 'message',
        sourceName: 'Starting agent',
        sourceId: 'parent',
        message: 'New detached live output',
        at,
      });
      hub.sessions[0].changes.push({
        id: 'new-change',
        unitId: 'parent',
        unitName: 'Starting agent',
        at,
        tool: 'edit',
        path: 'new.ts',
        summary: 'New detached diff output',
        diff: '+ fresh change',
      });
      browser.webContents.send('pidev:snapshot', hub);
      await waitFor(
        () =>
          document
            .getElementById('conversation')
            .textContent.includes('New detached conversation output') &&
          document
            .getElementById('live-feed')
            .textContent.includes('New detached live output') &&
          document
            .getElementById('unit-changes')
            .textContent.includes('New detached diff output'),
      );
      await click('.worker-card[data-context-unit="review"]');
      await waitFor(
        () =>
          document
            .getElementById('conversation')
            .textContent.includes('Agent conversation marker') &&
          document
            .getElementById('unit-task')
            .textContent.includes('Review the project'),
      );
      assert.equal(
        await evaluate(() =>
          document
            .getElementById('conversation')
            .textContent.includes('alpha conversation marker'),
        ),
        false,
      );
      await click('.parent-card[data-context-session="beta"]');
      await waitFor(() =>
        document
          .getElementById('conversation')
          .textContent.includes('beta conversation marker'),
      );
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = 'Prompt from detached layout';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
      });
      await click('#send-prompt');
      await waitFor(
        () => document.getElementById('parent-prompt').value === '',
      );
      assert.equal(calls.at(-1)[0], 'beta');
    },
  );
  await check(
    'detached order, width and visibility survive reload; Reset panel layout restores defaults',
    async () => {
      await option('details');
      await option('feed');
      await drag(
        '[data-inspector-panel="feed"] .detached-panel-heading',
        '[data-inspector-panel="details"] .detached-panel-heading',
      );
      assert.deepEqual((await layout()).detached, ['feed', 'details']);
      await drag(
        '[data-inspector-panel="feed"] .detached-panel-heading',
        '[data-inspector-panel="feed"] .detached-panel-heading',
        0.75,
      );
      assert.deepEqual(
        (await layout()).detached,
        ['feed', 'details'],
        'Dropping a panel onto itself keeps its position',
      );
      await evaluate(() => document.getElementById('detached-resize').focus());
      browser.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Left'});
      browser.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Left'});
      await delay(30);
      const width = await evaluate(
        () =>
          document
            .getElementById('inspector-panel-rack')
            .getBoundingClientRect().width,
      );
      await reload();
      assert.deepEqual((await layout()).detached, ['feed', 'details']);
      assert.ok(
        Math.abs(
          (await evaluate(
            () =>
              document
                .getElementById('inspector-panel-rack')
                .getBoundingClientRect().width,
          )) - width,
        ) < 2,
      );
      await evaluate(() => document.getElementById('layout-reset').click());
      assert.deepEqual((await layout()).order, [
        'conversation',
        'details',
        'feed',
        'changes',
        'tokens',
        'context',
        'speed',
      ]);
      assert.deepEqual((await layout()).detached, []);
      assert.equal((await layout()).saved, null);
    },
  );
  await check(
    'panel Minify uses existing visibility options with saved restoration',
    async () => {
      for (const [key, heading] of [
        ['visualization', '#factory-panel .factory-title-group'],
        ['workspaces', '#workspaces-panel .section-heading'],
        ['agents', '#worker-panels .section-heading'],
      ]) {
        await minify(heading);
        assert.equal(
          await evaluate(
            key => document.getElementById(`layout-${key}`).checked,
            key,
          ),
          false,
        );
        await reload();
        assert.equal(
          await evaluate(
            key => document.getElementById(`layout-${key}`).checked,
            key,
          ),
          false,
        );
        await option(key);
        assert.equal(
          await evaluate(
            key => document.getElementById(`layout-${key}`).checked,
            key,
          ),
          true,
        );
      }
    },
  );
  await check(
    'compact panel drawers retain labels, keyboard Minify and return focus to tabs',
    async () => {
      await option('feed');
      await option('details');
      browser.setContentSize(1000, 720);
      await settle();
      await bounds(true);
      await click('#open-panel-feed');
      await waitFor(() =>
        document
          .getElementById('inspector-panel-drawer')
          .matches(':popover-open'),
      );
      await bounds(true, true);
      await click('#inspector-panel-drawer .detached-panel-close');
      await waitFor(
        () =>
          !document
            .getElementById('inspector-panel-drawer')
            .matches(':popover-open'),
      );
      browser.setContentSize(1680, 1000);
      await settle();
      const afterDrawer = await layout();
      assert.deepEqual(
        afterDrawer.detached,
        ['feed', 'details'],
        'Closing the first drawer preserves the visible panel arrangement',
      );
      assert.deepEqual(
        afterDrawer.saved.detached,
        afterDrawer.detached,
        'The visible and saved panel order agree after returning to wide layout',
      );
      await reload();
      assert.deepEqual((await layout()).detached, afterDrawer.detached);
      browser.setContentSize(1000, 720);
      await settle();
      await click('#open-panel-feed');
      await evaluate(() =>
        document
          .querySelector(
            '[data-inspector-panel="feed"] .detached-panel-heading',
          )
          .focus(),
      );
      browser.webContents.sendInputEvent({
        type: 'keyDown',
        keyCode: 'F10',
        modifiers: ['shift'],
      });
      browser.webContents.sendInputEvent({
        type: 'keyUp',
        keyCode: 'F10',
        modifiers: ['shift'],
      });
      await waitFor(() =>
        document.getElementById('panel-context-menu').matches(':popover-open'),
      );
      await click('#panel-context-menu button');
      await waitFor(() => document.activeElement.id === 'tab-feed');
      assert.deepEqual((await layout()).detached, ['details']);
      assert.equal(
        await evaluate(() => document.getElementById('panel-feed').hidden),
        false,
      );
    },
  );
  await check(
    'Escape closes a compact drawer without stopping the selected working agent',
    async () => {
      await option('details');
      for (const unit of ['parent', 'review']) {
        browser.setContentSize(1680, 1000);
        await settle();
        if (unit === 'review')
          await click('.worker-card[data-context-unit="review"]');
        await waitFor(() => !document.getElementById('abort-parent').disabled);
        browser.setContentSize(1000, 720);
        await settle();
        await click('#open-panel-details');
        await waitFor(() =>
          document
            .getElementById('inspector-panel-drawer')
            .matches(':popover-open'),
        );
        browser.webContents.sendInputEvent({
          type: 'keyDown',
          keyCode: 'Escape',
        });
        browser.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Escape'});
        await waitFor(
          () =>
            !document
              .getElementById('inspector-panel-drawer')
              .matches(':popover-open') &&
            document.activeElement.id === 'open-panel-details',
        );
        assert.deepEqual(
          stops,
          [],
          `${unit}: dismissing a drawer must not stop work`,
        );
      }
    },
  );
  await check(
    'closing the final workspace dismisses detached drawers and retains the saved layout',
    async () => {
      hub.sessions = hub.sessions.slice(0, 1);
      browser.webContents.send('pidev:snapshot', hub);
      await waitFor(
        () => document.querySelectorAll('.parent-card').length === 1,
      );
      await option('conversation');
      browser.setContentSize(1000, 720);
      await settle();
      await click('#item-actions-button');
      await click('#close-session');
      await waitFor(
        () =>
          !document.getElementById('welcome').hidden &&
          document.getElementById('factory-workspace').hidden,
      );
      assert.deepEqual(calls.at(-1), ['close', 'alpha']);
      assert.equal(
        await evaluate(() =>
          document
            .getElementById('inspector-panel-drawer')
            .matches(':popover-open'),
        ),
        false,
        'Closing the final workspace must not reveal a detached Conversation drawer',
      );
      assert.deepEqual((await layout()).saved.detached, ['conversation']);

      hub = snapshot();
      hub.sessions = hub.sessions.slice(0, 1);
      browser.webContents.send('pidev:snapshot', hub);
      await waitFor(
        () =>
          !document.getElementById('factory-workspace').hidden &&
          document
            .getElementById('inspector-panel-drawer')
            .matches(':popover-open') &&
          document
            .getElementById('conversation')
            .textContent.includes('alpha conversation marker'),
      );
      hub.sessions = [];
      hub.selectedSessionId = undefined;
      browser.webContents.send('pidev:snapshot', hub);
      await waitFor(
        () =>
          !document.getElementById('welcome').hidden &&
          !document
            .getElementById('inspector-panel-drawer')
            .matches(':popover-open'),
      );
      assert.deepEqual((await layout()).saved.detached, ['conversation']);
    },
  );
  await check(
    'Live feed follows updates and preserves readers across drawers, workspaces and agents',
    async () => {
      const events = (id, count) =>
        Array.from({length: count}, (_, i) => ({
          id: `${id}-event-${i}`,
          at,
          kind: 'message',
          sourceName: 'Starting agent',
          sourceId: 'parent',
          message: `${id} event ${i}: reviewing the workspace`,
        }));
      const publish = async (count, id = 'alpha') => {
        hub.sessions.find(item => item.session.id === id).events = events(
          id,
          count,
        );
        browser.webContents.send('pidev:snapshot', hub);
        await waitFor(
          expected =>
            document.getElementById('feed-count').textContent ===
            String(expected),
          count,
        );
      };
      const bottom = () =>
        waitFor(() => {
          const panel = document.getElementById('panel-feed');
          return (
            panel.checkVisibility() &&
            panel.scrollHeight > panel.clientHeight &&
            panel.scrollHeight - panel.clientHeight - panel.scrollTop < 2
          );
        });
      const readerPosition = async () =>
        assert.ok(
          Math.abs(
            (await evaluate(
              () => document.getElementById('panel-feed').scrollTop,
            )) - 200,
          ) <= 1,
          'Incoming events preserve the reader position',
        );
      await option('feed');
      await publish(40);
      browser.setContentSize(1000, 720);
      await settle();
      await click('#open-panel-feed');
      await bottom();
      await click('[data-inspector-panel="feed"] .detached-panel-close');
      await publish(60);
      await click('#open-panel-feed');
      await bottom();
      await publish(61);
      await bottom();

      await evaluate(() => {
        document.getElementById('panel-feed').scrollTop = 200;
      });
      await settle();
      assert.equal(
        await evaluate(() => document.getElementById('follow-feed').checked),
        true,
      );
      await click('[data-inspector-panel="feed"] .detached-panel-close');
      await publish(80);
      await click('#open-panel-feed');
      await settle();
      await readerPosition();
      await click('[data-inspector-panel="feed"] .detached-panel-close');
      await publish(90);
      browser.setContentSize(1680, 1000);
      await settle();
      await readerPosition();

      browser.setContentSize(1000, 720);
      await settle();
      hub.sessions[1].events = events('beta', 80);
      browser.webContents.send('pidev:snapshot', hub);
      await click('.parent-card[data-context-session="beta"]');
      await waitFor(() =>
        document
          .getElementById('live-feed')
          .textContent.includes('beta event 79'),
      );
      await click('#open-panel-feed');
      await bottom();
      await click('[data-inspector-panel="feed"] .detached-panel-close');
      await publish(100, 'beta');
      browser.setContentSize(1680, 1000);
      await settle();
      await bottom();

      await click('.parent-card[data-context-session="alpha"]');
      await waitFor(() =>
        document
          .getElementById('live-feed')
          .textContent.includes('alpha event 89'),
      );
      await bottom();
      await publish(110);
      await bottom();
      hub.sessions[0].events.push(
        ...events('review', 80).map(event => ({...event, sourceId: 'review'})),
      );
      browser.webContents.send('pidev:snapshot', hub);
      await click('.worker-card[data-context-unit="review"]');
      await waitFor(() =>
        document
          .getElementById('live-feed')
          .textContent.includes('review event 79'),
      );
      await bottom();
      hub.sessions[0].events.push({
        ...events('review', 81).at(-1),
        sourceId: 'review',
      });
      browser.webContents.send('pidev:snapshot', hub);
      await waitFor(
        () => document.getElementById('feed-count').textContent === '81',
      );
      await bottom();
    },
  );
  await check(
    'drawer reading positions reset when the selected workspace or agent changes',
    async () => {
      for (const data of hub.sessions) {
        data.session.prompt = `${data.session.id} prompt\n${'Read the workspace carefully.\n'.repeat(40)}`;
        data.agents[0].task = `${data.session.id} review task\n${'Review the workspace carefully.\n'.repeat(40)}`;
        data.events = ['parent', 'review'].flatMap(sourceId =>
          Array.from({length: 80}, (_, i) => ({
            id: `${data.session.id}-${sourceId}-${i}`,
            at,
            kind: 'message',
            sourceName: sourceId,
            sourceId,
            message: `${data.session.id} ${sourceId} event ${i}`,
          })),
        );
      }
      browser.webContents.send('pidev:snapshot', hub);
      await option('details');
      await option('feed');
      browser.setContentSize(1000, 720);
      await settle();
      const read = async key => {
        await evaluate(name => {
          const body = document.getElementById(`panel-${name}`);
          body.scrollTop = 200;
        }, key);
        await settle();
        assert.equal(
          await evaluate(
            name => document.getElementById(`panel-${name}`).scrollTop,
            key,
          ),
          200,
        );
      };
      const top = async key => {
        await settle();
        assert.equal(
          await evaluate(
            name => document.getElementById(`panel-${name}`).scrollTop,
            key,
          ),
          0,
          `${key} starts at the top for the newly selected conversation`,
        );
      };
      await click('#open-panel-details');
      await read('details');
      await click('[data-inspector-panel="details"] .detached-panel-close');
      await click('#open-panel-feed');
      await evaluate(() => {
        const follow = document.getElementById('follow-feed');
        follow.checked = false;
        follow.dispatchEvent(new Event('change'));
      });
      await read('feed');
      await click('[data-inspector-panel="feed"] .detached-panel-close');

      await click('.parent-card[data-context-session="beta"]');
      await waitFor(() =>
        document
          .getElementById('unit-task')
          .textContent.includes('beta prompt'),
      );
      for (const key of ['details', 'feed']) {
        await click(`#open-panel-${key}`);
        await top(key);
        await read(key);
        await click(`[data-inspector-panel="${key}"] .detached-panel-close`);
      }
      if (
        await evaluate(() =>
          document.getElementById('factory-agents-button').checkVisibility(),
        )
      )
        await click('#factory-agents-button');
      await click('.worker-card[data-context-unit="review"]');
      await waitFor(() =>
        document
          .getElementById('unit-task')
          .textContent.includes('beta review task'),
      );
      for (const key of ['details', 'feed']) {
        await click(`#open-panel-${key}`);
        await top(key);
        await read(key);
        await click(`[data-inspector-panel="${key}"] .detached-panel-close`);
      }
      await click('.parent-card[data-context-session="beta"]');
      await waitFor(() =>
        document
          .getElementById('unit-task')
          .textContent.includes('beta prompt'),
      );
      browser.setContentSize(1680, 1000);
      await settle();
      await top('details');
      await top('feed');
      assert.equal(
        await evaluate(() => document.getElementById('follow-feed').checked),
        false,
      );
    },
  );
  await check(
    'conversation follow and reading position work while detached',
    async () => {
      hub.sessions[0].conversation = Array.from({length: 35}, (_, i) => ({
        id: `history-${i}`,
        role: i % 2 ? 'assistant' : 'user',
        text: `Message ${i}\n${'Readable history line\n'.repeat(4)}`,
        at,
      }));
      browser.webContents.send('pidev:snapshot', hub);
      await option('conversation');
      await waitFor(() => {
        const panel = document.getElementById('panel-conversation');
        return panel.scrollHeight - panel.clientHeight - panel.scrollTop < 4;
      });
      await evaluate(() => {
        const panel = document.getElementById('panel-conversation');
        document.getElementById('follow-conversation').checked = false;
        panel.scrollTop = 250;
      });
      const top = await evaluate(
        () => document.getElementById('panel-conversation').scrollTop,
      );
      hub.sessions[0].conversation.at(-1).text += 'New output\n'.repeat(10);
      browser.webContents.send('pidev:snapshot', hub);
      await delay(50);
      await settle();
      assert.ok(
        Math.abs(
          (await evaluate(
            () => document.getElementById('panel-conversation').scrollTop,
          )) - top,
        ) <= 1,
      );
      browser.setContentSize(1000, 720);
      await settle();
      await click('#open-panel-conversation');
      assert.ok(
        Math.abs(
          (await evaluate(
            () => document.getElementById('panel-conversation').scrollTop,
          )) - top,
        ) <= 1,
        'Drawer preserves the reader position',
      );
      await click('.inspector-panel-drawer .detached-panel-close');
      await click('#open-panel-conversation');
      assert.ok(
        Math.abs(
          (await evaluate(
            () => document.getElementById('panel-conversation').scrollTop,
          )) - top,
        ) <= 1,
        'Reopening the drawer preserves the reader position',
      );
      await click('.inspector-panel-drawer .detached-panel-close');
      browser.setContentSize(1680, 1000);
      await settle();
      for (const action of ['Minify', 'Panel layout', 'Drag']) {
        if (action === 'Minify')
          await minify(
            '[data-inspector-panel="conversation"] .detached-panel-heading',
          );
        else if (action === 'Panel layout') await option('conversation', false);
        else
          await drag(
            '[data-inspector-panel="conversation"] .detached-panel-heading',
            '.inspector-tabs',
          );
        await settle();
        assert.equal(
          await evaluate(
            () => document.getElementById('follow-conversation').checked,
          ),
          false,
          `${action} preserves disabled Follow`,
        );
        assert.ok(
          Math.abs(
            (await evaluate(
              () => document.getElementById('panel-conversation').scrollTop,
            )) - top,
          ) <= 1,
          `${action} preserves the reader position`,
        );
        assert.deepEqual((await layout()).detached, []);
        await option('conversation');
      }
      browser.setContentSize(1000, 720);
      await settle();
      await click('#open-panel-conversation');
      await evaluate(() => {
        const panel = document.getElementById('panel-conversation');
        document.getElementById('follow-conversation').checked = true;
        panel.scrollTop = panel.scrollHeight;
      });
      hub.sessions[0].conversation.at(-1).text += 'Follow output\n'.repeat(10);
      browser.webContents.send('pidev:snapshot', hub);
      await waitFor(() => {
        const panel = document.getElementById('panel-conversation');
        return panel.scrollHeight - panel.clientHeight - panel.scrollTop < 4;
      });
      await click('.inspector-panel-drawer .detached-panel-close');
      browser.setContentSize(1680, 1000);
      await settle();
      await drag(
        '[data-inspector-panel="conversation"] .detached-panel-heading',
        '.inspector-tabs',
      );
      assert.deepEqual((await layout()).detached, []);
    },
  );
  await check(
    'all shipped themes render panels and compact drawers with usable scene and controls',
    async () => {
      await option('details');
      await option('feed');
      const themes = await evaluate(() =>
        [...document.getElementById('factory-theme').options].map(
          option => option.value,
        ),
      );
      report.themes = themes;
      for (const theme of themes) {
        browser.webContents.setZoomFactor(1);
        browser.setContentSize(1680, 1000);
        await evaluate(theme => {
          const select = document.getElementById('factory-theme');
          select.value = theme;
          select.dispatchEvent(new Event('change', {bubbles: true}));
        }, theme);
        await settle();
        await bounds(false);
        await capture(`${theme}-normal.png`);
        browser.setContentSize(1000, 720);
        browser.webContents.setZoomFactor(1.25);
        await settle();
        await bounds(true);
        await capture(`${theme}-compact.png`);
        await click('#open-panel-feed');
        await bounds(true, true);
        await capture(`${theme}-drawer.png`);
        await click('.inspector-panel-drawer .detached-panel-close');
      }
    },
  );
}
main()
  .catch(error => {
    report.error = error.stack || String(error);
  })
  .finally(() => {
    save();
    app.exit(report.error || report.cases.some(item => item.error) ? 1 : 0);
  });
