<template>
  <div class="accounts-page">
    <!-- 标题栏 -->
    <div class="x-head">
      <h1>账号</h1>
      <span class="x-sub">
        {{ list.length }} 个环境 · 已登录 {{ loggedCount }} 个<template v-if="needLoginCount"> · 需登录 {{ needLoginCount }} 个</template>
      </span>
      <span class="x-spacer"></span>
      <button class="x-btn" :disabled="!hasIpc" @click="pickFile">
        <svg viewBox="0 0 24 24"><path d="M12 3v12" /><path d="m7 12 5 5 5-5" /><path d="M4 19h16" /></svg>
        {{ fileName || '导入账号文件' }}
      </button>
      <button class="x-btn primary" :disabled="!hasIpc || busyAll" @click="startLogin()">
        <svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        批量登录
      </button>
      <!-- 没有账号密码的号（只能手机扫码）走这条：建环境 → 弹二维码 → 你扫 → 自动收尾 -->
      <button class="x-btn" :disabled="!hasIpc || busyAll" @click="startQrLogin()">
        <svg viewBox="0 0 24 24">
          <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" /><path d="M14 14h3v3h-3zM20 14v3M14 20h6" />
        </svg>
        扫码加号
      </button>
    </div>

    <!-- 环境不可用提示 -->
    <div v-if="!hasIpc" class="x-tip warn" style="margin-bottom: 14px">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
      <span>浏览器环境功能需要在桌面版中使用。</span>
    </div>
    <div v-else-if="loadError" class="x-tip warn" style="margin-bottom: 14px">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
      <span>{{ loadError }} —— 请确认 FoxProfile 已启动（{{ base || '127.0.0.1:8000' }}）。</span>
    </div>

    <!-- KPI -->
    <div class="kpis">
      <div class="kpi ok">
        <div class="k">已登录</div>
        <div class="v">{{ loggedCount }}<small>/ {{ list.length }}</small></div>
      </div>
      <div class="kpi">
        <div class="k">需登录</div>
        <div class="v" :class="{ warn: needLoginCount > 0 }">{{ needLoginCount }}<small>个</small></div>
      </div>
      <div class="kpi">
        <div class="k">正在运行</div>
        <div class="v">{{ runningCount }}<small>个</small></div>
      </div>
      <div class="kpi">
        <div class="k">账号数据</div>
        <div class="v" style="font-size: 14px; padding-top: 5px">
          {{ profiledCount }} / {{ list.length }} 已拉取
        </div>
      </div>
    </div>

    <!-- 列表 -->
    <div class="x-card list-card">
      <div class="x-card-head">
        <div class="x-ic">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5" /><path d="M4.5 20c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5" /></svg>
        </div>
        <h2>账号列表</h2>
        <input v-model="keyword" class="x-input search" placeholder="搜索用户名 / 环境" />
        <span class="x-spacer"></span>
        <span class="live-hint" :title="`每 ${POLL_MS / 1000} 秒自动刷新`">
          <i class="x-dot ok"></i>自动同步
        </span>
        <!-- 「刷新状态」只重读本地状态（环境在不在跑 / 登录态 / 最后发布），不开浏览器；
             「抓全部资料」要逐个开环境爬页面（10 个号 5~6 分钟）。两个动作差别极大，名字必须分开。 -->
        <button class="x-mini" :disabled="busy" @click="refresh()" title="重读本地状态：环境在不在跑、登录态、最后发布时间">
          <svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 4v4h-4" /></svg>
          刷新状态
        </button>
        <button class="x-mini" :disabled="!hasIpc || busyAll" @click="syncProfiles()" title="逐个开环境抓头像/昵称/粉丝/关注/获赞，10 个号约 5~6 分钟">
          <svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></svg>
          抓全部资料
        </button>
        <button class="x-mini" :class="{ hl: selected.length }" :disabled="!hasIpc || busyAll || !selected.length" @click="openBatch()">
          <svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M14 6l4 4" /></svg>
          批量改资料<template v-if="selected.length"> · {{ selected.length }}</template>
        </button>
        <button class="x-mini" :disabled="!hasIpc || !list.length" @click="openInbox">收件箱</button>
        <!-- 三个备份放一个组里：按钮多了会换行，成组换行才不会孤零零掉一个到第二排 -->
        <div class="head-tools">
          <!-- 账号 txt 放在安装目录（<安装目录>\import\accounts），卸载/重装会跟着没；
               这个按钮把它们复制到数据目录并打成一个 zip，方便挪走留底。 -->
          <button class="x-mini" :disabled="!hasIpc" title="把收件箱里的账号 txt 复制到数据目录并打包成 zip（防止卸载/重装时丢掉）" @click="backupFiles">
            <svg viewBox="0 0 24 24"><path d="M12 3v11" /><path d="M8 10l4 4 4-4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>
            备份文件
          </button>
          <button class="x-mini" :disabled="!hasIpc" title="把账号凭据/资料/闹钟/发布账本写进当天的加密包（系统 DPAPI 加密，不落明文）" @click="backupSecrets">
            <svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
            备份凭据
          </button>
          <button class="x-mini" :disabled="!hasIpc || !list.length || busy" title="重新导出所有环境的 TikTok cookie 到 backups\cookies\<日期>" @click="backupAll">备份 cookie</button>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th style="width: 34px">
              <input type="checkbox" class="chk" :checked="allChecked" :indeterminate.prop="someChecked && !allChecked" title="全选 / 取消全选" @change="toggleAllSelect" />
            </th>
            <th style="width: 88px">环境</th>
            <th style="width: 234px">账号 / 邮箱</th>
            <th style="width: 126px">
              密码
              <button class="eye all" :title="showAll ? '全部隐藏' : '全部显示'" @click="toggleAll">
                <svg v-if="!showAll" viewBox="0 0 24 24"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" /><circle cx="12" cy="12" r="2.6" /></svg>
                <svg v-else viewBox="0 0 24 24"><path d="M3 3l18 18" /><path d="M10.6 6.1A9.9 9.9 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.3 3.9" /><path d="M6.3 8.5A16.7 16.7 0 0 0 2 12s3.6 6.5 10 6.5c1.5 0 2.8-.3 4-.8" /></svg>
              </button>
            </th>
            
            <th style="width: 64px">状态</th>
            <th style="width: 104px">出口 / 活动</th>
            <th style="width: 120px">最后发布</th>
            <th style="width: 238px; text-align: right">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in filtered" :key="row.env">
            <td>
              <input type="checkbox" class="chk" :checked="selected.includes(row.env)" @change="toggleSelect(row.env)" />
            </td>
            <td>
              <span class="env">{{ row.env }}</span>
              <span v-if="row.region" class="x-tag mute region-tag" :title="`账号地区 ${row.region.toUpperCase()}`">{{ row.region.toUpperCase() }}</span>
            </td>
            <td>
              <div class="acct">
                <div class="ava">
                  <img v-if="avatars[row.env]" :src="avatars[row.env]" alt="" />
                  <span v-else>{{ (row.username || row.env).slice(0, 2).toUpperCase() }}</span>
                </div>
                <div class="acct-text">
                  <div class="u">
                    <span class="cp" :title="`${row.nickname || '（无昵称）'}\n点击复制用户名：${row.username}`" @click="copy(row.username, '用户名')">
                      {{ row.nickname || row.username || '（未登记用户名）' }}
                    </span>
                    <svg v-if="row.verified" class="vf" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.5 2.5 4.5-5" /></svg>
                    <span
                      v-if="row.username && row.nickname && row.username !== row.nickname"
                      class="handle cp"
                      :title="`点击复制用户名：${row.username}`"
                      @click="copy(row.username, '用户名')"
                      >@{{ row.username }}</span
                    >
                    <span
                      v-if="row.avatarReverted"
                      class="rev-badge"
                      :title="`头像已经不是我们换的那张了（平台换回）${row.avatarRevertedAt ? '，发现于 ' + shortTime(row.avatarRevertedAt) : ''}`"
                      >头像被换回</span
                    >
                  </div>
                  <div class="m">
                    <span v-if="row.email" class="cp mail" :title="`点击复制邮箱：${row.email}`" @click="copy(row.email, '邮箱')">{{ row.email }}</span>
                    <span v-else class="none">未导入邮箱</span>
                    <span v-if="row.profileAt" class="counts mini" :title="`粉丝 / 关注 / 获赞（资料抓取于 ${fullTime(row.profileAt)}）`">
                      {{ fmt(row.followers) }}<i>/</i>{{ fmt(row.following) }}<i>/</i>{{ fmt(row.likes) }}
                    </span>
                    <span v-if="row.profileAt" class="age mini" :class="{ stale: profileAgeHours(row.profileAt) > 12 }">
                      {{ ageText(row.profileAt) }}
                    </span>
                  </div>
                </div>
              </div>
            </td>
            <td>
              <!-- 点击整格（有密码 / 未导入 都行）→ 直接改凭据，不用再造 txt 文件 -->
              <div v-if="row.password" class="pwd">
                <span class="val cp" :title="`点击复制密码；想改就点右边 ✎`" @click="copy(row.password, '密码')">
                  {{ revealed(row.env) ? row.password : '••••••••' }}
                </span>
                <button class="eye" :title="revealed(row.env) ? '隐藏' : '显示'" @click="toggleReveal(row.env)">
                  <svg v-if="!revealed(row.env)" viewBox="0 0 24 24"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" /><circle cx="12" cy="12" r="2.6" /></svg>
                  <svg v-else viewBox="0 0 24 24"><path d="M3 3l18 18" /><path d="M10.6 6.1A9.9 9.9 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.3 3.9" /><path d="M6.3 8.5A16.7 16.7 0 0 0 2 12s3.6 6.5 10 6.5c1.5 0 2.8-.3 4-.8" /></svg>
                </button>
                <button class="eye" title="修改凭据（密码/邮箱/2FA/地区）" @click="openCred(row)">
                  <svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M14 6l4 4" /></svg>
                </button>
              </div>
              <button v-else class="add-cred" title="添加密码（邮箱/2FA/地区也能一起填）" @click="openCred(row)">
                <svg viewBox="0 0 24 24"><path d="M12 5v14" /><path d="M5 12h14" /></svg>添加
              </button>
            </td>
            <td>
              <span v-if="row.loggedIn === true" class="status on"><i></i>{{ row.running ? '运行中' : '已登录' }}</span>
              <span v-else-if="row.loggedIn === false" class="status off"><i></i>需登录</span>
              <span v-else class="status unknown"><i></i>{{ row.note || '未知' }}</span>
            </td>
            <td>
              <div class="ip" :title="row.proxy">{{ shortProxy(row.proxy) }}</div>
              <div class="ip sub" :title="`最近活动 ${ago(row.lastActive)}前 · ${row.cookies} 条 TikTok cookie`">{{ ago(row.lastActive) }}前</div>
            </td>
            <td>
              <!-- 最后一次发布成功的时间（来源：发布账本 publish-ledger.jsonl + .published 兜底） -->
              <div v-if="publishTimes[row.env]" class="pub" :title="publishTitle(row.env)">
                <div class="pub-at">{{ fmtPublishAt(publishTimes[row.env].at) }}</div>
                <div class="pub-ago">{{ ago(publishTimes[row.env].at) }}前</div>
              </div>
              <span v-else class="none" title="这个环境还没有成功发布记录">—</span>
            </td>
            <td>
              <div class="rowact">
                <button v-if="!row.running" class="x-mini" :disabled="busy || !row.exists" @click="launch(row, 'launch')">
                  <svg viewBox="0 0 24 24"><path d="m8 5 11 7-11 7z" /></svg>启动
                </button>
                <button v-else class="x-mini" :disabled="busy" @click="launch(row, 'stop')">停止</button>
                <!--
                  行内这两个按钮以前是纯图标（只能靠 tooltip 分辨）。现在给了文字，
                  图标就去掉了：有文字时图标只是重复信息，还要多占约 40px，
                  而这一行有 10 列、总宽刚过 1240 —— 那 40px 正是邮箱/IP 被截断的原因。
                -->
                <button class="x-mini" :disabled="busy || busyAll" title="只拉这个号的资料（头像 / 粉丝 / 关注 / 获赞）" @click="syncProfiles(row.env)">抓资料</button>
                <button class="x-mini" :disabled="busy || busyAll" title="改这个号的资料（头像 / 名字 / 用户名 / 简介）" @click="openEdit(row)">改资料</button>
                <button class="x-mini hi" :disabled="busy || busyAll" @click="startLogin(row.env)">登录</button>
              </div>
            </td>
          </tr>
          <tr v-if="!filtered.length">
            <td colspan="8">
              <div class="x-empty">
                {{ list.length ? '没有匹配的账号' : '还没有环境：把账号文件丢进收件箱，或在配置页绑定 FoxProfile 环境' }}
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 单个账号资料编辑：右侧滑出面板 -->
    <div v-if="editForm" class="mask" @click.self="closeEdit()">
      <div class="panel">
        <div class="ph">
          <h3>修改资料 · {{ editForm.env }}</h3>
          <button class="dbtn" @click="closeEdit()">×</button>
        </div>
        <div class="pbody">
          <div class="pava">
            <div class="ava big">
              <img v-if="editForm.avatarPreview" :src="editForm.avatarPreview" alt="" />
              <span v-else>{{ (editForm.username || editForm.env).slice(0, 2).toUpperCase() }}</span>
            </div>
            <div class="pava-act">
              <span v-if="editForm.avatar" class="picked" :title="editForm.avatar">{{ baseName(editForm.avatar) }}</span>
              <button class="x-mini" @click="pickAvatar('single')">
                <svg viewBox="0 0 24 24"><path d="M4 16.5V19a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1v-2.5" /><path d="M12 4v11" /><path d="m8 8 4-4 4 4" /></svg>
                选择图片
              </button>
              <button v-if="editForm.avatar" class="x-mini" @click="clearAvatar('single')">清除</button>
            </div>
          </div>
          <label class="frow">
            <span>名字（昵称）</span>
            <input v-model="editForm.name" class="x-input" maxlength="30" placeholder="留空 = 不改" />
          </label>
          <label class="frow">
            <span>用户名</span>
            <input v-model="editForm.newUsername" class="x-input" maxlength="24" :placeholder="editForm.username || '留空 = 不改'" />
          </label>
          <p class="fhint">用户名全站唯一（约 30 天一次）；名字（昵称）实测 7 天一次；不确定就留空。</p>
          <label class="frow top">
            <span>个人简介</span>
            <textarea v-model="editForm.bio" class="x-input" rows="4" maxlength="80" placeholder="留空 = 不改，最多 80 字"></textarea>
          </label>
        </div>
        <div class="pf">
          <span class="x-tip">{{ editForm.hint }}</span>
          <span class="x-spacer"></span>
          <button class="x-mini" :disabled="editing || !canSubmitEdit" @click="submitEdit(true)">演练</button>
          <button class="x-btn" :disabled="editing || !canSubmitEdit" @click="submitEdit(false)">保存并应用</button>
        </div>
      </div>
    </div>

    <!-- 凭据编辑（点密码格 / 未导入的「+ 添加」） -->
    <div v-if="credForm" class="mask" @click.self="credForm = null">
      <div class="panel">
        <div class="ph">
          <h3>账号凭据 · {{ credForm.env }}<span v-if="credForm.username" class="cred-user">@{{ credForm.username }}</span></h3>
          <button class="dbtn" @click="credForm = null">×</button>
        </div>
        <div class="pbody">
          <label class="frow">
            <span>密码</span>
            <input
              v-model="credForm.password"
              class="x-input"
              :type="credForm.showPwd ? 'text' : 'password'"
              autocomplete="off"
              spellcheck="false"
              placeholder="TikTok 登录密码"
            />
          </label>
          <div class="frow">
            <span></span>
            <div style="display: flex; gap: 8px; align-items: center">
              <button class="x-mini" @click="credForm.showPwd = !credForm.showPwd">{{ credForm.showPwd ? '隐藏' : '显示' }}</button>
              <span class="fhint" style="margin: 0">存在本机 `data\env-accounts.json`（明文，界面要能复制）；保存后自动更新加密备份。</span>
            </div>
          </div>
          <label class="frow">
            <span>邮箱</span>
            <input
              v-model="credForm.email"
              class="x-input"
              autocomplete="off"
              spellcheck="false"
              :placeholder="credForm.emailMasked ? `TikTok 只给脱敏串 ${credForm.emailMasked}，完整邮箱请填这里` : '完整邮箱（TikTok 只给脱敏串，这里填全的）'"
            />
          </label>
          <label class="frow">
            <span>邮箱密码</span>
            <input v-model="credForm.emailPassword" class="x-input" autocomplete="off" spellcheck="false" placeholder="收验证码用，可留空" />
          </label>
          <label class="frow">
            <span>2FA 密钥</span>
            <input v-model="credForm.totpSecret" class="x-input" autocomplete="off" spellcheck="false" placeholder="base32 密钥，可留空（有它才能在异地重登）" />
          </label>
          <label class="frow">
            <span>地区</span>
            <input v-model="credForm.region" class="x-input" maxlength="6" placeholder="gb / us（TikTok 不提供，只能手填）" />
          </label>
          <p class="fhint">留空的格子会被清空（这是编辑器语义）；只想改密码，其它格保持原样不要动。</p>
        </div>
        <div class="pf">
          <span class="x-tip">{{ credForm.hint || '保存只写本地凭据文件 + 加密备份，不会登录、不动 cookie。' }}</span>
          <span class="x-spacer"></span>
          <button class="x-mini" :disabled="credSaving" @click="credForm = null">取消</button>
          <button class="x-btn" :disabled="credSaving" @click="saveCred">{{ credSaving ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>

    <!-- 批量改资料 -->
    <div v-if="batchForm" class="mask" @click.self="batchForm = null">
      <div class="panel wide">
        <div class="ph">
          <h3>批量改资料 · 已选 {{ selected.length }} 个</h3>
          <button class="dbtn" @click="batchForm = null">×</button>
        </div>
        <div class="pbody">
          <label class="frow">
            <span>名字模板</span>
            <input v-model="batchForm.nameTpl" class="x-input" placeholder="留空 = 不改，例：{nickname} UK" />
          </label>
          <label class="frow">
            <span>简介模板</span>
            <input v-model="batchForm.bioTpl" class="x-input" placeholder="留空 = 不改，例：UK daily · since {n}" />
          </label>
          <p class="fhint">
            可用变量：<code>{username}</code> 用户名、<code>{nickname}</code> 当前昵称、<code>{region}</code> 地区、<code>{env}</code> 环境名、<code>{n}</code> 序号（1 起）。
          </p>
          <div class="frow">
            <span>统一头像</span>
            <div class="pava">
              <div class="ava sm">
                <img v-if="batchForm.avatarPreview" :src="batchForm.avatarPreview" alt="" />
                <span v-else>无</span>
              </div>
              <button class="x-mini" @click="pickAvatar('batch')">选择图片</button>
              <button v-if="batchForm.avatar" class="x-mini" @click="clearAvatar('batch')">清除</button>
              <span v-if="batchForm.avatar" class="picked" :title="batchForm.avatar">{{ baseName(batchForm.avatar) }}</span>
            </div>
          </div>
          <p class="fhint">用户名不可批量：全站唯一 + 约 30 天冷却；名字（昵称）7 天一次。需要改就逐个来。</p>
          <div class="preview">
            <div class="pv-head">预览（{{ batchRows.length }} 行）<span v-if="batchForm.avatar" class="pv-ava"> · 头像统一换成 {{ baseName(batchForm.avatar) }}</span></div>
            <div v-for="(p, i) in batchRows" :key="p.env" class="pv-row">
              <b>{{ p.env }}</b>
              <span class="pv-name" :class="{ none: !p.name }">{{ p.name || '名字不改' }}</span>
              <span class="pv-bio" :class="{ none: !p.bio }">{{ p.bio || '简介不改' }}</span>
            </div>
            <div v-if="!batchRows.length" class="x-empty">模板是空的，先把名字或简介模板填上</div>
          </div>
        </div>
        <div class="pf">
          <span class="x-tip">每个号会在自己的 FoxProfile 环境里打开网页改，一个接一个，别中止在保存前。</span>
          <span class="x-spacer"></span>
          <button class="x-mini" :disabled="editing || !batchRows.length" @click="submitBatch(true)">演练</button>
          <button class="x-btn" :disabled="editing || !batchRows.length" @click="submitBatch(false)">开始执行</button>
        </div>
      </div>
    </div>

    <!-- 任务进行中：右下角进度抽屉 -->
    <div v-if="drawerOpen" class="drawer">
      <div class="dh">
        <span v-if="busyAll" class="spin"></span>
        <span v-else class="done-ic">
          <svg viewBox="0 0 24 24"><path d="m5 13 4 4L19 7" /></svg>
        </span>
        {{ busyAll ? taskTitle : '任务已结束' }}
        <span class="x-spacer"></span>
        <button class="dbtn copy" title="把全部日志复制到剪贴板" @click="copyLogs">
          <svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" /></svg>
          复制日志
        </button>
        <button class="dbtn" @click="lines = []">清空</button>
        <button v-if="busyAll" class="dbtn danger" @click="cancelTask">中止</button>
        <button v-else class="dbtn" @click="closeDrawer">×</button>
      </div>
      <div ref="logBox" class="log">
        <div v-for="(l, i) in lines" :key="i" class="logline" :class="lineClass(l)">{{ l }}</div>
      </div>
      <div class="bar"><i :style="{ width: progressPct + '%' }"></i></div>
      <div class="dmsg">{{ summary }}</div>
    </div>
    <!-- 复制反馈 -->
    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';

const POLL_MS = 6000; // 浏览器被手动关掉后，最多这么久界面就会自己同步过来
const hasIpc = typeof window !== 'undefined' && !!window.xnowpost?.listAccounts;
const list = ref([]);
const publishTimes = ref({}); // env → { at, date, session, title }
const base = ref('');
const loadError = ref('');
const busy = ref(false);
const keyword = ref('');
const fileName = ref('');
const pickedPath = ref('');
const avatars = ref({});
const revealedSet = ref([]); // 展开密码的环境名
const showAll = ref(false);
const toast = ref('');
let toastTimer = null;

const running = ref(false); // 登录/资料任务是否在跑（含自动同步）
const editing = ref(false); // 资料修改任务是否在跑
const syncing = ref(false);
const taskKind = ref('login');
const lines = ref([]);
const drawerOpen = ref(false);
const logBox = ref(null);
let offProgress = null;
let offPublishTimes = null;
let pollTimer = null;

const busyAll = computed(() => running.value || syncing.value || editing.value);
const taskTitle = computed(() =>
  taskKind.value === 'login' ? '批量登录进行中' : taskKind.value === 'edit' ? '正在修改账号资料' : '正在拉取账号资料',
);

const loggedCount = computed(() => list.value.filter((r) => r.loggedIn === true).length);
const needLoginCount = computed(() => list.value.filter((r) => r.loggedIn === false).length);
const runningCount = computed(() => list.value.filter((r) => r.running).length);
const profiledCount = computed(() => list.value.filter((r) => r.profileAt).length);

const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase();
  if (!k) return list.value;
  return list.value.filter(
    (r) =>
      r.env.toLowerCase().includes(k) ||
      (r.username || '').toLowerCase().includes(k) ||
      (r.nickname || '').toLowerCase().includes(k),
  );
});

