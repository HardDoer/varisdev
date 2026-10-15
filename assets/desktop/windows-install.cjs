const {app, shell} = require('electron');
const process = require('node:process');
const console = require('node:console');
const {mkdirSync} = require('node:fs');
const {homedir} = require('node:os');
const {join, resolve} = require('node:path');
const {pathToFileURL} = require('node:url');

const dataDir = process.env.VARISDEV_DATA_DIR
  ? resolve(process.env.VARISDEV_DATA_DIR)
  : join(
      process.env.LOCALAPPDATA || join(homedir(), 'AppData/Local'),
      'VarisDev',
    );
const profile = process.env.PIDEV_DESKTOP_DATA_DIR || join(dataDir, 'desktop');
const installerProfile = join(profile, 'windows-launcher/installer');
mkdirSync(installerProfile, {recursive: true});
app.setPath('userData', installerProfile);
app.setName('VarisDev');

async function install() {
  const [installRoot, runtimeRoot] = process.argv.slice(2);
  const {prepareWindowsLauncher, windowsAppId} = await import(
    pathToFileURL(
      join(runtimeRoot, 'desktop/build/src/runtime/windows-launcher.js'),
    ).href
  );
  app.setAppUserModelId(windowsAppId);
  await app.whenReady();
  const {shortcut} = await prepareWindowsLauncher({
    installRoot,
    runtimeRoot,
    dataDir,
    profile,
    nodeExecutable: process.env.VARISDEV_NODE_EXECUTABLE,
  });
  const directory = join(
    process.env.APPDATA || join(homedir(), 'AppData/Roaming'),
    'Microsoft/Windows/Start Menu/Programs',
  );
  mkdirSync(directory, {recursive: true});
  const destination = join(directory, 'VarisDev.lnk');
  if (!shell.writeShortcutLink(destination, 'create', shortcut))
    throw new Error(`Could not create ${destination}`);
  console.log(`Installed ${destination}`);
  app.quit();
}

install().catch(error => {
  console.error(error.message);
  app.exit(1);
});
