import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DashboardState} from '../src/dashboard/state.ts';
import type {AgentRecord} from '../src/agents/orchestrator.ts';
import {
  isPrimaryAgent,
  primaryUnit,
  primaryUnits,
} from '../assets/dashboard/scene-primary.js';

const agent = (id: string, createdAt: string, agentMode = 'primary') => ({
  id,
  createdAt,
  agentMode,
  status: 'idle',
  resumable: true,
});
const starter = {id: 'workspace', status: 'idle', primaryClosed: false};
const older = agent('older', '2026-01-01T00:00:00Z');
const middle = agent('middle', '2026-01-02T00:00:00Z');
const newest = agent('newest', '2026-01-03T00:00:00Z');

void test('the starter owns the large robot while present regardless of agent creation order', () => {
  const data = {session: starter, agents: [middle, older, newest]};
  assert.deepEqual(primaryUnit(data), {id: 'parent', unit: starter});
  assert.deepEqual(
    primaryUnits(data).map(item => item.id),
    ['parent', 'newest', 'middle', 'older'],
  );
  assert.deepEqual(data.agents, [middle, older, newest]);
});

void test('root closure promotes the second most recently created remaining primary', () => {
  for (const session of [
    {...starter, primaryClosed: true},
    {...starter, status: 'closed'},
  ]) {
    const data = {session, agents: [newest, older, middle]};
    assert.deepEqual(
      primaryUnits(data).map(item => item.id),
      ['newest', 'middle', 'older'],
    );
    assert.deepEqual(primaryUnit(data), {id: 'middle', unit: middle});
    data.agents = [newest, older];
    assert.deepEqual(primaryUnit(data), {id: 'older', unit: older});
    data.agents = [newest];
    assert.deepEqual(primaryUnit(data), {id: 'newest', unit: newest});
    data.agents = [];
    assert.equal(primaryUnit(data), undefined);
  }
});

void test('all and legacy modes are primaries; subagents and closed conversations cannot be promoted', () => {
  const all = {...middle, agentMode: 'all'};
  const legacy = {...older, agentMode: undefined};
  const subagent = {...newest, agentMode: 'subagent'};
  const cleaned = {...newest, id: 'cleaned', resumable: false};
  const closed = {...newest, id: 'closed', status: 'closed'};
  const data = {
    session: {...starter, primaryClosed: true},
    agents: [subagent, cleaned, legacy, closed, all],
  };
  assert.ok(isPrimaryAgent(all));
  assert.ok(isPrimaryAgent(legacy));
  assert.equal(isPrimaryAgent(subagent), false);
  assert.deepEqual(
    primaryUnits(data).map(item => item.id),
    ['middle', 'older'],
  );
  assert.equal(primaryUnit(data)?.unit, legacy);
  assert.equal(
    primaryUnit({session: data.session, agents: [subagent]}),
    undefined,
  );
  assert.equal(primaryUnit(undefined), undefined);
});

void test('equal creation times use immutable IDs for older snapshots, including missing timestamps', () => {
  const first = {...newest, id: 'first'};
  const second = {...newest, id: 'second'};
  const third = {...newest, id: 'third'};
  const data = {
    session: {...starter, status: 'closed'},
    agents: [first, second, third],
  };
  assert.deepEqual(
    primaryUnits(data).map(item => item.id),
    ['third', 'second', 'first'],
  );
  assert.equal(primaryUnit(data)?.unit, second);
  data.agents.reverse();
  assert.deepEqual(
    primaryUnits(data).map(item => item.id),
    ['third', 'second', 'first'],
  );
  assert.deepEqual(
    primaryUnits({
      agents: data.agents.map(unit => ({...unit, createdAt: undefined})),
    }).map(item => item.id),
    ['third', 'second', 'first'],
  );
});

void test('same-timestamp primaries keep creation order through dashboard completion, sorting and restoration', () => {
  const at = '2026-01-01T00:00:00Z';
  const state = new DashboardState({
    ...starter,
    status: 'idle',
    primaryClosed: true,
    name: 'Workspace',
    cwd: '/project',
    activity: 'Primary agent closed',
    startedAt: at,
    updatedAt: at,
  });
  const records = ['z-first', 'a-second', 'b-third'].map((id): AgentRecord => ({
    id,
    name: id,
    agentMode: 'primary',
    status: 'running',
    resumable: true,
    createdAt: at,
    cwd: '/project',
    model: 'fixture/model',
    task: 'Continue work',
    activity: 'Working',
  }));
  state.updateTeam(records, []);
  assert.equal(primaryUnit(state.snapshot())?.id, 'a-second');
  records[0].status = 'completed';
  records[0].finishedAt = '2026-01-01T00:01:00Z';
  state.updateTeam(records, []);
  assert.deepEqual(
    state.snapshot().agents.map(unit => unit.id),
    ['a-second', 'b-third', 'z-first'],
  );
  assert.equal(primaryUnit(state.snapshot())?.id, 'a-second');
  records[1].status = 'cancelled';
  records[1].finishedAt = '2026-01-01T00:02:00Z';
  state.updateTeam(records, []);
  assert.equal(primaryUnit(state.snapshot())?.id, 'a-second');

  const saved = state.snapshot();
  const restored = new DashboardState(saved.session);
  restored.updateTeam(saved.agents, [], true);
  assert.equal(primaryUnit(restored.snapshot())?.id, 'a-second');
  restored.updateTeam([...saved.agents].reverse(), [], true);
  assert.equal(primaryUnit(restored.snapshot())?.id, 'a-second');
});
