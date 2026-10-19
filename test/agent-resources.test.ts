import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {
  DefaultResourceLoader,
  type Skill,
} from '@earendil-works/pi-coding-agent';
import {createAgentResourcePolicy} from '../src/agents/resources.ts';
import {createWorkspaceConfiguration} from '../src/dashboard/workspace-config.ts';

type SkillResources = ReturnType<DefaultResourceLoader['getSkills']>;

function skill(name: string, disableModelInvocation = false): Skill {
  const baseDir = join('/skills', name);
  const filePath = join(baseDir, 'SKILL.md');
  return {
    name,
    description: `${name} instructions`,
    filePath,
    baseDir,
    disableModelInvocation,
    sourceInfo: {
      path: filePath,
      source: 'fixture',
      scope: 'temporary',
      origin: 'top-level',
      baseDir,
    },
  };
}

void test('agent resources filter denied skills after the existing override and retain the full policy catalog', () => {
  const controller = createAgentResourcePolicy({
    permissions: [
      {action: 'skill', resource: '*', effect: 'deny'},
      {action: 'skill', resource: 'build', effect: 'allow'},
      {action: 'skill', resource: 'review', effect: 'ask'},
      {action: 'skill', resource: 'manual', effect: 'allow'},
    ],
  });
  const catalog = controller.skills;
  assert.deepEqual(catalog(), []);
  const input: SkillResources = {
    skills: [skill('secret'), skill('build'), skill('review')],
    diagnostics: [],
  };
  const manual = skill('manual', true);
  const diagnostics = [
    {type: 'warning' as const, message: 'Existing diagnostic'},
  ];
  let previousCalls = 0;
  const options = controller.resourceOptions({
    skillsOverride(base: typeof input) {
      previousCalls++;
      assert.equal(base, input);
      return {...base, skills: [...base.skills, manual], diagnostics};
    },
  });
  const result = options.skillsOverride(input);
  assert.equal(previousCalls, 1);
  assert.deepEqual(
    result.skills.map(item => item.name),
    ['build', 'review', 'manual'],
  );
  assert.deepEqual(
    catalog().map(item => item.name),
    ['secret', 'build', 'review', 'manual'],
  );
  assert.equal(catalog()[0], input.skills[0]);
  assert.equal(result.skills[0], input.skills[1]);
  assert.equal(result.skills[1], input.skills[2]);
  assert.equal(result.skills[2], manual);
  assert.equal(result.skills[2].disableModelInvocation, true);
  assert.equal(result.skills[2].sourceInfo, manual.sourceInfo);
  assert.equal(result.diagnostics, diagnostics);
  assert.deepEqual(
    input.skills.map(item => item.name),
    ['secret', 'build', 'review'],
  );
});

void test('agent resources without skill restrictions preserve the prior result and prompt options', () => {
  for (const profile of [
    undefined,
    {permissions: []},
    {permissions: [{action: 'shell', resource: '*', effect: 'deny' as const}]},
  ]) {
    const controller = createAgentResourcePolicy(profile);
    const result = {
      skills: [skill('manual', true), skill('inspect')],
      diagnostics: [],
    };
    const appendSystemPrompt = ['Explicit instructions'];
    const additionalSkillPaths = ['/selected/SKILL.md'];
    const original = {
      cwd: '/workspace',
      agentDir: '/agent',
      systemPrompt: 'Original system prompt',
      appendSystemPrompt,
      additionalSkillPaths,
      noPromptTemplates: true,
      skillsOverride: () => result,
    };
    const options = controller.resourceOptions(original);
    assert.equal(options.cwd, original.cwd);
    assert.equal(options.agentDir, original.agentDir);
    assert.equal(options.systemPrompt, original.systemPrompt);
    assert.equal(options.appendSystemPrompt, appendSystemPrompt);
    assert.equal(options.additionalSkillPaths, additionalSkillPaths);
    assert.equal(options.noPromptTemplates, true);
    assert.equal(options.skillsOverride({skills: [], diagnostics: []}), result);
    assert.deepEqual(controller.skills(), result.skills);
    assert.equal(result.skills[0].disableModelInvocation, true);
  }
});

