import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type ExtensionFactory,
} from '@earendil-works/pi-coding-agent';
import {registerFactory} from '../src/dashboard/index.ts';
import {DesktopExtensionUI} from '../src/dashboard/extension-ui.ts';
import {
  registerAgentTools,
  type AgentToolsOptions,
} from '../src/tools/agents.ts';
import {
  resolveAgentTemplate,
  saveAgentTemplate,
  type AgentTemplate,
} from '../src/agents/templates.ts';
import {
  createDashboardParent,
  type DesktopDashboardParent,
} from '../src/dashboard/parent.ts';

interface ProviderRequest {
  tools?: unknown;
  messages: Array<{role: string; content: unknown}>;
}
function reply(response: ServerResponse, output: string | {path: string}) {
  const tool = typeof output !== 'string';
  const delta = tool
    ? {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: randomUUID(),
            type: 'function',
            function: {name: 'read', arguments: JSON.stringify(output)},
          },
        ],
      }
    : {role: 'assistant', content: output};
  response.writeHead(200, {'content-type': 'text/event-stream'});
  response.end(
    `data: ${JSON.stringify({id: randomUUID(), object: 'chat.completion.chunk', created: 1, model: 'root-skill-model', choices: [{index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop'}]})}\n\ndata: [DONE]\n\n`,
  );
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await delay(10);
  assert.ok(check(), 'Expected skill permission state');
}

