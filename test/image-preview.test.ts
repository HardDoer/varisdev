/* eslint-disable no-control-regex -- Verify actual terminal control output. */
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {test, type TestContext} from 'node:test';
import {pathToFileURL} from 'node:url';
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from '@earendil-works/pi-coding-agent';
import {
  compositeTuiLine,
  resetCapabilitiesCache,
  setCapabilities,
  sliceByColumn,
  TuiAltScreen,
  TuiMainScreen,
  visibleWidth,
  type Terminal,
  type TUI,
  type Component,
} from '@earendil-works/pi-tui';
import sharp from 'sharp';
import {decode} from 'sixel';
import {registerImagePreviews} from '../src/image-previews.ts';
import {ImagePreviewComponent} from '../src/image-preview/component.ts';
import {resolveImagePath} from '../src/image-preview/files.ts';
import {rewriteImageLinks} from '../src/image-preview/markdown.ts';
import {SixelFrame, SixelOutput} from '../src/image-preview/sixel.ts';
import {registerImagePreviewTool} from '../src/tools/image-preview.ts';

function terminal(columns = 30, rows = 14) {
  const writes: string[] = [];
  return {
    writes,
    columns,
    rows,
    kittyProtocolActive: false,
    start() {},
    stop() {},
    async drainInput() {},
    write(data: string) {
      writes.push(data);
    },
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
  } satisfies Terminal & {writes: string[]};
}

function frame(columns = 4, rows = 3): SixelFrame {
  const pixels = new Uint8Array(columns * 10 * rows * 20 * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = 255;
    pixels[index + 3] = 255;
  }
  return new SixelFrame(pixels, columns, rows);
}

