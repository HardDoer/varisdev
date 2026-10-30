import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {stripVTControlCharacters} from 'node:util';
import {
  CONFIG_DIR_NAME,
  ProjectTrustStore,
} from '@earendil-works/pi-coding-agent';
import {DashboardHub, type DashboardParent} from '../src/dashboard/hub.ts';
import {createDashboardParent} from '../src/dashboard/parent.ts';

async function waitFor(check: () => boolean, description: string) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await delay(5);
  assert.ok(check(), description);
}

async function fixture(t: TestContext, settings: object = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'varisdev-trust-startup-')),
  );
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  const previous = process.env.PI_CODING_AGENT_DIR;
  const title = process.title;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const parents: DashboardParent[] = [];
  const hub = new DashboardHub(
    undefined,
    async (request, interaction) => {
      const parent = await createDashboardParent(
        request,
        undefined,
        undefined,
        interaction,
      );
      parents.push(parent);
      return parent;
    },
    cwd,
  );
  t.after(async () => {
    await hub.close();
    await Promise.all(parents.map(parent => parent.close()));
    process.title = title;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, {recursive: true, force: true});
  });
  await mkdir(agentDir);
  await mkdir(join(cwd, '.git'), {recursive: true});
  const config = join(cwd, CONFIG_DIR_NAME);
  await mkdir(join(config, 'extensions'), {recursive: true});
  const loadedPath = join(root, 'project-loaded');
  await writeFile(
    join(config, 'extensions', 'fixture.js'),
    `
    import {writeFileSync} from 'node:fs';
    export default () => { writeFileSync(${JSON.stringify(loadedPath)}, 'loaded'); };
  `,
  );
  for (const name of ['continue-the-plan', 'review-fix']) {
    const path = join(config, 'skills', name);
    await mkdir(path, {recursive: true});
    await writeFile(
      join(path, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Repository ${name} skill\n---\n${name} repository instructions marker.`,
    );
  }
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'trust-fixture',
      defaultModel: 'global-model',
      retry: {enabled: false},
      compaction: {enabled: false},
      ...settings,
    }),
  );
  await writeFile(
    join(config, 'settings.json'),
    JSON.stringify({defaultModel: 'project-model'}),
  );
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        'trust-fixture': {
          api: 'openai-completions',
          apiKey: 'fixture-key',
          baseUrl: 'https://trust-fixture.invalid/v1',
          models: ['global-model', 'project-model'].map(id => ({
            id,
            name: id,
            contextWindow: 128000,
            maxTokens: 1000,
          })),
        },
      },
    }),
  );
  const requests: string[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (url: RequestInfo | URL, options?: RequestInit) => {
      assert.equal(
        String(url),
        'https://trust-fixture.invalid/v1/chat/completions',
      );
      requests.push(String(options?.body));
      return new Response(
        `data: ${JSON.stringify({
          id: 'fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'project-model',
          choices: [
            {
              index: 0,
              delta: {role: 'assistant', content: 'Skill received.'},
              finish_reason: 'stop',
            },
          ],
          usage: {prompt_tokens: 10, completion_tokens: 3, total_tokens: 13},
        })}\n\ndata: [DONE]\n\n`,
        {headers: {'content-type': 'text/event-stream'}},
      );
    },
  );
  const trust = new ProjectTrustStore(agentDir);
  const startup = async () => {
    await waitFor(
      () => Boolean(hub.snapshot().startup?.ui.dialogs[0]?.terminal?.revision),
      'Startup trust dialog is published before session creation finishes',
    );
    return hub.snapshot().startup!;
  };
  const open = () => {
    const operation = hub.createSession({cwd});
    void operation.catch(() => {});
    return operation;
  };
  return {
    root,
    cwd,
    agentDir,
    hub,
    parents,
    trust,
    loadedPath,
    requests,
    startup,
    open,
  };
}

void test(
  'desktop startup trust loads repository skills and project defaults before publishing the session',
  {timeout: 20000},
  async t => {
    const f = await fixture(t);
    const opening = f.open();
    const startup = await f.startup();
    const dialog = startup.ui.dialogs[0];
    assert.match(
      stripVTControlCharacters(dialog.terminal!.output),
      /Trust project folder/,
    );
    assert.ok(dialog.options?.includes('Trust (this session only)'));
    assert.ok(dialog.options?.includes('Do not trust (this session only)'));
    assert.equal(f.hub.snapshot().sessions.length, 0);
    assert.equal(f.trust.get(f.cwd), null);
    await assert.rejects(readFile(f.loadedPath), {code: 'ENOENT'});
    assert.throws(() => f.hub.restartSnapshots(), /still starting/);
    await f.hub.respondToDialog(startup.id, dialog.id, {columns: 62, rows: 18});
    await f.hub.respondToDialog(startup.id, dialog.id, {input: '\r'});
    const {id} = await opening;
    assert.equal(f.hub.snapshot().startup, undefined);
    assert.equal(f.trust.get(f.cwd), true);
    assert.equal(await readFile(f.loadedPath, 'utf8'), 'loaded');
    const features = await f.hub.sessionFeatures(id);
    assert.equal(features.model?.id, 'project-model');
    for (const name of ['continue-the-plan', 'review-fix']) {
      assert.equal(
        features.commands.filter(command => command.name === `skill:${name}`)
          .length,
        1,
      );
      assert.ok(
        features.contextFiles?.some(
          file => file.name === name && file.kind === 'skill',
        ),
      );
    }
    await f.parents[0].prompt('/skill:review-fix');
    assert.equal(f.requests.length, 1);
    assert.match(f.requests[0], /review-fix repository instructions marker/);
    await f.hub.closeSession(id);
    const reopened = await f.open();
    assert.equal(f.hub.snapshot().startup, undefined);
    assert.ok(
      (await f.hub.sessionFeatures(reopened.id)).commands.some(
        command => command.name === 'skill:continue-the-plan',
      ),
    );
  },
);

void test(
  'cancelling the startup prompt retains an untrusted session and asks again on reopening',
  {timeout: 20000},
  async t => {
    const f = await fixture(t);
    const opening = f.open();
    const startup = await f.startup();
    await f.hub.respondToDialog(startup.id, startup.ui.dialogs[0].id, {
      input: '\x1b',
    });
    const {id} = await opening;
    assert.equal(f.trust.get(f.cwd), null);
    const features = await f.hub.sessionFeatures(id);
    assert.equal(features.model?.id, 'global-model');
    assert.ok(!features.commands.some(command => command.source === 'skill'));
    await assert.rejects(readFile(f.loadedPath), {code: 'ENOENT'});
    await f.hub.closeSession(id);
    const reopened = f.open();
    const again = await f.startup();
    await f.hub.respondToDialog(
      again.id,
      again.ui.dialogs[0].id,
      'Do not trust',
    );
    await reopened;
    assert.equal(f.trust.get(f.cwd), false);
    await f.open();
    assert.equal(f.hub.snapshot().startup, undefined);
    assert.equal(f.requests.length, 0);
  },
);

void test(
  'session-only trust discovers skills without saving a project decision',
  {timeout: 20000},
  async t => {
    const f = await fixture(t);
    const opening = f.open();
    const startup = await f.startup();
    await f.hub.respondToDialog(
      startup.id,
      startup.ui.dialogs[0].id,
      'Trust (this session only)',
    );
    const {id} = await opening;
    assert.equal(f.trust.get(f.cwd), null);
    assert.ok(
      (await f.hub.sessionFeatures(id)).commands.some(
        command => command.name === 'skill:review-fix',
      ),
    );
    await f.parents[0].reload();
    assert.ok(
      (await f.hub.sessionFeatures(id)).commands.some(
        command => command.name === 'skill:review-fix',
      ),
    );
    assert.equal(f.trust.get(f.cwd), null);
  },
);

void test(
  'closing the dashboard cancels pending startup dialogs and does not load or save trust',
  {timeout: 15000},
  async t => {
    const f = await fixture(t);
    const opening = f.open();
    await f.startup();
    const rejected = assert.rejects(opening, /abort|closed/i);
    await f.hub.close();
    await rejected;
    assert.equal(f.hub.snapshot().startup, undefined);
    assert.equal(f.parents.length, 0);
    assert.equal(f.trust.get(f.cwd), null);
    await assert.rejects(readFile(f.loadedPath), {code: 'ENOENT'});
  },
);

void test(
  'desktop startup honors saved denial and global trust preferences without prompting',
  {timeout: 20000},
  async t => {
    for (const [preference, saved, trusted] of [
      ['always', null, true],
      ['never', null, false],
      ['always', false, false],
      ['never', true, true],
    ] as const) {
      await t.test(`${preference}, saved ${saved}`, async t => {
        const f = await fixture(t, {defaultProjectTrust: preference});
        if (saved !== null) f.trust.set(f.cwd, saved);
        const {id} = await f.open();
        assert.equal(f.hub.snapshot().startup, undefined);
        const features = await f.hub.sessionFeatures(id);
        assert.equal(
          features.commands.some(
            command => command.name === 'skill:review-fix',
          ),
          trusted,
        );
        assert.equal(
          features.model?.id,
          trusted ? 'project-model' : 'global-model',
        );
        assert.equal(f.requests.length, 0);
      });
    }
  },
);

void test(
  'startup dialogs remain reachable during concurrent creation and ignore late terminal replies',
  {timeout: 20000},
  async t => {
    const f = await fixture(t);
    const gate = Promise.withResolvers<void>();
    let firstUI:
      import('../src/dashboard/extension-ui.ts').DesktopExtensionUI | undefined;
    const first = f.hub.startParent(
      {cwd: f.cwd, name: 'First'},
      async (request, interaction) => {
        firstUI = interaction!.ui;
        await gate.promise;
        const parent = await createDashboardParent(
          request,
          undefined,
          undefined,
          interaction,
        );
        f.parents.push(parent);
        return parent;
      },
    );
    void first.catch(() => {});
    const second = f.hub.startParent({cwd: f.cwd, name: 'Second'});
    void second.catch(() => {});
    const visible = await f.startup();
    assert.equal(visible.name, 'Second');
    gate.resolve();
    await waitFor(
      () => Boolean(firstUI?.snapshot().dialogs[0]?.terminal?.revision),
      'The earlier startup reaches its trust prompt',
    );
    assert.equal(
      f.hub.snapshot().startup?.id,
      visible.id,
      'Another prompt does not steal focus',
    );
    await f.hub.respondToDialog(visible.id, visible.ui.dialogs[0].id);
    await second;
    const next = await f.startup();
    assert.equal(next.name, 'First');
    await f.hub.respondToDialog(visible.id, visible.ui.dialogs[0].id, {
      input: '\r',
    });
    assert.equal(
      f.trust.get(f.cwd),
      null,
      'A late reply cannot trust another pending project',
    );
    await f.hub.respondToDialog(next.id, next.ui.dialogs[0].id);
    await first;
  },
);

void test(
  'transferred and restored desktop sessions resolve trust before adoption',
  {timeout: 20000},
  async t => {
    const f = await fixture(t);
    const opening = f.open();
    const initial = await f.startup();
    await f.hub.respondToDialog(initial.id, initial.ui.dialogs[0].id);
    const {id} = await opening;
    const saved = f.parents[0].restartSnapshot();
    await f.hub.closeSession(id);
    const restoring = f.hub.startParent(
      {cwd: f.cwd},
      async (request, interaction) => {
        const parent = await createDashboardParent(
          request,
          undefined,
          saved,
          interaction,
        );
        f.parents.push(parent);
        return parent;
      },
    );
    void restoring.catch(() => {});
    const prompt = await f.startup();
    assert.equal(f.hub.snapshot().sessions.length, 0);
    await f.hub.respondToDialog(prompt.id, prompt.ui.dialogs[0].id, {
      input: '\r',
    });
    const parent = await restoring;
    f.hub.adoptSession(parent);
    assert.equal(f.hub.snapshot().sessions[0].session.id, id);
    assert.ok(
      (await parent.features()).commands.some(
        command => command.name === 'skill:review-fix',
      ),
    );
    assert.equal(f.trust.get(f.cwd), true);
  },
);

void test(
  'global extension trust decisions and resource-free projects do not open a startup prompt',
  {timeout: 20000},
  async t => {
    const f = await fixture(t);
    await mkdir(join(f.agentDir, 'extensions'));
    await writeFile(
      join(f.agentDir, 'extensions', 'trust.js'),
      `
    export default pi => pi.on('project_trust', (_event, ctx) => {
      if (!ctx.hasUI || ctx.mode !== 'rpc') throw new Error('Missing desktop startup UI');
      return {trusted: 'yes'};
    });
  `,
    );
    const {id} = await f.open();
    assert.equal(f.hub.snapshot().startup, undefined);
    assert.ok(
      (await f.hub.sessionFeatures(id)).commands.some(
        command => command.name === 'skill:review-fix',
      ),
    );
    assert.equal(f.trust.get(f.cwd), null);
    await f.hub.closeSession(id);
    await rm(join(f.agentDir, 'extensions'), {recursive: true});
    await rm(join(f.cwd, CONFIG_DIR_NAME), {recursive: true});
    await f.open();
    assert.equal(f.hub.snapshot().startup, undefined);
  },
);

for (const cancelStartup of [false, true]) {
  void test(
    `project extension initialization dialogs ${cancelStartup ? 'cancel when the dashboard closes' : 'remain visible through adoption and subsequent commands'}`,
    {timeout: 20000},
    async t => {
      const f = await fixture(t);
      const resultPath = join(f.root, 'initialization-result');
      await writeFile(
        join(f.cwd, CONFIG_DIR_NAME, 'extensions', 'fixture.js'),
        `
        import {writeFileSync} from 'node:fs';
        export default pi => {
          pi.on('session_start', async (_event, ctx) => {
            const accepted = await ctx.ui.confirm('Project initialization', 'Continue?');
            writeFileSync(${JSON.stringify(resultPath)}, String(accepted));
            ctx.ui.notify('Project initialized', 'info');
          });
          pi.registerCommand('initialization-check', {
            handler: async (_args, ctx) => {
              await ctx.ui.confirm('After startup', 'Continue?');
              ctx.ui.notify('Command completed', 'info');
            },
          });
        };
      `,
      );
      const opening = f.open();
      const trust = await f.startup();
      await f.hub.respondToDialog(trust.id, trust.ui.dialogs[0].id, {
        input: '\r',
      });
      await waitFor(
        () =>
          f.hub.snapshot().startup?.ui.dialogs[0]?.title ===
          'Project initialization',
        'Project initialization dialog is published while creation is still pending',
      );
      assert.equal(f.hub.snapshot().sessions.length, 0);
      if (cancelStartup) {
        const rejected = assert.rejects(opening, /abort|closed/i);
        await f.hub.close();
        await rejected;
        assert.equal(await readFile(resultPath, 'utf8'), 'false');
        assert.equal(f.parents.length, 0);
        assert.equal(f.hub.snapshot().startup, undefined);
        return;
      }
      const initialization = await f.startup();
      await f.hub.respondToDialog(
        initialization.id,
        initialization.ui.dialogs[0].id,
        true,
      );
      const {id} = await opening;
      assert.equal(await readFile(resultPath, 'utf8'), 'true');
      assert.ok(
        f.hub
          .snapshot()
          .sessions[0].ui?.notifications.some(
            item => item.message === 'Project initialized',
          ),
      );
      assert.ok(
        (await f.hub.sessionFeatures(id)).commands.some(
          command => command.name === 'skill:review-fix',
        ),
      );
      const command = f.parents[0].prompt('/initialization-check');
      void command.catch(() => {});
      await waitFor(
        () =>
          f.hub.snapshot().sessions[0].ui?.dialogs[0]?.title ===
          'After startup',
        'The adopted parent continues to publish its UI',
      );
      const dialog = f.hub.snapshot().sessions[0].ui!.dialogs[0];
      await f.hub.respondToDialog(id, dialog.id, true);
      await command;
      assert.ok(
        f.hub
          .snapshot()
          .sessions[0].ui?.notifications.some(
            item => item.message === 'Command completed',
          ),
      );
    },
  );
}

void test(
  'notification-only trust decisions remain published and retained in the adopted session',
  {timeout: 15000},
  async t => {
    const f = await fixture(t);
    await mkdir(join(f.agentDir, 'extensions'));
    await writeFile(
      join(f.agentDir, 'extensions', 'trust.js'),
      `
    export default pi => pi.on('project_trust', (_event, ctx) => {
      ctx.ui.notify('Repository resources disabled by policy', 'warning');
      return {trusted: 'no'};
    });
  `,
    );
    const notices: Array<{id: string; message: string; type: string}> = [];
    const unsubscribe = f.hub.subscribe(() => {
      const startup = f.hub.snapshot().startup;
      if (startup && !startup.ui.dialogs.length)
        notices.push(...startup.ui.notifications);
    });
    t.after(unsubscribe);
    const {id} = await f.open();
    const notice = notices.find(
      item => item.message === 'Repository resources disabled by policy',
    );
    assert.ok(notice, 'The notice is published even without a startup dialog');
    assert.equal(notice.type, 'warning');
    assert.ok(
      f.hub
        .snapshot()
        .sessions[0].ui?.notifications.some(item => item.id === notice.id),
    );
    assert.ok(
      !(await f.hub.sessionFeatures(id)).commands.some(
        command => command.source === 'skill',
      ),
    );
  },
);
