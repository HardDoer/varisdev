import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {ModelRuntime, SettingsManager} from '@earendil-works/pi-coding-agent';
import {DesktopAccounts, type AccountState} from '../src/desktop/accounts.ts';
import {createDashboardParent} from '../src/dashboard/parent.ts';

async function waitFor(check: () => boolean) {
  for (let count = 0; count < 300; count++) {
    if (check()) return;
    await delay(10);
  }
  assert.ok(check(), 'Account operation did not settle');
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'varisdev-accounts-'));
  const agentDir = join(directory, 'agent');
  const cwd = join(directory, 'project');
  await mkdir(agentDir);
  await mkdir(cwd);
  const previous = {
    agent: process.env.PI_CODING_AGENT_DIR,
    key: process.env.OPENAI_API_KEY,
  };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.OPENAI_API_KEY;
  const authPath = join(agentDir, 'auth.json');
  const existing = {other: {type: 'api_key', key: 'unrelated-credential'}};
  await writeFile(authPath, JSON.stringify(existing));
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        openai: {
          baseUrl: 'https://account-fixture.invalid/v1',
          api: 'openai-completions',
          models: [{id: 'account-model', name: 'Account fixture'}],
        },
      },
    }),
  );
  const runtime = await ModelRuntime.create({
    authPath,
    modelsPath: join(agentDir, 'models.json'),
    allowModelNetwork: false,
  });
  const originalRefresh = runtime.refresh.bind(runtime);
  const refresh = t.mock.method(
    runtime,
    'refresh',
    (options: Parameters<ModelRuntime['refresh']>[0]) =>
      originalRefresh({...options, allowNetwork: false}),
  );
  const states: AccountState[] = [];
  const opened: string[] = [];
  const parents: Array<Awaited<ReturnType<typeof createDashboardParent>>> = [];
  const accounts = new DesktopAccounts({
    createRuntime: async () => runtime,
    changed: state => states.push(state),
    openBrowser: async url => {
      opened.push(url);
    },
  });
  t.after(async () => {
    for (const parent of parents) await parent.close();
    await accounts.dispose();
    if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agent;
    if (previous.key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous.key;
    await rm(directory, {recursive: true, force: true});
  });
  const reply = (value: string) => {
    const state = accounts.snapshot();
    accounts.respond(state.attempt!.id, state.prompt!.id, value);
  };
  return {
    accounts,
    runtime,
    refresh,
    states,
    opened,
    authPath,
    agentDir,
    existing,
    cwd,
    reply,
    parents,
  };
}

void test(
  'GUI credentials persist and an already open parent can use them without restart',
  {timeout: 20000},
  async t => {
    const {
      accounts,
      runtime,
      states,
      authPath,
      agentDir,
      existing,
      cwd,
      reply,
      parents,
    } = await fixture(t);
    const parent = await createDashboardParent({cwd});
    parents.push(parent);
    const requests: string[] = [];
    t.mock.method(
      globalThis,
      'fetch',
      async (url: RequestInfo | URL, options?: RequestInit) => {
        assert.equal(
          String(url),
          'https://account-fixture.invalid/v1/chat/completions',
        );
        requests.push(new Headers(options?.headers).get('authorization')!);
        return new Response(
          'data: ' +
            JSON.stringify({
              id: 'fixture',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'account-model',
              choices: [
                {
                  index: 0,
                  delta: {role: 'assistant', content: 'Connected.'},
                  finish_reason: 'stop',
                },
              ],
            }) +
            '\n\ndata: [DONE]\n\n',
          {headers: {'content-type': 'text/event-stream'}},
        );
      },
    );
    await accounts.get();
    assert.equal(
      accounts.snapshot().providers.find(item => item.id === 'openai')?.stored,
      false,
    );
    accounts.start('openai', 'api_key');
    await waitFor(() => Boolean(accounts.snapshot().prompt));
    assert.equal(accounts.snapshot().prompt!.type, 'secret');
    reply('fixture-provider-key');
    await waitFor(() => !accounts.snapshot().attempt);
    assert.equal(accounts.snapshot().error, undefined);
    assert.equal(
      accounts.snapshot().providers.find(item => item.id === 'openai')?.status,
      'API key saved',
    );
    assert.deepEqual(JSON.parse(await readFile(authPath, 'utf8')), {
      ...existing,
      openai: {type: 'api_key', key: 'fixture-provider-key'},
    });
    const signedInParent = await createDashboardParent({cwd});
    parents.push(signedInParent);
    const selected = (await signedInParent.features()).model;
    assert.ok(selected);
    assert.ok(
      (await runtime.getAvailable()).some(
        model =>
          model.provider === selected.provider && model.id === selected.id,
      ),
      'Pi selects an available model after sign-in',
    );
    await parent.configure({provider: 'openai', modelId: 'account-model'});
    const defaults = SettingsManager.create(cwd, agentDir);
    assert.equal(defaults.getDefaultProvider(), undefined);
    assert.equal(defaults.getDefaultModel(), undefined);
    await parent.configure({
      provider: 'openai',
      modelId: 'account-model',
      thinkingLevel: 'off',
      persist: true,
    });
    const remembered = await createDashboardParent({cwd});
    parents.push(remembered);
    assert.deepEqual((await remembered.features()).model, {
      provider: 'openai',
      id: 'account-model',
    });
    await parent.prompt('Check the saved account');
    assert.deepEqual(requests, ['Bearer fixture-provider-key']);
    assert.doesNotMatch(
      JSON.stringify(states),
      /fixture-provider-key|unrelated-credential/,
    );
    accounts.start('openai', 'logout');
    await waitFor(() => !accounts.snapshot().attempt);
    assert.deepEqual(JSON.parse(await readFile(authPath, 'utf8')), existing);
    // The open parent rechecks credentials on subsequent requests.
    await assert.rejects(
      parent.configure({provider: 'openai', modelId: 'gpt-4o'}),
      /No API key/,
    );
  },
);

