<template>
  <div class="history-page">
    <div class="header">
      <h2>📋 历史产出</h2>
      <button class="btn btn-secondary" @click="openDir">📂 打开输出目录</button>
    </div>

    <!-- 骨架屏 -->
    <div v-if="loading" class="skeleton-list">
      <div v-for="n in 4" :key="n" class="skeleton-section">
        <div class="skeleton-date"></div>
        <div class="skeleton-card">
          <div class="skeleton-thumb"></div>
          <div class="skeleton-lines">
            <div class="skeleton-line w-60"></div>
            <div class="skeleton-line w-30"></div>
          </div>
        </div>
        <div class="skeleton-card">
          <div class="skeleton-thumb"></div>
          <div class="skeleton-lines">
            <div class="skeleton-line w-50"></div>
            <div class="skeleton-line w-25"></div>
          </div>
        </div>
      </div>
    </div>

    <div v-else-if="history.length === 0" class="empty-box">
      <span class="empty-icon">📭</span>
      <span>还没有生成过内容，去首页试试</span>
    </div>

    <template v-else>
      <div v-for="day in history" :key="day.date" class="day-section">
        <h3>{{ day.date }}</h3>
        <div
          v-for="item in day.items"
          :key="item.id"
          class="item-card"
          :class="{ selected: selectedDir === item.dir }"
          @click="selectSession(item)">
          <div class="item-thumb">
            <img v-if="item.thumbnail" :src="item.thumbnail" class="thumb-img" />
            <span v-else class="thumb-placeholder">{{ item.type === 'video' ? '🎬' : '🟢' }}</span>
          </div>
          <div class="item-body">
            <div class="item-title">{{ item.title_zh }}</div>
            <div class="item-meta">{{ item.type === 'video' ? '视频' : '图文' }}</div>
          </div>
        </div>
      </div>
    </template>

    <!-- 详情面板 -->
    <div v-if="detail" class="detail-panel">
      <div class="detail-header">
        <h3>📄 详情</h3>
        <button class="btn btn-small" @click="closeDetail">✕</button>
      </div>

      <div v-if="detail.text" class="detail-section">
        <h4>📝 文案</h4>
        <pre class="detail-text">{{ detail.text }}</pre>
      </div>

      <div v-if="detail.cost" class="detail-section cost-section">
        <h4>💰 费用</h4>
        <div class="cost-grid">
          <span>DeepSeek</span><span>¥{{ detail.cost.deepseek?.toFixed(4) || '0' }}</span>
          <span>Kolors</span><span>¥{{ detail.cost.kolors?.toFixed(2) || '0' }}</span>
          <span class="cost-total-label">合计</span><span class="cost-total-val">¥{{ detail.cost.total?.toFixed(2) || '0' }}</span>
        </div>
      </div>

      <div v-if="detail.images?.length" class="detail-section">
        <h4>🖼️ 图片 ({{ detail.images.length }})</h4>
        <div class="image-grid">
          <div v-for="img in detail.images" :key="img.name" class="image-item">
            <img :src="img.data" :alt="img.name" class="preview-img" />
            <span class="image-name">{{ img.name }}</span>
          </div>
        </div>
      </div>

      <div v-if="detail.videoFile" class="detail-section">
        <h4>🎬 视频</h4>
        <p class="video-hint">在 output 目录中查看 video.mp4</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, nextTick } from 'vue';

const history = ref([]);
const loading = ref(true);
const selectedDir = ref(null);
const detail = ref(null);

async function load() {
  loading.value = true;
  history.value = await window.xnowpost.getHistory();
  loading.value = false;
  // 异步加载缩略图
  nextTick(() => loadThumbnails());
}

function loadThumbnails() {
  for (const day of history.value) {
    for (const item of day.items) {
      if (item.dir) {
        window.xnowpost.getThumbnail(item.dir).then(url => {
          if (url) item.thumbnail = url;
        }).catch(() => {});
      }
    }
  }
}

async function selectSession(item) {
  if (selectedDir.value === item.dir) { closeDetail(); return; }
  selectedDir.value = item.dir;
  detail.value = await window.xnowpost.readSession(item.dir);
}

