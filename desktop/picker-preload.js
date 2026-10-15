const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  sources: () => ipcRenderer.invoke('picker-sources'),
  choose: (id) => ipcRenderer.send('picker-choose', id),
});
