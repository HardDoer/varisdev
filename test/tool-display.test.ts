import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ConversationState, toolInput} from '../src/conversation.ts';
import {
  formatToolInput,
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

void test('oversized production input remains bounded valid JSON after snapshot projection', () => {
  const operation = displayedOperation('write', {
    path: '/project/large.md',
    content: 'Line with "quotes" and \\\n'.repeat(10_000),
  });
  assert.ok(operation.input.length <= 8000);
  assert.doesNotThrow(() => JSON.parse(operation.input));
  assert.equal(operation.summary, '/project/large.md');
  assert.ok(operation.text.includes('Content:'));
  assert.ok(operation.text.includes('[Arguments truncated]'));
});
