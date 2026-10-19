import assert from 'node:assert/strict';
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import sharp from 'sharp';
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxToolCall,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import {getCurrentTools} from '@earendil-works/pi-ai/utils/transcript';
import {ModelRegistry, ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createDashboardParent} from '../src/dashboard/parent.ts';
import type {DashboardParent} from '../src/dashboard/hub.ts';
import type {ConversationMessage} from '../src/conversation.ts';
import {loadPluginThemes} from '../src/desktop/plugin-themes.ts';
import {saveToolSettings} from '../src/tools/settings.ts';

async function until(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), description);
}

function assertBoard(
  message: ConversationMessage | undefined,
  imagePath?: string,
) {
  assert.ok(message, 'The installed plugin produced a conversation message');
  assert.equal(message.visualizationErrors, undefined);
  assert.deepEqual(
    message.visualizations?.map(block => block.type),
    imagePath ? ['progress', 'markdown', 'image'] : ['progress', 'markdown'],
  );
  assert.deepEqual(message.visualizations?.[0], {
    type: 'progress',
    value: 1,
    total: 2,
    label: 'Tasks complete',
  });
  assert.deepEqual(message.visualizations?.[1], {
    type: 'markdown',
    text: '# Project plan\n\n- [x] Load the plugin\n- [ ] Review its board\n',
  });
  if (imagePath) {
    const image = message.visualizations?.[2];
    assert.equal(image?.type, 'image');
    if (image?.type === 'image') {
      assert.equal(image.path, imagePath);
      assert.equal(image.label, 'Project preview');
      assert.ok(image.id, 'Images receive an opaque transport ID');
    }
  }
}

