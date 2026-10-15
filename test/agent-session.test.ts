import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {
  createServer,
  type IncomingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionToolContext,
  type SessionShutdownEvent,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {createSessionWorker} from '../src/agents/session.ts';
import {WorkerConversation} from '../src/agents/conversation.ts';
import {
  AgentOrchestrator,
  type AgentRecord,
  type AgentWorker,
} from '../src/agents/orchestrator.ts';
import {DashboardState} from '../src/dashboard/state.ts';
import type {ModelUsage} from '../src/usage.ts';
import {registerAgentTools} from '../src/tools/agents.ts';

function toolContext(ctx: ExtensionContext): ExtensionToolContext {
  return Object.assign(ctx, {
    tools: [],
    async executeTool(): Promise<never> {
      throw new Error('Nested tool calls are not configured for this fixture.');
    },
  });
}

interface ProviderRequest {
  model: string;
  reasoning_effort?: string;
  messages: Array<{role: string; content: unknown}>;
  tools: Array<{function: {name: string}}>;
}

type ShutdownHandler = (
  event: SessionShutdownEvent | {type: 'agent_settled'},
) => Promise<void> | void;

function reply(
  response: ServerResponse,
  output: string | {name: string; arguments: Record<string, unknown>},
  contextTokens = 100,
) {
  const toolCall = typeof output !== 'string';
  const delta = toolCall
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
      model: 'worker-model',
      choices: [
        {index: 0, delta, finish_reason: toolCall ? 'tool_calls' : 'stop'},
      ],
      usage: {
        prompt_tokens: contextTokens,
        completion_tokens: 10,
        total_tokens: contextTokens + 10,
        prompt_tokens_details: {cached_tokens: 25, cache_write_tokens: 5},
      },
    })}\n\ndata: [DONE]\n\n`,
  );
}

function lastToolResult<T>(request: ProviderRequest): T {
  const content = request.messages.findLast(
    message => message.role === 'tool',
  )?.content;
  assert.ok(typeof content === 'string', 'Expected a tool result from the SDK');
  return JSON.parse(content) as T;
}

void test(
  'Pi workers load project tools, persist follow-up conversations, and compact through the SDK',
  {timeout: 15000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-worker-sdk-'));
    const agentDir = join(directory, 'config');
    const cwd = join(directory, 'project');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(modelRuntime);
    const requests: ProviderRequest[] = [];
    const requestHeaders: IncomingHttpHeaders[] = [];
    const server = createServer(async (request, response) => {
      try {
        let body = '';
        for await (const chunk of request) body += chunk;
        requests.push(JSON.parse(body));
        requestHeaders.push(request.headers);
        reply(
          response,
          requests.length === 1
            ? {name: 'read', arguments: {path: 'context.txt'}}
            : requests.length === 5
              ? 'Compacted fixture context.'
              : `Final answer ${requests.length}`,
          requests.length === 4 ? 120000 : undefined,
        );
      } catch (error) {
        response.writeHead(500);
        response.end(String(error));
      }
    });
    let worker: AgentWorker | undefined;
    t.after(async () => {
      worker?.dispose();
      worker = undefined;
      registry.unregisterProvider('varisdev-agent-test');
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, {recursive: true, force: true});
    });
    await mkdir(cwd, {recursive: true});
    await mkdir(agentDir, {recursive: true});
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({compaction: {keepRecentTokens: 32}}),
    );
    await writeFile(
      join(cwd, 'AGENTS.md'),
      'Project instruction marker: report every finding.',
    );
    await writeFile(
      join(cwd, 'context.txt'),
      'Fixture contents from the worker directory.',
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    registry.registerProvider('varisdev-agent-test', {
      api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      apiKey: 'local-test-key',
      headers: {'x-parent-provider': 'provider-config'},
      models: [
        {
          id: 'worker-model',
          name: 'Worker model',
          reasoning: true,
          input: ['text'],
          cost: {input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0.3},
          contextWindow: 128000,
          maxTokens: 1000,
          headers: {'x-parent-model': 'model-config'},
          compat: {supportsReasoningEffort: true},
        },
      ],
    });
    await modelRuntime.setRuntimeApiKey(
      'varisdev-agent-test',
      'parent-runtime-key',
    );
    worker = await createSessionWorker({
      id: 'worker-id',
      parentSessionId: 'parent-id',
      cwd,
      name: 'SDK worker',
      instructions: 'Worker instruction marker: inspect the fixture.',
      model: registry.find('varisdev-agent-test', 'worker-model')!,
      modelRegistry: registry,
      thinkingLevel: 'high',
      agentToolsExtension: () => {},
    });
    const activity: string[] = [];
    const usageUpdates: ModelUsage[] = [];
    assert.equal(
      await worker.run(
        'Read context.txt and report.',
        AbortSignal.timeout(5000),
        item => activity.push(item),
        usage => usageUpdates.push(usage),
      ),
      'Final answer 2',
    );
    assert.ok(activity.includes('Using read'));
    assert.equal(worker.usage?.calls.length, 2);
    assert.equal(worker.usage?.totalTokens, 220);
    assert.deepEqual(
      worker.usage?.calls.map(call => call.toolNames),
      [['read'], []],
    );
    assert.ok(Math.abs(worker.usage!.cost - 0.000373) < 1e-12);
    assert.ok(usageUpdates.some(usage => usage.calls.length === 1));
    usageUpdates.at(-1)!.calls[0].toolNames.push('mutated');
    assert.deepEqual(worker.usage?.calls[0].toolNames, ['read']);
    const toolNames = requests[0].tools.map(tool => tool.function.name);
    for (const name of [
      'read',
      'bash',
      'edit',
      'write',
      'browse',
      'download',
      'elevenlabs',
      'gamemaker_query',
      'image_query',
      'json_query',
      'openai_image',
    ]) {
      assert.ok(
        toolNames.includes(name),
        `${name} must be available to workers`,
      );
    }
    assert.equal(
      toolNames.some(name => name.startsWith('agent_')),
      false,
    );
    assert.match(
      JSON.stringify(requests[0].messages),
      /Project instruction marker/,
    );
    assert.match(
      JSON.stringify(requests[0].messages),
      /Worker instruction marker/,
    );
    assert.match(
      JSON.stringify(
        requests[1].messages.filter(message => message.role === 'tool'),
      ),
      /Fixture contents from the worker directory/,
    );
    await modelRuntime.setRuntimeApiKey(
      'varisdev-agent-test',
      'rotated-parent-key',
    );
    assert.equal(
      await worker.run(
        'Summarize your previous answer.',
        AbortSignal.timeout(5000),
        () => {},
      ),
      'Final answer 3',
    );
    assert.match(JSON.stringify(requests[2].messages), /Final answer 2/);
    assert.equal(worker.usage?.calls.length, 3);
    assert.equal(worker.usage?.totalTokens, 330);
    assert.deepEqual(
      requestHeaders.map(headers => headers.authorization),
      [
        'Bearer parent-runtime-key',
        'Bearer parent-runtime-key',
        'Bearer rotated-parent-key',
      ],
    );
    for (const headers of requestHeaders) {
      assert.equal(headers['x-parent-provider'], 'provider-config');
      assert.equal(headers['x-parent-model'], 'model-config');
    }
    for (const request of requests) {
      assert.equal(request.model, 'worker-model');
      assert.equal(request.reasoning_effort, 'high');
    }
    assert.equal(await readFile(worker.resultFile!, 'utf8'), 'Final answer 3');
    const transcript = await readFile(worker.sessionFile!, 'utf8');
    assert.match(transcript, /Fixture contents from the worker directory/);
    assert.match(transcript, /Summarize your previous answer/);

    assert.equal(
      await worker.run(
        'Continue with the next finding.',
        AbortSignal.timeout(5000),
        item => activity.push(item),
      ),
      'Final answer 4',
    );
    assert.ok(activity.includes('Compacting conversation'));
    const compacted = (await readFile(worker.sessionFile!, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    const compactions = compacted.filter(entry => entry.type === 'compaction');
    assert.equal(compactions.length, 1);
    assert.equal(
      worker.usage?.calls.length,
      5,
      'compaction aggregate is included alongside recorded responses',
    );
    assert.equal(worker.usage?.totalTokens, 120450);
    const summaryUsage = worker.usage!.calls.find(
      call => call.kind === 'compaction',
    )!;
    assert.equal(summaryUsage.id, `compaction-${compactions[0].id}`);
    assert.equal(summaryUsage.totalTokens, 110);
    assert.deepEqual(summaryUsage.toolNames, []);
    assert.ok(summaryUsage.cost > 0);
    assert.match(compactions[0].summary, /Compacted fixture context/);
    assert.equal(
      await worker.run(
        'Summarize the latest finding.',
        AbortSignal.timeout(5000),
        () => {},
      ),
      'Final answer 6',
    );
    assert.match(
      JSON.stringify(requests[5].messages),
      /Compacted fixture context/,
    );
    assert.match(JSON.stringify(requests[5].messages), /Final answer 4/);
    assert.equal(await readFile(worker.resultFile!, 'utf8'), 'Final answer 6');
    assert.equal(worker.usage?.calls.length, 6);
    assert.equal(worker.usage?.totalTokens, 120560);
    const restoredConversation = new WorkerConversation(
      SessionManager.open(worker.sessionFile!).getBranch(),
    ).snapshot();
    assert.deepEqual(
      restoredConversation.conversation.map(message => [
        message.id,
        message.role,
        message.text,
        message.input,
        message.status,
        message.at,
      ]),
      worker.conversation!.conversation.map(message => [
        message.id,
        message.role,
        message.text,
        message.input,
        message.status,
        message.at,
      ]),
      'Serialized SDK history restores the same public message identities and tool inputs',
    );
  },
);

void test(
  'SDK workers use native parent providers and refresh OAuth in the parent credential store',
  {timeout: 15000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-worker-oauth-'));
    const cwd = join(directory, 'project');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(directory, 'config');
    const providerId = 'varisdev-oauth-test';
    const authPath = join(directory, 'parent-auth.json');
    await writeFile(
      authPath,
      JSON.stringify({
        [providerId]: {
          type: 'oauth',
          access: 'expired',
          refresh: 'refresh-token',
          expires: 1,
        },
      }),
    );
    const modelRuntime = await ModelRuntime.create({
      authPath,
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(modelRuntime);
    const requestHeaders: IncomingHttpHeaders[] = [];
    const server = createServer((request, response) => {
      request.resume();
      requestHeaders.push(request.headers);
      reply(response, 'OAuth worker result.');
    });
    let worker: AgentWorker | undefined;
    t.after(async () => {
      worker?.dispose();
      worker = undefined;
      registry.unregisterProvider(providerId);
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, {recursive: true, force: true});
    });
    await mkdir(cwd, {recursive: true});
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    registry.registerProvider(providerId, {
      api: 'openai-completions',
      // The OAuth result supplies the actual endpoint for the native provider.
      baseUrl: 'http://127.0.0.1:1/v1',
      models: [
        {
          id: 'worker-model',
          name: 'Worker model',
          reasoning: false,
          input: ['text'],
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          contextWindow: 128000,
          maxTokens: 1000,
        },
      ],
    });
    const transport = registry.getProvider(providerId)!;
    let refreshes = 0;
    let streams = 0;
    registry.registerProvider({
      ...transport,
      auth: {
        oauth: {
          name: 'Local OAuth',
          isSubscription: true,
          async login() {
            throw new Error('Unexpected login');
          },
          async refresh(credential) {
            refreshes++;
            assert.equal(credential.refresh, 'refresh-token');
            return {
              ...credential,
              access: 'refreshed-parent-token',
              expires: Date.now() + 3600000,
            };
          },
          async toAuth(credential) {
            return {
              apiKey: credential.access,
              headers: {'x-parent-oauth': 'forwarded'},
              baseUrl,
            };
          },
        },
      },
      streamSimple(model, context, options) {
        streams++;
        assert.equal(model.baseUrl, baseUrl);
        return transport.streamSimple(model, context, options);
      },
    });
    await registry.refresh({allowNetwork: false, providers: [providerId]});
    worker = await createSessionWorker({
      id: 'oauth-worker',
      parentSessionId: 'oauth-parent',
      cwd,
      name: 'OAuth worker',
      model: registry.find(providerId, 'worker-model')!,
      modelRegistry: registry,
      thinkingLevel: 'off',
      agentToolsExtension: () => {},
    });
    assert.equal(
      await worker.run('Respond.', AbortSignal.timeout(5000), () => {}),
      'OAuth worker result.',
    );
    assert.equal(
      await worker.run('Follow up.', AbortSignal.timeout(5000), () => {}),
      'OAuth worker result.',
    );
    assert.equal(refreshes, 1);
    assert.equal(streams, 2);
    assert.equal(requestHeaders.length, 2);
    for (const headers of requestHeaders) {
      assert.equal(headers.authorization, 'Bearer refreshed-parent-token');
      assert.equal(headers['x-parent-oauth'], 'forwarded');
    }
    const stored = JSON.parse(await readFile(authPath, 'utf8'));
    assert.equal(stored[providerId].access, 'refreshed-parent-token');
  },
);

void test(
  'SDK workers discover peers, steer active tool loops, resume conversations, and store parent inbox messages silently',
  {timeout: 20000},
  async t => {
    const directory = await mkdtemp(
      join(tmpdir(), 'varisdev-worker-messaging-'),
    );
    const agentDir = join(directory, 'config');
    const cwd = join(directory, 'project');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const registry = new ModelRegistry(
      await ModelRuntime.create({
        authPath: join(agentDir, 'auth.json'),
        modelsPath: null,
        refreshOnCreate: false,
      }),
    );
    const tools = new Map<string, ToolDefinition>();
    const events = new Map<string, ShutdownHandler>();
    const parentMessages: Array<Parameters<ExtensionAPI['sendMessage']>> = [];
    let parentInboxMessageId = '';
    const pi = {
      registerTool(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
      registerCommand() {},
      on(event: string, handler: ShutdownHandler) {
        events.set(event, handler);
      },
      getThinkingLevel: () => 'off',
      sendMessage(...args: Parameters<ExtensionAPI['sendMessage']>) {
        parentMessages.push(args);
      },
    } as unknown as ExtensionAPI;
    // Use the production worker factory and its injected agent tools.
    registerAgentTools(pi);

    const spawned = Promise.withResolvers<void>();
    const peerQueued = Promise.withResolvers<void>();
    const requests: Record<'Receiver' | 'Sender', ProviderRequest[]> = {
      Receiver: [],
      Sender: [],
    };
    const providerErrors: unknown[] = [];
    const queuedMessage = 'Peer finding queued during the initial task.';
    const resumedMessage = 'Peer finding sent after completion.';
    const parentMessage = 'Received the queued peer finding.';
    interface Discovery {
      view: string;
      selfId: string;
      summary: Record<string, number>;
      agents: Array<Pick<AgentRecord, 'id' | 'name' | 'status'>>;
    }
    function discover(request: ProviderRequest, self: AgentRecord) {
      const result = lastToolResult<Discovery>(request);
      assert.equal(result.view, 'all');
      assert.equal(result.selfId, self.id);
      assert.equal(
        Object.values(result.summary).reduce((sum, count) => sum + count, 0),
        2,
      );
      assert.deepEqual(
        result.agents.map(agent => [agent.name, agent.id]).sort(),
        [
          [receiver.name, receiver.id],
          [sender.name, sender.id],
        ].sort(),
      );
      const peer = result.agents.find(agent => agent.id !== result.selfId);
      assert.ok(peer, 'The worker must discover its peer from agent_list');
      return peer;
    }
    function assertSender(content: unknown, message: string) {
      const text =
        typeof content === 'string' ? content : JSON.stringify(content);
      assert.ok(
        text.includes(message),
        `Expected delivered message: ${message}`,
      );
      const prefix = text.slice(0, text.indexOf(message));
      assert.match(prefix, new RegExp(sender.name));
      assert.match(prefix, new RegExp(sender.id));
    }
    const server = createServer(async (request, response) => {
      try {
        let body = '';
        for await (const chunk of request) body += chunk;
        const input = JSON.parse(body) as ProviderRequest;
        const firstUser = JSON.stringify(
          input.messages.find(message => message.role === 'user')?.content,
        );
        assert.match(firstUser, /Receiver initial task|Sender initial task/);
        const name = firstUser.includes('Receiver initial task')
          ? 'Receiver'
          : 'Sender';
        requests[name].push(input);
        await spawned.promise;
        const step = requests[name].length;
        if (step === 1) {
          assert.deepEqual(
            input.tools
              .map(tool => tool.function.name)
              .filter(tool => tool.startsWith('agent_'))
              .sort(),
            ['agent_list', 'agent_send'],
          );
          assert.ok(input.tools.some(tool => tool.function.name === 'read'));
          const prompt = JSON.stringify(
            input.messages.filter(message =>
              ['system', 'developer'].includes(message.role),
            ),
          );
          assert.match(prompt, new RegExp(name));
          assert.match(
            prompt,
            new RegExp(name === 'Receiver' ? receiver.id : sender.id),
          );
          assert.match(prompt, /agent_list/);
          assert.match(prompt, /agent_send/);
          assert.match(prompt, /parent/);
          reply(response, {name: 'agent_list', arguments: {view: 'all'}});
        } else if (name === 'Receiver' && step === 2) {
          assert.equal(discover(input, receiver).id, sender.id);
          // Hold an unfinished tool loop until the peer sends steering.
          await peerQueued.promise;
          reply(response, {name: 'agent_list', arguments: {view: 'all'}});
        } else if (name === 'Sender' && step === 2) {
          const peer = discover(input, sender);
          reply(response, {
            name: 'agent_send',
            arguments: {id: peer.id, message: queuedMessage},
          });
        } else if (name === 'Sender' && step === 3) {
          const result = lastToolResult<{agents: AgentRecord[]}>(input);
          assert.equal(result.agents[0].id, receiver.id);
          assert.equal(result.agents[0].status, 'running');
          peerQueued.resolve();
          reply(response, 'Sender queued the peer finding.');
        } else if (name === 'Receiver' && step === 3) {
          assertSender(
            input.messages.findLast(message => message.role === 'user')
              ?.content,
            queuedMessage,
          );
          assert.match(JSON.stringify(input.messages), /Receiver initial task/);
          reply(response, {
            name: 'agent_send',
            arguments: {id: 'parent', message: parentMessage},
          });
        } else if (name === 'Receiver' && step === 4) {
          const result = lastToolResult<{
            recipient: 'parent';
            stored: true;
            messageId: string;
          }>(input);
          assert.equal(result.recipient, 'parent');
          assert.equal(result.stored, true);
          assert.ok(result.messageId);
          parentInboxMessageId = result.messageId;
          reply(response, 'Receiver handled the queued finding.');
        } else if (name === 'Sender' && step === 4) {
          assert.match(
            JSON.stringify(
              input.messages.findLast(message => message.role === 'user'),
            ),
            /Send a second peer finding/,
          );
          reply(response, {name: 'agent_list', arguments: {view: 'all'}});
        } else if (name === 'Sender' && step === 5) {
          const peer = discover(input, sender);
          assert.equal(peer.status, 'completed');
          reply(response, {
            name: 'agent_send',
            arguments: {id: peer.id, message: resumedMessage},
          });
        } else if (name === 'Sender' && step === 6) {
          const result = lastToolResult<{agents: AgentRecord[]}>(input);
          assert.equal(result.agents[0].id, receiver.id);
          assert.ok(['queued', 'running'].includes(result.agents[0].status));
          reply(response, 'Sender sent the second finding.');
        } else if (name === 'Receiver' && step === 5) {
          assertSender(
            input.messages.findLast(message => message.role === 'user')
              ?.content,
            resumedMessage,
          );
          assert.match(JSON.stringify(input.messages), /Receiver initial task/);
          assert.match(
            JSON.stringify(input.messages),
            /Receiver handled the queued finding/,
          );
          reply(response, 'Receiver handled the second finding.');
        } else {
          assert.fail(`Unexpected provider request ${name} ${step}`);
        }
      } catch (error) {
        providerErrors.push(error);
        // Finish the local response and release gates so failures reach assertions promptly.
        peerQueued.resolve();
        reply(response, `Provider fixture failed: ${String(error)}`);
      }
    });
    t.after(async () => {
      spawned.resolve();
      peerQueued.resolve();
      await events.get('session_shutdown')?.({
        type: 'session_shutdown',
        reason: 'quit',
      });
      registry.unregisterProvider('openai-codex');
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, {recursive: true, force: true});
    });
    await mkdir(cwd, {recursive: true});
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    registry.registerProvider('openai-codex', {
      api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      apiKey: 'local-test-key',
      models: [
        {
          id: 'gpt-5.6-sol',
          name: 'Codex GPT-5.6 Sol',
          reasoning: false,
          input: ['text'],
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          contextWindow: 128000,
          maxTokens: 1000,
        },
      ],
    });
    const ctx = {
      cwd,
      hasUI: false,
      model: registry.find('openai-codex', 'gpt-5.6-sol')!,
      modelRegistry: registry,
      isIdle: () => true,
      sessionManager: {getSessionId: () => 'messaging-parent'},
    } as unknown as ExtensionContext;
    const executeCtx = toolContext(ctx);
    const execute = (name: string, params: Record<string, unknown>) =>
      tools
        .get(name)!
        .execute('parent-call', params, undefined, undefined, executeCtx);
    const spawn = async (name: string) => {
      const result = await execute('agent_spawn', {
        name,
        task: `${name} initial task.`,
        timeoutMs: 10000,
      });
      return (result.details as {agents: AgentRecord[]}).agents[0];
    };
    const receiver = await spawn('Receiver');
    const sender = await spawn('Sender');
    spawned.resolve();
    const wait = async () => {
      const result = await execute('agent_wait', {
        ids: [receiver.id, sender.id],
        timeoutMs: 10000,
      });
      assert.deepEqual(providerErrors, []);
      const agents = (result.details as {agents: AgentRecord[]}).agents;
      assert.deepEqual(
        agents.map(agent => agent.status),
        ['completed', 'completed'],
      );
      return agents;
    };
    const initial = await wait();
    assert.deepEqual(
      initial.map(agent => agent.output),
      [
        'Receiver handled the queued finding.',
        'Sender queued the peer finding.',
      ],
    );
    assert.deepEqual(parentMessages, [], 'Worker messages must not reach Pi');
    const inbox = (await execute('agent_inbox', {offset: 0, limit: 10}))
      .details as {
      total: number;
      offset: number;
      nextOffset?: number;
      messages: Array<{
        id: string;
        from: {id: string; name: string};
        createdAt: string;
        length: number;
        preview: string;
      }>;
    };
    assert.equal(inbox.total, 1);
    assert.equal(inbox.offset, 0);
    assert.equal(inbox.nextOffset, undefined);
    assert.equal(inbox.messages.length, 1);
    assert.equal(inbox.messages[0].id, parentInboxMessageId);
    assert.deepEqual(inbox.messages[0].from, {
      id: receiver.id,
      name: receiver.name,
    });
    assert.ok(Date.parse(inbox.messages[0].createdAt));
    assert.equal(inbox.messages[0].length, parentMessage.length);
    assert.equal(inbox.messages[0].preview, parentMessage);
    const fullInboxMessage = (
      await execute('agent_inbox', {messageId: parentInboxMessageId})
    ).details as {
      message: {
        id: string;
        from: {id: string; name: string};
        createdAt: string;
        message: string;
      };
    };
    assert.deepEqual(fullInboxMessage.message, {
      id: parentInboxMessageId,
      from: {id: receiver.id, name: receiver.name},
      createdAt: inbox.messages[0].createdAt,
      message: parentMessage,
    });

    await execute('agent_send', {
      id: sender.id,
      message: 'Send a second peer finding.',
    });
    const resumed = await wait();
    await events.get('agent_settled')?.({type: 'agent_settled'});
    assert.deepEqual(
      parentMessages,
      [],
      'Worker activity and completion must keep the parent session silent',
    );
    assert.deepEqual(
      (await execute('agent_inbox', {})).details,
      inbox,
      'Inbox reads must not consume stored messages',
    );
    assert.deepEqual(
      resumed.map(agent => agent.output),
      [
        'Receiver handled the second finding.',
        'Sender sent the second finding.',
      ],
    );
    assert.deepEqual(
      resumed.map(agent => agent.sessionFile),
      initial.map(agent => agent.sessionFile),
    );
    assert.equal(requests.Receiver.length, 5);
    assert.equal(requests.Sender.length, 6);
    assert.equal(
      await readFile(resumed[0].resultFile!, 'utf8'),
      'Receiver handled the second finding.',
    );
    assert.equal(
      await readFile(resumed[1].resultFile!, 'utf8'),
      'Sender sent the second finding.',
    );
    const transcript = await readFile(resumed[0].sessionFile!, 'utf8');
    const userMessages = transcript
      .trim()
      .split('\n')
      .map(
        line =>
          JSON.parse(line) as {message?: {role: string; content: unknown}},
      )
      .filter(entry => entry.message?.role === 'user')
      .map(entry => entry.message!.content);
    assert.equal(userMessages.length, 3);
    assert.match(JSON.stringify(userMessages[0]), /Receiver initial task/);
    assertSender(userMessages[1], queuedMessage);
    assertSender(userMessages[2], resumedMessage);
    assert.match(transcript, /Receiver initial task/);
    assert.match(transcript, /Receiver handled the queued finding/);
    assert.match(transcript, /Received the queued peer finding/);
    assert.match(transcript, /Receiver handled the second finding/);
  },
);

void test(
  'worker records retain isolated provider usage across followups, cancellation and cleanup',
  {timeout: 20000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-worker-usage-'));
    const cwd = join(directory, 'project');
    const agentDir = join(directory, 'config');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    const providerId = 'worker-usage-test';
    const manager = new AgentOrchestrator(1);
    const workers = new Map<string, AgentWorker>();
    const disposed = new Set<string>();
    const requests: string[] = [];
    const partial = Promise.withResolvers<void>();
    let heldResponse: ServerResponse | undefined;
    let disconnected = false;
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body) as ProviderRequest;
      const initial = JSON.stringify(
        input.messages.find(message => message.role === 'user')?.content,
      );
      requests.push(initial);
      if (initial.includes('worker-b')) {
        heldResponse = response;
        response.once('close', () => {
          disconnected = true;
        });
        response.writeHead(200, {'content-type': 'text/event-stream'});
        response.write(
          `data: ${JSON.stringify({
            id: 'partial-call',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'worker-model',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: 'Partial measured response',
                },
                finish_reason: null,
              },
            ],
            usage: {
              prompt_tokens: 200,
              completion_tokens: 15,
              total_tokens: 215,
              prompt_tokens_details: {
                cached_tokens: 50,
                cache_write_tokens: 10,
              },
            },
          })}\n\n`,
        );
      } else {
        const count = requests.filter(item => item === initial).length;
        reply(
          response,
          `Completed ${initial} turn ${count}`,
          initial.includes('worker-c') ? 300 : count === 1 ? 100 : 150,
        );
      }
    });
    t.after(async () => {
      await manager.close();
      heldResponse?.destroy();
      server.closeAllConnections();
      registry.unregisterProvider(providerId);
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, {recursive: true, force: true});
    });
    await mkdir(cwd, {recursive: true});
    await mkdir(agentDir, {recursive: true});
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({retry: {enabled: false}, compaction: {enabled: false}}),
    );
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    registry.registerProvider(providerId, {
      api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      apiKey: 'fixture-key',
      models: [
        {
          id: 'worker-model',
          name: 'Usage worker',
          reasoning: false,
          input: ['text'],
          cost: {input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0.3},
          contextWindow: 128000,
          maxTokens: 1000,
        },
      ],
    });
    const spawn = (name: string, autoCleanup = false) =>
      manager.spawn(
        {
          name,
          task: name,
          cwd,
          model: `${providerId}/worker-model`,
          autoCleanup,
        },
        async id => {
          const worker = await createSessionWorker({
            id,
            parentSessionId: 'usage-parent',
            cwd,
            name,
            model: registry.find(providerId, 'worker-model')!,
            modelRegistry: registry,
            thinkingLevel: 'off',
            agentToolsExtension: pi => {
              pi.on('message_update', event => {
                if (
                  name === 'worker-b' &&
                  event.message.role === 'assistant' &&
                  event.message.content.some(
                    part =>
                      part.type === 'text' &&
                      part.text.includes('Partial measured'),
                  )
                )
                  partial.resolve();
              });
            },
          });
          const dispose = worker.dispose.bind(worker);
          worker.dispose = () => {
            disposed.add(name);
            dispose();
          };
          workers.set(name, worker);
          return worker;
        },
      );
    const a = spawn('worker-a');
    await manager.wait([a.id], {timeoutMs: 10000});
    assert.equal(manager.get(a.id).usage?.totalTokens, 110);
    await manager.send(a.id, 'Follow up using your history.');
    await manager.wait([a.id], {timeoutMs: 10000});
    const aUsage = manager.get(a.id).usage!;
    assert.equal(aUsage.calls.length, 2);
    assert.equal(aUsage.totalTokens, 270);
    assert.ok(Math.abs(aUsage.cost - 0.000473) < 1e-12);
    const b = spawn('worker-b', true);
    await partial.promise;
    const conversationDeadline = Date.now() + 5000;
    while (
      !manager
        .conversation(b.id)
        .conversation.some(
          message => message.text === 'Partial measured response',
        ) &&
      Date.now() < conversationDeadline
    )
      await delay(5);
    const partialMessage = manager
      .conversation(b.id)
      .conversation.find(message => message.role === 'assistant')!;
    assert.equal(partialMessage.text, 'Partial measured response');
    assert.equal(partialMessage.streaming, true);
    assert.equal(
      manager.get(b.id).usage?.calls.length,
      0,
      'stream updates do not bill a second call',
    );
    const c = spawn('worker-c', true);
    assert.equal(manager.get(c.id).status, 'queued');
    assert.equal(manager.get(c.id).usage, undefined);
    assert.equal(
      requests.some(item => item.includes('worker-c')),
      false,
      'queued local work sends no model request',
    );
    manager.cancel(b.id);
    const completed = await manager.wait([b.id, c.id], {timeoutMs: 10000});
    assert.deepEqual(
      completed.map(record => record.status),
      ['cancelled', 'completed'],
    );
    const bConversation = manager.conversation(b.id);
    const cancelledMessage = bConversation.conversation.find(
      message => message.role === 'assistant',
    )!;
    assert.equal(cancelledMessage.id, partialMessage.id);
    assert.equal(cancelledMessage.text, 'Partial measured response');
    assert.equal(cancelledMessage.streaming, false);
    assert.equal(manager.conversation(c.id).conversation[0].text, 'worker-c');
    assert.deepEqual(
      workers.get('worker-b')!.conversation,
      bConversation,
      'Cancelled text survives SDK disposal',
    );
    const bUsage = completed[0].usage!;
    assert.equal(bUsage.calls.length, 1);
    assert.equal(bUsage.calls[0].stopReason, 'aborted');
    assert.deepEqual(
      [
        bUsage.input,
        bUsage.output,
        bUsage.cacheRead,
        bUsage.cacheWrite,
        bUsage.totalTokens,
      ],
      [140, 15, 50, 10, 215],
    );
    assert.ok(Math.abs(bUsage.cost - 0.000353) < 1e-12);
    assert.equal(completed[1].usage?.totalTokens, 310);
    assert.deepEqual(
      manager.get(a.id).usage,
      aUsage,
      'another worker cancellation does not alter this worker',
    );
    assert.ok(disposed.has('worker-b') && disposed.has('worker-c'));
    assert.deepEqual(
      workers.get('worker-b')!.usage,
      bUsage,
      'usage survives SDK disposal',
    );
    const deadline = Date.now() + 5000;
    while (!disconnected && Date.now() < deadline) await delay(10);
    assert.ok(disconnected, 'cancelled provider stream disconnects');
    completed[0].usage!.calls[0].input = 9999;
    completed[0].usage!.calls[0].toolNames.push('mutated');
    const listed = manager.list();
    listed
      .find(record => record.id === b.id)!
      .usage!.calls[0].toolNames.push('mutated list');
    assert.equal(manager.get(b.id).usage!.input, 140);
    assert.deepEqual(manager.get(b.id).usage!.calls[0].toolNames, []);
    const now = new Date().toISOString();
    const dashboard = new DashboardState({
      id: 'usage-parent',
      cwd,
      name: 'Parent',
      status: 'idle',
      activity: 'Ready',
      startedAt: now,
      updatedAt: now,
    });
    dashboard.updateTeam(manager.list(), []);
    const projected = dashboard.snapshot();
    projected.agents
      .find(record => record.id === b.id)!
      .usage!.calls[0].toolNames.push('mutated dashboard');
    assert.deepEqual(
      dashboard.snapshot().agents.find(record => record.id === b.id)!.usage!
        .calls[0].toolNames,
      [],
    );
    await manager.close();
    assert.deepEqual(manager.get(a.id).usage, aUsage);
    assert.equal(manager.get(b.id).usage!.totalTokens, 215);
  },
);
