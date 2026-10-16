import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  canePoints,
  caneSweepHits,
  createCaneSwing,
} from '../assets/dashboard/factory-cane.js';

void test('the cane shaft and hook sweep through targets between pointer events', () => {
  const before = canePoints(100, 200, 0);
  const after = canePoints(300, 200, 0);
  assert.equal(
    caneSweepHits(before, after, {x: 200, y: 150, radius: 10}),
    true,
  );
  assert.equal(caneSweepHits(before, after, {x: 200, y: 90, radius: 10}), true);
  assert.equal(
    caneSweepHits(before, after, {x: 200, y: 50, radius: 10}),
    false,
  );
  assert.equal(
    caneSweepHits(before, after, {x: 200, y: 250, radius: 10}),
    false,
  );
  assert.equal(
    caneSweepHits(before, before, {x: 100, y: 150, radius: 10}),
    true,
  );
  assert.equal(
    caneSweepHits(before, before, {x: 100, y: 350, radius: 10}),
    false,
  );
});

void test('the hook has its own collision area and rotated poses remain finite', () => {
  const points = canePoints(100, 200, 0);
  assert.equal(
    caneSweepHits(points, points, {x: 124, y: 117, radius: 1}),
    true,
  );
  assert.equal(
    caneSweepHits(points, points, {x: 142, y: 117, radius: 1}),
    false,
  );
  for (const angle of [-Math.PI, -1, 0, 1, Math.PI]) {
    assert.equal(canePoints(0, 0, angle).flat().every(Number.isFinite), true);
  }
});

void test('picking up, hovering and slow movement do not hit; waving does', () => {
  const swing = createCaneSwing();
  const targets = [{id: 'parent', x: 200, y: 150, radius: 15}];
  assert.deepEqual(swing.move(100, 200, 0, targets).hits, []);
  assert.deepEqual(swing.move(100, 200, 16, targets).hits, []);
  assert.deepEqual(swing.move(101, 200, 32, targets).hits, []);
  const result = swing.move(300, 200, 64, targets);
  assert.deepEqual(
    result.hits.map(target => target.id),
    ['parent'],
  );
  assert.equal(result.direction, 1);
});

void test('fast sweeps hit both parent and drones with independent cooldowns', () => {
  const swing = createCaneSwing();
  const targets = [
    {id: 'parent', x: 200, y: 150, radius: 15},
    {id: 'drone', x: 300, y: 150, radius: 12},
  ];
  swing.move(80, 200, 0, targets, false);
  assert.deepEqual(
    swing.move(430, 200, 30, targets, false).hits.map(t => t.id),
    ['parent', 'drone'],
  );
  assert.deepEqual(swing.move(80, 200, 60, targets, false).hits, []);
  swing.move(80, 200, 200, targets, false);
  swing.move(80, 200, 340, targets, false);
  assert.deepEqual(
    swing.move(430, 200, 370, targets, false).hits.map(t => t.id),
    ['parent', 'drone'],
  );
});

void test('idle gaps and resetting on leave cannot turn reentry into a strike', () => {
  const swing = createCaneSwing();
  const targets = [{id: 'parent', x: 200, y: 150, radius: 15}];
  swing.move(100, 200, 0, targets);
  assert.deepEqual(swing.move(400, 200, 500, targets).hits, []);
  swing.reset();
  assert.deepEqual(swing.move(100, 200, 516, targets).hits, []);
  assert.equal(swing.move(400, 200, 532, targets).hits.length, 1);
});

void test('motion off keeps a rigid mouse-controlled cane but still detects hits', () => {
  const swing = createCaneSwing();
  const targets = [{id: 'drone', x: 200, y: 150, radius: 15}];
  swing.move(400, 200, 0, targets, false);
  const result = swing.move(100, 200, 16, targets, false);
  assert.equal(result.angle, -0.3);
  assert.equal(result.direction, -1);
  assert.deepEqual(
    result.hits.map(t => t.id),
    ['drone'],
  );
});

void test('swing strength increases with speed, not distance or event frequency', () => {
  const target = {id: 'parent', x: 200, y: 150, radius: 15};
  const wave = (distance: number, dt: number) => {
    const swing = createCaneSwing();
    swing.move(100, 200, 0, [target]);
    return swing.move(100 + distance, 200, dt, [target]);
  };
  const gentle = wave(200, 160);
  const fast = wave(200, 20);
  assert.equal(gentle.hits.length, 1);
  assert.equal(fast.hits.length, 1);
  assert.ok(fast.strength > gentle.strength * 2);
  assert.equal(fast.strength, 2.2, 'Extreme speeds must remain bounded');
  assert.equal(wave(100, 80).strength, gentle.strength);
  assert.equal(wave(1, 100).strength, 0.35);
});

void test('invalid coordinates and non-increasing timestamps cannot strike', () => {
  const swing = createCaneSwing();
  const targets = [{id: 'parent', x: 200, y: 150, radius: 15}];
  swing.move(100, 200, 10, targets);
  assert.deepEqual(swing.move(400, 200, 10, targets).hits, []);
  assert.deepEqual(swing.move(100, 200, 5, targets).hits, []);
  assert.deepEqual(swing.move(NaN, 200, 20, targets).hits, []);
  assert.deepEqual(swing.move(400, 200, 30, targets).hits, []);
});
