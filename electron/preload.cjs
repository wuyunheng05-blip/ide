const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('workspace', {
  choose: () => ipcRenderer.invoke('workspace:choose'),
  createManaged: () => ipcRenderer.invoke('workspace:create-managed'),
  refreshTree: () => ipcRenderer.invoke('workspace:refresh-tree'),
  read: (filePath) => ipcRenderer.invoke('workspace:read', filePath),
  write: (filePath, content) => ipcRenderer.invoke('workspace:write', filePath, content),
  search: (query, maxResults = 20) => ipcRenderer.invoke('workspace:search', query, maxResults),
  gitStatus: () => ipcRenderer.invoke('workspace:git-status'),
  gitDiff: (filePath = '') => ipcRenderer.invoke('workspace:git-diff', filePath),
})
contextBridge.exposeInMainWorld('ai', {
  status: () => ipcRenderer.invoke('ai:settings-status'),
  saveSettings: (settings) => ipcRenderer.invoke('ai:save-settings', settings),
  chat: (messages, sessionType = 'project', sessionKey = '') => ipcRenderer.invoke('ai:chat', { messages, sessionType, sessionKey }),
})
contextBridge.exposeInMainWorld('aiProgress', {
  onProgress: (callback) => {
    const listener = (_, progress) => callback(progress)
    ipcRenderer.on('ai:progress', listener)
    return () => ipcRenderer.removeListener('ai:progress', listener)
  },
})
contextBridge.exposeInMainWorld('aiStream', {
  onChunk: (callback) => {
    const listener = (_, chunk) => callback(chunk)
    ipcRenderer.on('ai:stream', listener)
    return () => ipcRenderer.removeListener('ai:stream', listener)
  },
})
contextBridge.exposeInMainWorld('aiActivity', {
  onActivity: (callback) => {
    const listener = (_, activity) => callback(activity)
    ipcRenderer.on('ai:activity', listener)
    return () => ipcRenderer.removeListener('ai:activity', listener)
  },
})
