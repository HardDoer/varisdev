/* global process, __dirname, document, requestAnimationFrame, setTimeout,
   NodeFilter, Node, Event, KeyboardEvent, innerWidth, innerHeight, getComputedStyle */
const assert = require('node:assert/strict');
const {mkdirSync, writeFileSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {app, BrowserWindow, ipcMain} = require('electron');

const [directory, reportPath] = process.argv.slice(2);
const report = {cases: []};
const at = '2026-01-01T12:00:00.000Z';
let hub;
let window;
let calls = [];
let rendererErrors = [];
let resources;
let editorSubmission;
let chosenFolder;

function features() {
  return {
    commands: [
      {
        name: 'skill:inspect',
        description: 'Inspect the selected files',
        source: 'skill',
        path: '/fixture/skills/inspect/SKILL.md',
      },
      {
        name: 'review',
        description: 'Review the current diff',
        source: 'prompt',
      },
      {
        name: 'fixture-command',
        description: 'Local extension command',
        source: 'extension',
      },
      {
        name: 'compact',
        description: 'Summarize the conversation',
        source: 'builtin',
      },
    ],
    models: [
      {provider: 'fixture', id: 'small', name: 'Fixture small'},
      {provider: 'fixture-other', id: 'large', name: 'Fixture large'},
    ],
    model: {provider: 'fixture', id: 'small'},
    thinkingLevel: 'medium',
    thinkingLevels: ['off', 'low', 'medium', 'high'],
    tools: [{name: 'bash', description: 'Run a local command'}],
    diagnostics: [],
  };
}

app.setPath('userData', join(directory, 'profile'));
app.setPath('sessionData', join(directory, 'session'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
// Keep animation frames running across reloads when another window covers the fixture.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

function session(id, name) {
  return {
    session: {
      id,
      name,
      cwd: directory,
      model: 'fixture/small',
      thinkingLevel: 'medium',
      status: 'running',
      activity: 'Running bash: checking the project',
      startedAt: at,
      updatedAt: at,
      owned: true,
      controllable: true,
    },
    agents: [],
    totalAgents: 0,
    events: [],
    changes: [],
    conversationTruncated: false,
    queue: {steering: [], followUp: []},
    conversation: [
      {id: `${id}-user`, role: 'user', text: 'Inspect the project', at},
      {
        id: `${id}-assistant`,
        role: 'assistant',
        text: 'I will inspect the project.',
        at,
      },
      {
        id: `${id}-tool`,
        role: 'tool',
        toolName: 'bash',
        toolCallId: `${id}-call`,
        input: 'printf "first line\\nsecond line\\n"',
        status: 'running',
        streaming: true,
        text: 'first line\n',
        at,
      },
    ],
  };
}

function reset() {
  hub = {
    launchCwd: directory,
    selectedSessionId: 'alpha',
    sessions: [
      session('alpha', 'Alpha factory'),
      session('beta', 'Beta factory'),
    ],
  };
  calls = [];
  rendererErrors = [];
  editorSubmission = undefined;
  chosenFolder = undefined;
  resources = new Map([
    ['alpha', features()],
    ['beta', features()],
  ]);
}

ipcMain.handle('fixture:state', () => hub);
ipcMain.on('fixture:error', (_event, error) => rendererErrors.push(error));
for (const method of ['prompt', 'abort', 'workspace']) {
  ipcMain.handle(`fixture:${method}`, (_event, sessionId, request) => {
    calls.push({method, sessionId, request});
    const target = hub.sessions.find(item => item.session.id === sessionId);
    if (method === 'prompt' && target.session.status === 'running') {
      target.queue.steering.push(request.prompt);
      window.webContents.send('fixture:snapshot', hub);
    }
    if (method === 'abort') {
      target.queue = {steering: [], followUp: []};
      window.webContents.send('fixture:snapshot', hub);
    }
    return method === 'workspace'
      ? {cwd: directory, files: [], diff: '', truncated: false}
      : undefined;
  });
}

ipcMain.handle('fixture:choose-folder', () => {
  calls.push({method: 'chooseFolder'});
  return chosenFolder;
});
ipcMain.handle('fixture:create-session', (_event, input) => {
  calls.push({method: 'createSession', input});
  const parent = session('folder-parent', 'Selected folder');
  parent.session.cwd = input.cwd;
  parent.session.status = 'idle';
  parent.session.activity = 'Ready';
  parent.conversation = [];
  hub.sessions.push(parent);
  resources.set(parent.session.id, features());
  window.webContents.send('fixture:snapshot', hub);
  return {id: parent.session.id};
});

ipcMain.handle('fixture:features', (_event, sessionId) => {
  assert.ok(resources.has(sessionId), `Unknown feature session ${sessionId}`);
  return resources.get(sessionId);
});
ipcMain.handle('fixture:configure', (_event, sessionId, request) => {
  calls.push({method: 'configureSession', sessionId, request});
  const resource = resources.get(sessionId);
  resource.model = {provider: request.provider, id: request.modelId};
  resource.thinkingLevel = request.thinkingLevel;
  const target = hub.sessions.find(item => item.session.id === sessionId);
  target.session.model = `${request.provider}/${request.modelId}`;
  target.session.thinkingLevel = request.thinkingLevel;
  window.webContents.send('fixture:snapshot', hub);
});
for (const method of ['compact', 'reload']) {
  ipcMain.handle(`fixture:${method}`, (_event, sessionId, instructions) => {
    calls.push({method: `${method}Session`, sessionId, instructions});
  });
}
ipcMain.handle('fixture:dialog', (_event, sessionId, dialogId, value) => {
  calls.push({method: 'respondToDialog', sessionId, dialogId, value});
  const target = hub.sessions.find(item => item.session.id === sessionId);
  const dialog = target.ui.dialogs.find(item => item.id === dialogId);
  if (target.ui.extensionEditor?.id === dialogId && typeof value === 'string') {
    target.ui.dialogs = [
      {
        id: 'custom-editor-terminal',
        kind: 'terminal',
        title: 'Edit fixture draft',
        terminal: {
          columns: 60,
          rows: 8,
          output:
            '\u001b[36mCustom editor\u001b[0m\r\nEnter submits the fixture draft',
          revision: 1,
        },
      },
    ];
  } else if (
    dialogId === 'custom-editor-terminal' &&
    value === '\r' &&
    editorSubmission !== undefined
  ) {
    target.ui.dialogs = [];
    target.ui.editor = {id: 'submitted-editor-draft', text: editorSubmission};
  } else if (dialog?.kind === 'terminal' && value !== undefined) {
    dialog.terminal.output += `\r\nReceived ${JSON.stringify(value)}`;
    dialog.terminal.revision++;
  } else {
    target.ui.dialogs = target.ui.dialogs.filter(item => item.id !== dialogId);
  }
  window.webContents.send('fixture:snapshot', hub);
});

async function press(keyCode, modifiers = []) {
  window.webContents.sendInputEvent({type: 'keyDown', keyCode, modifiers});
  window.webContents.sendInputEvent({type: 'keyUp', keyCode});
  await settle();
}

async function evaluate(callback, ...args) {
  const result = await window.webContents.executeJavaScript(
    `(async () => {
      try {
        return {ok: true, value: await (${callback.toString()})(...${JSON.stringify(args)})};
      } catch (error) {
        return {ok: false, error: error.stack || String(error)};
      }
    })()`,
  );
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

async function settle() {
  await evaluate(
    () =>
      new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

async function until(callback, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate(callback)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

async function reloadPage() {
  await new Promise(resolve => {
    window.webContents.once('did-finish-load', resolve);
    window.webContents.reload();
  });
  await until(
    () =>
      document.getElementById('connection')?.textContent ===
      'Desktop connected',
    'Reloaded dashboard did not connect',
  );
  await settle();
}

async function publish() {
  window.webContents.send('fixture:snapshot', hub);
  await settle();
}

async function run(name, callback, width = 1600, height = 1000) {
  try {
    if (window.webContents.getURL().startsWith('file:'))
      await evaluate(() => window.localStorage.clear());
    if (Math.abs(window.webContents.getZoomFactor() - 1) > 0.001)
      window.webContents.setZoomFactor(1);
    reset();
    window.setContentSize(width, height);
    await window.loadFile(
      resolve(__dirname, '../../assets/dashboard/index.html'),
    );
    await until(
      () =>
        document.getElementById('connection')?.textContent ===
        'Desktop connected',
      'Dashboard never connected to the isolated preload fixture',
    );
    await settle();
    await callback();
    assert.deepEqual(rendererErrors, [], 'Renderer errors');
    const visibleErrors = await evaluate(() =>
      [...document.querySelectorAll('.form-error, #app-error')]
        .filter(item => !item.hidden && item.getClientRects().length)
        .map(item => item.textContent),
    );
    assert.deepEqual(visibleErrors, [], 'Visible application errors');
    if (process.env.DESKTOP_UI_SCREENSHOT_DIR && name.startsWith('composer'))
      await screenshot(`layout-${width}x${height}`);
    report.cases.push({name});
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
  } catch (error) {
    if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
      await screenshot(`failure-${report.cases.length + 1}`);
    report.cases.push({
      name,
      error: error.stack || String(error),
      rendererErrors: [...rendererErrors],
    });
  }
}

async function screenshot(name) {
  await settle();
  await new Promise(resolve => setTimeout(resolve, 60));
  const output = resolve(process.env.DESKTOP_UI_SCREENSHOT_DIR);
  mkdirSync(output, {recursive: true});
  const image = await window.webContents.capturePage();
  writeFileSync(join(output, `${name}.png`), image.toPNG());
}

function rgbChannels(color) {
  return color
    .match(/[\d.]+/g)
    .slice(0, 3)
    .map(Number);
}

function contrast(first, second) {
  const luminance = color => {
    const [r, g, b] = rgbChannels(color).map(channel => {
      const value = channel / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return r * 0.2126 + g * 0.7152 + b * 0.0722;
  };
  const [low, high] = [luminance(first), luminance(second)].sort(
    (a, b) => a - b,
  );
  return (high + 0.05) / (low + 0.05);
}

async function main() {
  await app.whenReady();
  window = new BrowserWindow({
    show: false,
    // Exercise the requested viewport on laptops with smaller displays too.
    enableLargerThanScreen: true,
    width: 1600,
    height: 1000,
    webPreferences: {
      preload: join(__dirname, 'desktop-ui-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  // Windows pauses animation frames for a hidden window even with background
  // throttling disabled. Display the fixture without taking keyboard focus.
  window.showInactive();
  window.webContents.on('console-message', details => {
    if (details.level === 'error') rendererErrors.push(details.message);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    rendererErrors.push(`Renderer exited: ${details.reason}`);
  });
  // This uses only local assets and synthetic state, including a separate profile.
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    if (/^https?:/.test(details.url)) {
      rendererErrors.push(`Unexpected network request: ${details.url}`);
      callback({cancel: true});
    } else callback({});
  });

  await run(
    'tool command, live output, selection and disclosure survive streaming',
    async () => {
      const initial = await evaluate(() => {
        const tool = document.querySelector(
          '#conversation li.conversation-tool',
        );
        if (!tool) throw new Error('Conversation has no tool row');
        const details = tool.querySelector('details');
        if (!details)
          throw new Error('Tool row has no disclosure for input/output');
        details.open = true;
        const walker = document.createTreeWalker(tool, NodeFilter.SHOW_TEXT);
        let output;
        while (walker.nextNode()) {
          if (walker.currentNode.data === 'first line\n')
            output = walker.currentNode;
        }
        if (!output)
          throw new Error('Tool output is missing its native text node');
        const range = document.createRange();
        range.setStart(output, 0);
        range.setEnd(output, 5);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        window.fixtureNodes = {
          tool,
          details,
          output,
          input: tool.querySelector('.tool-input').firstChild,
        };
        return {
          text: tool.textContent,
          selected: window.getSelection().toString(),
        };
      });
      assert.match(initial.text, /bash/i);
      assert.match(initial.text, /printf/);
      assert.match(initial.text, /running|working/i);
      assert.equal(initial.selected, 'first');
      for (const chunk of ['second line\n', 'third line\n']) {
        hub.sessions[0].conversation.at(-1).text += chunk;
        await publish();
        const streamed = await evaluate(() => {
          const {tool, details, output, input} = window.fixtureNodes;
          return {
            sameTool:
              document.querySelector('#conversation li.conversation-tool') ===
              tool,
            sameDetails: tool.querySelector('details') === details,
            sameOutput:
              tool.querySelector('.tool-output').firstChild === output,
            sameInput: tool.querySelector('.tool-input').firstChild === input,
            open: details.open,
            selected: window.getSelection().toString(),
            text: output.data,
          };
        });
        assert.equal(streamed.sameTool, true);
        assert.equal(streamed.sameDetails, true);
        assert.equal(streamed.sameOutput, true);
        assert.equal(streamed.sameInput, true);
        assert.equal(streamed.open, true);
        assert.equal(streamed.selected, 'first');
        assert.equal(streamed.text, hub.sessions[0].conversation.at(-1).text);
      }
      await evaluate(() => {
        window.getSelection().removeAllRanges();
        window.fixtureNodes.details.open = false;
      });
      Object.assign(hub.sessions[0].conversation.at(-1), {
        status: 'completed',
        streaming: false,
        finishedAt: at,
      });
      await publish();
      assert.match(
        await evaluate(
          () =>
            document.querySelector('#conversation li.conversation-tool')
              .textContent,
        ),
        /completed/i,
      );
      assert.deepEqual(
        await evaluate(() => ({
          sameDetails:
            document.querySelector(
              '#conversation .conversation-tool details',
            ) === window.fixtureNodes.details,
          open: window.fixtureNodes.details.open,
          status: window.fixtureNodes.tool.dataset.status,
        })),
        {sameDetails: true, open: false, status: 'completed'},
        'Completing a tool must preserve a disclosure the reader closed',
      );
      assert.equal(
        await evaluate(() => {
          const activity = document.getElementById('conversation-activity');
          return !activity.hidden && activity.getAttribute('role') === 'status';
        }),
        true,
        'Session activity must continue after its tool completes',
      );
    },
  );

  await run(
    'ongoing activity returns for later tools and exposes failures and cancellation',
    async () => {
      const activity = () => {
        const item = document.getElementById('conversation-activity');
        return {
          visible: !item.hidden && item.getClientRects().length > 0,
          text: item.textContent,
        };
      };
      assert.equal((await evaluate(activity)).visible, true);
      Object.assign(hub.sessions[0].conversation.at(-1), {
        status: 'failed',
        streaming: false,
        text: 'Command exited with status 2',
        error: 'Permission denied: config.txt',
        finishedAt: at,
      });
      Object.assign(hub.sessions[0].session, {
        status: 'idle',
        activity: 'Command failed',
        error: 'Permission denied: config.txt',
      });
      await publish();
      assert.equal((await evaluate(activity)).visible, false);
      assert.deepEqual(
        await evaluate(() => ({
          parent: document.getElementById('parent-status').textContent,
          inspector: document.getElementById('inspector-status').textContent,
        })),
        {parent: 'Error', inspector: 'Error'},
      );
      const failed = await evaluate(
        () =>
          document.querySelector('#conversation li.conversation-tool')
            .textContent,
      );
      assert.match(failed, /failed/i);
      assert.match(failed, /Command exited with status 2/);
      assert.deepEqual(
        await evaluate(() => {
          const row = document.querySelector(
            '#conversation .conversation-tool',
          );
          const error = row.querySelector('.conversation-error');
          return {
            status: row.dataset.status,
            error: error.textContent,
            visible: !error.hidden && error.getClientRects().length > 0,
          };
        }),
        {
          status: 'failed',
          error: 'Permission denied: config.txt',
          visible: true,
        },
      );
      hub.sessions[0].conversation.push({
        ...hub.sessions[0].conversation.at(-1),
        id: 'second-tool',
        toolCallId: 'second-call',
        status: 'running',
        streaming: true,
        text: 'Retry output',
        error: undefined,
        finishedAt: undefined,
      });
      Object.assign(hub.sessions[0].session, {
        status: 'running',
        activity: 'Retrying bash command',
        error: undefined,
      });
      await publish();
      const retryActivity = await evaluate(activity);
      assert.equal(
        retryActivity.visible,
        true,
        'Activity must return after the first operation',
      );
      assert.match(retryActivity.text, /Retrying bash command/);
      Object.assign(hub.sessions[0].conversation.at(-1), {
        status: 'cancelled',
        streaming: false,
        finishedAt: at,
      });
      hub.sessions[0].session.status = 'idle';
      await publish();
      assert.match(
        await evaluate(
          () =>
            [
              ...document.querySelectorAll(
                '#conversation li.conversation-tool',
              ),
            ].at(-1).textContent,
        ),
        /cancelled/i,
      );
      assert.equal((await evaluate(activity)).visible, false);
    },
  );

  await run('live activity events disclose linked details', async () => {
    hub.sessions[0].changes = [
      {
        id: 'change-1',
        unitId: 'parent',
        unitName: 'Alpha factory',
        path: 'src/example.js',
        tool: 'edit',
        summary: 'Updated the example',
        diff: 'diff --git a/src/example.js b/src/example.js\n+const value = 1;\n',
        at,
      },
    ];
    hub.sessions[0].events = [
      {
        id: 'event-tool-change',
        sourceId: 'parent',
        sourceName: 'Alpha factory',
        kind: 'tool',
        message: 'Ran a command',
        conversationId: 'alpha-tool',
        details: {},
        at,
      },
      {
        id: 'event-change',
        sourceId: 'parent',
        sourceName: 'Alpha factory',
        kind: 'tool',
        message: 'Updated the example: src/example.js',
        details: {
          File: 'src/example.js',
          Tool: 'edit',
          Diff: hub.sessions[0].changes[0].diff,
        },
        at,
      },
    ];
    hub.sessions[0].agents = [
      {
        id: 'worker-1',
        name: 'Fixture worker',
        task: 'Inspect the fixture project',
        cwd: directory,
        status: 'running',
        createdAt: at,
        startedAt: at,
        model: 'fixture/worker',
        activity: 'Reading src/example.js',
        output: 'Found the example value',
        autoCleanup: false,
        taskTruncated: false,
        outputTruncated: false,
      },
    ];
    hub.sessions[0].totalAgents = 1;
    hub.sessions[0].events.push({
      id: 'event-worker',
      sourceId: 'worker-1',
      sourceName: 'Fixture worker',
      kind: 'activity',
      message: 'Worker inspected the file',
      at,
    });
    await publish();
    await evaluate(() => document.getElementById('tab-feed').click());
    await settle();
    const parentDetail = await evaluate(() => {
      const event = document.querySelector('#live-feed .feed-event');
      event.querySelector('summary').click();
      return event.textContent;
    });
    assert.match(parentDetail, /printf "first line/);
    assert.match(parentDetail, /first line/);
    const changeDetail = await evaluate(() => {
      const event = document.querySelectorAll('#live-feed .feed-event')[1];
      event.querySelector('summary').click();
      return event.textContent;
    });
    assert.match(changeDetail, /src\/example\.js/);
    assert.match(changeDetail, /const value = 1/);
    await evaluate(() =>
      [...document.querySelectorAll('#active-workers button')]
        .find(item => item.textContent.includes('Fixture worker'))
        .click(),
    );
    await settle();
    const workerDetail = await evaluate(() => {
      const event = document.querySelector('#live-feed .feed-event');
      event.querySelector('summary').click();
      return event.textContent;
    });
    assert.match(workerDetail, /Inspect the fixture project/);
    assert.match(workerDetail, /Reading src\/example\.js/);
    assert.match(workerDetail, /Found the example value/);
  });

  await run(
    'agent live feed keeps green working yellow queued and blue completed history',
    async () => {
      const agent = {
        id: 'status-agent',
        name: 'Status agent',
        task: 'Inspect the project',
        activity: 'Completed the inspection',
        model: 'fixture/small',
        status: 'completed',
        createdAt: at,
        startedAt: at,
        finishedAt: at,
      };
      hub.sessions[0].agents = [agent];
      hub.sessions[0].totalAgents = 1;
      hub.sessions[0].events = ['queued', 'running', 'completed'].map(
        (status, index) => ({
          id: `status-event-${index}`,
          sourceId: agent.id,
          sourceName: agent.name,
          kind: 'agent',
          message: `Inspection ${status}`,
          details: {Status: status},
          at,
        }),
      );
      await publish();
      await evaluate(() => {
        document.querySelector('#history-workers button').click();
        document.getElementById('tab-feed').click();
      });
      await settle();
      const feed = () =>
        [...document.querySelectorAll('#live-feed .feed-event')].map(row => {
          const badge = row.querySelector('.status-badge');
          return {
            label: badge.textContent,
            visible: !badge.hidden && badge.getClientRects().length > 0,
            accent: getComputedStyle(row).borderLeftColor,
            color: getComputedStyle(badge).color,
            background: getComputedStyle(badge).backgroundColor,
          };
        });
      const original = await evaluate(feed);
      assert.deepEqual(
        original.map(row => row.label),
        ['Queued', 'Working', 'Completed'],
        'Historical events must expose the recorded status of the agent',
      );
      assert.ok(original.every(row => row.visible));
      assert.equal(new Set(original.map(row => row.accent)).size, 3);
      for (const row of original) {
        assert.equal(row.accent, row.color);
        assert.ok(
          contrast(row.color, row.background) >= 4.5,
          `${row.label} must remain readable`,
        );
      }
      const [queued, working, completed] = original.map(row =>
        rgbChannels(row.accent),
      );
      assert.ok(working[1] > working[0] + 30 && working[1] > working[2] + 30);
      assert.ok(queued[0] > queued[2] + 60 && queued[1] > queued[2] + 60);
      assert.ok(
        completed[2] > completed[1] + 30 && completed[1] > completed[0] + 30,
        'Completed must look blue with a clear difference from green',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR) {
        await evaluate(() => {
          for (const details of document.querySelectorAll('#live-feed details'))
            details.open = false;
          document.getElementById('panel-feed').scrollTop = 0;
        });
        await screenshot('agent-status-live-feed');
      }
      agent.status = 'failed';
      agent.activity = 'Inspection failed';
      hub.sessions[0].events.push({
        id: 'status-event-failed',
        sourceId: agent.id,
        sourceName: agent.name,
        kind: 'error',
        message: agent.activity,
        details: {Status: agent.status},
        at,
      });
      await publish();
      const updated = await evaluate(feed);
      assert.deepEqual(
        updated.slice(0, 3),
        original,
        'A new agent status must preserve earlier event colors and labels',
      );
      assert.equal(updated[3].label, 'Failed');
      const failed = rgbChannels(updated[3].accent);
      assert.ok(failed[0] > failed[1] + 50 && failed[0] > failed[2] + 50);
    },
  );

  await run(
    'selected agents are clear and readable in cards scene labels and fallback',
    async () => {
      hub.sessions[0].agents = ['running', 'queued', 'completed'].map(
        (status, index) => ({
          id: `selection-agent-${index}`,
          name: ['Working agent', 'Queued agent', 'Completed agent'][index],
          task: 'Inspect the project',
          activity:
            status === 'queued' ? 'Waiting for a slot' : 'Inspecting files',
          model: 'fixture/small',
          status,
          createdAt: at,
          startedAt: at,
          ...(status === 'completed' ? {finishedAt: at} : {}),
        }),
      );
      hub.sessions[0].totalAgents = 3;
      await publish();
      await evaluate(() => document.getElementById('motion-toggle').click());
      await settle();
      const themes = await evaluate(() =>
        [...document.getElementById('factory-theme').options].map(
          option => option.value,
        ),
      );
      const selected = () => {
        const card = document.querySelector(
          '#active-workers [aria-pressed="true"], #history-workers [aria-pressed="true"]',
        );
        const label = document.querySelector(
          '#scene-labels [aria-pressed="true"]',
        );
        const other = document.querySelector(
          '#active-workers [aria-pressed="false"]',
        );
        const style = item => ({
          color: getComputedStyle(item).color,
          background: getComputedStyle(item).backgroundColor,
        });
        return {
          inspector: document.getElementById('inspector-title').textContent,
          card: {
            ...style(card),
            name: card.querySelector('.worker-card-name, .history-row-name')
              .textContent,
            taskColor: getComputedStyle(
              card.querySelector('.worker-card-task, .history-row-task'),
            ).color,
          },
          label: {
            ...style(label),
            color: getComputedStyle(label.querySelector('.scene-label-name'))
              .color,
            name: label.textContent,
          },
          other: style(other),
          selectedCards: document.querySelectorAll(
            '#active-workers [aria-pressed="true"], #history-workers [aria-pressed="true"]',
          ).length,
          selectedLabels: document.querySelectorAll(
            '#scene-labels [aria-pressed="true"]',
          ).length,
        };
      };
      for (const theme of themes) {
        await evaluate(theme => {
          const select = document.getElementById('factory-theme');
          select.value = theme;
          select.dispatchEvent(new Event('change', {bubbles: true}));
        }, theme);
        for (const name of [
          'Working agent',
          'Queued agent',
          'Completed agent',
        ]) {
          await evaluate(
            name =>
              [
                ...document.querySelectorAll(
                  '#active-workers button, #history-workers button',
                ),
              ]
                .find(item => item.textContent.includes(name))
                .click(),
            name,
          );
          await settle();
          const result = await evaluate(selected);
          assert.equal(result.inspector, name);
          assert.equal(result.card.name, name);
          assert.equal(result.label.name, name);
          assert.equal(result.selectedCards, 1);
          assert.equal(result.selectedLabels, 1);
          assert.ok(
            contrast(result.card.background, result.other.background) >= 3,
            `${theme}: selection must stand out from the other agents`,
          );
          for (const surface of [result.card, result.label])
            assert.ok(
              contrast(surface.color, surface.background) >= 4.5,
              `${theme}: the selected name must remain readable`,
            );
          assert.ok(
            contrast(result.card.taskColor, result.card.background) >= 4.5,
            `${theme}: the selected task must remain readable`,
          );
        }
      }
      await evaluate(() => {
        const select = document.getElementById('factory-theme');
        select.value = 'factory';
        select.dispatchEvent(new Event('change', {bubbles: true}));
        [...document.querySelectorAll('#active-workers button')]
          .find(item => item.textContent.includes('Working agent'))
          .click();
      });
      await settle();
      const bounds = await evaluate(() => {
        const rect = document.getElementById('scene').getBoundingClientRect();
        return {
          x: Math.ceil(rect.x),
          y: Math.ceil(rect.y),
          width: Math.floor(rect.width),
          height: Math.floor(rect.height),
        };
      });
      const before = (await window.webContents.capturePage(bounds)).toBitmap();
      await evaluate(() =>
        [...document.querySelectorAll('#scene-labels button')]
          .find(item => item.textContent === 'Queued agent')
          .click(),
      );
      await settle();
      assert.equal((await evaluate(selected)).inspector, 'Queued agent');
      const after = (await window.webContents.capturePage(bounds)).toBitmap();
      let changed = 0;
      for (let offset = 0; offset < before.length; offset += 4)
        if (
          !before
            .subarray(offset, offset + 4)
            .equals(after.subarray(offset, offset + 4))
        )
          changed++;
      assert.ok(
        changed > 50,
        'Selecting an agent must visibly change the still 3D scene',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR) {
        await evaluate(() =>
          document.querySelector('#active-workers .selected').scrollIntoView({
            block: 'nearest',
          }),
        );
        await screenshot('selected-queued-agent');
      }

      // Exercise the same selection when WebGL is unavailable in the browser.
      window.webContents.debugger.attach('1.3');
      await window.webContents.debugger.sendCommand('Page.enable');
      const {identifier} = await window.webContents.debugger.sendCommand(
        'Page.addScriptToEvaluateOnNewDocument',
        {
          source: `(() => {
            const getContext = HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext = function(type, ...args) {
              return type === 'webgl' ? null : getContext.call(this, type, ...args);
            };
          })();`,
        },
      );
      try {
        await reloadPage();
        assert.equal(
          await evaluate(() => !document.getElementById('fallback').hidden),
          true,
          'Disabling WebGL must reveal the fallback scene',
        );
        await evaluate(() =>
          [...document.querySelectorAll('#fallback-units button')]
            .find(item => item.textContent.includes('Queued agent'))
            .click(),
        );
        await settle();
        const fallback = await evaluate(() => {
          const station = document.querySelector(
            '#fallback-units [aria-pressed="true"]',
          );
          const other = document.querySelector(
            '#fallback-units [aria-pressed="false"]',
          );
          return {
            visible: !document.getElementById('fallback').hidden,
            inspector: document.getElementById('inspector-title').textContent,
            selected: station.classList.contains('selected'),
            name: station.querySelector('strong').textContent,
            color: getComputedStyle(station.querySelector('strong')).color,
            background: getComputedStyle(station).backgroundColor,
            otherBackground: getComputedStyle(other).backgroundColor,
            cardSelected: document
              .querySelector('#active-workers .selected')
              .textContent.includes('Queued agent'),
          };
        });
        assert.equal(fallback.visible, true);
        assert.equal(fallback.selected, true);
        assert.equal(fallback.name, 'Queued agent');
        assert.equal(fallback.inspector, 'Queued agent');
        assert.equal(fallback.cardSelected, true);
        assert.ok(contrast(fallback.color, fallback.background) >= 4.5);
        assert.ok(contrast(fallback.background, fallback.otherBackground) >= 3);
        if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
          await screenshot('selected-agent-fallback');
      } finally {
        await window.webContents.debugger.sendCommand(
          'Page.removeScriptToEvaluateOnNewDocument',
          {identifier},
        );
        window.webContents.debugger.detach();
      }
    },
  );

  await run('switching parents restores each draft and cursor', async () => {
    await evaluate(() => {
      const editor = document.getElementById('parent-prompt');
      editor.value = 'Alpha unsent\nsecond line';
      editor.dispatchEvent(new Event('input', {bubbles: true}));
      editor.setSelectionRange(3, 9);
      [...document.querySelectorAll('#parents button')]
        .find(item => item.textContent.includes('Beta factory'))
        .click();
    });
    await settle();
    const beta = await evaluate(
      () => document.getElementById('parent-prompt').value,
    );
    assert.equal(beta, '');
    await evaluate(() => {
      const editor = document.getElementById('parent-prompt');
      editor.value = 'Beta unsent';
      editor.dispatchEvent(new Event('input', {bubbles: true}));
      [...document.querySelectorAll('#parents button')]
        .find(item => item.textContent.includes('Alpha factory'))
        .click();
    });
    await settle();
    const alpha = await evaluate(() => {
      const editor = document.getElementById('parent-prompt');
      const before = editor.getBoundingClientRect().height;
      const handle = document.getElementById('parent-prompt-resize');
      handle.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
          cancelable: true,
        }),
      );
      return {
        draft: editor.value,
        start: editor.selectionStart,
        end: editor.selectionEnd,
        before,
        after: editor.getBoundingClientRect().height,
        handle: handle.getAttribute('role'),
        label: handle.getAttribute('aria-label'),
      };
    });
    assert.equal(alpha.draft, 'Alpha unsent\nsecond line');
    assert.equal(alpha.start, 3);
    assert.equal(alpha.end, 9);
    assert.equal(alpha.handle, 'separator');
    assert.equal(alpha.label, 'Resize message field');
    assert.ok(alpha.after > alpha.before, 'Resize handle must grow the editor');
    await evaluate(() =>
      [...document.querySelectorAll('#parents button')]
        .find(item => item.textContent.includes('Beta factory'))
        .click(),
    );
    await settle();
    assert.equal(
      await evaluate(() => document.getElementById('parent-prompt').value),
      'Beta unsent',
    );
  });

  for (const [width, height] of [
    [1100, 760],
    [1600, 1000],
  ]) {
    await run(
      `composer remains below conversation and visible at ${width}×${height}`,
      async () => {
        Object.assign(hub.sessions[0].session, {
          owned: false,
          controllable: true,
        });
        hub.sessions.push(
          ...Array.from({length: 8}, (_, index) =>
            session(`extra-${index}`, `Additional factory ${index}`),
          ),
        );
        hub.sessions[0].agents = Array.from({length: 16}, (_, index) => ({
          id: `layout-worker-${index}`,
          name: `Worker ${index}`,
          task: `Inspect the project and report detailed findings ${index}`,
          activity: 'Checking files and running the relevant tests',
          model: 'fixture/small',
          status: index < 8 ? 'running' : 'completed',
          createdAt: at,
          startedAt: at,
          ...(index >= 8 ? {finishedAt: at} : {}),
        }));
        hub.sessions[0].totalAgents = 16;
        hub.sessions[0].session.context = {
          percent: 25,
          tokens: 32000,
          window: 128000,
        };
        hub.sessions[0].conversation = Array.from({length: 30}, (_, index) => ({
          id: `layout-message-${index}`,
          role: index % 2 ? 'assistant' : 'user',
          at,
          text: `History message ${index}\n${'Readable history line\n'.repeat(4)}`,
        }));
        await publish();
        await evaluate(() => {
          document.getElementById('parent-prompt').style.height = '400px';
        });
        await settle();
        const geometry = await evaluate(() => {
          const composer = document.getElementById('composer-slot');
          const panel = document.getElementById('panel-conversation');
          const inspector = document.getElementById('inspector');
          const editor = document.getElementById('parent-prompt');
          const send = document.getElementById('send-prompt');
          const overview = document.querySelector('.overview');
          const rect = item => {
            const {top, bottom, left, right, height} =
              item.getBoundingClientRect();
            return {top, bottom, left, right, height};
          };
          return {
            viewport: {width: innerWidth, height: innerHeight},
            composer: rect(composer),
            panel: rect(panel),
            editor: rect(editor),
            send: rect(send),
            inspector: rect(inspector),
            overview: rect(overview),
            overviewInFactory:
              overview.parentElement.classList.contains('factory-column'),
            parent: composer.parentElement === inspector,
            follows: !!(
              panel.compareDocumentPosition(composer) &
              Node.DOCUMENT_POSITION_FOLLOWING
            ),
            flex: getComputedStyle(inspector).display,
            workspaceInChanges: document
              .getElementById('panel-changes')
              .contains(document.querySelector('.workspace-section')),
            attachedNoteVisible:
              !document.getElementById('attached-note').hidden &&
              document.getElementById('attached-note').getClientRects().length >
                0,
            editorUsable:
              document.elementFromPoint(
                editor.getBoundingClientRect().left + 5,
                editor.getBoundingClientRect().bottom - 5,
              ) === editor,
            usable:
              document
                .elementFromPoint(
                  send.getBoundingClientRect().left + 5,
                  send.getBoundingClientRect().top + 5,
                )
                ?.closest('button') === send,
          };
        });
        assert.deepEqual(geometry.viewport, {width, height});
        assert.equal(geometry.parent, true);
        assert.equal(
          geometry.follows,
          true,
          'Composer must follow tab panels in DOM order',
        );
        assert.equal(geometry.flex, 'flex');
        assert.equal(geometry.workspaceInChanges, true);
        assert.equal(geometry.overviewInFactory, true);
        assert.ok(
          geometry.overview.right <= geometry.inspector.left,
          'Overview must sit in the factory column beside the inspector',
        );
        assert.ok(
          Math.abs(geometry.overview.top - geometry.inspector.top) <= 1,
          'Conversation inspector must begin beside the overview',
        );
        assert.equal(geometry.attachedNoteVisible, true);
        assert.ok(geometry.panel.height >= 90, JSON.stringify(geometry));
        assert.ok(
          geometry.composer.top >= geometry.panel.bottom - 1,
          JSON.stringify(geometry),
        );
        assert.ok(geometry.editor.height >= 40, JSON.stringify(geometry));
        assert.ok(
          geometry.editor.height <= height * 0.46,
          JSON.stringify(geometry),
        );
        assert.equal(
          geometry.editorUsable,
          true,
          'The bottom of a resized editor must remain visible and uncovered',
        );
        assert.ok(
          geometry.editor.top >= 0 && geometry.send.bottom <= height,
          JSON.stringify(geometry),
        );
        assert.ok(
          geometry.editor.left >= 0 && geometry.editor.right <= width,
          JSON.stringify(geometry),
        );
        assert.equal(
          geometry.usable,
          true,
          'Send button must be visible and uncovered',
        );
        const scroll = await evaluate(() => {
          const controls = document.querySelector('.app-controls');
          const before = controls.getBoundingClientRect().top;
          const column = document.querySelector('.factory-column');
          const conversation = document.getElementById('panel-conversation');
          column.scrollTop = 200;
          const lists = ['parents', 'active-workers', 'history-workers'].map(
            id => {
              const list = document.getElementById(id);
              list.scrollTop = 120;
              return {id, top: list.scrollTop};
            },
          );
          conversation.scrollTop = 120;
          conversation.dispatchEvent(new Event('scroll'));
          return {
            before,
            after: controls.getBoundingClientRect().top,
            factory: column.scrollTop,
            factoryOverflow: column.scrollHeight - column.clientHeight,
            mainOverflow:
              document.querySelector('main').scrollHeight -
              document.querySelector('main').clientHeight,
            lists,
            conversation: conversation.scrollTop,
            body: document.body.scrollTop,
            document: document.scrollingElement.scrollTop,
            window: window.scrollY,
            bodyOverflow: getComputedStyle(document.body).overflow,
            htmlOverflow: getComputedStyle(document.documentElement).overflow,
            composerBottom: document
              .getElementById('composer-slot')
              .getBoundingClientRect().bottom,
          };
        });
        assert.equal(scroll.factory, 0, 'The factory column must not scroll');
        assert.ok(scroll.factoryOverflow <= 1, JSON.stringify(scroll));
        assert.ok(scroll.mainOverflow <= 1, JSON.stringify(scroll));
        assert.ok(scroll.conversation > 0, JSON.stringify(scroll));
        for (const list of scroll.lists)
          assert.ok(
            list.top > 0,
            `${list.id} must keep overflowing entries accessible`,
          );
        assert.equal(
          scroll.after,
          scroll.before,
          'App controls must remain visible while lists and conversation scroll',
        );
        assert.equal(scroll.body, 0);
        assert.equal(scroll.document, 0);
        assert.equal(scroll.window, 0);
        assert.equal(scroll.bodyOverflow, 'hidden');
        assert.equal(scroll.htmlOverflow, 'hidden');
        assert.ok(scroll.composerBottom <= height, JSON.stringify(scroll));
        const factoryGeometry = async () =>
          evaluate(() => {
            const selectors = [
              '#overview-title',
              '#factory-title',
              '#scene',
              '#inspect-parent',
              '#workers-title',
              '#active-workers',
              '#history-title',
              '#history-search',
              '#history-workers',
            ];
            return selectors.map(selector => {
              const element = document.querySelector(selector);
              const rect = element.getBoundingClientRect();
              return {
                selector,
                height: rect.height,
                visible:
                  rect.top >= 0 &&
                  rect.bottom <= innerHeight &&
                  rect.left >= 0 &&
                  rect.right <= innerWidth &&
                  element.contains(
                    document.elementFromPoint(
                      rect.left + rect.width / 2,
                      rect.top + rect.height / 2,
                    ),
                  ),
              };
            });
          });
        for (const item of await factoryGeometry()) {
          assert.equal(item.visible, true, JSON.stringify(item));
          assert.ok(item.height > 0, JSON.stringify(item));
          if (item.selector === '#scene')
            assert.ok(item.height >= 90, JSON.stringify(item));
        }
        await evaluate(() => {
          const search = document.getElementById('history-search');
          search.value = 'Worker 15';
          search.dispatchEvent(new Event('input', {bubbles: true}));
          document.querySelector('#history-workers button').click();
        });
        assert.equal(
          await evaluate(
            () => document.getElementById('inspector-title').textContent,
          ),
          'Worker 15',
        );
        await evaluate(() => document.getElementById('inspect-parent').click());
        await settle();
        if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
          await screenshot(`factory-populated-${width}x${height}`);
        window.webContents.setZoomFactor(1.25);
        await settle();
        for (const item of await factoryGeometry())
          assert.equal(
            item.visible,
            true,
            `At 125% zoom: ${JSON.stringify(item)}`,
          );
        assert.equal(
          await evaluate(() => {
            const button = document.getElementById('send-prompt');
            const rect = button.getBoundingClientRect();
            return (
              rect.bottom <= innerHeight &&
              document.elementFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
              ) === button
            );
          }),
          true,
          'Steer must remain visible after zooming with a resized editor',
        );
        window.webContents.setZoomFactor(1);
        await settle();
        await evaluate(() => document.getElementById('tab-changes').click());
        await settle();
        assert.equal(
          await evaluate(() => {
            const workspace = document.querySelector('.workspace-section');
            return (
              workspace.getClientRects().length > 0 &&
              !workspace.closest('[hidden]')
            );
          }),
          true,
        );
        await evaluate(() =>
          document.getElementById('tab-conversation').click(),
        );
        hub.sessions = [
          session('alpha', 'Alpha factory'),
          session('beta', 'Beta factory'),
        ];
        await publish();
        await evaluate(() => {
          document.querySelector('.factory-column').scrollTop = 0;
        });
        await evaluate(() => {
          document.getElementById('parent-prompt').style.height = '';
        });
        await settle();
      },
      width,
      height,
    );
  }

  await run(
    'stream follows the bottom while preserving a reader’s history position',
    async () => {
      hub.sessions[0].conversation = Array.from({length: 35}, (_, index) => ({
        id: `history-${index}`,
        role: index % 2 ? 'assistant' : 'user',
        at,
        text: `Message ${index}\n${'Readable history line\n'.repeat(4)}`,
      }));
      await publish();
      await evaluate(() => {
        const panel = document.getElementById('panel-conversation');
        panel.scrollTop = panel.scrollHeight;
        document.getElementById('follow-conversation').checked = true;
      });
      hub.sessions[0].conversation.at(-1).text += 'Live addition\n'.repeat(8);
      await publish();
      const bottomGap = await evaluate(() => {
        const panel = document.getElementById('panel-conversation');
        return panel.scrollHeight - panel.clientHeight - panel.scrollTop;
      });
      assert.ok(bottomGap < 4, `Follow left ${bottomGap}px below the viewport`);
      const before = await evaluate(() => {
        const panel = document.getElementById('panel-conversation');
        panel.scrollTop = 100;
        panel.dispatchEvent(new Event('scroll'));
        return panel.scrollTop;
      });
      hub.sessions[0].conversation.at(-1).text +=
        'More streamed output\n'.repeat(8);
      await publish();
      const after = await evaluate(
        () => document.getElementById('panel-conversation').scrollTop,
      );
      assert.ok(
        Math.abs(after - before) <= 1,
        `Reading history moved from ${before} to ${after}`,
      );
    },
  );

  await run(
    'robot motion follows thinking writing and tool activity and respects Motion off',
    async () => {
      await evaluate(() => {
        if (
          document
            .getElementById('motion-toggle')
            .getAttribute('aria-pressed') !== 'true'
        )
          document.getElementById('motion-toggle').click();
      });
      hub.sessions[0].session.activity = 'Thinking';
      await publish();
      const bounds = await evaluate(() => {
        const rect = document
          .getElementById('factory-canvas')
          .getBoundingClientRect();
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.floor(rect.width),
          height: Math.floor(Math.min(rect.height, innerHeight - rect.y)),
        };
      });
      assert.equal(
        await evaluate(() => document.getElementById('factory-canvas').hidden),
        false,
        'The live scene must render',
      );
      const frame = async () =>
        (await window.webContents.capturePage(bounds)).toBitmap();
      const thinking = await frame();
      await new Promise(resolve => setTimeout(resolve, 180));
      assert.equal(
        thinking.equals(await frame()),
        false,
        'The working robot must visibly move between frames',
      );
      await evaluate(() => document.getElementById('motion-toggle').click());
      await settle();
      const still = await frame();
      await new Promise(resolve => setTimeout(resolve, 180));
      assert.equal(
        still.equals(await frame()),
        true,
        'Motion off must freeze the scene',
      );
      hub.sessions[0].session.activity = 'Responding';
      await publish();
      const writing = await frame();
      assert.equal(
        still.equals(writing),
        false,
        'Writing must have a different pose from thinking',
      );
      hub.sessions[0].session.activity = 'Using bash';
      await publish();
      assert.equal(
        writing.equals(await frame()),
        false,
        'Tool use must have a different pose from writing',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('robot-tools');
      await evaluate(() => document.getElementById('motion-toggle').click());
    },
  );

  await run(
    'Escape stops active work once preserves the draft and resumes visuals on the next run',
    async () => {
      hub.sessions[0].session.activity = 'Thinking about the next operation';
      await publish();
      assert.equal(
        await evaluate(
          () => document.getElementById('processing-bubble-text').textContent,
        ),
        'Thinking',
      );
      assert.equal(
        await evaluate(() =>
          document.getElementById('scene').classList.contains('is-processing'),
        ),
        true,
      );
      assert.match(
        await evaluate(
          () => document.getElementById('abort-parent').textContent,
        ),
        /Stop.*Esc/,
      );
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = 'Keep this unsent draft\nsecond line';
        editor.focus();
        editor.setSelectionRange(5, 16, 'backward');
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        window.fixtureRepeat = false;
        editor.addEventListener('keydown', event => {
          if (event.key === 'Escape' && event.repeat)
            window.fixtureRepeat = true;
        });
        editor.dispatchEvent(new Event('compositionstart', {bubbles: true}));
      });
      await press('Escape');
      assert.deepEqual(
        calls,
        [],
        'Escape during composition must preserve the active task',
      );
      await evaluate(() =>
        document
          .getElementById('parent-prompt')
          .dispatchEvent(new Event('compositionend', {bubbles: true})),
      );
      await press('Escape');
      await press('Escape', ['isautorepeat']);
      assert.equal(
        await evaluate(() => window.fixtureRepeat),
        true,
        'The repeated native key event must carry the browser repeat flag',
      );
      assert.deepEqual(calls, [
        {method: 'abort', sessionId: 'alpha', request: undefined},
      ]);
      const draft = () => {
        const editor = document.getElementById('parent-prompt');
        return {
          value: editor.value,
          start: editor.selectionStart,
          end: editor.selectionEnd,
          direction: editor.selectionDirection,
        };
      };
      const expectedDraft = {
        value: 'Keep this unsent draft\nsecond line',
        start: 5,
        end: 16,
        direction: 'backward',
      };
      assert.deepEqual(await evaluate(draft), expectedDraft);
      assert.deepEqual(
        await evaluate(() => ({
          processing: document
            .getElementById('scene')
            .classList.contains('is-processing'),
          stopping: document
            .getElementById('scene')
            .classList.contains('is-stopping'),
          bubbleHidden: document.getElementById('processing-bubble').hidden,
          status: document.getElementById('processing-state-text').textContent,
          paused: document
            .getElementById('processing-state')
            .classList.contains('paused'),
          indicator: getComputedStyle(
            document.querySelector('#processing-state > i'),
          ).animationName,
          activityIndicator: getComputedStyle(
            document.querySelector('#conversation-activity .activity-dot'),
          ).animationName,
          yellowBurst: !!document.getElementById('stop-burst'),
          effect: document
            .getElementById('scene')
            .classList.contains('is-startled'),
          alert: getComputedStyle(document.getElementById('scene'), '::before')
            .animationName,
        })),
        {
          processing: false,
          stopping: true,
          bubbleHidden: true,
          status: 'Stopping',
          paused: true,
          indicator: 'none',
          activityIndicator: 'none',
          yellowBurst: false,
          effect: true,
          alert: 'factory-alert',
        },
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('startled-robot');
      // A fast cancellation must still let the reaction finish.
      Object.assign(hub.sessions[0].session, {
        status: 'idle',
        activity: 'Ready',
      });
      Object.assign(hub.sessions[0].conversation.at(-1), {
        status: 'cancelled',
        streaming: false,
        finishedAt: at,
      });
      await publish();
      const sceneBounds = await evaluate(() => {
        const scene = document.getElementById('scene');
        // Compare the robot itself without the CSS alert tint changing pixels.
        scene.classList.remove('is-startled');
        const gl = document
          .getElementById('factory-canvas')
          .getContext('webgl');
        const bufferData = gl.bufferData.bind(gl);
        window.fixtureGeometry = new Map();
        gl.bufferData = (target, data, usage) => {
          if (usage === gl.DYNAMIC_DRAW)
            window.fixtureGeometry.set(
              gl.getParameter(gl.ARRAY_BUFFER_BINDING),
              new Float32Array(data),
            );
          bufferData(target, data, usage);
        };
        const rect = scene.getBoundingClientRect();
        return {
          x: Math.ceil(rect.x),
          y: Math.ceil(rect.y),
          width: Math.floor(rect.width),
          height: Math.floor(rect.height),
        };
      });
      const frame = async () =>
        (await window.webContents.capturePage(sceneBounds)).toBitmap();
      const airborne = await frame();
      await new Promise(resolve => setTimeout(resolve, 180));
      assert.equal(
        airborne.equals(await frame()),
        false,
        'The stopped robot must jump while normal activity is paused',
      );
      await new Promise(resolve => setTimeout(resolve, 1100));
      const geometry = () =>
        evaluate(() =>
          [...window.fixtureGeometry.values()].map(data => {
            const bytes = new Uint8Array(data.buffer);
            let hash = 2166136261;
            for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
            return {length: data.length, hash: hash >>> 0};
          }),
        );
      // Idle camera movement changes pixels, but the landed robot must be still.
      const landed = await geometry();
      assert.ok(landed.some(buffer => buffer.length > 0));
      await new Promise(resolve => setTimeout(resolve, 180));
      assert.deepEqual(
        await geometry(),
        landed,
        'The startled robot must settle back to a still pose',
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('processing-state').hidden,
        ),
        true,
      );
      Object.assign(hub.sessions[0].session, {
        status: 'running',
        activity: 'Writing the next response',
      });
      await publish();
      assert.deepEqual(
        await evaluate(() => ({
          processing: document
            .getElementById('scene')
            .classList.contains('is-processing'),
          stopping: document
            .getElementById('scene')
            .classList.contains('is-stopping'),
          bubbleVisible: !document.getElementById('processing-bubble').hidden,
          phase: document.getElementById('processing-state-text').textContent,
          paused: document
            .getElementById('processing-state')
            .classList.contains('paused'),
          activityPaused: document
            .getElementById('conversation-activity')
            .classList.contains('paused'),
        })),
        {
          processing: true,
          stopping: false,
          bubbleVisible: true,
          phase: 'Writing',
          paused: false,
          activityPaused: false,
        },
      );
      assert.deepEqual(await evaluate(draft), expectedDraft);
      assert.equal(calls.length, 1);
      await evaluate(() => {
        document.getElementById('motion-toggle').click();
        document.getElementById('abort-parent').click();
      });
      await settle();
      assert.equal(
        await evaluate(
          () =>
            getComputedStyle(document.getElementById('scene'), '::before')
              .animationName,
        ),
        'none',
        'Motion off must use a static alert',
      );
      const stillStartle = await frame();
      await new Promise(resolve => setTimeout(resolve, 180));
      assert.equal(
        stillStartle.equals(await frame()),
        true,
        'Motion off must keep the robot still during Stop',
      );
      assert.equal(calls.filter(call => call.method === 'abort').length, 2);
      await evaluate(() =>
        [...document.querySelectorAll('#parents button')]
          .find(button => button.textContent.includes('Beta'))
          .click(),
      );
      assert.equal(
        await evaluate(() =>
          document.getElementById('scene').classList.contains('is-startled'),
        ),
        false,
        'Stopping one parent must not flash another parent’s factory',
      );
    },
  );

  await run(
    'skill palette and slash autocomplete insert commands before sending arguments',
    async () => {
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = 'explain the file';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        document.getElementById('open-commands').click();
      });
      await until(
        () => document.querySelectorAll('#command-catalog button').length === 4,
        'Skill catalog did not load from sessionFeatures',
      );
      const catalog = await evaluate(() => ({
        open: document.getElementById('commands-dialog').open,
        text: document.getElementById('command-catalog').textContent,
        tools: document.getElementById('available-tools').textContent,
      }));
      assert.equal(catalog.open, true);
      for (const source of ['Skill', 'Template', 'Extension', 'Command'])
        assert.ok(catalog.text.includes(source), `Catalog missing ${source}`);
      assert.match(catalog.tools, /bash/);
      await evaluate(() =>
        [...document.querySelectorAll('#command-catalog button')]
          .find(item => item.textContent.includes('/skill:inspect'))
          .click(),
      );
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        '/skill:inspect explain the file',
      );
      assert.equal(
        await evaluate(() => document.getElementById('commands-dialog').open),
        true,
      );
      await evaluate(() => document.getElementById('close-commands').click());
      assert.deepEqual(calls, [], 'Selecting a skill must only edit the draft');
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = '/skill:in';
        editor.focus();
        editor.dispatchEvent(new Event('input', {bubbles: true}));
      });
      await until(
        () => !document.getElementById('command-suggestions').hidden,
        'Slash suggestions did not appear',
      );
      await press('Return');
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        '/skill:inspect ',
      );
      assert.deepEqual(
        calls,
        [],
        'Autocomplete Enter must not submit a prompt',
      );
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value += 'src/index.ts';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
      });
      await press('Return');
      await until(
        () => document.getElementById('parent-prompt').value === '',
        'Prompt with arguments did not submit',
      );
      assert.deepEqual(calls, [
        {
          method: 'prompt',
          sessionId: 'alpha',
          request: {prompt: '/skill:inspect src/index.ts'},
        },
      ]);
    },
  );

  await run(
    'model and thinking settings apply while idle and during active work',
    async () => {
      assert.deepEqual(
        await evaluate(() => {
          const model = document.getElementById('factory-model');
          const effort = document.getElementById('factory-effort');
          const modelBounds = model.getBoundingClientRect();
          const effortBounds = effort.getBoundingClientRect();
          return {
            model: model.textContent,
            effort: effort.textContent,
            visible: effortBounds.width > 0 && effortBounds.height > 0,
            beside:
              effortBounds.left >= modelBounds.right &&
              effortBounds.top < modelBounds.bottom &&
              effortBounds.bottom > modelBounds.top,
          };
        }),
        {
          model: 'fixture/small',
          effort: 'Effort: medium',
          visible: true,
          beside: true,
        },
      );
      hub.sessions[0].session.status = 'idle';
      await publish();
      await evaluate(() =>
        document.getElementById('open-session-settings').click(),
      );
      await until(
        () =>
          !document.getElementById('apply-session-settings').disabled &&
          document.getElementById('session-model').options.length === 2,
        'Idle model settings did not load',
      );
      assert.deepEqual(
        await evaluate(() => ({
          model: document.getElementById('session-model').value,
          thinking: document.getElementById('session-thinking').value,
        })),
        {model: 'fixture/small', thinking: 'medium'},
      );
      await evaluate(() => {
        document.getElementById('session-model').value = 'fixture-other/large';
        document.getElementById('session-thinking').value = 'high';
        document.getElementById('apply-session-settings').click();
      });
      await until(
        () => !document.getElementById('apply-session-settings').disabled,
        'Applying model settings did not finish',
      );
      assert.deepEqual(calls, [
        {
          method: 'configureSession',
          sessionId: 'alpha',
          request: {
            provider: 'fixture-other',
            modelId: 'large',
            thinkingLevel: 'high',
          },
        },
      ]);
      assert.deepEqual(
        await evaluate(() => ({
          model: document.getElementById('session-model').value,
          thinking: document.getElementById('session-thinking').value,
        })),
        {model: 'fixture-other/large', thinking: 'high'},
      );
      assert.deepEqual(
        await evaluate(() => ({
          model: document.getElementById('factory-model').textContent,
          effort: document.getElementById('factory-effort').textContent,
        })),
        {model: 'fixture-other/large', effort: 'Effort: high'},
      );
      hub.sessions[0].session.status = 'running';
      await publish();
      assert.deepEqual(
        await evaluate(() => ({
          model: document.getElementById('session-model').disabled,
          thinking: document.getElementById('session-thinking').disabled,
          apply: document.getElementById('apply-session-settings').disabled,
          compact: document.getElementById('compact-session').disabled,
          reload: document.getElementById('reload-session').disabled,
        })),
        {
          model: false,
          thinking: false,
          apply: false,
          compact: true,
          reload: true,
        },
      );
      for (const request of [
        {provider: 'fixture-other', modelId: 'large', thinkingLevel: 'low'},
        {provider: 'fixture', modelId: 'small', thinkingLevel: 'medium'},
      ]) {
        await evaluate(request => {
          document.getElementById('session-model').value =
            `${request.provider}/${request.modelId}`;
          document.getElementById('session-thinking').value =
            request.thinkingLevel;
        }, request);
        // Streaming snapshots must preserve settings being edited.
        await publish();
        await evaluate(() =>
          document.getElementById('apply-session-settings').click(),
        );
        await until(
          () => !document.getElementById('apply-session-settings').disabled,
          'Applying settings during work did not finish',
        );
        assert.deepEqual(calls.at(-1), {
          method: 'configureSession',
          sessionId: 'alpha',
          request,
        });
        assert.equal(hub.sessions[0].session.status, 'running');
        assert.deepEqual(
          await evaluate(() => ({
            model: document.getElementById('factory-model').textContent,
            effort: document.getElementById('factory-effort').textContent,
          })),
          {
            model: `${request.provider}/${request.modelId}`,
            effort: `Effort: ${request.thinkingLevel}`,
          },
        );
      }
      hub.sessions[0].session.status = 'idle';
      await publish();
      assert.deepEqual(
        await evaluate(() => ({
          compact: document.getElementById('compact-session').disabled,
          reload: document.getElementById('reload-session').disabled,
        })),
        {compact: false, reload: false},
      );
      await evaluate(() =>
        document.getElementById('close-session-settings').click(),
      );
    },
  );

  await run(
    'extension dialogs return values and native cancellation alongside notifications',
    async () => {
      hub.sessions[0].ui = {
        dialogs: [],
        notifications: [
          {id: 'notice-1', type: 'info', message: 'Fixture extension ready'},
        ],
        statuses: [{key: 'fixture', text: 'Waiting for your choice'}],
        editor: {id: 'editor-1', text: 'Draft from extension'},
      };
      await publish();
      assert.match(
        await evaluate(
          () => document.getElementById('extension-notifications').textContent,
        ),
        /Fixture extension ready/,
      );
      assert.match(
        await evaluate(
          () => document.getElementById('extension-statuses').textContent,
        ),
        /Waiting for your choice/,
      );
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        'Draft from extension',
      );
      await evaluate(() =>
        document.querySelector('#extension-notifications button').click(),
      );
      await publish();
      assert.equal(
        await evaluate(
          () => document.getElementById('extension-notifications').hidden,
        ),
        true,
      );
      const requests = [
        {
          id: 'choose',
          kind: 'select',
          title: 'Choose a plan',
          options: ['Read', 'Review'],
        },
        {
          id: 'input',
          kind: 'input',
          title: 'Name the plan',
          placeholder: 'Plan name',
          prefill: 'Initial name',
        },
        {
          id: 'editor',
          kind: 'editor',
          title: 'Edit instructions',
          prefill: 'Initial instructions',
        },
        {
          id: 'confirm',
          kind: 'confirm',
          title: 'Confirm the plan',
          message: 'Continue with this plan?',
        },
      ];
      const values = [
        'Review',
        'Updated name',
        'Edited instructions\nsecond line',
        true,
      ];
      for (const [index, request] of requests.entries()) {
        hub.sessions[0].ui.dialogs = [request];
        await publish();
        const shown = await evaluate(() => ({
          modal: document.getElementById('extension-dialog').matches(':modal'),
          title: document.getElementById('extension-dialog-title').textContent,
          session: document.getElementById('extension-dialog-session')
            .textContent,
          input: document.getElementById('extension-dialog-input').value,
          editor: document.getElementById('extension-dialog-editor').value,
        }));
        assert.equal(shown.modal, true);
        assert.equal(shown.title, request.title);
        assert.equal(shown.session, 'Alpha factory');
        if (request.prefill) assert.equal(shown[request.kind], request.prefill);
        await evaluate(
          (kind, value) => {
            if (kind !== 'confirm')
              document.getElementById(`extension-dialog-${kind}`).value = value;
            document.getElementById('submit-extension-dialog').click();
          },
          request.kind,
          values[index],
        );
        await until(
          () => !document.getElementById('extension-dialog').open,
          'Extension response did not close the native dialog',
        );
      }
      hub.sessions[0].ui.dialogs = [
        {id: 'cancel', kind: 'input', title: 'Cancel this request'},
      ];
      await publish();
      await press('Escape');
      await until(
        () => !document.getElementById('extension-dialog').open,
        'Escape did not cancel the native extension dialog',
      );
      assert.deepEqual(calls, [
        ...requests.map((request, index) => ({
          method: 'respondToDialog',
          sessionId: 'alpha',
          dialogId: request.id,
          value: values[index],
        })),
        {
          method: 'respondToDialog',
          sessionId: 'alpha',
          dialogId: 'cancel',
          value: undefined,
        },
      ]);
    },
  );

  await run(
    'terminal extension dialog renders ANSI and forwards raw input before Cancel',
    async () => {
      await evaluate(() => {
        const Terminal = window.Terminal;
        if (!Terminal) throw new Error('Local xterm asset did not load');
        window.Terminal = class extends Terminal {
          constructor(options) {
            super(options);
            window.fixtureTerminal = this;
          }
        };
      });
      hub.sessions[0].ui = {
        dialogs: [
          {
            id: 'terminal-1',
            kind: 'terminal',
            title: 'Fixture terminal',
            terminal: {
              columns: 40,
              rows: 6,
              output: '\u001b[31mANSI ready\u001b[0m\r\nInput: ',
              revision: 1,
            },
          },
        ],
        notifications: [],
        statuses: [],
      };
      await publish();
      await until(
        () =>
          window.fixtureTerminal?.buffer.active
            .getLine(0)
            ?.translateToString(true) === 'ANSI ready',
        'xterm did not render the ANSI frame',
      );
      const rendered = await evaluate(() => ({
        modal: document.getElementById('extension-dialog').matches(':modal'),
        widget: !!document.querySelector('#extension-dialog-terminal .xterm'),
        input: !!document.querySelector('#extension-dialog-terminal textarea'),
        foreground: window.fixtureTerminal.buffer.active
          .getLine(0)
          .getCell(0)
          .getFgColor(),
        columns: window.fixtureTerminal.cols,
        rows: window.fixtureTerminal.rows,
      }));
      assert.deepEqual(rendered, {
        modal: true,
        widget: true,
        input: true,
        foreground: 1,
        columns: 40,
        rows: 6,
      });
      await press('Return');
      await until(
        () =>
          window.fixtureTerminal.buffer.active
            .getLine(2)
            ?.translateToString(true)
            .includes('Received'),
        'Terminal response frame did not render',
      );
      assert.deepEqual(calls[0], {
        method: 'respondToDialog',
        sessionId: 'alpha',
        dialogId: 'terminal-1',
        value: '\r',
      });
      await press('Escape');
      assert.deepEqual(calls[1], {
        method: 'respondToDialog',
        sessionId: 'alpha',
        dialogId: 'terminal-1',
        value: '\u001b',
      });
      assert.equal(
        await evaluate(() => document.getElementById('extension-dialog').open),
        true,
        'Escape must remain inside the terminal dialog',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('terminal-1600x1000');
      await evaluate(() =>
        document.getElementById('cancel-extension-dialog').click(),
      );
      await until(
        () => !document.getElementById('extension-dialog').open,
        'Cancel did not close the terminal dialog',
      );
      assert.deepEqual(calls[2], {
        method: 'respondToDialog',
        sessionId: 'alpha',
        dialogId: 'terminal-1',
        value: undefined,
      });
      assert.equal(calls.length, 3);
    },
  );

  await run(
    'custom extension editor sends the full draft and returns a focused saved composer draft',
    async () => {
      assert.equal(
        await evaluate(
          () => document.getElementById('extension-editor').hidden,
        ),
        true,
      );
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = 'Alpha unchanged draft';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        [...document.querySelectorAll('#parents button')]
          .find(item => item.textContent.includes('Beta factory'))
          .click();
      });
      await settle();
      hub.sessions[1].ui = {
        extensionEditor: {id: 'beta-editor-open'},
        dialogs: [],
        notifications: [],
        statuses: [],
      };
      await publish();
      assert.equal(
        await evaluate(() => {
          const button = document.getElementById('extension-editor');
          return !button.hidden && button.getClientRects().length > 0;
        }),
        true,
      );
      const originalDraft =
        'Full draft to the custom editor\n' +
        'Keep every line, symbol and instruction: äö ✓.\n'.repeat(12) +
        'FINAL DRAFT LINE';
      const returnedDraft =
        'Edited draft returned by the extension\nSecond line ✓';
      editorSubmission = returnedDraft;
      await evaluate(value => {
        const editor = document.getElementById('parent-prompt');
        editor.value = value;
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        document.getElementById('extension-editor').click();
      }, originalDraft);
      await until(
        () =>
          document.getElementById('extension-dialog').matches(':modal') &&
          !!document.querySelector('#extension-dialog-terminal .xterm'),
        'Custom editor did not open its terminal dialog',
      );
      assert.deepEqual(calls[0], {
        method: 'respondToDialog',
        sessionId: 'beta',
        dialogId: 'beta-editor-open',
        value: originalDraft,
      });
      await press('Return');
      await until(
        () => !document.getElementById('extension-dialog').open,
        'Submitted custom editor did not close its terminal dialog',
      );
      assert.deepEqual(
        await evaluate(() => {
          const editor = document.getElementById('parent-prompt');
          return {
            value: editor.value,
            focused: document.activeElement === editor,
            start: editor.selectionStart,
            end: editor.selectionEnd,
          };
        }),
        {
          value: returnedDraft,
          focused: true,
          start: returnedDraft.length,
          end: returnedDraft.length,
        },
      );
      await evaluate(() => document.getElementById('extension-editor').click());
      await until(
        () => document.getElementById('extension-dialog').matches(':modal'),
        'Custom editor could not reopen for cancellation',
      );
      await evaluate(() =>
        document.getElementById('cancel-extension-dialog').click(),
      );
      await until(
        () => !document.getElementById('extension-dialog').open,
        'Canceled custom editor did not close',
      );
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        returnedDraft,
        'Canceling a custom editor must preserve the existing draft',
      );
      delete hub.sessions[1].ui.extensionEditor;
      await publish();
      assert.equal(
        await evaluate(
          () => document.getElementById('extension-editor').hidden,
        ),
        true,
      );
      await evaluate(() =>
        [...document.querySelectorAll('#parents button')]
          .find(item => item.textContent.includes('Alpha factory'))
          .click(),
      );
      await settle();
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        'Alpha unchanged draft',
      );
      await evaluate(() =>
        [...document.querySelectorAll('#parents button')]
          .find(item => item.textContent.includes('Beta factory'))
          .click(),
      );
      await settle();
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        returnedDraft,
        'The returned custom editor text must be saved as Beta’s draft',
      );
      assert.deepEqual(calls, [
        {
          method: 'respondToDialog',
          sessionId: 'beta',
          dialogId: 'beta-editor-open',
          value: originalDraft,
        },
        {
          method: 'respondToDialog',
          sessionId: 'beta',
          dialogId: 'custom-editor-terminal',
          value: '\r',
        },
        {
          method: 'respondToDialog',
          sessionId: 'beta',
          dialogId: 'beta-editor-open',
          value: returnedDraft,
        },
        {
          method: 'respondToDialog',
          sessionId: 'beta',
          dialogId: 'custom-editor-terminal',
          value: undefined,
        },
      ]);
    },
  );

  await run(
    'Tokens shows measured input output cache cost zero usage and a visual budget',
    async () => {
      hub.sessions[0].session.context = {
        tokens: 3200,
        window: 64000,
        percent: 5,
      };
      hub.sessions[0].usage = {
        input: 1200,
        output: 200,
        cacheRead: 500,
        cacheWrite: 100,
        totalTokens: 2000,
        cost: 0.0184,
        truncated: false,
        calls: [
          {
            id: 'alpha-assistant',
            at,
            model: 'fixture/small',
            input: 1200,
            output: 200,
            cacheRead: 500,
            cacheWrite: 100,
            totalTokens: 2000,
            cost: 0.0184,
            toolNames: ['bash'],
            stopReason: 'toolUse',
          },
        ],
      };
      hub.sessions[0].agents = [
        {
          id: 'worker-1',
          name: 'Fixture worker',
          task: 'Read the fixture project',
          cwd: directory,
          status: 'completed',
          createdAt: at,
          startedAt: at,
          finishedAt: at,
          model: 'fixture/worker',
          activity: 'Completed fixture task',
          output: 'Fixture result',
          autoCleanup: false,
          taskTruncated: false,
          outputTruncated: false,
          usage: {
            input: 3000,
            output: 100,
            cacheRead: 150,
            cacheWrite: 50,
            totalTokens: 3300,
            cost: 0.0123,
            truncated: false,
            calls: [
              {
                id: 'worker-call',
                at,
                model: 'fixture/worker',
                input: 3000,
                output: 100,
                cacheRead: 150,
                cacheWrite: 50,
                totalTokens: 3300,
                cost: 0.0123,
                toolNames: ['read'],
                stopReason: 'stop',
              },
            ],
          },
        },
      ];
      hub.sessions[0].totalAgents = 1;
      await publish();
      await evaluate(() => document.getElementById('tab-tokens').click());
      const counts = await evaluate(() => {
        const count = id =>
          Number(document.getElementById(id).textContent.replace(/[^\d]/g, ''));
        return {
          input: count('usage-input'),
          output: count('usage-output'),
          cacheRead: count('usage-cache-read'),
          cacheWrite: count('usage-cache-write'),
          total: count('usage-total'),
          cost: document.getElementById('usage-cost').textContent,
          context: document
            .getElementById('context-budget-meter')
            .getAttribute('aria-valuenow'),
          limit: document
            .getElementById('context-budget-meter')
            .getAttribute('aria-valuemax'),
          rows: document.querySelectorAll('#usage-calls tr').length,
          call: document.querySelector('#usage-calls tr').textContent,
          bars: ['input', 'output', 'cache-read', 'cache-write'].map(
            id => document.getElementById(`usage-bar-${id}`).style.width,
          ),
        };
      });
      assert.deepEqual(
        {...counts, call: undefined},
        {
          input: 1200,
          output: 200,
          cacheRead: 500,
          cacheWrite: 100,
          total: 2000,
          cost: '$0.0184',
          context: '3200',
          limit: '64000',
          rows: 1,
          call: undefined,
          bars: ['60%', '10%', '25%', '5%'],
        },
      );
      assert.match(counts.call, /Requested bash/);
      await evaluate(() => {
        const target = document.getElementById('token-budget');
        target.value = '1500';
        target.dispatchEvent(new Event('input', {bubbles: true}));
      });
      assert.deepEqual(
        await evaluate(() => {
          const meter = document.getElementById('token-budget-meter');
          return {
            visible: !meter.hidden,
            over: meter.classList.contains('over-budget'),
            used: meter.getAttribute('aria-valuenow'),
            max: meter.getAttribute('aria-valuemax'),
            width: meter.style.getPropertyValue('--used'),
          };
        }),
        {visible: true, over: true, used: '2000', max: '1500', width: '100%'},
      );
      await evaluate(() => {
        const target = document.getElementById('token-budget');
        target.value = '4000';
        target.dispatchEvent(new Event('input', {bubbles: true}));
      });
      assert.deepEqual(
        await evaluate(() => {
          const meter = document.getElementById('token-budget-meter');
          return {
            over: meter.classList.contains('over-budget'),
            width: meter.style.getPropertyValue('--used'),
          };
        }),
        {over: false, width: '50%'},
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR) {
        for (const [width, height] of [
          [1100, 760],
          [1600, 1000],
        ]) {
          window.setContentSize(width, height);
          await settle();
          await screenshot(`tokens-${width}x${height}`);
        }
      }
      assert.deepEqual(
        await evaluate(() =>
          [...document.getElementById('usage-unit').options].map(
            item => item.value,
          ),
        ),
        ['parent', 'worker-1'],
      );
      await evaluate(() => {
        const selector = document.getElementById('usage-unit');
        selector.value = 'worker-1';
        selector.dispatchEvent(new Event('change', {bubbles: true}));
      });
      assert.deepEqual(
        await evaluate(() => ({
          recipient: document.getElementById('usage-recipient').textContent,
          totals: ['input', 'output', 'cache-read', 'cache-write', 'total'].map(
            id =>
              Number(
                document
                  .getElementById(`usage-${id}`)
                  .textContent.replace(/[^\d]/g, ''),
              ),
          ),
          cost: document.getElementById('usage-cost').textContent,
          contextHidden: document.getElementById('usage-context-section')
            .hidden,
          target: document.getElementById('token-budget').value,
          call: document.querySelector('#usage-calls .usage-call-link')
            .textContent,
        })),
        {
          recipient: 'Model usage for Fixture worker',
          totals: [3000, 100, 150, 50, 3300],
          cost: '$0.0123',
          contextHidden: true,
          target: '',
          call: 'Requested read',
        },
      );
      assert.equal(
        hub.sessions[0].usage.totalTokens,
        2000,
        'Worker usage must not replace parent accounting',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('tokens-worker-1600x1000');
      await evaluate(() => {
        const selector = document.getElementById('usage-unit');
        selector.value = 'parent';
        selector.dispatchEvent(new Event('change', {bubbles: true}));
      });
      assert.deepEqual(
        await evaluate(() => ({
          total: Number(
            document
              .getElementById('usage-total')
              .textContent.replace(/[^\d]/g, ''),
          ),
          contextHidden: document.getElementById('usage-context-section')
            .hidden,
          target: document.getElementById('token-budget').value,
        })),
        {total: 2000, contextHidden: false, target: '4000'},
      );
      hub.sessions[0].usage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: 0,
        calls: [],
        truncated: false,
      };
      hub.sessions[0].session.context.tokens = 0;
      await publish();
      assert.deepEqual(
        await evaluate(() => ({
          totals: ['input', 'output', 'cache-read', 'cache-write', 'total'].map(
            id => document.getElementById(`usage-${id}`).textContent,
          ),
          cost: document.getElementById('usage-cost').textContent,
          bars: ['input', 'output', 'cache-read', 'cache-write'].map(
            id => document.getElementById(`usage-bar-${id}`).style.width,
          ),
          empty: !document.getElementById('usage-empty').hidden,
          tableHidden: document.getElementById('usage-table').hidden,
          contextVisible: !document.getElementById('context-budget-meter')
            .hidden,
          context: document
            .getElementById('context-budget-meter')
            .getAttribute('aria-valuenow'),
        })),
        {
          totals: ['0', '0', '0', '0', '0'],
          cost: '$0.0000',
          bars: ['0%', '0%', '0%', '0%'],
          empty: true,
          tableHidden: true,
          contextVisible: true,
          context: '0',
        },
      );
      assert.deepEqual(
        calls,
        [],
        'Viewing usage and setting a budget must stay local',
      );
    },
  );

  await run(
    'assistant stream preserves native text selection and row identity',
    async () => {
      hub.sessions[0].conversation = [
        {
          id: 'answer',
          role: 'assistant',
          text: 'Selectable answer',
          at,
          streaming: true,
        },
      ];
      await publish();
      await evaluate(() => {
        const row = document.querySelector('#conversation > li');
        const text = row.querySelector('.conversation-text').firstChild;
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 10);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        window.fixtureNodes = {row, text};
      });
      hub.sessions[0].conversation[0].text += ' continues streaming';
      await publish();
      assert.deepEqual(
        await evaluate(() => ({
          row:
            document.querySelector('#conversation > li') ===
            window.fixtureNodes.row,
          text:
            document.querySelector('#conversation .conversation-text')
              .firstChild === window.fixtureNodes.text,
          selection: window.getSelection().toString(),
        })),
        {row: true, text: true, selection: 'Selectable'},
      );
    },
  );
  await run(
    'actions remain expanded and distinct through streaming, parent switches and reload',
    async () => {
      hub.sessions[0].conversation = [
        'read',
        'edit',
        'bash',
        'agent_spawn',
      ].map((toolName, index) => ({
        id: `action-${index}`,
        role: 'tool',
        toolName,
        at,
        input: 'src/example.ts',
        text: 'Output remains visible',
        status: 'completed',
      }));
      hub.sessions[0].events = [
        {
          id: 'event',
          at,
          sourceId: 'parent',
          sourceName: 'Alpha',
          kind: 'tool',
          message: 'Read src/example.ts',
          details: {Tool: 'read', Output: 'File contents'},
        },
      ];
      await publish();
      const initial = await evaluate(() =>
        [...document.querySelectorAll('#conversation > li')].map(row => ({
          open: row.querySelector('details').open,
          label: row.querySelector('.action-label').textContent,
          accent: getComputedStyle(row).borderLeftColor,
        })),
      );
      assert.ok(initial.every(row => row.open));
      assert.equal(new Set(initial.map(row => row.accent)).size, 4);
      assert.deepEqual(
        initial.map(row => row.label),
        ['Read file', 'File change', 'Command', 'Agent'],
      );
      await evaluate(() =>
        document.querySelector('#conversation summary').click(),
      );
      await settle();
      hub.sessions[0].conversation[1].text += '\nMore output';
      await publish();
      await evaluate(() =>
        [...document.querySelectorAll('#parents button')]
          .find(button => button.textContent.includes('Beta'))
          .click(),
      );
      await evaluate(() =>
        [...document.querySelectorAll('#parents button')]
          .find(button => button.textContent.includes('Alpha'))
          .click(),
      );
      await reloadPage();
      assert.deepEqual(
        await evaluate(() =>
          [...document.querySelectorAll('#conversation details')].map(
            details => details.open,
          ),
        ),
        [false, true, true, true],
      );
      await evaluate(() => document.getElementById('tab-feed').click());
      assert.deepEqual(
        await evaluate(() => {
          const event = document.querySelector('#live-feed .feed-event');
          return {
            open: event.querySelector('details').open,
            compact:
              parseFloat(
                getComputedStyle(event.querySelector('.feed-event-message'))
                  .fontSize,
              ) <= 12,
            output: event.textContent.includes('File contents'),
          };
        }),
        {open: true, compact: true, output: true},
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('compact-live-feed');
      await evaluate(() => document.getElementById('tab-conversation').click());
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('conversation-actions');
      hub.sessions[0].conversation.push({
        id: 'final-response',
        role: 'assistant',
        at,
        text: 'The changes are ready.\n\nAssistant replies now have a clear accent, a brighter background, and more space around the text.\n\nThe robot jumps in surprise when you stop it, with a brief red alert across the factory.',
      });
      await publish();
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('assistant-response');
    },
  );

  await run(
    'theme selector is visible and applies and remembers every palette',
    async () => {
      const themes = await evaluate(() =>
        [...document.getElementById('factory-theme').options].map(
          option => option.value,
        ),
      );
      assert.equal(themes.length, 6);
      const backgrounds = new Set();
      for (const id of themes) {
        const result = await evaluate(id => {
          const select = document.getElementById('factory-theme');
          select.value = id;
          select.dispatchEvent(new Event('change', {bubbles: true}));
          return {
            selected: document.documentElement.dataset.theme,
            visible:
              select.getBoundingClientRect().height > 0 &&
              select.getBoundingClientRect().bottom <= innerHeight,
            background: getComputedStyle(document.querySelector('.panel'))
              .backgroundColor,
            stored: window.localStorage.getItem('varisdev.factory.theme'),
          };
        }, id);
        assert.equal(result.selected, id);
        assert.equal(result.stored, id);
        assert.equal(result.visible, true);
        backgrounds.add(result.background);
      }
      assert.equal(backgrounds.size, 6);
      await reloadPage();
      assert.equal(
        await evaluate(() => document.getElementById('factory-theme').value),
        'high-contrast',
      );
      await evaluate(() => {
        const select = document.getElementById('factory-theme');
        select.value = 'solarized-light';
        select.dispatchEvent(new Event('change', {bubbles: true}));
      });
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('light-theme');
    },
  );

  await run(
    'native zoom scales commands and the expanded editor and survives reload',
    async () => {
      await evaluate(() => {
        const zoom = document.getElementById('app-zoom');
        zoom.value = '1.5';
        zoom.dispatchEvent(new Event('change', {bubbles: true}));
      });
      await settle();
      assert.equal(window.webContents.getZoomFactor(), 1.5);
      const mainFont = await evaluate(() =>
        parseFloat(
          getComputedStyle(document.getElementById('parent-prompt')).fontSize,
        ),
      );
      assert.ok(mainFont >= 16);
      await evaluate(() => document.getElementById('open-commands').click());
      await until(
        () => !!document.querySelector('.command-description'),
        'Commands did not load',
      );
      assert.equal(
        await evaluate(() =>
          parseFloat(
            getComputedStyle(document.querySelector('.command-description'))
              .fontSize,
          ),
        ),
        mainFont,
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('commands-zoomed');
      await evaluate(() => {
        document.getElementById('close-commands').click();
        document.getElementById('expand-parent-editor').click();
      });
      const expanded = await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        const bounds = editor.getBoundingClientRect();
        return {
          font: parseFloat(getComputedStyle(editor).fontSize),
          fills: bounds.height > innerHeight * 0.5,
          fits:
            bounds.top >= 0 &&
            bounds.bottom <= innerHeight &&
            bounds.right <= innerWidth,
          open: document
            .getElementById('parent-controls')
            .matches(':popover-open'),
          hints: /Enter sends|Shift\+Enter adds a line/.test(
            document.body.textContent,
          ),
        };
      });
      assert.deepEqual(expanded, {
        font: mainFont,
        fills: true,
        fits: true,
        open: true,
        hints: false,
      });
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('editor-zoomed');
      await evaluate(() => document.getElementById('open-commands').click());
      assert.equal(
        await evaluate(() => {
          const dialog = document.getElementById('commands-dialog');
          return (
            dialog.matches(':modal') &&
            !dialog.inert &&
            document.activeElement === document.getElementById('command-search')
          );
        }),
        true,
      );
      await evaluate(() => {
        document.getElementById('close-commands').click();
        document.getElementById('expand-parent-editor').click();
      });
      await reloadPage();
      assert.equal(window.webContents.getZoomFactor(), 1.5);
      // The View menu changes native page zoom, which the setting must also save.
      window.webContents.setZoomFactor(1.25);
      await until(
        () =>
          Math.abs(
            Number(window.localStorage.getItem('varisdev.factory.zoom')) - 1.25,
          ) < 0.001,
        'Native zoom was not persisted',
      );
      await reloadPage();
      assert.ok(Math.abs(window.webContents.getZoomFactor() - 1.25) < 0.001);
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('workspace-zoomed');
    },
  );

  await run(
    'steering stays visible until delivery or Stop and belongs to its parent',
    async () => {
      assert.equal(
        await evaluate(
          () => document.getElementById('send-prompt').textContent,
        ),
        'Steer',
      );
      for (let index = 0; index < 2; index++) {
        await evaluate(() => {
          const editor = document.getElementById('parent-prompt');
          editor.value = 'Please inspect the tests first.';
          editor.dispatchEvent(new Event('input', {bubbles: true}));
          document.getElementById('prompt-form').requestSubmit();
        });
        await until(
          () =>
            !document.getElementById('send-prompt').disabled &&
            document.getElementById('parent-prompt').value === '',
          'Submission did not finish',
        );
      }
      assert.deepEqual(
        await evaluate(() =>
          [...document.querySelectorAll('#steering-message-list pre')].map(
            item => item.textContent,
          ),
        ),
        ['Please inspect the tests first.', 'Please inspect the tests first.'],
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('steering-messages').hidden,
        ),
        false,
      );
      assert.deepEqual(
        calls.filter(call => call.method === 'prompt'),
        [
          {
            method: 'prompt',
            sessionId: 'alpha',
            request: {prompt: 'Please inspect the tests first.'},
          },
          {
            method: 'prompt',
            sessionId: 'alpha',
            request: {prompt: 'Please inspect the tests first.'},
          },
        ],
      );
      await evaluate(() =>
        [...document.querySelectorAll('#parents button')]
          .find(button => button.textContent.includes('Beta'))
          .click(),
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('steering-messages').hidden,
        ),
        true,
      );
      await evaluate(() =>
        [...document.querySelectorAll('#parents button')]
          .find(button => button.textContent.includes('Alpha'))
          .click(),
      );
      await reloadPage();
      assert.equal(
        await evaluate(
          () => document.querySelectorAll('#steering-message-list li').length,
        ),
        2,
      );
      hub.sessions[0].queue.steering.shift();
      hub.sessions[0].conversation.push({
        id: 'delivered',
        role: 'user',
        text: 'Please inspect the tests first.',
        at,
      });
      await publish();
      assert.equal(
        await evaluate(
          () => document.querySelectorAll('#steering-message-list li').length,
        ),
        1,
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR) await screenshot('steering');
      hub.sessions[0].queue.steering = Array(6).fill('Steering instruction');
      await publish();
      window.webContents.setZoomFactor(1.5);
      await settle();
      assert.equal(
        await evaluate(() => {
          const send = document
            .getElementById('send-prompt')
            .getBoundingClientRect();
          const queue = document.getElementById('steering-messages');
          return (
            send.bottom <= innerHeight &&
            queue.scrollHeight > queue.clientHeight
          );
        }),
        true,
        'Steering messages must stay accessible without hiding Steer at 150% zoom',
      );
      await evaluate(() => document.getElementById('abort-parent').click());
      await until(
        () => document.getElementById('steering-messages').hidden,
        'Stop did not clear pending steering',
      );
      assert.equal(
        await evaluate(
          () =>
            [...document.querySelectorAll('#conversation .user')].filter(item =>
              item.textContent.includes('Please inspect the tests first.'),
            ).length,
        ),
        1,
      );
      hub.sessions[0].session.status = 'idle';
      await publish();
      assert.equal(
        await evaluate(
          () => document.getElementById('send-prompt').textContent,
        ),
        'Send',
      );
    },
  );

  await run(
    'Open folder creates an idle conversation and the first prompt wakes its parent',
    async () => {
      await evaluate(() => document.getElementById('new-session').click());
      await until(
        () => !document.getElementById('new-session').disabled,
        'Cancelled picker remained busy',
      );
      assert.deepEqual(calls, [{method: 'chooseFolder'}]);
      chosenFolder = directory;
      await evaluate(() => document.getElementById('new-session').click());
      await until(
        () =>
          document.getElementById('factory-title').textContent ===
          'Selected folder',
        'Opened folder was not selected',
      );
      assert.deepEqual(calls.slice(1), [
        {method: 'chooseFolder'},
        {method: 'createSession', input: {cwd: directory}},
      ]);
      assert.deepEqual(
        await evaluate(() => ({
          editor: document.getElementById('parent-prompt').value,
          messages: document.querySelectorAll('#conversation > li').length,
          dialog: !!document.getElementById('create-dialog'),
          focused:
            document.activeElement === document.getElementById('parent-prompt'),
        })),
        {editor: '', messages: 0, dialog: false, focused: true},
      );
      const mode = await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = 'Inspect this project';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        document.getElementById('prompt-form').requestSubmit();
        return document.getElementById('factory-canvas').dataset.parentMode;
      });
      assert.equal(mode, 'startled', 'The prompt wakes the parent immediately');
      await until(
        () => document.getElementById('parent-prompt').value === '',
        'The animation must allow the prompt to submit immediately',
      );
      assert.deepEqual(calls.at(-1), {
        method: 'prompt',
        sessionId: 'folder-parent',
        request: {prompt: 'Inspect this project'},
      });
    },
  );
}

main()
  .catch(error => {
    report.fatal = error.stack || String(error);
  })
  .finally(() => {
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    window?.destroy();
    app.exit(report.fatal ? 1 : 0);
  });
