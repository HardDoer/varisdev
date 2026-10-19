import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {createServer, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import {Type} from 'typebox';
import {
  createAgentSession,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import {workspaceConfigPaths} from '../src/dashboard/workspace-config.ts';
import {registerJsonQueryTool} from '../src/tools/json-query.ts';
import {
  AGENT_STEP_SUMMARY,
  agentCatalogAllows,
  agentToolPermissions,
  createAgentPolicyExtension,
  decideAgentPermission,
  evaluateAgentPermission,
  isAgentToolWhollyDenied,
  type AgentPermissionRule,
} from '../src/agents/policy.ts';

function permissionPath(path: string): string {
  return path.replaceAll('\\', '/');
}

type Handler = (
  event: Record<string, unknown>,
  ctx: ExtensionContext,
) => unknown;
function harness(
  factory: ExtensionFactory,
  signal?: AbortSignal,
  initial?: {
    tools?: string[];
    entries?: Array<{type: 'custom'; customType: string; data: unknown}>;
  },
) {
  const handlers = new Map<string, Handler>();
  const entries = initial?.entries ?? [];
  let tools = initial?.tools ?? ['read', 'write', 'bash', 'agent_spawn'];
  let confirmations = 0;
  const notifications: string[] = [];
  const ctx = {
    cwd: '/workspace',
    hasUI: false,
    signal,
    sessionManager: {getBranch: () => entries},
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      async confirm() {
        confirmations++;
        return true;
      },
      async select() {
        confirmations++;
        return 'Allow once';
      },
    },
    abort() {},
  } as unknown as ExtensionContext;
  const api = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    getActiveTools() {
      return [...tools];
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({type: 'custom', customType, data});
    },
    setActiveTools(names: string[]) {
      tools = [...names];
    },
  } as unknown as ExtensionAPI;
  void factory(api);
  return {
    ctx,
    entries,
    notifications,
    setTools(names: string[]) {
      tools = [...names];
    },
    get tools() {
      return tools;
    },
    get confirmations() {
      return confirmations;
    },
    emit(name: string, event: Record<string, unknown> = {}) {
      return handlers.get(name)?.({type: name, ...event}, ctx);
    },
    async call(
      toolName: string,
      input: Record<string, unknown>,
      nested = false,
    ) {
      return (await handlers.get('tool_call')?.(
        {
          type: 'tool_call',
          toolName,
          input,
          toolCallId: 'call/1',
          ...(nested ? {parentToolCallId: 'call'} : {}),
        },
        ctx,
      )) as ToolCallEventResult;
    },
  };
}

void test('ordered permissions match canonical actions, tool wildcards, and resource wildcards', () => {
  const permissions: AgentPermissionRule[] = [
    {action: '*', resource: '*', effect: 'deny'},
    {action: 'read', resource: 'src/**', effect: 'allow'},
    {action: 'read', resource: 'src/private/*', effect: 'ask'},
    {action: 'json_*', resource: 'public?.json', effect: 'allow'},
  ];
  assert.equal(
    evaluateAgentPermission(undefined, 'shell', 'git status'),
    'allow',
  );
  assert.equal(
    evaluateAgentPermission(permissions, 'read', 'src/app.ts'),
    'allow',
  );
  assert.equal(
    evaluateAgentPermission(permissions, 'read', 'src/private/token'),
    'ask',
  );
  assert.equal(
    evaluateAgentPermission(permissions, 'edit', 'src/app.ts'),
    'deny',
  );
  assert.equal(
    evaluateAgentPermission(permissions, 'read', './src/app.ts'),
    'allow',
  );
  assert.equal(
    evaluateAgentPermission(
      permissions,
      'read',
      '/workspace/src/app.ts',
      '/workspace',
    ),
    'allow',
  );
  assert.equal(
    evaluateAgentPermission(permissions, 'read', 'src/../secret'),
    'deny',
  );
  assert.equal(
    decideAgentPermission({permissions}, 'read', 'public1.json', 'json_query'),
    'allow',
  );
  assert.equal(
    decideAgentPermission({permissions}, 'read', 'public11.json', 'json_query'),
    'deny',
  );
  assert.equal(
    evaluateAgentPermission(
      [{action: 'read', resource: 'a[b].ts', effect: 'deny'}],
      'read',
      'a[b].ts',
    ),
    'deny',
  );
});

void test('home expansion applies only to leading rule patterns and leaves request paths literal', () => {
  const home = process.env.HOME ?? tmpdir();
  for (const action of ['read', 'edit', 'external_directory']) {
    assert.equal(
      evaluateAgentPermission(
        [{action, resource: '~/notes/**', effect: 'deny'}],
        action,
        `${home}/notes/file`,
      ),
      'deny',
    );
    assert.equal(
      evaluateAgentPermission(
        [{action, resource: '$HOME/notes/**', effect: 'deny'}],
        action,
        `${home}/notes/file`,
      ),
      'deny',
    );
  }
  assert.equal(
    evaluateAgentPermission(
      [{action: 'read', resource: '$HOME/notes/**', effect: 'deny'}],
      'read',
      '$HOME/notes/file',
    ),
    'allow',
  );
  assert.equal(
    evaluateAgentPermission(
      [{action: 'read', resource: 'notes/$HOME/**', effect: 'deny'}],
      'read',
      'notes/$HOME/file',
    ),
    'deny',
  );
  assert.equal(
    evaluateAgentPermission(
      [{action: 'read', resource: '~/notes/**', effect: 'deny'}],
      'read',
      '~/notes/file',
    ),
    'allow',
  );
  assert.equal(
    evaluateAgentPermission(
      [{action: 'shell', resource: 'cat $HOME/*', effect: 'deny'}],
      'shell',
      `cat ${home}/secret`,
    ),
    'allow',
  );
  assert.equal(
    evaluateAgentPermission(
      [{action: 'shell', resource: 'cat $HOME/*', effect: 'deny'}],
      'shell',
      'cat $HOME/secret',
    ),
    'deny',
  );
});

