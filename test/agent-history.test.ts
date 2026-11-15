import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  ModelRuntime,
  ModelRegistry,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionToolContext,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {registerAgentTools} from '../src/tools/agents.ts';
import {createSessionWorker} from '../src/agents/session.ts';
import {AgentHistoryStore, type AgentHistory} from '../src/agents/history.ts';
import type {AgentRecord} from '../src/agents/orchestrator.ts';
import {createDefaultAgentProfile} from '../src/agents/templates.ts';
import {saveToolSettings} from '../src/tools/settings.ts';
import {createDashboardParent} from '../src/dashboard/parent.ts';

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function parent(
  sessionManager: SessionManager,
  modelRegistry: ModelRegistry,
  createWorker = createSessionWorker,
) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition>();
  const ctx = {
    cwd: sessionManager.getCwd(),
    hasUI: false,
    sessionManager,
    modelRegistry,
    model: modelRegistry.find('history-fixture', 'worker'),
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
  const control = registerAgentTools(
    {
      on(name: string, handler: Handler) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      registerTool(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
      registerCommand() {},
      getThinkingLevel: () => 'off',
      events: {on() {}, emit() {}},
    } as unknown as ExtensionAPI,
    createWorker,
  );
  const emit = async (name: string) => {
    for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
  };
  const execute = (name: string, params: object) =>
    tools.get(name)!.execute('call', params, undefined, undefined, {
      ...ctx,
      tools: [],
      async executeTool() {
        throw new Error('Unexpected nested tool');
      },
    } as ExtensionToolContext);
  return {control, ctx, emit, execute};
}

void test(
  'parent reopening restores completed history, inbox and conversations and lazily continues the original Pi worker',
  {timeout: 20000},
  async t => {
    const root = await mkdtemp(join(tmpdir(), 'varisdev-agent-history-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'config');
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(cwd, {recursive: true});
    await mkdir(agentDir, {recursive: true});
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    registry.registerProvider('history-fixture', {
      api: 'openai-completions',
      apiKey: 'fixture-key',
      baseUrl: 'https://history.invalid/v1',
      models: [
        {
          id: 'worker',
          name: 'Worker',
          reasoning: false,
          input: ['text'],
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          contextWindow: 128000,
          maxTokens: 1000,
        },
      ],
    });
    const requests: {messages: unknown[]}[] = [];
    t.mock.method(
      globalThis,
      'fetch',
      async (_url: unknown, options?: RequestInit) => {
        requests.push(JSON.parse(String(options?.body)));
        return new Response(
          `data: ${JSON.stringify({id: 'reply', object: 'chat.completion.chunk', created: 1, model: 'worker', choices: [{index: 0, delta: {role: 'assistant', content: requests.length === 1 ? 'The door is blue.' : 'Still blue.'}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`,
          {headers: {'content-type': 'text/event-stream'}},
        );
      },
    );
    let creations = 0;
    const createWorker: typeof createSessionWorker = async options => {
      creations++;
      return createSessionWorker(options);
    };
    const saved = SessionManager.create(cwd, join(root, 'parents'));
    saved.appendMessage({
      role: 'user',
      content: 'Main task',
      timestamp: Date.now(),
    });
    let current = parent(saved, registry, createWorker);
    let dashboard:
      Awaited<ReturnType<typeof createDashboardParent>> | undefined;
    const title = process.title;
    t.after(async () => {
      await dashboard?.close();
      await current.emit('session_shutdown');
      process.title = title;
      registry.unregisterProvider('history-fixture');
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, {recursive: true, force: true});
    });
    await saveToolSettings('agents', {allowedModels: null});
    await current.emit('session_start');
    const spawned = await current.execute('agent_spawn', {
      name: 'Remember',
      task: 'Remember the blue door.',
      instructions: 'Retain the chosen color.',
    });
    const id = (spawned.details as {agents: AgentRecord[]}).agents[0].id;
    await current.execute('agent_wait', {ids: [id]});
    const original = current.control.snapshot()!.agents[0];
    assert.equal(original.output, 'The door is blue.');
    const message = current.control
      .getTeam(current.ctx)
      .storeMessage({from: {id, name: 'Remember'}, message: 'Saved finding'});
    const change = {
      id: 'saved-change',
      unitId: id,
      unitName: 'Remember',
      path: join(cwd, 'door.txt'),
      tool: 'write',
      at: new Date().toISOString(),
      diff: '+blue',
      summary: 'Created door.txt',
    };
    current.control.getTeam(current.ctx).storeChange(change);
    await current.emit('session_shutdown');
    const persisted = new AgentHistoryStore(
      agentDir,
      saved.getSessionId(),
    ).read()!;
    assert.equal(persisted.agents[0].resumable, true);
    assert.equal(persisted.agents[0].sessionFile, original.sessionFile);

    current = parent(
      SessionManager.open(saved.getSessionFile()!),
      registry,
      createWorker,
    );
    await current.emit('session_start');
    assert.equal(creations, 1);
    const restored = current.control.snapshot()!;
    assert.equal(restored.agents[0].status, 'completed');
    assert.equal(restored.agents[0].resumable, true);
    assert.deepEqual(restored.agents[0].conversation, original.conversation);
    assert.deepEqual(restored.messages, [message]);
    assert.deepEqual(restored.changes, [change]);
    assert.deepEqual(
      current.control.getTeam(current.ctx).listMessages({after: 0}),
      {messages: [message], nextAfter: 1, hasMore: false},
    );
    const history = await current.execute('agent_list', {view: 'history'});
    assert.equal((history.details as {agents: AgentRecord[]}).agents[0].id, id);
    assert.match(
      JSON.stringify((await current.execute('agent_status', {id})).content),
      /The door is blue/,
    );
    await current.execute('agent_send', {
      id,
      message: 'What color was the door?',
    });
    await current.execute('agent_wait', {ids: [id]});
    assert.equal(creations, 2);
    assert.equal(requests.length, 2);
    assert.match(
      JSON.stringify(requests[1].messages),
      /Remember the blue door/,
    );
    assert.match(JSON.stringify(requests[1].messages), /The door is blue/);
    assert.equal(
      current.control.snapshot()!.agents[0].sessionFile,
      original.sessionFile,
    );
    assert.equal(current.control.snapshot()!.agents[0].output, 'Still blue.');
    assert.match(
      await readFile(original.sessionFile!, 'utf8'),
      /What color was the door/,
    );
    await current.emit('session_shutdown');

    dashboard = await createDashboardParent(
      {cwd, resume: {id: saved.getSessionId(), path: saved.getSessionFile()!}},
      {
        model: registry.find('history-fixture', 'worker')!,
        modelRegistry: registry,
        thinkingLevel: 'off',
      },
    );
    const visible = dashboard.state.snapshot();
    assert.equal(visible.session.id, saved.getSessionId());
    assert.equal(visible.agents.length, 1);
    assert.equal(visible.agents[0].id, id);
    assert.equal(visible.agents[0].resumable, true);
    assert.equal(visible.agents[0].status, 'completed');
    assert.ok(
      visible.agents[0].conversation.some(item => item.text === 'Still blue.'),
    );
    assert.deepEqual(visible.changes, [change]);
    assert.equal(
      requests.length,
      2,
      'Opening the real dashboard must not start a prompt',
    );
    await dashboard.close();
    dashboard = undefined;

    const forked = SessionManager.open(saved.getSessionFile()!);
    forked.createBranchedSession(forked.getLeafId()!);
    assert.notEqual(forked.getSessionId(), saved.getSessionId());
    current = parent(forked, registry, createWorker);
    await current.emit('session_start');
    assert.deepEqual(current.control.snapshot()!.agents, []);
    await assert.rejects(
      current.execute('agent_status', {id}),
      /Unknown agent/,
    );
  },
);

void test(
  'interrupted agents settle without running; closed, cleaned and missing workers retain readable history',
  {timeout: 10000},
  async t => {
    const root = await mkdtemp(join(tmpdir(), 'varisdev-agent-interrupted-'));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    const runtime = await ModelRuntime.create({
      authPath: join(root, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    const session = SessionManager.create(root, join(root, 'parents'));
    const transcript = join(root, 'worker.jsonl');
    await writeFile(transcript, 'retained worker');
    const at = new Date().toISOString();
    const agents: AgentHistory['agents'] = [
      'running',
      'queued',
      'cancelling',
      'completed',
      'failed',
      'cancelled',
    ].map((status, index) => ({
      id: `agent-${index}`,
      name: `Agent ${index}`,
      task: 'Task',
      cwd: root,
      model: 'fixture/model',
      status: status as AgentRecord['status'],
      activity: status,
      resumable: true,
      sessionFile: transcript,
      createdAt: at,
      output: index === 3 ? 'Completed finding' : undefined,
      error: index === 4 ? 'Saved failure' : undefined,
      conversation: [
        {
          id: 'tool',
          role: 'tool',
          text: 'Partial result',
          toolName: 'bash',
          status: index < 3 ? 'running' : 'completed',
          streaming: index < 3,
          at,
        },
      ],
      conversationTruncated: false,
    }));
    agents[3].resumable = false; // Explicitly closed.
    agents[4].autoCleanup = true;
    agents[5].sessionFile = join(root, 'missing.jsonl');
    const store = new AgentHistoryStore(root, session.getSessionId());
    store.save(() => ({
      version: 1,
      sessionId: session.getSessionId(),
      agents,
      messages: [],
      changes: [],
      messageSequence: 0,
      configurations: Object.fromEntries(
        agents.map(agent => [
          agent.id,
          {agentProfile: createDefaultAgentProfile(), context: 'task'},
        ]),
      ),
    }));
    await store.flush();
    let creations = 0;
    const current = parent(session, registry, async () => {
      creations++;
      throw new Error('Must remain lazy');
    });
    t.after(async () => {
      await current.emit('session_shutdown');
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, {recursive: true, force: true});
    });
    await saveToolSettings('agents', {allowedModels: null});
    await current.emit('session_start');
    const restored = current.control.snapshot()!.agents;
    assert.equal(creations, 0);
    assert.equal(restored.length, 6);
    for (const agent of restored.slice(0, 3)) {
      assert.equal(agent.status, 'cancelled');
      assert.equal(agent.activity, 'Interrupted');
      assert.equal(agent.resumable, true);
      assert.equal(agent.conversation[0].status, 'cancelled');
      assert.equal(agent.conversation[0].streaming, false);
    }
    assert.equal(restored[3].output, 'Completed finding');
    assert.equal(restored[4].error, 'Saved failure');
    for (const agent of restored.slice(3)) {
      assert.equal(agent.resumable, false);
      await assert.rejects(
        current.execute('agent_send', {id: agent.id, message: 'Continue'}),
        /cleaned up/,
      );
    }
    assert.equal(creations, 0);
  },
);

void test(
  'older parent sessions recover readable worker transcripts without inventing resume configuration',
  {timeout: 10000},
  async t => {
    const root = await mkdtemp(join(tmpdir(), 'varisdev-agent-legacy-'));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    const session = SessionManager.create(root, join(root, 'parents'));
    const directory = join(root, 'varisdev', 'agents', session.getSessionId());
    const worker = SessionManager.create(root, join(directory, 'older-worker'));
    worker.appendModelChange('fixture', 'saved-model');
    worker.appendSessionInfo('Earlier review');
    worker.appendMessage({
      role: 'user',
      content: 'Review the blue door',
      timestamp: Date.now(),
    });
    worker.appendMessage({
      role: 'assistant',
      content: [
        {type: 'thinking', thinking: 'Private reasoning'},
        {type: 'text', text: 'The door is blue.'},
      ],
      provider: 'fixture',
      model: 'saved-model',
      api: 'openai-completions',
      timestamp: Date.now(),
      stopReason: 'stop',
      usage: {
        input: 10,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 14,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
      },
    });
    const interrupted = SessionManager.create(
      root,
      join(directory, 'interrupted-worker'),
    );
    interrupted.appendMessage({
      role: 'user',
      content: 'Unfinished task',
      timestamp: Date.now(),
    });
    interrupted.appendMessage({
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'pending',
          name: 'read',
          arguments: {path: 'file.txt'},
        },
      ],
      provider: 'fixture',
      model: 'saved-model',
      api: 'openai-completions',
      timestamp: Date.now(),
      stopReason: 'toolUse',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
      },
    });
    const current = parent(session, {
      find() {
        return undefined;
      },
    } as unknown as ModelRegistry);
    t.after(async () => {
      await current.emit('session_shutdown');
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, {recursive: true, force: true});
    });
    await current.emit('session_start');
    const history = (await current.execute('agent_list', {view: 'history'}))
      .details as {agents: AgentRecord[]};
    assert.equal(history.agents.length, 2);
    const recovered = current.control
      .snapshot()!
      .agents.find(agent => agent.id === 'older-worker')!;
    assert.equal(recovered.name, 'Earlier review');
    assert.equal(recovered.task, 'Review the blue door');
    assert.equal(recovered.output, 'The door is blue.');
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.model, 'fixture/saved-model');
    assert.equal(recovered.usage!.totalTokens, 14);
    assert.equal(recovered.resumable, false);
    assert.deepEqual(
      recovered.conversation.map(message => message.text),
      ['Review the blue door', 'The door is blue.'],
    );
    assert.doesNotMatch(JSON.stringify(recovered), /Private reasoning/);
    const unfinished = current.control
      .snapshot()!
      .agents.find(agent => agent.id === 'interrupted-worker')!;
    assert.equal(unfinished.status, 'cancelled');
    assert.equal(unfinished.resumable, false);
    assert.equal(unfinished.conversation.at(-1)!.status, 'cancelled');
    await current.emit('session_shutdown');
    assert.equal(
      JSON.parse(await readFile(join(directory, 'history.json'), 'utf8')).agents
        .length,
      2,
    );
  },
);

