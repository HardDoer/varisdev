import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRobotDamage} from '../assets/dashboard/robot-damage.js';

type Damage = ReturnType<typeof createRobotDamage>;
function advance(damage: Damage, seconds: number, dt = 1 / 60) {
  const frames = Math.ceil(seconds / dt);
  for (let i = 0; i < frames; i++) damage.tick(seconds / frames);
}
function destroy(damage: Damage, id = 'robot') {
  for (let i = 0; i < 4; i++) assert.equal(damage.hit(id, 1, 2.2), true);
  assert.equal(damage.pose(id).phase, 'exploding');
}
function grounded(pose: ReturnType<Damage['pose']>) {
  assert.equal(pose.offset[1], 0, 'Cane hits keep feet on the floor');
  assert.ok(pose.offset.every(n => Math.abs(n) <= 0.15));
  assert.ok(pose.rotation.every(n => Math.abs(n) <= 0.2));
  for (const value of [pose.surprise, pose.flinch, pose.collapse])
    assert.ok(value >= 0 && value <= 1);
}

void test('hard contacts produce stronger short flinches and immediate held surprise', () => {
  const gentle = createRobotDamage();
  const hard = createRobotDamage();
  assert.equal(gentle.hit('robot', 1, 0.35), true);
  assert.equal(hard.hit('robot', 1, 2.2), true);
  assert.ok(hard.pose('robot').damage > gentle.pose('robot').damage * 3);
  const contact = hard.pose('robot');
  grounded(contact);
  assert.ok(contact.flinch > gentle.pose('robot').flinch);
  assert.ok(contact.flinch > 0);
  assert.equal(contact.surprise, 1);
  assert.ok(contact.offset.some(n => n !== 0));
  assert.ok(contact.rotation.some(n => n !== 0));
  advance(hard, 0.2);
  grounded(hard.pose('robot'));
  assert.ok(hard.pose('robot').flinch > 0);
  assert.ok(hard.pose('robot').flinch < contact.flinch);
  advance(hard, 0.25);
  assert.ok(hard.pose('robot').surprise > 1 - 1e-9);
  advance(hard, 0.03);
  assert.equal(hard.pose('robot').flinch, 0);
  advance(hard, 0.27);
  assert.ok(hard.pose('robot').surprise > 0);
  assert.ok(hard.pose('robot').surprise < 1);
  advance(hard, 0.4);
  assert.ok(hard.pose('robot').surprise < 1e-9);
  assert.ok(hard.effects().some(piece => piece.kind === 'armor'));
  assert.equal(hard.hit('robot', -1, 2.2), true);
  assert.equal(hard.pose('robot').surprise, 1);
  assert.equal(hard.pose('robot').flinch, contact.flinch);
  assert.ok(hard.pose('robot').offset[2] > 0);
});

void test('grounded reactions return without launches or oscillation and preserve scars', () => {
  for (const direction of [-1, 1]) {
    const damage = createRobotDamage();
    damage.hit('robot', direction, 2.2);
    const scar = damage.pose('robot').damage;
    let previous = damage.pose('robot');
    const contact = previous;
    for (let i = 0; i < 180; i++) {
      damage.tick(1 / 60);
      const pose = damage.pose('robot');
      grounded(pose);
      for (const key of ['offset', 'rotation'] as const) {
        for (let axis = 0; axis < 3; axis++) {
          assert.ok(
            Math.abs(pose[key][axis]) <= Math.abs(previous[key][axis]) + 1e-9,
          );
          assert.ok(
            pose[key][axis] * contact[key][axis] >= 0,
            'No spring recoil past the resting pose',
          );
        }
      }
      previous = pose;
    }
    assert.ok(previous.offset.every(n => n === 0));
    assert.ok(previous.rotation.every(n => n === 0));
    assert.equal(previous.damage, scar);
    assert.equal(previous.phase, 'alive');
    advance(damage, 3);
    assert.equal(damage.effects().length, 0);
  }
});

