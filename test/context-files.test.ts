import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {
  createEditTool,
  createWriteTool,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import {attachedContextFiles} from '../src/dashboard/context-files.ts';

type Message = Parameters<SessionManager['appendMessage']>[0];
const cwd = join(tmpdir(), 'context-files-virtual-project');

function call(
  manager: SessionManager,
  id: string,
  name: string,
  args: unknown,
) {
  manager.appendMessage({
    role: 'assistant',
    api: 'openai-completions',
    provider: 'fixture',
    model: 'fixture',
    content: [{type: 'toolCall', id, name, arguments: args}],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
    },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  } as Message);
}

function result(
  manager: SessionManager,
  id: string,
  name: string,
  isError = false,
  text = 'Success',
) {
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: id,
    toolName: name,
    content: [{type: 'text', text}],
    isError,
    timestamp: Date.now(),
  });
}

function files(manager: SessionManager) {
  return attachedContextFiles(
    undefined,
    [],
    manager.buildSessionContext().messages,
    cwd,
  )!;
}

void test('successful SDK writes retain full supplied Markdown and merge edit snippets by path', async () => {
  const manager = SessionManager.inMemory(cwd);
  let diskContent = '';
  const write = createWriteTool(cwd, {
    operations: {
      mkdir: async () => {},
      writeFile: async (_path, content) => {
        diskContent = content;
      },
    },
  });
  const writeArgs = {path: '@PLAN.md', content: '# Plan\n- [ ] Task\nFooter'};
  call(manager, 'write', 'write', writeArgs);
  const written = await write.execute('write', writeArgs);
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'write',
    toolName: 'write',
    ...written,
    isError: false,
    timestamp: Date.now(),
  } as Message);
  const edit = createEditTool(cwd, {
    operations: {
      access: async () => {},
      readFile: async () => Buffer.from(diskContent),
      writeFile: async (_path, content) => {
        diskContent = content;
      },
    },
  });
  const editArgs = {
    path: './PLAN.md',
    edits: [
      {oldText: '- [ ] Task', newText: '- [x] Task'},
      {oldText: 'Footer', newText: 'Done'},
    ],
  };
  call(manager, 'edit', 'edit', editArgs);
  const edited = await edit.execute('edit', editArgs);
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'edit',
    toolName: 'edit',
    ...edited,
    isError: false,
    timestamp: Date.now(),
  } as Message);
  diskContent = 'DISK CHANGED AFTER RETAINED CALLS';
  const documents = files(manager);
  assert.equal(documents.length, 1);
  assert.equal(documents[0].path, join(cwd, 'PLAN.md'));
  assert.equal(documents[0].kind, 'document');
  assert.equal(documents[0].status, 'included');
  assert.match(
    documents[0].description,
    /full content supplied to a successful write/,
  );
  assert.match(
    documents[0].description,
    /Only the old and new replacement snippets/,
  );
  assert.equal(
    documents[0].content,
    'Written content:\n# Plan\n- [ ] Task\nFooter\n\n' +
      'Edit 1, old text:\n- [ ] Task\n\nEdit 1, new text:\n- [x] Task\n\n' +
      'Edit 2, old text:\nFooter\n\nEdit 2, new text:\nDone',
  );
  assert.doesNotMatch(documents[0].content!, /DISK CHANGED/);
});

void test('an edit without a retained read or write exposes only old and new snippets', async () => {
  const manager = SessionManager.inMemory(cwd);
  const args = {path: 'partial.MD', edits: [{oldText: 'old', newText: 'new'}]};
  call(manager, 'partial', 'edit', args);
  const edit = createEditTool(cwd, {
    operations: {
      access: async () => {},
      readFile: async () => Buffer.from('UNSEEN PREFIX\nold\nUNSEEN SUFFIX'),
      writeFile: async () => {},
    },
  });
  const edited = await edit.execute('partial', args);
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'partial',
    toolName: 'edit',
    ...edited,
    isError: false,
    timestamp: Date.now(),
  } as Message);
  const [document] = files(manager);
  assert.match(
    document.description,
    /Only the old and new replacement snippets/,
  );
  assert.equal(
    document.content,
    'Edit 1, old text:\nold\n\nEdit 1, new text:\nnew',
  );
  assert.doesNotMatch(document.content!, /UNSEEN/);
});

void test('retained legacy and normalized SDK edit arguments expose replacement snippets', () => {
  const manager = SessionManager.inMemory(cwd);
  const replacement = {oldText: 'before', newText: 'after'};
  const variants = [
    replacement,
    {edits: replacement},
    {edits: JSON.stringify([replacement])},
    {edits: JSON.stringify(replacement)},
    {edits: [{oldText: 'first', newText: 'second'}], ...replacement},
  ];
  variants.forEach((args, index) => {
    call(manager, String(index), 'edit', {path: `${index}.md`, ...args});
    result(manager, String(index), 'edit');
  });
  const documents = files(manager);
  assert.equal(documents.length, variants.length);
  for (const document of documents) {
    assert.match(document.content!, /old text:\nbefore/);
    assert.match(document.content!, /new text:\nafter/);
  }
  assert.match(documents.at(-1)!.content!, /Edit 2, old text:/);
});

