import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {
  createEnvironmentSettings,
  environmentPath,
  readShellEnvironment,
} from '../src/runtime/environment.mjs';
import {runRuntimeCommand} from '../src/runtime/manager.ts';
import {configurePath} from '../src/runtime/distribution.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const shellAvailable = await access('/bin/zsh').then(
  () => true,
  () => false,
);
const options = {timeout: 15000, skip: !shellAvailable};
async function fixture(t: TestContext, shell = '/bin/zsh') {
  const home = await mkdtemp(join(tmpdir(), 'varisdev-environment-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    SHELL: shell,
    PATH: '/usr/bin:/bin',
    OPENAI_API_KEY: 'inherited-key',
  };
  const file = environmentPath(env);
  await writeFile(
    join(home, '.zshrc'),
    'export OPENAI_API_KEY="shell-key"\nexport OPENAI_IMAGE_SIZE="1536x1024"\n',
  );
  await writeFile(
    join(home, '.bash_profile'),
    'export BASH_LOGIN_SETTING="profile"\n',
  );
  await writeFile(
    join(home, '.bashrc'),
    'export OPENAI_API_KEY="shell-key"\nexport OPENAI_IMAGE_SIZE="1536x1024"\n',
  );
  const settings = createEnvironmentSettings({env, file, timeoutMs: 2000});
  return {home, env, file, settings};
}

void test(
  'shell values remain in memory; save and remove affect only the selected JSON field',
  options,
  async t => {
    const f = await fixture(t);
    const initial = await f.settings.initialize();
    assert.equal(initial.values.OPENAI_API_KEY, 'shell-key');
    assert.equal(f.env.OPENAI_API_KEY, 'shell-key');
    assert.deepEqual(initial.savedNames, []);
    await assert.rejects(access(f.file), {code: 'ENOENT'});
    const saved = await f.settings.save('OPENAI_API_KEY', 'user-key');
    assert.equal(saved.values.OPENAI_API_KEY, 'user-key');
    assert.equal(f.env.OPENAI_API_KEY, 'user-key');
    assert.deepEqual(saved.savedNames, ['OPENAI_API_KEY']);
    assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), {
      OPENAI_API_KEY: 'user-key',
    });
    if (process.platform !== 'win32')
      assert.equal((await stat(f.file)).mode & 0o777, 0o600);
    assert.equal(saved.values.OPENAI_IMAGE_SIZE, '1536x1024');
    await f.settings.get();
    assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), {
      OPENAI_API_KEY: 'user-key',
    });
    const child = createEnvironmentSettings({
      env: f.settings.forChild(undefined, {reuseShell: true}),
      file: f.file,
      platform: 'win32',
    });
    await child.initialize();
    const removed = await child.save('OPENAI_API_KEY', null);
    assert.equal(
      removed.values.OPENAI_API_KEY,
      'shell-key',
      'app continuation retains the original fallback',
    );
    assert.deepEqual(removed.savedNames, []);
    await assert.rejects(access(f.file), {code: 'ENOENT'});
    assert.equal((await f.settings.get()).values.OPENAI_API_KEY, 'shell-key');
  },
);

