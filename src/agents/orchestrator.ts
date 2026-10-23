import {randomUUID} from 'node:crypto';
import {ConversationState, type ConversationSnapshot} from '../conversation.ts';
import {copyModelUsage, type ModelUsage} from '../usage.ts';
import type {
  SessionConfiguration,
  SessionFeatures,
} from '../dashboard/features.ts';

export type AgentStatus =
  'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

export interface AgentSpec {
  name: string;
  task: string;
  cwd: string;
  model: string;
  pinnedModel?: string;
  agentMode?: 'primary' | 'subagent' | 'all';
  agentProfile?: SessionFeatures['agentProfile'];
  timeoutMs?: number;
  autoCleanup?: boolean;
  thinkingLevel?: string;
  speedMode?: import('../speed-modes.ts').SpeedMode;
}

export interface AgentContextUsage {
  tokens: number | null;
  window: number;
  percent: number | null;
}

export interface AgentRecord extends AgentSpec {
  id: string;
  status: AgentStatus;
  resumable?: boolean;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  activity: string;
  output?: string;
  outputTruncated?: boolean;
  error?: string;
  sessionFile?: string;
  resultFile?: string;
  usage?: ModelUsage;
  context?: AgentContextUsage;
}

export interface AgentWorker {
  sessionFile?: string;
  resultFile?: string;
  readonly usage?: ModelUsage;
  readonly context?: AgentContextUsage;
  readonly conversation?: ConversationSnapshot;
  run(
    message: string,
    signal: AbortSignal,
    onActivity: (activity: string) => void,
    onUsage?: (usage: ModelUsage) => void,
    onConversation?: (conversation: ConversationSnapshot) => void,
  ): Promise<string>;
  steer(message: string, starting: boolean): Promise<boolean>;
  features?(): Promise<SessionFeatures>;
  configure?(input: SessionConfiguration): Promise<SessionFeatures>;
  command?(command: string): Promise<SessionFeatures>;
  compact?(instructions?: string): Promise<void>;
  reload?(): Promise<void>;
  clearQueue?(): {steering: string[]; followUp: string[]};
  abort?(): Promise<void>;
  dispose(): void | Promise<void>;
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
  disposal?: Promise<void>;
  cancellation?: Promise<void>;
  closing?: Promise<void>;
  interaction?: Promise<unknown>;
  maintaining?: boolean;
  stopVersion?: number;
  ownsSlot?: boolean;
  waiters?: number;
  resumeSlot?: {promise: Promise<void>; resolve: () => void};
}

export function isAgentFinished(status: AgentStatus): boolean {
  return ['completed', 'failed', 'cancelled'].includes(status);
}

