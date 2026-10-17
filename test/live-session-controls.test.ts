import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createServer, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  createDashboardParent,
  type DesktopDashboardParent,
} from '../src/dashboard/parent.ts';
import {DashboardHub} from '../src/dashboard/hub.ts';
import {registerFactory} from '../src/dashboard/index.ts';
import {registerAgentTools} from '../src/tools/agents.ts';
import type {FactoryControl} from '../src/desktop/launcher.ts';
import {DesktopToolSettings} from '../src/desktop/tool-settings.ts';

async function until(condition: () => boolean) {
  const end = Date.now() + 5000;
  while (!condition()) {
    assert.ok(Date.now() < end, 'Expected live session state');
    await delay(5);
  }
}

function reply(response: ServerResponse, tool = false) {
  response.writeHead(200, {'content-type': 'text/event-stream'});
  response.end(
    `data: ${JSON.stringify({
      id: 'fixture',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fixture',
      choices: [
        {
          index: 0,
          delta: tool
            ? {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'read-fixture',
                    type: 'function',
                    function: {
                      name: 'read',
                      arguments: JSON.stringify({path: 'fixture.txt'}),
                    },
                  },
                ],
              }
            : {role: 'assistant', content: 'Finished'},
          finish_reason: tool ? 'tool_calls' : 'stop',
        },
      ],
    })}\n\ndata: [DONE]\n\n`,
  );
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'varisdev-live-controls-'));
  const agentDir = join(root, 'config');
  const cwd = join(root, 'project');
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await mkdir(cwd, {recursive: true});
  await mkdir(agentDir, {recursive: true});
  await writeFile(join(cwd, 'fixture.txt'), 'Live control fixture');
  const requests: Array<{
    model: string;
    reasoning_effort?: string;
    messages: Array<{role: string; content: unknown}>;
  }> = [];
  let held: ServerResponse | undefined;
  let disconnected = false;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    if (requests.length === 1) {
      held = response;
      response.once('close', () => {
        disconnected = true;
      });
    } else reply(response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = 'live-controls';
  const config = {
    api: 'openai-completions' as const,
    apiKey: 'fixture-key',
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    models: ['one', 'two'].map(id => ({
      id,
      name: id,
      reasoning: true,
      input: ['text' as const],
      contextWindow: 128000,
      maxTokens: 1000,
      compat: {supportsReasoningEffort: true},
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
    })),
  };
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({providers: {[provider]: config}}),
  );
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      defaultProvider: provider,
      defaultModel: 'one',
      defaultThinkingLevel: 'low',
      retry: {enabled: false},
      compaction: {keepRecentTokens: 1},
    }),
  );
  let cleanup: () => Promise<void> = async () => {};
  t.after(async () => {
    held?.destroy();
    try {
      await cleanup();
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, {recursive: true, force: true});
    }
  });
  return {
    root,
    agentDir,
    cwd,
    provider,
    config,
    requests,
    get held() {
      return held;
    },
    get disconnected() {
      return disconnected;
    },
    cleanup: (operation: typeof cleanup) => {
      cleanup = operation;
    },
  };
}

async function respond(
  parent: DesktopDashboardParent,
  value?: string | boolean,
) {
  await until(() => parent.ui.snapshot().dialogs.length > 0);
  parent.ui.respond(parent.ui.snapshot().dialogs[0].id, value);
}

