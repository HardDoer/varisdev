import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import process from 'node:process';

/** @param {NodeJS.ProcessEnv} [env] */
export function settingsDirectory(env = process.env) {
  const home =
    (process.platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME) ||
    homedir();
  let directory = env.VARISDEV_SETTINGS_DIR;
  if (!directory) return resolve(home, '.varisdev');
  if (directory === '~') directory = home;
  else if (directory.startsWith('~/') || directory.startsWith('~\\'))
    directory = join(home, directory.slice(2));
  return resolve(directory);
}

/** Configure only a dedicated VarisDev process or its child environment. */
export function configureSettings(env = process.env) {
  const directory = settingsDirectory(env);
  env.VARISDEV_SETTINGS_DIR = directory;
  env.VARISDEV_CODING_AGENT_DIR = directory;
  delete env.VARISDEV_CODING_AGENT_SESSION_DIR;
  delete env.PI_PACKAGE_DIR;
  return env;
}
