import {randomUUID} from 'node:crypto';
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
  pendingMessages: number;
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
  run(
    message: string,
    signal: AbortSignal,
    onActivity: (activity: string) => void,
    onUsage?: (usage: ModelUsage) => void,
  ): Promise<string>;
  dispose(): void;
}

export interface AgentMessageSender {
  kind: 'parent' | 'agent';
  id: string;
  name?: string;
}

export interface QueuedAgentMessage {
  id: string;
  message: string;
  sender: AgentMessageSender;
  reference?: string;
  createdAt: string;
  state: 'pending' | 'delivered' | 'removed' | 'superseded' | 'discarded';
  deliveredAt?: string;
  resolvedAt?: string;
  replacedBy?: string;
}

export interface AgentMessageOptions {
  sender?: AgentMessageSender;
  reference?: string;
  supersedes?: string[];
}

export interface AgentMessageChange {
  agent: AgentRecord;
  outcome: 'queued' | 'superseded' | 'removed' | 'not_pending';
  message?: QueuedAgentMessage;
  affected: QueuedAgentMessage[];
}

interface Job {
  record: AgentRecord;
  createWorker?: (id: string) => Promise<AgentWorker>;
  worker?: AgentWorker;
  messages: QueuedAgentMessage[];
  messageHistory: Map<string, QueuedAgentMessage>;
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

  constructor(concurrency = 4) {
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

  list(): AgentRecord[] {
    return [...this.jobs.values()].map(job => copyRecord(job.record));
  }

  spawn(
    spec: AgentSpec,
    createWorker: (id: string) => Promise<AgentWorker>,
    sender: AgentMessageSender = {kind: 'parent', id: 'parent'},
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
    const initial = this.createMessage(spec.task, {sender});
    this.jobs.set(id, {
      record: {
        ...spec,
        id,
        status: 'queued',
        activity: 'Waiting for a worker slot',
        createdAt: new Date().toISOString(),
        pendingMessages: 1,
      },
      createWorker,
      messages: [initial],
      messageHistory: new Map([[initial.id, initial]]),
    });
    this.pump();
    this.changed();
    return this.get(id);
  }

  private createMessage(
    message: string,
    options: AgentMessageOptions,
  ): QueuedAgentMessage {
    if (!message.trim()) throw new Error('Agent message cannot be empty.');
    if (message.length > 64000) {
      throw new Error('Agent message cannot exceed 64000 characters.');
    }
    if (
      options.reference !== undefined &&
      (!options.reference.trim() || options.reference.length > 1000)
    ) {
      throw new Error('Message reference must contain 1 to 1000 characters.');
    }
    return {
      id: randomUUID(),
      message,
      sender: {...(options.sender ?? {kind: 'parent', id: 'parent'})},
      reference: options.reference,
      createdAt: new Date().toISOString(),
      state: 'pending',
    };
  }

  private copyMessage(message: QueuedAgentMessage): QueuedAgentMessage {
    return {...message, sender: {...message.sender}};
  }

  getMessage(id: string, messageId: string): QueuedAgentMessage {
    const message = this.job(id).messageHistory.get(messageId);
    if (!message) throw new Error(`Unknown agent message: ${messageId}`);
    return this.copyMessage(message);
  }

  listMessages(
    id: string,
    options: {
      view?: 'pending' | 'history' | 'all';
      offset?: number;
      limit?: number;
    } = {},
  ) {
    const {view = 'pending', offset = 0, limit = 10} = options;
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 20
    ) {
      throw new Error(
        'Message offset must be non-negative and limit must be 1 to 20.',
      );
    }
    const job = this.job(id);
    const history = [...job.messageHistory.values()].filter(
      message => message.state !== 'pending',
    );
    const messages =
      view === 'pending'
        ? job.messages
        : view === 'history'
          ? history
          : [...job.messages, ...history];
    return {
      view,
      total: messages.length,
      pending: job.messages.length,
      offset,
      nextOffset: offset + limit < messages.length ? offset + limit : undefined,
      messages: messages
        .slice(offset, offset + limit)
        .map(message => this.copyMessage(message)),
    };
  }

  private selectedMessages(job: Job, ids: string[]): QueuedAgentMessage[] {
    if (ids.length < 1 || ids.length > 32 || new Set(ids).size !== ids.length) {
      throw new Error('Select 1 to 32 unique message IDs.');
    }
    return ids.map(id => {
      const message = job.messageHistory.get(id);
      if (!message) throw new Error(`Unknown agent message: ${id}`);
      return message;
    });
  }

  removeMessages(id: string, messageIds: string[]): AgentMessageChange {
    this.ensureOpen();
    const job = this.job(id);
    const selected = this.selectedMessages(job, messageIds);
    if (selected.some(message => message.state !== 'pending')) {
      return {
        agent: this.get(id),
        outcome: 'not_pending',
        affected: selected.map(message => this.copyMessage(message)),
      };
    }
    const resolvedAt = new Date().toISOString();
    for (const message of selected)
      Object.assign(message, {state: 'removed', resolvedAt});
    job.messages = job.messages.filter(message => message.state === 'pending');
    job.record.pendingMessages = job.messages.length;
    if (job.record.status === 'queued' && job.record.pendingMessages === 0) {
      job.record.status = 'completed';
      job.record.activity = 'No pending messages';
      job.record.finishedAt = resolvedAt;
      if (job.record.autoCleanup) this.dispose(job);
    }
    this.changed();
    return {
      agent: this.get(id),
      outcome: 'removed',
      affected: selected.map(message => this.copyMessage(message)),
    };
  }

