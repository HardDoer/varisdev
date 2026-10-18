// Reusable, interleaved position/normal/color/emission storage. Geometry is
// written directly in the format consumed by WebGL; reset retains capacity.
const TAU = Math.PI * 2;
const STRIDE = 10;
const TRIANGLE = [0, 1, 2, 0, 2, 3];

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
  for (const [normal, points] of faces)
    for (const i of TRIANGLE)
      result.push(...points[i].map(v => v / 2), ...normal);
  return result;
}
function cylinderMesh(segments) {
  const result = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * TAU,
      b = ((i + 1) / segments) * TAU;
    const p = [Math.cos(a) * 0.5, Math.sin(a) * 0.5];
    const q = [Math.cos(b) * 0.5, Math.sin(b) * 0.5];
    const normal = [Math.cos((a + b) / 2), 0, Math.sin((a + b) / 2)];
    const side = [
      [p[0], -0.5, p[1]],
      [p[0], 0.5, p[1]],
      [q[0], 0.5, q[1]],
      [q[0], -0.5, q[1]],
    ];
    for (const j of TRIANGLE) result.push(...side[j], ...normal);
    for (const sign of [-1, 1]) {
      result.push(0, sign * 0.5, 0, 0, sign, 0);
      result.push(p[0], sign * 0.5, p[1], 0, sign, 0);
      result.push(q[0], sign * 0.5, q[1], 0, sign, 0);
    }
  }
  return result;
}
export const CUBE = cubeMesh();
const CYLINDER = cylinderMesh(12);
export const OCTAGON = cylinderMesh(8);

function rotationMatrix([rx, ry, rz]) {
  const cx = Math.cos(rx),
    sx = Math.sin(rx);
  const cy = Math.cos(ry),
    sy = Math.sin(ry);
  const cz = Math.cos(rz),
    sz = Math.sin(rz);
  return [
    cy * cz,
    sx * sy * cz - cx * sz,
    cx * sy * cz + sx * sz,
    cy * sz,
    sx * sy * sz + cx * cz,
    cx * sy * sz - sx * cz,
    -sy,
    sx * cy,
    cx * cy,
  ];
}

// Clip into reusable scratch storage, interpolating all vertex attributes.
// A triangle clipped against two planes has at most five vertices.
function clipPolygon(input, output, count, axis, boundary, above) {
  let length = 0;
  for (let i = 0; i < count; i++) {
    const a = i * STRIDE,
      b = ((i + 1) % count) * STRIDE;
    const insideA = above
      ? input[a + axis] >= boundary
      : input[a + axis] <= boundary;
    const insideB = above
      ? input[b + axis] >= boundary
      : input[b + axis] <= boundary;
    if (insideA) {
      for (let k = 0; k < STRIDE; k++) output[length++] = input[a + k];
    }
    if (insideA !== insideB) {
      const t =
        (boundary - input[a + axis]) / (input[b + axis] - input[a + axis]);
      for (let k = 0; k < STRIDE; k++)
        output[length++] = input[a + k] + (input[b + k] - input[a + k]) * t;
    }
  }
  return length / STRIDE;
}

const rings = new Map();
function ringPoints(segments) {
  let points = rings.get(segments);
  if (!points) {
    points = new Float64Array(segments * 4);
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * TAU,
        b = ((i + 0.82) / segments) * TAU;
      points.set([Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)], i * 4);
    }
    rings.set(segments, points);
  }
  return points;
}
function ringVertex(data, offset, x, y, z, color, emission) {
  data[offset] = x;
  data[offset + 1] = y;
  data[offset + 2] = z;
  data[offset + 3] = 0;
  data[offset + 4] = 1;
  data[offset + 5] = 0;
  data[offset + 6] = color[0];
  data[offset + 7] = color[1];
  data[offset + 8] = color[2];
  data[offset + 9] = emission;
}