void test('OAuth selection, browser links, device codes and manual prompts use SDK flows', async t => {
  const {accounts, runtime, refresh, opened, reply, authPath, states} =
    await fixture(t);
  const original = runtime.getProvider('openai-codex')!;
  runtime.registerNativeProvider({
    ...original,
    auth: {
      oauth: {
        ...original.auth.oauth!,
        async login(interaction, options) {
          assert.equal(options?.agentName, 'VarisDev');
          assert.match(
            options!.getDeviceId!(),
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          );
          assert.equal(options!.getDeviceId!(), options!.getDeviceId!());
          assert.equal(
            await interaction.prompt({
              type: 'select',
              message: 'Account type',
              options: [
                {id: 'personal', label: 'Personal'},
                {id: 'work', label: 'Work'},
              ],
            }),
            'work',
          );
          assert.equal(
            await interaction.prompt({type: 'text', message: 'Organization'}),
            'example',
          );
          interaction.notify({
            type: 'auth_url',
            url: 'https://provider.invalid/authorize',
            instructions: 'Authorize the app.',
          });
          interaction.notify({
            type: 'device_code',
            userCode: 'ABCD-EFGH',
            verificationUri: 'https://provider.invalid/device',
          });
          assert.equal(
            await interaction.prompt({
              type: 'manual_code',
              message: 'Authorization code',
            }),
            'private-code',
          );
          return {
            type: 'oauth',
            access: 'private-access-token',
            refresh: 'private-refresh-token',
            expires: Date.now() + 3600000,
          };
        },
        async toAuth(credential) {
          return {apiKey: credential.access};
        },
      },
    },
  });
  accounts.start('openai-codex', 'oauth');
  await waitFor(() => Boolean(accounts.snapshot().prompt));
  assert.throws(() => reply('unknown'), /listed options/);
  reply('work');
  await waitFor(() => accounts.snapshot().prompt?.type === 'text');
  reply('example');
  await waitFor(() => accounts.snapshot().prompt?.type === 'manual_code');
  assert.equal(accounts.snapshot().deviceCode, 'ABCD-EFGH');
  assert.deepEqual(opened, ['https://provider.invalid/authorize']);
  await accounts.openLink(accounts.snapshot().attempt!.id, 1);
  assert.deepEqual(opened, [
    'https://provider.invalid/authorize',
    'https://provider.invalid/device',
  ]);
  reply('private-code');
  await waitFor(() => !accounts.snapshot().attempt);
  assert.equal(accounts.snapshot().error, undefined);
  assert.ok(
    refresh.mock.calls.some(
      call =>
        call.arguments[0]?.allowNetwork === true &&
        call.arguments[0]?.providers?.[0] === 'openai-codex' &&
        call.arguments[0]?.signal instanceof AbortSignal,
    ),
    'Successful login refreshes only the signed-in provider through the SDK',
  );
  assert.equal(
    JSON.parse(await readFile(authPath, 'utf8'))['openai-codex'].type,
    'oauth',
  );
  assert.doesNotMatch(
    JSON.stringify(states),
    /private-(?:code|access|refresh)/,
  );
  assert.deepEqual(accounts.snapshot().links, []);
});