const doneCount = computed(() => lines.value.filter((l) => /✅|❌/.test(l)).length);
const totalCount = computed(() => {
  const t = lines.value.join('\n');
  const m = t.match(/合计：要跑\s*(\d+)/) || t.match(/目标\s*(\d+)\s*个环境/);
  return m ? Number(m[1]) : 0;
});
const progressPct = computed(() => {
  if (!busyAll.value) return lines.value.length ? 100 : 0;
  if (!totalCount.value) return 8;
  return Math.min(96, Math.round((doneCount.value / totalCount.value) * 100));
});
const summary = computed(() => {
  if (busyAll.value) {
    return totalCount.value
      ? `已完成 ${doneCount.value} / ${totalCount.value}，可随时中止`
      : '正在准备…';
  }
  const ok = lines.value.filter((l) => /✅/.test(l)).length;
  const bad = lines.value.filter((l) => /❌/.test(l)).length;
  return `结束：成功 ${ok} 个，失败 ${bad} 个`;
});

function revealed(env) {
  return showAll.value || revealedSet.value.includes(env);
}
function toggleReveal(env) {
  const s = revealedSet.value;
  revealedSet.value = s.includes(env) ? s.filter((x) => x !== env) : [...s, env];
}
function toggleAll() {
  showAll.value = !showAll.value;
}

