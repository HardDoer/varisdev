import assert from 'node:assert/strict';
import {
  access,
  cp,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {processImage} from '../src/sharp.ts';

const input = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"><rect width="4" height="2" fill="red"/></svg>',
);

function loadedSharpLibraries(): string[] {
  const report = process.report.getReport() as {sharedObjects: string[]};
  return report.sharedObjects.filter(path => /sharp|libvips/i.test(path));
}

void test('image operations return metadata, RGBA pixels and PNG without loading Sharp into the parent', async () => {
  const {metadata} = await processImage({
    input,
    output: 'metadata',
    limitInputPixels: 100,
  });
  assert.equal(metadata.width, 4);
  assert.equal(metadata.height, 2);
  assert.equal(metadata.format, 'svg');

  const raw = await processImage({
    input,
    output: 'raw',
    limitInputPixels: 100,
    resize: {width: 2, height: 2},
  });
  assert.equal(raw.info.width, 2);
  assert.equal(raw.info.height, 1);
  assert.equal(raw.info.channels, 4);
  assert.deepEqual(raw.data, Buffer.from([255, 0, 0, 255, 255, 0, 0, 255]));

  const png = await processImage({input, output: 'png', limitInputPixels: 100});
  assert.ok(Buffer.isBuffer(png.data));
  assert.equal(png.info.format, 'png');
  const converted = await processImage({
    input: png.data,
    output: 'metadata',
    limitInputPixels: 100,
  });
  assert.equal(converted.metadata.format, 'png');
  assert.equal(converted.metadata.width, 4);
  assert.equal(converted.metadata.height, 2);
  assert.deepEqual(loadedSharpLibraries(), []);
});

void test('invalid images and input pixel limits report errors; later operations still work', async () => {
  await assert.rejects(
    processImage({
      input: Buffer.from('not an image'),
      output: 'raw',
      limitInputPixels: 100,
    }),
    /unsupported image format/i,
  );
  await assert.rejects(
    processImage({input, output: 'raw', limitInputPixels: 1}),
    /pixel limit/i,
  );
  assert.equal(
    (await processImage({input, output: 'metadata', limitInputPixels: 100}))
      .metadata.width,
    4,
  );
  assert.deepEqual(loadedSharpLibraries(), []);
});

void test('cancelling an image operation rejects with its reason', async () => {
  const cancelled = new AbortController();
  const reason = new Error('Image preview disposed');
  const pending = processImage(
    {input, output: 'raw', limitInputPixels: 100},
    cancelled.signal,
  );
  cancelled.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.throws(
    () =>
      processImage(
        {input, output: 'metadata', limitInputPixels: 100},
        cancelled.signal,
      ),
    error => error === reason,
  );
});

void test(
  'package dependencies can be removed after image use and cancellation while the parent remains alive',
  {timeout: 30_000},
  async t => {
    // Copy the actual native binaries. On Windows this deletion fails if either
    // the parent or a child still has Sharp's DLL loaded, matching git clean -fdx.
    const directory = await mkdtemp(join(process.cwd(), '.sharp-update-test-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const modules = join(directory, 'node_modules');
    for (const name of ['sharp', '@img', 'detect-libc', 'semver']) {
      await cp(resolve('node_modules', name), join(modules, name), {
        recursive: true,
      });
    }
    for (const name of ['sharp.ts', 'sharp-worker.mjs']) {
      await cp(resolve('src', name), join(directory, name));
    }
    const isolated = (await import(
      pathToFileURL(join(directory, 'sharp.ts')).href
    )) as typeof import('../src/sharp.ts');
    const png = await isolated.processImage({
      input,
      output: 'png',
      limitInputPixels: 100,
    });
    assert.equal(png.info.format, 'png');
    await assert.rejects(
      isolated.processImage({
        input: Buffer.from('invalid'),
        output: 'raw',
        limitInputPixels: 100,
      }),
      /unsupported image format/i,
    );
    assert.deepEqual(loadedSharpLibraries(), []);
    // Inject a stalled native operation to cancel only after its DLL is loaded.
    await writeFile(
      join(directory, 'sharp-worker.mjs'),
      `import {createRequire} from 'node:module';
import {writeFileSync} from 'node:fs';
createRequire(import.meta.url)('sharp');
process.once('message', () => {
  writeFileSync(new URL('./ready', import.meta.url), '');
  setInterval(() => {}, 1000);
});
`,
    );
    const controller = new AbortController();
    const reason = new Error('Cancel stalled decoder');
    const pending = isolated.processImage(
      {input, output: 'raw', limitInputPixels: 100},
      controller.signal,
    );
    const rejected = assert.rejects(pending, error => error === reason);
    try {
      const deadline = Date.now() + 10_000;
      while (true) {
        try {
          await access(join(directory, 'ready'));
          break;
        } catch {
          assert.ok(Date.now() < deadline, 'Decoder did not load Sharp');
          await delay(20);
        }
      }
      if (process.platform === 'win32') {
        await assert.rejects(
          unlink(
            join(
              modules,
              '@img',
              `sharp-win32-${process.arch}`,
              'lib',
              'libvips-42.dll',
            ),
          ),
          {code: 'EPERM'},
        );
      }
    } finally {
      controller.abort(reason);
      await rejected;
    }
    await rm(modules, {recursive: true});
    await assert.rejects(readFile(join(modules, 'sharp', 'package.json')), {
      code: 'ENOENT',
    });
  },
);
