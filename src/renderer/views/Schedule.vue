<template>
  <div class="schedule-page">
    <div class="page-header">
      <h2>⏰ 定时闹钟</h2>
      <p class="subtitle">每天固定时间自动产出内容，保存后立即生效</p>
    </div>

    <div class="alarm-list">
      <div
        v-for="(job, i) in jobs"
        :key="job.id"
        class="alarm-card"
        :class="{ disabled: !job.enabled }"
      >
        <div class="card-row">
          <!-- 开关 -->
          <label class="toggle-switch">
            <input type="checkbox" v-model="job.enabled" />
            <span class="toggle-slider"></span>
          </label>

          <!-- 时间 -->
          <TimePicker v-model="job.time" />

          <!-- 删除 -->
          <button class="btn-delete" @click="removeJob(i)" title="删除闹钟">✕</button>
        </div>

        <!-- 模式标签 -->
        <div class="mode-row">
          <span
            v-for="opt in modeOptions"
            :key="opt.value"
            class="mode-chip"
            :class="{ active: job.mode === opt.value }"
            @click="job.mode = opt.value"
            >{{ opt.label }}</span
          >
        </div>

        <!-- 账号选择（生成模式才显示） -->
        <div class="acc-row" v-if="job.mode !== 'collect' && job.mode !== 'publish'">
          <div class="acc-picker" @click.stop>
            <input
              class="acc-input"
              :value="displayAccountName(job.account)"
              @input="onAccSearch($event, i)"
              @focus="onAccFocus(i)"
              @blur="onAccBlur(i)"
              @keydown.down.prevent="onAccArrow(i, 1)"
              @keydown.up.prevent="onAccArrow(i, -1)"
              @keydown.enter.prevent="onAccEnter(i)"
              placeholder="输入账号名搜索..."
            />
            <div v-if="job._showDropdown" class="acc-dropdown">
              <div
                v-for="(acc, ai) in filteredAccs(i)"
                :key="acc.name"
                class="acc-opt"
                :class="{ 'acc-opt-active': ai === job._highlightIdx }"
                @mousedown.prevent="selectAcc(i, acc.name)"
              >
                <span class="acc-opt-name">{{ acc.name }}</span>
                <span class="acc-opt-env" v-if="!acc.bitEnvId">⚠️ 未配置</span>
                <span class="acc-opt-env ok" v-else>✅</span>
              </div>
              <div v-if="filteredAccs(i).length === 0" class="acc-opt acc-opt-empty">无匹配账号</div>
            </div>
          </div>
          <span
            v-if="job.account"
            class="acc-badge"
            :style="{ background: accountColor(job.account) }"
          >{{ job.account }}</span>
          <span class="acc-hint" v-if="job.account">→ 发布</span>
          <button class="btn-clone" @click="cloneJob(i)" title="复制此闹钟">📋</button>
        </div>

        <!-- 名称 -->
        <input v-model="job.label" class="label-input" placeholder="闹钟名称（如：早间内容）" />
      </div>
    </div>

    <button class="btn btn-add" @click="addJob">➕ 添加闹钟</button>

    <div class="save-bar">
      <button class="btn btn-primary" @click="save" :disabled="saving">
        {{ saving ? '保存中...' : '💾 保存全部' }}
      </button>
      <span v-if="saved" class="saved-hint">✅ 已保存</span>
    </div>

    <div class="tips">
      <span class="tips-icon">💡</span>
      <div>
        <p>关闭开关 = 暂停闹钟，配置保留</p>
        <p>选择「账号」= 生成后自动发布到此账号，不选 = 仅生成</p>
        <p>桌面版启动后调度器自动在后台运行</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'

import TimePicker from '../components/TimePicker.vue'

const jobs = ref([])
const accounts = ref([])
const saving = ref(false)
const saved = ref(false)
const searchTexts = ref({})  // 每个闹钟的账号搜索文本

const modeOptions = [
  { value: 'auto', label: '视频+图文' },
  { value: 'video', label: '仅视频' },
  { value: 'post', label: '仅图文' },
  { value: 'collect', label: '采集+日报' },
  { value: 'publish', label: '批量发布(旧)', icon: '📤' },
]

// 账号按名称排序
const sortedAccounts = computed(() =>
  [...accounts.value].sort((a, b) => a.name.localeCompare(b.name))
)

// 账号颜色映射（基于名称的稳定色）
const accColors = {}
function accountColor(name) {
  if (!accColors[name]) {
    const palette = ['#f59e0b','#22c55e','#3b82f6','#ef4444','#8b5cf6','#ec4899','#14b8a6','#f97316','#6366f1','#84cc16','#06b6d4','#d946ef']
    let h = 0
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) % palette.length
    accColors[name] = palette[h]
  }
  return accColors[name]
}

