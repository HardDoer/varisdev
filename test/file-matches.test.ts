import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test, type TestContext} from 'node:test';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import sharp from 'sharp';
import {prepareFileQuery} from '../src/tools/file-matches.ts';
import {registerGameMakerQueryTool} from '../src/tools/gamemaker-query.ts';
import {registerImageQueryTool} from '../src/tools/image-query.ts';
import {registerJsonQueryTool} from '../src/tools/json-query.ts';

type Input = {
  path: string;
  maxFiles?: number;
  exclude?: string[];
  sampleLimit?: number;
};
type Tool = {
  name: string;
  execute(
    id: string,
    input: Input,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: {cwd: string},
  ): Promise<{
    details: {
      files: Array<{path: string; error?: string}>;
      summary: {
        filesProcessed: number;
        filesFailed: number;
        fileLimitReached: boolean;
      };
    };
  }>;
};

function capture(register: (pi: ExtensionAPI) => void): Tool {
  let tool: Tool | undefined;
  register({
    registerTool(value: unknown) {
      tool = value as Tool;
    },
  } as unknown as ExtensionAPI);
  assert.ok(tool);
  return tool;
}

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'varisdev-file-matches-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  return cwd;
}

for (const [register, extension] of [
  [registerJsonQueryTool, 'json'],
  [registerGameMakerQueryTool, 'yy'],
  [registerImageQueryTool, 'png'],
] as const) {
  void test(`${extension} query executes only the files prepared before approval`, async t => {
    const cwd = await fixture(t);
    const tool = capture(register);
    const content =
      extension === 'png'
        ? await sharp({
            create: {width: 1, height: 1, channels: 4, background: '#ff0000'},
          })
            .png()
            .toBuffer()
        : '{"approved":true}';
    await writeFile(join(cwd, `approved.${extension}`), content);
    const input = {path: ` @*.${extension} `};
    const jsonBefore = JSON.stringify(input);
    const approved = await prepareFileQuery(tool.name, input, cwd);
    assert.deepEqual(approved, [resolve(cwd, `approved.${extension}`)]);
    assert.equal(JSON.stringify(input), jsonBefore);
    await writeFile(join(cwd, `new-unapproved.${extension}`), content);
    assert.strictEqual(await prepareFileQuery(tool.name, input, cwd), approved);
    const result = await tool.execute('prepared', input, undefined, undefined, {
      cwd,
    });
    assert.deepEqual(
      result.details.files.map(file => file.path),
      [`approved.${extension}`],
    );
    const normal = await tool.execute(
      'normal',
      {...input},
      undefined,
      undefined,
      {cwd},
    );
    assert.deepEqual(
      normal.details.files.map(file => file.path),
      [`approved.${extension}`, `new-unapproved.${extension}`],
    );
  });
}

void test('prepared image exclusions cannot be changed to include an unapproved image', async t => {
  const cwd = await fixture(t);
  const tool = capture(registerImageQueryTool);
  const content = await sharp({
    create: {width: 1, height: 1, channels: 4, background: '#00ff00'},
  })
    .png()
    .toBuffer();
  await writeFile(join(cwd, 'approved.png'), content);
  await writeFile(join(cwd, 'denied.png'), content);
  const input: Input = {path: '@*.png', exclude: [' @denied.png ']};
  assert.deepEqual(await prepareFileQuery(tool.name, input, cwd), [
    resolve(cwd, 'approved.png'),
  ]);
  const allowed = await tool.execute('excluded', input, undefined, undefined, {
    cwd,
  });
  assert.deepEqual(
    allowed.details.files.map(file => file.path),
    ['approved.png'],
  );
  input.exclude!.splice(0);
  await assert.rejects(
    tool.execute('mutated', input, undefined, undefined, {cwd}),
    /selection changed after permission checks/,
  );
});

