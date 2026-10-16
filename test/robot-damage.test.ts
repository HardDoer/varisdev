import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRobotDamage} from '../assets/dashboard/robot-damage.js';

type Damage = ReturnType<typeof createRobotDamage>;
function advance(damage: Damage, seconds: number) {
  for (let t = 0; t < seconds; t += 1 / 60) damage.tick(1 / 60);
}
function destroy(damage: Damage, id = 'robot') {
  for (let i = 0; i < 4; i++) assert.equal(damage.hit(id, 1, 2.2), true);
  assert.equal(damage.pose(id).phase, 'exploding');
}

void test('hard cane impacts damage and launch substantially more than gentle contacts', () => {
  const gentle = createRobotDamage();
  const hard = createRobotDamage();
  assert.equal(gentle.hit('robot', 1, 0.35), true);
  assert.equal(hard.hit('robot', 1, 2.2), true);
  assert.ok(hard.pose('robot').damage > gentle.pose('robot').damage * 3);
  // Even the frame before tick has perceptible contact displacement/rotation.
  assert.ok(hard.pose('robot').offset[1] > 0);
  assert.ok(hard.pose('robot').offset[2] < 0);
  assert.ok(hard.pose('robot').rotation[0] > 0);
  advance(gentle, 0.18);
  advance(hard, 0.18);
  assert.ok(hard.pose('robot').offset[1] > gentle.pose('robot').offset[1]);
  assert.ok(
    Math.abs(hard.pose('robot').offset[2]) >
      Math.abs(gentle.pose('robot').offset[2]) * 3,
  );
  assert.ok(hard.pose('robot').rotation.some(n => Math.abs(n) > 0.5));
  assert.ok(hard.effects().some(piece => piece.kind === 'armor'));
});

void test('gravity, floor bounce, damping and angular springs settle without healing scars', () => {
  const damage = createRobotDamage();
  damage.hit('robot', -1, 2.2);
  const scar = damage.pose('robot').damage;
  assert.ok(damage.pose('robot').offset[2] > 0);
  let peak = 0;
  let bounced = false;
  let previousY = 0;
  let landed = false;
  for (let i = 0; i < 600; i++) {
    damage.tick(1 / 60);
    const p = damage.pose('robot');
    assert.ok(p.offset[1] >= 0);
    peak = Math.max(peak, p.offset[1]);
    if (peak > 0.5 && p.offset[1] < 0.03) landed = true;
    if (landed && p.offset[1] > previousY + 0.01) bounced = true;
    previousY = p.offset[1];
  }
  assert.ok(peak > 1);
  assert.ok(bounced);
  assert.deepEqual(damage.pose('robot').offset, [0, 0, 0]);
  assert.deepEqual(damage.pose('robot').rotation, [0, 0, 0]);
  assert.equal(damage.pose('robot').damage, scar);
  assert.equal(damage.pose('robot').phase, 'alive');
  assert.equal(damage.effects().length, 0);
});

void test('four hard hits explode once; dead bodies cannot be hit again', () => {
  const damage = createRobotDamage();
  for (let i = 0; i < 3; i++) {
    damage.hit('robot', 1, 2.2);
    assert.equal(damage.pose('robot').phase, 'alive');
  }
  assert.equal(damage.hit('robot', 1, 2.2), true);
  const explosion = damage.pose('robot');
  assert.equal(explosion.damage, 1);
  assert.equal(explosion.visible, false);
  assert.equal(explosion.blast, 1);
  const fragments = damage.effects();
  assert.ok(fragments.some(piece => piece.kind === 'head'));
  assert.ok(fragments.some(piece => piece.kind === 'limb'));
  assert.equal(damage.hit('robot', 1, 2.2), false);
  assert.deepEqual(damage.effects(), fragments);
  advance(damage, 0.3);
  assert.ok(damage.pose('robot').blast < 1);
  assert.ok(damage.pose('robot').blast > 0);
});