// 显示账号名
function displayAccountName(accName) {
  if (!accName || !sortedAccounts.value.find(a => a.name === accName)) return accName || ''
  return accName
}

// 当前闹钟的过滤后账号列表
function filteredAccs(jobIdx) {
  const q = (searchTexts.value[jobIdx] || '').toLowerCase()
  if (!q) return sortedAccounts.value
  return sortedAccounts.value.filter(a => a.name.toLowerCase().includes(q))
}

// 搜索输入
function onAccSearch(e, i) {
  searchTexts.value[i] = e.target.value
  jobs.value[i]._showDropdown = true
  jobs.value[i]._highlightIdx = 0
}

// 聚焦→显示下拉
function onAccFocus(i) {
  searchTexts.value[i] = ''
  jobs.value[i]._showDropdown = true
  jobs.value[i]._highlightIdx = 0
}

// 失焦→隐藏下拉（延迟给点击选项留时间）
function onAccBlur(i) {
  setTimeout(() => { jobs.value[i]._showDropdown = false }, 150)
}

// 上下箭头
function onAccArrow(i, dir) {
  const list = filteredAccs(i)
  const cur = jobs.value[i]._highlightIdx ?? 0
  jobs.value[i]._highlightIdx = Math.max(0, Math.min(list.length - 1, cur + dir))
}

// 回车选中
function onAccEnter(i) {
  const list = filteredAccs(i)
  const idx = jobs.value[i]._highlightIdx ?? 0
  if (list[idx]) selectAcc(i, list[idx].name)
}

// 选中账号
function selectAcc(i, name) {
  jobs.value[i].account = name
  jobs.value[i]._showDropdown = false
  searchTexts.value[i] = ''
}

// ===== 闹钟管理 =====

async function load() {
  jobs.value = await window.xnowpost.getSchedules()
  if (!jobs.value.length) resetDefaults()
  // 加载账号列表（用于闹钟的账号选择器）
  try {
    const config = await window.xnowpost.getConfig()
    accounts.value = config.accounts || []
  } catch (_) {}
}

function resetDefaults() {
  jobs.value = [
    { id: 1, time: '07:00', mode: 'auto',  label: '早间内容（视频+图文）', enabled: false, account: '' },
    { id: 2, time: '19:00', mode: 'video', label: '晚间视频',             enabled: false, account: '' },
    { id: 3, time: '21:00', mode: 'collect', label: '数据采集 + 日报',     enabled: false },
  ]
}

let nextId = 100
function addJob() {
  jobs.value.push({
    id: nextId++,
    time: '12:00',
    mode: 'auto',
    label: '新闹钟',
    enabled: true,
    account: '',
  })
}

function cloneJob(i) {
  const orig = jobs.value[i]
  jobs.value.splice(i + 1, 0, {
    ...JSON.parse(JSON.stringify(orig)),
    id: nextId++,
    label: orig.label + ' (复制)',
  })
}

function removeJob(i) {
  jobs.value.splice(i, 1)
}

async function save() {
  saving.value = true
  try {
    const raw = JSON.parse(JSON.stringify(jobs.value.map(j => {
      const { _showDropdown, _highlightIdx, ...rest } = j
      return rest
    })))
    const result = await window.xnowpost.saveSchedules(raw)
    if (!result || !result.ok) {
      alert('保存失败: ' + (result?.message || '未知错误'))
    } else {
      saved.value = true
      setTimeout(() => (saved.value = false), 3000)
    }
  } catch (err) {
    console.error('保存定时任务异常:', err)
    alert('保存异常: ' + err.message)
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.schedule-page {
  max-width: 600px;
  margin: 0 auto;
}

.page-header {
  margin-bottom: 20px;
}
h2 {
  font-size: 22px;
  margin: 0 0 4px;
}
.subtitle {
  font-size: 13px;
  color: #94a3b8;
  margin: 0;
}

/* 闹钟列表 — 两列网格 */
.alarm-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-bottom: 16px;
}
@media (max-width: 640px) {
  .alarm-list {
    grid-template-columns: 1fr;
  }
}

/* 闹钟卡片 */
.alarm-card {
  background: #2a3a4e;
  border: 1px solid #3b4f66;
  border-radius: 10px;
  padding: 14px;
  transition: all 0.2s;
}
.alarm-card:hover {
  border-color: #475569;
}
.alarm-card.disabled {
  opacity: 0.4;
}

/* 顶部行：开关 + 时间 + 删除 */
.card-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

/* 开关 */
.toggle-switch {
  position: relative;
  display: inline-block;
  width: 40px;
  height: 22px;
  cursor: pointer;
  flex-shrink: 0;
}
.toggle-switch input {
  display: none;
}
.toggle-slider {
  position: absolute;
  inset: 0;
  background: #475569;
  border-radius: 11px;
  transition: 0.25s;
}
.toggle-slider::before {
  content: '';
  position: absolute;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  top: 3px;
  left: 3px;
  transition: 0.25s;
}
.toggle-switch input:checked + .toggle-slider {
  background: #22c55e;
}
.toggle-switch input:checked + .toggle-slider::before {
  transform: translateX(18px);
}

/* 删除 */
.btn-delete {
  width: 30px;
  height: 30px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: #64748b;
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: 0.2s;
  flex-shrink: 0;
}
.btn-delete:hover {
  background: #7f1d1d44;
  color: #ef4444;
}

/* 模式标签行 */
.mode-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}
.mode-chip {
  padding: 4px 10px;
  border-radius: 5px;
  font-size: 12px;
  font-weight: 600;
  background: #1e293b;
  color: #94a3b8;
  border: 1px solid #334155;
  cursor: pointer;
  transition: all 0.15s;
  user-select: none;
}
.mode-chip:hover {
  color: #cbd5e1;
  border-color: #475569;
}
.mode-chip.active {
  background: #f59e0b;
  color: #0f172a;
  border-color: #f59e0b;
}

