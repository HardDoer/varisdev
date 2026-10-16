import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import {findPackageJSON} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {AgentSession} from '@earendil-works/pi-coding-agent';
import type {DesktopExtensionUI} from './extension-ui.js';

// These helpers are intentionally not exported by the SDK. Resolve against its
// entry, not the app's node_modules layout (which differs in desktop releases).
const sdkEntry = import.meta.resolve('@earendil-works/pi-coding-agent');
// Pi AI has import-only exports, so createRequire(...).resolve() cannot locate
// its entry. Node's package resolver accepts the SDK entry as its base and also
// works when Pi exists only in desktop/node_modules in production installs.
const aiPackage = findPackageJSON('@earendil-works/pi-ai', sdkEntry);
if (!aiPackage) throw new Error('The SDK Pi AI package could not be resolved.');
const {DEFAULT_RADIUS_GATEWAY} = (await import(
  new URL('./dist/providers/radius-config.js', pathToFileURL(aiPackage)).href
)) as {DEFAULT_RADIUS_GATEWAY: string};
async function internal<T>(path: string): Promise<T> {
  return (await import(new URL(path, sdkEntry).href)) as T;
}

export interface ReportFile {
  name: string;
  contentType: string;
  data: string;
}
export interface BugReportBundle {
  metadata: {
    id: string;
    createdAt: string;
    hint: string | null;
    session: {included: boolean; summaryIncluded: boolean};
    [key: string]: unknown;
  };
  diagnostics: {crashes: unknown[]; [key: string]: unknown};
  sessionJsonl?: string;
  summary?: string;
}
type Destination = 'radius' | 'gist';
type BugOptions = {hint?: string; includeSession: boolean};
type Delivery = {delivery: 'upload' | 'zip'; path?: string};

/** Narrow IO boundary so tests never need credentials, subprocesses or network. */
export interface ReportCommandDependencies {
  sharePayload(
    session: AgentSession,
    destination: Destination,
  ): Promise<ReportFile>;
  shareUpload(
    session: AgentSession,
    destination: Destination,
    file: ReportFile,
    signal: AbortSignal,
  ): Promise<string>;
  bugBundle(
    session: AgentSession,
    options: BugOptions,
    summary?: string,
  ): Promise<BugReportBundle>;
  bugFiles(bundle: BugReportBundle): Promise<ReportFile[]>;
  bugGateway(): Promise<string>;
  uploadBug(
    session: AgentSession,
    bundle: BugReportBundle,
    signal: AbortSignal,
    gateway: string,
  ): Promise<string>;
  exportBug(bundle: BugReportBundle, path: string): Promise<void>;
  recordBug(
    session: AgentSession,
    bundle: BugReportBundle,
    delivery: Delivery,
  ): Promise<void>;
  readChangelog(): Promise<string>;
  offline(): boolean;
}
export interface ReportCommandContext {
  session: AgentSession;
  ui: DesktopExtensionUI;
  /** Abort when the owning session changes or closes. */
  signal?: AbortSignal;
  dependencies?: Partial<ReportCommandDependencies>;
}

async function serializeShare(session: AgentSession): Promise<string> {
  const share = await internal<{
    createShareTrailingEntries(
      session: AgentSession,
      parentId: string | null,
      timestamp: string,
    ): unknown[];
  }>('./modes/interactive/session-share.js');
  const exporter = await internal<{
    serializeSessionBranch(
      manager: AgentSession['sessionManager'],
      trailing: (parentId: string | null, timestamp: string) => unknown[],
    ): string;
  }>('./core/session-export.js');
  return exporter.serializeSessionBranch(
    session.sessionManager,
    (parentId, timestamp) =>
      share.createShareTrailingEntries(session, parentId, timestamp),
  );
}

async function radiusToken(
  session: AgentSession,
  signal: AbortSignal,
): Promise<string | undefined> {
  signal.throwIfAborted();
  if (!session.modelRuntime.getProvider('radius')) return undefined;
  const auth = await internal<{
    getAuthCredential(
      value: Awaited<ReturnType<AgentSession['modelRuntime']['getAuth']>>,
    ): string | undefined;
  }>('./cli/auth-command.js');
  return auth.getAuthCredential(
    await session.modelRuntime.getAuth('radius', {
      minOAuthValidityMs: 5 * 60_000,
      signal,
    }),
  );
}

