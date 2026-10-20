/* global window, document, requestAnimationFrame, cancelAnimationFrame, ResizeObserver, IntersectionObserver */
import {createParentMotion} from './parent-motion.js';
import {AWAKE_EYE_HEIGHT} from './parent-activities.js';
import {createFactoryVisitors, visitorCaneId} from './factory-visitors.js';
import {createRobotDamage} from './robot-damage.js';
import {createRobotWhip, whipPose} from './robot-whip.js';
import {factoryIdentity} from './factory-identity.js';

const TAU = Math.PI * 2;
const WORKING = new Set(['running', 'cancelling']);
const BAYS = [
  [-1.5, -3.1],
  [2.6, -3.1],
  [6.7, -3.1],
  [-1.5, 3.1],
  [2.6, 3.1],
  [6.7, 3.1],
  [-7.4, 3.65],
  [-5.3, -4.4],
];
const QUEUE_SLOTS = [6, 7, 3, 4, 5, 0, 1, 2];
const DEFAULTS = {
  shell: '#e4e7d6',
  outline: '#29464b',
  screen: '#102d39',
  eyes: '#c2ffe3',
  white: '#fff4d4',
  metal: '#668487',
  selection: '#fff1a9',
  mint: '#69efba',
  cyan: '#67d9ff',
  amber: '#ffd066',
  red: '#ff655b',
  violet: '#c6a0ff',
  rose: '#ff9fcf',
  dim: '#a4b2ad',
  running: '#7bf0a4',
  queued: '#ffe075',
  completed: '#9ac8ff',
  failed: '#ff8d92',
  cancelling: '#ffb578',
  cancelled: '#b7c4cb',
  compacting: '#dab7ff',
};
const DATA_KEYS = [
  'renderer',
  'factoryIdentity',
  'factoryVisitors',
  'parentMode',
  'parentActivity',
  'parentAway',
  'parentAwayLabel',
  'parentStatus',
  'parentWork',
  'parentEyes',
  'robotWhip',
  'robotDamage',
  'robotDebris',
  'robotCleanup',
  'agentStatuses',
  'sceneEvents',
];
const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
const unsettled = pose => pose.phase !== 'alive' || pose.surprise > 0;
const iso = (x, z, h = 0) => [(x - z) * 14, (x + z) * 7 - h];
const rgb = color => `rgb(${color.map(n => Math.round(n * 255)).join(',')})`;

/** A pixel office. The dashboard owns selection labels and motion preferences;
 * the shared controllers own the same decorative lifecycles as the factory. */
