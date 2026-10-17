import {isDeepStrictEqual} from 'node:util';
import {
  ConversationState,
  type ConversationMessage,
  type ConversationSnapshot,
} from '../conversation.ts';
import type {AgentRecord} from '../agents/orchestrator.ts';
import {isAgentFinished} from '../agents/orchestrator.ts';
import type {ParentMessage} from '../agents/team.ts';
import type {UnitChange} from './changes.ts';
import {
  copyModelUsage,
  ModelUsageTracker,
  type ModelUsage,
  type ModelUsageCall,
} from '../usage.ts';

export interface DashboardSession {
  id: string;
  name: string;
  cwd: string;
  model?: string;
  thinkingLevel?: string;
  sessionFile?: string;
  status: 'idle' | 'running' | 'compacting' | 'closed';
  activity: string;
  startedAt: string;
  updatedAt: string;
  prompt?: string;
  response?: string;
  error?: string;
  context?: {tokens: number | null; window: number; percent: number | null};
}

export interface DashboardEvent {
  id: string;
  at: string;
  sourceId: string;
  sourceName: string;
  kind: 'session' | 'agent' | 'tool' | 'message' | 'error';
  message: string;
  details: Record<string, string>;
  conversationId?: string;
}

interface EventContext {
  fields?: Record<string, string | undefined>;
  conversationId?: string;
}

export interface DashboardAgent extends AgentRecord, ConversationSnapshot {
  taskTruncated: boolean;
  outputTruncated: boolean;
}

export type {ConversationMessage} from '../conversation.ts';

export interface DashboardSnapshot {
  session: DashboardSession;
  agents: DashboardAgent[];
  totalAgents: number;
  events: DashboardEvent[];
  changes: UnitChange[];
  conversation: ConversationMessage[];
  conversationTruncated: boolean;
  queue?: {steering: string[]; followUp: string[]};
  usage: ModelUsage;
}

const textLimit = 16000;
const eventLimit = 160;
const historyLimit = 100;

function preview(text: string, limit = textLimit): string {
  return text.length > limit
    ? `${text.slice(0, limit)}\n[Preview truncated]`
    : text;
}

function projectAgent(
  agent: AgentRecord & Partial<ConversationSnapshot>,
  conversationIsBounded = false,
): DashboardAgent {
  let conversation: ConversationSnapshot;
  if (conversationIsBounded && agent.conversation) {
    conversation = {
      conversation: agent.conversation.map(message => ({...message})),
      conversationTruncated: !!agent.conversationTruncated,
    };
  } else {
    const bounded = new ConversationState();
    bounded.replace(
      agent.conversation ?? [
        {
          id: `task-${agent.id}`,
          role: 'user',
          text: agent.task,
          at: agent.createdAt,
        },
      ],
      agent.conversationTruncated,
    );
    conversation = bounded.snapshot();
  }
  return {
    ...agent,
    ...conversation,
    usage: agent.usage ? copyModelUsage(agent.usage) : undefined,
    task: preview(agent.task),
    activity: preview(agent.activity, 2000),
    output: agent.output === undefined ? undefined : preview(agent.output),
    error: agent.error === undefined ? undefined : preview(agent.error, 4000),
    taskTruncated: agent.task.length > textLimit,
    outputTruncated:
      Boolean(agent.outputTruncated) ||
      (agent.output?.length ?? 0) > textLimit ||
      !!agent.output?.includes('[Output truncated. Read resultFile'),
  };
}

/** A bounded view of the live session and public conversation text. */
export class DashboardState {
  private session: DashboardSession;
  private agents: DashboardAgent[] = [];
  private totalAgents = 0;
  private readonly events: DashboardEvent[] = [];
  private readonly changes: UnitChange[] = [];
  private readonly conversation = new ConversationState();
  private queue: DashboardSnapshot['queue'];
  private readonly usage = new ModelUsageTracker();
  private previousAgents = new Map<string, DashboardAgent>();
  private seenMessages = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private cachedSnapshot?: DashboardSnapshot;
  private batchDepth = 0;
  private notificationPending = false;
  private sequence = 0;

