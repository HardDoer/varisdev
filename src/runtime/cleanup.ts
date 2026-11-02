import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import {isAbsolute, join, parse, posix, win32} from 'node:path';
import {fileURLToPath} from 'node:url';

export interface RuntimeProcess {
  pid: number;
  paths: string[];
  command: string;
  pathEncoding?: 'darwin-vis';
}

export const generationPattern =
  /^(?:runtime-\d+\.\d+\.\d+-[a-f0-9]+(?:-[a-f0-9]+)*|app-[a-f0-9]{16})$/;

function normalized(path: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? win32
        .resolve(path.replace(/^\\\\\?\\/, ''))
        .replaceAll('\\', '/')
        .toLowerCase()
        .replace(/\/+/g, '/')
    : posix.resolve(path);
}

// Darwin ps uses this bytewise representation under the inspector's C locale
// (VIS_TAB | VIS_NL | VIS_NOSLASH). Encode known paths instead of ambiguously
// decoding literal ASCII names such as M-CM-$ in process output.
function darwinVisiblePath(path: string): string {
  let visible = '';
  for (const byte of Buffer.from(path)) {
    if (byte >= 32 && byte <= 126) visible += String.fromCharCode(byte);
    else if (byte === 9 || byte === 10 || (byte & 127) === 32)
      visible += '\\' + byte.toString(8).padStart(3, '0');
    else {
      if (byte & 128) visible += 'M';
      const low = byte & 127;
      visible +=
        low < 32 || low === 127
          ? '^' + String.fromCharCode(low === 127 ? 63 : low + 64)
          : '-' + String.fromCharCode(low);
    }
  }
  return visible;
}

async function macPhysicalDirectories(displayed: string): Promise<string[]> {
  const {root} = parse(displayed);
  if (!root) throw new Error('Runtime launcher path is not absolute.');
  let candidates = [root];
  let entriesRead = 0;
  const deadline = Date.now() + 1000;
  for (const component of displayed
    .slice(root.length)
    .split('/')
    .filter(Boolean)) {
    if (component === '.' || component === '..' || Date.now() > deadline)
      throw new Error('Runtime launcher lookup unavailable.');
    const matches: string[] = [];
    for (const parent of candidates) {
      if (/M[-^]|\^[?@-_]|\\[0-7]{3}/.test(component)) {
        // VIS is ambiguous: a literal M-CM-$ directory and an ä directory both
        // print identically. Keep every physical match through every component.
        const entries = await readdir(parent, {withFileTypes: true});
        entriesRead += entries.length;
        if (entriesRead > 16_384 || Date.now() > deadline)
          throw new Error('Runtime launcher lookup limit exceeded.');
        for (const entry of entries) {
          if (
            (entry.isDirectory() || entry.isSymbolicLink()) &&
            darwinVisiblePath(entry.name) === component
          )
            matches.push(join(parent, entry.name));
        }
      } else {
        const path = join(parent, component);
        const info = await lstat(path);
        if (info.isDirectory() || info.isSymbolicLink()) matches.push(path);
      }
    }
    candidates = [...new Set(matches)];
    if (!candidates.length || candidates.length > 64 || Date.now() > deadline)
      throw new Error('Runtime launcher lookup unavailable.');
  }
  return candidates;
}

