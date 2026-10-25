import {spawn, type ChildProcess} from 'node:child_process';
import {createRequire} from 'node:module';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';
import {stat} from 'node:fs/promises';
import {delimiter, dirname, join, resolve} from 'node:path';
import {defaultDataDir, RuntimeManager} from './manager.ts';
import {macLauncherExecutable} from './mac-launcher.ts';
import {runAccountCommand, runPluginCommand} from './commands.ts';
import {configureSettings} from './settings.mjs';
import {
  copyEnvironment,
  environmentForChild,
  initializeEnvironment,
} from './environment.mjs';

const help = `VarisDev

Usage: varisdev [folder | --overview] [--ozone-platform=x11|wayland]

  --overview            Open the project overview
  --ozone-platform=x11|wayland
                        Select the Linux display backend
  update                Install available updates
  update --check        Check for updates
  login [provider]      Connect a model account
  login <provider> --api-key
                        Save an API key
  logout <provider>     Disconnect a model account
  install <source>      Install a plugin (--local for this project)
  remove <source>       Remove a plugin (--local for this project)
  list                  List installed plugins
  plugins update [source]
                        Update plugins
  mcp <command>         Configure and inspect MCP servers
  app install           Install the Windows or macOS app launcher
  run [options]         Run a prompt or automation from the terminal
  --version             Show the VarisDev version
  --help                Show this help
`;

function childDone(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
}

/** Keep Pi's management command first instead of treating it as a prompt. */
export function mcpCliArguments(args: string[]): string[] | undefined {
  if (args[0] === 'mcp') return args;
  if (args[0] === 'run' && args[1] === 'mcp') return args.slice(1);
  return undefined;
}

function runBundledPiCli(
  runtimeRoot: string,
  installRoot: string,
  args: string[],
): Promise<number> {
  return childDone(
    spawn(
      process.execPath,
      [
        join(
          runtimeRoot,
          'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
        ),
        ...args,
      ],
      {
        stdio: 'inherit',
        env: launchEnvironment(installRoot, runtimeRoot, false),
      },
    ),
  );
}

function launchEnvironment(
  installRoot: string,
  runtimeRoot = installRoot,
  continuation = true,
): NodeJS.ProcessEnv {
  const nodeExecutable =
    process.env.VARISDEV_NODE_EXECUTABLE ||
    (!process.versions.electron ? process.execPath : undefined);
  const inherited = continuation ? environmentForChild() : copyEnvironment();
  return {
    ...configureSettings(inherited),
    VARISDEV_INSTALL_ROOT: installRoot,
    ...(nodeExecutable ? {VARISDEV_NODE_EXECUTABLE: nodeExecutable} : {}),
    PATH: [
      dirname(process.env.VARISDEV_NODE_EXECUTABLE || process.execPath),
      join(runtimeRoot, 'node_modules/.bin'),
      inherited.PATH,
    ]
      .filter(Boolean)
      .join(delimiter),
  };
}

/** Electron exposes an API object inside its own process. Read its installed path there. */
export function electronExecutable(require: NodeJS.Require): string {
  const electron: unknown = require('electron');
  if (typeof electron === 'string') return electron;
  const directory = dirname(require.resolve('electron/package.json'));
  return join(
    directory,
    'dist',
    readFileSync(join(directory, 'path.txt'), 'utf8').trim(),
  );
}

/** Let the previous desktop finish closing before opening its profile again. */
export async function waitForPreviousDesktop(): Promise<void> {
  const value = process.env.VARISDEV_RESTART_PID;
  delete process.env.VARISDEV_RESTART_PID;
  if (!value) return;
  const pid = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    pid === process.pid
  )
    throw new Error('The restart process is invalid. Open VarisDev again.');
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
    if (Date.now() >= deadline)
      throw new Error(
        'The previous VarisDev window is still closing. Try opening it again.',
      );
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export type OzonePlatform = 'x11' | 'wayland';