for (const platform of ['linux', 'win32'] as const) {
  void test(
    `${platform} app continuations reuse shell fallback and reread changed, removed, and empty saved values`,
    {timeout: 5000},
    async t => {
      const base = join(root, '.varisdev/test-environment');
      await mkdir(base, {recursive: true});
      const home = await mkdtemp(join(base, 'continuation-'));
      t.after(() => rm(home, {recursive: true, force: true}));
      const file = join(home, 'environment.json');
      const marker = '__VARISDEV_ENVIRONMENT_CONTINUATION';
      const env: NodeJS.ProcessEnv = {
        HOME: home,
        PATH: 'launch-tools',
        STALE_PLUGIN_TOKEN: 'removed-by-shell',
      };
      let reads = 0;
      const readEnvironment = async () => {
        reads++;
        return {
          PATH: 'shell-tools',
          OPENAI_API_KEY: 'shell-key',
          EMPTY_FALLBACK: '',
          SHELL_ONLY_SETTING: 'from-shell',
        };
      };
      await writeFile(
        file,
        JSON.stringify({
          OPENAI_API_KEY: 'parent-saved',
          SAVED_ONLY_SETTING: 'parent-only',
          REMOVED_SETTING: 'parent-removed',
          EMPTY_SETTING: 'parent-empty',
          EMPTY_FALLBACK: 'parent-override',
        }),
      );
      const settings = createEnvironmentSettings({
        env,
        file,
        platform,
        readEnvironment,
      });
      await settings.initialize();
      env.PATH = 'app-tools' + (platform === 'win32' ? ';' : ':') + env.PATH;
      await settings.get();
      const child = settings.forChild(undefined, {reuseShell: true});
      assert.equal(child[marker], '1');
      assert.equal(env[marker], undefined);
      assert.equal(child.PATH, env.PATH);
      assert.equal(child.OPENAI_API_KEY, 'shell-key');
      assert.equal(child.EMPTY_FALLBACK, '');
      assert.ok(!Object.hasOwn(child, 'SAVED_ONLY_SETTING'));
      assert.ok(!Object.hasOwn(child, 'REMOVED_SETTING'));
      assert.ok(!Object.hasOwn(child, 'EMPTY_SETTING'));
      assert.ok(!Object.hasOwn(child, 'STALE_PLUGIN_TOKEN'));
      assert.deepEqual(
        Object.keys(child).sort(),
        [
          'HOME',
          'PATH',
          'OPENAI_API_KEY',
          'EMPTY_FALLBACK',
          'SHELL_ONLY_SETTING',
          marker,
        ].sort(),
        'Continuation metadata contains only a version marker',
      );
      const text =
        JSON.stringify({
          OPENAI_API_KEY: 'changed-saved',
          SAVED_ONLY_SETTING: '',
          EMPTY_SETTING: '',
          NEW_SAVED_SETTING: 'new-value',
        }) + '\n';
      await writeFile(file, text);
      const continued = createEnvironmentSettings({
        env: child,
        file,
        platform,
        readEnvironment,
      });
      const state = await continued.initialize();
      assert.equal(reads, 1, 'The continuation does not read the shell again');
      assert.equal(state.error, undefined);
      assert.equal(
        child[marker],
        undefined,
        'Ordinary tools inherit no marker',
      );
      assert.equal(state.values.OPENAI_API_KEY, 'changed-saved');
      assert.equal(state.values.SAVED_ONLY_SETTING, '');
      assert.equal(state.values.EMPTY_SETTING, '');
      assert.equal(state.values.EMPTY_FALLBACK, '');
      assert.equal(state.values.NEW_SAVED_SETTING, 'new-value');
      assert.ok(!Object.hasOwn(state.values, 'REMOVED_SETTING'));
      assert.ok(!Object.hasOwn(child, 'REMOVED_SETTING'));
      assert.equal(child.SHELL_ONLY_SETTING, 'from-shell');
      assert.equal(child.PATH, env.PATH);
      assert.deepEqual(state.savedNames, [
        'OPENAI_API_KEY',
        'SAVED_ONLY_SETTING',
        'EMPTY_SETTING',
        'NEW_SAVED_SETTING',
      ]);
      assert.ok(!state.names.includes(marker));
      assert.ok(!Object.hasOwn(state.values, marker));
      assert.equal(await readFile(file, 'utf8'), text);
      await continued.save('OPENAI_API_KEY', null);
      assert.equal(child.OPENAI_API_KEY, 'shell-key');
      await continued.save('SAVED_ONLY_SETTING', null);
      assert.ok(!Object.hasOwn(child, 'SAVED_ONLY_SETTING'));
      await continued.save('EMPTY_SETTING', null);
      assert.ok(!Object.hasOwn(child, 'EMPTY_SETTING'));
      await continued.save('NEW_SAVED_SETTING', null);
      await assert.rejects(access(file), {code: 'ENOENT'});
      const nextEnv = continued.forChild(undefined, {reuseShell: true});
      const next = createEnvironmentSettings({
        env: nextEnv,
        file,
        platform,
        readEnvironment,
      });
      const fallback = await next.get();
      assert.deepEqual(fallback.savedNames, []);
      assert.equal(nextEnv.OPENAI_API_KEY, 'shell-key');
      assert.equal(nextEnv.EMPTY_FALLBACK, '');
      assert.ok(!Object.hasOwn(nextEnv, 'SAVED_ONLY_SETTING'));
      assert.equal(nextEnv.PATH, env.PATH);
      assert.equal(nextEnv[marker], undefined);
      assert.equal(reads, 1);
    },
  );
}

void test(
  'a launched app consumes continuation across source and build helpers without starting its missing shell',
  {timeout: 15000},
  async t => {
    const base = join(root, '.varisdev/test-environment');
    await mkdir(base, {recursive: true});
    const home = await mkdtemp(join(base, 'launched-continuation-'));
    t.after(() => rm(home, {recursive: true, force: true}));
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: join(home, 'local'),
      XDG_CONFIG_HOME: join(home, 'config'),
      SystemRoot: process.env.SystemRoot,
      SHELL: join(home, 'missing/bash'),
      PATH: home,
    };
    await writeFile(join(home, 'pwsh.exe'), 'invalid isolated shell');
    const file = environmentPath(env);
    await mkdir(dirname(file), {recursive: true});
    await writeFile(
      file,
      JSON.stringify({
        OPENAI_API_KEY: 'parent-saved',
        REMOVED_SETTING: 'saved',
      }),
    );
    const settings = createEnvironmentSettings({
      env,
      file,
      readEnvironment: async () => ({...env, OPENAI_API_KEY: 'shell-key'}),
    });
    await settings.initialize();
    const child = settings.forChild(undefined, {reuseShell: true});
    const text =
      '{ "OPENAI_API_KEY": "child-saved", "SAVED_ONLY_SETTING": "" }\n';
    await writeFile(file, text);
    const copy = join(home, 'environment.mjs');
    await writeFile(
      copy,
      await readFile(join(root, 'src/runtime/environment.mjs'), 'utf8'),
    );
    const script = `
      import assert from 'node:assert/strict';
      import {readFile} from 'node:fs/promises';
      const source = await import(${JSON.stringify(new URL('../src/runtime/environment.mjs', import.meta.url).href)});
      const built = await import(${JSON.stringify(pathToFileURL(copy).href)});
      assert.equal(process.env.__VARISDEV_ENVIRONMENT_CONTINUATION, '1');
      await source.initializeEnvironment();
      await built.initializeEnvironment();
      assert.equal(source.environmentSettings(), built.environmentSettings());
      const state = await built.environmentSettings().get();
      assert.equal(state.error, undefined);
      assert.equal(process.env.__VARISDEV_ENVIRONMENT_CONTINUATION, undefined);
      assert.equal(source.copyEnvironment().__VARISDEV_ENVIRONMENT_CONTINUATION, undefined);
      assert.equal(process.env.OPENAI_API_KEY, 'child-saved');
      assert.equal(process.env.SAVED_ONLY_SETTING, '');
      assert.equal(process.env.REMOVED_SETTING, undefined);
      assert.deepEqual(state.savedNames, ['OPENAI_API_KEY', 'SAVED_ONLY_SETTING']);
      assert.equal(await readFile(${JSON.stringify(file)}, 'utf8'), ${JSON.stringify(text)});
      const restart = source.environmentForChild();
      assert.equal(restart.OPENAI_API_KEY, 'shell-key');
      assert.equal(restart.SAVED_ONLY_SETTING, undefined);
      assert.equal(restart.__VARISDEV_ENVIRONMENT_CONTINUATION, undefined);
      assert.equal(source.environmentForChild({...process.env, __VARISDEV_ENVIRONMENT_CONTINUATION: '1'}, {reuseShell: false}).__VARISDEV_ENVIRONMENT_CONTINUATION, undefined);
      const continuation = source.environmentForChild(undefined, {reuseShell: true});
      assert.equal(continuation.OPENAI_API_KEY, 'shell-key');
      assert.equal(continuation.SAVED_ONLY_SETTING, undefined);
      assert.equal(continuation.__VARISDEV_ENVIRONMENT_CONTINUATION, '1');
      console.log('app-continuation-ready');
    `;
    const output = await runRuntimeCommand(
      process.execPath,
      ['--input-type=module', '-e', script],
      {cwd: home, env: child, timeoutMs: 8000},
    );
    assert.match(output, /app-continuation-ready/);
  },
);