export function createYear1998Scene(
  canvas,
  {onSelect = () => {}, onLayout = () => {}} = {},
) {
  let output;
  try {
    output = canvas.getContext('2d', {alpha: false});
  } catch {
    return null;
  }
  if (!output) return null;
  // Render on a small pixel grid, then present with nearest-neighbour scaling.
  const pixels = document.createElement('canvas');
  const ctx = pixels.getContext('2d', {alpha: false});
  if (!ctx) return null;
  const originalLabel = canvas.getAttribute('aria-label');
  const parent = createParentMotion();
  const visitors = createFactoryVisitors();
  const damage = createRobotDamage();
  const whip = createRobotWhip();
  const damageHomes = new Map();
  let colors = {...DEFAULTS};
  let disposed = false,
    motion = true,
    inView = true,
    frame = 0;
  let width = 1,
    height = 1,
    pixelWidth = 420,
    pixelHeight = 265;
  let snapshot = null,
    sessionId,
    selected = 'parent',
    initialized = false;
  let identity = factoryIdentity('');
  let units = [],
    slots = new Map(),
    previous = new Map(),
    effects = [];
  let anchors = [],
    lastLayout = '',
    lastFrame = 0,
    lastPaint = 0,
    time = 0;
  let reaction = null;
  let camera = {x: -100, y: -38, zoom: 1.5};

  function data(name, value) {
    const text = String(value);
    if (canvas.dataset[name] !== text) canvas.dataset[name] = text;
  }
  function color(status) {
    return colors[status] || colors.dim;
  }
  function visible() {
    return (
      !disposed &&
      !document.hidden &&
      !canvas.closest('[hidden]') &&
      (inView || Boolean(canvas.closest(':popover-open, :modal')))
    );
  }
  function canAnimate() {
    return motion && visible();
  }
  function positionFor(unit) {
    return BAYS[slots.get(unit.id) ?? 0];
  }
  function reconcile(value) {
    const agents = value?.agents || [];
    const live = agents.filter(agent => WORKING.has(agent.status));
    const queue = agents.filter(agent => agent.status === 'queued');
    const history = agents
      .filter(agent => !WORKING.has(agent.status) && agent.status !== 'queued')
      .sort((a, b) =>
        String(b.finishedAt || b.createdAt || '').localeCompare(
          String(a.finishedAt || a.createdAt || ''),
        ),
      );
    const chosen = history.find(agent => agent.id === selected);
    units = [
      ...live,
      ...queue,
      ...(chosen ? [chosen] : []),
      ...history.filter(agent => agent !== chosen),
    ].slice(0, 8);
    const next = new Map(),
      taken = new Set();
    for (const unit of units) {
      const old = slots.get(unit.id);
      const keep =
        old !== undefined &&
        !taken.has(old) &&
        (unit.status !== 'queued' || old >= 6) &&
        (!WORKING.has(unit.status) || old < 6);
      const preferences =
        unit.status === 'queued' ? QUEUE_SLOTS : [0, 1, 2, 3, 4, 5, 6, 7];
      const slot = keep ? old : preferences.find(index => !taken.has(index));
      next.set(unit.id, slot);
      taken.add(slot);
    }
    slots = next;
    if (initialized && motion) {
      for (const unit of units) {
        const before = previous.get(unit.id);
        if (before === unit.status) continue;
        effects.push({
          id: unit.id,
          status: unit.status,
          event: before ? unit.status : 'spawned',
          age: 0,
        });
      }
      effects = effects.slice(-24);
    }
    previous = new Map(agents.map(agent => [agent.id, agent.status]));
    initialized = true;
  }

  function rect(x, y, w, h, fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(
      Math.round(x),
      Math.round(y),
      Math.max(1, Math.round(w)),
      Math.max(1, Math.round(h)),
    );
  }
  function polygon(points, fill) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    points.forEach(([x, y], index) =>
      index
        ? ctx.lineTo(Math.round(x), Math.round(y))
        : ctx.moveTo(Math.round(x), Math.round(y)),
    );
    ctx.closePath();
    ctx.fill();
  }
  function line(points, stroke, weight = 1) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = weight;
    ctx.lineJoin = 'miter';
    ctx.beginPath();
    points.forEach(([x, y], index) =>
      index
        ? ctx.lineTo(Math.round(x) + 0.5, Math.round(y) + 0.5)
        : ctx.moveTo(Math.round(x) + 0.5, Math.round(y) + 0.5),
    );
    ctx.stroke();
  }
  function tile(x, z, w, d, fill, elevation = 0) {
    polygon(
      [
        iso(x, z, elevation),
        iso(x + w, z, elevation),
        iso(x + w, z + d, elevation),
        iso(x, z + d, elevation),
      ],
      fill,
    );
  }
  function box(x, z, w, d, h, surface, front, side, bottom = 0) {
    const x0 = x - w / 2,
      z0 = z - d / 2;
    const a = iso(x0, z0, h),
      b = iso(x0 + w, z0, h);
    const c = iso(x0 + w, z0 + d, h),
      e = iso(x0, z0 + d, h);
    polygon(
      [e, c, iso(x0 + w, z0 + d, bottom), iso(x0, z0 + d, bottom)],
      front,
    );
    polygon([c, b, iso(x0 + w, z0, bottom), iso(x0 + w, z0 + d, bottom)], side);
    polygon([a, b, c, e], surface);
    line([e, c, b], '#304c50');
    return iso(x, z, h);
  }
  function panel(x, z, w, low, high, fill, axis = 'x') {
    const end = axis === 'x' ? [x + w, z] : [x, z + w];
    polygon(
      [iso(x, z, low), iso(...end, low), iso(...end, high), iso(x, z, high)],
      fill,
    );
  }
  function text(label, x, y, fill, size = 7) {
    ctx.font = `bold ${size}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = fill;
    ctx.fillText(label, Math.round(x), Math.round(y));
  }
  function diamond(x, y, w, h, fill) {
    polygon(
      [
        [x, y - h],
        [x + w, y],
        [x, y + h],
        [x - w, y],
      ],
      fill,
    );
  }

  function drawGround() {
    // A finite carpeted room with a visible cutaway slab and a clear aisle.
    box(-1.3, -0.45, 21, 11.9, 0, '#829397', '#566970', '#43575f', -6);
    for (let x = -11.8; x < 9.2; x += 1.2) {
      for (let z = -6.4; z < 5.5; z += 1.2) {
        const shade =
          (Math.round((x + 11.8) / 1.2) + Math.round((z + 6.4) / 1.2)) % 2
            ? '#83979c'
            : '#7e9399';
        tile(x, z, Math.min(1.17, 9.2 - x), Math.min(1.17, 5.5 - z), shade);
      }
    }
    tile(-11.65, -0.7, 20.7, 1.4, '#718992');
    tile(-10.9, -6.25, 1.25, 11.6, '#718992');
    BAYS.forEach(([x, z], slot) => {
      tile(x - 1.22, z - 1.65, 2.65, 2.6, slot >= 6 ? '#99a5a5' : '#a5b1ad');
      tile(x - 1.13, z - 1.56, 2.47, 2.42, '#9daaaa');
    });
    tile(-8.8, -2.65, 4.5, 3.35, '#746d75');
    tile(-8.65, -2.5, 4.2, 3.05, '#8e8485');
    line([iso(-11.8, 5.5), iso(9.2, 5.5), iso(9.2, -6.4)], '#d0d2c1');
  }

  function drawWalls() {
    panel(-11.8, -6.4, 21, 0, 44, '#dddac6');
    panel(-11.8, -6.4, 11.9, 0, 44, '#b5c0b9', 'z');
    panel(-11.78, -6.36, 20.96, 0, 4, '#939d97');
    panel(-11.76, -6.36, 11.84, 0, 4, '#788b86', 'z');
    panel(-11.8, -6.4, 21, 43, 45, '#f5f0dc');
    panel(-11.8, -6.4, 11.9, 43, 45, '#d8dfcf', 'z');
    for (const x of [-9.8, -4.4, 1.0, 6.0]) {
      // Deep sills, blue glass and cream mullions read as indoor windows.
      panel(x, -6.35, 2.9, 14, 36, '#f5efd9');
      panel(x + 0.14, -6.33, 2.62, 16, 34, '#76a5b4');
      panel(x + 0.24, -6.31, 0.8, 17, 33, '#b5d3d4');
      panel(x + 1.4, -6.29, 0.11, 16, 34, '#f4efdb');
      panel(x + 0.14, -6.29, 2.62, 24, 25, '#e7e9d5');
      panel(x - 0.05, -6.27, 3, 36, 38, '#9aa99e');
      box(x + 1.45, -6.19, 3.04, 0.32, 14, '#e8e7d4', '#aeb8a8', '#8d9f97', 12);
    }
    panel(-11.74, -3.9, 2.8, 13, 33, '#766859', 'z');
    panel(-11.7, -3.75, 2.5, 15, 31, '#baa67a', 'z');
    for (const [z, low, fill] of [
      [-3.55, 22, '#fff4cf'],
      [-2.65, 23, '#b5ccd5'],
      [-3.2, 16, '#eac0a5'],
    ]) {
      panel(-11.66, z, 0.65, low, low + 6, fill, 'z');
    }
    const clock = iso(-5.7, -6.2, 36);
    rect(clock[0] - 5, clock[1] - 5, 11, 11, '#596c70');
    rect(clock[0] - 4, clock[1] - 4, 9, 9, '#f7f2dd');
    line(
      [
        [clock[0], clock[1] - 3],
        [clock[0], clock[1]],
      ],
      '#344c54',
    );
    line(
      [
        [clock[0], clock[1]],
        [clock[0] + 2, clock[1] + 1],
      ],
      '#344c54',
    );
  }

  function pottedPlant(x, z) {
    box(x, z, 0.56, 0.56, 5, '#b09276', '#9b745b', '#775b4d');
    const [px, py] = iso(x, z, 5);
    rect(px - 1, py - 12, 2, 13, '#416c54');
    polygon(
      [
        [px, py - 6],
        [px - 8, py - 11],
        [px - 7, py - 15],
        [px - 3, py - 13],
      ],
      '#527e58',
    );
    polygon(
      [
        [px, py - 9],
        [px + 4, py - 16],
        [px + 8, py - 14],
        [px + 5, py - 9],
      ],
      '#739666',
    );
    polygon(
      [
        [px, py - 4],
        [px + 7, py - 8],
        [px + 8, py - 4],
        [px + 3, py - 2],
      ],
      '#46754f',
    );
    polygon(
      [
        [px, py - 3],
        [px - 5, py - 8],
        [px - 8, py - 5],
        [px - 3, py - 1],
      ],
      '#86a56f',
    );
  }

  function chair(x, z, executive = false) {
    const [px, py] = iso(x, z);
    line(
      [
        [px - 7, py + 2],
        [px, py - 1],
        [px + 7, py + 2],
      ],
      '#3b515b',
      2,
    );
    line(
      [
        [px, py - 7],
        [px, py + 3],
      ],
      '#5a6b6d',
      2,
    );
    for (const dx of [-7, 0, 6]) rect(px + dx, py + 2, 3, 2, '#2d414c');
    rect(px - 7, py - 10, 15, 5, '#314952');
    rect(px - 6, py - 10, 13, 3, executive ? '#79636c' : '#688998');
    rect(px - 7, py - 22, 14, executive ? 13 : 10, '#344d57');
    rect(
      px - 6,
      py - 21,
      12,
      executive ? 10 : 7,
      executive ? '#8d747b' : '#7897a3',
    );
    rect(px - 8, py - 12, 2, 7, '#344d57');
    rect(px + 7, py - 12, 2, 7, '#344d57');
  }

  function drawCRT(x, z, status, label, manager = false) {
    const [px, py] = iso(x, z, 13);
    polygon(
      [
        [px + 8, py - 20],
        [px + 13, py - 23],
        [px + 13, py - 10],
        [px + 8, py - 6],
      ],
      '#9c9f8c',
    );
    polygon(
      [
        [px - 8, py - 20],
        [px - 3, py - 23],
        [px + 13, py - 23],
        [px + 8, py - 20],
      ],
      '#e3dfc6',
    );
    rect(px - 9, py - 21, 18, 16, '#5d695f');
    rect(px - 8, py - 20, 16, 14, '#d5d2b8');
    rect(px - 6, py - 18, 12, 8, '#203e4d');
    rect(px - 5, py - 17, 10, 1, manager ? '#96b7d0' : '#7aa7b2');
    if (status && status !== 'queued') {
      for (let row = 0; row < 2; row++)
        rect(px - 4, py - 14 + row * 2, 4 + row * 2, 1, '#a8dbbf');
      rect(px + 3, py - 12, 1, 1, color(status));
    } else rect(px - 3, py - 13, 6, 1, '#6e9da4');
    rect(px - 6, py - 8, 2, 1, status ? color(status) : '#6d8e7e');
    text(label, px + 3, py - 7, '#40565c', 5);
    rect(px - 2, py - 5, 4, 5, '#b6baa4');
    rect(px - 6, py, 12, 2, '#6e8078');
    polygon(
      [
        [px - 12, py + 3],
        [px, py + 6],
        [px + 7, py + 2],
        [px - 5, py - 1],
      ],
      '#e1dcc2',
    );
    for (let i = 0; i < 4; i++) rect(px - 8 + i * 3, py + 2, 2, 1, '#7e8d83');
    rect(px + 10, py + 4, 3, 2, '#e3ddc1');
  }

  function drawDesk(x, z, unit = null, manager = false, slot = 0) {
    const cx = x - 0.25,
      cz = z - 0.9;
    const w = manager ? 3.6 : 2.65,
      d = manager ? 1.65 : 1.35;
    box(
      cx - w / 2 + 0.4,
      cz,
      0.6,
      d - 0.2,
      10,
      '#a8ad9b',
      '#b7b8a0',
      '#8c9b8d',
    );
    for (const low of [3, 7]) {
      panel(
        cx - w / 2 + 0.12,
        cz + (d - 0.2) / 2 + 0.02,
        0.5,
        low,
        low + 2,
        '#9ca88f',
      );
      panel(
        cx - w / 2 + 0.24,
        cz + (d - 0.2) / 2 + 0.03,
        0.22,
        low + 1,
        low + 1.5,
        '#4d6265',
      );
    }
    box(
      cx + w / 2 - 0.12,
      cz + d / 2 - 0.15,
      0.16,
      0.2,
      10,
      '#647b79',
      '#536a6e',
      '#435a61',
    );
    box(cx, cz, w, d, 13, '#c7b58b', '#9c9275', '#899280', 10);
    line(
      [iso(cx - w / 2, cz + d / 2, 13), iso(cx + w / 2, cz + d / 2, 13)],
      '#e4d1a2',
    );
    drawCRT(
      x + (manager ? 0.5 : 0.45),
      z - 1.1,
      unit?.status,
      manager ? 'MAIN' : String(slot + 1).padStart(2, '0'),
      manager,
    );
    // Loose papers and a mug make the work surface recognisable at small sizes.
    tile(cx - w / 2 + 0.2, cz - 0.1, 0.55, 0.6, '#f5eed7', 14);
    tile(cx - w / 2 + 0.28, cz + 0.03, 0.4, 0.05, '#89978d', 14.5);
    const mug = iso(cx + w / 2 - 0.25, cz + 0.3, 14);
    rect(mug[0] - 2, mug[1] - 4, 4, 4, '#ede5c9');
    rect(mug[0] + 2, mug[1] - 3, 2, 2, '#c7c7b0');
    rect(mug[0] - 1, mug[1] - 4, 2, 1, '#7b6150');
    chair(x - 0.8, z + 0.55, manager);
    if (manager) {
      const plate = iso(cx + 1.25, cz + 0.7, 15);
      rect(plate[0] - 9, plate[1] - 3, 18, 6, '#485d63');
      text('LEAD', plate[0], plate[1], '#f3e8c4', 5);
      const phone = iso(cx - 1.2, cz - 0.4, 14);
      rect(phone[0] - 3, phone[1] - 3, 7, 5, '#42585b');
      rect(phone[0] - 4, phone[1] - 4, 9, 2, colors[identity.accentKey]);
    }
  }

  function drawQueue(x, z) {
    chair(x - 0.25, z - 0.55);
    chair(x + 0.7, z - 0.65);
    box(x - 1.1, z - 0.5, 0.75, 0.8, 10, '#bdaf8c', '#a1977d', '#859084');
    box(x - 1.1, z - 0.5, 0.65, 0.65, 13, '#465f66', '#7e9192', '#5c7279', 10);
    tile(x - 1.35, z - 0.72, 0.5, 0.5, '#f4edce', 14);
    const p = iso(x - 1.1, z - 0.5, 17);
    rect(p[0] - 5, p[1] - 3, 10, 6, '#38515e');
    text('IN', p[0], p[1], '#f5e5b9', 5);
  }

  function cabinet(x, z) {
    box(x, z, 1.2, 0.75, 28, '#d2d0ba', '#b9c1ad', '#8f9f95');
    for (let i = 0; i < 4; i++) {
      const low = 2 + i * 6;
      panel(x - 0.5, z + 0.39, 1, low, low + 5, '#a8b6a5');
      panel(x - 0.14, z + 0.4, 0.28, low + 3, low + 4, '#3f5a61');
      panel(x - 0.35, z + 0.4, 0.26, low + 1, low + 2, '#e7e8cd');
    }
  }

  function printer(x, z) {
    box(x, z, 1.6, 1.1, 10, '#b7bfae', '#99aa9d', '#7b948c');
    box(x, z, 1.4, 0.85, 20, '#dad8c2', '#b9c4b0', '#8fa49a', 10);
    panel(x - 0.5, z + 0.44, 1, 13, 16, '#3c565e');
    tile(x - 0.45, z + 0.2, 0.9, 0.7, '#bcc6b3', 13);
    tile(x - 0.34, z + 0.35, 0.68, 0.58, '#f9f1d7', 14);
    tile(x - 0.48, z - 0.28, 0.9, 0.42, '#657b7b', 21);
    tile(x - 0.3, z - 0.24, 0.6, 0.32, '#f5eed6', 22);
    const p = iso(x + 0.45, z, 21);
    rect(p[0], p[1], 2, 2, colors.running);
  }

  function serverRack(x, z) {
    box(x, z, 1, 0.8, 35, '#718585', '#314c58', '#273f4b');
    for (let i = 0; i < 5; i++) {
      panel(x - 0.4, z + 0.42, 0.8, 3 + i * 6, 7 + i * 6, '#58717a');
      panel(x - 0.3, z + 0.43, 0.45, 4 + i * 6, 5 + i * 6, '#243f4b');
      const led = iso(x + 0.28, z + 0.44, 5 + i * 6);
      rect(led[0], led[1], 2, 1, i % 2 ? colors.queued : colors.running);
    }
  }

  function waterCooler(x, z) {
    box(x, z, 0.8, 0.7, 18, '#e0dfc9', '#c2cbb6', '#95aaa0');
    const p = iso(x, z, 18);
    rect(p[0] - 4, p[1] - 12, 9, 10, '#497984');
    rect(p[0] - 3, p[1] - 13, 7, 10, '#92c5cd');
    rect(p[0] - 2, p[1] - 12, 3, 7, '#c5e1df');
    rect(p[0] - 2, p[1] - 2, 4, 3, '#a0b4aa');
    const tap = iso(x, z + 0.36, 12);
    rect(tap[0] - 3, tap[1], 2, 2, '#5374a4');
    rect(tap[0] + 2, tap[1] + 2, 2, 2, '#b96a63');
  }

  function drawStatus(x, y, status, size = 1) {
    ctx.save();
    ctx.translate(Math.round(x), Math.round(y));
    ctx.scale(size, size);
    rect(-5, -5, 11, 11, '#28444c');
    rect(-4, -4, 9, 9, color(status));
    const ink = '#173842';
    if (status === 'completed')
      line(
        [
          [-2, 0],
          [0, 2],
          [3, -2],
        ],
        ink,
        1.5,
      );
    else if (status === 'failed') {
      rect(0, -3, 1, 4, ink);
      rect(0, 2, 1, 1, ink);
    } else if (status === 'queued') {
      rect(-2, -2, 1, 5, ink);
      rect(1, -2, 1, 5, ink);
    } else if (status === 'cancelled')
      line(
        [
          [-2, 2],
          [2, -2],
        ],
        ink,
        1.5,
      );
    else if (status === 'cancelling') rect(-2, -2, 5, 5, ink);
    else if (status === 'compacting') {
      line(
        [
          [-3, -2],
          [0, 0],
          [-3, 2],
        ],
        ink,
      );
      line(
        [
          [3, -2],
          [0, 0],
          [3, 2],
        ],
        ink,
      );
    } else if (status === 'running') {
      const step = motion ? Math.floor(time * 4) % 3 : 1;
      for (let i = 0; i < 3; i++)
        rect(-2 + i * 2, 2 - ((i + step) % 3), 1, 2 + ((i + step) % 3), ink);
    } else {
      line(
        [
          [-2, 1],
          [0, -1],
          [2, 1],
        ],
        ink,
      );
    }
    ctx.restore();
  }
  function drawActivity(activity, phase) {
    const beat = Math.sin(phase * 5);
    const ink = '#25474a';
    switch (activity) {
      case 'coffee':
        rect(9, -13, 5, 5, '#fff0d0');
        rect(13, -12, 3, 3, '#fff0d0');
        rect(10, -14, 4, 1, '#846442');
        rect(10 + (Math.floor(phase * 2) % 2), -19, 1, 3, '#e6e8cf');
        break;
      case 'jump-rope':
        line(
          [
            [-10, -11],
            [-17, -5 + beat * 3],
            [-10, 3],
            [10, 3],
            [17, -5 - beat * 3],
            [10, -11],
          ],
          colors.rose,
        );
        break;
      case 'juggle':
        for (let i = 0; i < 3; i++) {
          const a = phase * 3 + (i * TAU) / 3;
          rect(
            Math.cos(a) * 12 - 1,
            -24 + Math.sin(a) * 7,
            3,
            3,
            [colors.amber, colors.rose, colors.cyan][i],
          );
        }
        break;
      case 'dance':
        text('♪', 16, -18 + beat * 2, colors.rose, 12);
        text('♫', -17, -25 - beat * 2, '#fff1b2', 10);
        break;
      case 'stretch':
        line(
          [
            [-10, -10],
            [-15, -19],
            [-7, -24],
          ],
          colors.shell,
          3,
        );
        line(
          [
            [10, -10],
            [15, -19],
            [7, -24],
          ],
          colors.shell,
          3,
        );
        break;
      case 'weights': {
        const y = -15 - beat * 3;
        rect(-15, y, 30, 2, ink);
        for (const x of [-16, 13]) {
          rect(x, y - 4, 4, 10, '#314e59');
          rect(x + 1, y - 3, 2, 8, '#91a9ac');
        }
        break;
      }
      case 'hula-hoop':
        line(
          [
            [-13, -8],
            [-7, -10 - beat],
            [8, -10 + beat],
            [14, -7],
            [8, -5 + beat],
            [-8, -5 - beat],
            [-13, -8],
          ],
          colors.rose,
          2,
        );
        break;
      case 'yo-yo': {
        const y = -10 + (beat + 1) * 6;
        line(
          [
            [10, -14],
            [15, y],
          ],
          ink,
        );
        rect(13, y, 5, 3, colors.amber);
        break;
      }
      case 'read':
        polygon(
          [
            [-9, -12],
            [0, -10],
            [9, -12],
            [9, -3],
            [0, -1],
            [-9, -3],
          ],
          '#8c5c51',
        );
        line(
          [
            [-7, -11],
            [0, -9],
            [7, -11],
          ],
          '#fff0c8',
          2,
        );
        line(
          [
            [0, -9],
            [0, -3],
          ],
          '#fff0c8',
        );
        break;
      case 'sweep':
        line(
          [
            [10, -17],
            [16 + beat * 3, 0],
          ],
          '#937447',
          2,
        );
        rect(12 + beat * 3, -1, 9, 4, '#e0bf72');
        rect(24 + beat * 3, 1, 2, 1, '#d4c5a1');
        break;
      case 'balance':
        rect(-12, 2, 24, 2, '#bca173');
        polygon(
          [
            [-3, 7],
            [0, 3],
            [3, 7],
          ],
          ink,
        );
        break;
      case 'paper-plane': {
        const t = (phase % 3) / 3;
        const x = 11 + t * 19,
          y = -15 - Math.sin(t * Math.PI) * 10;
        polygon(
          [
            [x - 5, y - 3],
            [x + 5, y],
            [x - 4, y + 3],
            [x - 1, y],
          ],
          '#fff4d3',
        );
        break;
      }
    }
  }

  function parentWork() {
    const status = snapshot?.session?.status;
    if (
      parent.pose().mode !== 'work' ||
      !['running', 'compacting'].includes(status) ||
      visitors.isAway(sessionId) ||
      reaction ||
      whip.pose() ||
      unsettled(damage.pose('parent'))
    )
      return '';
    if (status === 'compacting') return 'compacting';
    const activity = snapshot?.session?.activity || '';
    if (/using|tool|running (bash|read|write|edit|agent_)/i.test(activity))
      return 'tools';
    return /responding|writing/i.test(activity) ? 'writing' : 'thinking';
  }

  function drawWork(work) {
    const phase = motion
      ? Math.floor(time * (work === 'writing' ? 8 : 3)) % 3
      : 0;
    const ink = colors.screen;
    const signal = {
      thinking: colors.completed,
      writing: colors.running,
      tools: colors.queued,
      compacting: colors.compacting,
    }[work];
    if (work === 'thinking') {
      // A hand at the chin and a small thought bubble stay legible at rest.
      line(
        [
          [-10, -11],
          [-13, -15],
          [-8, -17],
        ],
        colors.outline,
        4,
      );
      line(
        [
          [-10, -12],
          [-12, -15],
          [-8, -17],
        ],
        colors.shell,
        2,
      );
      rect(-30, -36, 19, 11, colors.outline);
      rect(-31, -34, 21, 7, colors.outline);
      rect(-29, -35, 17, 9, ink);
      rect(-15, -25, 3, 3, colors.outline);
      rect(-12, -22, 2, 2, signal);
      for (let i = 0; i < 3; i++)
        rect(-26 + i * 5, -31 - (motion && phase === i ? 1 : 0), 3, 3, signal);
    } else if (work === 'writing') {
      rect(-25, -18, 14, 19, colors.outline);
      rect(-24, -17, 12, 17, colors.white);
      rect(-23, -16, 10, 2, signal);
      for (let i = 0; i < 4; i++)
        rect(-22, -11 + i * 3, 5 + ((i + phase) % 3), 1, ink);
      rect(-10, -6, 21, 6, colors.outline);
      rect(-9, -5, 19, 4, '#91a7a1');
      for (let i = 0; i < 6; i++) rect(-7 + i * 3, -4, 2, 1, ink);
      rect(-10, -9 + (phase % 2), 5, 3, colors.shell);
      rect(6, -8 - (phase % 2), 5, 3, colors.shell);
    } else if (work === 'tools') {
      rect(-29, -21, 18, 15, colors.outline);
      rect(-28, -20, 16, 13, signal);
      rect(-27, -19, 14, 11, ink);
      line(
        [
          [-25, -17],
          [-23, -15],
          [-25, -13],
        ],
        signal,
      );
      rect(-21, -12, 5, 1, colors.eyes);
      rect(-22, -6, 4, 3, colors.outline);
      rect(-26, -3, 12, 2, colors.outline);
      const lift = motion ? phase % 2 : 0;
      line(
        [
          [9, -8],
          [12, -17 - lift],
        ],
        colors.outline,
        3,
      );
      line(
        [
          [9, -8],
          [12, -17 - lift],
        ],
        signal,
      );
      rect(9, -20 - lift, 7, 3, signal);
      rect(9, -20 - lift, 2, 2, ink);
      rect(8, -10, 4, 3, colors.shell);
    } else if (work === 'compacting') {
      rect(-31, -24, 22, 4, colors.outline);
      rect(-30, -23, 20, 2, colors.compacting);
      rect(-31, -3, 22, 4, colors.outline);
      rect(-30, -2, 20, 2, colors.compacting);
      rect(-29, -20, 2, 17, colors.outline);
      rect(-13, -20, 2, 17, colors.outline);
      const squeeze = motion ? phase % 2 : 0;
      rect(-26, -17 + squeeze, 12, 11 - squeeze, colors.white);
      for (let i = 0; i < 3; i++)
        rect(-25, -15 + i * 3 + squeeze, 10, 1, colors.compacting);
      line(
        [
          [-35, -15],
          [-32, -12],
          [-35, -9],
        ],
        colors.compacting,
        2,
      );
      line(
        [
          [-6, -15],
          [-9, -12],
          [-6, -9],
        ],
        colors.compacting,
        2,
      );
      rect(-10, -12, 4, 3, colors.shell);
    }
  }

  function drawRobot(item) {
    const pose = damage.pose(item.id);
    const home = damageHomes.get(item.id);
    const frozen = home && unsettled(pose);
    const [wx, wz] = frozen ? home : item.world;
    const [px, py] = iso(wx + pose.corpseOffset[0], wz + pose.corpseOffset[2]);
    const parentSize = item.parent ? 1.24 : 1;
    const walking = item.stride && motion;
    const stride = walking ? Math.sin(item.stride) : 0;
    const working =
      item.status === 'running' ||
      item.status === 'compacting' ||
      item.status === 'cancelling';
    const activity =
      !unsettled(pose) && !reaction && !whip.pose() ? item.activity : null;
    const hop =
      activity === 'jump-rope'
        ? Math.max(0, Math.sin(item.elapsed * 6)) * 2
        : 0;
    const surprise = Math.max(
      pose.surprise,
      item.surprise || 0,
      item.id === 'parent' && reaction ? 1 : 0,
    );
    const stopHop =
      item.id === 'parent' && reaction?.animated
        ? Math.sin(clamp(reaction.age / 0.7) * Math.PI) * 2
        : 0;
    const jump = motion ? Math.min(4, (item.jump || 0) * 3) + hop + stopHop : 0;
    const bodyX = px + pose.offset[0] * 14;
    const bodyY = py - jump - pose.lift * 7;
    if (selected === item.id && item.selectable !== false) {
      diamond(
        px,
        py + 1,
        item.parent ? 20 : 16,
        item.parent ? 10 : 8,
        '#244c53',
      );
      line(
        [
          [px - 19, py],
          [px, py + 9],
          [px + 19, py],
          [px, py - 9],
          [px - 19, py],
        ],
        colors.selection,
      );
    } else
      diamond(
        px + 1,
        py + 1,
        item.parent ? 14 : 11,
        item.parent ? 6 : 5,
        '#5c6f77',
      );
    if (pose.phase === 'replacing') {
      diamond(px, py, 16 + pose.door * 5, 9, '#28474a');
      for (let i = -2; i <= 2; i++)
        rect(px + i * 5, py + (i % 2), 3, 2, colors.amber);
    }
    if (pose.blast) {
      for (let i = 0; i < 8; i++) {
        const a = (i * TAU) / 8,
          radius = (1 - pose.blast) * 15 + 6;
        rect(
          px + Math.cos(a) * radius,
          py - 12 + Math.sin(a) * radius * 0.7,
          3,
          2,
          i % 2 ? colors.amber : colors.white,
        );
      }
    }
    ctx.save();
    // Replacement robots rise through their small service hatch.
    if (pose.phase === 'replacing') {
      ctx.beginPath();
      ctx.rect(px - 28, py - 55, 56, 57);
      ctx.clip();
    }
    ctx.translate(Math.round(bodyX), Math.round(bodyY));
    ctx.scale(parentSize, parentSize);
    ctx.rotate((pose.collapse * Math.PI) / 2);
    if (pose.visible) {
      const dead = pose.phase !== 'alive' && pose.phase !== 'replacing';
      const shell = dead ? '#929e90' : colors.shell;
      const ink = colors.outline;
      const accent = item.accent || colors.cyan;
      const arm = motion && working ? Math.floor(time * 5) % 2 : 0;
      rect(-7, -4 + Math.max(0, stride), 5, 4, ink);
      rect(3, -4 + Math.max(0, -stride), 5, 4, ink);
      rect(-6, -4 + Math.max(0, stride), 3, 1, '#a4b5ac');
      rect(4, -4 + Math.max(0, -stride), 3, 1, '#a4b5ac');
      rect(-7, -13, 14, 10, ink);
      rect(-6, -13, 12, 8, shell);
      const workAccent = {
        thinking: colors.completed,
        writing: colors.running,
        tools: colors.queued,
        compacting: colors.compacting,
      }[item.work];
      rect(-4, -11, 8, 3, workAccent || accent);
      rect(-3, -7, 3, 1, '#436570');
      rect(3, -7, 2, 1, dead ? colors.dim : color(item.status));
      rect(-10, -13 + arm - stride, 3, 8, ink);
      rect(-9, -13 + arm - stride, 2, 5, shell);
      rect(8, -13 - arm + stride, 3, 8, ink);
      rect(8, -13 - arm + stride, 2, 5, shell);
      rect(-9, -24, 18, 12, ink);
      rect(-10, -22, 20, 7, ink);
      rect(-8, -24, 16, 10, shell);
      rect(-9, -21, 18, 5, shell);
      rect(-7, -22, 14, 7, colors.screen);
      rect(-6, -21, 12, 1, '#335665');
      rect(-1, -28, 2, 4, ink);
      rect(-2, -28, 4, 3, dead ? colors.failed : color(item.status));
      const eyes = dead ? '#516965' : colors.eyes;
      if (dead || item.status === 'failed') {
        for (const x of [-4, 3]) {
          rect(x, -20, 1, 1, eyes);
          rect(x + 1, -19, 1, 1, eyes);
          rect(x, -18, 1, 1, eyes);
        }
      } else if (surprise) {
        rect(-5, -21, 3, 5, eyes);
        rect(2, -21, 3, 5, eyes);
        rect(-4, -20, 1, 2, colors.screen);
        rect(3, -20, 1, 2, colors.screen);
      } else if (item.status === 'completed') {
        line(
          [
            [-5, -18],
            [-4, -20],
            [-2, -18],
          ],
          eyes,
        );
        line(
          [
            [2, -18],
            [3, -20],
            [5, -18],
          ],
          eyes,
        );
      } else if (item.status === 'cancelled') {
        rect(-5, -18, 4, 1, eyes);
        rect(2, -18, 4, 1, eyes);
      } else if (item.parent && item.mode === 'rest' && !working) {
        rect(-5, -20, 3, 2, eyes);
        rect(2, -20, 3, 2, eyes);
      } else {
        rect(-5, -20, 3, 3, eyes);
        rect(2, -20, 3, 3, eyes);
      }
      if (item.parent) {
        rect(-7, -27, 14, 2, ink);
        rect(-6, -28, 2, 3, accent);
        rect(-1, -30, 2, 5, accent);
        rect(4, -28, 2, 3, accent);
      }
      if (pose.damage > 0) {
        line(
          [
            [5, -24],
            [3, -22],
            [5, -20],
          ],
          '#5e5549',
        );
        if (pose.damage > 0.35)
          line(
            [
              [-5, -12],
              [-2, -10],
              [-4, -7],
              [0, -5],
            ],
            '#5e5549',
          );
        if (pose.damage > 0.65) rect(-7, -24, 4, 2, colors.amber);
      }
      if (item.work && !dead) drawWork(item.work);
      if (activity && motion) drawActivity(activity, item.elapsed || 0);
      if (surprise && !dead) {
        rect(13, -32, 5, 10, '#24414a');
        rect(15, -31, 1, 5, '#fff1bd');
        rect(15, -24, 1, 1, '#fff1bd');
      }
    }
    ctx.restore();
    if (!unsettled(pose) && !item.away)
      drawStatus(
        px + (item.parent ? 23 : 17),
        py - (item.parent ? 22 : 19),
        item.status,
      );
    if (item.visitorName) {
      const name =
        item.visitorName.length > 15
          ? `${item.visitorName.slice(0, 14)}…`
          : item.visitorName;
      const w = Math.min(96, name.length * 4.3 + 8);
      rect(px - w / 2, py - 48, w, 10, '#294b52');
      text(name, px, py - 43, '#fff3cf', 7);
      rect(px - w / 2, py - 48, 2, 10, item.accent);
    }
    const screen = toScreen([bodyX, bodyY - (item.parent ? 43 : 34)]);
    const center = toScreen([bodyX, bodyY - (item.parent ? 19 : 14)]);
    anchors.push({
      id: item.id,
      x: screen[0] / pixelWidth,
      y: screen[1] / pixelHeight,
      visible:
        screen[0] > 0 &&
        screen[0] < pixelWidth &&
        screen[1] > 0 &&
        screen[1] < pixelHeight,
      centerX: center[0] / pixelWidth,
      centerY: center[1] / pixelHeight,
      radius: (item.parent ? 18 : 14) * camera.zoom,
      selectable: item.selectable !== false,
      targetable: pose.phase === 'alive' && !item.away,
      world: [wx, wz],
    });
  }

  function drawCleaner(home, pose) {
    const cleanup = pose.cleanup;
    if (!cleanup) return;
    const [x, y] = iso(home[0] + cleanup.position[0], home[1]);
    diamond(x, y, 12, 5, '#596b73');
    rect(x - 12, y - 4, 24, 5, '#253f49');
    rect(x - 10, y - 9, 20, 7, '#d7b15e');
    rect(x - 8, y - 14, 11, 9, '#f1d181');
    rect(x - 6, y - 13, 7, 5, '#24515d');
    rect(x - 4, y - 12, 2, 2, colors.cyan);
    rect(x + 7, y - 7, 5, 4, '#ebdfac');
    rect(x - 5, y - 17, 3, 3, colors.amber);
    line(
      [
        [x - 10, y - 8],
        [x - 17, y - 9 + cleanup.grip * 5],
        [x - 20, y - 3],
      ],
      '#344b50',
      2,
    );
    for (let i = -1; i <= 1; i++) {
      rect(x + i * 7 - 2, y - 3, 5, 5, '#29454b');
      rect(x + i * 7, y - 2, 1, 2, '#99aba1');
    }
  }
  function drawEffects(items) {
    for (const effect of effects) {
      const item = items.find(item => item.id === effect.id);
      if (!item) continue;
      const [x, y] = iso(...item.world);
      const fade = clamp(1 - effect.age / 1.4);
      ctx.globalAlpha = fade;
      const tint = color(effect.status);
      const r = 9 + effect.age * 9;
      line(
        [
          [x - r, y],
          [x, y + r * 0.5],
          [x + r, y],
          [x, y - r * 0.5],
          [x - r, y],
        ],
        tint,
      );
      if (effect.status === 'running') {
        const origin = iso(-6.25, 0, 24),
          t = clamp(effect.age / 0.8);
        const px = origin[0] + (x - origin[0]) * t;
        const py =
          origin[1] + (y - 22 - origin[1]) * t - Math.sin(t * Math.PI) * 6;
        rect(px - 2, py - 1, 5, 3, colors.white);
        rect(px - 1, py - 1, 2, 2, tint);
      } else {
        for (let i = 0; i < 5; i++) {
          const a = (i * TAU) / 5;
          rect(
            x + Math.cos(a) * effect.age * 15,
            y -
              23 -
              Math.sin(effect.age * Math.PI) * 8 +
              Math.sin(a) * effect.age * 7,
            2,
            2,
            i % 2 ? tint : colors.white,
          );
        }
      }
      ctx.globalAlpha = 1;
    }
    const lash = whip.pose();
    if (lash) {
      const source = items.find(item => item.id === 'parent');
      const target = items.find(item => item.id === lash.target);
      if (source && target) {
        const pose = whipPose(lash.age);
        const start = iso(...source.world, 17),
          end = iso(...target.world, 18);
        const points = [start];
        for (let i = 1; i <= 12; i++) {
          const t = i / 12;
          points.push([
            start[0] + (end[0] - start[0]) * pose.reach * t,
            start[1] +
              (end[1] - start[1]) * pose.reach * t -
              Math.sin(t * Math.PI) * (6 + (1 - pose.reach) * 10),
          ]);
        }
        line(points, '#31464a', 2);
        line(points, colors.amber);
        if (pose.crack) {
          for (let i = 0; i < 6; i++) {
            const a = (i * TAU) / 6;
            line(
              [
                end,
                [
                  end[0] + Math.cos(a) * 9 * pose.crack,
                  end[1] + Math.sin(a) * 9 * pose.crack,
                ],
              ],
              colors.white,
            );
          }
        }
      }
    }
    for (const piece of damage.effects()) {
      const item = items.find(item => item.id === piece.owner);
      const home = damageHomes.get(piece.owner) || item?.world;
      if (!home) continue;
      const [x, y] = iso(
        home[0] + piece.position[0],
        home[1] + piece.position[2],
        piece.position[1] * 7,
      );
      const spark = piece.kind === 'spark';
      rect(
        x,
        y,
        spark ? 2 : 3,
        spark ? 1 : 2,
        spark ? colors.amber : '#9cb1ad',
      );
    }
  }

  function toScreen([x, y]) {
    return [
      (x - camera.x) * camera.zoom + pixelWidth / 2,
      (y - camera.y) * camera.zoom + pixelHeight / 2,
    ];
  }
  function fitCamera() {
    const points = [iso(-6.75, -1.5)];
    for (const unit of units) points.push(iso(...positionFor(unit)));
    const pose = parent.pose();
    if (!visitors.isAway(sessionId)) points.push(iso(pose.x, pose.z));
    for (const visitor of visitors.visitorsAt(sessionId))
      points.push(iso(visitor.x, visitor.z));
    // Leave space around the main desk and its open office aisle.
    if (!units.length) points.push(iso(-3.7, 1.8));
    const left = Math.min(...points.map(p => p[0])) - 34;
    const right = Math.max(...points.map(p => p[0])) + 36;
    const top = Math.min(
      Math.min(...points.map(p => p[1])) - 56,
      iso(-6.75, -6.4, 40)[1],
    );
    const bottom = Math.max(...points.map(p => p[1])) + 24;
    camera = {
      x: (left + right) / 2,
      y: (top + bottom) / 2,
      zoom: Math.min(
        units.length ? 1.4 : 1.6,
        (pixelWidth - 24) / (right - left),
        (pixelHeight - 22) / (bottom - top),
      ),
    };
  }
  function render() {
    if (!visible()) return;
    fitCamera();
    const visiting = visitors.visitorsAt(sessionId);
    const away = visitors.isAway(sessionId);
    const ownTravel = visiting.find(visitor => visitor.id === sessionId);
    const pose = parent.pose();
    const shown = new Set([
      'parent',
      ...units.map(unit => unit.id),
      ...visiting.filter(v => v !== ownTravel).map(v => visitorCaneId(v.id)),
    ]);
    damage.retain(shown);
    for (const id of damageHomes.keys())
      if (!shown.has(id)) damageHomes.delete(id);
    const items = units.map(unit => ({
      id: unit.id,
      status: unit.status,
      world: positionFor(unit),
      accent: colors.cyan,
    }));
    if (
      !away ||
      ownTravel ||
      (damageHomes.has('parent') && unsettled(damage.pose('parent')))
    ) {
      const local = ownTravel || pose;
      items.push({
        id: 'parent',
        parent: true,
        status: snapshot?.session?.status || 'idle',
        world: [local.x, local.z],
        mode: local.mode || local.phase,
        activity: ownTravel ? null : pose.activity,
        work: parentWork(),
        elapsed: pose.elapsed,
        stride: local.stride,
        jump: local.jump,
        surprise: local.surprise,
        accent: colors[identity.accentKey],
      });
    }
    for (const visitor of visiting) {
      if (visitor === ownTravel) continue;
      const source = factoryIdentity(visitor.id);
      items.push({
        id: visitorCaneId(visitor.id),
        parent: true,
        selectable: false,
        status: visitor.status,
        world: [visitor.x, visitor.z],
        stride: visitor.stride,
        surprise: visitor.surprise,
        jump: visitor.jump,
        accent: colors[source.accentKey],
        visitorName: visitor.name || visitor.id,
      });
    }
    anchors = [];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#495961';
    ctx.fillRect(0, 0, pixelWidth, pixelHeight);
    ctx.save();
    ctx.translate(pixelWidth / 2, pixelHeight / 2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);
    drawGround();
    drawWalls();
    const occupants = new Map(units.map(unit => [slots.get(unit.id), unit]));
    const scenery = [
      {depth: -7.4, draw: () => drawDesk(-6.25, 0, snapshot?.session, true)},
      ...BAYS.map(([x, z], slot) => {
        const unit = occupants.get(slot);
        return {
          depth: x + z - 1.1,
          draw: () =>
            unit?.status === 'queued' || (!unit && slot >= 6)
              ? drawQueue(x, z)
              : drawDesk(x, z, unit, false, slot),
        };
      }),
      {depth: -14, draw: () => cabinet(-9.2, -4.8)},
      {depth: -7.7, draw: () => printer(-2.5, -5.2)},
      {depth: 3.4, draw: () => serverRack(8.1, -4.7)},
      {depth: -12.7, draw: () => waterCooler(-10.2, -2.5)},
      ...[
        [-11, 1.8],
        [-8.7, -5.6],
        [8.3, 4.65],
        [-10.8, 4.6],
      ].map(([x, z]) => ({depth: x + z, draw: () => pottedPlant(x, z)})),
    ];
    scenery.sort((a, b) => a.depth - b.depth).forEach(item => item.draw());
    if (away && !items.some(item => item.id === 'parent')) {
      const [x, y] = iso(-6.25, 0);
      diamond(x, y, 19, 9, '#365f5c');
      line(
        [
          [x - 15, y],
          [x, y + 7],
          [x + 15, y],
          [x, y - 7],
          [x - 15, y],
        ],
        colors.amber,
      );
      rect(x - 7, y - 24, 15, 12, '#294851');
      text('→', x, y - 18, colors.amber, 12);
      const p = toScreen([x, y - 43]);
      anchors.push({
        id: 'parent',
        x: p[0] / pixelWidth,
        y: p[1] / pixelHeight,
        centerX: p[0] / pixelWidth,
        centerY: (p[1] + 20 * camera.zoom) / pixelHeight,
        radius: 18 * camera.zoom,
        visible: true,
        selectable: true,
        targetable: false,
      });
    }
    items.sort((a, b) => a.world[0] + a.world[1] - (b.world[0] + b.world[1]));
    items.forEach(drawRobot);
    for (const item of items)
      drawCleaner(damageHomes.get(item.id) || item.world, damage.pose(item.id));
    drawEffects(items);
    ctx.restore();
    output.setTransform(1, 0, 0, 1, 0, 0);
    output.imageSmoothingEnabled = false;
    output.drawImage(pixels, 0, 0, canvas.width, canvas.height);
    publishLayout(away, visiting, pose, ownTravel, shown);
  }

  function publishLayout(away, visiting, pose, ownTravel, shown) {
    const detail = visitors.awayMessage(sessionId);
    const parentDamage = damage.pose('parent');
    data('renderer', 'year1998');
    data('factoryIdentity', identity.token);
    data('factoryVisitors', visiting.map(visitor => visitor.id).join(','));
    data('parentAway', away);
    data('parentAwayLabel', detail);
    data('parentStatus', snapshot?.session?.status || 'idle');
    data('parentWork', parentWork());
    data(
      'parentMode',
      unsettled(parentDamage)
        ? parentDamage.phase === 'alive'
          ? 'startled'
          : parentDamage.phase
        : reaction
          ? 'startled'
          : ownTravel?.phase || (away ? 'away' : pose.mode),
    );
    data('parentActivity', away && !ownTravel ? detail : pose.activity || '');
    data(
      'parentEyes',
      ['alive', 'replacing'].includes(parentDamage.phase)
        ? AWAKE_EYE_HEIGHT +
            Math.max(reaction ? 1 : 0, pose.surprise, parentDamage.surprise) *
              0.2
        : 0,
    );
    data('robotWhip', whip.pose()?.target || '');
    data(
      'robotDamage',
      JSON.stringify(
        Object.fromEntries([...shown].map(id => [id, damage.pose(id)])),
      ),
    );
    data('robotDebris', damage.effects().length);
    data(
      'robotCleanup',
      JSON.stringify(
        [...shown]
          .filter(id => damage.pose(id).cleanup)
          .map(id => ({id, ...damage.pose(id).cleanup})),
      ),
    );
    data(
      'agentStatuses',
      JSON.stringify(
        units.map(unit => ({
          id: unit.id,
          status: unit.status,
          slot: slots.get(unit.id),
        })),
      ),
    );
    data(
      'sceneEvents',
      effects.map(effect => `${effect.id}:${effect.event}`).join(','),
    );
    const foreign = visiting
      .filter(visitor => visitor.id !== sessionId)
      .map(visitor => visitor.name || visitor.id);
    const label = [
      'Isometric office with a main agent and agent workstations',
      detail ? `Main agent: ${detail}` : '',
      foreign.length ? `Visiting main agents: ${foreign.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('. ');
    if (canvas.getAttribute('aria-label') !== label)
      canvas.setAttribute('aria-label', label);
    const layout = anchors
      .filter(anchor => anchor.selectable)
      .map(({id, x, y, visible: isVisible}) => ({
        id,
        x,
        y,
        visible: isVisible,
        away: id === 'parent' && away,
        detail: id === 'parent' ? detail : '',
      }));
    const key = layout
      .map(
        a =>
          `${a.id}:${Math.round(a.x * width)}:${Math.round(a.y * height)}:${a.visible}:${a.detail}`,
      )
      .join('|');
    if (key !== lastLayout) {
      lastLayout = key;
      onLayout(layout);
    }
  }

  function syncWhip() {
    whip.update(
      sessionId,
      units
        .filter(
          unit => unit.status === 'running' && !unsettled(damage.pose(unit.id)),
        )
        .map(unit => unit.id),
      Boolean(reaction) ||
        unsettled(damage.pose('parent')) ||
        visitors.isAway(sessionId) ||
        !['rest', 'work'].includes(parent.pose().mode) ||
        snapshot?.session?.status === 'closed',
    );
  }
  function tick(now) {
    frame = 0;
    if (!canAnimate()) {
      lastFrame = 0;
      return;
    }
    const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 0.05) : 0;
    lastFrame = now;
    time += dt;
    damage.tick(dt);
    syncWhip();
    if (!whip.pose() && !unsettled(damage.pose('parent'))) parent.tick(dt);
    visitors.observeLocalPose(sessionId, parent.pose());
    const paused = visitors
      .visitorsAt(sessionId)
      .filter(visitor =>
        unsettled(
          damage.pose(
            visitor.id === sessionId ? 'parent' : visitorCaneId(visitor.id),
          ),
        ),
      )
      .map(visitor => visitor.id);
    if (unsettled(damage.pose('parent'))) paused.push(sessionId);
    visitors.tick(dt, paused);
    parent.setAway(visitors.isAway(sessionId));
    syncWhip();
    whip.tick(dt);
    effects.forEach(effect => {
      effect.age += dt;
    });
    effects = effects.filter(effect => effect.age < 1.4);
    if (reaction?.animated) {
      reaction.age += dt;
      if (reaction.age >= 1.1) reaction = null;
    }
    if (!lastPaint || now - lastPaint >= 32) {
      render();
      lastPaint = now;
    }
    schedule();
  }
  function schedule() {
    if (canAnimate() && !frame) frame = requestAnimationFrame(tick);
  }
  function stop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    lastFrame = 0;
    lastPaint = 0;
  }
  function refresh() {
    if (disposed) return;
    render();
    schedule();
  }
  function onVisibility() {
    if (!canAnimate()) stop();
    if (visible()) refresh();
  }
  function resize() {
    if (disposed) return;
    const bounds = canvas.getBoundingClientRect();
    width = Math.max(1, bounds.width);
    height = Math.max(1, bounds.height);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const scale = Math.max(0.6, Math.min(width / 420, height / 265));
    pixelWidth = Math.max(1, Math.round(width / scale));
    pixelHeight = Math.max(1, Math.round(height / scale));
    if (pixels.width !== pixelWidth) pixels.width = pixelWidth;
    if (pixels.height !== pixelHeight) pixels.height = pixelHeight;
    const w = Math.round(width * dpr),
      h = Math.round(height * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    refresh();
  }
  function findHit(event) {
    const bounds = canvas.getBoundingClientRect();
    let hit = null,
      distance = Infinity;
    for (const anchor of anchors) {
      if (!anchor.selectable || !anchor.visible) continue;
      const x = event.clientX - bounds.left,
        y = event.clientY - bounds.top;
      const d = Math.min(
        Math.hypot(
          x - anchor.centerX * bounds.width,
          y - anchor.centerY * bounds.height,
        ),
        Math.hypot(x - anchor.x * bounds.width, y - anchor.y * bounds.height),
      );
      const radius = Math.max(16, (anchor.radius * bounds.width) / pixelWidth);
      if (d < radius * 1.5 && d < distance) {
        hit = anchor.id;
        distance = d;
      }
    }
    return hit;
  }
  function onClick(event) {
    const hit = findHit(event);
    if (hit !== null) onSelect(hit);
  }
  function onPointerMove(event) {
    canvas.style.cursor = findHit(event) === null ? '' : 'pointer';
  }
  function onPointerLeave() {
    canvas.style.cursor = '';
  }
  function caneTargets() {
    if (!visible()) return [];
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return [];
    return anchors
      .filter(anchor => anchor.targetable)
      .map(anchor => ({
        id: anchor.id,
        x: bounds.left + anchor.centerX * bounds.width,
        y: bounds.top + anchor.centerY * bounds.height,
        radius: Math.max(12, (anchor.radius * bounds.width) / pixelWidth),
      }))
      .filter(
        target =>
          target.x + target.radius > Math.max(0, bounds.left) &&
          target.x - target.radius <
            Math.min(window.innerWidth, bounds.right) &&
          target.y + target.radius > Math.max(0, bounds.top) &&
          target.y - target.radius <
            Math.min(window.innerHeight, bounds.bottom),
      );
  }

  canvas.addEventListener('click', onClick);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('resize', resize);
  const resizeObserver =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
  resizeObserver?.observe(canvas);
  const intersectionObserver =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(entries => {
          inView = entries[0]?.isIntersecting ?? true;
          onVisibility();
        });
  intersectionObserver?.observe(canvas);
  resize();

  return {
    updateHub(hub) {
      if (disposed) return;
      visitors.update(hub);
      parent.setAway(visitors.isAway(sessionId));
      refresh();
    },
    update(value, selectedId = 'parent') {
      if (disposed) return;
      const id = value?.session?.id;
      if (id !== sessionId) {
        stop();
        sessionId = id;
        identity = factoryIdentity(id);
        initialized = false;
        previous = new Map();
        slots = new Map();
        effects = [];
        time = 0;
        reaction = null;
        whip.cancel();
        damage.reset();
        damageHomes.clear();
      }
      snapshot = value;
      selected = selectedId;
      visitors.update(value?.sessions ? value : value?.hub || value);
      parent.update(value?.session);
      visitors.observeLocalPose(id, parent.pose());
      parent.setAway(visitors.isAway(id));
      reconcile(value);
      syncWhip();
      refresh();
    },
    setPalette(palette) {
      if (disposed) return;
      colors = Object.fromEntries(
        Object.entries(DEFAULTS).map(([key, fallback]) => {
          const value = palette?.[key];
          const valid =
            Array.isArray(value) &&
            value.length === 3 &&
            value.every(n => Number.isFinite(n) && n >= 0 && n <= 1);
          return [key, valid ? rgb(value) : fallback];
        }),
      );
      refresh();
    },
    setMotion(enabled) {
      if (disposed) return;
      motion = Boolean(enabled);
      parent.setMotion(motion);
      visitors.setMotion(motion);
      whip.setMotion(motion);
      damage.setMotion(motion);
      parent.setAway(visitors.isAway(sessionId));
      if (!motion) {
        effects = [];
        stop();
      }
      if (motion) reaction = null;
      refresh();
    },
    prompt(id) {
      if (disposed || id !== sessionId) return;
      whip.cancel();
      if (!visitors.prompt(id)) parent.prompt();
      parent.setAway(visitors.isAway(id));
      refresh();
    },
    cancelPrompt(id) {
      if (disposed || id !== sessionId) return;
      parent.cancelPrompt();
      refresh();
    },
    startle(animate = true) {
      if (disposed) return;
      whip.cancel();
      parent.stop();
      reaction = {age: 0, animated: motion && Boolean(animate)};
      refresh();
    },
    clearStartle() {
      if (disposed) return;
      reaction = null;
      refresh();
    },
    caneTargets,
    hitWithCane(id, direction = 1, strength = 1) {
      if (disposed || !caneTargets().some(target => target.id === id))
        return false;
      const anchor = anchors.find(anchor => anchor.id === id);
      if (!unsettled(damage.pose(id))) damageHomes.set(id, [...anchor.world]);
      if (!damage.hit(id, direction, strength)) return false;
      reaction = null;
      whip.cancel();
      refresh();
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      parent.dispose();
      visitors.dispose();
      whip.dispose();
      damage.dispose();
      damageHomes.clear();
      effects = [];
      anchors = [];
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', resize);
      canvas.style.cursor = '';
      if (originalLabel === null) canvas.removeAttribute('aria-label');
      else canvas.setAttribute('aria-label', originalLabel);
      for (const key of DATA_KEYS) delete canvas.dataset[key];
      pixels.width = 1;
      pixels.height = 1;
    },
  };
}
