import assert from 'node:assert/strict';
import type {ChildProcess} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {
  AgentOrchestrator,
  type AgentWorker,
} from '../src/agents/orchestrator.ts';
import {runAgentSessionRequest} from '../src/dashboard/agent-session.ts';
import {nativeCommands} from '../src/dashboard/command-catalog.mjs';
import {
  DashboardHub,
  agentSessionRequest,
  type DashboardParent,
  type AgentSessionRequest,
  type ParentRequest,
} from '../src/dashboard/hub.ts';
import type {SessionFeatures} from '../src/dashboard/features.ts';
import {DashboardState} from '../src/dashboard/state.ts';
import {ExternalSessionRequests} from '../src/desktop/ipc.ts';
import {createFactoryBridge} from '../src/desktop/launcher.ts';

function features(): SessionFeatures {
  return {
    commands: [],
    models: [],
    tools: [],
    diagnostics: [],
    thinkingLevel: 'off',
    thinkingLevels: ['off', 'high'],
    model: {provider: 'fixture', id: 'model'},
  };
}
function state(id: string) {
  const now = new Date().toISOString();
  return new DashboardState({
    id,
    name: id,
    cwd: process.cwd(),
    status: 'idle',
    activity: 'Ready',
    startedAt: now,
    updatedAt: now,
  });
}
function owner(id: string) {
  const manager = new AgentOrchestrator();
  const current = state(id);
  manager.subscribe(() =>
    current.updateTeam(
      manager.list().map(record => ({
        ...record,
        ...manager.conversation(record.id),
      })),
      [],
    ),
  );
  let workspaceCloses = 0;
  const mainPrompts: string[] = [];
  const parent: DashboardParent = {
    state: current,
    prompt: async prompt => {
      mainPrompts.push(prompt);
    },
    abort: async () => ({steering: [], followUp: []}),
    restartSnapshot: () => {
      throw new Error('Unused');
    },
    cancelAgent: async agentId => {
      manager.cancel(agentId);
    },
    features: async () => features(),
    configure: async () => {},
    compact: async () => {},
    reload: async () => {},
    async agentSession(request) {
      if (request.agentId === 'parent' && request.action === 'close')
        throw new Error('The Main agent cannot be closed separately.');
      return runAgentSessionRequest(manager, request);
    },
    close: () => {
      workspaceCloses++;
      return manager.close();
    },
  };
  return {
    manager,
    parent,
    mainPrompts,
    get workspaceCloses() {
      return workspaceCloses;
    },
  };
}

void test('agent session validation accepts only fields for the chosen action', () => {
  assert.deepEqual(
    agentSessionRequest({
      agentId: 'worker',
      action: 'prompt',
      prompt: '  continue  ',
    }),
    {
      agentId: 'worker',
      action: 'prompt',
      prompt: 'continue',
    },
  );
  for (const confirmWorkspaceClose of [undefined, false, true])
    assert.throws(
      () =>
        agentSessionRequest({
          agentId: 'parent',
          action: 'close',
          ...(confirmWorkspaceClose === undefined
            ? {}
            : {confirmWorkspaceClose}),
        }),
      /Main.*cannot be closed separately/i,
    );
  for (const input of [
    null,
    {agentId: 'all', action: 'abort'},
    {agentId: 'worker', action: 'unknown'},
    {agentId: 'worker', action: 'prompt', prompt: ' '},
    {agentId: 'worker', action: 'prompt', prompt: 'x'.repeat(64001)},
    {
      agentId: 'worker',
      action: 'configure',
      configuration: {provider: 'fixture'},
    },
    {
      agentId: 'worker',
      action: 'configure',
      configuration: {thinkingLevel: 'high', extra: true},
    },
    {agentId: 'worker', action: 'abort', prompt: 'unexpected'},
    {
      agentId: 'worker',
      action: 'prompt',
      prompt: 'x',
      confirmWorkspaceClose: true,
    },
    {agentId: 'worker', action: 'abort', confirmWorkspaceClose: true},
    {agentId: 'worker', action: 'close', confirmWorkspaceClose: 'yes'},
    {agentId: 'worker', action: 'compact', instructions: 123},
    {agentId: 'worker', action: 'command', command: ''},
    {
      agentId: 'worker',
      action: 'command',
      command: '/model',
      prompt: 'unexpected',
    },
  ])
    assert.throws(() => agentSessionRequest(input));
});