void test(
  'unmarked and unknown continuations read the shell once and only explicit same-launch handoffs reuse it',
  {timeout: 5000},
  async t => {
    const base = join(root, '.varisdev/test-environment');
    await mkdir(base, {recursive: true});
    const home = await mkdtemp(join(base, 'initial-read-'));
    t.after(() => rm(home, {recursive: true, force: true}));
    const marker = '__VARISDEV_ENVIRONMENT_CONTINUATION';
    for (const version of [undefined, 'unknown-version']) {
      const env: NodeJS.ProcessEnv = {PATH: 'launch-tools'};
      if (version) env[marker] = version;
      let reads = 0;
      const shell = Promise.withResolvers<Record<string, string>>();
      const settings = createEnvironmentSettings({
        env,
        file: join(home, 'environment.json'),
        readEnvironment: async ({env: source = {}} = {}) => {
          reads++;
          assert.equal(source[marker], undefined);
          assert.equal(env[marker], undefined);
          return shell.promise;
        },
      });
      assert.equal(settings.forChild({[marker]: '1'})[marker], undefined);
      assert.equal(
        settings.forChild(undefined, {reuseShell: true})[marker],
        undefined,
      );
      const initialized = settings.initialize();
      const again = settings.initialize();
      assert.equal(reads, 1);
      assert.equal(
        settings.forChild(undefined, {reuseShell: true})[marker],
        undefined,
      );
      shell.resolve({PATH: 'shell-tools'});
      await Promise.all([initialized, again]);
      assert.equal(settings.forChild()[marker], undefined);
      assert.equal(settings.forChild({[marker]: '1'})[marker], undefined);
      assert.equal(
        settings.forChild({[marker]: '1'}, {reuseShell: false})[marker],
        undefined,
      );
      assert.equal(
        settings.forChild(undefined, {reuseShell: true})[marker],
        '1',
      );
      assert.equal(env[marker], undefined);
      await settings.get();
      assert.equal(reads, 1);
    }
  },
);

void test(
  'failed shell reads preserve fallback without marking a continuation and children retry the read',
  {timeout: 5000},
  async t => {
    const base = join(root, '.varisdev/test-environment');
    await mkdir(base, {recursive: true});
    const home = await mkdtemp(join(base, 'failed-read-'));
    t.after(() => rm(home, {recursive: true, force: true}));
    const file = join(home, 'environment.json');
    const marker = '__VARISDEV_ENVIRONMENT_CONTINUATION';
    const env: NodeJS.ProcessEnv = {OPENAI_API_KEY: 'launch-key'};
    await writeFile(file, JSON.stringify({OPENAI_API_KEY: 'saved-key'}));
    let reads = 0;
    const settings = createEnvironmentSettings({
      env,
      file,
      readEnvironment: async () => {
        reads++;
        throw new Error('Shell read failed.');
      },
    });
    const state = await settings.initialize();
    assert.match(state.error || '', /Shell read failed/);
    assert.equal(env.OPENAI_API_KEY, 'saved-key');
    const child = settings.forChild(undefined, {reuseShell: true});
    assert.equal(child[marker], undefined);
    assert.equal(child.OPENAI_API_KEY, 'launch-key');
    const continued = createEnvironmentSettings({
      env: child,
      file,
      readEnvironment: async ({env: source = {}} = {}) => {
        reads++;
        assert.equal(source[marker], undefined);
        assert.equal(source.OPENAI_API_KEY, 'launch-key');
        return {OPENAI_API_KEY: 'shell-key'};
      },
    });
    assert.equal((await continued.initialize()).error, undefined);
    assert.equal(reads, 2);
    assert.equal(child.OPENAI_API_KEY, 'saved-key');
    await continued.save('OPENAI_API_KEY', null);
    assert.equal(child.OPENAI_API_KEY, 'shell-key');
    assert.equal(continued.forChild()[marker], undefined);
    assert.equal(
      continued.forChild(undefined, {reuseShell: true})[marker],
      '1',
    );
  },
);

