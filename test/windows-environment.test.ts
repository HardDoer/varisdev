import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {
  copyEnvironment,
  createEnvironmentSettings,
  environmentPath,
  windowsEnvironment,
} from '../src/runtime/environment.mjs';
import {runTerminalProcess} from './fixtures/terminal-process.mjs';

const inheritedPath = 'C:\\Runtime;C:\\Windows\\System32';
const registeredPaths = [
  'c:\\windows\\system32\\;C:\\Program Files\\Git\\cmd',
  'C:\\Users\\test\\Työkalut;;C:/Program Files/Git/cmd',
];
const fallbackPath = [
  inheritedPath,
  'C:\\Program Files\\Git\\cmd',
  'C:\\Users\\test\\Työkalut',
].join(';');

void test('Windows PATH recovery preserves inherited tools and adds system and user tools once', () => {
  for (const name of ['PATH', 'Path', 'path']) {
    const env = {[name]: inheritedPath, CUSTOM_TOOL: 'inherited', HOME: 'home'};
    const recovered = windowsEnvironment(env, registeredPaths);
    assert.equal(recovered.PATH, fallbackPath);
    assert.equal(recovered.CUSTOM_TOOL, 'inherited');
    assert.deepEqual(
      Object.keys(recovered).filter(key => key.toLowerCase() === 'path'),
      ['PATH'],
    );
    assert.equal(
      env[name],
      inheritedPath,
      'Reading fallback does not mutate its input',
    );
    assert.equal(copyEnvironment(env, 'win32').PATH, inheritedPath);
    assert.equal(copyEnvironment(env, 'win32').HOME, 'home');
  }
  assert.equal(
    windowsEnvironment({}, [null, 'C:\\User tools']).PATH,
    'C:\\User tools',
  );
  assert.equal(
    windowsEnvironment({Path: '\\;C:;C:\\'}, ['c:\\;C:\\Tools\\;c:/tools'])
      .PATH,
    '\\;C:;C:\\;C:\\Tools\\',
    'Root paths and drive-relative paths remain distinct',
  );
});

void test(
  'Windows saved PATH aliases override recovery and removal restores the fallback without persisting it',
  {timeout: 5000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-windows-env-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    for (const name of ['PATH', 'Path', 'path']) {
      const file = join(directory, name + '.json');
      const env: NodeJS.ProcessEnv = {
        Path: inheritedPath,
        CUSTOM_TOOL: 'inherited',
      };
      const text =
        JSON.stringify({[name]: 'D:\\Chosen tools', Unrelated: 'keep'}) + '\n';
      await writeFile(file, text);
      let reads = 0;
      const readEnvironment = async ({
        env: source = {},
      }: {
        env?: NodeJS.ProcessEnv;
      } = {}) => {
        reads++;
        return windowsEnvironment(source, registeredPaths);
      };
      const settings = createEnvironmentSettings({
        env,
        file,
        platform: 'win32',
        readEnvironment,
      });
      const initial = await settings.initialize();
      assert.equal(env.PATH, 'D:\\Chosen tools');
      assert.equal(initial.values.PATH, 'D:\\Chosen tools');
      assert.deepEqual(initial.savedNames, ['PATH', 'UNRELATED']);
      assert.deepEqual(
        Object.keys(env).filter(key => key.toLowerCase() === 'path'),
        ['PATH'],
      );
      await settings.get();
      assert.equal(
        await readFile(file, 'utf8'),
        text,
        'Viewing settings preserves the saved file',
      );
      assert.equal(
        reads,
        1,
        'Registry recovery runs once per settings instance',
      );
      const child = settings.forChild();
      assert.equal(
        child.PATH,
        fallbackPath,
        'App continuations receive the real fallback',
      );
      assert.equal(child.UNRELATED, undefined);
      const continued = createEnvironmentSettings({
        env: child,
        file,
        platform: 'win32',
        readEnvironment,
      });
      await continued.initialize();
      assert.equal(child.PATH, 'D:\\Chosen tools');
      const removed = await continued.save('pAtH', null);
      assert.equal(removed.values.PATH, fallbackPath);
      assert.equal(child.PATH, fallbackPath);
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
        Unrelated: 'keep',
      });
      await settings.get();
      assert.equal(env.PATH, fallbackPath);
      env.PATH = 'C:\\App prefix;' + env.PATH;
      await settings.get();
      assert.equal(
        env.PATH,
        'C:\\App prefix;' + fallbackPath,
        'Viewing settings preserves runtime prefixes',
      );
      await settings.save('Path', 'E:\\Replacement');
      assert.equal(env.PATH, 'E:\\Replacement');
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
        Unrelated: 'keep',
        PATH: 'E:\\Replacement',
      });
      await settings.save('path', '');
      assert.equal(
        env.PATH,
        '',
        'An explicitly empty PATH also takes precedence',
      );
      await settings.save('PATH', null);
      assert.equal(env.PATH, fallbackPath);
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
        Unrelated: 'keep',
      });
    }
  },
);

