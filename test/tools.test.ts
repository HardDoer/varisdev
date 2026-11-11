import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import sharp from 'sharp';
import registerVarisdev from '../extensions/varisdev.ts';
import {registerBrowseTool} from '../src/tools/browse.ts';
import {registerDownloadTool} from '../src/tools/download.ts';
import {registerGameMakerQueryTool} from '../src/tools/gamemaker-query.ts';
import {registerImageQueryTool} from '../src/tools/image-query.ts';
import {registerJsonQueryTool} from '../src/tools/json-query.ts';
import {registerProjectTools} from '../src/tools/index.ts';

type ToolResult = {
  content: Array<{type: string; text?: string}>;
  details: unknown;
};

type CapturedTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: ToolResult) => void) | undefined,
    ctx: {cwd: string},
  ) => Promise<ToolResult>;
};

type QueryDetails = {
  summary: {
    filesProcessed: number;
    filesSucceeded: number;
    filesFailed: number;
    collectionCount: number;
    matchedCount: number;
  };
  files: Array<{
    rootKeys?: string[];
    groups?: Array<{key: string; count: number}>;
    samples?: string[];
  }>;
};

function captureTool(register: (pi: ExtensionAPI) => void): CapturedTool {
  let captured: CapturedTool | undefined;
  const pi = {
    registerTool(definition: unknown) {
      captured = definition as CapturedTool;
    },
  } as unknown as ExtensionAPI;

  register(pi);
  assert.ok(captured, 'the tool should be registered');
  return captured;
}

function responseWithUrl(
  body: BodyInit | null,
  init: ResponseInit,
  url: string,
): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, 'url', {value: url});
  return response;
}

function resultText(result: ToolResult): string {
  const content = result.content[0];
  assert.equal(content?.type, 'text');
  return content.text ?? '';
}

async function makeTempDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

void test('VarisDev registers its tools without built-in image generation or memory tools', () => {
  const toolNames: string[] = [];
  const pi = {
    registerTool(definition: CapturedTool) {
      toolNames.push(definition.name);
    },
    on() {},
    registerCommand() {},
    registerEntryRenderer() {},
    registerMarkdownTransformer() {},
    events: {on: () => () => {}},
  } as unknown as ExtensionAPI;

  registerVarisdev(pi);

  assert.deepEqual(toolNames, [
    'browse',
    'download',
    'gamemaker_query',
    'image_query',
    'image_preview',
    'json_query',
    'agent_templates',
    'agent_spawn',
    'agent_list',
    'agent_inbox',
    'agent_status',
    'agent_send',
    'agent_wait',
    'agent_cancel',
  ]);
  assert.equal(toolNames.includes('openai_image'), false);
  assert.equal(
    toolNames.some(name => name.startsWith('memory_')),
    false,
  );
});

