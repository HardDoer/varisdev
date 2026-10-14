/* global document, window, process, __dirname */
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
        return {
          hidden: jolt.hidden,
          sequence: jolt.dataset.sequence,
          path: jolt.querySelector('path').getAttribute('d'),
          animation: getComputedStyle(jolt.querySelector('path')).animationName,
          markers: [...document.querySelectorAll('.agent-work-marker')].map(
            item => ({
              id: item.dataset.agentId,
              hidden: item.hidden,
              animation: getComputedStyle(item, '::before').animationName,
            }),
          ),
        };
      };
      window.update();
    },
    pathToFileURL(
      resolve(__dirname, '../../assets/dashboard/processing-effects.js'),
    ).href,
  );
  const sequence = await evaluate(() => {
    const observations = [];
    window.data.queue.steering = ['Queued correction'];
    window.update();
    observations.push(window.inspect());
    window.data.session.status = 'running';
    window.data.conversation.push({
      id: 'user-1',
      role: 'user',
      text: 'First task',
    });
    window.update();
    window.effects.layout([{id: 'parent', x: 0.3, y: 0.4, visible: true}]);
    observations.push(window.inspect());
    window.update();
    observations.push(window.inspect());
    window.data.conversation.push({
      id: 'reply-1',
      role: 'assistant',
      text: 'Working',
    });
    window.update();
    observations.push(window.inspect());
    window.data.queue.steering = [];
    window.data.conversation.push({
      id: 'user-2',
      role: 'user',
      text: 'Queued correction',
    });
    window.update();
    observations.push(window.inspect());
    const original = window.data;
    window.data = {
      session: {id: 'other', status: 'running'},
      conversation: [{id: 'history', role: 'user', text: 'Historical task'}],
      agents: [],
    };
    window.update();
    observations.push(window.inspect());
    window.data = original;
    window.update();
    observations.push(window.inspect());
    window.data.conversation.push({
      id: 'user-3',
      role: 'user',
      text: 'A new correction',
    });
    window.update({motion: false});
    observations.push(window.inspect());
    return observations;
  });
  assert.equal(
    sequence[0].hidden,
    true,
    'Queued steering must wait for application',
  );
  assert.equal(sequence[1].hidden, false);
  assert.match(sequence[1].path, /L300 400$/);
  assert.equal(sequence[1].animation, 'prompt-data-flow');
  assert.equal(sequence[2].sequence, sequence[1].sequence);
  assert.equal(sequence[3].sequence, sequence[1].sequence);
  assert.notEqual(sequence[4].sequence, sequence[1].sequence);
  assert.equal(sequence[5].hidden, true);
  assert.equal(
    sequence[6].hidden,
    true,
    'Returning to a session must not replay old prompts',
  );
  assert.equal(sequence[7].hidden, false);
  assert.equal(sequence[7].animation, 'none');
  report.cases.push(
    'processing effects follow applied user messages and respect motion settings',
  );
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
    window.data.agents[0].status = 'completed';
    window.update();
    const completed = window.inspect();
    window.effects.dispose();
    return {
      active,
      still,
      stopped,
      completed,
      removed: !document.querySelector('.processing-effects'),
    };
  });
  assert.deepEqual(markers.active.markers, [
    {id: 'working', hidden: false, animation: 'working-beacon'},
  ]);
  assert.deepEqual(markers.still.markers, [
    {id: 'working', hidden: false, animation: 'none'},
  ]);
  assert.deepEqual(markers.stopped.markers, []);
  assert.deepEqual(markers.completed.markers, []);
  assert.equal(markers.removed, true);
  report.cases.push(
    'only working agents have markers, including with Motion off',
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
