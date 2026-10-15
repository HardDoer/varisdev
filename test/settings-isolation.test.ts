import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {test, type TestContext} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

const execFile = promisify(execFileCallback);
const checkout = fileURLToPath(new URL('../', import.meta.url));
const packageRoot = resolve(process.env.VARISDEV_TEST_PACKAGE_DIR ?? checkout);
const sdkRelative = 'node_modules/@earendil-works/pi-coding-agent';
const privateSDK = join(packageRoot, 'desktop', sdkRelative);
const stockSDK = join(checkout, sdkRelative);
const asURL = (path: string) => JSON.stringify(pathToFileURL(path).href);

async function json(path: string) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function put(path: string, value: string | object) {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(
    path,
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}

// Include directory entries so creating an empty cache or session directory is detected.
async function snapshot(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(path: string, prefix: string) {
    for (const entry of (await readdir(path, {withFileTypes: true})).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) {
        result[relative + '/'] = '';
        await visit(join(path, entry.name), relative + '/');
      } else {
        result[relative] = (await readFile(join(path, entry.name))).toString(
          'base64',
        );
      }
    }
  }
  await visit(directory, '');
  return result;
}

function modelConfig(provider: string) {
  return {
    providers: {
      [provider]: {
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:1/v1',
        models: [
          {
            id: 'fixture-model',
            name: 'Isolation fixture',
            contextWindow: 4096,
            maxTokens: 128,
          },
        ],
      },
    },
  };
}