void test(
  'installed project-board plugin renders command and tool metadata in real parent and agent SDK conversations and exposes its theme',
  {timeout: 20000},
  async t => {
    const root = await mkdtemp(
      join(tmpdir(), 'varisdev-plugin-visualizations-'),
    );
    const agentDir = join(root, 'user');
    const cwd = join(root, 'project');
    const packageName = 'varisdev-project-board-example';
    const installed = join(agentDir, 'npm', 'node_modules', packageName);
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const resources: {parent?: DashboardParent; registry?: ModelRegistry} = {};
    const providerId = 'project-board-fixture';
    t.after(async () => {
      await resources.parent?.close();
      resources.registry?.unregisterProvider(providerId);
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, {recursive: true, force: true});
    });
    await mkdir(join(cwd, '.git'), {recursive: true});
    await mkdir(agentDir, {recursive: true});
    await cp(
      fileURLToPath(new URL('../examples/project-board/', import.meta.url)),
      installed,
      {recursive: true},
    );
    const settingsPath = join(agentDir, 'settings.json');
    const settings = JSON.stringify({
      packages: [`npm:${packageName}`],
      retry: {enabled: false},
    });
    await writeFile(settingsPath, settings);
    await saveToolSettings('agents', {
      allowedModels: [`${providerId}/board-model`],
    });
    await writeFile(
      join(cwd, 'PLAN.md'),
      '# Project plan\n\n- [x] Load the plugin\n- [ ] Review its board\n',
    );
    const imagePath = join(cwd, 'preview.png');
    await sharp({
      create: {width: 8, height: 6, channels: 4, background: '#aaccee'},
    })
      .png()
      .toFile(imagePath);
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    resources.registry = registry;
    const turns: Array<{worker: boolean; toolNames: string[]}> = [];
    registry.registerProvider(providerId, {
      api: 'openai-completions',
      baseUrl: 'https://example.invalid',
      apiKey: 'local-fixture-key',
      models: [
        {
          id: 'board-model',
          name: 'Local board fixture',
          reasoning: false,
          input: ['text'],
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          contextWindow: 32000,
          maxTokens: 1000,
        },
      ],
      streamSimple(model, context: TranscriptContext) {
        const tools = getCurrentTools(context.messages);
        const worker = context.messages.some(
          message =>
            message.role === 'user' &&
            JSON.stringify(message.content).includes(
              'Show project_board with PLAN.md and preview.png.',
            ),
        );
        const toolNames = tools.map(tool => tool.name);
        turns.push({worker, toolNames});
        const userIndex = context.messages.findLastIndex(
          message => message.role === 'user',
        );
        const prompt = JSON.stringify(context.messages[userIndex]);
        const hasResult = context.messages
          .slice(userIndex + 1)
          .some(message => message.role === 'toolResult');
        const content = hasResult
          ? 'The project board is ready.'
          : !worker && prompt.includes('spawn-board-agent')
            ? fauxToolCall('agent_spawn', {
                name: 'Board agent',
                task: 'Show project_board with PLAN.md and preview.png.',
              })
            : fauxToolCall('project_board', {
                path: 'PLAN.md',
                image: 'preview.png',
              });
        const message = {
          ...fauxAssistantMessage(content, {
            stopReason: hasResult ? 'stop' : 'toolUse',
          }),
          api: model.api,
          model: model.id,
          provider: model.provider,
        };
        const stream = createAssistantMessageEventStream();
        stream.push({type: 'start', partial: message});
        stream.push({
          type: 'done',
          reason: message.stopReason as 'stop' | 'toolUse',
          message,
        });
        return stream;
      },
    });
    const parent = await createDashboardParent(
      {cwd, name: 'Plugin parent'},
      {
        model: registry.find(providerId, 'board-model')!,
        modelRegistry: registry,
        thinkingLevel: 'off',
      },
    );
    resources.parent = parent;
    const features = await parent.features();
    assert.ok(
      features.tools.some(tool => tool.name === 'project_board'),
      'The registered installed package loads its tool',
    );
    assert.ok(
      features.commands.some(command => command.name === 'project-board'),
      'The registered installed package loads its command',
    );
    await parent.prompt('/project-board');
    assert.equal(
      turns.length,
      0,
      'A displayed custom command requires no provider call',
    );
    assertBoard(
      parent.state
        .snapshot()
        .conversation.find(message =>
          message.text.includes('PLAN.md: 1/2 tasks complete.'),
        ),
    );
    await parent.prompt('Show the project board with its preview.');
    const toolMessage = parent.state
      .snapshot()
      .conversation.find(message => message.toolName === 'project_board');
    assert.equal(toolMessage?.status, 'completed');
    assertBoard(toolMessage, imagePath);
    await parent.prompt('spawn-board-agent to show the same project board.');
    const spawned = parent.state
      .snapshot()
      .conversation.findLast(message => message.toolName === 'agent_spawn');
    assert.equal(spawned?.status, 'completed', JSON.stringify(spawned));
    await until(
      () =>
        parent.state
          .snapshot()
          .agents.some(
            agent =>
              agent.name === 'Board agent' &&
              ['completed', 'failed'].includes(agent.status),
          ),
      'The real SDK agent finishes its installed plugin tool',
    );
    const agent = parent.state
      .snapshot()
      .agents.find(agent => agent.name === 'Board agent')!;
    assert.equal(agent.status, 'completed', agent.error);
    const agentTool = agent.conversation?.find(
      message => message.toolName === 'project_board',
    );
    assert.equal(agentTool?.status, 'completed', JSON.stringify(agentTool));
    assertBoard(agentTool, imagePath);
    assert.ok(
      turns.some(
        turn => turn.worker && turn.toolNames.includes('project_board'),
      ),
      'Agents load the installed plugin through their SDK resource loader',
    );
    const themes = await loadPluginThemes({cwd, agentDir});
    assert.deepEqual(themes.errors, []);
    assert.equal(themes.themes.length, 1);
    const theme = themes.themes[0];
    assert.equal(theme.id, `plugin:${packageName}:ink`);
    assert.equal(theme.name, 'Ink');
    assert.equal(theme.packageName, packageName);
    assert.equal(theme.base, 'nord');
    assert.equal(theme.colors.mint, '#a0f0d0');
    assert.match(theme.css ?? '', /\.conversation-entry\s*\{/);
    assert.equal(
      await readFile(settingsPath, 'utf8'),
      settings,
      'Loading plugin conversations and themes preserves the installed registration',
    );
  },
);
