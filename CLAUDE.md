# XNOWPost 项目规则

> 接手/接力开发先看 **`.claude/PROGRESS.md` 顶部「接力开发」**：当前版本、本轮做了什么、
> 待办优先级、部署与验收命令都在那里。本文件只写「为什么这么做、踩过什么坑」。
>
> git 提醒：HEAD 停在 `1.2.18`，工作区已到 `1.6.0`（55 改 + 83 未跟踪）。**别 `git checkout -- .` / `git stash`**。

## 界面：一套设计变量 + 一套通用组件类（新页面必须遵守）
- 变量和通用 class 全在 `src/renderer/styles/theme.css`（`main.js` 里 import，全局生效）。
- **颜色只留一个品牌色** `--brand: #FF2E5B`（TikTok 粉）；`--ok/--warn/--danger` **只用来表示状态**，
  不要拿来做装饰性强调色。写死色值（`#1e293b`、`#334155`…）是新旧界面观感割裂的主因。
- 组件类：`.x-card / .x-card-head / .x-field / .x-input / .x-select / .x-mini / .x-btn /
  .x-tag / .x-tip / .x-switch / .x-head / .x-empty`。新页面直接拼这些，不要再自己造一套。
- 图标用内联 SVG（`fill:none; stroke:currentColor; stroke-width:1.7~1.8`），不要再堆 emoji。
- 字段行固定三栏（标签 150px / 控件自适应 / 操作 96px），说明文字收进卡片底部 `.x-tip`，
  正文只留短标签 —— 长句平铺会把视觉重心全打散。
- 新增页面步骤：`src/renderer/views/Xxx.vue` + `router/index.js` 加一条 + `App.vue` 侧栏加导航项。
- 界面改完怎么验收：`npm run package` 之后 robocopy `release\win-unpacked` → 安装目录，重启应用，
  再用 `scripts\win-shot.ps1 -Out output\shot.png` 抓窗口位图（PrintWindow+PW_RENDERFULLCONTENT，
  Electron 不会黑屏）；`-ClickX/-ClickY`（窗口内相对坐标）可以点导航切页再抓一张。
  没有这个工具就只能靠用户口述，验收会很慢。
- **改配置页后必须回归「保存配置」**：点保存后看 `%APPDATA%\xnowpost\config\user.json` 的
  mtime 有没有变，变了才算真写进去（按钮文案变化不可靠）。

## 账号页（批量登录的界面入口）
- `src/renderer/views/Accounts.vue`（路由 `/accounts`）读三个来源：
  FoxProfile `GET /profiles`（环境/代理）、`GET /profiles/{env}/cookies?format=json`（登录态）、
  `%APPDATA%\xnowpost\data\env-accounts.json`（用户名映射）。
- 登录动作**不重写逻辑**：IPC `accounts:run` 只是 spawn `scripts/tk-login-batch.mjs`
  并把 stdout 流给界面（`accounts:progress`）。命令行和界面永远是同一份实现。
  `ELECTRON_RUN_AS_NODE=1` + `process.execPath` 才能在打包后跑（Electron 自带 node）。
- 打包相关：`electron-builder.yml` 的 `files` 必须含 `scripts/tk-login-batch.mjs`，
  且 `asarUnpack` 必须含 `scripts/**`（asar 里的文件不能直接 spawn）。
- 收件箱/截图/备份/报告在打包版走数据目录（`XNOWPOST_INBOX` 等环境变量覆盖），
  不写到安装目录 —— 装在 Program Files 里会因无权限失败。
- 登录态判定：主进程直接读 `<环境目录>/cookies.sqlite`（`node:sqlite`，毫秒级）。
  **别用 `GET /profiles/{env}/cookies` 查状态**——那个接口每调一次约 4 秒（FoxProfile 要拉进程导出），
  10 个环境就是 40 秒，界面等不起；它只用于「备份 cookie」。
  Electron 43 自带 Node 24.17，`node:sqlite` 免开关可用（已实测）。
- **界面必须轮询**（6 秒一次，`document.visibilityState === 'visible'` 且没有任务在跑时才刷）：
  环境是用户手动开的、也会被用户手动关，FoxProfile 那边 `GET /browser` 早就空了，
  界面不轮询就会一直显示「运行中」——这是用户实际踩到过的 bug。
- 账号资料（头像/昵称/粉丝/关注/赞/地区/注册时间）由 `scripts/tk-profile-sync.mjs` 抓：
  开环境 → 打开 `https://www.tiktok.com/@<用户名>` → 读 DOM → 头像下载到
  `<数据目录>/data/avatars/<环境>.jpg` → 写 `data/account-profiles.json` → 关环境。
  界面通过 `accounts:avatar` 拿 data URI 显示（不给渲染进程开 file:// 权限）。
- **头像选择器**：`[data-e2e="user-avatar"]` 是个空 div，真正的图在
  `img[class*="ImgAvatar"]`（299px，优先）或 `img.user-avatar` 里。
- **地区拿不到现成的**：`/passport/web/account/info/` 只给 `create_time`、`email`、`screen_name`，
  `country_code` 实测恒为 0。地区的唯一来源是账号文件第 6 列，登录时写进
  `env-accounts.json` 的 `region` 字段，资料脚本读它回填。别指望从网页抓。
- `user/detail` 之类数据接口要 X-Bogus 签名，直接 `fetch` 必然拿不到 JSON —— 别走这条路，走真实页面 DOM。
- 一批 10 个号拉资料约 5~6 分钟（每个 30 秒左右），必须后台跑 + 进度流，不能让界面卡着等。

### 修改账号资料（头像 / 名字 / 用户名 / 简介）
- 脚本：`scripts/tk-profile-edit.mjs`（界面 IPC `accounts:editProfiles` 只 spawn 它，逻辑不分叉）。
  ```powershell
  node scripts/tk-profile-edit.mjs --only TK01 --name "Cora" --bio "UK" --avatar D:\a.jpg
  node scripts/tk-profile-edit.mjs --only TK01 --name "Cora" --dry-run   # 只填不保存
  node scripts/tk-profile-edit.mjs --job jobs.json                       # 批量（界面走这条）
  ```
- 入口：账号页 → 行尾铅笔（单个，右侧滑出面板）/ 勾选多行 → 顶部「批量改资料」（弹窗）。
  批量只给 名字+简介+头像；**用户名不批量**（全站唯一 + TikTok 30 天冷却），只在单个面板里开放。
- 弹窗结构（实测）：`input[placeholder="Username"]`、`input[placeholder="Name"]`、
  `textarea[data-e2e="edit-profile-bio-input"]`、`input[type=file]`（.jpg/.jpeg/.png/.tiff/.heic/.webp）、
  入口按钮 `[data-e2e="edit-profile-entrance"]`、底部 `Cancel` / `Save`。
- 填值必须「点进去 → Ctrl+A → Delete → 逐字符输入」，填完**读回比对**；不一致再用 `insertText` 补一次。
  只 `fill()` 有时不触发 React 的 onChange，保存后等于没改。
- 头像走 `locator('input[type=file]').setInputFiles(path)`（FoxProfile `/page/upload`）；
  上传后若弹出裁剪确认，脚本会自动点 Apply/应用/Next。
- 批量模板变量：`{username}` `{nickname}` `{region}` `{env}` `{n}`（序号，1 起），在**渲染进程**渲染成
  每个号的具体值再传给脚本 —— 脚本只认最终值，不做模板，方便预览。
- 保存后必须**回主页读回校验**（`user-title` / `user-bio` / `user-subtitle`），并把结果写回
  `data/account-profiles.json`；改名成功还要更新 `env-accounts.json` 的 `username`。
- **头像读回必须「反复读」，读一次就判死会误报**（2026-10-19 真实事故）：批量换头像 4 个号，
  抽屉里 3 个报「⚠️ 头像地址没变（大概率没真正保存）」，其实**全都换成功了** ——
  点完 Save 立刻读主页，TikTok 那边还没刷新（事后读线上 URL 全变了）。
  现在 `src/avatar-verify.js` 定口径：保存后轮询复查（4s/6s/8s 递增，最多 45 秒），
  读到变了算 ✅，超时只说「可能只是延迟，稍后核实」，**绝不把延迟说成失败**。
  单测 `tests/unit/avatar-verify.test.js`（8 个用例）守这条。
- **界面缩略图要存「线上那张」**：`data/avatars/<环境>.jpg` 只由头像同步刷新，
  改资料成功后必须自己把 `img[class*="ImgAvatar"]` 的线上图下载覆盖过去
  （TikTok 已裁成 200x200），否则账号页还是旧图/默认灰头像 → 用户以为没换成。
  拷原图是下策（和真号显示不一致），只有下载失败才退回拷原图。
- 改动前先让用户点「演练」（`--dry-run`，填完点 Cancel，不产生任何服务端变更）。
- **点按钮的铁律**（踩过两次）：TikTok 一个按钮有 5~7 层嵌套副本（外层 691px 容器 →
  114px `<button>` → 几层 text div），而且桌面/移动/隐藏副本都同时存在。
  - 不能按「面积最大」挑（点到外层容器的空白处 = 弹窗根本不开）；
  - 不能只按 DOM 顺序挑最后一个（可能是被移出视口的隐藏副本 = 点空）。
  - 正确做法：候选里要求「中心点在视口内」且 `document.elementFromPoint(cx,cy)` 的结果
    是它自己或它的子/父元素，然后取**最内层**（面积最小）那个；点完再验证效果（弹窗开/关）。
- **不要用「页面里 class 含 error/toast 的元素」判成败**：TikTok 这种容器满页都是，
  会抓到主页背后的「Upload your first video」之类正文，把成功判成失败。
  唯一可信的判据是**保存后回主页读回**（头像 URL 只比路径，签名参数每次都变）。
- 头像预览：选完图要经 IPC `accounts:imagePreview` 转 data URI 再显示（渲染进程没有
  file:// 权限），并且把文件名回显出来 —— 只把路径塞进变量不给任何视觉反馈，用户会以为「没反应」。

