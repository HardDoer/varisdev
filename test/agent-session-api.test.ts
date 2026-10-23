import assert from 'node:assert/strict';
import type {ChildProcess} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
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
    agentSession: request => runAgentSessionRequest(manager, request),
    close: () => manager.close(),
  };
  return {manager, parent};
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
