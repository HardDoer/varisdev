import assert from 'node:assert/strict';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import type {AuthInteraction, LoginOptions} from '@earendil-works/pi-ai';
import {
  CommandCancelledError,
  runAccountCommand,
  runPluginCommand,
  type CommandDependencies,
  type CommandSDK,
} from '../src/runtime/commands.ts';
import {mcpCliArguments} from '../src/runtime/cli.ts';

void test('MCP commands are forwarded with mcp as Pi argv[0]', () => {
  assert.deepEqual(mcpCliArguments(['mcp', 'list', '--json']), [
    'mcp',
    'list',
    '--json',
  ]);
  assert.deepEqual(mcpCliArguments(['run', 'mcp', '--help']), [
    'mcp',
    '--help',
  ]);
  assert.equal(mcpCliArguments(['run', '--help']), undefined);
});

function accountFixture() {
  const output: string[] = [];
  const calls: unknown[][] = [];
  const providers = [
    {
      id: 'cloud',
      name: 'Cloud',
      auth: {
        oauth: {login: async () => ({})},
        apiKey: {login: async () => ({})},
      },
    },
    {
      id: 'key',
      name: 'Key provider',
      auth: {apiKey: {login: async () => ({})}},
    },
    {id: 'ambient', name: 'Ambient', auth: {apiKey: {}}},
  ];
  const agentDir = '/users/test/.varisdev/agent';
  const settings = {
    getOrCreateDeviceId() {
      calls.push(['getOrCreateDeviceId']);
      return 'installation-device-id';
    },
    async flush() {
      calls.push(['flush']);
    },
    drainErrors: () => [] as {error: Error}[],
  };
  let login: (
    provider: string,
    interaction: AuthInteraction,
    options: LoginOptions,
  ) => Promise<void> = async () => {};
  const runtime = {
    getProviders: () => providers,
    async login(
      provider: string,
      type: string,
      interaction: AuthInteraction,
      options: LoginOptions,
    ) {
      calls.push(['login', provider, type]);
      await login(provider, interaction, options);
    },
    async logout(provider: string) {
      calls.push(['logout', provider]);
    },
  };
  const sdk = {
    getAgentDir: () => agentDir,
    SettingsManager: {
      create(cwd: string, directory: string, options: unknown) {
        calls.push(['settings', cwd, directory, options]);
        return settings;
      },
    },
    ModelRuntime: {
      async create(options: unknown) {
        calls.push(['create', options]);
        return runtime;
      },
    },
  } as unknown as CommandSDK;
  const dependencies: CommandDependencies = {
    loadSDK: async () => sdk,
    createGlobalModelRuntime: async root => {
      calls.push(['global', root]);
      return runtime as unknown as Awaited<
        ReturnType<CommandSDK['ModelRuntime']['create']>
      >;
    },
    write: text => output.push(text),
    prompt: async () => '1',
    openBrowser: async () => {},
  };
  return {
    output,
    calls,
    dependencies,
    agentDir,
    settings,
    providers,
    setLogin: (handler: typeof login) => {
      login = handler;
    },
  };
}

void test('login lists providers from the shared app runtime and selects OAuth', async () => {
  const fixture = accountFixture();
  await runAccountCommand('/runtime', 'login', [], fixture.dependencies);
  assert.deepEqual(fixture.calls[1], ['login', 'cloud', 'oauth']);
  assert.deepEqual(fixture.calls[0], ['global', '/runtime']);
  assert.match(fixture.output.join('\n'), /varisdev login <provider>/);
  assert.match(fixture.output.join('\n'), /Cloud \(cloud\)/);
  assert.doesNotMatch(fixture.output.join('\n'), /Ambient/);
});