export class Geometry {
  constructor() {
    this.data = new Float32Array(1024);
    this.length = 0;
  }
  reset() {
    this.length = 0;
    return this;
  }
  reserve(length) {
    const offset = this.length;
    const needed = offset + length;
    if (needed > this.data.length) {
      let capacity = this.data.length;
      while (capacity < needed) capacity *= 2;
      const data = new Float32Array(capacity);
      data.set(this.data.subarray(0, offset));
      this.data = data;
    }
    this.length = needed;
    return offset;
  }
  view() {
    return this.data.subarray(0, this.length);
  }
  append(geometry, position, yaw = 0, originX = 0) {
    let offset = this.reserve(geometry.length);
    const d = this.data,
      source = geometry.data;
    const c = Math.cos(yaw),
      s = Math.sin(yaw);
    for (let i = 0; i < geometry.length; i += STRIDE, offset += STRIDE) {
      const x = source[i] - originX,
        z = source[i + 2];
      d[offset] = position[0] + x * c + z * s;
      d[offset + 1] = position[1] + source[i + 1];
      d[offset + 2] = position[2] + z * c - x * s;
      d[offset + 3] = source[i + 3] * c + source[i + 5] * s;
      d[offset + 4] = source[i + 4];
      d[offset + 5] = source[i + 5] * c - source[i + 3] * s;
      for (let k = 6; k < STRIDE; k++) d[offset + k] = source[i + k];
    }
  }
  appendBody(geometry, pivot, pose, floor = -Infinity, exit = Infinity) {
    if (!pose.visible || !geometry.length) return;
    const clipFloor = Number.isFinite(floor),
      clipExit = Number.isFinite(exit);
    const clipping = clipFloor || clipExit;
    if (
      !clipping &&
      pose.lift === 0 &&
      pose.offset.every(n => n === 0) &&
      pose.rotation.every(n => n === 0)
    ) {
      const offset = this.reserve(geometry.length);
      this.data.set(geometry.view(), offset);
      return;
    }
    const m = rotationMatrix(pose.rotation);
    const tx = pivot[0] + pose.offset[0];
    const ty = pivot[1] + pose.offset[1] + pose.lift;
    const tz = pivot[2] + pose.offset[2];
    const source = geometry.data;
    let offset = clipping ? 0 : this.reserve(geometry.length);
    if (clipping && !this.clipA) {
      this.clipA = new Float64Array(60);
      this.clipB = new Float64Array(60);
    }
    for (let i = 0; i < geometry.length; i += 30) {
      const d = clipping ? this.clipA : this.data;
      let out = clipping ? 0 : offset;
      for (let j = i; j < i + 30; j += STRIDE, out += STRIDE) {
        const x = source[j] - pivot[0],
          y = source[j + 1] - pivot[1],
          z = source[j + 2] - pivot[2];
        const nx = source[j + 3],
          ny = source[j + 4],
          nz = source[j + 5];
        d[out] = x * m[0] + y * m[1] + z * m[2] + tx;
        d[out + 1] = x * m[3] + y * m[4] + z * m[5] + ty;
        d[out + 2] = x * m[6] + y * m[7] + z * m[8] + tz;
        d[out + 3] = nx * m[0] + ny * m[1] + nz * m[2];
        d[out + 4] = nx * m[3] + ny * m[4] + nz * m[5];
        d[out + 5] = nx * m[6] + ny * m[7] + nz * m[8];
        for (let k = 6; k < STRIDE; k++) d[out + k] = source[j + k];
      }
      if (!clipping) {
        offset += 30;
        continue;
      }
      let input = this.clipA,
        output = this.clipB,
        count = 3;
      if (clipFloor) {
        count = clipPolygon(input, output, count, 1, floor, true);
        [input, output] = [output, input];
      }
      if (clipExit) {
        count = clipPolygon(input, output, count, 0, exit, false);
        input = output;
      }
      if (count < 3) continue;
      let dest = this.reserve((count - 2) * 30);
      for (let j = 1; j < count - 1; j++) {
        for (const vertex of [0, j, j + 1])
          for (let k = 0; k < STRIDE; k++)
            this.data[dest++] = input[vertex * STRIDE + k];
      }
    }
  }
  shape(mesh, p, s, color, emission = 0, yaw = 0, basis = null) {
    let offset = this.reserve((mesh.length / 6) * STRIDE);
    const d = this.data;
    const c = Math.cos(yaw),
      q = Math.sin(yaw);
    const ux = basis ? basis[0][0] : c,
      uy = basis ? basis[0][1] : 0,
      uz = basis ? basis[0][2] : -q;
    const vx = basis ? basis[1][0] : 0,
      vy = basis ? basis[1][1] : 1,
      vz = basis ? basis[1][2] : 0;
    const wx = basis ? basis[2][0] : q,
      wy = basis ? basis[2][1] : 0,
      wz = basis ? basis[2][2] : c;
    for (let i = 0; i < mesh.length; i += 6, offset += STRIDE) {
      const x = mesh[i] * s[0],
        y = mesh[i + 1] * s[1],
        z = mesh[i + 2] * s[2];
      const nx = mesh[i + 3],
        ny = mesh[i + 4],
        nz = mesh[i + 5];
      d[offset] = p[0] + x * ux + y * vx + z * wx;
      d[offset + 1] = p[1] + x * uy + y * vy + z * wy;
      d[offset + 2] = p[2] + x * uz + y * vz + z * wz;
      d[offset + 3] = nx * ux + ny * vx + nz * wx;
      d[offset + 4] = nx * uy + ny * vy + nz * wy;
      d[offset + 5] = nx * uz + ny * vz + nz * wz;
      d[offset + 6] = color[0];
      d[offset + 7] = color[1];
      d[offset + 8] = color[2];
      d[offset + 9] = emission;
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
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      dz = b[2] - a[2];
    const length = Math.hypot(dx, dy, dz);
    if (length < 0.0001) return;
    const v = [dx / length, dy / length, dz / length];
    const u = Math.abs(v[1]) > 0.95 ? [0, -v[2], v[1]] : [v[2], 0, -v[0]];
    const scale = Math.hypot(...u) || 1;
    for (let i = 0; i < 3; i++) u[i] /= scale;
    const w = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    this.shape(
      OCTAGON,
      [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
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
    const count = Math.max(0, Math.ceil(segments * fraction));
    let offset = this.reserve(count * 60);
    const points = ringPoints(segments),
      d = this.data;
    const c = Math.cos(phase),
      s = Math.sin(phase);
    const inner = radius - width,
      outer = radius + width;
    for (let i = 0; i < count; i++, offset += 60) {
      const at = (i % segments) * 4;
      const ax = points[at] * c - points[at + 1] * s,
        az = points[at + 1] * c + points[at] * s;
      const bx = points[at + 2] * c - points[at + 3] * s,
        bz = points[at + 3] * c + points[at + 2] * s;
      ringVertex(
        d,
        offset,
        p[0] + ax * inner,
        p[1],
        p[2] + az * inner,
        color,
        emission,
      );
      ringVertex(
        d,
        offset + 10,
        p[0] + ax * outer,
        p[1],
        p[2] + az * outer,
        color,
        emission,
      );
      ringVertex(
        d,
        offset + 20,
        p[0] + bx * outer,
        p[1],
        p[2] + bz * outer,
        color,
        emission,
      );
      ringVertex(
        d,
        offset + 30,
        p[0] + ax * inner,
        p[1],
        p[2] + az * inner,
        color,
        emission,
      );
      ringVertex(
        d,
        offset + 40,
        p[0] + bx * outer,
        p[1],
        p[2] + bz * outer,
        color,
        emission,
      );
      ringVertex(
        d,
        offset + 50,
        p[0] + bx * inner,
        p[1],
        p[2] + bz * inner,
        color,
        emission,
      );
    }
  }
}
