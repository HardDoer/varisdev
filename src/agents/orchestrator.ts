import {randomUUID} from 'node:crypto';
import {ConversationState, type ConversationSnapshot} from '../conversation.ts';
import {copyModelUsage, type ModelUsage} from '../usage.ts';

export type AgentStatus =
  'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

export interface AgentSpec {
  name: string;
  task: string;
  cwd: string;
  model: string;
  timeoutMs?: number;
  autoCleanup?: boolean;
}

export interface AgentRecord extends AgentSpec {
  id: string;
  status: AgentStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  activity: string;
  output?: string;
  error?: string;
  sessionFile?: string;
  resultFile?: string;
  usage?: ModelUsage;
}

export interface AgentWorker {
  sessionFile?: string;
  resultFile?: string;
  readonly usage?: ModelUsage;
  readonly conversation?: ConversationSnapshot;
  run(
    message: string,
    signal: AbortSignal,
    onActivity: (activity: string) => void,
    onUsage?: (usage: ModelUsage) => void,
    onConversation?: (conversation: ConversationSnapshot) => void,
  ): Promise<string>;
  steer(message: string, starting: boolean): Promise<boolean>;
  dispose(): void;
}

export interface AgentMessageSender {
  kind: 'parent' | 'agent';
  id: string;
  name?: string;
}

interface Job {
  record: AgentRecord;
  conversation: ConversationState;
  createWorker?: (id: string) => Promise<AgentWorker>;
  worker?: AgentWorker;
  initializing?: Promise<AgentWorker>;
  input: string;
  promptStarted?: boolean;
  controller?: AbortController;
  operation?: Promise<void>;
}

export function isAgentFinished(status: AgentStatus): boolean {
  return ['completed', 'failed', 'cancelled'].includes(status);
}

function copyRecord(record: AgentRecord): AgentRecord {
  return {
    ...record,
    usage: record.usage ? copyModelUsage(record.usage) : undefined,
  };
}

function formatDuration(ms: number): string {
  for (const [size, unit] of [
    [3600000, 'hour'],
    [60000, 'minute'],
    [1000, 'second'],
  ] as const) {
    if (ms % size === 0) {
      const value = ms / size;
      return `${value} ${unit}${value === 1 ? '' : 's'}`;
    }
  }
  return `${ms} millisecond${ms === 1 ? '' : 's'}`;
}

/** Owns background work for one parent session. */
export class AgentOrchestrator {
  private readonly jobs = new Map<string, Job>();
  private readonly listeners = new Set<() => void>();
  private readonly concurrency: number;
  private active = 0;
  private closed = false;
  private closing?: Promise<void>;