void test('workspace and task resource overrides refresh the permission catalog without restoring automatic task skills', async t => {
  const root = await mkdtemp(join(tmpdir(), 'varisdev-agent-resources-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(join(cwd, '.git'), {recursive: true});
  await mkdir(agentDir);
  const putSkill = async (path: string, name: string, manual = false) => {
    await mkdir(dirname(path), {recursive: true});
    await writeFile(
      path,
      `---\nname: ${name}\ndescription: ${name} instructions\n${manual ? 'disable-model-invocation: true\n' : ''}---\nInstructions for ${name}.\n`,
    );
  };
  await putSkill(
    join(agentDir, 'skills', 'automatic', 'SKILL.md'),
    'automatic',
  );
  await putSkill(
    join(agentDir, 'skills', 'automatic-denied', 'SKILL.md'),
    'automatic-denied',
  );
  for (const scope of ['workspace', 'task'] as const) {
    await t.test(scope, async () => {
      const selected = join(root, scope, 'selected', 'SKILL.md');
      const blocked = join(root, scope, 'blocked', 'SKILL.md');
      const manual = join(root, scope, 'manual', 'SKILL.md');
      await putSkill(selected, 'selected');
      await putSkill(blocked, 'blocked');
      await putSkill(manual, 'manual', true);
      const configuration = createWorkspaceConfiguration(cwd, agentDir);
      const controller = createAgentResourcePolicy({
        permissions: [
          {action: 'skill', resource: 'blocked', effect: 'deny'},
          {action: 'skill', resource: 'automatic-denied', effect: 'deny'},
          {action: 'skill', resource: 'selected', effect: 'ask'},
        ],
      });
      const previousCatalogs: string[][] = [];
      const options = configuration.resourceOptions(
        controller.resourceOptions({
          noExtensions: true,
          noThemes: true,
          noPromptTemplates: true,
          additionalSkillPaths: [selected, blocked, manual],
          appendSystemPrompt: ['Explicit instructions'],
          skillsOverride(result) {
            previousCatalogs.push(result.skills.map(item => item.name));
            return result;
          },
        }),
        scope,
      );
      const loader = configuration.resourceLoader(
        new DefaultResourceLoader({
          cwd,
          agentDir,
          settingsManager: configuration.resourceSettingsManager,
          ...options,
        }),
      );
      configuration.settingsManager.setProjectTrusted(true);
      const catalog = controller.skills;
      await loader.reload();
      const names = loader.getSkills().skills.map(item => item.name);
      assert.ok(names.includes('selected'));
      assert.ok(names.includes('manual'));
      assert.equal(names.includes('blocked'), false);
      assert.equal(names.includes('automatic-denied'), false);
      assert.equal(names.includes('automatic'), scope === 'workspace');
      assert.deepEqual(
        catalog().map(item => item.name),
        previousCatalogs.at(-1),
      );
      assert.ok(
        catalog().some(
          item => item.name === 'blocked' && item.filePath === blocked,
        ),
      );
      assert.equal(
        catalog().some(item => item.name === 'automatic-denied'),
        scope === 'workspace',
      );
      assert.equal(
        loader.getSkills().skills.find(item => item.name === 'manual')
          ?.disableModelInvocation,
        true,
      );
      if (scope === 'task')
        assert.deepEqual([...names].sort(), ['manual', 'selected']);
      assert.ok(
        loader.getAppendSystemPrompt().includes('Explicit instructions'),
      );

      await putSkill(blocked, 'approved');
      await loader.reload();
      const reloaded = loader.getSkills().skills.map(item => item.name);
      assert.ok(reloaded.includes('approved'));
      assert.equal(
        catalog().some(item => item.name === 'blocked'),
        false,
      );
      assert.ok(
        catalog().some(
          item => item.name === 'approved' && item.filePath === blocked,
        ),
      );
      assert.deepEqual(
        catalog().map(item => item.name),
        previousCatalogs.at(-1),
      );
      if (scope === 'task')
        assert.deepEqual([...reloaded].sort(), [
          'approved',
          'manual',
          'selected',
        ]);
    });
  }
});
