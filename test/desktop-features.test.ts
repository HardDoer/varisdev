import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test, type TestContext} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {ModelRegistry, ModelRuntime} from '@earendil-works/pi-coding-agent';
import {
  createDashboardParent,
  type DesktopDashboardParent,
} from '../src/dashboard/parent.ts';

interface Request {
  model: string;
  messages: Array<{role: string; content: unknown}>;
}

async function waitFor(check: () => boolean, description: string) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await delay(5);
  assert.ok(check(), description);
}

async function fixture(t: TestContext, configuredVarisdev = false) {
  const root = await mkdtemp(join(tmpdir(), 'desktop-features-'));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'config');
  const previous = process.env.PI_CODING_AGENT_DIR;
  const title = process.title;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const parents: DesktopDashboardParent[] = [];
  t.after(async () => {
    await Promise.all(parents.map(parent => parent.close()));
    process.title = title;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, {recursive: true, force: true});
  });
  await Promise.all([
    mkdir(join(agentDir, 'skills', 'user-skill'), {recursive: true}),
    mkdir(join(agentDir, 'prompts'), {recursive: true}),
    mkdir(join(cwd, '.pi', 'skills', 'project-skill'), {recursive: true}),
    mkdir(join(cwd, '.pi', 'prompts'), {recursive: true}),
    mkdir(join(cwd, '.pi', 'extensions'), {recursive: true}),
  ]);
  await writeFile(
    join(agentDir, 'skills', 'user-skill', 'SKILL.md'),
    '---\nname: user-skill\ndescription: User fixture skill\n---\nUSER SKILL BODY marker.',
  );
  const skillPath = join(cwd, '.pi', 'skills', 'project-skill', 'SKILL.md');
  await writeFile(
    skillPath,
    '---\nname: project-skill\ndescription: Project fixture skill\n---\nPROJECT SKILL BODY marker.',
  );
  await writeFile(
    join(agentDir, 'prompts', 'user-template.md'),
    '---\ndescription: User fixture template\n---\nUSER TEMPLATE $1 / $@',
  );
  const promptPath = join(cwd, '.pi', 'prompts', 'project-template.md');
  await writeFile(
    promptPath,
    '---\ndescription: Project fixture template\n---\nPROJECT TEMPLATE $1 / $@',
  );
  const extensionPath = join(cwd, '.pi', 'extensions', 'commands.ts');
  await writeFile(
    extensionPath,
    `
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {CustomEditor} from '@earendil-works/pi-coding-agent';
export default function(pi) {
  pi.registerCommand('fixture-command', {
    description: 'Run the fixture dialog command',
    handler: async (args, ctx) => {
      await writeFile(join(ctx.cwd, 'command-started.txt'), args);
      const confirmed = await ctx.ui.confirm('Fixture confirmation', args);
      pi.appendEntry('fixture-command-result', {args, confirmed, hasUI: ctx.hasUI});
      ctx.ui.notify('Fixture command finished: ' + confirmed);
    },
  });
  pi.registerCommand('model-command', {
    description: 'Send a model request from an extension',
    handler: async () => { pi.sendUserMessage('EXTENSION MODEL REQUEST'); },
  });
  pi.registerCommand('terminal-command', {
    description: 'Register a custom editor',
    handler: async (_args, ctx) => {
      ctx.ui.setEditorComponent((tui, theme, keys) => new CustomEditor(tui, theme, keys));
    },
  });
  pi.registerCommand('ui-error-command', {
    description: 'Report an extension UI failure',
    handler: async (_args, ctx) => {
      await ctx.ui.custom(() => { throw new Error('Fixture component failed.'); });
    },
  });
}
`,
  );
  const settingsPath = join(agentDir, 'settings.json');
  const settings = {
    retry: {enabled: false},
    compaction: {enabled: false, reserveTokens: 16000, keepRecentTokens: 32},
    ...(configuredVarisdev
      ? {extensions: [resolve('extensions/varisdev.ts')]}
      : {}),
  };
  await writeFile(settingsPath, JSON.stringify(settings));
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        'configured-fixture': {
          api: 'openai-completions',
          apiKey: 'configured-key',
          baseUrl: 'https://desktop-features.invalid/v1',
          models: [{id: 'configured-model', name: 'User configured model'}],
        },
      },
    }),
  );
  const requests: Request[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (url: RequestInfo | URL, options?: RequestInit) => {
      assert.equal(
        String(url),
        'https://desktop-features.invalid/v1/chat/completions',
      );
      const request = JSON.parse(String(options?.body)) as Request;
      requests.push(request);
      if (JSON.stringify(request.messages).includes('EXTENSION MODEL REQUEST'))
        await delay(20);
      const summary = JSON.stringify(request.messages).includes(
        'You are a context summarization assistant',
      );
      const chunk = {
        id: 'fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model: request.model,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: summary
                ? 'Fixture compacted history.'
                : 'Fixture answer.',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 12000,
          completion_tokens: 20,
          total_tokens: 12020,
        },
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        {
          headers: {'content-type': 'text/event-stream'},
        },
      );
    },
  );
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerProvider('desktop-fixture', {
    api: 'openai-completions',
    apiKey: 'fixture-key',
    baseUrl: 'https://desktop-features.invalid/v1',
    models: ['first-model', 'second-model'].map(id => ({
      id,
      name: id,
      reasoning: true,
      input: ['text'],
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
      contextWindow: 64000,
      maxTokens: 1000,
    })),
  });
  const registry = new ModelRegistry(runtime);
  const parent = await createDashboardParent(
    {cwd, name: 'Feature fixture'},
    {
      model: runtime.getModel('desktop-fixture', 'first-model')!,
      modelRegistry: registry,
      thinkingLevel: 'low',
    },
  );
  parents.push(parent);
  return {
    parent,
    cwd,
    requests,
    settingsPath,
    settings,
    skillPath,
    promptPath,
    extensionPath,
  };
}

