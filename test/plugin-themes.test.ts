import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {loadPluginThemes} from '../src/desktop/plugin-themes.ts';
import {workspaceConfigPaths} from '../src/dashboard/workspace-config.ts';
import {THEMES} from '../assets/dashboard/themes.js';
import {createDirectoryLink, createFileSymlinkOrSkip} from './filesystem.ts';

async function fixture(t: {after(fn: () => Promise<void>): void}) {
  const root = await mkdtemp(join(tmpdir(), 'varisdev-plugin-themes-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const agentDir = join(root, 'user');
  const cwd = join(root, 'project');
  await mkdir(agentDir, {recursive: true});
  await mkdir(join(cwd, '.pi'), {recursive: true});
  const plugin = join(agentDir, 'npm/node_modules/test-style');
  await mkdir(join(plugin, 'themes'), {recursive: true});
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({packages: ['npm:test-style']}),
  );
  return {root, agentDir, cwd, plugin};
}

void test('installed global and project packages expose declarative themes without running code or changing settings', async t => {
  const f = await fixture(t);
  const manifest = {
    name: 'test-style',
    varisdev: {themes: ['./themes/blue.json', './themes/blue.json']},
  };
  await writeFile(join(f.plugin, 'package.json'), JSON.stringify(manifest));
  await writeFile(
    join(f.plugin, 'themes/blue.json'),
    JSON.stringify({
      id: 'blue',
      name: 'Blue',
      colors: {mint: '#123456'},
      scenePalette: {floor: '#654321'},
      stylesheet: './style.css',
    }),
  );
  await writeFile(
    join(f.plugin, 'themes/style.css'),
    '.theme-control {gap: 16px;}',
  );
  await writeFile(
    join(f.plugin, 'index.js'),
    'throw new Error("Plugin code must not run");',
  );
  const project = join(f.cwd, 'style');
  await mkdir(project);
  await writeFile(
    join(project, 'package.json'),
    JSON.stringify({
      name: '@test/project',
      varisdev: {themes: ['./theme.json']},
    }),
  );
  await writeFile(
    join(project, 'theme.json'),
    JSON.stringify({id: 'factory', name: 'Project', base: 'solarized-light'}),
  );
  await writeFile(
    join(f.cwd, '.pi/settings.json'),
    JSON.stringify({packages: ['../style', 'npm:missing-project-package']}),
  );
  const before = await readFile(join(f.agentDir, 'settings.json'), 'utf8');
  const result = await loadPluginThemes(f);
  assert.deepEqual(result.errors, []);
  assert.equal(result.themes.length, 2);
  const globalTheme = result.themes.find(
    entry => entry.id === 'plugin:test-style:blue',
  );
  assert.ok(globalTheme);
  assert.equal(globalTheme.base, 'factory');
  assert.equal(globalTheme.css, '.theme-control {gap: 16px;}');
  assert.deepEqual(globalTheme.scenePalette, {floor: '#654321'});
  assert.ok(
    result.themes.some(
      entry => entry.id === 'plugin:%40test%2Fproject:factory',
    ),
  );
  assert.equal(
    await readFile(join(f.agentDir, 'settings.json'), 'utf8'),
    before,
  );
  const globalOnly = await loadPluginThemes({
    cwd: f.root,
    agentDir: f.agentDir,
  });
  assert.equal(globalOnly.themes.length, 1);
  await assert.rejects(
    access(workspaceConfigPaths(f.cwd, f.agentDir).workspaceDir),
    {code: 'ENOENT'},
  );
});

void test('plugins can inherit and override every shipped palette', async t => {
  const f = await fixture(t);
  await writeFile(
    join(f.plugin, 'package.json'),
    JSON.stringify({
      name: 'test-style',
      varisdev: {themes: THEMES.map(theme => `./themes/${theme.id}.json`)},
    }),
  );
  for (const theme of THEMES) {
    await writeFile(
      join(f.plugin, `themes/${theme.id}.json`),
      JSON.stringify({
        id: theme.id,
        name: theme.name,
        base: theme.id,
        colors: theme.colors,
      }),
    );
  }
  const result = await loadPluginThemes(f);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.themes.map(theme => theme.base),
    THEMES.map(theme => theme.id),
  );
  assert.deepEqual(
    result.themes.map(theme => theme.colors),
    THEMES.map(theme => theme.colors),
  );
});