### 账号凭据（用户名 / 密码 / 邮箱）
- 界面要「完整邮箱 + 密码小眼睛 + 点击复制」，所以凭据必须落到
  `%APPDATA%\xnowpost\data\env-accounts.json`（**明文**，故意为之；该目录不在仓库里）。
  不想留明文就删掉 `password`/`emailPassword` 字段，界面会自动显示「未导入」。
- **邮箱来源优先级**：`state.email`（本地导入的完整邮箱）> `config.accounts[].email` > TikTok 接口。
  TikTok `/passport/web/account/info/` 只给 `r***1@outlook.com` 这种**脱敏串**，
  用它覆盖本地完整邮箱是错的（踩过一次）。
- 「导入账号文件」= 只解析文件写状态（用户名/密码/邮箱/邮箱密码/地区），**不登录**；
  按用户名匹配已有环境，匹配不上才按序号落到 `TK0N`，不会把 TK03 的资料写到 TK01 上。
- 复制走主进程 `clipboard`（`accounts:copy`），不要用渲染进程 `navigator.clipboard`：
  后者在某些上下文会静默失败。
- 密码复制成功后**不要回显明文**到 toast（截图/录屏会漏），只提示「已复制密码（11 位）」。

## 定时（调度器）
- `src/scheduler.js` 是独立长驻进程，由 `electron/main.js` 的 `startScheduler()` spawn
  （打包版取 `app.asar.unpacked/src/scheduler.js`，cwd 用代码目录）。杀掉应用就杀掉调度器，
  **应用不运行 = 定时不执行**，没有补跑机制。
- 账号页 / 定时页改完都要回归：`schedule.json` 的 mtime 有没有变 + 调度器日志有没有
  `🔄 检测到配置变化，重新加载定时任务`（热重载 `fs.watchFile` 3 秒轮询、5 秒防抖）。
- **发布前登录态预检**（`src/login-state.js`）：`runJob` 在 spawn 引擎/发布器之前先读
  `<camoufox_data>/<环境>/cookies.sqlite`（moz_cookies 里的 `sessionid|sessionid_ss|sid_tt|sid_guard`）。
  - `state='out'` → 跳过本轮并告警（省 API 费用，不产生 FAILED 目录）；
  - `state='unknown'`（库不存在/被占用/没有 node:sqlite）→ **只提示不拦**，宁可放过不可误杀；
  - `publish` 模式只有「所有环境都没登录」才整体跳过，部分掉登录只记警告。
  - 教训：2026-10-18 08:35 那轮就是掉登录后照跑 5 分钟，到上传视频才发现页面是登录页。
- 环境名对应关系：`config/user.json` 的 `accounts[].name` 是 `01`…`10`，
  `bitEnvId`/`browserEnv` 才是 `TK01`…；定时里的 `account` 存的是 `name`，
  用 `resolveEnvs()` 转成环境名再查登录态。
- **任务 id 编码只有一套规则**（`src/job-ids.js`，界面/主进程/迁移脚本共用；
  单测 `tests/unit/job-ids.test.js`）：id 是 **1~999 的正整数、纯序号、只增不改**。
  老版本用过 `Date.now()` 当 id，同一份 `schedule.json` 里混着 `1 / 2 / 102` 和
  `1783852240727`，看日志容易误当成账号号（用户 2026-10-19 反馈「编码能统一一下吗」）。
  现在重复/非法/超过 999 的 id 会被自动重发号；到 999 回收最小空号，**永不越过四位数**。
  `electron/lib/sanitize.js#dedupeJobIds` 只是它的一个包装，**别再写第二份发号逻辑**。
  历史数据用 `node scripts/normalize-schedule-ids.mjs [--dry-run]` 一次性迁移
  （2026-10-19 实跑：20 个任务 → 1–20；08:30–09:15 十个视频任务 = 1–10 对应账号 01–10，
  10:00 采集 = 11，9 个停用老任务 = 12–20；自动备份到 `data/backups/`）。
  **迁移必须保序**：只改 id 字段，数组顺序和其它字段一个字都不动，脚本逐项校验，不一致就放弃写盘。
- 人和助手定位任务靠「时间 + 账号」（用户口径：「说 08:40 那个或 03 号就能定位」）；
  id 只在程序内部和确认卡上消歧用（文案形如 `#8 · 09:05 video · 账号 08`）。
- **定时页的改动只在内存里**，必须点「保存全部」才写 `schedule.json`；重启应用 = 未保存的闹钟全丢。
- **送 IPC 前必须转成纯数据**：`save()` 现在按 `_` 前缀过滤临时的界面字段再 `JSON.parse/stringify`
  一遍。踩过的坑：给 `_dropStyle`（浮层坐标，响应式对象）漏了过滤，`structuredClone` 直接抛
  `Failed to execute 'structuredClone' on 'Window': #<Object> could not be cloned.`
  —— 界面只显示一行黄色提示，用户以为「保存成功/没反应」，实际**一个字节都没写盘**。
  以后给 job 对象加临时字段，一律以 `_` 开头，别再逐个解构。
- **卡片里的下拉/浮层不能用 `position: absolute`**：`.x-card` / 卡片内部会把它裁掉
  （用户实际踩到：闹钟的账号选择框只露出前两三个账号）。
  正确做法：`<Teleport to="body">` + `getBoundingClientRect()` 算 fixed 坐标，
  下方空间不够就往上翻；并监听 `scroll`/`resize` 收起浮层（fixed 不跟随滚动）。
- 浮层收起还踩了两个坑（都是用户报的）：
  ① `window.addEventListener('scroll', hide, true)` 会同时收到**浮层自己内部滚动**的事件，
     鼠标滚轮滚列表就把浮层关了 → 回调里先 `e.target.closest('.acc-drop')` 就 return；
  ② 收起后输入框**仍然有焦点**，再点它不会触发 `focus` 事件 → 必须额外绑 `@click` 兜底重开，
     否则用户要点一下空白处再点回来才有反应。

## CMD 弹窗零容忍
- 所有 `spawn()` / `execSync()` 必须带 `windowsHide: true`
- 启动子进程一律用 `windowsHide: true`，不允许出现任何 CMD 窗口
- 新增任何 spawn/execSync 调用时必须加上此参数

## 采集：不许把"没采到"说成"采到了"（2026-10-19 事故）
- **`normalizeResult()` 的坑（已修，`src/collector/result.js`）**：采集器没数据时返回
  `{stats: null, username: ''}`，旧写法 `const stats = result.stats ? result.stats : result`
  会**退回成整个返回对象**，于是 `Object.keys().length === 2 > 0` 判成"有数据" →
  每个号记 ✅、`saveStats` 又因为值不是数字写不进任何行 → 全军覆没也骗过了
  "`allResults.length === 0` 就抛错"的守卫 → 覆盖 `collect-meta.json` 时间戳 → 界面显示
  "今天已采集"而 `analytics.db` 当天 0 行。**判有效数据的口径：至少一个 `Number.isFinite` 的数字**
  （0 是有效值：0 播放是真话）。
- **三种"没数据"必须分开报**（处置完全不同，别混成一句"页面结构可能已变化"）：
  1. `数据不足`：TikTok Studio 分析页五个 KPI 全是 `--` 占位（`looksInsufficient()`，账号还没数据）
     → 退出码 **2**，调度器 `runWithRetry` 见到 2 就记
     `❌ <任务> 失败：数据不足（…本轮不重试）` 并**不重试**（重试只会再开 10 个浏览器窗口白跑 2.5 分钟）。
     这行必须同时含 `❌` 和 `失败`：界面「调度进度」用 `/❌\s*.+?失败/` 判断任务已结束。
  2. 未登录 / 打不开环境 → 退出码 1，按失败重试。
  3. 解析不到（选择器失效）→ 退出码 1，需要改代码。
- **只有真采到数据才写 `collect-meta.json`**；每轮都写证据
  `output/<日期>/collect-HHMM.json`（`ok/total/collected/insufficient/failures`），
  日报页的黄条就是读它。以前"空跑也报 ✅ 完成"就是因为只有 stdout、没有落盘证据。
- **`username` 不要靠抓页面**：Studio 分析页不显示 `@handle`（10 个号抓回全是空串）。
  `resolveUsername()` 的顺序是 页面 > `data/env-accounts.json` > 配置 `accounts[].username`。
- **`--` 是"没有数据"，不是"选择器坏了"**：实测 TK01 页内 `fetch`
  `/tiktok/v1/analytics/insights/`（带完整参数）返回 insight 82 = `status 9`、类型 1–6 = `{}`，
  HTTP 200；Followers 页 `Total followers 0` + `Get more insights once you reach 100 followers`。
  这些号本来就没播放/粉丝，等数据长出来会自己恢复 —— 别为了"让日报有数字"去编数据。
- **在仓库目录跑 CLI 必须带 `XNOWPOST_DATA_DIR`**：`src/paths.js` 在开发模式下把数据目录
  解析成**仓库根**，会读到仓库里那份旧 `config\user.json`（比特时代的 UUID 环境名），
  报错长这样：`FoxProfile 里没有名为「31bea5b146af40f58b2a6eae0e2c2a6b」的环境`。
  ```powershell
  $env:XNOWPOST_DATA_DIR = "$env:APPDATA\xnowpost"; node src\collector\index.js --accounts 01,02
  ```
- **启动部署版应用前先清 `ELECTRON_RUN_AS_NODE`**：该变量存在时 `XNOWPost.exe` 会按 node 运行，
  **秒退、退出码 0、日志一个字都不写**（很容易误判成"打包坏了"）。
  ```powershell
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue; Start-Process E:\software\XNOWPost\XNOWPost.exe
  ```

## 运行日志页：两份日志都要看（2026-10-19「只能看到这几行」）
- 真内容在 **`logs/scheduler-<日期>.log`**（任务开始/登录态/引擎输出/采集细节），
  `logs/app-<日期>.log` 只是应用自己的事件 + 调度器输出的**回声**（消息前缀 `⏰`）。
- 所以：合并两份时必须 `dropEchoedSchedulerLines()` 去掉回声（否则每条出现两次）；
  时间格式不一样（app `2026/10/19 10:45:07` / 调度器 `2026-10-19 10:45:01`），
  统一 `normalizeTime()` 把斜杠换横杠再按字符串排序。
