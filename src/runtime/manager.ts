import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {refreshMacLauncher} from './mac-launcher.ts';
import {withNodePath} from './environment.mjs';
import {
  downloadRelease,
  readRelease,
  releaseURL,
  type Release,
} from './distribution.mjs';

const enginePackage = '@earendil-works/pi-coding-agent';
const sourceInputs = [
  'src',
  'assets',
  'extensions',
  'themes',
  'scripts',
  'bin',
  'tsconfig.desktop.json',
  'package.json',
  'package-lock.json',
  'desktop/package.json',
  'desktop/package-lock.json',
];

export interface UpdateProgress {
  stage:
    | 'waiting'
    | 'checking'
    | 'downloading'
    | 'preparing'
    | 'installing'
    | 'verifying'
    | 'activating';
  transferredBytes?: number;
  totalBytes?: number;
}

export interface UpdateStatus {
  progress?: UpdateProgress;
  phase: 'idle' | 'checking' | 'available' | 'updating' | 'ready' | 'error';
  currentVersion: string;
  currentRevision?: string;
  latestRevision?: string;
  latestVersion?: string;
  checkedAt?: string;
  error?: string;
  restartRequired: boolean;
}

export interface RuntimeCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface RuntimeHooks {
  run?: (
    command: string,
    args: string[],
    options: RuntimeCommandOptions,
  ) => Promise<string | void>;
  smokeImport?: (root: string) => Promise<void>;
  now?: () => Date;
  readRelease?: typeof readRelease;
  downloadRelease?: typeof downloadRelease;
}

export interface RuntimeManagerOptions {
  installRoot: string;
  dataDir?: string;
  /** The source tree captured when a desktop process started. */
  runningRoot?: string;
  requestTimeoutMs?: number;
  commandTimeoutMs?: number;
  lockTimeoutMs?: number;
  hooks?: RuntimeHooks;
}

interface ActiveRuntime {
  generation: string;
  baseRoot: string;
  fingerprint: string;
  version: string;
  revision?: string;
}

interface AppRelease {
  revision: string;
  source: string;
  archive?: Release;
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VARISDEV_DATA_DIR) return resolve(env.VARISDEV_DATA_DIR);
  if (process.platform === 'darwin')
    return join(
      env.HOME || homedir(),
      'Library',
      'Application Support',
      'VarisDev',
    );
  if (process.platform === 'win32')
    return join(
      env.LOCALAPPDATA ||
        join(env.USERPROFILE || homedir(), 'AppData', 'Local'),
      'VarisDev',
    );
  return join(
    env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local', 'share'),
    'varisdev',
  );
}

function stableVersion(version: unknown): version is string {
  return typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version);
}

function installedVersion(root: string): string {
  const file = join(
    root,
    'desktop',
    'node_modules',
    enginePackage,
    'package.json',
  );
  const value = JSON.parse(readFileSync(file, 'utf8')) as {version?: string};
  if (!stableVersion(value.version))
    throw new Error('The installed VarisDev runtime version is invalid.');
  return value.version;
}

async function sourceFingerprint(root: string): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (relative: string): Promise<void> => {
    const path = join(root, relative);
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      hash.update(`missing:${relative}\0`);
      return;
    }
    if (info.isDirectory()) {
      const entries = await readdir(path, {withFileTypes: true});
      for (const entry of entries.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        // Package inputs never include installed dependencies or generated output.
        if (['node_modules', 'build', '.git'].includes(entry.name)) continue;
        if (entry.isSymbolicLink())
          throw new Error('VarisDev runtime source contains a symbolic link.');
        await visit(join(relative, entry.name));
      }
    } else {
      hash.update(`${relative}\0`);
      hash.update(await readFile(path));
      hash.update('\0');
    }
  };
  for (const input of sourceInputs) await visit(input);
  return hash.digest('hex');
}

