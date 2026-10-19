import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {
  createServer,
  type IncomingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionToolContext,
  type SessionShutdownEvent,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {createSessionWorker} from '../src/agents/session.ts';
import {WorkerConversation} from '../src/agents/conversation.ts';
import {
  AgentOrchestrator,
  type AgentRecord,
  type AgentWorker,
} from '../src/agents/orchestrator.ts';
import {DashboardState} from '../src/dashboard/state.ts';
import {DesktopExtensionUI} from '../src/dashboard/extension-ui.ts';
import type {ModelUsage} from '../src/usage.ts';
import {registerAgentTools} from '../src/tools/agents.ts';
import {saveToolSettings} from '../src/tools/settings.ts';
import {
  createDefaultAgentProfile,
  saveAgentTemplate,
  type AgentTemplate,
} from '../src/agents/templates.ts';
import {workspaceConfigPaths} from '../src/dashboard/workspace-config.ts';

function toolContext(ctx: ExtensionContext): ExtensionToolContext {
  return Object.assign(ctx, {
    tools: [],
    async executeTool(): Promise<never> {
      throw new Error('Nested tool calls are not configured for this fixture.');
    },
  });
}

interface ProviderRequest {
  model: string;
  reasoning_effort?: string;
  messages: Array<{role: string; content: unknown}>;
  tools: Array<{function: {name: string}}>;
}

type ShutdownHandler = (
  event: SessionShutdownEvent | {type: 'agent_settled'},
) => Promise<void> | void;

function reply(
  response: ServerResponse,
  output: string | {name: string; arguments: Record<string, unknown>},
  contextTokens = 100,
) {
  const toolCall = typeof output !== 'string';
  const delta = toolCall
    ? {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `call_${randomUUID()}`,
            type: 'function',
            function: {
              name: output.name,
              arguments: JSON.stringify(output.arguments),
            },
          },
        ],
      }
    : {role: 'assistant', content: output};
  response.writeHead(200, {'content-type': 'text/event-stream'});
  response.end(
    `data: ${JSON.stringify({
      id: 'completion',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'worker-model',
      choices: [
        {index: 0, delta, finish_reason: toolCall ? 'tool_calls' : 'stop'},
      ],
      usage: {
        prompt_tokens: contextTokens,
        completion_tokens: 10,
        total_tokens: contextTokens + 10,
        prompt_tokens_details: {cached_tokens: 25, cache_write_tokens: 5},
      },
    })}\n\ndata: [DONE]\n\n`,
  );
}

function lastToolResult<T>(request: ProviderRequest): T {
  const content = request.messages.findLast(
    message => message.role === 'tool',
  )?.content;
  assert.ok(typeof content === 'string', 'Expected a tool result from the SDK');
  return JSON.parse(content) as T;
}

