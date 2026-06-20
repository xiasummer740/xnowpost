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
        <p>桌面版启动后调度器自动在后台运行</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'

import TimePicker from '../components/TimePicker.vue'

const jobs = ref([])
const saving = ref(false)
const saved = ref(false)

const modeOptions = [
  { value: 'auto', label: '视频+图文' },
  { value: 'video', label: '仅视频' },
  { value: 'post', label: '仅图文' },
  { value: 'collect', label: '采集+日报' },
]

async function load() {
  jobs.value = await window.xnowpost.getSchedules()
  if (!jobs.value.length) resetDefaults()
}

function resetDefaults() {
  // 默认全部关闭，用户按需开启
  jobs.value = [
    { id: 1, time: '07:00', mode: 'auto', label: '早间内容（视频+图文）', enabled: false },
    { id: 2, time: '19:00', mode: 'video', label: '晚间视频', enabled: false },
    { id: 3, time: '21:00', mode: 'collect', label: '数据采集 + 日报', enabled: false },
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
  })
}

function removeJob(i) {
  jobs.value.splice(i, 1)
}

async function save() {
  saving.value = true
  try {
    const raw = JSON.parse(JSON.stringify(jobs.value))
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
  color: #64748b;
  margin: 0;
}

/* 闹钟列表 */
.alarm-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 16px;
}

/* 闹钟卡片 */
.alarm-card {
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 10px;
  padding: 16px;
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
  background: #0f172a;
  color: #64748b;
  border: 1px solid #1e293b;
  cursor: pointer;
  transition: all 0.15s;
  user-select: none;
}
.mode-chip:hover {
  color: #94a3b8;
  border-color: #334155;
}
.mode-chip.active {
  background: #f59e0b;
  color: #0f172a;
  border-color: #f59e0b;
}

/* 名称 */
.label-input {
  width: 100%;
  padding: 6px 0;
  background: transparent;
  border: none;
  border-top: 1px solid #1e293b;
  color: #94a3b8;
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
}
.label-input:focus {
  color: #e2e8f0;
  border-top-color: #334155;
}
.label-input::placeholder {
  color: #475569;
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
