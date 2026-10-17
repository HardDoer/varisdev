import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test, type TestContext} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {
  ModelRegistry,
  ModelRuntime,
  ProjectTrustStore,
} from '@earendil-works/pi-coding-agent';
import {
  createDashboardParent,
  type DesktopDashboardParent,
} from '../src/dashboard/parent.ts';
import {DesktopToolSettings} from '../src/desktop/tool-settings.ts';

interface Request {
  model: string;
  reasoning_effort?: string;
  messages: Array<{role: string; content: unknown}>;
}

async function waitFor(check: () => boolean, description: string) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await delay(5);
  assert.ok(check(), description);
}

async function commandDialog(parent: DesktopDashboardParent, text: string) {
  const operation = parent.prompt(text);
  // A failed command must not become an unhandled rejection while waiting for UI.
  void operation.catch(() => {});
  await waitFor(
    () => parent.ui.snapshot().dialogs.length > 0,
    `${text} opens a native dialog`,
  );
  if (parent.ui.snapshot().dialogs[0].kind === 'terminal')
    await waitFor(
      () => Boolean(parent.ui.snapshot().dialogs[0]?.terminal?.revision),
      `${text} renders its SDK component`,
    );
  return {operation, dialog: parent.ui.snapshot().dialogs[0]};
}