const direct = {isQueued: () => true, submitted: () => {}};

void test(
  'desktop catalog loads configured user and project resources and reloads without duplicate VarisDev registrations',
  {timeout: 15000},
  async t => {
    const {
      parent,
      requests,
      settingsPath,
      settings,
      promptPath,
      extensionPath,
      skillPath,
    } = await fixture(t, true);
    const catalog = await parent.features();
    assert.ok(
      catalog.models.some(
        model =>
          model.provider === 'configured-fixture' &&
          model.id === 'configured-model',
      ),
    );
    for (const name of [
      'skill:user-skill',
      'skill:project-skill',
      'user-template',
      'project-template',
      'fixture-command',
      'commit',
      'varisdev',
      'factory',
      'compact',
      'reload',
      'model',
      'thinking',
      'session',
      'name',
    ])
      assert.equal(
        catalog.commands.filter(command => command.name === name).length,
        1,
        name,
      );
    assert.equal(
      catalog.commands.find(command => command.name === 'skill:project-skill')
        ?.path,
      skillPath,
    );
    assert.equal(
      catalog.commands.find(command => command.name === 'project-template')
        ?.path,
      promptPath,
    );
    assert.equal(
      catalog.commands.find(command => command.name === 'fixture-command')
        ?.path,
      extensionPath,
    );
    assert.equal(
      catalog.tools.filter(tool => tool.name === 'agent_spawn').length,
      1,
    );
    assert.equal(
      catalog.tools.filter(tool => tool.name === 'agent_list').length,
      1,
    );
    assert.deepEqual(catalog.diagnostics, []);
    assert.equal(requests.length, 0);
    await writeFile(
      promptPath,
      '---\ndescription: Reloaded template description\n---\nRELOADED $1',
    );
    await writeFile(
      settingsPath,
      JSON.stringify({...settings, enableSkillCommands: false}),
    );
    const stableState = parent.state;
    await parent.reload();
    assert.equal(parent.state, stableState);
    assert.equal(stableState.snapshot().session.status, 'idle');
    const reloaded = await parent.features();
    assert.equal(
      reloaded.commands.find(command => command.name === 'project-template')
        ?.description,
      'Reloaded template description',
    );
    assert.ok(!reloaded.commands.some(command => command.source === 'skill'));
    assert.equal(
      reloaded.commands.filter(command => command.name === 'commit').length,
      1,
    );
    assert.deepEqual(reloaded.diagnostics, []);
    await assert.rejects(
      parent.prompt('/skill:project-skill do work', direct),
      /disabled in settings/,
    );
    assert.equal(requests.length, 0);
    await parent.prompt('/project-template after reload', direct);
    assert.ok(
      stableState
        .snapshot()
        .conversation.some(message => message.text === 'RELOADED after'),
    );
  },
);

