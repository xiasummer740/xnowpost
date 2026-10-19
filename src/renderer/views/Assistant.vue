<template>
  <div class="asst-page">
    <div class="x-head">
      <h1>AI 助手</h1>
      <span class="x-sub">问它今天发了什么、为什么失败，也可以让它改配置 / 改闹钟 / 跑一轮（改之前会让你确认）</span>
      <div class="x-spacer"></div>
      <button class="x-mini" :disabled="busy" title="清空对话" @click="reset">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
          <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
        </svg>
        清空
      </button>
    </div>

    <div class="x-card asst-card">
      <div ref="scroller" class="asst-log">
        <div v-if="!log.length" class="asst-empty">
          <div class="asst-hints">
            <p class="asst-hint-title">可以这样问：</p>
            <button v-for="h in hints" :key="h" class="asst-hint" @click="ask(h)">{{ h }}</button>
          </div>
          <p class="x-tip">
            它读的是真实数据（发布账本 / FAILED 目录 / 调度日志 / 采集证据），不会编数字。
            改配置、改闹钟、发内容这类动作会先显示「要改什么」，你点「执行」才生效。
          </p>
        </div>

        <div v-for="(m, i) in log" :key="i" class="asst-row" :class="'is-' + m.role">
          <div v-if="m.role === 'user'" class="bubble user">{{ m.text }}</div>

          <div v-else-if="m.role === 'assistant'" class="bubble assistant" v-html="render(m.text)"></div>

          <div v-else-if="m.role === 'tool'" class="tool-chip" :class="{ bad: m.ok === false, skip: m.skipped }">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
              <path d="M14.7 6.3a4 4 0 0 0 5 5L21 21H3l9.7-9.7a4 4 0 0 1 2-5z" />
            </svg>
            <span class="tool-name">{{ m.preview }}</span>
            <span class="tool-ms">{{ m.ok === false ? '失败' : m.skipped ? '已跳过' : m.ms + 'ms' }}</span>
          </div>

          <div v-else-if="m.role === 'error'" class="bubble error">{{ m.text }}</div>
        </div>

        <div v-if="pending.length" class="confirm-box">
          <p class="confirm-title">这一步会真的改动东西，确认后才执行：</p>
          <div v-for="p in pending" :key="p.id" class="confirm-item">
            <span class="x-tag" :class="p.level === 'spend' ? 'warn' : 'brand'">{{ p.level === 'spend' ? '会花钱 / 会发布' : '改配置' }}</span>
            <pre class="confirm-text">{{ p.preview }}</pre>
            <div class="confirm-actions">
              <button class="x-btn" :disabled="busy" @click="decide(p.id, true)">执行</button>
              <button class="x-mini" :disabled="busy" @click="decide(p.id, false)">跳过</button>
            </div>
          </div>
        </div>

        <div v-if="busy" class="asst-thinking">
          <span class="dot"></span><span class="dot"></span><span class="dot"></span>
          <span class="thinking-text">{{ thinkingText }}</span>
        </div>
      </div>

      <div class="asst-input-row">
        <textarea
          ref="input"
          v-model="draft"
          class="x-textarea asst-input"
          rows="3"
          :disabled="busy || !!pending.length"
          :placeholder="pending.length ? '先点上面的「执行」或「跳过」' : '问点什么，例如：今天发了几个？哪个号掉登录了？'"
          @keydown.enter.exact.prevent="send"
        ></textarea>
        <button class="x-btn asst-send" :disabled="busy || !draft.trim() || !!pending.length" @click="send">
          发送
        </button>
      </div>
      <p class="x-tip asst-foot">
        Enter 发送 · Shift+Enter 换行 · 每次工具调用都记在 <code>data/assistant-ledger.jsonl</code>
      </p>
    </div>
  </div>
</template>

<script setup>
import { nextTick, onMounted, ref } from 'vue';