void test(
  'damaged history rows preserve valid data and corrupt manifests recover retained transcripts',
  {timeout: 10000},
  async t => {
    const root = await mkdtemp(join(tmpdir(), 'varisdev-agent-corrupt-'));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    const session = SessionManager.create(root, join(root, 'parents'));
    const store = new AgentHistoryStore(root, session.getSessionId());
    const directory = join(root, 'varisdev', 'agents', session.getSessionId());
    const transcript = SessionManager.create(root, join(directory, 'worker'));
    transcript.appendMessage({
      role: 'user',
      content: 'Durable original task',
      timestamp: Date.now(),
    });
    const at = new Date().toISOString();
    const row = {
      id: 'valid-row',
      role: 'user',
      text: 'Retained public message',
      at,
    };
    const message = {
      id: 'inbox-row',
      from: {id: 'worker', name: 'Reporter'},
      message: 'Retained finding',
      createdAt: at,
    };
    const change = {
      id: 'change-row',
      unitId: 'worker',
      unitName: 'Reporter',
      path: 'file.txt',
      tool: 'write',
      at,
      diff: '+hello',
      summary: 'Created file',
    };
    const manifest = {
      version: 1,
      sessionId: session.getSessionId(),
      messageSequence: 3,
      configurations: {},
      agents: [
        null,
        {
          id: 'worker',
          name: 'Reporter',
          task: 'Saved task',
          cwd: root,
          model: 'fixture/model',
          createdAt: at,
          activity: 'Completed',
          status: 'completed',
          conversation: [
            null,
            row,
            {id: 'broken-row', role: 'assistant', text: null, at},
          ],
          usage: {calls: [null]},
        },
      ],
      messages: [null, {...message, from: null}, message],
      changes: [null, change],
    };
    await writeFile(store.path, JSON.stringify(manifest));
    const errors: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args));
    const registry = {
      find() {
        return undefined;
      },
    } as unknown as ModelRegistry;
    let current = parent(session, registry);
    t.after(async () => {
      await current.emit('session_shutdown');
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, {recursive: true, force: true});
    });
    await current.emit('session_start');
    const restored = current.control.snapshot()!;
    assert.equal(restored.agents.length, 1);
    assert.deepEqual(
      restored.agents[0].conversation.map(item => item.text),
      [row.text],
    );
    assert.deepEqual(restored.messages, [message]);
    assert.deepEqual(restored.changes, [change]);
    assert.equal(
      current.control.getTeam(current.ctx).listMessages({after: 0}).messages
        .length,
      1,
    );
    await current.emit('session_shutdown');
    assert.equal(store.read()!.agents[0].conversation.length, 1);

    for (const damaged of [
      '{"version":1,"agents":',
      JSON.stringify({
        version: 1,
        sessionId: session.getSessionId(),
        agents: null,
      }),
      JSON.stringify({...manifest, agents: [null]}),
    ]) {
      await writeFile(store.path, damaged);
      current = parent(session, registry);
      await current.emit('session_start');
      const recovered = current.control.snapshot()!.agents;
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0].id, 'worker');
      assert.equal(recovered[0].resumable, false);
      assert.deepEqual(
        recovered[0].conversation.map(item => item.text),
        ['Durable original task'],
      );
      await current.emit('session_shutdown');
      assert.equal(store.read()!.agents[0].task, 'Durable original task');
    }

    const unreadable = new AgentHistoryStore(root, 'unreadable-parent');
    await writeFile(
      join(root, 'varisdev', 'agents', 'unreadable-parent'),
      'not a directory',
    );
    assert.equal(unreadable.read(), undefined);
    assert.ok(errors.length >= 3);
  },
);

