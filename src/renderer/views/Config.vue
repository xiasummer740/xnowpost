<template>
  <div class="config-page">
    <h2>⚙️ 配置</h2>

    <!-- DeepSeek -->
    <div class="api-row">
      <div class="form-group flex-1">
        <label>DeepSeek API Key（文案生成）</label>
        <div class="input-with-toggle">
          <input
            v-model="form.deepseekApiKey"
            :type="showKeys.deepseek ? 'text' : 'password'"
            placeholder="sk-..."
          />
          <button class="btn-eye" @click="showKeys.deepseek = !showKeys.deepseek" type="button" aria-label="切换显示 DeepSeek Key">
            {{ showKeys.deepseek ? '👁️' : '👁️‍🗨️' }}
          </button>
        </div>
        <div v-if="validationErrors.deepseekApiKey" class="field-error">{{ validationErrors.deepseekApiKey }}</div>
      </div>
      <button class="btn btn-test" @click="test('deepseek')" :disabled="testing.deepseek">
        {{ testing.deepseek ? '⏳' : '🔌' }}
      </button>
      <span class="status-icon" v-if="results.deepseek">{{
        results.deepseek.ok ? '✅' : '❌'
      }}</span>
    </div>
    <div
      class="result-msg"
      v-if="results.deepseek"
      :class="results.deepseek.ok ? 'success' : 'error'"
    >
      {{ results.deepseek.message }}
    </div>

    <!-- SiliconFlow -->
    <div class="api-row">
      <div class="form-group flex-1">
        <label>硅基流动 API Key（AI 生图）</label>
        <div class="input-with-toggle">
          <input
            v-model="form.siliconflowApiKey"
            :type="showKeys.siliconflow ? 'text' : 'password'"
            placeholder="sk-..."
          />
          <button
            class="btn-eye"
            @click="showKeys.siliconflow = !showKeys.siliconflow"
            type="button"
            aria-label="切换显示硅基流动 Key"
          >
            {{ showKeys.siliconflow ? '👁️' : '👁️‍🗨️' }}
          </button>
        </div>
        <div v-if="validationErrors.siliconflowApiKey" class="field-error">{{ validationErrors.siliconflowApiKey }}</div>
      </div>
      <button class="btn btn-test" @click="test('siliconflow')" :disabled="testing.siliconflow">
        {{ testing.siliconflow ? '⏳' : '🔌' }}
      </button>
      <span class="status-icon" v-if="results.siliconflow">{{
        results.siliconflow.ok ? '✅' : '❌'
      }}</span>
    </div>
    <div
      class="result-msg"
      v-if="results.siliconflow"
      :class="results.siliconflow.ok ? 'success' : 'error'"
    >
      {{ results.siliconflow.message }}
    </div>
    <div class="hint-block">注册: cloud.siliconflow.cn，新用户送 14 元</div>

    <!-- Pexels -->
    <div class="api-row">
      <div class="form-group flex-1">
        <label>Pexels API Key（真实素材搜索）</label>
        <div class="input-with-toggle">
          <input
            v-model="form.pexelsApiKey"
            :type="showKeys.pexels ? 'text' : 'password'"
            placeholder="免费注册获取..."
          />
          <button class="btn-eye" @click="showKeys.pexels = !showKeys.pexels" type="button" aria-label="切换显示 Pexels Key">
            {{ showKeys.pexels ? '👁️' : '👁️‍🗨️' }}
          </button>
        </div>
        <div v-if="validationErrors.pexelsApiKey" class="field-error">{{ validationErrors.pexelsApiKey }}</div>
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
          <input
            v-model="form.tgBotToken"
            :type="showKeys.tg ? 'text' : 'password'"
            placeholder="123456:ABC-DEF..."
          />
          <button class="btn-eye" @click="showKeys.tg = !showKeys.tg" type="button" aria-label="切换显示 TG Token">
            {{ showKeys.tg ? '👁️' : '👁️‍🗨️' }}
          </button>
        </div>
        <div v-if="validationErrors.tgBotToken" class="field-error">{{ validationErrors.tgBotToken }}</div>
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

    <!-- BitBrowser API Key -->
    <div class="api-row">
      <div class="form-group flex-1">
        <label>比特浏览器 API Key（采集认证）</label>
        <div class="input-with-toggle">
          <input
            v-model="form.bitApiKey"
            :type="showKeys.bitKey ? 'text' : 'password'"
            placeholder="32位UUID，如 fee00b3d51cb41bfbe517ff2c25f0ec4"
          />
          <button class="btn-eye" @click="showKeys.bitKey = !showKeys.bitKey" type="button" aria-label="切换显示比特 API Key">
            {{ showKeys.bitKey ? '👁️' : '👁️‍🗨️' }}
          </button>
        </div>
      </div>
    </div>
    <div class="hint-block">
      比特浏览器控制台 → 设置 → API 密钥（32位十六进制 UUID）
    </div>

    <hr class="section-divider" />

    <!-- 账号管理 -->
    <h3 class="section-title">👤 采集账号管理</h3>
    <p class="section-desc">通过比特浏览器 API 自动打开环境采集数据</p>

    <!-- 比特连接测试 -->
    <div class="bit-test-row">
      <button class="btn btn-test" @click="testBit" :disabled="testing.bit">
        {{ testing.bit ? '⏳' : '🔌' }}
      </button>
      <span>测试比特连接</span>
      <span class="status-icon" v-if="results.bit">{{ results.bit.ok ? '✅' : '❌' }}</span>
    </div>
    <div class="result-msg" v-if="results.bit" :class="results.bit.ok ? 'success' : 'error'">
      {{ results.bit.message }}
    </div>

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

    <!-- 数据存储位置 -->
    <h3 class="section-title">📁 数据存储位置</h3>
    <p class="section-desc">产出视频、配置、数据库等所有数据的存储目录（迁移后需重启生效）</p>

    <div class="data-dir-row">
      <div class="form-group flex-1">
        <label>当前数据目录</label>
        <input :value="currentDataDir" disabled class="dir-path-input" />
      </div>
      <button class="btn btn-test" @click="selectDir" title="选择新目录">📂</button>
    </div>

    <div v-if="selectedDir" class="new-dir-box">
      <p class="new-dir-label">新目录：</p>
      <p class="new-dir-path">{{ selectedDir }}</p>
      <button
        class="btn btn-primary"
        @click="startMigrate"
        :disabled="migrating"
      >
        {{ migrating ? '⏳ 迁移中...' : '📦 迁移数据到新目录' }}
      </button>
      <p v-if="migrateDone" class="migrate-hint">✅ 迁移完成，请重启应用生效</p>
    </div>

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
import { reactive, ref, onMounted } from 'vue'
import { useAppStore } from '../stores/app.js'

