import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {
  createNativeCommandRouter,
  createNavigationReceiver,
} from '../assets/dashboard/native-commands.js';
import {nativeCommands} from '../assets/dashboard/command-catalog.js';

void test('desktop routing uses the shared targets and leaves SDK and extension commands untouched', async () => {
  const calls: unknown[] = [];
  const data = {session: {id: 'original', cwd: '/project'}, conversation: []};
  const submission = {id: 'original', draft: {value: '/new', revision: 3}};
  let cancelled = true;
  const router = createNativeCommandRouter({
    api: {
      desktopCommand: async (name: string, input: unknown) => {
        calls.push([name, input]);
        return name === 'copy' ? {ok: true} : {cancelled};
      },
    },
    accounts: async (options: unknown) => {
      calls.push(['accounts', options]);
    },
    newSession: async (target: unknown) => {
      calls.push(['new', target]);
      return true;
    },
    resume: async (cwd: string) => {
      calls.push(['resume', cwd]);
    },
    hotkeys: async () => {
      calls.push(['hotkeys']);
    },
  });
  const route = (prompt: string) => router({prompt, data, submission});
  for (const command of nativeCommands.filter(
    command => command.target === 'session',
  ))
    assert.equal(route(`/${command.name}`), undefined, command.name);
  assert.equal(route('/extension-command argument'), undefined);
  assert.equal(
    route('ordinary prompt'),
    undefined,
    'normal prompts retain synchronous routing and immediate wake timing',
  );
  assert.equal(calls.length, 0);
  assert.equal(await route('/login openai'), true);
  assert.deepEqual(calls.pop(), [
    'accounts',
    {provider: 'openai', logout: false},
  ]);
  assert.equal(await route('/logout openai-codex'), true);
  assert.deepEqual(calls.pop(), [
    'accounts',
    {provider: 'openai-codex', logout: true},
  ]);
  assert.equal(await route('/new'), true);
  assert.deepEqual(calls.pop(), ['new', submission]);
  assert.equal(await route('/resume'), true);
  assert.deepEqual(calls.pop(), ['resume', '/project']);
  assert.equal(await route('/copy'), true);
  assert.deepEqual(calls.pop(), ['copy', {sessionId: 'original'}]);
  assert.equal(await route('/hotkeys'), true);
  assert.deepEqual(calls.pop(), ['hotkeys']);
  assert.equal(
    await route('/quit'),
    false,
    'cancelled native quit preserves the draft',
  );
  cancelled = false;
  assert.equal(await route('/quit'), true);
  for (const command of ['new', 'resume', 'copy', 'hotkeys', 'quit'])
    await assert.rejects(
      async () => route(`/${command} unexpected`),
      new RegExp(`Usage: /${command}`),
    );
});

void test('navigation from an unselected origin is acknowledged before replacement creation and deduplicated', async () => {
  const calls: unknown[] = [];
  const ack = Promise.withResolvers<void>();
  const observe = createNavigationReceiver({
    api: {
      respondToDialog: async (...args: unknown[]) => {
        calls.push(['ack', ...args]);
        await ack.promise;
      },
      createSession: async (input: unknown) => {
        calls.push(['create', input]);
        return {id: 'fork'};
      },
    },
    opened: async (...args: unknown[]) => {
      calls.push(['opened', ...args]);
    },
    failed: (error: unknown) => {
      throw error;
    },
  });
  const hub = {
    selectedSessionId: 'other',
    sessions: [
      {session: {id: 'other'}},
      {
        session: {id: 'origin'},
        ui: {
          navigation: {
            id: 'nav-1',
            cwd: '/original',
            sessionId: '/sessions/fork.jsonl',
            draft: 'Recovered user message',
          },
        },
      },
    ],
  };
  const pending = observe(hub);
  await Promise.resolve();
  assert.deepEqual(calls, [['ack', 'origin', 'nav-1']]);
  void observe(hub);
  ack.resolve();
  await pending;
  assert.deepEqual(calls, [
    ['ack', 'origin', 'nav-1'],
    ['create', {cwd: '/original', sessionId: '/sessions/fork.jsonl'}],
    ['opened', 'fork', 'Recovered user message'],
  ]);
});

void test('failed prepared navigation can be retried explicitly without acknowledging twice', async () => {
  let acks = 0;
  let creates = 0;
  let retry: (() => Promise<void>) | undefined;
  const opened: unknown[] = [];
  const observe = createNavigationReceiver({
    api: {
      respondToDialog: async () => {
        acks++;
      },
      createSession: async () => {
        if (++creates === 1) throw new Error('Create failed');
        return {id: 'recovered'};
      },
    },
    opened: async (id: string) => {
      opened.push(id);
    },
    failed: (error: Error, again: () => Promise<void>) => {
      assert.equal(error.message, 'Create failed');
      retry = again;
    },
  });
  await observe({
    sessions: [
      {
        session: {id: 'origin'},
        ui: {navigation: {id: 'nav', cwd: '/project', sessionId: 'clone'}},
      },
    ],
  });
  assert.equal(acks, 1);
  assert.equal(creates, 1);
  assert.ok(retry);
  await retry();
  assert.equal(acks, 1);
  assert.equal(creates, 2);
  assert.deepEqual(opened, ['recovered']);
});

void test(
  'native slash commands, safe drafts, account confirmation and native dialogs in Electron',
  {
    timeout: 30_000,
    skip:
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY
        ? 'Electron requires a display'
        : false,
  },
  async t => {
    const directory = await mkdtemp(
      join(tmpdir(), 'varisdev-native-command-ui-'),
    );
    t.after(() => rm(directory, {recursive: true, force: true}));
    const reportPath = join(directory, 'report.json');
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    let launchError;
    try {
      await promisify(execFileCallback)(
        createRequire(import.meta.url)('electron') as string,
        [
          fileURLToPath(
            new URL('./fixtures/native-command-ui.cjs', import.meta.url),
          ),
          directory,
          reportPath,
        ],
        {env, timeout: 25_000},
      );
    } catch (error) {
      launchError = error;
    }
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
      error?: string;
      cases: string[];
    };
    assert.ifError(report.error);
    assert.ifError(launchError);
    assert.equal(report.cases.length, 7);
  },
);
