import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {AgentSessionController} from '../src/agents/team.ts';

function inbox(sessionId = 'parent') {
  const control = new AgentSessionController({
    on() {},
  } as unknown as ExtensionAPI);
  const ctx = {
    hasUI: false,
    sessionManager: {getSessionId: () => sessionId},
  } as unknown as ExtensionContext;
  const team = control.getTeam(ctx);
  const store = (message: string) =>
    team.storeMessage({from: {id: 'worker', name: 'Reporter'}, message});
  const page = (after: number, limit?: number) => {
    const result = team.listMessages({
      after,
      ...(limit === undefined ? {} : {limit}),
    });
    assert.ok('nextAfter' in result);
    return result;
  };
  return {team, store, page};
}

void test('inbox cursor pages in arrival order while messages arrive', () => {
  const {team, store, page} = inbox();
  const messages = Array.from({length: 25}, (_, i) => store(`Update ${i + 1}`));
  const first = page(0);
  assert.deepEqual(first, {
    messages: messages.slice(0, 10),
    nextAfter: 10,
    hasMore: true,
  });
  messages.push(store('Update 26'), store('Update 27'));
  const second = page(first.nextAfter);
  assert.deepEqual(second, {
    messages: messages.slice(10, 20),
    nextAfter: 20,
    hasMore: true,
  });
  const last = page(second.nextAfter);
  assert.deepEqual(last, {
    messages: messages.slice(20),
    nextAfter: 27,
    hasMore: false,
  });
  assert.deepEqual(team.listMessages({offset: 5, limit: 2}), {
    total: 27,
    offset: 5,
    nextOffset: 7,
    messages: [messages[21], messages[20]],
  });
});

void test('empty cursor reads retain their position for later arrivals', () => {
  const {store, page} = inbox();
  assert.deepEqual(page(0), {messages: [], nextAfter: 0, hasMore: false});
  const first = store('First');
  assert.deepEqual(page(0), {
    messages: [first],
    nextAfter: 1,
    hasMore: false,
  });
  assert.deepEqual(page(1), {messages: [], nextAfter: 1, hasMore: false});
  const second = store('Second');
  assert.deepEqual(page(1), {
    messages: [second],
    nextAfter: 2,
    hasMore: false,
  });
});

void test('inbox cursor reports evicted messages and resumes from retained history', () => {
  const {store, page} = inbox();
  const messages = Array.from({length: 105}, (_, i) =>
    store(`Update ${i + 1}`),
  );
  assert.deepEqual(page(0, 2), {
    messages: messages.slice(5, 7),
    nextAfter: 7,
    hasMore: true,
    missed: 5,
  });
  assert.deepEqual(page(3, 1), {
    messages: [messages[5]],
    nextAfter: 6,
    hasMore: true,
    missed: 2,
  });
  assert.deepEqual(page(5, 1), {
    messages: [messages[5]],
    nextAfter: 6,
    hasMore: true,
  });
  assert.deepEqual(page(104), {
    messages: [messages[104]],
    nextAfter: 105,
    hasMore: false,
  });
});

void test('inbox cursor reads are replayable and preserve full message lookup', () => {
  const {team, store, page} = inbox();
  const message = store('Full finding '.repeat(100));
  const first = page(0);
  assert.deepEqual(page(0), first);
  assert.deepEqual(team.getMessage(message.id), message);
  first.messages[0].from.name = 'Changed';
  first.messages[0].message = 'Changed';
  assert.deepEqual(page(0).messages, [message]);
  assert.deepEqual(team.getMessage(message.id), message);
  assert.deepEqual(team.listMessages(), {
    total: 1,
    offset: 0,
    nextOffset: undefined,
    messages: [message],
  });
});

void test('inbox cursor validates positions, page sizes, and incompatible offsets', () => {
  const {team, store} = inbox();
  store('One');
  for (const after of [
    -1,
    0.5,
    NaN,
    Infinity,
    2,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () => team.listMessages({after}),
      /cursor must be a safe integer/,
    );
  }
  for (const limit of [0, 21, 1.5, NaN]) {
    assert.throws(
      () => team.listMessages({after: 0, limit}),
      /limit must be 1 to 20/,
    );
  }
  assert.throws(
    () => team.listMessages({after: 0, offset: 0}),
    /cursor cannot be combined with offset/,
  );
  assert.equal(team.listMessages({after: 1, limit: 20}).messages.length, 0);
});

void test('a future cursor from another parent session is rejected', () => {
  const first = inbox('first');
  first.store('One');
  first.store('Two');
  const cursor = first.page(0).nextAfter;
  const second = inbox('second');
  second.store('Different session');
  assert.throws(() => second.page(cursor), /in this workspace/);
  assert.deepEqual(
    second.page(0).messages.map(message => message.message),
    ['Different session'],
  );
});