void test('four strongest hits collapse a visible body once with small armor fragments', () => {
  const damage = createRobotDamage();
  for (let i = 0; i < 3; i++) {
    damage.hit('robot', 1, 2.2);
    assert.equal(damage.pose('robot').phase, 'alive');
  }
  assert.equal(damage.hit('robot', 1, 2.2), true);
  const explosion = damage.pose('robot');
  assert.equal(explosion.damage, 1);
  assert.equal(explosion.visible, true);
  assert.equal(explosion.blast, 1);
  assert.equal(explosion.offset[1], 0);
  const fragments = damage.effects();
  assert.ok(fragments.length > 0 && fragments.length <= 48);
  assert.ok(fragments.every(piece => !['head', 'limb'].includes(piece.kind)));
  assert.equal(damage.hit('robot', 1, 2.2), false);
  assert.deepEqual(damage.effects(), fragments);
  advance(damage, 0.3);
  assert.ok(damage.pose('robot').blast > 0 && damage.pose('robot').blast < 1);
  assert.ok(damage.pose('robot').collapse > explosion.collapse);
  advance(damage, 0.65);
  const wreck = damage.pose('robot');
  assert.equal(wreck.phase, 'wrecked');
  assert.equal(wreck.visible, true);
  assert.equal(wreck.collapse, 1);
  assert.equal(wreck.cleanup, null);
  assert.equal(wreck.offset[1], 0);
  assert.equal(wreck.corpseOffset[1], 0);
  advance(damage, 2.25);
  assert.equal(damage.pose('robot').phase, 'wrecked');
  assert.deepEqual(damage.pose('robot').corpseOffset, wreck.corpseOffset);
  assert.deepEqual(damage.pose('robot').rotation, wreck.rotation);
  assert.equal(damage.hit('robot'), false);
});

void test('cleaner arrives, grasps the resting corpse, tows it away before factory replacement', () => {
  const damage = createRobotDamage();
  destroy(damage);
  advance(damage, 3.35);
  let pose = damage.pose('robot');
  assert.equal(pose.phase, 'cleanup');
  assert.equal(pose.cleanup?.phase, 'arrive');
  assert.equal(pose.cleanup?.grip, 0);
  const parkedCorpse = pose.corpseOffset;
  const cleanerStart = pose.cleanup!.position;
  advance(damage, 1.8);
  pose = damage.pose('robot');
  assert.equal(pose.cleanup?.phase, 'arrive');
  assert.notDeepEqual(pose.cleanup!.position, cleanerStart);
  assert.deepEqual(pose.corpseOffset, parkedCorpse);
  assert.equal(pose.visible, true);
  advance(damage, 0.3);
  pose = damage.pose('robot');
  assert.equal(pose.cleanup?.phase, 'load');
  assert.ok(pose.cleanup!.grip >= 0 && pose.cleanup!.grip < 1);
  assert.deepEqual(
    pose.corpseOffset,
    parkedCorpse,
    'Corpse cannot move before grasp',
  );
  assert.equal(damage.hit('robot'), false);
  advance(damage, 1.05);
  pose = damage.pose('robot');
  assert.equal(pose.cleanup?.phase, 'leave');
  assert.equal(pose.cleanup?.grip, 1);
  const loaded = pose.corpseOffset;
  advance(damage, 0.8);
  pose = damage.pose('robot');
  assert.equal(pose.cleanup?.phase, 'leave');
  assert.notDeepEqual(
    pose.corpseOffset,
    loaded,
    'The departing cleaner carries its corpse',
  );
  assert.ok(pose.cleanup!.travel > 0);
  assert.ok(Number.isFinite(pose.cleanup!.wheel));
  assert.equal(pose.door, 0);
  assert.ok(pose.corpseOffset[1] >= 0 && pose.corpseOffset[1] <= 0.15);
  advance(damage, 2.1);
  pose = damage.pose('robot');
  assert.equal(pose.phase, 'replacing');
  assert.equal(pose.cleanup, null);
  assert.equal(pose.visible, false);
  assert.ok(pose.door > 0 && pose.door < 1);
  assert.equal(pose.lift, -3.4);
  advance(damage, 1);
  pose = damage.pose('robot');
  assert.equal(pose.phase, 'replacing');
  assert.equal(pose.door, 1);
  assert.equal(pose.visible, true);
  assert.ok(pose.lift > -3.4 && pose.lift < 0);
  assert.equal(damage.hit('robot'), false);
  advance(damage, 1.9);
  pose = damage.pose('robot');
  assert.equal(pose.phase, 'replacing');
  assert.equal(pose.lift, 0);
  assert.ok(pose.door > 0 && pose.door < 1);
  advance(damage, 1);
  pose = damage.pose('robot');
  assert.equal(pose.phase, 'alive');
  assert.equal(pose.generation, 1);
  assert.equal(pose.damage, 0);
  assert.equal(pose.collapse, 0);
  assert.equal(pose.cleanup, null);
  assert.deepEqual(pose.corpseOffset, [0, 0, 0]);
  assert.equal(pose.door, 0);
  assert.equal(pose.lift, 0);
  assert.equal(pose.visible, true);
  advance(damage, 10);
  assert.equal(damage.pose('robot').generation, 1);
  assert.equal(damage.hit('robot', 1, 2.2), true);
});

