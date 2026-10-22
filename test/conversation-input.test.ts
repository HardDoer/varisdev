import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ConversationState, toolInput} from '../src/conversation.ts';

void test('operation inputs retain their argument keys and exact multiline values as JSON', () => {
  for (const args of [
    {path: 'tasks.md', content: '# Tasks\n\n- [ ] Verify\nLiteral: \\n'},
    {
      path: 'tasks.md',
      edits: [{oldText: '- [ ] Verify\n', newText: '- [x] Verify\n'}],
    },
    {command: 'printf "first\\nsecond"\nls -la', timeout: 10},
    {url: 'https://example.com', method: 'POST', body: '{"title":"example"}'},
  ]) {
    assert.deepEqual(JSON.parse(toolInput(args)), args);
  }
  assert.equal(
    toolInput({timeout: 10, command: 'pwd'}),
    toolInput({command: 'pwd', timeout: 10}),
    'Argument ordering does not change the input restored from history',
  );
});

void test('JSON operation inputs omit private reasoning, image payloads and provider metadata', () => {
  const input = toolInput({
    path: 'public.md',
    content: 'Visible\ndata:image/png;base64,AAAA',
    thinking: 'secret thinking',
    thoughtSignature: 'secret signature',
    providerMetadata: {secret: 'provider'},
    attachment: {mimeType: 'image/png', data: 'secret image'},
    parts: [
      {type: 'thinking', thinking: 'secret reasoning'},
      {type: 'image', data: 'secret image'},
      {type: 'text', text: 'Public text'},
    ],
  });
  assert.equal(JSON.parse(input).path, 'public.md');
  assert.match(input, /Public text|Visible/);
  assert.doesNotMatch(input, /secret|data:image|AAAA/);
});

void test('large JSON inputs retain every string, argument, array item and long key', () => {
  for (const args of [
    {path: 'large.md', content: '\n\t"\\\u0000'.repeat(10000)},
    {
      path: 'many.json',
      fields: Object.fromEntries(
        Array.from({length: 200}, (_, index) => [
          `field${index}${'x'.repeat(200)}`,
          'Value\n'.repeat(1000),
        ]),
      ),
    },
    {
      path: 'array.json',
      rows: Array.from({length: 100}, () => ({
        oldText: 'Old\n'.repeat(1000),
        newText: 'New\n'.repeat(1000),
      })),
    },
  ]) {
    const input = toolInput(args);
    assert.deepEqual(JSON.parse(input), args);
    const state = new ConversationState();
    state.update({
      id: 'tool',
      role: 'tool',
      text: '',
      input,
      at: new Date().toISOString(),
    });
    const stored = state.snapshot().conversation[0];
    assert.equal(stored.truncated, false);
    assert.deepEqual(JSON.parse(stored.input!), args);
  }
});

void test('deep JSON inputs retain their values without recursive traversal', () => {
  let nested: unknown = 'Complete value';
  for (let index = 0; index < 20000; index++) nested = {next: [nested]};
  let restored = JSON.parse(toolInput(nested));
  for (let index = 0; index < 20000; index++) {
    assert.deepEqual(Object.keys(restored), ['next']);
    assert.equal(restored.next.length, 1);
    restored = restored.next[0];
  }
  assert.equal(restored, 'Complete value');
});

void test('circular and nonserializable inputs preserve neighboring arguments and never invoke accessors', () => {
  const cycle: Record<string, unknown> = {path: 'cycle.json'};
  cycle.next = cycle;
  const shared = {text: 'Shared valid value'};
  let getterCalls = 0;
  const accessors = Object.defineProperty({path: 'accessor.json'}, 'next', {
    enumerable: true,
    get() {
      getterCalls++;
      return {next: this};
    },
  });
  const throwing = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('Unavailable');
      },
    },
  );
  const callback = Object.assign(() => {}, {
    toJSON() {
      throw new Error('Argument serializers must not run');
    },
  });
  const input = JSON.parse(
    toolInput({
      cycle,
      shared: [shared, shared],
      accessors,
      throwing,
      largeInteger: 1n,
      missing: undefined,
      callback,
      symbol: Symbol('private'),
    }),
  );
  assert.deepEqual(input.cycle, {path: 'cycle.json', next: '[Circular]'});
  assert.deepEqual(input.shared, [shared, shared]);
  assert.deepEqual(input.accessors, {
    path: 'accessor.json',
    next: '[Arguments unavailable]',
  });
  assert.equal(getterCalls, 0);
  assert.equal(input.throwing, '[Arguments unavailable]');
  assert.equal(input.largeInteger, '[Arguments unavailable]');
  assert.equal(input.missing, null);
  assert.equal(input.callback, null);
  assert.equal(input.symbol, null);
  assert.equal(JSON.parse(toolInput(1n)), '[Arguments unavailable]');
  assert.equal(JSON.parse(toolInput(callback)), null);
});
