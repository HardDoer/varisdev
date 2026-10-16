import {mkdir, open, readFile, realpath, rm, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {extname, isAbsolute, resolve} from 'node:path';
import {
  CURRENT_SESSION_VERSION,
  parseSessionEntries,
  SessionManager,
  type AgentSession,
  type ExtensionUIContext,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';

export type SessionCommandResult =
  | {kind: 'done'; message?: string}
  | {kind: 'cancelled'}
  | {
      kind: 'replace';
      replacement: {sessionFile: string; cwd: string; editorText?: string};
    };

/** Structural subset of DesktopExtensionUI, also usable by headless tests. */
export interface SessionCommandUI {
  show(title: string, message: string): Promise<void>;
  select(
    title: string,
    options: string[],
    optionsConfig?: {selected?: string; message?: string; searchable?: boolean},
  ): Promise<string | undefined>;
  context: Pick<ExtensionUIContext, 'input' | 'confirm' | 'setEditorText'>;
}

const cancelled = {kind: 'cancelled'} as const;
const PAGE_SIZE = 1000;
const MAX_IMPORT_BYTES = 128 * 1024 * 1024;
const ABORTED = Symbol('session command aborted');

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw ABORTED;
}
const SENSITIVE =
  'Sessions may contain prompts, model responses, tool arguments, command output, file contents, extension messages, and secrets. Review the exported file before sharing it.';

function fileArgument(argument: string, cwd: string): string | undefined {
  let value = argument.trim();
  if (!value) return undefined;
  if (value.startsWith('"') || value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith(value[0]))
      throw new Error('The file path has an unmatched quote.');
    value = value.slice(1, -1);
  }
  if (!value.trim()) return undefined;
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\'))
    return resolve(homedir(), value.slice(2));
  return resolve(cwd, value);
}

function preview(value: unknown): string {
  if (typeof value === 'string')
    return value.replace(/\s+/g, ' ').slice(0, 140);
  if (!Array.isArray(value)) return '';
  return preview(
    value
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join(''),
  );
}

function describe(entry: SessionEntry): string {
  if (entry.type === 'message') {
    const message = entry.message;
    return `${message.role}: ${preview('content' in message ? message.content : '')}`;
  }
  if (entry.type === 'custom_message')
    return `${entry.customType}: ${preview(entry.content)}`;
  if (entry.type === 'compaction' || entry.type === 'branch_summary')
    return `${entry.type}: ${preview(entry.summary)}`;
  if (entry.type === 'session_info') return `name: ${preview(entry.name)}`;
  return entry.type;
}

/** Keep the entire history accessible without exceeding native dialog limits. */
async function selectEntry(
  ui: SessionCommandUI,
  title: string,
  choices: Array<{id: string; label: string}>,
  selectedId?: string | null,
  message?: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const index = choices.findIndex(choice => choice.id === selectedId);
  let page = Math.floor(Math.max(0, index) / PAGE_SIZE);
  for (;;) {
    checkCancelled(signal);
    const start = page * PAGE_SIZE;
    const slice = choices.slice(start, start + PAGE_SIZE);
    const previous = '← Previous page';
    const next = 'Next page →';
    const options = [
      ...(page ? [previous] : []),
      ...slice.map(choice => choice.label),
      ...(start + PAGE_SIZE < choices.length ? [next] : []),
    ];
    const selected = slice.find(choice => choice.id === selectedId)?.label;
    const answer = await ui.select(title, options, {
      ...(selected ? {selected} : {}),
      searchable: true,
      message: [
        message,
        choices.length > PAGE_SIZE
          ? `Page ${page + 1} of ${Math.ceil(choices.length / PAGE_SIZE)}`
          : undefined,
      ]
        .filter(Boolean)
        .join('\n'),
    });
    checkCancelled(signal);
    if (answer === undefined) return undefined;
    if (answer === previous && page) page--;
    else if (answer === next && start + PAGE_SIZE < choices.length) page++;
    else return slice.find(choice => choice.label === answer)?.id;
  }
}

/**
 * The SDK's branch operation changes its manager and defers header-only writes.
 * Run it on a detached snapshot, then persist its canonical entries under a
 * fresh SDK-generated identity. This also supports ephemeral live sessions and
 * forks before the first user message without ever changing the live manager.
 */
async function prepareBranch(
  session: AgentSession,
  leafId: string | null,
  signal?: AbortSignal,
): Promise<{sessionFile: string; cwd: string}> {
  checkCancelled(signal);
  const live = session.sessionManager;
  const cwd = live.getCwd();
  const snapshot = SessionManager.inMemory(
    cwd,
    undefined,
    structuredClone([live.getHeader()!, ...live.getEntries()]),
  );
  if (leafId) snapshot.createBranchedSession(leafId);
  else snapshot.newSession();
  return persistSnapshot(snapshot, cwd, live.getSessionFile(), signal);
}