void test('normal repeated hits accumulate lasting damage', () => {
  const damage = createRobotDamage();
  for (let i = 0; i < 7; i++) {
    damage.hit('robot', 1, 1);
    advance(damage, 1);
    assert.equal(damage.pose('robot').phase, 'alive');
  }
  assert.equal(damage.pose('robot').damage, 0.875);
  damage.hit('robot', -1, 1);
  assert.equal(damage.pose('robot').phase, 'exploding');
});

void test('Motion off preserves scars and immediately replaces bodies in every dead phase', () => {
  for (const [phase, time] of [
    ['alive', 0],
    ['exploding', 0],
    ['wrecked', 1],
    ['cleanup', 4],
    ['replacing', 9.5],
  ] as const) {
    const damage = createRobotDamage();
    if (phase === 'alive') damage.hit('robot', -1, 1);
    else destroy(damage);
    advance(damage, time);
    assert.equal(damage.pose('robot').phase, phase);
    const scar = damage.pose('robot').damage;
    damage.setMotion(false);
    const still = damage.pose('robot');
    assert.equal(still.phase, 'alive');
    assert.equal(still.visible, true);
    assert.equal(still.damage, phase === 'alive' ? scar : 0);
    assert.ok(still.offset.every(n => n === 0));
    assert.ok(still.rotation.every(n => n === 0));
    assert.deepEqual(still.corpseOffset, [0, 0, 0]);
    assert.equal(still.surprise, 0);
    assert.equal(still.flinch, 0);
    assert.equal(still.collapse, 0);
    assert.equal(still.cleanup, null);
    assert.equal(still.door, 0);
    assert.equal(damage.effects().length, 0);
    advance(damage, 100);
    assert.deepEqual(damage.pose('robot'), still);
    damage.hit('robot', 1, 0.35);
    assert.ok(damage.pose('robot').damage > still.damage);
    assert.ok(damage.pose('robot').offset.every(n => n === 0));
    assert.equal(damage.pose('robot').surprise, 0);
    assert.equal(damage.effects().length, 0);
  }
  const damage = createRobotDamage();
  damage.setMotion(false);
  for (let i = 0; i < 4; i++) damage.hit('robot', 1, 2.2);
  assert.equal(damage.pose('robot').phase, 'alive');
  assert.equal(damage.pose('robot').generation, 1);
  assert.equal(damage.pose('robot').damage, 0);
  damage.setMotion(true);
  advance(damage, 20);
  assert.equal(damage.pose('robot').generation, 1);
});

void test('retained snapshots preserve corpses; removal/reset/disposal isolate lifecycle state', () => {
  const damage = createRobotDamage();
  damage.hit('one', 1, 1);
  destroy(damage, 'two');
  advance(damage, 4);
  const original = damage.pose('one');
  const corpse = damage.pose('two');
  assert.equal(corpse.phase, 'cleanup');
  for (let i = 0; i < 200; i++) damage.retain(['one', 'two']);
  assert.deepEqual(damage.pose('one'), original);
  assert.deepEqual(damage.pose('two'), corpse);
  damage.retain(['one']);
  assert.equal(damage.pose('two').phase, 'alive');
  assert.equal(damage.pose('two').damage, 0);
  assert.equal(damage.pose('two').cleanup, null);
  assert.ok(damage.effects().every(piece => piece.owner === 'one'));
  damage.hit('two', -1, 1);
  advance(damage, 12);
  assert.equal(
    damage.pose('two').generation,
    0,
    'A removed cleaner must not replace a re-added robot',
  );
  assert.equal(damage.pose('two').damage, 0.125);
  destroy(damage, 'three');
  advance(damage, 4);
  damage.reset();
  for (const id of ['one', 'two', 'three']) {
    assert.equal(damage.pose(id).damage, 0);
    assert.equal(damage.pose(id).cleanup, null);
  }
  assert.equal(damage.effects().length, 0);
  destroy(damage, 'one');
  advance(damage, 4);
  damage.dispose();
  assert.equal(damage.effects().length, 0);
  assert.equal(damage.pose('one').damage, 0);
  assert.equal(damage.pose('one').cleanup, null);
  assert.equal(damage.hit('one'), false);
  damage.tick(1);
  damage.setMotion(true);
  assert.equal(damage.hit('new'), false);
});