void test(
  'hub worker API isolates owners and publishes direct prompt, stop, settings and close updates',
  {timeout: 10000},
  async t => {
    const one = owner('one');
    const two = owner('two');
    const hub = new DashboardHub(undefined, async () => one.parent);
    hub.adoptSession(one.parent);
    hub.adoptSession(two.parent);
    t.after(() => hub.close());
    const prompts: string[] = [];
    const operations: string[] = [];
    let settings = features();
    let release: (() => void) | undefined;
    let announce: (() => void) | undefined;
    let started = new Promise<void>(resolve => {
      announce = resolve;
    });
    const worker: AgentWorker = {
      async run(message, signal, _activity, _usage, conversation) {
        prompts.push(message);
        conversation?.({
          conversation: [
            {
              id: `turn-${prompts.length}`,
              role: 'assistant',
              text: message,
              streaming: true,
              at: new Date().toISOString(),
            },
          ],
          conversationTruncated: false,
        });
        announce?.();
        if (message === 'hold')
          await new Promise<void>(resolve => {
            release = resolve;
            signal.addEventListener('abort', () => resolve(), {once: true});
          });
        signal.throwIfAborted();
        return message;
      },
      async steer(message) {
        operations.push(`steer:${message}`);
        return true;
      },
      async features() {
        return settings;
      },
      async configure(input) {
        settings = {
          ...settings,
          thinkingLevel: input.thinkingLevel ?? settings.thinkingLevel,
        };
        return settings;
      },
      async command(command) {
        operations.push(`command:${command}`);
        if (!['/settings', '/model'].includes(command))
          throw new Error(
            `Native command is unavailable in worker conversations: ${command}`,
          );
        settings = {...settings, thinkingLevel: 'off'};
        return settings;
      },
      async compact(instructions) {
        operations.push(`compact:${instructions}`);
      },
      async reload() {
        operations.push('reload');
      },
      clearQueue: () => ({steering: ['Recovered steering'], followUp: []}),
      dispose() {
        operations.push('dispose');
      },
    };
    const record = one.manager.spawn(
      {
        name: 'Worker',
        task: 'initial',
        cwd: process.cwd(),
        model: 'fixture/model',
      },
      async () => worker,
    );
    await started;
    await one.manager.wait([record.id]);
    const request = (action: AgentSessionRequest) =>
      hub.agentSession('one', action);
    await assert.rejects(
      hub.agentSession('two', {
        agentId: record.id,
        action: 'prompt',
        prompt: 'wrong owner',
      }),
      /Unknown agent/,
    );
    await assert.rejects(
      hub.agentSession('missing', {agentId: record.id, action: 'features'}),
      /Unknown/,
    );
    started = new Promise<void>(resolve => {
      announce = resolve;
    });
    await request({agentId: record.id, action: 'prompt', prompt: 'hold'});
    await started;
    const snapshot = hub
      .snapshot()
      .sessions.find(item => item.session.id === 'one')!;
    assert.equal(snapshot.session.status, 'idle');
    assert.equal(snapshot.agents[0].conversation[0].text, 'hold');
    await request({agentId: record.id, action: 'prompt', prompt: '/settings'});
    assert.ok(operations.includes('command:/settings'));
    assert.equal(one.manager.get(record.id).status, 'running');
    assert.deepEqual(prompts, ['initial', 'hold']);
    for (const {name} of nativeCommands) {
      if (['settings', 'model'].includes(name)) continue;
      await assert.rejects(
        request({agentId: record.id, action: 'prompt', prompt: `/${name}`}),
        /Native command is unavailable in worker conversations/,
      );
      assert.ok(operations.includes(`command:/${name}`));
      assert.equal(operations.includes(`steer:/${name}`), false);
    }
    for (const prompt of ['guide', '/skill:fixture', '/custom-extension']) {
      await request({agentId: record.id, action: 'prompt', prompt});
      assert.ok(operations.includes(`steer:${prompt}`));
    }
    assert.equal(operations.includes('steer:/settings'), false);
    assert.deepEqual(await request({agentId: record.id, action: 'abort'}), {
      steering: ['Recovered steering'],
      followUp: [],
    });
    assert.equal(one.manager.get(record.id).status, 'cancelled');
    await request({
      agentId: record.id,
      action: 'configure',
      configuration: {thinkingLevel: 'high'},
    });
    assert.equal(one.manager.get(record.id).thinkingLevel, 'high');
    assert.equal(
      (
        (await request({
          agentId: record.id,
          action: 'features',
        })) as SessionFeatures
      ).thinkingLevel,
      'high',
    );
    await request({agentId: record.id, action: 'command', command: '/model'});
    assert.ok(operations.includes('command:/model'));
    assert.equal(one.manager.get(record.id).thinkingLevel, 'off');
    assert.deepEqual(prompts, ['initial', 'hold']);
    await assert.rejects(
      hub.agentSession('two', {
        agentId: record.id,
        action: 'command',
        command: '/model',
      }),
      /Unknown agent/,
    );
    await request({
      agentId: record.id,
      action: 'compact',
      instructions: 'Keep findings',
    });
    await request({agentId: record.id, action: 'reload'});
    assert.ok(operations.includes('compact:Keep findings'));
    assert.ok(operations.includes('reload'));
    await request({agentId: record.id, action: 'prompt', prompt: 'resume'});
    await one.manager.wait([record.id]);
    assert.deepEqual(prompts, ['initial', 'hold', 'resume']);
    await request({agentId: record.id, action: 'close'});
    assert.equal(one.manager.get(record.id).resumable, false);
    await assert.rejects(
      request({agentId: record.id, action: 'prompt', prompt: 'closed'}),
      /cleaned up/,
    );
    assert.equal(hub.snapshot().sessions.length, 2);
    release?.();
  },
);

