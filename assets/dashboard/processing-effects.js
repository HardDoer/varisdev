/* global document, window */
const NS = 'http://www.w3.org/2000/svg';
const FLIGHT_MS = 850;
const TAIL_MS = 180;
const PULSE_MS = 360;

function svgNode(tag, attributes = {}) {
  const element = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attributes))
    element.setAttribute(name, String(value));
  return element;
}

function visibleOrigin(element) {
  if (!element || window.getComputedStyle(element).visibility !== 'visible')
    return null;
  const box = element.getBoundingClientRect();
  if (!box.width || !box.height) return null;
  const left = Math.max(0, box.left);
  const right = Math.min(window.innerWidth, box.right);
  const top = Math.max(0, box.top);
  const bottom = Math.min(window.innerHeight, box.bottom);
  if (right <= left || bottom <= top) return null;
  return {x: (left + right) / 2, y: top + Math.min(18, (bottom - top) / 2)};
}

function curve(origin, target, progress) {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const length = Math.hypot(dx, dy) || 1;
  const bend = Math.min(70, length * 0.12);
  const control = {
    x: (origin.x + target.x) / 2 + (dy / length) * bend,
    y: (origin.y + target.y) / 2 - (dx / length) * bend,
  };
  const remaining = 1 - progress;
  return {
    x:
      remaining * remaining * origin.x +
      2 * remaining * progress * control.x +
      progress * progress * target.x,
    y:
      remaining * remaining * origin.y +
      2 * remaining * progress * control.y +
      progress * progress * target.y,
  };
}

