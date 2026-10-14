import {execFile} from 'node:child_process';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {Writable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import type {
  AuthInteraction,
  AuthPrompt,
  AuthType,
  Provider,
} from '@earendil-works/pi-ai';
import type {
  CreateModelRuntimeOptions,
  PackageManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

type AccountProvider = Pick<Provider, 'id' | 'name' | 'auth'>;
type CommandSettings = Pick<
  SettingsManager,
  'flush' | 'drainErrors' | 'getNpmCommand' | 'applyOverrides'
>;

export interface CommandSDK {
  getAgentDir(): string;
  ModelRuntime: {
    create(options: CreateModelRuntimeOptions): Promise<{
      getProviders(): readonly AccountProvider[];
      login(
        provider: string,
        type: AuthType,
        interaction: AuthInteraction,
      ): Promise<unknown>;
      logout(provider: string, options: {signal: AbortSignal}): Promise<void>;
    }>;
  };
  SettingsManager: {
    create(
      cwd: string,
      agentDir: string,
      options: {projectTrusted: boolean},
    ): CommandSettings;
  };
  DefaultPackageManager: new (options: {
    cwd: string;
    agentDir: string;
    settingsManager: CommandSettings;
  }) => Pick<
    PackageManager,
    | 'installAndPersist'
    | 'removeAndPersist'
    | 'listConfiguredPackages'
    | 'update'
    | 'setProgressCallback'
  >;
}

export interface CommandDependencies {
  loadSDK?: (root: string) => Promise<CommandSDK>;
  write?: (message: string) => void;
  prompt?: (prompt: AuthPrompt, signal: AbortSignal) => Promise<string>;
  openBrowser?: (url: string) => Promise<void>;
  signal?: AbortSignal;
}

async function loadSDK(root: string): Promise<CommandSDK> {
  const url = pathToFileURL(
    join(
      root,
      'desktop/node_modules/@earendil-works/pi-coding-agent/dist/index.js',
    ),
  );
  return (await import(url.href)) as CommandSDK;
}

function brand(message: string): string {
  return message.replace(/(?<![\w./\\@:-])pi(?![\w./\\-])/gi, 'VarisDev');
}

export class CommandCancelledError extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'CommandCancelledError';
  }
}

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CommandCancelledError();
}

async function openBrowser(url: string): Promise<void> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) return;
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  await new Promise<void>((resolve, reject) => {
    execFile(command, args, error => (error ? reject(error) : resolve()));
  });
}

/** Keep typed secrets out of the terminal's readline echo. */
function terminalPrompts(controller: AbortController) {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!muted) process.stdout.write(chunk, encoding);
      done();
    },
  });
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = createInterface({input: process.stdin, output, terminal});
  const queued: string[] = [];
  let inputClosed = false;
  let pending: ((value: string) => void) | undefined;
  rl.on('line', line => {
    if (pending) {
      const resolve = pending;
      pending = undefined;
      resolve(line);
    } else queued.push(line);
  });
  rl.on('SIGINT', () => controller.abort());
  rl.on('close', () => {
    inputClosed = true;
    if (pending) controller.abort();
  });

  return {
    async prompt(prompt: AuthPrompt, signal: AbortSignal): Promise<string> {
      checkCancelled(signal);
      const secret = prompt.type === 'secret' || prompt.type === 'manual_code';
      muted = false;
      rl.setPrompt(`${prompt.message}: `);
      rl.prompt();
      muted = secret;
      try {
        if (queued.length) return queued.shift()!;
        if (inputClosed) throw new CommandCancelledError();
        return await new Promise<string>((resolve, reject) => {
          const abort = () => reject(new CommandCancelledError());
          const finish = (value: string) => {
            signal.removeEventListener('abort', abort);
            resolve(value);
          };
          pending = finish;
          signal.addEventListener('abort', abort, {once: true});
          if (signal.aborted) abort();
        });
      } finally {
        pending = undefined;
        muted = false;
        if (secret && terminal) process.stdout.write('\n');
      }
    },
    close() {
      muted = false;
      rl.close();
      output.end();
    },
  };
}

