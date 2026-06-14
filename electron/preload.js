const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xnowpost', {
  // 配置
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  testApi: (type) => ipcRenderer.invoke('config:test', type),

  // 引擎
  runEngine: (mode, topic) => ipcRenderer.invoke('engine:run', mode, topic),
  cancelEngine: () => ipcRenderer.invoke('engine:cancel'),
  getEngineStatus: () => ipcRenderer.invoke('engine:status'),

  // 日志
  getLogs: () => ipcRenderer.invoke('logs:get'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  onLog: (callback) => {
    const listener = (_event, entry) => callback(entry);
    ipcRenderer.on('engine:log', listener);
    return () => ipcRenderer.removeListener('engine:log', listener);
  },

  // 历史
  getHistory: () => ipcRenderer.invoke('history:list'),
  readSession: (dir) => ipcRenderer.invoke('session:read', dir),
  getThumbnail: (dir) => ipcRenderer.invoke('session:thumbnail', dir),
  openOutputDir: () => ipcRenderer.invoke('shell:openOutput'),

  // 费用
  getLatestCost: () => ipcRenderer.invoke('cost:latest'),
});