export function parseDesktopArguments(
  args: string[],
  platform: NodeJS.Platform = process.platform,
): {project: string | undefined; ozonePlatform?: OzonePlatform} {
  let target: string | undefined;
  let ozonePlatform: OzonePlatform | undefined;
  for (const arg of args) {
    if (arg === '--ozone-platform' || arg.startsWith('--ozone-platform=')) {
      if (ozonePlatform) throw new Error('Specify --ozone-platform only once.');
      const value = arg.slice('--ozone-platform='.length);
      if (value !== 'x11' && value !== 'wayland')
        throw new Error(
          'Use --ozone-platform=x11 or --ozone-platform=wayland.',
        );
      if (platform !== 'linux')
        throw new Error('--ozone-platform is only supported on Linux.');
      ozonePlatform = value;
    } else {
      if (target !== undefined || (arg.startsWith('-') && arg !== '--overview'))
        throw new Error(
          'Usage: varisdev [folder | --overview] [--ozone-platform=x11|wayland]. Run varisdev --help for commands.',
        );
      target = arg;
    }
  }
  return {
    project:
      target === '--overview' ? undefined : resolve(target ?? process.cwd()),
    ozonePlatform,
  };
}

/** Launch a detached desktop and wait until its window and session are ready. */
export async function openDesktop(
  installRoot: string,
  runtimeRoot: string,
  project?: string,
  ozonePlatform?: OzonePlatform,
): Promise<void> {
  await waitForPreviousDesktop();
  const dataDir = defaultDataDir();
  const profile =
    process.env.PIDEV_DESKTOP_DATA_DIR ?? join(dataDir, 'desktop');
  mkdirSync(profile, {recursive: true});
  const env = launchEnvironment(installRoot, runtimeRoot);
  delete env.ELECTRON_RUN_AS_NODE;
  const launcher =
    process.platform === 'darwin'
      ? await macLauncherExecutable(installRoot, runtimeRoot, env)
      : undefined;
  const logPath = join(profile, 'startup.log');
  const log = openSync(logPath, 'a');
  const logStart = fstatSync(log).size;
  const require = createRequire(join(runtimeRoot, 'package.json'));
  let child: ChildProcess;
  try {
    child = spawn(
      launcher || electronExecutable(require),
      [
        ...(launcher
          ? []
          : [join(runtimeRoot, 'desktop/build/src/desktop/main.js')]),
        ...(ozonePlatform ? [`--ozone-platform=${ozonePlatform}`] : []),
        '--varisdev-launcher',
        ...(project ? [`--varisdev-project=${project}`] : []),
      ],
      {
        cwd: project ?? process.cwd(),
        detached: true,
        stdio: ['ignore', log, log, 'ipc'],
        env,
      },
    );
  } finally {
    closeSync(log);
  }
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(
      () =>
        finish(new Error('The app did not finish starting within 60 seconds.')),
      60_000,
    );
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off('error', finish);
      child.off('exit', exited);
      child.off('message', message);
      if (error) {
        child.kill();
        let details = '';
        try {
          const file = openSync(logPath, 'r');
          try {
            const size = fstatSync(file).size;
            const start = Math.max(logStart, size - 8000);
            const buffer = Buffer.alloc(Math.max(0, size - start));
            const length = readSync(file, buffer, 0, buffer.length, start);
            details = buffer.subarray(0, length).toString('utf8').trim();
          } finally {
            closeSync(file);
          }
        } catch {
          // Keep the original startup error if its log cannot be read.
        }
        const sandbox = /SUID sandbox helper|No usable sandbox/i.test(details)
          ? `\nLinux sandbox setup: ${join(runtimeRoot, 'docs/installation.md')}#linux-sandbox`
          : '';
        reject(
          new Error(
            `${error.message}${details ? `\n${details}` : ''}${sandbox}\nDetails: ${logPath}`,
          ),
        );
      } else {
        if (child.connected) child.disconnect();
        child.unref();
        resolve();
      }
    };
    const exited = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(
        new Error(
          `The app closed during startup (${code ?? signal ?? 'unknown'}).`,
        ),
      );
    const message = (value: unknown) => {
      if (!value || typeof value !== 'object' || !('type' in value)) return;
      if (value.type === 'ready') finish();
      else if (value.type === 'startup-error')
        finish(
          new Error(
            'error' in value ? String(value.error) : 'The app could not start.',
          ),
        );
    };
    child.once('error', finish);
    child.once('exit', exited);
    child.on('message', message);
  });
}

