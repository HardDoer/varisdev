import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const enginePackage = '@earendil-works/pi-coding-agent';
const sdkPackages = [
  enginePackage,
  '@earendil-works/pi-ai',
  '@earendil-works/pi-tui',
];
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

export interface UpdateStatus {
  phase: 'idle' | 'checking' | 'available' | 'updating' | 'ready' | 'error';
  currentVersion: string;
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
  fetch?: typeof globalThis.fetch;
  run?: (
    command: string,
    args: string[],
    options: RuntimeCommandOptions,
  ) => Promise<void>;
  smokeImport?: (root: string) => Promise<void>;
  now?: () => Date;
}

export interface RuntimeManagerOptions {
  installRoot: string;
  dataDir?: string;
  /** The source tree captured when a desktop process started. */
  runningRoot?: string;
  registryUrl?: string;
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
}

interface RegistryRelease {
  version: string;
  dependencies?: Record<string, string>;
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

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index])
      return left[index] > right[index] ? 1 : -1;
  }
  return 0;
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

async function runCommand(
  command: string,
  args: string[],
  options: RuntimeCommandOptions,
): Promise<void> {
  await new Promise<void>((fulfill, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let output = '';
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-12_000);
    };
    child.stdout.on('data', append);
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
      if (timedOut)
        reject(new Error('VarisDev runtime preparation timed out.'));
      else if (code !== 0)
        reject(
          new Error(
            `VarisDev runtime preparation failed (${code}). ${output.trim()}`,
          ),
        );
      else fulfill();
    });
  });
}

