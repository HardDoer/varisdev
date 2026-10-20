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
  saveAgentTemplate,
  resolveAgentTemplate,
  type AgentTemplate,
} from '../src/agents/templates.ts';
import {
  createDashboardParent,
  type DesktopDashboardParent,
} from '../src/dashboard/parent.ts';
import {saveToolSettings} from '../src/tools/settings.ts';

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
  assert.ok(check(), 'Expected profile integration state');
}

void test(
  'main profiles keep their system body and policy snapshot across approvals, model changes and saved history',
  {timeout: 20000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-profile-parent-'));
    const agentDir = join(directory, 'config');
    const cwd = join(directory, 'project');
    await mkdir(join(cwd, '.git'), {recursive: true});
    await mkdir(agentDir);
    await writeFile(
      join(cwd, 'AGENTS.md'),
      'Project context survives the custom profile base.',
    );
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({retry: {enabled: false}}),
    );
    await mkdir(join(agentDir, 'skills', 'automatic-context'), {
      recursive: true,
    });
    await mkdir(join(agentDir, 'prompts'));
    await writeFile(
      join(agentDir, 'SYSTEM.md'),
      'Automatic global base marker.',
    );
    await writeFile(
      join(agentDir, 'APPEND_SYSTEM.md'),
      'Automatic appended context marker.',
    );
    await writeFile(
      join(agentDir, 'skills', 'automatic-context', 'SKILL.md'),
      '---\nname: automatic-context\ndescription: Automatic skill catalog marker\n---\nSkill content.',
    );
    await writeFile(
      join(agentDir, 'prompts', 'automatic-prompt.md'),
      'Automatic prompt content.',
    );
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
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
        if (prompt.includes('policy-refresh-check')) {
          if (!results.length) {
            await saveToolSettings('agents', {
              allowedModels: ['profile-fixture/configured-model'],
            });
            reply(response, {
              path: 'policy-refresh.txt',
              content: 'Allowed write.',
            });
          } else reply(response, 'Policy refresh finished.');
        } else if (!prompt.includes('exercise-profile'))
          reply(response, 'Restored profile response.');
        else if (!results.length)
          reply(response, {path: 'approved.txt', content: 'Approved write.'});
        else if (results.length === 1)
          reply(response, {path: 'denied.txt', content: 'Forbidden write.'});
        else
          reply(response, 'Profile completed within its model step allowance.');
      } catch (error) {
        errors.push(error);
        response.destroy();
      }
    });
    t.after(async () => {
      for (const parent of parents) await parent.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
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
    await saveAgentTemplate(cwd, {
      scope: 'repository',
      id: 'custom-primary',
      name: 'Custom primary',
      mode: 'primary',
      instructions: 'CUSTOM PROFILE BASE: complete the requested review.',
      model: 'profile-fixture/configured-model',
      thinkingLevel: 'off',
      color: '#3366ff',
      steps: 3,
      permissions: [
        {action: 'edit', resource: '*', effect: 'deny'},
        {action: 'edit', resource: 'approved.txt', effect: 'ask'},
      ],
    });
    const profile = (await resolveAgentTemplate(cwd, 'custom-primary'))!;
    await assert.rejects(
      createDashboardParent(
        {cwd, agentProfile: {...profile, mode: 'subagent'}},
        inherited,
      ),
      /primary use/,
    );
    await assert.rejects(
      createDashboardParent(
        {cwd, agentProfile: {...profile, disabled: true}},
        inherited,
      ),
      /primary use/,
    );
    const parent = await createDashboardParent(
      {cwd, agentProfile: profile},
      inherited,
    );
    parents.push(parent);
    profile.name = 'MUTATED caller-owned name';
    profile.instructions = 'MUTATED caller-owned profile';
    profile.permissions![0].effect = 'allow';
    profile.steps = 99;
    const prompt = parent.prompt(
      'exercise-profile: write the approved file, try the denied file, and report.',
    );
    await until(() => !!parent.ui.snapshot().dialogs.length);
    const confirmation = parent.ui.snapshot().dialogs[0];
    assert.equal(confirmation.kind, 'select');
    assert.match(confirmation.title, /custom-primary/);
    assert.deepEqual(confirmation.options, [
      'Allow once',
      'Allow this conversation',
      'Allow this agent in this workspace',
      'Deny',
    ]);
    parent.ui.respond(confirmation.id, 'Allow once');
    await prompt;
    assert.deepEqual(errors, []);
    assert.equal(
      await readFile(join(cwd, 'approved.txt'), 'utf8'),
      'Approved write.',
    );
    await assert.rejects(readFile(join(cwd, 'denied.txt')), {code: 'ENOENT'});
    assert.equal(requests.length, 3);
    assert.equal(
      requests[0].model,
      'profile-model',
      'a primary profile does not replace the selected Pi model',
    );
    assert.equal(
      requests[0].reasoning_effort,
      'high',
      'a primary profile does not replace the selected Pi effort',
    );
    assert.ok(requests[0].tools?.some(tool => tool.function.name === 'write'));
    assert.equal(requests[2].tools?.length ?? 0, 0);
    assert.match(JSON.stringify(requests[0].messages), /CUSTOM PROFILE BASE/);
    assert.match(
      JSON.stringify(requests[0].messages),
      /Project context survives/,
    );
    assert.match(
      JSON.stringify(requests[0].messages),
      /Automatic appended context marker/,
    );
    assert.match(
      JSON.stringify(requests[0].messages),
      /Automatic skill catalog marker/,
    );
    assert.ok(
      (await parent.features()).commands.some(
        command =>
          command.source === 'prompt' && command.name === 'automatic-prompt',
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(requests[0].messages),
      /MUTATED caller-owned profile/,
    );
    assert.match(
      JSON.stringify(requests[2].messages),
      /Agent permission denied/,
    );
    assert.deepEqual((await parent.features()).agentProfile, {
      id: 'custom-primary',
      name: 'Custom primary',
      mode: 'primary',
      color: '#3366FF',
    });
    await parent.configure({
      provider: 'profile-fixture',
      modelId: 'configured-model',
      thinkingLevel: 'off',
    });
    const saved = parent.state.snapshot().session;
    assert.deepEqual(
      saved.agentProfile,
      (await parent.features()).agentProfile,
    );
    const restart = parent.restartSnapshot();
    assert.ok(
      restart.tools.includes('write'),
      'profile tools restore after the final model step',
    );
    assert.ok(
      restart.entries.some(
        entry =>
          entry.type === 'custom' &&
          entry.customType === 'varisdev.agent-profile',
      ),
    );
    await parent.close();
    await saveAgentTemplate(cwd, {
      scope: 'repository',
      id: 'custom-primary',
      name: 'Edited name on disk',
      instructions: 'Edited profile on disk.',
      mode: 'subagent',
      disabled: true,
    });
    const resumed = await createDashboardParent(
      {cwd, resume: {id: saved.id, path: saved.sessionFile!}},
      inherited,
    );
    parents.push(resumed);
    await resumed.prompt(
      'Check the saved profile after editing its source file.',
    );
    const restored = requests.at(-1)!;
    assert.equal(restored.model, 'configured-model');
    assert.match(JSON.stringify(restored.messages), /CUSTOM PROFILE BASE/);
    assert.doesNotMatch(
      JSON.stringify(restored.messages),
      /Edited profile on disk/,
    );
    assert.ok(
      restored.tools?.some(tool => tool.function.name === 'write'),
      'a new user message resets the step allowance',
    );
    assert.equal((await resumed.features()).thinkingLevel, 'off');
    assert.equal((await resumed.features()).agentProfile?.mode, 'primary');
    assert.deepEqual(
      resumed.state.snapshot().session.agentProfile,
      saved.agentProfile,
    );
    assert.equal(saved.agentProfile?.name, 'Custom primary');

    await saveAgentTemplate(cwd, {
      scope: 'repository',
      id: 'isolated-context',
      mode: 'primary',
      context: 'task',
      instructions: 'Task profile base marker.',
    });
    const taskProfile = (await resolveAgentTemplate(cwd, 'isolated-context'))!;
    const task = await createDashboardParent(
      {
        cwd,
        agentProfile: taskProfile,
        instructions: 'Explicit appended instructions marker.',
      },
      inherited,
    );
    parents.push(task);
    const assertTaskContext = (request: Request) => {
      const messages = JSON.stringify(request.messages);
      assert.equal(messages.split('Task profile base marker.').length - 1, 1);
      assert.equal(
        messages.split('Explicit appended instructions marker.').length - 1,
        1,
      );
      assert.doesNotMatch(
        messages,
        /Project context survives|Automatic global base marker|Automatic appended context marker|Automatic skill catalog marker|exercise-profile|CUSTOM PROFILE BASE/,
      );
      assert.ok(request.tools?.some(tool => tool.function.name === 'read'));
    };
    await task.prompt('Start a fresh task-scoped conversation.');
    assertTaskContext(requests.at(-1)!);
    const taskUserContent = requests
      .at(-1)!
      .messages.findLast(message => message.role === 'user')?.content;
    if (typeof taskUserContent === 'string')
      assert.equal(taskUserContent, 'Start a fresh task-scoped conversation.');
    else
      assert.deepEqual(taskUserContent, [
        {type: 'text', text: 'Start a fresh task-scoped conversation.'},
      ]);
    const taskFeatures = await task.features();
    assert.ok(
      !taskFeatures.commands.some(
        command => command.source === 'skill' || command.source === 'prompt',
      ),
    );
    await task.reload();
    await task.prompt('Check the same context after reload.');
    assertTaskContext(requests.at(-1)!);
    const taskSaved = task.state.snapshot().session;
    assert.ok(
      task
        .restartSnapshot()
        .entries.some(
          entry =>
            entry.type === 'custom' &&
            entry.customType === 'varisdev.agent-context' &&
            (entry.data as {scope?: string})?.scope === 'task',
        ),
    );
    await task.close();
    // Workers may save an explicit task override with a workspace-scoped profile.
    SessionManager.open(taskSaved.sessionFile!).appendCustomEntry(
      'varisdev.agent-profile',
      {...taskProfile, context: 'workspace'},
    );
    await saveAgentTemplate(cwd, {
      scope: 'repository',
      id: 'isolated-context',
      context: 'workspace',
      instructions: 'Edited context profile body.',
    });
    const restoredTask = await createDashboardParent(
      {cwd, resume: {id: taskSaved.id, path: taskSaved.sessionFile!}},
      inherited,
    );
    parents.push(restoredTask);
    await restoredTask.prompt(
      'Reopen the saved task scope as the main conversation.',
    );
    assertTaskContext(requests.at(-1)!);
    assert.doesNotMatch(
      JSON.stringify(requests.at(-1)!.messages),
      /Edited context profile body/,
    );

    const emptyTask = await createDashboardParent(
      {cwd, agentProfile: {...taskProfile, instructions: ''}},
      inherited,
    );
    parents.push(emptyTask);
    await emptyTask.prompt('Use the normal provider base with task context.');
    assert.doesNotMatch(
      JSON.stringify(requests.at(-1)!.messages),
      /Automatic global base marker|Automatic appended context marker|Project context survives|Automatic skill catalog marker/,
    );
    const workspace = await createDashboardParent(
      {
        cwd,
        agentProfile: {...taskProfile, context: 'workspace', instructions: ''},
      },
      inherited,
    );
    parents.push(workspace);
    await workspace.prompt('Use the normal workspace context.');
    const workspaceMessages = JSON.stringify(requests.at(-1)!.messages);
    assert.match(workspaceMessages, /Automatic global base marker/);
    assert.match(workspaceMessages, /Automatic appended context marker/);
    assert.match(workspaceMessages, /Project context survives/);
    assert.match(workspaceMessages, /Automatic skill catalog marker/);
    assert.doesNotMatch(
      workspaceMessages,
      /Start a fresh task-scoped conversation|exercise-profile/,
    );
    const plain = await createDashboardParent({cwd}, inherited);
    parents.push(plain);
    assert.deepEqual((await plain.features()).agentProfile, {
      id: 'default',
      name: 'Default',
      mode: 'all',
    });
    assert.equal(plain.state.snapshot().session.name, 'project');
    assert.equal(plain.state.snapshot().session.agentProfile?.id, 'default');
    const plainEntries = plain.restartSnapshot().entries;
    assert.ok(
      plainEntries.some(
        entry =>
          entry.type === 'custom' &&
          entry.customType === 'varisdev.agent-profile' &&
          (entry.data as {id?: string}).id === 'default',
      ),
    );
    assert.ok(
      !plainEntries.some(
        entry =>
          entry.type === 'custom' &&
          entry.customType === 'varisdev.agent-policy-tools',
      ),
      'neutral Default does not install policy hooks',
    );
    await plain.prompt(
      'Start a plain conversation without a configured profile.',
    );
    const plainRequest = requests.at(-1)!;
    const plainMessages = JSON.stringify(plainRequest.messages);
    assert.ok(
      !plainRequest.tools?.some(
        tool => tool.function.name === 'agent_templates',
      ),
      'configuration CRUD stays deferred until requested',
    );
    assert.doesNotMatch(
      plainMessages,
      /You are (?:the )?(?:Build|Plan|General|Explore)\b|default coding agent|builtin:(?:build|plan|general|explore)/i,
    );
    assert.match(plainMessages, /Automatic global base marker/);
    assert.match(plainMessages, /Automatic appended context marker/);
    assert.match(plainMessages, /Project context survives/);
    assert.doesNotMatch(
      plainMessages,
      /varisdev\.agent-profile|varisdev\.agent-context|builtin:default|CUSTOM PROFILE BASE|Task profile base marker|Edited context profile body|You are (?:the )?(?:delegated agent|Default)|"permissions"|"sourcePath"/,
    );
    const plainSaved = plain.state.snapshot().session;
    await plain.close();
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({
        retry: {enabled: false},
        default_agent: 'isolated-context',
        permissions: [
          {action: 'shell', resource: 'blocked-legacy-command', effect: 'deny'},
        ],
      }),
    );
    const configuredDefault = await createDashboardParent(
      {cwd, model: 'profile-fixture/configured-model', thinkingLevel: 'off'},
      inherited,
    );
    parents.push(configuredDefault);
    const configuredFeatures = await configuredDefault.features();
    assert.equal(configuredFeatures.agentProfile?.id, 'isolated-context');
    assert.equal(configuredFeatures.model?.id, 'configured-model');
    assert.equal(configuredFeatures.thinkingLevel, 'off');
    const legacyDirectory = join(agentDir, 'legacy-sessions');
    await mkdir(legacyDirectory);
    const legacy = SessionManager.create(cwd, legacyDirectory);
    legacy.appendModelChange('profile-fixture', 'profile-model');
    legacy.appendThinkingLevelChange('high');
    for (const entry of SessionManager.open(
      plainSaved.sessionFile!,
    ).getBranch())
      if (
        entry.type === 'message' &&
        (entry.message.role === 'user' || entry.message.role === 'assistant')
      )
        legacy.appendMessage(entry.message);
    const resumedLegacy = await createDashboardParent(
      {
        cwd,
        resume: {id: legacy.getSessionId(), path: legacy.getSessionFile()!},
      },
      inherited,
    );
    parents.push(resumedLegacy);
    assert.equal(
      (await resumedLegacy.features()).agentProfile?.id,
      'default',
      'legacy history gets neutral Default instead of the newly configured custom default',
    );
    const legacyProfiles = resumedLegacy
      .restartSnapshot()
      .entries.filter(
        entry =>
          entry.type === 'custom' &&
          entry.customType === 'varisdev.agent-profile',
      );
    assert.equal(legacyProfiles.length, 1);
    const legacyProfile =
      legacyProfiles[0].type === 'custom'
        ? (legacyProfiles[0].data as AgentTemplate)
        : undefined;
    assert.equal(legacyProfile?.id, 'default');
    assert.equal(legacyProfile?.instructions, '');
    assert.equal(legacyProfile?.model, undefined);
    assert.equal(legacyProfile?.permissionsVersion, 1);
    assert.deepEqual(legacyProfile?.permissions, [
      {action: 'shell', resource: 'blocked-legacy-command', effect: 'deny'},
    ]);
    await resumedLegacy.prompt(
      'Continue the legacy conversation using its normal Pi context.',
    );
    assert.doesNotMatch(
      JSON.stringify(requests.at(-1)!.messages),
      /Edited context profile body|builtin:default|You are (?:the )?Default|varisdev\.agent-profile/,
    );

    const resumedPlain = await createDashboardParent(
      {cwd, resume: {id: plainSaved.id, path: plainSaved.sessionFile!}},
      inherited,
    );
    parents.push(resumedPlain);
    assert.equal(
      (await resumedPlain.features()).agentProfile?.id,
      'default',
      'a later configured default does not replace the saved Default selection',
    );
    await saveAgentTemplate(cwd, {
      scope: 'repository',
      id: 'hidden-default',
      mode: 'primary',
      hidden: true,
      instructions: '',
    });
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({
        retry: {enabled: false},
        default_agent: 'hidden-default',
      }),
    );
    const resumedLegacyAgain = await createDashboardParent(
      {
        cwd,
        resume: {id: legacy.getSessionId(), path: legacy.getSessionFile()!},
      },
      inherited,
    );
    parents.push(resumedLegacyAgain);
    assert.deepEqual(
      resumedLegacyAgain
        .restartSnapshot()
        .entries.filter(
          entry =>
            entry.type === 'custom' &&
            entry.customType === 'varisdev.agent-profile',
        ),
      legacyProfiles,
      'shared permissions are composed and persisted once',
    );
    const invalidDefault = await createDashboardParent({cwd}, inherited);
    parents.push(invalidDefault);
    assert.equal((await invalidDefault.features()).agentProfile?.id, 'default');
    assert.equal(invalidDefault.state.snapshot().session.name, 'project');

    await saveAgentTemplate(cwd, {
      scope: 'repository',
      id: 'local-helper',
      mode: 'subagent',
      instructions: 'Local test helper.',
    });
    await saveAgentTemplate(cwd, {
      scope: 'repository',
      id: 'refresh-policy',
      mode: 'primary',
      instructions: 'Local policy regression profile.',
      steps: 2,
      permissions: [{action: 'subagent', resource: '*', effect: 'deny'}],
    });
    const refreshProfile = (await resolveAgentTemplate(cwd, 'refresh-policy'))!;
    const guarded = await createDashboardParent(
      {cwd, agentProfile: refreshProfile},
      inherited,
    );
    parents.push(guarded);
    const firstPolicyRequest = requests.length;
    await guarded.prompt('policy-refresh-check: write a file and summarize.');
    const policyRequests = requests.slice(firstPolicyRequest);
    assert.equal(policyRequests.length, 2);
    assert.ok(
      policyRequests[0].tools?.some(tool => tool.function.name === 'write'),
    );
    assert.ok(
      !policyRequests[0].tools?.some(
        tool => tool.function.name === 'agent_spawn',
      ),
      'dynamic registration cannot restore a denied subagent tool',
    );
    assert.equal(
      policyRequests[1].tools?.length ?? 0,
      0,
      'a changed tool-model policy cannot restore tools during the final model step',
    );
    assert.equal(
      await readFile(join(cwd, 'policy-refresh.txt'), 'utf8'),
      'Allowed write.',
    );
    assert.deepEqual(errors, []);
  },
);