export async function runRuntimeCommand(
  command: string,
  args: string[],
  options: RuntimeCommandOptions,
): Promise<string> {
  return new Promise<string>((fulfill, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let output = '';
    let stdout = '';
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-12_000);
    };
    child.stdout.on('data', chunk => {
      stdout = (stdout + chunk.toString()).slice(-16384);
      append(chunk);
    });
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn(
          'taskkill',
          ['/pid', String(child.pid), '/T', '/F'],
          {
            stdio: 'ignore',
            windowsHide: true,
          },
        );
        killer.on('error', () => child.kill('SIGKILL'));
      } else {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    }, options.timeoutMs);
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error('VarisDev update preparation timed out.'));
      else if (code !== 0)
        reject(
          new Error(
            `VarisDev update preparation failed (${code}). ${output.trim()}`,
          ),
        );
      else fulfill(stdout);
    });
  });
}

const applicationSources = [
  'ssh://git@github.com/HardDoer/varisdev.git',
  'https://github.com/HardDoer/varisdev.git',
];

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    ...(process.env.GIT_SSH_COMMAND || process.env.GIT_SSH
      ? {}
      : {GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes'}),
  };
}

function applicationSource(root: string): string | undefined {
  try {
    const info = JSON.parse(
      readFileSync(join(root, 'build-info.json'), 'utf8'),
    ) as {source?: string};
    return info.source &&
      (applicationSources.includes(info.source) || info.source === releaseURL)
      ? info.source
      : undefined;
  } catch {
    return undefined;
  }
}

function applicationVersion(root: string): string {
  const manifest = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  ) as {name?: string; version?: string};
  if (
    manifest.name !== 'varisdev' ||
    typeof manifest.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version)
  )
    throw new Error('The installed VarisDev application version is invalid.');
  return manifest.version;
}

function applicationRevision(root: string): string | undefined {
  try {
    const info = JSON.parse(
      readFileSync(join(root, 'build-info.json'), 'utf8'),
    ) as {revision?: string};
    return typeof info.revision === 'string' &&
      /^[a-f0-9]{40}$/.test(info.revision)
      ? info.revision
      : undefined;
  } catch {
    return undefined;
  }
}

/** Stages complete application installs and activates them after verification. */
export class RuntimeManager {
  readonly installRoot: string;
  readonly dataDir: string;
  private readonly options: RuntimeManagerOptions;
  private readonly listeners = new Set<(status: UpdateStatus) => void>();
  private state: UpdateStatus;
  private updating?: Promise<UpdateStatus>;
  private checking?: Promise<UpdateStatus>;

  constructor(options: RuntimeManagerOptions) {
    this.options = options;
    this.installRoot = resolve(options.installRoot);
    this.dataDir = resolve(options.dataDir || defaultDataDir());
    let version = '';
    try {
      version = applicationVersion(options.runningRoot || this.installRoot);
    } catch {
      /* check() reports missing application metadata. */
    }
    this.state = {
      phase: 'idle',
      currentVersion: version,
      currentRevision: applicationRevision(
        options.runningRoot || this.installRoot,
      ),
      restartRequired: false,
    };
  }

