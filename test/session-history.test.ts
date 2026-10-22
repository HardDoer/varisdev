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
import {test} from 'node:test';
import {
  ProjectTrustStore,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import {DashboardHub} from '../src/dashboard/hub.ts';
import {createDashboardParent} from '../src/dashboard/parent.ts';

for (const extensionProvider of [false, true])
  void test(
    `folder history restores the session, model and full large conversation${extensionProvider ? ' after compaction with an extension provider' : ''}`,
    {timeout: 20000},
    async t => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), 'varisdev-history-')),
      );
      const cwd = join(root, 'project');
      const other = join(root, 'other');
      const agentDir = join(root, 'agent');
      const previous = process.env.PI_CODING_AGENT_DIR;
      const title = process.title;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      let creations = 0;
      const hub = new DashboardHub(undefined, request => {
        creations++;
        return createDashboardParent(request);
      });
      t.after(async () => {
        await hub.close();
        process.title = title;
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        await rm(root, {recursive: true, force: true});
      });
      await Promise.all([cwd, other, agentDir].map(path => mkdir(path)));
      await writeFile(
        join(agentDir, 'settings.json'),
        JSON.stringify({
          defaultProvider: 'history-fixture',
          defaultModel: 'default-model',
          defaultThinkingLevel: 'low',
          retry: {enabled: false},
        }),
      );
      await writeFile(
        join(agentDir, 'models.json'),
        JSON.stringify({
          providers: {
            'history-fixture': {
              api: 'openai-completions',
              apiKey: 'fixture-key',
              baseUrl: 'https://history.invalid/v1',
              models: (extensionProvider
                ? ['default-model']
                : ['saved-model', 'default-model']
              ).map(id => ({
                id,
                reasoning: true,
              })),
            },
          },
        }),
      );
      if (extensionProvider) {
        const extensions = join(cwd, '.pi', 'extensions');
        await mkdir(extensions, {recursive: true});
        await writeFile(
          join(extensions, 'provider.js'),
          `export default pi => {
        pi.registerProvider('history-fixture', {
          api: 'openai-completions', apiKey: 'fixture-key',
          baseUrl: 'https://history.invalid/v1',
          models: [{id: 'saved-model', name: 'Saved model', reasoning: true,
            input: ['text'], contextWindow: 64000, maxTokens: 1000,
            cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}],
        });
      };`,
        );
      }
      new ProjectTrustStore(agentDir).set(cwd, true);
      const usage = {
        input: 10,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 20,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
      };
      function save(folder: string, name: string, timestamp: number) {
        const manager = SessionManager.create(folder);
        manager.appendModelChange('history-fixture', 'saved-model');
        manager.appendThinkingLevelChange('high');
        manager.appendSessionInfo(name);
        manager.appendMessage({
          role: 'user',
          content: 'Remember the blue door',
          timestamp,
        });
        manager.appendMessage({
          role: 'assistant',
          content: [{type: 'text', text: 'The door is blue.'}],
          api: 'openai-completions',
          provider: 'history-fixture',
          model: 'saved-model',
          stopReason: 'stop',
          usage,
          timestamp: timestamp + 1,
        });
        return manager;
      }
      const older = save(cwd, 'Older work', 1000);
      const saved = save(cwd, 'Current work', 2000);
      const longUser = 'Saved user text\n'.repeat(2000);
      const longAssistant = 'Saved assistant text\n'.repeat(2000);
      const longResult = 'Saved tool failure\n'.repeat(2000);
      const arguments_ = {
        path: 'history.txt',
        content: 'Full saved arguments\n'.repeat(2000),
      };
      const expected: Array<[string, string]> = [
        ['user', 'Remember the blue door'],
        ['assistant', 'The door is blue.'],
        ['user', longUser],
        ['assistant', longAssistant],
        ['tool', longResult],
      ];
      saved.appendMessage({role: 'user', content: longUser, timestamp: 2010});
      saved.appendMessage({
        role: 'assistant',
        content: [
          {type: 'text', text: longAssistant},
          {type: 'thinking', thinking: 'private saved reasoning'},
          {
            type: 'toolCall',
            id: 'saved-tool',
            name: 'write',
            arguments: {...arguments_, thinking: 'private saved arguments'},
          },
        ],
        api: 'openai-completions',
        provider: 'history-fixture',
        model: 'saved-model',
        stopReason: 'toolUse',
        usage,
        timestamp: 2011,
      });
      saved.appendMessage({
        role: 'toolResult',
        toolCallId: 'saved-tool',
        toolName: 'write',
        content: [{type: 'text', text: longResult}],
        details: {private: 'private saved provider details'},
        isError: true,
        timestamp: 2012,
      });
      let lastUserEntryId: string | undefined;
      for (let index = 0; index < 60; index++) {
        const prompt = `Saved prompt ${index}`;
        const response = `Saved response ${index}`;
        lastUserEntryId = saved.appendMessage({
          role: 'user',
          content: prompt,
          timestamp: 2020 + index * 2,
        });
        saved.appendMessage({
          role: 'assistant',
          content: [{type: 'text', text: response}],
          api: 'openai-completions',
          provider: 'history-fixture',
          model: 'saved-model',
          stopReason: 'stop',
          usage,
          timestamp: 2021 + index * 2,
        });
        expected.push(['user', prompt], ['assistant', response]);
      }
      if (extensionProvider)
        saved.appendCompaction(
          'Remember the blue door\nThe door is blue.',
          lastUserEntryId!,
          25000,
        );
      const unrelated = save(other, 'Other folder', 3000);
      const listed = await hub.listSessions(cwd);
      assert.deepEqual(
        listed.map(item => item.id),
        [saved.getSessionId(), older.getSessionId()],
      );
      assert.equal(listed[0].name, 'Current work');
      assert.equal(listed[0].firstMessage, 'Remember the blue door');
      assert.equal(listed[0].messageCount, 125);
      await assert.rejects(hub.listSessions('.'), /absolute/);
      await assert.rejects(
        hub.createSession({cwd, sessionId: unrelated.getSessionId()}),
        /no longer available/,
      );
      await assert.rejects(
        hub.createSession({cwd, sessionId: 'missing'}),
        /no longer available/,
      );
      assert.equal(creations, 0);

      const [resumed, duplicate] = await Promise.all([
        hub.createSession({cwd, sessionId: saved.getSessionId()}),
        hub.createSession({cwd, sessionId: saved.getSessionId()}),
      ]);
      assert.deepEqual(resumed, {id: saved.getSessionId()});
      assert.deepEqual(duplicate, resumed);
      assert.equal(creations, 1);
      assert.deepEqual(
        await hub.createSession({cwd, sessionId: resumed.id}),
        resumed,
      );
      assert.equal(creations, 1);
      const snapshot = hub.snapshot().sessions[0];
      assert.equal(snapshot.session.sessionFile, saved.getSessionFile());
      assert.equal(snapshot.session.name, 'Current work');
      assert.equal(snapshot.session.status, 'idle');
      assert.equal(snapshot.session.model, 'history-fixture/saved-model');
      assert.equal(snapshot.session.thinkingLevel, 'high');
      assert.equal(snapshot.conversation.length, 125);
      assert.equal(snapshot.conversationTruncated, false);
      assert.deepEqual(
        snapshot.conversation.map(item => [item.role, item.text]),
        expected,
      );
      assert.ok(snapshot.conversation.every(item => !item.truncated));
      const restoredTool = snapshot.conversation.find(
        item => item.toolCallId === 'saved-tool',
      )!;
      assert.deepEqual(JSON.parse(restoredTool.input!), {
        ...arguments_,
        thinking: '[Omitted]',
      });
      assert.equal(restoredTool.status, 'failed');
      assert.equal(restoredTool.error, longResult);
      assert.doesNotMatch(
        JSON.stringify(snapshot.conversation),
        /private saved/,
      );

      const requests: Array<{model: string; messages: unknown[]}> = [];
      t.mock.method(
        globalThis,
        'fetch',
        async (url: RequestInfo | URL, options?: RequestInit) => {
          assert.equal(
            String(url),
            'https://history.invalid/v1/chat/completions',
          );
          requests.push(JSON.parse(String(options?.body)));
          return new Response(
            `data: ${JSON.stringify({
              id: 'reply',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'saved-model',
              choices: [
                {
                  index: 0,
                  delta: {role: 'assistant', content: 'Still blue.'},
                  finish_reason: 'stop',
                },
              ],
            })}\n\ndata: [DONE]\n\n`,
            {headers: {'content-type': 'text/event-stream'}},
          );
        },
      );
      await hub.promptSession(resumed.id, {prompt: 'What color was the door?'});
      // Hub submissions run independently of the renderer request.
      for (let attempt = 0; attempt < 500; attempt++) {
        if (
          hub
            .snapshot()
            .sessions[0].conversation.some(item => item.text === 'Still blue.')
        )
          break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(requests.length, 1);
      assert.equal(requests[0].model, 'saved-model');
      assert.match(
        JSON.stringify(requests[0].messages),
        /Remember the blue door/,
      );
      assert.match(JSON.stringify(requests[0].messages), /The door is blue/);
      const contents = await readFile(saved.getSessionFile()!, 'utf8');
      assert.match(contents, /What color was the door/);
      assert.match(contents, /Still blue/);
      assert.equal((await hub.listSessions(cwd)).length, 2);

      const empty = join(root, 'empty');
      await mkdir(empty);
      assert.deepEqual(await hub.listSessions(empty), []);
    },
  );
