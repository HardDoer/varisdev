import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {runRuntimeCommand} from '../src/runtime/manager.ts';

const require = createRequire(import.meta.url);

void test(
  'real Electron dashboard interactions',
  {
    timeout: 120_000,
    skip:
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY
        ? 'Electron requires a Linux display (run with xvfb-run)'
        : false,
  },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-desktop-ui-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const reportPath = join(directory, 'report.json');
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    let launchError: unknown;
    try {
      await runRuntimeCommand(
        require('electron') as string,
        [
          fileURLToPath(new URL('./fixtures/desktop-ui.cjs', import.meta.url)),
          directory,
          reportPath,
        ],
        {
          cwd: fileURLToPath(new URL('../', import.meta.url)),
          env,
          timeoutMs: 100_000,
        },
      );
    } catch (error) {
      launchError = error;
    }
    let report: {
      cases: Array<{name: string; error?: string}>;
      fatal?: string;
      activeCase?: string;
      operation?: string;
    };
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8')) as typeof report;
    } catch {
      throw launchError || new Error('Electron produced no UI test report');
    }
    for (const result of report.cases) {
      await t.test(result.name, () => assert.ifError(result.error));
    }
    assert.ifError(report.fatal);
    if (launchError)
      throw new Error(
        `Electron UI run failed${report.activeCase ? ` during ${report.activeCase}` : ''}${report.operation ? ` (${report.operation})` : ''}`,
        {cause: launchError},
      );
    assert.equal(
      process.env.DESKTOP_UI_CASE_PATTERN
        ? report.cases.length > 0
        : report.cases.length,
      process.env.DESKTOP_UI_CASE_PATTERN ? true : 58,
      'All renderer scenarios must execute',
    );
  },
);
