import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  createParentMotion,
  IDLE_ACTIVITIES,
} from '../assets/dashboard/parent-motion.js';

type Controller = ReturnType<typeof createParentMotion>;
const HOME = -6.25;

function advance(controller: Controller, seconds: number) {
  for (let time = 0; time < seconds; time += 1 / 60) controller.tick(1 / 60);
}

function until(
  controller: Controller,
  condition: () => boolean,
  maximumSeconds = 70,
) {
  for (let frame = 0; frame < maximumSeconds * 60; frame++) {
    if (condition()) return;
    controller.tick(1 / 60);
  }
  assert.ok(
    condition(),
    `condition timed out: ${JSON.stringify(controller.pose())}`,
  );
}

function idleController(id = 'parent-one') {
  const controller = createParentMotion();
  controller.update({id, status: 'idle'});
  return controller;
}

function waitAtRest(controller: Controller) {
  const pose = controller.pose();
  assert.equal(pose.mode, 'rest');
  assert.equal(pose.activity, null);
  assert.equal(pose.stride, 0);
  advance(controller, 14.9);
  assert.deepEqual({...controller.pose(), elapsed: pose.elapsed}, pose);
  until(controller, () => controller.pose().mode === 'walk', 45.2);
}

void test('idle visits all twelve activities with 15–60 second pauses between walks', () => {
  assert.deepEqual(IDLE_ACTIVITIES, [
    'coffee',
    'jump-rope',
    'juggle',
    'dance',
    'stretch',
    'weights',
    'hula-hoop',
    'yo-yo',
    'read',
    'sweep',
    'balance',
    'paper-plane',
  ]);
  const controller = idleController();
  waitAtRest(controller);
  const activities: string[] = [];
  let previousX = HOME;
  for (let index = 0; index < 24; index++) {
    until(controller, () => controller.pose().mode === 'idle');
    const pose = controller.pose();
    assert.ok(pose.activity);
    activities.push(pose.activity);
    assert.ok(pose.x >= -3 && pose.x <= 6.5);
    assert.equal(pose.z, 0);
    assert.ok(Math.abs(pose.x - previousX) >= 1.5);
    assert.ok(pose.duration >= 5 && pose.duration <= 8);
    assert.ok(pose.elapsed < 1 / 60);
    assert.equal(pose.ground, -0.4);
    previousX = pose.x;
    advance(controller, 4.9);
    assert.equal(controller.pose().mode, 'idle');
    until(controller, () => controller.pose().mode === 'rest', 4);
    assert.equal(controller.pose().x, pose.x);
    assert.equal(controller.pose().duration, 0);
    waitAtRest(controller);
  }
  for (const start of [0, 12]) {
    assert.deepEqual(
      [...new Set(activities.slice(start, start + 12))].sort(),
      [...IDLE_ACTIVITIES].sort(),
    );
  }
  assert.notEqual(activities[11], activities[12]);
});

void test('standing in the aisle stays still through updates and wakes immediately for work', () => {
  const controller = idleController();
  until(controller, () => controller.pose().mode === 'idle');
  until(controller, () => controller.pose().mode === 'rest', 9);
  const standing = controller.pose();
  assert.notEqual(standing.x, HOME);
  for (let second = 0; second < 14; second++) {
    advance(controller, 1);
    controller.update({id: 'parent-one', status: 'idle'});
    assert.deepEqual(
      {...controller.pose(), elapsed: standing.elapsed},
      standing,
    );
  }
  controller.prompt();
  assert.equal(controller.pose().mode, 'startled');
  assert.equal(controller.pose().x, standing.x);
  assert.equal(controller.pose().surprise, 1);
  controller.update({id: 'parent-one', status: 'running'});
  until(controller, () => controller.pose().mode === 'work', 5);
  assert.equal(controller.pose().x, HOME);
  controller.update({id: 'parent-one', status: 'idle'});
  waitAtRest(controller);
});