export function containsRuntimePath(
  value: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
  pathEncoding?: RuntimeProcess['pathEncoding'],
): boolean {
  const raw = normalized(root, platform).replace(/\/$/, '');
  const needles = [raw];
  if (pathEncoding === 'darwin-vis') {
    const encoded = darwinVisiblePath(raw);
    needles.push(
      platform === 'win32'
        ? encoded.replaceAll('\\', '/').toLowerCase()
        : encoded,
    );
  }
  const matches = (path: string): boolean => {
    const text =
      platform === 'win32'
        ? path
            .replaceAll('\\', '/')
            .replaceAll('//?/', '')
            .replace(/\/+/g, '/')
            .toLowerCase()
        : path;
    for (const needle of needles) {
      let offset = text.indexOf(needle);
      while (offset !== -1) {
        const before = text[offset - 1];
        const after = text[offset + needle.length];
        if (
          (!before || /[\s\0"'=:(]/.test(before)) &&
          (!after || /[/\s\0"';):]/.test(after))
        )
          return true;
        offset = text.indexOf(needle, offset + needle.length);
      }
    }
    return false;
  };
  if (matches(value)) return true;
  // Dynamic import expressions commonly contain file URLs. Decode only those
  // URLs; other encoded command arguments are not path evidence.
  for (const match of value.matchAll(/file:\/\/[^\s\0"`<>]*/gi)) {
    try {
      if (matches(fileURLToPath(match[0], {windows: platform === 'win32'})))
        return true;
    } catch {
      /* Invalid file URLs provide no path evidence. */
    }
  }
  return false;
}

/** Inspection commands are read only and bounded, including their descendants. */
async function inspect(command: string, args: string[]): Promise<string> {
  return new Promise((fulfill, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        LC_ALL: 'C',
        ...(process.versions.electron ? {ELECTRON_RUN_AS_NODE: '1'} : {}),
      },
    });
    let output = '';
    let failed = false;
    const stop = () => {
      if (failed) return;
      failed = true;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn(
          join(
            process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows',
            'System32/taskkill.exe',
          ),
          ['/pid', String(child.pid), '/T', '/F'],
          {stdio: 'ignore', windowsHide: true, timeout: 3000},
        );
        killer.on('error', () => child.kill('SIGKILL'));
        killer.on('close', code => {
          if (code !== 0) child.kill('SIGKILL');
        });
      } else {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    };
    const timer = setTimeout(stop, 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (failed) return;
      output += chunk;
      if (output.length > 8 * 1024 * 1024) stop();
    });
    child.stderr.resume();
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0)
        reject(new Error('Runtime process inspection unavailable.'));
      else fulfill(output);
    });
  });
}

export function macRuntimeProcesses(
  executables: string,
  commands: string,
): RuntimeProcess[] {
  const parse = (output: string): Array<{pid: number; value: string}> =>
    output
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (!match || !match[2].trim())
          throw new Error('Invalid process inspection.');
        return {pid: Number(match[1]), value: match[2].trim()};
      });
  const paths = new Map(parse(executables).map(row => [row.pid, row.value]));
  // The first ps process has exited by the second snapshot. Retain surviving
  // processes and newly observed command lines, rather than requiring it to live.
  const fallback = (value: string): boolean =>
    value.startsWith('(') && value.endsWith(')');
  const host = (value: string): boolean => {
    const name = (fallback(value) ? value.slice(1, -1) : value)
      .split('/')
      .at(-1);
    return /^(?:node(?:js)?|electron|varisdev|npm)(?:\.exe)?$/i.test(
      name || '',
    );
  };
  return parse(commands).map<RuntimeProcess>(({pid, value}) => {
    const executable = paths.get(pid);
    // A zombie no longer holds a runtime, even when comm was read before exit.
    if (value === '<defunct>')
      return {pid, paths: [], command: value, pathEncoding: 'darwin-vis'};
    if (
      pid !== process.pid &&
      (fallback(value) || (executable && fallback(executable))) &&
      (host(value) || (executable && host(executable)))
    )
      throw new Error('Runtime process arguments unavailable.');
    return {
      pid,
      paths: executable ? [executable] : [],
      command: value,
      pathEncoding: 'darwin-vis',
    };
  });
}