void test('invalid time steps are ignored, catch-up is bounded, effects and robots are capped', () => {
  const damage = createRobotDamage({maxEffects: 12, maxRobots: 3});
  damage.hit('robot', 1, 1);
  const original = damage.pose('robot');
  const particles = damage.effects();
  for (const dt of [NaN, Infinity, -Infinity, -1, 0]) damage.tick(dt);
  assert.deepEqual(damage.pose('robot'), original);
  assert.deepEqual(damage.effects(), particles);
  const comparison = createRobotDamage();
  comparison.hit('robot', 1, 1);
  comparison.tick(0.25);
  damage.tick(99999);
  assert.deepEqual(damage.pose('robot'), comparison.pose('robot'));
  for (let i = 0; i < 100; i++) {
    damage.hit(`robot-${i}`, i % 2 ? -1 : 1, 2.2);
    assert.ok(damage.effects().length <= 12);
  }
  assert.equal(damage.pose('robot').damage, 0);
  assert.equal(damage.pose('robot-96').damage, 0);
  assert.ok(damage.pose('robot-97').damage > 0);
  assert.ok(
    damage
      .effects()
      .every(piece =>
        ['robot-97', 'robot-98', 'robot-99'].includes(piece.owner),
      ),
  );
  advance(damage, 10);
  assert.equal(damage.effects().length, 0);
});

void test('deterministic fragments and read snapshots cannot mutate model or cleaner state', () => {
  const a = createRobotDamage({maxRobots: NaN, maxEffects: Infinity});
  const b = createRobotDamage();
  assert.equal(a.hit(null), false);
  assert.equal(a.hit(''), false);
  a.hit('robot', NaN, Infinity);
  b.hit('robot', 1, 1);
  assert.deepEqual(a.effects(), b.effects());
  assert.deepEqual(a.pose('robot'), b.pose('robot'));
  const pose = a.pose('robot');
  pose.offset[0] = 999;
  pose.rotation[1] = NaN;
  pose.corpseOffset[0] = 999;
  pose.damage = -10;
  const effect = a.effects()[0];
  effect.position[0] = 999;
  effect.size[0] = 999;
  effect.rotation[0] = NaN;
  assert.deepEqual(a.pose('robot'), b.pose('robot'));
  assert.deepEqual(a.effects(), b.effects());
  for (const model of [a, b]) {
    for (let i = 0; i < 4; i++) model.hit('robot', 1, 2.2);
    advance(model, 4);
  }
  assert.deepEqual(a.effects(), b.effects());
  const cleaning = a.pose('robot');
  assert.ok(cleaning.cleanup);
  cleaning.cleanup.position[0] = 999;
  cleaning.cleanup.grip = -1;
  cleaning.corpseOffset[0] = 999;
  assert.deepEqual(a.pose('robot'), b.pose('robot'));
  advance(a, 10);
  for (const value of [
    ...a.pose('robot').offset,
    ...a.pose('robot').rotation,
    ...a.pose('robot').corpseOffset,
  ])
    assert.ok(Number.isFinite(value));
});

