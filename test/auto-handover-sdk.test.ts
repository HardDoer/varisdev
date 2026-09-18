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
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
} from '@earendil-works/pi-coding-agent';
import {registerAutoHandover} from '../src/auto-handover.ts';

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
      model: 'review-model',
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

void test(
  'Pi requests handovers at 80%, holds earlier native compaction, and continues through two fresh runtimes',
  {timeout: 30000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-auto-sdk-'));
    const cwd = join(directory, 'project');
    const agentDir = join(directory, 'config');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const originalTask = 'ORIGINAL TASK: carry out the requested file review.';
    const verified = 'VERIFIED PLAN: review draft.txt; validation is pending.';
    const handovers = [
      `FIRST HANDOVER: ${verified}`,
      'SECOND HANDOVER: review and validation complete; report the results.',
    ];
    const finished = Promise.withResolvers<void>();
    const failed = Promise.withResolvers<never>();
    void failed.promise.catch(() => {});
    const errors: unknown[] = [];
    function fail(error: unknown) {
      errors.push(error);
      failed.reject(error);
    }

    let runtime: AgentSessionRuntime | undefined;
    let cleaningUp = false;
    const sessions: AgentSession[] = [];
    const requests: ProviderRequest[][] = [[], [], []];
    const tools: string[][] = [[], [], []];
    const activeTools = ['read', 'session_handover_status'];
    const events: AgentSessionEvent[] = [];
    const automaticMessages: string[] = [];
    const operations: Promise<unknown>[] = [];
    let boundaryPercent: number | null | undefined;

    function respond(input: ProviderRequest): {
      output: Output;
      tokens?: number;
    } {
      assert.doesNotMatch(
        JSON.stringify(input.messages),
        /You are a context summarization assistant/,
        'Native threshold compaction must wait for the handover checkpoint',
      );
      assert.equal(input.model, 'review-model');
      assert.deepEqual(
        input.tools.map(tool => tool.function.name).sort(),
        [...activeTools].sort(),
        'Active tools carry over to each fresh runtime',
      );
      assert.equal(runtime!.session.thinkingLevel, 'high');
      const conversation = input.messages.filter(
        message => !['system', 'developer'].includes(message.role),
      );
      const first = JSON.stringify(conversation[0]?.content);
      const phase = first.includes(handovers[1])
        ? 2
        : first.includes(handovers[0])
          ? 1
          : 0;
      requests[phase].push(input);
      if (phase === 0) {
        switch (requests[0].length) {
          case 1:
            return {output: {name: 'read', arguments: {path: 'draft.txt'}}};
          case 2:
            assert.match(
              JSON.stringify(conversation.at(-1)),
              /PRIVATE TOOL OUTPUT/,
            );
            return {
              output: 'BELOW CHECKPOINT: review is ongoing.',
              tokens: 50000,
            };
          case 3:
            assert.equal(automaticMessages.length, 0);
            return {output: 'EXACT CONTEXT BOUNDARY', tokens: 51200};
          case 4:
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
          case 5:
            assert.equal(
              automaticMessages.length,
              1,
              'Steering must not repeat every turn',
            );
            assert.ok(JSON.stringify(conversation.at(-1)).includes(verified));
            return {output: handovers[0], tokens: 51200};
          default:
            assert.fail('The source must finish with its handover');
        }
      }
      if (requests[phase].length === 1) {
        assert.equal(conversation.length, 1);
        assert.equal(conversation[0].role, 'user');
        assert.ok(first.includes(handovers[phase - 1]));
        assert.match(
          JSON.stringify(input.messages),
          /PROJECT REVIEW INSTRUCTION/,
        );
        assert.doesNotMatch(
          JSON.stringify(input.messages),
          /ORIGINAL TASK|PRIVATE TOOL OUTPUT|BELOW CHECKPOINT|EXACT CONTEXT BOUNDARY|Context usage has reached/,
        );
        if (phase === 1)
          return {
            output: {name: 'read', arguments: {path: 'validation.txt'}},
            tokens: 51200,
          };
        assert.doesNotMatch(
          JSON.stringify(input.messages),
          /FIRST HANDOVER|VALIDATION EVIDENCE/,
        );
        return {output: 'REVIEW COMPLETE'};
      }
      assert.equal(phase, 1);
      assert.equal(requests[phase].length, 2);
      assert.equal(automaticMessages.length, 2);
      assert.match(JSON.stringify(conversation), /VALIDATION EVIDENCE/);
      assert.match(
        JSON.stringify(conversation.at(-1)),
        /Context usage has reached 80\.0%/,
      );
      return {output: handovers[1], tokens: 51200};
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
        const next = cleaningUp ? {output: 'Cleanup'} : respond(input);
        reply(response, next.output, next.tokens);
      } catch (error) {
        fail(error);
        response.writeHead(500);
        response.end(String(error));
      }
    });
    t.after(async () => {
      cleaningUp = true;
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
      join(cwd, 'AGENTS.md'),
      'PROJECT REVIEW INSTRUCTION: verify current files before continuing.',
    );
    await writeFile(
      join(cwd, 'draft.txt'),
      `PRIVATE TOOL OUTPUT\n${'Draft review evidence.\n'.repeat(40)}`,
    );
    await writeFile(join(cwd, 'checkpoint.txt'), verified);
    await writeFile(join(cwd, 'validation.txt'), 'VALIDATION EVIDENCE');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const createRuntime: CreateAgentSessionRuntimeFactory = async options => {
      const phase = sessions.length;
      assert.ok(phase < 3, 'Only two replacements are expected');
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
        models: ['review-model', 'default-model'].map(id => ({
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
              pi.on('turn_end', (event, ctx) => {
                if (
                  JSON.stringify(event.message).includes(
                    'EXACT CONTEXT BOUNDARY',
                  )
                )
                  boundaryPercent = ctx.getContextUsage()?.percent;
              });
              registerAutoHandover(pi);
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
          phase === 0 ? 'review-model' : 'default-model',
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
        if (phase === 2 && event.type === 'agent_settled') finished.resolve();
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
            void operation.catch(fail);
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
    runtime.session.setActiveToolsByName(activeTools);
    const first = runtime.session.prompt(originalTask);
    operations.push(first);
    await Promise.race([first, failed.promise]);
    assert.equal(requests[0].length, 2);
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
    assert.equal(sessions.length, 3);
    assert.equal(runtime.session, sessions[2]);
    assert.equal(runtime.session.model?.id, 'review-model');
    assert.equal(runtime.session.thinkingLevel, 'high');
    assert.equal(automaticMessages.length, 2);
    assert.deepEqual(tools, [['read', 'read'], ['read'], []]);
    const paths = sessions.map(session =>
      session.sessionManager.getSessionFile()!,
    );
    assert.equal(new Set(paths).size, 3);
    const transcripts = await Promise.all(
      paths.map(path => readFile(path, 'utf8')),
    );
    assert.match(transcripts[0], /ORIGINAL TASK|PRIVATE TOOL OUTPUT/);
    assert.ok(transcripts[1].includes(handovers[0]));
    assert.ok(transcripts[2].includes(handovers[1]));
    assert.doesNotMatch(
      transcripts[2],
      /ORIGINAL TASK|PRIVATE TOOL OUTPUT|FIRST HANDOVER/,
    );
    for (const session of sessions)
      assert.equal(
        session.sessionManager
          .getEntries()
          .filter(entry => entry.type === 'compaction').length,
        0,
      );
  },
);
