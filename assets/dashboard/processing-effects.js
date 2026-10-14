/* global document, setTimeout, clearTimeout */
const NS = 'http://www.w3.org/2000/svg';

function svgNode(tag, attributes = {}) {
  const element = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attributes))
    element.setAttribute(name, String(value));
  return element;
}

/** Effects follow messages actually entering conversation, not the steering queue. */
export function createProcessingEffects(container) {
  const layer = document.createElement('div');
  layer.className = 'processing-effects';
  layer.setAttribute('aria-hidden', 'true');
  const jolt = document.createElement('div');
  jolt.className = 'prompt-jolt';
  jolt.hidden = true;
  const svg = svgNode('svg', {
    viewBox: '0 0 1000 1000',
    preserveAspectRatio: 'none',
  });
  const glow = svgNode('path', {class: 'prompt-jolt-glow', pathLength: 100});
  const wire = svgNode('path', {class: 'prompt-jolt-wire', pathLength: 100});
  svg.append(glow, wire);
  const impact = document.createElement('span');
  impact.className = 'prompt-jolt-impact';
  const caption = document.createElement('span');
  caption.className = 'prompt-jolt-caption';
  caption.textContent = 'Processing prompt';
  jolt.append(svg, impact, caption);
  const markers = document.createElement('div');
  markers.className = 'agent-work-markers';
  layer.append(jolt, markers);
  container.append(layer);
  const seen = new Map();
  const markerNodes = new Map();
  let layout = [];
  let data;
  let sessionId;
  let timeout;
  let disposed = false;
  let sequence = 0;
  let stopping = false;

  function clear() {
    clearTimeout(timeout);
    jolt.hidden = true;
  }
  function place() {
    let target = layout.find(item => item.id === 'parent' && item.visible);
    if (!target) {
      const fallback = container.querySelector(
        '.fallback-station.parent-session',
      );
      if (fallback) {
        const box = fallback.getBoundingClientRect();
        const bounds = container.getBoundingClientRect();
        target = {
          x:
            (box.left - bounds.left + box.width / 2) /
            Math.max(1, bounds.width),
          y:
            (box.top - bounds.top + box.height * 0.35) /
            Math.max(1, bounds.height),
        };
      }
    }
    target ||= {x: 0.5, y: 0.45};
    const x = Math.max(0.06, Math.min(0.94, target.x)) * 1000;
    const y = Math.max(0.1, Math.min(0.88, target.y)) * 1000;
    const origin = [500, 980];
    const points = [origin];
    for (let step = 1; step < 11; step++) {
      const progress = step / 11;
      const bend = Math.sin(progress * Math.PI) * (step % 2 ? 28 : -28);
      points.push([
        origin[0] + (x - origin[0]) * progress + bend,
        origin[1] + (y - origin[1]) * progress,
      ]);
    }
    points.push([x, y]);
    const path = points
      .map((point, i) => `${i ? 'L' : 'M'}${point.join(' ')}`)
      .join(' ');
    glow.setAttribute('d', path);
    wire.setAttribute('d', path);
    for (const element of [impact, caption]) {
      element.style.left = `${x / 10}%`;
      element.style.top = `${y / 10}%`;
    }
    for (const [id, marker] of markerNodes) {
      const anchor = layout.find(item => item.id === id);
      marker.hidden = !anchor?.visible;
      if (anchor) {
        marker.style.left = `${anchor.x * 100}%`;
        marker.style.top = `${anchor.y * 100}%`;
      }
    }
  }
  function updateMarkers() {
    const working = new Map(
      (data?.agents || [])
        .filter(agent => agent.status === 'running' && !stopping)
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
      marker.title = `${agent.name}: working`;
    }
    place();
  }
  return {
    update(snapshot, options = {}) {
      if (disposed) return;
      data = snapshot;
      stopping = Boolean(options.stopping);
      layer.classList.toggle('motion-off', options.motion === false);
      if (sessionId !== data.session.id) {
        sessionId = data.session.id;
        layout = [];
        clear();
      }
      const messages = (data.conversation || []).filter(
        message => message.role === 'user',
      );
      const previous = seen.get(sessionId);
      if (previous) {
        const added = messages.filter(message => !previous.has(message.id));
        for (const message of added) previous.add(message.id);
        // The conversation itself is bounded; retain enough IDs to avoid replay
        // when switching views or restoring recent history after compaction.
        while (previous.size > 1000)
          previous.delete(previous.values().next().value);
        if (added.length && !stopping && data.session.status !== 'closed') {
          clear();
          place();
          jolt.dataset.sequence = String(++sequence);
          jolt.hidden = false;
          jolt.classList.remove('is-active');
          void jolt.offsetWidth;
          jolt.classList.add('is-active');
          timeout = setTimeout(clear, 1300);
        }
      } else {
        seen.set(sessionId, new Set(messages.map(message => message.id)));
        if (seen.size > 64) seen.delete(seen.keys().next().value);
      }
      updateMarkers();
    },
    layout(anchors) {
      if (disposed) return;
      layout = anchors;
      place();
    },
    dispose() {
      disposed = true;
      clear();
      markerNodes.clear();
      seen.clear();
      layer.remove();
    },
  };
}