void test(
  'desktop SDK expands skills and templates and executes builtins locally',
  {timeout: 15000},
  async t => {
    const {parent, requests, cwd} = await fixture(t);
    await parent.prompt('/skill:project-skill extra skill arguments', direct);
    const skillRequest = JSON.stringify(requests.at(-1)?.messages);
    assert.ok(skillRequest.includes('PROJECT SKILL BODY marker.'));
    assert.ok(skillRequest.includes('<skill name=\\"project-skill\\"'));
    assert.ok(skillRequest.includes('extra skill arguments'));
    await parent.prompt('/project-template "first argument" second', direct);
    assert.ok(
      JSON.stringify(requests.at(-1)?.messages).includes(
        'PROJECT TEMPLATE first argument / first argument second',
      ),
    );
    const before = requests.length;
    await parent.prompt('/model desktop-fixture/second-model', direct);
    await parent.prompt('/thinking high', direct);
    await parent.prompt('/name Renamed fixture', direct);
    await parent.prompt('/session', direct);
    assert.equal(requests.length, before);
    assert.deepEqual((await parent.features()).model, {
      provider: 'desktop-fixture',
      id: 'second-model',
    });
    assert.equal((await parent.features()).thinkingLevel, 'high');
    assert.equal(parent.state.snapshot().session.name, 'Renamed fixture');
    const report = parent.state
      .snapshot()
      .conversation.find(message =>
        message.text.includes('Session: Renamed fixture'),
      );
    assert.ok(report?.text.includes(cwd));
    await parent.configure({
      provider: 'configured-fixture',
      modelId: 'configured-model',
    });
    assert.deepEqual((await parent.features()).model, {
      provider: 'configured-fixture',
      id: 'configured-model',
    });
    assert.deepEqual((await parent.features()).thinkingLevels, ['off']);
    await assert.rejects(
      parent.configure({thinkingLevel: 'high'}),
      /Thinking level/,
    );
    await parent.configure({
      provider: 'desktop-fixture',
      modelId: 'second-model',
    });
    await assert.rejects(
      parent.configure({thinkingLevel: 'invalid'}),
      /Thinking level/,
    );
    await assert.rejects(
      parent.configure({provider: 'missing', modelId: 'missing'}),
      /Model is unavailable/,
    );
    await parent.prompt('/compact Preserve the fixture decision.', direct);
    assert.ok(requests.length > before);
    assert.ok(
      requests
        .slice(before)
        .some(request =>
          JSON.stringify(request.messages).includes(
            'Preserve the fixture decision.',
          ),
        ),
    );
    const afterCompaction = requests.length;
    await parent.prompt('/reload', direct);
    assert.equal(requests.length, afterCompaction);
  },
);

