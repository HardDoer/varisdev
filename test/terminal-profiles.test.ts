import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {runTerminalProcess} from './fixtures/terminal-process.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const application = new URL(
  './fixtures/terminal-profiles.mjs',
  import.meta.url,
);
const accountShell = process.platform === 'win32' ? null : userInfo().shell;
const accountKind = accountShell && basename(accountShell);
const accountProfiles =
  accountShell && (accountKind === 'zsh' || accountKind === 'bash')
    ? [
        {
          kind: accountKind,
          login: accountKind === 'zsh' ? '.zprofile' : '.bash_profile',
          shell: accountShell,
          account: true,
        },
      ]
    : [];

for (const profile of [
  {
    kind: 'zsh',
    login: '.zprofile',
    shell: process.env.VARISDEV_TEST_ZSH || '/bin/zsh',
    account: false,
  },
  {kind: 'bash', login: '.bash_profile', shell: '/bin/bash', account: false},
  {kind: 'bash', login: '.profile', shell: '/bin/bash', account: false},
  ...accountProfiles,
]) {
  const available = await access(profile.shell).then(
    () => true,
    () => false,
  );
  void test(
    profile.account
      ? `desktop startup without SHELL and project terminals use the account's ${profile.kind} profiles`
      : `desktop startup and project terminals use ${profile.kind} ${profile.login} and interactive rc settings`,
    {
      timeout: 25000,
      skip:
        process.platform === 'win32'
          ? 'Unix profiles require a macOS or Linux host'
          : !available && `${profile.shell} is unavailable`,
    },
    async t => {
      const output = join(root, '.varisdev/tool-output');
      await mkdir(output, {recursive: true});
      const directory = await realpath(
        await mkdtemp(join(output, 'terminal-profiles-')),
      );
      t.after(() => rm(directory, {recursive: true, force: true}));
      const home = join(directory, 'home');
      const project = join(directory, "project's files & $work");
      await Promise.all([mkdir(home), mkdir(project)]);
      const config = profile.kind === 'zsh' ? join(home, 'shell config') : home;
      if (config !== home) {
        await mkdir(config);
        await writeFile(
          join(home, '.zshenv'),
          'export ZDOTDIR="$HOME/shell config"\n' +
            (process.env.VARISDEV_TEST_ZSH_MODULE_PATH
              ? `module_path=('${process.env.VARISDEV_TEST_ZSH_MODULE_PATH.replaceAll("'", "'\\''")}' $module_path)\n`
              : ''),
        );
      }
      await writeFile(
        join(config, profile.login),
        `export TERMINAL_LOGIN_VALUE="${profile.kind}-login"\n` +
          (profile.kind === 'bash'
            ? 'if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi\n'
            : ''),
      );
      // A normal Bash rc often returns early outside an interactive shell.
      await writeFile(
        join(config, profile.kind === 'zsh' ? '.zshrc' : '.bashrc'),
        (profile.kind === 'bash'
          ? 'case $- in *i*) ;; *) return ;; esac\n'
          : '') +
          `export TERMINAL_PROFILE_VALUE="${profile.kind}-rc"\n` +
          'export PATH="$HOME/profile bin:$PATH"\n' +
          `alias profile_alias='printf "PROFILE_ALIAS=%s\\n" "${profile.kind}-alias"'\n` +
          'profile_function() { printf "PROFILE_FUNCTION=%s\\n" "$TERMINAL_PROFILE_VALUE"; }\n' +
          'PS1="profile> "\n',
      );
      if (profile.login === '.bash_profile') {
        await writeFile(
          join(home, '.profile'),
          'export TERMINAL_LOGIN_VALUE="wrong-login-profile"\n',
        );
      }
      // Run the shipped desktop bootstrap with only its application entry replaced.
      // The fixture uses the real environment settings and PTY integration.
      const app = join(directory, 'app');
      for (const relative of [
        'src/desktop/main.ts',
        'src/runtime/node-version.mjs',
        'src/runtime/environment.mjs',
      ]) {
        const target = join(app, relative);
        await mkdir(dirname(target), {recursive: true});
        await writeFile(target, await readFile(join(root, relative), 'utf8'));
      }
      await writeFile(join(app, 'package.json'), '{"type":"module"}\n');
      await writeFile(
        join(app, 'src/desktop/application.ts'),
        `await import(${JSON.stringify(application.href)});\n`,
      );
      const env: NodeJS.ProcessEnv = {
        HOME: home,
        USERPROFILE: home,
        ...(profile.account ? {} : {SHELL: profile.shell}),
        PATH: '/usr/bin:/bin',
        XDG_CONFIG_HOME: join(home, '.config'),
        TERMINAL_PROFILE_VALUE: 'stale-launcher-value',
        // Allow isolated Linux artifacts when running from a Windows checkout.
        ...(process.env.NODE_PATH ? {NODE_PATH: process.env.NODE_PATH} : {}),
      };
      const result = await runTerminalProcess(
        process.execPath,
        [join(app, 'src/desktop/main.ts'), home, project, profile.kind],
        {env, cwd: project, timeoutMs: 20000},
      );
      assert.match(result.stdout, /terminal-profiles-ready/);
    },
  );
}
