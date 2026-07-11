const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xnowpost', {
  // 是否为开发版（通过 main process 传入的可靠标记）
  isDev: process.argv.find(a => a.startsWith('--xnowpost-dev='))?.split('=')[1] === 'true',
  // 诊断
  ping: () => ipcRenderer.invoke('ping'),

  // 配置
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  testApi: (type, key) => ipcRenderer.invoke('config:test', type, key),
  testBit: (apiKey) => ipcRenderer.invoke('config:testBit', apiKey),
  getDataDir: () => ipcRenderer.invoke('config:getDataDir'),
  selectDataDir: () => ipcRenderer.invoke('config:selectDir'),
  migrateData: (newDir) => ipcRenderer.invoke('config:migrateData', newDir),

  // 引擎
  runEngine: (mode, topic) => ipcRenderer.invoke('engine:run', mode, topic),
  cancelEngine: () => ipcRenderer.invoke('engine:cancel'),
  getEngineStatus: () => ipcRenderer.invoke('engine:status'),
  getFailureCount: () => ipcRenderer.invoke('engine:failureCount'),

  // 日志
  getLogs: () => ipcRenderer.invoke('logs:get'),
  getLogsByDate: (date) => ipcRenderer.invoke('logs:history', date),
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
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  exportCsv: (content, name) => ipcRenderer.invoke('export:csv', content, name),

  // 费用
  getLatestCost: () => ipcRenderer.invoke('cost:latest'),

  // 采集数据
  runCollect: (accounts) => ipcRenderer.invoke('collect:run', accounts),
  getLatestCollect: () => ipcRenderer.invoke('collect:latest'),
  getDailyReport: (date) => ipcRenderer.invoke('report:daily', date),
  getTrend: (days) => ipcRenderer.invoke('report:trend', days),
  pushReport: (date) => ipcRenderer.invoke('report:push', date),

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
  onUpdateError: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('update:error', listener);
    return () => ipcRenderer.removeListener('update:error', listener);
  },

  // 引擎进度
  onProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('engine:progress', listener);
    return () => ipcRenderer.removeListener('engine:progress', listener);
  },

  // 调度器状态实时推送
  onEngineStatusPush: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('engine:status-push', listener);
    return () => ipcRenderer.removeListener('engine:status-push', listener);
  },

  // 定时任务
  getSchedules: () => ipcRenderer.invoke('schedule:list'),
  saveSchedules: (jobs) => ipcRenderer.invoke('schedule:save', jobs),

  // 发布
  runPublish: () => ipcRenderer.invoke('publish:run'),
  getPendingPublish: () => ipcRenderer.invoke('publish:pending'),

  // 应用
  restartApp: () => ipcRenderer.invoke('app:restart'),
});
