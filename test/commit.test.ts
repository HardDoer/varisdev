import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test, type TestContext} from 'node:test';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import {registerCommitCommand} from '../src/commit.ts';
import {builtinCommitSkillPath} from '../src/builtin-assets.ts';
import {
  createDefaultAgentProfile,
  deleteAgentTemplate,
  resolveAgentTemplate,
  saveAgentTemplate,
} from '../src/agents/templates.ts';
import {saveToolSettings} from '../src/tools/settings.ts';
import type {AgentPolicyOptions} from '../src/agents/policy.ts';

async function setup(
  t: TestContext,
  selectModels = true,
  policyOptions: AgentPolicyOptions = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'varisdev-commit-'));
  const agentDirectory = join(directory, 'agent');
  const cwd = join(directory, 'repository');
  await mkdir(join(cwd, '.git'), {recursive: true});
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, {recursive: true, force: true});
  });
  const messages: Array<{text: string; options: unknown}> = [];
  let command!: Parameters<ExtensionAPI['registerCommand']>[1];
  let commands: ReturnType<ExtensionAPI['getCommands']> = [];
  let effort = 'high';
  const models = [
    {provider: 'p', id: 'parent', reasoning: true},
    {
      provider: 'custom',
      id: 'organization/model',
      reasoning: true,
      thinkingLevelMap: {xhigh: 'xhigh', max: 'max'},
    },
    {provider: 'p', id: 'simple', reasoning: false},
  ];
  if (selectModels)
    await saveToolSettings('agents', {
      allowedModels: models.map(model => `${model.provider}/${model.id}`),
    });
  const ctx = {
    cwd,
    model: models[0],
    modelRegistry: {
      find: (provider: string, id: string) =>
        models.find(model => model.provider === provider && model.id === id),
    },
  } as unknown as ExtensionCommandContext;
  registerCommitCommand(
    {
      registerCommand(name: string, definition: typeof command) {
        assert.equal(name, 'commit');
        command = definition;
      },
      getThinkingLevel: () => effort,
      getCommands: () => commands,
      sendUserMessage(text: string, options: unknown) {
        messages.push({text, options});
      },
    } as unknown as ExtensionAPI,
    undefined,
    policyOptions,
  );
  return {
    agentDirectory,
    ctx,
    models,
    messages,
    commands: (value: ReturnType<ExtensionAPI['getCommands']>) => {
      commands = value;
    },
    effort: (value: string) => {
      effort = value;
    },
    run: (args = '') => command.handler(args, ctx),
    configuration: () => {
      const match = messages
        .at(-1)!
        .text.match(
          /Use these exact agent_spawn configuration arguments: (\{[^\n]+\})/,
        );
      assert.ok(match);
      return JSON.parse(match[1]);
    },
    save: (
      scope: 'global' | 'repository' | 'workspace',
      fields: {model?: string; thinkingLevel?: 'off' | 'low' | 'xhigh'},
    ) =>
      saveAgentTemplate(cwd, {
        scope,
        id: 'commit',
        name: `${scope} commit agent`,
        instructions: `${scope} commit instructions`,
        ...fields,
      }),
  };
}

void test('/commit uses the bundled skill and agent configuration and preserves explicit commit and push intent', async t => {
  const fixture = await setup(t);
  await fixture.run('  Use the requested commit message and origin/main.  ');
  const [{text, options}] = fixture.messages;
  assert.deepEqual(fixture.configuration(), {
    template: 'builtin:commit',
    model: 'p/parent',
    thinkingLevel: 'high',
    autoCleanup: true,
  });
  assert.match(text, /<\/skill>\n\nCommit and push\./);
  assert.ok(
    text.startsWith(
      `<skill name="commit" location="${builtinCommitSkillPath}">`,
    ),
  );
  assert.ok(
    text.includes(
      `References are relative to ${dirname(builtinCommitSkillPath)}.`,
    ),
  );
  assert.match(text, /Coordinate with active workers/);
  assert.match(text, /agent_status.*agent_wait/);
  assert.match(
    text,
    /Additional user instructions.*\nUse the requested commit message and origin\/main\./,
  );
  assert.deepEqual(options, {deliverAs: 'steer'});
  // Identity and working instructions come from the agent configuration.
  assert.equal(fixture.configuration().name, undefined);
  assert.equal(fixture.configuration().instructions, undefined);
  const template = await resolveAgentTemplate(
    fixture.ctx.cwd,
    'builtin:commit',
  );
  assert.equal(template?.name, 'Commit and push');
  assert.equal(template?.mode, 'all');
  assert.equal(template?.hidden, true);
  assert.match(template!.instructions, /Keep commit hooks enabled/);
  assert.match(template!.instructions, /Preserve unrelated changes/);
  assert.match(template!.instructions, /Push to the requested destination/);
});

