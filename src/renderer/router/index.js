import { createRouter, createWebHashHistory } from 'vue-router';

const routes = [
  { path: '/', name: 'Dashboard', component: () => import('../views/Dashboard.vue') },
  { path: '/config', name: 'Config', component: () => import('../views/Config.vue') },
  { path: '/history', name: 'History', component: () => import('../views/History.vue') },
  { path: '/logs', name: 'Logs', component: () => import('../views/Logs.vue') },
  { path: '/schedule', name: 'Schedule', component: () => import('../views/Schedule.vue') },
  { path: '/report', name: 'DailyReport', component: () => import('../views/DailyReport.vue') },
];

export default createRouter({
  history: createWebHashHistory(),
  routes,
});
