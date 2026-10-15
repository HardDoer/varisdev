import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {applyLinuxSandboxFix} from '../scripts/linux-sandbox.mjs';

void test(
  'sandbox wrapper preserves arguments and exit status and handles repeated Electron installations',
  {skip: process.platform === 'win32'},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-sandbox-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const bin = join(directory, 'shell tools');
    await mkdir(bin);
    await writeFile(
      join(bin, 'cat'),
      '#!/bin/sh\ncase "$1" in */unprivileged_userns_clone) printf "%s" "$TEST_USERNS";; */apparmor_restrict_unprivileged_userns) printf "%s" "$TEST_APPARMOR";; esac\n',
      {mode: 0o755},
    );
    const executable = join(directory, 'electron');
    const source =
      '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2))); process.exit(Number(process.env.TEST_EXIT || 0));\n';
    await writeFile(executable, source, {mode: 0o755});
    await applyLinuxSandboxFix(executable, 'linux');
    const wrapper = await readFile(executable, 'utf8');
    await applyLinuxSandboxFix(executable, 'linux');
    assert.equal(await readFile(executable, 'utf8'), wrapper);
    assert.equal(await readFile(executable + '.bin', 'utf8'), source);
    const args = ['app path/main.js', '--project=quotes\' $USER; "name"', ''];
    for (const [userns, apparmor, disabled] of [
      ['1', '0', false],
      ['0', '0', true],
      ['1', '1', true],
      ['', '', true],
    ] as const) {
      const env = {
        ...process.env,
        PATH: bin + ':' + process.env.PATH,
        TEST_USERNS: userns,
        TEST_APPARMOR: apparmor,
      };
      const {stdout} = await promisify(execFile)(executable, args, {env});
      assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1)!), [
        ...args,
        ...(disabled ? ['--no-sandbox'] : []),
      ]);
      await assert.rejects(
        promisify(execFile)(executable, args, {env: {...env, TEST_EXIT: '37'}}),
        {code: 37},
      );
    }
    await writeFile(executable, source + '// updated Electron\n');
    await chmod(executable, 0o755);
    await applyLinuxSandboxFix(executable, 'linux');
    assert.match(
      await readFile(executable + '.bin', 'utf8'),
      /updated Electron/,
    );
    await rm(executable + '.bin');
    await assert.rejects(applyLinuxSandboxFix(executable, 'linux'), {
      code: 'ENOENT',
    });
    await applyLinuxSandboxFix('/missing/electron', 'darwin');
    await applyLinuxSandboxFix('/missing/electron', 'win32');
  },
);
