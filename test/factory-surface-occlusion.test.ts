import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  createCaneSwing,
  canePoints,
  caneSweepContact,
} from '../assets/dashboard/factory-cane.js';
import {flameTargetsAt} from '../assets/dashboard/factory-flamethrower.js';
import {
  polygonOcclusion,
  sceneTargetContains,
} from '../assets/dashboard/factory-targets.js';

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

void test('flame hits exposed scenery and skips floor fully hidden by earlier faces', () => {
  const desk = face('desk', 60, -10, 110, 10);
  const floor = {...desk, id: 'floor'};
  const separate = face('separate', 80, 15, 90, 20);
  assert.deepEqual(
    flameTargetsAt({x: 0, y: 0}, {x: 100, y: 0}, [desk, floor, separate]),
    [desk, separate],
  );
  const left = face('left', 60, -10, 85, 10),
    right = face('right', 85, -10, 110, 10);
  assert.deepEqual(
    flameTargetsAt({x: 0, y: 0}, {x: 100, y: 0}, [left, right, floor]),
    [left, right],
  );
});

void test('flame finds an exposed part when the preferred contact is under a desk', () => {
  const desk = face('desk', 90, -5, 110, 5),
    floor = face('floor', 80, -15, 120, 15);
  const contacts = new Map();
  assert.deepEqual(
    flameTargetsAt({x: 0, y: 0}, {x: 100, y: 0}, [desk, floor], contacts),
    [desk, floor],
  );
  const at = contacts.get(floor);
  assert.ok(at);
  assert.equal(sceneTargetContains(floor, at.x, at.y), true);
  assert.equal(sceneTargetContains(desk, at.x, at.y), false);
});

void test('cane skips hidden floor, keeps separate objects and reports an exposed partial contact', () => {
  const desk = face('desk', 180, 130, 220, 170),
    floor = {...desk, id: 'floor'};
  const separate = face('separate', 250, 130, 270, 170);
  const swing = createCaneSwing();
  swing.move(100, 200, 0, [desk, floor, separate], false);
  assert.deepEqual(
    swing
      .move(300, 200, 30, [desk, floor, separate], false)
      .hits.map(t => t.id),
    ['desk', 'separate'],
  );
  const partial = face('floor', 170, 120, 230, 180);
  const before = canePoints(100, 200, 0),
    after = canePoints(300, 200, 0);
  const first = caneSweepContact(before, after, partial);
  assert.ok(first);
  const cover = face(
    'cover',
    first.x - 2,
    first.y - 2,
    first.x + 2,
    first.y + 2,
  );
  const contact = caneSweepContact(before, after, partial, [cover.polygon]);
  assert.ok(contact);
  assert.equal(sceneTargetContains(partial, contact.x, contact.y), true);
  assert.equal(sceneTargetContains(cover, contact.x, contact.y), false);
});

void test('occluding faces still cover scenery while their cane hit is on cooldown', () => {
  const desk = face('desk', 180, 130, 220, 170),
    hidden = {...desk, id: 'hidden'};
  const swing = createCaneSwing();
  swing.move(100, 200, 0, [desk], false);
  assert.deepEqual(
    swing.move(300, 200, 30, [desk], false).hits.map(t => t.id),
    ['desk'],
  );
  assert.equal(swing.move(100, 200, 60, [desk, hidden], false).hits.length, 0);
});

void test('polygon scenery occlusion leaves circular robot selection and overlaps unchanged', () => {
  const polygon = face('desk', 60, -10, 110, 10);
  const circle = {id: 'robot', x: 90, y: 0, radius: 10};
  assert.deepEqual(
    flameTargetsAt({x: 0, y: 0}, {x: 100, y: 0}, [circle, polygon]),
    [circle, polygon],
  );
  assert.deepEqual(
    flameTargetsAt({x: 0, y: 0}, {x: 100, y: 0}, [polygon, circle]),
    [polygon, circle],
  );
  const targets = [
    face('desk', 180, 130, 220, 170),
    {id: 'robot', x: 200, y: 150, radius: 10},
  ];
  const swing = createCaneSwing();
  swing.move(100, 200, 0, targets, false);
  assert.deepEqual(
    swing.move(300, 200, 30, targets, false).hits.map(t => t.id),
    ['desk', 'robot'],
  );
});

void test('coverage index bounds distant office faces before contact clipping', () => {
  const targets = Array.from({length: 500}, (_, i) =>
    face(
      String(i),
      (i % 25) * 32,
      Math.floor(i / 25) * 32,
      (i % 25) * 32 + 24,
      Math.floor(i / 25) * 32 + 24,
    ),
  );
  const covered = {...targets[0], id: 'covered'};
  const occlusion = polygonOcclusion([...targets, covered]);
  assert.equal(occlusion.size, 501);
  for (const target of targets) assert.deepEqual(occlusion.get(target), []);
  assert.deepEqual(occlusion.get(covered), [targets[0].polygon]);
});
