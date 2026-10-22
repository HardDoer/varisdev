import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createEnvironmentDamage} from '../assets/dashboard/environment-damage.js';

type Damage = ReturnType<typeof createEnvironmentDamage>;
type Site = {id: string | number; x: number; z: number};
const origin = {id: 'wall', x: 0, z: 0};

function model(
  sites: Site[] = [origin],
  options: Parameters<typeof createEnvironmentDamage>[0] = {},
) {
  const damage = createEnvironmentDamage(options);
  damage.setSites(sites);
  return damage;
}

function pose(damage: Damage, id: string | number = 'wall') {
  const result = damage.pose(id);
  assert.ok(result, `Registered site ${id}`);
  return result;
}

function bots(damage: Damage) {
  return damage
    .poses()
    .filter(
      site => site && ['arriving', 'repairing', 'leaving'].includes(site.phase),
    );
}

function advance(damage: Damage, seconds: number, frame = 1 / 60) {
  const count = Math.ceil(seconds / frame);
  for (let i = 0; i < count; i++) damage.tick(seconds / count);
}

function ignite(damage: Damage, id = 'wall') {
  for (let i = 0; i < 3; i++) assert.equal(damage.hit(id, 'flame', 0.25), true);
  assert.equal(pose(damage, id).fire, 1);
}