/** Persist only SDK-canonical entries, including migrations, under a new header. */
async function persistSnapshot(
  snapshot: SessionManager,
  cwd: string,
  parentSession?: string,
  signal?: AbortSignal,
): Promise<{sessionFile: string; cwd: string}> {
  checkCancelled(signal);
  const prepared = SessionManager.create(cwd, undefined, {parentSession});
  const sessionFile = prepared.getSessionFile()!;
  await mkdir(prepared.getSessionDir(), {recursive: true});
  checkCancelled(signal);
  const output = await open(sessionFile, 'wx', 0o600);
  try {
    try {
      await output.writeFile(
        [prepared.getHeader()!, ...snapshot.getEntries()]
          .map(entry => JSON.stringify(entry))
          .join('\n') + '\n',
      );
      checkCancelled(signal);
    } finally {
      await output.close();
    }
  } catch (error) {
    await rm(sessionFile, {force: true});
    throw error;
  }
  return {sessionFile, cwd};
}

async function fork(
  session: AgentSession,
  entryId: string,
  position: 'before' | 'at',
  signal?: AbortSignal,
): Promise<SessionCommandResult> {
  checkCancelled(signal);
  const runner = session.extensionRunner;
  if (runner.hasHandlers('session_before_fork')) {
    const result = await runner.emit({
      type: 'session_before_fork',
      entryId,
      position,
    });
    if (result?.cancel) return cancelled;
  }
  checkCancelled(signal);
  const entry = session.sessionManager.getEntry(entryId);
  if (
    !entry ||
    (position === 'before' &&
      (entry.type !== 'message' || entry.message.role !== 'user'))
  )
    throw new Error('Invalid entry ID for forking.');
  const editorText =
    position === 'before' &&
    entry.type === 'message' &&
    entry.message.role === 'user'
      ? typeof entry.message.content === 'string'
        ? entry.message.content
        : entry.message.content
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join('')
      : '';
  const replacement = await prepareBranch(
    session,
    position === 'at' ? entry.id : entry.parentId,
    signal,
  );
  try {
    await session.abort();
    checkCancelled(signal);
  } catch (error) {
    await rm(replacement.sessionFile, {force: true});
    throw error;
  }
  return {kind: 'replace', replacement: {...replacement, editorText}};
}

/** Parse/migrate with Pi, without opening (and possibly rewriting) the source. */
function validateImport(content: string, cwd: string): SessionManager {
  const entries = parseSessionEntries(content);
  if (
    entries.length !== content.split('\n').filter(line => line.trim()).length ||
    entries.some(entry => !entry || typeof entry !== 'object')
  )
    throw new Error('Import is not a valid Pi JSONL session.');
  const header = entries[0];
  if (
    !header ||
    header.type !== 'session' ||
    typeof header.id !== 'string' ||
    !header.id ||
    typeof header.timestamp !== 'string' ||
    (header.version !== undefined &&
      (!Number.isInteger(header.version) ||
        header.version < 1 ||
        header.version > CURRENT_SESSION_VERSION)) ||
    entries.slice(1).some(entry => entry.type === 'session')
  )
    throw new Error('Import requires a supported Pi session header.');
  const manager = SessionManager.inMemory(cwd, undefined, entries);
  // Pi accepts orphaned roots, but cycles/duplicate IDs are unsafe to traverse.
  // Reject malformed structure, never repair or synthesize imported messages.
  const parents = new Map<string, string | null>();
  for (const entry of manager.getEntries()) {
    if (
      typeof entry.type !== 'string' ||
      typeof entry.id !== 'string' ||
      !entry.id ||
      parents.has(entry.id) ||
      (entry.parentId !== null && typeof entry.parentId !== 'string')
    )
      throw new Error('Import has invalid session entry links.');
    parents.set(entry.id, entry.parentId);
  }
  const checked = new Set<string>();
  for (const id of parents.keys()) {
    const path = new Set<string>();
    let current: string | null = id;
    while (current !== null && parents.has(current) && !checked.has(current)) {
      if (path.has(current))
        throw new Error('Import has cyclic session entry links.');
      path.add(current);
      current = parents.get(current)!;
    }
    for (const visited of path) checked.add(visited);
  }
  manager.buildSessionProjection();
  return manager;
}

