import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
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
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import {createHandoverAgent} from '../src/handover-agent.ts';
import {registerAutoHandover} from '../src/auto-handover.ts';
import type {AgentRecord, AgentWorker} from '../src/agents/orchestrator.ts';
import type {AgentSessionController} from '../src/agents/team.ts';
import {createSessionWorker} from '../src/agents/session.ts';
import {registerAgentTools} from '../src/tools/agents.ts';
import {registerSessionHandover} from '../src/session-handover.ts';

interface ProviderRequest {
  model: string;
  reasoning_effort?: string;
  messages: Array<{role: string; content: unknown}>;
  tools: Array<{function: {name: string}}>;
}
type Output = string | {name: string; arguments: Record<string, unknown>};

function reply(response: ServerResponse, output: Output, tokens = 500) {
  const toolCall = typeof output !== 'string';
  response.writeHead(200, {'content-type': 'text/event-stream'});
  response.end(
    `data: ${JSON.stringify({
      id: 'completion',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'parent-model',
      choices: [
        {
          index: 0,
          delta: toolCall
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
            : {role: 'assistant', content: output},
          finish_reason: toolCall ? 'tool_calls' : 'stop',
        },
      ],
      usage: {
        prompt_tokens: tokens - 77,
        completion_tokens: 77,
        total_tokens: tokens,
        prompt_tokens_details: {cached_tokens: 111},
      },
    })}\n\ndata: [DONE]\n\n`,
  );
}

function records(request: ProviderRequest): AgentRecord[] {
  const content = request.messages.findLast(
    message => message.role === 'tool',
  )?.content;
  assert.equal(typeof content, 'string');
  return (JSON.parse(content as string) as {agents: AgentRecord[]}).agents;
}

