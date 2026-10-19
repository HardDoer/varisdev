import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {
  access,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {createInterface} from 'node:readline';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {runRuntimeCommand} from '../src/runtime/manager.ts';

// Exercise the private runtime's extension loader with source installed outside
// the checkout, where its development dependencies cannot satisfy imports.
const root = fileURLToPath(new URL('../', import.meta.url));
const cli =
  process.env.PI_TEST_CLI ??
  join(
    root,
    'desktop/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
  );
const hostModules = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-tui',
  'typebox',
];

for (const {missingSharp, unavailablePeers} of [
  {missingSharp: false, unavailablePeers: false},
  {missingSharp: true, unavailablePeers: false},
  {missingSharp: false, unavailablePeers: true},
]) {
  void test(
    `bundled Pi starts external VarisDev ${unavailablePeers ? 'with unavailable local Pi packages' : `without local Pi packages${missingSharp ? ' or Sharp' : ''}`}`,
    {timeout: 30_000},
    async t => {
      const directory = await mkdtemp(join(tmpdir(), 'varisdev-startup-'));
      let stopChild = async () => {};
      t.after(async () => {
        await stopChild();
        await rm(directory, {recursive: true, force: true, maxRetries: 5});
      });
      await Promise.all(
        ['src', 'extensions', 'assets'].map(name =>
          cp(join(root, name), join(directory, name), {recursive: true}),
        ),
      );
      await writeFile(
        join(directory, 'package.json'),
        JSON.stringify({name: 'varisdev', type: 'module'}),
      );
      const {dependencies} = JSON.parse(
        await readFile(join(root, 'package.json'), 'utf8'),
      ) as {dependencies: Record<string, string>};
      // Share production dependencies without exposing the checkout's Pi peers.
      for (const name of Object.keys(dependencies)) {
        if (missingSharp && name === 'sharp') continue;
        const target = join(directory, 'node_modules', name);
        await mkdir(dirname(target), {recursive: true});
        await symlink(join(root, 'node_modules', name), target, 'junction');
      }
      for (const name of hostModules) {
        const peerDir = join(directory, 'node_modules', name);
        await assert.rejects(access(peerDir), {code: 'ENOENT'});
        if (!unavailablePeers) continue;
        await mkdir(peerDir, {recursive: true});
        await writeFile(
          join(peerDir, 'package.json'),
          JSON.stringify({name, exports: './unavailable.js'}),
        );
      }
      const extension = join(directory, 'extensions', 'varisdev.ts');
      const promptFile = join(directory, 'prompt.txt');
      const probe = join(directory, 'prompt-probe.ts');
      await writeFile(promptFile, 'Startup file content.');
      await writeFile(
        probe,
        `import assert from 'node:assert/strict';
import {desktopInitialPrompts} from ${JSON.stringify(pathToFileURL(join(directory, 'src/dashboard/startup.ts')).href)};
export default async function () {
  const prompts = await desktopInitialPrompts(${JSON.stringify([`@${promptFile}`, 'Inspect the file.'])}, false);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].text.includes('Startup file content.'));
  assert.ok(prompts[0].text.endsWith('Inspect the file.'));
}
`,
      );
      const agentDir = join(directory, 'agent');
      const tempDir = join(directory, 'tmp');
      await mkdir(agentDir);
      await mkdir(tempDir);
      const nodeArgs: string[] = [];
      if (missingSharp) {
        const hook = join(directory, 'missing-sharp.mjs');
        await writeFile(
          hook,
          `import {registerHooks} from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sharp' || specifier.startsWith('@img/sharp') ||
        specifier.replaceAll('\\\\', '/').includes('/node_modules/sharp/')) {
      throw new Error('Sharp intentionally unavailable in startup test');
    }
    return next(specifier, context);
  }
});
`,
        );
        nodeArgs.push('--import', pathToFileURL(hook).href);
      }
      const child = spawn(
        process.execPath,
        [
          ...nodeArgs,
          cli,
          '--offline',
          '--mode',
          'rpc',
          '--no-session',
          '--no-extensions',
          '--no-skills',
          '--no-prompt-templates',
          '--no-themes',
          '-e',
          extension,
          '-e',
          probe,
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            VARISDEV_SETTINGS_DIR: agentDir,
            VARISDEV_CODING_AGENT_DIR: agentDir,
            PI_CODING_AGENT_DIR: agentDir,
            TMP: tempDir,
            TEMP: tempDir,
            JITI_FS_CACHE: 'false',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        },
      );
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', chunk => {
        stderr += chunk;
      });
      let hasClosed = false;
      const closed = new Promise<void>(resolve => {
        child.once('close', () => {
          hasClosed = true;
          resolve();
        });
      });
      const lines = createInterface({input: child.stdout});
      let timer: NodeJS.Timeout | undefined;
      let stopping: Promise<void> | undefined;
      stopChild = () =>
        (stopping ??= (async () => {
          clearTimeout(timer);
          if (!hasClosed && child.pid) {
            if (process.platform === 'win32') {
              await runRuntimeCommand(
                'taskkill',
                ['/pid', String(child.pid), '/T', '/F'],
                {cwd: root, env: process.env, timeoutMs: 5000},
              ).catch(error => {
                if (!hasClosed) throw error;
              });
            } else {
              try {
                process.kill(-child.pid, 'SIGKILL');
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
                  throw error;
              }
            }
          }
          await closed;
          lines.close();
        })());
      const response = new Promise<{
        success: boolean;
        data: {commands: {name: string}[]};
      }>((resolve, reject) => {
        timer = setTimeout(() => {
          void stopChild().then(
            () => reject(new Error(`Pi startup timed out: ${stderr}`)),
            reject,
          );
        }, 20_000);
        child.once('error', reject);
        child.once('close', code => {
          reject(new Error(`Pi exited (${code}): ${stderr}`));
        });
        lines.on('line', line => {
          try {
            const message = JSON.parse(line);
            if (message.id === 'startup') resolve(message);
          } catch (error) {
            reject(error);
          }
        });
      });
      child.stdin.write(
        JSON.stringify({id: 'startup', type: 'get_commands'}) + '\n',
      );
      const result = await response.finally(() => clearTimeout(timer));
      assert.equal(result.success, true);
      const commands = result.data.commands.map(command => command.name);
      for (const name of ['agents', 'commit', 'factory']) {
        assert.ok(commands.includes(name), `Missing /${name}: ${stderr}`);
      }
      for (const name of [
        'images',
        'handover',
        'auto-handover',
        'auto-session-refresh',
        'varisdev-handover-switch',
        'varisdev-handover-resume',
      ]) {
        assert.ok(!commands.includes(name), `Unexpected /${name}`);
      }
      assert.equal(stderr, '');
    },
  );
}
