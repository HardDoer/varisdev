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
} from '@earendil-works/pi-coding-agent';
import type {AgentSessionController} from '../src/agents/team.ts';
import {observeDashboardSession} from '../src/dashboard/observe.ts';
import type {DashboardState} from '../src/dashboard/state.ts';
import {createDashboardParent} from '../src/dashboard/parent.ts';
import type {DashboardParent} from '../src/dashboard/hub.ts';

interface ProviderRequest {
  model: string;
  reasoning_effort?: string;
  messages: Array<{role: string; content: unknown}>;
  tools: Array<{function: {name: string}}>;
}

interface CapturedRequest {
  body: ProviderRequest;
  headers: IncomingHttpHeaders;
  worker: boolean;
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
      model: 'dashboard-model',
      choices: [{index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop'}],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: {cached_tokens: 25, cache_write_tokens: 5},
      },
    })}\n\ndata: [DONE]\n\n`,
  );
}

async function waitFor(
  check: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await delay(10);
  assert.ok(check(), description);
}

void test(
  'dashboard parents use real SDK sessions, inherited credentials, native tools, workers and independent histories',
  {timeout: 25000},
  async t => {
    const directory = await mkdtemp(
      join(tmpdir(), 'varisdev-dashboard-parent-'),
    );
    const agentDir = join(directory, 'config');
    const cwd = join(directory, 'chosen-project');
    const otherCwd = join(directory, 'other-project');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const providerId = 'dashboard-parent-test';
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    const requests: CapturedRequest[] = [];
    const serverErrors: unknown[] = [];
    let heldResponse: ServerResponse | undefined;
    let steeringResponse: ServerResponse | undefined;
    let heldDisconnected = false;
    const server = createServer(async (request, response) => {
      try {
        let text = '';
        for await (const chunk of request) text += chunk;
        const body = JSON.parse(text) as ProviderRequest;
        const worker = !body.tools.some(
          tool => tool.function.name === 'agent_spawn',
        );
        requests.push({body, headers: request.headers, worker});
        const userIndex = body.messages.findLastIndex(
          message => message.role === 'user',
        );
        const prompt = JSON.stringify(body.messages[userIndex]?.content);
        const toolResults = body.messages
          .slice(userIndex + 1)
          .filter(message => message.role === 'tool');
        if (worker) {
          if (prompt.includes('hold-worker')) {
            heldResponse = response;
            response.once('close', () => {
              heldDisconnected = true;
            });
          } else {
            reply(
              response,
              toolResults.length === 0
                ? {
                    name: 'write',
                    arguments: {
                      path: 'worker.txt',
                      content: 'Worker wrote this.\n',
                    },
                  }
                : 'Completed worker result.',
            );
          }
        } else if (prompt.includes('steer-held-parent')) {
          steeringResponse = response;
        } else if (prompt.includes('steering-parent')) {
          assert.ok(
            body.messages.some(message => message.role === 'tool'),
            'Steering is delivered after the in-flight tool executes',
          );
          reply(response, 'Steered during the unfinished task.');
        } else if (prompt.includes('independent-parent')) {
          reply(response, 'Independent parent answer.');
        } else if (prompt.includes('follow-up-parent')) {
          reply(response, 'Follow-up parent answer.');
        } else if (prompt.includes('start-held-worker')) {
          reply(
            response,
            toolResults.length === 0
              ? {
                  name: 'agent_spawn',
                  arguments: {
                    name: 'Held worker',
                    task: 'hold-worker until cancelled',
                  },
                }
              : 'Background worker started.',
          );
        } else {
          const outputs = [
            {
              name: 'write',
              arguments: {path: 'parent.txt', content: 'Parent wrote this.\n'},
            },
            {
              name: 'agent_spawn',
              arguments: {
                name: 'Writer worker',
                task: 'Write the worker fixture and report.',
              },
            },
            {name: 'agent_wait', arguments: {timeoutMs: 5000}},
            'Parent completed the delegated task.',
          ];
          reply(
            response,
            outputs[toolResults.length] ?? 'Unexpected extra turn.',
          );
        }
      } catch (error) {
        serverErrors.push(error);
        response.writeHead(500);
        response.end('Fixture failed');
      }
    });
    const parents: DashboardParent[] = [];
    t.after(async () => {
      try {
        await Promise.all(parents.map(parent => parent.close()));
      } finally {
        heldResponse?.destroy();
        steeringResponse?.destroy();
        registry.unregisterProvider(providerId);
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        if (previousAgentDir === undefined)
          delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(directory, {recursive: true, force: true});
      }
    });
    await Promise.all([
      mkdir(cwd, {recursive: true}),
      mkdir(otherCwd, {recursive: true}),
      mkdir(agentDir, {recursive: true}),
    ]);
    await writeFile(
      join(cwd, 'AGENTS.md'),
      'Chosen project context marker: all work belongs in this folder.',
    );
    await writeFile(
      join(otherCwd, 'AGENTS.md'),
      'Independent project context marker: keep this history separate.',
    );
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
      apiKey: 'configured-fallback-key',
      headers: {'x-inherited-provider': 'parent-provider'},
      models: [
        {
          id: 'dashboard-model',
          name: 'Dashboard fixture model',
          reasoning: true,
          input: ['text'],
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          contextWindow: 128000,
          maxTokens: 1000,
          headers: {'x-inherited-model': 'parent-model'},
          compat: {supportsReasoningEffort: true},
        },
      ],
    });
    await runtime.setRuntimeApiKey(providerId, 'runtime-parent-key');
    const inherited = {
      model: registry.find(providerId, 'dashboard-model')!,
      modelRegistry: registry,
      thinkingLevel: 'high' as const,
    };
    const parent = await createDashboardParent(
      {cwd, name: 'Chosen parent'},
      inherited,
    );
    parents.push(parent);
    const initial = parent.state.snapshot();
    assert.equal(initial.session.cwd, cwd);
    assert.equal(initial.session.name, 'Chosen parent');
    assert.equal(initial.session.status, 'idle');
    assert.equal(initial.session.model, `${providerId}/dashboard-model`);
    const activities: string[] = [];
    const unsubscribe = parent.state.subscribe(() => {
      activities.push(parent!.state.snapshot().session.activity);
    });
    t.after(unsubscribe);
    await parent.prompt(
      'Write a parent file, delegate the worker file, and collect the result.',
    );
    await waitFor(
      () => parent!.state.snapshot().session.status === 'idle',
      'parent becomes idle after its SDK run',
    );
    const completed = parent.state.snapshot();
    assert.equal(
      completed.session.response,
      'Parent completed the delegated task.',
    );
    assert.deepEqual(
      completed.conversation.map(message => [message.role, message.toolName]),
      [
        ['user', undefined],
        ['tool', 'write'],
        ['tool', 'agent_spawn'],
        ['tool', 'agent_wait'],
        ['assistant', undefined],
      ],
    );
    const tools = completed.conversation.filter(
      message => message.role === 'tool',
    );
    assert.ok(
      tools.every(
        message => message.status === 'completed' && message.finishedAt,
      ),
    );
    assert.equal(tools[0].input?.split('\n')[0], 'parent.txt');
    assert.match(tools[0].text, /Successfully wrote/);
    assert.match(tools[1].input ?? '', /Writer worker/);
    assert.match(tools[2].text, /Completed worker result/);
    assert.equal(new Set(tools.map(message => message.toolCallId)).size, 3);
    assert.equal(
      completed.conversation[0].text,
      'Write a parent file, delegate the worker file, and collect the result.',
    );
    assert.equal(
      completed.conversation.at(-1)?.text,
      'Parent completed the delegated task.',
    );
    assert.ok(completed.conversation.every(message => !message.streaming));
    assert.equal(completed.usage.calls.length, 4);
    assert.deepEqual(
      [
        completed.usage.input,
        completed.usage.output,
        completed.usage.cacheRead,
        completed.usage.cacheWrite,
        completed.usage.totalTokens,
        completed.usage.cost,
      ],
      [280, 80, 100, 20, 480, 0],
      'SDK provider usage includes the four parent calls and excludes worker calls',
    );
    assert.deepEqual(
      completed.usage.calls.map(call => call.toolNames),
      [['write'], ['agent_spawn'], ['agent_wait'], []],
    );
    assert.ok(completed.session.sessionFile);
    let restoredState: DashboardState | undefined;
    let startObserver:
      ((event: never, ctx: ExtensionContext) => unknown) | undefined;
    const reloadedSession = SessionManager.open(completed.session.sessionFile!);
    observeDashboardSession(
      {
        getThinkingLevel: () => 'high',
        on(name: string, handler: typeof startObserver) {
          if (name === 'session_start') startObserver = handler;
        },
      } as unknown as ExtensionAPI,
      {
        snapshot: () => undefined,
        subscribe: () => () => {},
      } as unknown as AgentSessionController,
      state => {
        restoredState = state;
      },
    );
    await startObserver!(
      {type: 'session_start'} as never,
      {
        cwd,
        sessionManager: reloadedSession,
        isIdle: () => true,
        getContextUsage: () => undefined,
      } as unknown as ExtensionContext,
    );
    assert.deepEqual(
      restoredState!
        .snapshot()
        .conversation.map(message => [
          message.id,
          message.role,
          message.toolName,
          message.toolCallId,
          message.input,
          message.text,
          message.at,
          message.status,
        ]),
      completed.conversation.map(message => [
        message.id,
        message.role,
        message.toolName,
        message.toolCallId,
        message.input,
        message.text,
        message.at,
        message.status,
      ]),
      'reopening the persisted SDK branch restores the live conversation',
    );
    assert.deepEqual(
      restoredState!.snapshot().usage,
      completed.usage,
      'reopening SDK history restores provider counts and call IDs',
    );
    assert.ok(activities.includes('Using write'));
    assert.equal(
      await readFile(join(cwd, 'parent.txt'), 'utf8'),
      'Parent wrote this.\n',
    );
    assert.equal(
      await readFile(join(cwd, 'worker.txt'), 'utf8'),
      'Worker wrote this.\n',
    );
    assert.equal(completed.agents.length, 1);
    assert.equal(completed.agents[0].status, 'completed');
    assert.equal(completed.agents[0].output, 'Completed worker result.');
    assert.equal(completed.agents[0].usage?.totalTokens, 240);
    assert.deepEqual(
      completed.agents[0].usage?.calls.map(call => call.toolNames),
      [['write'], []],
      'real delegated provider usage reaches the dashboard separately from parent usage',
    );
    assert.equal(completed.changes.length, 2);
    const parentChange = completed.changes.find(
      change => change.unitId === 'parent',
    );
    assert.ok(
      parentChange,
      'native parent write is attributed to the parent session',
    );
    assert.equal(parentChange.path, join(cwd, 'parent.txt'));
    assert.equal(parentChange.tool, 'write');
    assert.equal(parentChange.summary, 'Created file');
    assert.match(parentChange.diff, /\+Parent wrote this\./);
    const workerChange = completed.changes.find(
      change => change.unitId === completed.agents[0].id,
    );
    assert.ok(workerChange, 'native worker write is attributed to its worker');
    assert.equal(workerChange.path, join(cwd, 'worker.txt'));
    assert.equal(workerChange.unitName, 'Writer worker');
    assert.match(workerChange.diff, /\+Worker wrote this\./);
    assert.equal(completed.agents[0].cwd, cwd);
    assert.equal(completed.agents[0].model, `${providerId}/dashboard-model`);
    assert.match(
      JSON.stringify(requests[0].body.messages),
      /Chosen project context marker/,
    );
    assert.match(
      JSON.stringify(requests.find(item => item.worker)!.body.messages),
      /Chosen project context marker/,
    );
    const names = requests[0].body.tools.map(tool => tool.function.name);
    for (const name of [
      'read',
      'bash',
      'edit',
      'write',
      'browse',
      'download',
      'json_query',
      'agent_spawn',
      'agent_wait',
      'agent_list',
    ]) {
      assert.ok(
        names.includes(name),
        `${name} is available to dashboard parents`,
      );
    }
    for (const captured of requests) {
      assert.equal(captured.headers.authorization, 'Bearer runtime-parent-key');
      assert.equal(captured.headers['x-inherited-provider'], 'parent-provider');
      assert.equal(captured.headers['x-inherited-model'], 'parent-model');
      assert.equal(captured.body.model, 'dashboard-model');
      assert.equal(captured.body.reasoning_effort, 'high');
    }
    assert.match(
      JSON.stringify(requests.findLast(item => !item.worker)!.body.messages),
      /Completed worker result/,
    );

    await runtime.setRuntimeApiKey(providerId, 'rotated-runtime-key');
    await parent.prompt('follow-up-parent: summarize the prior result.');
    const followup = requests.at(-1)!;
    assert.match(
      JSON.stringify(followup.body.messages),
      /Parent completed the delegated task/,
    );
    assert.match(JSON.stringify(followup.body.messages), /Parent wrote this/);
    assert.equal(followup.headers.authorization, 'Bearer rotated-runtime-key');
    assert.equal(
      parent.state.snapshot().session.response,
      'Follow-up parent answer.',
    );
    assert.equal(parent.state.snapshot().session.id, initial.session.id);

    const other = await createDashboardParent(
      {cwd: otherCwd, name: 'Other parent'},
      inherited,
    );
    parents.push(other);
    assert.notEqual(other.state.snapshot().session.id, initial.session.id);
    assert.equal(other.state.snapshot().session.cwd, otherCwd);
    await other.prompt('independent-parent: introduce this project.');
    const independent = requests.at(-1)!;
    const independentHistory = JSON.stringify(independent.body.messages);
    assert.match(independentHistory, /Independent project context marker/);
    assert.doesNotMatch(
      independentHistory,
      /Chosen project context marker|Parent completed the delegated task|follow-up-parent/,
    );
    assert.equal(
      other.state.snapshot().session.response,
      'Independent parent answer.',
    );
    assert.equal(
      parent.state.snapshot().session.response,
      'Follow-up parent answer.',
    );
    assert.deepEqual(other.state.snapshot().agents, []);
    assert.deepEqual(other.state.snapshot().changes, []);

    await parent.reload();
    const steeredRun = parent.prompt(
      'steer-held-parent: begin a task with a tool call.',
    );
    await waitFor(
      () => !!steeringResponse,
      'parent reaches its first model request',
    );
    await parent.prompt(
      'steering-parent: change approach before the task finishes.',
    );
    await parent.prompt(
      'steering-parent: also include this correction in the next model turn.',
    );
    const steeringMessages = [
      'steering-parent: change approach before the task finishes.',
      'steering-parent: also include this correction in the next model turn.',
    ];
    assert.deepEqual(parent.state.snapshot().queue, {
      steering: steeringMessages,
      followUp: [],
    });
    assert.deepEqual(other.state.snapshot().queue, {
      steering: [],
      followUp: [],
    });
    const queueCopy = parent.state.snapshot().queue!;
    queueCopy.steering.length = 0;
    assert.equal(parent.state.snapshot().queue!.steering.length, 2);
    const nextTurnIndex = requests.length;
    reply(steeringResponse!, {
      name: 'write',
      arguments: {
        path: 'steering-boundary.txt',
        content: 'Current turn completed its tool call.',
      },
    });
    await steeredRun;
    const nextTurn = requests[nextTurnIndex].body.messages;
    assert.deepEqual(
      nextTurn
        .filter(message => message.role === 'user')
        .slice(-2)
        .map(message => message.content),
      steeringMessages.map(text => [{type: 'text', text}]),
      'Every pending steering message reaches the very next model call',
    );
    assert.equal(requests.length, nextTurnIndex + 1);
    assert.deepEqual(parent.state.snapshot().queue, {
      steering: [],
      followUp: [],
    });
    assert.equal(
      parent.state.snapshot().session.response,
      'Steered during the unfinished task.',
    );
    assert.equal(
      await readFile(join(cwd, 'steering-boundary.txt'), 'utf8'),
      'Current turn completed its tool call.',
    );
    assert.match(
      JSON.stringify(requests.at(-1)!.body.messages),
      /steering-parent: change approach/,
    );

    steeringResponse = undefined;
    const cancelledSteerRun = parent.prompt('steer-held-parent: cancellation');
    await waitFor(() => !!steeringResponse, 'parent waits before cancellation');
    await parent.prompt('Do not deliver this queued steering message.');
    assert.equal(parent.state.snapshot().queue!.steering.length, 1);
    await parent.abort();
    await cancelledSteerRun;
    assert.deepEqual(parent.state.snapshot().queue, {
      steering: [],
      followUp: [],
    });
    assert.ok(
      !parent.state
        .snapshot()
        .conversation.some(
          message =>
            message.role === 'user' &&
            message.text === 'Do not deliver this queued steering message.',
        ),
    );

    await parent.prompt(
      'start-held-worker: leave a worker running in the background.',
    );
    await waitFor(
      () => heldResponse !== undefined,
      'background worker reaches the local provider',
    );
    assert.ok(
      parent.state
        .snapshot()
        .agents.some(
          agent => agent.name === 'Held worker' && agent.status === 'running',
        ),
    );
    const closing = parent.close();
    assert.equal(parent.close(), closing);
    await closing;
    await waitFor(
      () => heldDisconnected,
      'closing the parent cancels its active worker request',
    );
    assert.equal(parent.state.snapshot().session.status, 'closed');
    await assert.rejects(parent.prompt('must not run'), /closed/);
    await other.prompt(
      'independent-parent: still available after sibling shutdown.',
    );
    assert.equal(other.state.snapshot().session.status, 'idle');
    await other.close();
    assert.equal(other.state.snapshot().session.status, 'closed');

    for (const action of ['abort', 'close', 'steer'] as const) {
      await t.test(
        `${action} during credential preflight`,
        async cancellation => {
          if (action === 'steer') {
            const prompts = join(otherCwd, '.pi', 'prompts');
            await mkdir(prompts, {recursive: true});
            await writeFile(
              join(prompts, 'preflight-steer.md'),
              'independent-parent: TEMPLATE $@',
            );
          }
          const cancelled = await createDashboardParent(
            {cwd: otherCwd, name: `Cancelled during ${action}`},
            inherited,
          );
          parents.push(cancelled);
          let releaseCredentials!: () => void;
          const credentials = new Promise<void>(resolve => {
            releaseCredentials = resolve;
          });
          cancellation.after(releaseCredentials);
          let checkingCredentials = false;
          const hasConfiguredAuth = ModelRuntime.prototype.hasConfiguredAuth;
          const checkAuth = ModelRuntime.prototype.checkAuth;
          cancellation.mock.method(
            ModelRuntime.prototype,
            'hasConfiguredAuth',
            function (this: ModelRuntime, provider: string) {
              return provider === providerId
                ? false
                : hasConfiguredAuth.call(this, provider);
            },
          );
          cancellation.mock.method(
            ModelRuntime.prototype,
            'checkAuth',
            async function (
              this: ModelRuntime,
              ...args: Parameters<ModelRuntime['checkAuth']>
            ) {
              if (args[0] === providerId) {
                checkingCredentials = true;
                await credentials;
              }
              return checkAuth.apply(this, args);
            },
          );
          const requestCount = requests.length;
          const initialPrompt =
            'independent-parent: initial request before credentials resolve.';
          const prompting = cancelled.prompt(initialPrompt);
          await waitFor(
            () => checkingCredentials,
            'SDK prompt waits for credentials',
          );
          if (action === 'steer') {
            await cancelled.prompt(
              'independent-parent: first correction during preflight.',
            );
            await cancelled.prompt(
              '/preflight-steer second correction during preflight.',
            );
            const corrections = [
              'independent-parent: first correction during preflight.',
              'independent-parent: TEMPLATE second correction during preflight.',
            ];
            assert.deepEqual(cancelled.state.snapshot().queue, {
              steering: corrections,
              followUp: [],
            });
            assert.equal(requests.length, requestCount);
            releaseCredentials();
            await prompting;
            assert.equal(
              requests.length,
              requestCount + 1,
              'Preflight steering uses the initial run without starting extra turns',
            );
            assert.deepEqual(
              requests[requestCount].body.messages
                .filter(message => message.role === 'user')
                .map(message => message.content),
              [initialPrompt, ...corrections].map(text => [
                {type: 'text', text},
              ]),
              'The initial prompt and all preflight corrections reach the first model call in order',
            );
            assert.deepEqual(cancelled.state.snapshot().queue, {
              steering: [],
              followUp: [],
            });
            await cancelled.close();
            return;
          }
          let stopped = false;
          const stopping = cancelled[action]().then(() => {
            stopped = true;
          });
          await delay(10);
          assert.equal(
            stopped,
            false,
            `${action} keeps the live session until preflight settles`,
          );
          assert.notEqual(cancelled.state.snapshot().session.status, 'closed');
          releaseCredentials();
          await Promise.all([prompting, stopping]);
          const cancelledSnapshot = cancelled.state.snapshot();
          assert.deepEqual(cancelledSnapshot.conversation, []);
          assert.equal(
            requests.length,
            requestCount,
            'cancelled preflight sends no provider request',
          );
          assert.equal(
            cancelledSnapshot.events.some(event => event.kind === 'tool'),
            false,
          );
          assert.deepEqual(cancelledSnapshot.agents, []);
          assert.deepEqual(cancelledSnapshot.changes, []);
          assert.equal(
            cancelledSnapshot.session.status,
            action === 'close' ? 'closed' : 'idle',
          );
          if (action !== 'close') {
            await cancelled.prompt(
              'independent-parent: continue after the cancelled preflight.',
            );
            assert.equal(requests.length, requestCount + 1);
            assert.equal(
              cancelled.state.snapshot().session.response,
              'Independent parent answer.',
            );
            await cancelled.close();
          } else {
            await assert.rejects(
              cancelled.prompt('must stay closed'),
              /closed/,
            );
          }
        },
      );
    }

    assert.equal(
      JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'))
        .steeringMode,
      undefined,
      'Desktop steering policy does not change the saved Pi settings',
    );

    // Standalone desktop parents select the user's configured model and auth.
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({
        defaultProvider: providerId,
        defaultModel: 'dashboard-model',
        defaultThinkingLevel: 'high',
        retry: {enabled: false},
      }),
    );
    await mkdir(join(otherCwd, '.pi'), {recursive: true});
    await writeFile(
      join(otherCwd, '.pi', 'settings.json'),
      JSON.stringify({defaultThinkingLevel: 'medium'}),
    );
    await writeFile(
      join(agentDir, 'auth.json'),
      JSON.stringify({
        [providerId]: {type: 'api_key', key: 'saved-desktop-key'},
      }),
    );
    await writeFile(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          [providerId]: {
            api: 'openai-completions',
            baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
            headers: {'x-desktop-provider': 'configured-provider'},
            models: [
              {
                id: 'dashboard-model',
                reasoning: true,
                input: ['text'],
                contextWindow: 128000,
                maxTokens: 1000,
                compat: {supportsReasoningEffort: true},
              },
            ],
          },
        },
      }),
    );
    const standalone = await createDashboardParent({
      cwd: otherCwd,
      name: 'Standalone desktop parent',
    });
    parents.push(standalone);
    assert.equal(
      standalone.state.snapshot().session.model,
      `${providerId}/dashboard-model`,
    );
    const standaloneStart = requests.length;
    await standalone.prompt(
      'Write files with the configured standalone model.',
    );
    const standaloneRequests = requests.slice(standaloneStart);
    assert.ok(standaloneRequests.some(captured => captured.worker));
    for (const captured of standaloneRequests) {
      assert.equal(captured.headers.authorization, 'Bearer saved-desktop-key');
      assert.equal(
        captured.headers['x-desktop-provider'],
        'configured-provider',
      );
      assert.equal(captured.body.reasoning_effort, 'medium');
    }
    assert.equal(standalone.state.snapshot().session.status, 'idle');
    assert.equal(
      standalone.state.snapshot().session.response,
      'Parent completed the delegated task.',
    );
    assert.equal(
      await readFile(join(otherCwd, 'worker.txt'), 'utf8'),
      'Worker wrote this.\n',
    );
    await standalone.close();
    assert.equal(standalone.state.snapshot().session.status, 'closed');
    assert.deepEqual(serverErrors, []);
  },
);
