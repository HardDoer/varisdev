import type {DashboardHub} from '../dashboard/hub.ts';
import {runRuntimeCommand} from '../runtime/manager.ts';

interface CompletionWindow {
  isDestroyed(): boolean;
  isFocused(): boolean;
}

interface CompletionSoundOptions {
  window(): CompletionWindow | undefined;
  play(shouldPlay: () => boolean): void | Promise<void>;
}

/** Observe settlement before renderer snapshot delivery is throttled. */
export class DesktopCompletionSound {
  private readonly completions = new Map<string, string | undefined>();
  private readonly unsubscribe: () => void;
  private disposed = false;
  private readonly options: CompletionSoundOptions;

  constructor(
    hub: Pick<DashboardHub, 'completionStates' | 'subscribe'>,
    options: CompletionSoundOptions,
  ) {
    this.options = options;
    this.observe(hub.completionStates());
    this.unsubscribe = hub.subscribe(() =>
      this.observe(hub.completionStates()),
    );
  }

  private readonly shouldPlay = (): boolean => {
    const window = this.options.window();
    return (
      !this.disposed && !!window && !window.isDestroyed() && !window.isFocused()
    );
  };

  private observe(states: ReturnType<DashboardHub['completionStates']>): void {
    let completed = false;
    const retained = new Set<string>();
    for (const session of states) {
      retained.add(session.id);
      if (
        this.completions.has(session.id) &&
        session.completionId &&
        this.completions.get(session.id) !== session.completionId &&
        session.status !== 'closed'
      )
        completed = true;
      // A newly attached or restored workspace establishes a baseline.
      this.completions.set(session.id, session.completionId);
    }
    for (const id of this.completions.keys())
      if (!retained.has(id)) this.completions.delete(id);
    if (completed && this.shouldPlay())
      void Promise.resolve(this.options.play(this.shouldPlay)).catch(() => {});
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.completions.clear();
  }
}

interface SoundPlaybackOptions {
  path: string;
  shouldPlay(): boolean;
  beep(): void;
  platform?: NodeJS.Platform;
  run?: typeof runRuntimeCommand;
}

/** Preserve the original Pi extension's sound and platform player order. */
export async function playDesktopCompletionSound(
  options: SoundPlaybackOptions,
): Promise<void> {
  const path = options.path;
  const players: Array<[string, string[]]> = [];
  switch (options.platform ?? process.platform) {
    case 'win32':
      players.push([
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$player = [System.Media.SoundPlayer]::new('${path.replaceAll("'", "''")}'); ` +
            'try { $player.PlaySync() } finally { $player.Dispose() }',
        ],
      ]);
      break;
    case 'linux':
      players.push(
        ['pw-play', [path]],
        ['paplay', [path]],
        ['aplay', ['-q', path]],
        ['canberra-gtk-play', ['--file', path]],
        ['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', path]],
        ['play', ['-q', path]],
      );
      break;
  }
  for (const [command, args] of players) {
    if (!options.shouldPlay()) return;
    try {
      await (options.run ?? runRuntimeCommand)(command, args, {
        cwd: process.cwd(),
        env: {...process.env},
        timeoutMs: 5000,
      });
      return;
    } catch {
      // Try the next available player, then the native bell.
    }
  }
  if (options.shouldPlay()) options.beep();
}
