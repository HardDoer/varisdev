import {randomUUID} from 'node:crypto';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  AgentOrchestrator,
  isAgentFinished,
  type AgentRecord,
} from './orchestrator.ts';

import type {UnitChange} from '../dashboard/changes.ts';
import type {ConversationSnapshot} from '../conversation.ts';
import {subscribeToolSettings} from '../tools/settings.ts';

export interface AgentMessage {
  from: {id: string; name: string};
  message: string;
}

export interface ParentMessage extends AgentMessage {
  id: string;
  createdAt: string;
}

export interface AgentSessionSnapshot {
  sessionId: string;
  agents: (AgentRecord & ConversationSnapshot)[];
  messages: ParentMessage[];
  changes: UnitChange[];
}

/** Retain history after its worker has been released. */
export function archiveAgentRecord<
  T extends AgentRecord & Partial<ConversationSnapshot>,
>(agent: T): T {
  const finishedAt = agent.finishedAt ?? new Date().toISOString();
  return {
    ...agent,
    resumable: false,
    ...(!isAgentFinished(agent.status)
      ? {status: 'cancelled', activity: 'Cancelled', finishedAt}
      : {}),
    ...(agent.conversation
      ? {
          conversation: agent.conversation.map(message => ({
            ...message,
            ...(message.streaming ? {streaming: false} : {}),
            ...(message.role === 'tool' && message.status === 'running'
              ? {status: 'cancelled', finishedAt}
              : {}),
          })),
        }
      : {}),
  };
}

const maxParentMessages = 100;

function copyMessage(message: ParentMessage): ParentMessage {
  return {...message, from: {...message.from}};
}

/** Owns workers and their inbox for one parent session. */
class AgentTeam {
  private readonly manager = new AgentOrchestrator();
  private readonly messages: ParentMessage[] = [];
  private messageSequence = 0;
  private readonly changes: UnitChange[] = [];
  private context: ExtensionContext;
  private closed = false;
  private cachedSnapshot?: AgentSessionSnapshot;
  readonly sessionId: string;
  private readonly unsubscribe: () => void;
  private readonly publish: () => void;

  constructor(ctx: ExtensionContext, changed: () => void) {
    this.context = ctx;
    this.publish = changed;
    this.sessionId = ctx.sessionManager.getSessionId();
    const stopObservingAgents = this.manager.subscribe(() => {
      this.updateStatus();
      this.changed();
    });
    const stopObservingSettings = subscribeToolSettings(settings => {
      this.manager.setMaxConcurrentAgents(settings.agents.maxConcurrentAgents);
    });
    this.unsubscribe = () => {
      stopObservingAgents();
      stopObservingSettings();
    };
    this.updateStatus();
  }

  private changed(): void {
    this.cachedSnapshot = undefined;
    this.publish();
  }

  getManager(): AgentOrchestrator {
    if (this.closed) throw new Error('This agent session has closed.');
    return this.manager;
  }

  updateContext(ctx: ExtensionContext): void {
    this.getManager();
    if (this.sessionId !== ctx.sessionManager.getSessionId()) {
      throw new Error('This workspace has closed.');
    }
    this.context = ctx;
  }

  private setStatus(status?: string): void {
    try {
      if (this.context.hasUI) {
        this.context.ui.setStatus('varisdev-agents', status);
      }
    } catch (error) {
      console.error('Agent status update failed:', error);
    }
  }

  private updateStatus(): void {
    if (this.closed) return;
    const active = this.manager
      .list()
      .filter(record => !isAgentFinished(record.status));
    this.setStatus(
      active.length > 0
        ? `Agents: ${active.filter(record => record.status === 'running').length} running, ${active.filter(record => record.status === 'queued').length} queued, ${active.filter(record => record.status === 'cancelling').length} cancelling`
        : undefined,
    );
  }

