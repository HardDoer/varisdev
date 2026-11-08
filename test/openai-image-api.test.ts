import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {extname, join, resolve} from 'node:path';
import {test, type TestContext} from 'node:test';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import sharp from 'sharp';
import {ConversationImageRegistry} from '../src/conversation-images.ts';
import {registerOpenAIImageTool} from '../src/tools/openai-image.ts';

const svgBytes = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill="red" d="M0 0h16v16H0z"/></svg>',
);
// Two 1×1 frames, with a graphic control extension and image data for each.
const gifBytes = Buffer.from(
  '47494638396101000100800000000000ffffff' +
    '21f904000a0000002c0000000001000100000202440100' +
    '21f904000a0000002c00000000010001000002024c01003b',
  'hex',
);

type ImageDetails = {
  path: string;
  mimeType: string;
  bytes: number;
  source: string;
};
type Result = {
  details: {
    request: Record<string, unknown>;
    images: ImageDetails[];
  };
};
type ImageTool = {
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    update: ((result: Result) => void) | undefined,
    ctx: ExtensionContext,
  ): Promise<Result>;
};

async function fixture(t: TestContext, output = svgBytes) {
  const root = resolve('.varisdev/tool-output');
  await mkdir(root, {recursive: true});
  const cwd = await mkdtemp(join(root, 'image-api-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  for (const name of [
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_IMAGE_SIZE',
    'OPENAI_IMAGE_OUTPUT_FORMAT',
    'OPENAI_IMAGE_OUTPUT_DIR',
  ]) {
    const previous = process.env[name];
    delete process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  process.env.OPENAI_API_KEY = 'fixture-key';
  const requests: Request[] = [];
  const updates: Result[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === 'data:,') return new Response();
      const request = new Request(input, init);
      assert.match(
        request.url,
        /^https:\/\/api\.openai\.com\/v1\/images\/(generations|edits)$/,
      );
      requests.push(request);
      return Response.json({data: [{b64_json: output.toString('base64')}]});
    },
  );
  let tool!: ImageTool;
  registerOpenAIImageTool({
    registerTool(value: ImageTool) {
      tool = value;
    },
  } as unknown as ExtensionAPI);
  return {
    cwd,
    requests,
    updates,
    call: (params: Record<string, unknown> = {}, signal?: AbortSignal) =>
      tool.execute(
        'image-api',
        {
          model: 'gpt-image-2.6-flare',
          prompt: 'A fixture image',
          timeoutMs: 5000,
          ...params,
        },
        signal,
        update => updates.push(update),
        {cwd} as ExtensionContext,
      ),
  };
}

async function sourceImage(cwd: string) {
  const bytes = await sharp({
    create: {width: 3, height: 2, channels: 4, background: '#123456'},
  })
    .png()
    .toBuffer();
  await writeFile(join(cwd, 'source.png'), bytes);
  return bytes;
}

async function requestFields(
  request: Request,
): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.includes('application/json'))
    return request.json();
  const fields: Record<string, unknown> = {};
  (await request.formData()).forEach((value, key) => {
    fields[key] = value;
  });
  return fields;
}

