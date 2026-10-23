import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type {AutocompleteProvider} from '@earendil-works/pi-tui';
import {
  agentMentionAutocomplete,
  discoverAgentMentions,
  eligibleAgentMentions,
  parseAgentMention,
} from '../src/agents/mentions.ts';
import {
  createDefaultAgentProfile,
  saveAgentTemplate,
} from '../src/agents/templates.ts';
import type {createSessionWorker} from '../src/agents/session.ts';
import {
  registerAgentTools,
  type AgentToolsOptions,
} from '../src/tools/agents.ts';
import {saveToolSettings} from '../src/tools/settings.ts';

void test('mentions require a leading configuration ID and a text task', () => {
  assert.deepEqual(parseAgentMention('@agent:quality/review Check changes'), {
    id: 'quality/review',
    task: 'Check changes',
  });
  assert.deepEqual(
    parseAgentMention('@review-agent Check src/\nThen report.  '),
    {
      id: 'review-agent',
      task: 'Check src/\nThen report.',
    },
  );
  for (const text of [
    'Ask @review to help',
    'person@example.com',
    '@person@example.com task',
    '@src/file.ts task',
    '@repository:review task',
    '@review',
    '@review ',
    '@review\ntask',
    ' @review task',
    '@review  \n',
    '@agent:../review task',
    '@agent:team/../review task',
    '@agent:team/./review task',
    '@agent:team//review task',
    '@agent:/review task',
    '@agent:"unterminated name task',
    '@agent:"NUL\\u0000name" task',
  ])
    assert.equal(parseAgentMention(text), undefined, text);
});

void test('mention candidates include eligible subagent/all configurations and ask rules', () => {
  const base = createDefaultAgentProfile();
  const templates = [
    {...base, id: 'review', mode: 'subagent' as const},
    {...base, id: 'general', mode: 'all' as const},
    {...base, id: 'primary', mode: 'primary' as const},
    {...base, id: 'hidden', hidden: true},
    {...base, id: 'disabled', disabled: true},
    {...base, id: 'blocked'},
    {...base, id: 'path/agent'},
  ];
  assert.deepEqual(
    eligibleAgentMentions(templates, {
      permissions: [
        {action: 'subagent', resource: 'review', effect: 'ask'},
        {action: 'subagent', resource: 'blocked', effect: 'deny'},
      ],
    }).map(candidate => candidate.id),
    ['review', 'general', 'path/agent'],
  );
});

void test('native mention completion composes with Pi file completion and preserves task text', async () => {
  const file = {value: '@README.md', label: 'README.md'};
  let delegated = 0;
  const current: AutocompleteProvider = {
    triggerCharacters: ['/'],
    async getSuggestions() {
      delegated++;
      return {items: [file], prefix: '@R'};
    },
    applyCompletion(lines, line, column) {
      delegated++;
      return {lines, cursorLine: line, cursorCol: column};
    },
    shouldTriggerFileCompletion: () => true,
  };
  const provider = agentMentionAutocomplete(current, async () => [
    {id: 'review', name: 'Reviewer'},
    {
      id: 'quality/review',
      name: 'Quality reviewer',
      mention: '@agent:quality/review',
    },
  ]);
  const options = {signal: new AbortController().signal};
  const result = await provider.getSuggestions(
    ['@rev existing task'],
    0,
    4,
    options,
  );
  assert.equal(result?.items[0].value, '@review');
  assert.deepEqual(
    provider.applyCompletion(
      ['@rev existing task'],
      0,
      4,
      result!.items[0],
      '@rev',
    ),
    {
      lines: ['@review existing task'],
      cursorLine: 0,
      cursorCol: 8,
    },
  );
  const nested = await provider.getSuggestions(
    ['@agent:quality/r'],
    0,
    16,
    options,
  );
  assert.equal(nested?.items[0].value, '@agent:quality/review');
  assert.deepEqual(provider.triggerCharacters, ['/', '@']);
  assert.equal(provider.shouldTriggerFileCompletion?.(['@file'], 0, 5), true);
  await provider.getSuggestions(['@README.md'], 0, 10, options);
  await provider.getSuggestions(['See @review'], 0, 11, options);
  provider.applyCompletion(['@R'], 0, 2, file, '@R');
  assert.equal(delegated, 3);
});

