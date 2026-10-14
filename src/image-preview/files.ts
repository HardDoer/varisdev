import {open} from 'node:fs/promises';
import {homedir} from 'node:os';
import {extname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.svg',
  '.tif',
  '.tiff',
]);

export function resolveImagePath(
  value: string,
  cwd: string,
  markdown = false,
): string | undefined {
  let path = value.trim().replace(/^@/, '');
  if (
    (path.startsWith('"') && path.endsWith('"')) ||
    (path.startsWith("'") && path.endsWith("'"))
  )
    path = path.slice(1, -1);
  try {
    if (path.startsWith('file:')) path = fileURLToPath(path);
    else {
      if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path))
        return undefined;
      if (path.startsWith('//')) return undefined;
      if (markdown) path = decodeURIComponent(path);
    }
  } catch {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex -- Reject control characters in paths.
  if (!EXTENSIONS.has(extname(path).toLowerCase()) || /[\x00-\x1f]/.test(path))
    return undefined;
  if (path.startsWith('~/') || path.startsWith('~\\'))
    path = resolve(homedir(), path.slice(2));
  return resolve(cwd, path);
}

export async function readPreviewImage(path: string): Promise<Buffer> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Image path is not a file.');
    if (info.size > 50 * 1024 * 1024) throw new Error('Image exceeds 50 MiB.');
    const buffer = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await file.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > info.size)
      throw new Error('Image changed while being read. Try again.');
    return buffer.subarray(0, size);
  } finally {
    await file.close();
  }
}
