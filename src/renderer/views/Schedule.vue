<template>
  <div class="page">
    <!-- 标题栏 -->
    <div class="x-head">
      <h1>定时</h1>
      <span class="x-sub">
        {{ jobs.filter(j => j.mode !== 'collect').length }} 个闹钟 · 已开启
        {{ jobs.filter(j => j.mode !== 'collect' && j.enabled).length }} 个<template v-if="collectSchedActive"> · 采集 {{ collectTime }}</template>
      </span>
      <span class="x-spacer"></span>
      <button class="x-btn" @click="toggleAll(true)">
        <svg viewBox="0 0 24 24"><path d="m5 13 4 4L19 7" /></svg>
        全部开启
      </button>
      <button class="x-btn" @click="toggleAll(false)">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="m8 12 8 0" /></svg>
        全部关闭
      </button>
      <button class="x-btn primary" :disabled="saving" @click="save">
        <svg viewBox="0 0 24 24"><path d="M5 4h11l3 3v13H5z" /><path d="M9 4v5h6V4" /><path d="M9 15h6" /></svg>
        {{ saving ? '保存中…' : '保存全部' }}
      </button>
    </div>

    <!-- 保存反馈 -->
    <div v-if="saveError" class="x-tip warn" style="margin-bottom: 14px">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
      <span>{{ saveError }}</span>
    </div>
    <div v-else-if="saved" class="x-tip ok" style="margin-bottom: 14px">
      <svg viewBox="0 0 24 24"><path d="m5 13 4 4L19 7" /></svg>
      <span>已保存，调度器已重新加载（1 分钟内生效）</span>
    </div>

    <!-- 采集面板（独立于闹钟） -->
    <div class="x-card">
      <div class="x-card-head">
        <span class="x-ic">
          <svg viewBox="0 0 24 24"><path d="M12 3v10" /><path d="m8 9 4 4 4-4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>
        </span>
        <h2>采集面板</h2>
        <span class="x-hint">
          已选 {{ collectSelection.length }} 个账号<template v-if="collectSchedActive"> · 每天 {{ collectTime }} 自动采集</template>
        </span>
        <span class="x-spacer"></span>
        <button class="x-mini" @click="collectExpanded = !collectExpanded">
          {{ collectExpanded ? '收起' : '展开' }}
        </button>
      </div>

      <div v-if="collectExpanded" class="x-card-body">
        <div class="acc-grid">
          <label
            v-for="acc in uniqueAccounts"
            :key="acc.name"
            class="acc-chip"
            :class="{ on: collectSelection.includes(acc.name), bad: !acc.bitEnvId }"
          >
            <input type="checkbox" :value="acc.name" v-model="collectSelection" />
            <span class="an">{{ acc.name }}</span>
            <span class="ap">{{ platformLabel(acc.platform) }}</span>
            <i class="x-dot" :class="acc.bitEnvId ? 'ok' : 'warn'"></i>
          </label>
          <div v-if="uniqueAccounts.length === 0" class="acc-empty">暂无账号，请先到「配置」添加</div>
        </div>

        <div class="crow">
          <button class="x-mini" @click="selectAllCollect">全选</button>
          <button class="x-mini" @click="collectSelection = []">清空</button>
          <button class="x-btn primary sm" :disabled="collectRunning || collectSelection.length === 0" @click="startCollect">
            <svg viewBox="0 0 24 24"><path d="M7 5l10 7-10 7z" /></svg>
            {{ collectRunning ? '采集中…' : '开始采集' }}
          </button>
          <button v-if="collectRunning" class="x-btn sm danger" @click="stopCollect">取消采集</button>
          <span v-if="collectDone" class="x-tag ok">采集完成</span>
        </div>

        <!-- 采集定时：和闹钟共用顶部「保存全部」（这里以前有个独立「保存」，会用磁盘旧数据盖掉未保存的闹钟改动） -->
        <div class="crow top-line">
          <span class="lbl">每日定时采集</span>
          <TimePicker v-model="collectTime" />
          <label class="auto-toggle">
            <input type="checkbox" v-model="collectAuto" />
            <span>启用</span>
          </label>
          <span v-if="collectSchedActive" class="x-tag brand">每天 {{ collectTime }} 执行</span>
          <span v-else class="x-hint">改了这里也要点右上角「保存全部」</span>
        </div>
      </div>
    </div>

    <!-- 按账号分组的闹钟 -->
    <div v-for="(group, gIdx) in groupedJobs" :key="gIdx" class="x-card grp">
      <div class="x-card-head">
        <span v-if="group.account" class="gacc">{{ group.account }}</span>
        <span v-else class="x-ic">
          <svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h10" /></svg>
        </span>
        <h2>{{ group.account ? '账号 ' + group.account : '未指定账号（仅生成，不发布）' }}</h2>
        <span class="x-spacer"></span>
        <span class="x-hint">{{ group.jobs.length }} 个闹钟</span>
      </div>

      <div class="x-card-body grid">
        <!--
          一个闹钟 = 一行（2026-10-19 收口）。
          以前每张卡 3 排 9 个控件（开关/时间/复制/删除/模式×3/账号/自动发布/名称），
          20 个闹钟就是 180 个控件、整页要滚十几屏。
          名称那排删了：它的默认值就是模式名，而 setMode() 本来就会覆盖它 ——
          可编辑却会被切模式改掉，属于"看着能改、改了不算"。
        -->
        <div
          v-for="(job, jIdx) in group.jobs"
          :key="`${job.id}::${gIdx}-${jIdx}`"
          class="alarm"
          :class="{ off: !job.enabled }"
        >
          <button class="x-switch" :class="{ on: job.enabled }" :title="job.enabled ? '点击暂停' : '点击启用'" @click="job.enabled = !job.enabled">
            <i></i>
          </button>
          <TimePicker v-model="job.time" />

          <div class="seg">
            <button
              v-for="opt in modeOptions"
              :key="opt.value"
              class="segbtn"
              :class="{ on: job.mode === opt.value }"
              @click="setMode(globalIndex(group, jIdx), opt.value)"
            >
              {{ opt.label }}
            </button>
          </div>

          <div class="acc-picker">
            <input
              class="x-input"
              :value="displayAccountName(job.account)"
              @input="onAccSearch($event, globalIndex(group, jIdx))"
              @focus="onAccFocus(globalIndex(group, jIdx), $event.target)"
              @click="onAccClick(globalIndex(group, jIdx), $event.target)"
              @blur="onAccBlur(globalIndex(group, jIdx))"
              @keydown.down.prevent="onAccArrow(globalIndex(group, jIdx), 1)"
              @keydown.up.prevent="onAccArrow(globalIndex(group, jIdx), -1)"
              @keydown.enter.prevent="onAccEnter(globalIndex(group, jIdx))"
              placeholder="留空 = 仅生成不发布"
            />
            <!-- 下拉挂到 body 上（卡片 overflow 会把它裁掉），fixed 定位跟着输入框 -->
            <Teleport to="body">
              <div v-if="job._showDropdown" class="acc-drop" :style="job._dropStyle || {}">
                <div
                  v-for="(acc, ai) in filteredAccs(globalIndex(group, jIdx))"
                  :key="acc.name"
                  class="acc-opt"
                  :class="{ hi: ai === job._highlightIdx }"
                  @mousedown.prevent="selectAcc(globalIndex(group, jIdx), acc.name)"
                >
                  <span class="an">{{ acc.name }}</span>
                  <span class="env" :class="{ bad: !acc.bitEnvId }">{{ acc.bitEnvId || '未配置环境' }}</span>
                </div>
                <div v-if="filteredAccs(globalIndex(group, jIdx)).length === 0" class="acc-opt empty">无匹配账号</div>
              </div>
            </Teleport>
          </div>

          <span class="auto-tag" :class="{ on: !!job.account }" :title="job.account ? '生成完自动发到这个账号' : '没选账号 = 只生成不发布'">
            {{ job.account ? '自动发布' : '仅生成' }}
          </span>

          <button class="x-mini" title="复制这个闹钟" @click="cloneJob(globalIndex(group, jIdx))">
            <svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" /></svg>
          </button>
          <button class="x-mini danger" title="删除这个闹钟" @click="removeJob(globalIndex(group, jIdx))">
            <svg viewBox="0 0 24 24"><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /></svg>
          </button>
        </div>
      </div>
    </div>

    <button class="add-alarm" @click="addJob">
      <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
      添加闹钟
    </button>

    <div class="x-tip">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
      <span>
        关闭开关 = 暂停（配置保留）· 选了账号 = 生成后自动发布到该账号，不选 = 仅生成内容 ·
        定时由后台调度器执行，应用需要保持运行；出发前会先查登录态，账号掉登录会跳过这一轮并写日志。
      </span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'