void test(
  'Pi workers load project tools, persist follow-up conversations, and compact through the SDK',
  {timeout: 15000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-worker-sdk-'));
    const agentDir = join(directory, 'config');
    const cwd = join(directory, 'project');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(modelRuntime);
    const requests: ProviderRequest[] = [];
    const requestHeaders: IncomingHttpHeaders[] = [];
    const server = createServer(async (request, response) => {
      try {
        let body = '';
        for await (const chunk of request) body += chunk;
        requests.push(JSON.parse(body));
        requestHeaders.push(request.headers);
        reply(
          response,
          requests.length === 1
            ? {name: 'read', arguments: {path: 'context.txt'}}
            : requests.length === 5
              ? 'Compacted fixture context.'
              : `Final answer ${requests.length}`,
          requests.length === 4 ? 120000 : undefined,
        );
      } catch (error) {
        response.writeHead(500);
        response.end(String(error));
      }
    });
    let worker: AgentWorker | undefined;
    let workerTools: string[] = [];
    let workerCommands: string[] = [];
    let workerModels: string[] = [];
    let workerStopped = false;
    t.after(async () => {
      await worker?.dispose();
      worker = undefined;
      assert.ok(workerStopped);
      registry.unregisterProvider('varisdev-agent-test');
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, {recursive: true, force: true});
    });
    await mkdir(join(cwd, '.git'), {recursive: true});
    await mkdir(agentDir, {recursive: true});
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({compaction: {keepRecentTokens: 32}}),
    );
    await writeFile(
      join(cwd, 'AGENTS.md'),
      'Project instruction marker: report every finding.',
    );
    await writeFile(
      join(cwd, 'context.txt'),
      'Fixture contents from the worker directory.',
    );
    await mkdir(join(cwd, '.pi', 'prompts'), {recursive: true});
    await mkdir(join(cwd, '.pi', 'skills', 'fixture'), {recursive: true});
    await writeFile(
      join(cwd, '.pi', 'prompts', 'report.md'),
      '---\ndescription: Fixture report\n---\nProject template marker: $1',
    );
    await writeFile(
      join(cwd, '.pi', 'skills', 'fixture', 'SKILL.md'),
      '---\nname: fixture\ndescription: Fixture skill\n---\nProject skill marker: inspect every finding.',
    );
    await saveToolSettings('agents', {
      allowedModels: ['varisdev-agent-test/worker-model'],
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    registry.registerProvider('varisdev-agent-test', {
      api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      apiKey: 'local-test-key',
      headers: {'x-parent-provider': 'provider-config'},
      models: [
        {
          id: 'worker-model',
          name: 'Worker model',
          reasoning: true,
          input: ['text'],
          cost: {input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0.3},
          contextWindow: 128000,
          maxTokens: 1000,
          headers: {'x-parent-model': 'model-config'},
          compat: {supportsReasoningEffort: true},
        },
        {
          id: 'small-context-model',
          name: 'Small context model',
          reasoning: true,
          input: ['text'],
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          contextWindow: 64000,
          maxTokens: 1000,
          compat: {supportsReasoningEffort: true},
        },
      ],
    });
    await modelRuntime.setRuntimeApiKey(
      'varisdev-agent-test',
      'parent-runtime-key',
    );
    worker = await createSessionWorker({
      id: 'worker-id',
      parentSessionId: 'parent-id',
      cwd,
      name: 'SDK worker',
      instructions: 'Worker instruction marker: inspect the fixture.',
      model: registry.find('varisdev-agent-test', 'worker-model')!,
      modelRegistry: registry,
      thinkingLevel: 'high',
      projectTrustOverride: true,
      agentToolsExtension: pi => {
        pi.on('session_start', (_event, ctx) => {
          workerTools = pi.getAllTools().map(tool => tool.name);
          workerCommands = pi.getCommands().map(command => command.name);
          workerModels = ctx.modelRegistry
            .getAvailable()
            .map(model => `${model.provider}/${model.id}`);
        });
        pi.on('session_shutdown', () => {
          workerStopped = true;
        });
      },
    });
    assert.ok(
      workerTools.includes('codemode') && workerTools.includes('tool_search'),
    );
    assert.ok(workerCommands.includes('mcp'));
    assert.ok(workerModels.includes('varisdev-agent-test/worker-model'));
    const initialFeatures = await worker.features!();
    assert.deepEqual(initialFeatures.agentProfile, {
      id: 'default',
      name: 'Default',
      mode: 'all',
    });
    assert.ok(
      initialFeatures.commands.some(
        command => command.name === 'report' && command.source === 'prompt',
      ),
    );
    assert.ok(
      initialFeatures.commands.some(
        command =>
          command.name === 'skill:fixture' && command.source === 'skill',
      ),
    );
    assert.deepEqual(
      initialFeatures.models.map(model => `${model.provider}/${model.id}`),
      ['varisdev-agent-test/worker-model'],
    );

    const activity: string[] = [];
    const usageUpdates: ModelUsage[] = [];
    assert.equal(
      await worker.run(
        'Read context.txt and report.',
        AbortSignal.timeout(5000),
        item => activity.push(item),
        usage => usageUpdates.push(usage),
      ),
      'Final answer 2',
    );
    assert.ok(activity.includes('Using read'));
    const selectedProfiles = SessionManager.open(worker.sessionFile!)
      .getBranch()
      .filter(
        entry =>
          entry.type === 'custom' &&
          entry.customType === 'varisdev.agent-profile',
      );
    assert.equal(selectedProfiles.length, 1);
    assert.ok(selectedProfiles[0].type === 'custom');
    const selectedDefault = selectedProfiles[0].data as AgentTemplate;
    assert.equal(selectedDefault.key, 'builtin:default');
    assert.equal(selectedDefault.instructions, '');
    assert.deepEqual(selectedDefault.permissions, []);
    assert.equal(selectedDefault.steps, undefined);
    assert.equal(selectedDefault.model, undefined);
    assert.equal(selectedDefault.thinkingLevel, undefined);
    assert.equal(worker.usage?.calls.length, 2);
    assert.equal(worker.usage?.totalTokens, 220);
    const responseContext = worker.context;
    assert.ok(responseContext);
    assert.equal(responseContext.window, 128000);
    assert.ok(responseContext.tokens !== null && responseContext.tokens > 0);
    assert.equal(
      responseContext.percent,
      (responseContext.tokens / responseContext.window) * 100,
    );
    assert.deepEqual(
      worker.usage?.calls.map(call => call.toolNames),
      [['read'], []],
    );
    assert.ok(Math.abs(worker.usage!.cost - 0.000373) < 1e-12);
    assert.ok(usageUpdates.some(usage => usage.calls.length === 1));
    usageUpdates.at(-1)!.calls[0].toolNames.push('mutated');
    assert.deepEqual(worker.usage?.calls[0].toolNames, ['read']);
    const toolNames = requests[0].tools.map(tool => tool.function.name);
    for (const name of [
      'read',
      'bash',
      'edit',
      'write',
      'browse',
      'download',
      'gamemaker_query',
      'image_query',
      'json_query',
      'openai_image',
    ]) {
      assert.ok(
        toolNames.includes(name),
        `${name} must be available to workers`,
      );
    }
    assert.equal(
      toolNames.some(name => name.startsWith('agent_')),
      false,
    );
    assert.match(
      JSON.stringify(requests[0].messages),
      /Project instruction marker/,
    );
    assert.match(
      JSON.stringify(requests[0].messages),
      /Worker instruction marker/,
    );
    const defaultSystem = JSON.stringify(
      requests[0].messages.filter(message =>
        ['system', 'developer'].includes(message.role),
      ),
    );
    assert.match(defaultSystem, /You are an expert coding assistant/);
    assert.doesNotMatch(
      defaultSystem,
      /Other agents may edit files in this working directory\./,
    );
    assert.doesNotMatch(
      defaultSystem,
      /builtin:default|Agent \\"Default\\"|You are delegated|Your final answer should report/,
    );
    assert.match(
      JSON.stringify(
        requests[1].messages.filter(message => message.role === 'tool'),
      ),
      /Fixture contents from the worker directory/,
    );
    await modelRuntime.setRuntimeApiKey(
      'varisdev-agent-test',
      'rotated-parent-key',
    );
    assert.equal(
      await worker.run(
        'Summarize your previous answer.',
        AbortSignal.timeout(5000),
        () => {},
      ),
      'Final answer 3',
    );
    assert.match(JSON.stringify(requests[2].messages), /Final answer 2/);
    assert.equal(worker.usage?.calls.length, 3);
    assert.equal(worker.usage?.totalTokens, 330);
    assert.deepEqual(
      requestHeaders.map(headers => headers.authorization),
      [
        'Bearer parent-runtime-key',
        'Bearer parent-runtime-key',
        'Bearer rotated-parent-key',
      ],
    );
    for (const headers of requestHeaders) {
      assert.equal(headers['x-parent-provider'], 'provider-config');
      assert.equal(headers['x-parent-model'], 'model-config');
    }
    for (const request of requests) {
      assert.equal(request.model, 'worker-model');
      assert.equal(request.reasoning_effort, 'high');
    }
    assert.equal(await readFile(worker.resultFile!, 'utf8'), 'Final answer 3');
    const transcript = await readFile(worker.sessionFile!, 'utf8');
    assert.match(transcript, /Fixture contents from the worker directory/);
    assert.match(transcript, /Summarize your previous answer/);

    assert.equal(
      await worker.run(
        'Continue with the next finding.',
        AbortSignal.timeout(5000),
        item => activity.push(item),
      ),
      'Final answer 4',
    );
    assert.ok(activity.includes('Compacting conversation'));
    const compacted = (await readFile(worker.sessionFile!, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    const compactions = compacted.filter(entry => entry.type === 'compaction');
    assert.equal(compactions.length, 1);
    assert.equal(
      worker.usage?.calls.length,
      5,
      'compaction aggregate is included alongside recorded responses',
    );
    assert.equal(worker.usage?.totalTokens, 120450);
    const summaryUsage = worker.usage!.calls.find(
      call => call.kind === 'compaction',
    )!;
    assert.equal(summaryUsage.id, `compaction-${compactions[0].id}`);
    assert.equal(summaryUsage.totalTokens, 110);
    assert.deepEqual(summaryUsage.toolNames, []);
    assert.ok(summaryUsage.cost > 0);
    assert.match(compactions[0].summary, /Compacted fixture context/);
    assert.equal(
      await worker.run(
        'Summarize the latest finding.',
        AbortSignal.timeout(5000),
        () => {},
      ),
      'Final answer 6',
    );
    assert.match(
      JSON.stringify(requests[5].messages),
      /Compacted fixture context/,
    );
    assert.match(JSON.stringify(requests[5].messages), /Final answer 4/);
    assert.equal(await readFile(worker.resultFile!, 'utf8'), 'Final answer 6');
    assert.equal(worker.usage?.calls.length, 6);
    assert.equal(worker.usage?.totalTokens, 120560);
    const restoredConversation = new WorkerConversation(
      SessionManager.open(worker.sessionFile!).getBranch(),
    ).snapshot();
    assert.deepEqual(
      restoredConversation.conversation.map(message => [
        message.id,
        message.role,
        message.text,
        message.input,
        message.status,
        message.at,
      ]),
      worker.conversation!.conversation.map(message => [
        message.id,
        message.role,
        message.text,
        message.input,
        message.status,
        message.at,
      ]),
      'Serialized SDK history restores the same public message identities and tool inputs',
    );
    await assert.rejects(
      worker.configure!({thinkingLevel: 'invalid'}),
      /Thinking level must be one of/,
    );
    await assert.rejects(
      worker.configure!({provider: 'missing', modelId: 'missing'}),
      /Model is unavailable/,
    );
    await saveToolSettings('agents', {allowedModels: []});
    await assert.rejects(
      worker.configure!({modelId: 'worker-model'}),
      /No agent models selected/,
    );
    await saveToolSettings('agents', {
      allowedModels: ['varisdev-agent-test/worker-model'],
    });
    const configured = await worker.configure!({
      thinkingLevel: 'low',
      persist: false,
    });
    assert.deepEqual(configured.model, {
      provider: 'varisdev-agent-test',
      id: 'worker-model',
    });
    assert.equal(configured.thinkingLevel, 'low');
    await worker.run('/report selected', AbortSignal.timeout(5000), () => {});
    assert.match(
      JSON.stringify(requests[6].messages.at(-1)),
      /Project template marker: selected/,
    );
    assert.equal(requests[6].reasoning_effort, 'low');
    await worker.run('/skill:fixture', AbortSignal.timeout(5000), () => {});
    assert.match(
      JSON.stringify(requests[7].messages.at(-1)),
      /Project skill marker/,
    );
    await writeFile(
      join(cwd, '.pi', 'prompts', 'report.md'),
      '---\ndescription: Revised report\n---\nReloaded template marker: $1',
    );
    await worker.reload!();
    assert.ok(
      (await worker.features!()).commands.some(
        command =>
          command.name === 'report' && command.description === 'Revised report',
      ),
    );
    await worker.run('/report revised', AbortSignal.timeout(5000), () => {});
    assert.match(
      JSON.stringify(requests[8].messages.at(-1)),
      /Reloaded template marker: revised/,
    );
    await worker.compact!('Keep fixture findings');
    assert.ok(
      worker.usage!.calls.filter(call => call.kind === 'compaction').length >=
        2,
    );
    assert.deepEqual(worker.context, {
      tokens: null,
      window: 128000,
      percent: null,
    });
    await saveToolSettings('agents', {
      allowedModels: [
        'varisdev-agent-test/worker-model',
        'varisdev-agent-test/small-context-model',
      ],
    });
    await worker.configure!({
      provider: 'varisdev-agent-test',
      modelId: 'small-context-model',
      persist: false,
    });
    assert.deepEqual(worker.context, {
      tokens: null,
      window: 64000,
      percent: null,
    });
  },
);

void test(
  'pinned worker profiles override factory models and remain fixed across global policy changes',
  {timeout: 15000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-worker-pin-'));
    const agentDir = join(directory, 'config');
    const cwd = join(directory, 'project');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(join(cwd, '.git'), {recursive: true});
    await mkdir(agentDir, {recursive: true});
    const providerId = 'worker-pin-test';
    const pinnedId = 'pinned-model';
    const inheritedId = 'inherited-model';
    const pinnedReference = `${providerId}/${pinnedId}`;
    const inheritedReference = `${providerId}/${inheritedId}`;
    const registry = new ModelRegistry(
      await ModelRuntime.create({
        authPath: join(agentDir, 'auth.json'),
        modelsPath: null,
        refreshOnCreate: false,
      }),
    );
    const workers: AgentWorker[] = [];
    t.after(async () => {
      await Promise.all(workers.map(worker => worker.dispose()));
      registry.unregisterProvider(providerId);
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, {recursive: true, force: true});
    });
    registry.registerProvider(providerId, {
      api: 'openai-completions',
      baseUrl: 'https://worker-pin.invalid/v1',
      apiKey: 'fixture-key',
      models: [
        {
          id: pinnedId,
          name: 'Pinned worker model',
          reasoning: true,
          input: ['text'],
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          contextWindow: 128000,
          maxTokens: 1000,
          compat: {supportsReasoningEffort: true},
        },
        {
          id: inheritedId,
          name: 'Inherited worker model',
          reasoning: true,
          input: ['text'],
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          contextWindow: 128000,
          maxTokens: 1000,
          compat: {supportsReasoningEffort: true},
        },
      ],
    });
    await saveToolSettings('agents', {allowedModels: [inheritedReference]});
    const profile: AgentTemplate = {
      ...createDefaultAgentProfile(),
      id: 'pinned',
      key: 'workspace:pinned',
      name: 'Pinned worker',
      model: pinnedReference,
      permissionsVersion: 1,
      scope: 'workspace',
      sourcePath: join(cwd, '.pi', 'agents', 'pinned.md'),
    };
    const ui = new DesktopExtensionUI(() => {});
    const creatingPinned = createSessionWorker({
      id: 'pinned-worker',
      parentSessionId: 'pin-parent',
      cwd,
      name: 'Pinned worker',
      model: registry.find(providerId, inheritedId)!,
      modelRegistry: registry,
      thinkingLevel: 'off',
      agentProfile: profile,
      ui,
      agentToolsExtension: () => {},
    });
    profile.model = inheritedReference;
    const pinned = await creatingPinned;
    workers.push(pinned);

    const initial = await pinned.features!();
    assert.deepEqual(initial.model, {provider: providerId, id: pinnedId});
    assert.deepEqual(
      initial.models.map(model => `${model.provider}/${model.id}`),
      [pinnedReference],
      'the pin remains visible even when the global policy allows another model',
    );
    await saveToolSettings('agents', {allowedModels: []});
    assert.deepEqual(
      (await pinned.features!()).models.map(
        model => `${model.provider}/${model.id}`,
      ),
      [pinnedReference],
    );
    await pinned.configure!({provider: providerId, modelId: pinnedId});
    const thinkingLevel = initial.thinkingLevels.find(level => level !== 'off');
    assert.ok(thinkingLevel);
    await pinned.command!(`/thinking ${thinkingLevel}`);
    assert.equal((await pinned.features!()).thinkingLevel, thinkingLevel);
    await assert.rejects(
      pinned.command!(`/model ${inheritedReference}`),
      /configuration requires model worker-pin-test\/pinned-model/,
    );
    await assert.rejects(
      pinned.configure!({
        provider: providerId,
        modelId: inheritedId,
        thinkingLevel: 'off',
      }),
      /configuration requires model worker-pin-test\/pinned-model/,
    );
    const unchanged = await pinned.features!();
    assert.deepEqual(unchanged.model, {provider: providerId, id: pinnedId});
    assert.equal(unchanged.thinkingLevel, thinkingLevel);

    const inherited = await createSessionWorker({
      id: 'inherited-worker',
      parentSessionId: 'pin-parent',
      cwd,
      name: 'Inherited worker',
      model: registry.find(providerId, inheritedId)!,
      modelRegistry: registry,
      thinkingLevel: 'off',
      agentToolsExtension: () => {},
    });
    workers.push(inherited);
    assert.deepEqual((await inherited.features!()).models, []);
    await assert.rejects(
      inherited.configure!({provider: providerId, modelId: inheritedId}),
      /No agent models selected/,
    );
    await saveToolSettings('agents', {allowedModels: [inheritedReference]});
    assert.deepEqual(
      (await inherited.features!()).models.map(
        model => `${model.provider}/${model.id}`,
      ),
      [inheritedReference],
    );
    await inherited.configure!({provider: providerId, modelId: inheritedId});

    await assert.rejects(
      createSessionWorker({
        id: 'missing-pin-worker',
        parentSessionId: 'pin-parent',
        cwd,
        name: 'Missing pin worker',
        model: registry.find(providerId, inheritedId)!,
        modelRegistry: registry,
        thinkingLevel: 'off',
        agentProfile: {...profile, model: `${providerId}/missing`},
        agentToolsExtension: () => {},
      }),
      /Configured agent model is unavailable: worker-pin-test\/missing/,
    );
  },
);

void test(
  'SDK workers use native parent providers and refresh OAuth in the parent credential store',
  {timeout: 15000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-worker-oauth-'));
    const cwd = join(directory, 'project');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(directory, 'config');
    const providerId = 'varisdev-oauth-test';
    const authPath = join(directory, 'parent-auth.json');
    await writeFile(
      authPath,
      JSON.stringify({
        [providerId]: {
          type: 'oauth',
          access: 'expired',
          refresh: 'refresh-token',
          expires: 1,
        },
      }),
    );
    const modelRuntime = await ModelRuntime.create({
      authPath,
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(modelRuntime);
    const requestHeaders: IncomingHttpHeaders[] = [];
    const server = createServer((request, response) => {
      request.resume();
      requestHeaders.push(request.headers);
      reply(response, 'OAuth worker result.');
    });
    let worker: AgentWorker | undefined;
    t.after(async () => {
      await worker?.dispose();
      worker = undefined;
      registry.unregisterProvider(providerId);
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, {recursive: true, force: true});
    });
    await mkdir(join(cwd, '.git'), {recursive: true});
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    registry.registerProvider(providerId, {
      api: 'openai-completions',
      // The OAuth result supplies the actual endpoint for the native provider.
      baseUrl: 'http://127.0.0.1:1/v1',
      models: [
        {
          id: 'worker-model',
          name: 'Worker model',
          reasoning: false,
          input: ['text'],
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          contextWindow: 128000,
          maxTokens: 1000,
        },
      ],
    });
    const transport = registry.getProvider(providerId)!;
    let refreshes = 0;
    let streams = 0;
    registry.registerProvider({
      ...transport,
      auth: {
        oauth: {
          name: 'Local OAuth',
          isSubscription: true,
          async login() {
            throw new Error('Unexpected login');
          },
          async refresh(credential) {
            refreshes++;
            assert.equal(credential.refresh, 'refresh-token');
            return {
              ...credential,
              access: 'refreshed-parent-token',
              expires: Date.now() + 3600000,
            };
          },
          async toAuth(credential) {
            return {
              apiKey: credential.access,
              headers: {'x-parent-oauth': 'forwarded'},
              baseUrl,
            };
          },
        },
      },
      streamSimple(model, context, options) {
        streams++;
        assert.equal(model.baseUrl, baseUrl);
        return transport.streamSimple(model, context, options);
      },
    });
    await registry.refresh({allowNetwork: false, providers: [providerId]});
    worker = await createSessionWorker({
      id: 'oauth-worker',
      parentSessionId: 'oauth-parent',
      cwd,
      name: 'OAuth worker',
      model: registry.find(providerId, 'worker-model')!,
      modelRegistry: registry,
      thinkingLevel: 'off',
      agentToolsExtension: () => {},
    });
    assert.equal(
      await worker.run('Respond.', AbortSignal.timeout(5000), () => {}),
      'OAuth worker result.',
    );
    assert.equal(
      await worker.run('Follow up.', AbortSignal.timeout(5000), () => {}),
      'OAuth worker result.',
    );
    assert.equal(refreshes, 1);
    assert.equal(streams, 2);
    assert.equal(requestHeaders.length, 2);
    for (const headers of requestHeaders) {
      assert.equal(headers.authorization, 'Bearer refreshed-parent-token');
      assert.equal(headers['x-parent-oauth'], 'forwarded');
    }
    const stored = JSON.parse(await readFile(authPath, 'utf8'));
    assert.equal(stored[providerId].access, 'refreshed-parent-token');
  },
);

void test(
  'SDK workers discover peers, steer active tool loops, resume conversations, and store parent inbox messages silently',
  {timeout: 20000},
  async t => {
    const directory = await mkdtemp(
      join(tmpdir(), 'varisdev-worker-messaging-'),
    );
    const agentDir = join(directory, 'config');
    const cwd = join(directory, 'project');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const registry = new ModelRegistry(
      await ModelRuntime.create({
        authPath: join(agentDir, 'auth.json'),
        modelsPath: null,
        refreshOnCreate: false,
      }),
    );
    const tools = new Map<string, ToolDefinition>();
    const events = new Map<string, ShutdownHandler>();
    const parentMessages: Array<Parameters<ExtensionAPI['sendMessage']>> = [];
    let parentInboxMessageId = '';
    const pi = {
      registerTool(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
      registerCommand() {},
      on(event: string, handler: ShutdownHandler) {
        events.set(event, handler);
      },
      getThinkingLevel: () => 'off',
      sendMessage(...args: Parameters<ExtensionAPI['sendMessage']>) {
        parentMessages.push(args);
      },
    } as unknown as ExtensionAPI;
    // Use the production worker factory and its injected agent tools.
    registerAgentTools(pi);

    const spawned = Promise.withResolvers<void>();
    const peerQueued = Promise.withResolvers<void>();
    const requests: Record<'Receiver' | 'Sender', ProviderRequest[]> = {
      Receiver: [],
      Sender: [],
    };
    const providerErrors: unknown[] = [];
    const queuedMessage = 'Peer finding queued during the initial task.';
    const resumedMessage = 'Peer finding sent after completion.';
    const parentMessage = 'Received the queued peer finding.';
    interface Discovery {
      view: string;
      selfId: string;
      summary: Record<string, number>;
      agents: Array<Pick<AgentRecord, 'id' | 'name' | 'status'>>;
    }
    function discover(request: ProviderRequest, self: AgentRecord) {
      const result = lastToolResult<Discovery>(request);
      assert.equal(result.view, 'all');
      assert.equal(result.selfId, self.id);
      assert.equal(
        Object.values(result.summary).reduce((sum, count) => sum + count, 0),
        2,
      );
      assert.deepEqual(
        result.agents.map(agent => [agent.name, agent.id]).sort(),
        [
          [receiver.name, receiver.id],
          [sender.name, sender.id],
        ].sort(),
      );
      const peer = result.agents.find(agent => agent.id !== result.selfId);
      assert.ok(peer, 'The worker must discover its peer from agent_list');
      return peer;
    }
    function assertSender(content: unknown, message: string) {
      const text =
        typeof content === 'string' ? content : JSON.stringify(content);
      assert.ok(
        text.includes(message),
        `Expected delivered message: ${message}`,
      );
      const prefix = text.slice(0, text.indexOf(message));
      assert.match(prefix, new RegExp(sender.name));
      assert.match(prefix, new RegExp(sender.id));
    }
    const server = createServer(async (request, response) => {
      try {
        let body = '';
        for await (const chunk of request) body += chunk;
        const input = JSON.parse(body) as ProviderRequest;
        const firstUser = JSON.stringify(
          input.messages.find(message => message.role === 'user')?.content,
        );
        assert.match(firstUser, /Receiver initial task|Sender initial task/);
        const name = firstUser.includes('Receiver initial task')
          ? 'Receiver'
          : 'Sender';
        requests[name].push(input);
        await spawned.promise;
        const step = requests[name].length;
        if (step === 1) {
          assert.deepEqual(
            input.tools
              .map(tool => tool.function.name)
              .filter(tool => tool.startsWith('agent_'))
              .sort(),
            [
              'agent_cancel',
              'agent_inbox',
              'agent_list',
              'agent_send',
              'agent_spawn',
              'agent_status',
              'agent_wait',
            ],
          );
          assert.ok(input.tools.some(tool => tool.function.name === 'read'));
          const prompt = JSON.stringify(
            input.messages.filter(message =>
              ['system', 'developer'].includes(message.role),
            ),
          );
          assert.doesNotMatch(
            prompt,
            /Other agents may edit files in this working directory\./,
          );
          assert.doesNotMatch(
            prompt,
            /You are delegated|Complete the task using its instructions|Your final answer should report|reads its inbox|Do not duplicate the final answer/,
          );
          reply(response, {name: 'agent_list', arguments: {view: 'all'}});
        } else if (name === 'Receiver' && step === 2) {
          assert.equal(discover(input, receiver).id, sender.id);
          // Hold an unfinished tool loop until the peer sends steering.
          await peerQueued.promise;
          reply(response, {name: 'agent_list', arguments: {view: 'all'}});
        } else if (name === 'Sender' && step === 2) {
          const peer = discover(input, sender);
          reply(response, {
            name: 'agent_send',
            arguments: {id: peer.id, message: queuedMessage},
          });
        } else if (name === 'Sender' && step === 3) {
          const result = lastToolResult<{agents: AgentRecord[]}>(input);
          assert.equal(result.agents[0].id, receiver.id);
          assert.equal(result.agents[0].status, 'running');
          peerQueued.resolve();
          reply(response, 'Sender queued the peer finding.');
        } else if (name === 'Receiver' && step === 3) {
          assertSender(
            input.messages.findLast(message => message.role === 'user')
              ?.content,
            queuedMessage,
          );
          assert.match(JSON.stringify(input.messages), /Receiver initial task/);
          reply(response, {
            name: 'agent_send',
            arguments: {id: 'parent', message: parentMessage},
          });
        } else if (name === 'Receiver' && step === 4) {
          const result = lastToolResult<{
            recipient: 'parent';
            stored: true;
            messageId: string;
          }>(input);
          assert.equal(result.recipient, 'parent');
          assert.equal(result.stored, true);
          assert.ok(result.messageId);
          parentInboxMessageId = result.messageId;
          reply(response, 'Receiver handled the queued finding.');
        } else if (name === 'Sender' && step === 4) {
          assert.match(
            JSON.stringify(
              input.messages.findLast(message => message.role === 'user'),
            ),
            /Send a second peer finding/,
          );
          reply(response, {name: 'agent_list', arguments: {view: 'all'}});
        } else if (name === 'Sender' && step === 5) {
          const peer = discover(input, sender);
          assert.equal(peer.status, 'completed');
          reply(response, {
            name: 'agent_send',
            arguments: {id: peer.id, message: resumedMessage},
          });
        } else if (name === 'Sender' && step === 6) {
          const result = lastToolResult<{agents: AgentRecord[]}>(input);
          assert.equal(result.agents[0].id, receiver.id);
          assert.ok(['queued', 'running'].includes(result.agents[0].status));
          reply(response, 'Sender sent the second finding.');
        } else if (name === 'Receiver' && step === 5) {
          assertSender(
            input.messages.findLast(message => message.role === 'user')
              ?.content,
            resumedMessage,
          );
          assert.match(JSON.stringify(input.messages), /Receiver initial task/);
          assert.match(
            JSON.stringify(input.messages),
            /Receiver handled the queued finding/,
          );
          reply(response, 'Receiver handled the second finding.');
        } else {
          assert.fail(`Unexpected provider request ${name} ${step}`);
        }
      } catch (error) {
        providerErrors.push(error);
        // Finish the local response and release gates so failures reach assertions promptly.
        peerQueued.resolve();
        reply(response, `Provider fixture failed: ${String(error)}`);
      }
    });
    t.after(async () => {
      spawned.resolve();
      peerQueued.resolve();
      await events.get('session_shutdown')?.({
        type: 'session_shutdown',
        reason: 'quit',
      });
      registry.unregisterProvider('openai-codex');
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, {recursive: true, force: true});
    });
    await mkdir(join(cwd, '.git'), {recursive: true});
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    registry.registerProvider('openai-codex', {
      api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      apiKey: 'local-test-key',
      models: [
        {
          id: 'gpt-5.6-sol',
          name: 'Codex GPT-5.6 Sol',
          reasoning: false,
          input: ['text'],
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          contextWindow: 128000,
          maxTokens: 1000,
        },
      ],
    });
    await saveToolSettings('agents', {
      allowedModels: ['openai-codex/gpt-5.6-sol'],
    });
    const ctx = {
      cwd,
      hasUI: false,
      model: registry.find('openai-codex', 'gpt-5.6-sol')!,
      modelRegistry: registry,
      isIdle: () => true,
      isProjectTrusted: () => false,
      sessionManager: {getSessionId: () => 'messaging-parent'},
    } as unknown as ExtensionContext;
    const executeCtx = toolContext(ctx);
    const execute = (name: string, params: Record<string, unknown>) =>
      tools
        .get(name)!
        .execute('parent-call', params, undefined, undefined, executeCtx);
    const spawn = async (name: string) => {
      const result = await execute('agent_spawn', {
        name,
        task: `${name} initial task.`,
        timeoutMs: 10000,
      });
      return (result.details as {agents: AgentRecord[]}).agents[0];
    };
    const receiver = await spawn('Receiver');
    const sender = await spawn('Sender');
    spawned.resolve();
    const wait = async () => {
      const result = await execute('agent_wait', {
        ids: [receiver.id, sender.id],
        timeoutMs: 10000,
      });
      assert.deepEqual(providerErrors, []);
      const agents = (result.details as {agents: AgentRecord[]}).agents;
      assert.deepEqual(
        agents.map(agent => agent.status),
        ['completed', 'completed'],
      );
      return agents;
    };
    const initial = await wait();
    assert.deepEqual(
      initial.map(agent => agent.output),
      [
        'Receiver handled the queued finding.',
        'Sender queued the peer finding.',
      ],
    );
    assert.deepEqual(parentMessages, [], 'Worker messages must not reach Pi');
    const inbox = (await execute('agent_inbox', {offset: 0, limit: 10}))
      .details as {
      total: number;
      offset: number;
      nextOffset?: number;
      messages: Array<{
        id: string;
        from: {id: string; name: string};
        createdAt: string;
        length: number;
        preview: string;
      }>;
    };
    assert.equal(inbox.total, 1);
    assert.equal(inbox.offset, 0);
    assert.equal(inbox.nextOffset, undefined);
    assert.equal(inbox.messages.length, 1);
    assert.equal(inbox.messages[0].id, parentInboxMessageId);
    assert.deepEqual(inbox.messages[0].from, {
      id: receiver.id,
      name: receiver.name,
    });
    assert.ok(Date.parse(inbox.messages[0].createdAt));
    assert.equal(inbox.messages[0].length, parentMessage.length);
    assert.equal(inbox.messages[0].preview, parentMessage);
    const fullInboxMessage = (
      await execute('agent_inbox', {messageId: parentInboxMessageId})
    ).details as {
      message: {
        id: string;
        from: {id: string; name: string};
        createdAt: string;
        message: string;
      };
    };
    assert.deepEqual(fullInboxMessage.message, {
      id: parentInboxMessageId,
      from: {id: receiver.id, name: receiver.name},
      createdAt: inbox.messages[0].createdAt,
      message: parentMessage,
    });

    await execute('agent_send', {
      id: sender.id,
      message: 'Send a second peer finding.',
    });
    const resumed = await wait();
    await events.get('agent_settled')?.({type: 'agent_settled'});
    assert.deepEqual(
      parentMessages,
      [],
      'Worker activity and completion must keep the parent session silent',
    );
    assert.deepEqual(
      (await execute('agent_inbox', {})).details,
      inbox,
      'Inbox reads must not consume stored messages',
    );
    assert.deepEqual(
      resumed.map(agent => agent.output),
      [
        'Receiver handled the second finding.',
        'Sender sent the second finding.',
      ],
    );
    assert.deepEqual(
      resumed.map(agent => agent.sessionFile),
      initial.map(agent => agent.sessionFile),
    );
    assert.equal(requests.Receiver.length, 5);
    assert.equal(requests.Sender.length, 6);
    assert.equal(
      await readFile(resumed[0].resultFile!, 'utf8'),
      'Receiver handled the second finding.',
    );
    assert.equal(
      await readFile(resumed[1].resultFile!, 'utf8'),
      'Sender sent the second finding.',
    );
    const transcript = await readFile(resumed[0].sessionFile!, 'utf8');
    const userMessages = transcript
      .trim()
      .split('\n')
      .map(
        line =>
          JSON.parse(line) as {message?: {role: string; content: unknown}},
      )
      .filter(entry => entry.message?.role === 'user')
      .map(entry => entry.message!.content);
    assert.equal(userMessages.length, 3);
    assert.match(JSON.stringify(userMessages[0]), /Receiver initial task/);
    assertSender(userMessages[1], queuedMessage);
    assertSender(userMessages[2], resumedMessage);
    assert.match(transcript, /Receiver initial task/);
    assert.match(transcript, /Receiver handled the queued finding/);
    assert.match(transcript, /Received the queued peer finding/);
    assert.match(transcript, /Receiver handled the second finding/);
  },
);

void test(
  'worker records retain isolated provider usage across followups, cancellation and cleanup',
  {timeout: 20000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-worker-usage-'));
    const cwd = join(directory, 'project');
    const agentDir = join(directory, 'config');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    const providerId = 'worker-usage-test';
    const manager = new AgentOrchestrator(1);
    const workers = new Map<string, AgentWorker>();
    const disposed = new Set<string>();
    const requests: string[] = [];
    const partial = Promise.withResolvers<void>();
    let heldResponse: ServerResponse | undefined;
    let disconnected = false;
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body) as ProviderRequest;
      const initial = JSON.stringify(
        input.messages.find(message => message.role === 'user')?.content,
      );
      requests.push(initial);
      if (
        initial.includes('worker-b') &&
        requests.filter(item => item === initial).length === 1
      ) {
        heldResponse = response;
        response.once('close', () => {
          disconnected = true;
        });
        response.writeHead(200, {'content-type': 'text/event-stream'});
        response.write(
          `data: ${JSON.stringify({
            id: 'partial-call',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'worker-model',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: 'Partial measured response',
                },
                finish_reason: null,
              },
            ],
            usage: {
              prompt_tokens: 200,
              completion_tokens: 15,
              total_tokens: 215,
              prompt_tokens_details: {
                cached_tokens: 50,
                cache_write_tokens: 10,
              },
            },
          })}\n\n`,
        );
      } else {
        if (initial.includes('worker-b'))
          assert.doesNotMatch(
            JSON.stringify(input.messages),
            /Discard queued scope/,
          );
        const count = requests.filter(item => item === initial).length;
        reply(
          response,
          `Completed ${initial} turn ${count}`,
          initial.includes('worker-c') ? 300 : count === 1 ? 100 : 150,
        );
      }
    });
    t.after(async () => {
      await manager.close();
      heldResponse?.destroy();
      server.closeAllConnections();
      registry.unregisterProvider(providerId);
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, {recursive: true, force: true});
    });
    await mkdir(join(cwd, '.git'), {recursive: true});
    await mkdir(agentDir, {recursive: true});
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({retry: {enabled: false}, compaction: {enabled: false}}),
    );
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    registry.registerProvider(providerId, {
      api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      apiKey: 'fixture-key',
      models: [
        {
          id: 'worker-model',
          name: 'Usage worker',
          reasoning: false,
          input: ['text'],
          cost: {input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0.3},
          contextWindow: 128000,
          maxTokens: 1000,
        },
      ],
    });
    const spawn = (name: string, autoCleanup = false) =>
      manager.spawn(
        {
          name,
          task: name,
          cwd,
          model: `${providerId}/worker-model`,
          autoCleanup,
        },
        async id => {
          const worker = await createSessionWorker({
            id,
            parentSessionId: 'usage-parent',
            cwd,
            name,
            model: registry.find(providerId, 'worker-model')!,
            modelRegistry: registry,
            thinkingLevel: 'off',
            agentToolsExtension: pi => {
              pi.on('message_update', event => {
                if (
                  name === 'worker-b' &&
                  event.message.role === 'assistant' &&
                  event.message.content.some(
                    part =>
                      part.type === 'text' &&
                      part.text.includes('Partial measured'),
                  )
                )
                  partial.resolve();
              });
            },
          });
          const dispose = worker.dispose.bind(worker);
          worker.dispose = () => {
            disposed.add(name);
            return dispose();
          };
          workers.set(name, worker);
          return worker;
        },
      );
    const a = spawn('worker-a');
    await manager.wait([a.id], {timeoutMs: 10000});
    assert.equal(manager.get(a.id).usage?.totalTokens, 110);
    await manager.send(a.id, 'Follow up using your history.');
    await manager.wait([a.id], {timeoutMs: 10000});
    const aUsage = manager.get(a.id).usage!;
    assert.equal(aUsage.calls.length, 2);
    assert.equal(aUsage.totalTokens, 270);
    assert.ok(Math.abs(aUsage.cost - 0.000473) < 1e-12);
    const b = spawn('worker-b');
    await partial.promise;
    const conversationDeadline = Date.now() + 5000;
    while (
      !manager
        .conversation(b.id)
        .conversation.some(
          message => message.text === 'Partial measured response',
        ) &&
      Date.now() < conversationDeadline
    )
      await delay(5);
    const partialMessage = manager
      .conversation(b.id)
      .conversation.find(message => message.role === 'assistant')!;
    assert.equal(partialMessage.text, 'Partial measured response');
    assert.equal(partialMessage.streaming, true);
    assert.equal(
      manager.get(b.id).usage?.calls.length,
      0,
      'stream updates do not bill a second call',
    );
    const c = spawn('worker-c', true);
    assert.equal(manager.get(c.id).status, 'queued');
    assert.equal(manager.get(c.id).usage, undefined);
    assert.equal(
      requests.some(item => item.includes('worker-c')),
      false,
      'queued local work sends no model request',
    );
    await manager.send(b.id, 'Discard queued scope');
    manager.cancel(b.id);
    const completed = await manager.wait([b.id, c.id], {timeoutMs: 10000});
    assert.deepEqual(
      completed.map(record => record.status),
      ['cancelled', 'completed'],
    );
    const bConversation = manager.conversation(b.id);
    const cancelledMessage = bConversation.conversation.find(
      message => message.role === 'assistant',
    )!;
    assert.equal(cancelledMessage.id, partialMessage.id);
    assert.equal(cancelledMessage.text, 'Partial measured response');
    assert.equal(cancelledMessage.streaming, false);
    assert.equal(manager.conversation(c.id).conversation[0].text, 'worker-c');
    assert.deepEqual(
      workers.get('worker-b')!.conversation,
      bConversation,
      'Cancelled text survives SDK disposal',
    );
    const bUsage = completed[0].usage!;
    assert.equal(bUsage.calls.length, 1);
    assert.equal(bUsage.calls[0].stopReason, 'aborted');
    assert.deepEqual(
      [
        bUsage.input,
        bUsage.output,
        bUsage.cacheRead,
        bUsage.cacheWrite,
        bUsage.totalTokens,
      ],
      [140, 15, 50, 10, 215],
    );
    assert.ok(Math.abs(bUsage.cost - 0.000353) < 1e-12);
    assert.equal(completed[1].usage?.totalTokens, 310);
    assert.deepEqual(
      manager.get(a.id).usage,
      aUsage,
      'another worker cancellation does not alter this worker',
    );
    assert.equal(disposed.has('worker-b'), false);
    assert.equal(disposed.has('worker-c'), true);
    assert.deepEqual(
      workers.get('worker-b')!.usage,
      bUsage,
      'usage survives SDK disposal',
    );
    const deadline = Date.now() + 5000;
    while (!disconnected && Date.now() < deadline) await delay(10);
    assert.ok(disconnected, 'cancelled provider stream disconnects');
    completed[0].usage!.calls[0].input = 9999;
    completed[0].usage!.calls[0].toolNames.push('mutated');
    const listed = manager.list();
    listed
      .find(record => record.id === b.id)!
      .usage!.calls[0].toolNames.push('mutated list');
    assert.equal(manager.get(b.id).usage!.input, 140);
    assert.deepEqual(manager.get(b.id).usage!.calls[0].toolNames, []);
    const now = new Date().toISOString();
    const dashboard = new DashboardState({
      id: 'usage-parent',
      cwd,
      name: 'Parent',
      status: 'idle',
      activity: 'Ready',
      startedAt: now,
      updatedAt: now,
    });
    dashboard.updateTeam(manager.list(), []);
    const projected = dashboard.snapshot();
    projected.agents
      .find(record => record.id === b.id)!
      .usage!.calls[0].toolNames.push('mutated dashboard');
    assert.deepEqual(
      dashboard.snapshot().agents.find(record => record.id === b.id)!.usage!
        .calls[0].toolNames,
      [],
    );
    await manager.send(b.id, 'Resume the retained SDK conversation');
    const [resumed] = await manager.wait([b.id], {timeoutMs: 10000});
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.resumable, true);
    assert.equal(
      resumed.sessionFile,
      b.sessionFile ?? workers.get('worker-b')!.sessionFile,
    );
    assert.equal(resumed.usage!.calls.length, 2);
    assert.equal(resumed.usage!.totalTokens, 375);
    assert.equal(disposed.has('worker-b'), false);
    assert.ok(
      manager
        .conversation(b.id)
        .conversation.some(
          message => message.text === 'Partial measured response',
        ),
    );
    await manager.close();
    assert.equal(disposed.has('worker-b'), true);
    assert.deepEqual(manager.get(a.id).usage, aUsage);
    assert.equal(manager.get(b.id).usage!.totalTokens, 375);
  },
);

