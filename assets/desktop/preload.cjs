'use strict';

const {contextBridge, ipcRenderer, webFrame} = require('electron');

async function invoke(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result || result.ok !== true) {
    throw new Error(
      typeof result?.error === 'string'
        ? result.error
        : 'The desktop request failed.',
    );
  }
  return result.value;
}

contextBridge.exposeInMainWorld('pidev', {
  getZoom: () => webFrame.getZoomFactor(),
  setZoom: factor => {
    if (!Number.isFinite(factor) || factor < 0.25 || factor > 5)
      throw new TypeError('Zoom must be between 25% and 500%.');
    webFrame.setZoomFactor(factor);
  },
  getUpdateStatus: () => invoke('varisdev:get-update-status'),
  checkUpdates: () => invoke('varisdev:check-updates'),
  installUpdate: () => invoke('varisdev:install-update'),
  restartUpdate: sessionId => invoke('varisdev:restart-update', sessionId),
  onUpdateStatus(callback) {
    if (typeof callback !== 'function')
      throw new TypeError('An update callback is required.');
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('varisdev:update-status', listener);
    return () => ipcRenderer.removeListener('varisdev:update-status', listener);
  },
  onShowUpdates(callback) {
    if (typeof callback !== 'function')
      throw new TypeError('An updates callback is required.');
    const listener = () => callback();
    ipcRenderer.on('varisdev:show-updates', listener);
    return () => ipcRenderer.removeListener('varisdev:show-updates', listener);
  },
  onSelectSession(callback) {
    if (typeof callback !== 'function')
      throw new TypeError('A parent session callback is required.');
    const listener = (_event, id) => callback(id);
    ipcRenderer.on('varisdev:select-session', listener);
    return () =>
      ipcRenderer.removeListener('varisdev:select-session', listener);
  },
  conversationImage: (imageId, variant = 'thumbnail') =>
    invoke('varisdev:conversation-image', imageId, variant),
  appThemes: sessionId => invoke('varisdev:app-themes', sessionId),
  getState: () => invoke('pidev:get-state'),
  onSnapshot(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('A snapshot callback is required.');
    }
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('pidev:snapshot', listener);
    return () => ipcRenderer.removeListener('pidev:snapshot', listener);
  },
  createSession: input => invoke('pidev:create-session', input),
  promptSession: (id, input) => invoke('pidev:prompt-session', id, input),
  abortSession: id => invoke('pidev:abort-session', id),
  cancelAgent: (sessionId, agentId) =>
    invoke('pidev:cancel-agent', sessionId, agentId),
  respondToDialog: (sessionId, dialogId, value) =>
    invoke('pidev:respond-to-dialog', sessionId, dialogId, value),
  sessionFeatures: id => invoke('pidev:session-features', id),
  configureSession: (id, input) => invoke('pidev:configure-session', id, input),
  compactSession: (id, instructions) =>
    invoke('pidev:compact-session', id, instructions),
  reloadSession: id => invoke('pidev:reload-session', id),
  workspace: id => invoke('pidev:workspace', id),
  openTerminal: id => invoke('pidev:open-terminal', id),
  readMarkdown: (sessionId, path) =>
    invoke('pidev:read-markdown', sessionId, path),
  saveMarkdown: (sessionId, path, content, version) =>
    invoke('pidev:save-markdown', sessionId, path, content, version),
  chooseFolder: () => invoke('pidev:choose-folder'),
});
