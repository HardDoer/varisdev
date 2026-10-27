const process = require('node:process');
const console = require('node:console');
if (Number.parseInt(process.versions.node, 10) < 24) {
  console.error(`VarisDev requires Node 24+ (running ${process.version}).`);
  process.exit(1);
}
const {app, dialog} = require('electron');
const {existsSync, mkdirSync, readFileSync} = require('node:fs');
const {homedir} = require('node:os');
const {dirname, delimiter, isAbsolute, join} = require('node:path');
const {pathToFileURL} = require('node:url');

app.setName('VarisDev');
app.setAppUserModelId('com.varisware.varisdev');

async function start() {
  const config = JSON.parse(
    readFileSync(require.resolve('./launch.json'), 'utf8'),
  );
  for (const field of ['installRoot', 'dataDir', 'profile']) {
    if (typeof config[field] !== 'string' || !isAbsolute(config[field]))
      throw new Error(
        'Invalid launcher configuration. Run varisdev app install.',
      );
  }
  if (
    config.settingsDir !== undefined &&
    typeof config.settingsDir !== 'string'
  )
    throw new Error(
      'Invalid launcher configuration. Run varisdev app install.',
    );
  const bootstrapProfile = join(config.profile, 'windows-launcher/bootstrap');
  mkdirSync(bootstrapProfile, {recursive: true});
  app.setPath('userData', bootstrapProfile);
  process.env.VARISDEV_INSTALL_ROOT = config.installRoot;
  if (config.environment) {
    for (const name of [
      'VARISDEV_DATA_DIR',
      'PIDEV_DESKTOP_DATA_DIR',
      'VARISDEV_SETTINGS_DIR',
    ]) {
      if (typeof config.environment[name] === 'string')
        process.env[name] ??= config.environment[name];
    }
  } else {
    process.env.VARISDEV_DATA_DIR ??= config.dataDir;
    process.env.PIDEV_DESKTOP_DATA_DIR ??= config.profile;
  }
  if (config.nodeExecutable)
    process.env.VARISDEV_NODE_EXECUTABLE = config.nodeExecutable;
  process.env.PATH = [
    ...new Set(
      [
        config.nodeExecutable ? dirname(config.nodeExecutable) : undefined,
        ...(process.env.PATH || '').split(delimiter),
        ...(config.path || '').split(delimiter),
      ].filter(Boolean),
    ),
  ].join(delimiter);
  if (!config.environment && config.settingsDir)
    process.env.VARISDEV_SETTINGS_DIR ??= config.settingsDir;
  delete process.env.ELECTRON_RUN_AS_NODE;
  const {RuntimeManager} = await import(
    pathToFileURL(
      join(config.installRoot, 'desktop/build/src/runtime/manager.js'),
    ).href
  );
  // The saved generation may have been removed. Resolve through the base manager
  // before loading helpers; early installations have no helper of their own.
  const bootstrapRoot = await new RuntimeManager({
    installRoot: config.installRoot,
    dataDir: config.dataDir,
  }).currentRoot();
  const environment = [bootstrapRoot, config.installRoot]
    .map(root => join(root, 'src/runtime/environment.mjs'))
    .find(path => existsSync(path));
  if (environment) {
    const {initializeEnvironment} = await import(
      pathToFileURL(environment).href
    );
    await initializeEnvironment();
  }
  process.chdir(homedir());
  // Saved settings can select a different data directory from the launch fallback.
  const root = await new RuntimeManager({
    installRoot: config.installRoot,
  }).currentRoot();
  const {runCli} = await import(
    pathToFileURL(join(root, 'desktop/build/src/runtime/cli.js')).href
  );
  // Let the active CLI start its own Electron version and use the overview.
  const code = await runCli(['--overview'], config.installRoot);
  app.exit(code);
}

start().catch(async error => {
  console.error('Could not start VarisDev:', error);
  await app.whenReady();
  dialog.showErrorBox('Could not start VarisDev', error.message);
  app.exit(1);
});
