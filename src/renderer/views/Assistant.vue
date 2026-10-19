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
            改配置、改闹钟、发内容这类动作会先显示「要改什么」，你点「执行」才生效；
            改完 30 分钟内输入框上方会出现「撤销」。
            跑生成 / 发布 / 采集只代表「已启动」，问它「发成功了吗」它会去查账本和会话目录给三态结论。
            想让它先想再答：到「配置 → 文案模型」换成 deepseek-v4-pro（会慢一倍，但能看到思考过程）。
          </p>
        </div>

        <div v-for="(m, i) in log" :key="i" class="asst-row" :class="'is-' + m.role">
          <div v-if="m.role === 'user'" class="bubble user">{{ m.text }}</div>

          <div v-else-if="m.role === 'assistant'" class="bubble assistant" v-html="render(m.text)"></div>

          <!-- 思考过程（只有推理模型会给；默认收起，免得刷屏） -->
          <div v-else-if="m.role === 'reasoning'" class="reason-box">
            <button class="reason-toggle" @click="m._open = !m._open">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
                <path d="M12 3a6 6 0 0 0-3.6 10.8c.5.4.8 1 .8 1.6V17h5.6v-1.6c0-.6.3-1.2.8-1.6A6 6 0 0 0 12 3z" />
                <path d="M9.5 20h5" />
              </svg>
              思考过程（{{ m.text.length }} 字）{{ m._open ? '· 收起' : '· 展开' }}
            </button>
            <pre v-if="m._open" class="reason-text">{{ m.text }}</pre>
          </div>

          <div
            v-else-if="m.role === 'tool'"
            class="tool-chip"
            :class="{
              bad: m.ok === false,
              skip: m.skipped,
              good: m.ok !== false && m.verdict === 'success',
              warn: m.ok !== false && (m.verdict === 'unconfirmed' || m.verdict === 'failed'),
            }"
            :title="m.preview"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
              <path d="M14.7 6.3a4 4 0 0 0 5 5L21 21H3l9.7-9.7a4 4 0 0 1 2-5z" />
            </svg>
            <span class="tool-name">{{ m.name }}</span>
            <span v-if="m.detail" class="tool-detail">{{ m.detail }}</span>
            <span class="tool-ms">{{ m.ok === false ? '失败' : m.skipped ? '已跳过' : m.ms + 'ms' }}</span>
          </div>

          <div v-else-if="m.role === 'error'" class="bubble error">{{ m.text }}</div>
        </div>

        <div v-if="pending.length" class="confirm-box">
          <p class="confirm-title">
            这一步会真的改动东西，确认后才执行：
            <button v-if="pending.length > 1" class="x-btn asst-all" :disabled="busy" @click="decideAll">
              全部执行（{{ pending.length }} 步）
            </button>
          </p>
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

      <!-- 撤销栏：只对"改配置 / 改定时"出现（跑生成/发布/采集钱已经出去了，不提供撤销） -->
      <div v-if="undoList.length" class="undo-bar">
        <span class="undo-hint">30 分钟内可撤销：</span>
        <button
          v-for="u in undoList"
          :key="u.id"
          class="undo-chip"
          :disabled="busy"
          :title="'把 ' + u.label + ' 之前的内容原样恢复'"
          @click="doUndo(u.id)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <path d="M9 14 4 9l5-5" />
            <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
          </svg>
          {{ u.text }}
        </button>
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
// 可撤销的写操作（主进程每次响应都捎回来，过期/已撤销的会自动消失）
const undoList = ref([]);
const draft = ref('');
const busy = ref(false);
const thinkingText = ref('思考中…');
const scroller = ref(null);
const input = ref(null);

