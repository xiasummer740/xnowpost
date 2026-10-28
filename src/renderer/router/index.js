import { createRouter, createWebHashHistory } from 'vue-router';

const routes = [
  { path: '/', name: 'Dashboard', component: () => import('../views/Dashboard.vue') },
  { path: '/accounts', name: 'Accounts', component: () => import('../views/Accounts.vue') },
  // 浏览器环境：原来只能去 FoxProfile 自己的窗口做的事（新建/删除/启动/停止/测出口）
  { path: '/envs', name: 'BrowserEnvs', component: () => import('../views/BrowserEnvs.vue') },
  { path: '/config', name: 'Config', component: () => import('../views/Config.vue') },
  { path: '/history', name: 'History', component: () => import('../views/History.vue') },
  { path: '/logs', name: 'Logs', component: () => import('../views/Logs.vue') },
  { path: '/schedule', name: 'Schedule', component: () => import('../views/Schedule.vue') },
  { path: '/report', name: 'DailyReport', component: () => import('../views/DailyReport.vue') },
  { path: '/assistant', name: 'Assistant', component: () => import('../views/Assistant.vue') },
];

export default createRouter({
  history: createWebHashHistory(),
  routes,
});
