import {spawn} from 'node:child_process';
import {Buffer} from 'node:buffer';
import console from 'node:console';
import {setTimeout, clearTimeout} from 'node:timers';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {homedir, userInfo} from 'node:os';
import {statSync} from 'node:fs';
import {basename, dirname, join, win32} from 'node:path';
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
const continuationField = '__VARISDEV_ENVIRONMENT_CONTINUATION';
const continuationVersion = '1';
const suggestedFields = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
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

function fieldName(name, platform) {
  return platform === 'win32' ? name.toUpperCase() : name;
}

/** @param {NodeJS.ProcessEnv} [env] @param {NodeJS.Platform} [platform] */
export function copyEnvironment(
  env = process.env,
  platform = process.platform,
) {
  return Object.fromEntries(
    Object.entries(env).map(([name, value]) => [
      fieldName(name, platform),
      value,
    ]),
  );
}

/**
 * Make the selected Node executable available to npm lifecycle scripts.
 * @param {string} executable
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 */
export function withNodePath(
  executable,
  env = process.env,
  platform = process.platform,
) {
  const child = copyEnvironment(env, platform);
  const directory =
    platform === 'win32' ? win32.dirname(executable) : dirname(executable);
  child.PATH = [directory, child.PATH]
    .filter(Boolean)
    .join(platform === 'win32' ? ';' : ':');
  return child;
}

function fields(env, platform) {
  return Object.fromEntries(
    Object.entries(copyEnvironment(env, platform)).filter(
      ([name, value]) => isEnvironmentField(name) && typeof value === 'string',
    ),
  );
}

function setField(env, name, value, platform) {
  for (const key of Object.keys(env)) {
    if (fieldName(key, platform) === name) delete env[key];
  }
  if (value !== undefined) env[name] = value;
}