void test('/commit rejects disabled or primary-only configurations before dispatch', async t => {
  const fixture = await setup(t);
  await saveAgentTemplate(fixture.ctx.cwd, {
    scope: 'workspace',
    id: 'commit',
    mode: 'primary',
  });
  await assert.rejects(fixture.run(), /must support subagent or all mode/);
  await saveAgentTemplate(fixture.ctx.cwd, {
    scope: 'workspace',
    id: 'commit',
    mode: 'all',
    disabled: true,
  });
  await assert.rejects(fixture.run(), /unavailable/);
  assert.deepEqual(fixture.messages, []);
});

void test('/commit loads the active commit skill and rereads its content and command source on each invocation', async t => {
  const fixture = await setup(t);
  const skillDirectory = join(fixture.agentDirectory, 'skills', 'commit');
  const skillPath = join(skillDirectory, 'SKILL.md');
  await mkdir(skillDirectory, {recursive: true});
  await writeFile(
    skillPath,
    '---\nname: commit\ndescription: Custom commit workflow\n---\n\nUse the [release guide](guidance.md) before delegating.\n',
  );
  fixture.commands([
    {
      name: 'skill:commit',
      source: 'skill',
      sourceInfo: {
        path: skillPath,
        source: 'local',
        scope: 'user',
        origin: 'top-level',
      },
    },
  ]);
  await fixture.run();
  const first = fixture.messages.at(-1)!.text;
  assert.ok(first.startsWith(`<skill name="commit" location="${skillPath}">`));
  assert.ok(first.includes(`References are relative to ${skillDirectory}.`));
  assert.match(
    first,
    /Use the \[release guide\]\(guidance\.md\) before delegating/,
  );
  assert.doesNotMatch(first, /description: Custom commit workflow/);
  assert.match(first, /<\/skill>\n\nCommit and push\./);
  assert.equal(fixture.configuration().template, 'builtin:commit');

  await writeFile(
    skillPath,
    '---\nname: commit\ndescription: Custom commit workflow\n---\n\nUse the updated release workflow.\n',
  );
  await fixture.run();
  assert.match(
    fixture.messages.at(-1)!.text,
    /Use the updated release workflow/,
  );
  assert.doesNotMatch(fixture.messages.at(-1)!.text, /release guide/);

  fixture.commands([]);
  await fixture.run();
  assert.ok(
    fixture.messages
      .at(-1)!
      .text.startsWith(
        `<skill name="commit" location="${builtinCommitSkillPath}">`,
      ),
  );
  assert.match(fixture.messages.at(-1)!.text, /Coordinate with active workers/);
});

void test('/commit follows builtin < global < repository < workspace overrides and reloads configuration', async t => {
  const fixture = await setup(t);
  await fixture.save('global', {
    model: 'custom/organization/model',
    thinkingLevel: 'xhigh',
  });
  await fixture.run();
  assert.deepEqual(fixture.configuration(), {
    template: 'global:commit',
    model: 'custom/organization/model',
    thinkingLevel: 'xhigh',
    autoCleanup: true,
  });
  await fixture.save('repository', {model: 'p/simple', thinkingLevel: 'off'});
  await fixture.run();
  assert.equal(fixture.configuration().template, 'repository:commit');
  assert.equal(fixture.configuration().model, 'p/simple');
  assert.equal(fixture.configuration().thinkingLevel, 'off');
  await fixture.save('workspace', {});
  await fixture.run();
  assert.equal(fixture.configuration().template, 'workspace:commit');
  assert.equal(fixture.configuration().model, 'p/simple');
  assert.equal(fixture.configuration().thinkingLevel, 'off');
  await fixture.save('workspace', {model: 'p/parent', thinkingLevel: 'low'});
  await fixture.run();
  assert.equal(fixture.configuration().model, 'p/parent');
  assert.equal(fixture.configuration().thinkingLevel, 'low');
  await fixture.save('workspace', {
    model: 'custom/organization/model',
    thinkingLevel: 'xhigh',
  });
  await fixture.run();
  assert.equal(fixture.configuration().model, 'custom/organization/model');
  assert.equal(fixture.configuration().thinkingLevel, 'xhigh');
});

void test('/commit honors legacy model and effort only while using the bundled configuration', async t => {
  const fixture = await setup(t);
  await saveToolSettings('commit', {
    model: 'custom/organization/model',
    thinkingLevel: 'xhigh',
  });
  await fixture.run();
  assert.equal(fixture.configuration().model, 'custom/organization/model');
  assert.equal(fixture.configuration().thinkingLevel, 'xhigh');
  fixture.effort('low');
  await saveToolSettings('commit', {
    model: 'custom/organization/model',
    thinkingLevel: null,
  });
  await fixture.run();
  assert.equal(fixture.configuration().thinkingLevel, 'low');
  await saveToolSettings('commit', {model: null, thinkingLevel: 'off'});
  await fixture.run();
  assert.equal(fixture.configuration().model, 'p/parent');
  assert.equal(fixture.configuration().thinkingLevel, 'off');

  await saveToolSettings('commit', {
    model: 'custom/organization/model',
    thinkingLevel: 'xhigh',
  });
  await fixture.save('global', {});
  await fixture.run();
  assert.equal(fixture.configuration().model, 'p/parent');
  assert.equal(fixture.configuration().thinkingLevel, 'low');
});

