<template>
  <div class="schedule-page">
    <h2>⏰ 定时闹钟</h2>
    <p class="subtitle">设置每天固定时间自动产出内容，修改后无需重启立即生效</p>

    <div class="alarm-list">
      <div v-for="(job, i) in jobs" :key="job.id" class="alarm-card" :class="{ disabled: !job.enabled }">
        <div class="alarm-left">
          <label class="toggle-switch">
            <input type="checkbox" v-model="job.enabled" />
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="alarm-body">
          <div class="alarm-time-row">
            <input type="time" v-model="job.time" class="time-input" />
            <select v-model="job.mode" class="mode-select">
              <option value="auto">视频+图文</option>
              <option value="video">仅视频</option>
              <option value="post">仅图文</option>
              <option value="collect">数据采集+日报</option>
            </select>
          </div>
          <input v-model="job.label" class="label-input" placeholder="闹钟名称" />
        </div>
        <div class="alarm-right">
          <button class="btn-delete" @click="removeJob(i)" title="删除">✕</button>
        </div>
      </div>
    </div>

    <button class="btn btn-add" @click="addJob">➕ 添加闹钟</button>

    <div class="save-bar">
      <button class="btn btn-primary" @click="save" :disabled="saving">
        {{ saving ? '保存中...' : '💾 保存全部' }}
      </button>
      <span v-if="saved" class="saved-hint">✅ 已保存，调度器自动热加载</span>
    </div>

    <div class="tips">
      <h4>💡 说明</h4>
      <ul>
        <li>修改后自动保存，运行中的 <code>scheduler.js</code> 会热加载新配置</li>
        <li>需要先启动调度器：<code>npm run dev</code> 或后台运行 <code>node src/scheduler.js</code></li>
        <li>关闭闹钟开关 = 暂停，不删除配置</li>
      </ul>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';

const jobs = ref([]);
const saving = ref(false);
const saved = ref(false);

async function load() {
  jobs.value = await window.xnowpost.getSchedules();
  if (!jobs.value.length) resetDefaults();
}

function resetDefaults() {
  jobs.value = [
    { id: 1, time: '07:00', mode: 'auto', label: '早间内容（视频+图文）', enabled: true },
    { id: 2, time: '19:00', mode: 'video', label: '晚间视频', enabled: true },
    { id: 3, time: '21:00', mode: 'collect', label: '数据采集 + 日报', enabled: false },
  ];
}

let nextId = 100;
function addJob() {
  jobs.value.push({
    id: nextId++,
    time: '12:00',
    mode: 'auto',
    label: '新闹钟',
    enabled: true,
  });
}

function removeJob(i) {
  jobs.value.splice(i, 1);
}

async function save() {
  saving.value = true;
  // 超时保护：5秒没返回强制恢复 UI
  const timeout = setTimeout(() => {
    console.warn('保存超时，强制恢复 UI');
    saving.value = false;
    alert('保存超时，请检查 main.js 中 schedule:save handler 是否注册');
  }, 5000);

  try {
    // 检查 saveSchedules 是否存在
    if (typeof window.xnowpost.saveSchedules !== 'function') {
      throw new Error('saveSchedules 未定义，请重启应用');
    }
    const result = await window.xnowpost.saveSchedules(jobs.value);
    clearTimeout(timeout);
    if (!result || !result.ok) {
      console.error('保存失败:', result?.message || '未知错误');
      alert('保存失败: ' + (result?.message || '请检查控制台'));
    } else {
      saved.value = true;
      setTimeout(() => saved.value = false, 3000);
    }
  } catch (err) {
    clearTimeout(timeout);
    console.error('保存定时任务异常:', err);
    alert('保存异常: ' + err.message);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
h2 { font-size: 24px; margin-bottom: 4px; }
.subtitle { font-size: 13px; color: #64748b; margin-bottom: 24px; }

.alarm-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
.alarm-card {
  display: flex; align-items: center; gap: 14px;
  padding: 16px; background: #1e293b; border-radius: 10px;
  border: 1px solid #334155; transition: all 0.2s;
}
.alarm-card.disabled { opacity: 0.5; border-color: #1e293b; }

.alarm-left { flex-shrink: 0; }
.toggle-switch { position: relative; display: inline-block; width: 44px; height: 24px; cursor: pointer; }
.toggle-switch input { display: none; }
.toggle-slider {
  position: absolute; inset: 0; background: #475569; border-radius: 12px; transition: 0.3s;
}
.toggle-slider::before {
  content: ''; position: absolute; width: 18px; height: 18px; border-radius: 50%;
  background: #fff; top: 3px; left: 3px; transition: 0.3s;
}
.toggle-switch input:checked + .toggle-slider { background: #f59e0b; }
.toggle-switch input:checked + .toggle-slider::before { transform: translateX(20px); }

.alarm-body { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.alarm-time-row { display: flex; gap: 8px; align-items: center; }
.time-input {
  padding: 6px 10px; border: 1px solid #334155; border-radius: 6px;
  background: #0f172a; color: #e2e8f0; font-size: 18px; font-weight: 700;
  outline: none; width: 100px;
}
.time-input:focus { border-color: #f59e0b; }
.mode-select {
  padding: 6px 10px; border: 1px solid #334155; border-radius: 6px;
  background: #0f172a; color: #e2e8f0; font-size: 13px; outline: none;
}
.mode-select:focus { border-color: #f59e0b; }
.label-input {
  padding: 4px 0; background: transparent; border: none; border-bottom: 1px solid transparent;
  color: #94a3b8; font-size: 13px; outline: none; width: 100%;
}
.label-input:focus { border-bottom-color: #334155; color: #e2e8f0; }

.alarm-right { flex-shrink: 0; }
.btn-delete {
  width: 28px; height: 28px; border-radius: 6px; border: none;
  background: transparent; color: #64748b; cursor: pointer; font-size: 14px;
  display: flex; align-items: center; justify-content: center;
}
.btn-delete:hover { background: #7f1d1d44; color: #ef4444; }

.btn-add {
  width: 100%; padding: 12px; border: 2px dashed #334155; border-radius: 10px;
  background: transparent; color: #64748b; font-size: 14px; cursor: pointer; margin-bottom: 20px;
}
.btn-add:hover { border-color: #f59e0b44; color: #f59e0b; }

.save-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
.btn { padding: 10px 24px; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary { background: linear-gradient(135deg, #f59e0b, #d97706); color: #0f172a; }
.btn-primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(245,158,11,0.3); }
.saved-hint { font-size: 13px; color: #22c55e; }

.tips { background: #1e293b; border-radius: 8px; padding: 16px; }
.tips h4 { font-size: 13px; color: #94a3b8; margin: 0 0 8px; }
.tips ul { margin: 0; padding-left: 18px; }
.tips li { font-size: 12px; color: #64748b; line-height: 1.8; }
.tips code { background: #0f172a; padding: 1px 5px; border-radius: 3px; font-size: 11px; }
</style>
