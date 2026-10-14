/* global window */
const {contextBridge, ipcRenderer, webFrame} = require('electron');
contextBridge.exposeInMainWorld('pidev', {
  getZoom: () => webFrame.getZoomFactor(),
  setZoom: value => webFrame.setZoomFactor(value),
  getState: () => ipcRenderer.invoke('visualization:state'),
  onSnapshot(callback) {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('visualization:snapshot', listener);
    return () => ipcRenderer.removeListener('visualization:snapshot', listener);
  },
  conversationImage: (id, variant) =>
    ipcRenderer.invoke('visualization:image', id, variant),
  abortSession: id => ipcRenderer.invoke('visualization:abort', id),
});
window.addEventListener('error', event =>
  ipcRenderer.send('visualization:error', event.error?.stack || event.message),
);
window.addEventListener('unhandledrejection', event =>
  ipcRenderer.send(
    'visualization:error',
    String(event.reason?.stack || event.reason),
  ),
);
