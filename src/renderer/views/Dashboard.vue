<template>
  <div class="dashboard-page">
    <!-- ===== 顶栏 ===== -->
    <div class="x-head">
      <h1>控制台</h1>
      <span class="x-sub">
        {{ store.status.running ? '引擎运行中' : store.status.schedulerActive ? '调度器执行中' : '引擎空闲' }} · {{ store.status.configured ? '已配置' : '未配置' }}
      </span>
      <span class="x-spacer"></span>
      <button class="x-btn primary" @click="runAuto" :disabled="store.status.running || !store.status.configured">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13.5 3 5.5 13.5H11l-.7 7.5L18.5 10H13z" />
        </svg>
        <span>立即生成（{{ isMorning ? '1视频+1图文' : '1视频' }}）</span>
      </button>
    </div>

    <!-- ===== 状态条 ===== -->
    <div class="x-tip status-strip" :class="{ warn: !store.status.configured }">
      <span
        class="x-dot"
        :class="store.status.configured ? (store.status.running || store.status.schedulerActive ? 'warn' : 'ok') : 'off'"
      ></span>
      <span class="status-text">
        {{ !store.status.configured ? '还需要配置 API Key 才能开始工作' : store.status.running ? '引擎运行中…' : store.status.schedulerActive ? '调度器执行中' : '一切就绪' }}
      </span>
      <span class="status-badges">
        <span v-if="store.status.running" class="x-tag brand">引擎运行中</span>
        <span v-else-if="store.status.schedulerActive" class="x-tag warn">调度器执行中</span>
        <span v-else class="x-tag mute">空闲</span>
        <span v-if="store.status.schedulerLastRun" class="x-tag mute">{{ store.status.schedulerLastRun }}</span>
      </span>
    </div>

    <!-- 未配置引导 -->
    <div v-if="!store.status.configured" class="x-card">
      <div class="x-card-head">
        <span class="x-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3.2 14.4 9l6.3.5-4.8 4.1 1.5 6.2L12 16.6 6.6 19.8l1.5-6.2L3.3 9.5 9.6 9z" />
          </svg>
        </span>
        <h2>欢迎使用 XNOWPost</h2>
        <span class="x-hint">还差一步就能开始生成</span>
        <div class="x-spacer"></div>
        <router-link to="/config" class="x-btn primary">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
          <span>去配置页填写</span>
        </router-link>
      </div>
      <div class="x-card-body">
        <div class="x-tip warn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.5v5.5M12 16.5h.01" />
          </svg>
          <span>
            需要先配置 API Key 才能开始生成内容：<br />
            <b>DeepSeek</b> — AI 生成文案（注册送额度）<br />
            <b>硅基流动</b> — AI 生成图片（注册送 14 元）<br />
            <b>Telegram Bot</b> — 可选，推送到频道
          </span>
        </div>
      </div>
    </div>

    <!-- 内容生成：本次生成的临时参数，不动持久设置；整张卡片就是截图拖拽区 -->
    <div
      class="x-card gen-card"
      :class="{ dragging }"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <div class="x-card-head">
        <span class="x-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16z" />
            <path d="m14 6 4 4" />
          </svg>
        </span>
        <h2>内容生成</h2>
        <span class="x-hint">只影响这一次生成</span>
        <div class="x-spacer"></div>
        <span v-if="gen.images.length" class="x-tag brand">截图 {{ gen.images.length }} 张</span>
      </div>
      <div class="x-card-body">
        <!-- 主题 / 批量（仅已配置且空闲时可填） -->
        <template v-if="store.status.configured && !store.status.running && !store.status.schedulerActive">
          <div class="x-field gen-row">
            <span class="x-label"><b>主题</b></span>
            <input
              v-model="quickTopic"
              placeholder="输入主题（留空让 AI 自由发挥）…"
              class="x-input"
              @keyup.enter="quickGenerate"
              :disabled="batchMode"
            />
            <div class="x-actions">
              <button class="x-btn" @click="quickGenerate" :disabled="batchMode">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M13.5 3 5.5 13.5H11l-.7 7.5L18.5 10H13z" />
                </svg>
                <span>生成</span>
              </button>
              <button class="x-btn" :class="{ on: batchMode }" @click="batchMode = !batchMode">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M9 6h11M9 12h11M9 18h11" />
                  <circle cx="5" cy="6" r="1" />
                  <circle cx="5" cy="12" r="1" />
                  <circle cx="5" cy="18" r="1" />
                </svg>
                <span>批量</span>
              </button>
            </div>
          </div>

          <!-- 批量主题 -->
          <div v-if="batchMode && !store.status.running" class="x-field gen-row">
            <span class="x-label">
              <b>批量主题</b>
              <span class="x-tag mute">{{ topicCount }} 条</span>
            </span>
            <div class="stack">
              <textarea v-model="batchTopics" class="x-textarea" rows="4" placeholder="AI 视频创作技巧&#10;今日科技新闻&#10;产品使用教程"></textarea>
              <span class="res-line">每行一个主题，按顺序依次生成</span>
            </div>
            <div class="x-actions act-col">
              <button class="x-btn" @click="runBatch" :disabled="!batchTopics.trim()">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="m8 5 11 7-11 7z" />
                </svg>
                <span>批量生成 ({{ topicCount }})</span>
              </button>
              <button class="x-btn" @click="batchMode = false"><span>取消</span></button>
            </div>
          </div>
        </template>

        <!-- 进度（引擎运行时显示） -->
        <div v-if="store.status.running" class="progress-box">
          <div class="progress-top">
            <span class="spin"></span>
            <span class="progress-title">{{ batchTotal > 0 ? `批量生成 ${batchDone}/${batchTotal}` : '正在生成…' }}</span>
            <button class="x-btn danger" @click="handleCancel" :disabled="cancelling">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
              <span>{{ cancelling ? '取消中…' : '取消' }}</span>
            </button>
          </div>
          <div class="progress-step-label">{{ currentStep.label }}</div>
          <div class="progress-bar">
            <div class="progress-fill" :style="{ width: currentStep.percent + '%' }"></div>
          </div>
          <div class="progress-log">
            <div v-for="(log, i) in recentLogs" :key="i" class="progress-line" :class="log.type">
              <span class="progress-line-time">{{ log.time.slice(-8) }}</span>
              <span class="progress-line-msg">{{ log.message }}</span>
            </div>
          </div>
        </div>

        <!-- 配音语言 -->
        <div class="x-field">
          <span class="x-label"><b>配音</b></span>
          <div class="seg">
            <button class="seg-btn" :class="{ active: gen.voiceLang === 'zh' }" @click="gen.voiceLang = 'zh'">中文</button>
            <button class="seg-btn" :class="{ active: gen.voiceLang === 'en' }" @click="gen.voiceLang = 'en'">English</button>
            <button class="seg-btn" :class="{ active: gen.voiceLang === 'auto' }" @click="gen.voiceLang = 'auto'">跟随设置</button>
          </div>
        </div>

        <!-- 画面（上传截图） -->
        <div class="x-field gen-row">
          <span class="x-label"><b>画面</b></span>
          <div class="stack">
            <span v-if="gen.images.length" class="res-line ok">
              已选 {{ gen.images.length }} 张
              <a class="link" @click="gen.images = []">清除</a>
            </span>
            <span v-else class="res-line">不上传 → 自动用免费实拍素材</span>
          </div>
          <div class="x-actions">
            <button class="x-btn" @click="pickShots" :disabled="store.status.running">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
                <circle cx="9" cy="10" r="1.6" />
                <path d="m4.5 17 4.6-4.4 3.2 3 2.6-2.4 4.1 4" />
              </svg>
              <span>{{ gen.images.length ? '继续添加' : '上传截图' }}</span>
            </button>
          </div>
        </div>

        <div class="x-tip drop-tip">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v5.5M12 7.6h.01" />
          </svg>
          <span>可以直接把图片<b>拖进来</b>，或按 <b>Ctrl+V</b> 粘贴剪贴板里的截图{{ dragging ? ' —— 松手即可加入' : '' }}</span>
        </div>

        <!-- 主操作：同一行 .x-btn，只有「立即生成」是主按钮 -->
        <div class="gen-actions">
          <button class="x-btn primary" @click="runAuto" :disabled="store.status.running || !store.status.configured">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M13.5 3 5.5 13.5H11l-.7 7.5L18.5 10H13z" />
            </svg>
            <span>立即生成（{{ isMorning ? '1视频+1图文' : '1视频' }}）</span>
          </button>
          <button class="x-btn" @click="runVideo" :disabled="store.status.running || !store.status.configured">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="5.5" width="13" height="13" rx="2.5" />
              <path d="m16 10.5 5-2.8v8.6l-5-2.8z" />
            </svg>
            <span>仅视频</span>
          </button>
          <button class="x-btn" @click="runPost" :disabled="store.status.running || !store.status.configured">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
              <circle cx="9" cy="10" r="1.6" />
              <path d="m4.5 17 4.6-4.4 3.2 3 2.6-2.4 4.1 4" />
            </svg>
            <span>仅图文</span>
          </button>
          <button class="x-btn" @click="handleCollect" :disabled="collecting">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 19V5M4 19h16" />
              <path d="M8 16v-4M12.5 16V8M17 16v-2.5" />
            </svg>
            <span>{{ collecting ? '采集中…' : '采集' }}</span>
          </button>
          <button class="x-btn" @click="handlePublish" :disabled="publishing" :title="`发到 ${publishTargetLabel}`">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 4 11.6 20.4l-2.1-6.9L2.6 11.4z" />
              <path d="m9.5 13.5 4.2-4.2" />
            </svg>
            <span>{{ publishing ? '发布中…' : (publishTarget ? `发布 → ${publishTarget} 号` : '发布') }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 完成通知横幅 -->
    <div v-if="showCompletionBanner" class="x-card done-banner">
      <div class="done-inner">
        <span class="done-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="m8.4 12.4 2.6 2.6 4.6-5.2" />
          </svg>
        </span>
        <span class="done-text">内容已生成完成！</span>
        <button class="x-btn primary" @click="handlePublish" :disabled="publishing" :title="`发到 ${publishTargetLabel}`">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 4 11.6 20.4l-2.1-6.9L2.6 11.4z" />
            <path d="m9.5 13.5 4.2-4.2" />
          </svg>
          <span>{{ publishing ? '发布中…' : `立即发布 → ${publishTargetLabel}` }}</span>
        </button>
        <button class="x-mini" @click="showCompletionBanner = false" aria-label="关闭">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 内容预览 -->
    <div v-if="previewData" class="x-card">
      <div class="x-card-head">
        <span class="x-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 3.5h7l5 5v12H6z" />
            <path d="M13 3.5v5h5" />
          </svg>
        </span>
        <h2>最新生成内容</h2>
        <div class="x-spacer"></div>
        <button class="x-mini" @click="previewData = null" aria-label="关闭">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
      <div class="x-card-body">
        <div v-if="previewData.text" class="preview-text">{{ previewData.text.slice(0, 300) }}{{ previewData.text.length > 300 ? '...' : '' }}</div>
        <div v-if="previewData.images?.length" class="preview-imgs">
          <img v-for="(img, ii) in previewData.images.slice(0, 3)" :key="ii" :src="img.data" class="preview-img" />
        </div>
      </div>
    </div>

    <!-- 失败/异常红条（2026-10-19 P0-3）：TG 没配、系统通知可能被系统静音，
         所以界面上必须有一眼看得到的位置。点「看日志」直接跳运行日志页。 -->
    <div v-if="errorBanner" class="alert-bar danger">
      <span class="ab-ic">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3.2 21 20H3z" />
          <path d="M12 9v5M12 17h.01" />
        </svg>
      </span>
      <div class="ab-body">
        <span class="ab-title">最近有 {{ store.status.recentErrors }} 条错误</span>
        <span class="ab-text">{{ errorBanner }}</span>
      </div>
      <div class="x-spacer"></div>
      <button class="x-mini" @click="gotoLogs">看日志</button>
      <button class="x-mini" @click="bannerDismissed = true" aria-label="关闭">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>

    <!-- 系统状态 -->
    <div class="kpis">
      <div class="kpi" :class="{ on: store.status.running }">
        <div class="k">
          <span class="x-dot" :class="store.status.running ? 'ok' : 'off'"></span>引擎
        </div>
        <div class="v">
          {{ store.status.running ? '运行中' : '空闲' }}
          <span class="x-tag" :class="store.status.running ? 'brand' : 'mute'">{{ store.status.running ? '生成中' : '待命' }}</span>
        </div>
      </div>
      <div class="kpi" :class="{ on: store.status.schedulerRunning }">
        <div class="k">
          <span class="x-dot" :class="store.status.schedulerRunning ? 'ok' : 'off'"></span>调度器
        </div>
        <div class="v">
          {{ store.status.schedulerRunning ? '运行中' : '已停止' }}
          <small>{{ store.status.schedulerLastRun ? `上次 ${store.status.schedulerLastRun}` : '未执行' }}</small>
        </div>
      </div>
      <div class="kpi">
        <div class="k">
          <span class="x-dot" :class="store.status.recentErrors > 0 ? 'warn' : 'ok'"></span>错误
        </div>
        <div class="v" :class="{ err: store.status.recentErrors > 0 }">
          {{ store.status.recentErrors || 0 }} 条
          <span class="x-tag" :class="store.status.recentErrors > 0 ? 'danger' : 'ok'">{{ store.status.recentErrors > 0 ? '需处理' : '无异常' }}</span>
        </div>
      </div>
      <div class="kpi">
        <div class="k">
          <span class="x-dot" :class="store.status.configured ? 'ok' : 'warn'"></span>配置
        </div>
        <div class="v">
          {{ store.status.configured ? '已配置' : '未配置' }}
          <span class="x-tag" :class="store.status.configured ? 'ok' : 'warn'">{{ store.status.configured ? '就绪' : '缺 Key' }}</span>
        </div>
      </div>
    </div>

    <!-- 调度执行进度 -->
    <div class="x-card sched-progress">
      <div class="x-card-head">
        <span class="x-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="8.5" />
            <path d="M12 7.5V12l3 2" />
          </svg>
        </span>
        <h2>调度进度</h2>
        <span class="x-hint">
          <template v-if="sched.active">正在执行 · {{ sched.current?.label }} · 已用 {{ fmtElapsed(sched.current?.elapsedSec) }}</template>
          <template v-else-if="sched.schedulerRunning">空闲 · 等下一个闹钟</template>
          <template v-else>调度器未运行</template>
        </span>
        <div class="x-spacer"></div>
        <span v-if="sched.active" class="x-tag brand">执行中</span>
        <span v-else class="x-tag mute">待命</span>
        <button class="x-mini" @click="refreshProgress" title="刷新">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 4v4.5h-4.5" />
          </svg>
        </button>
      </div>
      <div class="x-card-body">
        <!-- 当前任务 + 阶段 -->
        <template v-if="sched.active">
          <div class="sp-row">
            <div class="sp-stage" :class="sched.stage">
              <span class="x-dot" :class="sched.stage === 'failed' ? 'warn' : sched.stage === 'published' ? 'ok' : 'ok'"></span>
              <b>{{ sched.stageText || '已启动' }}</b>
              <span v-if="sched.sessionDir" class="sp-dir">{{ sched.sessionDir }}</span>
            </div>
            <span class="x-spacer"></span>
            <span class="sp-time" v-if="sched.current?.startedAt">开始 {{ sched.current.startedAt.slice(11) }}</span>
            <span class="sp-time mono">{{ fmtElapsed(sched.current?.elapsedSec) }}</span>
          </div>
          <div class="sp-bar"><i></i></div>
          <!-- 阶段线路 -->
          <div class="sp-steps">
            <span v-for="(st, i) in SCHED_STEPS" :key="st.key" class="sp-step" :class="{ on: stepReached(i), cur: stepCurrent(i) }">
              {{ st.text }}
            </span>
          </div>
        </template>

        <!-- 空闲：接下来跑什么 -->
        <template v-else>
          <div v-if="sched.next.length" class="sp-next">
            <div v-for="n in sched.next" :key="n.time + n.account" class="sp-next-item">
              <span class="sp-t mono">{{ n.time }}</span>
              <span class="sp-n">{{ n.label || n.mode }}</span>
              <span v-if="n.account" class="x-tag mute">账号 {{ n.account }}</span>
              <span class="x-spacer"></span>
              <span class="sp-in">{{ fmtIn(n.inMinutes) }}</span>
            </div>
          </div>
          <div v-else class="x-hint">没有启用的闹钟 —— 去「定时」页加一个</div>
          <div v-if="sched.lastRun" class="sp-last">上次执行：{{ sched.lastRun }}</div>
        </template>

        <!-- 日志尾 -->
        <div v-if="sched.tail.length" class="sp-log">
          <div v-for="(l, i) in sched.tail.slice(-6)" :key="i" class="sp-line">{{ l }}</div>
        </div>
      </div>
    </div>

    <!-- 引擎连续失败警告 -->
    <div v-if="consecutiveFailures >= 2" class="x-tip warn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10.3 4.3 2.8 17.5A1.7 1.7 0 0 0 4.3 20h15.4a1.7 1.7 0 0 0 1.5-2.5L13.7 4.3a1.9 1.9 0 0 0-3.4 0z" />
        <path d="M12 9.5v4M12 16.6h.01" />
      </svg>
      <span>引擎已连续 {{ consecutiveFailures }} 次执行失败</span>
      <button class="x-mini" @click="dismissWarning">知道了</button>
    </div>

    <!-- 待发布卡片 -->
    <div v-if="pendingItems.length > 0" class="x-card">
      <div class="x-card-head">
        <span class="x-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 4 11.6 20.4l-2.1-6.9L2.6 11.4z" />
            <path d="m9.5 13.5 4.2-4.2" />
          </svg>
        </span>
        <h2>待发布内容</h2>
        <span class="x-hint">{{ pendingItems.length }} 项</span>
        <span v-if="todayPendingCount !== pendingItems.length" class="x-tag mute">当天 {{ todayPendingCount }}</span>
        <div class="x-spacer"></div>
        <button v-if="pendingItems.length > PENDING_LIMIT" class="x-mini" @click="pendingExpanded = !pendingExpanded">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <path v-if="pendingExpanded" d="m6 15 6-6 6 6" />
            <path v-else d="m6 9 6 6 6-6" />
          </svg>
          <span>{{ pendingExpanded ? '只看最近' : `展开全部` }}</span>
        </button>
        <button class="x-mini" @click="openDir">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2.5h9A1.5 1.5 0 0 1 21.5 10v8A1.5 1.5 0 0 1 20 19.5H4.5A1.5 1.5 0 0 1 3 18z" />
          </svg>
          <span>打开文件夹</span>
        </button>
      </div>
      <table>
        <thead>
          <tr>
            <th style="width: 178px">类型</th>
            <th>标题</th>
            <th style="width: 168px; text-align: right">生成时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(item, i) in shownPending" :key="i">
            <td class="pc-type">
              <span v-if="item.type === 'video'" class="x-tag brand">视频</span>
              <span v-else class="x-tag mute">图文</span>
              <!-- 旧日期/失败过的会话必须标出来：默认不会被发布，别让人以为点了「发布全部」就会发 -->
              <span v-if="item.old" class="x-tag mute" title="非当天的旧会话，默认不发布">旧</span>
              <span v-if="item.failed" class="x-tag" :class="item.retryable ? 'warn' : 'danger'"
                    :title="item.retryable ? '上次卡在发布阶段，会重试' : `上次失败于「${item.failedStage || '未知'}」，需要先重新生成`">
                {{ item.retryable ? '待重试' : '失败' }}
              </span>
            </td>
            <td><span class="pc-title">{{ item.title }}</span></td>
            <td class="num">{{ item.date }} {{ item.time }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="!pendingExpanded && pendingItems.length > PENDING_LIMIT" class="pc-hint">
        还有 {{ pendingItems.length - PENDING_LIMIT }} 项未显示
      </div>
      <div class="card-foot">
        <label class="pc-old" title="勾上才会把非当天的旧会话也发出去">
          <input v-model="includeOld" type="checkbox" />
          <span>含旧会话</span>
        </label>
        <!-- 目标账号：2026-10-19 加的。以前这里只能发 accounts[0]，用户想发 02 号没入口，
             助手也跟着发错号。现在选哪个就发哪个，选「默认」才按配置第一个。 -->
        <label class="pub-target" title="这条发到哪个指纹环境">
          <span>发到</span>
          <select v-model="publishTarget" class="x-select">
            <option value="">{{ defaultAccountLabel }}</option>
            <option v-for="a in accountOptions" :key="a.name" :value="a.name">
              {{ a.name }} · {{ a.env }}
            </option>
          </select>
        </label>
        <div class="x-spacer"></div>
        <span class="x-hint pub-hint" title="默认只发当天、每轮最多 3 条；勾「含旧会话」才发历史日期">只发当天 · 最多 3 条</span>
        <button class="x-btn" @click="handlePublish" :disabled="publishing">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 4 11.6 20.4l-2.1-6.9L2.6 11.4z" />
            <path d="m9.5 13.5 4.2-4.2" />
          </svg>
          <span>{{ publishing ? '发布中…' : '发布全部' }}</span>
        </button>
      </div>
    </div>

    <!-- 发布确认：账号发错撤不回来，所以点完按钮先看一眼"发到哪个号、几条" -->
    <div v-if="publishConfirm" class="pub-mask" @click.self="publishConfirm = false">
      <div class="pub-dialog">
        <div class="pub-dialog-head">
          <span class="x-ic">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 4 11.6 20.4l-2.1-6.9L2.6 11.4z" />
              <path d="m9.5 13.5 4.2-4.2" />
            </svg>
          </span>
          <span>确认发布</span>
        </div>
        <div class="pub-dialog-body">
          <div class="pub-row">
            <span class="pub-k">发到</span>
            <span class="pub-v">
              <b>{{ publishTargetLabel }}</b>
              <em v-if="!publishTarget" class="pub-warn">（没选账号 = 配置里第一个）</em>
            </span>
          </div>
          <div class="pub-row">
            <span class="pub-k">条数</span>
            <span class="pub-v">最多 {{ publishMaxCount }} 条{{ includeOld ? '，含历史日期会话' : '，只发当天' }}</span>
          </div>
          <div class="pub-row">
            <span class="pub-k">待发</span>
            <span class="pub-v">{{ pendingItems.length }} 条可发</span>
          </div>
          <div class="x-tip pub-tip">
            发出去就撤不回来了。要发到别的号，关掉这张卡，在「发到」里换账号。
          </div>
        </div>
        <div class="pub-dialog-foot">
          <button class="x-btn" @click="publishConfirm = false" :disabled="publishing">取消</button>
          <button class="x-btn primary" @click="confirmPublish" :disabled="publishing">
            {{ publishing ? '发布中…' : `发到 ${publishTargetLabel}` }}
          </button>
        </div>
      </div>
    </div>


    <!-- 最近费用 -->
    <div v-if="store.latestCost" class="x-card">
      <div class="x-card-head">
        <span class="x-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="6" width="18" height="12" rx="2.2" />
            <path d="M3 10h18" />
          </svg>
        </span>
        <h2>最近费用</h2>
        <span class="x-hint">本条内容的模型消耗</span>
        <div class="x-spacer"></div>
      </div>
      <div class="cost-body">
        <div class="cost-item">
          <span class="cost-metric">DeepSeek</span>
          <span class="cost-value">¥{{ store.latestCost.deepseek?.toFixed(4) || '0' }}</span>
        </div>
        <div class="cost-item">
          <span class="cost-metric">Kolors</span>
          <span class="cost-value">¥{{ store.latestCost.kolors?.toFixed(2) || '0' }}</span>
        </div>
        <div class="cost-item cost-total">
          <span class="cost-metric">合计</span>
          <span class="cost-value">¥{{ store.latestCost.total?.toFixed(2) || '0' }}</span>
        </div>
      </div>
    </div>

    <!-- 采集数据概览 -->
    <div v-if="collectData" class="x-card">
      <div class="x-card-head">
        <span class="x-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 19V5M4 19h16" />
            <path d="M8 16v-4M12.5 16V8M17 16v-2.5" />
          </svg>
        </span>
        <h2>数据概览</h2>
        <span class="x-hint">{{ collectData.date }}</span>
        <div class="x-spacer"></div>
      </div>
      <div class="x-card-body">
        <div class="plat-grid">
          <div v-for="(stats, platform) in collectData.platforms" :key="platform" class="plat-card">
            <div class="plat-name">{{ platformNames[platform] || platform }}</div>
            <div class="plat-stats">
              <div v-for="(val, key) in stats" :key="key" class="stat-item">
                <span class="stat-label">{{ metricLabels[key] || key }}</span>
                <span class="stat-value">{{ formatNum(val) }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 今日产出 -->
    <div class="x-card" v-if="store.status.todayDir">
      <div class="x-card-head">
        <span class="x-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3.5" y="5" width="17" height="15" rx="2.2" />
            <path d="M3.5 10h17M8 3.5v3M16 3.5v3" />
          </svg>
        </span>
        <h2>今日产出</h2>
        <span class="x-hint">
          {{ store.status.todayDir }}<template v-if="todayItems.length"> · {{ todayItems.length }} 条</template>
        </span>
        <div class="x-spacer"></div>
        <button v-if="todayItems.length > TODAY_LIMIT" class="x-mini" @click="todayExpanded = !todayExpanded">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <path v-if="todayExpanded" d="m6 15 6-6 6 6" />
            <path v-else d="m6 9 6 6 6-6" />
          </svg>
          <span>{{ todayExpanded ? '收起' : `显示全部 ${todayItems.length} 条` }}</span>
        </button>
        <button class="x-mini" @click="openDir">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2.5h9A1.5 1.5 0 0 1 21.5 10v8A1.5 1.5 0 0 1 20 19.5H4.5A1.5 1.5 0 0 1 3 18z" />
          </svg>
          <span>打开目录</span>
        </button>
      </div>
      <div class="x-card-body">
        <!-- 骨架屏：加载中 -->
        <div v-if="todayLoading" class="skeleton-list">
          <div v-for="n in 2" :key="n" class="skeleton-card">
            <div class="skeleton-thumb"></div>
            <div class="skeleton-lines">
              <div class="skeleton-line w-60"></div>
              <div class="skeleton-line w-30"></div>
            </div>
          </div>
        </div>

        <div v-else-if="todayItems.length === 0" class="x-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3.5 12.5 6 5.5h12l2.5 7v5.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z" />
            <path d="M3.5 12.5H9l1 2.5h4l1-2.5h5.5" />
          </svg>
          <span>还没有产出，点「立即生成」开始</span>
        </div>

        <div v-else class="today-list">
          <div v-for="item in shownToday" :key="item.id" class="item-card">
            <div class="item-thumb">
              <img v-if="item.thumbnail" :src="item.thumbnail" class="thumb-img" />
              <span v-else class="thumb-ph">
                <svg v-if="item.type === 'video'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="5.5" width="13" height="13" rx="2.5" />
                  <path d="m16 10.5 5-2.8v8.6l-5-2.8z" />
                </svg>
                <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
                  <circle cx="9" cy="10" r="1.6" />
                  <path d="m4.5 17 4.6-4.4 3.2 3 2.6-2.4 4.1 4" />
                </svg>
              </span>
            </div>
            <div class="item-body">
              <div class="item-title">{{ item.title_zh }}</div>
              <div class="item-meta">
                <span>{{ item.type === 'video' ? '视频' : '图文' }}</span>
                <span v-if="item.time">· {{ item.time }}</span>
                <span class="item-status" :class="item.status === 'ready' ? 'ok' : 'warn'">· {{ item.status === 'ready' ? '完成' : '待合成' }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 日志区域（非运行状态折叠） -->
    <div class="x-card">
      <div class="x-card-head log-head" @click="logExpanded = !logExpanded">
        <span class="x-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4.5" width="18" height="15" rx="2.2" />
            <path d="m7.5 10 2.5 2.5-2.5 2.5M13 15.5h4" />
          </svg>
        </span>
        <h2>最近日志</h2>
        <span class="x-hint">{{ store.logs.length }} 条</span>
        <div class="x-spacer"></div>
        <span class="x-mini">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <path v-if="logExpanded || store.status.running" d="m6 15 6-6 6 6" />
            <path v-else d="m6 9 6 6 6-6" />
          </svg>
          <span>{{ logExpanded || store.status.running ? '收起' : '展开' }}</span>
        </span>
      </div>
      <div v-if="logExpanded || store.status.running || store.logs.length > 0" class="log-container" :class="{ collapsed: !logExpanded && !store.status.running }">
        <div v-if="store.logs.length === 0 && !store.status.running" class="x-empty">
          暂无日志，触发「立即生成」后会显示在这里
        </div>
        <template v-else>
          <div v-for="(log, i) in displayLogs" :key="i" class="log-line" :class="log.type">
            <span class="log-time">{{ log.time }}</span>
            <span class="log-msg">{{ log.message }}</span>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useAppStore } from '../stores/app.js';
import { useRouter } from 'vue-router';
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue';
import { buildPublishOpts, publishTargetLabel as targetLabelOf, publishTargetOptions } from '../lib/publish-request.js';

const store = useAppStore();
const router = useRouter();

// 本次生成的临时选项：只影响这一条，不写进配置
const gen = reactive({
  voiceLang: 'auto',   // 'auto' | 'zh' | 'en'
  images: [],          // 当场选的截图绝对路径
});
const dragging = ref(false);

// ⚠️ 必须转成纯数据再交给 IPC。
// gen 是 reactive，gen.images 是 Proxy；ipcRenderer.invoke 用结构化克隆，
// 克隆 Proxy 会直接抛 "An object could not be cloned"，请求根本发不出去 ——
// 现象就是"点立即生成毫无反应"（已踩过，别再直接传 gen.images）。
function genOptions() {
  return { voiceLang: String(gen.voiceLang || 'auto'), images: Array.from(gen.images || [], String) };
}

// 统一的加入入口：去重，避免同一张图重复用
function addShots(paths) {
  const list = (paths || []).filter(p => typeof p === 'string' && p.trim());
  if (!list.length) return;
  gen.images = [...new Set([...gen.images, ...list])];
}

// 拖拽：Electron 32+ 的 File 已无 .path，必须走 webUtils
function onDrop(e) {
  dragging.value = false;
  const files = [...(e.dataTransfer?.files || [])];
  const paths = files
    .map(f => { try { return window.xnowpost.getPathForFile(f); } catch (_) { return ''; } })
    .filter(p => p && /\.(png|jpe?g|webp|bmp)$/i.test(p));
  if (!paths.length) {
    store.addLog('warning', '拖进来的文件里没有可用的图片（png/jpg/webp/bmp）');
    return;
  }
  addShots(paths);
  store.addLog('info', `📎 已加入 ${paths.length} 张截图`);
}

// 粘贴：剪贴板图片没有路径，交给主进程落盘后返回路径
async function onPaste(e) {
  const items = [...(e.clipboardData?.items || [])];
  const item = items.find(it => it.kind === 'file' && String(it.type).startsWith('image/'));
  if (!item) return;
  const file = item.getAsFile();
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const ext = (String(file.type).split('/')[1] || 'png').replace('jpeg', 'jpg');
    const r = await window.xnowpost.savePastedImage(buf, ext);
    if (r && r.ok && r.path) {
      addShots([r.path]);
      store.addLog('info', '📋 已粘贴 1 张截图');
    } else {
      store.addLog('error', '粘贴截图失败: ' + (r && r.message ? r.message : '未知错误'));
    }
  } catch (err) {
    store.addLog('error', '粘贴截图失败: ' + ((err && err.message) || err));
  }
}

async function pickShots() {
  try {
    const r = await window.xnowpost.pickImages();
    if (r && r.ok && Array.isArray(r.paths) && r.paths.length) addShots(r.paths);
  } catch (e) {
    store.addLog('error', '选择截图失败: ' + ((e && e.message) || e));
  }
}
const todayItems = ref([]);
const todayLoading = ref(true);
const isMorning = new Date().getHours() < 12;
const cancelling = ref(false);
const publishing = ref(false);
const collecting = ref(false);
const quickTopic = ref('');
const batchMode = ref(false);
const batchTopics = ref('');
const batchTotal = ref(0);
const batchDone = ref(0);
const logExpanded = ref(false);
const collectData = ref(null);
const showCompletionBanner = ref(false);
const previewData = ref(null);
const pendingItems = ref([]);
const consecutiveFailures = ref(0);

// 列表默认只显示最近几条 —— 一屏塞 55 条谁都不想翻。
// 想看全部就展开，或者直接点「打开文件夹」。
const PENDING_LIMIT = 5;
const TODAY_LIMIT = 4;
const pendingExpanded = ref(false);
const todayExpanded = ref(false);

// ── 调度执行进度（控制台「调度进度」卡片）──
const sched = ref({
  schedulerRunning: false,
  active: false,
  current: null,
  next: [],
  tail: [],
  sessionDir: '',
  stage: '',
  stageText: '',
  lastRun: '',
});
const SCHED_STEPS = [
  { key: 'generating', text: '生成内容' },
  { key: 'publishing', text: '上传发布' },
  { key: 'published', text: '完成' },
];
let schedTimer = null;

function fmtElapsed(sec) {
  const s = Math.max(0, Number(sec) || 0);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m} 分 ${r} 秒` : `${m} 分`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}
function fmtIn(min) {
  const m = Math.max(0, Number(min) || 0);
  if (m < 1) return '马上';
  if (m < 60) return `${m} 分钟后`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分后`;
}
function stepIndex() {
  const i = SCHED_STEPS.findIndex((s) => s.key === sched.value.stage);
  if (i >= 0) return i;
  return sched.value.stage === 'failed' ? 1 : 0;
}
function stepReached(i) {
  return i <= stepIndex();
}
function stepCurrent(i) {
  return i === stepIndex() && sched.value.stage !== 'failed';
}
async function refreshProgress() {
  try {
    if (!window.xnowpost.getScheduleProgress) return;
    const r = await window.xnowpost.getScheduleProgress();
    if (r) sched.value = r;
  } catch (_) {
    /* 单次失败忽略 */
  }
}

// 待发布按「日期 + 场次」倒序（主进程返回的是目录顺序，不保证时间先后）
const sortedPending = computed(() => [...pendingItems.value].sort(
  (a, b) => `${b.date}-${b.session}`.localeCompare(`${a.date}-${a.session}`),
));
const shownPending = computed(() => pendingExpanded.value
  ? sortedPending.value
  : sortedPending.value.slice(0, PENDING_LIMIT));

// 「默认只发当天」：卡片上要说清楚到底几条是今天的
const todayPendingCount = computed(() => pendingItems.value.filter((p) => !p.old).length);
// 勾上才把非当天的旧会话也发出去（护栏默认 OFF）
const includeOld = ref(false);

const shownToday = computed(() => todayExpanded.value
  ? todayItems.value
  : todayItems.value.slice(0, TODAY_LIMIT));

function dismissWarning() { consecutiveFailures.value = 0; }
let refreshTimer = null;
let cleanupStatusPush = null;
import { PLATFORM_NAMES as platformNames, METRIC_LABELS as metricLabels, formatNum } from '../constants.js';

// 轮询状态跟踪
let prevRunning = false
let tickCount = 0
// metricLabels, formatNum imported from constants.js

const statusText = computed(() => {
  if (!store.status.configured) return '🔑 还需要配置 API Key 才能开始工作';
  if (store.status.running) return '⏳ 引擎运行中...';
  if (store.status.schedulerActive) return '⏰ 调度器执行中';
  return '🟢 一切就绪';
});

const currentStep = ref({ label: '准备中...', percent: 0 });
let cleanupProgress = null;

const recentLogs = computed(() => store.logs.slice(-5));
const displayLogs = computed(() => store.logs.slice(-20).reverse());

// ── 失败红条（2026-10-19 P0-3）──
// TG 通知没配、系统 toast 也可能被系统静音，界面上必须有一眼看得到的位置。
const bannerDismissed = ref(false);
const errorBanner = computed(() => {
  if (bannerDismissed.value) return '';
  if (!(store.status.recentErrors > 0)) return '';
  const last = [...store.logs].reverse().find((l) => l.type === 'error');
  return last ? String(last.message || '').slice(0, 160) : '（错误内容见运行日志）';
});
// 又出现新错误时把「已关闭」状态复位，否则关一次就再也不提示了
watch(() => store.status.recentErrors, (n, prev) => {
  if ((n || 0) > (prev || 0)) bannerDismissed.value = false;
});
function gotoLogs() {
  router.push('/logs');
}

// 非运行时自动折叠日志
watch(() => store.status.running, (running, was) => {
  // 引擎刚停下（从 true→false）且最后一条日志是错误 → 展开让用户看见
  if (was && !running) {
    const last = store.logs[store.logs.length - 1];
    if (last && last.type === 'error') {
      logExpanded.value = true;
    } else {
      logExpanded.value = false;
    }
  }
});

async function loadThumbnails(items) {
  for (const item of items) {
    if (item.dir) {
      window.xnowpost.getThumbnail(item.dir).then(url => {
        if (url) item.thumbnail = url;
      }).catch(() => {});
    }
  }
}

async function refreshToday() {
  todayLoading.value = true;
  try {
    const history = await window.xnowpost.getHistory();
    const today = history.find(h => h.date === store.status.todayDir);
    todayItems.value = today ? today.items : [];
    if (todayItems.value.length) loadThumbnails(todayItems.value);
  } catch (e) {
    // 读取失败时保留已有列表，不把界面清空；这里不用 addLog，
    // 因为 15s 轮询也会调用它，失败时会刷屏
    console.error('读取今日产出失败:', e);
  } finally {
    todayLoading.value = false;
  }
}

async function handleCancel() {
  cancelling.value = true;
  try { await store.cancelEngine(); } finally { cancelling.value = false; }
}

function quickGenerate() {
  if (store.status.running) return;
  const topic = quickTopic.value?.trim() || '';
  store.addLog('info', topic ? `📝 主题: ${topic}` : '📝 未指定主题，AI 自由发挥');
  store.addLog('info', '🚀 开始生成...');
  store.runEngine('auto', topic, genOptions());
}

async function runAuto() { await store.runEngine('auto', '', genOptions()); await refreshToday(); }
async function runVideo() { await store.runEngine('video', '', genOptions()); await refreshToday(); }
async function runPost() { await store.runEngine('post', '', genOptions()); await refreshToday(); }

const topicCount = computed(() => batchTopics.value.trim() ? batchTopics.value.trim().split('\n').filter(Boolean).length : 0)

async function runBatch() {
  const topics = batchTopics.value.trim().split('\n').filter(Boolean)
  if (topics.length === 0) return
  batchTotal.value = topics.length
  batchDone.value = 0
  batchMode.value = false

  for (let i = 0; i < topics.length; i++) {
    const topic = topics[i].trim()
    store.addLog('info', `📋 [${i+1}/${topics.length}] ${topic}`)
    // 用 runEngine 返回的显式 cancelled 标记判断是否中断；
    // 绝不能再用 store.status.running —— 它在 runEngine 的 finally 里必然为 false，
    // 会让任何 ≥2 条的批量任务都在第 1 条后 break（P1-1）
    const result = await store.runEngine('auto', topic, genOptions())
    batchDone.value = i + 1
    await refreshToday()
    if (result?.cancelled) {
      store.addLog('warning', `批量生成已取消（已完成 ${batchDone.value}/${topics.length}）`)
      break
    }
  }
  batchTotal.value = 0
  batchDone.value = 0
}

async function handleCollect() {
  collecting.value = true
  store.addLog('info', '📊 手动触发数据采集...')
  try {
    const result = await window.xnowpost.runCollect()
    if (!result.ok) {
      store.addLog('error', '采集失败: ' + (result.message || ''))
    } else {
      store.addLog('success', '✅ 采集完成，正在刷新数据...')
      // 采集完成后自动刷新采集卡片
      collectData.value = await window.xnowpost.getLatestCollect()
    }
  } catch (e) {
    store.addLog('error', '采集调用失败: ' + (e.message || e))
  }
  collecting.value = false
}

async function refreshCollectData() {
  try {
    collectData.value = await window.xnowpost.getLatestCollect()
  } catch (_) {}
}

// 目标账号：'' = 按配置第一个（老行为）；选了就必须发到那个号。
// 持久化在 localStorage，重启应用还记得上次选的是几号。
const publishTarget = ref(localStorage.getItem('xnowpost.publishTarget') || '')
watch(publishTarget, (v) => localStorage.setItem('xnowpost.publishTarget', v || ''));
const publishConfirm = ref(false)
const pendingLoaded = ref(false)
const publishMaxCount = 3;   // 和主进程 DEFAULT_MAX_PER_RUN 一致，超过也只发 3 条
const accountOptions = ref([])
const defaultAccountLabel = ref('')

// 账号列表取本地配置（config:get），不走 accounts:list —— 那个要问 FoxProfile，慢且可能超时
async function loadPublishAccounts() {
  try {
    const cfg = await window.xnowpost.getConfig()
    const list = Array.isArray(cfg?.accounts) ? cfg.accounts : []
    const t = publishTargetOptions(list)
    accountOptions.value = t.options
    defaultAccountLabel.value = t.defaultLabel
    // 记住的号已经不在配置里了就退回默认，免得上游改了配置这里还挂着个幽灵账号
    if (publishTarget.value && !accountOptions.value.some((a) => a.name === publishTarget.value)) {
      publishTarget.value = ''
    }
  } catch (_) {}
}

// 文案和真正发出去的目标同源（都是 src/renderer/lib/publish-request.js，有单测守着）
const publishTargetLabel = computed(() => targetLabelOf(accountOptions.value, publishTarget.value))

// 点「发布」只是开确认卡：账号发错撤不回来，值得多看一眼
function handlePublish() {
  if (publishing.value) return
  // 只有"确实读到了待发列表且是 0 条"才拦；列表没读到时照常开确认卡，
  // 由主进程给准话（否则界面一次接口抖动就变成"点了没反应"）
  if (pendingLoaded.value && !pendingItems.value.length) {
    store.addLog('info', '没有待发布的内容')
    return
  }
  publishConfirm.value = true
}

async function confirmPublish() {
  publishing.value = true
  try {
    // includeOld / account 都由纯函数决定（单元测试守着），别在视图里再写一份
    const opts = buildPublishOpts({ target: publishTarget.value, includeOld: includeOld.value })
    const result = await window.xnowpost.runPublish(opts)
    if (!result.ok) {
      store.addLog('error', '发布失败: ' + (result.message || ''))
    } else if (result.published > 0) {
      store.addLog('success', `已发布 ${result.published} 条 → ${publishTargetLabel.value}`)
    } else {
      store.addLog('info', `没有可发的内容（${publishTargetLabel.value}）`)
    }
    publishConfirm.value = false
    await loadPendingItems()
  } catch (e) {
    store.addLog('error', '发布调用失败: ' + (e.message || e))
  }
  publishing.value = false
}
async function openDir() { await window.xnowpost.openOutputDir(); }

async function loadPendingItems() {
  try {
    pendingItems.value = await window.xnowpost.getPendingPublish()
    pendingLoaded.value = true
  } catch (_) {}
}

async function loadLatestPreview() {
  try {
    const history = await window.xnowpost.getHistory()
    const today = history.find(h => h.date === store.status.todayDir)
    if (today?.items?.length) {
      const latest = today.items[0]
      if (latest.dir) {
        const session = await window.xnowpost.readSession(latest.dir)
        if (session) previewData.value = session
      }
    }
  } catch (_) {}
}

async function refreshStatus() {
  const status = await window.xnowpost.getEngineStatus();
  Object.assign(store.status, status);
}

onMounted(async () => {
  // ⚠️ 初始化必须整体隔离异常：一旦这里抛出，后面的定时器与订阅就全都不会注册，
  // Dashboard 的实时更新会被永久禁用（P2-3）
  try {
    await refreshToday();
    store.loadCost();
    await refreshCollectData();
    loadPendingItems();
    await loadPublishAccounts();   // 「发到哪个号」的下拉，取本地配置，不走 FoxProfile
  } catch (e) {
    store.addLog('error', '控制台初始化失败: ' + ((e && e.message) || e));
  }

  // 调度进度：5 秒一刷（当前任务 / 阶段 / 日志尾）
  refreshProgress();
  schedTimer = setInterval(() => {
    if (document.hidden) return;
    refreshProgress();
  }, 5000);

  prevRunning = store.status.running;
  // 轮询：单次异常只跳过本轮，不能打断后续轮询
  refreshTimer = setInterval(async () => {
    if (document.hidden) return;
    try {
      tickCount++;

      // light status check each tick
      const status = await window.xnowpost.getEngineStatus().catch(() => null);
      if (!status) return;
      const wasRunning = prevRunning;
      prevRunning = status.running;
      Object.assign(store.status, status);
      // load consecutive failure count
      window.xnowpost.getFailureCount().then(c => { consecutiveFailures.value = c }).catch(() => {})

      // engine just finished -> refresh output + cost + show banner
      if (wasRunning && !status.running) {
        refreshToday();
        store.loadCost();
        showCompletionBanner.value = true;
        loadPendingItems();
        loadLatestPreview();
      }

      // refresh output/collect every 60s (4th tick)
      if (tickCount % 4 === 0) {
        if (!status.running) refreshToday();
        refreshCollectData();
      }
    } catch (_) {
      // 单次轮询失败忽略
    }
  }, 15000);

  // 监听引擎结构化进度
  try {
    cleanupProgress = window.xnowpost.onProgress((p) => {
      if (!p) return;
      currentStep.value = { label: p.label, percent: p.percent };
    });
  } catch (e) {
    store.addLog('warning', '进度订阅注册失败: ' + ((e && e.message) || e));
  }

  // 监听调度器状态即时推送（不依赖 15s 轮询）
  try {
    cleanupStatusPush = window.xnowpost.onEngineStatusPush((status) => {
      if (!status) return;
      const wasRunning = prevRunning;
      prevRunning = status.running;
      Object.assign(store.status, status);
      if (wasRunning && !status.running) {
        refreshToday();
        store.loadCost();
        loadPendingItems();
      }
    });
  } catch (e) {
    store.addLog('warning', '调度器状态订阅注册失败: ' + ((e && e.message) || e));
  }
});

onUnmounted(() => {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (schedTimer) { clearInterval(schedTimer); schedTimer = null; }
  if (cleanupProgress) { cleanupProgress(); cleanupProgress = null; }
  if (cleanupStatusPush) { cleanupStatusPush(); cleanupStatusPush = null; }
  window.removeEventListener('paste', onPaste);
});

// Ctrl+V 粘贴截图：只在有图片内容时生效，普通文字粘贴不受影响
window.addEventListener('paste', onPaste);
</script>

<style scoped>
/* ── 页面骨架 ── */
.dashboard-page { display: flex; flex-direction: column; gap: 14px; }

/* ── 失败红条（P0-3）── */
.alert-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--r-sm);
  font-size: 12.5px;
}
.alert-bar.danger {
  background: var(--danger-soft);
  border: 1px solid rgba(255, 77, 109, 0.3);
  color: var(--text-1);
}
.alert-bar .ab-ic { display: flex; flex: 0 0 16px; }
.alert-bar .ab-ic svg { width: 16px; height: 16px; stroke: var(--danger); fill: none; }
.alert-bar .ab-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.alert-bar .ab-title { font-weight: 600; color: var(--danger); }
.alert-bar .ab-text {
  color: var(--text-2);
  font-family: var(--font-mono);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 720px;
}

