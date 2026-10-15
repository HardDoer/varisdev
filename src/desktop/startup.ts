import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type FileEntry,
} from '@earendil-works/pi-coding-agent';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {closeSync, mkdirSync, openSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildDesktop} from './build.ts';
import {configureSettings} from '../runtime/settings.mjs';
import {defaultDataDir} from '../runtime/manager.ts';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));

/** The idle CLI session is transferred over IPC before its terminal exits. */
export interface DesktopStartup {
  cwd: string;
  agentDir: string;
  sessionFile?: string;
  sessionDir: string;
  entries: FileEntry[];
  leafId: string | null;
  model?: {provider: string; id: string};
  thinkingLevel: ReturnType<ExtensionAPI['getThinkingLevel']>;
  tools: string[];
  argv: string[];
}

export function desktopStartup(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  argv = process.argv.slice(2),
): DesktopStartup {
  const header = ctx.sessionManager.getHeader();
  return {
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    sessionFile: ctx.sessionManager.getSessionFile(),
    sessionDir: ctx.sessionManager.getSessionDir(),
    entries: [...(header ? [header] : []), ...ctx.sessionManager.getEntries()],
    leafId: ctx.sessionManager.getLeafId(),
    model: ctx.model
      ? {provider: ctx.model.provider, id: ctx.model.id}
      : undefined,
    thinkingLevel: pi.getThinkingLevel(),
    tools: pi.getActiveTools(),
    argv,
  };
}

export async function launchDesktop(
  startup: DesktopStartup,
  signal: AbortSignal,
): Promise<void> {
  await buildDesktop(signal);
  signal.throwIfAborted();
  const env = configureSettings({...process.env});
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const dataDir =
    process.env.PIDEV_DESKTOP_DATA_DIR ?? join(defaultDataDir(), 'desktop');
  mkdirSync(dataDir, {recursive: true});
  const logPath = join(dataDir, 'startup.log');
  const log = openSync(logPath, 'w');
  let child;
  try {
    child = spawn(
      require('electron') as string,
      [
        join(root, 'desktop/build/src/desktop/main.js'),
        '--pidev-startup',
        `--pidev-cwd=${startup.cwd}`,
      ],
      {
        cwd: startup.cwd,
        detached: true,
        stdio: ['ignore', log, log, 'ipc'],
        env,
      },
    );
  } finally {
    closeSync(log);
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        fail(
          new Error('The desktop did not finish starting within 60 seconds.'),
        ),
      60_000,
    );
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      child.off('error', fail);
      child.off('exit', exited);
      child.off('message', message);
    };
    const fail = (error: Error) => {
      cleanup();
      child.kill();
      const details = readFileSync(logPath, 'utf8').slice(-8000).trim();
      reject(new Error(`${error.message}${details ? `\n${details}` : ''}`));
    };
    const abort = () => fail(new Error('Desktop startup cancelled.'));
    const exited = (code: number | null) =>
      fail(new Error(`Desktop exited during startup (${code}).`));
    const message = (value: unknown) => {
      if (!value || typeof value !== 'object' || !('type' in value)) return;
      if (value.type === 'startup-request') {
        child.send({type: 'startup', startup}, error => {
          if (error) fail(error);
        });
      } else if (value.type === 'startup-ready') {
        cleanup();
        child.disconnect();
        child.unref();
        resolve();
      } else if (value.type === 'startup-error') {
        fail(
          new Error(
            'error' in value ? String(value.error) : 'Desktop startup failed.',
          ),
        );
      }
    };
    child.on('message', message);
    child.once('error', fail);
    child.once('exit', exited);
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
  });
}

export function registerDesktopStartup(
  pi: ExtensionAPI,
  launch = launchDesktop,
  // Keep Pi inside session_start while its graceful shutdown restores the
  // terminal. Returning would let the CLI submit its initial prompts again.
  waitForExit: () => Promise<void> = () => new Promise(() => {}),
): void {
  let opening: AbortController | undefined;
  pi.on('session_shutdown', () => opening?.abort());
  pi.on('session_start', async (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    opening?.abort();
    const current = new AbortController();
    opening = current;
    try {
      ctx.ui.notify('Opening VarisDev…', 'info');
      await launch(desktopStartup(pi, ctx), current.signal);
      if (current.signal.aborted) return;
      opening = undefined;
      ctx.shutdown();
      await waitForExit();
    } catch (error) {
      if (!current.signal.aborted)
        ctx.ui.notify(
          `Could not open VarisDev: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
    } finally {
      if (opening === current) opening = undefined;
    }
  });
}
