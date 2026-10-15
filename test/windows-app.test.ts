import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {homedir, tmpdir} from 'node:os';
import {delimiter, dirname, join} from 'node:path';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {RuntimeManager} from '../src/runtime/manager.ts';
import {
  prepareWindowsLauncher,
  quoteWindowsArgument,
  windowsAppId,
} from '../src/runtime/windows-launcher.ts';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

void test('Windows argument quoting preserves spaces, embedded quotes and trailing backslashes', () => {
  assert.equal(
    quoteWindowsArgument('C:\\Program Files\\VarisDev\\'),
    '"C:\\Program Files\\VarisDev\\\\"',
  );
  assert.equal(quoteWindowsArgument('a"b'), '"a\\"b"');
  assert.equal(quoteWindowsArgument('a\\"b'), '"a\\\\\\"b"');
});

void test('Windows launcher persists dedicated settings independently of Pi', async t => {
  const directory = await mkdtemp(
    join(tmpdir(), 'varisdev-launcher-settings-'),
  );
  t.after(() => rm(directory, {recursive: true, force: true}));
  const previousSettings = process.env.VARISDEV_SETTINGS_DIR;
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = join(directory, 'regular-pi');
    for (const override of [join(directory, 'settings'), undefined]) {
      if (override) process.env.VARISDEV_SETTINGS_DIR = override;
      else delete process.env.VARISDEV_SETTINGS_DIR;
      await prepareWindowsLauncher({
        installRoot: root,
        runtimeRoot: root,
        profile: directory,
        dataDir: join(directory, 'data'),
      });
      const config = JSON.parse(
        await readFile(join(directory, 'windows-launcher/launch.json'), 'utf8'),
      );
      assert.equal(
        config.settingsDir,
        override || join(homedir(), '.varisdev', 'agent'),
      );
      assert.equal(Object.hasOwn(config, 'agentDir'), false);
    }
  } finally {
    if (previousSettings === undefined)
      delete process.env.VARISDEV_SETTINGS_DIR;
    else process.env.VARISDEV_SETTINGS_DIR = previousSettings;
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
  }
});