function notify(text) {
  toast.value = text;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ''), 1800);
}

async function copy(text, label = '内容') {
  const v = String(text || '');
  if (!v) return notify(`${label}为空`);
  const r = await window.xnowpost.copyText(v);
  if (!r.ok) return notify(`复制失败：${r.message}`);
  // 密码不回显到屏幕上（截图/录屏会漏），只说复制了几位
  if (label === '密码') return notify(`已复制密码（${v.length} 位）`);
  notify(`已复制${label}：${v.length > 28 ? v.slice(0, 26) + '…' : v}`);
}

function shortProxy(p) {
  if (!p) return '直连';
  // 表格里只留 host:port，协议放 title —— 否则整列都被 "socks5 " 吃掉
  return String(p).replace(/^(socks5|socks4|http|https):\/\//i, '');
}
function fmt(n, label) {
  const s = String(n == null ? '' : n).trim();
  if (!s) return '—';
  const v = Number(s);
  if (!Number.isFinite(v)) return s;
  return v >= 10000 ? `${(v / 10000).toFixed(1)}万` : v.toLocaleString('en-US');
}
function ago(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 90) return '刚刚';
  if (s < 3600) return `${Math.round(s / 60)}分`;
  if (s < 86400) return `${Math.round(s / 3600)}小时`;
  return `${Math.round(s / 86400)}天`;
}
function lineClass(l) {
  if (/✅/.test(l)) return 'ok';
  if (/❌/.test(l)) return 'bad';
  if (/⚠️|人机验证/.test(l)) return 'warn';
  if (/──|═══|合计|目标/.test(l)) return 'head';
  return '';
}

