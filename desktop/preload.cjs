const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dsh', {
  send: message => ipcRenderer.send('bridge:send', JSON.stringify(message)),
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