void test('CLI OpenAI logout retains the issued registration before deleting credentials', async t => {
  const agentDir = await mkdtemp(
    join(tmpdir(), 'varisdev-logout-registration-'),
  );
  t.after(() => rm(agentDir, {recursive: true, force: true}));
  const authPath = join(agentDir, 'auth.json');
  await writeFile(
    authPath,
    JSON.stringify({
      openai: {
        type: 'oauth',
        clientId: 'oaiapp_existing',
        access: 'private-access',
        refresh: 'private-refresh',
        expires: 0,
      },
    }),
  );
  const fixture = accountFixture();
  const sdk = await fixture.dependencies.loadSDK!('/runtime');
  fixture.dependencies.loadSDK = async () => ({
    ...sdk,
    getAgentDir: () => agentDir,
    ModelRuntime: {
      async create() {
        return {
          getProviders: () => [],
          login: async () => assert.fail('Logout must not authorize'),
          async logout(provider) {
            assert.equal(provider, 'openai');
            const saved = await readFile(
              join(agentDir, 'openai-registrations.json'),
              'utf8',
            );
            assert.deepEqual(JSON.parse(saved).clientIds, ['oaiapp_existing']);
            assert.doesNotMatch(saved, /private-access|private-refresh/);
            await writeFile(authPath, '{}');
          },
        };
      },
    },
  });
  await runAccountCommand(
    '/runtime',
    'logout',
    ['openai'],
    fixture.dependencies,
  );
  assert.equal(await readFile(authPath, 'utf8'), '{}');
  assert.deepEqual(fixture.output, ['Signed out of openai.']);
});

void test('login delegates configured extension and llama providers to the shared runtime', async () => {
  const fixture = accountFixture();
  for (const [id, name] of [
    ['global-extension', 'Extension provider'],
    ['llama-server', 'llama.cpp server'],
  ]) {
    fixture.providers.push({
      id,
      name,
      auth: {apiKey: {login: async () => ({})}},
    });
    await runAccountCommand('/runtime', 'login', [id], fixture.dependencies);
    assert.deepEqual(fixture.calls.at(-1), ['login', id, 'api_key']);
  }
  assert.equal(
    fixture.calls.some(call => call[0] === 'create'),
    false,
  );
});

void test('shared runtime initialization failures stop login without falling back to bare providers', async () => {
  const fixture = accountFixture();
  fixture.dependencies.createGlobalModelRuntime = async () => {
    throw new Error('Pi runtime initialization failed');
  };
  await assert.rejects(
    runAccountCommand('/runtime', 'login', ['cloud'], fixture.dependencies),
    /VarisDev runtime initialization failed/,
  );
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.output, []);
});

void test('shared runtime diagnostics use sanitized output while healthy providers remain usable', async () => {
  const fixture = accountFixture();
  const create = fixture.dependencies.createGlobalModelRuntime!;
  let report: ((message: string) => void) | undefined;
  fixture.dependencies.createGlobalModelRuntime = async (
    root,
    onDiagnostic,
  ) => {
    report = onDiagnostic;
    onDiagnostic?.('Pi could not load one extension');
    return create(root, onDiagnostic);
  };
  fixture.dependencies.prompt = async () => 'private-key';
  fixture.setLogin(async (_provider, interaction) => {
    await interaction.prompt({type: 'secret', message: 'API key'});
    report?.('Pi diagnostic containing private-key');
  });
  await runAccountCommand('/runtime', 'login', ['key'], fixture.dependencies);
  assert.deepEqual(fixture.output, [
    'VarisDev could not load one extension',
    'VarisDev diagnostic containing [redacted]',
    'Signed in to Key provider.',
  ]);
});

