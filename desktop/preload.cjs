const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dsh', {
  send: message => ipcRenderer.send('bridge:send', JSON.stringify(message)),
  openSettings: () => ipcRenderer.send('settings:open'),
  pickWorkspace: () => ipcRenderer.invoke('workspace:pick'),
  onMessage: (callback) => {
    ipcRenderer.on('bridge:message', (_event, line) => {
      try {
        callback(JSON.parse(line))
      } catch {
        // Skip malformed lines.
      }
    })
  },
})
