import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {zstdDecompressSync} from 'node:zlib';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type {Model} from '@earendil-works/pi-ai';
import {
  createDashboardParent,
  type DesktopDashboardParent,
} from '../src/dashboard/parent.ts';
import {
  registerSpeedModes,
  runSpeedCommand,
  sessionSpeedMode,
  supportedSpeedModes,
} from '../src/speed-modes.ts';
import {createSessionWorker} from '../src/agents/session.ts';
import {AgentOrchestrator} from '../src/agents/orchestrator.ts';
import {runAgentSessionRequest} from '../src/dashboard/agent-session.ts';

const options = {timeout: 25_000};
const regular = ['regular'];
const fast = ['regular', 'fast'];
const ultrafast = ['regular', 'fast', 'ultrafast'];

function model(
  id: string,
  provider = 'openai',
  api = 'openai-responses',
  baseUrl = 'https://api.openai.com/v1',
) {
  return {id, provider, api, baseUrl} as Model<string>;
}

void test(
  'speed capabilities distinguish official model, API, endpoint and sign-in support',
  options,
  () => {
    for (const id of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-sol-2026-10-01']) {
      assert.deepEqual(supportedSpeedModes(model(id)), ultrafast);
      assert.deepEqual(supportedSpeedModes(model(id), true), ultrafast);
    }
    for (const id of [
      'gpt-5.5',
      'gpt-5.4-mini',
      'gpt-5.3-codex',
      'gpt-4o-2024-05-13',
      'o3',
      'o4-mini',
    ])
      assert.deepEqual(supportedSpeedModes(model(id)), fast);
    assert.deepEqual(supportedSpeedModes(model('gpt-5.5'), true), regular);
    for (const id of [
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ])
      assert.deepEqual(supportedSpeedModes(model(id), true), fast);
    for (const id of [
      'gpt-5.5-pro',
      'gpt-5.4-nano',
      'gpt-5-nano',
      'gpt-5.3-codex-spark',
      'gpt-5.2-chat-latest',
      'gpt-6x1-sol',
      'gpt-6-astra-unknown',
      'ft:gpt-6-astra',
      'o1',
      'o3-mini',
    ])
      assert.deepEqual(supportedSpeedModes(model(id)), regular, id);
    assert.deepEqual(
      supportedSpeedModes(model('gpt-6-astra', 'openrouter')),
      regular,
    );
    assert.deepEqual(
      supportedSpeedModes(
        model('gpt-6-astra', 'azure-openai', 'azure-openai-responses'),
      ),
      regular,
    );
    assert.deepEqual(
      supportedSpeedModes(
        model(
          'gpt-6-astra',
          'openai',
          'openai-responses',
          'https://gateway.invalid/v1',
        ),
      ),
      regular,
    );
    assert.deepEqual(
      supportedSpeedModes(model('gpt-6-astra', 'openai', 'openai-completions')),
      fast,
    );
    assert.deepEqual(
      supportedSpeedModes(
        model(
          'gpt-6-astra',
          'openai-codex',
          'openai-codex-responses',
          'https://chatgpt.com/backend-api',
        ),
      ),
      ultrafast,
    );
    for (const id of [
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-opus-4-8-20260601',
    ])
      assert.deepEqual(
        supportedSpeedModes(
          model(
            id,
            'anthropic',
            'anthropic-messages',
            'https://api.anthropic.com',
          ),
        ),
        fast,
      );
    for (const id of [
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-sonnet-4-8',
      'claude-haiku-4-5',
    ])
      assert.deepEqual(
        supportedSpeedModes(
          model(
            id,
            'anthropic',
            'anthropic-messages',
            'https://api.anthropic.com',
          ),
        ),
        regular,
      );
    assert.deepEqual(
      supportedSpeedModes(
        model(
          'claude-opus-5-5',
          'amazon-bedrock',
          'bedrock-converse-stream',
          'https://bedrock.amazonaws.com',
        ),
      ),
      regular,
    );
  },
);

