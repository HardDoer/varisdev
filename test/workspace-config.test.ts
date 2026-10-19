import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {
  CONFIG_DIR_NAME,
  DefaultResourceLoader,
  getPackageDir,
} from '@earendil-works/pi-coding-agent';
import {
  createWorkspaceConfiguration,
  workspaceConfigPaths,
} from '../src/dashboard/workspace-config.ts';
import {agentToolPermissions} from '../src/agents/policy.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'varisdev-workspace-config-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(join(cwd, '.git'), {recursive: true});
  await mkdir(agentDir);
  const paths = workspaceConfigPaths(cwd, agentDir);
  const put = async (path: string, text: string | object) => {
    await mkdir(dirname(path), {recursive: true});
    await writeFile(
      path,
      typeof text === 'string' ? text : JSON.stringify(text),
    );
  };
  const configuration = createWorkspaceConfiguration(cwd, agentDir);
  const loader = configuration.resourceLoader(
    new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: configuration.resourceSettingsManager,
      ...configuration.resourceOptions(),
    }),
  );
  return {root, cwd, agentDir, paths, put, configuration, loader};
}

void test('workspace identity shares the canonical repository root and separates worktrees', async t => {
  const f = await fixture(t);
  const nested = join(f.cwd, 'src', 'nested');
  await mkdir(nested, {recursive: true});
  const alias = join(f.root, 'alias');
  await symlink(f.cwd, alias, 'dir');
  assert.deepEqual(workspaceConfigPaths(nested, f.agentDir), f.paths);
  assert.deepEqual(workspaceConfigPaths(alias, f.agentDir), f.paths);
  assert.equal(f.paths.projectDir, await realpath(f.cwd));
  const worktree = join(f.root, 'worktree');
  await mkdir(worktree);
  await writeFile(
    join(worktree, '.git'),
    'gitdir: ../project/.git/worktrees/linked',
  );
  assert.notEqual(
    workspaceConfigPaths(worktree, f.agentDir).workspaceDir,
    f.paths.workspaceDir,
  );
});

void test('home settings markers do not merge unrelated folders or make home paths internal', async t => {
  const root = await mkdtemp(join(tmpdir(), 'varisdev-workspace-home-'));
  const home = join(root, 'home');
  const variable = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const previous = process.env[variable];
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  // Retain the real global marker when the simulated home is inside the real home.
  const agentDir = join(homedir(), CONFIG_DIR_NAME, 'agent');
  process.env[variable] = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, {recursive: true, force: true});
  });
  const first = join(home, 'first');
  const second = join(home, 'second');
  await Promise.all([
    mkdir(first, {recursive: true}),
    mkdir(second, {recursive: true}),
    mkdir(join(home, CONFIG_DIR_NAME, 'agent'), {recursive: true}),
  ]);
  assert.equal(await realpath(homedir()), await realpath(home));
  const a = workspaceConfigPaths(first, agentDir);
  const b = workspaceConfigPaths(second, agentDir);
  assert.equal(a.projectDir, await realpath(first));
  assert.equal(b.projectDir, await realpath(second));
  assert.notEqual(a.workspaceDir, b.workspaceDir);
  const target = await realpath(second);
  assert.deepEqual(
    agentToolPermissions('agent_spawn', {cwd: '../second'}, first),
    [
      {action: 'subagent', resource: 'default'},
      {action: 'external_directory', resource: target.replaceAll('\\', '/')},
    ],
  );
  const alias = join(root, 'home-alias');
  await symlink(home, alias, 'junction');
  assert.deepEqual(
    workspaceConfigPaths(join(alias, 'first'), agentDir),
    workspaceConfigPaths(first, agentDir),
  );
});

