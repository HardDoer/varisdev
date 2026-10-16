import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {
  DefaultResourceLoader,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  createAppResourceFilter,
  isAppPackageSource,
} from '../src/dashboard/resources.ts';

for (const fileUrls of [false, true]) {
  void test(`app resource loading excludes an older app registered by ${fileUrls ? 'file URL' : 'path'} without changing other plugins`, async t => {
    const source = (path: string) =>
      fileUrls ? pathToFileURL(path).href : path;
    const root = await mkdtemp(join(tmpdir(), 'varisdev-resources-'));
    t.after(() => rm(root, {recursive: true, force: true}));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    const old = join(root, 'old app #archive');
    const plugin = join(root, 'plugin');
    await Promise.all([cwd, agentDir, old, plugin].map(path => mkdir(path)));
    for (const [directory, repository] of [
      [old, 'git+https://github.com/HardDoer/varisdev.git'],
      [plugin, 'https://github.com/someone/varisdev-plugin.git'],
    ]) {
      await writeFile(
        join(directory, 'package.json'),
        JSON.stringify({
          name: directory === old ? 'old-app' : 'plugin',
          repository,
          type: 'module',
          pi: {extensions: ['./index.mjs']},
        }),
      );
      await writeFile(
        join(directory, 'index.mjs'),
        `import {writeFileSync} from 'node:fs'; export default function (api) { writeFileSync(${JSON.stringify(join(directory, 'loaded'))}, 'loaded'); api.registerCommand(${JSON.stringify(directory === old ? 'obsolete-app' : 'current-plugin')}, {handler: async () => {}}); }`,
      );
    }
    const local = join(old, 'local-plugin.mjs');
    await writeFile(
      local,
      `import {writeFileSync} from 'node:fs'; export default function () { writeFileSync(${JSON.stringify(join(old, 'local-loaded'))}, 'loaded'); }`,
    );
    const saved = {
      packages: [
        {source: source(old)},
        {source: source(plugin), extensions: ['index.mjs']},
      ],
      theme: 'varisware',
    };
    const settingsPath = join(agentDir, 'settings.json');
    await writeFile(settingsPath, JSON.stringify(saved));
    const settings = SettingsManager.create(cwd, agentDir, {
      projectTrusted: true,
    });
    const filtered = createAppResourceFilter(settings, cwd, agentDir);
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: filtered.settingsManager,
      additionalExtensionPaths: filtered.paths([source(local)]),
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    await assert.rejects(access(join(old, 'loaded')), {code: 'ENOENT'});
    await access(join(plugin, 'loaded'));
    await access(join(old, 'local-loaded'));
    assert.deepEqual(
      filtered.paths([
        source(join(old, 'index.mjs')),
        source(join(plugin, 'index.mjs')),
      ]),
      [source(join(plugin, 'index.mjs'))],
    );
    assert.deepEqual(settings.getGlobalSettings().packages, saved.packages);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), saved);
    // Other settings still use the original storage and retain both registrations.
    filtered.settingsManager.setTheme('nord');
    await settings.flush();
    assert.deepEqual(
      JSON.parse(await readFile(settingsPath, 'utf8')).packages,
      saved.packages,
    );
  });
}

void test(
  'Windows tilde resource paths retain other plugins and filter the older app',
  {skip: process.platform !== 'win32'},
  () => {
    const agentDir = join(homedir(), '.varisdev-resource-ownership-test');
    const old =
      '~\\.varisdev-resource-ownership-test\\npm\\node_modules\\varisdev\\extensions\\old.ts';
    const plugin =
      '~\\.varisdev-resource-ownership-test\\npm\\node_modules\\other-plugin\\extensions\\index.ts';
    const saved = {
      packages: ['npm:varisdev'],
      extensions: [old, plugin],
      theme: 'nord',
    };
    const settings = SettingsManager.inMemory(saved);
    const filtered = createAppResourceFilter(settings, agentDir, agentDir);
    assert.deepEqual(filtered.paths([old, plugin]), [plugin]);
    assert.deepEqual(filtered.settingsManager.getGlobalSettings(), {
      ...saved,
      packages: [],
      extensions: [plugin],
    });
    assert.deepEqual(settings.getGlobalSettings(), saved);
  },
);

void test('only the official app identity is filtered, including pinned sources', () => {
  for (const source of [
    'git:github.com/HardDoer/varisdev',
    'git:github.com/HardDoer/varisdev@v0.1.0',
    'git+https://github.com/HardDoer/varisdev.git#main',
    'git@github.com:HardDoer/varisdev.git',
    'npm:varisdev@0.1.0',
  ])
    assert.equal(isAppPackageSource(source), true, source);
  for (const source of [
    'git:github.com/someone/varisdev',
    'github:someone/varisdev',
    'npm:varisdev-other',
    '/projects/varisdev-plugin',
    'https://example.com/HardDoer/varisdev',
  ])
    assert.equal(isAppPackageSource(source), false, source);
});