import TimePicker from '../components/TimePicker.vue'
import { MODE_OPTIONS as modeOptions, MODE_LABEL_MAP as modeLabelMap } from '../constants.js'
import { reconcileJobIds, nextJobId as nextJobIdFrom } from '../../job-ids.js'

const jobs = ref([])
const accounts = ref([])
const saving = ref(false)
const saved = ref(false)
const saveError = ref('')
const searchTexts = ref({})  // 每个闹钟的账号搜索文本

// ===== 闹钟 id 分配 =====
// 旧实现是模块级 `let nextId = 100`，每次组件挂载都重置，且 load() 不与磁盘数据对账，
// 于是每次会话都重新发 100/101…，config/schedule.json 里出现了 2,101,101 这样的重复 id。
// 更早的版本还用过 `Date.now()` 当 id，留下 1783852240727 这种 13 位数字，和 1/2/102 混在一份配置里
// （用户 2026-10-19 反馈「编码能统一一下吗」）。
// 现在规则只有一份，在 `src/job-ids.js`：id 是 1~999 的纯序号、只增不改、重复/越界自动重发号；
// 历史 13 位 id 已由 `scripts/normalize-schedule-ids.mjs` 一次性迁移（08:30–09:15 → 1–10）。
let idSeq = 0

function nextJobId() {
  return nextJobIdFrom(jobs.value, idSeq)
}