void test(
  'Windows shortcut opens overview through the active runtime after an update',
  {
    skip: process.platform !== 'win32',
    timeout: 60000,
  },
  async t => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'varisdev windows app ')),
    );
    t.after(() => rm(directory, {recursive: true, force: true, maxRetries: 5}));
    const installRoot = join(directory, 'base install');
    const dataDir = join(directory, 'data');
    const profile = join(directory, 'desktop profile');
    const report = join(directory, 'launch.json');
    const appData = join(directory, 'roaming');
    const savedToolPath = join(directory, 'shell tools');
    const settingsDir = join(directory, 'settings');
    const inheritedAgent = join(directory, 'regular-pi');
    async function put(path: string, contents: string) {
      await mkdir(dirname(path), {recursive: true});
      await writeFile(path, contents);
    }
    async function application(path: string, version: string) {
      await put(
        join(path, 'package.json'),
        JSON.stringify({name: 'varisdev', type: 'module', version}),
      );
      await put(
        join(
          path,
          'desktop/node_modules/@earendil-works/pi-coding-agent/package.json',
        ),
        '{"version":"0.85.1"}',
      );
      for (const name of [
        'bin/varisdev.mjs',
        'assets/dashboard/index.html',
        'assets/desktop/preload.cjs',
        'desktop/build/src/desktop/main.js',
        'desktop/build/src/dashboard/parent.js',
      ])
        await put(join(path, name), '');
      await put(
        join(path, 'desktop/build/src/runtime/cli.js'),
        `
      import {writeFileSync} from 'node:fs';
      import {configureSettings} from ${JSON.stringify(pathToFileURL(join(root, 'src/runtime/settings.mjs')).href)};
      export async function runCli(args, installRoot) {
        configureSettings();
        writeFileSync(${JSON.stringify(report)}, JSON.stringify({args, installRoot, runtimeRoot: ${JSON.stringify(path)}, savedToolPath: process.env.PATH.split(';').includes(${JSON.stringify(savedToolPath)}), settingsDir: process.env.VARISDEV_SETTINGS_DIR, sdkSettingsDir: process.env.VARISDEV_CODING_AGENT_DIR, agentDir: process.env.PI_CODING_AGENT_DIR}));
        return 0;
      }
    `,
      );
    }
    await application(installRoot, '0.1.0');
    await put(
      join(installRoot, 'desktop/build/src/runtime/manager.js'),
      `export {RuntimeManager} from ${JSON.stringify(pathToFileURL(join(root, 'desktop/build/src/runtime/manager.js')).href)};`,
    );
    await put(
      join(installRoot, 'node_modules/npm/package.json'),
      '{"exports":{"./package.json":"./package.json"}}',
    );
    await symlink(
      dirname(require.resolve('electron/package.json')),
      join(installRoot, 'node_modules/electron'),
      'junction',
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      APPDATA: appData,
      VARISDEV_INSTALL_ROOT: installRoot,
      VARISDEV_DATA_DIR: dataDir,
      PIDEV_DESKTOP_DATA_DIR: profile,
      VARISDEV_NODE_EXECUTABLE: process.execPath,
      VARISDEV_SETTINGS_DIR: settingsDir,
      PI_CODING_AGENT_DIR: inheritedAgent,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.VARISDEV_RESTART_PID;
    await execute(
      process.execPath,
      [join(root, 'scripts/desktop-app.mjs'), 'install'],
      {env, timeout: 20000},
    );
    const shortcut = join(
      appData,
      'Microsoft/Windows/Start Menu/Programs/VarisDev.lnk',
    );
    const configPath = join(profile, 'windows-launcher/launch.json');
    const installedConfig = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(installedConfig.settingsDir, settingsDir);
    assert.equal(Object.hasOwn(installedConfig, 'agentDir'), false);
    const pinned = join(directory, 'Pinned VarisDev.lnk');
    await copyFile(shortcut, pinned);
    const details = await prepareWindowsLauncher({
      installRoot,
      runtimeRoot: root,
      profile,
      dataDir,
      nodeExecutable: process.execPath,
    });
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.path = [savedToolPath, config.path].join(delimiter);
    config.settingsDir = settingsDir;
    config.agentDir = join(directory, 'legacy-launcher-agent');
    await writeFile(configPath, JSON.stringify(config));
    const inspect = join(directory, 'inspect.cjs');
    await put(
      inspect,
      `
    const {app, shell} = require('electron');
    const {writeFileSync} = require('node:fs');
    app.whenReady().then(() => {
      writeFileSync(${JSON.stringify(join(directory, 'shortcut.json'))}, JSON.stringify(shell.readShortcutLink(${JSON.stringify(pinned)})));
      app.quit();
    });
  `,
    );
    await execute(require('electron') as string, [inspect], {
      env,
      timeout: 20000,
    });
    const saved = JSON.parse(
      await readFile(join(directory, 'shortcut.json'), 'utf8'),
    );
    assert.equal(saved.appUserModelId, windowsAppId);
    assert.equal(saved.target, details.shortcut.target);
    assert.equal(saved.args, details.shortcut.args);
    assert.equal(saved.icon, details.appDetails.appIconPath);
    assert.equal(saved.iconIndex, 0);
    assert.deepEqual(
      await readFile(saved.icon),
      await readFile(join(root, 'assets/desktop/robot-crow.ico')),
    );
    assert.equal(
      details.appDetails.relaunchCommand,
      `${quoteWindowsArgument(saved.target)} ${saved.args}`,
    );
    async function launch() {
      await rm(report, {force: true});
      // ShellExecute the saved shortcut, as Windows does for a pinned application.
      await execute(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Start-Process -FilePath '${pinned.replaceAll("'", "''")}'`,
        ],
        {
          env: {
            ...env,
            VARISDEV_SETTINGS_DIR: join(directory, 'inherited-settings'),
          },
          timeout: 15000,
        },
      );
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          return JSON.parse(await readFile(report, 'utf8'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await delay(100);
        }
      }
      throw new Error('The Windows shortcut did not launch VarisDev.');
    }
    assert.deepEqual(await launch(), {
      args: ['--overview'],
      installRoot,
      runtimeRoot: installRoot,
      savedToolPath: true,
      settingsDir,
      sdkSettingsDir: settingsDir,
      agentDir: inheritedAgent,
    });
    const manager = new RuntimeManager({
      installRoot,
      dataDir,
      hooks: {
        run: async (command, args, options) => {
          if (command === 'git') {
            if (args[0] === 'ls-remote') return `${'b'.repeat(40)}\tHEAD\n`;
            if (args[0] === 'init') await application(args[1], '0.2.0');
          } else if (args[1] === 'install') {
            await application(
              join(options.cwd, 'node_modules/varisdev'),
              '0.2.0',
            );
          }
          return;
        },
        smokeImport: async () => {},
      },
    });
    const status = await manager.update();
    assert.equal(status.phase, 'ready', status.error);
    const updatedRoot = await manager.currentRoot();
    assert.notEqual(updatedRoot, installRoot);
    // The original shortcut and bootstrap must resolve the newly selected runtime.
    assert.deepEqual(await launch(), {
      args: ['--overview'],
      installRoot,
      runtimeRoot: updatedRoot,
      savedToolPath: true,
      settingsDir,
      sdkSettingsDir: settingsDir,
      agentDir: inheritedAgent,
    });
  },
);
