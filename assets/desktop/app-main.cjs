const {app, dialog} = require('electron');
const process = require('node:process');
const console = require('node:console');
const {readFileSync} = require('node:fs');
const {homedir} = require('node:os');
const {isAbsolute, join} = require('node:path');
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
    (config.agentDir !== undefined && typeof config.agentDir !== 'string')
  )
    throw new Error(
      'Invalid launcher configuration. Run varisdev app install.',
    );
  // Finder starts apps without the shell's tool paths or startup files.
  process.env.PATH = config.path;
  process.env.VARISDEV_INSTALL_ROOT = config.installRoot;
  process.env.VARISDEV_NODE_EXECUTABLE = config.nodeExecutable;
  if (config.dataDir) process.env.VARISDEV_DATA_DIR = config.dataDir;
  if (config.agentDir) process.env.PI_CODING_AGENT_DIR = config.agentDir;
  const environmentFile = join(
    homedir(),
    'Library/Application Support/VarisDev/environment.json',
  );
  let environment;
  try {
    environment = JSON.parse(readFileSync(environmentFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw new Error(`Could not read ${environmentFile}: ${error.message}`);
  }
  if (environment !== undefined) {
    if (
      !environment ||
      typeof environment !== 'object' ||
      Array.isArray(environment)
    )
      throw new Error(`${environmentFile} must contain a JSON object.`);
    for (const [key, value] of Object.entries(environment)) {
      if (typeof value !== 'string')
        throw new Error(`${environmentFile}: ${key} must be a string.`);
      process.env[key] = value;
    }
  }
  process.chdir(homedir());
  const {RuntimeManager} = await import(
    pathToFileURL(
      join(config.installRoot, 'desktop/build/src/runtime/manager.js'),
    ).href
  );
  const runtime = new RuntimeManager({installRoot: config.installRoot});
  const root = await runtime.currentRoot();
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
