import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {delimiter, dirname, join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {runCommand} from '../scripts/test-installer.mjs';
import {collectDoctorReport} from '../assets/skills/doctor/scripts/diagnose.mjs';
import {
  createEnvironmentSettings,
  environmentPath,
} from '../src/runtime/environment.mjs';
import {readToolSettings} from '../src/tools/settings.ts';
import {createDirectoryLink} from './filesystem.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const helper = join(root, 'assets/skills/doctor/scripts/diagnose.mjs');
type Check = {id: string; status: string; [key: string]: unknown};
type Report = {
  formatVersion: number;
  installationRoot: string;
  paths: Record<string, string>;
  checks: Check[];
  limits: string[];
};
const check = (report: Report, id: string) => {
  const found = report.checks.find(item => item.id === id);
  assert.ok(found, `Missing ${id}`);
  return found;
};

async function fixture(t: TestContext) {
  const base = join(root, '.varisdev');
  await mkdir(base, {recursive: true});
  const home = await mkdtemp(join(base, 'doctor-test-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const project = join(home, 'project');
  await mkdir(project);
  await writeFile(join(project, '.git'), 'gitdir: isolated-fixture');
  const agent = join(home, '.varisdev/agent');
  const data = join(home, 'app-data');
  const env = {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, 'local-app-data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    VARISDEV_DATA_DIR: data,
    PATH: process.env.PATH || process.env.Path || '',
  };
  const environment =
    process.platform === 'darwin'
      ? join(home, 'Library/Application Support/VarisDev/environment.json')
      : process.platform === 'win32'
        ? join(env.LOCALAPPDATA, 'VarisDev/environment.json')
        : join(env.XDG_CONFIG_HOME, 'varisdev/environment.json');
  async function put(path: string, value: unknown, raw = false) {
    await mkdir(dirname(path), {recursive: true});
    await writeFile(path, raw ? String(value) : JSON.stringify(value));
  }
  async function diagnose(
    overrides: Record<string, string> = {},
    appRoot = root,
  ) {
    return (await collectDoctorReport({
      project,
      root: appRoot,
      env: {...env, ...overrides},
    })) as Report;
  }
  return {home, project, agent, data, env, environment, put, diagnose};
}

async function snapshot(directory: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result[entry.name] = await snapshot(path);
    else {
      const info = await stat(path);
      result[entry.name] = {
        content: await readFile(path, 'utf8'),
        mode: info.mode,
        modified: info.mtimeMs,
      };
    }
  }
  return result;
}

void test(
  'doctor finds the selected profile, canonical workspace, and scoped preference overlaps',
  {timeout: 20000},
  async t => {
    const f = await fixture(t);
    await f.put(join(f.project, '.git'), 'gitdir: fixture', true);
    await f.put(join(f.agent, 'settings.json'), {
      defaultModel: 'global-model',
      compaction: {enabled: true},
    });
    await f.put(join(f.project, '.varisdev/settings.json'), {
      defaultModel: 'repository-model',
    });
    const canonicalProject = await realpath(f.project);
    const workspace = join(
      f.agent,
      'workspaces',
      createHash('sha256').update(canonicalProject).digest('hex'),
    );
    await f.put(join(workspace, 'settings.json'), {
      defaultModel: 'workspace-model',
    });
    const report = await f.diagnose({
      VARISDEV_SETTINGS_DIR: join(f.home, '.varisdev'),
      PI_CODING_AGENT_DIR: join(f.home, '.pi/agent'),
    });
    assert.equal(report.formatVersion, 1);
    assert.equal(report.paths.settings, f.agent);
    assert.equal(report.paths.workspace, workspace);
    assert.equal(report.paths.environment, f.environment);
    assert.equal(check(report, 'settings.global').status, 'ok');
    assert.equal(
      check(report, 'settings.repository').requiresProjectTrust,
      true,
    );
    assert.equal(check(report, 'settings.workspace').status, 'ok');
    assert.deepEqual(check(report, 'settings.precedence').overrides, [
      {lower: 'global', higher: 'repository', fields: ['defaultModel']},
      {lower: 'global', higher: 'workspace', fields: ['defaultModel']},
      {lower: 'repository', higher: 'workspace', fields: ['defaultModel']},
    ]);
    assert.equal(check(report, 'settings.foreign-overrides').status, 'info');
    assert.equal(check(report, 'context.live').status, 'unknown');
    assert.equal(check(report, 'updates.latest').status, 'unknown');
    assert.equal(JSON.stringify(report).includes('workspace-model'), false);
  },
);

void test(
  'doctor matches Windows trust path casing and the nearest saved decision',
  {timeout: 20000, skip: process.platform !== 'win32'},
  async t => {
    const {ProjectTrustStore} = await import('@earendil-works/pi-coding-agent');
    const f = await fixture(t);
    const project = join(f.project, 'MiXeD-Project');
    await mkdir(project);
    const canonicalProject = await realpath(project);
    const parent = dirname(canonicalProject);
    const store = new ProjectTrustStore(f.agent);
    for (const [entries, expected] of [
      [{[canonicalProject.toLowerCase()]: true, [parent]: false}, true],
      [{[canonicalProject.toLowerCase()]: false, [parent]: true}, false],
      [
        {[canonicalProject.toLowerCase()]: null, [parent.toUpperCase()]: true},
        true,
      ],
      [
        {
          [canonicalProject.toLowerCase()]: null,
          [canonicalProject.toUpperCase()]: true,
          [parent]: false,
        },
        true,
      ],
    ] as const) {
      await f.put(join(f.agent, 'trust.json'), entries);
      const decision = store.get(project);
      assert.equal(decision, expected);
      const before = await snapshot(f.home);
      const report = (await collectDoctorReport({
        project,
        root,
        env: f.env,
      })) as Report;
      assert.equal(
        check(report, 'settings.trust').savedDecision,
        decision ? 'trusted' : 'untrusted',
      );
      assert.deepEqual(await snapshot(f.home), before);
    }
  },
);

void test(
  'doctor rejects malformed settings, validates model JSON with the shipped parser, and preserves files',
  {timeout: 20000},
  async t => {
    const f = await fixture(t);
    const secret = 'malformed-json-secret-DO-NOT-PRINT';
    await f.put(
      join(f.agent, 'settings.json'),
      `{"defaultModel": ${secret}}`,
      true,
    );
    await f.put(join(f.project, '.varisdev/settings.json'), {
      compaction: {enabled: 'wrong-type'},
    });
    await f.put(
      join(f.agent, 'models.json'),
      '{\n// custom model list\n"providers": {},\n}',
      true,
    );
    await f.put(join(f.agent, 'varisdev/tool-settings.json'), {
      agents: {allowedModels: ['not-a-provider-model'], maxConcurrentAgents: 0},
    });
    const before = await snapshot(f.home);
    const report = await f.diagnose();
    assert.equal(check(report, 'settings.global').status, 'error');
    assert.equal(check(report, 'settings.global').state, 'invalid-json');
    assert.equal(check(report, 'settings.repository').status, 'error');
    assert.equal(check(report, 'settings.models').status, 'ok');
    assert.equal(check(report, 'settings.tools').status, 'error');
    assert.equal(JSON.stringify(report).includes(secret), false);
    assert.deepEqual(await snapshot(f.home), before);
    await f.put(join(f.agent, 'settings.json'), ['invalid root']);
    assert.equal(
      check(await f.diagnose(), 'settings.global').state,
      'invalid-object',
    );
  },
);

void test(
  'saved empty environment overrides inherited keys while OAuth remains an independent presence observation',
  {timeout: 20000},
  async t => {
    const f = await fixture(t);
    const machineKey = 'machine-key-secret-never-print';
    const savedValue = 'saved-config-secret-never-print';
    await f.put(f.environment, {
      OPENAI_API_KEY: '',
      CUSTOM_VALUE: savedValue,
      BOOLISH: 'false',
    });
    await f.put(join(f.agent, 'auth.json'), {
      'openai-codex': {
        type: 'oauth',
        access: 'access-secret-never-print',
        refresh: 'refresh-secret-never-print',
        expires: 1,
      },
      custom: {
        type: 'api_key',
        key: '!never-execute-auth-command secret-command',
        env: {TOKEN: 'auth-env-secret'},
      },
    });
    const before = await snapshot(f.home);
    const report = await f.diagnose({OPENAI_API_KEY: machineKey});
    const variables = check(report, 'environment.sources').variables as Array<{
      name: string;
      source: string;
      present: boolean;
    }>;
    assert.deepEqual(
      variables.find(item => item.name === 'OPENAI_API_KEY'),
      {
        name: 'OPENAI_API_KEY',
        source: 'saved',
        present: false,
        inheritedPresence: 'present (may already include the app overlay)',
      },
    );
    assert.equal(
      variables.find(item => item.name === 'CUSTOM_VALUE')?.source,
      'saved',
    );
    const credentials = check(report, 'auth.presence').credentials as Array<
      Record<string, unknown>
    >;
    assert.equal(credentials[0].kind, 'oauth');
    assert.equal(credentials[0].expired, true);
    assert.equal(credentials[1].key, 'command (not evaluated)');
    assert.equal(check(report, 'auth.plugin-contracts').status, 'info');
    const output = JSON.stringify(report);
    for (const value of [
      machineKey,
      savedValue,
      'access-secret-never-print',
      'refresh-secret-never-print',
      'never-execute-auth-command',
      'auth-env-secret',
    ])
      assert.equal(output.includes(value), false, value);
    assert.deepEqual(await snapshot(f.home), before);
    // Removing a saved value restores the inherited source without persisting it.
    await rm(f.environment);
    const fallback = await f.diagnose({OPENAI_API_KEY: machineKey});
    const fallbackVariables = check(fallback, 'environment.sources')
      .variables as typeof variables;
    assert.equal(
      fallbackVariables.find(item => item.name === 'OPENAI_API_KEY')?.source,
      'inherited process',
    );
    assert.equal(JSON.stringify(fallback).includes(machineKey), false);
    await assert.rejects(stat(f.environment), {code: 'ENOENT'});
  },
);

void test('doctor uses the application environment fallback when Windows home directories differ', async t => {
  const f = await fixture(t);
  const env = {
    ...f.env,
    USERPROFILE: join(f.home, 'settings-home'),
    LOCALAPPDATA: '',
  };
  const environment = environmentPath(env, 'win32');
  await f.put(environment, {OPENAI_API_KEY: 'saved-key-never-print'});
  const before = await snapshot(f.home);
  const report = (await collectDoctorReport({
    project: f.project,
    root,
    env,
    platform: 'win32',
  })) as Report;
  assert.equal(report.paths.environment, environment);
  assert.equal(report.paths.settings, join(env.USERPROFILE, '.varisdev/agent'));
  const variables = check(report, 'environment.sources').variables as Array<{
    name: string;
    source: string;
    present: boolean;
  }>;
  assert.deepEqual(
    variables.find(item => item.name === 'OPENAI_API_KEY'),
    {
      name: 'OPENAI_API_KEY',
      source: 'saved',
      present: true,
      inheritedPresence: 'absent',
    },
  );
  assert.equal(JSON.stringify(report).includes('saved-key-never-print'), false);
  assert.deepEqual(await snapshot(f.home), before);
});

void test('doctor accepts long saved environment names supported by the app without losing other overrides', async t => {
  const f = await fixture(t);
  const name = 'DOCTOR_' + 'A'.repeat(122);
  const settings = createEnvironmentSettings({
    env: {...f.env},
    file: f.environment,
    readEnvironment: async () => ({}),
  });
  await settings.save(name, 'long-name-secret');
  await settings.save('OPENAI_API_KEY', 'long-name-api-secret');
  const saved = await settings.get();
  assert.equal(saved.values[name], 'long-name-secret');
  assert.equal(saved.values.OPENAI_API_KEY, 'long-name-api-secret');
  const before = await snapshot(f.home);
  const report = await f.diagnose();
  assert.equal(check(report, 'environment.file').status, 'ok');
  const variables = check(report, 'environment.sources').variables as Array<{
    name: string;
    source: string;
    present: boolean;
  }>;
  for (const key of [name, 'OPENAI_API_KEY']) {
    const variable = variables.find(item => item.name === key);
    assert.equal(variable?.source, 'saved', key);
    assert.equal(variable?.present, true, key);
  }
  assert.doesNotMatch(
    JSON.stringify(report),
    /long-name-secret|long-name-api-secret/,
  );
  assert.deepEqual(await snapshot(f.home), before);
});

void test('doctor rejects BOM-prefixed app settings like the production readers', async t => {
  const f = await fixture(t);
  const env = {...f.env, DOCTOR_BOM_KEY: 'inherited-bom-secret'};
  await f.put(
    f.environment,
    '\uFEFF' +
      JSON.stringify({
        DOCTOR_BOM_KEY: 'saved-bom-secret',
        VARISDEV_SETTINGS_DIR: join(f.home, 'wrong-profile'),
      }),
    true,
  );
  await f.put(
    join(f.agent, 'varisdev/tool-settings.json'),
    '\uFEFF' + JSON.stringify({agents: {allowedModels: []}}),
    true,
  );
  const settings = createEnvironmentSettings({
    env: {...env},
    file: f.environment,
    readEnvironment: async () => ({...env}),
  });
  await assert.rejects(
    settings.initialize(),
    /Could not read environment.json/,
  );
  await assert.rejects(readToolSettings(f.agent), /Cannot read tool settings/);
  const before = await snapshot(f.home);
  const report = (await collectDoctorReport({
    project: f.project,
    root,
    env,
  })) as Report;
  for (const id of ['environment.file', 'settings.tools']) {
    assert.equal(check(report, id).status, 'error');
    assert.equal(check(report, id).state, 'invalid-json');
  }
  assert.equal(report.paths.settings, f.agent);
  const variables = check(report, 'environment.sources').variables as Array<{
    name: string;
    source: string;
    present: boolean;
  }>;
  assert.deepEqual(
    variables.find(item => item.name === 'DOCTOR_BOM_KEY'),
    {
      name: 'DOCTOR_BOM_KEY',
      source: 'inherited process',
      present: true,
    },
  );
  assert.doesNotMatch(
    JSON.stringify(report),
    /inherited-bom-secret|saved-bom-secret/,
  );
  assert.deepEqual(await snapshot(f.home), before);
});

void test('doctor preserves BOM support for Pi configuration formats', async t => {
  const f = await fixture(t);
  for (const [name, value] of [
    ['settings.json', {retry: {enabled: false}}],
    ['models.json', {providers: {}}],
    ['auth.json', {custom: {type: 'api_key', key: 'bom-auth-secret'}}],
    ['trust.json', {[await realpath(f.project)]: true}],
    ['mcp.json', {mcpServers: {}}],
  ] as const)
    await f.put(join(f.agent, name), '\uFEFF' + JSON.stringify(value), true);
  const before = await snapshot(f.home);
  const report = await f.diagnose();
  for (const [id, status] of [
    ['settings.global', 'ok'],
    ['settings.models', 'ok'],
    ['auth.presence', 'info'],
    ['settings.trust', 'info'],
    ['mcp.global', 'info'],
  ]) {
    assert.equal(check(report, id).status, status, id);
    assert.equal(check(report, id).state, 'valid', id);
  }
  assert.equal(check(report, 'settings.trust').savedDecision, 'trusted');
  assert.doesNotMatch(JSON.stringify(report), /bom-auth-secret/);
  assert.deepEqual(await snapshot(f.home), before);
});

void test(
  'invalid saved environment does not silently apply a subset or leak its contents',
  {timeout: 20000},
  async t => {
    const f = await fixture(t);
    await f.put(f.environment, {
      OPENAI_API_KEY: 'unapplied-secret',
      HOME: 'invalid-configurable-field',
    });
    const report = await f.diagnose();
    assert.equal(check(report, 'environment.file').status, 'error');
    const variables = check(report, 'environment.sources').variables as Array<{
      name: string;
      source: string;
    }>;
    assert.equal(
      variables.find(item => item.name === 'OPENAI_API_KEY')?.source,
      'absent',
    );
    assert.equal(JSON.stringify(report).includes('unapplied-secret'), false);
    assert.equal(report.paths.settings, f.agent);
  },
);

void test(
  'MCP reports invalid entries, namespace collisions, overrides and missing references without executing user code',
  {timeout: 20000},
  async t => {
    const f = await fixture(t);
    const marker = join(f.home, 'must-not-exist');
    const command = `!node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed')"`;
    const plugin = join(f.home, 'plugin');
    await f.put(
      join(plugin, 'index.mjs'),
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');`,
      true,
    );
    await f.put(join(f.agent, 'settings.json'), {
      packages: [
        plugin,
        'https://user:plugin-url-secret@example.invalid/plugin?token=secret',
      ],
      extensions: [join(plugin, 'index.mjs')],
    });
    await f.put(join(f.agent, 'auth.json'), {
      custom: {type: 'api_key', key: command},
    });
    await f.put(join(f.agent, 'mcp.json'), {
      mcpServers: {
        'repo-tools': {
          command: process.execPath,
          args: [
            '-e',
            `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`,
          ],
          env: {TOKEN: '${MISSING_TOKEN}', ESCAPED: '$$NOT_A_REFERENCE'},
        },
        repo_tools: {
          url: 'https://user:mcp-url-secret@example.invalid/mcp?token=query-secret',
          headers: {Authorization: 'Bearer header-secret', 'X-Key': command},
        },
        invalid: {command: 3},
      },
    });
    await f.put(join(f.project, '.varisdev/mcp.json'), {
      mcpServers: {
        'repo-tools': {enabled: false},
        prohibited: {
          url: 'https://example.invalid',
          auth: {provider: 'openai'},
        },
      },
    });
    const first = await f.diagnose();
    await f.put(join(first.paths.workspace, 'mcp.json'), {
      mcpServers: {partial: {enabled: false}},
    });
    const before = await snapshot(f.home);
    const report = await f.diagnose();
    const entries = report.checks.filter(item => item.id === 'mcp.entry');
    assert.equal(
      entries.find(item => item.scope === 'global' && item.entry === 1)?.status,
      'warning',
    );
    assert.deepEqual(
      entries.find(item => item.scope === 'global' && item.entry === 1)
        ?.missingEnvironmentNames,
      ['MISSING_TOKEN'],
    );
    assert.equal(
      entries.find(item => item.scope === 'global' && item.entry === 2)?.status,
      'error',
    );
    assert.equal(
      entries.find(item => item.scope === 'global' && item.entry === 3)?.status,
      'error',
    );
    assert.equal(
      entries.find(item => item.scope === 'repository' && item.entry === 1)
        ?.enabled,
      false,
    );
    assert.equal(
      entries.find(item => item.scope === 'repository' && item.entry === 2)
        ?.status,
      'error',
    );
    assert.equal(
      entries.find(item => item.scope === 'workspace')?.status,
      'error',
    );
    assert.equal(check(report, 'mcp.live').status, 'unknown');
    assert.equal(check(report, 'plugins.runtime').status, 'unknown');
    for (const value of [
      'plugin-url-secret',
      'mcp-url-secret',
      'query-secret',
      'header-secret',
      marker,
      command,
    ])
      assert.equal(JSON.stringify(report).includes(value), false, value);
    await assert.rejects(stat(marker), {code: 'ENOENT'});
    assert.deepEqual(await snapshot(f.home), before);
  },
);

void test(
  'PATH candidates identify distinct installs, with update problems reported independently of latest release',
  {timeout: 20000},
  async t => {
    const f = await fixture(t);
    const directories = [join(f.home, 'one'), join(f.home, 'two')];
    for (const directory of directories) {
      const executable = join(
        directory,
        process.platform === 'win32' ? 'varisdev.cmd' : 'varisdev',
      );
      await f.put(executable, 'DO NOT EXECUTE', true);
      await chmod(executable, 0o755);
    }
    await f.put(join(f.data, 'active.json'), {
      generation: '../../escape-secret',
      baseRoot: root,
      version: '1.0.0',
    });
    await mkdir(join(f.data, 'update.lock'));
    const report = await f.diagnose({PATH: directories.join(delimiter)});
    assert.equal(check(report, 'path.varisdev').status, 'warning');
    assert.equal(
      (check(report, 'path.varisdev').matches as unknown[]).length,
      2,
    );
    assert.equal(check(report, 'updates.activation').status, 'warning');
    assert.equal(check(report, 'updates.lock').status, 'info');
    assert.equal(check(report, 'updates.latest').status, 'unknown');
    assert.equal(JSON.stringify(report).includes('escape-secret'), false);
  },
);

void test(
  'installed helper invocation resolves its application root and bounds oversized settings without creating state',
  {timeout: 30000},
  async t => {
    const f = await fixture(t);
    const installed = join(f.home, 'installed app');
    const installedHelper = join(
      installed,
      'assets/skills/doctor/scripts/diagnose.mjs',
    );
    await mkdir(dirname(installedHelper), {recursive: true});
    await copyFile(helper, installedHelper);
    await f.put(join(installed, 'package.json'), {
      name: 'varisdev',
      version: '3.2.1',
    });
    await f.put(
      join(f.agent, 'settings.json'),
      '{"padding":"' + 'x'.repeat(513 * 1024) + '"}',
      true,
    );
    const before = await snapshot(f.home);
    // The process-tree runner covers the wrapper and the actual installed helper.
    await runCommand(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import assert from 'node:assert/strict';
    import {execFile} from 'node:child_process';
    import {promisify} from 'node:util';
    const {stdout, stderr} = await promisify(execFile)(process.execPath,
      [process.argv[1], '--project', process.argv[2]], {maxBuffer: 256 * 1024});
    assert.equal(stderr, '');
    const report = JSON.parse(stdout);
    assert.equal(report.installationRoot, process.argv[3]);
    assert.equal(report.checks.find(item => item.id === 'installation.application').version, '3.2.1');
    assert.equal(report.checks.find(item => item.id === 'settings.global').state, 'limited');
    assert.equal(report.checks.find(item => item.id === 'settings.global').status, 'unknown');
    assert.equal(report.checks.find(item => item.id === 'settings.global').fix, undefined);
    assert.equal(report.checks.find(item => item.id === 'context.live').status, 'unknown');
    assert.ok(stdout.length < 128 * 1024);
  `,
        installedHelper,
        f.project,
        await realpath(installed),
      ],
      {
        timeoutMs: 20000,
        cwd: root,
        env: {
          ...process.env,
          ...f.env,
          VARISDEV_SETTINGS_DIR: '',
          VARISDEV_CODING_AGENT_DIR: '',
          VARISDEV_ENVIRONMENT_FILE: '',
          __VARISDEV_ENVIRONMENT_CONTINUATION: '',
          PI_CODING_AGENT_DIR: '',
        },
      },
    );
    assert.deepEqual(await snapshot(f.home), before);
  },
);

void test('diagnostic file limits leave configuration health unknown without repair advice', async t => {
  const f = await fixture(t);
  const padding = 'x'.repeat(513 * 1024);
  for (const [path, value] of [
    [join(f.agent, 'settings.json'), {padding}],
    [join(f.agent, 'models.json'), {providers: {example: {apiKey: padding}}}],
    [join(f.agent, 'auth.json'), {example: {type: 'api_key', key: padding}}],
    [join(f.agent, 'trust.json'), {[padding]: true}],
    [
      join(f.agent, 'varisdev/tool-settings.json'),
      {agents: {allowedModels: []}, commit: padding},
    ],
    [
      join(f.project, '.varisdev/mcp.json'),
      {
        mcpServers: {
          example: {command: 'unused', env: {EXAMPLE_VALUE: padding}},
        },
      },
    ],
  ] as const)
    await f.put(path, value);
  const before = await snapshot(f.home);
  const report = await f.diagnose();
  for (const id of [
    'settings.global',
    'settings.models',
    'auth.presence',
    'settings.trust',
    'settings.tools',
    'mcp.repository',
  ]) {
    const result = check(report, id);
    assert.equal(result.state, 'limited', id);
    assert.equal(result.status, 'unknown', id);
    assert.equal(result.fix, undefined, id);
    assert.doesNotMatch(result.summary as string, /malformed|invalid|repair/i);
  }
  assert.equal(check(report, 'settings.trust').savedDecision, 'unavailable');
  assert.deepEqual(await snapshot(f.home), before);
});

void test('an unread saved environment leaves profile and credential checks unavailable', async t => {
  const f = await fixture(t);
  await f.put(f.environment, {EXAMPLE_VALUE: 'x'.repeat(513 * 1024)});
  const before = await snapshot(f.home);
  const report = await f.diagnose({OPENAI_API_KEY: 'inherited-secret'});
  assert.deepEqual(
    report.checks.map(item => item.id),
    ['environment.file'],
  );
  assert.equal(check(report, 'environment.file').status, 'unknown');
  assert.equal(check(report, 'environment.file').fix, undefined);
  assert.equal(JSON.stringify(report).includes('inherited-secret'), false);
  assert.deepEqual(await snapshot(f.home), before);
});

void test('doctor resolves repository and nested package and resource paths like the production loader', async t => {
  const f = await fixture(t);
  const nested = join(f.project, 'src');
  await mkdir(nested);
  for (const [directory, scope] of [
    [f.project, 'repository'],
    [nested, 'current'],
  ] as const) {
    const config = join(directory, '.varisdev');
    await f.put(join(config, 'settings.json'), {
      skills: ['./direct', pathToFileURL(join(config, 'url skill ä')).href],
      packages: ['./plugin', pathToFileURL(join(config, 'url plugin ä')).href],
    });
    await f.put(
      join(config, 'direct/SKILL.md'),
      `---\nname: ${scope}-direct\ndescription: ${scope} direct skill\n---\nInstructions.`,
      true,
    );
    await f.put(join(config, 'plugin/package.json'), {
      name: `${scope}-plugin`,
      version: '1.0.0',
      pi: {skills: ['./skills']},
    });
    await f.put(
      join(config, 'plugin/skills/SKILL.md'),
      `---\nname: ${scope}-package\ndescription: ${scope} package skill\n---\nInstructions.`,
      true,
    );
    await f.put(
      join(config, 'url skill ä/SKILL.md'),
      `---\nname: ${scope}-url-direct\ndescription: ${scope} URL skill\n---\nInstructions.`,
      true,
    );
    await f.put(join(config, 'url plugin ä/package.json'), {
      name: `${scope}-url-plugin`,
      version: '1.0.0',
      pi: {skills: ['./skills']},
    });
    await f.put(
      join(config, 'url plugin ä/skills/SKILL.md'),
      `---\nname: ${scope}-url-package\ndescription: ${scope} URL package skill\n---\nInstructions.`,
      true,
    );
  }
  const {DefaultResourceLoader} = (await import(
    pathToFileURL(
      join(
        root,
        'desktop/node_modules/@earendil-works/pi-coding-agent/dist/index.js',
      ),
    ).href
  )) as typeof import('@earendil-works/pi-coding-agent');
  const {createWorkspaceConfiguration} = await import(
    pathToFileURL(join(root, 'desktop/build/src/dashboard/workspace-config.js'))
      .href
  );
  const configuration = createWorkspaceConfiguration(nested, f.agent);
  configuration.settingsManager.setProjectTrusted(true);
  const loader = new DefaultResourceLoader({
    cwd: nested,
    agentDir: f.agent,
    settingsManager: configuration.resourceSettingsManager,
    ...configuration.resourceOptions({
      noExtensions: true,
      noThemes: true,
      noPromptTemplates: true,
    }),
  });
  await loader.reload();
  const names = loader.getSkills().skills.map(skill => skill.name);
  for (const name of [
    'repository-direct',
    'repository-package',
    'current-direct',
    'current-package',
    'repository-url-direct',
    'repository-url-package',
    'current-url-direct',
    'current-url-package',
  ])
    assert.ok(names.includes(name), name);
  const report = (await collectDoctorReport({
    project: nested,
    root,
    env: f.env,
  })) as Report;
  assert.equal(
    report.checks.some(item => item.id === 'plugins.resource-path'),
    false,
  );
  const packages = report.checks.filter(
    item => item.id === 'plugins.entry' && item.kind === 'local',
  );
  assert.equal(packages.length, 4);
  assert.ok(
    packages.every(item => item.exists === true && item.status === 'info'),
  );
});

void test('project MCP overrides stay unknown when their global definition cannot be established', async t => {
  for (const scenario of ['file-limit', 'entry-limit', 'invalid-base']) {
    const f = await fixture(t);
    const mcpServers =
      scenario === 'entry-limit'
        ? Object.fromEntries(
            Array.from({length: 64}, (_, index) => [
              `other-${index}`,
              {command: 'unused'},
            ]),
          )
        : {};
    await f.put(join(f.agent, 'mcp.json'), {
      mcpServers: {
        ...mcpServers,
        example:
          scenario === 'file-limit'
            ? {command: 'unused', env: {EXAMPLE_VALUE: 'x'.repeat(513 * 1024)}}
            : scenario === 'invalid-base'
              ? {command: 3}
              : {command: 'unused'},
      },
    });
    await f.put(join(f.project, '.varisdev/mcp.json'), {
      mcpServers: {example: {enabled: false}},
    });
    const before = await snapshot(f.home);
    const report = await f.diagnose();
    if (scenario === 'file-limit')
      assert.equal(check(report, 'mcp.global').status, 'unknown');
    if (scenario === 'entry-limit')
      assert.equal(check(report, 'mcp.limit').status, 'unknown');
    const override = report.checks.find(
      item => item.id === 'mcp.entry' && item.scope === 'repository',
    );
    assert.equal(override?.status, 'unknown', scenario);
    assert.equal(override?.fix, undefined, scenario);
    assert.equal(override?.transport, undefined, scenario);
    assert.deepEqual(await snapshot(f.home), before);
  }
});

void test('the helper runs beside an explicitly loaded doctor directory alias', async t => {
  const f = await fixture(t);
  const alias = join(f.home, 'doctor alias');
  await createDirectoryLink(join(root, 'assets/skills/doctor'), alias);
  const {loadSkillsFromDir} = (await import(
    pathToFileURL(
      join(
        root,
        'desktop/node_modules/@earendil-works/pi-coding-agent/dist/index.js',
      ),
    ).href
  )) as typeof import('@earendil-works/pi-coding-agent');
  const doctor = loadSkillsFromDir({dir: alias, source: 'cli'}).skills.find(
    skill => skill.name === 'doctor',
  );
  assert.ok(doctor);
  assert.equal(dirname(doctor.filePath), alias);
  for (const flags of [[], ['--preserve-symlinks-main']]) {
    await runCommand(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          import assert from 'node:assert/strict';
          import {execFile} from 'node:child_process';
          import {promisify} from 'node:util';
          const {stdout, stderr} = await promisify(execFile)(process.execPath,
            process.argv.slice(1), {maxBuffer: 256 * 1024});
          assert.equal(stderr, '');
          const report = JSON.parse(stdout);
          assert.equal(report.formatVersion, 1);
          assert.equal(report.checks.find(item => item.id === 'installation.application').status, 'ok');
          assert.equal(report.checks.find(item => item.id === 'runtime.node').status, 'ok');
        `,
        '--',
        ...flags,
        join(dirname(doctor.filePath), 'scripts/diagnose.mjs'),
        '--project',
        f.project,
      ],
      {env: f.env, timeoutMs: 20000},
    );
  }
});