- **界面默认「按任务分组」**（`src/renderer/lib/log-runs.js`）：按 `🚀 … 任务开始` 切轮，
  一轮一行显示 `结果 / 耗时 / 账号 / 环境 / 已发几个 / 花费 / 错误·警告数 / 行数`，
  点开才是那一轮的全部原始行。为什么必须这样：一天 11 轮、1300+ 行，
  真正有用的是「08:30 那轮成没成」，平铺等于让人自己去翻。
  - 轮次边界**不看结束标记**（各任务收尾文字都不同：`✅ 仅视频 完成` / `✅ 数据采集 + 日报 完成` /
    `❌ … 失败：…`），只按下一个 `🚀 任务开始` 切；结果从轮内日志推断。
  - 耗时取**明确的收尾行**时间，不能用"轮内最后一行"——下一轮的 `🔐 TKxx 已登录` 预检行
    会把 2 分半钟的一轮算成 45 分钟。
  - 环境只认 `🌐 打开指纹环境 TKxx`：`🔐 … 已登录` 是调度器对**所有**账号做的预检，
    算进来会让每一轮都显示十个环境。
- **等级判定先看行首表情，再看关键词**，且**只认明确失败写法**：
  `失败：`/`Error:`/`FAILED`/`timed out`。反面教材（2026-10-19 当天真实踩到）：
  ① `🗣️ 先做配音（失败则一分钱不花在生图上）...` 只提了一句"失败" → 10 轮全部被标成 ❌ 失败；
  ② `🚀 任务开始（超时预算 1800s）` 里的"超时"同理；③ `🚫 文案含敏感信息，重写中` 是**警告**（重写后成功），
  不是失败。修完之后今天真实错误数是 **0**（之前显示 11 条全是假的）。
- **emoji 字符类必须按码位比对，不要写 `/^[🔶]/`**：没有 `u` 标志时 `🔶`（U+1F536）被拆成
  两个代理半区 `\uD83D\uDED6`，`🗣`/`📤` 这些 U+1D3xx… 的 emoji 高位也是 `\uD83D`，
  于是**所有 emoji 开头的行都命中**（判定直接串味）。正确写法：`const head = [...m][0];
  if (head && '⚠❗🔶🚫'.includes(head)) ...`。
- 还有一个 JS 坑：**`'abc'.includes('')` 恒为 true**，`head` 为空串时会无条件命中第一个分支
  （空消息被判成 warning）。所以 `head` 必须判空。
- 「实时」不能只给内存缓冲（500 行、重启即清空），要读今天日志文件的尾部，
  并且**每 5 秒重读一次**（调度器是独立进程）+ 打开页面时定位到最该看的地方
  （分组视图滚到顶部=最新一轮，全部行视图滚到底=最新一行）。
- 日志文件名一律用 **本地日期**（`toLocaleDateString('sv-SE')`）：`toISOString()` 是 UTC，
  北京时间 00:00–08:00 会把当天日志写进前一天的文件，和调度器的命名对不上。
- 一天能写 6000+ 行：全部行视图默认只渲染最近 2000 行 + 「显示更早 2000 行」按钮，
  别一次性全塞进 DOM（分组视图只渲染 11 行标题，不受影响）。

### 日志占不占资源（2026-10-19 用户提问）
- **内存不占**：`logBuffer` 硬上限 500 行（写到文件后不再驻留），分组视图只渲染 11~12 行标题。
- **磁盘很小**：一天两份文件（app + scheduler）0.1~0.3 MB；从 2026-06 攒到 10 月只有 30 个文件 / 2.95 MB。
- 但以前**只写不清**，所以现在启动时按 `electron/lib/log-prune.js` 删 **30 天前**的
  `app-<日期>.log` / `scheduler-<日期>.log`（其它文件一概不碰；`days<=0` 视为不清理）。
  首次运行实测：30 个 → 6 个，释放 2.02 MB，日志里留一行
  `🧹 清理 30 天前的日志 24 个，释放 2.02 MB`。
- 真正占磁盘的不是日志，是 `output/`（2026-10-19 实测 **1323 MB / 2302 文件**）：
  `封面.png` 304 个 578 MB、`video.mp4` 291 个 527 MB（**都是交付物，永不自动删**）、
  `expanded_debug.html` 243 个 57.5 MB、`_video/` 中间件 84 MB。

### output 保留 15 天（用户 2026-10-19 定口径）
- 规则在 `src/output-retention.js`（纯函数 + 4 条单测），主进程启动时执行一次：
  早于 **15 天**（按目录名里的日期，不是 mtime）的 `output/<日期>/` 里，只删两类：
  ① `expanded_debug.html`；② `_video/**`（配音/分镜/切片中间件）。
- **`video.mp4` / `封面.png` / `文案.txt` / `描述.txt` / `.published` / JSON 证据 /
  调试截图一律保留** —— `isCleanable()` 是白名单式判定，加新类型先加单测。
- `days<=0` = 不清理；单测里把「交付物一个都不许动」逐条钉住了。
- 首次运行实测：**230 个文件 / 释放 136.0 MB**，1323.2 MB → 1187.2 MB；
  老目录里 `video.mp4` 242 个、`封面.png` 255 个都还在，最近 15 天目录里
  22 个 `expanded_debug.html` 原样未动。
- **递归坑**：`am_0830/` 本身不可清，但里面的 `expanded_debug.html` 要清 ——
  遍历时不能对"不可清的目录"直接 `continue`，必须继续往下走（第一版就漏了，
  结果一个文件没删、日志也是空的，很容易误以为策略没生效）。

### 「放弃作品确认」有三层判定，别只改一层
同一个框在三个地方被处理，任何一层认错都会留下「未知弹窗」的假日志：
1. `page-sense.js` 的常驻反应器 → `policyFromButtons()`（按钮组合：取消类 + Discard）；
2. `dialogs.js` 第一轮 → `DIALOG_RULES` 的**文字签名**（`discard this post` 等）；
3. `dialogs.js` 第二轮 → 浮层兜底。**这里以前只有文字签名**，标题块不进浮层集合时
   （浮层里只剩「Not now / Discard」）就会被判成"未知弹窗"，日志写成
   `⚠️ 未知弹窗 → 点了安全按钮「not now」` —— 2026-10-19 当天出现 3 次（08:47 / 08:57 / 09:07），
   明明是认得的框却报未知，复盘时最误导人。现在第二轮也按按钮组合兜底，
   命中后记为 `rule: '放弃作品确认'` 且 `buttonOnly: true`，日志多一句
   `（标题块没进来，靠「取消类 + Discard」按钮组合认出来的）`。
- `allowDiscard` 只从上层的 `allowDiscardDraft` 透传（**只在"上传之前"那一步为 true**），
  其余场景这一层永远只点 Not now/Cancel。

## 数据日报页：三个数字必须说得清（用户 2026-10-19「我有点看不懂」）
- **「—」≠ 0**：没采到的指标以前按 0 累加（总粉丝明明没采到却显示 0 粉）。现在 KPI 汇总里
  "没有任何平台有这项指标"就返回 `null`，界面显示 `—` 并加脚注。0 只在**真的采到 0** 时显示。
- **页面显示的是"某一天的记录"，不是"今天的成果"**：顶部黄条读
  `output/<日期>/collect-*.json`（当天）和今天的证据（`collectToday`），
  只要今天那轮没采到就明说「今天 XX:XX 的采集没拿到数据，所以这一页显示的是 X 月 X 日（最近一次有数据的一天）」。
- **趋势横轴按真实日历天**（`report:trend` 里 `allDates` 用本地日期倒推 N 天）：
  旧实现取"最后 N 个有数据的日期"，把 2026-07-22 和 2026-10-18（隔 3 个月）等间距排在一起
  还连成一条线，看着像"这 7 天都是 0"。缺口必须断线（`trendSegments` 分段画）。
- **图例必须带账号名**（`01 · 播放`）：旧图例只有 `平台·指标`，8 个号渲染出一排一模一样的 chip，
  点哪个都不知道。
- **TG 没配 ≠ 推送失败**：`isTelegramConfigured()` 分开报；一个数字都没有时不推空日报；
  主进程手动「推送日报」也不许在没配 token 时记 `✅ 已推送到 TG`。

- **粉丝/关注/获赞只能从账号主页拿**（`src/collector/scrapers/tiktok-profile.js`）：
  分析页本来就没有这三项，Followers 页对 <100 粉的号只给 `0` + "达到 100 粉解锁"。
  采集器爬完分析页后在**同一个环境**里顺路打开 `https://www.tiktok.com/@<用户名>` 读资料卡
  （不额外开窗口）。指标键：`followers` / `following` / `total_likes`
  —— 主页的"获赞"是**累计获赞**，分析页的 `likes` 是**近 7 天视频点赞**，别混用同一个键。
- **资料卡必须读元素文本，不能读 `title`**：
  写法是 `<strong title="Followers" data-e2e="followers-count">0</strong>` ——
  `title` 是"这是粉丝数"的标签，不是数字。第一版读 title 拿到 `"Followers"` → 三个数全 null，
  而且代码只在"读到数字"时打日志，于是**一个字都不打**，看着像这段没执行（2026-10-19 踩过）。
  现在的口径：优先 `textContent`，只有它为空才退回 `title`；解析不出数字时**打印原始值**。
- 只拿到主页数字（分析页仍是 `--`）时返回 `partial: true`：照样入库（0 粉是真数据），
  日志 `ℹ️ 0N: 只拿到主页的粉丝/关注/获赞，播放/点赞/评论 TikTok 仍是「--」`，
  证据 JSON 记 `partial`，日报页显示**蓝色提示条**（不是黄色失败条）。
- **TG 的坑**：`electron/main.js` 会把配置页的 `tgBotToken` 写进 `process.env.TG_BOT_TOKEN`，
  **打包版不读 `.env`**。仓库 `.env` 里那个 `TG_BOT_TOKEN` 只有 14 字符（真 token 是 `数字:AA…` 40+ 位），
  CLI 跑采集会读到它并报 `❌ 日报推送失败: TG 推送失败 404 Not Found`。
  要真推 TG：到「配置 → Telegram Bot Token」填真 token。

