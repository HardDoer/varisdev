import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import type {ToolCall} from '@earendil-works/pi-ai';
import {
  createAgentSession,
  createReadTool,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  attachedContextFiles,
  loaderContextFiles,
} from '../src/dashboard/context-files.ts';

type Message = Parameters<SessionManager['appendMessage']>[0];

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'desktop-context-'));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'config');
  await Promise.all([
    mkdir(cwd, {recursive: true}),
    mkdir(join(agentDir, 'skills', 'hidden'), {recursive: true}),
    mkdir(join(agentDir, 'skills', 'visible'), {recursive: true}),
    mkdir(join(agentDir, 'prompts'), {recursive: true}),
  ]);
  t.after(() => rm(root, {recursive: true, force: true}));
  const hiddenPath = join(agentDir, 'skills', 'hidden', 'SKILL.md');
  const visiblePath = join(agentDir, 'skills', 'visible', 'SKILL.md');
  await Promise.all([
    writeFile(
      hiddenPath,
      '---\nname: hidden\ndescription: Hidden fixture\ndisable-model-invocation: true\n---\nHIDDEN BODY',
    ),
    writeFile(
      visiblePath,
      '---\nname: visible\ndescription: Visible fixture\n---\nVISIBLE BODY',
    ),
    writeFile(
      join(agentDir, 'prompts', 'fixture.md'),
      '---\ndescription: Fixture prompt\n---\nTEMPLATE BODY',
    ),
    writeFile(join(cwd, 'AGENTS.md'), 'AUTOMATIC INSTRUCTIONS'),
    writeFile(join(cwd, 'guide.md'), 'FIRST LINE\nSECOND LINE\nTHIRD LINE\n'),
  ]);
  const settings = SettingsManager.create(cwd, agentDir);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
  });
  await loader.reload();
  return {root, cwd, agentDir, loader, hiddenPath, visiblePath};
}

function appendReadCall(
  manager: SessionManager,
  id: string,
  args: ToolCall['arguments'],
): string {
  return manager.appendMessage({
    role: 'assistant',
    api: 'openai-completions',
    provider: 'fixture',
    model: 'fixture',
    content: [{type: 'toolCall', id, name: 'read', arguments: args}],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
    },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  });
}

async function appendRead(
  manager: SessionManager,
  cwd: string,
  id: string,
  path: string,
  offset = 1,
  limit = 1,
) {
  const args = {path, offset, limit};
  appendReadCall(manager, id, args);
  const result = await createReadTool(cwd).execute(id, args);
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: id,
    toolName: 'read',
    ...result,
    isError: false,
    timestamp: Date.now(),
  } as Message);
}

void test('successful retained Markdown reads consolidate excerpts and disappear after SDK compaction', async t => {
  const {cwd, loader, visiblePath} = await fixture(t);
  const manager = SessionManager.inMemory(cwd);
  await appendRead(manager, cwd, 'first', '@guide.md', 1, 1);
  await appendRead(manager, cwd, 'second', './guide.md', 2, 1);
  await appendRead(manager, cwd, 'skill', visiblePath, 1, 20);
  appendReadCall(manager, 'failed', {path: 'missing.md'});
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'failed',
    toolName: 'read',
    content: [{type: 'text', text: 'File missing'}],
    isError: true,
    timestamp: Date.now(),
  });
  const files = loaderContextFiles(
    loader,
    ['read'],
    manager.buildSessionContext().messages,
    cwd,
  );
  const guide = files.filter(file => file.path === join(cwd, 'guide.md'));
  assert.equal(guide.length, 1);
  assert.equal(guide[0].kind, 'document');
  assert.equal(guide[0].status, 'included');
  assert.match(guide[0].description, /line 1.*line 2/);
  assert.match(guide[0].content!, /FIRST LINE[\s\S]*SECOND LINE/);
  assert.ok(!guide[0].content!.includes('THIRD LINE'));
  assert.ok(!files.some(file => file.path === join(cwd, 'missing.md')));
  const skill = files.filter(file => file.path === visiblePath);
  assert.equal(skill.length, 1);
  assert.equal(skill[0].kind, 'skill');
  assert.equal(skill[0].status, 'included');
  assert.match(skill[0].content!, /VISIBLE BODY/);

  const keep = manager.appendMessage({
    role: 'user',
    content: 'Keep this recent question',
    timestamp: Date.now(),
  });
  manager.appendCompaction(
    'Summary mentions guide.md, without retaining its read content.',
    keep,
    3000,
  );
  const compacted = loaderContextFiles(
    loader,
    ['read'],
    manager.buildSessionContext().messages,
    cwd,
  );
  assert.ok(!compacted.some(file => file.kind === 'document'));
  assert.equal(
    compacted.find(file => file.path === visiblePath)?.status,
    'available',
  );
  assert.equal(
    compacted.find(file => file.path === visiblePath)?.content,
    undefined,
  );
  assert.equal(
    compacted.find(file => file.path === join(cwd, 'AGENTS.md'))?.status,
    'included',
  );
});

