/* global window, document, MouseEvent, Event, URL, ResizeObserver, process, __dirname, Buffer */
const assert = require('node:assert/strict');
const {mkdirSync, writeFileSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {pathToFileURL} = require('node:url');
const {app, BrowserWindow} = require('electron');

const [directory, reportPath] = process.argv.slice(2);
const report = {cases: [], screenshots: []};
let browser;
app.setPath('userData', join(directory, 'profile'));
app.setPath('sessionData', join(directory, 'session'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
function evaluate(fn, argument) {
  return browser.webContents.executeJavaScript(
    `(${fn.toString()})(${JSON.stringify(argument)})`,
  );
}
async function run(name, fn) {
  try {
    await fn();
    report.cases.push({name});
  } catch (error) {
    report.cases.push({name, error: error.stack || String(error)});
  }
}
async function setupRenderer(moduleUrl) {
  let clock = 1000;
  let sequence = 0;
  const frames = new Map();
  window.requestAnimationFrame = callback => {
    frames.set(++sequence, callback);
    return sequence;
  };
  window.cancelAnimationFrame = id => frames.delete(id);
  const resizers = [];
  const NativeResizeObserver = ResizeObserver;
  window.ResizeObserver = class extends NativeResizeObserver {
    constructor(callback) {
      super(callback);
      this.closed = false;
      resizers.push(this);
    }
    disconnect() {
      this.closed = true;
      super.disconnect();
    }
  };
  const {createThemeScene} = await import(moduleUrl);
  const {THEMES} = await import(new URL('./themes.js', moduleUrl));
  const {createParentMotion} = await import(
    new URL('./parent-motion.js', moduleUrl)
  );
  const palette = THEMES.find(theme => theme.id === 'year1998').scenePalette;
  let host;
  let layouts = [];
  let selections = [];
  let errors = [];
  let availability = [];
  let previousCanvas;
  const snapshot = (status = 'idle', agentStatus = 'running') => ({
    session: {id: 'city-session', name: 'City session', status},
    agents: [
      {
        id: 'builder',
        name: 'Builder',
        agentMode: 'subagent',
        status: agentStatus,
      },
      {
        id: 'reviewer',
        name: 'Reviewer',
        agentMode: 'subagent',
        status: 'queued',
      },
    ],
  });
  function reset() {
    host?.dispose();
    document.querySelector('#stage').innerHTML =
      '<canvas id="scene" class="theme-scene" aria-label="Session scene"></canvas><div id="fallback"></div>';
    layouts = [];
    selections = [];
    errors = [];
    availability = [];
    window.pluginCalls = [];
    window.pluginOptions = [];
    previousCanvas = null;
    host = createThemeScene(document.querySelector('canvas'), {
      fallbackContainer: document.querySelector('#fallback'),
      onSelect: id => selections.push(id),
      onLayout: layout => layouts.push(layout),
      onAvailability: value => availability.push(value),
      onError: value => errors.push(value),
    });
  }
  function advance(count = 1) {
    for (let i = 0; i < count; i++) {
      clock += 50;
      const queued = [...frames.values()];
      frames.clear();
      for (const callback of queued) callback(clock);
    }
  }
  function inspect() {
    const canvas = document.querySelector('canvas');
    return {
      renderer: canvas.dataset.renderer,
      data: {...canvas.dataset},
      available: host.hasCanvas(),
      hidden: canvas.hidden,
      layout: layouts.at(-1),
      selections: [...selections],
      errors: [...errors],
      availability: [...availability],
      pending: frames.size,
      activeResizers: resizers.filter(observer => !observer.closed).length,
      calls: window.pluginCalls,
      canvasChanged: previousCanvas
        ? canvas !== previousCanvas && !previousCanvas.isConnected
        : undefined,
      attributes: [
        canvas.id,
        canvas.className,
        canvas.getAttribute('aria-label'),
      ],
    };
  }
  function moduleSource({
    tag = 'valid',
    throws = '',
    delay = '',
    omit = '',
    exported = 1,
  } = {}) {
    const methods = [
      'update',
      'setPalette',
      'setMotion',
      'dispose',
      'updateHub',
      'prompt',
      'cancelPrompt',
      'startle',
      'clearStartle',
      'caneTargets',
      'hitWithCane',
    ];
    return `${delay ? `await window.${delay};` : ''}
      export const apiVersion = ${exported};
      export function createScene(canvas, options) {
        window.pluginOptions.push(options);
        window.pluginCalls.push(['create', ${JSON.stringify(tag)}, options.apiVersion, Object.keys(options.helpers)]);
        return {${methods
          .filter(name => name !== omit)
          .map(
            name => `${name}(...args) {
          window.pluginCalls.push([${JSON.stringify(name)}, ...args]);
          ${name === throws ? `throw new Error('${tag} ${name} failed');` : ''}
          ${name === 'caneTargets' ? "return [{id:'builder',x:0.5,y:0.5}];" : ''}
          ${name === 'hitWithCane' ? 'return true;' : ''}
        }`,
          )
          .join(',')}};
      }`;
  }
  function plugin(options) {
    const source = moduleSource(options);
    return {
      scene: {
        moduleUrl:
          'data:text/javascript;charset=utf-8,' + encodeURIComponent(source),
        apiVersion: 1,
      },
    };
  }
  function pixelHash() {
    const canvas = document.querySelector('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Year1998 must use Canvas2D');
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (let i = 0; i < pixels.length; i += 4) {
      hash = Math.imul(hash ^ pixels[i], 16777619);
      hash = Math.imul(hash ^ pixels[i + 1], 16777619);
      hash = Math.imul(hash ^ pixels[i + 2], 16777619);
    }
    return hash >>> 0;
  }
  window.fixture = {
    reset,
    advance,
    inspect,
    snapshot,
    plugin,
    pixelHash,
    createParentMotion,
    palette,
    host: () => host,
    rememberCanvas: () => {
      previousCanvas = document.querySelector('canvas');
    },
    theme: entry => host.setTheme(entry, palette),
    async year(status = 'idle') {
      reset();
      host.update(snapshot(status), 'builder');
      host.setMotion(false);
      await host.setTheme({scene: 'year1998'}, palette);
      return inspect();
    },
    click(id) {
      const anchor = layouts.at(-1).find(item => item.id === id);
      const canvas = document.querySelector('canvas');
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          clientX: rect.x + anchor.x * rect.width,
          clientY: rect.y + anchor.y * rect.height,
        }),
      );
      return inspect();
    },
    dispose: () => host.dispose(),
  };
}
async function main() {
  await app.whenReady();
  browser = new BrowserWindow({
    show: false,
    width: 960,
    height: 600,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  await browser.loadFile(join(__dirname, 'theme-scene.html'));
  await evaluate(
    setupRenderer,
    pathToFileURL(resolve(__dirname, '../../assets/dashboard/theme-scene.js'))
      .href,
  );

  await run(
    'switching factory, Year1998 and custom canvases preserves session state',
    async () => {
      const state = await evaluate(async () => {
        const f = window.fixture;
        f.reset();
        f.host().updateHub({
          sessions: [{id: 'city-session', status: 'idle'}],
          selectedSessionId: 'city-session',
        });
        f.host().update(f.snapshot(), 'builder');
        f.host().setMotion(false);
        const renderers = [];
        for (const entry of [
          {scene: 'factory'},
          {scene: 'year1998'},
          f.plugin(),
          {scene: 'factory'},
          f.plugin(),
        ]) {
          f.rememberCanvas();
          await f.theme(entry);
          renderers.push(f.inspect());
        }
        return renderers;
      });
      assert.deepEqual(
        state.map(item => item.renderer),
        ['factory', 'year1998', 'plugin', 'factory', 'plugin'],
      );
      for (const item of state) {
        assert.equal(item.available, true);
        assert.equal(item.canvasChanged, true);
        assert.deepEqual(item.attributes.slice(0, 2), ['scene', 'theme-scene']);
        assert.ok(
          item.attributes[2],
          'Renderer keeps an accessible canvas label',
        );
        assert.deepEqual(item.errors.filter(Boolean), []);
      }
      const calls = state.at(-1).calls;
      const creates = calls.filter(call => call[0] === 'create');
      assert.equal(creates.length, 2);
      assert.equal(creates[0][2], 1);
      assert.ok(creates[0][3].includes('createParentMotion'));
      assert.equal(calls.filter(call => call[0] === 'update').length, 2);
      assert.deepEqual(calls.find(call => call[0] === 'update').slice(1), [
        {
          session: {id: 'city-session', name: 'City session', status: 'idle'},
          agents: [
            {
              id: 'builder',
              name: 'Builder',
              agentMode: 'subagent',
              status: 'running',
            },
            {
              id: 'reviewer',
              name: 'Reviewer',
              agentMode: 'subagent',
              status: 'queued',
            },
          ],
        },
        'builder',
      ]);
      assert.ok(
        calls.some(
          call =>
            call[0] === 'updateHub' &&
            call[1].selectedSessionId === 'city-session',
        ),
      );
      assert.ok(
        calls.some(call => call[0] === 'setMotion' && call[1] === false),
      );
      assert.ok(
        calls.some(
          call => call[0] === 'setPalette' && Array.isArray(call[1].running),
        ),
      );
      assert.equal(calls.filter(call => call[0] === 'dispose').length, 1);
    },
  );

  await run(
    'same custom renderer receives palette changes without replacing its canvas',
    async () => {
      const state = await evaluate(async () => {
        const f = window.fixture;
        f.reset();
        const entry = f.plugin({tag: 'palette'});
        await f.theme(entry);
        f.rememberCanvas();
        await f.host().setTheme(entry, {...f.palette, running: [1, 0, 1]});
        return f.inspect();
      });
      assert.equal(state.canvasChanged, false);
      assert.equal(state.calls.filter(call => call[0] === 'create').length, 1);
      assert.deepEqual(state.calls.at(-1), [
        'setPalette',
        {...(await evaluate(() => window.fixture.palette)), running: [1, 0, 1]},
      ]);
    },
  );

  await run(
    'optional hooks forward and session changes clear pending reactions',
    async () => {
      const state = await evaluate(async () => {
        const f = window.fixture;
        f.reset();
        f.host().update(f.snapshot());
        f.host().prompt('city-session');
        await f.theme(f.plugin({tag: 'hooks'}));
        const targets = f.host().caneTargets();
        const hit = f.host().hitWithCane('builder', -1, 2);
        f.host().cancelPrompt('city-session');
        f.host().startle(false);
        f.host().clearStartle();
        f.host().prompt('city-session');
        f.host().update({
          ...f.snapshot(),
          session: {id: 'other', status: 'idle'},
        });
        await f.theme(f.plugin({tag: 'other-session'}));
        return {...f.inspect(), targets, hit};
      });
      assert.equal(state.hit, true);
      assert.equal(state.targets[0].id, 'builder');
      assert.ok(
        state.calls.some(
          call => call[0] === 'prompt' && call[1] === 'city-session',
        ),
      );
      assert.ok(state.calls.some(call => call[0] === 'cancelPrompt'));
      assert.ok(
        state.calls.some(call => call[0] === 'startle' && call[1] === false),
      );
      assert.ok(state.calls.some(call => call[0] === 'clearStartle'));
      const recent = state.calls.slice(
        state.calls.findIndex(
          call => call[0] === 'create' && call[1] === 'other-session',
        ),
      );
      assert.ok(!recent.some(call => ['prompt', 'startle'].includes(call[0])));
    },
  );

  await run(
    'stale custom import cannot replace a newer built in renderer or send callbacks',
    async () => {
      const state = await evaluate(async () => {
        const f = window.fixture;
        f.reset();
        await f.theme(f.plugin({tag: 'callbacks'}));
        const old = window.pluginOptions.at(-1);
        window.importGate = new Promise(resolve => {
          window.releaseImport = resolve;
        });
        const pending = f.theme(f.plugin({tag: 'stale', delay: 'importGate'}));
        await f.theme({scene: 'year1998'});
        window.releaseImport();
        await pending;
        old.onSelect('stale');
        old.onLayout([{id: 'stale'}]);
        return f.inspect();
      });
      assert.equal(state.renderer, 'year1998');
      assert.ok(
        !state.calls.some(call => call[0] === 'create' && call[1] === 'stale'),
      );
      assert.deepEqual(state.selections, []);
      assert.ok(!state.layout?.some(item => item.id === 'stale'));
    },
  );

  await run(
    'disposal invalidates pending module imports and renderer callbacks',
    async () => {
      const state = await evaluate(async () => {
        const f = window.fixture;
        f.reset();
        await f.theme(f.plugin({tag: 'before-dispose'}));
        const old = window.pluginOptions.at(-1);
        window.disposeGate = new Promise(resolve => {
          window.releaseDispose = resolve;
        });
        const pending = f.theme(
          f.plugin({tag: 'after-dispose', delay: 'disposeGate'}),
        );
        f.dispose();
        window.releaseDispose();
        await pending;
        old.onSelect('disposed');
        old.onLayout([{id: 'disposed'}]);
        f.dispose();
        return f.inspect();
      });
      assert.ok(
        !state.calls.some(
          call => call[0] === 'create' && call[1] === 'after-dispose',
        ),
      );
      assert.equal(state.calls.filter(call => call[0] === 'dispose').length, 1);
      assert.deepEqual(state.selections, []);
    },
  );

  await run(
    'invalid exports, missing required methods and failed imports fall back with diagnostics',
    async () => {
      const states = await evaluate(async () => {
        const f = window.fixture;
        const entries = [
          f.plugin({tag: 'wrong-version', exported: 2}),
          ...['update', 'setPalette', 'setMotion', 'dispose'].map(omit =>
            f.plugin({tag: 'missing-' + omit, omit}),
          ),
          {
            scene: {
              apiVersion: 1,
              moduleUrl:
                'data:text/javascript,throw new Error("module import failed")',
            },
          },
          {
            scene: {
              apiVersion: 3,
              moduleUrl: 'data:text/javascript,export const apiVersion=3',
            },
          },
          {
            scene: {
              apiVersion: 1,
              moduleUrl: 'data:text/javascript,export const apiVersion=1',
            },
          },
        ];
        const result = [];
        for (const entry of entries) {
          f.reset();
          f.host().update(f.snapshot());
          await f.theme(entry);
          result.push(f.inspect());
        }
        return result;
      });
      assert.equal(states.length, 8);
      for (const state of states) {
        assert.equal(state.renderer, 'factory');
        assert.equal(state.available, true);
        assert.ok(
          state.errors.some(error =>
            error.startsWith('Could not display theme scene: '),
          ),
        );
        assert.ok(state.layout?.some(anchor => anchor.id === 'parent'));
      }
    },
  );

  await run(
    'custom method failures recover to factory and replay current state',
    async () => {
      const states = await evaluate(async () => {
        const f = window.fixture;
        const result = [];
        for (const method of [
          'update',
          'setPalette',
          'setMotion',
          'updateHub',
          'prompt',
          'caneTargets',
          'hitWithCane',
        ]) {
          f.reset();
          await f.theme(f.plugin({tag: 'throw-' + method, throws: method}));
          if (method === 'update') f.host().update(f.snapshot(), 'builder');
          else if (method === 'setPalette')
            await f
              .host()
              .setTheme(
                f.plugin({tag: 'throw-' + method, throws: method}),
                f.palette,
              );
          else if (method === 'setMotion') f.host().setMotion(true);
          else if (method === 'updateHub') f.host().updateHub({sessions: []});
          else if (method === 'prompt') f.host().prompt('city-session');
          else f.host()[method]('builder');
          result.push(f.inspect());
        }
        return result;
      });
      for (const state of states) {
        assert.equal(state.renderer, 'factory');
        assert.ok(state.errors.some(error => /failed/.test(error)));
        assert.equal(
          state.calls.filter(call => call[0] === 'dispose').length,
          1,
        );
      }
    },
  );

  await run(
    'custom scenes may omit optional hooks and cleanup failures remain diagnosable',
    async () => {
      const states = await evaluate(async () => {
        const f = window.fixture;
        f.reset();
        await f.theme({
          scene: {
            apiVersion: 1,
            moduleUrl:
              'data:text/javascript,' +
              encodeURIComponent(
                'export const apiVersion=1; export function createScene() {return {update(){}, setPalette(){}, setMotion(){}, dispose(){}};}',
              ),
          },
        });
        f.host().updateHub({sessions: []});
        f.host().prompt('city-session');
        f.host().cancelPrompt('city-session');
        f.host().startle(false);
        f.host().clearStartle();
        const targets = f.host().caneTargets();
        const hit = f.host().hitWithCane('missing');
        const optional = {...f.inspect(), targets, hit};
        await f.theme(f.plugin({tag: 'cleanup', throws: 'dispose'}));
        await f.theme({scene: 'year1998'});
        return {optional, cleanup: f.inspect()};
      });
      assert.equal(states.optional.renderer, 'plugin');
      assert.deepEqual(states.optional.targets, []);
      assert.equal(states.optional.hit, false);
      assert.deepEqual(states.optional.errors.filter(Boolean), []);
      assert.equal(states.cleanup.renderer, 'year1998');
      assert.ok(
        states.cleanup.errors.some(error =>
          /Scene cleanup failed: cleanup dispose failed/.test(error),
        ),
      );
    },
  );

  await run(
    'Year1998 draws Canvas2D robots with normalized anchors and selectable targets',
    async () => {
      const state = await evaluate(async () => {
        const f = window.fixture;
        await f.year();
        const hash = f.pixelHash();
        const targets = f.host().caneTargets();
        const canvas = document.querySelector('canvas');
        for (const target of targets)
          canvas.dispatchEvent(
            new MouseEvent('click', {
              bubbles: true,
              clientX: target.x,
              clientY: target.y,
            }),
          );
        for (const anchor of f.inspect().layout) f.click(anchor.id);
        return {
          ...f.inspect(),
          targets,
          hash,
          width: window.innerWidth,
          height: window.innerHeight,
        };
      });
      assert.equal(state.renderer, 'year1998');
      assert.ok(state.hash > 0);
      assert.deepEqual(
        new Set(state.layout.map(anchor => anchor.id)),
        new Set(['parent', 'builder', 'reviewer']),
      );
      for (const anchor of state.layout) {
        assert.equal(anchor.visible, true);
        assert.ok(anchor.x > 0 && anchor.x < 1 && anchor.y > 0 && anchor.y < 1);
        assert.equal(
          state.selections.filter(id => id === anchor.id).length,
          2,
          anchor.id + ' selects at body and label anchor',
        );
      }
      assert.equal(state.targets.length, 3);
      for (const target of state.targets) {
        assert.ok(target.radius >= 12);
        assert.ok(
          target.x > 0 &&
            target.x < state.width &&
            target.y > 0 &&
            target.y < state.height,
        );
      }
    },
  );

  await run(
    'Year1998 status transitions change rendered pixels and create expiring effects',
    async () => {
      const state = await evaluate(async () => {
        const f = window.fixture;
        await f.year('running');
        f.host().setMotion(true);
        const before = f.pixelHash();
        f.host().update(f.snapshot('running', 'completed'), 'builder');
        const completed = {...f.inspect(), hash: f.pixelHash()};
        f.advance(32);
        const expired = f.inspect();
        const next = f.snapshot('running', 'completed');
        next.agents.push({id: 'new-worker', status: 'running'});
        f.host().update(next, 'new-worker');
        const spawned = f.inspect();
        await f.year('running');
        f.host().update(f.snapshot('running', 'completed'), 'builder');
        f.host().setMotion(true);
        return {
          before,
          completed,
          expired,
          spawned,
          withoutEffects: f.pixelHash(),
        };
      });
      assert.notEqual(
        state.completed.hash,
        state.before,
        'Status transition reaches the actual Canvas2D output',
      );
      assert.notEqual(
        state.completed.hash,
        state.withoutEffects,
        'Completion effects contribute visible pixels beyond the final status',
      );
      assert.ok(state.completed.data.sceneEvents.includes('builder:completed'));
      assert.equal(
        JSON.parse(state.completed.data.agentStatuses).find(
          agent => agent.id === 'builder',
        ).status,
        'completed',
      );
      assert.equal(state.expired.data.sceneEvents, '');
      assert.ok(state.spawned.data.sceneEvents.includes('new-worker:spawned'));
    },
  );

  await run(
    'Year1998 follows the shared parent rest, walk, activity and work states',
    async () => {
      const state = await evaluate(async () => {
        const f = window.fixture;
        await f.year('running');
        const staticActivities = [];
        const activities = [
          ['Thinking', 'thinking'],
          ['Responding', 'writing'],
          ['Writing', 'writing'],
          ['Using tool: read', 'tools'],
          ['Running bash', 'tools'],
          ['Running read', 'tools'],
          ['Running write', 'tools'],
          ['Running edit', 'tools'],
          ['Running agent_worker', 'tools'],
          ['Writing using tool', 'tools'],
          ['Thinking', 'thinking'],
        ];
        for (const [activity, expectedWork] of activities) {
          f.host().update(
            {
              session: {id: 'city-session', status: 'running', activity},
              agents: [],
            },
            'parent',
          );
          const hash = f.pixelHash();
          f.advance(5);
          staticActivities.push({
            activity,
            expectedWork,
            hash,
            after: f.pixelHash(),
            pending: f.inspect().pending,
            status: f.inspect().data.parentStatus,
            work: f.inspect().data.parentWork,
            image: ['Thinking', 'Responding', 'Using tool: read'].includes(
              activity,
            )
              ? document.querySelector('canvas').toDataURL('image/png')
              : undefined,
          });
        }
        f.host().update(
          {
            session: {
              id: 'city-session',
              status: 'compacting',
              activity: 'Compacting',
            },
            agents: [],
          },
          'parent',
        );
        const compacting = {
          hash: f.pixelHash(),
          work: f.inspect().data.parentWork,
          image: document.querySelector('canvas').toDataURL('image/png'),
        };
        f.advance(5);
        compacting.after = f.pixelHash();
        compacting.pending = f.inspect().pending;
        await f.year();
        const snapshot = {
          session: {id: 'city-session', status: 'idle'},
          agents: [],
        };
        f.host().update(snapshot);
        const reference = f.createParentMotion();
        reference.setMotion(false);
        reference.update(snapshot.session);
        reference.update(snapshot.session);
        reference.setMotion(true);
        f.host().setMotion(true);
        const seen = new Set();
        const mismatches = [];
        let frames = 0;
        for (; frames < 1600; frames++) {
          f.advance();
          if (frames > 0) reference.tick(0.05);
          const actual = f.inspect().data;
          const expected = reference.pose();
          seen.add(actual.parentMode);
          if (
            actual.parentMode !== expected.mode ||
            actual.parentActivity !== (expected.activity || '')
          ) {
            mismatches.push({
              frame: frames,
              actual: [actual.parentMode, actual.parentActivity],
              expected: [expected.mode, expected.activity || ''],
            });
            break;
          }
          if (expected.activity) break;
        }
        const activity = f.inspect();
        f.host().prompt('city-session');
        reference.prompt();
        const prompted = f.inspect().data.parentMode;
        f.host().update({
          session: {id: 'city-session', status: 'running'},
          agents: [],
        });
        reference.update({id: 'city-session', status: 'running'});
        for (let i = 0; i < 200; i++) {
          f.advance();
          reference.tick(0.05);
          if (reference.pose().mode === 'work') break;
        }
        const workMode = f.inspect().data.parentMode;
        function eyePixels() {
          const canvas = document.querySelector('canvas');
          const bounds = canvas.getBoundingClientRect();
          const target = f
            .host()
            .caneTargets()
            .find(target => target.id === 'parent');
          const scaleX = canvas.width / bounds.width;
          const scaleY = canvas.height / bounds.height;
          const left = Math.floor(
            (target.x - bounds.left - target.radius / 2) * scaleX,
          );
          const top = Math.floor(
            (target.y - bounds.top - target.radius / 2) * scaleY,
          );
          const width = Math.ceil(target.radius * scaleX);
          const height = Math.ceil((target.radius / 2) * scaleY);
          const pixels = canvas
            .getContext('2d')
            .getImageData(left, top, width, height).data;
          const eyeColor = f.palette.eyes.map(channel =>
            Math.round(channel * 255),
          );
          let lit = 0;
          const rows = new Set();
          for (let index = 0; index < pixels.length; index += 4) {
            if (
              !eyeColor.every(
                (channel, offset) => pixels[index + offset] === channel,
              )
            )
              continue;
            lit++;
            rows.add(Math.floor(index / 4 / width));
          }
          return {lit, rows: rows.size};
        }
        f.host().update({
          session: {id: 'city-session', status: 'idle'},
          agents: [],
        });
        f.host().startle(true);
        f.advance(24);
        const stopped = {data: f.inspect().data, eyes: eyePixels()};
        f.host().update({
          session: {id: 'city-session', status: 'cancelled'},
          agents: [],
        });
        const cancelledEyes = eyePixels();
        return {
          staticActivities,
          compacting,
          stopped,
          cancelledEyes,
          seen: [...seen],
          mismatches,
          frames,
          activity: activity.data.parentActivity,
          prompted,
          mode: workMode,
          expectedMode: reference.pose().mode,
        };
      });
      const [thinking, responding, writing, tool] = state.staticActivities;
      const screenshotDirectory = resolve(
        __dirname,
        '../../.pi/tmp/year1998-scenes',
      );
      mkdirSync(screenshotDirectory, {recursive: true});
      writeFileSync(
        join(screenshotDirectory, 'work-compacting.png'),
        Buffer.from(state.compacting.image.split(',')[1], 'base64'),
      );
      assert.equal(state.compacting.work, 'compacting');
      assert.equal(state.compacting.pending, 0);
      assert.equal(state.compacting.hash, state.compacting.after);
      for (const sample of [thinking, responding, tool]) {
        assert.notEqual(
          state.compacting.hash,
          sample.hash,
          'Compacting has distinct static props',
        );
      }
      for (const sample of [thinking, responding, tool])
        writeFileSync(
          join(screenshotDirectory, 'work-' + sample.expectedWork + '.png'),
          Buffer.from(sample.image.split(',')[1], 'base64'),
        );
      for (const sample of state.staticActivities) {
        assert.equal(
          sample.pending,
          0,
          sample.activity + ' does not schedule RAF with motion off',
        );
        assert.equal(sample.status, 'running');
        assert.equal(
          sample.work,
          sample.expectedWork,
          sample.activity + ' uses the regular scene work classification',
        );
        assert.equal(
          sample.hash,
          sample.after,
          sample.activity + ' stays still across queued frame advances',
        );
        const expectedHash =
          sample.expectedWork === 'thinking'
            ? thinking.hash
            : sample.expectedWork === 'writing'
              ? responding.hash
              : tool.hash;
        assert.equal(
          sample.hash,
          expectedHash,
          sample.activity + ' renders the same props as its work kind',
        );
      }
      for (const sample of [responding, writing, tool])
        assert.notEqual(
          thinking.hash,
          sample.hash,
          sample.activity + ' changes the static parent pixels from Thinking',
        );
      for (const sample of [responding, writing])
        assert.notEqual(
          tool.hash,
          sample.hash,
          sample.activity + ' has different static pixels from Using tool',
        );
      assert.equal(
        state.staticActivities.at(-1).hash,
        thinking.hash,
        'Activity-only updates restore the same pixels without advancing motion',
      );
      assert.deepEqual(
        state.mismatches,
        [],
        'Renderer advances the shared parent controller at the scene clock',
      );
      assert.ok(state.seen.includes('rest'));
      assert.ok(state.seen.includes('walk'));
      assert.ok(state.seen.includes('idle'));
      assert.ok(state.activity);
      assert.equal(state.prompted, 'startled');
      assert.equal(state.mode, 'work');
      assert.equal(state.mode, state.expectedMode);
      assert.equal(
        state.stopped.data.parentMode,
        'rest',
        'Stop settles the parent after its reaction',
      );
      assert.ok(
        Number(state.stopped.data.parentEyes) >= 0.24,
        'Stopped parent retains awake eyes',
      );
      assert.ok(
        state.cancelledEyes.lit > 0,
        'Eye region contains the palette eye color',
      );
      assert.ok(
        state.stopped.eyes.rows > state.cancelledEyes.rows,
        'Actual stopped eyes remain taller than cancelled eyelids',
      );
      assert.ok(
        state.stopped.eyes.lit > state.cancelledEyes.lit,
        'Awake eye area is visible in the Canvas2D pixels',
      );
    },
  );

  await run(
    'Year1998 motion off schedules no RAF and disposal releases listeners and observers',
    async () => {
      const state = await evaluate(async () => {
        const f = window.fixture;
        await f.year();
        f.host().prompt('city-session');
        f.host().startle(true);
        f.host().clearStartle();
        f.host().update(f.snapshot('running', 'failed'), 'builder');
        f.advance(10);
        const stopped = f.inspect();
        f.host().setMotion(true);
        const moving = f.inspect();
        const canvas = document.querySelector('canvas');
        const targets = f.host().caneTargets();
        const before = f.pixelHash();
        f.dispose();
        canvas.dispatchEvent(
          new MouseEvent('click', {
            clientX: targets[0].x,
            clientY: targets[0].y,
          }),
        );
        window.dispatchEvent(new Event('resize'));
        document.dispatchEvent(new Event('visibilitychange'));
        f.advance(5);
        return {
          stopped,
          moving,
          disposed: f.inspect(),
          before,
          after: f.pixelHash(),
        };
      });
      assert.equal(state.stopped.pending, 0);
      assert.equal(state.stopped.data.parentStatus, 'running');
      assert.equal(
        JSON.parse(state.stopped.data.agentStatuses).find(
          agent => agent.id === 'builder',
        ).status,
        'failed',
      );
      assert.ok(state.moving.pending > 0);
      assert.equal(state.disposed.pending, 0);
      assert.equal(state.disposed.activeResizers, 0);
      assert.deepEqual(state.disposed.selections, []);
      assert.equal(state.disposed.data.renderer, undefined);
      assert.equal(
        state.after,
        state.before,
        'Disposed scene does not repaint on resize or queued callbacks',
      );
    },
  );

  await run(
    'Year1998 normal and compact scenes render visible content for visual review',
    async () => {
      const output = resolve(__dirname, '../../.pi/tmp/year1998-scenes');
      mkdirSync(output, {recursive: true});
      for (const [name, width, height, dense] of [
        ['normal', 960, 600, true],
        ['compact', 360, 260, false],
        ['compact-dense', 380, 240, true],
      ]) {
        browser.setContentSize(width, height);
        await evaluate(async dense => {
          const f = window.fixture;
          await f.year('running');
          const snapshot = f.snapshot('running');
          snapshot.agents = dense
            ? [
                'running',
                'running',
                'queued',
                'completed',
                'failed',
                'cancelling',
                'compacting',
                'cancelled',
              ].map((status, index) => ({
                id: 'city-agent-' + index,
                name: status,
                status,
              }))
            : [];
          f.host().update(snapshot, dense ? 'city-agent-4' : 'parent');
          window.dispatchEvent(new Event('resize'));
        }, dense);
        const state = await evaluate(() => ({
          ...window.fixture.inspect(),
          hash: window.fixture.pixelHash(),
        }));
        assert.equal(state.renderer, 'year1998');
        assert.ok(state.hash > 0);
        assert.equal(state.layout.length, dense ? 9 : 1);
        for (const anchor of state.layout)
          assert.equal(
            anchor.visible,
            true,
            name + ': ' + anchor.id + ' stays visible',
          );
        const path = join(output, name + '.png');
        writeFileSync(path, (await browser.webContents.capturePage()).toPNG());
        report.screenshots.push(path);
      }
    },
  );
  await evaluate(() => window.fixture.dispose());
}
main()
  .catch(error => {
    report.fatal = error.stack || String(error);
  })
  .finally(() => {
    mkdirSync(directory, {recursive: true});
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    browser?.destroy();
    app.exit(report.fatal || report.cases.some(item => item.error) ? 1 : 0);
  });