async function loadAvatars(rows) {
  if (!hasIpc) return;
  const next = { ...avatars.value };
  let changed = false;
  for (const r of rows) {
    if (!r.hasAvatar) continue;
    // 缓存键 = 内容哈希（没有哈希才退回时间戳）。只看时间戳时，
    // 「同一张文件名、内容被换成另一张」不会触发重载，界面就会一直显示旧头像。
    const key = r.avatarSha ? `sha:${r.avatarSha}` : `at:${r.avatarAt || ''}`;
    if (next[r.env] && next[r.env + ':at'] === key) continue;
    const uri = await window.xnowpost.getAccountAvatar(r.env);
    if (uri) {
      next[r.env] = uri;
      next[r.env + ':at'] = key;
      changed = true;
    }
  }
  if (changed) avatars.value = next;
}

async function refresh(silent = false) {
  if (!hasIpc) return;
  if (!silent) busy.value = true;
  try {
    const r = await window.xnowpost.listAccounts();    if (r.ok) {
      list.value = r.list || [];
      base.value = r.base || '';
      loadError.value = '';
      if (!list.value.length && r.debug) {
        loadError.value = `主进程只拿到 0 个环境（profiles=${r.debug.profiles}, config=${r.debug.cfgAccounts}）`;
      }
      loadAvatars(list.value);
    } else {
      loadError.value = r.message || '读取失败';
    }
  } catch (e) {
    loadError.value = String(e.message || e);
  } finally {
    if (!silent) busy.value = false;
  }
}

/**
 * 每个账号最后一次发布成功的时间。
 * 主进程监听 publish-ledger.jsonl，发布成功的瞬间会主动推一次（onPublishTimesUpdated）；
 * 这里的轮询只是兜底（比如发布进程写完账本就被杀掉）。
 */
async function loadPublishTimes() {
  if (!hasIpc || !window.xnowpost.getPublishTimes) return;
  try {
    const r = await window.xnowpost.getPublishTimes();
    if (r && r.ok) publishTimes.value = r.latest || {};
  } catch (_) { /* 读不到就保持上一次的值 */ }
}

/** 账本里的 ISO 时间 → 本地「10-18 23:17」 */
function fmtPublishAt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── 资料新鲜度（用户 2026-10-20 口径：「资料抓的不准，不及时」）─────────────
// 光有数字不够，得让人一眼看出「这是什么时候抓的」。
function profileAgeHours(iso) {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 3600000;
}
function ageText(iso) {
  const h = profileAgeHours(iso);
  if (!Number.isFinite(h)) return '';
  if (h < 1 / 60) return '刚刚';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} 分钟前`;
  if (h < 24) return `${Math.round(h)} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}
function shortTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fullTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('zh-CN', { hour12: false });
}

function publishTitle(env) {
  const t = publishTimes.value[env];
  if (!t) return '';
  const at = new Date(t.at);
  const full = Number.isNaN(at.getTime()) ? t.at : at.toLocaleString('zh-CN', { hour12: false });
  return `最后一次发布成功：${full}\n会话：${t.date || ''}/${t.session || ''}\n标题：${t.title || '（未记录）'}`;
}

async function pickFile() {
  const p = await window.xnowpost.pickAccountFile();
  if (!p) return;
  pickedPath.value = p;
  fileName.value = p.split(/[\\/]/).pop();
  // 真导入：把用户名/密码/邮箱/地区写进状态文件，界面才能显示和复制密码
  const r = await window.xnowpost.importAccountFile(p);
  if (r.ok) {
    drawerOpen.value = true;
    lines.value = [];
    push(`  ✅ 已导入 ${r.count} 个账号的凭据（用户名/密码/邮箱/地区）`);
    for (const m of r.mapping || []) push(`     ${m.env} → @${m.username}`);
    // 新号会自动拿 TK11、TK12…（按用户名对齐，不会覆盖已有环境）——这点必须说清楚，
    // 否则用户会以为「导入就得把 10 个老号一起写进文件」。
    const fresh = (r.mapping || []).filter((m) => Number(String(m.env).replace(/\D/g, '')) > (list.value?.length || 0));
    if (fresh.length) {
      push(`  🆕 ${fresh.length} 个新账号将用新环境：${fresh.map((m) => m.env).join(', ')}（点「批量登录」时自动创建）`);
    }
    push('  提示：老账号留在原环境、新账号自动排新环境；这一步只读文件、不会登录，要登录请点「批量登录」。');
    push(`  📁 用的是这个文件：${p}（下次点「导入账号文件」还会打开这个目录）`);
    await refresh(true);
  } else {
    drawerOpen.value = true;
    push(`  ❌ 导入失败：${r.message}`);
  }
}

