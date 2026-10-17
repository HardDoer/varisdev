import {symlink} from 'node:fs/promises';
import type {TestContext} from 'node:test';

/** Create the directory link available to unprivileged test processes. */
export async function createDirectoryLink(
  target: string,
  path: string,
): Promise<void> {
  await symlink(
    target,
    path,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

/** Keep file symlink coverage where the host grants that capability. */
export async function createFileSymlinkOrSkip(
  t: TestContext,
  target: string,
  path: string,
): Promise<boolean> {
  try {
    await symlink(target, path, 'file');
    return true;
  } catch (error) {
    if (
      process.platform !== 'win32' ||
      (error as NodeJS.ErrnoException).code !== 'EPERM'
    )
      throw error;
    t.skip('Windows file symlinks require additional privileges');
    return false;
  }
}
