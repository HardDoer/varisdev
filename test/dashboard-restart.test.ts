import assert from 'node:assert/strict';
import {
  access,
  readFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import {createDashboardParent} from '../src/dashboard/parent.ts';
import {DashboardHub, type DashboardParent} from '../src/dashboard/hub.ts';
import type {DesktopStartup} from '../src/desktop/startup.ts';
import {saveAgentTemplate} from '../src/agents/templates.ts';

void test(
  'live restart snapshots preserve buffered blank parents, custom entries, active tools and CLI resources through real SDK restoration',
  {timeout: 15000},
  async t => {
    const root = await mkdtemp(join(tmpdir(), 'varisdev-dashboard-restart-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const parents: DashboardParent[] = [];
    const lifecycle: {hub?: DashboardHub} = {};
    t.after(async () => {
      await lifecycle.hub?.close();
      await Promise.all(parents.map(parent => parent.close()));
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, {recursive: true, force: true});
    });
    await mkdir(cwd, {recursive: true});
    await mkdir(agentDir, {recursive: true});
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({retry: {enabled: false}}),
    );
    const extension = join(root, 'restart-fixture.mjs');
    await writeFile(
      extension,
      `export default function(pi) {
    pi.registerVirtualModel({
      provider: 'restart-router', id: 'auto', name: 'Restart router',
      thinkingLevels: ['off', 'high'],
      route() { throw new Error('Restart must not dispatch a model request.'); }
    });
    pi.registerCommand('remember-restart', {
      description: 'Record custom state without an assistant response',
      async handler() {
        pi.appendEntry('restart-note', {value: 'Preserve this custom entry'});
        pi.sendMessage({customType: 'restart-message', content: 'A custom message before any assistant output.', display: true, details: {marker: 'retained'}});
        pi.setActiveTools(['read']);
      }
    });
  }`,
    );
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({
        retry: {enabled: false},
        extensions: [extension],
        default_agent: 'new-default',
      }),
    );
    await saveAgentTemplate(cwd, {
      scope: 'global',
      id: 'new-default',
      name: 'New default',
      mode: 'primary',
      instructions: 'New conversations only profile body.',
    });
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    registry.registerProvider('restart-fixture', {
      api: 'openai-completions',
      baseUrl: 'https://example.invalid',
      apiKey: 'local-fixture-key',
      models: [
        {
          id: 'restart-model',
          name: 'Restart fixture',
          reasoning: true,
          input: ['text'],
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          contextWindow: 32000,
          maxTokens: 1000,
        },
      ],
      streamSimple() {
        throw new Error('Restart snapshots must require no model requests.');
      },
    });
    t.after(() => registry.unregisterProvider('restart-fixture'));
    registry.registerVirtualModel({
      provider: 'restart-router',
      id: 'auto',
      name: 'Restart router',
      thinkingLevels: ['off', 'high'],
      route() {
        throw new Error('Restart must not dispatch a model request.');
      },
    });
    const inherited = {
      model: registry.find('restart-router', 'auto')!,
      modelRegistry: registry,
      thinkingLevel: 'high' as const,
    };
    const source = SessionManager.create(cwd, join(root, 'sessions'));
    const sourceId = source.getSessionId();
    const sourceFile = source.getSessionFile()!;
    const argv = [
      '--no-extensions',
      '-e',
      extension,
      '-e',
      'builtin:codemode',
      '-e',
      'builtin:tool-search',
      '-e',
      'builtin:mcp',
      '--no-mcp',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--system-prompt',
      'Live restart system prompt marker',
    ];
    const startup: DesktopStartup = {
      cwd,
      agentDir,
      sessionDir: source.getSessionDir(),
      sessionFile: sourceFile,
      entries: [source.getHeader()!],
      leafId: null,
      model: {provider: inherited.model.provider, id: inherited.model.id},
      thinkingLevel: 'high',
      tools: ['read', 'write', 'codemode', 'tool_search'],
      argv,
    };
    const parent = await createDashboardParent(
      {cwd, name: 'Blank draft parent'},
      inherited,
      startup,
    );
    parents.push(parent);
    const blank = parent.restartSnapshot();
    assert.equal(parent.state.snapshot().session.id, sourceId);
    assert.equal(blank.entries[0].type, 'session');
    assert.equal(blank.entries[0].id, sourceId);
    assert.equal(
      (await parent.features()).agentProfile?.id,
      'default',
      'legacy startup receives neutral Default instead of a later configured default',
    );
    assert.ok(
      blank.entries.some(
        entry =>
          entry.type === 'custom' &&
          entry.customType === 'varisdev.agent-profile' &&
          (entry.data as {id?: string}).id === 'default',
      ),
    );
    assert.deepEqual(blank.tools, ['read', 'write', 'codemode', 'tool_search']);
    assert.ok(
      !(await parent.features()).commands.some(
        command => command.name === 'mcp',
      ),
    );
    assert.deepEqual(blank.argv, argv);
    assert.equal(blank.thinkingLevel, 'high');
    assert.deepEqual(blank.model, startup.model);
    assert.ok(
      !blank.entries.some(
        entry => entry.type === 'message' && entry.message.role === 'assistant',
      ),
    );
    // A real file-backed SDK session has buffered its header and initial state.
    const fresh = await createDashboardParent(
      {cwd, name: 'Never sent a prompt'},
      inherited,
    );
    parents.push(fresh);
    assert.ok(
      (await fresh.features()).commands.some(command => command.name === 'mcp'),
    );
    assert.equal((await fresh.features()).agentProfile?.id, 'new-default');
    const unsent = fresh.restartSnapshot();
    assert.ok(unsent.sessionFile);
    await assert.rejects(access(unsent.sessionFile), /ENOENT/);
    const unsentId = fresh.state.snapshot().session.id;
    await fresh.prompt('/remember-restart');
    const bufferedCustom = fresh.restartSnapshot();
    await assert.rejects(access(bufferedCustom.sessionFile!), /ENOENT/);
    assert.ok(
      bufferedCustom.entries.some(
        entry => entry.type === 'custom' && entry.customType === 'restart-note',
      ),
    );
    const restoredBlank = await createDashboardParent({cwd}, inherited, unsent);
    parents.push(restoredBlank);
    assert.equal(
      restoredBlank.state.snapshot().session.id,
      unsentId,
      'A missing file must not generate a new parent ID',
    );
    const restoredBlankSnapshot = restoredBlank.restartSnapshot();
    assert.deepEqual(
      restoredBlankSnapshot.entries.slice(0, unsent.entries.length),
      JSON.parse(JSON.stringify(unsent.entries)),
    );
    assert.equal(restoredBlankSnapshot.leafId, unsent.leafId);
    const restoredBuffered = await createDashboardParent(
      {cwd},
      inherited,
      bufferedCustom,
    );
    parents.push(restoredBuffered);
    assert.equal(restoredBuffered.state.snapshot().session.id, unsentId);
    assert.deepEqual(
      restoredBuffered.restartSnapshot().entries,
      JSON.parse(JSON.stringify(bufferedCustom.entries)),
    );
    assert.equal(
      restoredBuffered.restartSnapshot().leafId,
      bufferedCustom.leafId,
    );
    assert.match(
      await readFile(bufferedCustom.sessionFile!, 'utf8'),
      /restart-note/,
    );
    await parent.prompt('/remember-restart');
    const custom = parent.restartSnapshot();
    assert.deepEqual(
      custom.tools,
      ['read'],
      'Snapshot the live active subset instead of every registered tool',
    );
    assert.ok(
      custom.entries.some(
        entry => entry.type === 'custom' && entry.customType === 'restart-note',
      ),
    );
    assert.ok(
      custom.entries.some(
        entry =>
          entry.type === 'custom_message' &&
          entry.customType === 'restart-message',
      ),
    );
    assert.ok(
      !custom.entries.some(
        entry => entry.type === 'message' && entry.message.role === 'assistant',
      ),
    );
    const restored = await createDashboardParent({cwd}, inherited, custom);
    parents.push(restored);
    const roundTrip = restored.restartSnapshot();
    assert.equal(restored.state.snapshot().session.id, sourceId);
    assert.deepEqual(
      roundTrip.entries,
      JSON.parse(JSON.stringify(custom.entries)),
    );
    assert.equal(roundTrip.leafId, custom.leafId);
    assert.deepEqual(roundTrip.tools, custom.tools);
    assert.deepEqual(roundTrip.argv, argv);
    assert.equal(roundTrip.thinkingLevel, 'high');
    assert.deepEqual(roundTrip.model, startup.model);
    assert.ok(
      (await restored.features()).commands.some(
        command => command.name === 'remember-restart',
      ),
      'Original explicit extension flags still load the CLI resource',
    );
    assert.ok(
      restored.state
        .snapshot()
        .conversation.some(
          message =>
            message.text === 'A custom message before any assistant output.',
        ),
    );
    const hub = new DashboardHub(
      undefined,
      async () => {
        throw new Error('Restart collection must use existing live parents.');
      },
      cwd,
    );
    lifecycle.hub = hub;
    hub.adoptSession(parent);
    hub.adoptSession(fresh);
    await new Promise<void>(resolve => setImmediate(resolve));
    const captured = hub.restartSnapshots();
    assert.equal(captured.length, 2);
    assert.deepEqual(captured[0].entries, custom.entries);
    assert.equal(captured[1].entries[0].id, unsentId);
    captured[0].argv.push('mutation');
    assert.deepEqual(
      parent.restartSnapshot().argv,
      argv,
      'Snapshots do not mutate live startup options',
    );
    assert.equal(sourceFile.includes(sourceId), true);
  },
);
