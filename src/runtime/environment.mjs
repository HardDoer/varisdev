import {spawn} from 'node:child_process';
import {Buffer} from 'node:buffer';
import console from 'node:console';
import {setTimeout, clearTimeout} from 'node:timers';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import process from 'node:process';

const hiddenFields = new Set([
  '_',
  'HOME',
  'USERPROFILE',
  'USER',
  'LOGNAME',
  'SHELL',
  'ZDOTDIR',
  'PWD',
  'OLDPWD',
  'SHLVL',
  'TERM',
  'TERMCAP',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TERM_SESSION_ID',
  'TTY',
  'TMPDIR',
  'NODE_OPTIONS',
  'NODE_CHANNEL_FD',
  'NODE_CHANNEL_SERIALIZATION_MODE',
]);
const publicAppFields = new Set([
  'VARISDEV_DATA_DIR',
  'VARISDEV_SETTINGS_DIR',
  'PIDEV_DESKTOP_DATA_DIR',
  'PI_OFFLINE',
]);
const suggestedFields = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_IMAGE_MODEL',
  'OPENAI_IMAGE_SIZE',
  'OPENAI_IMAGE_OUTPUT_DIR',
  'OPENAI_IMAGE_OUTPUT_FORMAT',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
];

export function isEnvironmentField(name) {
  return (
    typeof name === 'string' &&
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
    !hiddenFields.has(name) &&
    !name.startsWith('__') &&
    (publicAppFields.has(name) ||
      !/^(?:VARISDEV_|PIDEV_|PI_|ELECTRON_|XPC_|VSCODE_)/.test(name))
  );
}

/** Fixed outside VARISDEV_DATA_DIR so that setting can itself be configured. */
export function environmentPath(
  env = process.env,
  platform = process.platform,
) {
  const home = env.HOME || env.USERPROFILE || homedir();
  if (platform === 'darwin')
    return join(home, 'Library/Application Support/VarisDev/environment.json');
  if (platform === 'win32')
    return join(
      env.LOCALAPPDATA || join(home, 'AppData/Local'),
      'VarisDev/environment.json',
    );
  return join(
    env.XDG_CONFIG_HOME || join(home, '.config'),
    'varisdev/environment.json',
  );
}

function fields(env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name, value]) => isEnvironmentField(name) && typeof value === 'string',
    ),
  );
}

/**
 * Read exported values over a separate pipe; shell startup output is discarded.
 * @param {{env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, shell?: string, timeoutMs?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<Record<string, string>>}
 */
export function readShellEnvironment({
  env = process.env,
  platform = process.platform,
  shell = '/bin/zsh',
  timeoutMs = 8000,
  signal,
} = {}) {
  if (platform === 'win32') return Promise.resolve({});
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(
      shell,
      ['-o', 'NO_MONITOR', '-lic', '/usr/bin/env -0 >&3'],
      {
        env,
        cwd: env.HOME || homedir(),
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      },
    );
    let output = Buffer.alloc(0);
    let failure;
    const stop = error => {
      failure ??= error;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* Already exited. */
      }
    };
    const timer = setTimeout(
      () => stop(new Error('Reading .zshrc timed out.')),
      timeoutMs,
    );
    const abort = () => stop(new Error('Reading .zshrc was cancelled.'));
    signal?.addEventListener('abort', abort, {once: true});
    child.stdio[3].on('data', chunk => {
      if (output.length + chunk.length > 1024 * 1024) {
        stop(new Error('The shell environment is too large.'));
        return;
      }
      output = Buffer.concat([output, chunk]);
    });
    child.once('error', () => {
      failure ??= new Error('Could not start Zsh to read .zshrc.');
    });
    child.once('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) return reject(failure);
      if (code !== 0)
        return reject(
          new Error('Could not read .zshrc: shell startup failed.'),
        );
      const values = {};
      for (const record of output.toString('utf8').split('\0')) {
        const split = record.indexOf('=');
        if (split > 0 && isEnvironmentField(record.slice(0, split)))
          values[record.slice(0, split)] = record.slice(split + 1);
      }
      resolve(values);
    });
  });
}

