/* global process, document */
const assert = require('node:assert/strict');
const {writeFileSync} = require('node:fs');
const {join} = require('node:path');
const {pathToFileURL} = require('node:url');
const {setTimeout: delay} = require('node:timers/promises');
const {app, BrowserWindow} = require('electron');
const [directory, modulePath, reportPath] = process.argv.slice(2);
app.setPath('userData', join(directory, 'profile'));
let window;
let delivery;
const report = {};
async function until(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error('Window state did not settle within five seconds');
}

app.whenReady().then(async () => {
  try {
    const {DesktopSnapshotDelivery} = await import(pathToFileURL(modulePath));
    let changed;
    let revision = 0;
    let builds = 0;
    delivery = new DesktopSnapshotDelivery({
      subscribe(listener) {
        changed = listener;
        return () => {
          changed = undefined;
        };
      },
      deliverySnapshot() {
        builds++;
        return {sessions: [], revision};
      },
    });
    window = new BrowserWindow({
      show: false,
      width: 400,
      height: 300,
      webPreferences: {nodeIntegration: true, contextIsolation: false},
    });
    const page = join(directory, 'delivery.html');
    writeFileSync(
      page,
      `<!doctype html><title>Snapshot delivery check</title>
      <p>Checking background updates</p><script>
      globalThis.received = [];
      require('electron').ipcRenderer.on('pidev:snapshot', (_event, snapshot) => {
        received.push(snapshot.revision);
        document.querySelector('p').textContent = String(snapshot.revision);
      });</script>`,
    );
    await window.loadFile(page);
    delivery.attach(window);
    const receive = () =>
      window.webContents.executeJavaScript('globalThis.received');
    for (revision = 1; revision < 101; revision++) changed();
    revision = 100;
    await delay(160);
    assert.equal(builds, 0);
    window.showInactive();
    delivery.refresh();
    await until(async () => (await receive()).length === 1);
    assert.deepEqual(await receive(), [100]);
    revision = 101;
    changed();
    window.hide();
    await until(() => !window.isVisible());
    for (revision = 102; revision < 201; revision++) changed();
    revision = 200;
    await delay(160);
    assert.equal(builds, 1);
    window.showInactive();
    delivery.refresh();
    await until(async () => (await receive()).length === 2);
    assert.deepEqual(await receive(), [100, 200]);
    assert.equal(builds, 2);
    revision = 201;
    changed();
    delivery.dispose();
    await delay(160);
    assert.deepEqual(await receive(), [100, 200]);
    report.builds = builds;
    report.received = await receive();
  } catch (error) {
    report.error = error.stack || String(error);
    process.exitCode = 1;
  } finally {
    delivery?.dispose();
    window?.destroy();
    writeFileSync(reportPath, JSON.stringify(report));
    app.exit(process.exitCode || 0);
  }
});
