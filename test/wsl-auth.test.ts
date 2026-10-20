import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {get} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {DesktopAccounts} from '../src/desktop/accounts.ts';
import {openBrowser} from '../src/runtime/browser.mjs';
import {runAccountCommand, type CommandSDK} from '../src/runtime/commands.ts';

void test(
  'desktop Accounts and CLI Claude login complete through the WSL browser host and Pi callback',
  {timeout: 15000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-wsl-auth-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    t.after(() => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    });
    let exchanges = 0;
    t.mock.method(
      globalThis,
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        assert.equal(
          String(input),
          'https://platform.claude.com/v1/oauth/token',
        );
        const body = JSON.parse(String(init?.body));
        assert.equal(body.code, 'local-wsl-code');
        exchanges++;
        return new Response(
          JSON.stringify({
            access_token: 'wsl-access',
            refresh_token: 'wsl-refresh',
            expires_in: 3600,
          }),
          {status: 200},
        );
      },
    );
    const commands: string[] = [];
    const errors: unknown[] = [];
    const browser = (url: string) =>
      openBrowser(url, {
        platform: 'linux',
        env: {WSL_DISTRO_NAME: 'Ubuntu'},
        kernel: 'microsoft-standard-WSL2',
        run: async (command: string, args: string[]) => {
          commands.push(command);
          assert.deepEqual(args, ['url.dll,FileProtocolHandler', url]);
          const auth = new URL(url);
          assert.equal(auth.origin, 'https://claude.ai');
          const callback = new URL(auth.searchParams.get('redirect_uri')!);
          assert.equal(callback.hostname, 'localhost');
          // Use IPv4 for the local test client, matching Pi's loopback listener.
          callback.hostname = '127.0.0.1';
          callback.searchParams.set('code', 'local-wsl-code');
          callback.searchParams.set('state', auth.searchParams.get('state')!);
          try {
            await new Promise<void>((resolve, reject) => {
              const request = get(callback, {agent: false}, response => {
                response.resume();
                response.once('end', () =>
                  response.statusCode === 200
                    ? resolve()
                    : reject(
                        new Error(`Callback status ${response.statusCode}`),
                      ),
                );
              });
              request.setTimeout(2000, () =>
                request.destroy(new Error('Local callback timed out')),
              );
              request.once('error', reject);
            });
          } catch (error) {
            errors.push(error);
            throw error;
          }
        },
      });
    for (const mode of ['desktop', 'cli']) {
      const authPath = join(directory, `${mode}-auth.json`);
      await writeFile(
        authPath,
        JSON.stringify({other: {type: 'api_key', key: 'preserved'}}),
      );
      const runtime = await ModelRuntime.create({
        authPath,
        modelsPath: join(directory, 'models.json'),
        allowModelNetwork: false,
      });
      const refresh = runtime.refresh.bind(runtime);
      t.mock.method(
        runtime,
        'refresh',
        (options: Parameters<ModelRuntime['refresh']>[0]) =>
          refresh({...options, allowNetwork: false}),
      );
      if (mode === 'cli') {
        const output: string[] = [];
        await runAccountCommand('/fixture', 'login', ['anthropic'], {
          loadSDK: async () => ({getAgentDir: () => directory}) as CommandSDK,
          createGlobalModelRuntime: async () => runtime,
          openBrowser: browser,
          write: message => output.push(message),
          prompt: async (request, signal) => {
            if (request.type === 'select') return 'browser';
            return new Promise<string>((_resolve, reject) => {
              if (signal.aborted) reject(signal.reason);
              else
                signal.addEventListener('abort', () => reject(signal.reason), {
                  once: true,
                });
            });
          },
        });
        assert.match(output.join('\n'), /Signed in to Anthropic/);
      } else {
        const accounts = new DesktopAccounts({
          createRuntime: async () => runtime,
          openBrowser: browser,
          changed: state => {
            if (state.prompt?.type === 'select')
              queueMicrotask(() =>
                accounts.respond(
                  state.attempt!.id,
                  state.prompt!.id,
                  'browser',
                ),
              );
          },
        });
        t.after(() => accounts.dispose());
        accounts.start('anthropic', 'oauth');
        const deadline = Date.now() + 5000;
        while (accounts.snapshot().attempt && Date.now() < deadline)
          await delay(10);
        const state = accounts.snapshot();
        assert.equal(state.attempt, undefined, JSON.stringify(state));
        assert.equal(state.error, undefined);
        assert.match(state.message, /Signed in to Anthropic/);
      }
      const credentials = JSON.parse(await readFile(authPath, 'utf8'));
      assert.equal(credentials.anthropic.access, 'wsl-access');
      assert.deepEqual(credentials.other, {type: 'api_key', key: 'preserved'});
    }
    assert.equal(exchanges, 2);
    assert.deepEqual(commands, ['rundll32.exe', 'rundll32.exe']);
    assert.deepEqual(errors, []);
  },
);
