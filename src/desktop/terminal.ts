import {execFile} from 'node:child_process';
import {access, stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {delimiter, isAbsolute, join} from 'node:path';
import {promisify} from 'node:util';

interface TerminalCommand {
  name: string;
  executable: string;
  args: string[];
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const powershellQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Arguments are passed directly; project names never become shell syntax. */
export function terminalCommands(
  platform: NodeJS.Platform,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): TerminalCommand[] {
  if (platform === 'darwin') {
    const command = `cd -- ${shellQuote(cwd)}`;
    return [
      {
        name: 'Terminal',
        executable: '/usr/bin/osascript',
        args: [
          '-e',
          `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(command)}\nend tell`,
        ],
      },
    ];
  }
  if (platform === 'win32') {
    const script = `Start-Process -FilePath 'powershell.exe' -WorkingDirectory ${powershellQuote(cwd)} -ArgumentList '-NoExit'`;
    return [
      {name: 'Windows Terminal', executable: 'wt.exe', args: ['-d', cwd]},
      {
        name: 'PowerShell',
        executable: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
      },
    ];
  }
  const shell = env.SHELL && isAbsolute(env.SHELL) ? env.SHELL : '/bin/sh';
  return [
    ...(env.TERMINAL
      ? [{name: 'Terminal', executable: env.TERMINAL, args: ['-e', shell]}]
      : []),
    {name: 'Terminal', executable: 'x-terminal-emulator', args: ['-e', shell]},
    {
      name: 'GNOME Terminal',
      executable: 'gnome-terminal',
      args: [`--working-directory=${cwd}`],
    },
    {name: 'Konsole', executable: 'konsole', args: ['--workdir', cwd]},
    {
      name: 'Xfce Terminal',
      executable: 'xfce4-terminal',
      args: [`--working-directory=${cwd}`],
    },
    {name: 'Kitty', executable: 'kitty', args: ['--directory', cwd]},
    {
      name: 'Alacritty',
      executable: 'alacritty',
      args: ['--working-directory', cwd],
    },
    {name: 'XTerm', executable: 'xterm', args: ['-e', shell]},
  ];
}

async function available(command: string): Promise<boolean> {
  const paths = isAbsolute(command)
    ? [command]
    : (process.env.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map(path => join(path, command));
  for (const path of paths) {
    try {
      await access(
        path,
        process.platform === 'win32' ? constants.F_OK : constants.X_OK,
      );
      return true;
    } catch {
      // Try the next search directory.
    }
  }
  return false;
}

export async function openSystemTerminal(
  cwd: string,
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    available?: (command: string) => Promise<boolean>;
    run?: (command: string, args: string[], cwd: string) => Promise<void>;
  } = {},
): Promise<{name: string}> {
  if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory())
    throw new Error('Choose a project folder before opening a terminal.');
  const run =
    options.run ??
    (async (command, args, cwd) => {
      // Desktop terminal emulators may keep their launching process alive. Detach
      // them while retaining spawn errors, and wait only for short system launchers.
      if (command === '/usr/bin/osascript' || command === 'powershell.exe') {
        await promisify(execFile)(command, args, {cwd, timeout: 15000});
      } else {
        const {spawn} = await import('node:child_process');
        await new Promise<void>((resolve, reject) => {
          const child = spawn(command, args, {
            cwd,
            detached: true,
            stdio: 'ignore',
          });
          child.once('error', reject);
          child.once('spawn', () => {
            child.unref();
            resolve();
          });
        });
      }
    });
  for (const command of terminalCommands(
    options.platform ?? process.platform,
    cwd,
    options.env,
  )) {
    if (!(await (options.available ?? available)(command.executable))) continue;
    await run(command.executable, command.args, cwd);
    return {name: command.name};
  }
  throw new Error(
    'No terminal application was found. Install a terminal and try again.',
  );
}