void test(
  'speed selection follows the active session branch and stays separate for each model',
  options,
  async () => {
    const manager = SessionManager.inMemory('/tmp');
    const ctx = {
      model: model('gpt-6-astra'),
      modelRegistry: {
        isUsingOAuth: () => false,
        getProviderAuth: async () => ({
          auth: {apiKey: 'sk-fixture'},
          source: 'stored credential',
        }),
      },
      sessionManager: manager,
    } as Parameters<typeof sessionSpeedMode>[0];
    const append = (type: string, data: unknown) =>
      manager.appendCustomEntry(type, data);
    assert.equal(await runSpeedCommand('fast', '', ctx, append), 'fast');
    const fastLeaf = manager.getLeafId()!;
    assert.equal(
      await runSpeedCommand('ultrafast', '', ctx, append),
      'ultrafast',
    );
    assert.equal(sessionSpeedMode(ctx), 'ultrafast');
    manager.branch(fastLeaf);
    assert.equal(sessionSpeedMode(ctx), 'fast');
    assert.equal(await runSpeedCommand('fast', '', ctx, append), 'regular');
    ctx.model = model('gpt-6.1-sol');
    assert.equal(sessionSpeedMode(ctx), 'regular');
    ctx.model = model('gpt-6-astra');
    assert.equal(sessionSpeedMode(ctx), 'regular');
    await assert.rejects(
      runSpeedCommand('fast', 'maybe', ctx, append),
      /Usage/,
    );
    assert.equal(await runSpeedCommand('model', '', ctx, append), undefined);
  },
);

interface Captured {
  url: string;
  body: {
    model: string;
    speed?: string;
    service_tier?: string;
    betas?: string[];
    [key: string]: unknown;
  };
  headers: Headers;
}

function response(anthropic: boolean) {
  const events = anthropic
    ? [
        {
          type: 'message_start',
          message: {
            id: 'fixture',
            type: 'message',
            role: 'assistant',
            content: [],
            model: 'fixture',
            usage: {input_tokens: 1, output_tokens: 1},
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {type: 'text', text: ''},
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {type: 'text_delta', text: 'OK'},
        },
        {type: 'content_block_stop', index: 0},
        {
          type: 'message_delta',
          delta: {stop_reason: 'end_turn'},
          usage: {output_tokens: 1},
        },
        {type: 'message_stop'},
      ]
    : [
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'message',
            id: 'msg-fixture',
            role: 'assistant',
            content: [],
          },
        },
        {
          type: 'response.content_part.added',
          output_index: 0,
          content_index: 0,
          part: {type: 'output_text', text: '', annotations: []},
        },
        {
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          delta: 'OK',
        },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'message',
            id: 'msg-fixture',
            role: 'assistant',
            content: [{type: 'output_text', text: 'OK', annotations: []}],
          },
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp-fixture',
            status: 'completed',
            usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2},
          },
        },
      ];
  return new Response(
    events
      .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(''),
    {headers: {'content-type': 'text/event-stream'}},
  );
}