## 浏览器：只用 FoxProfile（Camoufox），比特浏览器已弃用
- 环境由 FoxProfile 启动（指纹、代理、时区才是对的），接口 `http://127.0.0.1:8000/api/v1`
- 环境名就是配置里的 `accounts[].bitEnvId` 字段（字段名沿用历史，值为 `TK01`…`TK10`）
- Camoufox 是 Firefox 内核，**没有 CDP**，Playwright 无法 attach。所以：
  - 采集：`src/collector/foxprofile.js`（HTTP 直调 `/page/*`，够用）
  - 发布：`src/collector/foxpw.js` —— Playwright 形状的代理，把
    `page.locator('#x').first().click()` 翻译成 FoxProfile 的 `/page/pw` 链式调用
- FoxProfile 侧为此新增了三个动作（`src/services/browser/control.py`）：
  `pw`（任意 Playwright 方法链）、`upload`（文件上传/文件选择器）、`dialogs`（弹窗策略 pre/post）
  **这是本地补丁**，`git pull` 会覆盖，升级 FoxProfile 后需要重新加。
- 窗口焦点也是本地补丁（`src/services/browser/window_focus.py` + `launcher.py`）：
  启动接口带 `focus` 参数，默认 `true`（界面点「启动」时把浏览器顶到前台）；
  程序自动启动（发布/采集）传 `focus=false`，抢了焦点会自动还回原窗口。
  `src/collector/foxprofile.js` 的 `foxLaunch(name, base, { focus })` 默认 `false`。
- 起始页也是本地补丁（`src/core/config.py` 的 `START_URL` + `runner.py`）：
  没有可恢复标签页时打开 `FOXPROFILE_START_URL`（`.env` 里配，默认 TikTok Studio），
  避免出现空白的 "New Tab" 窗口。标签页记录在 `<camoufox_data>/<环境>/tabs.json`。
  单实例保护在 `src/main.py`：API 已在跑时只唤起已有窗口，不再叠一个界面。

## 发布完必须关掉浏览器窗口
- 用户明确要求：**发完自动关闭指纹浏览器窗口**。原来的发布器从头到尾没有任何关环境的调用，
  每跑一轮就留下一个 camoufox 窗口（越跑越多，还占着 cookie 库，下次读登录态会失败）。
- 现在 `src/publisher/index.js` 的 `publishAll()` 用 `try { 循环 } finally { closeFoxProfile(envId) }`：
  无论成功/失败/演练，退出前都会 `closeFoxProfile` 并 `foxRunning()` 复核，
  日志分别是 `🧹 关闭指纹浏览器窗口...` / `✅ 指纹环境 TKxx 已关闭` / `✅ 已确认没有残留环境`。
- 调试想保留窗口看现场：`$env:XNOWPOST_KEEP_BROWSER = "1"`。
- 注意 `src/index.js`（引擎）里也有 `closeFoxProfile`，但那是在整轮结束、后处理之后才跑，
  实测会晚好几分钟；发布器这一层的 finally 才是"发完立刻关"。

## 发布文案：中英双语在**生成阶段**定稿（描述.txt）
- 用户要求：Description 要中英文一起，国内国外用户都能看懂。
- 生成侧（`src/index.js`）在写完 `文案.txt` 之后再写一份 **`描述.txt`**（发布用的最终文案）：
  中文标题 → 英文标题 → 前两屏字幕（中/英成对）→ 标签行。
  发布器（`src/publisher/tiktok.js`）**优先原样粘贴 `描述.txt`**，没有才现场拼
  （中文标题 + 英文标题 + 标签）。这样"一处生成、发布一致"，改文案不用改发布逻辑。
- 模型本来就返回 `title_en` / `scene_text_en` / `tags_en`，之前只用了中文那几个，英文白扔了。
- **标签必须去掉空格**：`#secure browsing` 在 TikTok 里只把 `#secure` 当标签，后面变成正文。
  `src/index.js` 写文案时统一 `replace(/\s+/g,'')` 并按小写去重；发布器解析时再兜一次。
- 发布器的标签配比：英/中交替取，最多 6 个 —— 纯中文标签海外刷不到，纯英文丢掉中文流量。

## 点弹窗：DOM `click()` 不够，要用**真实鼠标坐标**
- 2026-10-18 22:28 实测：日志写「✅ 点了 cancel」，监控却看到「Turn on automatic content checks?」
  又挂了 40 秒。原因：TikTok 的 TUXModal 按钮是 `<div>` + pointer 事件，
  元素级 `btn.click()`（合成事件）经常"不报错也不生效"。
- 现在 `handleDialogs` 会做**二次确认**：点完等 1.2 秒回读页面文字，
  签名还在 → `page.mouse.click(cx, cy)` 按坐标真点；还在 → 点右上角 `×`（`pickCloseBtn`）。
  日志：`🖱️ 「cancel」的 DOM 点击没生效，改用真实鼠标坐标再点一次`。
- **回读必须忽略大小写**：规则签名是小写（`turn on automatic content checks`），
  页面文字是 `Turn on automatic content checks?` —— 直接 `includes` 恒为 false，
  会被误判成"已经关了"，补点逻辑一次都不跑（2026-10-18 22:40 实测，白等 35 秒）。
- 所以页面侧 `pageSide` 的返回值里带 `cx/cy/close` 坐标，Node 侧才有机会补点 —— 改页面侧逻辑时别丢这几个字段。

## 发布器要"像眼睛一样看页面"（page-sense / page-act）
用户原话：「我需要你像眼睛一样看到页面每一个细节变化，包括按钮、点击、弹窗、状态，
这样才能像真人操作一样顺利发布」。所以发布器不再靠"盲操作 + 固定 sleep"。

- **眼睛** `src/publisher/page-sense.js`
  - `startSensing(page, { logFile })`：页面内装 MutationObserver + 捕获阶段 click 监听 +
    scroll 监听，Node 侧每 300ms 取一次增量，写 `<会话目录>/page-events.log`。
    记的是"看得见的变化"：浮层出现/消失（带全文和按钮列表）、`aria-disabled`/`aria-checked`
    翻转、上传百分比、文案计数、**点击的目标和坐标**、谁把页面滚了。
  - **页面导航会把 `window.__sense` 冲掉**：drain 返回 `ok:false` 时必须重装，否则全程 0 条。
  - **别用 `await import('fs-extra')` 再取 `appendFile`**：CommonJS 的具名导出探测不到，
    拿到 undefined 后异常被 try 吞掉 → 日志永远是空的（踩过）。
- **结构化状态** `snapshot(page)`：URL / 浮层（文字 + 每个按钮的文字/坐标/禁用状态）/
  Post 是否存在可点可见、`elementFromPoint` 命中谁 / 上传进度 / AI 开关 aria / 文案长度 / 检查项。
  决策一律基于它，别再各写一套 `evaluate`。
  - 浮层判定**必须真浮起来**（祖先 `position: fixed` 或 `role=dialog`）：
    只看 class 会把上传表单里的「Labeling AI-generated content」说明区块当弹窗。
- **手** `src/publisher/page-act.js`
  - `clickLabel(page, labels, { avoid, verified })`：找**最内层 + 中心在视口内 +
    `elementFromPoint` 命中它自己/子/父**的元素，用 `page.mouse.click(cx, cy)` 真点，
    然后轮询 `verified()` 确认"变化真的发生了"。`avoid` 里的危险词一票否决
    （「Cancel post」绝不能因为含 `cancel` 就被点掉）。
- **反应器** `startOverlayReactor(page)`：每 500ms 看一眼，认识的浮层立刻点掉并复验；
  不认识的**只记录不点**。策略表 `OVERLAY_POLICY`（改它要同步改单测）：
  | 浮层 | 点 | 绝不点 |
  |---|---|---|
  | 自动内容检查 | Turn on | Cancel post / Discard |
  | AI 标注引导 | Turn on | Not now / Discard |
  | 放弃作品确认 | Not now / Cancel / Stay | Discard / Exit / Leave |
  实测：`浮层出现 +12.5s → 🖱️ 点了「Not now」(836,410) → 已生效 +13.4s`（0.9 秒收掉）。
  同一个框最多试 4 次就停手（防"疯狂点击"），关掉了计数清零。
  - 弹窗在 DOM 里常被拆成好几块（标题块、按钮块各自命中 Modal 选择器），
    所以策略判定用**整页浮层文字拼接**，别逐块判断（逐块会漏掉没有标题的按钮块）。
  - **但整页文字拼接不够用**（2026-10-19 09:05 实测，当天 3/10 轮）：标题块偶尔不进浮层集合，
    只剩按钮块「Not now / Discard」，而同屏还挂着「Preview your video on your phone → Got it」，
    拼起来只有 "got it" → 被判成「通用确认」→ 对着被遮罩挡住的位置**盲点 4 次、白等 28 秒**。
    所以判定顺序是 `policyFromButtons()` **先于**文字：同一屏同时出现「取消类
    （Not now/Cancel/Stay）」+「Discard」，就直接按放弃作品确认处理。
    （反应器自己动手时仍点 Not now —— 它不知道当前是"发布前"还是"上传后"；
    真正丢弃旧草稿由主流程在**上传之前**自己点 Discard，见下一条。）
    自动内容检查是 Cancel + Turn on、AI 标注是 Not now + Turn on，都没 Discard，不会误入。
  - 4 次上限的 key 是**「策略 + 按钮文字」签名**（`overlaySignature()`），不是策略名：
    按策略名计数时，一次误判就把整轮里所有同策略浮层一起封死。
- **草稿必须真的丢掉，不是点 Not now**（2026-10-19 用户口径）：
  上传页若挂着旧草稿，会有一条横幅 `A video you were editing wasn't saved. Continue editing?
  [Discard] [Continue]`；点掉横幅后 TikTok 再弹一层 `Discard this post?`（Not now / Discard）。
  - 只点 **Not now** = 取消丢弃，草稿留着 → **下一轮进来照样弹**（当天 10 轮里 6 轮都有这个框），
    而且留下的草稿会在下次的确认框里被点名（`Your video "上一条的标题…"`）。
  - 正确做法：`tiktok.js` 在**上传之前**用 `handleDialogs(page, { allowDiscardDraft: true })`
    点确认框里的 **Discard** —— 此刻页面上还没有我们的视频/文案，丢的是上一轮的旧草稿，安全。
    实测丢弃后重开上传页 `hasBanner:false`（草稿真没了）。
  - **必须先 `reactor.pause()` 再动手**：反应器认识这个框，每 500ms 一轮会抢着点 Not now，
    把丢弃意图取消掉（这才是"每轮都弹"的真凶）。点完在 `finally` 里 `reactor.resume()`。
  - `allowDiscardDraft` 只在「放弃作品确认」这一条规则上放开 Discard，并把
    `discard/放弃` 从危险词里摘掉；其它规则和"未知弹窗"路径依旧拿不到 Discard
    （`SAFE_LABELS` 里本来就没有 discard）。**上传之后任何调用都不许带这个开关**。