async function fixture(t: TestContext, options: AgentToolsOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'varisdev-mentions-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, 'settings');
  const events = new Map<
    string,
    Array<(event: never, ctx: ExtensionContext) => unknown>
  >();
  const messages: Array<{content: string; details: unknown}> = [];
  const notices: string[] = [];
  const tools = new Map<string, ToolDefinition>();
  const workers: Array<Parameters<typeof createSessionWorker>[0]> = [];
  const runs: string[] = [];
  const childEvents: string[] = [];
  const pi = {
    on(
      name: string,
      handler: (event: never, ctx: ExtensionContext) => unknown,
    ) {
      events.set(name, [...(events.get(name) ?? []), handler]);
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    sendMessage(message: (typeof messages)[number]) {
      messages.push(message);
    },
    getThinkingLevel: () => 'high',
  } as unknown as ExtensionAPI;
  const parentModel = {provider: 'test', id: 'parent'};
  const pinnedModel = {provider: 'test', id: 'pinned'};
  const ctx = {
    cwd: root,
    hasUI: false,
    model: parentModel,
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === 'test' && id === 'pinned' ? pinnedModel : undefined,
    },
    isProjectTrusted: () => true,
    isIdle: () => true,
    ui: {notify: (message: string) => notices.push(message), setStatus() {}},
    sessionManager: {getSessionId: () => 'main-conversation'},
  } as unknown as ExtensionContext;
  const control = registerAgentTools(
    pi,
    async workerOptions => {
      workers.push(workerOptions);
      await workerOptions.agentToolsExtension({
        on(name: string) {
          childEvents.push(name);
        },
        registerTool() {},
        registerCommand() {},
      } as unknown as ExtensionAPI);
      return {
        async run(task) {
          runs.push(task);
          return 'Reviewed';
        },
        async steer() {
          return true;
        },
        dispose() {},
      };
    },
    {agentProfile: createDefaultAgentProfile(), ...options},
  );
  t.after(async () => {
    await control.getTeam(ctx).getManager().close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, {recursive: true, force: true});
  });
  await saveToolSettings('agents', {allowedModels: []});
  await saveAgentTemplate(root, {
    scope: 'global',
    id: 'review',
    mode: 'subagent',
    name: 'Review',
    instructions: 'Use the reviewer rules.',
    model: 'test/pinned',
    permissions: [{action: 'edit', resource: '*', effect: 'deny'}],
  });
  const input = async (text: string, extra: Partial<InputEvent> = {}) => {
    for (const handler of events.get('input') ?? []) {
      const result = (await handler(
        {type: 'input', text, source: 'rpc', ...extra} as never,
        ctx,
      )) as InputEventResult;
      if (result?.action === 'handled') return result;
    }
    return {action: 'continue'};
  };
  return {
    root,
    ctx,
    events,
    messages,
    notices,
    tools,
    workers,
    runs,
    childEvents,
    input,
    manager: control.getTeam(ctx).getManager(),
    pinnedModel,
  };
}

void test('main mentions launch through the agent runtime with pinned model, cwd, config and parent approval relay', async t => {
  const relay = async () => true;
  const f = await fixture(t, {approval: relay});
  assert.ok(
    (await discoverAgentMentions(f.root)).some(
      candidate => candidate.id === 'review',
    ),
  );
  assert.deepEqual(await f.input('@review Inspect src/'), {action: 'handled'});
  const records = f.manager.list();
  assert.equal(records.length, 1);
  await f.manager.wait([records[0].id]);
  assert.equal(records[0].pinnedModel, 'test/pinned');
  assert.equal(records[0].agentMode, 'subagent');
  assert.deepEqual(f.runs, ['Inspect src/']);
  assert.equal(f.workers[0].cwd, f.root);
  assert.equal(f.workers[0].model, f.pinnedModel);
  assert.equal(f.workers[0].approval, relay);
  assert.equal(f.workers[0].projectTrustOverride, true);
  assert.equal(f.workers[0].parentSessionId, 'main-conversation');
  assert.equal(
    f.workers[0].agentProfile!.instructions,
    'Use the reviewer rules.',
  );
  assert.deepEqual(f.workers[0].agentProfile!.permissions, [
    {action: 'edit', resource: '*', effect: 'deny'},
  ]);
  assert.equal(f.childEvents.includes('input'), false);
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].content, /@review Inspect src\//);
  assert.equal(f.notices.length, 0);
});

