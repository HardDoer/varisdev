import assert from 'node:assert/strict';
import type {ChildProcess} from 'node:child_process';
import {EventEmitter, getEventListeners} from 'node:events';
import {test, type TestContext} from 'node:test';
import {
  waitForDesktopStartup,
  type DesktopStartup,
} from '../src/desktop/startup.ts';

class StartupChild extends EventEmitter {
  readonly sent: unknown[] = [];
  readonly callbacks: Array<(error: Error | null) => void> = [];
  kills = 0;
  disconnects = 0;
  unrefs = 0;

  send(message: unknown, callback: (error: Error | null) => void) {
    this.sent.push(message);
    this.callbacks.push(callback);
    return true;
  }

  kill() {
    this.kills++;
    return true;
  }

  disconnect() {
    this.disconnects++;
  }

  unref() {
    this.unrefs++;
  }
}

const startup: DesktopStartup = {
  cwd: process.cwd(),
  agentDir: '/agent',
  sessionDir: '/sessions',
  entries: [],
  leafId: null,
  thinkingLevel: 'off',
  tools: ['read'],
  argv: [],
};

function handshake(t: TestContext) {
  t.mock.timers.enable({apis: ['setTimeout']});
  const child = new StartupChild();
  const controller = new AbortController();
  let status = 'pending';
  const done = waitForDesktopStartup(
    child as unknown as ChildProcess,
    startup,
    controller.signal,
  ).then(
    () => {
      status = 'ready';
      return undefined;
    },
    (error: Error) => {
      status = 'failed';
      return error;
    },
  );
  t.after(() => controller.abort());
  return {
    child,
    controller,
    done,
    get status() {
      return status;
    },
  };
}

function assertCleanedUp(child: StartupChild, controller: AbortController) {
  for (const event of ['message', 'error', 'exit'])
    assert.equal(child.listenerCount(event), 0, `${event} listener retained`);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
}

void test('startup interaction pauses the deadline until user response and still requires startup-ready', async t => {
  const current = handshake(t);
  const {child, controller, done} = current;
  child.emit('message', {type: 'startup-request'});
  assert.deepEqual(child.sent, [{type: 'startup', startup}]);
  t.mock.timers.tick(59_999);
  child.emit('message', {type: 'startup-interaction', waiting: true});
  t.mock.timers.tick(5 * 60_000);
  child.emit('message', {type: 'startup-interaction', waiting: true});
  t.mock.timers.tick(5 * 60_000);
  await Promise.resolve();
  assert.equal(current.status, 'pending');
  assert.equal(child.kills, 0);
  assert.equal(child.disconnects, 0);

  child.emit('message', {type: 'startup-interaction', waiting: false});
  t.mock.timers.tick(59_999);
  await Promise.resolve();
  assert.equal(current.status, 'pending');
  assert.equal(child.disconnects, 0);
  child.emit('message', {type: 'startup-ready'});
  assert.equal(await done, undefined);
  assert.equal(current.status, 'ready');
  assert.equal(child.disconnects, 1);
  assert.equal(child.unrefs, 1);
  assertCleanedUp(child, controller);

  // IPC completion can arrive after the ready message has settled the handoff.
  child.callbacks[0](new Error('late send error'));
  controller.abort();
  t.mock.timers.tick(5 * 60_000);
  assert.equal(child.kills, 0);
});

void test('startup remains bounded before interaction and ignores malformed interaction messages', async t => {
  const current = handshake(t);
  t.mock.timers.tick(30_000);
  for (const message of [
    null,
    'startup-ready',
    {},
    {type: 'startup-interaction'},
    {type: 'startup-interaction', waiting: 'true'},
    {type: 'startup-interaction', waiting: 1},
    {type: 'startup-interaction', waiting: false},
  ])
    current.child.emit('message', message);
  t.mock.timers.tick(29_999);
  await Promise.resolve();
  assert.equal(current.status, 'pending');
  t.mock.timers.tick(1);
  assert.match((await current.done)!.message, /within 60 seconds/);
  assert.equal(current.child.kills, 1);
  assertCleanedUp(current.child, current.controller);
});

void test('each closed prompt resumes a bounded full startup period without duplicate messages extending it', async t => {
  const current = handshake(t);
  const {child} = current;
  t.mock.timers.tick(59_999);
  child.emit('message', {type: 'startup-interaction', waiting: true});
  t.mock.timers.tick(5 * 60_000);
  child.emit('message', {type: 'startup-interaction', waiting: false});
  t.mock.timers.tick(59_999);
  child.emit('message', {type: 'startup-interaction', waiting: true});
  t.mock.timers.tick(5 * 60_000);
  child.emit('message', {type: 'startup-interaction', waiting: false});
  t.mock.timers.tick(59_999);
  await Promise.resolve();
  assert.equal(current.status, 'pending');
  child.emit('message', {type: 'startup-interaction', waiting: false});
  t.mock.timers.tick(1);
  assert.match((await current.done)!.message, /within 60 seconds/);
  assert.equal(child.kills, 1);
  assert.equal(child.disconnects, 0);
  assertCleanedUp(child, current.controller);
});

const failures = [
  {
    name: 'cancellation',
    fail: (_child: StartupChild, controller: AbortController) =>
      controller.abort(),
    message: /Desktop startup cancelled/,
  },
  {
    name: 'child exit',
    fail: (child: StartupChild) => child.emit('exit', 1),
    message: /Desktop exited during startup \(1\)/,
  },
  {
    name: 'child error',
    fail: (child: StartupChild) =>
      child.emit('error', new Error('spawn failed')),
    message: /spawn failed/,
  },
  {
    name: 'startup error',
    fail: (child: StartupChild) =>
      child.emit('message', {type: 'startup-error', error: 'adoption failed'}),
    message: /adoption failed/,
  },
  {
    name: 'transfer send error',
    fail: (child: StartupChild) => child.callbacks[0](new Error('send failed')),
    message: /send failed/,
  },
];

for (const failure of failures) {
  void test(`${failure.name} settles startup while interaction is waiting and clears handlers`, async t => {
    const current = handshake(t);
    const {child, controller} = current;
    child.emit('message', {type: 'startup-request'});
    child.emit('message', {type: 'startup-interaction', waiting: true});
    t.mock.timers.tick(5 * 60_000);
    failure.fail(child, controller);
    assert.match((await current.done)!.message, failure.message);
    assert.equal(current.status, 'failed');
    assertCleanedUp(child, controller);

    child.emit('message', {type: 'startup-ready'});
    child.emit('exit', 2);
    child.callbacks[0](new Error('late send error'));
    controller.abort();
    t.mock.timers.tick(5 * 60_000);
    assert.equal(child.kills, 1);
    assert.equal(child.disconnects, 0);
    assert.equal(child.unrefs, 0);
  });
}

void test('an already cancelled launch settles without retaining a deadline or handlers', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const child = new StartupChild();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    waitForDesktopStartup(
      child as unknown as ChildProcess,
      startup,
      controller.signal,
    ),
    /Desktop startup cancelled/,
  );
  assertCleanedUp(child, controller);
  t.mock.timers.tick(5 * 60_000);
  assert.equal(child.kills, 1);
});