  status(): UpdateStatus {
    return {...this.state};
  }
  subscribe(listener: (status: UpdateStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private publish(patch: Partial<UpdateStatus>): UpdateStatus {
    this.state = {...this.state, ...patch};
    for (const listener of this.listeners) {
      try {
        listener(this.status());
      } catch {
        /* A disconnected UI must not interrupt activation. */
      }
    }
    return this.status();
  }

  async currentRoot(): Promise<string> {
    const root = await this.selectedRoot();
    if (this.options.runningRoot)
      this.state.restartRequired = resolve(this.options.runningRoot) !== root;
    return root;
  }

  private async selectedRoot(): Promise<string> {
    let pointer: ActiveRuntime;
    try {
      pointer = JSON.parse(
        await readFile(join(this.dataDir, 'active.json'), 'utf8'),
      );
    } catch {
      return this.installRoot;
    }
    if (
      !pointer ||
      typeof pointer.generation !== 'string' ||
      !/^(?:runtime-\d+\.\d+\.\d+-[a-f0-9-]+|app-[a-f0-9]{16})$/.test(
        pointer.generation,
      ) ||
      pointer.baseRoot !== this.installRoot ||
      typeof pointer.version !== 'string' ||
      pointer.fingerprint !== (await sourceFingerprint(this.installRoot))
    )
      return this.installRoot;
    const generation = join(this.dataDir, 'runtimes', pointer.generation);
    const application = pointer.generation.startsWith('app-');
    const root = application
      ? join(
          generation,
          process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
          'varisdev',
        )
      : generation;
    try {
      if (application) {
        if (
          !pointer.revision ||
          pointer.revision !== applicationRevision(root) ||
          applicationVersion(root) !== pointer.version
        )
          return this.installRoot;
      } else if (installedVersion(root) !== pointer.version)
        return this.installRoot;
      await stat(join(root, 'desktop/build/src/dashboard/parent.js'));
      return root;
    } catch {
      return this.installRoot;
    }
  }

  async currentPiVersion(): Promise<string> {
    return installedVersion(await this.currentRoot());
  }

  check(): Promise<UpdateStatus> {
    if (this.updating) return this.updating;
    if (this.checking) return this.checking;
    this.checking = this.performCheck().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }
  private async performCheck(): Promise<UpdateStatus> {
    this.publish({
      phase: 'checking',
      progress: {stage: 'checking'},
      error: undefined,
    });
    try {
      const root = await this.currentRoot();
      const currentVersion = applicationVersion(root);
      const currentRevision = applicationRevision(root);
      const release = await this.latest();
      return this.publish({
        phase:
          release.revision !== currentRevision
            ? 'available'
            : this.state.restartRequired
              ? 'ready'
              : 'idle',
        currentVersion,
        currentRevision,
        latestVersion: release.archive?.version,
        latestRevision: release.revision,
        checkedAt: this.now().toISOString(),
        progress: undefined,
      });
    } catch (error) {
      return this.fail(error);
    }
  }

  update(): Promise<UpdateStatus> {
    if (this.updating) return this.updating;
    this.updating = (async () => {
      if (this.checking) await this.checking;
      return this.performUpdate();
    })().finally(() => {
      this.updating = undefined;
    });
    return this.updating;
  }

  private async performUpdate(): Promise<UpdateStatus> {
    this.publish({
      phase: 'updating',
      progress: {stage: 'waiting'},
      error: undefined,
    });
    let unlock: (() => Promise<void>) | undefined;
    let stage: string | undefined;
    let pointerTemp: string | undefined;
    try {
      const previousRoot = await this.currentRoot();
      unlock = await this.acquireLock();
      const activeRoot = await this.currentRoot();
      const currentVersion = applicationVersion(activeRoot);
      const currentRevision = applicationRevision(activeRoot);
      this.publish({progress: {stage: 'checking'}});
      const release = await this.latest();
      this.publish({
        currentVersion,
        currentRevision,
        latestVersion: release.archive?.version,
        latestRevision: release.revision,
        checkedAt: this.now().toISOString(),
      });
      if (release.revision === currentRevision) {
        const restartRequired =
          this.state.restartRequired || previousRoot !== activeRoot;
        return this.publish({
          phase: restartRequired ? 'ready' : 'idle',
          restartRequired,
          progress: undefined,
        });
      }
      this.publish({progress: {stage: 'preparing'}});
      const fingerprint = await sourceFingerprint(this.installRoot);
      // Keep nested npm lifecycle working directories below Windows path limits.
      const generation = `app-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
      stage = join(this.dataDir, 'runtimes', generation);
      await mkdir(stage, {recursive: true});
      const require = createRequire(join(activeRoot, 'package.json'));
      const executable =
        process.env.VARISDEV_NODE_EXECUTABLE || process.execPath;
      const env = withNodePath(executable, gitEnvironment());
      if (process.versions.electron && executable === process.execPath)
        env.ELECTRON_RUN_AS_NODE = '1';
      else delete env.ELECTRON_RUN_AS_NODE;
      const run = this.options.hooks?.run || runRuntimeCommand;
      const commandOptions = {
        env,
        timeoutMs: this.options.commandTimeoutMs ?? 10 * 60_000,
      };
      const source = join(stage, 'source');
      const npm = join(
        dirname(require.resolve('npm/package.json')),
        'bin/npm-cli.js',
      );
      let version: string;
      let archive: string;
      if (release.archive) {
        version = release.archive.version;
        archive = join(stage, `varisdev-${version}.tgz`);
        this.publish({progress: {stage: 'downloading'}});
        await (this.options.hooks?.downloadRelease || downloadRelease)(
          release.archive,
          archive,
          commandOptions.timeoutMs,
          progress =>
            this.publish({progress: {stage: 'downloading', ...progress}}),
        );
      } else {
        await run('git', ['init', source], {...commandOptions, cwd: stage});
        this.publish({progress: {stage: 'downloading'}});
        await run(
          'git',
          ['fetch', '--depth=1', release.source, release.revision],
          {...commandOptions, cwd: source},
        );
        await run('git', ['checkout', '--detach', 'FETCH_HEAD'], {
          ...commandOptions,
          cwd: source,
        });
        version = applicationVersion(source);
        this.publish({progress: {stage: 'preparing'}});
        await run(executable, [npm, 'pack', '--pack-destination', stage], {
          ...commandOptions,
          cwd: source,
        });
        archive = join(stage, `varisdev-${version}.tgz`);
      }
      this.publish({progress: {stage: 'installing'}});
      await run(
        executable,
        [
          npm,
          'install',
          '--global=true',
          '--prefix',
          stage,
          '--omit=dev',
          '--legacy-peer-deps',
          '--no-audit',
          '--no-fund',
          ...(release.archive ? ['--ignore-scripts'] : []),
          archive,
        ],
        {...commandOptions, cwd: stage},
      );
      const root = join(
        stage,
        process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
        'varisdev',
      );
      if (release.archive) {
        if (applicationRevision(root) !== release.revision)
          throw new Error(
            'The prepared application does not match the release manifest.',
          );
        this.publish({progress: {stage: 'preparing'}});
        await run(executable, [join(root, 'scripts/install-desktop.mjs')], {
          ...commandOptions,
          cwd: root,
        });
      }
      this.publish({progress: {stage: 'verifying'}});
      if (applicationVersion(root) !== version)
        throw new Error(
          'The prepared VarisDev application has an unexpected version.',
        );
      installedVersion(root);
      for (const file of [
        'bin/varisdev.mjs',
        'assets/dashboard/index.html',
        'assets/desktop/preload.cjs',
        'desktop/build/src/runtime/cli.js',
        'desktop/build/src/desktop/main.js',
      ])
        await stat(join(root, file));
      if (this.options.hooks?.smokeImport)
        await this.options.hooks.smokeImport(root);
      else
        await run(
          executable,
          [
            '--input-type=module',
            '--eval',
            `await import(${JSON.stringify(pathToFileURL(join(root, 'desktop/build/src/dashboard/parent.js')).href)}); await import(${JSON.stringify(pathToFileURL(join(root, 'desktop/build/src/runtime/cli.js')).href)});`,
          ],
          {...commandOptions, cwd: root},
        );
      await writeFile(
        join(root, 'build-info.json'),
        JSON.stringify({revision: release.revision, source: release.source}) +
          '\n',
      );
      await rm(source, {recursive: true, force: true});
      await rm(archive, {force: true});
      if (fingerprint !== (await sourceFingerprint(this.installRoot)))
        throw new Error(
          'VarisDev app files changed during the update. Please retry.',
        );
      this.publish({progress: {stage: 'activating'}});
      if (process.platform === 'darwin')
        await refreshMacLauncher(this.installRoot, root);
      const pointer: ActiveRuntime = {
        generation,
        baseRoot: this.installRoot,
        fingerprint,
        version,
        revision: release.revision,
      };
      await writeFile(
        join(stage, 'runtime.json'),
        JSON.stringify(pointer) + '\n',
      );
      pointerTemp = join(this.dataDir, `active-${randomUUID()}.tmp`);
      await writeFile(pointerTemp, JSON.stringify(pointer) + '\n');
      await rename(pointerTemp, join(this.dataDir, 'active.json'));
      pointerTemp = undefined;
      stage = undefined;
      return this.publish({
        phase: 'ready',
        currentVersion: version,
        latestVersion: version,
        currentRevision: release.revision,
        restartRequired: true,
        progress: undefined,
      });
    } catch (error) {
      return this.fail(error);
    } finally {
      if (pointerTemp) await rm(pointerTemp, {force: true}).catch(() => {});
      if (stage)
        await rm(stage, {recursive: true, force: true}).catch(() => {});
      if (unlock) await unlock();
    }
  }

  private now(): Date {
    return this.options.hooks?.now?.() || new Date();
  }
  private fail(error: unknown): UpdateStatus {
    return this.publish({
      phase: 'error',
      progress: undefined,
      error: `VarisDev update: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  private async latest(): Promise<AppRelease> {
    if (applicationSource(await this.currentRoot()) === releaseURL) {
      const archive = await (this.options.hooks?.readRelease || readRelease)(
        releaseURL,
        this.options.requestTimeoutMs ?? 15000,
      );
      return {revision: archive.revision, source: releaseURL, archive};
    }
    // Git installations retain their original update source.
    const preferred =
      applicationSource(await this.currentRoot()) || applicationSources[1];
    const sources = [
      preferred,
      ...applicationSources.filter(source => source !== preferred),
    ];
    const run = this.options.hooks?.run || runRuntimeCommand;
    const deadline = Date.now() + (this.options.requestTimeoutMs ?? 15_000);
    let failure: unknown;
    for (const source of sources) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const output = await Promise.race([
          run('git', ['ls-remote', '--exit-code', source, 'HEAD'], {
            cwd: this.installRoot,
            env: gitEnvironment(),
            timeoutMs: remaining,
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(new Error('Checking for VarisDev updates timed out.')),
              remaining,
            );
          }),
        ]);
        const revision =
          typeof output === 'string'
            ? /^([a-f0-9]{40})\s+HEAD\s*$/m.exec(output)?.[1]
            : undefined;
        if (!revision)
          throw new Error('Git did not return a valid application revision.');
        return {revision, source};
      } catch (error) {
        failure = error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw failure || new Error('Checking for VarisDev updates timed out.');
  }

  private async lockIsStale(
    lock: string,
    observedMtime: number,
  ): Promise<boolean> {
    try {
      const owner = JSON.parse(
        await readFile(join(lock, 'owner.json'), 'utf8'),
      );
      if (!Number.isInteger(owner.pid) || owner.pid <= 0)
        throw new Error('Invalid owner');
      try {
        process.kill(owner.pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    } catch {
      // A new owner needs time to finish writing its metadata.
      return Date.now() - observedMtime > 30_000;
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    await mkdir(this.dataDir, {recursive: true});
    const lock = join(this.dataDir, 'update.lock');
    const token = randomUUID();
    const started = Date.now();
    while (true) {
      try {
        await mkdir(lock);
        try {
          await writeFile(
            join(lock, 'owner.json'),
            JSON.stringify({pid: process.pid, token}),
          );
        } catch (error) {
          await rm(lock, {recursive: true, force: true});
          throw error;
        }
        return async () => {
          try {
            const owner = JSON.parse(
              await readFile(join(lock, 'owner.json'), 'utf8'),
            );
            if (owner.token === token)
              await rm(lock, {recursive: true, force: true});
          } catch {
            // Another owner or a removed directory needs no cleanup.
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (Date.now() - started >= (this.options.lockTimeoutMs ?? 15 * 60_000))
        throw new Error(
          'Another VarisDev update is still running. Please retry.',
        );
      try {
        const observed = await stat(lock);
        if (await this.lockIsStale(lock, observed.mtimeMs)) {
          // Elect one recovering process, then recheck both directory identity
          // and owner so an old observation cannot remove a new lock.
          const recovery = join(lock, 'recovery');
          let elected = false;
          try {
            await mkdir(recovery);
            elected = true;
            const current = await stat(lock);
            if (
              current.ino === observed.ino &&
              current.dev === observed.dev &&
              (await this.lockIsStale(lock, observed.mtimeMs))
            ) {
              const abandoned = `${lock}-abandoned-${randomUUID()}`;
              await rename(lock, abandoned);
              await rm(abandoned, {recursive: true, force: true});
              elected = false;
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            // A process can die after being elected for recovery as well.
            if (Date.now() - (await stat(recovery)).mtimeMs > 30_000)
              await rm(recovery, {recursive: true, force: true});
          } finally {
            if (elected) await rm(recovery, {recursive: true, force: true});
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await new Promise(fulfill => setTimeout(fulfill, 100));
    }
  }
}
