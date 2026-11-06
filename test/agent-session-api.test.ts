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
import {SessionManager} from '@earendil-works/pi-coding-agent';
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
import {createDefaultAgentProfile} from '../src/agents/templates.ts';
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
  let starterCloses = 0;
  const parent: DashboardParent = {
    state: current,
    prompt: async () => {
      throw new Error('Owner must not receive worker prompts.');
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
      if (request.agentId === 'parent' && request.action === 'close') {
        starterCloses++;
        current.updateSession({primaryClosed: true});
        return;
      }
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
    get workspaceCloses() {
      return workspaceCloses;
    },
    get starterCloses() {
      return starterCloses;
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
  assert.deepEqual(
    agentSessionRequest({
      agentId: 'parent',
      action: 'close',
      confirmWorkspaceClose: false,
    }),
    {agentId: 'parent', action: 'close', confirmWorkspaceClose: false},
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
  'hub templates validate folders, resolve scoped defaults and pass independent instance settings to creation',
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
    const plain = await hub.createSession({cwd});
    const plainRequest = created.shift();
    assert.deepEqual(plainRequest, {
      cwd: await realpath(cwd),
      name: undefined,
      agentProfile: {...createDefaultAgentProfile(), permissionsVersion: 1},
    });
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
    await hub.createSession({cwd, templateId: 'reviewer'});
    assert.deepEqual(created[0], {
      cwd: await realpath(cwd),
      name: undefined,
      agentProfile: listed.templates.find(item => item.id === 'reviewer'),
    });
    assert.notEqual(
      created[0].agentProfile,
      listed.templates.find(item => item.id === 'reviewer'),
    );
    await hub.createSession({
      cwd,
      templateId: 'global:reviewer',
      name: 'Explicit name',
    });
    assert.equal(created[1].name, 'Explicit name');
    assert.equal(created[1].agentProfile?.instructions, 'Global instructions');
    await assert.rejects(
      hub.createSession({cwd, sessionId: 'saved', templateId: 'reviewer'}),
      /new conversations/,
    );
    await assert.rejects(
      hub.createSession({cwd, templateId: 'missing'}),
      /unavailable/,
    );
    await hub.deleteAgentTemplate(cwd, {scope: 'workspace', id: 'reviewer'});
    await hub.deleteAgentTemplate(cwd, {scope: 'repository', id: 'reviewer'});
    const remaining = await hub.listAgentTemplates(cwd);
    assert.equal(
      remaining.templates.find(item => item.id === 'reviewer')?.scope,
      'global',
    );
    assert.equal(
      created[0].agentProfile?.instructions,
      'Personal instructions',
    );

    const settingsPath = join(directory, 'settings', 'settings.json');
    await writeFile(settingsPath, JSON.stringify({default_agent: 'reviewer'}));
    await hub.createSession({cwd});
    assert.equal(created[2].agentProfile?.id, 'reviewer');
    assert.equal(
      created[2].name,
      undefined,
      'configured default agents keep automatic folder naming',
    );
    await hub.saveAgentTemplate(cwd, {
      scope: 'global',
      id: 'hidden-primary',
      mode: 'primary',
      hidden: true,
      instructions: 'Hidden profile',
    });
    await writeFile(
      settingsPath,
      JSON.stringify({default_agent: 'hidden-primary'}),
    );
    await hub.createSession({cwd});
    assert.equal(created[3].agentProfile?.id, 'default');
    assert.equal(
      created[3].name,
      undefined,
      'plain defaults keep automatic folder naming',
    );
    await hub.createSession({cwd, templateId: 'hidden-primary'});
    assert.equal(created[4].agentProfile?.id, 'hidden-primary');
    await hub.saveAgentTemplate(cwd, {
      scope: 'global',
      id: 'child-only',
      mode: 'subagent',
      instructions: 'Child profile',
    });
    await assert.rejects(
      hub.createSession({cwd, templateId: 'child-only'}),
      /primary use/,
    );
    await hub.saveAgentTemplate(cwd, {
      scope: 'global',
      id: 'disabled-profile',
      disabled: true,
      instructions: 'Disabled profile',
    });
    await assert.rejects(
      hub.createSession({cwd, templateId: 'disabled-profile'}),
      /unavailable/,
    );
    for (const defaultAgent of [
      undefined,
      'missing',
      'disabled-profile',
      'child-only',
    ]) {
      await writeFile(
        settingsPath,
        JSON.stringify(defaultAgent ? {default_agent: defaultAgent} : {}),
      );
      const result = await hub.createSession({cwd});
      assert.deepEqual(created.at(-1)?.agentProfile, {
        ...createDefaultAgentProfile(),
        permissionsVersion: 1,
      });
      assert.equal(created.at(-1)?.name, undefined);
      await hub.closeSession(result.id);
    }
    const namedPlain = await hub.createSession({
      cwd,
      name: 'Chosen plain name',
    });
    assert.deepEqual(created.at(-1)?.agentProfile, {
      ...createDefaultAgentProfile(),
      permissionsVersion: 1,
    });
    assert.equal(created.at(-1)?.name, 'Chosen plain name');
    await hub.closeSession(namedPlain.id);
    listed.templates.find(item => item.id === 'reviewer')!.instructions =
      'Changed outside the created session';
    assert.equal(
      created[0].agentProfile?.instructions,
      'Personal instructions',
    );
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
      const started = await hub.createSession({cwd, templateId: id});
      assert.equal(created.at(-1)?.agentProfile?.id, id);
      assert.equal(
        created.at(-1)?.agentProfile?.instructions,
        'Ordinary filename profile.',
      );
      await hub.closeSession(started.id);
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
  'closing starter keeps other primary conversations and workspace identity usable',
  {timeout: 10000},
  async t => {
    const entry = owner('starter-close');
    const worker = await primaryWorker(entry);
    const hub = new DashboardHub(undefined, async () => entry.parent);
    hub.adoptSession(entry.parent);
    t.after(() => hub.close());
    assert.equal(
      await hub.agentSession('starter-close', {
        agentId: 'parent',
        action: 'close',
      }),
      undefined,
    );
    assert.equal(entry.starterCloses, 1);
    assert.equal(entry.workspaceCloses, 0);
    const snapshot = hub.snapshot().sessions[0];
    assert.equal(snapshot.session.id, 'starter-close');
    assert.equal(snapshot.session.primaryClosed, true);
    assert.equal(snapshot.session.status, 'idle');
    assert.equal(worker.disposals, 0);
    await hub.agentSession('starter-close', {
      agentId: worker.id,
      action: 'prompt',
      prompt: 'continue',
    });
    await entry.manager.wait([worker.id]);
    assert.deepEqual(worker.prompts, ['initial', 'continue']);
    const before = hub.snapshot();
    assert.deepEqual(
      await hub.agentSession('starter-close', {
        agentId: worker.id,
        action: 'close',
      }),
      {requiresWorkspaceCloseConfirmation: true},
    );
    assert.deepEqual(
      await hub.agentSession('starter-close', {
        agentId: worker.id,
        action: 'close',
        confirmWorkspaceClose: false,
      }),
      {requiresWorkspaceCloseConfirmation: true},
    );
    assert.deepEqual(hub.snapshot(), before);
    assert.equal(worker.disposals, 0);
    assert.deepEqual(
      await hub.agentSession('starter-close', {
        agentId: worker.id,
        action: 'close',
        confirmWorkspaceClose: true,
      }),
      {workspaceClosed: true},
    );
    assert.equal(entry.workspaceCloses, 1);
    assert.equal(worker.disposals, 1);
    assert.equal(hub.snapshot().sessions.length, 0);
  },
);

void test(
  'auto-cleanup after starter closure confirms workspace close for any existing agent',
  {timeout: 10000},
  async t => {
    for (const kind of ['owned', 'attached'] as const) {
      for (const selected of ['parent', 'primary', 'subagent'] as const) {
        await t.test(`${kind}: ${selected}`, async t => {
          const id = `auto-cleanup-${kind}-${selected}`;
          const source = owner(id);
          const hub = new DashboardHub(undefined, async () => source.parent);
          let unsubscribe = () => {};
          if (kind === 'owned') hub.adoptSession(source.parent);
          else {
            hub.updateExternal(source.parent.state.snapshot());
            unsubscribe = source.parent.state.subscribe(() =>
              hub.updateExternal(source.parent.state.snapshot()),
            );
            hub.setExternalControl({
              prompt: async () => {},
              abort: async () => ({steering: [], followUp: []}),
              cancelAgent: async () => {},
              features: async () => features(),
              configure: async () => {},
              compact: async () => {},
              reload: async () => {},
              agentSession: async (_id, request) =>
                source.parent.agentSession!(request),
            });
          }
          const finishPrimary = Promise.withResolvers<void>();
          t.after(async () => {
            finishPrimary.resolve();
            unsubscribe();
            await hub.close();
            if (kind === 'attached') await source.parent.close();
          });
          const primaryStarted = Promise.withResolvers<void>();
          const subagentStarted = Promise.withResolvers<AbortSignal>();
          let primaryDisposals = 0;
          let subagentDisposals = 0;
          const primary = source.manager.spawn(
            {
              name: 'Temporary primary',
              agentMode: 'all',
              autoCleanup: true,
              task: 'Finish after the starter closes',
              cwd: process.cwd(),
              model: 'fixture/model',
            },
            async () => ({
              async run(_prompt, signal) {
                signal.addEventListener(
                  'abort',
                  () => finishPrimary.resolve(),
                  {
                    once: true,
                  },
                );
                primaryStarted.resolve();
                await finishPrimary.promise;
                signal.throwIfAborted();
                return 'Finished after starter closure';
              },
              async steer() {
                return false;
              },
              dispose() {
                primaryDisposals++;
              },
            }),
          );
          const subagent = source.manager.spawn(
            {
              name: 'Live subagent',
              agentMode: 'subagent',
              task: 'Wait for workspace shutdown',
              cwd: process.cwd(),
              model: 'fixture/model',
            },
            async () => ({
              async run(_prompt, signal) {
                await new Promise<void>(resolve => {
                  signal.addEventListener('abort', () => resolve(), {
                    once: true,
                  });
                  subagentStarted.resolve(signal);
                });
                signal.throwIfAborted();
                return 'Stopped';
              },
              async steer() {
                return false;
              },
              dispose() {
                subagentDisposals++;
              },
            }),
          );
          await primaryStarted.promise;
          const subagentSignal = await subagentStarted.promise;
          assert.equal(source.manager.get(primary.id).status, 'running');
          assert.equal(
            await hub.agentSession(id, {agentId: 'parent', action: 'close'}),
            undefined,
          );
          assert.equal(source.starterCloses, 1);
          assert.equal(
            source.parent.state.snapshot().session.primaryClosed,
            true,
          );
          assert.equal(source.manager.get(primary.id).status, 'running');
          finishPrimary.resolve();
          await source.manager.wait([primary.id], {timeoutMs: 1000});
          assert.equal(source.manager.get(primary.id).status, 'completed');
          assert.equal(source.manager.get(primary.id).resumable, false);
          assert.equal(primaryDisposals, 1);
          const before = hub.snapshot();
          assert.equal(before.sessions[0].session.primaryClosed, true);
          assert.equal(before.sessions[0].session.controllable, true);
          assert.equal(before.sessions[0].session.status, 'idle');
          const subagentBefore = source.manager.get(subagent.id);
          const agentId =
            selected === 'parent'
              ? 'parent'
              : selected === 'primary'
                ? primary.id
                : subagent.id;
          await assert.rejects(
            hub.agentSession(id, {
              agentId: 'missing',
              action: 'close',
              confirmWorkspaceClose: true,
            }),
            /Unknown agent/,
          );
          for (const confirmWorkspaceClose of [undefined, false]) {
            assert.deepEqual(
              await hub.agentSession(id, {
                agentId,
                action: 'close',
                ...(confirmWorkspaceClose === undefined
                  ? {}
                  : {confirmWorkspaceClose}),
              }),
              {requiresWorkspaceCloseConfirmation: true},
            );
            assert.deepEqual(hub.snapshot(), before);
            assert.deepEqual(source.manager.get(subagent.id), subagentBefore);
            assert.equal(source.workspaceCloses, 0);
            assert.equal(source.starterCloses, 1);
            assert.equal(subagentDisposals, 0);
            assert.equal(subagentSignal.aborted, false);
          }
          assert.deepEqual(
            await hub.agentSession(id, {
              agentId,
              action: 'close',
              confirmWorkspaceClose: true,
            }),
            {workspaceClosed: true},
          );
          assert.equal(hub.snapshot().sessions.length, 0);
          assert.equal(source.starterCloses, 1);
          assert.equal(primaryDisposals, 1);
          assert.equal(source.workspaceCloses, Number(kind === 'owned'));
          assert.equal(subagentDisposals, Number(kind === 'owned'));
          assert.equal(subagentSignal.aborted, kind === 'owned');
          assert.equal(
            source.manager.get(subagent.id).status,
            kind === 'owned' ? 'cancelled' : 'running',
          );
        });
      }
    }
  },
);

void test(
  'subagents and explicitly closed primary workers do not keep the workspace open',
  {timeout: 10000},
  async t => {
    const entry = owner('last-starter');
    const primary = await primaryWorker(entry, 'primary');
    const subagent = await primaryWorker(entry, 'subagent');
    const hub = new DashboardHub(undefined, async () => entry.parent);
    hub.adoptSession(entry.parent);
    t.after(() => hub.close());
    await hub.agentSession('last-starter', {
      agentId: primary.id,
      action: 'close',
    });
    assert.equal(primary.disposals, 1);
    assert.equal(entry.manager.get(primary.id).resumable, false);
    const before = hub.snapshot();
    assert.deepEqual(
      await hub.agentSession('last-starter', {
        agentId: 'parent',
        action: 'close',
      }),
      {requiresWorkspaceCloseConfirmation: true},
    );
    assert.deepEqual(hub.snapshot(), before);
    assert.equal(entry.starterCloses, 0);
    assert.equal(subagent.disposals, 0);
    assert.deepEqual(
      await hub.agentSession('last-starter', {
        agentId: 'parent',
        action: 'close',
        confirmWorkspaceClose: true,
      }),
      {workspaceClosed: true},
    );
    assert.equal(entry.starterCloses, 0);
    assert.equal(entry.workspaceCloses, 1);
    assert.equal(subagent.disposals, 1);
  },
);

void test(
  'nonprimary closes dispose workers when the starter is already closed',
  {timeout: 10000},
  async t => {
    const entry = owner('subagent-close');
    const primary = await primaryWorker(entry);
    const subagent = await primaryWorker(entry, 'subagent');
    const hub = new DashboardHub(undefined, async () => entry.parent);
    hub.adoptSession(entry.parent);
    t.after(() => hub.close());
    await hub.agentSession('subagent-close', {
      agentId: 'parent',
      action: 'close',
    });
    assert.equal(
      await hub.agentSession('subagent-close', {
        agentId: subagent.id,
        action: 'close',
      }),
      undefined,
    );
    assert.equal(subagent.disposals, 1);
    assert.equal(primary.disposals, 0);
    assert.equal(entry.workspaceCloses, 0);
  },
);

void test(
  'concurrent final closes are serialized before counting remaining primary conversations',
  {timeout: 10000},
  async t => {
    for (const confirm of [false, true]) {
      const id = `concurrent-${confirm}`;
      const entry = owner(id);
      const primary = await primaryWorker(entry, 'primary');
      const hub = new DashboardHub(undefined, async () => entry.parent);
      hub.adoptSession(entry.parent);
      t.after(() => hub.close());
      const results = await Promise.all([
        hub.agentSession(id, {
          agentId: primary.id,
          action: 'close',
          confirmWorkspaceClose: confirm,
        }),
        hub.agentSession(id, {
          agentId: 'parent',
          action: 'close',
          confirmWorkspaceClose: confirm,
        }),
      ]);
      assert.deepEqual(results, [
        undefined,
        confirm
          ? {workspaceClosed: true}
          : {requiresWorkspaceCloseConfirmation: true},
      ]);
      assert.equal(primary.disposals, 1);
      assert.equal(entry.starterCloses, 0);
      assert.equal(entry.workspaceCloses, Number(confirm));
    }
  },
);

void test(
  'attached final closes use confirmed workspace dismissal despite delayed terminal snapshots',
  {timeout: 10000},
  async t => {
    const source = owner('attached-close');
    const primary = await primaryWorker(source);
    const hub = new DashboardHub(undefined, async () => source.parent);
    t.after(async () => {
      await hub.close();
      await source.parent.close();
    });
    const stale = source.parent.state.snapshot();
    hub.updateExternal(stale);
    hub.setExternalControl({
      prompt: async () => {},
      abort: async () => ({steering: [], followUp: []}),
      cancelAgent: async () => {},
      features: async () => features(),
      configure: async () => {},
      compact: async () => {},
      reload: async () => {},
      agentSession: async (_id, request) =>
        source.parent.agentSession!(request),
    });
    const results = await Promise.all([
      hub.agentSession('attached-close', {agentId: 'parent', action: 'close'}),
      hub.agentSession('attached-close', {
        agentId: primary.id,
        action: 'close',
      }),
    ]);
    assert.deepEqual(results, [
      undefined,
      {requiresWorkspaceCloseConfirmation: true},
    ]);
    hub.updateExternal(stale);
    assert.equal(hub.snapshot().sessions[0].session.primaryClosed, true);
    assert.equal(primary.disposals, 0);
    assert.deepEqual(
      await hub.agentSession('attached-close', {
        agentId: primary.id,
        action: 'close',
        confirmWorkspaceClose: true,
      }),
      {workspaceClosed: true},
    );
    assert.equal(hub.snapshot().sessions.length, 0);
    assert.equal(source.workspaceCloses, 0);
  },
);

void test(
  'same hub recounts recovered starters and restored primaries when a saved workspace resumes',
  {timeout: 10000},
  async t => {
    const cwd = process.cwd();
    for (const restoreStarter of [true, false]) {
      const id = `same-hub-resume-${restoreStarter}`;
      const savedPath = join(cwd, `${id}.jsonl`);
      t.mock.method(SessionManager, 'list', async () => [
        {
          id,
          path: savedPath,
          firstMessage: 'Saved workspace',
          modified: new Date(),
          messageCount: 1,
        },
      ]);
      const original = owner(id);
      const child = await primaryWorker(original, 'primary');
      const resumed = owner(id);
      let target = 'parent';
      if (!restoreStarter) {
        const saved = original.manager.get(child.id);
        resumed.parent.state.updateSession({primaryClosed: true});
        resumed.manager.restore(
          [
            {
              ...saved,
              sessionFile: savedPath,
              resumable: true,
              conversation: [],
              conversationTruncated: false,
            },
          ],
          async () => ({
            async run(prompt) {
              return prompt;
            },
            async steer() {
              return false;
            },
            dispose() {},
          }),
        );
        target = child.id;
      }
      const hub = new DashboardHub(undefined, async request => {
        assert.deepEqual(request.resume, {id, path: savedPath});
        return resumed.parent;
      });
      hub.adoptSession(original.parent);
      t.after(() => hub.close());
      await hub.agentSession(id, {
        agentId: restoreStarter ? 'parent' : child.id,
        action: 'close',
      });
      await hub.closeSession(id);
      assert.deepEqual(await hub.createSession({cwd, sessionId: id}), {id});
      const before = hub.snapshot();
      assert.deepEqual(
        await hub.agentSession(id, {agentId: target, action: 'close'}),
        {requiresWorkspaceCloseConfirmation: true},
      );
      assert.deepEqual(hub.snapshot(), before);
      assert.equal(resumed.starterCloses, 0);
      assert.equal(resumed.workspaceCloses, 0);
      assert.deepEqual(
        await hub.agentSession(id, {
          agentId: target,
          action: 'close',
          confirmWorkspaceClose: true,
        }),
        {workspaceClosed: true},
      );
      assert.equal(resumed.workspaceCloses, 1);
    }
  },
);

void test(
  'pending attached closure markers do not affect an owned resume with the same workspace ID',
  {timeout: 10000},
  async t => {
    const id = 'attached-owned-resume';
    const cwd = process.cwd();
    const savedPath = join(cwd, `${id}.jsonl`);
    t.mock.method(SessionManager, 'list', async () => [
      {
        id,
        path: savedPath,
        firstMessage: 'Saved workspace',
        modified: new Date(),
        messageCount: 1,
      },
    ]);
    const terminal = owner(id);
    await primaryWorker(terminal);
    const resumed = owner(id);
    const hub = new DashboardHub(undefined, async () => resumed.parent);
    t.after(async () => {
      await hub.close();
      await terminal.parent.close();
    });
    hub.updateExternal(terminal.parent.state.snapshot());
    hub.setExternalControl({
      prompt: async () => {},
      abort: async () => ({steering: [], followUp: []}),
      cancelAgent: async () => {},
      features: async () => features(),
      configure: async () => {},
      compact: async () => {},
      reload: async () => {},
      agentSession: async (_id, request) =>
        terminal.parent.agentSession!(request),
    });
    await hub.agentSession(id, {agentId: 'parent', action: 'close'});
    await hub.closeSession(id);
    await hub.createSession({cwd, sessionId: id});
    assert.equal(hub.snapshot().sessions[0].session.primaryClosed, undefined);
    assert.deepEqual(
      await hub.agentSession(id, {agentId: 'parent', action: 'close'}),
      {requiresWorkspaceCloseConfirmation: true},
    );
    assert.equal(resumed.starterCloses, 0);
    assert.equal(resumed.workspaceCloses, 0);
  },
);

void test(
  'any remaining agent confirms and dismisses ownerless workspaces without dispatching',
  {timeout: 10000},
  async t => {
    for (const kind of ['observed', 'disconnected', 'closed'] as const) {
      for (const selected of ['parent', 'primary', 'subagent'] as const) {
        const id = `uncontrolled-${kind}-${selected}`;
        const source = owner(id);
        const primary = await primaryWorker(source, 'primary');
        const subagent = await primaryWorker(source, 'subagent');
        const agentId =
          selected === 'parent'
            ? 'parent'
            : selected === 'primary'
              ? primary.id
              : subagent.id;
        if (selected !== 'parent')
          source.parent.state.updateSession({primaryClosed: true});
        const hub = new DashboardHub(
          kind === 'observed' ? source.parent.state : undefined,
          async () => {
            assert.fail('Dismissal must not create a parent');
          },
        );
        t.after(async () => {
          await hub.close();
          await source.parent.close();
        });
        if (kind !== 'observed') {
          hub.updateExternal(source.parent.state.snapshot());
          if (kind === 'closed') {
            hub.setExternalControl({
              prompt: async () => {
                assert.fail('Dead terminal prompt');
              },
              abort: async () => {
                assert.fail('Dead terminal abort');
              },
              cancelAgent: async () => {
                assert.fail('Dead terminal cancellation');
              },
              features: async () => features(),
              configure: async () => {},
              compact: async () => {},
              reload: async () => {},
              agentSession: async () => {
                assert.fail('Dead terminal agent dispatch');
              },
            });
            source.parent.state.updateSession({status: 'closed'});
            hub.updateExternal(source.parent.state.snapshot());
          }
        }
        const before = hub.snapshot();
        assert.deepEqual(
          await hub.agentSession(id, {agentId, action: 'close'}),
          {requiresWorkspaceCloseConfirmation: true},
        );
        assert.deepEqual(
          await hub.agentSession(id, {
            agentId,
            action: 'close',
            confirmWorkspaceClose: false,
          }),
          {requiresWorkspaceCloseConfirmation: true},
        );
        assert.deepEqual(hub.snapshot(), before);
        assert.equal(source.starterCloses, 0);
        assert.deepEqual(
          await hub.agentSession(id, {
            agentId,
            action: 'close',
            confirmWorkspaceClose: true,
          }),
          {workspaceClosed: true},
        );
        assert.equal(hub.snapshot().sessions.length, 0);
        assert.equal(source.workspaceCloses, 0);
        assert.equal(primary.disposals, 0);
        assert.equal(subagent.disposals, 0);
      }
    }
  },
);
