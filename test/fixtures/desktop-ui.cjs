/* global process, __dirname, document, requestAnimationFrame, setTimeout,
   NodeFilter, Node, Event, innerWidth, innerHeight, getComputedStyle */
const assert = require('node:assert/strict');
const {mkdirSync, writeFileSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {app, BrowserWindow, ipcMain} = require('electron');

const [directory, reportPath] = process.argv.slice(2);
const report = {cases: []};
const at = '2026-01-01T12:00:00.000Z';
const longPrompt =
  'Review every listed file and explain each change.\n' +
  'Keep the complete queued instruction available for reading. '.repeat(12) +
  '\nFINAL QUEUE LINE: preserve this exact ending.';
let hub;
let window;
let calls = [];
let rendererErrors = [];
let resources;
let editorSubmission;

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

function session(id, name) {
  return {
    session: {
      id,
      name,
      cwd: directory,
      status: 'running',
      activity: 'Running bash: checking the project',
      startedAt: at,
      updatedAt: at,
      owned: true,
      controllable: true,
      pendingPrompts: 1,
      queuedPrompts: [
        {
          id: `${id}-queued`,
          text: id === 'alpha' ? longPrompt : 'Beta queue only',
          queuedAt: at,
        },
      ],
    },
    agents: [],
    totalAgents: 0,
    events: [],
    changes: [],
    conversationTruncated: false,
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
  resources = new Map([
    ['alpha', features()],
    ['beta', features()],
  ]);
}

ipcMain.handle('fixture:state', () => hub);
ipcMain.on('fixture:error', (_event, error) => rendererErrors.push(error));
ipcMain.handle('fixture:remove', (_event, sessionId, promptId) => {
  calls.push({method: 'removeQueuedPrompt', sessionId, promptId});
  const target = hub.sessions.find(
    item => item.session.id === sessionId,
  ).session;
  target.queuedPrompts = target.queuedPrompts.filter(
    item => item.id !== promptId,
  );
  target.pendingPrompts = target.queuedPrompts.length;
  window.webContents.send('fixture:snapshot', hub);
});
for (const method of ['prompt', 'abort', 'workspace']) {
  ipcMain.handle(`fixture:${method}`, (_event, sessionId, request) => {
    calls.push({method, sessionId, request});
    if (method === 'abort') {
      const target = hub.sessions.find(
        item => item.session.id === sessionId,
      ).session;
      target.queuedPrompts = [];
      target.pendingPrompts = 0;
      window.webContents.send('fixture:snapshot', hub);
    }
    return method === 'workspace'
      ? {cwd: directory, files: [], diff: '', truncated: false}
      : undefined;
  });
}

ipcMain.handle('fixture:features', (_event, sessionId) => {
  assert.ok(resources.has(sessionId), `Unknown feature session ${sessionId}`);
  return resources.get(sessionId);
});
ipcMain.handle('fixture:configure', (_event, sessionId, request) => {
  calls.push({method: 'configureSession', sessionId, request});
  const resource = resources.get(sessionId);
  resource.model = {provider: request.provider, id: request.modelId};
  resource.thinkingLevel = request.thinkingLevel;
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

async function publish() {
  window.webContents.send('fixture:snapshot', hub);
  await settle();
}

async function run(name, callback, width = 1600, height = 1000) {
  try {
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
  const output = resolve(process.env.DESKTOP_UI_SCREENSHOT_DIR);
  mkdirSync(output, {recursive: true});
  const image = await window.webContents.capturePage();
  writeFileSync(join(output, `${name}.png`), image.toPNG());
}

async function main() {
  await app.whenReady();
  window = new BrowserWindow({
    show: false,
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
        pendingPrompts: 0,
        queuedPrompts: [],
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

  await run(
    'queue displays complete text and removes the selected prompt by ID',
    async () => {
      hub.sessions[0].session.queuedPrompts.push({
        id: 'alpha-second',
        text: 'Keep this next prompt',
        queuedAt: at,
      });
      hub.sessions[0].session.pendingPrompts = 2;
      await publish();
      const queue = await evaluate(() => {
        const section = document.getElementById('queued-prompts');
        const rows = [...document.querySelectorAll('#prompt-queue > li')];
        return {
          visible: !section.hidden && section.getClientRects().length > 0,
          texts: rows.map(item => item.textContent),
          buttons: rows.map(item =>
            [...item.querySelectorAll('button')].some(button =>
              /remove/i.test(button.textContent),
            ),
          ),
        };
      });
      assert.equal(queue.visible, true);
      assert.equal(queue.texts.length, 2);
      assert.ok(
        queue.texts[0].includes(longPrompt),
        'Queue must contain the entire multiline prompt',
      );
      assert.deepEqual(queue.buttons, [true, true]);
      assert.equal(
        await evaluate(() => {
          const queue = document.getElementById('prompt-queue');
          const content = queue.querySelector('.queued-prompt-text');
          queue.scrollTop = queue.scrollHeight;
          const range = document.createRange();
          range.setStart(
            content.firstChild,
            content.textContent.indexOf('FINAL QUEUE LINE'),
          );
          range.setEnd(content.firstChild, content.textContent.length);
          const ending = range.getBoundingClientRect();
          const visible = queue.getBoundingClientRect();
          return ending.top >= visible.top && ending.bottom <= visible.bottom;
        }),
        true,
        'The final line must be readable by scrolling the queue',
      );
      await evaluate(() => {
        const row = document.querySelectorAll('#prompt-queue > li')[1];
        row.scrollIntoView({block: 'nearest'});
        [...row.querySelectorAll('button')]
          .find(item => /remove/i.test(item.textContent))
          .click();
      });
      await until(
        () => document.querySelectorAll('#prompt-queue > li').length === 1,
        'Removed prompt remained in queue',
      );
      assert.deepEqual(calls, [
        {
          method: 'removeQueuedPrompt',
          sessionId: 'alpha',
          promptId: 'alpha-second',
        },
      ]);
      assert.ok(
        (
          await evaluate(
            () => document.getElementById('prompt-queue').textContent,
          )
        ).includes(longPrompt),
        'Removing the second prompt must retain the first prompt',
      );
      await evaluate(() =>
        document.querySelector('#prompt-queue > li button').click(),
      );
      await until(
        () => document.getElementById('queued-prompts').hidden,
        'Empty queue must disappear',
      );
      assert.deepEqual(calls[1], {
        method: 'removeQueuedPrompt',
        sessionId: 'alpha',
        promptId: 'alpha-queued',
      });
      assert.equal(hub.sessions[0].session.pendingPrompts, 0);
      assert.equal(hub.sessions[1].session.queuedPrompts.length, 1);
    },
  );

  await run(
    'switching parents restores each draft, cursor and queue',
    async () => {
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
      const beta = await evaluate(() => ({
        draft: document.getElementById('parent-prompt').value,
        queue: document.getElementById('prompt-queue').textContent,
      }));
      assert.equal(beta.draft, '');
      assert.match(beta.queue, /Beta queue only/);
      assert.ok(!beta.queue.includes(longPrompt));
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
        return {
          draft: editor.value,
          start: editor.selectionStart,
          end: editor.selectionEnd,
          queue: document.getElementById('prompt-queue').textContent,
        };
      });
      assert.equal(alpha.draft, 'Alpha unsent\nsecond line');
      assert.equal(alpha.start, 3);
      assert.equal(alpha.end, 9);
      assert.ok(alpha.queue.includes(longPrompt));
      assert.ok(!alpha.queue.includes('Beta queue only'));
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
    },
  );

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
            queueVisible:
              !document.getElementById('queued-prompts').hidden &&
              document.getElementById('queued-prompts').getClientRects()
                .length > 0,
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
        assert.equal(geometry.queueVisible, true);
        assert.ok(geometry.panel.height >= 90, JSON.stringify(geometry));
        assert.ok(
          geometry.composer.top >= geometry.panel.bottom - 1,
          JSON.stringify(geometry),
        );
        assert.ok(geometry.editor.height >= 40, JSON.stringify(geometry));
        assert.ok(geometry.editor.height <= 240, JSON.stringify(geometry));
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
          const topbar = document.querySelector('.topbar');
          const before = topbar.getBoundingClientRect().top;
          const column = document.querySelector('.factory-column');
          const conversation = document.getElementById('panel-conversation');
          column.scrollTop = 200;
          conversation.scrollTop = 120;
          conversation.dispatchEvent(new Event('scroll'));
          return {
            before,
            after: topbar.getBoundingClientRect().top,
            factory: column.scrollTop,
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
        assert.ok(
          scroll.factory > 0 && scroll.conversation > 0,
          JSON.stringify(scroll),
        );
        assert.equal(
          scroll.after,
          scroll.before,
          'Topbar must remain fixed while both columns scroll',
        );
        assert.equal(scroll.body, 0);
        assert.equal(scroll.document, 0);
        assert.equal(scroll.window, 0);
        assert.equal(scroll.bodyOverflow, 'hidden');
        assert.equal(scroll.htmlOverflow, 'hidden');
        assert.ok(scroll.composerBottom <= height, JSON.stringify(scroll));
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
      hub.sessions[0].session.queuedPrompts = [];
      hub.sessions[0].session.pendingPrompts = 0;
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
          burst: !document.getElementById('stop-burst').hidden,
          effect: document
            .getElementById('stop-burst')
            .classList.contains('braking'),
          queueHidden: document.getElementById('queued-prompts').hidden,
        })),
        {
          processing: false,
          stopping: true,
          bubbleHidden: true,
          status: 'Stopping',
          paused: true,
          indicator: 'none',
          activityIndicator: 'none',
          burst: true,
          effect: true,
          queueHidden: true,
        },
      );
      assert.equal(
        hub.sessions[1].session.pendingPrompts,
        1,
        'Aborting Alpha must preserve Beta’s ordered queue',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('stopping-1600x1000');
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
        modal: document.getElementById('commands-dialog').matches(':modal'),
        text: document.getElementById('command-catalog').textContent,
        tools: document.getElementById('available-tools').textContent,
      }));
      assert.equal(catalog.modal, true);
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
        false,
      );
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
    'model and thinking settings apply the selected provider and values',
    async () => {
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
      hub.sessions[0].session.status = 'running';
      await publish();
      assert.equal(
        await evaluate(
          () => document.getElementById('apply-session-settings').disabled,
        ),
        true,
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
          pendingMessages: 0,
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
