import assert from 'node:assert/strict';
import {copyFile, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {DesktopToolSettings} from '../src/desktop/tool-settings.ts';
import {readToolSettings, saveToolSettings} from '../src/tools/settings.ts';

const first = {provider: 'extension', id: 'custom/first', name: 'First'};
const second = {provider: 'extension', id: 'second', name: 'Second'};
const firstId = `${first.provider}/${first.id}`;
const secondId = `${second.provider}/${second.id}`;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'varisdev-tool-settings-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, {recursive: true, force: true});
  });
  const models = [first, second];
  const scopedModels: Array<{model: typeof first; thinkingLevel?: string}> = [];
  const service = new DesktopToolSettings({
    sessionFeatures: async sessionId => {
      assert.equal(sessionId, 'session');
      return {models, scopedModels};
    },
    createRuntime: async () => {
      throw new Error('The session catalog must be used.');
    },
  });
  return {directory, models, scopedModels, service};
}

void test('app catalog reads Pi models and refreshes local custom models', async t => {
  const {directory} = await fixture(t);
  const writeModels = (id: string) =>
    writeFile(
      join(directory, 'models.json'),
      JSON.stringify({
        providers: {
          'desktop-fixture': {
            baseUrl: 'https://model-fixture.invalid/v1',
            api: 'openai-completions',
            models: [{id, name: 'Local model'}],
          },
        },
      }),
    );
  await writeModels('local/one');
  const service = new DesktopToolSettings({
    sessionFeatures: async () => {
      throw new Error('No session is open.');
    },
  });
  const initial = await service.getToolSettings();
  assert.deepEqual(initial.settings, {
    agents: {allowedModels: []},
    commit: {model: null, thinkingLevel: null},
  });
  assert.ok(initial.models.some(model => model.provider === 'openai'));
  assert.ok(
    initial.models.some(
      model => model.provider === 'desktop-fixture' && model.id === 'local/one',
    ),
  );
  await writeModels('local/two');
  const refreshed = await service.getToolSettings();
  assert.ok(refreshed.models.some(model => model.id === 'local/two'));
  assert.ok(!refreshed.models.some(model => model.id === 'local/one'));
  await service.saveToolSettings('agents', {
    allowedModels: ['desktop-fixture/local/two'],
  });
  const saved = await service.saveToolSettings('commit', {
    model: 'desktop-fixture/local/two',
    thinkingLevel: 'medium',
  });
  assert.equal(saved.settings.commit.model, 'desktop-fixture/local/two');
});

void test('healthy global extension models remain selectable with extension diagnostics', async t => {
  const {directory} = await fixture(t);
  await mkdir(join(directory, 'extensions'));
  await copyFile(
    new URL('./fixtures/global-model-catalog.js', import.meta.url),
    join(directory, 'extensions', 'catalog.js'),
  );
  await writeFile(
    join(directory, 'extensions', 'broken.js'),
    'export default () => { throw new Error("Broken catalog extension"); };',
  );
  const service = new DesktopToolSettings({
    sessionFeatures: async sessionId => {
      assert.equal(sessionId, 'session');
      return {models: [first]};
    },
  });
  const ids = ['global-extension/physical', 'global-extension-router/route'];
  const initial = await service.getToolSettings();
  assert.match(
    initial.diagnostics?.join('\n') ?? '',
    /Broken catalog extension/,
  );
  const catalog = initial.models;
  for (const id of ids)
    assert.ok(catalog.some(model => `${model.provider}/${model.id}` === id));
  await service.saveToolSettings('agents', {allowedModels: ids});
  for (const model of ids) {
    const saved = await service.saveToolSettings('commit', {
      model,
      thinkingLevel: 'high',
    });
    assert.equal(saved.settings.commit.model, model);
    assert.deepEqual(saved.diagnostics, initial.diagnostics);
  }
  const selected = await service.getToolSettings('session');
  assert.deepEqual(selected.models, [first]);
  assert.equal(selected.diagnostics, undefined);
  const persisted = await readToolSettings();
  assert.deepEqual(persisted.agents.allowedModels, ids);
  assert.equal(persisted.commit.model, ids[1]);
});

