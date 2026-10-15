import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import registerVarisdev from '../extensions/varisdev.ts';
import type {AgentRecord} from '../src/agents/orchestrator.ts';

interface ProviderRequest {
  model: string;
  messages: Array<{role: string; content: unknown}>;
}

type Reply = {tokens?: number} & (
  | {text: string}
  | {overflow: true}
  | {toolCall: {name: string; arguments: Record<string, unknown>}}
);
const SUMMARY =
  'COMPACTED HISTORY: preserve the recorded decision and continue.';
const TURN_PREFIX_SUMMARY =
  'TURN PREFIX: continue the follow-up using the recorded decision.';
const ORIGINAL =
  'ORIGINAL REQUEST: Review the implementation and record the decision. ' +
  'Explain the findings, including the relevant files and any remaining work. '.repeat(
    3,
  );
const FOLLOW_UP =
  'FOLLOW UP: Continue the review using the recorded decision. ' +
  'Check the remaining work and report the next useful step with evidence. '.repeat(
    3,
  );

async function fixture(
  t: TestContext,
  enabled: boolean,
  replies: Reply[],
  workerReply?: (request: ProviderRequest) => Promise<Reply>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'varisdev-compaction-'));
  const cwd = join(directory, 'project');
  const agentDir = join(directory, 'config');
  const originalTitle = process.title;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let session: AgentSession | undefined = undefined;
  t.after(async () => {
    await session?.abort();
    await session?.extensionRunner.emit({
      type: 'session_shutdown',
      reason: 'quit',
    });
    session?.dispose();
    process.title = originalTitle;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, {recursive: true, force: true});
  });
  await mkdir(cwd, {recursive: true});
  await mkdir(agentDir, {recursive: true});

  const requests: ProviderRequest[] = [];
  const summaries: ProviderRequest[] = [];
  // Exercise the SDK's provider transport while keeping every request in memory.
  t.mock.method(
    globalThis,
    'fetch',
    async (url: RequestInfo | URL, options?: RequestInit) => {
      assert.equal(
        String(url),
        'https://compaction.invalid/v1/chat/completions',
      );
      const request = JSON.parse(String(options?.body)) as ProviderRequest;
      let reply: Reply;
      if (request.model === 'worker-model') {
        assert.ok(workerReply, 'Unexpected worker request');
        reply = await workerReply(request);
      } else {
        assert.equal(request.model, 'fixture-model');
        const isSummary = JSON.stringify(request.messages).includes(
          'You are a context summarization assistant',
        );
        (isSummary ? summaries : requests).push(request);
        const isTurnPrefixSummary =
          isSummary &&
          JSON.stringify(request.messages).includes(
            'earlier context from an ongoing conversation',
          );
        reply = isSummary
          ? {text: isTurnPrefixSummary ? TURN_PREFIX_SUMMARY : SUMMARY}
          : replies[requests.length - 1];
      }
      assert.ok(reply, 'Unexpected provider request');
      if ('overflow' in reply) {
        return Response.json(
          {
            error: {
              message: 'maximum context length exceeded',
              type: 'invalid_request_error',
              code: 'context_length_exceeded',
            },
          },
          {status: 400},
        );
      }
      const tokens = reply.tokens ?? 500;
      const chunk = {
        id: 'fixture-completion',
        object: 'chat.completion.chunk',
        created: 1,
        model: request.model,
        choices: [
          {
            index: 0,
            delta:
              'toolCall' in reply
                ? {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'worker-call',
                        type: 'function',
                        function: {
                          name: reply.toolCall.name,
                          arguments: JSON.stringify(reply.toolCall.arguments),
                        },
                      },
                    ],
                  }
                : {role: 'assistant', content: reply.text},
            finish_reason: 'toolCall' in reply ? 'tool_calls' : 'stop',
          },
        ],
        usage: {
          prompt_tokens: tokens - 20,
          completion_tokens: 20,
          total_tokens: tokens,
        },
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        {
          headers: {'content-type': 'text/event-stream'},
        },
      );
    },
  );

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider('compaction-fixture', {
    api: 'openai-completions',
    apiKey: 'fixture-key',
    baseUrl: 'https://compaction.invalid/v1',
    models: ['fixture-model', 'worker-model'].map(id => ({
      id,
      name: id,
      reasoning: false,
      input: ['text'],
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
      contextWindow: 64000,
      maxTokens: 1000,
    })),
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: {enabled, reserveTokens: 16000, keepRecentTokens: 48},
    retry: {enabled: false},
  });
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    resourceLoaderOptions: {
      noExtensions: true,
      noThemes: true,
      noSkills: true,
      noPromptTemplates: true,
      extensionFactories: [registerVarisdev],
    },
  });
  assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
  const created = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(cwd),
    model: modelRuntime.getModel('compaction-fixture', 'fixture-model'),
    thinkingLevel: 'off',
  });
  session = created.session;
  const errors: unknown[] = [];
  const events: AgentSessionEvent[] = [];
  session.subscribe(event => events.push(event));
  await session.bindExtensions({
    mode: 'print',
    onError: error => errors.push(error),
  });
  t.after(() => assert.deepEqual(errors, []));
  return {session, requests, summaries, events};
}

