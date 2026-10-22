import {createParentMotion} from './parent-motion.js';
import {
  AWAKE_EYE_HEIGHT,
  relaxedIdlePose,
  idleActivityPose,
  drawIdleActivity,
} from './parent-activities.js';
import {createRobotWhip, whipPose, drawRobotWhip} from './robot-whip.js';
import {factoryIdentity} from './factory-identity.js';
import {createFactoryVisitors, visitorCaneId} from './factory-visitors.js';
import {createRobotDamage} from './robot-damage.js';
import {drawCleanupBot} from './robot-cleanup.js';
import {createEnvironmentDamage} from './environment-damage.js';
import {
  environmentPrimitives,
  drawEnvironmentSurface,
  drawEnvironmentRepairBot,
} from './environment-visuals.js';

const NS = 'http://www.w3.org/2000/svg';
const TAU = Math.PI * 2;
const HOME = -6.25;
const STARTLE_SECONDS = 1.1;
const C = {
  shell: 'var(--robot-shell)',
  outline: 'var(--robot-outline)',
  screen: 'var(--robot-screen)',
  eyes: 'var(--robot-eyes)',
  edge: 'var(--line)',
  metal: 'color-mix(in srgb, var(--robot-shell) 62%, var(--robot-outline))',
  dark: 'var(--bg)',
  white: 'var(--text)',
  dim: 'var(--line)',
  amber: 'var(--amber)',
  cyan: 'var(--cyan)',
  mint: 'var(--mint)',
  running: 'color-mix(in srgb, var(--status-running) 60%, var(--robot-eyes))',
  queued: 'color-mix(in srgb, var(--status-queued) 60%, var(--robot-eyes))',
  completed:
    'color-mix(in srgb, var(--status-completed) 60%, var(--robot-eyes))',
  failed: 'color-mix(in srgb, var(--status-failed) 60%, var(--robot-eyes))',
  cancelling:
    'color-mix(in srgb, var(--status-cancelling) 60%, var(--robot-eyes))',
  compacting:
    'color-mix(in srgb, var(--status-compacting) 60%, var(--robot-eyes))',
  cancelled:
    'color-mix(in srgb, var(--status-cancelled) 60%, var(--robot-eyes))',
};
const ROBOT_C = {...C, dark: C.outline, white: C.eyes};
const STATUS_COLOR = {
  running: C.running,
  queued: C.queued,
  completed: C.completed,
  failed: C.failed,
  cancelling: C.cancelling,
  compacting: C.compacting,
  cancelled: C.cancelled,
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
function primitives(shapes, originX, ground = 0, yaw = 0, home = null) {
  const world = p => {
    const q = rotate(p, yaw);
    q[1] += ground;
    return q;
  };
  const project = p =>
    home?.iso
      ? [
          home.x + (p[0] - p[2]) * home.unit * 0.7,
          home.y - p[1] * home.unit + (p[0] + p[2]) * home.unit * 0.28,
        ]
      : home
        ? [
            home.x + (p[0] * 0.3 - p[2] * 0.9) * home.unit,
            home.y - p[1] * home.unit + p[2] * home.unit * 0.1,
          ]
        : [
            originX + p[0] * 6 + p[2] * 20,
            143 - p[1] * 23 - p[0] * 4 + p[2] * 3,
          ];
  const depth = p =>
    home?.iso ? p[0] + p[2] + p[1] * 0.6 : p[0] + p[1] * 0.6 - p[2] * 0.5;
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
    path(
      [a, b],
      color,
      color,
      Math.max(0.6, radius * (home ? home.unit * 2 : 40)),
    );
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
  const visitors = createFactoryVisitors();
  const damage = createRobotDamage({maxRobots: 16, maxEffects: 80});
  const environment = createEnvironmentDamage();
  let environmentSites = [],
    environmentLayout = '',
    environmentWorkstationKey = '';
  const environmentObjects = new Map();
  const damageVisuals = new Map();
  const visitorVisuals = new Map();
  function effectLayer(className) {
    const layer = document.createElementNS(NS, 'svg');
    layer.setAttribute('class', className);
    layer.setAttribute('aria-hidden', 'true');
    layer.setAttribute('focusable', 'false');
    return layer;
  }
  const floorEffects = effectLayer('robot-floor-effects');
  const debrisEffects = effectLayer('robot-debris-effects');
  const cleanupEffects = effectLayer('robot-cleanup-effects');
  const environmentFloor = effectLayer('environment-floor-effects');
  const environmentEffects = effectLayer('environment-repair-effects');
  const overlay = document.createElementNS(NS, 'svg');
  overlay.setAttribute('class', 'robot-whip-overlay');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.setAttribute('focusable', 'false');
  const visitorSvg = document.createElementNS(NS, 'svg');
  visitorSvg.setAttribute('class', 'factory-visitors-fallback');
  visitorSvg.setAttribute('viewBox', '0 0 240 180');
  visitorSvg.setAttribute('aria-hidden', 'true');
  visitorSvg.setAttribute('focusable', 'false');
  const visitorGroup = document.createElementNS(NS, 'g');
  visitorSvg.append(visitorGroup);
  const visitorNotice = document.createElement('span');
  visitorNotice.className = 'factory-away-notice';
  visitorNotice.setAttribute('aria-live', 'polite');
  let agents = [];
  let agentElements = new Map();
  let damageActive = false;
  let layoutRevision = 0;
  let recoilGlyph = null;
  function clearWhip() {
    recoilGlyph?.style.removeProperty('translate');
    recoilGlyph = null;
    overlay.remove();
  }
  function refreshAgentElements() {
    const next = new Map();
    for (const element of container.querySelectorAll(
      '.fallback-station.agent',
    )) {
      const id = element.dataset.unitId;
      const glyph = element.querySelector('.robot-glyph');
      if (id && glyph) next.set(id, {station: element, glyph});
    }
    const changed =
      next.size !== agentElements.size ||
      [...next].some(([id, visual]) => {
        const previous = agentElements.get(id);
        return (
          previous?.station !== visual.station ||
          previous?.glyph !== visual.glyph
        );
      });
    agentElements = next;
    return changed;
  }
  function whipTargets() {
    const running = new Set(
      agents.filter(a => a.status === 'running').map(a => a.id),
    );
    return [...agentElements]
      .filter(
        ([id, visual]) =>
          visual.station.isConnected &&
          running.has(id) &&
          damage.pose(id).phase === 'alive',
      )
      .map(([, visual]) => visual.station);
  }
  function syncWhip() {
    whip.update(
      session?.id,
      whipTargets().map(element => element.dataset.unitId),
      Boolean(reaction) ||
        damage.pose('parent').panic > 0 ||
        damage.pose('parent').surprise > 0 ||
        damage.pose('parent').flinch > 0 ||
        damage.pose('parent').phase !== 'alive' ||
        damage.pose('parent').offset.some(value => Math.abs(value) > 0.025) ||
        visitors.isAway(session?.id) ||
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
  const ground = document.createElementNS(NS, 'g');
  const robot = document.createElementNS(NS, 'g');
  const robotGeometry = document.createElementNS(NS, 'g');
  robot.append(robotGeometry);
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
  let damagedParentPose = null;
  let visible = true;
  let identity = factoryIdentity('');

  function setData(element, name, value) {
    const text = String(value);
    if (element.dataset[name] !== text) element.dataset[name] = text;
  }
  function setStyle(element, name, value) {
    if (element.style[name] !== value) element.style[name] = value;
  }

  function visibleBounds(rect) {
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      rect.right > 0 &&
      rect.left < window.innerWidth
    );
  }

  function caneTargetList() {
    if (
      disposed ||
      document.hidden ||
      !visible ||
      container.closest('[hidden]')
    )
      return [];
    const ids = new Set(agents.map(agent => agent.id));
    const candidates = [];
    if (
      session &&
      station &&
      robot.style.display !== 'none' &&
      damage.pose('parent').phase === 'alive'
    )
      candidates.push({id: 'parent', geometry: robotGeometry});
    for (const [id, visual] of agentElements) {
      if (ids.has(id) && damage.pose(id).phase === 'alive')
        candidates.push({id, geometry: visual.glyph});
    }
    for (const [id, visual] of visitorVisuals)
      if (damage.pose(id).phase === 'alive')
        candidates.push({id, geometry: visual.geometry});
    return candidates.flatMap(({id, geometry}) => {
      const rect = geometry.getBoundingClientRect();
      if (!visibleBounds(rect)) return [];
      return [
        {
          id,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          radius: Math.max(12, Math.min(rect.width, rect.height) * 0.5),
        },
      ];
    });
  }

  function clearCaneStyle(element) {
    if (!element) return;
    if (element.namespaceURI === NS) element.removeAttribute('transform');
    for (const property of [
      'left',
      'top',
      'rotate',
      'clip-path',
      'visibility',
      '--damage-eye-height',
      '--damage-shade',
      '--damage-char-percent',
    ])
      element.style.removeProperty(property);
    element.classList.remove(
      'robot-damage-body',
      'robot-cane-surprised',
      'robot-damage-corpse',
      'robot-burning',
      'robot-charred',
    );
    for (const key of [
      'damage',
      'damagePhase',
      'damageSurprise',
      'damageFlinch',
      'damageBurning',
      'damageChar',
      'damagePanic',
      'damageCollapse',
      'cleanupPhase',
      'damageVisible',
      'corpseOffset',
    ])
      delete element.dataset[key];
  }

  function clearDamageVisuals() {
    for (const visual of damageVisuals.values()) {
      clearCaneStyle(visual.element);
      visual.marks?.remove();
    }
    damageVisuals.clear();
    clearCaneStyle(robot);
    floorEffects.remove();
    debrisEffects.remove();
    cleanupEffects.remove();
  }

  const effectPath = (d, fill, stroke = C.outline, width = 0.8) => ({
    d,
    fill,
    stroke,
    width,
    depth: 0,
    shade: 0,
  });
  const polygonPath = points =>
    points
      .map((p, i) => `${i ? 'L' : 'M'}${p.map(number).join(' ')}`)
      .join(' ') + ' Z';

  function clearEnvironmentVisuals() {
    environmentFloor.remove();
    environmentEffects.remove();
    for (const visual of environmentObjects.values()) visual.remove();
    environmentObjects.clear();
    environmentLayout = '';
    delete container.dataset.environmentDamage;
  }
  function syncEnvironmentLayout() {
    const bounds = container.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    const key = `${layoutRevision}:${bounds.width}:${bounds.height}:${agents.map(a => a.id).join(',')}`;
    if (environmentLayout === key) return bounds;
    environmentLayout = key;
    const sites = [];
    const add = (id, px, py, kind, unit = 20) =>
      sites.push({
        id,
        px,
        py,
        x: (px / bounds.width) * 24 - 12,
        z: (py / bounds.height) * 12 - 6,
        kind,
        unit,
        h: 0,
        radius: kind === 'floor' ? 0.75 : 0.65,
      });
    for (let col = 0; col < 9; col++)
      for (let row = 0; row < 5; row++)
        add(
          `floor:${col}:${row}`,
          bounds.width * (0.08 + col * 0.105),
          bounds.height * (0.08 + row * 0.21),
          'floor',
          Math.min(23, bounds.width / 28),
        );
    const rect = svg.getBoundingClientRect();
    const matrix = svg.getScreenCTM();
    if (rect.width && rect.height && matrix) {
      const point = svg.createSVGPoint();
      point.x = 50.4;
      point.y = 90;
      const screen = point.matrixTransform(matrix);
      add(
        'workstation:parent',
        screen.x - bounds.left,
        screen.y - bounds.top,
        'furniture',
        Math.max(8, Math.hypot(matrix.a, matrix.b) * 23),
      );
    }
    for (const [id, visual] of agentElements) {
      const rect = visual.station.getBoundingClientRect();
      const robotRect = visual.glyph.getBoundingClientRect();
      const size = Math.max(
        28,
        Math.min(76, rect.width * 0.42, rect.height * 0.6),
      );
      const left = Math.max(
        0,
        Math.min(rect.width - size, robotRect.right - rect.left - 8),
      );
      const top = Math.max(
        0,
        Math.min(rect.height - size, robotRect.bottom - rect.top - size * 0.8),
      );
      let object = environmentObjects.get(id);
      if (!object || object.parentNode !== visual.station) {
        object?.remove();
        object = effectLayer('environment-workstation');
        object.setAttribute('viewBox', '0 0 80 80');
        visual.station.append(object);
        environmentObjects.set(id, object);
      }
      const scaleX = rect.width / Math.max(1, visual.station.offsetWidth);
      const scaleY = rect.height / Math.max(1, visual.station.offsetHeight);
      for (const [name, value] of Object.entries({
        left: left / scaleX,
        top: top / scaleY,
        width: size / scaleX,
        height: size / scaleY,
      }))
        object.style[name] = `${value}px`;
      add(
        `workstation:${id}`,
        rect.left - bounds.left + left + size * 0.525,
        rect.top - bounds.top + top + size * 0.25,
        'machinery',
        size * 0.5,
      );
    }
    for (const [id, visual] of environmentObjects)
      if (!agentElements.has(id)) {
        visual.remove();
        environmentObjects.delete(id);
      }
    environmentSites = sites;
    environment.setSites(sites);
    return bounds;
  }
  function drawEnvironment() {
    const bounds = syncEnvironmentLayout();
    if (!bounds) return;
    const floors = [],
      effects = [];
    for (const site of environmentSites) {
      const pose = environment.pose(site.id);
      const local = {...site, x: 0, z: 0};
      const home = {x: site.px, y: site.py, unit: site.unit, iso: true};
      const g = primitives(floors, 0, 0, 0, home),
        fx = primitives(effects, 0, 0, 0, home);
      if (site.kind === 'floor' && (pose.damage || pose.scorch)) {
        const floor = environmentPrimitives(g, local, pose);
        floor.box([0, -0.03, 0], [1.7, 0.08, 1.3], C.edge);
        floor.box([0, 0.015, 0], [1.58, 0.025, 1.18], C.dark);
      } else if (site.kind !== 'floor' && site.id !== 'workstation:parent') {
        const id = site.id.slice('workstation:'.length),
          object = environmentObjects.get(id);
        if (object) {
          const shapes = [];
          const mesh = environmentPrimitives(
            primitives(shapes, 0, 0, 0, {x: 40, y: 63, unit: 40, iso: true}),
            local,
            pose,
          );
          mesh.box([0, 0.32, 0], [0.9, 0.65, 0.75], C.metal);
          mesh.box([0, 0.72, 0], [1.15, 0.15, 0.95], C.shell);
          mesh.box([0.05, 1.06, -0.15], [0.8, 0.6, 0.14], C.outline);
          mesh.box([0.05, 1.08, -0.04], [0.65, 0.4, 0.04], C.screen);
          if (!pose.scorch && pose.chips < 0.1)
            for (let row = 0; row < 3; row++)
              mesh.box(
                [0.05, 1.21 - row * 0.12, -0.01],
                [0.45 - row * 0.08, 0.04, 0.02],
                C.mint,
                1,
              );
          paint(object, shapes);
        }
      }
      drawEnvironmentSurface(g, fx, C, local, pose, time);
      if (['arriving', 'repairing', 'leaving'].includes(pose?.phase)) {
        const start = site.x < 0 ? -25 : bounds.width + 25;
        const unit = Math.max(34, Math.min(42, site.unit * 1.8));
        const toolHeight = site.kind === 'floor' ? 0 : 0.8;
        const destinationX = site.px + unit * 0.14;
        const botX = start + (destinationX - start) * pose.botProgress;
        const botHome = {
          x: botX,
          y: site.py + unit * (0.556 + toolHeight),
          unit,
          iso: true,
        };
        const bot = primitives(effects, 0, 0, 0, botHome);
        drawEnvironmentRepairBot(
          bot,
          bot,
          C,
          {x: -0.95, z: -0.75, h: toolHeight},
          pose,
          time,
          0,
          [0, 0, 0],
        );
      }
    }
    for (const layer of [environmentFloor, environmentEffects]) {
      layer.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
      if (layer.parentNode !== container) container.append(layer);
    }
    paint(environmentFloor, floors);
    paint(environmentEffects, effects);
    const parentPose = environment.pose('workstation:parent');
    const key = parentPose
      ? [
          parentPose.damage,
          parentPose.dent,
          parentPose.chips,
          parentPose.scorch,
        ]
          .map(n => n.toFixed(2))
          .join(':')
      : '';
    if (key !== environmentWorkstationKey) {
      environmentWorkstationKey = key;
      drawWorkstation();
    }
    setData(
      container,
      'environmentDamage',
      JSON.stringify(environment.poses().filter(p => p.phase !== 'intact')),
    );
  }

  function drawDamageMarks(group, bounds, severity, pose, glyph) {
    const x = bounds.x,
      y = bounds.y,
      w = bounds.width,
      h = bounds.height;
    const p = (a, b) => [x + a * w, y + b * h];
    const shapes = [];
    if (severity > 0) {
      shapes.push(
        effectPath(
          polygonPath([
            p(0.33, 0.42),
            p(0.53, 0.36),
            p(0.66, 0.49),
            p(0.58, 0.65),
            p(0.35, 0.62),
            p(0.27, 0.51),
          ]),
          C.screen,
          C.outline,
          0.5,
        ),
      );
      shapes.push(
        effectPath(
          `M${p(0.45, 0.4).join(' ')} l${number(w * 0.06)} ${number(h * 0.1)} l${number(-w * 0.12)} ${number(h * 0.06)} l${number(w * 0.1)} ${number(h * 0.13)}`,
          'none',
          C.amber,
          Math.max(0.5, w * 0.018),
        ),
      );
    }
    if (severity >= 0.35)
      shapes.push(
        effectPath(
          polygonPath([
            p(0.57, 0.12),
            p(0.78, 0.18),
            p(0.67, 0.3),
            p(0.53, 0.25),
          ]),
          C.screen,
          C.outline,
          0.6,
        ),
      );
    if (severity >= 0.65)
      shapes.push(
        effectPath(
          `M${p(0.15, 0.7).join(' ')} L${p(0.37, 0.75).join(' ')} L${p(0.26, 0.84).join(' ')} M${p(0.72, 0.36).join(' ')} L${p(0.85, 0.56).join(' ')}`,
          'none',
          C.outline,
          Math.max(1, w * 0.055),
        ),
      );
    if (pose.burning) {
      for (let i = 0; i < 9; i++) {
        const cycle = (pose.fireAge * 3 + i / 9) % 1,
          a = 0.05 + i * 0.11,
          b = 0.95 - cycle * 0.65,
          height = (0.25 + (1 - cycle) * 0.3) * pose.burning;
        shapes.push(
          effectPath(
            polygonPath([
              p(a - 0.1, b),
              p(a - 0.08, b - height * 0.4),
              p(a + 0.03, b - height),
              p(a + 0.04, b - height * 0.45),
              p(a + 0.1, b),
            ]),
            '#ff4c16',
            '#ff9c24',
            Math.max(0.4, w * 0.008),
          ),
        );
        shapes.push(
          effectPath(
            polygonPath([
              p(a - 0.04, b),
              p(a + 0.02, b - height * 0.6),
              p(a + 0.05, b),
            ]),
            '#fff19b',
            '#ffbf37',
            0.3,
          ),
        );
      }
    }
    if (glyph && pose.panic) {
      const wave = Math.sin(pose.fireAge * 31) * 0.1;
      for (const side of [-1, 1]) {
        const a = side < 0 ? 0 : 1;
        shapes.push(
          effectPath(
            `M${p(a, 0.65).join(' ')} L${p(a + side * 0.18, 0.4 + wave * side).join(' ')} L${p(a + side * 0.2, 0.03 - wave * side).join(' ')}`,
            'none',
            '#d7e8e5',
            Math.max(2, w * 0.075),
          ),
        );
      }
      shapes.push(
        effectPath(
          polygonPath([
            p(0.42, 0.53),
            p(0.59, 0.53),
            p(0.59, 0.77),
            p(0.42, 0.77),
          ]),
          '#301b17',
          '#fff2ba',
          Math.max(1, w * 0.025),
        ),
      );
    }
    paint(group, shapes);
  }

  function drawHatch(shapes, home, openness) {
    const {x, y, width} = home;
    const w = Math.max(34, width * 1.15),
      h = w * 0.19;
    const point = (a, b) => [x + a * w, y + b * h];
    shapes.push(
      effectPath(
        polygonPath([
          point(-0.59, 0),
          point(-0.43, -0.7),
          point(0.59, -0.7),
          point(0.43, 0.7),
          point(-0.59, 0.7),
        ]),
        C.dark,
        C.metal,
        1.3,
      ),
    );
    for (const side of [-1, 1]) {
      const shift = side * openness * 0.43;
      const a = side < 0 ? -0.51 : 0,
        b = side < 0 ? 0 : 0.51;
      shapes.push(
        effectPath(
          polygonPath([
            point(a + shift, -0.52),
            point(b + shift, -0.52),
            point(b + shift - 0.08, 0.52),
            point(a + shift - 0.08, 0.52),
          ]),
          C.dim,
          C.metal,
          1,
        ),
      );
      for (let i = 0; i < 3; i++) {
        const at = a + shift + 0.09 + i * 0.12;
        shapes.push(
          effectPath(
            `M${point(at, 0.28).join(' ')} L${point(at + 0.06, -0.1).join(' ')}`,
            'none',
            C.amber,
            2,
          ),
        );
      }
    }
  }

  function applyDamage() {
    if (!damageActive && !damageVisuals.size) return;
    let bounds;
    const measureContainer = () =>
      (bounds ||= container.getBoundingClientRect());
    const floors = [],
      fragments = [],
      cleanupShapes = [];
    const activeIds = new Set(agents.map(agent => agent.id));
    const elements = new Map([
      ['parent', {element: robot, geometry: robotGeometry}],
    ]);
    for (const [id, visual] of agentElements)
      if (activeIds.has(id)) elements.set(id, {element: visual.glyph});
    for (const [id, visual] of visitorVisuals) elements.set(id, visual);
    damage.retain([...elements.keys()]);
    const pieces = damage.effects();
    const effectOwners = new Set(pieces.map(piece => piece.owner));
    for (const [id, visual] of damageVisuals) {
      if (elements.has(id)) continue;
      clearCaneStyle(visual.element);
      visual.marks?.remove();
      damageVisuals.delete(id);
    }
    for (const [id, body] of elements) {
      const {element, geometry} = body;
      const pose = damage.pose(id);
      if (!element || (id === 'parent' && robot.style.display === 'none'))
        continue;
      let visual = damageVisuals.get(id);
      if (!pose.damage && pose.phase === 'alive' && !effectOwners.has(id)) {
        clearCaneStyle(visual?.element);
        visual?.marks?.remove();
        damageVisuals.delete(id);
        continue;
      }
      if (visual?.element !== element) {
        clearCaneStyle(visual?.element);
        visual?.marks?.remove();
        const marks = document.createElementNS(NS, geometry ? 'g' : 'svg');
        marks.setAttribute('class', 'robot-damage-marks');
        if (!geometry) marks.setAttribute('viewBox', '0 0 100 100');
        marks.setAttribute('aria-hidden', 'true');
        marks.setAttribute('focusable', 'false');
        element.append(marks);
        visual = {element, marks};
        damageVisuals.set(id, visual);
      }
      const poseKey = JSON.stringify([
        layoutRevision,
        pose.damage,
        pose.phase,
        pose.surprise,
        pose.flinch,
        pose.burning,
        pose.char,
        pose.panic,
        pose.fireAge,
        pose.collapse,
        pose.offset,
        pose.corpseOffset,
        pose.cleanup,
        pose.door,
        pose.lift,
        pose.visible,
      ]);
      if (visual.poseKey === poseKey && visual.home) continue;
      clearCaneStyle(element);
      if (!visual.home || visual.layoutRevision !== layoutRevision) {
        const rect = (geometry || element).getBoundingClientRect();
        if (!rect.width || !rect.height) {
          visual.home = null;
          continue;
        }
        const local = geometry
          ? geometry.getBBox()
          : {x: 0, y: 0, width: 100, height: 100};
        const unit = geometry
          ? (rect.height / Math.max(1, local.height)) * 23
          : rect.height / 1.65;
        const containerBounds = measureContainer();
        visual.home = {
          x: rect.left - containerBounds.left + rect.width / 2,
          y: rect.bottom - containerBounds.top,
          width: rect.width,
          unit,
        };
        visual.local = local;
        visual.rectWidth = rect.width;
        visual.rectHeight = rect.height;
        visual.layoutRevision = layoutRevision;
      }
      const local = visual.local;
      const unit = visual.home.unit;
      const rect = {width: visual.rectWidth, height: visual.rectHeight};
      drawDamageMarks(visual.marks, local, pose.damage, pose, !geometry);
      geometry?.classList.add('robot-damage-material');
      element.style.setProperty('--damage-shade', String(1 - pose.char * 0.94));
      element.style.setProperty('--damage-char-percent', `${pose.char * 100}%`);
      element.classList.toggle('robot-burning', pose.panic > 0);
      element.classList.toggle('robot-charred', pose.char > 0);
      element.dataset.damageBurning = String(number(pose.burning));
      element.dataset.damageChar = String(number(pose.char));
      element.dataset.damagePanic = String(number(pose.panic));
      element.classList.add('robot-damage-body');
      element.dataset.damage = String(number(pose.damage));
      element.dataset.damagePhase = pose.phase;
      element.style.visibility = pose.visible ? '' : 'hidden';
      const collapse = pose.collapse || 0;
      const corpse = ['exploding', 'charring', 'wrecked', 'cleanup'].includes(
        pose.phase,
      );
      element.dataset.damageSurprise = String(number(pose.surprise || 0));
      element.dataset.damageFlinch = String(number(pose.flinch || 0));
      element.dataset.damageCollapse = String(number(collapse));
      element.dataset.cleanupPhase = pose.cleanup?.phase || '';
      element.dataset.damageVisible = String(pose.visible);
      element.dataset.corpseOffset = (pose.corpseOffset || [0, 0, 0])
        .map(number)
        .join(',');
      element.classList.toggle(
        'robot-cane-surprised',
        !corpse && (pose.surprise > 0 || pose.panic > 0),
      );
      element.classList.toggle('robot-damage-corpse', corpse);
      element.style.setProperty(
        '--damage-eye-height',
        `${number(3 + Math.max(pose.surprise, pose.scream) * 5)}px`,
      );
      const [x, y, z] = pose.offset.map(
        (value, axis) => value + (pose.corpseOffset?.[axis] || 0),
      );
      const angle = corpse
        ? collapse * 90
        : ((pose.rotation[0] - pose.rotation[2] * 0.35) * 180) / Math.PI;
      const radians = (angle * Math.PI) / 180;
      const floorShift = (width, height) =>
        (height -
          Math.abs(width * Math.sin(radians)) -
          Math.abs(height * Math.cos(radians))) /
        2;
      const rise =
        pose.phase === 'replacing'
          ? Math.max(0, Math.min(1, 1 + pose.lift / 3.4))
          : 1;
      if (geometry) {
        const dx = (x * 0.3 - z * 0.9) * 23,
          dy =
            -y * 23 +
            (1 - rise) * local.height +
            floorShift(local.width, local.height);
        element.setAttribute(
          'transform',
          `translate(${number(dx)} ${number(dy)}) rotate(${number(angle)} ${number(local.x + local.width / 2)} ${number(local.y + local.height / 2)})`,
        );
      } else {
        element.style.left = `${number((x * 0.3 - z * 0.9) * unit)}px`;
        element.style.top = `${number(-y * unit + (1 - rise) * rect.height + floorShift(rect.width, rect.height))}px`;
        element.style.rotate = `${number(angle)}deg`;
      }
      if (rise < 1)
        element.style.clipPath = `inset(0 0 ${number((1 - rise) * 100)}% 0)`;
      if (pose.phase === 'replacing') drawHatch(floors, visual.home, pose.door);
      if (pose.cleanup) {
        const g = primitives(cleanupShapes, 0, 0, 0, visual.home);
        drawCleanupBot(g, g, ROBOT_C, pose.cleanup);
      }
      visual.poseKey = poseKey;
    }
    for (const fragment of pieces) {
      const home = damageVisuals.get(fragment.owner)?.home;
      if (!home) continue;
      const [x, y, z] = fragment.position;
      const px = home.x + (x * 0.3 - z * 0.9) * home.unit;
      const py = home.y - y * home.unit + z * home.unit * 0.1;
      const w = Math.max(1.2, fragment.size[0] * home.unit),
        h = Math.max(1.2, fragment.size[1] * home.unit);
      const angle = fragment.rotation[2] + fragment.rotation[0] * 0.4;
      const point = (a, b) => [
        px + a * w * Math.cos(angle) - b * h * Math.sin(angle),
        py + a * w * Math.sin(angle) + b * h * Math.cos(angle),
      ];
      const color =
        fragment.kind === 'spark'
          ? C.amber
          : fragment.kind === 'armor'
            ? C.shell
            : C.metal;
      fragments.push({
        ...effectPath(
          polygonPath([
            point(-0.5, -0.5),
            point(0.5, -0.3),
            point(0.35, 0.5),
            point(-0.45, 0.25),
          ]),
          color,
          C.outline,
          0.6,
        ),
        opacity: Math.min(1, fragment.life * 3),
      });
    }
    for (const [layer, shapes] of [
      [floorEffects, floors],
      [debrisEffects, fragments],
      [cleanupEffects, cleanupShapes],
    ]) {
      if (shapes.length) {
        const containerBounds = measureContainer();
        const viewBox = `0 0 ${Math.max(1, containerBounds.width)} ${Math.max(1, containerBounds.height)}`;
        if (layer.getAttribute('viewBox') !== viewBox)
          layer.setAttribute('viewBox', viewBox);
      }
      paint(layer, shapes);
      if (shapes.length && !layer.parentNode) container.append(layer);
      else if (!shapes.length) layer.remove();
    }
    damageActive =
      pieces.length > 0 ||
      [...elements.keys()].some(id => {
        const pose = damage.pose(id);
        return (
          pose.damage > 0 ||
          pose.phase !== 'alive' ||
          pose.surprise > 0 ||
          pose.flinch > 0 ||
          pose.offset.some(value => Math.abs(value) > 0.025)
        );
      });
  }

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
      for (const [name, value] of Object.entries({
        d: shape.d,
        fill: shape.fill,
        stroke: shape.stroke,
        'stroke-width': number(shape.width),
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        opacity: shape.opacity ?? 1,
      })) {
        const text = String(value);
        if (element.getAttribute(name) !== text)
          element.setAttribute(name, text);
      }
      // A black overlay is unnecessary: brightness also follows theme colors.
      const filter = shape.shade ? `brightness(${1 - shape.shade})` : '';
      if (element.style.filter !== filter) element.style.filter = filter;
    });
  }

  function drawVisitors() {
    const visiting = visitors
      .visitorsAt(session?.id)
      .filter(visitor => visitor.id !== session?.id);
    const shown = new Set();
    for (const visitor of visiting) {
      const id = visitorCaneId(visitor.id);
      shown.add(id);
      let visual = visitorVisuals.get(id);
      if (!visual) {
        const element = document.createElementNS(NS, 'g');
        const geometry = document.createElementNS(NS, 'g');
        element.dataset.visitorId = visitor.id;
        element.append(geometry);
        visitorGroup.append(element);
        visual = {element, geometry};
        visitorVisuals.set(id, visual);
      }
      const source = factoryIdentity(visitor.id);
      const accent = `var(--${source.accentKey})`;
      const origin = 174 + (visitor.x + 5.05) * 7;
      const shapes = [];
      const g = primitives(shapes, origin, 0, visitor.yaw);
      const damagePose = damage.pose(id);
      const corpse = ['exploding', 'charring', 'wrecked', 'cleanup'].includes(
        damagePose.phase,
      );
      const surprise = corpse
        ? 0
        : Math.max(
            visitor.surprise || 0,
            damagePose.surprise || 0,
            damagePose.scream,
          );
      const braced =
        damagePose.panic > 0 ||
        damagePose.surprise > 0 ||
        damagePose.phase !== 'alive';
      const moving =
        !braced && (visitor.phase === 'arrive' || visitor.phase === 'depart');
      const running = visitor.phase === 'depart';
      const jump = braced ? 0 : visitor.jump || 0;
      g.cylinder([0, 0.05, 0], [1.5, 0.03, 1.05], C.dark);
      for (const [index, side] of [-1, 1].entries()) {
        const phase = Math.sin(visitor.stride + index * Math.PI);
        const footX = moving ? phase * (running ? 0.42 : 0.25) : 0;
        const footY = jump + Math.max(0, phase) * (running ? 0.24 : 0.12);
        g.box(
          [footX + 0.1, 0.24 + footY, side * 0.34],
          [0.68, 0.22, 0.4],
          C.metal,
        );
        g.rod(
          [footX, 0.34 + footY, side * 0.34],
          [-0.1, 0.8 + jump, side * 0.34],
          0.11,
          C.outline,
        );
      }
      g.box([0, 1.34 + jump, 0], [0.94, 0.86, 1], C.shell);
      g.box([0.49, 1.35 + jump, 0], [0.035, 0.22, 0.62], accent, 1);
      g.box([0.04, 2.17 + jump, 0], [1.06, 0.62, 1.14], C.shell);
      g.box([0.54, 2.17 + jump, 0], [0.09, 0.43, 1.08], C.outline);
      g.box([0.59, 2.17 + jump, 0], [0.08, 0.35, 0.96], C.screen);
      for (const side of [-1, 1]) {
        if (!corpse)
          g.box(
            [0.64, 2.2 + jump, side * 0.27],
            [0.04, 0.1 + surprise * 0.12, 0.19],
            C.eyes,
            1,
          );
        const swing = moving
          ? Math.sin(visitor.stride + (side === 1 ? Math.PI : 0))
          : 0;
        g.rod(
          [0, 1.65 + jump, side * 0.62],
          [
            -swing * 0.36,
            1.05 +
              jump +
              damagePose.panic *
                (1.7 + Math.sin(damagePose.fireAge * 31 + side) * 0.3),
            side * 0.8,
          ],
          0.1,
          C.metal,
        );
      }
      paint(visual.geometry, shapes);
    }
    for (const [id, visual] of visitorVisuals) {
      if (shown.has(id)) continue;
      visual.element.remove();
      visitorVisuals.delete(id);
    }
    setData(
      visitorSvg,
      'visitors',
      visiting.map(visitor => visitor.id).join(','),
    );
    if (visiting.length && !visitorSvg.parentNode) container.append(visitorSvg);
    else if (!visiting.length) visitorSvg.remove();
  }

  function render() {
    if (disposed || !station || !session) return;
    syncWhip();
    drawVisitors();
    const parentDamage = damage.pose('parent');
    const corpse = ['exploding', 'charring', 'wrecked', 'cleanup'].includes(
      parentDamage.phase,
    );
    const caneSurprise = Math.max(parentDamage.surprise, parentDamage.scream);
    const damagePaused =
      parentDamage.phase !== 'alive' ||
      caneSurprise > 0 ||
      parentDamage.flinch > 0;
    const ownAway = !damagePaused && visitors.isAway(session.id);
    const awayMessage = visitors.awayMessage(session.id);
    if (awayMessage) {
      if (visitorNotice.textContent !== awayMessage)
        visitorNotice.textContent = awayMessage;
      setData(station, 'awayLabel', awayMessage);
      station.classList.add('parent-is-away');
      if (!visitorNotice.parentNode) station.append(visitorNotice);
    } else {
      visitorNotice.remove();
      if ('awayLabel' in station.dataset) delete station.dataset.awayLabel;
      station.classList.remove('parent-is-away');
    }
    const ownTravel = visitors
      .visitorsAt(session.id)
      .find(visitor => visitor.id === session.id);
    setStyle(robot, 'display', ownAway && !ownTravel ? 'none' : '');
    setStyle(ground, 'display', robot.style.display);
    setStyle(
      ground,
      'visibility',
      parentDamage.phase === 'alive' ? '' : 'hidden',
    );
    if (ownAway && !ownTravel) {
      applyDamage();
      drawEnvironment();
      setData(svg, 'mode', 'away');
      setData(svg, 'activity', '');
      setData(svg, 'eyes', AWAKE_EYE_HEIGHT);
      return;
    }
    const currentPose = ownTravel
      ? {
          mode:
            ownTravel.phase === 'startled'
              ? 'startled'
              : ownTravel.phase === 'visit'
                ? 'rest'
                : ['depart', 'homecoming'].includes(ownTravel.phase)
                  ? 'return'
                  : 'walk',
          activity: null,
          elapsed: 0,
          duration: 0,
          x: ownTravel.x,
          z: ownTravel.z,
          yaw: ownTravel.yaw,
          ground: 0,
          stride: ownTravel.stride,
          jump: ownTravel.jump,
          surprise: ownTravel.surprise,
        }
      : controller.pose();
    if (!damagePaused) damagedParentPose = null;
    else if (!damagedParentPose) damagedParentPose = {...currentPose};
    const pose = damagedParentPose || currentPose;
    const lash = ownTravel || damagePaused ? null : whip.pose();
    const lashPose = lash ? whipPose(lash.age) : null;
    let whipHand;
    const idle =
      !damagePaused && pose.activity
        ? idleActivityPose(pose.activity, pose.elapsed)
        : null;
    const relaxed =
      pose.mode === 'rest' && !reaction && !damagePaused
        ? relaxedIdlePose(time, motion)
        : null;
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
    const moving =
      !damagePaused && (pose.mode === 'walk' || pose.mode === 'return');
    const running = pose.mode === 'return';
    const working = !damagePaused && pose.mode === 'work';
    const stop =
      ownTravel || damagePaused
        ? {jump: 0, surprise: 0, squash: 0}
        : reactionPose(reaction);
    const surprise = corpse
      ? 0
      : Math.max(stop.surprise, pose.surprise, caneSurprise);
    const jump = damagePaused ? 0 : stop.jump + pose.jump;
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
      (relaxed?.lift || 0) -
      (corpse ? 0 : parentDamage.flinch || 0) * 0.16;
    const base = 0.4 + lift;
    const signalColor = corpse ? C.dim : STATUS_COLOR[session.status] || C.dim;
    const ringColor = working ? signalColor : C.mint;
    const origin = 57 + (pose.x - HOME) * 8.8;
    const shapes = [];
    const yaw = pose.yaw + (idle?.yaw || 0) * blend - (lashPose?.turn || 0);
    const g = primitives(shapes, origin, pose.ground, yaw);
    const floorShapes = [];
    const floor = primitives(floorShapes, origin, pose.ground, yaw);
    floor.cylinder(
      [0, 0.36, 0],
      [2.25 - jump * 0.3, 0.04, 1.5 - jump * 0.18],
      C.dark,
    );
    if (working) floor.ring([0, 0.395, 0], 2.05, 0.075, C.screen);
    if (selected || working) floor.ring([0, 0.4, 0], 2.05, 0.04, ringColor);
    paint(ground, floorShapes);
    for (const [i, side] of [-1, 1].entries()) {
      const step = moving ? Math.sin(pose.stride + i * Math.PI) : 0;
      const foot = idle?.feet[i];
      const x =
        step * (running ? 0.7 : 0.42) +
        (foot?.x || 0) * blend +
        Math.sin(parentDamage.fireAge * 27 + (side * Math.PI) / 2) *
          parentDamage.panic *
          0.38;
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
        C.outline,
      );
      g.octagon([-0.23, 1.03 + lift, side * 0.54], [0.52, 0.25, 0.52], C.metal);
    }
    g.octagon([0, base + 1, 0], [1.2, 0.3, 1.24], C.outline);
    g.box([0, base + 1.55, 0], [1.45, 1.12, 1.52], C.shell);
    g.box([0.75, base + 1.54, 0], [0.09, 0.84, 1.15], C.outline);
    g.box([0.82, base + 1.62, 0], [0.05, 0.28, 0.68], C.screen);
    if (!corpse)
      g.box([0.85, base + 1.62, 0], [0.04, 0.1, 0.46], signalColor, 1);
    g.cylinder([0, base + 2.22, 0], [0.56, 0.34, 0.56], C.outline);
    g.box([0, base + 2.72, 0], [1.65, 0.88, 1.9], C.shell);
    g.box([0.78, base + 2.68, 0], [0.14, 0.66, 1.77], C.outline);
    g.box([0.83, base + 2.68, 0], [0.12, 0.58, 1.65], C.screen);
    const eyeHeight = corpse
      ? 0
      : (relaxed?.eyeHeight || AWAKE_EYE_HEIGHT) + surprise * 0.15;
    for (const side of [-1, 1]) {
      if (!corpse)
        g.box(
          [0.92, base + 2.72, side * 0.42],
          [0.04, eyeHeight, 0.3 + surprise * 0.08],
          C.eyes,
          1,
        );
      g.box([0, base + 2.65, side * 1.02], [0.5, 0.48, 0.22], C.metal);
    }
    if (surprise)
      g.box(
        [0.93, base + 2.42, 0],
        [0.04, 0.14 * surprise, 0.17 * surprise],
        C.eyes,
        1,
      );
    g.rod(
      [-0.43, base + 3.05, -0.48],
      [-0.53, base + 3.62, -0.48],
      0.035,
      C.metal,
    );
    g.octagon([-0.53, base + 3.67, -0.48], [0.23, 0.18, 0.23], C.screen);
    g.octagon(
      [-0.53, base + 3.79, -0.48],
      [0.15, 0.07, 0.15],
      corpse ? C.metal : signalColor,
      corpse ? 0 : 1,
    );
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
      const raisedArms = corpse
        ? 0
        : Math.max(stop.surprise, damagePaused ? 0 : pose.surprise);
      elbow = mix(elbow, [-0.15, base + 2.6, side * 1.65], raisedArms);
      hand = mix(hand, [0.25, base + 3.55, side * 1.95], raisedArms);
      elbow = mix(elbow, [0.5, base + 1.95, side * 1.23], caneSurprise);
      hand = mix(hand, [1.04, base + 2.65, side * 0.85], caneSurprise);
      const wave = Math.sin(parentDamage.fireAge * 31 + side * 2);
      elbow = mix(
        elbow,
        [-0.15, base + 2.6 + wave * 0.25, side * 1.65],
        parentDamage.panic,
      );
      hand = mix(
        hand,
        [0.25, base + 3.55 + wave * 0.35, side * 1.95],
        parentDamage.panic,
      );
      g.octagon(shoulder, [0.48, 0.47, 0.48], C.metal);
      g.rod(shoulder, elbow, 0.18, C.shell);
      g.octagon(elbow, [0.4, 0.36, 0.4], C.outline);
      g.rod(elbow, hand, 0.15, C.metal);
      g.box(hand, [0.38, 0.23, 0.35], C.shell);
      for (const finger of [-1, 1])
        g.box(
          [hand[0] + 0.18, hand[1] - 0.13, hand[2] + finger * 0.12],
          [0.13, 0.26, 0.075],
          C.outline,
        );
    }
    if (idle && blend > 0.5)
      drawIdleActivity(g, g, C, pose.activity, pose.elapsed, {...idle, lift});
    paint(robotGeometry, shapes);
    setData(svg, 'robotWhip', lash?.target || '');
    if (lash && whipHand) {
      const target = whipTargets().find(
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
          ROBOT_C,
          start.map(n => n / 24),
          end.map(n => n / 24),
          lash.age,
        );
        overlay.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
        if (!overlay.parentNode) container.append(overlay);
        paint(overlay, paths);
      }
    }
    applyDamage();
    drawEnvironment();
    setData(
      svg,
      'mode',
      parentDamage.phase !== 'alive'
        ? parentDamage.phase
        : caneSurprise || reaction
          ? 'startled'
          : pose.mode,
    );
    setData(svg, 'activity', damagePaused ? '' : pose.activity || '');
    setData(svg, 'eyes', eyeHeight);
  }

  function drawWorkstation() {
    const shapes = [];
    const g = environmentPrimitives(
      primitives(shapes, 39),
      {x: 1.85, z: 0},
      environment.pose('workstation:parent'),
    );
    const accent = `var(--${identity.accentKey})`;
    g.cylinder([0, 0.25, 0], [3.5, 0.25, 3.1], C.dim);
    g.box([1.95, 0.9, 0], [0.5, 1.25, 1.85], C.dim);
    g.box([1.85, 1.58, 0], [0.85, 0.18, 2.25], C.metal);
    g.box([2.05, 2.02, 0], [0.22, 0.85, 1.9], C.dark);
    g.box([1.91, 2.02, 0], [0.04, 0.6, 1.58], accent, 1);
    for (let row = 0; row < 3; row++)
      g.box(
        [1.88, 2.2 - row * 0.18, 0],
        [0.04, 0.04, 1.05 - row * 0.16],
        C.white,
        1,
      );
    for (let index = 0; index <= identity.roof; index++) {
      const z = -1.1 + index * 1.1;
      g.rod([-0.8, 3.2, z], [0.15, 3.65, z], 0.045, C.metal);
      g.rod([0.15, 3.65, z], [1.05, 3.2, z], 0.045, accent);
    }
    for (let index = 0; index < identity.utilities; index++)
      g.cylinder(
        [-1.35, 0.65, -0.85 + index * 0.55],
        [0.42, 1.05, 0.42],
        index % 2 ? C.metal : accent,
      );
    ground.remove();
    paint(workstation, shapes);
    workstation.append(ground);
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
    const elapsed =
      lastTime === null ? 0 : Math.max(0, (timestamp - lastTime) / 1000);
    const dt = Math.min(0.1, elapsed);
    // Keep SVG geometry updates at 30 fps while integrating real elapsed time.
    if (lastTime === null || dt >= 1 / 30) {
      lastTime = timestamp;
      if (motion) {
        time += dt;
        syncWhip();
        const parentDamage = damage.pose('parent');
        if (
          !whip.pose() &&
          parentDamage.phase === 'alive' &&
          !parentDamage.surprise &&
          !parentDamage.flinch &&
          !parentDamage.panic &&
          !parentDamage.offset.some(value => Math.abs(value) > 0.025)
        )
          controller.tick(dt);
        visitors.observeLocalPose(session?.id, controller.pose());
        const pausedVisitors = visitors
          .visitorsAt(session?.id)
          .filter(visitor => {
            const pose = damage.pose(
              visitor.id === session?.id ? 'parent' : visitorCaneId(visitor.id),
            );
            return (
              pose.panic > 0 || pose.surprise > 0 || pose.phase !== 'alive'
            );
          })
          .map(visitor => visitor.id);
        if (
          session?.id &&
          (parentDamage.panic > 0 ||
            parentDamage.surprise > 0 ||
            parentDamage.phase !== 'alive') &&
          !pausedVisitors.includes(session.id)
        )
          pausedVisitors.push(session.id);
        visitors.tick(dt, pausedVisitors);
        controller.setAway(visitors.isAway(session?.id));
        syncWhip();
        whip.tick(dt);
      }
      if (reaction?.animated) {
        reaction.age += dt;
        if (reaction.age >= STARTLE_SECONDS) reaction = null;
      }
      if (motion) {
        damage.tick(dt);
        environment.tick(elapsed);
      }
      render();
    }
    schedule();
  }
  function onVisibility() {
    stopFrame();
    if (!document.hidden && visible && !container.closest('[hidden]')) {
      render();
      schedule();
    }
  }
  function renderUpdate(immediate = false) {
    if (
      disposed ||
      document.hidden ||
      !visible ||
      container.closest('[hidden]')
    )
      return;
    if (immediate || !canAnimate() || frame === null) render();
    schedule();
  }
  document.addEventListener('visibilitychange', onVisibility);
  const observer = window.IntersectionObserver
    ? new window.IntersectionObserver(entries => {
        visible = entries.some(entry => entry.isIntersecting);
        if (visible && !document.hidden && !container.closest('[hidden]')) {
          render();
          schedule();
        } else stopFrame();
      })
    : null;
  observer?.observe(container);
  const layoutObserver = window.ResizeObserver
    ? new window.ResizeObserver(() => {
        layoutRevision++;
        for (const visual of damageVisuals.values()) visual.poseKey = '';
        renderUpdate(true);
      })
    : null;
  layoutObserver?.observe(container);

  function detach() {
    whip.cancel();
    clearWhip();
    clearDamageVisuals();
    clearEnvironmentVisuals();
    svg.remove();
    glyph?.classList.remove('parent-fallback-glyph');
    visitorNotice.remove();
    station?.classList.remove('parent-is-away');
    if (station) delete station.dataset.awayLabel;
    visitorSvg.remove();
    for (const visual of visitorVisuals.values()) visual.element.remove();
    visitorVisuals.clear();
    agentElements.clear();
    station = null;
    glyph = null;
  }

  return {
    updateHub(hub) {
      if (disposed) return;
      visitors.update(hub);
      controller.setAway(visitors.isAway(session?.id));
      renderUpdate();
    },
    update(data, selectedId) {
      if (disposed) return;
      let immediate = false;
      const next = container.querySelector('.fallback-station.parent-session');
      const nextGlyph = next?.querySelector('.robot-glyph');
      if (next !== station || nextGlyph !== glyph) {
        immediate = true;
        detach();
        if (nextGlyph) {
          station = next;
          glyph = nextGlyph;
          glyph.classList.add('parent-fallback-glyph');
          glyph.after(svg);
        }
      }
      if (session?.id !== data?.session?.id) {
        immediate = true;
        reaction = null;
        damagedParentPose = null;
        clearDamageVisuals();
        damage.reset();
        environment.reset();
        clearEnvironmentVisuals();
        environmentWorkstationKey = '';
        damageActive = false;
        time = 0;
        identity = factoryIdentity(data?.session?.id);
        svg.dataset.factoryIdentity = identity.token;
        drawWorkstation();
      }
      visitors.update(data?.sessions ? data : data?.hub || data);
      session = data?.session || null;
      const previousAgentIds = agents.map(agent => agent.id).join('|');
      agents = data?.agents || [];
      const agentLayoutChanged =
        refreshAgentElements() ||
        previousAgentIds !== agents.map(agent => agent.id).join('|');
      if (agentLayoutChanged) {
        immediate = true;
        layoutRevision++;
        for (const visual of damageVisuals.values()) visual.poseKey = '';
      }
      const nextSelected = selectedId === 'parent';
      if (selected !== nextSelected) immediate = true;
      selected = nextSelected;
      controller.update(session);
      visitors.observeLocalPose(session?.id, controller.pose());
      controller.setAway(visitors.isAway(session?.id));
      if (!session || !station) stopFrame();
      renderUpdate(immediate);
    },
    setMotion(enabled) {
      if (disposed) return;
      motion = Boolean(enabled);
      controller.setMotion(motion);
      visitors.setMotion(motion);
      whip.setMotion(motion);
      damage.setMotion(motion);
      environment.setMotion(motion);
      damagedParentPose = null;
      if (motion) reaction = null;
      clearDamageVisuals();
      stopFrame();
      render();
      schedule();
    },
    prompt(sessionId) {
      if (disposed || sessionId !== session?.id) return;
      whip.cancel();
      if (!visitors.prompt(sessionId)) controller.prompt();
      controller.setAway(visitors.isAway(sessionId));
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
    caneTargets() {
      return caneTargetList();
    },
    environmentTargets() {
      if (
        disposed ||
        document.hidden ||
        !visible ||
        container.closest('[hidden]')
      )
        return [];
      const bounds = syncEnvironmentLayout();
      if (!bounds || !session) return [];
      return environmentSites
        .map(site => ({
          id: site.id,
          x: bounds.left + site.px,
          y: bounds.top + site.py,
          radius: Math.max(9, site.radius * site.unit),
        }))
        .filter(
          p =>
            p.x >= Math.max(0, bounds.left) &&
            p.x <= Math.min(window.innerWidth, bounds.right) &&
            p.y >= Math.max(0, bounds.top) &&
            p.y <= Math.min(window.innerHeight, bounds.bottom),
        );
    },
    hitEnvironment(id, weapon, amount = 1) {
      if (disposed || !environment.hit(id, weapon, amount)) return false;
      render();
      schedule();
      return true;
    },
    burnRobot(id, seconds) {
      if (
        disposed ||
        !Number.isFinite(seconds) ||
        seconds <= 0 ||
        !caneTargetList().some(target => target.id === id)
      )
        return false;
      if (!damage.burn(id, seconds)) return false;
      damageActive = true;
      reaction = null;
      whip.cancel();
      render();
      schedule();
      return true;
    },
    hitWithCane(id, direction = 1, strength = 1) {
      if (disposed || !caneTargetList().some(target => target.id === id))
        return false;
      if (!damage.hit(id, direction, strength)) return false;
      damageActive = true;
      stopFrame();
      render();
      schedule();
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopFrame();
      observer?.disconnect();
      layoutObserver?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      controller.dispose();
      visitors.dispose();
      whip.dispose();
      clearWhip();
      damage.dispose();
      environment.dispose();
      clearEnvironmentVisuals();
      clearDamageVisuals();
      visitorSvg.remove();
      reaction = null;
      damagedParentPose = null;
      session = null;
      detach();
    },
  };
}
