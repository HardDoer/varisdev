import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sortOfficeObjects} from '../assets/dashboard/year1998-geometry.js';

void test('office depth uses furniture footprints when center depth reverses occlusion', () => {
  const desk = {id: 'desk', x: 0, z: 0, w: 4, d: 2};
  const chair = {id: 'chair', x: 1.7, z: -1.6, w: 0.8, d: 0.8};
  const robot = {id: 'robot', x: -1.8, z: 1.5, w: 0.5, d: 0.5};
  for (const objects of [
    [desk, chair, robot],
    [robot, desk, chair],
    [chair, robot, desk],
  ]) {
    assert.deepEqual(
      sortOfficeObjects(objects).map(item => item.id),
      ['chair', 'desk', 'robot'],
    );
    // The same occlusion applies along the perpendicular room wall.
    assert.deepEqual(
      sortOfficeObjects(
        objects.map(item => ({
          ...item,
          x: item.z,
          z: item.x,
          w: item.d,
          d: item.w,
        })),
      ).map(item => item.id),
      ['chair', 'desk', 'robot'],
    );
  }
});

void test('crossing visitors retain a stable order without losing scene objects', () => {
  const objects = [
    {id: 'visitor', x: 0.1, z: 0.1, w: 0.8, d: 0.8},
    {id: 'parent', x: 0, z: 0, w: 0.8, d: 0.8},
    {id: 'cabinet', x: -3, z: -4, w: 1.2, d: 0.75},
    {id: 'plant', x: -4, z: 3, w: 0.56, d: 0.56},
  ];
  const ordered = sortOfficeObjects(objects).map(item => item.id);
  assert.deepEqual(ordered, ['cabinet', 'plant', 'parent', 'visitor']);
  assert.deepEqual(
    sortOfficeObjects([...objects].reverse()).map(item => item.id),
    ordered,
  );
  assert.equal(objects[0].id, 'visitor');
});
