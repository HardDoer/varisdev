import {randomUUID} from 'node:crypto';
import {stat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import type {IDisposable, IPty} from '@lydell/node-pty';
import {resolveUserShell, shellEnvironment} from '../runtime/environment.mjs';
import {DesktopTerminalProfiles} from './terminal-profiles.ts';

const HISTORY_LIMIT = 256 * 1024;
const OUTPUT_BATCH_LIMIT = 256 * 1024;
const OUTPUT_BATCH_DELAY = 8;

function startsInsideSurrogatePair(value: string, index: number): boolean {
  if (index <= 0 || index >= value.length) return false;
  const previous = value.charCodeAt(index - 1);
  const next = value.charCodeAt(index);
  return (
    previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
  );
}

function boundedTail(value: string, limit: number): string {
  let start = Math.max(0, value.length - limit);
  if (startsInsideSurrogatePair(value, start)) start++;
  return value.slice(start);
}

type PtyModule = typeof import('@lydell/node-pty');

export interface TerminalSnapshot {
  sessionId: string;
  workspaceId: string;
  profileId: string;
  title: string;
  generation: string;
  sequence: number;
  data: string;
  exitCode?: number;
}

interface TerminalSession {
  pty: IPty;
  sessionId: string;
  workspaceId: string;
  profileId: string;
  title: string;
  generation: string;
  sequence: number;
  exitCode?: number;
  history: string[];
  historyLength: number;
  pending: string[];
  pendingLength: number;
  flushTimer?: NodeJS.Timeout;
  dataSubscription?: IDisposable;
  exitSubscription?: IDisposable;
}

interface TerminalStartup {
  workspaceId: string;
  cancelled: boolean;
  promise: Promise<TerminalSnapshot>;
}

interface TerminalOptions {
  profiles?: DesktopTerminalProfiles;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export class DesktopTerminals {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly starting = new Map<string, TerminalStartup>();
  private readonly profiles: DesktopTerminalProfiles;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private disposed = false;
  private readonly send: (event: TerminalSnapshot) => void;
  private readonly loadPty: () => Promise<PtyModule>;

  constructor(
    send: (event: TerminalSnapshot) => void,
    loadPty: () => Promise<PtyModule> = () => import('@lydell/node-pty'),
    options: TerminalOptions = {},
  ) {
    this.send = send;
    this.loadPty = loadPty;
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.profiles =
      options.profiles ??
      new DesktopTerminalProfiles(undefined, {
        env: this.env,
        platform: this.platform,
      });
  }

  private snapshot(entry: TerminalSession): TerminalSnapshot {
    return {
      sessionId: entry.sessionId,
      workspaceId: entry.workspaceId,
      profileId: entry.profileId,
      title: entry.title,
      generation: entry.generation,
      sequence: entry.sequence,
      data: entry.history.join(''),
      ...(entry.exitCode === undefined ? {} : {exitCode: entry.exitCode}),
    };
  }

  private appendHistory(entry: TerminalSession, data: string): void {
    if (data.length >= HISTORY_LIMIT) {
      const tail = boundedTail(data, HISTORY_LIMIT);
      entry.history = [tail];
      entry.historyLength = tail.length;
      return;
    }
    entry.history.push(data);
    entry.historyLength += data.length;
    while (entry.historyLength > HISTORY_LIMIT) {
      const excess = entry.historyLength - HISTORY_LIMIT;
      const first = entry.history[0];
      if (first.length <= excess) {
        entry.history.shift();
        entry.historyLength -= first.length;
      } else {
        const removed = startsInsideSurrogatePair(first, excess)
          ? excess + 1
          : excess;
        entry.history[0] = first.slice(removed);
        entry.historyLength -= removed;
      }
    }
  }

  private flush(entry: TerminalSession): void {
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    entry.flushTimer = undefined;
    if (!entry.pendingLength || this.sessions.get(entry.sessionId) !== entry)
      return;
    const data = entry.pending.join('');
    entry.pending = [];
    entry.pendingLength = 0;
    for (let offset = 0; offset < data.length;) {
      let end = Math.min(offset + OUTPUT_BATCH_LIMIT, data.length);
      if (startsInsideSurrogatePair(data, end)) end--;
      entry.sequence++;
      this.send({
        sessionId: entry.sessionId,
        workspaceId: entry.workspaceId,
        profileId: entry.profileId,
        title: entry.title,
        generation: entry.generation,
        sequence: entry.sequence,
        data: data.slice(offset, end),
      });
      offset = end;
    }
  }

  private queueOutput(entry: TerminalSession, data: string): void {
    if (!data || this.sessions.get(entry.sessionId) !== entry) return;
    this.appendHistory(entry, data);
    entry.pending.push(data);
    entry.pendingLength += data.length;
    if (entry.pendingLength >= OUTPUT_BATCH_LIMIT) {
      this.flush(entry);
      return;
    }
    entry.flushTimer ??= setTimeout(
      () => this.flush(entry),
      OUTPUT_BATCH_DELAY,
    );
  }

  list(workspaceId: string): TerminalSnapshot[] {
    return [...this.sessions.values()]
      .filter(entry => entry.workspaceId === workspaceId)
      .map(entry => {
        this.flush(entry);
        return this.snapshot(entry);
      });
  }

  async listReady(workspaceId: string): Promise<TerminalSnapshot[]> {
    for (;;) {
      const pending = [...this.starting.values()]
        .filter(entry => entry.workspaceId === workspaceId && !entry.cancelled)
        .map(entry => entry.promise);
      if (!pending.length) return this.list(workspaceId);
      await Promise.allSettled(pending);
    }
  }

  workspaceFor(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.workspaceId;
  }

  async open(
    workspaceId: string,
    cwd: string,
    terminalId?: string,
  ): Promise<TerminalSnapshot> {
    if (this.disposed) throw new Error('The terminal is closing.');
    if (terminalId !== undefined) {
      const entry = this.sessions.get(terminalId);
      if (!entry || entry.workspaceId !== workspaceId)
        throw new Error('Choose an open terminal in this workspace.');
      this.flush(entry);
      return this.snapshot(entry);
    }
    const existing = this.list(workspaceId)[0];
    if (existing) return existing;
    const pending = [...this.starting.values()].find(
      entry => entry.workspaceId === workspaceId && !entry.cancelled,
    );
    if (pending) return pending.promise;
    // Retain the original open(sessionId, cwd) identifier for direct callers.
    const sessionId =
      this.sessions.has(workspaceId) || this.starting.has(workspaceId)
        ? randomUUID()
        : workspaceId;
    return this.start(workspaceId, cwd, sessionId);
  }

  create(
    workspaceId: string,
    cwd: string,
    profileId?: string,
  ): Promise<TerminalSnapshot> {
    return this.start(workspaceId, cwd, randomUUID(), profileId);
  }

  private start(
    workspaceId: string,
    cwd: string,
    sessionId: string,
    profileId?: string,
  ): Promise<TerminalSnapshot> {
    if (this.disposed)
      return Promise.reject(new Error('The terminal is closing.'));
    if (this.sessions.size + this.starting.size >= 16)
      return Promise.reject(
        new Error('Close a terminal before opening another.'),
      );
    const startup: TerminalStartup = {
      workspaceId,
      cancelled: false,
      promise: undefined!,
    };
    this.starting.set(sessionId, startup);
    startup.promise = this.spawn(
      workspaceId,
      cwd,
      sessionId,
      startup,
      profileId,
    ).finally(() => {
      if (this.starting.get(sessionId) === startup)
        this.starting.delete(sessionId);
    });
    return startup.promise;
  }

  private async spawn(
    workspaceId: string,
    cwd: string,
    sessionId: string,
    startup: TerminalStartup,
    profileId?: string,
  ): Promise<TerminalSnapshot> {
    if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory())
      throw new Error('Choose a project folder before opening a terminal.');
    const {spawn} = await this.loadPty();
    if (this.disposed || startup.cancelled)
      throw new Error('This workspace has closed.');
    const profile = this.profiles.resolve(profileId);
    const shell = resolveUserShell({
      env: this.env,
      platform: this.platform,
      shell: profile.path,
    });
    const env: NodeJS.ProcessEnv = {
      ...shellEnvironment(this.env, shell.kind, this.platform),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };
    if (this.platform === 'win32' && shell.kind === 'bash')
      env.CHERE_INVOKING = '1';
    delete env.ELECTRON_RUN_AS_NODE;
    const kind = shell.kind.toLowerCase().replace(/\.exe$/, '');
    const args = !profile.custom
      ? shell.args
      : ['powershell', 'pwsh'].includes(kind)
        ? ['-NoLogo']
        : [
              'bash',
              'zsh',
              'fish',
              'nu',
              'sh',
              'dash',
              'ash',
              'ksh',
              'csh',
              'tcsh',
            ].includes(kind)
          ? shell.args
          : [];
    const pty = spawn(shell.file, args, {
      cwd,
      env,
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
    });
    if (this.disposed || startup.cancelled) {
      pty.kill();
      throw new Error('This workspace has closed.');
    }
    const entry: TerminalSession = {
      pty,
      sessionId,
      workspaceId,
      profileId: profile.id,
      title: profile.label,
      generation: randomUUID(),
      sequence: 0,
      history: [],
      historyLength: 0,
      pending: [],
      pendingLength: 0,
    };
    this.sessions.set(sessionId, entry);
    entry.dataSubscription = pty.onData(data => this.queueOutput(entry, data));
    entry.exitSubscription = pty.onExit(({exitCode}) => {
      if (this.sessions.get(sessionId) !== entry) return;
      this.flush(entry);
      entry.sequence++;
      entry.exitCode = exitCode;
      this.send({
        sessionId: entry.sessionId,
        workspaceId: entry.workspaceId,
        profileId: entry.profileId,
        title: entry.title,
        generation: entry.generation,
        sequence: entry.sequence,
        data: '',
        exitCode,
      });
      entry.dataSubscription?.dispose();
      entry.exitSubscription?.dispose();
      entry.dataSubscription = undefined;
      entry.exitSubscription = undefined;
    });
    this.flush(entry);
    return this.snapshot(entry);
  }

  write(sessionId: string, data: unknown): void {
    if (typeof data !== 'string' || data.length > 64 * 1024)
      throw new Error('Terminal input must contain at most 64 KB.');
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.exitCode !== undefined)
      throw new Error('Open a terminal before sending input.');
    entry.pty.write(data);
  }

  resize(sessionId: string, cols: unknown, rows: unknown): void {
    if (
      typeof cols !== 'number' ||
      !Number.isInteger(cols) ||
      cols < 2 ||
      cols > 500 ||
      typeof rows !== 'number' ||
      !Number.isInteger(rows) ||
      rows < 1 ||
      rows > 200
    )
      throw new Error('Invalid terminal dimensions.');
    const entry = this.sessions.get(sessionId);
    if (entry && entry.exitCode === undefined) entry.pty.resize(cols, rows);
  }

  closeWorkspace(workspaceId: string): void {
    for (const [id, startup] of this.starting)
      if (startup.workspaceId === workspaceId) this.close(id);
    for (const [id, entry] of this.sessions)
      if (entry.workspaceId === workspaceId) this.close(id);
  }

  close(sessionId: string): void {
    const startup = this.starting.get(sessionId);
    if (startup) startup.cancelled = true;
    this.starting.delete(sessionId);
    const entry = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (!entry) return;
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    entry.dataSubscription?.dispose();
    entry.exitSubscription?.dispose();
    entry.pending = [];
    entry.pendingLength = 0;
    if (entry.exitCode === undefined) entry.pty.kill();
  }

  dispose(): void {
    this.disposed = true;
    for (const id of this.starting.keys()) this.close(id);
    for (const id of this.sessions.keys()) this.close(id);
  }
}
