import {glob, stat} from 'node:fs/promises';
import {isAbsolute, relative, resolve} from 'node:path';

export const DEFAULT_MAX_FILES = 100;
export const MAX_FILES = 500;

export interface QueryFile {
  absolutePath: string;
  displayPath: string;
}

export interface FileQueryMatches {
  pattern: string;
  exclude: readonly string[];
  maxFiles: number;
  files: readonly QueryFile[];
  limitReached: boolean;
}

type FileQueryInput = {
  path: string;
  exclude?: string[];
  maxFiles?: number;
};

type Selection = {
  toolName: string;
  cwd: string;
  pattern: string;
  exclude: string[];
  maxFiles: number;
};

type PreparedQuery = {
  signature: string;
  found: FileQueryMatches;
  paths: readonly string[];
};

const preparedQuery = Symbol('prepared file query');
const supportedTools = new Set([
  'json_query',
  'gamemaker_query',
  'image_query',
]);

function throwIfAborted(toolName: string, signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(`${toolName} cancelled.`);
}

function normalizePattern(value: string, label: string): string {
  const trimmed = value.trim();
  const pattern = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  if (!pattern) throw new Error(`${label} cannot be empty.`);
  return pattern;
}

function selection(toolName: string, input: unknown, cwd: string): Selection {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof (input as FileQueryInput).path !== 'string'
  )
    throw new Error(`${toolName} requires a file path.`);
  const params = input as FileQueryInput;
  const image = toolName === 'image_query';
  return {
    toolName,
    cwd: resolve(cwd),
    pattern: normalizePattern(params.path, `${toolName} path`),
    exclude: image
      ? (params.exclude ?? []).map(pattern =>
          normalizePattern(pattern, 'image_query exclude pattern'),
        )
      : [],
    maxFiles:
      params.maxFiles === undefined || !Number.isFinite(params.maxFiles)
        ? DEFAULT_MAX_FILES
        : Math.min(Math.max(Math.round(params.maxFiles), 1), MAX_FILES),
  };
}

function displayPath(cwd: string, absolutePath: string): string {
  const path = relative(cwd, absolutePath);
  return (
    path && !path.startsWith('..') && !isAbsolute(path) ? path : absolutePath
  ).replaceAll('\\', '/');
}

function prepared(
  input: object,
  requested: Selection,
): PreparedQuery | undefined {
  if (!Object.hasOwn(input, preparedQuery)) return undefined;
  const cached = (input as {[preparedQuery]: PreparedQuery})[preparedQuery];
  if (cached.signature !== JSON.stringify(requested))
    throw new Error(
      `${requested.toolName} file selection changed after permission checks.`,
    );
  return cached;
}

async function discover(
  requested: Selection,
  signal?: AbortSignal,
): Promise<FileQueryMatches> {
  const files: QueryFile[] = [];
  const seen = new Set<string>();
  let limitReached = false;
  throwIfAborted(requested.toolName, signal);
  for await (const match of glob(requested.pattern, {
    cwd: requested.cwd,
    ...(requested.exclude.length ? {exclude: requested.exclude} : {}),
  })) {
    throwIfAborted(requested.toolName, signal);
    const absolutePath = resolve(requested.cwd, match);
    if (requested.toolName === 'image_query' && seen.has(absolutePath))
      continue;
    try {
      if (!(await stat(absolutePath)).isFile()) continue;
    } catch {
      // Keep inaccessible or transient matches for the existing per-file errors.
    }
    if (files.length >= requested.maxFiles) {
      limitReached = true;
      break;
    }
    seen.add(absolutePath);
    files.push({
      absolutePath,
      displayPath: displayPath(requested.cwd, absolutePath),
    });
  }
  throwIfAborted(requested.toolName, signal);
  files.sort((left, right) =>
    left.displayPath.localeCompare(right.displayPath),
  );
  return {
    pattern: requested.pattern,
    exclude: Object.freeze([...requested.exclude]),
    maxFiles: requested.maxFiles,
    files: Object.freeze(files.map(file => Object.freeze(file))),
    limitReached,
  };
}

/** Execute a prepared selection, or discover files for a call without preflight. */
export async function getFileQueryMatches(
  toolName: string,
  input: unknown,
  cwd: string,
  signal?: AbortSignal,
): Promise<FileQueryMatches> {
  const requested = selection(toolName, input, cwd);
  throwIfAborted(toolName, signal);
  return (
    prepared(input as object, requested)?.found ?? discover(requested, signal)
  );
}

/** Bind policy checks and execution to the same files on the SDK's input object. */
export async function prepareFileQuery(
  toolName: string,
  input: unknown,
  cwd: string,
  signal?: AbortSignal,
): Promise<readonly string[] | undefined> {
  if (!supportedTools.has(toolName)) return undefined;
  const requested = selection(toolName, input, cwd);
  throwIfAborted(toolName, signal);
  const cached = prepared(input as object, requested);
  if (cached) return cached.paths;
  const found = Object.freeze(await discover(requested, signal));
  const paths = Object.freeze(found.files.map(file => file.absolutePath));
  Object.defineProperty(input, preparedQuery, {
    value: Object.freeze({signature: JSON.stringify(requested), found, paths}),
  });
  return paths;
}
