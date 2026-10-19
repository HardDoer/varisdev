import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
  type TruncationResult,
  withFileMutationQueue,
} from '@earendil-works/pi-coding-agent';
import {mkdtemp, readFile, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {Type} from 'typebox';
import {
  DEFAULT_MAX_FILES,
  MAX_FILES,
  getFileQueryMatches,
  type QueryFile,
} from './file-matches.ts';

const DEFAULT_MAX_GROUPS = 50;
const MAX_GROUPS = 500;
const MAX_GROUP_BY_PATHS = 8;
const MAX_SELECT_PATHS = 20;
const MAX_SAMPLES = 20;
const MAX_ROOT_KEYS = 100;
const MAX_QUERY_FILE_BYTES = 50 * 1024 * 1024;
const MAX_VALUE_CHARS = 500;
const MAX_SAMPLE_CHARS = 2_000;

const jsonQuerySchema = Type.Object({
  path: Type.String({
    description:
      'Structured-data file path or glob pattern, relative to the current project. Custom extensions are supported. Prefix with @ if helpful.',
  }),
  collectionPath: Type.Optional(
    Type.String({
      description:
        'Dot-separated path or RFC 6901 JSON Pointer to the array to query, for example objects or /objects. If omitted, a root array is queried directly and any other root value is treated as one item.',
    }),
  ),
  where: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        'Exact-match filters as field-path/value pairs. All filters must match. Paths may use dots or RFC 6901 JSON Pointers; a missing field does not equal null.',
    }),
  ),
  groupBy: Type.Optional(
    Type.Array(
      Type.String({
        description:
          'Field path used to group matching items. Missing values are counted as <missing>.',
      }),
      {
        description:
          'Optional field paths to group and count, for example ["properties.owner_id"]. Multiple paths form a combined group.',
        minItems: 1,
        maxItems: MAX_GROUP_BY_PATHS,
      },
    ),
  ),
  select: Type.Optional(
    Type.Array(
      Type.String({
        description: 'Field path to include in each sample.',
      }),
      {
        description:
          'Optional fields to include in samples. When omitted, samples contain compact previews of whole matching items.',
        minItems: 1,
        maxItems: MAX_SELECT_PATHS,
      },
    ),
  ),
  sampleLimit: Type.Optional(
    Type.Integer({
      description: `Number of matching items to sample per file. Defaults to 0. Maximum ${MAX_SAMPLES}.`,
      minimum: 0,
      maximum: MAX_SAMPLES,
    }),
  ),
  includeRootKeys: Type.Optional(
    Type.Boolean({
      description: `Include top-level object keys for each file. At most ${MAX_ROOT_KEYS} keys are shown.`,
    }),
  ),
  maxFiles: Type.Optional(
    Type.Integer({
      description: `Maximum files to process. Defaults to ${DEFAULT_MAX_FILES}. Maximum ${MAX_FILES}.`,
      minimum: 1,
      maximum: MAX_FILES,
    }),
  ),
  maxGroups: Type.Optional(
    Type.Integer({
      description: `Maximum groups to show per file, ordered by count. Defaults to ${DEFAULT_MAX_GROUPS}. Maximum ${MAX_GROUPS}.`,
      minimum: 1,
      maximum: MAX_GROUPS,
    }),
  ),
});

type ValuePath = {
  source: string;
  segments: string[];
};

type ExactFilter = ValuePath & {
  expected: unknown;
};

type QueryPlan = {
  collection?: ValuePath;
  filters: ExactFilter[];
  groupBy: ValuePath[];
  select: ValuePath[];
  sampleLimit: number;
  includeRootKeys: boolean;
  maxGroups: number;
};

type ResolvedValue =
  {found: true; value: unknown} | {found: false; value?: never};

type JsonQueryGroupDetails = {
  key: string;
  count: number;
};

type JsonQueryFileDetails = {
  path: string;
  rootType?: string;
  rootKeys?: string[];
  rootKeyCount?: number;
  collectionCount?: number;
  matchedCount?: number;
  groups?: JsonQueryGroupDetails[];
  totalGroupCount?: number;
  samples?: string[];
  error?: string;
};

type JsonQueryToolDetails = {
  request: {
    path: string;
    collectionPath?: string;
    where?: Record<string, unknown>;
    groupBy?: string[];
    select?: string[];
    sampleLimit: number;
    includeRootKeys: boolean;
    maxFiles: number;
    maxGroups: number;
  };
  summary: {
    filesProcessed: number;
    filesSucceeded: number;
    filesFailed: number;
    fileLimitReached: boolean;
    collectionCount: number;
    matchedCount: number;
  };
  files: JsonQueryFileDetails[];
  truncation?: TruncationResult;
  fullOutputPath?: string;
};