async function importSession(
  session: AgentSession,
  ui: SessionCommandUI,
  args: string,
  signal?: AbortSignal,
): Promise<SessionCommandResult> {
  const currentCwd = session.sessionManager.getCwd();
  const argument =
    args.trim() ||
    (await ui.context.input('Import session', 'Path to a Pi .jsonl session', {
      signal,
    }));
  checkCancelled(signal);
  if (argument === undefined) return cancelled;
  const source = fileArgument(argument, currentCwd);
  if (!source) return cancelled;
  const info = await stat(source);
  if (!info.isFile()) throw new Error('Import path must be a JSONL file.');
  if (info.size > MAX_IMPORT_BYTES)
    throw new Error('Import exceeds the 128 MiB session size limit.');
  const content = await readFile(source, {encoding: 'utf8', signal});
  checkCancelled(signal);
  if (Buffer.byteLength(content) > MAX_IMPORT_BYTES)
    throw new Error('Import exceeds the 128 MiB session size limit.');
  const imported = validateImport(content, currentCwd);
  const storedCwd = imported.getHeader()?.cwd;
  let cwd =
    typeof storedCwd === 'string' && isAbsolute(storedCwd)
      ? storedCwd
      : undefined;
  if (cwd && !(await stat(cwd).catch(() => undefined))?.isDirectory())
    cwd = undefined;
  if (!cwd) {
    if (
      !(await ui.context.confirm(
        'Session working directory unavailable',
        `Stored working directory: ${storedCwd || '(missing)'}\nImport into ${currentCwd} instead?`,
        {signal},
      ))
    )
      return cancelled;
    cwd = currentCwd;
  }
  if (
    !(await ui.context.confirm(
      'Import session',
      `Open a new saved copy of ${source} in ${cwd}? The current session remains saved. Imported tool output and file contents may be sensitive.`,
      {signal},
    ))
  )
    return cancelled;
  checkCancelled(signal);
  const runner = session.extensionRunner;
  if (runner.hasHandlers('session_before_switch')) {
    const result = await runner.emit({
      type: 'session_before_switch',
      reason: 'resume',
      targetSessionFile: source,
    });
    if (result?.cancel) return cancelled;
  }
  checkCancelled(signal);
  // Persist the same validated, SDK-migrated snapshot, not a second read of an
  // untrusted source that may have changed while confirmation dialogs were open.
  const prepared = await persistSnapshot(imported, cwd, source, signal);
  try {
    await session.abort();
    checkCancelled(signal);
  } catch (error) {
    await rm(prepared.sessionFile, {force: true});
    throw error;
  }
  return {
    kind: 'replace',
    replacement: {...prepared, editorText: ''},
  };
}

async function protectLiveSession(
  session: AgentSession,
  destination: string,
): Promise<void> {
  if (!session.sessionFile) return;
  const [livePath, outputPath] = await Promise.all([
    realpath(session.sessionFile).catch(() => resolve(session.sessionFile!)),
    realpath(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return resolve(destination);
    }),
  ]);
  if (livePath === outputPath)
    throw new Error('Export cannot overwrite the live session file.');
  const [live, output] = await Promise.all([
    stat(livePath).catch(() => undefined),
    stat(outputPath).catch(() => undefined),
  ]);
  if (live && output && live.dev === output.dev && live.ino === output.ino)
    throw new Error('Export cannot overwrite the live session file.');
}

async function exportSession(
  session: AgentSession,
  ui: SessionCommandUI,
  args: string,
  signal?: AbortSignal,
): Promise<SessionCommandResult> {
  const cwd = session.sessionManager.getCwd();
  const argument =
    args.trim() ||
    (await ui.context.input(
      'Export session',
      'Destination path (.html or .jsonl); cancel to keep files unchanged',
      {signal},
    ));
  checkCancelled(signal);
  if (argument === undefined) return cancelled;
  const destination = fileArgument(argument, cwd);
  if (!destination) return cancelled;
  const extension = extname(destination).toLowerCase();
  if (extension !== '.html' && extension !== '.jsonl')
    throw new Error('Choose a destination ending in .html or .jsonl.');
  await protectLiveSession(session, destination);
  if (
    !(await ui.context.confirm('Export session — sensitive data', SENSITIVE, {
      signal,
    }))
  )
    return cancelled;
  const existing = await stat(destination).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    },
  );
  if (existing) {
    if (!existing.isFile())
      throw new Error('Export destination must be a file.');
    if (
      !(await ui.context.confirm(
        'Overwrite export?',
        `Replace ${destination}?`,
        {signal},
      ))
    )
      return cancelled;
  }
  await protectLiveSession(session, destination);
  checkCancelled(signal);
  const output =
    extension === '.jsonl'
      ? session.exportToJsonl(destination)
      : await session.exportToHtml(destination);
  return {
    kind: 'done',
    message: `Session exported to ${output}. Review it before sharing.`,
  };
}

