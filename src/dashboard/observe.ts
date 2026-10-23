import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {basename} from 'node:path';
import {
  archiveAgentRecord,
  type AgentSessionController,
} from '../agents/team.ts';
import {DashboardState, type ConversationMessage} from './state.ts';
import {observeFileChanges} from './changes.ts';
import {sessionAgentProfile} from './features.ts';
import {sessionSpeedMode, type SpeedMode} from '../speed-modes.ts';
import {modelUsage, compactionUsage, sessionUsageCalls} from '../usage.ts';
import {
  messageText,
  conversationVisualizations,
  publicText,
  resultStatus,
  toolInput,
} from '../conversation.ts';

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
  details?: unknown;
  display: boolean;
  timestamp: number;
}

export interface DashboardSessionObserver {
  (message: DashboardCustomMessage, ctx: ExtensionContext): void;
  restore(ctx: ExtensionContext): void;
  restoreUsage(ctx: ExtensionContext): void;
}

export function observeDashboardSession(
  pi: ExtensionAPI,
  control: AgentSessionController,
  onReady: (state: DashboardState, ctx: ExtensionContext) => void,
  existingState?: DashboardState,
): DashboardSessionObserver {
  let state: DashboardState | undefined;
  let cwd = process.cwd();
  let unsubscribe: (() => void) | undefined;
  let teamTimer: ReturnType<typeof setTimeout> | undefined;
  const tools = new Map<string, string>();
  let lastError: string | undefined;
  let sessionId: string | undefined;
  let seenChanges = new Set<string>();
  let assistantMessage: MessageIdentity | undefined;
  let userMessage: MessageIdentity | undefined;
  let messageSequence = 0;
  let customSequence = 0;
  let messageIdentities = new WeakMap<object, MessageIdentity>();

  function rememberMessage(message: object, entry: MessageIdentity): void {
    messageIdentities.set(message, entry);
  }

  function knownMessage(
    message: object,
    ctx: ExtensionContext,
  ): MessageIdentity | undefined {
    const known = messageIdentities.get(message);
    if (known) return known;
    // SDK history supplies identities when a completion uses another message object.
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
    let identity = messageIdentities.get(message);
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
    if (!message.display) return;
    const text = messageText(message);
    const visuals = conversationVisualizations(message, undefined, ctx.cwd);
    if (
      message.display &&
      (text || visuals.visualizations || visuals.visualizationErrors)
    )
      state.updateConversation({
        id: identity.id,
        at: identity.at,
        role: 'assistant',
        text,
        ...visuals,
        streaming: false,
      });
  }

  observeFileChanges(pi, change => {
    state?.recordChange({
      ...change,
      unitId: 'parent',
      unitName: 'Main agent',
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
      speedMode: sessionSpeedMode(ctx),
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
    clearTimeout(teamTimer);
    teamTimer = undefined;
    const team = control.deliverySnapshot?.() ?? control.snapshot();
    if (!state) return;
    if (team && team.sessionId === sessionId) {
      state.batch(() => {
        state!.updateTeam(team.agents, team.messages, true);
        for (const change of team.changes) {
          if (!seenChanges.has(change.id)) state!.recordChange(change);
        }
        seenChanges = new Set(team.changes.map(change => change.id));
      });
    } else {
      archiveTeam();
    }
  }

  function archiveTeam(): void {
    if (!state) return;
    const agents = state.deliverySnapshot().agents;
    if (agents.length)
      state.updateTeam(agents.map(archiveAgentRecord), [], true);
  }

  function scheduleTeamSync(): void {
    if (teamTimer) return;
    teamTimer = setTimeout(syncTeam, 40);
    teamTimer.unref();
  }

  function restoreUsage(ctx: ExtensionContext): void {
    state?.replaceUsage(sessionUsageCalls(ctx.sessionManager.getBranch()));
  }

  function restoreConversation(ctx: ExtensionContext): void {
    tools.clear();
    assistantMessage = undefined;
    userMessage = undefined;
    messageSequence = 0;
    customSequence = 0;
    messageIdentities = new WeakMap();
    let prompt = '';
    let response = '';
    lastError = undefined;
    const branch = ctx.sessionManager.getBranch();
    function* messages(): Generator<ConversationMessage> {
      for (const entry of branch) {
        if (entry.type === 'custom_message') {
          const id = `custom-${++customSequence}`;
          if (!entry.display) continue;
          const text = messageText(entry);
          const visuals = conversationVisualizations(entry, undefined, ctx.cwd);
          if (
            entry.display &&
            (text || visuals.visualizations || visuals.visualizationErrors)
          )
            yield {
              id,
              at: entry.timestamp,
              role: 'assistant',
              text,
              ...visuals,
            };
          continue;
        }
        if (entry.type !== 'message') continue;
        const message = entry.message;
        const text = 'content' in message ? messageText(message) : '';
        const visuals =
          'content' in message && (message.role !== 'custom' || message.display)
            ? conversationVisualizations(message, undefined, ctx.cwd)
            : {};
        const at =
          'timestamp' in message
            ? new Date(message.timestamp).toISOString()
            : entry.timestamp;
        if (message.role === 'user' || message.role === 'assistant') {
          const identity = newMessage(message);
          const error =
            message.role === 'assistant' ? message.errorMessage : undefined;
          if (
            text ||
            error ||
            visuals.visualizations ||
            visuals.visualizationErrors
          )
            yield {
              id: identity.id,
              role: message.role,
              text,
              ...visuals,
              at,
              error,
            };
          lastError = error ? publicText(error) : undefined;
          if (message.role === 'user') {
            prompt = text;
            response = '';
          } else {
            response = text;
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
        } else if (message.role === 'custom') {
          if (
            message.display &&
            (text || visuals.visualizations || visuals.visualizationErrors)
          )
            yield {
              id: `custom-${++customSequence}`,
              at,
              role: 'assistant',
              text,
              ...visuals,
            };
        } else if (message.role === 'toolResult') {
          yield {
            id: toolId(message.toolCallId),
            role: 'tool',
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            text,
            ...visuals,
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
    state?.batch(() => {
      state!.replaceConversation(messages());
      restoreUsage(ctx);
      state!.updateSession({
        prompt,
        response,
        error: lastError,
        ...(ctx.isIdle()
          ? {
              activity: lastError
                ? `Error: ${lastError.slice(0, 1000)}`
                : 'Ready for a task',
            }
          : {}),
      });
    });
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
    result: {content?: unknown; details?: unknown},
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
      ...conversationVisualizations(result, undefined, cwd),
      status: resultStatus(isError, text),
      streaming: false,
      error: isError ? text || 'Tool execution failed' : undefined,
      finishedAt: previous?.finishedAt ?? at,
    });
    tools.delete(toolCallId);
  }

  pi.on('session_start', (_event, ctx) => {
    cwd = ctx.cwd;
    unsubscribe?.();
    clearTimeout(teamTimer);
    teamTimer = undefined;
    tools.clear();
    lastError = undefined;
    seenChanges.clear();
    assistantMessage = undefined;
    userMessage = undefined;
    sessionId = ctx.sessionManager.getSessionId();
    const now = new Date().toISOString();
    const session = {
      ...metadata(ctx),
      agentProfile: sessionAgentProfile(ctx.sessionManager),
      id: ctx.sessionManager.getSessionId(),
      status: ctx.isIdle() ? ('idle' as const) : ('running' as const),
      activity: ctx.isIdle() ? 'Ready for a task' : 'Working',
      startedAt: ctx.sessionManager.getHeader()?.timestamp ?? now,
      updatedAt: now,
    };
    const reused = existingState?.deliverySnapshot().session.id === sessionId;
    state = reused ? existingState : new DashboardState(session);
    state!.batch(() => {
      if (reused) state!.updateSession({...session, error: undefined});
      restoreConversation(ctx);
      syncTeam();
      state!.record('session', 'Session connected');
    });
    unsubscribe = control.subscribe(scheduleTeamSync);
    onReady(state!, ctx);
  });
  pi.on('before_agent_start', (event, ctx) => {
    state?.batch(() => {
      // Pick up usage appended while idle before this run starts.
      restoreUsage(ctx);
      lastError = undefined;
      const prompt = 'prompt' in event ? event.prompt : undefined;
      state!.updateSession({
        ...metadata(ctx),
        ...(prompt !== undefined ? {prompt} : {}),
        response: '',
        error: undefined,
      });
      if (prompt !== undefined) state!.record('message', prompt);
    });
  });
  pi.on('agent_start', (_event, ctx) => {
    state?.batch(() => {
      lastError = undefined;
      state!.updateSession({
        ...metadata(ctx),
        status: 'running',
        activity: 'Working',
        error: undefined,
        response: '',
      });
      state!.record('session', 'Main agent started working');
    });
  });
  pi.on('message_start', (event, ctx) => {
    if (event.message.role === 'custom') {
      showCustomMessage(event.message, ctx, false);
      return;
    }
    if (event.message.role !== 'user' && event.message.role !== 'assistant')
      return;
    const message = event.message;
    const entry = newMessage(message);
    const text = messageText(message);
    const visuals = conversationVisualizations(message, undefined, cwd);
    state?.batch(() => {
      if (message.role === 'assistant') {
        assistantMessage = entry;
        lastError = undefined;
        state!.updateSession({
          activity: activity(text ? 'Responding' : 'Thinking'),
          error: undefined,
          response: text,
        });
      } else userMessage = entry;
      if (text || visuals.visualizations || visuals.visualizationErrors)
        state!.updateConversation({
          id: entry.id,
          at: entry.at,
          role: message.role,
          text,
          ...visuals,
          streaming: message.role === 'assistant',
        });
    });
  });
  pi.on('message_update', event => {
    if (event.message.role !== 'assistant') return;
    const delta = event.assistantMessageEvent;
    if (delta && delta.type !== 'text_delta') return;
    const previous = assistantMessage
      ? state?.conversationMessage(assistantMessage.id)
      : undefined;
    const text = messageText(event.message);
    const visuals = delta
      ? {
          visualizations: previous?.visualizations,
          visualizationErrors: previous?.visualizationErrors,
        }
      : conversationVisualizations(event.message, undefined, cwd);
    state?.batch(() => {
      if (
        (text || visuals.visualizations || visuals.visualizationErrors) &&
        assistantMessage
      )
        state!.updateConversation({
          id: assistantMessage.id,
          at: assistantMessage.at,
          role: 'assistant',
          text,
          ...visuals,
          streaming: true,
        });
      state!.updateSession({
        response: text,
        activity: activity(text ? 'Responding' : 'Thinking'),
      });
    });
  });
  pi.on('message_end', (event, ctx) => {
    if (event.message.role === 'custom') {
      showCustomMessage(event.message, ctx, false);
      return;
    }
    if (event.message.role === 'toolResult') {
      const message = event.message;
      state?.batch(() => {
        finishTool(
          message.toolCallId,
          message.toolName,
          message,
          message.isError,
          new Date(message.timestamp).toISOString(),
        );
        state!.updateSession({activity: activity('Working')});
      });
      return;
    }
    if (event.message.role !== 'assistant' && event.message.role !== 'user')
      return;
    const message = event.message;
    const text = messageText(message);
    const visuals = conversationVisualizations(message, undefined, cwd);
    const entry =
      (message.role === 'assistant' ? assistantMessage : userMessage) ??
      knownMessage(message, ctx) ??
      newMessage(message);
    rememberMessage(message, entry);
    const error =
      message.role === 'assistant' ? message.errorMessage : undefined;
    state?.batch(() => {
      if (
        text ||
        error ||
        visuals.visualizations ||
        visuals.visualizationErrors
      )
        state!.updateConversation({
          id: entry.id,
          at: entry.at,
          role: message.role,
          text,
          ...visuals,
          error,
          streaming: false,
        });
      if (message.role !== 'assistant') return;
      showCalls(message, entry.at, error, message.stopReason);
      const call = modelUsage(message, entry);
      if (call) state!.recordUsage(call, entry.sequence);
      lastError = message.errorMessage
        ? publicText(message.errorMessage)
        : undefined;
      if (lastError) state!.record('error', lastError);
      state!.updateSession({
        ...metadata(ctx),
        error: lastError,
        response: text,
      });
    });
    if (message.role === 'assistant') assistantMessage = undefined;
    else userMessage = undefined;
  });
  pi.on('tool_execution_start', event => {
    const previous = state?.conversationMessage(toolId(event.toolCallId));
    if (previous?.status && previous.status !== 'running') return;
    tools.set(event.toolCallId, event.toolName);
    state?.batch(() => {
      state!.updateConversation({
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
      state!.updateSession({activity: activity('Working')});
      state!.recordTool(toolId(event.toolCallId), `Using ${event.toolName}`);
    });
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
      ...conversationVisualizations(event.partialResult ?? {}, undefined, cwd),
      at: previous?.at ?? new Date().toISOString(),
      status: 'running',
      streaming: true,
    });
  });
  pi.on('tool_execution_end', event => {
    const previous = state?.conversationMessage(toolId(event.toolCallId));
    state?.batch(() => {
      // An awaited agent command is a publication boundary: its result and the
      // terminal worker state must become visible in the same update.
      if (event.toolName === 'agent_wait' && teamTimer) syncTeam();
      finishTool(
        event.toolCallId,
        event.toolName,
        event.result ?? {},
        event.isError,
      );
      state!.updateSession({activity: activity('Working')});
      if (!previous?.status || previous.status === 'running')
        state!.recordTool(
          toolId(event.toolCallId),
          `${event.toolName} ${event.isError ? 'failed' : 'finished'}`,
          event.isError,
        );
    });
  });
  pi.on('agent_settled', (_event, ctx) => {
    state?.batch(() => {
      // Do not publish an idle parent with a worker snapshot still waiting on
      // the throttle timer.
      if (teamTimer) syncTeam();
      // Streaming cache warming appends usage outside the message lifecycle.
      restoreUsage(ctx);
      tools.clear();
      state!.settleConversation();
      assistantMessage = undefined;
      userMessage = undefined;
      state!.updateSession({
        ...metadata(ctx),
        status: 'idle',
        activity: lastError
          ? `Error: ${lastError.slice(0, 1000)}`
          : 'Ready for a task',
      });
      state!.record(
        'session',
        lastError ? 'Run ended with an error' : 'Main agent finished',
      );
    });
  });
  pi.on('session_before_compact', () => {
    state?.batch(() => {
      state!.updateSession({
        status: 'compacting',
        activity: 'Compacting conversation',
      });
      state!.record('session', 'Compacting conversation');
    });
  });
  const afterCompaction = (ctx: ExtensionContext) => {
    state?.updateSession({
      ...metadata(ctx),
      status: ctx.isIdle() ? 'idle' : 'running',
      activity: ctx.isIdle() ? 'Ready for a task' : 'Working',
    });
  };
  pi.on('session_compact', (event, ctx) => {
    state?.batch(() => {
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
        if (call) state!.recordUsage(call, sequence);
      }
      if (!found) {
        const call = compactionUsage(
          event.compactionEntry,
          ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        );
        if (call) state!.recordUsage(call, sequence + 1);
      }
      afterCompaction(ctx);
    });
  });
  pi.on('session_compact_failed', (event, ctx) => {
    state?.batch(() => {
      afterCompaction(ctx);
      state!.record('error', event.errorMessage ?? 'Compaction cancelled');
    });
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
  const releaseSpeedMode = pi.events.on('varisdev:speed-mode', data => {
    const change = data as {sessionId: string; speedMode: SpeedMode};
    if (change.sessionId === sessionId)
      state?.updateSession({speedMode: change.speedMode});
  });
  pi.on('session_info_changed', (_event, ctx) => {
    state?.updateSession(metadata(ctx));
  });
  pi.on('session_tree', (_event, ctx) => restoreConversation(ctx));
  pi.on('session_shutdown', () => {
    releaseSpeedMode();
    clearTimeout(teamTimer);
    teamTimer = undefined;
    syncTeam();
    unsubscribe?.();
    unsubscribe = undefined;
    tools.clear();
    state?.batch(() => {
      archiveTeam();
      state!.settleConversation();
      state!.updateSession({status: 'closed', activity: 'Session closed'});
      state!.record('session', 'Session closed');
    });
    state = undefined;
    messageIdentities = new WeakMap();
    assistantMessage = undefined;
    userMessage = undefined;
    sessionId = undefined;
    seenChanges.clear();
  });
  return Object.assign(showCustomMessage, {
    restore: restoreConversation,
    restoreUsage,
  });
}
