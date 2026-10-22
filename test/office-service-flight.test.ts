import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  officeRepairFlight,
  officeCleanupFlight,
} from '../assets/dashboard/office-service-flight.js';
import {createRobotDamage} from '../assets/dashboard/robot-damage.js';
import {iso} from '../assets/dashboard/year1998-geometry.js';

void test('office repair flights enter above the viewport and descend without crossing walls', () => {
  for (const top of [-500, -150, 0]) {
    for (const site of [
      {x: -11.8, z: -6.4, h: 30},
      {x: 9, z: 5, h: 0},
      {x: -5, z: 0, h: 22},
    ]) {
      const entry = officeRepairFlight(site, {botProgress: 0}, top);
      assert.ok(iso(entry[0], entry[2], entry[1])[1] + 40 < top);
      let previousHeight = entry[1];
      for (let i = 1; i <= 20; i++) {
        const current = officeRepairFlight(site, {botProgress: i / 20}, top);
        assert.equal(current[0], entry[0]);
        assert.equal(current[2], entry[2]);
        assert.ok(current[0] > -11.8 && current[0] < 9.2);
        assert.ok(current[2] > -6.4 && current[2] < 5.5);
        assert.ok(current[1] < previousHeight);
        assert.ok(current[1] > site.h);
        previousHeight = current[1];
      }
    }
  }
});

void test('office cleanup lowers a crane, lifts the wreck and carries it offscreen before replacement', () => {
  const damage = createRobotDamage();
  const home = [-7, 0];
  const top = -260;
  for (let i = 0; i < 4; i++) damage.hit('parent', 1, 2.2);
  let previous: ReturnType<typeof officeCleanupFlight> = null;
  let arrivals = 0,
    pickups = 0,
    departures = 0;
  for (let frame = 0; frame < 600; frame++) {
    damage.tick(1 / 60);
    const pose = damage.pose('parent');
    const flight = officeCleanupFlight(home, pose, top);
    if (flight) {
      if (pose.cleanup?.phase === 'arrive') {
        if (!arrivals)
          assert.ok(
            iso(flight.position[0], flight.position[2], flight.position[1])[1] +
              40 <
              top,
          );
        assert.equal(flight.wreckLift, 0);
        arrivals++;
      } else if (pose.cleanup?.phase === 'load') {
        assert.ok(Math.abs(flight.position[1] - 25) < 1e-8);
        assert.ok(flight.wreckLift >= 0 && flight.wreckLift <= 8);
        pickups++;
      } else {
        assert.ok(flight.wreckLift >= 8);
        assert.ok(Math.abs(flight.position[1] - flight.wreckLift - 17) < 1e-8);
        departures++;
      }
      if (previous) {
        assert.equal(flight.position[0], previous.position[0]);
        assert.equal(flight.position[2], previous.position[2]);
        assert.ok(Math.abs(flight.position[1] - previous.position[1]) < 5);
        assert.ok(
          Math.abs(flight.cableLength - previous.cableLength) < 1,
          'The crane lowers its hook continuously into pickup',
        );
      }
      previous = flight;
    } else if (pose.phase === 'replacing') {
      assert.ok(previous);
      const wreckY = iso(home[0], home[1], previous.wreckLift)[1];
      assert.ok(wreckY + 40 < top, 'The entire wreck clears the viewport');
      break;
    }
  }
  assert.ok(arrivals > 60 && pickups > 40 && departures > 100);
});

void test('departed service bots stay beyond the screen when the viewport grows', () => {
  const site = {x: -7, z: 0, h: 22};
  const repairRoute = {exited: false};
  const repairPose = {botProgress: 0.3, phase: 'leaving'};
  officeRepairFlight(site, repairPose, -150, repairRoute);
  assert.equal(repairRoute.exited, true);
  const repair = officeRepairFlight(site, repairPose, -500, repairRoute);
  assert.ok(iso(repair[0], repair[2], repair[1])[1] + 50 < -500);
  const recalled = officeRepairFlight(
    site,
    {...repairPose, phase: 'arriving'},
    -500,
    repairRoute,
  );
  assert.deepEqual(
    recalled,
    repair,
    'Recalling a crew preserves its position after resizing',
  );
  const returned = officeRepairFlight(
    site,
    {phase: 'repairing', botProgress: 1},
    -500,
    repairRoute,
  );
  assert.equal(
    returned[1],
    34,
    'The recalled crew reaches the original working height',
  );
  assert.equal(
    repairRoute.exited,
    false,
    'A renewed hit can recall a departed repair bot',
  );

  const cleanupRoute = {exited: false};
  const pose = {
    offset: [0, 0, 0],
    phaseAge: 5.03,
    cleanup: {phase: 'leave', grip: 1},
  };
  officeCleanupFlight([-7, 0], pose, -150, cleanupRoute);
  assert.equal(cleanupRoute.exited, true);
  const flight = officeCleanupFlight([-7, 0], pose, -500, cleanupRoute);
  assert.ok(flight);
  assert.ok(iso(-7, 0, flight.wreckLift)[1] + 40 < -500);
});
