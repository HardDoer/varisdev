import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  createOfficeImpacts,
  officeSurface,
  officeMaterial,
} from '../assets/dashboard/year1998-damage.js';
import {createEnvironmentDamage} from '../assets/dashboard/environment-damage.js';
import {iso} from '../assets/dashboard/year1998-geometry.js';
import {gunTargetAt} from '../assets/dashboard/factory-gun.js';
import {visibleSceneTargets} from '../assets/dashboard/factory-targets.js';

type Face = NonNullable<ReturnType<typeof officeSurface>>;
function surface(points: number[][], material = 'plaster'): Face {
  const result = officeSurface(points, material);
  assert.ok(result);
  return result;
}
const wall = () =>
  surface([
    iso(-11.8, -6.4),
    iso(9.2, -6.4),
    iso(9.2, -6.4, 44),
    iso(-11.8, -6.4, 44),
  ]);
const floor = () =>
  surface([iso(-1, -1), iso(1, -1), iso(1, 1), iso(-1, 1)], 'carpet');
const identity = (point: {x: number; y: number}) => point;
function model(faces: Face[] = [wall()]) {
  const impacts = createOfficeImpacts();
  const sites = [{id: 'wall', x: 0, z: -6.4, variant: 'wall'}];
  impacts.setSites(sites, 'session');
  impacts.setSurfaces('wall', faces);
  const damage = createEnvironmentDamage();
  damage.setSites(sites);
  return {impacts, damage, sites};
}
function hit(
  state: ReturnType<typeof model>,
  point?: {x: number; y: number},
  weapon = 'gun',
) {
  const at = state.impacts.contact('wall', point);
  assert.ok(at);
  const before = state.damage.pose('wall');
  assert.ok(before);
  assert.equal(state.damage.hit('wall', weapon, 1), true);
  assert.equal(state.impacts.hit('wall', weapon, 1, at, before), true);
}

// Record only the office's drawing operations; assertions concern projection,
// localized mark size and lifecycle rather than canvas implementation behavior.
function drawing() {
  const transforms: number[][] = [],
    clips: unknown[] = [],
    colors: string[] = [];
  const ink: number[][] = [];
  const stack: number[] = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    save() {
      stack.push(this.globalAlpha);
    },
    restore() {
      this.globalAlpha = stack.pop()!;
    },
    beginPath() {},
    moveTo(x: number, y: number) {
      ink.push([x, y]);
    },
    lineTo(x: number, y: number) {
      ink.push([x, y]);
    },
    closePath() {},
    rect() {},
    clip(rule?: string) {
      clips.push(rule);
    },
    transform(...values: number[]) {
      transforms.push(values);
    },
    fill() {
      colors.push(this.fillStyle);
    },
    stroke() {
      colors.push(this.strokeStyle);
    },
  };
  return {ctx, transforms, clips, colors, ink};
}

void test('only usable parallelograms become office target surfaces', () => {
  assert.equal(
    officeSurface(
      [
        [0, 0],
        [10, 0],
        [0, 10],
      ],
      'wood',
    ),
    null,
  );
  assert.equal(
    officeSurface(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [5, 10],
      ],
      'wood',
    ),
    null,
  );
  assert.equal(
    officeSurface(
      [
        [0, 0],
        [10, 0],
        [10, 0],
        [0, 0],
      ],
      'wood',
    ),
    null,
  );
});

void test('wall, tabletop and floor contacts resolve onto the actual projected face', () => {
  for (const face of [
    wall(),
    floor(),
    surface(
      [iso(-2, -1, 13), iso(2, -1, 13), iso(2, 1, 13), iso(-2, 1, 13)],
      'wood',
    ),
  ]) {
    const state = model([face]);
    const point = {
      x:
        face.origin[0] +
        face.u[0] * face.width * 0.27 +
        face.v[0] * face.height * 0.63,
      y:
        face.origin[1] +
        face.u[1] * face.width * 0.27 +
        face.v[1] * face.height * 0.63,
    };
    const at = state.impacts.contact('wall', point);
    assert.ok(at);
    assert.ok(Math.abs(at.x / face.width - 0.27) < 1e-9);
    assert.ok(Math.abs(at.y / face.height - 0.63) < 1e-9);
    hit(state, point);
    const rendered = drawing();
    state.impacts.draw(rendered.ctx, 'wall', state.damage.pose('wall'), 0);
    assert.equal(rendered.transforms.length, 1);
    const transform = rendered.transforms[0];
    assert.ok(Math.abs(transform[4] - point.x) < 1e-9);
    assert.ok(Math.abs(transform[5] - point.y) < 1e-9);
    assert.deepEqual(transform.slice(0, 4), [...face.u, ...face.v]);
  }
});