void test('/commit preserves supported max reasoning from the current agent and legacy settings', async t => {
  const fixture = await setup(t);
  fixture.ctx.model = fixture.models[1] as typeof fixture.ctx.model;
  fixture.effort('max');
  await fixture.run();
  assert.equal(fixture.configuration().thinkingLevel, 'max');
  fixture.ctx.model = fixture.models[0] as typeof fixture.ctx.model;
  fixture.effort('low');
  await saveToolSettings('commit', {
    model: 'custom/organization/model',
    thinkingLevel: 'max',
  });
  await fixture.run();
  assert.equal(fixture.configuration().model, 'custom/organization/model');
  assert.equal(fixture.configuration().thinkingLevel, 'max');
});

void test('/commit rejects unavailable or disallowed configuration models and stale legacy choices without dispatch', async t => {
  const fixture = await setup(t);
  await fixture.save('global', {model: 'missing/model'});
  await assert.rejects(
    fixture.run(),
    /unavailable.*commit agent configuration/,
  );
  await fixture.save('global', {});
  await saveToolSettings('agents', {
    allowedModels: ['custom/organization/model'],
  });
  await assert.rejects(
    fixture.run(),
    /not allowed.*custom\/organization\/model/,
  );
  await fixture.save('global', {model: 'p/simple', thinkingLevel: 'off'});
  await assert.rejects(fixture.run(), /not allowed/);
  // An externally edited file can contain an obsolete explicit choice.
  await writeFile(
    join(fixture.agentDirectory, 'varisdev', 'tool-settings.json'),
    JSON.stringify({
      agents: {allowedModels: ['custom/organization/model']},
      commit: {model: 'p/parent', thinkingLevel: 'off'},
    }),
  );
  await deleteAgentTemplate(fixture.ctx.cwd, {scope: 'global', id: 'commit'});
  await assert.rejects(fixture.run(), /not allowed/);
  assert.equal(fixture.messages.length, 0);
});

void test('/commit surfaces SDK effort limits and missing current model before dispatch', async t => {
  const fixture = await setup(t);
  await fixture.save('global', {model: 'p/simple'});
  await assert.rejects(
    fixture.run(),
    /unsupported.*Supported levels: off.*commit agent configuration/,
  );
  await fixture.save('global', {model: 'p/parent', thinkingLevel: 'xhigh'});
  await assert.rejects(fixture.run(), /xhigh is unsupported/);
  await fixture.save('global', {});
  fixture.effort('max');
  await assert.rejects(fixture.run(), /max is unsupported/);
  fixture.ctx.model = undefined;
  await assert.rejects(fixture.run(), /Choose a current agent model/);
  assert.equal(fixture.messages.length, 0);
});

void test('/commit requires an agent model selection with fresh settings', async t => {
  const fixture = await setup(t, false);
  await assert.rejects(
    fixture.run(),
    /No agent models selected.*Choose a model in Menu → Tool models/,
  );
  assert.equal(fixture.messages.length, 0);
});

void test('/commit enforces skill permissions and owner approval before dispatch', async t => {
  const controller = new AbortController();
  let approve = false;
  let approvals = 0;
  const fixture = await setup(t, true, {
    signal: () => controller.signal,
    approval: async request => {
      assert.equal(request.action, 'skill');
      assert.equal(request.resource, 'commit');
      assert.equal(request.toolName, '/commit');
      approvals++;
      return approve;
    },
  });
  const profile = createDefaultAgentProfile();
  profile.permissions = [{action: 'skill', resource: 'commit', effect: 'deny'}];
  Object.assign(fixture.ctx, {
    hasUI: false,
    sessionManager: {
      getBranch: () => [
        {
          type: 'custom',
          customType: 'varisdev.agent-profile',
          data: profile,
        },
      ],
    },
  });
  await assert.rejects(fixture.run(), /permission denied: skill commit/);
  assert.equal(approvals, 0);
  assert.equal(fixture.messages.length, 0);

  profile.permissions[0].effect = 'ask';
  await assert.rejects(fixture.run(), /approval declined/);
  assert.equal(approvals, 1);
  assert.equal(fixture.messages.length, 0);
  approve = true;
  await fixture.run();
  assert.equal(approvals, 2);
  assert.equal(fixture.messages.length, 1);
  controller.abort(new Error('Stopped'));
  await assert.rejects(fixture.run(), /permission .*cancelled/);
  assert.equal(approvals, 2);
  assert.equal(fixture.messages.length, 1);
});
