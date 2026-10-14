import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import vm from 'node:vm';
import {DashboardHub} from '../src/dashboard/hub.ts';
import {
  readMarkdownFile,
  saveMarkdownFile,
} from '../src/dashboard/markdown-files.ts';
import {DashboardState} from '../src/dashboard/state.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'desktop-markdown-'));
  const cwd = join(root, 'project');
  await mkdir(cwd);
  t.after(() => rm(root, {recursive: true, force: true}));
  const path = join(cwd, 'PLAN.MD');
  await writeFile(path, '# Tasks\r\n- [ ] Finish\r\n');
  return {root, cwd, path};
}

void test('Markdown reads current disk text and saves atomically with a content version and original permissions', async t => {
  const {cwd, path} = await fixture(t);
  await chmod(path, 0o640);
  const first = await readMarkdownFile(cwd, './PLAN.MD');
  assert.equal(first.path, await realpath(path));
  assert.equal(first.content, '# Tasks\r\n- [ ] Finish\r\n');
  assert.equal(
    first.version,
    createHash('sha256').update(first.content).digest('hex'),
  );
  const saved = await saveMarkdownFile(
    cwd,
    first.path,
    '- [x] Finish\n',
    first.version,
  );
  assert.equal(saved.content, '- [x] Finish\n');
  assert.notEqual(saved.version, first.version);
  assert.deepEqual(await readMarkdownFile(cwd, path), saved);
  assert.equal(await readFile(path, 'utf8'), saved.content);
  if (process.platform !== 'win32')
    assert.equal((await stat(path)).mode & 0o777, 0o640);
  assert.deepEqual(await readdir(cwd), ['PLAN.MD']);
  await writeFile(path, 'AGENT UPDATED THE FILE');
  assert.equal(
    (await readMarkdownFile(cwd, path)).content,
    'AGENT UPDATED THE FILE',
  );
  await assert.rejects(
    saveMarkdownFile(cwd, path, 'OLD DRAFT', saved.version),
    /changed on disk.*Reload/,
  );
  assert.equal(await readFile(path, 'utf8'), 'AGENT UPDATED THE FILE');
  assert.deepEqual(await readdir(cwd), ['PLAN.MD']);
});

void test('Markdown saves through symlinks use the canonical regular target and competing versions cannot overwrite each other', async t => {
  const {root, cwd} = await fixture(t);
  const target = join(root, 'GLOBAL.md');
  const alias = join(cwd, 'linked.md');
  await writeFile(target, 'GLOBAL INSTRUCTIONS');
  await symlink(target, alias);
  const initial = await readMarkdownFile(cwd, 'linked.md');
  assert.equal(initial.path, await realpath(target));
  const results = await Promise.allSettled([
    saveMarkdownFile(cwd, alias, 'FIRST SAVE', initial.version),
    saveMarkdownFile(cwd, initial.path, 'SECOND SAVE', initial.version),
  ]);
  assert.equal(
    results.filter(result => result.status === 'fulfilled').length,
    1,
  );
  const rejected = results.find(
    result => result.status === 'rejected',
  ) as PromiseRejectedResult;
  assert.match(rejected.reason.message, /changed on disk/);
  assert.ok((await stat(alias)).isFile());
  assert.ok((await lstat(alias)).isSymbolicLink());
  const saved = await readMarkdownFile(cwd, alias);
  assert.equal(saved.path, initial.path);
  assert.match(saved.content, /^(FIRST|SECOND) SAVE$/);
  assert.equal(await realpath(alias), initial.path);
  await writeFile(join(root, 'plain.txt'), 'NOT MARKDOWN');
  await symlink(join(root, 'plain.txt'), join(cwd, 'wrong.md'));
  await assert.rejects(readMarkdownFile(cwd, 'wrong.md'), /resolve to a .md/);
  await symlink(join(root, 'absent.md'), join(cwd, 'missing.md'));
  await assert.rejects(readMarkdownFile(cwd, 'missing.md'), /no longer exists/);
});