function copyRecord(record: AgentRecord): AgentRecord {
  return {
    ...record,
    agentProfile: record.agentProfile ? {...record.agentProfile} : undefined,
    usage: record.usage ? copyModelUsage(record.usage) : undefined,
    context: record.context ? {...record.context} : undefined,
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
  private maxConcurrentAgents: number;
  private active = 0;
  private closed = false;
  private closing?: Promise<void>;

  constructor(maxConcurrentAgents = 6) {
    this.maxConcurrentAgents = 6;
    this.setMaxConcurrentAgents(maxConcurrentAgents);
  }

  /** The conversation's main agent always reserves one slot. */
  setMaxConcurrentAgents(maxConcurrentAgents: number): void {
    if (!Number.isSafeInteger(maxConcurrentAgents) || maxConcurrentAgents < 1) {
      throw new Error(
        'Maximum concurrent agents must be a whole number of at least 1.',
      );
    }
    this.maxConcurrentAgents = maxConcurrentAgents;
    this.pump();
  }

  assertAdditionalAgentsAllowed(): void {
    if (this.maxConcurrentAgents === 1)
      throw new Error(
        'Additional agents are disabled: maximum concurrent agents is 1, reserved for the main conversation. Change Menu → Tool models to allow more agents.',
      );
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
    this.assertAdditionalAgentsAllowed();
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
      job => !isAgentFinished(job.record.status) || job.record.resumable,
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
        agentProfile: spec.agentProfile ? {...spec.agentProfile} : undefined,
        id,
        status: 'queued',
        resumable: true,
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
    if (!job.createWorker)
      throw new Error('Agent session has been cleaned up.');
    job.initializing ??= job
      .createWorker(job.record.id)
      .then(async worker => {
        job.worker = worker;
        if (this.closed || !job.record.resumable) {
          await this.dispose(job);
          throw new Error('Agent stopped before its session was ready.');
        }
        if (
          job.record.status === 'cancelled' ||
          job.record.status === 'cancelling'
        )
          worker.clearQueue?.();
        job.record.sessionFile = worker.sessionFile;
        job.record.resultFile = worker.resultFile;
        this.captureUsage(job);
        this.captureContext(job);
        this.captureConversation(job);
        return worker;
      })
      .finally(() => {
        job.initializing = undefined;
      });
    return job.initializing;
  }

  private interact<T>(job: Job, action: () => Promise<T>): Promise<T> {
    const operation = (job.interaction ?? Promise.resolve()).then(action);
    job.interaction = operation.catch(() => {});
    return operation;
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
    const stopVersion = job.stopVersion;
    const ensureDelivery = () => {
      this.ensureOpen();
      this.ensureResumable(job);
      if (job.stopVersion !== stopVersion)
        throw new Error('Agent message cancelled.');
    };
    return this.interact(job, async () => {
      const text =
        sender?.kind === 'agent'
          ? 'Message from agent ' +
            JSON.stringify(sender.name) +
            ' (' +
            sender.id +
            '):\n' +
            message
          : message;
      for (;;) {
        ensureDelivery();
        if (
          job.operation &&
          (isAgentFinished(job.record.status) ||
            job.record.status === 'cancelling' ||
            job.controller?.signal.aborted)
        ) {
          await job.operation;
          continue;
        }
        if (!job.operation) this.assertAdditionalAgentsAllowed();
        const worker = await this.prepare(job);
        ensureDelivery();
        if (
          job.operation &&
          (isAgentFinished(job.record.status) ||
            job.record.status === 'cancelling' ||
            job.controller?.signal.aborted)
        ) {
          await job.operation;
          continue;
        }
        if (isAgentFinished(job.record.status)) {
          job.input = text;
          job.promptStarted = false;
          job.record.status = 'queued';
          job.record.activity = 'Waiting for a worker slot';
          job.record.finishedAt = undefined;
          job.record.error = undefined;
          job.record.output = undefined;
          job.record.outputTruncated = undefined;
          this.pump();
        } else if (!(await worker.steer(text, !job.promptStarted))) {
          await job.operation;
          continue;
        }
        if (job.stopVersion !== stopVersion) job.worker?.clearQueue?.();
        ensureDelivery();
        if (
          job.record.status === 'cancelling' ||
          job.controller?.signal.aborted
        ) {
          await job.operation;
          continue;
        }
        this.changed();
        return this.get(id);
      }
    });
  }

  async features(id: string): Promise<SessionFeatures> {
    this.ensureOpen();
    const job = this.job(id);
    return this.interact(job, async () => {
      this.ensureOpen();
      this.ensureResumable(job);
      const worker = await this.prepare(job);
      if (!worker.features)
        throw new Error('Agent session features are unavailable.');
      return worker.features();
    });
  }

  private async maintain<T>(
    id: string,
    action: (worker: AgentWorker) => Promise<T>,
  ): Promise<T> {
    this.ensureOpen();
    const job = this.job(id);
    const stopVersion = job.stopVersion;
    const ensureMaintenance = () => {
      this.ensureOpen();
      this.ensureResumable(job);
      if (job.stopVersion !== stopVersion)
        throw new Error('Agent operation cancelled.');
    };
    return this.interact(job, async () => {
      ensureMaintenance();
      job.maintaining = true;
      try {
        if (
          job.record.status === 'cancelling' ||
          isAgentFinished(job.record.status)
        )
          await job.operation;
        ensureMaintenance();
        const worker = await this.prepare(job);
        ensureMaintenance();
        return await action(worker);
      } finally {
        this.captureUsage(job);
        this.captureContext(job);
        this.captureConversation(job);
        job.maintaining = false;
        this.pump();
        this.changed();
      }
    });
  }

  async configure(
    id: string,
    input: SessionConfiguration,
  ): Promise<AgentRecord> {
    await this.maintain(id, async worker => {
      if (!worker.configure)
        throw new Error('Agent configuration is unavailable.');
      const features = await worker.configure(input);
      const record = this.job(id).record;
      if (features.model)
        record.model = `${features.model.provider}/${features.model.id}`;
      record.thinkingLevel = features.thinkingLevel;
      record.speedMode = features.speedMode;
    });
    return this.get(id);
  }

  async command(id: string, command: string): Promise<AgentRecord> {
    await this.maintain(id, async worker => {
      if (!worker.command)
        throw new Error('Agent native commands are unavailable.');
      const features = await worker.command(command);
      const record = this.job(id).record;
      if (features.model)
        record.model = `${features.model.provider}/${features.model.id}`;
      record.thinkingLevel = features.thinkingLevel;
      record.speedMode = features.speedMode;
    });
    return this.get(id);
  }

  compact(id: string, instructions?: string): Promise<void> {
    return this.maintain(id, async worker => {
      if (!worker.compact) throw new Error('Agent compaction is unavailable.');
      await worker.compact(instructions);
    });
  }

  reload(id: string): Promise<void> {
    return this.maintain(id, async worker => {
      if (!worker.reload) throw new Error('Agent reload is unavailable.');
      await worker.reload();
    });
  }

  async abort(id: string): Promise<{steering: string[]; followUp: string[]}> {
    this.ensureOpen();
    const job = this.job(id);
    const queue = job.worker?.clearQueue?.() ?? {steering: [], followUp: []};
    const interaction = job.interaction;
    this.cancel(id);
    await job.operation;
    await job.initializing?.catch(() => {});
    await interaction;
    await job.cancellation;
    await job.closing;
    await job.disposal;
    return queue;
  }

  async closeAgent(id: string): Promise<void> {
    this.ensureOpen();
    const job = this.job(id);
    job.closing ??= (async () => {
      job.record.resumable = false;
      this.cancel(id);
      await job.operation;
      await job.initializing?.catch(() => {});
      await job.interaction;
      await job.cancellation;
      await this.dispose(job);
      this.changed();
    })();
    return job.closing;
  }

  private ensureResumable(job: Job): void {
    if (
      !job.record.resumable ||
      (job.record.autoCleanup && isAgentFinished(job.record.status))
    ) {
      throw new Error('Agent session has been cleaned up. Spawn a new agent.');
    }
  }

  private captureUsage(job: Job): void {
    const usage = job.worker?.usage;
    if (usage) job.record.usage = copyModelUsage(usage);
  }

  private captureContext(job: Job): boolean {
    if (!job.worker) return false;
    const context = job.worker.context;
    const previous = job.record.context;
    job.record.context = context ? {...context} : undefined;
    return (
      previous?.tokens !== context?.tokens ||
      previous?.window !== context?.window ||
      previous?.percent !== context?.percent
    );
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

  private dispose(job: Job): Promise<void> {
    this.captureUsage(job);
    this.captureContext(job);
    this.captureConversation(job);
    const worker = job.worker;
    job.worker = undefined;
    job.createWorker = undefined;
    job.record.resumable = false;
    if (worker) {
      const disposal = (async () => {
        try {
          await worker.dispose();
        } catch {
          // Cleanup must not strand the worker slot or session shutdown.
        }
      })();
      job.disposal = job.disposal
        ? Promise.all([job.disposal, disposal]).then(() => {})
        : disposal;
    }
    this.settleConversation(job);
    return job.disposal ?? Promise.resolve();
  }

  private disposeWhenIdle(job: Job): void {
    job.record.resumable = false;
    job.closing ??= Promise.all([
      job.operation,
      job.initializing?.catch(() => {}),
      job.interaction,
      job.cancellation,
    ]).then(() => this.dispose(job));
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
    job.stopVersion = (job.stopVersion ?? 0) + 1;
    job.worker?.clearQueue?.();
    const cancellation = job.worker?.abort?.().catch(() => {});
    if (cancellation) {
      job.cancellation = Promise.all([job.cancellation, cancellation]).then(
        () => {},
      );
    }
    if (isAgentFinished(job.record.status)) return this.get(id);
    if (job.controller) {
      job.record.status = 'cancelling';
      job.record.activity = 'Cancelling';
      job.controller.abort(new Error('Agent cancelled.'));
    } else {
      job.record.status = 'cancelled';
      job.record.activity = 'Cancelled';
      job.record.finishedAt = new Date().toISOString();
      this.settleConversation(job);
      if (job.record.autoCleanup) this.disposeWhenIdle(job);
    }
    this.changed();
    this.pump();
    return this.get(id);
  }

  private pump(): void {
    for (const job of this.jobs.values()) {
      const resume = job.resumeSlot;
      if (!resume) continue;
      if (
        this.closed ||
        job.record.status !== 'running' ||
        job.controller?.signal.aborted
      ) {
        job.resumeSlot = undefined;
        resume.resolve();
      } else if (
        !job.waiters &&
        (this.maxConcurrentAgents === 1 ||
          this.active < this.maxConcurrentAgents - 1)
      ) {
        // Existing runs can finish after switching to main-only workflows.
        job.ownsSlot = true;
        this.active++;
        job.resumeSlot = undefined;
        resume.resolve();
      }
    }
    if (this.closed) return;
    for (const job of this.jobs.values()) {
      if (this.active >= this.maxConcurrentAgents - 1) break;
      if (job.record.status !== 'queued' || job.maintaining) continue;
      this.active++;
      job.ownsSlot = true;
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
            job.stopVersion = (job.stopVersion ?? 0) + 1;
            controller.abort(
              new Error(`Timed out after ${formatDuration(timeoutMs)}.`),
            );
            this.pump();
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
          if (signal.aborted) return;
          const contextChanged = this.captureContext(job);
          if (job.record.activity === activity && !contextChanged) return;
          job.record.activity = activity;
          this.changed();
        },
        usage => {
          // Cancellation does not erase tokens the provider has already reported.
          job.record.usage = copyModelUsage(usage);
          this.captureContext(job);
          this.changed();
        },
        conversation => {
          this.captureContext(job);
          this.captureConversation(job, conversation);
          this.changed();
        },
      );
      signal.throwIfAborted();
      job.record.output = output.slice(0, 12000);
      job.record.outputTruncated = output.length > 12000 || undefined;
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
      this.captureContext(job);
      this.captureConversation(job);
      if (!this.closed && !job.closing && job.record.autoCleanup) {
        if (job.maintaining) {
          this.cancel(job.record.id);
          this.disposeWhenIdle(job);
        } else {
          await this.dispose(job);
        }
      }
      this.settleConversation(job);
      job.record.finishedAt = new Date().toISOString();
      job.controller = undefined;
      job.operation = undefined;
      if (job.ownsSlot) {
        job.ownsSlot = false;
        this.active--;
      }
      this.changed();
      this.pump();
    }
  }

  async wait(
    ids: string[],
    options: {
      mode?: 'any' | 'all';
      timeoutMs?: number;
      signal?: AbortSignal;
      /** Release this running agent's slot until the wait finishes. */
      callerId?: string;
    } = {},
  ): Promise<AgentRecord[]> {
    const uniqueIds = [...new Set(ids)];
    uniqueIds.forEach(id => this.job(id));
    const caller = options.callerId ? this.job(options.callerId) : undefined;
    if (options.callerId && uniqueIds.includes(options.callerId))
      throw new Error('An agent cannot wait for itself.');
    const {mode = 'all', timeoutMs = 60000} = options;
    const callerSignal = caller?.controller?.signal;
    const signal =
      options.signal && callerSignal
        ? AbortSignal.any([options.signal, callerSignal])
        : (options.signal ?? callerSignal);
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
      const yielded =
        caller?.record.status === 'running' &&
        !caller.controller?.signal.aborted;
      if (yielded) {
        caller.waiters = (caller.waiters ?? 0) + 1;
        if (caller.ownsSlot) {
          caller.ownsSlot = false;
          this.active--;
        }
      }
      let restored = false;
      let resuming: Promise<void> | undefined;
      const restore = () => {
        if (!yielded || restored) return;
        restored = true;
        caller.waiters!--;
        if (
          !caller.waiters &&
          caller.record.status === 'running' &&
          !caller.controller?.signal.aborted &&
          !this.closed
        ) {
          if (!caller.resumeSlot) {
            let resolve!: () => void;
            const promise = new Promise<void>(done => {
              resolve = done;
            });
            caller.resumeSlot = {promise, resolve};
          }
          resuming = caller.resumeSlot.promise;
        }
      };
      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (aborted = false) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            unsubscribe();
            signal?.removeEventListener('abort', abort);
            restore();
            this.pump();
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
          this.pump();
        });
      } finally {
        restore();
        this.pump();
        await resuming;
      }
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
        job.interaction?.catch(() => {}),
        job.cancellation,
        job.closing,
      ]),
    ).then(async () => {
      await Promise.all([...this.jobs.values()].map(job => this.dispose(job)));
      this.listeners.clear();
    });
    return this.closing;
  }
}
