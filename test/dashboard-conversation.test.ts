import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from '@earendil-works/pi-coding-agent';
import type {
  AgentSessionController,
  AgentSessionSnapshot,
} from '../src/agents/team.ts';
import {observeDashboardSession} from '../src/dashboard/observe.ts';
import {DashboardState} from '../src/dashboard/state.ts';

type Handler = (event: never, ctx: ExtensionContext) => unknown;
const epoch = Date.parse('2026-01-01T12:00:00Z');
const at = (offset: number) => new Date(epoch + offset).toISOString();
const text = (value: string) => ({type: 'text', text: value});
const call = (id: string, name: string, args: unknown) => ({
  type: 'toolCall',
  id,
  name,
  arguments: args,
});
const message = (
  role: string,
  timestamp: number,
  content: unknown,
  extra = {},
) => ({role, timestamp: epoch + timestamp, content, ...extra});

function observer(existingState?: DashboardState) {
  const handlers = new Map<string, Handler[]>();
  let branch: SessionEntry[] = [];
  let current!: DashboardState;
  const pi = {
    getThinkingLevel: () => 'off',
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: '/fixture',
    isIdle: () => true,
    getContextUsage: () => undefined,
    sessionManager: {
      getSessionName: () => 'Fixture',
      getSessionId: () => 'fixture',
      getSessionFile: () => '/fixture/session.jsonl',
      getHeader: () => ({timestamp: at(0)}),
      getBranch: () => branch,
    },
  } as unknown as ExtensionContext;
  let team: AgentSessionSnapshot | undefined;
  let teamListener: (() => void) | undefined;
  const control = {
    snapshot: () => team,
    deliverySnapshot: () => team,
    subscribe: (listener: () => void) => {
      teamListener = listener;
      return () => {
        teamListener = undefined;
      };
    },
  } as unknown as AgentSessionController;
  const customMessages = observeDashboardSession(
    pi,
    control,
    state => {
      current = state;
    },
    existingState,
  );
  async function emit(type: string, event: object = {}) {
    for (const handler of handlers.get(type) ?? [])
      await handler({...event, type} as never, ctx);
  }
  function history(messages: ReturnType<typeof message>[]) {
    branch = messages.map((item, index) => ({
      type: item.role === 'custom' ? 'custom_message' : 'message',
      ...(item.role === 'custom' ? item : {}),
      id: `entry-${index}`,
      parentId: index ? `entry-${index - 1}` : null,
      timestamp: new Date(item.timestamp).toISOString(),
      message: item,
    })) as unknown as SessionEntry[];
  }
  return {
    emit,
    history,
    customMessages,
    ctx,
    team(snapshot: AgentSessionSnapshot) {
      team = snapshot;
      teamListener?.();
    },
    get state() {
      return current;
    },
  };
}