void test('unknown IDs, file mentions, emails and extension messages continue without delegation', async t => {
  const f = await fixture(t);
  for (const text of [
    '@unknown task',
    '@UNKNOWN task',
    '@unknown_word task',
    '@src/file.ts task',
    '@file.ts task',
    '@review.md task',
    'email@example.com',
    'Ask @review task',
    '@review',
  ]) {
    assert.deepEqual(await f.input(text), {action: 'continue'});
  }
  assert.deepEqual(await f.input('@review task', {source: 'extension'}), {
    action: 'continue',
  });
  assert.equal(f.manager.list().length, 0);
  assert.equal(f.messages.length, 0);
});

void test('explicit invocation enforces parent deny and unavailable approval before launch', async t => {
  const profile = createDefaultAgentProfile();
  profile.permissions = [
    {action: 'subagent', resource: 'review', effect: 'deny'},
  ];
  const shared = {agentProfile: profile};
  const f = await fixture(t, shared);
  assert.deepEqual(await f.input('@review task'), {action: 'handled'});
  assert.match(f.notices.at(-1)!, /permission denied/);
  assert.equal(f.manager.list().length, 0);
  profile.permissions[0].effect = 'ask';
  assert.deepEqual(await f.input('@review task'), {action: 'handled'});
  assert.match(f.notices.at(-1)!, /approval is unavailable/);
  assert.equal(f.manager.list().length, 0);
});

void test('explicit invocation asks using the parent policy resource and handles decline or cancellation', async t => {
  const profile = createDefaultAgentProfile();
  profile.permissions = [
    {action: 'subagent', resource: 'review', effect: 'ask'},
  ];
  const asked: Array<{action: string; resource: string; toolName: string}> = [];
  let approved = false;
  const f = await fixture(t, {
    agentProfile: profile,
    approval: async request => {
      asked.push(request);
      return approved;
    },
  });
  await f.input('@review task');
  assert.match(f.notices.at(-1)!, /approval declined/);
  assert.equal(f.manager.list().length, 0);
  assert.deepEqual(
    asked.map(({action, resource, toolName}) => ({action, resource, toolName})),
    [{action: 'subagent', resource: 'review', toolName: 'agent_spawn'}],
  );
  approved = true;
  await f.input('@review approved task');
  await f.manager.wait(f.manager.list().map(record => record.id));
  assert.deepEqual(f.runs, ['approved task']);
  const abort = new AbortController();
  abort.abort(new Error('Cancelled'));
  Object.assign(f.ctx, {signal: abort.signal});
  await f.input('@review cancelled task');
  assert.equal(f.manager.list().length, 1);
  assert.match(f.notices.at(-1)!, /cancelled/i);
});

void test('manual invocation preserves mode, disabled configuration, and inherited model restrictions', async t => {
  const f = await fixture(t);
  for (const configuration of [
    {id: 'primary', mode: 'primary' as const, model: 'test/pinned'},
    {id: 'disabled', disabled: true, model: 'test/pinned'},
    {id: 'inherit', mode: 'subagent' as const},
  ])
    await saveAgentTemplate(f.root, {
      scope: 'global',
      ...configuration,
      instructions: '',
    });
  await f.input('@primary task');
  assert.match(f.notices.at(-1)!, /only supports primary/);
  await f.input('@disabled task');
  assert.match(f.notices.at(-1)!, /disabled/);
  await f.input('@inherit task');
  assert.match(f.notices.at(-1)!, /not allowed|No agent models/i);
  assert.equal(f.manager.list().length, 0);
});

void test('nested configuration mentions use explicit syntax and resolve workspace overrides into new all-mode agents', async t => {
  const f = await fixture(t);
  await saveAgentTemplate(f.root, {
    scope: 'global',
    id: 'quality/review',
    mode: 'subagent',
    instructions: 'Global reviewer',
    model: 'test/unavailable',
  });
  await saveAgentTemplate(f.root, {
    scope: 'workspace',
    id: 'quality/review',
    mode: 'all',
    instructions: 'Workspace reviewer',
    model: 'test/pinned',
  });
  const candidates = await discoverAgentMentions(f.root);
  assert.equal(
    candidates.find(candidate => candidate.id === 'quality/review')?.mention,
    '@agent:quality/review',
  );
  assert.deepEqual(await f.input('@quality/review task'), {action: 'continue'});
  await f.input('@agent:quality/review Check workspace');
  await f.input('@agent:quality/review Check again');
  const records = f.manager.list();
  await f.manager.wait(records.map(record => record.id));
  assert.equal(records.length, 2);
  assert.notEqual(records[0].id, records[1].id);
  assert.ok(records.every(record => record.agentMode === 'all'));
  assert.ok(
    f.workers.every(
      options => options.agentProfile!.instructions === 'Workspace reviewer',
    ),
  );
  assert.deepEqual(f.runs, ['Check workspace', 'Check again']);
});