for (const scenario of ['owned', 'tree', 'fork']) {
  void test(
    scenario === 'owned'
      ? 'owned model, thinking and report controls preserve active provider work'
      : `${scenario} browsing preserves provider work until committed navigation`,
    {timeout: 15000},
    async t => {
      const env = await fixture(t);
      const parent = await createDashboardParent({cwd: env.cwd});
      const hub = new DashboardHub(undefined, async () => parent);
      hub.adoptSession(parent);
      env.cleanup(() => hub.close());
      const id = parent.state.snapshot().session.id;
      await hub.promptSession(id, {prompt: 'Perform the read task'});
      await until(() => !!env.held);
      for (const command of ['/tree', '/fork']) {
        const browsing = parent.prompt(command);
        await respond(parent);
        await browsing;
        assert.equal(env.disconnected, false);
        assert.equal(env.requests.length, 1);
      }
      if (scenario !== 'owned') {
        const committing = parent.prompt('/' + scenario);
        await until(() => parent.ui.snapshot().dialogs.length > 0);
        const dialog = parent.ui.snapshot().dialogs[0];
        const option =
          scenario === 'tree'
            ? dialog.options!.find(value =>
                value.includes('thinking_level_change'),
              )
            : dialog.options![0];
        assert.ok(option);
        parent.ui.respond(dialog.id, option);
        await committing;
        await until(() => env.disconnected);
        assert.equal(env.requests.length, 1);
        assert.equal(parent.state.snapshot().session.status, 'idle');
        if (scenario === 'fork') assert.ok(parent.ui.snapshot().navigation);
        return;
      }
      await parent.prompt(`/model ${env.provider}/two`);
      await parent.prompt('/thinking high');
      await parent.prompt('/name Active controls');
      for (const command of ['/settings', '/scoped-models', '/session']) {
        const operation = parent.prompt(command);
        await respond(parent);
        await operation;
      }
      const sharing = parent.prompt('/share');
      await respond(parent, false);
      await sharing;
      const reporting = parent.prompt('/bug');
      await respond(parent, true);
      await until(() => parent.ui.snapshot().dialogs[0]?.kind === 'editor');
      parent.ui.respond(parent.ui.snapshot().dialogs[0].id);
      await reporting;
      const exporting = parent.prompt(
        `/export ${join(env.root, 'live.jsonl')}`,
      );
      await respond(parent, true);
      await exporting;
      assert.match(
        await readFile(join(env.root, 'live.jsonl'), 'utf8'),
        /Perform the read task/,
      );
      assert.equal(
        parent.state.snapshot().session.model,
        `${env.provider}/two`,
      );
      assert.equal(parent.state.snapshot().session.thinkingLevel, 'high');
      assert.equal(env.disconnected, false);
      assert.equal(env.requests.length, 1);
      assert.equal(
        JSON.parse(await readFile(join(env.agentDir, 'settings.json'), 'utf8'))
          .defaultModel,
        'one',
      );
      await hub.configureSession(id, {
        provider: env.provider,
        modelId: 'two',
        persist: true,
      });
      assert.equal(
        JSON.parse(await readFile(join(env.agentDir, 'settings.json'), 'utf8'))
          .defaultModel,
        'two',
      );
      await parent.prompt('/thinking high');
      reply(env.held!, true);
      await until(() => parent.state.snapshot().session.status === 'idle');
      assert.equal(env.requests.length, 2);
      assert.equal(env.requests[0].model, 'one');
      assert.equal(env.requests[1].model, 'two');
      assert.equal(env.requests[1].reasoning_effort, 'high');
      assert.equal(
        env.requests[1].messages.filter(message => message.role === 'user')
          .length,
        1,
      );
    },
  );
}

