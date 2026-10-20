import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {DesktopTerminals} from '../src/desktop/terminal.ts';
import {runTerminalProcess} from './fixtures/terminal-process.mjs';

async function windowsTerminalEnvironment(
  directory: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  // Desktop launches can inherit a PATH without the Windows shell directories
  // and PowerShell 7 modules that Windows PowerShell cannot import.
  const modules = join(directory, 'modules');
  await mkdir(join(modules, 'PSReadLine'), {recursive: true});
  await writeFile(
    join(modules, 'PSReadLine', 'PSReadLine.psd1'),
    "@{ ModuleVersion = '99.0'; PowerShellVersion = '99.0'; GUID = 'b0372f07-b2a1-4076-9725-89a858e21dde' }",
  );
  for (const key of Object.keys(env))
    if (['path', 'psmodulepath'].includes(key.toLowerCase())) delete env[key];
  env.PATH = dirname(process.execPath);
  env.PSMODULEPATH = modules;
  env.PSModuleAnalysisCachePath = join(directory, 'module-cache');
  env.APPDATA = join(directory, 'appdata');
  env.LOCALAPPDATA = join(directory, 'localappdata');
  await Promise.all([
    mkdir(env.APPDATA, {recursive: true}),
    mkdir(env.LOCALAPPDATA, {recursive: true}),
  ]);
}

void test(
  'embedded shells retain their project, resize, isolate sessions and close',
  {skip: process.platform === 'win32', timeout: 15000},
  async t => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'varisdev-terminal-')),
    );
    t.after(() => rm(directory, {recursive: true, force: true}));
    const cwd = join(directory, "project's files & $work");
    await mkdir(cwd);
    const previous = process.env.SHELL;
    process.env.SHELL = '/bin/sh';
    t.after(() => {
      if (previous === undefined) delete process.env.SHELL;
      else process.env.SHELL = previous;
    });
    const terminals = new DesktopTerminals(() => {});
    t.after(() => terminals.dispose());
    const first = await terminals.open('first', cwd);
    assert.equal(
      (await terminals.open('first', cwd)).generation,
      first.generation,
    );
    const second = await terminals.open('second', directory);
    assert.notEqual(second.generation, first.generation);
    terminals.resize('first', 93, 31);
    terminals.write('first', "pwd -P; stty size; printf 'pty-%s\\n' 'ready'\r");
    let output = '';
    for (let i = 0; i < 100; i++) {
      output = (await terminals.open('first', cwd)).data;
      if (output.includes('pty-ready')) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.ok(output.includes(cwd), output);
    assert.match(output, /31 93/);
    assert.match(output, /pty-ready/);
    assert.doesNotMatch(
      (await terminals.open('second', directory)).data,
      /pty-ready/,
    );
    assert.throws(() => terminals.resize('first', 0, 50), /dimensions/);
    terminals.close('first');
    assert.throws(() => terminals.write('first', 'pwd\r'), /Open a terminal/);
    assert.notEqual(
      (await terminals.open('first', cwd)).generation,
      first.generation,
    );
    await assert.rejects(
      terminals.open('missing', join(directory, 'missing')),
      {code: 'ENOENT'},
    );
  },
);

void test(
  'Electron project terminals launch with a restricted Windows PATH and preserve controls',
  {
    timeout: 30000,
    skip:
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY,
  },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-terminal-ui-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const reportPath = join(directory, 'report.json');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: directory,
      SHELL: '/bin/sh',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    if (process.platform === 'win32')
      await windowsTerminalEnvironment(directory, env);
    let error;
    try {
      await runTerminalProcess(
        createRequire(import.meta.url)('electron') as string,
        [
          fileURLToPath(
            new URL('./fixtures/desktop-terminal.cjs', import.meta.url),
          ),
          directory,
          reportPath,
        ],
        {env, timeoutMs: 25000},
      );
    } catch (failure) {
      error = failure;
    }
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
      error?: string;
      cases: string[];
    };
    assert.ifError(report.error);
    assert.ifError(error);
    assert.equal(report.cases.length, 5);
  },
);
