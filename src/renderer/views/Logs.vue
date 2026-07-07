<template>
  <div class="logs-page">
    <div class="header">
      <h2>📜 运行日志</h2>
      <div class="header-right">
        <input type="date" v-model="historyDate" class="date-input" @change="loadHistory" />
        <button class="btn btn-secondary" @click="switchToLive">🔄 实时</button>
        <button class="btn btn-secondary" @click="clear">🗑️ 清空</button>
      </div>
    </div>

    <div v-if="isHistory" class="history-badge">📂 历史日志：{{ historyDate }}</div>

    <div class="filter-bar">
      <span
        v-for="t in filterTypes"
        :key="t.key"
        class="filter-chip"
        :class="{ active: activeFilter === t.key }"
        @click="activeFilter = t.key"
      >{{ t.label }}</span>
    </div>

    <div class="log-container">
      <div v-for="(log, i) in filteredLogs" :key="i" class="log-line" :class="log.type">
        <span class="log-time">{{ log.time }}</span>
        <span class="log-level">{{ levelIcon(log.type) }}</span>
        <span class="log-msg">{{ log.message }}</span>
      </div>
      <div v-if="filteredLogs.length === 0" class="empty">
        {{ logs.length === 0 ? '暂无日志' : '没有匹配的日志' }}
      </div>
    </div>
  </div>
</template>

<script setup>
import { useAppStore } from '../stores/app.js';
import { computed, onMounted, ref } from 'vue';

const store = useAppStore();
const logs = computed(() => store.logs);
const activeFilter = ref('all');
const historyDate = ref('');
const isHistory = ref(false);

const filterTypes = [
  { key: 'all', label: '全部' },
  { key: 'success', label: '✅ 成功' },
  { key: 'error', label: '❌ 错误' },
  { key: 'warning', label: '⚠️ 警告' },
  { key: 'info', label: 'ℹ️ 信息' },
];

const filteredLogs = computed(() => {
  if (activeFilter.value === 'all') return logs.value
  return logs.value.filter(l => l.type === activeFilter.value)
})

function levelIcon(type) {
  return { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' }[type] || 'ℹ️';
}

onMounted(async () => {
  store.logs = await window.xnowpost.getLogs();
});

function clear() {
  store.clearLogs();
}

async function loadHistory() {
  if (!historyDate.value) return
  isHistory.value = true
  try {
    store.logs = await window.xnowpost.getLogsByDate(historyDate.value)
  } catch (_) { store.logs = [] }
}

function switchToLive() {
  isHistory.value = false
  historyDate.value = ''
  store.loadLogs()
}

// set default date to today
onMounted(async () => {
  store.logs = await window.xnowpost.getLogs()
  const d = new Date()
  historyDate.value = d.toISOString().split('T')[0]
})
</script>

<style scoped>
.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
h2 { font-size: 24px; }
.btn-secondary { padding: 8px 16px; background: #334155; color: #e2e8f0; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
.btn-secondary:hover { background: #475569; }
.header-right { display: flex; gap: 8px; align-items: center; }
.date-input {
  padding: 6px 10px; border: 1px solid #334155; border-radius: 6px;
  background: #1e293b; color: #e2e8f0; font-size: 13px; outline: none;
}
.date-input:focus { border-color: #f59e0b; }
.history-badge {
  font-size: 12px; color: #60a5fa; background: #1e3a5f33; border: 1px solid #2563eb33;
  padding: 4px 10px; border-radius: 6px; margin-bottom: 10px; display: inline-block;
}

.filter-bar { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
.filter-chip {
  padding: 4px 12px; border-radius: 6px; font-size: 12px; font-weight: 600;
  background: #1e293b; color: #64748b; border: 1px solid #334155;
  cursor: pointer; transition: all 0.15s; user-select: none;
}
.filter-chip:hover { color: #94a3b8; border-color: #475569; }
.filter-chip.active { background: #334155; color: #f59e0b; border-color: #f59e0b44; }

.log-container { background: #0f172a; border: 1px solid #1e293b; border-radius: 8px; padding: 12px; max-height: calc(100vh - 210px); overflow-y: auto; }
.log-line { display: flex; gap: 10px; padding: 3px 0; font-size: 13px; font-family: monospace; border-bottom: 1px solid #1e293b22; }
.log-time { color: #64748b; min-width: 140px; }
.log-level { min-width: 24px; }
.log-msg { color: #94a3b8; }
.log-line.success .log-msg { color: #22c55e; }
.log-line.error .log-msg { color: #ef4444; }
.log-line.warning .log-msg { color: #f59e0b; }
.empty { padding: 40px; text-align: center; color: #64748b; }
</style>
