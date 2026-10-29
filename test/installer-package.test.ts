import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {createServer} from 'node:http';
import {homedir, tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {environmentPath, withNodePath} from '../src/runtime/environment.mjs';
import {runRuntimeCommand} from '../src/runtime/manager.ts';

const checkout = fileURLToPath(new URL('../', import.meta.url));

void test(
  'published installer builds, launches and updates the actual release outside the checkout with saved settings',
  {timeout: 600_000},
  async t => {
    const temporary = await realpath(
      await mkdtemp(join(tmpdir(), 'varisdev-installer space-')),
    );
    t.after(() => rm(temporary, {recursive: true, force: true, maxRetries: 5}));
    const home = join(temporary, 'home');
    const prefix = join(temporary, 'custom prefix');
    const data = join(temporary, 'saved data');
    const settings = join(temporary, 'agent settings');
    const existingProfile = join(temporary, 'existing desktop profile');
    const existingLauncher = join(existingProfile, 'windows-launcher');
    await mkdir(existingLauncher, {recursive: true});
    await writeFile(join(existingLauncher, 'launch.json'), 'existing launcher');
    const inherited = {...process.env, PIDEV_DESKTOP_DATA_DIR: existingProfile};
    await mkdir(home);
    const env: NodeJS.ProcessEnv = withNodePath(process.execPath, {
      ...inherited,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'AppData/Roaming'),
      LOCALAPPDATA: join(home, 'AppData/Local'),
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local/share'),
      ZDOTDIR: home,
      SHELL: process.platform === 'win32' ? '' : '/bin/sh',
      VARISDEV_DATA_DIR: join(temporary, 'fallback data'),
      VARISDEV_SETTINGS_DIR: settings,
      PIDEV_DESKTOP_DATA_DIR: data,
      VARISDEV_NODE_EXECUTABLE: process.execPath,
      npm_config_cache: process.env.npm_config_cache || join(homedir(), '.npm'),
      npm_config_prefer_offline: 'true',
      npm_config_update_notifier: 'false',
      // Production installation must not depend on automatic lifecycle hooks.
      npm_config_ignore_scripts: 'true',
      ...(process.platform === 'darwin'
        ? {
            electron_config_cache:
              process.env.electron_config_cache ||
              join(homedir(), 'Library/Caches/electron'),
          }
        : {}),
    });
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_PATH;
    delete env.VARISDEV_INSTALL_ROOT;
    const environment = environmentPath(env);
    await mkdir(dirname(environment), {recursive: true});
    const saved = JSON.stringify({
      VARISDEV_DATA_DIR: data,
      VARISDEV_SETTINGS_DIR: settings,
    });
    await writeFile(environment, saved);
    await mkdir(settings, {recursive: true});
    await writeFile(join(settings, 'preserved.txt'), 'saved user data');

    const run = (args: string[], cwd = temporary, timeoutMs = 240_000) =>
      runRuntimeCommand(process.execPath, args, {cwd, env, timeoutMs});
    const release = join(temporary, 'release');
    await run(['scripts/release-web.mjs', release], checkout, 30_000);
    const manifest = JSON.parse(
      await readFile(join(release, 'latest.json'), 'utf8'),
    );
    const archive = await readFile(
      join(release, `varisdev-${manifest.version}-${manifest.revision}.tgz`),
    );
    const installer = await readFile(join(release, 'install.mjs'));
    const server = createServer((request, response) => {
      if (request.url === '/latest.json')
        response.end(JSON.stringify(manifest));
      else if (request.url === '/download') response.end(archive);
      else if (request.url === '/install.mjs') response.end(installer);
      else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(
      () =>
        new Promise<void>(resolve => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    env.VARISDEV_INSTALLER_URL = `${origin}/install.mjs`;
    const result = await runRuntimeCommand(
      process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
      process.platform === 'win32'
        ? [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            join(release, 'install.ps1'),
            '-Prefix',
            prefix,
            '-Feed',
            `${origin}/latest.json`,
            '-NoPath',
          ]
        : [
            join(release, 'install.sh'),
            '--prefix',
            prefix,
            '--feed',
            `${origin}/latest.json`,
            '--no-path',
          ],
      {cwd: temporary, env, timeoutMs: 240_000},
    );
    assert.match(result, /Installed\./);
    const root = join(
      prefix,
      process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
      'varisdev',
    );
    for (const file of [
      'src/runtime/environment.mjs',
      'src/runtime/node-version.mjs',
      'desktop/build/src/runtime/environment.mjs',
      'desktop/build/src/runtime/cli.js',
      'desktop/build/src/desktop/main.js',
    ])
      await access(join(root, file));
    await assert.rejects(access(join(root, 'node_modules/gts')), {
      code: 'ENOENT',
    });
    const electron = await readFile(
      join(root, 'node_modules/electron/path.txt'),
      'utf8',
    );
    await access(join(root, 'node_modules/electron/dist', electron.trim()));
    const version = await run(
      [join(root, 'bin/varisdev.mjs'), '--version'],
      temporary,
      20_000,
    );
    assert.equal(version.trim(), `VarisDev ${manifest.version}`);
    await run(
      [
        '--input-type=module',
        '--eval',
        `
      await import(${JSON.stringify(pathToFileURL(join(root, 'desktop/build/src/dashboard/parent.js')).href)});
      await import('varisdev/visualizations');
    `,
      ],
      root,
      30_000,
    );

    // An earlier release forces the installed updater to prepare the real archive.
    await writeFile(
      join(root, 'build-info.json'),
      JSON.stringify({
        revision: '0'.repeat(40),
        source: 'https://joonas.ninja/varisdev/latest.json',
      }),
    );
    const updated = await run([
      '--input-type=module',
      '--eval',
      `
      const {initializeEnvironment} = await import(${JSON.stringify(pathToFileURL(join(root, 'src/runtime/environment.mjs')).href)});
      await initializeEnvironment();
      const {RuntimeManager} = await import(${JSON.stringify(pathToFileURL(join(root, 'desktop/build/src/runtime/manager.js')).href)});
      const {readRelease} = await import(${JSON.stringify(pathToFileURL(join(root, 'src/runtime/distribution.mjs')).href)});
      const manager = new RuntimeManager({installRoot: ${JSON.stringify(root)}, hooks: {
        readRelease: () => readRelease(${JSON.stringify(`${origin}/latest.json`)}),
      }});
      const status = await manager.update();
      if (status.phase !== 'ready') throw new Error(status.error || status.phase);
      console.log('ACTIVATED ' + await manager.currentRoot());
    `,
    ]);
    const active = /^ACTIVATED (.+)$/m.exec(updated)?.[1];
    assert.ok(active);
    assert.notEqual(active, root);
    const pointer = JSON.parse(
      await readFile(join(data, 'active.json'), 'utf8'),
    );
    assert.equal(pointer.revision, manifest.revision);
    assert.equal(pointer.baseRoot, root);
    assert.equal(
      (
        await run(
          [join(root, 'bin/varisdev.mjs'), '--version'],
          temporary,
          20_000,
        )
      ).trim(),
      `VarisDev ${manifest.version}`,
    );
    assert.equal(await readFile(environment, 'utf8'), saved);
    assert.deepEqual(await readdir(existingLauncher), ['launch.json']);
    assert.equal(
      await readFile(join(existingLauncher, 'launch.json'), 'utf8'),
      'existing launcher',
    );
    assert.equal(
      await readFile(join(settings, 'preserved.txt'), 'utf8'),
      'saved user data',
    );
    await assert.rejects(access(env.VARISDEV_DATA_DIR!), {code: 'ENOENT'});
    await assert.rejects(access(join(data, 'update.lock')), {code: 'ENOENT'});
    if (process.platform === 'win32') {
      const launcher = JSON.parse(
        await readFile(join(data, 'windows-launcher/launch.json'), 'utf8'),
      );
      assert.equal(launcher.installRoot, root);
      assert.equal(launcher.profile, data);
    }
    if (process.platform === 'darwin') {
      const launcher = JSON.parse(
        await readFile(
          join(
            home,
            'Applications/VarisDev.app/Contents/Resources/app/launch.json',
          ),
          'utf8',
        ),
      );
      assert.equal(launcher.installRoot, root);
      assert.equal(launcher.runtimeRoot, root);
    }
  },
);
