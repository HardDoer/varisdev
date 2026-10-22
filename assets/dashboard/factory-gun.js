import {validSceneTarget, visibleSceneTargets} from './factory-targets.js';

const NS = 'http://www.w3.org/2000/svg';
const COOLDOWN = 180;
const EFFECT_DURATION = 260;
const CONTROLS =
  'button, a, input, textarea, select, label, summary, [role="button"], [role="link"], [role="menuitem"], [role="slider"], [role="checkbox"], [role="switch"], [role="textbox"], [role="combobox"], [role="tab"], [contenteditable]:not([contenteditable="false"]), .factory-cane-holster, .factory-gun-holster';

// Viewport coordinates; ties retain the first target and never mutate the list.
export function gunTargetAt(x, y, targets = []) {
  if (![x, y].every(Number.isFinite) || !Array.isArray(targets)) return null;
  let nearest = null,
    distance = Infinity;
  for (const target of targets) {
    if (!validSceneTarget(target)) continue;
    const d = Math.hypot(target.x - x, target.y - y);
    if (d <= target.radius && d < distance) {
      nearest = target;
      distance = d;
    }
  }
  return nearest;
}

export function createFactoryGun(
  container,
  {
    holsterContainer = container,
    getTargets = () => [],
    getEnvironmentTargets = () => [],
    onEnvironmentHit = () => false,
    onHit = () => true,
    onEquip = () => {},
  } = {},
) {
  const document = container.ownerDocument,
    window = document.defaultView;
  const inToolbar = holsterContainer !== container;
  const svg = (tag, attributes = {}) => {
    const element = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attributes))
      element.setAttribute(key, value);
    return element;
  };
  function pistol(held = false) {
    const group = svg('g');
    if (held) {
      // The slide recedes toward the aim; the rear sight and grip face the user.
      group.append(
        svg('path', {
          d: 'M12 61 L34 54 L40 93 L18 100 Z',
          class: 'gun-grip',
        }),
        svg('path', {
          d: 'M16 71 L35 65 M17 79 L36 73 M18 87 L37 81 M19 95 L38 89',
          class: 'gun-grip-lines',
        }),
        svg('path', {
          d: 'M3 43 L40 32 L38 62 L12 70 Z',
          class: 'gun-body',
        }),
        svg('path', {
          d: 'M8 -4 L14 0 L44 28 L40 47 L37 27 Z',
          class: 'gun-side',
        }),
        svg('path', {
          d: 'M-10 0 L8 -4 L38 26 L4 37 Z',
          class: 'gun-slide',
        }),
        svg('path', {
          d: 'M-5 1 L4 -1 L26 25 L17 28 Z',
          class: 'gun-slide-highlight',
        }),
        svg('path', {
          d: 'M4 37 L38 26 L40 47 L6 58 Z',
          class: 'gun-rear',
        }),
        svg('path', {
          d: 'M12 41 L31 35 L32 43 L13 49 Z',
          class: 'gun-backplate',
        }),
        svg('path', {
          d: 'M3 36 V27 L13 24 L16 30 L25 27 L23 21 L33 18 L38 27 Z',
          class: 'gun-sight',
        }),
        svg('path', {d: 'M-3 0 L-4 -7 L1 -8 L3 -1 Z', class: 'gun-sight'}),
        svg('path', {d: 'M8 29 L11 28 M28 23 L31 22', class: 'gun-sight-dots'}),
      );
    } else {
      group.append(
        svg('path', {
          d: 'M27 19 H44 V27 Q44 31 39 31 H27 Z',
          class: 'gun-trigger-guard',
        }),
        svg('path', {d: 'M34 21 V25 L32 27', class: 'gun-trigger'}),
        svg('path', {
          d: 'M12 18 H33 L30 25 H26 L22 43 H8 L14 25 H10 Z',
          class: 'gun-body',
        }),
        svg('path', {d: 'M15 26 H25 L21 41 H10 Z', class: 'gun-grip'}),
        svg('path', {
          d: 'M14 30 H23 M13 34 H22 M12 38 H21',
          class: 'gun-grip-lines',
        }),
        svg('path', {
          d: 'M7 8 H57 V20 H6 V12 Z',
          class: 'gun-slide',
        }),
        svg('path', {
          d: 'M9 5 H14 V8 H9 Z M50 5 H54 V8 H50 Z',
          class: 'gun-sight',
        }),
        svg('path', {
          d: 'M12 11 V17 M17 11 V17 M22 11 V17',
          class: 'gun-serrations',
        }),
        svg('path', {d: 'M57 11 V17', class: 'gun-trigger'}),
      );
    }
    return group;
  }
  const holster = document.createElement('button');
  holster.type = 'button';
  holster.className = 'factory-gun-holster';
  holster.classList.toggle('factory-gun-toolbar', inToolbar);
  holster.hidden = inToolbar;
  const icon = svg('svg', {
    viewBox: '0 0 64 48',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  const stored = pistol();
  icon.append(stored);
  const label = document.createElement('span');
  const name = document.createElement('strong');
  name.textContent = 'Gun';
  const action = document.createElement('small');
  label.append(name, action);
  holster.append(icon, label);

  // The manual popover supplies a noninteractive top layer above app dialogs.
  const layer = document.createElement('div');
  layer.className = 'factory-gun-layer';
  if (typeof layer.showPopover === 'function')
    layer.setAttribute('popover', 'manual');
  layer.setAttribute('aria-hidden', 'true');
  const overlay = svg('svg', {
    class: 'factory-gun-overlay',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  const effects = svg('g');
  const held = pistol(true);
  held.setAttribute('class', 'gun-held');
  const crosshair = svg('g', {class: 'gun-crosshair'});
  crosshair.append(
    svg('circle', {r: '10', class: 'gun-reticle-backing'}),
    svg('path', {
      d: 'M-15 0 H-7 M7 0 H15 M0 -15 V-7 M0 7 V15',
      class: 'gun-reticle-outline',
    }),
    svg('path', {
      d: 'M-15 0 H-7 M7 0 H15 M0 -15 V-7 M0 7 V15',
      class: 'gun-reticle-lines',
    }),
    svg('circle', {r: '1.5', class: 'gun-reticle-dot'}),
  );
  overlay.append(effects, held, crosshair);
  layer.append(overlay);
  document.body.append(layer);
  if (inToolbar) holsterContainer.prepend(holster);
  else container.append(holster);

  let equipped = false,
    motion = true,
    disposed = false,
    sessionId,
    pointer = null,
    shot = null,
    lastShot = -Infinity,
    frame = 0,
    effectTimer = 0;

  function clearEffects() {
    if (frame) window.cancelAnimationFrame(frame);
    if (effectTimer) window.clearTimeout(effectTimer);
    frame = effectTimer = 0;
    shot = null;
    effects.replaceChildren();
    delete container.dataset.gunHit;
  }
  function resetPointer() {
    clearEffects();
    pointer = null;
    held.style.display = crosshair.style.display = 'none';
    document.documentElement.classList.remove('factory-gun-active');
  }
  function raiseOverlay() {
    if (!equipped || disposed || !layer.showPopover) return;
    if (layer.matches(':popover-open')) layer.hidePopover();
    layer.showPopover();
  }
  function equip(value) {
    if (disposed) return;
    const next = Boolean(value),
      pickedUp = next && !equipped;
    resetPointer();
    equipped = next;
    lastShot = -Infinity;
    container.dataset.gunEquipped = String(equipped);
    if (!equipped && layer.hidePopover && layer.matches(':popover-open'))
      layer.hidePopover();
    layer.hidden = !equipped;
    if (equipped) raiseOverlay();
    holster.setAttribute('aria-pressed', String(equipped));
    holster.setAttribute(
      'aria-label',
      equipped ? 'Return gun to holster' : 'Pick up gun',
    );
    holster.title = equipped
      ? 'Click the scene to fire · Right-click or Esc to holster'
      : 'Pick up gun';
    action.textContent = equipped ? 'Holster' : 'Pick up';
    if (pickedUp) onEquip();
  }
  function stow() {
    equip(false);
  }
  function sceneEvent(event) {
    const control = event.target.closest?.(CONTROLS);
    // Fallback robot buttons are scene targets; their nested controls stay usable.
    if (
      !container.contains(event.target) ||
      (control && !control.matches('.fallback-station'))
    )
      return false;
    const rect = container.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom
    );
  }
  function paintPointer(now) {
    if (!pointer) return null;
    const {x, y} = pointer;
    const sx = x + 100 < window.innerWidth ? 1 : -1;
    const recoil = motion && shot ? Math.max(0, 1 - (now - shot.at) / 120) : 0;
    const muzzle = {
      x: x + sx * 26,
      y: Math.min(y + 24, window.innerHeight - 110),
    };
    const angle = (Math.atan2(y - muzzle.y, x - muzzle.x) * 180) / Math.PI;
    overlay.setAttribute(
      'viewBox',
      `0 0 ${window.innerWidth} ${window.innerHeight}`,
    );
    held.style.display = crosshair.style.display = '';
    held.setAttribute(
      'transform',
      `translate(${muzzle.x} ${muzzle.y + recoil * 5}) scale(${sx * (1 + recoil * 0.04)} ${1 + recoil * 0.04})`,
    );
    crosshair.setAttribute('transform', `translate(${x} ${y})`);
    document.documentElement.classList.add('factory-gun-active');
    return {...muzzle, angle};
  }
  function paintEffects(now) {
    frame = 0;
    if (!shot || !equipped || disposed) return;
    const elapsed = now - shot.at;
    if (elapsed >= EFFECT_DURATION) {
      clearEffects();
      paintPointer(now);
      return;
    }
    shot.flash.setAttribute('opacity', String(Math.max(0, 1 - elapsed / 90)));
    shot.tracer.setAttribute('opacity', String(Math.max(0, 1 - elapsed / 140)));
    shot.impact.setAttribute('opacity', String(1 - elapsed / EFFECT_DURATION));
    shot.impact.setAttribute(
      'transform',
      `translate(${shot.x} ${shot.y}) scale(${0.8 + (elapsed / EFFECT_DURATION) * 0.5})`,
    );
    paintPointer(now);
    frame = window.requestAnimationFrame(paintEffects);
  }
  function fire(x, y) {
    if (![x, y].every(Number.isFinite)) return;
    const now = window.performance.now();
    if (now - lastShot < COOLDOWN) return;
    lastShot = now;
    pointer = {x, y};
    const muzzle = paintPointer(now);
    const rect = container.getBoundingClientRect();
    const visibleTargets = visibleSceneTargets(getTargets(), rect, window);
    const target = gunTargetAt(x, y, visibleTargets);
    const environment = target
      ? null
      : gunTargetAt(
          x,
          y,
          visibleSceneTargets(getEnvironmentTargets(), rect, window),
        );
    const hit = target
      ? onHit(target.id, target.x < muzzle.x ? -1 : 1, 2) !== false
      : environment && onEnvironmentHit(environment.id, 'gun', 1) !== false;
    if (!equipped || disposed) return;
    clearEffects();
    if (hit) container.dataset.gunHit = String((target || environment).id);

    const tracer = svg('g');
    const line = `M${muzzle.x} ${muzzle.y} L${x} ${y}`;
    tracer.append(
      svg('path', {d: line, class: 'gun-effect-outline'}),
      svg('path', {d: line, class: 'gun-tracer'}),
    );
    const flash = svg('g', {
      transform: `translate(${muzzle.x} ${muzzle.y}) rotate(${muzzle.angle})`,
    });
    flash.append(
      svg('path', {
        d: 'M-15 0 L-5 -4 L-2 -11 L2 -4 L9 0 L2 4 L-2 11 L-5 4 Z',
        class: 'gun-muzzle',
      }),
      svg('circle', {r: '2.5', class: 'gun-muzzle-core'}),
    );
    const impact = svg('g', {
      class: `gun-impact${hit ? '' : ' gun-impact-miss'}`,
      transform: `translate(${x} ${y})`,
    });
    const rays = hit
      ? 'M-21 0 H-14 M14 0 H21 M0 -21 V-14 M0 14 V21 M-15 -15 L-10 -10 M10 10 L15 15 M15 -15 L10 -10 M-10 10 L-15 15'
      : 'M-16 -16 L-11 -11 M11 11 L16 16 M16 -16 L11 -11 M-11 11 L-16 16';
    const ringRadius = hit ? '17' : '15';
    impact.append(
      svg('path', {d: rays, class: 'gun-effect-outline'}),
      svg('path', {d: rays, class: 'gun-impact-rays'}),
      svg('circle', {r: ringRadius, class: 'gun-impact-ring-outline'}),
      svg('circle', {r: ringRadius, class: 'gun-impact-ring'}),
    );
    effects.append(tracer, flash, impact);
    shot = {at: now, x, y, tracer, flash, impact};
    if (motion) paintEffects(now);
    else {
      effectTimer = window.setTimeout(() => {
        effectTimer = 0;
        clearEffects();
      }, EFFECT_DURATION);
    }
  }
  function onMove(event) {
    if (!equipped || event.pointerType === 'touch') return;
    if (![event.clientX, event.clientY].every(Number.isFinite)) return;
    if (sceneEvent(event)) event.stopPropagation();
    pointer = {x: event.clientX, y: event.clientY};
    paintPointer(window.performance.now());
  }
  function toggle(event) {
    equip(!equipped);
    if (equipped && event.detail > 0) onMove(event);
  }
  function onSceneDown(event) {
    if (!equipped || event.button !== 0 || !sceneEvent(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  function onSceneClick(event) {
    if (!equipped || event.detail === 0 || !sceneEvent(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.button === 0 && event.pointerType !== 'touch')
      fire(event.clientX, event.clientY);
  }
  function onKey(event) {
    if (!equipped || event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    stow();
  }
  function onContextMenu(event) {
    if (!equipped) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    stow();
  }
  function onWindowLeave(event) {
    if (equipped && !event.relatedTarget) resetPointer();
  }
  function onVisibility() {
    if (document.hidden) stow();
  }
  function onLayerToggle(event) {
    if (event.target !== layer && event.newState === 'open') raiseOverlay();
  }
  const listeners = [];
  function listen(target, type, handler, capture = false) {
    target.addEventListener(type, handler, capture);
    listeners.push(() => target.removeEventListener(type, handler, capture));
  }
  listen(holster, 'click', toggle);
  listen(document, 'pointermove', onMove, true);
  listen(document, 'pointerout', onWindowLeave);
  listen(document, 'pointercancel', stow);
  listen(document, 'contextmenu', onContextMenu, true);
  listen(document, 'keydown', onKey, true);
  listen(document, 'toggle', onLayerToggle, true);
  listen(document, 'visibilitychange', onVisibility);
  listen(document, 'scroll', resetPointer, true);
  listen(container, 'pointerdown', onSceneDown, true);
  listen(container, 'click', onSceneClick, true);
  listen(container, 'dblclick', onSceneDown, true);
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
      layer.remove();
      holster.remove();
      delete container.dataset.gunEquipped;
    },
  };
}
