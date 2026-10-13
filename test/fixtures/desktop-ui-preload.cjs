/* global window */
const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('pidev', {
  getState: () => ipcRenderer.invoke('fixture:state'),
  onSnapshot: callback => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('fixture:snapshot', listener);
    return () => ipcRenderer.removeListener('fixture:snapshot', listener);
  },
  removeQueuedPrompt: (sessionId, promptId) =>
    ipcRenderer.invoke('fixture:remove', sessionId, promptId),
  promptSession: (sessionId, request) =>
    ipcRenderer.invoke('fixture:prompt', sessionId, request),
  abortSession: sessionId => ipcRenderer.invoke('fixture:abort', sessionId),
  workspace: sessionId => ipcRenderer.invoke('fixture:workspace', sessionId),
  sessionFeatures: sessionId =>
    ipcRenderer.invoke('fixture:features', sessionId),
  configureSession: (sessionId, input) =>
    ipcRenderer.invoke('fixture:configure', sessionId, input),
  compactSession: (sessionId, instructions) =>
    ipcRenderer.invoke('fixture:compact', sessionId, instructions),
  reloadSession: sessionId => ipcRenderer.invoke('fixture:reload', sessionId),
  respondToDialog: (sessionId, dialogId, value) =>
    ipcRenderer.invoke('fixture:dialog', sessionId, dialogId, value),
  chooseFolder: async () => null,
  createSession: async () => {
    throw new Error('Creating sessions is outside this UI fixture');
  },
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
