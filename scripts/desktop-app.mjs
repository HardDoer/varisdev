import {execFileSync} from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import {createRequire} from 'node:module';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, URL} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const destination = join(homedir(), 'Applications/VarisDev.app');
const command = process.argv[2];

function run(executable, args) {
  return execFileSync(executable, args, {encoding: 'utf8', stdio: 'pipe'});
}

function checkNotRunning() {
  const executable = join(destination, 'Contents/MacOS') + '/';
  const pattern = `^${executable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(Electron|VarisDev)( |$)`;
  try {
    run('/usr/bin/pgrep', ['-f', pattern]);
  } catch (error) {
    if (error.status === 1) return;
    throw error;
  }
  const error = new Error('Quit VarisDev before reinstalling it.');
  error.code = 'APP_RUNNING';
  throw error;
}

function install() {
  const electron = require('electron');
  const source = join(dirname(electron), '../..');
  const main = join(root, 'desktop/build/src/desktop/main.js');
  if (!existsSync(main))
    throw new Error('The app build is missing. Reinstall VarisDev.');
  if (existsSync(destination)) {
    const marker = join(destination, 'Contents/Resources/app/launch.json');
    if (!existsSync(marker))
      throw new Error(
        `${destination} already exists and was not installed by this script.`,
      );
    // Do not replace files beneath a running application.
    checkNotRunning();
  }
  mkdirSync(dirname(destination), {recursive: true});
  const temporary = mkdtempSync(join(dirname(destination), '.varisdev-'));
  const staged = join(temporary, 'VarisDev.app');
  const previous = join(temporary, 'Previous.app');
  try {
    // Reuse the installed runtime, including its framework symlinks and helpers.
    run('/usr/bin/ditto', [source, staged]);
    const resources = join(staged, 'Contents/Resources');
    const appDirectory = join(resources, 'app');
    mkdirSync(appDirectory);
    rmSync(join(resources, 'default_app.asar'), {force: true});
    copyFileSync(
      join(root, 'assets/desktop/app-main.cjs'),
      join(appDirectory, 'main.cjs'),
    );
    copyFileSync(
      join(root, 'assets/desktop/robot-crow.icns'),
      join(resources, 'varisdev.icns'),
    );
    const {version} = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    );
    writeFileSync(
      join(appDirectory, 'package.json'),
      JSON.stringify(
        {
          name: 'varisdev',
          productName: 'VarisDev',
          version,
          main: 'main.cjs',
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(appDirectory, 'launch.json'),
      JSON.stringify(
        {
          installRoot: process.env.VARISDEV_INSTALL_ROOT || root,
          runtimeRoot: resolve(root),
          nodeExecutable:
            process.env.VARISDEV_NODE_EXECUTABLE || process.execPath,
          dataDir: process.env.VARISDEV_DATA_DIR,
          path: [
            ...new Set([
              dirname(process.execPath),
              ...(process.env.PATH || '').split(':').filter(Boolean),
              '/usr/bin',
              '/bin',
              '/usr/sbin',
              '/sbin',
            ]),
          ].join(':'),
          agentDir: process.env.PI_CODING_AGENT_DIR,
        },
        null,
        2,
      ),
    );
    renameSync(
      join(staged, 'Contents/MacOS/Electron'),
      join(staged, 'Contents/MacOS/VarisDev'),
    );
    const plist = join(staged, 'Contents/Info.plist');
    for (const [key, value] of Object.entries({
      CFBundleIdentifier: 'com.varisware.varisdev',
      CFBundleExecutable: 'VarisDev',
      CFBundleName: 'VarisDev',
      CFBundleDisplayName: 'VarisDev',
      CFBundleIconFile: 'varisdev.icns',
      CFBundleVersion: version,
      CFBundleShortVersionString: version,
    }))
      run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
    run('/usr/libexec/PlistBuddy', [
      '-c',
      'Delete :ElectronAsarIntegrity',
      plist,
    ]);
    run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', staged]);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]);
    if (existsSync(destination)) {
      checkNotRunning();
      renameSync(destination, previous);
    }
    try {
      renameSync(staged, destination);
    } catch (error) {
      if (existsSync(previous)) renameSync(previous, destination);
      throw error;
    }
    console.log(
      `Installed ${destination}\nOpen VarisDev from Finder, Spotlight, or the Dock.`,
    );
  } finally {
    rmSync(temporary, {recursive: true, force: true});
  }
}

try {
  if (process.platform !== 'darwin')
    throw new Error(
      'The app launcher installer currently supports macOS. Run varisdev to open the app on this platform.',
    );
  if (command === 'install') install();
  else if (command === 'open') {
    if (!existsSync(destination))
      throw new Error('Run varisdev app install first.');
    run('/usr/bin/open', [destination]);
  } else throw new Error('Usage: node scripts/desktop-app.mjs install|open');
} catch (error) {
  console.error(error.message);
  process.exitCode = error.code === 'APP_RUNNING' ? 2 : 1;
}