// 采集面板
// 采集定时的唯一保存入口是顶部「保存全部」（save()），这里只放"想怎么采"的状态。
const collectExpanded = ref(false)
const collectSelection = ref([])
const collectRunning = ref(false)
const collectDone = ref(false)
const collectTime = ref('21:00')
const collectAuto = ref(true)
// 采集任务在 jobs 里是否存在，决定「每天自动采集」是否真的在跑
const collectSchedActive = computed(() => {
  const j = jobs.value.find((x) => x.mode === 'collect')
  return !!j && j.enabled !== false
})

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
// 采集能取消：主进程有 collect:cancel（killProcessTree），以前界面从来没调过 ——
// 误点一次要等 10 个环境跑完（2~3 分钟）才能干别的。
async function stopCollect() {
  try {
    const r = await window.xnowpost.cancelCollect()
    if (r && r.ok === false) console.warn('取消采集:', r.message)
  } catch (e) {
    console.error('取消采集失败:', e)
  }
}

// 加载时检查是否有 collect 的定时任务
onMounted(async () => {
  // 首个 await 抛错不能阻断后面的初始化（P2-3）
  try {
    await load()
  } catch (e) {
    console.error('加载闹钟失败:', e)
  }
  // 检测现有 collect 定时任务（失败不影响闹钟卡片本身）
  try {
    const sched = await window.xnowpost.getSchedules()
    const collectJob = (sched || []).find(j => j.mode === 'collect')
    if (collectJob) {
      collectTime.value = collectJob.time || '21:00'
      collectAuto.value = collectJob.enabled !== false
      // 恢复上一次勾选的账号
      if (collectJob.collectAccounts) {
        collectSelection.value = collectJob.collectAccounts.split(',').filter(Boolean)
      }
    }
  } catch (e) {
    console.error('读取采集定时任务失败:', e)
  }
  // 下拉是 fixed 定位，滚动/改窗口大小就收起来，免得飘在错位置
  window.addEventListener('scroll', hideAllDrops, true)
  window.addEventListener('resize', hideAllDrops)
})

