import {formatSize, type ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {Type} from 'typebox';

const DEFAULT_BROWSE_TIMEOUT_MS = 30_000;
const MAX_BROWSE_TIMEOUT_MS = 120_000;
const BODY_READ_LIMIT_BYTES = 512 * 1024;
const JSON_BODY_READ_LIMIT_BYTES = 10 * 1024 * 1024;
const DEFAULT_OUTPUT_CHARS = 6_000;
const MIN_OUTPUT_CHARS = 500;
const MAX_OUTPUT_CHARS = 24_000;
const DEFAULT_LINK_LIMIT = 25;
const MAX_LINK_LIMIT = 100;
const MAX_JSON_POINTERS = 20;
const DEFAULT_VIEW: BrowseView = 'auto';
const MAX_OUTPUT_LINES = 1_200;

const BROWSE_VIEWS = ['auto', 'text', 'links', 'raw', 'none'] as const;

type BrowseView = (typeof BROWSE_VIEWS)[number];

type BodySample = {
  bytes: Uint8Array;
  truncated: boolean;
};

type LimitedText = {
  content: string;
  truncated: boolean;
  totalChars: number;
  outputChars: number;
  totalLines: number;
  outputLines: number;
};

type BrowseLink = {
  text: string;
  url: string;
};

type LinkExtraction = {
  links: BrowseLink[];
  totalLinks: number;
};

type BrowseToolDetails = {
  request: {
    url: string;
    method: string;
    view: BrowseView;
    maxChars: number;
    maxLinks: number;
    jsonPointers?: string[];
    timeoutMs: number;
  };
  response: {
    url: string;
    status: number;
    statusText: string;
    ok: boolean;
    headers: Record<string, string>;
    contentType: string;
    contentLength?: number;
    bodyBytesRead: number;
    bodyReadLimitBytes: number;
    bodyReadTruncated: boolean;
    textBody: boolean;
    htmlBody: boolean;
    title?: string;
    links?: BrowseLink[];
    totalLinks?: number;
    textTruncated?: boolean;
  };
};

const browseSchema = Type.Object({
  url: Type.String({description: 'HTTP or HTTPS URL to browse.'}),
  method: Type.Optional(
    Type.String({description: 'HTTP method. Defaults to GET.'}),
  ),
  headers: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        'Request headers as name/value strings. Do not include secrets unless the user explicitly provided them.',
    }),
  ),
  body: Type.Optional(
    Type.String({
      description: 'Optional UTF-8 request body. Not allowed for GET or HEAD.',
    }),
  ),
  view: Type.Optional(
    Type.String({
      description:
        'Output view: auto (default compact text), text (force text extraction), links (only links), raw (raw text body), or none (status only).',
    }),
  ),
  jsonPointers: Type.Optional(
    Type.Array(
      Type.String({
        description:
          'RFC 6901 JSON Pointer to select from a JSON response, for example /schemas/Track. Use an empty string to select the document root.',
      }),
      {
        description: `Select and return only these fields from a JSON response. This reads up to ${formatSize(JSON_BODY_READ_LIMIT_BYTES)} so large API and discovery documents can be queried without shell HTTP clients. Maximum ${MAX_JSON_POINTERS} pointers.`,
        minItems: 1,
        maxItems: MAX_JSON_POINTERS,
      },
    ),
  ),
  maxChars: Type.Optional(
    Type.Number({
      description: `Approximate maximum characters of page/body text to return. Defaults to ${DEFAULT_OUTPUT_CHARS}, or ${MAX_OUTPUT_CHARS} when jsonPointers is set. Maximum ${MAX_OUTPUT_CHARS}.`,
      minimum: MIN_OUTPUT_CHARS,
      maximum: MAX_OUTPUT_CHARS,
    }),
  ),
  maxLinks: Type.Optional(
    Type.Number({
      description: `Maximum links to return when view="links". Defaults to ${DEFAULT_LINK_LIMIT}. Maximum ${MAX_LINK_LIMIT}.`,
      minimum: 1,
      maximum: MAX_LINK_LIMIT,
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description: `Request timeout in milliseconds. Defaults to ${DEFAULT_BROWSE_TIMEOUT_MS}. Maximum ${MAX_BROWSE_TIMEOUT_MS}.`,
      minimum: 1,
      maximum: MAX_BROWSE_TIMEOUT_MS,
    }),
  ),
});

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  bull: '•',
  copy: '©',
  gt: '>',
  hellip: '…',
  ldquo: '“',
  lsquo: '‘',
  mdash: '—',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
  rdquo: '”',
  reg: '®',
  rsquo: '’',
  shy: '',
  trade: '™',
};

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    (timer as {unref?: () => void}).unref?.();
  }
}

function normalizeHttpUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    throw new Error(
      `Invalid URL: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('browse only supports http:// and https:// URLs.');
  }

  return parsed.toString();
}

function normalizeHttpMethod(method?: string): string {
  const normalized = (method ?? 'GET').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]*$/.test(normalized)) {
    throw new Error(`Invalid HTTP method: ${method}`);
  }
  return normalized;
}

function normalizeTimeout(timeoutMs?: number): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
    return DEFAULT_BROWSE_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.round(timeoutMs), 1), MAX_BROWSE_TIMEOUT_MS);
}

function normalizeBoundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), minimum), maximum);
}

function normalizeBrowseView(view?: string): BrowseView {
  const normalized = (view ?? DEFAULT_VIEW).trim().toLowerCase();
  if ((BROWSE_VIEWS as readonly string[]).includes(normalized)) {
    return normalized as BrowseView;
  }
  throw new Error(`Invalid browse view: ${view}`);
}

function normalizeJsonPointers(jsonPointers?: string[]): string[] | undefined {
  if (jsonPointers === undefined) return undefined;
  if (jsonPointers.length === 0) {
    throw new Error('jsonPointers must contain at least one JSON Pointer.');
  }
  if (jsonPointers.length > MAX_JSON_POINTERS) {
    throw new Error(
      `Too many JSON Pointers: ${jsonPointers.length}. Maximum is ${MAX_JSON_POINTERS}.`,
    );
  }

  const seen = new Set<string>();
  for (const pointer of jsonPointers) {
    if (pointer !== '' && !pointer.startsWith('/')) {
      throw new Error(
        `Invalid JSON Pointer ${JSON.stringify(pointer)}: pointers must be empty or start with "/".`,
      );
    }
    if (seen.has(pointer)) {
      throw new Error(`Duplicate JSON Pointer: ${JSON.stringify(pointer)}.`);
    }
    seen.add(pointer);
  }

  return [...jsonPointers];
}

function makeRequestHeaders(headers?: Record<string, string>): Headers {
  const result = new Headers(headers ?? {});

  if (!result.has('accept')) {
    result.set(
      'accept',
      'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.8,*/*;q=0.5',
    );
  }

  if (!result.has('user-agent')) {
    result.set('user-agent', 'VarisDev browse tool');
  }

  return result;
}

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function getMediaType(contentType: string): string {
  return contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function isHtmlContentType(contentType: string): boolean {
  const mediaType = getMediaType(contentType);
  return mediaType === 'text/html' || mediaType === 'application/xhtml+xml';
}

function isTextLikeContentType(contentType: string): boolean {
  const mediaType = getMediaType(contentType);
  return (
    mediaType === '' ||
    mediaType.startsWith('text/') ||
    mediaType.includes('json') ||
    mediaType.includes('xml') ||
    mediaType.includes('javascript') ||
    mediaType === 'application/x-www-form-urlencoded'
  );
}

function looksLikeHtml(input: string): boolean {
  return /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(
    input.slice(0, 1000),
  );
}

function joinChunks(chunks: Uint8Array[], byteLength: number): Uint8Array {
  const output = new Uint8Array(byteLength);
  let offset = 0;

  for (const chunk of chunks) {
    const remaining = byteLength - offset;
    if (remaining <= 0) break;
    const part =
      chunk.byteLength > remaining ? chunk.slice(0, remaining) : chunk;
    output.set(part, offset);
    offset += part.byteLength;
  }

  return output;
}

async function readBodySample(
  response: Response,
  byteLimit: number,
): Promise<BodySample> {
  if (!response.body) {
    return {bytes: new Uint8Array(), truncated: false};
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const readLimit = byteLimit + 1;
  let bytesRead = 0;

  try {
    while (bytesRead < readLimit) {
      const {done, value} = await reader.read();
      if (done) break;
      if (!value) continue;

      const remaining = readLimit - bytesRead;
      const chunk =
        value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      bytesRead += chunk.byteLength;

      if (value.byteLength > remaining) break;
    }

    if (bytesRead >= readLimit) {
      await reader.cancel().catch(() => {});
    }
  } finally {
    reader.releaseLock();
  }

  const truncated = bytesRead > byteLimit;
  const outputBytes = Math.min(bytesRead, byteLimit);
  return {bytes: joinChunks(chunks, outputBytes), truncated};
}

function decodeHtmlEntities(input: string): string {
  return input.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);?/gi,
    (match, entity: string) => {
      const normalized = entity.toLowerCase();
      if (normalized.startsWith('#x')) {
        const codePoint = Number.parseInt(normalized.slice(2), 16);
        return Number.isFinite(codePoint)
          ? String.fromCodePoint(codePoint)
          : match;
      }

      if (normalized.startsWith('#')) {
        const codePoint = Number.parseInt(normalized.slice(1), 10);
        return Number.isFinite(codePoint)
          ? String.fromCodePoint(codePoint)
          : match;
      }

      return HTML_ENTITIES[normalized] ?? match;
    },
  );
}

function sanitizeDecodedText(input: string): string {
  let output = '';

  for (const char of input) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint === 0) {
      output += '\uFFFD';
      continue;
    }
    if (
      (codePoint >= 1 && codePoint <= 8) ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      codePoint === 127
    ) {
      continue;
    }
    output += char;
  }

  return output;
}

function decodeUtf8(bytes: Uint8Array): string {
  return sanitizeDecodedText(new TextDecoder('utf-8').decode(bytes));
}

function normalizeInlineWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function normalizeExtractedText(input: string): string {
  const lines = input
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const output: string[] = [];
  let previous = '';
  for (const line of lines) {
    if (line === previous) continue;
    output.push(line);
    previous = line;
  }

  return output.join('\n');
}

function htmlFragmentToText(html: string): string {
  return normalizeInlineWhitespace(
    decodeHtmlEntities(
      html.replace(/<(br|hr)\b[^>]*\/?>/gi, ' ').replace(/<[^>]+>/g, ' '),
    ),
  );
}

function removeHtmlBlocks(html: string): string {
  let output = html.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of ['script', 'style', 'noscript', 'svg', 'canvas']) {
    output = output.replace(
      new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'),
      ' ',
    );
  }
  return output;
}

function htmlToText(html: string): string {
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  let output = bodyMatch?.[1] ?? html;

  output = removeHtmlBlocks(output)
    .replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(
      /<\/(p|div|section|article|header|footer|nav|main|aside|h[1-6]|li|tr|td|th|blockquote|pre|ul|ol|table)>/gi,
      '\n',
    )
    .replace(/<[^>]+>/g, ' ');

  return normalizeExtractedText(decodeHtmlEntities(output));
}

function extractTitle(html: string): string | undefined {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  if (!title) return undefined;
  const text = htmlFragmentToText(title);
  return text ? truncateLineToChars(text, 200) : undefined;
}

function cleanUrlForOutput(url: URL): URL {
  const cleaned = new URL(url.toString());
  cleaned.hash = '';

  for (const key of [...cleaned.searchParams.keys()]) {
    const normalized = key.toLowerCase();
    if (
      normalized.startsWith('utm_') ||
      ['fbclid', 'gclid', 'mc_cid', 'mc_eid', 'igshid'].includes(normalized)
    ) {
      cleaned.searchParams.delete(key);
    }
  }

  return cleaned;
}

function normalizeHref(href: string, baseUrl: string): string | undefined {
  const trimmed = decodeHtmlEntities(href).trim();
  if (!trimmed || trimmed.startsWith('#')) return undefined;

  const lower = trimmed.toLowerCase();
  if (/^(javascript|mailto|tel|data|blob):/.test(lower)) return undefined;

  try {
    const parsed = cleanUrlForOutput(new URL(trimmed, baseUrl));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function extractLinks(
  html: string,
  baseUrl: string,
  maxLinks: number,
): LinkExtraction {
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const hrefPattern = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/i;
  const seen = new Set<string>();
  const links: BrowseLink[] = [];
  let totalLinks = 0;
  let match: RegExpExecArray | null;

  while ((match = anchorPattern.exec(html)) !== null) {
    const attrs = match[1] ?? '';
    const rawHref = hrefPattern.exec(attrs)?.slice(1).find(Boolean);
    if (!rawHref) continue;

    const url = normalizeHref(rawHref, baseUrl);
    if (!url || seen.has(url)) continue;

    seen.add(url);
    totalLinks++;

    if (links.length >= maxLinks) continue;
    const text = htmlFragmentToText(match[2] ?? '');
    links.push({
      text: truncateLineToChars(text || url, 120),
      url,
    });
  }

  return {links, totalLinks};
}

function truncateLineToChars(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  if (maxChars <= 1) return '…';
  return `${input.slice(0, maxChars - 1)}…`;
}

function getMaxOutputLines(maxChars: number): number {
  return Math.min(MAX_OUTPUT_LINES, Math.max(20, Math.ceil(maxChars / 20)));
}

function limitText(input: string, maxChars: number): LimitedText {
  const text = input.trim();
  const lines = text ? text.split('\n') : [];
  const maxLines = getMaxOutputLines(maxChars);
  const output: string[] = [];
  let outputChars = 0;
  let truncated = false;

  for (const line of lines) {
    if (output.length >= maxLines) {
      truncated = true;
      break;
    }

    const separatorChars = output.length > 0 ? 1 : 0;
    const remaining = maxChars - outputChars - separatorChars;
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    if (line.length > remaining) {
      output.push(truncateLineToChars(line, remaining));
      outputChars += separatorChars + output[output.length - 1].length;
      truncated = true;
      break;
    }

    output.push(line);
    outputChars += separatorChars + line.length;
  }

  if (lines.length > output.length) truncated = true;

  return {
    content: output.join('\n').trim(),
    truncated,
    totalChars: text.length,
    outputChars,
    totalLines: lines.length,
    outputLines: output.length,
  };
}

function formatLinks(links: BrowseLink[], totalLinks: number): string {
  if (totalLinks === 0) return '(no links found)';

  const output = links.map(link => {
    const url = truncateLineToChars(link.url, 500);
    if (link.text === link.url) return `- ${url}`;
    return `- ${link.text} — ${url}`;
  });

  if (totalLinks > links.length) {
    output.push(`(showing ${links.length} of ${totalLinks} links)`);
  }

  return output.join('\n');
}

function plainTextBody(rawText: string): string {
  return rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function decodeJsonPointerToken(token: string, pointer: string): string {
  if (/~(?:[^01]|$)/.test(token)) {
    throw new Error(
      `Invalid JSON Pointer ${JSON.stringify(pointer)}: "~" must be escaped as "~0" and "/" as "~1".`,
    );
  }
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolveJsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === '') return document;

  let value = document;
  for (const encodedToken of pointer.slice(1).split('/')) {
    const token = decodeJsonPointerToken(encodedToken, pointer);
    if (
      value === null ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, token)
    ) {
      throw new Error(
        `JSON Pointer not found: ${JSON.stringify(pointer)} (missing token ${JSON.stringify(token)}).`,
      );
    }
    value = (value as Record<string, unknown>)[token];
  }

  return value;
}

function selectJsonPointers(rawText: string, pointers: string[]): string {
  let document: unknown;
  try {
    document = JSON.parse(rawText) as unknown;
  } catch (error) {
    throw new Error(
      `Could not parse response as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const selected: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const pointer of pointers) {
    selected[pointer] = resolveJsonPointer(document, pointer);
  }
  return JSON.stringify(selected, null, 2);
}

