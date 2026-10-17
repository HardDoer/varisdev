import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  factoryIdentity,
  factoryIdentityPalette,
  stableFactoryHash,
} from '../assets/dashboard/factory-identity.js';
import {
  createFactoryVisitors,
  HOME_ROUTE,
  visitorCaneId,
  VISITOR_ROUTE,
} from '../assets/dashboard/factory-visitors.js';

const sessions = (...values: Array<[string, string]>) => ({
  sessions: values.map(([id, status]) => ({
    session: {id, name: id, status},
  })),
});

function advance(
  visitors: ReturnType<typeof createFactoryVisitors>,
  seconds: number,
) {
  for (let elapsed = 0; elapsed < seconds; elapsed += 1 / 60)
    visitors.tick(1 / 60);
}

function until(
  visitors: ReturnType<typeof createFactoryVisitors>,
  condition: () => boolean,
  maximumSeconds = 90,
) {
  for (let frame = 0; frame < maximumSeconds * 60; frame++) {
    if (condition()) return;
    visitors.tick(1 / 60);
  }
  assert.ok(condition(), 'visitor condition timed out');
}

function travelerAtPhase(
  visitors: ReturnType<typeof createFactoryVisitors>,
  ids: string[],
  phase: string,
) {
  until(visitors, () => ids.some(id => visitors.snapshot(id)?.phase === phase));
  const source = ids.find(id => visitors.snapshot(id)?.phase === phase);
  assert.ok(source);
  const target = visitors.snapshot(source)?.targetId;
  assert.ok(target);
  return {source, target};
}

void test('factory identities are stable, distinct, and add only theme-derived decorative colors', () => {
  assert.equal(stableFactoryHash('alpha'), stableFactoryHash('alpha'));
  const alpha = factoryIdentity('alpha');
  const beta = factoryIdentity('beta');
  assert.deepEqual(factoryIdentity('alpha'), alpha);
  assert.notEqual(alpha.token, beta.token);
  assert.notDeepEqual(alpha, beta);
  assert.ok(['mint', 'cyan', 'amber'].includes(alpha.accentKey));
  assert.ok(alpha.gantry >= 0 && alpha.gantry <= 2);
  assert.ok(alpha.roof >= 0 && alpha.roof <= 2);
  assert.ok(alpha.utilities >= 2 && alpha.utilities <= 4);

  const palette = {
    floor: [0.1, 0.2, 0.3],
    edge: [0.2, 0.3, 0.4],
    metal: [0.3, 0.4, 0.5],
    white: [0.9, 0.9, 0.9],
    mint: [0.2, 0.9, 0.6],
    cyan: [0.1, 0.7, 1],
    amber: [1, 0.6, 0.2],
    running: [0.4, 0.8, 0.5],
    queued: [0.9, 0.8, 0.3],
    completed: [0.5, 0.7, 1],
    red: [1, 0.2, 0.2],
  };
  const derived = factoryIdentityPalette(palette, alpha);
  for (const semantic of ['running', 'queued', 'completed', 'red'])
    assert.equal(
      derived[semantic as keyof typeof derived],
      palette[semantic as keyof typeof palette],
      `${semantic} must retain the theme's semantic color`,
    );
  for (const color of [
    derived.factoryFloor,
    derived.factoryEdge,
    derived.factoryMetal,
    derived.factoryAccent,
  ])
    assert.ok(color.every((value: number) => value >= 0 && value <= 1));
});

void test('visitor route remains in the loading-dock corridor, clear of dais, queue pad, bays, and walls', () => {
  const obstacles = [
    {name: 'parent dais', x: -6.25, z: 0, radius: 3.3},
    {name: 'queue pad', x: -7.4, z: 3.65, radius: 1.45},
    {name: 'nearest work bay', x: -1.5, z: 3.1, radius: 2.1},
  ];
  for (const [x, z] of VISITOR_ROUTE) {
    assert.ok(x >= -10.75 && x <= 10.35, 'route stays on the foundation');
    assert.ok(z > -5.2 && z < 5.2, 'route stays clear of the rear/front walls');
    for (const obstacle of obstacles)
      assert.ok(
        Math.hypot(x - obstacle.x, z - obstacle.z) > obstacle.radius,
        `route stays clear of ${obstacle.name}`,
      );
  }
  for (const [x, z] of HOME_ROUTE) {
    assert.ok(x >= -10.75 && x <= -6.25);
    assert.ok(z >= 0 && z < 5.2);
  }
  assert.deepEqual(HOME_ROUTE.at(-1), [-6.25, 0]);
});