- **逐动作日志** `withActionLog()`：把发布期间每一条 console.log 按真实时间追加到
  `<会话目录>/publish.log`，格式 `+  11.8s  Δ   145ms  <原日志>`。
  为什么需要：调度器用 `spawnSync`，子进程 stdout **退出时才一次性回放**，时间戳全一样；
  `browser-trace.json` 又只记 3 个 trace.step —— 事故复盘时只能猜。现在不用猜了。
- 排查用脚本：`node scripts/_sense.mjs TK10 --seconds 40`（只开页面看事件流）、
  `node scripts/_probe-sense.mjs TK10`（验证 INIT/DRAIN/SNAPSHOT 在 evaluate 下是否持久）。

## 账号页「最后发布」：发布成功时间从哪来、为什么能即时刷新
用户要求：账号页能显示每个号最后一次发布成功的时间，并且**手动发布 / 闹钟发布都要即时更新**。

- **写**：`src/publisher/tiktok.js` 的 `markPublishedNow()` 点完 Post 后做两件事：
  ① 写会话目录的 `.published`（现在带 `env` / `session` / `title` / `confirmed:true`）；
  ② 往 `<数据目录>/data/publish-ledger.jsonl` **追加一行**（env / at / date / session / title）。
  账本是唯一"便宜"的数据源：追加写、不用扫描、老会话也能靠它补。
  两条路径（界面「发布」和调度器）都走同一个发布器，所以两边都一样。
- **算**：`src/publish-history.js`
  - `latestPublishByEnv(dataDir)` = 账本 + 会话 `.published` 合并取最新；
  - 老会话没有 `env` 字段时，用 `publish.log` 里的 `🌐 打开指纹环境 TKxx` 解析；
  - `confirmed:false`（点了按钮但没确认结果）**不算**成功，不进这一列。
- **即时**：主进程 `fs.watchFile` 盯账本 → 变化就 `webContents.send('accounts:publishTimesUpdated')`；
  账号页另外还有 6 秒轮询兜底。实测往账本追加一行，4 秒内界面就出现新时间（删掉也能马上回退）。
- **历史回填**：`node scripts/backfill-publish-ledger.mjs [--dry-run]`。
  它解析 `logs/app-*.log` / `scheduler-*.log`，按「📅 会话目录 → 📤 自动发布到账号: NN →
  🌐 打开指纹环境 TKxx」的顺序配对，再用 `.published` 里的真实时间写账本。
  2026-10-18 跑出 11 条（TK01×2、TK02×2、TK04–TK10），TK03 显示 `—` 是因为它那天
  am_0840 和 pm_2014 两轮**都是 FAILED**，确实没发成功过。
- 单测：`tests/unit/publish-history.test.js`（8 个用例，含「未确认不算成功」「账本与标记取较新」
  「坏行跳过」「目录不存在不抛异常」）。

## 环境窗口要能认出来（标题带 TKxx）+ 「开了两个窗口」的真相
- 用户实测反馈（2026-10-19）：手动开了环境后，窗口标题/任务栏全是 TikTok 页面标题
  （「TikTok Studio — Camoufox」/「(4)xxx (@xxx) | TikTok — Camoufox」），
  **分不清哪个窗口是哪个环境**；另外看到两个窗口以为是「一次启动开两个」。
- **真相：一个环境只开一个窗口。** 看到两个窗口 = 同时开着两个环境
  （那次是 TK04 + TK05）。认环境的办法：
  ```powershell
  Get-CimInstance Win32_Process -Filter "Name='camoufox.exe'" | ForEach-Object {
    $e = if ($_.CommandLine -match 'camoufox_data\\(TK\d+)') { $Matches[1] } else { '?' }   # 命令行里有 profile 路径
    $w = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    if ($w.MainWindowHandle -ne 0) { "$e → $($w.MainWindowTitle)" }
  }
  ```
  一个环境的 `tabs.json` 里可能存了多个标签页 —— 那是**同一个窗口里的多个标签**，不是多窗口。
- **窗口标题现在带环境名**：`TK04 · TikTok Studio — Camoufox`。实现是常驻的
  `scripts/env-title-watch.ps1`（主进程 `startEnvTitleWatcher()` 用 `powershell.exe` 拉起，
  `windowsHide: true`，`-ParentPid` 指向应用进程，应用退出它自己退），每 2 秒给每个
  camoufox 窗口 `SetWindowTextW` 校正一次。实测 SetWindowText 后 9 秒内 Firefox 不会覆盖
  （只有换页/切标签才重写），所以 2 秒一轮足够。
- **为什么不往页面里注入标题前缀**（试过，放弃）：Firefox 的窗口标题只跟随**前台标签页**，
  而 FoxProfile 的 `/page/evaluate` 打到的是它自己的 `_current`（≈ `pages[-1]`）。
  TK04 有两个标签时就踩到了 —— 注入打的是个人主页，窗口标题却还是「TikTok Studio」。
  想对齐只能调 `/page/tabs/{i}/select`，那会把用户正在看的标签切走，发布进行中更危险。
- PowerShell 坑：**`$env` 是保留的环境变量提供程序**，不能当变量名（`$env = 'TK04'` 不报错但取到空）
  —— 必须用 `$envName` 之类。

## 所有环境窗口统一 1292x994（别再折腾 Win32）
- 用户要求「所有环境浏览器的初始位置和大小统一，跟 TK01 一样」。
- **结论：Camoufox 开窗尺寸 = 指纹里的 `screen.availWidth x availHeight`，位置恒 0,0。**
  所以"统一窗口"= 统一指纹的可用屏幕，脚本 `scripts/set-uniform-screen-size.mjs`
  把每个环境的 `fingerprint.screen` 写成 avail `1292x994` / screen `1366x1024`
  （Camoufox 会把屏幕宽度规整到 1366），窗口就原生开成 1292x994，视口 1276x901。
  实测 TK02/TK03/TK05/TK07/TK10 五个环境结果完全一致。
- **反面教材（都试过，别再走）**：
  - 只写 `<环境目录>/window.json` 或 Firefox 的 `xulstore.json` → 被 Camoufox 启动参数盖掉
    （xulstore 写 1292x994，实际开成 1600x856）；
  - 启动后按坐标 `SetWindowPos` 反复纠正 → Firefox 反制，出现 482x211、高度 65535 的乱数据；
  - PowerShell 里用 `EnumWindows` + 委托枚举窗口 → native 回调看不到函数局部变量，
    静默返回空（同一时刻另一个脚本却正常）。要用窗口就 `Get-Process` 的 `MainWindowHandle`。
- 给新环境（TK11…）统一尺寸：跑一次 `node scripts/set-uniform-screen-size.mjs`。
  改完指纹**不需要重启 FoxProfile**（每次启动时读），但要先关掉该环境。
- **重启 FoxProfile 必须用 `scripts/restart-foxprofile.ps1`**：直接杀 `pythonw` 会留下
  **孤儿的 Flet UI 进程**，任务栏多出一个永远转圈的空窗口（用户实际看到「怎么有两个窗口」）。
  正确顺序：关环境 → 杀 Flet UI → 杀 pythonw → 杀残留 camoufox → 启动 → 等 API → 核对只有一个窗口。
  正常形态是 `flet` 1 个 + `pythonw` 2 个（venv 的 python 自举到系统 python，监听 8000 的是子进程），
  别把第二个 pythonw 当重复实例杀。
- 顺带说明：改屏幕尺寸会让 `window.screen`、`device-aspect-ratio` 等信号跟着统一，
  比原来每个号一个随机分辨率（1280x720 / 1600x900 / 2560x1440…）更自洽。

## 发布时的弹窗怎么处理（AI 标注 → Turn on）
- 统一入口：`src/publisher/dialogs.js` 的 `handleDialogs(page, { sessionPath, tag })`，
  在 4 个位置调用：`cleanup`（上传就绪后）、`after-aigc`（点完 AI 开关）、
  `pre-post`（点 Post 前最后一遍）、`post`（点完 Post 等跳转时）。
- **「Labeling AI-generated content」引导框必须点 Turn on**（用户实拍 2026-10-18）：
  这是 TikTok 对 AI 生成内容的合规标注要求，点 Not now = 拒绝标注，
  未标注的 AI 内容 TikTok 有权下架。老实现点「弹窗里第一个按钮」正好会点成 Not now。
- 分级规则（写死在 `DIALOG_RULES`，改规则要同步改单测 `tests/unit/dialogs.test.js`）：
  - 已知签名 → 只点指定按钮；AI 标注 = `Turn on`；**放弃作品确认 = 默认点 `Not now`**
    （轮询/被动清理时用：`Not now` = 不放弃，绝不误丢作品）；
    **只有发布前那一步「旧草稿」传 `allowDiscardDraft: true` 才点 `Discard`**
    （2026-10-19 用户口径：点 Not now 等于没丢弃，下次还弹；那一步还没上传我们的东西，安全）；
  - 限流/掉登录 → 先点掉弹窗，再 `findFatalDialog()` 判致命让本轮失败（别硬重试）；
  - 未知弹窗 → 只点安全按钮（Not now/关闭/跳过/Cancel/×/Got it），
    `discard/delete/log out/post` 这类危险词永远不点，截图 + JSON 落盘留证据。
- 弹窗关掉后**必须复核 AI 开关 `aria-checked`**：遮罩会把点击吃掉，
  否则「以为开了其实没开」= 发出去的内容没标注。
