'use strict';

const {contextBridge, ipcRenderer} = require('electron');

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
  workspace: id => invoke('pidev:workspace', id),
  chooseFolder: () => invoke('pidev:choose-folder'),
});
