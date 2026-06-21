<template>
  <div class="tp-wrap">
    <!-- 触发按钮 -->
    <button class="tp-trigger" @click="show = true" type="button">
      {{ modelValue }}
      <svg
        class="tp-chevron"
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>

    <!-- 弹窗 -->
    <Teleport to="body">
      <Transition name="tp-fade">
        <div v-if="show" class="tp-mask" @click.self="cancel">
          <Transition name="tp-pop" appear>
            <div class="tp-modal">
              <!-- 头部 -->
              <div class="tp-hd">
                <button class="tp-btn" @click="cancel" type="button">取消</button>
                <span class="tp-title">选择时间</span>
                <button class="tp-btn tp-done" @click="confirm" type="button">确定</button>
              </div>

              <!-- 选择器主体 -->
              <div class="tp-body">
                <!-- 小时 -->
                <div class="tp-col">
                  <div class="tp-bar"></div>
                  <div class="tp-scroll" ref="hourScrollEl" @wheel="onHourWheel">
                    <div class="tp-spacer"></div>
                    <div
                      v-for="h in 24"
                      :key="'h' + h"
                      class="tp-cell"
                      :class="{ on: tmpHour === h - 1 }"
                      @click="selectHour(h)"
                    >
                      {{ pad(h - 1) }}
                    </div>
                    <div class="tp-spacer"></div>
                  </div>
                </div>

                <span class="tp-colon">:</span>

                <!-- 分钟 -->
                <div class="tp-col">
                  <div class="tp-bar"></div>
                  <div class="tp-scroll" ref="minScrollEl" @wheel="onMinWheel">
                    <div class="tp-spacer"></div>
                    <div
                      v-for="m in 60"
                      :key="'m' + m"
                      class="tp-cell"
                      :class="{ on: tmpMin === m - 1 }"
                      @click="selectMin(m)"
                    >
                      {{ pad(m - 1) }}
                    </div>
                    <div class="tp-spacer"></div>
                  </div>
                </div>
              </div>
            </div>
          </Transition>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, nextTick, watch } from 'vue'

const props = defineProps({ modelValue: { type: String, required: true } })
const emit = defineEmits(['update:modelValue'])

const show = ref(false)
const tmpHour = ref(0)
const tmpMin = ref(0)
const hourScrollEl = ref(null)
const minScrollEl = ref(null)

const CELL_H = 36 // px per item, 匹配 CSS

function pad(n) {
  return String(n).padStart(2, '0')
}

function cancel() {
  show.value = false
}

function confirm() {
  emit('update:modelValue', pad(tmpHour.value) + ':' + pad(tmpMin.value))
  show.value = false
}

function scrollToCenter(el, index) {
  if (!el) return
  el.scrollTop = index * CELL_H
}

function selectHour(h) {
  tmpHour.value = h - 1
  scrollToCenter(hourScrollEl.value, tmpHour.value)
}

function selectMin(m) {
  tmpMin.value = m - 1
  scrollToCenter(minScrollEl.value, tmpMin.value)
}

function onHourWheel(e) {
  e.preventDefault()
  const next = tmpHour.value + Math.sign(e.deltaY)
  if (next >= 0 && next <= 23) {
    tmpHour.value = next
    scrollToCenter(hourScrollEl.value, next)
  }
}

function onMinWheel(e) {
  e.preventDefault()
  const next = tmpMin.value + Math.sign(e.deltaY)
  if (next >= 0 && next <= 59) {
    tmpMin.value = next
    scrollToCenter(minScrollEl.value, next)
  }
}

watch(show, async (v) => {
  if (v) {
    const [h, m] = props.modelValue.split(':').map(Number)
    tmpHour.value = isNaN(h) ? 7 : h
    tmpMin.value = isNaN(m) ? 0 : m
    await nextTick()
    // wait for browser layout before setting scrollTop for accurate snap
    await new Promise(r => requestAnimationFrame(r))
    scrollToCenter(hourScrollEl.value, tmpHour.value)
    scrollToCenter(minScrollEl.value, tmpMin.value)
  }
})
</script>

