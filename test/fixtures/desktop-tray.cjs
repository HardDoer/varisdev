/* global process, __dirname, setTimeout, clearTimeout, clearInterval, console */
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {readFileSync, writeFileSync} = require('node:fs');
const {join} = require('node:path');
const {pathToFileURL} = require('node:url');
const vm = require('node:vm');
const ts = require('typescript');
const {app, BrowserWindow, Menu, Tray, nativeImage} = require('electron');
const [directory, reportPath, modulePath] = process.argv.slice(2);
app.setPath('userData', join(directory, 'profile'));
const report = {cases: []};
let window;
let tray;
let menu;
let tooltip;
let closedSessions = 0;
let releaseSessions;
let quitting = false;

async function waitFor(condition) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(
    `Timed out waiting for desktop tray state: ${JSON.stringify({
      destroyed: window.isDestroyed(),
      visible: !window.isDestroyed() && window.isVisible(),
      minimized: !window.isDestroyed() && window.isMinimized(),
      events: report.events,
    })}`,
  );
}

async function main() {
  const {DesktopTray} = await import(pathToFileURL(modulePath));
  await app.whenReady();
  window = new BrowserWindow({show: false, width: 800, height: 600});
  report.events = [];
  for (const event of [
    'ready-to-show',
    'show',
    'hide',
    'close',
    'minimize',
    'restore',
  ])
    window.on(event, () => report.events.push(event));
  await window.loadURL('data:text/html,<title>VarisDev tray fixture</title>');
  // The bounded process runner starts Windows children with SW_HIDE, which
  // overrides their first native ShowWindow call.
  window.showInactive();
  window.hide();
  const events = new EventEmitter();
  const states = [];
  const source = readFileSync(
    join(__dirname, '../../src/desktop/application.ts'),
    'utf8',
  );
  const parsed = ts.createSourceFile(
    'application.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const pieces = [];
  for (const statement of parsed.statements) {
    if (statement.getText(parsed).startsWith("app.on('before-quit',"))
      pieces.push(statement.getText(parsed));
    if (!ts.isFunctionDeclaration(statement)) continue;
    const name = statement.name?.text;
    if (['showWindow', 'installTray', 'shutdown'].includes(name))
      pieces.push(statement.getText(parsed));
    if (name === 'createWindow') {
      const close = statement.body.statements.find(item =>
        item.getText(parsed).startsWith("mainWindow.on('close',"),
      );
      assert.ok(close);
      pieces.push(close.getText(parsed));
    }
  }
  assert.equal(pieces.length, 5);
  const context = {
    app,
    mainWindow: window,
    desktopTray: undefined,
    DesktopTray,
    Menu: {
      buildFromTemplate(template) {
        menu = Menu.buildFromTemplate(template);
        return menu;
      },
    },
    Tray: function (icon) {
      tray = new Tray(icon);
      const setToolTip = tray.setToolTip.bind(tray);
      tray.setToolTip = value => {
        tooltip = value;
        setToolTip(value);
      };
      return tray;
    },
    nativeImage,
    iconPath: join(
      __dirname,
      `../../assets/desktop/robot-crow.${process.platform === 'win32' ? 'ico' : 'png'}`,
    ),
    process,
    console,
    hub: {
      workStates: () => states,
      subscribe: listener => {
        events.on('change', listener);
        return () => events.off('change', listener);
      },
      close: async () => {
        closedSessions++;
        await new Promise(resolve => {
          releaseSessions = resolve;
        });
      },
    },
    shuttingDown: false,
    cleanupFinished: false,
    snapshotDelivery: {refresh: () => {}, dispose: () => {}},
    updateTimer: undefined,
    clearTimeout,
    clearInterval,
    unsubscribe: () => {},
    unsubscribeUpdates: () => {},
    completionSound: {dispose: () => {}},
    runtime: {waitForUpdate: async () => {}},
    terminals: {dispose: () => {}},
    accounts: {dispose: async () => {}},
    requests: {disconnect: () => {}},
    attachedSessionId: undefined,
  };
  vm.createContext(context);
  vm.runInContext(
    ts.transpileModule(pieces.join('\n') + '\ninstallTray(); showWindow();', {
      compilerOptions: {target: ts.ScriptTarget.ES2024},
    }).outputText,
    context,
  );
  assert.ok(context.desktopTray?.isAvailable());
  await waitFor(() => window.isVisible());
  assert.equal(tooltip, 'VarisDev — No open workspaces');
  window.close();
  await waitFor(() => !window.isVisible());
  assert.equal(window.isDestroyed(), false);
  assert.equal(closedSessions, 0);
  report.cases.push(
    'native close hides the window while keeping sessions alive',
  );

  states.push({status: 'running', agents: ['queued'], awaitingInput: false});
  events.emit('change');
  assert.equal(tooltip, 'VarisDev — Working: 1 · Queued: 1');
  assert.equal(menu.items[0].label, 'Working: 1 · Queued: 1');
  assert.equal(menu.items[0].enabled, false);
  report.cases.push('hidden work updates native tooltip and context menu');

  menu.items.find(item => item.label === 'Open VarisDev').click();
  await waitFor(() => window.isVisible());
  window.minimize();
  await waitFor(() => window.isMinimized());
  tray.emit('click');
  await waitFor(() => window.isVisible() && !window.isMinimized());
  window.close();
  tray.emit('double-click');
  await waitFor(() => window.isVisible());
  report.cases.push('menu and tray activation restore the existing window');

  window.close();
  menu.items.find(item => item.label === 'Quit VarisDev').click();
  await waitFor(() => !!releaseSessions);
  assert.equal(tray.isDestroyed(), true);
  assert.equal(window.isDestroyed(), false);
  assert.equal(closedSessions, 1);
  assert.equal(events.listenerCount('change'), 0);
  report.cases.push(
    'tray quit waits for session cleanup and releases its resources',
  );
  quitting = true;
  writeFileSync(reportPath, JSON.stringify(report));
  releaseSessions();
}

app.on('will-quit', () => {
  if (!quitting) return;
  assert.equal(window.isDestroyed(), true);
});
main().catch(error => {
  report.fatal = error.stack;
  writeFileSync(reportPath, JSON.stringify(report));
  tray?.destroy();
  app.exit(1);
});
