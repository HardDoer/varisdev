import {CONFIG_DIR_NAME} from '@earendil-works/pi-coding-agent';
import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute, join, relative, sep} from 'node:path';
import {test, type TestContext} from 'node:test';
import {
  builtinAgentsDirectory,
  builtinCommitAgentsDirectory,
  builtinCommitSkillPath,
  builtinSkillsDirectory,
  findVarisDevPackageRoot,
} from '../src/builtin-assets.ts';
import {workspaceConfigPaths} from '../src/dashboard/workspace-config.ts';
import {
  type AgentTemplate,
  createDefaultAgentProfile,
  deleteAgentTemplate,
  ensureAgentProfilePermissions,
  listAgentTemplates,
  prepareAgentTemplateGet,
  resolveAgentTemplate,
  resolveDefaultAgentTemplate,
  saveAgentTemplate,
} from '../src/agents/templates.ts';

const builtinIds = ['build', 'commit', 'default', 'explore', 'general', 'plan'];

void test('built-in asset paths resolve from source and compiled desktop locations', async () => {
  const root = findVarisDevPackageRoot();
  assert.equal(
    findVarisDevPackageRoot(
      join(root, 'desktop', 'build', 'src', 'builtin-assets.js'),
    ),
    root,
  );
  assert.equal(builtinAgentsDirectory, join(root, 'assets', 'agents'));
  assert.equal(builtinSkillsDirectory, join(root, 'assets', 'skills'));
  assert.equal(
    builtinCommitSkillPath,
    join(root, 'assets', 'skills', 'commit', 'SKILL.md'),
  );
  assert.equal(
    builtinCommitAgentsDirectory,
    join(root, 'assets', 'skills', 'commit', 'agents'),
  );
  assert.equal(
    JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).name,
    'varisdev',
  );
  assert.notEqual(
    JSON.parse(await readFile(join(root, 'desktop', 'package.json'), 'utf8'))
      .name,
    'varisdev',
  );
});

async function isolate(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'varisdev-agent-templates-'));
  const agentDir = join(root, 'agent-home');
  const repository = join(root, 'repository');
  const cwd = join(repository, 'packages', 'app');
  await mkdir(join(repository, '.git'), {recursive: true});
  await mkdir(cwd, {recursive: true});
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, {recursive: true, force: true});
  });
  const config = workspaceConfigPaths(cwd, agentDir);
  return {
    root,
    agentDir,
    repository: config.projectDir,
    cwd: join(config.projectDir, 'packages', 'app'),
    globalDirectory: join(agentDir, 'agents'),
    repositoryDirectory: join(config.repositoryConfigDir, 'agents'),
    workspaceDirectory: join(config.workspaceDir, 'agents'),
  };
}

void test('lists all scopes and applies workspace then repository precedence', async t => {
  const paths = await isolate(t);
  await mkdir(paths.globalDirectory, {recursive: true});
  await mkdir(paths.repositoryDirectory, {recursive: true});
  await mkdir(paths.workspaceDirectory, {recursive: true});
  await writeFile(
    join(paths.globalDirectory, 'reviewer.md'),
    '---\nname: Global reviewer\ndescription: Global checks\nmodel: openai/global\nthinkingLevel: low\n---\nCheck the change globally.\n',
  );
  await writeFile(
    join(paths.globalDirectory, 'writer.md'),
    '---\nname: Writer\n---\nWrite the requested change.\n',
  );
  await writeFile(
    join(paths.repositoryDirectory, 'reviewer.md'),
    '---\nname: Repository reviewer\nmodel: anthropic/repo\nthinkingLevel: high\n---\nUse this repository checklist.\n',
  );
  await writeFile(
    join(paths.workspaceDirectory, 'reviewer.md'),
    '---\nname: Personal workspace reviewer\nmodel: openai/personal\n---\nUse my local checklist.\n',
  );

  const result = await listAgentTemplates(paths.cwd);
  assert.deepEqual(
    result.sources.map(source => ({
      scope: source.scope,
      directory: source.directory,
      ids: source.templates.map(template => template.id),
    })),
    [
      {
        scope: 'builtin',
        directory: builtinAgentsDirectory,
        ids: builtinIds,
      },
      {
        scope: 'global',
        directory: paths.globalDirectory,
        ids: ['reviewer', 'writer'],
      },
      {
        scope: 'repository',
        directory: paths.repositoryDirectory,
        ids: ['reviewer'],
      },
      {
        scope: 'workspace',
        directory: paths.workspaceDirectory,
        ids: ['reviewer'],
      },
    ],
  );
  assert.deepEqual(
    result.templates.map(template => [
      template.id,
      template.scope,
      template.key,
      template.name,
    ]),
    [
      ['build', 'builtin', 'builtin:build', 'Build'],
      ['commit', 'builtin', 'builtin:commit', 'Commit and push'],
      ['default', 'builtin', 'builtin:default', 'Default'],
      ['explore', 'builtin', 'builtin:explore', 'Explore'],
      ['general', 'builtin', 'builtin:general', 'General'],
      ['plan', 'builtin', 'builtin:plan', 'Plan'],
      [
        'reviewer',
        'workspace',
        'workspace:reviewer',
        'Personal workspace reviewer',
      ],
      ['writer', 'global', 'global:writer', 'Writer'],
    ],
  );
  assert.deepEqual(
    result.allTemplates.map(template => template.key),
    [
      'builtin:build',
      'builtin:commit',
      'builtin:default',
      'builtin:explore',
      'builtin:general',
      'builtin:plan',
      'global:reviewer',
      'global:writer',
      'repository:reviewer',
      'workspace:reviewer',
    ],
  );
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.defaultAgentId, 'default');
  assert.equal(
    (await resolveAgentTemplate(paths.cwd, 'reviewer'))?.instructions,
    'Use my local checklist.',
  );
  assert.equal(
    (await resolveAgentTemplate(paths.cwd, 'global:reviewer'))?.model,
    'openai/global',
  );
  assert.equal(
    (await resolveAgentTemplate(paths.cwd, 'repository:reviewer'))
      ?.thinkingLevel,
    'high',
  );
  assert.equal(
    (await resolveAgentTemplate(paths.cwd, 'workspace:reviewer'))?.model,
    'openai/personal',
  );
  await deleteAgentTemplate(paths.cwd, {scope: 'workspace', id: 'reviewer'});
  assert.equal(
    (await resolveAgentTemplate(paths.cwd, 'reviewer'))?.name,
    'Repository reviewer',
  );
  await deleteAgentTemplate(paths.cwd, {scope: 'repository', id: 'reviewer'});
  assert.equal(
    (await resolveAgentTemplate(paths.cwd, 'reviewer'))?.name,
    'Global reviewer',
  );
  assert.equal(await resolveAgentTemplate(paths.cwd, 'missing'), undefined);
});