<style scoped>
/* ===== 触发按钮 ===== */
.tp-trigger {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 8px 12px;
  border: 2px solid #475569;
  border-radius: 8px;
  background: #0f172a;
  color: #f8fafc;
  font-size: 24px;
  font-weight: 700;
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.2s;
  min-width: 0;
}
.tp-trigger:hover {
  border-color: #f59e0b;
}
.tp-chevron {
  color: #64748b;
  flex-shrink: 0;
}

/* ===== 遮罩 ===== */
.tp-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

/* ===== 弹窗 ===== */
.tp-modal {
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 14px;
  width: 320px;
  max-width: 90vw;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}

/* 头部 */
.tp-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #334155;
}
.tp-btn {
  background: none;
  border: none;
  color: #94a3b8;
  font-size: 14px;
  cursor: pointer;
  padding: 4px 0;
  transition: color 0.15s;
}
.tp-btn:hover {
  color: #e2e8f0;
}
.tp-done {
  color: #f59e0b;
  font-weight: 600;
}
.tp-done:hover {
  color: #fbbf24;
}
.tp-title {
  font-size: 15px;
  font-weight: 600;
  color: #e2e8f0;
}

/* ===== 选择器 ===== */
.tp-body {
  display: flex;
  align-items: stretch;
  padding: 16px 0;
  position: relative;
}

.tp-col {
  flex: 1;
  position: relative;
  overflow: hidden;
  /* 渐变遮罩 */
  --mask-h: 16px;
}
.tp-col::before,
.tp-col::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: var(--mask-h);
  z-index: 2;
  pointer-events: none;
}
.tp-col::before {
  top: 0;
  background: linear-gradient(to bottom, #1e293b, transparent);
}
.tp-col::after {
  bottom: 0;
  background: linear-gradient(to top, #1e293b, transparent);
}

/* 选中指示器（横条） */
.tp-bar {
  position: absolute;
  top: 50%;
  left: 10%;
  right: 10%;
  height: 36px;
  transform: translateY(-50%);
  background: #33415566;
  border-radius: 6px;
  z-index: 0;
  pointer-events: none;
}

/* 滚动容器 */
.tp-scroll {
  height: 180px; /* 5 visible items */
  overflow-y: auto;
  scrollbar-width: none;
  position: relative;
  z-index: 1;
}
.tp-scroll::-webkit-scrollbar {
  display: none;
}

/* 间距块 */
.tp-spacer {
  height: 72px; /* (总高 - cell高) / 2 = (180-36)/2 = 72 */
  pointer-events: none;
}

/* 选项单元 */
.tp-cell {
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  font-weight: 500;
  color: #475569;
  cursor: pointer;
  transition: all 0.12s;
  user-select: none;
}
.tp-cell:hover {
  color: #94a3b8;
}
.tp-cell.on {
  color: #f8fafc;
  font-size: 22px;
  font-weight: 700;
}

/* 冒号分隔符 */
.tp-colon {
  display: flex;
  align-items: center;
  font-size: 22px;
  font-weight: 700;
  color: #f8fafc;
  padding: 0 2px;
  margin-top: -6px; /* offset spacer */
}

/* ===== 过渡动画 ===== */
.tp-fade-enter-active,
.tp-fade-leave-active {
  transition: opacity 0.18s;
}
.tp-fade-enter-from,
.tp-fade-leave-to {
  opacity: 0;
}

.tp-pop-enter-active {
  transition:
    transform 0.2s cubic-bezier(0.2, 0, 0, 1),
    opacity 0.15s;
}
.tp-pop-leave-active {
  transition:
    transform 0.15s ease-in,
    opacity 0.12s;
}
.tp-pop-enter-from {
  transform: scale(0.92) translateY(12px);
  opacity: 0;
}
.tp-pop-leave-to {
  transform: scale(0.96);
  opacity: 0;
}
</style>