function selectBodyText(input: {
  view: BrowseView;
  rawText: string;
  htmlBody: boolean;
  textBody: boolean;
  links: BrowseLink[];
  totalLinks: number;
  jsonPointers?: string[];
}): {label: string; text: string} | undefined {
  if (input.jsonPointers) {
    return {
      label: 'Selected JSON',
      text: selectJsonPointers(input.rawText, input.jsonPointers),
    };
  }

  if (input.view === 'none') return undefined;

  if (input.view === 'links') {
    return {
      label: 'Links',
      text: input.htmlBody
        ? formatLinks(input.links, input.totalLinks)
        : '(links view is only available for HTML responses)',
    };
  }

  if (!input.rawText) return undefined;

  if (input.view === 'raw') {
    return {label: 'Raw body', text: plainTextBody(input.rawText)};
  }

  if (input.htmlBody) {
    return {label: 'Text', text: htmlToText(input.rawText)};
  }

  if (input.textBody || input.view === 'text') {
    return {label: 'Text', text: plainTextBody(input.rawText)};
  }

  return undefined;
}

function formatBrowseResponseText(input: {
  requestUrl: string;
  responseUrl: string;
  status: number;
  statusText: string;
  contentType: string;
  contentLength?: number;
  bodyBytesRead: number;
  bodyReadLimitBytes: number;
  bodyReadTruncated: boolean;
  view: BrowseView;
  htmlBody: boolean;
  textBody: boolean;
  title?: string;
  body?: {label: string; limited: LimitedText};
}): string {
  const lines = [
    `URL: ${truncateLineToChars(input.responseUrl, 500)}`,
    `Status: ${input.status} ${input.statusText}`,
    `Type: ${input.contentType || '(unknown)'}`,
  ];

  if (input.requestUrl !== input.responseUrl) {
    lines.splice(
      1,
      0,
      `Requested: ${truncateLineToChars(input.requestUrl, 500)}`,
    );
  }

  if (input.contentLength !== undefined || input.bodyBytesRead > 0) {
    const bodyParts = [`read ${formatSize(input.bodyBytesRead)}`];
    if (input.contentLength !== undefined) {
      bodyParts.push(`declared ${formatSize(input.contentLength)}`);
    }
    if (input.bodyReadTruncated) {
      bodyParts.push(`capped at ${formatSize(input.bodyReadLimitBytes)}`);
    }
    lines.push(`Body: ${bodyParts.join(', ')}`);
  }

  if (input.title) lines.push(`Title: ${input.title}`);

  if (!input.body) {
    if (input.view !== 'none' && !input.textBody && !input.htmlBody) {
      lines.push('', 'Body omitted: non-text response.');
    }
    return lines.join('\n');
  }

  lines.push(
    '',
    `${input.body.label}:`,
    input.body.limited.content || '(empty)',
  );

  const notices: string[] = [];
  if (input.body.limited.truncated) {
    notices.push(
      `Text truncated to ${input.body.limited.outputChars} of ${input.body.limited.totalChars} chars / ${input.body.limited.outputLines} of ${input.body.limited.totalLines} lines. Narrow JSON with jsonPointers or increase maxChars and retry with browse`,
    );
  }
  if (input.bodyReadTruncated) {
    notices.push(
      `Fetched body capped at ${formatSize(input.bodyReadLimitBytes)} before extraction; use jsonPointers for large JSON responses or a more targeted URL`,
    );
  }
  if (input.htmlBody && input.view !== 'links') {
    notices.push('Use view="links" to list page links');
  }

  if (notices.length > 0) {
    lines.push('', `[${notices.join('. ')}.]`);
  }

  return lines.join('\n');
}

