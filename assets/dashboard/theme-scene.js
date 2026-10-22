/* global document */
import {createFactoryScene} from './factory-scene.js';
import {createYear1998Scene} from './year1998-scene.js';
import {createParentFallback} from './parent-fallback.js';
import {createParentMotion} from './parent-motion.js';
import {createFactoryVisitors, visitorCaneId} from './factory-visitors.js';
import {createRobotDamage} from './robot-damage.js';
import {createRobotWhip} from './robot-whip.js';
import {factoryIdentity, factoryIdentityPalette} from './factory-identity.js';

const HELPERS = Object.freeze({
  createParentMotion,
  createFactoryVisitors,
  visitorCaneId,
  createRobotDamage,
  createRobotWhip,
  factoryIdentity,
  factoryIdentityPalette,
});
const REQUIRED = ['update', 'setPalette', 'setMotion', 'dispose'];

/** Own the canvas and replay session state when a theme changes its renderer. */
export function createThemeScene(
  initialCanvas,
  {
    fallbackContainer,
    agentsForBuiltin,
    onSelect = () => {},
    onLayout = () => {},
    onAvailability = () => {},
    onError = () => {},
  },
) {
  let canvas = initialCanvas;
  let renderer;
  let available = false;
  let disposed = false;
  let revision = 0;
  let rendererRevision = 0;
  let requestedKey;
  let rendererKind;
  let palette;
  let snapshot;
  let hub;
  let selected = 'parent';
  let motion = false;
  let startled;
  const label = canvas.getAttribute('aria-label');

  function release() {
    const previous = renderer;
    renderer = undefined;
    rendererRevision++;
    try {
      if (typeof previous?.dispose === 'function') previous.dispose();
    } catch (error) {
      onError(`Scene cleanup failed: ${error?.message || String(error)}`);
    }
  }
  function newCanvas(kind) {
    const next = document.createElement('canvas');
    next.id = initialCanvas.id;
    next.className = initialCanvas.className;
    if (label) next.setAttribute('aria-label', label);
    next.dataset.renderer = kind;
    canvas.replaceWith(next);
    canvas = next;
  }
  function sceneSnapshot() {
    return snapshot && rendererKind !== 'plugin' && agentsForBuiltin
      ? {...snapshot, agents: agentsForBuiltin(snapshot)}
      : snapshot;
  }
  function replay() {
    renderer.setMotion(motion);
    if (palette) renderer.setPalette?.(palette);
    if (hub) renderer.updateHub?.(hub);
    if (snapshot) renderer.update(sceneSnapshot(), selected);
    if (startled !== undefined) renderer.startle?.(startled);
  }
  function install(create, kind) {
    release();
    rendererKind = kind;
    newCanvas(kind);
    onLayout([]);
    const current = rendererRevision;
    let installing = true;
    let latestLayout = [];
    const callbacks = {
      apiVersion: 1,
      helpers: HELPERS,
      onSelect(id) {
        if (!disposed && current === rendererRevision) onSelect(id);
      },
      onLayout(layout) {
        if (disposed || current !== rendererRevision) return;
        latestLayout = layout;
        if (!installing) onLayout(layout);
      },
    };
    renderer = create(canvas, callbacks);
    if (kind === 'plugin') {
      if (
        !renderer ||
        REQUIRED.some(name => typeof renderer[name] !== 'function')
      )
        throw new Error(`Custom scenes must implement ${REQUIRED.join(', ')}.`);
    }
    available = Boolean(renderer);
    if (!renderer) renderer = createParentFallback(fallbackContainer);
    canvas.hidden = !available;
    onAvailability(available);
    replay();
    installing = false;
    onLayout(latestLayout);
  }
  function recover(error) {
    onError(
      `Could not display theme scene: ${error?.message || String(error)}`,
    );
    try {
      install(createFactoryScene, 'factory');
    } catch {
      release();
      available = false;
      canvas.hidden = true;
      renderer = createParentFallback(fallbackContainer);
      onAvailability(false);
      replay();
    }
  }
  function invoke(method, ...args) {
    if (disposed) return;
    try {
      return renderer?.[method]?.(...args);
    } catch (error) {
      recover(error);
    }
  }

  return {
    hasCanvas: () => available,
    async setTheme(entry, nextPalette) {
      if (disposed) return;
      palette = nextPalette;
      const descriptor = entry.scene ?? 'factory';
      const key =
        typeof descriptor === 'string'
          ? descriptor
          : `${descriptor.apiVersion}:${descriptor.moduleUrl}`;
      if (requestedKey === key) {
        if (palette) invoke('setPalette', palette);
        return;
      }
      requestedKey = key;
      const request = ++revision;
      onError('');
      try {
        if (typeof descriptor === 'string') {
          if (!['factory', 'year1998'].includes(descriptor))
            throw new Error(`Unknown scene renderer: ${descriptor}`);
          install(
            descriptor === 'year1998'
              ? createYear1998Scene
              : createFactoryScene,
            descriptor,
          );
        } else {
          if (
            descriptor.apiVersion !== 1 ||
            typeof descriptor.moduleUrl !== 'string'
          )
            throw new Error('Unsupported theme scene API version.');
          const module = await import(descriptor.moduleUrl);
          if (disposed || request !== revision) return;
          if (
            module.apiVersion !== 1 ||
            typeof module.createScene !== 'function'
          )
            throw new Error(
              'Scene modules must export apiVersion = 1 and createScene.',
            );
          install(module.createScene, 'plugin');
        }
      } catch (error) {
        if (!disposed && request === revision) recover(error);
      }
    },
    updateHub(value) {
      hub = value;
      invoke('updateHub', value);
    },
    update(value, id = 'parent') {
      if (snapshot?.session?.id !== value?.session?.id) {
        startled = undefined;
      }
      snapshot = value;
      selected = id;
      invoke('update', sceneSnapshot(), id);
    },
    setMotion(enabled) {
      motion = Boolean(enabled);
      invoke('setMotion', motion);
    },
    prompt(id) {
      invoke('prompt', id);
    },
    cancelPrompt(id) {
      invoke('cancelPrompt', id);
    },
    startle(animate) {
      startled = animate;
      invoke('startle', animate);
    },
    clearStartle() {
      startled = undefined;
      invoke('clearStartle');
    },
    caneTargets: () => invoke('caneTargets') || [],
    hitWithCane: (id, direction, strength) =>
      invoke('hitWithCane', id, direction, strength) || false,
    burnRobot: (id, seconds) => invoke('burnRobot', id, seconds) || false,
    environmentTargets: () => invoke('environmentTargets') || [],
    hitEnvironment: (id, weapon, amount) =>
      invoke('hitEnvironment', id, weapon, amount) || false,
    dispose() {
      if (disposed) return;
      disposed = true;
      revision++;
      release();
      snapshot = hub = undefined;
    },
  };
}