void test('login dynamically loads the app runtime from the private desktop build', async t => {
  const root = await mkdtemp(join(tmpdir(), 'varisdev-command-runtime-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const modulePath = join(root, 'desktop/build/src/desktop/model-runtime.js');
  await mkdir(dirname(modulePath), {recursive: true});
  await writeFile(join(root, 'package.json'), JSON.stringify({type: 'module'}));
  await writeFile(
    modulePath,
    `
    export const calls = [];
    export async function createGlobalModelRuntime(onDiagnostic) {
      onDiagnostic?.('Pi extension warning');
      return {
        getProviders: () => [{id: 'configured', name: 'Configured', auth: {apiKey: {login() {}}}}],
        async login(provider, method, interaction, options) {
          calls.push([provider, method, options.agentName, typeof options.getDeviceId]);
        },
      };
    }
  `,
  );
  const fixture = accountFixture();
  fixture.dependencies.createGlobalModelRuntime = undefined;
  await runAccountCommand(root, 'login', ['configured'], fixture.dependencies);
  const module = await import(pathToFileURL(modulePath).href);
  assert.deepEqual(module.calls, [
    ['configured', 'api_key', 'VarisDev', 'function'],
  ]);
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.output, [
    'VarisDev extension warning',
    'Signed in to Configured.',
  ]);
});

void test('API key login overrides OAuth and redacts secrets in errors and progress', async () => {
  const fixture = accountFixture();
  fixture.dependencies.prompt = async prompt => {
    assert.equal(prompt.type, 'secret');
    return 'sk-private-value';
  };
  fixture.setLogin(async (_provider, interaction) => {
    const key = await interaction.prompt({
      type: 'secret',
      message: 'Pi API key',
    });
    interaction.notify({type: 'progress', message: `Pi storing ${key}`});
    throw new Error(`Pi rejected ${key}`);
  });
  await assert.rejects(
    runAccountCommand(
      '/runtime',
      'login',
      ['cloud', '--api-key'],
      fixture.dependencies,
    ),
    /VarisDev rejected \[redacted\]/,
  );
  assert.deepEqual(fixture.calls[1], ['login', 'cloud', 'api_key']);
  assert.deepEqual(fixture.output, ['VarisDev storing [redacted]']);
});

void test('OAuth opens only explicit auth URLs and displays device codes when browser opening fails', async () => {
  const fixture = accountFixture();
  const opened: string[] = [];
  fixture.dependencies.openBrowser = async url => {
    opened.push(url);
    throw new Error('No browser');
  };
  fixture.setLogin(async (_provider, interaction) => {
    interaction.notify({
      type: 'auth_url',
      url: 'https://example.test/login',
      instructions: 'Sign in to Pi',
    });
    interaction.notify({
      type: 'device_code',
      verificationUri: 'https://example.test/device',
      userCode: 'ABCD',
    });
    interaction.notify({
      type: 'info',
      message: 'Pi sign-in',
      links: [{url: 'https://example.test/help'}],
    });
  });
  await runAccountCommand('/runtime', 'login', ['cloud'], fixture.dependencies);
  assert.deepEqual(opened, ['https://example.test/login']);
  assert.match(fixture.output.join('\n'), /https:\/\/example.test\/login/);
  assert.match(fixture.output.join('\n'), /Code: ABCD/);
  assert.doesNotMatch(fixture.output.join('\n'), /\bpi\b/i);
});

void test('cancellation releases SIGINT listeners and prevents success output', async () => {
  const fixture = accountFixture();
  const controller = new AbortController();
  fixture.dependencies.signal = controller.signal;
  const before = process.listenerCount('SIGINT');
  fixture.setLogin(async (_provider, interaction) => {
    controller.abort();
    await interaction.prompt({type: 'secret', message: 'API key'});
  });
  await assert.rejects(
    runAccountCommand('/runtime', 'login', ['key'], fixture.dependencies),
    CommandCancelledError,
  );
  assert.equal(process.listenerCount('SIGINT'), before);
  assert.deepEqual(fixture.output, []);
});

void test('logout delegates one provider and login rejects unsupported providers and key arguments', async () => {
  const fixture = accountFixture();
  await runAccountCommand(
    '/runtime',
    'logout',
    ['cloud'],
    fixture.dependencies,
  );
  assert.deepEqual(fixture.calls[1], ['logout', 'cloud']);
  assert.deepEqual(fixture.output, ['Signed out of cloud.']);
  await assert.rejects(
    runAccountCommand('/runtime', 'login', ['ambient'], fixture.dependencies),
    /does not support/,
  );
  await assert.rejects(
    runAccountCommand(
      '/runtime',
      'login',
      ['key', '--api-key', 'secret'],
      fixture.dependencies,
    ),
    /Usage: varisdev login/,
  );
  await assert.rejects(
    runAccountCommand('/runtime', 'logout', [], fixture.dependencies),
    /Usage: varisdev logout/,
  );
});

void test('account storage errors retain the original auth path while branding prose', async () => {
  const authPath = join('/users/pi/.varisdev/agent', 'auth.json');
  const fixture = accountFixture();
  const load = fixture.dependencies.loadSDK!;
  fixture.dependencies.loadSDK = async root => ({
    ...(await load(root)),
    getAgentDir: () => '/users/pi/.varisdev/agent',
    ModelRuntime: {
      async create(options) {
        assert.equal(options.authPath, authPath);
        throw new Error(`Pi cannot read ${options.authPath}: EACCES`);
      },
    },
  });
  await assert.rejects(
    runAccountCommand('/runtime', 'logout', ['key'], fixture.dependencies),
    {message: `VarisDev cannot read ${authPath}: EACCES`},
  );
  assert.deepEqual(fixture.output, []);
});

void test('plugin errors preserve package sources and Windows paths while branding prose', async () => {
  await assert.rejects(
    runPluginCommand('/runtime', 'install', ['npm:pi-foo'], '/project', {
      loadSDK: async () => {
        throw new Error(
          'Pi cannot install npm:pi-foo: C:\\users\\pi\\.pi\\agent\\settings.json is locked',
        );
      },
    }),
    {
      message:
        'VarisDev cannot install npm:pi-foo: C:\\users\\pi\\.pi\\agent\\settings.json is locked',
    },
  );
});

async function isolatedSDK() {
  const directory = await mkdtemp(join(tmpdir(), 'varisdev-commands-'));
  const agentDir = join(directory, 'agent');
  const cwd = join(directory, 'project');
  await mkdir(agentDir);
  await mkdir(cwd);
  const url = pathToFileURL(
    resolve(
      'desktop/node_modules/@earendil-works/pi-coding-agent/dist/index.js',
    ),
  );
  const sdk = (await import(
    url.href
  )) as typeof import('@earendil-works/pi-coding-agent');
  return {directory, agentDir, cwd, sdk};
}

void test('login supplies lazy installation options from the private SDK and flushes only when requested', async () => {
  const fixture = accountFixture();
  fixture.setLogin(async (_provider, _interaction, options) => {
    assert.equal(options.agentName, 'VarisDev');
    assert.equal(options.getDeviceId?.(), 'installation-device-id');
    assert.equal(options.getDeviceId?.(), 'installation-device-id');
  });
  await runAccountCommand('/runtime', 'login', ['cloud'], fixture.dependencies);
  assert.deepEqual(fixture.calls.slice(2), [
    ['settings', fixture.agentDir, fixture.agentDir, {projectTrusted: false}],
    ['getOrCreateDeviceId'],
    ['getOrCreateDeviceId'],
    ['flush'],
  ]);
  assert.equal(fixture.output.at(-1), 'Signed in to Cloud.');
});

void test('API key login, logout, and OAuth without a device ID leave installation settings untouched', async () => {
  const fixture = accountFixture();
  fixture.setLogin(async (_provider, _interaction, options) => {
    assert.equal(typeof options.getDeviceId, 'function');
  });
  await runAccountCommand('/runtime', 'login', ['key'], fixture.dependencies);
  await runAccountCommand('/runtime', 'login', ['cloud'], fixture.dependencies);
  await runAccountCommand(
    '/runtime',
    'logout',
    ['removed-provider'],
    fixture.dependencies,
  );
  assert.deepEqual(
    fixture.calls.map(call => call[0]),
    ['global', 'login', 'global', 'login', 'create', 'logout'],
  );
  assert.deepEqual(fixture.calls.at(-1), ['logout', 'removed-provider']);
});

void test('provider prompts receive empty secrets and optional text unchanged', async () => {
  const fixture = accountFixture();
  fixture.dependencies.prompt = async () => '';
  fixture.setLogin(async (_provider, interaction) => {
    assert.equal(
      await interaction.prompt({type: 'secret', message: 'Optional key'}),
      '',
    );
    assert.equal(
      await interaction.prompt({type: 'text', message: 'Optional host'}),
      '',
    );
    assert.equal(
      await interaction.prompt({type: 'manual_code', message: 'Optional code'}),
      '',
    );
  });
  await runAccountCommand('/runtime', 'login', ['key'], fixture.dependencies);
  assert.equal(fixture.output.at(-1), 'Signed in to Key provider.');
});

void test('prompt cancellation can end one OAuth prompt while the provider completes login', async () => {
  const fixture = accountFixture();
  const controller = new AbortController();
  fixture.dependencies.prompt = async (_prompt, signal) => {
    assert.equal(signal.aborted, false);
    controller.abort();
    return 'callback-won';
  };
  fixture.setLogin(async (_provider, interaction) => {
    await assert.rejects(
      interaction.prompt({
        type: 'manual_code',
        message: 'Authorization code',
        signal: controller.signal,
      }),
      CommandCancelledError,
    );
    assert.equal(interaction.signal?.aborted, false);
  });
  await runAccountCommand('/runtime', 'login', ['cloud'], fixture.dependencies);
  assert.equal(fixture.output.at(-1), 'Signed in to Cloud.');
});

void test('installation settings flush after cancellation and preserve the cancellation result', async () => {
  const fixture = accountFixture();
  const controller = new AbortController();
  fixture.dependencies.signal = controller.signal;
  fixture.setLogin(async (_provider, interaction, options) => {
    options.getDeviceId?.();
    controller.abort();
    await interaction.prompt({
      type: 'manual_code',
      message: 'Authorization code',
    });
  });
  await assert.rejects(
    runAccountCommand('/runtime', 'login', ['cloud'], fixture.dependencies),
    CommandCancelledError,
  );
  assert.deepEqual(fixture.calls.at(-1), ['flush']);
  assert.deepEqual(fixture.output, []);
});

void test('installation settings errors prevent success and retain credential commit status', async () => {
  const fixture = accountFixture();
  fixture.settings.drainErrors = () => [
    {error: new Error('Pi settings unreadable')},
  ];
  fixture.setLogin(async (_provider, _interaction, options) => {
    options.getDeviceId?.();
  });
  await assert.rejects(
    runAccountCommand('/runtime', 'login', ['cloud'], fixture.dependencies),
    /VarisDev settings unreadable/,
  );
  assert.equal(
    fixture.calls.some(call => call[0] === 'getOrCreateDeviceId'),
    false,
  );
  assert.deepEqual(fixture.output, []);

  fixture.settings.drainErrors = () => [];
  fixture.settings.flush = async () => {
    fixture.settings.drainErrors = () => [
      {error: new Error('Pi settings write failed')},
    ];
  };
  await assert.rejects(
    runAccountCommand('/runtime', 'login', ['cloud'], fixture.dependencies),
    /Signed in to Cloud, but the installation ID could not be saved: VarisDev settings write failed/,
  );
  assert.deepEqual(fixture.output, []);
});

void test('SDK synchronization failures retain login and orphan logout commit status', async () => {
  const fixture = accountFixture();
  class SynchronizationError extends Error {}
  const load = fixture.dependencies.loadSDK!;
  fixture.dependencies.loadSDK = async root => ({
    ...(await load(root)),
    CredentialSynchronizationError:
      SynchronizationError as unknown as CommandSDK['CredentialSynchronizationError'],
  });
  fixture.setLogin(async (_provider, interaction) => {
    fixture.dependencies.prompt = async () => 'private-key';
    await interaction.prompt({type: 'secret', message: 'API key'});
    throw new SynchronizationError('Pi snapshot failed for private-key');
  });
  await assert.rejects(
    runAccountCommand('/runtime', 'login', ['cloud'], fixture.dependencies),
    /Signed in to Cloud, but local model state could not be synchronized: VarisDev snapshot failed for \[redacted\]/,
  );
  const previousLoad = fixture.dependencies.loadSDK;
  fixture.dependencies.loadSDK = async root => {
    const sdk = await previousLoad(root);
    const create = sdk.ModelRuntime.create;
    return {
      ...sdk,
      ModelRuntime: {
        async create(options) {
          return {
            ...(await create(options)),
            async logout() {
              throw new SynchronizationError('Pi snapshot failed');
            },
          };
        },
      },
    };
  };
  await assert.rejects(
    runAccountCommand(
      '/runtime',
      'logout',
      ['removed-provider'],
      fixture.dependencies,
    ),
    /Signed out of removed-provider, but local model state could not be synchronized: VarisDev snapshot failed/,
  );
  assert.deepEqual(fixture.output, []);
});

void test('bundled package manager persists user and local plugins without replacing registry or settings', async t => {
  const {directory, agentDir, cwd, sdk} = await isolatedSDK();
  t.after(() => rm(directory, {recursive: true, force: true}));
  const source = join(directory, 'plugin');
  await mkdir(source);
  const globalPath = join(agentDir, 'settings.json');
  const existing = {
    theme: 'custom',
    packages: [{source: '/existing/plugin', extensions: ['only.ts']}],
  };
  await writeFile(globalPath, JSON.stringify(existing));
  const output: string[] = [];
  const dependencies = {
    loadSDK: async () =>
      ({...sdk, getAgentDir: () => agentDir}) as unknown as CommandSDK,
    write: (text: string) => output.push(text),
  };
  await runPluginCommand(directory, 'install', [source], cwd, dependencies);
  const global = JSON.parse(await readFile(globalPath, 'utf8'));
  assert.equal(global.theme, 'custom');
  assert.deepEqual(global.packages, [
    ...existing.packages,
    relative(agentDir, source),
  ]);
  assert.equal(global.npmCommand, undefined);
  await runPluginCommand(
    directory,
    'install',
    [source, '--local'],
    cwd,
    dependencies,
  );
  const projectPath = join(cwd, sdk.CONFIG_DIR_NAME, 'settings.json');
  assert.deepEqual(JSON.parse(await readFile(projectPath, 'utf8')).packages, [
    relative(dirname(projectPath), source),
  ]);
  await runPluginCommand(directory, 'list', [], cwd, dependencies);
  assert.match(output.join('\n'), /\(local\)/);
  assert.match(output.join('\n'), /\(user\)/);
  await runPluginCommand(directory, 'update', [source], cwd, dependencies);
  await runPluginCommand(
    directory,
    'remove',
    [source, '--local'],
    cwd,
    dependencies,
  );
  assert.deepEqual(
    JSON.parse(await readFile(projectPath, 'utf8')).packages,
    [],
  );
  assert.deepEqual(JSON.parse(await readFile(globalPath, 'utf8')).packages, [
    ...existing.packages,
    relative(agentDir, source),
  ]);
  await runPluginCommand(directory, 'remove', [source], cwd, dependencies);
  assert.deepEqual(JSON.parse(await readFile(globalPath, 'utf8')), existing);
});

void test('package commands use bundled npm or respect a configured command and surface storage errors', async () => {
  for (const configured of [undefined, ['custom-npm', '--flag']]) {
    let command = configured;
    const calls: unknown[][] = [];
    const output: string[] = [];
    const settings = {
      drainErrors: () => [] as {error: Error}[],
      flush: async () => {
        calls.push(['flush']);
      },
      getNpmCommand: () => command,
      applyOverrides: (overrides: {npmCommand?: string[]}) => {
        command = overrides.npmCommand;
      },
    };
    const sdk = {
      getAgentDir: () => '/isolated',
      SettingsManager: {create: () => settings},
      DefaultPackageManager: class {
        setProgressCallback() {}
        async installAndPersist(source: string, options: unknown) {
          calls.push(['install', source, options]);
        }
        async removeAndPersist(source: string, options: unknown) {
          calls.push(['remove', source, options]);
          return true;
        }
        async update(source?: string) {
          calls.push(['update', source]);
        }
        listConfiguredPackages() {
          return [];
        }
      },
    } as unknown as CommandSDK;
    const dependencies = {
      loadSDK: async () => sdk,
      write: (text: string) => output.push(text),
    };
    await runPluginCommand(
      '/runtime',
      'install',
      ['npm:plugin', '--local'],
      '/project',
      dependencies,
    );
    assert.deepEqual(
      command,
      configured ?? [
        process.env.VARISDEV_NODE_EXECUTABLE || process.execPath,
        join('/runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      ],
    );
    assert.deepEqual(calls, [
      ['install', 'npm:plugin', {local: true}],
      ['flush'],
    ]);
    await runPluginCommand('/runtime', 'update', [], '/project', dependencies);
    assert.deepEqual(calls[2], ['update', undefined]);
    await runPluginCommand('/runtime', 'list', [], '/project', dependencies);
    assert.equal(output.at(-1), 'No plugins installed.');
    settings.drainErrors = () => [
      {error: new Error('Pi settings could not be saved')},
    ];
    await assert.rejects(
      runPluginCommand(
        '/runtime',
        'install',
        ['npm:plugin'],
        '/project',
        dependencies,
      ),
      /VarisDev settings could not be saved/,
    );
  }
});

function terminalAccountProcess(simulateSignal = false) {
  const commandsURL = pathToFileURL(resolve('src/runtime/commands.ts')).href;
  const script = `
    const {runAccountCommand, CommandCancelledError} = await import(${JSON.stringify(commandsURL)});
    if (${simulateSignal}) process.once('message', message => {
      if (message === 'SIGINT') process.emit('SIGINT');
    });
    const runtime = {
      getProviders: () => [{id: 'cloud', name: 'Cloud', auth: {apiKey: {login() {}}}}],
      async login(provider, type, interaction) {
        const key = await interaction.prompt({type: 'secret', message: 'API key'});
        interaction.notify({type: 'progress', message: 'Saved ' + key});
      },
    };
    try {
      await runAccountCommand('/isolated', 'login', [], {
        loadSDK: async () => ({getAgentDir: () => '/isolated', ModelRuntime: {create: async () => runtime}}),
        createGlobalModelRuntime: async () => runtime,
      });
    } catch (error) {
      console.log(error.message);
      process.exitCode = error instanceof CommandCancelledError ? 130 : 1;
    } finally {
      if (process.connected) process.disconnect();
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  }) as ChildProcessWithoutNullStreams;
  let output = '';
  let errors = '';
  child.stdout.on('data', chunk => {
    output += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    errors += chunk.toString();
  });
  const closed = new Promise<{
    code: number | null;
    output: string;
    errors: string;
  }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({code, output, errors}));
  });
  return {child, closed};
}

void test(
  'terminal readline buffers provider and secret input and never prints the key',
  {timeout: 15000},
  async t => {
    const {child, closed} = terminalAccountProcess();
    t.after(() => child.kill());
    child.stdin.end('cloud\nsk-terminal-private\n');
    const result = await closed;
    assert.equal(result.code, 0, result.errors);
    assert.match(result.output, /Signed in to Cloud/);
    assert.match(result.output, /Saved \[redacted\]/);
    assert.doesNotMatch(result.output + result.errors, /sk-terminal-private/);
  },
);

void test(
  'terminal Ctrl-C cancels a pending secret prompt and exits cleanly',
  {timeout: 15000},
  async t => {
    const {child, closed} = terminalAccountProcess(
      process.platform === 'win32',
    );
    t.after(() => child.kill());
    child.stdin.write('cloud\n');
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('API key:')) {
          child.stdout.removeListener('data', onData);
          resolve();
        }
      };
      child.stdout.on('data', onData);
      child.once('exit', () =>
        reject(new Error('Child exited before prompting')),
      );
    });
    // Windows kill('SIGINT') terminates the process without running its handler.
    if (process.platform === 'win32') child.send('SIGINT');
    else child.kill('SIGINT');
    const result = await closed;
    assert.equal(result.code, 130, result.errors);
    assert.match(result.output, /Cancelled/);
    assert.doesNotMatch(result.output, /Signed in/);
  },
);

void test('plugin commands reject unsupported arguments before touching configuration', async () => {
  const dependencies = {
    loadSDK: async (): Promise<CommandSDK> => {
      throw new Error('SDK must not load');
    },
  };
  for (const [command, args] of [
    ['install', []],
    ['remove', ['a', 'b']],
    ['list', ['--local']],
    ['update', ['--local']],
    ['install', ['--unknown']],
  ] as const) {
    await assert.rejects(
      runPluginCommand(
        '/runtime',
        command,
        [...args],
        '/project',
        dependencies,
      ),
      /Usage: varisdev/,
    );
  }
});
