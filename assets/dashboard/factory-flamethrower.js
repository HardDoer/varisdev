import {createFactoryFireAudio} from './factory-fire-audio.js';
import {validSceneTarget, visibleSceneTargets} from './factory-targets.js';

const NS = 'http://www.w3.org/2000/svg';
const CONTROLS =
  'button, a, input, textarea, select, label, summary, [role="button"], [role="link"], [role="menuitem"], [role="slider"], [role="checkbox"], [role="switch"], [role="textbox"], [role="combobox"], [role="tab"], [contenteditable]:not([contenteditable="false"])';
const SPREAD = 25;

// The widening flame jet can catch more than one robot along its length.
export function flameTargetsAt(muzzle, aim, targets = []) {
  if (
    !muzzle ||
    !aim ||
    ![muzzle.x, muzzle.y, aim.x, aim.y].every(Number.isFinite) ||
    !Array.isArray(targets)
  )
    return [];
  const dx = aim.x - muzzle.x,
    dy = aim.y - muzzle.y;
  const length = Math.hypot(dx, dy);
  if (!length) return [];
  return targets.filter(target => {
    if (!validSceneTarget(target)) return false;
    const along =
      ((target.x - muzzle.x) * dx + (target.y - muzzle.y) * dy) / length;
    if (along < -target.radius || along > length + target.radius) return false;
    const t = Math.max(0, Math.min(1, along / length));
    const distance = Math.hypot(
      target.x - muzzle.x - dx * t,
      target.y - muzzle.y - dy * t,
    );
    return distance <= target.radius + SPREAD * t;
  });
}