  send(
    id: string,
    message: string,
    options: AgentMessageOptions = {},
  ): AgentMessageChange {
    this.ensureOpen();
    const job = this.job(id);
    const queued = this.createMessage(message, options);
    const selected =
      options.supersedes === undefined
        ? []
        : this.selectedMessages(job, options.supersedes);
    // Validate the whole edit before changing anything, including at capacity.
    if (selected.some(message => message.state !== 'pending')) {
      return {
        agent: this.get(id),
        outcome: 'not_pending',
        affected: selected.map(message => this.copyMessage(message)),
      };
    }
    if (['failed', 'cancelled', 'cancelling'].includes(job.record.status)) {
      throw new Error(
        `Cannot message a ${job.record.status} agent. Spawn a new agent.`,
      );
    }
    this.ensureResumable(job);
    if (job.messages.length - selected.length >= 32) {
      throw new Error('This agent already has 32 pending messages.');
    }
    const position = selected.length
      ? Math.min(...selected.map(message => job.messages.indexOf(message)))
      : job.messages.length;
    const resolvedAt = new Date().toISOString();
    for (const message of selected)
      Object.assign(message, {
        state: 'superseded',
        resolvedAt,
        replacedBy: queued.id,
      });
    job.messages = job.messages.filter(message => message.state === 'pending');
    job.messages.splice(position, 0, queued);
    job.messageHistory.set(queued.id, queued);
    job.record.pendingMessages = job.messages.length;
    if (job.record.status === 'completed') {
      job.record.status = 'queued';
      job.record.activity = 'Waiting for a worker slot';
      job.record.finishedAt = undefined;
      job.record.output = undefined;
    }
    this.pump();
    this.changed();
    return {
      agent: this.get(id),
      outcome: selected.length ? 'superseded' : 'queued',
      message: this.copyMessage(queued),
      affected: selected.map(message => this.copyMessage(message)),
    };
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

  private dispose(job: Job): void {
    this.captureUsage(job);
    const worker = job.worker;
    job.worker = undefined;
    job.createWorker = undefined;
    worker?.dispose();
  }

  private discardMessages(job: Job): void {
    const resolvedAt = new Date().toISOString();
    for (const message of job.messages)
      Object.assign(message, {state: 'discarded', resolvedAt});
    job.messages = [];
    job.record.pendingMessages = 0;
  }

  cancel(id: string): AgentRecord {
    const job = this.job(id);
    if (isAgentFinished(job.record.status)) return this.get(id);
    this.discardMessages(job);
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
    const abort = () => this.discardMessages(job);
    signal.addEventListener('abort', abort, {once: true});
    try {
      signal.throwIfAborted();
      job.record.startedAt ??= new Date().toISOString();
      while (job.messages.length > 0) {
        signal.throwIfAborted();
        if (!job.worker) {
          job.record.activity = 'Starting';
          this.changed();
          signal.throwIfAborted();
          job.worker = await job.createWorker!(job.record.id);
          job.record.sessionFile = job.worker.sessionFile;
          job.record.resultFile = job.worker.resultFile;
          this.captureUsage(job);
        }
        signal.throwIfAborted();
        // Queue edits can remove all work while the worker is starting.
        if (job.messages.length === 0) continue;
        const queued = job.messages.shift()!;
        queued.state = 'delivered';
        queued.deliveredAt = new Date().toISOString();
        const message =
          queued.sender.kind === 'agent'
            ? `Message from agent ${JSON.stringify(queued.sender.name)} (${queued.sender.id}):\n${queued.message}`
            : queued.message;
        job.record.pendingMessages = job.messages.length;
        job.record.activity = 'Working';
        this.changed();
        signal.throwIfAborted();
        const output = await job.worker.run(
          message,
          signal,
          activity => {
            if (signal.aborted) return;
            job.record.activity = activity;
            this.changed();
          },
          usage => {
            // Cancellation does not erase tokens the provider has already reported.
            job.record.usage = copyModelUsage(usage);
            this.changed();
          },
        );
        signal.throwIfAborted();
        job.record.output =
          output.length > 12000
            ? `${output.slice(0, 12000)}\n[Output truncated. Read resultFile for the full result.]`
            : output;
      }
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
      this.discardMessages(job);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      this.captureUsage(job);
      if (job.record.autoCleanup || job.record.status !== 'completed') {
        this.dispose(job);
      }
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
      [...this.jobs.values()].map(job => job.operation),
    ).then(() => {
      for (const job of this.jobs.values()) this.dispose(job);
      this.listeners.clear();
    });
    return this.closing;
  }
}