function bands(output: string) {
  return [
    ...output.matchAll(/\x1b\[(\d+);(\d+)H\x1bP[^q]*q([\s\S]*?)\x1b\\/g),
  ].map(match => ({
    row: Number(match[1]),
    column: Number(match[2]),
    image: decode(match[3]),
  }));
}

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(process.cwd(), '.image-preview-test-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const path = join(cwd, 'image with spaces (1).png');
  await sharp({
    create: {
      width: 80,
      height: 40,
      channels: 4,
      background: {r: 255, g: 0, b: 0, alpha: 0.5},
    },
  })
    .png()
    .toFile(path);
  return {cwd, path};
}

void test('Markdown previews resolve local links without rewriting code examples or remote URLs', () => {
  const cwd = process.cwd();
  const source = [
    '`![inline example](image.png)`',
    '```md\n![example](image.png)\n```',
    '![Actual](<assets/image with spaces (1).png>)',
    '[Encoded](assets/image%20with%20spaces%20%281%29.png)',
    '[Reference][picture]\n\n[picture]: assets/image.png',
    '[Remote](https://example.org/image.png)',
    '[Unavailable](sandbox:/mnt/data/image.png)',
  ].join('\n\n');
  const paths: string[] = [];
  const result = rewriteImageLinks(source, cwd, path => {
    paths.push(path);
    return pathToFileURL(path).href;
  });
  assert.equal(paths.length, 3);
  assert.equal(paths[0], join(cwd, 'assets', 'image with spaces (1).png'));
  assert.equal(paths[0], paths[1]);
  assert.ok(result.includes('`![inline example](image.png)`'));
  assert.ok(result.includes('```md\n![example](image.png)\n```'));
  assert.ok(result.includes('[Actual](file:///'));
  assert.ok(result.includes('[Reference](file:///'));
  assert.ok(result.includes('[Remote](https://example.org/image.png)'));
  assert.ok(result.includes('[Unavailable](sandbox:/mnt/data/image.png)'));
  assert.equal(
    resolveImagePath('@"assets/100%.png"', cwd),
    join(cwd, 'assets', '100%.png'),
  );
  assert.equal(
    resolveImagePath(pathToFileURL(join(cwd, 'assets', 'a #%.png')).href, cwd),
    join(cwd, 'assets', 'a #%.png'),
  );
  assert.equal(
    resolveImagePath('https://example.org/image.png', cwd),
    undefined,
  );
  assert.equal(resolveImagePath('x.png\n\x1b[2J', cwd), undefined);
});

void test('Sixel is deferred until clearing and scrolling finish; chunked writes preserve the frame', () => {
  const image = frame();
  assert.ok(image.lines().every(line => visibleWidth(line) === image.columns));
  const input = `\x1b[?2026h\x1b[Hheader\r\n${image.lines().join('\r\n')}\r\nfooter\x1b[?2026l`;
  const whole = terminal();
  const adapter = new SixelOutput(whole);
  adapter.register(image);
  whole.write(input);
  const expected = whole.writes.join('');
  const decoded = bands(expected);
  assert.equal(decoded.length, 3);
  assert.deepEqual(
    decoded.map(band => [band.row, band.column]),
    [
      [2, 1],
      [3, 1],
      [4, 1],
    ],
  );
  for (const band of decoded) {
    assert.equal(band.image.width, 40);
    assert.equal(band.image.height, 20);
    assert.deepEqual([...band.image.data8.slice(0, 4)], [255, 0, 0, 255]);
  }
  assert.ok(expected.indexOf('footer') < expected.indexOf('\x1bP'));
  assert.ok(!expected.includes('varisdev-image'));
  assert.ok(expected.endsWith('\x1b[?80h\x1b8\x1b[?2026l'));
  adapter.dispose();

  const split = terminal();
  const originalWrite = split.write;
  const splitAdapter = new SixelOutput(split);
  splitAdapter.register(image);
  for (const character of input) split.write(character);
  assert.equal(split.writes.join(''), expected);
  splitAdapter.dispose();
  assert.equal(split.write, originalWrite);
});

void test('Sixel placements follow terminal scroll and clip hidden cells', () => {
  const target = terminal(20, 6);
  const output = new SixelOutput(target);
  const image = frame(8, 3);
  output.register(image);
  const clipped = sliceByColumn(image.lines()[0], 3, 3);
  target.write(
    `\x1b[?2026h\x1b[H${clipped}\r\n${image.lines()[1]}\r\n${image.lines()[2]}\r\n1\r\n2\r\n3\r\n4\x1b[?2026l`,
  );
  const decoded = bands(target.writes.join(''));
  // One terminal scroll removed the first image row before it was drawn.
  assert.deepEqual(
    decoded.map(band => [band.row, band.image.width]),
    [
      [1, 80],
      [2, 80],
    ],
  );
  output.dispose();
});

void test('both official Pi renderers accept preview cells, resize, and cleanly redraw overlays', t => {
  setCapabilities({images: null, hyperlinks: true, trueColor: true});
  t.after(resetCapabilitiesCache);
  for (const Tui of [TuiMainScreen, TuiAltScreen]) {
    const target = terminal();
    const adapter = new SixelOutput(target);
    const image = frame();
    adapter.register(image);
    const tui = new Tui(target);
    t.after(() => {
      tui.stop();
      adapter.dispose();
    });
    tui.addChild({
      render: () => ['heading', ...image.lines(), 'footer', ''],
      invalidate() {},
    });
    tui.start();
    tui.renderNow(true);
    assert.equal(bands(target.writes.join('')).length, image.rows);
    target.writes.length = 0;
    const overlay = tui.showOverlay(
      {render: () => ['cover'], invalidate() {}},
      {row: 1, col: 0, width: 8, anchor: 'top-left'},
    );
    tui.renderNow();
    assert.ok(!target.writes.join('').includes('varisdev-image'));
    overlay.hide();
    target.columns = 24;
    target.rows = 12;
    target.writes.length = 0;
    tui.renderNow(true);
    const rendered = target.writes.join('');
    assert.equal(bands(rendered).length, image.rows);
    assert.ok(!rendered.includes('varisdev-image'));
  }
});

void test('an overlay removes covered image cells before Sixel is drawn', () => {
  const target = terminal();
  const adapter = new SixelOutput(target);
  const image = frame(8, 1);
  adapter.register(image);
  const line = compositeTuiLine(image.lines()[0], 'OVER', 2, 4, 12);
  target.write(`\x1b[?2026h\x1b[H${line}\x1b[?2026l`);
  for (const band of bands(target.writes.join(''))) {
    assert.ok(band.column + band.image.width / 10 <= 3 || band.column >= 7);
  }
  adapter.dispose();
});

void test('image components load pixels, fit available width, and fall back to true color cells', async t => {
  const {path} = await fixture(t);
  setCapabilities({images: null, hyperlinks: true, trueColor: true});
  t.after(resetCapabilitiesCache);
  const theme = {fg: (_name: string, text: string) => text} as Theme;
  for (const sixel of [true, false]) {
    let loaded!: () => void;
    const ready = new Promise<void>(resolve => {
      loaded = resolve;
    });
    const target = terminal();
    const output = new SixelOutput(target);
    const component = new ImagePreviewComponent(
      path,
      theme,
      {sixel, active: true, output, invalidate: loaded},
      8,
      12,
    );
    component.render(14);
    await ready;
    const lines = component.render(14);
    assert.ok(lines.every(line => visibleWidth(line) <= 14));
    assert.ok(
      lines.some(line => line.includes(sixel ? 'varisdev-image' : '▀')),
    );
    if (sixel) {
      target.write(`\x1b[?2026h\x1b[H${lines.join('\r\n')}\x1b[?2026l`);
      assert.ok(bands(target.writes.join('')).length > 0);
    }
    component.dispose();
    output.dispose();
  }
});

void test('generated images and assistant links create native entries, deduplicate, and release terminal hooks', async t => {
  const {cwd, path} = await fixture(t);
  const previousWT = process.env.WT_SESSION;
  process.env.WT_SESSION = 'test';
  t.after(() => {
    if (previousWT === undefined) delete process.env.WT_SESSION;
    else process.env.WT_SESSION = previousWT;
  });
  setCapabilities({images: null, hyperlinks: true, trueColor: true});
  t.after(resetCapabilitiesCache);
  type Handler = (
    event: Record<string, unknown>,
    ctx: ExtensionContext,
  ) => unknown;
  const handlers = new Map<string, Handler>();
  const entries: Array<{customType: string; data: unknown}> = [];
  const target = terminal();
  const originalWrite = target.write;
  let listener: ((data: string) => unknown) | undefined;
  let command!: {
    handler: (args: string, ctx: ExtensionContext) => Promise<void>;
  };
  let viewerVisits = 0;
  let transformer:
    ((markdown: string, context: {messageType: string}) => string) | undefined;
  const tui = {
    terminal: target,
    requestRender() {},
    addInputListener(handler: (data: string) => unknown) {
      listener = handler;
      return () => {
        listener = undefined;
      };
    },
  } as unknown as TUI;
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerEntryRenderer() {},
    registerCommand(_name: string, value: typeof command) {
      command = value;
    },
    registerMarkdownTransformer(value: typeof transformer) {
      transformer = value;
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({customType, data});
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    mode: 'tui',
    hasUI: true,
    sessionManager: {getBranch: () => []},
    ui: {
      setWidget(_key: string, factory: (tui: TUI) => unknown) {
        factory(tui);
      },
      notify(message: string) {
        assert.fail(message);
      },
      async custom(
        factory: (
          tui: TUI,
          theme: Theme,
          keys: unknown,
          done: () => void,
        ) => Component & {dispose(): void},
      ) {
        let closed = false;
        const viewer = factory(
          tui,
          {fg: (_name: string, text: string) => text} as Theme,
          {},
          () => {
            closed = true;
          },
        );
        try {
          viewerVisits++;
          assert.match(viewer.render(30)[0], /Image \d+\/\d+/);
          viewer.handleInput?.('\x1b[D');
          assert.match(viewer.render(30)[0], /Image 1\//);
          viewer.handleInput?.('\x1b');
          assert.equal(closed, true);
        } finally {
          viewer.dispose();
        }
      },
    },
  } as unknown as ExtensionContext;
  registerImagePreviews(pi);
  await handlers.get('session_start')!({}, ctx);
  assert.match(target.writes.join(''), /\x1b\[\?80\$p/);
  assert.deepEqual(listener?.('\x1b[?80;1$y'), {data: ''});
  await handlers.get('tool_result')!(
    {
      toolName: 'openai_image',
      details: {images: [{path}]},
      input: {},
      isError: false,
    },
    ctx,
  );
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].data, {paths: [path]});
  const markdown = `![Generated](<${path}>)`;
  await handlers.get('message_end')!(
    {message: {role: 'assistant', content: [{type: 'text', text: markdown}]}},
    ctx,
  );
  assert.equal(entries.length, 1);
  assert.match(
    transformer!(markdown, {messageType: 'assistant'}),
    /\[Generated\]\(file:\/\//,
  );
  await handlers.get('tool_result')!(
    {
      toolName: 'image_preview',
      details: {images: [{path}]},
      input: {},
      isError: false,
    },
    ctx,
  );
  assert.equal(entries.length, 2);
  await command.handler('', ctx);
  const second = join(cwd, 'second image.svg');
  await writeFile(
    second,
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>',
  );
  await command.handler(`"${second}"`, ctx);
  assert.equal(viewerVisits, 2);
  await handlers.get('session_shutdown')!({}, ctx);
  assert.equal(listener, undefined);
  assert.equal(target.write, originalWrite);
  assert.equal(transformer!(markdown, {messageType: 'assistant'}), markdown);
});

void test('image_preview validates a real image and reports its dimensions', async t => {
  const {cwd, path} = await fixture(t);
  let tool!: {
    execute: (
      id: string,
      params: {path: string},
      signal: AbortSignal | undefined,
      update: undefined,
      ctx: {cwd: string},
    ) => Promise<{
      details: {images: Array<{path: string; width: number; height: number}>};
    }>;
  };
  registerImagePreviewTool({
    registerTool(value: typeof tool) {
      tool = value;
    },
  } as unknown as ExtensionAPI);
  const result = await tool.execute('preview', {path}, undefined, undefined, {
    cwd,
  });
  assert.equal(result.details.images[0].path, resolve(path));
  assert.equal(result.details.images[0].width, 80);
  assert.equal(result.details.images[0].height, 40);
  const invalid = join(cwd, 'invalid.png');
  await writeFile(invalid, 'not an image');
  await assert.rejects(
    tool.execute('invalid', {path: invalid}, undefined, undefined, {cwd}),
    /unsupported image format/i,
  );
  await assert.rejects(
    tool.execute(
      'remote',
      {path: 'https://example.org/x.png'},
      undefined,
      undefined,
      {cwd},
    ),
    /Unsupported local image path/,
  );
});
