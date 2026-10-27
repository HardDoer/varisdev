/* global AbortSignal, Buffer, console, fetch, process, URL */
import {spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {homedir, userInfo} from 'node:os';
import {delimiter, dirname, join, resolve} from 'node:path';
import {setTimeout} from 'node:timers';
import {pathToFileURL} from 'node:url';

export const releaseURL = 'https://joonas.ninja/varisdev/latest.json';

/** @typedef {{version: string, revision: string, url: string, sha256: string}} Release */
/** @typedef {{transferredBytes: number, totalBytes?: number}} DownloadProgress */

/** @param {string} url */
function downloadURL(url) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' &&
    !(
      parsed.protocol === 'http:' &&
      ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname)
    )
  )
    throw new Error('VarisDev downloads require HTTPS.');
  if (parsed.username || parsed.password)
    throw new Error('Invalid download URL.');
  return parsed.href;
}

/**
 * @param {string} [url]
 * @param {number} [timeoutMs]
 * @returns {Promise<Release>}
 */
export async function readRelease(url = releaseURL, timeoutMs = 15000) {
  const response = await fetch(downloadURL(url), {
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
  if (!response.ok)
    throw new Error(`Could not fetch VarisDev release (${response.status}).`);
  const release = await response.json();
  if (
    !release ||
    typeof release.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(release.version) ||
    typeof release.revision !== 'string' ||
    !/^[a-f0-9]{40}$/.test(release.revision) ||
    typeof release.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(release.sha256) ||
    typeof release.url !== 'string'
  )
    throw new Error('Invalid VarisDev release manifest.');
  return {...release, url: downloadURL(new URL(release.url, url).href)};
}

/**
 * @param {Release} release
 * @param {string} destination
 * @param {number} [timeoutMs]
 * @param {(progress: DownloadProgress) => void} [onProgress]
 */
export async function downloadRelease(
  release,
  destination,
  timeoutMs = 120000,
  onProgress,
) {
  const response = await fetch(downloadURL(release.url), {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok)
    throw new Error(`Could not download VarisDev (${response.status}).`);
  if (!response.body) throw new Error('The VarisDev download is empty.');
  const length = Number(response.headers.get('content-length'));
  const encoding = response.headers.get('content-encoding');
  const totalBytes =
    (!encoding || encoding === 'identity') &&
    Number.isSafeInteger(length) &&
    length > 0
      ? length
      : undefined;
  const chunks = [];
  let transferredBytes = 0;
  let reportedAt = 0;
  onProgress?.({transferredBytes, totalBytes});
  for await (const chunk of response.body) {
    chunks.push(chunk);
    transferredBytes += chunk.length;
    const now = Date.now();
    if (now - reportedAt >= 100) {
      onProgress?.({transferredBytes, totalBytes});
      reportedAt = now;
    }
  }
  onProgress?.({transferredBytes, totalBytes});
  const contents = Buffer.concat(chunks, transferredBytes);
  if (createHash('sha256').update(contents).digest('hex') !== release.sha256)
    throw new Error(
      'VarisDev download checksum does not match the release manifest.',
    );
  await writeFile(destination, contents);
}

async function findNpm() {
  const candidates = [
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  ];
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    const executable = join(
      directory,
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
    );
    if (!existsSync(executable)) continue;
    const target = await realpath(executable);
    if (target.endsWith('npm-cli.js')) return target;
    candidates.push(join(dirname(target), 'node_modules/npm/bin/npm-cli.js'));
  }
  const npm = candidates.find(path => existsSync(path));
  if (!npm) throw new Error('VarisDev requires Node.js 24+ with npm.');
  return npm;
}

function run(args, cwd, env = process.env) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Installation command failed (${result.status}).`);
}

/**
 * @param {string} bin
 * @param {{home?: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform}} [options]
 * @returns {Promise<{activation?: string, skippedProfiles: string[]}>}
 */
export async function configurePath(
  bin,
  {home = homedir(), env = process.env, platform = process.platform} = {},
) {
  if (platform === 'win32') {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `
      $bin = $env:VARISDEV_BIN
      $current = [Environment]::GetEnvironmentVariable('Path', 'User')
      if (($current -split ';') -notcontains $bin) {
        [Environment]::SetEnvironmentVariable('Path', "$bin;$current", 'User')
      }
    `,
      ],
      {env: {...env, VARISDEV_BIN: bin}, stdio: 'inherit'},
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error('Could not add VarisDev to your user PATH.');
    return {skippedProfiles: []};
  }
  const shell = env.SHELL || userInfo().shell || '';
  const config = env.XDG_CONFIG_HOME || join(home, '.config');
  let profiles;
  let line = `export PATH='${bin.replaceAll("'", "'\\''")}':"$PATH"`;
  if (shell.endsWith('/fish')) {
    profiles = [join(config, 'fish/conf.d/varisdev.fish')];
    const quoted = bin.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
    line = `fish_add_path --path '${quoted}'`;
  } else if (shell.endsWith('/nu')) {
    const directory =
      !env.XDG_CONFIG_HOME && platform === 'darwin'
        ? join(home, 'Library/Application Support')
        : config;
    profiles = [join(directory, 'nushell/env.nu')];
    line = `$env.PATH = ($env.PATH | prepend ${JSON.stringify(bin)} | uniq)`;
  } else if (shell.endsWith('/zsh')) {
    const directory = env.ZDOTDIR || home;
    profiles = [join(directory, '.zshrc'), join(directory, '.zprofile')];
  } else if (shell.endsWith('/bash')) {
    // Bash reads only the first existing login file. Do not create a new
    // .bash_profile that would prevent an existing .profile from being read.
    const login =
      ['.bash_profile', '.bash_login', '.profile'].find(name =>
        existsSync(join(home, name)),
      ) || '.profile';
    profiles = [join(home, '.bashrc'), join(home, login)];
  } else {
    profiles = [join(home, '.profile')];
  }
  const skippedProfiles = [];
  for (const profile of profiles) {
    try {
      await mkdir(dirname(profile), {recursive: true});
      const current = existsSync(profile)
        ? await readFile(profile, 'utf8')
        : '';
      if (!current.split('\n').includes(line))
        await appendFile(profile, `\n# VarisDev\n${line}\n`);
    } catch (error) {
      if (!['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw error;
      skippedProfiles.push(profile);
    }
  }
  return {activation: line, skippedProfiles};
}

/** @param {NodeJS.ProcessEnv} [env] */
export function defaultDataDir(env = process.env) {
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

async function lockIsStale(lock, observedMtime) {
  try {
    const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
    if (!Number.isInteger(owner.pid) || owner.pid <= 0)
      throw new Error('Invalid owner');
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      return error.code === 'ESRCH';
    }
  } catch {
    // A new owner needs time to finish writing its metadata.
    return Date.now() - observedMtime > 30_000;
  }
}

/**
 * @param {string} dataDir
 * @param {{wait?: boolean, timeoutMs?: number}} [options]
 * @returns {Promise<(() => Promise<void>) | undefined>}
 */
export async function acquireUpdateLock(
  dataDir,
  {wait = true, timeoutMs = 15 * 60_000} = {},
) {
  await mkdir(dataDir, {recursive: true});
  const lock = join(dataDir, 'update.lock');
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
      if (error.code !== 'EEXIST') throw error;
      if (!wait) return;
    }
    if (Date.now() - started >= timeoutMs)
      throw new Error(
        'Another VarisDev update is still running. Please retry.',
      );
    try {
      const observed = await stat(lock);
      if (await lockIsStale(lock, observed.mtimeMs)) {
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
            (await lockIsStale(lock, observed.mtimeMs))
          ) {
            const abandoned = `${lock}-abandoned-${randomUUID()}`;
            await rename(lock, abandoned);
            await rm(abandoned, {recursive: true, force: true});
            elected = false;
          }
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          // A process can die after being elected for recovery as well.
          if (Date.now() - (await stat(recovery)).mtimeMs > 30_000)
            await rm(recovery, {recursive: true, force: true});
        } finally {
          if (elected) await rm(recovery, {recursive: true, force: true});
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise(fulfill => setTimeout(fulfill, 100));
  }
}

