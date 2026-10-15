/* global window, document, requestAnimationFrame, cancelAnimationFrame, ResizeObserver, IntersectionObserver */
/* A small, dependency-free WebGL scene. Coordinates and lighting are real 3D;
 * the dashboard owns the accessible labels, session data and motion preference. */
import {createParentMotion} from './parent-motion.js';
import {
  AWAKE_EYE_HEIGHT,
  relaxedIdlePose,
  idleActivityPose,
  drawIdleActivity,
} from './parent-activities.js';
import {createRobotWhip, whipPose, drawRobotWhip} from './robot-whip.js';
import {factoryIdentity, factoryIdentityPalette} from './factory-identity.js';
import {createFactoryVisitors} from './factory-visitors.js';

const TAU = Math.PI * 2;
const STARTLE_DURATION = 1.1;
const COLORS = {
  floor: [0.095, 0.14, 0.16],
  edge: [0.14, 0.21, 0.23],
  dark: [0.065, 0.095, 0.115],
  metal: [0.29, 0.37, 0.39],
  shell: [0.66, 0.75, 0.73],
  white: [0.83, 0.91, 0.86],
  mint: [0.33, 1, 0.77],
  cyan: [0.15, 0.77, 1],
  amber: [1, 0.63, 0.22],
  red: [1, 0.22, 0.2],
  dim: [0.19, 0.34, 0.35],
  screen: [0.027, 0.13, 0.15],
  selection: [0.725, 0.91, 1],
  running: [0.47, 0.902, 0.631],
  queued: [0.961, 0.843, 0.431],
  completed: [0.569, 0.729, 1],
};
const BAYS = [
  [-1.5, -3.1],
  [2.6, -3.1],
  [6.7, -3.1],
  [-1.5, 3.1],
  [2.6, 3.1],
  [6.7, 3.1],
  [-7.4, 3.65],
  [-7.4, -3.65],
];
const QUEUE_SLOTS = [6, 7, 3, 4, 5, 0, 1, 2];
const WORKING = new Set(['running', 'cancelling']);

function normalize(v) {
  const l = Math.hypot(...v) || 1;
  return v.map(n => n / l);
}
function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function multiply(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  return o;
}
function cameraMatrix(eye, target, aspect) {
  const z = normalize(eye.map((v, i) => v - target[i]));
  const x = normalize(cross([0, 1, 0], z));
  const y = cross(z, x);
  const view = new Float32Array([
    x[0],
    y[0],
    z[0],
    0,
    x[1],
    y[1],
    z[1],
    0,
    x[2],
    y[2],
    z[2],
    0,
    -dot(x, eye),
    -dot(y, eye),
    -dot(z, eye),
    1,
  ]);
  const f = 1 / Math.tan((34 * Math.PI) / 360),
    near = 0.1,
    far = 110;
  const projection = new Float32Array([
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (far + near) / (near - far),
    -1,
    0,
    0,
    (2 * far * near) / (near - far),
    0,
  ]);
  return multiply(projection, view);
}

// Primitive meshes have position and normal pairs. Flat cylinder sides retain
// the clean facets of miniature machined parts.
function cubeMesh() {
  const result = [];
  const faces = [
    [
      [1, 0, 0],
      [
        [1, -1, -1],
        [1, 1, -1],
        [1, 1, 1],
        [1, -1, 1],
      ],
    ],
    [
      [-1, 0, 0],
      [
        [-1, -1, 1],
        [-1, 1, 1],
        [-1, 1, -1],
        [-1, -1, -1],
      ],
    ],
    [
      [0, 1, 0],
      [
        [-1, 1, -1],
        [-1, 1, 1],
        [1, 1, 1],
        [1, 1, -1],
      ],
    ],
    [
      [0, -1, 0],
      [
        [-1, -1, 1],
        [-1, -1, -1],
        [1, -1, -1],
        [1, -1, 1],
      ],
    ],
    [
      [0, 0, 1],
      [
        [1, -1, 1],
        [1, 1, 1],
        [-1, 1, 1],
        [-1, -1, 1],
      ],
    ],
    [
      [0, 0, -1],
      [
        [-1, -1, -1],
        [-1, 1, -1],
        [1, 1, -1],
        [1, -1, -1],
      ],
    ],
  ];
  for (const [n, p] of faces)
    for (const i of [0, 1, 2, 0, 2, 3])
      result.push(...p[i].map(v => v / 2), ...n);
  return result;
}
function cylinderMesh(segments = 12) {
  const result = [];
  const v = (p, n) => result.push(...p, ...n);
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * TAU,
      b = ((i + 1) / segments) * TAU;
    const p = [Math.cos(a) * 0.5, Math.sin(a) * 0.5];
    const q = [Math.cos(b) * 0.5, Math.sin(b) * 0.5];
    const n = [Math.cos((a + b) / 2), 0, Math.sin((a + b) / 2)];
    const side = [
      [p[0], -0.5, p[1]],
      [p[0], 0.5, p[1]],
      [q[0], 0.5, q[1]],
      [q[0], -0.5, q[1]],
    ];
    for (const j of [0, 1, 2, 0, 2, 3]) v(side[j], n);
    for (const sign of [-1, 1]) {
      v([0, sign * 0.5, 0], [0, sign, 0]);
      v([p[0], sign * 0.5, p[1]], [0, sign, 0]);
      v([q[0], sign * 0.5, q[1]], [0, sign, 0]);
    }
  }
  return result;
}
const CUBE = cubeMesh();
const CYLINDER = cylinderMesh();
const OCTAGON = cylinderMesh(8);