void test(
  'existing JSON overrides only its own fields and is never rewritten on startup',
  options,
  async t => {
    const f = await fixture(t);
    await mkdir(dirname(f.file), {recursive: true});
    const text =
      '{ "OPENAI_API_KEY": "saved-key", "CUSTOM_PLUGIN_TOKEN": "custom" }\n';
    await writeFile(f.file, text);
    const state = await f.settings.initialize();
    assert.equal(state.values.OPENAI_API_KEY, 'saved-key');
    assert.equal(state.values.OPENAI_IMAGE_SIZE, '1536x1024');
    assert.equal(state.values.CUSTOM_PLUGIN_TOKEN, 'custom');
    assert.equal(await readFile(f.file, 'utf8'), text);
    await f.settings.save('CUSTOM_PLUGIN_TOKEN', null);
    assert.equal(f.env.CUSTOM_PLUGIN_TOKEN, undefined);
    assert.equal(f.env.OPENAI_API_KEY, 'saved-key');
  },
);

void test(
  'Zsh startup handles profile exports, ZDOTDIR, expressions, multiline values, and noisy rc files',
  options,
  async t => {
    const f = await fixture(t);
    const directory = join(f.home, 'shell config');
    await mkdir(directory);
    await writeFile(
      join(f.home, '.zshenv'),
      'export ZDOTDIR="$HOME/shell config"\n',
    );
    await writeFile(
      join(directory, '.zprofile'),
      'export PROFILE_SETTING="profile"\n',
    );
    await writeFile(
      join(directory, '.zshrc'),
      'echo "startup noise and secret"\nexport OPENAI_API_KEY="$(cat "$HOME/key")"\nexport CUSTOM_SETTING=$\'line one\\nline two=3\'\nexport VARISDEV_INSTALL_ROOT="wrong"\nexport NODE_OPTIONS="wrong"\n',
    );
    await writeFile(join(f.home, 'key'), 'evaluated-key');
    const state = await f.settings.initialize();
    assert.equal(state.values.OPENAI_API_KEY, 'evaluated-key');
    assert.equal(state.values.PROFILE_SETTING, 'profile');
    assert.equal(state.values.CUSTOM_SETTING, 'line one\nline two=3');
    assert.equal(f.env.VARISDEV_INSTALL_ROOT, undefined);
    assert.equal(f.env.NODE_OPTIONS, undefined);
    assert.equal(f.env.HOME, f.home);
  },
);

void test(
  'shell unsets remove stale inherited values and shell XDG settings choose the JSON location',
  options,
  async t => {
    const f = await fixture(t);
    await writeFile(
      join(f.home, '.zshrc'),
      'unset OPENAI_API_KEY\nexport XDG_CONFIG_HOME="$HOME/custom-config"\n',
    );
    const file = join(f.home, 'custom-config/varisdev/environment.json');
    await mkdir(dirname(file), {recursive: true});
    await writeFile(file, JSON.stringify({CUSTOM_PLUGIN_TOKEN: 'saved'}));
    const settings = createEnvironmentSettings({env: f.env, platform: 'linux'});
    const state = await settings.initialize();
    assert.equal(f.env.OPENAI_API_KEY, undefined);
    assert.equal(state.values.OPENAI_API_KEY, undefined);
    assert.equal(state.values.CUSTOM_PLUGIN_TOKEN, 'saved');
    assert.deepEqual(state.savedNames, ['CUSTOM_PLUGIN_TOKEN']);
    f.env.PATH = `/app/bin:${f.env.PATH}`;
    await settings.get();
    assert.ok(
      f.env.PATH.startsWith('/app/bin:'),
      'viewing settings preserves app runtime path prefixes',
    );
  },
);

void test(
  'UI saves serialize without copying environment values or dropping unrelated saved entries',
  options,
  async t => {
    const f = await fixture(t);
    await Promise.all([
      f.settings.save('OPENAI_API_KEY', 'one'),
      f.settings.save('OPENAI_BASE_URL', 'https://example.test/v1'),
    ]);
    assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), {
      OPENAI_API_KEY: 'one',
      OPENAI_BASE_URL: 'https://example.test/v1',
    });
    await assert.rejects(
      f.settings.save('NODE_OPTIONS', 'secret'),
      /configurable/,
    );
    await assert.rejects(
      f.settings.save('OPENAI_API_KEY', {secret: 'value'}),
      /environment value/,
    );
  },
);

void test(
  'invalid settings and failed shell startups report errors without exposing values',
  options,
  async t => {
    const f = await fixture(t);
    const broken = createEnvironmentSettings({
      env: f.env,
      file: f.file,
      shell: join(f.home, 'zsh'),
    });
    const state = await broken.initialize();
    assert.equal(state.values.OPENAI_API_KEY, 'inherited-key');
    assert.match(state.error || '', /Could not start Zsh/);
    assert.doesNotMatch(state.error || '', /inherited-key/);
    await mkdir(dirname(f.file), {recursive: true});
    await writeFile(
      f.file,
      '{"OPENAI_API_KEY":"secret-that-must-not-be-logged",',
    );
    await assert.rejects(f.settings.get(), error => {
      assert.match(String(error), /environment.json/);
      assert.doesNotMatch(String(error), /secret-that/);
      return true;
    });
  },
);

void test(
  'shell deadline and cancellation terminate children',
  options,
  async t => {
    const f = await fixture(t);
    for (const cancel of [false, true]) {
      const pidFile = join(f.home, `child-${cancel}.pid`);
      await writeFile(
        join(f.home, '.zshrc'),
        `sleep 30 &\necho $! > '${pidFile}'\nwait\n`,
      );
      const controller = new AbortController();
      const pending = readShellEnvironment({
        env: f.env,
        timeoutMs: 300,
        signal: controller.signal,
      });
      const rejected = assert.rejects(
        pending,
        cancel ? /cancelled/ : /timed out/,
      );
      if (cancel) {
        for (let i = 0; i < 50; i++) {
          if (
            await access(pidFile).then(
              () => true,
              () => false,
            )
          )
            break;
          await delay(5);
        }
        controller.abort();
      }
      await rejected;
      const pid = Number(await readFile(pidFile, 'utf8'));
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        await delay(10);
      }
      assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
    }
  },
);

