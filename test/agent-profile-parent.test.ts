import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import {
  createDefaultAgentProfile,
  resolveAgentTemplate,
  saveAgentTemplate,
  type AgentTemplate,
} from '../src/agents/templates.ts';
import {
  createDashboardParent,
  type DesktopDashboardParent,
} from '../src/dashboard/parent.ts';
import {sessionAgentProfile} from '../src/dashboard/features.ts';
import {primaryClosedEntry} from '../src/dashboard/primary-session.ts';

interface Request {
  model: string;
  reasoning_effort?: string;
  messages: Array<{role: string; content: unknown}>;
  tools?: Array<{function: {name: string}}>;
}

function reply(
  response: ServerResponse,
  output: string | {path: string; content: string},
) {
  const tool = typeof output !== 'string';
  const delta = tool
    ? {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: randomUUID(),
            type: 'function',
            function: {name: 'write', arguments: JSON.stringify(output)},
          },
        ],
      }
    : {role: 'assistant', content: output};
  response.writeHead(200, {'content-type': 'text/event-stream'});
  response.end(
    `data: ${JSON.stringify({id: randomUUID(), object: 'chat.completion.chunk', created: 1, model: 'profile-model', choices: [{index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop'}]})}\n\ndata: [DONE]\n\n`,
  );
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await delay(10);
  assert.ok(check(), 'Expected Main agent integration state');
}

void test('Main markers hide selectable profile metadata while worker histories retain it', () => {
  const manager = SessionManager.inMemory(process.cwd());
  assert.deepEqual(sessionAgentProfile(manager), {
    id: 'default',
    name: 'Default',
    mode: 'all',
  });
  manager.appendCustomEntry('varisdev.agent-profile', {
    ...createDefaultAgentProfile(),
    id: 'worker',
    key: 'workspace:worker',
    name: 'Worker',
    mode: 'subagent',
    instructions: 'Worker instructions',
  } satisfies AgentTemplate);
  assert.deepEqual(sessionAgentProfile(manager), {
    id: 'worker',
    name: 'Worker',
    mode: 'subagent',
  });
  manager.appendCustomEntry('varisdev.main-agent', {version: 1});
  assert.equal(sessionAgentProfile(manager), undefined);
  manager.appendCustomEntry('varisdev.agent-profile', {
    ...createDefaultAgentProfile(),
    id: 'later-worker',
    key: 'workspace:later-worker',
    name: 'Later worker',
    mode: 'primary',
  } satisfies AgentTemplate);
  assert.equal(
    sessionAgentProfile(manager),
    undefined,
    'the Main marker takes precedence regardless of profile entry order',
  );
});

