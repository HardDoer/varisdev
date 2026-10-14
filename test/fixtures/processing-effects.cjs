/* global document, window, process, __dirname, setTimeout, getComputedStyle */
const assert = require('node:assert/strict');
const {writeFileSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {pathToFileURL} = require('node:url');
const {app, BrowserWindow} = require('electron');
const [directory, reportPath] = process.argv.slice(2);
const report = {cases: []};
let browser;
app.setPath('userData', join(directory, 'profile'));
app.setPath('sessionData', join(directory, 'session'));
const evaluate = (fn, arg) =>
  browser.webContents.executeJavaScript(
    `(${fn.toString()})(${JSON.stringify(arg)})`,
  );
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  await app.whenReady();
  browser = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  await browser.loadFile(join(__dirname, 'processing-effects.html'));
  await evaluate(
    async url => {
      const {createProcessingEffects} = await import(url);
      window.effects = createProcessingEffects(
        document.getElementById('scene'),
      );
      window.data = {
        session: {id: 'parent', status: 'idle'},
        conversation: [],
        agents: [],
        queue: {steering: [], followUp: []},
      };
      window.update = options => window.effects.update(window.data, options);
      window.inspect = () => {
        const jolt = document.querySelector('.prompt-jolt');
        const head = jolt.querySelector('circle');
        const scene = document.getElementById('scene').getBoundingClientRect();
        const composer = document
          .getElementById('parent-prompt')
          .getBoundingClientRect();
        return {
          hidden: jolt.hidden,
          sequence: jolt.dataset.sequence,
          path: jolt.querySelector('path').getAttribute('d'),
          head: {
            x: Number(head.getAttribute('cx')),
            y: Number(head.getAttribute('cy')),
            opacity: Number(head.style.opacity),
          },
          impact: {
            x: parseFloat(jolt.querySelector('span').style.left),
            y: parseFloat(jolt.querySelector('span').style.top),
            opacity: Number(
              getComputedStyle(jolt.querySelector('span')).opacity,
            ),
          },
          arrived: jolt.classList.contains('has-arrived'),
          svgDisplay: getComputedStyle(jolt.querySelector('svg')).display,
          position: getComputedStyle(jolt).position,
          outsideScene: !document.getElementById('scene').contains(jolt),
          scene: {
            left: scene.left,
            top: scene.top,
            width: scene.width,
            height: scene.height,
          },
          composer: {
            left: composer.left,
            top: composer.top,
            width: composer.width,
          },
          markers: [...document.querySelectorAll('.agent-work-marker')].map(
            item => ({
              id: item.dataset.agentId,
              hidden: item.hidden,
              animation: getComputedStyle(item, '::before').animationName,
            }),
          ),
        };
      };
      window.apply = text => {
        window.data.session.status = 'running';
        window.data.conversation.push({
          id: `user-${window.data.conversation.length}`,
          role: 'user',
          text,
        });
        window.update();
      };
      window.update();
      window.effects.layout([{id: 'parent', x: 0.3, y: 0.4, visible: true}]);
    },
    pathToFileURL(
      resolve(__dirname, '../../assets/dashboard/processing-effects.js'),
    ).href,
  );

  const start = await evaluate(() => {
    window.apply('First task');
    return window.inspect();
  });
  assert.equal(start.hidden, false);
  assert.equal(start.outsideScene, true);
  assert.equal(start.position, 'fixed');
  assert.equal(start.head.x, start.composer.left + start.composer.width / 2);
  assert.equal(start.head.y, start.composer.top + 18);
  assert.ok(
    start.head.x > start.scene.left + start.scene.width,
    'Flight must originate outside scene in the actual composer',
  );
  assert.equal(start.impact.x, start.scene.left + start.scene.width * 0.3);
  assert.equal(start.impact.y, start.scene.top + start.scene.height * 0.4);
  assert.equal(start.impact.opacity, 0);
  await wait(300);
  const middle = await evaluate(() => window.inspect());
  assert.ok(middle.head.x < start.head.x && middle.head.x > start.impact.x);
  assert.ok(middle.head.y < start.head.y && middle.head.y > start.impact.y);
  assert.equal(middle.arrived, false);
  assert.notEqual(middle.path, start.path);
  await wait(600);
  const arrival = await evaluate(() => window.inspect());
  assert.equal(arrival.arrived, true);
  assert.equal(arrival.head.x, arrival.impact.x);
  assert.equal(arrival.head.y, arrival.impact.y);
  assert.equal(arrival.head.opacity, 0);
  assert.ok(arrival.impact.opacity > 0);
  await wait(420);
  assert.equal(await evaluate(() => window.inspect().hidden), true);
  report.cases.push(
    'viewport flight starts at composer, travels with a short tail and pulses on arrival',
  );

  const expanded = await evaluate(() => {
    document.getElementById('prompt-form').style.cssText =
      'position:absolute;left:420px;top:80px;width:300px';
    document.getElementById('parent-prompt').style.width = '300px';
    window.apply('Expanded editor task');
    return window.inspect();
  });
  assert.equal(
    expanded.head.x,
    expanded.composer.left + expanded.composer.width / 2,
  );
  assert.equal(expanded.head.y, expanded.composer.top + 18);
  await wait(180);
  const moved = await evaluate(() => {
    document.getElementById('scene').style.left = '70px';
    window.effects.layout([{id: 'parent', x: 0.7, y: 0.2, visible: true}]);
    return new Promise(resolve =>
      window.requestAnimationFrame(() => resolve(window.inspect())),
    );
  });
  assert.equal(moved.impact.x, moved.scene.left + moved.scene.width * 0.7);
  assert.equal(moved.impact.y, moved.scene.top + moved.scene.height * 0.2);
  await browser.webContents.setZoomFactor(1.1);
  await wait(60);
  const zoomed = await evaluate(() => window.inspect());
  assert.equal(zoomed.impact.x, zoomed.scene.left + zoomed.scene.width * 0.7);
  await browser.webContents.setZoomFactor(1);
  const fallback = await evaluate(() => {
    window.effects.layout([]);
    return new Promise(resolve =>
      window.requestAnimationFrame(() => {
        const box = document
          .querySelector('.fallback-station')
          .getBoundingClientRect();
        resolve({
          effect: window.inspect(),
          x: box.left + box.width / 2,
          y: box.top + box.height * 0.35,
        });
      }),
    );
  });
  assert.equal(fallback.effect.impact.x, fallback.x);
  assert.equal(fallback.effect.impact.y, fallback.y);
  report.cases.push(
    'expanded composer, moving projected robot, zoom and SVG fallback use live bounds',
  );

  const queued = await evaluate(() => {
    window.data.queue.steering = ['Queued correction'];
    window.update();
    const before = window.inspect().sequence;
    window.update();
    const waiting = window.inspect().sequence;
    document.getElementById('prompt-form').hidden = true;
    window.data.queue.steering = [];
    window.apply('Queued correction');
    const applied = window.inspect();
    window.update();
    const repeated = window.inspect();
    window.apply('Hidden unrelated prompt');
    return {before, waiting, applied, repeated, hiddenPrompt: window.inspect()};
  });
  assert.equal(queued.waiting, queued.before);
  assert.notEqual(queued.applied.sequence, queued.before);
  assert.equal(queued.applied.hidden, false);
  assert.equal(queued.repeated.sequence, queued.applied.sequence);
  assert.equal(queued.hiddenPrompt.sequence, queued.applied.sequence);
  const switching = await evaluate(() => {
    const original = window.data;
    window.data = {
      session: {id: 'other', status: 'running'},
      conversation: [{id: 'history', role: 'user', text: 'Historical task'}],
      agents: [],
    };
    window.update();
    const other = window.inspect();
    original.conversation.push({
      id: 'background-new',
      role: 'user',
      text: 'Arrived while elsewhere',
    });
    window.data = original;
    window.update();
    return {other, returned: window.inspect()};
  });
  assert.equal(switching.other.hidden, true);
  assert.equal(switching.returned.hidden, true);
  report.cases.push(
    'queued steering flies only when applied, hidden unrelated prompts and history switches never replay',
  );

  const still = await evaluate(() => {
    document.getElementById('prompt-form').hidden = false;
    window.data.conversation.push({
      id: 'still',
      role: 'user',
      text: 'Still correction',
    });
    window.update({motion: false});
    return window.inspect();
  });
  assert.equal(still.hidden, false);
  assert.equal(still.svgDisplay, 'none');
  assert.equal(still.impact.opacity, 0.7);
  assert.equal(still.arrived, true);
  await wait(750);
  assert.equal(await evaluate(() => window.inspect().hidden), true);
  await browser.webContents.debugger.attach('1.3');
  await browser.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{name: 'prefers-reduced-motion', value: 'reduce'}],
  });
  await wait(50);
  const reduced = await evaluate(() => {
    window.apply('Reduced motion correction');
    return window.inspect();
  });
  assert.equal(reduced.svgDisplay, 'none');
  assert.equal(reduced.impact.opacity, 0.7);
  browser.webContents.debugger.detach();
  report.cases.push(
    'Motion off and system reduced motion show only a static robot pulse',
  );

  if (process.env.DESKTOP_UI_SCREENSHOT_DIR) {
    await evaluate(() => window.apply('Screenshot flight'));
    await wait(300);
    const image = await browser.webContents.capturePage();
    writeFileSync(
      join(process.env.DESKTOP_UI_SCREENSHOT_DIR, 'prompt-flight.png'),
      image.toPNG(),
    );
  }
  const markers = await evaluate(() => {
    window.data.agents = [
      {id: 'working', name: 'Builder', status: 'running'},
      {id: 'queued', name: 'Waiting', status: 'queued'},
      {id: 'finished', name: 'Done', status: 'completed'},
    ];
    window.update();
    window.effects.layout(
      window.data.agents.map((agent, index) => ({
        id: agent.id,
        x: 0.2 + index * 0.2,
        y: 0.3,
        visible: true,
      })),
    );
    const active = window.inspect();
    window.update({motion: false});
    const still = window.inspect();
    window.update({stopping: true});
    const stopped = window.inspect();
    window.effects.dispose();
    return {
      active,
      still,
      stopped,
      removed: !document.querySelector('.processing-effects, .prompt-jolt'),
    };
  });
  assert.equal(markers.active.markers.length, 1);
  assert.equal(markers.active.markers[0].id, 'working');
  assert.equal(markers.active.markers[0].hidden, false);
  assert.deepEqual(markers.still.markers, [
    {id: 'working', hidden: false, animation: 'none'},
  ]);
  assert.deepEqual(markers.stopped.markers, markers.active.markers);
  assert.equal(markers.removed, true);
  report.cases.push(
    'working agent markers remain in the scene and dispose removes both layers',
  );
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
