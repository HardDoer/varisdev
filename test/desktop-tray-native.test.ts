import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {runRuntimeCommand} from '../src/runtime/manager.ts';

const require = createRequire(import.meta.url);

void test(
  'native Electron tray integrates with desktop close, restore, status and quit',
  {
    timeout: 45_000,
    skip:
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY
        ? 'Electron requires a Linux display (run with xvfb-run)'
        : false,
  },
  async t => {
    const temporaryRoot = join(process.cwd(), '.varisdev', 'tmp');
    await mkdir(temporaryRoot, {recursive: true});
    const directory = await mkdtemp(join(temporaryRoot, 'desktop-tray-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const reportPath = join(directory, 'report.json');
    const modulePath = join(directory, 'tray.mjs');
    const source = await readFile(
      new URL('../src/desktop/tray.ts', import.meta.url),
      'utf8',
    );
    await writeFile(
      modulePath,
      ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
        },
      }).outputText,
    );
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    let launchError: unknown;
    try {
      await runRuntimeCommand(
        require('electron') as string,
        [
          fileURLToPath(
            new URL('./fixtures/desktop-tray.cjs', import.meta.url),
          ),
          directory,
          reportPath,
          modulePath,
        ],
        {cwd: process.cwd(), env, timeoutMs: 30_000},
      );
    } catch (error) {
      launchError = error;
    }
    let report: {cases: string[]; fatal?: string};
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8')) as typeof report;
    } catch {
      throw launchError || new Error('Electron produced no tray test report');
    }
    assert.ifError(report.fatal);
    assert.ifError(launchError);
    assert.equal(report.cases.length, 4);
  },
);