/** No shell, bounded output, and cancellation also terminates an uncooperative gh. */
function gh(args: string[], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, {stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      child.kill();
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000);
      killTimer.unref();
    };
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
    const collect = (chunk: Buffer, error: boolean) => {
      if (stdout.length + stderr.length + chunk.length > 1024 * 1024) {
        failure = new Error('GitHub CLI output exceeded 1 MiB.');
        abort();
      } else if (error) stderr += chunk.toString();
      else stdout += chunk.toString();
    };
    child.stdout.on('data', chunk => collect(chunk, false));
    child.stderr.on('data', chunk => collect(chunk, true));
    child.on('error', error => {
      failure = error;
    });
    child.on('close', code => {
      signal.removeEventListener('abort', abort);
      if (killTimer) clearTimeout(killTimer);
      if (signal.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error(
            stderr.trim() || 'GitHub CLI failed. Run gh auth login first.',
          ),
        );
      else resolve(stdout.trim());
    });
  });
}

const defaults: ReportCommandDependencies = {
  async sharePayload(session, destination) {
    if (destination === 'radius')
      return {
        name: 'session.jsonl',
        contentType: 'application/x-ndjson',
        data: await serializeShare(session),
      };
    const directory = await mkdtemp(join(tmpdir(), 'pi-share-'));
    try {
      const path = join(directory, 'session.html');
      await session.exportToHtml(path);
      return {
        name: 'session.html',
        contentType: 'text/html',
        data: await readFile(path, 'utf8'),
      };
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  },
  async shareUpload(session, destination, file, signal) {
    if (destination === 'radius') {
      const token = await radiusToken(session, signal);
      signal.throwIfAborted();
      if (!token)
        throw new Error(
          "Radius authentication is not configured. Run '/login radius' first. No upload was made.",
        );
      // Match Pi's session-share.js artifact destination and organization visibility.
      const url = new URL('/v1/artifacts', DEFAULT_RADIUS_GATEWAY);
      url.searchParams.set('visibility', 'organization');
      url.searchParams.set('title', 'Pi session');
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': file.contentType,
        },
        body: file.data,
        signal,
      });
      const result = (await response.json()) as {
        artifact?: {canonical_url?: string};
        error?: string;
      };
      const urlResult = result.artifact?.canonical_url;
      if (!response.ok || typeof urlResult !== 'string' || !urlResult)
        throw new Error(
          result.error || `Radius upload failed: ${response.status}`,
        );
      return urlResult;
    }
    await gh(['auth', 'status'], signal);
    const directory = await mkdtemp(join(tmpdir(), 'pi-share-'));
    try {
      const path = join(directory, 'session.html');
      await writeFile(path, file.data, {mode: 0o600});
      const gistUrl = await gh(
        ['gist', 'create', '--public=false', path],
        signal,
      );
      const id =
        /^https:\/\/gist\.github\.com\/(?:[^/]+\/)?([a-f0-9]+)\/?$/i.exec(
          gistUrl,
        )?.[1];
      if (!id)
        throw new Error(
          `Gist created, but its URL could not be parsed: ${gistUrl}`,
        );
      const config = await internal<{getShareViewerUrl(id: string): string}>(
        './config.js',
      );
      return `${config.getShareViewerUrl(id)}\nGist: ${gistUrl}`;
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  },
  async bugBundle(session, options, summary) {
    // Same bundle construction as interactive/bug-report.js, without TUI overlays.
    const helpers = await internal<{
      collectBugReportMetadata(
        options: Record<string, unknown>,
      ): BugReportBundle['metadata'];
      collectBugReportDiagnostics(
        manager: AgentSession['sessionManager'],
        crashes: unknown[],
      ): BugReportBundle['diagnostics'];
    }>('./core/bug-report.js');
    const crash = await internal<{readCrashLog(): unknown[]}>(
      './core/crash-log.js',
    );
    const extensions = session.resourceLoader.getExtensions();
    return {
      metadata: helpers.collectBugReportMetadata({
        hint: options.hint,
        sessionId: session.sessionId,
        cwd: session.sessionManager.getCwd(),
        includeSession: options.includeSession,
        includeSummary: summary !== undefined,
        messageCount: session.messages.length,
        model: session.model,
        modelRuntime: session.modelRuntime,
        thinkingLevel: session.thinkingLevel,
        extensions: extensions.extensions,
        extensionErrors: extensions.errors,
        globalSettings: session.settingsManager.getGlobalSettings(),
        projectSettings: session.settingsManager.getProjectSettings(),
      }),
      diagnostics: helpers.collectBugReportDiagnostics(
        session.sessionManager,
        crash.readCrashLog(),
      ),
      summary,
      sessionJsonl: options.includeSession
        ? await serializeShare(session)
        : undefined,
    };
  },
  async bugFiles(bundle) {
    return (
      await internal<{bugReportFiles(bundle: BugReportBundle): ReportFile[]}>(
        './core/bug-report.js',
      )
    ).bugReportFiles(bundle);
  },
  async bugGateway() {
    return (
      await internal<{getRadiusGatewayUrl(): string}>('./core/radius.js')
    ).getRadiusGatewayUrl();
  },
  async uploadBug(session, bundle, signal, gateway) {
    const token = await radiusToken(session, signal);
    signal.throwIfAborted();
    const uploader = await internal<{
      uploadBugReport(
        bundle: BugReportBundle,
        options: {token?: string; signal: AbortSignal; gatewayUrl: string},
      ): Promise<{id: string}>;
    }>('./core/bug-report-upload.js');
    return (
      await uploader.uploadBugReport(bundle, {
        token,
        signal,
        gatewayUrl: gateway,
      })
    ).id;
  },
  async exportBug(bundle, path) {
    const helpers = await internal<{
      writeBugReportArchive(
        bundle: BugReportBundle,
        path: string,
      ): Promise<void>;
    }>('./core/bug-report.js');
    // Pi's archive writer uses the default umask. Build in a private directory,
    // restrict permissions before publishing, and never overwrite an existing file.
    const directory = await mkdtemp(join(tmpdir(), 'pi-bug-report-'));
    try {
      const archive = join(directory, 'report.zip');
      await helpers.writeBugReportArchive(bundle, archive);
      await chmod(archive, 0o600);
      await copyFile(archive, path, constants.COPYFILE_EXCL);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  },
  async recordBug(session, bundle, delivery) {
    session.sessionManager.appendCustomEntry('pi.bug-report', {
      id: bundle.metadata.id,
      createdAt: bundle.metadata.createdAt,
      hint: bundle.metadata.hint,
      sessionIncluded: bundle.metadata.session.included,
      summaryIncluded: bundle.metadata.session.summaryIncluded,
      ...delivery,
    });
    if (bundle.diagnostics.crashes.length) {
      (
        await internal<{clearCrashLog(): void}>('./core/crash-log.js')
      ).clearCrashLog();
    }
  },
  async readChangelog() {
    const config = await internal<{getChangelogPath(): string}>('./config.js');
    return readFile(config.getChangelogPath(), 'utf8');
  },
  offline: () => Boolean(process.env.PI_OFFLINE),
};

