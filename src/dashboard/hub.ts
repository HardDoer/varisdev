import {realpath, stat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import type {DashboardSnapshot} from './state.ts';
import {DashboardState} from './state.ts';
import {DashboardInputError} from './errors.ts';
import {readWorkspaceDiff, type WorkspaceDiff} from './workspace.ts';

export interface ParentRequest {
  cwd: string;
  name?: string;
}

export interface DashboardParent {
  state: DashboardState;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  close(): Promise<void>;
}

export type ParentFactory = (
  request: ParentRequest,
) => Promise<DashboardParent>;

export interface ExternalSessionControl {
  prompt(id: string, prompt: string): Promise<void>;
  abort(id: string): Promise<void>;
}

interface Headquarters {
  state: DashboardState;
  parent?: DashboardParent;
  pending: string[];
  running?: Promise<void>;
  stopping: boolean;
  unsubscribe: () => void;
}

export interface DashboardHubSnapshot {
  selectedSessionId?: string;
  launchCwd: string;
  sessions: Array<
    DashboardSnapshot & {
      session: DashboardSnapshot['session'] & {
        owned: boolean;
        controllable: boolean;
        pendingPrompts: number;
      };
    }
  >;
}

function fields(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DashboardInputError('Expected a JSON object.');
  }
  return input as Record<string, unknown>;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new DashboardInputError(
      `${label} must contain 1 to ${max} characters.`,
    );
  }
  return value.trim();
}

/** Owns parent conversations started in the desktop factory. */
export class DashboardHub {
  private readonly sessions = new Map<string, Headquarters>();
  private readonly listeners = new Set<() => void>();
  private readonly creating = new Set<Promise<DashboardParent>>();
  private readonly selectedSessionId?: string;
  private external?: DashboardSnapshot;
  private externalControl?: ExternalSessionControl;
  private externalPendingPrompts = 0;
  private readonly launchCwd: string;
  private readonly factory: ParentFactory;
  private closed = false;
  private closing?: Promise<void>;

  constructor(
    initial: DashboardState | undefined,
    factory: ParentFactory,
    launchCwd = process.cwd(),
  ) {
    const session = initial?.snapshot().session;
    this.selectedSessionId = session?.id;
    this.launchCwd = session?.cwd ?? launchCwd;
    this.factory = factory;
    if (initial) this.add(initial);
  }

  updateExternal(snapshot: DashboardSnapshot, pendingPrompts = 0): void {
    if (this.closed) return;
    this.external = structuredClone(snapshot);
    this.externalPendingPrompts =
      Number.isInteger(pendingPrompts) &&
      pendingPrompts >= 0 &&
      pendingPrompts <= 32
        ? pendingPrompts
        : 0;
    this.changed();
  }

  setExternalControl(control: ExternalSessionControl | undefined): void {
    if (this.closed) return;
    this.externalControl = control;
    this.changed();
  }

  closeExternal(): void {
    this.externalControl = undefined;
    this.externalPendingPrompts = 0;
    if (!this.external) return;
    this.external.session.status = 'closed';
    this.external.session.activity = 'Terminal disconnected';
    this.changed();
  }