export async function runCli(
  args: string[],
  installRoot: string,
): Promise<number> {
  await initializeEnvironment();
  configureSettings();
  const [command, ...rest] = args;
  const manager = new RuntimeManager({installRoot});
  await manager.refreshEnvironment();
  const runtimeRoot = await manager.currentRoot();
  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(help);
    return 0;
  }
  if (command === '--version' || command === '-v') {
    const manifest = JSON.parse(
      readFileSync(join(runtimeRoot, 'package.json'), 'utf8'),
    ) as {version: string};
    console.log(`VarisDev ${manifest.version}`);
    return 0;
  }
  const mcpArgs = mcpCliArguments(args);
  if (mcpArgs) return runBundledPiCli(runtimeRoot, installRoot, mcpArgs);
  if (command === 'update') {
    if (rest.length > 1 || (rest.length === 1 && rest[0] !== '--check'))
      throw new Error('Usage: varisdev update [--check]');
    const checking = rest[0] === '--check';
    console.log(checking ? 'Checking for updates…' : 'Updating VarisDev…');
    const status = await (checking ? manager.check() : manager.update());
    if (status.error) throw new Error(status.error);
    console.log(
      status.restartRequired
        ? 'Update installed. Restart VarisDev to finish.'
        : status.phase === 'available'
          ? 'Updates available. Run varisdev update or use the Updates menu.'
          : 'VarisDev is up to date.',
    );
    return 0;
  }
  if (command === 'login' || command === 'logout') {
    await runAccountCommand(runtimeRoot, command, rest);
    return 0;
  }
  if (command === 'install' || command === 'remove' || command === 'list') {
    await runPluginCommand(runtimeRoot, command, rest);
    return 0;
  }
  if (command === 'plugins') {
    if (rest[0] !== 'update')
      throw new Error('Usage: varisdev plugins update [source]');
    await runPluginCommand(runtimeRoot, 'update', rest.slice(1));
    return 0;
  }
  if (command === 'app') {
    if (rest.length !== 1 || rest[0] !== 'install')
      throw new Error('Usage: varisdev app install');
    return childDone(
      spawn(
        process.execPath,
        [join(runtimeRoot, 'scripts/desktop-app.mjs'), 'install'],
        {
          stdio: 'inherit',
          env: launchEnvironment(installRoot, runtimeRoot),
        },
      ),
    );
  }
  if (command === 'run') {
    const mode =
      rest.includes('--mode') || rest.some(arg => arg.startsWith('--mode='));
    return childDone(
      spawn(
        process.execPath,
        [
          join(runtimeRoot, 'desktop/build/src/runtime/headless.js'),
          ...(mode || rest.includes('--print') || rest.includes('-p')
            ? []
            : ['--print']),
          '--extension',
          join(runtimeRoot, 'extensions/varisdev.ts'),
          ...rest,
        ],
        {stdio: 'inherit', env: launchEnvironment(installRoot, runtimeRoot)},
      ),
    );
  }
  const {project, ozonePlatform} = parseDesktopArguments(args);
  if (project && !(await stat(project)).isDirectory())
    throw new Error(`Choose a project folder: ${project}`);
  await openDesktop(installRoot, runtimeRoot, project, ozonePlatform);
  return 0;
}