function cancelled(): never {
  throw new DOMException('Report command cancelled', 'AbortError');
}
function check(context: ReportCommandContext): void {
  context.signal?.throwIfAborted();
}

/** Native cancellable progress. Dismissal, Escape and either button cancel. */
async function progress<T>(
  context: ReportCommandContext,
  message: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  check(context);
  const controller = new AbortController();
  const dialog = new AbortController();
  const abort = () =>
    controller.abort(
      new DOMException('Report command cancelled', 'AbortError'),
    );
  context.signal?.addEventListener('abort', abort, {once: true});
  context.ui.context.setStatus('report-command', message);
  const pendingDialog = context.ui.context
    .confirm(
      message,
      'This operation is running. Dismiss this dialog to cancel. A cancelled upload may already have reached the server.',
      {signal: dialog.signal},
    )
    .then(() => {
      if (!dialog.signal.aborted) abort();
    }, abort);
  let onAbort: () => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, {once: true});
  });
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([operation(controller.signal), stopped]);
  } finally {
    dialog.abort();
    controller.signal.removeEventListener('abort', onAbort);
    context.signal?.removeEventListener('abort', abort);
    context.ui.context.setStatus('report-command', undefined);
    await pendingDialog;
  }
}

// Native readonly dialogs are bounded. Never silently truncate a reviewed file.
async function showText(
  context: ReportCommandContext,
  title: string,
  text: string,
): Promise<void> {
  const pages: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 240000, text.length);
    // Do not render the halves of a Unicode surrogate pair in separate dialogs.
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    pages.push(text.slice(start, end));
    start = end;
  }
  if (!pages.length) pages.push('');
  for (const [index, page] of pages.entries()) {
    check(context);
    await context.ui.show(
      pages.length > 1 ? `${title} (${index + 1}/${pages.length})` : title,
      page,
    );
    check(context);
  }
}
async function review(
  context: ReportCommandContext,
  files: ReportFile[],
): Promise<void> {
  for (const file of files)
    await showText(context, `Review ${file.name}`, file.data);
}

