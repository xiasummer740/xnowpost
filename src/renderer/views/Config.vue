<template>
  <div class="config-page">
    <h2>⚙️ 配置</h2>

    <!-- DeepSeek -->
    <div class="api-row">
      <div class="form-group flex-1">
        <label>DeepSeek API Key（文案生成）</label>
        <div class="input-with-toggle">
          <input v-model="form.deepseekApiKey" :type="showKeys.deepseek ? 'text' : 'password'" placeholder="sk-..." />
          <button class="btn-eye" @click="showKeys.deepseek = !showKeys.deepseek" type="button">
            {{ showKeys.deepseek ? '👁️' : '👁️‍🗨️' }}
          </button>
        </div>
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
        <div class="input-with-toggle">
          <input v-model="form.siliconflowApiKey" :type="showKeys.siliconflow ? 'text' : 'password'" placeholder="sk-..." />
          <button class="btn-eye" @click="showKeys.siliconflow = !showKeys.siliconflow" type="button">
            {{ showKeys.siliconflow ? '👁️' : '👁️‍🗨️' }}
          </button>
        </div>
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
        <div class="input-with-toggle">
          <input v-model="form.pexelsApiKey" :type="showKeys.pexels ? 'text' : 'password'" placeholder="免费注册获取..." />
          <button class="btn-eye" @click="showKeys.pexels = !showKeys.pexels" type="button">
            {{ showKeys.pexels ? '👁️' : '👁️‍🗨️' }}
          </button>
        </div>
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
        <div class="input-with-toggle">
          <input v-model="form.tgBotToken" :type="showKeys.tg ? 'text' : 'password'" placeholder="123456:ABC-DEF..." />
          <button class="btn-eye" @click="showKeys.tg = !showKeys.tg" type="button">
            {{ showKeys.tg ? '👁️' : '👁️‍🗨️' }}
          </button>
        </div>
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
      <label>指纹浏览器 CDP 端口（旧版直连）</label>
      <input v-model="form.cdpEndpoint" placeholder="http://localhost:9222" />
    </div>

    <hr class="section-divider" />

    <!-- 账号管理 -->
    <h3 class="section-title">👤 采集账号管理</h3>
    <p class="section-desc">通过比特浏览器 API 自动打开环境采集数据</p>

    <div class="account-list">
      <div v-for="(acc, i) in form.accounts" :key="i" class="account-row">
        <input v-model="acc.name" placeholder="账号名称（如：主号）" class="acc-input acc-name" />
        <select v-model="acc.platform" class="acc-input acc-platform">
          <option value="tiktok">TikTok</option>
          <option value="xiaohongshu">小红书</option>
          <option value="facebook">Facebook</option>
          <option value="instagram">Instagram</option>
          <option value="youtube">YouTube</option>
          <option value="x">X (Twitter)</option>
        </select>
        <input v-model="acc.bitEnvId" placeholder="比特环境ID" class="acc-input acc-env" />
        <button class="btn-del" @click="removeAccount(i)" title="删除">✕</button>
      </div>
    </div>

    <button class="btn btn-add-acc" @click="addAccount">➕ 添加账号</button>

    <hr class="section-divider" />

    <div class="error-banner" v-if="errorMsg">{{ errorMsg }}</div>
    <div class="success-banner" v-if="saveMsg">{{ saveMsg }}</div>

    <div class="btn-row">
      <button class="btn btn-primary" @click="save" :disabled="saving">
        {{ saving ? '⏳ 保存中...' : '💾 保存配置' }}
      </button>
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
  accounts: [],
});
const testing = reactive({ deepseek: false, siliconflow: false, pexels: false, tg: false });
const results = reactive({ deepseek: null, siliconflow: null, pexels: null, tg: null });
const showKeys = reactive({ deepseek: false, siliconflow: false, pexels: false, tg: false });
const saving = ref(false);
const errorMsg = ref('');

onMounted(async () => {
  const config = await window.xnowpost.getConfig();
  Object.assign(form, config);
});

const saveMsg = ref('');

function addAccount() {
  form.accounts.push({ name: '', platform: 'tiktok', bitEnvId: '' });
}

function removeAccount(i) {
  form.accounts.splice(i, 1);
}

async function save() {
  saving.value = true;
  errorMsg.value = '';
  saveMsg.value = '';
  try {
    await store.saveConfig({ ...form });
    saveMsg.value = '✅ 配置已保存';
    setTimeout(() => saveMsg.value = '', 3000);
  } catch (e) {
    errorMsg.value = '保存失败: ' + (e.message || e);
  }
  saving.value = false;
}

async function test(type) {
  testing[type] = true;
  results[type] = null;
  errorMsg.value = '';
  try {
    await store.saveConfig({ ...form });
    results[type] = await window.xnowpost.testApi(type);
  } catch (e) {
    results[type] = { ok: false, message: 'IPC 调用失败: ' + (e.message || e) };
  }
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
.input-with-toggle { display: flex; align-items: stretch; max-width: 500px; }
.input-with-toggle input { flex: 1; border-top-right-radius: 0; border-bottom-right-radius: 0; border-right: none; max-width: none; }
.btn-eye {
  padding: 0 12px; border: 1px solid #334155; border-left: none; border-radius: 0 8px 8px 0;
  background: #1e293b; color: #64748b; cursor: pointer; font-size: 14px; line-height: 1;
  transition: background 0.2s;
}
.btn-eye:hover { background: #334155; color: #e2e8f0; }
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
.section-divider { border: none; border-top: 1px solid #334155; margin: 24px 0; }
.section-title { font-size: 16px; color: #e2e8f0; margin: 0 0 4px; }
.section-desc { font-size: 12px; color: #64748b; margin: 0 0 16px; }

/* 账号列表 */
.account-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.account-row {
  display: flex; gap: 8px; align-items: center;
  padding: 10px 12px; background: #1e293b; border: 1px solid #334155; border-radius: 8px;
}
.acc-input {
  padding: 7px 10px; border: 1px solid #334155; border-radius: 6px;
  background: #0f172a; color: #e2e8f0; font-size: 13px; outline: none;
  transition: border-color 0.15s;
}
.acc-input:focus { border-color: #f59e0b; }
.acc-name { flex: 2; min-width: 80px; }
.acc-platform { flex: 1; min-width: 90px; cursor: pointer; }
.acc-env { flex: 1; min-width: 70px; }
.btn-del {
  width: 28px; height: 28px; border: none; border-radius: 6px;
  background: transparent; color: #64748b; cursor: pointer; font-size: 12px;
  transition: all 0.15s; flex-shrink: 0;
}
.btn-del:hover { background: #7f1d1d44; color: #ef4444; }
.btn-add-acc {
  padding: 8px 16px; border: 2px dashed #334155; border-radius: 8px;
  background: transparent; color: #64748b; cursor: pointer; font-size: 13px;
  transition: all 0.15s; margin-bottom: 8px;
}
.btn-add-acc:hover { border-color: #f59e0b44; color: #f59e0b; }

.error-banner { background: #7f1d1d44; color: #fca5a5; padding: 10px 14px; border-radius: 8px; margin-bottom: 12px; font-size: 13px; border: 1px solid #7f1d1d; max-width: 600px; }
.success-banner { background: #064e3b44; color: #22c55e; padding: 10px 14px; border-radius: 8px; margin-bottom: 12px; font-size: 13px; border: 1px solid #064e3b; max-width: 600px; }
</style>
