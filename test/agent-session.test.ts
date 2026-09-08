import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {AuthStorage, ModelRegistry} from '@earendil-works/pi-coding-agent';
import {createSessionWorker} from '../src/agents/session.ts';
import type {AgentWorker} from '../src/agents/orchestrator.ts';

void test(
  'Pi workers load project tools and instructions, execute tools, and persist follow-up conversations',
  {timeout: 15000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-worker-sdk-'));
    const agentDir = join(directory, 'config');
    const cwd = join(directory, 'project');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    const requests: Array<{
      messages: Array<{role: string; content: unknown}>;
      tools: Array<{function: {name: string}}>;
    }> = [];
    const server = createServer(async (request, response) => {
      try {
        let body = '';
        for await (const chunk of request) body += chunk;
        requests.push(JSON.parse(body));
        const toolCall = requests.length === 1;
        const delta = toolCall
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_read',
                  type: 'function',
                  function: {
                    name: 'read',
                    arguments: JSON.stringify({path: 'context.txt'}),
                  },
                },
              ],
            }
          : {role: 'assistant', content: `Final answer ${requests.length}`};
        response.writeHead(200, {'content-type': 'text/event-stream'});
        response.end(
          `data: ${JSON.stringify({
            id: 'completion',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'worker-model',
            choices: [
              {
                index: 0,
                delta,
                finish_reason: toolCall ? 'tool_calls' : 'stop',
              },
            ],
          })}\n\ndata: [DONE]\n\n`,
        );
      } catch (error) {
        response.writeHead(500);
        response.end(String(error));
      }
    });
    let worker: AgentWorker | undefined;
    t.after(async () => {
      worker?.dispose();
      worker = undefined;
      registry.unregisterProvider('varisdev-agent-test');
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, {recursive: true, force: true});
    });
    await mkdir(cwd, {recursive: true});
    await writeFile(
      join(cwd, 'AGENTS.md'),
      'Project instruction marker: report every finding.',
    );
    await writeFile(
      join(cwd, 'context.txt'),
      'Fixture contents from the worker directory.',
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    registry.registerProvider('varisdev-agent-test', {
      api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      apiKey: 'local-test-key',
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
    worker = await createSessionWorker({
      id: 'worker-id',
      parentSessionId: 'parent-id',
      cwd,
      name: 'SDK worker',
      instructions: 'Worker instruction marker: inspect the fixture.',
      model: registry.find('varisdev-agent-test', 'worker-model')!,
      modelRegistry: registry,
      thinkingLevel: 'off',
    });
    const activity: string[] = [];
    assert.equal(
      await worker.run(
        'Read context.txt and report.',
        AbortSignal.timeout(5000),
        item => activity.push(item),
      ),
      'Final answer 2',
    );
    assert.ok(activity.includes('Using read'));
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
    assert.match(
      JSON.stringify(
        requests[1].messages.filter(message => message.role === 'tool'),
      ),
      /Fixture contents from the worker directory/,
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
    assert.equal(await readFile(worker.resultFile!, 'utf8'), 'Final answer 3');
    const transcript = await readFile(worker.sessionFile!, 'utf8');
    assert.match(transcript, /Fixture contents from the worker directory/);
    assert.match(transcript, /Summarize your previous answer/);
  },
);
