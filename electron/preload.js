const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('xnowpost', {
  // 是否为开发版（通过 main process 传入的可靠标记）
  isDev: process.argv.find(a => a.startsWith('--xnowpost-dev='))?.split('=')[1] === 'true',

  // 配置
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  testApi: (type, key) => ipcRenderer.invoke('config:test', type, key),
  // DeepSeek 模型列表 + 「请求的模型实际被路由到哪个模型」
  aiModels: () => ipcRenderer.invoke('ai:models'),
  // AI 助手（对话 + 动作确认）。写操作只有经由 assistantAnswer 传 approve 才会执行。
  assistantSend: (text) => ipcRenderer.invoke('assistant:send', text),
  assistantAnswer: (approvals) => ipcRenderer.invoke('assistant:answer', approvals),
  assistantState: () => ipcRenderer.invoke('assistant:state'),
  assistantReset: () => ipcRenderer.invoke('assistant:reset'),
  // 撤销一次写操作（30 分钟内有效，只能撤改配置/改定时）
  assistantUndo: (id) => ipcRenderer.invoke('assistant:undo', id),
  /**
   * 订阅「助手主动回报」（跑完的生成/发布任务自动把结果推回对话）。
   * 返回取消订阅函数，页面卸载时调用，避免热更新后重复累积监听。
   */
  onAssistantUpdate: (callback) => {
    const handler = (_event, payload) => { try { callback(payload); } catch (_) { /* 忽略渲染错误 */ } };
    ipcRenderer.on('assistant:update', handler);
    return () => ipcRenderer.removeListener('assistant:update', handler);
  },
  testBit: (apiKey, opts) => ipcRenderer.invoke('config:testBit', apiKey, opts),
  listFoxProfiles: () => ipcRenderer.invoke('config:foxProfiles'),
  getDataDir: () => ipcRenderer.invoke('config:getDataDir'),
  selectDataDir: (opts) => ipcRenderer.invoke('config:selectDir', opts),
  pickImages: () => ipcRenderer.invoke('config:pickImages'),
  // 拖拽进来的 File 对象在 Electron 32+ 已经没有 .path 了，
  // 必须走 webUtils.getPathForFile 才能拿到真实路径
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch (_) { return ''; }
  },
  // 粘贴的剪贴板图片没有路径，只能把字节交给主进程落盘
  savePastedImage: (buffer, ext) => ipcRenderer.invoke('config:savePastedImage', buffer, ext),
  migrateData: (newDir) => ipcRenderer.invoke('config:migrateData', newDir),

  // 引擎
  runEngine: (mode, topic, options) => ipcRenderer.invoke('engine:run', mode, topic, options),
  cancelEngine: () => ipcRenderer.invoke('engine:cancel'),
  getEngineStatus: () => ipcRenderer.invoke('engine:status'),
  getFailureCount: () => ipcRenderer.invoke('engine:failureCount'),

  // 日志
  getLogs: () => ipcRenderer.invoke('logs:get'),
  getLogsByDate: (date) => ipcRenderer.invoke('logs:history', date),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  openLogFolder: () => ipcRenderer.invoke('logs:openFolder'),
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
  cancelCollect: () => ipcRenderer.invoke('collect:cancel'),
  getLatestCollect: () => ipcRenderer.invoke('collect:latest'),
  getDailyReport: (date) => ipcRenderer.invoke('report:daily', date),
  getTrend: (days) => ipcRenderer.invoke('report:trend', days),
  // 某天的「发布侧」结果（发了 N 条 / 失败 M 条 / 未确认 K 条）—— 日报页用
  getPublishDay: (date) => ipcRenderer.invoke('report:publishDay', date),
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
  getScheduleProgress: () => ipcRenderer.invoke('schedule:progress'),
  // 首页「今天要跑的任务」表（主进程算好状态，界面只显示）
  getSchedulePlan: () => ipcRenderer.invoke('schedule:plan'),

  // 网络节点（内置 xray 内核）：小白只做一件事 = 把 vless:// 链接粘进来
  proxyStatus: () => ipcRenderer.invoke('proxy:status'),
  proxyImportNode: (payload) => ipcRenderer.invoke('proxy:importNode', payload),
  proxyTest: () => ipcRenderer.invoke('proxy:test'),
  proxyRestart: () => ipcRenderer.invoke('proxy:restart'),
  proxyClear: () => ipcRenderer.invoke('proxy:clear'),

  // 浏览器环境（FoxProfile 托管面：新建 / 删除 / 启动 / 停止 / 测出口）
  // 2026-10-28：整合成一个软件 —— 这个界面替代 FoxProfile 的窗口
  listBrowserEnvs: () => ipcRenderer.invoke('envs:list'),
  createBrowserEnv: (payload) => ipcRenderer.invoke('envs:create', payload),
  startBrowserEnv: (env) => ipcRenderer.invoke('envs:start', env),
  stopBrowserEnv: (env) => ipcRenderer.invoke('envs:stop', env),
  deleteBrowserEnv: (payload) => ipcRenderer.invoke('envs:delete', payload),
  ipCheckBrowserEnv: (env) => ipcRenderer.invoke('envs:ipCheck', env),
  ensureBrowserService: () => ipcRenderer.invoke('envs:ensureService'),

  // 账号（批量登录可视化）
  listAccounts: () => ipcRenderer.invoke('accounts:list'),  pickAccountFile: () => ipcRenderer.invoke('accounts:pickFile'),
  openAccountInbox: () => ipcRenderer.invoke('accounts:openInbox'),
  backupAccountFiles: () => ipcRenderer.invoke('accounts:backupFiles'),
  saveAccountCredentials: (payload) => ipcRenderer.invoke('accounts:saveCredentials', payload),
  backupAccountSecrets: () => ipcRenderer.invoke('accounts:backupSecrets'),
  runAccountLogin: (opts) => ipcRenderer.invoke('accounts:run', opts),
  cancelAccountLogin: () => ipcRenderer.invoke('accounts:cancel'),
  syncAccountProfiles: (opts) => ipcRenderer.invoke('accounts:syncProfiles', opts),
  getAccountAvatar: (env) => ipcRenderer.invoke('accounts:avatar', env),
  importAccountFile: (file) => ipcRenderer.invoke('accounts:import', file),
  copyText: (text) => ipcRenderer.invoke('accounts:copy', text),
  pickAccountImage: () => ipcRenderer.invoke('accounts:pickImage'),
  previewAccountImage: (file) => ipcRenderer.invoke('accounts:imagePreview', file),
  editAccountProfiles: (opts) => ipcRenderer.invoke('accounts:editProfiles', opts),
  backupAccountCookies: (envs) => ipcRenderer.invoke('accounts:backup', envs),
  launchAccountEnv: (env, action) => ipcRenderer.invoke('accounts:launch', env, action),
  // 每个账号最后一次发布成功的时间（账本 + .published）
  getPublishTimes: () => ipcRenderer.invoke('accounts:publishTimes'),
  onPublishTimesUpdated: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('accounts:publishTimesUpdated', listener);
    return () => ipcRenderer.removeListener('accounts:publishTimesUpdated', listener);
  },
  onAccountProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('accounts:progress', listener);
    return () => ipcRenderer.removeListener('accounts:progress', listener);
  },

  // 发布（opts 可指定 { maxCount, budgetMs }）
  runPublish: (opts) => ipcRenderer.invoke('publish:run', opts),
  getPendingPublish: () => ipcRenderer.invoke('publish:pending'),

  // 应用
  restartApp: () => ipcRenderer.invoke('app:restart'),
});
