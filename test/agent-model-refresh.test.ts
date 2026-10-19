import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import type {AgentWorker} from '../src/agents/orchestrator.ts';
import {registerAgentTools} from '../src/tools/agents.ts';
import {saveToolSettings} from '../src/tools/settings.ts';
import {saveAgentTemplate} from '../src/agents/templates.ts';

interface ProviderTool {
  function: {
    name: string;
    description?: string;
    parameters?: {
      properties?: {
        model?: {enum?: unknown; description?: unknown};
      };
    };
  };
}

interface ProviderRequest {
  messages: Array<{role: string; content: unknown}>;
  tools: ProviderTool[];
}

function reply(
  response: ServerResponse,
  output: string | {name: string; arguments: Record<string, unknown>},
): void {
  const tool = typeof output !== 'string';
  const delta = tool
    ? {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `call_${randomUUID()}`,
            type: 'function',
            function: {
              name: output.name,
              arguments: JSON.stringify(output.arguments),
            },
          },
        ],
      }
    : {role: 'assistant', content: output};
  response.writeHead(200, {'content-type': 'text/event-stream'});
  response.end(
    `data: ${JSON.stringify({
      id: 'completion',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'gpt-5.6-sol',
      choices: [{index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop'}],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 5,
        total_tokens: 25,
      },
    })}\n\ndata: [DONE]\n\n`,
  );
}

function spawnDeclaration(request: ProviderRequest): ProviderTool['function'] {
  const declaration = request.tools.find(
    tool => tool.function.name === 'agent_spawn',
  )?.function;
  assert.ok(declaration, 'provider request must declare agent_spawn');
  return declaration;
}

void test(
  'real SDK refreshes inherited model choices and accepts overrides for pinned configurations',
  {timeout: 15000},
  async t => {
    const root = await mkdtemp(join(tmpdir(), 'varisdev-agent-refresh-'));
    const agentDir = join(root, 'config');
    const cwd = join(root, 'project');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const providerId = 'agent-refresh-test';
    const initialModel = `${providerId}/gpt-5.6-sol`;
    const updatedModel = `${providerId}/gpt-6.1-sol`;
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    const requests: ProviderRequest[] = [];
    const serverErrors: unknown[] = [];
    const firstRequest = Promise.withResolvers<void>();
    const releaseFirstResponse = Promise.withResolvers<void>();
    const createdModels: string[] = [];
    const server = createServer(async (request, response) => {
      try {
        let body = '';
        for await (const chunk of request) body += chunk;
        const input = JSON.parse(body) as ProviderRequest;
        requests.push(input);
        const step = requests.length;
        if (step === 1) {
          const model = spawnDeclaration(input).parameters?.properties?.model;
          assert.match(String(model?.description), new RegExp(initialModel));
          assert.doesNotMatch(
            String(model?.description),
            new RegExp(updatedModel),
          );
          assert.equal(model?.enum, undefined);
          firstRequest.resolve();
          await releaseFirstResponse.promise;
          reply(response, {name: 'agent_list', arguments: {}});
        } else if (step === 2) {
          const model = spawnDeclaration(input).parameters?.properties?.model;
          assert.match(String(model?.description), new RegExp(updatedModel));
          assert.doesNotMatch(
            String(model?.description),
            new RegExp(initialModel),
          );
          assert.equal(model?.enum, undefined);
          reply(response, {
            name: 'agent_spawn',
            arguments: {
              name: 'Allowed worker',
              task: 'Complete in the stub worker.',
              model: updatedModel,
            },
          });
        } else if (step === 3) {
          assert.match(JSON.stringify(input.messages), /Allowed worker/);
          reply(response, {
            name: 'agent_spawn',
            arguments: {
              template: 'pinned',
              name: 'Pinned worker',
              task: 'Use the configured model.',
              model: `${providerId}/ignored-override`,
            },
          });
        } else if (step === 4) {
          assert.match(JSON.stringify(input.messages), /Pinned worker/);
          reply(response, {
            name: 'agent_spawn',
            arguments: {
              name: 'Denied inherited worker',
              task: 'This worker must not start.',
            },
          });
        } else if (step === 5) {
          const transcript = JSON.stringify(input.messages);
          assert.match(transcript, /Agent model .*gpt-5\.6-sol.*not allowed/);
          assert.match(transcript, /Allowed models: .*gpt-6\.1-sol/);
          reply(response, 'Policy refresh observed.');
        } else {
          throw new Error(`Unexpected provider request ${step}.`);
        }
      } catch (error) {
        serverErrors.push(error);
        response.writeHead(500);
        response.end('Fixture failed');
      }
    });
    const sessions: AgentSession[] = [];
    t.after(async () => {
      releaseFirstResponse.resolve();
      try {
        for (const session of sessions) session.dispose();
      } finally {
        registry.unregisterProvider(providerId);
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        if (previousAgentDir === undefined)
          delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(root, {recursive: true, force: true});
      }
    });

    await Promise.all([
      mkdir(agentDir, {recursive: true}),
      mkdir(cwd, {recursive: true}),
    ]);
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({retry: {enabled: false}}),
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    registry.registerProvider(providerId, {
      api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      apiKey: 'fixture-key',
      models: [
        {
          id: 'gpt-5.6-sol',
          name: 'GPT 5.6 Sol',
          reasoning: false,
          input: ['text'],
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          contextWindow: 64000,
          maxTokens: 1000,
        },
        {
          id: 'gpt-6.1-sol',
          name: 'GPT 6.1 Sol',
          reasoning: false,
          input: ['text'],
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          contextWindow: 64000,
          maxTokens: 1000,
        },
      ],
    });
    await saveToolSettings('agents', {allowedModels: [initialModel]});
    await saveAgentTemplate(cwd, {
      id: 'pinned',
      scope: 'workspace',
      mode: 'subagent',
      model: initialModel,
    });

    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      extensionFactories: [
        pi => {
          registerAgentTools(pi, async options => {
            createdModels.push(`${options.model.provider}/${options.model.id}`);
            const worker: AgentWorker = {
              sessionFile: join(root, 'stub-session.jsonl'),
              resultFile: join(root, 'stub-result.txt'),
              async run() {
                return 'Stub worker completed.';
              },
              async steer() {
                return true;
              },
              async dispose() {},
            };
            return worker;
          });
        },
      ],
    });
    await loader.reload();
    const {session} = await createAgentSession({
      cwd,
      agentDir,
      model: registry.find(providerId, 'gpt-5.6-sol')!,
      modelRuntime: runtime,
      thinkingLevel: 'off',
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
    });
    sessions.push(session);

    const running = session.prompt(
      'Exercise the live agent model policy once.',
    );
    await firstRequest.promise;
    await saveToolSettings('agents', {allowedModels: [updatedModel]});
    releaseFirstResponse.resolve();
    await running;

    assert.deepEqual(serverErrors, []);
    assert.equal(
      requests.length,
      5,
      'Only the natural tool continuations call the model',
    );
    const originalPrompts = requests[0].messages.filter(
      message => message.role === 'user',
    );
    assert.equal(originalPrompts.length, 1);
    for (const request of requests) {
      assert.deepEqual(
        request.messages.filter(message => message.role === 'user'),
        originalPrompts,
        'Refreshing harness tool definitions must not inject user prompts',
      );
    }
    assert.equal(
      session.messages.some(message => message.role === 'custom'),
      false,
      'Policy refresh must not inject custom chat messages',
    );
    assert.deepEqual(createdModels, [updatedModel, initialModel]);
    assert.equal(session.getLastAssistantText(), 'Policy refresh observed.');
  },
);
