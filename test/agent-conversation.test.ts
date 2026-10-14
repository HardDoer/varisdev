import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {Type} from 'typebox';
import {
  ModelRegistry,
  ModelRuntime,
  type AgentSessionEvent,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import {WorkerConversation} from '../src/agents/conversation.ts';
import {AgentOrchestrator} from '../src/agents/orchestrator.ts';
import {createSessionWorker} from '../src/agents/session.ts';
import {DashboardState} from '../src/dashboard/state.ts';
import type {ConversationMessage} from '../src/conversation.ts';

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition() && Date.now() < deadline) await delay(5);
  assert.ok(condition(), 'Expected live conversation update');
}

function chunk(
  response: ServerResponse,
  delta: object,
  finish_reason: string | null = null,
) {
  response.write(
    `data: ${JSON.stringify({
      id: 'conversation-fixture',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'worker-model',
      choices: [{index: 0, delta, finish_reason}],
    })}\n\n`,
  );
}
function done(response: ServerResponse) {
  response.end('data: [DONE]\n\n');
}

void test(
  'real SDK streams replies and repeated tool progress into isolated agent dashboards before completion',
  {timeout: 15000},
  async t => {
    const directory = await mkdtemp(
      join(tmpdir(), 'varisdev-conversation-sdk-'),
    );
    const agentDir = join(directory, 'config');
    const cwd = join(directory, 'project');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(cwd, {recursive: true});
    await mkdir(agentDir, {recursive: true});
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({retry: {enabled: false}, compaction: {enabled: false}}),
    );
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    const manager = new AgentOrchestrator(2);
    const secondText = Promise.withResolvers<void>();
    const finishText = Promise.withResolvers<void>();
    const secondProgress = Promise.withResolvers<void>();
    const finishTool = Promise.withResolvers<void>();
    const providerErrors: unknown[] = [];
    let requests = 0;
    const server = createServer(async (request, response) => {
      try {
        let body = '';
        for await (const part of request) body += part;
        const input = JSON.parse(body) as {
          messages: {role: string; content: unknown}[];
        };
        requests++;
        response.writeHead(200, {'content-type': 'text/event-stream'});
        if (requests === 1) {
          chunk(response, {
            role: 'assistant',
            reasoning_content: 'private reasoning',
            content: 'Inspecting',
          });
          await secondText.promise;
          chunk(response, {content: ' the fixture.'});
          await finishText.promise;
          chunk(
            response,
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'progress-call',
                  type: 'function',
                  function: {
                    name: 'fixture_progress',
                    arguments: '{"path":"fixture.txt"}',
                  },
                },
              ],
            },
            'tool_calls',
          );
        } else if (requests === 5) {
          chunk(
            response,
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'failed-call',
                  type: 'function',
                  function: {
                    name: 'fixture_progress',
                    arguments: '{"path":"missing"}',
                  },
                },
              ],
            },
            'tool_calls',
          );
        } else {
          if (requests === 6)
            assert.match(JSON.stringify(input.messages), /Fixture tool failed/);
          if (requests === 2)
            assert.match(JSON.stringify(input.messages), /Final tool output/);
          if (requests === 3)
            assert.match(JSON.stringify(input.messages), /Inspection complete/);
          chunk(
            response,
            {
              role: 'assistant',
              content:
                requests === 2
                  ? 'Inspection complete.'
                  : requests === 3
                    ? 'Resumed answer.'
                    : 'Cleaned answer.',
            },
            'stop',
          );
        }
        done(response);
      } catch (error) {
        providerErrors.push(error);
        response.destroy();
      }
    });
    t.after(async () => {
      secondText.resolve();
      finishText.resolve();
      secondProgress.resolve();
      finishTool.resolve();
      await manager.close();
      registry.unregisterProvider('conversation-fixture');
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, {recursive: true, force: true});
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    registry.registerProvider('conversation-fixture', {
      api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      apiKey: 'local-test-key',
      models: [
        {
          id: 'worker-model',
          name: 'Conversation fixture',
          reasoning: true,
          input: ['text'],
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
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
          model: 'conversation-fixture/worker-model',
          autoCleanup,
        },
        id =>
          createSessionWorker({
            id,
            parentSessionId: 'conversation-parent',
            name,
            cwd,
            model: registry.find('conversation-fixture', 'worker-model')!,
            modelRegistry: registry,
            thinkingLevel: 'off',
            agentToolsExtension: pi => {
              pi.registerTool({
                name: 'fixture_progress',
                label: 'Fixture progress',
                description: 'Report fixture progress',
                parameters: Type.Object({path: Type.String()}),
                async execute(_id, args, _signal, onUpdate) {
                  if (args.path === 'missing')
                    throw new Error('Fixture tool failed');
                  onUpdate?.({
                    content: [{type: 'text', text: 'Progress 1'}],
                    details: {private: 'private tool details'},
                  });
                  await secondProgress.promise;
                  onUpdate?.({
                    content: [{type: 'text', text: 'Progress 2'}],
                    details: {private: 'private tool details'},
                  });
                  await finishTool.promise;
                  return {
                    content: [{type: 'text', text: 'Final tool output'}],
                    details: {private: 'private tool details'},
                  };
                },
              });
            },
          }),
      );
    const now = new Date().toISOString();
    const dashboard = new DashboardState({
      id: 'conversation-parent',
      name: 'Parent',
      cwd,
      status: 'idle',
      activity: 'Ready',
      startedAt: now,
      updatedAt: now,
    });
    dashboard.updateConversation({
      id: 'parent-message',
      role: 'user',
      text: 'Parent only',
      at: now,
    });
    let notifications = 0;
    manager.subscribe(() => {
      notifications++;
      dashboard.updateTeam(
        manager
          .list()
          .map(agent => ({...agent, ...manager.conversation(agent.id)})),
        [],
      );
    });
    const a = spawn('Initial task');
    await until(() =>
      manager
        .conversation(a.id)
        .conversation.some(message => message.text === 'Inspecting'),
    );
    const first = manager
      .conversation(a.id)
      .conversation.find(message => message.role === 'assistant')!;
    assert.equal(first.streaming, true);
    assert.equal(manager.get(a.id).status, 'running');
    const before = notifications;
    secondText.resolve();
    await until(() =>
      dashboard
        .snapshot()
        .agents[0].conversation.some(
          message => message.text === 'Inspecting the fixture.',
        ),
    );
    assert.ok(
      notifications > before,
      'A second Responding update must notify observers',
    );
    assert.equal(
      manager
        .conversation(a.id)
        .conversation.find(message => message.role === 'assistant')!.id,
      first.id,
    );
    finishText.resolve();
    await until(() =>
      manager
        .conversation(a.id)
        .conversation.some(message => message.text === 'Progress 1'),
    );
    const tool = manager
      .conversation(a.id)
      .conversation.find(message => message.role === 'tool')!;
    assert.equal(tool.status, 'running');
    assert.equal(tool.streaming, true);
    assert.deepEqual(JSON.parse(tool.input!), {path: 'fixture.txt'});
    const progressNotifications = notifications;
    secondProgress.resolve();
    await until(() =>
      manager
        .conversation(a.id)
        .conversation.some(message => message.text === 'Progress 2'),
    );
    assert.ok(
      notifications > progressNotifications,
      'Repeated Using activity must still publish tool progress',
    );
    assert.equal(manager.get(a.id).activity, 'Using fixture_progress');
    assert.equal(manager.get(a.id).status, 'running');
    finishTool.resolve();
    await manager.wait([a.id], {timeoutMs: 5000});
    assert.equal(manager.get(a.id).status, 'completed');
    const complete = manager.conversation(a.id);
    assert.deepEqual(
      complete.conversation.map(message => message.role),
      ['user', 'assistant', 'tool', 'assistant'],
    );
    assert.equal(
      complete.conversation.find(message => message.role === 'tool')!.id,
      tool.id,
    );
    assert.equal(
      complete.conversation.find(message => message.role === 'tool')!.status,
      'completed',
    );
    assert.ok(complete.conversation.every(message => !message.streaming));
    assert.doesNotMatch(
      JSON.stringify(complete),
      /private reasoning|private tool details/,
    );
    assert.equal(
      'conversation' in manager.get(a.id),
      false,
      'Tool records remain compact',
    );
    complete.conversation[0].text = 'mutated accessor';
    dashboard.snapshot().agents[0].conversation[0].text = 'mutated dashboard';
    assert.equal(
      manager.conversation(a.id).conversation[0].text,
      'Initial task',
    );
    assert.equal(
      dashboard.snapshot().agents[0].conversation[0].text,
      'Initial task',
    );
    const ids = manager
      .conversation(a.id)
      .conversation.map(message => message.id);
    await manager.send(a.id, 'Resume the inspection');
    await manager.wait([a.id], {timeoutMs: 5000});
    assert.deepEqual(
      manager
        .conversation(a.id)
        .conversation.slice(0, 4)
        .map(message => message.id),
      ids,
    );
    assert.equal(
      manager.conversation(a.id).conversation.at(-2)?.text,
      'Resume the inspection',
    );
    const aConversation = manager.conversation(a.id);
    const b = spawn('Other task', true);
    await manager.wait([b.id], {timeoutMs: 5000});
    assert.equal(
      manager.conversation(b.id).conversation.at(-1)?.text,
      'Cleaned answer.',
    );
    await assert.rejects(manager.send(b.id, 'More work'), /cleaned up/);
    assert.deepEqual(manager.conversation(a.id), aConversation);
    assert.deepEqual(
      dashboard.snapshot().conversation.map(message => message.text),
      ['Parent only'],
    );
    const c = spawn('Failed tool task', true);
    await manager.wait([c.id], {timeoutMs: 5000});
    const failedTool = manager
      .conversation(c.id)
      .conversation.find(message => message.role === 'tool')!;
    assert.equal(failedTool.status, 'failed');
    assert.match(failedTool.error!, /Fixture tool failed/);
    assert.equal(failedTool.streaming, false);
    assert.equal(manager.get(c.id).status, 'completed');
    await manager.close();
    assert.deepEqual(manager.conversation(a.id), aConversation);
    assert.equal(manager.conversation(b.id).conversation[0].text, 'Other task');
    assert.deepEqual(providerErrors, []);
  },
);

const epoch = Date.parse('2026-01-01T12:00:00Z');
const text = (value: string) => ({type: 'text', text: value});
const message = (role: string, content: unknown, extra = {}) => ({
  role,
  timestamp: epoch,
  content,
  ...extra,
});
function history(messages: object[]): SessionEntry[] {
  return messages.map((message, index) => ({
    type: 'message',
    id: String(index),
    parentId: index ? String(index - 1) : null,
    timestamp: new Date(epoch).toISOString(),
    message,
  })) as SessionEntry[];
}
function emit(conversation: WorkerConversation, type: string, extra: object) {
  return conversation.record({type, ...extra} as AgentSessionEvent);
}

void test('worker message identities survive cloned SDK updates, duplicate completions, same timestamps and restoration', () => {
  const conversation = new WorkerConversation([]);
  const messages = [
    message('user', 'Task'),
    message('assistant', [text('Reply')]),
    message('user', 'Task'),
    message('assistant', [text('Reply')]),
  ];
  for (const source of messages) {
    emit(conversation, 'message_start', {message: source});
    const update = {...source};
    emit(conversation, 'message_update', {message: update});
    const end = {...source};
    emit(conversation, 'message_end', {message: end});
    emit(conversation, 'message_end', {message: end});
  }
  const completed = conversation.snapshot();
  assert.equal(completed.conversation.length, 4);
  assert.equal(
    new Set(completed.conversation.map(message => message.id)).size,
    4,
  );
  const restored = new WorkerConversation(history(messages)).snapshot();
  assert.deepEqual(restored, completed);
  completed.conversation[0].text = 'Mutated';
  assert.equal(conversation.snapshot().conversation[0].text, 'Task');
});

void test('worker history reconciles failed, cancelled and orphan tool results and prevents late progress reopening them', () => {
  const call = (id: string) => ({
    type: 'toolCall',
    id,
    name: 'bash',
    arguments: {command: 'false'},
  });
  const branch = history([
    message('assistant', [call('failed')], {
      stopReason: 'error',
      errorMessage: 'Provider failed',
    }),
    message('assistant', [call('interrupted')]),
    message('toolResult', [text('Operation aborted')], {
      toolCallId: 'cancelled',
      toolName: 'bash',
      isError: true,
    }),
    message('toolResult', [text('Command exited with code 1')], {
      toolCallId: 'orphan',
      toolName: 'bash',
      isError: true,
    }),
  ]);
  const conversation = new WorkerConversation(branch);
  assert.deepEqual(
    conversation
      .snapshot()
      .conversation.filter(message => message.role === 'tool')
      .map(message => [message.toolCallId, message.status]),
    [
      ['failed', 'failed'],
      ['interrupted', 'cancelled'],
      ['cancelled', 'cancelled'],
      ['orphan', 'failed'],
    ],
  );
  assert.ok(
    conversation.snapshot().conversation.every(message => !message.streaming),
  );
  assert.equal(
    emit(conversation, 'tool_execution_update', {
      toolCallId: 'orphan',
      toolName: 'bash',
      args: {},
      partialResult: {content: [text('late progress')]},
    }),
    false,
  );
  assert.equal(
    conversation.snapshot().conversation.at(-1)?.text,
    'Command exited with code 1',
  );
  emit(conversation, 'tool_execution_start', {
    toolCallId: 'running',
    toolName: 'read',
    args: {path: 'pending'},
  });
  conversation.settle(true, 'Cancelled');
  assert.equal(
    conversation.snapshot().conversation.at(-1)?.status,
    'cancelled',
  );
  conversation.begin();
  conversation.settle(false, 'Prompt preflight failed');
  assert.equal(
    conversation.snapshot().conversation.at(-1)?.error,
    'Prompt preflight failed',
  );
});

void test('worker custom message IDs restore without changing ordinary IDs and public history stays bounded', () => {
  const conversation = new WorkerConversation([]);
  const custom = (display: boolean, value: string) =>
    message('custom', [text(value)], {display, customType: 'fixture'});
  const hidden = custom(false, 'private custom message');
  const visible = custom(true, 'Visible custom message');
  const user = message('user', 'Task');
  for (const source of [hidden, visible, user]) {
    emit(conversation, 'message_start', {message: source});
    emit(conversation, 'message_end', {message: source});
  }
  const branch = history([user]);
  branch.unshift(
    ...([hidden, visible].map((source, index) => ({
      type: 'custom_message',
      id: `custom-entry-${index}`,
      parentId: null,
      ...source,
      timestamp: new Date(epoch).toISOString(),
    })) as unknown as SessionEntry[]),
  );
  assert.deepEqual(
    new WorkerConversation(branch)
      .snapshot()
      .conversation.map(message => message.id),
    conversation.snapshot().conversation.map(message => message.id),
  );
  assert.doesNotMatch(
    JSON.stringify(conversation.snapshot()),
    /private custom/,
  );
  for (let index = 0; index < 150; index++) {
    emit(conversation, 'tool_execution_start', {
      toolCallId: String(index),
      toolName: 'fixture',
      args: {content: 'I'.repeat(12000), thinking: 'private input reasoning'},
    });
    emit(conversation, 'tool_execution_update', {
      toolCallId: String(index),
      toolName: 'fixture',
      args: {},
      partialResult: {
        content: [
          text('O'.repeat(20000)),
          {type: 'thinking', thinking: 'private result reasoning'},
          {type: 'image', data: 'private image'},
        ],
        details: {private: 'private details'},
      },
    });
  }
  const snapshot = conversation.snapshot();
  assert.ok(snapshot.conversationTruncated);
  assert.ok(snapshot.conversation.length <= 100);
  const size = (message: ConversationMessage) =>
    message.text.length +
    (message.input?.length ?? 0) +
    (message.error?.length ?? 0);
  assert.ok(
    snapshot.conversation.reduce((sum, message) => sum + size(message), 0) <=
      160000,
  );
  assert.ok(snapshot.conversation.every(message => message.truncated));
  assert.doesNotMatch(JSON.stringify(snapshot), /private/);
});