  constructor(session: DashboardSession) {
    this.session = {
      ...session,
      context: session.context ? {...session.context} : undefined,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Apply related mutations while publishing a single synchronous change. */
  batch<T>(update: () => T): T {
    this.batchDepth++;
    try {
      return update();
    } finally {
      this.batchDepth--;
      if (!this.batchDepth && this.notificationPending) {
        this.notificationPending = false;
        this.notify();
      }
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private changed(): void {
    this.cachedSnapshot = undefined;
    this.session.updatedAt = new Date().toISOString();
    if (this.batchDepth) this.notificationPending = true;
    else this.notify();
  }

  /** Invalidate delivery state changed by a separately owned backend view. */
  touch(): void {
    this.changed();
  }

  private append(
    kind: DashboardEvent['kind'],
    message: string,
    sourceId = 'parent',
    sourceName = 'Parent session',
    context: EventContext = {},
  ): void {
    const details: Record<string, string> = {};
    let remaining = 32000;
    for (const [label, value] of Object.entries({
      Message: message,
      Project: this.session.cwd,
      Model: this.session.model,
      Status: this.session.status,
      ...context.fields,
    })) {
      if (!value || remaining <= 0) continue;
      const content = preview(value, Math.min(textLimit, remaining));
      details[label] = content;
      remaining -= content.length;
    }
    this.events.push({
      id: String(++this.sequence),
      at: new Date().toISOString(),
      sourceId,
      sourceName,
      kind,
      message: preview(message, 1000),
      details,
      conversationId: context.conversationId,
    });
    if (this.events.length > eventLimit) this.events.shift();
  }

  record(
    kind: DashboardEvent['kind'],
    message: string,
    sourceId?: string,
    sourceName?: string,
    context?: EventContext,
  ): void {
    this.append(kind, message, sourceId, sourceName, context);
    this.changed();
  }

  recordTool(id: string, message: string, isError = false): void {
    const tool = this.conversationMessage(id);
    this.record(isError ? 'error' : 'tool', message, undefined, undefined, {
      conversationId: id,
      fields: {
        Tool: tool?.toolName,
        Status: tool?.status,
        Input: tool?.input,
        Output: tool?.text,
        Error: tool?.error,
      },
    });
  }

  updateSession(patch: Partial<DashboardSession>): void {
    const next = {
      ...this.session,
      ...patch,
      ...(patch.context ? {context: {...patch.context}} : {}),
      ...(patch.error !== undefined ? {error: preview(patch.error, 4000)} : {}),
      ...(patch.prompt !== undefined ? {prompt: preview(patch.prompt)} : {}),
      ...(patch.response !== undefined
        ? {response: preview(patch.response)}
        : {}),
    };
    if (isDeepStrictEqual(this.session, next)) return;
    this.session = next;
    this.changed();
  }

  updateTeam(
    records: (AgentRecord & Partial<ConversationSnapshot>)[],
    messages: ParentMessage[],
    conversationsAreBounded = false,
  ): void {
    const nextTotalAgents = records.length;
    const active = records.filter(agent => !isAgentFinished(agent.status));
    const history = records
      .filter(agent => isAgentFinished(agent.status))
      .sort((a, b) =>
        (b.finishedAt ?? b.createdAt).localeCompare(
          a.finishedAt ?? a.createdAt,
        ),
      )
      .slice(0, historyLimit);
    const nextAgents = [...active, ...history].map(agent =>
      projectAgent(agent, conversationsAreBounded),
    );
    this.totalAgents = nextTotalAgents;
    this.agents = nextAgents;
    for (const agent of nextAgents) {
      const context: EventContext = {
        fields: {
          Project: agent.cwd,
          Model: agent.model,
          Status: agent.status,
          Task: agent.task,
          Output: agent.output,
          Error: agent.error,
          'Result file': agent.resultFile,
          'Session file': agent.sessionFile,
        },
      };
      const previous = this.previousAgents.get(agent.id);
      if (!previous || previous.status !== agent.status) {
        const message =
          agent.status === 'running'
            ? `Dispatched: ${agent.task}`
            : agent.status === 'queued'
              ? `Queued: ${agent.task}`
              : agent.status === 'failed'
                ? `Failed: ${agent.error ?? agent.activity}`
                : agent.activity;
        this.append(
          agent.status === 'failed' ? 'error' : 'agent',
          message,
          agent.id,
          agent.name,
          context,
        );
      } else if (previous.activity !== agent.activity) {
        this.append(
          agent.activity.startsWith('Using ') ? 'tool' : 'agent',
          agent.activity,
          agent.id,
          agent.name,
          context,
        );
      }
    }
    this.previousAgents = new Map(this.agents.map(agent => [agent.id, agent]));
    for (const message of messages) {
      if (!this.seenMessages.has(message.id)) {
        this.append(
          'message',
          `To parent session: ${message.message}`,
          message.from.id,
          message.from.name,
        );
      }
    }
    this.seenMessages = new Set(messages.map(message => message.id));
    this.changed();
  }

  replaceConversation(messages: Iterable<ConversationMessage>): void {
    if (this.conversation.replace(messages)) this.changed();
  }

  updateConversation(message: ConversationMessage): void {
    if (this.conversation.update(message)) this.changed();
  }

  conversationMessage(id: string): ConversationMessage | undefined {
    return this.conversation.get(id);
  }

  settleConversation(): void {
    if (this.conversation.settle()) this.changed();
  }

  updateQueue(steering: readonly string[], followUp: readonly string[]): void {
    const next = {
      steering: steering.map(text => preview(text)),
      followUp: followUp.map(text => preview(text)),
    };
    if (isDeepStrictEqual(this.queue, next)) return;
    this.queue = next;
    this.changed();
  }

  recordUsage(call: ModelUsageCall, sequence: number): void {
    if (this.usage.record(call, sequence)) this.changed();
  }

  replaceUsage(
    calls: Iterable<{call: ModelUsageCall; sequence: number}>,
  ): void {
    this.usage.replace(calls);
    this.changed();
  }

  recordChange(change: UnitChange): void {
    this.changes.push({...change});
    if (this.changes.length > 100) this.changes.shift();
    this.append(
      'tool',
      `${change.summary}: ${change.path}`,
      change.unitId,
      change.unitName,
      {fields: {File: change.path, Tool: change.tool, Diff: change.diff}},
    );
    this.changed();
  }

  /** A cached snapshot for immediate serialization. Callers must not mutate it. */
  deliverySnapshot(): DashboardSnapshot {
    return (this.cachedSnapshot ??= {
      session: {
        ...this.session,
        context: this.session.context ? {...this.session.context} : undefined,
      },
      agents: this.agents.map(agent => ({
        ...agent,
        conversation: agent.conversation.map(message => ({...message})),
        usage: agent.usage ? copyModelUsage(agent.usage) : undefined,
      })),
      totalAgents: this.totalAgents,
      events: this.events.map(event => ({
        ...event,
        details: {...event.details},
      })),
      changes: this.changes.map(change => ({...change})),
      ...this.conversation.snapshot(),
      queue: this.queue
        ? {
            steering: [...this.queue.steering],
            followUp: [...this.queue.followUp],
          }
        : undefined,
      usage: this.usage.snapshot(),
    });
  }

  snapshot(): DashboardSnapshot {
    return structuredClone(this.deliverySnapshot());
  }
}