void test('office faces hit in paint order and cannot be hit in surrounding circle space', () => {
  const state = model([floor()]);
  const targets = state.impacts.targets(identity);
  const target = targets[0];
  assert.equal(gunTargetAt(0, 0, targets), target);
  assert.equal(gunTargetAt(24, 12, targets), null);
  assert.equal(state.impacts.contact('wall', {x: 24, y: 12}), null);
  const glass = surface(
    [
      [-6, -6],
      [6, -6],
      [6, 6],
      [-6, 6],
    ],
    'glass',
  );
  state.impacts.setSurfaces('wall', [floor(), glass]);
  const next = state.impacts.targets(identity);
  assert.equal(gunTargetAt(0, 0, next), next[0]);
  assert.equal(state.impacts.contact('wall', {x: 0, y: 0})?.face, 1);
  const behind = surface(
    [
      [-8, -8],
      [8, -8],
      [8, 8],
      [-8, 8],
    ],
    'wood',
  );
  state.impacts.setSites(
    [...state.sites, {id: 'desk', x: 0, z: 0, variant: 'desk'}],
    'session',
  );
  state.impacts.setSurfaces('desk', [behind]);
  assert.equal(gunTargetAt(0, 0, state.impacts.targets(identity))?.id, 'desk');
});

void test('localized material marks preserve face projection under viewport scaling and canvas offset', () => {
  const state = model();
  const scale = 1.75,
    left = 123,
    top = 71;
  const target = state.impacts.targets((p: {x: number; y: number}) => ({
    x: p.x * scale + left,
    y: p.y * scale + top,
  }))[0];
  const aim = {x: target.x, y: target.y};
  assert.equal(gunTargetAt(aim.x, aim.y, [target]), target);
  const point = {x: (aim.x - left) / scale, y: (aim.y - top) / scale};
  hit(state, point);
  const rendered = drawing();
  state.impacts.draw(rendered.ctx, 'wall', state.damage.pose('wall'), 0);
  const [, , , , x, y] = rendered.transforms[0];
  assert.ok(Math.abs(x * scale + left - aim.x) < 1e-9);
  assert.ok(Math.abs(y * scale + top - aim.y) < 1e-9);
  assert.ok(rendered.colors.includes('#283431'), 'A dark bullet hole is drawn');
  assert.equal(rendered.clips.length, 1);
});

void test('bullet holes stay small after repeated hits and are clipped behind covering faces', () => {
  const state = model();
  const target = state.impacts.targets(identity)[0];
  for (let i = 0; i < 20; i++) hit(state, {x: target.x, y: target.y});
  const rendered = drawing();
  state.impacts.draw(rendered.ctx, 'wall', state.damage.pose('wall'), 0);
  assert.equal(
    rendered.transforms.length,
    1,
    'Repeated shots at the same point share a small hole',
  );
  // Clip paths describe the whole wall; mark drawing follows the transform.
  assert.ok(
    rendered.ink
      .slice(4)
      .every(([x, y]) => Math.abs(x) <= 5 && Math.abs(y) <= 5),
  );
  const cover = surface(
    [
      [target.x - 2, target.y - 2],
      [target.x + 2, target.y - 2],
      [target.x + 2, target.y + 2],
      [target.x - 2, target.y + 2],
    ],
    'metal',
  );
  state.impacts.setSurfaces('wall', [wall(), cover]);
  const covered = drawing();
  state.impacts.draw(covered.ctx, 'wall', state.damage.pose('wall'), 0);
  assert.ok(covered.clips.includes('evenodd'));
});

void test('damage repairs and session changes clear old bullet locations', () => {
  const state = model();
  hit(state);
  state.damage.tick(15);
  const restored = drawing();
  state.impacts.draw(restored.ctx, 'wall', state.damage.pose('wall'), 15);
  assert.equal(restored.transforms.length, 0);
  const target = state.impacts.targets(identity)[0];
  hit(state, {x: target.x + 8, y: target.y});
  const fresh = drawing();
  state.impacts.draw(fresh.ctx, 'wall', state.damage.pose('wall'), 15);
  assert.equal(fresh.transforms.length, 1);
  state.impacts.setSites(state.sites, 'other-session');
  state.impacts.setSurfaces('wall', [wall()]);
  const other = drawing();
  state.impacts.draw(other.ctx, 'wall', state.damage.pose('wall'), 0);
  assert.equal(other.transforms.length, 0);
});

void test('scorch is localized and independent of earlier bullet chips', () => {
  const state = model();
  const target = state.impacts.targets(identity)[0];
  hit(state, target);
  hit(state, {x: target.x + 15, y: target.y}, 'flame');
  const rendered = drawing();
  state.impacts.draw(rendered.ctx, 'wall', state.damage.pose('wall'), 0);
  assert.equal(rendered.transforms.length, 2);
  assert.ok(rendered.colors.includes('#283431'));
  assert.ok(rendered.colors.includes('#272b29'));
  assert.equal(
    rendered.ctx.globalAlpha,
    1,
    'Scorch opacity is scoped to its mark',
  );
});