void test('prompt during roaming jumps without teleporting, then returns quickly and faces home', () => {
  const controller = idleController();
  until(controller, () => controller.pose().x > HOME + 2);
  const before = controller.pose();
  assert.equal(before.mode, 'walk');
  controller.prompt();
  assert.equal(controller.pose().mode, 'startled');
  assert.equal(controller.pose().x, before.x);
  assert.equal(controller.pose().yaw, before.yaw);
  assert.equal(controller.pose().surprise, 1);
  advance(controller, 0.3);
  assert.ok(controller.pose().jump > 0.75);
  const startled = controller.pose();
  controller.prompt();
  assert.deepEqual(controller.pose(), startled);
  until(controller, () => controller.pose().mode === 'return', 0.5);
  assert.equal(controller.pose().jump, 0);
  let last = controller.pose();
  let maximumStep = 0;
  until(
    controller,
    () => {
      const current = controller.pose();
      const step = Math.abs(current.x - last.x);
      maximumStep = Math.max(maximumStep, step);
      assert.ok(step <= 5 / 60 + 1e-8);
      assert.ok(Math.abs(current.ground - last.ground) < 0.09);
      const yawStep = Math.atan2(
        Math.sin(current.yaw - last.yaw),
        Math.cos(current.yaw - last.yaw),
      );
      assert.ok(Math.abs(yawStep) < 0.5);
      last = current;
      return current.mode === 'rest';
    },
    4,
  );
  assert.ok(maximumStep > 4.9 / 60);
  assert.equal(last.x, HOME);
  assert.equal(last.yaw, 0);
  assert.equal(last.ground, 0);
  waitAtRest(controller);
});

void test('running snapshots do not restart the wake and an early completion still finishes returning', () => {
  const controller = idleController();
  until(controller, () => controller.pose().mode === 'idle');
  controller.update({id: 'parent-one', status: 'running'});
  advance(controller, 0.25);
  const pose = controller.pose();
  controller.update({id: 'parent-one', status: 'running'});
  controller.prompt();
  assert.deepEqual(controller.pose(), pose);
  until(controller, () => controller.pose().mode === 'return');
  advance(controller, 0.15);
  const returning = controller.pose();
  controller.update({id: 'parent-one', status: 'compacting'});
  assert.deepEqual(controller.pose(), returning);
  controller.update({id: 'parent-one', status: 'idle'});
  assert.deepEqual(controller.pose(), returning);
  until(controller, () => controller.pose().mode === 'rest');
  assert.equal(controller.pose().x, HOME);
  waitAtRest(controller);
});

void test('running work resumes at home and initial active snapshots never startle', () => {
  for (const status of ['running', 'compacting']) {
    const controller = createParentMotion();
    controller.update({id: 'active', status});
    assert.equal(controller.pose().mode, 'work');
    advance(controller, 10);
    assert.equal(controller.pose().x, HOME);
    assert.equal(controller.pose().jump, 0);
  }
  const controller = idleController();
  until(controller, () => controller.pose().mode === 'idle');
  controller.prompt();
  until(controller, () => controller.pose().mode === 'return');
  const pose = controller.pose();
  controller.update({id: 'parent-one', status: 'running'});
  assert.deepEqual(controller.pose(), pose);
  until(controller, () => controller.pose().mode === 'work');
  assert.equal(controller.pose().x, HOME);
  advance(controller, 6);
  assert.equal(controller.pose().mode, 'work');
});

void test('a delayed run starts at the workstation without repeating the prompt reaction', () => {
  const controller = idleController();
  until(controller, () => controller.pose().mode === 'idle');
  controller.prompt();
  until(controller, () => controller.pose().mode === 'rest');
  controller.update({id: 'parent-one', status: 'running'});
  assert.equal(controller.pose().mode, 'work');
  assert.equal(controller.pose().jump, 0);
  controller.update({id: 'parent-one', status: 'closed'});
  advance(controller, 10);
  controller.prompt();
  assert.equal(controller.pose().mode, 'rest');
  assert.equal(controller.pose().x, HOME);
});

void test('a rejected prompt releases its hold and repeated idle updates preserve activities', () => {
  const controller = idleController();
  until(controller, () => controller.pose().mode === 'idle');
  advance(controller, 1);
  const pose = controller.pose();
  controller.update({id: 'parent-one', status: 'idle'});
  assert.deepEqual(controller.pose(), pose);
  controller.prompt();
  controller.cancelPrompt();
  until(controller, () => controller.pose().mode === 'rest');
  waitAtRest(controller);
  controller.prompt();
  until(controller, () => controller.pose().mode === 'rest');
  controller.cancelPrompt();
  waitAtRest(controller);
});

