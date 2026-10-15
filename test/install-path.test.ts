import assert from 'node:assert/strict';
import {execFile, spawnSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {configurePath} from '../src/runtime/distribution.mjs';

const execute = promisify(execFile);
for (const shell of ['bash', 'zsh', 'fish', 'nu']) {
  const available =
    process.platform !== 'win32' &&
    spawnSync(shell, ['--version']).status === 0;
  void test(
    `${shell} finds varisdev outside the install directory after PATH setup`,
    {skip: available ? false : `${shell} is not installed`},
    async t => {
      const directory = await mkdtemp(join(tmpdir(), 'varisdev-path-'));
      t.after(() => rm(directory, {recursive: true, force: true}));
      const home = join(directory, 'home');
      const bin = join(directory, "install's \\ directory", 'bin');
      const config = join(home, 'custom config');
      const zdotdir = join(home, 'zsh config');
      await Promise.all(
        [home, bin, config, zdotdir].map(path =>
          mkdir(path, {recursive: true}),
        ),
      );
      await writeFile(
        join(bin, 'varisdev'),
        '#!/bin/sh\nprintf "installed command\\n"\n',
        {mode: 0o755},
      );
      const env = {
        ...process.env,
        HOME: home,
        SHELL: `/bin/${shell}`,
        XDG_CONFIG_HOME: config,
        ZDOTDIR: zdotdir,
        PATH: process.env.PATH,
      };
      // Preserve a Bash login profile that does not source .bashrc.
      if (shell === 'bash')
        await writeFile(
          join(home, '.bash_profile'),
          'export EXISTING_SETTING=kept\n',
        );
      const options = {home, env, platform: 'linux' as const};
      const activation = await configurePath(bin, options);
      const profile =
        shell === 'bash'
          ? join(home, '.bashrc')
          : shell === 'zsh'
            ? join(zdotdir, '.zshrc')
            : shell === 'fish'
              ? join(config, 'fish/conf.d/varisdev.fish')
              : join(config, 'nushell/env.nu');
      const before = await readFile(profile, 'utf8');
      await configurePath(bin, options);
      assert.equal(await readFile(profile, 'utf8'), before);
      const args =
        shell === 'bash'
          ? ['--noprofile', '--rcfile', profile, '-ic', 'varisdev']
          : shell === 'nu'
            ? ['--env-config', profile, '-c', '^varisdev']
            : ['-ic', 'varisdev'];
      const result = await execute(shell, args, {
        env,
        cwd: tmpdir(),
        timeout: 10000,
      });
      assert.equal(result.stdout.trim(), 'installed command');
      assert.ok(activation);
      // The printed command also activates PATH in an already open shell.
      const current = await execute(
        shell,
        ['-c', `${activation}\n${shell === 'nu' ? '^' : ''}varisdev`],
        {
          env,
          cwd: tmpdir(),
          timeout: 10000,
        },
      );
      assert.equal(current.stdout.trim(), 'installed command');
      if (shell === 'bash') {
        const login = join(home, '.bash_profile');
        assert.match(await readFile(login, 'utf8'), /EXISTING_SETTING=kept/);
        const result = await execute(
          shell,
          [
            '--noprofile',
            '--norc',
            '-c',
            '. "$HOME/.bash_profile"; varisdev; printf "%s" "$EXISTING_SETTING"',
          ],
          {env, cwd: tmpdir()},
        );
        assert.equal(result.stdout.trim(), 'installed command\nkept');
      }
    },
  );
}