void test('merges partial definitions and keeps raw scoped entries for editing', async t => {
  const paths = await isolate(t);
  await mkdir(paths.globalDirectory, {recursive: true});
  await mkdir(paths.repositoryDirectory, {recursive: true});
  await mkdir(paths.workspaceDirectory, {recursive: true});
  await writeFile(
    join(paths.globalDirectory, 'reviewer.md'),
    [
      '---',
      'name: Shared reviewer',
      'description: Reviews shared changes',
      'mode: all',
      'model: anthropic/claude#high',
      'permissions:',
      '  - action: shell',
      '    resource: "*"',
      '    effect: ask',
      '---',
      'Use the shared review checklist.',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(paths.repositoryDirectory, 'reviewer.md'),
    [
      '---',
      'color: "#ff6b6b"',
      'steps: 8',
      'permissions:',
      '  - action: shell',
      '    resource: git status',
      '    effect: allow',
      '---',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(paths.workspaceDirectory, 'reviewer.md'),
    '---\nhidden: true\n---\n',
  );

  const result = await listAgentTemplates(paths.cwd);
  const effective = result.templates.find(
    template => template.id === 'reviewer',
  );
  assert.deepEqual(effective, {
    id: 'reviewer',
    key: 'workspace:reviewer',
    name: 'Shared reviewer',
    description: 'Reviews shared changes',
    instructions: 'Use the shared review checklist.',
    mode: 'all',
    context: 'workspace',
    model: 'anthropic/claude',
    thinkingLevel: 'high',
    hidden: true,
    disabled: false,
    color: '#FF6B6B',
    steps: 8,
    permissions: [
      {action: 'shell', resource: '*', effect: 'ask'},
      {action: 'shell', resource: 'git status', effect: 'allow'},
    ],
    permissionsVersion: 1,
    scope: 'workspace',
    sourcePath: join(paths.workspaceDirectory, 'reviewer.md'),
  });
  assert.deepEqual(
    result.allTemplates
      .filter(template => template.id === 'reviewer')
      .map(template => ({
        key: template.key,
        name: template.name,
        instructions: template.instructions,
      })),
    [
      {
        key: 'global:reviewer',
        name: 'Shared reviewer',
        instructions: 'Use the shared review checklist.',
      },
      {key: 'repository:reviewer', name: undefined, instructions: ''},
      {key: 'workspace:reviewer', name: undefined, instructions: ''},
    ],
  );
  const repository = await resolveAgentTemplate(
    paths.cwd,
    'repository:reviewer',
  );
  assert.equal(repository?.name, 'Shared reviewer');
  assert.equal(repository?.scope, 'repository');
  assert.equal(repository?.hidden, false);
  assert.equal(repository?.instructions, 'Use the shared review checklist.');
});

void test('loads optional built-ins and keeps an empty Default selected', async t => {
  const paths = await isolate(t);
  const result = await listAgentTemplates(paths.cwd);
  assert.deepEqual(
    result.sources[0].templates.map(template => template.id),
    builtinIds,
  );
  const commit = result.allTemplates.find(template => template.id === 'commit');
  assert.equal(commit?.mode, 'all');
  assert.equal(commit?.hidden, true);
  assert.equal(
    commit?.sourcePath,
    join(builtinSkillsDirectory, 'commit', 'agents', 'commit.md'),
  );
  const fallback = createDefaultAgentProfile();
  assert.equal(fallback.instructions, '');
  assert.deepEqual(fallback.permissions, []);
  assert.equal(result.defaultAgentId, 'default');
  assert.deepEqual(
    (await resolveDefaultAgentTemplate(paths.cwd)).permissions,
    [],
  );
});

void test('discovers and safely writes nested agent IDs', async t => {
  const paths = await isolate(t);
  const saved = await saveAgentTemplate(paths.cwd, {
    scope: 'repository',
    id: 'team/reviewer',
    mode: 'all',
    context: 'task',
    permissions: [{action: 'edit', resource: '*', effect: 'deny'}],
  });
  assert.equal(
    saved.sourcePath,
    join(paths.repositoryDirectory, 'team', 'reviewer.md'),
  );
  assert.equal(saved.name, undefined);
  assert.equal(saved.instructions, '');
  const effective = await resolveAgentTemplate(paths.cwd, 'team/reviewer');
  assert.equal(effective?.name, 'team/reviewer');
  assert.equal(effective?.mode, 'all');
  assert.equal(effective?.context, 'task');
  assert.deepEqual(effective?.permissions, [
    {action: 'edit', resource: '*', effect: 'deny'},
  ]);
  await deleteAgentTemplate(paths.cwd, {
    scope: 'repository',
    id: 'team/reviewer',
  });
  assert.deepEqual(await readdir(paths.repositoryDirectory), []);

  if (process.platform !== 'win32') {
    await mkdir(paths.globalDirectory, {recursive: true});
    const outside = join(paths.root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(paths.globalDirectory, 'linked'));
    await assert.rejects(
      saveAgentTemplate(paths.cwd, {
        scope: 'global',
        id: 'linked/reviewer',
      }),
      /not a directory/,
    );
    assert.deepEqual(await readdir(outside), []);
    const escaped = join(outside, 'reviewer.md');
    await writeFile(escaped, '---\n---\n');
    await assert.rejects(
      deleteAgentTemplate(paths.cwd, {
        scope: 'global',
        id: 'linked/reviewer',
      }),
      /not a directory/,
    );
    assert.equal(await readFile(escaped, 'utf8'), '---\n---\n');

    const linkedRepository = join(paths.root, 'linked-repository');
    const linkedOutside = join(paths.root, 'linked-config-outside');
    await mkdir(join(linkedRepository, '.git'), {recursive: true});
    await mkdir(linkedOutside);
    await symlink(linkedOutside, join(linkedRepository, CONFIG_DIR_NAME));
    await assert.rejects(
      saveAgentTemplate(linkedRepository, {
        scope: 'repository',
        id: 'reviewer',
      }),
      /configuration path is not a directory/,
    );
    assert.deepEqual(await readdir(linkedOutside), []);
  }
});

void test('falls back to the neutral built-in when Default is unavailable', async t => {
  const paths = await isolate(t);
  await saveAgentTemplate(paths.cwd, {
    scope: 'workspace',
    id: 'default',
    hidden: true,
    permissions: [{action: 'shell', resource: '*', effect: 'deny'}],
  });
  assert.equal(
    (await listAgentTemplates(paths.cwd)).defaultAgentId,
    'builtin:default',
  );
  const fallback = await resolveDefaultAgentTemplate(paths.cwd);
  assert.equal(fallback.key, 'builtin:default');
  assert.equal(fallback.hidden, false);
  assert.deepEqual(fallback.permissions, []);
});

void test('selects default_agent only when it is visible and primary-capable', async t => {
  const paths = await isolate(t);
  await mkdir(paths.agentDir, {recursive: true});
  await writeFile(
    join(paths.agentDir, 'settings.json'),
    JSON.stringify({default_agent: 'writer'}),
  );
  await saveAgentTemplate(paths.cwd, {
    scope: 'global',
    id: 'writer',
    mode: 'all',
  });
  assert.equal((await listAgentTemplates(paths.cwd)).defaultAgentId, 'writer');

  await saveAgentTemplate(paths.cwd, {
    scope: 'workspace',
    id: 'writer',
    hidden: true,
  });
  assert.equal((await listAgentTemplates(paths.cwd)).defaultAgentId, 'default');
  await saveAgentTemplate(paths.cwd, {
    scope: 'workspace',
    id: 'writer',
    mode: 'subagent',
  });
  assert.equal((await listAgentTemplates(paths.cwd)).defaultAgentId, 'default');
  await saveAgentTemplate(paths.cwd, {
    scope: 'workspace',
    id: 'writer',
    mode: 'primary',
    disabled: true,
  });
  assert.equal((await listAgentTemplates(paths.cwd)).defaultAgentId, 'default');
  await saveAgentTemplate(paths.cwd, {
    scope: 'workspace',
    id: 'writer',
    mode: 'primary',
    disabled: false,
  });
  assert.equal((await listAgentTemplates(paths.cwd)).defaultAgentId, 'writer');
  assert.equal(
    (await resolveDefaultAgentTemplate(paths.cwd, 'primary')).id,
    'writer',
  );
  assert.equal(
    (await resolveDefaultAgentTemplate(paths.cwd, 'subagent')).id,
    'default',
  );
});

void test('lists the exact scoped default below higher repository and workspace overrides', async t => {
  const paths = await isolate(t);
  await saveAgentTemplate(paths.cwd, {
    scope: 'global',
    id: 'reviewer',
    name: 'Global reviewer',
    mode: 'all',
    context: 'task',
    model: 'fixture/global',
    instructions: 'Review using global instructions.',
    permissions: [{action: 'shell', resource: '*', effect: 'deny'}],
  });
  await saveAgentTemplate(paths.cwd, {
    scope: 'repository',
    id: 'reviewer',
    name: 'Repository reviewer',
    model: 'fixture/repository',
    instructions: 'Review using repository instructions.',
    permissions: [{action: 'edit', resource: '*', effect: 'deny'}],
  });
  await saveAgentTemplate(paths.cwd, {
    scope: 'workspace',
    id: 'reviewer',
    name: 'Workspace reviewer',
    model: 'fixture/workspace',
    instructions: 'Review using workspace instructions.',
    hidden: true,
    disabled: true,
  });
  for (const scope of ['global', 'repository']) {
    const selector = `${scope}:reviewer`;
    await writeFile(
      join(paths.agentDir, 'settings.json'),
      JSON.stringify({
        default_agent: selector,
        permissions: [{action: 'read', resource: '*', effect: 'ask'}],
      }),
    );
    const listing = await listAgentTemplates(paths.cwd);
    assert.equal(listing.defaultAgentId, selector);
    assert.equal(
      listing.templates.some(template => template.id === 'reviewer'),
      false,
    );
    const expected = await resolveAgentTemplate(paths.cwd, selector);
    assert.deepEqual(listing.defaultAgent, expected);
    assert.deepEqual(await resolveDefaultAgentTemplate(paths.cwd), expected);
    assert.equal(listing.defaultAgent?.scope, scope);
    assert.equal(listing.defaultAgent?.model, `fixture/${scope}`);
    assert.equal(listing.defaultAgent?.hidden, false);
    assert.equal(listing.defaultAgent?.disabled, false);
    assert.deepEqual(listing.defaultAgent?.permissions, [
      {action: 'read', resource: '*', effect: 'ask'},
      {action: 'shell', resource: '*', effect: 'deny'},
      ...(scope === 'repository'
        ? [{action: 'edit', resource: '*', effect: 'deny'}]
        : []),
    ]);
  }
});

void test('scoped defaults fall back when unavailable or invalid without adopting higher overrides', async t => {
  const paths = await isolate(t);
  await saveAgentTemplate(paths.cwd, {
    scope: 'workspace',
    id: 'reviewer',
    mode: 'all',
    hidden: false,
    disabled: false,
  });
  const settingsPath = join(paths.agentDir, 'settings.json');
  await mkdir(paths.agentDir, {recursive: true});
  const assertFallback = async (selector: string) => {
    await writeFile(settingsPath, JSON.stringify({default_agent: selector}));
    const listing = await listAgentTemplates(paths.cwd);
    assert.equal(listing.defaultAgentId, 'default', selector);
    assert.deepEqual(
      listing.defaultAgent,
      await resolveAgentTemplate(paths.cwd, 'default'),
      selector,
    );
    assert.deepEqual(
      await resolveDefaultAgentTemplate(paths.cwd),
      listing.defaultAgent,
    );
  };
  for (const unavailable of [
    {mode: 'all' as const, hidden: true},
    {mode: 'all' as const, disabled: true},
    {mode: 'subagent' as const},
  ]) {
    await saveAgentTemplate(paths.cwd, {
      scope: 'global',
      id: 'reviewer',
      ...unavailable,
    });
    await assertFallback('global:reviewer');
  }
  for (const invalid of [
    'global:missing',
    'missing',
    'invalid:reviewer',
    'global:../reviewer',
    'global:',
  ])
    await assertFallback(invalid);
  await saveAgentTemplate(paths.cwd, {
    scope: 'workspace',
    id: 'default',
    disabled: true,
  });
  const fallback = await listAgentTemplates(paths.cwd);
  assert.equal(fallback.defaultAgentId, 'builtin:default');
  assert.equal(fallback.defaultAgent?.key, 'builtin:default');
  assert.deepEqual(
    fallback.defaultAgent,
    await resolveDefaultAgentTemplate(paths.cwd),
  );
});

void test('prepends shared settings permissions through repository ancestors', async t => {
  const paths = await isolate(t);
  const packages = join(paths.repository, 'packages');
  const nestedRepositoryDirectory = join(packages, CONFIG_DIR_NAME, 'agents');
  const cwdRepositoryDirectory = join(paths.cwd, CONFIG_DIR_NAME, 'agents');
  await mkdir(paths.agentDir, {recursive: true});
  await mkdir(paths.repositoryDirectory, {recursive: true});
  await mkdir(nestedRepositoryDirectory, {recursive: true});
  await mkdir(cwdRepositoryDirectory, {recursive: true});
  await mkdir(paths.workspaceDirectory, {recursive: true});
  await writeFile(
    join(paths.agentDir, 'settings.json'),
    JSON.stringify({
      permissions: [{action: 'shell', resource: '*', effect: 'ask'}],
    }),
  );
  await writeFile(
    join(paths.repository, CONFIG_DIR_NAME, 'settings.json'),
    JSON.stringify({
      permissions: [{action: 'shell', resource: 'rm *', effect: 'deny'}],
    }),
  );
  await writeFile(
    join(packages, CONFIG_DIR_NAME, 'settings.json'),
    JSON.stringify({
      permissions: [{action: 'read', resource: 'packages/**', effect: 'allow'}],
    }),
  );
  await writeFile(
    join(paths.cwd, CONFIG_DIR_NAME, 'settings.json'),
    JSON.stringify({
      permissions: [{action: 'edit', resource: '*', effect: 'ask'}],
    }),
  );
  await writeFile(
    join(paths.workspaceDirectory, '..', 'settings.json'),
    JSON.stringify({
      permissions: [{action: 'shell', resource: 'git status', effect: 'allow'}],
    }),
  );
  await writeFile(
    join(paths.repositoryDirectory, 'reviewer.md'),
    '---\nname: Root reviewer\npermissions:\n  - action: read\n    resource: root/**\n    effect: allow\n---\nUse the root checklist.\n',
  );
  await writeFile(
    join(nestedRepositoryDirectory, 'reviewer.md'),
    '---\nmode: all\npermissions:\n  - action: read\n    resource: packages/private/**\n    effect: deny\n---\n',
  );
  await writeFile(
    join(cwdRepositoryDirectory, 'reviewer.md'),
    '---\nname: App reviewer\n---\n',
  );

  const result = await listAgentTemplates(paths.cwd);
  assert.deepEqual(
    result.sources
      .filter(source => source.scope === 'repository')
      .map(source => source.directory),
    [
      paths.repositoryDirectory,
      nestedRepositoryDirectory,
      cwdRepositoryDirectory,
    ],
  );
  assert.deepEqual(
    result.allTemplates
      .filter(template => template.id === 'reviewer')
      .map(template => template.sourcePath),
    [
      join(paths.repositoryDirectory, 'reviewer.md'),
      join(nestedRepositoryDirectory, 'reviewer.md'),
      join(cwdRepositoryDirectory, 'reviewer.md'),
    ],
  );
  const reviewer = await resolveAgentTemplate(paths.cwd, 'repository:reviewer');
  assert.equal(reviewer?.name, 'App reviewer');
  assert.equal(reviewer?.instructions, 'Use the root checklist.');
  assert.equal(
    reviewer?.sourcePath,
    join(cwdRepositoryDirectory, 'reviewer.md'),
  );
  assert.deepEqual(reviewer?.permissions, [
    {action: 'shell', resource: '*', effect: 'ask'},
    {action: 'shell', resource: 'rm *', effect: 'deny'},
    {action: 'read', resource: 'packages/**', effect: 'allow'},
    {action: 'edit', resource: '*', effect: 'ask'},
    {action: 'shell', resource: 'git status', effect: 'allow'},
    {action: 'read', resource: 'root/**', effect: 'allow'},
    {action: 'read', resource: 'packages/private/**', effect: 'deny'},
  ]);
  const defaultProfile = await resolveDefaultAgentTemplate(paths.cwd);
  assert.deepEqual(
    defaultProfile.permissions,
    reviewer?.permissions.slice(0, 5),
  );
  assert.equal(defaultProfile.permissionsVersion, 1);
});

void test('prepares exact physical sources and pins get snapshots', async t => {
  const paths = await isolate(t);
  const nestedDirectory = join(
    paths.repository,
    'packages',
    CONFIG_DIR_NAME,
    'agents',
  );
  await mkdir(paths.globalDirectory, {recursive: true});
  await mkdir(paths.repositoryDirectory, {recursive: true});
  await mkdir(nestedDirectory, {recursive: true});
  await mkdir(paths.workspaceDirectory, {recursive: true});
  const globalSource = join(paths.globalDirectory, 'reviewer.md');
  const rootSource = join(paths.repositoryDirectory, 'reviewer.md');
  const nestedSource = join(nestedDirectory, 'reviewer.md');
  const workspaceSource = join(paths.workspaceDirectory, 'reviewer.md');
  await writeFile(
    globalSource,
    '---\nname: Global\n---\nGlobal instructions.\n',
  );
  await writeFile(rootSource, '---\nname: Root\n---\n');
  await writeFile(nestedSource, '---\nname: Nested\n---\n');
  await writeFile(workspaceSource, '---\nname: Workspace\n---\n');
  const globalSettings = join(paths.agentDir, 'settings.json');
  const repositorySettings = join(
    paths.repository,
    CONFIG_DIR_NAME,
    'settings.json',
  );
  await writeFile(
    globalSettings,
    JSON.stringify({
      permissions: [{action: 'read', resource: '*', effect: 'ask'}],
    }),
  );
  await writeFile(
    repositorySettings,
    JSON.stringify({
      permissions: [{action: 'read', resource: 'src/**', effect: 'allow'}],
    }),
  );

  const effectiveInput: Record<string, unknown> = {
    action: 'get',
    id: 'reviewer',
  };
  const effective = await prepareAgentTemplateGet(paths.cwd, effectiveInput);
  assert.deepEqual(effective.sourcePaths, [
    globalSettings,
    repositorySettings,
    globalSource,
    rootSource,
    nestedSource,
    workspaceSource,
  ]);
  assert.equal(effective.value.name, 'Workspace');
  const symbol = Object.getOwnPropertySymbols(effectiveInput)[0];
  assert.ok(symbol);
  assert.equal(
    Object.getOwnPropertyDescriptor(effectiveInput, symbol)?.enumerable,
    false,
  );
  await writeFile(workspaceSource, '---\nname: Changed\n---\n');
  assert.equal(
    (await prepareAgentTemplateGet(paths.cwd, effectiveInput)).value.name,
    'Workspace',
  );
  effectiveInput.id = 'writer';
  await assert.rejects(
    prepareAgentTemplateGet(paths.cwd, effectiveInput),
    /selector changed after permission approval/,
  );

  const scoped = await prepareAgentTemplateGet(paths.cwd, {
    action: 'get',
    id: 'repository:reviewer',
  });
  assert.deepEqual(scoped.sourcePaths, [
    globalSettings,
    repositorySettings,
    globalSource,
    rootSource,
    nestedSource,
  ]);
  assert.equal(scoped.value.name, 'Nested');

  const raw = await prepareAgentTemplateGet(paths.cwd, {
    action: 'get',
    id: 'reviewer',
    scope: 'repository',
    sourcePath: rootSource,
  });
  assert.deepEqual(raw.sourcePaths, [rootSource]);
  assert.equal(raw.value.name, 'Root');
  const rawFallback = await prepareAgentTemplateGet(paths.cwd, {
    action: 'get',
    id: 'reviewer',
    scope: 'repository',
  });
  assert.deepEqual(rawFallback.sourcePaths, [nestedSource]);
  assert.equal(rawFallback.value.name, 'Nested');
});

void test('composes shared permissions into a legacy snapshot only once', async t => {
  const paths = await isolate(t);
  await mkdir(paths.agentDir, {recursive: true});
  const settingsPath = join(paths.agentDir, 'settings.json');
  await writeFile(
    settingsPath,
    JSON.stringify({
      permissions: [{action: 'shell', resource: '*', effect: 'ask'}],
    }),
  );
  const legacy = {
    ...createDefaultAgentProfile(),
    request: {headers: {'x-legacy': 'ignored'}},
  };
  assert.equal(legacy.permissionsVersion, undefined);
  const upgraded = await ensureAgentProfilePermissions(paths.cwd, legacy);
  assert.equal(upgraded.instructions, '');
  assert.equal(upgraded.permissionsVersion, 1);
  assert.equal(Object.hasOwn(upgraded, 'request'), false);
  assert.deepEqual(upgraded.permissions, [
    {action: 'shell', resource: '*', effect: 'ask'},
  ]);

  await writeFile(
    settingsPath,
    JSON.stringify({
      permissions: [{action: 'shell', resource: '*', effect: 'deny'}],
    }),
  );
  const currentSnapshot = {
    ...upgraded,
    request: {body: {legacy: true}},
  } as unknown as AgentTemplate;
  assert.deepEqual(
    await ensureAgentProfilePermissions(paths.cwd, currentSnapshot),
    upgraded,
  );
  assert.equal(Object.hasOwn(currentSnapshot, 'request'), true);
});

void test('diagnoses invalid shared settings permissions', async t => {
  const paths = await isolate(t);
  await mkdir(paths.agentDir, {recursive: true});
  await writeFile(
    join(paths.agentDir, 'settings.json'),
    JSON.stringify({permissions: [{action: '', effect: 'permit'}]}),
  );
  const result = await listAgentTemplates(paths.cwd);
  const listedDefault = result.templates.find(
    template => template.id === 'default',
  )!;
  assert.deepEqual(listedDefault.permissions, []);
  assert.equal(listedDefault.permissionsVersion, undefined);
  assert.match(
    result.diagnostics.find(item => item.scope === 'global')?.message ?? '',
    /Invalid shared agent permissions: Agent template permissions\[0\]\.action/,
  );
  await assert.rejects(
    resolveDefaultAgentTemplate(paths.cwd),
    /Cannot resolve agent profile because shared permissions are invalid/,
  );
  await assert.rejects(
    ensureAgentProfilePermissions(paths.cwd, listedDefault),
    /Cannot resolve agent profile because shared permissions are invalid/,
  );
});

void test('targets nested repository definitions by sourcePath', async t => {
  const paths = await isolate(t);
  const packagesDirectory = join(
    paths.repository,
    'packages',
    CONFIG_DIR_NAME,
    'agents',
  );
  await mkdir(paths.repositoryDirectory, {recursive: true});
  await mkdir(packagesDirectory, {recursive: true});
  const rootSource = join(paths.repositoryDirectory, 'reviewer.md');
  const packageSource = join(packagesDirectory, 'reviewer.md');
  await writeFile(rootSource, '---\nname: Root\n---\nRoot instructions.\n');
  await writeFile(packageSource, '---\nname: Package\n---\n');

  const saved = await saveAgentTemplate(paths.cwd, {
    scope: 'repository',
    id: 'reviewer',
    sourcePath: packageSource,
    name: 'Updated package',
    instructions: '',
  });
  assert.equal(saved.sourcePath, packageSource);
  assert.match(await readFile(rootSource, 'utf8'), /name: Root/);
  assert.match(
    await readFile(packageSource, 'utf8'),
    /name: "Updated package"/,
  );
  assert.equal(
    (await resolveAgentTemplate(paths.cwd, 'repository:reviewer'))?.name,
    'Updated package',
  );

  await deleteAgentTemplate(paths.cwd, {
    scope: 'repository',
    id: 'reviewer',
    sourcePath: packageSource,
  });
  assert.equal((await lstat(rootSource)).isFile(), true);
  await assert.rejects(lstat(packageSource), /ENOENT/);
  await assert.rejects(
    saveAgentTemplate(paths.cwd, {
      scope: 'repository',
      id: 'reviewer',
      sourcePath: join(
        paths.repository,
        'undiscovered',
        CONFIG_DIR_NAME,
        'agents',
        'reviewer.md',
      ),
    }),
    /must match the selected scope, ID, and a discovered configuration directory/,
  );
  await assert.rejects(
    deleteAgentTemplate(paths.cwd, {
      scope: 'repository',
      id: 'different',
      sourcePath: rootSource,
    }),
    /must match the selected scope, ID, and a discovered configuration directory/,
  );
});

void test('reports malformed files without hiding valid templates', async t => {
  const paths = await isolate(t);
  await mkdir(paths.globalDirectory, {recursive: true});
  await mkdir(paths.repositoryDirectory, {recursive: true});
  await writeFile(
    join(paths.globalDirectory, 'valid.md'),
    '---\nname: Valid\n---\nUseful instructions.\n',
  );
  await writeFile(
    join(paths.globalDirectory, 'Bad Name.md'),
    '---\nname: Bad slug\n---\nInstructions.\n',
  );
  await writeFile(
    join(paths.repositoryDirectory, 'broken.md'),
    '---\nname: Broken\nthinkingLevel: enormous\n---\nInstructions.\n',
  );
  await writeFile(
    join(paths.repositoryDirectory, 'unknown.md'),
    '---\nname: Unknown\nrequest:\n  headers:\n    x-old: ignored\n---\nInstructions.\n',
  );
  await mkdir(join(paths.repositoryDirectory, 'directory.md'));

  const result = await listAgentTemplates(paths.cwd);
  assert.deepEqual(
    result.templates.map(template => template.id),
    [...builtinIds, 'valid'],
  );
  assert.equal(result.diagnostics.length, 4);
  assert.match(
    result.diagnostics.find(item => item.sourcePath.endsWith('Bad Name.md'))!
      .message,
    /lowercase path of filename slugs/,
  );
  assert.match(
    result.diagnostics.find(item => item.sourcePath.endsWith('broken.md'))!
      .message,
    /thinkingLevel.*off.*max/,
  );
  assert.match(
    result.diagnostics.find(item => item.sourcePath.endsWith('unknown.md'))!
      .message,
    /Unknown frontmatter field: request/,
  );
  assert.match(
    result.diagnostics.find(item => item.sourcePath.endsWith('directory.md'))!
      .message,
    /regular Markdown file/,
  );
});

void test('saves editable frontmatter atomically in each scope and deletes exact files', async t => {
  const paths = await isolate(t);
  const global = await saveAgentTemplate(paths.cwd, {
    scope: 'global',
    id: 'release-review',
    name: 'Release "review"',
    description: 'Review before release',
    instructions: 'Inspect tests and packaging.\nReport blockers.',
    model: 'openai/gpt-5',
    thinkingLevel: 'xhigh',
  });
  const repository = await saveAgentTemplate(paths.cwd, {
    scope: 'repository',
    id: 'implementation',
    name: 'Implementation',
    instructions: 'Implement the requested change.',
  });
  const workspace = await saveAgentTemplate(paths.cwd, {
    scope: 'workspace',
    id: 'personal-review',
    name: 'Personal review',
    instructions: 'Apply my local review preferences.',
  });
  assert.equal(
    global.sourcePath,
    join(paths.globalDirectory, 'release-review.md'),
  );
  assert.equal(
    repository.sourcePath,
    join(paths.repositoryDirectory, 'implementation.md'),
  );
  assert.equal(
    workspace.sourcePath,
    join(paths.workspaceDirectory, 'personal-review.md'),
  );
  assert.equal(global.key, 'global:release-review');
  assert.match(
    await readFile(global.sourcePath, 'utf8'),
    /^---\nname: "Release \\"review\\""/,
  );
  assert.deepEqual(
    (await listAgentTemplates(paths.cwd)).templates.map(
      template => template.id,
    ),
    [
      ...builtinIds,
      'implementation',
      'personal-review',
      'release-review',
    ].sort(),
  );
  if (process.platform !== 'win32') {
    assert.equal((await lstat(global.sourcePath)).mode & 0o777, 0o600);
    assert.equal((await lstat(repository.sourcePath)).mode & 0o777, 0o644);
    assert.equal((await lstat(workspace.sourcePath)).mode & 0o777, 0o600);
  }
  await deleteAgentTemplate(paths.cwd, {
    scope: 'repository',
    id: 'implementation',
  });
  await deleteAgentTemplate(paths.cwd, {
    scope: 'repository',
    id: 'implementation',
  });
  assert.deepEqual(await readdir(paths.repositoryDirectory), []);
});

void test('updates serialize through one atomic destination and copy caller input', async t => {
  const paths = await isolate(t);
  const input = {
    scope: 'global' as const,
    id: 'worker',
    name: 'First',
    instructions: 'First instructions.',
    permissions: [{action: 'read', resource: 'first.txt', effect: 'allow'}],
  };
  const first = saveAgentTemplate(paths.cwd, input);
  input.name = 'Mutated after call';
  input.instructions = 'Mutated after call.';
  input.permissions[0].resource = 'mutated.txt';
  const initial = await first;
  assert.equal(initial.name, 'First');
  assert.equal(initial.instructions, 'First instructions.');
  assert.deepEqual(initial.permissions, [
    {action: 'read', resource: 'first.txt', effect: 'allow'},
  ]);
  await Promise.all(
    Array.from({length: 12}, (_, index) =>
      saveAgentTemplate(paths.cwd, {
        scope: 'global',
        id: 'worker',
        name: `Worker ${index}`,
        instructions: `Instructions ${index}.`,
      }),
    ),
  );
  const saved = await resolveAgentTemplate(paths.cwd, 'worker');
  assert.equal(saved?.name, 'Worker 11');
  assert.equal(saved?.instructions, 'Instructions 11.');
  assert.deepEqual(await readdir(paths.globalDirectory), ['worker.md']);
  const removed = deleteAgentTemplate(paths.cwd, {
    scope: 'global',
    id: 'worker',
  });
  const recreated = saveAgentTemplate(paths.cwd, {
    scope: 'global',
    id: 'worker',
    instructions: 'Recreated after deletion.',
  });
  await Promise.all([removed, recreated]);
  assert.equal(
    (await resolveAgentTemplate(paths.cwd, 'worker'))?.instructions,
    'Recreated after deletion.',
  );
});

void test('template mutations share destinations through workspace and settings aliases before creation', async t => {
  const paths = await isolate(t);
  const repositoryAlias = join(paths.root, 'repository-alias');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(paths.repository, repositoryAlias, linkType);
  const aliasCwd = join(repositoryAlias, 'packages', 'app');
  const workspaceSaves = await Promise.all(
    Array.from({length: 12}, (_, index) =>
      saveAgentTemplate(index % 2 ? aliasCwd : paths.cwd, {
        scope: 'workspace',
        id: 'team/worker',
        instructions: `Workspace ${index}.`,
      }),
    ),
  );
  assert.equal(new Set(workspaceSaves.map(saved => saved.sourcePath)).size, 1);
  assert.equal(
    (await resolveAgentTemplate(aliasCwd, 'team/worker'))?.instructions,
    'Workspace 11.',
  );

  const settingsRoot = join(paths.root, 'settings-root');
  const settingsAlias = join(paths.root, 'settings-alias');
  await mkdir(settingsRoot);
  await symlink(settingsRoot, settingsAlias, linkType);
  const settingsHomes = [settingsRoot, settingsAlias].map(path =>
    join(path, 'missing', 'home'),
  );
  const saves = Array.from({length: 12}, (_, index) => {
    process.env.PI_CODING_AGENT_DIR = settingsHomes[index % 2];
    return saveAgentTemplate(paths.cwd, {
      scope: 'global',
      id: 'team/worker',
      instructions: `Global ${index}.`,
    });
  });
  await Promise.all(saves);
  assert.equal(
    (await resolveAgentTemplate(paths.cwd, 'team/worker'))?.instructions,
    'Global 11.',
  );
  const removed = deleteAgentTemplate(paths.cwd, {
    scope: 'global',
    id: 'team/worker',
  });
  process.env.PI_CODING_AGENT_DIR = settingsHomes[0];
  const recreated = saveAgentTemplate(paths.cwd, {
    scope: 'global',
    id: 'team/worker',
    instructions: 'Recreated through the canonical settings path.',
  });
  await Promise.all([removed, recreated]);
  assert.equal(
    (await resolveAgentTemplate(paths.cwd, 'team/worker'))?.instructions,
    'Recreated through the canonical settings path.',
  );
  assert.deepEqual(await readdir(join(settingsHomes[0], 'agents', 'team')), [
    'worker.md',
  ]);
});

void test('refuses invalid input and will not replace or delete unexpected files', async t => {
  const paths = await isolate(t);
  const base = {
    scope: 'global' as const,
    id: 'safe',
    name: 'Safe',
    instructions: 'Instructions.',
  };
  const invalid: unknown[] = [
    null,
    [],
    'template',
    {...base, extra: true},
    {...base, id: '../escape'},
    {...base, id: 'Uppercase'},
    {...base, model: 'missing-slash'},
    {...base, model: 'p/has space'},
    {...base, thinkingLevel: 'extreme' as 'high'},
    {...base, mode: 'worker'},
    {...base, context: 'session'},
    {...base, hidden: 'true'},
    {...base, color: '#abc'},
    {...base, steps: 0},
    {...base, permissions: [{action: 'read', resource: '*', effect: 'maybe'}]},
    {...base, request: {}},
    {...base, sourcePath: 'relative/safe.md'},
    {...base, scope: 'machine' as 'global'},
    {...base, scope: 'builtin' as 'global'},
  ];
  for (const input of invalid)
    await assert.rejects(saveAgentTemplate(paths.cwd, input));
  await assert.rejects(resolveAgentTemplate(paths.cwd, 3), /id or key/);
  await assert.rejects(
    deleteAgentTemplate(paths.cwd, {scope: 'builtin', id: 'commit'}),
    /read-only/,
  );
  await assert.rejects(
    deleteAgentTemplate(paths.cwd, {scope: 'global', id: 'safe', extra: true}),
    /Unknown agent template field/,
  );

  await mkdir(paths.globalDirectory, {recursive: true});
  const unexpected = join(paths.globalDirectory, 'safe.md');
  await writeFile(unexpected, '---\ntemperature: 1\n---\nordinary notes\n');
  await assert.rejects(
    saveAgentTemplate(paths.cwd, base),
    /Refusing to replace malformed agent template/,
  );
  await assert.rejects(
    deleteAgentTemplate(paths.cwd, {scope: 'global', id: 'safe'}),
    /Refusing to replace malformed agent template/,
  );
  assert.equal(
    await readFile(unexpected, 'utf8'),
    '---\ntemperature: 1\n---\nordinary notes\n',
  );
});

void test('workspace templates are machine-local, repository-wide, and isolated by canonical project', async t => {
  const paths = await isolate(t);
  const first = await saveAgentTemplate(paths.cwd, {
    scope: 'workspace',
    id: 'personal',
    name: 'First workspace preferences',
    instructions: 'Use preferences for the first repository.',
  });
  const relativeSource = relative(paths.agentDir, first.sourcePath);
  assert.equal(isAbsolute(relativeSource), false);
  assert.equal(
    relativeSource === '..' || relativeSource.startsWith(`..${sep}`),
    false,
  );

  const deeper = join(paths.repository, 'other', 'nested');
  await mkdir(deeper, {recursive: true});
  assert.equal(
    (await resolveAgentTemplate(deeper, 'personal'))?.sourcePath,
    first.sourcePath,
  );

  const otherRepository = join(paths.root, 'other-repository');
  const otherCwd = join(otherRepository, 'nested');
  await mkdir(join(otherRepository, '.git'), {recursive: true});
  await mkdir(otherCwd);
  const second = await saveAgentTemplate(otherCwd, {
    scope: 'workspace',
    id: 'personal',
    name: 'Second workspace preferences',
    instructions: 'Use preferences for the second repository.',
  });
  assert.notEqual(first.sourcePath, second.sourcePath);
  assert.equal(
    (await resolveAgentTemplate(paths.cwd, 'personal'))?.name,
    'First workspace preferences',
  );
  assert.equal(
    (await resolveAgentTemplate(otherCwd, 'personal'))?.name,
    'Second workspace preferences',
  );
});

void test('uses cwd as the repository scope when no git ancestor exists', async t => {
  const paths = await isolate(t);
  const standalone = join(paths.root, 'standalone');
  await mkdir(join(standalone, CONFIG_DIR_NAME), {recursive: true});
  await saveAgentTemplate(standalone, {
    scope: 'repository',
    id: 'local',
    name: 'Local',
    instructions: 'Stay in this folder.',
  });
  const listed = await listAgentTemplates(standalone);
  const config = workspaceConfigPaths(standalone, paths.agentDir);
  assert.equal(config.projectDir, standalone);
  assert.equal(
    listed.sources.find(source => source.scope === 'repository')?.directory,
    join(config.repositoryConfigDir, 'agents'),
  );
  assert.equal(
    listed.templates.find(template => template.id === 'local')?.sourcePath,
    join(config.repositoryConfigDir, 'agents', 'local.md'),
  );
});
