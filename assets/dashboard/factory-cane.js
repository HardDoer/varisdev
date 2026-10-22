// A local toy: swinging never sends commands or changes a session's state.
import {
  visibleSceneTargets,
  exposedPolygonContact,
  polygonOcclusion,
} from './factory-targets.js';

const NS = 'http://www.w3.org/2000/svg';
const SHAFT = 'M0 6 V-92 A12 12 0 0 1 24 -92 V-82';
const COOLDOWN = 320;
const MAX_PENDING_MOVES = 128;
const MIN_SWING_SPEED = 0.18; // CSS pixels per millisecond.
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export function canePoints(x, y, angle) {
  const points = [
    [0, 6],
    [0, -92],
  ];
  for (let i = 1; i <= 8; i++) {
    const a = Math.PI + (i / 8) * Math.PI;
    points.push([12 + Math.cos(a) * 12, -92 + Math.sin(a) * 12]);
  }
  points.push([24, -82]);
  return points.map(([px, py]) => [
    x + px * Math.cos(angle) - py * Math.sin(angle),
    y + px * Math.sin(angle) + py * Math.cos(angle),
  ]);
}

function segmentDistance(p, a, b) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const t = clamp(
    ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1),
    0,
    1,
  );
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function triangleContains(p, a, b, c) {
  const cross = (a, b, c) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  // Degenerate triangles must not make every collinear target a hit.
  if (Math.abs(cross(a, b, c)) < 0.001) return false;
  const sides = [cross(a, b, p), cross(b, c, p), cross(c, a, p)];
  return sides.every(n => n >= 0) || sides.every(n => n <= 0);
}

// Sweep the whole shaft and crook, not just the cursor, so a quick wave cannot
// tunnel through a drone between pointer events.
export function caneSweepContact(before, after, target, covers = []) {
  if (!target.polygon) return null;
  for (let i = 1; i < before.length; i++) {
    const a = before[i - 1],
      b = before[i],
      c = after[i],
      d = after[i - 1];
    for (const triangle of [
      [a, b, c],
      [a, c, d],
    ]) {
      const contact = exposedPolygonContact(
        target.polygon,
        triangle.map(([x, y]) => ({x, y})),
        4,
        covers,
      );
      if (contact) return contact;
    }
  }
  return null;
}

export function caneSweepHits(before, after, target) {
  if (target.polygon) return Boolean(caneSweepContact(before, after, target));
  const p = [target.x, target.y],
    radius = target.radius + 4;
  for (let i = 1; i < before.length; i++) {
    const a = before[i - 1],
      b = before[i],
      c = after[i],
      d = after[i - 1];
    if (
      [
        [a, b],
        [b, c],
        [c, d],
        [d, a],
      ].some(([u, v]) => segmentDistance(p, u, v) <= radius) ||
      triangleContains(p, a, b, c) ||
      triangleContains(p, a, c, d)
    )
      return true;
  }
  return false;
}

export function createCaneSwing() {
  let previous = null;
  const hits = new Map();
  return {
    reset() {
      previous = null;
      hits.clear();
    },
    move(x, y, now, targets, motion = true) {
      if (![x, y, now].every(Number.isFinite)) {
        previous = null;
        return {angle: -0.3, hits: [], direction: 1, strength: 0.35};
      }
      const dt = previous ? now - previous.now : 0;
      const continuous = previous && dt > 0 && dt <= 180;
      const dx = continuous ? x - previous.x : 0;
      const distance = continuous ? Math.hypot(dx, y - previous.y) : 0;
      const angle =
        motion && continuous
          ? previous.angle +
            (clamp(dx / dt, -1.1, 1.1) - previous.angle) *
              (1 - Math.exp(-dt / 55))
          : -0.3;
      const points = canePoints(x, y, angle);
      const speed = continuous ? distance / dt : 0;
      // A gentle wave nudges; a fast flick kicks, without unbounded impulses.
      const strength = clamp(0.35 + (speed - MIN_SWING_SPEED) * 0.6, 0.35, 2.2);
      const struck = [];
      for (const [id, at] of hits) if (now - at >= COOLDOWN) hits.delete(id);
      if (continuous && distance >= 1.5 && speed >= MIN_SWING_SPEED) {
        const occlusion = polygonOcclusion(targets);
        for (const target of targets) {
          if (hits.has(target.id)) continue;
          const contact = target.polygon
            ? caneSweepContact(
                previous.points,
                points,
                target,
                occlusion.get(target),
              )
            : null;
          if (
            target.polygon
              ? contact
              : caneSweepHits(previous.points, points, target)
          ) {
            hits.set(target.id, now);
            struck.push(contact ? {...target, contact} : target);
          }
        }
      }
      previous = {x, y, now, angle, points};
      return {angle, hits: struck, direction: dx < 0 ? -1 : 1, strength};
    },
  };
}