void test(
  'Pi summarizes at 90%, transfers already waiting notifications, and preserves live workers',
  {timeout: 30000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-auto-sdk-'));
    const cwd = join(directory, 'project');
    const agentDir = join(directory, 'config');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const originalTask = 'ORIGINAL TASK: carry out the requested file review.';
    const verified = 'VERIFIED PLAN: review draft.txt; validation is pending.';
    const handover = `HANDOVER FROM DEDICATED AGENT: ${verified}`;
    const workerTask = 'WORKER TASK: inspect worker.txt and report findings.';
    const notification = 'CANCELLED WORKER: notification waiting before pause.';
    const duringSummary =
      'WORKER RESULT: completed during summary preparation.';
    const workerStarted = Promise.withResolvers<void>();
    const finishWorker = Promise.withResolvers<void>();
    const replacementReady = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const failed = Promise.withResolvers<never>();
    void failed.promise.catch(() => {});
    const errors: unknown[] = [];
    function fail(error: unknown) {
      errors.push(error);
      failed.reject(error);
      workerStarted.resolve();
      finishWorker.resolve();
      replacementReady.resolve();
    }

    let runtime: AgentSessionRuntime | undefined;
    let cleaningUp = false;
    let workerId = '';
    let workerBefore: AgentRecord;
    const sessions: AgentSession[] = [];
    const workers: AgentWorker[] = [];
    const requests: ProviderRequest[][] = [[], []];
    const workerRequests: ProviderRequest[] = [];
    const summaryRequests: ProviderRequest[] = [];
    let summaryDisposed = false;
    const tools: string[][] = [[], []];
    const events: AgentSessionEvent[] = [];
    const automaticMessages: string[] = [];
    const workingMessages: Array<string | undefined> = [];
    const operations: Promise<unknown>[] = [];
    let boundaryPercent: number | null | undefined;

    async function respond(input: ProviderRequest): Promise<{
      output: Output;
      tokens?: number;
    }> {
      assert.doesNotMatch(
        JSON.stringify(input.messages),
        /You are a context summarization assistant/,
        'Native compaction must never reach the provider',
      );
      if (input.model === 'worker-model') {
        workerRequests.push(input);
        assert.ok(
          !input.tools.some(
            tool => tool.function.name === 'session_handover_status',
          ),
        );
        if (workerRequests.length === 1) {
          assert.match(JSON.stringify(input.messages), /WORKER TASK/);
          return {
            output: {name: 'read', arguments: {path: 'worker.txt'}},
            tokens: 57600,
          };
        }
        assert.equal(workerRequests.length, 2);
        const conversation = input.messages.filter(
          message => !['system', 'developer'].includes(message.role),
        );
        assert.deepEqual(
          conversation.map(message => message.role),
          ['user', 'assistant', 'tool'],
          'A worker at 90% must continue without an automatic steering message',
        );
        assert.match(
          JSON.stringify(conversation.at(-1)),
          /WORKER FILE EVIDENCE/,
        );
        workerStarted.resolve();
        await finishWorker.promise;
        return {output: 'WORKER REVIEW COMPLETE'};
      }

      if (input.model === 'gpt-5.6-sol') {
        summaryRequests.push(input);
        assert.equal(input.reasoning_effort, 'high');
        assert.deepEqual(input.tools.map(tool => tool.function.name).sort(), [
          'find',
          'grep',
          'ls',
          'read',
        ]);
        const text = JSON.stringify(input.messages);
        assert.match(text, /session handover agent/);
        assert.match(text, /PROJECT REVIEW INSTRUCTION/);
        switch (summaryRequests.length) {
          case 1: {
            const instructions = JSON.stringify(
              input.messages.filter(message =>
                ['system', 'developer'].includes(message.role),
              ),
            );
            assert.doesNotMatch(instructions, /expert coding assistant/);
            assert.doesNotMatch(instructions, /implementation-skill-marker/);
            assert.ok(
              workingMessages.some(message =>
                message?.includes('Starting summary agent'),
              ),
            );
            const content = input.messages.at(-1)!.content;
            const prompt =
              typeof content === 'string'
                ? content
                : (content as Array<{text: string}>)
                    .map(part => part.text)
                    .join('\n');
            const path = JSON.parse(
              prompt.match(/snapshot at (".*?")\./)![1],
            ) as string;
            return {output: {name: 'read', arguments: {path}}};
          }
          case 2:
            assert.ok(
              workingMessages.some(message => message?.includes('Using read')),
            );
            assert.match(text, /ORIGINAL TASK|EXACT CONTEXT BOUNDARY/);
            assert.ok(text.includes(workerId));
            return {
              output: {name: 'read', arguments: {path: 'checkpoint.txt'}},
            };
          case 3:
            assert.ok(text.includes(verified));
            return {output: handover};
          default:
            assert.fail('Unexpected summarizer turn');
        }
      }

      assert.equal(input.model, 'parent-model');
      const conversation = input.messages.filter(
        message => !['system', 'developer'].includes(message.role),
      );
      const fresh = JSON.stringify(conversation[0]?.content).includes(handover);
      const phase = fresh ? 1 : 0;
      requests[phase].push(input);
      assert.equal(runtime!.session.thinkingLevel, 'high');
      if (!fresh) {
        switch (requests[0].length) {
          case 1:
            return {
              output: {
                name: 'agent_spawn',
                arguments: {
                  name: 'Reviewer',
                  task: workerTask,
                  model: 'auto-handover-sdk/worker-model',
                  notify: false,
                },
              },
            };
          case 2:
            workerId = records(input)[0].id;
            await workerStarted.promise;
            return {output: {name: 'agent_status', arguments: {id: workerId}}};
          case 3:
            workerBefore = records(input)[0];
            assert.equal(workerBefore.status, 'running');
            return {
              output: 'BELOW CHECKPOINT: review is ongoing.',
              tokens: 57599,
            };
          case 4:
            assert.equal(automaticMessages.length, 0);
            return {output: 'EXACT CONTEXT BOUNDARY', tokens: 57600};
          case 5:
            assert.equal(boundaryPercent, 90);
            assert.equal(automaticMessages.length, 1);
            assert.match(
              automaticMessages[0],
              /dedicated Codex GPT-5\.6 Sol agent with high reasoning/,
            );
            assert.match(
              JSON.stringify(conversation.at(-1)),
              /Context usage has reached 90.0%/,
            );
            return {
              output: 'Parent paused for the summarizing agent.',
              tokens: 57600,
            };
          default:
            assert.fail(
              'The old parent must stop after acknowledging the pause',
            );
        }
      }
      switch (requests[1].length) {
        case 1:
          assert.equal(conversation.length, 1);
          assert.equal(conversation[0].role, 'user');
          assert.ok(JSON.stringify(conversation[0].content).includes(handover));
          assert.match(
            JSON.stringify(input.messages),
            /PROJECT REVIEW INSTRUCTION/,
          );
          assert.doesNotMatch(
            JSON.stringify(input.messages),
            /ORIGINAL TASK|PRIVATE TOOL OUTPUT|BELOW CHECKPOINT|EXACT CONTEXT BOUNDARY|Context usage has reached/,
          );
          assert.ok(
            input.tools.some(
              tool => tool.function.name === 'session_handover_status',
            ),
          );
          assert.equal(summaryDisposed, true);
          assert.equal(workingMessages.at(-1), '');
          await replacementReady.promise;
          return {output: {name: 'agent_status', arguments: {id: workerId}}};
        case 2: {
          const worker = records(input)[0];
          for (const field of [
            'id',
            'createdAt',
            'startedAt',
            'sessionFile',
            'resultFile',
            'sessionCount',
          ] as const) {
            assert.equal(
              worker[field],
              workerBefore[field],
              `Worker ${field} changed`,
            );
          }
          assert.equal(worker.status, 'running');
          assert.equal(worker.sessionCount, 1);
          finishWorker.resolve();
          return {
            output: {
              name: 'agent_wait',
              arguments: {ids: [workerId], timeoutMs: 10000},
            },
          };
        }
        case 3:
          assert.equal(records(input)[0].status, 'completed');
          assert.equal(records(input)[0].output, 'WORKER REVIEW COMPLETE');
          assert.ok(!JSON.stringify(conversation).includes(notification));
          return {output: 'FRESH PARENT REVIEW COMPLETE'};
        case 4:
          assert.ok(JSON.stringify(conversation.at(-1)).includes(notification));
          return {output: 'FRESH PARENT RECEIVED WAITING NOTIFICATION'};
        case 5:
          assert.ok(
            JSON.stringify(conversation.at(-1)).includes(duringSummary),
          );
          return {output: 'FRESH PARENT RECEIVED SUMMARY-TIME NOTIFICATION'};
        default:
          assert.fail('Unexpected fresh parent response');
      }
    }

    const server = createServer(async (request, response) => {
      try {
        let body = '';
        for await (const chunk of request) body += chunk;
        const input = JSON.parse(body) as ProviderRequest;
        response.on('close', () => {
          if (!response.writableFinished && !cleaningUp)
            fail(new Error(`Cancelled live ${input.model} request`));
        });
        const next = cleaningUp ? {output: 'Cleanup'} : await respond(input);
        reply(response, next.output, next.tokens);
      } catch (error) {
        fail(error);
        response.writeHead(500);
        response.end(String(error));
      }
    });
    t.after(async () => {
      cleaningUp = true;
      workerStarted.resolve();
      finishWorker.resolve();
      replacementReady.resolve();
      await runtime?.session.abort();
      await Promise.allSettled(operations);
      await runtime?.dispose();
      runtime = undefined;
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, {recursive: true, force: true});
    });
    await mkdir(cwd, {recursive: true});
    await mkdir(join(agentDir, 'skills', 'implementation'), {recursive: true});
    await writeFile(
      join(agentDir, 'skills', 'implementation', 'SKILL.md'),
      '---\nname: implementation\ndescription: implementation-skill-marker\n---\nContinue implementation until the task is complete.',
    );
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({compaction: {enabled: false}, retry: {enabled: false}}),
    );
    await writeFile(
      join(cwd, 'AGENTS.md'),
      'PROJECT REVIEW INSTRUCTION: verify current files before continuing.',
    );
    await writeFile(
      join(cwd, 'checkpoint.txt'),
      `${verified}\nPRIVATE TOOL OUTPUT`,
    );
    await writeFile(join(cwd, 'worker.txt'), 'WORKER FILE EVIDENCE');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const createRuntime: CreateAgentSessionRuntimeFactory = async options => {
      const phase = sessions.length;
      assert.ok(phase < 2, 'Only one parent replacement is expected');
      const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, 'auth.json'),
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      modelRuntime.registerProvider('auto-handover-sdk', {
        api: 'openai-completions',
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        apiKey: 'local-test-key',
        models: ['parent-model', 'worker-model', 'default-model'].map(id => ({
          id,
          name: id,
          reasoning: true,
          input: ['text'],
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          contextWindow: 64000,
          maxTokens: 1000,
        })),
      });
      modelRuntime.registerProvider('openai-codex', {
        api: 'openai-completions',
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        apiKey: 'local-codex-test-key',
        models: [
          {
            id: 'gpt-5.6-sol',
            name: 'Codex GPT-5.6 Sol',
            reasoning: true,
            input: ['text'],
            cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
            contextWindow: 128000,
            maxTokens: 1000,
            compat: {supportsReasoningEffort: true},
          },
        ],
      });
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        modelRuntime,
        settingsManager: SettingsManager.inMemory({
          compaction: {
            enabled: true,
            reserveTokens: 16000,
            keepRecentTokens: 48,
          },
          retry: {enabled: false},
        }),
        resourceLoaderOptions: {
          noExtensions: true,
          noThemes: true,
          noSkills: true,
          noPromptTemplates: true,
          extensionFactories: [
            pi => {
              const control = registerAgentTools(pi, async options => {
                const worker = await createSessionWorker(options);
                workers.push(worker);
                return worker;
              });
              const sessionControl = registerSessionHandover(pi, control);
              pi.on('turn_end', (event, ctx) => {
                if (
                  JSON.stringify(event.message).includes(
                    'EXACT CONTEXT BOUNDARY',
                  )
                ) {
                  boundaryPercent = ctx.getContextUsage()?.percent;
                  // A worker result can be waiting long before the pause request.
                  // Sending it straight to Pi's follow-up queue wakes the old
                  // parent after the summary and blocks the idle session switch.
                  (control as AgentSessionController).getTeam(ctx).sendMessage({
                    customType: 'agent_result',
                    content: notification,
                    display: true,
                    details: {},
                  });
                }
              });
              registerAutoHandover(pi, sessionControl, async (ctx, id) => {
                (control as AgentSessionController).getTeam(ctx).sendMessage({
                  customType: 'agent_result',
                  content: duringSummary,
                  display: true,
                  details: {},
                });
                const agent = await createHandoverAgent(ctx, id);
                const dispose = agent.worker.dispose;
                agent.worker.dispose = () => {
                  assert.equal(summaryDisposed, false);
                  summaryDisposed = true;
                  dispose();
                };
                return agent;
              });
            },
          ],
        },
      });
      assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
      const created = await createAgentSessionFromServices({
        services,
        sessionManager: options.sessionManager,
        sessionStartEvent: options.sessionStartEvent,
        model: modelRuntime.getModel(
          'auto-handover-sdk',
          phase === 0 ? 'parent-model' : 'default-model',
        ),
        thinkingLevel: phase === 0 ? 'high' : 'off',
      });
      sessions.push(created.session);
      created.session.subscribe(event => {
        events.push(event);
        if (event.type === 'tool_execution_start')
          tools[phase].push(event.toolName);
        if (event.type === 'tool_execution_end' && event.isError)
          fail(event.result);
        if (
          event.type === 'message_end' &&
          event.message.role === 'custom' &&
          event.message.customType === 'varisdev_handover_request'
        )
          automaticMessages.push(JSON.stringify(event.message.content));
        if (
          phase === 1 &&
          event.type === 'agent_settled' &&
          requests[1].length === 5
        )
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
        uiContext: {
          setWorkingMessage: (message?: string) =>
            workingMessages.push(message),
          setStatus: () => {},
          notify: (message: string, type?: string) => {
            if (type === 'error') fail(new Error(message));
          },
        } as unknown as ExtensionUIContext,
        onError: fail,
        commandContextActions: {
          waitForIdle: () => session.waitForIdle(),
          newSession: options => {
            const operation = runtime!.newSession(options);
            operations.push(operation);
            void operation.then(() => replacementReady.resolve(), fail);
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
    const first = runtime.session.prompt(originalTask);
    operations.push(first);
    await Promise.race([first, failed.promise]);
    assert.equal(requests[0].length, 3);
    assert.equal(automaticMessages.length, 0);
    assert.equal(runtime.session.getContextUsage()?.tokens, 57599);
    assert.ok(
      events.some(
        event =>
          event.type === 'compaction_end' &&
          event.reason === 'threshold' &&
          event.aborted,
      ),
    );
    const continued = runtime.session.prompt('Continue the review.');
    operations.push(continued);
    void continued.catch(fail);
    await Promise.race([finished.promise, failed.promise]);
    await Promise.all(operations);
    await runtime.session.waitForIdle();
    assert.deepEqual(errors, []);
    assert.equal(sessions.length, 2);
    assert.equal(
      requests[0].length,
      5,
      'The source stops at its acknowledgement',
    );
    assert.equal(requests[1].length, 5);
    const sourceEntries = sessions[0].sessionManager.getEntries();
    assert.ok(
      sourceEntries.some(
        entry =>
          entry.type === 'custom' &&
          entry.customType === 'varisdev_handover_draft' &&
          (entry.data as {handover: string}).handover === handover,
      ),
      'The saved draft remains available for display and recovery',
    );
    assert.ok(
      !sessions[0].messages.some(message =>
        JSON.stringify(message).includes(handover),
      ),
      'The continuation draft must not become source model context',
    );
    assert.equal(runtime.session, sessions[1]);
    assert.equal(runtime.session.model?.id, 'parent-model');
    assert.equal(runtime.session.thinkingLevel, 'high');
    assert.equal(automaticMessages.length, 1);
    assert.deepEqual(tools[0], ['agent_spawn', 'agent_status']);
    assert.equal(summaryRequests.length, 3);
    assert.equal(summaryDisposed, true);
    assert.deepEqual(tools[1], ['agent_status', 'agent_wait']);
    assert.equal(workers.length, 1);
    assert.equal(workerRequests.length, 2);
    for (const session of sessions)
      assert.equal(
        session.sessionManager
          .getEntries()
          .filter(entry => entry.type === 'compaction').length,
        0,
      );
  },
);
