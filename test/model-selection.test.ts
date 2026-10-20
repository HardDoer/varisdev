import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {DesktopExtensionUI} from '../src/dashboard/extension-ui.ts';
import {
  DEFAULT_IMAGE_MODEL,
  getToolModels,
  OPENAI_IMAGE_PRESETS,
  saveToolModel,
  selectToolModel,
} from '../src/tools/model-selection.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tool-models-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const previousImage = process.env.OPENAI_IMAGE_MODEL;
  process.env.PI_CODING_AGENT_DIR = directory;
  delete process.env.OPENAI_IMAGE_MODEL;
  const ui = new DesktopExtensionUI(() => {});
  t.after(async () => {
    ui.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    if (previousImage === undefined) delete process.env.OPENAI_IMAGE_MODEL;
    else process.env.OPENAI_IMAGE_MODEL = previousImage;
    await rm(directory, {recursive: true, force: true});
  });
  async function dialog() {
    for (let attempt = 0; attempt < 200; attempt++) {
      const current = ui.snapshot().dialogs[0];
      if (current) return current;
      await delay(5);
    }
    throw new Error('Image preset chooser did not open');
  }
  return {
    directory,
    ui,
    dialog,
    ctx: {hasUI: true, ui: ui.context},
    path: join(directory, 'varisdev', 'tool-models', 'openai-image.json'),
  };
}

void test('first GUI use hosts native Pi presets and shares its saved choice with Tool models', async t => {
  const {ctx, ui, dialog} = await fixture(t);
  const choice = selectToolModel('openai-image', undefined, ctx);
  const pending = await dialog();
  assert.equal(pending.kind, 'select');
  assert.ok(pending.terminal);
  assert.match(
    pending.title,
    /Choose an OpenAI image model.*Menu → Tool models/,
  );
  assert.match(pending.terminal!.output, /GPT Image 2.5 Sunburst/);
  assert.ok(pending.options?.every(option => !option.includes('(gpt-image-')));
  ui.respond(pending.id, {input: '\x1b[B\r'});
  assert.equal(await choice, 'gpt-image-2.5-flare');
  assert.equal(
    await selectToolModel('openai-image', undefined, ctx),
    DEFAULT_IMAGE_MODEL,
  );
  assert.equal(ui.snapshot().dialogs.length, 0);
  const [settings] = await getToolModels();
  assert.equal(settings.model, DEFAULT_IMAGE_MODEL);
  assert.equal(settings.defaultModel, DEFAULT_IMAGE_MODEL);
  assert.deepEqual(
    settings.presets.map(preset => preset.id),
    [
      'gpt-image-2.5-sunburst',
      'gpt-image-2.5-flare',
      'gpt-image-2',
      'gpt-image-1.5',
      'gpt-image-1',
      'gpt-image-1-mini',
    ],
  );
  await saveToolModel('openai-image', 'gpt-image-1-mini');
  assert.equal(
    await selectToolModel('openai-image', undefined, ctx),
    'gpt-image-1-mini',
  );
  await assert.rejects(
    saveToolModel('openai-image', 'manual-model'),
    /presets/,
  );
  await assert.rejects(
    saveToolModel('../outside', DEFAULT_IMAGE_MODEL),
    /valid tool/,
  );
  assert.equal(OPENAI_IMAGE_PRESETS.length, 6);
});

void test('request and saved models precede the environment, and removal restores it', async t => {
  const {ctx, path, ui} = await fixture(t);
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, JSON.stringify({model: 'legacy-model'}));
  process.env.OPENAI_IMAGE_MODEL = ' environment-model ';
  for (const hasUI of [true, false]) {
    assert.equal(
      await selectToolModel('openai-image', undefined, {...ctx, hasUI}),
      'legacy-model',
    );
    assert.equal(
      await selectToolModel('openai-image', 'request-model', {...ctx, hasUI}),
      'request-model',
    );
  }
  const [settings] = await getToolModels();
  assert.equal(settings.model, 'legacy-model');
  assert.equal(settings.environment, 'OPENAI_IMAGE_MODEL');
  assert.equal(settings.environmentModel, 'environment-model');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).model, 'legacy-model');

  await saveToolModel('openai-image', 'gpt-image-2');
  assert.equal(
    await selectToolModel('openai-image', undefined, ctx),
    'gpt-image-2',
  );
  await saveToolModel('openai-image', '');
  for (const hasUI of [true, false]) {
    assert.equal(
      await selectToolModel('openai-image', undefined, {...ctx, hasUI}),
      'environment-model',
    );
  }
  assert.equal((await getToolModels())[0].model, '');
  assert.equal(ui.snapshot().dialogs.length, 0);
  await assert.rejects(readFile(path), {code: 'ENOENT'});
});

void test('reading and using an environment model never saves it', async t => {
  const {ctx, path, ui} = await fixture(t);
  process.env.OPENAI_IMAGE_MODEL = ' environment-model ';
  const [settings] = await getToolModels();
  assert.equal(settings.model, '');
  assert.equal(settings.environmentModel, 'environment-model');
  assert.equal(
    await selectToolModel('openai-image', undefined, ctx),
    'environment-model',
  );
  assert.equal(ui.snapshot().dialogs.length, 0);
  await assert.rejects(readFile(path), {code: 'ENOENT'});
  delete process.env.OPENAI_IMAGE_MODEL;
  const [withoutEnvironment] = await getToolModels();
  assert.equal(withoutEnvironment.model, '');
  assert.equal(withoutEnvironment.environment, undefined);
  assert.equal(withoutEnvironment.environmentModel, undefined);
});

void test('headless fallback leaves first GUI setup available and cancellation saves nothing', async t => {
  const {ctx, ui, dialog, path} = await fixture(t);
  assert.equal(
    await selectToolModel('openai-image', undefined, {...ctx, hasUI: false}),
    DEFAULT_IMAGE_MODEL,
  );
  await assert.rejects(readFile(path), {code: 'ENOENT'});
  const cancelled = selectToolModel('openai-image', undefined, ctx);
  ui.respond((await dialog()).id);
  await assert.rejects(cancelled, /setup cancelled.*No request was sent/);
  assert.equal((await getToolModels())[0].model, '');
  const abort = new AbortController();
  const aborted = selectToolModel('openai-image', undefined, ctx, abort.signal);
  await dialog();
  abort.abort();
  await assert.rejects(aborted, {name: 'AbortError'});
  assert.equal(ui.snapshot().dialogs.length, 0);
  await assert.rejects(readFile(path), {code: 'ENOENT'});
});

void test('concurrent first uses share a single chooser and choice', async t => {
  const {ctx, ui, dialog} = await fixture(t);
  const first = selectToolModel('openai-image', undefined, ctx);
  const second = selectToolModel('openai-image', undefined, ctx);
  ui.respond((await dialog()).id, {input: '\r'});
  assert.deepEqual(await Promise.all([first, second]), [
    'gpt-image-2.5-sunburst',
    'gpt-image-2.5-sunburst',
  ]);
  assert.equal(ui.snapshot().dialogs.length, 0);
});