void test('tool mappings include VarisDev mutators, patch destinations, and actual template IDs', () => {
  const cwd = resolve('/workspace');
  for (const name of [
    'read',
    'json_query',
    'gamemaker_query',
    'image_query',
    'image_preview',
  ])
    assert.deepEqual(agentToolPermissions(name, {path: '@src/app.ts'}), [
      {action: 'read', resource: 'src/app.ts'},
    ]);
  for (const name of ['write', 'edit', 'download'])
    assert.deepEqual(agentToolPermissions(name, {path: 'src/app.ts'}), [
      {action: 'edit', resource: 'src/app.ts'},
    ]);
  assert.deepEqual(agentToolPermissions('bash', {command: 'echo $HOME'}), [
    {action: 'shell', resource: 'echo $HOME'},
  ]);
  assert.deepEqual(agentToolPermissions('find', {pattern: '*.ts'}), [
    {action: 'glob', resource: '*.ts'},
  ]);
  assert.deepEqual(agentToolPermissions('ls', {path: 'src'}), [
    {action: 'list', resource: 'src'},
  ]);
  assert.deepEqual(
    agentToolPermissions('grep', {pattern: 'password', path: 'src'}),
    [{action: 'grep', resource: 'password'}],
  );
  assert.deepEqual(
    agentToolPermissions('browse', {url: 'https://example.com'}),
    [{action: 'webfetch', resource: 'https://example.com'}],
  );
  assert.deepEqual(
    agentToolPermissions('apply_patch', {
      patch: '*** Update File: a.ts\n*** Move to: b.ts\n*** Add File: c.ts',
    }).map(entry => entry.resource),
    ['a.ts', 'b.ts', 'c.ts'],
  );
  assert.deepEqual(
    agentToolPermissions('agent_spawn', {
      template: 'workspace:explore',
      name: 'build',
    }),
    [{action: 'subagent', resource: 'explore'}],
  );
  assert.deepEqual(agentToolPermissions('agent_spawn', {name: 'explore'}), [
    {action: 'subagent', resource: 'default'},
  ]);
  assert.equal(
    agentToolPermissions('agent_templates', {action: 'save', id: 'reviewer'})[0]
      .action,
    'edit',
  );
  assert.equal(
    agentToolPermissions('agent_templates', {action: 'get', id: 'reviewer'})[0]
      .action,
    'read',
  );
  assert.deepEqual(
    agentToolPermissions(
      'openai_image',
      {
        inputImagePaths: ['a.png'],
        outputDir: 'images',
      },
      cwd,
    ),
    [
      {action: 'read', resource: permissionPath(join(cwd, 'a.png'))},
      {action: 'edit', resource: permissionPath(join(cwd, 'images', '**'))},
    ],
  );
  assert.deepEqual(agentToolPermissions('custom_tool', {path: 'a.txt'}), [
    {action: 'custom_tool', resource: 'a.txt'},
  ]);
  assert.deepEqual(agentToolPermissions('query', {path: 'a.txt'}), [
    {action: 'query', resource: 'a.txt'},
  ]);
  assert.deepEqual(agentToolPermissions('read', {path: '../secret'}, cwd), [
    {action: 'read', resource: permissionPath(resolve(cwd, '../secret'))},
    {
      action: 'external_directory',
      resource: permissionPath(resolve(cwd, '../secret')),
    },
  ]);
});

void test('media permissions use actual trimmed and environment-resolved paths without normalizing them twice', async t => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'varisdev-policy-media-')),
  );
  const cwd = join(root, 'project');
  const outside = join(root, 'outside');
  const previous = process.env.OPENAI_IMAGE_OUTPUT_DIR;
  t.after(async () => {
    if (previous === undefined) delete process.env.OPENAI_IMAGE_OUTPUT_DIR;
    else process.env.OPENAI_IMAGE_OUTPUT_DIR = previous;
    await rm(root, {recursive: true, force: true});
  });
  await mkdir(join(cwd, '.git'), {recursive: true});
  await mkdir(outside);
  process.env.OPENAI_IMAGE_OUTPUT_DIR = outside;
  const outsideGuard = harness(
    createAgentPolicyExtension({
      permissions: [
        {action: 'external_directory', resource: '*', effect: 'deny'},
      ],
    }),
  );
  outsideGuard.ctx.cwd = cwd;
  for (const outputDir of [undefined, '', '   ']) {
    const denied = await outsideGuard.call('openai_image', {
      prompt: 'Fixture',
      outputDir,
    });
    assert.match(denied.reason!, /permission denied: external_directory/);
    assert.ok(denied.reason!.includes(permissionPath(outside)));
  }
  const protectedGuard = harness(
    createAgentPolicyExtension({
      permissions: [
        {action: 'edit', resource: 'protected/**', effect: 'deny'},
        {action: 'edit', resource: 'literal /**', effect: 'deny'},
      ],
    }),
  );
  protectedGuard.ctx.cwd = cwd;
  for (const outputDir of ['protected \t', 'literal /.']) {
    const denied = await protectedGuard.call('openai_image', {
      prompt: 'Fixture',
      outputDir,
    });
    assert.match(denied.reason!, /permission denied: edit/);
  }
  const outsideImage = join(outside, 'source.png');
  await writeFile(outsideImage, 'Fixture bytes.');
  await writeFile(join(cwd, '@source.png'), 'Internal shadow.');
  await symlink(outsideImage, join(cwd, '@source.png '));
  const input = {
    inputImagePaths: ['@@source.png /.'],
    outputDir: 'safe',
    prompt: 'Fixture',
  };
  const denied = await outsideGuard.call('openai_image', input);
  assert.match(denied.reason!, /permission denied: external_directory/);
  assert.ok(
    denied.reason!.includes(permissionPath(outsideImage)),
    'the resolved literal @ and trailing space identify the actual image',
  );
});

void test('template mutations check physical scoped paths and outside-directory permissions', async t => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'varisdev-policy-template-paths-')),
  );
  const agentDir = join(root, 'config');
  const project = join(root, 'project');
  await mkdir(join(project, '.git'), {recursive: true});
  const cwd = await realpath(project);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, {recursive: true, force: true});
  });
  const paths = workspaceConfigPaths(cwd, agentDir);
  const targets = {
    global: join(agentDir, 'agents', 'src', 'helper.md'),
    workspace: join(paths.workspaceDir, 'agents', 'src', 'helper.md'),
    repository: join(paths.repositoryConfigDir, 'agents', 'src', 'helper.md'),
  };
  const projectEdits = harness(
    createAgentPolicyExtension({
      permissions: [
        {action: 'edit', resource: '*', effect: 'deny'},
        {action: 'edit', resource: 'src/**', effect: 'allow'},
      ],
    }),
  );
  projectEdits.ctx.cwd = cwd;
  const outsideGuard = harness(
    createAgentPolicyExtension({
      permissions: [
        {action: 'external_directory', resource: '*', effect: 'deny'},
      ],
    }),
  );
  outsideGuard.ctx.cwd = cwd;
  for (const action of ['save', 'delete']) {
    for (const scope of ['global', 'workspace', 'repository'] as const) {
      const input = {action, scope, id: 'src/helper'};
      const outside = scope !== 'repository';
      assert.deepEqual(agentToolPermissions('agent_templates', input, cwd), [
        {action: 'edit', resource: permissionPath(targets[scope])},
        ...(outside
          ? [
              {
                action: 'external_directory',
                resource: permissionPath(targets[scope]),
              },
            ]
          : []),
      ]);
      assert.equal(
        (await projectEdits.call('agent_templates', input)).block,
        true,
        'an id matching src/** does not grant access to its configuration file',
      );
      const decision = await outsideGuard.call('agent_templates', input);
      if (outside) assert.match(decision.reason!, /external_directory/);
      else assert.equal(decision, undefined);
    }
  }
});

void test('template mutations authorize an explicit ancestor sourcePath', async t => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'varisdev-policy-source-')),
  );
  t.after(() => rm(root, {recursive: true, force: true}));
  const cwd = join(root, 'packages', 'app');
  const sourcePath = join(root, '.pi', 'agents', 'helper.md');
  await mkdir(cwd, {recursive: true});
  await mkdir(join(root, '.git'));
  const h = harness(
    createAgentPolicyExtension({
      permissions: [{action: 'edit', resource: sourcePath, effect: 'deny'}],
    }),
  );
  h.ctx.cwd = cwd;
  for (const action of ['save', 'delete']) {
    const input = {action, scope: 'repository', id: 'helper', sourcePath};
    assert.equal(
      agentToolPermissions('agent_templates', input, cwd)[0].resource,
      permissionPath(sourcePath),
    );
    assert.match(
      (await h.call('agent_templates', input, true)).reason!,
      /permission denied: edit/,
    );
  }
});

