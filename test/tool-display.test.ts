import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ConversationState, toolInput} from '../src/conversation.ts';
import {
  formatToolInput,
  formatToolResult,
  toolInputPreview,
} from '../assets/dashboard/tool-display.js';

// Exercise the actual serializer and snapshot boundary used by both parent
// sessions and agents before handing its public input to the browser renderer.
function displayedOperation(name: string, args: unknown) {
  const state = new ConversationState();
  state.update({
    id: 'operation',
    role: 'tool',
    at: '2026-01-01T00:00:00.000Z',
    text: '',
    toolName: name,
    input: toolInput(args),
    status: 'running',
  });
  const message = state.snapshot().conversation[0];
  return {
    input: message.input!,
    text: formatToolInput(name, message.input),
    summary: toolInputPreview(name, message.input),
  };
}

void test('production write and edit inputs retain multiline file data through snapshot rendering', () => {
  const content =
    '# Tasks\n- [ ] First\n<script>alert("hello")</script>\nLiteral \\n stays literal\n';
  const write = displayedOperation('write', {
    path: '/project/PLAN.md',
    content,
  });
  assert.deepEqual(JSON.parse(write.input), {
    path: '/project/PLAN.md',
    content,
  });
  assert.equal(write.summary, '/project/PLAN.md');
  assert.ok(write.text.startsWith('Write file\n\nPath: /project/PLAN.md'));
  assert.ok(write.text.includes(`Content:\n${content}`));
  assert.ok(!write.text.includes('\\n- [ ] First'));

  const oldText = '- [ ] First\n- [ ] Second\n';
  const newText = '- [x] First\n- [ ] Second\n';
  const edit = displayedOperation('edit', {
    path: '/project/PLAN.md',
    edits: [{oldText, newText}],
  });
  assert.equal(edit.summary, '/project/PLAN.md');
  assert.ok(edit.text.startsWith('Edit file\n\nPath: /project/PLAN.md'));
  assert.ok(edit.text.includes(`Original text:\n${oldText}`));
  assert.ok(edit.text.includes(`Replacement text:\n${newText}`));
  assert.ok(!edit.text.includes('\\n- [ ] Second'));
});

void test('production commands, queries and agent messages keep useful labeled fields and public data only', () => {
  const command = 'printf "first\\nsecond\\n"\npwd';
  const bash = displayedOperation('bash', {command, timeout: 3});
  assert.equal(bash.summary, 'printf "first\\nsecond\\n"');
  assert.ok(bash.text.includes(`Command:\n${command}`));
  assert.ok(bash.text.includes('Timeout (seconds): 3'));

  const read = displayedOperation('read', {
    path: '/project/file.md',
    offset: 2,
    limit: 5,
  });
  assert.ok(read.text.includes('Path: /project/file.md'));
  assert.ok(read.text.includes('Start line: 2'));
  assert.ok(read.text.includes('Line limit: 5'));

  const agent = displayedOperation('agent_send', {
    id: 'worker',
    message: 'Read PLAN.md\nThen report',
    thinking: 'private-thought',
    providerMetadata: {secret: 'private-metadata'},
    image: {type: 'image', data: 'private-image'},
    reference: 'data:image/png;base64,YWJjZA==',
  });
  assert.ok(agent.text.includes('Message:\nRead PLAN.md\nThen report'));
  assert.ok(agent.text.includes('[Image omitted]'));
  assert.ok(!agent.text.includes('private-'));
  assert.ok(!agent.input.includes('YWJjZA=='));
  assert.doesNotThrow(() => JSON.parse(agent.input));
});

void test('large production input retains exact multiline content through snapshot rendering', () => {
  const content =
    'Line with "quotes" and \\\n  Indented\r\n\nLiteral \\n stays literal 🛠️\n'.repeat(
      10_000,
    ) + 'Final file line\n';
  const args = {path: '/project/large.md', content};
  const operation = displayedOperation('write', args);
  assert.ok(content.length > 64 * 1024);
  assert.deepEqual(JSON.parse(operation.input), args);
  assert.equal(operation.summary, '/project/large.md');
  assert.equal(
    operation.text,
    `Write file\n\nPath: /project/large.md\n\nContent:\n${content}`,
  );
});