void test('factory hatch opens before replacement rises, then closes behind a fresh generation', () => {
  const damage = createRobotDamage();
  destroy(damage);
  advance(damage, 1.1);
  let p = damage.pose('robot');
  assert.equal(p.phase, 'replacing');
  assert.ok(p.door > 0 && p.door < 1);
  assert.equal(p.visible, false);
  assert.equal(p.lift, -3.4);
  advance(damage, 1);
  p = damage.pose('robot');
  assert.equal(p.door, 1);
  assert.equal(p.visible, true);
  assert.ok(p.lift > -3.4 && p.lift < 0);
  assert.equal(damage.hit('robot', 1, 2.2), false);
  advance(damage, 1.9);
  p = damage.pose('robot');
  assert.equal(p.phase, 'replacing');
  assert.equal(p.lift, 0);
  assert.ok(p.door < 1 && p.door > 0);
  advance(damage, 1);
  p = damage.pose('robot');
  assert.equal(p.phase, 'alive');
  assert.equal(p.generation, 1);
  assert.equal(p.damage, 0);
  assert.equal(p.door, 0);
  assert.equal(p.lift, 0);
  assert.equal(p.visible, true);
  advance(damage, 10);
  assert.equal(damage.pose('robot').generation, 1);
  assert.equal(damage.hit('robot', 1, 2.2), true);
});

void test('normal and gentle repeated hits accumulate damage without a time-based auto-heal', () => {
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

void test('Motion off preserves static damage, clears kinetic effects and never strands dead robots', () => {
  for (const phase of ['alive', 'exploding', 'replacing']) {
    const damage = createRobotDamage();
    if (phase === 'alive') damage.hit('robot', -1, 1);
    else destroy(damage);
    if (phase === 'replacing') advance(damage, 1.5);
    const scar = damage.pose('robot').damage;
    damage.setMotion(false);
    const still = damage.pose('robot');
    assert.equal(still.phase, 'alive');
    assert.equal(still.visible, true);
    assert.equal(still.damage, phase === 'alive' ? scar : 0);
    assert.deepEqual(still.offset, [0, 0, 0]);
    assert.deepEqual(still.rotation, [0, 0, 0]);
    assert.equal(still.door, 0);
    assert.equal(damage.effects().length, 0);
    advance(damage, 100);
    assert.deepEqual(damage.pose('robot'), still);
    damage.hit('robot', 1, 0.35);
    assert.ok(damage.pose('robot').damage > still.damage);
    assert.deepEqual(damage.pose('robot').offset, [0, 0, 0]);
    assert.equal(damage.effects().length, 0);
  }
  const damage = createRobotDamage();
  damage.setMotion(false);
  for (let i = 0; i < 4; i++) damage.hit('robot', 1, 2.2);
  assert.equal(damage.pose('robot').phase, 'alive');
  assert.equal(damage.pose('robot').generation, 1);
  assert.equal(damage.pose('robot').damage, 0);
  damage.setMotion(true);
  advance(damage, 10);
  assert.equal(damage.pose('robot').generation, 1);
});

void test('retained snapshots preserve damage; removal/reset/disposal isolate lifecycle state', () => {
  const damage = createRobotDamage();
  damage.hit('one', 1, 1);
  destroy(damage, 'two');
  const original = damage.pose('one');
  for (let i = 0; i < 200; i++) damage.retain(['one', 'two']);
  assert.deepEqual(damage.pose('one'), original);
  damage.retain(['one']);
  assert.equal(damage.pose('two').phase, 'alive');
  assert.equal(damage.pose('two').damage, 0);
  assert.ok(damage.effects().every(piece => piece.owner === 'one'));
  damage.reset();
  assert.equal(damage.pose('one').damage, 0);
  assert.equal(damage.effects().length, 0);
  damage.hit('one', 1, 1);
  damage.dispose();
  assert.equal(damage.effects().length, 0);
  assert.equal(damage.pose('one').damage, 0);
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

void test('deterministic fragments, bounded malformed inputs, and read snapshots cannot mutate the model', () => {
  const a = createRobotDamage({maxRobots: NaN, maxEffects: Infinity});
  const b = createRobotDamage();
  assert.equal(a.hit(null), false);
  assert.equal(a.hit(''), false);
  a.hit('robot', NaN, Infinity);
  b.hit('robot', 1, 1);
  assert.deepEqual(a.effects(), b.effects());
  assert.deepEqual(a.pose('robot'), b.pose('robot'));
  const p = a.pose('robot');
  p.offset[0] = 999;
  p.rotation[1] = NaN;
  p.damage = -10;
  const effect = a.effects()[0];
  effect.position[0] = 999;
  effect.size[0] = 999;
  effect.rotation[0] = NaN;
  assert.deepEqual(a.pose('robot'), b.pose('robot'));
  assert.deepEqual(a.effects(), b.effects());
  advance(a, 10);
  for (const value of [...a.pose('robot').offset, ...a.pose('robot').rotation])
    assert.ok(Number.isFinite(value));
});