  constructor(concurrency = 6) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('Agent concurrency must be a positive integer.');
    }
    this.concurrency = concurrency;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  private job(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown agent: ${id}`);
    return job;
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('This agent session has closed.');
  }

  get(id: string): AgentRecord {
    return copyRecord(this.job(id).record);
  }

  /** Conversation stays separate from public tool records and survives worker cleanup. */
  conversation(id: string): ConversationSnapshot {
    return this.job(id).conversation.snapshot();
  }

  list(): AgentRecord[] {
    return [...this.jobs.values()].map(job => copyRecord(job.record));
  }

  spawn(
    spec: AgentSpec,
    createWorker: (id: string) => Promise<AgentWorker>,
  ): AgentRecord {
    this.ensureOpen();
    if (!spec.task.trim() || !spec.name.trim()) {
      throw new Error('Agent name and task cannot be empty.');
    }
    if (
      spec.timeoutMs !== undefined &&
      (!Number.isInteger(spec.timeoutMs) || spec.timeoutMs < 1)
    ) {
      throw new Error('Agent timeout must be a positive integer.');
    }
    const retained = [...this.jobs.values()].filter(
      job => !job.record.autoCleanup || !isAgentFinished(job.record.status),
    );
    if (retained.length >= 64) {
      throw new Error('This session has reached its limit of 64 agents.');
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const conversation = new ConversationState();
    conversation.update({
      id: `task-${id}`,
      role: 'user',
      text: spec.task,
      at: createdAt,
    });
    this.jobs.set(id, {
      conversation,
      record: {
        ...spec,
        id,
        status: 'queued',
        activity: 'Waiting for a worker slot',
        createdAt,
      },
      createWorker,
      input: spec.task,
    });
    this.pump();
    this.changed();
    return this.get(id);
  }

  private prepare(job: Job): Promise<AgentWorker> {
    if (job.worker) return Promise.resolve(job.worker);
    job.initializing ??= job.createWorker!(job.record.id).then(worker => {
      if (
        this.closed ||
        ['cancelled', 'cancelling', 'failed'].includes(job.record.status)
      ) {
        worker.dispose();
        throw new Error('Agent stopped before its session was ready.');
      }
      job.worker = worker;
      job.record.sessionFile = worker.sessionFile;
      job.record.resultFile = worker.resultFile;
      this.captureUsage(job);
      this.captureConversation(job);
      return worker;
    });
    return job.initializing;
  }

  async send(
    id: string,
    message: string,
    sender?: AgentMessageSender,
  ): Promise<AgentRecord> {
    this.ensureOpen();
    if (!message.trim()) throw new Error('Agent message cannot be empty.');
    if (message.length > 64000)
      throw new Error('Agent message cannot exceed 64000 characters.');
    const job = this.job(id);
    const ensureRecipient = () => {
      this.ensureOpen();
      if (['failed', 'cancelled', 'cancelling'].includes(job.record.status))
        throw new Error(
          'Cannot message a ' +
            job.record.status +
            ' agent. Spawn a new agent.',
        );
      this.ensureResumable(job);
    };
    ensureRecipient();
    const worker = await this.prepare(job);
    ensureRecipient();
    const text =
      sender?.kind === 'agent'
        ? 'Message from agent ' +
          JSON.stringify(sender.name) +
          ' (' +
          sender.id +
          '):\n' +
          message
        : message;
    if (job.record.status === 'completed') {
      job.input = text;
      job.promptStarted = false;
      job.record.status = 'queued';
      job.record.activity = 'Waiting for a worker slot';
      job.record.finishedAt = undefined;
      job.record.output = undefined;
      this.pump();
    } else if (!(await worker.steer(text, !job.promptStarted))) {
      // The model has finished; let result persistence settle before resuming it.
      await job.operation;
      return this.send(id, message, sender);
    }
    this.changed();
    return this.get(id);
  }

  private ensureResumable(job: Job): void {
    if (job.record.autoCleanup && isAgentFinished(job.record.status)) {
      throw new Error('Agent session has been cleaned up. Spawn a new agent.');
    }
  }

  private captureUsage(job: Job): void {
    const usage = job.worker?.usage;
    if (usage) job.record.usage = copyModelUsage(usage);
  }

  private captureConversation(
    job: Job,
    snapshot = job.worker?.conversation,
  ): void {
    if (
      !snapshot ||
      (!snapshot.conversation.length && !snapshot.conversationTruncated)
    )
      return;
    job.conversation.replace(
      snapshot.conversation,
      snapshot.conversationTruncated,
    );
  }

  private dispose(job: Job): void {
    this.captureUsage(job);
    this.captureConversation(job);
    const worker = job.worker;
    job.worker = undefined;
    job.createWorker = undefined;
    worker?.dispose();
    this.settleConversation(job);
  }

  private settleConversation(job: Job): void {
    job.conversation.settle(
      job.record.status === 'failed' ? 'failed' : 'cancelled',
      job.record.error,
    );
    if (
      job.record.status === 'failed' &&
      job.record.error &&
      !job.conversation.snapshot().conversation.some(message => message.error)
    ) {
      job.conversation.update({
        id: `error-${job.record.id}`,
        role: 'assistant',
        text: '',
        error: job.record.error,
        at: new Date().toISOString(),
      });
    }
  }

  cancel(id: string): AgentRecord {
    const job = this.job(id);
    if (isAgentFinished(job.record.status)) return this.get(id);
    if (job.controller) {
      job.record.status = 'cancelling';
      job.record.activity = 'Cancelling';
      job.controller.abort(new Error('Agent cancelled.'));
    } else {
      job.record.status = 'cancelled';
      job.record.activity = 'Cancelled';
      job.record.finishedAt = new Date().toISOString();
      this.dispose(job);
    }
    this.changed();
    return this.get(id);
  }

  private pump(): void {
    if (this.closed) return;
    for (const job of this.jobs.values()) {
      if (this.active >= this.concurrency) break;
      if (job.record.status !== 'queued') continue;
      this.active++;
      job.record.status = 'running';
      job.controller = new AbortController();
      // Defer execution so the operation is assigned before any callbacks fire.
      job.operation = Promise.resolve().then(() => this.run(job));
    }
  }

  private async run(job: Job): Promise<void> {
    const controller = job.controller!;
    const {signal} = controller;
    const {timeoutMs} = job.record;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            controller.abort(
              new Error(`Timed out after ${formatDuration(timeoutMs)}.`),
            );
          }, timeoutMs);
    try {
      signal.throwIfAborted();
      job.record.startedAt ??= new Date().toISOString();
      job.record.activity = 'Starting';
      this.changed();
      const worker = await this.prepare(job);
      signal.throwIfAborted();
      job.record.activity = 'Working';
      this.changed();
      signal.throwIfAborted();
      job.promptStarted = true;
      const output = await worker.run(
        job.input,
        signal,
        activity => {
          if (signal.aborted || job.record.activity === activity) return;
          job.record.activity = activity;
          this.changed();
        },
        usage => {
          // Cancellation does not erase tokens the provider has already reported.
          job.record.usage = copyModelUsage(usage);
          this.changed();
        },
        conversation => {
          this.captureConversation(job, conversation);
          this.changed();
        },
      );
      signal.throwIfAborted();
      job.record.output =
        output.length > 12000
          ? `${output.slice(0, 12000)}\n[Output truncated. Read resultFile for the full result.]`
          : output;
      signal.throwIfAborted();
      job.record.status = 'completed';
      job.record.activity = 'Completed';
    } catch (error) {
      job.record.status =
        job.record.status === 'cancelling' ? 'cancelled' : 'failed';
      const cause = signal.aborted ? signal.reason : error;
      job.record.error = cause instanceof Error ? cause.message : String(cause);
      job.record.activity =
        job.record.status === 'cancelled'
          ? 'Cancelled'
          : job.record.error.slice(0, 2000);
    } finally {
      clearTimeout(timer);
      this.captureUsage(job);
      this.captureConversation(job);
      if (job.record.autoCleanup || job.record.status !== 'completed') {
        this.dispose(job);
      }
      this.settleConversation(job);
      job.record.finishedAt = new Date().toISOString();
      job.controller = undefined;
      job.operation = undefined;
      this.active--;
      this.pump();
      this.changed();
    }
  }

  async wait(
    ids: string[],
    options: {
      mode?: 'any' | 'all';
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<AgentRecord[]> {
    const uniqueIds = [...new Set(ids)];
    uniqueIds.forEach(id => this.job(id));
    const {signal, mode = 'all', timeoutMs = 60000} = options;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
      throw new Error('Wait timeout must be a non-negative integer.');
    }
    signal?.throwIfAborted();
    const ready = () => {
      const finished = uniqueIds.map(id =>
        isAgentFinished(this.job(id).record.status),
      );
      return (
        finished.length === 0 ||
        (mode === 'any' ? finished.some(Boolean) : finished.every(Boolean))
      );
    };
    if (!ready() && timeoutMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const finish = (aborted = false) => {
          clearTimeout(timer);
          unsubscribe();
          signal?.removeEventListener('abort', abort);
          if (aborted) reject(signal?.reason ?? new Error('Wait cancelled.'));
          else resolve();
        };
        const abort = () => finish(true);
        const unsubscribe = this.subscribe(() => {
          if (ready()) finish();
        });
        const timer = setTimeout(() => finish(), timeoutMs);
        signal?.addEventListener('abort', abort, {once: true});
        if (signal?.aborted) abort();
        else if (ready()) finish();
      });
    }
    return uniqueIds.map(id => this.get(id));
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const id of this.jobs.keys()) this.cancel(id);
    this.closing = Promise.all(
      [...this.jobs.values()].flatMap(job => [
        job.operation,
        job.initializing?.catch(() => {}),
      ]),
    ).then(() => {
      for (const job of this.jobs.values()) this.dispose(job);
      this.listeners.clear();
    });
    return this.closing;
  }
}
