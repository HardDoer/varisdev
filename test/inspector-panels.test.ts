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
  'inspector tab dragging, detached live panels, saved layout and compact theme drawers in Electron',
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
    const directory = await mkdtemp(
      join(tmpdir(), 'varisdev-inspector-panels-'),
    );
    const screenshots = await mkdtemp(
      join(tmpdir(), 'varisdev-inspector-themes-'),
    );
    t.after(() => rm(directory, {recursive: true, force: true}));
    t.diagnostic(`Inspector panel screenshots: ${screenshots}`);
    const reportPath = join(directory, 'report.json');
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    let launchError: unknown;
    try {
      await runRuntimeCommand(
        require('electron') as string,
        [
          fileURLToPath(
            new URL('./fixtures/inspector-panels.cjs', import.meta.url),
          ),
          directory,
          reportPath,
          screenshots,
        ],
        {cwd: process.cwd(), env, timeoutMs: 100_000},
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
    assert.ifError(report.error);
    assert.deepEqual(
      report.cases.filter(item => item.error),
      [],
    );
    assert.ifError(launchError);
    assert.equal(report.cases.length, 12);
    assert.equal(report.themes.length, 13);
    assert.equal(report.screenshots.length, report.themes.length * 3);
  },
);