void test('conversation streams parallel tools in call order and reconciles their result messages and reload', async () => {
  const fixture = observer();
  await fixture.emit('session_start');
  await fixture.emit('agent_start');
  const user = message('user', 1, 'Inspect the project');
  await fixture.emit('message_start', {message: user});
  await fixture.emit('message_end', {message: user});
  const assistant = message('assistant', 2, []);
  await fixture.emit('message_start', {message: assistant});
  assert.equal(fixture.state.snapshot().session.activity, 'Thinking');
  assert.equal(fixture.state.snapshot().conversation.length, 1);
  assistant.content = [call('a', 'bash', {command: 'git status --short'})];
  await fixture.emit('message_update', {message: assistant});
  assert.equal(fixture.state.snapshot().conversation.length, 1);
  assistant.content = [
    text('I will inspect both files.'),
    call('a', 'bash', {timeout: 10, command: 'git status --short'}),
    call('b', 'read', {limit: 20, path: 'README.md'}),
  ];
  await fixture.emit('message_update', {message: assistant});
  await fixture.emit('message_end', {message: assistant});
  for (const [toolCallId, toolName, args] of [
    ['a', 'bash', {command: 'git status --short', timeout: 10}],
    ['b', 'read', {path: 'README.md', limit: 20}],
  ] as const)
    await fixture.emit('tool_execution_start', {toolCallId, toolName, args});
  assert.equal(fixture.state.snapshot().session.activity, 'Using bash, read');
  await fixture.emit('tool_execution_update', {
    toolCallId: 'a',
    toolName: 'bash',
    args: {},
    partialResult: {
      content: [text('M src/a.ts')],
      details: {provider: 'hidden'},
    },
  });
  const partial = fixture.state.conversationMessage('tool-a')!;
  assert.equal(partial.text, 'M src/a.ts');
  assert.equal(partial.status, 'running');
  assert.equal(partial.streaming, true);
  assert.deepEqual(JSON.parse(partial.input!), {
    command: 'git status --short',
    timeout: 10,
  });
  await fixture.emit('tool_execution_update', {
    toolCallId: 'a',
    toolName: 'bash',
    args: {},
    partialResult: {content: [text('M src/a.ts\nM src/b.ts')]},
  });
  assert.equal(
    fixture.state.conversationMessage('tool-a')?.text,
    'M src/a.ts\nM src/b.ts',
  );
  const b = message('toolResult', 4, [text('Project readme')], {
    toolCallId: 'b',
    toolName: 'read',
    isError: false,
  });
  await fixture.emit('tool_execution_end', {
    toolCallId: 'b',
    toolName: 'read',
    result: b,
    isError: false,
  });
  assert.equal(fixture.state.snapshot().session.activity, 'Using bash');
  const a = message('toolResult', 5, [text('M src/a.ts\nM src/b.ts')], {
    toolCallId: 'a',
    toolName: 'bash',
    isError: false,
  });
  await fixture.emit('tool_execution_end', {
    toolCallId: 'a',
    toolName: 'bash',
    result: a,
    isError: false,
  });
  const finishedAt = fixture.state.conversationMessage('tool-a')?.finishedAt;
  for (const result of [a, b]) {
    await fixture.emit('message_start', {message: result});
    await fixture.emit('message_end', {message: result});
  }
  await fixture.emit('tool_execution_end', {
    toolCallId: 'a',
    toolName: 'bash',
    result: a,
    isError: false,
  });
  await fixture.emit('tool_execution_update', {
    toolCallId: 'a',
    toolName: 'bash',
    args: {},
    partialResult: {content: [text('late')]},
  });
  const answer = message('assistant', 6, [text('Inspection complete.')]);
  await fixture.emit('message_start', {message: answer});
  await fixture.emit('message_end', {message: answer});
  await fixture.emit('agent_settled');
  const completed = fixture.state.snapshot();
  assert.deepEqual(
    completed.conversation.map(item => item.role),
    ['user', 'assistant', 'tool', 'tool', 'assistant'],
  );
  assert.deepEqual(
    completed.conversation
      .filter(item => item.role === 'tool')
      .map(item => [item.toolCallId, item.status, item.at]),
    [
      ['a', 'completed', at(2)],
      ['b', 'completed', at(2)],
    ],
  );
  assert.equal(
    fixture.state.conversationMessage('tool-a')?.finishedAt,
    finishedAt,
  );
  assert.ok(completed.conversation.every(item => !item.streaming));
  assert.equal(
    completed.events.filter(item => item.message === 'bash finished').length,
    1,
  );
  fixture.history([user, assistant, a, b, answer]);
  await fixture.emit('session_tree');
  const restored = fixture.state.snapshot();
  assert.deepEqual(
    restored.conversation.map(item => [
      item.id,
      item.role,
      item.text,
      item.input,
      item.status,
      item.at,
    ]),
    completed.conversation.map(item => [
      item.id,
      item.role,
      item.text,
      item.input,
      item.status,
      item.at,
    ]),
  );
  await fixture.emit('message_end', {message: a});
  assert.equal(fixture.state.snapshot().conversation.length, 5);
  assert.equal(
    fixture.state.snapshot().session.response,
    'Inspection complete.',
  );
});

