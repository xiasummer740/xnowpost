<template>
  <div class="schedule-page">
    <div class="page-header">
      <h2>⏰ 定时闹钟</h2>
      <p class="subtitle">每天固定时间自动产出内容，保存后立即生效</p>
    </div>

    <!-- 📊 采集面板（独立于闹钟） -->
    <div class="collect-panel">
      <div class="cp-header" @click="collectExpanded = !collectExpanded">
        <span>📊 采集面板</span>
        <span class="cp-toggle">{{ collectExpanded ? '收起 ▲' : '展开 ▼' }}</span>
      </div>
      <div class="cp-body" v-if="collectExpanded">
        <div class="cp-hint">勾选要采集的账号，点击「开始采集」立即执行</div>
        <div class="cp-acc-list">
          <label v-for="acc in uniqueAccounts" :key="acc.name" class="cp-acc-item">
            <input type="checkbox" :value="acc.name" v-model="collectSelection" />
            <span class="cp-acc-name">{{ acc.name }}</span>
            <span class="cp-acc-plat">{{ platformLabel(acc.platform) }}</span>
            <span class="cp-acc-env" :class="acc.bitEnvId ? 'ok' : ''">{{ acc.bitEnvId ? '✅' : '⚠️ 未配置环境' }}</span>
          </label>
          <div v-if="uniqueAccounts.length === 0" class="cp-empty">暂无账号，请先到配置页添加</div>
        </div>
        <div class="cp-actions">
          <button class="btn btn-primary btn-sm" @click="selectAllCollect">全选</button>
          <button class="btn btn-secondary btn-sm" @click="collectSelection = []">清空</button>
          <button class="btn btn-collect btn-sm" @click="startCollect" :disabled="collectRunning || collectSelection.length === 0">
            {{ collectRunning ? '⏳ 采集中...' : '🚀 开始采集' }}
          </button>
          <span v-if="collectDone" class="cp-done">✅ 采集完成</span>
        </div>

        <!-- 定时采集 -->
        <div class="cp-schedule">
          <span class="cp-sch-label">⏰ 定时采集</span>
          <TimePicker v-model="collectTime" />
          <button class="btn btn-primary btn-sm" @click="saveCollectSchedule" :disabled="!collectTime">
            💾 保存
          </button>
          <span v-if="collectSchedSaved" class="cp-done">✅ 已保存</span>
          <span v-if="collectSchedActive" class="cp-active">🟢 每天 {{ collectTime }} 自动执行</span>
        </div>
      </div>
    </div>

    <!-- 一键开关 -->
    <div class="toggle-all-bar">
      <span class="toggle-all-label">批量操作</span>
      <button class="toggle-all-btn toggle-all-on" @click="toggleAll(true)">✅ 全部开启</button>
      <button class="toggle-all-btn toggle-all-off" @click="toggleAll(false)">⛔ 全部关闭</button>
    </div>

    <!-- 按账号分组循环 -->
    <div v-for="(group, gIdx) in groupedJobs" :key="gIdx" class="alarm-group">
      <div class="group-header" v-if="group.account">
        <span class="group-avatar">👤</span>
        <span class="group-name">{{ group.account === 'default' ? '默认账号' : group.account }}</span>
        <span class="group-count">{{ group.jobs.length }} 个闹钟</span>
      </div>
      <div class="group-header" v-else>
        <span class="group-avatar">📋</span>
        <span class="group-name">未指定账号</span>
        <span class="group-count">{{ group.jobs.length }} 个闹钟</span>
      </div>

      <div class="alarm-row">
        <div
          v-for="(job, jIdx) in group.jobs"
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
            <button class="btn-delete" @click="removeJob(globalIndex(group, jIdx))" title="删除闹钟">✕</button>
          </div>

          <!-- 模式标签 -->
          <div class="mode-row">
            <span
              v-for="opt in modeOptions"
              :key="opt.value"
              class="mode-chip"
              :class="{ active: job.mode === opt.value }"
              @click="setMode(globalIndex(group, jIdx), opt.value)"
              >{{ opt.label }}</span
            >
          </div>

          <!-- 账号选择 -->
          <div class="acc-row">
            <div class="acc-picker" @click.stop>
              <input
                class="acc-input"
                :value="displayAccountName(job.account)"
                @input="onAccSearch($event, globalIndex(group, jIdx))"
                @focus="onAccFocus(globalIndex(group, jIdx))"
                @blur="onAccBlur(globalIndex(group, jIdx))"
                @keydown.down.prevent="onAccArrow(globalIndex(group, jIdx), 1)"
                @keydown.up.prevent="onAccArrow(globalIndex(group, jIdx), -1)"
                @keydown.enter.prevent="onAccEnter(globalIndex(group, jIdx))"
                placeholder="输入账号名搜索..."
              />
              <div v-if="job._showDropdown" class="acc-dropdown">
                <div
                  v-for="(acc, ai) in filteredAccs(globalIndex(group, jIdx))"
                  :key="acc.name"
                  class="acc-opt"
                  :class="{ 'acc-opt-active': ai === job._highlightIdx }"
                  @mousedown.prevent="selectAcc(globalIndex(group, jIdx), acc.name)"
                >
                  <span class="acc-opt-name">{{ acc.name }}</span>
                  <span class="acc-opt-env" v-if="!acc.bitEnvId">⚠️ 未配置</span>
                  <span class="acc-opt-env ok" v-else>✅</span>
                </div>
                <div v-if="filteredAccs(globalIndex(group, jIdx)).length === 0" class="acc-opt acc-opt-empty">无匹配账号</div>
              </div>
            </div>
            <span
              v-if="job.account"
              class="acc-badge"
              :style="{ background: accountColor(job.account) }"
            >{{ job.account }}</span>
            <span class="acc-hint" v-if="job.account">→ 发布</span>
            <button class="btn-clone" @click="cloneJob(globalIndex(group, jIdx))" title="复制此闹钟">📋</button>
          </div>

          <!-- 名称 -->
          <input v-model="job.label" class="label-input" placeholder="闹钟名称（如：早间内容）" />
        </div>
      </div>
    </div>

    <button class="btn btn-add" @click="addJob">➕ 添加闹钟</button>

    <div class="save-bar">
      <button class="btn btn-primary" @click="save" :disabled="saving">
        {{ saving ? '保存中...' : '💾 保存全部' }}
      </button>
      <span v-if="saved" class="saved-hint">✅ 已保存</span>
      <span v-if="saveError" class="error-banner">{{ saveError }}</span>
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
import { MODE_OPTIONS as modeOptions, MODE_LABEL_MAP as modeLabelMap } from '../constants.js'