async function fixture(
  t: TestContext,
  configuredVarisdev = false,
  enabledModels?: string[],
) {
  const root = await mkdtemp(join(tmpdir(), 'desktop-features-'));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'config');
  const previous = process.env.PI_CODING_AGENT_DIR;
  const title = process.title;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const parents: DesktopDashboardParent[] = [];
  const responseGates: Array<ReturnType<typeof Promise.withResolvers<void>>> =
    [];
  t.after(async () => {
    for (const parent of parents) parent.ui.cancelDialogs();
    for (const gate of responseGates) gate.resolve();
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
  const contextPaths = {
    user: join(agentDir, 'AGENTS.md'),
    ancestor: join(root, 'AGENTS.md'),
    project: join(cwd, 'AGENTS.md'),
    system: join(agentDir, 'SYSTEM.md'),
    append: join(agentDir, 'APPEND_SYSTEM.md'),
    unrelated: join(cwd, 'notes.md'),
  };
  await Promise.all([
    writeFile(contextPaths.user, 'USER AUTOMATIC INSTRUCTIONS marker.'),
    writeFile(contextPaths.ancestor, 'ANCESTOR AUTOMATIC INSTRUCTIONS marker.'),
    writeFile(contextPaths.project, 'PROJECT AUTOMATIC INSTRUCTIONS marker.'),
    writeFile(contextPaths.system, 'CUSTOM SYSTEM PROMPT marker.'),
    writeFile(contextPaths.append, 'APPENDED SYSTEM PROMPT marker.'),
    writeFile(contextPaths.unrelated, 'UNRELATED MARKDOWN marker.'),
  ]);
  const settingsPath = join(agentDir, 'settings.json');
  const settings = {
    ...(enabledModels ? {enabledModels} : {}),
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
  const cancelledRequests: Request[] = [];
  let responseGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const holdNextResponse = () => {
    responseGate = Promise.withResolvers<void>();
    const gate = responseGate;
    responseGates.push(gate);
    return gate;
  };
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
      const gate = responseGate;
      responseGate = undefined;
      if (gate && options?.signal) {
        const {signal} = options;
        const cancelled = Promise.withResolvers<void>();
        const abort = () => {
          cancelledRequests.push(request);
          cancelled.reject(signal.reason);
        };
        signal.addEventListener('abort', abort, {once: true});
        if (signal.aborted) abort();
        try {
          await Promise.race([gate.promise, cancelled.promise]);
        } finally {
          signal.removeEventListener('abort', abort);
        }
      } else await gate?.promise;
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
  new ProjectTrustStore(agentDir).set(cwd, true);
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
    cancelledRequests,
    holdNextResponse,
    settingsPath,
    settings,
    skillPath,
    promptPath,
    extensionPath,
    contextPaths,
  };
}

void test(
  'desktop context catalog follows loaded instruction sources and refreshes cached content on reload',
  {timeout: 15000},
  async t => {
    const {parent, contextPaths, skillPath, promptPath, requests} =
      await fixture(t);
    const files = (await parent.features()).contextFiles!;
    assert.ok(Array.isArray(files));
    for (const path of [
      contextPaths.user,
      contextPaths.ancestor,
      contextPaths.project,
    ]) {
      const file = files.find(file => file.path === path);
      assert.equal(file?.kind, 'instructions');
      assert.equal(file?.status, 'included');
      assert.equal(file?.content, await readFile(path, 'utf8'));
    }
    for (const [path, kind] of [
      [contextPaths.system, 'system'],
      [contextPaths.append, 'append'],
    ]) {
      const file = files.find(file => file.path === path);
      assert.equal(file?.kind, kind);
      assert.equal(file?.status, 'included');
      assert.equal(file?.content, await readFile(path, 'utf8'));
    }
    assert.ok(!files.some(file => file.path === contextPaths.unrelated));
    const skill = files.find(file => file.path === skillPath);
    assert.equal(skill?.kind, 'skill');
    assert.equal(skill?.status, 'available');
    assert.equal(skill?.content, undefined);
    assert.match(
      skill!.description,
      /Project fixture skill.*advertised.*only when read or invoked/,
    );
    const template = files.find(file => file.path === promptPath);
    assert.equal(template?.kind, 'template');
    assert.equal(template?.status, 'available');
    assert.equal(template?.content, undefined);
    assert.match(template!.description, /when \/project-template is invoked/);
    await parent.prompt('Verify the automatic context');
    const request = JSON.stringify(requests.at(-1)?.messages);
    for (const marker of [
      'USER AUTOMATIC',
      'ANCESTOR AUTOMATIC',
      'PROJECT AUTOMATIC',
      'CUSTOM SYSTEM',
      'APPENDED SYSTEM',
    ])
      assert.ok(request.includes(marker), marker);
    assert.ok(!request.includes('PROJECT SKILL BODY'));
    assert.ok(!request.includes('USER TEMPLATE'));
    assert.ok(!request.includes('UNRELATED MARKDOWN'));
    await writeFile(
      contextPaths.project,
      'UPDATED PROJECT INSTRUCTIONS marker.',
    );
    await writeFile(contextPaths.append, 'UPDATED APPEND marker.');
    assert.equal(
      (await parent.features()).contextFiles!.find(
        file => file.path === contextPaths.project,
      )?.content,
      'PROJECT AUTOMATIC INSTRUCTIONS marker.',
    );
    await parent.reload();
    const reloaded = (await parent.features()).contextFiles!;
    assert.equal(
      reloaded.find(file => file.path === contextPaths.project)?.content,
      'UPDATED PROJECT INSTRUCTIONS marker.',
    );
    assert.equal(
      reloaded.find(file => file.path === contextPaths.append)?.content,
      'UPDATED APPEND marker.',
    );
    await parent.prompt('/skill:project-skill');
    const invoked = (await parent.features()).contextFiles!.filter(
      file => file.path === skillPath,
    );
    assert.equal(invoked.length, 1);
    assert.equal(invoked[0].status, 'included');
    assert.ok(invoked[0].content?.includes('PROJECT SKILL BODY marker.'));
    assert.match(invoked[0].description, /Invoked skill body retained/);
  },
);

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
    const {BUILTIN_SLASH_COMMANDS} = (await import(
      new URL(
        './core/slash-commands.js',
        import.meta.resolve('@earendil-works/pi-coding-agent'),
      ).href
    )) as {BUILTIN_SLASH_COMMANDS: Array<{name: string}>};
    for (const {name} of BUILTIN_SLASH_COMMANDS) {
      const matches = catalog.commands.filter(command => command.name === name);
      assert.equal(
        matches.length,
        1,
        `SDK builtin /${name} is discoverable once`,
      );
      assert.equal(matches[0].source, 'builtin', `/${name} stays native`);
    }
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
    for (const name of ['varisdev', 'factory', 'images'])
      assert.ok(
        !catalog.commands.some(command => command.name === name),
        `App self-extension command ${name} should be excluded`,
      );
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
    const reloadedSkill = reloaded.contextFiles!.find(
      file => file.path === skillPath,
    );
    assert.equal(reloadedSkill?.status, 'available');
    assert.match(reloadedSkill!.description, /advertised/);
    assert.equal(reloadedSkill?.content, undefined);
    assert.equal(
      reloaded.commands.filter(command => command.name === 'commit').length,
      1,
    );
    assert.deepEqual(reloaded.diagnostics, []);
    await assert.rejects(
      parent.prompt('/skill:project-skill do work'),
      /disabled in settings/,
    );
    assert.equal(requests.length, 0);
    await parent.prompt('/project-template after reload');
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
    assert.equal(parent.state.snapshot().session.thinkingLevel, 'low');
    await parent.prompt('/skill:project-skill extra skill arguments');
    const skillRequest = JSON.stringify(requests.at(-1)?.messages);
    assert.ok(skillRequest.includes('PROJECT SKILL BODY marker.'));
    assert.ok(skillRequest.includes('<skill name=\\"project-skill\\"'));
    assert.ok(skillRequest.includes('extra skill arguments'));
    await parent.prompt('/project-template "first argument" second');
    assert.ok(
      JSON.stringify(requests.at(-1)?.messages).includes(
        'PROJECT TEMPLATE first argument / first argument second',
      ),
    );
    const before = requests.length;
    await parent.prompt('/model desktop-fixture/second-model');
    await parent.prompt('/thinking high');
    await parent.prompt('/name Renamed fixture');
    const transcriptBeforeReport = parent.state.snapshot().conversation;
    const report = await commandDialog(parent, '/session');
    assert.equal(report.dialog.kind, 'info');
    assert.equal(report.dialog.title, 'Session information');
    assert.match(report.dialog.message!, /Name: Renamed fixture/);
    assert.ok(report.dialog.message!.includes(cwd));
    assert.match(
      report.dialog.message!,
      /Messages:.*\nTool calls:.*\nTokens:.*\nCost:/,
    );
    parent.ui.respond(report.dialog.id);
    await report.operation;
    assert.deepEqual(
      parent.state.snapshot().conversation,
      transcriptBeforeReport,
    );
    assert.equal(requests.length, before);
    assert.deepEqual((await parent.features()).model, {
      provider: 'desktop-fixture',
      id: 'second-model',
    });
    assert.equal((await parent.features()).thinkingLevel, 'high');
    assert.equal(parent.state.snapshot().session.thinkingLevel, 'high');
    assert.equal(parent.state.snapshot().session.name, 'Renamed fixture');
    await parent.configure({
      provider: 'configured-fixture',
      modelId: 'configured-model',
    });
    assert.deepEqual((await parent.features()).model, {
      provider: 'configured-fixture',
      id: 'configured-model',
    });
    assert.deepEqual((await parent.features()).thinkingLevels, ['off']);
    assert.equal(parent.state.snapshot().session.thinkingLevel, 'off');
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
    // A local session report no longer adds artificial history to compact.
    await parent.prompt('Keep the fixture decision for the next task.');
    await parent.prompt('/compact Preserve the fixture decision.');
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
    await parent.prompt('/reload');
    assert.equal(requests.length, afterCompaction);
  },
);