async function openInbox() {
  await window.xnowpost.openAccountInbox();
}

async function launch(row, action) {
  busy.value = true;
  const r = await window.xnowpost.launchAccountEnv(row.env, action);
  // 成功不用弹抽屉：行内状态 + 自动同步就够了；失败才需要把日志亮出来
  if (!r.ok) {
    drawerOpen.value = true;
    push(`  ${action === 'stop' ? '停止' : '启动'} ${row.env} 失败：${r.message}`);
  }
  busy.value = false;
  refresh(true);
}

/**
 * 备份账号文件：收件箱（安装目录\import\accounts）里的 txt/csv 复制到数据目录并打包 zip。
 * 为什么要它：文件放安装目录是用户要求的（好找），代价是**卸载/重装会跟着删掉**；
 * 这个按钮一键留底，zip 在 %APPDATA%\xnowpost\backups\account-files\ 下，重装后随便挪回去。
 */
async function backupFiles() {
  if (!hasIpc) return;
  drawerOpen.value = true;
  push('  正在备份收件箱里的账号文件…');
  try {
    const r = await window.xnowpost.backupAccountFiles();
    if (!r.ok) {
      push(`  ❌ ${r.message || '备份失败'}`);
      return;
    }
    push(`  ✅ 已备份 ${r.count} 个账号文件（${(r.bytes / 1024).toFixed(1)} KB）`);
    push(`  目录：${r.dir}`);
    if (r.zip) push(`  压缩包：${r.zip}`);
    else push('  ⚠️ 压缩包没生成（目录里的副本还在，可以直接拷走）');
    push('  提示：这个备份**不含**密码/邮箱（那些在 data\\env-accounts.json 里），要连凭据一起备份请单独拷那个文件。');
  } catch (e) {
    push(`  ❌ ${e.message}`);
  }
}

/**
 * 凭据编辑弹窗（点密码格里的 ✎ / 未导入的「+ 添加」）。
 * 目的：用户 2026-10-24「不能有按钮添加密码吗」—— 不再要求手写 txt 文件。
 * 保存只写本地凭据文件（+ 自动重写加密备份），**不登录、不动 cookie**。
 */
async function openCred(row) {
  // 邮箱要分清「完整邮箱」和 TikTok 给的脱敏串（k***e@outlook.com）：
  // 脱敏串只当提示（placeholder），**绝不能预填进输入框** —— 否则一保存就把脱敏串当成真邮箱存下来。
  const mail = String(row.email || '');
  const masked = mail.includes('*') ? mail : '';
  credForm.value = {
    env: row.env,
    username: row.username || '',
    password: row.password || '',
    email: masked ? '' : mail,
    emailMasked: masked,
    emailPassword: row.emailPassword || '',
    totpSecret: row.totpSecret || '',
    region: row.region || '',
    showPwd: !row.password, // 没密码时直接显示输入框内容，省一次点击
  };
}

async function saveCred() {
  const f = credForm.value;
  if (!f || credSaving.value) return;
  credSaving.value = true;
  try {
    const r = await window.xnowpost.saveAccountCredentials({
      env: f.env,
      username: f.username,
      password: f.password,
      email: f.email,
      emailPassword: f.emailPassword,
      totpSecret: f.totpSecret,
      region: f.region,
    });
    if (!r || !r.ok) {
      notify(`保存失败：${(r && r.message) || '未知错误'}`);
      return;
    }
    drawerOpen.value = true;
    push(`  ✅ ${f.env} 凭据已保存${f.password ? `（密码 ${f.password.length} 位）` : '（密码为空）'}`);
    if (r.backup && r.backup.ok) push(`  🔐 加密备份已更新：${r.backup.fileCount} 个文件`);
    else push('  ⚠️ 加密备份没更新成功（凭据已写盘，备份下次再补）');
    credForm.value = null;
    await refresh(true);
  } catch (e) {
    notify(`保存失败：${e.message}`);
  } finally {
    credSaving.value = false;
  }
}

/** 一键备份凭据（加密包，系统 DPAPI） */
async function backupSecrets() {
  if (!hasIpc) return;
  drawerOpen.value = true;
  push('  正在写凭据加密包…');
  try {
    const r = await window.xnowpost.backupAccountSecrets();
    if (!r || !r.ok) {
      push(`  ❌ 凭据备份失败：${(r && (r.reason || r.message)) || '未知原因'}`);
      return;
    }
    push(`  ✅ 凭据备份完成：${r.fileCount} 个文件`);
    push(`  文件：${r.file}`);
    push(`  规则：每天一份、留最近 ${r.keepDays} 天；启动时若发现凭据文件丢了/坏了会自动从这里恢复。`);
  } catch (e) {
    push(`  ❌ ${e.message}`);
  }
}

async function backupAll() {
  busy.value = true;
  drawerOpen.value = true;
  push('  正在备份 cookie…');  const r = await window.xnowpost.backupAccountCookies(list.value.map((x) => x.env));
  const ok = (r.out || []).filter((x) => x.ok).length;
  const bad = (r.out || []).filter((x) => !x.ok).length;
  push(`  ${bad ? '⚠️' : '✅'} cookie 备份完成：成功 ${ok} 个${bad ? `，失败 ${bad} 个` : ''}`);
  push(`  目录：${r.dir}`);
  busy.value = false;
}

async function copyLogs() {
  const text = lines.value.join('\n').trim();
  if (!text) return notify('日志是空的');
  const r = await window.xnowpost.copyText(text);
  notify(r.ok ? `已复制 ${lines.value.length} 行日志` : `复制失败：${r.message}`);
}

function closeDrawer() {
  drawerOpen.value = false;
  lines.value = [];
}

function push(text) {
  lines.value.push(text);
  nextTick(() => {
    if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight;
  });
}

async function startLogin(only) {
  if (!hasIpc || busyAll.value) return;
  const onlyEnv = typeof only === 'string' && /^TK\d+$/i.test(only) ? only : undefined;
  taskKind.value = 'login';
  running.value = true;
  lines.value = [];
  drawerOpen.value = true;
  push('  正在启动登录任务…');
  try {
    const r = await window.xnowpost.runAccountLogin({
      file: pickedPath.value || undefined,
      only: onlyEnv,
      gap: 60,
    });
    if (!r.ok && r.message) push(`  ❌ ${r.message}`);
    else push(`  进程结束（退出码 ${r.code}）`);
  } catch (e) {
    push(`  ❌ ${e.message}`);
  } finally {
    running.value = false;
    await refresh(true);
    // 同 startQrLogin：**不要**自动抓全部资料（那会开 10 个环境跑 5~6 分钟，属于没下指令的动作）。
    // 新号缺资料就提示一句，由用户自己点行尾「抓资料」。
    if (list.value.some((r) => !r.profileAt)) {
      push('  提示：刚登录的号还缺头像/粉丝等资料，需要就点行尾「抓资料」（只抓那一个环境）。');
    }
  }
}


