import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {test, type TestContext} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {ModelRegistry} from '@earendil-works/pi-coding-agent';
import {DesktopAccounts} from '../src/desktop/accounts.ts';
import {createDesktopModelRuntime} from '../src/llama.ts';
import {createSessionWorker} from '../src/agents/session.ts';
import {
  createDashboardParent,
  type DesktopDashboardParent,
} from '../src/dashboard/parent.ts';

async function until(check: () => boolean, label: string) {
  for (let count = 0; count < 500; count++) {
    if (check()) return;
    await delay(10);
  }
  assert.ok(check(), label);
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'varisdev-llama-'));
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'project');
  await mkdir(cwd);
  await mkdir(agentDir);
  const previous = Object.fromEntries(
    ['PI_CODING_AGENT_DIR', 'LLAMA_BASE_URL', 'LLAMA_API_KEY', 'HF_TOKEN'].map(
      key => [key, process.env[key]],
    ),
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.LLAMA_BASE_URL;
  delete process.env.LLAMA_API_KEY;
  process.env.HF_TOKEN = 'fixture-huggingface-token';
  const models = [
    {id: 'fixture-gguf', status: {value: 'unloaded'}, meta: {n_ctx: 32768}},
  ];
  const requests: Array<{
    path: string;
    method: string;
    model?: string;
    auth?: string;
  }> = [];
  const control = {holdLoad: false, holdDownload: false, failList: false};
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = body ? (JSON.parse(body) as {model?: string}) : {};
    const url = new URL(request.url!, 'http://localhost');
    requests.push({
      path: url.pathname,
      method: request.method!,
      model: input.model,
      auth: request.headers.authorization,
    });
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, {'content-type': 'application/json'});
      response.end(JSON.stringify(value));
    };
    if (url.pathname === '/models/sse') {
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.flushHeaders();
      return;
    }
    if (url.pathname === '/models' && request.method === 'GET') {
      json(
        control.failList
          ? {error: {message: 'Router unavailable'}}
          : {data: models},
        control.failList ? 503 : 200,
      );
    } else if (url.pathname === '/props') json({models_autoload: false});
    else if (url.pathname === '/models/load') {
      models.find(model => model.id === input.model)!.status.value =
        control.holdLoad ? 'loading' : 'loaded';
      json({success: true});
    } else if (url.pathname === '/models/unload') {
      const model = models.find(model => model.id === input.model);
      if (model) model.status.value = 'unloaded';
      json({success: true});
    } else if (url.pathname === '/models' && request.method === 'POST') {
      models.push({
        id: input.model!,
        status: {value: control.holdDownload ? 'downloading' : 'unloaded'},
        meta: {n_ctx: 32768},
      });
      json({success: true});
    } else if (url.pathname === '/v1/chat/completions') {
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.end(
        'data: ' +
          JSON.stringify({
            id: 'fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: input.model,
            choices: [
              {
                index: 0,
                delta: {role: 'assistant', content: 'Local model answer.'},
                finish_reason: 'stop',
              },
            ],
          }) +
          '\n\ndata: [DONE]\n\n',
      );
    } else json({error: {message: 'Unknown fixture endpoint'}}, 404);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const accounts = new DesktopAccounts({
    openBrowser: async () => {},
    changed: () => {},
  });
  const parents: DesktopDashboardParent[] = [];
  t.after(async () => {
    await Promise.all(parents.map(parent => parent.close()));
    await accounts.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, {recursive: true, force: true});
  });
  const fetch = globalThis.fetch;
  t.mock.method(
    globalThis,
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = new URL(String(input));
      if (target.hostname !== 'huggingface.co') return fetch(input, init);
      if (target.pathname === '/api/models')
        return Response.json([{id: 'fixture/repo', downloads: 100}]);
      return Response.json({
        id: target.pathname.slice('/api/models/'.length),
        gated: false,
        siblings: [{rfilename: 'fixture-Q4_K_M.gguf', size: 4096}],
      });
    },
  );
  async function connect(key = '') {
    const state = await accounts.get();
    assert.ok(
      state.providers.some(
        provider => provider.id === 'llama.cpp' && provider.apiKey,
      ),
    );
    accounts.start('llama.cpp', 'api_key');
    await until(
      () => accounts.snapshot().prompt?.type === 'text',
      'server URL prompt',
    );
    let current = accounts.snapshot();
    accounts.respond(current.attempt!.id, current.prompt!.id, url);
    await until(
      () => accounts.snapshot().prompt?.type === 'secret',
      'optional key prompt',
    );
    current = accounts.snapshot();
    assert.equal(current.prompt!.allowEmpty, true);
    accounts.respond(current.attempt!.id, current.prompt!.id, key);
    await until(
      () => !accounts.snapshot().attempt,
      'account connection completes',
    );
    assert.equal(accounts.snapshot().error, undefined);
  }
  async function parent() {
    const result = await createDashboardParent({cwd});
    parents.push(result);
    return result;
  }
  return {
    root,
    agentDir,
    cwd,
    url,
    accounts,
    models,
    requests,
    control,
    connect,
    parent,
  };
}

