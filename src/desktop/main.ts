import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron';
import {isAbsolute, join} from 'node:path';
import {mkdirSync} from 'node:fs';
import {SettingsManager} from '@earendil-works/pi-coding-agent';
import type {DesktopStartup} from './startup.ts';
import {desktopInitialPrompts} from '../dashboard/startup.ts';
import {fileURLToPath} from 'node:url';
import {DashboardInputError} from '../dashboard/errors.ts';
import {DashboardHub, isQueuedPrompts} from '../dashboard/hub.ts';
import {createDashboardParent} from '../dashboard/parent.ts';
import type {DashboardSnapshot} from '../dashboard/state.ts';
import {ExternalSessionRequests, requestId} from './ipc.ts';
import type {
  SessionFeatures,
  SessionConfiguration,
} from '../dashboard/features.ts';

app.setName('VarisDev Factory');
// Keep this checkout's Electron data alongside the application.
const profile =
  process.env.PIDEV_DESKTOP_DATA_DIR ??
  fileURLToPath(new URL('../../../../.pi/desktop/', import.meta.url));
mkdirSync(join(profile, 'temp'), {recursive: true});
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.setPath('temp', join(profile, 'temp'));

const pageUrl = new URL(
  '../../../../assets/dashboard/index.html',
  import.meta.url,
);
const preloadPath = fileURLToPath(
  new URL('../../../../assets/desktop/preload.cjs', import.meta.url),
);
const iconPath = fileURLToPath(
  new URL('../../../../assets/desktop/robot-crow.png', import.meta.url),
);
const cwdArgument = process.argv
  .find(argument => argument.startsWith('--pidev-cwd='))
  ?.slice('--pidev-cwd='.length);
const launchCwd =
  cwdArgument && isAbsolute(cwdArgument) ? cwdArgument : process.cwd();
const replacingTerminal = process.argv.includes('--pidev-startup');
let receiveStartup: ((startup: DesktopStartup) => void) | undefined;
const startupRequest = replacingTerminal
  ? new Promise<DesktopStartup>(resolve => {
      receiveStartup = resolve;
    })
  : undefined;
const hub = new DashboardHub(
  undefined,
  request => createDashboardParent(request),
  launchCwd,
);
let mainWindow: BrowserWindow | undefined;
let snapshotTimer: NodeJS.Timeout | undefined;
let shuttingDown = false;
let cleanupFinished = false;
let attachedSessionId: string | undefined;
const requests = new ExternalSessionRequests(
  request =>
    new Promise<void>((resolve, reject) => {
      if (!process.connected || !process.send) {
        reject(new Error('The attached Pi session disconnected.'));
        return;
      }
      process.send(request, error => (error ? reject(error) : resolve()));
    }),
  () => !!process.connected,
);
const externalControl = {
  prompt: (sessionId: string, prompt: string) =>
    requests.request('prompt', sessionId, prompt),
  abort: (sessionId: string) => requests.request('abort', sessionId),
  removeQueuedPrompt: (sessionId: string, promptId: string) =>
    requests.request('removeQueuedPrompt', sessionId, promptId),
  features: (sessionId: string) =>
    requests.request<SessionFeatures>('features', sessionId),
  configure: (sessionId: string, input: SessionConfiguration) =>
    requests.request('configure', sessionId, input),
  compact: (sessionId: string, instructions?: string) =>
    requests.request('compact', sessionId, instructions),
  reload: (sessionId: string) => requests.request('reload', sessionId),
};

function isLocalPage(url: string): boolean {
  try {
    const target = new URL(url);
    target.hash = '';
    return target.href === pageUrl.href;
  } catch {
    return false;
  }
}

function trusted(event: IpcMainInvokeEvent): boolean {
  return (
    !!mainWindow &&
    !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame &&
    isLocalPage(event.senderFrame.url)
  );
}

function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256) {
    throw new DashboardInputError('Choose a valid parent session.');
  }
  return value;
}

function handle(
  channel: string,
  action: (...args: unknown[]) => unknown,
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    if (!trusted(event) || shuttingDown) {
      return {ok: false, error: 'This desktop window is unavailable.'};
    }
    try {
      return {ok: true, value: await action(...args)};
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error && error.message
            ? error.message.slice(0, 2000)
            : 'The request could not be completed.',
      };
    }
  });
}

function installHandlers(): void {
  handle('pidev:get-state', () => hub.snapshot());
  handle('pidev:create-session', input => hub.createSession(input));
  handle('pidev:prompt-session', (sessionId, input) =>
    hub.promptSession(id(sessionId), input),
  );
  handle('pidev:abort-session', sessionId => hub.abortSession(id(sessionId)));
  handle('pidev:remove-queued-prompt', (sessionId, promptId) => {
    if (!requestId(promptId))
      throw new DashboardInputError('Choose a valid queued prompt.');
    return hub.removeQueuedPrompt(id(sessionId), promptId);
  });
  handle('pidev:respond-to-dialog', (sessionId, dialogId, value) =>
    hub.respondToDialog(id(sessionId), dialogId, value),
  );
  handle('pidev:session-features', sessionId =>
    hub.sessionFeatures(id(sessionId)),
  );
  handle('pidev:configure-session', (sessionId, input) =>
    hub.configureSession(id(sessionId), input),
  );
  handle('pidev:compact-session', (sessionId, instructions) =>
    hub.compactSession(id(sessionId), instructions),
  );
  handle('pidev:reload-session', sessionId => hub.reloadSession(id(sessionId)));
  handle('pidev:workspace', sessionId => hub.workspace(id(sessionId)));
  handle('pidev:choose-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Choose a project folder',
      defaultPath: launchCwd,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Choose folder',
    });
    return result.canceled ? undefined : result.filePaths[0];
  });
}

