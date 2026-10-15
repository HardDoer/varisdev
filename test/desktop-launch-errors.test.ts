import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';

const execute = promisify(execFile);

void test('desktop startup reports the current Electron failure and sandbox repair documentation', async t => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'varisdev-launch-error-')),
  );
  t.after(() => rm(directory, {recursive: true, force: true}));
  const electron = join(directory, 'node_modules/electron');
  const desktop = join(directory, 'desktop/build/src/desktop');
  const profile = join(directory, 'profile');
  await Promise.all(
    [electron, desktop, profile].map(path => mkdir(path, {recursive: true})),
  );
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(join(electron, 'package.json'), '{"main":"index.cjs"}');
  await writeFile(
    join(electron, 'index.cjs'),
    `module.exports = ${JSON.stringify(process.execPath)};`,
  );
  await writeFile(
    join(desktop, 'main.js'),
    `
    if (process.env.TEST_FAILURE === 'sandbox') {
      console.error('[FATAL:setuid_sandbox_host.cc:166] The SUID sandbox helper binary was found, but is not configured correctly.');
      console.error(${JSON.stringify(`You need to make sure that ${join(directory, 'chrome-sandbox')} is owned by root and has mode 4755.`)});
      process.exit(1);
    }
    console.error('Unrelated startup failure');
    process.kill(process.pid, 'SIGTERM');
  `,
  );
  const log = join(profile, 'startup.log');
  await writeFile(log, 'Previous startup\n' + 'old log\n'.repeat(2000));
  const source = `
    import {openDesktop} from ${JSON.stringify(new URL('../src/runtime/cli.ts', import.meta.url).href)};
    try {
      await openDesktop(${JSON.stringify(directory)}, ${JSON.stringify(directory)});
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  `;
  const env = {
    ...process.env,
    PIDEV_DESKTOP_DATA_DIR: profile,
    VARISDEV_DATA_DIR: join(directory, 'data'),
    VARISDEV_RESTART_PID: '',
  };
  await assert.rejects(
    execute(process.execPath, ['--input-type=module', '-e', source], {
      env: {...env, TEST_FAILURE: 'sandbox'},
      timeout: 10000,
    }),
    error => {
      const failure = error as {code: number; stderr: string};
      assert.equal(failure.code, 1);
      assert.match(failure.stderr, /SUID sandbox helper/);
      assert.match(failure.stderr, /owned by root and has mode 4755/);
      assert.ok(
        failure.stderr.includes(
          join(directory, 'docs/installation.md') + '#linux-sandbox',
        ),
      );
      assert.ok(failure.stderr.includes(log));
      assert.doesNotMatch(failure.stderr, /Previous startup|old log/);
      return true;
    },
  );
  await assert.rejects(
    execute(process.execPath, ['--input-type=module', '-e', source], {
      env: {...env, TEST_FAILURE: 'other'},
      timeout: 10000,
    }),
    error => {
      const failure = error as {code: number; stderr: string};
      assert.equal(failure.code, 1);
      assert.match(failure.stderr, /Unrelated startup failure/);
      if (process.platform !== 'win32') assert.match(failure.stderr, /SIGTERM/);
      assert.doesNotMatch(failure.stderr, /sandbox|old log/);
      return true;
    },
  );
  await mkdir(join(electron, 'dist'));
  await writeFile(
    join(electron, 'path.txt'),
    relative(join(electron, 'dist'), process.execPath),
  );
  await writeFile(join(electron, 'index.cjs'), 'module.exports = {app: {}};');
  await assert.rejects(
    execute(process.execPath, ['--input-type=module', '-e', source], {
      env,
      timeout: 10000,
    }),
    error => {
      const failure = error as {stderr: string};
      assert.match(failure.stderr, /Unrelated startup failure/);
      assert.doesNotMatch(failure.stderr, /Received an instance of Object/);
      return true;
    },
  );
  // Keep the complete log for later diagnosis even though the CLI shows only
  // the failed attempt.
  assert.match(await readFile(log, 'utf8'), /Previous startup/);
});
