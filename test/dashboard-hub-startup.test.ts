import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {test} from 'node:test';

void test('an empty desktop dashboard starts without loading the Pi SDK', async t => {
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (/^@earendil-works\/pi-(ai|coding-agent|tui)(\/|$)/.test(specifier))
        throw new Error(`The empty dashboard loaded ${specifier}`);
      return next(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  const {DashboardHub} = await import('../src/dashboard/hub.ts');
  const hub = new DashboardHub(undefined, async () => {
    assert.fail('Starting an empty dashboard must not create a parent.');
  });
  t.after(() => hub.close());
  assert.deepEqual(hub.snapshot().sessions, []);
  assert.equal(hub.snapshot().startup, undefined);
  assert.deepEqual(hub.workStates(), []);
  assert.deepEqual(hub.restartSnapshots(), []);
  await hub.close();
});

void test('closing during the deferred startup UI import cancels tracked parent creation', async t => {
  const {DashboardHub} = await import('../src/dashboard/hub.ts');
  let factoryCalls = 0;
  const hub = new DashboardHub(undefined, async () => {
    factoryCalls++;
    throw new Error('The cancelled startup reached its parent factory.');
  });
  t.after(() => hub.close());
  const opening = hub.startParent({cwd: process.cwd()});
  const rejected = assert.rejects(opening, /abort|closed/i);
  assert.throws(() => hub.restartSnapshots(), /still starting/);
  assert.deepEqual(hub.workStates(), []);
  assert.equal(hub.snapshot().startup, undefined);
  // Let startup reach its dynamic import before closing the dashboard.
  await Promise.resolve();
  const closing = hub.close();
  assert.equal(hub.close(), closing);
  await Promise.all([closing, rejected]);
  assert.equal(factoryCalls, 0);
  assert.deepEqual(hub.snapshot().sessions, []);
  assert.equal(hub.snapshot().startup, undefined);
  await assert.rejects(hub.startParent({cwd: process.cwd()}), /closed/);
});
