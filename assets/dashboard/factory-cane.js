// A local toy: swinging never sends commands or changes a session's state.
const NS = 'http://www.w3.org/2000/svg';
const SHAFT = 'M0 6 V-92 A12 12 0 0 1 24 -92 V-82';
const COOLDOWN = 320;
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
export function caneSweepHits(before, after, target) {
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
        return {angle: -0.3, hits: [], direction: 1};
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
      const struck = [];
      for (const [id, at] of hits) if (now - at >= COOLDOWN) hits.delete(id);
      if (continuous && distance >= 1.5 && distance / dt >= 0.18) {
        for (const target of targets) {
          if (
            !hits.has(target.id) &&
            caneSweepHits(previous.points, points, target)
          ) {
            hits.set(target.id, now);
            struck.push(target);
          }
        }
      }
      previous = {x, y, now, angle, points};
      return {angle, hits: struck, direction: dx < 0 ? -1 : 1};
    },
  };
}

export function createFactoryCane(
  container,
  {getTargets = () => [], onHit = () => true} = {},
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
  holster.className = 'factory-cane-holster';
  const icon = svg('svg', {
    viewBox: '0 0 36 48',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  const stored = svg('path', {
    d: 'M12 41 V12 A7 7 0 0 1 26 12 V17',
    class: 'cane-stored',
  });
  icon.append(
    svg('rect', {
      x: '3',
      y: '3',
      width: '30',
      height: '43',
      rx: '5',
      class: 'cane-rack',
    }),
    stored,
    svg('path', {
      d: 'M6 25 H25 V40 Q25 46 19 46 H12 Q6 46 6 40 Z',
      class: 'cane-pocket',
    }),
    svg('path', {d: 'M10 29 H21 M11 39 H20', class: 'cane-stitch'}),
  );
  const label = document.createElement('span');
  const name = document.createElement('strong');
  name.textContent = 'Cane';
  const action = document.createElement('small');
  label.append(name, action);
  holster.append(icon, label);
  const hint = document.createElement('span');
  hint.className = 'factory-cane-hint';
  hint.textContent = 'Wave to swing · Esc to holster';
  hint.setAttribute('role', 'status');
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
  container.append(overlay, hint, holster);
  let equipped = false,
    motion = true,
    disposed = false,
    sessionId;
  let frame = 0,
    samples = [],
    sparks = [];
  let previousRect = '';

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
    cane.style.display = 'none';
    container.classList.remove('cane-in-scene');
    stopEffects();
    previousRect = '';
  }
  function equip(value) {
    if (disposed) return;
    equipped = Boolean(value);
    resetPointer();
    container.dataset.caneEquipped = String(equipped);
    holster.setAttribute('aria-pressed', String(equipped));
    holster.setAttribute(
      'aria-label',
      equipped ? 'Return cane to holster' : 'Pick up cane',
    );
    holster.title = equipped
      ? 'Return cane to holster (Esc)'
      : 'Pick up cane, then wave the mouse over a robot or drone';
    action.textContent = equipped ? 'Holster' : 'Pick up';
    stored.style.visibility = equipped ? 'hidden' : '';
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
        `translate(${spark.x} ${spark.y}) scale(${motion ? 0.7 + age * 0.7 : 1})`,
      );
      return true;
    });
    if (!sparks.length) delete container.dataset.caneHit;
    if (samples.length || sparks.length)
      frame = window.requestAnimationFrame(paintEffects);
  }
  function onMove(event) {
    if (!equipped || event.pointerType === 'touch') return;
    if (holster.contains(event.target)) {
      resetPointer();
      return;
    }
    // Keep the factory camera steady while the mouse is driving the cane.
    event.stopPropagation();
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const rectKey = `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
    if (rectKey !== previousRect) {
      resetPointer();
      previousRect = rectKey;
    }
    const x = event.clientX - rect.left,
      y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
      resetPointer();
      return;
    }
    const now = window.performance.now();
    const targets = getTargets()
      .filter(
        target =>
          [target.x, target.y, target.radius].every(Number.isFinite) &&
          target.radius > 0 &&
          target.x >= rect.left &&
          target.x <= rect.right &&
          target.y >= rect.top &&
          target.y <= rect.bottom,
      )
      .map(target => ({
        ...target,
        x: target.x - rect.left,
        y: target.y - rect.top,
      }));
    const result = swing.move(x, y, now, targets, motion);
    overlay.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
    cane.style.display = '';
    cane.setAttribute(
      'transform',
      `translate(${x} ${y}) rotate(${(result.angle * 180) / Math.PI})`,
    );
    container.classList.add('cane-in-scene');
    if (motion) {
      const tip = canePoints(x, y, result.angle)[5];
      samples.push({x: tip[0], y: tip[1], at: now});
      if (samples.length > 12) samples.shift();
    }
    for (const target of result.hits) {
      if (onHit(target.id, result.direction) === false) continue;
      const element = svg('path', {
        class: 'cane-impact',
        d: 'M-18 0 H-10 M10 0 H18 M0 -18 V-10 M0 10 V18 M-12 -12 L-7 -7 M7 7 L12 12 M12 -12 L7 -7 M-7 7 L-12 12',
      });
      impacts.append(element);
      sparks.push({element, x: target.x, y: target.y, at: now});
      if (sparks.length > 12) sparks.shift().element.remove();
      container.dataset.caneHit = target.id;
    }
    if (samples.length || sparks.length) {
      if (frame) window.cancelAnimationFrame(frame);
      paintEffects(now);
    }
  }
  function toggle() {
    equip(!equipped);
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
  function onOutside(event) {
    if (equipped && !container.contains(event.target)) stow();
  }
  function onClick(event) {
    if (equipped && !holster.contains(event.target) && event.detail !== 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }
  function onVisibility() {
    if (document.hidden) stow();
  }
  holster.addEventListener('click', toggle);
  container.addEventListener('pointermove', onMove, true);
  container.addEventListener('pointerleave', resetPointer);
  container.addEventListener('pointercancel', stow);
  container.addEventListener('click', onClick, true);
  container.addEventListener('webglcontextlost', stow, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('focusin', onOutside);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('scroll', resetPointer, true);
  window.addEventListener('blur', stow);
  window.addEventListener('resize', resetPointer);
  equip(false);
  return {
    setSession(id) {
      if (id !== sessionId) {
        sessionId = id;
        stow();
      }
    },
    setMotion(value) {
      motion = Boolean(value);
      resetPointer();
    },
    dispose() {
      if (disposed) return;
      stow();
      disposed = true;
      holster.removeEventListener('click', toggle);
      container.removeEventListener('pointermove', onMove, true);
      container.removeEventListener('pointerleave', resetPointer);
      container.removeEventListener('pointercancel', stow);
      container.removeEventListener('click', onClick, true);
      container.removeEventListener('webglcontextlost', stow, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('focusin', onOutside);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('scroll', resetPointer, true);
      window.removeEventListener('blur', stow);
      window.removeEventListener('resize', resetPointer);
      overlay.remove();
      hint.remove();
      holster.remove();
      delete container.dataset.caneEquipped;
    },
  };
}