/** Account commands use the same auth.json and provider flows as the bundled SDK. */
export async function runAccountCommand(
  root: string,
  command: 'login' | 'logout',
  args: string[],
  dependencies: CommandDependencies = {},
): Promise<void> {
  const apiKey = args.includes('--api-key');
  const positional = args.filter(arg => arg !== '--api-key');
  if (
    positional.length > 1 ||
    positional.some(arg => arg.startsWith('-')) ||
    args.filter(arg => arg === '--api-key').length > 1 ||
    (command === 'logout' && (apiKey || positional.length !== 1))
  ) {
    throw new Error(
      command === 'login'
        ? 'Usage: varisdev login [provider] [--api-key]'
        : 'Usage: varisdev logout <provider>',
    );
  }

  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  dependencies.signal?.addEventListener('abort', cancel, {once: true});
  if (dependencies.signal?.aborted) cancel();
  let terminal: ReturnType<typeof terminalPrompts> | undefined;
  const secrets = new Set<string>();
  const sanitize = (message: string) => {
    for (const secret of secrets)
      message = message.split(secret).join('[redacted]');
    return brand(message);
  };
  const write = (message: string) =>
    (dependencies.write ?? (text => process.stdout.write(`${text}\n`)))(
      sanitize(message),
    );

  const prompt = async (request: AuthPrompt): Promise<string> => {
    const signal = request.signal
      ? AbortSignal.any([controller.signal, request.signal])
      : controller.signal;
    checkCancelled(signal);
    if (request.type === 'select') {
      request.options.forEach((option, index) =>
        write(`${index + 1}. ${option.label} (${option.id})`),
      );
    }
    const safeRequest = {...request, message: sanitize(request.message)};
    const value = await (dependencies.prompt
      ? dependencies.prompt(safeRequest, signal)
      : (terminal ??= terminalPrompts(controller)).prompt(safeRequest, signal));
    checkCancelled(signal);
    if (request.type === 'secret' || request.type === 'manual_code') {
      if (value) secrets.add(value);
    }
    if (request.type === 'select') {
      const selected =
        request.options.find(option => option.id === value) ??
        request.options[Number(value) - 1];
      if (!selected)
        throw new Error('Choose a listed option by number or provider ID.');
      return selected.id;
    }
    if (request.type === 'secret' && !value.trim())
      throw new Error('A value is required.');
    return value;
  };

  try {
    checkCancelled(controller.signal);
    const sdk = await (dependencies.loadSDK ?? loadSDK)(root);
    const agentDir = sdk.getAgentDir();
    const runtime = await sdk.ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: join(agentDir, 'models.json'),
      allowModelNetwork: false,
      refreshOnCreate: false,
      signal: controller.signal,
    });
    checkCancelled(controller.signal);
    if (command === 'logout') {
      await runtime.logout(positional[0], {signal: controller.signal});
      write(`Signed out of ${positional[0]}.`);
      return;
    }

    const providers = runtime
      .getProviders()
      .filter(provider =>
        apiKey
          ? Boolean(provider.auth.apiKey?.login)
          : Boolean(provider.auth.oauth || provider.auth.apiKey?.login),
      );
    if (!providers.length)
      throw new Error('No providers support this sign-in method.');
    if (!positional[0]) write('Sign in with varisdev login <provider>.');
    const providerId =
      positional[0] ??
      (await prompt({
        type: 'select',
        message: 'Choose a provider',
        options: providers.map(provider => ({
          id: provider.id,
          label: provider.name,
        })),
      }));
    const provider = providers.find(item => item.id === providerId);
    if (!provider) {
      throw new Error(
        `Provider '${providerId}' does not support this sign-in method. Run varisdev login${apiKey ? ' --api-key' : ''} to choose a provider.`,
      );
    }
    const type: AuthType = apiKey || !provider.auth.oauth ? 'api_key' : 'oauth';
    await runtime.login(provider.id, type, {
      signal: controller.signal,
      prompt,
      notify(event) {
        switch (event.type) {
          case 'auth_url':
            if (event.instructions) write(event.instructions);
            write(event.url);
            void (dependencies.openBrowser ?? openBrowser)(event.url).catch(
              () => {},
            );
            break;
          case 'device_code':
            write(`Code: ${event.userCode}`);
            write(event.verificationUri);
            void (dependencies.openBrowser ?? openBrowser)(
              event.verificationUri,
            ).catch(() => {});
            break;
          case 'info':
            write(event.message);
            event.links?.forEach(link =>
              write(`${link.label ? `${link.label}: ` : ''}${link.url}`),
            );
            break;
          case 'progress':
            write(event.message);
            break;
        }
      },
    });
    checkCancelled(controller.signal);
    write(`Signed in to ${provider.name}.`);
  } catch (error) {
    if (controller.signal.aborted || error instanceof CommandCancelledError) {
      throw new CommandCancelledError();
    }
    throw new Error(
      sanitize(error instanceof Error ? error.message : String(error)),
    );
  } finally {
    process.removeListener('SIGINT', cancel);
    dependencies.signal?.removeEventListener('abort', cancel);
    terminal?.close();
  }
}