export async function runtimeProcesses(): Promise<RuntimeProcess[]> {
  let rows: RuntimeProcess[];
  if (process.platform === 'linux') {
    rows = JSON.parse(
      await inspect(process.env.VARISDEV_NODE_EXECUTABLE || process.execPath, [
        fileURLToPath(new URL('./process-probe.mjs', import.meta.url)),
      ]),
    );
  } else if (process.platform === 'win32') {
    const shell = join(
      process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    );
    const script = `
      $ErrorActionPreference = 'Stop'
      [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
      $rows = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -gt 4 } | ForEach-Object {
        if (!$_.CommandLine -or !$_.ExecutablePath) {
          if ($_.Name -match '^(node(?:js)?|electron|varisdev|npm)(?:[.-]|$)') { throw 'Inaccessible runtime process' }
          return
        }
        @{pid=[int]$_.ProcessId; paths=@($_.ExecutablePath); command=$_.CommandLine}
      })
      ConvertTo-Json -InputObject $rows -Compress -Depth 4
    `;
    rows = JSON.parse(
      (
        await inspect(shell, [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ])
      ).replace(/^\uFEFF/, ''),
    );
  } else if (process.platform === 'darwin') {
    const output = await inspect('/bin/ps', ['-Aww', '-o', 'pid=,comm=']);
    const commands = await inspect('/bin/ps', ['-Aww', '-o', 'pid=,args=']);
    rows = macRuntimeProcesses(output, commands);
  } else throw new Error('Runtime process inspection unsupported.');
  if (
    !Array.isArray(rows) ||
    !rows.length ||
    rows.some(
      row =>
        !Number.isInteger(row.pid) ||
        !Array.isArray(row.paths) ||
        row.paths.some(path => typeof path !== 'string') ||
        typeof row.command !== 'string',
    )
  )
    throw new Error('Invalid process inspection.');
  return rows;
}

/** A CLI may have loaded its generation before its launcher path changed. */
function runtimeBootstrap(row: RuntimeProcess): boolean {
  const name = (path: string): string =>
    path
      .replaceAll('\\', '/')
      .replace(/^[a-z]:/i, '')
      .split('/')
      .at(-1) || '';
  const first = /^\s*(?:"([^"]+)"|'([^']+)'|([^\s\0]+))/.exec(row.command);
  const executable =
    row.paths[0] || first?.[1] || first?.[2] || first?.[3] || '';
  const incompleteDarwin =
    !row.paths.length &&
    (process.platform === 'darwin' || row.pathEncoding === 'darwin-vis');
  // A full snapshot identifies helper roles. A command-only ps row may omit
  // quoting around its executable path, so its first token cannot rule out a CLI.
  if (
    !incompleteDarwin &&
    !/^(?:node(?:js)?|electron|varisdev)(?:\.exe)?$/i.test(name(executable))
  )
    return false;
  if (row.command.includes('\0'))
    return row.command
      .split('\0')
      .slice(1)
      .some(argument => /^varisdev(?:\.mjs)?$/i.test(name(argument)));
  let command = row.command;
  if (!incompleteDarwin) {
    for (const prefix of [executable, `"${executable}"`, `'${executable}'`]) {
      if (command === prefix || command.startsWith(prefix + ' ')) {
        command = command.slice(prefix.length).trimStart();
        break;
      }
    }
  }
  const entries =
    /(?:^|\s)(?:"([^"]*varisdev(?:\.mjs)?)"|'([^']*varisdev(?:\.mjs)?)'|([^\s"']*varisdev(?:\.mjs)?))(?=$|\s)/gi;
  for (const match of command.matchAll(entries)) {
    const argument = match[1] || match[2] || match[3];
    if (!/^varisdev(?:\.mjs)?$/i.test(name(argument))) continue;
    return true;
  }
  return false;
}

function macMainLauncher(row: RuntimeProcess): boolean {
  if (process.platform !== 'darwin' && row.pathEncoding !== 'darwin-vis')
    return false;
  // The shipped main identity survives removal or replacement of launch.json.
  return row.paths.some(value =>
    /\.app\/Contents\/MacOS\/VarisDev$/i.test(
      process.platform === 'win32' ? value.replaceAll('\\', '/') : value,
    ),
  );
}

interface CleanupOptions {
  installRoot: string;
  dataDir: string;
  runningRoot?: string;
  protectedRoots?: string[];
  processes?: () => Promise<RuntimeProcess[]>;
}

async function plainDirectory(path: string): Promise<boolean> {
  const info = await lstat(path);
  return info.isDirectory() && !info.isSymbolicLink();
}

