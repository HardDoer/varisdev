import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DashboardState} from '../src/dashboard/state.ts';
import type {AgentRecord} from '../src/agents/orchestrator.ts';
import {
  isPrimaryAgent,
  mainUnit,
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

void test('the fixed Main agent remains the scene root regardless of agent creation order', () => {
  const data = {session: starter, agents: [middle, older, newest]};
  assert.deepEqual(mainUnit(data), {id: 'parent', unit: starter});
  assert.deepEqual(primaryUnit(data), {id: 'parent', unit: starter});
  assert.deepEqual(
    primaryUnits(data).map(item => item.id),
    ['parent', 'newest', 'middle', 'older'],
  );
  assert.deepEqual(data.agents, [middle, older, newest]);
});

void test('legacy primaryClosed cannot remove Main or rewrite supplied state text', () => {
  const marked = {
    ...starter,
    primaryClosed: true,
    activity: 'Closed',
  };
  const markedData = {session: marked, agents: [newest, older, middle]};
  assert.deepEqual(mainUnit(markedData), {
    id: 'parent',
    unit: {...marked, primaryClosed: false},
  });
  assert.equal(mainUnit(markedData)?.unit.status, 'idle');
  assert.equal(mainUnit(markedData)?.unit.activity, 'Closed');

  const disconnected = {
    ...starter,
    status: 'closed',
    activity: 'Terminal disconnected',
  };
  const disconnectedData = {
    session: disconnected,
    agents: [newest, older, middle],
  };
  assert.equal(mainUnit(disconnectedData)?.unit, disconnected);
  assert.equal(mainUnit(disconnectedData)?.unit.status, 'closed');
  assert.equal(
    mainUnit(disconnectedData)?.unit.activity,
    'Terminal disconnected',
  );
  assert.deepEqual(
    primaryUnits(disconnectedData).map(item => item.id),
    ['parent', 'newest', 'middle', 'older'],
  );
  disconnectedData.agents = [];
  assert.equal(primaryUnit(disconnectedData)?.id, 'parent');
});

void test('primary role classification stays separate from availability filtering', () => {
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
  assert.ok(isPrimaryAgent(cleaned));
  assert.ok(isPrimaryAgent(closed));
  assert.equal(isPrimaryAgent(subagent), false);
  assert.equal(isPrimaryAgent(undefined), false);
  assert.deepEqual(
    primaryUnits(data).map(item => item.id),
    ['parent', 'middle', 'older'],
  );
  assert.equal(primaryUnit(data)?.id, 'parent');
  assert.equal(primaryUnit({agents: [subagent]}), undefined);
  assert.equal(primaryUnit(undefined), undefined);
  assert.equal(mainUnit(undefined), undefined);
});

void test('additional primaries retain creation time, creation order and id ordering', () => {
  const first = {...newest, id: 'first', creationOrder: 1};
  const second = {...newest, id: 'second', creationOrder: 3};
  const third = {...newest, id: 'third', creationOrder: 2};
  const data = {
    session: {...starter, status: 'closed'},
    agents: [first, second, third],
  };
  assert.deepEqual(
    primaryUnits(data).map(item => item.id),
    ['parent', 'second', 'third', 'first'],
  );
  data.agents.reverse();
  assert.deepEqual(
    primaryUnits(data).map(item => item.id),
    ['parent', 'second', 'third', 'first'],
  );
  assert.deepEqual(
    primaryUnits({
      agents: data.agents.map(unit => ({
        ...unit,
        createdAt: undefined,
        creationOrder: undefined,
      })),
    }).map(item => item.id),
    ['third', 'second', 'first'],
  );
});

void test('dashboard completion and restoration preserve Main and additional ordering', () => {
  const at = '2026-01-01T00:00:00Z';
  const state = new DashboardState({
    ...starter,
    status: 'idle',
    primaryClosed: true,
    name: 'Workspace',
    cwd: '/project',
    activity: 'Legacy closed marker',
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
  assert.equal(primaryUnit(state.snapshot())?.id, 'parent');
  assert.deepEqual(
    primaryUnits(state.snapshot()).map(unit => unit.id),
    ['parent', 'b-third', 'a-second', 'z-first'],
  );
  records[0].status = 'completed';
  records[0].finishedAt = '2026-01-01T00:01:00Z';
  state.updateTeam(records, []);
  records[1].status = 'cancelled';
  records[1].finishedAt = '2026-01-01T00:02:00Z';
  state.updateTeam(records, []);
  assert.deepEqual(
    primaryUnits(state.snapshot()).map(unit => unit.id),
    ['parent', 'b-third', 'a-second', 'z-first'],
  );

  const saved = state.snapshot();
  const restored = new DashboardState(saved.session);
  restored.updateTeam(saved.agents, [], true);
  assert.deepEqual(
    primaryUnits(restored.snapshot()).map(unit => unit.id),
    ['parent', 'b-third', 'a-second', 'z-first'],
  );
  restored.updateTeam([...saved.agents].reverse(), [], true);
  assert.deepEqual(
    primaryUnits(restored.snapshot()).map(unit => unit.id),
    ['parent', 'b-third', 'a-second', 'z-first'],
  );
});
