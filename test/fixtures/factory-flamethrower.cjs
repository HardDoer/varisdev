/* global process, __dirname, window, document, PointerEvent, MouseEvent, KeyboardEvent, Event, URL, DOMParser */
const assert = require('node:assert/strict');
const {mkdirSync, readFileSync, writeFileSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {pathToFileURL} = require('node:url');
const {setTimeout: delay} = require('node:timers/promises');
const {app, BrowserWindow} = require('electron');

const [directory, reportPath] = process.argv.slice(2);
const screenshotDirectory = resolve(
  __dirname,
  '../../.pi/tmp/factory-flamethrower',
);
const report = {cases: [], screenshots: []};
const rendererErrors = [];
let browser;
app.setPath('userData', join(directory, 'profile'));
app.setPath('sessionData', join(directory, 'session'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

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
        voices: 0,
      },
      name + ': disposal releases scheduled work, overlays and audio voices',
    );
  } catch (error) {
    failure ||= error;
  }
  report.cases.push({
    name,
    ...(failure ? {error: failure.stack || String(failure)} : {}),
  });
}

async function installFixture(moduleUrl, applicationHtml) {
  const paintFrame = window.requestAnimationFrame.bind(window);
  let clock = 1000,
    nextId = 0;
  const frames = new Map(),
    timers = new Map();
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

  // Record dispatch to real Web Audio nodes, with a silent output bus.
  const NativeAudioContext = window.AudioContext;
  const voices = new Set();
  let starts = 0,
    stops = 0;
  window.AudioContext = class extends NativeAudioContext {
    constructor(...args) {
      super(...args);
      this.fixtureVoices = new Set();
      const mute = super.createGain();
      mute.gain.value = 0;
      mute.connect(this.destination);
      for (const name of [
        'createOscillator',
        'createBufferSource',
        'createGain',
        'createBiquadFilter',
      ]) {
        const create = this[name].bind(this);
        this[name] = (...values) => {
          const node = create(...values);
          const connect = node.connect.bind(node);
          node.connect = (target, ...ports) =>
            connect(target === this.destination ? mute : target, ...ports);
          if (node.start) {
            const start = node.start.bind(node),
              stop = node.stop.bind(node);
            node.start = (...values) => {
              starts++;
              voices.add(node);
              this.fixtureVoices.add(node);
              node.addEventListener('ended', () => voices.delete(node), {
                once: true,
              });
              return start(...values);
            };
            node.stop = (...values) => {
              stops++;
              voices.delete(node);
              this.fixtureVoices.delete(node);
              return stop(...values);
            };
          }
          return node;
        };
      }
    }
    close() {
      for (const voice of this.fixtureVoices) voices.delete(voice);
      this.fixtureVoices.clear();
      return super.close();
    }
  };
  const {createFactoryScene} = await import(moduleUrl);
  const {createYear1998Scene} = await import(
    new URL('./year1998-scene.js', moduleUrl)
  );
  const {createThemeScene} = await import(
    new URL('./theme-scene.js', moduleUrl)
  );
  const {createParentFallback} = await import(
    new URL('./parent-fallback.js', moduleUrl)
  );
  const {createFactoryCane} = await import(
    new URL('./factory-cane.js', moduleUrl)
  );
  const {createFactoryGun} = await import(
    new URL('./factory-gun.js', moduleUrl)
  );
  const {createFactoryFlamethrower} = await import(
    new URL('./factory-flamethrower.js', moduleUrl)
  );
  const {THEMES} = await import(new URL('./themes.js', moduleUrl));
  for (const name of ['factory-flamethrower.css', 'year1998.css']) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('./' + name, moduleUrl).href;
    document.head.append(link);
    await new Promise((resolve, reject) => {
      link.onload = resolve;
      link.onerror = reject;
    });
  }
  const application = new DOMParser().parseFromString(
    applicationHtml,
    'text/html',
  );
  const toolbarMarkup = application.querySelector(
    '#application-controls',
  ).outerHTML;
  const root = document.querySelector('#root');
  let current;
  function advance(ms = 20, follow, frameMs = 20) {
    const end = clock + ms;
    while (clock < end) {
      if (follow) follow();
      clock = Math.min(end, clock + frameMs);
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
  function rect(element) {
    const {x, y, width, height} = element.getBoundingClientRect();
    return {x, y, width, height};
  }
  function center(element) {
    const r = rect(element);
    return {x: r.x + r.width / 2, y: r.y + r.height / 2};
  }
  function pointer(element, type, point, extra = {}) {
    const event = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerType: 'mouse',
      pointerId: 1,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: point.x,
      clientY: point.y,
      ...extra,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }
  function graphic(selector) {
    const element = document.querySelector(selector);
    if (!element) return {visible: false};
    const bounds = rect(element),
      style = window.getComputedStyle(element);
    return {
      visible:
        bounds.width > 0 &&
        bounds.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) > 0,
      bounds,
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
        '.factory-flamethrower-layer, .factory-gun-layer, .factory-cane-layer',
      ).length,
      active: [
        'factory-flamethrower-active',
        'factory-gun-active',
        'factory-cane-active',
      ].some(name => document.documentElement.classList.contains(name)),
      voices: voices.size,
    };
  }
  async function setup(
    renderer = 'webgl',
    themeId = 'factory',
    localHolsters = false,
    environment = false,
    compactScene = false,
  ) {
    if (current)
      throw new Error('Previous flamethrower fixture was not disposed');
    const theme = THEMES.find(item => item.id === themeId);
    if (!theme) throw new Error('Unknown theme: ' + themeId);
    document.documentElement.dataset.theme = theme.id;
    document.documentElement.style.colorScheme = theme.colorScheme;
    for (const [name, value] of Object.entries(theme.colors))
      document.documentElement.style.setProperty('--' + name, value);
    root.innerHTML = toolbarMarkup;
    const toolbar = root.querySelector('#application-controls');
    const menu = root.querySelector('#app-menu-button');
    const field = document.createElement('input');
    field.setAttribute('aria-label', 'Session note');
    field.value = 'notes';
    const host = document.createElement('section');
    host.className =
      'factory-stage' +
      (renderer === 'fallback' ? ' fallback-units' : '') +
      (compactScene ? ' compact-scene' : '');
    host.setAttribute('aria-label', theme.name + ' flamethrower scene');
    root.append(host);
    const selections = [];
    let canvas, scene;
    if (renderer === 'fallback') {
      host.innerHTML =
        '<button type="button" class="fallback-station parent-session" data-unit-id="parent"><span class="robot-glyph"><i></i></span><strong>Main robot</strong></button>' +
        '<button type="button" class="fallback-station agent running" data-unit-id="drone"><span class="robot-glyph agent robot-subagent"><i></i></span><strong>Drone</strong><span class="status-badge running">Running</span></button>';
      scene = createParentFallback(host);
      host.addEventListener('click', event => {
        const station = event.target.closest('.fallback-station');
        if (station) selections.push(station.dataset.unitId);
      });
    } else {
      canvas = document.createElement('canvas');
      canvas.setAttribute('aria-label', 'Live agent workspace');
      host.append(canvas);
      if (renderer === 'webgl' && !canvas.getContext('webgl'))
        throw new Error('Real WebGL context unavailable');
      scene =
        renderer === 'host'
          ? createThemeScene(canvas, {})
          : (renderer === 'year1998'
              ? createYear1998Scene
              : createFactoryScene)(canvas, {
              onSelect: id => selections.push(id),
            });
      if (!scene) throw new Error(renderer + ' scene did not initialize');
      if (renderer === 'host') {
        await scene.setTheme(theme, theme.scenePalette);
        canvas = host.querySelector('canvas');
      } else scene.setPalette(theme.scenePalette);
    }
    scene.setMotion(true);
    const snapshot = {
      session: {id: 'flame-session', status: 'idle'},
      agents: [{id: 'drone', agentMode: 'subagent', status: 'running'}],
    };
    scene.update(snapshot, 'parent');
    const originalSnapshot = JSON.stringify(snapshot);
    const burns = [],
      gunHits = [],
      caneHits = [],
      environmentHits = [];
    const equips = {flame: 0, gun: 0, cane: 0};
    let acceptBurns = true,
      overrideEnvironmentTargets = null,
      environmentHook = null;
    const holsterContainer = localHolsters ? host : toolbar;
    const environmentOptions = {
      getEnvironmentTargets: () =>
        environment
          ? (overrideEnvironmentTargets ?? scene.environmentTargets?.() ?? [])
          : [],
      onEnvironmentHit: (id, weapon, amount) => {
        const accepted = scene.hitEnvironment(id, weapon, amount);
        environmentHits.push({id, weapon, amount, accepted, time: clock});
        environmentHook?.();
        return accepted;
      },
    };
    const cane = createFactoryCane(host, {
      ...environmentOptions,
      holsterContainer,
      getTargets: () => scene.caneTargets(),
      onEquip: () => {
        equips.cane++;
        gun?.stow();
        flame?.stow();
      },
      onHit: (id, direction, strength) => {
        caneHits.push(id);
        return scene.hitWithCane(id, direction, strength);
      },
    });
    const gun = createFactoryGun(host, {
      ...environmentOptions,
      holsterContainer,
      getTargets: () => scene.caneTargets(),
      onEquip: () => {
        equips.gun++;
        cane.stow();
        flame?.stow();
      },
      onHit: (id, direction, strength) => {
        gunHits.push(id);
        return scene.hitWithCane(id, direction, strength);
      },
    });
    const flame = createFactoryFlamethrower(host, {
      ...environmentOptions,
      holsterContainer,
      getTargets: () => scene.caneTargets(),
      onEquip: () => {
        equips.flame++;
        gun.stow();
        cane.stow();
      },
      onBurn: (id, seconds) => {
        const accepted = acceptBurns && scene.burnRobot(id, seconds);
        burns.push({id, seconds, accepted});
        return accepted;
      },
    });
    for (const toy of [flame, gun, cane]) toy.setSession('flame-session');
    const holster = holsterContainer.querySelector(
      '.factory-flamethrower-holster',
    );
    let menuClicks = 0;
    menu.addEventListener('click', () => menuClicks++);
    function target(id = 'parent') {
      return scene.caneTargets().find(item => item.id === id);
    }
    function surface(id = 'parent') {
      if (canvas) return canvas;
      const p = target(id);
      if (!p) return host;
      const element = document.elementFromPoint(p.x, p.y);
      if (element?.closest('.fallback-station')?.dataset.unitId !== id)
        throw new Error('Fallback target covered: ' + id);
      return element;
    }
    function moveTo(id = 'parent') {
      const point = target(id);
      if (point) pointer(surface(id), 'pointermove', point);
    }
    function start(id = 'parent') {
      const point = target(id);
      if (!point) throw new Error('Missing target: ' + id);
      moveTo(id);
      return pointer(surface(id), 'pointerdown', point);
    }
    function stop() {
      pointer(document, 'pointerup', target() || center(host));
    }
    function pose(id = 'parent') {
      if (canvas)
        return JSON.parse(canvas.dataset.robotDamage || '{}')[id] || {};
      const element =
        id === 'parent'
          ? host.querySelector('.parent-fallback-robot > g:nth-child(2)')
          : host.querySelector('.agent .robot-glyph');
      return {
        damage: Number(element?.dataset.damage || 0),
        phase: element?.dataset.damagePhase || 'alive',
        burning: Number(element?.dataset.damageBurning || 0),
        char: Number(element?.dataset.damageChar || 0),
        panic: Number(element?.dataset.damagePanic || 0),
        collapse: Number(element?.dataset.damageCollapse || 0),
        cleanup: element?.dataset.cleanupPhase || null,
        transform:
          element?.getAttribute('transform') || element?.style.transform || '',
      };
    }
    function state() {
      return {
        equipped: host.dataset.flamethrowerEquipped ?? null,
        firing: host.dataset.flamethrowerFiring ?? null,
        gun: host.dataset.gunEquipped ?? null,
        cane: host.dataset.caneEquipped ?? null,
        pressed: holster.getAttribute('aria-pressed'),
        held: graphic('.flamethrower-held'),
        layer: graphic('.factory-flamethrower-layer'),
        frames: frames.size,
        timers: timers.size,
        voices: voices.size,
        audioStarts: starts,
        audioStops: stops,
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
      snapshot,
      flame,
      gun,
      cane,
      holster,
      gunHolster: holsterContainer.querySelector('.factory-gun-holster'),
      caneHolster: holsterContainer.querySelector('.factory-cane-holster'),
      burns,
      gunHits,
      caneHits,
      environmentHits,
      equips,
      selections,
      target,
      surface,
      moveTo,
      start,
      stop,
      pose,
      state,
      unchanged: () => JSON.stringify(snapshot) === originalSnapshot,
      reject: () => {
        acceptBurns = false;
      },
      overrideEnvironment: targets => {
        overrideEnvironmentTargets = targets;
      },
      onEnvironment: callback => {
        environmentHook = callback;
      },
      menuClicks: () => menuClicks,
      dispose() {
        flame.dispose();
        gun.dispose();
        cane.dispose();
        scene.dispose();
      },
    };
    advance(40);
    return current;
  }
  function environmentState(f = current) {
    return JSON.parse((f.canvas || f.host).dataset.environmentDamage || '[]');
  }
  function environmentTarget(f, furniture = false) {
    const bounds = f.host.getBoundingClientRect(),
      robots = f.scene.caneTargets();
    const targets = f.scene
      .environmentTargets()
      .filter(
        target =>
          target.id.startsWith('floor:') !== furniture &&
          target.x > bounds.left + 110 &&
          target.x < bounds.right - 110 &&
          target.y > bounds.top + 40 &&
          target.y < bounds.bottom - 100 &&
          robots.every(
            robot =>
              Math.hypot(robot.x - target.x, robot.y - target.y) >
              robot.radius + (furniture ? 4 : target.radius + 24),
          ),
      );
    targets.sort(
      (a, b) =>
        Math.hypot(
          a.x - bounds.left - bounds.width / 2,
          a.y - bounds.top - bounds.height / 2,
        ) -
        Math.hypot(
          b.x - bounds.left - bounds.width / 2,
          b.y - bounds.top - bounds.height / 2,
        ),
    );
    if (!targets.length)
      throw new Error(
        'No unobstructed ' +
          (furniture ? 'furniture' : 'floor') +
          ' environment target in ' +
          f.renderer,
      );
    return targets[0];
  }
  function environmentSurface(f, point) {
    return f.canvas || document.elementFromPoint(point.x, point.y) || f.host;
  }
  function sprayEnvironment(f, point, ms = 900) {
    f.holster.click();
    const surface = environmentSurface(f, point);
    pointer(surface, 'pointermove', point);
    pointer(surface, 'pointerdown', point);
    advance(ms);
    f.flame.stow();
  }
  function swingEnvironment(f, target) {
    f.caneHolster.click();
    const bounds = f.host.getBoundingClientRect(),
      y = Math.min(bounds.bottom - 5, target.y + 64);
    for (const x of [
      target.x - 90,
      target.x + 90,
      target.x - 90,
      target.x + 90,
    ]) {
      pointer(environmentSurface(f, {x, y}), 'pointermove', {x, y});
      advance(40);
    }
    f.cane.stow();
  }
  function shootEnvironment(f, point, count = 1) {
    f.gunHolster.click();
    for (let i = 0; i < count; i++) {
      environmentSurface(f, point).dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          detail: 1,
          button: 0,
          clientX: point.x,
          clientY: point.y,
        }),
      );
      advance(200);
    }
    f.gun.stow();
  }

  window.fixture = {
    cleanup,
    paint: () => new Promise(resolve => paintFrame(() => paintFrame(resolve))),
    themes: () => THEMES.map(theme => theme.id),
    shotState: () => current.state(),
    async environmentWeapon(renderer, weapon, furniture = false) {
      const theme = renderer === 'year1998' ? 'year1998' : 'factory';
      const f = await setup(renderer, theme, false, true);
      const target = environmentTarget(f, furniture);
      if (weapon === 'flame') sprayEnvironment(f, target);
      else if (weapon === 'gun') shootEnvironment(f, target);
      else swingEnvironment(f, target);
      return {
        target,
        hits: f.environmentHits,
        poses: environmentState(f),
        caneHits: f.caneHits,
        gunHits: f.gunHits,
        unchanged: f.unchanged(),
        selections: f.selections,
      };
    },
    async environmentParentAnchor() {
      const results = [];
      for (const compact of [false, true]) {
        const f = await setup('fallback', 'factory', false, true, compact);
        const svg = f.host.querySelector('.parent-fallback-robot'),
          point = svg.createSVGPoint();
        point.x = 50.4;
        point.y = 90;
        const physical = point.matrixTransform(svg.getScreenCTM());
        const target = f.scene
          .environmentTargets()
          .find(item => item.id === 'workstation:parent');
        results.push({compact, target, actual: {x: physical.x, y: physical.y}});
        cleanup();
      }
      return results;
    },
    async environmentPalette(renderer, theme) {
      const f = await setup(renderer, theme, false, true),
        broken = environmentTarget(f);
      shootEnvironment(f, broken, 4);
      advance(5300);
      const bounds = f.host.getBoundingClientRect();
      const burning = f.scene
        .environmentTargets()
        .find(
          target =>
            target.id.startsWith('floor:') &&
            target.id !== broken.id &&
            Math.hypot(target.x - broken.x, target.y - broken.y) > 100 &&
            target.x > bounds.left + 90 &&
            target.x < bounds.right - 90 &&
            target.y > bounds.top + 70 &&
            target.y < bounds.bottom - 90,
        );
      if (!burning)
        throw new Error(
          'No separate fire site for environment palette capture',
        );
      sprayEnvironment(f, burning);
      advance(1800);
      return environmentState(f);
    },
    async environmentWhileAway() {
      const f = await setup('fallback', 'factory', false, true);
      f.scene.update(
        {
          ...f.snapshot,
          hub: {
            sessions: [
              {session: f.snapshot.session},
              {session: {id: 'neighbor', status: 'idle'}},
            ],
          },
        },
        'parent',
      );
      const robot = f.host.querySelector(
        '.parent-fallback-robot > g:nth-child(2)',
      );
      for (
        let elapsed = 0;
        elapsed < 90000 && robot.style.display !== 'none';
        elapsed += 100
      )
        advance(100);
      const away = robot.style.display === 'none';
      const target = environmentTarget(f);
      sprayEnvironment(f, target);
      advance(1600);
      return {
        away,
        poses: environmentState(f),
        shapes:
          f.host.querySelector('.environment-floor-effects')
            ?.childElementCount ?? 0,
        unchanged: f.unchanged(),
      };
    },
    async environmentEdges() {
      const f = await setup('webgl', 'factory', false, true),
        target = environmentTarget(f);
      for (const targets of [
        {invalid: true},
        [
          {
            ...target,
            x: f.host.getBoundingClientRect().left - 1,
            radius: 10000,
          },
        ],
      ]) {
        f.overrideEnvironment(targets);
        shootEnvironment(f, target);
        swingEnvironment(f, target);
        sprayEnvironment(f, target, 100);
      }
      const invalidHits = f.environmentHits.length;
      f.overrideEnvironment([target, {...target}]);
      sprayEnvironment(f, target, 100);
      return {invalidHits, hits: f.environmentHits, unchanged: f.unchanged()};
    },
    async environmentCaneCancellation(dispose) {
      const f = await setup('webgl', 'factory', false, true),
        target = environmentTarget(f);
      const other = f.scene
        .environmentTargets()
        .find(item => item.id !== target.id);
      f.overrideEnvironment([target, {...target, id: other.id}]);
      f.onEnvironment(() => (dispose ? f.cane.dispose() : f.cane.stow()));
      swingEnvironment(f, target);
      advance(300);
      return {
        hits: f.environmentHits,
        sparks: document.querySelectorAll('.cane-impact').length,
        equipped: f.host.dataset.caneEquipped,
        unchanged: f.unchanged(),
      };
    },
    async environmentRobotPriority(renderer) {
      const theme = renderer === 'year1998' ? 'year1998' : 'factory';
      const f = await setup(renderer, theme, false, true);
      const robot = f.target(),
        site = environmentTarget(f);
      f.overrideEnvironment([
        {...site, x: robot.x, y: robot.y, radius: robot.radius + 10},
      ]);
      shootEnvironment(f, robot);
      const gun = {
        robotHits: f.gunHits.length,
        environmentHits: f.environmentHits.length,
        damage: f.pose().damage,
      };
      f.holster.click();
      f.start();
      advance(180, () => f.moveTo());
      f.flame.stow();
      return {
        gun,
        robotBurns: f.burns,
        environmentBurns: f.environmentHits,
        poses: environmentState(f),
        unchanged: f.unchanged(),
      };
    },
    async environmentFire(renderer) {
      const theme = renderer === 'year1998' ? 'year1998' : 'factory';
      const f = await setup(renderer, theme, false, true);
      const target = environmentTarget(f);
      sprayEnvironment(f, target);
      const initial = environmentState(f),
        direct = [
          ...new Set(f.environmentHits.filter(h => h.accepted).map(h => h.id)),
        ];
      advance(1800);
      return {
        target,
        direct,
        initial,
        spread: environmentState(f),
        state: f.state(),
        unchanged: f.unchanged(),
        selections: f.selections,
      };
    },
    async environmentLowFps(renderer) {
      const results = [];
      for (const frameMs of [1000 / 60, 100]) {
        const f = await setup(
          renderer,
          renderer === 'year1998' ? 'year1998' : 'factory',
          false,
          true,
        );
        const target = environmentTarget(f);
        shootEnvironment(f, target, 4);
        advance(5500, undefined, frameMs);
        results.push(environmentState(f).find(pose => pose.id === target.id));
        cleanup();
      }
      return results;
    },
    async environmentQueuedTables() {
      const f = await setup('year1998', 'year1998', false, true);
      f.scene.update(
        {
          ...f.snapshot,
          agents: [
            ...f.snapshot.agents,
            {id: 'queued-environment', status: 'queued'},
          ],
        },
        'parent',
      );
      advance(40);
      const targets = [];
      for (const id of ['desk:6', 'desk:7']) {
        const target = f.scene
          .environmentTargets()
          .find(item => item.id === id);
        if (!target)
          throw new Error('Queue table environment target not visible: ' + id);
        targets.push(target);
        sprayEnvironment(f, target);
      }
      return {targets, poses: environmentState(f), unchanged: f.unchanged()};
    },
    async environmentRepairStart(renderer) {
      const theme = renderer === 'year1998' ? 'year1998' : 'factory';
      const f = await setup(renderer, theme, false, true);
      const target = environmentTarget(f);
      shootEnvironment(f, target, 4);
      const broken = environmentState(f);
      advance(5300);
      return {
        target,
        broken,
        poses: environmentState(f),
        unchanged: f.unchanged(),
      };
    },
    environmentAdvance(ms) {
      advance(ms);
      return environmentState();
    },
    environmentReset() {
      const f = current,
        target = environmentTarget(f);
      sprayEnvironment(f, target);
      const burning = environmentState(f);
      f.flame.setMotion(false);
      f.scene.setMotion(false);
      const still = environmentState(f);
      advance(2000);
      const frozen = environmentState(f);
      f.scene.update(
        {
          ...f.snapshot,
          session: {...f.snapshot.session, id: 'other-environment-session'},
        },
        'parent',
      );
      const reset = environmentState(f);
      f.scene.dispose();
      return {
        burning,
        still,
        frozen,
        reset,
        targetsAfterDispose: f.scene.environmentTargets(),
        dataRemoved: !(f.canvas || f.host).hasAttribute(
          'data-environment-damage',
        ),
        unchanged: f.unchanged(),
      };
    },
    async environmentForwarding(themeId) {
      const f = await setup('host', themeId, false, true);
      const target = environmentTarget(f);
      shootEnvironment(f, target);
      return {
        hits: f.environmentHits,
        poses: environmentState(f),
        unchanged: f.unchanged(),
      };
    },
    async nativeSetup(renderer) {
      const f = await setup(renderer);
      return {
        holster: center(f.holster),
        target: f.target(),
        menu: center(f.menu),
      };
    },
    nativeState(ms = 0) {
      const f = current;
      advance(ms);
      return {
        state: f.state(),
        burns: f.burns.length,
        pose: f.pose(),
        selections: f.selections,
      };
    },
    async ignition(renderer) {
      const f = await setup(renderer);
      f.holster.click();
      f.moveTo();
      advance(100);
      const before = f.burns.length,
        audioBefore = f.state().audioStarts;
      const prevented = f.start();
      advance(200, () => f.moveTo());
      const burning = f.pose(),
        firstTarget = f.target(),
        first = f.state();
      advance(160, () => f.moveTo());
      const moved = f.pose(),
        nextTarget = f.target();
      f.stop();
      const stopped = f.state(),
        count = f.burns.length;
      advance(2100);
      return {
        before,
        audioBefore,
        prevented,
        burning,
        moved,
        firstTarget,
        nextTarget,
        first,
        stopped,
        extraBurns: f.burns.length - count,
        cooled: f.pose(),
        burns: f.burns,
        selections: f.selections,
        unchanged: f.unchanged(),
      };
    },
    async lifecycle(renderer) {
      const f = await setup(renderer);
      f.holster.click();
      f.start();
      for (
        let elapsed = 0;
        elapsed < 8000 && f.pose().phase === 'alive';
        elapsed += 20
      )
        advance(20, () => f.moveTo());
      f.stop();
      const dead = f.pose(),
        deadTarget = Boolean(f.target());
      advance(1100);
      const wrecked = f.pose();
      advance(2300);
      const cleanup = f.pose();
      advance(6200);
      const replacing = f.pose();
      advance(3800);
      const replaced = f.pose();
      return {
        dead,
        deadTarget,
        wrecked,
        cleanup,
        replacing,
        replaced,
        restoredTarget: Boolean(f.target()),
        burns: f.burns,
        unchanged: f.unchanged(),
        selections: f.selections,
      };
    },
    async releaseAndAim(renderer) {
      const f = await setup(renderer);
      f.holster.click();
      f.start();
      advance(160, () => f.moveTo());
      const parent = f.pose();
      f.moveTo('drone');
      advance(180, () => f.moveTo('drone'));
      const drone = f.pose('drone');
      const r = f.host.getBoundingClientRect();
      const miss = {x: r.right - 4, y: r.bottom - 4};
      pointer(f.canvas || f.host, 'pointermove', miss);
      const count = f.burns.length;
      advance(200);
      const afterMiss = f.burns.length;
      f.stop();
      const stopped = f.state();
      f.reject();
      f.start();
      advance(120, () => f.moveTo());
      const rejected = f.burns.slice(afterMiss),
        rejectedPose = f.pose();
      f.stop();
      return {
        parent,
        drone,
        count,
        afterMiss,
        stopped,
        rejected,
        rejectedPose,
        unchanged: f.unchanged(),
        selections: f.selections,
      };
    },
    async cancellation(action) {
      const f = await setup();
      f.holster.click();
      f.start();
      advance(100, () => f.moveTo());
      const before = f.state();
      let prevented = null;
      if (action === 'stow') f.flame.stow();
      else if (action === 'session') f.flame.setSession('other-session');
      else if (action === 'motion') f.flame.setMotion(false);
      else if (action === 'dispose') f.flame.dispose();
      else if (action === 'escape') {
        const event = new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        });
        document.dispatchEvent(event);
        prevented = event.defaultPrevented;
      } else if (action === 'right') {
        const event = new MouseEvent('contextmenu', {
          button: 2,
          bubbles: true,
          cancelable: true,
        });
        f.menu.dispatchEvent(event);
        prevented = event.defaultPrevented;
      } else if (action === 'scroll')
        document.dispatchEvent(new Event('scroll', {bubbles: true}));
      else window.dispatchEvent(new Event(action));
      const after = f.state(),
        count = f.burns.length;
      advance(2100);
      return {
        before,
        after,
        extraBurns: f.burns.length - count,
        prevented,
        cooled: f.pose(),
        detached: !f.holster.isConnected,
      };
    },
    async controls(renderer) {
      const f = await setup(renderer);
      f.holster.click();
      const sceneButton = document.createElement('button');
      sceneButton.textContent = 'Scene action';
      sceneButton.style.cssText =
        'position:absolute;left:8px;top:8px;z-index:2';
      f.host.append(sceneButton);
      let sceneClicks = 0;
      sceneButton.addEventListener('click', () => sceneClicks++);
      const prevented = pointer(
        sceneButton,
        'pointerdown',
        center(sceneButton),
      );
      sceneButton.click();
      advance(120);
      pointer(f.menu, 'pointerdown', center(f.menu));
      f.menu.click();
      advance(100);
      f.toolbar.append(f.field);
      f.field.focus();
      f.field.value = 'edited';
      f.field.dispatchEvent(new Event('input', {bubbles: true}));
      const controlled = {
        prevented,
        sceneClicks,
        menuClicks: f.menuClicks(),
        burns: f.burns.length,
        firing: f.state().firing,
        focused: document.activeElement === f.field,
        value: f.field.value,
      };
      f.flame.stow();
      const point = f.target();
      f.surface().dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          detail: 1,
          clientX: point.x,
          clientY: point.y,
        }),
      );
      return {
        controlled,
        selections: f.selections,
        outsideScene: !f.host.contains(f.holster),
        transparent:
          window.getComputedStyle(
            document.querySelector('.factory-flamethrower-layer'),
          ).pointerEvents === 'none',
      };
    },
    async switching(localHolsters) {
      const f = await setup('webgl', 'factory', localHolsters);
      function equip(button) {
        pointer(button, 'pointerdown', center(button));
        button.click();
        pointer(button, 'pointerup', center(button));
        advance(20);
      }
      equip(f.caneHolster);
      const cane = f.state();
      equip(f.holster);
      f.start();
      advance(160, () => f.moveTo());
      const flame = f.state();
      const count = f.burns.length;
      equip(f.gunHolster);
      const gun = f.state();
      advance(400);
      const afterGun = f.burns.length;
      equip(f.holster);
      f.start();
      advance(100, () => f.moveTo());
      equip(f.caneHolster);
      const caneAgain = f.state();
      const countAgain = f.burns.length;
      advance(400);
      return {
        cane,
        flame,
        gun,
        caneAgain,
        count,
        afterGun,
        countAgain,
        finalCount: f.burns.length,
        equips: f.equips,
        gunHits: f.gunHits,
        caneHits: f.caneHits,
      };
    },
    async sessionAndMotion() {
      const f = await setup();
      f.holster.click();
      f.start();
      advance(100, () => f.moveTo());
      f.flame.setSession('flame-session');
      const same = f.state();
      f.flame.setSession(null);
      const missing = f.state();
      const hidden = window.getComputedStyle(f.holster).display === 'none';
      f.flame.setSession('restored');
      const restored = window.getComputedStyle(f.holster).display !== 'none';
      f.flame.setMotion(false);
      f.scene.setMotion(false);
      f.holster.click();
      f.start();
      advance(500, () => f.moveTo());
      const staticPose = f.pose(),
        staticState = f.state();
      f.stop();
      return {
        same,
        missing,
        hidden,
        restored,
        staticPose,
        staticState,
        unchanged: f.unchanged(),
      };
    },
    async forwarding(themeId) {
      const f = await setup('host', themeId);
      const accepted = f.scene.burnRobot('parent', 0.2);
      const rejected = f.scene.burnRobot('missing', 0.2);
      advance(40);
      return {
        accepted,
        rejected,
        pose: f.pose(),
        renderer: f.canvas.dataset.renderer,
        unchanged: f.unchanged(),
      };
    },
    async corpseScreenshot(renderer) {
      const theme = renderer === 'year1998' ? 'year1998' : 'factory';
      const f = await setup(renderer, theme);
      f.holster.click();
      f.start();
      for (
        let elapsed = 0;
        elapsed < 8000 && f.pose().phase === 'alive';
        elapsed += 20
      )
        advance(20, () => f.moveTo());
      f.flame.stow();
      advance(2100);
      return {pose: f.pose(), state: f.state()};
    },
    async screenshot(renderer, theme) {
      const f = await setup(renderer, theme);
      f.holster.click();
      f.start();
      advance(300, () => f.moveTo());
      const controls = [...f.toolbar.querySelectorAll(':scope > button')]
        .filter(button => !button.hidden)
        .map(button => {
          const r = rect(button);
          return {
            text: button.textContent.trim(),
            rect: r,
            visible:
              r.width > 0 &&
              r.height > 0 &&
              r.x >= 0 &&
              r.y >= 0 &&
              r.x + r.width <= window.innerWidth &&
              r.y + r.height <= window.innerHeight,
            topmost: button.contains(
              document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
            ),
          };
        });
      return {
        state: f.state(),
        pose: f.pose(),
        controls,
        host: rect(f.host),
        viewport: {width: window.innerWidth, height: window.innerHeight},
        noPageScroll:
          document.documentElement.scrollWidth <= window.innerWidth &&
          document.documentElement.scrollHeight <= window.innerHeight,
      };
    },
  };
}