void test(
  'retained SDK workers await /commit responses with the active workspace skill and agent configuration',
  {timeout: 15000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-worker-commit-'));
    const agentDir = join(directory, 'config');
    const cwd = join(directory, 'project');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(join(cwd, '.git'), {recursive: true});
    await mkdir(agentDir, {recursive: true});
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({retry: {enabled: false}, compaction: {enabled: false}}),
    );
    const providerId = 'worker-commit-test';
    const registry = new ModelRegistry(
      await ModelRuntime.create({
        authPath: join(agentDir, 'auth.json'),
        modelsPath: null,
        refreshOnCreate: false,
      }),
    );
    const manager = new AgentOrchestrator(1);
    const requests: ProviderRequest[] = [];
    const commitStarted = Promise.withResolvers<void>();
    const finishCommit = Promise.withResolvers<void>();
    const toolExecutions: string[] = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      if (requests.length === 1) {
        reply(response, 'Initial context retained.');
      } else {
        commitStarted.resolve();
        await finishCommit.promise;
        reply(response, 'Commit delegation response.');
      }
    });
    t.after(async () => {
      finishCommit.resolve();
      await manager.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      registry.unregisterProvider(providerId);
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, {recursive: true, force: true});
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    registry.registerProvider(providerId, {
      api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      apiKey: 'fixture-key',
      models: [
        {
          id: 'worker-model',
          name: 'Commit fixture',
          reasoning: true,
          input: ['text'],
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          contextWindow: 128000,
          maxTokens: 1000,
        },
      ],
    });
    await saveToolSettings('agents', {
      allowedModels: [`${providerId}/worker-model`],
    });
    await saveAgentTemplate(cwd, {
      scope: 'global',
      id: 'commit',
      name: 'Global commit',
      instructions: 'Global commit configuration.',
      thinkingLevel: 'high',
    });
    await saveAgentTemplate(cwd, {
      scope: 'workspace',
      id: 'commit',
      name: 'Workspace commit',
      instructions: 'Workspace commit configuration.',
      model: `${providerId}/worker-model`,
      thinkingLevel: 'low',
    });
    const skillDirectory = join(
      workspaceConfigPaths(cwd, agentDir).workspaceDir,
      'skills',
      'commit',
    );
    const skillPath = join(skillDirectory, 'SKILL.md');
    await mkdir(skillDirectory, {recursive: true});
    await writeFile(
      skillPath,
      '---\nname: commit\ndescription: Workspace commit workflow\n---\nActive workspace commit skill marker: read [guidance](guidance.md) before delegating.',
    );
    const {id} = manager.spawn(
      {
        name: 'Retained committer',
        task: 'Inspect the fixture.',
        cwd,
        model: `${providerId}/worker-model`,
        thinkingLevel: 'high',
      },
      id =>
        createSessionWorker({
          id,
          parentSessionId: 'commit-parent',
          cwd,
          name: 'Retained committer',
          model: registry.find(providerId, 'worker-model')!,
          modelRegistry: registry,
          thinkingLevel: 'high',
          agentToolsExtension: pi => {
            pi.on('tool_execution_start', event => {
              toolExecutions.push(event.toolName);
            });
          },
        }),
    );
    const [initial] = await manager.wait([id], {timeoutMs: 10000});
    assert.equal(initial.status, 'completed');
    assert.equal(initial.output, 'Initial context retained.');
    assert.ok(
      (await manager.features(id)).commands.some(
        command => command.name === 'commit' && command.source === 'extension',
      ),
    );

    await manager.send(id, '/commit Use the requested commit message.');
    await commitStarted.promise;
    await delay(20);
    assert.equal(
      manager.get(id).status,
      'running',
      'The command remains active until its model turn finishes',
    );
    assert.equal(manager.get(id).output, undefined);
    assert.equal(
      await readFile(initial.resultFile!, 'utf8'),
      'Initial context retained.',
    );
    const text = requests[1].messages.at(-1)!.content;
    const content =
      typeof text === 'string'
        ? text
        : (text as Array<{text?: string}>)
            .map(part => part.text ?? '')
            .join('\n');
    assert.match(content, /Active workspace commit skill marker/);
    assert.ok(content.includes(skillPath));
    assert.ok(
      content.includes(`References are relative to ${skillDirectory}.`),
    );
    assert.match(content, /Use the requested commit message/);
    const configuration = content.match(
      /Use these exact agent_spawn configuration arguments: (\{[^\n]+\})/,
    );
    assert.ok(configuration);
    assert.deepEqual(JSON.parse(configuration[1]), {
      template: 'workspace:commit',
      model: `${providerId}/worker-model`,
      thinkingLevel: 'low',
      autoCleanup: true,
    });
    assert.match(
      JSON.stringify(requests[1].messages),
      /Initial context retained/,
    );

    finishCommit.resolve();
    const [completed] = await manager.wait([id], {timeoutMs: 5000});
    assert.equal(completed.status, 'completed');
    assert.equal(completed.output, 'Commit delegation response.');
    assert.equal(completed.sessionFile, initial.sessionFile);
    assert.equal(completed.resumable, true);
    assert.equal(
      await readFile(completed.resultFile!, 'utf8'),
      'Commit delegation response.',
    );
    assert.deepEqual(toolExecutions, []);
    assert.equal(requests.length, 2);
    assert.equal(completed.usage!.calls.length, 2);
  },
);