void test('concurrent deaths keep separate cleaners and lifecycle timing is frame invariant', () => {
  const fine = createRobotDamage();
  const coarse = createRobotDamage();
  for (const model of [fine, coarse]) destroy(model, 'first');
  advance(fine, 1, 1 / 120);
  advance(coarse, 1, 1 / 20);
  for (const model of [fine, coarse]) destroy(model, 'second');
  for (const seconds of [2.5, 1.2, 1.8, 1.4, 1.8, 1.5, 3]) {
    advance(fine, seconds, 1 / 120);
    advance(coarse, seconds, 1 / 20);
    for (const id of ['first', 'second']) {
      const a = fine.pose(id);
      const b = coarse.pose(id);
      assert.equal(a.phase, b.phase);
      assert.equal(a.visible, b.visible);
      assert.equal(a.generation, b.generation);
      assert.equal(a.cleanup?.phase, b.cleanup?.phase);
      assert.ok(Math.abs(a.phaseAge - b.phaseAge) < 1e-6);
      for (let axis = 0; axis < 3; axis++) {
        assert.ok(Math.abs(a.corpseOffset[axis] - b.corpseOffset[axis]) < 1e-6);
        if (a.cleanup && b.cleanup)
          assert.ok(
            Math.abs(a.cleanup.position[axis] - b.cleanup.position[axis]) <
              1e-6,
          );
      }
    }
    const first = fine.pose('first');
    const second = fine.pose('second');
    if (first.cleanup && second.cleanup)
      assert.notDeepEqual(first.cleanup.position, second.cleanup.position);
  }
  assert.equal(fine.pose('first').generation, 1);
  assert.equal(fine.pose('second').generation, 1);
});

function expose(damage: Damage, seconds: number, id = 'robot', dt = 1 / 60) {
  const frames = Math.ceil(seconds / dt);
  for (let i = 0; i < frames; i++) {
    assert.equal(damage.burn(id, seconds / frames), true);
    damage.tick(seconds / frames);
  }
}

void test('short fire bursts immediately engulf and distress robots then expire with lasting heat', () => {
  const damage = createRobotDamage();
  assert.equal(damage.burn('robot', 0.1), true);
  const first = damage.pose('robot');
  assert.equal(first.burning, 1);
  assert.equal(first.panic, 1);
  assert.equal(first.scream, 1);
  assert.ok(first.char > 0 && first.char < 0.1);
  assert.equal(first.damage, first.char);
  assert.equal(first.phase, 'alive');
  assert.equal(first.blast, 0);
  assert.equal(damage.effects().length, 0);
  advance(damage, 1.5);
  const fading = damage.pose('robot');
  assert.ok(fading.burning > 0 && fading.burning < 1);
  advance(damage, 1);
  const cooled = damage.pose('robot');
  assert.equal(cooled.phase, 'alive');
  assert.equal(cooled.burning, 0);
  assert.equal(cooled.scream, 0);
  assert.equal(cooled.panic, 0);
  assert.equal(cooled.damage, first.damage);
  assert.equal(cooled.char, first.char);
  assert.deepEqual(cooled.offset, [0, 0, 0]);
  advance(damage, 60);
  assert.deepEqual(damage.pose('robot'), cooled);
});

void test('3.5 seconds of exposure chars and collapses without blast then cleaner replaces it', () => {
  const damage = createRobotDamage();
  expose(damage, 3.25);
  assert.equal(damage.pose('robot').phase, 'alive');
  expose(damage, 0.25);
  const burnt = damage.pose('robot');
  assert.equal(burnt.phase, 'charring');
  assert.equal(burnt.char, 1);
  assert.equal(burnt.damage, 1);
  assert.equal(burnt.scream, 0);
  assert.equal(burnt.panic, 0);
  assert.equal(burnt.visible, true);
  assert.equal(burnt.blast, 0);
  assert.equal(damage.effects().length, 0);
  assert.equal(damage.burn('robot', 0.25), false);
  assert.equal(damage.hit('robot'), false);
  advance(damage, 0.5);
  assert.ok(damage.pose('robot').collapse > burnt.collapse);
  assert.equal(damage.pose('robot').blast, 0);
  advance(damage, 0.5);
  const corpse = damage.pose('robot');
  assert.equal(corpse.phase, 'wrecked');
  assert.equal(corpse.collapse, 1);
  assert.equal(corpse.char, 1);
  assert.ok(corpse.burning > 0);
  assert.deepEqual(
    corpse.offset,
    burnt.offset,
    'Corpse stays where fire felled it',
  );
  advance(damage, 2.4);
  assert.equal(damage.pose('robot').phase, 'cleanup');
  advance(damage, 3.9);
  assert.equal(damage.pose('robot').cleanup?.phase, 'leave');
  assert.ok(damage.pose('robot').corpseOffset[0] > 0);
  assert.equal(damage.pose('robot').char, 1);
  advance(damage, 2.2);
  assert.equal(damage.pose('robot').phase, 'replacing');
  assert.equal(damage.pose('robot').char, 0);
  advance(damage, 3.6);
  const replacement = damage.pose('robot');
  assert.equal(replacement.phase, 'alive');
  assert.equal(replacement.generation, 1);
  assert.equal(replacement.damage, 0);
  assert.equal(replacement.char, 0);
  assert.equal(replacement.burning, 0);
  assert.deepEqual(replacement.offset, [0, 0, 0]);
  assert.equal(damage.burn('robot', 0.1), true);
});