void test(
  'Windows registry failure retains inherited tools and saved settings',
  {timeout: 5000},
  async t => {
    const directory = await mkdtemp(
      join(tmpdir(), 'varisdev-windows-env-failure-'),
    );
    t.after(() => rm(directory, {recursive: true, force: true}));
    const file = join(directory, 'environment.json');
    const env: NodeJS.ProcessEnv = {
      Path: inheritedPath,
      CUSTOM_TOOL: 'inherited',
    };
    const settings = createEnvironmentSettings({
      env,
      file,
      platform: 'win32',
      readEnvironment: async () => {
        throw new Error('Could not read Windows PATH.');
      },
    });
    const initial = await settings.initialize();
    assert.match(initial.error || '', /Could not read Windows PATH/);
    assert.equal(env.PATH, inheritedPath);
    await assert.rejects(readFile(file), {code: 'ENOENT'});
    await settings.save('Path', 'D:\\Chosen tools');
    assert.equal(env.PATH, 'D:\\Chosen tools');
    await settings.save('PATH', null);
    assert.equal(env.PATH, inheritedPath);
    assert.equal(settings.forChild({Path: inheritedPath}).PATH, inheritedPath);
    await assert.rejects(readFile(file), {code: 'ENOENT'});
  },
);

void test(
  'Windows CLI launches preserve mixed-case PATH and distinguish fallback from saved overrides',
  {skip: process.platform !== 'win32', timeout: 30000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-cli-path-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const report = join(directory, 'child.json');
    const tools = join(directory, 'inherited tools');
    const chosen = join(directory, 'chosen tools');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: directory,
      LOCALAPPDATA: join(directory, 'local'),
    };
    for (const name of Object.keys(env))
      if (name.toLowerCase() === 'path') delete env[name];
    env.Path = tools;
    const settingsFile = environmentPath(env, 'win32');
    await mkdir(join(directory, 'local', 'VarisDev'), {recursive: true});
    const saved = JSON.stringify({Path: chosen});
    await writeFile(settingsFile, saved);
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    const childSource = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(report)}, JSON.stringify({path: process.env.PATH, names: Object.keys(process.env).filter(name => name.toLowerCase() === 'path')}));`;
    for (const relative of [
      'scripts',
      'node_modules/@earendil-works/pi-coding-agent/dist/bundle',
    ])
      await mkdir(join(directory, relative), {recursive: true});
    await writeFile(join(directory, 'scripts/desktop-app.mjs'), childSource);
    await writeFile(
      join(
        directory,
        'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
      ),
      childSource,
    );
    for (const [args, continuation] of [
      [['app', 'install'], true],
      [['mcp', 'list'], false],
    ] as const) {
      const source = `
      const {RuntimeManager} = await import(${JSON.stringify(new URL('../src/runtime/manager.ts', import.meta.url).href)});
      RuntimeManager.prototype.currentRoot = async () => ${JSON.stringify(directory)};
      const {runCli} = await import(${JSON.stringify(new URL('../src/runtime/cli.ts', import.meta.url).href)});
      process.exitCode = await runCli(${JSON.stringify(args)}, ${JSON.stringify(directory)});
    `;
      await runTerminalProcess(
        process.execPath,
        ['--input-type=module', '-e', source],
        {env, cwd: directory, timeoutMs: 10000},
      );
      const child = JSON.parse(await readFile(report, 'utf8')) as {
        path: string;
        names: string[];
      };
      assert.deepEqual(child.names, ['PATH']);
      assert.equal(child.path.split(';').includes(tools), continuation);
      assert.equal(child.path.split(';').includes(chosen), !continuation);
      assert.equal(await readFile(settingsFile, 'utf8'), saved);
    }
  },
);

void test(
  'Unix environment copies retain case distinctions and shell unsets',
  {timeout: 5000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-unix-env-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const env: NodeJS.ProcessEnv = {
      PATH: '/bin',
      Path: 'custom',
      CUSTOM_TOOL: 'removed',
    };
    assert.deepEqual(copyEnvironment(env, 'linux'), env);
    const settings = createEnvironmentSettings({
      env,
      file: join(directory, 'environment.json'),
      platform: 'linux',
      readEnvironment: async () => ({PATH: '/usr/bin', Path: 'custom'}),
    });
    await settings.initialize();
    assert.equal(env.CUSTOM_TOOL, undefined);
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.Path, 'custom');
    await settings.save('Path', 'saved');
    assert.equal(env.Path, 'saved');
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(settings.forChild().Path, 'custom');
  },
);
