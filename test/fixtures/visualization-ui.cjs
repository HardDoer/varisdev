/* global process, __dirname, document, window, setTimeout, requestAnimationFrame, getComputedStyle */
const assert = require('node:assert/strict');
const {writeFile} = require('node:fs/promises');
const {join, resolve} = require('node:path');
const {app, BrowserWindow, ipcMain} = require('electron');
const sharp = require('sharp');
const [directory, reportPath] = process.argv.slice(2);
const report = {cases: []};
const at = '2026-01-01T12:00:00.000Z';
let browser;
let hub;
let raster;
let requests;
let failures;
let delays;
let errors;
let aborts;
let activeImages;
let peakImages;
function message(id, visualizations, text = '') {
  return {id, role: 'assistant', text, at, visualizations};
}
function image(id, name = id) {
  return {
    type: 'image',
    id,
    name,
    path: `/project/${name}.png`,
    width: 1200,
    height: 900,
  };
}
function parent(id) {
  return {
    session: {
      id,
      name: id,
      cwd: directory,
      status: 'running',
      activity: 'Working',
      owned: true,
      controllable: true,
      startedAt: at,
      updatedAt: at,
    },
    agents: [],
    totalAgents: 0,
    events: [],
    changes: [],
    conversation: [],
    queue: {steering: [], followUp: []},
  };
}
app.setPath('userData', join(directory, 'profile'));
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
ipcMain.handle('visualization:state', () => hub);
ipcMain.handle('visualization:abort', () => {
  aborts++;
  return {steering: [], followUp: []};
});
ipcMain.on('visualization:error', (_event, error) => errors.push(error));
ipcMain.handle('visualization:image', async (_event, id, variant) => {
  requests.push({id, variant});
  activeImages++;
  peakImages = Math.max(peakImages, activeImages);
  try {
    if (delays.has(id)) await delays.get(id);
    if (failures.get(id) === 'missing')
      throw new Error('Image reference is unavailable.');
    if (failures.get(id) === 'remote')
      return {
        src: 'https://example.invalid/unsafe.png',
        width: 640,
        height: 480,
        name: id,
      };
    return {
      src: raster,
      width: variant === 'thumbnail' ? 640 : 1200,
      height: variant === 'thumbnail' ? 480 : 900,
      name: id,
    };
  } finally {
    activeImages--;
  }
});
async function evaluate(fn, ...args) {
  const result = await browser.webContents.executeJavaScript(`(async () => {
    try {return {value: await (${fn.toString()})(...${JSON.stringify(args)})};}
    catch (error) {return {error: error.stack};}
  })()`);
  if (result.error) throw new Error(result.error);
  return result.value;
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ...args) {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(fn, ...args)) return;
    await wait(25);
  }
  throw new Error(`Timed out: ${fn.toString()}`);
}
async function settle() {
  await evaluate(
    () =>
      new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}
async function publish() {
  browser.webContents.send('visualization:snapshot', hub);
  await settle();
}
async function loaded(count = 1) {
  await until(
    count =>
      [
        ...document.querySelectorAll('#conversation .visualization-image img'),
      ].filter(img => !img.hidden && img.complete && img.naturalWidth)
        .length === count,
    count,
  );
}
async function check(name, fn) {
  try {
    hub = {
      selectedSessionId: 'alpha',
      launchCwd: directory,
      sessions: [parent('alpha'), parent('beta')],
    };
    requests = [];
    failures = new Map();
    delays = new Map();
    errors = [];
    aborts = 0;
    activeImages = 0;
    peakImages = 0;
    await browser.loadFile(
      resolve(__dirname, '../../assets/dashboard/index.html'),
    );
    await until(
      () => document.querySelectorAll('#parents .parent-card').length === 2,
    );
    await fn();
    assert.deepEqual(errors, [], 'Renderer has no unhandled errors');
    report.cases.push({name});
  } catch (error) {
    report.cases.push({name, error: error.stack});
  }
}
(async () => {
  await app.whenReady();
  raster =
    'data:image/png;base64,' +
    (
      await sharp({
        create: {width: 640, height: 480, channels: 3, background: '#427a68'},
      })
        .png()
        .toBuffer()
    ).toString('base64');
  browser = new BrowserWindow({
    show: false,
    width: 1500,
    height: 1000,
    webPreferences: {
      preload: join(__dirname, 'visualization-ui-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  browser.showInactive();
  browser.webContents.session.webRequest.onBeforeRequest(
    (details, callback) => {
      if (/^https?:/.test(details.url)) {
        errors.push(`Unexpected network: ${details.url}`);
        callback({cancel: true});
      } else callback({});
    },
  );
  await check(
    'Parent image nodes survive streaming snapshots and duplicate references fetch once',
    async () => {
      hub.sessions[0].conversation = [
        message('one', [image('same')]),
        message('two', [image('same')]),
      ];
      await publish();
      await loaded(2);
      await evaluate(() => {
        window.keptImage = document.querySelector('#conversation img');
      });
      for (let i = 0; i < 4; i++) {
        hub.sessions[0].conversation[0].text += 'stream\n';
        await publish();
      }
      assert.equal(
        await evaluate(
          () =>
            window.keptImage === document.querySelector('#conversation img'),
        ),
        true,
      );
      assert.deepEqual(requests, [{id: 'same', variant: 'thumbnail'}]);
    },
  );
  await check(
    'Offscreen metadata stays lazy until the image enters the conversation viewport',
    async () => {
      hub.sessions[0].conversation = [
        message('first', [image('lazy')]),
        message('tail', [], 'line\n'.repeat(200)),
      ];
      await publish();
      await wait(150);
      assert.deepEqual(requests, []);
      await evaluate(() => {
        document.getElementById('panel-conversation').scrollTop = 0;
      });
      await loaded();
      assert.deepEqual(requests, [{id: 'lazy', variant: 'thumbnail'}]);
    },
  );
  await check(
    'Larger view uses full raster and native Escape restores focus while the parent keeps running',
    async () => {
      hub.sessions[0].conversation = [
        message('one', [image('large', 'Design')]),
      ];
      await publish();
      await loaded();
      await evaluate(() => {
        const button = document.querySelector('.visualization-image-open');
        button.focus();
        button.click();
      });
      await until(
        () => !document.querySelector('#conversation-image-dialog img').hidden,
      );
      assert.equal(
        await evaluate(
          () =>
            document.getElementById('conversation-image-metadata').textContent,
        ),
        '1200 × 900 · /project/Design.png',
      );
      assert.equal(
        await evaluate(() => document.activeElement.id),
        'conversation-image-close',
      );
      browser.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Escape'});
      browser.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Escape'});
      await until(
        () => !document.getElementById('conversation-image-dialog').open,
      );
      assert.equal(aborts, 0);
      assert.equal(hub.sessions[0].session.status, 'running');
      assert.equal(
        await evaluate(() => document.activeElement.className),
        'visualization-image-open',
      );
      assert.deepEqual(
        requests.map(item => item.variant),
        ['thumbnail', 'full'],
      );
    },
  );
  await check(
    'A delayed image cannot replace the new parent session image',
    async () => {
      let release;
      delays.set(
        'old',
        new Promise(resolve => {
          release = resolve;
        }),
      );
      hub.sessions[0].conversation = [message('shared', [image('old')])];
      hub.sessions[1].conversation = [message('shared', [image('new')])];
      await publish();
      await until(
        () =>
          document.querySelector('.visualization-image-status')?.textContent ===
          'Loading image…',
      );
      await evaluate(() =>
        [...document.querySelectorAll('#parents .parent-card')]
          .find(item => item.textContent.includes('beta'))
          .click(),
      );
      await loaded();
      release();
      await wait(100);
      assert.equal(
        await evaluate(() => document.querySelector('#conversation img').alt),
        'new',
      );
      assert.equal(
        await evaluate(
          () => document.querySelectorAll('#conversation img').length,
        ),
        1,
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('conversation-image-dialog').open,
        ),
        false,
      );
    },
  );
  await check(
    'Rapid conversation switches bound image IPC and skip stale queued images',
    async () => {
      const releases = [];
      try {
        for (const id of ['old-1', 'old-2'])
          delays.set(id, new Promise(resolve => releases.push(resolve)));
        hub.sessions[0].conversation = [
          message(
            'old',
            ['old-1', 'old-2', 'old-3', 'old-4'].map(id => image(id)),
          ),
        ];
        hub.sessions[1].conversation = [
          message(
            'middle',
            ['middle-1', 'middle-2', 'middle-3'].map(id => image(id)),
          ),
        ];
        await publish();
        await until(
          () =>
            [
              ...document.querySelectorAll('.visualization-image-status'),
            ].filter(item => item.textContent === 'Loading image…').length ===
            4,
        );
        assert.equal(activeImages, 2, 'Only two desktop image calls start');
        await evaluate(() =>
          [...document.querySelectorAll('#parents .parent-card')]
            .find(item => item.textContent.includes('beta'))
            .click(),
        );
        await until(
          () =>
            [
              ...document.querySelectorAll('.visualization-image-status'),
            ].filter(item => item.textContent === 'Loading image…').length ===
            3,
        );
        hub.sessions[0].conversation = [
          message('current', [image('current-1'), image('current-2')]),
        ];
        await publish();
        await evaluate(() =>
          [...document.querySelectorAll('#parents .parent-card')]
            .find(item => item.textContent.includes('alpha'))
            .click(),
        );
        await until(
          () =>
            [
              ...document.querySelectorAll('.visualization-image-status'),
            ].filter(item => item.textContent === 'Loading image…').length ===
            2,
        );
        assert.equal(
          activeImages,
          2,
          'Scope changes retain the occupied IPC slots',
        );
        assert.deepEqual(
          requests.map(item => item.id),
          ['old-1', 'old-2'],
        );
        releases[0]();
        await until(() =>
          [...document.querySelectorAll('#conversation img')].some(
            img => img.alt === 'current-1' && !img.hidden,
          ),
        );
        releases[1]();
        await loaded(2);
        assert.equal(peakImages, 2, 'Image IPC never exceeds the shared limit');
        assert.deepEqual(
          requests.map(item => item.id),
          ['old-1', 'old-2', 'current-1', 'current-2'],
        );
        assert.deepEqual(
          await evaluate(() =>
            [...document.querySelectorAll('#conversation img')].map(
              img => img.alt,
            ),
          ),
          ['current-1', 'current-2'],
        );
      } finally {
        for (const release of releases) release();
      }
    },
  );
  await check(
    'Unavailable references and invalid bridge URLs have per image retry',
    async () => {
      failures.set('retry', 'missing');
      hub.sessions[0].conversation = [message('one', [image('retry')])];
      await publish();
      await until(
        () => !document.querySelector('.visualization-image-retry').hidden,
      );
      assert.match(
        await evaluate(
          () =>
            document.querySelector('.visualization-image-status').textContent,
        ),
        /unavailable/,
      );
      failures.set('retry', 'remote');
      await evaluate(() =>
        document.querySelector('.visualization-image-retry').click(),
      );
      await until(() =>
        document
          .querySelector('.visualization-image-status')
          .textContent.includes('invalid'),
      );
      assert.equal(
        await evaluate(() =>
          document.querySelector('#conversation img').hasAttribute('src'),
        ),
        false,
      );
      failures.delete('retry');
      await evaluate(() =>
        document.querySelector('.visualization-image-retry').click(),
      );
      await loaded();
      assert.equal(requests.length, 3);
      failures.set('retry', 'missing');
      await evaluate(() =>
        document.querySelector('.visualization-image-open').click(),
      );
      await until(
        () => !document.getElementById('conversation-image-retry').hidden,
      );
      failures.delete('retry');
      await evaluate(() =>
        document.getElementById('conversation-image-retry').click(),
      );
      await until(
        () => !document.querySelector('#conversation-image-dialog img').hidden,
      );
      await evaluate(() =>
        document.getElementById('conversation-image-close').click(),
      );
      assert.equal(requests.filter(item => item.variant === 'full').length, 2);
    },
  );
  await check(
    'Plugin Markdown, progress and malformed block diagnostics render safely',
    async () => {
      hub.sessions[0].conversation = [
        message('plugin', [
          {
            type: 'markdown',
            text: '# Plugin output\n\n**Safe** <img src=x onerror="window.hacked=true">\n\n[link](javascript:window.hacked=true)',
          },
          {type: 'progress', value: 140, total: 100, label: 'Files checked'},
          {type: 'progress', value: 4, label: 'Discovering files'},
        ]),
      ];
      hub.sessions[0].conversation[0].visualizationErrors = [
        'Unsupported visualization block: <script>alert(1)</script>',
      ];
      await publish();
      const state = await evaluate(() => ({
        heading: document.querySelector('.visualization-markdown h1')
          .textContent,
        unsafe: !!document.querySelector(
          '.conversation-visualizations img, .conversation-visualizations script, .conversation-visualizations a',
        ),
        raw: document.querySelector('.visualization-markdown').textContent,
        bounded: document.querySelector('progress[aria-label="Files checked"]')
          .value,
        indeterminate: !document
          .querySelector('progress[aria-label="Discovering files"]')
          .hasAttribute('value'),
        warning: document.querySelector('.visualization-errors').textContent,
        hacked: !!window.hacked,
      }));
      assert.equal(state.heading, 'Plugin output');
      assert.equal(state.unsafe, false);
      assert.equal(state.hacked, false);
      assert.match(state.raw, /<img src=x/);
      assert.equal(state.bounded, 100);
      assert.equal(state.indeterminate, true);
      assert.match(state.warning, /Unsupported visualization block/);
    },
  );
  await check(
    'Agent tool results use the same image and plugin blocks without changing header positions',
    async () => {
      hub.sessions[0].conversation = [message('parent', [image('parent')])];
      hub.sessions[0].agents = [
        {
          id: 'worker',
          name: 'Image agent',
          cwd: directory,
          task: 'Render images',
          status: 'running',
          activity: 'Working',
          createdAt: at,
          startedAt: at,
          conversation: [
            {
              ...message('tool', [
                image('agent'),
                {type: 'markdown', text: '## Agent visual'},
                {type: 'progress', value: 1, total: 2, label: 'Agent work'},
              ]),
              role: 'tool',
              toolName: 'plugin',
              status: 'completed',
              input: '{}',
            },
          ],
        },
      ];
      hub.sessions[0].totalAgents = 1;
      await publish();
      await loaded();
      const before = await evaluate(() => {
        const box = document
          .querySelector('.inspector-heading')
          .getBoundingClientRect();
        return {x: box.x, y: box.y, height: box.height};
      });
      await evaluate(() => {
        document.querySelector('#active-workers button').click();
        document.querySelector('#conversation details').open = true;
      });
      await loaded();
      assert.equal(
        await evaluate(() => document.querySelector('#conversation img').alt),
        'agent',
      );
      assert.equal(
        await evaluate(
          () =>
            document.querySelector('.visualization-markdown h2').textContent,
        ),
        'Agent visual',
      );
      assert.equal(
        await evaluate(
          () => document.querySelector('#conversation details').open,
        ),
        true,
      );
      const after = await evaluate(() => {
        const box = document
          .querySelector('.inspector-heading')
          .getBoundingClientRect();
        return {x: box.x, y: box.y, height: box.height};
      });
      assert.deepEqual(after, before);
      assert.equal(
        await evaluate(() =>
          [
            ...document.querySelectorAll(
              '.visualization-image,.visualization-markdown',
            ),
          ].some(item =>
            ['auto', 'scroll'].includes(getComputedStyle(item).overflowY),
          ),
        ),
        false,
      );
      assert.deepEqual(
        requests.map(item => item.id),
        ['parent', 'agent'],
      );
    },
  );
  await check(
    'Delayed image expansion follows the bottom and preserves a reader above',
    async () => {
      let release;
      delays.set(
        'following',
        new Promise(resolve => {
          release = resolve;
        }),
      );
      hub.sessions[0].conversation = [
        message('lead', [], 'line\n'.repeat(120)),
        message('image', [image('following')]),
      ];
      await publish();
      await wait(50);
      release();
      await loaded();
      await settle();
      assert.equal(
        await evaluate(() => {
          const panel = document.getElementById('panel-conversation');
          return panel.scrollHeight - panel.scrollTop - panel.clientHeight < 5;
        }),
        true,
      );
      let releaseSecond;
      delays.set(
        'reading',
        new Promise(resolve => {
          releaseSecond = resolve;
        }),
      );
      hub.sessions[0].conversation.push(message('second', [image('reading')]));
      await publish();
      await wait(50);
      await evaluate(() => {
        const panel = document.getElementById('panel-conversation');
        panel.scrollTop -= 160;
      });
      await settle();
      const top = await evaluate(
        () => document.getElementById('panel-conversation').scrollTop,
      );
      releaseSecond();
      await loaded(2);
      await settle();
      const after = await evaluate(
        () => document.getElementById('panel-conversation').scrollTop,
      );
      assert.ok(
        Math.abs(after - top) < 4,
        `Reader moved from ${top} to ${after}`,
      );
    },
  );
  await check(
    'Removed image entries release their nodes and the raster cache evicts old references',
    async () => {
      for (let i = 0; i < 26; i++) {
        hub.sessions[0].conversation = [
          message('replace', [image(`cache-${i}`)]),
        ];
        await publish();
        await loaded();
      }
      const count = requests.length;
      hub.sessions[0].conversation = [message('replace', [image('cache-25')])];
      await publish();
      await loaded();
      assert.equal(requests.length, count);
      hub.sessions[0].conversation = [message('replace', [image('cache-0')])];
      await publish();
      await loaded();
      assert.equal(requests.length, count + 1);
      hub.sessions[0].conversation = [];
      await publish();
      assert.equal(
        await evaluate(
          () => document.querySelectorAll('#conversation img').length,
        ),
        0,
      );
    },
  );
  browser.destroy();
})()
  .catch(error => {
    report.fatal = error.stack;
  })
  .finally(async () => {
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    app.exit(report.fatal || report.cases.some(item => item.error) ? 1 : 0);
  });
