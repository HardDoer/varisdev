import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test, {type TestContext} from 'node:test';
import {
  ModelRegistry,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  type SessionBoundaryDraft,
} from '@earendil-works/pi-coding-agent';
import {createDashboardParent} from '../src/dashboard/parent.ts';
import type {DashboardParent, ParentRequest} from '../src/dashboard/hub.ts';
import {saveToolSettings} from '../src/tools/settings.ts';
import {AgentOrchestrator} from '../src/agents/orchestrator.ts';
import {registerAgentCompletions} from '../src/agents/completions.ts';
import {createSessionWorker} from '../src/agents/session.ts';

type Request = {
  messages: Array<{role: string; content: unknown}>;
  tools?: Array<{function: {name: string}}>;
};
type Call = {name: string; arguments: Record<string, unknown>};
function response(output: string | Call[]): Response {
  const tools = Array.isArray(output);
  return new Response(
    `data: ${JSON.stringify({
      id: 'reply',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fixture',
      choices: [
        {
          index: 0,
          delta: tools
            ? {
                role: 'assistant',
                tool_calls: output.map((call, index) => ({
                  index,
                  id: randomUUID(),
                  type: 'function',
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments),
                  },
                })),
              }
            : {role: 'assistant', content: output},
          finish_reason: tools ? 'tool_calls' : 'stop',
        },
      ],
    })}\n\ndata: [DONE]\n\n`,
    {headers: {'content-type': 'text/event-stream'}},
  );
}
const launch = (task: string): Call => ({
  name: 'agent_spawn',
  arguments: {name: task, task},
});
function task(request: Request): string {
  return JSON.stringify(
    request.messages.find(message => message.role === 'user')?.content,
  );
}
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check() && Date.now() < end) await delay(5);
  assert.ok(check(), 'Expected completion state was not reached');
}
async function fixture(
  t: TestContext,
  respond: (request: Request) => Response | Promise<Response>,
  concurrency = 6,
) {
  const output = join(process.cwd(), '.varisdev', 'tool-output', 'check-temp');
  await mkdir(output, {recursive: true});
  const root = await mkdtemp(join(output, 'agent-completions-'));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'config');
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await mkdir(cwd, {recursive: true});
  await mkdir(agentDir, {recursive: true});
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({retry: {enabled: false}, compaction: {enabled: false}}),
  );
  new ProjectTrustStore(agentDir).set(cwd, true);
  await saveToolSettings('agents', {
    allowedModels: null,
    maxConcurrentAgents: concurrency,
  });
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  const provider = 'completion-fixture';
  registry.registerProvider(provider, {
    api: 'openai-completions',
    apiKey: 'fixture-key',
    baseUrl: 'https://completion.invalid/v1',
    models: [
      {
        id: 'fixture',
        name: 'Fixture',
        reasoning: false,
        input: ['text'],
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
        contextWindow: 128000,
        maxTokens: 1000,
      },
    ],
  });
  const requests: Request[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, options?: RequestInit) => {
      const request = JSON.parse(String(options?.body)) as Request;
      requests.push(request);
      const signal = options?.signal;
      signal?.throwIfAborted();
      const aborted = Promise.withResolvers<never>();
      const abort = () => aborted.reject(signal!.reason);
      signal?.addEventListener('abort', abort, {once: true});
      try {
        return await Promise.race([respond(request), aborted.promise]);
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    },
  );
  const parents: DashboardParent[] = [];
  t.after(async () => {
    try {
      await Promise.all(parents.map(parent => parent.close()));
    } finally {
      registry.unregisterProvider(provider);
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, {recursive: true, force: true});
    }
  });
  async function open(resume?: ParentRequest['resume']) {
    const parent = await createDashboardParent(
      {cwd, resume},
      {
        model: registry.find(provider, 'fixture')!,
        modelRegistry: registry,
        thinkingLevel: 'off',
      },
    );
    parents.push(parent);
    return parent;
  }
  return {
    open,
    requests,
    cwd,
    registry,
    model: registry.find(provider, 'fixture')!,
  };
}

