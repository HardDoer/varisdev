import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import {registerCommitCommand} from '../src/commit.ts';
import {saveToolSettings} from '../src/tools/settings.ts';

async function setup(t: TestContext, selectModels = true) {
  const directory = await mkdtemp(join(tmpdir(), 'varisdev-commit-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, {recursive: true, force: true});
  });
  const messages: Array<{text: string; options: unknown}> = [];
  let command!: Parameters<ExtensionAPI['registerCommand']>[1];
  let effort = 'high';
  const models = [
    {provider: 'p', id: 'parent', reasoning: true},
    {
      provider: 'custom',
      id: 'organization/model',
      reasoning: true,
      thinkingLevelMap: {xhigh: 'xhigh', max: 'max'},
    },
    {provider: 'p', id: 'simple', reasoning: false},
  ];
  if (selectModels)
    await saveToolSettings('agents', {
      allowedModels: models.map(model => `${model.provider}/${model.id}`),
    });
  const ctx = {
    model: models[0],
    modelRegistry: {
      find: (provider: string, id: string) =>
        models.find(model => model.provider === provider && model.id === id),
    },
  } as unknown as ExtensionCommandContext;
  registerCommitCommand({
    registerCommand(name: string, definition: typeof command) {
      assert.equal(name, 'commit');
      command = definition;
    },
    getThinkingLevel: () => effort,
    sendUserMessage(text: string, options: unknown) {
      messages.push({text, options});
    },
  } as unknown as ExtensionAPI);
  return {
    directory,
    ctx,
    models,
    messages,
    effort: (value: string) => {
      effort = value;
    },
    run: (args = '') => command.handler(args, ctx),
  };
}

void test('/commit inherits exact parent model and effort and preserves delegation instructions', async t => {
  const fixture = await setup(t);
  await fixture.run('  Use the requested commit message and origin/main.  ');
  const [{text, options}] = fixture.messages;
  assert.ok(
    text.includes(JSON.stringify({model: 'p/parent', thinkingLevel: 'high'})),
  );
  assert.match(text, /agent_spawn.*autoCleanup=true/);
  assert.match(text, /Coordinate with active workers/);
  assert.match(text, /keep commit hooks enabled/);
  assert.match(text, /agent_status or agent_wait/);
  assert.match(
    text,
    /Additional user instructions.*\nUse the requested commit message and origin\/main\./,
  );
  assert.deepEqual(options, {deliverAs: 'steer'});
});

void test('/commit reads saved model and effort on each invocation, including independently inherited fields', async t => {
  const fixture = await setup(t);
  await saveToolSettings('commit', {
    model: 'custom/organization/model',
    thinkingLevel: 'xhigh',
  });
  await fixture.run();
  assert.ok(
    fixture.messages.at(-1)!.text.includes(
      JSON.stringify({
        model: 'custom/organization/model',
        thinkingLevel: 'xhigh',
      }),
    ),
  );
  fixture.effort('low');
  await saveToolSettings('commit', {
    model: 'custom/organization/model',
    thinkingLevel: null,
  });
  await fixture.run();
  assert.ok(
    fixture.messages.at(-1)!.text.includes(
      JSON.stringify({
        model: 'custom/organization/model',
        thinkingLevel: 'low',
      }),
    ),
  );
  await saveToolSettings('commit', {model: null, thinkingLevel: 'off'});
  await fixture.run();
  assert.ok(
    fixture.messages
      .at(-1)!
      .text.includes(JSON.stringify({model: 'p/parent', thinkingLevel: 'off'})),
  );
});

void test('/commit preserves supported max reasoning from the parent and saved settings', async t => {
  const fixture = await setup(t);
  fixture.ctx.model = fixture.models[1] as typeof fixture.ctx.model;
  fixture.effort('max');
  await fixture.run();
  const selection = JSON.stringify({
    model: 'custom/organization/model',
    thinkingLevel: 'max',
  });
  assert.ok(fixture.messages.at(-1)!.text.includes(selection));
  fixture.ctx.model = fixture.models[0] as typeof fixture.ctx.model;
  fixture.effort('low');
  await saveToolSettings('commit', {
    model: 'custom/organization/model',
    thinkingLevel: 'max',
  });
  await fixture.run();
  assert.ok(fixture.messages.at(-1)!.text.includes(selection));
});

void test('/commit rejects unavailable models, disallowed inheritance and stale explicit policy without dispatch', async t => {
  const fixture = await setup(t);
  await saveToolSettings('agents', {allowedModels: ['missing/model']});
  await saveToolSettings('commit', {
    model: 'missing/model',
    thinkingLevel: null,
  });
  await assert.rejects(fixture.run(), /unavailable.*Menu → Commit settings/);
  await saveToolSettings('commit', {model: null, thinkingLevel: null});
  await saveToolSettings('agents', {
    allowedModels: ['custom/organization/model'],
  });
  await assert.rejects(
    fixture.run(),
    /Menu → Agent models.*custom\/organization\/model/,
  );
  // An externally edited file can contain an obsolete explicit choice.
  await writeFile(
    join(fixture.directory, 'varisdev', 'tool-settings.json'),
    JSON.stringify({
      agents: {allowedModels: ['custom/organization/model']},
      commit: {model: 'p/parent', thinkingLevel: 'off'},
    }),
  );
  await assert.rejects(fixture.run(), /not allowed/);
  assert.equal(fixture.messages.length, 0);
});

void test('/commit surfaces SDK effort limits and missing parent selection before dispatch', async t => {
  const fixture = await setup(t);
  await saveToolSettings('commit', {model: 'p/simple', thinkingLevel: 'high'});
  await assert.rejects(
    fixture.run(),
    /unsupported.*Supported levels: off.*Commit settings/,
  );
  await saveToolSettings('commit', {model: 'p/parent', thinkingLevel: 'xhigh'});
  await assert.rejects(fixture.run(), /xhigh is unsupported/);
  await saveToolSettings('commit', {model: null, thinkingLevel: null});
  fixture.effort('max');
  await assert.rejects(fixture.run(), /max is unsupported/);
  fixture.ctx.model = undefined;
  await assert.rejects(fixture.run(), /Choose a parent model/);
  assert.equal(fixture.messages.length, 0);
});

void test('/commit requires an agent model selection with fresh settings', async t => {
  const fixture = await setup(t, false);
  await assert.rejects(
    fixture.run(),
    /No agent models selected.*Choose a model in Menu → Agent models/,
  );
  assert.equal(fixture.messages.length, 0);
});