const jobs = ref([])
const accounts = ref([])
const saving = ref(false)
const saved = ref(false)
const saveError = ref('')
const searchTexts = ref({})  // 每个闹钟的账号搜索文本

// 采集面板
const collectExpanded = ref(false)
const collectSelection = ref([])
const collectRunning = ref(false)
const collectDone = ref(false)
const collectTime = ref('21:00')
const collectSchedSaved = ref(false)
const collectSchedActive = ref(false)

// 去重后的账号列表（按名称去重，保留第一个）
const uniqueAccounts = computed(() => {
  const seen = new Set()
  return sortedAccounts.value.filter(a => {
    if (seen.has(a.name)) return false
    seen.add(a.name)
    return true
  })
})

function platformLabel(val) {
  const map = { tiktok:'TikTok', xiaohongshu:'小红书', facebook:'Facebook', instagram:'Instagram', youtube:'YouTube', x:'X (Twitter)' }
  return map[val] || val
}
function selectAllCollect() {
  collectSelection.value = uniqueAccounts.value.map(a => a.name)
}
async function startCollect() {
  if (collectSelection.value.length === 0) return
  collectRunning.value = true
  collectDone.value = false
  try {
    const result = await window.xnowpost.runCollect(collectSelection.value)
    if (!result.ok) {
      console.error('采集失败:', result.message)
    }
    collectDone.value = true
    setTimeout(() => { collectDone.value = false }, 3000)
  } catch (e) {
    console.error('采集调用失败:', e)
  } finally {
    collectRunning.value = false
  }
}
async function saveCollectSchedule() {
  if (!collectTime.value) return
  collectSchedSaved.value = false
  try {
    // 保存一个特殊的 schedule 条目，mode 为 collect
    const schedules = await window.xnowpost.getSchedules()
    // 移除旧的 collect 定时任务
    const filtered = schedules.filter(j => j.mode !== 'collect')
    filtered.push({
      id: Date.now(),
      time: collectTime.value,
      mode: 'collect',
      label: '数据采集 + 日报',
      enabled: true,
      collectAccounts: collectSelection.value.join(','),
    })
    const result = await window.xnowpost.saveSchedules(filtered)
    if (result && result.ok) {
      collectSchedSaved.value = true
      collectSchedActive.value = true
      setTimeout(() => { collectSchedSaved.value = false }, 3000)
    }
  } catch (e) {
    console.error('保存采集定时失败:', e)
  }
}