void test('idle parents deterministically visit another open factory and prompts return from the actual position', () => {
  const first = createFactoryVisitors();
  const hub = sessions(['alpha', 'idle'], ['beta', 'idle'], ['gamma', 'idle']);
  first.update(hub);

  until(first, () =>
    ['alpha', 'beta', 'gamma'].some(
      id => first.snapshot(id)?.phase === 'visit',
    ),
  );
  // Advance two fresh controllers to an exact common state.
  const replayA = createFactoryVisitors();
  const replayB = createFactoryVisitors();
  replayA.update(hub);
  replayB.update(hub);
  advance(replayA, 70);
  advance(replayB, 70);
  for (const id of ['alpha', 'beta', 'gamma'])
    assert.deepEqual(replayA.snapshot(id), replayB.snapshot(id));

  const visitorId = ['alpha', 'beta', 'gamma'].find(
    id => first.snapshot(id)?.phase === 'visit',
  );
  assert.ok(visitorId);
  const before = first.snapshot(visitorId!);
  assert.ok(before?.targetId);
  assert.match(first.awayMessage(visitorId!), /^Visiting /);
  const visible = first.visitorsAt(before!.targetId!);
  assert.ok(visible.some(visitor => visitor.id === visitorId));
  assert.equal(first.prompt(visitorId!), true);
  const startled = first.snapshot(visitorId!);
  assert.equal(startled?.phase, 'startled');
  assert.match(first.awayMessage(visitorId!), /^Startled — returning from /);
  assert.equal(startled?.x, before?.x, 'prompt must not teleport x');
  assert.equal(startled?.z, before?.z, 'prompt must not teleport z');
  advance(first, 0.25);
  const jump = first
    .visitorsAt(before!.targetId!)
    .find(visitor => visitor.id === visitorId);
  assert.ok((jump?.jump || 0) > 0.7);
  until(first, () => first.snapshot(visitorId!)?.phase === 'depart', 1);
  const departure = first.snapshot(visitorId!);
  assert.ok(
    Math.hypot(
      departure!.x - VISITOR_ROUTE[0][0],
      departure!.z - VISITOR_ROUTE[0][1],
    ) > 0.1,
    'return begins at the visited position rather than the entrance',
  );
  until(first, () => first.snapshot(visitorId!)?.phase === 'homecoming', 5);
  const entrance = first.snapshot(visitorId!);
  assert.equal(first.awayMessage(visitorId!), 'Returning to own workstation');
  assert.equal(
    first.visitorsAt(visitorId!).some(visitor => visitor.id === visitorId),
    true,
    'the original robot must reappear at its own loading dock',
  );
  assert.ok(
    Math.hypot(entrance!.x - HOME_ROUTE[0][0], entrance!.z - HOME_ROUTE[0][1]) <
      0.2,
  );
  until(first, () => !first.isAway(visitorId!), 5);
  const home = first.snapshot(visitorId!);
  assert.equal(home?.phase, 'wait');
  assert.equal(home?.x, HOME_ROUTE.at(-1)?.[0]);
  assert.equal(home?.z, HOME_ROUTE.at(-1)?.[1]);
  assert.equal(first.isAway('never-seen'), false);
});

void test('departures start at the observed roaming pose and an arrival prompt reverses the reached segment', () => {
  const visitors = createFactoryVisitors();
  visitors.update(sessions(['roamer', 'idle'], ['host', 'idle']));
  visitors.observeLocalPose('roamer', {x: 3.25, z: 0, yaw: Math.PI});
  until(visitors, () => visitors.snapshot('roamer')?.phase === 'leaving-home');
  const departure = visitors.snapshot('roamer');
  assert.ok((departure?.x || 0) > 3, 'departure must not snap to HOME');

  until(
    visitors,
    () => {
      const state = visitors.snapshot('roamer');
      return (
        state?.phase === 'arrive' &&
        state.routeIndex === 0 &&
        Math.hypot(
          state.x - VISITOR_ROUTE[0][0],
          state.z - VISITOR_ROUTE[0][1],
        ) > 0.15
      );
    },
    20,
  );
  const arrived = visitors.snapshot('roamer')!;
  const distance = Math.hypot(
    arrived.x - VISITOR_ROUTE[0][0],
    arrived.z - VISITOR_ROUTE[0][1],
  );
  assert.equal(visitors.prompt('roamer'), true);
  until(visitors, () => visitors.snapshot('roamer')?.phase === 'depart', 1);
  advance(visitors, 0.1);
  const reversed = visitors.snapshot('roamer')!;
  assert.ok(
    Math.hypot(
      reversed.x - VISITOR_ROUTE[0][0],
      reversed.z - VISITOR_ROUTE[0][1],
    ) < distance,
    'return must reverse toward the entrance, not continue deeper',
  );
});

