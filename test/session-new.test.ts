import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type {AgentSessionControl} from '../src/agents/team.ts';
import {registerSessionNewTool} from '../src/tools/session-new.ts';

function fixture() {
  const idle = Promise.withResolvers<void>();
  const commands = new Map<
    string,
    Parameters<ExtensionAPI['registerCommand']>[1]
  >();
  const events = new Map<string, () => void>();
  const commandRuns: Promise<void>[] = [];
  const notices: string[] = [];
  const calls: string[] = [];
  const abort = new AbortController();
  let tool!: ToolDefinition;
  let active = true;
  let newSession: ExtensionCommandContext['newSession'] = async () => ({
    cancelled: true,
  });
  const ctx = {
    model: {provider: 'test', id: 'parent'},
    signal: abort.signal,
    get sessionManager() {
      if (!active) throw new Error('Stale session context');
      return {
        getSessionId: () => 'old-parent',
        getSessionFile: () => '/old-parent.jsonl',
      };
    },
    ui: {notify: (message: string) => notices.push(message)},
    waitForIdle: () => idle.promise,
    newSession: (
      options: Parameters<ExtensionCommandContext['newSession']>[0],
    ) => newSession(options),
  } as unknown as ExtensionCommandContext;
  const agents: AgentSessionControl = {
    attach() {
      calls.push('attach');
    },
    prepareHandover() {
      calls.push('prepare');
      return {
        transfer(id) {
          calls.push(`transfer:${id}`);
        },
        cancel() {
          calls.push('cancel');
        },
        async close() {
          calls.push('close');
        },
      };
    },
  };
  const pi = {
    registerTool(definition: ToolDefinition) {
      tool = definition;
    },
    registerCommand(
      name: string,
      command: Parameters<ExtensionAPI['registerCommand']>[1],
    ) {
      commands.set(name, command);
    },
    on(name: string, callback: () => void) {
      events.set(name, callback);
    },
    getThinkingLevel: () => 'high',
    getActiveTools: () => ['read', 'session_new'],
    sendUserMessage(
      message: string,
      options: {expandPromptTemplates?: boolean},
    ) {
      assert.equal(options.expandPromptTemplates, true);
      const [command, token] = message.slice(1).split(' ');
      commandRuns.push(commands.get(command)!.handler(token, ctx));
    },
  } as unknown as ExtensionAPI;
  registerSessionNewTool(pi, agents);
  return {
    idle,
    notices,
    calls,
    abort,
    commands,
    ctx,
    async execute(handover = 'Continue the ongoing workflow.') {
      return tool.execute(
        'call',
        {handover},
        abort.signal,
        undefined,
        ctx as ExtensionContext,
      );
    },
    async finish() {
      idle.resolve();
      await Promise.all(commandRuns);
    },
    switchWith(fn: ExtensionCommandContext['newSession']) {
      newSession = fn;
    },
    shutdown() {
      active = false;
      events.get('session_shutdown')!();
    },
  };
}

void test('parent handover waits for idle, rejects duplicate requests, and respects cancellation', async () => {
  const parent = fixture();
  const scheduled = await parent.execute();
  assert.match(JSON.stringify(scheduled.content), /scheduled/);
  assert.deepEqual(parent.calls, []);
  await assert.rejects(parent.execute(), /already pending/);
  parent.abort.abort(new Error('User stopped the turn'));
  await parent.finish();
  assert.deepEqual(parent.calls, []);
  assert.deepEqual(parent.notices, []);

  const closing = fixture();
  await closing.execute();
  closing.shutdown();
  await closing.finish();
  assert.deepEqual(closing.calls, []);
});

void test('a cancelled parent switch restores ownership and allows another handover', async () => {
  const parent = fixture();
  await parent.execute();
  await parent.finish();
  assert.deepEqual(parent.calls, ['prepare', 'cancel']);
  assert.match(parent.notices[0], /cancelled/);
  await parent.execute('Try the handover again.');
  await parent.finish();
  assert.deepEqual(parent.calls, ['prepare', 'cancel', 'prepare', 'cancel']);
});

void test('handover failure restores a live source or closes detached workers after invalidation', async t => {
  const errors: unknown[] = [];
  t.mock.method(console, 'error', (message: unknown) => errors.push(message));
  for (const invalidated of [false, true]) {
    const parent = fixture();
    parent.switchWith(async () => {
      if (invalidated) parent.shutdown();
      throw new Error('Cannot create replacement');
    });
    await parent.execute();
    await parent.finish();
    assert.deepEqual(parent.calls, [
      'prepare',
      invalidated ? 'close' : 'cancel',
    ]);
  }
  assert.equal(errors.length, 2);
  assert.ok(
    errors.every(message =>
      String(message).includes('Cannot create replacement'),
    ),
  );

  // Unbound SDK command contexts return success without invoking replacement
  // callbacks. Treat this as a failed handover and retain the live source.
  const unbound = fixture();
  unbound.switchWith(async () => ({cancelled: false}));
  await unbound.execute();
  await unbound.finish();
  assert.deepEqual(unbound.calls, ['prepare', 'cancel']);
  assert.match(unbound.notices[0], /host did not start/);
});

void test('invalid handovers and unsolicited internal commands cannot initiate a switch', async () => {
  const parent = fixture();
  await assert.rejects(parent.execute('  '), /cannot be empty/);
  await assert.rejects(parent.execute('x'.repeat(64001)), /64000 characters/);
  await assert.rejects(
    parent.commands.get('varisdev-new-session')!.handler('missing', parent.ctx),
    /No matching/,
  );
  await assert.rejects(
    parent.commands
      .get('varisdev-resume-parent')!
      .handler('missing', parent.ctx),
    /No handover/,
  );
  parent.abort.abort(new Error('Aborted'));
  await assert.rejects(parent.execute(), /Aborted/);
  assert.deepEqual(parent.calls, []);
});
