import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {basename} from 'node:path';
import type {AgentSessionController} from '../agents/team.ts';
import {DashboardState, type ConversationMessage} from './state.ts';
import {observeFileChanges} from './changes.ts';
import {modelUsage, compactionUsage, type ModelUsageCall} from '../usage.ts';

const outputLimit = 16000;
const inputLimit = 8000;

function publicText(text: string): string {
  return text.replace(
    /data:image\/[^;\s]+;base64,[a-z0-9+/=]+/gi,
    '[Image omitted]',
  );
}

/** Read only public text blocks, with no thinking, images or result details. */
function messageText(message: {content?: unknown}): string {
  if (typeof message.content === 'string')
    return publicText(message.content).slice(0, outputLimit + 1);
  if (!Array.isArray(message.content)) return '';
  let text = '';
  for (const part of message.content) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    text +=
      (text ? '\n' : '') + publicText(part.text).slice(0, outputLimit + 1);
    if (text.length > outputLimit) return text.slice(0, outputLimit + 1);
  }
  return text;
}

/** Put the useful command, path or URL on the summary's first line. */
function toolInput(args: unknown): string {
  let remaining = inputLimit + 1;
  let nodes = 0;
  function clean(value: unknown, depth = 0): unknown {
    if (remaining <= 0 || ++nodes > 100 || depth > 6)
      return '[Arguments truncated]';
    if (typeof value === 'string') {
      const text = publicText(value).slice(0, remaining);
      remaining -= text.length;
      return text;
    }
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value))
      return value.slice(0, 30).map(item => clean(item, depth + 1));
    const record = value as Record<string, unknown>;
    if (
      record.type === 'image' ||
      (typeof record.mimeType === 'string' &&
        record.mimeType.startsWith('image/'))
    )
      return '[Image omitted]';
    if (record.type === 'thinking') return '[Thinking omitted]';
    return Object.fromEntries(
      Object.entries(record)
        .slice(0, 40)
        .map(([key, item]) => [
          key.slice(0, 200),
          /^(?:base64|thinking|thoughtSignature|signature|providerMetadata)$/i.test(
            key,
          )
            ? '[Omitted]'
            : clean(item, depth + 1),
        ]),
    );
  }
  try {
    const record =
      args && typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : undefined;
    const key = ['command', 'path', 'file_path', 'url'].find(
      key => typeof record?.[key] === 'string' && record[key],
    );
    const summary = key
      ? publicText(record![key] as string).slice(0, inputLimit + 1)
      : '';
    remaining -= summary.length;
    const rest = key
      ? Object.fromEntries(
          Object.entries(record!).filter(([name]) => name !== key),
        )
      : args;
    const details = JSON.stringify(clean(rest), null, 2) ?? '';
    return (
      summary +
      (summary && details !== '{}' ? '\n' : '') +
      (summary && details === '{}' ? '' : details)
    ).slice(0, inputLimit + 1);
  } catch {
    return '[Arguments unavailable]';
  }
}

function resultStatus(
  isError: boolean,
  text: string,
): ConversationMessage['status'] {
  if (!isError) return 'completed';
  return /^(?:Operation|Tool execution) (?:aborted|cancelled)\.?$/i.test(
    text.trim(),
  )
    ? 'cancelled'
    : 'failed';
}

function toolId(toolCallId: string): string {
  return `tool-${toolCallId}`;
}

function messageId(role: string, timestamp: number, sequence: number): string {
  return `message-${role}-${timestamp}-${sequence}`;
}

type MessageIdentity = {id: string; at: string; sequence: number};

export interface DashboardCustomMessage {
  role: 'custom';
  customType: string;
  content: unknown;
  display: boolean;
  timestamp: number;
}

