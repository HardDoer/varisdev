import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, relative} from 'node:path';
import {test} from 'node:test';
import {DefaultResourceLoader} from '@earendil-works/pi-coding-agent';
import {createDirectoryLink} from './filesystem.ts';
import {builtinSkillsDirectory} from '../src/builtin-assets.ts';
import {createAgentResourcePolicy} from '../src/agents/resources.ts';
import {createWorkspaceConfiguration} from '../src/dashboard/workspace-config.ts';

void test('bundled doctor is discovered without saving configuration, survives reload, and yields to a user skill', async t => {
  const root = await mkdtemp(join(tmpdir(), 'varisdev-builtin-skills-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'settings');
  await mkdir(cwd);
  await mkdir(agentDir);
  const settingsPath = join(agentDir, 'settings.json');
  const saved = JSON.stringify({retry: {enabled: false}});
  await writeFile(settingsPath, saved);
  const configuration = createWorkspaceConfiguration(cwd, agentDir);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: configuration.resourceSettingsManager,
    ...configuration.resourceOptions({noExtensions: true, noThemes: true}),
  });
  await loader.reload();
  const bundled = join(builtinSkillsDirectory, 'doctor', 'SKILL.md');
  assert.equal(
    loader.getSkills().skills.find(skill => skill.name === 'doctor')?.filePath,
    bundled,
  );
  assert.deepEqual(loader.getSkills().diagnostics, []);
  await loader.reload();
  assert.equal(
    loader.getSkills().skills.filter(skill => skill.name === 'doctor').length,
    1,
  );
  assert.equal(await readFile(settingsPath, 'utf8'), saved);

  const replacement = join(agentDir, 'skills', 'doctor', 'SKILL.md');
  await mkdir(dirname(replacement), {recursive: true});
  await writeFile(
    replacement,
    '---\nname: doctor\ndescription: Custom installation checks\n---\nCustom doctor.\n',
  );
  await loader.reload();
  const doctors = loader
    .getSkills()
    .skills.filter(skill => skill.name === 'doctor');
  assert.equal(doctors.length, 1);
  assert.equal(doctors[0].filePath, replacement);
  assert.equal(await readFile(settingsPath, 'utf8'), saved);
});

void test('doctor respects task context, disabled skills, and agent skill permissions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'varisdev-builtin-skill-policy-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'settings');
  await mkdir(cwd);
  await mkdir(agentDir);
  for (const scenario of ['workspace', 'task', 'disabled', 'denied'] as const) {
    const configuration = createWorkspaceConfiguration(cwd, agentDir);
    const policy = createAgentResourcePolicy({
      permissions:
        scenario === 'denied'
          ? [{action: 'skill', resource: 'doctor', effect: 'deny'}]
          : [],
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: configuration.resourceSettingsManager,
      ...configuration.resourceOptions(
        policy.resourceOptions({
          noExtensions: true,
          noThemes: true,
          noSkills: scenario === 'disabled',
        }),
        scenario === 'task' ? 'task' : 'workspace',
      ),
    });
    await loader.reload();
    assert.equal(
      loader.getSkills().skills.some(skill => skill.name === 'doctor'),
      scenario === 'workspace',
      scenario,
    );
    if (scenario === 'denied')
      assert.ok(policy.skills().some(skill => skill.name === 'doctor'));
  }
});

