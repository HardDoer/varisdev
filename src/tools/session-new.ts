import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {randomUUID} from 'node:crypto';
import {Type} from 'typebox';
import type {AgentHandover, AgentSessionControl} from '../agents/team.ts';

type HandoverState =
  | 'scheduled'
  | 'waiting_for_idle'
  | 'switching'
  | 'completed'
  | 'cancelled'
  | 'failed';

interface HandoverRecord {
  id: string;
  state: HandoverState;
  handover: string;
  revision: number;
  dispatchedRevision?: number;
  deliveredRevision?: number;
  sourceSessionId: string;
  sourceSessionFile?: string;
  destinationSessionId?: string;
  destinationSessionFile?: string;
  requestedAt: string;
  updatedAt: string;
  waitingAt?: string;
  switchingAt?: string;
  dispatchedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  failedAt?: string;
  pendingReason: string;
  error?: string;
}

interface HandoverHistory {
  records: Map<string, HandoverRecord>;
  pending?: HandoverRequest;
}

interface HandoverRequest {
  record: HandoverRecord;
  history: HandoverHistory;
  lease: AgentHandover;
  model: {provider: string; id: string};
  thinkingLevel: ReturnType<ExtensionAPI['getThinkingLevel']>;
  activeTools: string[];
  stopWaiting: ReturnType<typeof Promise.withResolvers<void>>;
  received: ReturnType<typeof Promise.withResolvers<void>>;
  signal?: AbortSignal;
  onAbort?: () => void;
  commandStarted: boolean;
  configured: boolean;
  prompt?: string;
  replacement?: ExtensionContext;
  error?: unknown;
}

// Replacement runtimes reload extension modules. Keep the current session's
// bounded history and in-flight dispatch shared until its replacement claims it.
const storeKey = Symbol.for('varisdev.parentSessionHandovers');
const shared = globalThis as typeof globalThis & {
  [storeKey]?: {
    sessions: Map<string, HandoverHistory>;
    switching: Map<string, HandoverRequest>;
  };
};
const store = (shared[storeKey] ??= {
  sessions: new Map(),
  switching: new Map(),
});
const historyLimit = 50;

function getHistory(ctx: ExtensionContext): HandoverHistory {
  const id = ctx.sessionManager.getSessionId();
  let history = store.sessions.get(id);
  if (!history) {
    history = {records: new Map()};
    store.sessions.set(id, history);
  }
  return history;
}

function editable(record: HandoverRecord): boolean {
  return (
    ['scheduled', 'waiting_for_idle', 'switching'].includes(record.state) &&
    !record.dispatchedAt
  );
}

function cancellable(record: HandoverRecord): boolean {
  return ['scheduled', 'waiting_for_idle'].includes(record.state);
}

function inspect(record: HandoverRecord, includeText = true) {
  const {handover, ...metadata} = record;
  return {
    ...metadata,
    ...(includeText ? {handover} : {preview: handover.slice(0, 240)}),
    canUpdate: editable(record),
    canCancel: cancellable(record),
  };
}

function result<T extends object>(details: T) {
  return {
    content: [{type: 'text' as const, text: JSON.stringify(details, null, 2)}],
    details,
  };
}

function validateText(handover: string): void {
  if (!handover.trim()) throw new Error('Handover cannot be empty.');
  if (handover.length > 64000)
    throw new Error('Handover cannot exceed 64000 characters.');
}

function stopListening(request: HandoverRequest): void {
  if (request.onAbort)
    request.signal?.removeEventListener('abort', request.onAbort);
}

function finish(
  request: HandoverRequest,
  state: 'completed' | 'cancelled' | 'failed',
  reason: string,
): void {
  const {record, history} = request;
  record.state = state;
  record.updatedAt = new Date().toISOString();
  record[`${state}At`] = record.updatedAt;
  record.pendingReason = reason;
  stopListening(request);
  request.stopWaiting.resolve();
  if (history.pending === request) history.pending = undefined;
  store.switching.delete(record.id);
}

