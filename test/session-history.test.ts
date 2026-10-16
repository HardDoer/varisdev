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
    `folder history resumes the same Pi session, model and conversation${extensionProvider ? ' with an extension provider' : ''}`,
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
      const unrelated = save(other, 'Other folder', 3000);
      const listed = await hub.listSessions(cwd);
      assert.deepEqual(
        listed.map(item => item.id),
        [saved.getSessionId(), older.getSessionId()],
      );
      assert.equal(listed[0].name, 'Current work');
      assert.equal(listed[0].firstMessage, 'Remember the blue door');
      assert.equal(listed[0].messageCount, 2);
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
      assert.ok(
        snapshot.conversation.some(item => item.text === 'The door is blue.'),
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