/** @param {{env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, file?: string, shell?: string, timeoutMs?: number, signal?: AbortSignal}} [options] */
export function createEnvironmentSettings({
  env = process.env,
  platform = process.platform,
  file,
  shell,
  timeoutMs,
  signal,
} = {}) {
  const inherited = fields(env);
  let machine;
  let machineValues = inherited;
  let error;
  let applied = new Set(Object.keys(inherited));
  let lastValues = {};
  let savedNames = [];
  let saving = Promise.resolve();
  async function readSaved() {
    let saved;
    try {
      saved = JSON.parse(await readFile(file, 'utf8'));
    } catch (cause) {
      if (cause.code === 'ENOENT') return {};
      throw new Error(
        'Could not read environment.json. Check that it contains a JSON object of string values.',
      );
    }
    if (
      !saved ||
      typeof saved !== 'object' ||
      Array.isArray(saved) ||
      Object.entries(saved).some(
        ([name, value]) =>
          !isEnvironmentField(name) || typeof value !== 'string',
      )
    )
      throw new Error(
        'environment.json must contain configurable environment names with string values.',
      );
    return saved;
  }
  async function initialize() {
    machine ??= readShellEnvironment({
      env: {...env},
      platform,
      shell,
      timeoutMs,
      signal,
    })
      .then(
        shellValues =>
          (machineValues = platform === 'win32' ? inherited : shellValues),
      )
      .catch(cause => {
        error = `${cause.message} Using the inherited environment and saved settings.`;
        return inherited;
      });
    return get();
  }
  async function get() {
    if (!machine) return initialize();
    await machine;
    file ??= environmentPath(
      {HOME: env.HOME, USERPROFILE: env.USERPROFILE, ...machineValues},
      platform,
    );
    const saved = await readSaved();
    const values = {...machineValues, ...saved};
    for (const name of applied)
      if (!Object.hasOwn(values, name)) delete env[name];
    for (const [name, value] of Object.entries(values)) {
      if (lastValues[name] !== value) env[name] = value;
    }
    lastValues = values;
    applied = new Set(Object.keys(values));
    savedNames = Object.keys(saved);
    return {
      values,
      names: [...new Set([...suggestedFields, ...Object.keys(values)])].sort(),
      savedNames,
      ...(error ? {error} : {}),
    };
  }
  async function save(name, value) {
    if (!isEnvironmentField(name))
      throw new Error('Choose a configurable environment variable name.');
    if (value !== null && (typeof value !== 'string' || value.includes('\0')))
      throw new Error('Enter an environment value without null characters.');
    const operation = saving.then(async () => {
      await initialize();
      const saved = await readSaved();
      if (value === null) delete saved[name];
      else saved[name] = value;
      if (value !== null || Object.keys(saved).length) {
        await mkdir(dirname(file), {recursive: true});
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(saved, null, 2) + '\n', {
            mode: 0o600,
            flag: 'wx',
          });
          await rename(temporary, file);
        } finally {
          await rm(temporary, {force: true});
        }
      } else await rm(file, {force: true});
      return get();
    });
    saving = operation.catch(() => {});
    return operation;
  }
  // App continuations load the JSON themselves. Preserve their real fallback
  // rather than passing a saved value off as an inherited environment value.
  function forChild(base = env) {
    const child = {...base};
    for (const name of savedNames) {
      if (!Object.hasOwn(machineValues, name)) delete child[name];
      else child[name] = machineValues[name];
    }
    return child;
  }
  return {initialize, get, save, forChild};
}

const stateKey = Symbol.for('varisdev.environment-settings');
export function environmentSettings() {
  return (globalThis[stateKey] ??= createEnvironmentSettings());
}
export function environmentForChild(env = process.env) {
  return environmentSettings().forChild(env);
}
export async function initializeEnvironment() {
  const state = await environmentSettings().initialize();
  if (state.error) console.warn(`VarisDev: ${state.error}`);
}
