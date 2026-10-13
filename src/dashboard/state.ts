import type {AgentRecord} from '../agents/orchestrator.ts';
import {isAgentFinished} from '../agents/orchestrator.ts';
import type {ParentMessage} from '../agents/team.ts';
import type {UnitChange} from './changes.ts';

export interface DashboardSession {
  id: string;
  name: string;
  cwd: string;
  model?: string;
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
}

export interface DashboardAgent extends AgentRecord {
  taskTruncated: boolean;
  outputTruncated: boolean;
}

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: string;
  streaming?: boolean;
  truncated?: boolean;
  error?: string;
}

export interface DashboardSnapshot {
  session: DashboardSession;
  agents: DashboardAgent[];
  totalAgents: number;
  events: DashboardEvent[];
  changes: UnitChange[];
  conversation: ConversationMessage[];
  conversationTruncated: boolean;
}

const textLimit = 16000;
const eventLimit = 160;
const historyLimit = 100;

function preview(text: string, limit = textLimit): string {
  return text.length > limit
    ? `${text.slice(0, limit)}\n[Preview truncated]`
    : text;
}

function projectAgent(agent: AgentRecord): DashboardAgent {
  return {
    ...agent,
    task: preview(agent.task),
    activity: preview(agent.activity, 2000),
    output: agent.output === undefined ? undefined : preview(agent.output),
    error: agent.error === undefined ? undefined : preview(agent.error, 4000),
    taskTruncated: agent.task.length > textLimit,
    outputTruncated:
      (agent.output?.length ?? 0) > textLimit ||
      !!agent.output?.includes('[Output truncated. Read resultFile'),
  };
}

/** A bounded view of the live session; never reads transcripts or credentials. */
export class DashboardState {
  private session: DashboardSession;
  private agents: DashboardAgent[] = [];
  private totalAgents = 0;
  private readonly events: DashboardEvent[] = [];
  private readonly changes: UnitChange[] = [];
  private conversation: ConversationMessage[] = [];
  private conversationTruncated = false;
  private previousAgents = new Map<string, DashboardAgent>();
  private seenMessages = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private sequence = 0;

  constructor(session: DashboardSession) {
    this.session = {...session};
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.session.updatedAt = new Date().toISOString();
    for (const listener of this.listeners) listener();
  }

  private append(
    kind: DashboardEvent['kind'],
    message: string,
    sourceId = 'parent',
    sourceName = 'Mastermind',
  ): void {
    this.events.push({
      id: String(++this.sequence),
      at: new Date().toISOString(),
      sourceId,
      sourceName,
      kind,
      message: preview(message, 1000),
    });
    if (this.events.length > eventLimit) this.events.shift();
  }

  record(
    kind: DashboardEvent['kind'],
    message: string,
    sourceId?: string,
    sourceName?: string,
  ): void {
    this.append(kind, message, sourceId, sourceName);
    this.changed();
  }

  updateSession(patch: Partial<DashboardSession>): void {
    this.session = {
      ...this.session,
      ...patch,
      ...(patch.prompt !== undefined ? {prompt: preview(patch.prompt)} : {}),
      ...(patch.response !== undefined
        ? {response: preview(patch.response)}
        : {}),
    };
    this.changed();
  }

  updateTeam(records: AgentRecord[], messages: ParentMessage[]): void {
    this.totalAgents = records.length;
    const active = records.filter(agent => !isAgentFinished(agent.status));
    const history = records
      .filter(agent => isAgentFinished(agent.status))
      .sort((a, b) =>
        (b.finishedAt ?? b.createdAt).localeCompare(
          a.finishedAt ?? a.createdAt,
        ),
      )
      .slice(0, historyLimit);
    this.agents = [...active, ...history].map(projectAgent);
    for (const agent of this.agents) {
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
        );
      } else if (previous.activity !== agent.activity) {
        this.append(
          agent.activity.startsWith('Using ') ? 'tool' : 'agent',
          agent.activity,
          agent.id,
          agent.name,
        );
      } else if (previous.pendingMessages !== agent.pendingMessages) {
        this.append(
          'message',
          `${agent.pendingMessages} pending instruction${agent.pendingMessages === 1 ? '' : 's'}`,
          agent.id,
          agent.name,
        );
      }
    }
    this.previousAgents = new Map(this.agents.map(agent => [agent.id, agent]));
    for (const message of messages) {
      if (!this.seenMessages.has(message.id)) {
        this.append(
          'message',
          `To mastermind: ${message.message}`,
          message.from.id,
          message.from.name,
        );
      }
    }
    this.seenMessages = new Set(messages.map(message => message.id));
    this.changed();
  }

  private trimConversation(): void {
    let size = this.conversation.reduce(
      (total, message) => total + message.text.length,
      0,
    );
    while (this.conversation.length > 100 || size > 160000) {
      size -= this.conversation.shift()!.text.length;
      this.conversationTruncated = true;
    }
  }

  replaceConversation(messages: ConversationMessage[]): void {
    this.conversation = messages.map(message => ({
      ...message,
      text: preview(message.text),
      truncated: message.text.length > textLimit,
    }));
    this.conversationTruncated = false;
    this.trimConversation();
    this.changed();
  }

  updateConversation(message: ConversationMessage): void {
    const entry = {
      ...message,
      text: preview(message.text),
      truncated: message.text.length > textLimit,
    };
    const index = this.conversation.findIndex(item => item.id === entry.id);
    if (index < 0) this.conversation.push(entry);
    else this.conversation[index] = entry;
    this.trimConversation();
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
    );
    this.changed();
  }

  snapshot(): DashboardSnapshot {
    return {
      session: {
        ...this.session,
        context: this.session.context ? {...this.session.context} : undefined,
      },
      agents: this.agents.map(agent => ({...agent})),
      totalAgents: this.totalAgents,
      events: this.events.map(event => ({...event})),
      changes: this.changes.map(change => ({...change})),
      conversation: this.conversation.map(message => ({...message})),
      conversationTruncated: this.conversationTruncated,
    };
  }
}
