const { contextBridge, ipcRenderer } = require('electron');
// The only messages the overlay page can send to, and receive from, the app.
contextBridge.exposeInMainWorld('pen', {
  send: (channel, data) => { if (['pen-toggle', 'mouse', 'page'].includes(channel)) ipcRenderer.send(channel, data); },
  on: callback => ipcRenderer.on('msg', (_event, message) => callback(message))
});
