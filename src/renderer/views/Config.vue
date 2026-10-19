<template>
  <div class="config-page">
    <!-- ===== 页面标题栏 ===== -->
    <div class="x-head">
      <h1>配置</h1>
      <span class="x-sub">API 密钥与成片参数</span>
      <div class="x-spacer"></div>
      <button class="x-btn" type="button" @click="restartApp">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20.5 12a8.5 8.5 0 1 1-3-6.5" />
          <path d="M20.5 3.5V9H15" />
        </svg>
        <span>重启应用</span>
      </button>
      <button class="x-btn primary" type="button" @click="save" :disabled="saving">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19.5 21h-15A1.5 1.5 0 0 1 3 19.5v-15A1.5 1.5 0 0 1 4.5 3H16l5 5v11.5A1.5 1.5 0 0 1 19.5 21z" />
          <path d="M17 21v-7.5H7V21" />
          <path d="M7.5 3v5h6.5" />
        </svg>
        <span>{{ saving ? '保存中…' : '保存配置' }}</span>
      </button>
    </div>

    <!-- 保存 / 校验反馈（原来在页面底部，保存按钮上移后跟着上移） -->
    <div v-if="errorMsg" class="x-tip warn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5v5.5" />
        <path d="M12 16.5h.01" />
      </svg>
      <span>{{ errorMsg }}</span>
    </div>
    <div v-if="saveMsg" class="x-tip ok-flash">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="m8.4 12.4 2.6 2.6 4.6-5.2" />
      </svg>
      <span>{{ saveMsg }}</span>
    </div>

    <!-- ===== AI 服务 ===== -->
    <section class="x-card">
      <div class="x-card-head">
        <span class="x-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3.2" />
            <path d="M12 2.6v2.3M12 19.1v2.3M2.6 12h2.3M19.1 12h2.3M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4 17 7M7 17l-1.6 1.6" />
          </svg>
        </span>
        <h2>AI 服务</h2>
        <span class="x-hint">文案 / 生图 / 素材</span>
        <div class="x-spacer"></div>
      </div>
      <div class="x-card-body">

        <!-- DeepSeek -->
        <div class="x-field wide-act">
          <span class="x-label">
            <b>DeepSeek</b>
            <span v-if="keyState.deepseek" class="x-tag ok">已配置</span>
            <span v-else class="x-tag warn">未配置</span>
          </span>
          <div class="stack">
            <input
              v-model="form.deepseekApiKey"
              :type="showKeys.deepseek ? 'text' : 'password'"
              placeholder="sk-...（文案生成）"
              class="x-input mono"
              @focus="onKeyFocus('deepseek', $event)"
              @input="markKeyEditing('deepseek')"
            />
            <div v-if="editing.deepseek" class="res-line">正在输入新 Key（不改动即保持原值）</div>
            <div v-if="validationErrors.deepseekApiKey" class="field-error">{{ validationErrors.deepseekApiKey }}</div>
            <div v-if="results.deepseek" class="res-line" :class="results.deepseek.ok ? 'ok' : 'err'">
              {{ results.deepseek.message }}
            </div>
          </div>
          <div class="x-actions">
            <button class="x-mini" type="button" @click="test('deepseek')" :disabled="testing.deepseek">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 3v5M15 3v5" />
                <path d="M6 8h12v5a6 6 0 0 1-12 0z" />
                <path d="M12 19v2" />
              </svg>
              <span>{{ testing.deepseek ? '测试中' : '测试' }}</span>
            </button>
            <button
              class="x-mini"
              type="button"
              @click="showKeys.deepseek = !showKeys.deepseek"
              aria-label="切换显示 DeepSeek Key"
            >
              <svg v-if="showKeys.deepseek" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2.6 12S6.2 5.6 12 5.6 21.4 12 21.4 12 17.8 18.4 12 18.4 2.6 12 2.6 12z" />
                <circle cx="12" cy="12" r="2.8" />
              </svg>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 3.5 20.5 21" />
                <path d="M10.6 5.9A9.8 9.8 0 0 1 12 5.8c5.8 0 9.4 6.2 9.4 6.2a16 16 0 0 1-2.6 3.4" />
                <path d="M6.5 7.3C4 9 2.6 12 2.6 12s3.6 6.2 9.4 6.2c1.2 0 2.3-.3 3.3-.7" />
                <path d="M9.9 10a2.9 2.9 0 0 0 4.1 4.1" />
              </svg>
            </button>
            <button
              v-if="keyState.deepseek && !editing.deepseek"
              class="x-mini hi"
              type="button"
              @click="resetKey('deepseek')"
            >更换</button>
          </div>
        </div>

        <!-- 硅基流动 -->
        <div class="x-field wide-act">
          <span class="x-label">
            <b>硅基流动</b>
            <span v-if="keyState.siliconflow" class="x-tag ok">已配置</span>
            <span v-else class="x-tag warn">未配置</span>
          </span>
          <div class="stack">
            <input
              v-model="form.siliconflowApiKey"
              :type="showKeys.siliconflow ? 'text' : 'password'"
              placeholder="sk-...（AI 生图）"
              class="x-input mono"
              @focus="onKeyFocus('siliconflow', $event)"
              @input="markKeyEditing('siliconflow')"
            />
            <div v-if="editing.siliconflow" class="res-line">正在输入新 Key（不改动即保持原值）</div>
            <div v-if="validationErrors.siliconflowApiKey" class="field-error">{{ validationErrors.siliconflowApiKey }}</div>
            <div v-if="results.siliconflow" class="res-line" :class="results.siliconflow.ok ? 'ok' : 'err'">
              {{ results.siliconflow.message }}
            </div>
          </div>
          <div class="x-actions">
            <button class="x-mini" type="button" @click="test('siliconflow')" :disabled="testing.siliconflow">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 3v5M15 3v5" />
                <path d="M6 8h12v5a6 6 0 0 1-12 0z" />
                <path d="M12 19v2" />
              </svg>
              <span>{{ testing.siliconflow ? '测试中' : '测试' }}</span>
            </button>
            <button
              class="x-mini"
              type="button"
              @click="showKeys.siliconflow = !showKeys.siliconflow"
              aria-label="切换显示硅基流动 Key"
            >
              <svg v-if="showKeys.siliconflow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2.6 12S6.2 5.6 12 5.6 21.4 12 21.4 12 17.8 18.4 12 18.4 2.6 12 2.6 12z" />
                <circle cx="12" cy="12" r="2.8" />
              </svg>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 3.5 20.5 21" />
                <path d="M10.6 5.9A9.8 9.8 0 0 1 12 5.8c5.8 0 9.4 6.2 9.4 6.2a16 16 0 0 1-2.6 3.4" />
                <path d="M6.5 7.3C4 9 2.6 12 2.6 12s3.6 6.2 9.4 6.2c1.2 0 2.3-.3 3.3-.7" />
                <path d="M9.9 10a2.9 2.9 0 0 0 4.1 4.1" />
              </svg>
            </button>
            <button
              v-if="keyState.siliconflow && !editing.siliconflow"
              class="x-mini hi"
              type="button"
              @click="resetKey('siliconflow')"
            >更换</button>
          </div>
        </div>

        <!-- Pexels -->
        <div class="x-field wide-act">
          <span class="x-label">
            <b>Pexels</b>
            <span v-if="form.pexelsApiKey" class="x-tag ok">已配置</span>
            <span v-else class="x-tag warn">未配置</span>
          </span>
          <div class="stack">
            <input
              v-model="form.pexelsApiKey"
              :type="showKeys.pexels ? 'text' : 'password'"
              placeholder="粘贴 pexels.com/api 获取的 Key（真实素材搜索）"
              class="x-input mono"
            />
            <div v-if="validationErrors.pexelsApiKey" class="field-error">{{ validationErrors.pexelsApiKey }}</div>
            <div v-if="results.pexels" class="res-line" :class="results.pexels.ok ? 'ok' : 'err'">
              {{ results.pexels.message }}
            </div>
          </div>
          <div class="x-actions">
            <button class="x-mini" type="button" @click="test('pexels')" :disabled="testing.pexels">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 3v5M15 3v5" />
                <path d="M6 8h12v5a6 6 0 0 1-12 0z" />
                <path d="M12 19v2" />
              </svg>
              <span>{{ testing.pexels ? '测试中' : '测试' }}</span>
            </button>
            <button
              class="x-mini"
              type="button"
              @click="showKeys.pexels = !showKeys.pexels"
              aria-label="切换显示 Pexels Key"
            >
              <svg v-if="showKeys.pexels" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2.6 12S6.2 5.6 12 5.6 21.4 12 21.4 12 17.8 18.4 12 18.4 2.6 12 2.6 12z" />
                <circle cx="12" cy="12" r="2.8" />
              </svg>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 3.5 20.5 21" />
                <path d="M10.6 5.9A9.8 9.8 0 0 1 12 5.8c5.8 0 9.4 6.2 9.4 6.2a16 16 0 0 1-2.6 3.4" />
                <path d="M6.5 7.3C4 9 2.6 12 2.6 12s3.6 6.2 9.4 6.2c1.2 0 2.3-.3 3.3-.7" />
                <path d="M9.9 10a2.9 2.9 0 0 0 4.1 4.1" />
              </svg>
            </button>
          </div>
        </div>

        <!-- 原 hint-block 合并成卡片底部一条提示条（含 Pexels 额度说明，必须准确：
             旧文案写「月 200 次」，实际免费额度是每小时 200 次 / 每月 20000 次，
             按旧文案会让人以为只够做十几条视频，直接放弃这个功能） -->
        <div class="x-tip">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v5.5" />
            <path d="M12 7.6h.01" />
          </svg>
          <span>
            DeepSeek 负责文案、硅基流动负责 AI 生图、Pexels 负责真实素材搜索。
            硅基流动注册 cloud.siliconflow.cn（新用户送 14 元）；Pexels 注册 pexels.com/api（免费，额度每小时 200 次 / 每月 20000 次，一条 9 镜视频约消耗 18 次请求）。
            已配置的 Key 显示为掩码（前 6 位 + **** + 后 4 位），不改动即保持原值；要换 Key 点「更换」清空后重新输入。
            DeepSeek / 硅基流动的「测试」用主进程已保存的密钥，新填的 Key 需先保存再测试。
          </span>
        </div>
      </div>
    </section>

    <!-- ===== 成片效果 ===== -->
    <section class="x-card">
      <div class="x-card-head">
        <span class="x-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
            <path d="M3 9.5h18M8 4.5v5M16 4.5v5" />
            <path d="m11 12.6 3.2 2.4-3.2 2.4z" />
          </svg>
        </span>
        <h2>成片效果</h2>
        <span class="x-hint">开场镜 / 配音 / 截图素材</span>
        <div class="x-spacer"></div>
      </div>
      <div class="x-card-body">
        <div class="x-field">
          <span class="x-label"><b>开场镜</b></span>
          <div class="switch-line">
            <div
              class="x-switch"
              :class="{ on: form.heroI2V }"
              role="switch"
              :aria-checked="form.heroI2V"
              @click="form.heroI2V = !form.heroI2V"
            ><i></i></div>
            <span class="switch-text">{{ form.heroI2V ? 'AI 图生视频（Wan2.2，走硅基流动 Key）' : '全片用免费实拍素材 + 运镜' }}</span>
          </div>
        </div>

        <div class="x-field">
          <span class="x-label"><b>配音语言</b></span>
          <select v-model="form.voiceLang" class="x-select">
            <option value="auto">自动（跟字幕语言）</option>
            <option value="zh">中文（读中文文案）</option>
            <option value="en">English（读英文文案）</option>
          </select>
        </div>

        <div class="x-field">
          <span class="x-label"><b>我的截图目录</b></span>
          <input type="text" v-model="form.materialsDir" placeholder="留空则用图库素材" class="x-input mono" />
          <div class="x-actions">
            <button class="x-mini" type="button" @click="pickMaterials" :disabled="picking">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2.5h9A1.5 1.5 0 0 1 21.5 10v8A1.5 1.5 0 0 1 20 19.5H4.5A1.5 1.5 0 0 1 3 18z" />
              </svg>
              <span>{{ picking ? '选择中' : '选择' }}</span>
            </button>
          </div>
        </div>

        <!-- 原来的 long hint 全文搬到这里 -->
        <div class="x-tip warn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.3 4.3 2.8 17.5A1.7 1.7 0 0 0 4.3 20h15.4a1.7 1.7 0 0 0 1.5-2.5L13.7 4.3a1.9 1.9 0 0 0-3.4 0z" />
            <path d="M12 9.5v4" />
            <path d="M12 16.6h.01" />
          </svg>
          <span>
            关闭开场镜（默认）：全片用免费实拍素材 + 运镜，成本约 <b>¥0.01/条</b>。<br />
            开启开场镜：单条多花约 <b>¥1–2</b>；失败会自动回退，不影响出片。<br />
            <b>我的截图目录</b>：把 png/jpg 放进去，按文件名顺序依次作为分镜画面（图不够会循环用）。
            这是最"贴切"的方式——自己的后台、学员反馈、收款页面都能直接上视频，且不额外花钱。
          </span>
        </div>
      </div>
    </section>

    <!-- ===== 推送 ===== -->
    <section class="x-card">
      <div class="x-card-head">
        <span class="x-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 4 11.6 20.4l-2.1-6.9L2.6 11.4z" />
            <path d="m9.5 13.5 4.2-4.2" />
          </svg>
        </span>
        <h2>推送</h2>
        <span class="x-hint">出片后发到 Telegram</span>
        <div class="x-spacer"></div>
      </div>
      <div class="x-card-body">
        <div class="x-field wide-act">
          <span class="x-label">
            <b>Bot Token</b>
            <span v-if="form.tgBotToken" class="x-tag ok">已配置</span>
            <span v-else class="x-tag mute">未配置</span>
          </span>
          <div class="stack">
            <input
              v-model="form.tgBotToken"
              :type="showKeys.tg ? 'text' : 'password'"
              placeholder="123456:ABC-DEF..."
              class="x-input mono"
            />
            <div v-if="validationErrors.tgBotToken" class="field-error">{{ validationErrors.tgBotToken }}</div>
            <div v-if="results.tg" class="res-line" :class="results.tg.ok ? 'ok' : 'err'">
              {{ results.tg.message }}
            </div>
          </div>
          <div class="x-actions">
            <button class="x-mini" type="button" @click="test('tg')" :disabled="testing.tg">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 3v5M15 3v5" />
                <path d="M6 8h12v5a6 6 0 0 1-12 0z" />
                <path d="M12 19v2" />
              </svg>
              <span>{{ testing.tg ? '测试中' : '测试' }}</span>
            </button>
            <button
              class="x-mini"
              type="button"
              @click="showKeys.tg = !showKeys.tg"
              aria-label="切换显示 TG Token"
            >
              <svg v-if="showKeys.tg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2.6 12S6.2 5.6 12 5.6 21.4 12 21.4 12 17.8 18.4 12 18.4 2.6 12 2.6 12z" />
                <circle cx="12" cy="12" r="2.8" />
              </svg>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 3.5 20.5 21" />
                <path d="M10.6 5.9A9.8 9.8 0 0 1 12 5.8c5.8 0 9.4 6.2 9.4 6.2a16 16 0 0 1-2.6 3.4" />
                <path d="M6.5 7.3C4 9 2.6 12 2.6 12s3.6 6.2 9.4 6.2c1.2 0 2.3-.3 3.3-.7" />
                <path d="M9.9 10a2.9 2.9 0 0 0 4.1 4.1" />
              </svg>
            </button>
          </div>
        </div>

        <div class="x-field">
          <span class="x-label"><b>频道 ID</b></span>
          <input v-model="form.tgChannelId" placeholder="@your_channel" class="x-input mono" />
        </div>
      </div>
    </section>

    <!-- ===== 指纹浏览器（FoxProfile） ===== -->
    <section class="x-card">
      <div class="x-card-head">
        <span class="x-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18" />
            <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z" />
          </svg>
        </span>
        <h2>指纹浏览器</h2>
        <span class="x-hint">FoxProfile 接口</span>
        <div class="x-spacer"></div>
      </div>
      <div class="x-card-body">
        <div class="x-field">
          <span class="x-label"><b>接口地址</b></span>
          <input v-model="form.foxApiBase" placeholder="http://127.0.0.1:8000/api/v1" class="x-input mono" />
        </div>

        <div class="x-field">
          <span class="x-label">
            <b>CDP 端口</b>
            <span class="x-tag mute">旧版直连</span>
          </span>
          <input v-model="form.cdpEndpoint" placeholder="http://localhost:9222" class="x-input mono" />
        </div>

        <!-- 指纹浏览器连接测试（原来在页面下方单独一块，并入本卡片） -->
        <div class="x-field wide-act">
          <span class="x-label">
            <b>连接状态</b>
            <span v-if="results.bit && results.bit.ok" class="x-tag ok">已连通</span>
            <span v-else-if="results.bit" class="x-tag danger">连接失败</span>
            <span v-else class="x-tag mute">未测试</span>
          </span>
          <div class="stack">
            <span v-if="foxProfiles.length" class="res-line">{{ foxProfiles.length }} 个环境可用</span>
            <span v-if="results.bit" class="res-line" :class="results.bit.ok ? 'ok' : 'err'">{{ results.bit.message }}</span>
            <span v-if="!results.bit && foxLoadError" class="res-line err">{{ foxLoadError }}</span>
          </div>
          <div class="x-actions">
            <button class="x-mini hi" type="button" @click="testBit" :disabled="testing.bit">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 3v5M15 3v5" />
                <path d="M6 8h12v5a6 6 0 0 1-12 0z" />
                <path d="M12 19v2" />
              </svg>
              <span>{{ testing.bit ? '测试中' : '测试连接' }}</span>
            </button>
            <button class="x-mini" type="button" @click="loadFoxProfiles" title="刷新环境列表">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 12a8 8 0 1 1-2.4-5.7" />
                <path d="M20 4.5V10h-5.5" />
              </svg>
            </button>
          </div>
        </div>

        <!-- 原来的 hint-block 全文搬到这里 -->
        <div class="x-tip">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v5.5" />
            <path d="M12 7.6h.01" />
          </svg>
          <span>
            FoxProfile 启动后会在本机开一个接口（默认 8000 端口），采集时由它自动打开对应环境。
            保存配置后点上面的「测试连接」确认能连上。CDP 端口只给旧版直连浏览器用，Camoufox 没有 CDP，一般留空即可。
          </span>
        </div>
      </div>
    </section>

    <!-- ===== 采集账号 ===== -->
    <section class="x-card">
      <div class="x-card-head">
        <span class="x-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="9.5" cy="8.5" r="3.5" />
            <path d="M3 20v-1.2A4.8 4.8 0 0 1 7.8 14h3.4a4.8 4.8 0 0 1 4.8 4.8V20" />
            <path d="M17 5.2a3.4 3.4 0 0 1 0 6.6" />
            <path d="M18.4 14.2A4.6 4.6 0 0 1 21 18.6V20" />
          </svg>
        </span>
        <h2>采集账号</h2>
        <span class="x-hint">每个账号绑一个 FoxProfile 环境</span>
        <div class="x-spacer"></div>
        <span v-if="foxProfiles.length" class="x-tag mute">{{ foxProfiles.length }} 个环境</span>
      </div>
      <div class="x-card-body">
        <div class="account-list">
          <div v-for="(acc, i) in form.accounts" :key="i" class="account-row">
            <input v-model="acc.name" placeholder="账号名称（如：主号）" class="x-input acc-name" />
            <select v-model="acc.platform" class="x-select acc-platform">
              <option value="tiktok">TikTok</option>
              <option value="xiaohongshu">小红书</option>
              <option value="facebook">Facebook</option>
              <option value="instagram">Instagram</option>
              <option value="youtube">YouTube</option>
              <option value="x">X (Twitter)</option>
            </select>
            <select v-model="acc.bitEnvId" class="x-select acc-env">
              <option value="">未指定环境</option>
              <option v-for="p in foxProfiles" :key="p.name" :value="p.name">
                {{ p.name }}{{ p.running ? '（运行中）' : '' }}
              </option>
              <!-- 配置里存在但环境列表没有的旧值，保留显示，避免一保存就被清空 -->
              <option v-if="acc.bitEnvId && !foxProfiles.some(p => p.name === acc.bitEnvId)" :value="acc.bitEnvId">
                {{ acc.bitEnvId }}（环境不存在）
              </option>
            </select>
            <button class="x-mini del" type="button" @click="removeAccount(i)" title="删除" aria-label="删除账号">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        </div>

        <div class="acc-foot">
          <button class="x-mini" type="button" @click="addAccount">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 5.5v13M5.5 12h13" />
            </svg>
            <span>添加账号</span>
          </button>
        </div>

        <!-- 原来的 section-desc 全文搬到这里 -->
        <div class="x-tip">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v5.5" />
            <path d="M12 7.6h.01" />
          </svg>
          <span>通过 FoxProfile 指纹浏览器自动打开环境采集数据（每个账号绑一个环境）。环境下拉里选的就是 FoxProfile 里的环境名，读不到列表时先到上面「测试连接」。</span>
        </div>
      </div>
    </section>

    <!-- ===== 数据与迁移 ===== -->
    <section class="x-card">
      <div class="x-card-head">
        <span class="x-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2.5h9A1.5 1.5 0 0 1 21.5 10v8A1.5 1.5 0 0 1 20 19.5H4.5A1.5 1.5 0 0 1 3 18z" />
            <path d="M3 10.5h18.5" />
          </svg>
        </span>
        <h2>数据与迁移</h2>
        <span class="x-hint">视频 / 配置 / 数据库</span>
        <div class="x-spacer"></div>
      </div>
      <div class="x-card-body">
        <div class="x-field">
          <span class="x-label"><b>当前数据目录</b></span>
          <input :value="currentDataDir" disabled class="x-input mono dir-path-input" />
          <div class="x-actions">
            <button class="x-mini hi" type="button" @click="selectDir" title="选择新目录">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2.5h9A1.5 1.5 0 0 1 21.5 10v8A1.5 1.5 0 0 1 20 19.5H4.5A1.5 1.5 0 0 1 3 18z" />
              </svg>
              <span>选择</span>
            </button>
          </div>
        </div>

        <div v-if="selectedDir" class="new-dir-box">
          <p class="new-dir-label">新目录</p>
          <p class="new-dir-path">{{ selectedDir }}</p>
          <button class="x-btn primary" type="button" @click="startMigrate" :disabled="migrating">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3.5 20 8v8l-8 4.5L4 16V8z" />
              <path d="M4 8l8 4.5L20 8M12 12.5V20.5" />
            </svg>
            <span>{{ migrating ? '迁移中…' : '迁移数据到新目录' }}</span>
          </button>
          <div v-if="migrateDone" class="migrate-actions">
            <p class="migrate-hint">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                <path d="m5 12.5 4.5 4.5L19 7.5" />
              </svg>
              <span>迁移完成，请重启应用生效</span>
            </p>
            <button class="x-btn" type="button" @click="restartApp">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20.5 12a8.5 8.5 0 1 1-3-6.5" />
                <path d="M20.5 3.5V9H15" />
              </svg>
              <span>立即重启</span>
            </button>
          </div>
        </div>

        <!-- 原来的 section-desc 全文搬到这里（迁移属于风险操作，用 warn 样式） -->
        <div class="x-tip warn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.3 4.3 2.8 17.5A1.7 1.7 0 0 0 4.3 20h15.4a1.7 1.7 0 0 0 1.5-2.5L13.7 4.3a1.9 1.9 0 0 0-3.4 0z" />
            <path d="M12 9.5v4" />
            <path d="M12 16.6h.01" />
          </svg>
          <span>产出视频、配置、数据库等所有数据的存储目录（迁移后需重启生效）。迁移过程中不要关闭程序，完成后按提示重启。</span>
        </div>
      </div>
    </section>

    <!-- 版本号：不显示的话分不清装的是哪个包（踩过：跑了三个月的旧版还在以为是最新） -->
    <div class="version-line">当前版本 v{{ appVersionText || '—' }}</div>
  </div>