for (const operation of ['generate', 'edit'] as const) {
  void test(
    `${operation} forwards SVG authoring and complexity, saves SVG, and provides a conversation preview`,
    {timeout: 15000},
    async t => {
      const f = await fixture(t);
      if (operation === 'edit') await sourceImage(f.cwd);
      const result = await f.call({
        ...(operation === 'edit' ? {inputImagePaths: ['@source.png']} : {}),
        outputFormat: 'svg',
        quality: 'max',
        complexity: 'medium',
        n: 1,
        svg: {model: 'svg-author', reasoning: {effort: 'xhigh'}},
        safetyIdentifier: 'safe-hash',
        user: 'deprecated-id',
      });
      assert.equal(f.requests.length, 1);
      const request = f.requests[0];
      assert.equal(request.headers.get('authorization'), 'Bearer fixture-key');
      const body = await requestFields(request);
      assert.equal(body.model, 'gpt-image-2.6-flare');
      assert.equal(body.quality, 'max');
      assert.equal(body.complexity, 'medium');
      assert.equal(body.output_format, 'svg');
      assert.equal(body.safety_identifier, 'safe-hash');
      assert.equal(body.user, undefined);
      if (operation === 'generate') {
        assert.deepEqual(body.svg, {
          model: 'svg-author',
          reasoning: {effort: 'xhigh'},
        });
      } else {
        assert.equal(body['svg[model]'], 'svg-author');
        assert.equal(body['svg[reasoning][effort]'], 'xhigh');
        assert.ok(body.image instanceof File);
      }
      const image = result.details.images[0];
      assert.equal(extname(image.path), '.svg');
      assert.equal(image.mimeType, 'image/svg+xml');
      assert.equal(image.bytes, svgBytes.length);
      assert.equal(image.source, 'base64');
      assert.deepEqual(await readFile(image.path), svgBytes);
      assert.equal(result.details.request.operation, operation);
      assert.equal(result.details.request.complexity, 'medium');
      const registry = new ConversationImageRegistry();
      const attachment = registry.registerPath(image.path, f.cwd);
      const preview = await registry.read(attachment.id);
      assert.match(preview.src, /^data:image\/png;base64,/);
      assert.equal(preview.width, 16);
      assert.equal(preview.height, 16);
      assert.deepEqual(await readFile(image.path), svgBytes);
    },
  );

  void test(
    `${operation} forwards GIF frame controls and saves GIF for conversation previews`,
    {timeout: 15000},
    async t => {
      const f = await fixture(t, gifBytes);
      if (operation === 'edit') await sourceImage(f.cwd);
      const result = await f.call({
        ...(operation === 'edit' ? {inputImagePaths: ['source.png']} : {}),
        outputFormat: 'GIF',
        size: '512x512',
        frameCount: 2,
        frameDurationMs: 655359,
        complexity: 'low',
        safetyIdentifier: '',
        user: 'legacy-id',
      });
      const body = await requestFields(f.requests[0]);
      assert.equal(body.output_format, 'gif');
      assert.equal(body.size, '512x512');
      assert.equal(Number(body.frame_count), 2);
      assert.equal(Number(body.frame_duration_ms), 655359);
      assert.equal(body.complexity, 'low');
      assert.equal(body.safety_identifier, undefined);
      assert.equal(body.user, 'legacy-id');
      const image = result.details.images[0];
      assert.equal(extname(image.path), '.gif');
      assert.equal(image.mimeType, 'image/gif');
      assert.deepEqual(await readFile(image.path), gifBytes);
      const registry = new ConversationImageRegistry();
      const attachment = registry.registerPath(image.path, f.cwd);
      const preview = await registry.read(attachment.id, 'full');
      assert.match(preview.src, /^data:image\/png;base64,/);
      assert.equal(preview.width, 1);
      assert.equal(preview.height, 1);
      assert.deepEqual(await readFile(image.path), gifBytes);
    },
  );
}

void test(
  'GIF omits frame controls to use API defaults and respects an explicit environment size',
  {timeout: 5000},
  async t => {
    const f = await fixture(t, gifBytes);
    await f.call({outputFormat: 'gif'});
    const defaults = await f.requests[0].json();
    assert.equal(defaults.size, 'auto');
    assert.equal(defaults.frame_count, undefined);
    assert.equal(defaults.frame_duration_ms, undefined);
    assert.equal(defaults.complexity, undefined);
    assert.equal(defaults.svg, undefined);
    process.env.OPENAI_IMAGE_SIZE = '640x480';
    await f.call({outputFormat: 'gif'});
    assert.equal((await f.requests[1].json()).size, '640x480');
  },
);

void test(
  'SVG can use the API default author and a 128-character safety identifier',
  {timeout: 5000},
  async t => {
    const f = await fixture(t);
    process.env.OPENAI_IMAGE_OUTPUT_FORMAT = 'svg';
    const identifier = 'h'.repeat(128);
    await f.call({
      model: 'gpt-image-2.6-sunburst',
      safetyIdentifier: identifier,
    });
    const body = await f.requests[0].json();
    assert.equal(body.model, 'gpt-image-2.6-sunburst');
    assert.equal(body.output_format, 'svg');
    assert.equal(body.svg, undefined);
    assert.equal(body.safety_identifier, identifier);
  },
);

