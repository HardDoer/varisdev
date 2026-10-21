import {stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';

export async function openConversationURL(
  value: unknown,
  openExternal: (url: string) => Promise<void>,
): Promise<void> {
  let url: URL;
  try {
    if (typeof value !== 'string') throw new Error();
    const target = value.trim();
    if (!/^https?:\/\//i.test(target) || /[\s\p{Cc}]/u.test(target))
      throw new Error();
    url = new URL(target);
  } catch {
    throw new Error('Choose a valid HTTP or HTTPS link.');
  }
  await openExternal(url.href);
}

export async function openConversationFile(
  cwd: string,
  value: unknown,
  openPath: (path: string) => Promise<string>,
): Promise<void> {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 8192 ||
    value.includes('\0')
  )
    throw new Error('Choose a valid file path.');
  const target = value.startsWith('~\\')
    ? `~/${value.slice(2).replaceAll('\\', '/')}`
    : value;
  const path = target.startsWith('~/')
    ? join(homedir(), target.slice(2))
    : resolve(cwd, target);
  const info = await stat(path);
  if (!info.isFile() && !info.isDirectory())
    throw new Error('Choose a file or folder.');
  const error = await openPath(path);
  if (error) throw new Error(error);
}
