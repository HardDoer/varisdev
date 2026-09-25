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
  /** Resume buffered notifications if the destination already owns the team. */
  resume(): boolean;
  close(): Promise<void>;
}

interface ParentBinding {
  pi: ExtensionAPI;
  context: ExtensionContext;
  sessionId: string;
}

interface ParentMessage {
  customType: string;
  content: string;
  display: boolean;
  details: unknown;
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
  private readonly notified = new Set<string>();
  private readonly messages: ParentMessage[] = [];
  private parent?: ParentBinding;
  private handover?: TeamHandover;
  private paused = false;
  private deliveryPending = false;
  private interrupted = false;
  private runSignal?: AbortSignal;
  private closed = false;
  sessionId: string;

  constructor(parent: ParentBinding) {
    this.sessionId = parent.sessionId;
    this.bind(parent, false);
    this.manager.subscribe(() => this.changed());
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

  bind(parent: ParentBinding, paused: boolean): void {
    this.getManager();
    this.detach();
    this.parent = parent;
    this.sessionId = parent.sessionId;
    this.paused = paused;
    this.updateStatus();
  }

  activate(parent: ParentBinding): void {
    if (!this.owns(parent) || this.handover) return;
    this.paused = false;
    this.flush();
  }

  started(parent: ParentBinding): void {
    if (!this.owns(parent)) return;
    this.deliveryPending = false;
    this.interrupted = false;
    this.runSignal = parent.context.signal;
    this.activate(parent);
  }

  settled(parent: ParentBinding): void {
    if (!this.owns(parent)) return;
    this.deliveryPending = false;
    // The host clears ctx.signal before settlement. Retain the run's signal
    // so Esc leaves the parent stopped until the user starts another run.
    this.interrupted = this.runSignal?.aborted ?? false;
    this.flush();
  }

  sendMessage(message: ParentMessage): void {
    this.getManager();
    this.messages.push(message);
    this.flush();
  }

  private flush(): void {
    if (
      !this.closed &&
      !this.paused &&
      !this.deliveryPending &&
      !this.interrupted &&
      this.parent &&
      this.messages.length &&
      // Keep notifications in the team until the parent settles. A host
      // follow-up queued during work would restart the source after its
      // handover acknowledgement, before the waiting switch can run.
      this.parent.context.isIdle()
    ) {
      const message = this.messages.shift()!;
      // Pi defers prompts sent during agent_settled, leaving isIdle true
      // until the handlers return. Reserve one delivery until the next run.
      this.deliveryPending = true;
      try {
        this.parent.pi.sendMessage(message, {
          deliverAs: 'followUp',
          triggerTurn: true,
        });
      } catch (error) {
        this.deliveryPending = false;
        // Notification failures must not interrupt workers or their cleanup.
        console.error('Agent notification failed:', error);
      }
    }
  }

  private changed(): void {
    if (this.closed) return;
    this.updateStatus();
    for (const record of this.manager.list()) {
      if (!isAgentFinished(record.status)) {
        this.notified.delete(record.id);
        continue;
      }
      if (this.notified.has(record.id)) continue;
      this.notified.add(record.id);
      if (record.notify) {
        this.sendMessage({
          customType: 'agent_result',
          content: `Agent ${JSON.stringify(record.name)} (${record.id}) ${record.status}.\n${record.error ?? record.output?.slice(0, 2000) ?? ''}\nUse agent_status for the result and transcript paths.`,
          display: true,
          details: {agent: record},
        });
      }
    }
  }

  prepare(parent: ParentBinding, restore: () => void): AgentHandover {
    if (!this.owns(parent)) throw new Error('This parent session has closed.');
    if (this.handover) throw new Error('An agent handover is already pending.');
    this.paused = true;
    this.handover = new TeamHandover(this, parent, restore);
    return this.handover;
  }

  finishHandover(
    handover: TeamHandover,
    parent: ParentBinding,
    paused: boolean,
  ): void {
    if (this.closed || this.handover !== handover) {
      throw new Error('This agent handover has closed.');
    }
    this.handover = undefined;
    this.bind(parent, paused);
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
    this.team.finishHandover(this, parent, true);
    this.removeTransfer();
    this.state = 'attached';
    this.attachedParent = parent;
    return this.team;
  }

  cancel(): void {
    if (this.team.isClosed) return;
    if (this.state !== 'prepared' && this.state !== 'pending') return;
    this.removeTransfer();
    this.team.finishHandover(this, this.origin, false);
    this.state = 'cancelled';
    this.restore();
    this.team.activate(this.origin);
  }

  resume(): boolean {
    if (!this.attachedParent || !this.team.owns(this.attachedParent)) {
      return false;
    }
    this.team.activate(this.attachedParent);
    return true;
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
  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    pi.on('session_start', () => {
      this.shuttingDown = false;
    });
    pi.on('agent_start', (_event, ctx) => {
      if (this.shuttingDown) return;
      this.attach(ctx);
      this.team!.started(this.parent!);
    });
    pi.on('agent_settled', () => {
      if (!this.shuttingDown && this.team && this.parent)
        this.team.settled(this.parent);
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
    const parent = {pi: this.pi, context: ctx, sessionId};
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