void test('stopping an idle main mention cancels pending approval before creating a worker', async t => {
  const profile = createDefaultAgentProfile();
  profile.permissions = [
    {action: 'subagent', resource: 'review', effect: 'ask'},
  ];
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<boolean>();
  const f = await fixture(t, {
    agentProfile: profile,
    signal: () => controller.signal,
    approval: async request => {
      assert.equal(request.signal, controller.signal);
      started.resolve();
      return pending.promise;
    },
  });
  const input = f.input('@review Wait for approval');
  await started.promise;
  controller.abort(new Error('Stopped'));
  assert.deepEqual(await input, {action: 'handled'});
  pending.resolve(true);
  assert.equal(f.manager.list().length, 0);
  assert.match(f.notices.at(-1)!, /cancelled.*Stopped/i);
});

void test('dotted configuration discovery and native completion select and launch the saved profile', async t => {
  const f = await fixture(t);
  for (const id of ['sf-agent.test', 'quality.v2/sf-agent..test'])
    await saveAgentTemplate(f.root, {
      scope: 'workspace',
      id,
      mode: 'all',
      model: 'test/pinned',
      instructions: `Dotted instructions for ${id}.`,
    });
  let delegated = 0;
  const provider = agentMentionAutocomplete(
    {
      async getSuggestions() {
        delegated++;
        return null;
      },
      applyCompletion(lines, line, column) {
        return {lines, cursorLine: line, cursorCol: column};
      },
    },
    () => discoverAgentMentions(f.root),
  );
  for (const [query, id] of [
    ['@sf-agent.t', 'sf-agent.test'],
    ['@agent:quality.v2/sf-agent..t', 'quality.v2/sf-agent..test'],
  ]) {
    const task = `Use ${id}`;
    const result = await provider.getSuggestions(
      [`${query} ${task}`],
      0,
      query.length,
      {signal: new AbortController().signal},
    );
    assert.equal(result?.items.length, 1);
    const selected = provider.applyCompletion(
      [`${query} ${task}`],
      0,
      query.length,
      result!.items[0],
      result!.prefix,
    );
    assert.equal(parseAgentMention(selected.lines[0])?.id, id);
    assert.deepEqual(await f.input(selected.lines[0]), {action: 'handled'});
  }
  await f.manager.wait(f.manager.list().map(record => record.id));
  assert.deepEqual(
    f.workers.map(worker => worker.agentProfile?.id),
    ['sf-agent.test', 'quality.v2/sf-agent..test'],
  );
  assert.deepEqual(f.runs, [
    'Use sf-agent.test',
    'Use quality.v2/sf-agent..test',
  ]);
  assert.equal(f.notices.length, 0);
  assert.equal(delegated, 0);
  await provider.getSuggestions(['@file.ts'], 0, 8, {
    signal: new AbortController().signal,
  });
  assert.equal(delegated, 1, 'Unmatched dotted file completion stays with Pi');
  assert.deepEqual(await f.input('@file.ts Read the source file'), {
    action: 'continue',
  });
});

