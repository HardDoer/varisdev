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
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
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
    states,
    opened,
    authPath,
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
    const {accounts, states, authPath, existing, cwd, reply, parents} =
      await fixture(t);
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
    const unselected = await createDashboardParent({cwd});
    parents.push(unselected);
    assert.equal((await unselected.features()).model, undefined);
    await assert.rejects(
      unselected.prompt('Do not pick a model for me'),
      /Choose a model/,
    );
    await parent.configure({provider: 'openai', modelId: 'account-model'});
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
  const {accounts, runtime, opened, reply, authPath, states} = await fixture(t);
  const original = runtime.getProvider('openai-codex')!;
  runtime.registerNativeProvider({
    ...original,
    auth: {
      oauth: {
        ...original.auth.oauth!,
        async login(interaction) {
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
  assert.deepEqual(opened, [
    'https://provider.invalid/authorize',
    'https://provider.invalid/device',
  ]);
  await accounts.openLink(accounts.snapshot().attempt!.id, 0);
  assert.equal(opened.length, 3);
  reply('private-code');
  await waitFor(() => !accounts.snapshot().attempt);
  assert.equal(accounts.snapshot().error, undefined);
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
      PI_CODING_AGENT_DIR: join(directory, 'agent'),
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
    assert.equal(report.cases.length, 6);
    assert.ifError(failure);
  },
);