void test(
  'changing retention removes finished agents from an open workspace and reopening cannot restore them',
  {timeout: 15000},
  async t => {
    const root = await mkdtemp(join(tmpdir(), 'varisdev-retention-history-'));
    const agentDir = join(root, 'config');
    const cwd = join(root, 'project');
    await mkdir(agentDir, {recursive: true});
    await mkdir(cwd);
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    const session = SessionManager.create(cwd, join(root, 'parents'));
    session.appendMessage({
      role: 'user',
      content: 'Parent conversation',
      timestamp: Date.now(),
    });
    const directory = join(
      agentDir,
      'varisdev',
      'agents',
      session.getSessionId(),
      'old-worker',
    );
    await mkdir(directory, {recursive: true});
    const sessionFile = join(directory, 'worker.jsonl');
    const resultFile = join(directory, 'result.txt');
    await writeFile(sessionFile, 'saved worker');
    await writeFile(resultFile, 'saved result');
    const old = new Date(Date.now() - 10 * 86400000).toISOString();
    const store = new AgentHistoryStore(agentDir, session.getSessionId());
    store.save(() => ({
      version: 1,
      sessionId: session.getSessionId(),
      messageSequence: 0,
      messages: [],
      changes: [],
      configurations: {},
      agents: [
        {
          id: 'old-worker',
          name: 'Old worker',
          task: 'task',
          cwd,
          model: 'fixture/model',
          status: 'completed',
          createdAt: old,
          finishedAt: old,
          activity: 'Completed',
          agentMode: 'subagent',
          conversation: [],
          conversationTruncated: false,
          sessionFile,
          resultFile,
        },
      ],
    }));
    await store.flush();
    await saveToolSettings('agents', {
      allowedModels: [],
      historyRetentionDays: 30,
    });
    let current = parent(session, registry);
    t.after(async () => {
      await current.emit('session_shutdown');
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, {recursive: true, force: true});
    });
    await current.emit('session_start');
    assert.equal(current.control.snapshot()!.agents.length, 1);
    // Queue a normal save immediately before expiry to exercise write ordering.
    current.control.getTeam(current.ctx).storeMessage({
      from: {id: 'old-worker', name: 'Old worker'},
      message: 'Finding',
    });
    await saveToolSettings('agents', {
      allowedModels: [],
      historyRetentionDays: 7,
    });
    const {watchAgentHistory} = await import('../src/agents/retention.ts');
    const pendingCleanup = watchAgentHistory(agentDir, async () => {});
    await pendingCleanup.ready;
    await pendingCleanup.close();
    const {existsSync} = await import('node:fs');
    assert.equal(
      existsSync(directory),
      true,
      'Fresh files survive stale saved completion metadata',
    );
    assert.equal(current.control.snapshot()!.agents.length, 1);
    const {utimes} = await import('node:fs/promises');
    for (const file of [sessionFile, resultFile])
      await utimes(file, new Date(old), new Date(old));
    await saveToolSettings('agents', {
      allowedModels: [],
      historyRetentionDays: 7,
    });
    const {setTimeout: delay} = await import('node:timers/promises');
    for (let tries = 0; tries < 200 && existsSync(directory); tries++)
      await delay(10);
    assert.equal(existsSync(directory), false);
    assert.deepEqual(current.control.snapshot()!.agents, []);
    await current.emit('session_shutdown');
    assert.deepEqual(
      new AgentHistoryStore(agentDir, session.getSessionId()).read()!.agents,
      [],
    );
    current = parent(SessionManager.open(session.getSessionFile()!), registry);
    await current.emit('session_start');
    assert.deepEqual(current.control.snapshot()!.agents, []);
    assert.ok(await readFile(session.getSessionFile()!, 'utf8'));
  },
);