function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≈ ${expected}`);
}

void test('registered scenery gets small cane dents, stronger gun chips and accumulated flame scorch', () => {
  const damage = model([
    {id: 'cane', x: -10, z: 0},
    {id: 'gun', x: 0, z: 0},
    {id: 'flame', x: 10, z: 0},
  ]);
  assert.equal(damage.active(), false);
  assert.equal(damage.hit('cane', 'cane'), true);
  assert.equal(damage.hit('gun', 'gun'), true);
  assert.equal(damage.hit('flame', 'flame', 0.1), true);
  const cane = pose(damage, 'cane');
  const gun = pose(damage, 'gun');
  const flame = pose(damage, 'flame');
  assert.ok(cane.damage > 0 && cane.damage < 0.1);
  assert.ok(gun.damage > cane.damage * 4);
  assert.ok(cane.dent > 0);
  assert.equal(cane.chips, 0);
  assert.ok(gun.chips > 0);
  assert.equal(gun.dent, 0);
  assert.ok(flame.scorch > 0);
  assert.equal(flame.fire, 0);
  assert.equal(flame.weapon, 'flame');
  assert.equal(damage.active(), true);
  for (let i = 0; i < 20; i++) damage.hit('gun', 'gun');
  assert.equal(pose(damage, 'gun').damage, 1);
  assert.equal(pose(damage, 'gun').chips, 1);
  assert.equal(pose(damage, 'gun').phase, 'damaged');
});

void test('repair robots wait five seconds, arrive, restore damage and depart', () => {
  const damage = model();
  damage.hit('wall', 'gun');
  const initial = pose(damage);
  damage.tick(4.5);
  assert.equal(pose(damage).phase, 'damaged');
  assert.equal(pose(damage).botProgress, 0);
  assert.equal(pose(damage).damage, initial.damage);
  damage.tick(0.5);
  assert.equal(pose(damage).phase, 'arriving');
  near(pose(damage).botProgress, 0);
  damage.tick(1);
  near(pose(damage).botProgress, 0.5);
  assert.equal(pose(damage).damage, initial.damage);
  damage.tick(1);
  assert.equal(pose(damage).phase, 'repairing');
  near(pose(damage).repairProgress, 0);
  assert.equal(pose(damage).botProgress, 1);
  damage.tick(1.5);
  const repairing = pose(damage);
  assert.equal(repairing.phase, 'repairing');
  near(repairing.repairProgress, 0.5);
  assert.ok(repairing.damage > 0 && repairing.damage < initial.damage);
  assert.ok(repairing.chips < initial.chips);
  damage.tick(1.5);
  assert.equal(pose(damage).phase, 'leaving');
  assert.equal(pose(damage).damage, 0);
  assert.equal(pose(damage).repairProgress, 1);
  near(pose(damage).botProgress, 1);
  damage.tick(1);
  near(pose(damage).botProgress, 0.5);
  damage.tick(1);
  assert.equal(pose(damage).phase, 'intact');
  assert.equal(pose(damage).weapon, null);
  assert.equal(pose(damage).botProgress, 0);
  assert.equal(damage.active(), false);
});

void test('three repair slots cover arrival, work and departure before draining the queue', () => {
  const sites = Array.from({length: 8}, (_, id) => ({id, x: id * 10, z: 0}));
  const damage = model(sites);
  for (const {id} of sites) damage.hit(id, 'gun');
  const dispatched: (string | number)[] = [];
  const phases = new Set<string>();
  for (let frame = 1; frame <= 26 * 60; frame++) {
    damage.tick(1 / 60);
    const active = bots(damage);
    assert.ok(
      active.length <= 3,
      `At most three dispatched bots at frame ${frame}`,
    );
    for (const site of active) {
      assert.ok(site);
      phases.add(site.phase);
      if (!dispatched.includes(site.id)) dispatched.push(site.id);
    }
    if ([5, 7, 10, 11].includes(frame / 60)) {
      assert.equal(active.length, 3);
      assert.ok(
        damage
          .poses()
          .slice(3)
          .every(site => site?.phase === 'damaged'),
      );
    }
    if (frame === 11 * 60)
      assert.ok(active.every(site => site?.phase === 'leaving'));
  }
  assert.deepEqual(
    dispatched,
    sites.map(site => site.id),
  );
  assert.deepEqual(phases, new Set(['arriving', 'repairing', 'leaving']));
  assert.ok(damage.poses().every(site => site?.phase === 'intact'));
  assert.equal(damage.active(), false);
});

void test('older waiting damage keeps its queue position through more hits and registration changes', () => {
  const sites = ['newest', 'middle', 'oldest', 'busy'].map((id, i) => ({
    id,
    x: i * 10,
    z: 0,
  }));
  const damage = model(sites, {maxRepairBots: 1});
  damage.hit('busy', 'gun');
  damage.tick(1);
  damage.hit('oldest', 'gun');
  damage.tick(1);
  damage.hit('middle', 'gun');
  damage.tick(1);
  damage.hit('newest', 'gun');
  damage.tick(3);
  for (let i = 0; i < 20; i++) damage.hit('oldest', 'cane');
  damage.setSites([...sites].reverse());
  damage.tick(6);
  for (const id of ['oldest', 'middle', 'newest']) {
    assert.deepEqual(
      bots(damage).map(site => site?.id),
      [id],
    );
    assert.equal(pose(damage, id).phase, 'arriving');
    damage.tick(7);
    assert.equal(pose(damage, id).phase, 'intact');
  }
  assert.equal(damage.active(), false);
});

void test('an older site still receiving hits allows ready queued damage to use a free slot', () => {
  const sites = ['busy', 'older', 'ready'].map((id, x) => ({id, x, z: 0}));
  const damage = model(sites, {maxRepairBots: 1});
  for (const {id} of sites) damage.hit(id, 'gun');
  damage.tick(11);
  damage.hit('older', 'cane');
  damage.tick(1);
  assert.equal(pose(damage, 'ready').phase, 'arriving');
  assert.equal(pose(damage, 'older').phase, 'damaged');
  damage.tick(7);
  assert.equal(pose(damage, 'older').phase, 'arriving');
  damage.tick(7);
  assert.equal(damage.active(), false);
});

void test('further contacts postpone dispatch until five quiet seconds have elapsed', () => {
  const damage = model();
  damage.hit('wall', 'gun');
  damage.tick(4);
  damage.hit('wall', 'cane');
  damage.tick(4.9);
  assert.equal(pose(damage).phase, 'damaged');
  assert.equal(pose(damage).botProgress, 0);
  damage.tick(0.1);
  assert.equal(pose(damage).phase, 'arriving');
  damage.tick(7);
  assert.equal(damage.active(), false);
});

void test('renewed damage preserves dispatched bots and restarts repair after a quiet period', () => {
  for (const elapsed of [6, 8.5, 10.5]) {
    const damage = model([origin, {id: 'queued', x: 10, z: 0}], {
      maxRepairBots: 1,
    });
    damage.hit('wall', 'gun');
    damage.hit('queued', 'gun');
    damage.tick(elapsed);
    const before = pose(damage);
    assert.equal(damage.hit('wall', 'cane'), true);
    const renewed = pose(damage);
    near(renewed.botProgress, before.botProgress);
    assert.equal(
      renewed.phase,
      before.phase === 'leaving' ? 'arriving' : before.phase,
    );
    if (before.phase === 'arriving') near(renewed.phaseAge, before.phaseAge);
    assert.equal(renewed.repairProgress, 0);
    assert.ok(renewed.damage > before.damage);
    let previous = renewed;
    for (let frame = 0; frame < 294; frame++) {
      damage.tick(1 / 60);
      const current = pose(damage);
      assert.ok(current.botProgress > 0, 'The dispatched bot stays visible');
      assert.ok(
        Math.abs(current.botProgress - previous.botProgress) <= 1 / 120 + 1e-8,
      );
      assert.equal(bots(damage).length, 1);
      assert.equal(pose(damage, 'queued').phase, 'damaged');
      near(current.damage, renewed.damage);
      previous = current;
    }
    assert.equal(pose(damage).phase, 'repairing');
    assert.equal(pose(damage).repairWaiting, true);
    assert.equal(pose(damage).botProgress, 1);
    damage.hit('wall', 'gun');
    const held = pose(damage);
    damage.tick(4.9);
    assert.equal(pose(damage).repairWaiting, true);
    near(pose(damage).damage, held.damage);
    damage.tick(0.1);
    assert.equal(pose(damage).repairWaiting, false);
    near(pose(damage).repairProgress, 0);
    damage.tick(1.5);
    near(pose(damage).damage, (held.damage * 2) / 3);
    near(pose(damage).chips, (held.chips * 2) / 3);
    damage.tick(1.5);
    assert.equal(pose(damage).phase, 'leaving');
    assert.equal(pose(damage, 'queued').phase, 'damaged');
    damage.tick(2);
    assert.equal(pose(damage).phase, 'intact');
    assert.equal(pose(damage, 'queued').phase, 'arriving');
    damage.tick(7);
    assert.equal(damage.active(), false);
  }
});

void test('brief exposure scorches, sustained exposure ignites and fire keeps damaging the site', () => {
  const brief = model();
  brief.hit('wall', 'flame', 0.1);
  const scorched = pose(brief);
  brief.tick(2);
  assert.equal(pose(brief).fire, 0);
  assert.equal(pose(brief).damage, scorched.damage);
  assert.equal(pose(brief).scorch, scorched.scorch);

  const damage = model();
  for (let i = 0; i < 3; i++) {
    damage.hit('wall', 'flame', 0.25);
    damage.tick(0.25);
  }
  const burning = pose(damage);
  assert.equal(burning.fire, 1);
  assert.ok(burning.fireAge > 0);
  damage.tick(2);
  assert.equal(pose(damage).fire, 1);
  assert.ok(pose(damage).damage > burning.damage);
  assert.ok(pose(damage).scorch > burning.scorch);
  assert.equal(pose(damage).phase, 'damaged');
});

void test('the repair robot extinguishes a sustained fire before restoring the scorched surface', () => {
  const damage = model();
  ignite(damage);
  damage.tick(7);
  const arrival = pose(damage);
  assert.equal(arrival.phase, 'repairing');
  assert.equal(arrival.fire, 1);
  damage.tick(0.5);
  const extinguishing = pose(damage);
  assert.ok(extinguishing.fire > 0 && extinguishing.fire < 1);
  assert.equal(extinguishing.damage, arrival.damage);
  assert.equal(extinguishing.scorch, arrival.scorch);
  damage.tick(0.25);
  near(pose(damage).fire, 0);
  near(pose(damage).damage, arrival.damage);
  damage.tick(0.75);
  assert.equal(pose(damage).fire, 0);
  assert.ok(pose(damage).damage < arrival.damage);
  assert.ok(pose(damage).scorch < arrival.scorch);
  damage.tick(1.5);
  assert.equal(pose(damage).phase, 'leaving');
  assert.equal(pose(damage).damage, 0);
  assert.equal(pose(damage).scorch, 0);
});

void test('neighboring fires spread locally for at most two hops and finish without reignition', () => {
  const sites = [
    origin,
    {id: 'near', x: 2.5, z: 0},
    {id: 'second', x: 5, z: 0},
    {id: 'third', x: 7.5, z: 0},
    {id: 'far', x: 0, z: 10},
  ];
  const damage = model(sites);
  ignite(damage);
  damage.tick(1.4);
  assert.equal(pose(damage, 'near').fire, 0);
  damage.tick(0.1);
  assert.equal(pose(damage, 'near').fire, 1);
  assert.equal(pose(damage, 'near').weapon, 'flame');
  assert.equal(pose(damage, 'second').fire, 0);
  damage.tick(1.5);
  assert.equal(pose(damage, 'second').fire, 1);
  damage.tick(1.5);
  assert.equal(pose(damage, 'third').damage, 0);
  assert.equal(pose(damage, 'far').damage, 0);
  damage.tick(7.5);
  assert.equal(pose(damage).phase, 'intact');
  assert.equal(pose(damage, 'near').phase, 'leaving');
  assert.equal(pose(damage, 'second').phase, 'repairing');
  damage.tick(10);
  assert.equal(damage.active(), false);
  for (const site of damage.poses()) {
    assert.equal(site?.phase, 'intact');
    assert.equal(site?.fire, 0);
    assert.equal(site?.damage, 0);
  }
  damage.tick(10_000);
  assert.equal(damage.active(), false);
  ignite(damage);
  assert.equal(pose(damage).fire, 1, 'A fresh direct attack can ignite again');
});

void test('dense fire clusters have a finite spread budget and do not cross gaps', () => {
  const sites = Array.from({length: 40}, (_, i) => ({
    id: i === 0 ? 'wall' : `dense-${i}`,
    x: (i % 8) * 0.2,
    z: Math.floor(i / 8) * 0.2,
  }));
  sites.push({id: 'separate', x: 4.5, z: 0});
  const damage = model(sites);
  ignite(damage);
  damage.tick(4.5);
  const burning = damage.poses().filter(site => site && site.fire > 0);
  assert.ok(burning.length >= 3 && burning.length <= 8);
  assert.equal(pose(damage, 'separate').damage, 0);
  damage.tick(Number.MAX_VALUE);
  assert.equal(damage.active(), false);
  assert.ok(damage.poses().every(site => site?.phase === 'intact'));
});

void test('spreading fire queues repairs without a swarm and every burned site is restored', () => {
  const sites = Array.from({length: 20}, (_, i) => ({
    id: i === 0 ? 'wall' : `neighbor-${i}`,
    x: (i % 5) * 0.3,
    z: Math.floor(i / 5) * 0.3,
  }));
  const damage = model(sites);
  ignite(damage);
  const burned = new Set<string | number>();
  const repaired = new Set<string | number>();
  let queuedFire = false;
  for (let frame = 0; frame < 35 * 60 && damage.active(); frame++) {
    damage.tick(1 / 60);
    const active = bots(damage);
    assert.ok(active.length <= 3);
    for (const site of damage.poses()) {
      assert.ok(site);
      if (site.fire > 0) burned.add(site.id);
      if (site.phase === 'damaged' && site.fire > 0 && active.length === 3)
        queuedFire = true;
      if (site.phase === 'intact' && burned.has(site.id)) repaired.add(site.id);
    }
  }
  assert.ok(
    queuedFire,
    'Fire waits for bots already arriving, repairing or leaving',
  );
  assert.ok(burned.size > 3 && burned.size <= 8);
  assert.deepEqual(repaired, burned);
  assert.equal(damage.active(), false);
  assert.ok(
    damage.poses().every(site => site?.phase === 'intact' && site.fire === 0),
  );
});

void test('a newly ignited fire keeps its dispatched bot and is extinguished after renewed damage settles', () => {
  const damage = model();
  damage.hit('wall', 'gun');
  damage.tick(8.5);
  ignite(damage);
  assert.equal(pose(damage).phase, 'repairing');
  assert.equal(pose(damage).repairWaiting, true);
  assert.equal(pose(damage).botProgress, 1);
  const renewed = pose(damage);
  damage.tick(5);
  const restart = pose(damage);
  assert.equal(restart.repairWaiting, false);
  assert.equal(restart.fire, 1);
  assert.ok(restart.damage > renewed.damage);
  damage.tick(0.75);
  near(pose(damage).fire, 0);
  near(pose(damage).damage, restart.damage);
  damage.tick(2.25);
  assert.equal(pose(damage).phase, 'leaving');
  assert.equal(pose(damage).scorch, 0);
  damage.tick(2);
  assert.equal(damage.active(), false);
});

void test('frame partitions retain fractional time and produce identical lifecycle and spreading poses', () => {
  const sites = [
    origin,
    ...Array.from({length: 6}, (_, i) => ({
      id: `neighbor-${i}`,
      x: i + 1,
      z: 0,
    })),
  ];
  const coarse = model(sites);
  const smooth = model(sites);
  const uneven = model(sites);
  for (const damage of [coarse, smooth, uneven]) ignite(damage);
  for (const seconds of [0.1, 1.4, 1.25, 2.25, 2, 0.75, 0.75, 1.5, 2, 4]) {
    coarse.tick(seconds);
    advance(smooth, seconds, 1 / 144);
    advance(uneven, seconds, 0.137);
    assert.deepEqual(smooth.poses(), coarse.poses());
    assert.deepEqual(uneven.poses(), coarse.poses());
  }
  const fine = model();
  fine.hit('wall', 'cane');
  advance(fine, 5, 1 / 240);
  assert.equal(pose(fine).phase, 'arriving');
});

void test('flame exposure is additive across input frames and each call is capped at a quarter second', () => {
  const burst = model();
  const frames = model();
  burst.hit('wall', 'flame', 10_000);
  for (let i = 0; i < 15; i++) frames.hit('wall', 'flame', 1 / 60);
  near(pose(burst).damage, pose(frames).damage);
  near(pose(burst).scorch, pose(frames).scorch);
  assert.equal(pose(burst).fire, 0);
  burst.hit('wall', 'flame', 100);
  assert.equal(pose(burst).fire, 0);
  burst.hit('wall', 'flame', 100);
  assert.equal(pose(burst).fire, 1);
});

void test('setSites retains same-session damage, lifecycle and updated positions while pruning removed ids', () => {
  const damage = model([origin, {id: 'removed', x: 4, z: 0}]);
  damage.hit('wall', 'gun');
  damage.hit('removed', 'gun');
  damage.tick(6);
  const before = pose(damage);
  const descriptors = [
    {id: 'wall', x: -2, z: 3, kind: 'wall'},
    {id: 'new', x: 10, z: 0, kind: 'floor'},
  ];
  damage.setSites(descriptors);
  assert.deepEqual(pose(damage), {...before, x: -2, z: 3});
  assert.equal(damage.pose('removed'), null);
  assert.equal(pose(damage, 'new').damage, 0);
  descriptors[0].x = 50;
  assert.equal(pose(damage).x, -2, 'Registration copies coordinates');
  const snapshot = pose(damage);
  snapshot.damage = 99;
  assert.equal(pose(damage).damage, before.damage, 'Poses are detached');
  damage.setSites([]);
  assert.equal(damage.active(), false);
  assert.deepEqual(damage.poses(), []);
  damage.setSites([origin]);
  assert.equal(pose(damage).damage, 0);
});

void test('pruned waiting sites release queue entries and removed dispatched bots release slots', () => {
  const sites = ['busy', 'removed', 'waiting'].map((id, x) => ({id, x, z: 0}));
  const damage = model(sites, {maxRepairBots: 1});
  for (const {id} of sites) damage.hit(id, 'gun');
  damage.tick(6);
  assert.equal(pose(damage, 'busy').phase, 'arriving');
  damage.setSites([sites[2]]);
  assert.equal(damage.pose('busy'), null);
  assert.equal(damage.pose('removed'), null);
  damage.tick(1 / 60);
  assert.equal(pose(damage, 'waiting').phase, 'arriving');
  damage.setSites([...sites].reverse());
  assert.equal(pose(damage, 'busy').phase, 'intact');
  assert.equal(pose(damage, 'removed').phase, 'intact');
  damage.tick(7);
  assert.equal(damage.active(), false);
  damage.hit('removed', 'gun');
  damage.hit('busy', 'gun');
  damage.tick(5);
  assert.deepEqual(
    bots(damage).map(site => site?.id),
    ['removed'],
  );
  damage.tick(7);
  assert.deepEqual(
    bots(damage).map(site => site?.id),
    ['busy'],
  );
  damage.tick(7);
  assert.equal(damage.active(), false);
});

void test('repair limits stay finite and a long tick drains the largest scene with one bot', () => {
  const sites = Array.from({length: 256}, (_, id) => ({id, x: id, z: 0}));
  const damage = model(sites, {maxSites: 256, maxRepairBots: 1});
  for (const {id} of sites) damage.hit(id, 'gun');
  damage.tick(5);
  assert.equal(bots(damage).length, 1);
  damage.tick(Number.MAX_VALUE);
  assert.equal(damage.active(), false);
  assert.ok(damage.poses().every(site => site?.phase === 'intact'));
  damage.hit(255, 'cane');
  damage.tick(4.9);
  assert.equal(
    pose(damage, 255).phase,
    'damaged',
    'Suspended time was discarded',
  );
  damage.tick(0.1);
  assert.equal(pose(damage, 255).phase, 'arriving');

  for (const [maxRepairBots, expected] of [
    [0, 1],
    [-1, 1],
    [1.9, 1],
    [NaN, 3],
    [Infinity, 3],
    [Number.MAX_VALUE, 5],
  ]) {
    const limited = model(sites.slice(0, 5), {maxSites: 5, maxRepairBots});
    for (let id = 0; id < 5; id++) limited.hit(id, 'gun');
    limited.tick(5);
    assert.equal(bots(limited).length, expected);
    limited.tick(Number.MAX_VALUE);
    assert.equal(limited.active(), false);
  }
});

void test('registration and invalid contacts cannot grow or corrupt bounded scene state', () => {
  const damage = createEnvironmentDamage({maxSites: 2});
  damage.setSites([
    {id: '', x: 0, z: 0},
    {id: 'invalid', x: NaN, z: 0},
    origin,
    {...origin, x: 10},
    {id: 0, x: 1, z: 2},
    {id: 'overflow', x: 0, z: 0},
  ]);
  assert.equal(damage.poses().length, 2);
  assert.equal(pose(damage).x, 0);
  assert.equal(damage.pose('overflow'), null);
  assert.equal(damage.hit('unknown', 'gun'), false);
  assert.equal(damage.hit('wall', 'unknown'), false);
  for (const amount of [0, -1, NaN, Infinity])
    assert.equal(damage.hit('wall', 'flame', amount), false);
  assert.equal(damage.active(), false);
  assert.equal(damage.hit(0, 'gun', Number.MAX_VALUE), true);
  assert.ok(pose(damage, 0).damage <= 1);
  const before = damage.poses();
  for (const seconds of [0, -1, NaN, Infinity]) damage.tick(seconds);
  assert.deepEqual(damage.poses(), before);
  const capped = createEnvironmentDamage({maxSites: Number.MAX_VALUE});
  capped.setSites(Array.from({length: 500}, (_, i) => ({id: i, x: i, z: 0})));
  assert.equal(capped.poses().length, 256);
});

void test('Motion off keeps static damage, freezes fire propagation and resumes without catch-up', () => {
  const damage = model([origin, {id: 'neighbor', x: 2, z: 0}]);
  ignite(damage);
  damage.tick(0.5);
  const burning = pose(damage);
  damage.setMotion(false);
  const frozen = damage.poses();
  assert.equal(pose(damage).fire, 0);
  assert.equal(pose(damage).fireAge, 0);
  assert.equal(damage.active(), false);
  damage.tick(1000);
  assert.deepEqual(damage.poses(), frozen);
  assert.equal(damage.hit('neighbor', 'cane'), true);
  assert.ok(pose(damage, 'neighbor').dent > 0);
  damage.setMotion(true);
  assert.equal(pose(damage).fire, burning.fire);
  near(pose(damage).fireAge, burning.fireAge);
  damage.tick(0.9);
  assert.equal(pose(damage, 'neighbor').fire, 0);
  damage.tick(0.1);
  assert.equal(pose(damage, 'neighbor').fire, 1);
  damage.tick(6);
  assert.equal(pose(damage).phase, 'repairing');
  const working = pose(damage);
  damage.setMotion(false);
  assert.equal(pose(damage).botProgress, 0);
  damage.tick(100);
  near(pose(damage).repairProgress, working.repairProgress);
  damage.setMotion(true);
  assert.equal(pose(damage).botProgress, 1);
  damage.tick(10);
  assert.equal(damage.active(), false);
});

void test('Motion freezes queued and dispatched repairs and reset clears both without stale work', () => {
  const sites = ['busy', 'first', 'second'].map((id, x) => ({id, x, z: 0}));
  const damage = model(sites, {maxRepairBots: 1});
  for (const {id} of sites) damage.hit(id, 'gun');
  damage.tick(6);
  const traveling = pose(damage, 'busy');
  damage.setMotion(false);
  const frozen = damage.poses();
  damage.tick(Number.MAX_VALUE);
  assert.deepEqual(damage.poses(), frozen);
  damage.setMotion(true);
  assert.deepEqual(pose(damage, 'busy'), traveling);
  damage.tick(6);
  assert.equal(pose(damage, 'busy').phase, 'intact');
  assert.equal(pose(damage, 'first').phase, 'arriving');
  assert.equal(pose(damage, 'second').phase, 'damaged');
  damage.reset();
  damage.tick(Number.MAX_VALUE);
  assert.equal(damage.active(), false);
  assert.equal(bots(damage).length, 0);
  damage.hit('second', 'cane');
  damage.hit('busy', 'gun');
  damage.tick(5);
  assert.deepEqual(
    bots(damage).map(site => site?.id),
    ['second'],
  );
  damage.tick(Number.MAX_VALUE);
  assert.equal(damage.active(), false);
});

void test('flame contacts with Motion off leave static scorch until animation is enabled', () => {
  const damage = model();
  damage.setMotion(false);
  for (let i = 0; i < 3; i++) damage.hit('wall', 'flame', 0.25);
  assert.ok(pose(damage).scorch > 0);
  assert.ok(pose(damage).damage > 0);
  assert.equal(pose(damage).fire, 0);
  damage.tick(100);
  assert.equal(pose(damage).phaseAge, 0);
  damage.setMotion(true);
  assert.equal(pose(damage).fire, 1);
  damage.tick(20);
  assert.equal(pose(damage).phase, 'intact');
});

void test('reset retains scene registration, clears session damage and does not affect another instance', () => {
  const first = model([origin, {id: 'neighbor', x: 2, z: 0}]);
  const second = model();
  ignite(first);
  first.tick(2);
  second.hit('wall', 'gun');
  const otherSession = second.poses();
  first.reset();
  assert.equal(first.poses().length, 2);
  assert.equal(first.active(), false);
  assert.ok(first.poses().every(site => site?.phase === 'intact'));
  first.tick(1000);
  assert.equal(first.active(), false);
  assert.deepEqual(second.poses(), otherSession);
  assert.equal(first.hit('wall', 'cane'), true);
  first.setMotion(false);
  first.reset();
  assert.equal(first.hit('wall', 'gun'), true);
  assert.equal(first.active(), false, 'Reset preserves the Motion setting');
});

void test('dispose clears the scene permanently and all later operations are inert', () => {
  const damage = model();
  ignite(damage);
  damage.dispose();
  damage.dispose();
  damage.reset();
  damage.setMotion(true);
  damage.setSites([origin]);
  damage.tick(Number.MAX_VALUE);
  assert.equal(damage.hit('wall', 'cane'), false);
  assert.equal(damage.pose('wall'), null);
  assert.deepEqual(damage.poses(), []);
  assert.equal(damage.active(), false);
});
