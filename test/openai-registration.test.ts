import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {get} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import type {
  AuthPrompt,
  OAuthAuth,
  OAuthCredential,
} from '@earendil-works/pi-ai';
import {createDesktopModelRuntime} from '../src/llama.ts';
import {preserveOpenAIRegistration} from '../src/openai-registration.ts';
import {
  patchBundledOpenAIRegistration,
  patchOpenAIRegistration,
} from '../scripts/patch-openai-registration.mjs';

const sourcePath = fileURLToPath(
  new URL(
    'auth/oauth/openai-chatgpt.js',
    import.meta.resolve('@earendil-works/pi-ai'),
  ),
);
const deviceId = 'ad1962eb-dc9c-4245-a45a-4ca32e4ef440';
const issued = 'issued-client-a';
const other = 'issued-client-b';
const options = {timeout: 8000};
type Runtime = Awaited<ReturnType<typeof createDesktopModelRuntime>>;

function loopback(url: URL): Promise<{status: number; body: string}> {
  assert.equal(url.hostname, '127.0.0.1');
  return new Promise((resolve, reject) => {
    const request = get(url, {agent: false}, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
      });
      response.on('error', reject);
      response.on('end', () => resolve({status: response.statusCode!, body}));
    });
    request.setTimeout(2000, () =>
      request.destroy(new Error('Loopback callback timed out')),
    );
    request.on('error', reject);
  });
}

function pendingPrompt(signal: AbortSignal): Promise<string> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
  });
}