void test(
  'Main roots ignore requested, saved and default configurations while retaining shared permissions and one marker',
  {timeout: 20000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-main-parent-'));
    const agentDir = join(directory, 'config');
    const cwd = join(directory, 'project');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const sharedPermissions = [
      {action: 'edit', resource: '*', effect: 'deny'},
      {action: 'edit', resource: 'approved.txt', effect: 'ask'},
      {action: 'subagent', resource: '*', effect: 'deny'},
    ] as const;
    await mkdir(join(cwd, '.git'), {recursive: true});
    await mkdir(agentDir, {recursive: true});
    await writeFile(join(cwd, 'AGENTS.md'), 'MAIN WORKSPACE CONTEXT MARKER');
    await writeFile(join(agentDir, 'SYSTEM.md'), 'MAIN GLOBAL BASE MARKER');
    await writeFile(
      join(agentDir, 'APPEND_SYSTEM.md'),
      'MAIN APPENDED CONTEXT MARKER',
    );
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({
        retry: {enabled: false},
        default_agent: 'configured-root',
        permissions: sharedPermissions,
      }),
    );
    await saveAgentTemplate(cwd, {
      scope: 'repository',
      id: 'configured-root',
      name: 'Configured root',
      mode: 'primary',
      context: 'task',
      instructions: 'CONFIGURED DEFAULT PROFILE MUST BE IGNORED',
      model: 'profile-fixture/configured-model',
      thinkingLevel: 'off',
      steps: 1,
      permissions: [
        {action: 'edit', resource: '*', effect: 'allow'},
        {action: 'subagent', resource: '*', effect: 'allow'},
      ],
    });
    const configured = (await resolveAgentTemplate(cwd, 'configured-root'))!;
    const requested: AgentTemplate = {
      ...configured,
      id: 'requested-root',
      key: 'repository:requested-root',
      name: 'Requested root',
      mode: 'subagent',
      disabled: true,
      instructions: 'REQUESTED ROOT PROFILE MUST BE IGNORED',
      permissions: [
        {action: 'edit', resource: '*', effect: 'allow'},
        {action: 'subagent', resource: '*', effect: 'allow'},
      ],
    };

    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    const requests: Request[] = [];
    const errors: unknown[] = [];
    const parents: DesktopDashboardParent[] = [];
    const server = createServer(async (request, response) => {
      try {
        let raw = '';
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw) as Request;
        requests.push(body);
        const userIndex = body.messages.findLastIndex(
          message => message.role === 'user',
        );
        const prompt = JSON.stringify(body.messages[userIndex]?.content);
        const results = body.messages
          .slice(userIndex + 1)
          .filter(message => message.role === 'tool');
        if (prompt.includes('exercise-main-policy')) {
          if (results.length === 0)
            reply(response, {
              path: 'approved.txt',
              content: 'Approved write.\n',
            });
          else if (results.length === 1)
            reply(response, {
              path: 'denied.txt',
              content: 'Forbidden write.\n',
            });
          else reply(response, 'Main policy exercise complete.');
        } else reply(response, 'Main conversation response.');
      } catch (error) {
        errors.push(error);
        response.destroy();
      }
    });
    t.after(async () => {
      for (const parent of parents) await parent.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      registry.unregisterProvider('profile-fixture');
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, {recursive: true, force: true});
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    registry.registerProvider('profile-fixture', {
      api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      apiKey: 'fixture-key',
      models: ['profile-model', 'configured-model'].map(id => ({
        id,
        name: id,
        reasoning: true,
        input: ['text'],
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
        contextWindow: 128000,
        maxTokens: 1000,
        compat: {supportsReasoningEffort: true},
      })),
    });
    const inherited = {
      model: registry.find('profile-fixture', 'profile-model')!,
      modelRegistry: registry,
      thinkingLevel: 'high' as const,
    };

    const parent = await createDashboardParent(
      {
        cwd,
        agentProfile: requested,
        instructions: 'EXPLICIT MAIN INSTRUCTION MARKER',
      },
      inherited,
    );
    parents.push(parent);
    assert.equal((await parent.features()).agentProfile, undefined);
    assert.equal(parent.state.snapshot().session.agentProfile, undefined);
    assert.equal(parent.state.snapshot().session.name, 'project');
    const initialEntries = parent.restartSnapshot().entries;
    assert.equal(
      initialEntries.filter(
        entry =>
          entry.type === 'custom' && entry.customType === 'varisdev.main-agent',
      ).length,
      1,
    );
    assert.ok(
      !initialEntries.some(
        entry =>
          entry.type === 'custom' &&
          entry.customType === 'varisdev.agent-profile',
      ),
    );
    assert.ok(
      !initialEntries.some(
        entry =>
          entry.type === 'custom' &&
          entry.customType === 'varisdev.agent-context',
      ),
    );

    const exercising = parent.prompt(
      'exercise-main-policy: write approved.txt, then denied.txt, and report.',
    );
    await until(() => parent.ui.snapshot().dialogs.length > 0);
    const approval = parent.ui.snapshot().dialogs[0];
    assert.equal(approval.kind, 'select');
    assert.match(approval.title, /Permission: main/i);
    parent.ui.respond(approval.id, 'Allow once');
    await exercising;
    assert.deepEqual(errors, []);
    assert.equal(
      await readFile(join(cwd, 'approved.txt'), 'utf8'),
      'Approved write.\n',
    );
    await assert.rejects(readFile(join(cwd, 'denied.txt')), {code: 'ENOENT'});
    assert.equal(
      requests.length,
      3,
      'the requested one-step profile does not constrain Main',
    );
    assert.equal(requests[0].model, 'profile-model');
    assert.equal(requests[0].reasoning_effort, 'high');
    const initialMessages = JSON.stringify(requests[0].messages);
    assert.match(initialMessages, /MAIN GLOBAL BASE MARKER/);
    assert.match(initialMessages, /MAIN APPENDED CONTEXT MARKER/);
    assert.match(initialMessages, /MAIN WORKSPACE CONTEXT MARKER/);
    assert.match(initialMessages, /EXPLICIT MAIN INSTRUCTION MARKER/);
    assert.doesNotMatch(
      initialMessages,
      /REQUESTED ROOT PROFILE MUST BE IGNORED|CONFIGURED DEFAULT PROFILE MUST BE IGNORED/,
    );
    const agentSession = parent.agentSession;
    assert.ok(agentSession);
    await assert.rejects(
      agentSession({agentId: 'parent', action: 'close'}),
      /Main.*cannot be closed separately/i,
    );
    assert.notEqual(parent.state.snapshot().session.primaryClosed, true);

    await parent.configure({
      provider: 'profile-fixture',
      modelId: 'configured-model',
      thinkingLevel: 'off',
    });
    const saved = parent.state.snapshot().session;
    assert.equal(saved.agentProfile, undefined);
    const restart = parent.restartSnapshot();
    assert.equal(
      restart.entries.filter(
        entry =>
          entry.type === 'custom' && entry.customType === 'varisdev.main-agent',
      ).length,
      1,
    );
    await parent.close();

    await saveAgentTemplate(cwd, {
      scope: 'repository',
      id: 'configured-root',
      name: 'Edited configured root',
      mode: 'primary',
      instructions: 'EDITED DEFAULT PROFILE MUST BE IGNORED',
    });
    const resumed = await createDashboardParent(
      {cwd, resume: {id: saved.id, path: saved.sessionFile!}},
      inherited,
    );
    parents.push(resumed);
    assert.equal((await resumed.features()).agentProfile, undefined);
    assert.equal(resumed.state.snapshot().session.agentProfile, undefined);
    assert.notEqual(resumed.state.snapshot().session.primaryClosed, true);
    assert.equal((await resumed.features()).model?.id, 'configured-model');
    assert.equal((await resumed.features()).thinkingLevel, 'off');
    assert.equal(
      resumed
        .restartSnapshot()
        .entries.filter(
          entry =>
            entry.type === 'custom' &&
            entry.customType === 'varisdev.main-agent',
        ).length,
      1,
    );
    await resumed.prompt('Resume the Main conversation.');
    const resumedMessages = JSON.stringify(requests.at(-1)!.messages);
    assert.match(resumedMessages, /EXPLICIT MAIN INSTRUCTION MARKER/);
    assert.doesNotMatch(
      resumedMessages,
      /REQUESTED ROOT PROFILE MUST BE IGNORED|CONFIGURED DEFAULT PROFILE MUST BE IGNORED|EDITED DEFAULT PROFILE MUST BE IGNORED/,
    );
    await resumed.close();

    const legacy = SessionManager.create(
      cwd,
      join(directory, 'legacy-sessions'),
    );
    legacy.appendMessage({
      role: 'user',
      content: 'Legacy conversation history.',
      timestamp: Date.now(),
    });
    legacy.appendModelChange('profile-fixture', 'profile-model');
    legacy.appendThinkingLevelChange('high');
    legacy.appendCustomEntry('varisdev.agent-profile', {
      ...configured,
      id: 'legacy-root',
      key: 'repository:legacy-root',
      mode: 'primary',
      context: 'task',
      instructions: 'LEGACY SAVED PROFILE MUST BE IGNORED',
      permissions: [
        {action: 'edit', resource: '*', effect: 'allow'},
        {action: 'subagent', resource: '*', effect: 'allow'},
      ],
    });
    legacy.appendCustomEntry('varisdev.agent-context', {scope: 'task'});
    legacy.appendCustomEntry(primaryClosedEntry, {closed: true});
    const legacyParent = await createDashboardParent(
      {
        cwd,
        resume: {id: legacy.getSessionId(), path: legacy.getSessionFile()!},
      },
      inherited,
    );
    parents.push(legacyParent);
    assert.equal((await legacyParent.features()).agentProfile, undefined);
    assert.notEqual(legacyParent.state.snapshot().session.primaryClosed, true);
    const legacyEntries = legacyParent.restartSnapshot().entries;
    assert.equal(
      legacyEntries.filter(
        entry =>
          entry.type === 'custom' && entry.customType === 'varisdev.main-agent',
      ).length,
      1,
    );
    assert.equal(
      legacyEntries.filter(
        entry =>
          entry.type === 'custom' &&
          entry.customType === 'varisdev.agent-profile',
      ).length,
      1,
      'legacy profile history is retained without becoming the root identity',
    );
    await legacyParent.prompt('Continue the legacy session as Main.');
    const legacyMessages = JSON.stringify(requests.at(-1)!.messages);
    assert.match(legacyMessages, /MAIN GLOBAL BASE MARKER/);
    assert.match(legacyMessages, /MAIN APPENDED CONTEXT MARKER/);
    assert.match(legacyMessages, /MAIN WORKSPACE CONTEXT MARKER/);
    assert.doesNotMatch(
      legacyMessages,
      /LEGACY SAVED PROFILE MUST BE IGNORED|CONFIGURED DEFAULT PROFILE MUST BE IGNORED|EDITED DEFAULT PROFILE MUST BE IGNORED/,
    );
    await legacyParent.close();

    const legacyAgain = await createDashboardParent(
      {
        cwd,
        resume: {id: legacy.getSessionId(), path: legacy.getSessionFile()!},
      },
      inherited,
    );
    parents.push(legacyAgain);
    assert.notEqual(legacyAgain.state.snapshot().session.primaryClosed, true);
    assert.equal(
      legacyAgain
        .restartSnapshot()
        .entries.filter(
          entry =>
            entry.type === 'custom' &&
            entry.customType === 'varisdev.main-agent',
        ).length,
      1,
      'resuming Main repeatedly does not duplicate its marker',
    );

    const fresh = await createDashboardParent({cwd}, inherited);
    parents.push(fresh);
    assert.equal((await fresh.features()).agentProfile, undefined);
    assert.equal(fresh.state.snapshot().session.agentProfile, undefined);
    await fresh.prompt('Start another Main conversation.');
    assert.doesNotMatch(
      JSON.stringify(requests.at(-1)!.messages),
      /CONFIGURED DEFAULT PROFILE MUST BE IGNORED|EDITED DEFAULT PROFILE MUST BE IGNORED/,
    );
    assert.deepEqual(errors, []);
  },
);