void test(
  'automatic results keep callers and workers parallel, batch final results, and persist one delivery',
  {timeout: 20000},
  async t => {
    const first = Promise.withResolvers<Response>();
    const second = Promise.withResolvers<Response>();
    let parentCalls = 0;
    const f = await fixture(t, request => {
      if (task(request).includes('first-fixture-agent')) return first.promise;
      if (task(request).includes('second-fixture-agent')) return second.promise;
      parentCalls++;
      if (parentCalls === 1)
        return response([
          launch('first-fixture-agent'),
          launch('second-fixture-agent'),
        ]);
      if (parentCalls === 2) return response('Finished my independent work.');
      const text = JSON.stringify(request.messages);
      assert.match(text, /first unique result/);
      assert.match(text, /second unique result/);
      return response('Combined answer.');
    });
    const parent = await f.open();
    const running = parent.prompt('parallel-fixture-root');
    await until(
      () => parentCalls === 2 && parent.state.snapshot().agents.length === 2,
    );
    assert.equal(parent.state.snapshot().session.status, 'running');
    assert.equal(
      parent.state.snapshot().agents.filter(agent => agent.status === 'running')
        .length,
      2,
    );
    first.resolve(response('first unique result'));
    await until(() =>
      parent.state
        .snapshot()
        .agents.some(agent => agent.status === 'completed'),
    );
    assert.equal(parentCalls, 2);
    second.resolve(response('second unique result'));
    await running;
    assert.equal(parentCalls, 3);
    assert.equal(parent.lastAssistantText?.(), 'Combined answer.');
    assert.ok(
      f.requests.every(
        request =>
          !request.tools?.some(tool =>
            ['agent_status', 'agent_wait'].includes(tool.function.name),
          ),
      ),
    );
    const saved = (await SessionManager.list(f.cwd))[0];
    const entries = (await readFile(saved.path, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    assert.equal(
      entries.filter(
        entry =>
          entry.type === 'custom_message' &&
          entry.customType === 'varisdev.agent-results',
      ).length,
      1,
    );
    await parent.prompt('Continue from that answer.');
    const finalEntries = (await readFile(saved.path, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    assert.equal(
      finalEntries.filter(
        entry =>
          entry.type === 'custom_message' &&
          entry.customType === 'varisdev.agent-results',
      ).length,
      1,
    );
  },
);

void test(
  'nested automatic waits release the worker slot and deliver only to the initiating agent',
  {timeout: 20000},
  async t => {
    let rootCalls = 0;
    let branchCalls = 0;
    let leafCalls = 0;
    const f = await fixture(
      t,
      request => {
        if (task(request).includes('leaf-fixture-agent')) {
          leafCalls++;
          return response('private leaf result');
        }
        if (task(request).includes('branch-fixture-agent')) {
          branchCalls++;
          if (branchCalls === 1)
            return response([launch('leaf-fixture-agent')]);
          if (branchCalls === 2)
            return response('Branch independent work finished.');
          assert.match(JSON.stringify(request.messages), /private leaf result/);
          return response('branch complete result');
        }
        rootCalls++;
        if (rootCalls === 1) return response([launch('branch-fixture-agent')]);
        if (rootCalls === 2) return response('Root independent work finished.');
        assert.match(
          JSON.stringify(request.messages),
          /branch complete result/,
        );
        assert.doesNotMatch(
          JSON.stringify(request.messages),
          /private leaf result/,
        );
        return response('Nested answer.');
      },
      2,
    );
    const parent = await f.open();
    await parent.prompt('nested-fixture-root');
    assert.equal(parent.lastAssistantText?.(), 'Nested answer.');
    assert.equal(leafCalls, 1);
    assert.equal(branchCalls, 3);
    assert.equal(rootCalls, 3);
    assert.deepEqual(
      parent.state.snapshot().agents.map(agent => agent.status),
      ['completed', 'completed'],
    );
  },
);

void test(
  'stopping an automatic wait leaves workers running and delivers their saved result once on resume',
  {timeout: 20000},
  async t => {
    const worker = Promise.withResolvers<Response>();
    let rootCalls = 0;
    const f = await fixture(t, request => {
      if (task(request).includes('held-fixture-agent')) return worker.promise;
      rootCalls++;
      if (rootCalls === 1) return response([launch('held-fixture-agent')]);
      if (rootCalls === 2) return response('Independent work is finished.');
      assert.match(JSON.stringify(request.messages), /retained unique result/);
      return response('Resumed answer.');
    });
    const parent = await f.open();
    const running = parent.prompt('stop-fixture-root');
    await until(
      () =>
        rootCalls === 2 &&
        parent.state.snapshot().agents[0]?.status === 'running',
    );
    await parent.abort();
    await running;
    assert.equal(parent.state.snapshot().session.status, 'idle');
    assert.equal(parent.state.snapshot().agents[0].status, 'running');
    worker.resolve(response('retained unique result'));
    await until(() => parent.state.snapshot().agents[0].status === 'completed');
    assert.equal(
      rootCalls,
      2,
      'a stopped caller must not restart when a worker finishes',
    );
    const saved = (await SessionManager.list(f.cwd))[0];
    await parent.close();
    const reopened = await f.open({id: saved.id, path: saved.path});
    assert.equal(
      rootCalls,
      2,
      'opening saved history must not start a model request',
    );
    await reopened.prompt('Continue with the result.');
    assert.equal(rootCalls, 3);
    assert.equal(reopened.lastAssistantText?.(), 'Resumed answer.');
    const entries = (await readFile(saved.path, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    assert.equal(
      entries.filter(
        entry =>
          entry.type === 'custom_message' &&
          entry.customType === 'varisdev.agent-results',
      ).length,
      1,
    );
  },
);

void test(
  'worker failures are delivered automatically without result polling',
  {timeout: 20000},
  async t => {
    let launched = false;
    let failures = 0;
    const f = await fixture(t, request => {
      if (task(request).includes('failing-fixture-agent')) {
        failures++;
        return new Response(
          JSON.stringify({error: {message: 'fixture worker failure'}}),
          {status: 401, headers: {'content-type': 'application/json'}},
        );
      }
      if (!launched) {
        launched = true;
        return response([launch('failing-fixture-agent')]);
      }
      const text = JSON.stringify(request.messages);
      return response(
        text.includes('fixture worker failure')
          ? 'Reported the worker failure.'
          : 'Finished other work.',
      );
    });
    const parent = await f.open();
    await parent.prompt('failure-fixture-root');
    assert.equal(failures, 1);
    assert.equal(parent.lastAssistantText?.(), 'Reported the worker failure.');
    assert.equal(parent.state.snapshot().agents[0].status, 'failed');
  },
);

void test(
  'continuing a finished agent delivers its new result automatically',
  {timeout: 20000},
  async t => {
    let childCalls = 0;
    let launched = false;
    let resumed = false;
    const f = await fixture(t, request => {
      if (task(request).includes('resumable-fixture-agent'))
        return response(
          ++childCalls === 1
            ? 'original unique result'
            : 'updated unique result',
        );
      if (!launched) {
        launched = true;
        return response([launch('resumable-fixture-agent')]);
      }
      const text = JSON.stringify(request.messages);
      if (text.includes('resume-fixture-command') && !resumed) {
        resumed = true;
        return response([
          {
            name: 'agent_send',
            arguments: {
              id: parent.state.snapshot().agents[0].id,
              message: 'Continue the previous task.',
            },
          },
        ]);
      }
      return response(
        text.includes('updated unique result')
          ? 'Updated answer.'
          : text.includes('original unique result')
            ? 'Original answer.'
            : 'Independent work finished.',
      );
    });
    const parent = await f.open();
    await parent.prompt('resume-fixture-root');
    assert.equal(parent.lastAssistantText?.(), 'Original answer.');
    await parent.prompt('resume-fixture-command');
    assert.equal(parent.lastAssistantText?.(), 'Updated answer.');
    assert.equal(childCalls, 2);
    assert.equal(parent.state.snapshot().agents.length, 1);
  },
);

void test(
  'messaging a running peer does not make the sender wait for that peer',
  {timeout: 20000},
  async t => {
    const peer = Promise.withResolvers<Response>();
    let peerId: string | undefined;
    let rootCalls = 0;
    let senderCalls = 0;
    let peerCalls = 0;
    const f = await fixture(t, async request => {
      if (task(request).includes('busy-fixture-agent')) {
        peerId = parent.state
          .snapshot()
          .agents.find(agent => agent.name === 'busy-fixture-agent')!.id;
        return ++peerCalls === 1
          ? peer.promise
          : response('Busy peer final result.');
      }
      if (task(request).includes('sender-fixture-agent')) {
        if (++senderCalls === 1) {
          await until(() => Boolean(peerId));
          return response([
            {
              name: 'agent_send',
              arguments: {id: peerId!, message: 'Progress from the sender.'},
            },
          ]);
        }
        return response('Sender final result.');
      }
      if (++rootCalls === 1)
        return response([
          launch('sender-fixture-agent'),
          launch('busy-fixture-agent'),
        ]);
      return response(
        JSON.stringify(request.messages).includes('Busy peer final result.')
          ? 'Both results collected.'
          : 'Root independent work finished.',
      );
    });
    const parent = await f.open();
    const running = parent.prompt('peer-fixture-root');
    await until(() =>
      parent.state
        .snapshot()
        .agents.some(
          agent =>
            agent.name === 'sender-fixture-agent' &&
            agent.status === 'completed',
        ),
    );
    assert.equal(
      parent.state.snapshot().agents.find(agent => agent.id === peerId)!.status,
      'running',
    );
    peer.resolve(response('Initial peer work finished.'));
    await running;
    assert.equal(parent.lastAssistantText?.(), 'Both results collected.');
    assert.equal(senderCalls, 2);
    assert.equal(peerCalls, 2);
  },
);

void test(
  'an agent started by a user mention delivers its result to the idle Main agent once',
  {timeout: 20000},
  async t => {
    const worker = Promise.withResolvers<Response>();
    let rootCalls = 0;
    let childCalls = 0;
    const f = await fixture(t, request => {
      if (!task(request).includes('@default')) {
        childCalls++;
        return worker.promise;
      }
      rootCalls++;
      assert.match(JSON.stringify(request.messages), /mention unique result/);
      return response('Mention result received.');
    });
    const parent = await f.open();
    await parent.prompt('@default mention-fixture-task');
    await until(() => childCalls === 1);
    assert.equal(rootCalls, 0);
    assert.equal(parent.state.snapshot().session.status, 'idle');
    worker.resolve(response('mention unique result'));
    await until(
      () =>
        rootCalls === 1 && parent.state.snapshot().session.status === 'idle',
    );
    assert.equal(parent.lastAssistantText?.(), 'Mention result received.');
    const saved = (await SessionManager.list(f.cwd))[0];
    const entries = (await readFile(saved.path, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    assert.equal(
      entries.filter(
        entry =>
          entry.type === 'custom_message' &&
          entry.customType === 'varisdev.agent-results',
      ).length,
      1,
    );
  },
);

void test(
  'Main cannot be closed separately and still receives its agent result',
  {timeout: 20000},
  async t => {
    const worker = Promise.withResolvers<Response>();
    let childStarted = false;
    let rootCalls = 0;
    const f = await fixture(t, request => {
      if (!task(request).includes('@default')) {
        childStarted = true;
        return worker.promise;
      }
      rootCalls++;
      return response('Main result received.');
    });
    const parent = await f.open();
    await parent.prompt('@default closure-fixture-task');
    await until(() => childStarted);
    await assert.rejects(
      parent.agentSession!({agentId: 'parent', action: 'close'}),
      /Main agent cannot be closed/,
    );
    const notices = parent.ui?.snapshot().notifications;
    worker.resolve(response('Child completed while Main stayed open.'));
    await until(
      () =>
        rootCalls === 1 && parent.state.snapshot().session.status === 'idle',
    );
    assert.equal(parent.lastAssistantText?.(), 'Main result received.');
    assert.equal(parent.state.snapshot().session.primaryClosed, false);
    assert.deepEqual(parent.ui?.snapshot().notifications, notices);
    assert.equal(parent.state.snapshot().session.error, undefined);
    assert.equal(parent.state.snapshot().agents[0].agentProfile?.id, 'default');
  },
);

void test(
  'stopping an idle caller suppresses automatic result turns until the next explicit prompt',
  {timeout: 20000},
  async t => {
    const worker = Promise.withResolvers<Response>();
    let childStarted = false;
    let rootCalls = 0;
    const f = await fixture(t, request => {
      if (!task(request).includes('@default')) {
        childStarted = true;
        return worker.promise;
      }
      rootCalls++;
      assert.match(JSON.stringify(request.messages), /saved idle result/);
      return response('Main continued with the saved result.');
    });
    const parent = await f.open();
    await parent.prompt('@default stopped-idle-fixture');
    await until(() => childStarted);
    await parent.abort();
    worker.resolve(response('saved idle result'));
    await until(() => parent.state.snapshot().agents[0].status === 'completed');
    const previousUse = parent.state.snapshot().agents[0].lastUsedAt;
    await delay(20);
    assert.equal(rootCalls, 0);
    assert.equal(parent.state.snapshot().session.primaryClosed, false);
    await parent.prompt('Continue with the saved result.');
    assert.equal(rootCalls, 1);
    assert.equal(
      parent.lastAssistantText?.(),
      'Main continued with the saved result.',
    );
    assert.ok(
      Date.parse(parent.state.snapshot().agents[0].lastUsedAt ?? '') >
        Date.parse(previousUse ?? ''),
      'Automatically reading a saved result renews its inactivity period',
    );
  },
);

void test(
  'closing the workspace stops agents and preserves Main for resume without a spontaneous turn',
  {timeout: 20000},
  async t => {
    const worker = Promise.withResolvers<Response>();
    let childStarted = false;
    let rootCalls = 0;
    const f = await fixture(t, request => {
      if (!task(request).includes('@default')) {
        childStarted = true;
        return worker.promise;
      }
      rootCalls++;
      assert.match(JSON.stringify(request.messages), /cancelled/);
      return response('Main resumed after workspace closure.');
    });
    const parent = await f.open();
    await parent.prompt('@default workspace-close-fixture');
    await until(() => childStarted);
    const state = parent.state.snapshot();
    await parent.close();
    assert.equal(rootCalls, 0);
    const resumed = await f.open({
      id: state.session.id,
      path: state.session.sessionFile!,
    });
    assert.equal(resumed.state.snapshot().session.primaryClosed, false);
    assert.equal(resumed.state.snapshot().agents[0].status, 'cancelled');
    assert.equal(rootCalls, 0);
    await resumed.prompt('Continue after closing the workspace.');
    assert.equal(rootCalls, 1);
    assert.equal(
      resumed.lastAssistantText?.(),
      'Main resumed after workspace closure.',
    );
  },
);

void test(
  'Main handles new user work while the harness waits for an agent result',
  {timeout: 20000},
  async t => {
    const worker = Promise.withResolvers<Response>();
    let rootCalls = 0;
    let childStarted = false;
    const f = await fixture(t, request => {
      if (task(request).includes('parallel-input-worker')) {
        childStarted = true;
        return worker.promise;
      }
      rootCalls++;
      if (rootCalls === 1) return response([launch('parallel-input-worker')]);
      if (rootCalls === 2) return response('Initial Main work finished.');
      const text = JSON.stringify(request.messages);
      assert.match(text, /additional user task/);
      return response(
        text.includes('parallel input result')
          ? 'Main combined both tasks and the result.'
          : 'Handled the additional user task.',
      );
    });
    const parent = await f.open();
    const running = parent.prompt('parallel-input-root');
    await until(
      () =>
        rootCalls === 2 &&
        childStarted &&
        parent.state.snapshot().session.response ===
          'Initial Main work finished.',
    );
    await parent.prompt(
      'Handle an additional user task while the agent works.',
    );
    await until(
      () =>
        rootCalls === 3 &&
        parent.state.snapshot().session.response ===
          'Handled the additional user task.',
    );
    assert.equal(parent.state.snapshot().agents[0].status, 'running');
    worker.resolve(response('parallel input result'));
    await running;
    assert.equal(rootCalls, 4);
    assert.equal(
      parent.lastAssistantText?.(),
      'Main combined both tasks and the result.',
    );
  },
);

for (const boundary of ['turn_end', 'agent_before_settle'] as const) {
  void test(
    `automatic results preserve preceding ${boundary} proposals through Pi`,
    {timeout: 20000},
    async t => {
      const manager = new AgentOrchestrator(3);
      t.after(() => manager.close());
      let calls = 0;
      const marker = `prior proposal from ${boundary}`;
      const f = await fixture(t, () => {
        calls++;
        return response(
          calls === 1
            ? 'Initial boundary response.'
            : 'Combined boundary response.',
        );
      });
      let launched = false;
      const caller = manager.spawn(
        {
          name: 'boundary caller',
          task: 'boundary root',
          cwd: f.cwd,
          model: `${f.model.provider}/${f.model.id}`,
        },
        id =>
          createSessionWorker({
            id,
            parentSessionId: 'boundary-parent',
            cwd: f.cwd,
            name: 'boundary caller',
            model: f.model,
            modelRegistry: f.registry,
            thinkingLevel: 'off',
            agentToolsExtension(pi) {
              const propose = (event: {
                entries: readonly SessionBoundaryDraft[];
              }) => {
                if (calls !== 1) return;
                return {
                  entries: [
                    ...event.entries,
                    {
                      type: 'custom_message' as const,
                      customType: 'fixture.preceding-proposal',
                      content: marker,
                      display: false,
                    },
                  ],
                };
              };
              if (boundary === 'turn_end') pi.on('turn_end', propose);
              else pi.on('agent_before_settle', propose);
              const completions = registerAgentCompletions(
                pi,
                () => manager,
                records =>
                  records.map(record => ({
                    type: 'text',
                    text: record.output ?? '',
                  })),
                id,
              );
              const start = (ctx: Parameters<typeof completions.track>[1]) => {
                launched = true;
                const child = manager.spawn(
                  {
                    name: 'boundary child',
                    task: 'boundary child',
                    cwd: f.cwd,
                    model: 'fixture/child',
                    agentMode: 'subagent',
                  },
                  async () => ({
                    run: async () => 'chained child result',
                    steer: async () => false,
                    dispose() {},
                  }),
                );
                completions.track(child.id, ctx);
                return child.id;
              };
              pi.on('before_agent_start', (_event, ctx) => {
                if (boundary === 'turn_end' && !launched) start(ctx);
              });
              pi.on('turn_end', async (_event, ctx) => {
                if (boundary === 'agent_before_settle' && !launched) {
                  // Register after the completion hook so the result first becomes
                  // available at the final settlement boundary.
                  const child = start(ctx);
                  await manager.wait([child], {
                    timeoutMs: 1000,
                    signal: ctx.signal,
                  });
                }
              });
            },
          }),
      );
      const [finished] = await manager.wait([caller.id], {timeoutMs: 10000});
      assert.equal(finished.status, 'completed', finished.error);
      assert.equal(finished.output, 'Combined boundary response.');
      assert.equal(calls, 2);
      const messages = JSON.stringify(f.requests[1].messages);
      assert.match(messages, /chained child result/);
      assert.equal(
        messages.split(marker).length - 1,
        1,
        'Pi must retain the preceding extension proposal exactly once',
      );
    },
  );
}
