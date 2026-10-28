<template>
  <div class="envs-page">
    <!-- 标题栏：一个页面管完全部环境，不用再去 FoxProfile 的窗口 -->
    <div class="x-head">
      <h1>浏览器环境</h1>
      <span class="x-sub">
        {{ envs.length }} 个环境 · 运行中 {{ runningCount }} · 已登录 {{ loggedCount }}
        <template v-if="proxy.configured"> · 出口 {{ proxy.running ? '内核运行中' : '内核未启动' }}</template>
      </span>
      <span class="x-spacer"></span>
      <button class="x-btn" :disabled="!hasIpc || loading" @click="refresh">
        <svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></svg>
        刷新
      </button>
      <button class="x-btn primary" :disabled="!hasIpc || !serviceOk" @click="openCreate">
        <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
        新建环境
      </button>
    </div>

    <!-- 后台服务挂了：以前这里只会看到一个 502，现在直接给按钮 -->
    <div v-if="!serviceOk && !loading" class="banner err">
      <span>❌ 浏览器后台服务没在跑：{{ serviceNote || '连不上 127.0.0.1:8000' }}</span>
      <button class="x-btn" :disabled="fixing" @click="fixService">
        {{ fixing ? '正在启动…' : '启动后台服务' }}
      </button>
    </div>

    <!-- 节点没配 / 内核没跑：环境里的浏览器一定打不开外网，必须在这就说明白 -->
    <div v-if="!proxy.configured && !loading" class="banner err">
      <span>❌ 还没有配置网络节点：环境里的浏览器打不开任何网站（出口 IP 是空的）</span>
      <button class="x-btn" @click="$router.push('/config')">去配置节点</button>
    </div>
    <div v-else-if="proxy.configured && !proxy.running && !loading" class="banner err">
      <span>⚠️ 代理内核没在跑（节点：{{ proxy.describe }}），浏览器现在出不去外网</span>
      <button class="x-btn" :disabled="fixing" @click="fixProxy">
        {{ fixing ? '正在启动…' : '启动内核' }}
      </button>
    </div>

    <div v-if="msg" class="banner" :class="msgKind">
      <span>{{ msg }}</span>
      <button class="x-mini" @click="msg = ''">✕</button>
    </div>

    <div class="x-card list-card">
      <div class="x-card-head">
        <span class="x-ic">
          <svg viewBox="0 0 24 24">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M3 9h18M7.5 6.5h.01M10.5 6.5h.01" />
          </svg>
        </span>
        <h2>环境列表</h2>
        <span class="x-hint">一条环境一条代理端口；启动/停止直接驱动指纹浏览器</span>
        <span class="x-spacer"></span>
        <span class="x-tag">{{ envs.length }} 个</span>
      </div>

      <div v-if="!envs.length && !loading" class="x-empty">
        还没有环境。点右上角「新建环境」建一个。
      </div>

      <table v-else class="env-table">
        <thead>
          <tr>
            <th class="c-env">环境</th>
            <th class="c-acc">账号</th>
            <th class="c-port">代理端口</th>
            <th class="c-tz">时区 / 语言</th>
            <th class="c-login">登录态</th>
            <th class="c-state">状态</th>
            <th class="c-ops">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in envs" :key="e.env" :class="{ on: e.running }">
            <td class="c-env">
              <b>{{ e.env }}</b>
              <span v-if="e.engine && e.engine !== 'camoufox'" class="x-tag">{{ e.engine }}</span>
            </td>
            <td class="c-acc">
              <span v-if="e.username" class="mono">@{{ e.username }}</span>
              <span v-else class="muted">—</span>
              <span v-if="e.passwordSet" class="dot ok" title="已存密码"></span>
              <span v-if="e.totpSet" class="dot ok" title="已存 2FA 密钥"></span>
            </td>
            <td class="c-port">
              <template v-if="e.port">
                <span class="mono">{{ e.port }}</span>
                <span v-if="!e.portOk" class="tag-warn" title="中继配置里没有这条端口">未监听</span>
              </template>
              <span v-else class="tag-warn">没配代理</span>
              <div v-if="ipInfo[e.env]" class="ip-line">{{ ipInfo[e.env] }}</div>
            </td>
            <td class="c-tz">
              <span class="muted">{{ e.timezone || '自动' }}</span>
              <span class="muted"> / {{ e.locale || '自动' }}</span>
            </td>
            <td class="c-login">
              <span v-if="e.loggedIn === true" class="pill ok">已登录</span>
              <span v-else-if="e.loggedIn === false" class="pill warn">需登录</span>
              <span v-else class="pill" :title="e.note">未知</span>
            </td>
            <td class="c-state">
              <span v-if="e.running" class="pill ok">运行中</span>
              <span v-else class="pill">未启动</span>
            </td>
            <td class="c-ops">
              <button
                v-if="!e.running"
                class="x-mini"
                :disabled="busy[e.env] || !serviceOk"
                @click="start(e)"
              >
                {{ busy[e.env] === 'start' ? '启动中…' : '启动' }}
              </button>
              <button v-else class="x-mini" :disabled="busy[e.env]" @click="stop(e)">
                {{ busy[e.env] === 'stop' ? '停止中…' : '停止' }}
              </button>
              <button class="x-mini" :disabled="busy[e.env] || !serviceOk" @click="ipCheck(e)">
                {{ busy[e.env] === 'ip' ? '测中…' : '测出口' }}
              </button>
              <button class="x-mini hi" :disabled="busy[e.env] || e.running" @click="openDelete(e)">
                删除
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <div class="x-tip">
        环境 = 一套独立的指纹 + cookie，账号页和定时任务用的就是这里的名字（TK01…）。
        删环境会连它的 cookie 一起删掉，那个号就得重新登录。
      </div>
    </div>

    <!-- 新建 / 删除：右侧滑出面板（和账号页的凭据编辑同一个形态） -->
    <div v-if="panel" class="mask" @click.self="closePanel">
      <div class="panel">
        <div class="panel-head">
          <h3>{{ panel === 'create' ? '新建浏览器环境' : `删除环境 ${delEnv}` }}</h3>
          <button class="x-mini" @click="closePanel">✕</button>
        </div>

        <template v-if="panel === 'create'">
          <div class="field">
            <label>环境名</label>
            <input v-model="form.name" class="x-input" placeholder="TK12" />
            <p class="hint">账号页 / 定时任务里就用这个名字，建议接着编号往下排。</p>
          </div>
          <div class="field">
            <label>代理端口</label>
            <input v-model="form.port" class="x-input" :placeholder="`自动分配 ${suggestPort}`" />
            <p class="hint">一条环境一条端口，绝不能共用（1090 起顺序递增；留空自动分配）。</p>
          </div>
          <div class="field">
            <label>时区</label>
            <select v-model="form.timezone" class="x-select">
              <option value="">跟随出口 IP（推荐）</option>
              <option v-for="t in TZ_LIST" :key="t" :value="t">{{ t }}</option>
            </select>
          </div>
          <div class="field">
            <label>语言</label>
            <select v-model="form.locale" class="x-select">
              <option value="">跟随出口 IP（推荐）</option>
              <option v-for="l in LOCALE_LIST" :key="l" :value="l">{{ l }}</option>
            </select>
          </div>
          <p class="hint">窗口尺寸会自动统一成 1292×994（和其它号一致），不用手调。</p>
          <div class="panel-foot">
            <button class="x-btn" @click="closePanel">取消</button>
            <button class="x-btn primary" :disabled="creating" @click="doCreate">
              {{ creating ? '正在创建…' : '创建' }}
            </button>
          </div>
        </template>

        <template v-else>
          <p class="warn-text">
            删掉后这个环境的指纹、cookie、登录态会一起消失，那个号必须重新登录，不可恢复。
          </p>
          <div class="field">
            <label>要删除就输入 <b>{{ delEnv }}</b></label>
            <input v-model="delConfirm" class="x-input" :placeholder="delEnv" />
          </div>
          <div class="panel-foot">
            <button class="x-btn" @click="closePanel">取消</button>
            <button
              class="x-btn danger"
              :disabled="delConfirm !== delEnv || deleting"
              @click="doDelete"
            >
              {{ deleting ? '正在删除…' : '确认删除' }}
            </button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';

