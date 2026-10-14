import {randomUUID} from 'node:crypto';
import {readFile, rename, rm, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';

/** Existing Finder launchers must dispatch through the updated application's CLI. */
export async function refreshMacLauncher(
  installRoot: string,
  updatedRoot: string,
  destination = join(homedir(), 'Applications/VarisDev.app'),
): Promise<void> {
  const directory = join(destination, 'Contents/Resources/app');
  let config: {installRoot?: unknown};
  try {
    config = JSON.parse(await readFile(join(directory, 'launch.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (
    typeof config.installRoot !== 'string' ||
    resolve(config.installRoot) !== resolve(installRoot)
  )
    return;
  const source = await readFile(
    join(updatedRoot, 'assets/desktop/app-main.cjs'),
  );
  const temporary = join(directory, `main-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, source);
    await rename(temporary, join(directory, 'main.cjs'));
  } finally {
    await rm(temporary, {force: true});
  }
}