export type QueryToolConfiguration = {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  documentLabel: string;
  parseDocument: (source: string) => unknown;
};

function normalizeBoundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), minimum), maximum);
}

function decodeJsonPointerToken(token: string, path: string): string {
  if (/~(?:[^01]|$)/.test(token)) {
    throw new Error(
      `Invalid JSON Pointer ${JSON.stringify(path)}: "~" must be escaped as "~0" and "/" as "~1".`,
    );
  }
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function parseValuePath(source: string): ValuePath {
  const path = source.trim();
  if (!path || path === '$') return {source, segments: []};

  if (path.startsWith('/')) {
    return {
      source,
      segments: path
        .slice(1)
        .split('/')
        .map(token => decodeJsonPointerToken(token, path)),
    };
  }

  const withoutRoot = path.startsWith('$.') ? path.slice(2) : path;
  const segments = withoutRoot.split('.');
  if (segments.some(segment => segment.length === 0)) {
    throw new Error(
      `Invalid field path ${JSON.stringify(source)}: use an RFC 6901 JSON Pointer for keys containing dots or empty path segments.`,
    );
  }
  return {source, segments};
}

function uniquePaths(paths: string[] | undefined, label: string): ValuePath[] {
  const seen = new Set<string>();
  return (paths ?? []).map(path => {
    if (seen.has(path)) {
      throw new Error(`Duplicate ${label} path: ${JSON.stringify(path)}.`);
    }
    seen.add(path);
    return parseValuePath(path);
  });
}

function makeQueryPlan(params: {
  collectionPath?: string;
  where?: Record<string, unknown>;
  groupBy?: string[];
  select?: string[];
  sampleLimit?: number;
  includeRootKeys?: boolean;
  maxGroups?: number;
}): QueryPlan {
  const filters = Object.entries(params.where ?? {}).map(
    ([path, expected]): ExactFilter => ({
      ...parseValuePath(path),
      expected,
    }),
  );

  return {
    collection: params.collectionPath
      ? parseValuePath(params.collectionPath)
      : undefined,
    filters,
    groupBy: uniquePaths(params.groupBy, 'groupBy'),
    select: uniquePaths(params.select, 'select'),
    sampleLimit: normalizeBoundedInteger(params.sampleLimit, 0, 0, MAX_SAMPLES),
    includeRootKeys: params.includeRootKeys ?? false,
    maxGroups: normalizeBoundedInteger(
      params.maxGroups,
      DEFAULT_MAX_GROUPS,
      1,
      MAX_GROUPS,
    ),
  };
}

function resolveValue(value: unknown, path: ValuePath): ResolvedValue {
  let current = value;

  for (const segment of path.segments) {
    if (
      current === null ||
      typeof current !== 'object' ||
      !Object.hasOwn(current, segment)
    ) {
      return {found: false};
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return {found: true, value: current};
}

function rootType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function truncateChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function displayValue(value: ResolvedValue): string {
  if (!value.found) return '<missing>';
  return truncateChars(canonicalJson(value.value), MAX_VALUE_CHARS);
}

function matchesFilters(item: unknown, filters: ExactFilter[]): boolean {
  return filters.every(filter => {
    const actual = resolveValue(item, filter);
    return actual.found && isDeepStrictEqual(actual.value, filter.expected);
  });
}

function groupItem(
  item: unknown,
  groupBy: ValuePath[],
): {canonicalKey: string; displayKey: string} {
  const values = groupBy.map(path => ({
    path,
    value: resolveValue(item, path),
  }));
  const canonicalKey = values
    .map(({value}) =>
      value.found ? `value:${canonicalJson(value.value)}` : 'missing:',
    )
    .join('\u0000');
  const displayKey = values
    .map(({path, value}) => `${path.source}=${displayValue(value)}`)
    .join(' | ');
  return {canonicalKey, displayKey};
}

function sampleItem(item: unknown, select: ValuePath[]): string {
  if (select.length === 0) {
    return truncateChars(canonicalJson(item), MAX_SAMPLE_CHARS);
  }

  const fields: Record<string, unknown> = {};
  for (const path of select) {
    const selected = resolveValue(item, path);
    fields[path.source] = selected.found ? selected.value : '<missing>';
  }
  return truncateChars(canonicalJson(fields), MAX_SAMPLE_CHARS);
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncateChars(message.replace(/\s+/g, ' ').trim(), MAX_VALUE_CHARS);
}

function throwIfAborted(toolName: string, signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(`${toolName} cancelled.`);
}

async function queryFile(
  file: QueryFile,
  plan: QueryPlan,
  config: QueryToolConfiguration,
  signal?: AbortSignal,
): Promise<JsonQueryFileDetails> {
  try {
    throwIfAborted(config.name, signal);
    const fileStats = await stat(file.absolutePath);
    if (fileStats.size > MAX_QUERY_FILE_BYTES) {
      throw new Error(
        `File is ${formatSize(fileStats.size)}; the ${config.name} per-file limit is ${formatSize(MAX_QUERY_FILE_BYTES)}.`,
      );
    }

    const rawText = await readFile(file.absolutePath, {
      encoding: 'utf8',
      signal,
    });
    const document = config.parseDocument(rawText.replace(/^\uFEFF/, ''));
    const rootKeys =
      document !== null &&
      typeof document === 'object' &&
      !Array.isArray(document)
        ? Object.keys(document as Record<string, unknown>).sort()
        : [];

    let items: unknown[];
    if (plan.collection) {
      const collection = resolveValue(document, plan.collection);
      if (!collection.found) {
        throw new Error(
          `Collection path not found: ${JSON.stringify(plan.collection.source)}.`,
        );
      }
      if (!Array.isArray(collection.value)) {
        throw new Error(
          `Collection path ${JSON.stringify(plan.collection.source)} contains ${rootType(collection.value)}, not an array.`,
        );
      }
      items = collection.value;
    } else {
      items = Array.isArray(document) ? document : [document];
    }

    const groups = new Map<string, {key: string; count: number}>();
    const samples: string[] = [];
    let matchedCount = 0;

    for (const item of items) {
      if (!matchesFilters(item, plan.filters)) continue;
      matchedCount++;

      if (samples.length < plan.sampleLimit) {
        samples.push(sampleItem(item, plan.select));
      }

      if (plan.groupBy.length > 0) {
        const group = groupItem(item, plan.groupBy);
        const current = groups.get(group.canonicalKey);
        if (current) {
          current.count++;
        } else {
          groups.set(group.canonicalKey, {key: group.displayKey, count: 1});
        }
      }
    }

    const sortedGroups = [...groups.values()].sort(
      (left, right) =>
        right.count - left.count || left.key.localeCompare(right.key),
    );

    return {
      path: file.displayPath,
      rootType: rootType(document),
      ...(plan.includeRootKeys
        ? {
            rootKeys: rootKeys.slice(0, MAX_ROOT_KEYS),
            rootKeyCount: rootKeys.length,
          }
        : {}),
      collectionCount: items.length,
      matchedCount,
      ...(plan.groupBy.length > 0
        ? {
            groups: sortedGroups.slice(0, plan.maxGroups),
            totalGroupCount: sortedGroups.length,
          }
        : {}),
      ...(plan.sampleLimit > 0 ? {samples} : {}),
    };
  } catch (error) {
    throwIfAborted(config.name, signal);
    return {path: file.displayPath, error: describeError(error)};
  }
}

function formatQueryDescription(details: JsonQueryToolDetails): string {
  const parts = [`collection=${details.request.collectionPath ?? '<root>'}`];
  const filters = Object.entries(details.request.where ?? {});
  if (filters.length > 0) {
    parts.push(
      `where ${filters
        .map(([path, value]) => `${path}=${displayValue({found: true, value})}`)
        .join(', ')}`,
    );
  }
  if (details.request.groupBy?.length) {
    parts.push(`groupBy=${details.request.groupBy.join(',')}`);
  }
  return parts.join('; ');
}

function formatQueryResult(details: JsonQueryToolDetails): string {
  const {summary} = details;
  const lines = [
    `Path: ${details.request.path}`,
    `Files: ${summary.filesProcessed} processed, ${summary.filesSucceeded} succeeded, ${summary.filesFailed} failed${summary.fileLimitReached ? ` (limit ${details.request.maxFiles} reached; more files matched)` : ''}`,
    `Query: ${formatQueryDescription(details)}`,
    `Totals: ${summary.matchedCount} matched of ${summary.collectionCount} items`,
  ];

  for (const file of details.files) {
    lines.push('', file.path);
    if (file.error) {
      lines.push(`  error: ${file.error}`);
      continue;
    }

    lines.push(`  root: ${file.rootType}`);
    if (file.rootKeys && file.rootKeyCount !== undefined) {
      const omitted = file.rootKeyCount - file.rootKeys.length;
      lines.push(
        `  root keys (${file.rootKeyCount}): ${file.rootKeys.join(', ') || '(none)'}${omitted > 0 ? ` (+${omitted} more)` : ''}`,
      );
    }
    lines.push(
      `  matched: ${file.matchedCount} of ${file.collectionCount} items`,
    );

    if (file.groups && file.totalGroupCount !== undefined) {
      lines.push(
        `  groups (${file.totalGroupCount}${file.groups.length < file.totalGroupCount ? `; showing ${file.groups.length}` : ''}):`,
      );
      for (const group of file.groups) {
        lines.push(`    ${group.count}  ${group.key}`);
      }
      if (file.groups.length === 0) lines.push('    (none)');
    }

    if (file.samples) {
      lines.push(`  samples (${file.samples.length}):`);
      for (const sample of file.samples) lines.push(`    ${sample}`);
      if (file.samples.length === 0) lines.push('    (none)');
    }
  }

  return lines.join('\n');
}

async function truncateQueryOutput(
  output: string,
  details: JsonQueryToolDetails,
  toolName: string,
): Promise<string> {
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) return output;

  const tempDir = await mkdtemp(
    join(tmpdir(), `pi-${toolName.replaceAll('_', '-')}-`),
  );
  const outputPath = join(tempDir, 'output.txt');
  await withFileMutationQueue(outputPath, async () => {
    await writeFile(outputPath, output, 'utf8');
  });
  details.truncation = truncation;
  details.fullOutputPath = outputPath;

  return `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${outputPath}]`;
}

export function registerQueryTool(
  pi: ExtensionAPI,
  config: QueryToolConfiguration,
): void {
  pi.registerTool<typeof jsonQuerySchema, JsonQueryToolDetails>({
    name: config.name,
    label: config.label,
    description: config.description,
    promptSnippet: config.promptSnippet,
    promptGuidelines: config.promptGuidelines,
    parameters: jsonQuerySchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const plan = makeQueryPlan(params);
      const found = await getFileQueryMatches(
        config.name,
        params,
        ctx.cwd,
        signal,
      );
      const {pattern, maxFiles} = found;
      if (found.files.length === 0) {
        throw new Error(
          `No files matched ${config.name} path ${JSON.stringify(pattern)} from ${ctx.cwd}.`,
        );
      }

      const files: JsonQueryFileDetails[] = [];
      for (const file of found.files) {
        files.push(await queryFile(file, plan, config, signal));
      }

      const succeededFiles = files.filter(file => !file.error);
      if (succeededFiles.length === 0) {
        const shownErrors = files
          .slice(0, 5)
          .map(file => `${file.path}: ${file.error}`)
          .join('; ');
        const omittedErrors = files.length - 5;
        throw new Error(
          `Could not query any matched ${config.documentLabel}. ${shownErrors}${omittedErrors > 0 ? `; and ${omittedErrors} more error(s)` : ''}`,
        );
      }

      const details: JsonQueryToolDetails = {
        request: {
          path: pattern,
          collectionPath: params.collectionPath,
          where: params.where,
          groupBy: params.groupBy,
          select: params.select,
          sampleLimit: plan.sampleLimit,
          includeRootKeys: plan.includeRootKeys,
          maxFiles,
          maxGroups: plan.maxGroups,
        },
        summary: {
          filesProcessed: files.length,
          filesSucceeded: succeededFiles.length,
          filesFailed: files.length - succeededFiles.length,
          fileLimitReached: found.limitReached,
          collectionCount: succeededFiles.reduce(
            (total, file) => total + (file.collectionCount ?? 0),
            0,
          ),
          matchedCount: succeededFiles.reduce(
            (total, file) => total + (file.matchedCount ?? 0),
            0,
          ),
        },
        files,
      };
      const output = formatQueryResult(details);

      return {
        content: [
          {
            type: 'text',
            text: await truncateQueryOutput(output, details, config.name),
          },
        ],
        details,
      };
    },
  });
}

export function registerJsonQueryTool(pi: ExtensionAPI): void {
  registerQueryTool(pi, {
    name: 'json_query',
    label: 'JSON Query',
    description:
      'Inspect and query one or many strict JSON files without writing an ad-hoc script. Supports globbing (including JSON stored under custom extensions), root-key inspection, exact nested-field filters, per-file group counts, and selected samples. Output is truncated to 2000 lines or 50KB, with full output saved to a temporary file.',
    promptSnippet:
      'Inspect and summarize strict JSON files with globs, nested equality filters, group counts, and samples instead of writing one-off scripts.',
    promptGuidelines: [
      'Use json_query instead of ad-hoc Python, Node, jq, or shell scripts when inspecting or counting strict JSON data. Use gamemaker_query for GameMaker .yy and .yyp files because they can contain trailing commas.',
      'json_query paths accept dot-separated fields such as properties.owner_id or RFC 6901 JSON Pointers for keys containing dots or slashes.',
      'Use json_query collectionPath for a nested array, where for exact filters, groupBy for Counter-style counts, and select plus sampleLimit for representative records.',
      'If you notice unexpected or unfinished behavior when using json_query, report it to the user.',
    ],
    documentLabel: 'JSON files',
    parseDocument: source => JSON.parse(source) as unknown,
  });
}