class InstallRollbackError extends Error {}

function packageRoot(prefix) {
  return join(
    prefix,
    process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
    'varisdev',
  );
}

function entrypoints(prefix) {
  return process.platform === 'win32'
    ? ['varisdev', 'varisdev.cmd', 'varisdev.ps1'].map(name =>
        join(prefix, name),
      )
    : [join(prefix, 'bin/varisdev')];
}

async function promotePackage(stage, prefix, temporary, activate) {
  const sources = [packageRoot(stage), ...entrypoints(stage)];
  const destinations = [packageRoot(prefix), ...entrypoints(prefix)];
  for (const source of sources) await lstat(source);
  const backup = join(temporary, 'previous');
  await mkdir(backup);
  const changes = [];
  try {
    for (const [index, destination] of destinations.entries()) {
      await mkdir(dirname(destination), {recursive: true});
      const previous = join(backup, String(index));
      const change = {destination, previous, saved: false, installed: false};
      try {
        await rename(destination, previous);
        change.saved = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      changes.push(change);
      await rename(sources[index], destination);
      change.installed = true;
    }
    await activate(packageRoot(prefix));
  } catch (error) {
    const failures = [];
    for (const change of changes.reverse()) {
      try {
        if (change.installed)
          await rm(change.destination, {
            recursive: true,
            force: true,
            maxRetries: 5,
          });
        if (change.saved) await rename(change.previous, change.destination);
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length)
      throw new InstallRollbackError(
        `Could not restore the previous installation. Recovery files remain in ${temporary}.`,
        {cause: new AggregateError([error, ...failures])},
      );
    throw error;
  }
}

export async function install(args = process.argv.slice(2)) {
  if (Number.parseInt(process.versions.node, 10) < 24)
    throw new Error('VarisDev requires Node 24+ with npm.');
  if (args.includes('--help')) {
    console.log(
      'Usage: node install.mjs [--prefix DIRECTORY] [--feed URL] [--no-path]',
    );
    return;
  }
  let prefix =
    process.env.VARISDEV_INSTALL_DIR || join(homedir(), '.local', 'varisdev');
  let feed = releaseURL;
  let addPath = true;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--no-path') {
      addPath = false;
      continue;
    }
    if (!args[index + 1]) throw new Error(`Missing value for ${args[index]}.`);
    if (args[index] === '--prefix') prefix = args[++index];
    else if (args[index] === '--feed') feed = args[++index];
    else throw new Error(`Unknown option: ${args[index]}`);
  }
  prefix = resolve(prefix);
  const npm = await findNpm();
  const release = await readRelease(feed);
  await mkdir(prefix, {recursive: true});
  const temporary = await mkdtemp(join(prefix, '.varisdev-install-'));
  let unlock;
  let retainRecovery = false;
  try {
    const archive = join(temporary, 'varisdev.tgz');
    console.log(
      `Installing VarisDev ${release.version} (${release.revision.slice(0, 8)}) into ${prefix}`,
    );
    await downloadRelease(release, archive);
    // Keep npm and preparation failures away from the installed package and shims.
    // npm 12 disables lifecycle scripts by default; prepare the verified archive explicitly.
    const stage = join(temporary, 'stage');
    run(
      [
        npm,
        'install',
        '--global=true',
        '--prefix',
        stage,
        '--omit=dev',
        '--legacy-peer-deps',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        archive,
      ],
      temporary,
    );
    const root = packageRoot(stage);
    // Use the downloaded app's settings reader so installer and desktop updates
    // honor the same saved data directory and machine environment fallback.
    const {initializeEnvironment, environmentForChild} = await import(
      pathToFileURL(join(root, 'src/runtime/environment.mjs')).href
    );
    await initializeEnvironment();
    unlock = await acquireUpdateLock(defaultDataDir());
    const env = environmentForChild();
    run([join(root, 'scripts/install-desktop.mjs')], root, env);
    const manifest = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    );
    const info = JSON.parse(
      await readFile(join(root, 'build-info.json'), 'utf8'),
    );
    if (
      manifest.name !== 'varisdev' ||
      manifest.version !== release.version ||
      info.revision !== release.revision
    )
      throw new Error(
        'Installed application does not match the release manifest.',
      );
    run([join(root, 'bin/varisdev.mjs'), '--version'], root, env);
    await promotePackage(stage, prefix, temporary, async installed => {
      if (process.platform === 'darwin' || process.platform === 'win32')
        run(
          [join(installed, 'scripts/desktop-app.mjs'), 'install'],
          installed,
          {
            ...env,
            VARISDEV_INSTALL_ROOT: await realpath(installed),
            VARISDEV_NODE_EXECUTABLE: process.execPath,
          },
        );
    });
    const bin = process.platform === 'win32' ? prefix : join(prefix, 'bin');
    if (addPath) {
      const {activation, skippedProfiles} = await configurePath(bin);
      if (skippedProfiles.length) {
        console.log('Installed. Shell PATH setup is incomplete.');
        for (const profile of skippedProfiles)
          console.warn(
            `VarisDev: Cannot update ${profile}: permission denied or read-only file.`,
          );
        console.log(
          `To use this terminal now, run:\n${activation}\nTo set PATH permanently, add that line to a writable shell startup file.`,
        );
      } else {
        console.log('Installed. Open a new terminal and run varisdev.');
        if (activation)
          console.log(`To use this terminal now, run:\n${activation}`);
      }
    } else console.log(`Installed. Add ${bin} to PATH, then run varisdev.`);
  } catch (error) {
    retainRecovery = error instanceof InstallRollbackError;
    throw error;
  } finally {
    try {
      if (!retainRecovery)
        await rm(temporary, {recursive: true, force: true, maxRetries: 5});
    } finally {
      await unlock?.();
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  install().catch(error => {
    console.error(`VarisDev: ${error.message || String(error)}`);
    process.exitCode = 1;
  });
}
