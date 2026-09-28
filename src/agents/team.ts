import {randomUUID} from 'node:crypto';
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
} from '@earendil-works/pi-coding-agent';
import {AgentOrchestrator, isAgentFinished} from './orchestrator.ts';

export interface AgentSessionControl {
  attach(ctx: ExtensionContext): void;
  prepareHandover(ctx: ExtensionContext): AgentHandover;
}

export interface AgentHandover {
  transfer(sessionId: string): void;
  cancel(): void;
  /** Check whether the destination still owns the team during recovery. */
  hasDestination(): boolean;
  close(): Promise<void>;
}

interface ParentBinding {
  context: ExtensionContext;
  sessionId: string;
}

export interface AgentMessage {
  from: {id: string; name: string};
  message: string;
}

export interface ParentMessage extends AgentMessage {
  id: string;
  createdAt: string;
}

const maxParentMessages = 100;

function copyMessage(message: ParentMessage): ParentMessage {
  return {...message, from: {...message.from}};
}

// Fresh extension runtimes may reload this module. Only unclaimed transfers
// live here; attached teams are owned by their current extension runtime.
const transfersKey = Symbol.for('varisdev.agents.pendingTransfers');
const shared = globalThis as typeof globalThis & {
  [transfersKey]?: Map<string, TeamHandover>;
};
const pendingTransfers = (shared[transfersKey] ??= new Map());

/** Owns workers independently of the extension runtime displaying them. */
class AgentTeam {
  private readonly manager = new AgentOrchestrator();
  private readonly messages: ParentMessage[] = [];
  private parent?: ParentBinding;
  private handover?: TeamHandover;
  private closed = false;
  sessionId: string;

