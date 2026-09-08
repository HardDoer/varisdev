import {randomUUID} from 'node:crypto';

export type AgentStatus =
  'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

export interface AgentSpec {
  name: string;
  task: string;
  cwd: string;
  model: string;
  timeoutMs: number;
  notify: boolean;
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
}

export interface AgentWorker {
  sessionFile?: string;
  resultFile?: string;
  run(
    message: string,
    signal: AbortSignal,
    onActivity: (activity: string) => void,
  ): Promise<string>;
  dispose(): void;
}

interface Job {
  record: AgentRecord;
  createWorker: (id: string) => Promise<AgentWorker>;
  worker?: AgentWorker;
  messages: string[];
  controller?: AbortController;
  operation?: Promise<void>;
}

export function isAgentFinished(status: AgentStatus): boolean {
  return ['completed', 'failed', 'cancelled'].includes(status);
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
    return {...this.job(id).record};
  }

  list(): AgentRecord[] {
    return [...this.jobs.values()].map(job => ({...job.record}));
  }

  spawn(
    spec: AgentSpec,
    createWorker: (id: string) => Promise<AgentWorker>,
  ): AgentRecord {
    this.ensureOpen();
    if (!spec.task.trim() || !spec.name.trim()) {
      throw new Error('Agent name and task cannot be empty.');
    }
    if (!Number.isInteger(spec.timeoutMs) || spec.timeoutMs < 1) {
      throw new Error('Agent timeout must be a positive integer.');
    }
    if (this.jobs.size >= 64) {
      throw new Error('This session has reached its limit of 64 agents.');
    }
    const id = randomUUID();
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
      messages: [spec.task],
    });
    this.pump();
    this.changed();
    return this.get(id);
  }

  send(id: string, message: string): AgentRecord {
    this.ensureOpen();
    const job = this.job(id);
    if (!message.trim()) throw new Error('Agent message cannot be empty.');
    if (['failed', 'cancelled', 'cancelling'].includes(job.record.status)) {
      throw new Error(
        `Cannot message a ${job.record.status} agent. Spawn a new agent.`,
      );
    }
    if (job.messages.length >= 32) {
      throw new Error('This agent already has 32 pending messages.');
    }
    job.messages.push(message);
    job.record.pendingMessages = job.messages.length;
    if (job.record.status === 'completed') {
      job.record.status = 'queued';
      job.record.activity = 'Waiting for a worker slot';
      job.record.finishedAt = undefined;
      job.record.output = undefined;
    }
    this.pump();
    this.changed();
    return this.get(id);
  }

  cancel(id: string): AgentRecord {
    const job = this.job(id);
    if (isAgentFinished(job.record.status)) return this.get(id);
    job.messages = [];
    job.record.pendingMessages = 0;
    if (job.controller) {
      job.record.status = 'cancelling';
      job.record.activity = 'Cancelling';
      job.controller.abort(new Error('Agent cancelled.'));
    } else {
      job.record.status = 'cancelled';
      job.record.activity = 'Cancelled';
      job.record.finishedAt = new Date().toISOString();
      job.worker?.dispose();
      job.worker = undefined;
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
    const timer = setTimeout(() => {
      controller.abort(
        new Error(`Timed out after ${formatDuration(job.record.timeoutMs)}.`),
      );
    }, job.record.timeoutMs);
    try {
      signal.throwIfAborted();
      job.record.startedAt ??= new Date().toISOString();
      job.record.activity = 'Starting';
      this.changed();
      job.worker ??= await job.createWorker(job.record.id);
      job.record.sessionFile = job.worker.sessionFile;
      job.record.resultFile = job.worker.resultFile;
      signal.throwIfAborted();
      while (job.messages.length > 0) {
        const message = job.messages.shift()!;
        job.record.pendingMessages = job.messages.length;
        job.record.activity = 'Working';
        this.changed();
        const output = await job.worker.run(message, signal, activity => {
          job.record.activity = activity;
          this.changed();
        });
        signal.throwIfAborted();
        job.record.output =
          output.length > 12000
            ? `${output.slice(0, 12000)}\n[Output truncated. Read resultFile for the full result.]`
            : output;
      }
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
      job.messages = [];
      job.record.pendingMessages = 0;
    } finally {
      clearTimeout(timer);
      if (job.record.status !== 'completed') {
        job.worker?.dispose();
        job.worker = undefined;
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
      for (const job of this.jobs.values()) {
        job.worker?.dispose();
        job.worker = undefined;
      }
      this.listeners.clear();
    });
    return this.closing;
  }
}