export function observeDashboardSession(
  pi: ExtensionAPI,
  control: AgentSessionController,
  onReady: (state: DashboardState, ctx: ExtensionContext) => void,
  existingState?: DashboardState,
): (message: DashboardCustomMessage, ctx: ExtensionContext) => void {
  let state: DashboardState | undefined;
  let unsubscribe: (() => void) | undefined;
  const tools = new Map<string, string>();
  let lastError: string | undefined;
  let sessionId: string | undefined;
  let seenChanges = new Set<string>();
  let assistantMessage: MessageIdentity | undefined;
  let userMessage: MessageIdentity | undefined;
  let messageSequence = 0;
  let customSequence = 0;
  const messageIdentities: Array<{
    message: WeakRef<object>;
    entry: MessageIdentity;
  }> = [];

  function rememberMessage(message: object, entry: MessageIdentity): void {
    messageIdentities.push({message: new WeakRef(message), entry});
    if (messageIdentities.length > 100) messageIdentities.shift();
  }

  function knownMessage(
    message: object,
    ctx: ExtensionContext,
  ): MessageIdentity | undefined {
    const known = messageIdentities.findLast(
      item => item.message.deref() === message,
    )?.entry;
    if (known) return known;
    // SDK history supplies the identity of old completions after the small cache expires.
    let sequence = 0;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== 'message') continue;
      if (entry.message.role !== 'user' && entry.message.role !== 'assistant')
        continue;
      sequence++;
      if (entry.message !== message) continue;
      const identity = {
        id: messageId(entry.message.role, entry.message.timestamp, sequence),
        at: new Date(entry.message.timestamp).toISOString(),
        sequence,
      };
      rememberMessage(message, identity);
      return identity;
    }
    return undefined;
  }

  function newMessage(message: {
    role: string;
    timestamp: number;
  }): MessageIdentity {
    const sequence = ++messageSequence;
    const entry = {
      id: messageId(message.role, message.timestamp, sequence),
      at: new Date(message.timestamp).toISOString(),
      sequence,
    };
    rememberMessage(message, entry);
    return entry;
  }
  function showCustomMessage(
    message: DashboardCustomMessage,
    ctx: ExtensionContext,
    persisted = true,
  ): void {
    if (!state) return;
    let identity = messageIdentities.findLast(
      item => item.message.deref() === message,
    )?.entry;
    if (!identity && persisted) {
      let sequence = 0;
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== 'custom_message') continue;
        sequence++;
        if (
          entry.customType === message.customType &&
          entry.content === message.content &&
          entry.display === message.display
        )
          identity = {
            id: `custom-${sequence}`,
            at: entry.timestamp,
            sequence: 0,
          };
      }
      customSequence = Math.max(customSequence, sequence);
    }
    identity ??= {
      id: `custom-${++customSequence}`,
      at: new Date(message.timestamp).toISOString(),
      sequence: 0,
    };
    rememberMessage(message, identity);
    const text = messageText(message);
    if (message.display && text)
      state.updateConversation({
        id: identity.id,
        at: identity.at,
        role: 'assistant',
        text,
        streaming: false,
      });
  }

  observeFileChanges(pi, change => {
    state?.recordChange({
      ...change,
      unitId: 'parent',
      unitName: 'Parent session',
    });
  });

  function metadata(ctx: ExtensionContext) {
    const usage = ctx.getContextUsage();
    return {
      name: ctx.sessionManager.getSessionName() || basename(ctx.cwd),
      cwd: ctx.cwd,
      sessionFile: ctx.sessionManager.getSessionFile(),
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      thinkingLevel: pi.getThinkingLevel(),
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
    tools.clear();
    assistantMessage = undefined;
    userMessage = undefined;
    messageSequence = 0;
    customSequence = 0;
    messageIdentities.length = 0;
    let prompt = '';
    let response = '';
    const branch = ctx.sessionManager.getBranch();
    function* messages(): Generator<ConversationMessage> {
      for (const entry of branch) {
        if (entry.type === 'custom_message') {
          const id = `custom-${++customSequence}`;
          const text = messageText(entry);
          if (entry.display && text)
            yield {id, at: entry.timestamp, role: 'assistant', text};
          continue;
        }
        if (entry.type !== 'message') continue;
        const message = entry.message;
        const text = 'content' in message ? messageText(message) : '';
        const at =
          'timestamp' in message
            ? new Date(message.timestamp).toISOString()
            : entry.timestamp;
        if (message.role === 'user' || message.role === 'assistant') {
          const identity = newMessage(message);
          const error =
            message.role === 'assistant' ? message.errorMessage : undefined;
          if (text || error)
            yield {
              id: identity.id,
              role: message.role,
              text,
              at,
              error,
            };
          if (message.role === 'user') {
            prompt = text;
            response = '';
          } else {
            if (text) response = text;
            for (const part of message.content) {
              if (part.type !== 'toolCall') continue;
              yield {
                id: toolId(part.id),
                role: 'tool',
                toolCallId: part.id,
                toolName: part.name,
                input: toolInput(part.arguments),
                text: '',
                at,
                status: message.stopReason === 'error' ? 'failed' : 'cancelled',
                error:
                  message.stopReason === 'error' ||
                  message.stopReason === 'aborted'
                    ? error
                    : undefined,
                finishedAt: at,
              };
            }
          }
        } else if (message.role === 'toolResult') {
          yield {
            id: toolId(message.toolCallId),
            role: 'tool',
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            text,
            at,
            status: resultStatus(message.isError, text),
            error: message.isError
              ? text || 'Tool execution failed'
              : undefined,
            finishedAt: at,
            streaming: false,
          };
        }
      }
    }
    function* calls(): Generator<{call: ModelUsageCall; sequence: number}> {
      let sequence = 0;
      let summarySequence = 0;
      let summaryModel: string | undefined;
      for (const entry of branch) {
        if (entry.type === 'model_change')
          summaryModel = `${entry.provider}/${entry.modelId}`;
        if (entry.type === 'compaction') {
          summarySequence++;
          const call = compactionUsage(entry, summaryModel);
          if (call) yield {call, sequence: summarySequence};
          continue;
        }
        if (entry.type !== 'message') continue;
        const message = entry.message;
        if (message.role !== 'user' && message.role !== 'assistant') continue;
        sequence++;
        if (message.role !== 'assistant') continue;
        const call = modelUsage(message, {
          id: messageId(message.role, message.timestamp, sequence),
          at: new Date(message.timestamp).toISOString(),
        });
        if (call) yield {call, sequence};
      }
    }
    state?.replaceConversation(messages());
    state?.replaceUsage(calls());
    state?.updateSession({prompt, response});
  }

  function showCalls(
    message: {content?: unknown},
    at: string,
    error?: string,
    stopReason?: string,
  ): void {
    if (!Array.isArray(message.content)) return;
    for (const part of message.content) {
      if (part?.type !== 'toolCall' || typeof part.id !== 'string') continue;
      const previous = state?.conversationMessage(toolId(part.id));
      if (previous?.status && previous.status !== 'running') continue;
      const failed = stopReason === 'error' || stopReason === 'aborted';
      state?.updateConversation({
        ...previous,
        id: toolId(part.id),
        role: 'tool',
        toolCallId: part.id,
        toolName: part.name,
        input: toolInput(part.arguments),
        text: previous?.text ?? '',
        at: previous?.at ?? at,
        status: failed
          ? stopReason === 'aborted'
            ? 'cancelled'
            : 'failed'
          : 'running',
        error: failed ? error : undefined,
        streaming: !failed,
        finishedAt: failed ? new Date().toISOString() : undefined,
      });
    }
  }

  function finishTool(
    toolCallId: string,
    toolName: string,
    result: {content?: unknown},
    isError: boolean,
    at = new Date().toISOString(),
  ): void {
    const previous = state?.conversationMessage(toolId(toolCallId));
    const text = messageText(result);
    state?.updateConversation({
      ...previous,
      id: toolId(toolCallId),
      role: 'tool',
      toolCallId,
      toolName,
      at: previous?.at ?? at,
      text,
      status: resultStatus(isError, text),
      streaming: false,
      error: isError ? text || 'Tool execution failed' : undefined,
      finishedAt: previous?.finishedAt ?? at,
    });
    tools.delete(toolCallId);
  }

  pi.on('session_start', (_event, ctx) => {
    unsubscribe?.();
    tools.clear();
    lastError = undefined;
    seenChanges.clear();
    assistantMessage = undefined;
    userMessage = undefined;
    sessionId = ctx.sessionManager.getSessionId();
    const now = new Date().toISOString();
    const session = {
      ...metadata(ctx),
      id: ctx.sessionManager.getSessionId(),
      status: ctx.isIdle() ? ('idle' as const) : ('running' as const),
      activity: ctx.isIdle() ? 'Ready for a task' : 'Working',
      startedAt: ctx.sessionManager.getHeader()?.timestamp ?? now,
      updatedAt: now,
    };
    if (existingState?.snapshot().session.id === sessionId) {
      state = existingState;
      state.updateSession({...session, error: undefined});
    } else state = new DashboardState(session);
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
    state?.record('session', 'Parent session started working');
  });
  pi.on('message_start', (event, ctx) => {
    if (event.message.role === 'custom') {
      showCustomMessage(event.message, ctx, false);
      return;
    }
    if (event.message.role !== 'user' && event.message.role !== 'assistant')
      return;
    const entry = newMessage(event.message);
    const text = messageText(event.message);
    if (event.message.role === 'assistant') {
      assistantMessage = entry;
      state?.updateSession({
        activity: activity(text ? 'Responding' : 'Thinking'),
      });
    } else userMessage = entry;
    if (text)
      state?.updateConversation({
        id: entry.id,
        at: entry.at,
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
        id: assistantMessage.id,
        at: assistantMessage.at,
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
    if (event.message.role === 'custom') {
      showCustomMessage(event.message, ctx, false);
      return;
    }
    if (event.message.role === 'toolResult') {
      finishTool(
        event.message.toolCallId,
        event.message.toolName,
        event.message,
        event.message.isError,
        new Date(event.message.timestamp).toISOString(),
      );
      state?.updateSession({activity: activity('Working')});
      return;
    }
    if (event.message.role !== 'assistant' && event.message.role !== 'user')
      return;
    const text = messageText(event.message);
    const entry =
      (event.message.role === 'assistant' ? assistantMessage : userMessage) ??
      knownMessage(event.message, ctx) ??
      newMessage(event.message);
    rememberMessage(event.message, entry);
    const error =
      event.message.role === 'assistant'
        ? event.message.errorMessage
        : undefined;
    if (text || error)
      state?.updateConversation({
        id: entry.id,
        at: entry.at,
        role: event.message.role,
        text,
        error,
        streaming: false,
      });
    if (event.message.role !== 'assistant') {
      userMessage = undefined;
      return;
    }
    showCalls(event.message, entry.at, error, event.message.stopReason);
    const call = modelUsage(event.message, entry);
    if (call) state?.recordUsage(call, entry.sequence);
    assistantMessage = undefined;
    if (event.message.errorMessage) {
      lastError = publicText(event.message.errorMessage).slice(0, 4000);
      state?.record('error', lastError);
      state?.updateSession({error: lastError.slice(0, 4000)});
    }
    state?.updateSession({...metadata(ctx), ...(text ? {response: text} : {})});
  });
  pi.on('tool_execution_start', event => {
    const previous = state?.conversationMessage(toolId(event.toolCallId));
    if (previous?.status && previous.status !== 'running') return;
    tools.set(event.toolCallId, event.toolName);
    state?.updateConversation({
      ...previous,
      id: toolId(event.toolCallId),
      role: 'tool',
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      input: toolInput(event.args),
      text: previous?.text ?? '',
      at: previous?.at ?? new Date().toISOString(),
      status: 'running',
      streaming: true,
    });
    state?.updateSession({activity: activity('Working')});
    state?.recordTool(toolId(event.toolCallId), `Using ${event.toolName}`);
  });
  pi.on('tool_execution_update', event => {
    const previous = state?.conversationMessage(toolId(event.toolCallId));
    if (previous?.status && previous.status !== 'running') return;
    state?.updateConversation({
      ...previous,
      id: toolId(event.toolCallId),
      role: 'tool',
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      input: previous?.input ?? toolInput(event.args),
      text: messageText(event.partialResult ?? {}),
      at: previous?.at ?? new Date().toISOString(),
      status: 'running',
      streaming: true,
    });
  });
  pi.on('tool_execution_end', event => {
    const previous = state?.conversationMessage(toolId(event.toolCallId));
    finishTool(
      event.toolCallId,
      event.toolName,
      event.result ?? {},
      event.isError,
    );
    state?.updateSession({activity: activity('Working')});
    if (!previous?.status || previous.status === 'running')
      state?.recordTool(
        toolId(event.toolCallId),
        `${event.toolName} ${event.isError ? 'failed' : 'finished'}`,
        event.isError,
      );
  });
  pi.on('agent_settled', (_event, ctx) => {
    tools.clear();
    state?.settleConversation();
    assistantMessage = undefined;
    userMessage = undefined;
    state?.updateSession({
      ...metadata(ctx),
      status: 'idle',
      activity: lastError
        ? `Error: ${lastError.slice(0, 1000)}`
        : 'Ready for a task',
    });
    state?.record(
      'session',
      lastError ? 'Run ended with an error' : 'Parent session finished',
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
  pi.on('session_compact', (event, ctx) => {
    let sequence = 0;
    let model: string | undefined;
    let found = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'model_change')
        model = `${entry.provider}/${entry.modelId}`;
      if (entry.type !== 'compaction') continue;
      sequence++;
      found ||= entry.id === event.compactionEntry.id;
      const call = compactionUsage(
        entry,
        model ??
          (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
      );
      if (call) state?.recordUsage(call, sequence);
    }
    if (!found) {
      const call = compactionUsage(
        event.compactionEntry,
        ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      );
      if (call) state?.recordUsage(call, sequence + 1);
    }
    afterCompaction(ctx);
  });
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
  pi.on('thinking_level_select', event => {
    state?.updateSession({thinkingLevel: event.level});
  });
  pi.on('session_info_changed', (_event, ctx) => {
    state?.updateSession(metadata(ctx));
  });
  pi.on('session_tree', (_event, ctx) => restoreConversation(ctx));
  pi.on('session_shutdown', () => {
    unsubscribe?.();
    unsubscribe = undefined;
    tools.clear();
    state?.settleConversation();
    state?.updateSession({status: 'closed', activity: 'Session closed'});
    state?.record('session', 'Session closed');
    state = undefined;
    messageIdentities.length = 0;
    assistantMessage = undefined;
    userMessage = undefined;
    sessionId = undefined;
    seenChanges.clear();
  });
  return showCustomMessage;
}