void test('read provenance follows SDK tilde paths and previews remain bounded without opening files', async t => {
  const {cwd, loader} = await fixture(t);
  const manager = SessionManager.inMemory(cwd);
  const sdkRead = createReadTool(cwd, {
    operations: {
      access: async path => {
        assert.equal(path, join(homedir(), 'context-preview.md'));
      },
      readFile: async () => Buffer.from('x'.repeat(20000)),
    },
  });
  const args = {path: '@~/context-preview.md'};
  appendReadCall(manager, 'home', args);
  const result = await sdkRead.execute('home', args);
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'home',
    toolName: 'read',
    ...result,
    isError: false,
    timestamp: Date.now(),
  } as Message);
  const files = loaderContextFiles(
    loader,
    ['read'],
    manager.buildSessionContext().messages,
    cwd,
  );
  const file = files.find(file => file.kind === 'document')!;
  assert.equal(file.path, join(homedir(), 'context-preview.md'));
  assert.ok(file.content!.length < 8050);
  assert.match(file.content!, /\[Preview truncated\]$/);
});

void test('real SDK command context exposes instruction content and available skill/template metadata', async t => {
  const {cwd, agentDir, loader, hiddenPath, visiblePath} = await fixture(t);
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const manager = SessionManager.inMemory(cwd);
  const {session} = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: manager,
  });
  t.after(() => session.dispose());
  await session.bindExtensions({mode: 'rpc'});
  const ctx = session.extensionRunner.createCommandContext();
  const commands = [
    {
      name: 'fixture',
      description: 'Fixture prompt',
      source: 'prompt' as const,
      path: loader.getPrompts().prompts[0].filePath,
    },
  ];
  const files = attachedContextFiles(
    ctx.getSystemPromptOptions(),
    commands,
    manager.buildSessionContext().messages,
    cwd,
  )!;
  assert.equal(
    files.find(file => file.path === join(cwd, 'AGENTS.md'))?.content,
    'AUTOMATIC INSTRUCTIONS',
  );
  assert.equal(
    files.find(file => file.path === hiddenPath)?.status,
    'available',
  );
  assert.match(
    files.find(file => file.path === hiddenPath)!.description,
    /advertisement.*disabled/,
  );
  assert.equal(
    files.find(file => file.path === hiddenPath)?.content,
    undefined,
  );
  assert.ok(!ctx.getSystemPrompt().includes('Hidden fixture'));
  assert.ok(ctx.getSystemPrompt().includes('Visible fixture'));
  assert.ok(!ctx.getSystemPrompt().includes('VISIBLE BODY'));
  assert.equal(
    files.find(file => file.kind === 'template')?.status,
    'available',
  );
  assert.equal(
    files.find(file => file.kind === 'template')?.content,
    undefined,
  );

  session.setActiveToolsByName(['edit']);
  const withoutRead = attachedContextFiles(
    ctx.getSystemPromptOptions(),
    commands,
    [],
    cwd,
  )!;
  assert.match(
    withoutRead.find(file => file.path === visiblePath)!.description,
    /not advertised/,
  );
  assert.ok(!ctx.getSystemPrompt().includes('Visible fixture'));
  assert.equal(attachedContextFiles(undefined, [], undefined, cwd), undefined);
});

