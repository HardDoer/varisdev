import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {DesktopExtensionUI} from '../src/dashboard/extension-ui.ts';
import {
  getToolModels,
  saveToolModel,
  selectToolModel,
} from '../src/tools/model-selection.ts';

void test('first-use model setup explains the choice, saves it, and supports GUI edits and overrides', async t => {
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
  const ctx = {hasUI: true, ui: ui.context};
  const choice = selectToolModel('openai-image', undefined, ctx);
  while (!ui.snapshot().dialogs.length) await delay(5);
  const dialog = ui.snapshot().dialogs[0];
  assert.match(dialog.title, /needs its own model.*saved for future requests/);
  ui.respond(dialog.id, 'user-image-model');
  assert.equal(await choice, 'user-image-model');
  assert.equal(
    await selectToolModel('openai-image', undefined, ctx),
    'user-image-model',
  );
  assert.equal(ui.snapshot().dialogs.length, 0);
  assert.equal(
    await selectToolModel('openai-image', 'request-model', ctx),
    'request-model',
  );
  assert.equal(
    (await getToolModels()).find(item => item.id === 'openai-image')?.model,
    'user-image-model',
  );
  await saveToolModel('openai-image', 'new-user-model');
  assert.equal(
    await selectToolModel('openai-image', undefined, ctx),
    'new-user-model',
  );
  process.env.OPENAI_IMAGE_MODEL = 'environment-model';
  assert.equal(
    await selectToolModel('openai-image', undefined, ctx),
    'environment-model',
  );
  delete process.env.OPENAI_IMAGE_MODEL;
  await saveToolModel('openai-image', '');
  const cancelled = selectToolModel('openai-image', undefined, ctx);
  while (!ui.snapshot().dialogs.length) await delay(5);
  ui.respond(ui.snapshot().dialogs[0].id);
  await assert.rejects(cancelled, /setup cancelled.*No request was sent/);
  assert.equal(
    (await getToolModels()).find(item => item.id === 'openai-image')?.model,
    '',
  );
  await assert.rejects(
    selectToolModel('openai-image', undefined, {...ctx, hasUI: false}),
    /needs a model choice before its first use/,
  );
  await assert.rejects(saveToolModel('../outside', 'model'), /valid tool/);
});