void test('browse selects JSON fields and returns response details', async () => {
  const tool = captureTool(registerBrowseTool);
  const originalFetch = globalThis.fetch;
  const requestedUrl = 'https://example.test/api';

  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), requestedUrl);
    assert.equal(init?.method, 'GET');
    return responseWithUrl(
      JSON.stringify({
        schemas: {Track: {type: 'object'}},
        ignored: 'not selected',
      }),
      {
        status: 200,
        statusText: 'OK',
        headers: {'content-type': 'application/json'},
      },
      requestedUrl,
    );
  }) as typeof fetch;

  try {
    const result = await tool.execute(
      'browse-test',
      {url: requestedUrl, jsonPointers: ['/schemas/Track']},
      undefined,
      undefined,
      {cwd: process.cwd()},
    );
    const text = resultText(result);
    const details = result.details as {
      response: {status: number; contentType: string};
    };

    assert.match(text, /Selected JSON:/);
    assert.match(text, /"\/schemas\/Track"/);
    assert.doesNotMatch(text, /not selected/);
    assert.equal(details.response.status, 200);
    assert.equal(details.response.contentType, 'application/json');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test('browse preserves HTML text and links with invalid numeric entities', async t => {
  const tool = captureTool(registerBrowseTool);
  const url = 'https://example.test/page';
  t.mock.method(globalThis, 'fetch', async () =>
    responseWithUrl(
      '<html><head><title>Title &#1114112;</title></head><body>' +
        '<p>Before &#x110000; &#0; &#xD800; &#999999999999999999999; after</p>' +
        '<p>Valid &#65; &#x1F642; &amp;</p>' +
        '<a href="/target?value=&#x110000;">Link &#1114112;</a>' +
        '</body></html>',
      {headers: {'content-type': 'text/html'}},
      url,
    ),
  );

  for (const view of ['auto', 'text', 'links', 'raw']) {
    const result = await tool.execute(
      'browse-entities',
      {url, view},
      undefined,
      undefined,
      {cwd: process.cwd()},
    );
    const details = result.details as {
      response: {title: string; links: Array<{text: string; url: string}>};
    };
    assert.equal(details.response.title, 'Title \uFFFD');
    assert.deepEqual(details.response.links, [
      {text: 'Link \uFFFD', url: 'https://example.test/target?value=%EF%BF%BD'},
    ]);
    if (view === 'auto' || view === 'text') {
      assert.match(
        resultText(result),
        /Before \uFFFD \uFFFD \uFFFD \uFFFD after/,
      );
      assert.match(resultText(result), /Valid A 🙂 &/);
    }
    if (view === 'raw') assert.match(resultText(result), /&#x110000;/);
  }
});

void test('download saves relative paths under the tool cwd and reports details', async () => {
  const tool = captureTool(registerDownloadTool);
  const cwd = await makeTempDirectory('varisdev-download-');
  const originalFetch = globalThis.fetch;
  const payload = Buffer.from('download payload');
  const requestedUrl = 'https://example.test/archive.bin';

  globalThis.fetch = (async input => {
    assert.equal(String(input), requestedUrl);
    return responseWithUrl(
      payload,
      {
        status: 200,
        statusText: 'OK',
        headers: {'content-type': 'application/octet-stream'},
      },
      requestedUrl,
    );
  }) as typeof fetch;

  try {
    const result = await tool.execute(
      'download-test',
      {url: requestedUrl, path: '@downloads/archive.bin'},
      undefined,
      undefined,
      {cwd},
    );
    const outputPath = join(cwd, 'downloads', 'archive.bin');
    const details = result.details as {
      requestUrl: string;
      responseUrl: string;
      path: string;
      bytes: number;
      contentType?: string;
    };

    assert.deepEqual(await readFile(outputPath), payload);
    assert.equal(details.requestUrl, requestedUrl);
    assert.equal(details.responseUrl, requestedUrl);
    assert.equal(details.path, outputPath);
    assert.equal(details.bytes, payload.byteLength);
    assert.equal(details.contentType, 'application/octet-stream');
    assert.match(resultText(result), /Successfully downloaded/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(cwd, {recursive: true, force: true});
  }
});

void test('download rejects unsupported URL schemes before fetching', async () => {
  const tool = captureTool(registerDownloadTool);
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;

  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error('fetch should not be called');
  }) as typeof fetch;

  try {
    await assert.rejects(
      tool.execute(
        'download-scheme-test',
        {url: 'file:///tmp/source', path: 'source.bin'},
        undefined,
        undefined,
        {cwd: process.cwd()},
      ),
      /only supports http:\/\/ and https:\/\//,
    );
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test('json_query filters, groups, and samples a nested collection', async () => {
  const tool = captureTool(registerJsonQueryTool);
  const cwd = await makeTempDirectory('varisdev-json-query-');

  try {
    await writeFile(
      join(cwd, 'records.json'),
      JSON.stringify({
        records: [
          {kind: 'unit', owner: {id: 1}, name: 'alpha'},
          {kind: 'unit', owner: {id: 1}, name: 'beta'},
          {kind: 'unit', owner: {id: 2}, name: 'gamma'},
          {kind: 'building', owner: {id: 1}, name: 'base'},
        ],
      }),
    );

    const result = await tool.execute(
      'json-query-test',
      {
        path: '@*.json',
        collectionPath: 'records',
        where: {kind: 'unit'},
        groupBy: ['owner.id'],
        select: ['name', 'owner.id'],
        sampleLimit: 2,
        includeRootKeys: true,
      },
      undefined,
      undefined,
      {cwd},
    );
    const details = result.details as QueryDetails;

    assert.deepEqual(details.summary, {
      filesProcessed: 1,
      filesSucceeded: 1,
      filesFailed: 0,
      fileLimitReached: false,
      collectionCount: 4,
      matchedCount: 3,
    });
    assert.deepEqual(details.files[0]?.rootKeys, ['records']);
    assert.deepEqual(details.files[0]?.groups, [
      {key: 'owner.id=1', count: 2},
      {key: 'owner.id=2', count: 1},
    ]);
    assert.deepEqual(details.files[0]?.samples, [
      '{"name":"alpha","owner.id":1}',
      '{"name":"beta","owner.id":1}',
    ]);
    assert.match(resultText(result), /Totals: 3 matched of 4 items/);
  } finally {
    await rm(cwd, {recursive: true, force: true});
  }
});

void test('structured queries preserve selected __proto__ fields and missing values', async t => {
  const cwd = await makeTempDirectory('varisdev-query-fields-');
  t.after(() => rm(cwd, {recursive: true, force: true}));
  for (const [filename, register] of [
    ['records.json', registerJsonQueryTool],
    ['records.yy', registerGameMakerQueryTool],
  ] as const) {
    await writeFile(
      join(cwd, filename),
      '[{"name":"present","__proto__":{"id":7}},{"name":"missing"}]',
    );
    const tool = captureTool(register);
    const result = await tool.execute(
      'query-special-fields',
      {path: filename, select: ['name', '__proto__'], sampleLimit: 2},
      undefined,
      undefined,
      {cwd},
    );
    const details = result.details as QueryDetails;
    assert.equal(details.summary.filesSucceeded, 1);
    assert.deepEqual(details.files[0]?.samples, [
      '{"__proto__":{"id":7},"name":"present"}',
      '{"__proto__":"<missing>","name":"missing"}',
    ]);
  }
});

void test('gamemaker_query accepts comments and trailing commas', async () => {
  const tool = captureTool(registerGameMakerQueryTool);
  const cwd = await makeTempDirectory('varisdev-gamemaker-query-');

  try {
    await writeFile(
      join(cwd, 'project.yyp'),
      `{
        // GameMaker resources permit JSON-like syntax.
        "resources": [
          {"id": {"name": "spr_player",},},
          {"id": {"name": "obj_player",},},
        ],
      }`,
    );

    const result = await tool.execute(
      'gamemaker-query-test',
      {
        path: '*.yyp',
        collectionPath: 'resources',
        select: ['id.name'],
        sampleLimit: 2,
      },
      undefined,
      undefined,
      {cwd},
    );
    const details = result.details as QueryDetails;

    assert.equal(details.summary.filesSucceeded, 1);
    assert.equal(details.summary.collectionCount, 2);
    assert.equal(details.summary.matchedCount, 2);
    assert.deepEqual(details.files[0]?.samples, [
      '{"id.name":"spr_player"}',
      '{"id.name":"obj_player"}',
    ]);
  } finally {
    await rm(cwd, {recursive: true, force: true});
  }
});

void test('image_query reports alpha bounds and row-major grid occupancy', async () => {
  const tool = captureTool(registerImageQueryTool);
  const cwd = await makeTempDirectory('varisdev-image-query-');
  const imagePath = join(cwd, 'alpha.png');

  try {
    await sharp(
      Buffer.from([
        255, 0, 0, 0, 255, 0, 0, 128, 255, 0, 0, 255, 255, 0, 0, 255,
      ]),
      {raw: {width: 2, height: 2, channels: 4}},
    )
      .png()
      .toFile(imagePath);

    const result = await tool.execute(
      'image-query-test',
      {
        path: 'alpha.png',
        alphaThreshold: 127,
        grid: {cellWidth: 1, cellHeight: 1},
      },
      undefined,
      undefined,
      {cwd},
    );
    const details = result.details as {
      summary: {totalPixels: number; matchingPixels: number};
      files: Array<{
        width: number;
        height: number;
        alpha: {
          matchingPixels: number;
          transparentPixels: number;
          translucentPixels: number;
          opaquePixels: number;
          bounds: {x: number; y: number; width: number; height: number};
        };
        grid: {matchingPixels: number[][]; totalPixels: number[][]};
      }>;
    };
    const file = details.files[0];

    assert.ok(file);
    assert.equal(file.width, 2);
    assert.equal(file.height, 2);
    assert.deepEqual(details.summary, {
      filesProcessed: 1,
      filesSucceeded: 1,
      filesFailed: 0,
      fileLimitReached: false,
      totalPixels: 4,
      matchingPixels: 3,
    });
    assert.equal(file.alpha.matchingPixels, 3);
    assert.equal(file.alpha.transparentPixels, 1);
    assert.equal(file.alpha.translucentPixels, 1);
    assert.equal(file.alpha.opaquePixels, 2);
    assert.deepEqual(file.alpha.bounds, {x: 0, y: 0, width: 2, height: 2});
    assert.deepEqual(file.grid.matchingPixels, [
      [0, 1],
      [1, 1],
    ]);
    assert.deepEqual(file.grid.totalPixels, [
      [1, 1],
      [1, 1],
    ]);
  } finally {
    await rm(cwd, {recursive: true, force: true});
  }
});

void test('project tools retain local image previews without built-in image generation', async t => {
  const tools = new Map<string, CapturedTool>();
  registerProjectTools({
    registerTool(tool: CapturedTool) {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI);
  assert.equal(tools.has('openai_image'), false);
  assert.ok(tools.has('image_query'));
  const preview = tools.get('image_preview');
  assert.ok(preview);

  const cwd = await makeTempDirectory('varisdev-project-preview-');
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const path = join(cwd, 'existing image.png');
  const bytes = await sharp({
    create: {width: 4, height: 2, channels: 4, background: '#16a085'},
  })
    .png()
    .toBuffer();
  await writeFile(path, bytes);

  const result = await preview.execute(
    'project-preview',
    {path: '@existing image.png'},
    undefined,
    undefined,
    {cwd},
  );
  assert.match(
    resultText(result),
    /Image preview: .*existing image\.png \(4×2, png\)/,
  );
  assert.deepEqual(result.details, {
    varisdev: {version: 1, blocks: [{type: 'image', path}]},
    images: [{path, width: 4, height: 2}],
  });
  assert.deepEqual(await readFile(path), bytes);
});