async function fixture(t: TestContext, oauth = false) {
  const root = await mkdtemp(join(tmpdir(), 'varisdev-speed-'));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'config');
  const title = process.title;
  const env = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  await mkdir(cwd, {recursive: true});
  await mkdir(agentDir, {recursive: true});
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      compaction: {enabled: false},
      retry: {enabled: false},
      cacheWarming: {enabled: false},
      transport: 'sse',
    }),
  );
  const codexAccess = `fixture.${Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': {chatgpt_account_id: 'speed-account'},
    }),
  ).toString('base64')}.signature`;
  await writeFile(
    join(agentDir, 'auth.json'),
    JSON.stringify({
      openai: oauth
        ? {
            type: 'oauth',
            access: 'saved-chatgpt-access',
            refresh: 'saved-refresh',
            expires: Date.now() + 3600000,
            clientId: 'fixture-client',
          }
        : {type: 'api_key', key: 'sk-speed-fixture'},
      'openai-codex': {
        type: 'oauth',
        access: codexAccess,
        refresh: 'saved-codex-refresh',
        expires: Date.now() + 3600000,
        accountId: 'speed-account',
      },
      anthropic: {type: 'api_key', key: 'sk-ant-speed-fixture'},
    }),
  );
  const parents: DesktopDashboardParent[] = [];
  const requests: Captured[] = [];
  let gate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  t.mock.method(
    globalThis,
    'fetch',
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(
        headers.get('content-encoding') === 'zstd'
          ? zstdDecompressSync(init?.body as Uint8Array).toString()
          : String(init?.body),
      ) as Captured['body'];
      requests.push({url: String(url), body, headers});
      await gate?.promise;
      // Reproduce the reported backend rejection instead of accepting every tier.
      if (body.service_tier === 'fast')
        return Response.json(
          {detail: 'Unsupported service_tier: fast'},
          {status: 400},
        );
      if (String(url).endsWith('/chat/completions'))
        return new Response(
          `data: ${JSON.stringify({
            id: 'fixture',
            model: body.model,
            choices: [
              {
                index: 0,
                delta: {role: 'assistant', content: 'OK'},
                finish_reason: 'stop',
              },
            ],
          })}\n\ndata: [DONE]\n\n`,
          {headers: {'content-type': 'text/event-stream'}},
        );
      return response(String(url).includes('anthropic.com'));
    },
  );
  t.after(async () => {
    gate?.resolve();
    await Promise.all(parents.map(parent => parent.close()));
    process.title = title;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, {recursive: true, force: true});
  });
  const create = async (
    reference = 'openai/gpt-6-astra',
    resume?: {id: string; path: string},
  ) => {
    const parent = await createDashboardParent({
      cwd,
      ...(resume ? {resume} : {model: reference}),
      thinkingLevel: 'low',
    });
    parents.push(parent);
    return parent;
  };
  return {
    create,
    requests,
    agentDir,
    cwd,
    codexAccess,
    hold: () => {
      gate = Promise.withResolvers<void>();
      return gate;
    },
  };
}

void test(
  'desktop commands toggle requests, keep an active turn unchanged and restore saved session preferences',
  options,
  async t => {
    const f = await fixture(t);
    const parent = await f.create();
    const initial = await parent.features();
    assert.equal(initial.speedMode, 'regular');
    assert.deepEqual(initial.speedModes, ultrafast);
    assert.ok(initial.commands.some(command => command.name === 'fast'));
    assert.ok(initial.commands.some(command => command.name === 'ultrafast'));
    await parent.prompt('/fast');
    assert.equal(f.requests.length, 0, 'Commands never become model prompts');
    assert.equal(parent.state.snapshot().session.speedMode, 'fast');
    await parent.prompt('First fast response');
    assert.equal(f.requests.at(-1)?.body.service_tier, 'priority');
    assert.equal(f.requests.at(-1)?.url, 'https://api.openai.com/v1/responses');
    assert.equal(
      f.requests.at(-1)?.headers.get('authorization'),
      'Bearer sk-speed-fixture',
    );
    assert.equal(parent.state.snapshot().session.error, undefined);
    const held = f.hold();
    const running = parent.prompt('Held fast response');
    const deadline = Date.now() + 3000;
    while (f.requests.length < 2 && Date.now() < deadline) await delay(5);
    assert.equal(f.requests.length, 2);
    await parent.prompt('/ultrafast');
    assert.equal(f.requests[1].body.service_tier, 'priority');
    held.resolve();
    await running;
    await parent.prompt('Next ultrafast response');
    assert.equal(f.requests.at(-1)?.body.service_tier, 'ultrafast');
    await parent.prompt('/ultrafast');
    await parent.prompt('Regular response');
    assert.equal(
      f.requests.at(-1)?.body.service_tier,
      'default',
      'Regular explicitly overrides a project default of Fast',
    );
    await parent.prompt('/fast on');
    await parent.configure({
      provider: 'openai',
      modelId: 'gpt-5.4-nano',
      persist: false,
    });
    assert.equal((await parent.features()).speedMode, 'regular');
    assert.equal(parent.state.snapshot().session.speedMode, 'regular');
    await assert.rejects(parent.prompt('/ultrafast'), /unavailable/);
    await assert.rejects(parent.prompt('/fast'), /unavailable/);
    await parent.configure({
      provider: 'openai',
      modelId: 'gpt-6-astra',
      persist: false,
    });
    assert.equal((await parent.features()).speedMode, 'fast');
    await parent.prompt('/ultrafast on');
    await parent.prompt('Saved ultrafast response');
    const saved = parent.state.snapshot().session;
    const content = await readFile(saved.sessionFile!, 'utf8');
    assert.match(content, /varisdev\.speed-mode/);
    await parent.reload();
    assert.equal((await parent.features()).speedMode, 'ultrafast');
    await parent.close();
    const resumed = await f.create('', {
      id: saved.id,
      path: saved.sessionFile!,
    });
    assert.equal((await resumed.features()).speedMode, 'ultrafast');
    assert.equal(resumed.state.snapshot().session.speedMode, 'ultrafast');
    await resumed.prompt('Resumed response');
    assert.equal(f.requests.at(-1)?.body.service_tier, 'ultrafast');
    const independent = await f.create();
    assert.equal((await independent.features()).speedMode, 'regular');
    assert.equal(
      JSON.stringify(
        JSON.parse(await readFile(join(f.agentDir, 'settings.json'), 'utf8')),
      ).includes('speed'),
      false,
    );
  },
);