</template>

<script setup>
import { reactive, ref, onMounted } from 'vue'
import { useAppStore } from '../stores/app.js'

const store = useAppStore()
const form = reactive({
  deepseekApiKey: '',
  siliconflowApiKey: '',
  pexelsApiKey: '',
  tgBotToken: '',
  tgChannelId: '@your_channel',
  cdpEndpoint: 'http://localhost:9222',
  bitApiKey: '',
  browserType: 'foxprofile',
  foxApiBase: 'http://127.0.0.1:8000/api/v1',
  dataDir: '',
  // 开场镜图生视频：默认关闭（唯一会额外花钱的开关，不能默认开）
  heroI2V: false,
  // 配音语言：auto = 跟字幕语言（旧行为）
  voiceLang: 'auto',
  // 用户自带截图目录
  materialsDir: '',
  accounts: [],
})
const testing = reactive({ deepseek: false, siliconflow: false, pexels: false, tg: false, bit: false })
const results = reactive({ deepseek: null, siliconflow: null, pexels: null, tg: null, bit: null })
const showKeys = reactive({ deepseek: false, siliconflow: false, pexels: false, tg: false, bitKey: false })
// FoxProfile 环境列表（给账号下拉用）
const foxProfiles = ref([])
const foxLoadError = ref('')
const saving = ref(false)
const errorMsg = ref('')
const validationErrors = reactive({})
const currentDataDir = ref('')
const selectedDir = ref('')
const migrating = ref(false)
const migrateDone = ref(false)

