import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {registerCompletionAlert} from '../src/completion-alert.ts';

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<void>;

void test('completion alert only activates after an unfocused run settles', async () => {
  const handlers = new Map<string, EventHandler>();
  const commands: string[] = [];
  let terminalOutput = '';

  const pi = {
    on(event: string, handler: EventHandler) {
      handlers.set(event, handler);
    },
    async exec(command: string) {
      commands.push(command);
      return {stdout: '', stderr: '', code: 0, killed: false};
    },
  } as unknown as ExtensionAPI;

  registerCompletionAlert(pi);

  const sessionStart = handlers.get('session_start');
  const agentSettled = handlers.get('agent_settled');
  const sessionShutdown = handlers.get('session_shutdown');
  assert.ok(sessionStart);
  assert.ok(agentSettled);
  assert.ok(sessionShutdown);

  const context = {mode: 'tui'} as ExtensionContext;
  const originalWrite = process.stdout.write;
  process.stdout.write = ((data: string | Uint8Array) => {
    terminalOutput += data.toString();
    return true;
  }) as typeof process.stdout.write;

  let started = false;
  try {
    await sessionStart({}, context);
    started = true;
    assert.ok(terminalOutput.includes('\x1b[?1004h'));

    await agentSettled({}, context);
    assert.equal(commands.length, 0);

    process.stdin.emit('data', Buffer.from('\x1b[O'));
    await agentSettled({}, context);
    assert.equal(commands.length > 0, process.platform !== 'darwin');
    assert.ok(terminalOutput.includes('\x1b]9;4;1;100\x07'));

    process.stdin.emit('data', Buffer.from('\x1b[I'));
    assert.ok(terminalOutput.includes('\x1b]9;4;0\x07'));
  } finally {
    if (started) await sessionShutdown({}, context);
    process.stdin.pause();
    process.stdout.write = originalWrite;
  }
});
