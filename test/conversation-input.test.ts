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

void test('large and nested inputs remain parseable within the stored input budget and show truncation', () => {
  const cycle: Record<string, unknown> = {path: 'cycle.json'};
  cycle.next = cycle;
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
    cycle,
  ]) {
    const input = toolInput(args);
    assert.ok(input.length <= 8000, `Input length ${input.length}`);
    assert.equal(JSON.parse(input).path, args.path);
    assert.match(input, /Arguments truncated/);
    const state = new ConversationState();
    state.update({
      id: 'tool',
      role: 'tool',
      text: '',
      input,
      at: new Date().toISOString(),
    });
    const stored = state.snapshot().conversation[0];
    assert.equal(stored.truncated, true);
    assert.deepEqual(JSON.parse(stored.input!), JSON.parse(input));
  }
});