// 加载时检查是否有 collect 的定时任务
onMounted(async () => {
  await load()
  // 检测现有 collect 定时任务
  const sched = await window.xnowpost.getSchedules()
  const collectJob = (sched || []).find(j => j.mode === 'collect')
  if (collectJob) {
    collectTime.value = collectJob.time || '21:00'
    collectSchedActive.value = collectJob.enabled !== false
    // 恢复上一次勾选的账号
    if (collectJob.collectAccounts) {
      collectSelection.value = collectJob.collectAccounts.split(',').filter(Boolean)
    }
  }
})

// modeOptions imported from constants.js

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
  // 同步旧标签：确保标签与模式一致（"早间内容"→"视频+图文"等）
  for (const job of jobs.value) {
    if (modeLabelMap[job.mode] && job.label !== modeLabelMap[job.mode]) {
      job.label = modeLabelMap[job.mode]
    }
  }
  // 加载账号列表（用于闹钟的账号选择器）
  try {
    const config = await window.xnowpost.getConfig()
    accounts.value = config.accounts || []
  } catch (_) {}
}

function resetDefaults() {
  jobs.value = [
    { id: 1, time: '07:00', mode: 'auto',  label: '视频+图文', enabled: false, account: '' },
    { id: 2, time: '19:00', mode: 'video', label: '仅视频',    enabled: false, account: '' },
  ]
}

let nextId = 100
function addJob() {
  jobs.value.push({
    id: nextId++,
    time: '12:00',
    mode: 'auto',
    label: '视频+图文',
    enabled: true,
    account: '',
  })
}

// modeLabelMap imported from constants.js

// 设置模式 + 自动更新标签
function setMode(i, val) {
  const job = jobs.value[i]
  job.mode = val
  // 标签始终跟随模式选择
  job.label = modeLabelMap[val] || val
}

function cloneJob(i) {
  const orig = jobs.value[i]
  jobs.value.splice(i + 1, 0, {
    ...structuredClone(orig),
    id: nextId++,
    label: orig.label + ' (复制)',
  })
}

function removeJob(i) {
  jobs.value.splice(i, 1)
  // 清理已删除闹钟的搜索文本缓存
  delete searchTexts.value[i]
}

function toggleAll(enabled) {
  jobs.value.forEach(j => (j.enabled = enabled))
}

// 按账号分组（同账号闹钟排一起，无账号的放最后）
const groupedJobs = computed(() => {
  const groups = {}
  for (const job of jobs.value) {
    const key = job.account || ''
    if (!groups[key]) groups[key] = { account: job.account || '', jobs: [] }
    groups[key].jobs.push(job)
  }
  // 有账号的组在前，无账号在后
  const hasAccount = Object.entries(groups).filter(([k]) => k)
  const noAccount = Object.entries(groups).filter(([k]) => !k)
  hasAccount.sort(([a], [b]) => a.localeCompare(b))
  return [...hasAccount, ...noAccount].map(([, v]) => v)
})

// 获取组内闹钟在全局 jobs 中的索引
function globalIndex(group, jIdx) {
  return jobs.value.indexOf(group.jobs[jIdx])
}