- **TUXModal 的标题文字和按钮行不在同一个元素里**（2026-10-18 20:14 整轮发布挂在这）：
  只找「同时含文字和按钮」的容器，拿到的是里面某个文本块 → 判成"未知弹窗、无安全按钮"
  → 一个都不点 → 弹窗盖着 Post → `Locator.click: Timeout 30000ms exceeded` → 重试一次也失败。
  正确做法：**文本签名找锚点 → 一层层爬父节点 → 爬到能同时看到标题和目标按钮的那一层再点**
  （爬到面积 > 55% 视口的整页容器就停，避免点到别的弹窗的 Turn on）。
- 那个框的真名是「**Turn on automatic content checks?**」（Cancel / Turn on），
  不是 AI 标注框；两个都点 Turn on，两个都要在规则表里。
- 只有 **`position: fixed` 的浮层**才算"未知弹窗"：上传表单里的普通区块
  （`Content check lite`、"We'll automatically check your video…"）不是弹窗，
  当成弹窗的后果是每轮刷一堆假动作 + 几十张 PNG 截图（20:15 那轮实测）。
- 证据截图按「弹窗文字」去重，一次发布里同一个框只存一份；`no-match`（签名命中但没按钮）
  只提示一次，且**不算"有进展"**——否则弹窗清理循环会空转 10 轮。
- 点 Post 要有三层兜底：8s 短超时 → 先清弹窗再点一次 → JS `dispatchEvent` + `page.mouse.click(坐标)`；
  默认 30s 超时一次失败就把整轮判死太脆。
- 别再用 `JS remove()` 删弹窗 DOM：React 状态还在，下一步照样被挡。
- 单测不需要真浏览器：`tests/unit/dialogs.test.js` 用最小 DOM 影子对象跑页面侧那段逻辑
  （10 个用例，含「Turn on 被点、Not now 一次都没被点」「Discard 绝不点」
  「标题与按钮分离仍能点到 Turn on」「静态表单区块不算弹窗」）。

## 成片必须有"封面感"的开头（别让第一帧是黑的）
- 用户实拍反馈：发出去的视频第一帧是黑的（分镜 `fade=t=in` 从黑起），
  平台自动封面也是黑的，刷到的人完全不知道视频讲什么。
- 现在 `src/engine/covercard.js` 的 `prependCoverCard()` 会把已经生成的 `封面.png`
  （标题 + 一句话钩子 + CTA）作为 1.6s 定格卡拼到正片最前面：
  统一到 1080x1920/25fps/yuv420p + 48k 立体声再 `concat`，静音卡补 `anullsrc`，
  失败自动回退成原片（`src/index.js` 里只在 `封面.png` 存在时尝试）。
- 实测：17.36s → 18.96s，1080x1920 首帧就是封面图，音画不偏移。
- 文案（`文案.txt`）第一行本来就是标题钩子（如「矩阵攻略：一个账号不够，五个平台才稳」），
  后面接要点和 hashtag —— 生成侧不用改，缺的只是「封面真的被用上」。

## 发布器要靠"读回校验"，不能假设输入成功
- TikTok 文案框是 Draft.js：`fill()`/`execCommand` 只改 DOM，编辑器状态不认（计数停 0/4000）；
  逐字符输入在 Firefox 下会丢字（`#` 触发话题联想把后续按键吃掉）。
- 可靠做法（已封装在 `src/publisher/clipboard.js`）：系统剪贴板 + `Ctrl+V` 原子粘贴，
  再用页面上的「已用字符 x/4000」和读回的文本校验；失败才退回分段慢速输入。
- 检查项文案中英双语都要认（新环境浏览器语言是 en-US）：
  `音乐版权检查`/`Music copyright check`、`内容快速检查`/`Content check lite`、`未发现问题`/`No issues found`。
- **两条检查项会随 TikTok 改版消失，判定不能写死 AND**（2026-10-18 卡 15 分钟：
  Studio 只剩一个可选的「Content check lite」开关，「音乐版权检查」整项没了 →
  `两项都"未发现问题"` 永不成立，白等满 15 分钟再报错，页面上 Post 明明已经可点）。
  现在的三态判定：该项**不存在**就不要求；存在则必须自己后面跟「未发现问题」；
  再兜底「`[data-e2e="post_video_button"]` 可点 + 无 Checking 字样」连续两轮即放行。
  排查现场用 `scripts/_probe-page.mjs <环境>` 只读看当前页面（URL/Post 状态/文案/检查项），不动页面。

## 控制台「调度进度」怎么来的
- IPC `schedule:progress`（`electron/main.js`）聚合三样东西：
  ① 调度器日志文件 `%APPDATA%/xnowpost/logs/scheduler-<日期>.log` 的尾部 —— 判断当前任务与已用时间；
  ② 今天最新会话目录（`output/<日期>/am_HHMM|pm_HHMM`）里的产物 —— 推断阶段
     （无文件=生成中 / `video.mp4`=已产出正在发布 / `.published`=已发布 / `FAILED`=失败）；
  ③ `schedule.json` 里启用中的闹钟 —— 算「下一个跑什么、还有多久」。
- **不要指望运行中能拿到引擎实时输出**：`scheduler.js` 用 `spawnSync` 跑引擎，
  子进程 stdout 要等退出才一次性回放，所以进度只能靠上面这些落盘信号。
- 验收：`scripts\win-shot.ps1 -ScrollX 800 -ScrollY 500 -Wheel -6 -Out out.png` 可以在窗口内滚动后再截图
  （`-Wheel` 正数向上、负数向下；dwData 必须按 UInt32 补码传，负数写 `4294967176`）。
- 想验证「执行中」样子又不想真跑一次：临时往当天调度器日志追加
  `[时间] 🚀 仅视频 任务开始（超时预算 1800s）`，截完图再把这几行删掉（别截断文件，调度器可能正在写）。


## TikTok 登录：用户名 + 本地 2FA（已验证，别再走弯路）
- **必须用「用户名」登录，不能用邮箱**；入口是登录页的 `Log in with email or username` 链接
  （不是页头 Log in 弹窗、也不是 `/login/phone-or-email` 深链直接填）。
- 流程：`/login` → `Use phone / email / username` → `Log in with email or username`
  → 填用户名 + 密码 → `Log in` → 跳 `/login/2sv/totp` → 填 6 位码 → `Next`。
- 2FA 码**本地生成**，不用等邮箱：账号文件第 5 列是 base32 密钥，
  `totp()` 用 HMAC-SHA1（30 秒窗口）现算；失败自动换下一个时间窗重试（应对时钟偏差）。
- 账号文件格式（全角竖线分隔）：`用户名｜密码｜邮箱｜邮箱密码｜2FA密钥｜地区`；
  解析器同时兼容半角 `|`、制表符、逗号，并自动跳过表头和说明行。
- **按钮都是 `DIV.TUXButton-label`，不是 `<button>`**，`button:has-text()` 选不中；
  可靠做法是 `evaluate` 找出文字完全匹配的最内层元素，拿中心坐标用 `page.mouse.click()`。
- 页面里存在 1×1 的隐藏 `input[type=password]`，取输入框必须过滤尺寸（宽≥60、高≥20、y≥40）。
- 判断成功**看 URL 是否离开 `/login`**（会落在 `/foryou` 或 `/tiktokstudio`），
  不要为了复核再把窗口跳到别处（用户在意窗口内容被带走）。

### 批量登录（方案 A：文件即命令）
```powershell
# 1) 把账号 txt 丢进 import\accounts\（文件名随意）
node scripts/tk-login-batch.mjs --auto --dry-run   # 先看计划：谁登录、谁跳过、要不要建环境
node scripts/tk-login-batch.mjs --auto             # 真跑
```
- 账号 N → 环境 `TK0N`；环境不够会调 `POST /profiles` 自动建 `TK11`…（代理/时区照抄模板环境）。
- 默认**跳过已登录的环境**（`GET /profiles/{env}/cookies?format=json` 里有没有 `sessionid`），
  `--force` 才强制重登（会先去 `/logout`）。其它开关：`--from/--to/--only`、`--gap 60`、
  `--no-create`、`--no-config`。
- 每台登录后：读 cookie 复核 → `GET /profiles/{name}/cookies?format=json` 备份到
  `backups/cookies/<日期>/<环境>.json`（**换机器/环境坏了导入 cookie 就能恢复，不用重登**）。
- 产出：报告 `output/account-login-<时间>.md`（成功/失败/卡在哪一步/截图）、
  截图 `output/login-shots/`、状态 `%APPDATA%\xnowpost\data\env-accounts.json`、
  应用配置 `%APPDATA%\xnowpost\config\user.json` 自动补 `bitEnvId` 与 `username`。
