import {randomUUID} from 'node:crypto';
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBoundaryDraft,
} from '@earendil-works/pi-coding-agent';
import type {AgentOrchestrator, AgentRecord} from './orchestrator.ts';
import {isAgentFinished} from './orchestrator.ts';

const requestType = 'varisdev.agent-result-request';
const receiptType = 'varisdev.agent-result-receipt';
const resultType = 'varisdev.agent-results';

/** Pi boundaries deliver completed work without adding polling turns. */
export function registerAgentCompletions(
  pi: ExtensionAPI,
  managerFor: (ctx: ExtensionContext) => AgentOrchestrator,
  content: (records: AgentRecord[]) => Array<{type: 'text'; text: string}>,
  callerId?: string,
  getHostSignal?: () => AbortSignal | undefined,
) {
  const pending = new Map<string, string>();
  let unsubscribe: (() => void) | undefined;
  let idleLaunch = false;
  let waking = false;
  let stopped = false;
  let context: ExtensionContext | undefined;
  let hostSignal: AbortSignal | undefined;
  const stop = () => {
    stopped = true;
    idleLaunch = false;
  };

  function restore(ctx: ExtensionContext) {
    const entries =
      ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.();
    if (!entries) return;
    pending.clear();
    for (const entry of entries) {
      if (entry.type === 'custom' && entry.customType === requestType) {
        const data = entry.data as {id?: unknown; ticket?: unknown};
        if (typeof data?.id === 'string' && typeof data.ticket === 'string')
          pending.set(data.id, data.ticket);
      } else if (
        (entry.type === 'custom' && entry.customType === receiptType) ||
        (entry.type === 'custom_message' && entry.customType === resultType)
      ) {
        const data = (entry.type === 'custom' ? entry.data : entry.details) as {
          tickets?: unknown;
        };
        if (!Array.isArray(data?.tickets)) continue;
        for (const [id, ticket] of pending)
          if (data.tickets.includes(ticket)) pending.delete(id);
      }
    }
  }
  function records(ctx: ExtensionContext) {
    const manager = managerFor(ctx);
    return [...pending.keys()].flatMap(id => {
      try {
        return [manager.get(id)];
      } catch {
        pending.delete(id);
        return [];
      }
    });
  }
  function take(ctx: ExtensionContext) {
    const completed = records(ctx).filter(record =>
      isAgentFinished(record.status),
    );
    if (!completed.length) return undefined;
    const tickets = completed.map(record => pending.get(record.id)!);
    for (const record of completed) pending.delete(record.id);
    const manager = managerFor(ctx);
    const used = completed.map(record => manager.touch(record.id));
    return {
      customType: resultType,
      content: content(used),
      display: false,
      details: {tickets},
    };
  }
  function wakeIfReady() {
    if (!idleLaunch || callerId || stopped || waking || !context?.isIdle?.())
      return;
    const current = records(context);
    if (
      !current.length ||
      current.some(record => !isAgentFinished(record.status))
    )
      return;
    waking = true;
    queueMicrotask(() => {
      try {
        if (!context || stopped || !idleLaunch || !context.isIdle()) return;
        const message = take(context);
        if (message)
          pi.sendMessage(message, {triggerTurn: Boolean(context.model)});
      } finally {
        waking = false;
      }
    });
  }
  function observe(ctx: ExtensionContext) {
    context = ctx;
    unsubscribe ??= managerFor(ctx).subscribe(wakeIfReady);
    const signal = getHostSignal?.();
    if (hostSignal !== signal) {
      hostSignal?.removeEventListener('abort', stop);
      hostSignal = signal;
      hostSignal?.addEventListener('abort', stop, {once: true});
    }
    if (hostSignal?.aborted) stop();
  }
  pi.on('session_start', (_event, ctx) => {
    stopped = false;
    idleLaunch = false;
    context = ctx;
    unsubscribe?.();
    unsubscribe = undefined;
    hostSignal?.removeEventListener('abort', stop);
    hostSignal = undefined;
    restore(ctx);
  });
  pi.on('agent_start', (_event, ctx) => {
    stopped = false;
    idleLaunch = false;
    observe(ctx);
  });
  pi.on('before_agent_start', (event, ctx) => {
    restore(ctx);
    // Pi persists a triggering custom message after this hook.
    if (
      event.messageType === 'custom' &&
      event.message.customType === resultType
    ) {
      const details = event.message.details as {tickets?: unknown};
      if (Array.isArray(details?.tickets))
        for (const [id, ticket] of pending)
          if (details.tickets.includes(ticket)) pending.delete(id);
    }
    const message = take(ctx);
    return message ? {message} : undefined;
  });
  pi.on('turn_end', async (event, ctx) => {
    if (stopped || event.outcome !== 'completed' || ctx.signal?.aborted) return;
    const hasToolCalls =
      event.message.role === 'assistant' &&
      event.message.content.some(block => block.type === 'toolCall');
    // Keep Pi's turn signal active so Stop can interrupt the wait.
    if (
      !hasToolCalls &&
      !event.continue &&
      !event.context.pendingMessages.length
    ) {
      const outstanding = records(ctx).map(record => record.id);
      if (outstanding.length) {
        const input = new AbortController();
        const signal = ctx.signal
          ? AbortSignal.any([ctx.signal, input.signal])
          : input.signal;
        // Pi exposes queued input through context while this boundary is held.
        const checkInput = () => {
          if (stopped || ctx.hasPendingMessages?.()) input.abort();
        };
        const timer = setInterval(checkInput, 50);
        timer.unref();
        checkInput();
        try {
          await managerFor(ctx).wait(outstanding, {
            timeoutMs: null,
            signal,
            callerId,
          });
        } catch (error) {
          if (ctx.signal?.aborted || stopped) return;
          if (!input.signal.aborted) throw error;
        } finally {
          clearInterval(timer);
        }
      }
    }
    if (stopped || ctx.signal?.aborted) return;
    const message = take(ctx);
    if (!message) return;
    return {
      entries: [
        ...event.entries,
        {type: 'custom_message', ...message},
      ] as SessionBoundaryDraft[],
      continue: true,
    };
  });
  pi.on('agent_before_settle', (event, ctx) => {
    if (stopped || event.outcome !== 'completed' || ctx.signal?.aborted) return;
    const message = take(ctx);
    if (!message) return;
    return {
      entries: [
        ...event.entries,
        {type: 'custom_message', ...message},
      ] as SessionBoundaryDraft[],
      continue: true,
    };
  });
  pi.on('agent_settled', (event, ctx) => {
    idleLaunch = false;
    if (event.aborted) {
      stopped = true;
      restore(ctx);
    }
  });
  pi.on('session_shutdown', () => {
    stopped = true;
    idleLaunch = false;
    unsubscribe?.();
    unsubscribe = undefined;
    hostSignal?.removeEventListener('abort', stop);
    hostSignal = undefined;
  });
  return {
    track(id: string, ctx: ExtensionContext) {
      stopped = false;
      idleLaunch = !callerId && ctx.isIdle?.() === true;
      observe(ctx);
      const ticket = randomUUID();
      pending.set(id, ticket);
      pi.appendEntry?.(requestType, {id, ticket});
      wakeIfReady();
    },
    inspect() {
      idleLaunch = false;
    },
    acknowledge(completed: AgentRecord[]) {
      const tickets = completed
        .filter(record => isAgentFinished(record.status))
        .map(record => pending.get(record.id))
        .filter((ticket): ticket is string => Boolean(ticket));
      if (!tickets.length) return;
      for (const [id, ticket] of pending)
        if (tickets.includes(ticket)) pending.delete(id);
      pi.appendEntry?.(receiptType, {tickets});
    },
  };
}
