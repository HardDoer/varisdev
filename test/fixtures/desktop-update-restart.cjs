/* global process, __dirname, setTimeout */
const assert = require('node:assert/strict');
const {readFileSync, writeFileSync} = require('node:fs');
const {join} = require('node:path');
const {pathToFileURL} = require('node:url');
const {app, BrowserWindow, ipcMain} = require('electron');
const [directory, reportPath, nodeExecutable] = process.argv.slice(2);
const root = join(__dirname, '../..');
const built = path => pathToFileURL(join(root, 'desktop/build/src', path)).href;
const report = {cases: []};
let restartHandler;
let saved = [];
let captured;
const captureError = 'Restart captured by fixture';
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => {
  if (channel === 'varisdev:restart-update') restartHandler = handler;
  originalHandle(channel, handler);
};
app.relaunch = command => {
  captured = {...command, restore: process.env.VARISDEV_DESKTOP_RESTORE};
  // Exercise the application's rollback so each case can reuse the same window.
  throw new Error(captureError);
};
async function main() {
  process.env.PI_OFFLINE = '1';
  process.env.VARISDEV_INSTALL_ROOT = root;
  process.env.VARISDEV_NODE_EXECUTABLE = nodeExecutable;
  process.env.PIDEV_DESKTOP_DATA_DIR = join(directory, 'profile');
  process.env.VARISDEV_DATA_DIR = join(directory, 'data');
  process.env.VARISDEV_SETTINGS_DIR = join(directory, 'agent');
  delete process.env.VARISDEV_DESKTOP_RESTORE;
  process.argv = [process.argv[0], process.argv[1], '--varisdev-launcher'];
  const {RuntimeManager} = await import(built('runtime/manager.js'));
  RuntimeManager.prototype.status = () => ({
    phase: 'ready',
    currentVersion: '1.0.0',
    restartRequired: true,
  });
  const {DashboardHub} = await import(built('dashboard/hub.js'));
  DashboardHub.prototype.restartSnapshots = () => saved;
  const deliverySnapshot = DashboardHub.prototype.deliverySnapshot;
  await import(built('desktop/application.js'));
  let browser;
  for (let attempt = 0; attempt < 200; attempt++) {
    browser = BrowserWindow.getAllWindows()[0];
    if (
      restartHandler &&
      browser &&
      !browser.webContents.isLoading() &&
      browser.webContents.getURL().startsWith('file:')
    )
      break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(browser, 'Application must create its desktop window');
  assert.ok(restartHandler, 'Application must register its restart handler');
  for (const hasSaved of [false, true]) {
    saved = hasSaved
      ? [{cwd: directory, entries: [{type: 'session', id: 'saved'}]}]
      : [];
    for (const backend of [undefined, 'x11', 'wayland']) {
      process.argv = [
        process.argv[0],
        process.argv[1],
        '--varisdev-launcher',
        ...(backend ? [`--ozone-platform=${backend}`] : []),
      ];
      // Environment hints must not become explicit restart arguments.
      process.env.ELECTRON_OZONE_PLATFORM_HINT = 'auto';
      process.env.WAYLAND_DISPLAY = 'wayland-fixture';
      process.env.DISPLAY = ':99';
      captured = undefined;
      DashboardHub.prototype.deliverySnapshot = function () {
        return {
          ...deliverySnapshot.call(this),
          selectedSessionId: 'saved',
          sessions: [
            {
              session: {id: 'saved', cwd: directory, status: 'idle'},
              agents: [],
            },
          ],
        };
      };
      let result;
      try {
        result = await restartHandler({
          sender: browser.webContents,
          senderFrame: browser.webContents.mainFrame,
        });
      } finally {
        DashboardHub.prototype.deliverySnapshot = deliverySnapshot;
      }
      assert.equal(result.error, captureError);
      assert.ok(captured, 'Application must prepare an Electron relaunch');
      assert.equal(captured.execPath, nodeExecutable);
      assert.deepEqual(captured.args, [
        join(root, 'bin/varisdev.mjs'),
        hasSaved ? '--overview' : directory,
        ...(backend ? [`--ozone-platform=${backend}`] : []),
      ]);
      assert.equal(
        captured.restore,
        hasSaved ? join(directory, 'profile/update-restart.json') : undefined,
      );
      if (hasSaved)
        assert.deepEqual(
          JSON.parse(readFileSync(captured.restore, 'utf8')),
          saved,
        );
      assert.equal(process.env.VARISDEV_DESKTOP_RESTORE, undefined);
      report.cases.push({hasSaved, backend: backend ?? null});
    }
  }
}
main()
  .catch(error => {
    report.error = error.stack || String(error);
  })
  .finally(() => {
    writeFileSync(reportPath, JSON.stringify(report));
    app.exit(report.error ? 1 : 0);
  });
