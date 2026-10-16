/* global process, __dirname */
const assert = require('node:assert/strict');
const {mkdirSync, writeFileSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {pathToFileURL} = require('node:url');
const {app, BrowserWindow} = require('electron');

const [directory, reportPath] = process.argv.slice(2);
const report = {cases: []};
const rendererErrors = [];
let browser;

app.setPath('userData', join(directory, 'profile'));
app.setPath('sessionData', join(directory, 'session'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

function evaluate(method) {
  return browser.webContents.executeJavaScript(
    `window.fixture[${JSON.stringify(method)}]()`,
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

async function main() {
  await app.whenReady();
  browser = new BrowserWindow({
    show: false,
    width: 900,
    height: 650,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  browser.webContents.on('console-message', details => {
    if (details.level === 'error') rendererErrors.push(details.message);
  });
  await browser.loadFile(join(__dirname, 'factory-cane.html'));
  await browser.webContents.executeJavaScript(
    `(async moduleUrl => {
      let clock = 1000;
      let nextFrame = 0;
      const callbacks = new Map();
      Object.defineProperty(window.performance, 'now', {
        configurable: true,
        value: () => clock,
      });
      window.requestAnimationFrame = callback => {
        callbacks.set(++nextFrame, callback);
        return nextFrame;
      };
      window.cancelAnimationFrame = id => callbacks.delete(id);
      window.IntersectionObserver = class {
        constructor(callback) {
          this.callback = callback;
          this.disconnected = false;
        }
        observe() {
          this.callback([{isIntersecting: true}]);
        }
        disconnect() {
          this.disconnected = true;
        }
      };
      window.ResizeObserver = class {
        constructor(callback) {
          this.callback = callback;
          this.disconnected = false;
        }
        observe() {}
        disconnect() {
          this.disconnected = true;
        }
      };
      const {createFactoryScene} = await import(moduleUrl);
      const {createFactoryCane} = await import(
        new URL('./factory-cane.js', moduleUrl)
      );
      const {createParentFallback} = await import(
        new URL('./parent-fallback.js', moduleUrl)
      );
      const root = document.querySelector('#root');
      let screenshotFixture;

      function advance(frames = 1) {
        for (let index = 0; index < frames; index++) {
          clock += 50;
          const queued = [...callbacks];
          callbacks.clear();
          for (const [, callback] of queued) callback(clock);
        }
      }
      function clearRoot() {
        callbacks.clear();
        root.replaceChildren();
      }
      function pointer(target, x, y, type = 'pointermove') {
        clock += 20;
        target.dispatchEvent(
          new PointerEvent(type, {
            bubbles: type !== 'pointerleave',
            cancelable: true,
            clientX: x,
            clientY: y,
            pointerType: 'mouse',
          }),
        );
      }
      function targetById(scene, id) {
        const target = scene.caneTargets().find(item => item.id === id);
        if (!target) throw new Error('Missing cane target: ' + id);
        return target;
      }
      function sweep(element, target) {
        const bounds = element.getBoundingClientRect();
        const left = Math.max(bounds.left + 4, target.x - 90);
        const right = Math.min(bounds.right - 4, target.x + 90);
        const y = Math.min(bounds.bottom - 4, target.y + 64);
        pointer(element, left, y);
        pointer(element, right, y);
        return {left, right, y};
      }
      function clickTarget(canvas, target, detail = 1) {
        canvas.dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            clientX: target.x,
            clientY: target.y,
            detail,
          }),
        );
      }
      function hashFloats(values) {
        let hash = 2166136261;
        const bits = new Uint32Array(values.buffer);
        for (const value of bits)
          hash = Math.imul(hash ^ value, 16777619) >>> 0;
        return hash;
      }
      function createWebGL() {
        clearRoot();
        const host = document.createElement('section');
        host.className = 'webgl-stage';
        const canvas = document.createElement('canvas');
        canvas.setAttribute('aria-label', 'Factory cane test scene');
        host.append(canvas);
        root.append(host);
        const gl = canvas.getContext('webgl');
        if (!gl) throw new Error('Electron could not create a real WebGL context');
        const buffers = [];
        let bound;
        let dynamic = new Float32Array();
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
        const selections = [];
        const scene = createFactoryScene(canvas, {
          onSelect: id => selections.push(id),
        });
        if (!scene) throw new Error('Factory scene failed GPU initialization');
        scene.update(
          {
            session: {id: 'cane-session', status: 'idle'},
            agents: [{id: 'drone', status: 'running'}],
          },
          'parent',
        );
        const hits = [];
        const cane = createFactoryCane(host, {
          getTargets: () => scene.caneTargets(),
          onHit: (id, direction) => {
            hits.push({id, direction});
            return scene.hitWithCane(id, direction);
          },
        });
        cane.setSession('cane-session');
        return {
          host,
          canvas,
          scene,
          cane,
          hits,
          selections,
          dynamicHash: () => hashFloats(dynamic),
          dispose() {
            cane.dispose();
            scene.dispose();
            clearRoot();
          },
        };
      }

      window.fixture = {
        screenshotHolstered() {
          screenshotFixture?.dispose();
          screenshotFixture = createWebGL();
          return screenshotFixture.scene.caneTargets();
        },
        screenshotSwing() {
          if (!screenshotFixture) screenshotFixture = createWebGL();
          screenshotFixture.host
            .querySelector('.factory-cane-holster')
            .click();
          sweep(
            screenshotFixture.canvas,
            targetById(screenshotFixture.scene, 'drone'),
          );
        },
        screenshotCleanup() {
          screenshotFixture?.dispose();
          screenshotFixture = null;
        },
        controls() {
          const fixture = createWebGL();
          const {host, canvas, scene, cane, selections} = fixture;
          const holster = host.querySelector('.factory-cane-holster');
          const overlay = host.querySelector('.factory-cane-overlay');
          const hostBounds = host.getBoundingClientRect();
          const holsterBounds = holster.getBoundingClientRect();
          const overlayBounds = overlay.getBoundingClientRect();
          const initial = {
            equipped: host.dataset.caneEquipped,
            pressed: holster.getAttribute('aria-pressed'),
            overlay: Boolean(overlay),
            styled: {
              holsterPosition: getComputedStyle(holster).position,
              holsterInside:
                holsterBounds.width > 0 &&
                holsterBounds.height > 0 &&
                holsterBounds.left >= hostBounds.left &&
                holsterBounds.top >= hostBounds.top &&
                holsterBounds.right <= hostBounds.right &&
                holsterBounds.bottom <= hostBounds.bottom,
              overlayPointerEvents: getComputedStyle(overlay).pointerEvents,
              overlayCoversScene:
                Math.abs(overlayBounds.left - hostBounds.left) < 1 &&
                Math.abs(overlayBounds.top - hostBounds.top) < 1 &&
                Math.abs(overlayBounds.width - hostBounds.width) < 1 &&
                Math.abs(overlayBounds.height - hostBounds.height) < 1,
            },
          };
          holster.click();
          const pickedUp = {
            equipped: host.dataset.caneEquipped,
            pressed: holster.getAttribute('aria-pressed'),
          };
          clickTarget(canvas, targetById(scene, 'parent'));
          const blocked = [...selections];
          holster.click();
          clickTarget(canvas, targetById(scene, 'parent'));
          const returned = [...selections];
          holster.click();
          let aborts = 0;
          const onAbort = () => aborts++;
          document.addEventListener('keydown', onAbort);
          document.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Escape',
              bubbles: true,
              cancelable: true,
            }),
          );
          document.removeEventListener('keydown', onAbort);
          const escaped = host.dataset.caneEquipped;
          clickTarget(canvas, targetById(scene, 'drone'));
          const afterEscape = [...selections];
          cane.dispose();
          scene.dispose();
          const result = {
            initial,
            pickedUp,
            blocked,
            returned,
            escaped,
            aborts,
            afterEscape,
          };
          clearRoot();
          return result;
        },

        webglSwing() {
          const fixture = createWebGL();
          const {host, canvas, scene, cane, hits} = fixture;
          let leakedPointerMoves = 0;
          canvas.addEventListener('pointermove', () => leakedPointerMoves++);
          host.querySelector('.factory-cane-holster').click();
          const targets = scene.caneTargets();
          const parent = targetById(scene, 'parent');
          const drone = targetById(scene, 'drone');
          const stationaryY = Math.min(
            canvas.getBoundingClientRect().bottom - 4,
            parent.y + 64,
          );
          pointer(canvas, parent.x, stationaryY);
          pointer(canvas, parent.x, stationaryY);
          const stationaryHits = hits.length;

          hits.length = 0;
          const parentSweep = sweep(canvas, parent);
          const parentHitHash = fixture.dynamicHash();
          pointer(canvas, parentSweep.left, parentSweep.y);
          pointer(canvas, parentSweep.right, parentSweep.y);
          const duringCooldown = hits.filter(hit => hit.id === 'parent').length;
          clock += 400;
          pointer(canvas, parentSweep.left, parentSweep.y);
          pointer(canvas, parentSweep.right, parentSweep.y);
          const afterCooldown = hits.filter(hit => hit.id === 'parent').length;

          hits.length = 0;
          pointer(host, parentSweep.left, parentSweep.y, 'pointerleave');
          pointer(canvas, parentSweep.left, parentSweep.y);
          pointer(host, parentSweep.left, parentSweep.y, 'pointerleave');
          pointer(canvas, parentSweep.right, parentSweep.y);
          const teleportHits = hits.length;

          hits.length = 0;
          pointer(host, parentSweep.left, parentSweep.y, 'pointerleave');
          sweep(canvas, targetById(scene, 'parent'));
          pointer(host, parentSweep.left, parentSweep.y, 'pointerleave');
          sweep(canvas, targetById(scene, 'drone'));
          const bodyHits = hits.map(hit => hit.id);
          const directions = hits.map(hit => hit.direction);
          const held = host.querySelector('.cane-held');
          const heldBounds = held.getBoundingClientRect();
          const heldVisible = {
            display: getComputedStyle(held).display,
            width: heldBounds.width,
            height: heldBounds.height,
          };

          scene.setMotion(false);
          cane.setMotion(false);
          const staticHash = fixture.dynamicHash();
          hits.length = 0;
          sweep(canvas, targetById(scene, 'parent'));
          const motionOff = {
            hits: hits.map(hit => hit.id),
            hashUnchanged: fixture.dynamicHash() === staticHash,
            trail: host.querySelector('.cane-trail').getAttribute('d'),
            indicator: host.dataset.caneHit,
          };
          const result = {
            targets,
            leakedPointerMoves,
            stationaryHits,
            parentHitHash,
            duringCooldown,
            afterCooldown,
            teleportHits,
            bodyHits,
            directions,
            heldVisible,
            motionOff,
          };
          fixture.dispose();
          return result;
        },

        webglRecoil() {
          const fixture = createWebGL();
          const {scene} = fixture;
          const targets = scene.caneTargets();
          scene.setMotion(false);
          const still = fixture.dynamicHash();
          const acceptedStill = scene.hitWithCane('parent', -1);
          const noStaticRecoil = fixture.dynamicHash() === still;
          scene.setMotion(true);
          const before = fixture.dynamicHash();
          const accepted = scene.hitWithCane('parent', 1);
          const after = fixture.dynamicHash();
          const invalid = scene.hitWithCane('missing', 1);
          advance(2);
          const animated = fixture.dynamicHash();
          const result = {
            targets,
            acceptedStill,
            noStaticRecoil,
            accepted,
            invalid,
            changed: after !== before,
            animated: animated !== after,
          };
          fixture.dispose();
          return result;
        },

        fallbackRecoil() {
          clearRoot();
          const container = document.createElement('section');
          container.className = 'fallback-units';
          container.innerHTML =
            '<div class="fallback-station parent-session"><span class="robot-glyph"></span></div>' +
            '<div class="fallback-station agent" data-unit-id="drone"><span class="robot-glyph">Drone</span></div>';
          root.append(container);
          const fallback = createParentFallback(container);
          fallback.update(
            {
              session: {id: 'fallback-cane', status: 'idle'},
              agents: [{id: 'drone', status: 'running'}],
            },
            'parent',
          );
          const targets = fallback.caneTargets();
          const robot = container.querySelector('.parent-fallback-robot g:last-child');
          const glyph = container.querySelector('.agent .robot-glyph');
          const acceptedParent = fallback.hitWithCane('parent', -1);
          const parentStart = robot.getAttribute('transform') || '';
          const acceptedDrone = fallback.hitWithCane('drone', 1);
          const droneStart = [glyph.style.left, glyph.style.top, glyph.style.rotate];
          advance(2);
          const parentAnimated = (robot.getAttribute('transform') || '') !== parentStart;
          const droneAnimated = glyph.style.left !== droneStart[0];
          fallback.setMotion(false);
          const cleared = {
            parent: robot.getAttribute('transform') || '',
            drone: [glyph.style.left, glyph.style.top, glyph.style.rotate],
          };
          const acceptedStill = fallback.hitWithCane('parent', 1);
          const noStaticRecoil = (robot.getAttribute('transform') || '') === '';
          const invalid = fallback.hitWithCane('missing', 1);
          fallback.dispose();
          const afterDispose = fallback.caneTargets();
          clearRoot();
          return {
            targets,
            acceptedParent,
            acceptedDrone,
            parentStart,
            droneStart,
            parentAnimated,
            droneAnimated,
            cleared,
            acceptedStill,
            noStaticRecoil,
            invalid,
            afterDispose,
          };
        },

        lifecycle() {
          clearRoot();
          const host = document.createElement('section');
          host.className = 'plain-stage';
          root.append(host);
          const cane = createFactoryCane(host);
          const holster = host.querySelector('.factory-cane-holster');
          cane.setSession('first');
          holster.click();
          cane.setSession('first');
          const sameSession = host.dataset.caneEquipped;
          cane.setSession('second');
          const switched = host.dataset.caneEquipped;
          holster.click();
          window.dispatchEvent(new Event('blur'));
          const blurred = host.dataset.caneEquipped;
          holster.click();
          const bounds = host.getBoundingClientRect();
          pointer(host, bounds.left + 100, bounds.top + 160);
          const beforeDispose = {
            equipped: host.dataset.caneEquipped,
            nodes: host.children.length,
            inScene: host.classList.contains('cane-in-scene'),
          };
          cane.dispose();
          const disposed = {
            equipped: host.dataset.caneEquipped ?? null,
            nodes: host.children.length,
            inScene: host.classList.contains('cane-in-scene'),
          };
          holster.click();
          window.dispatchEvent(new Event('blur'));
          cane.setSession('third');
          cane.setMotion(true);
          cane.dispose();
          const idempotent = host.children.length;
          clearRoot();
          return {
            sameSession,
            switched,
            blurred,
            beforeDispose,
            disposed,
            idempotent,
            pending: callbacks.size,
          };
        },
      };
    })(${JSON.stringify(
      pathToFileURL(
        resolve(__dirname, '../../assets/dashboard/factory-scene.js'),
      ).href,
    )})`,
  );

  await run(
    'pick up and return preserve intentional scene selection',
    async () => {
      const result = await evaluate('controls');
      assert.deepEqual(result.initial, {
        equipped: 'false',
        pressed: 'false',
        overlay: true,
        styled: {
          holsterPosition: 'absolute',
          holsterInside: true,
          overlayPointerEvents: 'none',
          overlayCoversScene: true,
        },
      });
      assert.deepEqual(result.pickedUp, {equipped: 'true', pressed: 'true'});
      assert.deepEqual(result.blocked, []);
      assert.deepEqual(result.returned, ['parent']);
      assert.equal(result.escaped, 'false');
      assert.equal(result.aborts, 0, 'Escape must not reach the abort handler');
      assert.deepEqual(result.afterEscape, ['parent', 'drone']);
    },
  );

  await run(
    'real pointer waves hit bodies with cooldown and never teleport across leave',
    async () => {
      const result = await evaluate('webglSwing');
      assert.deepEqual(result.targets.map(target => target.id).sort(), [
        'drone',
        'parent',
      ]);
      for (const target of result.targets) {
        assert.ok(Number.isFinite(target.x));
        assert.ok(Number.isFinite(target.y));
        assert.ok(target.radius >= 12);
      }
      assert.equal(
        result.leakedPointerMoves,
        0,
        'Equipped pointer moves must not reach the scene camera',
      );
      assert.equal(result.stationaryHits, 0, 'Hovering must not strike');
      assert.equal(result.duringCooldown, 1, 'Repeated waves must cool down');
      assert.equal(result.afterCooldown, 2, 'A cooled target can be hit again');
      assert.equal(result.teleportHits, 0, 'Reentry must begin a new sweep');
      assert.ok(result.bodyHits.includes('parent'));
      assert.ok(result.bodyHits.includes('drone'));
      assert.ok(
        result.directions.every(direction => Math.abs(direction) === 1),
      );
      assert.notEqual(result.heldVisible.display, 'none');
      assert.ok(result.heldVisible.width > 10);
      assert.ok(result.heldVisible.height > 50);
      assert.deepEqual(result.motionOff.hits, ['parent']);
      assert.equal(result.motionOff.hashUnchanged, true);
      assert.equal(result.motionOff.trail, '');
      assert.equal(result.motionOff.indicator, 'parent');
    },
  );

  await run(
    'WebGL exposes finite body targets and renders cane recoil',
    async () => {
      const result = await evaluate('webglRecoil');
      assert.deepEqual(result.targets.map(target => target.id).sort(), [
        'drone',
        'parent',
      ]);
      assert.equal(result.acceptedStill, true);
      assert.equal(result.noStaticRecoil, true);
      assert.equal(result.accepted, true);
      assert.equal(result.invalid, false);
      assert.equal(result.changed, true, 'The recoil must reach GPU geometry');
      assert.equal(
        result.animated,
        true,
        'The recoil must animate over real frames',
      );
    },
  );

  await run(
    'SVG fallback exposes body targets and cleans up recoil',
    async () => {
      const result = await evaluate('fallbackRecoil');
      assert.deepEqual(result.targets.map(target => target.id).sort(), [
        'drone',
        'parent',
      ]);
      for (const target of result.targets) {
        assert.ok(Number.isFinite(target.x));
        assert.ok(Number.isFinite(target.y));
        assert.ok(target.radius >= 18);
      }
      assert.equal(result.acceptedParent, true);
      assert.equal(result.acceptedDrone, true);
      assert.notEqual(result.parentStart, '');
      assert.ok(result.droneStart.some(Boolean));
      assert.equal(result.parentAnimated, true);
      assert.equal(result.droneAnimated, true);
      assert.deepEqual(result.cleared, {parent: '', drone: ['', '', '']});
      assert.equal(result.acceptedStill, true);
      assert.equal(result.noStaticRecoil, true);
      assert.equal(result.invalid, false);
      assert.deepEqual(result.afterDispose, []);
    },
  );

  await run(
    'session, blur, and dispose reset every cane resource',
    async () => {
      const result = await evaluate('lifecycle');
      assert.equal(result.sameSession, 'true');
      assert.equal(result.switched, 'false');
      assert.equal(result.blurred, 'false');
      assert.deepEqual(result.beforeDispose, {
        equipped: 'true',
        nodes: 3,
        inScene: true,
      });
      assert.deepEqual(result.disposed, {
        equipped: null,
        nodes: 0,
        inScene: false,
      });
      assert.equal(result.idempotent, 0);
      assert.equal(result.pending, 0);
      assert.deepEqual(rendererErrors, []);
    },
  );

  if (process.env.CANE_SCREENSHOT_DIR) {
    const output = resolve(process.env.CANE_SCREENSHOT_DIR);
    mkdirSync(output, {recursive: true});
    await evaluate('screenshotHolstered');
    const holstered = join(output, 'factory-cane-holstered.png');
    writeFileSync(holstered, (await browser.capturePage()).toPNG());
    await evaluate('screenshotSwing');
    const swinging = join(output, 'factory-cane-mid-swing.png');
    writeFileSync(swinging, (await browser.capturePage()).toPNG());
    await evaluate('screenshotCleanup');
    report.screenshots = [holstered, swinging];
  }
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