void test('painted materials choose plaster chips, wood splinters, glass cracks and metal dents', () => {
  assert.equal(officeMaterial({kind: 'wall'}, '#dddac6'), 'plaster');
  assert.equal(officeMaterial({kind: 'wall'}, '#76a5b4'), 'glass');
  assert.equal(officeMaterial({kind: 'furniture'}, '#c7b58b'), 'wood');
  assert.equal(officeMaterial({kind: 'furniture'}, '#e3dfc6'), 'plastic');
  assert.equal(officeMaterial({kind: 'machinery'}, '#314c58'), 'metal');
  assert.equal(officeMaterial({kind: 'floor'}, '#83979c'), 'carpet');
  const marks: string[][] = [];
  for (const material of ['plaster', 'wood', 'glass', 'metal']) {
    const state = model([
      surface(
        [
          [0, 0],
          [40, 0],
          [40, 30],
          [0, 30],
        ],
        material,
      ),
    ]);
    hit(state);
    const rendered = drawing();
    state.impacts.draw(rendered.ctx, 'wall', state.damage.pose('wall'), 0);
    marks.push(rendered.colors);
  }
  assert.equal(new Set(marks.map(colors => JSON.stringify(colors))).size, 4);
});

void test('face changes discard stale impacts and storage is bounded during long sessions', () => {
  const state = model([
    surface(
      [
        [0, 0],
        [300, 0],
        [300, 40],
        [0, 40],
      ],
      'wood',
    ),
  ]);
  for (let i = 0; i < 100; i++) hit(state, {x: i * 2 + 1, y: 20});
  const rendered = drawing();
  state.impacts.draw(rendered.ctx, 'wall', state.damage.pose('wall'), 0);
  assert.equal(rendered.transforms.length, 32);
  state.impacts.setSites([{...state.sites[0], variant: 'queue'}], 'session');
  state.impacts.setSurfaces('wall', [floor()]);
  const replaced = drawing();
  state.impacts.draw(replaced.ctx, 'wall', state.damage.pose('wall'), 0);
  assert.equal(replaced.transforms.length, 0);
  assert.equal(state.impacts.contact('wall', {x: NaN, y: 0}), null);
  assert.equal(state.impacts.contact('missing'), null);
});

void test('visible polygon pieces remain targetable when their center is outside the canvas', () => {
  const target = {
    id: 'wall',
    x: -100,
    y: 20,
    radius: 200,
    polygon: [
      {x: -200, y: 0},
      {x: 20, y: 0},
      {x: 20, y: 40},
      {x: -200, y: 40},
    ],
  };
  const rect = {left: 0, top: 0, right: 100, bottom: 100};
  const viewport = {innerWidth: 100, innerHeight: 100};
  assert.equal(visibleSceneTargets([target], rect, viewport).length, 1);
  assert.equal(gunTargetAt(5, 20, [target]), target);
  for (const polygon of [
    [],
    [{x: 0, y: 0}],
    [
      {x: 0, y: 0},
      {x: 1, y: 1},
      {x: 2, y: 2},
    ],
    [
      {x: NaN, y: 0},
      {x: 20, y: 0},
      {x: 0, y: 20},
    ],
  ]) {
    assert.equal(gunTargetAt(0, 0, [{...target, polygon}]), null);
  }
});

void test('workstation face insertion and removal preserve the struck geometric surface', () => {
  const base = () =>
    surface(
      [
        [0, 0],
        [30, 0],
        [30, 20],
        [0, 20],
      ],
      'plastic',
    );
  const screen = () =>
    surface(
      [
        [40, 0],
        [60, 0],
        [60, 20],
        [40, 20],
      ],
      'plastic',
    );
  const keys = () =>
    surface(
      [
        [80, 0],
        [120, 0],
        [120, 20],
        [80, 20],
      ],
      'plastic',
    );
  const extraScreenRow = () =>
    surface(
      [
        [45, 5],
        [55, 5],
        [55, 7],
        [45, 7],
      ],
      'plastic',
    );
  const state = model([base(), screen(), keys()]);
  const point = {x: 100, y: 10};
  hit(state, point);
  for (const faces of [
    [base(), screen(), extraScreenRow(), keys()],
    [base(), screen(), keys()],
    [base(), screen(), extraScreenRow(), keys()],
  ]) {
    state.impacts.setSurfaces('wall', faces);
    const rendered = drawing();
    state.impacts.draw(rendered.ctx, 'wall', state.damage.pose('wall'), 0);
    assert.equal(rendered.transforms.length, 1);
    assert.deepEqual(rendered.transforms[0].slice(4), [point.x, point.y]);
  }
  state.impacts.setSurfaces('wall', [base(), screen(), extraScreenRow()]);
  const removed = drawing();
  state.impacts.draw(removed.ctx, 'wall', state.damage.pose('wall'), 0);
  assert.equal(
    removed.transforms.length,
    0,
    'A removed face cannot transfer its mark to another face',
  );
});
