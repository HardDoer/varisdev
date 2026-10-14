import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import sharp from 'sharp';
import {resolveImagePath} from '../src/image-preview/files.ts';
import {registerImagePreviewTool} from '../src/tools/image-preview.ts';

void test('image_preview returns a VarisDev image block without a terminal UI', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'varisdev-image-preview-'));
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
  let tool!: {
    description: string;
    execute(
      id: string,
      params: {path: string},
      signal: AbortSignal | undefined,
      update: undefined,
      ctx: {cwd: string},
    ): Promise<{
      content: Array<{type: string; text: string}>;
      details: {
        varisdev: {
          version: number;
          blocks: Array<{type: string; path: string}>;
        };
        images: Array<{path: string; width: number; height: number}>;
      };
    }>;
  };
  registerImagePreviewTool({
    registerTool(value: typeof tool) {
      tool = value;
    },
  } as unknown as ExtensionAPI);
  const result = await tool.execute(
    'preview',
    {path: '@image with spaces (1).png'},
    undefined,
    undefined,
    {cwd},
  );
  assert.match(tool.description, /VarisDev conversation/);
  assert.doesNotMatch(tool.description, /terminal/i);
  assert.deepEqual(result.details.varisdev, {
    version: 1,
    blocks: [{type: 'image', path: resolve(path)}],
  });
  assert.deepEqual(result.details.images, [
    {path: resolve(path), width: 80, height: 40},
  ]);
  assert.match(result.content[0].text, /80×40/);
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
  await assert.rejects(
    tool.execute(
      'cancelled',
      {path},
      AbortSignal.abort(new Error('Stopped')),
      undefined,
      {cwd},
    ),
    /Stopped/,
  );
});

void test('image file references support local paths and file URLs without accepting remote URLs', () => {
  const cwd = resolve('example-project');
  assert.equal(
    resolveImagePath('@screenshots/result.png', cwd),
    join(cwd, 'screenshots/result.png'),
  );
  assert.equal(
    resolveImagePath(pathToFileURL(join(cwd, 'my image.svg')).href, cwd),
    join(cwd, 'my image.svg'),
  );
  assert.equal(
    resolveImagePath('https://example.com/image.png', cwd),
    undefined,
  );
  assert.equal(resolveImagePath('data:image/png;base64,AAAA', cwd), undefined);
  assert.equal(resolveImagePath('notes.md', cwd), undefined);
});
