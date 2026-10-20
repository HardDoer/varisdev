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

interface GunReport {
  cases: Array<{name: string; error?: string}>;
  themes: string[];
  screenshots: Array<{
    path: string;
    renderer: string;
    theme?: string;
    compact?: boolean;
    zoom?: number;
  }>;
  fatal?: string;
}

void test(
  'factory gun in real Electron WebGL and SVG scenes',
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
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-factory-gun-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const reportPath = join(directory, 'report.json');
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    let launchError: unknown;
    try {
      await runRuntimeCommand(
        require('electron') as string,
        [
          fileURLToPath(new URL('./fixtures/factory-gun.cjs', import.meta.url)),
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
      if (error instanceof Error && /timed out/i.test(error.message))
        t.diagnostic(
          'Factory gun Electron check timed out; its process tree was terminated.',
        );
    }
    let report: GunReport;
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8')) as GunReport;
    } catch {
      throw launchError || new Error('Electron produced no factory gun report');
    }
    assert.ifError(report.fatal);
    assert.equal(report.cases.length, 14, 'Every gun scenario must execute');
    for (const result of report.cases) {
      await t.test(result.name, () => assert.ifError(result.error));
    }
    assert.deepEqual(
      report.themes,
      THEMES.map(theme => theme.id),
    );
    for (const theme of report.themes) {
      for (const renderer of ['webgl', 'fallback']) {
        const screenshot = report.screenshots.find(
          item => item.theme === theme && item.renderer === renderer,
        );
        assert.ok(screenshot, `${theme}/${renderer}: shot screenshot required`);
        assert.ok((await stat(screenshot.path)).size > 0);
      }
    }
    assert.equal(
      report.screenshots.filter(item => item.compact).length,
      6,
      'Compact screenshots cover both renderers at each zoom',
    );
    t.diagnostic('Gun screenshots: .pi/tmp/factory-gun');
    assert.ifError(launchError);
  },
);
