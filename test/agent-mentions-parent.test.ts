import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {
  createDefaultAgentProfile,
  saveAgentTemplate,
} from '../src/agents/templates.ts';
import {
  createDashboardParent,
  type DesktopDashboardParent,
} from '../src/dashboard/parent.ts';
import {saveToolSettings} from '../src/tools/settings.ts';

async function until(
  check: () => boolean,
  detail = () => 'Expected managed mention state',
) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await delay(10);
  assert.ok(check(), detail());
}

void test(
  'managed parent invokes a pinned child without a root model, cancels approval and retires workers on reload',
  {timeout: 15000},
  async t => {
    const root = await mkdtemp(join(tmpdir(), 'varisdev-parent-mentions-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'settings');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    // This fixture starts without a selected model. Its provider is registered by
    // session_start, after Pi's initial model selection has finished.
    const credentials = Object.entries(process.env).filter(([key]) =>
      /API_KEY|TOKEN|ACCESS_KEY|^AWS_|^GOOGLE_CLOUD_|^GCLOUD_PROJECT$|^GOOGLE_APPLICATION_CREDENTIALS$/.test(
        key,
      ),
    );
    for (const [key] of credentials) delete process.env[key];
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const requests: Array<{model: string; messages: unknown}> = [];
    const parents: DesktopDashboardParent[] = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.end(
        `data: ${JSON.stringify({id: 'mention-response', object: 'chat.completion.chunk', created: 1, model: 'pinned-child', choices: [{index: 0, delta: {role: 'assistant', content: 'Child reviewed the task.'}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`,
      );
    });
    t.after(async () => {
      for (const parent of parents) await parent.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      for (const [key, value] of credentials) process.env[key] = value;
      await rm(root, {recursive: true, force: true});
    });
    await mkdir(cwd, {recursive: true});
    await mkdir(join(agentDir, 'extensions'), {recursive: true});
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({retry: {enabled: false}}),
    );
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    await writeFile(
      join(agentDir, 'extensions', 'mention-provider.ts'),
      `
export default function (pi) {
  pi.on('session_start', (_event, ctx) => {
    ctx.modelRegistry.registerProvider('mention-fixture', {
      api: 'openai-completions', apiKey: 'fixture-key', baseUrl: ${JSON.stringify(baseUrl)},
      models: [{id: 'pinned-child', name: 'Pinned child', reasoning: false,
        input: ['text'], contextWindow: 128000, maxTokens: 1000,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}],
    });
  });
}
`,
    );
    await saveToolSettings('agents', {allowedModels: []});
    await saveAgentTemplate(cwd, {
      scope: 'global',
      id: 'review',
      name: 'Review',
      mode: 'subagent',
      model: 'mention-fixture/pinned-child',
      instructions: 'PINNED CHILD INSTRUCTIONS',
    });
    const profile = createDefaultAgentProfile();
    profile.id = 'main-reviewer';
    profile.key = 'workspace:main-reviewer';
    profile.name = 'Main reviewer';
    profile.permissions = [
      {action: 'subagent', resource: 'review', effect: 'ask'},
    ];
    const current = await createDashboardParent({cwd, agentProfile: profile});
    parents.push(current);
    const rootModel = (await current.features()).model;
    assert.ok(!rootModel || rootModel.provider === 'unknown');
    const approved = current.prompt('@review Inspect the changes');
    await until(() => current.ui.snapshot().dialogs.length > 0);
    assert.equal(requests.length, 0);
    const approval = current.ui.snapshot().dialogs[0];
    assert.equal(approval.kind, 'select');
    current.ui.respond(approval.id, 'Allow once');
    await approved;
    await until(
      () =>
        current.state
          .snapshot()
          .agents.some(agent => ['completed', 'failed'].includes(agent.status)),
      () => JSON.stringify(current.state.snapshot()),
    );
    const child = current.state.snapshot().agents[0];
    assert.equal(child.status, 'completed', child.error);
    assert.equal(child.pinnedModel, 'mention-fixture/pinned-child');
    assert.equal(child.agentMode, 'subagent');
    assert.equal(child.task, 'Inspect the changes');
    assert.match(child.output!, /Child reviewed the task/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, 'pinned-child');
    assert.match(
      JSON.stringify(requests[0].messages),
      /PINNED CHILD INSTRUCTIONS/,
    );
    assert.deepEqual((await current.features()).model, rootModel);
    await assert.rejects(
      current.prompt('@unknown Ordinary input'),
      /no model|model.*selected|no API key/i,
    );
    assert.equal(requests.length, 1);
    const cancelled = current.prompt('@review Do not launch this task');
    await until(() => current.ui.snapshot().dialogs.length > 0);
    await current.abort();
    await cancelled;
    assert.equal(current.ui.snapshot().dialogs.length, 0);
    assert.equal(current.state.snapshot().agents.length, 1);
    assert.equal(
      requests.length,
      1,
      'Only the approved child made a provider request',
    );

    const identity = (await current.features()).agentProfile;
    const savedProfile = current
      .restartSnapshot()
      .entries.findLast(
        entry =>
          entry.type === 'custom' &&
          entry.customType === 'varisdev.agent-profile',
      );
    await current.reload();
    const reloaded = current.state.snapshot();
    assert.equal(reloaded.session.status, 'idle');
    assert.equal(reloaded.agents.length, 1);
    assert.equal(reloaded.agents[0].id, child.id);
    assert.equal(reloaded.agents[0].status, 'completed');
    assert.equal(reloaded.agents[0].resumable, false);
    assert.equal(reloaded.agents[0].output, child.output);
    assert.deepEqual(reloaded.session.agentProfile, identity);
    assert.deepEqual((await current.features()).agentProfile, identity);
    assert.deepEqual(
      current
        .restartSnapshot()
        .entries.findLast(
          entry =>
            entry.type === 'custom' &&
            entry.customType === 'varisdev.agent-profile',
        ),
      savedProfile,
      'Reload retains the saved root profile identity',
    );
    assert.equal(requests.length, 1, 'Reload requires no main turn');
    const next = current.prompt('@review A fresh team after reload');
    await until(() => current.ui.snapshot().dialogs.length > 0);
    current.ui.respond(current.ui.snapshot().dialogs[0].id, 'Allow once');
    await next;
    await until(() => {
      const agent = current.state.snapshot().agents[0];
      return agent?.id !== child.id && agent?.status === 'completed';
    });
    const fresh = current.state.snapshot().agents;
    assert.equal(fresh.length, 1);
    assert.notEqual(fresh[0].id, child.id);
    assert.equal(fresh[0].resumable, true);
    assert.equal(requests.length, 2);
  },
);