void test(
  'worker profiles persist their prompt and policy snapshot, relay approval cancellation, and bound model steps',
  {timeout: 15000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-worker-profile-'));
    const agentDir = join(directory, 'config');
    const cwd = join(directory, 'project');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(join(cwd, '.pi'), {recursive: true});
    await mkdir(agentDir, {recursive: true});
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({retry: {enabled: false}, compaction: {enabled: false}}),
    );
    await writeFile(
      join(cwd, '.pi', 'SYSTEM.md'),
      'Default project base marker.',
    );
    await writeFile(join(cwd, 'AGENTS.md'), 'Retained project context marker.');
    await writeFile(join(cwd, 'context.txt'), 'Approved fixture contents.');
    const providerId = 'worker-profile-test';
    const registry = new ModelRegistry(
      await ModelRuntime.create({
        authPath: join(agentDir, 'auth.json'),
        modelsPath: null,
        refreshOnCreate: false,
      }),
    );
    const manager = new AgentOrchestrator(1);
    const requests: ProviderRequest[] = [];
    const providerErrors: unknown[] = [];
    const approvalStarted = Promise.withResolvers<void>();
    const approvals: Array<{
      title: string;
      message: string;
      signal?: AbortSignal;
    }> = [];
    const profile: AgentTemplate = {
      id: 'reviewer',
      key: 'workspace:reviewer',
      name: 'Scoped reviewer',
      instructions:
        'Profile base system marker: inspect this project carefully.',
      scope: 'workspace',
      sourcePath: join(directory, 'reviewer.md'),
      mode: 'all',
      context: 'workspace',
      hidden: false,
      disabled: false,
      color: '#abcdef',
      permissions: [
        {action: 'read', resource: '*', effect: 'ask'},
        {action: 'edit', resource: 'blocked.txt', effect: 'deny'},
      ],
    };
    const snapshot = structuredClone(profile);
    const server = createServer(async (request, response) => {
      try {
        let body = '';
        for await (const chunk of request) body += chunk;
        const input = JSON.parse(body) as ProviderRequest;
        requests.push(input);
        if (requests.length === 1 || requests.length === 4) {
          reply(response, {name: 'read', arguments: {path: 'context.txt'}});
        } else if (requests.length === 2) {
          assert.match(
            JSON.stringify(input.messages.at(-1)),
            /Approved fixture contents/,
          );
          reply(response, {
            name: 'write',
            arguments: {path: 'blocked.txt', content: 'Must not be written'},
          });
        } else if (requests.length === 3) {
          assert.match(
            JSON.stringify(input.messages.at(-1)),
            /Agent permission denied: edit .*blocked\.txt/,
          );
          reply(response, 'Profile inspection complete.');
        } else if (requests.length === 5) {
          reply(response, 'Profile conversation resumed.');
        } else {
          assert.equal(requests.length, 6);
          assert.equal(input.tools?.length ?? 0, 0);
          assert.match(
            JSON.stringify(input.messages),
            /final allowed model step/,
          );
          reply(response, 'Budget summary complete.');
        }
      } catch (error) {
        providerErrors.push(error);
        reply(response, `Profile fixture failed: ${String(error)}`);
      }
    });
    t.after(async () => {
      await manager.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      registry.unregisterProvider(providerId);
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, {recursive: true, force: true});
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    registry.registerProvider(providerId, {
      api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      apiKey: 'fixture-key',
      models: [
        {
          id: 'worker-model',
          name: 'Profile fixture',
          reasoning: false,
          input: ['text'],
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          contextWindow: 128000,
          maxTokens: 1000,
        },
      ],
    });
    await saveToolSettings('agents', {
      allowedModels: [`${providerId}/worker-model`],
    });
    const {id} = manager.spawn(
      {
        name: 'Approval worker',
        task: 'Inspect the fixture.',
        cwd,
        model: `${providerId}/worker-model`,
      },
      id => {
        const creating = createSessionWorker({
          id,
          parentSessionId: 'profile-parent',
          cwd,
          name: 'Approval worker',
          model: registry.find(providerId, 'worker-model')!,
          modelRegistry: registry,
          thinkingLevel: 'off',
          agentProfile: profile,
          instructions: 'Additional explicit spawn instructions marker.',
          approval: {
            hasUI: true,
            async confirm(title, message, options) {
              approvals.push({title, message, signal: options?.signal});
              if (approvals.length === 1) return true;
              approvalStarted.resolve();
              return new Promise<boolean>(resolve => {
                options?.signal?.addEventListener(
                  'abort',
                  () => resolve(false),
                  {once: true},
                );
              });
            },
          },
          agentToolsExtension: () => {},
        });
        profile.instructions = 'Mutated after worker creation';
        profile.permissions[0].effect = 'allow';
        return creating;
      },
    );
    const [completed] = await manager.wait([id], {timeoutMs: 10000});
    assert.deepEqual(providerErrors, []);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.output, 'Profile inspection complete.');
    assert.equal(approvals.length, 1);
    assert.match(approvals[0].title, /Approval worker/);
    assert.match(approvals[0].message, /read.*context.txt/);
    assert.ok(approvals[0].signal instanceof AbortSignal);
    await assert.rejects(readFile(join(cwd, 'blocked.txt')), {code: 'ENOENT'});
    const system = JSON.stringify(
      requests[0].messages.filter(message =>
        ['system', 'developer'].includes(message.role),
      ),
    );
    assert.equal(system.split(snapshot.instructions).length - 1, 1);
    assert.match(system, /Retained project context marker/);
    assert.match(system, /Additional explicit spawn instructions marker/);
    assert.doesNotMatch(
      system,
      /Default project base marker|Mutated after worker creation|You are an expert coding assistant/,
    );
    const entry = SessionManager.open(completed.sessionFile!)
      .getBranch()
      .find(
        entry =>
          entry.type === 'custom' &&
          entry.customType === 'varisdev.agent-profile',
      );
    assert.ok(entry?.type === 'custom');
    assert.deepEqual(entry.data, {...snapshot, permissionsVersion: 1});
    const features = await manager.features(id);
    assert.deepEqual(features.agentProfile, {
      id: snapshot.id,
      name: snapshot.name,
      mode: snapshot.mode,
      color: snapshot.color,
    });
    features.agentProfile!.name = 'Mutated feature accessor';
    assert.equal(
      (await manager.features(id)).agentProfile!.name,
      snapshot.name,
    );

    await manager.send(id, 'Inspect again with approval.');
    await approvalStarted.promise;
    await manager.abort(id);
    assert.equal(manager.get(id).status, 'cancelled');
    assert.equal(manager.get(id).resumable, true);
    assert.equal(approvals[1].signal?.aborted, true);
    await manager.send(id, 'Recover after approval cancellation.');
    const [resumed] = await manager.wait([id], {timeoutMs: 5000});
    assert.equal(resumed.output, 'Profile conversation resumed.');
    assert.equal(resumed.sessionFile, completed.sessionFile);
    await manager.reload(id);
    assert.deepEqual((await manager.features(id)).agentProfile, {
      id: snapshot.id,
      name: snapshot.name,
      mode: snapshot.mode,
      color: snapshot.color,
    });

    const budget = manager.spawn(
      {
        name: 'Budget worker',
        task: 'Summarize the fixture.',
        cwd,
        model: `${providerId}/worker-model`,
      },
      id =>
        createSessionWorker({
          id,
          parentSessionId: 'profile-parent',
          cwd,
          name: 'Budget worker',
          model: registry.find(providerId, 'worker-model')!,
          modelRegistry: registry,
          thinkingLevel: 'off',
          agentProfile: {
            ...snapshot,
            id: 'budget',
            key: 'workspace:budget',
            permissions: [],
            steps: 1,
          },
          agentToolsExtension: () => {},
        }),
    );
    const [summary] = await manager.wait([budget.id], {timeoutMs: 5000});
    assert.deepEqual(providerErrors, []);
    assert.equal(summary.output, 'Budget summary complete.');
    assert.equal(summary.usage!.calls.length, 1);
    assert.equal(requests.length, 6);
  },
);

