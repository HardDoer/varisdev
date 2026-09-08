import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
} from '@earendil-works/pi-coding-agent';
import type {AgentRecord} from '../src/agents/orchestrator.ts';
import {registerAgentTools} from '../src/tools/agents.ts';
import {registerSessionNewTool} from '../src/tools/session-new.ts';

interface ProviderRequest {
  model: string;
  messages: Array<{role: string; content: unknown; name?: string}>;
  tools: Array<{
    function: {
      name: string;
      parameters: {
        required?: string[];
        properties?: Record<string, {minLength?: number; maxLength?: number}>;
      };
    };
  }>;
}

type Output = string | {name: string; arguments: Record<string, unknown>};

function reply(response: ServerResponse, model: string, output: Output) {
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
      model,
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
  assert.equal(typeof content, 'string', 'Expected an SDK tool result');
  return JSON.parse(content as string) as T;
}

function records(request: ProviderRequest): AgentRecord[] {
  return lastToolResult<{agents: AgentRecord[]}>(request).agents;
}

void test(
  'Pi parent handovers replace the runtime twice while live workers, queued work and notifications survive',
  {timeout: 45000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-parent-sdk-'));
    const cwd = join(directory, 'project');
    const agentDir = join(directory, 'config');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const originalTask =
      'ORIGINAL PARENT TASK: run the requested workflow with automatic handovers.';
    const originalContext = 'ORIGINAL PARENT TOOL OUTPUT: private old context.';
    const firstHandover =
      'FIRST PARENT HANDOVER: continue the requested ongoing workflow; retain the workers, collect progress, then hand over again.';
    const secondHandover =
      'SECOND PARENT HANDOVER: finish the requested workflow and collect the existing workers.';
    const queuedBeforeFirst = 'WORK QUEUED BEFORE FIRST HANDOVER';
    const queuedByFirst = 'WORK QUEUED BY FIRST FRESH PARENT';
    const queuedBeforeSecond = 'WORK QUEUED BEFORE SECOND HANDOVER';
    const queuedBySecond = 'WORK QUEUED BY SECOND FRESH PARENT';
    const firstWorkerMessage = 'LIVE WORKER REPORT TO FIRST FRESH PARENT';
    const secondWorkerMessage = 'LIVE WORKER REPORT TO SECOND FRESH PARENT';
    const completionOutput = 'FINISHER COMPLETED DURING PARENT TRANSITION';

    const liveStarted = Promise.withResolvers<void>();
    const finisherStarted = Promise.withResolvers<void>();
    const transitionStarted = Promise.withResolvers<void>();
    const completionObserved = Promise.withResolvers<void>();
    const finishLiveInitialTask = Promise.withResolvers<void>();
    const secondQueuedTaskStarted = Promise.withResolvers<void>();
    const finishSecondQueuedTask = Promise.withResolvers<void>();
    const replacementFinished = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    const finished = Promise.withResolvers<void>();
    const failed = Promise.withResolvers<never>();
    void failed.promise.catch(() => {});
    const gates = [
      liveStarted,
      finisherStarted,
      transitionStarted,
      completionObserved,
      finishLiveInitialTask,
      secondQueuedTaskStarted,
      finishSecondQueuedTask,
      ...replacementFinished,
    ];
    const errors: unknown[] = [];
    function fail(error: unknown) {
      errors.push(error);
      failed.reject(error);
      for (const gate of gates) gate.resolve();
    }

    let runtime: AgentSessionRuntime | undefined;
    let initialPrompt: Promise<void> | undefined;
    let cleaningUp = false;
    let parentFinished = false;
    let liveId = '';
    let finisherId = '';
    let liveBefore: AgentRecord;
    let finisherBefore: AgentRecord;
    let finalWorkers: AgentRecord[] = [];
    const sessions: AgentSession[] = [];
    const loaders: unknown[] = [];
    const registrations: unknown[] = [];
    const operations: Promise<unknown>[] = [];
    const parentRequests: ProviderRequest[][] = [[], [], []];
    const workerRequests: ProviderRequest[] = [];
    const executedTools: string[][] = [[], [], []];
    const notifications: Array<{
      sessionId: string;
      customType: string;
      content: unknown;
    }> = [];
    const archived: string[] = [];

    function assertSameWorker(record: AgentRecord, previous: AgentRecord) {
      for (const field of [
        'id',
        'createdAt',
        'startedAt',
        'sessionFile',
        'resultFile',
        'sessionCount',
      ] as const) {
        assert.equal(record[field], previous[field], `Worker ${field} changed`);
      }
      assert.equal(
        record.sessionCount,
        1,
        'A parent handover must retain the worker session',
      );
      assert.equal(record.error, undefined);
    }

    async function respondToWorker(input: ProviderRequest): Promise<Output> {
      workerRequests.push(input);
      const users = input.messages.filter(message => message.role === 'user');
      const firstUser = JSON.stringify(users[0]?.content);
      assert.match(firstUser, /LIVE INITIAL TASK|FINISHER INITIAL TASK/);
      if (firstUser.includes('FINISHER INITIAL TASK')) {
        assert.equal(users.length, 1);
        finisherStarted.resolve();
        await transitionStarted.promise;
        return completionOutput;
      }
      const lastUser = JSON.stringify(users.at(-1)?.content);
      const lastMessage = input.messages.at(-1);
      if (users.length === 1) {
        if (lastMessage?.role !== 'tool') {
          liveStarted.resolve();
          await transitionStarted.promise;
          return {name: 'agent_list', arguments: {view: 'all'}};
        }
        const discovery = lastToolResult<{
          selfId: string;
          agents: AgentRecord[];
        }>(input);
        assert.equal(discovery.selfId, liveId);
        assert.deepEqual(
          discovery.agents.map(agent => agent.id).sort(),
          [liveId, finisherId].sort(),
        );
        const peer = discovery.agents.find(agent => agent.id === finisherId)!;
        assert.ok(['running', 'completed'].includes(peer.status));
        if (peer.status !== 'completed') {
          // Observe actual orchestrator completion through a live worker's SDK tool.
          // The parent factory remains gated until this confirms the notification was buffered.
          return {name: 'agent_list', arguments: {view: 'all'}};
        }
        assert.equal(
          sessions.length,
          1,
          'Completion must occur between parent runtimes',
        );
        assert.equal(
          notifications.length,
          0,
          'Detached parent must buffer completion',
        );
        completionObserved.resolve();
        await finishLiveInitialTask.promise;
        return 'LIVE INITIAL TASK COMPLETE';
      }
      assert.match(
        JSON.stringify(input.messages),
        /LIVE INITIAL TASK COMPLETE/,
      );
      if (lastUser.includes(queuedBeforeFirst)) {
        assert.equal(users.length, 2);
        if (lastMessage?.role === 'tool') {
          assert.deepEqual(lastToolResult(input), {
            recipient: 'parent',
            delivered: true,
          });
          return 'FIRST QUEUED WORK COMPLETE';
        }
        return {
          name: 'agent_send',
          arguments: {id: 'parent', message: firstWorkerMessage},
        };
      }
      if (lastUser.includes(queuedByFirst)) {
        assert.equal(users.length, 3);
        if (lastMessage?.role === 'tool') {
          assert.deepEqual(lastToolResult(input), {
            recipient: 'parent',
            delivered: true,
          });
          return 'SECOND QUEUED WORK COMPLETE';
        }
        secondQueuedTaskStarted.resolve();
        await finishSecondQueuedTask.promise;
        return {
          name: 'agent_send',
          arguments: {id: 'parent', message: secondWorkerMessage},
        };
      }
      if (lastUser.includes(queuedBeforeSecond)) {
        assert.equal(users.length, 4);
        return 'THIRD QUEUED WORK COMPLETE';
      }
      assert.ok(lastUser.includes(queuedBySecond));
      assert.equal(users.length, 5);
      return 'ALL LIVE WORKER TASKS COMPLETE';
    }

    async function respondToParent(input: ProviderRequest): Promise<Output> {
      assert.equal(
        input.model,
        'parent-model',
        'The selected parent model must be restored',
      );
      const conversation = input.messages.filter(
        message => !['system', 'developer'].includes(message.role),
      );
      const firstUser = JSON.stringify(conversation[0]?.content);
      const phase = firstUser.includes(originalTask)
        ? 0
        : firstUser.includes(firstHandover)
          ? 1
          : firstUser.includes(secondHandover)
            ? 2
            : assert.fail(`Unexpected first fresh prompt: ${firstUser}`);
      parentRequests[phase].push(input);
      const step = parentRequests[phase].length;
      if (step === 1) {
        assert.equal(
          conversation.length,
          1,
          'First provider request must contain only the handover and system instructions',
        );
        assert.equal(conversation[0].role, 'user');
        const system = JSON.stringify(
          input.messages.filter(message =>
            ['system', 'developer'].includes(message.role),
          ),
        );
        assert.match(system, /PROJECT PARENT INSTRUCTION/);
        assert.match(system, /session_new/);
        assert.match(system, /last tool call/i);
        assert.match(system, /ordinary tasks.*current session/i);
        const tool = input.tools.find(
          tool => tool.function.name === 'session_new',
        )!;
        assert.ok(tool, 'Fresh resource loaders must register session_new');
        assert.deepEqual(tool.function.parameters.required, ['handover']);
        assert.equal(
          tool.function.parameters.properties?.handover.minLength,
          1,
        );
        assert.equal(
          tool.function.parameters.properties?.handover.maxLength,
          64000,
        );
        assert.equal(runtime!.session.thinkingLevel, 'high');
        if (phase > 0) {
          assert.doesNotMatch(
            JSON.stringify(input.messages),
            /ORIGINAL PARENT TASK|ORIGINAL PARENT TOOL OUTPUT|OUTGOING PARENT ANSWER/,
          );
          if (phase === 2) {
            assert.doesNotMatch(
              JSON.stringify(input.messages),
              /FIRST PARENT HANDOVER|FIRST FRESH PARENT TOOL CONTEXT|FINISHER COMPLETED DURING PARENT TRANSITION/,
            );
          }
          // withSession must return while the new model response is still pending.
          await replacementFinished[phase - 1].promise;
        }
      }
      if (phase === 0) {
        switch (step) {
          case 1:
            return {name: 'read', arguments: {path: 'original.txt'}};
          case 2:
            assert.ok(JSON.stringify(input.messages).includes(originalContext));
            return {
              name: 'agent_spawn',
              arguments: {
                name: 'Live',
                task: 'LIVE INITIAL TASK',
                model: 'varisdev-parent-test/worker-model',
                notify: false,
                timeoutMs: 30000,
              },
            };
          case 3:
            liveId = records(input)[0].id;
            return {
              name: 'agent_spawn',
              arguments: {
                name: 'Finisher',
                task: 'FINISHER INITIAL TASK',
                model: 'varisdev-parent-test/worker-model',
                notify: true,
                timeoutMs: 30000,
              },
            };
          case 4:
            finisherId = records(input)[0].id;
            await Promise.all([liveStarted.promise, finisherStarted.promise]);
            return {
              name: 'agent_send',
              arguments: {id: liveId, message: queuedBeforeFirst},
            };
          case 5:
            assert.equal(records(input)[0].pendingMessages, 1);
            return {name: 'agent_status', arguments: {id: liveId}};
          case 6:
            liveBefore = records(input)[0];
            assert.equal(liveBefore.status, 'running');
            assert.ok(liveBefore.sessionFile);
            return {name: 'agent_status', arguments: {id: finisherId}};
          case 7:
            finisherBefore = records(input)[0];
            assert.equal(finisherBefore.status, 'running');
            assert.ok(finisherBefore.sessionFile);
            return {name: 'session_new', arguments: {handover: firstHandover}};
          default:
            return 'OUTGOING PARENT ANSWER';
        }
      }
      if (phase === 1) {
        switch (step) {
          case 1:
            return {name: 'agent_list', arguments: {view: 'all'}};
          case 2: {
            const listed = records(input);
            assert.deepEqual(
              listed.map(agent => agent.id).sort(),
              [liveId, finisherId].sort(),
            );
            assert.equal(
              listed.find(agent => agent.id === liveId)?.status,
              'running',
            );
            assert.equal(
              listed.find(agent => agent.id === liveId)?.pendingMessages,
              1,
            );
            assert.equal(
              listed.find(agent => agent.id === finisherId)?.status,
              'completed',
            );
            return {name: 'agent_status', arguments: {id: liveId}};
          }
          case 3:
            assertSameWorker(records(input)[0], liveBefore);
            return {
              name: 'agent_send',
              arguments: {id: liveId, message: queuedByFirst},
            };
          case 4:
            assert.equal(records(input)[0].pendingMessages, 2);
            finishLiveInitialTask.resolve();
            await secondQueuedTaskStarted.promise;
            return {
              name: 'agent_wait',
              arguments: {ids: [liveId], timeoutMs: 0},
            };
          case 5:
            assertSameWorker(records(input)[0], liveBefore);
            assert.equal(records(input)[0].status, 'running');
            return {name: 'read', arguments: {path: 'first-fresh.txt'}};
          case 6:
            assert.match(
              JSON.stringify(input.messages),
              /FIRST FRESH PARENT TOOL CONTEXT/,
            );
            return {
              name: 'agent_send',
              arguments: {id: liveId, message: queuedBeforeSecond},
            };
          case 7:
            assert.equal(records(input)[0].pendingMessages, 1);
            return {name: 'session_new', arguments: {handover: secondHandover}};
          default:
            return 'FIRST FRESH PARENT OUTGOING ANSWER';
        }
      }
      switch (step) {
        case 1:
          return {name: 'agent_list', arguments: {view: 'all'}};
        case 2:
          assert.deepEqual(
            records(input)
              .map(agent => agent.id)
              .sort(),
            [liveId, finisherId].sort(),
          );
          assert.equal(
            records(input).find(agent => agent.id === liveId)?.pendingMessages,
            1,
          );
          return {name: 'agent_status', arguments: {id: liveId}};
        case 3:
          assertSameWorker(records(input)[0], liveBefore);
          assert.equal(records(input)[0].status, 'running');
          return {
            name: 'agent_send',
            arguments: {id: liveId, message: queuedBySecond},
          };
        case 4:
          assert.equal(records(input)[0].pendingMessages, 2);
          finishSecondQueuedTask.resolve();
          return {
            name: 'agent_wait',
            arguments: {ids: [liveId, finisherId], timeoutMs: 10000},
          };
        case 5:
          finalWorkers = records(input);
          assert.deepEqual(
            finalWorkers.map(agent => agent.status),
            ['completed', 'completed'],
          );
          assertSameWorker(finalWorkers[0], liveBefore);
          assertSameWorker(finalWorkers[1], finisherBefore);
          assert.equal(
            finalWorkers[0].output,
            'ALL LIVE WORKER TASKS COMPLETE',
          );
          assert.equal(finalWorkers[1].output, completionOutput);
          parentFinished = true;
          return 'PARENT WORKFLOW COMPLETE';
        default:
          return 'Worker notifications acknowledged.';
      }
    }

    const server = createServer(async (request, response) => {
      try {
        let body = '';
        for await (const chunk of request) body += chunk;
        const input = JSON.parse(body) as ProviderRequest;
        response.on('close', () => {
          if (!response.writableFinished && !cleaningUp) {
            fail(
              new Error(`A live ${input.model} provider request was cancelled`),
            );
          }
        });
        const output = cleaningUp
          ? 'Cleanup.'
          : await (input.model === 'worker-model'
              ? respondToWorker(input)
              : respondToParent(input));
        reply(response, input.model, output);
      } catch (error) {
        fail(error);
        reply(
          response,
          'parent-model',
          `Provider fixture failed: ${String(error)}`,
        );
      }
    });
    t.after(async () => {
      cleaningUp = true;
      for (const gate of gates) gate.resolve();
      await initialPrompt?.catch(() => {});
      initialPrompt = undefined;
      await Promise.allSettled(operations);
      await runtime?.dispose();
      runtime = undefined;
      server.closeAllConnections();
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
      'PROJECT PARENT INSTRUCTION: report findings and preserve other agents’ work.',
    );
    await writeFile(join(cwd, 'original.txt'), originalContext);
    await writeFile(
      join(cwd, 'first-fresh.txt'),
      'FIRST FRESH PARENT TOOL CONTEXT',
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const createRuntime: CreateAgentSessionRuntimeFactory = async options => {
      const phase = sessions.length;
      if (phase > 0) {
        assert.equal(options.sessionStartEvent?.reason, 'new');
        archived.push(await readFile(sessions[phase - 1].sessionFile!, 'utf8'));
      }
      if (phase === 1) {
        transitionStarted.resolve();
        await completionObserved.promise;
      }
      const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, 'auth.json'),
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      modelRuntime.registerProvider('varisdev-parent-test', {
        api: 'openai-completions',
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        apiKey: 'local-test-key',
        models: ['parent-model', 'worker-model', 'default-model'].map(id => ({
          id,
          name: id,
          reasoning: true,
          input: ['text'],
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          contextWindow: 128000,
          maxTokens: 1000,
        })),
      });
      const services = await createAgentSessionServices({
        cwd: options.cwd,
        agentDir: options.agentDir,
        modelRuntime,
        settingsManager: SettingsManager.inMemory({
          compaction: {enabled: false},
          retry: {enabled: false},
        }),
        resourceLoaderOptions: {
          noExtensions: true,
          noThemes: true,
          noSkills: true,
          noPromptTemplates: true,
          extensionFactories: [
            pi => {
              registrations.push(pi);
              const control = registerAgentTools(pi);
              registerSessionNewTool(pi, control);
            },
          ],
        },
      });
      assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
      loaders.push(services.resourceLoader);
      const created = await createAgentSessionFromServices({
        services,
        sessionManager: options.sessionManager,
        sessionStartEvent: options.sessionStartEvent,
        model: modelRuntime.getModel(
          'varisdev-parent-test',
          phase === 0 ? 'parent-model' : 'default-model',
        ),
        thinkingLevel: phase === 0 ? 'high' : 'off',
      });
      const {session} = created;
      sessions.push(session);
      session.subscribe(event => {
        if (event.type === 'tool_execution_start')
          executedTools[phase].push(event.toolName);
        if (event.type === 'tool_execution_end' && event.isError)
          fail(event.result);
        if (event.type === 'message_end' && event.message.role === 'custom') {
          notifications.push({
            sessionId: session.sessionId,
            customType: event.message.customType,
            content: event.message.content,
          });
        }
        if (event.type === 'agent_settled' && phase === 2 && parentFinished)
          finished.resolve();
      });
      return {...created, services, diagnostics: services.diagnostics};
    };
    runtime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir,
      sessionManager: SessionManager.create(cwd, join(directory, 'sessions')),
    });
    async function bind(session: AgentSession) {
      await session.bindExtensions({
        mode: 'print',
        onError: fail,
        commandContextActions: {
          waitForIdle: () => session.waitForIdle(),
          newSession: options => {
            if (cleaningUp) return Promise.resolve({cancelled: true});
            const phase = sessions.indexOf(session);
            const operation = runtime!.newSession(options);
            operations.push(operation);
            void operation.then(
              () => replacementFinished[phase].resolve(),
              fail,
            );
            return operation;
          },
          fork: async () => ({cancelled: true}),
          navigateTree: async () => ({cancelled: true}),
          switchSession: async () => ({cancelled: true}),
          reload: async () => {},
        },
      });
    }
    runtime.setRebindSession(bind);
    await bind(runtime.session);
    // The first and only manually submitted prompt is an ordinary user task.
    // session_new must obtain its command context through Pi's real dispatcher.
    initialPrompt = runtime.session.prompt(originalTask);
    void initialPrompt.catch(fail);
    await Promise.race([finished.promise, failed.promise]);
    await Promise.all(operations);
    await initialPrompt;
    await runtime.session.waitForIdle();
    assert.deepEqual(errors, []);
    assert.equal(sessions.length, 3);
    assert.equal(new Set(sessions).size, 3);
    assert.equal(new Set(loaders).size, 3);
    assert.equal(new Set(registrations).size, 3);
    assert.equal(new Set(sessions.map(session => session.sessionId)).size, 3);
    assert.equal(runtime.session, sessions[2]);
    assert.equal(runtime.session.model?.id, 'parent-model');
    assert.equal(runtime.session.thinkingLevel, 'high');
    assert.equal(executedTools[0].at(-1), 'session_new');
    assert.equal(executedTools[1].at(-1), 'session_new');
    assert.ok(
      workerRequests.length >= 8,
      'Queued tasks must reach the real worker provider',
    );

    const paths = sessions.map(session => session.sessionFile!);
    assert.equal(new Set(paths).size, 3);
    const transcripts = await Promise.all(
      paths.map(path => readFile(path, 'utf8')),
    );
    assert.deepEqual(
      transcripts.slice(0, 2),
      archived,
      'Outgoing transcripts must remain persisted and unchanged',
    );
    const headers = transcripts.map(
      text =>
        JSON.parse(text.split('\n')[0]) as {
          type: string;
          id: string;
          parentSession?: string;
        },
    );
    assert.deepEqual(
      headers.map(header => header.id),
      sessions.map(session => session.sessionId),
    );
    assert.ok(headers.every(header => header.type === 'session'));
    assert.equal(headers[1].parentSession, paths[0]);
    assert.equal(headers[2].parentSession, paths[1]);
    assert.ok(transcripts[0].includes(originalTask));
    assert.ok(transcripts[0].includes(originalContext));
    assert.ok(transcripts[1].includes(firstHandover));
    assert.ok(transcripts[2].includes(secondHandover));
    assert.doesNotMatch(
      transcripts[1],
      /ORIGINAL PARENT TASK|ORIGINAL PARENT TOOL OUTPUT/,
    );
    assert.doesNotMatch(
      transcripts[2],
      /ORIGINAL PARENT TASK|ORIGINAL PARENT TOOL OUTPUT|FIRST PARENT HANDOVER|FIRST FRESH PARENT TOOL CONTEXT/,
    );

    const completionMessages = notifications.filter(
      message => message.customType === 'agent_result',
    );
    assert.equal(
      completionMessages.length,
      1,
      'Completion buffered during replacement must be delivered exactly once',
    );
    assert.equal(completionMessages[0].sessionId, sessions[1].sessionId);
    assert.ok(
      JSON.stringify(completionMessages[0].content).includes(completionOutput),
    );
    const workerMessages = notifications.filter(
      message => message.customType === 'agent_message',
    );
    assert.equal(workerMessages.length, 2);
    for (const [index, marker] of [
      firstWorkerMessage,
      secondWorkerMessage,
    ].entries()) {
      const message = workerMessages[index];
      assert.equal(message.sessionId, sessions[index + 1].sessionId);
      assert.ok(JSON.stringify(message.content).includes(marker));
      assert.ok(JSON.stringify(message.content).includes(liveId));
    }
    assert.equal(
      await readFile(finalWorkers[0].resultFile!, 'utf8'),
      'ALL LIVE WORKER TASKS COMPLETE',
    );
    const workerTranscript = await readFile(
      finalWorkers[0].sessionFile!,
      'utf8',
    );
    const userMessages = workerTranscript
      .trim()
      .split('\n')
      .map(
        line =>
          JSON.parse(line) as {message?: {role: string; content: unknown}},
      )
      .filter(entry => entry.message?.role === 'user')
      .map(entry => JSON.stringify(entry.message!.content));
    const expected = [
      'LIVE INITIAL TASK',
      queuedBeforeFirst,
      queuedByFirst,
      queuedBeforeSecond,
      queuedBySecond,
    ];
    assert.equal(userMessages.length, expected.length);
    for (const [index, message] of expected.entries())
      assert.ok(userMessages[index].includes(message));
  },
);
