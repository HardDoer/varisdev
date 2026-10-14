import type {
  AgentSessionEvent,
  SessionEntry,
} from '@earendil-works/pi-coding-agent';
import {
  ConversationState,
  messageText,
  publicText,
  resultStatus,
  toolInput,
  type ConversationSnapshot,
} from '../conversation.ts';

type Identity = {id: string; at: string};
const toolId = (id: string) => `tool-${id}`;

/** Projects SDK messages and tool events without exposing private thinking or details. */
export class WorkerConversation {
  private readonly state = new ConversationState();
  private sequence = 0;
  private customSequence = 0;
  private errorSequence = 0;
  private readonly identities = new WeakMap<object, Identity>();
  private assistant?: Identity;
  private user?: Identity;
  private latestAssistant?: Identity;

  constructor(branch: readonly SessionEntry[]) {
    for (const entry of branch) {
      if (entry.type === 'custom_message') {
        const id = `custom-${++this.customSequence}`;
        const text = messageText(entry);
        if (entry.display && text)
          this.state.update({
            id,
            at: entry.timestamp,
            role: 'assistant',
            text,
          });
        continue;
      }
      if (entry.type !== 'message') continue;
      const message = entry.message;
      const at = new Date(message.timestamp).toISOString();
      if (message.role === 'user' || message.role === 'assistant') {
        const identity = this.identity(message);
        const text = messageText(message);
        const error =
          message.role === 'assistant' ? message.errorMessage : undefined;
        if (text || error)
          this.state.update({
            ...identity,
            role: message.role,
            text,
            error: error ? publicText(error) : undefined,
            streaming: false,
          });
        if (message.role === 'assistant') {
          this.showCalls(message, identity.at);
        }
      } else if (message.role === 'toolResult') {
        this.finishTool(
          message.toolCallId,
          message.toolName,
          message,
          message.isError,
          at,
        );
      } else if (message.role === 'custom') {
        const identity = this.customIdentity(message);
        const text = messageText(message);
        if (message.display && text)
          this.state.update({
            ...identity,
            at,
            role: 'assistant',
            text,
          });
      }
    }
    // Historical calls with no result were interrupted before completion.
    this.state.settle();
  }

  private identity(message: {role: string; timestamp: number}): Identity {
    let identity = this.identities.get(message);
    if (!identity) {
      identity = {
        id: `message-${message.role}-${message.timestamp}-${++this.sequence}`,
        at: new Date(message.timestamp).toISOString(),
      };
      this.identities.set(message, identity);
    }
    return identity;
  }

  private customIdentity(message: {timestamp: number}): Identity {
    let identity = this.identities.get(message);
    if (!identity) {
      identity = {
        id: `custom-${++this.customSequence}`,
        at: new Date(message.timestamp).toISOString(),
      };
      this.identities.set(message, identity);
    }
    return identity;
  }

  begin(): void {
    this.latestAssistant = undefined;
  }

  private showCalls(
    message: {content: unknown; stopReason?: string; errorMessage?: string},
    at: string,
  ): void {
    if (!Array.isArray(message.content)) return;
    for (const part of message.content) {
      if (part?.type !== 'toolCall' || typeof part.id !== 'string') continue;
      const previous = this.state.get(toolId(part.id));
      if (previous?.status && previous.status !== 'running') continue;
      const failed =
        message.stopReason === 'error' || message.stopReason === 'aborted';
      this.state.update({
        ...previous,
        id: toolId(part.id),
        role: 'tool',
        toolCallId: part.id,
        toolName: part.name,
        input: toolInput(part.arguments),
        text: previous?.text ?? '',
        at: previous?.at ?? at,
        status: failed
          ? message.stopReason === 'aborted'
            ? 'cancelled'
            : 'failed'
          : 'running',
        error:
          failed && message.errorMessage
            ? publicText(message.errorMessage)
            : undefined,
        streaming: !failed,
        finishedAt: failed ? new Date().toISOString() : undefined,
      });
    }
  }

  private finishTool(
    toolCallId: string,
    toolName: string,
    result: {content?: unknown},
    isError: boolean,
    at = new Date().toISOString(),
  ): void {
    const previous = this.state.get(toolId(toolCallId));
    const text = messageText(result);
    this.state.update({
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
  }

  /** Returns true for public conversation events, including empty thinking activity. */
  record(event: AgentSessionEvent): boolean {
    if (
      event.type === 'message_start' ||
      event.type === 'message_update' ||
      event.type === 'message_end'
    ) {
      const message = event.message;
      if (message.role === 'user' || message.role === 'assistant') {
        const role = message.role;
        const started = event.type === 'message_start';
        const ended = event.type === 'message_end';
        const identity =
          this.identities.get(message) ??
          (started
            ? undefined
            : role === 'assistant'
              ? this.assistant
              : this.user) ??
          this.identity(message);
        this.identities.set(message, identity);
        if (role === 'assistant') {
          this.assistant = ended ? undefined : identity;
          this.latestAssistant = identity;
        } else this.user = ended ? undefined : identity;
        const text = messageText(message);
        const error = role === 'assistant' ? message.errorMessage : undefined;
        if (text || error)
          this.state.update({
            ...identity,
            role,
            text,
            error: error ? publicText(error) : undefined,
            streaming: role === 'assistant' && !ended,
          });
        if (role === 'assistant' && ended) this.showCalls(message, identity.at);
        return true;
      }
      if (message.role === 'toolResult' && event.type === 'message_end') {
        this.finishTool(
          message.toolCallId,
          message.toolName,
          message,
          message.isError,
          new Date(message.timestamp).toISOString(),
        );
        return true;
      }
      if (message.role === 'custom') {
        const identity = this.customIdentity(message);
        const text = messageText(message);
        if (message.display && text)
          this.state.update({
            ...identity,
            role: 'assistant',
            text,
          });
        return true;
      }
    } else if (
      event.type === 'tool_execution_start' ||
      event.type === 'tool_execution_update'
    ) {
      const previous = this.state.get(toolId(event.toolCallId));
      if (previous?.status && previous.status !== 'running') return false;
      this.state.update({
        ...previous,
        id: toolId(event.toolCallId),
        role: 'tool',
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        input: previous?.input ?? toolInput(event.args),
        text:
          event.type === 'tool_execution_update'
            ? messageText(event.partialResult ?? {})
            : (previous?.text ?? ''),
        at: previous?.at ?? new Date().toISOString(),
        status: 'running',
        streaming: true,
      });
      return true;
    } else if (event.type === 'tool_execution_end') {
      this.finishTool(
        event.toolCallId,
        event.toolName,
        event.result ?? {},
        event.isError,
      );
      return true;
    }
    return false;
  }

  settle(cancelled: boolean, error?: string): void {
    this.assistant = undefined;
    this.user = undefined;
    this.state.settle(error && !cancelled ? 'failed' : 'cancelled', error);
    if (error && !cancelled) {
      const previous = this.latestAssistant
        ? this.state.get(this.latestAssistant.id)
        : undefined;
      if (!previous?.error) {
        this.state.update({
          ...previous,
          id: previous?.id ?? `error-${++this.errorSequence}`,
          at: previous?.at ?? new Date().toISOString(),
          role: 'assistant',
          text: previous?.text ?? '',
          error: publicText(error),
          streaming: false,
        });
      }
    }
  }

  snapshot(): ConversationSnapshot {
    return this.state.snapshot();
  }
}