void test('doctor uses the application environment file after saved configuration-location overrides', async t => {
  for (const platform of ['win32', 'linux'] as const) {
    const f = await fixture(t);
    const file = environmentPath(f.env, platform);
    const env: NodeJS.ProcessEnv = {...f.env};
    const settings = createEnvironmentSettings({
      env,
      platform,
      readEnvironment: async () => ({...f.env}),
    });
    const locationName =
      platform === 'win32' ? 'LOCALAPPDATA' : 'XDG_CONFIG_HOME';
    await settings.save(locationName, join(f.home, 'overridden-location'));
    await settings.save('OPENAI_API_KEY', 'bound-file-secret');
    const impostor = environmentPath(env, platform);
    assert.notEqual(impostor, file);
    await f.put(impostor, {
      OPENAI_API_KEY: '',
      VARISDEV_SETTINGS_DIR: join(f.home, 'wrong-profile'),
    });
    assert.equal(
      (await settings.get()).values.OPENAI_API_KEY,
      'bound-file-secret',
    );
    assert.equal(env.VARISDEV_ENVIRONMENT_FILE, file);
    const before = await snapshot(f.home);
    for (const inherited of [
      env,
      settings.forChild(env),
      settings.forChild(env, {reuseShell: true}),
    ]) {
      const report = (await collectDoctorReport({
        project: f.project,
        root,
        env: inherited,
        platform,
      })) as Report;
      assert.equal(report.paths.environment, file, platform);
      assert.equal(report.paths.settings, f.agent, platform);
      assert.equal(check(report, 'environment.file').status, 'ok', platform);
      const variables = check(report, 'environment.sources')
        .variables as Array<{
        name: string;
        source: string;
        present: boolean;
      }>;
      const key = variables.find(item => item.name === 'OPENAI_API_KEY');
      assert.equal(key?.source, 'saved', platform);
      assert.equal(key?.present, true, platform);
      assert.doesNotMatch(JSON.stringify(report), /bound-file-secret/);
    }
    for (const binding of [undefined, 'relative/environment.json']) {
      const report = (await collectDoctorReport({
        project: f.project,
        root,
        env: {
          ...env,
          VARISDEV_ENVIRONMENT_FILE: binding,
          VARISDEV_CODING_AGENT_DIR: f.agent,
        },
        platform,
      })) as Report;
      assert.equal(
        check(report, 'environment.file').status,
        'unknown',
        platform,
      );
      assert.equal(
        check(report, 'environment.file').state,
        'unbound',
        platform,
      );
      assert.equal(
        report.checks.some(item => item.id === 'auth.presence'),
        false,
      );
      assert.equal(
        report.checks.some(item => item.id === 'environment.sources'),
        false,
      );
    }
    assert.deepEqual(await snapshot(f.home), before);
  }
});