/**
 * 浏览器环境（2026-10-28）
 *
 * 用户口径：「两个软件结合使用，用起来也比较麻烦，能整合成一个软件吗」
 * → FoxProfile 退成后台服务（headless，没有窗口可关），环境管理搬到这一页。
 *
 * 这一页只做「管理」：列表 / 新建 / 删除 / 启动 / 停止 / 测出口。
 * 真正的指纹、启动、页面控制仍在 FoxProfile 里，这里全部走它的 HTTP 接口
 * （主进程 envs:* 那组 IPC），不复制它的逻辑。
 */

const api = typeof window !== 'undefined' ? window.xnowpost : null;
const hasIpc = typeof api?.listBrowserEnvs === 'function';

const envs = ref([]);
// 代理内核状态（节点配没配、内核在不在跑）—— 这一层决定浏览器能不能出网
const proxy = reactive({ configured: false, running: false, describe: '未配置', exitIp: '' });
const runningCount = ref(0);
const loggedCount = ref(0);
const serviceOk = ref(true);
const serviceNote = ref('');
const loading = ref(false);
const fixing = ref(false);

const msg = ref('');
const msgKind = ref('info');
const busy = reactive({});
const ipInfo = reactive({});

const panel = ref(''); // '' | 'create' | 'delete'
const creating = ref(false);
const deleting = ref(false);
const form = reactive({ name: '', port: '', timezone: '', locale: '' });
const delEnv = ref('');
const delConfirm = ref('');

