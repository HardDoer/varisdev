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
  agents: AgentRecord[];
  messages: ParentMessage[];
  changes: UnitChange[];
}

const maxParentMessages = 100;

function copyMessage(message: ParentMessage): ParentMessage {
  return {...message, from: {...message.from}};
}

/** Owns workers and their inbox for one parent session. */
class AgentTeam {
  private readonly manager = new AgentOrchestrator();
  private readonly messages: ParentMessage[] = [];
  private readonly changes: UnitChange[] = [];
  private context: ExtensionContext;
  private closed = false;
  readonly sessionId: string;
  private readonly unsubscribe: () => void;
  private readonly changed: () => void;

  constructor(ctx: ExtensionContext, changed: () => void) {
    this.context = ctx;
    this.changed = changed;
    this.sessionId = ctx.sessionManager.getSessionId();
    this.unsubscribe = this.manager.subscribe(() => {
      this.updateStatus();
      this.changed();
    });
    this.updateStatus();
  }

  getManager(): AgentOrchestrator {
    if (this.closed) throw new Error('This agent session has closed.');
    return this.manager;
  }

  updateContext(ctx: ExtensionContext): void {
    this.getManager();
    if (this.sessionId !== ctx.sessionManager.getSessionId()) {
      throw new Error('This parent session has closed.');
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
    this.messages.push(stored);
    if (this.messages.length > maxParentMessages) this.messages.shift();
    this.changed();
    return copyMessage(stored);
  }

  getMessage(id: string): ParentMessage {
    this.getManager();
    const message = this.messages.find(message => message.id === id);
    if (!message) throw new Error(`Unknown parent inbox message: ${id}`);
    return copyMessage(message);
  }

  listMessages(options: {offset?: number; limit?: number} = {}) {
    this.getManager();
    const {offset = 0, limit = 10} = options;
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

  snapshot(): AgentSessionSnapshot {
    return {
      sessionId: this.sessionId,
      agents: this.manager.list(),
      messages: this.messages.map(copyMessage),
      changes: this.changes.map(change => ({...change})),
    };
  }

  close(): Promise<void> {
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
  private shuttingDown = false;
  private readonly listeners = new Set<() => void>();

  constructor(pi: ExtensionAPI) {
    pi.on('session_start', () => {
      this.shuttingDown = false;
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
    return this.team?.snapshot();
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
    if (this.shuttingDown)
      throw new Error('The parent session is shutting down.');
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
