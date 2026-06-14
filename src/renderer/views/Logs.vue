<template>
  <div class="logs-page">
    <div class="header">
      <h2>📜 运行日志</h2>
      <button class="btn btn-secondary" @click="clear">🗑️ 清空</button>
    </div>

    <div class="log-container">
      <div v-for="(log, i) in logs" :key="i" class="log-line" :class="log.type">
        <span class="log-time">{{ log.time }}</span>
        <span class="log-level">{{ levelIcon(log.type) }}</span>
        <span class="log-msg">{{ log.message }}</span>
      </div>
      <div v-if="logs.length === 0" class="empty">暂无日志</div>
    </div>
  </div>
</template>

<script setup>
import { useAppStore } from '../stores/app.js';
import { computed, onMounted } from 'vue';

const store = useAppStore();
const logs = computed(() => store.logs);

function levelIcon(type) {
  return { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' }[type] || 'ℹ️';
}

onMounted(async () => {
  store.logs = await window.xnowpost.getLogs();
});

function clear() {
  store.clearLogs();
}
</script>

<style scoped>
.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
h2 { font-size: 24px; }
.btn-secondary { padding: 8px 16px; background: #334155; color: #e2e8f0; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
.log-container { background: #0f172a; border: 1px solid #1e293b; border-radius: 8px; padding: 12px; max-height: calc(100vh - 160px); overflow-y: auto; }
.log-line { display: flex; gap: 10px; padding: 3px 0; font-size: 12px; font-family: monospace; border-bottom: 1px solid #1e293b22; }
.log-time { color: #64748b; min-width: 140px; }
.log-level { min-width: 24px; }
.log-msg { color: #94a3b8; }
.log-line.success .log-msg { color: #22c55e; }
.log-line.error .log-msg { color: #ef4444; }
.log-line.warning .log-msg { color: #f59e0b; }
.empty { padding: 40px; text-align: center; color: #64748b; }
</style>
