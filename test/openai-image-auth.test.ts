import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {
  ModelRegistry,
  ModelRuntime,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {registerOpenAIImageTool} from '../src/tools/openai-image.ts';

const imageBytes = Buffer.from('fixture-image');
const oauth = {
  type: 'oauth',
  access: 'chatpass-token',
  refresh: 'refresh-token',
  expires: 0,
  clientId: 'fixture-client',
};
const savedApiKey = {type: 'api_key', key: 'saved-key'};

const accounts = [
  {name: 'a saved ChatPass login', credential: oauth},
  {name: 'a saved API key', credential: savedApiKey},
] as const;

const missingKeyError =
  'OpenAI image generation and editing require OPENAI_API_KEY. Set it in Environment settings or the process environment.';

type ImageTool = {
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: ExtensionContext,
  ): Promise<{
    details: {
      request: {operation: string; apiKeyEnvVar?: string};
      images: Array<{path: string}>;
    };
  }>;
};

async function fixture(t: TestContext, credential?: object) {
  const cwd = await mkdtemp(join(tmpdir(), 'varisdev-image-auth-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  for (const name of ['OPENAI_API_KEY', 'OPENAI_BASE_URL']) {
    const previous = process.env[name];
    delete process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  const authPath = join(cwd, 'auth.json');
  const savedAuth = credential ? {openai: credential} : {};
  await writeFile(authPath, JSON.stringify(savedAuth));
  const runtime = await ModelRuntime.create({
    authPath,
    modelsPath: null,
    modelsStorePath: join(cwd, 'models-store.json'),
    allowModelNetwork: false,
  });
  const ctx = new Proxy(
    {cwd, modelRegistry: new ModelRegistry(runtime)} as ExtensionContext,
    {
      get(target, property, receiver) {
        assert.notEqual(
          property,
          'modelRegistry',
          'Image authentication must not access the chat model registry',
        );
        return Reflect.get(target, property, receiver);
      },
    },
  );
  let tool!: ImageTool;
  registerOpenAIImageTool({
    registerTool(value: ImageTool) {
      tool = value;
    },
  } as unknown as ExtensionAPI);
  const requests: Request[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === 'data:,') return new Response();
      const request = new Request(input, init);
      requests.push(request);
      assert.match(
        request.url,
        /^https:\/\/api\.openai\.com\/v1\/images\/(generations|edits)$/,
      );
      return Response.json({data: [{b64_json: imageBytes.toString('base64')}]});
    },
  );
  return {
    cwd,
    ctx,
    requests,
    assertSavedAuthUnchanged: async () =>
      assert.deepEqual(JSON.parse(await readFile(authPath, 'utf8')), savedAuth),
    call: (params: Record<string, unknown> = {}) =>
      tool.execute(
        'image-auth',
        {
          prompt: 'A test image',
          model: 'gpt-image-2.5-flare',
          timeoutMs: 2000,
          ...params,
        },
        undefined,
        undefined,
        ctx,
      ),
  };
}

for (const operation of ['generate', 'edit'] as const) {
  for (const account of accounts) {
    void test(
      `${operation} uses OPENAI_API_KEY alongside ${account.name} without accessing the registry`,
      {timeout: 5000},
      async t => {
        const f = await fixture(t, account.credential);
        process.env.OPENAI_API_KEY = ' environment-key ';
        const inputPath = join(f.cwd, 'reference.png');
        if (operation === 'edit') await writeFile(inputPath, imageBytes);
        const result = await f.call({
          ...(operation === 'edit'
            ? {inputImagePaths: ['@reference.png']}
            : {}),
          quality: 'high',
          size: '1536x1024',
          outputFormat: 'webp',
        });
        assert.equal(f.requests.length, 1);
        const request = f.requests[0];
        assert.equal(
          request.headers.get('authorization'),
          'Bearer environment-key',
        );
        assert.equal(
          new URL(request.url).pathname,
          operation === 'edit' ? '/v1/images/edits' : '/v1/images/generations',
        );
        if (operation === 'edit') {
          const form = await request.formData();
          assert.equal(form.get('model'), 'gpt-image-2.5-flare');
          assert.equal(form.get('prompt'), 'A test image');
          assert.equal(form.get('quality'), 'high');
          assert.equal(form.get('size'), '1536x1024');
          assert.equal(form.get('output_format'), 'webp');
          const image = form.get('image');
          assert.ok(image instanceof File);
          assert.equal(image.name, 'reference.png');
          assert.deepEqual(Buffer.from(await image.arrayBuffer()), imageBytes);
        } else {
          const body = await request.json();
          assert.equal(body.model, 'gpt-image-2.5-flare');
          assert.equal(body.prompt, 'A test image');
          assert.equal(body.quality, 'high');
          assert.equal(body.size, '1536x1024');
          assert.equal(body.output_format, 'webp');
        }
        assert.equal(result.details.request.operation, operation);
        assert.equal(result.details.request.apiKeyEnvVar, 'OPENAI_API_KEY');
        assert.deepEqual(
          await readFile(result.details.images[0].path),
          imageBytes,
        );
        await f.assertSavedAuthUnchanged();
      },
    );
  }
}

for (const account of [
  ...accounts,
  {name: 'no saved account', credential: undefined},
]) {
  void test(
    `missing OPENAI_API_KEY fails locally with ${account.name} without accessing the registry`,
    {timeout: 5000},
    async t => {
      const f = await fixture(t, account.credential);
      f.ctx.hasUI = true;
      f.ctx.ui = {
        select: () =>
          assert.fail(
            'Must validate image credentials before asking for a model',
          ),
      } as unknown as ExtensionContext['ui'];
      for (const key of [undefined, '   ']) {
        if (key === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = key;
        await assert.rejects(f.call({model: undefined}), {
          message: missingKeyError,
        });
        assert.equal(f.requests.length, 0);
      }
      await f.assertSavedAuthUnchanged();
    },
  );
}
