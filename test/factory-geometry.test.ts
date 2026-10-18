import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Geometry} from '../assets/dashboard/factory-geometry.js';

const color = [0.25, 0.5, 0.75];
const origin = [0, 0, 0];
const still = {visible: true, offset: origin, rotation: origin, lift: 0};
function close(actual: number, expected: number, tolerance = 0.00001) {
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${actual} != ${expected}`,
  );
}
function vertices(geometry: Geometry) {
  const data = geometry.view();
  return Array.from({length: data.length / 10}, (_, i) =>
    Array.from(data.subarray(i * 10, (i + 1) * 10)),
  );
}

void test('geometry grows without losing vertices and reuses storage without drawing stale tails', () => {
  const geometry = new Geometry();
  geometry.box(origin, [1, 1, 1], color);
  const first = geometry.view().slice();
  for (let i = 0; i < 100; i++) geometry.cylinder([i, 0, 0], [1, 2, 1], color);
  assert.deepEqual(geometry.view().subarray(0, first.length), first);
  const storage = geometry.data.buffer;
  geometry.reset();
  assert.equal(geometry.view().length, 0);
  geometry.box(origin, [1, 1, 1], color);
  assert.equal(geometry.data.buffer, storage);
  assert.deepEqual(geometry.view(), first);
  const scene = new Geometry();
  scene.appendBody(geometry, origin, still);
  assert.deepEqual(scene.view(), first);
  scene.appendBody(geometry, origin, {...still, visible: false});
  assert.deepEqual(scene.view(), first);
  scene.reset();
  scene.appendBody(geometry.reset(), origin, still, 0, 0);
  assert.equal(scene.length, 0);
});

void test('primitive meshes retain dimensions, unit normals, colors and triangle counts', () => {
  const geometry = new Geometry();
  for (const [shape, count] of [
    ['box', 36],
    ['cylinder', 144],
    ['octagon', 96],
  ] as const) {
    geometry.reset();
    geometry[shape]([2, 3, 4], [2, 4, 6], color, 0.8);
    const points = vertices(geometry);
    assert.equal(points.length, count);
    for (let axis = 0; axis < 3; axis++) {
      close(Math.min(...points.map(p => p[axis])), [1, 1, 1][axis]);
      close(Math.max(...points.map(p => p[axis])), [3, 5, 7][axis]);
    }
    for (const p of points) {
      close(Math.hypot(...p.slice(3, 6)), 1);
      assert.deepEqual(p.slice(6, 9), color);
      close(p[9], 0.8);
    }
  }
});

void test('rings preserve partial segments, phase, gaps and winding', () => {
  const geometry = new Geometry();
  for (const segments of [16, 24, 28, 32, 36, 40, 48]) {
    for (const fraction of [0, 0.28, 0.72, 1]) {
      for (const phase of [0, 0.37, -2.5]) {
        geometry
          .reset()
          .ring([2, 3, 4], 1, 0.1, color, 0.7, segments, fraction, phase);
        const points = vertices(geometry);
        assert.equal(points.length, Math.ceil(segments * fraction) * 6);
        for (let i = 0; i < points.length; i++) {
          const segment = Math.floor(i / 6);
          const corner = [0, 1, 2, 0, 2, 3][i % 6];
          const angle =
            phase +
            ((segment + (corner < 2 ? 0 : 0.82)) / segments) * Math.PI * 2;
          const radius = corner === 0 || corner === 3 ? 0.9 : 1.1;
          close(points[i][0], 2 + Math.cos(angle) * radius);
          close(points[i][2], 4 + Math.sin(angle) * radius);
          assert.deepEqual(points[i].slice(1, 2), [3]);
          assert.deepEqual(points[i].slice(3, 9), [0, 1, 0, ...color]);
        }
      }
    }
  }
});

void test('parent placement rotates positions and normals around the local origin', () => {
  const body = new Geometry();
  body.box([-6.25, 1, 0], [1, 1, 1], color);
  const placed = new Geometry();
  placed.append(body, [3, 2, 4], Math.PI / 2, -6.25);
  const source = vertices(body);
  vertices(placed).forEach((p, i) => {
    close(p[0], 3 + source[i][2]);
    close(p[1], 2 + source[i][1]);
    close(p[2], 4 - (source[i][0] + 6.25));
    close(p[3], source[i][5]);
    close(p[4], source[i][4]);
    close(p[5], -source[i][3]);
    assert.deepEqual(p.slice(6), source[i].slice(6));
  });
});

void test('rods align to vertical and sloping endpoints and ignore zero-length sparks', () => {
  const geometry = new Geometry();
  const start = [1, 2, 3];
  for (const end of [
    [1, 7, 3],
    [-2, 1, 9],
    [1, -3, 3],
  ]) {
    geometry.reset().rod(start, end, 0.2, color);
    const length = Math.hypot(...end.map((n, axis) => n - start[axis]));
    const direction = end.map((n, axis) => (n - start[axis]) / length);
    const projections = vertices(geometry).map(p =>
      p
        .slice(0, 3)
        .reduce((sum, n, axis) => sum + (n - start[axis]) * direction[axis], 0),
    );
    close(Math.min(...projections), 0);
    close(Math.max(...projections), length);
  }
  geometry.reset().rod(start, start, 0.2, color);
  assert.equal(geometry.length, 0);
});

void test('damaged bodies rotate around their pivot with translation and lift', () => {
  const source = new Geometry();
  source.box([2, 3, 4], [1, 2, 3], color);
  const pivot = [2, 1, 4];
  const pose = {
    ...still,
    rotation: [0.2, -0.7, 1.1],
    offset: [0.5, -0.2, 1.5],
    lift: 0.8,
  };
  // Independent sequential rotations verify the combined transform and normals.
  const rotate = ([x, y, z]: number[]) => {
    for (const [axis, angle] of pose.rotation.entries()) {
      const c = Math.cos(angle),
        s = Math.sin(angle);
      if (axis === 0) [y, z] = [y * c - z * s, y * s + z * c];
      if (axis === 1) [x, z] = [x * c + z * s, z * c - x * s];
      if (axis === 2) [x, y] = [x * c - y * s, x * s + y * c];
    }
    return [x, y, z];
  };
  const result = new Geometry();
  result.appendBody(source, pivot, pose);
  vertices(result).forEach((p, i) => {
    const original = vertices(source)[i];
    const position = rotate(
      original.slice(0, 3).map((n, axis) => n - pivot[axis]),
    );
    const normal = rotate(original.slice(3, 6));
    for (let axis = 0; axis < 3; axis++) {
      close(
        p[axis],
        position[axis] +
          pivot[axis] +
          pose.offset[axis] +
          (axis === 1 ? pose.lift : 0),
      );
      close(p[axis + 3], normal[axis]);
    }
    assert.deepEqual(p.slice(6), original.slice(6));
  });
});

void test('hatch and service-exit clipping preserve visible area and interpolate attributes', () => {
  const triangle = new Geometry();
  const points = [
    [-2, -1, 0],
    [2, -1, 0],
    [0, 3, 0],
  ];
  const length = triangle.reserve(30);
  points.forEach(([x, y, z], i) =>
    triangle.data.set(
      [x, y, z, 0, 0, 1, (x + 2) / 4, (y + 1) / 4, 0.5, 0.8],
      length + i * 10,
    ),
  );
  const result = new Geometry();
  for (const [floor, exit, area] of [
    [0, Infinity, 4.5],
    [-Infinity, 0, 4],
    [0, 0, 2.25],
    [4, 0, 0],
    [0, -3, 0],
  ]) {
    result.reset().appendBody(triangle, origin, still, floor, exit);
    const clipped = vertices(result);
    let actualArea = 0;
    for (let i = 0; i < clipped.length; i += 3) {
      const [a, b, c] = clipped.slice(i, i + 3);
      actualArea +=
        ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
    }
    close(actualArea, area);
    for (const p of clipped) {
      assert.ok(p[1] >= floor && p[0] <= exit);
      close(p[6], (p[0] + 2) / 4);
      close(p[7], (p[1] + 1) / 4);
      assert.deepEqual(p.slice(3, 6), [0, 0, 1]);
      close(p[9], 0.8);
    }
  }
});
