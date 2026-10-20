import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {dirname, join, resolve} from 'node:path';
import type {ShortcutDetails} from 'electron';
import {settingsDirectory} from './settings.mjs';
import {environmentForChild} from './environment.mjs';

export const windowsAppId = 'com.varisware.varisdev';

/** Quote one argument using Windows CommandLineToArgvW rules. */
export function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

export interface WindowsLauncherOptions {
  installRoot: string;
  runtimeRoot: string;
  profile: string;
  dataDir: string;
  nodeExecutable?: string;
}

export async function prepareWindowsLauncher(options: WindowsLauncherOptions) {
  const {installRoot, runtimeRoot, profile, dataDir} = options;
  const directory = join(profile, 'windows-launcher');
  const require = createRequire(join(installRoot, 'package.json'));
  const electronDirectory = dirname(require.resolve('electron/package.json'));
  // The base installation stays in place when RuntimeManager activates an update.
  const executable = join(
    electronDirectory,
    'dist',
    (await readFile(join(electronDirectory, 'path.txt'), 'utf8')).trim(),
  );
  await mkdir(directory, {recursive: true});
  const bootstrap = join(directory, 'main.cjs');
  const icon = join(directory, 'varisdev.ico');
  const machine = environmentForChild();
  const config = JSON.stringify({
    installRoot: resolve(installRoot),
    runtimeRoot: resolve(runtimeRoot),
    dataDir: resolve(dataDir),
    profile: resolve(profile),
    nodeExecutable: options.nodeExecutable,
    path: machine.PATH,
    settingsDir: settingsDirectory(machine),
    environment: {
      VARISDEV_DATA_DIR: machine.VARISDEV_DATA_DIR,
      PIDEV_DESKTOP_DATA_DIR: machine.PIDEV_DESKTOP_DATA_DIR,
      VARISDEV_SETTINGS_DIR: machine.VARISDEV_SETTINGS_DIR,
    },
  });
  // Replace individual files atomically so another launch never reads a partial file.
  for (const [destination, contents] of [
    [
      bootstrap,
      await readFile(join(runtimeRoot, 'assets/desktop/windows-main.cjs')),
    ],
    [join(directory, 'launch.json'), Buffer.from(config)],
  ] as const) {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, contents);
      await rename(temporary, destination);
    } finally {
      await rm(temporary, {force: true});
    }
  }
  await copyFile(join(runtimeRoot, 'assets/desktop/robot-crow.ico'), icon);
  const args = `${quoteWindowsArgument(bootstrap)} --overview`;
  return {
    shortcut: {
      target: executable,
      args,
      cwd: installRoot,
      description: 'VarisDev',
      icon,
      iconIndex: 0,
      appUserModelId: windowsAppId,
    } satisfies ShortcutDetails,
    appDetails: {
      appId: windowsAppId,
      appIconPath: icon,
      appIconIndex: 0,
      relaunchCommand: `${quoteWindowsArgument(executable)} ${args}`,
      relaunchDisplayName: 'VarisDev',
    },
  };
}
