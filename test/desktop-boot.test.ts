import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {runRuntimeCommand} from '../src/runtime/manager.ts';

const require = createRequire(import.meta.url);

void test(
  'the production overview restores plugin themes before loading a workspace',
  {
    timeout: 60000,
    skip:
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY
        ? 'Electron requires a display'
        : false,
  },
  async t => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const temporaryRoot = join(root, '.varisdev/tool-output');
    await mkdir(temporaryRoot, {recursive: true});
    const directory = await mkdtemp(join(temporaryRoot, 'desktop-boot-'));
    t.after(() =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      }),
    );
    const agentDir = join(directory, 'agent');
    const plugin = join(directory, 'theme');
    await Promise.all(
      [agentDir, plugin, join(directory, 'project', '.git')].map(path =>
        mkdir(path, {recursive: true}),
      ),
    );
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({
        packages: [plugin],
        defaultProvider: 'boot-fixture',
        defaultModel: 'offline',
        checkForUpdates: false,
      }),
    );
    await writeFile(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          'boot-fixture': {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:1',
            apiKey: 'fixture',
            models: [
              {
                id: 'offline',
                name: 'Offline fixture',
                contextWindow: 32000,
                maxTokens: 1000,
              },
            ],
          },
        },
      }),
    );
    await writeFile(
      join(plugin, 'package.json'),
      JSON.stringify({
        name: 'boot-theme',
        varisdev: {themes: ['./theme.json']},
      }),
    );
    await writeFile(
      join(plugin, 'theme.json'),
      JSON.stringify({id: 'boot', name: 'Boot theme', base: 'factory'}),
    );
    const reportPath = join(directory, 'report.json');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      VARISDEV_SETTINGS_DIR: agentDir,
      VARISDEV_DATA_DIR: join(directory, 'data'),
      PIDEV_DESKTOP_DATA_DIR: join(directory, 'profile'),
      LOCALAPPDATA: directory,
      XDG_CONFIG_HOME: directory,
      PI_OFFLINE: '1',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    let launchError: unknown;
    try {
      await runRuntimeCommand(
        require('electron') as string,
        [join(root, 'test/fixtures/desktop-boot.cjs'), directory, reportPath],
        {cwd: root, env, timeoutMs: 45000},
      );
    } catch (error) {
      launchError = error;
    }
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
      cases: string[];
      stage?: string;
      fatal?: string;
    };
    assert.ifError(report.fatal);
    if (launchError)
      throw new Error(`Desktop boot failed during ${report.stage}`, {
        cause: launchError,
      });
    assert.equal(report.cases.length, 2);
  },
);