function cancel(request: HandoverRequest, reason: string): void {
  finish(request, 'cancelled', reason);
  request.lease.cancel();
}

function handoverPrompt(record: HandoverRecord): string {
  return [
    'Continue the plan from this handover in your fresh parent session.',
    `Parent handover ID: ${record.id}; revision: ${record.revision}. Use session_handover_status to inspect delivery and recent handovers.`,
    'Your background agents remain attached. Use agent_list to discover their IDs and progress, and agent_status or agent_wait to collect their results.',
    ...(record.sourceSessionFile
      ? [`Previous parent transcript: ${record.sourceSessionFile}`]
      : []),
    `Handover:\n${record.handover}`,
  ].join('\n\n');
}

const idSchema = Type.String({
  minLength: 1,
  description:
    'Parent handover request ID returned by session_new or session_handover_status.',
});
const handoverSchema = Type.String({
  minLength: 1,
  maxLength: 64000,
  description:
    'Complete handover for the fresh parent: task, user instructions, progress, decisions, files, checks, agent assignments, and next steps.',
});

/** Replace the parent runtime using Pi's command context, then resume work. */
export function registerSessionNewTool(
  pi: ExtensionAPI,
  agents: AgentSessionControl,
) {
  async function schedule(
    handover: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    ctx.signal?.throwIfAborted();
    validateText(handover);
    const history = getHistory(ctx);
    if (history.pending) {
      return result({
        outcome: 'already_pending',
        handover: inspect(history.pending.record),
      });
    }
    if (!ctx.model)
      throw new Error('Select a model before starting a new session.');
    const model = {provider: ctx.model.provider, id: ctx.model.id};
    const thinkingLevel = pi.getThinkingLevel();
    const activeTools = pi.getActiveTools();
    const timestamp = new Date().toISOString();
    const record: HandoverRecord = {
      id: randomUUID(),
      state: 'scheduled',
      handover,
      revision: 1,
      sourceSessionId: ctx.sessionManager.getSessionId(),
      sourceSessionFile: ctx.sessionManager.getSessionFile(),
      requestedAt: timestamp,
      updatedAt: timestamp,
      pendingReason:
        'Waiting for the session command to start. Worker messages are buffered.',
    };
    const request: HandoverRequest = {
      record,
      history,
      // Pause before dispatching the waiting command. Incoming workers must
      // not continually add follow-up turns while the parent seeks idle.
      lease: agents.prepareHandover(ctx),
      model,
      thinkingLevel,
      activeTools,
      signal: ctx.signal ?? signal,
      stopWaiting: Promise.withResolvers<void>(),
      received: Promise.withResolvers<void>(),
      commandStarted: false,
      configured: false,
    };
    history.pending = request;
    history.records.set(record.id, record);
    while (history.records.size > historyLimit)
      history.records.delete(history.records.keys().next().value!);
    request.onAbort = () => {
      if (cancellable(record))
        cancel(
          request,
          'The source turn was stopped before session replacement began. Buffered worker messages return to the source session.',
        );
    };
    request.signal?.addEventListener('abort', request.onAbort, {once: true});
    try {
      // Pi dispatches commands synchronously up to their first await, even
      // during a tool call. Returning this result lets that turn settle.
      pi.sendUserMessage(`/varisdev-new-session ${record.id}`, {
        expandPromptTemplates: true,
      });
      if (!request.commandStarted) {
        throw new Error(
          'Pi did not dispatch the session handover command. Use Pi 0.85.1 or newer.',
        );
      }
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      finish(
        request,
        'failed',
        `The session command could not start: ${record.error}`,
      );
      request.lease.cancel();
      return result({outcome: 'failed', handover: inspect(record)});
    }
    return result({outcome: 'scheduled', handover: inspect(record)});
  }

  function hasPending(ctx: ExtensionContext): boolean {
    return Boolean(getHistory(ctx).pending);
  }

  function cancelPending(
    id: string,
    ctx: ExtensionContext,
    reason: string,
  ): boolean {
    const request = getHistory(ctx).pending;
    if (!request || request.record.id !== id || !cancellable(request.record))
      return false;
    cancel(request, reason);
    return true;
  }

  pi.registerTool({
    name: 'session_new',
    label: 'Start fresh parent session',
    description:
      'Schedule a fresh parent session and continue automatically from a handover. Returns a request ID and state. Background agents and queued work remain attached. Worker notifications are buffered immediately until the handover completes or is cancelled. A duplicate call returns the existing pending request.',
    promptGuidelines: [
      'Use session_new when the user requests a fresh parent session or has enabled an ongoing workflow with automatic handovers, including an instructed context usage threshold. A standing workflow instruction covers repeated handovers. Complete ordinary tasks in the current session.',
      'Write a self-contained handover with the task, user instructions, progress, decisions, files, checks, agent assignments, and concrete next steps. Only the handover and normal system/project instructions carry into the fresh parent context.',
      'Make session_new your last tool call in this conversation and finish the current turn. The parent starts a fresh session after this turn settles. If circumstances change while it is pending, use session_handover_status, session_handover_update or session_handover_cancel to manage the request.',
    ],
    executionMode: 'sequential',
    parameters: Type.Object({handover: handoverSchema}),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return schedule(params.handover, ctx, signal);
    },
  });

  pi.registerTool({
    name: 'session_handover_status',
    label: 'Inspect parent handovers',
    description:
      'Inspect a parent handover by ID, including its full text, state, timestamps, pending reason, revision and delivered revision. Omit ID to list recent requests with previews, newest first. The latest 50 requests remain available across fresh parent sessions in this runtime chain.',
    parameters: Type.Object({
      id: Type.Optional(idSchema),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 50,
          default: 10,
          description: 'Maximum requests to list when ID is omitted.',
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const history = getHistory(ctx);
      if (params.id) {
        const record = history.records.get(params.id);
        return result(
          record
            ? {outcome: 'found', handover: inspect(record)}
            : {outcome: 'not_found', id: params.id},
        );
      }
      const limit = Math.min(50, Math.max(1, params.limit ?? 10));
      return result({
        handovers: [...history.records.values()]
          .reverse()
          .slice(0, limit)
          .map(record => inspect(record, false)),
        total: history.records.size,
      });
    },
  });

  pi.registerTool({
    name: 'session_handover_update',
    label: 'Update parent handover',
    description:
      'Replace the complete handover text by request ID and increment its revision. Allowed until the prompt is dispatched to the destination, including while the runtime is switching. Returns updated, too_late or not_found, with the current state and delivered revision when available.',
    executionMode: 'sequential',
    parameters: Type.Object({id: idSchema, handover: handoverSchema}),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      validateText(params.handover);
      const record = getHistory(ctx).records.get(params.id);
      if (!record) return result({outcome: 'not_found', id: params.id});
      if (!editable(record))
        return result({outcome: 'too_late', handover: inspect(record)});
      record.handover = params.handover;
      record.revision++;
      record.updatedAt = new Date().toISOString();
      return result({outcome: 'updated', handover: inspect(record)});
    },
  });

  pi.registerTool({
    name: 'session_handover_cancel',
    label: 'Cancel parent handover',
    description:
      'Cancel a scheduled parent handover or one waiting for idle. Buffered worker messages return to the source. Once switching starts, Pi may dispose the source and cancellation returns too_late. Repeated cancellation returns already_cancelled. Other outcomes are cancelled and not_found.',
    executionMode: 'sequential',
    parameters: Type.Object({id: idSchema}),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const history = getHistory(ctx);
      const record = history.records.get(params.id);
      if (!record) return result({outcome: 'not_found', id: params.id});
      if (record.state === 'cancelled')
        return result({
          outcome: 'already_cancelled',
          handover: inspect(record),
        });
      if (!cancellable(record))
        return result({outcome: 'too_late', handover: inspect(record)});
      cancel(
        history.pending!,
        'Cancelled before session replacement began. Buffered worker messages return to the source session.',
      );
      return result({outcome: 'cancelled', handover: inspect(record)});
    },
  });

  pi.registerCommand('varisdev-new-session', {
    description:
      'Internal session_new command: wait for idle, replace the parent, and dispatch the handover.',
    handler: async (args, ctx) => {
      const request = getHistory(ctx).pending;
      if (
        !request ||
        args.trim() !== request.record.id ||
        request.commandStarted
      ) {
        throw new Error('No matching parent session handover request.');
      }
      request.commandStarted = true;
      const {record, lease} = request;
      record.state = 'waiting_for_idle';
      record.waitingAt = record.updatedAt = new Date().toISOString();
      record.pendingReason =
        'Waiting for the source turn and already queued host work to settle. Finish this turn. New worker messages are buffered. The handover can be updated or cancelled.';
      try {
        await Promise.race([ctx.waitForIdle(), request.stopWaiting.promise]);
        if (!cancellable(record)) return;
        if (request.signal?.aborted) {
          request.onAbort!();
          return;
        }
        // The host can dispose the source inside newSession, before setup or
        // withSession. Stop accepting cancellation before entering that call.
        record.state = 'switching';
        record.switchingAt = record.updatedAt = new Date().toISOString();
        record.pendingReason =
          'Pi is replacing the source runtime. Cancellation is too late; the text can still be updated until prompt dispatch.';
        stopListening(request); // The host aborts the old session during teardown.
        store.switching.set(record.id, request);
        const switched = await ctx.newSession({
          parentSession: record.sourceSessionFile,
          setup: async manager => {
            record.destinationSessionId = manager.getSessionId();
            record.destinationSessionFile = manager.getSessionFile();
            record.updatedAt = new Date().toISOString();
            store.sessions.set(record.destinationSessionId, request.history);
            lease.transfer(record.destinationSessionId);
          },
          withSession: async next => {
            request.replacement = next;
            await next.sendUserMessage(`/varisdev-resume-parent ${record.id}`, {
              expandPromptTemplates: true,
            });
            if (!request.configured) {
              throw (
                request.error ??
                new Error('The fresh parent did not accept its handover.')
              );
            }
            // Freeze only here, after asynchronous model restoration. Receipt
            // is acknowledged by message_start, rather than by a void Pi API.
            request.prompt = handoverPrompt(record);
            record.dispatchedRevision = record.revision;
            record.dispatchedAt = record.updatedAt = new Date().toISOString();
            record.pendingReason =
              'The handover prompt was dispatched; waiting for the destination to receive it. Updates and cancellation are too late.';
            const run = next.sendUserMessage(request.prompt);
            await Promise.race([
              request.received.promise,
              run.then(() => {
                if (record.deliveredRevision === undefined)
                  throw new Error(
                    'The destination did not receive the handover prompt.',
                  );
              }),
            ]);
          },
        });
        if (switched.cancelled) {
          cancel(
            request,
            'Pi cancelled the session switch. Buffered worker messages return to the source session.',
          );
        } else if (record.deliveredRevision === undefined) {
          throw new Error('The session host did not start the fresh parent.');
        }
      } catch (error) {
        // An idle failure arriving concurrently with cancellation must not
        // replace the settled outcome or restore the source a second time.
        if (request.history.pending !== request) return;
        record.error = error instanceof Error ? error.message : String(error);
        let sourceIsActive = false;
        try {
          sourceIsActive =
            ctx.sessionManager.getSessionId() === record.sourceSessionId;
        } catch {
          // Session replacement invalidates the old context.
        }
        let recovery: string;
        try {
          if (sourceIsActive) {
            lease.cancel();
            recovery =
              'Background agents and buffered messages remain with the source session.';
          } else if (lease.resume()) {
            recovery =
              'Background agents and buffered messages remain with the destination session.';
          } else {
            await lease.close();
            recovery =
              'No live parent could claim the agents; their workers were closed.';
          }
        } catch (recoveryError) {
          recovery = `Agent recovery also failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`;
        }
        finish(
          request,
          'failed',
          `Handover failed: ${record.error} ${recovery}`,
        );
        console.error(record.pendingReason);
        try {
          (request.replacement ?? ctx).ui.notify(record.pendingReason, 'error');
        } catch {
          // Host shutdown may already have disposed the UI.
        }
      } finally {
        store.switching.delete(record.id);
        if (record.destinationSessionId || record.error) {
          // Retain a live source on pre-replacement failure; stale contexts throw.
          try {
            ctx.sessionManager.getSessionId();
          } catch {
            store.sessions.delete(record.sourceSessionId);
          }
        }
      }
    },
  });

  pi.registerCommand('varisdev-resume-parent', {
    description:
      'Internal session_new command: attach agents and restore the fresh parent settings.',
    handler: async (args, ctx) => {
      const request = store.switching.get(args.trim());
      if (
        !request ||
        request.configured ||
        request.record.destinationSessionId !==
          ctx.sessionManager.getSessionId()
      ) {
        throw new Error('No handover is waiting for this parent session.');
      }
      try {
        agents.attach(ctx);
        const model = ctx.modelRegistry.find(
          request.model.provider,
          request.model.id,
        );
        if (!model || !(await pi.setModel(model))) {
          throw new Error(
            `The handover model is unavailable: ${request.model.provider}/${request.model.id}`,
          );
        }
        pi.setThinkingLevel(request.thinkingLevel);
        pi.setActiveTools(request.activeTools);
        request.configured = true;
      } catch (error) {
        request.error = error;
        throw error;
      }
    },
  });

  pi.on('session_start', (_event, ctx) => {
    const request = getHistory(ctx).pending;
    if (
      request?.record.destinationSessionId === ctx.sessionManager.getSessionId()
    ) {
      // setup runs before host rebind/session_start. Claim the team now so a
      // later rebind or model restoration failure keeps the live parent usable.
      request.replacement = ctx;
      agents.attach(ctx);
    }
  });

  pi.on('message_start', (event, ctx) => {
    const request = getHistory(ctx).pending;
    if (
      !request?.prompt ||
      request.record.destinationSessionId !==
        ctx.sessionManager.getSessionId() ||
      event.message.role !== 'user'
    )
      return;
    const content = event.message.content;
    const text =
      typeof content === 'string'
        ? content
        : content
            .filter(part => part.type === 'text')
            .map(part => part.text)
            .join('\n');
    if (text !== request.prompt) return;
    request.record.deliveredRevision = request.record.dispatchedRevision;
    finish(
      request,
      'completed',
      `The destination received revision ${request.record.deliveredRevision}. Background agents remain attached.`,
    );
    request.received.resolve();
  });

  pi.on('session_shutdown', async (event, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    const history = store.sessions.get(id);
    const request = history?.pending;
    if (
      request &&
      request.record.sourceSessionId === id &&
      cancellable(request.record)
    ) {
      // This is an ordinary shutdown, rather than our committed switch. The
      // team controller may have preserved a prepared lease for reason=new;
      // restoring it here would attach workers to the outgoing dead runtime.
      finish(
        request,
        'cancelled',
        'The source session shut down before the handover began.',
      );
      store.sessions.delete(id);
      await request.lease.close();
      return;
    }
    // A matching new-session transition keeps history until setup installs it
    // on the destination. Ordinary shutdowns release the in-memory history.
    if (!(
      event.reason === 'new' &&
      request?.record.state === 'switching' &&
      request.record.sourceSessionId === id
    ))
      store.sessions.delete(id);
  });

  return {schedule, hasPending, cancelPending};
}