void test('quoted ordinary filenames and scoped selections complete and launch with their exact IDs', async t => {
  const f = await fixture(t);
  const ids = [
    'My Agent (Review).test',
    'Äänekäs 助手',
    'Uppercase.Agent',
    '.Hidden Agent',
    'Team Ä/My Agent (2)',
    ' leading and trailing ',
  ];
  if (process.platform !== 'win32')
    ids.push('global:My Agent', 'Name "quoted" \\ Agent');
  for (const id of ids)
    await saveAgentTemplate(f.root, {
      scope: 'workspace',
      id,
      mode: 'all',
      model: 'test/pinned',
      instructions: `Exact filename: ${id}.`,
    });
  const candidates = await discoverAgentMentions(f.root);
  const provider = agentMentionAutocomplete(
    {
      async getSuggestions() {
        return null;
      },
      applyCompletion(lines, line, column) {
        return {lines, cursorLine: line, cursorCol: column};
      },
    },
    async () => candidates,
  );
  for (const id of ids) {
    const candidate = candidates.find(candidate => candidate.id === id)!;
    assert.ok(candidate, id);
    const mention = candidate.mention || `@${candidate.id}`;
    const query = mention.slice(0, -1);
    const task = `Use ${id}`;
    const suggestions = await provider.getSuggestions(
      [query],
      0,
      query.length,
      {signal: new AbortController().signal},
    );
    const item = suggestions?.items.find(item => item.value === mention);
    assert.ok(item, `Completion for ${mention}`);
    const completion = provider.applyCompletion(
      [`${query} ${task}`],
      0,
      query.length,
      item,
      suggestions!.prefix,
    );
    assert.equal(parseAgentMention(completion.lines[0])?.id, id);
    assert.deepEqual(await f.input(completion.lines[0]), {action: 'handled'});
  }
  await f.manager.wait(f.manager.list().map(agent => agent.id));
  assert.deepEqual(
    f.workers.map(worker => worker.agentProfile?.id),
    ids,
  );
  assert.deepEqual(
    f.workers.map(worker => worker.agentProfile?.instructions),
    ids.map(id => `Exact filename: ${id}.`),
  );
  assert.equal(f.notices.length, 0);
  assert.deepEqual(
    parseAgentMention('@"My Agent (Review).test" Direct quoted task'),
    {id: 'My Agent (Review).test', task: 'Direct quoted task', literalId: true},
  );
  const before = f.workers.length;
  assert.deepEqual(
    await f.input(
      '@agent:workspace:"My Agent (Review).test" Scoped quoted task',
    ),
    {action: 'handled'},
  );
  await f.manager.wait(f.manager.list().map(agent => agent.id));
  assert.equal(f.workers.length, before + 1);
  assert.equal(f.workers.at(-1)?.agentProfile?.id, 'My Agent (Review).test');
});

void test(
  'scoped-looking filename permissions agree across discovery, quoted launches and direct launch gates',
  {
    skip:
      process.platform === 'win32'
        ? 'Colon is not a Windows filename character'
        : false,
  },
  async t => {
    const profile = createDefaultAgentProfile();
    profile.permissions = [
      {action: 'subagent', resource: '*', effect: 'deny'},
      {action: 'subagent', resource: 'global:Agent', effect: 'allow'},
    ];
    const f = await fixture(t, {agentProfile: profile});
    for (const id of ['Agent', 'global:Agent'])
      await saveAgentTemplate(f.root, {
        scope: 'workspace',
        id,
        mode: 'all',
        model: 'test/pinned',
        instructions: `Literal profile ${id}.`,
      });
    assert.deepEqual(
      (await discoverAgentMentions(f.root, profile)).map(
        candidate => candidate.id,
      ),
      ['global:Agent'],
    );
    assert.deepEqual(
      await f.input('@agent:"global:Agent" Use the literal filename'),
      {action: 'handled'},
    );
    await f.manager.wait(f.manager.list().map(agent => agent.id));
    assert.equal(f.notices.length, 0);
    assert.equal(f.workers[0].agentProfile?.id, 'global:Agent');
    profile.permissions = [
      {action: 'subagent', resource: '*', effect: 'deny'},
      {action: 'subagent', resource: 'Agent', effect: 'allow'},
    ];
    assert.deepEqual(
      (await discoverAgentMentions(f.root, profile)).map(
        candidate => candidate.id,
      ),
      ['Agent'],
    );
    await f.input('@agent:"global:Agent" Denied literal filename');
    assert.match(f.notices.at(-1)!, /permission denied.*global:Agent/);
    const spawn = f.tools.get('agent_spawn')!;
    await assert.rejects(
      spawn.execute(
        'direct',
        {
          template: 'workspace:global:Agent',
          task: 'Cannot bypass the catalog gate',
        },
        undefined,
        undefined,
        f.ctx as never,
      ),
      /does not allow launching/,
    );
    assert.equal(f.workers.length, 1);
    assert.deepEqual(await f.input('@Agent Use the ordinary filename'), {
      action: 'handled',
    });
    await f.manager.wait(f.manager.list().map(agent => agent.id));
    assert.equal(f.workers.at(-1)?.agentProfile?.id, 'Agent');
  },
);