void test('session extension IDs and live saved settings are returned', async t => {
  const {service, models} = await fixture(t);
  assert.deepEqual((await service.getToolSettings('session')).models, models);
  await service.saveToolSettings(
    'agents',
    {allowedModels: [firstId]},
    'session',
  );
  const saved = await service.saveToolSettings(
    'commit',
    {model: firstId, thinkingLevel: 'xhigh'},
    'session',
  );
  assert.equal(saved.settings.commit.model, firstId);
  await saveToolSettings('commit', {model: null, thinkingLevel: 'off'});
  assert.deepEqual((await service.getToolSettings('session')).settings.commit, {
    model: null,
    thinkingLevel: 'off',
  });
  models.push({provider: 'new-extension', id: 'new', name: 'New'});
  assert.equal((await service.getToolSettings('session')).models.length, 3);
});

void test('invalid IPC values and unknown catalog selections leave settings intact', async t => {
  const {service} = await fixture(t);
  const initial = await readToolSettings();
  const invalid: Array<[unknown, unknown]> = [
    ['__proto__', {}],
    [null, {}],
    ['agents', null],
    ['agents', []],
    ['agents', {allowedModels: 'all'}],
    ['agents', {allowedModels: [42]}],
    ['agents', {allowedModels: [firstId], extra: true}],
    ['commit', {model: firstId, thinkingLevel: 'invalid'}],
    ['commit', {model: false, thinkingLevel: null}],
    ['commit', {model: null, thinkingLevel: null, extra: true}],
    ['agents', {allowedModels: ['unknown/new']}],
    ['commit', {model: 'unknown/new', thinkingLevel: null}],
  ];
  for (const [section, value] of invalid) {
    await assert.rejects(service.saveToolSettings(section, value, 'session'));
    assert.deepEqual(await readToolSettings(), initial);
  }
  // A failed request must not poison the save queue.
  await service.saveToolSettings(
    'agents',
    {allowedModels: [firstId]},
    'session',
  );
});

void test('commit selection and agent allowlist stay consistent across saves', async t => {
  const {service} = await fixture(t);
  await service.saveToolSettings(
    'agents',
    {allowedModels: [firstId]},
    'session',
  );
  await assert.rejects(
    service.saveToolSettings(
      'commit',
      {model: secondId, thinkingLevel: null},
      'session',
    ),
  );
  await service.saveToolSettings(
    'commit',
    {model: firstId, thinkingLevel: 'high'},
    'session',
  );
  await assert.rejects(
    service.saveToolSettings('agents', {allowedModels: [secondId]}, 'session'),
  );
  await assert.rejects(
    service.saveToolSettings('agents', {allowedModels: []}, 'session'),
    /Commit settings first/,
  );
  assert.equal((await readToolSettings()).commit.model, firstId);
  assert.deepEqual((await readToolSettings()).agents.allowedModels, [firstId]);
  await service.saveToolSettings(
    'commit',
    {model: null, thinkingLevel: null},
    'session',
  );
  await service.saveToolSettings(
    'agents',
    {allowedModels: [secondId]},
    'session',
  );
});

void test('saved unavailable choices remain visible and can be retained or removed', async t => {
  const {service} = await fixture(t);
  const missing = 'removed-provider/old-model';
  await saveToolSettings('agents', {allowedModels: [missing]});
  await saveToolSettings('commit', {model: missing, thinkingLevel: 'low'});
  const state = await service.getToolSettings('session');
  assert.deepEqual(state.settings.agents.allowedModels, [missing]);
  assert.equal(state.settings.commit.model, missing);
  await service.saveToolSettings(
    'agents',
    {allowedModels: [missing, firstId]},
    'session',
  );
  await service.saveToolSettings(
    'commit',
    {model: missing, thinkingLevel: 'high'},
    'session',
  );
  await assert.rejects(
    service.saveToolSettings(
      'agents',
      {allowedModels: [missing, 'removed-provider/new']},
      'session',
    ),
    /Unknown model/,
  );
  await service.saveToolSettings(
    'commit',
    {model: null, thinkingLevel: null},
    'session',
  );
  await service.saveToolSettings(
    'agents',
    {allowedModels: [firstId]},
    'session',
  );
  await assert.rejects(
    service.saveToolSettings(
      'agents',
      {allowedModels: [missing, firstId]},
      'session',
    ),
    /Unknown model/,
  );
});

