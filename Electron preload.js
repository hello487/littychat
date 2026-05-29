const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    minimize: () => ipcRenderer.invoke('window-minimize'),
    maximize: () => ipcRenderer.invoke('window-maximize'),
    close: () => ipcRenderer.invoke('window-close'),
    
    saveAvatar: (userId, buffer) => ipcRenderer.invoke('save-avatar', { userId, buffer }),
    getAvatarPath: (userId) => ipcRenderer.invoke('get-avatar-path', userId),
    
    dbQuery: (sql, params) => ipcRenderer.invoke('db-query', { sql, params }),
    dbRun: (sql, params) => ipcRenderer.invoke('db-run', { sql, params }),
    
    getConfig: (key) => ipcRenderer.invoke('get-config', key),
    setConfig: (key, value) => ipcRenderer.invoke('set-config', { key, value }),
    
    exportChat: (data) => ipcRenderer.invoke('export-chat', data),
    getAppVersion: () => ipcRenderer.invoke('get-app-version')
});