async function legacyPlatform(
  root: string,
  generation: string,
  installRoot: string,
): Promise<NodeJS.Platform | undefined> {
  const physical = async (relative: string, base = root): Promise<boolean> => {
    let path = base;
    try {
      for (const part of relative.split('/')) {
        path = join(path, part);
        if ((await lstat(path)).isSymbolicLink()) return false;
      }
      return true;
    } catch {
      return false;
    }
  };
  if (
    generation.startsWith('app-') &&
    (await physical('node_modules/varisdev'))
  )
    return 'win32';
  const prefix = generation.startsWith('app-')
    ? 'lib/node_modules/varisdev/'
    : '';
  const locations = [
    {base: root, prefix: `${prefix}node_modules/electron/dist/`},
    {base: root, prefix: `${prefix}desktop/node_modules/electron/dist/`},
  ];
  if (generation.startsWith('runtime-')) {
    // The original updater linked root dependencies to the base installation.
    // Inspect only that exact trusted target; removal still unlinks the link.
    try {
      const linked = join(root, 'node_modules');
      const expected = join(installRoot, 'node_modules');
      if (
        (await lstat(linked)).isSymbolicLink() &&
        (await physical('node_modules', installRoot)) &&
        normalized(await realpath(linked), process.platform) ===
          normalized(await realpath(expected), process.platform)
      )
        locations.push({
          base: installRoot,
          prefix: 'node_modules/electron/dist/',
        });
    } catch {
      /* Unknown or broken dependency links are left alone. */
    }
  }
  for (const location of locations) {
    if (await physical(`${location.prefix}electron.exe`, location.base))
      return 'win32';
    if (
      await physical(
        `${location.prefix}Electron.app/Contents/MacOS/Electron`,
        location.base,
      )
    )
      return 'darwin';
    if (await physical(`${location.prefix}electron`, location.base))
      return 'linux';
  }
  return undefined;
}

/** Keep ownership until locked contents can be removed on a later attempt. */
export async function removeRuntimeGeneration(root: string): Promise<void> {
  if (!(await plainDirectory(root))) return;
  for (const entry of await readdir(root)) {
    if (entry !== 'runtime.json')
      await rm(join(root, entry), {recursive: true, force: true});
  }
  await rm(join(root, 'runtime.json'), {force: true});
  await rmdir(root);
}

