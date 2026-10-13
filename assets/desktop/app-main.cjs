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
    typeof config.main !== 'string' ||
    !isAbsolute(config.main) ||
    typeof config.path !== 'string' ||
    !config.path ||
    (config.agentDir !== undefined && typeof config.agentDir !== 'string')
  )
    throw new Error(
      'Invalid launcher configuration. Run npm run desktop:install from the VarisDev checkout.',
    );
  // Finder starts apps without the shell's tool paths or startup files.
  process.env.PATH = config.path;
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
  await import(pathToFileURL(config.main).href);
}

// The installed app owns its sessions; reopening it should focus that runtime.
app.setName('VarisDev');
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    void app.whenReady().then(() => app.emit('activate'));
  });
  start().catch(async error => {
    console.error('Could not start VarisDev:', error);
    await app.whenReady();
    dialog.showErrorBox('Could not start VarisDev', error.message);
    app.exit(1);
  });
}
