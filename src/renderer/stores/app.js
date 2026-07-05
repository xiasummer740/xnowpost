import { defineStore } from 'pinia';

export const useAppStore = defineStore('app', {
  state: () => ({
    config: {
      deepseekApiKey: '',
      siliconflowApiKey: '',
      pexelsApiKey: '',
      tgBotToken: '',
      tgChannelId: '@your_channel',
      cdpEndpoint: 'http://localhost:9222',
    },
    status: {
      configured: false,
      running: false,
      todayDir: '',
    },
    logs: [],
    activeTab: 0,
    latestCost: null, // { deepseek: number, kolors: number, total: number }
  }),

  actions: {
    async loadConfig() {
      this.config = await window.xnowpost.getConfig();
      this.status = await window.xnowpost.getEngineStatus();
    },

    async saveConfig(config) {
      const res = await window.xnowpost.saveConfig(config);
      if (!res.ok) throw new Error(res.message || '保存配置失败');
      this.config = { ...config };
      this.status = await window.xnowpost.getEngineStatus();
    },

    async runEngine(mode = 'auto', topic = '') {
      this.status.running = true;
      try {
        const result = await window.xnowpost.runEngine(mode, topic);
        if (!result.ok) {
          this.addLog('error', result.message || '执行失败');
        }
      } finally {
        this.status.running = false;
        // 引擎执行完后自动刷新费用信息
        this.loadCost();
      }
    },

    async loadCost() {
      this.latestCost = await window.xnowpost.getLatestCost();
    },

    async cancelEngine() {
      const result = await window.xnowpost.cancelEngine();
      if (result.ok) {
        this.status.running = false;
        this.addLog('warning', '引擎已取消');
      }
      return result;
    },

    addLog(type, message) {
      this.logs.push({ time: new Date().toLocaleString('zh-CN'), type, message });
      if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
    },

    async loadLogs() {
      this.logs = await window.xnowpost.getLogs();
    },

    clearLogs() {
      window.xnowpost.clearLogs();
      this.logs = [];
    },
  },
});
