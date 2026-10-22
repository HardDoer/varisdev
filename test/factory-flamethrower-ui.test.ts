import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {runRuntimeCommand} from '../src/runtime/manager.ts';
import {THEMES} from '../assets/dashboard/themes.js';

const require = createRequire(import.meta.url);

interface FlamethrowerReport {
  cases: Array<{name: string; error?: string}>;
  themes: string[];
  screenshots: Array<{
    path: string;
    renderer: string;
    theme: string;
    compact?: boolean;
    zoom?: number;
    environment?: boolean;
  }>;
  fatal?: string;
}

void test(
  'factory flamethrower in real Electron factory, Year1998 and SVG scenes',
  {
    timeout: 150_000,
    skip:
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY
        ? 'Electron requires a Linux display (run with xvfb-run)'
        : false,
  },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-factory-flame-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const reportPath = join(directory, 'report.json');
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    let launchError: unknown;
    try {
      await runRuntimeCommand(
        require('electron') as string,
        [
          fileURLToPath(
            new URL('./fixtures/factory-flamethrower.cjs', import.meta.url),
          ),
          directory,
          reportPath,
        ],
        {
          cwd: fileURLToPath(new URL('../', import.meta.url)),
          env,
          timeoutMs: 130_000,
        },
      );
    } catch (error) {
      launchError = error;
      if (error instanceof Error && /timed out/i.test(error.message))
        t.diagnostic(
          'Flamethrower Electron check timed out; its process tree was terminated.',
        );
    }
    let report: FlamethrowerReport;
    try {
      report = JSON.parse(
        await readFile(reportPath, 'utf8'),
      ) as FlamethrowerReport;
    } catch {
      throw (
        launchError || new Error('Electron produced no flamethrower report')
      );
    }
    assert.ifError(report.fatal);
    assert.equal(
      report.cases.length,
      65,
      'Every flamethrower and environment scenario must run',
    );
    for (const result of report.cases)
      await t.test(result.name, () => assert.ifError(result.error));
    assert.deepEqual(
      report.themes,
      THEMES.map(theme => theme.id),
    );
    for (const theme of report.themes) {
      for (const renderer of ['webgl', 'fallback']) {
        assert.ok(
          report.screenshots.some(
            item => item.theme === theme && item.renderer === renderer,
          ),
          `${theme}/${renderer}: burning scene screenshot required`,
        );
        assert.ok(
          report.screenshots.some(
            item =>
              item.theme === theme &&
              item.renderer === renderer &&
              item.environment,
          ),
          `${theme}/${renderer}: environmental fire, damage and repair screenshot required`,
        );
      }
    }
    assert.ok(
      report.screenshots.some(
        item => item.theme === 'year1998' && item.renderer === 'year1998',
      ),
      'Actual Year1998 renderer screenshot required',
    );
    for (const renderer of ['webgl', 'fallback', 'year1998']) {
      for (const zoom of [0.8, 1, 1.5, 2])
        assert.ok(
          report.screenshots.some(
            item =>
              item.renderer === renderer && item.compact && item.zoom === zoom,
          ),
          `${renderer}/${zoom}: compact screenshot required`,
        );
    }
    for (const screenshot of report.screenshots)
      assert.ok((await stat(screenshot.path)).size > 0);
    t.diagnostic('Flamethrower screenshots: .pi/tmp/factory-flamethrower');
    assert.ifError(launchError);
  },
);
