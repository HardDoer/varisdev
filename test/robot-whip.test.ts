import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  createRobotWhip,
  whipPose,
  WHIP_SECONDS,
} from '../assets/dashboard/robot-whip.js';

void test('whip waits 20–45 seconds, chooses a supplied visible worker, and finishes once', () => {
  // Minimum cadence, then the last visible target, then maximum cadence.
  const values = [0, 0, 0.99, 1];
  const whip = createRobotWhip(() => values.shift() ?? 1);
  whip.update('parent', ['visible-a', 'visible-b']);
  whip.tick(19.9);
  assert.equal(whip.pose(), null);
  whip.update('parent', ['visible-a', 'visible-b']);
  whip.tick(0.11);
  assert.equal(whip.pose()?.target, 'visible-b');
  whip.tick(0.7);
  assert.ok(whipPose(whip.pose()!.age).recoil > 0);
  whip.tick(WHIP_SECONDS);
  assert.equal(whip.pose(), null);
  whip.tick(44.9);
  assert.equal(whip.pose(), null);
  whip.tick(0.11);
  assert.ok(whip.pose());
});

void test('snapshots and repeated selection do not start or replay a lash', () => {
  const whip = createRobotWhip(() => 0);
  for (let i = 0; i < 200; i++) whip.update('parent', ['worker']);
  assert.equal(whip.pose(), null);
  whip.tick(20);
  whip.tick(0.5);
  const current = whip.pose();
  for (let i = 0; i < 200; i++) whip.update('parent', ['worker']);
  assert.deepEqual(whip.pose(), current);
});

void test('stop, prompt, target removal, Motion off, session switching and disposal cancel cleanly', () => {
  for (const reason of [
    'interrupt',
    'target',
    'motion',
    'session',
    'cancel',
    'dispose',
  ]) {
    const whip = createRobotWhip(() => 0);
    whip.update('parent', ['worker']);
    whip.tick(20);
    assert.ok(whip.pose());
    if (reason === 'interrupt') whip.update('parent', ['worker'], true);
    if (reason === 'target') whip.update('parent', []);
    if (reason === 'motion') whip.setMotion(false);
    if (reason === 'session') whip.update('other', ['worker']);
    if (reason === 'cancel') whip.cancel();
    if (reason === 'dispose') whip.dispose();
    assert.equal(whip.pose(), null, reason);
    whip.tick(1);
    assert.equal(whip.pose(), null, reason);
  }
});

void test('no eligible workers and prompt/idle activity blocking pause the cadence; reenable waits', () => {
  const whip = createRobotWhip(() => 0);
  whip.update('parent', []);
  whip.tick(100);
  assert.equal(whip.pose(), null);
  whip.update('parent', ['worker'], true);
  whip.tick(100);
  assert.equal(whip.pose(), null);
  whip.update('parent', ['worker']);
  whip.tick(19);
  assert.equal(whip.pose(), null);
  whip.setMotion(false);
  whip.tick(100);
  whip.setMotion(true);
  whip.tick(19);
  assert.equal(whip.pose(), null);
  whip.tick(1.01);
  assert.ok(whip.pose());
});