void test('template gets authorize actual raw and effective definition sources', async t => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'varisdev-policy-template-read-')),
  );
  const agentDir = join(root, 'config');
  const project = join(root, 'project');
  const cwd = join(project, 'packages', 'app');
  const globalPath = join(agentDir, 'agents', 'src', 'helper.md');
  const rootRepositoryPath = join(project, '.pi', 'agents', 'src', 'helper.md');
  const nestedRepositoryPath = join(cwd, '.pi', 'agents', 'src', 'helper.md');
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, {recursive: true, force: true});
  });
  await mkdir(join(project, '.git'), {recursive: true});
  for (const path of [globalPath, rootRepositoryPath, nestedRepositoryPath]) {
    await mkdir(join(path, '..'), {recursive: true});
    await writeFile(
      path,
      '---\nname: Helper\n---\nPhysical helper instructions.\n',
    );
  }
  const readGuard = harness(
    createAgentPolicyExtension({
      permissions: [
        {action: 'read', resource: '*', effect: 'deny'},
        {action: 'read', resource: 'src/**', effect: 'allow'},
      ],
    }),
  );
  readGuard.ctx.cwd = cwd;
  const outsideGuard = harness(
    createAgentPolicyExtension({
      permissions: [
        {action: 'external_directory', resource: '*', effect: 'deny'},
      ],
    }),
  );
  outsideGuard.ctx.cwd = cwd;
  const contributingGuard = harness(
    createAgentPolicyExtension({
      permissions: [{action: 'read', resource: globalPath, effect: 'deny'}],
    }),
  );
  contributingGuard.ctx.cwd = cwd;
  const allDenied = harness(
    createAgentPolicyExtension({
      permissions: [
        {action: 'read', resource: '*', effect: 'deny'},
        {action: 'edit', resource: '*', effect: 'deny'},
      ],
    }),
  );
  allDenied.ctx.cwd = cwd;
  assert.match(
    (
      await allDenied.call('agent_templates', {
        action: 'get',
        id: 'src/helper',
        scope: 'global',
      })
    ).reason!,
    /permission denied: read/,
  );
  for (const scope of ['global', 'repository']) {
    const denied = await readGuard.call(
      'agent_templates',
      {action: 'get', id: 'src/helper', scope},
      true,
    );
    assert.match(denied.reason!, /permission denied: read/);
    assert.ok(
      denied.reason!.includes(
        permissionPath(scope === 'global' ? globalPath : nestedRepositoryPath),
      ),
    );
  }
  const global = await outsideGuard.call('agent_templates', {
    action: 'get',
    id: 'src/helper',
    scope: 'global',
    sourcePath: globalPath,
  });
  assert.match(global.reason!, /permission denied: external_directory/);
  for (const sourcePath of [rootRepositoryPath, nestedRepositoryPath])
    assert.equal(
      await outsideGuard.call('agent_templates', {
        action: 'get',
        id: 'src/helper',
        scope: 'repository',
        sourcePath,
      }),
      undefined,
      'raw repository reads check only their selected physical definition',
    );
  for (const id of ['src/helper', 'repository:src/helper']) {
    const effective = await outsideGuard.call('agent_templates', {
      action: 'get',
      id,
    });
    assert.match(effective.reason!, /permission denied: external_directory/);
    assert.ok(
      effective.reason!.includes(permissionPath(globalPath)),
      'effective gets authorize lower contributing scopes too',
    );
    const contributor = await contributingGuard.call('agent_templates', {
      action: 'get',
      id,
    });
    assert.match(contributor.reason!, /permission denied: read/);
    assert.ok(contributor.reason!.includes(permissionPath(globalPath)));
  }
  assert.equal(
    await readGuard.call('query', {path: 'src/helper'}),
    undefined,
    'an unknown custom query tool is governed by its own action',
  );
  const customGuard = harness(
    createAgentPolicyExtension({
      permissions: [{action: 'query', resource: '*', effect: 'deny'}],
    }),
  );
  assert.match(
    (await customGuard.call('query', {path: 'src/helper'})).reason!,
    /permission denied: query/,
  );
});

void test('shell permissions inspect compound, piped and nested commands before execution', async () => {
  const h = harness(
    createAgentPolicyExtension({
      permissions: [{action: 'shell', resource: 'git push *', effect: 'deny'}],
    }),
  );
  for (const command of [
    'echo harmless; git push origin main',
    'echo harmless | git push origin main',
    'true && git push origin main',
    'false || git push origin main',
    'if true; then git push origin main; fi',
    'echo "$(git push origin main)"',
    'cat <(git push origin main)',
    'echo `git push origin main`',
    'git\t"push" origin main',
    'echo $((1 + $(git push origin main)))',
  ])
    assert.match(
      (await h.call('bash', {command}, true)).reason!,
      /permission denied: shell .*git/,
    );
  for (const command of [
    'echo harmless',
    "echo 'git push origin main'",
    "cat <<'EOF'\ngit push origin main\nEOF",
    'echo "$unknown"',
  ])
    assert.equal(await h.call('bash', {command}), undefined, command);
});

void test('shell command aliases share ordered decisions and exact component allows compose', async () => {
  const components = harness(
    createAgentPolicyExtension({
      permissions: [
        {action: 'shell', resource: '*', effect: 'deny'},
        {action: 'shell', resource: 'pwd', effect: 'allow'},
        {action: 'shell', resource: 'ls', effect: 'allow'},
      ],
    }),
  );
  assert.equal(await components.call('bash', {command: 'pwd; ls'}), undefined);
  assert.equal(await components.call('bash', {command: 'pwd | ls'}), undefined);
  assert.equal(
    (await components.call('bash', {command: 'pwd; git push'})).block,
    true,
  );
  const quotedAllow: AgentPermissionRule[] = [
    {action: 'shell', resource: '*', effect: 'deny'},
    {action: 'shell', resource: "cat 'file with spaces'", effect: 'allow'},
  ];
  const quoted = harness(
    createAgentPolicyExtension({permissions: quotedAllow}),
  );
  assert.equal(
    await quoted.call('bash', {command: "cat 'file with spaces'"}),
    undefined,
  );
  const laterDeny = harness(
    createAgentPolicyExtension({
      permissions: [
        ...quotedAllow,
        {action: 'shell', resource: 'cat file with spaces', effect: 'deny'},
      ],
    }),
  );
  assert.equal(
    (await laterDeny.call('bash', {command: "cat 'file with spaces'"})).block,
    true,
  );
  const cookedAllow = harness(
    createAgentPolicyExtension({
      permissions: [
        {action: 'shell', resource: '*', effect: 'deny'},
        {action: 'shell', resource: 'git status', effect: 'allow'},
      ],
    }),
  );
  assert.equal(
    await cookedAllow.call('bash', {command: 'git "status"'}),
    undefined,
  );
});