void test(
  'extension commands submit before execution, retain dialogs and editors, reject busy actions and report UI errors',
  {timeout: 15000},
  async t => {
    const {parent, cwd, requests} = await fixture(t);
    let queued = true;
    let submissions = 0;
    const operation = parent.prompt('/fixture-command command arguments', {
      isQueued: () => queued,
      submitted: () => {
        assert.ok(queued);
        queued = false;
        submissions++;
      },
    });
    while (!parent.ui.snapshot().dialogs.length) await delay(5);
    assert.equal(queued, false);
    assert.equal(submissions, 1);
    assert.equal(
      await readFile(join(cwd, 'command-started.txt'), 'utf8'),
      'command arguments',
    );
    await assert.rejects(parent.reload(), /already working/);
    await assert.rejects(
      parent.configure({thinkingLevel: 'high'}),
      /already working/,
    );
    await assert.rejects(parent.compact(), /already working/);
    const dialog = parent.ui.snapshot().dialogs[0];
    assert.equal(dialog.kind, 'confirm');
    assert.equal(dialog.message, 'command arguments');
    parent.ui.respond(dialog.id, true);
    await operation;
    assert.equal(submissions, 1);
    assert.equal(requests.length, 0);
    assert.ok(
      parent.ui
        .snapshot()
        .notifications.some(
          item => item.message === 'Fixture command finished: true',
        ),
    );
    await parent.prompt('/fixture-command must not execute', {
      isQueued: () => false,
      submitted: () => assert.fail('cancelled queue item submitted'),
    });
    assert.equal(
      await readFile(join(cwd, 'command-started.txt'), 'utf8'),
      'command arguments',
    );
    await parent.prompt('/terminal-command', direct);
    assert.equal(typeof parent.ui.context.getEditorComponent(), 'function');
    const editor = parent.ui.snapshot().extensionEditor;
    assert.ok(editor);
    parent.ui.respond(editor.id, 'fixture editor draft');
    await waitFor(
      () =>
        !!parent.ui
          .snapshot()
          .dialogs[0]?.terminal?.output.includes('fixture editor draft'),
      'CustomEditor renders the supplied draft',
    );
    const editorDialog = parent.ui.snapshot().dialogs[0];
    assert.equal(editorDialog.kind, 'terminal');
    parent.ui.respond(editorDialog.id, '\r');
    await waitFor(
      () =>
        parent.ui.snapshot().editor?.text === 'fixture editor draft' &&
        parent.ui.snapshot().dialogs.length === 0,
      'CustomEditor submits its draft and closes',
    );
    parent.ui.respond(editor.id, '/project-temp');
    await waitFor(
      () =>
        !!parent.ui
          .snapshot()
          .dialogs[0]?.terminal?.output.includes('/project-temp'),
      'Completion editor renders its draft',
    );
    const completionDialog = parent.ui.snapshot().dialogs[0];
    parent.ui.respond(completionDialog.id, '\t');
    await waitFor(
      () =>
        !!parent.ui
          .snapshot()
          .dialogs[0]?.terminal?.output.includes('project-template'),
      'Native prompt templates appear in editor completions',
    );
    parent.ui.respond(completionDialog.id);
    await waitFor(
      () => parent.ui.snapshot().dialogs.length === 0,
      'Completion editor cancels',
    );
    await parent.prompt('/ui-error-command', direct);
    assert.ok(
      (await parent.features()).diagnostics.some(item =>
        item.message.includes('Fixture component failed.'),
      ),
    );
    assert.ok(
      parent.ui.snapshot().notifications.some(item => item.type === 'error'),
    );
    const pending = parent.prompt('/fixture-command abort me', direct);
    while (!parent.ui.snapshot().dialogs.length) await delay(5);
    await parent.abort();
    await pending;
    assert.deepEqual(parent.ui.snapshot().dialogs, []);
    const afterAbort = parent.prompt('/fixture-command after abort', direct);
    while (!parent.ui.snapshot().dialogs.length) await delay(5);
    parent.ui.respond(parent.ui.snapshot().dialogs[0].id, false);
    await afterAbort;
    const composer = parent.ui.snapshot().editor;
    assert.ok(composer);
    await parent.reload();
    assert.deepEqual(parent.ui.snapshot().editor, composer);
    assert.equal(parent.ui.context.getEditorComponent(), undefined);
    assert.equal(parent.ui.snapshot().extensionEditor, undefined);
    assert.deepEqual(parent.ui.snapshot().notifications, []);
    parent.ui.respond(editor.id, 'stale editor button');
    assert.deepEqual(parent.ui.snapshot().dialogs, []);
    await parent.prompt('/terminal-command', direct);
    const reloadedEditor = parent.ui.snapshot().extensionEditor;
    assert.ok(reloadedEditor);
    assert.notEqual(reloadedEditor.id, editor.id);
    parent.ui.respond(reloadedEditor.id, 'editor after reload');
    await waitFor(
      () =>
        !!parent.ui
          .snapshot()
          .dialogs[0]?.terminal?.output.includes('editor after reload'),
      'CustomEditor works after extension reload',
    );
    parent.ui.respond(parent.ui.snapshot().dialogs[0].id);
    await waitFor(
      () => parent.ui.snapshot().dialogs.length === 0,
      'Reloaded editor cancels',
    );
  },
);

void test(
  'extension initiated model turns finish before the desktop queue advances',
  {timeout: 15000},
  async t => {
    const {parent, requests} = await fixture(t);
    let submissions = 0;
    await parent.prompt('/model-command', {
      isQueued: () => true,
      submitted: () => {
        submissions++;
      },
    });
    assert.equal(submissions, 1);
    assert.equal(requests.length, 1);
    const transcript = parent.state.snapshot().conversation;
    assert.ok(
      transcript.some(
        message =>
          message.role === 'user' && message.text === 'EXTENSION MODEL REQUEST',
      ),
    );
    assert.ok(
      transcript.some(
        message =>
          message.role === 'assistant' &&
          message.text === 'Fixture answer.' &&
          !message.streaming,
      ),
    );
    assert.equal(parent.state.snapshot().session.status, 'idle');
  },
);
