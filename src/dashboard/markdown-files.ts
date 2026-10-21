import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open, realpath, rename, unlink} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename, dirname, extname, join, resolve} from 'node:path';
import {DashboardInputError} from './errors.ts';

const maximumBytes = 1024 * 1024;
const conflictMessage =
  'This Markdown file changed on disk. Reload it before saving your edits.';
const saving = new Map<string, Promise<unknown>>();

export interface MarkdownFile {
  path: string;
  content: string;
  version: string;
}

function inputPath(cwd: string, value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 4096 ||
    value.includes('\0')
  )
    throw new DashboardInputError('Choose a valid Markdown file path.');
  const target = value.startsWith('~\\')
    ? `~/${value.slice(2).replaceAll('\\', '/')}`
    : value;
  const path = target.startsWith('~/')
    ? resolve(homedir(), target.slice(2))
    : resolve(cwd, target);
  if (extname(path).toLowerCase() !== '.md')
    throw new DashboardInputError(
      'Choose a Markdown file with a .md extension.',
    );
  return path;
}

async function canonicalPath(path: string): Promise<string> {
  const canonical = await realpath(path);
  if (extname(canonical).toLowerCase() !== '.md')
    throw new DashboardInputError(
      'The Markdown file must resolve to a .md file.',
    );
  return canonical;
}

function version(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Read through a handle so replaced paths and special files cannot turn a
 * bounded read into a different or unbounded resource. Symlinks resolve once
 * to their regular Markdown target; the response always names that target. */
async function readRegular(path: string) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile())
      throw new DashboardInputError('Choose a regular Markdown file.');
    if (metadata.size > maximumBytes)
      throw new DashboardInputError('Markdown files must be at most 1 MB.');
    const buffer = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const {bytesRead} = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximumBytes)
      throw new DashboardInputError('Markdown files must be at most 1 MB.');
    const bytes = buffer.subarray(0, length);
    let content: string;
    try {
      content = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(
        bytes,
      );
    } catch {
      throw new DashboardInputError(
        'The Markdown file must contain UTF-8 text.',
      );
    }
    if (content.includes('\0'))
      throw new DashboardInputError(
        'The Markdown file must contain text without NUL bytes.',
      );
    return {file: {path, content, version: version(bytes)}, metadata};
  } finally {
    await handle.close();
  }
}

function fileError(error: unknown): never {
  if (error instanceof DashboardInputError) throw error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR')
    throw new DashboardInputError(
      'The Markdown file no longer exists at this path.',
    );
  if (code === 'EACCES' || code === 'EPERM')
    throw new DashboardInputError(
      'The Markdown file could not be accessed. Check its file permissions.',
    );
  if (code === 'ELOOP' || code === 'EISDIR')
    throw new DashboardInputError('Choose a regular Markdown file.');
  throw new DashboardInputError(
    'The Markdown file could not be read or saved.',
  );
}

export async function readMarkdownFile(
  cwd: string,
  value: unknown,
): Promise<MarkdownFile> {
  const path = inputPath(cwd, value);
  try {
    return (await readRegular(await canonicalPath(path))).file;
  } catch (error) {
    return fileError(error);
  }
}

export async function saveMarkdownFile(
  cwd: string,
  value: unknown,
  content: unknown,
  expectedVersion: unknown,
): Promise<MarkdownFile> {
  const path = inputPath(cwd, value);
  if (typeof content !== 'string' || content.includes('\0'))
    throw new DashboardInputError(
      'Markdown content must be text without NUL bytes.',
    );
  if (!content.isWellFormed())
    throw new DashboardInputError(
      'Markdown content must contain valid Unicode text.',
    );
  if (content.length > maximumBytes)
    throw new DashboardInputError('Markdown files must be at most 1 MB.');
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > maximumBytes)
    throw new DashboardInputError('Markdown files must be at most 1 MB.');
  if (
    typeof expectedVersion !== 'string' ||
    !/^[a-f0-9]{64}$/.test(expectedVersion)
  )
    throw new DashboardInputError('Read the Markdown file before saving it.');
  try {
    const canonical = await canonicalPath(path);
    // Serialize saves to the same real target, including requests through aliases.
    const previous = saving.get(canonical);
    const operation = (async () => {
      await previous?.catch(() => {});
      const before = await readRegular(canonical);
      if (before.file.version !== expectedVersion)
        throw new DashboardInputError(conflictMessage);
      const temporary = join(
        dirname(canonical),
        `.${basename(canonical)}.${randomUUID()}.tmp`,
      );
      let staged = false;
      try {
        const handle = await open(
          temporary,
          'wx',
          before.metadata.mode & 0o7777,
        );
        staged = true;
        try {
          await handle.writeFile(bytes);
          // chmod avoids the process umask stripping the original permissions.
          await handle.chmod(before.metadata.mode & 0o7777);
          await handle.sync();
        } finally {
          await handle.close();
        }
        // Check again after staging, immediately before replacing the real file.
        if ((await canonicalPath(path)) !== canonical)
          throw new DashboardInputError(conflictMessage);
        const latest = await readRegular(canonical);
        if (
          latest.file.version !== expectedVersion ||
          latest.metadata.dev !== before.metadata.dev ||
          latest.metadata.ino !== before.metadata.ino ||
          latest.metadata.mode !== before.metadata.mode
        )
          throw new DashboardInputError(conflictMessage);
        await rename(temporary, canonical);
        staged = false;
        return {path: canonical, content, version: version(bytes)};
      } finally {
        if (staged) await unlink(temporary).catch(() => {});
      }
    })();
    saving.set(canonical, operation);
    try {
      return await operation;
    } finally {
      if (saving.get(canonical) === operation) saving.delete(canonical);
    }
  } catch (error) {
    return fileError(error);
  }
}
