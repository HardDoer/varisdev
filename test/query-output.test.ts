import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {fileURLToPath} from 'node:url';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import sharp from 'sharp';
import {registerGameMakerQueryTool} from '../src/tools/gamemaker-query.ts';
import {registerImageQueryTool} from '../src/tools/image-query.ts';
import {registerJsonQueryTool} from '../src/tools/json-query.ts';
import {saveQueryOutput} from '../src/tools/query-output.ts';
import {createDirectoryLink} from './filesystem.ts';

type QueryTool = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: undefined,
    update: undefined,
    ctx: {cwd: string},
  ) => Promise<{
    content: Array<{text: string}>;
    details: {fullOutputPath?: string; truncation?: {content: string}};
  }>;
};

function captureTool(register: (pi: ExtensionAPI) => void): QueryTool {
  let tool: QueryTool | undefined;
  register({
    registerTool(definition: unknown) {
      tool = definition as QueryTool;
    },
  } as ExtensionAPI);
  assert.ok(tool);
  return tool;
}

async function scratch(t: TestContext): Promise<string> {
  const base = fileURLToPath(
    new URL('../build/verification/', import.meta.url),
  );
  await mkdir(base, {recursive: true});
  const path = await mkdtemp(join(base, 'query output '));
  t.after(() => rm(path, {recursive: true, force: true}));
  return path;
}

void test('query tools save readable full output in their project and preserve earlier results', async t => {
  for (const register of [
    registerJsonQueryTool,
    registerGameMakerQueryTool,
    registerImageQueryTool,
  ]) {
    const tool = captureTool(register);
    await t.test(tool.name, async t => {
      const cwd = await scratch(t);
      assert.notEqual(cwd, process.cwd());
      let params: Record<string, unknown>;
      let shortParams: Record<string, unknown>;
      if (tool.name === 'image_query') {
        const image = await sharp({
          create: {
            width: 1,
            height: 1024,
            channels: 4,
            background: '#ff0000',
          },
        })
          .png()
          .toBuffer();
        await writeFile(join(cwd, 'a.png'), image);
        await writeFile(join(cwd, 'b.png'), image);
        params = {path: '*.png', grid: {cellWidth: 1, cellHeight: 1}};
        shortParams = {path: 'a.png'};
      } else {
        const path = tool.name === 'json_query' ? 'records.json' : 'records.yy';
        await writeFile(
          join(cwd, path),
          JSON.stringify(
            Array.from({length: 500}, (_, index) => ({
              kind: `${String(index).padStart(3, '0')}-${'x'.repeat(240)}`,
            })),
          ),
        );
        params = {path, groupBy: ['kind'], maxGroups: 500};
        shortParams = {path};
      }
      const short = await tool.execute(
        'short',
        shortParams,
        undefined,
        undefined,
        {cwd},
      );
      assert.equal(short.details.fullOutputPath, undefined);
      await assert.rejects(stat(join(cwd, '.varisdev')), {code: 'ENOENT'});

      const result = await tool.execute(
        'same-call-id',
        params,
        undefined,
        undefined,
        {cwd},
      );
      const path = result.details.fullOutputPath;
      assert.ok(path);
      const directory = join(await realpath(cwd), '.varisdev', 'tool-output');
      assert.equal(dirname(path), directory);
      assert.ok(basename(path).startsWith(`${tool.name}-`));
      assert.ok(path.endsWith('.txt'));
      const full = await readFile(path, 'utf8');
      assert.ok(result.details.truncation);
      assert.ok(full.startsWith(result.details.truncation.content));
      assert.ok(full.length > result.content[0]!.text.length);
      assert.ok(
        result.content[0]!.text.includes(`Full output saved to: ${path}`),
      );
      assert.ok(!full.includes('[Output truncated:'));

      // Restored history and a newly registered tool must keep the old path valid.
      const savedDetails = JSON.parse(JSON.stringify(result.details)) as {
        fullOutputPath: string;
      };
      const next = await captureTool(register).execute(
        'same-call-id',
        params,
        undefined,
        undefined,
        {cwd},
      );
      assert.notEqual(next.details.fullOutputPath, path);
      assert.equal(await readFile(savedDetails.fullOutputPath, 'utf8'), full);
      assert.equal(await readFile(next.details.fullOutputPath!, 'utf8'), full);
      assert.equal((await readdir(directory)).length, 2);
    });
  }
});

void test('query output rejects linked storage directories without writing outside the project', async t => {
  for (const linked of ['.varisdev', 'tool-output']) {
    await t.test(linked, async t => {
      const root = await scratch(t);
      const cwd = join(root, 'project');
      const outside = join(root, 'outside');
      await mkdir(cwd);
      await mkdir(outside);
      const storage = join(cwd, '.varisdev');
      if (linked === 'tool-output') await mkdir(storage);
      await createDirectoryLink(
        outside,
        linked === '.varisdev' ? storage : join(storage, 'tool-output'),
      );
      await assert.rejects(
        saveQueryOutput(cwd, 'json_query', 'saved output'),
        /must be a real directory/,
      );
      assert.deepEqual(await readdir(outside), []);
    });
  }
});

void test('query output allows a project opened through a directory link', async t => {
  const root = await scratch(t);
  const project = join(root, 'project');
  const linked = join(root, 'linked project');
  await mkdir(project);
  await createDirectoryLink(project, linked);
  const path = await saveQueryOutput(linked, 'json_query', 'saved output');
  assert.equal(
    dirname(path),
    join(await realpath(project), '.varisdev', 'tool-output'),
  );
  assert.equal(await readFile(path, 'utf8'), 'saved output');
});

void test('query output preserves files blocking its storage directories', async t => {
  const cwd = await scratch(t);
  const storage = join(cwd, '.varisdev');
  await writeFile(storage, 'user file');
  await assert.rejects(
    saveQueryOutput(cwd, 'json_query', 'saved output'),
    /must be a real directory/,
  );
  assert.equal(await readFile(storage, 'utf8'), 'user file');
});

void test('query output removes a partially written result when writing fails', async t => {
  const cwd = await scratch(t);
  const probe = await open(join(cwd, 'probe.txt'), 'wx');
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const write = prototype.writeFile;
  await probe.close();
  const replacement = t.mock.method(
    prototype,
    'writeFile',
    async function (this: FileHandle) {
      await write.call(this, 'partial output', 'utf8');
      throw new Error('simulated disk write failure');
    },
  );
  try {
    await assert.rejects(
      saveQueryOutput(cwd, 'json_query', 'complete output'),
      /simulated disk write failure/,
    );
  } finally {
    replacement.mock.restore();
  }
  assert.deepEqual(await readdir(join(cwd, '.varisdev', 'tool-output')), []);
  const path = await saveQueryOutput(cwd, 'json_query', 'retry output');
  assert.equal(await readFile(path, 'utf8'), 'retry output');
});