async function fixture(t: TestContext, custom: boolean) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'varisdev-settings-isolation-')),
  );
  t.after(() =>
    rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}),
  );
  const home = join(root, 'home');
  const project = join(root, 'project');
  const settings = custom
    ? join(root, 'custom-settings')
    : join(home, '.varisdev', 'agent');
  const normalPi = join(home, '.pi');
  const projectPi = join(project, '.pi');
  const inherited = join(root, 'inherited-agent');
  const sessions = join(root, 'inherited-sessions');
  const packageDir = join(root, 'inherited-package');
  const source = join(root, 'local-plugin');
  const report = join(root, 'plugin-report.json');
  const forbidden = join(root, 'pi-plugin-loaded');
  const decoyPlugin = join(root, 'pi-plugin');
  const guard = join(root, 'offline.mjs');
  await put(
    guard,
    `
    import http from 'node:http';
    import https from 'node:https';
    import {syncBuiltinESMExports} from 'node:module';
    const deny = () => { throw new Error('Unexpected network request in isolation test'); };
    globalThis.fetch = deny;
    http.request = http.get = https.request = https.get = deny;
    syncBuiltinESMExports();
  `,
  );
  await put(join(decoyPlugin, 'package.json'), {
    name: 'regular-pi-fixture',
    type: 'module',
    pi: {extensions: ['./extension.mjs']},
  });
  await put(
    join(decoyPlugin, 'extension.mjs'),
    `
    import {writeFileSync} from 'node:fs';
    writeFileSync(${JSON.stringify(forbidden)}, 'Regular Pi plugin was imported');
    export default function () { throw new Error('Regular Pi plugin was loaded'); }
  `,
  );
  await put(join(source, 'package.json'), {
    name: 'varisdev-isolation-fixture',
    version: '1.0.0',
    type: 'module',
    pi: {extensions: ['./extension.mjs']},
  });
  await put(
    join(source, 'extension.mjs'),
    `
    import {writeFileSync} from 'node:fs';
    export default function(api) {
      api.registerCommand('isolation-fixture', {
        description: 'Report local plugin loading without a model request',
        handler: async (args, ctx) => {
          writeFileSync(${JSON.stringify(report)}, JSON.stringify({args, cwd: ctx.cwd, hasUI: ctx.hasUI}));
        },
      });
    }
  `,
  );
  for (const directory of [join(normalPi, 'agent'), projectPi, inherited]) {
    await put(join(directory, 'settings.json'), {
      defaultProvider: 'regular-pi-provider',
      defaultModel: 'fixture-model',
      defaultThinkingLevel: 'minimal',
      theme: 'light',
      packages: [decoyPlugin],
    });
    await put(join(directory, 'auth.json'), {
      'regular-pi-provider': {type: 'api_key', key: 'regular-pi-secret'},
    });
    await put(
      join(directory, 'models.json'),
      modelConfig('regular-pi-provider'),
    );
    await put(
      join(directory, 'sessions', 'keep.jsonl'),
      'Regular Pi session bytes\n',
    );
    await put(
      join(directory, 'extensions', 'decoy.mjs'),
      await readFile(join(decoyPlugin, 'extension.mjs'), 'utf8'),
    );
  }
  await put(join(sessions, 'keep.jsonl'), 'Inherited Pi session bytes\n');
  await put(join(packageDir, 'package.json'), {
    name: 'foreign-pi-package',
    version: '9.0.0',
    piConfig: {name: 'foreign', configDir: '.foreign'},
  });
  await put(join(settings, 'settings.json'), {
    defaultProvider: 'isolation-provider',
    defaultModel: 'fixture-model',
    defaultThinkingLevel: 'low',
    defaultProjectTrust: 'always',
    theme: 'dark',
  });
  await put(join(settings, 'auth.json'), {
    'isolation-provider': {type: 'api_key', key: 'varisdev-secret'},
    openai: {type: 'api_key', key: 'varisdev-openai-secret'},
  });
  await put(join(settings, 'models.json'), modelConfig('isolation-provider'));
  await put(join(project, '.varisdev', 'settings.json'), {
    defaultThinkingLevel: 'high',
  });
  const legacySession = join(normalPi, 'agent', 'sessions', 'legacy.jsonl');
  const timestamp = '2026-01-01T00:00:00.000Z';
  const legacyHeader = {
    type: 'session',
    version: 3,
    id: 'b953ad25-c5ac-4bdd-9bc7-92b8fc7d78d8',
    timestamp,
    cwd: project,
  };
  const legacyNote = {
    type: 'custom',
    id: 'legacy-note',
    parentId: null,
    timestamp,
    customType: 'legacy-pi-note',
    data: {text: 'Original Pi session'},
  };
  await put(
    legacySession,
    [legacyHeader, legacyNote].map(entry => JSON.stringify(entry)).join('\n') +
      '\n',
  );
  const legacyStartup = {
    cwd: project,
    agentDir: join(normalPi, 'agent'),
    sessionFile: legacySession,
    sessionDir: dirname(legacySession),
    entries: [
      legacyHeader,
      legacyNote,
      {
        type: 'custom',
        id: 'buffered-note',
        parentId: 'legacy-note',
        timestamp,
        customType: 'buffered-pi-note',
        data: {text: 'Unsaved handoff buffer'},
      },
    ],
    leafId: 'buffered-note',
    model: {provider: 'regular-pi-provider', id: 'fixture-model'},
    thinkingLevel: 'high',
    tools: ['read'],
    argv: [
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
    ],
  };
  const protectedDirectories = [
    normalPi,
    projectPi,
    inherited,
    sessions,
    packageDir,
    decoyPlugin,
  ];
  if (custom) {
    const defaultDirectory = join(home, '.varisdev');
    await put(join(defaultDirectory, 'settings.json'), {
      theme: 'untouched-default',
    });
    protectedDirectories.push(defaultDirectory);
  }
  const before = await Promise.all(protectedDirectories.map(snapshot));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    PI_CODING_AGENT_DIR: inherited,
    PI_CODING_AGENT_SESSION_DIR: sessions,
    VARISDEV_CODING_AGENT_DIR: inherited,
    VARISDEV_CODING_AGENT_SESSION_DIR: sessions,
    PI_PACKAGE_DIR: packageDir,
    PI_OFFLINE: '1',
    VARISDEV_DATA_DIR: join(root, 'data'),
    VARISDEV_NODE_EXECUTABLE: process.execPath,
    npm_config_offline: 'true',
    npm_config_cache: join(root, 'npm-cache'),
    JITI_FS_CACHE: 'false',
    NODE_OPTIONS: `--import=${pathToFileURL(guard).href}`,
  };
  for (const key of [
    'VARISDEV_SETTINGS_DIR',
    'VARISDEV_INSTALL_ROOT',
    'PI_MANAGED_INSTALL_ROOT',
    'NODE_PATH',
    'ELECTRON_RUN_AS_NODE',
  ])
    delete env[key];
  if (custom) env.VARISDEV_SETTINGS_DIR = settings;
  async function run(args: string[], environment = env) {
    const child = execFile(process.execPath, args, {
      cwd: project,
      env: environment,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    child.child.stdin?.end();
    return child;
  }
  async function evaluate(script: string, environment = env) {
    const result = await run(
      ['--input-type=module', '-e', script],
      environment,
    );
    const line = result.stdout
      .split('\n')
      .find(line => line.startsWith('ISOLATION='));
    assert.ok(
      line,
      `Missing subprocess report:\n${result.stdout}\n${result.stderr}`,
    );
    return JSON.parse(line.slice('ISOLATION='.length));
  }
  return {
    root,
    home,
    project,
    settings,
    normalPi,
    inherited,
    sessions,
    legacyStartup,
    source,
    report,
    forbidden,
    env,
    run,
    evaluate,
    async assertProtected() {
      assert.deepEqual(
        await Promise.all(protectedDirectories.map(snapshot)),
        before,
        'VarisDev changed regular Pi data or an inherited Pi path',
      );
      await assert.rejects(
        readFile(forbidden),
        {code: 'ENOENT'},
        'VarisDev imported a regular Pi plugin',
      );
    },
  };
}

void test(
  'bundled Pi uses the upstream global and project resource layout in its own namespace',
  {timeout: 60000},
  async t => {
    const f = await fixture(t, false);
    const projectSettings = join(f.project, '.varisdev');
    const theme = await json(
      join(privateSDK, 'dist/modes/interactive/theme/dark.json'),
    );
    for (const [scope, directory] of [
      ['global', f.settings],
      ['project', projectSettings],
    ]) {
      await put(join(directory, 'SYSTEM.md'), `${scope} system prompt`);
      await put(
        join(directory, 'APPEND_SYSTEM.md'),
        `${scope} appended prompt`,
      );
      await put(
        join(directory, 'extensions', `${scope}.ts`),
        'export default function () {}',
      );
      await put(
        join(directory, 'prompts', `${scope}.md`),
        `${scope} prompt template`,
      );
      await put(
        join(directory, 'skills', `${scope}-skill`, 'SKILL.md'),
        `---\nname: ${scope}-skill\ndescription: Layout fixture\n---\n${scope} skill instructions`,
      );
      await put(join(directory, 'themes', `${scope}.json`), {
        ...theme,
        name: scope,
      });
      await mkdir(join(directory, 'npm/node_modules/layout-fixture'), {
        recursive: true,
      });
      await mkdir(join(directory, 'git/github.com/example/layout-fixture'), {
        recursive: true,
      });
    }
    await put(join(f.settings, 'AGENTS.md'), 'VarisDev global instructions');
    await put(join(f.project, 'AGENTS.md'), 'Shared project instructions');
    const report = await f.evaluate(`
    await import(${asURL(join(packageRoot, 'desktop/build/src/runtime/settings-entry.mjs'))});
    const sdk = await import(${asURL(join(privateSDK, 'dist/index.js'))});
    const config = await import(${asURL(join(privateSDK, 'dist/config.js'))});
    const stock = await import(${asURL(join(stockSDK, 'dist/config.js'))});
    const {rm} = await import('node:fs/promises');
    const {join} = await import('node:path');
    const names = ['getAgentDir', 'getCustomThemesDir', 'getModelsPath', 'getAuthPath',
      'getSettingsPath', 'getToolsDir', 'getBinDir', 'getPromptsDir', 'getSessionsDir'];
    delete process.env.PI_CODING_AGENT_DIR;
    const piPaths = Object.fromEntries(names.map(name => [name, stock[name]()]));
    const appPaths = Object.fromEntries(names.map(name => [name, config[name]()]));
    const settings = sdk.SettingsManager.create(process.cwd());
    const options = {cwd: process.cwd(), agentDir: sdk.getAgentDir(), settingsManager: settings};
    const loader = new sdk.DefaultResourceLoader(options);
    await loader.reload();
    const packages = new sdk.DefaultPackageManager(options);
    const project = join(process.cwd(), config.CONFIG_DIR_NAME);
    const projectPrompt = loader.getSystemPrompt();
    const projectAppend = loader.getAppendSystemPrompt();
    const projectSource = loader.getSystemPromptSource();
    const projectAppendSources = loader.getAppendSystemPromptSources();
    await rm(join(project, 'SYSTEM.md'));
    await rm(join(project, 'APPEND_SYSTEM.md'));
    await loader.reload();
    console.log('ISOLATION=' + JSON.stringify({
      piPaths, appPaths, projectPrompt, projectAppend, projectSource, projectAppendSources,
      globalPrompt: loader.getSystemPrompt(), globalAppend: loader.getAppendSystemPrompt(),
      globalSource: loader.getSystemPromptSource(), globalAppendSources: loader.getAppendSystemPromptSources(),
      instructions: loader.getAgentsFiles().agentsFiles,
      extensions: loader.getExtensions().extensions.map(item => item.resolvedPath).sort(),
      extensionErrors: loader.getExtensions().errors,
      skills: loader.getSkills().skills.map(item => item.filePath).sort(),
      prompts: loader.getPrompts().prompts.map(item => item.filePath).sort(),
      themes: loader.getThemes().themes.map(item => item.name).sort(),
      packages: ['user', 'project'].map(scope => ({
        npm: packages.getInstalledPath('npm:layout-fixture', scope),
        git: packages.getInstalledPath('git:github.com/example/layout-fixture', scope),
      })),
    }));
  `);
    for (const [key, path] of Object.entries(report.piPaths)) {
      assert.equal(
        report.appPaths[key],
        String(path).replace(join(f.home, '.pi'), join(f.home, '.varisdev')),
      );
    }
    assert.equal(report.projectPrompt, 'project system prompt');
    assert.deepEqual(report.projectAppend, ['project appended prompt']);
    assert.deepEqual(report.projectSource, {
      path: join(projectSettings, 'SYSTEM.md'),
    });
    assert.deepEqual(report.projectAppendSources, [
      {path: join(projectSettings, 'APPEND_SYSTEM.md')},
    ]);
    assert.equal(report.globalPrompt, 'global system prompt');
    assert.deepEqual(report.globalAppend, ['global appended prompt']);
    assert.deepEqual(report.globalSource, {
      path: join(f.settings, 'SYSTEM.md'),
    });
    assert.deepEqual(report.globalAppendSources, [
      {path: join(f.settings, 'APPEND_SYSTEM.md')},
    ]);
    assert.deepEqual(report.instructions, [
      {
        path: join(f.settings, 'AGENTS.md'),
        content: 'VarisDev global instructions',
      },
      {
        path: join(f.project, 'AGENTS.md'),
        content: 'Shared project instructions',
      },
    ]);
    assert.deepEqual(report.extensionErrors, []);
    assert.deepEqual(
      report.extensions,
      [
        join(f.settings, 'extensions/global.ts'),
        join(projectSettings, 'extensions/project.ts'),
      ].sort(),
    );
    assert.deepEqual(
      report.skills,
      [
        join(f.settings, 'skills/global-skill/SKILL.md'),
        join(projectSettings, 'skills/project-skill/SKILL.md'),
      ].sort(),
    );
    assert.deepEqual(
      report.prompts,
      [
        join(f.settings, 'prompts/global.md'),
        join(projectSettings, 'prompts/project.md'),
      ].sort(),
    );
    assert.deepEqual(report.themes, ['global', 'project']);
    assert.deepEqual(
      report.packages,
      [f.settings, projectSettings].map(directory => ({
        npm: join(directory, 'npm/node_modules/layout-fixture'),
        git: join(directory, 'git/github.com/example/layout-fixture'),
      })),
    );
    await f.assertProtected();
  },
);

for (const custom of [false, true]) {
  void test(
    `settings isolation with ${custom ? 'a custom settings directory' : 'the default home directory'}`,
    {timeout: 120000},
    async t => {
      const f = await fixture(t, custom);
      const stockManifest = await readFile(
        join(stockSDK, 'package.json'),
        'utf8',
      );
      const cli = (args: string[]) =>
        f.run([join(packageRoot, 'bin/varisdev.mjs'), ...args]);

      await cli(['logout', 'openai']);
      assert.deepEqual(await json(join(f.settings, 'auth.json')), {
        'isolation-provider': {type: 'api_key', key: 'varisdev-secret'},
      });
      await f.assertProtected();

      await cli(['install', f.source, '--local']);
      assert.deepEqual(
        await json(join(f.project, '.varisdev', 'settings.json')),
        {
          defaultThinkingLevel: 'high',
          packages: [relative(join(f.project, '.varisdev'), f.source)],
        },
      );
      const privateReport = await f.evaluate(`
      await import(${asURL(join(packageRoot, 'desktop/build/src/runtime/settings-entry.mjs'))});
      const sdk = await import(${asURL(join(privateSDK, 'dist/index.js'))});
      const config = await import(${asURL(join(privateSDK, 'dist/config.js'))});
      const settings = sdk.SettingsManager.create(process.cwd());
      const runtime = await sdk.ModelRuntime.create({allowModelNetwork: false});
      const {AuthStorage} = await import(${asURL(join(privateSDK, 'dist/core/auth-storage.js'))});
      const auth = AuthStorage.create();
      const loader = new sdk.DefaultResourceLoader({cwd: process.cwd(), agentDir: sdk.getAgentDir(), settingsManager: settings});
      await loader.reload();
      const session = sdk.SessionManager.create(process.cwd());
      session.appendMessage({role: 'user', content: 'Isolated session fixture', timestamp: Date.now()});
      session.appendMessage({role: 'assistant', content: [{type: 'text', text: 'Saved without calling a model'}],
        api: 'openai-completions', provider: 'isolation-provider', model: 'fixture-model',
        usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
        stopReason: 'stop', timestamp: Date.now()});
      const listed = await sdk.SessionManager.list(process.cwd());
      const {execFileSync} = await import('node:child_process');
      const piChild = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(`
        const sdk = await import(${asURL(join(stockSDK, 'dist/index.js'))});
        const config = await import(${asURL(join(stockSDK, 'dist/config.js'))});
        const {AuthStorage} = await import(${asURL(join(stockSDK, 'dist/core/auth-storage.js'))});
        const settings = sdk.SettingsManager.create(process.cwd());
        console.log(JSON.stringify({
          agentDir: sdk.getAgentDir(), appName: config.APP_NAME, configDir: config.CONFIG_DIR_NAME,
          sessionOverride: process.env.PI_CODING_AGENT_SESSION_DIR,
          provider: settings.getDefaultProvider(), thinking: settings.getDefaultThinkingLevel(),
          credential: await AuthStorage.create().read('regular-pi-provider'),
        }));
      `)}], {encoding: 'utf8', env: process.env}));
      const report = {
        agentDir: sdk.getAgentDir(), appName: config.APP_NAME, configDir: config.CONFIG_DIR_NAME,
        inheritedSession: process.env.PI_CODING_AGENT_SESSION_DIR ?? null,
        privateSession: process.env.VARISDEV_CODING_AGENT_SESSION_DIR ?? null,
        inheritedPackage: process.env.PI_PACKAGE_DIR ?? null, piChild,
        provider: settings.getDefaultProvider(), thinking: settings.getDefaultThinkingLevel(),
        credential: await auth.read('isolation-provider'), foreignCredential: await auth.read('regular-pi-provider') ?? null,
        ownModel: !!runtime.getModel('isolation-provider', 'fixture-model'),
        foreignModel: !!runtime.getModel('regular-pi-provider', 'fixture-model'),
        errors: loader.getExtensions().errors,
        extensionPaths: loader.getExtensions().extensions.map(extension => extension.resolvedPath),
        sessionFile: session.getSessionFile(), sessionIds: listed.map(session => session.id), sessionId: session.getSessionId(),
      };
      settings.setTheme('light');
      await settings.flush();
      console.log('ISOLATION=' + JSON.stringify(report));
    `);
      assert.equal(privateReport.agentDir, f.settings);
      assert.equal(privateReport.appName, 'varisdev');
      assert.equal(privateReport.configDir, '.varisdev');
      assert.equal(privateReport.inheritedSession, f.sessions);
      assert.equal(privateReport.privateSession, null);
      assert.deepEqual(privateReport.piChild, {
        agentDir: f.inherited,
        appName: 'pi',
        configDir: '.pi',
        sessionOverride: f.sessions,
        provider: 'regular-pi-provider',
        thinking: 'minimal',
        credential: {type: 'api_key', key: 'regular-pi-secret'},
      });
      assert.equal(privateReport.inheritedPackage, null);
      assert.equal(privateReport.provider, 'isolation-provider');
      assert.equal(privateReport.thinking, 'high');
      assert.deepEqual(privateReport.credential, {
        type: 'api_key',
        key: 'varisdev-secret',
      });
      assert.equal(privateReport.foreignCredential, null);
      assert.equal(privateReport.ownModel, true);
      assert.equal(privateReport.foreignModel, false);
      assert.deepEqual(privateReport.errors, []);
      assert.deepEqual(privateReport.extensionPaths, [
        join(f.source, 'extension.mjs'),
      ]);
      assert.ok(
        privateReport.sessionFile.startsWith(
          join(f.settings, 'sessions') +
            (process.platform === 'win32' ? '\\' : '/'),
        ),
      );
      assert.match(
        await readFile(privateReport.sessionFile, 'utf8'),
        /Saved without calling a model/,
      );
      assert.ok(privateReport.sessionIds.includes(privateReport.sessionId));
      assert.equal(
        (await json(join(f.settings, 'settings.json'))).theme,
        'light',
      );
      await f.assertProtected();

      await cli(['run', '/isolation-fixture local-plugin']);
      assert.deepEqual(await json(f.report), {
        args: 'local-plugin',
        cwd: f.project,
        hasUI: false,
      });
      const resumed = await f.evaluate(`
        await import(${asURL(join(packageRoot, 'desktop/build/src/runtime/settings-entry.mjs'))});
        const {createDashboardParent} = await import(${asURL(join(packageRoot, 'desktop/build/src/dashboard/parent.js'))});
        const {restoreDesktopSession} = await import(${asURL(join(packageRoot, 'desktop/build/src/dashboard/startup.js'))});
        const startup = ${JSON.stringify(f.legacyStartup)};
        const sdk = await import(${asURL(join(privateSDK, 'dist/index.js'))});
        const {readFile} = await import('node:fs/promises');
        const ownDir = sdk.SessionManager.create(process.cwd()).getSessionDir();
        const ownAgent = sdk.getAgentDir();
        // Either external path must be replaced even when the agent directory claims to match.
        const externalFile = await restoreDesktopSession({...startup, agentDir: ownAgent, sessionDir: ownDir}, ownAgent);
        externalFile.appendCustomEntry('external-file-save', {text: 'Private copy'});
        const fileSaved = (await readFile(externalFile.getSessionFile(), 'utf8')).includes('external-file-save');
        const externalDir = await restoreDesktopSession({...startup, agentDir: ownAgent,
          sessionFile: externalFile.getSessionFile()}, ownAgent);
        externalDir.appendCustomEntry('external-dir-save', {text: 'Private copy'});
        const dirSaved = (await readFile(externalDir.getSessionFile(), 'utf8')).includes('external-dir-save');
        const externalPaths = [externalFile, externalDir].map(manager => ({file: manager.getSessionFile(), dir: manager.getSessionDir()}));
        const parent = await createDashboardParent({cwd: process.cwd()}, undefined, startup);
        let snapshot;
        let diagnostics;
        try {
          snapshot = parent.restartSnapshot();
          diagnostics = (await parent.features()).diagnostics;
        } finally { await parent.close(); }
        // A subsequent restart in the current directory must keep the copied file.
        const restored = await restoreDesktopSession(snapshot, snapshot.agentDir);
        restored.appendCustomEntry('saved-after-handoff', {text: 'Saved in VarisDev'});
        console.log('ISOLATION=' + JSON.stringify({
          agentDir: snapshot.agentDir, sessionFile: snapshot.sessionFile,
          restoredFile: restored.getSessionFile(), diagnostics, externalPaths, fileSaved, dirSaved,
          entries: restored.getEntries().filter(entry => entry.type === 'custom').map(entry => entry.customType),
          model: snapshot.model,
        }));
      `);
      assert.equal(resumed.agentDir, f.settings);
      assert.equal(resumed.restoredFile, resumed.sessionFile);
      assert.ok(resumed.sessionFile.startsWith(join(f.settings, 'sessions')));
      assert.equal(resumed.model, undefined);
      assert.equal(resumed.fileSaved, true);
      assert.equal(resumed.dirSaved, true);
      for (const paths of resumed.externalPaths) {
        assert.equal(paths.file, resumed.sessionFile);
        assert.ok(paths.dir.startsWith(join(f.settings, 'sessions')));
      }
      assert.ok(
        resumed.diagnostics.some(
          (entry: {message: string}) =>
            entry.message.includes('regular-pi-provider/fixture-model') &&
            entry.message.includes('not configured'),
        ),
      );
      for (const kind of [
        'legacy-pi-note',
        'buffered-pi-note',
        'saved-after-handoff',
      ])
        assert.ok(
          resumed.entries.includes(kind),
          `Missing transferred session entry: ${kind}`,
        );
      assert.match(
        await readFile(resumed.sessionFile, 'utf8'),
        /Saved in VarisDev/,
      );
      await f.assertProtected();

      await cli(['remove', f.source, '--local']);
      assert.deepEqual(
        await json(join(f.project, '.varisdev', 'settings.json')),
        {
          defaultThinkingLevel: 'high',
          packages: [],
        },
      );
      await f.assertProtected();

      const stockEnv = {...f.env};
      for (const key of [
        'PI_CODING_AGENT_DIR',
        'PI_CODING_AGENT_SESSION_DIR',
        'PI_PACKAGE_DIR',
      ])
        delete stockEnv[key];
      const stockReport = await f.evaluate(
        `
      const sdk = await import(${asURL(join(stockSDK, 'dist/index.js'))});
      const config = await import(${asURL(join(stockSDK, 'dist/config.js'))});
      const {AuthStorage} = await import(${asURL(join(stockSDK, 'dist/core/auth-storage.js'))});
      const settings = sdk.SettingsManager.create(process.cwd());
      const runtime = await sdk.ModelRuntime.create({allowModelNetwork: false, refreshOnCreate: false});
      console.log('ISOLATION=' + JSON.stringify({
        agentDir: sdk.getAgentDir(), appName: config.APP_NAME, configDir: config.CONFIG_DIR_NAME,
        provider: settings.getDefaultProvider(), thinking: settings.getDefaultThinkingLevel(),
        credential: await AuthStorage.create().read('regular-pi-provider'),
        ownModel: !!runtime.getModel('regular-pi-provider', 'fixture-model'),
        foreignModel: !!runtime.getModel('isolation-provider', 'fixture-model'),
      }));
    `,
        stockEnv,
      );
      assert.deepEqual(stockReport, {
        agentDir: join(f.normalPi, 'agent'),
        appName: 'pi',
        configDir: '.pi',
        provider: 'regular-pi-provider',
        thinking: 'minimal',
        credential: {type: 'api_key', key: 'regular-pi-secret'},
        ownModel: true,
        foreignModel: false,
      });
      assert.equal(
        await readFile(join(stockSDK, 'package.json'), 'utf8'),
        stockManifest,
      );
      await f.assertProtected();
    },
  );
}
