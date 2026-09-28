import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type {AgentSessionControl} from '../src/agents/team.ts';
import {registerSessionHandover} from '../src/session-handover.ts';

interface RecordView {
  id: string;
  state: string;
  handover?: string;
  revision: number;
  dispatchedRevision?: number;
  deliveredRevision?: number;
  sourceSessionId: string;
  destinationSessionId?: string;
  requestedAt: string;
  updatedAt: string;
  waitingAt?: string;
  switchingAt?: string;
  dispatchedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  failedAt?: string;
  pendingReason: string;
  canUpdate: boolean;
  canCancel: boolean;
}
interface ToolResult {
  outcome?: string;
  handover?: RecordView;
  handovers?: RecordView[];
  total?: number;
}

type ReplacedSessionContext = Parameters<
  NonNullable<
    NonNullable<
      Parameters<ExtensionCommandContext['newSession']>[0]
    >['withSession']
  >
>[0];
type EventHandler = (event: object, ctx: ExtensionContext) => void;

function fixture(sessionId = randomUUID(), calls: string[] = []) {
  const idle = Promise.withResolvers<void>();
  const commands = new Map<
    string,
    Parameters<ExtensionAPI['registerCommand']>[1]
  >();
  const events = new Map<string, EventHandler>();
  const tools = new Map<string, ToolDefinition>();
  const commandRuns: Promise<void>[] = [];
  const notices: string[] = [];
  const prompts: string[] = [];
  const abort = new AbortController();
  let active = true;
  let attached = false;
  let modelAvailable = true;
  let commandDispatch = true;
  let cleanupFails = false;
  let setModel: () => Promise<boolean> = async () => modelAvailable;
  let newSession: ExtensionCommandContext['newSession'] = async () => ({
    cancelled: true,
  });
  const manager = {
    getSessionId: () => sessionId,
    getSessionFile: () => `/${sessionId}.jsonl`,
  };
  const ctx = {
    model: {provider: 'test', id: 'parent'},
    modelRegistry: {
      find: () =>
        modelAvailable ? {provider: 'test', id: 'parent'} : undefined,
    },
    signal: abort.signal,
    get sessionManager() {
      if (!active) throw new Error('Stale session context');
      return manager;
    },
    ui: {notify: (message: string) => notices.push(message)},
    waitForIdle: () => idle.promise,
    newSession: (
      options: Parameters<ExtensionCommandContext['newSession']>[0],
    ) => newSession(options),
    async sendUserMessage(
      message: string,
      options?: {expandPromptTemplates?: boolean},
    ) {
      if (options?.expandPromptTemplates) {
        const [command, token] = message.slice(1).split(' ');
        // Pi handles command exceptions itself; the request must retain errors.
        await commands
          .get(command)!
          .handler(token, ctx)
          .catch(() => {});
        return;
      }
      prompts.push(message);
      events.get('message_start')!(
        {message: {role: 'user', content: [{type: 'text', text: message}]}},
        ctx,
      );
    },
  } as unknown as ReplacedSessionContext;
  const agents: AgentSessionControl = {
    attach() {
      attached = true;
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
        hasDestination() {
          calls.push('hasDestination');
          return attached;
        },
        async close() {
          calls.push('close');
          if (cleanupFails) throw new Error('Worker disposal failed');
        },
      };
    },
  };
  const pi = {
    registerTool(definition: ToolDefinition) {
      tools.set(definition.name, definition);
    },
    registerCommand(
      name: string,
      command: Parameters<ExtensionAPI['registerCommand']>[1],
    ) {
      commands.set(name, command);
    },
    on(name: string, callback: EventHandler) {
      events.set(name, callback);
    },
    getThinkingLevel: () => 'high',
    getActiveTools: () => [
      'read',
      'session_handover_status',
      'session_handover_update',
      'session_handover_cancel',
    ],
    setModel: () => setModel(),
    setThinkingLevel: (level: string) => calls.push(`thinking:${level}`),
    setActiveTools: () => calls.push('tools'),
    sendUserMessage(
      message: string,
      options: {expandPromptTemplates?: boolean},
    ) {
      assert.equal(options.expandPromptTemplates, true);
      if (!commandDispatch) return;
      const [command, token] = message.slice(1).split(' ');
      commandRuns.push(commands.get(command)!.handler(token, ctx));
    },
  } as unknown as ExtensionAPI;
  const sessions = registerSessionHandover(pi, agents);
  async function invoke(name: string, params: object): Promise<ToolResult> {
    const response = await tools
      .get(name)!
      .execute('call', params, undefined, undefined, ctx);
    return response.details as ToolResult;
  }
  return {
    idle,
    notices,
    calls,
    abort,
    commands,
    ctx,
    manager,
    prompts,
    tools,
    invoke,
    schedule: async (handover = 'Continue the ongoing workflow.') =>
      (await sessions.schedule(handover, ctx)).details,
    status: (id?: string) => invoke('session_handover_status', id ? {id} : {}),
    update: (id: string, handover: string) =>
      invoke('session_handover_update', {id, handover}),
    cancel: (id: string) => invoke('session_handover_cancel', {id}),
    async finish() {
      idle.resolve();
      await Promise.all(commandRuns);
    },
    async drainCommands() {
      await Promise.all(commandRuns);
    },
    switchWith(fn: ExtensionCommandContext['newSession']) {
      newSession = fn;
    },
    missingModel() {
      modelAvailable = false;
    },
    modelWith(fn: () => Promise<boolean>) {
      setModel = fn;
    },
    disableDispatch() {
      commandDispatch = false;
    },
    failCleanup() {
      cleanupFails = true;
    },
    attachDestination() {
      attached = true;
    },
    start() {
      events.get('session_start')!({}, ctx);
    },
    shutdown(reason = 'new') {
      events.get('session_shutdown')!({reason}, ctx);
      active = false;
    },
  };
}

