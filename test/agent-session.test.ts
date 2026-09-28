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
import {test, type TestContext} from 'node:test';
import {
  ModelRegistry,
  ModelRuntime,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionShutdownEvent,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {createSessionWorker} from '../src/agents/session.ts';
import type {AgentRecord, AgentWorker} from '../src/agents/orchestrator.ts';
import {registerAgentTools} from '../src/tools/agents.ts';

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
  'Pi workers load project tools and instructions, execute tools, and persist follow-up conversations',
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
            : `Final answer ${requests.length}`,
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
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
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
    assert.equal(
      await worker.run(
        'Read context.txt and report.',
        AbortSignal.timeout(5000),
        item => activity.push(item),
      ),
      'Final answer 2',
    );
    assert.ok(activity.includes('Using read'));
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
  'SDK workers discover peers, queue messages, resume conversations, and store parent inbox messages silently',
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
            [
              'agent_list',
              'agent_message_remove',
              'agent_messages',
              'agent_new_session',
              'agent_send',
            ],
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
          // Keep the recipient's initial turn open until the peer tool has queued work.
          await peerQueued.promise;
          reply(response, 'Receiver initial result.');
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
          assert.equal(result.agents[0].pendingMessages, 1);
          peerQueued.resolve();
          reply(response, 'Sender queued the peer finding.');
        } else if (name === 'Receiver' && step === 3) {
          assertSender(
            input.messages.findLast(message => message.role === 'user')
              ?.content,
            queuedMessage,
          );
          assert.match(
            JSON.stringify(input.messages),
            /Receiver initial result/,
          );
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
          assert.match(
            JSON.stringify(input.messages),
            /Receiver initial result/,
          );
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
    const execute = (name: string, params: Record<string, unknown>) =>
      tools
        .get(name)!
        .execute('parent-call', params, undefined, undefined, ctx);
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
    assert.match(transcript, /Receiver initial result/);
    assert.match(transcript, /Receiver handled the queued finding/);
    assert.match(transcript, /Received the queued peer finding/);
    assert.match(transcript, /Receiver handled the second finding/);
  },
);

async function localParent(
  t: TestContext,
  respond: (
    request: ProviderRequest,
    step: number,
  ) => Promise<Parameters<typeof reply>[1]>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'varisdev-handover-sdk-'));
  const cwd = join(directory, 'project');
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(directory, 'config');
  const registry = new ModelRegistry(
    await ModelRuntime.create({
      authPath: join(directory, 'config', 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    }),
  );
  const tools = new Map<string, ToolDefinition>();
  const events = new Map<string, ShutdownHandler>();
  const parentMessages: Array<Parameters<ExtensionAPI['sendMessage']>> = [];
  registerAgentTools({
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
  } as unknown as ExtensionAPI);
  const providerErrors: unknown[] = [];
  let step = 0;
  const server = createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      reply(response, await respond(JSON.parse(body), ++step));
    } catch (error) {
      providerErrors.push(error);
      reply(response, `Provider fixture failed: ${String(error)}`);
    }
  });
  t.after(async () => {
    await events.get('session_shutdown')?.({
      type: 'session_shutdown',
      reason: 'quit',
    });
    registry.unregisterProvider('openai-codex');
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
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
    sessionManager: {getSessionId: () => 'handover-parent'},
  } as unknown as ExtensionContext;
  const execute = (name: string, params: Record<string, unknown>) =>
    tools.get(name)!.execute('parent-call', params, undefined, undefined, ctx);
  return {
    cwd,
    execute,
    parentMessages,
    async wait(id: string) {
      const result = await execute('agent_wait', {ids: [id], timeoutMs: 10000});
      assert.deepEqual(providerErrors, []);
      const agent = (result.details as {agents: AgentRecord[]}).agents[0];
      assert.equal(agent.status, 'completed', JSON.stringify(agent));
      return agent;
    },
  };
}

