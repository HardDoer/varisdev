import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  AWAKE_EYE_HEIGHT,
  relaxedIdlePose,
} from '../assets/dashboard/parent-activities.js';

void test('relaxed idle pose stays awake with naturally bent arms', () => {
  const pose = relaxedIdlePose(0, false);

  assert.ok(pose.eyeHeight > AWAKE_EYE_HEIGHT);
  assert.equal(pose.arms.length, 2);
  for (const arm of pose.arms) {
    assert.ok(arm.elbow[1] > arm.hand[1], 'elbow remains above the hand');
    assert.ok(arm.hand[1] > 1.1, 'hand does not hang in a shutdown pose');
  }
  assert.equal(pose.arms[0].elbow[2], -pose.arms[1].elbow[2]);
  assert.equal(pose.arms[0].hand[2], -pose.arms[1].hand[2]);
});

void test('relaxed idle breathing is gentle and Motion off is deterministic', () => {
  const samples = [0, 0.5, 1, 1.5, 2].map(time => relaxedIdlePose(time, true));

  for (const pose of samples) {
    assert.ok(pose.eyeHeight >= AWAKE_EYE_HEIGHT);
    assert.ok(Math.abs(pose.lift) <= 0.018);
    assert.ok(
      [
        pose.breath,
        pose.lift,
        pose.eyeHeight,
        ...pose.arms.flatMap(arm => [...arm.elbow, ...arm.hand]),
      ].every(Number.isFinite),
    );
  }
  assert.ok(new Set(samples.map(pose => pose.lift)).size > 1);
  assert.ok(new Set(samples.map(pose => pose.arms[0].hand[0])).size > 1);
  assert.deepEqual(relaxedIdlePose(0, false), relaxedIdlePose(200, false));
});
