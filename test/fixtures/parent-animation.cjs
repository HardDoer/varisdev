/* global window, document, MouseEvent, Event, process, __dirname, Buffer */
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
async function until(mode, maximum = 400) {
  const pose = await evaluate(
    ({mode, maximum}) => {
      for (let i = 0; i < maximum; i++) {
        if (window.fixture.mode() === mode) return window.fixture.inspect();
        window.fixture.advance(1);
      }
      return window.fixture.inspect();
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
      const gl = canvas.getContext('webgl');
      if (!gl)
        throw new Error('Electron could not create a real WebGL context');
      const buffers = [];
      const deleted = new Set();
      let bound;
      let dynamic = new Float32Array();
      let draws = 0;
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
        if (bound === buffers[1]) dynamic = new Float32Array(data);
        return bufferData(target, data, usage);
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
        reset(id, status) {
          data = {session: {id, status, activity: 'Thinking'}, agents: []};
          scene.update(data, 'parent');
          return inspect();
        },
        update(status) {
          data.session.status = status;
          scene.update(data, 'parent');
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
    'idle roaming moves GPU geometry and its clickable screen anchor',
    async () => {
      const home = await reset();
      finiteRendered(home);
      const walk = await until('walk');
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
    },
  );

  await run(
    'every idle activity renders changing finite robot and prop geometry',
    async () => {
      await reset('twelve-activities');
      const captures = await evaluate(() => {
        const captures = [];
        const seen = new Set();
        for (let i = 0; i < 6000 && seen.size < 12; i++) {
          window.fixture.advance(1);
          const activity =
            document.querySelector('canvas').dataset.parentActivity;
          if (!activity || seen.has(activity)) continue;
          seen.add(activity);
          window.fixture.advance(10);
          const first = window.fixture.inspect(true);
          window.fixture.advance(10);
          const second = window.fixture.inspect();
          captures.push({first, second});
        }
        return captures;
      });
      assert.deepEqual(
        captures.map(item => item.first.activity).sort(),
        [...activities].sort(),
      );
      for (const {first, second} of captures) {
        finiteRendered(first);
        finiteRendered(second);
        assert.equal(second.activity, first.activity);
        assert.notEqual(
          second.hash,
          first.hash,
          `${first.activity} must animate its geometry`,
        );
      }
      if (process.env.PARENT_ANIMATION_SCREENSHOT_DIR) {
        const sharp = require('sharp');
        const output = process.env.PARENT_ANIMATION_SCREENSHOT_DIR;
        mkdirSync(output, {recursive: true});
        const tiles = [];
        for (let index = 0; index < captures.length; index++) {
          const pose = captures[index].first;
          const image = Buffer.from(pose.image.split(',')[1], 'base64');
          writeFileSync(join(output, `${pose.activity}.png`), image);
          const title = Buffer.from(
            `<svg width="400" height="28"><rect width="400" height="28" fill="#101b20"/><text x="12" y="20" fill="white" font-size="16">${pose.activity}</text></svg>`,
          );
          const tile = await sharp(image)
            .resize(400, 260)
            .extend({
              top: 28,
              bottom: 0,
              left: 0,
              right: 0,
              background: '#101b20',
            })
            .composite([{input: title, top: 0, left: 0}])
            .png()
            .toBuffer();
          tiles.push({
            input: tile,
            left: (index % 3) * 400,
            top: Math.floor(index / 3) * 288,
          });
        }
        await sharp({
          create: {
            width: 1200,
            height: 1152,
            channels: 4,
            background: '#101b20',
          },
        })
          .composite(tiles)
          .png()
          .toFile(join(output, 'contact-sheet.png'));
      }
    },
  );

  await run(
    'prompt jumps in place, runs home, and repeated running snapshots do not restart it',
    async () => {
      await reset('prompt-parent');
      await until('idle');
      const idle = await inspect();
      await evaluate(() => window.fixture.scene().prompt('other-parent'));
      assert.equal((await inspect()).mode, 'idle');
      await evaluate(() => window.fixture.scene().prompt('prompt-parent'));
      assert.equal((await inspect()).mode, 'startled');
      await advance(5);
      const startled = await inspect();
      finiteRendered(startled);
      assert.ok(
        Math.abs(startled.centerX - idle.centerX) < 0.001,
        'Startle must jump before returning',
      );
      assert.notEqual(startled.hash, idle.hash);
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
      await until('idle');
      await evaluate(() => window.fixture.update('compacting'));
      assert.equal((await inspect()).mode, 'startled');
      finiteRendered(await until('work'));
    },
  );

  await run(
    'motion off freezes uploaded geometry and cancelling a prompt permits idle roaming',
    async () => {
      await reset('motion-parent');
      await until('idle');
      await evaluate(() => window.fixture.scene().setMotion(false));
      const staticPose = await inspect();
      assert.equal(staticPose.pending, 0);
      assert.ok(Math.abs(staticPose.centerX + 6.25) < 0.001);
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
      await until('idle');
      await evaluate(() => {
        window.fixture.scene().prompt('motion-parent');
        window.fixture.scene().cancelPrompt('motion-parent');
      });
      await until('return');
      await until('rest');
      await until('walk', 30);
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
      assert.equal((await inspect()).mode, 'rest');
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
