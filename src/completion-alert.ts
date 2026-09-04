import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {fileURLToPath} from 'node:url';

const COMPLETION_SOUND_PATH = fileURLToPath(
  new URL('../assets/windows_98_ding.wav', import.meta.url),
);
const PLAYER_TIMEOUT_MS = 5000;
const ENABLE_FOCUS_REPORTING = '\x1b[?1004h';
const DISABLE_FOCUS_REPORTING = '\x1b[?1004l';
const FOCUS_IN = '\x1b[I';
const FOCUS_OUT = '\x1b[O';
const TERMINAL_BELL = '\x07';
const PROGRESS_COMPLETE = '\x1b]9;4;1;100\x07';
const PROGRESS_CLEAR = '\x1b]9;4;0\x07';
const ITERM_REQUEST_ATTENTION = '\x1b]1337;RequestAttention=once\x07';
const ITERM_CANCEL_ATTENTION = '\x1b]1337;RequestAttention=no\x07';

type SoundPlayerCommand = {
  command: string;
  args: string[];
};

type AgentSettledAPI = {
  on(
    event: 'agent_settled',
    handler: (_event: unknown, ctx: ExtensionContext) => Promise<void>,
  ): void;
};

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function getWindowsAttentionScript(): string {
  return `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class VarisDevAttention {
  [StructLayout(LayoutKind.Sequential)]
  public struct FlashInfo {
    public uint Size;
    public IntPtr Window;
    public uint Flags;
    public uint Count;
    public uint Timeout;
  }

  [DllImport("user32.dll")]
  public static extern bool FlashWindowEx(ref FlashInfo info);

  public static void Flash(IntPtr window) {
    var info = new FlashInfo {
      Size = (uint)Marshal.SizeOf(typeof(FlashInfo)),
      Window = window,
      Flags = 15,
      Count = 5,
      Timeout = 0
    };
    FlashWindowEx(ref info);
  }
}
'@

$currentId = $PID
$window = [IntPtr]::Zero
while ($currentId -gt 0 -and $window -eq [IntPtr]::Zero) {
  $candidate = Get-Process -Id $currentId -ErrorAction SilentlyContinue
  if ($candidate -and $candidate.MainWindowHandle -ne 0) {
    $window = $candidate.MainWindowHandle
    break
  }

  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $currentId" -ErrorAction SilentlyContinue
  if (!$current -or $current.ParentProcessId -eq $currentId) { break }
  $currentId = $current.ParentProcessId
}

if ($window -eq [IntPtr]::Zero) { exit 1 }
[VarisDevAttention]::Flash($window)
`.trim();
}

function getSoundPlayerCommands(): SoundPlayerCommand[] {
  switch (process.platform) {
    case 'win32': {
      const soundPath = quotePowerShell(COMPLETION_SOUND_PATH);
      return [
        {
          command: 'powershell.exe',
          args: [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$player = [System.Media.SoundPlayer]::new(${soundPath}); ` +
              'try { $player.PlaySync() } finally { $player.Dispose() }',
          ],
        },
      ];
    }
    case 'linux':
      return [
        {command: 'pw-play', args: [COMPLETION_SOUND_PATH]},
        {command: 'paplay', args: [COMPLETION_SOUND_PATH]},
        {command: 'aplay', args: ['-q', COMPLETION_SOUND_PATH]},
        {
          command: 'canberra-gtk-play',
          args: ['--file', COMPLETION_SOUND_PATH],
        },
        {
          command: 'ffplay',
          args: [
            '-nodisp',
            '-autoexit',
            '-loglevel',
            'quiet',
            COMPLETION_SOUND_PATH,
          ],
        },
        {command: 'play', args: ['-q', COMPLETION_SOUND_PATH]},
      ];
    default:
      return [];
  }
}

async function playCompletionSound(pi: ExtensionAPI): Promise<void> {
  for (const player of getSoundPlayerCommands()) {
    try {
      const result = await pi.exec(player.command, player.args, {
        timeout: PLAYER_TIMEOUT_MS,
      });
      if (result.code === 0) return;
    } catch {
      // Try the next available player.
    }
  }

  process.stdout.write(TERMINAL_BELL);
}

async function requestWindowsAttention(
  pi: ExtensionAPI,
  isStillNeeded: () => boolean,
): Promise<void> {
  try {
    const result = await pi.exec(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        getWindowsAttentionScript(),
      ],
      {timeout: PLAYER_TIMEOUT_MS},
    );
    if (result.code === 0) return;
  } catch {
    // The caller keeps the terminal progress indicator as a fallback.
  }

  if (isStillNeeded()) process.stdout.write(TERMINAL_BELL);
}

export function registerCompletionAlert(pi: ExtensionAPI): void {
  let focused = true;
  let focusInput = '';
  let focusListener: ((data: Buffer | string) => void) | undefined;
  let attentionActive = false;

  const clearAttention = () => {
    if (!attentionActive) return;
    attentionActive = false;

    process.stdout.write(PROGRESS_CLEAR);
    if (process.env.TERM_PROGRAM === 'iTerm.app') {
      process.stdout.write(ITERM_CANCEL_ATTENTION);
    }
  };

  const handleFocusInput = (data: Buffer | string) => {
    const input = focusInput + data.toString();
    const focusInIndex = input.lastIndexOf(FOCUS_IN);
    const focusOutIndex = input.lastIndexOf(FOCUS_OUT);

    if (focusInIndex >= 0 || focusOutIndex >= 0) {
      focused = focusInIndex > focusOutIndex;
      if (focused) clearAttention();
    }

    focusInput = input.slice(-(FOCUS_IN.length - 1));
  };

  const startFocusTracking = (ctx: ExtensionContext) => {
    if (ctx.mode !== 'tui' || focusListener) return;

    focused = true;
    focusInput = '';
    focusListener = handleFocusInput;
    process.stdin.on('data', focusListener);
    process.stdout.write(ENABLE_FOCUS_REPORTING);
  };

  const stopFocusTracking = () => {
    if (!focusListener) return;

    process.stdin.off('data', focusListener);
    process.stdout.write(DISABLE_FOCUS_REPORTING);
    focusListener = undefined;
    focusInput = '';
    focused = true;
    clearAttention();
  };

  const requestAttention = () => {
    if (attentionActive) return;
    attentionActive = true;

    process.stdout.write(PROGRESS_COMPLETE);
    if (process.platform === 'win32') {
      void requestWindowsAttention(pi, () => attentionActive);
    } else if (process.env.TERM_PROGRAM === 'iTerm.app') {
      process.stdout.write(ITERM_REQUEST_ATTENTION + TERMINAL_BELL);
    } else {
      process.stdout.write(TERMINAL_BELL);
    }
  };

  pi.on('session_start', async (_event, ctx) => {
    startFocusTracking(ctx);
  });

  (pi as unknown as AgentSettledAPI).on(
    'agent_settled',
    async (_event, ctx) => {
      if (ctx.mode !== 'tui' || focused) return;
      requestAttention();
      if (process.platform !== 'darwin') void playCompletionSound(pi);
    },
  );

  pi.on('session_shutdown', async () => {
    stopFocusTracking();
  });
}
