import '../runtime/settings-entry.mjs';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron';
import {isAbsolute, join} from 'node:path';
import {spawn} from 'node:child_process';
import {
  accessSync,
  closeSync,
  openSync,
  constants,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import {RuntimeManager, defaultDataDir} from '../runtime/manager.ts';
import {
  prepareWindowsLauncher,
  windowsAppId,
} from '../runtime/windows-launcher.ts';
import {
  publicUpdateStatus,
  requireUpdateRestart,
  updateMessage,
  updateRestartCommand,
} from './updates.ts';
import {SettingsManager} from '@earendil-works/pi-coding-agent';
import type {DesktopStartup} from './startup.ts';
import {desktopInitialPrompts} from '../dashboard/startup.ts';
import {fileURLToPath} from 'node:url';
import {DashboardInputError} from '../dashboard/errors.ts';
import {DashboardHub, type StoppedMessages} from '../dashboard/hub.ts';
import {createDashboardParent} from '../dashboard/parent.ts';
import type {DashboardSnapshot} from '../dashboard/state.ts';
import {ExternalSessionRequests} from './ipc.ts';
import {DesktopPreferences} from './preferences.ts';
import {DesktopTerminals} from './terminal.ts';
import {openConversationFile} from './files.ts';
import {DesktopAccounts} from './accounts.ts';
import {DesktopToolSettings} from './tool-settings.ts';
import {getToolModels, saveToolModel} from '../tools/model-selection.ts';
import {
  hasConversationImage,
  readConversationImage,
} from '../conversation-images.ts';
import type {ConversationImageResponse} from '../visualizations.ts';
import {loadPluginThemes} from './plugin-themes.ts';
import type {
  SessionFeatures,
  SessionConfiguration,
} from '../dashboard/features.ts';

app.setName('VarisDev');
if (process.platform === 'win32') app.setAppUserModelId(windowsAppId);
const terminals = new DesktopTerminals(event => {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('pidev:terminal', event);
});
const installRoot =
  process.env.VARISDEV_INSTALL_ROOT ??
  fileURLToPath(new URL('../../../../', import.meta.url));
const runtime = new RuntimeManager({
  installRoot,
  runningRoot: fileURLToPath(new URL('../../../../', import.meta.url)),
});
const profile =
  process.env.PIDEV_DESKTOP_DATA_DIR ?? join(defaultDataDir(), 'desktop');
mkdirSync(join(profile, 'temp'), {recursive: true});
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.setPath('temp', join(profile, 'temp'));
const preferences = new DesktopPreferences(profile);

const pageUrl = new URL(
  '../../../../assets/dashboard/index.html',
  import.meta.url,
);
const preloadPath = fileURLToPath(
  new URL('../../../../assets/desktop/preload.cjs', import.meta.url),
);
const iconPath = fileURLToPath(
  new URL(
    `../../../../assets/desktop/robot-crow.${process.platform === 'win32' ? 'ico' : 'png'}`,
    import.meta.url,
  ),
);
const cwdArgument = process.argv
  .find(argument => argument.startsWith('--pidev-cwd='))
  ?.slice('--pidev-cwd='.length);
const launchCwd =
  cwdArgument && isAbsolute(cwdArgument) ? cwdArgument : process.cwd();
const projectArgument = process.argv
  .find(argument => argument.startsWith('--varisdev-project='))
  ?.slice('--varisdev-project='.length);
const launchProject =
  projectArgument && isAbsolute(projectArgument) ? projectArgument : undefined;
const replacingTerminal = process.argv.includes('--pidev-startup');
const standalone = process.argv.includes('--varisdev-launcher');
const primaryInstance =
  !standalone || app.requestSingleInstanceLock({project: launchProject});
let desktopReady = false;
const pendingProjects: Array<string | undefined> = [];
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
const toolSettings = new DesktopToolSettings({
  sessionFeatures: sessionId => hub.sessionFeatures(sessionId),
});
let mainWindow: BrowserWindow | undefined;
const accounts = new DesktopAccounts({
  openBrowser: url => shell.openExternal(url),
  changed: state => {
    if (
      mainWindow &&
      !mainWindow.isDestroyed() &&
      !mainWindow.webContents.isDestroyed()
    )
      mainWindow.webContents.send('varisdev:accounts', state);
  },
});
let snapshotTimer: NodeJS.Timeout | undefined;
let shuttingDown = false;
let cleanupFinished = false;
let restarting = false;
let sessionOperations = 0;
const closingSessions = new Set<string>();
let updateTimer: NodeJS.Timeout | undefined;
const sessionActions = new Set([
  'pidev:create-session',
  'pidev:close-session',
  'pidev:prompt-session',
  'pidev:configure-session',
  'pidev:compact-session',
  'pidev:reload-session',
]);
let attachedSessionId: string | undefined;
const requests = new ExternalSessionRequests(
  request =>
    new Promise<void>((resolve, reject) => {
      if (!process.connected || !process.send) {
        reject(new Error('The attached parent session disconnected.'));
        return;
      }
      process.send(request, error => (error ? reject(error) : resolve()));
    }),
  () => !!process.connected,
);
const externalControl = {
  prompt: (sessionId: string, prompt: string) =>
    requests.request('prompt', sessionId, prompt),
  abort: (sessionId: string) =>
    requests.request<StoppedMessages>('abort', sessionId),
  cancelAgent: (sessionId: string, agentId: string) =>
    requests.request('cancelAgent', sessionId, agentId),
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
    if (!trusted(event) || shuttingDown || restarting) {
      return {ok: false, error: 'This desktop window is unavailable.'};
    }
    const sessionAction = sessionActions.has(channel);
    if (sessionAction) sessionOperations++;
    try {
      return {ok: true, value: await action(...args)};
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error && error.message
            ? updateMessage(error.message)
            : 'The request could not be completed.',
      };
    } finally {
      if (sessionAction) sessionOperations--;
    }
  });
}