void test('SDK loader honors disabled context resources and caches only sourced prompt text', async t => {
  const {cwd, agentDir, loader: base} = await fixture(t);
  const systemPath = join(agentDir, 'custom-system.md');
  const appendPath = join(agentDir, 'custom-append.md');
  await Promise.all([
    writeFile(systemPath, 'CUSTOM SOURCE'),
    writeFile(appendPath, 'APPEND SOURCE'),
  ]);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    noExtensions: true,
    systemPrompt: systemPath,
    appendSystemPrompt: ['Inline appendix', appendPath],
  });
  await loader.reload();
  const files = loaderContextFiles(loader, ['read'], [], cwd);
  assert.ok(
    !files.some(
      file =>
        file.kind === 'instructions' ||
        file.kind === 'skill' ||
        file.kind === 'template',
    ),
  );
  assert.equal(
    files.find(file => file.path === systemPath)?.content,
    'CUSTOM SOURCE',
  );
  assert.equal(
    files.find(file => file.path === appendPath)?.status,
    'included',
  );
  assert.equal(
    files.find(file => file.path === appendPath)?.content,
    undefined,
    'mixed inline/file append content has no reliable per-source mapping',
  );
  assert.ok(!files.some(file => file.path === 'Inline appendix'));
  await writeFile(systemPath, 'SOURCE CHANGED');
  assert.equal(
    loaderContextFiles(loader, ['read'], [], cwd).find(
      file => file.path === systemPath,
    )?.content,
    'CUSTOM SOURCE',
  );
  await loader.reload();
  assert.equal(
    loaderContextFiles(loader, ['read'], [], cwd).find(
      file => file.path === systemPath,
    )?.content,
    'SOURCE CHANGED',
  );
  assert.ok(base.getAgentsFiles().agentsFiles.length > 0);
});

void test('retained reads and invoked skills survive compaction when their actual message bodies remain', async t => {
  const {cwd, loader, visiblePath} = await fixture(t);
  const manager = SessionManager.inMemory(cwd);
  await appendRead(manager, cwd, 'removed', 'guide.md');
  const keep = manager.appendMessage({
    role: 'user',
    content: `<skill name="visible" location="${visiblePath}">\nINVOKED SKILL BODY\n</skill>\n\nUse this skill`,
    timestamp: Date.now(),
  });
  await appendRead(manager, cwd, 'retained', 'guide.md', 2, 1);
  appendReadCall(manager, 'invalid', {path: 'file://%broken.md'});
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'invalid',
    toolName: 'read',
    content: [{type: 'text', text: 'Invalid URL'}],
    isError: true,
    timestamp: Date.now(),
  });
  manager.appendCompaction('Older read summarized', keep, 3000);
  const files = loaderContextFiles(
    loader,
    ['read'],
    manager.buildSessionContext().messages,
    cwd,
  );
  const guide = files.find(file => file.path === join(cwd, 'guide.md'))!;
  assert.match(guide.content!, /SECOND LINE/);
  assert.doesNotMatch(guide.content!, /FIRST LINE/);
  const skill = files.find(file => file.path === visiblePath)!;
  assert.equal(skill.status, 'included');
  assert.match(skill.content!, /INVOKED SKILL BODY/);
  assert.match(skill.description, /Invoked skill body retained/);
});

void test('total context previews are bounded while every loaded path remains visible', async t => {
  const {cwd, loader} = await fixture(t);
  const inherited = Object.create(loader) as DefaultResourceLoader;
  inherited.getAgentsFiles = () => ({
    agentsFiles: Array.from({length: 12}, (_, index) => ({
      path: join(cwd, `${index}.md`),
      content: 'x'.repeat(16000),
    })),
  });
  const files = loaderContextFiles(inherited, ['read'], [], cwd);
  assert.equal(files.filter(file => file.kind === 'instructions').length, 12);
  const previews = files.flatMap(file =>
    file.content === undefined ? [] : [file.content],
  );
  assert.equal(previews.length, 8);
  assert.ok(
    previews.reduce(
      (sum, value) => sum + value.replace('\n[Preview truncated]', '').length,
      0,
    ) <= 64000,
  );
});
