import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {
  assertAgentModelAllowed,
  readToolSettings,
  saveToolSettings,
} from '../src/tools/settings.ts';

async function isolate(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'varisdev-settings-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, {recursive: true, force: true});
  });
  return join(directory, 'varisdev', 'tool-settings.json');
}

void test('tool settings default to no allowed models and persist independent sections with deduplicated model IDs', async t => {
  const path = await isolate(t);
  const defaults = {
    agents: {allowedModels: []},
    commit: {model: null, thinkingLevel: null},
  };
  assert.deepEqual(await readToolSettings(), defaults);
  await assert.rejects(
    assertAgentModelAllowed('custom/organization/model'),
    /No agent models selected.*Choose a model in Menu → Agent models/,
  );
  await saveToolSettings('agents', {
    allowedModels: ['custom/organization/model', 'custom/organization/model'],
  });
  await saveToolSettings('commit', {
    model: 'custom/organization/model',
    thinkingLevel: 'high',
  });
  const settings = await readToolSettings();
  assert.deepEqual(settings.agents.allowedModels, [
    'custom/organization/model',
  ]);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), settings);
  settings.agents.allowedModels!.push('other/model');
  await assert.rejects(
    assertAgentModelAllowed('other/model'),
    /Menu → Agent models.*custom\/organization\/model/,
  );
  await saveToolSettings('agents', {allowedModels: null});
  await assertAgentModelAllowed('other/model');
  assert.equal((await readToolSettings()).commit.thinkingLevel, 'high');
});

void test('concurrent saves preserve both sections, copy queued input, and leave only the atomic destination', async t => {
  const path = await isolate(t);
  const allowedModels = ['provider/a', 'provider/b'];
  const pending = saveToolSettings('agents', {allowedModels});
  allowedModels[0] = 'mutated/model';
  await Promise.all([
    pending,
    ...Array.from({length: 20}, (_, i) =>
      saveToolSettings('commit', {
        model: `provider/${i % 2 ? 'b' : 'a'}`,
        thinkingLevel: 'low',
      }),
    ),
  ]);
  assert.deepEqual(await readToolSettings(), {
    agents: {allowedModels: ['provider/a', 'provider/b']},
    commit: {model: 'provider/b', thinkingLevel: 'low'},
  });
  assert.deepEqual(await readdir(join(path, '..')), ['tool-settings.json']);
});

void test('invalid shapes and IDs fail without changing saved settings', async t => {
  await isolate(t);
  await saveToolSettings('agents', {allowedModels: ['p/m']});
  const before = await readToolSettings();
  const invalid: Array<[unknown, unknown]> = [
    ['unknown', {}],
    ['agents', null],
    ['agents', []],
    ['agents', {}],
    ['agents', {allowedModels: null, extra: true}],
    ['agents', {allowedModels: 'p/m'}],
    ['agents', {allowedModels: Array(513).fill('p/m')}],
    ['agents', {allowedModels: Array(1)}],
    ['commit', {model: null}],
    ['commit', {model: null, thinkingLevel: 'max'}],
    ['commit', {model: null, thinkingLevel: 1}],
    ['commit', {model: null, thinkingLevel: null, extra: true}],
    ...[
      '',
      'model',
      '/model',
      'provider/',
      'p/a b',
      'p/a\n',
      'p/a\u0000',
      'p/a\u200b',
      `p/${'m'.repeat(511)}`,
      3,
      null,
    ].map(model => ['agents', {allowedModels: [model]}] as [unknown, unknown]),
  ];
  for (const [section, value] of invalid)
    await assert.rejects(saveToolSettings(section, value));
  assert.deepEqual(await readToolSettings(), before);
});

void test('cross-section conflicts are rejected inside the write queue and later valid saves succeed', async t => {
  await isolate(t);
  await saveToolSettings('agents', {allowedModels: ['p/a']});
  await saveToolSettings('commit', {model: 'p/a', thinkingLevel: null});
  await assert.rejects(
    saveToolSettings('agents', {allowedModels: []}),
    /Commit settings first/,
  );
  assert.deepEqual(await readToolSettings(), {
    agents: {allowedModels: ['p/a']},
    commit: {model: 'p/a', thinkingLevel: null},
  });
  await assert.rejects(
    saveToolSettings('agents', {allowedModels: ['p/b']}),
    /Commit settings first/,
  );
  await saveToolSettings('commit', {model: null, thinkingLevel: null});
  const results = await Promise.allSettled([
    saveToolSettings('agents', {allowedModels: ['p/b']}),
    saveToolSettings('commit', {model: 'p/a', thinkingLevel: null}),
  ]);
  assert.deepEqual(
    results.map(result => result.status),
    ['fulfilled', 'rejected'],
  );
  await saveToolSettings('commit', {model: 'p/b', thinkingLevel: 'off'});
  assert.equal((await readToolSettings()).commit.model, 'p/b');
});

void test('malformed persisted data fails closed rather than allowing every model', async t => {
  const path = await isolate(t);
  await mkdir(join(path, '..'), {recursive: true});
  for (const content of [
    '{broken',
    '{}',
    JSON.stringify({
      agents: {allowedModels: [false]},
      commit: {model: null, thinkingLevel: null},
    }),
  ]) {
    await writeFile(path, content);
    await assert.rejects(readToolSettings(), /Cannot read tool settings/);
    await assert.rejects(
      assertAgentModelAllowed('p/a'),
      /Cannot read tool settings/,
    );
    await assert.rejects(
      saveToolSettings('agents', {allowedModels: null}),
      /Cannot read tool settings/,
    );
    assert.equal(await readFile(path, 'utf8'), content);
  }
});

void test('empty selections persist and deny models while legacy null stays readable', async t => {
  const path = await isolate(t);
  await mkdir(join(path, '..'), {recursive: true});
  await writeFile(
    path,
    JSON.stringify({
      agents: {allowedModels: null},
      commit: {model: null, thinkingLevel: null},
    }),
  );
  assert.equal((await readToolSettings()).agents.allowedModels, null);
  await assertAgentModelAllowed('p/a');
  await saveToolSettings('agents', {allowedModels: ['p/a']});
  await saveToolSettings('agents', {allowedModels: []});
  assert.deepEqual((await readToolSettings()).agents.allowedModels, []);
  assert.deepEqual(
    JSON.parse(await readFile(path, 'utf8')).agents.allowedModels,
    [],
  );
  await assert.rejects(
    assertAgentModelAllowed('p/a'),
    /No agent models selected.*Menu → Agent models/,
  );
  await assert.rejects(
    saveToolSettings('commit', {model: 'p/a', thinkingLevel: null}),
    /No agent models selected.*Menu → Agent models/,
  );
  assert.equal((await readToolSettings()).commit.model, null);
});
