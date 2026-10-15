import {stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';

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
  const path = value.startsWith('~/')
    ? join(homedir(), value.slice(2))
    : resolve(cwd, value);
  const info = await stat(path);
  if (!info.isFile() && !info.isDirectory())
    throw new Error('Choose a file or folder.');
  const error = await openPath(path);
  if (error) throw new Error(error);
}