void test(
  'subagents accept parent work but reject direct user prompts while primary and all agents remain promptable',
  {timeout: 10000},
  async t => {
    const entry = owner('mode-owner');
    const hub = new DashboardHub(undefined, async () => entry.parent);
    hub.adoptSession(entry.parent);
    let release: (() => void) | undefined;
    t.after(async () => {
      release?.();
      await hub.close();
    });
    for (const agentMode of ['primary', 'all', 'subagent'] as const) {
      const prompts: string[] = [];
      const steering: string[] = [];
      const started = Promise.withResolvers<void>();
      const record = entry.manager.spawn(
        {
          name: agentMode,
          agentMode,
          task: 'initial',
          cwd: process.cwd(),
          model: 'fixture/model',
        },
        async () => ({
          async run(message) {
            prompts.push(message);
            if (message === 'hold') {
              started.resolve();
              await new Promise<void>(resolve => {
                release = resolve;
              });
            }
            return message;
          },
          async steer(message) {
            steering.push(message);
            return true;
          },
          features: async () => features(),
          dispose() {},
        }),
      );
      await entry.manager.wait([record.id]);
      const direct = (prompt: string) =>
        hub.agentSession('mode-owner', {
          agentId: record.id,
          action: 'prompt',
          prompt,
        });
      if (agentMode !== 'subagent') {
        await direct('continue');
        await entry.manager.wait([record.id]);
        assert.deepEqual(prompts, ['initial', 'continue']);
        continue;
      }
      await assert.rejects(direct('continue'), /through their parent agent/);
      await assert.rejects(direct('/model'), /through their parent agent/);
      assert.deepEqual(
        await hub.agentSession('mode-owner', {
          agentId: record.id,
          action: 'features',
        }),
        features(),
      );
      await entry.manager.send(record.id, 'hold', {
        kind: 'parent',
        id: 'mode-owner',
      });
      await started.promise;
      await assert.rejects(
        direct('steer directly'),
        /through their parent agent/,
      );
      await entry.manager.send(record.id, 'parent guidance', {
        kind: 'parent',
        id: 'mode-owner',
      });
      assert.deepEqual(steering, ['parent guidance']);
      release?.();
      await entry.manager.wait([record.id]);
      assert.deepEqual(prompts, ['initial', 'hold']);
    }
  },
);

