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
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {
  createEnvironmentSettings,
  environmentPath,
  readShellEnvironment,
} from '../src/runtime/environment.mjs';
import {runRuntimeCommand} from '../src/runtime/manager.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const shellAvailable = await access('/bin/zsh').then(
  () => true,
  () => false,
);
const options = {timeout: 15000, skip: !shellAvailable};
async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'varisdev-environment-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    SHELL: '/bin/zsh',
    PATH: '/usr/bin:/bin',
    OPENAI_API_KEY: 'inherited-key',
  };
  const file = environmentPath(env);
  await writeFile(
    join(home, '.zshrc'),
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
      env: f.settings.forChild(),
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
      shell: join(f.home, 'missing-shell'),
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

void test(
  'Finder, CLI, and direct desktop/headless entry points load Zsh before application imports',
  options,
  async t => {
    const f = await fixture(t);
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
      'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
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
