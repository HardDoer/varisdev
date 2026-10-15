import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {SessionManager, SettingsManager} from '@earendil-works/pi-coding-agent';
import {DesktopModelDefaults} from '../src/desktop/model-defaults.ts';
import {
  createDashboardParent,
  type DesktopDashboardParent,
} from '../src/dashboard/parent.ts';

const provider = 'defaults-fixture';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'varisdev-model-defaults-'));
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'project');
  const previous = process.env.PI_CODING_AGENT_DIR;
  const title = process.title;
  const parents: DesktopDashboardParent[] = [];
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await mkdir(agentDir, {recursive: true});
  await mkdir(cwd, {recursive: true});
  t.after(async () => {
    await Promise.all(parents.map(parent => parent.close()));
    process.title = title;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, {recursive: true, force: true});
  });
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        [provider]: {
          api: 'openai-completions',
          apiKey: 'fixture-key',
          baseUrl: 'https://defaults-fixture.invalid/v1',
          models: [
            {id: 'reasoning', name: 'Reasoning model', reasoning: true},
            {id: 'plain', name: 'Plain model', reasoning: false},
          ],
        },
      },
    }),
  );
  const settingsPath = join(agentDir, 'settings.json');
  const settings = () =>
    SettingsManager.create(cwd, agentDir).getGlobalSettings();
  return {
    agentDir,
    cwd,
    parents,
    settingsPath,
    settings,
    service: new DesktopModelDefaults(),
  };
}

void test('model defaults read app settings, persist both choices, and keep unrelated settings', async t => {
  const {agentDir, settingsPath, settings, service} = await fixture(t);
  await writeFile(
    settingsPath,
    JSON.stringify({
      defaultProvider: provider,
      defaultModel: 'reasoning',
      defaultThinkingLevel: 'high',
      modelThinkingLevels: {[`${provider}/reasoning`]: 'low'},
      theme: 'light',
    }),
  );
  await mkdir(join(agentDir, '.pi'));
  await writeFile(
    join(agentDir, '.pi', 'settings.json'),
    JSON.stringify({
      defaultProvider: provider,
      defaultModel: 'plain',
      defaultThinkingLevel: 'off',
    }),
  );
  const before = await service.get();
  assert.deepEqual(before.model, {provider, id: 'reasoning'});
  assert.equal(before.thinkingLevel, 'low');
  assert.deepEqual(
    before.models.find(model => model.id === 'plain')?.thinkingLevels,
    ['off'],
  );
  const saved = await service.save({
    provider,
    modelId: 'reasoning',
    thinkingLevel: 'high',
  });
  assert.equal(saved.thinkingLevel, 'high');
  assert.equal(settings().defaultThinkingLevel, 'high');
  assert.equal(
    settings().modelThinkingLevels?.[`${provider}/reasoning`],
    'high',
  );
  assert.equal(settings().theme, 'light');
  assert.deepEqual(await new DesktopModelDefaults().get(), saved);
  // A read after a save observes the durable defaults, without any session ID.
  const saving = service.save({
    provider,
    modelId: 'plain',
    thinkingLevel: 'off',
  });
  const reading = service.get();
  assert.deepEqual((await saving).model, {provider, id: 'plain'});
  assert.deepEqual((await reading).model, {provider, id: 'plain'});
  assert.equal(settings().defaultModel, 'plain');
  assert.equal(settings().defaultThinkingLevel, 'off');
});