for (const [format, bytes, mimeType] of [
  ['svg', svgBytes, 'image/svg+xml'],
  ['gif', gifBytes, 'image/gif'],
] as const) {
  void test(
    `legacy URL image responses save ${format} with the returned media type`,
    {timeout: 5000},
    async t => {
      const f = await fixture(t);
      t.mock.method(
        globalThis,
        'fetch',
        async (input: RequestInfo | URL, init?: RequestInit) => {
          if (input === 'data:,') return new Response();
          const request = new Request(input, init);
          if (request.url === 'https://images.example.test/result')
            return new Response(bytes, {
              headers: {'content-type': `${mimeType}; charset=utf-8`},
            });
          assert.equal(new URL(request.url).pathname, '/v1/images/generations');
          return Response.json({
            data: [{url: 'https://images.example.test/result'}],
          });
        },
      );
      const result = await f.call({outputFormat: format});
      const image = result.details.images[0];
      assert.equal(extname(image.path), `.${format}`);
      assert.equal(image.source, 'url');
      assert.equal(image.mimeType, `${mimeType}; charset=utf-8`);
      assert.deepEqual(await readFile(image.path), bytes);
    },
  );
}

void test(
  'markup edit uploads a transparent local PNG matching the oriented first image',
  {timeout: 15000},
  async t => {
    const f = await fixture(t);
    const first = await sharp({
      create: {width: 3, height: 2, channels: 3, background: 'blue'},
    })
      .jpeg()
      .withMetadata({orientation: 6})
      .toBuffer();
    const overlay = await sharp({
      create: {width: 2, height: 3, channels: 4, background: '#ff000080'},
    })
      .png()
      .toBuffer();
    await writeFile(join(f.cwd, 'first.jpg'), first);
    await writeFile(join(f.cwd, 'markup.png'), overlay);
    await sourceImage(f.cwd);
    const result = await f.call({
      inputImagePaths: ['@first.jpg', 'source.png'],
      markupImagePath: '@markup.png',
      outputFormat: 'png',
      complexity: 'high',
      safetyIdentifier: 'edit-safe-hash',
    });
    const form = await f.requests[0].formData();
    const inputs = form.getAll('image[]');
    assert.equal(inputs.length, 2);
    assert.ok(inputs[0] instanceof File);
    assert.deepEqual(Buffer.from(await inputs[0].arrayBuffer()), first);
    const markup = form.get('markup');
    assert.ok(markup instanceof File);
    assert.equal(markup.name, 'markup.png');
    assert.equal(markup.type, 'image/png');
    assert.deepEqual(Buffer.from(await markup.arrayBuffer()), overlay);
    assert.equal(form.get('mask'), null);
    assert.equal(form.get('complexity'), 'high');
    assert.equal(form.get('safety_identifier'), 'edit-safe-hash');
    assert.deepEqual(result.details.request.markupImage, {
      path: join(f.cwd, 'markup.png'),
      mimeType: 'image/png',
      bytes: overlay.length,
    });
    assert.ok(
      f.updates.every(
        update => !JSON.stringify(update.details).includes('upload'),
      ),
    );
  },
);

void test(
  'mask edits upload the local alpha PNG',
  {timeout: 15000},
  async t => {
    const f = await fixture(t);
    await sourceImage(f.cwd);
    const mask = await sharp({
      create: {width: 3, height: 2, channels: 4, background: '#ffffff00'},
    })
      .png()
      .toBuffer();
    await writeFile(join(f.cwd, 'mask.png'), mask);
    const result = await f.call({
      inputImagePaths: ['source.png'],
      maskImagePath: 'mask.png',
    });
    const form = await f.requests[0].formData();
    const upload = form.get('mask');
    assert.ok(upload instanceof File);
    assert.deepEqual(Buffer.from(await upload.arrayBuffer()), mask);
    assert.equal(form.get('markup'), null);
    assert.deepEqual(result.details.request.maskImage, {
      path: join(f.cwd, 'mask.png'),
      mimeType: 'image/png',
      bytes: mask.length,
    });
  },
);