// ===== 掩码 API Key 状态（P1-8 S4）=====
// 主进程下发的 deepseekApiKey / siliconflowApiKey 是掩码（前 6 位 + **** + 后 4 位），
// 并额外给出 hasXxxApiKey 布尔字段表示"是否已配置"。
// 前端规则：默认显示掩码；用户不改动就原样回传掩码（主进程会忽略等于掩码的值）；
// 想换 Key 必须显式点「重新设置密钥」清空输入框。
const keyState = reactive({ deepseek: false, siliconflow: false })
const editing = reactive({ deepseek: false, siliconflow: false })
const maskSnapshot = reactive({ deepseek: '', siliconflow: '' })

const KEY_FIELDS = { deepseek: 'deepseekApiKey', siliconflow: 'siliconflowApiKey' }

// 是否是掩码值（含 * 或是刚下发的掩码快照）——判重/校验时要跳过
function isMaskValue(name, v) {
  return !!v && (String(v).includes('*') || v === maskSnapshot[name])
}

function applyKeyState(config) {
  const c = config || {}
  // 兼容尚未实现 hasXxxApiKey 的主进程版本：掩码非空同样视为"已配置"
  keyState.deepseek = typeof c.hasDeepseekApiKey === 'boolean' ? c.hasDeepseekApiKey : !!c.deepseekApiKey
  keyState.siliconflow = typeof c.hasSiliconflowApiKey === 'boolean' ? c.hasSiliconflowApiKey : !!c.siliconflowApiKey
  maskSnapshot.deepseek = c.deepseekApiKey || ''
  maskSnapshot.siliconflow = c.siliconflowApiKey || ''
  editing.deepseek = false
  editing.siliconflow = false
}

