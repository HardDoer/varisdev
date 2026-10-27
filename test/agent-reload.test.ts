import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {AgentSessionController} from '../src/agents/team.ts';

void test(
  'reload final snapshots retire completed, running and queued workers before disposal finishes',
  {timeout: 5000},
  async t => {
    type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
    const handlers = new Map<string, Handler>();
    const pi = {
      on(name: string, handler: Handler) {
        handlers.set(name, handler);
      },
    } as unknown as ExtensionAPI;
    const ctx = {
      hasUI: false,
      sessionManager: {getSessionId: () => 'reload-session'},
    } as unknown as ExtensionContext;
    const control = new AgentSessionController(pi);
    const manager = control.getTeam(ctx).getManager();
    const disposal = Promise.withResolvers<void>();
    const spec = {
      name: 'Worker',
      task: 'Keep findings',
      model: 'test/model',
      cwd: process.cwd(),
    };
    t.after(async () => {
      disposal.resolve();
      await manager.close();
    });
    const completed = manager.spawn(spec, async () => ({
      async run() {
        return 'Retained result';
      },
      async steer() {
        return true;
      },
      dispose: () => disposal.promise,
    }));
    await manager.wait([completed.id]);
    for (let index = 0; index < 7; index++)
      manager.spawn(spec, async () => ({
        run(_task, signal) {
          return new Promise<string>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          });
        },
        async steer() {
          return true;
        },
        dispose: () => disposal.promise,
      }));
    const deadline = Date.now() + 2000;
    while (
      manager.list().filter(agent => agent.status === 'running').length < 5 &&
      Date.now() < deadline
    )
      await delay(5);
    assert.equal(
      manager.list().filter(agent => agent.status === 'running').length,
      5,
    );
    assert.equal(
      manager.list().filter(agent => agent.status === 'queued').length,
      2,
    );
    const before = control.deliverySnapshot()!;
    assert.ok(before.agents.every(agent => agent.resumable));

    const closing = handlers.get('session_shutdown')!(
      {type: 'session_shutdown', reason: 'reload'},
      ctx,
    );
    assert.equal(control.snapshot(), undefined);
    assert.throws(() => control.getTeam(ctx), /shutting down/);
    const final = control.deliverySnapshot()!;
    assert.equal(final.agents.length, 8);
    assert.ok(final.agents.every(agent => agent.resumable === false));
    assert.equal(
      final.agents.filter(agent => agent.status === 'cancelled').length,
      7,
    );
    assert.equal(
      final.agents.find(agent => agent.id === completed.id)!.output,
      'Retained result',
    );
    assert.ok(
      before.agents.every(agent => agent.resumable),
      'Previously delivered snapshots stay immutable',
    );
    disposal.resolve();
    await closing;
    assert.strictEqual(control.deliverySnapshot(), final);

    handlers.get('session_start')!({type: 'session_start'}, ctx);
    assert.equal(control.deliverySnapshot(), undefined);
    const replacement = control.getTeam(ctx).getManager();
    t.after(() => replacement.close());
    assert.deepEqual(replacement.list(), []);
    assert.throws(() => replacement.get(completed.id), /Unknown agent/);
  },
);
