const {app, dialog} = require('electron');
const process = require('node:process');
const console = require('node:console');
const {spawn} = require('node:child_process');
const {readFileSync, mkdirSync} = require('node:fs');
const {homedir} = require('node:os');
const {isAbsolute, join, resolve} = require('node:path');
const {pathToFileURL} = require('node:url');

async function start() {
  const config = JSON.parse(
    readFileSync(require.resolve('./launch.json'), 'utf8'),
  );
  if (
    !config ||
    typeof config.installRoot !== 'string' ||
    !isAbsolute(config.installRoot) ||
    typeof config.nodeExecutable !== 'string' ||
    !isAbsolute(config.nodeExecutable) ||
    (config.dataDir !== undefined && typeof config.dataDir !== 'string') ||
    typeof config.path !== 'string' ||
    !config.path ||
    (config.settingsDir !== undefined && typeof config.settingsDir !== 'string')
  )
    throw new Error(
      'Invalid launcher configuration. Run varisdev app install.',
    );
  process.env.PATH ||= config.path;
  process.env.VARISDEV_INSTALL_ROOT = config.installRoot;
  process.env.VARISDEV_NODE_EXECUTABLE = config.nodeExecutable;
  if (config.dataDir) process.env.VARISDEV_DATA_DIR ??= config.dataDir;
  if (config.settingsDir)
    process.env.VARISDEV_SETTINGS_DIR ??= config.settingsDir;
  let environmentModule;
  try {
    environmentModule = require.resolve('./environment.mjs');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    // Older updaters refreshed only main.cjs in an existing app bundle.
    const {RuntimeManager} = await import(
      pathToFileURL(
        join(config.installRoot, 'desktop/build/src/runtime/manager.js'),
      ).href
    );
    const activeRoot = await new RuntimeManager({
      installRoot: config.installRoot,
    }).currentRoot();
    environmentModule = join(activeRoot, 'src/runtime/environment.mjs');
  }
  const {initializeEnvironment, environmentForChild} = await import(
    pathToFileURL(environmentModule).href
  );
  await initializeEnvironment();
  process.chdir(homedir());
  const {RuntimeManager, defaultDataDir} = await import(
    pathToFileURL(
      join(config.installRoot, 'desktop/build/src/runtime/manager.js'),
    ).href
  );
  const runtime = new RuntimeManager({installRoot: config.installRoot});
  const root = await runtime.currentRoot();
  if (
    (!config.runtimeRoot || resolve(config.runtimeRoot) !== resolve(root)) &&
    !process.connected
  ) {
    const project = process.argv.find(arg =>
      arg.startsWith('--varisdev-project='),
    );
    const profile =
      process.env.PIDEV_DESKTOP_DATA_DIR || join(defaultDataDir(), 'desktop');
    mkdirSync(profile, {recursive: true});
    app.setPath('userData', profile);
    if (
      !app.requestSingleInstanceLock({
        project: project?.slice('--varisdev-project='.length),
      })
    ) {
      app.quit();
      return;
    }
    app.releaseSingleInstanceLock();
    const child = spawn(
      config.nodeExecutable,
      [
        join(config.installRoot, 'bin/varisdev.mjs'),
        ...(project
          ? [project.slice('--varisdev-project='.length)]
          : ['--overview']),
      ],
      {
        detached: true,
        stdio: 'ignore',
        env: {
          ...environmentForChild(),
          VARISDEV_RESTART_PID: String(process.pid),
        },
      },
    );
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    app.quit();
    return;
  }
  process.env.PATH = [join(root, 'node_modules/.bin'), process.env.PATH].join(
    ':',
  );
  await import(
    pathToFileURL(join(root, 'desktop/build/src/desktop/main.js')).href
  );
}

app.setName('VarisDev');
process.argv.push('--varisdev-launcher');
start().catch(async error => {
  console.error('Could not start VarisDev:', error);
  await app.whenReady();
  dialog.showErrorBox('Could not start VarisDev', error.message);
  app.exit(1);
});
