import {
  getPackageDir,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {DesktopExtensionUI} from './extension-ui.ts';
import {
  runPiInteractiveFlow,
  showChangelogView,
  type PiInteractiveFlow,
} from './native-session-views.ts';

async function internal<T>(relativePath: string): Promise<T> {
  return (await import(
    pathToFileURL(join(getPackageDir(), 'dist', relativePath)).href
  )) as T;
}

const shippedShare = await internal<{shareSession: PiInteractiveFlow}>(
  'modes/interactive/session-share.js',
);
const shippedBug = await internal<{reportBug: PiInteractiveFlow}>(
  'modes/interactive/bug-report.js',
);

/** Injection replaces complete shipped flows so tests never upload or spawn gh. */
export interface ReportCommandDependencies {
  shareSession: PiInteractiveFlow;
  reportBug: PiInteractiveFlow;
}

export interface ReportCommandContext {
  session: AgentSession;
  ui: Pick<DesktopExtensionUI, 'native' | 'context'>;
  /** Abort when the owning session changes or closes. */
  signal?: AbortSignal;
  dependencies?: Partial<ReportCommandDependencies>;
}

const defaults: ReportCommandDependencies = {
  shareSession: shippedShare.shareSession,
  reportBug: shippedBug.reportBug,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Returns false only for a command this module does not own. */
export async function runReportCommand(
  name: string,
  args: string,
  context: ReportCommandContext,
): Promise<boolean> {
  if (!['share', 'bug', 'changelog'].includes(name)) return false;
  const deps = {...defaults, ...context.dependencies};
  try {
    context.signal?.throwIfAborted();
    if (name !== 'bug' && args.trim()) throw new Error(`Usage: /${name}`);
    if (name === 'share')
      await runPiInteractiveFlow(context, 'Share session', deps.shareSession);
    else if (name === 'bug')
      await runPiInteractiveFlow(
        context,
        'Report a bug',
        deps.reportBug,
        args || undefined,
      );
    else await showChangelogView(context);
  } catch (error) {
    const cancelled =
      Boolean(context.signal?.aborted) ||
      (error instanceof Error && error.name === 'AbortError');
    context.ui.context.notify(
      cancelled ? 'Report command cancelled.' : errorMessage(error),
      cancelled ? 'info' : 'error',
    );
  }
  return true;
}