void test('large plain and JSON-encoded strings retain exact tool input and result text', () => {
  const text =
    'First "line"\r\n  Second line\n\nLiteral \\n and \\t stay literal 🛠️\n'.repeat(
      2000,
    ) + 'Final message line\n';
  assert.ok(text.length > 64 * 1024);
  for (const value of [text, JSON.stringify(text)]) {
    assert.equal(
      formatToolInput('agent_send', value),
      `Send agent message\n\n${text}`,
    );
    assert.equal(formatToolResult(value), text);
  }
});

void test('large arrays keep readable numbering and every entry through the tail', () => {
  const values = Array.from(
    {length: 128},
    (_, index) =>
      `Entry ${index + 1}\n${'Details '.repeat(128)}\nEnd ${index + 1}\n`,
  );
  const expected = values
    .map((value, index) => `${index + 1}.\n${value}`)
    .join('\n\n');
  assert.ok(expected.length > 64 * 1024);
  assert.equal(
    formatToolInput('json_query', JSON.stringify(values)),
    `Inspect JSON\n\n${expected}`,
  );
  assert.equal(formatToolResult(values), expected);
});

void test('large objects keep labeled multiline fields and their final sibling', () => {
  const entries = Array.from({length: 128}, (_, index) => {
    const value = `Field ${index + 1}\n${'Details '.repeat(128)}\nEnd ${index + 1}\n`;
    return [`field_${index + 1}`, value];
  });
  const value = Object.fromEntries([...entries, ['tail', 'Final sibling']]);
  const expected = `${entries
    .map(([, text], index) => `Field ${index + 1}:\n${text}`)
    .join('\n\n')}\n\nTail: Final sibling`;
  assert.ok(expected.length > 64 * 1024);
  assert.equal(
    formatToolInput('json_query', value),
    `Inspect JSON\n\n${expected}`,
  );
  assert.equal(formatToolResult(JSON.stringify(value)), expected);
});

void test('20,000 nested public tool arguments retain their full serialized input and result', () => {
  const content =
    'Deep "quoted" line\nLiteral \\n stays literal\n'.repeat(2000) +
    'Final deep content line\n';
  for (const shape of ['object', 'array']) {
    let value: unknown = {content, tail: 'Final deep field'};
    for (let depth = 0; depth < 20_000; depth++)
      value = shape === 'array' ? [value] : {child: value};
    const operation = displayedOperation('json_query', {
      data: value,
      tail: 'Final root field',
    });
    assert.ok(operation.input.includes(JSON.stringify(content)));
    assert.ok(operation.input.endsWith(',"tail":"Final root field"}'));
    assert.equal(operation.text, `Inspect JSON\n\n${operation.input}`);
    assert.equal(formatToolResult(operation.input), operation.input);
    assert.equal(operation.summary, 'Inspect JSON');
  }
});

void test('previews of 20,000 nested array arguments use the tool label without overflowing', () => {
  let command: unknown = 'Final command value';
  for (let depth = 0; depth < 20_000; depth++) command = [command];
  const input = toolInput({command, tail: 'Final root field'});
  assert.equal(toolInputPreview('bash', input), 'Run command');
  const operation = displayedOperation('bash', {
    command,
    tail: 'Final root field',
  });
  assert.equal(operation.summary, 'Run command');
  assert.equal(operation.text, `Run command\n\n${input}`);
  assert.equal(formatToolResult(input), input);
});

void test('deep structures use the existing JSON depth fallback without losing their tail', () => {
  const leaf = {
    content: 'Deep content\n'.repeat(6000),
    tail: 'Final deep field',
  };
  let value: unknown = leaf;
  for (let depth = 0; depth < 20; depth++) value = {child: value};
  const text = formatToolResult(JSON.stringify(value));
  assert.ok(text.startsWith('Child:\n  Child:\n'));
  assert.ok(text.includes('"child": {'));
  assert.ok(text.includes(`"content": ${JSON.stringify(leaf.content)}`));
  assert.ok(text.includes('"tail": "Final deep field"'));
  assert.ok(!text.includes('[Display truncated]'));
});