void test(
  'SDK workers retain results and queued follow-ups across fresh sessions without completion notifications',
  {timeout: 20000},
  async t => {
    const originalTask =
      'ORIGINAL TASK MARKER: use automatic handovers for this workflow.';
    const originalContext = 'ORIGINAL TOOL CONTEXT MARKER';
    const firstHandover =
      'FIRST HANDOVER: checkpoint alpha; read context.txt and continue automatically.';
    const secondHandover =
      'SECOND HANDOVER: checkpoint beta; finish the workflow.';
    const queuedFollowup =
      'QUEUED FOLLOWUP: continue with another fresh handover.';
    const latestFollowup =
      'LATEST FOLLOWUP: summarize the completed checkpoint.';
    const sessions: AgentRecord[] = [];
    const parent = await localParent(t, async (input, step) => {
      const conversation = input.messages.filter(
        message => !['system', 'developer'].includes(message.role),
      );
      const text = JSON.stringify(input.messages);
      if ([1, 4, 9].includes(step)) {
        assert.equal(
          conversation.length,
          1,
          'A fresh session starts with only the handover or initial task',
        );
        assert.equal(conversation[0].role, 'user');
        assert.match(text, /Project handover instruction marker/);
        assert.match(text, /Persistent worker instruction marker/);
        assert.deepEqual(
          input.tools
            .map(tool => tool.function.name)
            .filter(name => name.startsWith('agent_'))
            .sort(),
          [
            'agent_list',
            'agent_message_remove',
            'agent_messages',
            'agent_new_session',
            'agent_send',
          ],
        );
        assert.ok(input.tools.some(tool => tool.function.name === 'read'));
        if (step !== 1) {
          assert.doesNotMatch(
            text,
            /ORIGINAL TASK MARKER|ORIGINAL TOOL CONTEXT MARKER/,
          );
          assert.ok(
            JSON.stringify(conversation[0].content).includes(
              step === 4 ? firstHandover : secondHandover,
            ),
          );
        }
        if (step === 9) {
          assert.doesNotMatch(
            text,
            /FIRST HANDOVER|QUEUED FOLLOWUP|Fresh project tool contents/,
          );
        }
      }
      if ([3, 6, 10].includes(step)) {
        const listed = lastToolResult<{
          selfId: string;
          agents: Array<{id: string}>;
        }>(input);
        assert.equal(listed.selfId, id);
        assert.deepEqual(
          listed.agents.map(agent => agent.id),
          [id],
        );
        const status = await parent.execute('agent_status', {id});
        sessions.push((status.details as {agents: AgentRecord[]}).agents[0]);
      }
      switch (step) {
        case 1:
          assert.ok(text.includes(originalTask));
          return {name: 'read', arguments: {path: 'original.txt'}};
        case 2:
          assert.ok(text.includes(originalContext));
          return {name: 'agent_list', arguments: {view: 'all'}};
        case 3:
          // Queue work while the old SDK run is still active, before it requests a new session.
          await parent.execute('agent_send', {id, message: queuedFollowup});
          return {
            name: 'agent_new_session',
            arguments: {handover: firstHandover},
          };
        case 4:
          return {name: 'read', arguments: {path: 'context.txt'}};
        case 5:
          assert.match(text, /Fresh project tool contents/);
          return {name: 'agent_list', arguments: {view: 'all'}};
        case 6:
          return {
            name: 'agent_send',
            arguments: {id: 'parent', message: 'First fresh session ready.'},
          };
        case 7: {
          const result = lastToolResult<{
            recipient: 'parent';
            stored: true;
            messageId: string;
          }>(input);
          assert.equal(result.recipient, 'parent');
          assert.equal(result.stored, true);
          assert.ok(result.messageId);
          return 'First handover result.';
        }
        case 8:
          assert.ok(
            JSON.stringify(conversation.at(-1)?.content).includes(
              queuedFollowup,
            ),
          );
          assert.ok(text.includes(firstHandover));
          assert.match(text, /First handover result/);
          return {
            name: 'agent_new_session',
            arguments: {handover: secondHandover},
          };
        case 9:
          return {name: 'agent_list', arguments: {view: 'all'}};
        case 10:
          return {
            name: 'agent_send',
            arguments: {id: 'parent', message: 'Second fresh session ready.'},
          };
        case 11: {
          const result = lastToolResult<{
            recipient: 'parent';
            stored: true;
            messageId: string;
          }>(input);
          assert.equal(result.recipient, 'parent');
          assert.equal(result.stored, true);
          assert.ok(result.messageId);
          return 'Second handover result.';
        }
        case 12:
          assert.equal(
            conversation.filter(message => message.role === 'user').length,
            2,
          );
          assert.ok(
            JSON.stringify(conversation.at(-1)?.content).includes(
              latestFollowup,
            ),
          );
          assert.ok(text.includes(secondHandover));
          assert.match(text, /Second handover result/);
          assert.doesNotMatch(
            text,
            /ORIGINAL TASK MARKER|FIRST HANDOVER|QUEUED FOLLOWUP/,
          );
          return 'Latest followup result.';
        default:
          assert.fail(`Unexpected provider request ${step}`);
      }
    });
    await writeFile(
      join(parent.cwd, 'AGENTS.md'),
      'Project handover instruction marker: report progress.',
    );
    await writeFile(join(parent.cwd, 'original.txt'), originalContext);
    await writeFile(
      join(parent.cwd, 'context.txt'),
      'Fresh project tool contents',
    );
    const spawned = await parent.execute('agent_spawn', {
      name: 'Ongoing worker',
      task: originalTask,
      instructions:
        'Persistent worker instruction marker: follow the project instructions.',
      timeoutMs: 10000,
    });
    const {id} = (spawned.details as {agents: AgentRecord[]}).agents[0];
    const completed = await parent.wait(id);
    assert.equal(completed.output, 'Second handover result.');
    const status = await parent.execute('agent_status', {id});
    assert.deepEqual(
      (status.details as {agents: AgentRecord[]}).agents,
      [completed],
      'Status must retain the result returned by wait after worker handovers',
    );
    assert.deepEqual(
      sessions.map(agent => agent.sessionCount),
      [1, 2, 3],
    );
    const paths = sessions.map(agent => agent.sessionFile!);
    assert.equal(new Set(paths).size, 3);
    assert.equal(completed.sessionFile, paths[2]);
    assert.equal(completed.previousSessionFile, paths[1]);
    assert.equal(sessions[1].previousSessionFile, paths[0]);
    const transcripts = await Promise.all(
      paths.map(path => readFile(path, 'utf8')),
    );
    const headers = transcripts.map(
      text =>
        JSON.parse(text.split('\n')[0]) as {
          id: string;
          type: string;
          parentSession?: string;
        },
    );
    assert.equal(new Set(headers.map(header => header.id)).size, 3);
    assert.ok(headers.every(header => header.type === 'session'));
    assert.equal(headers[1].parentSession, paths[0]);
    assert.equal(headers[2].parentSession, paths[1]);
    assert.ok(transcripts[0].includes(originalTask));
    assert.ok(transcripts[0].includes(originalContext));
    assert.match(transcripts[0], /agent_new_session/);
    assert.ok(transcripts[1].includes(firstHandover));
    assert.ok(transcripts[1].includes(queuedFollowup));
    assert.match(transcripts[1], /agent_new_session/);
    assert.ok(transcripts[2].includes(secondHandover));
    assert.doesNotMatch(
      transcripts[2],
      /ORIGINAL TOOL CONTEXT MARKER|FIRST HANDOVER|QUEUED FOLLOWUP/,
    );
    assert.deepEqual(
      parent.parentMessages,
      [],
      'Worker messages and completions must not reach the parent session',
    );
    const inbox = (await parent.execute('agent_inbox', {})).details as {
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
    assert.equal(inbox.total, 2);
    assert.equal(inbox.offset, 0);
    assert.equal(inbox.nextOffset, undefined);
    assert.deepEqual(
      inbox.messages.map(message => ({
        from: message.from,
        length: message.length,
        preview: message.preview,
      })),
      ['Second fresh session ready.', 'First fresh session ready.'].map(
        message => ({
          from: {id, name: 'Ongoing worker'},
          length: message.length,
          preview: message,
        }),
      ),
      'Worker handovers retain parent messages in newest-first order',
    );
    const oldest = inbox.messages[1];
    const full = (await parent.execute('agent_inbox', {messageId: oldest.id}))
      .details as {
      message: {
        id: string;
        from: {id: string; name: string};
        createdAt: string;
        message: string;
      };
    };
    assert.deepEqual(full.message, {
      id: oldest.id,
      from: oldest.from,
      createdAt: oldest.createdAt,
      message: 'First fresh session ready.',
    });
    assert.deepEqual(
      (await parent.execute('agent_inbox', {})).details,
      inbox,
      'Inbox reads must not consume messages',
    );
    await parent.execute('agent_send', {id, message: latestFollowup});
    const followedUp = await parent.wait(id);
    assert.equal(followedUp.sessionFile, paths[2]);
    assert.equal(followedUp.sessionCount, 3);
    assert.equal(followedUp.output, 'Latest followup result.');
    const latestStatus = await parent.execute('agent_status', {id});
    assert.deepEqual((latestStatus.details as {agents: AgentRecord[]}).agents, [
      followedUp,
    ]);
    assert.deepEqual(parent.parentMessages, []);
    assert.deepEqual((await parent.execute('agent_inbox', {})).details, inbox);
    assert.equal(
      await readFile(followedUp.resultFile!, 'utf8'),
      'Latest followup result.',
    );
    assert.deepEqual(
      await Promise.all(paths.slice(0, 2).map(path => readFile(path, 'utf8'))),
      transcripts.slice(0, 2),
    );
    const latestTranscript = await readFile(paths[2], 'utf8');
    assert.match(latestTranscript, /Second handover result/);
    assert.ok(latestTranscript.includes(latestFollowup));
    assert.match(latestTranscript, /Latest followup result/);
  },
);