const sensitive =
  'Messages, model output, tool calls/results, file contents, command output, system prompts and tool schemas can contain secrets. No automatic transcript redaction is performed.';
const bugWarning =
  'This private report goes to the Pi developers (Earendil), not a public issue. It includes Pi/OS versions, model/provider configuration, extensions and settings (credential fields are redacted), provider errors and crash logs. Paths, free-text diagnostics and crash details may still contain sensitive data. Review every attached file before sending.';

async function share(
  context: ReportCommandContext,
  deps: ReportCommandDependencies,
): Promise<void> {
  if (deps.offline())
    throw new Error('Sharing requires online mode (PI_OFFLINE is set).');
  const {session, ui} = context;
  const setting = session.settingsManager.getSessionShareDestination();
  const destination: Destination =
    setting === 'gist'
      ? 'gist'
      : setting === 'radius' ||
          session.modelRuntime.getProviderAuthStatus('radius').configured
        ? 'radius'
        : 'gist';
  const warning =
    destination === 'radius'
      ? `Upload to ${DEFAULT_RADIUS_GATEWAY} as an organization-visible Radius artifact. Members of your organization can access it.`
      : 'Upload to GitHub as a secret (unlisted) gist using gh. A secret gist is NOT private: anyone with its link can read it. Pi’s session viewer can display it.';
  if (
    !(await ui.context.confirm(
      'Prepare session share?',
      `${warning}\n\n${sensitive}\n\nNext: review the complete exported payload locally. Nothing is uploaded until you confirm again.`,
      {signal: context.signal},
    ))
  )
    cancelled();
  const payload = await deps.sharePayload(session, destination);
  await review(context, [payload]);
  check(context);
  if (
    !(await ui.context.confirm(
      'Upload reviewed session?',
      `${warning}\n\nSend exactly the reviewed ${payload.name}? ${sensitive}`,
      {signal: context.signal},
    ))
  )
    cancelled();
  check(context);
  const url = await progress(context, 'Sharing session…', signal =>
    deps.shareUpload(session, destination, payload, signal),
  );
  check(context);
  await ui.show('Session shared', `Share URL: ${url}`);
}

