import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, dirname, join, resolve} from 'node:path';
import {test, type TestContext} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import type {SessionFeatures} from '../src/dashboard/features.ts';

const execFile = promisify(execFileCallback);
const checkout = fileURLToPath(new URL('../', import.meta.url));
const packageRoot = resolve(
  process.env.VARISDEV_TEST_PACKAGE_DIR ??
    process.env.PI_TEST_PACKAGE_DIR ??
    checkout,
);
const cli = join(packageRoot, 'bin/varisdev.mjs');
const parentURL = pathToFileURL(
  join(packageRoot, 'desktop/build/src/dashboard/parent.js'),
).href;
const displayAvailable =
  process.platform !== 'linux' ||
  Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
const fixtureProvider = 'standalone-fixture-provider';
const fixtureModel = 'offline-model';

interface Fixture {
  directory: string;
  project: string;
  agentDir: string;
  env: NodeJS.ProcessEnv;
  source: string;
  commandReport: string;
  desktopReport: string;
  desktopPidFile: string;
  closeFile: string;
  originalSettings: Record<string, unknown>;
}

async function readJSON(path: string) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function setup(t: TestContext): Promise<Fixture> {
  // An installed package must already contain postinstall's compiled runtime.
  for (const path of [
    cli,
    'desktop/build/src/runtime/cli.js',
    'desktop/build/src/dashboard/parent.js',
    'desktop/build/src/desktop/main.js',
  ]) {
    await access(path === cli ? path : join(packageRoot, path));
  }
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'varisdev-standalone-')),
  );
  t.after(async () => {
    await writeFile(join(directory, 'close-desktop'), 'close');
    let pid: number | undefined;
    try {
      pid = Number(await readFile(join(directory, 'desktop.pid'), 'utf8'));
    } catch {
      /* No desktop started. */
    }
    if (pid) {
      for (let count = 0; count < 50; count++) {
        try {
          process.kill(pid, 0);
        } catch {
          pid = undefined;
          break;
        }
        await delay(100);
      }
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Already closed. */
        }
      }
    }
    try {
      await assert.rejects(
        access(join(directory, 'forbidden-command')),
        {code: 'ENOENT'},
        'Standalone invoked a global npm or Pi executable',
      );
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
    }
  });
  const project = join(directory, 'project');
  const agentDir = join(directory, 'agent');
  const plugin = join(directory, 'fixture-plugin');
  const blocked = join(directory, 'blocked-commands');
  const existingPlugin = join(directory, 'existing-plugin');
  const oldApp = join(directory, 'old-app');
  await Promise.all(
    [
      project,
      agentDir,
      plugin,
      blocked,
      existingPlugin,
      oldApp,
      join(directory, 'home'),
    ].map(path => mkdir(path)),
  );
  await writeFile(
    join(oldApp, 'package.json'),
    JSON.stringify({
      name: 'old-varisdev',
      type: 'module',
      repository: 'https://github.com/HardDoer/varisdev.git',
      pi: {extensions: ['./index.mjs']},
    }),
  );
  await writeFile(
    join(oldApp, 'index.mjs'),
    "export default function () { throw new Error('Obsolete VarisDev extension loaded'); }",
  );
  const forbiddenReport = join(directory, 'forbidden-command');
  for (const command of ['pi', 'npm']) {
    await writeFile(
      join(blocked, command),
      `#!/bin/sh\nprintf '%s' '${command}' > '${forbiddenReport}'\nexit 89\n`,
      {mode: 0o755},
    );
    await writeFile(
      join(blocked, `${command}.cmd`),
      `@echo ${command}>"${forbiddenReport}"\r\n@exit /b 89\r\n`,
    );
  }
  const systemDirectories =
    process.platform === 'win32'
      ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')]
      : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(directory, 'home'),
    USERPROFILE: join(directory, 'home'),
    XDG_CONFIG_HOME: join(directory, 'home', '.config'),
    VARISDEV_SETTINGS_DIR: agentDir,
    VARISDEV_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_DIR: join(directory, 'regular-pi'),
    PI_OFFLINE: '1',
    VARISDEV_DATA_DIR: join(directory, 'data'),
    PIDEV_DESKTOP_DATA_DIR: join(directory, 'desktop'),
    VARISDEV_NODE_EXECUTABLE: process.execPath,
    PATH: [blocked, dirname(process.execPath), ...systemDirectories].join(
      delimiter,
    ),
    npm_config_offline: 'true',
    npm_config_cache: join(directory, 'npm-cache'),
    JITI_FS_CACHE: 'false',
  };
  for (const key of [
    'NODE_PATH',
    'NODE_OPTIONS',
    'ELECTRON_RUN_AS_NODE',
    'PI_MANAGED_INSTALL_ROOT',
    'VARISDEV_INSTALL_ROOT',
  ])
    delete env[key];
  const commandReport = join(directory, 'command.json');
  const desktopReport = join(directory, 'desktop.json');
  const desktopPidFile = join(directory, 'desktop.pid');
  const closeFile = join(directory, 'close-desktop');
  await writeFile(
    join(plugin, 'package.json'),
    JSON.stringify({
      name: 'varisdev-standalone-fixture',
      version: '1.0.0',
      type: 'module',
      pi: {extensions: ['./extension.mjs'], skills: ['./skills']},
      varisdev: {themes: ['./theme.json']},
    }),
  );
  await writeFile(
    join(plugin, 'theme.json'),
    JSON.stringify({
      id: 'fixture',
      name: 'Fixture',
      base: 'nord',
      colors: {bg: '#131c29'},
    }),
  );
  const imagePath = join(project, 'preview.svg');
  await writeFile(
    imagePath,
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"><rect width="12" height="8" fill="red"/></svg>',
  );
  await mkdir(join(plugin, 'skills', 'standalone-fixture'), {recursive: true});
  await writeFile(
    join(plugin, 'skills', 'standalone-fixture', 'SKILL.md'),
    '---\nname: standalone-fixture\ndescription: Standalone installation fixture skill\n---\nSTANDALONE SKILL BODY marker.\n',
  );
  await writeFile(
    join(plugin, 'extension.mjs'),
    `
import {existsSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require = createRequire(${JSON.stringify(join(packageRoot, 'package.json'))});
export default function(api) {
  let timer;
  api.registerProvider(${JSON.stringify(fixtureProvider)}, {
    api: 'openai-completions',
    apiKey: 'standalone-fixture-key',
    baseUrl: 'https://standalone-fixture.invalid/v1',
    models: [{
      id: ${JSON.stringify(fixtureModel)},
      name: 'Offline fixture model',
      reasoning: false,
      input: ['text'],
      contextWindow: 32000,
      maxTokens: 1000,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
    }],
  });
  api.registerCommand('standalone-fixture', {
    description: 'Verify an installed standalone plugin',
    handler: async (args, ctx) => {
      writeFileSync(${JSON.stringify(commandReport)}, JSON.stringify({args, cwd: ctx.cwd, mode: ctx.mode, hasUI: ctx.hasUI}));
    },
  });
  api.registerTool({
    name: 'standalone_fixture', label: 'Standalone fixture', description: 'Installed fixture tool',
    parameters: {type: 'object', properties: {}, required: []},
    async execute() { return {content: [{type: 'text', text: 'Standalone fixture tool result'}], details: {}}; },
  });
  api.on('session_start', () => {
    if (!process.versions.electron) return;
    const {app, BrowserWindow} = require('electron');
    api.sendMessage({customType: 'standalone-image', content: 'Fixture preview', display: true, details: {varisdev: {version: 1, blocks: [{type: 'image', path: ${JSON.stringify(imagePath)}}]}}});
    writeFileSync(${JSON.stringify(desktopPidFile)}, String(process.pid));
    timer = setInterval(async () => {
      if (existsSync(${JSON.stringify(closeFile)})) { clearInterval(timer); app.quit(); return; }
      if (existsSync(${JSON.stringify(desktopReport)})) return;
      try {
        const window = BrowserWindow.getAllWindows()[0];
        if (!window || !window.isVisible() || window.webContents.isLoading()) return;
        const result = await window.webContents.executeJavaScript(
          "(async () => { const state = await window.pidev.getState(); if (state.sessions.length !== 1) return; const id = state.sessions[0].session.id; const features = await window.pidev.sessionFeatures(id); const themes = await window.pidev.appThemes(id); const reference = state.sessions[0].conversation.flatMap(message => message.visualizations || []).find(block => block.type === 'image'); if (!reference) throw new Error('Image metadata is missing'); const image = await window.pidev.conversationImage(reference.id, 'thumbnail'); return {state, features, themes, image, ready: document.readyState, title: document.title}; })()"
        );
        if (!result) return;
        writeFileSync(${JSON.stringify(desktopReport)}, JSON.stringify({pid: process.pid, visible: window.isVisible(), ...result}));
      } catch (error) {
        writeFileSync(${JSON.stringify(desktopReport)}, JSON.stringify({error: String(error)}));
      }
    }, 100);
  });
  api.on('session_shutdown', () => clearInterval(timer));
}
`,
  );
  await writeFile(
    join(existingPlugin, 'package.json'),
    JSON.stringify({
      name: 'existing-empty-plugin',
      version: '1.0.0',
      pi: {extensions: []},
    }),
  );
  const originalSettings = {
    quietStartup: true,
    packages: [{source: existingPlugin, extensions: []}, oldApp],
    defaultProvider: fixtureProvider,
    defaultModel: fixtureModel,
    retry: {enabled: false},
  };
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify(originalSettings),
  );
  // Pack with the shipped npm CLI: global npm and Pi deliberately fail in PATH.
  const packed = await execFile(
    process.execPath,
    [
      join(packageRoot, 'node_modules/npm/bin/npm-cli.js'),
      'pack',
      '--ignore-scripts',
      '--offline',
      '--json',
      '--pack-destination',
      directory,
    ],
    {cwd: plugin, env, timeout: 30000},
  );
  const [{filename}] = JSON.parse(packed.stdout) as Array<{filename: string}>;
  const source = `npm:varisdev-standalone-fixture@file:${join(directory, filename)}`;
  return {
    directory,
    project,
    agentDir,
    env,
    source,
    commandReport,
    desktopReport,
    desktopPidFile,
    closeFile,
    originalSettings,
  };
}

