<template>
  <div class="dashboard-page">
    <!-- ===== 顶栏 ===== -->
    <div class="x-head">
      <h1>控制台</h1>
      <span class="x-sub">
        {{ store.status.running ? '引擎运行中' : store.status.schedulerActive ? '调度器执行中' : '引擎空闲' }} · {{ store.status.configured ? '已配置' : '未配置' }}
      </span>
      <span class="x-spacer"></span>
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

    <!-- ===== 任务表（用户 2026-10-23：「首页能不能加个任务表，这样看得比较清楚」） ===== -->
    <div v-if="plan.upcoming.length || plan.done.length" class="x-card plan-card">
      <div class="x-card-head">
        <span class="x-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3.5 2" />
          </svg>
        </span>
        <h2>任务表</h2>
        <span class="x-hint">{{ planSummary }}</span>
        <div class="x-spacer"></div>
        <button v-if="planUpcomingRows.length > 5" class="x-mini" @click="showAllPlan = !showAllPlan">
          {{ showAllPlan ? '只看接下来 5 条' : '接下来全部 ' + planUpcomingRows.length + ' 条' }}
        </button>
        <button v-if="plan.done.length" class="x-mini" @click="showDonePlan = !showDonePlan">
          {{ showDonePlan ? '收起今天已跑完' : '今天已跑完 ' + plan.done.length + ' 条' }}
        </button>
        <router-link to="/schedule" class="x-mini">去调整</router-link>
      </div>

      <table class="plan">
        <thead>
          <tr>
            <th class="c-time">时间</th>
            <th class="c-task">任务</th>
            <th class="c-acc">账号</th>
            <th class="c-state">状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in planUpcomingShown" :key="'u' + r.id + '-' + r.time" :class="['st-' + r.status, { next: r === planUpcomingShown[0] && r.day === '今天' }]">
            <td class="c-time">
              <span v-if="r.day === '明天'" class="day">明天</span><b>{{ r.time }}</b>
            </td>
            <td class="c-task">
              {{ r.label }}<span v-if="r.durationText" class="dim"> · {{ r.durationText }}</span>
            </td>
            <td class="c-acc" :title="r.accounts.join(',')">{{ r.accountsText }}</td>
            <td class="c-state"><span class="x-tag" :class="planTagClass(r)">{{ planTagText(r) }}</span></td>
          </tr>

          <template v-if="showDonePlan">
            <tr class="sep">
              <td colspan="4">今天已经跑完的 {{ plan.done.length }} 条</td>
            </tr>
            <tr v-for="r in plan.done" :key="'d' + r.id + '-' + r.time" :class="['st-' + r.status, 'done-row']">
              <td class="c-time"><b>{{ r.time }}</b></td>
              <td class="c-task">
                {{ r.label }}<span v-if="r.durationText" class="dim"> · {{ r.durationText }}</span>
              </td>
              <td class="c-acc" :title="r.accounts.join(',')">{{ r.accountsText }}</td>
              <td class="c-state">
                <span class="x-tag" :class="planTagClass(r)">{{ planTagText(r) }}</span>
                <span v-if="r.finishedAt" class="fin">{{ r.finishedAt }} 结束</span>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
      <div v-if="planHiddenUp > 0" class="plan-more">
        接下来还有 {{ planHiddenUp }} 条没显示（点右上「接下来全部」）
      </div>
      <div v-else-if="!plan.done.length" class="plan-more">今天还没有跑过的记录。</div>
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
            <th style="width: 34px">
              <input
                type="checkbox"
                class="pc-check"
                :checked="allShownSelected"
                :indeterminate.prop="someShownSelected && !allShownSelected"
                title="全选当前显示的条目"
                @change="toggleSelectAll($event.target.checked)"
              />
            </th>
            <th style="width: 152px">类型</th>
            <th>标题</th>
            <th style="width: 168px; text-align: right">生成时间</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(item, i) in shownPending"
            :key="`${item.date}/${item.session}`"
            :class="{ 'pc-picked': isPicked(item) }"
            @click="togglePick(item)"
          >
            <td class="pc-pickcell" @click.stop>
              <input type="checkbox" class="pc-check" :checked="isPicked(item)" @change="togglePick(item)" />
            </td>
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
        <!-- 条数：以前写死「最多 3 条」，用户问「不能选择性发布吗」。现在既能选条数，
             也能勾具体的某几条（勾了就按勾选的发，条数下拉自动失效）。 -->
        <label class="pub-target" title="不勾选时按顺序发前 N 条（新→旧，不随机）">
          <span>条数</span>
          <select v-model="publishCount" class="x-select pc-count" :disabled="pickedCount > 0">
            <option :value="1">1 条</option>
            <option :value="2">2 条</option>
            <option :value="3">3 条</option>
            <option value="all">全部</option>
          </select>
        </label>
        <div class="x-spacer"></div>
        <button v-if="pickedCount" class="x-mini pc-clear" @click="clearPicks" title="取消全部勾选">清空勾选</button>
        <span class="x-hint pub-hint" :title="publishPlan.detail">
          {{ pickedCount ? `已勾选 ${pickedCount} 条` : '按生成时间新→旧，不随机' }}
        </span>
        <button class="x-btn primary" @click="handlePublish" :disabled="publishing">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 4 11.6 20.4l-2.1-6.9L2.6 11.4z" />
            <path d="m9.5 13.5 4.2-4.2" />
          </svg>
          <span>{{ publishing ? '发布中…' : publishBtnLabel }}</span>
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
            <span class="pub-v">{{ publishPlan.detail }}{{ includeOld ? '，含历史日期会话' : '' }}</span>
          </div>
          <div v-if="pickedCount" class="pub-row">
            <span class="pub-k">内容</span>
            <span class="pub-v pub-list">
              <span v-for="p in pickedItems" :key="`${p.date}/${p.session}`" class="pub-item">
                {{ p.date }} {{ p.time }} · {{ p.title || p.session }}
              </span>
            </span>
          </div>
          <div class="pub-row">
            <span class="pub-k">待发</span>
            <span class="pub-v">{{ pendingItems.length }} 条可发</span>
          </div>
          <div class="x-tip pub-tip">
            发出去就撤不回来了。要发到别的号 / 换几条，关掉这张卡再改。
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
        <!-- 主题只在这里填一次，下面「立即生成 / 仅视频 / 仅图文」三个按钮都会带上它。
             以前这里另有一个「生成」按钮，只它认主题、另外三个按钮把主题丢掉（P0 级隐性 bug）。 -->
        <template v-if="store.status.configured && !store.status.running && !store.status.schedulerActive">
          <div class="x-field gen-row">
            <span class="x-label"><b>主题</b></span>
            <input
              v-model="quickTopic"
              placeholder="输入主题（留空让 AI 自由发挥）…"
              class="x-input"
              @keyup.enter="runAuto"
              :disabled="batchMode"
            />
            <div class="x-actions">
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
          <!-- 「采集」不在这张卡里：它属于数据，不属于生成。入口统一在「定时 → 采集面板」。 -->
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
          <span>{{ publishing ? '发布中…' : publishBtnLabel }}</span>
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

  </div>