/** Effects follow messages actually entering conversation, not the steering queue. */
export function createProcessingEffects(
  container,
  {getOrigin = () => document.getElementById('parent-prompt')} = {},
) {
  const layer = document.createElement('div');
  layer.className = 'processing-effects';
  layer.setAttribute('aria-hidden', 'true');
  const markers = document.createElement('div');
  markers.className = 'agent-work-markers';
  layer.append(markers);
  container.append(layer);

  // The composer and scene live in different columns; the flight spans both.
  const jolt = document.createElement('div');
  jolt.className = 'prompt-jolt';
  jolt.setAttribute('aria-hidden', 'true');
  jolt.hidden = true;
  const svg = svgNode('svg');
  const defs = svgNode('defs');
  const gradient = svgNode('linearGradient', {
    id: 'prompt-packet-tail',
    gradientUnits: 'userSpaceOnUse',
  });
  gradient.append(
    svgNode('stop', {
      offset: 0,
      class: 'prompt-jolt-tail-start',
      'stop-opacity': 0,
    }),
    svgNode('stop', {offset: 1, class: 'prompt-jolt-tail-end'}),
  );
  defs.append(gradient);
  const glow = svgNode('path', {class: 'prompt-jolt-glow'});
  const wire = svgNode('path', {class: 'prompt-jolt-wire'});
  const head = svgNode('circle', {class: 'prompt-jolt-head', r: 3.5});
  svg.append(defs, glow, wire, head);
  const impact = document.createElement('span');
  impact.className = 'prompt-jolt-impact';
  jolt.append(svg, impact);
  document.body.append(jolt);

  const seen = new Map();
  const queuedOrigins = new Map();
  const markerNodes = new Map();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let layoutById = new Map();
  let containerBounds;
  let fallbackTarget = null;
  let data;
  let sessionId;
  let frame;
  let flight;
  let disposed = false;
  let sequence = 0;
  let stopping = false;
  let motion = true;

  function clear() {
    window.cancelAnimationFrame(frame);
    frame = undefined;
    flight = null;
    jolt.hidden = true;
    jolt.classList.remove('has-arrived');
  }
  function refreshPositions() {
    containerBounds = container.getBoundingClientRect();
    fallbackTarget = null;
    if (layoutById.get('parent')?.visible) return;
    const fallback = container.querySelector(
      '.fallback-station.parent-session',
    );
    if (fallback) {
      const box = fallback.getBoundingClientRect();
      if (box.width && box.height)
        fallbackTarget = {
          x: box.left + box.width / 2,
          y: box.top + box.height * 0.35,
        };
    }
  }
  function targetPosition() {
    const target = layoutById.get('parent');
    const bounds = containerBounds;
    if (target?.visible && bounds)
      return {
        x: bounds.left + target.x * bounds.width,
        y: bounds.top + target.y * bounds.height,
      };
    if (fallbackTarget) return fallbackTarget;
    if (bounds?.width && bounds.height)
      return {
        x: bounds.left + bounds.width / 2,
        y: bounds.top + bounds.height * 0.45,
      };
    return null;
  }
  function placeMarkers() {
    for (const [id, marker] of markerNodes) {
      const anchor = layoutById.get(id);
      const hidden = !anchor?.visible;
      if (marker.hidden !== hidden) marker.hidden = hidden;
      if (anchor) {
        const left = `${anchor.x * 100}%`;
        const top = `${anchor.y * 100}%`;
        if (marker.style.left !== left) marker.style.left = left;
        if (marker.style.top !== top) marker.style.top = top;
      }
    }
  }
  function draw(now) {
    if (!flight || disposed) return;
    const target = targetPosition();
    if (!target) return clear();
    const elapsed = now - flight.started;
    const duration = flight.still ? 700 : FLIGHT_MS + PULSE_MS;
    if (elapsed >= duration) return clear();
    const viewBox = `0 0 ${window.innerWidth} ${window.innerHeight}`;
    if (svg.getAttribute('viewBox') !== viewBox)
      svg.setAttribute('viewBox', viewBox);
    impact.style.left = `${target.x}px`;
    impact.style.top = `${target.y}px`;
    const origin = flight.origin;
    if (!flight.still) {
      // A short fading tail travels with the packet; no stationary full path.
      const progress = Math.min(1, elapsed / FLIGHT_MS);
      const end = curve(origin, target, progress);
      head.setAttribute('cx', end.x);
      head.setAttribute('cy', end.y);
      head.style.opacity = elapsed < FLIGHT_MS ? '1' : '0';
      const tailStart = Math.max(0, (elapsed - TAIL_MS) / FLIGHT_MS);
      const tail = curve(origin, target, Math.min(1, tailStart));
      for (const [name, value] of Object.entries({
        x1: tail.x,
        y1: tail.y,
        x2: end.x,
        y2: end.y,
      }))
        gradient.setAttribute(name, value);
      const points = [];
      for (let i = 0; i <= 12; i++) {
        const point = curve(
          origin,
          target,
          Math.min(1, tailStart + ((progress - tailStart) * i) / 12),
        );
        points.push(
          `${i ? 'L' : 'M'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`,
        );
      }
      for (const path of [glow, wire]) {
        path.setAttribute('d', points.join(' '));
        path.style.opacity = String(
          Math.min(1, elapsed / 70) *
            Math.max(0, 1 - Math.max(0, elapsed - FLIGHT_MS) / TAIL_MS),
        );
      }
      if (elapsed >= FLIGHT_MS && !flight.arrived) {
        flight.arrived = true;
        jolt.classList.add('has-arrived');
      }
    }
    frame = window.requestAnimationFrame(draw);
  }
  function start(origin) {
    clear();
    refreshPositions();
    if (!targetPosition()) return;
    const still = !motion || reducedMotion.matches;
    if (!still && !origin) return;
    flight = {origin, still, started: window.performance.now(), arrived: still};
    jolt.dataset.sequence = String(++sequence);
    jolt.classList.toggle('motion-off', still);
    jolt.classList.toggle('has-arrived', still);
    jolt.hidden = false;
    draw(flight.started);
  }
  function motionChanged() {
    layer.classList.toggle('motion-off', !motion || reducedMotion.matches);
    if (flight && (!motion || reducedMotion.matches) && !flight.still)
      start(flight.origin);
  }
  reducedMotion.addEventListener('change', motionChanged);

  function updateMarkers() {
    const working = new Map(
      (data?.agents || [])
        .filter(agent => ['running', 'cancelling'].includes(agent.status))
        .map(agent => [agent.id, agent]),
    );
    for (const [id, marker] of markerNodes) {
      if (working.has(id)) continue;
      marker.remove();
      markerNodes.delete(id);
    }
    for (const [id, agent] of working) {
      let marker = markerNodes.get(id);
      if (!marker) {
        marker = document.createElement('span');
        marker.className = 'agent-work-marker';
        marker.dataset.agentId = id;
        marker.textContent = 'Working';
        markers.append(marker);
        markerNodes.set(id, marker);
      }
      const text = agent.status === 'cancelling' ? 'Cancelling' : 'Working';
      if (marker.textContent !== text) marker.textContent = text;
      if (marker.dataset.status !== agent.status)
        marker.dataset.status = agent.status;
      const title = `${agent.name}: ${text.toLowerCase()}`;
      if (marker.title !== title) marker.title = title;
    }
    placeMarkers();
  }
  refreshPositions();
  const resizeObserver = window.ResizeObserver
    ? new window.ResizeObserver(refreshPositions)
    : null;
  resizeObserver?.observe(container);
  window.addEventListener('scroll', refreshPositions, true);
  window.addEventListener('resize', refreshPositions);
  return {
    update(snapshot, options = {}) {
      if (disposed) return;
      data = snapshot;
      stopping = Boolean(options.stopping);
      motion = options.motion !== false;
      motionChanged();
      const switched = sessionId !== data.session.id;
      if (switched) {
        sessionId = data.session.id;
        layoutById = new Map();
        clear();
      }
      const origin = visibleOrigin(getOrigin());
      const queued = queuedOrigins.get(sessionId) || new Map();
      const conversation = data.conversation || [];
      const previous = seen.get(sessionId);
      if (previous) {
        const added = [];
        // Conversation snapshots are append-only during a run. Scan backward
        // to the newest known user message instead of filtering all history.
        for (let index = conversation.length - 1; index >= 0; index--) {
          const message = conversation[index];
          if (message.role !== 'user') continue;
          if (previous.has(message.id)) break;
          added.push(message);
        }
        for (const message of added) previous.add(message.id);
        while (previous.size > 1000)
          previous.delete(previous.values().next().value);
        if (
          !switched &&
          added.length &&
          !stopping &&
          data.session.status !== 'closed'
        ) {
          const message = added[0];
          const queuedOrigin = queued.get(message.text);
          // Hidden composers only produce a flight for steering captured earlier.
          if (origin || queuedOrigin) start(origin || queuedOrigin);
        }
      } else {
        seen.set(
          sessionId,
          new Set(
            conversation
              .filter(message => message.role === 'user')
              .map(message => message.id),
          ),
        );
        if (seen.size > 64) {
          const oldest = seen.keys().next().value;
          seen.delete(oldest);
          queuedOrigins.delete(oldest);
        }
      }
      const currentQueue = new Set(data.queue?.steering || []);
      for (const text of queued.keys())
        if (!currentQueue.has(text)) queued.delete(text);
      if (origin) for (const text of currentQueue) queued.set(text, origin);
      queuedOrigins.set(sessionId, queued);
      if (stopping) clear();
      updateMarkers();
    },
    layout(anchors) {
      if (disposed) return;
      layoutById = new Map(anchors.map(anchor => [anchor.id, anchor]));
      if (flight) refreshPositions();
      placeMarkers();
    },
    dispose() {
      disposed = true;
      clear();
      reducedMotion.removeEventListener('change', motionChanged);
      resizeObserver?.disconnect();
      window.removeEventListener('scroll', refreshPositions, true);
      window.removeEventListener('resize', refreshPositions);
      markerNodes.clear();
      seen.clear();
      queuedOrigins.clear();
      layer.remove();
      jolt.remove();
    },
  };
}