const hints = [
  '今天发了几个？有失败吗？',
  '为什么最近这一轮失败了？',
  '还有几条待发？',
  '把待发里第 1 条发到 02 号',   // 点名具体条目：助手会先 get_pending 拿序号再 run_publish({pick})
  '刚才那条发出去了吗？',
  '哪个号掉登录了？',
  '记住：配音一律用英文',
  '把 09:05 那个闹钟关掉',
  '加一个 23:50 的闹钟（账号 10）',
  '看下我的定时任务',
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
  undoList.value = Array.isArray(r.undo) ? r.undo : [];
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
      name: approve ? '执行' : '跳过',
      detail: String(target.preview).split('\n')[0],
      preview: target.preview,
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

/** 一批待确认动作一次全执行（模型一次提议 10 个闹钟时，不该让人点 10 下） */
async function decideAll() {
  if (busy.value || !pending.value.length) return;
  const items = pending.value.map((p) => ({ id: p.id, approve: true }));
  for (const p of pending.value) {
    log.value.push({
      role: 'tool',
      name: '执行',
      detail: String(p.preview).split('\n')[0],
      preview: p.preview,
      ok: true,
      ms: 0,
    });
  }
  pending.value = [];
  startThinking();
  try {
    applyResult(await window.xnowpost.assistantAnswer(items));
  } catch (e) {
    log.value.push({ role: 'error', text: `执行失败：${e.message}` });
  } finally {
    stopThinking();
  }
}

async function doUndo(id) {
  if (busy.value) return;
  const item = undoList.value.find((u) => u.id === id);
  startThinking();
  try {
    const r = await window.xnowpost.assistantUndo(id);
    applyResult(r);
    if (r && r.ok) {
      log.value.push({
        role: 'tool',
        preview: `↩ 撤销：${item ? item.label : id}${Array.isArray(r.restored) && r.restored.length ? `（${r.restored.join('、')}）` : ''}`,
        ok: true,
        ms: 0,
      });
    }
  } catch (e) {
    log.value.push({ role: 'error', text: `撤销失败：${e.message}` });
  } finally {
    stopThinking();
    scrollBottom();
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
.tool-chip.good { border-color: rgba(52, 211, 153, 0.4); }
.tool-chip.warn { border-color: rgba(255, 176, 32, 0.45); color: #ffd9a0; }
.tool-name { flex: 0 0 auto; opacity: 0.85; font-variant-numeric: tabular-nums; }
/* 结论行才是用户想看的东西（发了没发、几条），工具名只是注解 */
.tool-detail {
  color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tool-chip.bad .tool-detail { color: #ffb3c1; }
.tool-ms { color: var(--text-dim); opacity: 0.7; flex: 0 0 auto; }

/* 推理模型的思考过程：默认收起 */
.reason-box { align-self: flex-start; max-width: 86%; }
.reason-toggle {
  display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
  padding: 4px 9px; border-radius: 8px; font-size: 12px;
  background: rgba(124, 92, 255, 0.1); border: 1px solid rgba(124, 92, 255, 0.32);
  color: #c4b5fd; font-family: inherit;
}
.reason-toggle svg { width: 13px; height: 13px; }
.reason-text {
  margin: 6px 0 0; padding: 9px 11px; border-radius: 8px; white-space: pre-wrap; word-break: break-word;
  background: rgba(124, 92, 255, 0.06); border: 1px solid rgba(124, 92, 255, 0.2);
  color: var(--text-dim); font-size: 12px; line-height: 1.65; font-family: inherit;
  max-height: 320px; overflow: auto;
}

.confirm-box {
  border: 1px solid rgba(255, 176, 32, 0.42); background: rgba(255, 176, 32, 0.08);
  border-radius: 10px; padding: 11px 13px; display: flex; flex-direction: column; gap: 10px;
}
.confirm-title {
  font-size: 12.5px; color: #ffcf7a;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
}
.asst-all { padding: 4px 12px; font-size: 12px; }
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
.undo-bar {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  padding: 8px 16px; border-top: 1px solid var(--line);
  background: rgba(255, 176, 32, 0.06);
}
.undo-hint { font-size: 11.5px; color: #ffcf7a; }
.undo-chip {
  display: inline-flex; align-items: center; gap: 5px;
  background: rgba(255, 176, 32, 0.14); color: #ffd79a;
  border: 1px solid rgba(255, 176, 32, 0.4); border-radius: 999px;
  padding: 4px 11px; font-size: 12px; cursor: pointer; transition: background .15s, border-color .15s;
}
.undo-chip svg { width: 12px; height: 12px; }
.undo-chip:hover:not(:disabled) { background: rgba(255, 176, 32, 0.24); border-color: rgba(255, 176, 32, 0.7); }
.undo-chip:disabled { opacity: .55; cursor: not-allowed; }
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