void test('session changes reset position, wake state, and the deterministic shuffle', () => {
  const controller = idleController();
  until(controller, () => controller.pose().mode === 'idle');
  controller.prompt();
  advance(controller, 0.3);
  controller.update({id: 'other-parent', status: 'running'});
  assert.equal(controller.pose().mode, 'work');
  assert.equal(controller.pose().x, HOME);
  assert.equal(controller.pose().jump, 0);
  controller.update({id: 'parent-one', status: 'idle'});
  const fresh = idleController();
  for (let frame = 0; frame < 60 * 160; frame++) {
    controller.tick(1 / 60);
    fresh.tick(1 / 60);
    assert.deepEqual(controller.pose(), fresh.pose());
  }
});

void test('stop rests at home for the reaction, then respects the latest status', () => {
  const controller = idleController();
  until(controller, () => controller.pose().mode === 'idle');
  controller.prompt();
  controller.setMotion(false);
  controller.stop();
  controller.setMotion(true);
  assert.equal(controller.pose().mode, 'rest');
  assert.equal(controller.pose().x, HOME);
  assert.equal(controller.pose().jump, 0);
  advance(controller, 2.6);
  assert.equal(controller.pose().mode, 'rest');
  waitAtRest(controller);
  controller.update({id: 'parent-one', status: 'running'});
  controller.stop();
  advance(controller, 2.4);
  assert.equal(controller.pose().mode, 'rest');
  until(controller, () => controller.pose().mode === 'work', 0.2);
  controller.update({id: 'parent-one', status: 'idle'});
  controller.stop();
  controller.prompt();
  assert.equal(controller.pose().mode, 'startled');
});

void test('motion preference immediately settles and reenable respects status', () => {
  const controller = idleController();
  until(controller, () => controller.pose().mode === 'idle');
  controller.prompt();
  advance(controller, 0.3);
  controller.setMotion(false);
  const still = controller.pose();
  assert.equal(still.mode, 'rest');
  assert.equal(still.x, HOME);
  assert.equal(still.activity, null);
  assert.equal(still.duration, 0);
  assert.equal(still.jump, 0);
  assert.equal(still.surprise, 0);
  assert.equal(still.stride, 0);
  controller.prompt();
  advance(controller, 20);
  assert.deepEqual(controller.pose(), still);
  controller.update({id: 'parent-one', status: 'running'});
  assert.equal(controller.pose().mode, 'work');
  controller.setMotion(true);
  advance(controller, 1);
  assert.equal(controller.pose().mode, 'work');
  controller.setMotion(false);
  controller.update({id: 'parent-one', status: 'idle'});
  controller.setMotion(true);
  waitAtRest(controller);
});

void test('offsite visits hide local motion and reappear settled at the workstation', () => {
  const controller = idleController();
  until(controller, () => controller.pose().mode === 'walk');
  controller.setAway(true);
  const away = controller.pose();
  assert.equal(away.mode, 'rest');
  assert.equal(away.x, HOME);
  advance(controller, 120);
  controller.prompt();
  assert.deepEqual(controller.pose(), away);
  controller.update({id: 'parent-one', status: 'running'});
  assert.equal(controller.pose().x, HOME);
  controller.setAway(false);
  assert.equal(controller.pose().mode, 'work');
  assert.equal(controller.pose().x, HOME);
});

void test('invalid deltas are ignored, long gaps are bounded, and disposal freezes the controller', () => {
  const controller = idleController();
  const initial = controller.pose();
  for (const dt of [NaN, Infinity, -Infinity, -1, 0]) controller.tick(dt);
  assert.deepEqual(controller.pose(), initial);
  controller.tick(Number.MAX_VALUE);
  assert.equal(controller.pose().mode, 'rest');
  assert.ok(Math.abs(controller.pose().elapsed - 1) < 1e-8);
  for (const value of Object.values(controller.pose())) {
    if (typeof value === 'number') assert.ok(Number.isFinite(value));
  }
  controller.dispose();
  const disposed = controller.pose();
  assert.equal(disposed.x, HOME);
  controller.prompt();
  controller.stop();
  controller.cancelPrompt();
  controller.setMotion(false);
  controller.update({id: 'new-parent', status: 'running'});
  advance(controller, 10);
  assert.deepEqual(controller.pose(), disposed);
});