void test('exact shell allows preserve assignments and redirects in each operation', async () => {
  const h = harness(
    createAgentPolicyExtension({
      permissions: [
        {action: 'shell', resource: '*', effect: 'deny'},
        {action: 'shell', resource: 'git status', effect: 'allow'},
      ],
    }),
  );
  for (const command of [
    'PATH=/evil git status',
    'git status > file',
    'git status 2> errors',
    '> output git status',
    'git status < input',
    'PATH=/evil; git status',
    '> output; git status',
    'PATH=/evil',
    '> output',
    'git status; PATH=/evil',
  ])
    assert.equal((await h.call('bash', {command})).block, true, command);
  assert.equal(await h.call('bash', {command: 'git "status"'}), undefined);
  const explicit = harness(
    createAgentPolicyExtension({
      permissions: [
        {action: 'shell', resource: '*', effect: 'deny'},
        {action: 'shell', resource: 'git status', effect: 'allow'},
        {action: 'shell', resource: 'PATH=/safe', effect: 'allow'},
        {
          action: 'shell',
          resource: 'PATH=/safe git status > output',
          effect: 'allow',
        },
      ],
    }),
  );
  assert.equal(
    await explicit.call('bash', {command: 'PATH=/safe git "status" > output'}),
    undefined,
  );
  assert.equal(
    await explicit.call('bash', {command: 'PATH=/safe; git "status"'}),
    undefined,
  );
});

void test(
  'native PowerShell parser gates compounds and substitutions without executing source',
  {skip: process.platform !== 'win32'},
  async () => {
    const h = harness(
      createAgentPolicyExtension({
        permissions: [
          {action: 'shell', resource: 'git push *', effect: 'deny'},
        ],
      }),
    );
    h.ctx.cwd = process.cwd();
    for (const command of [
      'Write-Output harmless; git push origin main',
      'Write-Output $(git push origin main)',
      '& "git" push origin main',
      'GIT PUSH origin main',
    ])
      assert.match(
        (await h.call('powershell', {command})).reason!,
        /permission denied: shell/i,
      );
    assert.equal(
      await h.call('powershell', {command: 'Write-Output harmless'}),
      undefined,
    );
    const exact = harness(
      createAgentPolicyExtension({
        permissions: [
          {action: 'shell', resource: '*', effect: 'deny'},
          {action: 'shell', resource: 'git status', effect: 'allow'},
        ],
      }),
    );
    exact.ctx.cwd = process.cwd();
    for (const command of ['git status > file', "$env:PATH='evil'; git status"])
      assert.equal(
        (await exact.call('powershell', {command})).block,
        true,
        command,
      );
  },
);

void test('shell outside-directory checks infer static directories, arguments, redirects and symlinks', async t => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'varisdev-shell-paths-')),
  );
  t.after(() => rm(root, {recursive: true, force: true}));
  const cwd = join(root, 'project');
  const outside = join(root, 'outside');
  await mkdir(join(cwd, 'nested'), {recursive: true});
  await mkdir(join(cwd, '.git'));
  await mkdir(outside);
  await symlink(outside, join(cwd, 'escape'), 'dir');
  const h = harness(
    createAgentPolicyExtension({
      permissions: [
        {action: 'external_directory', resource: '*', effect: 'deny'},
      ],
    }),
  );
  h.ctx.cwd = cwd;
  for (const command of [
    'cd ../outside; cat file.txt',
    'cat ../outside/file.txt',
    'echo harmless > ../outside/output.txt',
    'cat escape/file.txt',
    'cd nested; cat ../../outside/file.txt',
    'git -C ../outside status',
    'git --work-tree=../outside status',
    'cat < ../outside/input.txt',
  ])
    assert.match(
      (await h.call('bash', {command})).reason!,
      /permission denied: external_directory/,
      command,
    );
  for (const command of [
    'cat nested/file.txt',
    'cd nested; cat ../file.txt',
    'echo "$unknown"',
    'echo /outside',
  ])
    assert.equal(await h.call('bash', {command}), undefined, command);
});

void test('shell scanning bounds invalid syntax and leaves unconfigured Pi commands alone', async () => {
  const ordinary = harness(createAgentPolicyExtension({steps: 4}));
  const configured = harness(
    createAgentPolicyExtension({
      permissions: [{action: 'shell', resource: 'git push *', effect: 'deny'}],
    }),
  );
  for (const command of [
    'if true; then',
    'echo ' + 'x'.repeat(16_384),
    'echo ' + '$('.repeat(100) + 'true' + ')'.repeat(100),
  ]) {
    assert.equal(await ordinary.call('bash', {command}), undefined);
    assert.equal((await configured.call('bash', {command})).block, true);
  }
});

void test('catalog and declarations preserve exceptions and reject untemplated name impersonation', async () => {
  const permissions: AgentPermissionRule[] = [
    {action: 'subagent', resource: '*', effect: 'deny'},
    {action: 'subagent', resource: 'explore', effect: 'allow'},
    {action: 'edit', resource: '*', effect: 'deny'},
  ];
  assert.equal(agentCatalogAllows({permissions}, 'workspace:explore'), true);
  assert.equal(agentCatalogAllows({permissions}, 'build'), false);
  assert.equal(isAgentToolWhollyDenied({permissions}, 'write'), true);
  assert.equal(isAgentToolWhollyDenied({permissions}, 'agent_spawn'), false);
  assert.equal(
    isAgentToolWhollyDenied({permissions}, 'agent_templates'),
    false,
  );
  assert.equal(isAgentToolWhollyDenied({permissions}, 'openai_image'), true);
  const h = harness(createAgentPolicyExtension({permissions}));
  permissions.push({action: 'edit', resource: '*', effect: 'allow'});
  h.emit('before_agent_start', {messageType: 'user'});
  assert.deepEqual(h.tools, ['read', 'bash', 'agent_spawn']);
  assert.equal((await h.call('agent_spawn', {name: 'explore'})).block, true);
  assert.equal(
    await h.call('agent_spawn', {template: 'repository:explore'}),
    undefined,
  );
  assert.equal((await h.call('download', {path: 'file'}, true)).block, true);
  assert.equal(
    (await h.call('agent_templates', {action: 'delete', id: 'build'}, true))
      .block,
    true,
  );
  h.emit('agent_end');
  assert.deepEqual(h.tools, ['read', 'write', 'bash', 'agent_spawn']);
});