/**
 * 扫码加号：没有账号密码的号只能手机扫码。点一次 = 建/用一个空号环境（TK11…）→
 * 浏览器弹出二维码 → 你手机扫 → 扫完自动读用户名、写配置、备份 cookie、关窗口。
 * 一次加多个就多点几次（登录任务同时只允许一个在跑）。
 */
async function startQrLogin() {
  if (!hasIpc || busyAll.value) return;
  taskKind.value = 'login';
  running.value = true;
  lines.value = [];
  drawerOpen.value = true;
  push('  扫码加号：正在打开环境并生成二维码…');
  push('  提示：浏览器窗口会自动顶到最前，手机 TikTok → 我 → 右上角扫码；');
  push('        不想加了就直接关掉那个浏览器窗口（会当失败处理，不会占用环境）。');
  try {
    const r = await window.xnowpost.runAccountLogin({ qr: true, qrCount: 1, gap: 60 });
    if (!r.ok && r.message) push(`  ❌ ${r.message}`);
    else push(`  进程结束（退出码 ${r.code}）`);
  } catch (e) {
    push(`  ❌ ${e.message}`);
  } finally {
    running.value = false;
    await refresh(true);
    // 注意：这里**不要**自动去「抓全部资料」。
    // v1.6.76 曾在这里 `if (list.value.some(r => !r.profileAt)) syncProfiles()`，
    // 结果用户扫完码，程序自己把 10 个环境全开了一遍（每个 30 秒、窗口一个个闪），
    // 用户根本没下过这个指令（2026-10-24 明确反问「为什么又拉取全部账号呀，我有下指令吗」）。
    // 用户名登录流程自己已经读到了（/tiktokstudio 的 @ 链接），缺的只是头像/粉丝数，
    // 需要就让用户自己点行尾「抓资料」。
    if (list.value.some((r) => !r.profileAt)) {
      push('  提示：新号还缺头像/粉丝/获赞等资料，需要就点行尾「抓资料」（只抓那一个环境）。');
    }
  }
}

async function syncProfiles(only) {
  if (!hasIpc || busyAll.value) return;
  taskKind.value = 'profile';
  syncing.value = true;
      lines.value = [];
      drawerOpen.value = true;
  push('  正在拉取账号资料（头像/粉丝/关注/赞）…');
  try {
    const r = await window.xnowpost.syncAccountProfiles({
      only: typeof only === 'string' ? only : undefined,
      gap: 3,
    });
    if (!r.ok && r.message) push(`  ❌ ${r.message}`);
    else push(`  进程结束（退出码 ${r.code}）`);
  } catch (e) {
    push(`  ❌ ${e.message}`);
  } finally {
    syncing.value = false;
    await refresh(true);
  }
}

async function cancelTask() {
  const r = await window.xnowpost.cancelAccountLogin();
  push(r.ok ? '  ⚠️ 已请求中止' : `  ${r.message}`);
}

/* ───────── 资料修改：单个 / 批量 ───────── */
const selected = ref([]);
const editForm = ref(null); // { env, username, name, newUsername, bio, avatar, avatarPreview, hint }
const batchForm = ref(null); // { nameTpl, bioTpl, avatar, avatarPreview }
// 凭据编辑（密码/邮箱/邮箱密码/2FA/地区）：点密码格里的 ✎ 打开
const credForm = ref(null); // { env, username, password, email, emailPassword, totpSecret, region, showPwd }
const credSaving = ref(false);

const allChecked = computed(() => filtered.value.length > 0 && filtered.value.every((r) => selected.value.includes(r.env)));
const someChecked = computed(() => filtered.value.some((r) => selected.value.includes(r.env)));
const canSubmitEdit = computed(() => {
  const f = editForm.value;
  if (!f) return false;
  return Boolean(f.name || f.bio || f.avatar || (f.newUsername && f.newUsername !== f.username));
});

function toggleSelect(env) {
  selected.value = selected.value.includes(env) ? selected.value.filter((e) => e !== env) : [...selected.value, env];
}
function toggleAllSelect() {
  selected.value = allChecked.value ? [] : filtered.value.map((r) => r.env);
}

function openEdit(row) {
  const cur = String(row.nickname || '');
  editForm.value = {
    env: row.env,
    username: row.username || '',
    // 昵称等于用户名（新号默认）时留空，避免用户以为要重复填一遍
    name: cur && cur !== row.username ? cur : '',
    newUsername: '',
    bio: String(row.bio || '').toLowerCase().startsWith('no bio') ? '' : String(row.bio || ''),
    avatar: '',
    avatarPreview: avatars.value[row.env] || '',
    hint: row.username ? `当前 @${row.username}` : '这个环境还没登记用户名，先导入账号文件或登录一次',
  };
}

function closeEdit() {
  editForm.value = null;
}

async function pickAvatar(which) {
  const r = await window.xnowpost.pickAccountImage();
  if (!r || r.canceled) return; // 用户自己按了取消，不打扰
  if (!r.ok) {
    notify(`选图失败：${r.message || '未知错误'}`);
    return;
  }
  // 读成 data URI 做缩略图：渲染进程没有 file:// 权限。
  // （之前这里被我写成「清空预览」，所以选完图界面还是显示「无」，看起来像没反应）
  const pv = await window.xnowpost.previewAccountImage(r.path);
  const uri = pv && pv.ok ? pv.uri : '';
  if (which === 'single' && editForm.value) {
    editForm.value.avatar = r.path;
    editForm.value.avatarPreview = uri;
    editForm.value.hint = `头像：${r.name}${uri ? '' : '（预览失败，仍会上传原图）'}`;
  } else if (which === 'batch' && batchForm.value) {
    batchForm.value.avatar = r.path;
    batchForm.value.avatarPreview = uri;
  }
  notify(`已选择头像：${r.name}${uri ? '' : '（预览失败）'}`);
}
function baseName(p) {
  return String(p || '').split(/[\\/]/).pop() || '';
}
function clearAvatar(which) {
  if (which === 'single' && editForm.value) {
    editForm.value.avatar = '';
    editForm.value.avatarPreview = avatars.value[editForm.value.env] || '';
    editForm.value.hint = `当前 @${editForm.value.username || '?'}`;
  } else if (which === 'batch' && batchForm.value) {
    batchForm.value.avatar = '';
    batchForm.value.avatarPreview = '';
  }
}

/** 模板变量：{username} {nickname} {region} {env} {n} */
function tpl(str, row, index) {
  return String(str || '').replace(/\{(username|nickname|region|env|n)\}/gi, (_m, key) => {
    const k = String(key).toLowerCase();
    if (k === 'username') return row.username || '';
    if (k === 'nickname') return row.nickname || row.username || '';
    if (k === 'region') return (row.region || '').toUpperCase();
    if (k === 'env') return row.env;
    return String(index + 1);
  });
}

const batchRows = computed(() => {
  const f = batchForm.value;
  if (!f) return [];
  const rows = list.value.filter((r) => selected.value.includes(r.env));
  return rows.map((r, i) => ({
    env: r.env,
    username: r.username,
    name: f.nameTpl ? tpl(f.nameTpl, r, i).trim() : '',
    bio: f.bioTpl ? tpl(f.bioTpl, r, i).trim() : '',
  }));
});

function openBatch() {
  if (!selected.value.length) return;
  batchForm.value = { nameTpl: '', bioTpl: '', avatar: '', avatarPreview: '' };
}