void test('stale session errors propagate without using the app catalog or saving', async t => {
  await fixture(t);
  const service = new DesktopToolSettings({
    sessionFeatures: async () => {
      throw new Error('Unknown parent session.');
    },
    createRuntime: async () => {
      throw new Error('Unexpected app catalog fallback.');
    },
  });
  await assert.rejects(
    service.getToolSettings('closed'),
    /Unknown parent session/,
  );
  await assert.rejects(
    service.saveToolSettings('agents', {allowedModels: [firstId]}, 'closed'),
    /Unknown parent session/,
  );
  assert.deepEqual((await readToolSettings()).agents.allowedModels, []);
});

void test('desktop settings start empty and persist clearing explicit model choices', async t => {
  const {service} = await fixture(t);
  assert.deepEqual(
    (await service.getToolSettings('session')).settings.agents.allowedModels,
    [],
  );
  await service.saveToolSettings(
    'agents',
    {allowedModels: [firstId, secondId]},
    'session',
  );
  const saved = await service.saveToolSettings(
    'agents',
    {allowedModels: []},
    'session',
  );
  assert.deepEqual(saved.settings.agents.allowedModels, []);
  assert.deepEqual((await readToolSettings()).agents.allowedModels, []);
  await assert.rejects(
    service.saveToolSettings(
      'commit',
      {model: firstId, thinkingLevel: null},
      'session',
    ),
    /No agent models selected.*Menu → Agent models/,
  );
});

void test('active Pi scope limits new choices without clearing saved global preferences', async t => {
  const {directory, models, scopedModels, service} = await fixture(t);
  await writeFile(
    join(directory, 'settings.json'),
    JSON.stringify({enabledModels: [secondId]}),
  );
  await saveToolSettings('agents', {allowedModels: [firstId]});
  await saveToolSettings('commit', {model: firstId, thinkingLevel: null});
  const before = await readToolSettings();
  scopedModels.push({model: second, thinkingLevel: 'high'});
  const restricted = await service.getToolSettings('session');
  assert.deepEqual(restricted.models, [second]);
  assert.deepEqual(restricted.settings, before);
  assert.deepEqual(await readToolSettings(), before);
  // Existing preferences may be retained while editing another setting.
  await service.saveToolSettings(
    'agents',
    {allowedModels: [firstId, secondId]},
    'session',
  );
  await service.saveToolSettings(
    'commit',
    {model: firstId, thinkingLevel: 'low'},
    'session',
  );
  await service.saveToolSettings(
    'commit',
    {model: null, thinkingLevel: null},
    'session',
  );
  await service.saveToolSettings('agents', {allowedModels: []}, 'session');
  await assert.rejects(
    service.saveToolSettings('agents', {allowedModels: [firstId]}, 'session'),
    /Unknown model/,
  );
  await service.saveToolSettings(
    'agents',
    {allowedModels: [secondId]},
    'session',
  );
  await service.saveToolSettings(
    'commit',
    {model: secondId, thinkingLevel: null},
    'session',
  );
  assert.equal((await readToolSettings()).commit.thinkingLevel, null);
  // Clearing the live scope restores this session's catalog, even with a
  // different scope still saved globally in Pi.
  scopedModels.length = 0;
  assert.deepEqual((await service.getToolSettings('session')).models, models);
  await service.saveToolSettings(
    'agents',
    {allowedModels: [firstId, secondId]},
    'session',
  );
});

