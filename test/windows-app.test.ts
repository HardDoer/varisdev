import assert from 'node:assert/strict';
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
import {RuntimeManager} from '../src/runtime/manager.ts';
import {environmentPath} from '../src/runtime/environment.mjs';
import {
  prepareWindowsLauncher,
  quoteWindowsArgument,
  windowsAppId,
} from '../src/runtime/windows-launcher.ts';

import {runTerminalProcess as execute} from './fixtures/terminal-process.mjs';
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

for (const legacyBase of [false, true]) {
  void test(
    `Windows shortcut recovers a removed cached generation${legacyBase ? ' with a helper-free base' : ''}`,
    {
      skip: process.platform !== 'win32',
      timeout: 90000,
    },
    async t => {
      const directory = await realpath(
        await mkdtemp(join(tmpdir(), 'varisdev windows app ')),
      );
      t.after(() =>
        rm(directory, {recursive: true, force: true, maxRetries: 5}),
      );
      const installRoot = join(directory, 'base install');
      const dataDir = join(directory, 'data');
      const inheritedDataDir = join(directory, 'inherited data');
      const profile = join(directory, 'desktop profile');
      const report = join(directory, 'launch.json');
      const appData = join(directory, 'roaming');
      const savedToolPath = join(directory, 'shell tools');
      const settingsDir = join(directory, 'settings');
      const inheritedSettingsDir = join(directory, 'inherited-settings');
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
        await put(
          join(path, 'node_modules/npm/package.json'),
          '{"exports":{"./package.json":"./package.json"}}',
        );
        for (const name of ['environment.mjs', 'node-version.mjs'])
          await put(
            join(path, 'src/runtime', name),
            await readFile(join(root, 'src/runtime', name), 'utf8'),
          );
        for (const name of ['windows-main.cjs', 'robot-crow.ico']) {
          await mkdir(join(path, 'assets/desktop'), {recursive: true});
          await copyFile(
            join(root, 'assets/desktop', name),
            join(path, 'assets/desktop', name),
          );
        }
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
        writeFileSync(${JSON.stringify(report)}, JSON.stringify({args, installRoot, runtimeRoot: ${JSON.stringify(path)}, dataDir: process.env.VARISDEV_DATA_DIR, savedToolPath: process.env.PATH.split(';').includes(${JSON.stringify(savedToolPath)}), settingsDir: process.env.VARISDEV_SETTINGS_DIR, sdkSettingsDir: process.env.VARISDEV_CODING_AGENT_DIR, agentDir: process.env.PI_CODING_AGENT_DIR}));
        return 0;
      }
    `,
        );
      }
      await application(installRoot, '0.1.0');
      if (legacyBase) {
        for (const name of ['environment.mjs', 'node-version.mjs'])
          await rm(join(installRoot, 'src/runtime', name));
      }
      await put(
        join(installRoot, 'desktop/build/src/runtime/manager.js'),
        `export {RuntimeManager} from ${JSON.stringify(pathToFileURL(join(root, 'desktop/build/src/runtime/manager.js')).href)};`,
      );
      await symlink(
        dirname(require.resolve('electron/package.json')),
        join(installRoot, 'node_modules/electron'),
        'junction',
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        APPDATA: appData,
        LOCALAPPDATA: join(directory, 'local'),
        VARISDEV_INSTALL_ROOT: installRoot,
        VARISDEV_DATA_DIR: dataDir,
        PIDEV_DESKTOP_DATA_DIR: profile,
        VARISDEV_NODE_EXECUTABLE: process.execPath,
        VARISDEV_SETTINGS_DIR: settingsDir,
        PI_CODING_AGENT_DIR: inheritedAgent,
      };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.VARISDEV_RESTART_PID;
      await put(
        environmentPath(env, 'win32'),
        JSON.stringify({
          VARISDEV_SETTINGS_DIR: settingsDir,
          VARISDEV_DATA_DIR: dataDir,
        }),
      );
      await execute(
        process.execPath,
        [join(root, 'scripts/desktop-app.mjs'), 'install'],
        {env, timeoutMs: 20000},
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
      async function configureLauncher() {
        const config = JSON.parse(await readFile(configPath, 'utf8'));
        config.path = [savedToolPath, config.path].join(delimiter);
        config.settingsDir = settingsDir;
        config.agentDir = join(directory, 'legacy-launcher-agent');
        await writeFile(configPath, JSON.stringify(config));
      }
      await configureLauncher();
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
        timeoutMs: 20000,
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
          join(
            process.env.SystemRoot || process.env.windir || 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
          ),
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Start-Process -Wait -FilePath '${pinned.replaceAll("'", "''")}'`,
          ],
          {
            env: {
              ...env,
              VARISDEV_SETTINGS_DIR: inheritedSettingsDir,
              VARISDEV_DATA_DIR: inheritedDataDir,
            },
            timeoutMs: 15000,
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
      function expectedLaunch(runtimeRoot: string) {
        return {
          args: ['--overview'],
          installRoot,
          runtimeRoot,
          dataDir,
          savedToolPath: true,
          settingsDir,
          sdkSettingsDir: settingsDir,
          agentDir: settingsDir,
        };
      }
      assert.deepEqual(
        await launch(),
        legacyBase
          ? {
              ...expectedLaunch(installRoot),
              dataDir: inheritedDataDir,
              settingsDir: inheritedSettingsDir,
              sdkSettingsDir: inheritedSettingsDir,
              agentDir: inheritedSettingsDir,
            }
          : expectedLaunch(installRoot),
      );
      let revision = 'b'.repeat(40);
      let version = '0.2.0';
      const manager = new RuntimeManager({
        installRoot,
        dataDir,
        hooks: {
          run: async (command, args, options) => {
            if (command === 'git') {
              if (args[0] === 'ls-remote') return `${revision}\tHEAD\n`;
              if (args[0] === 'init') await application(args[1], version);
            } else if (args[1] === 'install') {
              await application(
                join(options.cwd, 'node_modules/varisdev'),
                version,
              );
            }
            return;
          },
          smokeImport: async () => {},
        },
      });
      const status = await manager.update();
      assert.equal(status.phase, 'ready', status.error);
      const generationA = await manager.currentRoot();
      assert.notEqual(generationA, installRoot);
      await prepareWindowsLauncher({
        installRoot,
        runtimeRoot: generationA,
        profile,
        dataDir,
        nodeExecutable: process.execPath,
      });
      await configureLauncher();
      assert.deepEqual(await launch(), expectedLaunch(generationA));
      const cachedConfig = await readFile(configPath, 'utf8');
      assert.equal(JSON.parse(cachedConfig).runtimeRoot, generationA);
      const cachedBootstrap = await readFile(
        join(profile, 'windows-launcher/main.cjs'),
      );
      revision = 'c'.repeat(40);
      version = '0.3.0';
      const secondUpdate = await manager.update();
      assert.equal(secondUpdate.phase, 'ready', secondUpdate.error);
      const generationB = await manager.currentRoot();
      assert.notEqual(generationB, generationA);
      await rm(dirname(dirname(generationA)), {recursive: true, force: true});
      if (legacyBase) {
        for (const name of ['environment.mjs', 'node-version.mjs'])
          await assert.rejects(
            readFile(join(installRoot, 'src/runtime', name)),
            {
              code: 'ENOENT',
            },
          );
      }
      // Use the same pinned shortcut, config and bootstrap after the cached runtime disappears.
      assert.equal(await readFile(configPath, 'utf8'), cachedConfig);
      assert.deepEqual(
        await readFile(join(profile, 'windows-launcher/main.cjs')),
        cachedBootstrap,
      );
      assert.deepEqual(await launch(), expectedLaunch(generationB));
      assert.deepEqual(await readFile(pinned), await readFile(shortcut));
    },
  );
}