void test('same-millisecond messages retain distinct IDs through completion and history restoration', async () => {
  const fixture = observer();
  await fixture.emit('session_start');
  const messages = [
    message('user', 1, 'Same input'),
    message('assistant', 2, [text('Same reply')]),
    message('user', 1, 'Same input'),
    message('assistant', 2, [text('Same reply')]),
  ];
  for (const item of messages) {
    await fixture.emit('message_start', {message: item});
    await fixture.emit('message_end', {message: item});
    await fixture.emit('message_end', {message: item});
  }
  const completed = fixture.state.snapshot().conversation;
  assert.equal(completed.length, 4);
  assert.equal(new Set(completed.map(item => item.id)).size, 4);
  assert.deepEqual(
    completed.map(item => item.role),
    ['user', 'assistant', 'user', 'assistant'],
  );
  fixture.history(messages);
  await fixture.emit('session_tree');
  assert.deepEqual(
    fixture.state.snapshot().conversation.map(item => item.id),
    completed.map(item => item.id),
  );
  await fixture.emit('message_end', {message: messages.at(-1)});
  assert.equal(fixture.state.snapshot().conversation.length, 4);
});

void test('tool errors, aborted calls, incomplete streams and shutdown settle without running rows', async () => {
  const fixture = observer();
  await fixture.emit('session_start');
  await fixture.emit('agent_start');
  await fixture.emit('tool_execution_start', {
    toolCallId: 'failed',
    toolName: 'bash',
    args: {command: 'false'},
  });
  await fixture.emit('tool_execution_end', {
    toolCallId: 'failed',
    toolName: 'bash',
    isError: true,
    result: {content: [text('Command exited with code 1')]},
  });
  assert.equal(
    fixture.state.conversationMessage('tool-failed')?.status,
    'failed',
  );
  assert.equal(
    fixture.state.conversationMessage('tool-failed')?.error,
    'Command exited with code 1',
  );
  await fixture.emit('tool_execution_start', {
    toolCallId: 'aborted',
    toolName: 'bash',
    args: {command: 'sleep 60'},
  });
  await fixture.emit('tool_execution_end', {
    toolCallId: 'aborted',
    toolName: 'bash',
    isError: true,
    result: {content: [text('Operation aborted')]},
  });
  assert.equal(
    fixture.state.conversationMessage('tool-aborted')?.status,
    'cancelled',
  );
  await fixture.emit('tool_execution_start', {
    toolCallId: 'unfinished',
    toolName: 'read',
    args: {path: 'pending.txt'},
  });
  const assistant = message('assistant', 8, [text('Partial answer')]);
  await fixture.emit('message_start', {message: assistant});
  await fixture.emit('agent_settled');
  const settled = fixture.state.snapshot();
  assert.ok(
    settled.conversation.every(
      item => !item.streaming && item.status !== 'running',
    ),
  );
  assert.equal(
    fixture.state.conversationMessage('tool-unfinished')?.status,
    'cancelled',
  );
  assert.ok(fixture.state.conversationMessage('tool-unfinished')?.finishedAt);
  assert.equal(settled.session.status, 'idle');
  const broken = message(
    'assistant',
    9,
    [call('broken', 'write', {path: 'never.txt'})],
    {stopReason: 'error', errorMessage: 'Provider failed'},
  );
  await fixture.emit('message_start', {message: broken});
  await fixture.emit('message_end', {message: broken});
  assert.equal(
    fixture.state.conversationMessage('tool-broken')?.status,
    'failed',
  );
  assert.equal(fixture.state.snapshot().session.error, 'Provider failed');
  await fixture.emit('tool_execution_start', {
    toolCallId: 'closing',
    toolName: 'read',
    args: {path: 'closing.txt'},
  });
  await fixture.emit('session_shutdown');
  assert.equal(
    fixture.state.conversationMessage('tool-closing')?.status,
    'cancelled',
  );
  assert.equal(fixture.state.snapshot().session.status, 'closed');
});