// 聚焦时若仍是掩码则全选，用户直接输入即可整体替换，避免把新字符拼进掩码
function onKeyFocus(name, e) {
  if (editing[name] || !e || !e.target) return
  if (isMaskValue(name, e.target.value)) e.target.select()
}

function markKeyEditing(name) {
  editing[name] = true
}

// 「重新设置密钥」：清空输入框让用户输入新值（掩码不能被当成真实值提交）
function resetKey(name) {
  form[KEY_FIELDS[name]] = ''
  editing[name] = true
  showKeys[name] = true
}

const FIELD_LABELS = {
  deepseekApiKey: 'DeepSeek API Key',
  siliconflowApiKey: '硅基流动 API Key',
  pexelsApiKey: 'Pexels API Key',
  tgBotToken: 'Telegram Bot Token',
  tgChannelId: 'Telegram 频道 ID',
  cdpEndpoint: 'CDP 端口',
}

function validate() {
  for (const k of Object.keys(validationErrors)) delete validationErrors[k]
  // 掩码值不参与格式校验（它本来就不是真实 Key）
  if (form.deepseekApiKey && !isMaskValue('deepseek', form.deepseekApiKey) && !form.deepseekApiKey.startsWith('sk-')) {
    validationErrors.deepseekApiKey = 'DeepSeek Key 通常以 sk- 开头'
  }
  if (form.siliconflowApiKey && !isMaskValue('siliconflow', form.siliconflowApiKey) && form.siliconflowApiKey.length < 8) {
    validationErrors.siliconflowApiKey = 'API Key 长度不足，请检查'
  }
  if (form.tgBotToken && !/^\d+:[\w-]+$/.test(form.tgBotToken)) {
    validationErrors.tgBotToken = 'Token 格式应为 123456:ABC-DEF...'
  }
  if (form.pexelsApiKey && form.pexelsApiKey.length < 10) {
    validationErrors.pexelsApiKey = 'Key 长度不足，请检查'
  }
  return Object.keys(validationErrors).length === 0
}