export function registerBrowseTool(pi: ExtensionAPI): void {
  pi.registerTool<typeof browseSchema, BrowseToolDetails>({
    name: 'browse',
    label: 'Browse',
    description:
      'Fetch an HTTP/HTTPS URL and return a compact browser-style view. Supports text, links, raw bodies, status checks, and RFC 6901 JSON Pointer selection from large JSON documents. Use this tool—not shell commands—for HTTP requests and web research.',
    promptSnippet:
      'Fetch URLs directly, including targeted fields from large JSON documents. Do not use bash, curl, wget, Node, or Python for HTTP requests or web research.',
    promptGuidelines: [
      'Use browse for all HTTP/HTTPS access, including web research, documentation, APIs, discovery documents, downloads inspected as text, and local HTTP endpoints. Do not use bash, curl, wget, PowerShell, Node, Python, or other shell commands to fetch URLs.',
      'For JSON APIs and large JSON documents, use browse jsonPointers to return only the required fields. JSON Pointers follow RFC 6901, such as /resources/edits/methods/get or /schemas/Track.',
      'If browse output is truncated or omits the relevant content, retry browse with a targeted URL, jsonPointers, view="links", or a larger maxChars as appropriate. Do not fall back to shell-based HTTP clients.',
      'Use browse view="links" only when navigation links are needed; use view="raw" for API/plain-text bodies and view="none" for status checks.',
      'Keep browse maxChars at its default initially; increase it when a relevant browse result is truncated and cannot be narrowed first.',
      'Do not send credentials, tokens, or private data with browse unless the user explicitly provided or requested them.',
      'If you notice unexpected or unfinished behavior when using browse, report it to the user.',
    ],
    parameters: browseSchema,
    async execute(_toolCallId, params, signal) {
      const url = normalizeHttpUrl(params.url);
      const method = normalizeHttpMethod(params.method);
      const view = normalizeBrowseView(params.view);
      const jsonPointers = normalizeJsonPointers(params.jsonPointers);
      const maxChars = normalizeBoundedInteger(
        params.maxChars,
        jsonPointers ? MAX_OUTPUT_CHARS : DEFAULT_OUTPUT_CHARS,
        MIN_OUTPUT_CHARS,
        MAX_OUTPUT_CHARS,
      );
      const maxLinks = normalizeBoundedInteger(
        params.maxLinks,
        DEFAULT_LINK_LIMIT,
        1,
        MAX_LINK_LIMIT,
      );
      const timeoutMs = normalizeTimeout(params.timeoutMs);

      if (
        (method === 'GET' || method === 'HEAD') &&
        params.body !== undefined
      ) {
        throw new Error(`${method} requests cannot include a body.`);
      }
      if (jsonPointers && (view === 'links' || view === 'none')) {
        throw new Error(
          `jsonPointers cannot be combined with view=${JSON.stringify(view)}. Omit view or use view="auto".`,
        );
      }
      if (jsonPointers && method === 'HEAD') {
        throw new Error('jsonPointers cannot be used with HEAD requests.');
      }

      const timeoutController = new AbortController();
      const timeout = setTimeout(
        () =>
          timeoutController.abort(
            new Error(`Browse request timed out after ${timeoutMs}ms`),
          ),
        timeoutMs,
      );
      unrefTimer(timeout);

      const abortFromAgent = () => timeoutController.abort(signal?.reason);
      if (signal?.aborted) {
        abortFromAgent();
      } else {
        signal?.addEventListener('abort', abortFromAgent, {once: true});
      }

      try {
        const response = await fetch(url, {
          method,
          headers: makeRequestHeaders(params.headers),
          body: params.body,
          redirect: 'follow',
          signal: timeoutController.signal,
        });

        const responseHeaders = headersToObject(response.headers);
        const contentType = response.headers.get('content-type') ?? '';
        const contentLength = parseContentLength(
          response.headers.get('content-length'),
        );
        const textBody = isTextLikeContentType(contentType);
        const htmlContentType = isHtmlContentType(contentType);
        const shouldReadBody = method !== 'HEAD' && view !== 'none';
        const bodyReadLimitBytes = jsonPointers
          ? JSON_BODY_READ_LIMIT_BYTES
          : BODY_READ_LIMIT_BYTES;
        const bodySample = shouldReadBody
          ? await readBodySample(response, bodyReadLimitBytes)
          : {bytes: new Uint8Array(), truncated: false};
        if (jsonPointers && bodySample.truncated) {
          throw new Error(
            `JSON response exceeds the ${formatSize(bodyReadLimitBytes)} browse selection limit. Use a more targeted URL.`,
          );
        }
        const shouldDecodeBody =
          shouldReadBody &&
          (Boolean(jsonPointers) ||
            textBody ||
            view === 'raw' ||
            view === 'text' ||
            view === 'links');
        const rawText = shouldDecodeBody ? decodeUtf8(bodySample.bytes) : '';
        const htmlBody = htmlContentType || looksLikeHtml(rawText);
        const title = htmlBody && rawText ? extractTitle(rawText) : undefined;
        const linkExtraction =
          htmlBody && rawText
            ? extractLinks(rawText, response.url, maxLinks)
            : {links: [], totalLinks: 0};
        const body = selectBodyText({
          view,
          rawText,
          htmlBody,
          textBody,
          links: linkExtraction.links,
          totalLinks: linkExtraction.totalLinks,
          jsonPointers,
        });
        const limitedBody = body
          ? {label: body.label, limited: limitText(body.text, maxChars)}
          : undefined;

        const contentText = formatBrowseResponseText({
          requestUrl: url,
          responseUrl: response.url,
          status: response.status,
          statusText: response.statusText,
          contentType,
          contentLength,
          bodyBytesRead: bodySample.bytes.byteLength,
          bodyReadLimitBytes,
          bodyReadTruncated: bodySample.truncated,
          view,
          htmlBody,
          textBody,
          title,
          body: limitedBody,
        });

        return {
          content: [{type: 'text', text: contentText}],
          details: {
            request: {
              url,
              method,
              view,
              maxChars,
              maxLinks,
              jsonPointers,
              timeoutMs,
            },
            response: {
              url: response.url,
              status: response.status,
              statusText: response.statusText,
              ok: response.ok,
              headers: responseHeaders,
              contentType,
              contentLength,
              bodyBytesRead: bodySample.bytes.byteLength,
              bodyReadLimitBytes,
              bodyReadTruncated: bodySample.truncated,
              textBody,
              htmlBody,
              title,
              links: linkExtraction.links,
              totalLinks: linkExtraction.totalLinks,
              textTruncated: limitedBody?.limited.truncated,
            },
          },
        };
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abortFromAgent);
      }
    },
  });
}