void test('restores tool results without calls and cancels unfinished history calls', async () => {
  const fixture = observer();
  fixture.history([
    message('assistant', 1, [call('lost', 'read', {path: 'lost.txt'})]),
    message('toolResult', 2, [text('Unavailable')], {
      toolCallId: 'orphan',
      toolName: 'read',
      isError: true,
    }),
    message(
      'assistant',
      3,
      [call('cancelled', 'bash', {command: 'sleep 10'})],
      {stopReason: 'aborted', errorMessage: 'Operation aborted'},
    ),
  ]);
  await fixture.emit('session_start');
  assert.deepEqual(
    fixture.state
      .snapshot()
      .conversation.filter(item => item.role === 'tool')
      .map(item => [item.toolCallId, item.status, item.text]),
    [
      ['lost', 'cancelled', ''],
      ['orphan', 'failed', 'Unavailable'],
      ['cancelled', 'cancelled', ''],
    ],
  );
  assert.ok(
    fixture.state
      .snapshot()
      .conversation.filter(item => item.role === 'tool')
      .every(item => item.finishedAt),
  );
});

void test('public conversation omits thinking, provider details and images while inputs preserve argument keys', async () => {
  const fixture = observer();
  await fixture.emit('session_start');
  const assistant = message('assistant', 1, [
    {
      type: 'thinking',
      thinking: 'secret reasoning',
      signature: 'secret signature',
    },
    {type: 'image', data: 'secret image base64'},
    text('Visible commentary'),
  ]);
  await fixture.emit('message_start', {message: assistant});
  await fixture.emit('message_update', {message: assistant});
  await fixture.emit('message_end', {message: assistant});
  for (const [id, args] of [
    ['command', {timeout: 5, command: 'pwd'}],
    ['path', {content: 'new file', path: 'src/file.ts'}],
    ['url', {method: 'GET', url: 'https://example.com'}],
  ] as const) {
    await fixture.emit('tool_execution_start', {
      toolCallId: id,
      toolName: 'fixture',
      args,
    });
    assert.deepEqual(
      JSON.parse(fixture.state.conversationMessage(`tool-${id}`)!.input!),
      args,
    );
  }
  await fixture.emit('tool_execution_start', {
    toolCallId: 'images',
    toolName: 'fixture',
    args: {
      prompt: 'Make an image',
      image: {type: 'image', data: 'secret image base64'},
      base64: 'secret encoded input',
      thinking: 'secret reasoning',
      data: 'Useful request data',
      attachment: {mimeType: 'image/png', data: 'secret image base64'},
    },
  });
  await fixture.emit('tool_execution_end', {
    toolCallId: 'images',
    toolName: 'fixture',
    isError: false,
    result: {
      content: [
        text('Visible result'),
        {type: 'image', data: 'secret image base64'},
        {type: 'thinking', thinking: 'secret reasoning'},
        text('data:image/png;base64,' + 'A'.repeat(300)),
      ],
      details: {providerMetadata: 'secret provider payload'},
    },
  });
  const json = JSON.stringify(fixture.state.snapshot().conversation);
  assert.match(json, /Visible commentary/);
  assert.match(json, /Visible result/);
  assert.match(json, /Useful request data/);
  assert.doesNotMatch(json, /secret|data:image|A{100}/);
  const empty = message('assistant', 2, [
    {type: 'thinking', thinking: 'hidden'},
  ]);
  await fixture.emit('message_start', {message: empty});
  await fixture.emit('message_update', {message: empty});
  // Tools still executing take precedence over Thinking activity.
  assert.equal(fixture.state.snapshot().session.activity, 'Using fixture');
  await fixture.emit('agent_settled');
  await fixture.emit('message_start', {message: empty});
  await fixture.emit('message_update', {message: empty});
  assert.equal(fixture.state.snapshot().session.activity, 'Thinking');
});

