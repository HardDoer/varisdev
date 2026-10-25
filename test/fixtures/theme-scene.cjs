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
  // Pixel comparisons read back repeatedly; keep Canvas2D on one rasterizer.
  const getContext = window.HTMLCanvasElement.prototype.getContext;
  window.HTMLCanvasElement.prototype.getContext = function (type, options) {
    return getContext.call(
      this,
      type,
      type === '2d' ? {...options, willReadFrequently: true} : options,
    );
  };
  const contextLossListeners = new Map();
  const addListener = window.HTMLCanvasElement.prototype.addEventListener;
  const removeListener = window.HTMLCanvasElement.prototype.removeEventListener;
  window.HTMLCanvasElement.prototype.addEventListener = function (
    type,
    listener,
    ...options
  ) {
    if (type === 'webglcontextlost') {
      if (!contextLossListeners.has(this))
        contextLossListeners.set(this, new Set());
      contextLossListeners.get(this).add(listener);
    }
    return addListener.call(this, type, listener, ...options);
  };
  window.HTMLCanvasElement.prototype.removeEventListener = function (
    type,
    listener,
    ...options
  ) {
    if (type === 'webglcontextlost') {
      const listeners = contextLossListeners.get(this);
      listeners?.delete(listener);
      if (!listeners?.size) contextLossListeners.delete(this);
    }
    return removeListener.call(this, type, listener, ...options);
  };
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
  function reset({agentsForBuiltin} = {}) {
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
      agentsForBuiltin,
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
      contextLossListeners: [...contextLossListeners.values()].reduce(
        (count, listeners) => count + listeners.size,
        0,
      ),
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
  async function withContexts(mode, action) {
    const prototype = window.HTMLCanvasElement.prototype;
    const original = prototype.getContext;
    const attempts = [];
    const locked = [];
    prototype.getContext = function (type, options) {
      attempts.push({canvas: this, type});
      if (type === 'webgl') {
        if (['null', 'none', '2d-throw'].includes(mode)) return null;
        if (mode === 'throw') throw new Error('WebGL creation failed');
      }
      if (type === '2d') {
        if (mode === 'none') return null;
        if (mode === '2d-throw') throw new Error('Canvas2D creation failed');
      }
      const context = original.call(this, type, options);
      if (type === 'webgl' && ['shader', 'buffer'].includes(mode)) {
        if (!context) throw new Error('Real WebGL context is required');
        locked.push(this);
        if (mode === 'shader') {
          context.getShaderParameter = () => false;
          context.getShaderInfoLog = () => 'Injected shader failure';
        } else {
          context.createBuffer = () => {
            throw new Error('Factory buffer allocation failed');
          };
        }
      }
      return context;
    };
    try {
      const state = await action();
      const current = document.querySelector('canvas');
      return {
        ...state,
        contextAttempts: attempts.map(({canvas, type}) => ({
          type,
          current: canvas === current,
        })),
        lockedCanvases: locked.length,
        lockedCanvasReplaced: locked.every(
          canvas => !canvas.isConnected && canvas !== current,
        ),
        lockedCanvasRejects2D: locked.every(
          canvas => original.call(canvas, '2d') === null,
        ),
      };
    } finally {
      prototype.getContext = original;
    }
  }
  function pixelHash() {
    const canvas = document.querySelector('canvas');
    const context = canvas.getContext('2d');
    let pixels;
    if (context)
      pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    else {
      const gl = canvas.getContext('webgl');
      if (!gl) throw new Error('Scene requires a canvas context');
      pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(
        0,
        0,
        canvas.width,
        canvas.height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
    }
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
    withContexts,
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
      const state = inspect();
      if (state.renderer !== 'year1998')
        throw new Error(
          'Year1998 failed to initialize: ' + state.errors.join('; '),
        );
      return state;
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
    'null and throwing WebGL contexts use a selectable Canvas2D factory with replayed state',
    async () => {
      const states = await evaluate(async () => {
        const f = window.fixture;
        const results = [];
        for (const mode of ['null', 'throw']) {
          results.push(
            await f.withContexts(mode, async () => {
              f.reset();
              f.host().update(f.snapshot('running'), 'builder');
              f.host().setMotion(false);
              f.host().startle(false);
              f.rememberCanvas();
              await f.theme({scene: 'factory'});
              const initial = {...f.inspect(), hash: f.pixelHash()};
              f.advance(5);
              const stoppedHash = f.pixelHash();
              f.click('builder');
              f.host().clearStartle();
              const selectedHash = f.pixelHash();
              f.host().update(f.snapshot('running'), 'parent');
              const parentSelectedHash = f.pixelHash();
              f.rememberCanvas();
              await f
                .host()
                .setTheme(
                  {scene: 'factory'},
                  {...f.palette, shell: [1, 0, 1], running: [1, 0, 1]},
                );
              const palette = {...f.inspect(), hash: f.pixelHash()};
              const hit = f.host().hitWithCane('builder', 1, 1);
              f.host().setMotion(true);
              const moving = f.inspect();
              f.dispose();
              return {
                initial,
                stoppedHash,
                selectedHash,
                parentSelectedHash,
                palette,
                hit,
                moving,
                disposed: f.inspect(),
              };
            }),
          );
        }
        return results;
      });
      for (const state of states) {
        const {initial} = state;
        assert.equal(initial.renderer, 'factory-2d');
        assert.equal(initial.available, true);
        assert.equal(initial.hidden, false);
        assert.equal(initial.canvasChanged, true);
        assert.equal(initial.data.parentStatus, 'running');
        assert.equal(initial.data.parentMode, 'startled');
        assert.deepEqual(initial.availability, [true]);
        assert.deepEqual(initial.errors.filter(Boolean), []);
        assert.deepEqual(initial.layout.map(anchor => anchor.id).sort(), [
          'builder',
          'parent',
          'reviewer',
        ]);
        assert.equal(state.stoppedHash, initial.hash);
        assert.equal(initial.pending, 0);
        assert.notEqual(state.selectedHash, state.parentSelectedHash);
        assert.notEqual(state.palette.hash, state.parentSelectedHash);
        assert.equal(state.palette.canvasChanged, false);
        assert.equal(state.palette.selections.at(-1), 'builder');
        assert.equal(state.hit, true);
        assert.ok(state.moving.pending > 0);
        assert.equal(state.disposed.pending, 0);
        assert.equal(state.disposed.activeResizers, 0);
        assert.deepEqual(state.contextAttempts[0], {
          type: 'webgl',
          current: false,
        });
        assert.ok(
          state.contextAttempts.some(
            attempt => attempt.type === '2d' && attempt.current,
          ),
        );
      }
    },
  );

  await run(
    'failed shaders and thrown factory creation replace a canvas locked by real WebGL',
    async () => {
      const states = await evaluate(async () => {
        const f = window.fixture;
        const results = [];
        for (const mode of ['shader', 'buffer']) {
          results.push(
            await f.withContexts(mode, async () => {
              f.reset();
              f.host().update(f.snapshot('running'), 'reviewer');
              f.host().setMotion(false);
              await f.theme({scene: 'factory'});
              return {...f.click('reviewer'), hash: f.pixelHash(), mode};
            }),
          );
        }
        return results;
      });
      for (const state of states) {
        assert.equal(state.renderer, 'factory-2d');
        assert.equal(state.available, true);
        assert.equal(state.lockedCanvases, 1);
        assert.equal(state.lockedCanvasReplaced, true);
        assert.equal(state.lockedCanvasRejects2D, true);
        assert.ok(state.hash > 0);
        assert.equal(state.selections.at(-1), 'reviewer');
        assert.equal(state.contextLossListeners, 0);
        if (state.mode === 'buffer')
          assert.deepEqual(state.errors.filter(Boolean), [
            'Could not display theme scene: Factory buffer allocation failed',
          ]);
        else assert.deepEqual(state.errors.filter(Boolean), []);
      }
    },
  );

  await run(
    'context loss switches to Canvas2D with state replay and ignores events from the old canvas',
    async () => {
      const state = await evaluate(async () => {
        const f = window.fixture;
        f.reset({
          agentsForBuiltin: snapshot =>
            snapshot.agents.filter(agent => agent.id === 'reviewer'),
        });
        const hub = {
          sessions: [
            {id: 'city-session', status: 'running'},
            {id: 'other-session', status: 'idle'},
          ],
        };
        f.host().updateHub(hub);
        f.host().update(f.snapshot('running'), 'reviewer');
        f.host().setMotion(false);
        f.host().startle(false);
        const palette = {...f.palette, shell: [0.9, 0.15, 0.75]};
        await f.host().setTheme({scene: 'factory'}, palette);
        const before = f.inspect();
        const oldCanvas = document.querySelector('canvas');
        f.rememberCanvas();
        const lost = new Event('webglcontextlost', {cancelable: true});
        oldCanvas.dispatchEvent(lost);
        const recovered = {...f.inspect(), hash: f.pixelHash()};
        const replacement = document.querySelector('canvas');
        for (const type of ['webglcontextlost', 'webglcontextrestored'])
          oldCanvas.dispatchEvent(new Event(type, {cancelable: true}));
        oldCanvas.dispatchEvent(new MouseEvent('click'));
        f.advance(4);
        const stale = {
          ...f.inspect(),
          hash: f.pixelHash(),
          sameCanvas: replacement === document.querySelector('canvas'),
        };
        f.click('reviewer');
        await f.host().setTheme(f.plugin({tag: 'after-context-loss'}), palette);
        return {
          before,
          recovered,
          stale,
          final: f.inspect(),
          prevented: lost.defaultPrevented,
          hub,
          palette,
        };
      });
      assert.equal(state.before.renderer, 'factory');
      assert.equal(state.before.contextLossListeners, 2);
      assert.equal(state.prevented, true);
      assert.equal(state.recovered.renderer, 'factory-2d');
      assert.equal(state.recovered.available, true);
      assert.equal(state.recovered.canvasChanged, true);
      assert.equal(state.recovered.data.parentStatus, 'running');
      assert.equal(state.recovered.data.parentMode, 'startled');
      assert.deepEqual(state.recovered.availability, [true, true]);
      assert.deepEqual(state.recovered.errors.filter(Boolean), []);
      assert.deepEqual(state.recovered.layout.map(anchor => anchor.id).sort(), [
        'parent',
        'reviewer',
      ]);
      assert.equal(state.recovered.contextLossListeners, 0);
      assert.equal(state.recovered.activeResizers, 1);
      assert.equal(state.recovered.pending, 0);
      assert.equal(state.stale.sameCanvas, true);
      assert.equal(state.stale.hash, state.recovered.hash);
      assert.deepEqual(state.stale.selections, []);
      assert.equal(state.final.selections.at(-1), 'reviewer');
      assert.equal(state.final.renderer, 'plugin');
      assert.ok(
        state.final.calls.some(
          call => call[0] === 'setMotion' && call[1] === false,
        ),
      );
      assert.deepEqual(
        state.final.calls.find(call => call[0] === 'setPalette')[1],
        state.palette,
      );
      assert.deepEqual(
        state.final.calls.find(call => call[0] === 'updateHub')[1],
        state.hub,
      );
      assert.equal(
        state.final.calls.find(call => call[0] === 'update')[1].agents.length,
        2,
        'Custom scenes receive the unfiltered snapshot',
      );
      assert.equal(
        state.final.calls.find(call => call[0] === 'update')[2],
        'reviewer',
      );
      assert.ok(
        state.final.calls.some(
          call => call[0] === 'startle' && call[1] === false,
        ),
      );
    },
  );

  await run(
    'switching and disposal remove factory context listeners and ignore detached canvas events',
    async () => {
      const state = await evaluate(async () => {
        const f = window.fixture;
        f.reset();
        f.host().update(f.snapshot('running'));
        f.host().setMotion(true);
        await f.theme({scene: 'factory'});
        const oldCanvas = document.querySelector('canvas');
        await f.theme({scene: 'year1998'});
        const switchedCanvas = document.querySelector('canvas');
        oldCanvas.dispatchEvent(
          new Event('webglcontextlost', {cancelable: true}),
        );
        oldCanvas.dispatchEvent(new Event('webglcontextrestored'));
        const switched = {
          ...f.inspect(),
          sameCanvas: switchedCanvas === document.querySelector('canvas'),
        };
        await f.theme({scene: 'factory'});
        const beforeDispose = f.inspect();
        const disposedCanvas = document.querySelector('canvas');
        const targets = f.host().caneTargets();
        f.dispose();
        const lost = new Event('webglcontextlost', {cancelable: true});
        disposedCanvas.dispatchEvent(lost);
        disposedCanvas.dispatchEvent(new Event('webglcontextrestored'));
        for (const target of targets)
          disposedCanvas.dispatchEvent(
            new MouseEvent('click', {clientX: target.x, clientY: target.y}),
          );
        window.dispatchEvent(new Event('resize'));
        f.advance(4);
        return {
          switched,
          beforeDispose,
          disposed: {
            ...f.inspect(),
            sameCanvas: disposedCanvas === document.querySelector('canvas'),
          },
          preventedAfterDispose: lost.defaultPrevented,
        };
      });
      assert.equal(state.switched.renderer, 'year1998');
      assert.equal(state.switched.sameCanvas, true);
      assert.equal(state.switched.contextLossListeners, 0);
      assert.equal(state.switched.activeResizers, 1);
      assert.equal(state.beforeDispose.renderer, 'factory');
      assert.equal(state.beforeDispose.contextLossListeners, 2);
      assert.equal(state.disposed.sameCanvas, true);
      assert.equal(state.disposed.contextLossListeners, 0);
      assert.equal(state.disposed.activeResizers, 0);
      assert.equal(state.disposed.pending, 0);
      assert.deepEqual(state.disposed.selections, []);
      assert.equal(state.preventedAfterDispose, false);
    },
  );

  await run(
    'unavailable WebGL and Canvas2D retain the DOM fallback and custom errors',
    async () => {
      const states = await evaluate(async () => {
        const f = window.fixture;
        const results = [];
        for (const mode of ['none', '2d-throw']) {
          results.push(
            await f.withContexts(mode, async () => {
              f.reset();
              document.querySelector('#fallback').innerHTML =
                '<div class="fallback-station parent-session"><span class="robot-glyph"></span></div>';
              f.host().update(f.snapshot('running'));
              f.host().setMotion(false);
              await f.theme({scene: 'factory'});
              const fallback = {
                ...f.inspect(),
                robot: Boolean(
                  document.querySelector('.parent-fallback-robot path'),
                ),
              };
              await f.theme(
                f.plugin({tag: 'fallback-error', throws: 'update'}),
              );
              const failedPlugin = f.inspect();
              f.dispose();
              return {fallback, failedPlugin, disposed: f.inspect()};
            }),
          );
        }
        return results;
      });
      for (const state of states) {
        assert.equal(state.fallback.available, false);
        assert.equal(state.fallback.hidden, true);
        assert.equal(state.fallback.robot, true);
        assert.deepEqual(state.fallback.layout, []);
        assert.deepEqual(state.fallback.availability, [false]);
        assert.equal(state.fallback.pending, 0);
        assert.deepEqual(state.fallback.errors.filter(Boolean), []);
        assert.equal(state.failedPlugin.available, false);
        assert.equal(state.failedPlugin.hidden, true);
        assert.ok(
          state.failedPlugin.errors.includes(
            'Could not display theme scene: fallback-error update failed',
          ),
        );
        assert.equal(
          state.failedPlugin.calls.filter(call => call[0] === 'dispose').length,
          1,
        );
        assert.equal(state.disposed.pending, 0);
        assert.equal(state.disposed.activeResizers, 0);
        assert.equal(state.disposed.contextLossListeners, 0);
      }
    },
  );

  await run(
    'renderers use the latest visibility entry to resume motion and paint hidden updates',
    async () => {
      const states = await evaluate(async () => {
        const f = window.fixture;
        const NativeObserver = window.IntersectionObserver;
        const observers = new Set();
        window.IntersectionObserver = class {
          constructor(callback) {
            this.callback = callback;
            observers.add(this);
          }
          observe(target) {
            this.target = target;
          }
          disconnect() {
            observers.delete(this);
          }
        };
        function visibility(...values) {
          for (const observer of observers)
            observer.callback(
              values.map(isIntersecting => ({
                target: observer.target,
                isIntersecting,
              })),
              observer,
            );
        }
        async function sample(kind) {
          f.reset();
          f.host().update(f.snapshot('running'), 'builder');
          f.host().setMotion(true);
          await f.theme({scene: kind === 'factory-2d' ? 'factory' : kind});
          visibility(false, true);
          f.advance();
          const before = {...f.inspect(), hash: f.pixelHash()};
          f.advance(8);
          const moving = {...f.inspect(), hash: f.pixelHash()};
          visibility(true, false);
          const hidden = {...f.inspect(), hash: f.pixelHash()};
          f.host().update(f.snapshot('compacting'), 'builder');
          f.advance(8);
          const updatedWhileHidden = {...f.inspect(), hash: f.pixelHash()};
          visibility(false, true);
          f.advance();
          const shown = {...f.inspect(), hash: f.pixelHash()};
          f.advance(8);
          const resumed = {...f.click('builder'), hash: f.pixelHash()};
          f.dispose();
          return {
            kind,
            before,
            moving,
            hidden,
            updatedWhileHidden,
            shown,
            resumed,
            observersAfterDispose: observers.size,
            disposed: f.inspect(),
          };
        }
        try {
          const result = [];
          for (const kind of ['factory', 'factory-2d', 'year1998'])
            result.push(
              kind === 'factory-2d'
                ? await f.withContexts('null', () => sample(kind))
                : await sample(kind),
            );
          return result;
        } finally {
          f.dispose();
          window.IntersectionObserver = NativeObserver;
        }
      });
      for (const state of states) {
        assert.equal(state.before.renderer, state.kind);
        assert.deepEqual(state.resumed.errors.filter(Boolean), []);
        assert.ok(state.before.pending > 0, state.kind + ' starts motion');
        assert.notEqual(
          state.moving.hash,
          state.before.hash,
          state.kind + ' paints animation after the last entry is shown',
        );
        assert.equal(
          state.hidden.pending,
          0,
          state.kind + ' pauses when hidden',
        );
        assert.equal(state.updatedWhileHidden.pending, 0);
        assert.equal(
          state.updatedWhileHidden.hash,
          state.hidden.hash,
          state.kind + ' leaves the hidden frame unchanged',
        );
        if (state.kind !== 'factory')
          assert.equal(state.shown.data.parentStatus, 'compacting');
        assert.notEqual(
          state.shown.hash,
          state.updatedWhileHidden.hash,
          state.kind + ' paints the current snapshot when shown',
        );
        assert.ok(state.shown.pending > 0, state.kind + ' resumes motion');
        assert.notEqual(
          state.resumed.hash,
          state.shown.hash,
          state.kind + ' continues animating after becoming visible',
        );
        assert.equal(state.resumed.selections.at(-1), 'builder');
        assert.equal(state.observersAfterDispose, 0);
        assert.equal(state.disposed.pending, 0);
        assert.equal(state.disposed.activeResizers, 0);
      }
    },
  );

  await run(
    'animated factory screens and conveyors retain visible damage at explicit contacts',
    async () => {
      const state = await evaluate(async () => {
        const f = window.fixture;
        return f.withContexts('null', async () => {
          async function sample(damaged) {
            f.reset();
            f.host().setMotion(false);
            f.host().update(f.snapshot('running'), 'builder');
            await f.theme({scene: 'factory'});
            f.host().setMotion(true);
            f.advance();
            const targets = f.host().environmentTargets();
            function face(id, ratio, vertical) {
              const target = targets.find(target => {
                if (target.id !== id) return false;
                const [a, b, , d] = target.polygon;
                const width = Math.hypot(b.x - a.x, b.y - a.y);
                const height = Math.hypot(d.x - a.x, d.y - a.y);
                return (
                  Math.abs(width / height - ratio) < 0.01 &&
                  (vertical ? Math.abs(d.x - a.x) < 0.001 : d.x < a.x)
                );
              });
              if (!target) throw new Error('Missing factory surface: ' + id);
              return target;
            }
            function contact(name, target, u, v) {
              const [a, b, , d] = target.polygon;
              return {
                name,
                id: target.id,
                x: a.x + (b.x - a.x) * u + (d.x - a.x) * v,
                y: a.y + (b.y - a.y) * u + (d.y - a.y) * v,
                polygon: target.polygon,
              };
            }
            const contacts = [
              // The contact crosses the first animated text row.
              contact(
                'screen',
                face('desk:parent', Math.hypot(1.4 * 14, 1.4 * 7) / 9, true),
                0.2,
                2.5 / 9,
              ),
              // The belt contact lies on a roller and clear of the cargo.
              contact('belt', face('printer', 1.4 / 0.85, false), 0.26, 0.7),
              contact('cargo', face('printer', 1, false), 0.5, 0.5),
            ];
            const hits = damaged
              ? contacts.map(point =>
                  f.host().hitEnvironment(point.id, 'gun', 1, {
                    x: point.x,
                    y: point.y,
                  }),
                )
              : [];
            const canvas = document.querySelector('canvas');
            const bounds = canvas.getBoundingClientRect();
            const context = canvas.getContext('2d');
            function pixels(point) {
              const scaleX = canvas.width / bounds.width;
              const scaleY = canvas.height / bounds.height;
              return [
                ...context.getImageData(
                  Math.floor((point.x - bounds.left - 10) * scaleX),
                  Math.floor((point.y - bounds.top - 10) * scaleY),
                  Math.ceil(20 * scaleX),
                  Math.ceil(20 * scaleY),
                ).data,
              ];
            }
            const frames = [];
            let previous = 0;
            for (const frame of [0, 1, 8, 24, 40]) {
              f.advance(frame - previous);
              previous = frame;
              const current = f.host().environmentTargets();
              frames.push({
                frame,
                regions: contacts.map(point => ({
                  name: point.name,
                  pixels: pixels(point),
                  stableSurface: current.some(
                    target =>
                      target.id === point.id &&
                      JSON.stringify(target.polygon) ===
                        JSON.stringify(point.polygon),
                  ),
                })),
                damage: JSON.parse(f.inspect().data.environmentDamage),
              });
            }
            const result = {...f.inspect(), contacts, hits, frames};
            f.dispose();
            return result;
          }
          return {pristine: await sample(false), damaged: await sample(true)};
        });
      });
      assert.equal(state.damaged.renderer, 'factory-2d');
      assert.deepEqual(state.damaged.hits, [true, true, true]);
      assert.deepEqual(state.damaged.errors.filter(Boolean), []);
      assert.deepEqual(state.damaged.contacts, state.pristine.contacts);
      for (const name of ['screen', 'belt']) {
        const first = state.pristine.frames[0].regions.find(
          region => region.name === name,
        );
        const last = state.pristine.frames
          .at(-1)
          .regions.find(region => region.name === name);
        assert.notDeepEqual(
          first.pixels,
          last.pixels,
          name + ' visibly animates during the damage check',
        );
      }
      for (let frame = 0; frame < state.damaged.frames.length; frame++) {
        const sample = state.damaged.frames[frame];
        assert.ok(
          sample.damage.some(
            pose => pose.id === 'desk:parent' && pose.chips > 0,
          ),
        );
        assert.ok(
          sample.damage.some(pose => pose.id === 'printer' && pose.chips > 0),
        );
        for (let region = 0; region < sample.regions.length; region++) {
          const actual = sample.regions[region];
          const pristine = state.pristine.frames[frame].regions[region];
          assert.equal(
            actual.stableSurface,
            true,
            actual.name + ' keeps its contact surface at frame ' + sample.frame,
          );
          let changed = 0;
          for (let i = 0; i < actual.pixels.length; i += 4)
            if (
              Math.abs(actual.pixels[i] - pristine.pixels[i]) +
                Math.abs(actual.pixels[i + 1] - pristine.pixels[i + 1]) +
                Math.abs(actual.pixels[i + 2] - pristine.pixels[i + 2]) >
              30
            )
              changed++;
          assert.ok(
            changed >= 6,
            `${actual.name} mark remains visible at frame ${sample.frame}: ${changed} changed pixels`,
          );
        }
      }
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
    'Year1998 limits repair crews and flies them down from above the viewport',
    async () => {
      const state = await evaluate(async () => {
        const f = window.fixture;
        await f.year('running');
        f.host().setMotion(true);
        f.advance();
        const targets = [
          ...new Map(
            f
              .host()
              .environmentTargets()
              .filter(t => !t.id.startsWith('wall:'))
              .map(t => [t.id, t]),
          ).values(),
        ].slice(0, 12);
        for (const target of targets)
          f.host().hitEnvironment(target.id, 'gun', 1);
        const poses = () => JSON.parse(f.inspect().data.environmentDamage);
        const image = () => document.querySelector('canvas').toDataURL();
        const damaged = image();
        f.advance(101);
        const arrival = poses().filter(p => p.phase === 'arriving');
        f.advance(20);
        const descending = image();
        f.advance(30);
        const working = poses().filter(p => p.phase === 'repairing');
        const repairing = image();
        let peak = 0;
        for (let i = 0; i < 1200; i++) {
          f.advance();
          peak = Math.max(
            peak,
            poses().filter(p =>
              ['arriving', 'repairing', 'leaving'].includes(p.phase),
            ).length,
          );
        }
        return {
          count: targets.length,
          arrival,
          working,
          peak,
          remaining: poses(),
          images: {damaged, descending, repairing},
        };
      });
      assert.equal(state.count, 12);
      assert.equal(state.arrival.length, 3);
      assert.ok(
        state.arrival.every(p => p.botScreen[1] < 0),
        'Crews enter from above the visible canvas',
      );
      assert.equal(state.working.length, 3);
      for (const working of state.working) {
        const arrival = state.arrival.find(p => p.id === working.id);
        assert.equal(working.botPosition[0], arrival.botPosition[0]);
        assert.equal(working.botPosition[2], arrival.botPosition[2]);
        assert.ok(working.botPosition[1] < arrival.botPosition[1]);
      }
      assert.equal(state.peak, 3);
      assert.deepEqual(state.remaining, [], 'Queued repairs eventually finish');
      const output = resolve(__dirname, '../../.pi/tmp/year1998-scenes');
      mkdirSync(output, {recursive: true});
      for (const [name, image] of Object.entries(state.images)) {
        const path = join(output, 'repair-' + name + '.png');
        writeFileSync(path, Buffer.from(image.split(',')[1], 'base64'));
        report.screenshots.push(path);
      }
    },
  );

  await run(
    'Year1998 cleanup descends to the wreck and carries it upward out of view',
    async () => {
      const state = await evaluate(async () => {
        const f = window.fixture;
        await f.year('running');
        f.host().setMotion(true);
        f.advance();
        for (let i = 0; i < 4; i++) f.host().hitWithCane('parent', 1, 2.2);
        const samples = {},
          images = {};
        for (let frame = 0; frame < 220; frame++) {
          f.advance();
          const data = f.inspect().data;
          const pose = JSON.parse(data.robotDamage).parent;
          const cleanup = JSON.parse(data.robotCleanup).find(
            p => p.id === 'parent',
          );
          if (cleanup) {
            const stage =
              pose.phaseAge < 0.1
                ? 'entry'
                : pose.phaseAge >= 1 && pose.phaseAge < 1.1
                  ? 'descending'
                  : pose.phaseAge >= 2.9 && pose.phaseAge < 3
                    ? 'loading'
                    : pose.phaseAge >= 4.2 && pose.phaseAge < 4.3
                      ? 'leaving'
                      : pose.phaseAge > 5.9
                        ? 'exit'
                        : null;
            if (stage && !samples[stage]) {
              samples[stage] = cleanup;
              if (['descending', 'loading', 'leaving'].includes(stage))
                images[stage] = document.querySelector('canvas').toDataURL();
            }
          }
        }
        return {
          samples,
          images,
          final: JSON.parse(f.inspect().data.robotDamage).parent.phase,
        };
      });
      const {entry, descending, loading, leaving, exit} = state.samples;
      assert.ok(entry && descending && loading && leaving && exit);
      assert.ok(entry.screen[1] < 0);
      assert.ok(
        exit.screen[1] < -40,
        'Crane and suspended wreck clear the viewport',
      );
      assert.ok(descending.position[1] < entry.position[1]);
      assert.ok(leaving.position[1] > loading.position[1]);
      assert.ok(loading.wreckLift > 0);
      assert.ok(leaving.wreckLift > loading.wreckLift);
      for (const sample of Object.values(state.samples)) {
        assert.equal(sample.position[0], entry.position[0]);
        assert.equal(sample.position[2], entry.position[2]);
      }
      assert.equal(state.final, 'replacing');
      const output = resolve(__dirname, '../../.pi/tmp/year1998-scenes');
      mkdirSync(output, {recursive: true});
      for (const [name, image] of Object.entries(state.images)) {
        const path = join(output, 'cleanup-' + name + '.png');
        writeFileSync(path, Buffer.from(image.split(',')[1], 'base64'));
        report.screenshots.push(path);
      }
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
    'Year1998 scenes render at display resolution and remain selectable across sizes and zoom levels',
    async () => {
      const output = resolve(__dirname, '../../.pi/tmp/year1998-scenes');
      mkdirSync(output, {recursive: true});
      for (const [name, width, height, dense, zoom] of [
        ['normal', 960, 600, true, 1],
        ['all-working', 960, 600, 'working', 1],
        ['compact', 360, 260, false, 1],
        ['compact-dense', 380, 240, true, 1],
        ['zoomed', 960, 600, true, 1.5],
        ['zoomed-compact', 600, 440, true, 2.5],
      ]) {
        browser.setContentSize(width, height);
        browser.webContents.setZoomFactor(zoom);
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
                status: dense === 'working' ? 'running' : status,
              }))
            : [];
          f.host().update(snapshot, dense ? 'city-agent-4' : 'parent');
          window.dispatchEvent(new Event('resize'));
        }, dense);
        const state = await evaluate(dense => {
          const canvas = document.querySelector('canvas');
          const bounds = canvas.getBoundingClientRect();
          return {
            ...window.fixture.click(dense ? 'city-agent-4' : 'parent'),
            hash: window.fixture.pixelHash(),
            backing: [canvas.width, canvas.height],
            display: [bounds.width, bounds.height].map(value =>
              Math.round(value * window.devicePixelRatio),
            ),
          };
        }, dense);
        assert.deepEqual(
          state.backing,
          state.display,
          name + ': canvas uses every display pixel',
        );
        assert.equal(
          state.selections.at(-1),
          dense ? 'city-agent-4' : 'parent',
          name + ': displayed robot stays selectable',
        );
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