void test('configured global markers cannot identify unrelated projects, including settings aliases', async t => {
  const root = await mkdtemp(
    join(tmpdir(), 'varisdev-workspace-global-marker-'),
  );
  t.after(() => rm(root, {recursive: true, force: true}));
  const tools = join(root, 'tools');
  const marker = join(tools, CONFIG_DIR_NAME);
  const first = join(tools, 'first');
  const second = join(tools, 'second');
  await mkdir(join(marker, 'agent'), {recursive: true});
  await mkdir(first);
  await mkdir(second);
  const alias = join(root, 'settings-alias');
  await symlink(marker, alias, 'junction');
  for (const agentDir of [
    marker,
    join(marker, 'agent'),
    join(alias, 'agent'),
  ]) {
    const a = workspaceConfigPaths(first, agentDir);
    const b = workspaceConfigPaths(second, agentDir);
    assert.equal(a.projectDir, await realpath(first));
    assert.equal(b.projectDir, await realpath(second));
    assert.notEqual(a.workspaceDir, b.workspaceDir);
    await mkdir(a.workspaceDir, {recursive: true});
    await writeFile(
      join(a.workspaceDir, 'settings.json'),
      JSON.stringify({defaultModel: 'first-only'}),
    );
    assert.equal(
      createWorkspaceConfiguration(
        first,
        agentDir,
      ).settingsManager.getDefaultModel(),
      'first-only',
    );
    assert.equal(
      createWorkspaceConfiguration(
        second,
        agentDir,
      ).settingsManager.getDefaultModel(),
      undefined,
    );
  }
  const explicit = join(first, CONFIG_DIR_NAME);
  await mkdir(explicit);
  await mkdir(join(first, 'nested'));
  assert.equal(
    workspaceConfigPaths(join(first, 'nested'), join(alias, 'agent'))
      .projectDir,
    await realpath(first),
  );
  await mkdir(join(tools, '.git'));
  assert.equal(
    workspaceConfigPaths(first, join(alias, 'agent')).projectDir,
    await realpath(tools),
  );
});

