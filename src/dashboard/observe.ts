import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {basename} from 'node:path';
import type {AgentSessionController} from '../agents/team.ts';
import {DashboardState, type ConversationMessage} from './state.ts';
import {observeFileChanges} from './changes.ts';

/** Only public response text is shown; thinking and provider payloads stay out. */
function messageText(message: {content?: unknown}): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n');
}

export function observeDashboardSession(
  pi: ExtensionAPI,
  control: AgentSessionController,
  onReady: (state: DashboardState, ctx: ExtensionContext) => void,
): void {
  let state: DashboardState | undefined;
  let unsubscribe: (() => void) | undefined;
  const tools = new Map<string, string>();
  let lastError: string | undefined;
  let sessionId: string | undefined;
  let seenChanges = new Set<string>();
  let sequence = 0;
  let assistantMessage: {id: string; at: string} | undefined;
  let userMessage: {id: string; at: string} | undefined;
  observeFileChanges(pi, change => {
    state?.recordChange({...change, unitId: 'parent', unitName: 'Mastermind'});
  });

  function metadata(ctx: ExtensionContext) {
    const usage = ctx.getContextUsage();
    return {
      name: ctx.sessionManager.getSessionName() || basename(ctx.cwd),
      cwd: ctx.cwd,
      sessionFile: ctx.sessionManager.getSessionFile(),
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      context: usage
        ? {
            tokens: usage.tokens,
            window: usage.contextWindow,
            percent: usage.percent,
          }
        : undefined,
    };
  }

  function activity(fallback: string): string {
    return tools.size
      ? `Using ${[...new Set(tools.values())].join(', ')}`
      : fallback;
  }

  function syncTeam(): void {
    const team = control.snapshot();
    if (state && team && team.sessionId === sessionId) {
      state.updateTeam(team.agents, team.messages);
      for (const change of team.changes) {
        if (!seenChanges.has(change.id)) state.recordChange(change);
      }
      seenChanges = new Set(team.changes.map(change => change.id));
    }
  }

  function restoreConversation(ctx: ExtensionContext): void {
    const branch = ctx.sessionManager.getBranch();
    let prompt = '';
    let response = '';
    const conversation: ConversationMessage[] = [];
    for (const entry of branch) {
      if (entry.type !== 'message') continue;
      if (entry.message.role === 'user' || entry.message.role === 'assistant') {
        const text = messageText(entry.message);
        const error =
          entry.message.role === 'assistant'
            ? entry.message.errorMessage
            : undefined;
        if (text || error)
          conversation.push({
            id: entry.id,
            role: entry.message.role,
            text,
            at: entry.timestamp,
            error,
          });
      }
      if (entry.message.role === 'user') {
        prompt = messageText(entry.message);
        response = '';
      } else if (entry.message.role === 'assistant') {
        const text = messageText(entry.message);
        if (text) response = text;
      }
    }
    state?.updateSession({prompt, response});
    state?.replaceConversation(conversation);
  }

  pi.on('session_start', (_event, ctx) => {
    unsubscribe?.();
    tools.clear();
    lastError = undefined;
    seenChanges.clear();
    sequence = 0;
    assistantMessage = undefined;
    userMessage = undefined;
    sessionId = ctx.sessionManager.getSessionId();
    const now = new Date().toISOString();
    state = new DashboardState({
      ...metadata(ctx),
      id: ctx.sessionManager.getSessionId(),
      status: ctx.isIdle() ? 'idle' : 'running',
      activity: ctx.isIdle() ? 'Ready for a task' : 'Working',
      startedAt: ctx.sessionManager.getHeader()?.timestamp ?? now,
      updatedAt: now,
    });
    restoreConversation(ctx);
    unsubscribe = control.subscribe(syncTeam);
    syncTeam();
    state.record('session', 'Session connected');
    onReady(state, ctx);
  });
  pi.on('before_agent_start', (event, ctx) => {
    lastError = undefined;
    state?.updateSession({
      ...metadata(ctx),
      prompt: event.prompt,
      response: '',
      error: undefined,
    });
    state?.record('message', event.prompt);
  });
  pi.on('agent_start', (_event, ctx) => {
    state?.updateSession({
      ...metadata(ctx),
      status: 'running',
      activity: 'Working',
    });
    state?.record('session', 'Mastermind started working');
  });
  pi.on('message_start', event => {
    if (event.message.role !== 'user' && event.message.role !== 'assistant')
      return;
    const entry = {
      id: `live-${++sequence}`,
      at: new Date(event.message.timestamp).toISOString(),
    };
    if (event.message.role === 'assistant') assistantMessage = entry;
    else userMessage = entry;
    const text = messageText(event.message);
    if (text)
      state?.updateConversation({
        ...entry,
        role: event.message.role,
        text,
        streaming: event.message.role === 'assistant',
      });
  });
  pi.on('message_update', event => {
    if (event.message.role !== 'assistant') return;
    const text = messageText(event.message);
    if (text && assistantMessage)
      state?.updateConversation({
        ...assistantMessage,
        role: 'assistant',
        text,
        streaming: true,
      });
    state?.updateSession({
      response: text,
      activity: activity(text ? 'Responding' : 'Thinking'),
    });
  });
  pi.on('message_end', (event, ctx) => {
    if (event.message.role !== 'assistant' && event.message.role !== 'user')
      return;
    const text = messageText(event.message);
    const entry = (event.message.role === 'assistant'
      ? assistantMessage
      : userMessage) ?? {
      id: `live-${++sequence}`,
      at: new Date(event.message.timestamp).toISOString(),
    };
    const error =
      event.message.role === 'assistant'
        ? event.message.errorMessage
        : undefined;
    if (text || error)
      state?.updateConversation({
        ...entry,
        role: event.message.role,
        text,
        error,
        streaming: false,
      });
    if (event.message.role !== 'assistant') return;
    if (event.message.errorMessage) {
      lastError = event.message.errorMessage;
      state?.record('error', lastError);
      state?.updateSession({error: lastError.slice(0, 4000)});
    }
    state?.updateSession({...metadata(ctx), ...(text ? {response: text} : {})});
  });
  pi.on('tool_execution_start', event => {
    tools.set(event.toolCallId, event.toolName);
    state?.updateSession({activity: activity('Working')});
    state?.record('tool', `Using ${event.toolName}`);
  });
  pi.on('tool_execution_end', event => {
    tools.delete(event.toolCallId);
    state?.updateSession({activity: activity('Working')});
    state?.record(
      event.isError ? 'error' : 'tool',
      `${event.toolName} ${event.isError ? 'failed' : 'finished'}`,
    );
  });
  pi.on('agent_settled', (_event, ctx) => {
    tools.clear();
    state?.updateSession({
      ...metadata(ctx),
      status: 'idle',
      activity: lastError
        ? `Error: ${lastError.slice(0, 1000)}`
        : 'Ready for a task',
    });
    state?.record(
      'session',
      lastError ? 'Run ended with an error' : 'Mastermind finished',
    );
  });
  pi.on('session_before_compact', () => {
    state?.updateSession({
      status: 'compacting',
      activity: 'Compacting conversation',
    });
    state?.record('session', 'Compacting conversation');
  });
  const afterCompaction = (ctx: ExtensionContext) => {
    state?.updateSession({
      ...metadata(ctx),
      status: ctx.isIdle() ? 'idle' : 'running',
      activity: ctx.isIdle() ? 'Ready for a task' : 'Working',
    });
  };
  pi.on('session_compact', (_event, ctx) => afterCompaction(ctx));
  pi.on('session_compact_failed', (event, ctx) => {
    afterCompaction(ctx);
    state?.record('error', event.errorMessage ?? 'Compaction cancelled');
  });
  pi.on('model_select', (event, ctx) => {
    state?.updateSession({
      ...metadata(ctx),
      model: `${event.model.provider}/${event.model.id}`,
    });
  });
  pi.on('session_info_changed', (_event, ctx) => {
    state?.updateSession(metadata(ctx));
  });
  pi.on('session_tree', (_event, ctx) => restoreConversation(ctx));
  pi.on('session_shutdown', () => {
    unsubscribe?.();
    unsubscribe = undefined;
    tools.clear();
    state?.updateSession({status: 'closed', activity: 'Session closed'});
    state?.record('session', 'Session closed');
    state = undefined;
    assistantMessage = undefined;
    userMessage = undefined;
    sessionId = undefined;
    seenChanges.clear();
  });
}
