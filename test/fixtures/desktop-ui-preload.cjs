/* global window */
const {contextBridge, ipcRenderer, webFrame} = require('electron');

contextBridge.exposeInMainWorld('pidev', {
  getZoom: () => webFrame.getZoomFactor(),
  setZoom: factor => webFrame.setZoomFactor(factor),
  getState: () => ipcRenderer.invoke('fixture:state'),
  onSnapshot: callback => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('fixture:snapshot', listener);
    return () => ipcRenderer.removeListener('fixture:snapshot', listener);
  },
  promptSession: (sessionId, request) =>
    ipcRenderer.invoke('fixture:prompt', sessionId, request),
  abortSession: sessionId => ipcRenderer.invoke('fixture:abort', sessionId),
  agentSession: (sessionId, request) =>
    ipcRenderer.invoke('fixture:agent-session', sessionId, request),
  cancelAgent: (sessionId, agentId) =>
    ipcRenderer.invoke('fixture:cancelAgent', sessionId, agentId),
  workspace: sessionId => ipcRenderer.invoke('fixture:workspace', sessionId),
  readMarkdown: (sessionId, path) =>
    ipcRenderer.invoke('fixture:read-markdown', sessionId, path),
  sessionFeatures: sessionId =>
    ipcRenderer.invoke('fixture:features', sessionId),
  configureSession: (sessionId, input) =>
    ipcRenderer.invoke('fixture:configure', sessionId, input),
  compactSession: (sessionId, instructions) =>
    ipcRenderer.invoke('fixture:compact', sessionId, instructions),
  reloadSession: sessionId => ipcRenderer.invoke('fixture:reload', sessionId),
  respondToDialog: (sessionId, dialogId, value) =>
    ipcRenderer.invoke('fixture:dialog', sessionId, dialogId, value),
  recentProjects: () => ipcRenderer.invoke('fixture:recent-projects'),
  chooseFolder: () => ipcRenderer.invoke('fixture:choose-folder'),
  listSessions: cwd => ipcRenderer.invoke('fixture:list-sessions', cwd),
  openWorkspaceConfiguration: cwd =>
    ipcRenderer.invoke('fixture:open-workspace-configuration', cwd),
  createSession: input => ipcRenderer.invoke('fixture:create-session', input),
  listAgentTemplates: cwd =>
    ipcRenderer.invoke('fixture:list-agent-templates', cwd),
  saveAgentTemplate: (cwd, input) =>
    ipcRenderer.invoke('fixture:save-agent-template', cwd, input),
  deleteAgentTemplate: (cwd, input) =>
    ipcRenderer.invoke('fixture:delete-agent-template', cwd, input),
  closeSession: sessionId =>
    ipcRenderer.invoke('fixture:close-session', sessionId),
});

window.addEventListener('error', event => {
  ipcRenderer.send('fixture:error', event.error?.stack || event.message);
});
window.addEventListener('unhandledrejection', event => {
  ipcRenderer.send(
    'fixture:error',
    String(event.reason?.stack || event.reason),
  );
});
