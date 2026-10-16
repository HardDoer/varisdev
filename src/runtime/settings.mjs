import {homedir} from 'node:os';
import {join, relative, resolve} from 'node:path';
import process from 'node:process';
import {migrateSettings} from './settings-migration.mjs';

/** @param {NodeJS.ProcessEnv} env */
function settingsHome(env) {
  return (
    (process.platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME) ||
    homedir()
  );
}

/** @param {NodeJS.ProcessEnv} [env] */
export function settingsDirectory(env = process.env) {
  const home = settingsHome(env);
  const root = resolve(home, '.varisdev');
  let directory = env.VARISDEV_SETTINGS_DIR;
  if (!directory) return join(root, 'agent');
  if (directory === '~') directory = home;
  else if (directory.startsWith('~/') || directory.startsWith('~\\'))
    directory = join(home, directory.slice(2));
  directory = resolve(directory);
  // Existing desktop launchers saved the former flat default explicitly.
  return relative(root, directory) === '' ? join(root, 'agent') : directory;
}

/** Configure only a dedicated VarisDev process or its child environment. */
export function configureSettings(env = process.env) {
  const directory = settingsDirectory(env);
  const root = resolve(settingsHome(env), '.varisdev');
  if (relative(join(root, 'agent'), directory) === '')
    migrateSettings(root, directory);
  env.VARISDEV_SETTINGS_DIR = directory;
  env.VARISDEV_CODING_AGENT_DIR = directory;
  // Dependency reinstalls can restore Pi's original package identity.
  env.PI_CODING_AGENT_DIR = directory;
  delete env.VARISDEV_CODING_AGENT_SESSION_DIR;
  delete env.PI_CODING_AGENT_SESSION_DIR;
  delete env.PI_PACKAGE_DIR;
  return env;
}