/** Builds isolated runtime generations; only a fully verified generation becomes active. */
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
      version = installedVersion(options.runningRoot || this.installRoot);
    } catch {
      // check() exposes missing or malformed runtime metadata as an error.
    }
    this.state = {
      phase: 'idle',
      currentVersion: version,
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
        // A disconnected UI must not interrupt activation or lock cleanup.
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
      !/^runtime-\d+\.\d+\.\d+-[a-f0-9-]+$/.test(pointer.generation) ||
      pointer.baseRoot !== this.installRoot ||
      !stableVersion(pointer.version) ||
      pointer.fingerprint !== (await sourceFingerprint(this.installRoot))
    )
      return this.installRoot;
    const root = join(this.dataDir, 'runtimes', pointer.generation);
    try {
      if (installedVersion(root) !== pointer.version) return this.installRoot;
      await stat(
        join(root, 'desktop', 'build', 'src', 'dashboard', 'parent.js'),
      );
      return root;
    } catch {
      return this.installRoot;
    }
  }

  async currentPiVersion(): Promise<string> {
    const version = installedVersion(await this.currentRoot());
    this.state.currentVersion = version;
    return version;
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
    this.publish({phase: 'checking', error: undefined});
    try {
      const currentVersion = await this.currentPiVersion();
      const release = await this.latest();
      const available = compareVersions(release.version, currentVersion) > 0;
      return this.publish({
        phase: available
          ? 'available'
          : this.state.restartRequired
            ? 'ready'
            : 'idle',
        currentVersion,
        latestVersion: release.version,
        checkedAt: this.now().toISOString(),
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
    this.publish({phase: 'updating', error: undefined});
    let unlock: (() => Promise<void>) | undefined;
    let stage: string | undefined;
    let pointerTemp: string | undefined;
    try {
      const previousRoot = await this.currentRoot();
      unlock = await this.acquireLock();
      const currentVersion = await this.currentPiVersion();
      const release = await this.latest();
      this.publish({
        latestVersion: release.version,
        checkedAt: this.now().toISOString(),
      });
      if (compareVersions(release.version, currentVersion) <= 0) {
        const restartRequired =
          this.state.restartRequired ||
          previousRoot !== (await this.currentRoot());
        return this.publish({
          phase: restartRequired ? 'ready' : 'idle',
          restartRequired,
        });
      }
      const fingerprint = await sourceFingerprint(this.installRoot);
      const generation = `runtime-${release.version}-${randomUUID()}`;
      stage = join(this.dataDir, 'runtimes', generation);
      await mkdir(stage, {recursive: true});
      for (const input of sourceInputs) {
        // The SDK lock describes the old generation; npm resolves a new one.
        if (input === 'desktop/package-lock.json') continue;
        const from = join(this.installRoot, input);
        try {
          await stat(from);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        await cp(from, join(stage, input), {recursive: true});
      }
      await symlink(
        join(this.installRoot, 'node_modules'),
        join(stage, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const manifestPath = join(stage, 'desktop', 'package.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.dependencies ??= {};
      for (const name of sdkPackages)
        manifest.dependencies[name] = release.version;
      if (release.dependencies?.typebox)
        manifest.dependencies.typebox = release.dependencies.typebox;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const require = createRequire(join(this.installRoot, 'package.json'));
      const env = {...process.env};
      const executable = env.VARISDEV_NODE_EXECUTABLE || process.execPath;
      if (process.versions.electron && executable === process.execPath)
        env.ELECTRON_RUN_AS_NODE = '1';
      else delete env.ELECTRON_RUN_AS_NODE;
      env.npm_config_registry = await this.registry();
      const run = this.options.hooks?.run || runCommand;
      const commandOptions = {
        env,
        timeoutMs: this.options.commandTimeoutMs ?? 10 * 60_000,
      };
      await run(
        executable,
        [
          join(
            dirname(require.resolve('npm/package.json')),
            'bin',
            'npm-cli.js',
          ),
          'install',
          '--global=false',
          '--prefix',
          join(stage, 'desktop'),
          '--omit=dev',
          '--legacy-peer-deps',
          '--no-audit',
          '--no-fund',
        ],
        {...commandOptions, cwd: join(stage, 'desktop')},
      );
      if (installedVersion(stage) !== release.version)
        throw new Error(
          'The prepared VarisDev runtime has an unexpected version.',
        );
      await run(
        executable,
        [
          require.resolve('typescript/bin/tsc'),
          '--project',
          join(stage, 'tsconfig.desktop.json'),
        ],
        {...commandOptions, cwd: stage},
      );
      if (this.options.hooks?.smokeImport)
        await this.options.hooks.smokeImport(stage);
      else
        await run(
          executable,
          [
            '--input-type=module',
            '--eval',
            `await import(${JSON.stringify(pathToFileURL(join(stage, 'desktop', 'build', 'src', 'dashboard', 'parent.js')).href)})`,
          ],
          {...commandOptions, cwd: stage},
        );
      // A package reinstall while preparing must not activate obsolete app sources.
      if (fingerprint !== (await sourceFingerprint(this.installRoot)))
        throw new Error(
          'VarisDev app files changed during the update. Please retry.',
        );
      const pointer: ActiveRuntime = {
        generation,
        baseRoot: this.installRoot,
        fingerprint,
        version: release.version,
      };
      await writeFile(
        join(stage, 'runtime.json'),
        `${JSON.stringify(pointer, null, 2)}\n`,
      );
      pointerTemp = join(this.dataDir, `active-${randomUUID()}.tmp`);
      await writeFile(pointerTemp, `${JSON.stringify(pointer, null, 2)}\n`);
      await rename(pointerTemp, join(this.dataDir, 'active.json'));
      pointerTemp = undefined;
      stage = undefined; // Generations may still be used by a running app.
      return this.publish({
        phase: 'ready',
        currentVersion: release.version,
        restartRequired: true,
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
      error:
        `VarisDev runtime: ${error instanceof Error ? error.message : String(error)}`.replace(
          /(?<![\w./@:-])Pi(?![\w./-])/g,
          'VarisDev',
        ),
    });
  }

  private async registry(): Promise<string> {
    let registry = 'https://registry.npmjs.org/';
    for (const path of [
      process.env.npm_config_userconfig || join(homedir(), '.npmrc'),
      join(this.installRoot, '.npmrc'),
    ]) {
      try {
        const contents = await readFile(path, 'utf8');
        const entries = new Map(
          contents.split(/\r?\n/).flatMap(line => {
            const match =
              /^\s*(registry|@earendil-works:registry)\s*=\s*(\S+)\s*$/.exec(
                line,
              );
            return match ? [[match[1], match[2]] as [string, string]] : [];
          }),
        );
        registry =
          entries.get('@earendil-works:registry') ||
          entries.get('registry') ||
          registry;
      } catch {
        // Missing npm configuration uses the public registry.
      }
    }
    registry =
      this.options.registryUrl ||
      process.env.npm_config_registry ||
      process.env.NPM_CONFIG_REGISTRY ||
      registry;
    const url = new URL(registry);
    if (!['https:', 'http:'].includes(url.protocol))
      throw new Error(
        'The configured app runtime registry must use HTTP or HTTPS.',
      );
    return url.href.endsWith('/') ? url.href : `${url.href}/`;
  }

  private async latest(): Promise<RegistryRelease> {
    const controller = new AbortController();
    const timeoutMs = this.options.requestTimeoutMs ?? 15_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = async () => {
      const fetch = this.options.hooks?.fetch || globalThis.fetch;
      const response = await fetch(
        `${await this.registry()}${encodeURIComponent(enginePackage)}/latest`,
        {
          signal: controller.signal,
          headers: {accept: 'application/json'},
        },
      );
      if (!response.ok)
        throw new Error(
          `App runtime registry returned HTTP ${response.status}.`,
        );
      const release = (await response.json()) as RegistryRelease;
      if (!stableVersion(release.version))
        throw new Error(
          'The app runtime registry did not return a stable version.',
        );
      return release;
    };
    try {
      return await Promise.race([
        request(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('Checking the VarisDev runtime timed out.'));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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
          'Another VarisDev runtime update is still running. Please retry.',
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
