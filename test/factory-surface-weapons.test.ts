import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  canePoints,
  caneSweepContact,
  caneSweepHits,
  createCaneSwing,
} from '../assets/dashboard/factory-cane.js';
import {
  flameTargetsAt,
  flameTargetContact,
} from '../assets/dashboard/factory-flamethrower.js';
import {sceneTargetContains} from '../assets/dashboard/factory-targets.js';

function face(
  id: string,
  left: number,
  top: number,
  right: number,
  bottom: number,
) {
  return {
    id,
    x: (left + right) / 2,
    y: (top + bottom) / 2,
    radius: Math.hypot(right - left, bottom - top) / 2,
    polygon: [
      {x: left, y: top},
      {x: right, y: top},
      {x: right, y: bottom},
      {x: left, y: bottom},
    ],
  };
}

void test('flame cone touches actual wall faces without hitting their large surrounding circles', () => {
  const muzzle = {x: 0, y: 0},
    aim = {x: 100, y: 0};
  const wall = face('wall', -100, 50, 300, 55);
  const near = face('near', 50, -3, 70, 3);
  const behind = face('behind', -10, -1, -1, 1);
  const beyond = face('beyond', 101, -1, 200, 1);
  assert.deepEqual(flameTargetsAt(muzzle, aim, [wall, near, behind, beyond]), [
    near,
  ]);
  const contact = flameTargetContact(muzzle, aim, near);
  assert.ok(contact);
  assert.equal(sceneTargetContains(near, contact.x, contact.y), true);
  const atAim = face('aim', 95, -5, 105, 5);
  assert.deepEqual(flameTargetContact(muzzle, aim, atAim), aim);
});

void test('polygon flame contacts follow rotated cone edges and stop at its tip', () => {
  const muzzle = {x: 0, y: 0},
    aim = {x: 100, y: 0};
  const edge = face('edge', 100, 25, 110, 26);
  const outside = face('outside', 100, 25.01, 110, 26);
  assert.deepEqual(flameTargetsAt(muzzle, aim, [edge, outside]), [edge]);
  const rotate = (p: {x: number; y: number}) => ({x: -p.y, y: p.x});
  const rotated = [edge, outside].map(target => ({
    ...target,
    ...rotate(target),
    polygon: target.polygon.map(rotate),
  }));
  assert.deepEqual(flameTargetsAt(rotate(muzzle), rotate(aim), rotated), [
    rotated[0],
  ]);
  assert.deepEqual(flameTargetsAt(aim, aim, [edge]), []);
});

void test('cane sweep hits a narrow face between events and reports a point on the struck surface', () => {
  const before = canePoints(100, 200, 0),
    after = canePoints(300, 200, 0);
  const thin = face('thin', 199, 130, 201, 180);
  const distant = face('distant', -100, 260, 500, 270);
  assert.equal(caneSweepHits(before, after, thin), true);
  assert.equal(caneSweepHits(before, after, distant), false);
  const contact = caneSweepContact(before, after, thin);
  assert.ok(contact);
  assert.equal(sceneTargetContains(thin, contact.x, contact.y), true);
  assert.equal(
    caneSweepHits(before, after, {...distant, polygon: undefined}),
    true,
    'Existing circular target geometry remains available',
  );
});

void test('polygon cane collision includes shaft thickness and crook without an oversized margin', () => {
  const points = canePoints(100, 200, 0);
  const edge = face('edge', 104, 150, 105, 160);
  const outside = face('outside', 104.01, 150, 105, 160);
  assert.equal(caneSweepHits(points, points, edge), true);
  assert.equal(caneSweepHits(points, points, outside), false);
  const hook = face('hook', 123, 115, 125, 118);
  assert.equal(caneSweepHits(points, points, hook), true);
  const contact = caneSweepContact(points, points, hook);
  assert.ok(contact);
  assert.equal(sceneTargetContains(hook, contact.x, contact.y), true);
});

void test('several painted faces of one object share cane cooldown and return one contact', () => {
  const swing = createCaneSwing();
  const targets = [
    face('desk', 190, 130, 210, 150),
    face('desk', 190, 150, 210, 180),
  ];
  const original = JSON.stringify(targets);
  swing.move(100, 200, 0, targets, false);
  const result = swing.move(300, 200, 30, targets, false);
  assert.equal(result.hits.length, 1);
  assert.ok(result.hits[0].contact);
  assert.equal(
    sceneTargetContains(
      result.hits[0],
      result.hits[0].contact.x,
      result.hits[0].contact.y,
    ),
    true,
  );
  assert.equal(swing.move(100, 200, 60, targets, false).hits.length, 0);
  assert.equal(
    JSON.stringify(targets),
    original,
    'Collision does not mutate supplied targets',
  );
});
