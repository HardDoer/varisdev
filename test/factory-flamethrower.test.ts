import assert from 'node:assert/strict';
import {test} from 'node:test';
import {flameTargetsAt} from '../assets/dashboard/factory-flamethrower.js';

void test('flame jet ignites multiple robots along its widening path', () => {
  const muzzle = {x: 100, y: 100};
  const aim = {x: 0, y: 100};
  const front = {id: 'parent', x: 10, y: 110, radius: 10};
  const middle = {id: 'drone', x: 50, y: 100, radius: 5};
  const outside = {id: 'outside', x: 50, y: 130, radius: 5};
  const behind = {id: 'behind', x: 120, y: 100, radius: 10};
  const distant = {id: 'far', x: -40, y: 100, radius: 10};
  const targets = [front, middle, outside, behind, distant];
  targets.forEach(Object.freeze);
  Object.freeze(targets);
  assert.deepEqual(flameTargetsAt(muzzle, aim, targets), [front, middle]);
  assert.deepEqual(flameTargetsAt(aim, muzzle, targets), [front, middle]);
  assert.deepEqual(
    flameTargetsAt({x: 300, y: 0}, {x: 300, y: 200}, targets),
    [],
  );
});

void test('flame spread respects robot edges and follows rotated aim', () => {
  const muzzle = {x: 30, y: 10};
  const aim = {x: 30, y: 110};
  const edge = {id: 'edge', x: 60, y: 110, radius: 5};
  const outside = {...edge, id: 'outside', x: 60.01};
  assert.deepEqual(flameTargetsAt(muzzle, aim, [edge, outside]), [edge]);
  assert.deepEqual(flameTargetsAt(aim, aim, [edge]), []);
});

void test('invalid flame input cannot hit robots or hide valid targets', () => {
  const target = {id: 'valid', x: 0, y: 0, radius: 20};
  const muzzle = {x: 80, y: 60};
  const aim = {x: 0, y: 0};
  const hit = flameTargetsAt as (
    muzzle: unknown,
    aim: unknown,
    targets?: unknown,
  ) => unknown[];
  for (const point of [null, {}, {x: NaN, y: 0}, {x: 0, y: Infinity}]) {
    assert.deepEqual(hit(point, aim, [target]), []);
    assert.deepEqual(hit(muzzle, point, [target]), []);
  }
  for (const invalid of [null, {}, 'robots'])
    assert.deepEqual(hit(muzzle, aim, invalid), []);
  assert.deepEqual(
    hit(muzzle, aim, [
      null,
      {},
      {...target, radius: -1},
      {...target, id: ''},
      {...target, x: NaN},
      target,
    ]),
    [target],
  );
});