async function runEditJobs(jobs, dryRun) {
  if (!hasIpc || busyAll.value || editing.value) return;
  taskKind.value = 'edit';
  editing.value = true;
  lines.value = [];
  drawerOpen.value = true;
  push(`  正在${dryRun ? '演练' : '修改'}资料：${jobs.length} 个环境…`);
  try {
    const r = await window.xnowpost.editAccountProfiles({ jobs, dryRun, gap: 4 });
    if (!r.ok && r.message) push(`  ❌ ${r.message}`);
    else push(`  进程结束（退出码 ${r.code}）`);
  } catch (e) {
    push(`  ❌ ${e.message}`);
  } finally {
    editing.value = false;
    await refresh(true);
  }
}

async function submitEdit(dryRun) {
  const f = editForm.value;
  if (!f) return;
  const job = { env: f.env };
  if (f.avatar) job.avatar = f.avatar;
  if (f.name.trim()) job.name = f.name.trim();
  if (f.bio.trim()) job.bio = f.bio.trim();
  if (f.newUsername.trim() && f.newUsername.trim() !== f.username) job.newUsername = f.newUsername.trim();
  if (!job.avatar && !job.name && !job.bio && !job.newUsername) {
    notify('没有要改的内容');
    return;
  }
  closeEdit();
  await runEditJobs([job], dryRun);
}

async function submitBatch(dryRun) {
  const f = batchForm.value;
  if (!f) return;
  const jobs = batchRows.value
    .map((p) => {
      const job = { env: p.env };
      if (p.name) job.name = p.name;
      if (p.bio) job.bio = p.bio;
      if (f.avatar) job.avatar = f.avatar;
      return job;
    })
    .filter((j) => j.name || j.bio || j.avatar);
  if (!jobs.length) {
    notify('没有要改的内容');
    return;
  }
  batchForm.value = null;
  selected.value = [];
  await runEditJobs(jobs, dryRun);
}

onMounted(() => {
  refresh();
  loadPublishTimes();
  if (hasIpc) {
    offProgress = window.xnowpost.onAccountProgress((p) => {
      if (p.type === 'line') push(p.text);
      else if (p.type === 'start') push(p.text);
      else if (p.type === 'done') {
        // 任务收尾：立刻刷一次列表和头像（改资料会换掉头像文件，不刷新还是旧图）
        refresh(true);
        loadPublishTimes();
      }
    });
    // 发布成功的瞬间主进程就推过来 → 不用等 6 秒轮询
    if (window.xnowpost.onPublishTimesUpdated) {
      offPublishTimes = window.xnowpost.onPublishTimesUpdated((payload) => {
        if (payload && payload.ok) publishTimes.value = payload.latest || {};
      });
    }
  }
  // 自动同步：浏览器被手动关掉、或别的窗口改了状态，界面最多 6 秒就能跟上
  pollTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (busyAll.value) return;
    refresh(true);
    loadPublishTimes();
  }, POLL_MS);
});