onMounted(async () => {
  // 首个 await 抛错不能阻断后面的初始化（P2-3）
  try {
    const config = await window.xnowpost.getConfig()
    // hasXxxApiKey / appVersion 是主进程下发的派生字段，只用于 UI 判断，不回写进表单/配置文件
    const { hasDeepseekApiKey, hasSiliconflowApiKey, appVersion, ...rest } = config || {}
    Object.assign(form, rest)
    if (appVersion) appVersionText.value = appVersion
    applyKeyState(config)
  } catch (e) {
    errorMsg.value = '读取配置失败: ' + ((e && e.message) || e)
  }
  try {
    const dirResult = await window.xnowpost.getDataDir()
    currentDataDir.value = dirResult.path
  } catch (_) {}
  // 拉一次 FoxProfile 环境列表填充下拉（连不上就提示，不阻断页面）
  loadFoxProfiles()
})

// 读取 FoxProfile 环境列表（下拉选项）
async function loadFoxProfiles() {
  foxLoadError.value = ''
  try {
    const r = await window.xnowpost.listFoxProfiles()
    if (r && r.ok) {
      foxProfiles.value = r.list || []
    } else {
      foxProfiles.value = []
      foxLoadError.value = `读取环境列表失败：${(r && r.message) || '未知错误'}（请确认 FoxProfile 已启动）`
    }
  } catch (e) {
    foxProfiles.value = []
    foxLoadError.value = '读取环境列表失败: ' + ((e && e.message) || e)
  }
}

