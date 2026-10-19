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
  if (current.kind === 'terminal' && value) {
    const deadline = Date.now() + 3000;
    while (
      !ui.snapshot().dialogs[0]?.terminal?.output.includes('Revoke approval') &&
      Date.now() < deadline
    )
      await delay(5);
    assert.match(ui.snapshot().dialogs[0].terminal!.output, /Revoke approval/);
    ui.respond(current.id, {input: value === 'Back' ? '\x1b[B\r' : '\r'});
    return;
  }
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
    await mkdir(join(agentDir, 'extensions'), {recursive: true});
    await writeFile(
      join(agentDir, 'extensions', 'approval-cancellation.ts'),
      `export default function(pi) {
        pi.registerCommand('approval-cancellation-fixture', {
          description: 'Exercise parent dialog cancellation',
          handler: async (_args, ctx) => {
            await ctx.ui.select('First parent dialog', ['Continue']);
            await ctx.ui.select('Follow-up parent dialog', ['Continue']);
          },
        });
      }`,
    );
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
    const workerUi = parent.ui;
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
    const lateDialogCommand = parent.prompt('/approval-cancellation-fixture');
    assert.equal((await dialog(parent.ui)).title, 'First parent dialog');
    const stoppingParent = parent.abort();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      stoppingParent.then(() => true),
      new Promise<boolean>(resolve => {
        deadline = setTimeout(() => resolve(false), 1000);
      }),
    ]);
    clearTimeout(deadline);
    if (!drained) {
      // Release the fixture's second dialog so a regression can fail cleanly.
      parent.ui.cancelDialogs();
      await stoppingParent;
    }
    assert.equal(
      drained,
      true,
      'Parent Stop must drain follow-up dialog requests',
    );
    await lateDialogCommand;
    assert.equal(parent.ui.snapshot().dialogs.length, 0);
    const nextDialogCommand = parent.prompt('/approval-cancellation-fixture');
    assert.equal((await dialog(parent.ui)).title, 'First parent dialog');
    await select(parent.ui, 'Continue');
    assert.equal((await dialog(parent.ui)).title, 'Follow-up parent dialog');
    await select(parent.ui, 'Continue');
    await nextDialogCommand;
    assert.equal(parent.ui.snapshot().dialogs.length, 0);

    assert.ok(workerContext);
    const scope = sessionAgentApprovalScope(workerContext);
    assert.equal(scope.agentId, 'reviewer');
    assert.notEqual(scope.conversationId, 'execution-id');
    assert.notEqual(scope.conversationId, parent.state.snapshot().session.id);
    const store = defaultAgentApprovalStore();
    const operation = {
      toolName: 'write',
      action: 'write',
      resource: 'large-file.txt',
      input: {path: 'large-file.txt', content: 'saved line\n'.repeat(2200)},
    };
    const own = await store.remember(scope, operation, 'conversation');
    const parentGrant = await store.remember(
      {...scope, conversationId: parent.state.snapshot().session.id},
      operation,
      'conversation',
    );
    const agentGrant = await store.remember(scope, operation, 'agent');
    const cancelledReview = worker.command!('/approvals');
    await select(workerUi, 'This conversation');
    const cancelledChoices = await dialog(workerUi);
    await select(workerUi, cancelledChoices.options![0]);
    assert.equal((await dialog(workerUi)).kind, 'terminal');
    worker.clearQueue!();
    await cancelledReview;
    assert.equal(workerUi.snapshot().dialogs.length, 0);
    assert.ok((await store.list()).some(grant => grant.id === own.id));
    const managing = worker.command!('/approvals');
    await select(workerUi, 'This conversation');
    const choices = await dialog(workerUi);
    assert.equal(
      choices.options?.length,
      1,
      'Worker lists only its conversation grants',
    );
    await select(workerUi, choices.options![0]);
    assert.equal((await dialog(workerUi)).kind, 'terminal');
    assert.ok((await dialog(workerUi)).title.length < 100);
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
    const sharedWorkerManagement = worker.command!('/approvals');
    const workerDialog = await dialog(workerUi);
    const mainCancellation = parent.prompt('/approvals');
    const queuedDeadline = Date.now() + 3000;
    while (
      parent.ui.snapshot().dialogs.length < 2 &&
      Date.now() < queuedDeadline
    )
      await delay(5);
    assert.equal(parent.ui.snapshot().dialogs.length, 2);
    await parent.abort();
    await mainCancellation;
    assert.deepEqual(
      parent.ui.snapshot().dialogs.map(item => item.id),
      [workerDialog.id],
      'Stopping the parent preserves a worker approval command',
    );
    worker.clearQueue!();
    await sharedWorkerManagement;
    assert.equal(parent.ui.snapshot().dialogs.length, 0);

    const skill = worker.run(
      '/skill:commit',
      new AbortController().signal,
      () => {},
    );
    const workerPermission = await dialog(workerUi);
    assert.match(workerPermission.title, /Permission: reviewer/);
    await parent.abort();
    assert.equal(
      (await dialog(workerUi)).id,
      workerPermission.id,
      'Stopping the parent preserves a running worker permission request',
    );
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
      const closingSkill = terminalWorker.run(
        '/skill:commit',
        new AbortController().signal,
        () => {},
      );
      const declinedOnClose = assert.rejects(closingSkill, /approval declined/);
      await dialog(workerUi);
      await parent.close();
      await declinedOnClose;
      assert.equal(workerUi.snapshot().dialogs.length, 0);
    } finally {
      await terminalWorker.dispose();
    }
  },
);