</template>

<script setup>
import { useAppStore } from '../stores/app.js';
import { useRouter } from 'vue-router';
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue';
import { buildPublishOpts, buildPickKeys, describePublishPlan, publishTargetLabel as targetLabelOf, publishTargetOptions } from '../lib/publish-request.js';

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
const isMorning = new Date().getHours() < 12;
const cancelling = ref(false);
const publishing = ref(false);
const quickTopic = ref('');
const batchMode = ref(false);
const batchTopics = ref('');
const batchTotal = ref(0);
const batchDone = ref(0);
const showCompletionBanner = ref(false);
const previewData = ref(null);
const pendingItems = ref([]);

// 列表默认只显示最近几条 —— 一屏塞 55 条谁都不想翻。
// 想看全部就展开，或者直接点「打开文件夹」。
const PENDING_LIMIT = 5;
const pendingExpanded = ref(false);

// ── 待发布列表 ──
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

let refreshTimer = null;
let cleanupStatusPush = null;

// 轮询状态跟踪
let prevRunning = false
let tickCount = 0

const statusText = computed(() => {
  if (!store.status.configured) return '🔑 还需要配置 API Key 才能开始工作';
  if (store.status.running) return '⏳ 引擎运行中...';
  if (store.status.schedulerActive) return '⏰ 调度器执行中';
  return '🟢 一切就绪';
});

// 生成进度（内容生成卡片里的进度条 / 阶段文字）
const currentStep = ref({ label: '准备中...', percent: 0 });
// 进度里显示的最近几行引擎日志
const recentLogs = computed(() => store.logs.slice(-5));
let cleanupProgress = null;

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