void test(
  'task context excludes parent history and automatic workspace resources while retaining explicit instructions and tools',
  {timeout: 15000},
  async t => {
    const directory = await mkdtemp(
      join(tmpdir(), 'varisdev-worker-task-context-'),
    );
    const agentDir = join(directory, 'config');
    const cwd = join(directory, 'project');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(join(cwd, '.git'), {recursive: true});
    await mkdir(join(cwd, '.pi'), {recursive: true});
    await mkdir(agentDir, {recursive: true});
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({retry: {enabled: false}, compaction: {enabled: false}}),
    );
    const workspaceDir = workspaceConfigPaths(cwd, agentDir).workspaceDir;
    await mkdir(workspaceDir, {recursive: true});
    for (const [root, scope] of [
      [agentDir, 'GLOBAL'],
      [join(cwd, '.pi'), 'REPOSITORY'],
      [workspaceDir, 'WORKSPACE'],
    ]) {
      await writeFile(
        join(root, 'AGENTS.md'),
        `UNRELATED_${scope}_AGENTS_SENTINEL`,
      );
      await writeFile(
        join(root, 'SYSTEM.md'),
        `UNRELATED_${scope}_SYSTEM_SENTINEL`,
      );
      await writeFile(
        join(root, 'APPEND_SYSTEM.md'),
        `UNRELATED_${scope}_APPEND_SENTINEL`,
      );
      const skillDir = join(root, 'skills', `unrelated-${scope.toLowerCase()}`);
      await mkdir(skillDir, {recursive: true});
      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---\nname: unrelated-${scope.toLowerCase()}\ndescription: UNRELATED_${scope}_SKILL_SENTINEL\n---\nUnrelated skill instructions.`,
      );
      await mkdir(join(root, 'prompts'), {recursive: true});
      await writeFile(
        join(root, 'prompts', `unrelated-${scope.toLowerCase()}.md`),
        `---\ndescription: UNRELATED_${scope}_PROMPT_SENTINEL\n---\nUnrelated prompt instructions.`,
      );
    }
    await writeFile(
      join(cwd, 'AGENTS.md'),
      'UNRELATED_PROJECT_AGENTS_SENTINEL',
    );
    const parentSession = SessionManager.create(cwd);
    parentSession.appendMessage({
      role: 'user',
      content: 'PARENT_TRANSCRIPT_SENTINEL',
      timestamp: Date.now(),
    });
    const providerId = 'worker-task-context-test';
    const registry = new ModelRegistry(
      await ModelRuntime.create({
        authPath: join(agentDir, 'auth.json'),
        modelsPath: null,
        refreshOnCreate: false,
      }),
    );
    const requests: ProviderRequest[] = [];
    const workers: AgentWorker[] = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      reply(response, `Task context answer ${requests.length}`);
    });
    t.after(async () => {
      await Promise.all(workers.map(worker => worker.dispose()));
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      registry.unregisterProvider(providerId);
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, {recursive: true, force: true});
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    registry.registerProvider(providerId, {
      api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      apiKey: 'fixture-key',
      models: [
        {
          id: 'worker-model',
          name: 'Task fixture',
          reasoning: false,
          input: ['text'],
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          contextWindow: 128000,
          maxTokens: 1000,
        },
      ],
    });
    await saveToolSettings('agents', {
      allowedModels: [`${providerId}/worker-model`],
    });
    const profile: AgentTemplate = {
      id: 'task-reviewer',
      key: 'workspace:task-reviewer',
      name: 'Task reviewer',
      instructions: 'TASK_PROFILE_BASE_SENTINEL: report on the assigned task.',
      mode: 'subagent',
      context: 'task',
      hidden: false,
      disabled: false,
      permissions: [
        {action: 'edit', resource: '*', effect: 'deny'},
        {action: 'shell', resource: '*', effect: 'deny'},
        {action: 'subagent', resource: '*', effect: 'deny'},
      ],
      scope: 'workspace',
      sourcePath: join(workspaceDir, 'agents', 'task-reviewer.md'),
    };
    const create = async (
      id: string,
      context?: 'task' | 'workspace',
      agentProfile: AgentTemplate | null = profile,
    ) => {
      const worker = await createSessionWorker({
        id,
        parentSessionId: parentSession.getSessionId(),
        cwd,
        name: 'Task reviewer',
        model: registry.find(providerId, 'worker-model')!,
        modelRegistry: registry,
        thinkingLevel: 'off',
        agentProfile: agentProfile ?? undefined,
        context,
        instructions: 'EXPLICIT_TASK_INSTRUCTIONS_SENTINEL',
        projectTrustOverride: true,
        agentToolsExtension: () => {},
      });
      workers.push(worker);
      return worker;
    };
    const task = await create('task-scope');
    await task.run(
      'TASK_USER_MESSAGE_SENTINEL',
      AbortSignal.timeout(5000),
      () => {},
    );
    const taskInput = JSON.stringify(requests[0].messages);
    assert.equal(taskInput.split(profile.instructions).length - 1, 1);
    assert.match(taskInput, /EXPLICIT_TASK_INSTRUCTIONS_SENTINEL/);
    assert.match(taskInput, /TASK_USER_MESSAGE_SENTINEL/);
    assert.equal(
      taskInput.includes('Agent \\"Task reviewer\\" (task-scope).'),
      false,
    );
    assert.doesNotMatch(
      taskInput,
      /You are delegated|You are an expert coding assistant|Your final answer should|Send blockers or progress|Do not duplicate the final answer/,
    );
    assert.doesNotMatch(taskInput, /PARENT_TRANSCRIPT_SENTINEL|UNRELATED_/);
    assert.doesNotMatch(
      taskInput,
      /coordinate file ownership|reads its inbox|Shared working directory|Other agents share this directory|Other agents may edit files/,
    );
    assert.ok(requests[0].tools.some(tool => tool.function.name === 'read'));
    assert.equal(requests[0].model, 'worker-model');
    const taskFeatures = await task.features!();
    assert.equal(
      taskFeatures.commands.some(
        command => command.source === 'skill' || command.source === 'prompt',
      ),
      false,
    );
    assert.doesNotMatch(
      JSON.stringify(taskFeatures.contextFiles),
      /UNRELATED_/,
    );
    const persisted = SessionManager.open(task.sessionFile!)
      .getBranch()
      .find(
        entry =>
          entry.type === 'custom' &&
          entry.customType === 'varisdev.agent-context',
      );
    assert.ok(persisted?.type === 'custom');
    assert.deepEqual(persisted.data, {scope: 'task'});

    await task.reload!();
    await task.run(
      'Continue the assigned task.',
      AbortSignal.timeout(5000),
      () => {},
    );
    assert.doesNotMatch(
      JSON.stringify(requests[1].messages),
      /PARENT_TRANSCRIPT_SENTINEL|UNRELATED_/,
    );
    assert.match(
      JSON.stringify(requests[1].messages),
      /TASK_USER_MESSAGE_SENTINEL/,
    );
    assert.equal(
      JSON.stringify(requests[1].messages).split(profile.instructions).length -
        1,
      1,
    );

    const workspace = await create('workspace-override', 'workspace');
    await workspace.run(
      'Check explicit workspace context.',
      AbortSignal.timeout(5000),
      () => {},
    );
    const workspaceInput = JSON.stringify(requests[2].messages);
    assert.match(workspaceInput, /UNRELATED_PROJECT_AGENTS_SENTINEL/);
    assert.match(workspaceInput, /UNRELATED_WORKSPACE_AGENTS_SENTINEL/);
    assert.doesNotMatch(
      workspaceInput,
      /PARENT_TRANSCRIPT_SENTINEL|TASK_USER_MESSAGE_SENTINEL/,
    );
    assert.equal(workspaceInput.split(profile.instructions).length - 1, 1);
    assert.ok(
      (await workspace.features!()).commands.some(
        command =>
          command.name === 'unrelated-workspace' && command.source === 'prompt',
      ),
    );
    const override = SessionManager.open(workspace.sessionFile!)
      .getBranch()
      .find(
        entry =>
          entry.type === 'custom' &&
          entry.customType === 'varisdev.agent-context',
      );
    assert.ok(override?.type === 'custom');
    assert.deepEqual(override.data, {scope: 'workspace'});
    assert.deepEqual(
      requests[2].tools.map(tool => tool.function.name),
      requests[0].tools.map(tool => tool.function.name),
    );

    const explicitTask = await create('task-override', 'task', {
      ...profile,
      context: 'workspace',
    });
    await explicitTask.run(
      'Use explicit task context.',
      AbortSignal.timeout(5000),
      () => {},
    );
    assert.doesNotMatch(
      JSON.stringify(requests[3].messages),
      /PARENT_TRANSCRIPT_SENTINEL|UNRELATED_/,
    );
    assert.equal(
      JSON.stringify(requests[3].messages).split(profile.instructions).length -
        1,
      1,
    );

    const defaultWorker = await create('default-task', 'task', null);
    assert.deepEqual((await defaultWorker.features!()).agentProfile, {
      id: 'default',
      name: 'Default',
      mode: 'all',
    });
    await defaultWorker.run(
      'Answer this task with the Default agent.',
      AbortSignal.timeout(5000),
      () => {},
    );
    const defaultSystem = JSON.stringify(
      requests[4].messages.filter(message =>
        ['system', 'developer'].includes(message.role),
      ),
    );
    assert.equal(
      defaultSystem.includes('Agent \\"Task reviewer\\" (default-task).'),
      false,
    );
    assert.doesNotMatch(
      defaultSystem,
      /Other agents may edit files in this working directory\./,
    );
    assert.match(defaultSystem, /EXPLICIT_TASK_INSTRUCTIONS_SENTINEL/);
    const defaultProfile = SessionManager.open(defaultWorker.sessionFile!)
      .getBranch()
      .find(
        entry =>
          entry.type === 'custom' &&
          entry.customType === 'varisdev.agent-profile',
      );
    assert.ok(defaultProfile?.type === 'custom');
    assert.equal((defaultProfile.data as AgentTemplate).key, 'builtin:default');
    assert.equal((defaultProfile.data as AgentTemplate).instructions, '');
    assert.doesNotMatch(
      defaultSystem,
      /TASK_PROFILE_BASE_SENTINEL|PARENT_TRANSCRIPT_SENTINEL|UNRELATED_|You are delegated|Complete the task using its instructions|Your final answer should report|Send blockers or progress|reads its inbox|Do not duplicate the final answer/,
    );

    await saveAgentTemplate(cwd, {
      scope: 'workspace',
      id: 'default',
      name: 'Local default',
      mode: 'all',
      context: 'task',
      instructions: 'SELECTED_DEFAULT_PROFILE_SENTINEL',
    });
    const configuredDefault = await create(
      'configured-default',
      undefined,
      null,
    );
    assert.deepEqual((await configuredDefault.features!()).agentProfile, {
      id: 'default',
      name: 'Local default',
      mode: 'all',
    });
    await configuredDefault.run(
      'Use the configured Default agent.',
      AbortSignal.timeout(5000),
      () => {},
    );
    const configuredSystem = JSON.stringify(requests[5].messages);
    assert.equal(
      configuredSystem.split('SELECTED_DEFAULT_PROFILE_SENTINEL').length - 1,
      1,
    );
    assert.doesNotMatch(
      configuredSystem,
      /PARENT_TRANSCRIPT_SENTINEL|UNRELATED_|TASK_PROFILE_BASE_SENTINEL/,
    );
    const configuredSnapshot = SessionManager.open(
      configuredDefault.sessionFile!,
    )
      .getBranch()
      .find(
        entry =>
          entry.type === 'custom' &&
          entry.customType === 'varisdev.agent-profile',
      );
    assert.ok(configuredSnapshot?.type === 'custom');
    assert.equal(
      (configuredSnapshot.data as AgentTemplate).key,
      'workspace:default',
    );
    assert.equal(
      (configuredSnapshot.data as AgentTemplate).instructions,
      'SELECTED_DEFAULT_PROFILE_SENTINEL',
    );
  },
);

void test(
  'worker skill policies hide denied discovery, gate explicit commands and reads, and cancel approval preflight',
  {timeout: 15000},
  async t => {
    const directory = await mkdtemp(
      join(tmpdir(), 'varisdev-worker-skill-policy-'),
    );
    const agentDir = join(directory, 'config');
    const cwd = join(directory, 'project');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(join(cwd, '.git'), {recursive: true});
    await mkdir(agentDir, {recursive: true});
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({retry: {enabled: false}, compaction: {enabled: false}}),
    );
    const skillPaths = new Map<string, string>();
    for (const name of ['approved', 'blocked']) {
      const skillDirectory = join(agentDir, 'skills', name);
      await mkdir(skillDirectory, {recursive: true});
      const path = join(skillDirectory, 'SKILL.md');
      skillPaths.set(name, path);
      await writeFile(
        path,
        `---\nname: ${name}\ndescription: ${name.toUpperCase()}_SKILL_DISCOVERY_SENTINEL\n---\n${name.toUpperCase()}_SKILL_BODY_SENTINEL`,
      );
    }
    const providerId = 'worker-skill-policy-test';
    const registry = new ModelRegistry(
      await ModelRuntime.create({
        authPath: join(agentDir, 'auth.json'),
        modelsPath: null,
        refreshOnCreate: false,
      }),
    );
    const requests: ProviderRequest[] = [];
    const providerErrors: unknown[] = [];
    const approvalStarted = Promise.withResolvers<void>();
    const approvals: Array<{
      title: string;
      message: string;
      signal?: AbortSignal;
    }> = [];
    let worker: AgentWorker | undefined;
    const server = createServer(async (request, response) => {
      try {
        let body = '';
        for await (const chunk of request) body += chunk;
        const input = JSON.parse(body) as ProviderRequest;
        requests.push(input);
        assert.doesNotMatch(
          JSON.stringify(input.messages),
          /BLOCKED_SKILL_DISCOVERY_SENTINEL|BLOCKED_SKILL_BODY_SENTINEL/,
        );
        if (requests.length === 2) {
          reply(response, {
            name: 'read',
            arguments: {path: skillPaths.get('blocked')!},
          });
        } else if (requests.length === 3) {
          assert.match(
            JSON.stringify(input.messages.at(-1)),
            /skill.*blocked.*denied|denied.*skill.*blocked/i,
          );
          reply(response, 'Blocked skill read prevented.');
        } else {
          assert.match(
            JSON.stringify(input.messages.at(-1)),
            /APPROVED_SKILL_BODY_SENTINEL/,
          );
          reply(response, 'Approved skill response.');
        }
      } catch (error) {
        providerErrors.push(error);
        reply(response, `Skill policy fixture failed: ${String(error)}`);
      }
    });
    t.after(async () => {
      await worker?.dispose();
      worker = undefined;
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      registry.unregisterProvider(providerId);
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, {recursive: true, force: true});
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    registry.registerProvider(providerId, {
      api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      apiKey: 'fixture-key',
      models: [
        {
          id: 'worker-model',
          name: 'Skill fixture',
          reasoning: false,
          input: ['text'],
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          contextWindow: 128000,
          maxTokens: 1000,
        },
      ],
    });
    await saveToolSettings('agents', {
      allowedModels: [`${providerId}/worker-model`],
    });
    worker = await createSessionWorker({
      id: 'skill-worker',
      parentSessionId: 'skill-parent',
      cwd,
      name: 'Skill worker',
      model: registry.find(providerId, 'worker-model')!,
      modelRegistry: registry,
      thinkingLevel: 'off',
      agentProfile: {
        id: 'skill-policy',
        key: 'workspace:skill-policy',
        name: 'Skill policy',
        instructions: '',
        mode: 'all',
        context: 'workspace',
        hidden: false,
        disabled: false,
        permissions: [
          {action: 'skill', resource: 'blocked', effect: 'deny'},
          {action: 'skill', resource: 'approved', effect: 'ask'},
        ],
        scope: 'workspace',
        sourcePath: join(directory, 'skill-policy.md'),
      },
      approval: {
        hasUI: true,
        async confirm(title, message, options) {
          approvals.push({title, message, signal: options?.signal});
          if (approvals.length !== 2) return true;
          approvalStarted.resolve();
          return new Promise<boolean>(resolve => {
            options?.signal?.addEventListener('abort', () => resolve(false), {
              once: true,
            });
          });
        },
      },
      agentToolsExtension: () => {},
    });
    const features = await worker.features!();
    assert.equal(
      features.commands.some(command => command.name === 'skill:blocked'),
      false,
    );
    assert.ok(
      features.commands.some(command => command.name === 'skill:approved'),
    );
    assert.doesNotMatch(
      JSON.stringify(features.contextFiles),
      /BLOCKED_SKILL_DISCOVERY_SENTINEL/,
    );
    await assert.rejects(
      worker.run('/skill:blocked', AbortSignal.timeout(5000), () => {}),
      /denied.*skill.*blocked|skill.*blocked.*denied/i,
    );
    assert.equal(requests.length, 0);
    assert.equal(approvals.length, 0);
    assert.equal(
      await worker.run('/skill:approved', AbortSignal.timeout(5000), () => {}),
      'Approved skill response.',
    );
    assert.equal(approvals.length, 1);
    assert.match(approvals[0].title, /Skill worker/);
    assert.match(approvals[0].message, /skill.*approved/);
    assert.ok(approvals[0].signal instanceof AbortSignal);
    assert.equal(
      await worker.run(
        'Read the blocked skill file.',
        AbortSignal.timeout(5000),
        () => {},
      ),
      'Blocked skill read prevented.',
    );
    assert.deepEqual(providerErrors, []);

    const controller = new AbortController();
    const running = worker.run('/skill:approved', controller.signal, () => {});
    await approvalStarted.promise;
    controller.abort(new Error('Cancel skill approval'));
    await assert.rejects(running, /Cancel skill approval/);
    assert.equal(approvals[1].signal?.aborted, true);
    assert.equal(requests.length, 3);
    await worker.reload!();
    await assert.rejects(
      worker.run('/skill:blocked', AbortSignal.timeout(5000), () => {}),
      /denied.*skill.*blocked|skill.*blocked.*denied/i,
    );
    assert.equal(
      requests.length,
      3,
      'Denied input cannot return a stale assistant result or start a model turn',
    );
    assert.equal(
      await worker.run('/skill:approved', AbortSignal.timeout(5000), () => {}),
      'Approved skill response.',
    );
    assert.deepEqual(providerErrors, []);
    assert.equal(requests.length, 4);
  },
);
