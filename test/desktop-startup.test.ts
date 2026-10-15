import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {registerDesktopStartup} from '../src/desktop/startup.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
// Point this at a fresh production install to exercise Git package deployment.
const packageRoot = resolve(process.env.PI_TEST_PACKAGE_DIR ?? root);

void test('desktop startup exits only after transfer succeeds, skips headless sessions and retains the terminal after failure', async () => {
  const handlers = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => Promise<void>
  >();
  let exits = 0;
  let launches = 0;
  let release = () => {};
  let failure = false;
  const notifications: string[] = [];
  const session = SessionManager.inMemory(root);
  const pi = {
    on: (
      name: string,
      handler: (event: unknown, ctx: ExtensionContext) => Promise<void>,
    ) => handlers.set(name, handler),
    getThinkingLevel: () => 'high',
    getActiveTools: () => ['read'],
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: 'tui',
    cwd: root,
    sessionManager: session,
    shutdown: () => {
      exits++;
    },
    ui: {notify: (message: string) => notifications.push(message)},
  } as unknown as ExtensionContext;
  registerDesktopStartup(
    pi,
    async (startup, signal) => {
      launches++;
      assert.equal(startup.cwd, root);
      assert.deepEqual(startup.tools, ['read']);
      assert.equal(signal.aborted, false);
      if (failure) throw new Error('fixture launch failure');
      await new Promise<void>(resolve => {
        release = resolve;
      });
    },
    async () => {},
  );
  for (const mode of ['rpc', 'print', 'json'] as const)
    await handlers.get('session_start')!({}, {...ctx, mode});
  assert.equal(launches, 0);
  const started = handlers.get('session_start')!({}, ctx);
  assert.equal(launches, 1);
  assert.equal(exits, 0);
  release();
  await started;
  assert.equal(exits, 1);
  failure = true;
  await handlers.get('session_start')!({}, ctx);
  assert.equal(exits, 1);
  assert.match(notifications.at(-1)!, /fixture launch failure/);
});

