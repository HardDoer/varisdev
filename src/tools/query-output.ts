import {withFileMutationQueue} from '@earendil-works/pi-coding-agent';
import {randomUUID} from 'node:crypto';
import {lstat, mkdir, open, realpath, unlink} from 'node:fs/promises';
import {join, relative} from 'node:path';

async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, {mode: 0o700});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    relative(path, await realpath(path)) !== ''
  ) {
    throw new Error(`Query output storage must be a real directory: ${path}`);
  }
}

/** Saved conversations retain these paths; only failed writes are removed. */
export async function saveQueryOutput(
  cwd: string,
  toolName: string,
  output: string,
): Promise<string> {
  const storage = join(await realpath(cwd), '.varisdev');
  await ensureDirectory(storage);
  const directory = join(storage, 'tool-output');
  await ensureDirectory(directory);
  const name = toolName.replace(/[^a-z0-9_-]/gi, '-');
  const outputPath = join(directory, `${name}-${randomUUID()}.txt`);
  await withFileMutationQueue(outputPath, async () => {
    const file = await open(outputPath, 'wx', 0o600);
    try {
      await file.writeFile(output, 'utf8');
      await file.close();
    } catch (error) {
      await file.close().catch(() => {});
      await unlink(outputPath);
      throw error;
    }
  });
  return outputPath;
}