const TZ_LIST = [
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Bangkok',
];
const LOCALE_LIST = ['en-US', 'en-GB', 'zh-CN', 'ja-JP', 'ko-KR', 'de-DE', 'fr-FR', 'th-TH'];

const suggestPort = computed(() => {
  const used = envs.value.map((e) => Number(e.port) || 0);
  const top = Math.max(1089, ...used);
  return Math.min(1109, top + 1);
});

function say(text, kind = 'info') {
  msg.value = text;
  msgKind.value = kind;
}

function nextEnvName() {
  const names = envs.value.map((e) => String(e.env || '').toUpperCase());
  let n = 1;
  while (names.includes(`TK${String(n).padStart(2, '0')}`)) n += 1;
  return `TK${String(n).padStart(2, '0')}`;
}

let timer = null;

async function refresh() {
  if (!hasIpc) {
    serviceOk.value = false;
    serviceNote.value = '当前版本没有接上环境接口（preload 里缺 listBrowserEnvs），请重新安装';
    return;
  }
  loading.value = true;
  try {
    const r = await api.listBrowserEnvs();
    if (!r) {
      serviceOk.value = false;
      serviceNote.value = '主进程没有回应';
      return;
    }
    serviceOk.value = r.serviceOk !== false;
    serviceNote.value = r.serviceNote || '';
    envs.value = Array.isArray(r.envs) ? r.envs : [];
    if (r.proxy) {
      proxy.configured = !!r.proxy.configured;
      proxy.running = !!r.proxy.running;
      proxy.describe = r.proxy.describe || '未配置';
    }
    runningCount.value = r.runningCount || 0;
    loggedCount.value = r.loggedCount || 0;
  } catch (e) {
    serviceOk.value = false;
    serviceNote.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
}

async function fixService() {
  if (!hasIpc) return;
  fixing.value = true;
  say('正在启动浏览器后台服务…');
  try {
    const r = await api.ensureBrowserService();
    if (r?.ok) {
      say('✅ 后台服务已就绪', 'ok');
      await refresh();
    } else {
      say(`❌ 启动失败：${r?.message || '未知原因'}`, 'err');
    }
  } catch (e) {
    say(`❌ 启动失败：${e?.message || e}`, 'err');
  } finally {
    fixing.value = false;
  }
}

/** 节点配了但内核没跑：直接在这里点起来，不用回配置页 */
async function fixProxy() {
  if (!hasIpc) return;
  fixing.value = true;
  say('正在启动代理内核…');
  try {
    const r = await api.proxyRestart();
    if (r?.ok) {
      say(r.ip ? `✅ 代理内核已启动，出口：${r.ip}` : `⚠️ 内核起来了但出口没通：${r.probeError || ''}`, r.ip ? 'ok' : 'err');
      await refresh();
    } else {
      say(`❌ 启动失败：${r?.message || '未知原因'}`, 'err');
    }
  } catch (e) {
    say(`❌ 启动失败：${e?.message || e}`, 'err');
  } finally {
    fixing.value = false;
  }
}

function openCreate() {
  if (!serviceOk.value) {
    say('后台服务没在跑，先点上面的「启动后台服务」', 'err');
    return;
  }
  form.name = nextEnvName();
  form.port = '';
  form.timezone = '';
  form.locale = '';
  panel.value = 'create';
}

function openDelete(e) {
  delEnv.value = e.env;
  delConfirm.value = '';
  panel.value = 'delete';
}

function closePanel() {
  panel.value = '';
  delConfirm.value = '';
}

async function doCreate() {
  if (!hasIpc) return;
  const name = String(form.name || '').trim();
  if (!name) {
    say('先填个环境名（例：TK12）', 'err');
    return;
  }
  creating.value = true;
  try {
    const payload = { name };
    if (String(form.port || '').trim()) payload.port = Number(form.port);
    if (form.timezone) payload.timezone = form.timezone;
    if (form.locale) payload.locale = form.locale;
    const r = await api.createBrowserEnv(payload);
    if (!r?.ok) {
      say(`❌ ${r?.message || '创建失败'}`, 'err');
      return;
    }
    say(`✅ 已创建 ${r.env}（代理端口 ${r.port}）`, 'ok');
    closePanel();
    await refresh();
  } catch (e) {
    say(`❌ 创建失败：${e?.message || e}`, 'err');
  } finally {
    creating.value = false;
  }
}

async function doDelete() {
  if (!hasIpc) return;
  if (delConfirm.value !== delEnv.value) {
    say('确认名不一致，没有删除', 'err');
    return;
  }
  deleting.value = true;
  try {
    const r = await api.deleteBrowserEnv({ env: delEnv.value, confirm: delConfirm.value });
    if (!r?.ok) {
      say(`❌ ${r?.message || '删除失败'}`, 'err');
      return;
    }
    say(`🗑️ 已删除 ${r.env}`, 'ok');
    closePanel();
    await refresh();
  } catch (e) {
    say(`❌ 删除失败：${e?.message || e}`, 'err');
  } finally {
    deleting.value = false;
  }
}

async function start(e) {
  if (!hasIpc) return;
  busy[e.env] = 'start';
  say(`正在启动 ${e.env}…（等浏览器真的能用才返回）`);
  try {
    const r = await api.startBrowserEnv(e.env);
    if (r?.ok) say(`✅ ${e.env} 已启动`, 'ok');
    else say(`❌ ${e.env} 启动失败：${r?.message || '未知原因'}`, 'err');
  } catch (err) {
    say(`❌ ${e.env} 启动失败：${err?.message || err}`, 'err');
  } finally {
    delete busy[e.env];
    await refresh();
  }
}

async function stop(e) {
  if (!hasIpc) return;
  busy[e.env] = 'stop';
  try {
    const r = await api.stopBrowserEnv(e.env);
    if (r?.ok) say(`🧹 ${e.env} 已停止`, 'ok');
    else say(`❌ ${e.env} 停止失败：${r?.message || '未知原因'}`, 'err');
  } catch (err) {
    say(`❌ ${e.env} 停止失败：${err?.message || err}`, 'err');
  } finally {
    delete busy[e.env];
    await refresh();
  }
}

async function ipCheck(e) {
  if (!hasIpc) return;
  busy[e.env] = 'ip';
  try {
    const r = await api.ipCheckBrowserEnv(e.env);
    if (r?.ok) {
      const text = [r.ip, r.place].filter(Boolean).join(' · ');
      ipInfo[e.env] = text || '通了，但没读到 IP';
      const warn = Array.isArray(r.warnings) && r.warnings.length ? `　⚠️ ${r.warnings[0]}` : '';
      say(`✅ ${e.env} 出口：${ipInfo[e.env]}${warn}`, warn ? 'info' : 'ok');
    } else {
      ipInfo[e.env] = `不通：${r?.message || '未知原因'}`;
      say(`❌ ${e.env} 出口不通：${r?.message || '未知原因'}（检查这条端口的中继）`, 'err');
    }
  } catch (err) {
    ipInfo[e.env] = `不通：${err?.message || err}`;
    say(`❌ ${e.env} 测出口失败：${err?.message || err}`, 'err');
  } finally {
    delete busy[e.env];
  }
}

onMounted(() => {
  refresh();
  // 环境会被用户手动开关、也会被定时任务开关，界面必须自己跟着变（同账号页的道理）
  timer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (Object.keys(busy).length) return;
    refresh();
  }, 8000);
});

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<style scoped>
.envs-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 按钮一多会把标题挤成竖排 —— 标题/提示/按钮都不许被压缩 */
.x-head {
  flex-wrap: wrap;
  row-gap: 8px;
}
.x-head h1,
.x-head .x-sub,
.x-head .x-spacer,
.x-head > button {
  flex: 0 0 auto;
  white-space: nowrap;
}
.x-head .x-spacer {
  flex: 1;
}

.banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: var(--r-md);
  border: 1px solid var(--stroke-2);
  background: var(--bg2);
  font-size: 12.5px;
  color: var(--text);
}
.banner > span {
  flex: 1;
  min-width: 0;
}
.banner.err {
  border-color: rgba(240, 81, 78, 0.55);
  background: var(--danger-soft);
  color: #ffb4b2;
}
.banner.ok {
  border-color: rgba(45, 212, 167, 0.5);
  background: var(--ok-soft);
  color: #9ff0d8;
}

/* theme.css 只有 primary / ghost，删除这种不可逆的动作用红色确认 */
.x-btn.danger {
  border-color: rgba(240, 81, 78, 0.55);
  color: #ffb4b2;
  background: var(--danger-soft);
}
.x-btn.danger:hover {
  background: rgba(240, 81, 78, 0.22);
  border-color: rgba(240, 81, 78, 0.75);
}

.list-card .x-card-head {  flex-wrap: wrap;
  row-gap: 6px;
}
.list-card .x-card-head h2,
.list-card .x-card-head .x-ic,
.list-card .x-card-head .x-hint,
.list-card .x-card-head .x-tag {
  flex: 0 0 auto;
  white-space: nowrap;
}

.env-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.env-table th {
  text-align: left;
  font-weight: 600;
  font-size: 11.5px;
  color: var(--text-3);
  padding: 8px 12px;
  border-bottom: 1px solid var(--stroke);
  white-space: nowrap;
}
.env-table td {
  padding: 9px 12px;
  border-bottom: 1px solid rgba(34, 48, 63, 0.55);
  color: var(--text);
  vertical-align: middle;
}
.env-table tbody tr:hover {
  background: rgba(26, 38, 55, 0.55);
}
.env-table tbody tr.on {
  background: rgba(45, 212, 167, 0.05);
}
.env-table .c-env b {
  font-weight: 650;
  letter-spacing: 0.3px;
}
.env-table .c-ops {
  text-align: right;
  white-space: nowrap;
}
.env-table .c-ops .x-mini {
  height: 24px;
  padding: 0 9px;
  font-size: 11.5px;
  margin-left: 4px;
}
.env-table .c-tz,
.env-table .c-login,
.env-table .c-state {
  white-space: nowrap;
}