async function runCLI(fixture: Fixture, args: string[], timeout = 30000) {
  const command = execFile(process.execPath, [cli, ...args], {
    cwd: fixture.project,
    env: fixture.env,
    timeout,
    maxBuffer: 1024 * 1024,
  });
  command.child.stdin?.end();
  return command;
}

async function parentFeatures(
  fixture: Fixture,
  invokeCommand = false,
): Promise<SessionFeatures> {
  const script = `
    globalThis.fetch = async url => { throw new Error('Unexpected network request: ' + url); };
    const {createDashboardParent} = await import(${JSON.stringify(parentURL)});
    const parent = await createDashboardParent({cwd: ${JSON.stringify(fixture.project)}});
    try {
      ${invokeCommand ? "await parent.prompt('/standalone-fixture installed-plugin');" : ''}
      console.log('STANDALONE_FEATURES=' + JSON.stringify(await parent.features()));
    } finally { await parent.close(); }
  `;
  const result = await execFile(
    process.execPath,
    ['--input-type=module', '-e', script],
    {
      cwd: fixture.project,
      env: fixture.env,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    },
  );
  const line = result.stdout
    .split('\n')
    .find(line => line.startsWith('STANDALONE_FEATURES='));
  assert.ok(
    line,
    `No parent features reported:\n${result.stdout}\n${result.stderr}`,
  );
  return JSON.parse(line.slice('STANDALONE_FEATURES='.length));
}