void test(
  'SDK thinking and model selectors apply explicit session or default actions and cancel without model requests',
  {timeout: 15000},
  async t => {
    const {parent, requests, settingsPath} = await fixture(t);
    const transcript = parent.state.snapshot().conversation;
    const actions = [
      {id: 'default', label: 'Make as default'},
      {id: 'session', label: 'Apply to session'},
    ];
    const search = async (query: string) => {
      const dialog = parent.ui.snapshot().dialogs[0];
      const revision = dialog.terminal!.revision;
      parent.ui.respond(dialog.id, query);
      await waitFor(
        () => parent.ui.snapshot().dialogs[0]?.terminal?.revision !== revision,
        'Typing updates the SDK selector',
      );
    };
    const thinking = await commandDialog(parent, '/thinking');
    assert.equal(thinking.dialog.kind, 'terminal');
    assert.equal(thinking.dialog.title, 'Model & thinking');
    assert.deepEqual(thinking.dialog.actions, actions);
    assert.equal(parent.state.snapshot().session.thinkingLevel, 'low');
    await search('high');
    parent.ui.respond(thinking.dialog.id, {action: 'session'});
    await thinking.operation;
    assert.equal(parent.state.snapshot().session.thinkingLevel, 'high');
    assert.equal(
      JSON.parse(await readFile(settingsPath, 'utf8')).defaultThinkingLevel,
      undefined,
    );

    const cancelledThinking = await commandDialog(parent, '/thinking');
    parent.ui.respond(cancelledThinking.dialog.id);
    await cancelledThinking.operation;
    assert.equal((await parent.features()).thinkingLevel, 'high');

    const model = await commandDialog(parent, '/model');
    assert.equal(model.dialog.kind, 'terminal');
    assert.equal(model.dialog.title, 'Model & thinking');
    assert.deepEqual(model.dialog.actions, actions);
    assert.equal((await parent.features()).model?.id, 'first-model');
    await search('second-model');
    parent.ui.respond(model.dialog.id, {action: 'session'});
    await model.operation;
    assert.deepEqual((await parent.features()).model, {
      provider: 'desktop-fixture',
      id: 'second-model',
    });
    assert.equal(
      JSON.parse(await readFile(settingsPath, 'utf8')).defaultModel,
      undefined,
    );

    const savedModel = await commandDialog(parent, '/model');
    parent.ui.respond(savedModel.dialog.id, {action: 'default'});
    await savedModel.operation;
    const saved = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.equal(saved.defaultProvider, 'desktop-fixture');
    assert.equal(saved.defaultModel, 'second-model');
    assert.equal((await parent.features()).model?.id, 'second-model');

    const cancelledModel = await commandDialog(parent, '/model');
    parent.ui.respond(cancelledModel.dialog.id);
    await cancelledModel.operation;
    assert.equal((await parent.features()).model?.id, 'second-model');

    for (const command of ['/thinking', '/model']) {
      const stopped = await commandDialog(parent, command);
      await parent.abort();
      await stopped.operation;
      parent.ui.respond(stopped.dialog.id, {action: 'default'});
      await delay(20);
      assert.deepEqual(parent.ui.snapshot().dialogs, []);
    }
    assert.equal((await parent.features()).thinkingLevel, 'high');
    assert.equal((await parent.features()).model?.id, 'second-model');
    assert.deepEqual(parent.state.snapshot().conversation, transcript);
    assert.equal(requests.length, 0);
    await assert.rejects(
      parent.prompt('/thinking unsupported'),
      /Thinking level/,
    );
    for (const command of ['/model missing', '/model missing/model']) {
      const empty = await commandDialog(parent, command);
      assert.ok(empty.dialog.terminal!.output.includes('No matching models'));
      parent.ui.respond(empty.dialog.id, {action: 'default'});
      assert.equal(parent.ui.snapshot().dialogs.length, 1);
      parent.ui.respond(empty.dialog.id);
      await empty.operation;
      assert.equal((await parent.features()).model?.id, 'second-model');
    }
    const stoppedBeforeOpen = parent.prompt('/model');
    await parent.abort();
    await stoppedBeforeOpen;
    await delay(20);
    assert.deepEqual(parent.ui.snapshot().dialogs, []);

    await parent.configure({
      provider: 'configured-fixture',
      modelId: 'configured-model',
    });
    const unsupportedThinking = await commandDialog(parent, '/thinking');
    assert.equal(unsupportedThinking.dialog.kind, 'terminal');
    assert.deepEqual((await parent.features()).thinkingLevels, ['off']);
    parent.ui.respond(unsupportedThinking.dialog.id, {action: 'session'});
    await unsupportedThinking.operation;
    assert.equal((await parent.features()).thinkingLevel, 'off');
    assert.equal(requests.length, 0);
  },
);