function installHandlers(): void {
  handle('varisdev:get-tool-settings', sessionId =>
    toolSettings.getToolSettings(
      sessionId === undefined ? undefined : id(sessionId),
    ),
  );
  handle('varisdev:save-tool-settings', (section, value, sessionId) =>
    toolSettings.saveToolSettings(
      section,
      value,
      sessionId === undefined ? undefined : id(sessionId),
    ),
  );
  handle('varisdev:get-agent-notice', () => ({
    acknowledged: preferences.agentNoticeAcknowledged(),
  }));
  handle('varisdev:acknowledge-agent-notice', () =>
    preferences.acknowledgeAgentNotice(),
  );
  handle('varisdev:get-commit-notice', () => ({
    acknowledged: preferences.commitNoticeAcknowledged(),
  }));
  handle('varisdev:acknowledge-commit-notice', () =>
    preferences.acknowledgeCommitNotice(),
  );
  handle('varisdev:get-tool-models', getToolModels);
  handle('varisdev:save-tool-model', saveToolModel);
  handle('varisdev:get-accounts', () => accounts.get());
  handle('varisdev:account-start', (provider, method) =>
    accounts.start(provider, method),
  );
  handle('varisdev:account-respond', (attempt, prompt, value) =>
    accounts.respond(attempt, prompt, value),
  );
  handle('varisdev:account-cancel', attempt => accounts.cancel(attempt));
  handle('varisdev:account-link', (attempt, index) =>
    accounts.openLink(attempt, index),
  );
  handle('varisdev:get-update-status', () =>
    publicUpdateStatus(runtime.status()),
  );
  handle('varisdev:check-updates', async () =>
    publicUpdateStatus(await runtime.check()),
  );
  handle('varisdev:install-update', async () =>
    publicUpdateStatus(await runtime.update()),
  );
  handle('varisdev:restart-update', restartForUpdate);
  handle('varisdev:conversation-image', (imageId, variant = 'thumbnail') => {
    if (
      typeof imageId !== 'string' ||
      imageId.length > 96 ||
      (variant !== 'thumbnail' && variant !== 'full')
    )
      throw new DashboardInputError('Choose a valid conversation image.');
    if (!hasConversationImage(imageId) && attachedSessionId)
      return requests.request<ConversationImageResponse>(
        'conversationImage',
        attachedSessionId,
        {imageId, variant},
      );
    return readConversationImage(imageId, variant);
  });
  handle('varisdev:app-themes', sessionId => {
    const selected =
      sessionId === undefined
        ? undefined
        : hub
            .snapshot()
            .sessions.find(item => item.session.id === id(sessionId));
    if (sessionId !== undefined && !selected)
      throw new DashboardInputError('Choose a valid parent session.');
    return loadPluginThemes({cwd: selected?.session.cwd ?? launchCwd});
  });
  handle('pidev:get-state', () => hub.snapshot());
  handle('pidev:list-sessions', cwd => hub.listSessions(cwd));
  handle('pidev:create-session', async input => {
    const result = await hub.createSession(input);
    const cwd = hub
      .snapshot()
      .sessions.find(item => item.session.id === result.id)!.session.cwd;
    preferences.rememberFolder(cwd);
    return result;
  });
  handle('pidev:close-session', async sessionId => {
    const parentId = id(sessionId);
    closingSessions.add(parentId);
    try {
      await hub.closeSession(parentId);
      terminals.close(parentId);
    } finally {
      closingSessions.delete(parentId);
    }
  });
  handle('pidev:prompt-session', (sessionId, input) =>
    hub.promptSession(id(sessionId), input),
  );
  handle('pidev:abort-session', sessionId => hub.abortSession(id(sessionId)));
  handle('pidev:cancel-agent', (sessionId, agentId) =>
    hub.cancelAgent(id(sessionId), agentId),
  );
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
  handle('pidev:read-markdown', (sessionId, path) =>
    hub.readMarkdown(id(sessionId), path),
  );
  handle('pidev:save-markdown', (sessionId, path, content, version) =>
    hub.saveMarkdown(id(sessionId), path, content, version),
  );
  handle('pidev:open-terminal', async sessionId => {
    const parentId = id(sessionId);
    const selected = hub
      .snapshot()
      .sessions.find(item => item.session.id === parentId);
    if (!selected || closingSessions.has(parentId))
      throw new DashboardInputError('Choose an open parent session.');
    const terminal = await terminals.open(parentId, selected.session.cwd);
    if (
      closingSessions.has(parentId) ||
      !hub.snapshot().sessions.some(item => item.session.id === parentId)
    ) {
      terminals.close(parentId);
      throw new DashboardInputError('This parent session has closed.');
    }
    return terminal;
  });
  handle('pidev:terminal-write', (sessionId, data) =>
    terminals.write(id(sessionId), data),
  );
  handle('pidev:terminal-resize', (sessionId, cols, rows) =>
    terminals.resize(id(sessionId), cols, rows),
  );
  handle('pidev:terminal-close', sessionId => terminals.close(id(sessionId)));
  handle('pidev:open-file', (sessionId, path) => {
    const selected = hub
      .snapshot()
      .sessions.find(item => item.session.id === id(sessionId));
    if (!selected)
      throw new DashboardInputError('Choose a valid parent session.');
    return openConversationFile(selected.session.cwd, path, shell.openPath);
  });
  handle('pidev:choose-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Choose a project folder',
      defaultPath: preferences.folder(launchCwd),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Open folder',
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
      submenu: [{role: 'quit', label: 'Quit VarisDev'}],
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
    {
      label: 'Updates',
      submenu: [
        {
          label: 'Check for updates…',
          click: () => {
            showWindow();
            mainWindow?.webContents.send('varisdev:show-updates');
            void runtime.check().catch(() => {});
          },
        },
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
  const windowsLauncher =
    process.platform === 'win32'
      ? await prepareWindowsLauncher({
          installRoot,
          runtimeRoot: fileURLToPath(new URL('../../../../', import.meta.url)),
          profile,
          dataDir: runtime.dataDir,
          nodeExecutable: process.env.VARISDEV_NODE_EXECUTABLE,
        })
      : undefined;
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 760,
    backgroundColor: '#10171d',
    title: 'VarisDev',
    icon: iconPath,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (windowsLauncher) mainWindow.setAppDetails(windowsLauncher.appDetails);
  mainWindow.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  mainWindow.webContents.on(
    'did-start-navigation',
    (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) accounts.cancel(accounts.snapshot().attempt?.id);
    },
  );
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

async function restartForUpdate(selectedSessionId?: unknown): Promise<void> {
  const snapshot = hub.snapshot();
  const selectedId =
    selectedSessionId === undefined
      ? snapshot.selectedSessionId
      : id(selectedSessionId);
  if (
    selectedId !== undefined &&
    !snapshot.sessions.some(item => item.session.id === selectedId)
  )
    throw new DashboardInputError('Choose a valid parent session.');
  requireUpdateRestart(runtime.status(), snapshot, sessionOperations);
  if (accounts.snapshot().attempt)
    throw new Error('Finish or cancel account setup before restarting.');
  restarting = true;
  const selected = snapshot.sessions.find(
    item => item.session.id === selectedId,
  );
  const command = updateRestartCommand(
    installRoot,
    process.env.VARISDEV_NODE_EXECUTABLE,
    process.execPath,
    selected?.session.cwd,
  );
  const restartEnvironment = [
    'ELECTRON_RUN_AS_NODE',
    'VARISDEV_DESKTOP_RESTORE',
  ] as const;
  const previousEnvironment = Object.fromEntries(
    restartEnvironment.map(key => [key, process.env[key]]),
  );
  try {
    accessSync(command.executable, constants.X_OK);
    accessSync(command.args[0], constants.R_OK);
    if (
      !statSync(command.executable).isFile() ||
      !statSync(command.args[0]).isFile()
    )
      throw new Error('The VarisDev launcher is not a file.');
    const saved = hub.restartSnapshots();
    const selectedIndex = saved.findIndex(parent =>
      parent.entries.some(
        entry => entry.type === 'session' && entry.id === selectedId,
      ),
    );
    if (selectedIndex > 0) saved.unshift(...saved.splice(selectedIndex, 1));
    if (saved.length) {
      const restorePath = join(profile, 'update-restart.json');
      writeFileSync(restorePath, JSON.stringify(saved), {mode: 0o600});
      command.env.VARISDEV_DESKTOP_RESTORE = restorePath;
      command.args = [join(installRoot, 'bin', 'varisdev.mjs'), '--overview'];
    }
    requireUpdateRestart(runtime.status(), hub.snapshot(), sessionOperations);
    if (!process.env.VARISDEV_NODE_EXECUTABLE) {
      // ELECTRON_RUN_AS_NODE also affects Electron's relaunch helper. Use a
      // separate CLI process that waits until this desktop has fully exited.
      command.env.VARISDEV_RESTART_PID = String(process.pid);
      const log = openSync(join(profile, 'startup.log'), 'a');
      try {
        const child = spawn(command.executable, command.args, {
          cwd: installRoot,
          env: command.env,
          detached: true,
          stdio: ['ignore', log, log],
        });
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('spawn', resolve);
        });
        child.unref();
      } finally {
        closeSync(log);
      }
    } else {
      for (const key of restartEnvironment) {
        if (command.env[key] === undefined) delete process.env[key];
        else process.env[key] = command.env[key];
      }
      // Electron starts the original CLI only after this process has exited.
      app.relaunch({execPath: command.executable, args: command.args});
    }
    app.quit();
  } catch (error) {
    for (const key of restartEnvironment) {
      if (previousEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnvironment[key];
    }
    restarting = false;
    throw error;
  }
}

const openingProjects = new Map<string, Promise<string>>();
async function openProject(project?: string): Promise<void> {
  showWindow();
  if (!project || shuttingDown || restarting) return;
  const existing = hub
    .snapshot()
    .sessions.find(
      item => item.session.cwd === project && item.session.status !== 'closed',
    );
  let sessionId = existing?.session.id;
  if (!sessionId) {
    let opening = openingProjects.get(project);
    if (!opening) {
      sessionOperations++;
      opening = hub
        .createSession({cwd: project})
        .then(result => {
          preferences.rememberFolder(project);
          return result.id;
        })
        .finally(() => {
          sessionOperations--;
          openingProjects.delete(project);
        });
      openingProjects.set(project, opening);
    }
    sessionId = await opening;
  }
  mainWindow?.webContents.send('varisdev:select-session', sessionId);
}

app.on('second-instance', (_event, _argv, _cwd, data: unknown) => {
  const project =
    data &&
    typeof data === 'object' &&
    'project' in data &&
    typeof data.project === 'string' &&
    isAbsolute(data.project)
      ? data.project
      : undefined;
  if (!desktopReady) pendingProjects.push(project);
  else
    void openProject(project).catch(error =>
      dialog.showErrorBox(
        'Could not open project',
        updateMessage(String(error)),
      ),
    );
});

async function restoreAfterUpdate(): Promise<boolean> {
  const restorePath = process.env.VARISDEV_DESKTOP_RESTORE;
  delete process.env.VARISDEV_DESKTOP_RESTORE;
  if (!restorePath || restorePath !== join(profile, 'update-restart.json'))
    return false;
  const saved = JSON.parse(
    readFileSync(restorePath, 'utf8'),
  ) as DesktopStartup[];
  for (const startup of saved) {
    const parent = await createDashboardParent(
      {cwd: startup.cwd},
      undefined,
      startup,
    );
    hub.adoptSession(parent);
    preferences.rememberFolder(startup.cwd);
  }
  unlinkSync(restorePath);
  return saved.length > 0;
}

const unsubscribeUpdates = runtime.subscribe(status => {
  if (
    !shuttingDown &&
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed()
  ) {
    mainWindow.webContents.send(
      'varisdev:update-status',
      publicUpdateStatus(status),
    );
  }
});

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
    sessionId?: unknown;
  };
  if (payload.type === 'snapshot' && externalSnapshot(payload.snapshot)) {
    const nextId =
      payload.controllable === true ? payload.snapshot.session.id : undefined;
    if (attachedSessionId !== nextId)
      requests.disconnect('The attached parent session changed.');
    attachedSessionId = nextId;
    hub.updateExternal(payload.snapshot);
    hub.setExternalControl(nextId ? externalControl : undefined);
  } else if (
    payload.type === 'detach' &&
    payload.sessionId === attachedSessionId
  ) {
    attachedSessionId = undefined;
    requests.disconnect('The attached parent session changed.');
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
  clearInterval(updateTimer);
  unsubscribe();
  unsubscribeUpdates();
  try {
    terminals.dispose();
    await accounts.dispose();
    if (
      attachedSessionId &&
      hub
        .snapshot()
        .sessions.some(item => item.session.id === attachedSessionId)
    ) {
      try {
        await Promise.all([
          hub.abortSession(attachedSessionId),
          hub.cancelAgent(attachedSessionId, 'all'),
        ]);
      } catch (error) {
        console.error('Could not stop the attached parent session:', error);
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

if (!primaryInstance) {
  if (process.connected && process.send)
    process.send({type: 'ready'}, () => app.exit(0));
  else app.exit(0);
} else
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
          const settings = SettingsManager.create(startup.cwd);
          const prompts = await desktopInitialPrompts(
            startup.argv,
            settings.getImageAutoResize(),
          );
          hub.adoptSession(parent, prompts);
          preferences.rememberFolder(startup.cwd);
        } catch (error) {
          await parent.close();
          throw error;
        }
        process.send?.({type: 'startup-ready'});
      } else {
        const restored = await restoreAfterUpdate();
        if (launchProject && !restored) {
          await hub.createSession({cwd: launchProject});
          preferences.rememberFolder(launchProject);
        }
        if (process.connected) process.send?.({type: 'ready'});
      }
      desktopReady = true;
      for (const project of pendingProjects.splice(0))
        await openProject(project);
      if (!process.env.PI_OFFLINE) {
        void runtime.check().catch(() => {});
        updateTimer = setInterval(
          () => {
            if (['idle', 'available', 'error'].includes(runtime.status().phase))
              void runtime.check().catch(() => {});
          },
          6 * 60 * 60 * 1000,
        );
        updateTimer.unref();
      }
    })
    .catch(error => {
      console.error('Could not start VarisDev:', error);
      if (process.connected) {
        process.send?.({
          type: 'startup-error',
          error: updateMessage(
            error instanceof Error ? error.message : String(error),
          ),
        });
        app.quit();
        return;
      }
      dialog.showErrorBox(
        'VarisDev could not start',
        updateMessage(error instanceof Error ? error.message : String(error)),
      );
      app.quit();
    });
