import type {ImageContent} from '@earendil-works/pi-ai';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import type {DesktopStartup} from '../desktop/startup.ts';
import {
  listAgentTemplates,
  saveAgentTemplate,
  deleteAgentTemplate,
  resolveAgentTemplate,
  resolveDefaultAgentTemplate,
  type AgentTemplate,
} from '../agents/templates.ts';
import {realpath, stat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import type {DashboardSnapshot} from './state.ts';
import {DashboardState} from './state.ts';
import {DashboardInputError} from './errors.ts';
import {workspaceConfigurationDirectory} from './workspace-config.ts';
import {nativeCommand, parseSlashCommand} from './command-catalog.mjs';
import {readWorkspaceDiff, type WorkspaceDiff} from './workspace.ts';
import type {SessionFeatures, SessionConfiguration} from './features.ts';
import type {DesktopExtensionUI, DesktopUIState} from './extension-ui.ts';
import {
  readMarkdownFile,
  saveMarkdownFile,
  type MarkdownFile,
} from './markdown-files.ts';

export interface ParentRequest {
  cwd: string;
  name?: string;
  instructions?: string;
  model?: string;
  thinkingLevel?: string;
  agentProfile?: AgentTemplate;
  resume?: {id: string; path: string};
}

export interface SavedSession {
  id: string;
  name?: string;
  firstMessage: string;
  modified: string;
  messageCount: number;
}

export interface StartedSession {
  id: string;
}

export type StoppedMessages = NonNullable<DashboardSnapshot['queue']>;

export type AgentSessionRequest = {agentId: string} & (
  | {action: 'prompt'; prompt: string}
  | {action: 'configure'; configuration: SessionConfiguration}
  | {action: 'command'; command: string}
  | {action: 'compact'; instructions?: string}
  | {action: 'abort' | 'features' | 'reload' | 'close'}
);

export type AgentSessionResult = void | SessionFeatures | StoppedMessages;

export interface DashboardParent {
  state: DashboardState;
  ui?: DesktopExtensionUI;
  prompt(text: string, images?: ImageContent[]): Promise<void>;
  abort(): Promise<StoppedMessages>;
  restartSnapshot(): DesktopStartup;
  cancelAgent(agentId: string): Promise<void>;
  agentSession?(request: AgentSessionRequest): Promise<AgentSessionResult>;
  close(): Promise<void>;
  features(): Promise<SessionFeatures>;
  configure(input: SessionConfiguration): Promise<void>;
  compact(instructions?: string): Promise<void>;
  reload(): Promise<void>;
  lastAssistantText?(): string | undefined;
}

export type ParentFactory = (
  request: ParentRequest,
) => Promise<DashboardParent>;

export interface ExternalSessionControl {
  prompt(id: string, prompt: string): Promise<void>;
  abort(id: string): Promise<StoppedMessages>;
  cancelAgent(id: string, agentId: string): Promise<void>;
  agentSession?(
    id: string,
    request: AgentSessionRequest,
  ): Promise<AgentSessionResult>;
  features(id: string): Promise<SessionFeatures>;
  configure(id: string, input: SessionConfiguration): Promise<void>;
  compact(id: string, instructions?: string): Promise<void>;
  reload(id: string): Promise<void>;
}

interface Headquarters {
  state: DashboardState;
  parent?: DashboardParent;
  running: Set<Promise<void>>;
  pending: Set<Promise<unknown>>;
  stopping: boolean;
  closing: boolean;
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

export function agentCancellationId(input: unknown): string {
  return text(input, 'Agent ID', 128);
}

export function sessionConfiguration(input: unknown): SessionConfiguration {
  const values = fields(input);
  if (
    Object.keys(values).some(
      key => !['provider', 'modelId', 'thinkingLevel', 'persist'].includes(key),
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
  if (values.persist !== undefined) {
    if (typeof values.persist !== 'boolean')
      throw new DashboardInputError('Persist must be a boolean.');
    result.persist = values.persist;
  }
  return result;
}

export function compactionInstructions(input: unknown): string | undefined {
  if (input === undefined || input === '') return;
  return text(input, 'Compaction instructions', 64000);
}

export function agentSessionRequest(input: unknown): AgentSessionRequest {
  const values = fields(input);
  const agentId = agentCancellationId(values.agentId);
  if (agentId === 'all')
    throw new DashboardInputError('Choose one agent conversation.');
  const action = values.action;
  const allowed =
    action === 'prompt'
      ? ['prompt']
      : action === 'configure'
        ? ['configuration']
        : action === 'command'
          ? ['command']
          : action === 'compact'
            ? ['instructions']
            : [];
  if (
    ![
      'prompt',
      'abort',
      'features',
      'configure',
      'command',
      'compact',
      'reload',
      'close',
    ].includes(action as string)
  )
    throw new DashboardInputError('Unknown agent conversation action.');
  if (
    Object.keys(values).some(
      key => !['agentId', 'action', ...allowed].includes(key),
    )
  )
    throw new DashboardInputError('Unknown agent conversation field.');
  if (action === 'prompt')
    return {agentId, action, prompt: text(values.prompt, 'Prompt', 64000)};
  if (action === 'configure')
    return {
      agentId,
      action,
      configuration: sessionConfiguration(values.configuration),
    };
  if (action === 'command')
    return {agentId, action, command: text(values.command, 'Command', 64000)};
  if (action === 'compact')
    return {
      agentId,
      action,
      instructions: compactionInstructions(values.instructions),
    };
  return {agentId, action: action as 'abort' | 'features' | 'reload' | 'close'};
}

async function sessionFolder(input: unknown): Promise<string> {
  const path = text(input, 'Folder', 4096);
  if (!isAbsolute(path))
    throw new DashboardInputError('Choose an absolute folder path.');
  try {
    const cwd = await realpath(path);
    if ((await stat(cwd)).isDirectory()) return cwd;
  } catch {
    // Report missing and inaccessible folders through the same input error.
  }
  throw new DashboardInputError(
    'The folder does not exist or is not a directory.',
  );
}

/** Owns parent conversations started in the desktop factory. */
export class DashboardHub {
  private readonly sessions = new Map<string, Headquarters>();
  private readonly listeners = new Set<() => void>();
  private readonly creating = new Set<Promise<DashboardParent>>();
  private readonly creationCredits = new Map<
    Promise<DashboardParent>,
    number
  >();
  private readonly resuming = new Map<string, Promise<StartedSession>>();
  private readonly resumeFolders = new Map<string, Promise<void>>();
  private readonly closingSessions = new Map<string, Promise<void>>();
  private readonly dismissedExternalSessions = new Set<string>();
  private readonly selectedSessionId?: string;
  private external?: DashboardSnapshot;
  private externalControl?: ExternalSessionControl;
  private readonly launchCwd: string;
  private readonly factory: ParentFactory;
  private cachedSnapshot?: DashboardHubSnapshot;
  private closed = false;
  private closing?: Promise<void>;

  constructor(
    initial: DashboardState | undefined,
    factory: ParentFactory,
    launchCwd = process.cwd(),
  ) {
    const session = initial?.deliverySnapshot().session;
    this.selectedSessionId = session?.id;
    this.launchCwd = session?.cwd ?? launchCwd;
    this.factory = factory;
    if (initial) this.add(initial);
  }

  updateExternal(snapshot: DashboardSnapshot, copy = true): void {
    if (
      this.closed ||
      this.dismissedExternalSessions.has(snapshot.session.id) ||
      this.sessions.has(snapshot.session.id)
    )
      return;
    this.external = copy ? structuredClone(snapshot) : snapshot;
    this.changed();
  }

  setExternalControl(control: ExternalSessionControl | undefined): void {
    if (this.closed || this.externalControl === control) return;
    this.externalControl = control;
    this.changed();
  }

  closeExternal(): void {
    this.externalControl = undefined;
    if (!this.external) return;
    this.external = {
      ...this.external,
      session: {
        ...this.external.session,
        status: 'closed',
        activity: 'Terminal disconnected',
      },
    };
    this.changed();
  }

  private add(state: DashboardState, parent?: DashboardParent): Headquarters {
    const entry: Headquarters = {
      state,
      parent,
      running: new Set(),
      pending: new Set(),
      stopping: false,
      closing: false,
      maintaining: false,
      unsubscribe: state.subscribe(() => this.changed()),
    };
    this.sessions.set(state.deliverySnapshot().session.id, entry);
    this.changed();
    return entry;
  }

  private has(entry: Headquarters): boolean {
    return [...this.sessions.values()].includes(entry);
  }

  private refresh(entry: Headquarters): void {
    if (
      this.closed ||
      !this.has(entry) ||
      entry.closing ||
      !entry.parent ||
      entry.parent.state === entry.state
    )
      return;
    const previousId = entry.state.deliverySnapshot().session.id;
    entry.unsubscribe();
    entry.state = entry.parent.state;
    entry.unsubscribe = entry.state.subscribe(() => this.changed());
    const nextId = entry.state.deliverySnapshot().session.id;
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
    this.cachedSnapshot = undefined;
    for (const listener of this.listeners) listener();
  }

  /** A cached snapshot for immediate IPC serialization. Do not mutate it. */
  deliverySnapshot(): DashboardHubSnapshot {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    const sessions: DashboardHubSnapshot['sessions'] = [
      ...(this.external
        ? [
            {
              ...this.external,
              session: {
                ...this.external.session,
                owned: false,
                controllable:
                  !!this.externalControl &&
                  this.external.session.status !== 'closed',
              },
            },
          ]
        : []),
      ...[...this.sessions.values()].map(entry => {
        const snapshot = entry.state.deliverySnapshot();
        return {
          ...snapshot,
          ...(entry.parent?.ui
            ? {ui: structuredClone(entry.parent.ui.snapshot())}
            : {}),
          session: {
            ...snapshot.session,
            ...(entry.closing ? {activity: 'Closing'} : {}),
            owned: !!entry.parent,
            controllable:
              !!entry.parent &&
              !entry.closing &&
              snapshot.session.status !== 'closed',
          },
        };
      }),
    ];
    return (this.cachedSnapshot = {
      selectedSessionId: sessions.some(
        item => item.session.id === this.selectedSessionId,
      )
        ? this.selectedSessionId
        : sessions[0]?.session.id,
      launchCwd: this.launchCwd,
      sessions,
    });
  }

  snapshot(): DashboardHubSnapshot {
    return structuredClone(this.deliverySnapshot());
  }

  /** Adopt the idle CLI session as a native desktop parent. */
  adoptSession(
    parent: DashboardParent,
    prompts: Array<{text: string; images?: ImageContent[]}> = [],
  ): void {
    this.ensureOpen();
    const id = parent.state.deliverySnapshot().session.id;
    if (this.sessions.has(id))
      throw new DashboardInputError('This session is already open.');
    this.dismissedExternalSessions.delete(id);
    if (this.external?.session.id === id) this.external = undefined;
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
        entry.pending.delete(startup);
        if (this.has(entry)) this.changed();
      });
    entry.running.add(startup);
    entry.pending.add(startup);
    this.changed();
  }

  async workspace(id: string): Promise<WorkspaceDiff> {
    this.ensureOpen();
    if (this.external?.session.id === id)
      return readWorkspaceDiff(this.external.session.cwd);
    const entry = this.sessions.get(id);
    if (!entry) throw new DashboardInputError('Unknown workspace.');
    return readWorkspaceDiff(entry.state.deliverySnapshot().session.cwd);
  }

  private markdownCwd(id: string): string {
    this.ensureOpen();
    if (typeof id !== 'string' || !id || id.length > 256)
      throw new DashboardInputError('Choose a valid workspace.');
    if (this.external?.session.id === id) return this.external.session.cwd;
    const entry = this.sessions.get(id);
    if (!entry) throw new DashboardInputError('Unknown workspace.');
    return entry.state.deliverySnapshot().session.cwd;
  }

  async readMarkdown(id: string, path: unknown): Promise<MarkdownFile> {
    return readMarkdownFile(this.markdownCwd(id), path);
  }

  async saveMarkdown(
    id: string,
    path: unknown,
    content: unknown,
    version: unknown,
  ): Promise<MarkdownFile> {
    return saveMarkdownFile(this.markdownCwd(id), path, content, version);
  }

  private ensureOpen(): void {
    if (this.closed) throw new DashboardInputError('The dashboard has closed.');
  }

  async listSessions(input: unknown): Promise<SavedSession[]> {
    this.ensureOpen();
    const cwd = await sessionFolder(input);
    const sessions = await SessionManager.list(cwd);
    return sessions.map(session => ({
      id: session.id,
      name: session.name,
      firstMessage: session.firstMessage.slice(0, 500),
      modified: session.modified.toISOString(),
      messageCount: session.messageCount,
    }));
  }

  async workspaceConfigurationFolder(input: unknown): Promise<string> {
    this.ensureOpen();
    return workspaceConfigurationDirectory(await sessionFolder(input));
  }

  async listAgentTemplates(input: unknown) {
    this.ensureOpen();
    const cwd = await sessionFolder(input);
    return listAgentTemplates(cwd);
  }

  async saveAgentTemplate(folder: unknown, input: unknown) {
    this.ensureOpen();
    const cwd = await sessionFolder(folder);
    const values = fields(input);
    return saveAgentTemplate(cwd, values);
  }

  async deleteAgentTemplate(folder: unknown, input: unknown): Promise<void> {
    this.ensureOpen();
    const cwd = await sessionFolder(folder);
    const values = fields(input);
    if (Object.keys(values).some(key => !['scope', 'id'].includes(key)))
      throw new DashboardInputError('Unknown agent template field.');
    await deleteAgentTemplate(cwd, values);
  }

  async createSession(input: unknown): Promise<StartedSession> {
    this.ensureOpen();
    const values = fields(input);
    const cwd = await sessionFolder(values.cwd);
    if (values.sessionId !== undefined && values.templateId !== undefined)
      throw new DashboardInputError('Templates apply to new conversations.');
    if (values.sessionId !== undefined) {
      const id = text(values.sessionId, 'Session ID', 128);
      const saved = (await SessionManager.list(cwd)).find(
        item => item.id === id,
      );
      if (!saved)
        throw new DashboardInputError(
          'This saved session is no longer available in this folder.',
        );
      this.ensureOpen();
      const key = `${cwd}\0${id}`;
      const pending = this.resuming.get(key);
      if (pending) return pending;
      const opening = this.inResumeFolder(cwd, async () => {
        const closing = this.closingSessions.get(id);
        if (closing) {
          try {
            await closing;
          } catch {
            throw new DashboardInputError(
              'This session did not close. Retry closing it before reopening.',
            );
          }
          this.ensureOpen();
        }
        const opened = this.deliverySnapshot().sessions.find(
          item => item.session.id === id && item.session.status !== 'closed',
        );
        const replacements = await this.resumeReplacements(cwd, id);
        if (opened) {
          const results = await Promise.allSettled(
            replacements.map(replacement => this.closeReplacement(replacement)),
          );
          const failure = results.find(result => result.status === 'rejected');
          if (failure?.status === 'rejected') throw failure.reason;
          return {id};
        }
        return this.startSession(
          {cwd, resume: {id, path: saved.path}},
          replacements,
        );
      });
      this.resuming.set(key, opening);
      try {
        return await opening;
      } finally {
        if (this.resuming.get(key) === opening) this.resuming.delete(key);
      }
    }
    const name =
      values.name === undefined || values.name === ''
        ? undefined
        : text(values.name, 'Name', 120);
    const explicit = values.templateId !== undefined;
    const template = explicit
      ? await resolveAgentTemplate(cwd, values.templateId)
      : await resolveDefaultAgentTemplate(cwd, 'primary');
    if (!template || template.disabled)
      throw new DashboardInputError('This agent profile is unavailable.');
    if (template.mode === 'subagent')
      throw new DashboardInputError(
        'Choose an agent that supports primary use.',
      );
    return this.startSession({
      cwd,
      name,
      agentProfile: structuredClone(template),
    });
  }

  private async inResumeFolder<T>(
    cwd: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.resumeFolders.get(cwd);
    const released = Promise.withResolvers<void>();
    const queued = (previous ?? Promise.resolve())
      .catch(() => {})
      .then(() => released.promise);
    this.resumeFolders.set(cwd, queued);
    if (previous) await previous.catch(() => {});
    try {
      this.ensureOpen();
      return await action();
    } finally {
      released.resolve();
      if (this.resumeFolders.get(cwd) === queued)
        this.resumeFolders.delete(cwd);
    }
  }

  private async resumeReplacements(
    cwd: string,
    targetId: string,
  ): Promise<
    Array<{id: string; entry?: Headquarters; external?: DashboardSnapshot}>
  > {
    const replacements: Array<{
      id: string;
      entry?: Headquarters;
      external?: DashboardSnapshot;
    }> = [];
    const sameFolder = async (path: string): Promise<boolean> => {
      if (path === cwd) return true;
      try {
        return (await realpath(path)) === cwd;
      } catch {
        return false;
      }
    };
    if (
      this.external?.session.id !== targetId &&
      this.external &&
      (await sameFolder(this.external.session.cwd))
    )
      replacements.push({
        id: this.external.session.id,
        external: this.external,
      });
    for (const [id, entry] of this.sessions) {
      if (
        id !== targetId &&
        (await sameFolder(entry.state.deliverySnapshot().session.cwd))
      )
        replacements.push({id, entry});
    }
    return replacements;
  }

  private async closeReplacement(replacement: {
    id: string;
    entry?: Headquarters;
    external?: DashboardSnapshot;
  }): Promise<boolean> {
    if (replacement.entry) {
      if (this.sessions.get(replacement.id) !== replacement.entry) return false;
      await this.closeSession(replacement.id);
      return this.sessions.get(replacement.id) !== replacement.entry;
    }
    if (this.external !== replacement.external) return false;
    await this.closeSession(replacement.id);
    return this.external !== replacement.external;
  }

  private async startSession(
    request: ParentRequest,
    replacements: Array<{
      id: string;
      entry?: Headquarters;
      external?: DashboardSnapshot;
    }> = [],
  ): Promise<StartedSession> {
    this.ensureOpen();
    const owned = [...this.sessions.values()].filter(
      entry => entry.parent,
    ).length;
    const reservedCredits = [...this.creationCredits.values()].reduce(
      (total, credit) => total + credit,
      0,
    );
    const replacementCredit = replacements.some(
      replacement => replacement.entry?.parent,
    )
      ? 1
      : 0;
    if (owned + this.creating.size - reservedCredits - replacementCredit >= 8) {
      throw new DashboardInputError('The factory can hold eight workspaces.');
    }
    const creation = Promise.resolve().then(async () => {
      const parent = await this.factory(request);
      if (this.closed) {
        await parent.close();
        throw new DashboardInputError(
          'The dashboard closed while starting the session.',
        );
      }
      return parent;
    });
    this.creating.add(creation);
    this.creationCredits.set(creation, replacementCredit);
    try {
      const parent = await creation;
      if (this.closed) {
        await parent.close();
        throw new DashboardInputError(
          'The dashboard closed while starting the session.',
        );
      }
      const id = parent.state.deliverySnapshot().session.id;
      if (this.sessions.has(id) || this.external?.session.id === id) {
        await parent.close();
        // A concurrent adoption/open of the requested saved session wins.
        if (request.resume?.id === id) return {id};
        throw new DashboardInputError('This session is already open.');
      }

      const results = await Promise.allSettled(
        replacements.map(replacement => this.closeReplacement(replacement)),
      );
      const replacementFailure = results.find(
        result => result.status === 'rejected',
      );
      if (this.closed) {
        await parent.close();
        throw new DashboardInputError(
          'The dashboard closed while starting the session.',
        );
      }
      if (replacementFailure?.status === 'rejected') {
        await parent.close();
        throw replacementFailure.reason;
      }
      const remainingOwned = [...this.sessions.values()].filter(
        entry => entry.parent,
      ).length;
      if (remainingOwned >= 8) {
        await parent.close();
        throw new DashboardInputError('The factory can hold eight workspaces.');
      }
      if (this.external?.session.id === id) this.external = undefined;
      this.dismissedExternalSessions.delete(id);
      this.add(parent.state, parent);
      return {id};
    } finally {
      this.creating.delete(creation);
      this.creationCredits.delete(creation);
    }
  }

  private owned(
    id: string,
    allowStopping = false,
  ): Headquarters & {parent: DashboardParent} {
    this.ensureOpen();
    if (this.external?.session.id === id)
      throw new DashboardInputError('Continue this session in its terminal.');
    const entry = this.sessions.get(id);
    if (!entry) throw new DashboardInputError('Unknown workspace.');
    if (!entry.parent)
      throw new DashboardInputError('Continue this session in its terminal.');
    if (entry.closing)
      throw new DashboardInputError('This session is closing.');
    if (entry.stopping && !allowStopping)
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
        'This workspace is no longer connected. Reopen the app from the terminal.',
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
      (typeof value !== 'string' || value.length > 262144) &&
      (typeof value !== 'object' || value === null || Array.isArray(value))
    )
      throw new DashboardInputError('Invalid extension dialog response.');
    const parent = this.owned(id).parent;
    if (!parent.ui)
      throw new DashboardInputError(
        'Extension dialogs are unavailable in this session.',
      );
    const ui = parent.ui.snapshot();
    if (ui.navigation?.id === dialogId) {
      if (value !== undefined)
        throw new DashboardInputError('Invalid navigation acknowledgement.');
      parent.ui.respond(dialogId);
      return;
    }
    const dialog = ui.dialogs[0];
    const editor =
      ui.editor?.id === dialogId || ui.extensionEditor?.id === dialogId;
    if (!editor && dialog?.id !== dialogId)
      throw new DashboardInputError(
        'This extension dialog is no longer waiting for a response.',
      );
    if (value !== null && typeof value === 'object') {
      const response = fields(value);
      const keys = Object.keys(response);
      if (!editor && dialog?.terminal) {
        if (
          keys.length === 1 &&
          keys[0] === 'input' &&
          typeof response.input === 'string' &&
          response.input.length <= 262144
        ) {
          parent.ui.respond(dialogId, {input: response.input});
          return;
        }
        if (
          keys.length === 2 &&
          keys.includes('columns') &&
          keys.includes('rows') &&
          Number.isInteger(response.columns) &&
          Number.isInteger(response.rows) &&
          Number(response.columns) >= 20 &&
          Number(response.columns) <= 240 &&
          Number(response.rows) >= 6 &&
          Number(response.rows) <= 100
        ) {
          parent.ui.respond(dialogId, {
            columns: Number(response.columns),
            rows: Number(response.rows),
          });
          return;
        }
      }
      if (
        editor ||
        dialog?.kind !== 'terminal' ||
        Object.keys(response).length !== 1 ||
        typeof response.action !== 'string' ||
        (!dialog.actions?.some(action => action.id === response.action) &&
          !dialog.tabs?.some(tab => `tab:${tab.id}` === response.action))
      )
        throw new DashboardInputError('Invalid extension dialog action.');
      parent.ui.respond(dialogId, {action: response.action});
      return;
    }
    if (value !== undefined) {
      const expectedType =
        !editor && (dialog?.kind === 'confirm' || dialog?.kind === 'info')
          ? 'boolean'
          : 'string';
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

  /** Copy from the authoritative transcript, not its bounded dashboard preview. */
  lastAssistantText(id: string): string {
    const parent = this.owned(id).parent;
    const text = parent.lastAssistantText?.();
    if (!text) throw new DashboardInputError('No assistant message to copy.');
    return text;
  }

  async sessionFeatures(id: string): Promise<SessionFeatures> {
    const attached = this.attached(id);
    const features = attached
      ? await attached.features(id)
      : await this.owned(id).parent.features();
    return structuredClone(features);
  }

  private maintain(
    id: string,
    action: (parent: DashboardParent) => Promise<void>,
    allowRunning = false,
  ): Promise<void> {
    const entry = this.owned(id);
    const status = entry.state.deliverySnapshot().session.status;
    if (
      status === 'closed' ||
      (!allowRunning &&
        (entry.maintaining || entry.running.size || status !== 'idle'))
    )
      throw new DashboardInputError('Wait until this session is idle.');
    if (!allowRunning) entry.maintaining = true;
    let actionOperation: Promise<void>;
    try {
      actionOperation = action(entry.parent);
    } catch (error) {
      actionOperation = Promise.reject(error);
    }
    const operation = actionOperation.finally(() => {
      if (!allowRunning) entry.maintaining = false;
      entry.pending.delete(operation);
      if (this.has(entry)) {
        if (!entry.closing) this.refresh(entry);
        this.changed();
      }
    });
    entry.pending.add(operation);
    return operation;
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
    await this.maintain(id, parent => parent.compact(instructions), true);
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
    if (entry.running.size >= 32)
      throw new DashboardInputError(
        'This session already has 32 pending prompts.',
      );
    const command = parseSlashCommand(prompt);
    if (entry.maintaining && !(command && nativeCommand(command.name)?.live))
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
        entry.pending.delete(operation);
        if (this.has(entry)) {
          if (!entry.closing) this.refresh(entry);
          this.changed();
        }
      });
    entry.running.add(operation);
    entry.pending.add(operation);
    this.changed();
    return operation;
  }

  restartSnapshots(): DesktopStartup[] {
    this.ensureOpen();
    if (this.creating.size)
      throw new DashboardInputError('A workspace is still starting.');
    const parents: DesktopStartup[] = [];
    for (const entry of this.sessions.values()) {
      if (!entry.parent) continue;
      const snapshot = entry.state.deliverySnapshot();
      if (snapshot.session.status === 'closed') continue;
      if (
        entry.running.size ||
        entry.stopping ||
        entry.closing ||
        entry.maintaining ||
        snapshot.session.status !== 'idle' ||
        snapshot.agents.some(agent =>
          ['queued', 'running', 'cancelling'].includes(agent.status),
        )
      )
        throw new DashboardInputError(
          'Workspaces and agents must be idle before restarting.',
        );
      parents.push(entry.parent.restartSnapshot());
    }
    return parents;
  }

  async agentSession(id: string, input: unknown): Promise<AgentSessionResult> {
    const request = agentSessionRequest(input);
    const attached = this.attached(id);
    if (attached) {
      if (!attached.agentSession)
        throw new DashboardInputError('Agent conversations are unavailable.');
      return structuredClone(await attached.agentSession(id, request));
    }
    const entry = this.owned(id);
    if (!entry.parent.agentSession)
      throw new DashboardInputError('Agent conversations are unavailable.');
    const operation = Promise.resolve().then(() =>
      entry.parent!.agentSession!(request),
    );
    entry.pending.add(operation);
    try {
      return structuredClone(await operation);
    } finally {
      entry.pending.delete(operation);
      if (this.has(entry) && !entry.closing) this.refresh(entry);
    }
  }

  async cancelAgent(id: string, input: unknown): Promise<void> {
    const agentId = agentCancellationId(input);
    const attached = this.attached(id);
    if (attached) return attached.cancelAgent(id, agentId);
    await this.owned(id, true).parent.cancelAgent(agentId);
  }

  async abortSession(id: string): Promise<StoppedMessages> {
    const attached = this.attached(id);
    if (attached) return attached.abort(id);
    const entry = this.owned(id);
    entry.stopping = true;
    entry.state.updateSession({activity: 'Stopping'});
    let aborting: Promise<StoppedMessages>;
    try {
      aborting = entry.parent.abort();
    } catch (error) {
      aborting = Promise.reject(error);
    }
    const operation = (async () => {
      const queued = await aborting;
      await Promise.allSettled(entry.running);
      if (!entry.closing) {
        entry.state.updateSession({status: 'idle', activity: 'Stopped'});
        entry.state.record('session', 'Main agent stopped');
      }
      return queued;
    })().finally(() => {
      if (!entry.closing) entry.stopping = false;
      entry.pending.delete(operation);
      if (this.has(entry)) this.changed();
    });
    entry.pending.add(operation);
    return operation;
  }

  async closeSession(id: string): Promise<void> {
    this.ensureOpen();
    const closing = this.closingSessions.get(id);
    if (closing) return closing;
    if (this.external?.session.id === id) {
      this.dismissedExternalSessions.add(id);
      this.external = undefined;
      this.externalControl = undefined;
      this.changed();
      return Promise.resolve();
    }
    if (this.dismissedExternalSessions.has(id)) return Promise.resolve();
    const entry = this.sessions.get(id);
    if (!entry) throw new DashboardInputError('Unknown workspace.');
    if (!entry.parent) {
      entry.unsubscribe();
      this.sessions.delete(id);
      this.dismissedExternalSessions.add(id);
      this.changed();
      return Promise.resolve();
    }
    entry.stopping = true;
    entry.closing = true;
    const operation = Promise.resolve().then(async () => {
      let parentClosing: Promise<void>;
      try {
        parentClosing = entry.parent!.close();
      } catch (error) {
        parentClosing = Promise.reject(error);
      }
      const [result] = await Promise.allSettled([
        parentClosing,
        ...entry.pending,
      ]);
      if (result.status === 'rejected') {
        entry.closing = false;
        entry.stopping = false;
        const message =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        entry.state.updateSession({
          activity: `Close failed: ${message.slice(0, 1000)}`,
          error: message.slice(0, 4000),
        });
        throw result.reason;
      }
      entry.unsubscribe();
      if (this.sessions.get(id) === entry) this.sessions.delete(id);
      this.changed();
    });
    const tracked = operation.then(
      () => {
        if (this.closingSessions.get(id) === tracked)
          this.closingSessions.delete(id);
      },
      error => {
        if (this.closingSessions.get(id) === tracked)
          this.closingSessions.delete(id);
        throw error;
      },
    );
    this.closingSessions.set(id, tracked);
    entry.state.updateSession({activity: 'Closing', error: undefined});
    return tracked;
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
      await Promise.allSettled([
        ...[...this.sessions.entries()].map(async ([id, entry]) => {
          const sessionClosing = this.closingSessions.get(id);
          if (sessionClosing) {
            await Promise.allSettled([sessionClosing, ...entry.pending]);
            return;
          }
          let parentClosing: Promise<void> = Promise.resolve();
          try {
            parentClosing = entry.parent?.close() ?? parentClosing;
          } catch (error) {
            parentClosing = Promise.reject(error);
          }
          await Promise.allSettled([parentClosing, ...entry.pending]);
        }),
        ...this.closingSessions.values(),
      ]);
      // A concurrently created parent is disposed by createSession before it can run.
      await Promise.allSettled([...this.creating]);
    })();
    return this.closing;
  }
}
