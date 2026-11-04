import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {runRuntimeCommand} from '../src/runtime/manager.ts';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));

void test(
  'What’s new through the production Electron preload and saved desktop preferences',
  {
    timeout: 155_000,
    skip:
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY
        ? 'Electron requires a display'
        : false,
  },
  async t => {
    const scratch = join(root, '.varisdev', 'tool-output');
    await mkdir(scratch, {recursive: true});
    const directory = await mkdtemp(join(scratch, 'whats-new-ui-'));
    t.after(() =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      }),
    );
    const reportPath = join(directory, 'report.json');
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    let launchError: unknown;
    try {
      await runRuntimeCommand(
        require('electron') as string,
        [
          fileURLToPath(new URL('./fixtures/whats-new.cjs', import.meta.url)),
          directory,
          reportPath,
        ],
        {cwd: root, env, timeoutMs: 140_000},
      );
    } catch (error) {
      launchError = error;
    }
    let report: {
      error?: string;
      activeCase?: string;
      cases: string[];
      themes: string[];
      layouts: Array<{
        theme: string;
        width: number;
        height: number;
        zoom: number;
      }>;
    };
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8')) as typeof report;
    } catch {
      throw launchError || new Error('Electron produced no What’s new report');
    }
    assert.ifError(report.error);
    if (launchError)
      throw new Error(
        `What’s new Electron run failed${report.activeCase ? ` during ${report.activeCase}` : ''}`,
        {cause: launchError},
      );
    assert.equal(
      report.cases.length,
      12,
      'All renderer scenarios must execute',
    );
    assert.ok(report.themes.includes('factory'));
    assert.ok(report.themes.includes('year1998'));
    assert.equal(report.layouts.length, report.themes.length * 5);
  },
);