/** Persist package changes through the SDK's settings storage, preserving existing entries. */
export async function runPluginCommand(
  root: string,
  command: 'install' | 'remove' | 'list' | 'update',
  args: string[],
  cwd = process.cwd(),
  dependencies: CommandDependencies = {},
): Promise<void> {
  const local = args.includes('--local');
  const positional = args.filter(arg => arg !== '--local');
  if (
    positional.some(arg => arg.startsWith('-')) ||
    args.filter(arg => arg === '--local').length > 1 ||
    (local && command !== 'install' && command !== 'remove') ||
    (command === 'list' && positional.length > 0) ||
    (command === 'update' && positional.length > 1) ||
    ((command === 'install' || command === 'remove') && positional.length !== 1)
  ) {
    const usage =
      command === 'update'
        ? 'plugins update [source]'
        : command === 'list'
          ? 'list'
          : `${command} <source> [--local]`;
    throw new Error(`Usage: varisdev ${usage}`);
  }
  const write = (message: string) =>
    (dependencies.write ?? (text => process.stdout.write(`${text}\n`)))(
      brand(message),
    );
  try {
    const sdk = await (dependencies.loadSDK ?? loadSDK)(root);
    const agentDir = sdk.getAgentDir();
    const settings = sdk.SettingsManager.create(cwd, agentDir, {
      projectTrusted: true,
    });
    const checkSettings = () => {
      const errors = settings.drainErrors();
      if (errors.length)
        throw new Error(errors.map(item => item.error.message).join('\n'));
    };
    checkSettings();
    if (!settings.getNpmCommand()?.length) {
      settings.applyOverrides({
        npmCommand: [
          process.env.VARISDEV_NODE_EXECUTABLE || process.execPath,
          join(root, 'node_modules/npm/bin/npm-cli.js'),
        ],
      });
    }
    const manager = new sdk.DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: settings,
    });
    manager.setProgressCallback(event => {
      if (event.type === 'start')
        write(event.message ?? `${event.action}: ${event.source}`);
    });
    if (command === 'list') {
      const packages = manager.listConfiguredPackages();
      if (!packages.length) write('No plugins installed.');
      for (const pkg of packages) {
        write(`${pkg.source} (${pkg.scope === 'project' ? 'local' : 'user'})`);
      }
      return;
    }
    const source = positional[0];
    if (command === 'install') await manager.installAndPersist(source, {local});
    else if (command === 'remove')
      await manager.removeAndPersist(source, {local});
    else await manager.update(source);
    await settings.flush();
    checkSettings();
    write(
      command === 'install'
        ? `Installed ${source}.`
        : command === 'remove'
          ? `Removed ${source}.`
          : source
            ? `Updated ${source}.`
            : 'Plugins updated.',
    );
  } catch (error) {
    throw new Error(
      brand(error instanceof Error ? error.message : String(error)),
    );
  }
}