void test('changed prepared path, maximum, cwd, or tool name requires new permission checks', async t => {
  const cwd = await fixture(t);
  const other = join(cwd, 'other');
  await mkdir(other);
  await writeFile(join(cwd, 'approved.json'), '{}');
  await writeFile(join(cwd, 'denied.json'), '{}');
  const json = capture(registerJsonQueryTool);
  for (const mutate of [
    (input: Input) => {
      input.path = 'denied.json';
    },
    (input: Input) => {
      input.maxFiles = 2;
    },
  ]) {
    const input: Input = {path: '*.json', maxFiles: 1};
    await prepareFileQuery(json.name, input, cwd);
    mutate(input);
    await assert.rejects(
      json.execute('mutated', input, undefined, undefined, {cwd}),
      /selection changed after permission checks/,
    );
    await assert.rejects(
      prepareFileQuery(json.name, input, cwd),
      /selection changed after permission checks/,
    );
  }
  const input: Input = {path: '*.json'};
  await prepareFileQuery(json.name, input, cwd);
  await assert.rejects(
    json.execute('changed-cwd', input, undefined, undefined, {cwd: other}),
    /selection changed after permission checks/,
  );
  await assert.rejects(
    capture(registerGameMakerQueryTool).execute(
      'changed-tool',
      input,
      undefined,
      undefined,
      {cwd},
    ),
    /selection changed after permission checks/,
  );
  input.sampleLimit = 1;
  assert.equal(
    (await json.execute('same-files', input, undefined, undefined, {cwd}))
      .details.summary.filesProcessed,
    2,
  );
});

void test('an approved empty selection stays empty after files are created', async t => {
  const cwd = await fixture(t);
  const input = {path: '*.json'};
  assert.deepEqual(await prepareFileQuery('json_query', input, cwd), []);
  await writeFile(join(cwd, 'not-approved.json'), '{}');
  await assert.rejects(
    capture(registerJsonQueryTool).execute(
      'empty',
      input,
      undefined,
      undefined,
      {cwd},
    ),
    /No files matched json_query/,
  );
});

void test('prepared files retain sorted output, file limits and per-file disappearance errors', async t => {
  const cwd = await fixture(t);
  for (const name of ['z.json', 'a.json', 'm.json'])
    await writeFile(join(cwd, name), '{}');
  await mkdir(join(cwd, 'directory.json'));
  const tool = capture(registerJsonQueryTool);
  const limited: Input = {path: '*.json', maxFiles: 2};
  const paths = await prepareFileQuery(tool.name, limited, cwd);
  assert.equal(paths?.length, 2);
  assert.deepEqual(
    paths,
    [...paths!].sort((left, right) => left.localeCompare(right)),
  );
  await writeFile(join(cwd, 'later.json'), '{}');
  const result = await tool.execute('limited', limited, undefined, undefined, {
    cwd,
  });
  assert.equal(result.details.summary.fileLimitReached, true);
  assert.deepEqual(
    result.details.files.map(file => resolve(cwd, file.path)),
    paths,
  );
  const transient: Input = {path: '*.json'};
  const before = await prepareFileQuery(tool.name, transient, cwd);
  await rm(join(cwd, 'a.json'));
  const disappeared = await tool.execute(
    'disappeared',
    transient,
    undefined,
    undefined,
    {cwd},
  );
  assert.equal(disappeared.details.summary.filesProcessed, before?.length);
  assert.equal(disappeared.details.summary.filesFailed, 1);
  assert.ok(
    disappeared.details.files.find(file => file.path === 'a.json')?.error,
  );
});

void test('shared discovery retains the default and maximum file bounds and cancellation', async t => {
  const cwd = await fixture(t);
  await Promise.all(
    Array.from({length: 501}, (_, index) =>
      writeFile(join(cwd, `${index}.json`), '{}'),
    ),
  );
  assert.equal(
    (await prepareFileQuery('json_query', {path: '*.json'}, cwd))?.length,
    100,
  );
  assert.equal(
    (
      await prepareFileQuery(
        'gamemaker_query',
        {path: '*.json', maxFiles: 999},
        cwd,
      )
    )?.length,
    500,
  );
  const controller = new AbortController();
  const reason = new Error('query permission cancelled');
  controller.abort(reason);
  await assert.rejects(
    prepareFileQuery('image_query', {path: '*.json'}, cwd, controller.signal),
    error => error === reason,
  );
  assert.equal(
    await prepareFileQuery('read', {path: '*.json'}, cwd),
    undefined,
  );
});