.mono {
  font-family: var(--font-mono);
  font-size: 12px;
}
.muted {
  color: var(--text-3);
}
.ip-line {
  margin-top: 3px;
  font-size: 11px;
  color: var(--info);
  font-family: var(--font-mono);
  white-space: nowrap;
}

.pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: var(--bg3);
  color: var(--text-2);
  border: 1px solid var(--stroke-2);
  white-space: nowrap;
}
.pill.ok {
  background: var(--ok-soft);
  color: #8fe9cf;
  border-color: rgba(45, 212, 167, 0.45);
}
.pill.warn {
  background: var(--warn-soft);
  color: #f6c274;
  border-color: rgba(245, 165, 36, 0.45);
}

.tag-warn {
  margin-left: 6px;
  font-size: 10.5px;
  color: var(--warn);
  border: 1px solid rgba(245, 165, 36, 0.5);
  border-radius: 6px;
  padding: 1px 5px;
}
.dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  margin-left: 5px;
  vertical-align: middle;
}
.dot.ok {
  background: var(--ok);
}

/* 新建/删除面板：右侧滑出 */
.mask {
  position: fixed;
  inset: 0;
  background: rgba(4, 8, 13, 0.55);
  display: flex;
  justify-content: flex-end;
  z-index: 60;
}
.panel {
  width: 420px;
  max-width: 92vw;
  height: 100%;
  background: var(--bg2);
  border-left: 1px solid var(--stroke-2);
  box-shadow: var(--shadow-2);
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: auto;
}
.panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.panel-head h3 {
  font-size: 14.5px;
  margin: 0;
  flex: 1;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.field label {
  font-size: 12px;
  color: var(--text-2);
}
.field label b {
  color: var(--text);
}
.hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.5;
}
.warn-text {
  margin: 0;
  font-size: 12.5px;
  color: #ffb4b2;
  background: var(--danger-soft);
  border: 1px solid rgba(240, 81, 78, 0.45);
  border-radius: var(--r-sm);
  padding: 9px 11px;
  line-height: 1.55;
}
.panel-foot {
  margin-top: auto;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 8px;
}
</style>