void test(
  'native settings roundtrip through Pi settings and Stop does not reopen nested menus',
  {timeout: 15000},
  async t => {
    const {parent, requests, settingsPath} = await fixture(t);
    const settings = await commandDialog(parent, '/settings');
    assert.equal(settings.dialog.kind, 'select');
    assert.equal(settings.dialog.title, 'Session settings');
    assert.ok(settings.dialog.options!.includes('Auto retry: off'));
    parent.ui.respond(settings.dialog.id, 'Auto retry: off');
    await waitFor(
      () => parent.ui.snapshot().dialogs[0]?.title === 'Auto retry',
      'Settings opens the retry submenu',
    );
    const retry = parent.ui.snapshot().dialogs[0];
    assert.equal(retry.selected, 'off');
    assert.deepEqual(retry.options, ['on', 'off']);
    parent.ui.respond(retry.id, 'on');
    await waitFor(
      () =>
        !!parent.ui.snapshot().dialogs[0]?.options?.includes('Auto retry: on'),
      'Changed setting is reflected in the menu',
    );
    parent.ui.respond(parent.ui.snapshot().dialogs[0].id);
    await settings.operation;
    assert.equal(
      JSON.parse(await readFile(settingsPath, 'utf8')).retry.enabled,
      true,
    );

    await parent.reload();
    const reloaded = await commandDialog(parent, '/settings');
    assert.ok(reloaded.dialog.options!.includes('Auto retry: on'));
    parent.ui.respond(reloaded.dialog.id, 'Auto retry: on');
    await waitFor(
      () => parent.ui.snapshot().dialogs[0]?.title === 'Auto retry',
      'Reloaded settings retain the selected value',
    );
    const cancelledRetry = parent.ui.snapshot().dialogs[0];
    assert.equal(cancelledRetry.selected, 'on');
    parent.ui.respond(cancelledRetry.id);
    await waitFor(
      () => parent.ui.snapshot().dialogs[0]?.title === 'Session settings',
      'Cancelling a submenu returns to settings',
    );
    const nested = parent.ui.snapshot().dialogs[0];
    parent.ui.respond(nested.id, 'Auto retry: on');
    await waitFor(
      () => parent.ui.snapshot().dialogs[0]?.title === 'Auto retry',
      'Retry submenu opens before Stop',
    );
    const stoppedRetry = parent.ui.snapshot().dialogs[0];
    await parent.abort();
    await reloaded.operation;
    parent.ui.respond(stoppedRetry.id, 'off');
    await delay(20);
    assert.deepEqual(parent.ui.snapshot().dialogs, []);
    assert.equal(
      JSON.parse(await readFile(settingsPath, 'utf8')).retry.enabled,
      true,
    );
    await assert.rejects(
      parent.prompt('/settings unsupported'),
      /Usage|arguments/i,
    );
    assert.deepEqual(parent.ui.snapshot().dialogs, []);
    assert.equal(requests.length, 0);
  },
);