  private add(state: DashboardState, parent?: DashboardParent): Headquarters {
    const entry: Headquarters = {
      state,
      parent,
      pending: [],
      stopping: false,
      unsubscribe: state.subscribe(() => this.changed()),
    };
    this.sessions.set(state.snapshot().session.id, entry);
    this.changed();
    return entry;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  snapshot(): DashboardHubSnapshot {
    return {
      selectedSessionId:
        this.selectedSessionId ??
        this.external?.session.id ??
        this.sessions.keys().next().value,
      launchCwd: this.launchCwd,
      sessions: [
        ...(this.external
          ? [
              {
                ...structuredClone(this.external),
                session: {
                  ...this.external.session,
                  owned: false,
                  controllable:
                    !!this.externalControl &&
                    this.external.session.status !== 'closed',
                  pendingPrompts: this.externalPendingPrompts,
                },
              },
            ]
          : []),
        ...[...this.sessions.values()].map(entry => {
          const snapshot = entry.state.snapshot();
          return {
            ...snapshot,
            session: {
              ...snapshot.session,
              owned: !!entry.parent,
              controllable:
                !!entry.parent && snapshot.session.status !== 'closed',
              pendingPrompts: entry.pending.length,
            },
          };
        }),
      ],
    };
  }

  async workspace(id: string): Promise<WorkspaceDiff> {
    this.ensureOpen();
    if (this.external?.session.id === id)
      return readWorkspaceDiff(this.external.session.cwd);
    const entry = this.sessions.get(id);
    if (!entry) throw new DashboardInputError('Unknown parent session.');
    return readWorkspaceDiff(entry.state.snapshot().session.cwd);
  }

  private ensureOpen(): void {
    if (this.closed) throw new DashboardInputError('The dashboard has closed.');
  }

  async createSession(input: unknown): Promise<{id: string}> {
    this.ensureOpen();
    const values = fields(input);
    const prompt = text(values.prompt, 'Prompt', 64000);
    const path = text(values.cwd, 'Folder', 4096);
    if (!isAbsolute(path))
      throw new DashboardInputError('Choose an absolute folder path.');
    const name =
      values.name === undefined || values.name === ''
        ? undefined
        : text(values.name, 'Name', 120);
    let cwd: string;
    try {
      cwd = await realpath(path);
      if (!(await stat(cwd)).isDirectory())
        throw new DashboardInputError('Not a directory');
    } catch {
      throw new DashboardInputError(
        'The folder does not exist or is not a directory.',
      );
    }
    this.ensureOpen();
    const owned = [...this.sessions.values()].filter(
      entry => entry.parent,
    ).length;
    if (owned + this.creating.size >= 8) {
      throw new DashboardInputError(
        'The factory can hold eight parent sessions.',
      );
    }
    const creation = Promise.resolve().then(async () => {
      const parent = await this.factory({cwd, name});
      if (this.closed) {
        await parent.close();
        throw new DashboardInputError(
          'The dashboard closed while starting the session.',
        );
      }
      return parent;
    });
    this.creating.add(creation);
    try {
      const parent = await creation;
      if (this.closed) {
        await parent.close();
        throw new DashboardInputError(
          'The dashboard closed while starting the session.',
        );
      }
      const entry = this.add(parent.state, parent);
      this.enqueue(entry, prompt);
      return {id: parent.state.snapshot().session.id};
    } finally {
      this.creating.delete(creation);
    }
  }

  private owned(id: string): Headquarters & {parent: DashboardParent} {
    this.ensureOpen();
    if (this.external?.session.id === id)
      throw new DashboardInputError('Continue this session in its terminal.');
    const entry = this.sessions.get(id);
    if (!entry) throw new DashboardInputError('Unknown parent session.');
    if (!entry.parent)
      throw new DashboardInputError('Continue this session in its terminal.');
    if (entry.stopping)
      throw new DashboardInputError(
        'This session is stopping. Try again when it is idle.',
      );
    return entry as Headquarters & {parent: DashboardParent};
  }

  private attached(id: string): ExternalSessionControl | undefined {
    this.ensureOpen();
    if (this.external?.session.id !== id) return;
    if (!this.externalControl || this.external.session.status === 'closed')
      throw new DashboardInputError(
        'This Pi session is no longer connected. Reopen the factory from Pi.',
      );
    return this.externalControl;
  }

  async promptSession(id: string, input: unknown): Promise<void> {
    const prompt = text(fields(input).prompt, 'Prompt', 64000);
    const attached = this.attached(id);
    if (attached) return attached.prompt(id, prompt);
    const entry = this.owned(id);
    if (entry.pending.length >= 32)
      throw new DashboardInputError(
        'This session already has 32 queued prompts.',
      );
    this.enqueue(entry, prompt);
  }

  private enqueue(entry: Headquarters, prompt: string): void {
    entry.pending.push(prompt);
    entry.state.record('message', `Prompt queued: ${prompt}`);
    // Reserve the runner before calling prompt: SDK preflight is asynchronous.
    if (!entry.running) {
      entry.running = Promise.resolve().then(async () => {
        try {
          while (!this.closed && !entry.stopping && entry.pending.length) {
            const next = entry.pending.shift()!;
            entry.state.updateSession({
              status: 'running',
              activity: 'Starting task',
              prompt: next,
              response: '',
              error: undefined,
            });
            try {
              await entry.parent!.prompt(next);
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              entry.state.updateSession({
                status: 'idle',
                activity: `Error: ${message.slice(0, 1000)}`,
                error: message.slice(0, 4000),
              });
              entry.state.record('error', message);
            }
          }
        } finally {
          entry.running = undefined;
          this.changed();
        }
      });
    }
    this.changed();
  }

  async abortSession(id: string): Promise<void> {
    const attached = this.attached(id);
    if (attached) return attached.abort(id);
    const entry = this.owned(id);
    entry.stopping = true;
    entry.pending.length = 0;
    entry.state.updateSession({activity: 'Stopping'});
    try {
      await entry.parent.abort();
      await entry.running;
      entry.state.updateSession({status: 'idle', activity: 'Stopped'});
      entry.state.record('session', 'Parent stopped; queued prompts cleared');
    } finally {
      entry.stopping = false;
      this.changed();
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.externalControl = undefined;
    for (const entry of this.sessions.values()) {
      entry.stopping = true;
      entry.pending.length = 0;
      entry.unsubscribe();
    }
    this.listeners.clear();
    this.closing = (async () => {
      await Promise.allSettled(
        [...this.sessions.values()].map(async entry => {
          await entry.parent?.close();
          await entry.running;
        }),
      );
      // A concurrently created parent is disposed by createSession before it can run.
      await Promise.allSettled([...this.creating]);
    })();
    return this.closing;
  }
}