/** Caller holds update.lock, shared with older updaters. Failures leave files for a later run. */
export async function cleanupRuntimeGenerations(
  options: CleanupOptions,
): Promise<void> {
  try {
    const {installRoot, dataDir} = options;
    const directory = join(dataDir, 'runtimes');
    if (
      !(await plainDirectory(dataDir)) ||
      !(await plainDirectory(directory)) ||
      normalized(await realpath(directory), process.platform) !==
        normalized(directory, process.platform)
    )
      return;
    const protectedPaths = [
      installRoot,
      options.runningRoot || installRoot,
      ...(options.protectedRoots || []),
      process.execPath,
      ...process.argv,
      process.cwd(),
    ];
    // Also protect callers whose installation path traverses a symlink.
    for (const path of [installRoot, options.runningRoot]) {
      if (path) {
        try {
          protectedPaths.push(await realpath(path));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
    let active: string | undefined;
    try {
      const pointer = JSON.parse(
        await readFile(join(dataDir, 'active.json'), 'utf8'),
      );
      if (
        !pointer ||
        typeof pointer.generation !== 'string' ||
        !generationPattern.test(pointer.generation)
      )
        return;
      active = pointer.generation;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
    }
    const candidates: Array<{
      root: string;
      owner: Record<string, unknown>;
      inferredPlatform?: NodeJS.Platform;
    }> = [];
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      if (
        !generationPattern.test(entry.name) ||
        entry.name === active ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      )
        continue;
      const root = join(directory, entry.name);
      try {
        if (!(await plainDirectory(root))) continue;
        const metadata = join(root, 'runtime.json');
        const info = await lstat(metadata);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384)
          continue;
        const owner = JSON.parse(await readFile(metadata, 'utf8'));
        try {
          await lstat(join(root, 'recovery.json'));
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
        }
        if (
          !owner ||
          owner.generation !== entry.name ||
          typeof owner.baseRoot !== 'string' ||
          !isAbsolute(owner.baseRoot) ||
          normalized(owner.baseRoot, process.platform) !==
            normalized(installRoot, process.platform) ||
          typeof owner.fingerprint !== 'string' ||
          !/^[a-f0-9]{64}$/.test(owner.fingerprint) ||
          typeof owner.version !== 'string' ||
          !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(owner.version) ||
          (owner.revision !== undefined &&
            (typeof owner.revision !== 'string' ||
              !/^[a-f0-9]{40}$/.test(owner.revision)))
        )
          continue;
        const platform =
          owner.platform ??
          (await legacyPlatform(root, entry.name, installRoot));
        if (platform !== process.platform) continue;
        if (!protectedPaths.some(path => containsRuntimePath(path, root)))
          candidates.push({
            root,
            owner,
            inferredPlatform:
              owner.platform === platform ? undefined : platform,
          });
      } catch {
        /* Unknown or unreadable ownership is never a deletion candidate. */
      }
    }
    if (!candidates.length) return;
    const processes = await (options.processes || runtimeProcesses)();
    if (
      !Array.isArray(processes) ||
      !processes.length ||
      processes.some(
        row =>
          !Number.isInteger(row.pid) ||
          row.pid <= 0 ||
          !Array.isArray(row.paths) ||
          row.paths.some(path => typeof path !== 'string') ||
          typeof row.command !== 'string',
      )
    )
      return;
    for (const row of processes) {
      if (row.pid === process.pid) continue;
      if (runtimeBootstrap(row) || macMainLauncher(row)) return;
      const evidence = [...row.paths, row.command];
      const refers = (value: string, root: string): boolean =>
        containsRuntimePath(value, root, process.platform, row.pathEncoding);
      // Old bootstraps load JS dynamically; unrelated runtime arguments do not
      // identify which generation they imported. Keep every possibility alive.
      if (
        evidence.some(value =>
          refers(value, join(installRoot, 'bin/varisdev.mjs')),
        ) ||
        (evidence.some(value => refers(value, installRoot)) &&
          !evidence.some(value => refers(value, directory)))
      )
        return;
      for (const path of row.paths) {
        const displayed =
          row.pathEncoding === 'darwin-vis' && process.platform !== 'win32'
            ? path
            : path.replaceAll('\\', '/');
        const match = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(displayed);
        if (!match) continue;
        const bundles =
          row.pathEncoding === 'darwin-vis'
            ? await macPhysicalDirectories(match[1])
            : [match[1]];
        for (const bundle of bundles) {
          const config = JSON.parse(
            await readFile(
              join(bundle, 'Contents/Resources/app/launch.json'),
              'utf8',
            ).catch(error => {
              // Electron helper bundles normally have no launcher config.
              if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return '{}';
              throw error;
            }),
          );
          // The config may have been rewritten since this process loaded JS.
          if (
            typeof config.installRoot === 'string' ||
            typeof config.runtimeRoot === 'string'
          )
            return;
        }
      }
      for (const {root} of candidates) {
        if (evidence.some(value => refers(value, root)))
          protectedPaths.push(root);
      }
      protectedPaths.push(...evidence);
    }
    for (const {root, owner, inferredPlatform} of candidates) {
      if (protectedPaths.some(path => containsRuntimePath(path, root)))
        continue;
      try {
        if (!(await plainDirectory(root))) continue;
        if (inferredPlatform) {
          const temporary = join(root, `.runtime-${randomUUID()}.tmp`);
          try {
            // Retain the platform proof before removing the files that supplied
            // it. A partial deletion must remain eligible on its next attempt.
            await writeFile(
              temporary,
              JSON.stringify({...owner, platform: inferredPlatform}) + '\n',
              {flag: 'wx', mode: 0o600},
            );
            await rename(temporary, join(root, 'runtime.json'));
          } finally {
            await rm(temporary, {force: true}).catch(() => {});
          }
        }
        await removeRuntimeGeneration(root);
      } catch {
        /* Locked files and permission errors are retried at next cleanup. */
      }
    }
  } catch {
    /* Cleanup must never prevent launching or activation. */
  }
}
