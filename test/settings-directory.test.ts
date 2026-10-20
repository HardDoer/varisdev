import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {test, type TestContext} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {configureBundledPi} from '../scripts/configure-pi.mjs';
import {
  configureSettings,
  settingsDirectory,
} from '../src/runtime/settings.mjs';

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'varisdev-settings-layout-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const root = join(home, '.varisdev');
  const agent = join(root, 'agent');
  const env = {HOME: home, USERPROFILE: home};
  async function put(path: string, content = 'fixture') {
    await mkdir(dirname(path), {recursive: true});
    await writeFile(path, content);
  }
  return {home, root, agent, env, put};
}

void test('global layout matches Pi with only the application namespace changed', async t => {
  const f = await fixture(t);
  assert.equal(settingsDirectory(f.env), f.agent);
  // Path lookup alone must not create or migrate anything.
  assert.deepEqual(await readdir(f.home), []);
  for (const override of [f.root, '~/.varisdev', '~\\.varisdev', f.agent]) {
    assert.equal(
      settingsDirectory({...f.env, VARISDEV_SETTINGS_DIR: override}),
      f.agent,
    );
  }
  for (const [override, expected] of [
    [join(f.home, 'custom'), join(f.home, 'custom')],
    ['~/custom', join(f.home, 'custom')],
    ['~\\custom', join(f.home, 'custom')],
    ['~', f.home],
    ['./custom', resolve('custom')],
  ]) {
    assert.equal(
      settingsDirectory({...f.env, VARISDEV_SETTINGS_DIR: override}),
      expected,
    );
  }
});

void test('Pi directory overrides cannot redirect the bundled runtime', async t => {
  const f = await fixture(t);
  const pi = join(f.home, '.pi', 'agent');
  const env = {
    ...f.env,
    PI_CODING_AGENT_DIR: pi,
    PI_CODING_AGENT_SESSION_DIR: join(pi, 'sessions'),
    PI_PACKAGE_DIR: join(f.home, 'standalone-pi'),
    VARISDEV_CODING_AGENT_DIR: pi,
    VARISDEV_CODING_AGENT_SESSION_DIR: join(pi, 'sessions'),
  };
  const configured = configureSettings(env);
  assert.equal(configured.VARISDEV_SETTINGS_DIR, f.agent);
  assert.equal(configured.VARISDEV_CODING_AGENT_DIR, f.agent);
  assert.equal(configured.VARISDEV_CODING_AGENT_SESSION_DIR, undefined);
  assert.equal(configured.PI_PACKAGE_DIR, undefined);
  assert.equal(configured.PI_CODING_AGENT_DIR, f.agent);
  assert.equal(configured.PI_CODING_AGENT_SESSION_DIR, undefined);
  assert.deepEqual(configureSettings(configured), configured);
  assert.deepEqual(await readdir(f.home), []);
});

