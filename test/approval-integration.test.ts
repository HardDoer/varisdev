import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {
  ModelRegistry,
  ModelRuntime,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {defaultAgentApprovalStore} from '../src/agents/approvals.ts';
import {sessionAgentApprovalScope} from '../src/agents/approval-context.ts';
import {createSessionWorker} from '../src/agents/session.ts';
import {createDefaultAgentProfile} from '../src/agents/templates.ts';
import {createDashboardParent} from '../src/dashboard/parent.ts';
import {DesktopExtensionUI} from '../src/dashboard/extension-ui.ts';

async function dialog(ui: DesktopExtensionUI) {
  const deadline = Date.now() + 3000;
  while (!ui.snapshot().dialogs.length && Date.now() < deadline) await delay(5);
  const current = ui.snapshot().dialogs[0];
  assert.ok(current, 'Expected a native approval dialog');
  return current;
}
async function select(ui: DesktopExtensionUI, value?: string) {
  const current = await dialog(ui);
  assert.equal(current.kind, 'select');
  if (value) assert.ok(current.options?.includes(value), `Missing ${value}`);
  ui.respond(current.id, value);
}

void test(
  'main and subagent approval commands use their session identity and clean up native dialogs',
  {timeout: 15000},
  async t => {
    const root = await mkdtemp(
      join(tmpdir(), 'varisdev-approval-integration-'),
    );
    const cwd = join(root, 'project');
    const agentDir = join(root, 'settings');
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(cwd, {recursive: true});
    await mkdir(agentDir, {recursive: true});
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({retry: {enabled: false}}),
    );
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    registry.registerProvider('approval-integration', {
      api: 'openai-completions',
      apiKey: 'fixture',
      baseUrl: 'http://127.0.0.1:1/v1',
      models: [
        {
          id: 'model',
          name: 'Fixture',
          reasoning: false,
          input: ['text'],
          contextWindow: 128000,
          maxTokens: 1000,
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
        },
      ],
    });
    const model = registry.find('approval-integration', 'model')!;
    const profile = {
      ...createDefaultAgentProfile(),
      id: 'reviewer',
      key: 'workspace:reviewer',
      name: 'Reviewer',
      mode: 'all' as const,
      permissionsVersion: 1 as const,
      permissions: [
        {action: 'skill', resource: 'commit', effect: 'ask' as const},
      ],
    };
    const parent = await createDashboardParent(
      {cwd, agentProfile: profile},
      {
        model,
        modelRegistry: registry,
        thinkingLevel: 'off',
      },
    );
    const workerUi = new DesktopExtensionUI(() => {});
    let workerContext: ExtensionContext | undefined;
    const worker = await createSessionWorker({
      id: 'execution-id',
      parentSessionId: parent.state.snapshot().session.id,
      cwd,
      name: 'Subagent',
      agentProfile: {...profile, mode: 'subagent'},
      model,
      modelRegistry: registry,
      thinkingLevel: 'off',
      ui: workerUi,
      agentToolsExtension: pi => {
        pi.on('session_start', (_event, ctx) => {
          workerContext = ctx;
        });
      },
    });
    t.after(async () => {
      await worker.dispose();
      workerUi.dispose();
      await parent.close();
      registry.unregisterProvider('approval-integration');
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, {recursive: true, force: true});
    });
    assert.ok(workerContext);
    const scope = sessionAgentApprovalScope(workerContext);
    assert.equal(scope.agentId, 'reviewer');
    assert.notEqual(scope.conversationId, 'execution-id');
    assert.notEqual(scope.conversationId, parent.state.snapshot().session.id);
    const store = defaultAgentApprovalStore();
    const operation = {
      toolName: '/commit',
      action: 'skill',
      resource: 'commit',
      input: {name: 'commit'},
    };
    const own = await store.remember(scope, operation, 'conversation');
    const parentGrant = await store.remember(
      {...scope, conversationId: parent.state.snapshot().session.id},
      operation,
      'conversation',
    );
    const agentGrant = await store.remember(scope, operation, 'agent');
    const managing = worker.command!('/approvals');
    await select(workerUi, 'This conversation');
    const choices = await dialog(workerUi);
    assert.equal(
      choices.options?.length,
      1,
      'Worker lists only its conversation grants',
    );
    await select(workerUi, choices.options![0]);
    assert.equal((await dialog(workerUi)).title, 'reviewer: /commit');
    await select(workerUi, 'Revoke approval');
    await select(workerUi);
    await managing;
    assert.ok(!(await store.list()).some(grant => grant.id === own.id));
    assert.ok((await store.list()).some(grant => grant.id === parentGrant.id));
    assert.ok((await store.list()).some(grant => grant.id === agentGrant.id));

    const mainManagement = parent.prompt('/approvals');
    await select(parent.ui, 'This agent in this workspace');
    const agentChoices = await dialog(parent.ui);
    await select(parent.ui, agentChoices.options![0]);
    await select(parent.ui, 'Revoke approval');
    await select(parent.ui);
    await mainManagement;
    assert.ok(!(await store.list()).some(grant => grant.id === agentGrant.id));

    const workerCancellation = worker.command!('/approvals');
    await dialog(workerUi);
    worker.clearQueue!();
    await workerCancellation;
    assert.equal(workerUi.snapshot().dialogs.length, 0);
    const mainCancellation = parent.prompt('/approvals');
    await dialog(parent.ui);
    await parent.abort();
    await mainCancellation;
    assert.equal(parent.ui.snapshot().dialogs.length, 0);

    const skill = worker.run(
      '/skill:commit',
      new AbortController().signal,
      () => {},
    );
    assert.match((await dialog(workerUi)).title, /Permission: reviewer/);
    await select(workerUi, 'Deny');
    await assert.rejects(skill, /approval declined/);
    const workerController = new AbortController();
    const cancelledSkill = worker.run(
      '/skill:commit',
      workerController.signal,
      () => {},
    );
    await dialog(workerUi);
    workerController.abort();
    await assert.rejects(cancelledSkill, /abort|cancel/i);
    assert.equal(workerUi.snapshot().dialogs.length, 0);

    await store.revoke(parentGrant.id);
    const committing = parent.prompt('/commit');
    await select(parent.ui, 'Deny');
    await committing;
    assert.ok(
      parent.ui
        .snapshot()
        .notifications.some(item => /approval declined/.test(item.message)),
    );
    assert.equal(
      (await store.list()).length,
      0,
      'Denied skill command saves no grant',
    );
    const cancelledCommit = parent.prompt('/commit');
    await dialog(parent.ui);
    await parent.abort();
    await cancelledCommit;
    assert.equal(parent.ui.snapshot().dialogs.length, 0);
    assert.equal((await store.list()).length, 0);
    await assert.rejects(
      worker.command!('/approvals unexpected'),
      /Usage: \/approvals/,
    );

    const terminalWorker = await createSessionWorker({
      id: 'terminal-execution',
      parentSessionId: 'attached-parent',
      cwd,
      name: 'Terminal worker',
      agentProfile: {...profile, mode: 'subagent'},
      model,
      modelRegistry: registry,
      thinkingLevel: 'off',
      approvalUI: workerUi.context,
      agentToolsExtension: () => {},
    });
    try {
      const terminalManagement = terminalWorker.command!('/approvals');
      await dialog(workerUi);
      terminalWorker.clearQueue!();
      await terminalManagement;
      assert.equal(workerUi.snapshot().dialogs.length, 0);
      const terminalSkill = terminalWorker.run(
        '/skill:commit',
        new AbortController().signal,
        () => {},
      );
      await select(workerUi, 'Deny');
      await assert.rejects(terminalSkill, /approval declined/);
      assert.equal(workerUi.snapshot().dialogs.length, 0);
    } finally {
      await terminalWorker.dispose();
    }
  },
);
