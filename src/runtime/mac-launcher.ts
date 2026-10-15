import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {readFile, rename, rm, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';

/** Keep existing Finder launchers able to load the current application. */
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
    if (process.platform === 'darwin') {
      try {
        await access(join(destination, 'Contents/Info.plist'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      await promisify(execFile)('/usr/bin/codesign', [
        '--force',
        '--deep',
        '--sign',
        '-',
        destination,
      ]);
    }
  } finally {
    await rm(temporary, {force: true});
  }
}

/** Refresh the app bundle after the previous desktop has finished closing. */
export async function macLauncherExecutable(
  installRoot: string,
  runtimeRoot: string,
  env: NodeJS.ProcessEnv,
  destination = join(homedir(), 'Applications/VarisDev.app'),
): Promise<string | undefined> {
  let config: {installRoot?: string; runtimeRoot?: string};
  try {
    config = JSON.parse(
      await readFile(
        join(destination, 'Contents/Resources/app/launch.json'),
        'utf8',
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (
    typeof config.installRoot !== 'string' ||
    resolve(config.installRoot) !== resolve(installRoot)
  )
    return;
  if (
    typeof config.runtimeRoot !== 'string' ||
    resolve(config.runtimeRoot) !== resolve(runtimeRoot)
  ) {
    try {
      await promisify(execFile)(
        env.VARISDEV_NODE_EXECUTABLE || process.execPath,
        [join(runtimeRoot, 'scripts/desktop-app.mjs'), 'install'],
        {env},
      );
    } catch (error) {
      // A running app receives the project through its single-instance handler.
      if ((error as {code?: number}).code !== 2) throw error;
    }
  }
  const executable = join(destination, 'Contents/MacOS/VarisDev');
  try {
    await access(executable);
    return executable;
  } catch {
    return join(destination, 'Contents/MacOS/Electron');
  }
}