const store = useAppStore()
const form = reactive({
  deepseekApiKey: '',
  siliconflowApiKey: '',
  pexelsApiKey: '',
  tgBotToken: '',
  tgChannelId: '@your_channel',
  cdpEndpoint: 'http://localhost:9222',
  bitApiKey: '',
  dataDir: '',
  accounts: [],
})
const testing = reactive({ deepseek: false, siliconflow: false, pexels: false, tg: false, bit: false })
const results = reactive({ deepseek: null, siliconflow: null, pexels: null, tg: null, bit: null })
const showKeys = reactive({ deepseek: false, siliconflow: false, pexels: false, tg: false, bitKey: false })
const saving = ref(false)
const errorMsg = ref('')
const validationErrors = reactive({})
const currentDataDir = ref('')
const selectedDir = ref('')
const migrating = ref(false)
const migrateDone = ref(false)

const FIELD_LABELS = {
  deepseekApiKey: 'DeepSeek API Key',
  siliconflowApiKey: '硅基流动 API Key',
  pexelsApiKey: 'Pexels API Key',
  tgBotToken: 'Telegram Bot Token',
  tgChannelId: 'Telegram 频道 ID',
  cdpEndpoint: 'CDP 端口',
}

function validate() {
  for (const k of Object.keys(validationErrors)) delete validationErrors[k]
  if (form.deepseekApiKey && !form.deepseekApiKey.startsWith('sk-')) {
    validationErrors.deepseekApiKey = 'DeepSeek Key 通常以 sk- 开头'
  }
  if (form.siliconflowApiKey && form.siliconflowApiKey.length < 8) {
    validationErrors.siliconflowApiKey = 'API Key 长度不足，请检查'
  }
  if (form.tgBotToken && !/^\d+:[\w-]+$/.test(form.tgBotToken)) {
    validationErrors.tgBotToken = 'Token 格式应为 123456:ABC-DEF...'
  }
  if (form.pexelsApiKey && form.pexelsApiKey.length < 10) {
    validationErrors.pexelsApiKey = 'Key 长度不足，请检查'
  }
  return Object.keys(validationErrors).length === 0
}