void test(
  'main agent speed capabilities accept official OpenAI endpoints with a trailing slash',
  options,
  async t => {
    const f = await fixture(t);
    await writeFile(
      join(f.agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          openai: {baseUrl: 'https://api.openai.com/v1/'},
          'openai-codex': {baseUrl: 'https://chatgpt.com/backend-api/'},
        },
      }),
    );
    for (const reference of [
      'openai/gpt-6-astra',
      'openai-codex/gpt-6-astra',
    ]) {
      const parent = await f.create(reference);
      const features = await parent.features();
      assert.deepEqual(features.speedModes, ultrafast, reference);
      await parent.prompt('/fast on');
      assert.equal(parent.state.snapshot().session.speedMode, 'fast');
      await parent.prompt('Fast response through the official endpoint');
      assert.equal(f.requests.at(-1)?.body.service_tier, 'priority');
      assert.equal(parent.state.snapshot().session.error, undefined);
      await parent.prompt('/ultrafast on');
      await parent.prompt('Ultrafast response through the official endpoint');
      assert.equal(f.requests.at(-1)?.body.service_tier, 'ultrafast');
    }
  },
);

void test(
  'main agent speed capabilities follow live credentials without replacing the session',
  options,
  async t => {
    const f = await fixture(t);
    const parent = await f.create('openai/gpt-5.5');
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    assert.deepEqual((await parent.features()).speedModes, fast);
    await parent.prompt('/fast on');
    const authPath = join(f.agentDir, 'auth.json');
    const saved = JSON.parse(await readFile(authPath, 'utf8')) as Record<
      string,
      unknown
    >;
    saved.openai = {
      type: 'oauth',
      access: 'switched-chatgpt-access',
      refresh: 'switched-refresh',
      expires: Date.now() + 3600000,
      clientId: 'switch-client',
    };
    await writeFile(authPath, JSON.stringify(saved));
    const subscription = await parent.features();
    assert.deepEqual(subscription.speedModes, regular);
    assert.equal(subscription.speedMode, 'regular');
    await assert.rejects(parent.prompt('/fast on'), /unavailable/);
    await parent.prompt('Regular response with saved ChatGPT sign-in');
    assert.equal(f.requests.at(-1)?.body.service_tier, undefined);
    assert.equal(
      f.requests.at(-1)?.headers.get('authorization'),
      'Bearer switched-chatgpt-access',
    );
    saved.openai = {type: 'api_key', key: 'sk-switched-api-key'};
    await writeFile(authPath, JSON.stringify(saved));
    const restored = await parent.features();
    assert.deepEqual(restored.speedModes, fast);
    assert.equal(restored.speedMode, 'fast');
    await parent.prompt('Fast response with the replacement API key');
    assert.equal(f.requests.at(-1)?.body.service_tier, 'priority');
    assert.equal(
      f.requests.at(-1)?.headers.get('authorization'),
      'Bearer sk-switched-api-key',
    );
  },
);

