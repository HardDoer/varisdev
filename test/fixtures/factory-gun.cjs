/* global process, __dirname, window, document, PointerEvent, MouseEvent, KeyboardEvent, Event, URL */
const assert = require('node:assert/strict');
const {mkdirSync, writeFileSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {pathToFileURL} = require('node:url');
const {setTimeout: delay} = require('node:timers/promises');
const {app, BrowserWindow} = require('electron');

const [directory, reportPath] = process.argv.slice(2);
const screenshotDirectory = resolve(__dirname, '../../.pi/tmp/factory-gun');
const report = {cases: [], screenshots: []};
const rendererErrors = [];
let browser;

app.setPath('userData', join(directory, 'profile'));
app.setPath('sessionData', join(directory, 'session'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

function evaluate(method, ...args) {
  return browser.webContents.executeJavaScript(
    `window.fixture[${JSON.stringify(method)}](...${JSON.stringify(args)})`,
  );
}

async function run(name, fn) {
  let failure;
  try {
    await fn();
  } catch (error) {
    failure = error;
  }
  try {
    assert.deepEqual(
      await evaluate('cleanup'),
      {
        frames: 0,
        timers: 0,
        layers: 0,
        active: false,
      },
      name + ': disposal must release every scheduled effect and layer',
    );
  } catch (error) {
    failure ||= error;
  }
  report.cases.push({
    name,
    ...(failure ? {error: failure.stack || String(failure)} : {}),
  });
}

async function installFixture(moduleUrl) {
  const paintFrame = window.requestAnimationFrame.bind(window);
  let clock = 1000;
  let nextId = 0;
  const frames = new Map();
  const timers = new Map();
  Object.defineProperty(window.performance, 'now', {
    configurable: true,
    value: () => clock,
  });
  window.requestAnimationFrame = callback => {
    frames.set(++nextId, callback);
    return nextId;
  };
  window.cancelAnimationFrame = id => frames.delete(id);
  window.setTimeout = (callback, ms = 0, ...args) => {
    timers.set(++nextId, {at: clock + ms, callback, args});
    return nextId;
  };
  window.clearTimeout = id => timers.delete(id);
  window.IntersectionObserver = class {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {
      this.callback([{isIntersecting: true}]);
    }
    disconnect() {}
  };
  window.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  const {createFactoryScene} = await import(moduleUrl);
  const {createParentFallback} = await import(
    new URL('./parent-fallback.js', moduleUrl)
  );
  const {createFactoryCane} = await import(
    new URL('./factory-cane.js', moduleUrl)
  );
  const {createFactoryGun} = await import(
    new URL('./factory-gun.js', moduleUrl)
  );
  const {THEMES} = await import(new URL('./themes.js', moduleUrl));
  const root = document.querySelector('#root');
  let current;

  function advance(ms = 20) {
    const end = clock + ms;
    while (clock < end) {
      clock = Math.min(end, clock + 20);
      for (const [id, timer] of [...timers]) {
        if (timer.at > clock) continue;
        timers.delete(id);
        timer.callback(...timer.args);
      }
      const queued = [...frames];
      frames.clear();
      for (const [, callback] of queued) callback(clock);
    }
  }
  function click(element, point, extra = {}) {
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      detail: 1,
      clientX: point.x,
      clientY: point.y,
      ...extra,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }
  function move(element, point) {
    element.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        cancelable: true,
        pointerType: 'mouse',
        clientX: point.x,
        clientY: point.y,
      }),
    );
  }
  function rect(element) {
    const {x, y, width, height} = element.getBoundingClientRect();
    return {x, y, width, height};
  }
  function center(element) {
    const bounds = rect(element);
    return {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2};
  }
  function graphic(selector) {
    const element = document.querySelector(selector);
    if (!element) return {visible: false};
    const bounds = rect(element);
    const style = window.getComputedStyle(element);
    return {
      visible:
        bounds.width > 0 &&
        bounds.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) > 0,
      bounds,
      transform: element.getAttribute('transform'),
      stroke: style.stroke,
    };
  }
  function cleanup() {
    current?.dispose();
    current = null;
    root.replaceChildren();
    return {
      frames: frames.size,
      timers: timers.size,
      layers: document.querySelectorAll(
        '.factory-gun-layer, .factory-cane-layer',
      ).length,
      active:
        document.documentElement.classList.contains('factory-gun-active') ||
        document.documentElement.classList.contains('factory-cane-active'),
    };
  }
  function setup(
    renderer = 'webgl',
    themeId = 'factory',
    localHolsters = false,
  ) {
    if (current) throw new Error('Previous gun fixture was not disposed');
    const theme = THEMES.find(item => item.id === themeId);
    if (!theme) throw new Error('Unknown theme: ' + themeId);
    document.documentElement.dataset.theme = theme.id;
    document.documentElement.style.colorScheme = theme.colorScheme;
    for (const [name, value] of Object.entries(theme.colors))
      document.documentElement.style.setProperty('--' + name, value);
    root.innerHTML =
      '<nav id="application-controls" aria-label="Session actions">' +
      '<button id="panel-control">Session menu</button>' +
      '<input id="panel-field" aria-label="Session note" value="notes">' +
      '<span id="fixture-label"></span></nav>';
    const toolbar = root.querySelector('#application-controls');
    const menu = root.querySelector('#panel-control');
    const field = root.querySelector('#panel-field');
    root.querySelector('#fixture-label').textContent =
      theme.name + ' · ' + renderer + ' · Factory gun';
    const host = document.createElement('section');
    host.className =
      'factory-stage' + (renderer === 'fallback' ? ' fallback-units' : '');
    root.append(host);
    const selections = [];
    let canvas;
    let scene;
    if (renderer === 'webgl') {
      canvas = document.createElement('canvas');
      canvas.setAttribute('aria-label', 'Factory gun WebGL scene');
      host.append(canvas);
      if (!canvas.getContext('webgl'))
        throw new Error('Electron could not create a real WebGL context');
      scene = createFactoryScene(canvas, {onSelect: id => selections.push(id)});
      if (!scene) throw new Error('Factory WebGL scene did not initialize');
      scene.setPalette(theme.scenePalette);
    } else {
      host.innerHTML =
        '<button type="button" class="fallback-station parent-session" data-unit-id="parent">' +
        '<span class="robot-glyph"><i></i></span><strong>Main robot</strong></button>' +
        '<button type="button" class="fallback-station agent running" data-unit-id="drone">' +
        '<span class="robot-glyph agent robot-subagent"><i></i></span>' +
        '<strong>Drone</strong><span class="status-badge running">Running</span></button>';
      scene = createParentFallback(host);
      host.addEventListener('click', event => {
        const station = event.target.closest('.fallback-station');
        if (station) selections.push(station.dataset.unitId);
      });
    }
    scene.setMotion(false);
    const snapshot = {
      session: {id: 'gun-session', status: 'idle'},
      agents: [{id: 'drone', agentMode: 'subagent', status: 'running'}],
    };
    scene.update(snapshot, 'parent');
    const originalSnapshot = JSON.stringify(snapshot);
    const hits = [];
    const caneHits = [];
    const equips = {gun: 0, cane: 0};
    let overrideTargets = null;
    let acceptHits = true;
    const holsterContainer = localHolsters ? host : toolbar;
    const cane = createFactoryCane(host, {
      holsterContainer,
      getTargets: () => scene.caneTargets(),
      onEquip: () => {
        equips.cane++;
        gun?.stow();
      },
      onHit: (id, direction, strength) => {
        caneHits.push({id, direction, strength});
        return scene.hitWithCane(id, direction, strength);
      },
    });
    const gun = createFactoryGun(host, {
      holsterContainer,
      getTargets: () => overrideTargets ?? scene.caneTargets(),
      onEquip: () => {
        equips.gun++;
        cane.stow();
      },
      onHit: (id, direction, strength) => {
        const accepted =
          acceptHits && scene.hitWithCane(id, direction, strength);
        hits.push({id, direction, strength, accepted});
        return accepted;
      },
    });
    cane.setSession('gun-session');
    gun.setSession('gun-session');
    const holster = holsterContainer.querySelector('.factory-gun-holster');
    const caneHolster = holsterContainer.querySelector('.factory-cane-holster');
    let menuClicks = 0;
    menu.addEventListener('click', () => menuClicks++);
    function target(id) {
      const target = scene.caneTargets().find(item => item.id === id);
      if (!target) throw new Error('Missing ' + renderer + ' target: ' + id);
      return target;
    }
    function surface(id = 'parent') {
      if (canvas) return canvas;
      const point = target(id);
      const element = document.elementFromPoint(point.x, point.y);
      if (element?.closest('.fallback-station')?.dataset.unitId !== id)
        throw new Error(
          'Robot target is covered or outside its fallback station: ' + id,
        );
      return element;
    }
    function fire(id = 'parent', extra) {
      return click(surface(id), target(id), extra);
    }
    function damage(id) {
      if (canvas)
        return JSON.parse(canvas.dataset.robotDamage || '{}')[id]?.damage || 0;
      const element =
        id === 'parent'
          ? host.querySelector('.parent-fallback-robot > g:nth-child(2)')
          : host.querySelector('.agent .robot-glyph');
      return Number(element?.dataset.damage || 0);
    }
    function state() {
      return {
        equipped: host.dataset.gunEquipped ?? null,
        cane: host.dataset.caneEquipped ?? null,
        hit: host.dataset.gunHit ?? null,
        pressed: holster.getAttribute('aria-pressed'),
        frames: frames.size,
        timers: timers.size,
        impacts: document.querySelectorAll('.gun-impact').length,
        miss: Boolean(document.querySelector('.gun-impact-miss')),
        held: graphic('.gun-held'),
        tracer: graphic('.gun-tracer'),
        impact: graphic('.gun-impact'),
      };
    }
    current = {
      renderer,
      host,
      canvas,
      toolbar,
      menu,
      field,
      scene,
      gun,
      cane,
      holster,
      caneHolster,
      hits,
      caneHits,
      equips,
      selections,
      target,
      surface,
      fire,
      damage,
      state,
      menuClicks: () => menuClicks,
      unchanged: () => JSON.stringify(snapshot) === originalSnapshot,
      override: targets => {
        overrideTargets = targets;
      },
      reject: () => {
        acceptHits = false;
      },
      dispose() {
        gun.dispose();
        cane.dispose();
        scene.dispose();
      },
    };
    return current;
  }

  window.fixture = {
    cleanup,
    paint: () => new Promise(resolve => paintFrame(() => paintFrame(resolve))),
    shotState: () => current.state(),
    themes: () => THEMES.map(theme => theme.id),
    firing(renderer) {
      const f = setup(renderer);
      const targets = f.scene.caneTargets();
      f.holster.click();
      const parent = f.target('parent');
      for (const x of [parent.x - 100, parent.x, parent.x + 100]) {
        move(f.surface(), {x, y: parent.y});
        advance();
      }
      const motionHits = f.hits.length;
      const parentPrevented = f.fire('parent');
      advance(40);
      const parentShot = {damage: f.damage('parent'), ...f.state()};
      advance(200);
      const dronePrevented = f.fire('drone');
      advance(20);
      const pointerSelections = [...f.selections];
      const keyboardPrevented = f.fire('drone', {detail: 0});
      return {
        targets,
        motionHits,
        parentPrevented,
        dronePrevented,
        parentShot,
        droneDamage: f.damage('drone'),
        hits: f.hits,
        pointerSelections,
        keyboardPrevented,
        keyboardSelection: f.selections,
        unchanged: f.unchanged(),
        final: f.state(),
      };
    },
    cooldown(renderer) {
      const f = setup(renderer);
      f.holster.click();
      f.fire();
      const first = f.hits.length;
      f.fire('drone');
      advance(179);
      f.fire('drone');
      const cooling = f.hits.length;
      advance(1);
      f.fire('drone');
      const ready = f.hits.length;
      advance(180);
      const bounds = f.host.getBoundingClientRect();
      const missPoint = {x: bounds.right - 8, y: bounds.bottom - 8};
      if (
        f.scene
          .caneTargets()
          .some(
            t => Math.hypot(t.x - missPoint.x, t.y - missPoint.y) <= t.radius,
          )
      )
        throw new Error('Fixture miss point unexpectedly intersects a robot');
      const missPrevented = click(f.canvas || f.host, missPoint);
      advance(20);
      const miss = f.state();
      advance(300);
      return {
        first,
        cooling,
        ready,
        missPrevented,
        miss,
        hitsAfterMiss: f.hits.length,
        expired: f.state(),
        selections: f.selections,
      };
    },
    motionOff(renderer) {
      const f = setup(renderer);
      f.gun.setMotion(false);
      f.holster.click();
      f.fire();
      const shot = f.state();
      const before = document.querySelector('.factory-gun-overlay').innerHTML;
      advance(100);
      const frozen =
        document.querySelector('.factory-gun-overlay').innerHTML === before;
      const during = f.state();
      advance(200);
      return {
        shot,
        during,
        frozen,
        expired: f.state(),
        damage: f.damage('parent'),
      };
    },
    singleTarget() {
      const f = setup();
      const parent = f.target('parent');
      f.override([{...parent, id: 'drone', x: parent.x + 2}, parent]);
      f.holster.click();
      f.fire();
      const single = {
        hits: [...f.hits],
        parent: f.damage('parent'),
        drone: f.damage('drone'),
      };
      advance(180);
      f.reject();
      f.fire();
      const rejected = f.state();
      advance(180);
      const bounds = f.host.getBoundingClientRect();
      const outside = {
        id: 'parent',
        x: bounds.left - 2,
        y: parent.y,
        radius: 1000,
      };
      f.override([outside]);
      f.fire();
      return {
        single,
        rejected,
        afterOutside: f.hits.length,
        outside: f.state(),
      };
    },
    controls() {
      const f = setup();
      f.fire();
      const initialSelection = [...f.selections];
      f.selections.length = 0;
      f.holster.click();
      const parent = f.target('parent');
      const panel = document.createElement('button');
      panel.id = 'cover-panel';
      panel.textContent = 'Panel action';
      panel.style.left = parent.x - 50 + 'px';
      panel.style.top = parent.y - 36 + 'px';
      root.append(panel);
      let panelClicks = 0;
      panel.addEventListener('click', () => panelClicks++);
      const panelCoversRobot =
        document.elementFromPoint(parent.x, parent.y) === panel;
      const panelPrevented = click(panel, parent);
      const menuPrevented = click(f.menu, center(f.menu));
      f.field.focus();
      f.field.value = 'edited';
      f.field.dispatchEvent(new Event('input', {bubbles: true}));
      const unaffected = {
        panelClicks,
        menuClicks: f.menuClicks(),
        field: f.field.value,
        focused: document.activeElement === f.field,
        equipped: f.state().equipped,
        hits: f.hits.length,
        selections: [...f.selections],
      };
      panel.remove();
      f.fire();
      const equippedSelection = [...f.selections];
      f.holster.click();
      f.fire('drone');
      return {
        initialSelection,
        panelCoversRobot,
        panelPrevented,
        menuPrevented,
        unaffected,
        equippedSelection,
        restoredSelection: f.selections,
        holsterOutsideScene: !f.host.contains(f.holster),
        overlayTransparent:
          window.getComputedStyle(
            document.querySelector('.factory-gun-overlay'),
          ).pointerEvents === 'none',
      };
    },
    switching(localHolsters) {
      const f = setup('webgl', 'factory', localHolsters);
      function equipControl(button) {
        const point = center(button);
        move(button, point);
        button.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: point.x,
            clientY: point.y,
            pointerType: 'mouse',
          }),
        );
        button.focus();
        click(button, point);
        advance(20);
      }
      equipControl(f.caneHolster);
      const caneFirst = f.state();
      equipControl(f.holster);
      const gunNext = f.state();
      f.fire();
      const gunHit = f.state();
      equipControl(f.caneHolster);
      const caneAgain = f.state();
      advance(400);
      const parent = f.target('parent');
      const bounds = f.host.getBoundingClientRect();
      const y = Math.min(bounds.bottom - 5, parent.y + 64);
      move(f.canvas, {x: Math.max(bounds.left + 4, parent.x - 90), y});
      advance(20);
      move(f.canvas, {x: Math.min(bounds.right - 4, parent.x + 90), y});
      advance(20);
      const caneHit = f.caneHits.some(hit => hit.id === 'parent');
      equipControl(f.holster);
      const gunAgain = f.state();
      f.gun.stow();
      f.gun.stow();
      return {
        caneFirst,
        gunNext,
        gunHit,
        caneAgain,
        caneHit,
        gunAgain,
        stowed: f.state(),
        equips: f.equips,
        gunHits: f.hits.length,
      };
    },
    dismiss() {
      const f = setup();
      f.holster.click();
      f.fire();
      let escapedToApp = 0;
      const abort = () => escapedToApp++;
      document.addEventListener('keydown', abort);
      const escape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(escape);
      document.removeEventListener('keydown', abort);
      const escaped = f.state();
      f.fire('drone');
      const selectionAfterEscape = [...f.selections];
      f.holster.click();
      const right = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
      });
      f.menu.dispatchEvent(right);
      const rightStowed = f.state();
      const second = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
      });
      f.menu.dispatchEvent(second);
      return {
        escapePrevented: escape.defaultPrevented,
        escapedToApp,
        escaped,
        selectionAfterEscape,
        rightPrevented: right.defaultPrevented,
        rightStowed,
        normalContextMenu: !second.defaultPrevented,
      };
    },
    lifecycle() {
      const f = setup();
      f.holster.click();
      f.fire();
      f.gun.setSession('gun-session');
      const sameSession = f.state();
      f.gun.setSession('other-session');
      const changed = f.state();
      f.holster.click();
      advance(180);
      f.fire();
      window.dispatchEvent(new Event('blur'));
      const blurred = f.state();
      f.holster.click();
      f.gun.setSession(null);
      const missing = {
        ...f.state(),
        hidden: window.getComputedStyle(f.holster).display === 'none',
      };
      f.gun.setSession('third-session');
      return {
        sameSession,
        changed,
        blurred,
        missing,
        restored: window.getComputedStyle(f.holster).display !== 'none',
        cursorRestored: window.getComputedStyle(f.host).cursor !== 'none',
      };
    },
    disposal() {
      const f = setup();
      f.holster.click();
      f.fire();
      move(f.canvas, f.target('parent'));
      const pending = f.state();
      const holster = f.holster;
      const before = f.hits.length;
      f.gun.dispose();
      const disposed = {
        state: f.state(),
        layers: document.querySelectorAll('.factory-gun-layer').length,
        holsterRemoved: !f.toolbar.contains(holster),
        cursorRestored: window.getComputedStyle(f.host).cursor !== 'none',
      };
      holster.click();
      f.gun.setSession('disposed-session');
      f.gun.setMotion(true);
      f.gun.stow();
      f.fire('drone');
      document.dispatchEvent(
        new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}),
      );
      window.dispatchEvent(new Event('blur'));
      advance(500);
      f.gun.dispose();
      return {
        pending,
        disposed,
        extraHits: f.hits.length - before,
        selections: f.selections,
        after: f.state(),
      };
    },
    nativeSetup(renderer) {
      setup(renderer);
      return {
        holster: center(current.holster),
        target: current.target('parent'),
        menu: center(current.menu),
      };
    },
    nativeState() {
      const f = current;
      advance(40);
      const host = rect(f.host);
      const holster = rect(f.holster);
      const overlay = rect(document.querySelector('.factory-gun-overlay'));
      return {
        ...f.state(),
        hits: f.hits,
        menuClicks: f.menuClicks(),
        selections: f.selections,
        damage: f.damage('parent'),
        layout: {
          host,
          holster,
          overlay,
          viewport: {width: window.innerWidth, height: window.innerHeight},
          noPageScroll:
            document.documentElement.scrollHeight <= window.innerHeight &&
            document.documentElement.scrollWidth <= window.innerWidth,
          holsterVisible:
            holster.x >= 0 &&
            holster.y >= 0 &&
            holster.x + holster.width <= window.innerWidth &&
            holster.y + holster.height <= window.innerHeight,
        },
      };
    },
    screenshot(renderer, theme) {
      const f = setup(renderer, theme);
      f.holster.click();
      f.fire();
      advance(40);
      return {
        state: f.state(),
        damage: f.damage('parent'),
        targets: f.scene.caneTargets().length,
      };
    },
  };
}

