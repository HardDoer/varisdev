import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {test, type TestContext} from 'node:test';
import {
  SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import {DesktopExtensionUI} from '../src/dashboard/extension-ui.ts';
import {runAuthCommand} from '../src/dashboard/native-auth-commands.ts';
import type {SettingsCommandContext} from '../src/dashboard/settings-commands.ts';

type Runtime = AgentSession['modelRuntime'];
type Interaction = Parameters<Runtime['login']>[2];
const model = {provider: 'test', id: 'current', name: 'Current'};
const providers = [
  {
    id: 'account',
    name: 'Account Provider',
    auth: {oauth: {name: 'Account sign in', isSubscription: false}},
  },
  {
    id: 'key',
    name: 'Key Provider',
    auth: {apiKey: {name: 'API key', login() {}}},
  },
];

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await delay(5);
  assert.ok(check(), message);
}

function harness(t: TestContext) {
  const ui = new DesktopExtensionUI(() => {});
  t.after(() => ui.dispose());
  const controller = new AbortController();
  const logins: Array<{
    provider: string;
    method: string;
    interaction: Interaction;
  }> = [];
  const logouts: string[] = [];
  const refreshes: string[][] = [];
  const configurations: unknown[] = [];
  const answers: string[] = [];
  let login: (
    interaction: Interaction,
  ) => Promise<void> = async interaction => {
    answers.push(
      await interaction.prompt({type: 'text', message: 'Enter API key'}),
    );
  };
  let committed = false;
  let logoutSignal: AbortSignal | undefined;
  const session = {
    model,
    scopedModels: [],
    settingsManager: SettingsManager.inMemory(),
    modelRuntime: {
      getProviders: () => providers,
      getProvider: (id: string) =>
        providers.find(provider => provider.id === id),
      getProviderAuthStatus: () => ({configured: false}),
      isUsingOAuth: () => false,
      getAvailableSnapshot: () => [model],
      async login(provider: string, method: string, interaction: Interaction) {
        logins.push({provider, method, interaction});
        await login(interaction);
        interaction.signal?.throwIfAborted();
        committed = true;
      },
      async listCredentials() {
        return [{providerId: 'account', type: 'oauth'}];
      },
      async logout(provider: string, options: {signal: AbortSignal}) {
        logoutSignal = options.signal;
        logouts.push(provider);
      },
      async refresh(options: {providers: string[]; signal: AbortSignal}) {
        refreshes.push(options.providers);
        return {aborted: options.signal.aborted, errors: new Map()};
      },
    },
  } as unknown as AgentSession;
  const ctx: SettingsCommandContext = {
    session,
    ui,
    signal: controller.signal,
    configure: async options => {
      configurations.push(options);
    },
  };
  const output = () => ui.snapshot().dialogs[0]?.terminal?.output ?? '';
  return {
    ctx,
    ui,
    controller,
    logins,
    logouts,
    refreshes,
    configurations,
    answers,
    committed: () => committed,
    logoutSignal: () => logoutSignal,
    login: (action: typeof login) => {
      login = action;
    },
    text: async (text: string) =>
      waitFor(
        () => output().includes(text),
        `Expected native auth output: ${text}\n${output()}`,
      ),
    key: (input: string) => {
      const dialog = ui.snapshot().dialogs[0];
      assert.ok(dialog?.terminal, 'Expected an active native terminal');
      ui.respond(dialog.id, {input});
    },
  };
}

void test(
  'native login hosts Pi auth-method and provider selectors with the active session OAuth interaction',
  {timeout: 5000},
  async t => {
    const h = harness(t);
    const responses: string[] = [];
    h.login(async interaction => {
      interaction.notify({
        type: 'device_code',
        verificationUri: 'https://example.invalid/device',
        userCode: 'TEST-CODE',
      });
      responses.push(
        await interaction.prompt({
          type: 'select',
          message: 'Choose account',
          options: [
            {id: 'work', label: 'Work account'},
            {id: 'personal', label: 'Personal account'},
          ],
        }),
      );
      responses.push(
        await interaction.prompt({
          type: 'manual_code',
          message: 'Paste callback code',
        }),
      );
      interaction.notify({type: 'info', message: 'Authentication complete'});
    });
    const command = runAuthCommand('login', '', h.ctx);
    await h.text('Select authentication method');
    assert.equal(h.ui.snapshot().dialogs[0].kind, 'terminal');
    h.key('\r');
    await h.text('Select provider to configure');
    h.key('\r');
    await h.text('Choose account');
    assert.equal(h.logins[0].provider, 'account');
    assert.equal(h.logins[0].method, 'oauth');
    h.key('\r');
    await h.text('Paste callback code');
    h.key('callback-code');
    h.key('\r');
    assert.equal(await command, true);
    assert.deepEqual(responses, ['work', 'callback-code']);
    assert.equal(h.committed(), true);
    assert.deepEqual(h.refreshes, [['account']]);
    assert.deepEqual(h.configurations, [{}]);
    assert.equal(h.ui.snapshot().dialogs.length, 0);
  },
);