async function capture(filename, metadata, firing = true) {
  browser.webContents.invalidate();
  await evaluate('paint');
  await delay(50);
  const state = await evaluate('shotState');
  if (firing) {
    assert.equal(
      state.held.visible,
      true,
      filename + ': held flamethrower visible',
    );
    assert.equal(state.firing, 'true', filename + ': stream active at capture');
  } else {
    assert.equal(
      state.equipped,
      'false',
      filename + ': weapon stowed at capture',
    );
  }
  const path = join(screenshotDirectory, filename);
  writeFileSync(path, (await browser.webContents.capturePage()).toPNG());
  report.screenshots.push({...metadata, path});
}

async function nativeInput(type, point) {
  const zoom = browser.webContents.getZoomFactor();
  browser.webContents.sendInputEvent({
    type,
    x: Math.round(point.x * zoom),
    y: Math.round(point.y * zoom),
    ...(type === 'mouseMove' ? {} : {button: 'left', clickCount: 1}),
  });
  await delay(20);
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
  browser.showInactive();
  const moduleUrl = pathToFileURL(
    resolve(__dirname, '../../assets/dashboard/factory-scene.js'),
  ).href;
  const applicationHtml = readFileSync(
    resolve(__dirname, '../../assets/dashboard/index.html'),
    'utf8',
  );
  await browser.webContents.executeJavaScript(
    `(${installFixture.toString()})(${JSON.stringify(moduleUrl)}, ${JSON.stringify(applicationHtml)})`,
  );
  report.themes = await evaluate('themes');
  if (
    process.env.FACTORY_FLAMETHROWER_CAPTURE_ONLY === 'environment-fallback'
  ) {
    await run('SVG environmental effects capture', async () => {
      for (const theme of report.themes) {
        const poses = await evaluate('environmentPalette', 'fallback', theme);
        assert.ok(poses.some(pose => pose.fire > 0));
        assert.ok(poses.some(pose => pose.phase === 'repairing'));
        await capture(
          'environment-palette-fallback-' + theme + '.png',
          {renderer: 'fallback', theme, environment: true},
          false,
        );
        await evaluate('cleanup');
      }
      await evaluate('environmentRepairStart', 'fallback');
      await evaluate('environmentAdvance', 2700);
      await capture(
        'environment-fallback-repairing.png',
        {renderer: 'fallback', theme: 'factory'},
        false,
      );
    });
    return;
  }
  for (const renderer of ['webgl', 'year1998', 'fallback']) {
    await run(
      renderer +
        ': native mouse hold sprays and release outside the scene stops',
      async () => {
        const points = await evaluate('nativeSetup', renderer);
        await nativeInput('mouseMove', points.holster);
        await nativeInput('mouseDown', points.holster);
        await nativeInput('mouseUp', points.holster);
        await nativeInput('mouseMove', points.target);
        await nativeInput('mouseDown', points.target);
        const held = await evaluate('nativeState', 160);
        assert.equal(held.state.equipped, 'true');
        assert.equal(held.state.firing, 'true');
        assert.ok(held.burns > 1 && held.pose.damage > 0);
        assert.deepEqual(held.selections, []);
        await nativeInput('mouseUp', points.menu);
        const released = await evaluate('nativeState', 2100);
        assert.equal(released.state.firing, 'false');
        assert.equal(released.state.voices, 0);
        assert.equal(released.burns, held.burns);
        assert.equal(released.pose.burning, 0);
      },
    );
    await run(
      renderer + ': continuous ignition, panic movement, release and cooling',
      async () => {
        const r = await evaluate('ignition', renderer);
        assert.equal(r.before, 0, 'Hovering never burns');
        assert.equal(r.prevented, true);
        assert.ok(r.burning.damage > 0 && r.burning.damage < 1);
        assert.ok(
          r.burning.burning > 0 && r.burning.char > 0 && r.burning.panic > 0,
        );
        assert.ok(
          r.moved.damage > r.burning.damage,
          'Holding accumulates exposure',
        );
        assert.notDeepEqual(
          renderer === 'fallback' ? r.moved.transform : r.moved.offset,
          renderer === 'fallback' ? r.burning.transform : r.burning.offset,
          'Burning robot moves: ' +
            JSON.stringify({before: r.burning, after: r.moved}),
        );
        assert.equal(r.first.firing, 'true');
        assert.equal(r.first.held.visible, true);
        assert.ok(
          r.first.audioStarts - r.audioBefore >= 4,
          'Controller dispatches the hiss and robot cry voices',
        );
        assert.equal(r.stopped.firing, 'false');
        assert.equal(r.stopped.voices, 0);
        assert.equal(r.extraBurns, 0);
        assert.equal(r.cooled.burning, 0);
        assert.equal(
          r.cooled.damage,
          r.moved.damage,
          'Fire cannot cause damage after release',
        );
        assert.ok(
          r.burns.length > 2 &&
            r.burns.every(
              b => b.accepted && b.seconds > 0 && b.seconds <= 0.25,
            ),
        );
        assert.deepEqual(r.selections, []);
        assert.equal(r.unchanged, true);
      },
    );
    await run(
      renderer +
        ': sustained fire chars a corpse, cleans it up and replaces the robot',
      async () => {
        const r = await evaluate('lifecycle', renderer);
        assert.equal(r.dead.phase, 'charring');
        assert.equal(r.dead.damage, 1);
        assert.equal(r.dead.char, 1);
        assert.equal(r.deadTarget, false);
        assert.equal(r.wrecked.phase, 'wrecked');
        assert.equal(r.wrecked.collapse, 1);
        assert.equal(r.wrecked.char, 1);
        assert.equal(r.cleanup.phase, 'cleanup');
        assert.ok(r.cleanup.cleanup);
        assert.equal(r.replacing.phase, 'replacing');
        assert.equal(r.replacing.char, 0);
        assert.equal(r.replaced.phase, 'alive');
        assert.equal(r.replaced.damage, 0);
        assert.equal(r.replaced.char, 0);
        assert.equal(r.restoredTarget, true);
        assert.equal(r.unchanged, true);
        assert.deepEqual(r.selections, []);
      },
    );
    await run(
      renderer + ': aim follows moving targets, misses and rejected burns',
      async () => {
        const r = await evaluate('releaseAndAim', renderer);
        assert.ok(r.parent.damage > 0);
        assert.ok(r.drone.damage > 0);
        assert.equal(
          r.count,
          r.afterMiss,
          'Missing the robots does not apply damage',
        );
        assert.equal(r.stopped.firing, 'false');
        assert.ok(r.rejected.length > 0 && r.rejected.every(b => !b.accepted));
        assert.equal(r.rejectedPose.damage, r.parent.damage);
        assert.equal(r.unchanged, true);
        assert.deepEqual(r.selections, []);
      },
    );
    await run(
      renderer + ': scene controls, toolbar menu and text input remain usable',
      async () => {
        const r = await evaluate('controls', renderer);
        assert.deepEqual(r.controlled, {
          prevented: false,
          sceneClicks: 1,
          menuClicks: 1,
          burns: 0,
          firing: 'false',
          focused: true,
          value: 'edited',
        });
        assert.deepEqual(r.selections, ['parent']);
        assert.equal(r.outsideScene, true);
        assert.equal(r.transparent, true);
      },
    );
  }
  for (const action of [
    'stow',
    'blur',
    'scroll',
    'resize',
    'session',
    'dispose',
    'motion',
    'escape',
    'right',
  ]) {
    await run(
      action + ': cancels flame stream, damage and synthesized audio',
      async () => {
        const r = await evaluate('cancellation', action);
        assert.equal(r.before.firing, 'true');
        assert.ok(r.before.voices > 0);
        assert.notEqual(r.after.firing, 'true');
        assert.equal(r.after.voices, 0);
        assert.equal(r.extraBurns, 0);
        assert.equal(r.cooled.burning, 0);
        if (['escape', 'right'].includes(action)) {
          assert.equal(r.prevented, true);
          assert.equal(r.after.equipped, 'false');
        }
        if (action === 'dispose') assert.equal(r.detached, true);
      },
    );
  }
  for (const local of [false, true])
    await run(
      (local ? 'Scene' : 'Toolbar') +
        ' weapon controls enforce gun/cane/flamethrower exclusivity',
      async () => {
        const r = await evaluate('switching', local);
        assert.equal(r.cane.cane, 'true');
        assert.equal(r.cane.equipped, 'false');
        assert.equal(r.flame.equipped, 'true');
        assert.equal(r.flame.cane, 'false');
        assert.equal(r.flame.gun, 'false');
        assert.equal(r.gun.gun, 'true');
        assert.equal(r.gun.equipped, 'false');
        assert.equal(r.gun.voices, 0);
        assert.equal(r.count, r.afterGun);
        assert.equal(r.caneAgain.cane, 'true');
        assert.equal(r.caneAgain.equipped, 'false');
        assert.equal(r.caneAgain.voices, 0);
        assert.equal(r.countAgain, r.finalCount);
        assert.deepEqual(r.equips, {flame: 2, gun: 1, cane: 2});
        assert.deepEqual(r.gunHits, []);
        assert.deepEqual(r.caneHits, []);
      },
    );
  await run(
    'Session availability, same-session updates and motion preference',
    async () => {
      const r = await evaluate('sessionAndMotion');
      assert.equal(r.same.firing, 'true');
      assert.equal(r.missing.equipped, 'false');
      assert.equal(r.hidden, true);
      assert.equal(r.restored, true);
      assert.ok(r.staticPose.damage > 0 && r.staticPose.char > 0);
      assert.equal(r.staticPose.burning, 0);
      assert.equal(r.staticPose.panic, 0);
      assert.equal(r.unchanged, true);
    },
  );
  for (const theme of ['factory', 'year1998'])
    await run(
      theme + ': theme host forwards burnRobot to the active shipped renderer',
      async () => {
        const r = await evaluate('forwarding', theme);
        assert.equal(r.accepted, true);
        assert.equal(r.rejected, false);
        assert.ok(r.pose.burning > 0 && r.pose.damage > 0);
        assert.equal(r.unchanged, true);
      },
    );
  await run(
    'All weapon adapters ignore malformed and off-scene environment targets; flame deduplicates contacts',
    async () => {
      const r = await evaluate('environmentEdges');
      assert.equal(r.invalidHits, 0);
      assert.ok(r.hits.length > 0);
      assert.equal(
        new Set(r.hits.map(hit => hit.id + ':' + hit.time)).size,
        r.hits.length,
        'One exposure per site per animation frame',
      );
      assert.equal(r.unchanged, true);
    },
  );
  for (const dispose of [false, true])
    await run(
      'Cane environment callback ' +
        (dispose ? 'disposal' : 'stow') +
        ' cancels remaining queued contacts and sparks',
      async () => {
        const r = await evaluate('environmentCaneCancellation', dispose);
        assert.equal(r.hits.length, 1);
        assert.equal(r.sparks, 0);
        assert.notEqual(r.equipped, 'true');
        assert.equal(r.unchanged, true);
      },
    );
  await run(
    'Fallback parent workstation target tracks the rendered SVG in regular and compact scenes',
    async () => {
      for (const r of await evaluate('environmentParentAnchor'))
        assert.ok(
          Math.hypot(r.target.x - r.actual.x, r.target.y - r.actual.y) <= 2,
          JSON.stringify(r),
        );
    },
  );
  await run(
    'Year1998 queued and empty queue tables expose actual burning surfaces',
    async () => {
      const r = await evaluate('environmentQueuedTables');
      for (const id of ['desk:6', 'desk:7'])
        assert.ok(
          r.poses.some(
            pose => pose.id === id && pose.fire > 0 && pose.scorch > 0,
          ),
        );
      assert.equal(r.unchanged, true);
      await capture(
        'environment-year1998-queue-tables.png',
        {renderer: 'year1998', theme: 'year1998'},
        false,
      );
    },
  );
  await run(
    'Fallback environment fire keeps rendering while the main robot visits another session',
    async () => {
      const r = await evaluate('environmentWhileAway');
      assert.equal(r.away, true);
      assert.ok(r.poses.some(pose => pose.fire > 0));
      assert.ok(r.shapes > 0);
      assert.equal(r.unchanged, true);
      await capture(
        'environment-fallback-away.png',
        {renderer: 'fallback', theme: 'factory'},
        false,
      );
    },
  );
  for (const renderer of ['webgl', 'year1998', 'fallback']) {
    await run(
      renderer + ': repair delay follows elapsed time at 10fps and 60fps',
      async () => {
        const [regular, slow] = await evaluate('environmentLowFps', renderer);
        assert.equal(regular?.phase, 'arriving');
        assert.equal(slow?.phase, 'arriving');
        assert.ok(
          Math.abs(regular.phaseAge - slow.phaseAge) <= 0.12,
          JSON.stringify({regular, slow}),
        );
      },
    );
    await run(
      renderer +
        ': furniture and machinery chip under gunshots and burn under flame',
      async () => {
        for (const weapon of ['gun', 'flame']) {
          const r = await evaluate('environmentWeapon', renderer, weapon, true);
          const affected = r.poses.find(pose => pose.id === r.target.id);
          assert.ok(affected?.damage > 0, JSON.stringify(r));
          assert.ok(
            weapon === 'gun'
              ? affected.chips > 0
              : affected.scorch > 0 && affected.fire > 0,
          );
          assert.equal(r.unchanged, true);
          await capture(
            'environment-' + renderer + '-furniture-' + weapon + '.png',
            {renderer, theme: renderer === 'year1998' ? 'year1998' : 'factory'},
            false,
          );
          await evaluate('cleanup');
        }
      },
    );
    for (const weapon of ['cane', 'gun', 'flame'])
      await run(
        renderer +
          ': ' +
          weapon +
          ' damages real environment surfaces through its own controller',
        async () => {
          const r = await evaluate('environmentWeapon', renderer, weapon);
          const hits = r.hits.filter(
            hit => hit.accepted && hit.weapon === weapon,
          );
          assert.ok(hits.length > 0, JSON.stringify(r));
          const poses = r.poses.filter(pose =>
            hits.some(hit => hit.id === pose.id),
          );
          assert.ok(poses.length > 0 && poses.every(pose => pose.damage > 0));
          if (weapon === 'cane') {
            assert.ok(poses.some(pose => pose.dent > 0));
            assert.ok(
              poses.every(pose => pose.chips === 0 && pose.scorch === 0),
            );
            assert.deepEqual(
              r.caneHits,
              [],
              'Environment contact has its own callback',
            );
          } else if (weapon === 'gun') {
            assert.ok(poses.some(pose => pose.chips > 0));
            assert.ok(
              poses.every(pose => pose.dent === 0 && pose.scorch === 0),
            );
            assert.deepEqual(
              r.gunHits,
              [],
              'An empty-scene click hits environment without a robot hit',
            );
          } else {
            assert.ok(poses.some(pose => pose.scorch > 0 && pose.fire > 0));
            assert.ok(poses.every(pose => pose.dent === 0 && pose.chips === 0));
          }
          assert.equal(r.unchanged, true);
          assert.deepEqual(r.selections, []);
          await capture(
            'environment-' + renderer + '-' + weapon + '.png',
            {renderer, theme: renderer === 'year1998' ? 'year1998' : 'factory'},
            false,
          );
        },
      );
    await run(
      renderer +
        ': gun prioritizes robots and the flame cone can contact robot and environment together',
      async () => {
        const r = await evaluate('environmentRobotPriority', renderer);
        assert.equal(r.gun.robotHits, 1);
        assert.equal(r.gun.environmentHits, 0);
        assert.ok(r.gun.damage > 0);
        assert.ok(r.robotBurns.some(hit => hit.accepted));
        assert.ok(
          r.environmentBurns.some(
            hit => hit.accepted && hit.weapon === 'flame',
          ),
        );
        assert.ok(r.poses.some(pose => pose.scorch > 0));
        assert.equal(r.unchanged, true);
      },
    );
    await run(
      renderer +
        ': environmental fire persists after release and spreads to untouched neighboring surfaces',
      async () => {
        const r = await evaluate('environmentFire', renderer);
        assert.equal(r.state.firing, 'false');
        assert.equal(r.state.voices, 0);
        assert.ok(r.initial.some(pose => pose.fire > 0));
        assert.ok(
          r.spread.some(pose => pose.fire > 0 && !r.direct.includes(pose.id)),
          JSON.stringify(r),
        );
        assert.ok(
          r.spread.some(
            pose =>
              pose.damage >
              (r.initial.find(initial => initial.id === pose.id)?.damage ?? 1),
          ),
        );
        assert.equal(r.unchanged, true);
        assert.deepEqual(r.selections, []);
        await capture(
          'environment-' + renderer + '-spread.png',
          {renderer, theme: renderer === 'year1998' ? 'year1998' : 'factory'},
          false,
        );
      },
    );
    await run(
      renderer +
        ': repair bots arrive later, rebuild damaged surfaces, leave and release session state',
      async () => {
        const r = await evaluate('environmentRepairStart', renderer);
        const broken = r.broken.find(pose => pose.id === r.target.id),
          arriving = r.poses.find(pose => pose.id === r.target.id);
        assert.ok(broken?.damage >= 1);
        assert.equal(arriving?.phase, 'arriving');
        assert.ok(arriving.botProgress > 0 && arriving.botProgress < 1);
        await capture(
          'environment-' + renderer + '-arriving.png',
          {renderer, theme: renderer === 'year1998' ? 'year1998' : 'factory'},
          false,
        );
        const repairing = (await evaluate('environmentAdvance', 2700)).find(
          pose => pose.id === r.target.id,
        );
        assert.equal(repairing?.phase, 'repairing');
        assert.equal(repairing.botProgress, 1);
        assert.ok(
          repairing.repairProgress > 0 && repairing.damage < broken.damage,
        );
        await capture(
          'environment-' + renderer + '-repairing.png',
          {renderer, theme: renderer === 'year1998' ? 'year1998' : 'factory'},
          false,
        );
        const leaving = (await evaluate('environmentAdvance', 2000)).find(
          pose => pose.id === r.target.id,
        );
        assert.equal(leaving?.phase, 'leaving');
        assert.equal(leaving.damage, 0);
        assert.equal(leaving.chips, 0);
        assert.deepEqual(await evaluate('environmentAdvance', 2200), []);
        const reset = await evaluate('environmentReset');
        assert.ok(reset.burning.some(pose => pose.fire > 0));
        assert.ok(reset.still.some(pose => pose.scorch > 0));
        assert.ok(
          reset.still.every(pose => pose.fire === 0 && pose.botProgress === 0),
        );
        assert.deepEqual(reset.frozen, reset.still);
        assert.deepEqual(reset.reset, []);
        assert.deepEqual(reset.targetsAfterDispose, []);
        assert.equal(reset.dataRemoved, true);
        assert.equal(reset.unchanged, true);
      },
    );
  }
  for (const theme of ['factory', 'year1998'])
    await run(
      theme + ': theme host forwards environment targets and weapon damage',
      async () => {
        const r = await evaluate('environmentForwarding', theme);
        assert.ok(r.hits.some(hit => hit.accepted && hit.weapon === 'gun'));
        assert.ok(r.poses.some(pose => pose.chips > 0));
        assert.equal(r.unchanged, true);
      },
    );
  await run(
    'All palettes and shipped renderers show fire and real application toolbar controls',
    async () => {
      for (const renderer of ['webgl', 'fallback', 'year1998']) {
        const themes = renderer === 'year1998' ? ['year1998'] : report.themes;
        for (const theme of themes) {
          const r = await evaluate('screenshot', renderer, theme);
          assert.ok(r.pose.burning > 0);
          assert.equal(r.noPageScroll, true);
          assert.ok(
            r.controls.length >= 4 &&
              r.controls.every(c => c.visible && c.topmost),
            JSON.stringify(r.controls),
          );
          await capture('flamethrower-' + renderer + '-' + theme + '.png', {
            renderer,
            theme,
          });
          await evaluate('cleanup');
          const environment = await evaluate(
            'environmentPalette',
            renderer,
            theme,
          );
          assert.ok(environment.some(pose => pose.fire > 0 && pose.scorch > 0));
          assert.ok(environment.some(pose => pose.chips > 0));
          assert.ok(
            environment.some(
              pose => pose.phase === 'repairing' && pose.botProgress > 0,
            ),
          );
          await capture(
            'environment-palette-' + renderer + '-' + theme + '.png',
            {renderer, theme, environment: true},
            false,
          );
          await evaluate('cleanup');
        }
      }
    },
  );
  await run(
    'Charred corpses render after the flame stream is stowed in all shipped renderers',
    async () => {
      for (const renderer of ['webgl', 'fallback', 'year1998']) {
        const r = await evaluate('corpseScreenshot', renderer);
        assert.equal(r.pose.phase, 'wrecked');
        assert.equal(r.pose.char, 1);
        assert.equal(r.pose.collapse, 1);
        await capture(
          'flamethrower-' + renderer + '-corpse.png',
          {renderer, theme: renderer === 'year1998' ? 'year1998' : 'factory'},
          false,
        );
        await evaluate('cleanup');
      }
    },
  );
  await run(
    'Compact windows at supported zoom retain weapon controls and a usable scene',
    async () => {
      browser.setContentSize(720, 620);
      for (const renderer of ['webgl', 'fallback', 'year1998']) {
        for (const zoom of [0.8, 1, 1.5, 2]) {
          browser.webContents.setZoomFactor(zoom);
          await delay(60);
          const theme = renderer === 'year1998' ? 'year1998' : 'factory';
          const r = await evaluate('screenshot', renderer, theme);
          assert.equal(r.noPageScroll, true);
          assert.ok(
            r.controls.every(c => c.visible && c.topmost),
            JSON.stringify(r.controls),
          );
          assert.ok(
            r.host.width >= 300 && r.host.height >= 180,
            JSON.stringify(r),
          );
          await capture(
            'flamethrower-' + renderer + '-compact-' + zoom + '.png',
            {renderer, theme, compact: true, zoom},
          );
          await evaluate('cleanup');
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
    writeFileSync(
      join(
        screenshotDirectory,
        process.env.FACTORY_FLAMETHROWER_CAPTURE_ONLY
          ? 'capture-report.json'
          : 'report.json',
      ),
      JSON.stringify(report, null, 2),
    );
    browser?.destroy();
    app.exit(report.fatal ? 1 : 0);
  });
