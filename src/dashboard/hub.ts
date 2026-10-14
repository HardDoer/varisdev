import type {ImageContent} from '@earendil-works/pi-ai';
import {realpath, stat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import type {DashboardSnapshot} from './state.ts';
import {DashboardState} from './state.ts';
import {DashboardInputError} from './errors.ts';
import {readWorkspaceDiff, type WorkspaceDiff} from './workspace.ts';
import type {SessionFeatures, SessionConfiguration} from './features.ts';
import type {DesktopExtensionUI, DesktopUIState} from './extension-ui.ts';

export interface ParentRequest {
  cwd: string;
  name?: string;
}

export interface DashboardParent {
  state: DashboardState;
  ui?: DesktopExtensionUI;
  prompt(text: string, images?: ImageContent[]): Promise<void>;
  abort(): Promise<void>;
  close(): Promise<void>;
  features(): Promise<SessionFeatures>;
  configure(input: SessionConfiguration): Promise<void>;
  compact(instructions?: string): Promise<void>;
  reload(): Promise<void>;
}

export type ParentFactory = (
  request: ParentRequest,
) => Promise<DashboardParent>;

export interface ExternalSessionControl {
  prompt(id: string, prompt: string): Promise<void>;
  abort(id: string): Promise<void>;
  features(id: string): Promise<SessionFeatures>;
  configure(id: string, input: SessionConfiguration): Promise<void>;
  compact(id: string, instructions?: string): Promise<void>;
  reload(id: string): Promise<void>;
}

interface Headquarters {
  state: DashboardState;
  parent?: DashboardParent;
  running: Set<Promise<void>>;
  stopping: boolean;
  maintaining: boolean;
  unsubscribe: () => void;
}

export interface DashboardHubSnapshot {
  selectedSessionId?: string;
  launchCwd: string;
  sessions: Array<
    DashboardSnapshot & {
      ui?: DesktopUIState;
      session: DashboardSnapshot['session'] & {
        owned: boolean;
        controllable: boolean;
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

export function sessionConfiguration(input: unknown): SessionConfiguration {
  const values = fields(input);
  if (
    Object.keys(values).some(
      key => !['provider', 'modelId', 'thinkingLevel'].includes(key),
    )
  )
    throw new DashboardInputError('Unknown session setting.');
  const result: SessionConfiguration = {};
  if (values.provider !== undefined || values.modelId !== undefined) {
    result.provider = text(values.provider, 'Provider', 256);
    result.modelId = text(values.modelId, 'Model', 256);
  }
  if (values.thinkingLevel !== undefined)
    result.thinkingLevel = text(values.thinkingLevel, 'Thinking level', 32);
  if (!Object.keys(result).length)
    throw new DashboardInputError('Choose a model or thinking level.');
  return result;
}

export function compactionInstructions(input: unknown): string | undefined {
  if (input === undefined || input === '') return;
  return text(input, 'Compaction instructions', 64000);
}

/** Owns parent conversations started in the desktop factory. */
export class DashboardHub {
  private readonly sessions = new Map<string, Headquarters>();
  private readonly listeners = new Set<() => void>();
  private readonly creating = new Set<Promise<DashboardParent>>();
  private readonly selectedSessionId?: string;
  private external?: DashboardSnapshot;
  private externalControl?: ExternalSessionControl;
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

  updateExternal(snapshot: DashboardSnapshot): void {
    if (this.closed) return;
    this.external = structuredClone(snapshot);
    this.changed();
  }

  setExternalControl(control: ExternalSessionControl | undefined): void {
    if (this.closed) return;
    this.externalControl = control;
    this.changed();
  }

  closeExternal(): void {
    this.externalControl = undefined;
    if (!this.external) return;
    this.external.session.status = 'closed';
    this.external.session.activity = 'Terminal disconnected';
    this.changed();
  }

  private add(state: DashboardState, parent?: DashboardParent): Headquarters {
    const entry: Headquarters = {
      state,
      parent,
      running: new Set(),
      stopping: false,
      maintaining: false,
      unsubscribe: state.subscribe(() => this.changed()),
    };
    this.sessions.set(state.snapshot().session.id, entry);
    this.changed();
    return entry;
  }

  private refresh(entry: Headquarters): void {
    if (this.closed || !entry.parent || entry.parent.state === entry.state)
      return;
    const previousId = entry.state.snapshot().session.id;
    entry.unsubscribe();
    entry.state = entry.parent.state;
    entry.unsubscribe = entry.state.subscribe(() => this.changed());
    const nextId = entry.state.snapshot().session.id;
    if (nextId !== previousId) {
      this.sessions.delete(previousId);
      this.sessions.set(nextId, entry);
    }
    this.changed();
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
                  ...structuredClone(this.external.session),
                  owned: false,
                  controllable:
                    !!this.externalControl &&
                    this.external.session.status !== 'closed',
                },
              },
            ]
          : []),
        ...[...this.sessions.values()].map(entry => {
          const snapshot = entry.state.snapshot();
          return {
            ...snapshot,
            ...(entry.parent?.ui
              ? {ui: structuredClone(entry.parent.ui.snapshot())}
              : {}),
            session: {
              ...snapshot.session,
              owned: !!entry.parent,
              controllable:
                !!entry.parent && snapshot.session.status !== 'closed',
            },
          };
        }),
      ],
    };
  }

  /** Adopt the idle CLI session as a native desktop parent. */
  adoptSession(
    parent: DashboardParent,
    prompts: Array<{text: string; images?: ImageContent[]}> = [],
  ): void {
    this.ensureOpen();
    const id = parent.state.snapshot().session.id;
    if (this.sessions.has(id))
      throw new DashboardInputError('This session is already open.');
    const entry = this.add(parent.state, parent);
    // CLI arguments are an invocation script, executed in Pi's original order.
    // Interactive messages still go straight to native steering while it runs.
    const startup = Promise.resolve()
      .then(async () => {
        for (const prompt of prompts) {
          if (this.closed || entry.stopping) break;
          await this.submit(entry, prompt.text, prompt.images);
        }
      })
      .finally(() => {
        entry.running.delete(startup);
        this.changed();
      });
    entry.running.add(startup);
    this.changed();
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
      this.add(parent.state, parent);
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

  async respondToDialog(
    id: string,
    dialogId: unknown,
    value?: unknown,
  ): Promise<void> {
    if (typeof dialogId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(dialogId))
      throw new DashboardInputError('Choose a valid extension dialog.');
    if (
      value !== undefined &&
      typeof value !== 'boolean' &&
      (typeof value !== 'string' || value.length > 262144)
    )
      throw new DashboardInputError('Invalid extension dialog response.');
    const parent = this.owned(id).parent;
    if (!parent.ui)
      throw new DashboardInputError(
        'Extension dialogs are unavailable in this session.',
      );
    const ui = parent.ui.snapshot();
    const dialog = ui.dialogs[0];
    const editor =
      ui.editor?.id === dialogId || ui.extensionEditor?.id === dialogId;
    if (!editor && dialog?.id !== dialogId)
      throw new DashboardInputError(
        'This extension dialog is no longer waiting for a response.',
      );
    if (value !== undefined) {
      const expectedType =
        !editor && dialog?.kind === 'confirm' ? 'boolean' : 'string';
      if (typeof value !== expectedType)
        throw new DashboardInputError('Invalid extension dialog response.');
      if (
        !editor &&
        dialog?.kind === 'select' &&
        !dialog.options?.includes(value as string)
      )
        throw new DashboardInputError(
          'Choose one of the extension dialog options.',
        );
    }
    parent.ui.respond(dialogId, value as string | boolean | undefined);
  }

  async sessionFeatures(id: string): Promise<SessionFeatures> {
    const attached = this.attached(id);
    const features = attached
      ? await attached.features(id)
      : await this.owned(id).parent.features();
    return structuredClone(features);
  }

  private async maintain(
    id: string,
    action: (parent: DashboardParent) => Promise<void>,
    allowRunning = false,
  ): Promise<void> {
    const entry = this.owned(id);
    const status = entry.state.snapshot().session.status;
    if (
      entry.maintaining ||
      status === 'compacting' ||
      status === 'closed' ||
      (!allowRunning && (entry.running.size || status !== 'idle'))
    )
      throw new DashboardInputError('Wait until this session is idle.');
    entry.maintaining = true;
    try {
      await action(entry.parent);
    } finally {
      entry.maintaining = false;
      this.refresh(entry);
      this.changed();
    }
  }

  async configureSession(id: string, input: unknown): Promise<void> {
    const configuration = sessionConfiguration(input);
    const attached = this.attached(id);
    if (attached) return attached.configure(id, configuration);
    await this.maintain(id, parent => parent.configure(configuration), true);
  }

  async compactSession(id: string, input?: unknown): Promise<void> {
    const instructions = compactionInstructions(input);
    const attached = this.attached(id);
    if (attached) return attached.compact(id, instructions);
    await this.maintain(id, parent => parent.compact(instructions));
  }

  async reloadSession(id: string): Promise<void> {
    const attached = this.attached(id);
    if (attached) return attached.reload(id);
    await this.maintain(id, parent => parent.reload());
  }

  async promptSession(id: string, input: unknown): Promise<void> {
    const prompt = text(fields(input).prompt, 'Prompt', 64000);
    const attached = this.attached(id);
    if (attached) return attached.prompt(id, prompt);
    const entry = this.owned(id);
    if (entry.maintaining)
      throw new DashboardInputError(
        'This session is updating. Try again when it is idle.',
      );
    void this.submit(entry, prompt);
  }

  private submit(
    entry: Headquarters,
    prompt: string,
    images?: ImageContent[],
  ): Promise<void> {
    entry.state.record('message', prompt);
    const operation = entry
      .parent!.prompt(prompt, images)
      .catch(error => {
        if (this.closed || entry.stopping) return;
        const message = error instanceof Error ? error.message : String(error);
        entry.state.updateSession({
          activity: 'Error: ' + message.slice(0, 1000),
          error: message.slice(0, 4000),
        });
        entry.state.record('error', message);
      })
      .finally(() => {
        entry.running.delete(operation);
        this.refresh(entry);
        this.changed();
      });
    entry.running.add(operation);
    this.changed();
    return operation;
  }

  async abortSession(id: string): Promise<void> {
    const attached = this.attached(id);
    if (attached) return attached.abort(id);
    const entry = this.owned(id);
    entry.stopping = true;
    entry.state.updateSession({activity: 'Stopping'});
    try {
      await entry.parent.abort();
      await Promise.allSettled(entry.running);
      entry.state.updateSession({status: 'idle', activity: 'Stopped'});
      entry.state.record('session', 'Parent stopped');
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
      entry.unsubscribe();
    }
    this.listeners.clear();
    this.closing = (async () => {
      await Promise.allSettled(
        [...this.sessions.values()].map(async entry => {
          await entry.parent?.close();
          await Promise.allSettled(entry.running);
        }),
      );
      // A concurrently created parent is disposed by createSession before it can run.
      await Promise.allSettled([...this.creating]);
    })();
    return this.closing;
  }
}