void test(
  'attached model, scope and thinking controls preserve active work and native commands never reach the model',
  {timeout: 15000},
  async t => {
    const env = await fixture(t);
    let control: FactoryControl | undefined;
    const runtime = await ModelRuntime.create({
      authPath: join(env.agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerProvider(env.provider, env.config);
    await runtime.refresh({allowNetwork: false});
    const settingsManager = SettingsManager.create(env.cwd, env.agentDir);
    const loader = new DefaultResourceLoader({
      cwd: env.cwd,
      agentDir: env.agentDir,
      settingsManager,
      noExtensions: true,
      extensionFactories: [
        pi =>
          registerFactory(pi, registerAgentTools(pi), {
            isOpen: () => false,
            async launch(_state, current) {
              control = current;
              return {
                show() {},
                attach() {},
                detach() {},
                close() {},
                connected: true,
              };
            },
            detach() {},
          }),
      ],
    });
    await loader.reload();
    const {session} = await createAgentSession({
      cwd: env.cwd,
      agentDir: env.agentDir,
      modelRuntime: runtime,
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.create(env.cwd),
      model: runtime.getModel(env.provider, 'one')!,
    });
    await session.bindExtensions({mode: 'rpc'});
    env.cleanup(async () => {
      await session.abort();
      await session.extensionRunner.emit({
        type: 'session_shutdown',
        reason: 'quit',
      });
      session.dispose();
    });
    await session.prompt('/factory');
    assert.ok(control);
    const toolSettings = new DesktopToolSettings({
      sessionFeatures: async () => control!.features(),
    });
    session.setScopedModels([
      {model: runtime.getModel(env.provider, 'one')!, thinkingLevel: 'high'},
    ]);
    const scoped = await control.features();
    assert.deepEqual(scoped.scopedModels, [
      {
        model: {provider: env.provider, id: 'one', name: 'one'},
        thinkingLevel: 'high',
      },
    ]);
    assert.deepEqual(
      (await toolSettings.getToolSettings('attached')).models,
      scoped.scopedModels!.map(scoped => scoped.model),
    );
    const run = session.prompt('Perform the read task');
    await until(() => !!env.held);
    session.setScopedModels([{model: runtime.getModel(env.provider, 'two')!}]);
    assert.deepEqual((await toolSettings.getToolSettings('attached')).models, [
      {provider: env.provider, id: 'two', name: 'two'},
    ]);
    session.setScopedModels([]);
    assert.deepEqual(
      (await toolSettings.getToolSettings('attached')).models,
      (await control.features()).models,
    );
    await control.prompt(`/model ${env.provider}/two`);
    await control.prompt('/thinking high');
    for (const command of ['/model', '/settings', '/share', '/bug', '/export'])
      await assert.rejects(
        Promise.resolve().then(() => control!.prompt(command)),
        /attached terminal/,
      );
    assert.equal(session.model?.id, 'two');
    assert.equal(session.thinkingLevel, 'high');
    assert.equal(session.getSteeringMessages().length, 0);
    assert.equal(env.disconnected, false);
    assert.equal(env.requests.length, 1);
    reply(env.held!, true);
    await run;
    assert.equal(env.requests.length, 2);
    assert.equal(env.requests[1].model, 'two');
    assert.equal(env.requests[1].reasoning_effort, 'high');
    assert.equal(
      env.requests[1].messages.filter(message => message.role === 'user')
        .length,
      1,
    );
  },
);

void test(
  'native controls and extension commands remain available during SDK manual compaction',
  {timeout: 15000},
  async t => {
    const env = await fixture(t);
    await mkdir(join(env.agentDir, 'extensions'), {recursive: true});
    await writeFile(
      join(env.agentDir, 'extensions', 'compaction.js'),
      `
    import {writeFileSync} from 'node:fs';
    export default pi => {
      pi.registerCommand('release-compaction', {handler() {pi.events.emit('fixture:release', {});}});
      pi.on('session_before_compact', async event => {
        writeFileSync(${JSON.stringify(join(env.root, 'compacting'))}, 'waiting');
        await new Promise(resolve => {
          const off = pi.events.on('fixture:release', () => {off(); resolve();});
          event.signal.addEventListener('abort', () => {off(); resolve();}, {once:true});
        });
        return {cancel:true};
      });
    }
  `,
    );
    const manager = SessionManager.create(env.cwd);
    manager.appendModelChange(env.provider, 'one');
    manager.appendMessage({
      role: 'user',
      content: 'Earlier context '.repeat(100),
      timestamp: 1,
    });
    manager.appendMessage({
      role: 'assistant',
      content: [{type: 'text', text: 'Earlier response'}],
      api: 'openai-completions',
      provider: env.provider,
      model: 'one',
      stopReason: 'stop',
      timestamp: 2,
      usage: {
        input: 1000,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1010,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
      },
    });
    manager.appendMessage({
      role: 'user',
      content: 'Keep this most recent request',
      timestamp: 3,
    });
    const parent = await createDashboardParent({
      cwd: env.cwd,
      resume: {id: manager.getSessionId(), path: manager.getSessionFile()!},
    });
    env.cleanup(() => parent.close());
    const compacting = parent.compact().catch(error => error as Error);
    await until(() => existsSync(join(env.root, 'compacting')));
    await parent.prompt(`/model ${env.provider}/two`);
    await parent.prompt('/thinking high');
    assert.equal(existsSync(join(env.root, 'compacting')), true);
    await assert.rejects(
      parent.prompt('Ordinary prompt during manual compaction'),
      /compaction/,
    );
    await parent.prompt('/release-compaction');
    const result = await compacting;
    assert.ok(result instanceof Error);
    assert.match(result.message, /cancelled/i);
    assert.equal(parent.state.snapshot().session.model, `${env.provider}/two`);
    assert.equal(parent.state.snapshot().session.thinkingLevel, 'high');
    assert.equal(env.requests.length, 0);
  },
);
