import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {cp, mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';

// Exercise Pi's bundled CLI and its extension loader; native TS imports in the
// other tests do not use the same dependency resolution as an installed plugin.
const cli =
  process.env.PI_TEST_CLI ??
  fileURLToPath(
    new URL(
      './bundle/cli.js',
      import.meta.resolve('@earendil-works/pi-coding-agent'),
    ),
  );
const hostModules = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-tui',
  'typebox',
];

for (const missingSharp of [false, true]) {
  void test(
    `bundled Pi starts VarisDev without local Pi packages${missingSharp ? ' or Sharp' : ''}`,
    {timeout: 30_000},
    async t => {
      const directory = await mkdtemp(join(process.cwd(), '.startup-test-'));
      await Promise.all(
        ['src', 'extensions'].map(name =>
          cp(resolve(name), join(directory, name), {recursive: true}),
        ),
      );
      await writeFile(join(directory, 'package.json'), '{"type":"module"}');
      // The terminal extension uses Pi's virtual modules even though the
      // separate Electron process needs these packages installed on disk.
      for (const name of hostModules) {
        const peerDir = join(directory, 'node_modules', name);
        await mkdir(peerDir, {recursive: true});
        await writeFile(
          join(peerDir, 'package.json'),
          JSON.stringify({name, exports: './unavailable.js'}),
        );
      }
      const extension = join(directory, 'extensions', 'varisdev.ts');
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
          '--mode',
          'rpc',
          '--no-session',
          '--no-extensions',
          '--no-skills',
          '--no-prompt-templates',
          '--no-themes',
          '-e',
          extension,
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: agentDir,
            TMP: tempDir,
            TEMP: tempDir,
            JITI_FS_CACHE: 'false',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', chunk => {
        stderr += chunk;
      });
      const closed = new Promise<void>(resolve => {
        child.once('close', () => resolve());
      });
      const lines = createInterface({input: child.stdout});
      t.after(async () => {
        child.kill();
        await closed;
        lines.close();
        await rm(directory, {recursive: true, force: true});
      });
      const response = new Promise<{
        success: boolean;
        data: {commands: {name: string}[]};
      }>((resolve, reject) => {
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
      const result = await response;
      assert.equal(result.success, true);
      const commands = result.data.commands.map(command => command.name);
      for (const name of [
        'varisdev',
        'images',
        'agents',
        'commit',
        'factory',
      ]) {
        assert.ok(commands.includes(name), `Missing /${name}: ${stderr}`);
      }
      for (const name of [
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
