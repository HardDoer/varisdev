/* global window, document, requestAnimationFrame, cancelAnimationFrame, ResizeObserver, IntersectionObserver */
/* A small, dependency-free WebGL scene. Coordinates and lighting are real 3D;
 * the dashboard owns the accessible labels, session data and motion preference. */
const TAU = Math.PI * 2;
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

function buildFactory(C) {
  const g = new Geometry();
  // Floating cutaway foundation and the visible service plinth underneath.
  g.box([0, -0.66, 0], [21.5, 0.45, 12.1], C.dark);
  g.box([0, -0.31, 0], [21.1, 0.28, 11.7], C.edge);
  g.box([0, -0.13, 0], [20.7, 0.12, 11.3], C.floor);
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
    g.rod([x, 4.7, -5.3], [x + 0.9, 3.8, -5.3], 0.08, C.edge);
    g.box([x, 4.5, -4.8], [0.85, 0.12, 0.6], C.dark);
    g.box([x, 4.42, -4.76], [0.68, 0.035, 0.42], C.white, 0.95);
  }
  // Exposed plumbing and utility tanks on the command side.
  for (const y of [1.75, 2.16]) {
    g.rod([-10.2, y, -4.8], [-4.3, y, -4.8], 0.1, C.metal);
    g.rod([-10.2, 0.2, -4.8], [-10.2, y, -4.8], 0.1, C.metal);
    for (const x of [-9, -7, -5]) g.box([x, y, -4.8], [0.09, 0.3, 0.3], C.dark);
  }
  for (const x of [-9.3, -8.1]) {
    g.cylinder([x, 1, -3.7], [0.83, 1.85, 0.83], C.metal);
    g.cylinder([x, 1.73, -3.7], [0.9, 0.11, 0.9], C.dark);
    g.cylinder([x, 0.35, -3.7], [0.9, 0.13, 0.9], C.dark);
    g.box([x, 1.06, -3.24], [0.12, 0.65, 0.05], C.mint, 0.8);
  }
  // Master dais, radial tracks and two physical control consoles.
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
  let factory = makeBuffer(buildFactory(C), gl.STATIC_DRAW);
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
      status === 'compacting'
    )
      return C.amber;
    if (status === 'running') return C.mint;
    if (status === 'completed') return C.cyan;
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
    // Working drones claim work bays before queued/history units, even when
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
          burst(p, C.mint, 42);
        } else if (
          shown &&
          old &&
          old !== agent.status &&
          agent.status === 'completed'
        )
          burst(positionFor(agent), C.cyan, 62);
        else if (shown && old !== agent.status && agent.status === 'failed')
          burst(positionFor(agent), C.red, 48);
      }
    }
    previous = new Map(agents.map(a => [a.id, a.status]));
    firstSnapshot = false;
  }

  function master(g, fx) {
    const state = snapshot?.session?.status || 'idle';
    const active = state === 'running' || state === 'compacting';
    const activity = snapshot?.session?.activity || '';
    const tools =
      active &&
      /using|tool|running (bash|read|write|edit|agent_)/i.test(activity);
    const writing = active && !tools && /responding|writing/i.test(activity);
    const thinking = active && !tools && !writing;
    const color = tools ? C.amber : thinking ? C.cyan : statusColor(state);
    const t = active ? time : 0;
    const x = -6.25,
      bob = active ? Math.sin(t * (writing ? 5 : 2.5)) * 0.09 : 0;
    const y = 0.4 + bob;
    g.cylinder([x, 0.38, 0], [2.25, 0.045, 1.5], [0.026, 0.055, 0.06]);
    // Two planted feet, visible knee joints and a segmented waist.
    for (const z of [-0.54, 0.54]) {
      g.box([x + 0.12, 0.59, z], [1.08, 0.35, 0.66], C.metal);
      g.box([x + 0.5, 0.65, z], [0.12, 0.15, 0.55], C.shell);
      g.rod([x - 0.15, 0.7, z], [x - 0.25, 1.15 + bob, z], 0.2, C.dark);
      g.octagon([x - 0.23, 1.03 + bob, z], [0.52, 0.25, 0.52], C.metal);
      g.box([x - 0.1, 1.2 + bob, z], [0.52, 0.45, 0.44], C.shell);
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
    for (const z of [-0.4, 0.4]) {
      g.box([x + 0.91, y + 2.67, z], [0.04, 0.16, 0.29], color, 1);
      g.box([x - 0.08, y + 2.64, z * 2.23], [0.56, 0.5, 0.14], C.metal);
      g.box([x + 0.01, y + 2.66, z * 2.43], [0.21, 0.22, 0.03], color, 0.8);
    }
    g.rod(
      [x - 0.43, y + 3.05, -0.48],
      [x - 0.53, y + 3.68, -0.48],
      0.037,
      C.metal,
    );
    g.octagon([x - 0.53, y + 3.72, -0.48], [0.19, 0.16, 0.19], color, 0.95);
    for (const side of [-1, 1]) {
      const shoulder = [x, y + 1.94, side * 0.96];
      const stroke = Math.sin(
        t * (writing ? 11 : tools ? 5 : 2.4) + side * 1.8,
      );
      const elbow =
        thinking && side === 1
          ? [x + 0.5, y + 1.85, 1.18]
          : [x + 0.55 + (active ? stroke * 0.22 : 0), y + 1.2, side * 1.25];
      const hand =
        thinking && side === 1
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
    if (selected === 'parent' || active)
      g.ring(
        [x, 0.4, 0],
        2.08,
        selected === 'parent' ? 0.037 : 0.024,
        color,
        0.9,
        48,
        active ? 0.72 : 1,
        t * 0.28,
      );
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
              y + 3.55 + Math.sin(angle) * 0.16,
              Math.sin(angle) * 1.05,
            ],
            [pulse, pulse, pulse],
            C.cyan,
            1,
          );
        }
        g.ring([x, y + 3.5, 0], 1.08, 0.025, C.cyan, 0.7, 32, 0.72, t * 1.8);
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
    return [x, y + 4.0, 0];
  }

  function drone(unit, g, fx, index) {
    const slot = slots.get(unit.id),
      [baseX, baseY, z] = positionFor(unit);
    const active = WORKING.has(unit.status),
      failed = unit.status === 'failed';
    const t = active ? time + index * 1.7 : 0;
    const y = baseY + (active ? Math.sin(t * 2.8) * 0.1 : 0);
    const x = baseX + (active ? Math.sin(t * 1.35) * 0.045 : 0);
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
        const flame = 0.18 + (1 + Math.sin(t * 17 + side)) * 0.035;
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
      y - 0.32 + (active ? Math.sin(t * 4) * 0.12 : 0),
      z + 0.12,
    ];
    g.rod([x + 0.1, y - 0.2, z + 0.27], elbow, 0.066, C.dark);
    g.octagon(elbow, [0.2, 0.18, 0.2], C.amber);
    g.rod(elbow, hand, 0.055, C.metal);
    g.box(hand, [0.18, 0.16, 0.16], C.dark);
    if (slot < 6 && active) {
      const bx = BAYS[slot][0],
        target = [bx + 1, 1.25, z + Math.sin(t * 2.5) * 0.16];
      const welding = unit.status === 'running';
      if (welding) {
        const beltPosition = ((t * 0.35) % 1) * 1.4 - 0.7;
        g.box([bx + 1, 1.08, z + beltPosition], [0.31, 0.16, 0.25], C.metal);
        g.box([bx + 1, 1.17, z + beltPosition], [0.2, 0.025, 0.15], color, 0.9);
        g.rod(hand, target, 0.012, C.cyan, 1);
        fx.rod(hand, target, 0.055, C.cyan, 0.1);
        g.octagon(target, [0.12, 0.09, 0.12], C.white, 1);
        // Deliberate welding sparks derive from an actually running drone.
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
      g.ring([baseX, 0.27, z], 0.97, 0.032, color, 0.95, 32);
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
    const aspect = width / height;
    // Move back on narrow canvases so the entire factory remains inside frame.
    const solo = units.length === 0;
    const distance = (solo ? 0.44 : 0.82) * Math.max(1, 1.6 / aspect);
    const target = solo ? [-5.6, 1.6, 0] : [-0.5, 0.6, 0];
    const eye = [
      target[0] + 23 * distance + cameraOffset[0],
      target[1] + 24 * distance + cameraOffset[1],
      30 * distance,
    ];
    const matrix = cameraMatrix(eye, target, aspect);
    const g = new Geometry(),
      fx = new Geometry();
    const positions = [{id: 'parent', p: master(g, fx), body: [-6.25, 2, 0]}];
    units.forEach((unit, i) =>
      positions.push({
        id: unit.id,
        p: drone(unit, g, fx, i),
        body: positionFor(unit),
      }),
    );
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
    const layout = anchors.map(({id, x, y, visible}) => ({id, x, y, visible}));
    // Labels do not need subpixel DOM churn on a stationary scene.
    const key = layout
      .map(
        a =>
          `${a.id}:${Math.round(a.x * width)}:${Math.round(a.y * height)}:${a.visible}`,
      )
      .join('|');
    if (key !== lastLayout) {
      lastLayout = key;
      onLayout(layout);
    }
  }
  function canAnimate() {
    return motion && !document.hidden && inView && !disposed && !contextLost;
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
    render();
    frame = requestAnimationFrame(tick);
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
    stop();
  }
  function onContextRestored() {
    if (disposed) return;
    resources.shaders = [];
    resources.buffers = [];
    program = null;
    try {
      initializeProgram();
      factory = makeBuffer(buildFactory(C), gl.STATIC_DRAW);
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
    update(data, selectedId = 'parent') {
      if (disposed) return;
      const id = data?.session?.id;
      if (id !== sessionId) {
        sessionId = id;
        firstSnapshot = true;
        previous = new Map();
        slots = new Map();
        particles = [];
        dispatches = [];
        flashes = [];
        time = 0;
      }
      snapshot = data;
      selected = selectedId;
      reconcile(data);
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
        upload(factory, buildFactory(C), gl.STATIC_DRAW);
        render();
        schedule();
      }
    },
    setMotion(enabled) {
      if (disposed) return;
      motion = Boolean(enabled);
      if (!motion) {
        stop();
        particles = [];
        dispatches = [];
        flashes = [];
        pointer = [0, 0];
        cameraOffset = [0, 0];
      }
      render();
      schedule();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
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
      particles = [];
      dispatches = [];
      flashes = [];
      anchors = [];
      releaseResources();
    },
  };
}