void test('fire panic moves frantically on the floor within home bounds and stops after expiry', () => {
  const damage = createRobotDamage();
  const positions = new Set();
  const path: number[][] = [];
  for (let i = 0; i < 120; i++) {
    damage.burn('robot', 1 / 60);
    damage.tick(1 / 60);
    const pose = damage.pose('robot');
    assert.equal(pose.phase, 'alive');
    assert.equal(pose.offset[1], 0);
    assert.ok(Math.abs(pose.offset[0]) <= 1.4);
    assert.ok(Math.abs(pose.offset[2]) <= 0.85);
    assert.ok(pose.rotation.every(n => Math.abs(n) <= 0.2));
    assert.equal(pose.panic, 1);
    positions.add(pose.offset.map(n => n.toFixed(2)).join(','));
    path.push(pose.offset);
  }
  assert.ok(positions.size > 100);
  assert.ok(
    Math.max(...path.map(p => p[0])) - Math.min(...path.map(p => p[0])) > 2.7,
  );
  assert.ok(
    Math.max(...path.map(p => p[2])) - Math.min(...path.map(p => p[2])) > 1.6,
  );
  advance(damage, 1);
  assert.ok(
    damage.pose('robot').panic > 0,
    'The run and scream remain readable after release',
  );
  advance(damage, 2);
  assert.deepEqual(damage.pose('robot').offset, [0, 0, 0]);
  assert.equal(damage.pose('robot').panic, 0);
});

void test('repeated separated bursts accumulate heat and cane damage remains additive', () => {
  const damage = createRobotDamage();
  for (let i = 0; i < 13; i++) {
    damage.burn('robot', 0.25);
    advance(damage, 2);
    assert.equal(damage.pose('robot').phase, 'alive');
    assert.equal(damage.pose('robot').burning, 0);
  }
  assert.ok(damage.pose('robot').char > 0.92);
  damage.burn('robot', 0.25);
  assert.equal(damage.pose('robot').phase, 'charring');
  const mixed = createRobotDamage();
  mixed.hit('robot', 1, 1);
  advance(mixed, 2);
  expose(mixed, 3);
  assert.equal(mixed.pose('robot').phase, 'alive');
  assert.ok(mixed.pose('robot').damage > mixed.pose('robot').char);
  mixed.burn('robot', 0.1);
  assert.equal(mixed.pose('robot').phase, 'charring');
  assert.equal(mixed.pose('robot').blast, 0);
});

void test('Motion off retains static heat and damage with no fire, panic or deferred animation', () => {
  const damage = createRobotDamage();
  damage.burn('robot', 0.25);
  damage.tick(0.2);
  damage.setMotion(false);
  const still = damage.pose('robot');
  assert.ok(still.char > 0);
  assert.equal(still.burning, 0);
  assert.equal(still.panic, 0);
  assert.equal(still.scream, 0);
  assert.deepEqual(still.offset, [0, 0, 0]);
  advance(damage, 10);
  assert.deepEqual(damage.pose('robot'), still);
  for (let i = 0; i < 20; i++) assert.equal(damage.burn('robot', 0.25), true);
  const crisp = damage.pose('robot');
  assert.equal(crisp.damage, 1);
  assert.equal(crisp.char, 1);
  assert.equal(crisp.phase, 'alive');
  assert.equal(crisp.burning, 0);
  assert.equal(crisp.panic, 0);
  assert.equal(crisp.generation, 0);
  assert.deepEqual(crisp.offset, [0, 0, 0]);
  damage.setMotion(true);
  advance(damage, 20);
  assert.deepEqual(damage.pose('robot'), crisp);
  damage.burn('robot', 0.01);
  assert.equal(damage.pose('robot').phase, 'charring');
  damage.setMotion(false);
  assert.equal(damage.pose('robot').generation, 1);
  assert.equal(damage.pose('robot').char, 0);
});

