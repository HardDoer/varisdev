import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {runRuntimeCommand} from '../src/runtime/manager.ts';

const require = createRequire(import.meta.url);

void test(
  'workspace and agent context actions, keyboard controls, saved removal and rendered themes in Electron',
  {
    timeout: 125_000,
    skip:
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY
        ? 'Electron requires a display'
        : false,
  },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-item-menu-'));
    const screenshots = await mkdtemp(
      join(tmpdir(), 'varisdev-item-menu-screenshots-'),
    );
    t.after(() => rm(directory, {recursive: true, force: true}));
    t.diagnostic(`Context menu screenshots: ${screenshots}`);
    const reportPath = join(directory, 'report.json');
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    let launchError: unknown;
    try {
      await runRuntimeCommand(
        require('electron') as string,
        [
          fileURLToPath(
            new URL('./fixtures/item-context-menu.cjs', import.meta.url),
          ),
          directory,
          reportPath,
          screenshots,
        ],
        {cwd: process.cwd(), env, timeoutMs: 110_000},
      );
    } catch (error) {
      launchError = error;
    }
    const report = JSON.parse(
      await readFile(reportPath, 'utf8').catch(error => {
        throw launchError || error;
      }),
    ) as {
      error?: string;
      cases: {name: string; error?: string}[];
      themes: string[];
      screenshots: string[];
    };
    const failures = report.cases.filter(item => item.error);
    assert.ifError(report.error);
    assert.deepEqual(failures, []);
    assert.ifError(launchError);
    assert.equal(report.cases.length, 15);
    assert.ok(report.themes.length >= 10);
    assert.equal(report.screenshots.length, report.themes.length * 2 + 1);
  },
);
