import {randomUUID} from 'node:crypto';
import {stat} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {isAbsolute} from 'node:path';
import type {IPty} from '@lydell/node-pty';

export interface TerminalSnapshot {
  sessionId: string;
  generation: string;
  sequence: number;
  data: string;
  exitCode?: number;
}

interface TerminalSession {
  pty: IPty;
  snapshot: TerminalSnapshot;
}

export class DesktopTerminals {
  private readonly sessions = new Map<string, TerminalSession>();
  private disposed = false;

  private readonly send: (event: TerminalSnapshot) => void;

  constructor(send: (event: TerminalSnapshot) => void) {
    this.send = send;
  }

  async open(sessionId: string, cwd: string): Promise<TerminalSnapshot> {
    if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory())
      throw new Error('Choose a project folder before opening a terminal.');
    const {spawn} = await import('@lydell/node-pty');
    if (this.disposed) throw new Error('The terminal is closing.');
    const existing = this.sessions.get(sessionId);
    if (existing) return {...existing.snapshot};
    if (this.sessions.size >= 16)
      throw new Error('Close a terminal before opening another.');
    const shell =
      process.platform === 'win32'
        ? 'powershell.exe'
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
    const snapshot: TerminalSnapshot = {
      sessionId,
      generation: randomUUID(),
      sequence: 0,
      data: '',
    };
    const entry = {pty, snapshot};
    this.sessions.set(sessionId, entry);
    pty.onData(data => {
      if (this.sessions.get(sessionId) !== entry) return;
      snapshot.sequence++;
      snapshot.data = (snapshot.data + data).slice(-256 * 1024);
      this.send({...snapshot, data});
    });
    pty.onExit(({exitCode}) => {
      if (this.sessions.get(sessionId) !== entry) return;
      snapshot.sequence++;
      snapshot.exitCode = exitCode;
      this.send({...snapshot, data: ''});
    });
    return {...snapshot};
  }

  write(sessionId: string, data: unknown): void {
    if (typeof data !== 'string' || data.length > 64 * 1024)
      throw new Error('Terminal input must contain at most 64 KB.');
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.snapshot.exitCode !== undefined)
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
    if (entry && entry.snapshot.exitCode === undefined)
      entry.pty.resize(cols, rows);
  }

  close(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (entry && entry.snapshot.exitCode === undefined) entry.pty.kill();
  }

  dispose(): void {
    this.disposed = true;
    for (const id of this.sessions.keys()) this.close(id);
  }
}
