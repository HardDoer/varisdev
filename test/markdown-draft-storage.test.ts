import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  createDraftStore,
  flushDrafts,
} from '../assets/dashboard/draft-storage.js';

void test('draft writes debounce, flush explicitly, and retain the last durable copy after a failure', t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const content = new Map<string, string>();
  let writes = 0;
  let failWrites = false;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => content.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (failWrites) throw new Error('Storage full');
        writes++;
        content.set(key, value);
      },
      removeItem: (key: string) => content.delete(key),
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  const errors: unknown[] = [];
  const store = createDraftStore('drafts', {
    debounceMs: 200,
    validate: (id: unknown, value: unknown) =>
      typeof id === 'string' && typeof value === 'string',
    onError: (error: unknown) => errors.push(error),
  });
  store.save('first', 'one');
  store.save('first', 'two');
  store.save('second', 'three');
  t.mock.timers.tick(199);
  assert.equal(writes, 0);

  assert.equal(store.flush(), true);
  assert.equal(writes, 1);
  assert.deepEqual(JSON.parse(content.get('drafts') || ''), [
    ['first', 'two'],
    ['second', 'three'],
  ]);
  t.mock.timers.tick(1);
  assert.equal(writes, 1, 'an explicit flush cancels the pending write');

  store.save('first', 'newest');
  store.save('third', 'unsaved document');
  failWrites = true;
  t.mock.timers.tick(200);
  assert.equal(errors.length, 1);
  assert.throws(flushDrafts, /Unsaved drafts could not be stored for restart/);
  assert.deepEqual(
    JSON.parse(content.get('drafts') || ''),
    [
      ['first', 'two'],
      ['second', 'three'],
    ],
    'a failed write leaves the last durable drafts intact',
  );
  assert.equal(store.get('first'), 'newest');
  assert.equal(store.get('third'), 'unsaved document');

  failWrites = false;
  assert.doesNotThrow(flushDrafts);
  assert.deepEqual(JSON.parse(content.get('drafts') || ''), [
    ['first', 'newest'],
    ['second', 'three'],
    ['third', 'unsaved document'],
  ]);
});