void test('ask requires actual approval, propagates relay signals, and blocks cancellation', async () => {
  const profile = {
    permissions: [
      {
        action: 'shell',
        resource: '*',
        effect: 'ask',
      } satisfies AgentPermissionRule,
    ],
  };
  const noUI = harness(createAgentPolicyExtension(profile));
  assert.match(
    (await noUI.call('bash', {command: 'git status'})).reason!,
    /approval is unavailable/,
  );
  assert.equal(noUI.confirmations, 0);
  noUI.ctx.hasUI = true;
  assert.equal(await noUI.call('bash', {command: 'git status'}), undefined);
  assert.equal(noUI.confirmations, 1);
  const denied = harness(
    createAgentPolicyExtension(profile, {approval: async () => false}),
  );
  assert.match(
    (await denied.call('bash', {command: 'git status'})).reason!,
    /declined/,
  );
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<boolean>();
  const h = harness(
    createAgentPolicyExtension(profile, {
      approval: async request => {
        assert.equal(request.signal, controller.signal);
        assert.equal(request.resource, 'git status');
        entered.resolve();
        return pending.promise;
      },
    }),
    controller.signal,
  );
  const call = h.call('bash', {command: 'git status'}, true);
  await entered.promise;
  controller.abort(new Error('Worker stopped'));
  assert.match((await call).reason!, /cancelled.*Worker stopped/);
  pending.resolve(true);
  const synchronousAbort = new AbortController();
  const aborted = harness(
    createAgentPolicyExtension(profile, {
      approval: async () => {
        synchronousAbort.abort(new Error('Cancelled during approval'));
        return false;
      },
    }),
    synchronousAbort.signal,
  );
  assert.match(
    (await aborted.call('bash', {command: 'git status'})).reason!,
    /cancelled/,
  );
  const relay = harness(
    createAgentPolicyExtension(profile, {
      label: 'Explore job',
      approval: {
        hasUI: true,
        async confirm(title, _message, options) {
          assert.equal(title, 'Agent permission: Explore job');
          assert.equal(options?.signal, undefined);
          return true;
        },
      },
    }),
  );
  assert.equal(await relay.call('bash', {command: 'git status'}), undefined);
});

void test('final first turn blocks nested tools and new user messages reset turn allowance', async () => {
  assert.throws(
    () => createAgentPolicyExtension({steps: 0}),
    /positive integer/,
  );
  assert.throws(
    () => createAgentPolicyExtension({steps: 1.5}),
    /positive integer/,
  );
  const h = harness(createAgentPolicyExtension({steps: 1}));
  h.emit('before_agent_start', {messageType: 'user'});
  assert.deepEqual(h.tools, []);
  assert.equal((await h.call('write', {path: 'a'}, true)).block, true);
  h.emit('agent_end');
  assert.deepEqual(h.tools, ['read', 'write', 'bash', 'agent_spawn']);
  const two = harness(createAgentPolicyExtension({steps: 2}));
  two.emit('before_agent_start', {messageType: 'user'});
  two.emit('turn_start');
  two.emit('turn_end', {message: {role: 'assistant', content: []}});
  assert.deepEqual(two.tools, []);
  two.emit('input', {
    text: 'More',
    source: 'interactive',
    streamingBehavior: 'steer',
  });
  assert.ok((two.tools as string[]).includes('write'));
});

void test('policy preserves live tool selection changes and does not revive an intentionally empty baseline after reload', () => {
  const factory = createAgentPolicyExtension({
    steps: 3,
    permissions: [{action: 'write', resource: '*', effect: 'deny'}],
  });
  const h = harness(factory, undefined, {tools: ['read', 'write']});
  h.emit('session_start', {reason: 'startup'});
  h.emit('before_agent_start', {messageType: 'user'});
  h.setTools(['read', 'write', 'dynamic_reader']);
  h.emit('turn_start');
  h.emit('turn_end', {message: {role: 'assistant', content: []}});
  assert.deepEqual(h.tools, ['read', 'dynamic_reader']);
  h.setTools(['dynamic_reader']);
  h.emit('turn_start');
  h.emit('turn_end', {message: {role: 'assistant', content: []}});
  assert.deepEqual(h.tools, []);
  h.emit('agent_end');
  assert.deepEqual(h.tools, ['write', 'dynamic_reader']);
  h.setTools([]);
  h.emit('before_agent_start', {messageType: 'user'});
  assert.deepEqual(
    h.tools,
    [],
    'a live empty selection is not treated as saved final-step state',
  );
  h.emit('agent_end');
  h.emit('session_shutdown', {reason: 'reload'});
  const reloaded = harness(factory, undefined, {tools: [], entries: h.entries});
  reloaded.emit('session_start', {reason: 'reload'});
  reloaded.emit('before_agent_start', {messageType: 'user'});
  assert.deepEqual(
    reloaded.tools,
    [],
    'reload retains an explicitly empty selection',
  );
});

void test('shell bare-command suffix, Windows paths, Default launches, grep queries, and execute actions match their configured rules', async () => {
  const rules: AgentPermissionRule[] = [
    {action: 'shell', resource: '*', effect: 'ask'},
    {action: 'shell', resource: 'git status *', effect: 'allow'},
    {action: 'shell', resource: 'git push *', effect: 'deny'},
  ];
  assert.equal(evaluateAgentPermission(rules, 'shell', 'git status'), 'allow');
  assert.equal(
    evaluateAgentPermission(rules, 'shell', 'git status --short'),
    'allow',
  );
  assert.equal(evaluateAgentPermission(rules, 'shell', 'git push'), 'deny');
  assert.equal(
    evaluateAgentPermission(rules, 'shell', 'git push origin main'),
    'deny',
  );
  assert.equal(evaluateAgentPermission(rules, 'shell', 'git pushy'), 'ask');
  assert.equal(
    decideAgentPermission(
      {permissions: rules},
      'shell',
      'GIT PUSH',
      'powershell',
    ),
    'deny',
  );
  const paths: AgentPermissionRule[] = [
    {action: '*', resource: '*', effect: 'deny'},
    {action: 'read', resource: 'SRC\\**', effect: 'allow'},
  ];
  assert.equal(
    evaluateAgentPermission(paths, 'read', 'src/file.ts', undefined, 'win32'),
    'allow',
  );
  assert.equal(
    evaluateAgentPermission(paths, 'read', 'src/file.ts', undefined, 'linux'),
    'deny',
  );
  assert.equal(
    evaluateAgentPermission(
      [{action: 'read', resource: 'c:/WORK/**', effect: 'deny'}],
      'read',
      'C:\\work\\file.ts',
      undefined,
      'win32',
    ),
    'deny',
  );
  const launches = harness(
    createAgentPolicyExtension({
      permissions: [
        {action: 'subagent', resource: '*', effect: 'deny'},
        {action: 'subagent', resource: 'default', effect: 'allow'},
      ],
    }),
  );
  assert.equal(await launches.call('agent_spawn', {}), undefined);
  assert.equal(
    await launches.call('agent_spawn', {name: 'reviewer'}),
    undefined,
  );
  assert.equal(
    (
      await launches.call('agent_spawn', {
        template: 'reviewer',
        name: 'default',
      })
    ).block,
    true,
  );
  assert.equal(
    (await launches.call('agent_spawn', {template: 'unknown', name: 'default'}))
      .block,
    true,
  );
  const inspection = harness(
    createAgentPolicyExtension({
      permissions: [
        {action: 'grep', resource: 'password', effect: 'deny'},
        {action: 'execute', resource: '*', effect: 'deny'},
      ],
    }),
  );
  assert.equal(
    (await inspection.call('grep', {pattern: 'password', path: 'src'})).block,
    true,
  );
  assert.equal(
    await inspection.call('grep', {pattern: 'name', path: 'password'}),
    undefined,
  );
  assert.equal(
    (await inspection.call('codemode', {code: 'return 1'})).block,
    true,
  );
  assert.equal(
    isAgentToolWhollyDenied(
      {permissions: [{action: 'execute', resource: '*', effect: 'deny'}]},
      'codemode',
    ),
    true,
  );
});