void test(
  'Anthropic integration sends fast speed and preserves its required beta header only for preview models',
  options,
  async t => {
    const f = await fixture(t);
    const parent = await f.create('anthropic/claude-opus-4-8');
    await parent.prompt('/fast');
    await parent.prompt('Preview fast response');
    assert.equal(f.requests.at(-1)?.body.speed, 'fast');
    assert.ok(
      f.requests
        .at(-1)
        ?.headers.get('anthropic-beta')
        ?.includes('fast-mode-2026-02-01'),
    );
    assert.equal(
      f.requests.at(-1)?.body.betas,
      undefined,
      'Pi SDK turns betas into the HTTP header',
    );
    await parent.prompt('/fast off');
    await parent.prompt('Standard response');
    assert.equal(f.requests.at(-1)?.body.speed, undefined);
    assert.equal(
      f.requests
        .at(-1)
        ?.headers.get('anthropic-beta')
        ?.includes('fast-mode-2026-02-01'),
      false,
    );
    await assert.rejects(parent.prompt('/ultrafast'), /unavailable/);
    await parent.configure({
      provider: 'anthropic',
      modelId: 'claude-opus-5-5',
      persist: false,
    });
    await parent.prompt('/fast');
    await parent.prompt('Generally available fast response');
    assert.equal(f.requests.at(-1)?.body.speed, 'fast');
    assert.equal(
      f.requests
        .at(-1)
        ?.headers.get('anthropic-beta')
        ?.includes('fast-mode-2026-02-01'),
      false,
    );
    assert.equal(parent.state.snapshot().session.error, undefined);
  },
);

void test(
  'saved ChatGPT sign-in without an environment API key uses subscription model support and credentials',
  options,
  async t => {
    const f = await fixture(t, true);
    const parent = await f.create('openai/gpt-6.1-sol');
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    await parent.prompt('/fast');
    await parent.prompt('Subscription fast response');
    assert.equal((await parent.features()).speedMode, 'fast');
    assert.equal(f.requests.at(-1)?.body.service_tier, 'priority');
    assert.equal(f.requests.at(-1)?.url, 'https://api.openai.com/v1/responses');
    assert.equal(
      f.requests.at(-1)?.headers.get('authorization'),
      'Bearer saved-chatgpt-access',
    );
    assert.equal(parent.state.snapshot().session.error, undefined);
    await parent.prompt('/fast off');
    await parent.prompt('Subscription regular response');
    assert.equal(f.requests.at(-1)?.body.service_tier, 'default');
    await parent.prompt('/ultrafast');
    await parent.prompt('Subscription response');
    assert.equal(f.requests.at(-1)?.body.service_tier, 'ultrafast');
    assert.equal(
      f.requests.at(-1)?.headers.get('authorization'),
      'Bearer saved-chatgpt-access',
    );
    await parent.configure({
      provider: 'openai',
      modelId: 'gpt-5.5',
      persist: false,
    });
    assert.deepEqual((await parent.features()).speedModes, regular);
    await assert.rejects(parent.prompt('/fast'), /unavailable/);
  },
);