void test(
  'native name input and session information can be dismissed or stopped without transcript messages',
  {timeout: 15000},
  async t => {
    const {parent, requests, cwd} = await fixture(t);
    const transcript = parent.state.snapshot().conversation;
    const rename = await commandDialog(parent, '/name');
    assert.equal(rename.dialog.kind, 'input');
    assert.equal(rename.dialog.title, 'Session name');
    parent.ui.respond(rename.dialog.id, '  Named through input  ');
    await rename.operation;
    assert.equal(parent.state.snapshot().session.name, 'Named through input');
    const cancel = await commandDialog(parent, '/name');
    parent.ui.respond(cancel.dialog.id);
    await cancel.operation;
    assert.equal(parent.state.snapshot().session.name, 'Named through input');
    const stopped = await commandDialog(parent, '/name');
    await parent.abort();
    await stopped.operation;
    parent.ui.respond(stopped.dialog.id, 'Stale name');
    assert.equal(parent.state.snapshot().session.name, 'Named through input');

    const info = await commandDialog(parent, '/session');
    assert.equal(info.dialog.kind, 'info');
    assert.equal(info.dialog.title, 'Session information');
    assert.match(info.dialog.message!, /Name: Named through input/);
    assert.ok(info.dialog.message!.includes(cwd));
    parent.ui.respond(info.dialog.id);
    await info.operation;
    const stoppedInfo = await commandDialog(parent, '/session');
    await parent.abort();
    await stoppedInfo.operation;
    await delay(20);
    assert.deepEqual(parent.ui.snapshot().dialogs, []);
    assert.deepEqual(parent.state.snapshot().conversation, transcript);
    assert.equal(requests.length, 0);
    await assert.rejects(
      parent.prompt('/session unsupported'),
      /Usage|arguments/i,
    );
    assert.deepEqual(parent.ui.snapshot().dialogs, []);
  },
);