export function createFactoryCane(
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
  const swing = createCaneSwing();
  const svg = (tag, attributes = {}) => {
    const element = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attributes))
      element.setAttribute(key, value);
    return element;
  };
  const holster = document.createElement('button');
  holster.type = 'button';
  const inToolbar = holsterContainer !== container;
  holster.className = 'factory-cane-holster';
  holster.classList.toggle('factory-cane-toolbar', inToolbar);
  holster.hidden = inToolbar;
  const icon = svg('svg', {
    viewBox: '0 0 36 48',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  const stored = svg('g');
  const storedShaft = 'M12 42 V13 A8 8 0 0 1 28 13 V19';
  stored.append(
    svg('path', {d: storedShaft, class: 'cane-stored-outline'}),
    svg('path', {d: storedShaft, class: 'cane-stored'}),
    svg('path', {d: 'M12 40 V43', class: 'cane-stored-tip'}),
  );
  icon.append(stored);
  const label = document.createElement('span');
  const name = document.createElement('strong');
  name.textContent = 'Cane';
  const action = document.createElement('small');
  label.append(name, action);
  holster.append(icon, label);
  const hint = document.createElement('span');
  hint.className = inToolbar
    ? 'factory-cane-toolbar-hint'
    : 'factory-cane-hint';
  hint.textContent = 'Wave to swing · Right-click or Esc to holster';
  hint.setAttribute('role', 'status');
  // A manual top-layer popover stays above app panels, menus and dialogs without
  // stealing focus or pointer events. Never change macOS's global cursor setting:
  // hide the native pointer only where our visible, app-local cane replaces it.
  const overlayLayer = document.createElement('div');
  overlayLayer.className = 'factory-cane-layer';
  overlayLayer.setAttribute('popover', 'manual');
  overlayLayer.setAttribute('aria-hidden', 'true');
  const overlay = svg('svg', {
    class: 'factory-cane-overlay',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  const impacts = svg('g');
  const trail = svg('path', {class: 'cane-trail'});
  const cane = svg('g', {class: 'cane-held'});
  cane.append(
    svg('path', {d: SHAFT, class: 'cane-outline'}),
    svg('path', {d: SHAFT, class: 'cane-wood'}),
    svg('path', {d: 'M-1 -28 V-90 Q-1 -102 12 -102', class: 'cane-shine'}),
    svg('path', {d: 'M0 -17 V5', class: 'cane-grip'}),
    svg('path', {d: 'M-3 -18 H3 M-3 2 H3', class: 'cane-band'}),
  );
  overlay.append(trail, impacts, cane);
  overlayLayer.append(overlay);
  document.body.append(overlayLayer);
  container.append(hint);
  if (inToolbar) holsterContainer.prepend(holster);
  else container.append(holster);
  let equipped = false,
    motion = true,
    disposed = false,
    sessionId;
  let frame = 0,
    moveFrame = 0,
    pendingMoves = [],
    samples = [],
    sparks = [];
  let previousRect = '',
    wasInScene = false;

  function stopEffects() {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    samples = [];
    sparks = [];
    trail.setAttribute('d', '');
    impacts.replaceChildren();
    delete container.dataset.caneHit;
  }
  function resetPointer() {
    swing.reset();
    if (moveFrame) window.cancelAnimationFrame(moveFrame);
    moveFrame = 0;
    pendingMoves = [];
    cane.style.display = 'none';
    container.classList.remove('cane-in-scene');
    document.documentElement.classList.remove('factory-cane-active');
    stopEffects();
    previousRect = '';
    wasInScene = false;
  }
  function raiseOverlay() {
    if (!equipped || disposed || !overlayLayer.showPopover) return;
    if (overlayLayer.matches(':popover-open')) overlayLayer.hidePopover();
    overlayLayer.showPopover();
  }
  function onLayerToggle(event) {
    if (event.target !== overlayLayer && event.newState === 'open')
      raiseOverlay();
  }
  function equip(value) {
    if (disposed) return;
    equipped = Boolean(value);
    if (equipped) onEquip();
    resetPointer();
    container.dataset.caneEquipped = String(equipped);
    if (!equipped && overlayLayer.matches(':popover-open'))
      overlayLayer.hidePopover();
    overlayLayer.hidden = !equipped;
    if (equipped) raiseOverlay();
    holster.setAttribute('aria-pressed', String(equipped));
    holster.setAttribute(
      'aria-label',
      equipped ? 'Return cane to holster' : 'Pick up cane',
    );
    holster.title = equipped
      ? 'Return cane to holster (right-click or Esc)'
      : 'Pick up cane, then wave the mouse over a robot or drone';
    action.textContent = equipped ? 'Holster' : 'Pick up';
    hint.hidden = !equipped;
  }
  function paintEffects(now) {
    frame = 0;
    samples = samples.filter(p => now - p.at < 110);
    trail.setAttribute(
      'd',
      motion && samples.length > 1
        ? samples.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ')
        : '',
    );
    sparks = sparks.filter(spark => {
      const age = (now - spark.at) / 240;
      if (age >= 1) {
        spark.element.remove();
        return false;
      }
      spark.element.setAttribute('opacity', motion ? String(1 - age) : '1');
      spark.element.setAttribute(
        'transform',
        `translate(${spark.x} ${spark.y}) scale(${(motion ? 0.7 + age * 0.7 : 1) * spark.strength})`,
      );
      return true;
    });
    if (!sparks.length) delete container.dataset.caneHit;
    if (samples.length || sparks.length)
      frame = window.requestAnimationFrame(paintEffects);
  }
  function paintMove(move, rect, visibleTargets) {
    const {x, y, at: now} = move;
    const inScene =
      move.inScene &&
      rect.width > 0 &&
      rect.height > 0 &&
      x >= rect.left &&
      x <= rect.right &&
      y >= rect.top &&
      y <= rect.bottom;
    const rectKey = `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
    if (rectKey !== previousRect || inScene !== wasInScene) {
      swing.reset();
      samples = [];
      previousRect = rectKey;
    }
    wasInScene = inScene;
    const targets = inScene ? visibleTargets : [];
    const result = swing.move(x, y, now, targets, motion);
    const viewBox = `0 0 ${window.innerWidth} ${window.innerHeight}`;
    if (overlay.getAttribute('viewBox') !== viewBox)
      overlay.setAttribute('viewBox', viewBox);
    cane.style.display = '';
    cane.setAttribute(
      'transform',
      `translate(${x} ${y}) rotate(${(result.angle * 180) / Math.PI})`,
    );
    container.classList.toggle('cane-in-scene', inScene);
    document.documentElement.classList.add('factory-cane-active');
    if (motion) {
      const tip = canePoints(x, y, result.angle)[5];
      samples.push({x: tip[0], y: tip[1], at: now});
      if (samples.length > 12) samples.shift();
    }
    for (const target of result.hits) {
      if (!equipped || disposed) return;
      const accepted =
        target.environmentId !== undefined
          ? target.contact
            ? onEnvironmentHit(
                target.environmentId,
                'cane',
                result.strength,
                target.contact,
              )
            : onEnvironmentHit(target.environmentId, 'cane', result.strength)
          : onHit(target.id, result.direction, result.strength);
      if (!equipped || disposed) return;
      if (accepted === false) continue;
      const element = svg('path', {
        class: 'cane-impact',
        d: 'M-18 0 H-10 M10 0 H18 M0 -18 V-10 M0 10 V18 M-12 -12 L-7 -7 M7 7 L12 12 M12 -12 L7 -7 M-7 7 L-12 12',
      });
      impacts.append(element);
      sparks.push({
        element,
        x: target.contact?.x ?? target.x,
        y: target.contact?.y ?? target.y,
        at: now,
        strength: result.strength,
      });
      if (sparks.length > 12) sparks.shift().element.remove();
      container.dataset.caneHit = target.id;
    }
    if (samples.length || sparks.length) {
      if (frame) window.cancelAnimationFrame(frame);
      paintEffects(now);
    }
  }
  function paintMoves() {
    moveFrame = 0;
    if (!equipped || disposed || !pendingMoves.length) return;
    const moves = pendingMoves;
    pendingMoves = [];
    const rect = container.getBoundingClientRect();
    const visibleTargets = moves.some(move => move.inScene)
      ? [
          ...visibleSceneTargets(getTargets(), rect, window),
          ...visibleSceneTargets(getEnvironmentTargets(), rect, window).map(
            target => ({
              ...target,
              id: `environment:${target.id}`,
              environmentId: target.id,
            }),
          ),
        ]
      : [];
    for (const move of moves) {
      if (!equipped || disposed) return;
      if (move.reset) {
        swing.reset();
        samples = [];
        wasInScene = false;
      } else paintMove(move, rect, visibleTargets);
    }
  }
  function queueMove(move) {
    if (pendingMoves.length >= MAX_PENDING_MOVES) {
      // Keep the start and latest pointer position without sweeping across the
      // omitted middle of an input flood.
      pendingMoves.length = MAX_PENDING_MOVES - 2;
      pendingMoves.push({reset: true});
    }
    pendingMoves.push(move);
    if (!moveFrame) moveFrame = window.requestAnimationFrame(paintMoves);
  }
  function onMove(event) {
    if (!equipped || event.pointerType === 'touch') return;
    const inScene =
      container.contains(event.target) &&
      !event.target.closest(
        'button:not(.fallback-station), a, input, textarea, select, [role="button"]:not(.fallback-station)',
      );
    // Stop only scene moves: the rest of the app keeps normal hover/click behavior.
    if (inScene) event.stopPropagation();
    const move = {
      x: event.clientX,
      y: event.clientY,
      at: window.performance.now(),
      inScene,
    };
    // Preserve curved paths between frames. Geometry and target bounds are
    // still measured once when the batch is painted.
    queueMove(move);
  }
  function toggle(event) {
    equip(!equipped);
    if (equipped && event.detail > 0) onMove(event);
  }
  function stow() {
    equip(false);
  }
  function onKey(event) {
    if (equipped && event.key === 'Escape' && !event.isComposing) {
      event.preventDefault();
      event.stopImmediatePropagation();
      stow();
    }
  }
  function onContextMenu(event) {
    if (!equipped) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    stow();
  }
  function onSceneLeave() {
    if (!equipped) return;
    // Preserve the reset boundary when moves on both sides of it share a frame.
    swing.reset();
    if (pendingMoves.length) queueMove({reset: true});
    wasInScene = false;
    container.classList.remove('cane-in-scene');
  }
  function onWindowLeave(event) {
    if (equipped && !event.relatedTarget) resetPointer();
  }
  function onClick(event) {
    if (
      equipped &&
      !event.target.closest(
        'button:not(.fallback-station), a, input, textarea, select, [role="button"]:not(.fallback-station)',
      ) &&
      event.detail !== 0
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }
  function onVisibility() {
    if (document.hidden) stow();
  }
  holster.addEventListener('click', toggle);
  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('pointerout', onWindowLeave);
  document.addEventListener('pointercancel', stow);
  document.addEventListener('contextmenu', onContextMenu, true);
  document.addEventListener('toggle', onLayerToggle, true);
  container.addEventListener('pointerleave', onSceneLeave);
  container.addEventListener('click', onClick, true);
  container.addEventListener('webglcontextlost', stow, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('scroll', resetPointer, true);
  window.addEventListener('blur', stow);
  window.addEventListener('resize', resetPointer);
  equip(false);
  return {
    stow,
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
    dispose() {
      if (disposed) return;
      stow();
      disposed = true;
      holster.removeEventListener('click', toggle);
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerout', onWindowLeave);
      document.removeEventListener('pointercancel', stow);
      document.removeEventListener('contextmenu', onContextMenu, true);
      document.removeEventListener('toggle', onLayerToggle, true);
      container.removeEventListener('pointerleave', onSceneLeave);
      container.removeEventListener('click', onClick, true);
      container.removeEventListener('webglcontextlost', stow, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('scroll', resetPointer, true);
      window.removeEventListener('blur', stow);
      window.removeEventListener('resize', resetPointer);
      overlayLayer.remove();
      hint.remove();
      holster.remove();
      delete container.dataset.caneEquipped;
    },
  };
}