for (const reason of ['manual', 'threshold', 'overflow'] as const) {
  void test(
    `VarisDev allows native ${reason} compaction and continuation in the same session`,
    {timeout: 15000},
    async t => {
      const {session, requests, summaries, events} = await fixture(
        t,
        reason !== 'manual',
        [
          {text: 'Recorded decision: proceed.'},
          reason === 'overflow'
            ? {overflow: true}
            : {text: 'Review complete.', tokens: 50001},
          {text: 'Continued with the recorded decision.'},
        ],
      );
      const sessionId = session.sessionManager.getSessionId();
      await session.prompt(ORIGINAL);
      assert.equal(summaries.length, 0, 'Do not compact below the threshold');
      await session.prompt(FOLLOW_UP);

      if (reason === 'manual') {
        assert.equal(summaries.length, 0, 'Respect disabled auto-compaction');
        const result = await session.compact('Keep the recorded decision.');
        assert.equal(result.summary, SUMMARY);
        assert.match(JSON.stringify(summaries), /Keep the recorded decision/);
      }
      const expectedSummary =
        reason === 'overflow'
          ? `${SUMMARY}\n\n---\n\n**Turn Context (split turn):**\n\n${TURN_PREFIX_SUMMARY}`
          : SUMMARY;
      assert.equal(summaries.length, reason === 'overflow' ? 2 : 1);
      assert.match(JSON.stringify(summaries[0].messages), /ORIGINAL REQUEST/);
      if (reason === 'overflow')
        assert.match(JSON.stringify(summaries[1].messages), /FOLLOW UP/);
      const compactions = session.sessionManager
        .getEntries()
        .filter(entry => entry.type === 'compaction');
      assert.equal(compactions.length, 1);
      assert.equal(compactions[0].summary, expectedSummary);
      assert.equal(compactions[0].fromHook, false);
      const end = events.find(event => event.type === 'compaction_end');
      assert.ok(end?.type === 'compaction_end');
      assert.equal(end.reason, reason);
      assert.equal(end.aborted, false);
      assert.equal(end.willRetry, reason === 'overflow');
      assert.equal(end.result?.summary, expectedSummary);

      if (reason !== 'overflow') {
        assert.equal(requests.length, 2, 'Do not retry a completed response');
        await session.prompt('Continue with the recorded decision.');
      }
      assert.equal(requests.length, 3);
      const continued = JSON.stringify(requests[2].messages);
      assert.ok(continued.includes(SUMMARY));
      if (reason === 'overflow')
        assert.ok(continued.includes(TURN_PREFIX_SUMMARY));
      assert.doesNotMatch(continued, /ORIGINAL REQUEST/);
      assert.equal(session.sessionManager.getSessionId(), sessionId);
      assert.equal(session.autoCompactionEnabled, reason !== 'manual');
      assert.equal(
        summaries.length,
        reason === 'overflow' ? 2 : 1,
        'Do not compact again using stale usage',
      );
    },
  );
}