void test('a closed destination recalls its surviving visitor and removes the stale target', () => {
  const visitors = createFactoryVisitors();
  visitors.update(sessions(['source', 'idle'], ['target', 'idle']));
  until(
    visitors,
    () =>
      visitors.snapshot('source')?.phase === 'visit' ||
      visitors.snapshot('target')?.phase === 'visit',
  );
  const source =
    visitors.snapshot('source')?.phase === 'visit' ? 'source' : 'target';
  const target = visitors.snapshot(source)!.targetId!;
  visitors.update(sessions([source, 'idle']));
  assert.equal(visitors.snapshot(target), null);
  assert.equal(visitors.snapshot(source)?.targetId, null);
  assert.equal(visitors.snapshot(source)?.phase, 'homecoming');
  assert.deepEqual(visitors.visitorsAt(target), []);
  assert.match(visitors.awayMessage(source), /^Returning to own workstation$/);
  until(visitors, () => !visitors.isAway(source), 5);
  assert.deepEqual(
    [visitors.snapshot(source)?.x, visitors.snapshot(source)?.z],
    HOME_ROUTE.at(-1),
  );
});

void test('active and closed visitors are recalled, closed sessions are removed, and reduced motion clears travel', () => {
  const visitors = createFactoryVisitors();
  visitors.update(sessions(['source', 'idle'], ['target', 'idle']));
  until(visitors, () => visitors.isAway('source') || visitors.isAway('target'));
  const id = visitors.isAway('source') ? 'source' : 'target';
  const other = id === 'source' ? 'target' : 'source';
  visitors.update(sessions([id, 'running'], [other, 'idle']));
  assert.equal(visitors.snapshot(id)?.phase, 'startled');
  advance(visitors, 0.2);
  visitors.update(sessions([other, 'idle']));
  assert.equal(
    visitors.snapshot(id),
    null,
    'authoritative hub removes a closed factory',
  );
  assert.deepEqual(visitors.visitorsAt(other), []);

  visitors.update(sessions(['one', 'idle'], ['two', 'idle']));
  until(visitors, () => visitors.isAway('one') || visitors.isAway('two'));
  visitors.setMotion(false);
  assert.equal(visitors.isAway('one'), false);
  assert.equal(visitors.isAway('two'), false);
  advance(visitors, 300);
  assert.equal(visitors.isAway('one'), false);
  visitors.dispose();
  assert.equal(visitors.snapshot('one'), null);
});

for (const [phase, activeStatus] of [
  ['arrive', 'running'],
  ['visit', 'compacting'],
] as const) {
  void test(`an idle visitor in ${phase} is shooed when its host starts ${activeStatus}`, () => {
    const visitors = createFactoryVisitors();
    const ids = ['aardvark', 'zebra'];
    visitors.update(sessions(['aardvark', 'idle'], ['zebra', 'idle']));
    const {source, target} = travelerAtPhase(visitors, ids, phase);
    assert.equal(source, 'aardvark');
    const before = visitors.snapshot(source)!;

    // aardvark sorts before zebra, exercising the final recall pass when it
    // is the visitor and its host status is applied later in update().
    visitors.update(sessions([source, 'idle'], [target, activeStatus]));
    const startled = visitors.snapshot(source)!;
    assert.equal(startled.phase, 'startled');
    assert.equal(startled.x, before.x, 'recall must preserve the current x');
    assert.equal(startled.z, before.z, 'recall must preserve the current z');
    assert.equal(startled.targetId, target);

    until(visitors, () => visitors.snapshot(source)?.phase === 'depart', 2);
    until(visitors, () => !visitors.isAway(source), 6);
    assert.deepEqual(
      [visitors.snapshot(source)?.x, visitors.snapshot(source)?.z],
      HOME_ROUTE.at(-1),
    );
    assert.equal(visitors.snapshot(source)?.targetId, null);
  });
}