void test(
  'root and native skill permissions gate commands and file reads while preserving session context',
  {timeout: 20000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-root-skills-'));
    const cwd = join(directory, 'project');
    const agentDir = join(directory, 'settings');
    await mkdir(join(cwd, '.git'), {recursive: true});
    await mkdir(agentDir);
    await writeFile(
      join(cwd, 'AGENTS.md'),
      'Root skill project context marker.',
    );
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({retry: {enabled: false}}),
    );
    for (const [name, description, body] of [
      ['denied-skill', 'DENIED SKILL DESCRIPTION', 'DENIED SKILL BODY MARKER'],
      [
        'approved-skill',
        'APPROVED SKILL DESCRIPTION',
        'APPROVED SKILL BODY MARKER',
      ],
      ['open-skill', 'OPEN SKILL DESCRIPTION', 'OPEN SKILL BODY MARKER'],
    ]) {
      const folder = join(agentDir, 'skills', name);
      await mkdir(folder, {recursive: true});
      await writeFile(
        join(folder, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
      );
    }
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const requests: ProviderRequest[] = [];
    const errors: unknown[] = [];
    const parents: DesktopDashboardParent[] = [];
    const nativeCleanup: Array<() => void> = [];
    const server = createServer(async (request, response) => {
      try {
        let raw = '';
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw) as ProviderRequest;
        requests.push(body);
        const userIndex = body.messages.findLastIndex(
          message => message.role === 'user',
        );
        const prompt = JSON.stringify(body.messages[userIndex]?.content);
        const results = body.messages
          .slice(userIndex + 1)
          .filter(message => message.role === 'tool');
        if (!results.length && prompt.includes('read-denied-skill'))
          reply(response, {
            path: join(agentDir, 'skills', 'denied-skill', 'SKILL.md'),
          });
        else if (!results.length && prompt.includes('read-approved-skill'))
          reply(response, {
            path: join(agentDir, 'skills', 'approved-skill', 'SKILL.md'),
          });
        else reply(response, 'Root skill response.');
      } catch (error) {
        errors.push(error);
        response.destroy();
      }
    });
    t.after(async () => {
      for (const dispose of nativeCleanup) dispose();
      await Promise.all(parents.map(parent => parent.close()));
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, {recursive: true, force: true});
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    registry.registerProvider('root-skill-fixture', {
      api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      apiKey: 'fixture-key',
      models: [
        {
          id: 'root-skill-model',
          name: 'Root skill model',
          reasoning: false,
          input: ['text'],
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          contextWindow: 128000,
          maxTokens: 1000,
        },
      ],
    });
    const inherited = {
      model: registry.find('root-skill-fixture', 'root-skill-model')!,
      modelRegistry: registry,
      thinkingLevel: 'off' as const,
    };
    await saveAgentTemplate(cwd, {
      scope: 'repository',
      id: 'skill-policy',
      mode: 'primary',
      instructions: 'Apply the root skill policy.',
      permissions: [
        {action: 'skill', resource: 'denied-skill', effect: 'deny'},
        {action: 'skill', resource: 'approved-skill', effect: 'ask'},
      ],
    });
    const profile = (await resolveAgentTemplate(cwd, 'skill-policy'))!;
    const parent = await createDashboardParent(
      {cwd, agentProfile: profile},
      inherited,
    );
    parents.push(parent);
    const features = await parent.features();
    assert.ok(
      !features.commands.some(command => command.name === 'skill:denied-skill'),
    );
    assert.ok(
      features.commands.some(
        command => command.name === 'skill:approved-skill',
      ),
    );
    assert.ok(
      features.commands.some(command => command.name === 'skill:open-skill'),
    );
    await parent.prompt('Describe the available skills.');
    assert.match(
      JSON.stringify(requests[0].messages),
      /APPROVED SKILL DESCRIPTION/,
    );
    assert.match(
      JSON.stringify(requests[0].messages),
      /OPEN SKILL DESCRIPTION/,
    );
    assert.doesNotMatch(
      JSON.stringify(requests[0].messages),
      /DENIED SKILL DESCRIPTION|DENIED SKILL BODY MARKER|APPROVED SKILL BODY MARKER/,
    );

    const beforeDenied = requests.length;
    await parent.prompt('/skill:denied-skill').catch(error => {
      assert.match(String(error), /denied|permission/i);
    });
    assert.equal(
      requests.length,
      beforeDenied,
      'denied direct skill input never reaches the provider',
    );
    const declined = parent.prompt(
      '/skill:approved-skill Decline this invocation.',
    );
    await until(() =>
      parent.ui.snapshot().dialogs.some(dialog => dialog.kind === 'select'),
    );
    assert.equal(
      requests.length,
      beforeDenied,
      'skill input waits for its approval',
    );
    parent.ui.respond(parent.ui.snapshot().dialogs[0].id, 'Deny');
    await declined.catch(error => {
      assert.match(String(error), /declined|permission/i);
    });
    assert.equal(requests.length, beforeDenied);
    const approved = parent.prompt(
      '/skill:approved-skill Approve this invocation.',
    );
    await until(() =>
      parent.ui.snapshot().dialogs.some(dialog => dialog.kind === 'select'),
    );
    parent.ui.respond(
      parent.ui.snapshot().dialogs[0].id,
      'Allow this conversation',
    );
    await approved;
    assert.equal(requests.length, beforeDenied + 1);
    const expanded = JSON.stringify(requests.at(-1)!.messages);
    assert.equal(expanded.split('APPROVED SKILL BODY MARKER').length - 1, 1);
    assert.doesNotMatch(expanded, /DENIED SKILL BODY MARKER/);
    const beforeRemembered = requests.length;
    await parent.prompt(
      '/skill:approved-skill Reuse this conversation approval.',
    );
    assert.equal(requests.length, beforeRemembered + 1);
    assert.equal(parent.ui.snapshot().dialogs.length, 0);

    const readApproved = parent.prompt(
      'read-approved-skill with the read tool.',
    );
    await until(() =>
      parent.ui.snapshot().dialogs.some(dialog => dialog.kind === 'select'),
    );
    await until(
      () =>
        parent.ui
          .snapshot()
          .dialogs[0]?.terminal?.output.includes('approved-skill') === true,
    );
    parent.ui.respond(parent.ui.snapshot().dialogs[0].id, 'Allow once');
    await readApproved;
    assert.match(
      JSON.stringify(
        requests.at(-1)!.messages.findLast(message => message.role === 'tool')
          ?.content,
      ),
      /APPROVED SKILL BODY MARKER/,
    );
    await parent.prompt('read-denied-skill with the read tool.');
    const deniedRead = JSON.stringify(requests.at(-1)!.messages);
    assert.match(deniedRead, /permission denied/i);
    assert.doesNotMatch(deniedRead, /DENIED SKILL BODY MARKER/);
    await parent.reload();
    assert.ok(
      !(await parent.features()).commands.some(
        command => command.name === 'skill:denied-skill',
      ),
    );
    const beforeReloadedDeny = requests.length;
    await parent.prompt('/skill:denied-skill').catch(error => {
      assert.match(String(error), /denied|permission/i);
    });
    assert.equal(requests.length, beforeReloadedDeny);

    const neutral = await createDashboardParent({cwd}, inherited);
    parents.push(neutral);
    assert.equal((await neutral.features()).agentProfile?.id, 'default');
    assert.ok(
      (await neutral.features()).commands.some(
        command => command.name === 'skill:denied-skill',
      ),
    );
    await neutral.prompt(
      '/skill:denied-skill Load this skill without a profile restriction.',
    );
    assert.match(
      JSON.stringify(requests.at(-1)!.messages),
      /DENIED SKILL BODY MARKER/,
    );
    assert.equal(neutral.ui.snapshot().dialogs.length, 0);

    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({
        retry: {enabled: false},
        default_agent: 'skill-policy',
        permissions: [
          ...profile.permissions,
          {
            action: 'subagent',
            resource: 'native-blocked-helper',
            effect: 'deny',
          },
        ],
      }),
    );
    for (const id of ['native-blocked-helper', 'native-open-helper'])
      await saveAgentTemplate(cwd, {
        scope: 'repository',
        id,
        mode: 'subagent',
        instructions: 'Native helper profile.',
      });
    const nativeUi = new DesktopExtensionUI(() => {});
    const nativeManager = SessionManager.create(
      cwd,
      join(directory, 'native-sessions'),
    );
    const nativeFactory: ExtensionFactory = pi => {
      const shared: AgentToolsOptions = {};
      const control = registerAgentTools(pi, undefined, shared);
      registerFactory(
        pi,
        control,
        {
          isOpen: () => false,
          launch: async () => {
            throw new Error('Unexpected native window');
          },
          detach: () => {},
        },
        shared,
      );
    };
    const nativeLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      systemPrompt: 'NATIVE BASE PROMPT MARKER',
      appendSystemPrompt: ['NATIVE APPEND PROMPT MARKER'],
      extensionFactories: [nativeFactory],
    });
    await nativeLoader.reload();
    const {session: native} = await createAgentSession({
      cwd,
      agentDir,
      model: inherited.model,
      modelRuntime: runtime,
      thinkingLevel: 'off',
      resourceLoader: nativeLoader,
      sessionManager: nativeManager,
    });
    nativeCleanup.push(() => {
      native.dispose();
      nativeUi.dispose();
    });
    await native.bindExtensions({
      mode: 'rpc',
      uiContext: nativeUi.context,
      onError: error => errors.push(error),
    });
    const nativeProfiles = nativeManager
      .getEntries()
      .filter(
        entry =>
          entry.type === 'custom' &&
          entry.customType === 'varisdev.agent-profile',
      );
    assert.equal(nativeProfiles.length, 1);
    const nativeProfile =
      nativeProfiles[0].type === 'custom'
        ? (nativeProfiles[0].data as AgentTemplate)
        : undefined;
    assert.equal(nativeProfile?.id, 'default');
    assert.equal(nativeProfile?.instructions, '');
    assert.equal(nativeProfile?.permissionsVersion, 1);
    const beforeNativeDenied = requests.length;
    await native.prompt('/skill:denied-skill');
    assert.equal(requests.length, beforeNativeDenied);
    const nativeDeclined = native.prompt(
      '/skill:approved-skill Decline native skill.',
    );
    await until(() =>
      nativeUi.snapshot().dialogs.some(dialog => dialog.kind === 'select'),
    );
    nativeUi.respond(nativeUi.snapshot().dialogs[0].id, 'Deny');
    await nativeDeclined;
    assert.equal(requests.length, beforeNativeDenied);
    const nativeApproved = native.prompt(
      '/skill:approved-skill Approve native skill.',
    );
    await until(() =>
      nativeUi.snapshot().dialogs.some(dialog => dialog.kind === 'select'),
    );
    nativeUi.respond(
      nativeUi.snapshot().dialogs[0].id,
      'Allow this agent in this workspace',
    );
    await nativeApproved;
    assert.equal(requests.length, beforeNativeDenied + 1);
    const nativePayload = JSON.stringify(requests.at(-1)!.messages);
    assert.equal(
      nativePayload.split('APPROVED SKILL BODY MARKER').length - 1,
      1,
    );
    assert.doesNotMatch(nativePayload, /DENIED SKILL DESCRIPTION/);
    assert.match(nativePayload, /Root skill project context marker/);
    assert.match(nativePayload, /NATIVE BASE PROMPT MARKER/);
    assert.match(nativePayload, /NATIVE APPEND PROMPT MARKER/);
    assert.doesNotMatch(
      nativePayload,
      /Apply the root skill policy|DENIED SKILL BODY MARKER|builtin:default/,
    );
    assert.match(JSON.stringify(requests.at(-1)!.tools), /native-open-helper/);
    assert.doesNotMatch(
      JSON.stringify(requests.at(-1)!.tools),
      /native-blocked-helper/,
    );
    await native.prompt('read-denied-skill with the read tool.');
    assert.match(
      JSON.stringify(requests.at(-1)!.messages),
      /permission denied.*skill denied-skill/i,
    );
    assert.doesNotMatch(
      JSON.stringify(requests.at(-1)!.messages),
      /DENIED SKILL BODY MARKER/,
    );
    await native.reload();
    assert.equal(
      nativeManager
        .getEntries()
        .filter(
          entry =>
            entry.type === 'custom' &&
            entry.customType === 'varisdev.agent-profile',
        ).length,
      1,
    );
    const beforeNativeReloaded = requests.length;
    await native.prompt(
      '/skill:approved-skill Reuse approval after native reload.',
    );
    assert.equal(requests.length, beforeNativeReloaded + 1);
    assert.equal(nativeUi.snapshot().dialogs.length, 0);

    const explicitSkill = join(directory, 'explicit-native-skill');
    await mkdir(explicitSkill);
    await writeFile(
      join(explicitSkill, 'SKILL.md'),
      '---\nname: explicit-native-skill\ndescription: EXPLICIT NATIVE SKILL DESCRIPTION\n---\nExplicit skill body.',
    );
    const taskManager = SessionManager.create(
      cwd,
      join(directory, 'native-task-sessions'),
    );
    taskManager.appendCustomEntry('varisdev.agent-profile', {
      ...nativeProfile!,
      id: 'saved-native-task',
      key: 'repository:saved-native-task',
      context: 'task',
      instructions: 'SAVED NATIVE TASK PROFILE BODY',
      model: 'unavailable/profile-model',
      thinkingLevel: 'high',
    });
    const taskLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      systemPrompt: 'NATIVE BASE PROMPT MARKER',
      appendSystemPrompt: ['NATIVE APPEND PROMPT MARKER'],
      additionalSkillPaths: [explicitSkill],
      extensionFactories: [nativeFactory],
    });
    await taskLoader.reload();
    const {session: taskNative} = await createAgentSession({
      cwd,
      agentDir,
      model: inherited.model,
      modelRuntime: runtime,
      thinkingLevel: 'off',
      resourceLoader: taskLoader,
      sessionManager: taskManager,
    });
    const taskUi = new DesktopExtensionUI(() => {});
    nativeCleanup.push(() => {
      taskNative.dispose();
      taskUi.dispose();
    });
    await taskNative.bindExtensions({
      mode: 'rpc',
      uiContext: taskUi.context,
      onError: error => errors.push(error),
    });
    await taskNative.prompt('Use the saved native task profile.');
    const taskPayload = JSON.stringify(requests.at(-1)!.messages);
    assert.equal(
      taskPayload.split('SAVED NATIVE TASK PROFILE BODY').length - 1,
      1,
    );
    assert.match(taskPayload, /NATIVE APPEND PROMPT MARKER/);
    assert.doesNotMatch(taskPayload, /NATIVE BASE PROMPT MARKER/);
    assert.match(taskPayload, /EXPLICIT NATIVE SKILL DESCRIPTION/);
    assert.doesNotMatch(
      taskPayload,
      /OPEN SKILL DESCRIPTION|APPROVED SKILL DESCRIPTION|DENIED SKILL DESCRIPTION/,
    );
    assert.match(
      taskPayload,
      /Root skill project context marker/,
      'native context files lack source information needed to distinguish explicit files',
    );
    assert.equal(taskNative.model?.id, inherited.model.id);
    assert.equal(taskNative.thinkingLevel, 'off');
    assert.deepEqual(errors, []);
  },
);