void test('OAuth login persists one installation ID across simultaneous accounts, retries and recreation', async t => {
  const {accounts, runtime, agentDir, states} = await fixture(t);
  const settingsPath = join(agentDir, 'settings.json');
  await writeFile(settingsPath, JSON.stringify({theme: 'light'}));
  t.mock.method(globalThis, 'fetch', async () => {
    assert.fail('Account identity integration must not use the network');
  });
  const observed: string[] = [];
  let finish!: () => void;
  const ready = new Promise<void>(resolve => {
    finish = resolve;
  });
  const login: ModelRuntime['login'] = async (
    provider,
    method,
    interaction,
    options,
  ) => {
    assert.equal(provider, 'openai');
    assert.equal(method, 'oauth');
    assert.equal(interaction.signal?.aborted, false);
    assert.equal(options?.agentName, 'VarisDev');
    const id = options!.getDeviceId!();
    assert.match(
      id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    assert.equal(options!.getDeviceId!(), id);
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.equal(settings.deviceId, id, 'ID must be saved before login starts');
    assert.equal(settings.theme, 'light');
    observed.push(id);
    await ready;
    throw new Error('Retry sign-in');
  };
  t.mock.method(runtime, 'login', login);
  const recreate = () =>
    new DesktopAccounts({
      createRuntime: async () => runtime,
      changed: state => states.push(state),
      openBrowser: async () => assert.fail('No real OAuth browser flow'),
    });
  const simultaneous = recreate();
  t.after(() => simultaneous.dispose());
  accounts.start('openai', 'oauth');
  simultaneous.start('openai', 'oauth');
  await waitFor(() => observed.length === 2);
  assert.equal(observed[0], observed[1]);
  assert.throws(() => accounts.start('openai', 'oauth'), /Finish or cancel/);
  finish();
  await waitFor(
    () => !accounts.snapshot().attempt && !simultaneous.snapshot().attempt,
  );
  assert.equal(accounts.snapshot().error, 'Retry sign-in');
  accounts.start('openai', 'oauth');
  await waitFor(() => !accounts.snapshot().attempt);
  assert.equal(observed.length, 3);
  await accounts.dispose();
  const recreated = recreate();
  t.after(() => recreated.dispose());
  recreated.start('openai', 'oauth');
  await waitFor(() => !recreated.snapshot().attempt);
  assert.equal(observed.length, 4);
  assert.deepEqual(observed, Array(4).fill(observed[0]));
  assert.equal(
    JSON.parse(await readFile(settingsPath, 'utf8')).deviceId,
    observed[0],
  );
  assert.doesNotMatch(JSON.stringify(states), /unrelated-credential/);
});

void test('installation settings failures prevent OAuth and allow a later retry', async t => {
  const {accounts, runtime, agentDir} = await fixture(t);
  const settingsPath = join(agentDir, 'settings.json');
  await writeFile(settingsPath, 'invalid settings');
  const implementation: ModelRuntime['login'] = async (
    _provider,
    _method,
    _interaction,
    options,
  ) => {
    options!.getDeviceId!();
    throw new Error('Reached login');
  };
  const login = t.mock.method(runtime, 'login', implementation);
  accounts.start('openai', 'oauth');
  await waitFor(() => !accounts.snapshot().attempt);
  assert.equal(
    accounts.snapshot().error,
    'Could not read installation settings.',
  );
  assert.equal(login.mock.callCount(), 1);
  await writeFile(settingsPath, '{}');
  accounts.start('openai', 'oauth');
  await waitFor(() => !accounts.snapshot().attempt);
  assert.equal(login.mock.callCount(), 2);
  assert.equal(accounts.snapshot().error, 'Reached login');
});

void test('default account runtime uses SDK global extension providers and built-in auth overrides', async t => {
  const {agentDir, authPath, existing} = await fixture(t);
  const refresh = ModelRuntime.prototype.refresh;
  t.mock.method(
    ModelRuntime.prototype,
    'refresh',
    function (
      this: ModelRuntime,
      options: Parameters<ModelRuntime['refresh']>[0],
    ) {
      return refresh.call(this, {...options, allowNetwork: false});
    },
  );
  await mkdir(join(agentDir, 'extensions'));
  await writeFile(
    join(agentDir, 'extensions', 'accounts.js'),
    `
    export default pi => {
      pi.registerProvider('openai', {
        name: 'Extension OpenAI',
        models: [],
        async refreshModels() { return []; },
        oauth: {
          name: 'Extension OAuth',
          async login(callbacks) {
            const choice = await callbacks.onSelect({message: 'Account', options: [{id: 'custom', label: 'Custom account'}]});
            if (choice !== 'custom') throw new Error('Wrong account choice');
            const value = await callbacks.onPrompt({message: 'Blank for default', allowEmpty: true});
            if (value !== '') throw new Error('Expected provider default');
            return {access: 'extension-access', refresh: 'extension-refresh', expires: Date.now() + 3600000};
          },
          async refreshToken(credential) { return credential; },
          getApiKey(credential) { return credential.access; },
        },
      });
      pi.registerProvider({
        id: 'native-account', name: 'Native account', getModels: () => [],
        stream() { throw new Error('Unused'); },
        streamSimple() { throw new Error('Unused'); },
        auth: {apiKey: {
          name: 'Native key',
          async login(interaction) {
            return {type: 'api_key', key: await interaction.prompt({type: 'secret', message: 'Native secret'})};
          },
          async resolve({credential}) { return credential ? {auth: {apiKey: credential.key}} : undefined; },
        }},
      });
    }
  `,
  );
  t.mock.method(globalThis, 'fetch', async () => {
    assert.fail('Extension account integration must not use the network');
  });
  const states: AccountState[] = [];
  const accounts = new DesktopAccounts({
    changed: state => states.push(state),
    openBrowser: async () => assert.fail('No real browser authorization'),
  });
  t.after(() => accounts.dispose());
  const initial = await accounts.get();
  assert.equal(
    initial.providers.find(provider => provider.id === 'openai')?.name,
    'Extension OpenAI',
  );
  assert.equal(
    initial.providers.find(provider => provider.id === 'native-account')
      ?.apiKey,
    true,
  );
  const respond = (value: string) => {
    const state = accounts.snapshot();
    accounts.respond(state.attempt!.id, state.prompt!.id, value);
  };
  accounts.start('native-account', 'api_key');
  await waitFor(() => accounts.snapshot().prompt?.message === 'Native secret');
  respond('native-private-key');
  await waitFor(() => !accounts.snapshot().attempt);
  assert.equal(accounts.snapshot().error, undefined);
  accounts.start('openai', 'oauth');
  await waitFor(() => accounts.snapshot().prompt?.type === 'select');
  respond('custom');
  await waitFor(
    () => accounts.snapshot().prompt?.message === 'Blank for default',
  );
  respond('');
  await waitFor(() => !accounts.snapshot().attempt);
  assert.equal(accounts.snapshot().error, undefined);
  const stored = JSON.parse(await readFile(authPath, 'utf8'));
  assert.deepEqual(stored.other, existing.other);
  assert.equal(stored['native-account'].key, 'native-private-key');
  assert.equal(stored.openai.access, 'extension-access');
  assert.doesNotMatch(
    JSON.stringify(states),
    /native-private-key|extension-access|extension-refresh/,
  );
});

for (const [name, source] of [
  ['loading', 'export default () => { throw new Error("Broken extension"); };'],
  ['registration', 'export default pi => pi.registerProvider({id: ""});'],
]) {
  void test(`global account runtime reports SDK extension ${name} errors and keeps healthy providers usable`, async t => {
    const {agentDir, authPath} = await fixture(t);
    await mkdir(join(agentDir, 'extensions'));
    await writeFile(join(agentDir, 'extensions', 'broken.js'), source);
    const accounts = new DesktopAccounts({
      changed: () => {},
      openBrowser: async () => {},
    });
    t.after(() => accounts.dispose());
    const state = await accounts.get();
    assert.ok(
      state.providers.some(
        provider =>
          provider.id === 'openai' && provider.oauth && provider.apiKey,
      ),
    );
    assert.match(state.diagnostics!.join('\n'), /broken\.js/);
    accounts.start('other', 'logout');
    await waitFor(() => !accounts.snapshot().attempt);
    assert.equal(accounts.snapshot().error, undefined);
    assert.match(accounts.snapshot().diagnostics!.join('\n'), /broken\.js/);
    assert.deepEqual(JSON.parse(await readFile(authPath, 'utf8')), {});
  });
}

void test('all OAuth provider variants receive SDK login options without creating an unused device ID', async t => {
  const {accounts, runtime, agentDir} = await fixture(t);
  const settingsPath = join(agentDir, 'settings.json');
  await writeFile(settingsPath, 'unused invalid settings');
  const visited: string[] = [];
  const login: ModelRuntime['login'] = async (
    provider,
    method,
    _interaction,
    options,
  ) => {
    assert.equal(method, 'oauth');
    assert.equal(typeof options?.getDeviceId, 'function');
    assert.equal(options?.agentName, 'VarisDev');
    visited.push(provider);
    return {
      type: 'oauth',
      access: 'private-token',
      refresh: 'private-refresh',
      expires: 0,
    };
  };
  t.mock.method(runtime, 'login', login);
  const providers = runtime
    .getProviders()
    .filter(provider => provider.auth.oauth);
  assert.ok(providers.some(provider => provider.id === 'openai'));
  assert.ok(providers.some(provider => provider.id === 'openai-codex'));
  assert.ok(providers.some(provider => provider.id === 'github-copilot'));
  for (const provider of providers) {
    accounts.start(provider.id, 'oauth');
    await waitFor(() => !accounts.snapshot().attempt);
    assert.equal(accounts.snapshot().error, undefined, provider.id);
  }
  assert.deepEqual(
    visited,
    providers.map(provider => provider.id),
  );
  assert.equal(await readFile(settingsPath, 'utf8'), 'unused invalid settings');
});

void test('provider prompts receive empty defaults and raw strings without adapter validation', async t => {
  const {accounts, runtime, reply, states} = await fixture(t);
  const provider = runtime.getProvider('github-copilot')!;
  runtime.registerNativeProvider({
    ...provider,
    auth: {
      oauth: {
        ...provider.auth.oauth!,
        async login(interaction) {
          assert.equal(
            await interaction.prompt({
              type: 'text',
              message: 'Blank for default domain',
            }),
            '',
          );
          assert.equal(
            await interaction.prompt({type: 'secret', message: 'Optional key'}),
            '',
          );
          assert.equal(
            await interaction.prompt({
              type: 'manual_code',
              message: 'Continue',
            }),
            '',
          );
          assert.equal(
            await interaction.prompt({type: 'text', message: 'Exact value'}),
            '  raw input  ',
          );
          interaction.notify({
            type: 'info',
            message: 'Provider accepted defaults.',
          });
          return {
            type: 'oauth',
            access: 'private-token',
            refresh: 'private-refresh',
            expires: Date.now() + 3600000,
          };
        },
      },
    },
  });
  accounts.start(provider.id, 'oauth');
  for (const message of [
    'Blank for default domain',
    'Optional key',
    'Continue',
    'Exact value',
  ]) {
    await waitFor(() => accounts.snapshot().prompt?.message === message);
    assert.equal(accounts.snapshot().prompt?.allowEmpty, true);
    reply(message === 'Exact value' ? '  raw input  ' : '');
  }
  await waitFor(() => !accounts.snapshot().attempt);
  assert.equal(accounts.snapshot().error, undefined);
  assert.ok(
    states.some(state => state.message === 'Provider accepted defaults.'),
  );
  assert.doesNotMatch(
    JSON.stringify(states),
    /private-token|private-refresh|\[redacted\]/,
  );
});

void test('stored credentials for unavailable providers remain visible and can be logged out through the SDK', async t => {
  const {accounts, authPath} = await fixture(t);
  const state = await accounts.get();
  assert.deepEqual(
    state.providers.find(provider => provider.id === 'other'),
    {
      id: 'other',
      name: 'other',
      oauth: false,
      apiKey: false,
      stored: true,
      status: 'API key saved',
    },
  );
  accounts.start('other', 'logout');
  await waitFor(() => !accounts.snapshot().attempt);
  assert.equal(accounts.snapshot().error, undefined);
  assert.equal(accounts.snapshot().message, 'Signed out of other.');
  assert.deepEqual(JSON.parse(await readFile(authPath, 'utf8')), {});
  assert.equal(
    accounts.snapshot().providers.some(provider => provider.id === 'other'),
    false,
  );
});

void test('catalog refresh failures preserve the SDK login result and do not expose provider errors', async t => {
  const {accounts, runtime, authPath, states, reply} = await fixture(t);
  const originalRefresh = runtime.refresh.bind(runtime);
  t.mock.method(
    runtime,
    'refresh',
    async (options: Parameters<ModelRuntime['refresh']>[0]) => {
      if (options?.allowNetwork) {
        assert.deepEqual(options.providers, ['openai']);
        return {
          aborted: false,
          errors: new Map([
            ['openai', new Error('private-refresh-credential')],
          ]),
        };
      }
      return originalRefresh(options);
    },
  );
  accounts.start('openai', 'api_key');
  await waitFor(() => Boolean(accounts.snapshot().prompt));
  reply('saved-api-key');
  await waitFor(() => !accounts.snapshot().attempt);
  assert.equal(accounts.snapshot().message, 'API key saved for OpenAI.');
  assert.equal(
    accounts.snapshot().error,
    'Credentials saved, but the model catalog could not be refreshed.',
  );
  assert.equal(
    JSON.parse(await readFile(authPath, 'utf8')).openai.key,
    'saved-api-key',
  );
  assert.doesNotMatch(
    JSON.stringify(states),
    /private-refresh-credential|saved-api-key/,
  );
});

void test('cancellation, stale replies, callback races and failures preserve credentials', async t => {
  const {accounts, runtime, authPath, existing, reply} = await fixture(t);
  accounts.start('openai', 'api_key');
  await waitFor(() => Boolean(accounts.snapshot().prompt));
  const stale = accounts.snapshot();
  assert.throws(() => accounts.start('openai', 'api_key'), /Finish or cancel/);
  accounts.cancel(stale.attempt!.id);
  await waitFor(() => !accounts.snapshot().attempt);
  assert.equal(accounts.snapshot().message, 'Cancelled.');
  assert.equal(accounts.snapshot().prompt, undefined);
  assert.throws(
    () => accounts.respond(stale.attempt!.id, stale.prompt!.id, 'stale-key'),
    /ended/,
  );
  assert.deepEqual(JSON.parse(await readFile(authPath, 'utf8')), existing);

  const provider = runtime.getProvider('openai-codex')!;
  runtime.registerNativeProvider({
    ...provider,
    auth: {
      oauth: {
        ...provider.auth.oauth!,
        async login(interaction) {
          const callback = new AbortController();
          const manual = interaction.prompt({
            type: 'manual_code',
            message: 'Optional fallback code',
            signal: callback.signal,
          });
          callback.abort();
          await assert.rejects(manual);
          const secret = await interaction.prompt({
            type: 'secret',
            message: 'Secret',
          });
          throw new Error(`Provider rejected ${secret}`);
        },
      },
    },
  });
  accounts.start('openai-codex', 'oauth');
  await waitFor(() => accounts.snapshot().prompt?.type === 'secret');
  reply('secret-for-error');
  await waitFor(() => !accounts.snapshot().attempt);
  assert.match(accounts.snapshot().error!, /Provider rejected \[redacted\]/);
  assert.deepEqual(JSON.parse(await readFile(authPath, 'utf8')), existing);
  accounts.start('openai', 'api_key');
  await waitFor(() => Boolean(accounts.snapshot().prompt));
  await accounts.dispose();
  assert.equal(accounts.snapshot().prompt, undefined);
  assert.deepEqual(JSON.parse(await readFile(authPath, 'utf8')), existing);
});

void test(
  'account dialogs in Electron use the production preload and bundled SDK',
  {timeout: 60000},
  async t => {
    if (
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY
    )
      return t.skip('Electron requires a display');
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-account-ui-'));
    t.after(() =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 15,
        retryDelay: 100,
      }),
    );
    const reportPath = join(directory, 'report.json');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      VARISDEV_SETTINGS_DIR: join(directory, 'agent'),
      VARISDEV_CODING_AGENT_DIR: join(directory, 'agent'),
      PI_CODING_AGENT_DIR: join(directory, 'regular-pi'),
      VARISDEV_DATA_DIR: join(directory, 'data'),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const require = createRequire(import.meta.url);
    let failure;
    try {
      await promisify(execFileCallback)(
        require('electron') as string,
        [
          fileURLToPath(
            new URL('./fixtures/desktop-accounts.cjs', import.meta.url),
          ),
          directory,
          reportPath,
        ],
        {env, timeout: 50000},
      );
    } catch (error) {
      failure = error;
    }
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
      error?: string;
      cases: string[];
    };
    assert.ifError(report.error);
    assert.equal(report.cases.length, 7);
    assert.ifError(failure);
  },
);
