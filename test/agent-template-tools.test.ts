import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {registerAgentTools} from '../src/tools/agents.ts';
import {saveToolSettings} from '../src/tools/settings.ts';
import type {createSessionWorker} from '../src/agents/session.ts';
import type {AgentRecord} from '../src/agents/orchestrator.ts';
import {
  prepareAgentTemplateGet,
  resolveAgentTemplate,
} from '../src/agents/templates.ts';

void test(
  'agent configuration tools persist all writable scopes and apply defaults to spawned conversations',
  {timeout: 10000},
  async t => {
    const root = await mkdtemp(join(tmpdir(), 'varisdev-template-tools-'));
    const cwd = join(root, 'project');
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, 'settings');
    await mkdir(cwd, {recursive: true});
    const models = [
      {provider: 'fixture', id: 'default'},
      {provider: 'fixture', id: 'review'},
    ];
    await saveToolSettings('agents', {
      allowedModels: models.map(model => `${model.provider}/${model.id}`),
    });
    const tools = new Map<string, ToolDefinition>();
    const seen: Array<Parameters<typeof createSessionWorker>[0]> = [];
    const workerTools = new Map<string, Map<string, ToolDefinition>>();
    type Listener = (
      event: Record<string, unknown>,
      ctx: ExtensionContext,
    ) => unknown;
    const listeners = new Map<
      Map<string, ToolDefinition>,
      Map<string, Listener[]>
    >();
    const extension = (registered: Map<string, ToolDefinition>) =>
      ({
        on(name: string, listener: Listener) {
          const events =
            listeners.get(registered) ?? new Map<string, Listener[]>();
          events.set(name, [...(events.get(name) ?? []), listener]);
          listeners.set(registered, events);
        },
        registerCommand() {},
        registerTool(tool: ToolDefinition) {
          registered.set(tool.name, tool);
        },
        getThinkingLevel: () => 'medium',
      }) as unknown as ExtensionAPI;
    const ctx = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => false,
      model: models[0],
      modelRegistry: {
        find: (provider: string, id: string) =>
          models.find(model => model.provider === provider && model.id === id),
      },
      sessionManager: {getSessionId: () => 'initiator'},
      tools: [],
    } as unknown as ExtensionToolContext;
    const createWorker = async (
      options: Parameters<typeof createSessionWorker>[0],
    ) => {
      seen.push(options);
      const registered = new Map<string, ToolDefinition>();
      await options.agentToolsExtension(extension(registered));
      workerTools.set(options.id, registered);
      return {
        async run() {
          return 'Finished';
        },
        async steer() {
          return true;
        },
        dispose() {},
      };
    };
    const control = registerAgentTools(extension(tools), createWorker);
    const controls = [control];
    t.after(async () => {
      await Promise.all(
        controls.map(item => item.getTeam(ctx).getManager().close()),
      );
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, {recursive: true, force: true});
    });
    const execute = (
      name: string,
      input: Record<string, unknown>,
      source = tools,
    ) => source.get(name)!.execute('call', input, undefined, undefined, ctx);
    const catalogFor = (source = tools) => {
      const schema = source.get('agent_spawn')!.parameters as unknown as {
        properties: {template: {description: string}};
      };
      return schema.properties.template.description;
    };
    const plainListing = (await execute('agent_templates', {})).details as {
      templates: Array<{id: string}>;
      defaultAgentId: string;
    };
    assert.deepEqual(plainListing.templates.map(profile => profile.id).sort(), [
      'build',
      'default',
      'explore',
      'general',
      'plan',
    ]);
    assert.equal(plainListing.defaultAgentId, 'default');
    for (const listener of listeners.get(tools)?.get('before_agent_start') ??
      [])
      await listener({}, ctx);
    assert.doesNotMatch(catalogFor(), /commit:|build:|plan:/);
    assert.match(catalogFor(), /default:/);
    assert.match(catalogFor(), /explore:/);
    assert.match(catalogFor(), /general:/);
    const save = (scope: string, instructions: string, model: string) =>
      execute('agent_templates', {
        action: 'save',
        id: 'reviewer',
        scope,
        name: 'Reviewer',
        mode: 'all',
        instructions,
        model,
        thinkingLevel: 'high',
        request: {headers: {'x-agent': 'reviewer'}, body: {temperature: 0.2}},
      });
    const acknowledgement = await save(
      'global',
      'Review global conventions.',
      'fixture/default',
    );
    assert.equal((acknowledgement.details as {saved: boolean}).saved, true);
    assert.doesNotMatch(
      (acknowledgement.content[0] as {text: string}).text,
      /Review global conventions/,
    );
    await save(
      'repository',
      'Review repository conventions.',
      'fixture/review',
    );
    await save('workspace', 'Review workspace conventions.', 'fixture/review');
    const listing = await execute('agent_templates', {});
    const templates = JSON.parse(
      (listing.content[0] as {text: string}).text,
    ).templates;
    const reviewer = templates.find(
      (template: {id: string}) => template.id === 'reviewer',
    );
    assert.equal(reviewer.scope, 'workspace');
    assert.equal(reviewer.instructions, undefined);
    assert.equal(reviewer.sourcePath, undefined);
    assert.equal(reviewer.request, undefined);
    const pageIds: string[] = [];
    let offset: number | undefined = 0;
    do {
      const page = (await execute('agent_templates', {offset, limit: 2}))
        .details as {
        templates: Array<{id: string}>;
        nextOffset?: number;
        total: number;
      };
      assert.ok(page.templates.length <= 2);
      assert.equal(page.total, templates.length);
      pageIds.push(...page.templates.map(item => item.id));
      offset = page.nextOffset;
    } while (offset !== undefined);
    assert.deepEqual(
      pageIds,
      templates.map((item: {id: string}) => item.id),
    );
    const saved = await execute('agent_templates', {
      action: 'get',
      id: 'reviewer',
      scope: 'global',
    });
    assert.equal(
      (saved.details as {instructions: string}).instructions,
      'Review global conventions.',
    );
    assert.deepEqual((saved.details as {request: unknown}).request, {
      headers: {'x-agent': 'reviewer'},
      body: {temperature: 0.2},
    });
    const approvedGet = {action: 'get', id: 'reviewer', scope: 'global'};
    await prepareAgentTemplateGet(cwd, approvedGet);
    await save('global', 'Changed after approval.', 'fixture/default');
    const approvedRead = await execute('agent_templates', approvedGet);
    assert.equal(
      (approvedRead.details as {instructions: string}).instructions,
      'Review global conventions.',
    );
    approvedGet.id = 'explore';
    await assert.rejects(
      execute('agent_templates', approvedGet),
      /selector changed after permission approval/,
    );
    await save('global', 'Review global conventions.', 'fixture/default');
    await assert.rejects(
      execute('agent_templates', {
        action: 'delete',
        id: 'reviewer',
        scope: 'global',
        sourcePath: join(root, 'different.md'),
      }),
      /sourcePath/,
    );
    const result = await execute('agent_spawn', {
      template: 'reviewer',
      task: 'Review this change.',
      instructions: 'Focus on errors.',
    });
    const record = (result.details as {agents: AgentRecord[]}).agents[0];
    const manager = control.getTeam(ctx).getManager();
    await manager.wait([record.id], {timeoutMs: 2000});
    assert.equal(seen[0].name, 'Reviewer');
    assert.equal(seen[0].model, models[1]);
    assert.equal(seen[0].thinkingLevel, 'high');
    assert.equal(seen[0].instructions, 'Focus on errors.');
    assert.equal(seen[0].context, 'workspace');
    assert.equal(
      seen[0].agentProfile?.instructions,
      'Review workspace conventions.',
    );
    assert.deepEqual(
      [...workerTools.get(record.id)!.keys()].sort(),
      [...tools.keys()].sort(),
    );
    const nested = await execute(
      'agent_spawn',
      {
        template: 'reviewer',
        name: 'Second reviewer',
        task: 'Review the result.',
        model: 'fixture/default',
        thinkingLevel: 'low',
      },
      workerTools.get(record.id),
    );
    const nestedRecord = (nested.details as {agents: AgentRecord[]}).agents[0];
    await manager.wait([nestedRecord.id], {timeoutMs: 2000});
    assert.equal(seen[1].name, 'Second reviewer');
    assert.equal(seen[1].model, models[0]);
    assert.equal(seen[1].thinkingLevel, 'low');
    assert.equal(
      manager.list().length,
      2,
      'Nested agents share the same workspace registry',
    );
    await assert.rejects(
      execute(
        'agent_wait',
        {ids: [record.id], timeoutMs: 0},
        workerTools.get(record.id),
      ),
      /cannot wait for itself/,
    );
    const ownWait = await execute(
      'agent_wait',
      {timeoutMs: 0},
      workerTools.get(record.id),
    );
    assert.deepEqual(
      (ownWait.details as {agents: AgentRecord[]}).agents.map(
        agent => agent.id,
      ),
      [nestedRecord.id],
    );
    await execute('agent_templates', {
      action: 'delete',
      id: 'reviewer',
      scope: 'workspace',
    });
    const repositoryFallback = await execute('agent_templates', {
      action: 'get',
      id: 'reviewer',
    });
    assert.equal(
      (repositoryFallback.details as {scope: string}).scope,
      'repository',
    );
    await execute('agent_templates', {
      action: 'delete',
      id: 'reviewer',
      scope: 'repository',
    });
    const fallback = await execute('agent_templates', {
      action: 'get',
      id: 'reviewer',
    });
    assert.equal((fallback.details as {scope: string}).scope, 'global');
    await assert.rejects(
      execute('agent_spawn', {template: 'missing', task: 'Work'}),
      /Unknown agent configuration: missing/,
    );
    const defaultLaunch = await execute('agent_spawn', {task: 'Work'});
    const defaultRecord = (defaultLaunch.details as {agents: AgentRecord[]})
      .agents[0];
    await manager.wait([defaultRecord.id], {timeoutMs: 2000});
    assert.equal(seen.at(-1)?.name, 'Default');
    assert.equal(seen.at(-1)?.agentProfile?.id, 'default');
    assert.equal(seen.at(-1)?.agentProfile?.instructions, '');
    assert.deepEqual(seen.at(-1)?.agentProfile?.permissions, []);

    for (const definition of [
      {id: 'primary-only'},
      {id: 'hidden-helper', mode: 'subagent', hidden: true, context: 'task'},
      {id: 'offline', mode: 'subagent', disabled: true},
    ])
      await execute('agent_templates', {
        action: 'save',
        scope: 'workspace',
        ...definition,
      });
    await assert.rejects(
      execute('agent_spawn', {template: 'primary-only', task: 'Work'}),
      /primary/,
    );
    await assert.rejects(
      execute('agent_spawn', {template: 'offline', task: 'Work'}),
      /disabled/,
    );
    const visible = (await execute('agent_templates', {})).details as {
      templates: Array<{id: string}>;
    };
    assert.ok(
      !visible.templates.some(item =>
        ['hidden-helper', 'offline'].includes(item.id),
      ),
    );
    const hidden = await execute('agent_spawn', {
      template: 'workspace:hidden-helper',
      task: 'Use only this task.',
    });
    await manager.wait(
      [(hidden.details as {agents: AgentRecord[]}).agents[0].id],
      {timeoutMs: 2000},
    );
    assert.equal(seen.at(-1)?.context, 'task');
    assert.equal(seen.at(-1)?.name, 'hidden-helper');
    const overridden = await execute('agent_spawn', {
      template: 'hidden-helper',
      context: 'workspace',
      task: 'Use workspace instructions.',
    });
    await manager.wait(
      [(overridden.details as {agents: AgentRecord[]}).agents[0].id],
      {timeoutMs: 2000},
    );
    assert.equal(seen.at(-1)?.context, 'workspace');

    await execute('agent_templates', {
      action: 'save',
      scope: 'workspace',
      id: 'coordinator',
      permissions: [
        {action: 'subagent', resource: '*', effect: 'deny'},
        {action: 'subagent', resource: 'searcher', effect: 'allow'},
      ],
    });
    await execute('agent_templates', {
      action: 'save',
      scope: 'workspace',
      id: 'searcher',
      mode: 'subagent',
      permissions: [{action: 'subagent', resource: '*', effect: 'deny'}],
    });
    const restrictedTools = new Map<string, ToolDefinition>();
    const approval = {hasUI: true, confirm: async () => true};
    const restrictedControl = registerAgentTools(
      extension(restrictedTools),
      createWorker,
      {
        agentProfile: await resolveAgentTemplate(cwd, 'coordinator'),
        approval,
      },
    );
    controls.push(restrictedControl);
    for (const input of [{name: 'searcher'}, {template: 'global:reviewer'}])
      await assert.rejects(
        execute('agent_spawn', {...input, task: 'Work'}, restrictedTools),
        /does not allow/,
      );
    for (const listener of listeners
      .get(restrictedTools)
      ?.get('before_agent_start') ?? [])
      await listener({}, ctx);
    const restrictedCatalog = catalogFor(restrictedTools);
    assert.match(restrictedCatalog, /searcher:/);
    assert.doesNotMatch(restrictedCatalog, /reviewer:|hidden-helper:/);
    const searched = await execute(
      'agent_spawn',
      {template: 'workspace:searcher', task: 'Find relevant files.'},
      restrictedTools,
    );
    const searcher = (searched.details as {agents: AgentRecord[]}).agents[0];
    await restrictedControl
      .getTeam(ctx)
      .getManager()
      .wait([searcher.id], {timeoutMs: 2000});
    assert.equal(seen.at(-1)?.approval, approval);
    assert.equal(seen.at(-1)?.agentProfile?.id, 'searcher');
    await assert.rejects(
      execute(
        'agent_spawn',
        {template: 'searcher', task: 'Delegate again.'},
        workerTools.get(searcher.id),
      ),
      /does not allow/,
    );

    for (let index = 0; index < 18; index++)
      await execute('agent_templates', {
        action: 'save',
        scope: 'workspace',
        id: `catalog/helper-${String(index).padStart(2, '0')}`,
        mode: 'subagent',
        description: `Description ${'detail '.repeat(60)}`,
      });
    for (const listener of listeners.get(tools)?.get('before_agent_start') ??
      [])
      await listener({}, ctx);
    const catalog = catalogFor();
    assert.equal(catalog.match(/catalog\/helper-\d+:/g)?.length, 16);
    assert.doesNotMatch(
      catalog,
      /primary-only:|hidden-helper:|offline:|Review global conventions/,
    );
    const compact = (await execute('agent_templates', {})).details as {
      templates: Array<{description?: string}>;
      total: number;
      nextOffset: number;
    };
    assert.equal(compact.templates.length, 20);
    assert.ok(compact.total > 20);
    assert.equal(compact.nextOffset, 20);
    assert.ok(
      compact.templates.every(
        item => !item.description || item.description.length <= 180,
      ),
    );
  },
);
