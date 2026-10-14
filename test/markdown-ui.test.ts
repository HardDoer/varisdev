import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);

void test(
  'Markdown editor and pinned tasklists in Electron',
  {
    timeout: 60_000,
    skip:
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY
        ? 'Electron requires a Linux display (run with xvfb-run)'
        : false,
  },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-markdown-ui-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const reportPath = join(directory, 'report.json');
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    let launchError: unknown;
    try {
      await execFile(
        require('electron') as string,
        [
          fileURLToPath(new URL('./fixtures/markdown-ui.cjs', import.meta.url)),
          directory,
          reportPath,
        ],
        {env, timeout: 45_000, maxBuffer: 2 * 1024 * 1024},
      );
    } catch (error) {
      launchError = error;
    }
    let report: {cases: Array<{name: string; error?: string}>; fatal?: string};
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8')) as typeof report;
    } catch {
      throw launchError || new Error('Electron produced no Markdown UI report');
    }
    assert.ifError(report.fatal);
    assert.equal(
      report.cases.length,
      16,
      'All Markdown scenarios must execute',
    );
    for (const result of report.cases) {
      await t.test(result.name, () => assert.ifError(result.error));
    }
    assert.ifError(launchError);
  },
);