void test('visible extension messages appear live and restore as assistant text without measured usage', async () => {
  const fixture = observer();
  await fixture.emit('session_start');
  const report = message(
    'custom',
    1,
    [
      text('Session: Renamed fixture'),
      {type: 'image', data: 'secret image data'},
    ],
    {
      customType: 'desktop-session',
      display: true,
      details: {secret: 'provider details'},
    },
  );
  await fixture.emit('message_start', {message: report});
  await fixture.emit('message_end', {message: report});
  const hidden = message('custom', 2, 'Hidden extension message', {
    customType: 'hidden',
    display: false,
  });
  await fixture.emit('message_start', {message: hidden});
  await fixture.emit('message_end', {message: hidden});
  assert.deepEqual(
    fixture.state
      .snapshot()
      .conversation.map(item => [item.id, item.role, item.text]),
    [['custom-1', 'assistant', 'Session: Renamed fixture']],
  );
  fixture.history([report, hidden]);
  await fixture.emit('session_tree');
  assert.deepEqual(
    fixture.state
      .snapshot()
      .conversation.map(item => [item.id, item.role, item.text]),
    [['custom-1', 'assistant', 'Session: Renamed fixture']],
  );
  const emitted = {
    role: 'custom' as const,
    timestamp: epoch + 3,
    customType: 'extension',
    content: 'Visible configured extension message',
    display: true,
  };
  // Idle SDK custom messages are persisted before their session events, which bypass pi.on.
  fixture.history([report, hidden, emitted]);
  fixture.customMessages(emitted, fixture.ctx);
  fixture.customMessages(emitted, fixture.ctx);
  assert.deepEqual(
    fixture.state.snapshot().conversation.map(item => item.text),
    ['Session: Renamed fixture', 'Visible configured extension message'],
  );
  assert.equal(fixture.state.snapshot().usage.calls.length, 0);
  await fixture.emit('session_tree');
  assert.deepEqual(
    fixture.state.snapshot().conversation.map(item => item.id),
    ['custom-1', 'custom-3'],
  );
  assert.doesNotMatch(
    JSON.stringify(fixture.state.snapshot().conversation),
    /secret|Hidden extension/,
  );
  let notifications = 0;
  fixture.state.subscribe(() => notifications++);
  await fixture.emit('session_shutdown', {reason: 'reload'});
  const reloaded = observer(fixture.state);
  reloaded.history([report, hidden, emitted]);
  await reloaded.emit('session_start');
  assert.equal(
    reloaded.state,
    fixture.state,
    'reload preserves the state held by the hub',
  );
  assert.equal(reloaded.state.snapshot().session.status, 'idle');
  assert.ok(
    notifications > 1,
    'existing hub subscribers receive reload updates',
  );
  assert.deepEqual(
    reloaded.state.snapshot().conversation.map(item => item.id),
    ['custom-1', 'custom-3'],
  );
});

void test('shutdown flushes a pending team publication before detaching state', async () => {
  const fixture = observer();
  await fixture.emit('session_start');
  fixture.team({
    sessionId: 'fixture',
    agents: [
      {
        id: 'agent-final',
        name: 'Final agent',
        task: 'Finish the work',
        cwd: '/fixture',
        model: 'test/model',
        status: 'completed',
        activity: 'Completed',
        output: 'Final output',
        createdAt: at(1),
        finishedAt: at(2),
        conversation: [
          {
            id: 'agent-answer',
            role: 'assistant',
            text: 'Final output',
            at: at(2),
          },
        ],
        conversationTruncated: false,
      },
    ],
    messages: [
      {
        id: 'message-final',
        createdAt: at(2),
        from: {id: 'agent-final', name: 'Final agent'},
        message: 'Final finding',
      },
    ],
    changes: [
      {
        id: 'change-final',
        unitId: 'agent-final',
        unitName: 'Final agent',
        path: '/fixture/result.txt',
        tool: 'write',
        at: at(2),
        diff: '+result',
        summary: 'Created file',
      },
    ],
  });
  await fixture.emit('session_shutdown');
  const snapshot = fixture.state.snapshot();
  assert.equal(snapshot.session.status, 'closed');
  assert.equal(snapshot.agents[0].output, 'Final output');
  assert.equal(snapshot.changes[0].id, 'change-final');
  assert.ok(
    snapshot.events.some(event => event.message.includes('Final finding')),
  );
});