const saveMsg = ref('')
const appVersionText = ref('')
const picking = ref(false)

// 选「我的截图目录」：复用主进程的目录选择器，只换个标题
async function pickMaterials() {
  picking.value = true
  try {
    const r = await window.xnowpost.selectDataDir({ title: '选择存放截图的文件夹' })
    if (r && r.ok && r.path) form.materialsDir = r.path
  } catch (e) {
    errorMsg.value = '选择目录失败: ' + ((e && e.message) || e)
  } finally {
    picking.value = false
  }
}

function addAccount() {
  form.accounts.push({ name: '', platform: 'tiktok', bitEnvId: '' })
}

function removeAccount(i) {
  form.accounts.splice(i, 1)
}

async function save() {
  if (!validate()) {
    errorMsg.value = '请修正标红的字段后再保存'
    return
  }
  saving.value = true
  errorMsg.value = ''
  saveMsg.value = ''
  try {
    const payload = JSON.parse(JSON.stringify(form))
    // 用户点了「重新设置密钥」却没填新值 → 回传原掩码，避免把已保存的 Key 误清空
    if (editing.deepseek && !payload.deepseekApiKey) payload.deepseekApiKey = maskSnapshot.deepseek
    if (editing.siliconflow && !payload.siliconflowApiKey) payload.siliconflowApiKey = maskSnapshot.siliconflow
    // 其余情况原样回传掩码即可（主进程会把"等于掩码的值"视为用户没改）
    await store.saveConfig(payload)
    // 保存成功后重新拉取配置：把刚输入的明文 Key 换回掩码，并刷新"已配置"状态
    try {
      const latest = await window.xnowpost.getConfig()
      form.deepseekApiKey = latest.deepseekApiKey || ''
      form.siliconflowApiKey = latest.siliconflowApiKey || ''
      applyKeyState(latest)
    } catch (_) {}
    saveMsg.value = '✅ 配置已保存'
    setTimeout(() => (saveMsg.value = ''), 3000)
  } catch (e) {
    errorMsg.value = '保存失败: ' + (e.message || e)
    setTimeout(() => (errorMsg.value = ''), 5000)
  }
  saving.value = false
}