void test('running and compacting hosts never receive new visitors regardless of hub order', () => {
  const orders: Array<Array<[string, string]>> = [
    [
      ['running-host', 'running'],
      ['idle-a', 'idle'],
      ['compacting-host', 'compacting'],
      ['idle-b', 'idle'],
    ],
    [
      ['idle-b', 'idle'],
      ['compacting-host', 'compacting'],
      ['idle-a', 'idle'],
      ['running-host', 'running'],
    ],
  ];

  for (const order of orders) {
    const visitors = createFactoryVisitors();
    visitors.update(sessions(...order));
    let sawTravel = false;
    for (let frame = 0; frame < 120 * 60; frame++) {
      visitors.tick(1 / 60);
      for (const id of ['idle-a', 'idle-b']) {
        const target = visitors.snapshot(id)?.targetId;
        if (target) sawTravel = true;
        assert.notEqual(target, 'running-host');
        assert.notEqual(target, 'compacting-host');
      }
    }
    assert.equal(
      sawTravel,
      true,
      'idle factories should still visit each other',
    );
  }
});

void test('a paused visitor freezes, reacts to host work in place, and returns after release', () => {
  const visitors = createFactoryVisitors();
  const ids = ['aardvark', 'zebra'];
  visitors.update(sessions(['aardvark', 'idle'], ['zebra', 'idle']));
  const {source, target} = travelerAtPhase(visitors, ids, 'arrive');
  assert.equal(visitorCaneId(source), `visitor:${source}`);

  const pausedArrival = visitors.snapshot(source);
  for (let second = 0; second < 120; second++) visitors.tick(1, [source]);
  assert.deepEqual(
    visitors.snapshot(source),
    pausedArrival,
    'position and phase timers must freeze while selected',
  );

  visitors.update(sessions([source, 'idle'], [target, 'running']));
  const recalled = visitors.snapshot(source)!;
  assert.equal(recalled.phase, 'startled');
  assert.equal(recalled.x, pausedArrival?.x);
  assert.equal(recalled.z, pausedArrival?.z);
  for (let second = 0; second < 120; second++) visitors.tick(1, [source]);
  assert.deepEqual(
    visitors.snapshot(source),
    recalled,
    'the recalled visitor must remain frozen until released',
  );

  until(visitors, () => !visitors.isAway(source), 6);
  assert.deepEqual(
    [visitors.snapshot(source)?.x, visitors.snapshot(source)?.z],
    HOME_ROUTE.at(-1),
  );
});

void test('closures and disabled motion clear paused travel immediately', () => {
  const ids = ['aardvark', 'zebra'];

  const closedSource = createFactoryVisitors();
  closedSource.update(sessions(['aardvark', 'idle'], ['zebra', 'idle']));
  const sourceTrip = travelerAtPhase(closedSource, ids, 'arrive');
  closedSource.tick(30, [sourceTrip.source]);
  closedSource.update(sessions([sourceTrip.target, 'idle']));
  assert.equal(closedSource.snapshot(sourceTrip.source), null);
  assert.deepEqual(closedSource.visitorsAt(sourceTrip.target), []);

  const closedTarget = createFactoryVisitors();
  closedTarget.update(sessions(['aardvark', 'idle'], ['zebra', 'idle']));
  const targetTrip = travelerAtPhase(closedTarget, ids, 'arrive');
  closedTarget.tick(30, [targetTrip.source]);
  closedTarget.update(sessions([targetTrip.source, 'idle']));
  const rerouted = closedTarget.snapshot(targetTrip.source)!;
  assert.equal(closedTarget.snapshot(targetTrip.target), null);
  assert.equal(rerouted.targetId, null);
  assert.equal(rerouted.phase, 'homecoming');
  closedTarget.tick(30, [targetTrip.source]);
  assert.deepEqual(closedTarget.snapshot(targetTrip.source), rerouted);
  until(closedTarget, () => !closedTarget.isAway(targetTrip.source), 6);

  const reducedMotion = createFactoryVisitors();
  reducedMotion.update(sessions(['aardvark', 'idle'], ['zebra', 'idle']));
  const motionTrip = travelerAtPhase(reducedMotion, ids, 'arrive');
  reducedMotion.tick(30, [motionTrip.source]);
  reducedMotion.setMotion(false);
  assert.equal(reducedMotion.isAway(motionTrip.source), false);
  assert.equal(reducedMotion.snapshot(motionTrip.source)?.targetId, null);
  assert.deepEqual(
    [
      reducedMotion.snapshot(motionTrip.source)?.x,
      reducedMotion.snapshot(motionTrip.source)?.z,
    ],
    HOME_ROUTE.at(-1),
  );
});
