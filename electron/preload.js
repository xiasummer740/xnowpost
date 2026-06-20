const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xnowpost', {
  // 是否为开发版（通过 main process 传入的可靠标记）
  isDev: process.argv.find(a => a.startsWith('--xnowpost-dev='))?.split('=')[1] === 'true',
  // 诊断
  ping: () => ipcRenderer.invoke('ping'),

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

  // 采集数据
  getLatestCollect: () => ipcRenderer.invoke('collect:latest'),

  // 自动更新
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateAvailable: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on('update:available', listener);
    return () => ipcRenderer.removeListener('update:available', listener);
  },
  onUpdateNotAvailable: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('update:not-available', listener);
    return () => ipcRenderer.removeListener('update:not-available', listener);
  },
  onUpdateProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('update:progress', listener);
    return () => ipcRenderer.removeListener('update:progress', listener);
  },
  onUpdateDownloaded: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('update:downloaded', listener);
    return () => ipcRenderer.removeListener('update:downloaded', listener);
  },

  // 定时任务
  getSchedules: () => ipcRenderer.invoke('schedule:list'),
  saveSchedules: (jobs) => ipcRenderer.invoke('schedule:save', jobs),
});