async function dialog(parent: DesktopDashboardParent, title: RegExp) {
  await until(
    () => title.test(parent.ui.snapshot().dialogs[0]?.title || ''),
    `dialog ${title}`,
  );
  return parent.ui.snapshot().dialogs[0];
}
async function choose(
  parent: DesktopDashboardParent,
  title: RegExp,
  option: string | RegExp | boolean | undefined,
) {
  const current = await dialog(parent, title);
  const value =
    option instanceof RegExp
      ? current.options?.find(value => option.test(value))
      : option;
  if (option instanceof RegExp)
    assert.ok(value, `Missing ${option}: ${current.options}`);
  parent.ui.respond(current.id, value);
}

void test('llama.cpp environment configuration discovers loaded models without stored credentials', async t => {
  const f = await fixture(t);
  process.env.LLAMA_BASE_URL = f.url;
  f.models[0].status.value = 'loaded';
  const parent = await f.parent();
  const features = await parent.features();
  assert.ok(
    features.models.some(
      model => model.provider === 'llama.cpp' && model.id === 'fixture-gguf',
    ),
  );
  assert.ok(
    (await f.accounts.get()).providers.some(
      provider =>
        provider.id === 'llama.cpp' && provider.status !== 'Not connected',
    ),
  );
});

void test('background agents use the configured llama.cpp provider and server credentials', async t => {
  const f = await fixture(t);
  await f.connect('worker-server-key');
  f.models[0].status.value = 'loaded';
  const runtime = await createDesktopModelRuntime({
    authPath: join(f.agentDir, 'auth.json'),
    modelsPath: join(f.agentDir, 'models.json'),
  });
  await runtime.refresh({providers: ['llama.cpp'], allowNetwork: true});
  const registry = new ModelRegistry(runtime);
  const model = registry.find('llama.cpp', 'fixture-gguf');
  assert.ok(model);
  const worker = await createSessionWorker({
    id: 'local-worker',
    parentSessionId: 'local-parent',
    cwd: f.cwd,
    name: 'Local worker',
    model,
    modelRegistry: registry,
    thinkingLevel: 'off',
    agentToolsExtension: () => {},
  });
  try {
    assert.equal(
      await worker.run(
        'Answer locally',
        new AbortController().signal,
        () => {},
      ),
      'Local model answer.',
    );
    assert.ok(
      f.requests.some(
        request =>
          request.path === '/v1/chat/completions' &&
          request.auth === 'Bearer worker-server-key',
      ),
    );
  } finally {
    await worker.dispose();
  }
});

