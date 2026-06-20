<template>
  <div class="app-container">
    <aside class="sidebar">
      <div class="logo">
        <h1>XNOWPost</h1>
        <div class="logo-meta">
          <span v-if="isDev" class="dev-badge">开发版</span>
          <span class="ver">v{{ version }}</span>
        </div>
        <p>内容营销引擎</p>
      </div>
      <nav>
        <router-link to="/" class="nav-item" :class="{ active: $route.path === '/' }">
          🏠 首页
        </router-link>
        <router-link to="/config" class="nav-item" :class="{ active: $route.path === '/config' }">
          ⚙️ 配置
        </router-link>
        <router-link to="/history" class="nav-item" :class="{ active: $route.path === '/history' }">
          📋 历史
        </router-link>
        <router-link to="/logs" class="nav-item" :class="{ active: $route.path === '/logs' }">
          📜 日志
        </router-link>
        <router-link to="/schedule" class="nav-item" :class="{ active: $route.path === '/schedule' }">
          ⏰ 闹钟
        </router-link>
      </nav>
      <div class="sidebar-footer">
        <span class="status-dot" :class="store.status.configured ? 'online' : 'offline'"></span>
        {{ store.status.configured ? '已配置' : '未配置' }}
      </div>
    </aside>
    <main class="content">
      <router-view />
    </main>
  </div>
</template>

<script setup>
import { useAppStore } from './stores/app.js';
import { onMounted, ref } from 'vue';
import { version } from '../../package.json';

const store = useAppStore();
const isDev = ref(window.xnowpost?.isDev ?? false);

onMounted(async () => {
  await store.loadConfig();
  // 监听引擎日志
  window.xnowpost.onLog((entry) => {
    store.logs.push(entry);
  });
});
</script>

<style scoped>
.app-container {
  display: flex;
  height: 100vh;
  background: #0f172a;
  color: #e2e8f0;
}
.sidebar {
  width: 200px;
  min-width: 200px;
  background: #1e293b;
  display: flex;
  flex-direction: column;
  padding: 20px 0;
  border-right: 1px solid #334155;
}
.logo {
  padding: 0 16px 14px;
  border-bottom: 1px solid #334155;
  margin-bottom: 8px;
}
.logo h1 {
  font-size: 18px;
  font-weight: 900;
  background: linear-gradient(135deg, #f59e0b, #ef4444);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  margin: 0 0 3px 0;
}
.logo-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 2px;
}
.logo .ver {
  font-size: 11px;
  font-weight: 600;
  background: #334155;
  -webkit-text-fill-color: #94a3b8;
  padding: 1px 6px;
  border-radius: 4px;
}
.dev-badge {
  font-size: 10px;
  font-weight: 800;
  background: #f97316;
  -webkit-text-fill-color: #0f172a;
  padding: 1px 5px;
  border-radius: 3px;
  letter-spacing: 0.5px;
  white-space: nowrap;
}
.logo p { font-size: 11px; color: #64748b; margin: 0; }
.nav-item {
  display: block;
  padding: 12px 20px;
  color: #94a3b8;
  text-decoration: none;
  font-size: 14px;
  transition: all 0.2s;
  border-left: 3px solid transparent;
}
.nav-item:hover { color: #e2e8f0; background: #33415533; }
.nav-item.active { color: #f59e0b; border-left-color: #f59e0b; background: #33415544; }
.sidebar-footer {
  margin-top: auto;
  padding: 16px 20px;
  font-size: 12px;
  color: #64748b;
}
.status-dot {
  display: inline-block;
  width: 8px; height: 8px;
  border-radius: 50%;
  margin-right: 6px;
}
.status-dot.online { background: #22c55e; }
.status-dot.offline { background: #ef4444; }
.content {
  flex: 1;
  overflow-y: auto;
  padding: 30px;
}
</style>
