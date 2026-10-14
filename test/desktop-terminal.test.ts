import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {openSystemTerminal, terminalCommands} from '../src/desktop/terminal.ts';

void test('terminal launches in the selected project and falls back to an installed application', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varisdev-terminal-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const cwd = join(directory, "project's files & $work");
  await mkdir(cwd);
  const attempts: string[] = [];
  const launched: unknown[] = [];
  const terminal = await openSystemTerminal(cwd, {
    platform: 'linux',
    env: {SHELL: '/bin/sh'},
    available: async command => {
      attempts.push(command);
      return command === 'konsole';
    },
    run: async (...args) => {
      launched.push(args);
    },
  });
  assert.equal(terminal.name, 'Konsole');
  assert.deepEqual(launched, [['konsole', ['--workdir', cwd], cwd]]);
  assert.ok(attempts.includes('gnome-terminal'));
  await assert.rejects(
    openSystemTerminal(cwd, {
      platform: 'linux',
      env: {},
      available: async () => false,
    }),
    /No terminal application/,
  );
  await assert.rejects(
    openSystemTerminal(join(cwd, 'missing'), {
      run: async () =>
        assert.fail('Must not start a terminal for a missing project'),
    }),
    {code: 'ENOENT'},
  );
});

void test(
  'macOS terminal navigation treats punctuation in a project path as data',
  {skip: process.platform === 'win32'},
  async t => {
    const directory = await mkdtemp(
      join(tmpdir(), 'varisdev-terminal-quoting-'),
    );
    t.after(() => rm(directory, {recursive: true, force: true}));
    const cwd = join(directory, "quotes' $USER; echo wrong\nfolder");
    await mkdir(cwd);
    const command = terminalCommands('darwin', cwd)[0];
    const encoded = command.args[1]
      .split('\ndo script ')[1]
      .split('\nend tell')[0];
    const shellCommand = JSON.parse(encoded) as string;
    const {stdout} = await promisify(execFile)('/bin/sh', [
      '-c',
      `${shellCommand} && pwd -P`,
    ]);
    // macOS /var is an alias for /private/var.
    const {stdout: realCwd} = await promisify(execFile)('/bin/pwd', ['-P'], {
      cwd,
    });
    assert.equal(stdout, realCwd);
  },
);

void test(
  'Terminal tab uses the desktop bridge without affecting the draft',
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
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    let error;
    try {
      await promisify(execFile)(
        createRequire(import.meta.url)('electron') as string,
        [
          fileURLToPath(
            new URL('./fixtures/desktop-terminal.cjs', import.meta.url),
          ),
          directory,
          reportPath,
        ],
        {env, timeout: 25000},
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
    assert.equal(report.cases.length, 2);
  },
);

void test('Windows terminal receives the project as one argument and has a PowerShell fallback', () => {
  const cwd = "C:\\project's files & $data";
  const [terminal, fallback] = terminalCommands('win32', cwd);
  assert.deepEqual(terminal.args, ['-d', cwd]);
  const command = Buffer.from(fallback.args.at(-1)!, 'base64').toString(
    'utf16le',
  );
  assert.match(command, /-WorkingDirectory 'C:\\project''s files & \$data'/);
});