void test(
  'llama.cpp account setup, catalog discovery, loading, inference, unloading and downloads use Pi clients',
  {timeout: 30000},
  async t => {
    const f = await fixture(t);
    const parent = await f.parent();
    assert.ok(
      (await parent.features()).commands.some(
        command => command.name === 'llama',
      ),
    );
    await parent.prompt('/llama');
    assert.match(
      parent.ui.snapshot().notifications.at(-1)!.message,
      /Menu → Accounts/,
    );
    await f.connect();
    const stored = JSON.parse(
      await readFile(join(f.agentDir, 'auth.json'), 'utf8'),
    ) as Record<string, {env: {LLAMA_BASE_URL: string}}>;
    assert.equal(stored['llama.cpp'].env.LLAMA_BASE_URL, f.url);
    let run = parent.prompt('/llama');
    await choose(parent, /^llama.cpp ·/, /^fixture-gguf · unloaded/);
    await choose(parent, /^llama.cpp ·/, 'Close');
    await run;
    assert.equal(f.models[0].status.value, 'loaded');
    assert.ok(
      (await parent.features()).models.some(
        model => model.provider === 'llama.cpp' && model.id === 'fixture-gguf',
      ),
    );
    await parent.configure({provider: 'llama.cpp', modelId: 'fixture-gguf'});
    await parent.prompt('Answer with the local model');
    assert.match(
      parent.state.snapshot().session.response!,
      /Local model answer/,
    );
    assert.ok(
      f.requests.some(
        request =>
          request.path === '/v1/chat/completions' &&
          request.model === 'fixture-gguf',
      ),
    );
    await parent.reload();
    assert.ok(
      (await parent.features()).commands.some(
        command => command.name === 'llama',
      ),
    );
    run = parent.prompt('/llama');
    await choose(parent, /^llama.cpp ·/, /^fixture-gguf · loaded/);
    await choose(parent, /Unload model/, true);
    await choose(parent, /^llama.cpp ·/, 'Download model…');
    await choose(parent, /Download a GGUF model/, 'fixture');
    await choose(parent, /Choose a repository/, 'fixture/repo');
    await choose(parent, /Quantization for/, /^Q4_K_M/);
    await choose(parent, /^llama.cpp ·/, 'Close');
    await run;
    assert.equal(f.models[0].status.value, 'unloaded');
    assert.ok(
      f.requests.some(
        request =>
          request.path === '/models' &&
          request.method === 'POST' &&
          request.model === 'fixture/repo:Q4_K_M',
      ),
    );
    assert.equal(
      (await parent.features()).models.some(
        model => model.provider === 'llama.cpp',
      ),
      false,
    );
  },
);

void test(
  'llama.cpp progress cancellation, parent stopping and close stop server operations and permit retry',
  {timeout: 30000},
  async t => {
    const f = await fixture(t);
    await f.connect('fixture-server-key');
    const parent = await f.parent();
    f.control.holdLoad = true;
    let run = parent.prompt('/llama');
    await choose(parent, /^llama.cpp ·/, /^fixture-gguf/);
    await until(
      () =>
        parent.ui
          .snapshot()
          .dialogs[0]?.terminal?.output.includes('Loading model') === true &&
        f.models[0].status.value === 'loading',
      'loading progress',
    );
    const progress = parent.ui.snapshot().dialogs[0];
    parent.ui.respond(progress.id, '\x1b');
    await choose(parent, /^llama.cpp ·/, 'Close');
    await run;
    assert.equal(f.models[0].status.value, 'unloaded');
    assert.ok(
      f.requests.some(
        request =>
          request.path === '/models/unload' &&
          request.auth === 'Bearer fixture-server-key',
      ),
    );
    run = parent.prompt('/llama');
    await choose(parent, /^llama.cpp ·/, /^fixture-gguf/);
    await until(() => f.models[0].status.value === 'loading', 'second load');
    await parent.abort();
    await run;
    assert.equal(f.models[0].status.value, 'unloaded');
    assert.deepEqual(parent.ui.snapshot().dialogs, []);
    f.control.holdLoad = false;
    f.control.failList = true;
    run = parent.prompt('/llama');
    await dialog(parent, /Router unavailable/);
    f.control.failList = false;
    await choose(parent, /Router unavailable/, 'Retry');
    await choose(parent, /^llama.cpp ·/, 'Download model…');
    f.control.holdDownload = true;
    await choose(parent, /Download a GGUF model/, 'fixture/held:Q4_K_M');
    await until(
      () => f.models.some(model => model.status.value === 'downloading'),
      'download progress',
    );
    await parent.close();
    await run;
    assert.equal(
      f.models.find(model => model.id === 'fixture/held:Q4_K_M')?.status.value,
      'unloaded',
    );
    assert.deepEqual(parent.ui.snapshot().dialogs, []);
  },
);
