import assert from 'node:assert/strict';
import {test} from 'node:test';
import {gunTargetAt} from '../assets/dashboard/factory-gun.js';

void test('gun aim hits a body edge without adding an invisible hit margin', () => {
  const robot = {id: 'parent', x: 100, y: 80, radius: 20};
  assert.equal(gunTargetAt(100, 80, [robot]), robot);
  assert.equal(gunTargetAt(112, 96, [robot]), robot);
  assert.equal(gunTargetAt(120.01, 80, [robot]), null);
  assert.equal(gunTargetAt(100, 59.99, [robot]), null);
  assert.equal(gunTargetAt(0, 0), null);
});

void test('one shot chooses the nearest containing robot or drone', () => {
  const robot = {id: 'parent', x: 100, y: 100, radius: 100};
  const drone = {id: 'drone', x: 130, y: 140, radius: 20};
  const outside = {id: 'outside', x: 129, y: 140, radius: 0.5};
  assert.equal(gunTargetAt(130, 140, [robot, drone]), drone);
  assert.equal(gunTargetAt(130, 140, [drone, robot]), drone);
  assert.equal(gunTargetAt(130, 140, [outside, robot]), robot);
  assert.equal(gunTargetAt(210, 210, [robot, drone]), null);
});

void test('equal aim distances keep the first target and preserve input objects', () => {
  const first = Object.freeze({id: 'parent', x: -5, y: 0, radius: 10});
  const second = Object.freeze({id: 'drone', x: 5, y: 0, radius: 10});
  const targets = [first, second];
  Object.freeze(targets);
  const snapshot = JSON.stringify(targets);
  assert.equal(gunTargetAt(0, 0, targets), first);
  assert.equal(gunTargetAt(0, 0, [second, first]), second);
  assert.equal(JSON.stringify(targets), snapshot);
});

void test('malformed targets cannot hide a valid target or become a hit', () => {
  const at = gunTargetAt as (
    x: unknown,
    y: unknown,
    targets?: unknown,
  ) => unknown;
  const valid = {id: 0, x: 0, y: 0, radius: 5};
  const invalid = [
    null,
    undefined,
    {},
    {id: '', x: 0, y: 0, radius: 5},
    {id: NaN, x: 0, y: 0, radius: 5},
    {id: 'nan', x: NaN, y: 0, radius: 5},
    {id: 'infinite', x: 0, y: Infinity, radius: 5},
    {id: 'radius', x: 0, y: 0, radius: Infinity},
    {id: 'negative', x: 0, y: 0, radius: -1},
    {id: 'zero', x: 0, y: 0, radius: 0},
    {id: 'string', x: '0', y: 0, radius: 5},
  ];
  assert.equal(at(0, 0, invalid), null);
  assert.equal(at(0, 0, [...invalid, valid]), valid);
  for (const targets of [null, {}, 'targets'])
    assert.equal(at(0, 0, targets), null);
});

void test('non-finite pointer coordinates cannot produce a target', () => {
  const targets = [{id: 'parent', x: 0, y: 0, radius: 20}];
  for (const [x, y] of [
    [NaN, 0],
    [0, NaN],
    [Infinity, 0],
    [0, -Infinity],
  ])
    assert.equal(gunTargetAt(x, y, targets), null);
});
