/* global document, window, ResizeObserver, requestAnimationFrame, cancelAnimationFrame */
export const apiVersion = 1;

/** @type {import('varisdev/theme-renderers').ThemeSceneModule['createScene']} */
export function createScene(canvas, {onSelect, onLayout, helpers}) {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas2D is unavailable');
  const parent = helpers.createParentMotion();
  const damage = helpers.createRobotDamage();
  let snapshot = null;
  let selected = 'parent';
  let palette = {};
  let hubCount = 0;
  let motion = true;
  let disposed = false;
  let frame = 0;
  let previousTime = 0;
  let clock = 0;
  let reaction = false;
  let reactionUntil = Infinity;
  let pendingPrompt = false;
  let boxes = [];
  let identity = null;

  const color = (key, fallback) => {
    const rgb = palette[key];
    return rgb
      ? `rgb(${rgb.map(value => Math.round(value * 255)).join(',')})`
      : fallback;
  };

  function draw() {
    if (disposed) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = color('floor', '#102026');
    context.fillRect(0, 0, width, height);
    context.strokeStyle = color('edge', '#45616c');
    context.lineWidth = 1;
    for (let x = 0; x < width; x += 24) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
    }
    for (let y = 0; y < height; y += 24) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }
    context.font = '12px monospace';
    context.fillStyle = '#111827';
    context.fillRect(0, 0, width, 30);
    context.fillStyle = '#ffffff';
    context.fillText(
      `CONTROL ROOM ${identity?.token || ''}  |  ${hubCount} sessions`,
      12,
      20,
    );
    const units = snapshot
      ? [{id: 'parent', status: snapshot.session.status}, ...snapshot.agents]
      : [];
    const columns = Math.max(
      1,
      Math.ceil(Math.sqrt((units.length * width) / Math.max(1, height * 1.8))),
    );
    const rows = Math.max(1, Math.ceil(units.length / columns));
    const cellWidth = width / columns;
    const cellHeight = Math.max(1, height - 54) / rows;
    boxes = units.map((unit, index) => {
      const pose = damage.pose(unit.id);
      const parentPose = unit.id === 'parent' ? parent.pose() : null;
      const x = ((index % columns) + 0.5) * cellWidth;
      const y = 38 + (Math.floor(index / columns) + 0.5) * cellHeight;
      const size = Math.max(
        4,
        Math.min(42, cellWidth * 0.28, cellHeight * 0.32),
      );
      const bounce =
        motion && unit.status === 'running'
          ? Math.sin(clock * 5 + index) * 2
          : 0;
      const jump = parentPose ? parentPose.jump * 6 : 0;
      context.save();
      context.translate(x + pose.offset[0] * 80, y - jump + bounce);
      context.rotate(pose.rotation[2] + pose.collapse * 1.2);
      context.globalAlpha = pose.visible ? 1 : 0.25;
      context.fillStyle = color('shell', '#c8d2d8');
      context.strokeStyle = color('outline', '#05080c');
      context.lineWidth = 3;
      context.fillRect(-size, -size, size * 2, size * 1.6);
      context.strokeRect(-size, -size, size * 2, size * 1.6);
      context.fillStyle = color('screen', '#081217');
      context.fillRect(-size * 0.75, -size * 0.7, size * 1.5, size * 0.7);
      context.fillStyle = color('eyes', '#ffffff');
      context.fillRect(-size * 0.5, -size * 0.5, size * 0.25, size * 0.18);
      context.fillRect(size * 0.25, -size * 0.5, size * 0.25, size * 0.18);
      context.fillStyle = color(unit.status, '#7fcbd2');
      context.beginPath();
      context.arc(0, size * 0.32, Math.max(2, size * 0.12), 0, Math.PI * 2);
      context.fill();
      if (pose.damage > 0) {
        context.strokeStyle = color('red', '#ff6878');
        context.beginPath();
        context.moveTo(-size, 0);
        context.lineTo(0, size * 0.4);
        context.lineTo(size * 0.3, size * 0.1);
        context.stroke();
      }
      context.restore();
      if (selected === unit.id) {
        context.strokeStyle = color('selection', '#fff06b');
        context.lineWidth = 2;
        context.strokeRect(
          x - size - 5,
          y - size - 7,
          size * 2 + 10,
          size * 1.6 + 12,
        );
      }
      const label = unit.status.toUpperCase();
      const labelWidth = Math.min(
        cellWidth - 4,
        context.measureText(label).width + 10,
      );
      const labelY = y + size * 0.8 + 15;
      context.fillStyle = '#111827';
      context.fillRect(x - labelWidth / 2, labelY - 12, labelWidth, 17);
      context.fillStyle = '#ffffff';
      context.textAlign = 'center';
      context.fillText(label, x, labelY, labelWidth - 6);
      context.textAlign = 'left';
      return {id: unit.id, x, y, radius: size + 8};
    });
    if (reaction || pendingPrompt) {
      context.fillStyle = color(reaction ? 'amber' : 'cyan', '#ffeb70');
      context.fillRect(0, height - 26, width, 26);
      context.fillStyle = '#111111';
      context.fillText(
        reaction ? '!! ATTENTION !!' : 'PROMPT RECEIVED...',
        12,
        height - 9,
      );
    }
    onLayout(
      boxes.map(box => ({
        id: box.id,
        x: box.x / width,
        y: Math.max(0, box.y - box.radius - 8) / height,
        visible: true,
      })),
    );
  }

  function animate(time) {
    frame = 0;
    if (disposed || !motion || document.hidden) return;
    const dt = previousTime ? Math.min((time - previousTime) / 1000, 0.1) : 0;
    previousTime = time;
    clock += dt;
    parent.tick(dt);
    damage.tick(dt);
    if (reaction && clock >= reactionUntil) reaction = false;
    draw();
    schedule();
  }
  function schedule() {
    if (!disposed && motion && !document.hidden && !frame)
      frame = requestAnimationFrame(animate);
  }
  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
    previousTime = 0;
  }
  function visibility() {
    stop();
    draw();
    schedule();
  }
  function click(event) {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const target = boxes.find(
      box => Math.hypot(box.x - x, box.y - y) <= box.radius,
    );
    if (target) onSelect(target.id);
  }
  const resize = new ResizeObserver(draw);
  resize.observe(canvas);
  canvas.addEventListener('click', click);
  document.addEventListener('visibilitychange', visibility);
  draw();
  schedule();

  return {
    update(next, selectedId) {
      if (disposed) return;
      if (next?.session.id !== snapshot?.session.id) {
        damage.reset();
        pendingPrompt = false;
        reaction = false;
        identity = next ? helpers.factoryIdentity(next.session.id) : null;
      }
      snapshot = next;
      selected = selectedId;
      parent.update(next?.session);
      damage.retain(['parent', ...(next?.agents || []).map(agent => agent.id)]);
      if (next?.session.status !== 'idle') pendingPrompt = false;
      draw();
    },
    updateHub(hub) {
      if (!disposed) {
        hubCount = hub?.sessions.length || 0;
        draw();
      }
    },
    setPalette(next) {
      if (disposed) return;
      palette = next || {};
      draw();
    },
    setMotion(enabled) {
      if (disposed) return;
      motion = enabled;
      parent.setMotion(enabled);
      damage.setMotion(enabled);
      stop();
      draw();
      schedule();
    },
    prompt(id) {
      if (disposed || id !== snapshot?.session.id) return;
      pendingPrompt = true;
      parent.prompt();
      draw();
    },
    cancelPrompt(id) {
      if (disposed || id !== snapshot?.session.id) return;
      pendingPrompt = false;
      parent.cancelPrompt();
      draw();
    },
    startle(animate = true) {
      if (disposed) return;
      reaction = true;
      reactionUntil = animate && motion ? clock + 0.8 : Infinity;
      parent.stop();
      draw();
    },
    clearStartle() {
      if (!disposed) {
        reaction = false;
        draw();
      }
    },
    caneTargets() {
      if (disposed) return [];
      const rect = canvas.getBoundingClientRect();
      return boxes.map(box => ({
        ...box,
        x: box.x + rect.left,
        y: box.y + rect.top,
      }));
    },
    hitWithCane(id, direction = 1, strength = 1) {
      if (disposed || !boxes.some(box => box.id === id)) return false;
      const hit = damage.hit(id, direction, strength);
      draw();
      return hit;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      resize.disconnect();
      canvas.removeEventListener('click', click);
      document.removeEventListener('visibilitychange', visibility);
      parent.dispose();
      damage.dispose();
      boxes = [];
    },
  };
}
