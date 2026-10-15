import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {promisify} from 'node:util';

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);

void test(
  'tool settings, first agent notice and first commit notice through the production Electron preload',
  {
    timeout: 45_000,
    skip:
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY
        ? 'Electron requires a display'
        : false,
  },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-tool-settings-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const reportPath = join(directory, 'report.json');
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    let launchError;
    try {
      await execFile(
        require('electron') as string,
        [
          fileURLToPath(
            new URL('./fixtures/tool-settings.cjs', import.meta.url),
          ),
          directory,
          reportPath,
        ],
        {env, timeout: 40_000},
      );
    } catch (error) {
      launchError = error;
    }
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
      error?: string;
      cases: string[];
    };
    assert.ifError(report.error);
    assert.ifError(launchError);
    assert.equal(report.cases.length, 8);
  },
);
