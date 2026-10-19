import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {promisify} from 'node:util';

void test(
  'actual Pi SDK terminal widgets render in Electron',
  {
    timeout: 60_000,
    skip:
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY
        ? 'Electron requires a display'
        : false,
  },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-native-sdk-ui-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const reportPath = join(directory, 'report.json');
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    let launchError: unknown;
    try {
      await promisify(execFileCallback)(
        createRequire(import.meta.url)('electron') as string,
        [
          fileURLToPath(
            new URL('./fixtures/native-sdk-ui.cjs', import.meta.url),
          ),
          directory,
          reportPath,
        ],
        {env, timeout: 50_000, maxBuffer: 2 * 1024 * 1024},
      );
    } catch (error) {
      launchError = error;
    }
    let report: {error?: string; cases: string[]};
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8')) as typeof report;
    } catch {
      throw launchError || new Error('Electron produced no native SDK report');
    }
    assert.ifError(report.error);
    assert.ifError(launchError);
    assert.deepEqual(report.cases, [
      'actual stock Settings selector renders, searches, resizes and opens its submenu',
      'actual stock worker Model selector renders many models with light appearance',
      'actual stock long Fork selector remains accessible at compact zoom',
    ]);
  },
);