const log = ref([]);
const pending = ref([]);
const draft = ref('');
const busy = ref(false);
const thinkingText = ref('思考中…');
const scroller = ref(null);
const input = ref(null);

const hints = [
  '今天发了几个？有失败吗？',
  '为什么最近这一轮失败了？',
  '还有几条待发？',
  '哪个号掉登录了？',
  '把 09:05 那个闹钟关掉',
];

const thinkingMessages = ['看数据…', '读日志…', '算一下…'];
let thinkingTimer = null;

function startThinking() {
  busy.value = true;
  let i = 0;
  thinkingText.value = thinkingMessages[0];
  clearInterval(thinkingTimer);
  thinkingTimer = setInterval(() => {
    i = (i + 1) % thinkingMessages.length;
    thinkingText.value = thinkingMessages[i];
  }, 1400);
}
function stopThinking() {
  busy.value = false;
  clearInterval(thinkingTimer);
  thinkingTimer = null;
}

/** 只允许 **粗体** 与换行（不用 v-html 渲染模型原文，避免注入） */
function render(text) {
  const esc = String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return esc
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

async function scrollBottom() {
  await nextTick();
  const el = scroller.value;
  if (el) el.scrollTop = el.scrollHeight;
}

/** 把主进程返回的快照合并进界面 */
function applyResult(r) {
  if (!r) return;
  if (Array.isArray(r.view)) {
    log.value = r.view.map((v) => ({ ...v }));
  }
  pending.value = Array.isArray(r.pending) ? r.pending : [];
  if (r.ok === false && r.error) {
    log.value.push({ role: 'error', text: r.error });
  }
  scrollBottom();
}

async function send() {
  const text = draft.value.trim();
  if (!text || busy.value || pending.value.length) return;
  draft.value = '';
  log.value.push({ role: 'user', text });
  startThinking();
  scrollBottom();
  try {
    const r = await window.xnowpost.assistantSend(text);
    applyResult(r);
  } catch (e) {
    log.value.push({ role: 'error', text: `请求失败：${e.message}` });
  } finally {
    stopThinking();
  }
}

function ask(text) {
  draft.value = text;
  send();
}

async function decide(id, approve) {
  if (busy.value) return;
  const target = pending.value.find((p) => p.id === id);
  const approvals = pending.value.map((p) => ({ id: p.id, approve: p.id === id ? approve : false }));
  pending.value = [];
  if (target) {
    log.value.push({
      role: 'tool',
      preview: `${approve ? '执行' : '跳过'}：${String(target.preview).split('\n')[0]}`,
      ok: approve,
      skipped: !approve,
      ms: 0,
    });
  }
  startThinking();
  try {
    const r = await window.xnowpost.assistantAnswer(approvals);
    applyResult(r);
  } catch (e) {
    log.value.push({ role: 'error', text: `执行失败：${e.message}` });
  } finally {
    stopThinking();
  }
}

async function reset() {
  try {
    await window.xnowpost.assistantReset();
  } catch (_) { /* 清不掉也不影响继续问 */ }
  log.value = [];
  pending.value = [];
  draft.value = '';
  input.value?.focus();
}

onMounted(async () => {
  try {
    const s = await window.xnowpost.assistantState();
    if (s) applyResult(s);
  } catch (_) { /* 首次进入拿不到状态就直接空白 */ }
  input.value?.focus();
});

</script>

<style scoped>
.asst-page { display: flex; flex-direction: column; gap: 12px; height: 100%; }
.asst-card { display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 0; overflow: hidden; }

.asst-log { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; }

.asst-empty { display: flex; flex-direction: column; gap: 10px; }
.asst-hint-title { color: var(--text-dim); font-size: 12.5px; margin-bottom: 8px; }
.asst-hints { display: flex; flex-wrap: wrap; gap: 8px; }
.asst-hint {
  background: var(--brand-soft); color: var(--text);
  border: 1px solid rgba(255, 46, 91, 0.22); border-radius: 999px;
  padding: 6px 12px; font-size: 12.5px; cursor: pointer; transition: background .15s, border-color .15s;
}
.asst-hint:hover { background: rgba(255, 46, 91, 0.16); border-color: rgba(255, 46, 91, 0.45); }

.asst-row { display: flex; }
.is-user { justify-content: flex-end; }

.bubble { max-width: 78%; padding: 9px 13px; border-radius: 12px; font-size: 13px; line-height: 1.65; word-break: break-word; }
.bubble.user { background: var(--brand); color: #fff; border-bottom-right-radius: 4px; }
.bubble.assistant { background: rgba(44, 61, 80, 0.42); color: var(--text); border-bottom-left-radius: 4px; }
.bubble.assistant :deep(code) { background: rgba(0, 0, 0, 0.28); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
.bubble.assistant :deep(strong) { color: #fff; }
.bubble.error { background: rgba(255, 77, 109, 0.14); border: 1px solid rgba(255, 77, 109, 0.4); color: #ffb3c1; }

.tool-chip {
  align-self: flex-start; display: inline-flex; align-items: center; gap: 7px;
  max-width: 86%; padding: 5px 10px; border-radius: 8px;
  background: rgba(44, 61, 80, 0.3); border: 1px solid var(--line);
  color: var(--text-dim); font-size: 12px;
}
.tool-chip svg { width: 13px; height: 13px; flex: 0 0 auto; }
.tool-chip.bad { border-color: rgba(255, 77, 109, 0.45); color: #ffb3c1; }
.tool-chip.skip { opacity: 0.75; }
.tool-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-ms { color: var(--text-dim); opacity: 0.7; flex: 0 0 auto; }

.confirm-box {
  border: 1px solid rgba(255, 176, 32, 0.42); background: rgba(255, 176, 32, 0.08);
  border-radius: 10px; padding: 11px 13px; display: flex; flex-direction: column; gap: 10px;
}
.confirm-title { font-size: 12.5px; color: #ffcf7a; }
.confirm-item { display: flex; flex-direction: column; gap: 8px; }
.confirm-text {
  margin: 0; white-space: pre-wrap; word-break: break-word;
  font-family: inherit; font-size: 12.5px; line-height: 1.65; color: var(--text);
  background: rgba(0, 0, 0, 0.22); border-radius: 8px; padding: 9px 11px;
}
.confirm-actions { display: flex; gap: 8px; }

.asst-thinking { display: flex; align-items: center; gap: 5px; color: var(--text-dim); font-size: 12.5px; padding: 4px 2px; }
.asst-thinking .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--brand); animation: asst-blink 1.1s infinite; }
.asst-thinking .dot:nth-child(2) { animation-delay: .18s; }
.asst-thinking .dot:nth-child(3) { animation-delay: .36s; }
.thinking-text { margin-left: 4px; }
@keyframes asst-blink { 0%, 70%, 100% { opacity: .25; } 35% { opacity: 1; } }

/* 输入区：原来 36px（沿用了单行 .x-input 的 height），鼠标很难点中。
   现在换 .x-textarea + 88px 最小高度、字号 13.5px，点击/输入都舒服。 */
.asst-input-row { display: flex; gap: 12px; padding: 14px 16px 8px; border-top: 1px solid var(--line); align-items: flex-end; }
.asst-input {
  flex: 1; resize: none; font-family: inherit;
  min-height: 88px; max-height: 220px;
  padding: 10px 12px; font-size: 13.5px; line-height: 1.65;
  border-radius: 10px; cursor: text;
}
.asst-input:disabled { cursor: not-allowed; opacity: 0.7; }
.asst-send { flex: 0 0 96px; height: 44px; font-size: 13.5px; }
.asst-foot { padding: 0 16px 12px; margin: 0; font-size: 11.5px; color: var(--text-dim); }
.asst-foot code { background: rgba(0, 0, 0, 0.25); padding: 1px 5px; border-radius: 4px; }
</style>