void test('invalid model defaults do not save and failures remain retryable', async t => {
  const {settingsPath, service} = await fixture(t);
  await service.save({provider, modelId: 'reasoning', thinkingLevel: 'high'});
  const original = await readFile(settingsPath, 'utf8');
  for (const input of [
    null,
    [],
    {},
    {provider},
    {provider, modelId: 'reasoning'},
    {provider, modelId: 'missing', thinkingLevel: 'high'},
    {provider, modelId: 'reasoning', thinkingLevel: 'invalid'},
    {provider, modelId: 'plain', thinkingLevel: 'high'},
    {
      provider,
      modelId: 'reasoning',
      thinkingLevel: 'high',
      sessionId: 'active',
    },
  ]) {
    await assert.rejects(service.save(input));
    assert.equal(await readFile(settingsPath, 'utf8'), original);
  }
  await writeFile(settingsPath, '{broken');
  await assert.rejects(service.get(), /Could not access model defaults/);
  await assert.rejects(
    service.save({provider, modelId: 'plain', thinkingLevel: 'off'}),
    /Could not access model defaults/,
  );
  assert.equal(await readFile(settingsPath, 'utf8'), '{broken');
  await writeFile(settingsPath, original);
  assert.equal(
    (await service.save({provider, modelId: 'plain', thinkingLevel: 'off'}))
      .thinkingLevel,
    'off',
  );
});

void test('missing defaults do not select a model and unavailable saved defaults remain visible', async t => {
  const {settingsPath, service} = await fixture(t);
  assert.equal((await service.get()).model, undefined);
  await writeFile(
    settingsPath,
    JSON.stringify({
      defaultProvider: 'removed',
      defaultModel: 'old',
      defaultThinkingLevel: 'high',
    }),
  );
  assert.deepEqual((await service.get()).model, {
    provider: 'removed',
    id: 'old',
  });
  assert.equal((await service.get()).thinkingLevel, 'high');
});

void test('new parents use saved defaults while live and resumed selections stay independent', async t => {
  const {cwd, parents, settings, service} = await fixture(t);
  const initial = {provider, modelId: 'reasoning', thinkingLevel: 'high'};
  await service.save(initial);
  const parent = await createDashboardParent({cwd});
  parents.push(parent);
  assert.equal(parent.state.snapshot().session.model, `${provider}/reasoning`);
  assert.equal(parent.state.snapshot().session.thinkingLevel, 'high');
  await parent.prompt('/model defaults-fixture/plain');
  assert.equal(parent.state.snapshot().session.thinkingLevel, 'off');
  assert.equal(settings().defaultModel, 'reasoning');
  assert.equal((await service.get()).thinkingLevel, 'high');
  const fresh = await createDashboardParent({cwd});
  parents.push(fresh);
  assert.equal(fresh.state.snapshot().session.model, `${provider}/reasoning`);
  assert.equal(fresh.state.snapshot().session.thinkingLevel, 'high');
  await parent.configure({
    provider,
    modelId: 'reasoning',
    thinkingLevel: 'low',
  });
  assert.equal(settings().defaultThinkingLevel, 'high');
  await service.save({provider, modelId: 'plain', thinkingLevel: 'off'});
  assert.equal(parent.state.snapshot().session.thinkingLevel, 'low');
  assert.equal(fresh.state.snapshot().session.thinkingLevel, 'high');
  const saved = SessionManager.create(cwd);
  saved.appendModelChange(provider, 'reasoning');
  saved.appendThinkingLevelChange('low');
  saved.appendMessage({
    role: 'user',
    content: 'Saved conversation',
    timestamp: Date.now(),
  });
  saved.appendMessage({
    role: 'assistant',
    content: [{type: 'text', text: 'Saved answer'}],
    provider,
    model: 'reasoning',
    api: 'openai-completions',
    stopReason: 'stop',
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
    },
  });
  const resumed = await createDashboardParent({
    cwd,
    resume: {id: saved.getSessionId(), path: saved.getSessionFile()!},
  });
  parents.push(resumed);
  assert.equal(resumed.state.snapshot().session.model, `${provider}/reasoning`);
  assert.equal(resumed.state.snapshot().session.thinkingLevel, 'low');
  assert.deepEqual((await service.get()).model, {provider, id: 'plain'});
  assert.equal((await service.get()).thinkingLevel, 'off');
});