void test('save validates against changed live scope and preserves parent inheritance', async t => {
  const {scopedModels, service} = await fixture(t);
  scopedModels.push({model: first});
  assert.deepEqual((await service.getToolSettings('session')).models, [first]);
  scopedModels.splice(0, 1, {model: second, thinkingLevel: 'high'});
  await assert.rejects(
    service.saveToolSettings('agents', {allowedModels: [firstId]}, 'session'),
    /Unknown model/,
  );
  await saveToolSettings('agents', {allowedModels: null});
  await assert.rejects(
    service.saveToolSettings(
      'commit',
      {model: firstId, thinkingLevel: null},
      'session',
    ),
    /Unknown model/,
  );
  const saved = await service.saveToolSettings(
    'commit',
    {model: null, thinkingLevel: null},
    'session',
  );
  assert.deepEqual(saved.settings, {
    agents: {allowedModels: null},
    commit: {model: null, thinkingLevel: null},
  });
  // A scoped thinking annotation does not silently become a Commit override.
  const explicit = await service.saveToolSettings(
    'commit',
    {model: secondId, thinkingLevel: null},
    'session',
  );
  assert.deepEqual(explicit.settings.commit, {
    model: secondId,
    thinkingLevel: null,
  });
});

void test('no-session pickers resolve and refresh global Pi scope through registered extension models', async t => {
  const {directory} = await fixture(t);
  await mkdir(join(directory, 'extensions'));
  await copyFile(
    new URL('./fixtures/global-model-catalog.js', import.meta.url),
    join(directory, 'extensions', 'catalog.js'),
  );
  const settingsPath = join(directory, 'settings.json');
  const physical = 'global-extension/physical';
  const virtual = 'global-extension-router/route';
  const writeScope = (enabledModels: string[] | undefined) =>
    writeFile(settingsPath, JSON.stringify({enabledModels}));
  // Physical extension models need configured provider access for Pi scoping.
  await writeFile(
    join(directory, 'auth.json'),
    JSON.stringify({'global-extension': {type: 'api_key', key: 'fixture-key'}}),
  );
  await writeScope([`${virtual}:high`]);
  const service = new DesktopToolSettings({
    sessionFeatures: async () => ({models: [first]}),
  });
  const initial = await service.getToolSettings();
  assert.deepEqual(
    initial.models.map(model => `${model.provider}/${model.id}`),
    [virtual],
  );
  await service.saveToolSettings('agents', {allowedModels: [virtual]});
  await service.saveToolSettings('commit', {
    model: virtual,
    thinkingLevel: null,
  });
  await assert.rejects(
    service.saveToolSettings('agents', {allowedModels: [virtual, physical]}),
    /Unknown model/,
  );
  await writeScope(['global-extension/*:low']);
  const changed = await service.getToolSettings();
  assert.deepEqual(
    changed.models.map(model => `${model.provider}/${model.id}`),
    [physical],
  );
  assert.deepEqual(changed.settings.agents.allowedModels, [virtual]);
  assert.deepEqual(changed.settings.commit, {
    model: virtual,
    thinkingLevel: null,
  });
  // Session state takes priority over saved global settings.
  assert.deepEqual((await service.getToolSettings('session')).models, [first]);
  await service.saveToolSettings('commit', {model: null, thinkingLevel: null});
  await service.saveToolSettings('agents', {allowedModels: [physical]});
  await service.saveToolSettings('commit', {
    model: physical,
    thinkingLevel: 'off',
  });
  for (const scope of [[], undefined, ['missing-provider/missing']]) {
    await writeScope(scope);
    const fallback = await service.getToolSettings();
    assert.ok(fallback.models.some(model => model.provider === 'openai'));
    assert.ok(
      fallback.models.some(
        model => `${model.provider}/${model.id}` === virtual,
      ),
    );
    if (scope?.length)
      assert.match(fallback.diagnostics?.join('\n') ?? '', /missing-provider/);
    else assert.equal(fallback.diagnostics, undefined);
  }
});