async function capture(filename, metadata) {
  // The fake effect clock does not flush Chromium's compositor after zooming.
  browser.webContents.invalidate();
  await evaluate('paint');
  await delay(50);
  const state = await evaluate('shotState');
  assert.equal(state.held.visible, true, filename + ': held gun at capture');
  assert.equal(state.impact.visible, true, filename + ': impact at capture');
  const path = join(screenshotDirectory, filename);
  writeFileSync(path, (await browser.webContents.capturePage()).toPNG());
  report.screenshots.push({...metadata, path});
}

async function nativeClick(point) {
  const zoom = browser.webContents.getZoomFactor();
  const position = {
    x: Math.round(point.x * zoom),
    y: Math.round(point.y * zoom),
  };
  browser.webContents.sendInputEvent({type: 'mouseMove', ...position});
  browser.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...position,
  });
  browser.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    clickCount: 1,
    ...position,
  });
  await delay(30);
}

async function main() {
  await app.whenReady();
  mkdirSync(screenshotDirectory, {recursive: true});
  browser = new BrowserWindow({
    show: false,
    width: 1024,
    height: 740,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  browser.webContents.on('console-message', details => {
    if (details.level === 'error') rendererErrors.push(details.message);
  });
  await browser.loadFile(join(__dirname, 'factory-gun.html'));
  // Capturing a hidden window changes document visibility and holsters the gun.
  browser.showInactive();
  const moduleUrl = pathToFileURL(
    resolve(__dirname, '../../assets/dashboard/factory-scene.js'),
  ).href;
  await browser.webContents.executeJavaScript(
    `(${installFixture.toString()})(${JSON.stringify(moduleUrl)})`,
  );
  report.themes = await evaluate('themes');

  for (const renderer of ['webgl', 'fallback']) {
    await run(
      renderer +
        ': clicks hit robots and drones while pointer motion never fires',
      async () => {
        const result = await evaluate('firing', renderer);
        assert.deepEqual(result.targets.map(target => target.id).sort(), [
          'drone',
          'parent',
        ]);
        assert.equal(result.motionHits, 0);
        assert.equal(result.parentPrevented, true);
        assert.equal(result.dronePrevented, true);
        assert.deepEqual(
          result.hits.map(hit => hit.id),
          ['parent', 'drone'],
        );
        assert.ok(
          result.hits.every(
            hit =>
              hit.accepted &&
              hit.strength === 2 &&
              Math.abs(hit.direction) === 1,
          ),
        );
        assert.ok(result.parentShot.damage > 0);
        assert.ok(result.droneDamage > 0);
        assert.equal(result.parentShot.hit, 'parent');
        assert.equal(result.final.hit, 'drone');
        assert.equal(result.parentShot.held.visible, true);
        assert.equal(result.parentShot.tracer.visible, true);
        assert.equal(result.parentShot.impact.visible, true);
        assert.deepEqual(result.pointerSelections, []);
        assert.equal(result.keyboardPrevented, false);
        assert.deepEqual(result.keyboardSelection, ['drone']);
        assert.equal(result.unchanged, true);
      },
    );
    await run(
      renderer +
        ': cooldown applies across targets and misses expire without selection',
      async () => {
        const result = await evaluate('cooldown', renderer);
        assert.equal(result.first, 1);
        assert.equal(result.cooling, 1);
        assert.equal(result.ready, 2);
        assert.equal(result.hitsAfterMiss, 2);
        assert.equal(result.missPrevented, true);
        assert.equal(result.miss.hit, null);
        assert.equal(result.miss.miss, true);
        assert.equal(result.miss.impact.visible, true);
        assert.equal(result.expired.impacts, 0);
        assert.equal(result.expired.frames, 0);
        assert.equal(result.expired.timers, 0);
        assert.deepEqual(result.selections, []);
      },
    );
    await run(
      renderer +
        ': motion off keeps shooting and static feedback without effect frames',
      async () => {
        const result = await evaluate('motionOff', renderer);
        assert.ok(result.damage > 0);
        assert.equal(result.shot.hit, 'parent');
        assert.equal(result.shot.frames, 0);
        assert.equal(result.shot.impact.visible, true);
        assert.equal(result.frozen, true);
        assert.equal(result.during.hit, 'parent');
        assert.equal(result.expired.hit, null);
        assert.equal(result.expired.impacts, 0);
        assert.equal(result.expired.frames, 0);
        assert.equal(result.expired.timers, 0);
      },
    );
  }

  await run(
    'overlapping targets produce one hit; rejected and out of scene targets show misses',
    async () => {
      const result = await evaluate('singleTarget');
      assert.deepEqual(
        result.single.hits.map(hit => hit.id),
        ['parent'],
      );
      assert.ok(result.single.parent > 0);
      assert.equal(result.single.drone, 0);
      assert.equal(result.rejected.hit, null);
      assert.equal(result.rejected.miss, true);
      assert.equal(result.afterOutside, 2);
      assert.equal(result.outside.hit, null);
      assert.equal(result.outside.miss, true);
    },
  );
  await run(
    'scene selection is suppressed while panel buttons and text fields stay usable',
    async () => {
      const result = await evaluate('controls');
      assert.deepEqual(result.initialSelection, ['parent']);
      assert.equal(result.panelCoversRobot, true);
      assert.equal(result.panelPrevented, false);
      assert.equal(result.menuPrevented, false);
      assert.deepEqual(result.unaffected, {
        panelClicks: 1,
        menuClicks: 1,
        field: 'edited',
        focused: true,
        equipped: 'true',
        hits: 0,
        selections: [],
      });
      assert.deepEqual(result.equippedSelection, []);
      assert.deepEqual(result.restoredSelection, ['drone']);
      assert.equal(result.holsterOutsideScene, true);
      assert.equal(result.overlayTransparent, true);
    },
  );
  await run(
    'cane and gun switch from toolbar and local holsters and both remain usable',
    async () => {
      for (const localHolsters of [false, true]) {
        const result = await evaluate('switching', localHolsters);
        assert.equal(result.caneFirst.cane, 'true');
        assert.equal(result.caneFirst.equipped, 'false');
        assert.equal(result.gunNext.cane, 'false');
        assert.equal(result.gunNext.equipped, 'true');
        assert.equal(result.gunHit.hit, 'parent');
        assert.equal(result.caneAgain.cane, 'true');
        assert.equal(result.caneAgain.equipped, 'false');
        assert.equal(result.caneAgain.hit, null);
        assert.equal(result.caneHit, true);
        assert.equal(result.gunAgain.cane, 'false');
        assert.equal(result.gunAgain.equipped, 'true');
        assert.equal(result.stowed.equipped, 'false');
        assert.deepEqual(result.equips, {cane: 2, gun: 2});
        assert.equal(result.gunHits, 1);
        assert.deepEqual(await evaluate('cleanup'), {
          frames: 0,
          timers: 0,
          layers: 0,
          active: false,
        });
      }
    },
  );
  await run(
    'Escape and right click stow the gun and restore normal scene actions',
    async () => {
      const result = await evaluate('dismiss');
      assert.equal(result.escapePrevented, true);
      assert.equal(result.escapedToApp, 0);
      assert.equal(result.escaped.equipped, 'false');
      assert.equal(result.escaped.hit, null);
      assert.deepEqual(result.selectionAfterEscape, ['drone']);
      assert.equal(result.rightPrevented, true);
      assert.equal(result.rightStowed.equipped, 'false');
      assert.equal(result.normalContextMenu, true);
      for (const state of [result.escaped, result.rightStowed]) {
        assert.equal(state.frames, 0);
        assert.equal(state.timers, 0);
        assert.equal(state.impacts, 0);
      }
    },
  );
  await run(
    'session changes and window blur clear held state and pending shots',
    async () => {
      const result = await evaluate('lifecycle');
      assert.equal(result.sameSession.equipped, 'true');
      assert.equal(result.sameSession.hit, 'parent');
      for (const state of [result.changed, result.blurred, result.missing]) {
        assert.equal(state.equipped, 'false');
        assert.equal(state.hit, null);
        assert.equal(state.frames, 0);
        assert.equal(state.timers, 0);
        assert.equal(state.impacts, 0);
      }
      assert.equal(result.missing.hidden, true);
      assert.equal(result.restored, true);
      assert.equal(result.cursorRestored, true);
    },
  );
  await run(
    'dispose cancels frames and layers and detaches retained controls and listeners',
    async () => {
      const result = await evaluate('disposal');
      assert.ok(result.pending.frames > 0);
      assert.equal(result.disposed.state.equipped, null);
      assert.equal(result.disposed.state.hit, null);
      assert.equal(result.disposed.state.frames, 0);
      assert.equal(result.disposed.state.timers, 0);
      assert.equal(result.disposed.layers, 0);
      assert.equal(result.disposed.holsterRemoved, true);
      assert.equal(result.disposed.cursorRestored, true);
      assert.equal(result.extraHits, 0);
      assert.deepEqual(result.selections, ['drone']);
      assert.equal(result.after.equipped, null);
      assert.equal(result.after.frames, 0);
      assert.equal(result.after.timers, 0);
    },
  );
  await run(
    'native Electron clicks work in compact scenes at supported zoom levels',
    async () => {
      try {
        for (const renderer of ['webgl', 'fallback']) {
          for (const zoom of [1, 1.25, 0.8]) {
            browser.setContentSize(560, 430);
            browser.webContents.setZoomFactor(zoom);
            await evaluate('paint');
            const points = await evaluate('nativeSetup', renderer);
            await nativeClick(points.holster);
            await nativeClick(points.menu);
            await nativeClick(points.target);
            const result = await evaluate('nativeState');
            assert.equal(
              result.equipped,
              'true',
              renderer + ' at zoom ' + zoom,
            );
            assert.equal(result.hits.length, 1);
            assert.equal(result.hits[0].id, 'parent');
            assert.ok(result.damage > 0);
            assert.equal(result.menuClicks, 1);
            assert.deepEqual(result.selections, []);
            assert.equal(result.held.visible, true);
            assert.equal(result.impact.visible, true);
            assert.equal(result.layout.noPageScroll, true);
            assert.equal(result.layout.holsterVisible, true);
            assert.ok(
              result.layout.host.width > 350 && result.layout.host.height > 200,
            );
            const {overlay, viewport} = result.layout;
            assert.ok(Math.abs(overlay.x) < 1 && Math.abs(overlay.y) < 1);
            assert.ok(
              Math.abs(overlay.width - viewport.width) < 1 &&
                Math.abs(overlay.height - viewport.height) < 1,
            );
            await capture(
              'factory-gun-' + renderer + '-compact-zoom-' + zoom + '.png',
              {renderer, zoom, compact: true},
            );
            assert.deepEqual(await evaluate('cleanup'), {
              frames: 0,
              timers: 0,
              layers: 0,
              active: false,
            });
          }
        }
      } finally {
        browser.webContents.setZoomFactor(1);
        browser.setContentSize(1024, 700);
        // Deliver resize before the next fixture equips its pointer overlay.
        await delay(60);
      }
    },
  );
  await run(
    'every shipped theme renders the held gun, tracer and impact in WebGL and SVG',
    async () => {
      for (const renderer of ['webgl', 'fallback']) {
        for (const theme of report.themes) {
          const result = await evaluate('screenshot', renderer, theme);
          assert.equal(result.state.hit, 'parent', renderer + '/' + theme);
          assert.ok(result.damage > 0);
          assert.equal(result.targets, 2);
          assert.equal(result.state.held.visible, true);
          assert.equal(result.state.tracer.visible, true);
          assert.equal(result.state.impact.visible, true);
          await capture('factory-gun-' + theme + '-' + renderer + '-shot.png', {
            renderer,
            theme,
          });
          assert.deepEqual(await evaluate('cleanup'), {
            frames: 0,
            timers: 0,
            layers: 0,
            active: false,
          });
        }
      }
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