void test('canonical paths catch symlink escapes and nonexistent write targets while keeping the worktree internal', async t => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'varisdev-policy-canonical-')),
  );
  t.after(() => rm(root, {recursive: true, force: true}));
  const project = join(root, 'repo');
  const cwd = join(project, 'feature');
  const outside = join(root, 'outside');
  await Promise.all([
    mkdir(join(project, '.git'), {recursive: true}),
    mkdir(cwd, {recursive: true}),
    mkdir(outside),
  ]);
  await writeFile(join(outside, 'secret.json'), '{}');
  await symlink(outside, join(cwd, 'linked'), 'junction');
  const read = agentToolPermissions('read', {path: 'linked/secret.json'}, cwd);
  assert.deepEqual(read, [
    {action: 'read', resource: permissionPath(join(outside, 'secret.json'))},
    {
      action: 'external_directory',
      resource: permissionPath(join(outside, 'secret.json')),
    },
  ]);
  const write = agentToolPermissions(
    'write',
    {path: 'linked/new/deep/file.ts'},
    cwd,
  );
  assert.deepEqual(write, [
    {
      action: 'edit',
      resource: permissionPath(join(outside, 'new/deep/file.ts')),
    },
    {
      action: 'external_directory',
      resource: permissionPath(join(outside, 'new/deep/file.ts')),
    },
  ]);
  assert.deepEqual(agentToolPermissions('read', {path: '../shared.ts'}, cwd), [
    {action: 'read', resource: permissionPath(join(project, 'shared.ts'))},
  ]);
  assert.deepEqual(
    agentToolPermissions('grep', {pattern: '../regex', path: '.'}, cwd),
    [{action: 'grep', resource: '../regex'}],
  );
  assert.deepEqual(
    agentToolPermissions('grep', {pattern: 'name', path: outside}, cwd),
    [
      {action: 'grep', resource: 'name'},
      {action: 'external_directory', resource: permissionPath(outside)},
    ],
  );
  const h = harness(
    createAgentPolicyExtension({
      permissions: [
        {action: 'external_directory', resource: '*', effect: 'deny'},
      ],
    }),
  );
  h.ctx.cwd = cwd;
  assert.equal(
    (await h.call('read', {path: 'linked/secret.json'})).block,
    true,
  );
  assert.equal(
    (await h.call('write', {path: 'linked/new/deep/file.ts'})).block,
    true,
  );
  assert.equal(await h.call('read', {path: '../shared.ts'}), undefined);
});

void test('skill input and known skill reads share deny, approval, notification and preflight cancellation', async t => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'varisdev-policy-skills-')),
  );
  t.after(() => rm(root, {recursive: true, force: true}));
  const blocked = join(root, 'blocked', 'SKILL.md');
  const approved = join(root, 'approved', 'SKILL.md');
  await Promise.all([
    mkdir(join(root, 'blocked')),
    mkdir(join(root, 'approved')),
  ]);
  await Promise.all([
    writeFile(blocked, 'Blocked skill body.'),
    writeFile(approved, 'Approved skill body.'),
  ]);
  const profile = {
    permissions: [
      {action: 'skill', resource: '*', effect: 'deny'},
      {action: 'skill', resource: 'approved', effect: 'ask'},
    ] satisfies AgentPermissionRule[],
  };
  const skills = () => [
    {name: 'blocked', filePath: blocked},
    {name: 'approved', filePath: approved},
  ];
  const reasons: string[] = [];
  const asks: string[] = [];
  const h = harness(
    createAgentPolicyExtension(profile, {
      skills,
      onInputBlocked: reason => reasons.push(reason),
      approval: async request => {
        assert.equal(request.action, 'skill');
        asks.push(request.resource);
        return true;
      },
    }),
  );
  h.ctx.cwd = root;
  assert.deepEqual(await h.emit('input', {text: '/skill:blocked review'}), {
    action: 'handled',
  });
  assert.match(h.notifications[0], /permission denied: skill blocked/);
  assert.equal(reasons.length, 1);
  assert.equal((await h.call('read', {path: blocked})).block, true);
  assert.equal(
    (await h.call('json_query', {path: 'blocked/*.md'})).block,
    true,
    'matched query files retain their known skill identity',
  );
  assert.deepEqual(await h.emit('input', {text: '/skill:approved review'}), {
    action: 'continue',
  });
  assert.equal(await h.call('read', {path: approved}), undefined);
  assert.deepEqual(asks, ['approved', 'approved']);
  const declined = harness(
    createAgentPolicyExtension(profile, {skills, approval: async () => false}),
  );
  assert.deepEqual(await declined.emit('input', {text: '/skill:approved'}), {
    action: 'handled',
  });
  assert.match(declined.notifications[0], /declined/);
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<boolean>();
  const cancelled = harness(
    createAgentPolicyExtension(profile, {
      skills,
      signal: () => controller.signal,
      approval: async request => {
        assert.equal(request.signal, controller.signal);
        entered.resolve();
        return pending.promise;
      },
    }),
  );
  const input = cancelled.emit('input', {text: '/skill:approved'});
  await entered.promise;
  controller.abort(new Error('Stopped before model start'));
  assert.deepEqual(await input, {action: 'handled'});
  assert.match(cancelled.notifications[0], /Stopped before model start/);
  pending.resolve(true);
});

void test('query permission checks use actual matched files and retain the execution snapshot', async t => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'varisdev-policy-query-')),
  );
  t.after(() => rm(root, {recursive: true, force: true}));
  await Promise.all([
    writeFile(join(root, 'public.json'), '{}'),
    writeFile(join(root, 'secret.json'), '{}'),
  ]);
  const h = harness(
    createAgentPolicyExtension({
      permissions: [{action: 'read', resource: 'secret.json', effect: 'deny'}],
    }),
  );
  h.ctx.cwd = root;
  for (const tool of ['json_query', 'gamemaker_query', 'image_query'])
    assert.match(
      (await h.call(tool, {path: '*.json'})).reason!,
      /permission denied.*secret.json/,
    );
  const controller = new AbortController();
  const asks: string[] = [];
  const approved = harness(
    createAgentPolicyExtension(
      {permissions: [{action: 'read', resource: '*', effect: 'ask'}]},
      {
        signal: () => controller.signal,
        approval: async request => {
          asks.push(request.resource);
          return true;
        },
      },
    ),
  );
  approved.ctx.cwd = root;
  const input = {path: 'public*.json'};
  assert.equal(await approved.call('json_query', input), undefined);
  await writeFile(join(root, 'public-later.json'), '{}');
  assert.equal(await approved.call('json_query', input), undefined);
  assert.deepEqual(asks, [
    permissionPath(join(root, 'public.json')),
    permissionPath(join(root, 'public.json')),
  ]);
});