async function fixture(t: TestContext, credential?: OAuthCredential) {
  const directory = await mkdtemp(
    join(tmpdir(), 'varisdev-openai-registration-'),
  );
  t.after(() => rm(directory, {recursive: true, force: true}));
  const authPath = join(directory, 'auth.json');
  if (credential)
    await writeFile(authPath, JSON.stringify({openai: credential}));

  // Execute the production patch against installed Pi. Only import locations and
  // the loopback listener are adapted; the OAuth flow remains the patched source.
  let source = patchOpenAIRegistration(await readFile(sourcePath, 'utf8'));
  source = source.replace(
    /from "(\.[^"]+)"/g,
    (_: string, relative: string) =>
      `from ${JSON.stringify(pathToFileURL(join(dirname(sourcePath), relative)).href)}`,
  );
  assert.ok(source.includes('const CALLBACK_PORT = 1455;'));
  source = source
    .replace('const CALLBACK_PORT = 1455;', 'let CALLBACK_PORT = 0;')
    .replace(
      'const CALLBACK_HOST = getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";',
      'const CALLBACK_HOST = "127.0.0.1";',
    )
    .replace('const REDIRECT_URI =', 'let REDIRECT_URI =')
    .replace(
      'server.removeListener("error", reject);',
      `CALLBACK_PORT = server.address().port;
            REDIRECT_URI = \`http://127.0.0.1:\${CALLBACK_PORT}\${CALLBACK_PATH}\`;
            server.removeListener("error", reject);`,
    );
  const modulePath = join(directory, 'openai-chatgpt.mjs');
  await writeFile(modulePath, source);
  const {openaiChatGPTOAuth} = (await import(
    pathToFileURL(modulePath).href
  )) as {openaiChatGPTOAuth: OAuthAuth};
  assert.equal(
    (
      openaiChatGPTOAuth.login as OAuthAuth['login'] & {
        varisdevRegistrationReuse?: boolean;
      }
    ).varisdevRegistrationReuse,
    true,
  );

  const tokens: URLSearchParams[] = [];
  const control = {failToken: false};
  t.mock.method(
    globalThis,
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(
        String(input),
        'https://auth.openai.com/api/accounts/oauth/token',
        'Unexpected network request',
      );
      assert.equal(init?.method, 'POST');
      assert.ok(init?.body instanceof URLSearchParams);
      tokens.push(new URLSearchParams(init.body));
      if (control.failToken)
        return new Response('fixture exchange failure', {status: 503});
      return Response.json({
        access_token: `access-${tokens.length}`,
        refresh_token: `refresh-${tokens.length}`,
        id_token: 'fixture-id-token',
        expires_in: 3600,
        scope: 'openid chatgpt.tokens.use.direct',
      });
    },
  );

  async function recreate() {
    const runtime = await createDesktopModelRuntime({
      authPath,
      modelsPath: null,
      modelsStorePath: join(directory, 'models-cache.json'),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const provider = runtime.getProvider('openai')!;
    runtime.registerNativeProvider({
      ...provider,
      auth: {...provider.auth, oauth: openaiChatGPTOAuth},
    });
    return runtime;
  }
  let runtime = await recreate();
  const urls: URL[] = [];
  const selections: Array<Extract<AuthPrompt, {type: 'select'}>['options']> =
    [];
  const browserResponses: Array<{status: number; body: string}> = [];
  async function login(
    input: {
      clientId?: string;
      choice?: string;
      browser?: boolean;
      cancel?: boolean;
    } = {clientId: issued},
  ) {
    const controller = new AbortController();
    const deadline = setTimeout(
      () => controller.abort(new Error('Login fixture deadline exceeded')),
      4000,
    );
    let url: URL | undefined;
    let callbackTask: Promise<unknown> | undefined;
    const callback = () => {
      assert.ok(url, 'Pi must announce the authorization URL before prompting');
      const result = new URL(url.searchParams.get('redirect_uri')!);
      result.searchParams.set('state', url.searchParams.get('state')!);
      result.searchParams.set('code', `code-${urls.length}`);
      if (input.clientId !== undefined)
        result.searchParams.set('client_id', input.clientId);
      return result;
    };
    try {
      const credential = await runtime.login(
        'openai',
        'oauth',
        {
          signal: controller.signal,
          notify(event) {
            if (event.type === 'auth_url') {
              url = new URL(event.url);
              urls.push(url);
            }
          },
          async prompt(prompt) {
            if (prompt.type === 'select') {
              selections.push(prompt.options);
              return input.choice ?? issued;
            }
            assert.equal(prompt.type, 'manual_code');
            if (input.cancel)
              controller.abort(new Error('Fixture user cancelled'));
            if (input.browser) {
              callbackTask = loopback(callback())
                .then(response => {
                  browserResponses.push(response);
                })
                .catch(error => controller.abort(error));
              return pendingPrompt(prompt.signal!);
            }
            controller.signal.throwIfAborted();
            return callback().href;
          },
        },
        {getDeviceId: () => deviceId},
      );
      assert.ok(credential.type === 'oauth');
      return credential;
    } finally {
      clearTimeout(deadline);
      controller.abort();
      // The browser path's pending manual prompt must be cancelled by Pi cleanup.
      if (callbackTask) await callbackTask.catch(() => {});
    }
  }
  return {
    login,
    urls,
    tokens,
    selections,
    browserResponses,
    control,
    authPath,
    registrationPath: join(directory, 'openai-registrations.json'),
    runtime: () => runtime,
    async recreate() {
      runtime = await recreate();
    },
  };
}

function assertReturning(url: URL, clientId = issued) {
  assert.equal(url.searchParams.get('client_id'), clientId);
  assert.equal(url.searchParams.has('agent_name_hint'), false);
  assert.equal(
    url.searchParams.get('ext_agent_host_id'),
    `urn:uuid:${deviceId}`,
  );
}

async function assertActive(runtime: Runtime, access: string) {
  assert.equal((await runtime.getAuth('openai'))?.auth.apiKey, access);
  assert.deepEqual(await runtime.listCredentials(), [
    {providerId: 'openai', type: 'oauth'},
  ]);
}

void test(
  'tracked registration patch is idempotent, rejects drift and applies to the private bundle',
  options,
  async t => {
    const source = await readFile(sourcePath, 'utf8');
    const patched = patchOpenAIRegistration(source);
    assert.notEqual(patched, source);
    assert.equal(patchOpenAIRegistration(patched), patched);
    assert.throws(
      () =>
        patchOpenAIRegistration(
          source.replace(
            'function startCallbackServer(expectedState)',
            'function changedCallbackServer(expectedState)',
          ),
        ),
      /Pi OpenAI OAuth changed/,
    );
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-openai-bundle-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const bundledPath = join(
      directory,
      'node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-chatgpt.js',
    );
    await mkdir(dirname(bundledPath), {recursive: true});
    await writeFile(bundledPath, source);
    await patchBundledOpenAIRegistration(directory);
    assert.equal(await readFile(bundledPath, 'utf8'), patched);
    await patchBundledOpenAIRegistration(directory);
    assert.equal(await readFile(bundledPath, 'utf8'), patched);
  },
);

for (const browser of [false, true]) {
  void test(
    `initial registration and returning ${browser ? 'browser' : 'manual'} login reuse the issued ID and host`,
    options,
    async t => {
      const f = await fixture(t);
      const first = await f.login();
      assert.equal(first.clientId, issued);
      assert.equal(
        f.urls[0].searchParams.get('client_id'),
        'dynamic_agent_client',
      );
      assert.equal(f.urls[0].searchParams.get('agent_name_hint'), 'VarisDev');
      assert.equal(f.selections.length, 0);
      const second = await f.login({browser});
      assert.equal(
        second.clientId,
        issued,
        'Returning callback may omit client_id',
      );
      assertReturning(f.urls[1]);
      assert.equal(
        f.urls[0].searchParams.get('ext_agent_host_id'),
        f.urls[1].searchParams.get('ext_agent_host_id'),
      );
      assert.deepEqual(
        f.tokens.map(body => body.get('client_id')),
        [issued, issued],
      );
      assert.equal(f.tokens[1].get('code'), 'code-2');
      assert.equal(
        f.tokens[1].get('redirect_uri'),
        f.urls[1].searchParams.get('redirect_uri'),
      );
      assert.deepEqual(
        f.selections[0].map(item => item.id),
        [issued, 'new'],
      );
      if (browser) assert.equal(f.browserResponses[0].status, 200);
      await assertActive(f.runtime(), 'access-2');
    },
  );
}

for (const browser of [false, true]) {
  void test(
    `mismatched ${browser ? 'browser' : 'manual'} callback cannot replace credentials or save another registration`,
    options,
    async t => {
      const f = await fixture(t);
      await f.login();
      await assert.rejects(
        f.login({clientId: other, browser}),
        /client ID does not match/,
      );
      assert.equal(
        f.tokens.length,
        1,
        'Mismatch must be rejected before code exchange',
      );
      await assertActive(f.runtime(), 'access-1');
      if (browser) {
        assert.equal(f.browserResponses[0].status, 400);
        assert.match(f.browserResponses[0].body, /client ID does not match/);
      }
      await f.recreate();
      await f.login({});
      assert.deepEqual(
        f.selections.at(-1)!.map(item => item.id),
        [issued, 'new'],
      );
      assertReturning(f.urls.at(-1)!);
    },
  );
}

void test(
  'registration survives logout and runtime recreation without appearing as a credential',
  options,
  async t => {
    const f = await fixture(t);
    await f.login();
    await f.runtime().logout('openai');
    assert.deepEqual(await f.runtime().listCredentials(), []);
    await f.recreate();
    assert.deepEqual(await f.runtime().listCredentials(), []);
    await f.login({});
    assertReturning(f.urls.at(-1)!);
    await assertActive(f.runtime(), 'access-2');
  },
);

void test(
  'failed first token exchange retains the issued registration for a later runtime retry',
  options,
  async t => {
    const f = await fixture(t);
    f.control.failToken = true;
    await assert.rejects(f.login(), /token request failed \(503\)/);
    assert.deepEqual(await f.runtime().listCredentials(), []);
    await f.recreate();
    f.control.failToken = false;
    await f.login({});
    assertReturning(f.urls[1]);
    assert.deepEqual(
      f.tokens.map(body => body.get('client_id')),
      [issued, issued],
    );
    await assertActive(f.runtime(), 'access-2');
  },
);

void test(
  'cancelled and failed reauthentication preserve the active OAuth credential',
  options,
  async t => {
    const f = await fixture(t);
    await f.login();
    await assert.rejects(f.login({cancel: true}), /cancel/i);
    assert.equal(f.tokens.length, 1);
    await assertActive(f.runtime(), 'access-1');
    f.control.failToken = true;
    await assert.rejects(f.login({}), /token request failed \(503\)/);
    await assertActive(f.runtime(), 'access-1');
    await f.recreate();
    await assertActive(f.runtime(), 'access-1');
    f.control.failToken = false;
    await f.login({});
    assertReturning(f.urls.at(-1)!);
    await assertActive(f.runtime(), 'access-3');
  },
);

void test(
  'explicit new account registers dynamically and both saved connections remain selectable',
  options,
  async t => {
    const f = await fixture(t);
    await f.login();
    const second = await f.login({choice: 'new', clientId: other});
    assert.equal(second.clientId, other);
    assert.equal(
      f.urls[1].searchParams.get('client_id'),
      'dynamic_agent_client',
    );
    assert.equal(f.urls[1].searchParams.get('agent_name_hint'), 'VarisDev');
    assert.equal(
      f.urls[1].searchParams.get('ext_agent_host_id'),
      f.urls[0].searchParams.get('ext_agent_host_id'),
    );
    await f.recreate();
    await f.login({choice: issued});
    assert.deepEqual(
      f.selections.at(-1)!.map(item => item.id),
      [other, issued, 'new'],
    );
    assertReturning(f.urls.at(-1)!);
    await assertActive(f.runtime(), 'access-3');
  },
);

function legacyCredential(): OAuthCredential {
  return {
    type: 'oauth',
    clientId: issued,
    access: 'legacy-access',
    refresh: 'legacy-refresh',
    expires: Date.now() + 3600000,
  };
}

void test(
  'logout migrates an existing OAuth registration before deleting its credential',
  options,
  async t => {
    const f = await fixture(t, legacyCredential());
    await f.runtime().logout('openai');
    await f.recreate();
    assert.deepEqual(await f.runtime().listCredentials(), []);
    await f.login({});
    assertReturning(f.urls[0]);
  },
);

void test(
  'API key replacement migrates an existing OAuth registration for later reuse',
  options,
  async t => {
    const f = await fixture(t, legacyCredential());
    await f.runtime().login('openai', 'api_key', {
      prompt: async () => 'fixture-api-key',
      notify() {},
    });
    assert.equal(
      (await f.runtime().getAuth('openai'))?.auth.apiKey,
      'fixture-api-key',
    );
    await f.recreate();
    await f.login({});
    assertReturning(f.urls[0]);
  },
);

void test(
  'CLI preservation helper retains a legacy registration after credential removal',
  options,
  async t => {
    const f = await fixture(t, legacyCredential());
    assert.equal(await preserveOpenAIRegistration(f.authPath), issued);
    await rm(f.authPath);
    await f.recreate();
    assert.deepEqual(await f.runtime().listCredentials(), []);
    await f.login({});
    assertReturning(f.urls[0]);
  },
);

for (const storage of ['credentials', 'registrations'] as const) {
  void test(
    `malformed ${storage} storage prevents a fresh registration`,
    options,
    async t => {
      const f = await fixture(t);
      const path = storage === 'credentials' ? f.authPath : f.registrationPath;
      const malformed =
        storage === 'credentials'
          ? '{invalid JSON'
          : JSON.stringify({version: 1, clientIds: ['dynamic_agent_client']});
      await writeFile(path, malformed);
      await assert.rejects(
        f.login(),
        storage === 'credentials'
          ? /Could not read OpenAI registration storage/
          : /Invalid saved OpenAI registrations/,
      );
      assert.equal(
        f.urls.length,
        0,
        'Storage errors must stop before opening authorization',
      );
      assert.equal(f.tokens.length, 0);
      assert.equal(await readFile(path, 'utf8'), malformed);
    },
  );
}

for (const clientId of [undefined, 'dynamic_agent_client']) {
  void test(
    `initial registration rejects ${clientId === undefined ? 'missing client_id' : 'literal dynamic_agent_client'} callback`,
    options,
    async t => {
      const f = await fixture(t);
      await assert.rejects(
        f.login({clientId}),
        /registration callback did not contain an issued client ID/,
      );
      assert.equal(
        f.urls[0].searchParams.get('client_id'),
        'dynamic_agent_client',
      );
      assert.deepEqual(f.selections, []);
      assert.equal(
        f.tokens.length,
        0,
        'Invalid registration must stop before token exchange',
      );
      assert.deepEqual(await f.runtime().listCredentials(), []);
      await assert.rejects(readFile(f.registrationPath), {code: 'ENOENT'});
    },
  );
}
