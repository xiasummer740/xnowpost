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

### 架构决策
- 生成+发布原子化：不扫 output 目录，闹钟直接定账号
- 向后兼容：旧 schedule.json 无 `account` 字段 → 不触发自动发布

### 发布资产
- XNOWPost Setup 1.1.0.exe (107 MB)
- XNOWPost Setup 1.1.0.exe.blockmap
- latest.yml
- 向后兼容：旧 schedule.json 无 `account` 字段 → 不触发自动发布