/** Preserve launch-specific tools, then restore registered Windows tools. */
export function windowsEnvironment(env, paths) {
  const values = fields(env, 'win32');
  const seen = new Set();
  values.PATH = [values.PATH, ...paths]
    .flatMap(value => (value || '').split(';'))
    .map(value => value.trim())
    .filter(value => {
      if (!value) return false;
      const path = win32.normalize(value);
      const key = (
        path === win32.parse(path).root ? path : path.replace(/\\+$/, '')
      ).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(';');
  return values;
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function accountShell() {
  try {
    return userInfo().shell;
  } catch {
    // Desktop launches may not have a user database entry.
    return undefined;
  }
}

/**
 * Select the same shell for startup environment reads and embedded terminals.
 * @param {{env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, shell?: string, exists?: (file: string) => boolean, userShell?: () => string | null | undefined}} [options]
 * @returns {{file: string, args: string[], kind: string}}
 */
export function resolveUserShell({
  env = process.env,
  platform = process.platform,
  shell,
  exists = isFile,
  userShell = accountShell,
} = {}) {
  if (platform !== 'win32') {
    const file =
      shell ||
      env.SHELL ||
      userShell() ||
      (platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
    return {file, args: ['-l'], kind: basename(file)};
  }
  const values = shellEnvironment(env, '', platform);
  if (!shell) {
    const candidates = [
      ...(values.PATH || '')
        .split(';')
        .map(path => path.trim().replace(/^"(.*)"$/, '$1'))
        .filter(Boolean)
        .map(path => win32.join(path, 'pwsh.exe')),
      ...new Set(
        [
          values.PROGRAMW6432,
          values.PROGRAMFILES,
          'C:\\Program Files',
          values['PROGRAMFILES(X86)'],
          'C:\\Program Files (x86)',
        ]
          .filter(Boolean)
          .map(path => win32.join(path, 'PowerShell', '7', 'pwsh.exe')),
      ),
      ...(values.LOCALAPPDATA
        ? [
            win32.join(
              values.LOCALAPPDATA,
              'Microsoft',
              'PowerShell',
              '7',
              'pwsh.exe',
            ),
            win32.join(
              values.LOCALAPPDATA,
              'Microsoft',
              'WindowsApps',
              'pwsh.exe',
            ),
          ]
        : []),
    ];
    shell = candidates.find(exists);
  }
  const file =
    shell ||
    win32.join(
      values.SYSTEMROOT || values.WINDIR || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
  const kind = win32
    .basename(file)
    .replace(/\.exe$/i, '')
    .toLowerCase();
  const args =
    kind === 'pwsh' || kind === 'powershell'
      ? ['-NoLogo']
      : kind === 'cmd'
        ? []
        : kind === 'bash'
          ? ['--login', '-i']
          : ['-l'];
  return {file, args, kind};
}

/**
 * Windows PowerShell must rebuild module paths inherited from PowerShell 7.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} kind
 * @param {NodeJS.Platform} [platform]
 * @returns {NodeJS.ProcessEnv}
 */
export function shellEnvironment(env, kind, platform = process.platform) {
  const values = copyEnvironment(env, platform);
  if (platform === 'win32' && kind === 'powershell') delete values.PSMODULEPATH;
  return values;
}

function powerShellLiteral(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function windowsEnvironmentSource(values, target) {
  if (values === undefined)
    return `[Environment]::GetEnvironmentVariables('${target}')`;
  return (
    '@{' +
    Object.entries(values)
      .filter(([, value]) => typeof value === 'string')
      .map(
        ([name, value]) =>
          `${powerShellLiteral(name)}=${powerShellLiteral(value)}`,
      )
      .join(';') +
    '}'
  );
}

const windowsStartupJob = `
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class VarisDevStartupJob {
  [StructLayout(LayoutKind.Sequential)]
  private struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations;
    public ulong ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")]
  private static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);
  public static void Attach() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    ExtendedLimits limits = new ExtendedLimits();
    limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))) ||
        !AssignProcessToJobObject(job, GetCurrentProcess())) {
      int error = Marshal.GetLastWin32Error();
      CloseHandle(job);
      throw new Win32Exception(error);
    }
    // The non-inheritable handle remains open until this PowerShell exits.
  }
}
`;

function windowsEnvironmentCommand(options, prefix, suffix) {
  const profiles =
    options.profilePaths === undefined
      ? '@($PROFILE.AllUsersAllHosts, $PROFILE.AllUsersCurrentHost, $PROFILE.CurrentUserAllHosts, $PROFILE.CurrentUserCurrentHost)'
      : '@(' + options.profilePaths.map(powerShellLiteral).join(',') + ')';
  return `
    $ErrorActionPreference = 'Stop'
    $machine = ${windowsEnvironmentSource(options.machineEnvironment, 'Machine')}
    $user = ${windowsEnvironmentSource(options.userEnvironment, 'User')}
    $inherited = @{}
    foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
      $inherited[$entry.Key] = $entry.Value
    }
    $registered = @{}
    foreach ($scope in @($machine, $user)) {
      foreach ($entry in $scope.GetEnumerator()) { $registered[$entry.Key] = $entry.Value }
    }
    foreach ($entry in $registered.GetEnumerator()) {
      if (!$inherited.ContainsKey($entry.Key)) {
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
      }
    }
    foreach ($entry in $registered.GetEnumerator()) {
      if (!$inherited.ContainsKey($entry.Key)) {
        [Environment]::SetEnvironmentVariable($entry.Key, [Environment]::ExpandEnvironmentVariables($entry.Value), 'Process')
      }
    }
    $env:Path = (@(
      $inherited['Path'],
      [Environment]::ExpandEnvironmentVariables([string]$machine['Path']),
      [Environment]::ExpandEnvironmentVariables([string]$user['Path'])
    ) | Where-Object { $_ }) -join ';'
    Add-Type -TypeDefinition ${powerShellLiteral(windowsStartupJob)}
    [VarisDevStartupJob]::Attach()
    $ErrorActionPreference = 'Continue'
    foreach ($profilePath in ${profiles}) {
      if (Test-Path -LiteralPath $profilePath -PathType Leaf) {
        try { . $profilePath *> $null } catch { }
      }
    }
    $ErrorActionPreference = 'Stop'
    $values = @{}
    foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
      $values[$entry.Key] = $entry.Value
    }
    $json = Microsoft.PowerShell.Utility\\ConvertTo-Json -Compress -InputObject $values
    $bytes = [Text.Encoding]::UTF8.GetBytes(${powerShellLiteral(prefix)} + $json + ${powerShellLiteral(suffix)})
    $output = [Console]::OpenStandardOutput()
    $output.Write($bytes, 0, $bytes.Length)
    $output.Flush()
  `;
}

/**
 * Read registered Windows values and shell profile exports without logging values.
 * @param {{env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, shell?: string, timeoutMs?: number, signal?: AbortSignal, windows?: {machineEnvironment?: NodeJS.ProcessEnv, userEnvironment?: NodeJS.ProcessEnv, profilePaths?: string[]}}} [options]
 * @returns {Promise<Record<string, string>>}
 */
export function readShellEnvironment({
  env = process.env,
  platform = process.platform,
  shell,
  timeoutMs = 8000,
  signal,
  windows: windowsOptions = {},
} = {}) {
  const windows = platform === 'win32';
  const selected = resolveUserShell({env, platform, shell});
  const childEnv = shellEnvironment(env, selected.kind, platform);
  const system32 = win32.join(
    childEnv.SYSTEMROOT || childEnv.WINDIR || 'C:\\Windows',
    'System32',
  );
  const name = selected.kind;
  const label =
    {
      zsh: 'Zsh',
      bash: 'Bash',
      fish: 'Fish',
      nu: 'Nushell',
      pwsh: 'PowerShell 7',
      powershell: 'Windows PowerShell',
    }[name] || 'the shell';
  const source = name === 'zsh' ? '.zshrc' : `${label} startup files`;
  const token = randomUUID();
  const prefix = `__VARISDEV_ENV_${token}_START__`;
  const suffix = `__VARISDEV_ENV_${token}_END__`;
  // Bash login profiles need not source .bashrc. Read the login environment,
  // then exec an interactive shell so both startup contexts are honored.
  const shellArgs = windows
    ? [
        ...selected.args,
        // Defer profiles until registered variables are available to them.
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(
          windowsEnvironmentCommand(windowsOptions, prefix, suffix),
          'utf16le',
        ).toString('base64'),
      ]
    : name === 'bash'
      ? ['+m', '-lc', 'exec "$BASH" +m -ic \'/usr/bin/env -0 >&3\'']
      : name === 'nu'
        ? [
            '--login',
            '--interactive',
            '--commands',
            "^/bin/sh -c '/usr/bin/env -0 >&3'",
          ]
        : [
            ...(name === 'zsh' ? ['-o', 'NO_MONITOR'] : []),
            '-lic',
            '/usr/bin/env -0 >&3',
          ];
  const startFailure = () =>
    new Error(
      `Could not start ${label} to read ${name === 'zsh' ? '.zshrc' : 'its startup files'}.`,
    );
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    let child;
    try {
      child = spawn(selected.file, shellArgs, {
        env: childEnv,
        cwd: childEnv.HOME || childEnv.USERPROFILE || homedir(),
        detached: !windows,
        windowsHide: true,
        stdio: windows
          ? ['ignore', 'pipe', 'ignore']
          : ['ignore', 'ignore', 'ignore', 'pipe'],
      });
    } catch {
      reject(startFailure());
      return;
    }
    let output = Buffer.alloc(0);
    let failure;
    let exited = false;
    child.once('exit', () => {
      exited = true;
    });
    const stream = child.stdio[windows ? 1 : 3];
    const stop = error => {
      if (failure) return;
      failure = error;
      if (windows && child.pid && !exited) {
        const killer = spawn(
          win32.join(system32, 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          {
            windowsHide: true,
            stdio: 'ignore',
            timeout: 5000,
            killSignal: 'SIGKILL',
          },
        );
        killer.once('error', () => {
          child.kill('SIGKILL');
          stream.destroy();
        });
        killer.once('close', code => {
          if (code !== 0) child.kill('SIGKILL');
          stream.destroy();
        });
      } else {
        try {
          if (!windows && child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
        stream.destroy();
      }
    };
    const timer = setTimeout(
      () => stop(new Error(`Reading ${source} timed out.`)),
      timeoutMs,
    );
    const abort = () => stop(new Error(`Reading ${source} was cancelled.`));
    signal?.addEventListener('abort', abort, {once: true});
    stream.on('data', chunk => {
      if (output.length + chunk.length > 1024 * 1024) {
        stop(new Error('The shell environment is too large.'));
        return;
      }
      output = Buffer.concat([output, chunk]);
    });
    child.once('error', () => {
      failure ??= startFailure();
    });
    child.once('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) return reject(failure);
      if (code !== 0)
        return reject(
          new Error(`Could not read ${source}: shell startup failed.`),
        );
      if (windows) {
        try {
          const text = output.toString('utf8');
          const start = text.indexOf(prefix);
          const end = text.indexOf(suffix, start + prefix.length);
          if (start < 0 || end < 0) throw new Error();
          const values = JSON.parse(text.slice(start + prefix.length, end));
          if (
            !values ||
            Array.isArray(values) ||
            typeof values !== 'object' ||
            Object.values(values).some(value => typeof value !== 'string')
          )
            throw new Error();
          return resolve(windowsEnvironment(values, []));
        } catch {
          return reject(new Error(`Could not read ${source}.`));
        }
      }
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

/** @param {{env?: NodeJS.ProcessEnv, initialEnv?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, file?: string, shell?: string, timeoutMs?: number, signal?: AbortSignal, windows?: {machineEnvironment?: NodeJS.ProcessEnv, userEnvironment?: NodeJS.ProcessEnv, profilePaths?: string[]}, readEnvironment?: typeof readShellEnvironment}} [options] */
export function createEnvironmentSettings({
  env = process.env,
  initialEnv = env,
  platform = process.platform,
  file,
  shell,
  timeoutMs,
  signal,
  windows,
  readEnvironment = readShellEnvironment,
} = {}) {
  const inherited = fields(initialEnv, platform);
  let machine;
  let shellInitialized = false;
  let machineValues = inherited;
  let error;
  let applied = new Set(Object.keys(fields(env, platform)));
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
          !isEnvironmentField(fieldName(name, platform)) ||
          typeof value !== 'string',
      )
    )
      throw new Error(
        'environment.json must contain configurable environment names with string values.',
      );
    return saved;
  }
  async function initialize() {
    if (!machine) {
      const source = copyEnvironment(initialEnv, platform);
      const continued = source[continuationField] === continuationVersion;
      delete source[continuationField];
      setField(env, continuationField, undefined, platform);
      if (continued) {
        shellInitialized = true;
        machine = Promise.resolve(inherited);
      } else {
        machine = readEnvironment({
          env: source,
          platform,
          shell,
          timeoutMs,
          signal,
          windows,
        })
          .then(shellValues => {
            machineValues = fields(shellValues, platform);
            shellInitialized = true;
            return machineValues;
          })
          .catch(cause => {
            error = `${cause.message} Using the inherited environment and saved settings.`;
            return inherited;
          });
      }
    }
    return get();
  }
  async function get() {
    if (!machine) return initialize();
    await machine;
    file ??= environmentPath(
      {HOME: env.HOME, USERPROFILE: env.USERPROFILE, ...machineValues},
      platform,
    );
    const saved = fields(await readSaved(), platform);
    const values = {...machineValues, ...saved};
    for (const name of applied)
      if (!Object.hasOwn(values, name))
        setField(env, name, undefined, platform);
    for (const [name, value] of Object.entries(values)) {
      if (lastValues[name] !== value) setField(env, name, value, platform);
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
    if (typeof name === 'string') name = fieldName(name, platform);
    if (!isEnvironmentField(name))
      throw new Error('Choose a configurable environment variable name.');
    if (value !== null && (typeof value !== 'string' || value.includes('\0')))
      throw new Error('Enter an environment value without null characters.');
    const operation = saving.then(async () => {
      await initialize();
      const saved = await readSaved();
      setField(saved, name, value === null ? undefined : value, platform);
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
  // App children load the JSON themselves. Preserve their real fallback
  // rather than passing a saved value off as an inherited environment value.
  // Only handoffs within the same launch may skip reading the shell again.
  function forChild(base = env, {reuseShell = false} = {}) {
    const child = copyEnvironment(base, platform);
    delete child[continuationField];
    for (const name of savedNames)
      setField(child, name, machineValues[name], platform);
    if (reuseShell && shellInitialized)
      child[continuationField] = continuationVersion;
    return child;
  }
  return {initialize, get, save, forChild};
}

const stateKey = Symbol.for('varisdev.environment-settings');
const previousStateKey = Symbol.for('varisdev.environment-settings.v2');
const previousVersionedStateKey = Symbol.for(
  'varisdev.environment-settings.v3',
);
const versionedStateKey = Symbol.for('varisdev.environment-settings.v4');
export function environmentSettings() {
  if (!globalThis[versionedStateKey]) {
    // Older helpers may cache a failed or PATH-only shell read. Recover their
    // fallback so saved overrides do not become inherited values.
    const previous =
      globalThis[previousVersionedStateKey] ||
      globalThis[previousStateKey] ||
      globalThis[stateKey];
    const initialEnv = previous
      ? copyEnvironment(previous.forChild(process.env))
      : undefined;
    if (initialEnv) delete initialEnv[continuationField];
    globalThis[versionedStateKey] = createEnvironmentSettings({initialEnv});
    globalThis[stateKey] = globalThis[versionedStateKey];
    globalThis[previousStateKey] = globalThis[versionedStateKey];
    globalThis[previousVersionedStateKey] = globalThis[versionedStateKey];
  }
  return globalThis[versionedStateKey];
}
/** @param {NodeJS.ProcessEnv} [env] @param {{reuseShell?: boolean}} [options] */
export function environmentForChild(env = process.env, options = {}) {
  return environmentSettings().forChild(env, options);
}
export async function initializeEnvironment() {
  const state = await environmentSettings().initialize();
  if (state.error) console.warn(`VarisDev: ${state.error}`);
}