void test('Markdown rejects invalid inputs, special files, binary data, and oversized reads and writes', async t => {
  const {cwd, path} = await fixture(t);
  const initial = await readMarkdownFile(cwd, path);
  for (const invalid of [
    undefined,
    null,
    1,
    {},
    [],
    '',
    ' ',
    'x\0.md',
    'x'.repeat(4097),
  ]) {
    await assert.rejects(
      readMarkdownFile(cwd, invalid),
      /valid Markdown file path/,
    );
    await assert.rejects(
      saveMarkdownFile(cwd, invalid, '', initial.version),
      /valid Markdown file path/,
    );
  }
  await assert.rejects(readMarkdownFile(cwd, 'PLAN.txt'), /\.md extension/);
  await mkdir(join(cwd, 'folder.md'));
  await assert.rejects(
    readMarkdownFile(cwd, 'folder.md'),
    /regular Markdown file/,
  );
  for (const invalid of [undefined, null, 123, {}, 'x\0'])
    await assert.rejects(
      saveMarkdownFile(cwd, path, invalid, initial.version),
      /content must be text/,
    );
  await assert.rejects(
    saveMarkdownFile(cwd, path, '\ud800', initial.version),
    /valid Unicode text/,
  );
  for (const invalid of [undefined, null, 123, '', 'wrong', 'F'.repeat(64)])
    await assert.rejects(
      saveMarkdownFile(cwd, path, '', invalid),
      /before saving/,
    );
  await assert.rejects(
    saveMarkdownFile(cwd, path, 'é'.repeat(524289), initial.version),
    /at most 1 MB/,
  );
  await writeFile(join(cwd, 'large.md'), Buffer.alloc(1048577, 'x'));
  await assert.rejects(readMarkdownFile(cwd, 'large.md'), /at most 1 MB/);
  await writeFile(join(cwd, 'binary.md'), Buffer.from([0xc3, 0x28]));
  await assert.rejects(readMarkdownFile(cwd, 'binary.md'), /UTF-8 text/);
  await writeFile(join(cwd, 'nul.md'), 'a\0b');
  await assert.rejects(readMarkdownFile(cwd, 'nul.md'), /NUL bytes/);
  await writeFile(join(cwd, 'bom.md'), '\ufeffTEXT');
  assert.equal((await readMarkdownFile(cwd, 'bom.md')).content, '\ufeffTEXT');
  assert.equal(await readFile(path, 'utf8'), initial.content);
});

void test('the hub resolves Markdown relative to the chosen known session and permits an explicit outside path', async t => {
  const {root, cwd, path} = await fixture(t);
  const now = new Date().toISOString();
  const state = new DashboardState({
    id: 'parent',
    name: 'Parent',
    cwd,
    status: 'idle',
    activity: 'Ready',
    startedAt: now,
    updatedAt: now,
  });
  const hub = new DashboardHub(state, async () => {
    throw new Error('Unused factory');
  });
  t.after(() => hub.close());
  const initial = await hub.readMarkdown('parent', 'PLAN.MD');
  assert.equal(initial.path, await realpath(path));
  const outside = join(root, 'AGENTS.md');
  await writeFile(outside, 'OUTSIDE INSTRUCTIONS');
  const global = await hub.readMarkdown('parent', outside);
  const saved = await hub.saveMarkdown(
    'parent',
    global.path,
    'UPDATED GLOBAL FIXTURE',
    global.version,
  );
  assert.equal(await readFile(outside, 'utf8'), saved.content);
  await assert.rejects(
    hub.readMarkdown('missing', path),
    /Unknown parent session/,
  );
  await assert.rejects(
    hub.saveMarkdown('missing', path, '', initial.version),
    /Unknown parent session/,
  );
  await assert.rejects(
    hub.readMarkdown('' as string, path),
    /valid parent session/,
  );
  hub.updateExternal({
    ...state.snapshot(),
    session: {...state.snapshot().session, id: 'attached'},
  });
  assert.equal(
    (await hub.readMarkdown('attached', '../AGENTS.md')).content,
    saved.content,
  );
  await hub.close();
  await assert.rejects(
    hub.readMarkdown('parent', path),
    /dashboard has closed/,
  );
});

void test('the actual desktop preload forwards Markdown IPC arguments and preserves conflict errors', async () => {
  const calls: Array<{channel: string; args: unknown[]}> = [];
  const file = {
    path: '/fixture/PLAN.md',
    content: '- [ ] Task',
    version: 'a'.repeat(64),
  };
  let api:
    | {
        readMarkdown: (...args: unknown[]) => Promise<unknown>;
        saveMarkdown: (...args: unknown[]) => Promise<unknown>;
      }
    | undefined;
  let failed = false;
  const electron = {
    contextBridge: {
      exposeInMainWorld(name: string, value: typeof api) {
        assert.equal(name, 'pidev');
        api = value;
      },
    },
    ipcRenderer: {
      async invoke(channel: string, ...args: unknown[]) {
        calls.push({channel, args});
        return failed
          ? {
              ok: false,
              error:
                'This Markdown file changed on disk. Reload it before saving your edits.',
            }
          : {ok: true, value: file};
      },
    },
    webFrame: {},
  };
  vm.runInNewContext(
    await readFile(
      new URL('../assets/desktop/preload.cjs', import.meta.url),
      'utf8',
    ),
    {require: () => electron},
  );
  assert.deepEqual(await api!.readMarkdown('parent', 'PLAN.md'), file);
  assert.deepEqual(
    await api!.saveMarkdown('parent', file.path, 'Draft', file.version),
    file,
  );
  assert.deepEqual(calls, [
    {channel: 'pidev:read-markdown', args: ['parent', 'PLAN.md']},
    {
      channel: 'pidev:save-markdown',
      args: ['parent', file.path, 'Draft', file.version],
    },
  ]);
  failed = true;
  await assert.rejects(
    api!.saveMarkdown('parent', file.path, 'Draft', file.version),
    /changed on disk.*Reload/,
  );
});