function installMenu(): void {
  const menu: MenuItemConstructorOptions[] = [];
  if (process.platform === 'darwin') menu.push({role: 'appMenu'});
  menu.push(
    {
      label: 'File',
      submenu: [{role: 'quit', label: 'Quit VarisDev Factory'}],
    },
    {role: 'editMenu'},
    {
      label: 'View',
      submenu: [
        {role: 'reload'},
        {type: 'separator'},
        {role: 'resetZoom'},
        {role: 'zoomIn'},
        {role: 'zoomOut'},
        {type: 'separator'},
        {role: 'togglefullscreen'},
      ],
    },
    {role: 'windowMenu'},
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 760,
    backgroundColor: '#10171d',
    title: 'VarisDev Factory',
    icon: iconPath,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isLocalPage(url)) event.preventDefault();
  });
  mainWindow.webContents.on('will-frame-navigate', event => {
    if (!event.isMainFrame || !isLocalPage(event.url)) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', event =>
    event.preventDefault(),
  );
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.on('page-title-updated', event => event.preventDefault());
  mainWindow.on('close', event => {
    if (!cleanupFinished) {
      event.preventDefault();
      app.quit();
    }
  });
  mainWindow.once('ready-to-show', showWindow);
  mainWindow.once('closed', () => {
    mainWindow = undefined;
  });
  await mainWindow.loadFile(fileURLToPath(pageUrl));
}

const unsubscribe = hub.subscribe(() => {
  if (shuttingDown || snapshotTimer) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = undefined;
    if (
      mainWindow &&
      !mainWindow.isDestroyed() &&
      !mainWindow.webContents.isDestroyed()
    ) {
      mainWindow.webContents.send('pidev:snapshot', hub.snapshot());
    }
  }, 80);
  snapshotTimer.unref();
});

function externalSnapshot(value: unknown): value is DashboardSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<DashboardSnapshot>;
  return (
    !!snapshot.session &&
    typeof snapshot.session.id === 'string' &&
    typeof snapshot.session.name === 'string' &&
    typeof snapshot.session.cwd === 'string' &&
    Array.isArray(snapshot.agents) &&
    Array.isArray(snapshot.events) &&
    Array.isArray(snapshot.changes)
  );
}

process.on('message', (message: unknown) => {
  // Shutdown can be waiting for the attached session's abort reply.
  if (requests.reply(message)) return;
  if (shuttingDown || !message || typeof message !== 'object') return;
  if (
    'type' in message &&
    message.type === 'startup' &&
    'startup' in message &&
    receiveStartup
  ) {
    receiveStartup(message.startup as DesktopStartup);
    receiveStartup = undefined;
    return;
  }
  const payload = message as {
    type?: unknown;
    snapshot?: unknown;
    controllable?: unknown;
    queuedPrompts?: unknown;
    sessionId?: unknown;
  };
  if (
    payload.type === 'snapshot' &&
    externalSnapshot(payload.snapshot) &&
    isQueuedPrompts(payload.queuedPrompts)
  ) {
    const nextId =
      payload.controllable === true ? payload.snapshot.session.id : undefined;
    if (attachedSessionId !== nextId)
      requests.disconnect('The attached Pi session changed.');
    attachedSessionId = nextId;
    hub.updateExternal(payload.snapshot, payload.queuedPrompts);
    hub.setExternalControl(nextId ? externalControl : undefined);
  } else if (
    payload.type === 'detach' &&
    payload.sessionId === attachedSessionId
  ) {
    attachedSessionId = undefined;
    requests.disconnect('The attached Pi session changed.');
    hub.closeExternal();
  } else if (payload.type === 'show') {
    showWindow();
  } else if (payload.type === 'close') {
    app.quit();
  }
});
process.on('disconnect', () => {
  attachedSessionId = undefined;
  requests.disconnect();
  hub.closeExternal();
});

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(snapshotTimer);
  unsubscribe();
  try {
    if (attachedSessionId) {
      try {
        await hub.abortSession(attachedSessionId);
      } catch (error) {
        console.error('Could not stop the attached Pi session:', error);
      }
    }
    await hub.close();
  } catch (error) {
    console.error('Could not finish closing dashboard sessions:', error);
  } finally {
    requests.disconnect('The factory window closed.');
    cleanupFinished = true;
    app.quit();
  }
}

app.on('before-quit', event => {
  if (!cleanupFinished) {
    event.preventDefault();
    void shutdown();
  }
});
app.on('window-all-closed', () => app.quit());
app.on('activate', showWindow);

void app
  .whenReady()
  .then(async () => {
    app.dock?.setIcon(iconPath);
    installHandlers();
    installMenu();
    await createWindow();
    if (startupRequest) {
      process.send?.({type: 'startup-request'});
      const startup = await startupRequest;
      const parent = await createDashboardParent(
        {cwd: startup.cwd},
        undefined,
        startup,
      );
      try {
        const settings = SettingsManager.create(startup.cwd, startup.agentDir);
        const prompts = await desktopInitialPrompts(
          startup.argv,
          settings.getImageAutoResize(),
        );
        hub.adoptSession(parent, prompts);
      } catch (error) {
        await parent.close();
        throw error;
      }
      process.send?.({type: 'startup-ready'});
    } else if (process.connected) process.send?.({type: 'ready'});
  })
  .catch(error => {
    console.error('Could not start VarisDev Factory:', error);
    if (replacingTerminal && process.connected) {
      process.send?.({
        type: 'startup-error',
        error: error instanceof Error ? error.message : String(error),
      });
      app.quit();
      return;
    }
    dialog.showErrorBox(
      'VarisDev could not start',
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
  });