void test('bundled fallback retains exclusions from every applicable original settings scope', async t => {
  const root = await mkdtemp(join(tmpdir(), 'varisdev-builtin-exclusions-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const project = join(root, 'project');
  const cwd = join(project, 'nested');
  const agentDir = join(root, 'settings');
  await mkdir(join(project, '.git'), {recursive: true});
  await mkdir(cwd);
  await mkdir(agentDir);
  const paths = createWorkspaceConfiguration(cwd, agentDir).paths;
  const bundled = join(builtinSkillsDirectory, 'doctor', 'SKILL.md');
  const scopes = [
    {name: 'global', base: agentDir},
    {name: 'repository', base: paths.repositoryConfigDir},
    {name: 'current', base: join(cwd, '.pi')},
    {name: 'workspace', base: paths.workspaceDir},
  ];
  for (const scope of scopes) await mkdir(scope.base, {recursive: true});
  for (const scope of scopes) {
    for (const pattern of [
      `-${bundled}`,
      `!${bundled}`,
      `-${dirname(bundled)}`,
      `!${relative(scope.base, dirname(bundled)).replaceAll('\\', '/')}/*`,
      '!doctor',
      '!**/doctor/SKILL.md',
      `-${relative(scope.base, bundled)}`,
    ]) {
      for (const other of scopes)
        await writeFile(
          join(other.base, 'settings.json'),
          JSON.stringify({skills: other === scope ? [pattern] : []}),
        );
      const configuration = createWorkspaceConfiguration(cwd, agentDir);
      configuration.settingsManager.setProjectTrusted(true);
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager: configuration.resourceSettingsManager,
        ...configuration.resourceOptions({noExtensions: true, noThemes: true}),
      });
      await loader.reload();
      assert.ok(
        !loader.getSkills().skills.some(skill => skill.name === 'doctor'),
        `${scope.name}: ${pattern}`,
      );
      await loader.reload();
      assert.ok(
        !loader.getSkills().skills.some(skill => skill.name === 'doctor'),
        `reload ${scope.name}: ${pattern}`,
      );
    }
  }
  for (const [lower, higher, restore, expected] of [
    ['global', 'repository', `+${bundled}`, true],
    ['repository', 'current', `+${relative(join(cwd, '.pi'), bundled)}`, true],
    ['current', 'workspace', `+${relative(paths.workspaceDir, bundled)}`, true],
    ['global', 'workspace', '+unrelated/SKILL.md', false],
  ] as const) {
    for (const scope of scopes)
      await writeFile(
        join(scope.base, 'settings.json'),
        JSON.stringify({
          skills:
            scope.name === lower
              ? [`-${bundled}`]
              : scope.name === higher
                ? [restore]
                : [],
        }),
      );
    const configuration = createWorkspaceConfiguration(cwd, agentDir);
    configuration.settingsManager.setProjectTrusted(true);
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: configuration.resourceSettingsManager,
      ...configuration.resourceOptions({noExtensions: true, noThemes: true}),
    });
    await loader.reload();
    assert.equal(
      loader.getSkills().skills.some(skill => skill.name === 'doctor'),
      expected,
      `${lower} exclusion with ${higher} ${restore}`,
    );
  }
  // Repository preferences are inactive before trust, and a user override still
  // wins by name even when the bundled file has been excluded.
  for (const scope of scopes)
    await writeFile(
      join(scope.base, 'settings.json'),
      JSON.stringify({
        skills: scope.name === 'repository' ? [`-${bundled}`] : [],
      }),
    );
  const untrusted = createWorkspaceConfiguration(cwd, agentDir);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: untrusted.resourceSettingsManager,
    ...untrusted.resourceOptions({noExtensions: true, noThemes: true}),
  });
  await loader.reload();
  assert.ok(loader.getSkills().skills.some(skill => skill.name === 'doctor'));
  untrusted.settingsManager.setProjectTrusted(true);
  await loader.reload();
  assert.ok(!loader.getSkills().skills.some(skill => skill.name === 'doctor'));
  const custom = join(agentDir, 'skills', 'doctor', 'SKILL.md');
  await mkdir(dirname(custom), {recursive: true});
  await writeFile(
    custom,
    '---\nname: doctor\ndescription: User doctor\n---\nUser checks.',
  );
  await loader.reload();
  assert.equal(
    loader.getSkills().skills.find(skill => skill.name === 'doctor')?.filePath,
    custom,
  );
});

void test('explicit bundled doctor selection and user path aliases preserve Pi selection semantics', async t => {
  const root = await mkdtemp(join(tmpdir(), 'varisdev-builtin-explicit-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'settings');
  await mkdir(cwd);
  await mkdir(agentDir);
  const alias = join(root, 'skills-alias');
  await createDirectoryLink(builtinSkillsDirectory, alias);
  const bundled = join(builtinSkillsDirectory, 'doctor', 'SKILL.md');
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({skills: [`-${bundled}`]}),
  );
  for (const context of ['workspace', 'task'] as const) {
    const configuration = createWorkspaceConfiguration(cwd, agentDir);
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: configuration.resourceSettingsManager,
      ...configuration.resourceOptions(
        {
          noExtensions: true,
          noThemes: true,
          additionalSkillPaths: [join(alias, 'doctor', 'SKILL.md')],
        },
        context,
      ),
    });
    await loader.reload();
    const doctor = loader
      .getSkills()
      .skills.find(skill => skill.name === 'doctor');
    assert.ok(doctor, context);
    assert.equal(doctor.sourceInfo.scope, 'temporary');
  }
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({skills: ['!doctor', `+${bundled}`]}),
  );
  const configuration = createWorkspaceConfiguration(cwd, agentDir);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: configuration.resourceSettingsManager,
    ...configuration.resourceOptions({noExtensions: true, noThemes: true}),
  });
  await loader.reload();
  assert.equal(
    loader.getSkills().skills.find(skill => skill.name === 'doctor')?.sourceInfo
      .scope,
    'user',
  );
});