async function test(type) {
  testing[type] = true
  results[type] = null
  errorMsg.value = ''
  try {
    if (type === 'deepseek' || type === 'siliconflow') {
      // 这两个 Key 前端只有掩码，不能拿去测试：
      // 主进程会自己读取已保存的真实密钥做连通性测试（S4 掩码契约）。
      // 注意：未保存的新 Key 不会被测试到，需先保存再点测试。
      results[type] = await window.xnowpost.testApi(type)
    } else {
      // Pexels / TG Token 未做掩码，仍按原逻辑传值（主进程优先用传入值，否则回退已保存配置）
      const keyMap = { pexels: 'pexelsApiKey', tg: 'tgBotToken' }
      results[type] = await window.xnowpost.testApi(type, form[keyMap[type]] || '')
    }
  } catch (e) {
    results[type] = { ok: false, message: 'IPC 调用失败: ' + (e.message || e) }
  }
  testing[type] = false
}

async function testBit() {
  testing.bit = true
  results.bit = null
  try {
    results.bit = await window.xnowpost.testBit(form.bitApiKey || undefined)
  } catch (e) {
    results.bit = { ok: false, message: '调用失败: ' + (e.message || e) }
  }
  testing.bit = false
  // 顺便刷新环境下拉，省得用户再点一次刷新
  if (results.bit && results.bit.ok) loadFoxProfiles()
}

