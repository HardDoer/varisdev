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
} from '@earendil-works/pi-coding-agent';
import {registerAutoHandover} from '../src/auto-handover.ts';
import type {AgentRecord, AgentWorker} from '../src/agents/orchestrator.ts';
import {createSessionWorker} from '../src/agents/session.ts';
import {registerAgentTools} from '../src/tools/agents.ts';
import {registerSessionNewTool} from '../src/tools/session-new.ts';

interface ProviderRequest {
  model: string;
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
  'Pi steers the parent at exactly 80%, holds earlier native compaction, and resumes a fresh runtime with its live worker',
  {timeout: 30000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-auto-sdk-'));
    const cwd = join(directory, 'project');
    const agentDir = join(directory, 'config');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const originalTask = 'ORIGINAL TASK: carry out the requested file review.';
    const verified = 'VERIFIED PLAN: review draft.txt; validation is pending.';
    const handover = `HANDOVER FROM WORKING PARENT: ${verified}`;
    const workerTask = 'WORKER TASK: inspect worker.txt and report findings.';
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
    const tools: string[][] = [[], []];
    const events: AgentSessionEvent[] = [];
    const automaticMessages: string[] = [];
    const operations: Promise<unknown>[] = [];
    let boundaryPercent: number | null | undefined;

    async function respond(input: ProviderRequest): Promise<{
      output: Output;
      tokens?: number;
    }> {
      assert.doesNotMatch(
        JSON.stringify(input.messages),
        /You are a context summarization assistant/,
        'Native threshold compaction must wait for the parent checkpoint',
      );
      if (input.model === 'worker-model') {
        workerRequests.push(input);
        assert.ok(
          !input.tools.some(tool => tool.function.name === 'session_new'),
        );
        if (workerRequests.length === 1) {
          assert.match(JSON.stringify(input.messages), /WORKER TASK/);
          return {
            output: {name: 'read', arguments: {path: 'worker.txt'}},
            tokens: 51200,
          };
        }
        assert.equal(workerRequests.length, 2);
        const conversation = input.messages.filter(
          message => !['system', 'developer'].includes(message.role),
        );
        assert.deepEqual(
          conversation.map(message => message.role),
          ['user', 'assistant', 'tool'],
          'A worker at 80% must continue without an automatic steering message',
        );
        assert.match(
          JSON.stringify(conversation.at(-1)),
          /WORKER FILE EVIDENCE/,
        );
        workerStarted.resolve();
        await finishWorker.promise;
        return {output: 'WORKER REVIEW COMPLETE'};
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
              tokens: 50000,
            };
          case 4:
            assert.equal(automaticMessages.length, 0);
            return {output: 'EXACT CONTEXT BOUNDARY', tokens: 51200};
          case 5:
            assert.equal(boundaryPercent, 80);
            assert.equal(automaticMessages.length, 1);
            assert.match(automaticMessages[0], /final response/i);
            assert.match(
              automaticMessages[0],
              /harness handles the session change/i,
            );
            assert.match(automaticMessages[0], /verify|inspect|read/i);
            assert.match(
              JSON.stringify(conversation.at(-1)),
              /Context usage has reached 80\.0%/,
            );
            return {
              output: {name: 'read', arguments: {path: 'checkpoint.txt'}},
              tokens: 51200,
            };
          case 6:
            assert.equal(
              automaticMessages.length,
              1,
              'Steering must not repeat every turn',
            );
            assert.ok(JSON.stringify(conversation.at(-1)).includes(verified));
            return {output: handover, tokens: 51200};
          default:
            assert.fail('The old parent must finish with its handover');
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
            input.tools.some(tool => tool.function.name === 'session_new'),
          );
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
          return {output: 'FRESH PARENT REVIEW COMPLETE'};
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
    await mkdir(agentDir, {recursive: true});
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
              const sessionControl = registerSessionNewTool(pi, control);
              pi.on('turn_end', (event, ctx) => {
                if (
                  JSON.stringify(event.message).includes(
                    'EXACT CONTEXT BOUNDARY',
                  )
                )
                  boundaryPercent = ctx.getContextUsage()?.percent;
              });
              registerAutoHandover(pi, sessionControl);
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
        if (event.type === 'message_end' && event.message.role === 'custom')
          automaticMessages.push(JSON.stringify(event.message.content));
        if (phase === 1 && event.type === 'agent_settled') finished.resolve();
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
    assert.equal(runtime.session.getContextUsage()?.tokens, 50000);
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
    assert.equal(runtime.session, sessions[1]);
    assert.equal(runtime.session.model?.id, 'parent-model');
    assert.equal(runtime.session.thinkingLevel, 'high');
    assert.equal(automaticMessages.length, 1);
    assert.deepEqual(tools[0], ['agent_spawn', 'agent_status', 'read']);
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