void test('reload archives reused worker history before a replacement controller has a team', async () => {
  for (const shutdown of [false, true]) {
    const fixture = observer();
    await fixture.emit('session_start');
    fixture.state.updateTeam(
      ['completed', 'running', 'queued'].map((status, index) => ({
        id: `old-${status}`,
        name: status,
        task: 'Retain findings',
        cwd: '/fixture',
        model: 'test/model',
        status: status as 'completed' | 'running' | 'queued',
        activity: status,
        resumable: true,
        createdAt: at(index),
        output: status === 'completed' ? 'Retained result' : undefined,
        conversation: [
          {
            id: `tool-${status}`,
            at: at(index),
            role: 'tool' as const,
            text: 'Retained tool output',
            status:
              status === 'completed'
                ? ('completed' as const)
                : ('running' as const),
            streaming: status !== 'completed',
          },
        ],
      })),
      [],
    );
    if (shutdown) await fixture.emit('session_shutdown', {reason: 'reload'});
    const reloaded = observer(fixture.state);
    await reloaded.emit('session_start', {reason: 'reload'});
    assert.strictEqual(reloaded.state, fixture.state);
    const agents = reloaded.state.snapshot().agents;
    assert.equal(agents.length, 3);
    assert.ok(agents.every(agent => agent.resumable === false));
    assert.ok(
      agents.every(agent => ['completed', 'cancelled'].includes(agent.status)),
    );
    assert.equal(
      agents.find(agent => agent.id === 'old-completed')!.output,
      'Retained result',
    );
    for (const agent of agents) {
      assert.equal(agent.conversation[0].streaming, false);
      assert.equal(agent.conversation[0].status, agent.status);
      assert.equal(agent.conversation[0].text, 'Retained tool output');
    }
    await reloaded.emit('session_shutdown');
  }
});

void test('agent wait flushes a throttled terminal worker state with its result', async () => {
  const fixture = observer();
  const worker = {
    id: 'awaited-agent',
    name: 'Awaited agent',
    task: 'Finish before agent_wait returns',
    cwd: '/fixture',
    model: 'test/model',
    status: 'running' as const,
    activity: 'Working',
    createdAt: at(1),
    conversation: [
      {
        id: 'agent-task',
        role: 'user' as const,
        text: 'Finish before agent_wait returns',
        at: at(1),
      },
    ],
    conversationTruncated: false,
  };
  fixture.team({
    sessionId: 'fixture',
    agents: [worker],
    messages: [],
    changes: [],
  });
  await fixture.emit('session_start');
  assert.equal(fixture.state.snapshot().agents[0].status, 'running');

  fixture.team({
    sessionId: 'fixture',
    agents: [
      {
        ...worker,
        status: 'completed',
        activity: 'Completed',
        output: 'Finished',
        finishedAt: at(2),
      },
    ],
    messages: [],
    changes: [],
  });
  await fixture.emit('tool_execution_end', {
    toolCallId: 'wait-call',
    toolName: 'agent_wait',
    result: {content: [text('Finished')]},
    isError: false,
  });

  const snapshot = fixture.state.snapshot();
  assert.equal(snapshot.agents[0].status, 'completed');
  assert.equal(snapshot.agents[0].output, 'Finished');
  assert.equal(
    snapshot.conversation.find(message => message.toolCallId === 'wait-call')
      ?.status,
    'completed',
  );
});