void test(
  'native Windows uses inherited fields and the same JSON precedence without invoking Zsh',
  {timeout: 5000},
  async t => {
    const f = await fixture(t);
    const settings = createEnvironmentSettings({
      env: f.env,
      file: f.file,
      platform: 'win32',
      shell: '/does/not/exist',
    });
    assert.equal(
      (await settings.initialize()).values.OPENAI_API_KEY,
      'inherited-key',
    );
    assert.equal(
      (await settings.save('OPENAI_API_KEY', 'saved')).values.OPENAI_API_KEY,
      'saved',
    );
    assert.equal(
      (await settings.save('OPENAI_API_KEY', null)).values.OPENAI_API_KEY,
      'inherited-key',
    );
  },
);

for (const shell of ['/bin/zsh', '/bin/bash']) {
  const available = await access(shell).then(
    () => true,
    () => false,
  );
  void test(
    `Finder, CLI, and direct desktop/headless entry points load ${shell} before application imports`,
    {timeout: 15000, skip: !available},
    async t => {
      const f = await fixture(t, shell);
      async function put(relative: string, text: string) {
        const path = join(f.home, 'app', relative);
        await mkdir(dirname(path), {recursive: true});
        await writeFile(path, text);
        return path;
      }
      const check =
        "if (process.env.OPENAI_API_KEY !== 'shell-key') throw new Error('Missing startup environment'); console.log('environment-ready');";
      const helper = await readFile(
        join(root, 'src/runtime/environment.mjs'),
        'utf8',
      );
      await put('package.json', '{"type":"module"}');
      await put('src/runtime/environment.mjs', helper);
      await put('src/desktop/application.ts', check);
      await put('src/runtime/headless-session.ts', check);
      for (const relative of [
        'src/desktop/main.ts',
        'src/runtime/headless.ts',
        'bin/varisdev.mjs',
        'src/runtime/node-version.mjs',
      ]) {
        await put(relative, await readFile(join(root, relative), 'utf8'));
      }
      await put(
        'desktop/build/src/runtime/manager.js',
        `export class RuntimeManager { async currentRoot() { ${check} return ${JSON.stringify(join(f.home, 'app'))}; } }`,
      );
      await put(
        'desktop/build/src/runtime/cli.js',
        `export async function runCli() { ${check} return 0; }`,
      );
      for (const entry of [
        'src/desktop/main.ts',
        'src/runtime/headless.ts',
        'bin/varisdev.mjs',
      ]) {
        const output = await runRuntimeCommand(
          process.execPath,
          [join(f.home, 'app', entry)],
          {cwd: f.home, env: f.env, timeoutMs: 4000},
        );
        assert.match(output, /environment-ready/);
      }
      // Execute the production CJS launcher with only Electron and the post-bootstrap runtime stubbed.
      await put('bundle/environment.mjs', helper);
      await put(
        'bundle/main.cjs',
        await readFile(join(root, 'assets/desktop/app-main.cjs'), 'utf8'),
      );
      await put(
        'bundle/launch.json',
        JSON.stringify({
          installRoot: join(f.home, 'app'),
          runtimeRoot: join(f.home, 'app'),
          nodeExecutable: process.execPath,
          path: f.env.PATH,
        }),
      );
      await put('desktop/build/src/desktop/main.js', check);
      await put(
        'node_modules/electron/index.js',
        'module.exports={app:{setName(){},exit(code){process.exitCode=code},whenReady:async()=>{}},dialog:{showErrorBox(_,message){console.error(message)}}};',
      );
      const output = await runRuntimeCommand(
        process.execPath,
        [join(f.home, 'app/bundle/main.cjs')],
        {cwd: f.home, env: f.env, timeoutMs: 4000},
      );
      assert.match(output, /environment-ready/);
      await rm(join(f.home, 'app/bundle/environment.mjs'));
      await put(
        'desktop/build/src/runtime/manager.js',
        `export class RuntimeManager { async currentRoot() { return ${JSON.stringify(join(f.home, 'app'))}; } }`,
      );
      const upgraded = await runRuntimeCommand(
        process.execPath,
        [join(f.home, 'app/bundle/main.cjs')],
        {cwd: f.home, env: f.env, timeoutMs: 4000},
      );
      assert.match(
        upgraded,
        /environment-ready/,
        'an older updater that copied only main.cjs can load the active environment helper',
      );
      await assert.rejects(access(f.file), {code: 'ENOENT'});
    },
  );
}

void test(
  'direct bundled Pi commands receive effective JSON credentials',
  options,
  async t => {
    const f = await fixture(t);
    await mkdir(dirname(f.file), {recursive: true});
    await writeFile(
      f.file,
      JSON.stringify({CUSTOM_MCP_TOKEN: 'saved-command-key'}),
    );
    const cli = join(
      f.home,
      'desktop/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
    );
    await mkdir(dirname(cli), {recursive: true});
    await writeFile(
      cli,
      "if (process.env.CUSTOM_MCP_TOKEN !== 'saved-command-key') throw new Error('Missing saved command credential'); console.log('command-environment-ready');",
    );
    const script = `const {RuntimeManager} = await import(${JSON.stringify(new URL('../src/runtime/manager.ts', import.meta.url).href)}); RuntimeManager.prototype.currentRoot = async () => ${JSON.stringify(f.home)}; const {runCli} = await import(${JSON.stringify(new URL('../src/runtime/cli.ts', import.meta.url).href)}); process.exitCode = await runCli(['mcp', 'list'], ${JSON.stringify(f.home)});`;
    const output = await runRuntimeCommand(
      process.execPath,
      ['--input-type=module', '-e', script],
      {cwd: f.home, env: f.env, timeoutMs: 8000},
    );
    assert.match(output, /command-environment-ready/);
  },
);