void test('pending handovers expose IDs, reasons, revisions, previews and duplicate requests', async () => {
  const parent = fixture();
  const scheduled = await parent.schedule();
  const record = scheduled.handover!;
  assert.equal(scheduled.outcome, 'scheduled');
  assert.equal(record.state, 'waiting_for_idle');
  assert.equal(record.sourceSessionId, parent.manager.getSessionId());
  assert.equal(record.canUpdate, true);
  assert.equal(record.canCancel, true);
  assert.ok(Date.parse(record.requestedAt));
  assert.ok(Date.parse(record.waitingAt!));
  assert.match(
    record.pendingReason,
    /source turn.*worker messages remain in agent_inbox/i,
  );
  assert.deepEqual(parent.calls, ['prepare'], 'Buffer workers from scheduling');
  const duplicate = await parent.schedule('A duplicate must not replace text.');
  assert.equal(duplicate.outcome, 'already_pending');
  assert.equal(duplicate.handover?.id, record.id);
  assert.equal(duplicate.handover?.revision, 1);
  const updated = await parent.update(record.id, 'Revised task');
  assert.equal(updated.outcome, 'updated');
  assert.equal(updated.handover?.revision, 2);
  assert.equal(updated.handover?.handover, 'Revised task');
  assert.equal(
    (await parent.status(record.id)).handover?.handover,
    'Revised task',
  );
  const listed = await parent.status();
  assert.equal(listed.total, 1);
  assert.equal(listed.handovers?.[0].handover, undefined);
  assert.equal(
    (await fixture().status(record.id)).outcome,
    'not_found',
    'Unrelated parents cannot access this history',
  );
  await parent.cancel(record.id);
  await parent.drainCommands(); // Cancellation must not wait for idle.
});

void test('explicit cancellation and stopping the source turn release workers immediately', async () => {
  const parent = fixture();
  const {id} = (await parent.schedule()).handover!;
  const cancelled = await parent.cancel(id);
  assert.equal(cancelled.outcome, 'cancelled');
  assert.equal(cancelled.handover?.state, 'cancelled');
  assert.ok(Date.parse(cancelled.handover!.cancelledAt!));
  assert.deepEqual(parent.calls, ['prepare', 'cancel']);
  assert.equal((await parent.cancel(id)).outcome, 'already_cancelled');
  assert.equal((await parent.update(id, 'Too late')).outcome, 'too_late');
  await parent.drainCommands();
  const second = (await parent.schedule()).handover!;
  assert.notEqual(second.id, id);
  parent.abort.abort(new Error('User stopped the turn'));
  await parent.drainCommands();
  assert.equal((await parent.status(second.id)).handover?.state, 'cancelled');
  assert.deepEqual(parent.calls, ['prepare', 'cancel', 'prepare', 'cancel']);
  const closing = fixture();
  await closing.schedule();
  closing.shutdown('quit');
  await closing.drainCommands();
  assert.deepEqual(closing.calls, ['prepare', 'close']);
});