void test('prepared query matches retain literal Unicode and dollar paths instead of native aliases', async t => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'varisdev-policy-query-literal-')),
  );
  t.after(() => rm(root, {recursive: true, force: true}));
  const cwd = join(root, 'project');
  await mkdir(join(cwd, '.git'), {recursive: true});
  const outside = join(root, 'outside.json');
  await writeFile(outside, '{}');
  await writeFile(join(cwd, 'space file.json'), '{}');
  await symlink(outside, join(cwd, 'space\u00a0file.json'));
  await mkdir(join(cwd, '$HOME'));
  await symlink(outside, join(cwd, '$HOME', 'blocked.json'));
  const h = harness(
    createAgentPolicyExtension({
      permissions: [
        {action: 'external_directory', resource: '*', effect: 'deny'},
      ],
    }),
  );
  h.ctx.cwd = cwd;
  assert.equal(
    await h.call('read', {path: 'space\u00a0file.json'}),
    undefined,
    'native read normalizes spaces to its actual internal target',
  );
  for (const path of ['space\u00a0file.json', '$HOME/blocked.json'])
    assert.match(
      (await h.call('json_query', {path})).reason!,
      /permission denied: external_directory/,
      'queries authorize their literal discovered file',
    );
});

interface ProviderRequest {
  messages: Array<{role: string; content: unknown}>;
  tools?: Array<{function: {name: string}}>;
}
function reply(response: ServerResponse, tool?: string): void {
  response.writeHead(200, {'content-type': 'text/event-stream'});
  response.end(
    `data: ${JSON.stringify({
      id: 'completion',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'policy-model',
      choices: [
        {
          index: 0,
          delta: tool
            ? {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_probe',
                    type: 'function',
                    function: {name: tool, arguments: '{}'},
                  },
                ],
              }
            : {role: 'assistant', content: 'Work summarized.'},
          finish_reason: tool ? 'tool_calls' : 'stop',
        },
      ],
      usage: {prompt_tokens: 20, completion_tokens: 5, total_tokens: 25},
    })}\n\ndata: [DONE]\n\n`,
  );
}