onMounted(async () => {
  const config = await window.xnowpost.getConfig()
  Object.assign(form, config)
  const dirResult = await window.xnowpost.getDataDir()
  currentDataDir.value = dirResult.path
})

const saveMsg = ref('')

function addAccount() {
  form.accounts.push({ name: '', platform: 'tiktok', bitEnvId: '' })
}

function removeAccount(i) {
  form.accounts.splice(i, 1)
}

async function save() {
  if (!validate()) {
    errorMsg.value = '请修正标红的字段后再保存'
    return
  }
  saving.value = true
  errorMsg.value = ''
  saveMsg.value = ''
  try {
    await store.saveConfig({ ...form })
    saveMsg.value = '✅ 配置已保存'
    setTimeout(() => (saveMsg.value = ''), 3000)
  } catch (e) {
    errorMsg.value = '保存失败: ' + (e.message || e)
    setTimeout(() => (errorMsg.value = ''), 5000)
  }
  saving.value = false
}

async function test(type) {
  testing[type] = true
  results[type] = null
  errorMsg.value = ''
  try {
    const keyMap = { deepseek: 'deepseekApiKey', siliconflow: 'siliconflowApiKey', pexels: 'pexelsApiKey', tg: 'tgBotToken' }
    const key = form[keyMap[type]] || ''
    results[type] = await window.xnowpost.testApi(type, key)
  } catch (e) {
    results[type] = { ok: false, message: 'IPC 调用失败: ' + (e.message || e) }
  }
  testing[type] = false
}

async function testBit() {
  testing.bit = true
  results.bit = null
  try {
    results.bit = await window.xnowpost.testBit(form.bitApiKey || undefined)
  } catch (e) {
    results.bit = { ok: false, message: '调用失败: ' + (e.message || e) }
  }
  testing.bit = false
}

// === 数据目录 ===
async function selectDir() {
  errorMsg.value = ''
  const result = await window.xnowpost.selectDataDir()
  if (result.ok && result.path) {
    selectedDir.value = result.path
    migrateDone.value = false
  }
}

async function startMigrate() {
  if (!selectedDir.value) return
  migrating.value = true
  errorMsg.value = ''
  migrateDone.value = false
  try {
    const result = await window.xnowpost.migrateData(selectedDir.value)
    if (result.ok) {
      migrateDone.value = true
      currentDataDir.value = selectedDir.value  // 显示迁移后的目录（重启后生效）
    } else {
      errorMsg.value = result.message || '迁移失败'
    }
  } catch (e) {
    errorMsg.value = '迁移失败: ' + (e.message || e)
  }
  migrating.value = false
}
</script>

