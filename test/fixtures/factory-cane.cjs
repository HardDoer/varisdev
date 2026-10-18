/* global process, __dirname */
const assert = require('node:assert/strict');
const {mkdirSync, writeFileSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {pathToFileURL} = require('node:url');
const {app, BrowserWindow} = require('electron');
const {setTimeout: delay} = require('node:timers/promises');

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
        advance();
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
        const bufferSubData = gl.bufferSubData.bind(gl);
        gl.bufferSubData = (target, offset, data) => {
          if (bound === buffers[1]) dynamic = new Float32Array(data);
          return bufferSubData(target, offset, data);
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
          onHit: (id, direction, strength) => {
            hits.push({id, direction, strength});
            return scene.hitWithCane(id, direction, strength);
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

      function createFallback() {
        clearRoot();
        const host = document.createElement('section');
        host.className = 'fallback-units';
        host.innerHTML =
          '<div class="fallback-station parent-session"><span class="robot-glyph"></span></div>' +
          '<div class="fallback-station agent" data-unit-id="drone"><span class="robot-glyph">Drone</span></div>';
        root.append(host);
        const scene = createParentFallback(host);
        scene.update({session: {id: 'damage-session', status: 'idle'},
          agents: [{id: 'drone', status: 'running'}]}, 'parent');
        return {host, scene, dispose() {scene.dispose(); clearRoot();}};
      }
      let damageFixture;
      let damageRenderer;
      function damageState(id = 'parent') {
        const fixture = damageFixture;
        if (damageRenderer === 'webgl') {
          const state = JSON.parse(fixture.canvas.dataset.robotDamage || '{}')[id];
          const cleaners = JSON.parse(fixture.canvas.dataset.robotCleanup || '[]');
          return {...state, cleaners,
            cleanerGeometry: fixture.dynamicHash(),
            eyes: Number(fixture.canvas.dataset.parentEyes),
            corpseTransform: JSON.stringify([state?.corpseOffset, state?.rotation, state?.collapse]),
            debris: Number(fixture.canvas.dataset.robotDebris || 0),
            target: fixture.scene.caneTargets().some(target => target.id === id),
            geometry: fixture.dynamicHash()};
        }
        const element = id === 'parent'
          ? fixture.host.querySelector('.parent-fallback-robot > g:nth-child(2)')
          : fixture.host.querySelector('.agent .robot-glyph');
        return {damage: Number(element?.dataset.damage || 0),
          phase: element?.dataset.damagePhase || 'alive',
          surprise: Number(element?.dataset.damageSurprise || 0),
          flinch: Number(element?.dataset.damageFlinch || 0),
          collapse: Number(element?.dataset.damageCollapse || 0),
          visible: element?.dataset.damageVisible !== 'false',
          corpseOffset: (element?.dataset.corpseOffset || '0,0,0').split(',').map(Number),
          cleanupPhase: element?.dataset.cleanupPhase || '',
          cleaners: [...fixture.host.querySelector('.robot-cleanup-effects')?.children || []].map(node => node.outerHTML),
          cleanerGeometry: fixture.host.querySelector('.robot-cleanup-effects')?.innerHTML || '',
          eyes: Number(fixture.host.querySelector('.parent-fallback-robot')?.dataset.eyes),
          corpseTransform: element?.getAttribute('transform') || '',
          debris: fixture.host.querySelector('.robot-debris-effects')?.children.length || 0,
          target: fixture.scene.caneTargets().some(target => target.id === id),
          marks: element?.querySelector('.robot-damage-marks')?.children.length || 0,
          hatch: fixture.host.querySelector('.robot-floor-effects')?.innerHTML || '',
          geometry: element?.outerHTML || '',
          transform: element?.getAttribute('transform') || '',
          styles: [element?.style.left || '', element?.style.top || '', element?.style.rotate || ''],
          clip: element?.style.clipPath || '',
        };
      }
      function damageSnapshot(session = 'damage-session', agents = [{id: 'drone', status: 'running'}]) {
        damageFixture.scene.update({session: {id: session, status: 'idle'}, agents}, 'parent');
      }

      let visitorFixture;
      let visitorRenderer;
      let visitorData;
      const visitorId = 'visitor:visitor';
      function visitorSnapshot(status = 'idle') {
        visitorData = {
          session: {id: 'host', status},
          agents: [{id: 'drone', status: 'running'}],
          hub: {sessions: [
            {session: {id: 'host', status}},
            {session: {id: 'visitor', status: 'idle'}},
          ]},
        };
        visitorFixture.scene.update(visitorData, 'parent');
      }
      function visitorState() {
        const {scene, host, canvas} = visitorFixture;
        const element = host.querySelector('[data-visitor-id="visitor"]');
        const state = visitorRenderer === 'WebGL'
          ? JSON.parse(canvas.dataset.robotDamage || '{}')[visitorId]
          : element ? {
              damage: Number(element.dataset.damage || 0),
              phase: element.dataset.damagePhase || 'alive',
              surprise: Number(element.dataset.damageSurprise || 0),
            } : undefined;
        return {
          ...state,
          present: Boolean(state),
          target: scene.caneTargets().find(target => target.id === visitorId),
          geometry: visitorRenderer === 'WebGL'
            ? visitorFixture.dynamicHash() : element?.outerHTML,
          cleaners: visitorRenderer === 'WebGL'
            ? JSON.parse(canvas.dataset.robotCleanup || '[]').filter(item => item.id === visitorId).length
            : host.querySelector('.robot-cleanup-effects')?.children.length || 0,
          debris: visitorRenderer === 'WebGL'
            ? Number(canvas.dataset.robotDebris || 0)
            : host.querySelector('.robot-debris-effects')?.children.length || 0,
        };
      }
      function visitorSetup(renderer) {
        visitorFixture?.dispose();
        visitorRenderer = renderer;
        visitorFixture = renderer === 'WebGL' ? createWebGL() : createFallback();
        const {scene, host, canvas} = visitorFixture;
        if (!visitorFixture.cane) {
          const cane = createFactoryCane(host, {
            getTargets: () => scene.caneTargets(),
            onHit: (id, direction, strength) => scene.hitWithCane(id, direction, strength),
          });
          const dispose = visitorFixture.dispose;
          visitorFixture.cane = cane;
          visitorFixture.dispose = () => {cane.dispose(); dispose();};
        }
        visitorFixture.cane.setSession('host');
        visitorSnapshot();
        for (let index = 0; index < 1800 && !scene.caneTargets().some(target => target.id === visitorId); index++) advance();
        const initial = visitorState();
        if (!initial.target) throw new Error('Visiting robot never became a cane target');
        if (canvas) clickTarget(canvas, initial.target);
        const selections = visitorFixture.selections || [];
        const before = JSON.stringify(visitorData);
        host.querySelector('.factory-cane-holster').click();
        sweep(canvas || host, initial.target);
        const hit = visitorState();
        host.querySelector('.factory-cane-holster').click();
        return {initial, hit, selections,
          unchanged: before === JSON.stringify(visitorData)};
      }

      window.fixture = {
        visitorWebGL() {return visitorSetup('WebGL');},
        visitorFallback() {return visitorSetup('Fallback');},
        visitorSnapshot() {
          visitorSnapshot();
          return visitorState();
        },
        visitorDestroy() {
          for (let index = 0; index < 4 && visitorState().phase === 'alive'; index++)
            visitorFixture.scene.hitWithCane(visitorId, 1, 2.2);
          return {...visitorState(), rejected: !visitorFixture.scene.hitWithCane(visitorId)};
        },
        visitorCleanupAndWork() {
          advance(90);
          const cleaning = visitorState();
          visitorSnapshot('running');
          return {cleaning, busy: visitorState()};
        },
        visitorRecover() {
          for (let index = 0; index < 300 && visitorState().phase !== 'alive'; index++) advance();
          return visitorState();
        },
        visitorDepart() {
          advance(120);
          return {...visitorState(), rejected: !visitorFixture.scene.hitWithCane(visitorId)};
        },
        visitorDispose() {
          visitorFixture?.dispose();
          visitorFixture = null;
        },
        damageWebGL() {
          damageFixture?.dispose();
          damageRenderer = 'webgl';
          damageFixture = createWebGL();
          damageSnapshot();
          return damageState();
        },
        damageFallback() {
          damageFixture?.dispose();
          damageRenderer = 'fallback';
          damageFixture = createFallback();
          damageFixture.host.style.margin = '160px 0 0 70px';
          damageSnapshot();
          return damageState();
        },
        damageHit() {
          const accepted = damageFixture.scene.hitWithCane('parent', 1, 2.2);
          return {accepted, ...damageState()};
        },
        damageAdvance() {
          advance(4);
          return damageState();
        },
        damageSnapshot() {
          damageSnapshot();
          return damageState();
        },
        damageSettle() {
          advance(24);
          return damageState();
        },
        damageExplode() {
          let hits = 1;
          while (hits < 6 && damageState().phase === 'alive') {
            damageFixture.scene.hitWithCane('parent', 1, 2.2);
            hits++;
          }
          return {hits, ...damageState()};
        },
        damageExplosionFrame() {
          advance(4);
          return damageState();
        },
        damageWrecked() {
          advance(16);
          return damageState();
        },
        damageResting() {
          advance(20);
          return damageState();
        },
        damageArrive() {
          advance(30);
          return damageState();
        },
        damageArriveMid() {
          advance(20);
          return damageState();
        },
        damageLoad() {
          advance(20);
          return damageState();
        },
        damageLeave() {
          advance(24);
          return damageState();
        },
        damageCargo() {
          advance(16);
          return damageState();
        },
        damageReplacing() {
          advance(40);
          return damageState();
        },
        damageRise() {
          advance(20);
          return damageState();
        },
        damageFresh() {
          advance(80);
          return damageState();
        },
        damageCleanup() {
          damageFixture?.dispose();
          damageFixture = null;
        },
        damageLifecycle() {
          const {scene, host} = damageFixture;
          scene.hitWithCane('parent', 1, 2.2);
          scene.setMotion(false);
          const still = damageState();
          advance(8);
          const staticFrozen = damageState().geometry === still.geometry;
          damageSnapshot();
          const staticSnapshot = damageState();
          scene.hitWithCane('parent', 1, 2.2);
          scene.hitWithCane('parent', 1, 2.2);
          scene.hitWithCane('parent', 1, 2.2);
          const staticReplacement = damageState();
          scene.setMotion(true);
          for (let index = 0; index < 4; index++) scene.hitWithCane('drone', -1, 2.2);
          advance(80);
          const removedHadCleaner = damageState('drone').cleaners.length > 0;
          damageSnapshot('damage-session', []);
          const removal = {target: scene.caneTargets().some(target => target.id === 'drone'),
            debris: damageState().debris, cleaners: damageState().cleaners.length};
          for (let index = 0; index < 4; index++) scene.hitWithCane('parent', 1, 2.2);
          advance(80);
          const switchingDead = damageState().phase;
          damageSnapshot('new-session');
          const switched = damageState();
          for (let index = 0; index < 4; index++) scene.hitWithCane('parent', 1, 2.2);
          advance(80);
          const beforeMotionOff = damageState().phase;
          scene.setMotion(false);
          const motionOffReplacement = damageState();
          scene.setMotion(true);
          for (let index = 0; index < 4; index++) scene.hitWithCane('parent', 1, 2.2);
          advance(80);
          const disposingDead = damageState().phase;
          scene.dispose();
          const disposed = {targets: scene.caneTargets(), pending: callbacks.size,
            effects: host.querySelectorAll('.robot-floor-effects, .robot-debris-effects, .robot-cleanup-effects, .robot-damage-marks').length,
            diagnostics: Boolean(damageFixture.canvas?.hasAttribute('data-robot-damage') || damageFixture.canvas?.hasAttribute('data-robot-cleanup'))};
          damageFixture.dispose();
          damageFixture = null;
          return {still, staticFrozen, staticSnapshot, staticReplacement, removedHadCleaner, removal,
            switchingDead, switched, beforeMotionOff, motionOffReplacement, disposingDead, disposed};
        },
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
          const overlay = document.querySelector('.factory-cane-overlay');
          const layer = overlay.parentElement;
          const hostBounds = host.getBoundingClientRect();
          const holsterBounds = holster.getBoundingClientRect();
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
              overlayInitiallyHidden: getComputedStyle(layer).display === 'none',
              overlayOnBody: layer.parentElement === document.body,
              manualPopover: layer.getAttribute('popover') === 'manual',
            },
          };
          holster.click();
          const overlayBounds = overlay.getBoundingClientRect();
          const pickedUp = {
            equipped: host.dataset.caneEquipped,
            pressed: holster.getAttribute('aria-pressed'),
            topLayer: layer.matches(':popover-open'),
            viewport: Math.abs(overlayBounds.left) < 1 &&
              Math.abs(overlayBounds.top) < 1 &&
              Math.abs(overlayBounds.width - window.innerWidth) < 1 &&
              Math.abs(overlayBounds.height - window.innerHeight) < 1,
            fixed: getComputedStyle(layer).position === 'fixed',
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

        toolbar() {
          clearRoot();
          const toolbar = document.createElement('div');
          toolbar.id = 'application-controls';
          const menu = document.createElement('button');
          menu.textContent = 'Menu';
          toolbar.append(menu);
          const host = document.createElement('section');
          host.className = 'plain-stage';
          root.append(toolbar, host);
          const hits = [];
          const cane = createFactoryCane(host, {
            holsterContainer: toolbar,
            getTargets: () => {
              const rect = host.getBoundingClientRect();
              return [{id: 'parent', x: rect.left + 200, y: rect.top + 150, radius: 20}];
            },
            onHit: (id, direction, strength) => hits.push({id, direction, strength}),
          });
          const holster = toolbar.querySelector('.factory-cane-holster');
          const initiallyHidden = getComputedStyle(holster).display === 'none';
          cane.setSession('toolbar-session');
          const bounds = holster.getBoundingClientRect();
          const menuBounds = menu.getBoundingClientRect();
          const inline = getComputedStyle(holster).position === 'static' &&
            bounds.right <= menuBounds.left && bounds.height === 32;
          const noFloatingControls = !host.querySelector('.factory-cane-holster, .factory-cane-hint');
          pointer(holster, bounds.x + 4, bounds.y + 4, 'pointerdown');
          holster.focus();
          holster.click();
          const pickedUp = host.dataset.caneEquipped;
          const sceneBounds = host.getBoundingClientRect();
          pointer(host, sceneBounds.x + 100, sceneBounds.y + 200);
          pointer(host, sceneBounds.x + 300, sceneBounds.y + 200);
          advance();
          pointer(holster, bounds.x + 4, bounds.y + 4, 'pointerdown');
          holster.focus();
          const readyToReturn = host.dataset.caneEquipped;
          holster.click();
          const returned = host.dataset.caneEquipped;
          holster.click();
          pointer(menu, menuBounds.x + 4, menuBounds.y + 4, 'pointerdown');
          menu.focus();
          menu.click();
          const menuKeepsEquipped = host.dataset.caneEquipped;
          cane.setSession(null);
          const hiddenWithoutSession = getComputedStyle(holster).display === 'none';
          cane.dispose();
          const cleanedUp = !toolbar.querySelector('.factory-cane-holster') && toolbar.contains(menu);
          clearRoot();
          return {initiallyHidden, inline, noFloatingControls, pickedUp, hits,
            readyToReturn, returned, menuKeepsEquipped, hiddenWithoutSession, cleanedUp};
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
          advance();
          const stationaryHits = hits.length;

          hits.length = 0;
          const parentSweep = sweep(canvas, parent);
          const parentHitHash = fixture.dynamicHash();
          pointer(canvas, parentSweep.left, parentSweep.y);
          pointer(canvas, parentSweep.right, parentSweep.y);
          advance();
          const duringCooldown = hits.filter(hit => hit.id === 'parent').length;
          clock += 400;
          pointer(canvas, parentSweep.left, parentSweep.y);
          pointer(canvas, parentSweep.right, parentSweep.y);
          advance();
          const afterCooldown = hits.filter(hit => hit.id === 'parent').length;

          hits.length = 0;
          pointer(host, parentSweep.left, parentSweep.y, 'pointerleave');
          pointer(canvas, parentSweep.left, parentSweep.y);
          pointer(host, parentSweep.left, parentSweep.y, 'pointerleave');
          pointer(canvas, parentSweep.right, parentSweep.y);
          advance();
          const teleportHits = hits.length;

          hits.length = 0;
          pointer(host, parentSweep.left, parentSweep.y, 'pointerleave');
          sweep(canvas, targetById(scene, 'parent'));
          pointer(host, parentSweep.left, parentSweep.y, 'pointerleave');
          sweep(canvas, targetById(scene, 'drone'));
          const bodyHits = hits.map(hit => hit.id);
          const directions = hits.map(hit => hit.direction);
          const held = document.querySelector('.cane-held');
          const heldBounds = held.getBoundingClientRect();
          const heldVisible = {
            display: getComputedStyle(held).display,
            width: heldBounds.width,
            height: heldBounds.height,
          };

          scene.update({session: {id: 'fresh-motion-off', status: 'idle'},
            agents: [{id: 'drone', status: 'running'}]}, 'parent');
          scene.setMotion(false);
          cane.setMotion(false);
          const staticHash = fixture.dynamicHash();
          hits.length = 0;
          sweep(canvas, targetById(scene, 'parent'));
          const motionOff = {
            hits: hits.map(hit => hit.id),
            damageVisible: fixture.dynamicHash() !== staticHash,
            trail: document.querySelector('.cane-trail').getAttribute('d'),
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
          const staticDamageVisible = fixture.dynamicHash() !== still;
          const staticTargetX = targetById(scene, 'parent').x;
          advance(4);
          const noStaticRecoil = targetById(scene, 'parent').x === staticTargetX;
          scene.update({session: {id: 'fresh-recoil', status: 'idle'},
            agents: [{id: 'drone', status: 'running'}]}, 'parent');
          scene.setMotion(true);
          const baselineX = targetById(scene, 'parent').x;
          scene.hitWithCane('parent', 1, 0.35);
          const gentleDisplacement = Math.abs(targetById(scene, 'parent').x - baselineX);
          scene.hitWithCane('parent', 1, 2.2);
          const strongDisplacement = Math.abs(targetById(scene, 'parent').x - baselineX);
          const before = fixture.dynamicHash();
          const accepted = scene.hitWithCane('parent', 1);
          const after = fixture.dynamicHash();
          const invalid = scene.hitWithCane('missing', 1);
          advance(2);
          const animated = fixture.dynamicHash();
          const result = {
            targets,
            acceptedStill,
            staticDamageVisible,
            noStaticRecoil,
            accepted,
            invalid,
            changed: after !== before,
            animated: animated !== after,
            gentleDisplacement,
            strongDisplacement,
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
          const robot = container.querySelector('.parent-fallback-robot > g:nth-child(2)');
          const glyph = container.querySelector('.agent .robot-glyph');
          fallback.hitWithCane('drone', 1, 0.35);
          const gentleDisplacement = Math.abs(parseFloat(glyph.style.left));
          fallback.hitWithCane('drone', 1, 2.2);
          const strongDisplacement = Math.abs(parseFloat(glyph.style.left));
          const acceptedParent = fallback.hitWithCane('parent', -1);
          const parentStart = robot.getAttribute('transform') || '';
          const acceptedDrone = fallback.hitWithCane('drone', 1);
          const droneStart = [glyph.style.left, glyph.style.top, glyph.style.rotate];
          advance(2);
          const parentAnimated = (robot.getAttribute('transform') || '') !== parentStart;
          const droneAnimated = glyph.style.left !== droneStart[0];
          fallback.setMotion(false);
          const cleared = {
            parent: (robot.getAttribute('transform') || '').startsWith('translate(0 0) rotate(0 '),
            drone: [glyph.style.left, glyph.style.top, glyph.style.rotate].every(value => parseFloat(value) === 0),
          };
          const staticTransform = robot.getAttribute('transform');
          const acceptedStill = fallback.hitWithCane('parent', 1);
          advance(4);
          const noStaticRecoil = robot.getAttribute('transform') === staticTransform;
          const staticDamageVisible = robot.querySelector('.robot-damage-marks')?.children.length > 0;
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
            staticDamageVisible,
            noStaticRecoil,
            invalid,
            afterDispose,
            gentleDisplacement,
            strongDisplacement,
          };
        },

        async outsideSetup() {
          const fixture = createWebGL();
          window.outsideFixture = fixture;
          const panel = document.createElement('button');
          panel.id = 'outside-panel';
          panel.textContent = 'Outside panel';
          panel.style.cssText = 'position:fixed;inset:140px auto auto 280px;width:280px;height:240px;background:rgb(20,40,60);cursor:crosshair;z-index:9999';
          let clicks = 0;
          panel.addEventListener('click', () => clicks++);
          root.append(panel);
          fixture.host.querySelector('.factory-cane-holster').click();
          const parent = targetById(fixture.scene, 'parent');
          // A real opaque panel covers the entire body sweep, not just its center.
          panel.style.left = (parent.x - 120) + 'px';
          panel.style.top = (parent.y - 30) + 'px';
          const panelCoversSweep = [parent.x - 90, parent.x, parent.x + 90].every(
            x => document.elementFromPoint(x, parent.y + 64) === panel);
          pointer(panel, parent.x - 90, parent.y + 64);
          pointer(panel, parent.x + 90, parent.y + 64);
          advance();
          const panelHits = fixture.hits.length;
          // The first scene move crosses the body from the last outside sample.
          // Removing the panel must not turn that teleport into a real swing.
          pointer(panel, parent.x - 90, parent.y + 64);
          panel.hidden = true;
          pointer(fixture.canvas, parent.x + 90, parent.y + 64);
          panel.hidden = false;
          advance();
          const teleportHits = fixture.hits.length;
          const held = document.querySelector('.cane-held');
          const beforeLeave = held.getAttribute('transform');
          pointer(fixture.host, 390, 320, 'pointerleave');
          const leaveKeepsHeld = held.style.display !== 'none' &&
            held.getAttribute('transform') === beforeLeave;
          pointer(panel, 390, 320, 'pointerdown');
          panel.focus();
          clickTarget(panel, {x: 390, y: 320});
          pointer(panel, 390, 320);
          advance();
          const panelCursor = getComputedStyle(panel).cursor;
          const panelEquipped = fixture.host.dataset.caneEquipped;
          const holster = fixture.host.querySelector('.factory-cane-holster');
          const rect = holster.getBoundingClientRect();
          pointer(holster, rect.x + 10, rect.y + 10);
          advance();
          const holsterCursor = getComputedStyle(holster).cursor;
          const holsterFollow = held.getAttribute('transform').startsWith(
            'translate(' + (rect.x + 10) + ' ' + (rect.y + 10) + ')');
          pointer(panel, 390, 320);
          return {panelCoversSweep, panelHits, teleportHits, leaveKeepsHeld, panelCursor, panelEquipped,
            clicks, holsterCursor, holsterFollow};
        },
        async outsideDialog() {
          const dialog = document.createElement('dialog');
          dialog.style.cssText = 'position:fixed;inset:100px auto auto 220px;margin:0;width:400px;height:340px;border:0;padding:0;background:rgb(20,40,60)';
          root.append(dialog);
          const opened = new Promise(resolve => dialog.addEventListener('toggle', resolve, {once: true}));
          dialog.showModal();
          await opened;
          pointer(dialog, 390, 320);
          advance();
          return {open: dialog.open, topLayer: document.querySelector('.factory-cane-layer').matches(':popover-open'),
            cursor: getComputedStyle(dialog).cursor};
        },
        async outsidePopover() {
          document.querySelector('dialog').close();
          const popover = document.createElement('div');
          popover.id = 'outside-popover';
          popover.setAttribute('popover', 'manual');
          popover.style.cssText = 'position:fixed;inset:100px auto auto 220px;margin:0;width:400px;height:340px;border:0;padding:0;background:rgb(20,40,60)';
          root.append(popover);
          const opened = new Promise(resolve => popover.addEventListener('toggle', resolve, {once: true}));
          popover.showPopover();
          await opened;
          pointer(popover, 390, 320);
          advance();
          return {open: popover.matches(':popover-open'),
            cursor: getComputedStyle(popover).cursor};
        },
        outsideCleanup() {
          window.outsideFixture?.dispose();
          delete window.outsideFixture;
        },
        outsideStow() {
          const fixture = window.outsideFixture;
          const panel = document.querySelector('#outside-panel');
          const first = new MouseEvent('contextmenu', {bubbles:true, cancelable:true});
          panel.dispatchEvent(first);
          const second = new MouseEvent('contextmenu', {bubbles:true, cancelable:true});
          panel.dispatchEvent(second);
          const result = {
            firstPrevented: first.defaultPrevented,
            secondPrevented: second.defaultPrevented,
            equipped: fixture.host.dataset.caneEquipped,
            cursor: getComputedStyle(panel).cursor,
            active: document.documentElement.classList.contains('factory-cane-active'),
            hidden: getComputedStyle(document.querySelector('.factory-cane-layer')).display === 'none',
          };
          document.querySelector('#outside-popover').hidePopover();
          fixture.dispose();
          delete window.outsideFixture;
          result.cleaned = !document.querySelector('.factory-cane-layer, .factory-cane-overlay');
          return result;
        },
        viewportSetup() {
          const fixture = createWebGL();
          window.viewportFixture = fixture;
          root.style.paddingTop = '240px';
          root.style.paddingBottom = '1000px';
          window.scrollTo(0, 180);
          fixture.host.querySelector('.factory-cane-holster').click();
        },
        viewportCheck() {
          const fixture = window.viewportFixture;
          const bounds = fixture.host.getBoundingClientRect();
          const x = bounds.left + 180;
          const y = bounds.top + 230;
          pointer(fixture.canvas, x, y);
          advance();
          const held = document.querySelector('.cane-held');
          const point = new DOMPoint(0, 0).matrixTransform(held.getScreenCTM());
          const overlay = document.querySelector('.factory-cane-overlay');
          const rect = overlay.getBoundingClientRect();
          return {scroll: window.scrollY, aligned: Math.abs(point.x - x) < 1 && Math.abs(point.y - y) < 1,
            viewport: Math.abs(rect.x) < 1 && Math.abs(rect.y) < 1 &&
              Math.abs(rect.width - innerWidth) < 1 && Math.abs(rect.height - innerHeight) < 1};
        },
        viewportCleanup() {
          window.viewportFixture.dispose();
          delete window.viewportFixture;
          root.style.paddingTop = root.style.paddingBottom = '';
          window.scrollTo(0, 0);
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
          pointer(host, 100, 160);
          cane.setSession('first');
          const sameSession = host.dataset.caneEquipped;
          cane.setSession('second');
          const switched = host.dataset.caneEquipped;
          const switchCursorRestored = getComputedStyle(host).cursor !== 'none';
          holster.click();
          pointer(host, 100, 160);
          window.dispatchEvent(new Event('blur'));
          const blurred = host.dataset.caneEquipped;
          const blurCursorRestored = getComputedStyle(host).cursor !== 'none';
          holster.click();
          const bounds = host.getBoundingClientRect();
          pointer(host, bounds.left + 100, bounds.top + 160);
          advance();
          const beforeDispose = {
            equipped: host.dataset.caneEquipped,
            nodes: host.children.length,
            inScene: host.classList.contains('cane-in-scene'),
            bodyLayers: document.querySelectorAll('body > .factory-cane-layer').length,
            cursor: getComputedStyle(host).cursor,
          };
          cane.dispose();
          const disposed = {
            equipped: host.dataset.caneEquipped ?? null,
            nodes: host.children.length,
            inScene: host.classList.contains('cane-in-scene'),
            bodyLayers: document.querySelectorAll('.factory-cane-layer, .factory-cane-overlay').length,
            cursorRestored: getComputedStyle(host).cursor !== 'none',
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
            switchCursorRestored,
            blurred,
            blurCursorRestored,
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
          overlayInitiallyHidden: true,
          overlayOnBody: true,
          manualPopover: true,
        },
      });
      assert.deepEqual(result.pickedUp, {
        equipped: 'true',
        pressed: 'true',
        topLayer: true,
        viewport: true,
        fixed: true,
      });
      assert.deepEqual(result.blocked, []);
      assert.deepEqual(result.returned, ['parent']);
      assert.equal(result.escaped, 'false');
      assert.equal(result.aborts, 0, 'Escape must not reach the abort handler');
      assert.deepEqual(result.afterEscape, ['parent', 'drone']);
    },
  );

  await run(
    'toolbar holster never covers the scene and returns without reequipping',
    async () => {
      const result = await evaluate('toolbar');
      for (const key of [
        'initiallyHidden',
        'inline',
        'noFloatingControls',
        'hiddenWithoutSession',
        'cleanedUp',
      ])
        assert.equal(result[key], true, key);
      assert.equal(result.pickedUp, 'true');
      assert.equal(
        result.readyToReturn,
        'true',
        'Pointerdown/focus on the external holster must not stow early',
      );
      assert.equal(result.returned, 'false');
      assert.equal(result.menuKeepsEquipped, 'true');
      assert.equal(result.hits.length, 1);
      assert.equal(result.hits[0].id, 'parent');
      assert.equal(result.hits[0].strength, 2.2);
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
      assert.equal(result.motionOff.damageVisible, true);
      assert.equal(result.motionOff.trail, '');
      assert.equal(result.motionOff.indicator, 'parent');
    },
  );

  await run(
    'WebGL exposes body targets and bounded cane flinches',
    async () => {
      const result = await evaluate('webglRecoil');
      assert.deepEqual(result.targets.map(target => target.id).sort(), [
        'drone',
        'parent',
      ]);
      assert.ok(result.strongDisplacement > result.gentleDisplacement * 2);
      assert.equal(result.acceptedStill, true);
      assert.equal(result.staticDamageVisible, true);
      assert.equal(result.noStaticRecoil, true);
      assert.equal(result.accepted, true);
      assert.equal(result.invalid, false);
      assert.equal(result.changed, true, 'The flinch must reach GPU geometry');
      assert.equal(
        result.animated,
        true,
        'The flinch must animate over real frames',
      );
    },
  );

  await run(
    'SVG fallback exposes body targets and clears short flinches',
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
      assert.ok(result.strongDisplacement > result.gentleDisplacement * 2);
      assert.equal(result.acceptedParent, true);
      assert.equal(result.acceptedDrone, true);
      assert.notEqual(result.parentStart, '');
      assert.ok(result.droneStart.some(Boolean));
      assert.equal(result.parentAnimated, true);
      assert.equal(result.droneAnimated, true);
      assert.deepEqual(result.cleared, {parent: true, drone: true});
      assert.equal(result.acceptedStill, true);
      assert.equal(result.staticDamageVisible, true);
      assert.equal(result.noStaticRecoil, true);
      assert.equal(result.invalid, false);
      assert.deepEqual(result.afterDispose, []);
    },
  );

  for (const renderer of ['WebGL', 'Fallback']) {
    await run(
      renderer +
        ' grounded surprise, resting corpse, cleanup and replacement lifecycle',
      async () => {
        const capture = async phase => {
          if (!process.env.CANE_SCREENSHOT_DIR) return;
          const output = resolve(process.env.CANE_SCREENSHOT_DIR);
          mkdirSync(output, {recursive: true});
          writeFileSync(
            join(
              output,
              'factory-cane-' + renderer.toLowerCase() + '-' + phase + '.png',
            ),
            (await browser.webContents.capturePage()).toPNG(),
          );
        };
        try {
          const initial = await evaluate('damage' + renderer);
          assert.equal(initial.damage, 0);
          assert.equal(initial.target, true);
          const hit = await evaluate('damageHit');
          assert.equal(hit.accepted, true);
          assert.ok(hit.damage > 0 && hit.damage < 1);
          assert.notEqual(
            hit.geometry,
            initial.geometry,
            'Damage must reach rendered geometry',
          );
          assert.equal(hit.surprise, 1);
          assert.ok(hit.flinch > 0);
          assert.ok(
            hit.eyes > initial.eyes,
            'Surprise must enlarge the rendered eyes',
          );
          if (renderer === 'WebGL') {
            assert.equal(hit.offset[1], 0);
            assert.ok(hit.offset.every(value => Math.abs(value) <= 0.15));
            assert.ok(hit.rotation.every(value => Math.abs(value) <= 0.2));
          }
          const flinch = await evaluate('damageAdvance');
          assert.notEqual(
            flinch.geometry,
            hit.geometry,
            'The crouch and guard must animate',
          );
          assert.ok(flinch.flinch < hit.flinch);
          assert.equal(flinch.surprise, 1);
          await capture('grounded-surprise');
          const snapshot = await evaluate('damageSnapshot');
          assert.equal(
            snapshot.damage,
            hit.damage,
            'A normal session snapshot must not heal damage',
          );
          assert.equal(snapshot.surprise, flinch.surprise);
          const settled = await evaluate('damageSettle');
          assert.equal(settled.flinch, 0);
          assert.equal(settled.surprise, 0);
          assert.ok(
            settled.eyes < hit.eyes - 0.05 &&
              Math.abs(settled.eyes - initial.eyes) < 0.04,
            'Surprise eye widening ends while normal idle motion continues',
          );
          assert.equal(settled.damage, hit.damage);
          const dead = await evaluate('damageExplode');
          assert.equal(
            dead.hits,
            4,
            'Four strongest hits must destroy a robot',
          );
          assert.equal(dead.phase, 'exploding');
          assert.equal(dead.visible, true);
          assert.equal(dead.target, false);
          assert.ok(
            dead.debris > 0 && dead.debris <= 48,
            'Destruction emits bounded small fragments',
          );
          const rejected = await evaluate('damageHit');
          assert.equal(rejected.accepted, false);
          assert.equal(
            rejected.debris,
            dead.debris,
            'A dead robot must not explode twice',
          );
          const explosionFrame = await evaluate('damageExplosionFrame');
          assert.equal(explosionFrame.phase, 'exploding');
          assert.ok(explosionFrame.collapse > dead.collapse);
          await capture('collapse');
          const deadSnapshot = await evaluate('damageSnapshot');
          assert.equal(deadSnapshot.phase, 'exploding');
          assert.equal(deadSnapshot.target, false);
          const wreck = await evaluate('damageWrecked');
          assert.equal(wreck.phase, 'wrecked');
          assert.equal(wreck.visible, true);
          assert.equal(wreck.collapse, 1);
          assert.equal(wreck.target, false);
          const resting = await evaluate('damageResting');
          assert.equal(resting.phase, 'wrecked');
          assert.equal(
            resting.corpseTransform,
            wreck.corpseTransform,
            'The corpse rests on the floor',
          );
          assert.deepEqual(resting.corpseOffset, wreck.corpseOffset);
          assert.equal(resting.cleaners.length, 0);
          await capture('wrecked');
          const arrive = await evaluate('damageArrive');
          const cleanupPhase = state =>
            state.cleanup?.phase || state.cleanupPhase;
          assert.equal(arrive.phase, 'cleanup');
          assert.equal(cleanupPhase(arrive), 'arrive');
          assert.ok(arrive.cleaners.length > 0, 'A cleanup robot must render');
          assert.deepEqual(arrive.corpseOffset, wreck.corpseOffset);
          await capture('cleaner-arrive');
          const approaching = await evaluate('damageArriveMid');
          assert.equal(cleanupPhase(approaching), 'arrive');
          assert.notEqual(
            approaching.cleanerGeometry,
            arrive.cleanerGeometry,
            'Cleaner geometry must approach',
          );
          assert.equal(approaching.corpseTransform, wreck.corpseTransform);
          const load = await evaluate('damageLoad');
          assert.equal(cleanupPhase(load), 'load');
          assert.deepEqual(
            load.corpseOffset,
            wreck.corpseOffset,
            'Cargo stays still before grasp',
          );
          assert.equal(load.target, false);
          await capture('cleaner-loading');
          const leave = await evaluate('damageLeave');
          assert.equal(cleanupPhase(leave), 'leave');
          assert.equal(leave.visible, true);
          await capture('cleaner-leave');
          const cargo = await evaluate('damageCargo');
          assert.equal(cleanupPhase(cargo), 'leave');
          assert.notDeepEqual(cargo.corpseOffset, leave.corpseOffset);
          assert.notEqual(
            cargo.corpseTransform,
            leave.corpseTransform,
            'Rendered corpse must follow its cleaner',
          );
          assert.notEqual(cargo.cleanerGeometry, leave.cleanerGeometry);
          const cargoSnapshot = await evaluate('damageSnapshot');
          assert.equal(cargoSnapshot.phase, 'cleanup');
          assert.deepEqual(cargoSnapshot.corpseOffset, cargo.corpseOffset);
          assert.equal((await evaluate('damageHit')).accepted, false);
          await capture('cleaner-cargo');
          const replacing = await evaluate('damageReplacing');
          assert.equal(replacing.phase, 'replacing');
          assert.equal(replacing.target, false);
          assert.equal(replacing.cleaners.length, 0);
          const rising = await evaluate('damageRise');
          assert.equal(rising.phase, 'replacing');
          assert.equal(
            rising.target,
            false,
            'An emerging replacement is not yet targetable',
          );
          if (renderer === 'WebGL') {
            assert.ok(rising.door > 0);
            assert.ok(rising.lift > -3.4 && rising.lift < 0);
          } else {
            assert.notEqual(
              rising.hatch,
              '',
              'A real split floor hatch must render',
            );
            assert.notEqual(
              rising.clip,
              '',
              'The emerging replacement is floor-clipped',
            );
          }
          assert.notEqual(
            rising.geometry,
            replacing.geometry,
            'Doors and replacement must animate',
          );
          const rejectedRising = await evaluate('damageHit');
          assert.equal(rejectedRising.accepted, false);
          await capture('replacement-hatch');
          const fresh = await evaluate('damageFresh');
          assert.equal(fresh.phase, 'alive');
          assert.equal(fresh.damage, 0);
          assert.equal(fresh.target, true);
          assert.equal(fresh.debris, 0);
          if (renderer === 'WebGL') assert.equal(fresh.generation, 1);
          else assert.equal(fresh.marks, 0);
          const lifecycle = await evaluate('damageLifecycle');
          assert.ok(lifecycle.still.damage > 0);
          assert.equal(
            lifecycle.staticFrozen,
            true,
            'Motion off cannot animate transforms or effects',
          );
          assert.equal(lifecycle.staticSnapshot.damage, lifecycle.still.damage);
          assert.equal(lifecycle.staticReplacement.phase, 'alive');
          assert.equal(lifecycle.staticReplacement.damage, 0);
          assert.equal(lifecycle.staticReplacement.target, true);
          assert.equal(lifecycle.staticReplacement.debris, 0);
          assert.equal(lifecycle.removedHadCleaner, true);
          assert.deepEqual(lifecycle.removal, {
            target: false,
            debris: 0,
            cleaners: 0,
          });
          assert.equal(lifecycle.switchingDead, 'cleanup');
          assert.equal(lifecycle.switched.damage, 0);
          assert.equal(lifecycle.switched.phase, 'alive');
          assert.equal(lifecycle.switched.debris, 0);
          assert.equal(lifecycle.switched.cleaners.length, 0);
          assert.equal(lifecycle.beforeMotionOff, 'cleanup');
          assert.equal(lifecycle.motionOffReplacement.phase, 'alive');
          assert.equal(lifecycle.motionOffReplacement.damage, 0);
          assert.equal(lifecycle.motionOffReplacement.target, true);
          assert.equal(lifecycle.motionOffReplacement.debris, 0);
          assert.equal(lifecycle.motionOffReplacement.cleaners.length, 0);
          assert.equal(lifecycle.disposingDead, 'cleanup');
          assert.deepEqual(lifecycle.disposed, {
            targets: [],
            pending: 0,
            effects: 0,
            diagnostics: false,
          });
        } finally {
          await evaluate('damageCleanup');
        }
      },
    );
  }

  for (const renderer of ['WebGL', 'Fallback']) {
    await run(
      renderer + ' visitors take cane hits, recover, and leave a busy host',
      async () => {
        try {
          const {initial, hit, selections, unchanged} = await evaluate(
            'visitor' + renderer,
          );
          assert.equal(initial.phase, 'alive');
          assert.ok(initial.target);
          assert.ok(
            hit.damage > 0,
            'A real pointer wave must damage the visitor',
          );
          assert.equal(hit.surprise, 1);
          assert.notEqual(hit.geometry, initial.geometry);
          assert.deepEqual(
            selections,
            [],
            'Visitors are cane targets without selecting a local agent',
          );
          assert.equal(unchanged, true, 'Cane hits must not change sessions');
          const snapshot = await evaluate('visitorSnapshot');
          assert.equal(snapshot.damage, hit.damage);
          assert.equal(snapshot.surprise, hit.surprise);
          const dead = await evaluate('visitorDestroy');
          assert.equal(dead.phase, 'exploding');
          assert.equal(dead.target, undefined);
          assert.equal(dead.rejected, true);
          const {cleaning, busy} = await evaluate('visitorCleanupAndWork');
          assert.equal(cleaning.phase, 'cleanup');
          assert.ok(cleaning.cleaners > 0);
          assert.equal(busy.phase, 'cleanup');
          assert.equal(
            busy.present,
            true,
            'Starting work must not discard a visitor mid cleanup',
          );
          const recovered = await evaluate('visitorRecover');
          assert.equal(recovered.phase, 'alive');
          assert.equal(recovered.damage, 0);
          assert.ok(recovered.target, 'Replacement visitor becomes hittable');
          const departed = await evaluate('visitorDepart');
          assert.equal(departed.present, false);
          assert.equal(departed.target, undefined);
          assert.equal(departed.rejected, true);
          assert.equal(departed.cleaners, 0);
          assert.equal(departed.debris, 0);
        } finally {
          await evaluate('visitorDispose');
        }
      },
    );
  }

  await run(
    'held cane follows outside controls above dialogs and popovers',
    async () => {
      try {
        const result = await evaluate('outsideSetup');
        assert.deepEqual(result, {
          panelCoversSweep: true,
          panelHits: 0,
          teleportHits: 0,
          leaveKeepsHeld: true,
          panelCursor: 'none',
          panelEquipped: 'true',
          clicks: 1,
          holsterCursor: 'none',
          holsterFollow: true,
        });
        // Inspect actual compositor pixels, not z-index alone: an opaque top-layer
        // surface would cover these cane-colored shaft pixels if raising regressed.
        async function visibleAboveSurface(method) {
          const state = await evaluate(method);
          assert.equal(state.open, true);
          assert.equal(state.cursor, 'none');
          if ('topLayer' in state) assert.equal(state.topLayer, true);
          const viewport = await browser.webContents.executeJavaScript(
            '({width: innerWidth, height: innerHeight})',
          );
          let image;
          let wood = 0;
          // Native toggle and compositor painting are not driven by our fake RAF.
          for (let attempt = 0; attempt < 20 && wood <= 80; attempt++) {
            await delay(50);
            image = await browser.webContents.capturePage();
            const {width, height} = image.getSize();
            const pixels = image.toBitmap();
            // Map CSS coordinates into the captured image on scaled displays.
            const left = Math.floor((350 / viewport.width) * width);
            const right = Math.ceil((450 / viewport.width) * width);
            const top = Math.floor((210 / viewport.height) * height);
            const bottom = Math.ceil((330 / viewport.height) * height);
            wood = 0;
            for (let y = top; y < bottom; y++) {
              for (let x = left; x < right; x++) {
                const index = (y * width + x) * 4;
                const [blue, green, red] = pixels.subarray(index, index + 3);
                if (
                  red > 150 &&
                  green > 100 &&
                  green < 220 &&
                  blue < 150 &&
                  red > green
                )
                  wood++;
              }
            }
          }
          assert.ok(
            wood > 80,
            method + ': cane must paint above the opaque top-layer surface',
          );
          return image;
        }
        await visibleAboveSurface('outsideDialog');
        await visibleAboveSurface('outsidePopover');
        if (process.env.CANE_SCREENSHOT_DIR) {
          const output = resolve(process.env.CANE_SCREENSHOT_DIR);
          mkdirSync(output, {recursive: true});
          writeFileSync(
            join(output, 'factory-cane-app-layer.png'),
            (await browser.webContents.capturePage()).toPNG(),
          );
        }
        assert.deepEqual(await evaluate('outsideStow'), {
          firstPrevented: true,
          secondPrevented: false,
          equipped: 'false',
          cursor: 'crosshair',
          active: false,
          hidden: true,
          cleaned: true,
        });
      } finally {
        await evaluate('outsideCleanup');
      }
    },
  );

  await run(
    'viewport cane coordinates survive document scrolling and Electron zoom',
    async () => {
      await evaluate('viewportSetup');
      try {
        for (const zoom of [1, 1.25, 0.8]) {
          browser.webContents.setZoomFactor(zoom);
          await delay(30);
          const result = await evaluate('viewportCheck');
          assert.ok(result.scroll > 0, 'The fixture must really scroll');
          assert.equal(
            result.aligned,
            true,
            'Held origin must match client coordinates at zoom ' + zoom,
          );
          assert.equal(
            result.viewport,
            true,
            'Overlay must cover the viewport at zoom ' + zoom,
          );
        }
      } finally {
        browser.webContents.setZoomFactor(1);
        await evaluate('viewportCleanup');
      }
    },
  );

  await run(
    'session, blur, and dispose reset every cane resource',
    async () => {
      const result = await evaluate('lifecycle');
      assert.equal(result.sameSession, 'true');
      assert.equal(result.switched, 'false');
      assert.equal(result.switchCursorRestored, true);
      assert.equal(result.blurred, 'false');
      assert.equal(result.blurCursorRestored, true);
      assert.deepEqual(result.beforeDispose, {
        equipped: 'true',
        nodes: 2,
        inScene: true,
        bodyLayers: 1,
        cursor: 'none',
      });
      assert.deepEqual(result.disposed, {
        equipped: null,
        nodes: 0,
        inScene: false,
        bodyLayers: 0,
        cursorRestored: true,
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