void test(
  'legacy Codex OAuth sends the Fast wire tier to the ChatGPT backend and retains saved preferences',
  options,
  async t => {
    const f = await fixture(t);
    const parent = await f.create('openai-codex/gpt-6-astra');
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    assert.deepEqual((await parent.features()).speedModes, ultrafast);
    await parent.prompt('/fast on');
    await parent.prompt('Codex fast response');
    assert.equal(f.requests.length, 1, 'Fast succeeds without retrying a 400');
    const request = f.requests.at(-1)!;
    assert.equal(
      request.url,
      'https://chatgpt.com/backend-api/codex/responses',
    );
    assert.equal(request.body.service_tier, 'priority');
    assert.equal(
      request.headers.get('authorization'),
      `Bearer ${f.codexAccess}`,
    );
    assert.equal(request.headers.get('chatgpt-account-id'), 'speed-account');
    assert.equal(parent.state.snapshot().session.error, undefined);
    const saved = parent.state.snapshot().session;
    await parent.close();
    const resumed = await f.create('', {
      id: saved.id,
      path: saved.sessionFile!,
    });
    assert.equal((await resumed.features()).speedMode, 'fast');
    await resumed.prompt('Resumed Codex fast response');
    assert.equal(f.requests.at(-1)?.body.service_tier, 'priority');
    await resumed.prompt('/ultrafast on');
    await resumed.prompt('Codex ultrafast response');
    assert.equal(f.requests.at(-1)?.body.service_tier, 'ultrafast');
    await resumed.prompt('/ultrafast off');
    await resumed.prompt('Codex regular response');
    assert.equal(f.requests.at(-1)?.body.service_tier, 'default');
    assert.equal(resumed.state.snapshot().session.error, undefined);
  },
);

void test(
  'OpenAI Chat Completions uses the compatible priority tier with API key authentication',
  options,
  async t => {
    const f = await fixture(t);
    await writeFile(
      join(f.agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          openai: {
            models: [
              {id: 'gpt-5.2', api: 'openai-completions', reasoning: true},
            ],
          },
        },
      }),
    );
    const parent = await f.create('openai/gpt-5.2');
    assert.deepEqual((await parent.features()).speedModes, fast);
    await parent.prompt('/fast on');
    await parent.prompt('Chat Completions fast response');
    assert.equal(f.requests.length, 1);
    assert.equal(
      f.requests.at(-1)?.url,
      'https://api.openai.com/v1/chat/completions',
    );
    assert.equal(f.requests.at(-1)?.body.service_tier, 'priority');
    assert.equal(
      f.requests.at(-1)?.headers.get('authorization'),
      'Bearer sk-speed-fixture',
    );
    assert.equal(parent.state.snapshot().session.error, undefined);
    await assert.rejects(parent.prompt('/ultrafast on'), /unavailable/);
    await parent.prompt('/fast off');
    await parent.prompt('Chat Completions regular response');
    assert.equal(f.requests.at(-1)?.body.service_tier, 'default');
  },
);