async function assertFeatures(features: SessionFeatures) {
  assert.deepEqual(features.diagnostics, []);
  assert.deepEqual(features.model, {
    provider: fixtureProvider,
    id: fixtureModel,
  });
  assert.ok(
    features.models.some(
      model => model.provider === fixtureProvider && model.id === fixtureModel,
    ),
    'Installed fixture model is missing',
  );
  assert.ok(
    features.commands.some(
      command =>
        command.name === 'standalone-fixture' && command.source === 'extension',
    ),
  );
  assert.ok(
    features.commands.some(
      command =>
        command.name === 'skill:standalone-fixture' &&
        command.source === 'skill',
    ),
  );
  assert.ok(!features.commands.some(command => command.name === 'commit'));
  for (const name of [
    'browse',
    'agent_spawn',
    'agent_list',
    'read',
    'standalone_fixture',
  ]) {
    assert.ok(
      features.tools.some(tool => tool.name === name),
      `Missing standalone tool ${name}`,
    );
  }
  const skill = features.contextFiles?.find(
    file => file.kind === 'skill' && file.name === 'standalone-fixture',
  );
  assert.ok(skill, 'Installed skill metadata is missing from context files');
  assert.equal(skill.status, 'available');
  assert.match(skill.description, /Standalone installation fixture skill/);
  assert.match(
    await readFile(skill.path, 'utf8'),
    /STANDALONE SKILL BODY marker\./,
  );
}