for (const staleSave of [false, true]) {
  void test(
    `a live owner reconciles another owner's saved use before retention cleanup${staleSave ? ' after saving stale history' : ''}`,
    {timeout: 15000},
    async t => {
      const day = 86400000;
      const viewedAt = Date.now();
      const old = new Date(viewedAt - 10 * day).toISOString();
      const used = new Date(viewedAt).toISOString();
      t.mock.timers.enable({apis: ['Date'], now: viewedAt});
      const root = await mkdtemp(join(tmpdir(), 'varisdev-shared-history-'));
      const agentDir = join(root, 'config');
      const cwd = join(root, 'project');
      await mkdir(cwd, {recursive: true});
      const previous = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const owners: ReturnType<typeof parent>[] = [];
      t.after(async () => {
        for (const owner of owners) await owner.emit('session_shutdown');
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        await rm(root, {recursive: true, force: true});
      });
      const session = SessionManager.create(cwd, join(root, 'parents'));
      session.appendMessage({
        role: 'user',
        content: 'Shared workspace',
        timestamp: viewedAt,
      });
      const store = new AgentHistoryStore(agentDir, session.getSessionId());
      const directory = join(
        agentDir,
        'varisdev',
        'agents',
        session.getSessionId(),
        'worker',
      );
      await mkdir(directory, {recursive: true});
      const sessionFile = join(directory, 'session.jsonl');
      const resultFile = join(directory, 'result.txt');
      const {utimes} = await import('node:fs/promises');
      for (const file of [sessionFile, resultFile]) {
        await writeFile(file, 'Retained finding');
        await utimes(file, new Date(old), new Date(old));
      }
      store.save(() => ({
        version: 1,
        sessionId: session.getSessionId(),
        messageSequence: 0,
        messages: [],
        changes: [],
        configurations: {},
        agents: [
          {
            id: 'worker',
            name: 'Worker',
            task: 'Saved task',
            cwd,
            model: 'fixture/model',
            agentMode: 'subagent',
            status: 'completed',
            activity: 'Completed',
            createdAt: old,
            finishedAt: old,
            lastUsedAt: old,
            sessionFile,
            resultFile,
            conversation: [],
            conversationTruncated: false,
          },
        ],
      }));
      await store.flush();
      await saveToolSettings('agents', {
        allowedModels: [],
        historyRetentionDays: 30,
      });
      const registry = {find: () => undefined} as unknown as ModelRegistry;
      const open = async () => {
        const owner = parent(
          SessionManager.open(session.getSessionFile()!),
          registry,
          async () => assert.fail('Reading retained history must remain lazy'),
        );
        owners.push(owner);
        await owner.emit('session_start');
        return owner;
      };
      const first = await open();
      const second = await open();
      assert.equal(second.control.snapshot()!.agents[0].lastUsedAt, old);
      const {runAgentSessionRequest} =
        await import('../src/dashboard/agent-session.ts');
      await runAgentSessionRequest(
        first.control.getTeam(first.ctx).getManager(),
        {agentId: 'worker', action: 'view'},
      );
      await first.emit('session_shutdown');
      assert.equal(store.read()!.agents[0].lastUsedAt, used);
      assert.equal(second.control.snapshot()!.agents[0].lastUsedAt, old);

      t.mock.timers.setTime(viewedAt + 2 * day);
      if (staleSave) {
        const message = second.control.getTeam(second.ctx).storeMessage({
          from: {id: 'worker', name: 'Worker'},
          message: 'Save the stale owner before changing retention',
        });
        const {setTimeout: delay} = await import('node:timers/promises');
        for (let tries = 0; tries < 300; tries++) {
          if (store.read()!.messages.some(saved => saved.id === message.id))
            break;
          await delay(10);
        }
        const saved = store.read()!;
        assert.ok(saved.messages.some(row => row.id === message.id));
        assert.equal(saved.agents[0].lastUsedAt, used);
      }
      const {watchAgentHistory} = await import('../src/agents/retention.ts');
      const sweep = async () => {
        const watcher = watchAgentHistory(agentDir, async () => {});
        try {
          await watcher.ready;
        } finally {
          await watcher.close();
        }
      };
      await saveToolSettings('agents', {
        allowedModels: [],
        historyRetentionDays: 7,
      });
      await sweep();
      assert.equal(
        second.control.getTeam(second.ctx).getManager().get('worker')
          .lastUsedAt,
        used,
        'Cleanup must adopt the saved use time rather than renew it',
      );
      assert.equal(second.control.snapshot()!.agents[0].lastUsedAt, used);
      for (const file of [sessionFile, resultFile])
        assert.equal(await readFile(file, 'utf8'), 'Retained finding');
      await second.emit('session_shutdown');
      assert.equal(store.read()!.agents[0].lastUsedAt, used);

      const reopened = await open();
      assert.equal(reopened.control.snapshot()!.agents[0].lastUsedAt, used);
      t.mock.timers.setTime(viewedAt + 7 * day - 1);
      await sweep();
      assert.equal(reopened.control.snapshot()!.agents[0].lastUsedAt, used);
      assert.equal(await readFile(resultFile, 'utf8'), 'Retained finding');
      t.mock.timers.setTime(viewedAt + 7 * day + 1);
      await sweep();
      assert.deepEqual(reopened.control.snapshot()!.agents, []);
      const {existsSync} = await import('node:fs');
      assert.equal(existsSync(directory), false);
      await reopened.emit('session_shutdown');
      assert.deepEqual(store.read()!.agents, []);
      const expired = await open();
      assert.deepEqual(expired.control.snapshot()!.agents, []);
    },
  );
}