async function handleCancel() {
  cancelling.value = true;
  try { await store.cancelEngine(); } finally { cancelling.value = false; }
}

/*
 * 生成统一走这里：三个按钮只有「模式」不同，主题都取「主题」输入框。
 * 2026-10-19 修：以前 runAuto/runVideo/runPost 传的是空串，用户填了主题点「立即生成」
 * 主题被静默丢掉（只有已删掉的那个「生成」按钮认主题），AI 直接自由发挥，界面上毫无提示。
 */
async function generate(mode) {
  if (store.status.running) return;
  const topic = quickTopic.value?.trim() || '';
  store.addLog('info', topic ? `📝 主题: ${topic}` : '📝 未指定主题，AI 自由发挥');
  await store.runEngine(mode, topic, genOptions());
  // 生成完只需要刷新待发布列表（今日产出/最新预览已随卡片移到历史页）
  loadPendingItems();
}

const runAuto = () => generate('auto');
const runVideo = () => generate('video');
const runPost = () => generate('post');

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
    loadPendingItems()
    if (result?.cancelled) {
      store.addLog('warning', `批量生成已取消（已完成 ${batchDone.value}/${topics.length}）`)
      break
    }
  }
  batchTotal.value = 0
  batchDone.value = 0
}

// 目标账号：'' = 按配置第一个（老行为）；选了就必须发到那个号。
// 持久化在 localStorage，重启应用还记得上次选的是几号。
const publishTarget = ref(localStorage.getItem('xnowpost.publishTarget') || '')
watch(publishTarget, (v) => localStorage.setItem('xnowpost.publishTarget', v || ''));
const publishConfirm = ref(false)
// 条数：1 / 2 / 3 / 'all'（不勾选时按顺序发前 N 条）
const publishCount = ref(1)
// 勾选的条目（key = date/session）。勾了就按勾选发，条数下拉失效。
const pickedKeys = ref([])
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

// ── 勾选与条数（2026-10-19 用户问「不能选择性发布吗，非要发 3 条或者随机？」）──
const pickedItems = computed(() => pendingItems.value.filter((it) => isPicked(it)))
const pickedCount = computed(() => pickedItems.value.length)
const shownPendingKeys = computed(() => shownPending.value.map((it) => `${it.date}/${it.session}`))
const allShownSelected = computed(() => shownPendingKeys.value.length > 0
  && shownPendingKeys.value.every((k) => pickedKeys.value.includes(k)))
const someShownSelected = computed(() => shownPendingKeys.value.some((k) => pickedKeys.value.includes(k)))

// 这一轮到底发几条、发哪些 —— 确认卡和真正执行都读它。
// eligible = 实际候选数（勾了「含旧会话」时比当天多），按钮上显示的条数就是 plan.send。
const publishEligible = computed(() => (includeOld.value
  ? pendingItems.value.length
  : pendingItems.value.filter((it) => !it.old).length))
const publishPlan = computed(() => describePublishPlan({
  pick: pickedItems.value,
  count: publishCount.value,
  total: pendingItems.value.filter((it) => !it.old).length,
  eligible: publishEligible.value,
}))

function pickKeyOf(item) { return `${item.date}/${item.session}`; }
function isPicked(item) { return pickedKeys.value.includes(pickKeyOf(item)); }
function togglePick(item) {
  const k = pickKeyOf(item);
  pickedKeys.value = pickedKeys.value.includes(k)
    ? pickedKeys.value.filter((x) => x !== k)
    : [...pickedKeys.value, k];
}
function toggleSelectAll(on) {
  pickedKeys.value = on ? [...new Set([...pickedKeys.value, ...shownPendingKeys.value])] : [];
}
function clearPicks() { pickedKeys.value = []; }
// 文案和真正发出去的目标同源（都是 src/renderer/lib/publish-request.js，有单测守着）
const publishTargetLabel = computed(() => targetLabelOf(accountOptions.value, publishTarget.value))

/*
 * 主按钮和「生成完成」横幅共用同一份文案：发几条 + 发到哪个号。
 * 为什么必须带条数：以前生成行里那个按钮只写「发布 → 02 号」，看不出这次发几条、发哪条，
 * 而它发的其实是待发布列表里按上次选择的内容 —— 这是最容易"账号对了内容错了"的一格。
 */
