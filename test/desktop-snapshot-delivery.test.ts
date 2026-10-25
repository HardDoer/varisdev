import assert from 'node:assert/strict';
import type {ChildProcess} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {
  DashboardState,
  type DashboardSnapshot,
} from '../src/dashboard/state.ts';
import {
  createFactoryBridge,
  type FactoryControl,
} from '../src/desktop/launcher.ts';

class BackpressuredChild extends EventEmitter {
  connected = true;
  readonly snapshots: DashboardSnapshot[] = [];
  readonly acknowledgements: Array<() => void> = [];

  send(
    message: {type: string; snapshot?: DashboardSnapshot},
    done: () => void,
  ) {
    if (message.type === 'snapshot') {
      this.snapshots.push(message.snapshot!);
      this.acknowledgements.push(done);
    } else done();
    return false;
  }

  acknowledge() {
    const done = this.acknowledgements.shift();
    assert.ok(done, 'A snapshot must be in flight');
    done();
  }
}

function state() {
  const at = '2026-01-01T12:00:00.000Z';
  return new DashboardState({
    id: 'parent',
    name: 'Parent',
    cwd: process.cwd(),
    status: 'idle',
    activity: 'Ready',
    startedAt: at,
    updatedAt: at,
  });
}

const control: FactoryControl = {
  prompt: async () => {},
  abort: async () => ({steering: [], followUp: []}),
  cancelAgent: async () => {},
  features: async () => ({
    commands: [],
    models: [],
    thinkingLevel: 'off',
    thinkingLevels: [],
    tools: [],
    diagnostics: [],
  }),
  configure: async () => {},
  compact: async () => {},
  reload: async () => {},
};

void test('a prompt snapshot resumed after backpressure consumes the pending flush', t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const child = new BackpressuredChild();
  const bridge = createFactoryBridge(child as unknown as ChildProcess);
  t.after(() => bridge.detach());
  const current = state();
  current.updateConversation({
    id: 'retained-tool',
    role: 'tool',
    toolName: 'read',
    text: 'Retained tool output\n'.repeat(100_000),
    at: '2026-01-01T12:00:00.000Z',
    status: 'completed',
  });
  bridge.attach(current, control);
  bridge.ready();
  assert.equal(child.snapshots.length, 1);

  current.updateConversation({
    id: 'submitted-prompt',
    role: 'user',
    text: 'Continue the work',
    at: '2026-01-01T12:00:01.000Z',
  });
  t.mock.timers.tick(80); // The first flush encounters the busy transport.
  current.updateSession({status: 'running', activity: 'Thinking'});
  child.acknowledge(); // Resume with the latest state, including the prompt.
  assert.equal(child.snapshots.length, 2);
  assert.equal(child.snapshots[1].conversation.at(-1)?.id, 'submitted-prompt');
  assert.equal(child.snapshots[1].session.activity, 'Thinking');
  child.acknowledge();
  t.mock.timers.tick(80);
  assert.equal(
    child.snapshots.length,
    2,
    'The pending timer must not serialize the same complete thread again',
  );

  current.updateSession({activity: 'Responding'});
  t.mock.timers.tick(80);
  assert.equal(child.snapshots.length, 3);
  assert.equal(child.snapshots[2].session.activity, 'Responding');
  child.acknowledge();
});

void test('changes arriving before an in-flight snapshot flush retain their scheduled delivery', t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const child = new BackpressuredChild();
  const bridge = createFactoryBridge(child as unknown as ChildProcess);
  t.after(() => bridge.detach());
  const current = state();
  bridge.attach(current, control);
  bridge.ready();
  current.updateSession({activity: 'Starting'});
  t.mock.timers.tick(40);
  child.acknowledge();
  assert.equal(child.snapshots.length, 1);
  t.mock.timers.tick(40);
  assert.equal(child.snapshots.length, 2);
  assert.equal(child.snapshots[1].session.activity, 'Starting');
  child.acknowledge();
});