/* 顶栏里当按钮用的 router-link */
a.x-btn { text-decoration: none; }

/* ── 状态条 ── */
.status-strip { align-items: center; }
.status-strip .x-dot { flex: 0 0 7px; }
.status-strip .x-dot.warn { animation: pulse 1.5s infinite; }
.status-text { flex: 1; min-width: 0; }
.status-badges { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.status-badges .x-tag.mute { font-family: var(--font-mono); }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

/* ── KPI 小卡（系统状态） ── */
.kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.kpi {
  background: var(--bg2);
  border: 1px solid var(--stroke);
  border-radius: var(--r-md);
  padding: 13px 15px;
  min-width: 0;
}
.kpi .k { display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--text-3); }
.kpi .v {
  display: flex; align-items: center; gap: 8px;
  margin-top: 6px; font-size: 20px; font-weight: 680; letter-spacing: 0.3px;
  color: var(--text); min-width: 0;
}
.kpi .v small {
  font-size: 11px; font-weight: 500; color: var(--text-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.kpi .v .x-tag { flex: 0 0 auto; }
.kpi.on .v { color: var(--ok); }
.kpi .v.err { color: var(--danger); }
.x-card-head .x-tag { flex: 0 0 auto; }

/* ── 字段行：操作列放宽（生成 / 批量、上传截图） ── */
.x-field.gen-row { grid-template-columns: 150px minmax(0, 1fr) 186px; }
.x-actions.act-col { flex-direction: column; align-items: stretch; }
.stack { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.res-line { font-size: 11.5px; line-height: 1.5; color: var(--text-3); }
.res-line.ok { color: var(--ok); }
.res-line .link { margin-left: 6px; color: var(--text-2); text-decoration: underline; cursor: pointer; }
.res-line .link:hover { color: var(--brand); }

/* ── 分段选择（配音语言） ── */
.seg {
  display: inline-flex;
  border: 1px solid var(--stroke-2);
  border-radius: var(--r-sm);
  overflow: hidden;
}
.seg-btn {
  height: 32px;
  padding: 0 14px;
  font-size: 12.5px;
  font-family: var(--font-ui);
  color: var(--text-2);
  background: transparent;
  border: 0;
  border-right: 1px solid var(--stroke);
  cursor: pointer;
  transition: background 0.16s, color 0.16s;
}
.seg-btn:last-child { border-right: 0; }
.seg-btn:hover { background: var(--bg3); color: var(--text); }
.seg-btn.active { background: var(--brand-soft); color: var(--brand); font-weight: 600; }

/* 批量开关的开启态 */
.x-btn.on { border-color: var(--brand); background: var(--brand-soft); color: var(--brand); }

/* 卡片底部提示条 + 主操作行 */
.drop-tip { margin-top: 10px; }
.drop-tip b { color: var(--text); font-weight: 600; }
.gen-actions {
  display: flex; flex-wrap: wrap; gap: 8px;
  margin-top: 12px; padding-top: 12px;
  border-top: 1px dashed var(--stroke);
}
/* 拖拽悬停：整张卡片高亮，给用户明确反馈 */
.gen-card.dragging { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); }
/* ── 进度（在生成卡片内） ── */
.x-btn.danger { border-color: var(--danger); background: var(--danger-soft); color: var(--danger); }
.spin {
  width: 13px; height: 13px; flex: 0 0 13px; border-radius: 50%;
  border: 2px solid var(--stroke-2); border-top-color: var(--brand);
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.progress-box {
  margin: 8px 0 4px; padding: 12px;
  background: var(--bg1); border: 1px solid var(--stroke); border-radius: var(--r-sm);
}
.progress-top { display: flex; align-items: center; gap: 9px; margin-bottom: 10px; }
.progress-title { flex: 1; font-size: 13px; font-weight: 600; color: var(--text); }
.progress-step-label { font-size: 12.5px; color: var(--text-2); margin-bottom: 8px; }
.progress-bar { height: 6px; border-radius: 3px; background: var(--bg3); overflow: hidden; margin-bottom: 10px; }
.progress-fill { height: 100%; min-width: 2%; border-radius: 3px; background: var(--brand); transition: width 0.5s ease; }
.progress-log {
  max-height: 132px; overflow-y: auto; padding: 8px 10px;
  background: var(--bg0); border: 1px solid var(--stroke); border-radius: var(--r-sm);
}
.progress-line { display: flex; gap: 10px; font-family: var(--font-mono); font-size: 11px; line-height: 1.65; }
.progress-line-time { flex: 0 0 62px; color: var(--text-3); }
.progress-line-msg { color: var(--text-2); word-break: break-word; }
.progress-line.success .progress-line-msg { color: var(--ok); }
.progress-line.error .progress-line-msg { color: var(--danger); }
.progress-line.warning .progress-line-msg { color: var(--warn); }

/* ── 完成横幅 ── */
.done-inner { display: flex; align-items: center; gap: 10px; padding: 12px 16px; }
.done-ic { display: flex; align-items: center; }
.done-ic svg { width: 17px; height: 17px; stroke: var(--ok); fill: none; stroke-width: 1.9; }
.done-text { flex: 1; font-size: 13px; font-weight: 600; color: var(--ok); }

/* ── 内容预览 ── */
.preview-text {
  margin: 10px 0 8px; font-size: 12.5px; line-height: 1.6;
  color: var(--text-2); max-height: 132px; overflow-y: auto;
}
.preview-imgs { display: flex; flex-wrap: wrap; gap: 8px; padding-bottom: 4px; }
.preview-img {
  width: 78px; height: 78px; object-fit: cover;
  border-radius: var(--r-sm); border: 1px solid var(--stroke);
}

/* ── 卡片底部工具行 / 提示条里的按钮 ── */
.card-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 16px 12px; border-top: 1px solid var(--stroke); }
.x-tip .x-mini { margin-left: auto; }
.x-tip b { color: var(--text); font-weight: 600; }

/* ── 最近费用 ── */
.cost-body { display: flex; flex-wrap: wrap; gap: 26px; padding: 12px 16px 14px; }
.cost-item { display: flex; flex-direction: column; gap: 3px; }
.cost-metric { font-size: 11px; color: var(--text-3); }
.cost-value { font-size: 15px; font-weight: 680; color: var(--text); font-family: var(--font-mono); }
.cost-total .cost-value { font-size: 17px; color: var(--brand); }

/* ── 采集数据概览 ── */
.plat-grid { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 0 4px; }
.plat-card {
  flex: 1 1 160px; min-width: 150px;
  background: var(--bg1); border: 1px solid var(--stroke);
  border-radius: var(--r-sm); padding: 10px 12px;
}
.plat-name { font-size: 12px; font-weight: 650; color: var(--text); margin-bottom: 6px; }
.plat-stats { display: flex; flex-wrap: wrap; gap: 4px 14px; }
.stat-item { display: flex; gap: 5px; font-size: 11px; }
.stat-label { color: var(--text-3); }
.stat-value { color: var(--text-2); font-weight: 600; font-family: var(--font-mono); }

/* ── 今日产出 ── */
.today-list { display: flex; flex-direction: column; gap: 8px; padding: 10px 0 4px; }
.item-card {
  display: flex; align-items: center; gap: 12px; padding: 10px;
  background: var(--bg1); border: 1px solid var(--stroke);
  border-radius: var(--r-sm); transition: background 0.16s, border-color 0.16s;
}
.item-card:hover { background: var(--bg3); border-color: var(--stroke-2); }
.item-thumb {
  width: 56px; height: 56px; flex: 0 0 56px; border-radius: var(--r-sm);
  overflow: hidden; background: var(--bg0);
  display: flex; align-items: center; justify-content: center;
}
.thumb-img { width: 100%; height: 100%; object-fit: cover; }
.thumb-ph { display: flex; align-items: center; justify-content: center; }
.thumb-ph svg { width: 20px; height: 20px; stroke: var(--text-3); fill: none; stroke-width: 1.7; }
.item-body { flex: 1; min-width: 0; }
.item-title { font-size: 13px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item-meta {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
  margin-top: 4px; font-size: 11.5px; color: var(--text-3);
}
.item-status.ok { color: var(--ok); }
.item-status.warn { color: var(--warn); }

/* 骨架屏：覆盖全局 style.css 的旧配色 */
.skeleton-card { background: var(--bg1); border: 1px solid var(--stroke); border-radius: var(--r-sm); }
.skeleton-thumb, .skeleton-line { background: var(--bg3); }
.x-empty svg { width: 26px; height: 26px; stroke: var(--text-3); fill: none; stroke-width: 1.6; }

/* ── 表格（待发布列表） ── */
table { width: 100%; border-collapse: collapse; font-size: 13px; }
thead th {
  text-align: left; font-size: 11.5px; font-weight: 600; color: var(--text-3);
  padding: 9px 16px; background: var(--bg1); border-bottom: 1px solid var(--stroke);
}
tbody td { padding: 9px 16px; border-bottom: 1px solid var(--stroke); vertical-align: middle; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: var(--bg3); }
.pc-title {
  display: block; max-width: 100%;
  font-size: 12.5px; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
td.num { text-align: right; font-family: var(--font-mono); font-size: 11.5px; color: var(--text-3); }
.pc-hint { padding: 8px 16px 0; font-size: 11px; color: var(--text-3); }

/* 类型列：视频/图文 + 旧 + 待重试 一行排开（挤成三行会把每行撑得很高） */
.pc-type { display: flex; align-items: center; gap: 5px; flex-wrap: nowrap; }

/* 「含旧会话」勾选框（默认关：护栏要求旧会话必须显式放行） */
.pc-old {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
  user-select: none;
}
.pc-old input { accent-color: var(--brand); cursor: pointer; }
/* 这一行现在有 4 个元素（含旧会话 / 发到 / 提示 / 按钮），窄了要能换行，控件不许被压扁 */
.card-foot { flex-wrap: wrap; row-gap: 8px; }
.pub-hint { flex: none; white-space: nowrap; }

/* 目标账号下拉：和「含旧会话」同一行，字号压低一点免得抢走按钮的视觉重心 */
.pub-target {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
}
.pub-target .x-select {
  height: 26px;
  min-width: 132px;
  font-size: 12px;
  padding: 0 8px;
}

/* 发布确认卡：账号发错撤不回来，所以在动手前把「发到谁、几条」摆出来 */
.pub-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(8, 10, 16, 0.55);
  backdrop-filter: blur(2px);
}
.pub-dialog {
  width: 380px;
  max-width: calc(100vw - 40px);
  background: var(--bg0);
  border: 1px solid var(--stroke);
  border-radius: var(--r);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}
.pub-dialog-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  font-size: 13px;
  font-weight: 650;
  color: var(--text);
  border-bottom: 1px solid var(--stroke);
}
.pub-dialog-body { padding: 12px 16px; display: flex; flex-direction: column; gap: 9px; }
.pub-row { display: flex; gap: 10px; font-size: 12px; }
.pub-k { width: 34px; flex: none; color: var(--text-3); }
.pub-v { color: var(--text-2); }
.pub-v b { color: var(--text); font-weight: 650; }
.pub-warn { color: var(--warn); font-style: normal; margin-left: 4px; }
.pub-tip { margin-top: 2px; }
.pub-dialog-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 16px 12px;
  border-top: 1px solid var(--stroke);
  background: var(--bg1);
}

/* ── 日志区域（可折叠） ── */
.log-head { cursor: pointer; }
.log-container {
  border-top: 1px solid var(--stroke);
  padding: 10px 16px 12px;
  max-height: 420px;
  overflow-y: auto;
}
.log-container.collapsed { display: none; }
.log-line { display: flex; gap: 12px; font-family: var(--font-mono); font-size: 11.5px; line-height: 1.7; }
.log-time { flex: 0 0 142px; color: var(--text-3); }
.log-msg { color: var(--text-2); word-break: break-word; }
.log-line.success .log-msg { color: var(--ok); }
.log-line.error .log-msg { color: var(--danger); }
.log-line.warning .log-msg { color: var(--warn); }
/* ── 调度进度卡片 ── */
.sched-progress .x-card-body { padding-top: 12px; }
.sp-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
}
.sp-stage {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--text);
}
.sp-stage b { font-weight: 640; }
.sp-stage.failed b { color: var(--danger); }
.sp-dir {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  background: var(--bg3);
  border-radius: 5px;
  padding: 1px 6px;
}
.sp-time { font-size: 11.5px; color: var(--text-3); }
.sp-time.mono { font-family: var(--font-mono); color: var(--text-2); }
.sp-bar {
  position: relative;
  height: 4px;
  border-radius: 3px;
  background: var(--bg3);
  overflow: hidden;
  margin: 10px 0 9px;
}
.sp-bar i {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  width: 38%;
  border-radius: 3px;
  background: linear-gradient(90deg, transparent, var(--brand), transparent);
  animation: sp-slide 1.5s ease-in-out infinite;
}
@keyframes sp-slide {
  0% { left: -40%; }
  100% { left: 100%; }
}
.sp-steps {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.sp-step {
  font-size: 11px;
  color: var(--text-3);
  border: 1px solid var(--stroke);
  background: var(--bg1);
  border-radius: 20px;
  padding: 2px 9px;
}
.sp-step.on {
  color: var(--text-2);
  border-color: var(--stroke-2);
}
.sp-step.cur {
  color: var(--brand);
  border-color: rgba(255, 46, 91, 0.5);
  background: var(--brand-soft);
  font-weight: 640;
}
.sp-next { display: flex; flex-direction: column; gap: 6px; }
.sp-next-item {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 12.5px;
  color: var(--text-2);
  padding: 6px 9px;
  border-radius: var(--r-sm);
  background: var(--bg1);
  border: 1px solid var(--stroke);
}
.sp-t {
  font-family: var(--font-mono);
  font-weight: 700;
  color: var(--text);
  font-size: 13px;
}
.sp-n { color: var(--text-2); }
.sp-in { font-size: 11.5px; color: var(--text-3); }
.sp-last { margin-top: 8px; font-size: 11.5px; color: var(--text-3); }
.sp-log {
  margin-top: 11px;
  padding: 9px 11px;
  border-radius: var(--r-sm);
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid var(--stroke);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.65;
  color: var(--text-3);
  overflow: hidden;
}
.sp-line {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sp-line:last-child { color: var(--text-2); }
</style>