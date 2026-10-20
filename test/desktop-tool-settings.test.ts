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

void test('app catalog uses Pi available models and refreshes local custom models', async t => {
  const {directory} = await fixture(t);
  const writeModels = (id: string) =>
    writeFile(
      join(directory, 'models.json'),
      JSON.stringify({
        providers: {
          'unconfigured-fixture': {
            baseUrl: 'https://unconfigured-fixture.invalid/v1',
            api: 'openai-completions',
            models: [{id: 'unavailable', name: 'Unconfigured model'}],
          },
          'desktop-fixture': {
            baseUrl: 'https://model-fixture.invalid/v1',
            api: 'openai-completions',
            apiKey: 'fixture-key',
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
  });
  assert.ok(
    !initial.models.some(model => model.provider === 'unconfigured-fixture'),
  );
  await assert.rejects(
    service.saveToolSettings('agents', {
      allowedModels: ['unconfigured-fixture/unavailable'],
    }),
    /Unknown model/,
  );
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
  assert.deepEqual(
    (await service.getToolSettings()).settings.agents.allowedModels,
    ['desktop-fixture/local/two'],
  );
});

void test('healthy global extension models remain selectable with extension diagnostics', async t => {
  const {directory} = await fixture(t);
  await mkdir(join(directory, 'extensions'));
  await copyFile(
    new URL('./fixtures/global-model-catalog.js', import.meta.url),
    join(directory, 'extensions', 'catalog.js'),
  );
  await writeFile(
    join(directory, 'auth.json'),
    JSON.stringify({'global-extension': {type: 'api_key', key: 'fixture-key'}}),
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
  const selected = await service.getToolSettings('session');
  assert.deepEqual(selected.models, [first]);
  assert.equal(selected.diagnostics, undefined);
  const persisted = await readToolSettings();
  assert.deepEqual(persisted.agents.allowedModels, ids);
});

void test('desktop saves copy queued inputs and return live session choices', async t => {
  const {service, models} = await fixture(t);
  const replacement = {agents: {allowedModels: [firstId]}};
  const pending = service.saveToolSettings('all', replacement, 'session');
  replacement.agents.allowedModels[0] = 'unknown/mutated';
  const saved = await pending;
  assert.deepEqual(saved.settings, {agents: {allowedModels: [firstId]}});
  assert.deepEqual(saved.models, models);
  await saveToolSettings('agents', {allowedModels: [secondId]});
  assert.deepEqual(
    (await service.getToolSettings('session')).settings.agents.allowedModels,
    [secondId],
  );
  models.push({provider: 'new-extension', id: 'new', name: 'New'});
  assert.equal((await service.getToolSettings('session')).models.length, 3);
});

void test('invalid IPC settings and unknown models preserve saved choices', async t => {
  const {service} = await fixture(t);
  await service.saveToolSettings(
    'agents',
    {allowedModels: [firstId]},
    'session',
  );
  const before = await readToolSettings();
  const invalid: Array<[unknown, unknown]> = [
    ['__proto__', {}],
    [null, {}],
    ['agents', null],
    ['agents', []],
    ['agents', {allowedModels: 'all'}],
    ['agents', {allowedModels: [42]}],
    ['agents', {allowedModels: [firstId], extra: true}],
    ['agents', {allowedModels: ['unknown/new']}],
    ['commit', {model: firstId, thinkingLevel: null}],
    [
      'all',
      {
        agents: {allowedModels: [secondId]},
        commit: {model: null, thinkingLevel: null},
      },
    ],
    ['all', {agents: {allowedModels: ['unknown/new']}}],
  ];
  for (const [section, value] of invalid) {
    await assert.rejects(service.saveToolSettings(section, value, 'session'));
    assert.deepEqual(await readToolSettings(), before);
  }
  const saved = await service.saveToolSettings(
    'all',
    {agents: {allowedModels: [secondId]}},
    'session',
  );
  assert.deepEqual(saved.settings, {agents: {allowedModels: [secondId]}});
});

void test('saved unavailable choices can be retained or removed but cannot be reintroduced', async t => {
  const {service} = await fixture(t);
  const missing = 'removed-provider/old-model';
  await saveToolSettings('agents', {allowedModels: [missing]});
  assert.deepEqual(
    (await service.getToolSettings('session')).settings.agents.allowedModels,
    [missing],
  );
  await service.saveToolSettings(
    'all',
    {agents: {allowedModels: [missing, firstId]}},
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
  const saved = await service.saveToolSettings(
    'all',
    {agents: {allowedModels: []}},
    'session',
  );
  assert.deepEqual(saved.settings.agents.allowedModels, []);
});

void test('stale session errors propagate without using the app catalog or saving', async t => {
  await fixture(t);
  const service = new DesktopToolSettings({
    sessionFeatures: async () => {
      throw new Error('Unknown workspace.');
    },
    createRuntime: async () => {
      throw new Error('Unexpected app catalog fallback.');
    },
  });
  await assert.rejects(service.getToolSettings('closed'), /Unknown workspace/);
  await assert.rejects(
    service.saveToolSettings('agents', {allowedModels: [firstId]}, 'closed'),
    /Unknown workspace/,
  );
  assert.deepEqual((await readToolSettings()).agents.allowedModels, []);
});

void test('live Pi scope limits new choices and preserves saved agent preferences', async t => {
  const {directory, models, scopedModels, service} = await fixture(t);
  await writeFile(
    join(directory, 'settings.json'),
    JSON.stringify({enabledModels: [firstId]}),
  );
  await saveToolSettings('agents', {allowedModels: [firstId]});
  const before = await readToolSettings();
  scopedModels.push({model: second, thinkingLevel: 'high'});
  const restricted = await service.getToolSettings('session');
  assert.deepEqual(restricted.models, [second]);
  assert.deepEqual(restricted.settings, before);
  await service.saveToolSettings(
    'all',
    {agents: {allowedModels: [firstId, secondId]}},
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
  scopedModels.splice(0, 1, {model: first});
  await assert.rejects(
    service.saveToolSettings(
      'agents',
      {allowedModels: [secondId, 'unknown/new']},
      'session',
    ),
    /Unknown model/,
  );
  scopedModels.length = 0;
  assert.deepEqual((await service.getToolSettings('session')).models, models);
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
  // Session state takes priority over saved global settings.
  assert.deepEqual((await service.getToolSettings('session')).models, [first]);
  await service.saveToolSettings('agents', {allowedModels: [physical]});
  for (const scope of [[], undefined, ['missing-provider/missing']]) {
    await writeScope(scope);
    const fallback = await service.getToolSettings();
    assert.ok(
      fallback.models.some(
        model => `${model.provider}/${model.id}` === physical,
      ),
    );
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