void test('failed, pending, unmatched, non-Markdown and malformed calls are excluded', () => {
  const manager = SessionManager.inMemory(cwd);
  for (const name of ['write', 'edit']) {
    const args =
      name === 'write'
        ? {content: 'body'}
        : {edits: [{oldText: 'a', newText: 'b'}]};
    call(manager, `${name}-failed`, name, {path: `${name}-failed.md`, ...args});
    result(manager, `${name}-failed`, name, true);
    call(manager, `${name}-pending`, name, {
      path: `${name}-pending.md`,
      ...args,
    });
    call(manager, `${name}-mismatch`, name, {
      path: `${name}-mismatch.md`,
      ...args,
    });
    result(manager, `${name}-mismatch`, 'read');
    result(manager, `${name}-orphan`, name);
    call(manager, `${name}-other`, name, {path: `${name}.txt`, ...args});
    result(manager, `${name}-other`, name);
  }
  const invalid = [
    null,
    'invalid',
    {},
    {path: 123},
    {path: 'file://%broken.md', content: 'body'},
    {path: 'missing-content.md'},
    {path: 'wrong-content.md', content: 123},
    {path: 'empty-edits.md', edits: []},
    {path: 'bad-edits.md', edits: 'invalid JSON'},
    {path: 'bad-edits.md', edits: null},
    {path: 'bad-edits.md', edits: [null]},
    {path: 'bad-edits.md', edits: [{oldText: 'a', newText: 123}]},
    {path: 'mixed-edits.md', edits: [{oldText: 'a', newText: 'b'}, {}]},
  ];
  invalid.forEach((args, index) => {
    for (const name of ['write', 'edit', 'read']) {
      const id = `${name}-invalid-${index}`;
      call(manager, id, name, args);
      result(manager, id, name, false, '');
    }
  });
  assert.deepEqual(files(manager), []);
});

void test('empty successful writes and deletions remain visible', () => {
  const manager = SessionManager.inMemory(cwd);
  call(manager, 'empty', 'write', {path: 'empty.md', content: ''});
  result(manager, 'empty', 'write', false, '');
  call(manager, 'delete', 'edit', {
    path: 'delete.md',
    edits: [{oldText: 'removed', newText: ''}],
  });
  result(manager, 'delete', 'edit', false, '');
  assert.equal(files(manager)[0].content, 'Written content:\n');
  assert.equal(
    files(manager)[1].content,
    'Edit 1, old text:\nremoved\n\nEdit 1, new text:\n',
  );
});

void test('compaction removes write contents while keeping retained edit snippets', () => {
  const manager = SessionManager.inMemory(cwd);
  call(manager, 'write', 'write', {
    path: 'plan.md',
    content: 'WHOLE ORIGINAL FILE',
  });
  result(manager, 'write', 'write');
  const keep = manager.appendMessage({
    role: 'user',
    content: 'Update the plan',
    timestamp: Date.now(),
  });
  call(manager, 'edit', 'edit', {
    path: 'plan.md',
    edits: [{oldText: 'ORIGINAL', newText: 'UPDATED'}],
  });
  result(manager, 'edit', 'edit');
  manager.appendCompaction('Created plan.md earlier.', keep, 3000);
  const [document] = files(manager);
  assert.match(
    document.description,
    /Only the old and new replacement snippets/,
  );
  assert.doesNotMatch(document.description, /full content/);
  assert.doesNotMatch(document.content!, /WHOLE|FILE/);
  assert.match(document.content!, /UPDATED/);
  const after = manager.appendMessage({
    role: 'user',
    content: 'Continue',
    timestamp: Date.now(),
  });
  manager.appendCompaction('Edited plan.md earlier.', after, 3000);
  assert.deepEqual(files(manager), []);
});

void test('write and edit previews retain per-file and total bounds while all paths stay visible', () => {
  const manager = SessionManager.inMemory(cwd);
  for (let index = 0; index < 12; index++) {
    const name = index % 2 ? 'edit' : 'write';
    const args =
      name === 'write'
        ? {content: 'x'.repeat(20000)}
        : {edits: [{oldText: 'a'.repeat(10000), newText: 'b'.repeat(10000)}]};
    call(manager, String(index), name, {path: `${index}.md`, ...args});
    result(manager, String(index), name);
  }
  const documents = files(manager);
  assert.equal(documents.length, 12);
  const previews = documents.flatMap(file =>
    file.content === undefined ? [] : [file.content],
  );
  assert.equal(previews.length, 8);
  for (const preview of previews)
    assert.match(preview, /\[Preview truncated\]$/);
  assert.ok(
    previews.every(
      preview => preview.replace('\n[Preview truncated]', '').length <= 8000,
    ),
  );
  assert.equal(
    previews.reduce(
      (sum, preview) =>
        sum + preview.replace('\n[Preview truncated]', '').length,
      0,
    ),
    64000,
  );
});
