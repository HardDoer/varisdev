/* global process, setTimeout, __dirname */
const {app} = require('electron');
const {writeFileSync, appendFileSync} = require('node:fs');
const {join} = require('node:path');
const {spawn} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const [directory, reportPath, nodeExecutable, mode = 'node'] =
  process.argv.slice(2);
const marker = join(directory, 'shutdown.txt');
const target = join(directory, 'replacement.cjs');
app.setPath('userData', join(directory, 'profile'));
writeFileSync(
  target,
  `
  const {readFileSync, writeFileSync} = require('node:fs');
  (async () => {
  if (process.env.VARISDEV_RESTART_PID) {
    const {waitForPreviousDesktop} = await import(${JSON.stringify(pathToFileURL(join(__dirname, '../../desktop/build/src/runtime/cli.js')).href)});
    await waitForPreviousDesktop();
  }
  let oldAlive = true;
  try { process.kill(${process.pid}, 0); } catch { oldAlive = false; }
  writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({
    oldAlive,
    shutdown: readFileSync(${JSON.stringify(marker)}, 'utf8'),
    restore: process.env.VARISDEV_DESKTOP_RESTORE,
    runAsNode: process.env.ELECTRON_RUN_AS_NODE
  }));
  })().catch(error => { writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({error: error.message})); process.exit(1); });
`,
);
let closed = false;
app.on('before-quit', event => {
  if (closed) return;
  event.preventDefault();
  setTimeout(() => {
    writeFileSync(marker, 'sessions closed\n');
    closed = true;
    app.quit();
  }, 80);
});
process.on('exit', () => appendFileSync(marker, 'process exited\n'));
app.whenReady().then(() => {
  delete process.env.ELECTRON_RUN_AS_NODE;
  process.env.VARISDEV_DESKTOP_RESTORE = join(directory, 'update-restart.json');
  if (mode === 'electron') {
    const child = spawn(process.execPath, [target], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        VARISDEV_RESTART_PID: String(process.pid),
      },
      detached: true,
      stdio: 'ignore',
    });
    child.once('spawn', () => {
      child.unref();
      app.quit();
    });
    child.once('error', error => {
      writeFileSync(reportPath, JSON.stringify({error: error.message}));
      app.exit(1);
    });
  } else {
    app.relaunch({execPath: nodeExecutable, args: [target]});
    app.quit();
  }
});