async function save() {
  saving.value = true
  try {
    const raw = structuredClone(jobs.value.map(j => {
      const { _showDropdown, _highlightIdx, ...rest } = j
      return rest
    }))
    const result = await window.xnowpost.saveSchedules(raw)
    if (!result || !result.ok) {
      saveError.value = result?.message || '保存失败'
    } else {
      saved.value = true
      saveError.value = ''
      setTimeout(() => (saved.value = false), 3000)
    }
  } catch (err) {
    saveError.value = err.message || '保存异常'
  } finally {
    saving.value = false
  }
}

</script>

<style scoped>
.schedule-page {
  max-width: none;
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
  font-size: 14px;
  color: #94a3b8;
  margin: 0;
}

/* 按账号分组 */
.alarm-group {
  margin-bottom: 16px;
}
.group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding: 6px 12px;
  background: #1e293b;
  border-radius: 8px;
  border: 1px solid #334155;
}
.group-avatar { font-size: 14px; }
.group-name { font-size: 13px; font-weight: 700; color: #60a5fa; }
.group-count {
  margin-left: auto;
  font-size: 11px;
  color: #64748b;
  background: #0f172a;
  padding: 2px 8px;
  border-radius: 10px;
}

/* 同一账号的闹钟排在一行，自动折行 */
.alarm-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.alarm-row > .alarm-card {
  flex: 1 1 280px;
  min-width: 0;
}

/* 一键开关栏 */
.toggle-all-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 8px 12px;
  background: #1e293b;
  border-radius: 8px;
  border: 1px solid #334155;
}
.toggle-all-label {
  font-size: 12px;
  font-weight: 600;
  color: #64748b;
  margin-right: 4px;
}
.toggle-all-btn {
  padding: 5px 12px;
  border-radius: 6px;
  border: none;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}
.toggle-all-btn:hover {
  transform: translateY(-1px);
}
.toggle-all-on {
  background: #22c55e22;
  color: #22c55e;
  border: 1px solid #22c55e44;
}
.toggle-all-on:hover {
  background: #22c55e44;
}
.toggle-all-off {
  background: #ef444422;
  color: #ef4444;
  border: 1px solid #ef444444;
}
.toggle-all-off:hover {
  background: #ef444444;
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
.error-banner {
  font-size: 13px;
  color: #ef4444;
  background: #7f1d1d44;
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid #7f1d1d;
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

/* 采集面板 */
.collect-panel {
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 10px;
  margin-bottom: 16px;
  overflow: hidden;
}
.cp-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 700;
  color: #22c55e;
  user-select: none;
}
.cp-header:hover { background: #33415533; }
.cp-toggle { font-size: 11px; color: #64748b; font-weight: 400; }
.cp-body { padding: 0 14px 14px; border-top: 1px solid #334155; }
.cp-hint { font-size: 12px; color: #64748b; margin: 10px 0; }
.cp-acc-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
.cp-acc-item {
  display: flex; align-items: center; gap: 10px;
  padding: 6px 8px; border-radius: 6px;
  cursor: pointer; font-size: 13px;
  transition: background 0.15s;
}
.cp-acc-item:hover { background: #33415566; }
.cp-acc-item input[type="checkbox"] { accent-color: #22c55e; }
.cp-acc-name { font-weight: 600; color: #e2e8f0; }
.cp-acc-plat { font-size: 11px; color: #64748b; }
.cp-acc-env { margin-left: auto; font-size: 11px; color: #ef4444; }
.cp-acc-env.ok { color: #22c55e; }
.cp-empty { font-size: 12px; color: #64748b; padding: 10px 0; text-align: center; }
.cp-actions { display: flex; gap: 8px; align-items: center; }
.btn-sm { padding: 6px 14px; font-size: 12px; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; }
.btn-collect { background: #22c55e; color: #0f172a; }
.btn-collect:hover:not(:disabled) { background: #16a34a; }
.btn-collect:disabled { opacity: 0.5; cursor: not-allowed; }
.cp-done { font-size: 12px; font-weight: 600; color: #22c55e; }

/* 定时采集 */
.cp-schedule {
  display: flex; align-items: center; gap: 10px;
  margin-top: 12px; padding-top: 12px;
  border-top: 1px solid #334155;
}
.cp-sch-label { font-size: 13px; font-weight: 600; color: #94a3b8; white-space: nowrap; }
.cp-active { font-size: 11px; color: #22c55e; font-weight: 600; }

</style>