void test(
  'live cleanup discovers saved workers, preserves an omitted primary and expires an unknown subagent',
  {timeout: 15000},
  async t => {
    const day = 86400000;
    const createdAt = Date.now();
    const at = new Date(createdAt).toISOString();
    t.mock.timers.enable({apis: ['Date'], now: createdAt});
    const root = await mkdtemp(join(tmpdir(), 'varisdev-discovered-history-'));
    const agentDir = join(root, 'config');
    const cwd = join(root, 'project');
    await mkdir(cwd, {recursive: true});
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const owners: ReturnType<typeof parent>[] = [];
    t.after(async () => {
      for (const owner of owners) await owner.emit('session_shutdown');
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, {recursive: true, force: true});
    });
    const session = SessionManager.create(cwd, join(root, 'parents'));
    session.appendMessage({
      role: 'user',
      content: 'Shared workspace',
      timestamp: createdAt,
    });
    const store = new AgentHistoryStore(agentDir, session.getSessionId());
    store.save(() => ({
      version: 1,
      sessionId: session.getSessionId(),
      agents: [],
      messages: [],
      changes: [],
      messageSequence: 0,
      configurations: {},
    }));
    await store.flush();
    await saveToolSettings('agents', {
      allowedModels: [],
      historyRetentionDays: 30,
    });
    const registry = {find: () => undefined} as unknown as ModelRegistry;
    const open = async () => {
      const owner = parent(
        SessionManager.open(session.getSessionFile()!),
        registry,
        async () => assert.fail('Discovering saved workers must remain lazy'),
      );
      owners.push(owner);
      await owner.emit('session_start');
      return owner;
    };
    const staleOwner = await open();
    const writer = await open();
    const records: AgentHistory['agents'] = [];
    const configurations: AgentHistory['configurations'] = {};
    const {utimes} = await import('node:fs/promises');
    for (const [id, agentMode] of [
      ['primary', 'primary'],
      ['expired', 'subagent'],
    ] as const) {
      const directory = join(
        agentDir,
        'varisdev',
        'agents',
        session.getSessionId(),
        id,
      );
      const transcript = SessionManager.create(cwd, directory);
      transcript.appendMessage({
        role: 'user',
        content: `${id} task`,
        timestamp: createdAt,
      });
      const sessionFile = transcript.getSessionFile()!;
      const resultFile = join(directory, 'result.txt');
      await writeFile(resultFile, `${id} finding`);
      for (const file of [sessionFile, resultFile])
        await utimes(file, createdAt / 1000, createdAt / 1000);
      records.push({
        id,
        name: id,
        task: `${id} task`,
        cwd,
        model: 'fixture/model',
        agentMode,
        status: 'completed',
        activity: 'Completed',
        createdAt: at,
        finishedAt: at,
        lastUsedAt: at,
        resumable: true,
        sessionFile,
        resultFile,
        conversation: [],
        conversationTruncated: false,
      });
      configurations[id] = {
        agentProfile: createDefaultAgentProfile(),
        instructions: `${id} instructions`,
        context: 'task',
      };
      writer.control
        .getTeam(writer.ctx)
        .retainWorkerConfiguration(id, configurations[id]);
    }
    writer.control
      .getTeam(writer.ctx)
      .getManager()
      .restore(records, async () =>
        assert.fail('Saving restored workers must remain lazy'),
      );
    await writer.emit('session_shutdown');
    assert.deepEqual(staleOwner.control.snapshot()!.agents, []);
    const message = staleOwner.control.getTeam(staleOwner.ctx).storeMessage({
      from: {id: 'parent', name: 'Parent'},
      message: 'Save the empty owner snapshot',
    });
    const {setTimeout: delay} = await import('node:timers/promises');
    for (let tries = 0; tries < 300; tries++) {
      if (store.read()!.messages.some(saved => saved.id === message.id)) break;
      await delay(10);
    }
    const saved = store.read()!;
    assert.ok(saved.messages.some(row => row.id === message.id));
    assert.deepEqual(saved.agents.map(agent => agent.id).sort(), [
      'expired',
      'primary',
    ]);
    assert.deepEqual(saved.configurations, configurations);

    t.mock.timers.setTime(createdAt + 8 * day);
    await saveToolSettings('agents', {
      allowedModels: [],
      historyRetentionDays: 7,
    });
    const {watchAgentHistory} = await import('../src/agents/retention.ts');
    const sweep = async () => {
      const watcher = watchAgentHistory(agentDir, async () => {});
      try {
        await watcher.ready;
      } finally {
        await watcher.close();
      }
    };
    await sweep();
    const discovered = staleOwner.control.snapshot()!.agents;
    assert.deepEqual(
      discovered.map(agent => agent.id),
      ['primary'],
    );
    assert.equal(discovered[0].lastUsedAt, at);
    assert.equal(discovered[0].resumable, true);
    const team = staleOwner.control.getTeam(staleOwner.ctx);
    assert.deepEqual(
      team.workerConfiguration('primary'),
      configurations.primary,
    );
    assert.throws(() => team.workerConfiguration('expired'), /unavailable/);
    const {existsSync} = await import('node:fs');
    assert.equal(
      existsSync(
        join(agentDir, 'varisdev', 'agents', session.getSessionId(), 'expired'),
      ),
      false,
    );
    assert.match(
      await readFile(discovered[0].sessionFile!, 'utf8'),
      /primary task/,
    );
    await staleOwner.emit('session_shutdown');
    assert.deepEqual(
      store.read()!.agents.map(agent => agent.id),
      ['primary'],
    );
    assert.deepEqual(store.read()!.configurations, {
      primary: configurations.primary,
    });

    const reopened = await open();
    assert.deepEqual(
      reopened.control.snapshot()!.agents.map(agent => agent.id),
      ['primary'],
    );
    assert.equal(reopened.control.snapshot()!.agents[0].resumable, true);
    assert.deepEqual(
      reopened.control.getTeam(reopened.ctx).workerConfiguration('primary'),
      configurations.primary,
    );
    t.mock.timers.setTime(createdAt + 30 * day);
    await sweep();
    assert.deepEqual(
      reopened.control.snapshot()!.agents.map(agent => agent.id),
      ['primary'],
    );
    assert.equal(
      await readFile(records[0].resultFile!, 'utf8'),
      'primary finding',
    );
  },
);

