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
  desktopCommand: (action, input) =>
    invoke('pidev:desktop-command', action, input),
  getZoom: () => webFrame.getZoomFactor(),
  setZoom: factor => {
    if (!Number.isFinite(factor) || factor < 0.25 || factor > 5)
      throw new TypeError('Zoom must be between 25% and 500%.');
    webFrame.setZoomFactor(factor);
  },
  getToolSettings: sessionId => invoke('varisdev:get-tool-settings', sessionId),
  saveToolSettings: (section, value, sessionId) =>
    invoke('varisdev:save-tool-settings', section, value, sessionId),
  getAgentNotice: () => invoke('varisdev:get-agent-notice'),
  acknowledgeAgentNotice: () => invoke('varisdev:acknowledge-agent-notice'),
  getCommitNotice: () => invoke('varisdev:get-commit-notice'),
  acknowledgeCommitNotice: () => invoke('varisdev:acknowledge-commit-notice'),
  getToolModels: () => invoke('varisdev:get-tool-models'),
  saveToolModel: (tool, model) =>
    invoke('varisdev:save-tool-model', tool, model),
  getAccounts: () => invoke('varisdev:get-accounts'),
  startAccount: (provider, method) =>
    invoke('varisdev:account-start', provider, method),
  respondAccount: (attempt, prompt, value) =>
    invoke('varisdev:account-respond', attempt, prompt, value),
  cancelAccount: attempt => invoke('varisdev:account-cancel', attempt),
  openAccountLink: (attempt, index) =>
    invoke('varisdev:account-link', attempt, index),
  onAccounts(callback) {
    if (typeof callback !== 'function')
      throw new TypeError('An accounts callback is required.');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('varisdev:accounts', listener);
    return () => ipcRenderer.removeListener('varisdev:accounts', listener);
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
  recentProjects: () => invoke('pidev:recent-projects'),
  listSessions: cwd => invoke('pidev:list-sessions', cwd),
  openWorkspaceConfiguration: cwd =>
    invoke('pidev:open-workspace-configuration', cwd),
  createSession: input => invoke('pidev:create-session', input),
  closeSession: id => invoke('pidev:close-session', id),
  promptSession: (id, input) => invoke('pidev:prompt-session', id, input),
  abortSession: id => invoke('pidev:abort-session', id),
  listAgentTemplates: cwd => invoke('pidev:list-agent-templates', cwd),
  saveAgentTemplate: (cwd, input) =>
    invoke('pidev:save-agent-template', cwd, input),
  deleteAgentTemplate: (cwd, input) =>
    invoke('pidev:delete-agent-template', cwd, input),
  agentSession: (sessionId, request) =>
    invoke('pidev:agent-session', sessionId, request),
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
  writeTerminal: (id, data) => invoke('pidev:terminal-write', id, data),
  resizeTerminal: (id, cols, rows) =>
    invoke('pidev:terminal-resize', id, cols, rows),
  closeTerminal: id => invoke('pidev:terminal-close', id),
  onTerminal(callback) {
    if (typeof callback !== 'function')
      throw new TypeError('A terminal callback is required.');
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('pidev:terminal', listener);
    return () => ipcRenderer.removeListener('pidev:terminal', listener);
  },
  openFile: (id, path) => invoke('pidev:open-file', id, path),
  readMarkdown: (sessionId, path) =>
    invoke('pidev:read-markdown', sessionId, path),
  saveMarkdown: (sessionId, path, content, version) =>
    invoke('pidev:save-markdown', sessionId, path, content, version),
  chooseFolder: () => invoke('pidev:choose-folder'),
});