- 处理完的账号文件自动归档到 `import\accounts\done\`。

### 人机验证（captcha）怎么处理
- 滑块/拼图这类**不做自动破解**：成功率低，失败还会加重风控。
- 做法是**人工接管**：检测到验证（文字 + `iframe[src*=captcha]` / `[id*=captcha]` 双保险）后，
  脚本用 Win32 `ShowWindow`+`SetForegroundWindow` 把浏览器窗口顶到最前，打印醒目提示，
  **保持窗口打开**并每 2 秒轮询，你拖完后自动接着走；默认最多等 `--captcha-wait 300` 秒。
- 等待期间窗口被关掉 → 判该号失败，继续下一个号。

## 验证发布链路用演练模式（不产生真实作品）
```powershell
$env:XNOWPOST_PUBLISH_DRY_RUN = "1"    # 填完文案、检查通过后停在发布按钮前
node src/publisher/index.js --env TK01 --max 1
```
演练结束会抛 `演练模式：…`，上层计为「跳过」，**不会**写 `.published` 标记。
截图落在会话目录 `dry-run.png`。

## 发布候选只有一份扫描实现（`src/output-scan.js`，2026-10-19 定的护栏）
别在界面/发布器/主进程里各写一份"哪些内容可以发"。
- 同一个问题原来有三份实现，规则互相不一致，而**无人值守走的正是最松的那份**
  （`src/publisher/index.js`：没有 FAILED 拦截、`--all` 全发、不认 `confirmed`、全部条目发到 `accounts[0]`）。
  实测积压 **57 个未发布会话（14 个带 FAILED，最老 2026-06-18）**，一次 `--all` 就能把两个月的旧内容推出去。
- 统一口径（默认值就是安全值）：**只认当天**；`--any-date` / `includeOld: true` 才放开旧会话；
  **跳过 `.published`**（含 `confirmed:false` —— 重发会产生重复作品）；**跳过 FAILED**，
  但 `FAILED.stage` 属于发布阶段（不含「视频/合成」）的会重试，因为视频本身是好的；
  默认 **每轮最多 3 条**（`DEFAULT_MAX_PER_RUN`，可用 `XNOWPOST_PUBLISH_MAX_PER_RUN` 覆盖）。
- 改规则先改 `tests/unit/output-scan.test.js`（12 例：老会话不进候选、FAILED 分级、
  未确认不重传、坏标记不抛异常、上限截断…）。
- `--all` 现在只表示「当天全部（不限条数）」，**不再**意味着清空历史积压。

## 「点了 Post 但没确认」不许记成功（退出码 3）
- `publishToTikTok` 在"点过 Post 但预算内没能证明已公开"时**不抛错**，只在 `.published`
  里写 `confirmed:false` + `note:'post-clicked-unconfirmed'`。三处调用方原来都照样记 ✅。
- 现在约定：这种结果计「未确认」——**不算成功，也不重发**（重发 = 重复作品/重复计费）：
  `src/publisher/index.js` 计 `unconfirmed` 并退出 **3**；`src/index.js`（引擎自动发布）接
  `options.onUnconfirmed` 回调后写 `FAILED{published:true}`（下一轮据此跳过）并退出 3；
  `scheduler.js` 见退出码 3 记 `⚠️ … 未确认（不重试、不重发，请到后台核对）`。
- 界面「调度进度」用 `END_RE` 判断任务是否结束，所以那行必须以 `⚠️ … 未确认` 结尾
  （`electron/main.js` 的 `END_RE` 里同时认 `✅完成 / ❌失败 / ⚠️未确认 / ⏱️ / ⏭️跳过 / 进程结束`）。

## 失败要知道（`tgBotToken` 是空的，别指望 TG）
- 唯一的对外告警 `sendAlert()` 只走 Telegram，而配置里 token 一直是空的 →
  定时任务失败/被跳过时**没有任何人会知道**（2026-10-18 掉登录空跑 24 分钟就是这么漏的）。
- 现在三条通道，加新告警点时至少覆盖前两条：
  1. **系统通知** `notifyFailure({title, body, key})`（主进程）：`Notification.isSupported()` 保护、
     同一条消息 10 分钟去重、点击聚焦窗口。触发点是调度器输出里的
     `❌ / ⏱️ / ⚠️…未确认 / ⏭️ 跳过`（这些行现在按 `error` 记账，所以「错误 N 条」KPI 才是真的数）
     以及手动发布失败。
  2. **控制台红条**：`store.status.recentErrors > 0` 时显示最新一条错误 + 「看日志」；
     出现新错误会把"已关闭"状态复位。
  3. **日报页「这天发了什么」**：IPC `report:publishDay` 读发布账本（成功）+ 会话目录 FAILED（失败/未确认）。
     账号都没数据时数据日报全是「—」，但这三个数永远是实话。

## 模型名不许写死在安装目录里（`deepseek-chat` 是个会变的别名）
用户 2026-10-19 问「模型是最新的吗、会自动升级吗」。实测三件事：
- `GET https://api.deepseek.com/models` 只列 `deepseek-flash` 和 `deepseek-v4-pro`；
- 用 `deepseek-chat` 请求，**回包里的 `model` 字段是 `deepseek-flash`** —— 老别名被服务端
  **静默路由**了（当天 10 条成片其实都是 flash 出的）；
- `deepseek-v4-pro` 是**推理模型**：同一个 9 分镜口播稿，flash 9.6s / 1893 tokens / 正文 1012 字，
  v4-pro 21.9s / 2257 tokens（其中 **1930 是思考**）/ 正文 856 字；max_tokens 给 120 和 3000
  都返回**空正文**（`finish_reason=length`），给 8000 才有内容。

所以：
- **模型/上限存在数据目录 `config/user.json` 的 `deepseekModel` / `deepseekMaxTokens`**，
  优先级 数据目录 > 代码目录 `config/default.json` > 内置 FALLBACK（`src/engine/config.js` 的
  `readAiOverrides()`）。别再只改 `config/default.json` —— 打包后它在安装目录里，用户改不了。
- 配置页有「文案模型」下拉（列表来自 `/models`）+ 「刷新列表」，并**分开显示「请求的」和「实际的」**：
  只要两者不一致就说明被路由了，这件事必须看得见（`ai:models` IPC 用一个 1 token 请求探测）。
- 选到推理模型时自动把上限提到 **8000**（`REASONING_MIN_MAX_TOKENS`），否则正文会是空的；
  引擎侧 `getDeepSeekConfig()` 对推理模型 + 小 max_tokens 会 warnOnce 说明原因。
- **记账按回包里的真实模型名**：`trackDeepSeek(usage, response.model)`，`cost.json` 多写
  `models[]` 与 `estimated`。价格表只有 `deepseek-chat` 是确认过的，其它模型按它估算并**明确标记**
  （`priceForModel()`），别把未知模型算成 0 元 = 假装免费。
- 「测试连接」改成 **30 秒超时 + 自动重试一次 + 错误分类**（`electron/lib/ai-error.js`）：
  401=Key 无效、402=余额不足、429=限流、5xx=服务端、超时/DNS/传输中断分开说。
  起因：用户截图里的 `Premature close` 被当成 Key 坏了，其实同一把 Key 连打 5 次全通（0.4~0.9s）。
- **主进程里绝对不要用 OpenAI SDK 发 DeepSeek 请求**（这是本轮最值钱的一条）：
  2026-10-19 实测，同一把 Key、同一台机器 —— `node` 里用 SDK 连打 5 次全通（0.4~0.9s），
  但在 **Electron 主进程**里必然 0.6~0.8s 就 `Invalid response body ... Premature close`；
  同时 `GET /models`（axios）和硅基流动生图（axios）都正常。
  所以主进程里统一走 `deepSeekChatMain()`（axios + `node:https`）；
  引擎跑在**独立 node 子进程**里，继续用 SDK 没问题（每天 10 条成片都是它生成的）。
  排查入口：失败时应用日志会写 `DeepSeek 请求失败（第 N 次）：<name> <message>`。


## AI 助手（侧边栏「AI 助手」，2026-10-19 加的）
用户要求：「能不能加 AI 功能，能完成日常复杂的事，或按我的对话去执行/配置」。
答案是能 —— 因为项目已经把"能做的事"全拆成了明确的动作（发布/定时/采集/配置/日报/账号），
助手只要学会调它们，不用另写一套逻辑。

- **三块代码，各管一件事**（改哪块先看注释）：
  - `electron/lib/assistant-tools.js`：**纯逻辑** —— 工具白名单、权限分级（read/write/spend）、
    参数校验、确认卡片文案、脱敏、审计行、上下文裁剪、系统提示词。**安全边界只在这里定义。**
  - `electron/assistant.js`：**执行循环**（问模型 → tool_calls → 执行 → 喂回 → 再问）。
    不 import electron，所以能用假模型/假执行器完整单测。
  - `electron/main.js` 的 `assistantExec()`：**怎么执行**（读真实数据、调既有 IPC）。
  - 界面 `src/renderer/views/Assistant.vue`（路由 `/assistant`）。
- **红线（改之前必须想清楚）**：
  1. **没有**「执行任意命令 / 读写任意文件」的工具。能力 = 白名单，不多一个。
     单测里逐条断言 `exec/shell/run_command/read_file/write_file/eval` 都不存在。
  2. **写操作必须人确认**：模型只能"提议"，界面弹确认卡（显示改动前后）→ 用户点「执行」才落盘。
     没表态 = 拒绝（宁可少做）。校验阶段就拦死配置白名单，**危险改动连确认卡都不会出现**
     （否则用户可能顺手点执行 —— 这条有 4 个单测守着）。
  3. 每次工具调用写 `data/assistant-ledger.jsonl`；Key/密码经 `redactDeep` 脱敏，
     **永不进模型上下文**（`get_accounts` 返回的 password/emailPassword 会被自动替换成 `***`）。
- **复用同一份实现**：`main.js` 里加了 `handle(channel, fn)` 登记表（`ACTIONS`），
  `engine:run` / `publish:run` / `collect:run` / `accounts:list` / `schedule:save` 都改用它注册，
  助手直接 `ACTIONS.get('publish:run')(null, opts)` 调用 —— **不要为助手另写一份"怎么发布"**。
  被复用的处理器不许依赖第一个参数 `event`。
- **发布条数被夹死**：模型传 99 也只发 3 条（`PUBLISH_MAX_PER_TURN` + `clampPublishCount`），
  在预览和执行两处都夹（预览说 3、执行也发 3，不许出现"看到的和做的不是一回事"）。
- **长任务不 await**：`run_engine` / `run_publish` / `run_collect` 起完就返回（`started: true`），
  否则一轮生成 5~15 分钟会把对话卡死。
- **上下文裁剪必须切在 user 边界**：从中间切会留下"孤立 tool 结果 / tool_calls 没结果"→ 服务端 400，
  这一轮的钱白花（`trimHistory` 有单测）。
- 主进程里**仍然只能用 axios 发 DeepSeek 请求**（`assistantCallModel`），原因见上一节。

### 执行结果必须看得见 + 「发成功了吗」要有三态结论（2026-10-19 补）
用户截图反馈原话：「AI 助手的执行结果也不明显，也没有告诉我是否发布成功」「这个 AI 对话执行是不是还差点意思」。
三个问题、三处修：
- **工具行要带人话结论**：界面每个工具行现在是「工具名 + 结论 + 耗时」（`get_pending · 待发 0 条（只算当天）· 95ms`），
  结论来自 `summarizeToolResult(name, result)`（纯函数，有单测）：执行器的 `summary` 优先，其次错误，最后按已知结构兜底。
  以前只显示「工具名 + 毫秒」，用户看到 `run_publish 103ms` 完全不知道发了没发。