void test('project installations override duplicate global theme IDs and retain other global themes', async t => {
  const f = await fixture(t);
  const manifest = {name: 'test-style', varisdev: {themes: ['./blue.json']}};
  await writeFile(
    join(f.plugin, 'package.json'),
    JSON.stringify({
      ...manifest,
      varisdev: {themes: ['./blue.json', './global.json']},
    }),
  );
  await writeFile(
    join(f.plugin, 'blue.json'),
    JSON.stringify({
      id: 'blue',
      name: 'Global Blue',
      colors: {mint: '#111111'},
    }),
  );
  await writeFile(
    join(f.plugin, 'global.json'),
    JSON.stringify({id: 'global', name: 'Global Extra'}),
  );
  const projectPlugin = join(f.cwd, '.pi/npm/node_modules/test-style');
  await mkdir(projectPlugin, {recursive: true});
  await writeFile(
    join(projectPlugin, 'package.json'),
    JSON.stringify(manifest),
  );
  await writeFile(
    join(projectPlugin, 'blue.json'),
    JSON.stringify({
      id: 'blue',
      name: 'Project Blue',
      colors: {mint: '#222222'},
      stylesheet: './project.css',
    }),
  );
  await writeFile(
    join(projectPlugin, 'project.css'),
    '.theme-control {gap: 24px;}',
  );
  await writeFile(
    join(f.cwd, '.pi/settings.json'),
    JSON.stringify({packages: ['npm:test-style']}),
  );
  const result = await loadPluginThemes(f);
  assert.deepEqual(result.errors, []);
  assert.equal(result.themes.length, 2);
  const selected = result.themes.find(
    entry => entry.id === 'plugin:test-style:blue',
  );
  assert.ok(selected);
  assert.equal(selected.name, 'Project Blue');
  assert.equal(selected.colors.mint, '#222222');
  assert.equal(selected.css, '.theme-control {gap: 24px;}');
  assert.ok(
    result.themes.some(entry => entry.id === 'plugin:test-style:global'),
  );
  const globalOnly = await loadPluginThemes({
    cwd: f.root,
    agentDir: f.agentDir,
  });
  assert.equal(
    globalOnly.themes.find(entry => entry.id === selected.id)?.name,
    'Global Blue',
  );
});

void test('malformed themes, outside resources, and oversized CSS produce bounded diagnostics', async t => {
  const f = await fixture(t);
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(
    join(outside, 'outside.json'),
    JSON.stringify({id: 'outside', name: 'Outside'}),
  );
  await createDirectoryLink(outside, join(f.plugin, 'linked'));
  const paths = [
    './linked/outside.json',
    '../../../outside.json',
    './bad.json',
    './base.json',
    './large.json',
    './invalid.json',
    './good.json',
  ];
  await writeFile(
    join(f.plugin, 'package.json'),
    JSON.stringify({name: 'test-style', varisdev: {themes: paths}}),
  );
  await writeFile(
    join(f.plugin, 'bad.json'),
    JSON.stringify({id: 'bad', name: 'Bad', colors: {mint: 'red'}}),
  );
  await writeFile(
    join(f.plugin, 'base.json'),
    JSON.stringify({id: 'base', name: 'Base', base: 'unknown'}),
  );
  await writeFile(
    join(f.plugin, 'large.json'),
    JSON.stringify({id: 'large', name: 'Large', stylesheet: './large.css'}),
  );
  await writeFile(join(f.plugin, 'large.css'), 'x'.repeat(128 * 1024 + 1));
  await writeFile(join(f.plugin, 'invalid.json'), '{invalid json');
  await writeFile(
    join(f.plugin, 'good.json'),
    JSON.stringify({id: 'good', name: 'Good'}),
  );
  const result = await loadPluginThemes(f);
  assert.equal(result.themes.length, 1);
  assert.equal(result.errors.length, 6);
  assert.ok(result.errors.some(error => error.includes('leaves the package')));
  assert.ok(result.errors.some(error => error.includes('six digit hex')));
  assert.ok(result.errors.some(error => error.includes('128 KB')));
  assert.ok(result.errors.every(error => error.length <= 770));
});

void test('outside theme file symlinks are rejected when supported', async t => {
  const f = await fixture(t);
  const outside = join(f.root, 'outside.json');
  const linked = join(f.plugin, 'linked.json');
  await writeFile(outside, JSON.stringify({id: 'outside', name: 'Outside'}));
  if (!(await createFileSymlinkOrSkip(t, outside, linked))) return;
  await writeFile(
    join(f.plugin, 'package.json'),
    JSON.stringify({
      name: 'test-style',
      varisdev: {themes: ['./linked.json']},
    }),
  );
  const result = await loadPluginThemes(f);
  assert.deepEqual(result.themes, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /leaves the package/);
});