void test('explicit project markers retain no-Git root discovery with alternate settings directories', async t => {
  const root = await mkdtemp(join(tmpdir(), 'varisdev-workspace-marker-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const project = join(root, 'project');
  const nested = join(project, 'src', 'nested');
  const agentDir = join(root, 'custom-settings');
  await mkdir(join(project, CONFIG_DIR_NAME), {recursive: true});
  await mkdir(nested, {recursive: true});
  const expected = workspaceConfigPaths(project, agentDir);
  assert.equal(expected.projectDir, await realpath(project));
  assert.deepEqual(workspaceConfigPaths(nested, agentDir), expected);
  const alias = join(root, 'project-alias');
  await symlink(project, alias, 'junction');
  assert.deepEqual(
    workspaceConfigPaths(join(alias, 'src'), agentDir),
    expected,
  );
  await mkdir(join(root, '.git'));
  assert.equal(
    workspaceConfigPaths(nested, agentDir).projectDir,
    await realpath(root),
  );
});

void test('settings overlay uses Pi merge and migration, retains trust and global save scope', async t => {
  const f = await fixture(t);
  await f.put(join(f.agentDir, 'settings.json'), {
    defaultProvider: 'global',
    defaultModel: 'global',
    compaction: {reserveTokens: 100, keepRecentTokens: 200},
    defaultTools: ['read', 'bash'],
  });
  await f.put(join(f.paths.repositoryConfigDir, 'settings.json'), {
    defaultModel: 'repository',
    compaction: {reserveTokens: 300},
    defaultTools: ['+edit'],
  });
  await f.put(join(f.paths.workspaceDir, 'settings.json'), {
    defaultModel: 'workspace',
    compaction: {keepRecentTokens: 400},
    defaultTools: ['-bash'],
    queueMode: 'all',
  });
  const settings = f.configuration.settingsManager;
  await settings.reload();
  assert.equal(settings.isProjectTrusted(), false);
  assert.equal(settings.getDefaultModel(), 'workspace');
  assert.deepEqual(settings.getDefaultTools(), ['read']);
  settings.setProjectTrusted(true);
  assert.equal(settings.getDefaultProvider(), 'global');
  assert.deepEqual(settings.getDefaultTools(), ['read', 'edit']);
  assert.deepEqual(settings.getCompactionSettings(), {
    enabled: true,
    reserveTokens: 300,
    keepRecentTokens: 400,
  });
  assert.equal(settings.getSteeringMode(), 'all');
  settings.setDefaultModel('saved-global');
  await settings.flush();
  assert.equal(
    JSON.parse(await readFile(join(f.agentDir, 'settings.json'), 'utf8'))
      .defaultModel,
    'saved-global',
  );
  assert.equal(settings.getDefaultModel(), 'workspace');
  assert.equal(
    JSON.parse(
      await readFile(join(f.paths.workspaceDir, 'settings.json'), 'utf8'),
    ).defaultModel,
    'workspace',
  );
  await f.put(join(f.paths.workspaceDir, 'settings.json'), {
    defaultModel: 'reloaded',
  });
  await settings.reload();
  assert.equal(settings.getDefaultModel(), 'reloaded');
});

void test('workspace resources override matching names while retaining all configured scopes', async t => {
  const f = await fixture(t);
  const theme = JSON.parse(
    await readFile(
      join(getPackageDir(), 'dist/modes/interactive/theme/dark.json'),
      'utf8',
    ),
  );
  for (const [scope, directory] of [
    ['global', f.agentDir],
    ['repository', f.paths.repositoryConfigDir],
    ['workspace', f.paths.workspaceDir],
  ]) {
    await f.put(
      join(directory, 'prompts', 'shared.md'),
      `---\ndescription: ${scope}\n---\n${scope}`,
    );
    await f.put(join(directory, 'prompts', `${scope}.md`), scope);
    await f.put(
      join(directory, 'skills', 'shared', 'SKILL.md'),
      `---\nname: shared\ndescription: ${scope}\n---\n${scope}`,
    );
    await f.put(join(directory, 'themes', 'shared.json'), {
      ...theme,
      name: 'shared',
    });
    await f.put(
      join(directory, 'extensions', `${scope}.js`),
      `export default function(pi) { pi.registerCommand('${scope}-command', {handler: async () => {}}); }`,
    );
  }
  const packageDir = join(f.root, 'workspace-package');
  await f.put(join(packageDir, 'package.json'), {
    name: 'workspace-package',
    pi: {prompts: ['prompts']},
  });
  await f.put(
    join(packageDir, 'prompts', 'packaged.md'),
    'workspace package prompt',
  );
  await f.put(join(f.paths.workspaceDir, 'settings.json'), {
    packages: [packageDir],
  });
  f.configuration.settingsManager.setProjectTrusted(true);
  await f.loader.reload();
  assert.equal(
    f.loader
      .getPrompts()
      .prompts.find(p => p.name === 'shared')
      ?.content.trim(),
    'workspace',
  );
  assert.equal(
    f.loader
      .getPrompts()
      .prompts.find(p => p.name === 'packaged')
      ?.content.trim(),
    'workspace package prompt',
  );
  for (const name of ['global', 'repository', 'workspace']) {
    assert.ok(
      f.loader.getPrompts().prompts.some(p => p.name === name),
      name,
    );
    assert.ok(
      f.loader
        .getExtensions()
        .extensions.some(e => e.commands.has(`${name}-command`)),
      name,
    );
  }
  assert.equal(
    f.loader.getSkills().skills.find(s => s.name === 'shared')?.description,
    'workspace',
  );
  assert.equal(
    f.loader.getThemes().themes.find(theme => theme.name === 'shared')
      ?.sourcePath,
    join(f.paths.workspaceDir, 'themes', 'shared.json'),
  );
  assert.equal(
    f.loader.getSkills().skills.find(s => s.name === 'commit')
      ?.disableModelInvocation,
    true,
  );
  assert.deepEqual(f.loader.getExtensions().errors, []);
  await f.put(
    join(f.paths.workspaceDir, 'prompts', 'shared.md'),
    'updated workspace',
  );
  await f.loader.reload();
  assert.equal(
    f.loader
      .getPrompts()
      .prompts.find(p => p.name === 'shared')
      ?.content.trim(),
    'updated workspace',
  );
});

void test('trust bootstrap excludes repository extensions and retains machine-local configuration', async t => {
  const f = await fixture(t);
  for (const [scope, directory] of [
    ['global', f.agentDir],
    ['repository', f.paths.repositoryConfigDir],
    ['workspace', f.paths.workspaceDir],
  ]) {
    await f.put(
      join(directory, 'extensions', `${scope}.js`),
      `export default function(pi) { pi.registerCommand('${scope}', {handler: async () => {}}); }`,
    );
    await f.put(join(directory, 'SYSTEM.md'), `${scope} system`);
  }
  let bootstrap: string[] = [];
  await f.loader.reload({
    resolveProjectTrust: async ({extensionsResult}) => {
      bootstrap = extensionsResult.extensions.flatMap(e => [
        ...e.commands.keys(),
      ]);
      return false;
    },
  });
  assert.ok(bootstrap.includes('global'));
  assert.ok(bootstrap.includes('workspace'));
  assert.ok(!bootstrap.includes('repository'));
  assert.ok(
    !f.loader
      .getExtensions()
      .extensions.some(e => e.commands.has('repository')),
  );
  assert.equal(f.loader.getSystemPrompt(), 'workspace system');
});

void test('workspace instruction conventions and system files reload through SDK hooks', async t => {
  const f = await fixture(t);
  await f.put(join(f.cwd, 'AGENTS.md'), 'repository instructions');
  await f.put(join(f.agentDir, 'AGENTS.md'), 'global instructions');
  await f.put(
    join(f.paths.workspaceDir, 'AGENTS.md'),
    'workspace instructions',
  );
  await f.put(
    join(f.paths.workspaceDir, 'AGENTS.override.md'),
    'workspace override instructions',
  );
  await f.put(
    join(f.paths.repositoryConfigDir, 'SYSTEM.md'),
    'repository system',
  );
  await f.put(join(f.paths.workspaceDir, 'SYSTEM.md'), 'workspace system');
  await f.put(
    join(f.paths.workspaceDir, 'APPEND_SYSTEM.md'),
    'workspace append',
  );
  f.configuration.settingsManager.setProjectTrusted(true);
  await f.loader.reload();
  assert.equal(f.loader.getSystemPrompt(), 'workspace system');
  assert.deepEqual(f.loader.getSystemPromptSource(), {
    path: join(f.paths.workspaceDir, 'SYSTEM.md'),
  });
  assert.deepEqual(f.loader.getAppendSystemPrompt(), ['workspace append']);
  assert.deepEqual(f.loader.getAppendSystemPromptSources(), [
    {path: join(f.paths.workspaceDir, 'APPEND_SYSTEM.md')},
  ]);
  const files = f.loader.getAgentsFiles().agentsFiles;
  assert.ok(files.some(file => file.content === 'global instructions'));
  assert.ok(files.some(file => file.content === 'repository instructions'));
  assert.equal(files.at(-1)?.content, 'workspace override instructions');
  await f.put(join(f.paths.workspaceDir, 'SYSTEM.md'), 'updated system');
  await f.loader.reload();
  assert.equal(f.loader.getSystemPrompt(), 'updated system');
  const disabled = new DefaultResourceLoader({
    cwd: f.cwd,
    agentDir: f.agentDir,
    settingsManager: f.configuration.resourceSettingsManager,
    ...f.configuration.resourceOptions({
      noContextFiles: true,
      noSkills: true,
      noExtensions: true,
      systemPrompt: 'CLI system',
    }),
  });
  await disabled.reload();
  assert.deepEqual(disabled.getAgentsFiles().agentsFiles, []);
  assert.deepEqual(disabled.getSkills().skills, []);
  assert.deepEqual(disabled.getExtensions().extensions, []);
  assert.equal(disabled.getSystemPrompt(), 'CLI system');
});

void test('APPEND_SYSTEM survives the internal main and delegated instruction append', async t => {
  const f = await fixture(t);
  await f.put(
    join(f.paths.workspaceDir, 'APPEND_SYSTEM.md'),
    'personal append',
  );
  const loader = f.configuration.resourceLoader(
    new DefaultResourceLoader({
      cwd: f.cwd,
      agentDir: f.agentDir,
      settingsManager: f.configuration.resourceSettingsManager,
      ...f.configuration.resourceOptions({
        appendSystemPrompt: ['delegated instructions'],
      }),
    }),
  );
  await loader.reload();
  assert.deepEqual(loader.getAppendSystemPrompt(), [
    'personal append',
    'delegated instructions',
  ]);
  assert.deepEqual(loader.getAppendSystemPromptSources(), [
    {path: join(f.paths.workspaceDir, 'APPEND_SYSTEM.md')},
  ]);
});

void test('MCP hook retains inherited servers, workspace precedence and SDK parse errors', async t => {
  const f = await fixture(t);
  await f.put(join(f.agentDir, 'mcp.json'), {
    mcpServers: {
      global: {command: 'global'},
      shared: {command: 'global'},
    },
  });
  await f.put(join(f.paths.repositoryConfigDir, 'mcp.json'), {
    mcpServers: {
      project: {command: 'project'},
      shared: {command: 'project'},
    },
  });
  await f.put(join(f.paths.workspaceDir, 'mcp.json'), {
    autoEnableCodemode: false,
    mcpServers: {
      workspace: {command: 'workspace'},
      shared: {command: 'workspace'},
    },
  });
  const load = f.configuration.mcpOptions.loadConfig!;
  const context = {} as Parameters<typeof load>[0];
  let config = load(context);
  assert.deepEqual(
    config.servers.map(s => s.name),
    ['global', 'shared', 'workspace'],
  );
  f.configuration.settingsManager.setProjectTrusted(true);
  config = load(context);
  assert.deepEqual(
    config.servers.map(s => s.name),
    ['global', 'shared', 'project', 'workspace'],
  );
  assert.equal(
    (config.servers.find(s => s.name === 'shared')!.config as {command: string})
      .command,
    'workspace',
  );
  assert.equal(config.autoEnableCodemode, false);
  assert.deepEqual(config.errors, []);
  await f.put(join(f.paths.workspaceDir, 'mcp.json'), '{bad json');
  assert.ok(
    load(context).errors.some(error =>
      error.includes(join(f.paths.workspaceDir, 'mcp.json')),
    ),
  );
});

void test('nested folders share workspace configuration and retain root and current project resources', async t => {
  const f = await fixture(t);
  const nested = join(f.cwd, 'nested');
  await mkdir(nested);
  await f.put(join(f.paths.repositoryConfigDir, 'settings.json'), {
    defaultProvider: 'root',
    defaultModel: 'root-model',
  });
  await f.put(join(nested, CONFIG_DIR_NAME, 'settings.json'), {
    defaultModel: 'nested-model',
  });
  await f.put(
    join(f.paths.repositoryConfigDir, 'prompts', 'root.md'),
    'root prompt',
  );
  await f.put(
    join(nested, CONFIG_DIR_NAME, 'prompts', 'nested.md'),
    'nested prompt',
  );
  await f.put(join(f.paths.repositoryConfigDir, 'SYSTEM.md'), 'root system');
  await f.put(
    join(f.paths.workspaceDir, 'prompts', 'workspace.md'),
    'shared workspace prompt',
  );
  const config = createWorkspaceConfiguration(nested, f.agentDir);
  config.settingsManager.setProjectTrusted(true);
  const loader = config.resourceLoader(
    new DefaultResourceLoader({
      cwd: nested,
      agentDir: f.agentDir,
      settingsManager: config.resourceSettingsManager,
      ...config.resourceOptions(),
    }),
  );
  await loader.reload();
  assert.equal(config.settingsManager.getDefaultProvider(), 'root');
  assert.equal(config.settingsManager.getDefaultModel(), 'nested-model');
  assert.deepEqual(
    loader
      .getPrompts()
      .prompts.map(p => p.name)
      .sort(),
    ['nested', 'root', 'workspace'],
  );
  assert.equal(loader.getSystemPrompt(), 'root system');
  assert.deepEqual(loader.getSystemPromptSource(), {
    path: join(f.paths.repositoryConfigDir, 'SYSTEM.md'),
  });
  await f.put(join(nested, CONFIG_DIR_NAME, 'SYSTEM.md'), 'nested system');
  await loader.reload();
  assert.equal(loader.getSystemPrompt(), 'nested system');
});

void test('task context includes explicitly selected resources without automatic instructions or catalogs', async t => {
  const f = await fixture(t);
  for (const directory of [
    f.agentDir,
    f.paths.repositoryConfigDir,
    f.paths.workspaceDir,
  ]) {
    await f.put(join(directory, 'SYSTEM.md'), 'Automatic system sentinel');
    await f.put(
      join(directory, 'APPEND_SYSTEM.md'),
      'Automatic append sentinel',
    );
    await f.put(
      join(directory, 'skills', 'automatic', 'SKILL.md'),
      '---\nname: automatic\ndescription: Automatic skill sentinel\n---\nAutomatic body',
    );
    await f.put(
      join(directory, 'prompts', 'automatic.md'),
      'Automatic prompt sentinel',
    );
  }
  await f.put(join(f.cwd, 'AGENTS.md'), 'Repository instructions sentinel');
  await f.put(join(f.agentDir, 'AGENTS.md'), 'Global instructions sentinel');
  await f.put(
    join(f.paths.workspaceDir, 'AGENTS.md'),
    'Workspace instructions sentinel',
  );
  const skill = join(f.root, 'selected', 'SKILL.md');
  const prompt = join(f.root, 'selected-prompt.md');
  await f.put(
    skill,
    '---\nname: selected\ndescription: Selected skill\n---\nSelected skill body',
  );
  await f.put(prompt, 'Selected prompt body');
  const options = f.configuration.resourceOptions(
    {
      additionalSkillPaths: [skill],
      additionalPromptTemplatePaths: [prompt],
      appendSystemPrompt: [
        'Explicit appended instructions',
        'Explicit appended instructions',
      ],
    },
    'task',
  );
  const loader = f.configuration.resourceLoader(
    new DefaultResourceLoader({
      cwd: f.cwd,
      agentDir: f.agentDir,
      settingsManager: f.configuration.resourceSettingsManager,
      ...options,
    }),
  );
  f.configuration.settingsManager.setProjectTrusted(true);
  await loader.reload();
  assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
  assert.equal(loader.getSystemPrompt(), undefined);
  assert.equal(loader.getSystemPromptSource(), undefined);
  assert.deepEqual(loader.getAppendSystemPrompt(), [
    'Explicit appended instructions',
  ]);
  assert.deepEqual(loader.getAppendSystemPromptSources(), []);
  assert.deepEqual(
    loader.getSkills().skills.map(item => item.name),
    ['selected'],
  );
  assert.deepEqual(
    loader.getPrompts().prompts.map(item => item.name),
    ['selected-prompt'],
  );
  await f.put(
    skill,
    '---\nname: selected\ndescription: Updated selected skill\n---\nUpdated body',
  );
  await loader.reload();
  assert.equal(
    loader.getSkills().skills[0].description,
    'Updated selected skill',
  );
  assert.equal(loader.getSystemPrompt(), undefined);
  assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
});

void test('workspace context includes each canonical instruction file and repeated append block once', async t => {
  const f = await fixture(t);
  const instructions = join(f.agentDir, 'AGENTS.md');
  await f.put(instructions, 'Shared instructions sentinel');
  await symlink(instructions, join(f.cwd, 'AGENTS.md'));
  const append = join(f.paths.workspaceDir, 'APPEND_SYSTEM.md');
  await f.put(append, 'Shared append sentinel');
  const loader = f.configuration.resourceLoader(
    new DefaultResourceLoader({
      cwd: f.cwd,
      agentDir: f.agentDir,
      settingsManager: f.configuration.resourceSettingsManager,
      ...f.configuration.resourceOptions({appendSystemPrompt: [append]}),
    }),
  );
  await loader.reload();
  assert.equal(
    loader
      .getAgentsFiles()
      .agentsFiles.filter(file =>
        file.content.includes('Shared instructions sentinel'),
      ).length,
    1,
  );
  assert.deepEqual(loader.getAppendSystemPrompt(), ['Shared append sentinel']);
  assert.deepEqual(loader.getAppendSystemPromptSources(), [{path: append}]);
});