const invalidOptions: Array<[Record<string, unknown>, RegExp]> = [
  [
    {markupImagePath: 'markup.png', maskImagePath: 'mask.png'},
    /cannot be combined/,
  ],
  [{markupImagePath: 'markup.png'}, /require inputImagePaths/],
  [{maskImagePath: 'mask.png'}, /require inputImagePaths/],
  [
    {
      outputFormat: 'gif',
      maskImagePath: 'mask.png',
      inputImagePaths: ['source.png'],
    },
    /does not support masks/,
  ],
  [{frameCount: 2}, /require GIF/],
  [{frameDurationMs: 200}, /require GIF/],
  [{outputFormat: 'gif', frameCount: 1}, /integer from 2 through 16/],
  [{outputFormat: 'gif', frameCount: 17}, /integer from 2 through 16/],
  [{outputFormat: 'gif', frameCount: 2.5}, /integer from 2 through 16/],
  [{outputFormat: 'gif', frameDurationMs: 19}, /integer of at least 20/],
  [{outputFormat: 'gif', frameDurationMs: 20.5}, /integer of at least 20/],
  [{outputFormat: 'gif', size: '513x512'}, /dimensions divisible by 16/],
  [{outputFormat: 'gif', size: '0x512'}, /dimensions divisible by 16/],
  [{outputFormat: 'gif', size: 'square'}, /dimensions divisible by 16/],
  [{outputFormat: 'gif', outputCompression: 50}, /requires JPEG or WebP/],
  [{outputFormat: 'svg', outputCompression: 50}, /requires JPEG or WebP/],
  [{outputFormat: 'svg', n: 2}, /requires n=1/],
  [{outputFormat: 'svg', n: 1.1}, /requires n=1/],
  [{svg: {model: 'author'}}, /require SVG/],
  [{outputFormat: 'svg', svg: {model: ' '}}, /must name an SVG author/],
  [{outputFormat: 'gif', background: 'transparent'}, /require PNG or WebP/],
  [{safetyIdentifier: 'x'.repeat(129)}, /at most 128/],
];
for (const [options, error] of invalidOptions) {
  void test(
    `invalid image options fail before a billed request: ${JSON.stringify(options)}`,
    {timeout: 5000},
    async t => {
      const f = await fixture(t);
      await assert.rejects(f.call(options), error);
      assert.equal(f.requests.length, 0);
    },
  );
}

for (const [name, width, channels, background, error] of [
  ['wrong dimensions', 4, 4, '#ff000080', /dimensions must match/],
  ['no alpha', 3, 3, '#ff0000', /alpha channel/],
  ['opaque alpha', 3, 4, '#ff0000ff', /transparent pixels/],
] as const) {
  void test(
    `markup rejects ${name} before making a request`,
    {timeout: 15000},
    async t => {
      const f = await fixture(t);
      await sourceImage(f.cwd);
      const markup = await sharp({
        create: {width, height: 2, channels, background},
      })
        .png()
        .toBuffer();
      await writeFile(join(f.cwd, 'markup.png'), markup);
      await assert.rejects(
        f.call({
          inputImagePaths: ['source.png'],
          markupImagePath: 'markup.png',
        }),
        error,
      );
      assert.equal(f.requests.length, 0);
    },
  );
}

void test(
  'image cancellation before execution prevents a request',
  {timeout: 5000},
  async t => {
    const f = await fixture(t);
    const controller = new AbortController();
    controller.abort(new Error('cancelled fixture'));
    await assert.rejects(
      f.call({outputFormat: 'gif'}, controller.signal),
      /cancelled fixture/,
    );
    assert.equal(f.requests.length, 0);
  },
);

for (const mode of ['cancel', 'timeout'] as const) {
  void test(
    `image ${mode} aborts an in-flight GIF request without saving a result`,
    {timeout: 5000},
    async t => {
      const f = await fixture(t);
      const controller = new AbortController();
      let started!: () => void;
      const pending = new Promise<void>(resolve => {
        started = resolve;
      });
      t.mock.method(
        globalThis,
        'fetch',
        async (input: RequestInfo | URL, init?: RequestInit) => {
          if (input === 'data:,') return new Response();
          const request = new Request(input, init);
          started();
          return new Promise<Response>((_resolve, reject) => {
            if (request.signal.aborted) reject(request.signal.reason);
            else
              request.signal.addEventListener(
                'abort',
                () => reject(request.signal.reason),
                {once: true},
              );
          });
        },
      );
      const result = f.call(
        {outputFormat: 'gif', timeoutMs: mode === 'timeout' ? 100 : 3000},
        controller.signal,
      );
      const rejected = assert.rejects(result, /abort|timed out/i);
      await pending;
      if (mode === 'cancel') controller.abort(new Error('cancelled fixture'));
      await rejected;
      assert.ok(f.updates.every(update => update.details.images.length === 0));
    },
  );
}