void test(
  'hub deletes the desktop template payload from its selected repository source',
  {timeout: 10000},
  async t => {
    const directory = await mkdtemp(
      join(tmpdir(), 'varisdev-template-delete-'),
    );
    const root = join(directory, 'repository');
    const cwd = join(root, 'nested');
    await mkdir(join(root, '.git'), {recursive: true});
    await mkdir(cwd);
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(directory, 'settings');
    const hub = new DashboardHub(undefined, async () => owner('unused').parent);
    t.after(async () => {
      await hub.close();
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, {recursive: true, force: true});
    });
    const rootTemplate = await hub.saveAgentTemplate(root, {
      scope: 'repository',
      id: 'reviewer',
      instructions: 'Root reviewer',
    });
    const nestedPath = join(
      await realpath(cwd),
      '.pi',
      'agents',
      'reviewer.md',
    );
    await mkdir(join(cwd, '.pi', 'agents'), {recursive: true});
    await writeFile(nestedPath, '---\n---\nNested reviewer\n');
    const listed = await hub.listAgentTemplates(cwd);
    const copies = listed.allTemplates.filter(
      item => item.scope === 'repository' && item.id === 'reviewer',
    );
    assert.equal(copies.length, 2);
    const nested = copies.find(item => item.sourcePath === nestedPath)!;
    assert.ok(nested);
    const payload = {
      scope: nested.scope,
      id: nested.id,
      sourcePath: nested.sourcePath,
    };
    await assert.rejects(
      hub.deleteAgentTemplate(cwd, {...payload, extra: true}),
      /Unknown agent template field/,
    );
    await hub.deleteAgentTemplate(cwd, payload);
    await assert.rejects(readFile(nestedPath), {code: 'ENOENT'});
    await assert.rejects(
      hub.deleteAgentTemplate(cwd, {...payload, sourcePath: 42}),
      /sourcePath/,
    );
    await assert.rejects(
      hub.deleteAgentTemplate(cwd, {
        ...payload,
        sourcePath: join(directory, 'reviewer.md'),
      }),
      /sourcePath/,
    );
    assert.match(
      await readFile(rootTemplate.sourcePath, 'utf8'),
      /Root reviewer/,
    );
    assert.deepEqual(
      (await hub.listAgentTemplates(cwd)).allTemplates
        .filter(item => item.scope === 'repository' && item.id === 'reviewer')
        .map(item => item.sourcePath),
      [rootTemplate.sourcePath],
    );
    await hub.deleteAgentTemplate(cwd, {
      scope: rootTemplate.scope,
      id: rootTemplate.id,
      sourcePath: rootTemplate.sourcePath,
    });
    await assert.rejects(readFile(rootTemplate.sourcePath), {code: 'ENOENT'});
  },
);