const publishBtnLabel = computed(() => {
  const short = publishTarget.value ? `${publishTarget.value} 号` : '默认账号'
  const n = pickedCount.value || publishPlan.value.send
  return `${pickedCount.value ? '发布勾选的' : '发布'} ${n} 条 → ${short}`
})

// 点「发布」只是开确认卡：账号发错撤不回来，值得多看一眼
function handlePublish() {
  if (publishing.value) return
  // 只有"确实读到了待发列表且是 0 条"才拦；列表没读到时照常开确认卡，
  // 由主进程给准话（否则界面一次接口抖动就变成"点了没反应"）
  if (pendingLoaded.value && !pendingItems.value.length) {
    store.addLog('info', '没有待发布的内容')
    return
  }
  // 有内容但一条都发不出去（今天 0 条 + 没勾「含旧会话」+ 没点名）时别开确认卡，
  // 直接说清怎么才能发 —— 否则确认卡里写「待发 0 条」，用户只会觉得按钮坏了。
  // 只在"列表已读到且有内容"时才拦（列表没读到时交给主进程给准话）。
  if (pendingLoaded.value && pendingItems.value.length && publishPlan.value.send === 0) {
    store.addLog('info', '今天还没有可发的内容：勾上「含旧会话」，或直接在列表里点要发的那一条')
    return
  }
  publishConfirm.value = true
}

async function confirmPublish() {
  publishing.value = true
  try {
    // includeOld / account 都由纯函数决定（单元测试守着），别在视图里再写一份
    const opts = buildPublishOpts({ target: publishTarget.value, includeOld: includeOld.value })
    // 勾了就只发勾选的；没勾就按「条数」发前 N 条（'all' = 当天全部）
    const pick = buildPickKeys(pickedItems.value)
    if (pick.length) opts.pick = pick
    else if (publishCount.value === 'all') opts.all = true
    else opts.maxCount = Number(publishCount.value) || 1
    const result = await window.xnowpost.runPublish(opts)
    if (!result.ok) {
      store.addLog('error', '发布失败: ' + (result.message || ''))
    } else if (result.published > 0) {
      store.addLog('success', `已发布 ${result.published} 条 → ${publishTargetLabel.value}${pickedCount.value ? `（勾选的 ${pickedCount.value} 条）` : ''}`)
    } else {
      store.addLog('info', `没有可发的内容（${publishTargetLabel.value}）`)
    }
    publishConfirm.value = false
    pickedKeys.value = []   // 发过的条目已不在待发里，勾选一并清掉
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

/* ───────── 首页任务表（IPC schedule:plan：upcoming + done） ───────── */
const plan = ref({ today: '', now: '', upcoming: [], done: [] });
const showDonePlan = ref(false);
const showAllPlan = ref(false);
let planTimer = null;
const planUpcomingRows = computed(() => plan.value.upcoming || []);
// 明天一整天排着 10 条发布 + 采集 + 养号，全铺开会把首页顶下去，默认只给 5 条
const planUpcomingShown = computed(() =>
  showAllPlan.value ? planUpcomingRows.value : planUpcomingRows.value.slice(0, 5),
);
const planHiddenUp = computed(() => Math.max(0, planUpcomingRows.value.length - planUpcomingShown.value.length));

function fmtIn(mins) {
  const m = Math.max(0, Math.round(mins));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h ? h + ' 小时 ' + mm + ' 分' : mm + ' 分钟';
}
function fmtTook(sec) {
  const n = Math.max(0, Math.round(sec));
  if (!n) return '';
  if (n < 60) return n + ' 秒';
  const m = Math.floor(n / 60);
  const r = n % 60;
  return r ? m + ' 分 ' + r + ' 秒' : m + ' 分钟';
}
function planTagText(r) {
  switch (r.status) {
    case 'running': return '执行中';
    case 'ok': return r.tookSec ? '已完成 · ' + fmtTook(r.tookSec) : '已完成';
    case 'partial': return '部分完成';
    case 'failed': return '失败';
    case 'insufficient': return '数据不足';
    case 'unconfirmed': return '未确认';
    case 'timeout': return '超时';
    case 'skipped': return '已跳过';
    default:
      if (r.day === '明天') return '明天 ' + fmtIn(r.minsFromNow);
      return '还有 ' + fmtIn(r.minsFromNow);
  }
}
function planTagClass(r) {
  switch (r.status) {
    case 'running': return 'brand';
    case 'ok': return 'ok';
    case 'partial': return 'warn';
    case 'failed':
    case 'timeout':
    case 'unconfirmed': return 'danger';
    case 'insufficient':
    case 'skipped': return 'mute';
    default: return 'brand';
  }
}
const planSummary = computed(() => {
  const up = plan.value.upcoming || [];
  const done = plan.value.done || [];
  const running = up.find((r) => r.status === 'running');
  if (running) return '现在在执行 ' + running.time + ' 那条';
  if (up.length) {
    const nx = up[0];
    const when = nx.day === '明天' ? '明天 ' : '今天 ';
    return '接下来 ' + up.length + ' 条 · 下一条 ' + when + nx.time + '（还有 ' + fmtIn(nx.minsFromNow) + '）';
  }
  if (done.length) return '今天 ' + done.length + ' 条都跑完了，没有待执行的';
  return '定时页还没有启用的闹钟';
});

async function refreshPlan() {
  const api = window.xnowpost;
  if (!api || typeof api.getSchedulePlan !== 'function') return;
  try {
    const r = await api.getSchedulePlan();
    if (r && Array.isArray(r.upcoming)) plan.value = r;
  } catch (_) {
    /* 读不到就保持上一张表，不打扰用户 */
  }
}

onMounted(async () => {
  refreshPlan();
  planTimer = setInterval(refreshPlan, 30000);
  // ⚠️ 初始化必须整体隔离异常：一旦这里抛出，后面的定时器与订阅就全都不会注册，
  // Dashboard 的实时更新会被永久禁用（P2-3）
  try {
    loadPendingItems();
    await loadPublishAccounts();   // 「发到哪个号」的下拉，取本地配置，不走 FoxProfile
  } catch (e) {
    store.addLog('error', '控制台初始化失败: ' + ((e && e.message) || e));
  }

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

      // 引擎刚跑完 → 弹完成横幅 + 刷新待发布（新生成的内容就在里面）
      if (wasRunning && !status.running) {
        showCompletionBanner.value = true;
        loadPendingItems();
        loadLatestPreview();
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
        loadPendingItems();
        loadLatestPreview();
      }
    });
  } catch (e) {
    store.addLog('warning', '调度器状态订阅注册失败: ' + ((e && e.message) || e));
  }
});