function closeDetail() {
  selectedDir.value = null;
  detail.value = null;
}

async function openDir() {
  await window.xnowpost.openOutputDir();
}

onMounted(load);
</script>

<style scoped>
.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
h2 { font-size: 24px; }
h3 { font-size: 14px; color: #f59e0b; margin: 20px 0 10px; padding-bottom: 8px; border-bottom: 1px solid #334155; }
h4 { font-size: 13px; color: #94a3b8; margin: 0 0 8px; }
.btn-secondary { padding: 8px 16px; background: #334155; color: #e2e8f0; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
.btn-secondary:hover { background: #475569; }
.btn-small { padding: 4px 12px; background: #334155; color: #e2e8f0; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
.btn-small:hover { background: #475569; }

/* 空状态 */
.empty-box { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 80px 20px; color: #64748b; }
.empty-icon { font-size: 40px; }

/* 卡片 + 缩略图 */
.item-card {
  display: flex; gap: 14px; padding: 12px; background: #1e293b; border-radius: 10px;
  margin-bottom: 6px; cursor: pointer; transition: all 0.15s;
}
.item-card:hover { background: #334155; }
.item-card.selected { background: #334155; border: 1px solid #f59e0b44; }

.item-thumb {
  width: 56px; height: 56px; border-radius: 8px; overflow: hidden;
  background: #0f172a; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
}
.thumb-img { width: 100%; height: 100%; object-fit: cover; }
.thumb-placeholder { font-size: 22px; opacity: 0.5; }
.item-body { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; }
.item-title { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item-meta { font-size: 13px; color: #64748b; margin-top: 3px; }

/* 骨架屏 */
.skeleton-list { display: flex; flex-direction: column; gap: 16px; }
.skeleton-section { display: flex; flex-direction: column; gap: 6px; }
.skeleton-date { height: 14px; width: 100px; border-radius: 4px; background: linear-gradient(90deg, #1e293b 25%, #334155 50%, #1e293b 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; margin-bottom: 4px; }
.skeleton-card { display: flex; gap: 14px; padding: 12px; background: #1e293b; border-radius: 10px; }
.skeleton-thumb { width: 56px; height: 56px; border-radius: 8px; background: linear-gradient(90deg, #1e293b 25%, #334155 50%, #1e293b 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; flex-shrink: 0; }
.skeleton-lines { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 8px; }
.skeleton-line { height: 12px; border-radius: 4px; background: linear-gradient(90deg, #1e293b 25%, #334155 50%, #1e293b 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; }
.skeleton-line.w-60 { width: 60%; }
.skeleton-line.w-50 { width: 50%; }
.skeleton-line.w-30 { width: 30%; }
.skeleton-line.w-25 { width: 25%; }
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

/* 详情面板 */
.detail-panel {
  position: fixed; right: 0; top: 0; width: 420px; height: 100vh;
  background: #1e293b; border-left: 1px solid #334155;
  padding: 24px; overflow-y: auto; z-index: 10; animation: slideIn 0.2s ease;
}
@keyframes slideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }
.detail-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.detail-section { margin-bottom: 20px; }
.detail-text {
  font-size: 13px; line-height: 1.6; color: #cbd5e1;
  background: #0f172a; border-radius: 8px; padding: 12px;
  white-space: pre-wrap; max-height: 300px; overflow-y: auto;
}
.cost-section { background: #065f4622; border: 1px solid #05966933; border-radius: 8px; padding: 12px; }
.cost-grid { display: grid; grid-template-columns: 1fr auto; gap: 6px 16px; font-size: 13px; }
.cost-total-label { color: #f59e0b; font-weight: 600; }
.cost-total-val { color: #f59e0b; font-weight: 700; }
.image-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.image-item { display: flex; flex-direction: column; gap: 4px; }
.preview-img { width: 100%; border-radius: 6px; border: 1px solid #334155; }
.image-name { font-size: 10px; color: #64748b; text-align: center; }
.video-hint { font-size: 13px; color: #94a3b8; padding: 8px; background: #0f172a; border-radius: 6px; }
</style>
