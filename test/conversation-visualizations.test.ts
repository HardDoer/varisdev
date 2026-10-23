import assert from 'node:assert/strict';
import {mkdtemp, open, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {before, test} from 'node:test';
import type {
  AgentSessionEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from '@earendil-works/pi-coding-agent';
import type {AgentSessionController} from '../src/agents/team.ts';
import {WorkerConversation} from '../src/agents/conversation.ts';
import {
  ConversationState,
  conversationVisualizations,
} from '../src/conversation.ts';
import {
  ConversationImageRegistry,
  readConversationImage,
} from '../src/conversation-images.ts';
import {observeDashboardSession} from '../src/dashboard/observe.ts';
import type {DashboardState} from '../src/dashboard/state.ts';
import {processImage} from '../src/sharp.ts';
import {
  visualResult,
  visualizationDetails,
  type ConversationImage,
} from '../src/visualizations.ts';

let png: Buffer;
before(async () => {
  const result = await processImage({
    input: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="3200" height="1600"><rect width="3200" height="1600" fill="#4c79a8"/></svg>',
    ),
    output: 'png',
    limitInputPixels: 40_000_000,
  });
  png = result.data;
});

async function directory(t: {after: (fn: () => Promise<void>) => void}) {
  const cwd = await mkdtemp(join(tmpdir(), 'varisdev-visualizations-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  await writeFile(join(cwd, 'picture.png'), png);
  return cwd;
}

function parent(cwd: string) {
  type Handler = (event: never, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler[]>();
  let branch: SessionEntry[] = [];
  let state!: DashboardState;
  const pi = {
    events: {on: () => () => {}},
    getThinkingLevel: () => 'off',
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    isIdle: () => true,
    getContextUsage: () => undefined,
    sessionManager: {
      getSessionName: () => 'Visualization fixture',
      getSessionId: () => 'visual-fixture',
      getSessionFile: () => join(cwd, 'session.jsonl'),
      getHeader: () => undefined,
      getBranch: () => branch,
    },
  } as unknown as ExtensionContext;
  const custom = observeDashboardSession(
    pi,
    {
      snapshot: () => undefined,
      subscribe: () => () => {},
    } as unknown as AgentSessionController,
    value => {
      state = value;
    },
  );
  return {
    ctx,
    custom,
    async emit(type: string, event: object = {}) {
      for (const handler of handlers.get(type) ?? [])
        await handler({...event, type} as never, ctx);
    },
    history(value: SessionEntry[]) {
      branch = value;
    },
    get state() {
      return state;
    },
  };
}

void test('public helpers produce a plain versioned JSON result and copy plugin blocks', () => {
  const blocks = [
    {type: 'markdown' as const, text: '**Report**'},
    {type: 'progress' as const, value: 3, total: 5},
  ];
  const result = visualResult('Report created', blocks);
  blocks[0].text = 'Changed';
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    content: [{type: 'text', text: 'Report created'}],
    details: {
      varisdev: {
        version: 1,
        blocks: [
          {type: 'markdown', text: '**Report**'},
          {type: 'progress', value: 3, total: 5},
        ],
      },
    },
  });
});

void test('image metadata is registered synchronously, legacy dimensions survive and inline payloads never enter snapshots', async t => {
  const cwd = await directory(t);
  const details = {
    ...visualizationDetails([
      {type: 'image', path: 'picture.png', label: 'Result'},
    ]),
    images: [{path: 'picture.png', width: 3200, height: 1600}],
  };
  const visuals = conversationVisualizations(
    {
      content: [
        {type: 'image', mimeType: 'image/png', data: png.toString('base64')},
      ],
      details,
    },
    undefined,
    cwd,
  );
  assert.equal(visuals.visualizations?.length, 2);
  const image = visuals.visualizations![0] as ConversationImage;
  assert.equal(image.path, join(cwd, 'picture.png'));
  assert.equal(image.width, 3200);
  assert.equal(image.height, 1600);
  assert.equal(image.label, 'Result');
  const state = new ConversationState();
  state.update({
    id: 'images',
    at: new Date().toISOString(),
    role: 'user',
    text: '',
    ...visuals,
  });
  const encoded = JSON.stringify(state.snapshot());
  assert.ok(!encoded.includes(png.toString('base64')));
  assert.ok(!encoded.includes('base64'));
  assert.ok(!encoded.includes('mimeType'));
  state.snapshot().conversation[0].visualizations![0].type = 'image';
  (
    state.snapshot().conversation[0].visualizations![0] as ConversationImage
  ).name = 'mutated';
  assert.equal(
    (state.snapshot().conversation[0].visualizations![0] as ConversationImage)
      .name,
    'picture.png',
  );
  const full = await readConversationImage(image.id, 'full');
  assert.equal(full.width, 2560);
  assert.equal(full.height, 1280);
  assert.match(full.src, /^data:image\/png;base64,/);
  const inline = await readConversationImage(
    (visuals.visualizations![1] as ConversationImage).id,
  );
  assert.equal(inline.width, 640);
  assert.equal(inline.height, 320);
  const legacy = conversationVisualizations(
    {details: {images: [{path: 'picture.png', width: 3200, height: 1600}]}},
    undefined,
    cwd,
  );
  assert.equal((legacy.visualizations![0] as ConversationImage).id, image.id);
});

void test('malformed versions, types and fields produce bounded visible diagnostics alongside ordinary text', () => {
  for (const varisdev of [
    null,
    {version: 2, blocks: []},
    {version: 1, blocks: 'bad'},
  ]) {
    const result = conversationVisualizations({details: {varisdev}});
    assert.equal(result.visualizations, undefined);
    assert.ok(result.visualizationErrors?.length);
  }
  const invalid = conversationVisualizations({
    details: {
      varisdev: {
        version: 1,
        blocks: [
          {type: 'html', text: '<script>bad()</script>'},
          {type: 'image', path: 'https://invalid/picture.png'},
          {type: 'markdown', text: 1},
          {type: 'progress', value: Infinity},
          {type: 'progress', value: 1, total: 0},
          {type: 'image'},
          null,
          {type: 'progress', value: NaN},
          ...Array(20).fill({type: 'unknown'}),
        ],
      },
    },
  });
  assert.equal(invalid.visualizations, undefined);
  assert.ok(invalid.visualizationErrors!.length <= 8);
  assert.ok(invalid.visualizationErrors!.every(error => error.length <= 200));
  const state = new ConversationState();
  state.update({
    id: 'bad',
    role: 'tool',
    at: '',
    text: 'The tool still returned ordinary text',
    ...invalid,
  });
  assert.equal(
    state.snapshot().conversation[0].text,
    'The tool still returned ordinary text',
  );
  const large = conversationVisualizations({
    details: {
      varisdev: {
        version: 1,
        blocks: Array(10).fill({
          type: 'markdown',
          text: 'a'.repeat(20000) + 'data:image/png;base64,c2VjcmV0',
        }),
      },
    },
  });
  assert.equal(large.visualizations?.length, 8);
  assert.ok(
    large.visualizations!.every(
      block => block.type === 'markdown' && block.text.length === 16000,
    ),
  );
  assert.ok(!JSON.stringify(large).includes('c2VjcmV0'));
  assert.ok(large.visualizationErrors!.length <= 8);
});

void test('parent and worker conversations preserve image-only messages, tool progress, displayed metadata and restored history', async t => {
  const cwd = await directory(t);
  const observer = parent(cwd);
  await observer.emit('session_start');
  const worker = new WorkerConversation([], cwd);
  const timestamp = Date.parse('2026-01-01T00:00:00Z');
  const attachment = {
    role: 'user',
    timestamp,
    content: [
      {type: 'image', mimeType: 'image/png', data: png.toString('base64')},
    ],
  };
  async function emit(type: string, event: object) {
    await observer.emit(type, event);
    worker.record({...event, type} as AgentSessionEvent);
  }
  await emit('message_start', {message: attachment});
  await emit('message_end', {message: attachment});
  await emit('tool_execution_start', {
    toolCallId: 'image',
    toolName: 'plugin',
    args: {},
  });
  await emit('tool_execution_update', {
    toolCallId: 'image',
    toolName: 'plugin',
    args: {},
    partialResult: visualResult('Working', [
      {type: 'progress', value: 2, total: 4, label: 'Rendering'},
    ]),
  });
  for (const snapshot of [observer.state.snapshot(), worker.snapshot()]) {
    assert.equal(snapshot.conversation.length, 2);
    assert.equal(snapshot.conversation[0].text, '');
    assert.equal(snapshot.conversation[0].visualizations![0].type, 'image');
    assert.deepEqual(snapshot.conversation[1].visualizations, [
      {type: 'progress', value: 2, total: 4, label: 'Rendering'},
    ]);
    assert.equal(snapshot.conversation[1].streaming, true);
  }
  const result = visualResult('Generated', [
    {type: 'image', path: 'picture.png'},
    {type: 'markdown', text: '**Generated report**'},
  ]);
  await emit('tool_execution_end', {
    toolCallId: 'image',
    toolName: 'plugin',
    result,
    isError: false,
  });
  const toolMessage = {
    role: 'toolResult',
    timestamp: timestamp + 1,
    toolCallId: 'image',
    toolName: 'plugin',
    ...result,
    isError: false,
  };
  await emit('message_end', {message: toolMessage});
  const custom = {
    role: 'custom' as const,
    customType: 'plugin.report',
    timestamp: timestamp + 2,
    content: [],
    display: true,
    details: visualizationDetails([
      {type: 'markdown', text: '# Plugin message'},
      {type: 'progress', value: 4},
    ]),
  };
  await emit('message_start', {message: custom});
  await emit('message_end', {message: custom});
  // The extension sendMessage observer reconciles the same object too.
  observer.custom(custom, observer.ctx);
  const hidden = {...custom, timestamp: timestamp + 3, display: false};
  await emit('message_end', {message: hidden});
  const branch = [
    {
      type: 'message',
      id: 'user',
      parentId: null,
      timestamp: new Date(timestamp).toISOString(),
      message: attachment,
    },
    {
      type: 'message',
      id: 'tool',
      parentId: 'user',
      timestamp: new Date(timestamp + 1).toISOString(),
      message: toolMessage,
    },
    {
      type: 'custom_message',
      id: 'custom',
      parentId: 'tool',
      ...custom,
      timestamp: new Date(timestamp + 2).toISOString(),
    },
  ] as unknown as SessionEntry[];
  for (const snapshot of [observer.state.snapshot(), worker.snapshot()]) {
    assert.equal(snapshot.conversation.length, 3);
    assert.equal(snapshot.conversation[1].status, 'completed');
    assert.equal(snapshot.conversation[1].visualizations?.length, 2);
    assert.equal(
      (snapshot.conversation[1].visualizations![0] as ConversationImage).path,
      join(cwd, 'picture.png'),
    );
    assert.equal(snapshot.conversation[2].text, '');
    assert.equal(snapshot.conversation[2].visualizations?.length, 2);
    assert.ok(!JSON.stringify(snapshot).includes(png.toString('base64')));
  }
  const live = observer.state.snapshot().conversation;
  observer.history(branch);
  await observer.emit('session_tree');
  const restoredWorker = new WorkerConversation(branch, cwd).snapshot()
    .conversation;
  const restoredParent = observer.state.snapshot().conversation;
  assert.deepEqual(
    restoredParent.map(row => row.visualizations),
    live.map(row => row.visualizations),
  );
  assert.deepEqual(
    restoredWorker.map(row => row.visualizations),
    live.map(row => row.visualizations),
  );
});

void test('registry returns PNG rasters, deduplicates work, caps decode concurrency and validates changed or missing files', async t => {
  const cwd = await directory(t);
  const registry = new ConversationImageRegistry();
  const images = [];
  for (let index = 0; index < 5; index++) {
    const name = `picture-${index}.png`;
    await writeFile(join(cwd, name), png);
    images.push(registry.registerPath(name, cwd));
  }
  const jobs = images.map(image => registry.read(image.id));
  const duplicate = registry.read(images[0].id);
  assert.equal(registry.stats.active, 2);
  assert.equal(registry.stats.queued, 3);
  const results = await Promise.all([...jobs, duplicate]);
  assert.deepEqual(results[0], results[5]);
  assert.ok(
    results.every(
      result =>
        result.width === 640 &&
        result.height === 320 &&
        result.src.startsWith('data:image/png;base64,'),
    ),
  );
  assert.equal(registry.stats.active, 0);
  assert.equal(registry.stats.queued, 0);
  assert.ok(registry.stats.cacheBytes <= 32 * 1024 * 1024);
  assert.deepEqual(await registry.read(images[0].id), results[0]);
  await rm(images[0].path!);
  await assert.rejects(registry.read(images[0].id), /missing or unreadable/);
  await writeFile(images[1].path!, 'invalid raster');
  await assert.rejects(registry.read(images[1].id), /Could not decode/);
  await assert.rejects(
    registry.read(join(cwd, 'picture.png')),
    /no longer available/,
  );
  await assert.rejects(
    registry.read(images[2].id, 'other' as never),
    /Unknown.*variant/,
  );
});

void test('registry evicts sources and transformed caches within limits and rejects oversized files and pixel dimensions', async t => {
  const cwd = await directory(t);
  const registry = new ConversationImageRegistry({
    maxEntries: 2,
    maxCacheBytes: 100,
  });
  const first = registry.registerPath('picture.png', cwd);
  await registry.read(first.id);
  assert.equal(registry.stats.cacheBytes, 0);
  registry.registerPath('next.png', cwd);
  registry.registerPath('last.png', cwd);
  assert.equal(registry.stats.entries, 2);
  await assert.rejects(registry.read(first.id), /no longer available/);
  const tiny = new ConversationImageRegistry({
    maxStorageBytes: png.toString('base64').length * 2 - 1,
  });
  assert.throws(
    () => tiny.registerInline(png.toString('base64'), 'image/png'),
    /memory limit/,
  );
  assert.throws(
    () => registry.registerInline('%%%%', 'image/png'),
    /invalid base64/,
  );
  assert.throws(
    () => registry.registerInline('YWJj', 'text/html'),
    /unsupported media/,
  );
  const largePath = join(cwd, 'large.png');
  const large = await open(largePath, 'w');
  await large.truncate(51 * 1024 * 1024);
  await large.close();
  const largeImage = registry.registerPath(largePath);
  await assert.rejects(registry.read(largeImage.id), /exceeds 50 MiB/);
  await writeFile(
    join(cwd, 'pixels.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="7000" height="6000"><rect width="7000" height="6000"/></svg>',
  );
  const pixels = registry.registerPath('pixels.svg', cwd);
  await assert.rejects(registry.read(pixels.id), /pixel limit/);
});

void test('malformed plugin details remain visible with normal tool text in parent and worker live and restored messages', async () => {
  const observer = parent(join(tmpdir(), 'varisdev-visualization-diagnostics'));
  await observer.emit('session_start');
  const worker = new WorkerConversation([]);
  const result = {
    content: [{type: 'text', text: 'The report is saved'}],
    details: {
      varisdev: {version: 27, blocks: [{type: 'html', text: '<b>ignored</b>'}]},
    },
  };
  const event = {
    type: 'tool_execution_end',
    toolCallId: 'report',
    toolName: 'plugin',
    isError: false,
    result,
  };
  await observer.emit(event.type, event);
  worker.record(event as AgentSessionEvent);
  const message = {
    role: 'toolResult',
    toolCallId: 'report',
    toolName: 'plugin',
    isError: false,
    timestamp: 1000,
    ...result,
  };
  const branch = [
    {
      type: 'message',
      id: 'report',
      parentId: null,
      timestamp: new Date(1000).toISOString(),
      message,
    },
  ] as unknown as SessionEntry[];
  observer.history(branch);
  const live = [observer.state.snapshot(), worker.snapshot()];
  await observer.emit('session_tree');
  for (const snapshot of [
    ...live,
    observer.state.snapshot(),
    new WorkerConversation(branch).snapshot(),
  ]) {
    const row = snapshot.conversation[0];
    assert.equal(row.text, 'The report is saved');
    assert.equal(row.visualizations, undefined);
    assert.deepEqual(row.visualizationErrors, [
      'Unsupported VarisDev visualization version.',
    ]);
  }
});

void test('overwriting a local image produces a fresh serialized ID and raster while unchanged references reuse their ID', async t => {
  const cwd = await directory(t);
  const message = {
    details: visualizationDetails([
      {type: 'image' as const, path: 'picture.png'},
    ]),
  };
  const reference = () =>
    conversationVisualizations(message, undefined, cwd)
      .visualizations![0] as ConversationImage;
  const first = reference();
  assert.equal(reference().id, first.id);
  const initial = await readConversationImage(first.id);
  assert.equal(initial.width, 640);
  assert.equal(initial.height, 320);
  const replacement = await processImage({
    input: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#e54c26"/></svg>',
    ),
    output: 'png',
    limitInputPixels: 40_000_000,
  });
  await writeFile(join(cwd, 'picture.png'), replacement.data);
  const updated = reference();
  assert.notEqual(updated.id, first.id);
  assert.equal(updated.path, first.path);
  assert.equal(reference().id, updated.id);
  const fresh = await readConversationImage(updated.id);
  assert.equal(fresh.width, 120);
  assert.equal(fresh.height, 40);
  assert.notEqual(fresh.src, initial.src);
  const missing = conversationVisualizations(
    {details: visualizationDetails([{type: 'image', path: 'later.png'}])},
    undefined,
    cwd,
  ).visualizations![0] as ConversationImage;
  await assert.rejects(
    readConversationImage(missing.id),
    /missing or unreadable/,
  );
  await writeFile(join(cwd, 'later.png'), replacement.data);
  // A missing reference remains usable for a direct viewer retry too.
  assert.equal((await readConversationImage(missing.id)).width, 120);
  const available = conversationVisualizations(
    {details: visualizationDetails([{type: 'image', path: 'later.png'}])},
    undefined,
    cwd,
  ).visualizations![0] as ConversationImage;
  assert.notEqual(available.id, missing.id);
});