void test('cancellation wins over a concurrent idle failure', async () => {
  const parent = fixture();
  const {id} = (await parent.schedule()).handover!;
  parent.idle.reject(new Error('The host stopped waiting'));
  await parent.cancel(id);
  await parent.drainCommands();
  assert.equal((await parent.status(id)).handover?.state, 'cancelled');
  assert.deepEqual(parent.calls, ['prepare', 'cancel']);
});

void test('Pi veto restores the source and allows another request', async () => {
  const parent = fixture();
  const first = (await parent.schedule()).handover!;
  await parent.finish();
  assert.deepEqual(parent.calls, ['prepare', 'cancel']);
  assert.match(
    (await parent.status(first.id)).handover!.pendingReason,
    /Pi cancelled/,
  );
  await parent.schedule('Try the handover again.');
  await parent.finish();
  assert.equal((await parent.status()).total, 2);
});

void test('switching rejects cancellation, accepts text updates until dispatch, and confirms the received revision across reloads', async () => {
  const parent = fixture();
  const next = fixture();
  const restoring = Promise.withResolvers<void>();
  const restoreModel = Promise.withResolvers<boolean>();
  const freshRun = Promise.withResolvers<void>();
  next.modelWith(() => {
    restoring.resolve();
    return restoreModel.promise;
  });
  const originalSend = next.ctx.sendUserMessage.bind(next.ctx);
  next.ctx.sendUserMessage = async (text, options) => {
    if (!options?.expandPromptTemplates) {
      assert.equal((await next.update(id, 'Too late')).outcome, 'too_late');
      assert.equal((await next.cancel(id)).outcome, 'too_late');
      await originalSend(text, options);
      return freshRun.promise;
    }
    return originalSend(text, options);
  };
  parent.switchWith(async options => {
    assert.equal((await parent.status(id)).handover?.state, 'switching');
    assert.equal((await parent.cancel(id)).outcome, 'too_late');
    parent.shutdown();
    await options!.setup!(next.manager as never);
    next.start();
    await options!.withSession!(next.ctx);
    return {cancelled: false};
  });
  const {id} = (await parent.schedule()).handover!;
  await parent.update(id, 'Revision before idle');
  parent.idle.resolve();
  await restoring.promise;
  const updated = await next.update(id, 'Revision during model restoration');
  assert.equal(updated.handover?.revision, 3);
  assert.equal(updated.handover?.canCancel, false);
  restoreModel.resolve(true);
  await parent.drainCommands(); // Return before the new parent turn finishes.
  const completed = (await next.status(id)).handover!;
  assert.equal(completed.state, 'completed');
  assert.equal(completed.revision, 3);
  assert.equal(completed.deliveredRevision, 3);
  assert.equal(completed.dispatchedRevision, 3);
  assert.equal(completed.destinationSessionId, next.manager.getSessionId());
  for (const field of ['switchingAt', 'dispatchedAt', 'completedAt'] as const)
    assert.ok(Date.parse(completed[field]!));
  assert.match(next.prompts[0], /Revision during model restoration/);
  assert.doesNotMatch(next.prompts[0], /Revision before idle/);
  assert.equal((await next.cancel(id)).outcome, 'too_late');
  const tooLate = await next.update(
    id,
    'This cannot replace the received text',
  );
  assert.equal(tooLate.outcome, 'too_late');
  assert.equal(tooLate.handover?.deliveredRevision, 3);
  assert.deepEqual(parent.calls, [
    'prepare',
    `transfer:${next.manager.getSessionId()}`,
  ]);
  freshRun.resolve();
  next.shutdown('quit');
});