void test('conversation bounds stored input, output, errors and total history and isolates snapshots', () => {
  const state = new DashboardState({
    id: 'bounds',
    cwd: '/fixture',
    name: 'Bounds',
    status: 'idle',
    activity: 'Ready',
    startedAt: at(0),
    updatedAt: at(0),
  });
  const source = {
    id: 'tool-a',
    role: 'tool' as const,
    at: at(1),
    text: 'Output line\n'.repeat(3000),
    input: 'Input line\n'.repeat(3000),
    error: 'Error line\n'.repeat(3000),
    toolName: 'bash',
    status: 'running' as const,
  };
  state.updateConversation(source);
  source.text = 'mutated input';
  const snapshot = state.snapshot();
  assert.ok(snapshot.conversation[0].text.length < 16100);
  assert.ok(snapshot.conversation[0].input!.length < 8100);
  assert.ok(snapshot.conversation[0].error!.length < 4100);
  assert.ok(snapshot.conversation[0].truncated);
  snapshot.conversation[0].text = 'mutated snapshot';
  state.conversationMessage('tool-a')!.text = 'mutated read';
  assert.match(state.snapshot().conversation[0].text, /^Output line/);
  state.replaceConversation(
    Array.from({length: 500}, (_, index) => ({
      ...source,
      id: String(index),
      text: 'Output line\n'.repeat(3000),
    })),
  );
  const bounded = state.snapshot();
  assert.ok(bounded.conversation.length <= 100);
  assert.ok(
    bounded.conversation.reduce(
      (sum, item) =>
        sum +
        item.text.length +
        (item.input?.length ?? 0) +
        (item.error?.length ?? 0),
      0,
    ) <= 160000,
  );
  assert.equal(bounded.conversationTruncated, true);
  const last = bounded.conversation.at(-1)!;
  state.updateConversation({
    ...last,
    text: 'Finished',
    status: 'completed',
    finishedAt: at(2),
  });
  assert.equal(
    state.snapshot().conversation.filter(item => item.id === last.id).length,
    1,
  );
  assert.equal(state.conversationMessage(last.id)?.text, 'Finished');
  state.settleConversation();
  assert.ok(
    state.snapshot().conversation.every(item => item.status !== 'running'),
  );
});

void test('state batches publications, caches delivery snapshots and suppresses repeated values', () => {
  const state = new DashboardState({
    id: 'delivery',
    cwd: '/fixture',
    name: 'Delivery',
    status: 'idle',
    activity: 'Ready',
    startedAt: at(0),
    updatedAt: at(0),
  });
  const initial = state.deliverySnapshot();
  assert.equal(state.deliverySnapshot(), initial);
  let notifications = 0;
  state.subscribe(() => notifications++);
  state.batch(() => {
    state.updateSession({status: 'running', activity: 'Responding'});
    state.updateConversation({
      id: 'answer',
      role: 'assistant',
      text: 'Partial answer',
      at: at(1),
      streaming: true,
    });
  });
  assert.equal(notifications, 1);
  const delivered = state.deliverySnapshot();
  assert.notEqual(delivered, initial);
  assert.equal(state.deliverySnapshot(), delivered);
  state.updateSession({status: 'running', activity: 'Responding'});
  state.updateConversation({...delivered.conversation[0]});
  assert.equal(notifications, 1);
  const isolated = state.snapshot();
  isolated.session.activity = 'Mutated';
  isolated.conversation[0].text = 'Mutated';
  assert.equal(state.deliverySnapshot().session.activity, 'Responding');
  assert.equal(state.deliverySnapshot().conversation[0].text, 'Partial answer');
});

