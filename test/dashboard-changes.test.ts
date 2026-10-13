import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {observeFileChanges, type UnitChange} from '../src/dashboard/changes.ts';
import {registerAgentTools} from '../src/tools/agents.ts';

function hooks(cwd: string) {
  const handlers = new Map<
    string,
    Array<(event: Record<string, unknown>, ctx: ExtensionContext) => unknown>
  >();
  const tools = new Map<string, ToolDefinition>();
  const ctx = {
    cwd,
    hasUI: false,
    model: {provider: 'test', id: 'model'},
    modelRegistry: {},
    sessionManager: {getSessionId: () => 'parent'},
  } as unknown as ExtensionContext;
  const pi = {
    on(
      name: string,
      handler: (
        event: Record<string, unknown>,
        ctx: ExtensionContext,
      ) => unknown,
    ) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    getThinkingLevel: () => 'off',
  } as unknown as ExtensionAPI;
  return {
    pi,
    ctx,
    tools,
    async emit(name: string, event: Record<string, unknown> = {}) {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
    async start(id: string, toolName: string, args: Record<string, unknown>) {
      await this.emit('tool_call', {toolCallId: id, toolName, input: args});
    },
    async end(id: string, toolName: string, details = {}, isError = false) {
      await this.emit('tool_execution_end', {
        toolCallId: id,
        toolName,
        result: {details},
        isError,
      });
    },
  };
}

void test('file hooks match calls, prefer actual edit patches and bound write diffs', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'dashboard-changes-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const h = hooks(cwd);
  const changes: UnitChange[] = [];
  observeFileChanges(h.pi, change =>
    changes.push({...change, unitId: 'parent', unitName: 'Parent'}),
  );
  await writeFile(join(cwd, 'one'), 'old\n');
  await h.start('write', 'write', {path: '@one', content: 'new\n'});
  await writeFile(join(cwd, 'one'), 'new\n');
  await h.emit('tool_execution_start', {
    toolCallId: 'write',
    toolName: 'write',
    args: {path: '@one', content: 'new\n'},
  });
  await h.start('edit', 'edit', {
    path: 'two',
    edits: [{oldText: 'a', newText: 'b'}],
  });
  await h.end('edit', 'edit', {
    patch: '--- two\n+++ two\n@@ -1 +1 @@\n-a\n+b',
    diff: 'ignored',
  });
  await h.end('write', 'write');
  assert.equal(changes[0].path, join(cwd, 'two'));
  assert.match(changes[0].diff, /\n-a\n\+b$/);
  assert.equal(changes[1].path, join(cwd, 'one'));
  assert.match(changes[1].diff, /@@ -1,1 \+1,1 @@\n-old\n\+new$/);
  assert.equal(changes[1].unitId, 'parent');
  assert.notEqual(changes[0].id, changes[1].id);

  await h.start('failed', 'write', {path: 'one', content: 'bad'});
  await h.end('failed', 'write', {}, true);
  await h.start('same', 'write', {path: 'one', content: 'new\n'});
  await h.end('same', 'write');
  await h.start('empty', 'edit', {path: 'one', edits: []});
  await h.end('empty', 'edit', {patch: ''});
  await h.start('bash', 'bash', {
    command: 'ignored',
    path: 'one',
    content: 'bad',
  });
  await h.end('bash', 'bash');
  assert.equal(changes.length, 2);

  await h.start('large-diff', 'write', {
    path: 'new',
    content: 'line\n'.repeat(5000),
  });
  await h.end('large-diff', 'write');
  assert.ok(changes.at(-1)!.diff.length <= 12000);
  assert.match(changes.at(-1)!.diff, /\[truncated\]$/);
  await writeFile(join(cwd, 'huge'), 'a'.repeat(40000));
  await h.start('huge', 'write', {path: 'huge', content: 'small'});
  await h.end('huge', 'write');
  assert.match(changes.at(-1)!.diff, /before exceeds 32 KiB/);
  await writeFile(join(cwd, 'binary'), Buffer.from([0, 255, 2]));
  await h.start('binary', 'write', {path: 'binary', content: 'text'});
  await h.end('binary', 'write');
  assert.match(changes.at(-1)!.summary, /binary content/);
  await h.start('big-after', 'write', {
    path: 'one',
    content: 'x'.repeat(40000),
  });
  await h.end('big-after', 'write');
  assert.match(changes.at(-1)!.diff, /after exceeds 32 KiB/);
  await h.start('big-patch', 'edit', {path: 'one', edits: []});
  await h.end('big-patch', 'edit', {patch: '+new\n'.repeat(4000)});
  assert.ok(changes.at(-1)!.diff.length <= 12000);
  const count = changes.length;
  const starting = h.start('closed', 'write', {path: 'new', content: 'text'});
  await h.emit('session_shutdown');
  await starting;
  await h.end('closed', 'write');
  assert.equal(changes.length, count);
});

void test('worker hooks attribute changes and team snapshots retain bounded copies', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'dashboard-worker-changes-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const parent = hooks(cwd);
  const worker = hooks(cwd);
  let ready!: () => void;
  const registered = new Promise<void>(resolve => {
    ready = resolve;
  });
  const control = registerAgentTools(parent.pi, async options => {
    await options.agentToolsExtension(worker.pi);
    ready();
    return {
      async run() {
        return 'done';
      },
      dispose() {},
    };
  });
  t.after(() => parent.emit('session_shutdown'));
  await parent.tools
    .get('agent_spawn')!
    .execute(
      'spawn',
      {name: 'Drone', task: 'Work'},
      undefined,
      undefined,
      parent.ctx,
    );
  await registered;
  const id = control.snapshot()!.agents[0].id;
  let notifications = 0;
  control.subscribe(() => {
    notifications++;
  });
  await worker.start('edit', 'edit', {
    path: 'one',
    edits: [{oldText: 'a', newText: 'b'}],
  });
  await worker.end('edit', 'edit', {patch: '-a\n+b'});
  await worker.start('write', 'write', {path: 'two', content: 'hello'});
  await worker.end('write', 'write');
  assert.ok(notifications >= 2);
  const snapshot = control.snapshot()!;
  assert.deepEqual(
    snapshot.changes.map(change => [
      change.unitId,
      change.unitName,
      change.tool,
    ]),
    [
      [id, 'Drone', 'edit'],
      [id, 'Drone', 'write'],
    ],
  );
  snapshot.changes[0].diff = 'mutated';
  snapshot.changes.length = 0;
  assert.equal(control.snapshot()!.changes[0].diff, '-a\n+b');
  const team = control.getTeam(parent.ctx);
  const change = control.snapshot()!.changes[0];
  for (let i = 0; i < 101; i++) team.storeChange({...change, id: String(i)});
  change.diff = 'outside';
  assert.equal(control.snapshot()!.changes.length, 100);
  assert.equal(control.snapshot()!.changes[0].id, '1');
  assert.equal(control.snapshot()!.changes[0].diff, '-a\n+b');
  await parent.emit('session_shutdown');
  await worker.start('stale', 'edit', {path: 'one', edits: []});
  await worker.end('stale', 'edit', {patch: '-b\n+c'});
  assert.equal(control.snapshot(), undefined);
  await parent.emit('session_start');
  assert.deepEqual(control.getTeam(parent.ctx).snapshot().changes, []);
});