export function createFactoryFlamethrower(
  container,
  {
    holsterContainer = container,
    getTargets = () => [],
    getEnvironmentTargets = () => [],
    onEnvironmentHit = () => false,
    onBurn = () => false,
    onEquip = () => {},
  } = {},
) {
  const document = container.ownerDocument,
    window = document.defaultView;
  const inToolbar = holsterContainer !== container;
  const audio = createFactoryFireAudio(window);
  const svg = (tag, attributes = {}) => {
    const element = document.createElementNS(NS, tag);
    for (const [name, value] of Object.entries(attributes))
      element.setAttribute(name, value);
    return element;
  };
  function weapon() {
    const group = svg('g');
    group.append(
      svg('path', {
        d: 'M18 13 L36 13 L37 28 L27 34 L18 30 Z',
        class: 'flame-tank',
      }),
      svg('path', {d: 'M30 29 L26 44 L17 42 L21 27 Z', class: 'flame-grip'}),
      svg('path', {d: 'M34 28 Q50 48 54 28 L54 19', class: 'flame-hose'}),
      svg('path', {d: 'M6 12 L49 12 L49 23 L6 23 Z', class: 'flame-body'}),
      svg('path', {d: 'M4 10 L13 10 L13 25 L4 25 Z', class: 'flame-nozzle'}),
      svg('path', {
        d: 'M20 14 V21 M26 14 V21 M32 14 V21',
        class: 'flame-vents',
      }),
      svg('path', {d: 'M38 9 H44 V12 M15 10 V7 H20 V10', class: 'flame-vents'}),
    );
    return group;
  }
  const holster = document.createElement('button');
  holster.type = 'button';
  holster.className = 'factory-flamethrower-holster';
  holster.classList.toggle('factory-flamethrower-toolbar', inToolbar);
  holster.hidden = inToolbar;
  const icon = svg('svg', {
    viewBox: '0 0 60 48',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  icon.append(weapon());
  const label = document.createElement('span');
  const name = document.createElement('strong');
  name.textContent = 'Flamethrower';
  const action = document.createElement('small');
  label.append(name, action);
  holster.append(icon, label);
  if (inToolbar) holsterContainer.prepend(holster);
  else container.append(holster);

  const layer = document.createElement('div');
  layer.className = 'factory-flamethrower-layer';
  layer.setAttribute('aria-hidden', 'true');
  if (typeof layer.showPopover === 'function')
    layer.setAttribute('popover', 'manual');
  const overlay = svg('svg', {
    class: 'factory-flamethrower-overlay',
    'aria-hidden': 'true',
  });
  const stream = svg('g', {class: 'flame-stream'});
  const outer = svg('path', {class: 'flame-jet-outer'});
  const inner = svg('path', {class: 'flame-jet-inner'});
  stream.append(outer, inner);
  const sparks = Array.from({length: 12}, () =>
    svg('path', {class: 'flame-ember'}),
  );
  stream.append(...sparks);
  const held = weapon();
  held.setAttribute('class', 'flamethrower-held');
  const reticle = svg('g', {class: 'flame-reticle'});
  reticle.append(
    svg('circle', {r: '12', class: 'flame-reticle-back'}),
    svg('path', {
      d: 'M-17 0 H-7 M7 0 H17 M0 -17 V-7 M0 7 V17',
      class: 'flame-reticle-lines',
    }),
  );
  overlay.append(stream, held, reticle);
  layer.append(overlay);
  document.body.append(layer);

  let equipped = false,
    firing = false,
    disposed = false,
    motion = true;
  let pointer = null,
    frame = 0,
    previous = 0,
    sessionId,
    pointerId;
  function stop() {
    firing = false;
    pointerId = undefined;
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    stream.style.display = 'none';
    container.dataset.flamethrowerFiring = 'false';
    audio.stop();
  }
  function resetPointer() {
    stop();
    pointer = null;
    held.style.display = reticle.style.display = 'none';
    document.documentElement.classList.remove('factory-flamethrower-active');
  }
  function raiseOverlay() {
    if (!equipped || disposed || !layer.showPopover) return;
    if (layer.matches(':popover-open')) layer.hidePopover();
    layer.showPopover();
  }
  function equip(value) {
    if (disposed) return;
    const pickedUp = value && !equipped;
    resetPointer();
    equipped = Boolean(value);
    container.dataset.flamethrowerEquipped = String(equipped);
    layer.hidden = !equipped;
    if (equipped) raiseOverlay();
    else if (layer.hidePopover && layer.matches(':popover-open'))
      layer.hidePopover();
    holster.setAttribute('aria-pressed', String(equipped));
    holster.setAttribute(
      'aria-label',
      equipped ? 'Put away flamethrower' : 'Pick up flamethrower',
    );
    holster.title = equipped
      ? 'Hold left mouse button to spray flames · Right-click or Esc to put away'
      : 'Pick up flamethrower';
    action.textContent = equipped ? 'Put away' : 'Pick up';
    if (pickedUp) onEquip();
  }
  const stow = () => equip(false);
  function sceneEvent(event) {
    if (!container.contains(event.target)) return false;
    const control = event.target.closest?.(CONTROLS);
    if (control && !control.matches('.fallback-station')) return false;
    const rect = container.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      event.clientX >= Math.max(0, rect.left) &&
      event.clientX <= Math.min(window.innerWidth, rect.right) &&
      event.clientY >= Math.max(0, rect.top) &&
      event.clientY <= Math.min(window.innerHeight, rect.bottom)
    );
  }
  function paintPointer() {
    if (!pointer) return null;
    const sx = pointer.x + 160 < window.innerWidth ? 1 : -1;
    const sy = pointer.y + 115 < window.innerHeight ? 1 : -1;
    const muzzle = {x: pointer.x + sx * 95, y: pointer.y + sy * 62};
    const angle =
      (Math.atan2(muzzle.y - pointer.y, muzzle.x - pointer.x) * 180) / Math.PI;
    overlay.setAttribute(
      'viewBox',
      `0 0 ${window.innerWidth} ${window.innerHeight}`,
    );
    held.style.display = reticle.style.display = '';
    held.setAttribute(
      'transform',
      `translate(${muzzle.x} ${muzzle.y}) rotate(${angle}) scale(1 ${sx}) translate(-4 -17)`,
    );
    reticle.setAttribute('transform', `translate(${pointer.x} ${pointer.y})`);
    document.documentElement.classList.add('factory-flamethrower-active');
    return muzzle;
  }
  function paintStream(muzzle, now) {
    const dx = pointer.x - muzzle.x,
      dy = pointer.y - muzzle.y;
    const length = Math.hypot(dx, dy);
    const phase = motion ? now / 75 : 0;
    stream.style.display = '';
    stream.setAttribute(
      'transform',
      `translate(${muzzle.x} ${muzzle.y}) rotate(${(Math.atan2(dy, dx) * 180) / Math.PI})`,
    );
    const wave = Math.sin(phase) * 4;
    outer.setAttribute(
      'd',
      `M0 -3 Q${length * 0.4} ${-12 + wave} ${length * 0.72} -17 L${length * 0.94} -27 L${length * 0.9} -12 L${length + 16} -9 L${length + 5} 0 L${length + 12} 18 L${length * 0.86} 14 L${length * 0.92} 25 Q${length * 0.4} ${12 + wave} 0 3 Z`,
    );
    inner.setAttribute(
      'd',
      `M0 -1 Q${length * 0.5} -7 ${length * 0.91} -10 L${length * 0.8} 0 L${length} 8 Q${length * 0.4} 6 0 1 Z`,
    );
    sparks.forEach((spark, i) => {
      const t = ((motion ? now / 450 : 0.5) + i / sparks.length) % 1;
      const x = length * t,
        y = Math.sin(i * 2.4 + phase * 0.35) * SPREAD * t;
      spark.setAttribute('d', `M${x} ${y} l${4 + t * 7} ${-2 - t * 2}`);
      spark.setAttribute('opacity', String(0.3 + 0.7 * t));
    });
  }
  function spray(now) {
    frame = 0;
    if (!firing || !pointer || disposed) return;
    const seconds = Math.max(0, Math.min(0.1, (now - previous) / 1000));
    previous = now;
    const muzzle = paintPointer();
    paintStream(muzzle, now);
    const rect = container.getBoundingClientRect();
    const visible = visibleSceneTargets(getTargets(), rect, window);
    const hitIds = new Set();
    for (const target of flameTargetsAt(muzzle, pointer, visible)) {
      if (!firing || disposed) return;
      if (hitIds.has(target.id) || seconds <= 0) continue;
      hitIds.add(target.id);
      if (onBurn(target.id, seconds) !== false && firing && !disposed)
        audio.scream(target.id);
    }
    if (seconds > 0 && firing && !disposed) {
      const environmentIds = new Set();
      const environment = visibleSceneTargets(
        getEnvironmentTargets(),
        rect,
        window,
      );
      for (const target of flameTargetsAt(muzzle, pointer, environment)) {
        if (!firing || disposed) return;
        if (environmentIds.has(target.id)) continue;
        environmentIds.add(target.id);
        onEnvironmentHit(target.id, 'flame', seconds);
      }
    }
    if (firing && !disposed) frame = window.requestAnimationFrame(spray);
  }
  function move(event) {
    if (!equipped || event.pointerType === 'touch') return;
    if (![event.clientX, event.clientY].every(Number.isFinite)) return;
    if (firing && (!sceneEvent(event) || event.buttons === 0)) stop();
    if (sceneEvent(event)) event.stopPropagation();
    pointer = {x: event.clientX, y: event.clientY};
    paintPointer();
  }
  function down(event) {
    if (
      !equipped ||
      event.button !== 0 ||
      event.pointerType === 'touch' ||
      !sceneEvent(event)
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (firing) return;
    pointer = {x: event.clientX, y: event.clientY};
    pointerId = event.pointerId;
    firing = true;
    container.dataset.flamethrowerFiring = 'true';
    audio.start();
    previous = window.performance.now() - 1000 / 60;
    spray(window.performance.now());
  }
  function up(event) {
    if (
      firing &&
      (event.pointerId === pointerId || event.pointerId === undefined)
    )
      stop();
  }
  function click(event) {
    if (!equipped || event.detail === 0 || !sceneEvent(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  function cancel(event) {
    if (
      !equipped ||
      (event.type === 'keydown' &&
        (event.key !== 'Escape' || event.isComposing))
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    stow();
  }
  const listeners = [];
  function listen(target, type, handler, capture = false) {
    target.addEventListener(type, handler, capture);
    listeners.push(() => target.removeEventListener(type, handler, capture));
  }
  listen(holster, 'click', event => {
    equip(!equipped);
    if (equipped && event.detail > 0) move(event);
  });
  listen(document, 'pointermove', move, true);
  listen(container, 'pointerdown', down, true);
  listen(container, 'click', click, true);
  listen(container, 'dblclick', click, true);
  listen(document, 'pointerup', up, true);
  listen(document, 'pointercancel', stow);
  listen(document, 'pointerout', event => {
    if (!event.relatedTarget) resetPointer();
  });
  listen(document, 'contextmenu', cancel, true);
  listen(document, 'keydown', cancel, true);
  listen(document, 'visibilitychange', () => {
    if (document.hidden) stow();
  });
  listen(document, 'scroll', resetPointer, true);
  listen(
    document,
    'toggle',
    event => {
      if (event.target !== layer && event.newState === 'open') {
        stop();
        raiseOverlay();
      }
    },
    true,
  );
  listen(container, 'webglcontextlost', stow, true);
  listen(window, 'blur', stow);
  listen(window, 'resize', resetPointer);
  equip(false);
  return {
    setSession(id) {
      if (disposed) return;
      if (inToolbar) holster.hidden = !id;
      if (id !== sessionId) {
        sessionId = id;
        stow();
      }
    },
    setMotion(value) {
      if (disposed) return;
      motion = Boolean(value);
      resetPointer();
    },
    stow,
    dispose() {
      if (disposed) return;
      stow();
      disposed = true;
      for (const remove of listeners) remove();
      audio.dispose();
      layer.remove();
      holster.remove();
      delete container.dataset.flamethrowerEquipped;
      delete container.dataset.flamethrowerFiring;
    },
  };
}