for (const recoverShell of [false, true]) {
  void test(
    recoverShell
      ? 'source and build helpers migrate a legacy shell failure and initialize Bash once'
      : 'legacy singleton migration restores inherited fallbacks while applying saved settings to process.env',
    {
      timeout: 15000,
      skip: recoverShell
        ? process.platform !== 'linux'
        : process.platform === 'win32',
    },
    async t => {
      const f = await fixture(t, '/bin/bash');
      if (!recoverShell) f.env.SHELL = join(f.home, 'missing/bash');
      await writeFile(
        join(f.home, '.bashrc'),
        'printf "read\\n" >> "$HOME/shell-reads"\nexport MIGRATION_INHERITED_SETTING="$OPENAI_API_KEY"\nexport OPENAI_API_KEY="bash-key"\nexport SHELL_ONLY_SETTING="from-bash"\n',
      );
      const text =
        '{ "OPENAI_API_KEY": "saved-key", "SAVED_ONLY_SETTING": "saved-only" }\n';
      await mkdir(dirname(f.file), {recursive: true});
      await writeFile(f.file, text);
      const buildHelper = join(f.home, 'build/environment.mjs');
      await mkdir(dirname(buildHelper), {recursive: true});
      await writeFile(
        buildHelper,
        await readFile(join(root, 'src/runtime/environment.mjs'), 'utf8'),
      );
      const script = `
        import assert from 'node:assert/strict';
        import {access, readFile} from 'node:fs/promises';
        import {delimiter} from 'node:path';
        const source = await import(${JSON.stringify(new URL('../src/runtime/environment.mjs', import.meta.url).href)});
        const built = await import(${JSON.stringify(pathToFileURL(buildHelper).href)});
        const file = ${JSON.stringify(f.file)};
        const recoverShell = ${recoverShell};
        if (!recoverShell)
          process.env.SystemRoot = ${JSON.stringify(join(f.home, 'missing-windows'))};
        const fallback = recoverShell ? 'bash-key' : 'inherited-key';
        const key = Symbol.for('varisdev.environment-settings');
        process.env.OPENAI_API_KEY = 'saved-key';
        process.env.SAVED_ONLY_SETTING = 'saved-only';
        let legacyReads = 0;
        const legacy = {
          async initialize() {
            return {values: {...process.env}, error: 'Could not start Zsh to read .zshrc.'};
          },
          forChild(base) {
            assert.equal(base, process.env);
            legacyReads++;
            const child = {...base, OPENAI_API_KEY: 'inherited-key', __VARISDEV_ENVIRONMENT_CONTINUATION: '1'};
            delete child.SAVED_ONLY_SETTING;
            return child;
          },
        };
        globalThis[key] = legacy;
        assert.match((await legacy.initialize()).error, /Zsh/);
        process.env.RUNTIME_ADDED_SETTING = 'from-app';
        const settings = source.environmentSettings();
        assert.notEqual(settings, legacy);
        assert.equal(globalThis[key], settings);
        const state = await settings.initialize();
        assert.equal(state.values.OPENAI_API_KEY, 'saved-key');
        assert.equal(state.values.SAVED_ONLY_SETTING, 'saved-only');
        assert.equal(process.env.OPENAI_API_KEY, 'saved-key');
        assert.equal(process.env.RUNTIME_ADDED_SETTING, 'from-app');
        assert.deepEqual(state.savedNames.sort(), ['OPENAI_API_KEY', 'SAVED_ONLY_SETTING']);
        assert.equal(await readFile(file, 'utf8'), ${JSON.stringify(text)});
        if (recoverShell) {
          assert.equal(state.error, undefined);
          assert.equal(process.env.MIGRATION_INHERITED_SETTING, 'inherited-key');
          assert.equal(process.env.SHELL_ONLY_SETTING, 'from-bash');
        } else {
          assert.match(state.error, /Could not start/);
          assert.doesNotMatch(state.error, /Zsh/);
        }
        const child = settings.forChild();
        assert.equal(child.OPENAI_API_KEY, fallback);
        assert.equal(child.SAVED_ONLY_SETTING, undefined);
        assert.equal(process.env.SAVED_ONLY_SETTING, 'saved-only');
        process.env.RUNTIME_ADDED_SETTING = 'changed-by-app';
        const runtimePath = 'app-runtime-bin' + delimiter + process.env.PATH;
        process.env.PATH = runtimePath;
        assert.notEqual(source.environmentSettings, built.environmentSettings);
        assert.equal(built.environmentSettings(), settings);
        await built.initializeEnvironment();
        await source.initializeEnvironment();
        await settings.get();
        assert.equal(process.env.RUNTIME_ADDED_SETTING, 'changed-by-app');
        assert.equal(process.env.PATH, runtimePath);
        assert.equal(await readFile(file, 'utf8'), ${JSON.stringify(text)});
        await settings.save('OPENAI_API_KEY', 'replacement-key');
        assert.equal(process.env.OPENAI_API_KEY, 'replacement-key');
        assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
          OPENAI_API_KEY: 'replacement-key', SAVED_ONLY_SETTING: 'saved-only',
        });
        const removed = await built.environmentSettings().save('OPENAI_API_KEY', null);
        assert.equal(removed.values.OPENAI_API_KEY, fallback);
        assert.equal(process.env.OPENAI_API_KEY, fallback);
        assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {SAVED_ONLY_SETTING: 'saved-only'});
        await settings.save('SAVED_ONLY_SETTING', null);
        assert.equal(process.env.SAVED_ONLY_SETTING, undefined);
        await assert.rejects(access(file), {code: 'ENOENT'});
        assert.equal(legacyReads, 1);
        if (recoverShell)
          assert.equal(await readFile(${JSON.stringify(join(f.home, 'shell-reads'))}, 'utf8'), 'read\\n');
        console.log('singleton-migration-ready');
      `;
      const output = await runRuntimeCommand(
        process.execPath,
        ['--input-type=module', '-e', script],
        {cwd: f.home, env: f.env, timeoutMs: 8000},
      );
      assert.match(output, /singleton-migration-ready/);
    },
  );
}