void test('theme registration count is bounded', async t => {
  const f = await fixture(t);
  await writeFile(
    join(f.plugin, 'package.json'),
    JSON.stringify({
      name: 'test-style',
      varisdev: {themes: Array(65).fill('./good.json')},
    }),
  );
  await writeFile(
    join(f.plugin, 'good.json'),
    JSON.stringify({id: 'good', name: 'Good'}),
  );
  const result = await loadPluginThemes(f);
  assert.equal(result.themes.length, 1);
  assert.match(result.errors[0], /limit of 64/);
});

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
void test(
  'renderer discovers, persists, reloads and removes plugin themes in Electron',
  {
    timeout: 30_000,
    skip:
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY
        ? 'Electron requires a display'
        : false,
  },
  async t => {
    const directory = await mkdtemp(
      join(tmpdir(), 'varisdev-plugin-theme-ui-'),
    );
    t.after(() => rm(directory, {recursive: true, force: true}));
    const reportPath = join(directory, 'report.json');
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    let launchError;
    try {
      await execFile(
        require('electron') as string,
        [
          fileURLToPath(
            new URL('./fixtures/plugin-themes.cjs', import.meta.url),
          ),
          directory,
          reportPath,
        ],
        {env, timeout: 25_000},
      );
    } catch (error) {
      launchError = error;
    }
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
      error?: string;
      cases: string[];
    };
    assert.ifError(report.error);
    assert.ifError(launchError);
    assert.equal(report.cases.length, 6);
  },
);

void test('workspace themes override canonical repository and global packages while retaining every scope', async t => {
  const f = await fixture(t);
  await mkdir(join(f.cwd, '.git'));
  const nested = join(f.cwd, 'nested');
  await mkdir(join(nested, '.pi'), {recursive: true});
  const paths = workspaceConfigPaths(nested, f.agentDir);
  const settingsPaths: string[] = [];
  for (const [scope, directory, plugin] of [
    ['global', f.agentDir, f.plugin],
    [
      'repository',
      paths.repositoryConfigDir,
      join(paths.repositoryConfigDir, 'npm/node_modules/test-style'),
    ],
    [
      'nested',
      join(nested, '.pi'),
      join(nested, '.pi/npm/node_modules/test-style'),
    ],
    [
      'workspace',
      paths.workspaceDir,
      join(paths.workspaceDir, 'npm/node_modules/test-style'),
    ],
  ]) {
    await mkdir(plugin, {recursive: true});
    const settingsPath = join(directory, 'settings.json');
    settingsPaths.push(settingsPath);
    await writeFile(
      settingsPath,
      JSON.stringify({packages: ['npm:test-style', './missing-package']}),
    );
    await writeFile(
      join(plugin, 'package.json'),
      JSON.stringify({
        name: 'test-style',
        pi: {extensions: ['./index.js']},
        varisdev: {themes: ['./blue.json', './extra.json']},
      }),
    );
    await writeFile(
      join(plugin, 'index.js'),
      'throw new Error("Theme discovery must not execute extensions");',
    );
    await writeFile(
      join(plugin, 'blue.json'),
      JSON.stringify({id: 'blue', name: `${scope} blue`}),
    );
    await writeFile(
      join(plugin, 'extra.json'),
      JSON.stringify({id: scope, name: `${scope} extra`}),
    );
  }
  const before = await Promise.all(
    settingsPaths.map(path => readFile(path, 'utf8')),
  );
  const result = await loadPluginThemes({cwd: nested, agentDir: f.agentDir});
  assert.deepEqual(result.errors, []);
  assert.equal(
    result.themes.find(theme => theme.id === 'plugin:test-style:blue')?.name,
    'workspace blue',
  );
  for (const scope of ['workspace', 'nested', 'repository', 'global'])
    assert.ok(
      result.themes.some(theme => theme.id === `plugin:test-style:${scope}`),
      scope,
    );
  assert.equal(result.themes.length, 5);
  assert.deepEqual(
    await Promise.all(settingsPaths.map(path => readFile(path, 'utf8'))),
    before,
  );
  await assert.rejects(access(join(paths.workspaceDir, 'missing-package')), {
    code: 'ENOENT',
  });
  await writeFile(join(paths.workspaceDir, 'settings.json'), '{invalid');
  const invalid = await loadPluginThemes({cwd: nested, agentDir: f.agentDir});
  assert.ok(
    invalid.errors.some(error =>
      error.includes(join(paths.workspaceDir, 'settings.json')),
    ),
  );
  assert.equal(
    invalid.themes.find(theme => theme.id === 'plugin:test-style:blue')?.name,
    'nested blue',
  );
  assert.ok(
    invalid.themes.some(theme => theme.id === 'plugin:test-style:repository'),
  );
  assert.ok(
    invalid.themes.some(theme => theme.id === 'plugin:test-style:global'),
  );
});
