import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import type {AuthInteraction} from '@earendil-works/pi-ai';
import {
  CommandCancelledError,
  runAccountCommand,
  runPluginCommand,
  type CommandDependencies,
  type CommandSDK,
} from '../src/runtime/commands.ts';

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
  let login: (
    provider: string,
    interaction: AuthInteraction,
  ) => Promise<void> = async () => {};
  const sdk = {
    getAgentDir: () => '/isolated/agent',
    ModelRuntime: {
      async create(options: unknown) {
        calls.push(['create', options]);
        return {
          getProviders: () => providers,
          async login(
            provider: string,
            type: string,
            interaction: AuthInteraction,
          ) {
            calls.push(['login', provider, type]);
            await login(provider, interaction);
          },
          async logout(provider: string) {
            calls.push(['logout', provider]);
          },
        };
      },
    },
  } as unknown as CommandSDK;
  const dependencies: CommandDependencies = {
    loadSDK: async () => sdk,
    write: text => output.push(text),
    prompt: async () => '1',
    openBrowser: async () => {},
  };
  return {
    output,
    calls,
    dependencies,
    setLogin: (handler: typeof login) => {
      login = handler;
    },
  };
}

void test('login lists interactive providers and selects OAuth with normal auth paths', async () => {
  const fixture = accountFixture();
  await runAccountCommand('/runtime', 'login', [], fixture.dependencies);
  assert.deepEqual(fixture.calls[1], ['login', 'cloud', 'oauth']);
  assert.deepEqual(fixture.calls[0], [
    'create',
    {
      authPath: '/isolated/agent/auth.json',
      modelsPath: '/isolated/agent/models.json',
      allowModelNetwork: false,
      refreshOnCreate: false,
      signal:
        fixture.calls[0][1] &&
        (fixture.calls[0][1] as {signal: AbortSignal}).signal,
    },
  ]);
  assert.match(fixture.output.join('\n'), /varisdev login <provider>/);
  assert.match(fixture.output.join('\n'), /Cloud \(cloud\)/);
  assert.doesNotMatch(fixture.output.join('\n'), /Ambient/);
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

void test('OAuth shows browser and device links when browser opening fails', async () => {
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
  assert.deepEqual(opened, [
    'https://example.test/login',
    'https://example.test/device',
  ]);
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
  const authPath = '/users/pi/.pi/agent/auth.json';
  const fixture = accountFixture();
  const load = fixture.dependencies.loadSDK!;
  fixture.dependencies.loadSDK = async root => ({
    ...(await load(root)),
    getAgentDir: () => '/users/pi/.pi/agent',
    ModelRuntime: {
      async create(options) {
        assert.equal(options.authPath, authPath);
        throw new Error(`Pi cannot read ${options.authPath}: EACCES`);
      },
    },
  });
  await assert.rejects(
    runAccountCommand('/runtime', 'login', ['key'], fixture.dependencies),
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

void test('bundled SDK login and logout preserve other credentials in an isolated auth.json', async t => {
  const {directory, agentDir, sdk} = await isolatedSDK();
  t.after(() => rm(directory, {recursive: true, force: true}));
  const authPath = join(agentDir, 'auth.json');
  const existing = {other: {type: 'api_key', key: 'existing-secret'}};
  await writeFile(authPath, JSON.stringify(existing));
  const output: string[] = [];
  const load = async () =>
    ({
      ...sdk,
      getAgentDir: () => agentDir,
      ModelRuntime: {
        async create(options: Parameters<typeof sdk.ModelRuntime.create>[0]) {
          assert.equal(options?.authPath, authPath);
          const runtime = await sdk.ModelRuntime.create({
            ...options,
            modelsPath: null,
          });
          const provider = runtime.getProvider('anthropic')!;
          runtime.registerNativeProvider({
            ...provider,
            auth: {
              apiKey: {
                ...provider.auth.apiKey!,
                async login(interaction) {
                  return {
                    type: 'api_key',
                    key: await interaction.prompt({
                      type: 'secret',
                      message: 'API key',
                    }),
                  };
                },
              },
            },
          });
          return runtime;
        },
      },
    }) as unknown as CommandSDK;
  const dependencies = {
    loadSDK: load,
    write: (text: string) => output.push(text),
    prompt: async () => 'new-secret',
  };
  await runAccountCommand(
    directory,
    'login',
    ['anthropic', '--api-key'],
    dependencies,
  );
  assert.deepEqual(JSON.parse(await readFile(authPath, 'utf8')), {
    ...existing,
    anthropic: {type: 'api_key', key: 'new-secret'},
  });
  await runAccountCommand(directory, 'logout', ['anthropic'], dependencies);
  assert.deepEqual(JSON.parse(await readFile(authPath, 'utf8')), existing);
  assert.doesNotMatch(output.join('\n'), /secret/);
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
  assert.deepEqual(global.packages, [...existing.packages, '../plugin']);
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
    '../../plugin',
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
    '../plugin',
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
        '/runtime/node_modules/npm/bin/npm-cli.js',
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

function terminalAccountProcess() {
  const commandsURL = pathToFileURL(resolve('src/runtime/commands.ts')).href;
  const script = `
    const {runAccountCommand, CommandCancelledError} = await import(${JSON.stringify(commandsURL)});
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
      });
    } catch (error) {
      console.log(error.message);
      process.exitCode = error instanceof CommandCancelledError ? 130 : 1;
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
    const {child, closed} = terminalAccountProcess();
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
    child.kill('SIGINT');
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