/* 账号选择行 */
.acc-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

/* 账号搜索选择器 */
.acc-picker {
  position: relative;
  flex: 1;
  min-width: 0;
}
.acc-input {
  width: 100%;
  padding: 4px 8px;
  border-radius: 5px;
  font-size: 12px;
  font-weight: 600;
  background: #1e293b;
  color: #cbd5e1;
  border: 1px solid #3b4f66;
  outline: none;
  box-sizing: border-box;
}
.acc-input:focus {
  border-color: #f59e0b;
  color: #f1f5f9;
}
.acc-input::placeholder {
  color: #64748b;
  font-weight: 400;
}
.acc-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 100;
  max-height: 240px;
  overflow-y: auto;
  background: #2a3a4e;
  border: 1px solid #475569;
  border-radius: 6px;
  margin-top: 2px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
}
.acc-opt {
  padding: 6px 10px;
  font-size: 12px;
  color: #cbd5e1;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
}
.acc-opt:hover,
.acc-opt-active {
  background: #3b4f66;
  color: #f1f5f9;
}
.acc-opt-name {
  flex: 1;
}
.acc-opt-env {
  font-size: 10px;
  color: #ef4444;
}
.acc-opt-env.ok {
  color: #22c55e;
}
.acc-opt-empty {
  color: #64748b;
  cursor: default;
}

/* 账号彩色标签 */
.acc-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  color: #0f172a;
  white-space: nowrap;
  flex-shrink: 0;
}

.acc-hint {
  font-size: 11px;
  color: #22c55e;
  white-space: nowrap;
}

/* 复制按钮 */
.btn-clone {
  padding: 2px 6px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: #64748b;
  cursor: pointer;
  font-size: 14px;
  flex-shrink: 0;
  transition: 0.15s;
}
.btn-clone:hover {
  color: #f59e0b;
  background: #f59e0b22;
}

/* 名称 */
.label-input {
  width: 100%;
  padding: 6px 0;
  background: transparent;
  border: none;
  border-top: 1px solid #334155;
  color: #cbd5e1;
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
}
.label-input:focus {
  color: #f1f5f9;
  border-top-color: #475569;
}
.label-input::placeholder {
  color: #64748b;
}

/* 添加按钮 */
.btn-add {
  width: 100%;
  padding: 12px;
  border: 2px dashed #334155;
  border-radius: 10px;
  background: transparent;
  color: #64748b;
  font-size: 14px;
  cursor: pointer;
  margin-bottom: 20px;
  transition: 0.2s;
}
.btn-add:hover {
  border-color: #f59e0b44;
  color: #f59e0b;
}

/* 保存栏 */
.save-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 24px;
}
.btn {
  padding: 10px 24px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-primary {
  background: linear-gradient(135deg, #f59e0b, #d97706);
  color: #0f172a;
}
.btn-primary:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(245, 158, 11, 0.3);
}
.saved-hint {
  font-size: 13px;
  color: #22c55e;
}

/* 提示 */
.tips {
  display: flex;
  gap: 10px;
  background: #1e293b;
  border-radius: 8px;
  padding: 12px 14px;
}
.tips-icon {
  font-size: 15px;
  line-height: 1.6;
}
.tips p {
  margin: 0;
  font-size: 12px;
  color: #64748b;
  line-height: 1.8;
}
.tips p + p {
  margin-top: 2px;
}
</style>