function hideAllDrops(e) {
  // 下拉自己内部滚动（10 个账号放不下要滚）不能把下拉关掉
  const t = e && e.target
  if (t && t.closest && t.closest('.acc-drop')) return
  for (const job of jobs.value) {
    if (job && job._showDropdown) job._showDropdown = false
  }
}

onUnmounted(() => {
  window.removeEventListener('scroll', hideAllDrops, true)
  window.removeEventListener('resize', hideAllDrops)
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
  placeDrop(i, e.target)
}

// 点击输入框：下拉若被滚动/ resize 收起过，输入框仍然有焦点，
// 不会再触发 focus 事件 → 必须靠 click 兜底重新打开
function onAccClick(i, el) {
  if (!jobs.value[i]._showDropdown) {
    jobs.value[i]._showDropdown = true
    jobs.value[i]._highlightIdx = 0
  }
  placeDrop(i, el)
}

// 聚焦→显示下拉
function onAccFocus(i) {
  searchTexts.value[i] = ''
  jobs.value[i]._showDropdown = true
  jobs.value[i]._highlightIdx = 0
  placeDrop(i, arguments[1])
}

// 下拉浮层的定位：挂到 body 后要用 fixed 坐标跟着输入框走，
// 空间不够时往上翻（否则列表底部那几个账号还是看不到）
function placeDrop(i, el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return
  const r = el.getBoundingClientRect()
  const width = Math.max(r.width, 190)
  const count = Math.max(filteredAccs(i).length, 1)
  const height = Math.min(232, count * 30 + 10)
  const below = window.innerHeight - r.bottom
  const flipUp = below < height + 14 && r.top > height + 14
  const top = flipUp ? r.top - height - 4 : r.bottom + 4
  const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
  jobs.value[i]._dropStyle = {
    position: 'fixed',
    left: `${Math.round(left)}px`,
    top: `${Math.round(Math.max(8, top))}px`,
    width: `${Math.round(width)}px`,
    maxHeight: `${Math.round(height)}px`,
  }
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
  try {
    jobs.value = await window.xnowpost.getSchedules()
  } catch (e) {
    console.error('读取定时任务失败:', e)
    jobs.value = []
  }
  if (!Array.isArray(jobs.value)) jobs.value = []
  if (!jobs.value.length) resetDefaults()
  // 与磁盘数据对账：修复历史遗留的重复 id，并把发号器对齐到当前最大 id
  idSeq = reconcileJobIds(jobs.value)
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

function addJob() {
  jobs.value.push({
    id: nextJobId(),
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
    ...JSON.parse(JSON.stringify(orig)),
    id: nextJobId(),
    label: orig.label + ' (复制)',
  })
}

function removeJob(i) {
  jobs.value.splice(i, 1)
  // searchTexts 是按全局下标存的，删除后下标整体前移，必须清空重建，
  // 否则会把上一个闹钟的搜索词套到错误的下一个闹钟上
  searchTexts.value = {}
}

function toggleAll(enabled) {
  jobs.value.forEach(j => (j.enabled = enabled))
}

// 按账号分组（同账号闹钟排一起，无账号的放最后，过滤掉采集任务）
const groupedJobs = computed(() => {
  const groups = {}
  for (const job of jobs.value) {
    // 采集任务已有独立面板，不在闹钟卡片区域重复展示
    if (job.mode === 'collect') continue
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
    // ⚠️ 送进 IPC 的必须是能结构化克隆的纯数据：
    //    ① 以 _ 开头的都是界面临时字段（_showDropdown / _highlightIdx / _dropStyle…），
    //       其中 _dropStyle 是响应式对象，直接传会报
    //       "Failed to execute 'structuredClone' on 'Window': #<Object> could not be cloned."
    //    ② Vue 的响应式代理本身也克隆不了 → 统一走一遍 JSON 往返拿纯对象。
    //    按前缀过滤而不是白名单，避免以后新增的调度字段被悄悄丢掉。
    const raw = JSON.parse(
      JSON.stringify(
        jobs.value
          // 采集定时任务由下面的 collectJob 统一生成，内存里那份不作数（防止出现两条）
          .filter((j) => j.mode !== 'collect')
          .map((j) => {
            const plain = {}
            for (const [k, v] of Object.entries(j)) {
              if (k.startsWith('_')) continue
              plain[k] = v
            }
            return plain
          }),
      ),
    )

    /*
     * 采集定时也走这一处保存（2026-10-19 收口）。
     * 以前采集面板有独立的「保存」：它自己 getSchedules() 读**磁盘**再写回，
     * 用户在闹钟卡片上的改动还在内存里没保存 → 被磁盘旧数据整体盖掉，改动静默丢失。
     * 现在只有一个「保存全部」，两边一起写。
     */
    if (collectTime.value) {
      const existing = jobs.value.find((j) => j.mode === 'collect')
      raw.push({
        id: (existing && Number(existing.id)) || nextJobId(),
        time: collectTime.value,
        mode: 'collect',
        label: '数据采集 + 日报',
        enabled: collectAuto.value !== false,
        collectAccounts: collectSelection.value.join(','),
      })
    }

    const result = await window.xnowpost.saveSchedules(raw)
    if (!result || !result.ok) {
      saveError.value = result?.message || '保存失败'
    } else {
      saved.value = true
      saveError.value = ''
      // 保存成功后把内存里的 collect 条目对齐磁盘，避免下次保存重复发号
      const collectJob = raw.find((j) => j.mode === 'collect')
      const idx = jobs.value.findIndex((j) => j.mode === 'collect')
      if (collectJob) {
        if (idx >= 0) jobs.value.splice(idx, 1, { ...collectJob })
        else jobs.value.push({ ...collectJob })
      } else if (idx >= 0) {
        jobs.value.splice(idx, 1)
      }
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
.page {
  padding-bottom: 8px;
}

.x-tip.ok {
  color: var(--ok);
  background: var(--ok-soft);
  border-color: rgba(45, 212, 167, 0.3);
}

/* ── 采集面板 ── */
.x-card + .x-card,
.x-card + .grp {
  margin-top: 12px;
}

.acc-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 7px;
  padding: 10px 0 4px;
}

.acc-chip {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 9px;
  border-radius: var(--r-sm);
  background: var(--bg1);
  border: 1px solid var(--stroke);
  cursor: pointer;
  font-size: 12px;
  color: var(--text-2);
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}
.acc-chip:hover {
  border-color: var(--stroke-2);
  color: var(--text);
}
.acc-chip.on {
  border-color: rgba(255, 46, 91, 0.55);
  background: var(--brand-soft);
  color: var(--text);
}
.acc-chip input {
  display: none;
}
.acc-chip .an {
  font-weight: 640;
  font-family: var(--font-mono);
  color: var(--text);
}
.acc-chip .ap {
  font-size: 10.5px;
  color: var(--text-3);
}
.acc-chip .x-dot {
  margin-left: auto;
}
.acc-empty {
  grid-column: 1 / -1;
  font-size: 12px;
  color: var(--text-3);
  padding: 6px 2px;
}

.crow {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 10px;
}
.crow.top-line {
  margin-top: 10px;
  border-top: 1px dashed var(--stroke);
}
.crow .lbl {
  font-size: 12px;
  color: var(--text-2);
  font-weight: 600;
}

.x-btn.sm {
  padding: 5px 11px;
  font-size: 12px;
}

/* ── 闹钟分组 ── */
.gacc {
  width: 26px;
  height: 26px;
  flex: 0 0 26px;
  border-radius: 8px;
  background: var(--brand-soft);
  color: var(--brand);
  border: 1px solid rgba(255, 46, 91, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11.5px;
  font-weight: 700;
  font-family: var(--font-mono);
}

.grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 12px;
}

/* 一个闹钟 = 一行：开关 / 时间 / 模式 / 账号 / 自动发布 / 复制 / 删除 */
.alarm {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--r-md);
  background: var(--bg1);
  border: 1px solid var(--stroke);
  transition: border-color 0.15s, opacity 0.15s;
}
.alarm:hover {
  border-color: var(--stroke-2);
}
.alarm.off {
  opacity: 0.55;
}
.alarm .seg {
  flex: 0 0 auto;
}
.alarm .segbtn {
  flex: 0 0 auto;
  padding: 4px 10px;
}
.alarm .acc-picker {
  flex: 0 1 200px;
}
/* 自动发布/仅生成 状态：只说明这一行会发生什么，不可点 */
.auto-tag {
  flex: 0 0 auto;
  margin-left: auto;   /* 状态 + 复制 + 删除贴右边，"自动发布"紧跟着账号框 */
  font-size: 11px;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: 999px;
  color: var(--text-3);
  background: var(--bg2);
  border: 1px solid var(--stroke);
  white-space: nowrap;
}
.auto-tag.on {
  color: var(--brand);
  background: var(--brand-soft);
  border-color: transparent;
}

.arow {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
/* 采集定时的启用开关（跟闹钟共用「保存全部」） */
.auto-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
}
.auto-toggle input {
  accent-color: var(--brand);
}

/* 模式分段控件 */
.seg {
  display: flex;
  gap: 4px;
  background: var(--bg2);
  border: 1px solid var(--stroke);
  border-radius: var(--r-sm);
  padding: 3px;
}
.segbtn {
  flex: 1;
  padding: 5px 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  font-size: 11.5px;
  font-weight: 600;
  font-family: var(--font-ui);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  white-space: nowrap;
}
.segbtn:hover {
  color: var(--text);
  background: var(--bg3);
}
.segbtn.on {
  background: var(--brand);
  color: #fff;
}

/* 账号选择器 */
.acc-picker {
  position: relative;
  flex: 1;
  min-width: 0;
}
.acc-picker .x-input {
  height: 30px;
  font-size: 12px;
}
/* 下拉挂到 body 上：fixed 定位 + 高 z-index，卡片 overflow 裁不到它 */
.acc-drop {
  position: fixed;
  z-index: 900;
  overflow-y: auto;
  background: var(--bg2);
  border: 1px solid var(--stroke-2);
  border-radius: var(--r-sm);
  box-shadow: var(--shadow-2);
  padding: 4px;
}
.acc-opt {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
}
.acc-opt:hover,
.acc-opt.hi {
  background: var(--bg3);
  color: var(--text);
}
.acc-opt .an {
  font-family: var(--font-mono);
  font-weight: 640;
  color: var(--text);
}
.acc-opt .env {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--ok);
  font-family: var(--font-mono);
}
.acc-opt .env.bad {
  color: var(--warn);
}
.acc-opt.empty {
  color: var(--text-3);
  cursor: default;
  font-size: 11.5px;
}

.name {
  height: 30px;
  font-size: 12px;
}

/* 添加闹钟 */
.add-alarm {
  width: 100%;
  margin-top: 12px;
  padding: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border: 1px dashed var(--stroke-2);
  border-radius: var(--r-md);
  background: transparent;
  color: var(--text-3);
  font-size: 12.5px;
  font-weight: 600;
  font-family: var(--font-ui);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.add-alarm svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
}
.add-alarm:hover {
  color: var(--brand);
  border-color: rgba(255, 46, 91, 0.5);
  background: var(--brand-soft);
}

.x-tip {
  margin-top: 14px;
}
</style>