void test(
  'an expired last primary remains resumable in legacy history, and renewed use persists',
  {timeout: 15000},
  async t => {
    const root = await mkdtemp(join(tmpdir(), 'varisdev-retained-primary-'));
    const agentDir = join(root, 'config');
    const cwd = join(root, 'project');
    await mkdir(agentDir, {recursive: true});
    await mkdir(cwd);
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    registry.registerProvider('history-fixture', {
      api: 'openai-completions',
      apiKey: 'fixture-key',
      baseUrl: 'https://history.invalid/v1',
      models: [
        {
          id: 'worker',
          name: 'Worker',
          reasoning: false,
          input: ['text'],
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          contextWindow: 128000,
          maxTokens: 1000,
        },
      ],
    });
    const session = SessionManager.create(cwd, join(root, 'parents'));
    session.appendMessage({
      role: 'user',
      content: 'Workspace',
      timestamp: Date.now(),
    });
    session.appendCustomEntry('varisdev.primary-closed', {closed: true});
    const directory = join(
      agentDir,
      'varisdev',
      'agents',
      session.getSessionId(),
      'last-primary',
    );
    await mkdir(directory, {recursive: true});
    const transcript = SessionManager.create(cwd, directory);
    transcript.appendMessage({
      role: 'user',
      content: 'Primary task',
      timestamp: Date.now() - 30 * 86400000,
    });
    const old = new Date(Date.now() - 30 * 86400000).toISOString();
    const store = new AgentHistoryStore(agentDir, session.getSessionId());
    store.save(() => ({
      version: 1,
      sessionId: session.getSessionId(),
      messageSequence: 0,
      messages: [],
      changes: [],
      configurations: {
        'last-primary': {
          agentProfile: createDefaultAgentProfile(),
          context: 'task',
        },
      },
      agents: [
        {
          id: 'last-primary',
          name: 'Last primary',
          task: 'Primary task',
          cwd,
          model: 'history-fixture/worker',
          agentMode: 'all',
          resumable: true,
          status: 'completed',
          createdAt: old,
          finishedAt: old,
          activity: 'Completed',
          sessionFile: transcript.getSessionFile(),
          conversation: [],
          conversationTruncated: false,
        },
      ],
    }));
    await store.flush();
    await saveToolSettings('agents', {
      allowedModels: null,
      historyRetentionDays: 7,
    });
    let runs = 0;
    const createWorker: typeof createSessionWorker = async () => ({
      sessionFile: transcript.getSessionFile(),
      run: async () => {
        runs++;
        return 'continued';
      },
      steer: async () => true,
      dispose() {},
    });
    let current = parent(session, registry, createWorker);
    t.after(async () => {
      await current.emit('session_shutdown');
      registry.unregisterProvider('history-fixture');
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, {recursive: true, force: true});
    });
    await current.emit('session_start');
    const kept = current.control.snapshot()!.agents;
    assert.equal(kept.length, 1);
    assert.equal(kept[0].resumable, true);
    const manager = current.control.getTeam(current.ctx).getManager();
    await manager.send('last-primary', 'Continue the workspace');
    await manager.wait(['last-primary']);
    assert.equal(runs, 1);
    const lastUsedAt = manager.get('last-primary').lastUsedAt;
    assert.ok(Date.parse(lastUsedAt!) > Date.parse(old));
    await current.emit('session_shutdown');
    current = parent(
      SessionManager.open(session.getSessionFile()!),
      registry,
      createWorker,
    );
    await current.emit('session_start');
    assert.equal(current.control.snapshot()!.agents[0].lastUsedAt, lastUsedAt);
    assert.equal(current.control.snapshot()!.agents[0].resumable, true);
    assert.match(
      await readFile(session.getSessionFile()!, 'utf8'),
      /varisdev.primary-closed/,
    );
  },
);