void test('failures restore the source, retain an attached destination, or close detached workers', async t => {
  t.mock.method(console, 'error', () => {});
  for (const stage of [
    'source',
    'detached',
    'model',
    'rebind',
    'delivery',
    'cleanup',
    'unbound',
  ] as const) {
    const parent = fixture();
    const next = fixture();
    if (stage === 'model') next.missingModel();
    if (stage === 'cleanup') parent.failCleanup();
    if (stage === 'delivery') {
      const send = next.ctx.sendUserMessage.bind(next.ctx);
      next.ctx.sendUserMessage = async (text, options) => {
        if (!options?.expandPromptTemplates)
          throw new Error('Delivery rejected');
        return send(text, options);
      };
    }
    parent.switchWith(async options => {
      if (stage === 'source') throw new Error('Cannot create replacement');
      if (stage === 'unbound') return {cancelled: false};
      parent.shutdown();
      if (stage === 'detached') throw new Error('Cannot create replacement');
      await options!.setup!(next.manager as never);
      next.start();
      if (stage === 'cleanup') throw new Error('Attachment failed');
      parent.attachDestination(); // The shared team is now owned by next.
      if (stage === 'rebind')
        throw new Error('Rebind failed after session_start');
      await options!.withSession!(next.ctx);
      return {cancelled: false};
    });
    const {id} = (await parent.schedule()).handover!;
    await parent.finish();
    if (stage === 'cleanup') {
      const failed = (await next.status(id)).handover!;
      assert.equal(failed.state, 'failed');
      assert.match(
        failed.pendingReason,
        /Agent recovery also failed: Worker disposal failed/,
      );
      next.shutdown('quit');
    } else if (['model', 'rebind', 'delivery'].includes(stage)) {
      assert.equal(parent.calls.at(-1), 'hasDestination', stage);
      assert.equal(parent.calls.includes('close'), false, stage);
      const failed = (await next.status(id)).handover!;
      assert.equal(failed.state, 'failed');
      assert.ok(Date.parse(failed.failedAt!));
      assert.equal(failed.deliveredRevision, undefined);
      assert.match(failed.pendingReason, /remain with the destination/);
      next.shutdown('quit');
    } else {
      assert.equal(
        parent.calls.at(-1),
        stage === 'detached' ? 'close' : 'cancel',
        stage,
      );
      if (stage !== 'detached') {
        assert.equal((await parent.status(id)).handover?.state, 'failed');
        assert.equal((await parent.update(id, 'Retry')).outcome, 'too_late');
      }
    }
  }
});

void test('an unrelated destination replacement releases its abandoned handover history', async t => {
  t.mock.method(console, 'error', () => {});
  const parent = fixture();
  const next = fixture();
  parent.switchWith(async options => {
    parent.shutdown();
    await options!.setup!(next.manager as never);
    next.start();
    next.shutdown('new');
    throw new Error('Destination replaced before handover delivery');
  });
  const {id} = (await parent.schedule()).handover!;
  await parent.finish();
  const reopened = fixture(next.manager.getSessionId());
  assert.equal((await reopened.status(id)).outcome, 'not_found');
  assert.deepEqual(parent.calls.slice(-2), ['hasDestination', 'close']);
});

void test('invalid handovers, missing IDs and unsolicited commands cannot initiate a switch', async () => {
  const parent = fixture();
  await assert.rejects(parent.schedule('  '), /cannot be empty/);
  await assert.rejects(parent.schedule('x'.repeat(64001)), /64000 characters/);
  assert.equal((await parent.status('missing')).outcome, 'not_found');
  assert.equal((await parent.update('missing', 'Task')).outcome, 'not_found');
  assert.equal((await parent.cancel('missing')).outcome, 'not_found');
  await assert.rejects(
    parent.commands
      .get('varisdev-handover-switch')!
      .handler('missing', parent.ctx),
    /No matching/,
  );
  await assert.rejects(
    parent.commands
      .get('varisdev-handover-resume')!
      .handler('missing', parent.ctx),
    /No handover/,
  );
  parent.abort.abort(new Error('Aborted'));
  await assert.rejects(parent.schedule(), /Aborted/);
  assert.deepEqual(parent.calls, []);
  const undispatched = fixture();
  undispatched.disableDispatch();
  const failed = await undispatched.schedule();
  assert.equal(failed.outcome, 'failed');
  assert.match(failed.handover!.pendingReason, /did not dispatch/);
  assert.deepEqual(undispatched.calls, ['prepare', 'cancel']);
});

void test('history retains the latest 50 requests with bounded listing', async () => {
  const parent = fixture();
  let firstId = '';
  let lastId = '';
  for (let index = 0; index < 52; index++) {
    const record = (await parent.schedule(`Task ${index}`)).handover!;
    firstId ||= record.id;
    lastId = record.id;
    await parent.cancel(record.id);
  }
  await parent.drainCommands();
  const listed = await parent.invoke('session_handover_status', {limit: 2});
  assert.equal(listed.total, 50);
  assert.equal(listed.handovers?.length, 2);
  assert.equal(listed.handovers?.[0].id, lastId);
  assert.equal((await parent.status(firstId)).outcome, 'not_found');
});