void test('doctor retains the production launch-resolved profile after opening another workspace', async t => {
  const f = await fixture(t);
  const launch = join(f.home, 'launch');
  await f.put(f.environment, {VARISDEV_SETTINGS_DIR: './custom-agent'});
  await f.put(join(launch, 'custom-agent/settings.json'), '{invalid', true);
  const before = await snapshot(f.home);
  await runCommand(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import process from 'node:process';
      import {join} from 'node:path';
      import {createEnvironmentSettings} from ${JSON.stringify(pathToFileURL(join(root, 'src/runtime/environment.mjs')).href)};
      import {configureSettings} from ${JSON.stringify(pathToFileURL(join(root, 'src/runtime/settings.mjs')).href)};
      import {collectDoctorReport} from ${JSON.stringify(pathToFileURL(helper).href)};
      process.chdir(process.argv[1]);
      const env = {...process.env};
      const settings = createEnvironmentSettings({env, initialEnv: {...env}, file: process.argv[3], readEnvironment: async () => ({...env})});
      await settings.initialize();
      configureSettings(env);
      assert.equal(env.VARISDEV_CODING_AGENT_DIR, join(process.argv[1], 'custom-agent'));
      const report = await collectDoctorReport({project: process.argv[2], env});
      assert.equal(report.paths.settings, env.VARISDEV_CODING_AGENT_DIR);
      assert.equal(report.checks.find(item => item.id === 'settings.global').status, 'error');
      assert.equal(report.checks.find(item => item.id === 'settings.profile').source, 'VARISDEV_CODING_AGENT_DIR');
    `,
      launch,
      f.project,
      f.environment,
    ],
    {env: f.env, timeoutMs: 20000},
  );
  assert.deepEqual(await snapshot(f.home), before);
});

void test('relative launch paths remain unknown without a resolved runtime binding', async t => {
  const f = await fixture(t);
  await f.put(f.environment, {VARISDEV_SETTINGS_DIR: './custom-agent'});
  const report = await f.diagnose({
    VARISDEV_SETTINGS_DIR: join(f.home, 'machine-profile'),
  });
  assert.equal(check(report, 'locations.launch').status, 'unknown');
  assert.deepEqual(check(report, 'locations.launch').environmentNames, [
    'VARISDEV_SETTINGS_DIR',
  ]);
  assert.equal(
    report.checks.some(item => item.id === 'settings.global'),
    false,
  );
  assert.equal(
    report.checks.some(item => item.id === 'mcp.global'),
    false,
  );
  await f.put(f.environment, {VARISDEV_DATA_DIR: './custom-data'});
  const data = await f.diagnose();
  assert.equal(check(data, 'locations.launch').status, 'unknown');
  assert.deepEqual(check(data, 'locations.launch').environmentNames, [
    'VARISDEV_DATA_DIR',
  ]);
  assert.equal(
    data.checks.some(item => item.id === 'updates.activation'),
    false,
  );
});

void test(
  'doctor MCP missing references agree with Pi for inherited and saved mixed-case environment',
  {timeout: 40000},
  async t => {
    const scratch = join(root, '.varisdev/tool-output/doctor-modes');
    await mkdir(scratch, {recursive: true});
    const home = await mkdtemp(join(scratch, 'mcp-references-'));
    t.after(() => rm(home, {recursive: true, force: true}));
    const project = join(home, 'project');
    const agent = join(home, '.varisdev/agent');
    await mkdir(project);
    await mkdir(agent, {recursive: true});
    await writeFile(join(project, '.git'), 'gitdir: isolated-fixture');
    const env = {
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: join(home, 'local-app-data'),
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_DATA_HOME: join(home, 'data'),
      PATH: process.env.PATH || process.env.Path || '',
    };
    const environment = environmentPath(env);
    await mkdir(dirname(environment), {recursive: true});
    await runCommand(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          import assert from 'node:assert/strict';
          import {readFile, writeFile, stat} from 'node:fs/promises';
          import {join} from 'node:path';
          import process from 'node:process';
          const {collectDoctorReport} = await import(${JSON.stringify(pathToFileURL(helper).href)});
          const {createEnvironmentSettings} = await import(${JSON.stringify(pathToFileURL(join(root, 'src/runtime/environment.mjs')).href)});
          const {resolveConfigValue, getMissingConfigValueEnvVarNames} = await import(${JSON.stringify(pathToFileURL(join(root, 'desktop/node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js')).href)});
          const [project, agent, environment, root, home] = process.argv.slice(1);
          const initial = {...process.env};
          const marker = join(home, 'must-not-execute');
          const markerScript = 'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "executed")';
          const commandCredential = '!' + JSON.stringify(process.execPath) + ' -e ' + JSON.stringify(markerScript);
          const references = ['\${Api_Token}', '$Api_Token', '\${API_TOKEN}', '\${aPi_ToKeN}'];
          const allMissing = ['Api_Token', 'API_TOKEN', 'aPi_ToKeN'];
          await writeFile(join(agent, 'mcp.json'), JSON.stringify({
            mcpServers: {example: {
              command: process.execPath,
              args: ['-e', markerScript],
              env: {
                ...Object.fromEntries(references.map((value, index) => ['REFERENCE_' + index, value])),
                CREDENTIAL: commandCredential,
              },
            }},
          }));
          const scenarios = [
            {name: 'inherited uppercase key', inherited: {API_TOKEN: 'inherited-secret'}, saved: {}, windows: [], posix: ['Api_Token', 'aPi_ToKeN']},
            {name: 'inherited mixed-case key', inherited: {aPi_ToKeN: 'inherited-secret'}, saved: {}, windows: [], posix: ['Api_Token', 'API_TOKEN']},
            {name: 'saved mixed-case key', inherited: {}, saved: {aPi_ToKeN: 'saved-secret'}, windows: [], posix: ['Api_Token', 'API_TOKEN']},
            {name: 'saved replacement for inherited key', inherited: {API_TOKEN: 'inherited-secret'}, saved: {aPi_ToKeN: 'saved-secret'}, windows: [], posix: ['Api_Token']},
            {name: 'missing key', inherited: {}, saved: {}, windows: allMissing, posix: allMissing},
            {name: 'empty inherited key', inherited: {API_TOKEN: ''}, saved: {}, windows: allMissing, posix: allMissing},
            {name: 'saved empty mixed-case override', inherited: {API_TOKEN: 'inherited-secret'}, saved: {aPi_ToKeN: ''}, windows: allMissing, posix: ['Api_Token', 'aPi_ToKeN']},
            {name: 'saved differently-cased keys for one Windows variable', inherited: {}, saved: {API_TOKEN: 'saved-secret', aPi_ToKeN: ''}, windows: allMissing, posix: ['Api_Token', 'aPi_ToKeN']},
          ];
          for (const scenario of scenarios) {
            const inherited = {...initial, ...scenario.inherited};
            const savedText = JSON.stringify(scenario.saved);
            await writeFile(environment, savedText);
            const beforeLaunch = await collectDoctorReport({project, root, env: inherited});
            const settings = createEnvironmentSettings({
              env: process.env,
              initialEnv: inherited,
              file: environment,
              readEnvironment: async () => ({...inherited}),
            });
            const state = await settings.initialize();
            assert.equal(state.error, undefined, scenario.name);
            // Resolve only references; command credentials and server commands stay unevaluated.
            const resolverMissing = [...new Set(references.flatMap(value =>
              resolveConfigValue(value) === undefined ? getMissingConfigValueEnvVarNames(value) : [],
            ))];
            const afterLaunch = await collectDoctorReport({project, root, env: process.env});
            for (const report of [beforeLaunch, afterLaunch]) {
              assert.equal(report.checks.find(item => item.id === 'environment.file')?.status, 'ok', scenario.name);
              const entry = report.checks.find(item => item.id === 'mcp.entry' && item.scope === 'global');
              assert.ok(entry, scenario.name);
              assert.deepEqual(entry.missingEnvironmentNames, resolverMissing, scenario.name);
              assert.deepEqual(entry.missingEnvironmentNames, process.platform === 'win32' ? scenario.windows : scenario.posix, scenario.name);
              assert.equal(entry.status, resolverMissing.length ? 'warning' : 'info', scenario.name);
              assert.equal(entry.commandValues, 'not evaluated', scenario.name);
              const output = JSON.stringify(report);
              for (const secret of ['inherited-secret', 'saved-secret', commandCredential, marker])
                assert.equal(output.includes(secret), false, scenario.name);
            }
            assert.equal(await readFile(environment, 'utf8'), savedText, scenario.name);
            await assert.rejects(stat(marker), {code: 'ENOENT'});
          }
        `,
        project,
        agent,
        environment,
        root,
        home,
      ],
      {env, cwd: root, timeoutMs: 25000},
    );
  },
);
