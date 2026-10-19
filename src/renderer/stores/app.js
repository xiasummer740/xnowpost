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
      dataDir: '',
    },
    status: {
      configured: false,
      running: false,
      todayDir: '',
    },
    logs: [],
    activeTab: 0,
    latestCost: null, // { deepseek: number, kolors: number, total: number }
    // 显式取消标记：runEngine 的 finally 一定会把 status.running 置回 false，
    // 所以调用方（批量生成）不能用 status.running 判断"是否被用户取消"（见 P1-1）
    cancelled: false,
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

    async runEngine(mode = 'auto', topic = '', options = {}) {
      this.status.running = true;
      this.cancelled = false; // 每次运行都重置取消标记，避免上一次的取消影响本次
      let result = { ok: false, message: '' };
      try {
        // ⚠️ 调用方可能传进来 Vue 响应式对象（Proxy），结构化克隆会直接抛
        // "An object could not be cloned"，请求发不到主进程 —— 现象是"点了没反应"。
        // 在这里统一转成纯数据，作为最后一道防线。
        let safeOptions = {};
        try { safeOptions = JSON.parse(JSON.stringify(options || {})); } catch (_) { safeOptions = {}; }
        result = (await window.xnowpost.runEngine(mode, topic, safeOptions)) || { ok: true };
        if (!result.ok) {
          this.addLog('error', result.message || '执行失败');
        }
      } catch (e) {
        // 抛错也要返回结构化结果，否则批量循环里会变成未捕获的 rejection
        result = { ok: false, message: (e && e.message) || String(e) };
        this.addLog('error', '引擎调用失败: ' + result.message);
      } finally {
        this.status.running = false;
        // 引擎执行完后自动刷新费用信息
        this.loadCost();
      }
      // 把"是否被取消"显式回传给调用方（批量生成据此决定是否中断）
      return { ...result, cancelled: this.cancelled === true || result.cancelled === true };
    },

    async loadCost() {
      try {
        this.latestCost = await window.xnowpost.getLatestCost();
      } catch (_) {
        // 费用读取失败不影响主流程
      }
    },

    async cancelEngine() {
      const result = await window.xnowpost.cancelEngine();
      if (result.ok) {
        this.cancelled = true; // 让 await runEngine 的调用方知道是"用户取消"
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