void test(
  'native provider login sends API key input through the session runtime and refreshes its catalog',
  {timeout: 5000},
  async t => {
    const h = harness(t);
    const command = runAuthCommand('login', 'key', h.ctx);
    await h.text('Enter API key');
    assert.equal(h.logins[0].provider, 'key');
    assert.equal(h.logins[0].method, 'api_key');
    const dialog = h.ui.snapshot().dialogs[0];
    h.ui.respond(dialog.id, {columns: 42, rows: 12});
    assert.equal(h.ui.snapshot().dialogs[0].terminal?.columns, 42);
    assert.equal(h.ui.snapshot().dialogs[0].terminal?.rows, 12);
    h.key('test-key');
    h.key('\r');
    assert.equal(await command, true);
    assert.deepEqual(h.answers, ['test-key']);
    assert.equal(h.committed(), true);
    assert.deepEqual(h.refreshes, [['key']]);
  },
);

void test(
  'native auth Escape cancels the SDK input without storing a credential',
  {timeout: 5000},
  async t => {
    const h = harness(t);
    const command = runAuthCommand('login', 'key', h.ctx);
    await h.text('Enter API key');
    h.key('\x1b');
    assert.equal(await command, true);
    assert.equal(h.logins[0].interaction.signal?.aborted, true);
    assert.equal(h.committed(), false);
    assert.deepEqual(h.refreshes, []);
    assert.equal(h.ui.snapshot().dialogs.length, 0);
  },
);

void test(
  'command cancellation closes native auth and aborts its SDK interaction',
  {timeout: 5000},
  async t => {
    const h = harness(t);
    const command = runAuthCommand('login', 'key', h.ctx);
    await h.text('Enter API key');
    h.controller.abort();
    assert.equal(await command, true);
    assert.equal(h.logins[0].interaction.signal?.aborted, true);
    assert.equal(h.committed(), false);
    assert.equal(h.ui.snapshot().dialogs.length, 0);
    assert.deepEqual(h.configurations, []);
  },
);

void test(
  'native logout lists SDK stored credentials and signs out through the active runtime',
  {timeout: 5000},
  async t => {
    const h = harness(t);
    const command = runAuthCommand('logout', '', h.ctx);
    await h.text('Select provider to logout');
    await h.text('Account Provider');
    assert.deepEqual(h.logouts, []);
    h.key('\r');
    assert.equal(await command, true);
    assert.deepEqual(h.logouts, ['account']);
    assert.ok(h.logoutSignal());
    assert.deepEqual(h.configurations, [{}]);
    assert.match(
      h.ui
        .snapshot()
        .notifications.map(item => item.message)
        .join('\n'),
      /Logged out of Account Provider/,
    );
  },
);

void test(
  'native auth preserves SDK login failures and ignores other or already aborted commands',
  {timeout: 5000},
  async t => {
    const h = harness(t);
    assert.equal(await runAuthCommand('model', '', h.ctx), false);
    await assert.rejects(
      runAuthCommand('logout', 'account', h.ctx),
      /Usage: \/logout/,
    );
    assert.equal(h.ui.snapshot().dialogs.length, 0);
    h.login(async () => {
      throw new Error('Key rejected');
    });
    assert.equal(await runAuthCommand('login', 'key', h.ctx), true);
    assert.equal(h.committed(), false);
    assert.match(
      h.ui
        .snapshot()
        .notifications.map(item => item.message)
        .join('\n'),
      /Failed to save API key for Key Provider: Key rejected/,
    );
    h.controller.abort();
    assert.equal(await runAuthCommand('login', '', h.ctx), true);
    assert.equal(h.logins.length, 1);
    assert.equal(h.ui.snapshot().dialogs.length, 0);
  },
);