void test(
  'live configuration keeps the active provider request and applies model and effort to the next turn',
  {timeout: 15000},
  async t => {
    const {parent, requests, holdNextResponse} = await fixture(t);
    const first = holdNextResponse();
    let finished = false;
    const running = parent.prompt('Start a task').finally(() => {
      finished = true;
    });
    await waitFor(() => requests.length === 1, 'First provider request starts');
    assert.equal(parent.state.snapshot().session.status, 'running');
    assert.equal(requests[0].model, 'first-model');
    assert.equal(requests[0].reasoning_effort, 'low');
    await parent.configure({thinkingLevel: 'high'});
    assert.equal((await parent.features()).thinkingLevel, 'high');
    assert.equal(parent.state.snapshot().session.thinkingLevel, 'high');
    await assert.rejects(
      parent.configure({thinkingLevel: 'invalid'}),
      /Thinking level/,
    );
    await assert.rejects(
      parent.configure({provider: 'missing', modelId: 'missing'}),
      /Model is unavailable/,
    );
    await assert.rejects(
      parent.configure({
        provider: 'configured-fixture',
        modelId: 'configured-model',
        thinkingLevel: 'high',
      }),
      /Thinking level/,
    );
    await assert.rejects(parent.reload(), /already working/);
    assert.equal(finished, false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].reasoning_effort, 'low');
    const second = holdNextResponse();
    await parent.prompt('Continue with the new effort');
    first.resolve();
    await waitFor(() => requests.length === 2, 'Steering starts the next turn');
    assert.equal(requests[1].model, 'first-model');
    assert.equal(requests[1].reasoning_effort, 'high');
    await parent.configure({
      provider: 'desktop-fixture',
      modelId: 'second-model',
      thinkingLevel: 'medium',
    });
    assert.deepEqual((await parent.features()).model, {
      provider: 'desktop-fixture',
      id: 'second-model',
    });
    assert.equal(parent.state.snapshot().session.thinkingLevel, 'medium');
    assert.equal(finished, false);
    assert.equal(requests[1].model, 'first-model');
    await parent.prompt('/thinking low');
    await parent.prompt('/model desktop-fixture/second-model');
    await parent.prompt('Continue with the new model');
    second.resolve();
    await running;
    assert.equal(requests.length, 3);
    assert.equal(requests[2].model, 'second-model');
    assert.equal(requests[2].reasoning_effort, 'low');
    assert.equal(parent.state.snapshot().session.status, 'idle');
  },
);

void test(
  'live compact command reaches Pi and interrupts the active provider request',
  {timeout: 15000},
  async t => {
    const {parent, requests, cancelledRequests, holdNextResponse} =
      await fixture(t);
    holdNextResponse();
    const running = parent.prompt('Continue working until interrupted.');
    void running.catch(() => {});
    await waitFor(
      () => requests.length === 1,
      'The active provider request starts',
    );
    assert.equal(parent.state.snapshot().session.status, 'running');
    await assert.rejects(
      parent.prompt('/compact Preserve the live fixture decision.'),
      /Nothing to compact/,
    );
    await running;
    assert.deepEqual(cancelledRequests, [requests[0]]);
    assert.equal(requests.length, 1);
    assert.equal(parent.state.snapshot().session.status, 'idle');
  },
);

