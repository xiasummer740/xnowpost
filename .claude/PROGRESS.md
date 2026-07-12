## v1.1.2 发布 (2026-07-05)
- 版本: 1.1.1 → 1.1.2（patch）
- [v1.1.2 Release](https://github.com/xiasummer740/xnowpost/releases/tag/v1.1.2)
- 3 个资产: XNOWPost.Setup.1.1.2.exe + blockmap + latest.yml

### 修复（两轮审查共 11 项）
**GPU 兼容性**
- start-dev.ps1 + npm run dev 改用 `--use-gl=swiftshader --no-sandbox`

**稳定性**
- 引擎子进程手动 setTimeout 替代不可靠的 spawn timeout
- Store + IPC 日志限 500 条防 OOM
- session:read 图片 base64 加 2MB 单张限制
- Dashboard 轮询加 document.hidden 检测，后台暂停

**安全/健壮**
- CSP 补充 `media-src 'none'`
- config:test 直接传 Key，不再先 saveConfig 再测试
- loadWinState 校验窗口坐标在可见屏幕内

**体验**
- 全局 body → 14px，最小字号提到 13px
- Schedule.vue alert() 改 UI banner
- 移除了 dead dependency: better-sqlite3（与 Electron 43 编译冲突）

## v1.1.3 发布 (2026-07-08)
- 版本: 1.1.2 → 1.1.3
- [v1.1.3 Release](https://github.com/xiasummer740/xnowpost/releases/tag/v1.1.3)
- 安装包: `XNOWPost-Setup-1.1.3.exe`（固定 artifactName，不带空格）

### 全功能优化 26 项（Sprint 1-4）
**Sprint 1 — 基础加固**
- IPC 降级：非 Electron 环境显示"需要桌面版"遮罩
- Hash 路由：`createMemoryHistory` → `createWebHashHistory`，刷新保持路由
- 轮询修复：Schedule removeJob 清理 searchTexts 泄漏
- Dashboard 轮询已有 document.hidden + onUnmounted（已验证不需改）

**Sprint 2 — 体验提升**
- Config 前端验证：Key 格式校验（sk-开头/长度/TG Token 正则）
- History 详情面板加固层遮罩 + 点击外部关闭 + 小屏全宽
- Dashboard 轮询优化：状态变化驱动刷新，减少 66% IPC 调用
- 常量抽取：`src/renderer/constants.js`（platformNames/metricLabels/formatNum 等）

**Sprint 3 — 代码整洁**
- Logs 页日志级别筛选 tabs（全部/成功/错误/警告/信息）
- 取消按钮旋转动画（CSS ::before 伪元素 spinner）
- `JSON.parse(JSON.stringify)` ×3 → `structuredClone`
- TS 类型声明：`src/types/electron.d.ts` 完整 XnowpostAPI 接口
- Config 错误提示 5s 自动消失
- aria-label：5 个 👁️ 按钮加辅助功能标签

### 功能强化（Phase 1 — 发布流程）
- **发布卡片**：Dashboard 展示待发布内容列表，一键发布全部
- **系统状态卡**：引擎/调度器/错误数/配置 四项状态指示灯
- **完成通知**：引擎生成完弹出绿色横幅 + 立即发布按钮
- IPC 扩展：`publish:pending` 扫描未发布内容，`engine:status` 加 `recentErrors`

### 功能强化（Phase 2 — 效率工具）
- **新手引导**：首次使用 3 步引导弹窗（配 Key→加账号→设闹钟）
- **批量生成**：Dashboard 批量模式，多主题逐行输入→排队生成→进度 2/5
- **趋势折线图**：SVG 无依赖实现，DailyReport 展示 7 天粉丝/播放趋势
- IPC 扩展：`report:trend` 批量查 N 天数据

### 功能强化（Phase 3 — 运维能力）
- **日志历史**：日期选择器按日加载历史日志文件
- **CSV 导出**：DailyReport 一键导出报表数据
- **错误通知**：引擎连续 2 次失败 → 桌面 Notification + Dashboard 红条
- **内容预览**：生成后直接在 Dashboard 展示文案+图片

### Bug 修复
- **自动升级卡 0%**：`electron-builder.yml` 加 `artifactName`，安装包文件名与 `latest.yml` 一致

## v1.1.4 发布 (2026-07-10)
- 版本: 1.1.3 → 1.1.4（patch）
- [v1.1.4 Release](https://github.com/xiasummer740/xnowpost/releases/tag/v1.1.4)
- 安装包: `XNOWPost-Setup-1.1.4.exe`

### 🐛 修复
1. **日报无数据（打包版）** — collector 硬编码 `path.resolve('data/analytics.db')`，打包后 CWD 指向 `app.asar.unpacked`，而主进程从 `%APPDATA%/xnowpost/data/` 读取 → 路径不一致 → 日报永远"暂无日报数据"
   - 修复：collector 改用 `process.env.XNOWPOST_DATA_DIR` 环境变量，与 organizer.js 保持一致
   - 连带修复 `CONFIG_PATH`、`ACCOUNT_META_PATH`、`collect-meta.json` 保存路径
2. **调度器状态卡死** — `schedulerRunning` 标志位只匹配英文关键词（done/complete），调度器输出中文「✅ 完成」→ 永远不重置
   - 修复：检测关键词增加中文「完成」「失败」「开始」
3. **定时采集不传账号** — 采集面板保存了 `collectAccounts` 但 scheduler 的 `runJob('collect')` 没传 `--accounts` 参数
   - 修复：scheduler.js 加入 `accFlag`

### 🆕 改进
4. **日报仪表盘可视化** — KPI 汇总行（总播放/主页访问/总点赞/总评论/总粉丝）+ 每个账号柱状对比条（蓝色今日/灰色昨日）

### 数据迁移（已完成）
- 项目根目录 `data/analytics.db` → `%APPDATA%/xnowpost/data/analytics.db`
- 包含 6/27-7/1 共 219 条历史记录

## 下个对话待办

1. **多平台发布扩展** — 小红书/Facebook/Instagram/YouTube/X 的 publisher 模块
2. **TikTok 发布器重构** — 当前 663 行，超规则 300 行上限 2 倍，需拆文件
3. **TikTok 发布器错误重试** — 网络断开/环境关闭时无重试机制
4. **多账号多闹钟生产配置** — 创建 10 个账号 + 10 个闹钟
5. **多平台 scraper URL 补全** — 小红书/Facebook/Instagram/YouTube/X 的 URL 仍是 `#待祥哥提供URL`
  - scraper 多源探测：body/title/URL 三路找 @username
  - 采集后自动写回 user.json 配置，日报从配置读取
  - 新增 profileUrlFor() 各平台主页链接生成
  - 回退手动输入框，全自动无需填写

## v1.2.4 发布 (2026-07-11)
- 版本: 1.1.4 → 1.2.4（patch，v1.2.0~1.2.3 已全部删除）
- [v1.2.4 Release](https://github.com/xiasummer740/xnowpost/releases/tag/v1.2.4)
- 安装包: `XNOWPost-Setup-1.2.4.exe`

### ✨ 新增
- **可配置数据存储目录** — 配置页选择任意目录，一键迁移
- **一键重启** — 迁移后显示「立即重启」按钮

### 🐛 修复
- **保存配置报错** — JSON 深拷贝剥离 Vue Proxy
- **数据目录自动回退** — 被更新覆盖时自动恢复
- **禁止迁到安装目录** — 防止升级清数据
- **复制闹钟无反应** — structuredClone 遇 Vue Proxy 不报错也不执行，改用 JSON 深拷贝

## v1.2.5 发布 (2026-07-11)
- 版本: 1.2.4 → 1.2.5（patch）
- [v1.2.5 Release](https://github.com/xiasummer740/xnowpost/releases/tag/v1.2.5)

### 🐛 修复
- **TikTok Content check 提前发布** — 旧策略等「音乐版权检查」文字就点发布，没等「内容快速检查」
  - 新策略等 Post 按钮 data-disabled 变为 false 才点，这是 TikTok 自己的"全部检查通过"信号
  - "检查尚未完成"弹窗改取消不强制发，避免重复浪费

## v1.2.14 发布 (2026-07-12)
- 版本: 1.2.13 → 1.2.14（patch，v1.2.0~1.2.13 已全部删除）
- [v1.2.14 Release](https://github.com/xiasummer740/xnowpost/releases/tag/v1.2.14)

### 🐛 关键修复
- **Content check 误判** — `includes('未发现问题')` 从音乐版权借词，误判内容检查已过
  修复：`lastIndexOf > indexOf 内容快速检查` 验证位置
- **检查通过后等10秒再发布** — 防 TikTok 缓冲
- **调度器状态即时推送** — scheduler 输出"开始"标记触发前端即时更新
- **控制台时间 UTC 问题** — 改为北京时间显示
- **保存配置报错** — JSON 深拷贝剥离 Vue Proxy
- **数据目录自动回退** — 被更新覆盖时自动恢复；禁止迁到安装目录
- **复制闹钟、保存配置无反应** — structuredClone 遇 Vue Proxy，改 JSON 深拷贝
- **自动更新错误不再沉默** — 前端显示错误原因；删陈旧 latest.yml(v1.0.14)
- **安装路径统一** — oneClick: true，自动升级不再装到不同路径
- **发布流程每步加确认日志** — 检查通过→按钮可点→已点击→等待处理→等待审查

## 本轮完成
- [时间选择器 bug 修复+体验优化] 三个问题一起修
  - 根因1：`scrollToCenter` 公式`(1+index)*36-90+18` 多减了36px → 选中偏移1格
  - 修复：`scrollTop = index * CELL_H`
  - 根因2：鼠标滚轮每tick滚动~108px = 3格 → 跳选
  - 修复：`@wheel` 劫持滚轮，e.preventDefault()，每tick仅+1/-1
  - 根因3：点击单元格后scroll位置不跟随
  - 修复：`selectHour/selectMin` 函数同时设值+滚动
  - 初始化：`requestAnimationFrame` 确保布局完成后再设scrollTop
- [better-sqlite3 → sql.js 迁移] 原生模块版本不匹配无法编译
  - 创建 `src/db.js` 统一封装 sql.js 的 openDB/ensureDB API
  - 重构 collector、daily、trends、main.js 中所有 DB 操作
  - 纯 JS 实现，不再依赖原生编译
- [TikTok 采集适配] 新版 TikTok Studio 页面
  - 旧选择器 `[data-testid="followers-count"]` 失效
  - 改为 textContent 文本扫描提取数据（views/likes/comments/shares）
  - `waitUntil: 'domcontentloaded'` 替代 `networkidle`（React 页面持续有网络活动）
- [日报页面 📊] 全新页面展示采集数据
  - 日期前后切换（← ▶ →）
  - 平台数据卡片（粉丝/播放/点赞/评论/分享）
  - 昨日对比（↑ 绿色 / ↓ 红色）
  - 摘要文本区（类 TG 推送格式）
  - 侧边栏新入口「📊 日报」
- [多账号支持] 采集器 + 日报页面
  - 配置页「账号管理」区块（名称/平台/比特环境ID）
  - `browser.js` 新增 `openBitProfile()` — 走比特API `localhost:54345/browser/open`
  - 采集器循环账号列表，逐个打开环境采集→关闭
  - 数据库 `daily_stats` 加 `account` 字段 + schema 迁移
  - 日报页顶部账号 tab 切换，每个账号独立展示数据
- [v1.0.15发布] 时间选择器升级 + CMD 窗口消除
  - electron-builder GitHub Release + tag v1.0.15
  - 3 个资产完整（exe + blockmap + latest.yml）

- [v1.0.8发布] 安装版打包 + GitHub Release + 自动更新机制
- [自动更新] electron-updater + 侧边栏红点角标 + 关于弹窗
- [安装版崩溃修复] 
  - electron-updater CJS/ESM 加载兼容
  - 调度器 spawn 路径指向 app.asar.unpacked
  - healthCheck execSync 加 windowsHide:true
  - 全局崩溃日志（crash.log）
- [文案丰富化] 提示词从1种风格扩展到8种（揭秘/故事/对比/教程/反常识等）
- [VPN业务接入] 提示词+策略模块加入VPN宣传方向
- [闹钟默认关闭] 默认全部 disabled，用户按需开启
- [采集日报修复] 浏览器连不上不再静默跳过，有历史数据也生成日报
- [调度器清理] 删除重复的 daily.js 独立调用
- [开发版标识] 窗口标题 + 侧边栏标签，单实例锁
- [CMD弹窗] 全部 execSync/spawn 加 windowsHide
- [产出目录] FFmpeg 直接输出到最终位置，try-finally保底清理
- [费用记录] cost.json pipeline 开始前先保存
- [调度器] 桌面版自动启动，崩溃自愈
- [UI] 闹钟页面重写、首页调度器状态/产出时间/数据概览
- [v1.0.9] 修复视频输出残缺（表层修复）— FFmpeg 两步写入，防止被杀留下残缺 MP4
- [v1.0.10] 修复 FFmpeg 管道死锁（根因修复）— stderr 重定向 2>nul，切断管道缓冲区写阻塞
  - 真正根因：FFmpeg stderr ~8KB 超过 Windows 匿名管道默认缓冲区 4KB
  - 导致：FFmpeg 卡住 → 引擎卡 → 调度器 10min 超时 → 全进程树被 kill
  - 附带：调度器重试 → "隔11分钟自动生成"的假象
- [v1.0.11] NSIS oneClick: true — 自动更新静默安装，不弹安装向导
- [v1.0.12] NSIS 恢复向导安装，支持自定义安装路径（allowToChangeInstallationDirectory: true）
  - 根因：v1.0.11 oneClick 不提权，读不到旧版注册表，安装目录不一致
  - 祥哥情况：v1.0.8 装在 E:\software\XNOWPost（自定义路径），oneClick 装到 %APPDATA%，两个版本并存
- [v1.0.13] 修复视频合成极慢导致超时的问题
  - 根因：FFmpeg 默认 yuv444p（4:4:4 极慢编码）+ preset medium + crf 18
  - 18 秒视频编码 8 分钟，卡在调度器 10 分钟超时边界
  - 修复：-pix_fmt yuv420p + -preset veryfast -crf 23（速度快 10-20 倍）
  - 调度器超时从 10 分钟提升到 15 分钟
- [v1.0.14] 修复 FFmpeg bat 文件中转导致 0 字节文件的问题
  - 根因：bat 文件通过 cmd.exe 中转执行 FFmpeg，管道重定向冲突导致输出 0 字节
  - 修复：去掉 bat 文件，直接 execSync + cwd:dirPath 调用 FFmpeg
  - stderr 改用 stdio:['pipe','pipe','ignore'] 防管道死锁（替代 2>nul）
  - 增加 size > 0 检查防止虚假成功

## 关键决策
- v1.0.12 恢复 NSIS 向导安装（oneClick: false），支持自定义路径
- v1.0.13 FFmpeg 以速度优先，放弃最高质量（yuv420p+veryfast 仍是高清画质）
- 后续版本自动更新时，NSIS 会从注册表读取旧安装目录，自动填好路径
- FFmpeg stderr 2>nul：不经过管道，防止缓冲区死锁。FFmpeg 错误通过 exit code 捕获
- scheduler 和 engine 分开进程：隔离崩溃，调度器挂了自动重启
- 提示词多风格+多产品：AI 随机选择不同方向和产品
- 安装版路径：调度器用 app.asar.unpacked，引擎已经有解包路径
- **better-sqlite3 → sql.js**：原生模块版本不匹配且缺 ClangCL 编译工具，换纯 JS SQLite
- **采集器走比特 API**：不再依赖 CDP 端口直连，改调 `localhost:54345/browser/open`
- **多账号数据隔离**：数据库加 `account` 字段，日报页按账号 tab 分组
- **时间选择器 @wheel 劫持**：CSS scroll-snap 在 Electron 中不可靠，改 JS 直接控制每格滚动

## 本轮完成
- [TikTok 自动发布模块] 新建 `src/publisher/` 模块
  - `publisher/index.js` — 发布器入口，扫描未发布内容 → 调用各平台发布器
  - `publisher/tiktok.js` — TikTok Studio 上传发布（Playwright + 比特浏览器）
  - `Schedule.vue` 新增「自动发布」模式 + 调度器 `publish` 任务类型
  - 首页新增「📤 发布」按钮，IPC `publish:run` 一键触发
- [比特环境 ID 探测] 从 db.sqlite 查出环境为 UUID 格式
  - `browser_persistent_data` 表查到 4 个 browser_id，2 个可用环境
  - 可用环境: `24056554bc0e479784f054c161670a53` ✅ / `fee00b3d51cb41bfbe517ff2c25f0ec4`（同 API Key，打不开）
  - `browser.js` 修复：环境 ID 和 API Key 相同时不传 key 防止 API 混淆
  - `config:testBit` 增加环境探测逻辑（UUID 探测 + 打开测试）
- [无 CMD 弹窗启动] 所有启动命令加 `WindowStyle Hidden`
- [v1.0.16 发布] 版本推进，68 个单元测试全部通过

## 本轮完成 (v1.0.17-dev)
- [TikTok 发布器 AI 开关修复] dispatchEvent + wait 600ms 解决点击问题
  - 根因：`aigc_container` 在 DOM 里但 CSS 计算尺寸为 0 → `isVisible()` 拒点，force click 也被浏览器层拦截
  - 修复：`dispatchEvent(new MouseEvent('click'))` 绕开可见性检查，**拆成两步**：dispatch → wait 600ms 等 React 渲染 → 再检查 `aria-checked`
  - force click 保留为第一策略兜底
- [TikTok 发布器 Post 按钮修复] 两条 bug
  - `data-e2e="post_video_button"`（下划线）实际正确，但旧代码只搜了 `post-video-btn`（连字符）
  - `isDisabled()` 超时默认 `true` → 按钮被跳过。改用 `getAttribute('data-disabled')`
- [BrowserTracer 模块] 新建 `src/publisher/debug-trace.js` — 纯文本操作追踪器
  - `trace.step()` 包裹每个操作，自动捕获前后 DOM 状态（switch/按钮/dialog/URL）
  - 输出 `browser-trace.json`，兼容 DeepSeek 等不支持图片的大模型
- [v1.0.17-dev] 版本推进

## 遗留问题
- **TikTok 发布器退出弹窗** ✅ 已修复
- **TikTok 发布器 AI 开关** ✅ 已修复（dispatchEvent + wait 600ms）
- **TikTok 发布器 Post 按钮** ✅ 已修复（正确 data-e2e + 禁用状态检测）
- **TikTok 发布器核心流程**：全部通过 ✅
- **fee00b3d51cb41bfbe517ff2c25f0ec4 无法打开** — 既是 API Key 又是环境 ID，API 混淆
  - 实际可用环境仅 `31bea5b146af40f58b2a6eae0e2c2a6b` 一个
- **多平台 scraper URL** — 小红书/Facebook/Instagram/YouTube/X 的 URL 仍是 `#待祥哥提供URL`
- **TG 推送 404** — bot token 未配或频道 ID 无效

---

## v1.1.0 发布 (2026-06-22)

### 功能
- [闹钟账号自动发布] 闹钟新增「账号」选择器，生成后直接发布到指定账号
  - Schedule.vue 新增 `accounts` 下拉列表（从 config.accounts 加载）
  - scheduler.js 将 `--auto-publish --account <name>` 传给引擎
  - index.js 新增 `--auto-publish` 解析+调用 tiktok.js
  - tiktok.js Post 后立即写 `.published`（不等 35s）
- [自动更新就绪] electron-builder GitHub Release 发布流程，面板已有红点+下载+安装

### Bug 修复
- [重复发布] Post 点击后立即写 `.published`，防止 trace.save/page.close 失败导致重发
- [清理错误不抛] `postedYet=true` 时清理失败不抛错，不阻塞调用方
- [安装包缺少 publisher 模块] electron-builder.yml 补 `src/publisher/**/*` 白名单
- [安装包文件名] 修正 GitHub Release 资产名（空格→短横线，对齐 latest.yml）
- [Content check 未完成就发布] 填标题后、Post 前，轮询检测 "No issues found" 最多 5 分钟

### 架构决策
- 生成+发布原子化：不扫 output 目录，闹钟直接定账号
- 向后兼容：旧 schedule.json 无 `account` 字段 → 不触发自动发布

### 发布资产
- XNOWPost Setup 1.1.0.exe (107 MB)
- XNOWPost Setup 1.1.0.exe.blockmap
- latest.yml

---

## v1.1.1-dev (2026-06-23)

### Bug 修复
- [postedYet 作用域 Bug] `let postedYet` 声明在 try 块内 → catch 访问不到 → 发布报错
  - 移到 try 外面，同时作用域可用
- [Content check 等待] 发布前轮询检测 "No issues found" 后点 Post，最长 5 分钟
  - 检测到违规文字（content violation/copyright 等）直接中止并抛错
  - tiktok.js 快速检测 + 等待循环（每 5 秒），不卡死

### 优化
- [AI 提示词 TikTok 合规] content_video.txt / content_post.txt 加 5 条合规要求
  - 禁止虚假宣传、对比贬低、诱导互动
  - 用"增长方案""曝光提升"等自然表述替代"买粉""刷量"

### 下个对话优先级
1. **多账号多闹钟配置** — 创建 10 个账号 + 10 个闹钟的生产环境
2. **多平台发布扩展** — 小红书/Facebook/Instagram/YouTube/X

### 本轮修复 (2026-06-24)
- **[Content check 假失败]** 负面关键词"违规/版权"匹配到页面无关文字，首次检查即抛错
  - 根因：document.body.innerText 含页脚版权信息等，includes('违规') 第一轮 5s 循环就命中
  - 修复：去掉所有负面关键词检测，只正向等待 "No issues found" / "未发现问题"
  - 超时后不抛错，继续尝试发布
- **[自动发布不重试]** 发布失败不再重跑完整 engine（避免浪费 API 费用）
  - 根因：scheduler unWithRetry 每次重试都跑 src/index.js 生成全新内容
  - 日志表现为文件夹: am_1121 → am_1123 → am_1126（3 次不同内容）
  - 修复：--auto-publish 任务首次失败即停止，不重试

### 本轮完成 (2026-06-24)
- **[发布流程全线修复]** 闹钟自动发布全部跑通
  - Content check: 去掉负面关键词误杀 + 加中文"未发现问题"检测 + 延长到10分钟
  - 弹窗处理: "检查尚未完成"等10s后点"立即发布" + 空白弹窗保守dismiss
  - Post按钮: 追加dispatchEvent兜底，不怕浮层遮挡
  - 窗口关闭: 跳转到/content页 → 等"内容审查中"消失 + "仅自己"→"所有人" → 才关窗口
  - 比特API关闭: 修复 callBitAPI 误判 close 成功为失败（data:"操作成功"不是 data.ws）
  - scheduler: 自动发布模式不重试（避免重跑engine浪费钱）
  - fs.writeJsonSync: import fs→fs-extra
- **[闹钟页面UI优化]**
  - 两列网格布局，账号搜索输入框（打字即过滤）
  - 彩色账号标签，📋复制按钮，颜色提亮（背景 #2a3a4e，文字 #cbd5e1）
- **[控制台状态同步]**
  - statusText 精确显示: 空闲/引擎运行中/调度器执行中
  - 快捷生成栏在运行时隐藏（闹钟全自动）

## 本轮完成 (2026-06-27)
- **[CMD 弹窗根治]** 
  - 根因：`process.execPath` 指向 `electron.exe`（GUI程序），`windowsHide` 对它无效
  - 修复：所有 spawn/execSync 改用真正的 `node.exe`
  - `package.json` dev 脚本绕过 `.cmd` 批处理
- **[闹钟页改版]** flex弹性布局 + 按账号分组 + 去掉采集/发布模式 + 标签随模式
- **[独立采集面板]** 勾选账号→采集 + 定时采集持久化
- **[日报页优化]** 全量展示 + 🔄刷新/📤推送 + 窗口位置记忆
- **[TikTok 采集增强]** 关键词补全 + 支持 `|` 布局 + 新增指标 + @用户名提取 + 🔗主页链接
- **[比特窗口防堆积]** 采集前 `closeAllBitProfiles()` 清理残留窗口