void test(
  'native compaction preserves a live worker, its conversation, queue, inbox, and result',
  {timeout: 15000},
  async t => {
    const workerReady = Promise.withResolvers<void>();
    const releaseWorker = Promise.withResolvers<void>();
    t.after(() => releaseWorker.resolve());
    const workerRequests: ProviderRequest[] = [];
    const {session, summaries} = await fixture(
      t,
      false,
      [{text: 'Recorded decision: proceed.'}, {text: 'Review complete.'}],
      async request => {
        workerRequests.push(request);
        switch (workerRequests.length) {
          case 1:
            return {
              toolCall: {
                name: 'agent_send',
                arguments: {id: 'parent', message: 'Worker evidence ready.'},
              },
            };
          case 2:
            return {text: 'INITIAL WORKER RESULT'};
          case 3:
            workerReady.resolve();
            await releaseWorker.promise;
            return {text: 'RESUMED WORKER RESULT'};
          case 4:
            return {text: 'QUEUED WORKER RESULT'};
          default:
            assert.fail('Unexpected worker request');
        }
      },
    );
    async function tool<T>(name: string, parameters: Record<string, unknown>) {
      const registered = session.agent.state.tools.find(
        tool => tool.name === name,
      );
      assert.ok(registered, `Missing tool ${name}`);
      return (await registered.execute('fixture-call', parameters))
        .details as T;
    }
    const spawned = await tool<{agents: AgentRecord[]}>('agent_spawn', {
      name: 'Reviewer',
      task: 'ORIGINAL WORKER TASK: record the evidence.',
      model: 'compaction-fixture/worker-model',
    });
    const id = spawned.agents[0].id;
    const wait = () => tool<{agents: AgentRecord[]}>('agent_wait', {ids: [id]});
    const initial = (await wait()).agents[0];
    assert.equal(initial.status, 'completed');
    assert.equal(initial.output, 'INITIAL WORKER RESULT');
    assert.ok(initial.resultFile);
    assert.ok(initial.sessionFile);

    await tool('agent_send', {id, message: 'RESUMED WORKER TASK'});
    await workerReady.promise;
    await tool('agent_send', {id, message: 'QUEUED WORKER TASK'});
    const status = () => tool<{agents: AgentRecord[]}>('agent_status', {id});
    const before = await status();
    assert.equal(before.agents[0].status, 'running');
    assert.equal(await readFile(initial.resultFile, 'utf8'), initial.output);
    const inbox = await tool('agent_inbox', {});
    assert.match(JSON.stringify(inbox), /Worker evidence ready/);

    await session.prompt(ORIGINAL);
    await session.prompt(FOLLOW_UP);
    await session.compact();
    assert.equal(summaries.length, 1);
    assert.deepEqual(await status(), before);
    assert.deepEqual(await tool('agent_inbox', {}), inbox);
    assert.equal(await readFile(initial.resultFile, 'utf8'), initial.output);

    releaseWorker.resolve();
    const finished = (await wait()).agents[0];
    assert.equal(finished.id, id);
    assert.equal(finished.status, 'completed');
    assert.equal(finished.output, 'QUEUED WORKER RESULT');
    assert.equal(finished.sessionFile, initial.sessionFile);
    assert.equal(finished.resultFile, initial.resultFile);
    assert.equal(await readFile(finished.resultFile!, 'utf8'), finished.output);
    assert.equal(workerRequests.length, 4);
    const continued = JSON.stringify(workerRequests[3].messages);
    for (const text of [
      'ORIGINAL WORKER TASK',
      'INITIAL WORKER RESULT',
      'RESUMED WORKER TASK',
      'RESUMED WORKER RESULT',
      'QUEUED WORKER TASK',
    ]) {
      assert.ok(continued.includes(text), `Worker context lost ${text}`);
    }
  },
);