void test(
  'extension commands retain dialogs and editors, reject reload while busy and report UI errors',
  {timeout: 15000},
  async t => {
    const {parent, cwd, requests} = await fixture(t);
    const operation = parent.prompt('/fixture-command command arguments');
    await waitFor(
      () => parent.ui.snapshot().dialogs.length > 0,
      'The project extension opens its confirmation',
    );
    assert.equal(
      await readFile(join(cwd, 'command-started.txt'), 'utf8'),
      'command arguments',
    );
    await assert.rejects(parent.reload(), /already working/);
    await parent.configure({thinkingLevel: 'high'});
    assert.equal((await parent.features()).thinkingLevel, 'high');
    const dialog = parent.ui.snapshot().dialogs[0];
    assert.equal(dialog.kind, 'confirm');
    assert.equal(dialog.message, 'command arguments');
    parent.ui.respond(dialog.id, true);
    await operation;
    assert.equal(requests.length, 0);
    assert.ok(
      parent.ui
        .snapshot()
        .notifications.some(
          item => item.message === 'Fixture command finished: true',
        ),
    );
    await parent.prompt('/terminal-command');
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
    await parent.prompt('/ui-error-command');
    assert.ok(
      (await parent.features()).diagnostics.some(item =>
        item.message.includes('Fixture component failed.'),
      ),
    );
    assert.ok(
      parent.ui.snapshot().notifications.some(item => item.type === 'error'),
    );
    const pending = parent.prompt('/fixture-command abort me');
    await waitFor(
      () => parent.ui.snapshot().dialogs.length > 0,
      'The extension opens a dialog before Stop',
    );
    await parent.abort();
    await pending;
    assert.deepEqual(parent.ui.snapshot().dialogs, []);
    const afterAbort = parent.prompt('/fixture-command after abort');
    await waitFor(
      () => parent.ui.snapshot().dialogs.length > 0,
      'The extension opens a new dialog after Stop',
    );
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
    await parent.prompt('/terminal-command');
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
  'extension initiated model turns finish before command completion',
  {timeout: 15000},
  async t => {
    const {parent, requests} = await fixture(t);
    await parent.prompt('/model-command');
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

void test('tool settings follow real Pi scope changes while keeping saved global tool preferences', async t => {
  const enabledModels = ['desktop-fixture/second-model:high'];
  const {parent, requests, settingsPath} = await fixture(
    t,
    false,
    enabledModels,
  );
  const service = new DesktopToolSettings({
    sessionFeatures: async id => {
      assert.equal(id, 'session');
      return parent.features();
    },
    createRuntime: async () => {
      throw new Error('A selected session must use its live scope.');
    },
  });
  const features = await parent.features();
  assert.ok(features.models.some(model => model.id === 'first-model'));
  assert.deepEqual(features.scopedModels, [
    {
      model: {
        provider: 'desktop-fixture',
        id: 'second-model',
        name: 'second-model',
      },
      thinkingLevel: 'high',
    },
  ]);
  const initial = await service.getToolSettings('session');
  assert.deepEqual(
    initial.models,
    features.scopedModels!.map(scoped => scoped.model),
  );
  await service.saveToolSettings(
    'agents',
    {
      allowedModels: ['desktop-fixture/second-model'],
    },
    'session',
  );

  const applyScope = async (action: string) => {
    const {operation, dialog} = await commandDialog(parent, '/scoped-models');
    assert.equal(dialog.kind, 'select');
    parent.ui.respond(dialog.id, action);
    await waitFor(
      () =>
        Boolean(
          parent.ui.snapshot().dialogs[0]?.id !== dialog.id &&
          parent.ui.snapshot().dialogs[0]?.title === 'Scoped models',
        ),
      'The scope editor returns to its menu',
    );
    parent.ui.respond(
      parent.ui.snapshot().dialogs[0].id,
      'Apply to this session',
    );
    await operation;
  };
  await applyScope('Enable only current model');
  assert.deepEqual((await parent.features()).scopedModels, [
    {
      model: {
        provider: 'desktop-fixture',
        id: 'first-model',
        name: 'first-model',
      },
    },
  ]);
  const changed = await service.getToolSettings('session');
  assert.deepEqual(
    changed.models.map(model => model.id),
    ['first-model'],
  );
  assert.deepEqual(changed.settings.agents.allowedModels, [
    'desktop-fixture/second-model',
  ]);
  await assert.rejects(
    service.saveToolSettings(
      'commit',
      {
        model: 'desktop-fixture/second-model',
        thinkingLevel: null,
      },
      'session',
    ),
    /Unknown model/,
  );
  assert.deepEqual(
    JSON.parse(await readFile(settingsPath, 'utf8')).enabledModels,
    enabledModels,
  );

  await applyScope('Enable all models');
  assert.deepEqual((await parent.features()).scopedModels, []);
  const restored = await service.getToolSettings('session');
  assert.ok(restored.models.some(model => model.id === 'first-model'));
  assert.ok(restored.models.some(model => model.id === 'second-model'));
  assert.deepEqual(restored.settings.agents.allowedModels, [
    'desktop-fixture/second-model',
  ]);
  assert.deepEqual(
    JSON.parse(await readFile(settingsPath, 'utf8')).enabledModels,
    enabledModels,
  );
  assert.equal(requests.length, 0);
});
