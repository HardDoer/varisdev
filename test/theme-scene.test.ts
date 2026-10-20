import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {runRuntimeCommand} from '../src/runtime/manager.ts';

const require = createRequire(import.meta.url);

void test(
  'theme scene host and Year1998 renderer in real Electron',
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
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-theme-scene-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const reportPath = join(directory, 'report.json');
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    let launchError: unknown;
    try {
      await runRuntimeCommand(
        require('electron') as string,
        [
          fileURLToPath(new URL('./fixtures/theme-scene.cjs', import.meta.url)),
          directory,
          reportPath,
        ],
        {
          cwd: fileURLToPath(new URL('../', import.meta.url)),
          env,
          timeoutMs: 90_000,
        },
      );
    } catch (error) {
      launchError = error;
      if (error instanceof Error && /timed out/i.test(error.message))
        t.diagnostic(
          'Theme scene check timed out; its process tree was terminated.',
        );
    }
    let report: {
      cases: Array<{name: string; error?: string}>;
      screenshots: string[];
      fatal?: string;
    };
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8')) as typeof report;
    } catch {
      throw launchError || new Error('Electron produced no theme scene report');
    }
    assert.ifError(report.fatal);
    assert.equal(
      report.cases.length,
      13,
      'All host and renderer scenarios execute',
    );
    for (const result of report.cases)
      await t.test(result.name, () => assert.ifError(result.error));
    assert.equal(report.screenshots.length, 5);
    for (const path of report.screenshots) {
      assert.ok(
        (await stat(path)).size > 1000,
        'Scene screenshot contains rendered content',
      );
      t.diagnostic(path);
    }
    assert.ifError(launchError);
  },
);
