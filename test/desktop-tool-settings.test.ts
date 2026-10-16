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
  const service = new DesktopToolSettings({
    sessionFeatures: async sessionId => {
      assert.equal(sessionId, 'session');
      return {models};
    },
    createRuntime: async () => {
      throw new Error('The session catalog must be used.');
    },
  });
  return {directory, models, service};
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