  storeMessage(message: AgentMessage): ParentMessage {
    this.getManager();
    if (!message.message.trim())
      throw new Error('Agent message cannot be empty.');
    if (message.message.length > 64000)
      throw new Error('Agent message cannot exceed 64000 characters.');
    const stored = {
      ...message,
      from: {...message.from},
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.messageSequence++;
    this.messages.push(stored);
    if (this.messages.length > maxParentMessages) this.messages.shift();
    this.changed();
    return copyMessage(stored);
  }

  getMessage(id: string): ParentMessage {
    this.getManager();
    const message = this.messages.find(message => message.id === id);
    if (!message) throw new Error(`Unknown main agent inbox message: ${id}`);
    return copyMessage(message);
  }

  listMessages(
    options: {offset?: number; limit?: number; after?: number} = {},
  ) {
    this.getManager();
    const {offset = 0, limit = 10, after} = options;
    if (after !== undefined && Object.hasOwn(options, 'offset')) {
      throw new Error('Message cursor cannot be combined with offset.');
    }
    if (
      after !== undefined &&
      (!Number.isSafeInteger(after) ||
        after < 0 ||
        after > this.messageSequence)
    ) {
      throw new Error(
        `Message cursor must be a safe integer from 0 to ${this.messageSequence} in this workspace.`,
      );
    }
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 20
    )
      throw new Error(
        'Message offset must be non-negative and limit must be 1 to 20.',
      );
    if (after !== undefined) {
      const retainedAfter = this.messageSequence - this.messages.length;
      const start = Math.max(0, after - retainedAfter);
      const messages = this.messages.slice(start, start + limit);
      const missed = Math.max(0, retainedAfter - after);
      return {
        messages: messages.map(copyMessage),
        nextAfter: messages.length
          ? retainedAfter + start + messages.length
          : after,
        hasMore: start + messages.length < this.messages.length,
        ...(missed ? {missed} : {}),
      };
    }
    const total = this.messages.length;
    const messages = this.messages.toReversed().slice(offset, offset + limit);
    return {
      total,
      offset,
      nextOffset:
        offset + messages.length < total ? offset + messages.length : undefined,
      messages: messages.map(copyMessage),
    };
  }

  storeChange(change: UnitChange): void {
    if (this.closed) return;
    this.changes.push({...change});
    if (this.changes.length > 100) this.changes.shift();
    this.changed();
  }

  /** A cached snapshot for observers. Callers must not mutate it. */
  deliverySnapshot(): AgentSessionSnapshot {
    return (this.cachedSnapshot ??= {
      sessionId: this.sessionId,
      agents: this.manager.list().map(agent => ({
        ...agent,
        ...this.manager.conversation(agent.id),
      })),
      messages: this.messages.map(copyMessage),
      changes: this.changes.map(change => ({...change})),
    });
  }

  snapshot(): AgentSessionSnapshot {
    return structuredClone(this.deliverySnapshot());
  }

  close(): Promise<void> {
    if (this.closed) return this.manager.close();
    const snapshot = this.deliverySnapshot();
    this.cachedSnapshot = {
      ...snapshot,
      agents: snapshot.agents.map(archiveAgentRecord),
    };
    this.closed = true;
    this.unsubscribe();
    this.messages.length = 0;
    this.changes.length = 0;
    this.setStatus();
    return this.manager.close();
  }
}

/** One controller per parent extension registration. */
export class AgentSessionController {
  private team?: AgentTeam;
  private finalSnapshot?: AgentSessionSnapshot;
  private shuttingDown = false;
  private readonly listeners = new Set<() => void>();

  constructor(pi: ExtensionAPI) {
    pi.on('session_start', () => {
      this.shuttingDown = false;
      this.finalSnapshot = undefined;
    });
    pi.on('agent_start', (_event, ctx) => {
      if (this.shuttingDown) return;
      this.attach(ctx);
    });
    pi.on('session_shutdown', async () => {
      this.shuttingDown = true;
      const team = this.team;
      this.team = undefined;
      const closing = team?.close();
      this.finalSnapshot = team?.deliverySnapshot();
      this.changed();
      await closing;
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Reading state never creates a team. Messages are in arrival order. */
  snapshot(): AgentSessionSnapshot | undefined {
    const snapshot = this.team?.deliverySnapshot();
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  /** A cached snapshot for state delivery. Callers must not mutate it. */
  deliverySnapshot(): AgentSessionSnapshot | undefined {
    return this.team?.deliverySnapshot() ?? this.finalSnapshot;
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error('Agent observer failed:', error);
      }
    }
  }

  attach(ctx: ExtensionContext): void {
    if (this.shuttingDown) throw new Error('The workspace is shutting down.');
    if (this.team) this.team.updateContext(ctx);
    else {
      this.team = new AgentTeam(ctx, () => this.changed());
      this.changed();
    }
  }

  getTeam(ctx: ExtensionContext): AgentTeam {
    this.attach(ctx);
    return this.team!;
  }
}