// === 数据目录 ===
async function selectDir() {
  errorMsg.value = ''
  const result = await window.xnowpost.selectDataDir()
  if (result.ok && result.path) {
    selectedDir.value = result.path
    migrateDone.value = false
  }
}

async function startMigrate() {
  if (!selectedDir.value) return
  migrating.value = true
  errorMsg.value = ''
  migrateDone.value = false
  try {
    const result = await window.xnowpost.migrateData(selectedDir.value)
    if (result.ok) {
      migrateDone.value = true
      currentDataDir.value = selectedDir.value  // 显示迁移后的目录（重启后生效）
    } else {
      errorMsg.value = result.message || '迁移失败'
    }
  } catch (e) {
    errorMsg.value = '迁移失败: ' + (e.message || e)
  }
  migrating.value = false
}

function restartApp() {
  window.xnowpost.restartApp()
}
</script>

<style scoped>
/* 页面容器：卡片之间 14px */
.config-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 字段里的「控件 + 结果/错误提示」竖排 */
.stack {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

/* 带两枚以上操作按钮的行：操作列放宽（theme 默认 96px 只够放一枚） */
.x-field.wide-act {
  grid-template-columns: 150px minmax(0, 1fr) 172px;
}

/* 测试结果 / 状态文字 */
.res-line {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-3);
  word-break: break-word;
}
.res-line.ok { color: var(--ok); }
.res-line.err { color: var(--danger); }

.field-error {
  font-size: 11px;
  color: var(--danger);
  padding-left: 1px;
}

/* 开关行 */
.switch-line {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.switch-text {
  font-size: 12.5px;
  color: var(--text-2);
}

/* 保存成功提示条（错误提示直接用 theme 的 .x-tip.warn） */
.x-tip.ok-flash {
  background: var(--ok-soft);
  border-color: rgba(45, 212, 167, 0.24);
  color: var(--ok);
}
.x-tip.ok-flash svg { stroke: var(--ok); }
.x-tip b { color: var(--text); font-weight: 600; }

/* 采集账号 */
.account-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 6px;
}
.account-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: var(--bg1);
  border: 1px solid var(--stroke);
  border-radius: var(--r-sm);
}
.acc-name { flex: 2 1 0; min-width: 88px; }
.acc-platform { flex: 1 1 0; min-width: 96px; }
.acc-env { flex: 1.4 1 0; min-width: 92px; }
.acc-foot { padding: 10px 0 2px; }
.x-mini.del { color: var(--text-3); }
.x-mini.del:hover {
  color: var(--danger);
  background: var(--danger-soft);
  border-color: rgba(240, 81, 78, 0.42);
}

/* 数据目录与迁移 */
.dir-path-input { color: var(--text-2); }
.dir-path-input:disabled {
  opacity: 1;
  background: var(--bg3);
  cursor: default;
}
.new-dir-box {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  margin: 10px 0 4px;
  padding: 12px 14px;
  background: var(--bg3);
  border: 1px solid var(--stroke-2);
  border-radius: var(--r-sm);
}
.new-dir-label {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-3);
}
.new-dir-path {
  margin: 0;
  font-size: 12.5px;
  color: var(--text);
  font-family: var(--font-mono);
  word-break: break-all;
}
.migrate-actions {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
.migrate-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 12.5px;
  color: var(--ok);
}
.migrate-hint svg {
  width: 14px;
  height: 14px;
  stroke: currentColor;
  fill: none;
  stroke-width: 1.9;
}

/* 版本号 */
.version-line {
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-3);
  text-align: center;
  letter-spacing: 0.3px;
}

</style>
