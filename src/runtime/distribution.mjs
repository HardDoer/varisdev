/* global AbortSignal, Buffer, console, fetch, process, URL */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {homedir, userInfo} from 'node:os';
import {delimiter, dirname, join, resolve} from 'node:path';
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

export async function install(args = process.argv.slice(2)) {
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
  if (Number.parseInt(process.versions.node, 10) < 24)
    throw new Error('VarisDev requires Node.js 24+ with npm.');
  prefix = resolve(prefix);
  const npm = await findNpm();
  const release = await readRelease(feed);
  await mkdir(prefix, {recursive: true});
  const temporary = await mkdtemp(join(prefix, '.varisdev-install-'));
  try {
    const archive = join(temporary, 'varisdev.tgz');
    console.log(
      `Installing VarisDev ${release.version} (${release.revision.slice(0, 8)}) into ${prefix}`,
    );
    await downloadRelease(release, archive);
    // npm 12 disables Git and lifecycle scripts by default. Install a verified
    // local archive, then explicitly prepare the app with its bundled npm.
    run(
      [
        npm,
        'install',
        '--global=true',
        '--prefix',
        prefix,
        '--omit=dev',
        '--legacy-peer-deps',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        archive,
      ],
      temporary,
    );
    const root = join(
      prefix,
      process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
      'varisdev',
    );
    run([join(root, 'scripts/install-desktop.mjs')], root);
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
    run([join(root, 'bin/varisdev.mjs'), '--version'], root);
    if (process.platform === 'darwin' || process.platform === 'win32')
      run([join(root, 'scripts/desktop-app.mjs'), 'install'], root, {
        ...process.env,
        VARISDEV_INSTALL_ROOT: await realpath(root),
        VARISDEV_NODE_EXECUTABLE: process.execPath,
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
  } finally {
    await rm(temporary, {recursive: true, force: true, maxRetries: 5});
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