<style scoped>
h2 {
  font-size: 24px;
  margin-bottom: 24px;
}
.api-row {
  display: flex;
  gap: 10px;
  align-items: flex-end;
  margin-bottom: 4px;
}
.flex-1 {
  flex: 1;
  margin-bottom: 0 !important;
}
.form-group {
  margin-bottom: 16px;
}
.form-group label {
  display: block;
  font-size: 13px;
  color: #94a3b8;
  margin-bottom: 6px;
}
.form-group input {
  width: 100%;
  max-width: 500px;
  padding: 10px 14px;
  border: 1px solid #334155;
  border-radius: 8px;
  background: #1e293b;
  color: #e2e8f0;
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s;
}
.form-group input:focus {
  border-color: #f59e0b;
}
.input-with-toggle {
  display: flex;
  align-items: stretch;
  max-width: 500px;
}
.input-with-toggle input {
  flex: 1;
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
  border-right: none;
  max-width: none;
}
.btn-eye {
  padding: 0 12px;
  border: 1px solid #334155;
  border-left: none;
  border-radius: 0 8px 8px 0;
  background: #1e293b;
  color: #64748b;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  transition: background 0.2s;
}
.btn-eye:hover {
  background: #334155;
  color: #e2e8f0;
}
.hint-block {
  font-size: 11px;
  color: #64748b;
  margin-bottom: 16px;
  margin-left: 2px;
}
.status-icon {
  font-size: 18px;
  padding-bottom: 10px;
}
.btn-row {
  display: flex;
  gap: 12px;
  margin-top: 24px;
}
.btn {
  padding: 10px 24px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.btn-primary {
  background: linear-gradient(135deg, #f59e0b, #d97706);
  color: #0f172a;
}
.btn-test {
  background: #334155;
  color: #e2e8f0;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 18px;
  padding: 8px 14px;
  height: 44px;
  min-width: 48px;
}
.btn-test:hover {
  background: #475569;
}
.btn-test:disabled {
  opacity: 0.5;
}
.result-msg {
  margin-bottom: 12px;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 12px;
  max-width: 500px;
}
.result-msg.success {
  background: #064e3b22;
  color: #22c55e;
  border: 1px solid #064e3b;
}
.result-msg.error {
  background: #7f1d1d22;
  color: #ef4444;
  border: 1px solid #7f1d1d;
}
.section-divider {
  border: none;
  border-top: 1px solid #334155;
  margin: 24px 0;
}
.section-title {
  font-size: 16px;
  color: #e2e8f0;
  margin: 0 0 4px;
}
.section-desc {
  font-size: 12px;
  color: #64748b;
  margin: 0 0 16px;
}

/* 账号列表 */
.account-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}
.account-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 10px 12px;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 8px;
}
.acc-input {
  padding: 7px 10px;
  border: 1px solid #334155;
  border-radius: 6px;
  background: #0f172a;
  color: #e2e8f0;
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s;
}
.acc-input:focus {
  border-color: #f59e0b;
}
.acc-name {
  flex: 2;
  min-width: 80px;
}
.acc-platform {
  flex: 1;
  min-width: 90px;
  cursor: pointer;
}
.acc-env {
  flex: 1;
  min-width: 70px;
}
.btn-del {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #64748b;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s;
  flex-shrink: 0;
}
.btn-del:hover {
  background: #7f1d1d44;
  color: #ef4444;
}
.btn-add-acc {
  padding: 8px 16px;
  border: 2px dashed #334155;
  border-radius: 8px;
  background: transparent;
  color: #64748b;
  cursor: pointer;
  font-size: 13px;
  transition: all 0.15s;
  margin-bottom: 8px;
}
.btn-add-acc:hover {
  border-color: #f59e0b44;
  color: #f59e0b;
}

/* 比特连接测试 */
.bit-test-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.error-banner {
  background: #7f1d1d44;
  color: #fca5a5;
  padding: 10px 14px;
  border-radius: 8px;
  margin-bottom: 12px;
  font-size: 13px;
  border: 1px solid #7f1d1d;
  max-width: 600px;
}
.success-banner {
  background: #064e3b44;
  color: #22c55e;
  padding: 10px 14px;
  border-radius: 8px;
  margin-bottom: 12px;
  font-size: 13px;
  border: 1px solid #064e3b;
  max-width: 600px;
}
.field-error {
  font-size: 11px;
  color: #ef4444;
  margin-top: 4px;
  padding-left: 2px;
}

/* 数据目录 */
.data-dir-row {
  display: flex;
  gap: 10px;
  align-items: flex-end;
  margin-bottom: 4px;
}
.dir-path-input {
  width: 100%;
  max-width: 500px;
  padding: 10px 14px;
  border: 1px solid #334155;
  border-radius: 8px;
  background: #0f172a;
  color: #94a3b8;
  font-size: 13px;
  outline: none;
  font-family: monospace;
}
.new-dir-box {
  margin-top: 12px;
  padding: 12px 16px;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 8px;
  max-width: 500px;
}
.new-dir-label {
  font-size: 12px;
  color: #64748b;
  margin: 0 0 4px;
}
.new-dir-path {
  font-size: 13px;
  color: #e2e8f0;
  font-family: monospace;
  margin: 0 0 12px;
  word-break: break-all;
}
.migrate-hint {
  margin-top: 8px;
  font-size: 13px;
  color: #22c55e;
}
</style>