  constructor(parent: ParentBinding) {
    this.sessionId = parent.sessionId;
    this.bind(parent);
    this.manager.subscribe(() => this.updateStatus());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  getManager(): AgentOrchestrator {
    if (this.closed) throw new Error('This agent session has closed.');
    return this.manager;
  }

  owns(parent: ParentBinding): boolean {
    return !this.closed && this.parent === parent;
  }

  private setStatus(parent: ParentBinding, status?: string): void {
    try {
      if (parent.context.hasUI) {
        parent.context.ui.setStatus('varisdev-agents', status);
      }
    } catch (error) {
      console.error('Agent status update failed:', error);
    }
  }

  private updateStatus(): void {
    if (!this.parent || this.closed) return;
    const active = this.manager
      .list()
      .filter(record => !isAgentFinished(record.status));
    this.setStatus(
      this.parent,
      active.length > 0
        ? `Agents: ${active.filter(record => record.status === 'running').length} running, ${active.filter(record => record.status === 'queued').length} queued, ${active.filter(record => record.status === 'cancelling').length} cancelling`
        : undefined,
    );
  }

  private detach(): void {
    if (this.parent) this.setStatus(this.parent);
    this.parent = undefined;
  }

  bind(parent: ParentBinding): void {
    this.getManager();
    this.detach();
    this.parent = parent;
    this.sessionId = parent.sessionId;
    this.updateStatus();
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

  prepare(parent: ParentBinding, restore: () => void): AgentHandover {
    if (!this.owns(parent)) throw new Error('This parent session has closed.');
    if (this.handover) throw new Error('An agent handover is already pending.');
    this.handover = new TeamHandover(this, parent, restore);
    return this.handover;
  }

  finishHandover(handover: TeamHandover, parent: ParentBinding): void {
    if (this.closed || this.handover !== handover) {
      throw new Error('This agent handover has closed.');
    }
    this.handover = undefined;
    this.bind(parent);
  }

  shutdown(
    parent: ParentBinding,
    reason: SessionShutdownEvent['reason'],
  ): Promise<void> {
    if (!this.owns(parent)) return Promise.resolve();
    this.detach();
    if (reason === 'new' && this.handover) return Promise.resolve();
    return this.close();
  }

  close(): Promise<void> {
    this.closed = true;
    this.handover?.removeTransfer();
    this.handover = undefined;
    this.messages.length = 0;
    this.detach();
    return this.manager.close();
  }
}

class TeamHandover implements AgentHandover {
  private destination?: string;
  private attachedParent?: ParentBinding;
  private state: 'prepared' | 'pending' | 'attached' | 'cancelled' | 'closed' =
    'prepared';

  private readonly team: AgentTeam;
  private readonly origin: ParentBinding;
  private readonly restore: () => void;

  constructor(team: AgentTeam, origin: ParentBinding, restore: () => void) {
    this.team = team;
    this.origin = origin;
    this.restore = restore;
  }

  transfer(sessionId: string): void {
    this.team.getManager();
    if (this.state !== 'prepared') {
      throw new Error(
        'This agent handover is no longer awaiting a destination.',
      );
    }
    if (!sessionId || sessionId === this.origin.sessionId) {
      throw new Error('An agent handover needs a fresh session ID.');
    }
    if (pendingTransfers.has(sessionId)) {
      throw new Error('This session already has a pending agent handover.');
    }
    this.destination = sessionId;
    this.state = 'pending';
    this.team.sessionId = sessionId;
    pendingTransfers.set(sessionId, this);
  }

  removeTransfer(): void {
    if (this.destination && pendingTransfers.get(this.destination) === this) {
      pendingTransfers.delete(this.destination);
    }
  }

  attach(parent: ParentBinding): AgentTeam {
    if (this.state !== 'pending' || parent.sessionId !== this.destination) {
      throw new Error('This agent handover belongs to another session.');
    }
    this.team.finishHandover(this, parent);
    this.removeTransfer();
    this.state = 'attached';
    this.attachedParent = parent;
    return this.team;
  }

  cancel(): void {
    if (this.team.isClosed) return;
    if (this.state !== 'prepared' && this.state !== 'pending') return;
    this.removeTransfer();
    this.team.finishHandover(this, this.origin);
    this.state = 'cancelled';
    this.restore();
  }

  hasDestination(): boolean {
    return (
      this.attachedParent !== undefined && this.team.owns(this.attachedParent)
    );
  }

  close(): Promise<void> {
    if (this.state === 'cancelled') return Promise.resolve();
    this.removeTransfer();
    this.state = 'closed';
    return this.team.close();
  }
}

/** One controller per parent extension registration; workers retain the team. */
export class AgentSessionController implements AgentSessionControl {
  private team?: AgentTeam;
  private parent?: ParentBinding;
  private shuttingDown = false;
  constructor(pi: ExtensionAPI) {
    pi.on('session_start', () => {
      this.shuttingDown = false;
    });
    pi.on('agent_start', (_event, ctx) => {
      if (this.shuttingDown) return;
      this.attach(ctx);
    });
    pi.on('session_shutdown', async event => {
      this.shuttingDown = true;
      const team = this.team;
      const parent = this.parent;
      this.team = undefined;
      this.parent = undefined;
      if (team && parent) await team.shutdown(parent, event.reason);
    });
  }

  attach(ctx: ExtensionContext): void {
    if (this.shuttingDown)
      throw new Error('The parent session is shutting down.');
    const sessionId = ctx.sessionManager.getSessionId();
    if (this.team?.isClosed) {
      this.team = undefined;
      this.parent = undefined;
    }
    if (this.team && this.parent) {
      if (this.parent.sessionId !== sessionId || !this.team.owns(this.parent)) {
        throw new Error('This parent session has closed.');
      }
      this.parent.context = ctx;
      return;
    }
    const parent = {context: ctx, sessionId};
    const transfer = pendingTransfers.get(sessionId);
    this.team = transfer ? transfer.attach(parent) : new AgentTeam(parent);
    this.parent = parent;
  }

  getTeam(ctx: ExtensionContext): AgentTeam {
    this.attach(ctx);
    return this.team!;
  }

  prepareHandover(ctx: ExtensionContext): AgentHandover {
    const team = this.getTeam(ctx);
    const parent = this.parent!;
    return team.prepare(parent, () => {
      this.shuttingDown = false;
      this.team = team;
      this.parent = parent;
    });
  }
}