void test(
  'hub template management stays available while Main creation ignores defaults and rejects configurations',
  {timeout: 10000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-template-api-'));
    const cwd = join(directory, 'repository');
    await mkdir(cwd);
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(directory, 'settings');
    const created: ParentRequest[] = [];
    const hub = new DashboardHub(undefined, async request => {
      created.push(request);
      return owner(`instance-${created.length}`).parent;
    });
    t.after(async () => {
      await hub.close();
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, {recursive: true, force: true});
    });
    await assert.rejects(hub.listAgentTemplates('.'), /absolute/);
    await assert.rejects(hub.saveAgentTemplate(cwd, null), /JSON object/);
    await assert.rejects(
      hub.deleteAgentTemplate(cwd, {scope: 'global', id: '../outside'}),
      /relative filename path/,
    );

    const resolvedCwd = await realpath(cwd);
    const plain = await hub.createSession({cwd});
    assert.deepEqual(created.at(-1), {cwd: resolvedCwd, name: undefined});
    await hub.closeSession(plain.id);

    const defaults = {
      id: 'reviewer',
      name: 'Global reviewer',
      instructions: 'Global instructions',
      model: 'fixture/model',
      thinkingLevel: 'high',
    };
    await hub.saveAgentTemplate(cwd, {...defaults, scope: 'global'});
    await hub.saveAgentTemplate(cwd, {
      ...defaults,
      scope: 'repository',
      name: 'Repository reviewer',
      instructions: 'Repository instructions',
    });
    await hub.saveAgentTemplate(cwd, {
      ...defaults,
      scope: 'workspace',
      name: 'Personal reviewer',
      instructions: 'Personal instructions',
    });
    const listed = await hub.listAgentTemplates(cwd);
    assert.equal(
      listed.templates.filter(item => item.id === 'reviewer').length,
      1,
    );
    assert.equal(
      listed.templates.find(item => item.id === 'reviewer')?.scope,
      'workspace',
    );
    assert.equal(
      listed.allTemplates.filter(item => item.id === 'reviewer').length,
      3,
    );

    const mainConfigurationError = (error: unknown) => {
      assert.equal(
        (error as Error).message,
        'The Main agent does not use an agent configuration.',
      );
      return true;
    };
    const creationCount = created.length;
    for (const templateId of ['reviewer', 'global:reviewer', 'missing'])
      await assert.rejects(
        hub.createSession({cwd, templateId}),
        mainConfigurationError,
      );
    await assert.rejects(
      hub.createSession({cwd, sessionId: 'saved', templateId: 'reviewer'}),
      mainConfigurationError,
    );
    assert.equal(created.length, creationCount);

    await hub.deleteAgentTemplate(cwd, {scope: 'workspace', id: 'reviewer'});
    await hub.deleteAgentTemplate(cwd, {scope: 'repository', id: 'reviewer'});
    const remaining = await hub.listAgentTemplates(cwd);
    assert.equal(
      remaining.templates.find(item => item.id === 'reviewer')?.scope,
      'global',
    );

    const settingsPath = join(directory, 'settings', 'settings.json');
    await writeFile(settingsPath, JSON.stringify({default_agent: 'reviewer'}));
    const configuredDefault = await hub.createSession({cwd});
    assert.deepEqual(created.at(-1), {cwd: resolvedCwd, name: undefined});
    await hub.closeSession(configuredDefault.id);

    await hub.saveAgentTemplate(cwd, {
      scope: 'global',
      id: 'hidden-primary',
      mode: 'primary',
      hidden: true,
      instructions: 'Hidden profile',
    });
    await hub.saveAgentTemplate(cwd, {
      scope: 'global',
      id: 'child-only',
      mode: 'subagent',
      instructions: 'Child profile',
    });
    await hub.saveAgentTemplate(cwd, {
      scope: 'global',
      id: 'disabled-profile',
      disabled: true,
      instructions: 'Disabled profile',
    });
    for (const templateId of [
      'hidden-primary',
      'child-only',
      'disabled-profile',
    ])
      await assert.rejects(
        hub.createSession({cwd, templateId}),
        mainConfigurationError,
      );

    for (const defaultAgent of [
      'hidden-primary',
      'child-only',
      'disabled-profile',
      'missing',
    ]) {
      await writeFile(
        settingsPath,
        JSON.stringify({default_agent: defaultAgent}),
      );
      const result = await hub.createSession({cwd});
      assert.deepEqual(created.at(-1), {cwd: resolvedCwd, name: undefined});
      await hub.closeSession(result.id);
    }

    const namedPlain = await hub.createSession({
      cwd,
      name: 'Chosen plain name',
    });
    assert.deepEqual(created.at(-1), {
      cwd: resolvedCwd,
      name: 'Chosen plain name',
    });
    await hub.closeSession(namedPlain.id);

    for (const id of [
      'My Agent (Ä).test',
      ' leading and trailing ',
      `${'Team'.repeat(40)}/${'Agent'.repeat(40)}`,
    ]) {
      await hub.saveAgentTemplate(cwd, {
        scope: 'global',
        id,
        mode: 'all',
        instructions: 'Ordinary filename profile.',
      });
      assert.ok(
        (await hub.listAgentTemplates(cwd)).allTemplates.some(
          template => template.id === id,
        ),
      );
      await assert.rejects(
        hub.createSession({cwd, templateId: id}),
        mainConfigurationError,
      );
    }
  },
);