void test('bootstrap keeps unbranded and private SDK path lookups in VarisDev without initializing files', async t => {
  const f = await fixture(t);
  const execFile = promisify(execFileCallback);
  const root = fileURLToPath(new URL('../', import.meta.url));
  for (const override of [undefined, join(f.home, 'custom-agent')]) {
    const env = configureSettings({
      ...process.env,
      ...f.env,
      VARISDEV_SETTINGS_DIR: override ?? '',
      PI_CODING_AGENT_DIR: join(f.home, '.pi', 'agent'),
      VARISDEV_CODING_AGENT_DIR: join(f.home, 'inherited-agent'),
      PI_CODING_AGENT_SESSION_DIR: join(f.home, '.pi', 'sessions'),
      VARISDEV_CODING_AGENT_SESSION_DIR: join(f.home, 'inherited-sessions'),
    });
    const expected = override ?? f.agent;
    for (const prefix of ['', 'desktop/']) {
      const config = pathToFileURL(
        join(
          root,
          prefix,
          'node_modules/@earendil-works/pi-coding-agent/dist/config.js',
        ),
      ).href;
      const {stdout} = await execFile(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
          const config = await import(${JSON.stringify(config)});
          console.log(JSON.stringify({
            agent: config.getAgentDir(), auth: config.getAuthPath(),
            settings: config.getSettingsPath(), models: config.getModelsPath(),
            sessionOverride: process.env[config.ENV_SESSION_DIR] ?? null,
          }));
        `,
        ],
        {env},
      );
      assert.deepEqual(JSON.parse(stdout), {
        agent: expected,
        auth: join(expected, 'auth.json'),
        settings: join(expected, 'settings.json'),
        models: join(expected, 'models.json'),
        sessionOverride: null,
      });
    }
    assert.deepEqual(await readdir(f.home), []);
  }
});

void test('private SDK configuration preserves package metadata and the standalone SDK', async t => {
  const f = await fixture(t);
  const relative = 'node_modules/@earendil-works/pi-coding-agent/package.json';
  const privateManifest = join(f.home, 'desktop', relative);
  const stockManifest = join(f.home, relative);
  const original = {
    name: 'sdk-fixture',
    version: '1.0.0',
    piConfig: {configDir: '.pi', other: true},
  };
  await f.put(privateManifest, JSON.stringify(original));
  await f.put(stockManifest, JSON.stringify(original));
  const oauthRelative =
    'node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-chatgpt.js';
  const oauthSource = await readFile(
    new URL(
      './auth/oauth/openai-chatgpt.js',
      import.meta.resolve('@earendil-works/pi-ai/oauth'),
    ),
    'utf8',
  );
  await f.put(join(f.home, 'desktop', oauthRelative), oauthSource);
  await f.put(join(f.home, oauthRelative), oauthSource);
  const browserRelative =
    'node_modules/@earendil-works/pi-coding-agent/dist/utils/open-browser.js';
  const browserSource = await readFile(
    new URL(
      './utils/open-browser.js',
      import.meta.resolve('@earendil-works/pi-coding-agent'),
    ),
    'utf8',
  );
  await f.put(join(f.home, 'desktop', browserRelative), browserSource);
  await f.put(join(f.home, browserRelative), browserSource);
  await configureBundledPi(join(f.home, 'desktop'));
  assert.deepEqual(JSON.parse(await readFile(privateManifest, 'utf8')), {
    ...original,
    piConfig: {...original.piConfig, name: 'varisdev', configDir: '.varisdev'},
  });
  assert.deepEqual(JSON.parse(await readFile(stockManifest, 'utf8')), original);
  const patched = await readFile(
    join(f.home, 'desktop', oauthRelative),
    'utf8',
  );
  assert.match(patched, /varisdevRegistrationReuse: true/);
  assert.equal(
    await readFile(join(f.home, oauthRelative), 'utf8'),
    oauthSource,
  );
  const patchedBrowser = await readFile(
    join(f.home, 'desktop', browserRelative),
    'utf8',
  );
  assert.match(patchedBrowser, /openWSLBrowser\(target\)/);
  assert.equal(
    await readFile(join(f.home, browserRelative), 'utf8'),
    browserSource,
  );
  assert.equal(
    await readFile(
      join(
        f.home,
        'desktop',
        browserRelative.replace('open-browser.js', 'varisdev-browser.mjs'),
      ),
      'utf8',
    ),
    await readFile(
      new URL('../src/runtime/browser.mjs', import.meta.url),
      'utf8',
    ),
  );
  await configureBundledPi(join(f.home, 'desktop'));
  assert.equal(
    await readFile(join(f.home, 'desktop', oauthRelative), 'utf8'),
    patched,
  );
  assert.equal(
    await readFile(join(f.home, 'desktop', browserRelative), 'utf8'),
    patchedBrowser,
  );
});

void test('legacy flat VarisDev profiles migrate without changing originals or Pi', async t => {
  const f = await fixture(t);
  const files = [
    'auth.json',
    'models.json',
    'models-store.json',
    'trust.json',
    'keybindings.json',
    'SYSTEM.md',
    'APPEND_SYSTEM.md',
    'AGENTS.md',
    'AGENTS.override.md',
    'CLAUDE.md',
    'extensions/review.ts',
    'skills/review/SKILL.md',
    'prompts/review.md',
    'themes/custom.json',
    'sessions/project/session.jsonl',
    'npm/node_modules/example/index.js',
    'git/example.org/user/plugin/index.js',
    'tools/custom.js',
    'bin/rg',
    'agents/reviewer.md',
    'varisdev/tool-settings.json',
    'varisdev/tool-models/openai_image.json',
    'package.json',
    'package-lock.json',
    'node_modules/example/index.js',
  ];
  for (const file of files) await f.put(join(f.root, file), file);
  const settings = {
    defaultModel: 'preserved',
    extensions: ['./extensions/review.ts', '!extensions/disabled.ts'],
    skills: ['./skills/**/SKILL.md'],
    packages: [
      'npm:example',
      'git:example.org/user/plugin',
      'https://example.org/user/plugin',
      '../external-plugin',
      {source: './git/example.org/user/plugin', skills: ['skills/*.md']},
    ],
  };
  const original = JSON.stringify(settings);
  await f.put(join(f.root, 'settings.json'), original);
  await f.put(join(f.root, 'unrelated-app-file'), 'do not move');
  const piAuth = join(f.home, '.pi', 'agent', 'auth.json');
  await f.put(piAuth, 'standalone Pi credentials');
  // Simulate an old desktop launcher which persisted the flat default.
  const env = configureSettings({...f.env, VARISDEV_SETTINGS_DIR: f.root});
  assert.equal(env.VARISDEV_SETTINGS_DIR, f.agent);
  for (const file of files) {
    assert.equal(await readFile(join(f.agent, file), 'utf8'), file);
    assert.equal(await readFile(join(f.root, file), 'utf8'), file);
  }
  assert.equal(await readFile(piAuth, 'utf8'), 'standalone Pi credentials');
  assert.equal(await readFile(join(f.root, 'settings.json'), 'utf8'), original);
  assert.equal(
    await readFile(join(f.root, 'unrelated-app-file'), 'utf8'),
    'do not move',
  );
  await assert.rejects(readFile(join(f.agent, 'unrelated-app-file')), {
    code: 'ENOENT',
  });
  assert.deepEqual(
    JSON.parse(await readFile(join(f.agent, 'settings.json'), 'utf8')),
    {
      ...settings,
      extensions: [
        join(f.agent, 'extensions/review.ts'),
        '!' + join(f.agent, 'extensions/disabled.ts'),
      ],
      skills: [join(f.agent, 'skills/**/SKILL.md')],
      packages: [
        ...settings.packages.slice(0, 3),
        join(f.home, 'external-plugin'),
        {
          source: join(f.agent, 'git/example.org/user/plugin'),
          skills: ['skills/*.md'],
        },
      ],
    },
  );
  assert.ok(
    !(await readdir(f.root)).some(name => name.startsWith('.agent-migration-')),
  );
  // Repeated startup must not restore credentials the user removed after migration.
  await rm(join(f.agent, 'auth.json'));
  configureSettings(env);
  await assert.rejects(readFile(join(f.agent, 'auth.json')), {code: 'ENOENT'});
});

void test('existing agent directories and explicit custom profiles are never overwritten', async t => {
  const f = await fixture(t);
  await f.put(join(f.root, 'auth.json'), 'old credentials');
  await f.put(join(f.agent, 'auth.json'), 'current credentials');
  configureSettings(f.env);
  assert.equal(
    await readFile(join(f.agent, 'auth.json'), 'utf8'),
    'current credentials',
  );
  const custom = join(f.home, 'custom');
  await f.put(join(custom, 'auth.json'), 'custom credentials');
  configureSettings({...f.env, VARISDEV_SETTINGS_DIR: custom});
  assert.deepEqual(await readdir(custom), ['auth.json']);
  assert.equal(
    await readFile(join(custom, 'auth.json'), 'utf8'),
    'custom credentials',
  );
  assert.equal(
    await readFile(join(f.root, 'auth.json'), 'utf8'),
    'old credentials',
  );
});

void test('migrated config symlinks become independent files without modifying their targets', async t => {
  const f = await fixture(t);
  const pi = join(f.home, '.pi', 'agent');
  const original = JSON.stringify({extensions: ['./extensions/review.ts']});
  await f.put(join(pi, 'settings.json'), original);
  await f.put(join(pi, 'auth.json'), 'standalone credentials');
  await mkdir(f.root, {recursive: true});
  try {
    for (const name of ['settings.json', 'auth.json'])
      await symlink(join(pi, name), join(f.root, name), 'file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('File symlinks require additional privileges on this platform');
      return;
    }
    throw error;
  }
  configureSettings(f.env);
  assert.equal(await readFile(join(pi, 'settings.json'), 'utf8'), original);
  await writeFile(join(f.agent, 'auth.json'), 'VarisDev credentials');
  assert.equal(
    await readFile(join(pi, 'auth.json'), 'utf8'),
    'standalone credentials',
  );
});

void test('migration failure leaves the original profile intact and does not publish a partial copy', async t => {
  const f = await fixture(t);
  await f.put(join(f.root, 'settings.json'), '{invalid');
  await f.put(join(f.root, 'auth.json'), 'preserved credentials');
  assert.throws(() => configureSettings(f.env), SyntaxError);
  assert.equal(
    await readFile(join(f.root, 'auth.json'), 'utf8'),
    'preserved credentials',
  );
  assert.deepEqual((await readdir(f.root)).sort(), [
    'auth.json',
    'settings.json',
  ]);
});