onUnmounted(() => {
  if (offProgress) offProgress();
  if (offPublishTimes) offPublishTimes();
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<style scoped>
.accounts-page { display: flex; flex-direction: column; gap: 14px; }

.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.kpi {
  background: var(--bg2);
  border: 1px solid var(--stroke);
  border-radius: var(--r-md);
  padding: 13px 15px;
  min-width: 0;
}
.kpi .k { font-size: 11.5px; color: var(--text-3); }
.kpi .v {
  font-size: 22px; font-weight: 680; margin-top: 5px; letter-spacing: 0.3px;
  color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.kpi .v small { font-size: 12px; color: var(--text-3); font-weight: 500; margin-left: 4px; }
.kpi.ok .v { color: var(--ok); }
.kpi .v.warn { color: var(--warn); }

.list-card { display: flex; flex-direction: column; }
.list-card .x-card-head { gap: 8px; flex-wrap: wrap; row-gap: 6px; }
/* 按钮一多就会把「账号列表」「自动同步」挤成竖排 —— 标题/提示和按钮都不许被压缩 */
.list-card .x-card-head h2,
.list-card .x-card-head .x-ic,
.list-card .x-card-head .live-hint,
.list-card .x-card-head > button { flex: 0 0 auto; white-space: nowrap; }
/* 备份按钮成组：跟随整行一起换行，不会被拆散 */
.head-tools { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; margin-left: 2px; }
.head-tools .x-mini { white-space: nowrap; }
.search { width: 180px; height: 30px; flex: 0 0 180px; font-size: 12px; }
.live-hint {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; color: var(--text-3); margin-right: 2px; white-space: nowrap;
}

table { width: 100%; border-collapse: collapse; font-size: 13px; table-layout: fixed; }
thead th {
  text-align: left; font-size: 11.5px; font-weight: 600; color: var(--text-3);
  padding: 8px 12px; background: rgba(10, 16, 23, 0.45); border-bottom: 1px solid var(--stroke);
  white-space: nowrap;
}
tbody td { padding: 7px 12px; border-bottom: 1px solid rgba(34, 48, 63, 0.55); vertical-align: middle; white-space: nowrap; }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover { background: rgba(44, 61, 80, 0.16); }

.env {
  font-family: var(--font-mono); font-size: 12px; color: var(--text-2);
  background: var(--bg3); padding: 2px 7px; border-radius: 6px;
}
.region-tag { margin-left: 5px; font-size: 9.5px; padding: 0 4px; }

.acct { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ava {
  width: 26px; height: 26px; border-radius: 50%; flex: 0 0 26px; overflow: hidden;
  background: linear-gradient(135deg, #2b3a4d, #1a2637);
  border: 1px solid var(--stroke-2);
  display: flex; align-items: center; justify-content: center;
  font-size: 9.5px; color: var(--text-2); font-weight: 650;
}
.ava img { width: 100%; height: 100%; object-fit: cover; display: block; }
.acct-text { min-width: 0; }
.acct .u {
  font-size: 13px; color: var(--text); display: flex; align-items: center; gap: 5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.acct .u .handle { font-size: 10.5px; color: var(--text-3); font-weight: 400; }
.acct .vf { width: 12px; height: 12px; stroke: var(--info); fill: none; stroke-width: 2; flex: 0 0 12px; }
.acct .m {
  font-size: 10px; color: var(--text-3);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cp { cursor: pointer; border-radius: 3px; }
.cp:hover { color: var(--brand); background: var(--brand-soft); box-shadow: 0 0 0 2px var(--brand-soft); }
.none { font-size: 11px; color: var(--text-3); opacity: 0.7; }

.pwd { display: flex; align-items: center; gap: 5px; }
.pwd .val { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-2); letter-spacing: 0.5px; }
.eye {
  background: none; border: none; padding: 2px; cursor: pointer; display: inline-flex;
  align-items: center; color: var(--text-3); flex: 0 0 auto;
}
.eye:hover { color: var(--brand); }
.eye svg { width: 13px; height: 13px; stroke: currentColor; fill: none; stroke-width: 1.7; }
.eye.all { margin-left: 4px; vertical-align: -2px; }
/* 没有密码时那一格的「+ 添加」按钮（比一行灰字「未导入」明确：这里能点） */
.add-cred {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font-size: 11px;
  color: var(--brand);
  background: transparent;
  border: 1px dashed color-mix(in srgb, var(--brand) 45%, transparent);
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s ease;
}
.add-cred:hover { background: color-mix(in srgb, var(--brand) 12%, transparent); }
.add-cred svg { width: 11px; height: 11px; stroke: currentColor; fill: none; stroke-width: 2; }
.cred-user { margin-left: 8px; font-size: 12px; font-weight: 400; color: var(--text-3); font-family: var(--font-mono); }

.toast {
  position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
  background: var(--bg3); border: 1px solid var(--stroke-2); color: var(--text);
  font-size: 12px; padding: 8px 14px; border-radius: 999px;
  box-shadow: var(--shadow-2); z-index: 80; max-width: 60vw;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.counts { display: flex; align-items: center; gap: 3px; font-family: var(--font-mono); font-size: 11px; color: var(--text-2); }.counts.mini { gap: 2px; font-size: 9.5px; color: var(--text-3); flex: 0 0 auto; margin-left: 8px; }
.counts i { color: var(--text-3); font-style: normal; opacity: 0.6; }
/* 资料新鲜度 + 「平台把头像换回了」标记（2026-10-20 用户报「资料不准、不及时」） */
.age.mini { margin-left: 8px; font-size: 9.5px; color: var(--text-3); flex: 0 0 auto; }
.age.mini.stale { color: var(--warn); }
.rev-badge {
  margin-left: 8px; padding: 0 5px; border-radius: 4px; font-size: 9.5px; line-height: 15px;
  color: var(--warn); background: color-mix(in srgb, var(--warn) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--warn) 34%, transparent); flex: 0 0 auto; cursor: help;
}
.muted { font-size: 11.5px; color: var(--text-3); }

.status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; }
.status i { width: 6px; height: 6px; border-radius: 50%; flex: 0 0 6px; }
.status.on { color: #7fe3c8; }
.status.on i { background: var(--ok); box-shadow: 0 0 0 3px rgba(45, 212, 167, 0.14); }
.status.off { color: #f3c377; }
.status.off i { background: var(--warn); box-shadow: 0 0 0 3px rgba(245, 165, 36, 0.14); }
.status.unknown { color: var(--text-3); }
.status.unknown i { background: var(--text-3); }

.ip { font-family: var(--font-mono); font-size: 9.5px; color: var(--text-3); display: block; overflow: hidden; text-overflow: ellipsis; }
.ip.sub { font-size: 9.5px; opacity: 0.75; margin-top: 1px; }

/* 最后发布时间：上面是日期时间，下面是「x 分钟前」 */
.pub { line-height: 1.25; }
.pub-at { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-2); }
.pub-ago { font-size: 9.5px; color: var(--text-3); opacity: 0.8; margin-top: 1px; }
.rowact { display: flex; gap: 5px; justify-content: flex-end; flex-wrap: nowrap; white-space: nowrap; }

/* ── 进度抽屉 ── */
.drawer {
  position: fixed; right: 22px; bottom: 18px; width: 360px; max-height: 46vh;
  background: var(--bg2); border: 1px solid var(--stroke-2); border-radius: var(--r-md);
  box-shadow: var(--shadow-2); overflow: hidden; display: flex; flex-direction: column; z-index: 50;
}
.dh {
  display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  border-bottom: 1px solid var(--stroke); font-size: 12.5px; font-weight: 600; color: var(--text);
}
.spin {
  width: 13px; height: 13px; border-radius: 50%; flex: 0 0 13px;
  border: 2px solid color-mix(in srgb, var(--brand) 30%, transparent); border-top-color: var(--brand-2);
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.done-ic svg { width: 14px; height: 14px; stroke: var(--ok); fill: none; stroke-width: 2.4; }
.dbtn {
  background: none; border: 1px solid var(--stroke-2); color: var(--text-2);
  font-size: 11.5px; padding: 3px 8px; border-radius: 6px; cursor: pointer;
}
.dbtn:hover { background: var(--bg3); color: var(--text); }
.dbtn { display: inline-flex; align-items: center; gap: 4px; }
.dbtn svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
.dbtn.copy:hover { color: var(--brand); border-color: color-mix(in srgb, var(--brand) 50%, transparent); }
.dbtn.danger { border-color: rgba(240, 81, 78, 0.4); color: #f0837f; }
.log {
  padding: 8px 12px; overflow-y: auto; font-family: var(--font-mono);
  font-size: 11px; line-height: 1.65; color: var(--text-2); flex: 1; min-height: 60px;
}
.logline { white-space: pre-wrap; word-break: break-word; }
.logline.ok { color: #7fe3c8; }
.logline.bad { color: #f0837f; }
.logline.warn { color: var(--warn); }
.logline.head { color: var(--text); font-weight: 600; margin-top: 4px; }
.bar { height: 3px; background: var(--bg3); }
.bar i { display: block; height: 100%; background: linear-gradient(90deg, var(--brand-1), var(--brand-2), var(--brand-3)); transition: width 0.4s; }
.dmsg { padding: 8px 12px; font-size: 11.5px; color: var(--text-3); border-top: 1px solid var(--stroke); }
/* ─── 单个编辑面板 / 批量弹窗 ─── */
.chk { width: 14px; height: 14px; accent-color: var(--brand); cursor: pointer; vertical-align: middle; }
.mask {
  position: fixed; inset: 0; background: rgba(4, 8, 12, 0.55); backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: flex-end; z-index: 60;
}
.panel {
  width: 420px; max-width: 92vw; height: 100%; background: var(--bg2);
  border-left: 1px solid var(--stroke-2); display: flex; flex-direction: column;
  box-shadow: -18px 0 40px rgba(0, 0, 0, 0.45); animation: slidein 0.18s ease-out;
}
.panel.wide { width: 560px; }
@keyframes slidein { from { transform: translateX(24px); opacity: 0.6; } to { transform: none; opacity: 1; } }
.ph {
  display: flex; align-items: center; gap: 8px; padding: 14px 16px;
  border-bottom: 1px solid var(--stroke);
}
.ph h3 { font-size: 14px; font-weight: 640; color: var(--text); margin: 0; flex: 1; }
.pbody { padding: 16px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; flex: 1; }
.pf {
  display: flex; align-items: center; gap: 8px; padding: 12px 16px;
  border-top: 1px solid var(--stroke); background: rgba(10, 16, 23, 0.4);
}
.frow { display: flex; flex-direction: column; gap: 6px; }
.frow > span { font-size: 11.5px; color: var(--text-3); }
.frow .x-input { width: 100%; }
.fhint { font-size: 11px; color: var(--text-3); margin: -4px 0 0; line-height: 1.5; }
.fhint code {
  font-family: var(--font-mono); font-size: 10.5px; color: var(--brand);
  background: color-mix(in srgb, var(--brand) 10%, transparent); padding: 1px 4px; border-radius: 4px;
}
.pava { display: flex; align-items: center; gap: 10px; }
.pava-act { display: flex; gap: 6px; }
.ava.big { width: 64px; height: 64px; flex: 0 0 64px; font-size: 18px; border-radius: 16px; }
.ava.sm { width: 44px; height: 44px; flex: 0 0 44px; font-size: 11px; border-radius: 12px; }
.picked {
  font-size: 10.5px; color: var(--text-2); font-family: var(--font-mono);
  background: var(--bg3); padding: 2px 6px; border-radius: 5px;
  max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.preview {
  border: 1px solid var(--stroke); border-radius: var(--r-md); overflow: hidden;
  background: rgba(10, 16, 23, 0.35); max-height: 220px; overflow-y: auto;
}
.pv-head { font-size: 11px; color: var(--text-3); padding: 7px 10px; border-bottom: 1px solid var(--stroke); }
.pv-head .pv-ava { color: var(--brand); }
.pv-row {
  display: grid; grid-template-columns: 54px 1fr 1fr; gap: 8px; align-items: center;
  padding: 6px 10px; font-size: 11.5px; border-bottom: 1px solid rgba(34, 48, 63, 0.4);
}
.pv-row:last-child { border-bottom: none; }
.pv-row b { font-family: var(--font-mono); font-size: 11px; color: var(--text-2); }
.pv-name { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pv-bio { color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pv-name.none, .pv-bio.none { color: var(--text-3); opacity: 0.5; }
.x-mini.hl { color: var(--brand); border-color: color-mix(in srgb, var(--brand) 50%, transparent); background: color-mix(in srgb, var(--brand) 10%, transparent); }
</style>
