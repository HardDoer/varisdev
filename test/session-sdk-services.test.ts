import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {stripVTControlCharacters} from 'node:util';
import {
  ModelRegistry,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import {createDashboardParent} from '../src/dashboard/parent.ts';
import {createSessionWorker} from '../src/agents/session.ts';
import type {DesktopStartup} from '../src/desktop/startup.ts';

interface Capture {
  trusted: boolean;
  model?: string;
  scope: Array<{model: string; thinkingLevel?: string}>;
}

void test('desktop and worker adapters use SDK trust, provider registration, scopes and defaults', async t => {
  const root = await mkdtemp(join(tmpdir(), 'varisdev-sdk-services-'));
  const agentDir = join(root, 'config');
  const cwd = join(root, 'project');
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, {recursive: true, force: true});
  });
  await mkdir(join(agentDir, 'extensions'), {recursive: true});
  await mkdir(join(cwd, '.pi', 'extensions'), {recursive: true});
  await mkdir(join(cwd, '.git'), {recursive: true});
  const capturePath = join(root, 'capture.json');
  const trustPath = join(root, 'trust-context.json');
  const projectPath = join(root, 'project-loaded.txt');
  const bridgePath = join(root, 'provider-auth-name.txt');
  const provider = 'sdk-adapter';
  const config = {
    api: 'openai-completions' as const,
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'adapter-fixture-key',
    models: [
      {
        id: 'physical',
        name: 'Adapter physical',
        reasoning: true,
        input: ['text' as const],
        contextWindow: 128000,
        maxTokens: 1000,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
      },
    ],
  };
  await writeFile(
    join(agentDir, 'extensions', 'capture.js'),
    `
    import {writeFileSync} from 'node:fs';
    export default pi => {
      pi.registerProvider('${provider}', ${JSON.stringify(config)});
      pi.on('project_trust', (_event, ctx) => {
        writeFileSync(${JSON.stringify(trustPath)}, JSON.stringify({mode:ctx.mode,hasUI:ctx.hasUI}));
      });
      pi.on('session_start', (_event, ctx) => {
        writeFileSync(${JSON.stringify(bridgePath)}, ctx.modelRegistry.getProvider('${provider}').auth.apiKey.name);
        writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
          trusted:ctx.isProjectTrusted(),
          model:ctx.model && ctx.model.provider+'/'+ctx.model.id,
          scope:ctx.scopedModels.map(({model,thinkingLevel})=>({model:model.provider+'/'+model.id,thinkingLevel})),
        }));
      });
    };
  `,
  );
  await writeFile(
    join(cwd, '.pi', 'extensions', 'router.js'),
    `
    import {writeFileSync} from 'node:fs';
    export default pi => {
      writeFileSync(${JSON.stringify(projectPath)}, 'loaded');
      pi.registerVirtualModel({provider:'${provider}',id:'auto',name:'Auto',
        route() { return {provider:'${provider}',model:'physical'}; }
      });
    };
  `,
  );
  const settingsPath = join(agentDir, 'settings.json');
  const settings = async (values: object = {}) =>
    writeFile(
      settingsPath,
      JSON.stringify({
        defaultProvider: provider,
        defaultModel: 'physical',
        enabledModels: [`${provider}/physical:high`],
        ...values,
      }),
    );
  const capture = async () =>
    JSON.parse(await readFile(capturePath, 'utf8')) as Capture;
  const store = new ProjectTrustStore(agentDir);
  await settings();
  const untrusted = await createDashboardParent({cwd});
  try {
    assert.deepEqual(await capture(), {
      trusted: false,
      model: `${provider}/physical`,
      scope: [{model: `${provider}/physical`, thinkingLevel: 'high'}],
    });
    assert.deepEqual(JSON.parse(await readFile(trustPath, 'utf8')), {
      mode: 'rpc',
      hasUI: false,
    });
    await assert.rejects(readFile(projectPath), {code: 'ENOENT'});
    const command = untrusted.prompt('/settings');
    const deadline = Date.now() + 3000;
    while (
      !untrusted.ui.snapshot().dialogs[0]?.terminal?.revision &&
      Date.now() < deadline
    )
      await delay(5);
    const dialog = untrusted.ui.snapshot().dialogs[0];
    assert.equal(dialog?.kind, 'terminal');
    untrusted.ui.respond(dialog.id, {input: 'Steering mode'});
    while (
      !untrusted.ui
        .snapshot()
        .dialogs[0]?.terminal?.output.includes('Steering mode') &&
      Date.now() < deadline
    )
      await delay(5);
    assert.match(
      stripVTControlCharacters(
        untrusted.ui.snapshot().dialogs[0]?.terminal?.output ?? '',
      ),
      /Steering mode\s+one-at-a-time/,
    );
    untrusted.ui.respond(dialog.id);
    await command;
  } finally {
    await untrusted.close();
  }

  await t.test(
    'saved trust enables project virtual models before session selection',
    async () => {
      store.set(cwd, true);
      await settings({
        defaultProjectTrust: 'never',
        defaultModel: 'auto',
        enabledModels: [`${provider}/auto:high`],
      });
      const parent = await createDashboardParent({cwd});
      try {
        assert.deepEqual(await capture(), {
          trusted: true,
          model: `${provider}/auto`,
          scope: [{model: `${provider}/auto`, thinkingLevel: 'high'}],
        });
        assert.equal(await readFile(projectPath, 'utf8'), 'loaded');
      } finally {
        await parent.close();
      }
    },
  );

  await t.test(
    'saved denial takes priority over the global always preference',
    async () => {
      store.set(cwd, false);
      await settings({defaultProjectTrust: 'always'});
      await rm(projectPath);
      const parent = await createDashboardParent({cwd});
      try {
        assert.equal((await capture()).trusted, false);
        await assert.rejects(readFile(projectPath), {code: 'ENOENT'});
      } finally {
        await parent.close();
      }
    },
  );

  await t.test(
    'global trust preferences apply without a saved project decision',
    async () => {
      store.set(cwd, null);
      for (const [defaultProjectTrust, trusted] of [
        ['always', true],
        ['never', false],
      ] as const) {
        await settings({defaultProjectTrust});
        const parent = await createDashboardParent({cwd});
        try {
          assert.equal((await capture()).trusted, trusted);
        } finally {
          await parent.close();
        }
      }
      store.set(cwd, false);
    },
  );

  await t.test(
    'startup trust flags and model scopes reach SDK services',
    async () => {
      const manager = SessionManager.inMemory(cwd);
      const startup: DesktopStartup = {
        cwd,
        agentDir,
        sessionDir: manager.getSessionDir(),
        entries: [manager.getHeader()!, ...manager.getEntries()],
        leafId: null,
        thinkingLevel: 'medium',
        tools: ['read'],
        argv: ['--approve', '--models', `${provider}/auto:low`],
      };
      const parent = await createDashboardParent({cwd}, undefined, startup);
      try {
        assert.equal((await capture()).trusted, true);
        assert.deepEqual((await capture()).scope, [
          {model: `${provider}/auto`, thinkingLevel: 'low'},
        ]);
      } finally {
        await parent.close();
      }
      store.set(cwd, true);
      const denied = await createDashboardParent({cwd}, undefined, {
        ...startup,
        argv: ['--no-approve'],
      });
      try {
        assert.equal((await capture()).trusted, false);
      } finally {
        await denied.close();
      }
    },
  );

  await t.test(
    'worker service initialization retains local routes and session trust overrides',
    async () => {
      store.set(cwd, false);
      await settings({
        defaultProjectTrust: 'never',
        enabledModels: [`${provider}/auto:high`],
      });
      const runtime = await ModelRuntime.create({
        authPath: join(agentDir, 'parent-auth.json'),
        modelsPath: null,
        refreshOnCreate: false,
      });
      runtime.registerProvider(provider, config);
      await runtime.refresh({allowNetwork: false});
      const registry = new ModelRegistry(runtime);
      const worker = await createSessionWorker({
        id: 'adapter-worker',
        parentSessionId: 'adapter-parent',
        cwd,
        name: 'Adapter',
        model: registry.find(provider, 'physical')!,
        modelRegistry: registry,
        thinkingLevel: 'medium',
        projectTrustOverride: true,
        agentToolsExtension() {},
      });
      try {
        assert.equal(await readFile(bridgePath, 'utf8'), 'Current agent');
        assert.deepEqual(await capture(), {
          trusted: true,
          model: `${provider}/physical`,
          scope: [{model: `${provider}/auto`, thinkingLevel: 'high'}],
        });
      } finally {
        await worker.dispose();
      }
    },
  );
});