void test(
  'bundled Pi startup from another project transfers its resumed session and CLI prompts to Electron, then exits while the GUI remains alive',
  {
    timeout: 120_000,
    skip:
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY
        ? 'Electron requires a display'
        : false,
  },
  async t => {
    const tempRoot = join(root, '.pi/tmp');
    await mkdir(tempRoot, {recursive: true});
    const directory = await mkdtemp(join(tempRoot, 'desktop-startup-'));
    const cwd = join(directory, 'project');
    const agentDir = join(directory, 'agent');
    const report = join(directory, 'report.json');
    const close = join(directory, 'close');
    let desktopPid: number | undefined;
    const source = SessionManager.inMemory(cwd);
    source.appendMessage({
      role: 'user',
      content: 'A conversation already in progress.',
      timestamp: Date.now(),
    });
    source.appendMessage({
      role: 'assistant',
      content: [{type: 'text', text: 'Previous response.'}],
      api: 'openai-completions',
      provider: 'startup-test',
      model: 'model',
      stopReason: 'stop',
      timestamp: Date.now(),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
      },
    });
    source.appendModelChange('startup-test', 'model');
    source.appendSessionInfo('Resumed GUI conversation');
    source.appendCustomEntry('startup-marker', {from: 'terminal'});
    const sessionFile = join(directory, 'session.jsonl');
    await Promise.all([
      mkdir(cwd, {recursive: true}),
      mkdir(agentDir, {recursive: true}),
    ]);
    await writeFile(
      sessionFile,
      [source.getHeader(), ...source.getEntries()]
        .map(value => JSON.stringify(value))
        .join('\n') + '\n',
    );
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({
        packages: [packageRoot],
        defaultProvider: 'startup-test',
        defaultModel: 'model',
        quietStartup: true,
        checkForUpdates: false,
      }),
    );
    await writeFile(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          'startup-test': {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:1',
            apiKey: 'fixture',
            models: [
              {
                id: 'model',
                name: 'Startup model',
                reasoning: true,
                input: ['text'],
                contextWindow: 128000,
                maxTokens: 1000,
              },
            ],
          },
        },
      }),
    );
    const extension = join(directory, 'probe.ts');
    await writeFile(
      extension,
      `
import {existsSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require = createRequire(${JSON.stringify(join(packageRoot, 'package.json'))});
export default function(pi) {
  const commands = [];
  let timer;
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode === 'tui') return;
    const {app, BrowserWindow} = require('electron');
    writeFileSync(${JSON.stringify(join(directory, 'desktop.pid'))}, String(process.pid));
    timer = setInterval(async () => {
      if (existsSync(${JSON.stringify(close)})) { clearInterval(timer); app.quit(); return; }
      if (commands.length !== 2) return;
      try {
        const window = BrowserWindow.getAllWindows()[0];
        const state = await window.webContents.executeJavaScript('window.pidev.getState()');
        writeFileSync(${JSON.stringify(report)}, JSON.stringify({pid: process.pid, commands, state}));
      } catch (error) { writeFileSync(${JSON.stringify(report)}, JSON.stringify({error: String(error)})); }
    }, 100);
  });
  pi.on('session_shutdown', () => clearInterval(timer));
  pi.registerCommand('startup-probe', {handler: async (args, ctx) => {
    commands.push({args, mode: ctx.mode, cwd: ctx.cwd, id: ctx.sessionManager.getSessionId(), model: ctx.model.id, thinking: pi.getThinkingLevel(), entries: ctx.sessionManager.getEntries()});
  }});
}
`,
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      VARISDEV_SETTINGS_DIR: agentDir,
      VARISDEV_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_DIR: agentDir,
      PI_TEST_CLI: pathToFileURL(
        join(
          packageRoot,
          'desktop/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
        ),
      ).href,
      PI_OFFLINE: '1',
      PIDEV_DESKTOP_DATA_DIR: join(directory, 'profile'),
      TMP: directory,
      TEMP: directory,
      JITI_FS_CACHE: 'false',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      process.execPath,
      [
        join(root, 'test/fixtures/desktop-cli.mjs'),
        '--offline',
        '--session',
        sessionFile,
        '--model',
        'startup-test/model',
        '--thinking',
        'high',
        '--extension',
        extension,
        '/startup-probe first',
        '/startup-probe second',
      ],
      {cwd, env, stdio: ['pipe', 'pipe', 'pipe']},
    );
    let output = '';
    child.stdout.on('data', data => {
      output = (output + String(data)).slice(-16000);
    });
    child.stderr.on('data', data => {
      output = (output + String(data)).slice(-16000);
    });
    let exited = false;
    let exitCode: number | null = null;
    child.on('exit', code => {
      exited = true;
      exitCode = code;
    });
    t.after(async () => {
      child.kill();
      await writeFile(close, 'close');
      if (!desktopPid) {
        try {
          desktopPid = Number(
            await readFile(join(directory, 'desktop.pid'), 'utf8'),
          );
        } catch {
          /* No desktop started. */
        }
      }
      if (desktopPid) {
        for (let count = 0; count < 50; count++) {
          try {
            process.kill(desktopPid, 0);
          } catch {
            break;
          }
          await delay(100);
        }
        try {
          process.kill(desktopPid);
        } catch {
          /* Already closed. */
        }
      }
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
    });
    const deadline = Date.now() + 100_000;
    let result:
      | {
          error?: string;
          pid: number;
          commands: Array<{
            args: string;
            mode: string;
            id: string;
            thinking: string;
            entries: Array<{type: string; customType?: string}>;
          }>;
          state: {
            sessions: Array<{
              session: {
                id: string;
                owned: boolean;
                controllable: boolean;
                name: string;
              };
              conversation: Array<{text: string}>;
            }>;
          };
        }
      | undefined;
    while (Date.now() < deadline) {
      try {
        result = JSON.parse(await readFile(report, 'utf8')) as typeof result;
      } catch {
        /* Still starting. */
      }
      if ((result && exited) || output.includes('Could not open VarisDev'))
        break;
      await delay(100);
    }
    assert.doesNotMatch(output, /Host-provided extension packages/);
    const startupLog = await readFile(
      join(directory, 'profile/startup.log'),
      'utf8',
    ).catch(() => 'No startup log.');
    assert.ok(
      result,
      `No desktop report. Desktop log:\n${startupLog}\nCLI output:\n${output}`,
    );
    assert.ifError(result.error);
    desktopPid = result.pid;
    assert.equal(exited, true, `The terminal did not exit:\n${output}`);
    assert.equal(exitCode, 0, output);
    assert.notEqual(desktopPid, child.pid);
    process.kill(desktopPid, 0);
    assert.deepEqual(
      result.commands.map(command => command.args),
      ['first', 'second'],
    );
    for (const command of result.commands) {
      assert.equal(command.mode, 'rpc');
      assert.equal(command.id, source.getSessionId());
      assert.equal(command.thinking, 'high');
      assert.ok(
        command.entries.some(
          entry =>
            entry.type === 'custom' && entry.customType === 'startup-marker',
        ),
      );
    }
    assert.equal(result.state.sessions.length, 1);
    const transferred = result.state.sessions[0];
    assert.equal(transferred.session.owned, true);
    assert.equal(transferred.session.controllable, true);
    assert.equal(transferred.session.name, 'Resumed GUI conversation');
    assert.ok(
      transferred.conversation.some(message =>
        message.text.includes('Previous response.'),
      ),
    );
  },
);