class FakeChild extends EventEmitter {
  connected = true;
  deliver?: (value: object) => void;
  send(value: object, callback?: () => void) {
    this.deliver?.(value);
    callback?.();
    return true;
  }
}

void test('attached agent requests validate and carry results without reaching owner prompt controls', async () => {
  const child = new FakeChild();
  const bridge = createFactoryBridge(child as unknown as ChildProcess);
  const calls: AgentSessionRequest[] = [];
  bridge.attach(state('attached'), {
    prompt: () => {
      assert.fail('Wrong conversation');
    },
    abort: () => ({steering: [], followUp: []}),
    cancelAgent: () => {},
    features: async () => features(),
    configure: async () => {},
    compact: async () => {},
    reload: async () => {},
    async agentSession(request) {
      calls.push(request);
      return request.action === 'features' ? features() : undefined;
    },
  });
  bridge.ready();
  const requests = new ExternalSessionRequests(
    async message => {
      child.emit('message', message);
    },
    () => child.connected,
  );
  child.deliver = value => {
    requests.reply(value);
  };
  assert.deepEqual(
    await requests.request('agentSession', 'attached', {
      agentId: 'worker',
      action: 'features',
    }),
    features(),
  );
  await requests.request('agentSession', 'attached', {
    agentId: 'worker',
    action: 'prompt',
    prompt: '  direct  ',
  });
  await requests.request('agentSession', 'attached', {
    agentId: 'worker',
    action: 'close',
  });
  assert.deepEqual(
    calls.map(call => call.action),
    ['features', 'prompt', 'close'],
  );
  assert.equal((calls[1] as {prompt: string}).prompt, 'direct');
  await assert.rejects(
    requests.request('agentSession', 'stale', {
      agentId: 'worker',
      action: 'abort',
    }),
    /no longer attached/,
  );
  await assert.rejects(
    requests.request('agentSession', 'attached', {
      agentId: 'all',
      action: 'abort',
    }),
    /one agent/,
  );
  await assert.rejects(
    requests.request('agentSession', 'attached', {
      agentId: 'worker',
      action: 'configure',
      configuration: {persist: 'yes'},
    }),
    /Choose a model/,
  );
  assert.equal(calls.length, 3);
  bridge.detach();
  requests.disconnect();
});

async function primaryWorker(
  entry: ReturnType<typeof owner>,
  agentMode: 'primary' | 'all' | 'subagent' = 'all',
) {
  const prompts: string[] = [];
  let disposals = 0;
  const record = entry.manager.spawn(
    {
      name: agentMode,
      agentMode,
      task: 'initial',
      cwd: process.cwd(),
      model: 'fixture/model',
    },
    async () => ({
      async run(prompt) {
        prompts.push(prompt);
        return prompt;
      },
      async steer() {
        return false;
      },
      dispose() {
        disposals++;
      },
    }),
  );
  await entry.manager.wait([record.id]);
  return {
    id: record.id,
    prompts,
    get disposals() {
      return disposals;
    },
  };
}

