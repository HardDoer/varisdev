import {createParentMotion} from './parent-motion.js';
import {
  AWAKE_EYE_HEIGHT,
  relaxedIdlePose,
  idleActivityPose,
  drawIdleActivity,
} from './parent-activities.js';
import {createRobotWhip, whipPose, drawRobotWhip} from './robot-whip.js';

const NS = 'http://www.w3.org/2000/svg';
const TAU = Math.PI * 2;
const HOME = -6.25;
const STARTLE_SECONDS = 1.1;
const C = {
  shell: 'var(--mint)',
  edge: 'var(--cyan)',
  metal: 'var(--muted)',
  dark: 'var(--bg)',
  white: 'var(--text)',
  dim: 'var(--line)',
  amber: 'var(--amber)',
  cyan: 'var(--cyan)',
  mint: 'var(--mint)',
};
const mix = (a, b, amount) =>
  a.map((value, i) => value + (b[i] - value) * amount);
const number = value => Math.round(value * 100) / 100;
const rotate = (p, yaw) => [
  p[0] * Math.cos(yaw) + p[2] * Math.sin(yaw),
  p[1],
  p[2] * Math.cos(yaw) - p[0] * Math.sin(yaw),
];

// The shared activity geometry uses x forward, y up, and z across the arms.
// Project those same primitives into the icon instead of maintaining SVG props.
function primitives(shapes, originX, ground = 0, yaw = 0) {
  const world = p => {
    const q = rotate(p, yaw);
    q[1] += ground;
    return q;
  };
  const project = p => [
    originX + p[0] * 6 + p[2] * 20,
    143 - p[1] * 23 - p[0] * 4 + p[2] * 3,
  ];
  const depth = p => p[0] + p[1] * 0.6 - p[2] * 0.5;
  const path = (points, color, stroke = null, width = 0, shade = 0) => {
    const vertices = points.map(world);
    shapes.push({
      d:
        vertices
          .map((p, i) => `${i ? 'L' : 'M'}${project(p).map(number).join(' ')}`)
          .join(' ') + (stroke ? '' : ' Z'),
      fill: stroke ? 'none' : color,
      stroke: stroke || 'var(--panel)',
      width: stroke ? width : 0.45,
      shade,
      depth: vertices.reduce((sum, p) => sum + depth(p), 0) / vertices.length,
    });
  };
  const polygon = (points, color, shade = 0) =>
    path(points, color, null, 0, shade);
  const box = (p, size, color, emission = 0, boxYaw = 0) => {
    const corners = [];
    for (const y of [-1, 1])
      for (const z of [-1, 1])
        for (const x of [-1, 1]) {
          const q = rotate(
            [(x * size[0]) / 2, (y * size[1]) / 2, (z * size[2]) / 2],
            boxYaw,
          );
          corners.push(q.map((value, i) => value + p[i]));
        }
    for (const [indices, shade] of [
      [[0, 1, 3, 2], 0.3],
      [[4, 6, 7, 5], 0],
      [[0, 4, 5, 1], 0.18],
      [[2, 3, 7, 6], 0.3],
      [[0, 2, 6, 4], 0.3],
      [[1, 5, 7, 3], 0.08],
    ])
      polygon(
        indices.map(i => corners[i]),
        color,
        emission ? 0 : shade,
      );
  };
  const cylinder = (p, size, color, emission = 0, segments = 12) => {
    const ring = side =>
      Array.from({length: segments}, (_, i) => [
        p[0] + (Math.cos((i * TAU) / segments) * size[0]) / 2,
        p[1] + (side * size[1]) / 2,
        p[2] + (Math.sin((i * TAU) / segments) * size[2]) / 2,
      ]);
    const bottom = ring(-1),
      top = ring(1);
    polygon(bottom, color, 0.25);
    for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments;
      polygon(
        [bottom[i], bottom[next], top[next], top[i]],
        color,
        emission ? 0 : 0.15,
      );
    }
    polygon(top, color);
  };
  const rod = (a, b, radius, color) =>
    path([a, b], color, color, Math.max(0.6, radius * 40));
  const ring = (p, radius, thickness, color, emission = 0, segments = 28) => {
    for (let i = 0; i < segments; i++) {
      const at = j => [
        p[0] + Math.cos((j * TAU) / segments) * radius,
        p[1],
        p[2] + Math.sin((j * TAU) / segments) * radius,
      ];
      rod(at(i), at(i + 1), thickness * (1 + emission * 0.15), color);
    }
  };
  return {
    box,
    cylinder,
    rod,
    ring,
    octagon: (p, size, color, emission = 0) =>
      cylinder(p, size, color, emission, 8),
  };
}

