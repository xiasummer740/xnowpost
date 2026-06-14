<template>
  <div class="config-page">
    <h2>⚙️ 配置</h2>

    <!-- DeepSeek -->
    <div class="api-row">
      <div class="form-group flex-1">
        <label>DeepSeek API Key（文案生成）</label>
        <input v-model="form.deepseekApiKey" type="password" placeholder="sk-..." />
      </div>
      <button class="btn btn-test" @click="test('deepseek')" :disabled="testing.deepseek">
        {{ testing.deepseek ? '⏳' : '🔌' }}
      </button>
      <span class="status-icon" v-if="results.deepseek">{{ results.deepseek.ok ? '✅' : '❌' }}</span>
    </div>
    <div class="result-msg" v-if="results.deepseek" :class="results.deepseek.ok ? 'success' : 'error'">
      {{ results.deepseek.message }}
    </div>

    <!-- SiliconFlow -->
    <div class="api-row">
      <div class="form-group flex-1">
        <label>硅基流动 API Key（AI 生图）</label>
        <input v-model="form.siliconflowApiKey" type="password" placeholder="sk-..." />
      </div>
      <button class="btn btn-test" @click="test('siliconflow')" :disabled="testing.siliconflow">
        {{ testing.siliconflow ? '⏳' : '🔌' }}
      </button>
      <span class="status-icon" v-if="results.siliconflow">{{ results.siliconflow.ok ? '✅' : '❌' }}</span>
    </div>
    <div class="result-msg" v-if="results.siliconflow" :class="results.siliconflow.ok ? 'success' : 'error'">
      {{ results.siliconflow.message }}
    </div>
    <div class="hint-block">注册: cloud.siliconflow.cn，新用户送 14 元</div>

    <!-- Pexels -->
    <div class="api-row">
      <div class="form-group flex-1">
        <label>Pexels API Key（真实素材搜索）</label>
        <input v-model="form.pexelsApiKey" type="password" placeholder="免费注册获取..." />
      </div>
      <button class="btn btn-test" @click="test('pexels')" :disabled="testing.pexels">
        {{ testing.pexels ? '⏳' : '🔌' }}
      </button>
      <span class="status-icon" v-if="results.pexels">{{ results.pexels.ok ? '✅' : '❌' }}</span>
    </div>
    <div class="result-msg" v-if="results.pexels" :class="results.pexels.ok ? 'success' : 'error'">
      {{ results.pexels.message }}
    </div>
    <div class="hint-block">注册: pexels.com/api，免费月200次搜索</div>

    <!-- TG Bot -->
    <div class="api-row">
      <div class="form-group flex-1">
        <label>Telegram Bot Token（消息推送）</label>
        <input v-model="form.tgBotToken" type="password" placeholder="123456:ABC-DEF..." />
      </div>
      <button class="btn btn-test" @click="test('tg')" :disabled="testing.tg">
        {{ testing.tg ? '⏳' : '🔌' }}
      </button>
      <span class="status-icon" v-if="results.tg">{{ results.tg.ok ? '✅' : '❌' }}</span>
    </div>

    <div class="form-group">
      <label>Telegram 频道 ID</label>
      <input v-model="form.tgChannelId" placeholder="@your_channel" />
    </div>
    <div class="result-msg" v-if="results.tg" :class="results.tg.ok ? 'success' : 'error'">
      {{ results.tg.message }}
    </div>

    <!-- CDP -->
    <div class="form-group">
      <label>指纹浏览器 CDP 端口（数据采集）</label>
      <input v-model="form.cdpEndpoint" placeholder="http://localhost:9222" />
    </div>

    <div class="btn-row">
      <button class="btn btn-primary" @click="save">💾 保存配置</button>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref, onMounted } from 'vue';
import { useAppStore } from '../stores/app.js';

const store = useAppStore();
const form = reactive({
  deepseekApiKey: '',
  siliconflowApiKey: '',
  pexelsApiKey: '',
  tgBotToken: '',
  tgChannelId: '@your_channel',
  cdpEndpoint: 'http://localhost:9222',
});
const testing = reactive({ deepseek: false, siliconflow: false, pexels: false, tg: false });
const results = reactive({ deepseek: null, siliconflow: null, pexels: null, tg: null });

onMounted(async () => {
  const config = await window.xnowpost.getConfig();
  Object.assign(form, config);
});

async function save() {
  await store.saveConfig({ ...form });
}

async function test(type) {
  testing[type] = true;
  results[type] = null;
  await store.saveConfig({ ...form });
  results[type] = await window.xnowpost.testApi(type);
  testing[type] = false;
}
</script>

<style scoped>
h2 { font-size: 24px; margin-bottom: 24px; }
.api-row { display: flex; gap: 10px; align-items: flex-end; margin-bottom: 4px; }
.flex-1 { flex: 1; margin-bottom: 0 !important; }
.form-group { margin-bottom: 16px; }
.form-group label { display: block; font-size: 13px; color: #94a3b8; margin-bottom: 6px; }
.form-group input {
  width: 100%; max-width: 500px;
  padding: 10px 14px; border: 1px solid #334155; border-radius: 8px;
  background: #1e293b; color: #e2e8f0; font-size: 14px;
  outline: none; transition: border-color 0.2s;
}
.form-group input:focus { border-color: #f59e0b; }
.hint-block { font-size: 11px; color: #64748b; margin-bottom: 16px; margin-left: 2px; }
.status-icon { font-size: 18px; padding-bottom: 10px; }
.btn-row { display: flex; gap: 12px; margin-top: 24px; }
.btn {
  padding: 10px 24px; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer;
}
.btn-primary { background: linear-gradient(135deg, #f59e0b, #d97706); color: #0f172a; }
.btn-test {
  background: #334155; color: #e2e8f0; border: none; border-radius: 6px; cursor: pointer;
  font-size: 18px; padding: 8px 14px; height: 44px; min-width: 48px;
}
.btn-test:hover { background: #475569; }
.btn-test:disabled { opacity: 0.5; }
.result-msg {
  margin-bottom: 12px; padding: 8px 12px; border-radius: 6px; font-size: 12px;
  max-width: 500px;
}
.result-msg.success { background: #064e3b22; color: #22c55e; border: 1px solid #064e3b; }
.result-msg.error { background: #7f1d1d22; color: #ef4444; border: 1px solid #7f1d1d; }
</style>