void test(
  'Linux Bash startup loads its own profile without requiring Zsh and preserves saved overrides',
  {timeout: 15000, skip: process.platform !== 'linux'},
  async t => {
    const home = await mkdtemp(join(tmpdir(), 'varisdev-bash-environment-'));
    t.after(() => rm(home, {recursive: true, force: true}));
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      SHELL: '/bin/bash',
      PATH: '/usr/bin:/bin',
      OPENAI_API_KEY: 'inherited-key',
      STALE_PLUGIN_TOKEN: 'inherited-token',
    };
    await writeFile(
      join(home, '.bash_profile'),
      'export BASH_LOGIN_SETTING="from-login"\n',
    );
    await writeFile(
      join(home, '.bashrc'),
      'echo "startup noise with private-key"\necho "private-key" >&2\nexport OPENAI_API_KEY="bash-key"\nexport BASH_PLUGIN_SETTING="from-bash"\nunset STALE_PLUGIN_TOKEN\n',
    );
    await writeFile(join(home, '.zshrc'), 'exit 19\n');
    const bin = join(home, 'installed/bin');
    await configurePath(bin, {home, env, platform: 'linux'});
    const file = environmentPath(env, 'linux');
    await mkdir(dirname(file), {recursive: true});
    const text = '{ "OPENAI_API_KEY": "saved-key" }\n';
    await writeFile(file, text);
    const settings = createEnvironmentSettings({
      env,
      platform: 'linux',
      timeoutMs: 2000,
    });
    const state = await settings.initialize();
    assert.equal(state.error, undefined);
    assert.equal(env.OPENAI_API_KEY, 'saved-key');
    assert.equal(env.BASH_PLUGIN_SETTING, 'from-bash');
    assert.equal(env.BASH_LOGIN_SETTING, 'from-login');
    assert.ok(env.PATH?.split(':').includes(bin));
    assert.equal(env.STALE_PLUGIN_TOKEN, undefined);
    assert.equal(await readFile(file, 'utf8'), text);
    assert.equal(settings.forChild().OPENAI_API_KEY, 'bash-key');
    assert.equal(
      (await settings.save('OPENAI_API_KEY', null)).values.OPENAI_API_KEY,
      'bash-key',
    );
    await assert.rejects(access(file), {code: 'ENOENT'});

    await writeFile(join(home, '.bashrc'), 'echo "private-key" >&2\nexit 17\n');
    const failed = await createEnvironmentSettings({
      env,
      file,
      platform: 'linux',
      timeoutMs: 2000,
    }).initialize();
    assert.match(
      failed.error || '',
      /Could not read Bash startup files: shell startup failed/,
    );
    assert.doesNotMatch(failed.error || '', /Zsh|private-key/);
    const missing = await createEnvironmentSettings({
      env,
      file,
      platform: 'linux',
      shell: join(home, 'bash'),
      timeoutMs: 2000,
    }).initialize();
    assert.match(missing.error || '', /Could not start Bash/);
    assert.doesNotMatch(missing.error || '', /Zsh|private-key/);
  },
);

void test(
  'Bash startup deadlines and cancellation stop background descendants',
  {timeout: 10000, skip: process.platform !== 'linux'},
  async t => {
    const home = await mkdtemp(join(tmpdir(), 'varisdev-bash-timeout-'));
    t.after(() => rm(home, {recursive: true, force: true}));
    const env = {HOME: home, SHELL: '/bin/bash', PATH: '/usr/bin:/bin'};
    for (const cancel of [false, true]) {
      const pidFile = join(home, `child-${cancel}.pid`);
      const startup = `sleep 30 &\necho $! > '${pidFile}'\nwait\n`;
      await writeFile(join(home, '.bash_profile'), cancel ? '' : startup);
      await writeFile(join(home, '.bashrc'), cancel ? startup : '');
      const controller = new AbortController();
      const pending = readShellEnvironment({
        env,
        timeoutMs: 1000,
        signal: controller.signal,
      });
      const rejected = assert.rejects(
        pending,
        cancel ? /cancelled/ : /timed out/,
      );
      if (cancel) {
        for (let i = 0; i < 100; i++) {
          if (
            await access(pidFile).then(
              () => true,
              () => false,
            )
          )
            break;
          await delay(5);
        }
        controller.abort();
      }
      await rejected;
      const pid = Number(await readFile(pidFile, 'utf8'));
      // A killed orphan can remain a zombie until the host's init reaps it.
      const status = await readFile(`/proc/${pid}/stat`, 'utf8').catch(
        error => {
          if (error.code === 'ENOENT') return '';
          throw error;
        },
      );
      assert.ok(
        !status || /^\d+ \(.+\) Z /.test(status),
        `Shell descendant ${pid} is still running`,
      );
    }
  },
);

const nuShell = process.env.VARISDEV_TEST_NU || '/usr/bin/nu';
const nuAvailable =
  process.platform !== 'win32' &&
  (await access(nuShell).then(
    () => true,
    () => false,
  ));