void test('invalid exposures are rejected without state and long exposures are capped per call', () => {
  const damage = createRobotDamage();
  for (const seconds of [NaN, Infinity, -Infinity, -1, 0])
    assert.equal(damage.burn('robot', seconds), false);
  for (const id of [null, undefined, ''])
    assert.equal(damage.burn(id, 0.1), false);
  assert.equal(damage.pose('robot').damage, 0);
  const comparison = createRobotDamage();
  damage.burn('robot', 10000);
  comparison.burn('robot', 0.25);
  assert.deepEqual(damage.pose('robot'), comparison.pose('robot'));
  for (const dt of [NaN, Infinity, -1, 0]) damage.tick(dt);
  assert.deepEqual(damage.pose('robot'), comparison.pose('robot'));
  damage.tick(99999);
  comparison.tick(0.25);
  assert.deepEqual(damage.pose('robot'), comparison.pose('robot'));
});

void test('fire state is isolated by retain, bounded capacity, reset and disposal', () => {
  const damage = createRobotDamage({maxRobots: 2});
  damage.burn('one', 0.2);
  damage.burn('two', 0.25);
  advance(damage, 0.2);
  const retained = damage.pose('one');
  damage.retain(['one']);
  assert.deepEqual(damage.pose('one'), retained);
  assert.equal(damage.pose('two').char, 0);
  assert.equal(damage.pose('two').burning, 0);
  damage.burn('two', 0.01);
  assert.ok(damage.pose('two').char < 0.01);
  damage.burn('three', 0.1);
  assert.equal(damage.pose('one').char, 0);
  assert.equal(damage.pose('one').panic, 0);
  damage.reset();
  for (const id of ['one', 'two', 'three']) {
    assert.equal(damage.pose(id).char, 0);
    assert.equal(damage.pose(id).burning, 0);
  }
  damage.burn('new', 0.25);
  damage.dispose();
  assert.equal(damage.pose('new').char, 0);
  assert.equal(damage.burn('new', 0.2), false);
  assert.equal(damage.burn('other', 0.2), false);
});

void test('fire exposure and lifecycle timing match across frame rates', () => {
  const fine = createRobotDamage();
  const coarse = createRobotDamage();
  expose(fine, 2.5, 'robot', 1 / 120);
  expose(coarse, 2.5, 'robot', 1 / 20);
  const compare = () => {
    const a = fine.pose('robot');
    const b = coarse.pose('robot');
    assert.equal(a.phase, b.phase);
    assert.equal(a.generation, b.generation);
    assert.ok(Math.abs(a.char - b.char) < 1e-8);
    assert.ok(Math.abs(a.phaseAge - b.phaseAge) < 1e-8);
    assert.ok(Math.abs(a.burning - b.burning) < 1e-8);
    for (let i = 0; i < 3; i++)
      assert.ok(Math.abs(a.offset[i] - b.offset[i]) < 1e-8);
  };
  compare();
  advance(fine, 2, 1 / 120);
  advance(coarse, 2, 1 / 20);
  compare();
  // Apply the lethal last exposure at the same time; then vary tick cadence.
  for (const model of [fine, coarse])
    for (let i = 0; i < 4; i++) model.burn('robot', 0.25);
  for (const seconds of [0.3, 0.7, 2.5, 1.5, 3.2, 1.8, 4]) {
    advance(fine, seconds, 1 / 120);
    advance(coarse, seconds, 1 / 20);
    compare();
  }
  assert.equal(fine.pose('robot').generation, 1);
});

void test('removing or resetting burnt corpses cancels their cleaner and replacement', () => {
  for (const elapsed of [0, 1, 4, 10]) {
    for (const reset of [false, true]) {
      const damage = createRobotDamage();
      for (let i = 0; i < 14; i++) damage.burn('robot', 0.25);
      advance(damage, elapsed);
      assert.notEqual(damage.pose('robot').phase, 'alive');
      if (reset) damage.reset();
      else damage.retain([]);
      assert.equal(damage.pose('robot').burning, 0);
      assert.equal(damage.pose('robot').char, 0);
      assert.equal(damage.pose('robot').cleanup, null);
      assert.equal(damage.burn('robot', 0.1), true);
      advance(damage, 20);
      assert.equal(damage.pose('robot').phase, 'alive');
      assert.equal(damage.pose('robot').generation, 0);
      assert.ok(damage.pose('robot').char > 0);
      assert.equal(damage.pose('robot').cleanup, null);
    }
  }
});
