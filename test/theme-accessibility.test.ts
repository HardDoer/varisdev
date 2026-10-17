import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {THEMES} from '../assets/dashboard/themes.js';

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);

interface ThemeResult {
  id: string;
  name: string;
  error?: string;
  fingerprint?: string;
}

interface ThemeReport {
  fatal?: string;
  rendererErrors: string[];
  themes: ThemeResult[];
}

void test(
  'all shipped themes render accessible states, robots, effects, and review previews',
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
    const directory = await mkdtemp(
      join(tmpdir(), 'varisdev-theme-accessibility-'),
    );
    t.after(() => rm(directory, {recursive: true, force: true}));
    const reportPath = join(directory, 'report.json');
    const screenshotDirectory = fileURLToPath(
      new URL('../.pi/tmp/theme-accessibility/', import.meta.url),
    );
    await rm(screenshotDirectory, {recursive: true, force: true});
    await mkdir(screenshotDirectory, {recursive: true});

    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    let launchError: unknown;
    try {
      await execFile(
        require('electron') as string,
        [
          fileURLToPath(
            new URL('./fixtures/theme-accessibility.cjs', import.meta.url),
          ),
          directory,
          reportPath,
          screenshotDirectory,
        ],
        {env, timeout: 110_000, maxBuffer: 2 * 1024 * 1024},
      );
    } catch (error) {
      launchError = error;
    }

    let report: ThemeReport;
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8')) as ThemeReport;
    } catch {
      throw launchError || new Error('Electron produced no theme audit report');
    }
    assert.ifError(report.fatal);
    assert.deepEqual(
      report.themes.map(theme => theme.id),
      THEMES.map(theme => theme.id),
      'The renderer audit must visit every shipped theme in catalog order',
    );
    for (const result of report.themes)
      await t.test(`${result.name} rendered accessibility`, () =>
        assert.ifError(result.error),
      );

    assert.deepEqual(report.rendererErrors, [], 'Renderer console errors');
    assert.equal(
      new Set(report.themes.map(theme => theme.fingerprint)).size,
      THEMES.length,
      'Every shipped theme must expose a distinct rendered palette',
    );
    assert.ifError(launchError);
  },
);