void test(
  'Nushell startup exports env, config and login values through the inherited descriptor',
  {timeout: 10000, skip: !nuAvailable},
  async t => {
    const home = await mkdtemp(join(tmpdir(), 'varisdev-nu-environment-'));
    t.after(() => rm(home, {recursive: true, force: true}));
    const config = join(home, 'config');
    const directory = join(config, 'nushell');
    await mkdir(directory, {recursive: true});
    await writeFile(
      join(directory, 'env.nu'),
      '$env.OPENAI_API_KEY = "nu-key"\n',
    );
    await writeFile(
      join(directory, 'config.nu'),
      'print "private-startup-noise"\n$env.NU_CONFIG_SETTING = "config"\n',
    );
    await writeFile(
      join(directory, 'login.nu'),
      '$env.NU_LOGIN_SETTING = "login"\n',
    );
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      SHELL: nuShell,
      PATH: '/usr/bin:/bin',
      XDG_CONFIG_HOME: config,
    };
    const bin = join(home, 'installed/bin');
    await configurePath(bin, {home, env, platform: 'linux'});
    const settings = createEnvironmentSettings({
      env,
      platform: 'linux',
      timeoutMs: 3000,
    });
    const state = await settings.initialize();
    assert.equal(state.error, undefined);
    assert.equal(env.OPENAI_API_KEY, 'nu-key');
    assert.equal(env.NU_CONFIG_SETTING, 'config');
    assert.equal(env.NU_LOGIN_SETTING, 'login');
    assert.ok(env.PATH?.split(':').includes(bin));
    await assert.rejects(access(environmentPath(env, 'linux')), {
      code: 'ENOENT',
    });
  },
);

for (const previousVersion of [2, 3]) {
  void test(
    `source and standalone build helpers replace a cached v${previousVersion} loader while preserving its saved setting fallbacks`,
    {timeout: 15000},
    async t => {
      const base = join(root, '.varisdev/test-environment');
      await mkdir(base, {recursive: true});
      const home = await mkdtemp(join(base, `v${previousVersion}-`));
      t.after(() => rm(home, {recursive: true, force: true}));
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        LOCALAPPDATA: join(home, 'local'),
        XDG_CONFIG_HOME: join(home, 'config'),
        SHELL: join(home, 'missing/bash'),
      };
      // A broken executable produces an isolated startup failure on Windows.
      await writeFile(
        join(home, 'pwsh.exe'),
        'invalid executable for isolated startup failure',
      );
      for (const name of Object.keys(env))
        if (name.toLowerCase() === 'path') delete env[name];
      Object.assign(env, {PATH: home});
      const file = environmentPath(env);
      await mkdir(dirname(file), {recursive: true});
      const text = '{ "OPENAI_API_KEY": "saved-key" }\n';
      await writeFile(file, text);
      const copy = join(home, 'environment.mjs');
      await writeFile(
        copy,
        await readFile(join(root, 'src/runtime/environment.mjs'), 'utf8'),
      );
      const script = `
      import assert from 'node:assert/strict';
      import {access, readFile} from 'node:fs/promises';
      process.env.OPENAI_API_KEY = 'saved-key';
      const previous = Symbol.for('varisdev.environment-settings.v${previousVersion}');
      const current = Symbol.for('varisdev.environment-settings.v4');
      const v2 = Symbol.for('varisdev.environment-settings.v2');
      const v3 = Symbol.for('varisdev.environment-settings.v3');
      const legacy = Symbol.for('varisdev.environment-settings');
      let reads = 0;
      const stale = {
        initialize() { throw new Error('The cached PATH-only loader must not run'); },
        forChild(base) {
          assert.equal(base, process.env);
          reads++;
          return {...base, OPENAI_API_KEY: 'launch-fallback', __VARISDEV_ENVIRONMENT_CONTINUATION: '1'};
        },
      };
      if (${previousVersion} === 3)
        globalThis[v2] = {forChild() { throw new Error('v3 takes precedence'); }};
      globalThis[previous] = stale;
      globalThis[legacy] = {forChild() { throw new Error('Versioned state takes precedence'); }};
      const source = await import(${JSON.stringify(new URL('../src/runtime/environment.mjs', import.meta.url).href)});
      const built = await import(${JSON.stringify(pathToFileURL(copy).href)});
      const settings = source.environmentSettings();
      assert.notEqual(settings, stale);
      assert.equal(settings, built.environmentSettings());
      assert.equal(settings, globalThis[current]);
      assert.equal(settings, globalThis[v2]);
      assert.equal(settings, globalThis[v3]);
      assert.equal(settings, globalThis[legacy]);
      const state = await settings.initialize();
      assert.match(state.error, /Could not start/);
      assert.equal(state.values.OPENAI_API_KEY, 'saved-key');
      assert.equal(process.env.OPENAI_API_KEY, 'saved-key');
      assert.equal(settings.forChild().OPENAI_API_KEY, 'launch-fallback');
      assert.equal(settings.forChild().__VARISDEV_ENVIRONMENT_CONTINUATION, undefined);
      assert.equal(await readFile(${JSON.stringify(file)}, 'utf8'), ${JSON.stringify(text)});
      await settings.save('OPENAI_API_KEY', null);
      assert.equal(process.env.OPENAI_API_KEY, 'launch-fallback');
      await assert.rejects(access(${JSON.stringify(file)}), {code: 'ENOENT'});
      assert.equal(reads, 1);
      console.log('v${previousVersion}-migration-ready');
    `;
      const output = await runRuntimeCommand(
        process.execPath,
        ['--input-type=module', '-e', script],
        {
          cwd: home,
          env,
          timeoutMs: 8000,
        },
      );
      assert.match(output, new RegExp(`v${previousVersion}-migration-ready`));
    },
  );
}