/** Native session interactions. Replacement/refresh and lifecycle belong to the host. */
async function executeSessionCommand(
  name: string,
  args: string,
  {
    session,
    ui,
    signal,
  }: {session: AgentSession; ui: SessionCommandUI; signal?: AbortSignal},
): Promise<SessionCommandResult | undefined> {
  checkCancelled(signal);
  if (['tree', 'fork', 'clone', 'session'].includes(name) && args.trim())
    throw new Error(`Usage: /${name} (this command takes no arguments).`);
  switch (name) {
    case 'tree': {
      const manager = session.sessionManager;
      const choices: Array<{id: string; label: string}> = [];
      const stack = manager
        .getTree()
        .map(node => ({node, depth: 0}))
        .reverse();
      while (stack.length) {
        const {node, depth} = stack.pop()!;
        choices.push({
          id: node.entry.id,
          label: `${node.entry.id === manager.getLeafId() ? '→ ' : ''}[${node.entry.id}] ${'  '.repeat(Math.min(depth, 12))}${describe(node.entry)}${node.label ? ` (${preview(node.label)})` : ''}`,
        });
        for (let i = node.children.length - 1; i >= 0; i--)
          stack.push({node: node.children[i], depth: depth + 1});
      }
      if (!choices.length)
        return {kind: 'done', message: 'No entries in this session.'};
      const selected = await selectEntry(
        ui,
        'Session tree',
        choices,
        manager.getLeafId(),
        'Select a user message to edit it, or another entry to continue after it. No branch summary or model request is made.',
        signal,
      );
      if (!selected) return cancelled;
      if (selected === manager.getLeafId())
        return {kind: 'done', message: 'Already at this point.'};
      if (session.isStreaming) await session.abort();
      checkCancelled(signal);
      const result = await session.navigateTree(selected, {summarize: false});
      if (result.cancelled || result.aborted) return cancelled;
      ui.context.setEditorText(result.editorText ?? '');
      return {kind: 'done', message: 'Session tree position updated.'};
    }
    case 'fork': {
      const messages = session.getUserMessagesForForking();
      if (!messages.length)
        return {kind: 'done', message: 'No user messages to fork from.'};
      const selected = await selectEntry(
        ui,
        'Fork session',
        messages.map(message => ({
          id: message.entryId,
          label: `[${message.entryId}] ${preview(message.text)}`,
        })),
        messages.at(-1)?.entryId,
        'Create a separate saved session before the selected user message, with its text restored to the editor.',
        signal,
      );
      return selected ? fork(session, selected, 'before', signal) : cancelled;
    }
    case 'clone': {
      const leaf = session.sessionManager.getLeafId();
      return leaf
        ? fork(session, leaf, 'at', signal)
        : {kind: 'done', message: 'Nothing to clone yet.'};
    }
    case 'import':
      return importSession(session, ui, args, signal);
    case 'export':
      return exportSession(session, ui, args, signal);
    case 'session': {
      const stats = session.getSessionStats();
      await ui.show(
        'Session information',
        [
          `Name: ${session.sessionManager.getSessionName() ?? '(unnamed)'}`,
          `ID: ${stats.sessionId}`,
          `File: ${stats.sessionFile ?? '(in memory)'}`,
          `Working directory: ${session.sessionManager.getCwd()}`,
          `Messages: ${stats.totalMessages} (${stats.userMessages} user, ${stats.assistantMessages} assistant, ${stats.toolResults} tool results)`,
          `Tool calls: ${stats.toolCalls}`,
          `Tokens: ${stats.tokens.total} (input ${stats.tokens.input}, output ${stats.tokens.output}, cache read ${stats.tokens.cacheRead}, cache write ${stats.tokens.cacheWrite})`,
          `Cost: $${stats.cost.toFixed(6)}`,
        ].join('\n'),
      );
      return {kind: 'done'};
    }
    case 'name': {
      const value =
        args.trim() ||
        (await ui.context.input(
          'Session name',
          session.sessionManager.getSessionName() ?? 'New display name',
          {signal},
        ));
      checkCancelled(signal);
      if (value === undefined || !value.trim()) return cancelled;
      session.setSessionName(value.trim());
      return {kind: 'done', message: `Session named ${value.trim()}.`};
    }
    default:
      return undefined;
  }
}

export async function runSessionCommand(
  name: string,
  args: string,
  context: {session: AgentSession; ui: SessionCommandUI; signal?: AbortSignal},
): Promise<SessionCommandResult | undefined> {
  if (
    !['tree', 'fork', 'clone', 'import', 'export', 'session', 'name'].includes(
      name,
    )
  )
    return undefined;
  try {
    return await executeSessionCommand(name, args, context);
  } catch (error) {
    if (error === ABORTED || context.signal?.aborted) return cancelled;
    throw error;
  }
}
