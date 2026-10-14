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

export interface DashboardAgent extends AgentRecord {
  taskTruncated: boolean;
  outputTruncated: boolean;
}

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  at: string;
  streaming?: boolean;
  truncated?: boolean;
  error?: string;
  toolName?: string;
  toolCallId?: string;
  input?: string;
  status?: 'running' | 'completed' | 'failed' | 'cancelled';
  finishedAt?: string;
}

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

function projectAgent(agent: AgentRecord): DashboardAgent {
  return {
    ...agent,
    usage: agent.usage ? copyModelUsage(agent.usage) : undefined,
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

function projectMessage(message: ConversationMessage): ConversationMessage {
  return {
    ...message,
    text: preview(message.text),
    input:
      message.input === undefined ? undefined : preview(message.input, 8000),
    error:
      message.error === undefined ? undefined : preview(message.error, 4000),
    toolName:
      message.toolName === undefined
        ? undefined
        : preview(message.toolName, 200),
    truncated:
      !!message.truncated ||
      message.text.length > textLimit ||
      (message.input?.length ?? 0) > 8000 ||
      (message.error?.length ?? 0) > 4000,
  };
}

function messageSize(message: ConversationMessage): number {
  return (
    message.text.length +
    (message.input?.length ?? 0) +
    (message.error?.length ?? 0)
  );
}

/** A bounded view of the live session and public conversation text. */
export class DashboardState {
  private session: DashboardSession;
  private agents: DashboardAgent[] = [];
  private totalAgents = 0;
  private readonly events: DashboardEvent[] = [];
  private readonly changes: UnitChange[] = [];
  private conversation: ConversationMessage[] = [];
  private conversationTruncated = false;
  private queue: DashboardSnapshot['queue'];
  private readonly usage = new ModelUsageTracker();
  private previousAgents = new Map<string, DashboardAgent>();
  private seenMessages = new Set<string>();
  private readonly listeners = new Set<() => void>();
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

  private changed(): void {
    this.session.updatedAt = new Date().toISOString();
    for (const listener of this.listeners) listener();
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
    this.session = {
      ...this.session,
      ...patch,
      ...(patch.context ? {context: {...patch.context}} : {}),
      ...(patch.error !== undefined ? {error: preview(patch.error, 4000)} : {}),
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

  private trimConversation(): void {
    let size = this.conversation.reduce(
      (total, message) => total + messageSize(message),
      0,
    );
    while (this.conversation.length > 100 || size > 160000) {
      size -= messageSize(this.conversation.shift()!);
      this.conversationTruncated = true;
    }
  }

  replaceConversation(messages: Iterable<ConversationMessage>): void {
    this.conversation = [];
    this.conversationTruncated = false;
    for (const message of messages) {
      const index = this.conversation.findIndex(item => item.id === message.id);
      const previous = this.conversation[index];
      const entry = projectMessage({
        ...previous,
        ...message,
        at: previous?.at ?? message.at,
      });
      if (index < 0) this.conversation.push(entry);
      else this.conversation[index] = entry;
      this.trimConversation();
    }
    this.changed();
  }

  updateConversation(message: ConversationMessage): void {
    const entry = projectMessage(message);
    const index = this.conversation.findIndex(item => item.id === entry.id);
    if (index < 0) this.conversation.push(entry);
    else this.conversation[index] = entry;
    this.trimConversation();
    this.changed();
  }

  conversationMessage(id: string): ConversationMessage | undefined {
    const message = this.conversation.find(item => item.id === id);
    return message ? {...message} : undefined;
  }

  settleConversation(): void {
    const now = new Date().toISOString();
    for (const message of this.conversation) {
      if (message.streaming) message.streaming = false;
      if (message.role === 'tool' && message.status === 'running') {
        message.status = 'cancelled';
        message.finishedAt = now;
      }
    }
    this.changed();
  }

  updateQueue(steering: readonly string[], followUp: readonly string[]): void {
    this.queue = {
      steering: steering.map(text => preview(text)),
      followUp: followUp.map(text => preview(text)),
    };
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

  snapshot(): DashboardSnapshot {
    return {
      session: {
        ...this.session,
        context: this.session.context ? {...this.session.context} : undefined,
      },
      agents: this.agents.map(agent => ({
        ...agent,
        usage: agent.usage ? copyModelUsage(agent.usage) : undefined,
      })),
      totalAgents: this.totalAgents,
      events: this.events.map(event => ({
        ...event,
        details: {...event.details},
      })),
      changes: this.changes.map(change => ({...change})),
      conversation: this.conversation.map(message => ({...message})),
      conversationTruncated: this.conversationTruncated,
      queue: this.queue
        ? {
            steering: [...this.queue.steering],
            followUp: [...this.queue.followUp],
          }
        : undefined,
      usage: this.usage.snapshot(),
    };
  }
}