void test(
  'standalone production CLI uses bundled npm and loads installed plugins without registering itself',
  {timeout: 90000},
  async t => {
    const fixture = await setup(t);
    const manifest = await readJSON(join(packageRoot, 'package.json'));
    const version = await runCLI(fixture, ['--version']);
    assert.equal(version.stdout.trim(), `VarisDev ${manifest.version}`);
    const help = await runCLI(fixture, ['--help']);
    for (const command of [
      'varisdev',
      'login',
      'logout',
      'install',
      'remove',
      'plugins update',
    ])
      assert.ok(help.stdout.includes(command));
    assert.doesNotMatch(help.stdout + version.stdout, /\bpi\b/i);
    const installed = await runCLI(fixture, ['install', fixture.source]);
    assert.match(installed.stdout, /Installed npm:varisdev-standalone-fixture/);
    const settings = await readJSON(join(fixture.agentDir, 'settings.json'));
    assert.deepEqual(settings, {
      ...fixture.originalSettings,
      packages: [
        ...(fixture.originalSettings.packages as unknown[]),
        fixture.source,
      ],
    });
    assert.doesNotMatch(
      JSON.stringify(settings.packages),
      new RegExp(packageRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    const listed = await runCLI(fixture, ['list']);
    assert.ok(listed.stdout.includes(fixture.source));
    await assertFeatures(await parentFeatures(fixture, true));
    assert.deepEqual(await readJSON(fixture.commandReport), {
      args: 'installed-plugin',
      cwd: fixture.project,
      mode: 'rpc',
      hasUI: true,
    });
    const offline = join(fixture.directory, 'offline.mjs');
    await writeFile(
      offline,
      "globalThis.fetch = async () => { throw new Error('Unexpected network request'); };\n",
    );
    await runCLI(
      {
        ...fixture,
        env: {
          ...fixture.env,
          NODE_OPTIONS: `--import=${pathToFileURL(offline).href}`,
        },
      },
      ['run', '/standalone-fixture headless-plugin'],
    );
    const headless = await readJSON(fixture.commandReport);
    assert.equal(headless.args, 'headless-plugin');
    assert.equal(headless.cwd, fixture.project);
    assert.equal(headless.hasUI, false);
    assert.deepEqual(
      await readJSON(join(fixture.agentDir, 'settings.json')),
      settings,
    );
    const removed = await runCLI(fixture, ['remove', fixture.source]);
    assert.match(removed.stdout, /Removed npm:varisdev-standalone-fixture/);
    assert.deepEqual(
      await readJSON(join(fixture.agentDir, 'settings.json')),
      fixture.originalSettings,
    );
    assert.ok(
      !(await runCLI(fixture, ['list'])).stdout.includes(fixture.source),
    );
    const features = await parentFeatures(fixture);
    assert.ok(
      !features.commands.some(command => command.name === 'standalone-fixture'),
    );
    assert.ok(!features.tools.some(tool => tool.name === 'standalone_fixture'));
  },
);

void test(
  'standalone CLI opens its own desktop and exits while the ready app remains running',
  {
    timeout: 120000,
    skip: displayAvailable ? false : 'Electron requires a display',
  },
  async t => {
    const fixture = await setup(t);
    await runCLI(fixture, ['install', fixture.source]);
    const result = await runCLI(fixture, [fixture.project], 90000);
    assert.doesNotMatch(result.stdout + result.stderr, /Error|Could not open/);
    let report:
      | {
          error?: string;
          pid: number;
          visible: boolean;
          ready: string;
          title: string;
          features: SessionFeatures;
          image: {src: string; width: number; height: number};
          themes: {
            themes: Array<{id: string; colors: {bg: string}}>;
            errors: string[];
          };
          state: {
            sessions: Array<{
              session: {cwd: string; owned: boolean; controllable: boolean};
            }>;
          };
        }
      | undefined;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        report = await readJSON(fixture.desktopReport);
        break;
      } catch {
        await delay(100);
      }
    }
    const log = await readFile(
      join(fixture.directory, 'desktop', 'startup.log'),
      'utf8',
    );
    assert.ok(
      report,
      `No desktop UI report. CLI output:\n${result.stdout}\n${result.stderr}\nDesktop log:\n${log}`,
    );
    assert.ifError(report.error);
    process.kill(report.pid, 0);
    assert.equal(report.visible, true);
    assert.equal(report.ready, 'complete');
    assert.equal(report.title, 'VarisDev');
    assert.equal(report.state.sessions.length, 1);
    assert.equal(report.state.sessions[0].session.cwd, fixture.project);
    assert.equal(report.state.sessions[0].session.owned, true);
    assert.equal(report.state.sessions[0].session.controllable, true);
    await assertFeatures(report.features);
    assert.match(report.image.src, /^data:image\/png;base64,/);
    assert.equal(report.image.width, 12);
    assert.equal(report.image.height, 8);
    assert.deepEqual(report.themes.errors, []);
    assert.ok(
      report.themes.themes.some(
        theme =>
          theme.id === 'plugin:varisdev-standalone-fixture:fixture' &&
          theme.colors.bg === '#131c29',
      ),
    );
    await writeFile(fixture.closeFile, 'close');
    let exited = false;
    for (let count = 0; count < 100; count++) {
      try {
        process.kill(report.pid, 0);
      } catch {
        exited = true;
        break;
      }
      await delay(100);
    }
    assert.ok(exited, 'The fixture did not close its desktop process');
  },
);