class Geometry {
  constructor() {
    this.data = [];
  }
  append(geometry, position, yaw = 0, originX = 0) {
    const c = Math.cos(yaw),
      s = Math.sin(yaw);
    for (let i = 0; i < geometry.data.length; i += 10) {
      const d = geometry.data,
        x = d[i] - originX,
        z = d[i + 2];
      this.data.push(
        position[0] + x * c + z * s,
        position[1] + d[i + 1],
        position[2] + z * c - x * s,
        d[i + 3] * c + d[i + 5] * s,
        d[i + 4],
        d[i + 5] * c - d[i + 3] * s,
        d[i + 6],
        d[i + 7],
        d[i + 8],
        d[i + 9],
      );
    }
  }
  shape(mesh, p, s, color, emission = 0, yaw = 0, basis = null) {
    const c = Math.cos(yaw),
      q = Math.sin(yaw);
    for (let i = 0; i < mesh.length; i += 6) {
      const x = mesh[i] * s[0],
        y = mesh[i + 1] * s[1],
        z = mesh[i + 2] * s[2];
      const nx = mesh[i + 3],
        ny = mesh[i + 4],
        nz = mesh[i + 5];
      if (basis) {
        const [u, v, w] = basis;
        this.data.push(
          p[0] + x * u[0] + y * v[0] + z * w[0],
          p[1] + x * u[1] + y * v[1] + z * w[1],
          p[2] + x * u[2] + y * v[2] + z * w[2],
          nx * u[0] + ny * v[0] + nz * w[0],
          nx * u[1] + ny * v[1] + nz * w[1],
          nx * u[2] + ny * v[2] + nz * w[2],
          ...color,
          emission,
        );
      } else {
        this.data.push(
          p[0] + x * c + z * q,
          p[1] + y,
          p[2] + z * c - x * q,
          nx * c + nz * q,
          ny,
          nz * c - nx * q,
          ...color,
          emission,
        );
      }
    }
  }
  box(p, s, color, emission = 0, yaw = 0) {
    this.shape(CUBE, p, s, color, emission, yaw);
  }
  cylinder(p, s, color, emission = 0) {
    this.shape(CYLINDER, p, s, color, emission);
  }
  octagon(p, s, color, emission = 0) {
    this.shape(OCTAGON, p, s, color, emission);
  }
  rod(a, b, radius, color, emission = 0) {
    const d = b.map((n, i) => n - a[i]);
    const length = Math.hypot(...d);
    if (length < 0.0001) return;
    const v = d.map(n => n / length);
    const u = normalize(
      cross(Math.abs(v[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0], v),
    );
    const w = cross(u, v);
    this.shape(
      OCTAGON,
      a.map((n, i) => (n + b[i]) / 2),
      [radius * 2, length, radius * 2],
      color,
      emission,
      0,
      [u, v, w],
    );
  }
  ring(
    p,
    radius,
    width,
    color,
    emission = 0,
    segments = 40,
    fraction = 1,
    phase = 0,
  ) {
    // Flat annular ribbons take six vertices per segment, keeping the live
    // selection and holographic rings inexpensive on integrated GPUs.
    for (let i = 0; i < segments * fraction; i++) {
      const a = phase + (i / segments) * TAU,
        b = phase + ((i + 0.82) / segments) * TAU;
      const points = [
        [a, radius - width],
        [a, radius + width],
        [b, radius + width],
        [b, radius - width],
      ];
      for (const j of [0, 1, 2, 0, 2, 3]) {
        const [angle, r] = points[j];
        this.data.push(
          p[0] + Math.cos(angle) * r,
          p[1],
          p[2] + Math.sin(angle) * r,
          0,
          1,
          0,
          ...color,
          emission,
        );
      }
    }
  }
}

function buildFactory(C, identity = factoryIdentity('')) {
  const g = new Geometry();
  const F = factoryIdentityPalette(C, identity);
  // Floating cutaway foundation and the visible service plinth underneath.
  g.box([0, -0.66, 0], [21.5, 0.45, 12.1], C.dark);
  g.box([0, -0.31, 0], [21.1, 0.28, 11.7], F.factoryEdge);
  g.box([0, -0.13, 0], [20.7, 0.12, 11.3], F.factoryFloor);
  for (let x = -10; x <= 10; x += 1)
    g.box([x, -0.058, 0], [0.018, 0.014, 11], C.edge);
  for (let z = -5; z <= 5; z += 1)
    g.box([0, -0.056, z], [20, 0.014, 0.018], C.edge);
  for (const z of [-5.68, 5.68]) {
    g.box([0, -0.25, z], [20.5, 0.1, 0.055], C.mint, 0.65);
    g.box([0, 0.08, z], [21, 0.18, 0.12], C.metal);
    for (let x = -9.6; x <= 10; x += 1.1)
      g.box([x, 0.18, z], [0.46, 0.025, 0.14], C.amber, 0.2, -0.35);
  }
  // The center aisle is a data spine, connecting the command station to bays.
  for (const z of [-1.25, 1.25]) {
    g.box([1.8, 0.015, z], [15.5, 0.025, 0.075], C.mint, 0.45);
    for (let x = -4.7; x < 9; x += 1.3)
      g.box([x, 0.025, z * 0.74], [0.22, 0.025, 0.07], C.metal);
  }
  for (let x = -2; x < 9; x += 2) {
    g.box([x, 0.023, -0.16], [0.32, 0.025, 0.075], C.dim, 0, -0.65);
    g.box([x, 0.023, 0.16], [0.32, 0.025, 0.075], C.dim, 0, 0.65);
  }
  // Rear service wall: low enough to read the cutaway, with a tall gantry.
  g.box([0, 0.75, -5.48], [20.8, 1.5, 0.32], C.dark);
  for (let x = -9.8; x < 10; x += 2) {
    g.box([x, 0.8, -5.25], [1.8, 1.18, 0.15], C.edge);
    g.box([x, 1.42, -5.12], [1.3, 0.06, 0.055], C.cyan, 0.65);
    for (let i = 0; i < 4; i++)
      g.box([x - 0.5 + i * 0.32, 0.75, -5.15], [0.1, 0.58, 0.04], C.dark);
  }
  for (const x of [-10, -3.8, 9.9]) {
    g.box([x, 2.5, -5.3], [0.28, 5, 0.38], C.metal);
    g.box([x, 0.3, -5.25], [0.62, 0.6, 0.65], C.edge);
    g.box([x + 0.17, 2.8, -5.05], [0.035, 1.1, 0.05], C.amber, 0.7);
  }
  g.box([0, 4.9, -5.3], [20.7, 0.3, 0.4], C.metal);
  g.box([0, 4.67, -5.08], [20, 0.06, 0.08], C.cyan, 0.85);
  for (let x = -9; x <= 9; x += 3) {
    const lean = identity.gantry === 0 ? -0.9 : identity.gantry === 1 ? 0 : 0.9;
    g.rod([x, 4.7, -5.3], [x + lean, 3.8, -5.3], 0.08, F.factoryEdge);
    g.box([x, 4.5, -4.8], [0.85, 0.12, 0.6], C.dark);
    g.box([x, 4.42, -4.76], [0.68, 0.035, 0.42], F.factoryAccent, 0.95);
  }
  // Session identity changes only overhead/rear service architecture, leaving
  // every workstation and collision route in the same functional position.
  for (let i = 0; i < identity.roof + 1; i++) {
    const x = -1.8 + i * 3.6;
    g.rod([x - 1.25, 4.58, -4.95], [x, 5.22, -4.95], 0.065, F.factoryMetal);
    g.rod([x, 5.22, -4.95], [x + 1.25, 4.58, -4.95], 0.065, F.factoryMetal);
    g.box([x, 5.25, -4.95], [1.7, 0.08, 0.18], F.factoryAccent, 0.45);
  }
  for (let i = 0; i < 4; i++) {
    const x = -1.5 + i * 2.1;
    const lit = (i + identity.stripePhase) % 4 === 0;
    g.box(
      [x, 1.05, -5.03],
      [0.7, 0.055, 0.045],
      lit ? F.factoryAccent : F.factoryEdge,
      lit ? 0.75 : 0.1,
    );
  }
  // Exposed plumbing and utility tanks on the command side.
  for (const y of [1.75, 2.16]) {
    g.rod([-10.2, y, -4.8], [-4.3, y, -4.8], 0.1, C.metal);
    g.rod([-10.2, 0.2, -4.8], [-10.2, y, -4.8], 0.1, C.metal);
    for (const x of [-9, -7, -5]) g.box([x, y, -4.8], [0.09, 0.3, 0.3], C.dark);
  }
  for (const x of Array.from(
    {length: identity.utilities},
    (_, i) => -9.55 + i * 0.95,
  )) {
    g.cylinder([x, 1, -3.7], [0.83, 1.85, 0.83], C.metal);
    g.cylinder([x, 1.73, -3.7], [0.9, 0.11, 0.9], C.dark);
    g.cylinder([x, 0.35, -3.7], [0.9, 0.13, 0.9], C.dark);
    g.box([x, 1.06, -3.24], [0.12, 0.65, 0.05], C.mint, 0.8);
  }
  // Parent session dais, radial tracks and two physical control consoles.
  g.octagon([-6.25, 0.12, 0], [5.5, 0.28, 5.5], C.edge);
  g.octagon([-6.25, 0.28, 0], [4.85, 0.12, 4.85], C.dark);
  g.ring([-6.25, 0.36, 0], 2.2, 0.032, C.mint, 0.6);
  for (const z of [-1.65, 1.65]) {
    g.box([-4.85, 0.73, z], [0.65, 0.8, 0.95], C.edge);
    g.box([-4.85, 1.18, z], [0.94, 0.12, 1.24], C.metal);
    g.box([-4.85, 1.25, z], [0.72, 0.035, 0.8], C.screen);
    for (let i = 0; i < 4; i++)
      g.box(
        [-5.1 + i * 0.16, 1.276, z],
        [0.035, 0.012, 0.52 - i * 0.09],
        C.mint,
        0.8,
      );
    g.box([-4.5, 1.29, z + 0.38], [0.085, 0.04, 0.085], C.amber, 0.8);
  }
  BAYS.forEach(([x, z], i) => {
    if (i >= 6) {
      g.octagon([x, 0.06, z], [1.8, 0.11, 1.8], C.edge);
      g.ring([x, 0.13, z], 0.8, 0.025, C.amber, 0.4, 24);
      return;
    }
    const back = z < 0 ? -1 : 1;
    g.box([x, 0.04, z], [3.55, 0.12, 3.0], C.dark);
    for (const side of [-1, 1])
      g.box([x + side * 1.67, 0.12, z], [0.05, 0.045, 2.8], C.dim, 0.35);
    g.octagon([x - 0.35, 0.13, z], [1.75, 0.12, 1.75], C.edge);
    g.ring([x - 0.35, 0.22, z], 0.74, 0.018, C.dim, 0.4, 24);
    // Bench, belt rollers and a distinct processing block.
    g.box([x + 1.0, 0.43, z], [1.05, 0.72, 1.96], C.edge);
    g.box([x + 1.0, 0.85, z], [1.12, 0.12, 2.12], C.metal);
    g.box([x + 1.0, 0.93, z], [0.82, 0.065, 1.95], C.dark);
    for (let j = -4; j <= 4; j++)
      g.rod(
        [x + 0.64, 0.98, z + j * 0.2],
        [x + 1.36, 0.98, z + j * 0.2],
        0.045,
        C.metal,
      );
    for (const side of [-1, 1])
      g.box([x + 1 + side * 0.53, 1.02, z], [0.065, 0.14, 2.12], C.edge);
    g.box([x + 1, 1.08, z], [0.43, 0.23, 0.5], C.shell);
    g.box([x + 1, 1.21, z], [0.28, 0.025, 0.25], C.amber, 0.15);
    // Raised screen faces inward; horizontal diagnostic lights are real mesh.
    g.box([x - 0.37, 0.78, z + back * 1.05], [0.15, 1.35, 0.15], C.metal);
    g.box([x - 0.37, 1.66, z + back * 1.05], [1.3, 0.86, 0.15], C.edge);
    g.box([x - 0.37, 1.68, z + back * 0.957], [1.12, 0.64, 0.035], C.screen);
    for (let row = 0; row < 4; row++) {
      g.box(
        [x - 0.74, 1.88 - row * 0.13, z + back * 0.932],
        [0.06, 0.035, 0.02],
        C.mint,
        0.55,
      );
      g.box(
        [x - 0.28, 1.88 - row * 0.13, z + back * 0.932],
        [0.62 - row * 0.1, 0.025, 0.02],
        C.dim,
        0.45,
      );
    }
    g.box([x + 1.5, 0.6, z + back * 1.12], [0.22, 1.12, 0.24], C.metal);
    g.box([x + 1.5, 1.28, z + back * 1.12], [0.19, 0.2, 0.2], C.amber, 0.35);
  });
  // Dock ramp and cargo give the entrance a visible purpose.
  g.box([-10.35, -0.05, 2.7], [1.8, 0.14, 2], C.metal);
  for (let x = -10.9; x < -9.5; x += 0.25)
    g.box([x, 0.03, 2.7], [0.08, 0.025, 1.85], C.dark);
  for (const [x, z] of [
    [9.4, 4.8],
    [8.45, 4.9],
    [9.4, 3.9],
  ]) {
    g.box([x, 0.34, z], [0.7, 0.65, 0.68], C.edge);
    g.box([x, 0.68, z], [0.73, 0.07, 0.71], C.metal);
    g.box([x, 0.36, z + 0.35], [0.38, 0.09, 0.02], C.amber, 0.25);
  }
  return g;
}

const VERTEX_SHADER = `
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec3 aColor;
attribute float aEmission;
uniform mat4 uMatrix;
varying vec3 vPosition;
varying vec3 vNormal;
varying vec3 vColor;
varying float vEmission;
void main() {
  vPosition = aPosition; vNormal = aNormal; vColor = aColor; vEmission = aEmission;
  gl_Position = uMatrix * vec4(aPosition, 1.0);
}`;
const FRAGMENT_SHADER = `
precision mediump float;
varying vec3 vPosition;
varying vec3 vNormal;
varying vec3 vColor;
varying float vEmission;
uniform vec3 uEye;
uniform float uGlow;
void main() {
  vec3 n = normalize(vNormal);
  vec3 viewDirection = normalize(uEye - vPosition);
  vec3 key = normalize(vec3(-0.45, 0.9, 0.55));
  float diffuse = max(dot(n, key), 0.0);
  float rim = pow(1.0 - max(dot(n, viewDirection), 0.0), 3.0);
  float spec = pow(max(dot(n, normalize(key + viewDirection)), 0.0), 36.0);
  float bounce = max(dot(n, normalize(vec3(0.3, 0.2, -1.0))), 0.0);
  vec3 lit = vColor * (vec3(0.23, 0.3, 0.34) + diffuse * vec3(0.84, 0.87, 0.77) + bounce * vec3(0.04, 0.18, 0.2));
  lit += vec3(0.18, 0.33, 0.32) * rim * 0.35 + vec3(0.3) * spec;
  lit = mix(lit, vColor * 1.25, clamp(vEmission, 0.0, 1.0));
  lit = pow(max(lit, vec3(0.0)), vec3(0.88));
  gl_FragColor = uGlow > 0.5 ? vec4(vColor * vEmission, 1.0) : vec4(lit, 1.0);
}`;

/** Create a live scene, or return null so the caller can retain its fallback. */
export function createFactoryScene(
  canvas,
  {onSelect = () => {}, onLayout = () => {}} = {},
) {
  let gl;
  try {
    gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
      powerPreference: 'low-power',
    });
  } catch {
    return null;
  }
  if (!gl) return null;
  const defaultCanvasLabel =
    canvas.getAttribute('aria-label') ||
    'Factory view with a parent session and agents';
  const resources = {shaders: [], buffers: []};
  let program, attributes, uniforms;
  function releaseResources() {
    for (const buffer of resources.buffers) gl.deleteBuffer(buffer);
    for (const shader of resources.shaders) gl.deleteShader(shader);
    if (program) gl.deleteProgram(program);
  }
  function initializeProgram() {
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('WebGL shader allocation failed');
      resources.shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program));
    attributes = ['aPosition', 'aNormal', 'aColor', 'aEmission'].map(n =>
      gl.getAttribLocation(program, n),
    );
    uniforms = Object.fromEntries(
      ['uMatrix', 'uEye', 'uGlow'].map(n => [
        n,
        gl.getUniformLocation(program, n),
      ]),
    );
  }
  try {
    initializeProgram();
  } catch {
    releaseResources();
    return null;
  }
  function makeBuffer(geometry, usage) {
    const buffer = gl.createBuffer();
    resources.buffers.push(buffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(geometry.data), usage);
    return {buffer, count: geometry.data.length / 10};
  }
  let C = Object.fromEntries(
    Object.entries(COLORS).map(([key, color]) => [key, [...color]]),
  );
  let identity = factoryIdentity('');
  let factory = makeBuffer(buildFactory(C, identity), gl.STATIC_DRAW);
  let dynamic = makeBuffer(new Geometry(), gl.DYNAMIC_DRAW);
  let glow = makeBuffer(new Geometry(), gl.DYNAMIC_DRAW);
  let disposed = false,
    contextLost = false,
    motion = true,
    inView = true,
    frame = 0;
  let snapshot = null,
    selected = 'parent',
    firstSnapshot = true,
    sessionId;
  let previous = new Map(),
    units = [],
    slots = new Map(),
    particles = [],
    dispatches = [],
    flashes = [];
  let reaction = null;
  const parentMotion = createParentMotion();
  const whip = createRobotWhip();
  const visitors = createFactoryVisitors();

  function syncWhip() {
    const mode = parentMotion.pose().mode;
    whip.update(
      sessionId,
      units
        .filter(
          unit =>
            unit.status === 'running' &&
            anchors.some(a => a.id === unit.id && a.visible),
        )
        .map(unit => unit.id),
      Boolean(reaction) ||
        visitors.isAway(sessionId) ||
        !['rest', 'work'].includes(mode) ||
        snapshot?.session?.status === 'closed',
    );
  }
  let cameraTarget = [-5.6, 1.6, 0];
  let lastFrame = 0,
    time = 0,
    width = 1,
    height = 1,
    anchors = [];
  let pointer = [0, 0],
    cameraOffset = [0, 0],
    lastLayout = '';

  function statusColor(status) {
    if (status === 'failed') return C.red;
    if (
      status === 'queued' ||
      status === 'cancelling' ||
      status === 'cancelled' ||
      status === 'compacting'
    )
      return C.queued;
    if (status === 'running') return C.running;
    if (status === 'completed') return C.completed;
    return C.dim;
  }
  function positionFor(unit) {
    const [x, z] = BAYS[slots.get(unit.id) ?? 0];
    return [x + ((slots.get(unit.id) ?? 0) < 6 ? -0.35 : 0), 1.63, z];
  }
  function burst(position, color, count = 40) {
    flashes.push({p: [...position], color, age: 0, life: 1.15});
    if (flashes.length > 16) flashes.shift();
    // Randomness affects only the trajectory of a real state-change effect.
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * TAU,
        speed = 1.1 + Math.random() * 3;
      particles.push({
        p: [...position],
        v: [
          Math.cos(angle) * speed,
          1 + Math.random() * 4,
          Math.sin(angle) * speed,
        ],
        color,
        age: 0,
        life: 0.65 + Math.random() * 0.9,
        size: 0.025 + Math.random() * 0.035,
      });
    }
    if (particles.length > 400) particles.splice(0, particles.length - 400);
  }
  function reconcile(data) {
    const agents = data?.agents || [];
    const live = agents.filter(a => WORKING.has(a.status));
    const queue = agents.filter(a => a.status === 'queued');
    const history = agents
      .filter(a => !WORKING.has(a.status) && a.status !== 'queued')
      .sort((a, b) =>
        String(b.finishedAt || b.createdAt || '').localeCompare(
          String(a.finishedAt || a.createdAt || ''),
        ),
      );
    const chosenHistory = history.find(a => a.id === selected);
    units = [
      ...live,
      ...queue,
      ...(chosenHistory ? [chosenHistory] : []),
      ...history.filter(a => a !== chosenHistory),
    ].slice(0, 8);
    const nextSlots = new Map(),
      taken = new Set();
    // Working agents claim work bays before queued/history units, even when
    // a selected historical unit previously occupied a station.
    for (const unit of units) {
      const prefs =
        unit.status === 'queued' ? QUEUE_SLOTS : [0, 1, 2, 3, 4, 5, 6, 7];
      const old = slots.get(unit.id);
      const preferredOld =
        old !== undefined &&
        !taken.has(old) &&
        (unit.status !== 'queued' || old >= 6) &&
        (!WORKING.has(unit.status) || old < 6);
      const slot = preferredOld ? old : prefs.find(s => !taken.has(s));
      nextSlots.set(unit.id, slot);
      taken.add(slot);
    }
    slots = nextSlots;
    for (const agent of agents) {
      const old = previous.get(agent.id);
      if (!firstSnapshot && motion) {
        const shown = units.find(u => u.id === agent.id);
        if (
          shown &&
          agent.status === 'running' &&
          (old === 'queued' || old === undefined)
        ) {
          const p = positionFor(agent);
          dispatches.push({from: [-5.7, 2.95, 0], to: p, age: 0, life: 1.5});
          burst(p, C.running, 42);
        } else if (
          shown &&
          old &&
          old !== agent.status &&
          agent.status === 'completed'
        )
          burst(positionFor(agent), C.completed, 62);
        else if (shown && old !== agent.status && agent.status === 'failed')
          burst(positionFor(agent), C.red, 48);
      }
    }
    previous = new Map(agents.map(a => [a.id, a.status]));
    firstSnapshot = false;
  }

  function startlePose() {
    if (!reaction) return {surprise: 0, jump: 0, squash: 0, wobble: 0};
    if (!reaction.animated) return {surprise: 1, jump: 0, squash: 0, wobble: 0};
    const p = reaction.age / STARTLE_DURATION;
    const surprise = Math.min(1, p / 0.1) * Math.min(1, (1 - p) / 0.42);
    const flight = Math.max(0, Math.min(1, (p - 0.06) / 0.58));
    const jump = Math.sin(flight * Math.PI) * 1.65;
    const squash =
      p >= 0.64 && p < 0.8
        ? -Math.sin(((p - 0.64) / 0.16) * Math.PI) * 0.25
        : p >= 0.8
          ? Math.sin(((p - 0.8) / 0.2) * Math.PI) * 0.1
          : -Math.sin(Math.min(1, p / 0.06) * Math.PI) * 0.12;
    return {surprise, jump, squash, wobble: Math.sin(p * TAU * 4) * surprise};
  }

  function drawParentSession(sceneGeometry, sceneEffects, visitor = null) {
    const pose = visitor
      ? {
          mode:
            visitor.phase === 'startled'
              ? 'startled'
              : visitor.phase === 'visit'
                ? 'rest'
                : ['depart', 'homecoming'].includes(visitor.phase)
                  ? 'return'
                  : 'walk',
          activity: null,
          elapsed: 0,
          duration: 0,
          x: visitor.x,
          z: visitor.z,
          yaw: visitor.yaw,
          ground: 0,
          stride: visitor.stride,
          jump: visitor.jump,
          surprise: visitor.surprise,
        }
      : parentMotion.pose();
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
    const g = new Geometry(),
      fx = new Geometry();
    const state = visitor?.status || snapshot?.session?.status || 'idle';
    const active =
      !visitor &&
      pose.mode === 'work' &&
      (state === 'running' || state === 'compacting');
    const moving = pose.mode === 'walk' || pose.mode === 'return';
    const running = pose.mode === 'return';
    const activity = visitor ? '' : snapshot?.session?.activity || '';
    const tools =
      active &&
      /using|tool|running (bash|read|write|edit|agent_)/i.test(activity);
    const writing = active && !tools && /responding|writing/i.test(activity);
    const thinking = active && !tools && !writing;
    const color = tools ? C.amber : thinking ? C.cyan : statusColor(state);
    const t = active ? time : 0;
    const x = -6.25,
      bob = active
        ? Math.sin(t * (writing ? 5 : 2.5)) * 0.09
        : moving
          ? Math.abs(Math.sin(pose.stride)) * (running ? 0.13 : 0.06)
          : 0;
    const lash = visitor ? null : whip.pose();
    const lashPose = lash ? whipPose(lash.age) : null;
    let whipHand;
    const reactionPose = visitor
      ? {surprise: 0, jump: 0, squash: 0, wobble: 0}
      : startlePose();
    const surprise = Math.max(reactionPose.surprise, pose.surprise);
    const jump = reactionPose.jump + pose.jump;
    const {squash, wobble} = reactionPose;
    const lift =
      bob + jump + squash + (idle?.lift || 0) * blend + (relaxed?.lift || 0);
    const y = 0.4 + lift;
    g.cylinder(
      [x, 0.38, 0],
      [2.25 - jump * 0.35, 0.045, 1.5 - jump * 0.2],
      [0.026, 0.055, 0.06],
    );
    // The feet leave the dais, kick outward, then plant for the landing squash.
    for (const side of [-1, 1]) {
      const z = side * 0.54;
      const step = Math.sin(pose.stride + (side === 1 ? Math.PI : 0));
      const foot = idle?.feet[side === -1 ? 0 : 1];
      const footZ = z + side * jump * 0.17 + (foot?.z || 0) * blend;
      const footX =
        x +
        jump * 0.18 +
        (moving ? step * (running ? 0.7 : 0.42) : 0) +
        (foot?.x || 0) * blend;
      const footY =
        jump * 1.12 +
        (moving ? Math.max(0, step) * (running ? 0.34 : 0.2) : 0) +
        (foot?.y || 0) * blend;
      g.box([footX + 0.12, 0.59 + footY, footZ], [1.08, 0.35, 0.66], C.metal);
      g.box([footX + 0.5, 0.65 + footY, footZ], [0.12, 0.15, 0.55], C.shell);
      g.rod(
        [footX - 0.15, 0.7 + footY, footZ],
        [x - 0.25, 1.15 + lift, z],
        0.2,
        C.dark,
      );
      g.octagon([x - 0.23, 1.03 + lift, z], [0.52, 0.25, 0.52], C.metal);
      g.box([x - 0.1, 1.2 + lift, z], [0.52, 0.45, 0.44], C.shell);
    }
    g.octagon([x, y + 1, 0], [1.2, 0.3, 1.24], C.dark);
    g.box([x, y + 1.55, 0], [1.45, 1.12, 1.52], C.shell);
    g.box([x + 0.74, y + 1.54, 0], [0.09, 0.84, 1.15], C.edge);
    g.box([x + 0.8, y + 1.62, 0], [0.035, 0.27, 0.68], C.dark);
    g.box([x + 0.825, y + 1.62, 0], [0.025, 0.11, 0.46], color, 0.85);
    for (const z of [-0.44, 0.44])
      g.box([x + 0.79, y + 1.3, z], [0.03, 0.08, 0.15], C.amber, 0.5);
    g.cylinder([x, y + 2.22, 0], [0.56, 0.34, 0.56], C.dark);
    // Wide helmet, dark wraparound visor, two independently glowing eyes.
    g.box([x + 0.05, y + 2.62, 0], [1.54, 0.88, 1.66], C.shell);
    g.box([x + 0.12, y + 3.09, 0], [1.35, 0.11, 1.5], C.white);
    g.box([x + 0.84, y + 2.61, 0], [0.095, 0.47, 1.45], C.dark);
    g.box([x + 0.9, y + 2.58, 0], [0.035, 0.05, 1.23], color, 0.7);
    const eyeHeight = relaxed?.eyeHeight || AWAKE_EYE_HEIGHT;
    for (const z of [-0.4, 0.4]) {
      g.box(
        [x + 0.91, y + 2.67, z],
        [0.04, eyeHeight + surprise * 0.15, 0.3 + surprise * 0.08],
        surprise ? C.white : color,
        1,
      );
      if (surprise > 0)
        g.box(
          [x + 0.935, y + 2.69, z],
          [0.015, surprise * 0.14, surprise * 0.12],
          C.dark,
        );
      g.box([x - 0.08, y + 2.64, z * 2.23], [0.56, 0.5, 0.14], C.metal);
      g.box([x + 0.01, y + 2.66, z * 2.43], [0.21, 0.22, 0.03], color, 0.8);
    }
    if (surprise > 0)
      g.box(
        [x + 0.92, y + 2.43, 0],
        [0.04, surprise * 0.15, surprise * 0.19],
        C.white,
        0.85,
      );
    const antenna = [x - 0.53 + wobble * 0.4, y + 3.68, -0.48 + wobble * 0.18];
    g.rod([x - 0.43, y + 3.05, -0.48], antenna, 0.037, C.metal);
    g.octagon(
      [antenna[0], antenna[1] + 0.04, antenna[2]],
      [0.19, 0.16, 0.19],
      color,
      0.95,
    );
    for (const side of [-1, 1]) {
      const shoulder = [x, y + 1.94, side * 0.96];
      const stroke = Math.sin(
        t * (writing ? 11 : tools ? 5 : 2.4) + side * 1.8,
      );
      const relaxedArm = relaxed?.arms[side === -1 ? 0 : 1];
      const elbow = relaxedArm
        ? [
            x + relaxedArm.elbow[0],
            y + relaxedArm.elbow[1],
            relaxedArm.elbow[2],
          ]
        : thinking && side === 1
          ? [x + 0.5, y + 1.85, 1.18]
          : [x + 0.55 + (active ? stroke * 0.22 : 0), y + 1.2, side * 1.25];
      const hand = relaxedArm
        ? [x + relaxedArm.hand[0], y + relaxedArm.hand[1], relaxedArm.hand[2]]
        : thinking && side === 1
          ? [x + 0.95, y + 2.37 + stroke * 0.1, 0.52]
          : [
              x + 1.3 + (tools ? stroke * 0.45 : 0),
              y +
                0.98 +
                (writing
                  ? stroke * 0.3
                  : tools
                    ? Math.abs(stroke) * 0.45
                    : active
                      ? stroke * 0.12
                      : 0),
              side * (thinking ? 1.18 : 1.52),
            ];
      const idleArm = idle?.arms[side === -1 ? 0 : 1];
      if (idleArm) {
        for (let axis = 0; axis < 3; axis++) {
          const origin = axis === 0 ? x : axis === 1 ? y : 0;
          elbow[axis] += (origin + idleArm.elbow[axis] - elbow[axis]) * blend;
          hand[axis] += (origin + idleArm.hand[axis] - hand[axis]) * blend;
        }
      } else if (moving) {
        const swing = Math.sin(pose.stride + (side === 1 ? Math.PI : 0));
        elbow[0] = x - swing * (running ? 0.65 : 0.4);
        elbow[1] = y + 1.25;
        hand[0] = x - swing * (running ? 0.85 : 0.55) + (running ? 0.65 : 0.1);
        hand[1] = y + (running ? 1.7 : 0.75);
        hand[2] = side * 1.1;
      }
      if (lashPose && side === 1) {
        for (let axis = 0; axis < 3; axis++) {
          const origin = axis === 0 ? x : axis === 1 ? y : 0;
          elbow[axis] +=
            (origin + lashPose.elbow[axis] - elbow[axis]) * lashPose.blend;
          hand[axis] +=
            (origin + lashPose.hand[axis] - hand[axis]) * lashPose.blend;
        }
        whipHand = [...hand];
      }
      // Blend from the frozen work pose into a broad, overhead flail.
      const raisedElbow = [x - 0.15, y + 2.6, side * 1.65];
      const raisedHand = [x + 0.25 + wobble * 0.12, y + 3.55, side * 1.95];
      for (let axis = 0; axis < 3; axis++) {
        elbow[axis] += (raisedElbow[axis] - elbow[axis]) * surprise;
        hand[axis] += (raisedHand[axis] - hand[axis]) * surprise;
      }
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
    if (active)
      g.ring([x, 0.4, 0], 2.08, 0.024, color, 0.9, 48, 0.72, t * 0.28);
    if (!visitor && selected === 'parent')
      g.ring([x, 0.41, 0], 2.38, 0.075, C.selection, 1, 48);
    if (active) {
      fx.ring([x, 0.44, 0], 2.12, 0.085, color, 0.08, 40);
      // Distinct poses and signals follow the actual model/tool activity.
      if (thinking) {
        for (let i = 0; i < 3; i++) {
          const angle = t * 1.8 + (i * TAU) / 3;
          const pulse = 0.14 + (1 + Math.sin(t * 4 - i)) * 0.045;
          g.octagon(
            [
              x + Math.cos(angle) * 1.05,
              0.4 + bob + 3.55 + Math.sin(angle) * 0.16,
              Math.sin(angle) * 1.05,
            ],
            [pulse, pulse, pulse],
            C.cyan,
            1,
          );
        }
        g.ring([x, 3.9 + bob, 0], 1.08, 0.025, C.cyan, 0.7, 32, 0.72, t * 1.8);
      } else if (writing) {
        for (let row = 0; row < 5; row++) {
          const length = 0.3 + ((t * 0.8 + row * 0.19) % 1) * 0.7;
          g.box(
            [x + 1.65, 1.75 + row * 0.14, 0],
            [0.04, 0.035, length],
            C.mint,
            0.95,
          );
        }
      } else if (tools) {
        const strike = (t * 1.5) % 1;
        for (let i = 0; i < 5; i++) {
          const angle = (i * TAU) / 5;
          const origin = [x + 1.4, 1.3, 1.5];
          const tip = [
            origin[0] + Math.cos(angle) * strike * 0.65,
            origin[1] + Math.sin(angle) * strike * 0.5,
            origin[2] + strike * 0.2,
          ];
          fx.rod(origin, tip, 0.028, C.amber, (1 - strike) * 0.8);
        }
      }
      // The command hologram is only live while the parent works.
      for (let i = 0; i < 3; i++)
        g.ring(
          [x + 1.65, 1.55 + i * 0.26, 0],
          0.48 - i * 0.1,
          0.018,
          color,
          0.8,
          24,
          0.7,
          t * (0.6 + i * 0.2),
        );
      g.rod([x + 1.65, 1.3, 0], [x + 1.65, 2.27, 0], 0.016, color, 0.75);
    }
    if (idle && blend > 0.5) {
      const props = new Geometry(),
        propEffects = new Geometry();
      drawIdleActivity(
        props,
        propEffects,
        C,
        pose.activity,
        pose.elapsed,
        idle,
      );
      g.append(props, [x, 0, 0]);
      fx.append(propEffects, [x, 0, 0]);
    }
    const position = [pose.x, pose.ground, pose.z];
    const targetUnit = lash && units.find(unit => unit.id === lash.target);
    const targetPosition = targetUnit ? positionFor(targetUnit) : null;
    const turn = targetPosition
      ? Math.sign(-targetPosition[2]) * lashPose.turn
      : 0;
    const yaw = pose.yaw + (idle?.yaw || 0) * blend + turn;
    let whipStart = null;
    if (whipHand) {
      const dx = whipHand[0] - x,
        dz = whipHand[2];
      whipStart = [
        pose.x + dx * Math.cos(yaw) + dz * Math.sin(yaw),
        pose.ground + whipHand[1],
        pose.z + dz * Math.cos(yaw) - dx * Math.sin(yaw),
      ];
    }
    sceneGeometry.append(g, position, yaw, x);
    sceneEffects.append(fx, position, yaw, x);
    if (!visitor) {
      canvas.dataset.robotWhip = lash?.target || '';
      canvas.dataset.parentMode = pose.mode;
      canvas.dataset.parentActivity = pose.activity || '';
      canvas.dataset.parentEyes = String(eyeHeight);
    }
    return {
      p: [pose.x, pose.ground + y + 4.0, pose.z],
      body: [pose.x, pose.ground + y + 1.6, pose.z],
      whipStart,
    };
  }

  function drawAgent(unit, g, fx, index) {
    const slot = slots.get(unit.id),
      [baseX, baseY, z] = positionFor(unit);
    const active = unit.status === 'running',
      failed = unit.status === 'failed';
    const t = active ? time + index * 1.7 : 0;
    const lash = whip.pose();
    const recoil = lash?.target === unit.id ? whipPose(lash.age).recoil : 0;
    const y = baseY + (active ? Math.sin(t * 3.4) * 0.24 : 0) + recoil * 0.68;
    const x = baseX + (active ? Math.sin(t * 1.7) * 0.1 : 0) + recoil * 0.28;
    if (active) {
      const pulse = 0.75 + Math.sin(t * 4) * 0.2;
      g.ring([baseX, 0.26, z], 0.94, 0.065, C.running, 1, 36);
      fx.ring([baseX, 0.28, z], 1.02, 0.12, C.running, pulse * 0.28, 36);
      g.ring([baseX, 0.3, z], 1.09, 0.04, C.running, 1, 32, 0.28, t * 1.8);
    }
    const color = statusColor(unit.status);
    g.cylinder([x, 0.225, z], [1.22, 0.018, 0.86], [0.025, 0.055, 0.06]);
    // A compact flying machine: four nacelles, fins, armored central hull.
    g.octagon([x, y, z], [1.12, 0.49, 1.12], C.shell);
    g.box([x + 0.08, y + 0.28, z], [0.7, 0.14, 0.74], C.white);
    g.box([x + 0.55, y + 0.01, z], [0.07, 0.3, 0.7], C.dark);
    for (const zz of [-0.2, 0.2])
      g.box([x + 0.6, y + 0.04, z + zz], [0.025, 0.09, 0.16], color, 1);
    g.box([x, y + 0.36, z], [0.34, 0.035, 0.12], color, 0.9);
    for (const side of [-1, 1]) {
      g.rod([x - 0.15, y, z], [x - 0.17, y, z + side * 0.78], 0.08, C.dark);
      g.box([x - 0.2, y + 0.04, z + side * 0.71], [0.48, 0.25, 0.36], C.metal);
      g.cylinder(
        [x - 0.2, y - 0.14, z + side * 0.71],
        [0.25, 0.16, 0.25],
        C.dark,
      );
      g.cylinder(
        [x - 0.2, y - 0.24, z + side * 0.71],
        [0.18, 0.05, 0.18],
        color,
        active ? 1 : 0.2,
      );
      g.box([x - 0.48, y + 0.18, z + side * 0.71], [0.1, 0.3, 0.36], C.shell);
      if (active) {
        const flame = 0.3 + (1 + Math.sin(t * 12 + side)) * 0.07;
        fx.octagon(
          [x - 0.2, y - 0.25 - flame / 2, z + side * 0.71],
          [0.12, flame, 0.12],
          color,
          0.5,
        );
        fx.octagon(
          [x - 0.2, y - 0.3 - flame / 2, z + side * 0.71],
          [0.22, flame * 1.25, 0.22],
          color,
          0.09,
        );
      }
    }
    g.rod(
      [x - 0.32, y + 0.32, z - 0.28],
      [x - 0.38, y + 0.64, z - 0.28],
      0.024,
      C.metal,
    );
    g.octagon([x - 0.38, y + 0.68, z - 0.28], [0.1, 0.09, 0.1], color, 0.85);
    const elbow = [x + 0.47, y - 0.38, z + 0.29];
    const hand = [
      x + 0.83,
      y - 0.32 + (active ? Math.sin(t * 4) * 0.3 : 0),
      z + 0.12,
    ];
    g.rod([x + 0.1, y - 0.2, z + 0.27], elbow, 0.066, C.dark);
    g.octagon(elbow, [0.2, 0.18, 0.2], C.amber);
    g.rod(elbow, hand, 0.055, C.metal);
    g.box(hand, [0.18, 0.16, 0.16], C.dark);
    if (slot < 6 && active) {
      const bx = BAYS[slot][0],
        target = [bx + 1, 1.25, z + Math.sin(t * 2.5) * 0.32];
      const welding = unit.status === 'running';
      if (welding) {
        const beltPosition = ((t * 0.35) % 1) * 1.4 - 0.7;
        g.box([bx + 1, 1.08, z + beltPosition], [0.31, 0.16, 0.25], C.metal);
        g.box([bx + 1, 1.17, z + beltPosition], [0.2, 0.025, 0.15], color, 0.9);
        g.rod(hand, target, 0.022, C.cyan, 1);
        fx.rod(hand, target, 0.085, C.cyan, 0.22);
        g.octagon(target, [0.12, 0.09, 0.12], C.white, 1);
        // Deliberate welding sparks derive from an actually running agent.
        for (let j = 0; j < 7; j++) {
          const cycle = (t * 1.8 + j / 7) % 1,
            a = j * 2.399;
          const p = [
            target[0] + Math.cos(a) * cycle * 0.55,
            target[1] + Math.sin(cycle * Math.PI) * 0.45,
            target[2] + Math.sin(a) * cycle * 0.55,
          ];
          fx.rod(
            p,
            [
              p[0] + Math.cos(a) * 0.06,
              p[1] + 0.035,
              p[2] + Math.sin(a) * 0.06,
            ],
            0.012,
            j % 3 ? C.amber : C.white,
            1 - cycle,
          );
        }
      }
      g.box(
        [bx + 1.5, 1.3, z + (z < 0 ? -1.12 : 1.12)],
        [0.2, 0.18, 0.21],
        color,
        0.9,
      );
      g.ring([baseX, 0.25, z], 0.76, 0.022, color, 0.75, 28, 0.72, t * 0.6);
    }
    if (failed) {
      g.box(
        [x, y + 0.4, z],
        [0.19, 0.1, 0.2],
        C.red,
        0.65 + Math.sin(time * 6) * 0.3,
      );
      g.ring([baseX, 0.25, z], 0.8, 0.028, C.red, 0.8, 24, 0.85);
    }
    if (selected === unit.id)
      g.ring([baseX, 0.27, z], 1.12, 0.075, C.selection, 1, 40);
    return [x, y + 1.02, z];
  }

  function project(p, matrix) {
    const w =
      matrix[3] * p[0] + matrix[7] * p[1] + matrix[11] * p[2] + matrix[15];
    return {
      x:
        ((matrix[0] * p[0] + matrix[4] * p[1] + matrix[8] * p[2] + matrix[12]) /
          w) *
          0.5 +
        0.5,
      y:
        0.5 -
        ((matrix[1] * p[0] + matrix[5] * p[1] + matrix[9] * p[2] + matrix[13]) /
          w) *
          0.5,
      w,
    };
  }
  function upload(target, geometry, usage = gl.DYNAMIC_DRAW) {
    gl.bindBuffer(gl.ARRAY_BUFFER, target.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(geometry.data), usage);
    target.count = geometry.data.length / 10;
  }
  function draw(target) {
    gl.bindBuffer(gl.ARRAY_BUFFER, target.buffer);
    let offset = 0;
    [3, 3, 3, 1].forEach((size, i) => {
      gl.enableVertexAttribArray(attributes[i]);
      gl.vertexAttribPointer(attributes[i], size, gl.FLOAT, false, 40, offset);
      offset += size * 4;
    });
    gl.drawArrays(gl.TRIANGLES, 0, target.count);
  }
  function resize() {
    const rect = canvas.getBoundingClientRect(),
      dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(rect.width, 1);
    height = Math.max(rect.height, 1);
    const w = Math.round(width * dpr),
      h = Math.round(height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }
  function render() {
    if (disposed || contextLost) return;
    resize();
    syncWhip();
    const aspect = width / height;
    // Move back on narrow canvases so the entire factory remains inside frame.
    const solo = units.length === 0;
    const distance = (solo ? 0.44 : 0.82) * Math.max(1, 1.6 / aspect);
    const pose = parentMotion.pose();
    const wantedTarget = solo ? [pose.x + 0.65, 1.6, pose.z] : [-0.5, 0.6, 0];
    if (!motion) cameraTarget = wantedTarget;
    const target = cameraTarget;
    const eye = [
      target[0] + 23 * distance + cameraOffset[0],
      target[1] + 24 * distance + cameraOffset[1],
      30 * distance,
    ];
    const matrix = cameraMatrix(eye, target, aspect);
    const g = new Geometry(),
      fx = new Geometry();
    const visiting = visitors.visitorsAt(sessionId);
    const ownAway = visitors.isAway(sessionId);
    const ownTravel = visiting.find(visitor => visitor.id === sessionId);
    let parentPosition;
    if (ownTravel) {
      parentPosition = drawParentSession(g, fx, ownTravel);
      canvas.dataset.robotWhip = '';
      canvas.dataset.parentMode = ownTravel.phase;
      canvas.dataset.parentActivity = '';
      canvas.dataset.parentEyes = String(AWAKE_EYE_HEIGHT);
    } else if (!ownAway) parentPosition = drawParentSession(g, fx);
    else {
      parentPosition = {
        p: [-6.25, 4.4, 0],
        body: [-6.25, 1.6, 0],
        whipStart: null,
      };
      // A holographic locator leaves the workstation visibly occupied by an
      // away/return state instead of making the parent silently disappear.
      const pulse = 0.8 + Math.sin(time * 2.4) * 0.12;
      g.ring([-6.25, 0.42, 0], 2.18, 0.055, C.amber, pulse, 40);
      g.ring([-6.25, 2.15, 0], 0.72, 0.028, C.amber, 0.85, 32);
      g.rod([-6.25, 0.45, 0], [-6.25, 2.15, 0], 0.018, C.amber, 0.8);
      g.rod([-6.75, 2.15, 0], [-5.78, 2.15, 0], 0.055, C.amber, 0.9);
      g.rod([-5.78, 2.15, 0], [-6.08, 2.42, 0], 0.055, C.amber, 0.9);
      g.rod([-5.78, 2.15, 0], [-6.08, 1.88, 0], 0.055, C.amber, 0.9);
      canvas.dataset.robotWhip = '';
      canvas.dataset.parentMode = 'away';
      canvas.dataset.parentActivity = visitors.awayMessage(sessionId);
      canvas.dataset.parentEyes = String(AWAKE_EYE_HEIGHT);
    }
    const positions = [{id: 'parent', ...parentPosition}];
    units.forEach((unit, i) =>
      positions.push({
        id: unit.id,
        p: drawAgent(unit, g, fx, i),
        body: positionFor(unit),
      }),
    );
    for (const visitor of visiting) {
      if (visitor === ownTravel) continue;
      drawParentSession(g, fx, visitor);
      const source = factoryIdentityPalette(C, factoryIdentity(visitor.id));
      g.ring(
        [visitor.x, 0.43, visitor.z],
        2.34,
        0.065,
        source.factoryAccent,
        0.95,
        48,
      );
    }
    canvas.dataset.factoryVisitors = visiting
      .map(visitor => visitor.id)
      .join(',');
    canvas.dataset.parentAway = String(ownAway);
    const parentAwayMessage = visitors.awayMessage(sessionId);
    canvas.dataset.parentAwayLabel = parentAwayMessage;
    const foreignNames = visiting
      .filter(visitor => visitor.id !== sessionId)
      .map(visitor => visitor.name || visitor.id);
    const canvasDetails = [
      parentAwayMessage ? `Parent: ${parentAwayMessage}` : '',
      foreignNames.length ? `Visiting parents: ${foreignNames.join(', ')}` : '',
    ].filter(Boolean);
    canvas.setAttribute(
      'aria-label',
      canvasDetails.length
        ? `${defaultCanvasLabel}. ${canvasDetails.join('. ')}.`
        : defaultCanvasLabel,
    );
    const lash = whip.pose();
    const lashTarget = lash && positions.find(p => p.id === lash.target);
    if (lashTarget && positions[0].whipStart) {
      const endpoint = [...lashTarget.body];
      endpoint[1] += 0.22 + whipPose(lash.age).recoil * 0.68;
      drawRobotWhip(g, fx, C, positions[0].whipStart, endpoint, lash.age);
    }
    for (const beam of dispatches) {
      const fade = Math.max(0, 1 - beam.age / beam.life);
      g.rod(beam.from, beam.to, 0.016 * fade, C.white, 1);
      fx.rod(beam.from, beam.to, 0.1 * fade, C.mint, fade * 0.15);
      const head = beam.from.map(
        (v, i) => v + (beam.to[i] - v) * Math.min(1, beam.age * 2.8),
      );
      fx.octagon(head, [0.27, 0.27, 0.27], C.mint, fade * 0.7);
      fx.ring(
        [beam.to[0], 0.3, beam.to[2]],
        0.4 + beam.age * 1.6,
        0.036,
        C.mint,
        fade * 0.5,
        36,
      );
    }
    for (const flash of flashes) {
      const fade = 1 - flash.age / flash.life;
      fx.ring(
        [flash.p[0], 0.31, flash.p[2]],
        0.18 + flash.age * 2.0,
        0.05 * fade,
        flash.color,
        fade * 0.65,
        32,
      );
      if (flash.age < 0.24) {
        const size = 0.18 + flash.age * 3;
        fx.octagon(
          flash.p,
          [size, size, size],
          flash.color,
          (1 - flash.age / 0.24) * 0.7,
        );
      }
    }
    for (const p of particles) {
      const fade = 1 - p.age / p.life;
      const tail = p.p.map((v, i) => v - p.v[i] * 0.035);
      fx.rod(tail, p.p, p.size * fade, p.color, fade);
    }
    upload(dynamic, g);
    upload(glow, fx);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.useProgram(program);
    gl.uniformMatrix4fv(uniforms.uMatrix, false, matrix);
    gl.uniform3fv(uniforms.uEye, eye);
    gl.uniform1f(uniforms.uGlow, 0);
    draw(factory);
    draw(dynamic);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.depthMask(false);
    gl.uniform1f(uniforms.uGlow, 1);
    draw(glow);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    anchors = positions.map(({id, p, body}) => {
      const point = project(p, matrix),
        center = project(body, matrix);
      return {
        id,
        x: point.x,
        y: point.y,
        visible:
          point.w > 0 &&
          point.x > 0 &&
          point.x < 1 &&
          point.y > 0 &&
          point.y < 1,
        centerX: center.x,
        centerY: center.y,
      };
    });
    const awayMessage = visitors.awayMessage(sessionId);
    const layout = anchors.map(({id, x, y, visible}) => ({
      id,
      x,
      y,
      visible,
      away: id === 'parent' && Boolean(awayMessage),
      detail: id === 'parent' ? awayMessage : '',
    }));
    // Labels do not need subpixel DOM churn on a stationary scene.
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
  function canAnimate() {
    return (
      (motion || reaction?.animated) &&
      !document.hidden &&
      inView &&
      !disposed &&
      !contextLost
    );
  }
  function tick(now) {
    frame = 0;
    if (!canAnimate()) {
      lastFrame = 0;
      return;
    }
    const elapsed = lastFrame ? (now - lastFrame) / 1000 : 0;
    lastFrame = now;
    if (reaction?.animated) {
      reaction.age += elapsed;
      if (reaction.age >= STARTLE_DURATION) reaction = null;
    }
    // The parent Stop reaction and working agents keep separate clocks.
    if (motion) {
      const dt = Math.min(elapsed, 0.05);
      time += dt;
      syncWhip();
      if (!whip.pose()) parentMotion.tick(dt);
      visitors.observeLocalPose(sessionId, parentMotion.pose());
      visitors.tick(dt);
      parentMotion.setAway(visitors.isAway(sessionId));
      syncWhip();
      whip.tick(dt);
      const pose = parentMotion.pose();
      const target =
        units.length === 0 ? [pose.x + 0.65, 1.6, pose.z] : [-0.5, 0.6, 0];
      cameraTarget = cameraTarget.map(
        (v, i) => v + (target[i] - v) * Math.min(1, dt * 5),
      );
      cameraOffset = cameraOffset.map(
        (v, i) => v + (pointer[i] - v) * Math.min(1, dt * 4),
      );
      for (const p of particles) {
        p.age += dt;
        p.v[1] -= dt * 5;
        p.p = p.p.map((v, i) => v + p.v[i] * dt);
      }
      particles = particles.filter(p => p.age < p.life && p.p[1] > 0.05);
      dispatches.forEach(b => {
        b.age += dt;
      });
      dispatches = dispatches.filter(b => b.age < b.life);
      flashes.forEach(f => {
        f.age += dt;
      });
      flashes = flashes.filter(f => f.age < f.life);
    }
    render();
    if (canAnimate()) schedule();
    else lastFrame = 0;
  }
  function schedule() {
    if (canAnimate() && !frame) frame = requestAnimationFrame(tick);
  }
  function stop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    lastFrame = 0;
  }
  function onResize() {
    if (!disposed) {
      render();
      schedule();
    }
  }
  function onVisibility() {
    if (canAnimate()) {
      render();
      schedule();
    } else stop();
  }
  function onPointerMove(event) {
    const rect = canvas.getBoundingClientRect();
    pointer = [
      ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 1.5 - 0.75,
      0.5 - (event.clientY - rect.top) / Math.max(rect.height, 1),
    ];
    const hit = findHit(event);
    canvas.style.cursor = hit ? 'pointer' : '';
  }
  function onPointerLeave() {
    pointer = [0, 0];
    canvas.style.cursor = '';
  }
  function findHit(event) {
    const rect = canvas.getBoundingClientRect(),
      x = event.clientX - rect.left,
      y = event.clientY - rect.top;
    let hit = null,
      distance = Infinity;
    for (const a of anchors) {
      const d = Math.min(
        Math.hypot(x - a.x * rect.width, y - a.y * rect.height),
        Math.hypot(x - a.centerX * rect.width, y - a.centerY * rect.height),
      );
      if (a.visible && d < (a.id === 'parent' ? 62 : 38) && d < distance) {
        hit = a.id;
        distance = d;
      }
    }
    return hit;
  }
  function onClick(event) {
    const hit = findHit(event);
    if (hit !== null) onSelect(hit);
  }
  function onContextLost(event) {
    event.preventDefault();
    contextLost = true;
    whip.cancel();
    reaction = null;
    stop();
  }
  function onContextRestored() {
    if (disposed) return;
    resources.shaders = [];
    resources.buffers = [];
    program = null;
    try {
      initializeProgram();
      factory = makeBuffer(buildFactory(C, identity), gl.STATIC_DRAW);
      dynamic = makeBuffer(new Geometry(), gl.DYNAMIC_DRAW);
      glow = makeBuffer(new Geometry(), gl.DYNAMIC_DRAW);
      contextLost = false;
      render();
      schedule();
    } catch {
      releaseResources();
    }
  }
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);
  document.addEventListener('visibilitychange', onVisibility);
  const resizeObserver =
    typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
  resizeObserver?.observe(canvas);
  if (!resizeObserver) window.addEventListener('resize', onResize);
  const intersectionObserver =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(entries => {
          inView = entries[0]?.isIntersecting ?? true;
          onVisibility();
        })
      : null;
  intersectionObserver?.observe(canvas);
  render();
  schedule();

  return {
    updateHub(hub) {
      if (disposed) return;
      visitors.update(hub);
      parentMotion.setAway(visitors.isAway(sessionId));
      render();
      schedule();
    },
    update(data, selectedId = 'parent') {
      if (disposed) return;
      const id = data?.session?.id;
      if (id !== sessionId) {
        reaction = null;
        stop();
        sessionId = id;
        identity = factoryIdentity(id);
        canvas.dataset.factoryIdentity = identity.token;
        if (!contextLost)
          upload(factory, buildFactory(C, identity), gl.STATIC_DRAW);
        firstSnapshot = true;
        previous = new Map();
        slots = new Map();
        particles = [];
        dispatches = [];
        flashes = [];
        time = 0;
      }
      visitors.update(data?.sessions ? data : data?.hub || data);
      parentMotion.update(data?.session);
      visitors.observeLocalPose(id, parentMotion.pose());
      parentMotion.setAway(visitors.isAway(id));
      snapshot = data;
      selected = selectedId;
      reconcile(data);
      if (time === 0) {
        const pose = parentMotion.pose();
        cameraTarget =
          units.length === 0 ? [pose.x + 0.65, 1.6, pose.z] : [-0.5, 0.6, 0];
      }
      render();
      schedule();
    },
    setPalette(palette) {
      if (disposed) return;
      const next = Object.fromEntries(
        Object.entries(COLORS).map(([key, fallback]) => {
          const color = palette?.[key];
          const valid =
            Array.isArray(color) &&
            color.length === 3 &&
            color.every(n => Number.isFinite(n) && n >= 0 && n <= 1);
          return [key, [...(valid ? color : fallback)]];
        }),
      );
      // In-flight effects retain their age and position while changing color.
      const replacements = new Map(
        Object.keys(COLORS).map(key => [C[key], next[key]]),
      );
      for (const effect of [...particles, ...flashes]) {
        effect.color = replacements.get(effect.color) ?? effect.color;
      }
      C = next;
      // Reuse the existing GPU buffer; context restoration rebuilds from C.
      if (!contextLost) {
        upload(factory, buildFactory(C, identity), gl.STATIC_DRAW);
        render();
        schedule();
      }
    },
    setMotion(enabled) {
      if (disposed) return;
      motion = Boolean(enabled);
      parentMotion.setMotion(motion);
      visitors.setMotion(motion);
      whip.setMotion(motion);
      if (motion) reaction = null;
      if (!canAnimate()) stop();
      render();
      schedule();
    },
    prompt(id) {
      if (disposed || id !== sessionId) return;
      whip.cancel();
      if (!visitors.prompt(id)) parentMotion.prompt();
      parentMotion.setAway(visitors.isAway(id));
      render();
      schedule();
    },
    cancelPrompt(id) {
      if (disposed || id !== sessionId) return;
      parentMotion.cancelPrompt();
      render();
      schedule();
    },
    startle(animate = true) {
      if (disposed || contextLost) return;
      stop();
      whip.cancel();
      parentMotion.stop();
      reaction = {age: 0, animated: Boolean(animate)};
      render();
      if (animate) schedule();
    },
    clearStartle() {
      if (disposed || !reaction) return;
      reaction = null;
      if (!canAnimate()) stop();
      render();
      schedule();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      reaction = null;
      parentMotion.dispose();
      visitors.dispose();
      whip.dispose();
      stop();
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      canvas.style.cursor = '';
      canvas.setAttribute('aria-label', defaultCanvasLabel);
      delete canvas.dataset.factoryIdentity;
      delete canvas.dataset.factoryVisitors;
      delete canvas.dataset.parentAway;
      delete canvas.dataset.parentAwayLabel;
      particles = [];
      dispatches = [];
      flashes = [];
      anchors = [];
      releaseResources();
    },
  };
}