void test(
  'Main cannot close separately and remains usable after every additional agent closes',
  {timeout: 10000},
  async t => {
    const entry = owner('persistent-main');
    const primary = await primaryWorker(entry, 'primary');
    const subagent = await primaryWorker(entry, 'subagent');
    const hub = new DashboardHub(undefined, async () => entry.parent);
    hub.adoptSession(entry.parent);
    t.after(() => hub.close());

    const beforeMainClose = hub.snapshot();
    for (const confirmWorkspaceClose of [undefined, false, true])
      await assert.rejects(
        hub.agentSession('persistent-main', {
          agentId: 'parent',
          action: 'close',
          ...(confirmWorkspaceClose === undefined
            ? {}
            : {confirmWorkspaceClose}),
        }),
        /Main.*cannot be closed separately/i,
      );
    assert.deepEqual(hub.snapshot(), beforeMainClose);
    assert.equal(entry.workspaceCloses, 0);

    assert.equal(
      await hub.agentSession('persistent-main', {
        agentId: primary.id,
        action: 'close',
        confirmWorkspaceClose: true,
      }),
      undefined,
    );
    assert.equal(primary.disposals, 1);
    assert.equal(entry.manager.get(primary.id).resumable, false);
    assert.equal(hub.snapshot().sessions.length, 1);
    assert.notEqual(hub.snapshot().sessions[0].session.primaryClosed, true);
    assert.equal(entry.workspaceCloses, 0);

    assert.equal(
      await hub.agentSession('persistent-main', {
        agentId: subagent.id,
        action: 'close',
      }),
      undefined,
    );
    assert.equal(subagent.disposals, 1);
    assert.equal(entry.manager.get(subagent.id).resumable, false);
    assert.equal(hub.snapshot().sessions.length, 1);
    assert.notEqual(hub.snapshot().sessions[0].session.primaryClosed, true);
    assert.equal(entry.workspaceCloses, 0);

    await hub.promptSession('persistent-main', {
      prompt: 'Main continues after all additional agents close',
    });
    assert.deepEqual(entry.mainPrompts, [
      'Main continues after all additional agents close',
    ]);

    await hub.closeSession('persistent-main');
    assert.equal(entry.workspaceCloses, 1);
    assert.equal(hub.snapshot().sessions.length, 0);
  },
);

void test(
  'attached additional agent closure never closes its workspace even with confirmation',
  {timeout: 10000},
  async t => {
    const source = owner('attached-persistent-main');
    const primary = await primaryWorker(source, 'primary');
    const hub = new DashboardHub(undefined, async () => source.parent);
    t.after(async () => {
      await hub.close();
      await source.parent.close();
    });
    hub.updateExternal(source.parent.state.snapshot());
    hub.setExternalControl({
      prompt: async (_id, prompt) => source.parent.prompt(prompt),
      abort: async () => ({steering: [], followUp: []}),
      cancelAgent: async () => {},
      features: async () => features(),
      configure: async () => {},
      compact: async () => {},
      reload: async () => {},
      agentSession: async (_id, request) =>
        source.parent.agentSession!(request),
    });

    await assert.rejects(
      hub.agentSession('attached-persistent-main', {
        agentId: 'parent',
        action: 'close',
      }),
      /Main.*cannot be closed separately/i,
    );
    assert.equal(
      await hub.agentSession('attached-persistent-main', {
        agentId: primary.id,
        action: 'close',
        confirmWorkspaceClose: true,
      }),
      undefined,
    );
    assert.equal(primary.disposals, 1);
    assert.equal(source.workspaceCloses, 0);
    const snapshot = hub.snapshot().sessions[0];
    assert.equal(snapshot.session.id, 'attached-persistent-main');
    assert.notEqual(snapshot.session.primaryClosed, true);
    assert.equal(snapshot.session.status, 'idle');

    await hub.promptSession('attached-persistent-main', {
      prompt: 'Attached Main remains available',
    });
    assert.deepEqual(source.mainPrompts, ['Attached Main remains available']);
  },
);

void test(
  'concurrent additional agent closes never turn into a workspace close',
  {timeout: 10000},
  async t => {
    const entry = owner('concurrent-agent-close');
    const primary = await primaryWorker(entry, 'primary');
    const subagent = await primaryWorker(entry, 'subagent');
    const hub = new DashboardHub(undefined, async () => entry.parent);
    hub.adoptSession(entry.parent);
    t.after(() => hub.close());

    assert.deepEqual(
      await Promise.all([
        hub.agentSession('concurrent-agent-close', {
          agentId: primary.id,
          action: 'close',
          confirmWorkspaceClose: true,
        }),
        hub.agentSession('concurrent-agent-close', {
          agentId: subagent.id,
          action: 'close',
          confirmWorkspaceClose: true,
        }),
      ]),
      [undefined, undefined],
    );
    assert.equal(primary.disposals, 1);
    assert.equal(subagent.disposals, 1);
    assert.equal(entry.workspaceCloses, 0);
    assert.equal(hub.snapshot().sessions.length, 1);
    assert.notEqual(hub.snapshot().sessions[0].session.primaryClosed, true);
  },
);