void test('assistant stream ignores non-display deltas and stops publishing after its preview is full', async () => {
  const fixture = observer();
  await fixture.emit('session_start');
  const assistant = message('assistant', 1, []);
  await fixture.emit('message_start', {message: assistant});
  let notifications = 0;
  fixture.state.subscribe(() => notifications++);
  assistant.content = [{type: 'thinking', thinking: 'private'}];
  await fixture.emit('message_update', {
    message: assistant,
    assistantMessageEvent: {
      type: 'thinking_delta',
      contentIndex: 0,
      delta: 'private',
      partial: assistant,
    },
  });
  assert.equal(notifications, 0);
  assistant.content = [text('Visible')];
  await fixture.emit('message_update', {
    message: assistant,
    assistantMessageEvent: {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'Visible',
      partial: assistant,
    },
  });
  assert.equal(notifications, 1);
  assert.equal(fixture.state.snapshot().session.response, 'Visible');
  await fixture.emit('message_update', {
    message: assistant,
    assistantMessageEvent: {
      type: 'text_end',
      contentIndex: 0,
      content: 'Visible',
      partial: assistant,
    },
  });
  assert.equal(notifications, 1);
  assistant.content = [text('x'.repeat(17000))];
  await fixture.emit('message_update', {
    message: assistant,
    assistantMessageEvent: {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'x'.repeat(16993),
      partial: assistant,
    },
  });
  assert.equal(notifications, 2);
  assert.equal(fixture.state.snapshot().conversation[0].truncated, true);
  assistant.content = [text('x'.repeat(18000))];
  await fixture.emit('message_update', {
    message: assistant,
    assistantMessageEvent: {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'x'.repeat(1000),
      partial: assistant,
    },
  });
  assert.equal(notifications, 2);
});

void test('agent conversations project separate bounded copies and preserve history truncation across team updates', () => {
  const state = new DashboardState({
    id: 'agent-parent',
    name: 'Parent',
    cwd: '/fixture',
    status: 'idle',
    activity: 'Ready',
    startedAt: at(0),
    updatedAt: at(0),
  });
  state.updateConversation({
    id: 'parent-user',
    role: 'user',
    text: 'Parent task',
    at: at(0),
  });
  const conversation = [
    {
      id: 'agent-tool',
      role: 'tool' as const,
      toolName: 'bash',
      text: 'Agent output\n'.repeat(2000),
      input: 'Agent input\n'.repeat(1000),
      error: 'Agent error\n'.repeat(1000),
      status: 'failed' as const,
      at: at(1),
    },
  ];
  const agent = {
    id: 'agent-a',
    name: 'Agent A',
    task: 'Agent task',
    cwd: '/fixture',
    model: 'test/model',
    status: 'failed' as const,
    activity: 'Failed',
    createdAt: at(0),
    conversation,
    conversationTruncated: true,
  };
  state.updateTeam(
    [
      agent,
      {
        ...agent,
        id: 'agent-b',
        name: 'Agent B',
        task: 'Other task',
        conversation: undefined,
        conversationTruncated: undefined,
      },
    ],
    [],
  );
  conversation[0].text = 'Mutated source';
  const projected = state.snapshot();
  assert.equal(projected.agents[0].conversationTruncated, true);
  assert.ok(projected.agents[0].conversation[0].truncated);
  assert.ok(projected.agents[0].conversation[0].text.length < 16100);
  assert.ok(projected.agents[0].conversation[0].input!.length < 8100);
  assert.ok(projected.agents[0].conversation[0].error!.length < 4100);
  projected.agents[0].conversation[0].text = 'Mutated snapshot';
  projected.agents[0].conversation.length = 0;
  assert.match(
    state.snapshot().agents[0].conversation[0].text,
    /^Agent output/,
  );
  assert.equal(projected.agents[1].conversation[0].text, 'Other task');
  assert.equal(projected.agents[1].conversationTruncated, false);
  assert.equal(state.snapshot().conversation[0].text, 'Parent task');
  state.updateTeam([state.snapshot().agents[0]], []);
  assert.equal(state.snapshot().agents[0].conversationTruncated, true);
});
