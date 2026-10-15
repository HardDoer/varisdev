import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {test} from 'node:test';

import {initAgentControls} from '../assets/dashboard/agent-controls.js';

class FakeElement {
  hidden = false;
  disabled = false;
  textContent = '';
  attributes = new Map<string, string>();
  listeners = new Map<string, () => void>();

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener);
  }

  click() {
    if (!this.disabled) this.listeners.get('click')?.();
  }
}

function elements() {
  return Object.fromEntries(
    [
      'cancel-all-agents',
      'cancel-agent',
      'remove-agent',
      'cancel-all-agents-error',
      'cancel-agent-error',
    ].map(id => [id, new FakeElement()]),
  );
}

function agent(id: string, status: string) {
  return {id, name: `${id} name`, status};
}

function hub() {
  return {
    launchCwd: '/project',
    sessions: [
      {
        session: {
          id: 'parent-one',
          owned: true,
          controllable: true,
        },
        agents: [
          agent('queued', 'queued'),
          agent('running', 'running'),
          agent('cancelling', 'cancelling'),
          agent('completed', 'completed'),
          agent('failed', 'failed'),
          agent('cancelled', 'cancelled'),
        ],
        totalAgents: 6,
      },
    ],
  };
}

void test('finished agents can be dismissed from one parent and return if resumed', async t => {
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    'document',
  );
  const originalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    'localStorage',
  );
  t.after(() => {
    if (originalDocument)
      Object.defineProperty(globalThis, 'document', originalDocument);
    else delete (globalThis as {document?: Document}).document;
    if (originalStorage)
      Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else delete (globalThis as {localStorage?: Storage}).localStorage;
  });

  const stored = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  };
  const nodes = elements();
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {getElementById: (id: string) => nodes[id]},
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: localStorage,
  });

  let current = hub();
  let selected = 'running';
  let cancelError = false;
  const cancelled: [string, string][] = [];
  let refreshed = 0;
  const controls = initAgentControls({
    api: {
      async cancelAgent(sessionId: string, agentId: string) {
        cancelled.push([sessionId, agentId]);
        if (cancelError) throw new Error('Could not stop agent');
      },
    },
    selected: () => current.sessions[0],
    selectedAgent: () => selected,
    refresh: () => refreshed++,
    removed: () => {
      current = controls.filterHub(current);
      if (!current.sessions[0].agents.some(item => item.id === selected))
        selected = 'parent';
    },
  });

  for (const id of ['queued', 'running', 'cancelling']) {
    selected = id;
    controls.render();
    assert.equal(nodes['remove-agent'].hidden, true);
    assert.equal(nodes['remove-agent'].disabled, true);
  }
  for (const id of ['completed', 'failed', 'cancelled']) {
    selected = id;
    controls.render();
    assert.equal(nodes['remove-agent'].hidden, false);
    assert.equal(nodes['remove-agent'].disabled, false);
    assert.equal(
      nodes['remove-agent'].attributes.get('aria-label'),
      `Remove agent ${id} name`,
    );
  }

  selected = 'queued';
  controls.render();
  nodes['cancel-agent'].click();
  await setImmediate();
  nodes['cancel-all-agents'].click();
  await setImmediate();
  assert.deepEqual(cancelled, [
    ['parent-one', 'queued'],
    ['parent-one', 'all'],
  ]);
  assert.equal(refreshed, 2);

  selected = 'running';
  cancelError = true;
  controls.render();
  nodes['cancel-agent'].click();
  await setImmediate();
  assert.equal(nodes['cancel-agent-error'].hidden, false);
  assert.equal(nodes['cancel-agent-error'].textContent, 'Could not stop agent');

  current = {
    ...current,
    sessions: [
      {
        ...current.sessions[0],
        agents: current.sessions[0].agents.map(item =>
          item.id === 'running' ? {...item, status: 'failed'} : item,
        ),
      },
    ],
  };
  controls.render();
  assert.equal(nodes['cancel-agent-error'].hidden, true);
  assert.equal(nodes['remove-agent'].hidden, false);

  const source = current;
  const unfiltered = structuredClone(current);
  nodes['remove-agent'].click();
  assert.equal(selected, 'parent');
  assert.equal(current.sessions[0].agents.length, 5);
  assert.equal(current.sessions[0].totalAgents, 5);
  assert.deepEqual(source, unfiltered);
  assert.deepEqual(
    unfiltered.sessions[0].agents,
    hub().sessions[0].agents.map(item =>
      item.id === 'running' ? {...item, status: 'failed'} : item,
    ),
  );
  assert.equal(controls.filterHub(current).sessions[0].totalAgents, 5);
  assert.match(
    stored.get('varisdev.dismissed-agents.v1') ?? '',
    /parent-one.*running/,
  );

  const reloadNodes = elements();
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {getElementById: (id: string) => reloadNodes[id]},
  });
  const reloaded = initAgentControls({
    api: undefined,
    selected: () => undefined,
    selectedAgent: () => 'parent',
    refresh: () => {},
  });
  const otherParent = {
    ...unfiltered.sessions[0],
    session: {...unfiltered.sessions[0].session, id: 'parent-two'},
  };
  const acrossParents = reloaded.filterHub({
    ...unfiltered,
    sessions: [unfiltered.sessions[0], otherParent],
  });
  assert.equal(acrossParents.sessions[0].agents.length, 5);
  assert.equal(acrossParents.sessions[0].totalAgents, 5);
  assert.equal(acrossParents.sessions[1].agents.length, 6);
  assert.equal(acrossParents.sessions[1].totalAgents, 6);

  const freshAgents = reloaded.filterHub({
    ...unfiltered,
    sessions: [
      {
        ...unfiltered.sessions[0],
        agents: [
          agent('fresh-one', 'running'),
          agent('fresh-two', 'completed'),
        ],
        totalAgents: 2,
      },
    ],
  });
  assert.equal(freshAgents.sessions[0].agents.length, 2);
  assert.equal(freshAgents.sessions[0].totalAgents, 2);

  const resumed = structuredClone(unfiltered);
  resumed.sessions[0].agents.find(item => item.id === 'running')!.status =
    'cancelling';
  const visibleAgain = reloaded.filterHub(resumed);
  assert.equal(visibleAgain.sessions[0].agents.length, 6);
  assert.equal(visibleAgain.sessions[0].totalAgents, 6);
  assert.equal(stored.has('varisdev.dismissed-agents.v1'), false);
});
