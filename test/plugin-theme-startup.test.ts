import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {join} from 'node:path';
import {test} from 'node:test';

void test('cold theme discovery keeps the Pi SDK and session UI out of the module graph', async t => {
  const sdkEntry = import.meta.resolve('@earendil-works/pi-coding-agent');
  const sdkDirectory = new URL('./', sdkEntry).href;
  const blocked: string[] = [];
  const loaded = new Set<string>();
  const hooks = registerHooks({
    load(url, context, next) {
      const sdkPath = url.startsWith(sdkDirectory)
        ? url.slice(sdkDirectory.length)
        : '';
      if (
        url === sdkEntry ||
        /^(modes|cli|extensions)\//.test(sdkPath) ||
        /^core\/(sdk|agent-session|session-manager|resource-loader)\.js$/.test(
          sdkPath,
        ) ||
        /\/node_modules\/@earendil-works\/pi-(tui|agent-core|codemode|mcp)\//.test(
          url,
        ) ||
        /\/node_modules\/@earendil-works\/pi-ai\/dist\/(index\.js|providers\/)/.test(
          url,
        )
      ) {
        blocked.push(url);
        throw new Error(`Theme discovery loaded session or UI code: ${url}`);
      }
      loaded.add(url);
      return next(url, context);
    },
  });
  t.after(() => hooks.deregister());
  const temporaryRoot = join(process.cwd(), '.varisdev/tool-output');
  await mkdir(temporaryRoot, {recursive: true});
  const root = await mkdtemp(join(temporaryRoot, 'theme-startup-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const agentDir = join(root, 'agent');
  const repository = join(root, 'project');
  const cwd = join(repository, 'nested');
  await mkdir(join(repository, '.git'), {recursive: true});
  await mkdir(cwd);
  const {workspaceConfigPaths} =
    await import('../src/dashboard/workspace-paths.ts');
  const paths = workspaceConfigPaths(cwd, agentDir, '.pi');
  assert.ok(!loaded.has(new URL('config.js', sdkDirectory).href));
  assert.ok(
    !loaded.has(new URL('core/settings-manager.js', sdkDirectory).href),
  );
  assert.ok(!loaded.has(new URL('core/package-manager.js', sdkDirectory).href));

  const settingsPaths: string[] = [];
  for (const [scope, directory] of [
    ['global', agentDir],
    ['repository', paths.repositoryConfigDir],
    ['nested', join(cwd, '.pi')],
    ['workspace', paths.workspaceDir],
  ]) {
    const plugin = join(directory, 'package');
    await mkdir(plugin, {recursive: true});
    const settingsPath = join(directory, 'settings.json');
    settingsPaths.push(settingsPath);
    await writeFile(
      settingsPath,
      JSON.stringify({packages: ['./package', './missing-package']}),
    );
    await writeFile(
      join(plugin, 'package.json'),
      JSON.stringify({
        name: 'boot-style',
        main: './index.js',
        pi: {extensions: ['./index.js']},
        varisdev: {themes: ['./shared.json', './scope.json']},
      }),
    );
    await writeFile(
      join(plugin, 'index.js'),
      'throw new Error("Theme discovery executed extension code");',
    );
    await writeFile(
      join(plugin, 'shared.json'),
      JSON.stringify({id: 'shared', name: `${scope} shared`}),
    );
    await writeFile(
      join(plugin, 'scope.json'),
      JSON.stringify({id: scope, name: `${scope} extra`}),
    );
  }
  const before = await Promise.all(
    settingsPaths.map(path => readFile(path, 'utf8')),
  );
  const {loadPluginThemes} = await import('../src/desktop/plugin-themes.ts');
  const result = await loadPluginThemes({cwd, agentDir});
  assert.deepEqual(result.errors, []);
  assert.equal(result.themes.length, 5);
  assert.equal(result.themes[0].name, 'workspace shared');
  for (const scope of ['workspace', 'nested', 'repository', 'global'])
    assert.ok(
      result.themes.some(theme => theme.id === `plugin:boot-style:${scope}`),
      scope,
    );
  assert.deepEqual(
    await Promise.all(settingsPaths.map(path => readFile(path, 'utf8'))),
    before,
  );

  const workspaceSettings = join(paths.workspaceDir, 'settings.json');
  await writeFile(workspaceSettings, '{invalid');
  const invalid = await loadPluginThemes({cwd, agentDir});
  assert.equal(invalid.errors.length, 1);
  assert.ok(invalid.errors[0].includes(workspaceSettings));
  assert.equal(invalid.themes[0].name, 'nested shared');
  assert.deepEqual(blocked, []);
});
