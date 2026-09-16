import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import {
  readHandoverSettings,
  registerHandoverSettingsCommands,
  writeHandoverSetting,
} from '../src/handover-settings.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'varisdev-handover-settings-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(cwd);
  await mkdir(agentDir);
  const globalPath = join(agentDir, 'varisdev.json');
  const projectPath = join(cwd, '.pi', 'varisdev.json');
  return {cwd, agentDir, globalPath, projectPath};
}

void test('missing settings files enable both automatic steps', async t => {
  const {cwd, agentDir, projectPath} = await fixture(t);
  assert.deepEqual(await readHandoverSettings(cwd, agentDir), {
    'auto-handover': 'on',
    'auto-session-refresh': 'on',
  });
  await assert.rejects(readFile(projectPath), {code: 'ENOENT'});
});

void test('project settings override global settings and each read sees changes', async t => {
  const {cwd, agentDir, globalPath, projectPath} = await fixture(t);
  await writeFile(globalPath, '{"auto-handover":"off","unrelated":true}');
  assert.deepEqual(await readHandoverSettings(cwd, agentDir), {
    'auto-handover': 'off',
    'auto-session-refresh': 'on',
  });
  await mkdir(join(cwd, '.pi'));
  await writeFile(
    projectPath,
    '{"auto-handover":"on","auto-session-refresh":"off"}',
  );
  assert.deepEqual(await readHandoverSettings(cwd, agentDir), {
    'auto-handover': 'on',
    'auto-session-refresh': 'off',
  });
  await writeFile(projectPath, '{}');
  assert.deepEqual(await readHandoverSettings(cwd, agentDir), {
    'auto-handover': 'off',
    'auto-session-refresh': 'on',
  });
});

void test('invalid JSON, roots and present values report the offending file', async t => {
  const {cwd, agentDir, globalPath, projectPath} = await fixture(t);
  await mkdir(join(cwd, '.pi'));
  const rejectsAt = (path: string, detail: string) => (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(path), error.message);
    assert.ok(error.message.includes(detail), error.message);
    return true;
  };

  await writeFile(globalPath, '{');
  await assert.rejects(
    readHandoverSettings(cwd, agentDir),
    rejectsAt(globalPath, 'JSON'),
  );
  await writeFile(globalPath, '{}');
  await writeFile(projectPath, '[]');
  await assert.rejects(
    readHandoverSettings(cwd, agentDir),
    rejectsAt(projectPath, 'JSON object'),
  );
  await writeFile(globalPath, '{"auto-handover":null}');
  await writeFile(projectPath, '{"auto-handover":"on"}');
  await assert.rejects(
    readHandoverSettings(cwd, agentDir),
    rejectsAt(globalPath, '"auto-handover" must be "on" or "off"'),
  );
  await writeFile(globalPath, '{}');
  const invalidProject = '{"auto-session-refresh":false}';
  await writeFile(projectPath, invalidProject);
  await assert.rejects(
    readHandoverSettings(cwd, agentDir),
    rejectsAt(projectPath, '"auto-session-refresh" must be "on" or "off"'),
  );
  await assert.rejects(
    writeHandoverSetting(cwd, 'auto-handover', 'off'),
    rejectsAt(projectPath, 'auto-session-refresh'),
  );
  assert.equal(await readFile(projectPath, 'utf8'), invalidProject);
});

void test('writes create project settings and preserve other fields and global settings', async t => {
  const {cwd, globalPath, projectPath} = await fixture(t);
  const global = '{"auto-handover":"off"}';
  await writeFile(globalPath, global);
  await writeHandoverSetting(cwd, 'auto-session-refresh', 'off');
  assert.deepEqual(JSON.parse(await readFile(projectPath, 'utf8')), {
    'auto-session-refresh': 'off',
  });
  await writeFile(
    projectPath,
    '{"auto-session-refresh":"off","editor":{"theme":"dark"}}',
  );
  await writeHandoverSetting(cwd, 'auto-handover', 'on');
  assert.deepEqual(JSON.parse(await readFile(projectPath, 'utf8')), {
    'auto-handover': 'on',
    'auto-session-refresh': 'off',
    editor: {theme: 'dark'},
  });
  assert.equal(await readFile(globalPath, 'utf8'), global);
});

void test('overlapping setting writes retain both changes and unrelated fields', async t => {
  const {cwd, projectPath} = await fixture(t);
  await mkdir(join(cwd, '.pi'));
  await writeFile(
    projectPath,
    '{"auto-handover":"on","auto-session-refresh":"on","editor":{"theme":"dark"}}',
  );
  await Promise.all([
    writeHandoverSetting(cwd, 'auto-handover', 'off'),
    writeHandoverSetting(cwd, 'auto-session-refresh', 'off'),
  ]);
  assert.deepEqual(JSON.parse(await readFile(projectPath, 'utf8')), {
    'auto-handover': 'off',
    'auto-session-refresh': 'off',
    editor: {theme: 'dark'},
  });
});

void test('commands display both effective states, persist settings and reject invalid arguments', async t => {
  const {cwd, agentDir, globalPath, projectPath} = await fixture(t);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  await writeFile(globalPath, '{"auto-session-refresh":"off"}');
  type Command = Parameters<ExtensionAPI['registerCommand']>[1];
  const commands = new Map<string, Command>();
  const notifications: Array<{message: string; type: string}> = [];
  const pi = {
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    ui: {
      notify(message: string, type: string) {
        notifications.push({message, type});
      },
    },
  } as unknown as ExtensionCommandContext;
  registerHandoverSettingsCommands(pi);
  assert.deepEqual(
    [...commands.keys()],
    ['auto-handover', 'auto-session-refresh'],
  );
  const handover = commands.get('auto-handover')!;
  const refresh = commands.get('auto-session-refresh')!;
  await handover.handler('', ctx);
  assert.deepEqual(notifications.pop(), {
    message: 'auto-handover: on\nauto-session-refresh: off',
    type: 'info',
  });
  await assert.rejects(readFile(projectPath), {code: 'ENOENT'});
  await handover.handler(' off ', ctx);
  assert.equal(
    notifications.pop()?.message,
    'auto-handover: off\nauto-session-refresh: off',
  );
  await refresh.handler('on', ctx);
  assert.equal(
    notifications.pop()?.message,
    'auto-handover: off\nauto-session-refresh: on',
  );
  const saved = await readFile(projectPath, 'utf8');
  assert.deepEqual(JSON.parse(saved), {
    'auto-handover': 'off',
    'auto-session-refresh': 'on',
  });
  await refresh.handler('on off', ctx);
  assert.deepEqual(notifications.pop(), {
    message: 'Usage: /auto-session-refresh [on|off]',
    type: 'error',
  });
  assert.equal(await readFile(projectPath, 'utf8'), saved);
  await writeFile(projectPath, 'null');
  await refresh.handler('', ctx);
  assert.equal(notifications.at(-1)?.type, 'error');
  assert.ok(notifications.at(-1)?.message.includes(projectPath));
});
