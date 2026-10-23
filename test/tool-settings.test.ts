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

void test('tool settings start empty and persist deduplicated agent choices', async t => {
  const path = await isolate(t);
  assert.deepEqual(await readToolSettings(), {
    agents: {allowedModels: [], maxConcurrentAgents: 6},
  });
  await assert.rejects(
    assertAgentModelAllowed('p/a'),
    /No agent models selected/,
  );
  await saveToolSettings('agents', {allowedModels: ['p/a', 'p/a']});
  assert.deepEqual(await readToolSettings(), {
    agents: {allowedModels: ['p/a'], maxConcurrentAgents: 6},
  });
  await assertAgentModelAllowed('p/a');
  await assert.rejects(assertAgentModelAllowed('p/b'), /not allowed/);
  const settings = await readToolSettings();
  settings.agents.allowedModels!.push('p/b');
  await assert.rejects(assertAgentModelAllowed('p/b'), /not allowed/);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    agents: {allowedModels: ['p/a'], maxConcurrentAgents: 6},
  });
  await saveToolSettings('agents', {allowedModels: null});
  await assertAgentModelAllowed('p/b');
});

void test('configuration model pins override global selections only for that exact model', async t => {
  await isolate(t);
  for (const allowedModels of [[], ['p/allowed'], null]) {
    await saveToolSettings('agents', {allowedModels});
    await assertAgentModelAllowed('p/pinned', undefined, 'p/pinned');
    await assert.rejects(
      assertAgentModelAllowed('p/allowed', undefined, 'p/pinned'),
      /configuration requires model p\/pinned/,
    );
    if (allowedModels !== null)
      await assert.rejects(assertAgentModelAllowed('p/pinned'));
  }
});

void test('queued saves snapshot inputs and leave only the atomic destination', async t => {
  const path = await isolate(t);
  const allowedModels = ['p/a'];
  const pending = saveToolSettings('agents', {allowedModels});
  allowedModels[0] = 'mutated/model';
  await pending;
  assert.deepEqual((await readToolSettings()).agents.allowedModels, ['p/a']);
  const replacement = {agents: {allowedModels: ['p/b', 'p/b']}};
  const saves = Array.from({length: 20}, () =>
    saveToolSettings('all', replacement),
  );
  replacement.agents.allowedModels[0] = 'mutated/model';
  await Promise.all(saves);
  assert.deepEqual(await readToolSettings(), {
    agents: {allowedModels: ['p/b'], maxConcurrentAgents: 6},
  });
  assert.deepEqual(await readdir(join(path, '..')), ['tool-settings.json']);
});

void test('retired commit preferences are discarded without losing agent restrictions', async t => {
  const path = await isolate(t);
  await mkdir(join(path, '..'), {recursive: true});
  for (const commit of [
    {model: 'gone/old', thinkingLevel: 'high'},
    {obsolete: true},
    null,
  ]) {
    await writeFile(
      path,
      JSON.stringify({agents: {allowedModels: ['p/a']}, commit}),
    );
    assert.deepEqual(await readToolSettings(), {
      agents: {allowedModels: ['p/a'], maxConcurrentAgents: 6},
    });
    await assert.rejects(assertAgentModelAllowed('p/b'), /not allowed/);
    await saveToolSettings('agents', {allowedModels: ['p/b']});
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      agents: {allowedModels: ['p/b'], maxConcurrentAgents: 6},
    });
  }
});

void test('invalid updates leave saved settings intact and later saves still succeed', async t => {
  await isolate(t);
  await saveToolSettings('agents', {allowedModels: ['p/a']});
  const before = await readToolSettings();
  const invalid: Array<[unknown, unknown]> = [
    ['unknown', {}],
    ['commit', {model: null, thinkingLevel: null}],
    ['agents', null],
    ['agents', []],
    ['agents', {}],
    ['agents', {allowedModels: null, extra: true}],
    ['agents', {allowedModels: 'p/a'}],
    ['agents', {allowedModels: Array(513).fill('p/a')}],
    ['agents', {allowedModels: Array(1)}],
    ...[
      null,
      [],
      {},
      {agents: {allowedModels: ['p/b']}, extra: true},
      {
        agents: {allowedModels: ['p/b'], maxConcurrentAgents: 6},
        commit: {model: null, thinkingLevel: null},
      },
    ].map(value => ['all', value] as [unknown, unknown]),
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
  for (const [section, value] of invalid) {
    await assert.rejects(saveToolSettings(section, value));
    assert.deepEqual(await readToolSettings(), before);
  }
  await saveToolSettings('all', {agents: {allowedModels: []}});
  await assert.rejects(
    assertAgentModelAllowed('p/a'),
    /No agent models selected/,
  );
});

void test('malformed persisted agent settings fail closed', async t => {
  const path = await isolate(t);
  await mkdir(join(path, '..'), {recursive: true});
  for (const content of [
    '{broken',
    '{}',
    JSON.stringify({agents: {allowedModels: [false]}, commit: null}),
    JSON.stringify({agents: {allowedModels: []}, extra: true}),
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

void test('legacy unrestricted selections remain readable and can be cleared', async t => {
  const path = await isolate(t);
  await mkdir(join(path, '..'), {recursive: true});
  await writeFile(
    path,
    JSON.stringify({
      agents: {allowedModels: null},
      commit: {model: null, thinkingLevel: null},
    }),
  );
  await assertAgentModelAllowed('p/a');
  await saveToolSettings('agents', {allowedModels: []});
  assert.deepEqual(await readToolSettings(), {
    agents: {allowedModels: [], maxConcurrentAgents: 6},
  });
  await assert.rejects(
    assertAgentModelAllowed('p/a'),
    /No agent models selected/,
  );
});

void test('concurrency defaults migrate old settings and model-only saves preserve a saved limit', async t => {
  const path = await isolate(t);
  await mkdir(join(path, '..'), {recursive: true});
  await writeFile(path, JSON.stringify({agents: {allowedModels: ['p/a']}}));
  assert.equal((await readToolSettings()).agents.maxConcurrentAgents, 6);
  await saveToolSettings('agents', {
    allowedModels: ['p/a'],
    maxConcurrentAgents: 1,
  });
  await saveToolSettings('agents', {allowedModels: ['p/b']});
  assert.deepEqual((await readToolSettings()).agents, {
    allowedModels: ['p/b'],
    maxConcurrentAgents: 1,
  });
  assert.equal(
    JSON.parse(await readFile(path, 'utf8')).agents.maxConcurrentAgents,
    1,
  );
  for (const maxConcurrentAgents of [
    0,
    -1,
    1.5,
    '6',
    null,
    undefined,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    await assert.rejects(
      saveToolSettings('agents', {allowedModels: ['p/a'], maxConcurrentAgents}),
      /whole number of at least 1/,
    );
    assert.equal((await readToolSettings()).agents.maxConcurrentAgents, 1);
  }
});