function reactionPose(reaction) {
  if (!reaction) return {jump: 0, surprise: 0, squash: 0};
  if (!reaction.animated) return {jump: 0, surprise: 1, squash: 0};
  const progress = reaction.age / STARTLE_SECONDS;
  const flight = Math.max(0, Math.min(1, (progress - 0.06) / 0.58));
  return {
    jump: Math.sin(flight * Math.PI) * 1.35,
    surprise: Math.min(1, progress / 0.1) * Math.min(1, (1 - progress) / 0.42),
    squash:
      progress >= 0.64 && progress < 0.8
        ? -Math.sin(((progress - 0.64) / 0.16) * Math.PI) * 0.22
        : 0,
  };
}

export function createParentFallback(container) {
  const document = container.ownerDocument;
  const window = document.defaultView;
  const controller = createParentMotion();
  const whip = createRobotWhip();
  const overlay = document.createElementNS(NS, 'svg');
  overlay.setAttribute('class', 'robot-whip-overlay');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.setAttribute('focusable', 'false');
  let agents = [];
  let recoilGlyph = null;
  function clearWhip() {
    recoilGlyph?.style.removeProperty('translate');
    recoilGlyph = null;
    overlay.remove();
  }
  function targets() {
    const running = new Set(
      agents.filter(a => a.status === 'running').map(a => a.id),
    );
    return [...container.querySelectorAll('.fallback-station.agent')].filter(
      element => {
        const rect = element.getBoundingClientRect();
        const glyphBounds = element
          .querySelector('.robot-glyph')
          ?.getBoundingClientRect();
        return (
          glyphBounds?.width > 0 &&
          glyphBounds.height > 0 &&
          running.has(element.dataset.unitId) &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.top < window.innerHeight &&
          rect.right > 0 &&
          rect.left < window.innerWidth
        );
      },
    );
  }
  function syncWhip() {
    whip.update(
      session?.id,
      targets().map(element => element.dataset.unitId),
      Boolean(reaction) ||
        !['rest', 'work'].includes(controller.pose().mode) ||
        session?.status === 'closed',
    );
    if (!whip.pose()) clearWhip();
  }
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 240 180');
  svg.setAttribute('class', 'parent-fallback-robot');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const workstation = document.createElementNS(NS, 'g');
  const robot = document.createElementNS(NS, 'g');
  svg.append(workstation, robot);
  let station = null;
  let glyph = null;
  let session = null;
  let selected = false;
  let motion = true;
  let disposed = false;
  let frame = null;
  let lastTime = null;
  let time = 0;
  let reaction = null;
  let visible = true;

  function paint(group, shapes) {
    shapes.sort((a, b) => a.depth - b.depth);
    while (group.children.length > shapes.length)
      group.lastElementChild.remove();
    shapes.forEach((shape, i) => {
      let element = group.children[i];
      if (!element) {
        element = document.createElementNS(NS, 'path');
        group.append(element);
      }
      element.setAttribute('d', shape.d);
      element.setAttribute('fill', shape.fill);
      element.setAttribute('stroke', shape.stroke);
      element.setAttribute('stroke-width', number(shape.width));
      element.setAttribute('stroke-linecap', 'round');
      element.setAttribute('stroke-linejoin', 'round');
      // A black overlay is unnecessary: brightness also follows theme colors.
      element.style.filter = shape.shade
        ? `brightness(${1 - shape.shade})`
        : '';
    });
  }

  function render() {
    if (disposed || !station || !session) return;
    syncWhip();
    const pose = controller.pose();
    const lash = whip.pose();
    const lashPose = lash ? whipPose(lash.age) : null;
    let whipHand;
    const idle = pose.activity
      ? idleActivityPose(pose.activity, pose.elapsed)
      : null;
    const relaxed =
      pose.mode === 'rest' && !reaction ? relaxedIdlePose(time, motion) : null;
    const blend = idle
      ? Math.max(
          0,
          Math.min(
            1,
            pose.elapsed / 0.35,
            (pose.duration - pose.elapsed) / 0.35,
          ),
        )
      : 0;
    const moving = pose.mode === 'walk' || pose.mode === 'return';
    const running = pose.mode === 'return';
    const working = pose.mode === 'work';
    const stop = reactionPose(reaction);
    const surprise = Math.max(stop.surprise, pose.surprise);
    const jump = stop.jump + pose.jump;
    const bob = moving
      ? Math.abs(Math.sin(pose.stride)) * (running ? 0.13 : 0.06)
      : working && motion
        ? Math.sin(time * 3) * 0.06
        : 0;
    const lift =
      bob +
      jump +
      stop.squash +
      (idle?.lift || 0) * blend +
      (relaxed?.lift || 0);
    const base = 0.4 + lift;
    const color = surprise ? C.amber : working ? C.cyan : C.mint;
    const origin = 57 + (pose.x - HOME) * 8.8;
    const shapes = [];
    const yaw = pose.yaw + (idle?.yaw || 0) * blend - (lashPose?.turn || 0);
    const g = primitives(shapes, origin, pose.ground, yaw);
    g.cylinder(
      [0, 0.36, 0],
      [2.25 - jump * 0.3, 0.04, 1.5 - jump * 0.18],
      C.dark,
    );
    if (selected || working) g.ring([0, 0.4, 0], 2.05, 0.04, color);
    for (const [i, side] of [-1, 1].entries()) {
      const step = moving ? Math.sin(pose.stride + i * Math.PI) : 0;
      const foot = idle?.feet[i];
      const x = step * (running ? 0.7 : 0.42) + (foot?.x || 0) * blend;
      const y =
        jump * 1.1 +
        Math.max(0, step) * (running ? 0.34 : 0.2) +
        (foot?.y || 0) * blend;
      const z = side * 0.54 + side * jump * 0.17 + (foot?.z || 0) * blend;
      g.box([x + 0.12, 0.59 + y, z], [1.08, 0.35, 0.66], C.metal);
      g.box([x + 0.5, 0.66 + y, z], [0.14, 0.16, 0.55], C.shell);
      g.rod(
        [x - 0.15, 0.7 + y, z],
        [-0.25, 1.15 + lift, side * 0.54],
        0.18,
        C.dark,
      );
      g.octagon([-0.23, 1.03 + lift, side * 0.54], [0.52, 0.25, 0.52], C.metal);
    }
    g.octagon([0, base + 1, 0], [1.2, 0.3, 1.24], C.dark);
    g.box([0, base + 1.55, 0], [1.45, 1.12, 1.52], C.shell);
    g.box([0.75, base + 1.54, 0], [0.09, 0.84, 1.15], C.edge);
    g.box([0.82, base + 1.62, 0], [0.05, 0.28, 0.68], C.dark);
    g.box([0.85, base + 1.62, 0], [0.04, 0.1, 0.46], color, 1);
    g.cylinder([0, base + 2.22, 0], [0.56, 0.34, 0.56], C.dark);
    g.box([0, base + 2.72, 0], [1.65, 0.88, 1.9], C.shell);
    g.box([0.83, base + 2.68, 0], [0.12, 0.58, 1.65], C.dark);
    const eyeHeight = relaxed?.eyeHeight || AWAKE_EYE_HEIGHT;
    for (const side of [-1, 1]) {
      g.box(
        [0.92, base + 2.72, side * 0.42],
        [0.04, eyeHeight + surprise * 0.15, 0.3 + surprise * 0.08],
        surprise ? C.white : color,
        1,
      );
      g.box([0, base + 2.65, side * 1.02], [0.5, 0.48, 0.22], C.metal);
    }
    if (surprise)
      g.box(
        [0.93, base + 2.42, 0],
        [0.04, 0.14 * surprise, 0.17 * surprise],
        C.white,
        1,
      );
    g.rod(
      [-0.43, base + 3.05, -0.48],
      [-0.53, base + 3.62, -0.48],
      0.035,
      C.metal,
    );
    g.octagon([-0.53, base + 3.67, -0.48], [0.19, 0.16, 0.19], color, 1);
    for (const [i, side] of [-1, 1].entries()) {
      const shoulder = [0, base + 1.94, side * 0.96];
      const relaxedArm = relaxed?.arms[i];
      let elbow = relaxedArm
        ? [relaxedArm.elbow[0], base + relaxedArm.elbow[1], relaxedArm.elbow[2]]
        : [0.55, base + 1.2, side * 1.25];
      let hand = relaxedArm
        ? [relaxedArm.hand[0], base + relaxedArm.hand[1], relaxedArm.hand[2]]
        : [1.3, base + 0.98, side * 1.52];
      if (idle) {
        const at = p => [p[0], p[1] + base, p[2]];
        elbow = mix(elbow, at(idle.arms[i].elbow), blend);
        hand = mix(hand, at(idle.arms[i].hand), blend);
      } else if (moving) {
        const swing = Math.sin(pose.stride + i * Math.PI);
        elbow = [-swing * (running ? 0.65 : 0.4), base + 1.25, side * 1.25];
        hand = [
          -swing * (running ? 0.85 : 0.55) + (running ? 0.65 : 0.1),
          base + (running ? 1.7 : 0.75),
          side * 1.1,
        ];
      } else if (working) {
        const stroke = motion ? Math.sin(time * 5 + side * 1.8) : 0;
        hand[1] += 0.2 + stroke * 0.12;
        hand[2] *= 0.75;
      }
      if (lashPose && side === 1) {
        const at = p => [p[0], p[1] + base, p[2]];
        elbow = mix(elbow, at(lashPose.elbow), lashPose.blend);
        hand = mix(hand, at(lashPose.hand), lashPose.blend);
        whipHand = [...hand];
      }
      elbow = mix(elbow, [-0.15, base + 2.6, side * 1.65], surprise);
      hand = mix(hand, [0.25, base + 3.55, side * 1.95], surprise);
      g.octagon(shoulder, [0.48, 0.47, 0.48], C.metal);
      g.rod(shoulder, elbow, 0.18, C.shell);
      g.octagon(elbow, [0.4, 0.36, 0.4], C.dark);
      g.rod(elbow, hand, 0.15, C.metal);
      g.box(hand, [0.38, 0.23, 0.35], C.shell);
      for (const finger of [-1, 1])
        g.box(
          [hand[0] + 0.18, hand[1] - 0.13, hand[2] + finger * 0.12],
          [0.13, 0.26, 0.075],
          C.dark,
        );
    }
    if (idle && blend > 0.5)
      drawIdleActivity(g, g, C, pose.activity, pose.elapsed, {...idle, lift});
    paint(robot, shapes);
    svg.dataset.robotWhip = lash?.target || '';
    if (lash && whipHand) {
      const target = targets().find(
        element => element.dataset.unitId === lash.target,
      );
      const glyph = target?.querySelector('.robot-glyph');
      if (glyph) {
        if (recoilGlyph !== glyph) clearWhip();
        recoilGlyph = glyph;
        glyph.style.translate = `0 ${number(-lashPose.recoil * 16)}px`;
        const bounds = container.getBoundingClientRect();
        const icon = svg.getBoundingClientRect();
        const hit = glyph.getBoundingClientRect();
        const scale = Math.min(icon.width / 240, icon.height / 180);
        const h = rotate(whipHand, yaw);
        h[1] += pose.ground;
        const start = [
          icon.left -
            bounds.left +
            (icon.width - 240 * scale) / 2 +
            (origin + h[0] * 6 + h[2] * 20) * scale,
          -(
            icon.top -
            bounds.top +
            (icon.height - 180 * scale) / 2 +
            (143 - h[1] * 23 - h[0] * 4 + h[2] * 3) * scale
          ),
          0,
        ];
        const end = [
          hit.left - bounds.left + hit.width / 2,
          -(hit.top - bounds.top + hit.height / 2),
          0,
        ];
        const paths = [];
        const geometry = {
          rod(a, b, radius, color) {
            paths.push({
              d: `M${number(a[0] * 24)} ${number(-a[1] * 24)} L${number(b[0] * 24)} ${number(-b[1] * 24)}`,
              fill: 'none',
              stroke: color,
              width: radius * 42,
              depth: 0,
              shade: 0,
            });
          },
        };
        drawRobotWhip(
          geometry,
          geometry,
          C,
          start.map(n => n / 24),
          end.map(n => n / 24),
          lash.age,
        );
        overlay.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
        if (!overlay.parentNode) container.append(overlay);
        paint(overlay, paths);
      }
    }
    svg.dataset.mode = reaction ? 'startled' : pose.mode;
    svg.dataset.activity = pose.activity || '';
    svg.dataset.eyes = String(eyeHeight);
  }

  function drawWorkstation() {
    const shapes = [];
    const g = primitives(shapes, 39);
    g.cylinder([0, 0.25, 0], [3.5, 0.25, 3.1], C.dim);
    g.box([1.95, 0.9, 0], [0.5, 1.25, 1.85], C.dim);
    g.box([1.85, 1.58, 0], [0.85, 0.18, 2.25], C.metal);
    g.box([2.05, 2.02, 0], [0.22, 0.85, 1.9], C.dark);
    g.box([1.91, 2.02, 0], [0.04, 0.6, 1.58], C.cyan, 1);
    for (let row = 0; row < 3; row++)
      g.box(
        [1.88, 2.2 - row * 0.18, 0],
        [0.04, 0.04, 1.05 - row * 0.16],
        C.white,
        1,
      );
    paint(workstation, shapes);
  }
  drawWorkstation();

  function canAnimate() {
    return (
      !disposed &&
      (motion || reaction?.animated) &&
      station &&
      session &&
      visible &&
      !document.hidden &&
      !container.closest('[hidden]')
    );
  }
  function stopFrame() {
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    lastTime = null;
  }
  function schedule() {
    if (frame === null && canAnimate())
      frame = window.requestAnimationFrame(tick);
  }
  function tick(timestamp) {
    frame = null;
    if (!canAnimate()) {
      lastTime = null;
      return;
    }
    const dt =
      lastTime === null ? 0 : Math.min(0.1, (timestamp - lastTime) / 1000);
    // Keep SVG geometry updates at 30 fps while integrating real elapsed time.
    if (lastTime === null || dt >= 1 / 30) {
      lastTime = timestamp;
      if (motion) {
        time += dt;
        syncWhip();
        if (!whip.pose()) controller.tick(dt);
        syncWhip();
        whip.tick(dt);
      }
      if (reaction?.animated) {
        reaction.age += dt;
        if (reaction.age >= STARTLE_SECONDS) reaction = null;
      }
      render();
    }
    schedule();
  }
  function onVisibility() {
    stopFrame();
    if (!document.hidden) {
      render();
      schedule();
    }
  }
  document.addEventListener('visibilitychange', onVisibility);
  const observer = window.IntersectionObserver
    ? new window.IntersectionObserver(entries => {
        visible = entries.some(entry => entry.isIntersecting);
        if (visible) schedule();
        else stopFrame();
      })
    : null;
  observer?.observe(container);

  function detach() {
    whip.cancel();
    clearWhip();
    svg.remove();
    glyph?.classList.remove('parent-fallback-glyph');
    station = null;
    glyph = null;
  }

  return {
    update(data, selectedId) {
      if (disposed) return;
      const next = container.querySelector('.fallback-station.parent-session');
      const nextGlyph = next?.querySelector('.robot-glyph');
      if (next !== station || nextGlyph !== glyph) {
        detach();
        if (nextGlyph) {
          station = next;
          glyph = nextGlyph;
          glyph.classList.add('parent-fallback-glyph');
          glyph.after(svg);
        }
      }
      if (session?.id !== data?.session?.id) {
        reaction = null;
        time = 0;
      }
      session = data?.session || null;
      agents = data?.agents || [];
      selected = selectedId === 'parent';
      controller.update(session);
      if (!session || !station) stopFrame();
      render();
      schedule();
    },
    setMotion(enabled) {
      if (disposed) return;
      motion = Boolean(enabled);
      controller.setMotion(motion);
      whip.setMotion(motion);
      if (motion) reaction = null;
      stopFrame();
      render();
      schedule();
    },
    prompt(sessionId) {
      if (disposed || sessionId !== session?.id) return;
      whip.cancel();
      controller.prompt();
      render();
      schedule();
    },
    cancelPrompt(sessionId) {
      if (disposed || sessionId !== session?.id) return;
      controller.cancelPrompt();
      render();
      schedule();
    },
    startle(animate = true) {
      if (disposed) return;
      whip.cancel();
      controller.stop();
      reaction = {age: 0, animated: Boolean(animate)};
      stopFrame();
      render();
      schedule();
    },
    clearStartle() {
      if (disposed) return;
      reaction = null;
      if (!canAnimate()) stopFrame();
      render();
      schedule();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopFrame();
      observer?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      controller.dispose();
      whip.dispose();
      clearWhip();
      reaction = null;
      session = null;
      detach();
    },
  };
}
