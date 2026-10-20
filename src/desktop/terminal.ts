import {randomUUID} from 'node:crypto';
import {stat} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {isAbsolute, join} from 'node:path';
import type {IDisposable, IPty} from '@lydell/node-pty';

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
  generation: string;
  sequence: number;
  data: string;
  exitCode?: number;
}

interface TerminalSession {
  pty: IPty;
  sessionId: string;
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

export class DesktopTerminals {
  private readonly sessions = new Map<string, TerminalSession>();
  private disposed = false;
  private readonly send: (event: TerminalSnapshot) => void;
  private readonly loadPty: () => Promise<PtyModule>;

  constructor(
    send: (event: TerminalSnapshot) => void,
    loadPty: () => Promise<PtyModule> = () => import('@lydell/node-pty'),
  ) {
    this.send = send;
    this.loadPty = loadPty;
  }

  private snapshot(entry: TerminalSession): TerminalSnapshot {
    return {
      sessionId: entry.sessionId,
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

  async open(sessionId: string, cwd: string): Promise<TerminalSnapshot> {
    if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory())
      throw new Error('Choose a project folder before opening a terminal.');
    const {spawn} = await this.loadPty();
    if (this.disposed) throw new Error('The terminal is closing.');
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.flush(existing);
      return this.snapshot(existing);
    }
    if (this.sessions.size >= 16)
      throw new Error('Close a terminal before opening another.');
    // Desktop launchers can inherit a PATH without Windows shell directories.
    const shell =
      process.platform === 'win32'
        ? join(
            process.env.SystemRoot || process.env.windir || 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
          )
        : process.env.SHELL || userInfo().shell || '/bin/sh';
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    if (process.platform === 'win32') {
      // PowerShell 7's inherited module path can make Windows PowerShell load
      // incompatible modules, including PSReadLine. Let the shell rebuild it.
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === 'psmodulepath') delete env[key];
      }
    }
    const pty = spawn(
      shell,
      process.platform === 'win32' ? ['-NoLogo'] : ['-l'],
      {
        cwd,
        env,
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
      },
    );
    const entry: TerminalSession = {
      pty,
      sessionId,
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

  close(sessionId: string): void {
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
    for (const id of this.sessions.keys()) this.close(id);
  }
}
