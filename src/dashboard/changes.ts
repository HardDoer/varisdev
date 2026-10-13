import {randomUUID} from 'node:crypto';
import {open} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';

export interface UnitChange {
  id: string;
  unitId: string;
  unitName: string;
  path: string;
  tool: string;
  at: string;
  diff: string;
  summary: string;
}

const maxBytes = 32 * 1024;
const maxDiff = 12000;
type Contents = {text?: string; note?: string; missing?: boolean};

function bounded(text: string, limit = maxDiff): string {
  const suffix = '\n[truncated]';
  return text.length <= limit
    ? text
    : text.slice(0, limit - suffix.length) + suffix;
}

function nativePath(path: string, cwd: string): string {
  path = path.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ');
  if (path.startsWith('@')) path = path.slice(1);
  if (path === '~') path = homedir();
  else if (path.startsWith('~/')) path = resolve(homedir(), path.slice(2));
  if (path.startsWith('file://')) path = fileURLToPath(path);
  return resolve(cwd, path);
}

function textContents(text: string): Contents {
  if (Buffer.byteLength(text) > maxBytes) return {note: 'exceeds 32 KiB'};
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      return {note: 'binary content'};
    }
  }
  return {text};
}

async function readBefore(path: string): Promise<Contents> {
  try {
    const file = await open(path, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return {note: 'not a regular file'};
      if (stat.size > maxBytes) return {note: 'exceeds 32 KiB'};
      const buffer = Buffer.alloc(maxBytes);
      const {bytesRead} = await file.read(buffer, 0, maxBytes, 0);
      const afterRead = await file.stat();
      if (afterRead.size > maxBytes) return {note: 'exceeds 32 KiB'};
      if (bytesRead !== stat.size || afterRead.mtimeMs !== stat.mtimeMs) {
        return {note: 'previous content changed during capture'};
      }
      try {
        return textContents(
          new TextDecoder('utf-8', {fatal: true}).decode(
            buffer.subarray(0, bytesRead),
          ),
        );
      } catch {
        return {note: 'binary content'};
      }
    } finally {
      await file.close();
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? {text: '', missing: true}
      : {note: 'previous content unavailable'};
  }
}

function diffLines(text: string, prefix: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const result = lines.map(line => prefix + line);
  if (!text.endsWith('\n')) result.push('\\ No newline at end of file');
  return result;
}

function lineCount(text: string): number {
  return text ? text.split('\n').length - Number(text.endsWith('\n')) : 0;
}

function writeDiff(path: string, before: Contents, after: Contents): string {
  if (before.text === undefined || after.text === undefined) {
    return `Content diff unavailable: ${[before.note && `before ${before.note}`, after.note && `after ${after.note}`].filter(Boolean).join('; ')}.`;
  }
  const oldCount = lineCount(before.text);
  const newCount = lineCount(after.text);
  return bounded(
    [
      `--- ${before.missing ? '/dev/null' : path}`,
      `+++ ${path}`,
      `@@ -${oldCount ? 1 : 0},${oldCount} +${newCount ? 1 : 0},${newCount} @@`,
      ...diffLines(before.text, '-'),
      ...diffLines(after.text, '+'),
    ].join('\n'),
  );
}

/** Observes successful native file tools; no tool arguments are executed. */
export function observeFileChanges(
  pi: ExtensionAPI,
  onChange: (change: Omit<UnitChange, 'unitId' | 'unitName'>) => void,
): void {
  const pending = new Map<
    string,
    {
      path: string;
      tool: string;
      before?: Promise<Contents>;
      after?: Contents;
    }
  >();
  // The SDK awaits tool_call before executing tools. Execution-start events
  // are observational and cannot hold a write until its old content is read.
  pi.on('tool_call', async (event, ctx) => {
    if (!['edit', 'write'].includes(event.toolName)) return;
    const args = event.input as Record<string, unknown>;
    if (!args || typeof args.path !== 'string') return;
    if (event.toolName === 'write' && typeof args.content !== 'string') return;
    let path: string;
    try {
      path = nativePath(args.path, ctx.cwd);
    } catch {
      return;
    }
    const entry = {
      path,
      tool: event.toolName,
      before: event.toolName === 'write' ? readBefore(path) : undefined,
      after:
        event.toolName === 'write' && typeof args.content === 'string'
          ? textContents(args.content)
          : undefined,
    };
    pending.set(event.toolCallId, entry);
    await entry.before;
  });
  pi.on('tool_execution_end', async event => {
    const entry = pending.get(event.toolCallId);
    if (!entry) return;
    if (event.isError || entry.tool !== event.toolName) {
      pending.delete(event.toolCallId);
      return;
    }
    let diff: string;
    let summary: string;
    if (entry.tool === 'edit') {
      const details = event.result?.details;
      const patch =
        typeof details?.patch === 'string' ? details.patch : details?.diff;
      if (typeof patch !== 'string' || !patch.trim()) {
        pending.delete(event.toolCallId);
        return;
      }
      diff = bounded(patch);
      summary = 'Edited file';
    } else {
      const before = await entry.before!;
      if (pending.get(event.toolCallId) !== entry) return;
      const after = entry.after!;
      if (
        !before.missing &&
        before.text !== undefined &&
        before.text === after.text
      ) {
        pending.delete(event.toolCallId);
        return;
      }
      diff = writeDiff(entry.path, before, after);
      summary = before.missing ? 'Created file' : 'Wrote file';
      if (before.note || after.note)
        summary += ` (${before.note ?? after.note})`;
    }
    pending.delete(event.toolCallId);
    onChange({
      id: randomUUID(),
      path: entry.path,
      tool: entry.tool,
      at: new Date().toISOString(),
      diff,
      summary: bounded(summary, 500),
    });
  });
  pi.on('session_shutdown', () => pending.clear());
}