- **`get_last_task`（只读）**：把三处证据合起来裁决 —— ① 发布账本（唯一能证明"真发出去了"的东西）；
  ② 当天最近 3 场会话的 `.published` / `FAILED` / 有没有成片；③ 进程还在不在（`engineProcess` / `collectProcess` / 调度器）。
  返回 `verdict` 五态：`running / success / unconfirmed / failed / not_published`，一句话 `verdictText`。
- **系统提示词钉死**：「跑生成/发布/采集只代表**已启动**」→ 用户问发成功没必须再调 `get_last_task`，
  回答第一行就要给 ✅/❌/⏳ 三态结论。**不许把「已启动」说成「已发布」**（有单测守着这句话）。
- 实测：点提示「刚才那条发出去了吗？」→ `get_last_task ✅ 3ms` → 回「✅ 已发布：TK01 · 10:30 ·
  《海外账号运营卡顿？稳定网络是关键》，已确认公开。另外最近 40 分钟内还有两场也已确认发布：am_0915（TK10）、am_0910（TK09）」。

### 发到指定账号：不许再"发到账号 01"（2026-10-19 事故）
真实事故：用户说「TK02 也发布一条视频」，助手跑了生成、又跑了发布，最后**发到了 TK01**，
而且发布已经撤不回来。复盘结论：**这不是模型的错，是链路的错**。
- 根因：`publish:run` 里写死 `const envId = config.accounts[0].bitEnvId`，`opts` 里给什么都不看；
  `doRunEngine()` 也从不传 `--account`。而引擎（`src/index.js`）和发布器（`src/publisher/index.js`）
  **本来就支持** `--account NN --auto-publish` / `--env TKxx` —— 定时任务天天这么跑，只有手动/助手这条路没接上。
- 现在：
  - `electron/lib/publish-target.js` 是**唯一**的目标判定（纯函数 + 9 条单测，`tests/unit/publish-target.test.js`）：
    点名 `account`（"02" 或 "2"）必须命中，点名 `env`（"TK02"）必须命中，
    **命中不了就失败**，报错里列出可选账号；什么都没指定才用 `accounts[0]`，并标记 `explicit:false`
    （界面/日志据此写"默认账号 01"，不许含糊）。
  - `run_engine` 新增 `account` / `autoPublish`：给了账号就 `--account NN --auto-publish`，
    生成完**直接发到那个号**（这正是"XX 号也发一条"的正确动作，一次确认、一条链路）。
  - `run_publish` 新增 `account` / `env`：确认卡上永久写明 `发布 1 条 · 发到账号 02`；
    不写就是「发到默认账号（01）」，让用户在点「执行」之前就看见。
  - 系统提示词第 8 条：用户点名账号就必须带 `account`，「**不许先跑再报告发错号**」。
- 反面教材（这次的原话）：助手回「生成工具不能指定账号，实际用哪个账号由配置决定」——
  这句话在改之前是真的，但正确做法**不是解释限制，而是把限制去掉**。
- 还没做：首页「发布」按钮（`publish:run` 的 UI 入口）目前仍无账号选择器，只能发 accounts[0]；
  要按号发得走助手或定时任务。
### 覆盖面：界面上能点的，助手也要能点（2026-10-19 补）
用户口径：「不光是发布视频，这个项目所有的它都能执行、判断、分析，可以吗」「说白了，就是要像你一样强大」。
缺口是**工具定义**，不是模型能力。补齐后 22 个工具，覆盖全部页面：
- `manage_accounts`（write）：`op=login` 批量登录+备份登录态、`op=sync_profiles` 重抓头像/粉丝、
  `op=edit_profile` 改昵称/简介、`op=launch` / `stop_env` 开关环境。
- `admin_action`（write）：`cancel_engine` / `cancel_collect` / `clear_logs` / `push_report`（推 TG 日报）。
- `get_trend`（read）：最近 N 天各账号趋势（`report:trend` 的形状是 `{ "账号|指标": {...} }`，别当成数组）。
- `backup_cookies`：**执行器早就写在 main.js 里，工具定义却漏了** → 模型根本不知道有这个能力（本次补上）。
- 实现方式：把原来 `ipcMain.handle(...)` 的 `accounts:run / syncProfiles / editProfiles / launch /
  report:trend / report:push / logs:clear` 改成 `handle(...)` 登记进 `ACTIONS`，助手直接调同一份实现。
- **长任务不 await**：登录（10~20 分钟）、拉资料（30 秒/号）、改资料都只返回 `started: true`，
  结果靠 `get_last_task` / `get_logs` 查 —— 和 `run_engine` 一个口径，别把对话卡死。
- 单测 `tests/unit/assistant-coverage.test.js`（8 例）钉住：危险能力（exec/shell/read_file/eval）一个都不许有；
  会动线上账号的必须 `write` 且要确认；预览文案必须写清"要等多久/会开浏览器"；工具总数写死防偷塞。

### 会思考（推理模型）
- 助手用的是配置页那个「文案模型」。选 `deepseek-v4-pro` 就是推理模型：回包多一段 `reasoning_content`，
  循环里单独 push 成 `{role:'reasoning'}`，界面渲染成可折叠的「思考过程（N 字）」（紫色块，默认收起）。
- **`max_tokens` 必须兜到 8000**（`assistantCallModel` 里按 `/reason|v4-pro/i` 判断），给小了正文会是空的。
- 代价：慢约一倍（21.9s vs 9.6s 的实测），所以默认仍是 flash；界面上明确写着怎么换。
### 新建定时任务（助手能加闹钟，2026-10-19 补）
用户原话：「我让 AI 新建闹钟都做不了吗，这个级别有点低呀」——以前的 `schedule_action` 只有
改/启停/删，`create` 缺失，等于「改得动、造不出」。现在：
- `op=create` 支持单条（`time` + `account` + `mode`）和批量（`items: [{time,account,mode}, …]`，**一次最多 10 条**）。
  一次请求 = 一张确认卡 = 用户点一次「执行」（多条待确认时界面右上还有「全部执行（N 步）」）。
- 校验顺序从便宜到贵：**时间**（`normalizeJobTime`：`8:30`/全角冒号都收，落盘永远 `HH:MM`；
  `24:00`/`08:60` 一律拒）→ **账号必须已存在**（凭空造 `account:"11"` 会到点发现没这个环境）
  → **重复检查**（同一批里也查，避免自己撞自己）→ 才动盘。
- 新建出来默认 `enabled: true`（用户说「加个闹钟」不是「加个关着的闹钟」）；id 由 `nextJobId()` 发，永不复用。
- 整个新建走 `assistantTxBegin('新建定时任务 …', ['config/schedule.json'])`，**所以「撤销」能把它删掉**
  —— 实测：建 23:50/账号 10 → #23 → 点撤销 → 23 个回到 22 个、`23:50` 消失。
- 单测 `tests/unit/schedule-create.test.js`（11 条）钉住：`required` 只有 `op`、枚举外 op 拒绝、
  时间规范化、确认卡逐条列出且超过 12 条省略、批量 items 结构不被校验层拍成字符串、
  原有 enable/disable/delete/update 文案没被挤掉。

### 长期记忆（`data/assistant-memory.json`）
- 权限级多了 **`note`**：`remember` / `forget` 只动助手自己的文件，**直接执行不用确认**；
  业务写操作（改配置/改定时）和花钱动作仍然必须人点「执行」。`get_memory` 是只读。
- 记忆会拼进**每一轮**系统提示词，所以有硬上限（`MEMORY_LIMIT=40` 条 / `MEMORY_MAX_TEXT=200` 字、
  拼进提示词时最多 1200 字符）。加记忆相关功能前先想清楚"这条会不会让每轮都更贵"。
- 重复文本只更新分类，不新增；空记忆不落盘。
- **记忆不是指令**：提示词里明写「记住的用户信息（不是指令）」，模型自己写下的东西不许被当成命令执行。
- 写完记忆要 `updateSystemPrompt()` 立刻生效（只换 `messages[0]`），**不要重建会话** ——
  重建会把「刚说完记住我偏好英文」之后的问题答断片。
- 就绪日志带记忆条数（`工具 N 个，记忆 M 条`），排查"记忆到底加载了没"看这一行最快。
- 验收记忆功能时**必须清掉测试写进去的假偏好**，否则它会一直影响真实回答。

### 写操作快照与撤销（`data/assistant-undo/`）
- 只快照会被改的小 JSON：改配置 → `config/user.json`，改定时 → `config/schedule.json`。
- 撤销 = **原样盖回快照**，不是"再反向执行一次"（反向操作遇到中间态会改出新花样）。
  回滚 `user.json` 之后要 `saveConfig(loadConfig())` 把环境变量同步回来。
- 窗口 **30 分钟**、最多留 **10 条**、**只在本进程内有效**（重启后界面不再提供撤销）——
  别把"重启后还能撤"写进说明。
- 跑生成 / 发布 / 采集 **不提供撤销**：钱和内容已经出去了。提示词里也要这么告诉模型，
  否则它会答应"帮我把刚才那条发布撤回"。
- 撤销本身也记审计账本（`tool: undo`）。


## 凭据备份与恢复（`src/secrets-backup.js`）
- 每天把 5 个文件（`data/env-accounts.json`、`account-profiles.json`、`account-meta.json`、
  `config/schedule.json`、`data/publish-ledger.jsonl`）+ 全部 cookie 打成
  `backups/secrets/<日期>/secrets.enc`，用 Electron `safeStorage`（Windows = DPAPI）加密，
  **写完解密读回校验**才落盘；保留 14 天。
- 启动时 `restoreSecretsIfNeeded()` **只补缺失或损坏的文件**，绝不覆盖现有内容（避免拿旧备份盖掉新数据）。
- 边界：DPAPI 是"同一个 Windows 用户"才能解密 —— 换机器/换用户解不开，要人工处理，
  所以**明文塞账号密码仍然是唯一能跨机器恢复的东西**（`env-accounts.json` 本身就是明文，故意为之）。
- 导入账号文件时 `totpSecret`（2FA 密钥）必须写进 `env-accounts.json` —— 老代码解析了但没落盘，
  等于每次导入都把 2FA 丢了（已修）。