void test(
  'Pi extension commands and selected worker commands share session persistence and request behavior',
  options,
  async t => {
    const f = await fixture(t);
    const runtime = await ModelRuntime.create({
      authPath: join(f.agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const settings = SettingsManager.inMemory({
      retry: {enabled: false},
      compaction: {enabled: false},
    });
    const loader = new DefaultResourceLoader({
      cwd: f.cwd,
      agentDir: f.agentDir,
      settingsManager: settings,
      extensionFactories: [registerSpeedModes],
    });
    await loader.reload();
    const {session} = await createAgentSession({
      cwd: f.cwd,
      agentDir: f.agentDir,
      modelRuntime: runtime,
      model: runtime.getModel('openai', 'gpt-6-astra')!,
      resourceLoader: loader,
      settingsManager: settings,
      sessionManager: SessionManager.inMemory(f.cwd),
    });
    t.after(() => session.dispose());
    await session.bindExtensions({mode: 'rpc'});
    await session.prompt('/fast');
    assert.equal(
      sessionSpeedMode(session.extensionRunner.createContext()),
      'fast',
    );
    await session.prompt('Terminal fast response');
    assert.equal(f.requests.at(-1)?.body.service_tier, 'priority');
    await session.prompt('/fast');
    await session.prompt('Terminal regular response');
    assert.equal(f.requests.at(-1)?.body.service_tier, 'default');
    await runtime.refresh({allowNetwork: false});
    const worker = await createSessionWorker({
      id: 'speed-worker',
      parentSessionId: 'speed-parent',
      cwd: f.cwd,
      name: 'Speed worker',
      model: runtime.getModel('openai', 'gpt-6-astra')!,
      modelRegistry: new ModelRegistry(runtime),
      thinkingLevel: 'low',
      agentToolsExtension: () => {},
    });
    t.after(() => worker.dispose());
    assert.equal((await worker.command!('/ultrafast')).speedMode, 'ultrafast');
    await worker.run(
      'Worker ultrafast response',
      new AbortController().signal,
      () => {},
    );
    assert.equal(f.requests.at(-1)?.body.service_tier, 'ultrafast');
    assert.match(
      await readFile(worker.sessionFile!, 'utf8'),
      /varisdev\.speed-mode/,
    );
    assert.equal(
      (await worker.command!('/ultrafast off')).speedMode,
      'regular',
    );
    assert.equal(
      sessionSpeedMode(session.extensionRunner.createContext()),
      'regular',
      'Worker changes stay in the worker session',
    );
  },
);

void test(
  'retained workers follow live parent credential switches in both directions without an environment key',
  options,
  async t => {
    const f = await fixture(t);
    const authPath = join(f.agentDir, 'auth.json');
    const runtime = await ModelRuntime.create({
      authPath,
      modelsPath: null,
      refreshOnCreate: false,
    });
    await runtime.refresh({allowNetwork: false});
    const registry = new ModelRegistry(runtime);
    const saveCredential = async (credential: unknown) => {
      const saved = JSON.parse(await readFile(authPath, 'utf8')) as Record<
        string,
        unknown
      >;
      saved.openai = credential;
      await writeFile(authPath, JSON.stringify(saved));
    };
    const worker = async (id: string) => {
      const value = await createSessionWorker({
        id,
        parentSessionId: 'switch-parent',
        cwd: f.cwd,
        name: id,
        model: runtime.getModel('openai', 'gpt-5.5')!,
        modelRegistry: registry,
        thinkingLevel: 'low',
        agentToolsExtension: () => {},
      });
      t.after(() => value.dispose());
      return value;
    };
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    const fromApiKey = await worker('api-key-worker');
    assert.deepEqual((await fromApiKey.features!()).speedModes, fast);
    await fromApiKey.command!('/fast on');
    await fromApiKey.run(
      'API key fast response',
      new AbortController().signal,
      () => {},
    );
    assert.equal(f.requests.at(-1)?.body.service_tier, 'priority');
    assert.equal(
      f.requests.at(-1)?.headers.get('authorization'),
      'Bearer sk-speed-fixture',
    );

    await saveCredential({
      type: 'oauth',
      access: 'switched-chatgpt-access',
      refresh: 'switched-refresh',
      expires: Date.now() + 3600000,
      clientId: 'switch-client',
    });
    assert.equal(
      registry.isUsingOAuth(runtime.getModel('openai', 'gpt-5.5')!),
      false,
      'The parent catalog snapshot still describes the old API key',
    );
    assert.deepEqual((await fromApiKey.features!()).speedModes, regular);
    assert.equal((await fromApiKey.features!()).speedMode, 'regular');
    await assert.rejects(fromApiKey.command!('/fast on'), /unavailable/);
    await fromApiKey.run(
      'OAuth regular response',
      new AbortController().signal,
      () => {},
    );
    assert.equal(f.requests.at(-1)?.body.service_tier, undefined);
    assert.equal(
      f.requests.at(-1)?.headers.get('authorization'),
      'Bearer switched-chatgpt-access',
    );

    await runtime.refresh({allowNetwork: false});
    const fromOAuth = await worker('oauth-worker');
    assert.deepEqual((await fromOAuth.features!()).speedModes, regular);
    await saveCredential({type: 'api_key', key: 'sk-switched-api-key'});
    assert.equal(
      registry.isUsingOAuth(runtime.getModel('openai', 'gpt-5.5')!),
      true,
      'The parent catalog snapshot still describes the old OAuth login',
    );
    for (const retained of [fromApiKey, fromOAuth]) {
      assert.deepEqual((await retained.features!()).speedModes, fast);
      await retained.command!('/fast on');
      await retained.run(
        'Switched API key fast response',
        new AbortController().signal,
        () => {},
      );
      assert.equal(f.requests.at(-1)?.body.service_tier, 'priority');
      assert.equal(
        f.requests.at(-1)?.headers.get('authorization'),
        'Bearer sk-switched-api-key',
      );
    }
  },
);

void test(
  'selected running subagents accept speed commands through the conversation bridge without prompts or owner changes',
  options,
  async t => {
    const f = await fixture(t);
    const parent = await f.create();
    await parent.prompt('/fast on');
    const runtime = await ModelRuntime.create({
      authPath: join(f.agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    await runtime.refresh({allowNetwork: false});
    const registry = new ModelRegistry(runtime);
    const manager = new AgentOrchestrator();
    const held = f.hold();
    t.after(async () => {
      held.resolve();
      await manager.close();
    });
    const record = manager.spawn(
      {
        name: 'Selected subagent',
        task: 'Held subagent response',
        cwd: f.cwd,
        model: 'openai/gpt-6-astra',
        agentMode: 'subagent',
      },
      id =>
        createSessionWorker({
          id,
          parentSessionId: parent.state.snapshot().session.id,
          cwd: f.cwd,
          name: 'Selected subagent',
          model: runtime.getModel('openai', 'gpt-6-astra')!,
          modelRegistry: registry,
          thinkingLevel: 'low',
          agentToolsExtension: () => {},
        }),
    );
    const deadline = Date.now() + 3000;
    while (!f.requests.length && Date.now() < deadline) await delay(5);
    assert.equal(f.requests.length, 1);
    assert.equal(
      f.requests[0].body.service_tier,
      'default',
      'Subagents retain their own speed selection',
    );
    await runAgentSessionRequest(manager, {
      agentId: record.id,
      action: 'command',
      command: '/ultrafast on',
    });
    assert.equal(manager.get(record.id).status, 'running');
    assert.equal(manager.get(record.id).speedMode, 'ultrafast');
    assert.equal(f.requests.length, 1, 'The switch does not prompt the model');
    assert.equal(
      f.requests[0].body.service_tier,
      'default',
      'The active request keeps its speed',
    );
    assert.equal(
      (await parent.features()).speedMode,
      'fast',
      'The owner retains its own mode',
    );
    await assert.rejects(
      runAgentSessionRequest(manager, {
        agentId: record.id,
        action: 'prompt',
        prompt: '/fast on',
      }),
      /through their parent/,
    );
    held.resolve();
    await manager.wait([record.id]);
    await manager.send(record.id, 'Next subagent response');
    await manager.wait([record.id]);
    assert.equal(f.requests.at(-1)?.body.service_tier, 'ultrafast');
    await runAgentSessionRequest(manager, {
      agentId: record.id,
      action: 'command',
      command: '/fast off',
    });
    assert.equal(manager.get(record.id).speedMode, 'regular');
    assert.equal((await parent.features()).speedMode, 'fast');

    const primary = manager.spawn(
      {
        name: 'Selected primary',
        task: 'Primary initial response',
        cwd: f.cwd,
        model: 'openai/gpt-6-astra',
        agentMode: 'primary',
      },
      id =>
        createSessionWorker({
          id,
          parentSessionId: parent.state.snapshot().session.id,
          cwd: f.cwd,
          name: 'Selected primary',
          model: runtime.getModel('openai', 'gpt-6-astra')!,
          modelRegistry: registry,
          thinkingLevel: 'low',
          agentToolsExtension: () => {},
        }),
    );
    await manager.wait([primary.id]);
    const requestsBeforeCommand = f.requests.length;
    await runAgentSessionRequest(manager, {
      agentId: primary.id,
      action: 'prompt',
      prompt: '/ultrafast on',
    });
    assert.equal(manager.get(primary.id).speedMode, 'ultrafast');
    assert.equal(
      f.requests.length,
      requestsBeforeCommand,
      'A primary agent slash command targets its own session',
    );
    assert.equal(manager.get(record.id).speedMode, 'regular');
    assert.equal((await parent.features()).speedMode, 'fast');
  },
);