async function bug(
  context: ReportCommandContext,
  hint: string,
  deps: ReportCommandDependencies,
): Promise<void> {
  const {session, ui} = context;
  await ui.show('Private Pi bug report', bugWarning);
  check(context);
  const description = await ui.context.editor(
    'What went wrong? (optional)',
    hint,
    {signal: context.signal},
  );
  if (description === undefined) cancelled();
  const options: BugOptions = {
    hint: description.trim() || undefined,
    includeSession: false,
  };
  const transcript = await ui.select(
    'Include the session transcript?',
    ['No', 'Yes, include the transcript'],
    {selected: 'No', message: sensitive},
  );
  if (!transcript) cancelled();
  options.includeSession = transcript === 'Yes, include the transcript';
  let summary: string | undefined;
  if (!options.includeSession) {
    const summarize = await ui.select(
      'Generate a summary instead?',
      ['No', 'Yes, generate a summary'],
      {
        selected: 'No',
        message: `Generating sends recent conversation content to ${session.model?.provider ?? 'the current provider'} using your credentials and tokens (may incur cost). Only the generated summary will be attached to the bug report. It can still contain sensitive data and will be reviewed before upload.`,
      },
    );
    if (!summarize) cancelled();
    if (summarize === 'Yes, generate a summary') {
      if (deps.offline())
        throw new Error('Generating a summary requires online mode.');
      summary = await progress(
        context,
        `Writing summary with ${session.model?.name ?? 'the current model'}…`,
        signal => session.summarizeForBugReport({hint: options.hint, signal}),
      );
    }
  }
  check(context);
  const bundle = await deps.bugBundle(session, options, summary);
  const gateway = await deps.bugGateway();
  await review(context, await deps.bugFiles(bundle));
  const delivery = await ui.select(
    'Deliver reviewed bug report',
    ['Upload Report', 'Export as Zip', 'Cancel'],
    {
      selected: 'Cancel',
      message: `${bugWarning}\n\nUpload destination: ${new URL('/v1/bug-reports', gateway).href}. Login is optional; Radius authentication attributes the report to your account.\nTranscript: ${options.includeSession ? 'included' : 'not included'}\nSummary: ${summary === undefined ? 'not included' : 'included'}`,
    },
  );
  check(context);
  if (!delivery || delivery === 'Cancel') cancelled();
  if (delivery === 'Upload Report') {
    if (deps.offline())
      throw new Error(
        'Uploading bug reports requires online mode. Choose Export as Zip instead.',
      );
    if (
      !(await ui.context.confirm(
        'Send private bug report?',
        `Send exactly the reviewed files to ${new URL('/v1/bug-reports', gateway).href}?\n\n${bugWarning}`,
        {signal: context.signal},
      ))
    )
      cancelled();
    check(context);
    try {
      const id = await progress(context, 'Uploading bug report…', signal =>
        deps.uploadBug(session, bundle, signal, gateway),
      );
      check(context);
      ui.context.notify(`Bug report uploaded. Report ID: ${id}`, 'info');
      await record(context, deps, bundle, {delivery: 'upload'});
      return;
    } catch (error) {
      if (isCancelled(context, error)) throw error;
      const fallback = await ui.select(
        'Bug report upload failed',
        ['Export as Zip', 'Cancel'],
        {selected: 'Cancel', message: errorMessage(error)},
      );
      if (fallback !== 'Export as Zip') cancelled();
    }
  }
  check(context);
  const path = join(
    session.sessionManager.getCwd(),
    `pi-bug-report-${bundle.metadata.id}.zip`,
  );
  if (
    !(await ui.context.confirm(
      'Export private bug report?',
      `Write the reviewed sensitive report locally to:\n${path}\n\nNothing will be uploaded.`,
      {signal: context.signal},
    ))
  )
    cancelled();
  check(context);
  await deps.exportBug(bundle, path);
  ui.context.notify(
    `Bug report exported to: ${path}\nReport ID: ${bundle.metadata.id}`,
    'info',
  );
  await record(context, deps, bundle, {delivery: 'zip', path});
}

async function record(
  context: ReportCommandContext,
  deps: ReportCommandDependencies,
  bundle: BugReportBundle,
  delivery: Delivery,
): Promise<void> {
  try {
    await deps.recordBug(context.session, bundle, delivery);
  } catch (error) {
    // A successful upload must never be mistaken for a retryable failure.
    context.ui.context.notify(
      `Report delivered, but its session receipt could not be saved: ${errorMessage(error)}`,
      'warning',
    );
  }
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function isCancelled(context: ReportCommandContext, error: unknown): boolean {
  return (
    Boolean(context.signal?.aborted) ||
    (error instanceof Error && error.name === 'AbortError')
  );
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
    check(context);
    if (name !== 'bug' && args.trim()) throw new Error(`Usage: /${name}`);
    if (name === 'share') await share(context, deps);
    else if (name === 'bug') await bug(context, args, deps);
    else await showText(context, 'Pi changelog', await deps.readChangelog());
  } catch (error) {
    context.ui.context.notify(
      isCancelled(context, error)
        ? 'Report command cancelled.'
        : errorMessage(error),
      isCancelled(context, error) ? 'info' : 'error',
    );
  }
  return true;
}