void test(
  'Pi preserves dynamic tools across turns, reload and resume while filtering denied and final declarations',
  {timeout: 15000},
  async t => {
    const root = await mkdtemp(join(tmpdir(), 'varisdev-policy-'));
    const agentDir = join(root, 'config');
    const cwd = join(root, 'project');
    await Promise.all([
      mkdir(agentDir, {recursive: true}),
      mkdir(join(cwd, '.git'), {recursive: true}),
    ]);
    const outsideFile = join(root, 'outside.txt');
    const literalHomeFile = join(cwd, '$HOME', 'allowed.txt');
    await writeFile(outsideFile, 'Outside fixture.');
    await mkdir(join(cwd, '$HOME'));
    await writeFile(literalHomeFile, 'Literal HOME fixture.');
    await symlink(outsideFile, join(cwd, '$HOME', 'blocked.txt'));
    await symlink(outsideFile, join(cwd, 'space name.txt'));
    await symlink(outsideFile, join(cwd, 'cafe\u0301.txt'));
    const nativeReads: string[] = [];
    const nativeWrites: string[] = [];
    const approvedQueries: string[] = [];
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({retry: {enabled: false}}),
    );
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    const requests: ProviderRequest[] = [];
    const errors: unknown[] = [];
    const recordError = (error: unknown) => {
      errors.push(error);
    };
    const firstRequest = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let writes = 0;
    let probes = 0;
    let dynamicCalls = 0;
    let shellExecutions = 0;
    const server = createServer(async (request, response) => {
      try {
        let body = '';
        for await (const chunk of request) body += chunk;
        const input = JSON.parse(body) as ProviderRequest;
        requests.push(input);
        const step = ((requests.length - 1) % 3) + 1;
        if (requests.length === 1) {
          firstRequest.resolve();
          await release.promise;
        }
        assert.ok(
          requests.length <= 12,
          'step limit must prevent extra model requests',
        );
        if (step !== 3) {
          assert.equal(
            JSON.stringify(input.messages).includes(AGENT_STEP_SUMMARY),
            false,
            'summary instruction is limited to the final request',
          );
          assert.ok(
            input.tools?.some(tool => tool.function.name === 'policy_probe'),
          );
          assert.equal(
            input.tools?.some(tool => tool.function.name === 'policy_mutate'),
            false,
            'wholly denied direct tools are omitted from declarations',
          );
          assert.equal(
            input.tools?.some(tool => tool.function.name === 'policy_write'),
            false,
          );
          assert.equal(
            input.tools?.some(
              tool => tool.function.name === 'policy_denied_dynamic',
            ),
            false,
          );
          if (step === 2)
            assert.ok(
              input.tools?.some(
                tool => tool.function.name === 'policy_dynamic',
              ),
              'dynamically activated permitted tools reach the next request',
            );
        } else {
          assert.equal(
            input.tools?.length ?? 0,
            0,
            'final request contains no tools',
          );
          assert.ok(
            JSON.stringify(input.messages).includes(AGENT_STEP_SUMMARY),
          );
          assert.match(
            JSON.stringify(input.messages),
            /permission denied.*policy_write/,
          );
        }
        reply(
          response,
          step === 1
            ? 'policy_probe'
            : step === 2
              ? 'policy_dynamic'
              : undefined,
        );
      } catch (error) {
        errors.push(error);
        response.writeHead(500);
        response.end('Fixture failed');
      }
    });
    const cleanup: {dispose?: () => void} = {};
    t.after(async () => {
      release.resolve();
      cleanup.dispose?.();
      registry.unregisterProvider('policy-fixture');
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, {recursive: true, force: true});
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    registry.registerProvider('policy-fixture', {
      api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      apiKey: 'fixture-key',
      models: [
        {
          id: 'policy-model',
          name: 'Policy fixture',
          reasoning: false,
          input: ['text'],
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          contextWindow: 64000,
          maxTokens: 1000,
        },
      ],
    });
    const extensionFactories: ExtensionFactory[] = [
      pi => {
        const registerDeferredQuery: ExtensionAPI['registerTool'] = tool =>
          pi.registerTool({...tool, exposure: 'deferred'});
        registerJsonQueryTool({...pi, registerTool: registerDeferredQuery});
        pi.registerTool(
          createReadToolDefinition(cwd, {
            operations: {
              async access() {},
              async readFile(path) {
                nativeReads.push(path);
                return Buffer.from('Native literal HOME fixture.');
              },
              async detectImageMimeType() {
                return null;
              },
            },
          }),
        );
        pi.registerTool(
          createWriteToolDefinition(cwd, {
            operations: {
              async mkdir() {},
              async writeFile(path) {
                nativeWrites.push(path);
              },
            },
          }),
        );
        pi.registerTool({
          name: 'bash',
          label: 'Shell permission integration fixture',
          description:
            'Records permitted shell calls without executing commands.',
          parameters: Type.Object({command: Type.String()}),
          async execute() {
            shellExecutions++;
            return {
              content: [{type: 'text', text: 'Permitted fixture call.'}],
              details: {},
            };
          },
        });
        pi.registerTool({
          name: 'policy_probe',
          label: 'Policy probe',
          description: 'Probe nested permission enforcement.',
          parameters: Type.Object({}),
          async execute(_id, _input, _signal, _update, ctx) {
            probes++;
            const queryDirectory = `query-probe-${probes}`;
            await mkdir(join(cwd, queryDirectory));
            await writeFile(
              join(cwd, queryDirectory, 'approved.json'),
              '{"approved":true}',
            );
            const queried = await ctx.executeTool('json_query', {
              path: `${queryDirectory}/*.json`,
            });
            const queryDetails = queried.result.details as {
              summary: {filesProcessed: number};
              files: Array<{path: string}>;
            };
            assert.equal(approvedQueries.length, probes);
            assert.equal(queryDetails.summary.filesProcessed, 1);
            assert.deepEqual(
              queryDetails.files.map(file => file.path),
              [`${queryDirectory}/approved.json`],
            );
            assert.doesNotMatch(
              JSON.stringify(queried.result),
              /unapproved\.json/,
              'nested deferred execution must retain the permission preflight snapshot',
            );
            for (const path of [
              pathToFileURL(outsideFile).href,
              'space\u00a0name.txt',
              'café.txt',
              '$HOME/blocked.txt',
            ]) {
              const read = await ctx.executeTool('read', {path});
              assert.match(
                JSON.stringify(read.result.content),
                /permission denied: external_directory/,
              );
            }
            const write = await ctx.executeTool('write', {
              path: pathToFileURL(outsideFile).href,
              content: 'Forbidden fixture write.',
            });
            assert.match(
              JSON.stringify(write.result.content),
              /permission denied: external_directory/,
            );
            const allowedRead = await ctx.executeTool('read', {
              path: '$HOME/allowed.txt',
            });
            assert.match(
              JSON.stringify(allowedRead.result.content),
              /Native literal HOME fixture/,
            );
            const blocked = await ctx.executeTool('bash', {
              command: 'echo harmless; git push origin main',
            });
            assert.match(
              JSON.stringify(blocked.result.content),
              /permission denied: shell git push/,
            );
            await ctx.executeTool('bash', {command: 'echo harmless'});
            const result = await ctx.executeTool('policy_write', {});
            pi.setActiveTools([
              ...pi.getActiveTools(),
              'policy_dynamic',
              'policy_denied_dynamic',
            ]);
            return {content: result.result.content, details: {}};
          },
        });
        pi.registerTool({
          name: 'policy_dynamic',
          label: 'Dynamic policy reader',
          description: 'A permitted deferred tool activated during a run.',
          exposure: 'deferred',
          parameters: Type.Object({}),
          async execute() {
            dynamicCalls++;
            return {
              content: [{type: 'text', text: 'Dynamic tool ran.'}],
              details: {},
            };
          },
        });
        pi.registerTool({
          name: 'policy_denied_dynamic',
          label: 'Dynamic policy mutator',
          description: 'A denied deferred tool activated during a run.',
          exposure: 'deferred',
          parameters: Type.Object({}),
          async execute() {
            writes++;
            return {
              content: [{type: 'text', text: 'Unexpected dynamic mutation.'}],
              details: {},
            };
          },
        });
        pi.registerTool({
          name: 'policy_mutate',
          label: 'Policy mutator',
          description: 'A denied direct mutator.',
          parameters: Type.Object({}),
          async execute() {
            writes++;
            return {
              content: [{type: 'text', text: 'Unexpected mutation'}],
              details: {},
            };
          },
        });
        pi.registerTool({
          name: 'policy_write',
          label: 'Policy write',
          description: 'A denied deferred mutator.',
          exposure: 'deferred',
          parameters: Type.Object({}),
          async execute() {
            writes++;
            return {
              content: [{type: 'text', text: 'Unexpected write'}],
              details: {},
            };
          },
        });
      },
      createAgentPolicyExtension(
        {
          steps: 3,
          permissions: [
            {action: 'read', resource: 'query-probe-*/*.json', effect: 'ask'},
            {action: 'external_directory', resource: '*', effect: 'deny'},
            {action: 'shell', resource: 'git push *', effect: 'deny'},
            {action: 'policy_write', resource: '*', effect: 'deny'},
            {action: 'policy_mutate', resource: '*', effect: 'deny'},
            {action: 'policy_denied_dynamic', resource: '*', effect: 'deny'},
          ],
        },
        {
          approval: async request => {
            assert.equal(request.action, 'read');
            assert.equal(request.toolName, 'json_query');
            assert.ok(request.resource.endsWith('/approved.json'));
            approvedQueries.push(request.resource);
            await writeFile(
              join(request.resource, '..', 'unapproved.json'),
              '{"unapproved":true}',
            );
            return true;
          },
        },
      ),
      pi => {
        const activateDenied = () =>
          pi.setActiveTools([...pi.getActiveTools(), 'policy_mutate']);
        // Model schema refresh extensions can activate tools after policy hooks.
        pi.on('before_agent_start', activateDenied);
        pi.on('turn_end', activateDenied);
      },
    ];
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      extensionFactories,
    });
    await loader.reload();
    const {session} = await createAgentSession({
      cwd,
      agentDir,
      model: registry.find('policy-fixture', 'policy-model')!,
      modelRuntime: runtime,
      thinkingLevel: 'off',
      resourceLoader: loader,
      sessionManager: SessionManager.create(cwd, join(root, 'sessions')),
    });
    cleanup.dispose = () => session.dispose();
    await session.bindExtensions({onError: recordError});
    const before = session.getActiveToolNames();
    const running = session.prompt('Perform a probe and summarize.');
    await firstRequest.promise;
    release.resolve();
    await running;
    assert.deepEqual(errors, []);
    assert.equal(
      session.getLastAssistantText(),
      'Work summarized.',
      JSON.stringify(session.messages),
    );
    const restoredTools = [
      ...before,
      'policy_dynamic',
      'policy_denied_dynamic',
    ];
    assert.deepEqual(session.getActiveToolNames(), restoredTools);
    await session.prompt('Perform another probe.');
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 6);
    assert.equal(probes, 2);
    assert.equal(dynamicCalls, 2);
    assert.equal(writes, 0);
    assert.deepEqual(session.getActiveToolNames(), restoredTools);
    await session.reload();
    assert.deepEqual(session.getActiveToolNames(), restoredTools);
    await session.prompt('Perform another probe after reloading extensions.');
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 9);
    assert.deepEqual(session.getActiveToolNames(), restoredTools);
    const sessionFile = session.sessionManager.getSessionFile()!;
    session.dispose();
    const resumedLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      extensionFactories,
    });
    await resumedLoader.reload();
    const {session: resumed} = await createAgentSession({
      cwd,
      agentDir,
      model: registry.find('policy-fixture', 'policy-model')!,
      modelRuntime: runtime,
      thinkingLevel: 'off',
      resourceLoader: resumedLoader,
      sessionManager: SessionManager.open(sessionFile),
    });
    cleanup.dispose = () => resumed.dispose();
    await resumed.bindExtensions({onError: recordError});
    await resumed.prompt('Resume the saved conversation with another probe.');
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 12);
    assert.equal(probes, 4);
    assert.equal(approvedQueries.length, 4);
    assert.deepEqual(
      nativeReads,
      Array(4).fill(literalHomeFile),
      'only the literal internal HOME filename reaches native read operations',
    );
    assert.deepEqual(
      nativeWrites,
      [],
      'file URL writes are blocked before native operations',
    );
    assert.equal(
      shellExecutions,
      4,
      'only harmless calls reach the fixture tool',
    );
    assert.equal(dynamicCalls, 4);
    assert.equal(writes, 0);
    assert.deepEqual(resumed.getActiveToolNames(), restoredTools);
  },
);
