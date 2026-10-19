/* global window, document, MouseEvent, Event, URL, process, __dirname, Buffer */
const assert = require('node:assert/strict');
const {mkdirSync, writeFileSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {pathToFileURL} = require('node:url');
const {app, BrowserWindow} = require('electron');

const [directory, reportPath] = process.argv.slice(2);
const report = {cases: []};
let browser;
const rendererErrors = [];
const activities = [
  'coffee',
  'jump-rope',
  'juggle',
  'dance',
  'stretch',
  'weights',
  'hula-hoop',
  'yo-yo',
  'read',
  'sweep',
  'balance',
  'paper-plane',
];
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
function finiteRendered(pose) {
  assert.equal(
    pose.finite,
    true,
    'Uploaded geometry must contain finite values',
  );
  assert.ok(pose.vertices > 1000, 'Robot geometry must reach the WebGL buffer');
  assert.ok(pose.draws > 0, 'The GPU must draw the uploaded triangles');
  assert.ok(
    pose.pixels > 1000,
    'The actual WebGL framebuffer must contain the scene',
  );
  assert.equal(pose.glError, 0);
  assert.ok(
    pose.anchor?.visible,
    'The parent label must follow a visible robot',
  );
  assert.ok(Number.isFinite(pose.anchor.x) && Number.isFinite(pose.anchor.y));
}
async function reset(id = 'alpha', status = 'idle') {
  return evaluate(({id, status}) => window.fixture.reset(id, status), {
    id,
    status,
  });
}
async function inspect() {
  return evaluate(() => window.fixture.inspect());
}
async function advance(frames = 1) {
  return evaluate(frames => window.fixture.advance(frames), frames);
}
// Production WebGL integrates at most 50ms per frame, including long rests.
const REST_MIN_FRAMES = 300;
const REST_MAX_FRAMES = 1200;
const REST_STILL_FRAMES = REST_MIN_FRAMES - 20;
async function until(mode, maximum = REST_MAX_FRAMES + 220) {
  const pose = await evaluate(
    ({mode, maximum}) => {
      let frames = 0;
      while (frames < maximum && window.fixture.mode() !== mode) {
        window.fixture.advance(1);
        frames++;
      }
      return {...window.fixture.inspect(), frames};
    },
    {mode, maximum},
  );
  assert.equal(
    pose.mode,
    mode,
    `Expected ${mode} before ${maximum} virtual frames`,
  );
  return pose;
}
async function stillRest(pose, frames = REST_STILL_FRAMES) {
  assert.equal(pose.mode, 'rest');
  assert.equal(pose.activity, '');
  await advance(frames);
  const rested = await inspect();
  finiteRendered(rested);
  assert.equal(rested.mode, 'rest', 'Rest must last at least 15 seconds');
  assert.notEqual(
    rested.hash,
    pose.hash,
    'Rest must retain gentle breathing motion',
  );
  assert.equal(
    rested.centerX,
    pose.centerX,
    'Breathing must not move the robot around the aisle',
  );
  assert.ok(rested.eyes >= 0.24, 'Resting eyes must remain visibly open');
  return rested;
}
async function restThenWalk(pose) {
  await stillRest(pose);
  const walk = await until('walk', REST_MAX_FRAMES - REST_STILL_FRAMES + 3);
  const frames = REST_STILL_FRAMES + walk.frames;
  assert.ok(
    frames >= REST_MIN_FRAMES - 1,
    'Rest must last at least 15 seconds',
  );
  assert.ok(
    frames <= REST_MAX_FRAMES + 2,
    'Rest must finish within 60 seconds',
  );
  return walk;
}

async function main() {
  await app.whenReady();
  browser = new BrowserWindow({
    show: false,
    width: 800,
    height: 520,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  browser.webContents.on('console-message', details => {
    if (details.level === 'error') rendererErrors.push(details.message);
  });
  await browser.loadFile(join(__dirname, 'parent-animation.html'));
  await evaluate(
    async moduleUrl => {
      // Drive the production scene's own queued callbacks, without waiting for
      // native RAF, timer scheduling, window visibility, or desktop occlusion.
      let clock = 1000;
      let nextFrame = 0;
      const callbacks = new Map();
      let hidden = false;
      Object.defineProperty(document, 'hidden', {get: () => hidden});
      window.requestAnimationFrame = callback => {
        callbacks.set(++nextFrame, callback);
        return nextFrame;
      };
      window.cancelAnimationFrame = id => callbacks.delete(id);
      const observers = [];
      window.IntersectionObserver = class {
        constructor(callback) {
          this.callback = callback;
          this.disconnected = false;
          observers.push(this);
        }
        observe() {
          this.callback([{isIntersecting: true}]);
        }
        disconnect() {
          this.disconnected = true;
        }
      };
      // Native resizes can arrive between evaluations. Keep resize callbacks
      // controlled too, so cleanup can be checked without races.
      const resizers = [];
      window.ResizeObserver = class {
        constructor(callback) {
          this.callback = callback;
          this.disconnected = false;
          resizers.push(this);
        }
        observe() {}
        disconnect() {
          this.disconnected = true;
        }
      };
      const canvas = document.querySelector('canvas');
      let canvasLayoutReads = 0;
      const canvasRect = canvas.getBoundingClientRect.bind(canvas);
      canvas.getBoundingClientRect = () => {
        canvasLayoutReads++;
        return canvasRect();
      };
      const gl = canvas.getContext('webgl', {preserveDrawingBuffer: true});
      if (!gl)
        throw new Error('Electron could not create a real WebGL context');
      const buffers = [];
      const deleted = new Set();
      let bound;
      let dynamic = new Float32Array();
      let draws = 0;
      let allocations = 0;
      let storageChanges = 0;
      let staticUploads = 0;
      const uploadStorage = new Map();
      const createBuffer = gl.createBuffer.bind(gl);
      gl.createBuffer = () => {
        const buffer = createBuffer();
        buffers.push(buffer);
        return buffer;
      };
      const bindBuffer = gl.bindBuffer.bind(gl);
      gl.bindBuffer = (target, buffer) => {
        bound = buffer;
        return bindBuffer(target, buffer);
      };
      const bufferData = gl.bufferData.bind(gl);
      gl.bufferData = (target, data, usage) => {
        allocations++;
        return bufferData(target, data, usage);
      };
      const bufferSubData = gl.bufferSubData.bind(gl);
      gl.bufferSubData = (target, offset, data) => {
        if (bound === buffers[0]) staticUploads++;
        if (uploadStorage.get(bound) !== data.buffer) storageChanges++;
        uploadStorage.set(bound, data.buffer);
        if (buffers.indexOf(bound) % 3 === 1) dynamic = new Float32Array(data);
        return bufferSubData(target, offset, data);
      };
      const drawArrays = gl.drawArrays.bind(gl);
      gl.drawArrays = (...args) => {
        draws++;
        return drawArrays(...args);
      };
      const deleteBuffer = gl.deleteBuffer.bind(gl);
      gl.deleteBuffer = buffer => {
        deleted.add(buffer);
        return deleteBuffer(buffer);
      };
      const {createFactoryScene} = await import(moduleUrl);
      const {idleActivityPose, drawIdleActivity} = await import(
        new URL('./parent-activities.js', moduleUrl)
      );
      const {createParentFallback} = await import(
        new URL('./parent-fallback.js', moduleUrl)
      );
      let fallback;
      let fallbackContainer;
      let scene;
      let data;
      let anchor;
      let selected;
      const create = () => {
        scene = createFactoryScene(canvas, {
          onLayout: layout => {
            anchor = layout.find(item => item.id === 'parent');
          },
          onSelect: id => {
            selected = id;
          },
        });
        if (!scene)
          throw new Error('Factory scene failed shader or GPU initialization');
      };
      create();
      const inspect = (image = false) => {
        scene.update(data, 'parent');
        let centerX = 0;
        // The first primitive in the dynamic upload is the robot's ground shadow.
        for (let i = 0; i < 1440; i += 10) centerX += dynamic[i];
        centerX /= 144;
        let hash = 2166136261;
        const bits = new Uint32Array(dynamic.buffer);
        for (const value of bits)
          hash = Math.imul(hash ^ value, 16777619) >>> 0;
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(
          0,
          0,
          canvas.width,
          canvas.height,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixels,
        );
        let visible = 0;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) visible++;
        return {
          mode: canvas.dataset.parentMode,
          activity: canvas.dataset.parentActivity,
          eyes: Number(canvas.dataset.parentEyes),
          whip: canvas.dataset.robotWhip,
          parentAway: canvas.dataset.parentAway,
          awayLabel: canvas.dataset.parentAwayLabel,
          canvasLabel: canvas.getAttribute('aria-label'),
          visitors: canvas.dataset.factoryVisitors,
          centerX,
          hash,
          anchor,
          vertices: dynamic.length / 10,
          finite: dynamic.every(Number.isFinite),
          draws,
          pixels: visible,
          glError: gl.getError(),
          pending: callbacks.size,
          image: image ? canvas.toDataURL('image/png') : undefined,
        };
      };
      window.fixture = {
        scene: () => scene,
        activityGeometry(activities) {
          const colors = Object.fromEntries(
            [
              'shell',
              'edge',
              'metal',
              'dark',
              'white',
              'dim',
              'amber',
              'cyan',
              'mint',
            ].map((name, i) => [name, [i / 10, 0.5, 0.8]]),
          );
          return activities.map(activity => {
            const samples = [0.5, 1, 2, 4.5].map(time => {
              const pose = idleActivityPose(activity, time);
              const primitives = [];
              const geometry = Object.fromEntries(
                ['box', 'cylinder', 'octagon', 'rod', 'ring'].map(method => [
                  method,
                  (...args) => primitives.push([method, ...args]),
                ]),
              );
              drawIdleActivity(
                geometry,
                geometry,
                colors,
                activity,
                time,
                pose,
              );
              const finite = value => {
                if (typeof value === 'number') return Number.isFinite(value);
                if (Array.isArray(value)) return value.every(finite);
                if (value && typeof value === 'object')
                  return Object.values(value).every(finite);
                return true;
              };
              return {
                finite: finite(pose) && finite(primitives),
                primitives: primitives.length,
                pose: JSON.stringify(pose),
                geometry: JSON.stringify(primitives),
              };
            });
            return {activity, samples};
          });
        },
        whipScenario() {
          window.fixture.reset('whip-parent', 'running');
          data.agents = [
            {id: 'working-robot', status: 'running'},
            {id: 'queued-robot', status: 'queued'},
          ];
          scene.update(data, 'parent');
          window.fixture.advance(300);
          const baseline = inspect();
          let frames = 300;
          while (!canvas.dataset.robotWhip && frames++ < 1000) {
            scene.update(data, frames % 2 ? 'parent' : 'working-robot');
            window.fixture.advance(1);
          }
          const windup = inspect();
          window.fixture.advance(14);
          const crack = inspect();
          data.agents[0].status = 'completed';
          scene.update(data, 'parent');
          const stopped = canvas.dataset.robotWhip;
          data.agents[0].status = 'running';
          scene.update(data, 'parent');
          scene.setMotion(false);
          window.fixture.advance(1000);
          const disabled = canvas.dataset.robotWhip;
          scene.setMotion(true);
          return {baseline, windup, crack, stopped, disabled, frames};
        },
        fallbackWhipScenario() {
          window.fixture.createFallback();
          fallbackContainer.style.cssText =
            'position:fixed;top:0;left:0;display:flex;width:480px;height:200px';
          const station = fallbackContainer.firstElementChild;
          station.style.cssText = 'width:240px;height:180px';
          station.querySelector('svg').style.cssText =
            'width:240px;height:180px';
          const agent = document.createElement('div');
          agent.className = 'fallback-station agent running';
          agent.dataset.unitId = 'svg-worker';
          agent.innerHTML =
            '<span class="robot-glyph" style="display:block;width:48px;height:48px;margin:60px">Robot</span>';
          agent.style.cssText = 'width:240px;height:180px';
          fallbackContainer.append(agent);
          data = {
            session: {id: 'svg-parent', status: 'running'},
            agents: [{id: 'svg-worker', status: 'running'}],
          };
          fallback.update(data, 'parent');
          let frames = 0;
          while (
            !station.querySelector('svg').dataset.robotWhip &&
            frames++ < 1100
          )
            window.fixture.advance(1);
          window.fixture.advance(14);
          const overlay = fallbackContainer.querySelector(
            '.robot-whip-overlay',
          );
          const capture = {
            target: station.querySelector('svg').dataset.robotWhip,
            paths: overlay?.children.length || 0,
            finite:
              overlay &&
              [...overlay.children].every(
                path => !/NaN|Infinity/.test(path.getAttribute('d')),
              ),
            hop: agent.querySelector('.robot-glyph').style.translate,
          };
          fallback.setMotion(false);
          capture.removed = !fallbackContainer.querySelector(
            '.robot-whip-overlay',
          );
          capture.reset =
            agent.querySelector('.robot-glyph').style.translate === '';
          window.fixture.disposeFallback();
          fallbackContainer.remove();
          return capture;
        },
        createFallback() {
          fallbackContainer = document.createElement('div');
          fallbackContainer.innerHTML =
            '<div class="fallback-station parent-session"><span class="robot-glyph"></span></div>';
          document.body.append(fallbackContainer);
          fallback = createParentFallback(fallbackContainer);
          data = {session: {id: 'svg-parent', status: 'idle'}, agents: []};
          fallback.update(data, 'parent');
        },
        fallbackMode() {
          return fallbackContainer.querySelector('svg').dataset.mode;
        },
        fallbackMotion(enabled) {
          fallback.setMotion(enabled);
        },
        fallbackPose() {
          const svg = fallbackContainer.querySelector('svg');
          const robot = svg.lastElementChild;
          const paths = [...robot.querySelectorAll('path')];
          const bounds = robot.getBBox();
          return {
            mode: svg.dataset.mode,
            activity: svg.dataset.activity,
            eyes: Number(svg.dataset.eyes),
            geometry: JSON.stringify(
              paths.map(path => [
                path.getAttribute('d'),
                path.getAttribute('fill'),
                path.getAttribute('stroke'),
                path.getAttribute('stroke-width'),
                path.style.filter,
              ]),
            ),
            paths: paths.length,
            finite: paths.every(
              path => !/NaN|Infinity/.test(path.getAttribute('d')),
            ),
            bounds: [bounds.x, bounds.y, bounds.width, bounds.height],
          };
        },
        fallbackPrompt(id = 'svg-parent') {
          fallback.prompt(id);
        },
        disposeFallback() {
          fallback.dispose();
          return {
            pending: callbacks.size,
            removed: !fallbackContainer.querySelector('svg'),
          };
        },
        reset(id, status) {
          data = {session: {id, status, activity: 'Thinking'}, agents: []};
          scene.update(data, 'parent');
          return inspect();
        },
        update(status) {
          data.session.status = status;
          scene.update(data, 'parent');
        },
        updateHub(sessions) {
          scene.updateHub({
            sessions: sessions.map(([id, status, name]) => ({
              session: {id, status, name: name || id},
            })),
          });
        },
        materialPalette() {
          const watched = {
            shell: [0.11, 0.01, 0.01],
            outline: [0.12, 0.02, 0.02],
            screen: [0.13, 0.03, 0.03],
            eyes: [0.14, 0.04, 0.04],
            running: [0.21, 0.01, 0.02],
            queued: [0.22, 0.02, 0.03],
            completed: [0.23, 0.03, 0.04],
            failed: [0.24, 0.04, 0.05],
            cancelling: [0.25, 0.05, 0.06],
            compacting: [0.26, 0.06, 0.07],
            cancelled: [0.27, 0.07, 0.08],
          };
          scene.setMotion(false);
          scene.setPalette(watched);
          const countColor = color => {
            let count = 0;
            for (let offset = 0; offset < dynamic.length; offset += 10) {
              if (
                color.every(
                  (channel, index) =>
                    Math.abs(dynamic[offset + 6 + index] - channel) < 0.00001,
                )
              )
                count++;
            }
            return count;
          };
          data = {
            session: {
              id: 'material-parent-signal',
              status: 'running',
              activity: 'Thinking',
            },
            agents: [],
          };
          scene.update(data, 'parent');
          const parentSignals = {running: countColor(watched.running)};
          data.session.status = 'compacting';
          data.session.activity = 'Compacting context';
          scene.update(data, 'parent');
          parentSignals.compacting = countColor(watched.compacting);
          data = {
            session: {id: 'material-parent', status: 'idle'},
            agents: [
              'running',
              'queued',
              'completed',
              'failed',
              'cancelling',
              'compacting',
              'cancelled',
            ].map(status => ({id: `material-${status}`, status})),
          };
          scene.update(data, 'parent');
          const counts = Object.fromEntries(
            Object.entries(watched).map(([name, color]) => [
              name,
              countColor(color),
            ]),
          );
          scene.setMotion(true);
          return {
            counts,
            parentSignals,
            finite: dynamic.every(Number.isFinite),
          };
        },
        performanceScenario() {
          data = {
            session: {id: 'performance-parent', status: 'running'},
            agents: Array.from({length: 6}, (_, index) => ({
              id: `performance-agent-${index}`,
              status: 'running',
            })),
          };
          scene.update(data, 'parent');
          const beforeBurst = draws;
          for (let index = 0; index < 40; index++) {
            data.session.activity = `Streaming ${index}`;
            scene.update(data, 'parent');
          }
          const burstDraws = draws - beforeBurst;
          const beforeFrames = draws;
          const beforeAllocations = allocations;
          const beforeStorageChanges = storageChanges;
          const beforeStaticUploads = staticUploads;
          canvasLayoutReads = 0;
          const advanceAt = (frames, hz) => {
            for (let index = 0; index < frames; index++) {
              clock += 1000 / hz;
              const queued = [...callbacks];
              callbacks.clear();
              for (const [, callback] of queued) callback(clock);
            }
          };
          advanceAt(60, 60);
          const animatedDraws = draws - beforeFrames;
          const beforeFastFrames = draws;
          advanceAt(120, 120);
          const fastDraws = draws - beforeFastFrames;
          const frameAllocations = allocations - beforeAllocations;
          const frameStorageChanges = storageChanges - beforeStorageChanges;
          const frameStaticUploads = staticUploads - beforeStaticUploads;
          const layoutReads = canvasLayoutReads;
          document.body.hidden = true;
          const beforeHidden = draws;
          scene.update(data, 'parent');
          for (let index = 0; index < 5; index++) {
            clock += 16;
            const queued = [...callbacks];
            callbacks.clear();
            for (const [, callback] of queued) callback(clock);
          }
          const hiddenDraws = draws - beforeHidden;
          const hiddenPending = callbacks.size;
          document.body.hidden = false;
          scene.update(data, 'parent');
          return {
            burstDraws,
            animatedDraws,
            fastDraws,
            frameAllocations,
            frameStorageChanges,
            frameStaticUploads,
            layoutReads,
            hiddenDraws,
            hiddenPending,
            resumedPending: callbacks.size,
          };
        },
        mode: () => canvas.dataset.parentMode,
        inspect,
        advance(frames) {
          for (let i = 0; i < frames; i++) {
            clock += 50;
            const queued = [...callbacks];
            callbacks.clear();
            for (const [, callback] of queued) callback(clock);
          }
          return {mode: canvas.dataset.parentMode, pending: callbacks.size};
        },
        visibility(value) {
          hidden = value;
          document.dispatchEvent(new Event('visibilitychange'));
        },
        intersection(value) {
          for (const observer of observers)
            if (!observer.disconnected)
              observer.callback([{isIntersecting: value}]);
        },
        click() {
          const rect = canvas.getBoundingClientRect();
          canvas.dispatchEvent(
            new MouseEvent('click', {
              clientX: rect.left + anchor.x * rect.width,
              clientY: rect.top + anchor.y * rect.height,
            }),
          );
          return selected;
        },
        cleanup() {
          const before = draws;
          scene.dispose();
          const pending = callbacks.size;
          window.fixture.advance(10);
          document.dispatchEvent(new Event('visibilitychange'));
          canvas.dispatchEvent(new MouseEvent('pointermove'));
          for (const observer of resizers) observer.callback();
          scene.update(data);
          scene.prompt(data.session.id);
          scene.setMotion(true);
          return {
            pending,
            afterPending: callbacks.size,
            drawsUnchanged: draws === before,
            buffers: buffers.length,
            deleted: deleted.size,
            disconnected: [...observers, ...resizers].every(
              item => item.disconnected,
            ),
          };
        },
      };
    },
    pathToFileURL(resolve(__dirname, '../../assets/dashboard/factory-scene.js'))
      .href,
  );

  await run(
    'initial relaxed rest breathes awake, then roaming and activities stay lively in the aisle',
    async () => {
      const home = await reset();
      finiteRendered(home);
      assert.ok(home.eyes >= 0.24, 'WebGL rest must use open, lit eyes');
      const walk = await restThenWalk(home);
      await advance(40);
      const roaming = await inspect();
      finiteRendered(roaming);
      assert.ok(
        Math.abs(roaming.centerX - home.centerX) > 1,
        'Robot must leave its home station',
      );
      assert.notEqual(roaming.hash, home.hash);
      assert.ok(
        Math.hypot(
          roaming.anchor.x - walk.anchor.x,
          roaming.anchor.y - walk.anchor.y,
        ) > 0.005,
      );
      assert.equal(await evaluate(() => window.fixture.click()), 'parent');
      await until('idle', 220);
      await advance(10);
      const first = await evaluate(() => window.fixture.inspect(true));
      await advance(10);
      const second = await inspect();
      finiteRendered(first);
      finiteRendered(second);
      assert.ok(activities.includes(first.activity));
      assert.equal(second.activity, first.activity);
      assert.notEqual(
        second.hash,
        first.hash,
        'The rendered activity must animate',
      );
      const rest = await until('rest', 160);
      assert.ok(rest.centerX >= -3 && rest.centerX <= 6.5);
      assert.ok(
        Math.abs(rest.centerX - second.centerX) < 0.000001,
        'The pause must stay at the activity location',
      );
      await restThenWalk(rest);
      if (process.env.PARENT_ANIMATION_SCREENSHOT_DIR) {
        const output = process.env.PARENT_ANIMATION_SCREENSHOT_DIR;
        mkdirSync(output, {recursive: true});
        writeFileSync(
          join(output, `${first.activity}.png`),
          Buffer.from(first.image.split(',')[1], 'base64'),
        );
      }
    },
  );

  await run(
    'every idle activity produces finite animated robot poses and prop geometry',
    async () => {
      // Exercise the shared production activity geometry separately from its
      // 12 rests. The preceding case checks its actual WebGL rendering.
      const captures = await evaluate(
        activities => window.fixture.activityGeometry(activities),
        activities,
      );
      assert.deepEqual(
        captures.map(item => item.activity),
        activities,
      );
      for (const {activity, samples} of captures) {
        assert.ok(
          samples.every(sample => sample.finite),
          `${activity} must stay finite`,
        );
        assert.ok(
          samples.every(sample => sample.primitives > 0),
          `${activity} must draw props`,
        );
        assert.ok(
          new Set(samples.map(sample => sample.pose)).size > 1,
          `${activity} must animate the robot pose`,
        );
        assert.ok(
          new Set(samples.map(sample => sample.geometry)).size > 1,
          `${activity} must animate its prop geometry`,
        );
      }
    },
  );

  await run(
    'prompt wakes aisle rest immediately, runs home, and completed work rests again',
    async () => {
      await reset('prompt-parent');
      await until('idle');
      const rest = await until('rest', 165);
      assert.ok(rest.centerX >= -3 && rest.centerX <= 6.5);
      await evaluate(() => window.fixture.scene().prompt('other-parent'));
      assert.equal((await inspect()).mode, 'rest');
      await evaluate(() => window.fixture.scene().prompt('prompt-parent'));
      assert.equal((await inspect()).mode, 'startled');
      await advance(5);
      const startled = await inspect();
      finiteRendered(startled);
      assert.ok(
        Math.abs(startled.centerX - rest.centerX) < 0.001,
        'Startle must jump before returning',
      );
      assert.notEqual(startled.hash, rest.hash);
      await evaluate(() => window.fixture.update('running'));
      const returning = await until('return');
      assert.equal(returning.activity, '');
      await advance(8);
      const closer = await inspect();
      assert.ok(
        Math.abs(closer.centerX + 6.25) < Math.abs(returning.centerX + 6.25),
      );
      const trajectory = await evaluate(() => {
        const modes = [];
        for (let i = 0; i < 180; i++) {
          window.fixture.update('running');
          window.fixture.scene().prompt('prompt-parent');
          window.fixture.advance(1);
          modes.push(window.fixture.mode());
        }
        return modes;
      });
      assert.ok(trajectory.includes('work'));
      assert.ok(
        !trajectory.includes('startled'),
        'Repeated snapshots must preserve the return',
      );
      const working = await inspect();
      finiteRendered(working);
      assert.equal(working.mode, 'work');
      assert.ok(Math.abs(working.centerX + 6.25) < 0.001);
      await evaluate(() => window.fixture.update('idle'));
      await advance();
      await stillRest(await inspect());
    },
  );

  await run(
    'session switches reset the moving robot and compacting starts work on arrival',
    async () => {
      await reset('old-parent');
      await until('idle');
      await evaluate(() => window.fixture.scene().prompt('old-parent'));
      await until('return');
      const fresh = await reset('new-parent');
      assert.equal(fresh.mode, 'rest');
      assert.equal(fresh.activity, '');
      assert.ok(Math.abs(fresh.centerX + 6.25) < 0.001);
      await evaluate(() => window.fixture.update('compacting'));
      await advance();
      assert.equal((await inspect()).mode, 'startled');
      finiteRendered(await until('work'));
    },
  );

  await run(
    'motion off freezes geometry, and reenable and prompt cancellation enter rest',
    async () => {
      await reset('motion-parent');
      await until('walk');
      await advance(40);
      await evaluate(() => window.fixture.scene().setMotion(false));
      const staticPose = await inspect();
      assert.equal(staticPose.pending, 0);
      assert.ok(Math.abs(staticPose.centerX + 6.25) < 0.001);
      assert.ok(staticPose.eyes >= 0.24);
      await advance(100);
      assert.equal(
        (await inspect()).hash,
        staticPose.hash,
        'Motion off must freeze the relaxed breathing pose',
      );
      await evaluate(() => {
        window.fixture.scene().prompt('motion-parent');
        window.fixture.update('running');
      });
      const frozen = await inspect();
      await advance(100);
      assert.equal((await inspect()).hash, frozen.hash);
      assert.equal((await inspect()).pending, 0);
      await evaluate(() => {
        window.fixture.update('idle');
        window.fixture.scene().setMotion(true);
      });
      await stillRest(await inspect());
      await evaluate(() => {
        window.fixture.scene().prompt('motion-parent');
        window.fixture.scene().cancelPrompt('motion-parent');
      });
      await until('return', 20);
      const cancelled = await until('rest', 220);
      assert.ok(Math.abs(cancelled.centerX + 6.25) < 0.001);
      await restThenWalk(cancelled);
      finiteRendered(await inspect());
    },
  );

  await run(
    'Stop cancels a return and its finite reaction works with motion off',
    async () => {
      await reset('stop-parent');
      await until('idle');
      await evaluate(() => window.fixture.scene().prompt('stop-parent'));
      await until('return');
      await evaluate(() => window.fixture.scene().startle(true));
      const stopped = await inspect();
      assert.equal(stopped.mode, 'rest');
      assert.ok(Math.abs(stopped.centerX + 6.25) < 0.001);
      await advance(25);
      const landedStop = await inspect();
      assert.equal(landedStop.mode, 'rest');
      await stillRest(landedStop, REST_STILL_FRAMES - 25);
      await evaluate(() => {
        window.fixture.scene().setMotion(false);
        window.fixture.scene().startle(true);
      });
      const start = await inspect();
      await advance(6);
      const jump = await inspect();
      finiteRendered(jump);
      assert.notEqual(jump.hash, start.hash);
      await advance(24);
      const landed = await inspect();
      assert.equal(landed.pending, 0, 'The finite Stop reaction must stop RAF');
      await advance(40);
      assert.equal((await inspect()).hash, landed.hash);
      await evaluate(() => window.fixture.scene().startle(false));
      const staticStartle = await inspect();
      assert.equal(staticStartle.pending, 0);
      await evaluate(() => window.fixture.scene().clearStartle());
      assert.notEqual((await inspect()).hash, staticStartle.hash);
    },
  );

  await run(
    'visibility and intersection suspend queued frames and resume without a time jump',
    async () => {
      await reset('visibility-parent');
      await evaluate(() => window.fixture.scene().setMotion(true));
      await until('walk');
      const before = await inspect();
      await evaluate(() => window.fixture.visibility(true));
      assert.equal((await advance(100)).pending, 0);
      assert.equal((await inspect()).hash, before.hash);
      await evaluate(() => window.fixture.visibility(false));
      await advance(1);
      assert.equal((await inspect()).hash, before.hash);
      await advance(1);
      assert.notEqual((await inspect()).hash, before.hash);
      const resumed = await inspect();
      await evaluate(() => window.fixture.intersection(false));
      assert.equal((await advance(100)).pending, 0);
      assert.equal((await inspect()).hash, resumed.hash);
      await evaluate(() => window.fixture.intersection(true));
      await advance(1);
      assert.equal((await inspect()).hash, resumed.hash);
      assert.equal((await inspect()).pending, 1);
    },
  );

  await run(
    'heavy scenes follow 60/120 Hz frames, reuse storage, coalesce updates, and pause while hidden',
    async () => {
      const result = await evaluate(() => window.fixture.performanceScenario());
      assert.equal(
        result.burstDraws,
        0,
        'snapshot bursts must wait for the already queued frame',
      );
      assert.equal(
        result.animatedDraws,
        60 * 3,
        'Every 60 Hz frame must paint',
      );
      assert.equal(result.fastDraws, 120 * 3, 'Every 120 Hz frame must paint');
      assert.equal(result.frameAllocations, 0, 'GPU capacity must be reused');
      assert.equal(
        result.frameStorageChanges,
        0,
        'CPU vertex storage must be reused',
      );
      assert.equal(
        result.frameStaticUploads,
        0,
        'Static geometry must stay on the GPU',
      );
      assert.equal(
        result.layoutReads,
        0,
        'animation frames must use ResizeObserver dimensions',
      );
      assert.equal(result.hiddenDraws, 0);
      assert.equal(result.hiddenPending, 0);
      assert.equal(result.resumedPending, 1);
    },
  );

  await run(
    'an idle parent visits another open factory, disappears locally, and runs from the remote position all the way home when prompted',
    async () => {
      const home = await reset('visit-source');
      await evaluate(() =>
        window.fixture.updateHub([
          ['visit-source', 'idle', 'Source factory'],
          ['visit-target', 'idle', 'Target factory'],
        ]),
      );
      const leaving = await evaluate(() => {
        for (let frame = 0; frame < 1500; frame++) {
          const pose = window.fixture.inspect();
          if (pose.parentAway === 'true') return {...pose, frames: frame};
          window.fixture.advance(1);
        }
        return window.fixture.inspect();
      });
      assert.equal(leaving.parentAway, 'true');
      assert.match(leaving.awayLabel, /^Visiting Target factory$/);
      assert.notEqual(leaving.centerX, home.centerX);
      const offsite = await evaluate(() => {
        for (let frame = 0; frame < 400; frame++) {
          const pose = window.fixture.inspect();
          if (pose.mode === 'away') return pose;
          window.fixture.advance(1);
        }
        return window.fixture.inspect();
      });
      assert.equal(offsite.mode, 'away', 'the local workstation must be empty');
      assert.match(offsite.canvasLabel, /Main agent: Visiting Target factory/);
      await evaluate(() => window.fixture.scene().prompt('visit-source'));
      const startled = await inspect();
      assert.equal(startled.mode, 'away');
      assert.match(startled.awayLabel, /^Startled — returning from /);
      const homecoming = await evaluate(() => {
        for (let frame = 0; frame < 180; frame++) {
          const pose = window.fixture.inspect();
          if (pose.mode === 'homecoming') return pose;
          window.fixture.advance(1);
        }
        return window.fixture.inspect();
      });
      finiteRendered(homecoming);
      assert.equal(homecoming.parentAway, 'true');
      assert.match(homecoming.awayLabel, /^Returning to own workstation$/);
      assert.ok(
        Math.abs(homecoming.centerX + 6.25) > 1,
        'the robot must enter at the loading dock instead of teleporting home',
      );
      const returned = await evaluate(() => {
        for (let frame = 0; frame < 180; frame++) {
          const pose = window.fixture.inspect();
          if (pose.parentAway === 'false') return pose;
          window.fixture.advance(1);
        }
        return window.fixture.inspect();
      });
      finiteRendered(returned);
      assert.equal(returned.parentAway, 'false');
      assert.ok(Math.abs(returned.centerX + 6.25) < 0.001);
      await evaluate(() =>
        window.fixture.updateHub([['visit-source', 'idle', 'Source factory']]),
      );
    },
  );

  await run(
    'decorative whip reaches a visible working robot and cancels when it completes',
    async () => {
      const poses = await evaluate(() => window.fixture.whipScenario());
      finiteRendered(poses.windup);
      finiteRendered(poses.crack);
      assert.equal(poses.windup.whip, 'working-robot');
      assert.equal(poses.crack.whip, 'working-robot');
      assert.ok(
        poses.crack.vertices > poses.baseline.vertices,
        'Cable and crack must reach the GPU',
      );
      assert.notEqual(poses.crack.hash, poses.windup.hash);
      assert.ok(
        Math.abs(poses.crack.centerX - poses.baseline.centerX) < 0.001,
        'The parent must stay at its station',
      );
      assert.equal(poses.stopped, '');
      assert.equal(poses.disabled, '');
    },
  );

  await run(
    'WebGL robots keep shell, outline, visor, eyes, and every status light distinct',
    async () => {
      const result = await evaluate(() => window.fixture.materialPalette());
      assert.equal(result.finite, true);
      assert.ok(result.parentSignals.running > 0);
      assert.ok(result.parentSignals.compacting > 0);
      for (const [material, count] of Object.entries(result.counts))
        assert.ok(count > 0, `${material} must reach uploaded scene geometry`);
    },
  );

  await run(
    'dispose cancels RAF, disconnects observers, and releases real GPU buffers',
    async () => {
      assert.equal((await inspect()).pending, 1);
      const cleanup = await evaluate(() => window.fixture.cleanup());
      assert.equal(cleanup.pending, 0);
      assert.equal(cleanup.afterPending, 0);
      assert.equal(cleanup.drawsUnchanged, true);
      assert.equal(cleanup.disconnected, true);
      assert.equal(cleanup.buffers, 3);
      assert.equal(cleanup.deleted, cleanup.buffers);
      assert.deepEqual(rendererErrors, []);
    },
  );

  await run(
    'SVG fallback breathes awake during aisle rest and prompt returns it home',
    async () => {
      const poses = await evaluate(() => {
        window.fixture.createFallback();
        const until = (mode, maximum) => {
          for (
            let i = 0;
            window.fixture.fallbackMode() !== mode && i < maximum;
            i++
          )
            window.fixture.advance(1);
          return window.fixture.fallbackPose();
        };
        const home = window.fixture.fallbackPose();
        window.fixture.fallbackMotion(false);
        const motionOff = window.fixture.fallbackPose();
        window.fixture.advance(100);
        const motionOffLater = window.fixture.fallbackPose();
        window.fixture.fallbackMotion(true);
        const idle = until('idle', 1420);
        window.fixture.advance(10);
        const active = window.fixture.fallbackPose();
        const rest = until('rest', 165);
        window.fixture.advance(280);
        const still = window.fixture.fallbackPose();
        window.fixture.fallbackPrompt('other-parent');
        const unrelated = window.fixture.fallbackPose();
        window.fixture.fallbackPrompt();
        const woken = window.fixture.fallbackPose();
        window.fixture.advance(5);
        const jump = window.fixture.fallbackPose();
        const returning = until('return', 20);
        const returned = until('rest', 220);
        const cleanup = window.fixture.disposeFallback();
        return {
          home,
          motionOff,
          motionOffLater,
          idle,
          active,
          rest,
          still,
          unrelated,
          woken,
          jump,
          returning,
          returned,
          cleanup,
        };
      });
      for (const pose of [
        poses.home,
        poses.active,
        poses.rest,
        poses.still,
        poses.jump,
        poses.returned,
      ]) {
        assert.equal(pose.finite, true);
        assert.ok(pose.paths > 100, 'SVG must contain the actual robot shapes');
        assert.ok(pose.bounds.every(Number.isFinite));
      }
      assert.equal(poses.home.mode, 'rest');
      assert.ok(poses.motionOff.eyes >= 0.24);
      assert.equal(
        poses.motionOffLater.geometry,
        poses.motionOff.geometry,
        'Motion off must freeze fallback breathing',
      );
      assert.equal(poses.idle.mode, 'idle');
      assert.ok(activities.includes(poses.active.activity));
      assert.equal(poses.rest.mode, 'rest');
      assert.equal(poses.still.mode, 'rest');
      assert.equal(poses.rest.activity, '');
      assert.notEqual(
        poses.rest.geometry,
        poses.home.geometry,
        'SVG pause must be away from home',
      );
      assert.notEqual(
        poses.still.geometry,
        poses.rest.geometry,
        'SVG rest must retain gentle breathing motion',
      );
      assert.ok(poses.home.eyes >= 0.24, 'SVG rest must use open, lit eyes');
      assert.ok(poses.still.eyes >= 0.24, 'SVG breathing must keep eyes open');
      assert.equal(poses.unrelated.mode, 'rest');
      assert.equal(poses.woken.mode, 'startled');
      assert.notEqual(poses.jump.geometry, poses.rest.geometry);
      assert.equal(poses.returning.mode, 'return');
      assert.equal(poses.returned.mode, 'rest');
      assert.ok(poses.returned.eyes >= 0.24);
      assert.equal(poses.cleanup.pending, 0);
      assert.equal(poses.cleanup.removed, true);
      assert.deepEqual(rendererErrors, []);
    },
  );

  await run(
    'SVG whip crosses the station layout, recoils the worker and cleans up with Motion off',
    async () => {
      const pose = await evaluate(() => window.fixture.fallbackWhipScenario());
      assert.equal(pose.target, 'svg-worker');
      assert.ok(pose.paths >= 56, 'The fallback must draw the curved cable');
      assert.equal(pose.finite, true);
      assert.notEqual(pose.hop, '0px 0px');
      assert.equal(pose.removed, true);
      assert.equal(pose.reset, true);
      assert.deepEqual(rendererErrors, []);
    },
  );
}

main()
  .catch(error => {
    report.fatal = error.stack || String(error);
  })
  .finally(() => {
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    browser?.destroy();
    app.exit(report.fatal ? 1 : 0);
  });
