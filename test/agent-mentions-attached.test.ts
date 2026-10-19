import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  createDefaultAgentProfile,
  saveAgentTemplate,
} from '../src/agents/templates.ts';
import {registerFactory} from '../src/dashboard/index.ts';
import {DesktopExtensionUI} from '../src/dashboard/extension-ui.ts';
import type {DashboardState} from '../src/dashboard/state.ts';
import type {FactoryControl} from '../src/desktop/launcher.ts';
import {
  registerAgentTools,
  type AgentToolsOptions,
} from '../src/tools/agents.ts';
import {saveToolSettings} from '../src/tools/settings.ts';

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await delay(5);
  assert.ok(check(), 'Expected attached mention state');
}

void test(
  'attached desktop mentions share native launch policy without a parent model and cancel pending approval',
  {timeout: 15000},
  async t => {
    const root = await mkdtemp(join(tmpdir(), 'varisdev-attached-mentions-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'settings');
    const previous = process.env.PI_CODING_AGENT_DIR;
    const credentials = Object.entries(process.env).filter(([key]) =>
      /API_KEY|TOKEN|ACCESS_KEY|^AWS_|^GOOGLE_CLOUD_|^GCLOUD_PROJECT$|^GOOGLE_APPLICATION_CREDENTIALS$/.test(
        key,
      ),
    );
    for (const [key] of credentials) delete process.env[key];
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const requests: Array<{model: string; messages: unknown}> = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.end(
        `data: ${JSON.stringify({id: 'attached-response', object: 'chat.completion.chunk', created: 1, model: 'pinned-child', choices: [{index: 0, delta: {role: 'assistant', content: 'Attached child result.'}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`,
      );
    });
    const ui = new DesktopExtensionUI(() => {});
    let session:
      Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
    t.after(async () => {
      await session?.abort();
      await session?.extensionRunner.emit({
        type: 'session_shutdown',
        reason: 'quit',
      });
      session?.dispose();
      session = undefined;
      ui.dispose();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      for (const [key, value] of credentials) process.env[key] = value;
      await rm(root, {recursive: true, force: true});
    });
    await mkdir(cwd, {recursive: true});
    await mkdir(agentDir, {recursive: true});
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({retry: {enabled: false}}),
    );
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    await saveToolSettings('agents', {allowedModels: []});
    for (const id of ['review', 'blocked'])
      await saveAgentTemplate(cwd, {
        scope: 'global',
        id,
        name: id,
        mode: 'subagent',
        model: 'attached-mention/pinned-child',
        instructions: 'ATTACHED CHILD INSTRUCTIONS',
      });
    const profile = {
      ...createDefaultAgentProfile(),
      id: 'attached-root',
      name: 'Attached root',
      permissions: [
        {action: 'subagent', resource: 'review', effect: 'ask' as const},
        {action: 'subagent', resource: 'blocked', effect: 'deny' as const},
      ],
    };
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const settingsManager = SettingsManager.create(cwd, agentDir);
    let control: FactoryControl | undefined;
    let state: DashboardState | undefined;
    const shared: AgentToolsOptions = {};
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      extensionFactories: [
        pi => {
          registerFactory(
            pi,
            registerAgentTools(pi, undefined, shared),
            {
              isOpen: () => false,
              async launch(currentState, currentControl) {
                state = currentState;
                control = currentControl;
                return {
                  show() {},
                  attach() {},
                  detach() {},
                  close() {},
                  connected: true,
                };
              },
              detach() {},
            },
            shared,
          );
          // Register after initial model selection to exercise a missing parent model.
          pi.on('session_start', () => {
            pi.registerProvider('attached-mention', {
              api: 'openai-completions',
              apiKey: 'fixture-key',
              baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
              models: [
                {
                  id: 'pinned-child',
                  name: 'Pinned child',
                  reasoning: false,
                  input: ['text'],
                  contextWindow: 128000,
                  maxTokens: 1000,
                  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
                },
              ],
            });
          });
        },
      ],
    });
    await loader.reload();
    const sessionManager = SessionManager.create(cwd);
    sessionManager.appendCustomEntry('varisdev.agent-profile', profile);
    ({session} = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      settingsManager,
      resourceLoader: loader,
      sessionManager,
    }));
    await session.bindExtensions({mode: 'rpc', uiContext: ui.context});
    await session.prompt('/factory');
    assert.ok(control);
    assert.ok(state);
    const rootModel = (await control.features()).model;
    assert.ok(!rootModel || rootModel.provider === 'unknown');

    await control.prompt('@blocked Denied task');
    assert.match(
      ui.snapshot().notifications.at(-1)!.message,
      /permission denied/,
    );
    assert.equal(state.snapshot().agents.length, 0);
    assert.equal(requests.length, 0);
    await assert.rejects(
      async () => control!.prompt(`@review ${'x'.repeat(64001)}`),
      /64000/,
    );

    const approved = control.prompt('@review Inspect attached changes');
    await until(() => ui.snapshot().dialogs.length > 0);
    assert.equal(requests.length, 0);
    const approval = ui.snapshot().dialogs[0];
    assert.equal(approval.title, 'Permission: attached-root');
    ui.respond(approval.id, 'Allow once');
    await approved;
    await until(() => state!.snapshot().agents[0]?.status === 'completed');
    const child = state.snapshot().agents[0];
    assert.equal(child.pinnedModel, 'attached-mention/pinned-child');
    assert.equal(child.task, 'Inspect attached changes');
    assert.match(child.output!, /Attached child result/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, 'pinned-child');
    assert.match(
      JSON.stringify(requests[0].messages),
      /ATTACHED CHILD INSTRUCTIONS/,
    );
    assert.deepEqual((await control.features()).model, rootModel);

    // Generated extension input keeps its source and must never launch a child.
    await assert.rejects(
      session.sendUserMessage('@review Generated extension task'),
      /no model|model.*selected|no API key/i,
    );
    assert.equal(ui.snapshot().dialogs.length, 0);
    assert.equal(state.snapshot().agents.length, 1);

    const cancelled = control.prompt('@review Cancel this approval');
    await until(() => ui.snapshot().dialogs.length > 0);
    await control.abort();
    await cancelled;
    assert.equal(ui.snapshot().dialogs.length, 0);
    assert.equal(state.snapshot().agents.length, 1);
    assert.equal(requests.length, 1);

    const retry = control.prompt('@review After cancellation');
    await until(() => ui.snapshot().dialogs.length > 0);
    ui.respond(ui.snapshot().dialogs[0].id, 'Allow once');
    await retry;
    await until(
      () =>
        state!.snapshot().agents.length === 2 &&
        state!.snapshot().agents.every(agent => agent.status === 'completed'),
    );
    assert.equal(requests.length, 2);
  },
);