onUnmounted(() => {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (planTimer) { clearInterval(planTimer); planTimer = null; }
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
.pc-check { accent-color: var(--brand); cursor: pointer; margin: 0; }
.pc-pickcell { width: 34px; }
tbody tr { cursor: pointer; }
tbody tr.pc-picked { background: color-mix(in srgb, var(--brand) 9%, transparent); }
.pc-count { min-width: 76px; }
.pc-clear { flex: none; }
/* 勾选多条时「内容」要一条一行，挤成一段读不出来 */
.pub-list { display: flex; flex-direction: column; gap: 2px; }
.pub-item { display: block; line-height: 1.45; }

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
/* ── 首页任务表（2026-10-23 用户要求：首页能看清「待执行的任务」） ── */
table.plan { width: 100%; border-collapse: collapse; font-size: 12.5px; }
table.plan th {
  text-align: left; font-weight: 600; font-size: 11px; color: var(--text-3);
  padding: 0 8px 6px; border-bottom: 1px solid var(--stroke);
}
table.plan td {
  padding: 7px 8px; border-bottom: 1px solid var(--stroke);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
table.plan tr:last-child td { border-bottom: none; }
table.plan tr.next td { background: color-mix(in srgb, var(--brand) 6%, transparent); }
table.plan tr.done-row td { color: var(--text-3); }
table.plan tr.sep td {
  padding: 12px 8px 4px; font-size: 11px; color: var(--text-3);
  border-bottom: 1px solid var(--stroke); background: none;
}
.c-time { width: 96px; }
.c-time b { font-variant-numeric: tabular-nums; }
.c-time .day {
  font-size: 10px; padding: 0 4px; margin-right: 4px; border-radius: 3px;
  color: var(--warn); background: color-mix(in srgb, var(--warn) 14%, transparent);
}
.c-acc { width: 30%; color: var(--text-2); }
.c-state { width: 190px; text-align: right; }
.c-state .fin { margin-left: 6px; font-size: 10.5px; color: var(--text-3); }
table.plan .dim { color: var(--text-3); }
.plan-more { padding: 8px 10px 0; font-size: 11.5px; color: var(--text-3); }
</style>