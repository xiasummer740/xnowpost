# 接力开发 — 新对话从这里开始

> 更新：2026-10-19 22:40 ｜ 版本 **1.6.37**（已打包、已部署、已重启验证）

## 1S（v1.6.35–1.6.37）第二轮实测 + 「跑完自动回报」
用户口径：「修 A B，另外截图的，能不需要我重复问吗，发布完成后 自动返回结果状态，
可以吗？不然我还要一直看着时间守着」。

### A. 日志自己说谎（检查超时却写「检查已通过」）
- 实测 pm_2214：829 行先打「⏭️ 检查还在跑但 Post 已可点（等了 90s），放行发布」，
  846 行紧接着打「⏳ 检查已通过，等 3s 后发布」—— 同一件事两种结论。
- `src/publisher/tiktok.js` 新增 `checksTimedOut`：超时分支置 true，放行后按它分两句
  （「检查未完成（超时放行）」/「检查已通过」），并补一行提醒点 Post 后可能再弹确认框。

### B. 「Continue to post?」弹窗被当成未知浮层
- 实测 22:17（TK04）：检查卡满 90 秒放行 → 点 Post → TikTok 弹
  「Continue to post? We're still checking your video…[Cancel | Post now]」，
  规则表里没有 → 日志「👁️ 未知浮层（不点，只记录）」，靠二次兜底才点成功。
- `dialogs.js` 新增规则**检查未完成确认框**（点 Post now，绝不点 Cancel）；
  新增 `allowDanger` 机制：`post` 在 DANGER_LABELS 里，规则可逐条豁免危险词
  （⚠️ `handleDialogs` 里给页面侧的映射必须带上 `allowDanger`，漏传就"命中但一个按钮都点不到"）。
- `page-sense.js` 的 `OVERLAY_POLICY` 同步加 `checksPending`，**排在「通用确认」之前**
  （否则同框里有 OK/Got it 会先命中它，点 Cancel = 取消发布）。
- 单测：dialogs +1（20 个），assistant-loop +1（15 个），全量 **501 pass**。

### C. 助手跑完自动回报（用户不用守着问）
- 链路：`doRunEngine.finish()` → `onAssistantRunDone(outcome, error)` → `reportAssistantRun()`
  → `session.notify(text)`（写 `messages` + `view`，带 `auto:true`）→ `assistant:update` IPC
  → preload `onAssistantUpdate` → `Assistant.vue` 订阅后 `applyResult()`。
- 内容全用落盘证据（`.published`/`FAILED`/`cost.json`/账本标题），六种结局：
  已发布 / 失败 / 成片好了未发 / 只出文案 / 取消 / 异常退出。
- **踩坑 1**：钩子赋值写成 `reportAssistantRun()` 的第一行 → 只有"回报过一次"之后才挂上，
  于是永远不回报（22:30 pm_2229 跑完一条都没发）。必须放在函数定义之后。
- **踩坑 2**：`assistantRunWatch` 一开始写在 `setupIPC()` 里，而读它的 `finish()` 在顶层
  `doRunEngine()` → 作用域断裂。变量与钩子都放模块顶层。
- 数字口径：11 秒别写「1 分钟」（<90 秒报秒）；¥0.0039 别写「¥0.00」（<0.1 保留三位）。

### D. 顺带发现：`mode=text` 是假的（助手说 ¥0.01，实际跑了整条视频）
- 22:29 实测：助手答「只生成文案（mode=text，约 ¥0.01），不发布」，日志却是
  `node src/index.js`（无参数 = auto）→ 真跑了配音+封面+合成，多花 ¥0.02、多等 3 分钟。
- 根因：`doRunEngine` 只映射 video/post，`text` 落到 `[]`；引擎也没有 `--text-only`。
- 现在：引擎新增 **`--text-only`**（只调 DeepSeek + 写 `文案.txt`/`描述.txt`，
  不配音/不生图/不合成/不发布；不要求硅基流动 Key；与 `--auto-publish` 组合直接报错）；
  文案写法抽成 `writeContentFiles()` 供视频流程和 text 模式共用（别复制两份会漂移）。
- 实测：22:31:44 → 22:31:55，**11 秒、¥0.01、目录里只有 文案.txt/描述.txt/cost.json**。
- 确认卡也随之改口径：tag 只写「会花钱」，正文写「只出文案…不发布」，不再吓唬「会发布」。

### 验收（真应用、真提问，output/ 里有图）
- v1636-b/c.png：只出文案 → 4 秒后对话里自动出现「📝 文案好了（1 分钟）…¥0.00」（旧口径）
- v1637-a.png：确认卡新口径；v1637-b.png：自动回报「📝 文案好了（4 秒）…¥0.004」
- 未验证：A/B 要等一次"真发布且检查超时"的轮次才看得到（下一轮闹钟或手动发 pm_2229）。

## 1R（v1.6.32–1.6.34）AI 助手实测：它说了三句假话，全修了
用户口径：「我准备发消息 你监测整个过程 找找问题」→「一起修」。
监测手段：scripts\_watch-assistant.ps1 同时 tail logs\app-<日期>.log + data\assistant-ledger.jsonl
（每次工具调用带 ms/ok/brief），配合 win-shot.ps1 抓界面。

- **P0 时间少 8 小时**：助手答「已发布：TK03 · 13:43」，实际 21:43。
  get_last_task 里 
ew Date(at).toISOString().slice(11,16) 取的是 UTC。
  新增 localHHMM()（main.js 模块级），**以后任何时间显示都不许再用 toISOString 切片**。
- **P0 「还在生成」是假的**：21:40 助手说「pm_1911 还在生成」，实际那轮 19:11:27 起来、19:11:30 就被取消
  （目录里只剩 cost.json，¥0）。原判定「没有成片/发布/失败标记 ⇒ 还在生成」。
  现在 eadSessionRow() 带上 iles/ageMin/hasText，describeSession() 分五种状态，
  15 分钟没动静且没有进程 ⇒ erdict='stalled'（黄色）。
- **P0 「待发 0」与首页「27 项」矛盾**：get_status 原来 onlyToday:true 只数当天。
  改用 .pending 口径（和首页/get_pending 同一份数据）：待发 当天 0 条（另有历史 27 条…）。
  ⚠️ 用 pending 不要用 items：items 是"本轮能发的候选"，old 标记只在 pending 里。
- **P1 费用少算 2/3**：确认卡写「约 ¥0.01」，实际 ¥0.03（DeepSeek 0.0116 + 封面 Kolors 0.02）。
  三处文案统一成「一条视频约 ¥0.03 = 文案 ¥0.01 + 封面生图 ¥0.02」。
- **P2 等待期看不到阶段**：currentStage() 读今天 app 日志尾部 80 行，映射成
  写文案/配音/找素材/做封面/合成/上传/填文案/等检查/等审查，get_last_task 与 get_status 都带 stage。
- **P2 点名某一轮答非所问**：实测助手把 21:43 的成功当成 pm_1911 的结果，还自己编「它只生成了文案」。
  get_last_task 新增 session 参数（pm_1911 / 2026-10-19/pm_1911），命中只答那一场；
  不带参数时也附一句 最近一场：…。system prompt 加第 10 条。
- **P2 中文被画红波浪线**：Assistant.vue 输入框补 spellcheck="false" autocorrect="off"。
- **额外：发布按钮双击**：19:11:13 与 19:11:15 各跑一次「手动发布开始」，各扫 307 条。
  publish:run 加重入保护 + 3 秒去抖（publishInFlight / publishLastAt）。
- **重复日志**：✅ video.mp4 (x.xMB) 曾打两遍（video.js 与 index.js 各一次）；
  「TG 未配置」notifier 与调用方各打一条 —— index.js 两处删掉。
- 验收（真应用、真提问）：output/v1633-assist-1.png（点名 pm_1911 → stalled 结论 + ¥0.03）、
  output/v1634-assist-1.png（待发 当天 0 / 历史 27）、output/v1632-assist-1.png（21:43 本地时间）。
- 未验证：重复日志那两行要等下一轮真生成（00:30 闹钟）才看得到。
## 1Q（v1.6.23–1.6.31）全项目「重复 / 啰嗦 / 功能不清楚」清理
- 用户口径：「再全面审查整个项目 模块 按钮 功能 等等全方位，有没有像刚才一样重复 啰嗦，功能不清楚的」，
  确认「一起做」（两批一起改），只把「TG 没配就整轮记失败」留到后面单独做。
- **首页**（1766 → 1318 行）删掉 6 张汇总卡（系统状态 4 个 KPI / 调度执行进度 / 最近费用 / 采集数据概览 /
  今日产出 / 最近日志）—— 它们都是别的页面的摘要，和「一眼看懂今天该干什么」抢位置。
  连带删掉 15 个死函数/常量（refreshToday / refreshCollectData / refreshProgress / handleCollect /
  loadThumbnails / sched+stepIndex / logExpanded / displayLogs / consecutiveFailures …），
  `onMounted` 只剩「拉待发布 + 读账号 + 15 秒轮询 + 进度/状态订阅」。
  主题输入框的 `@keyup.enter` 从已删的 `quickGenerate` 改到 `runAuto`；三个生成按钮统一走
  `generate(mode)`，主题不再被静默丢掉。
- **定时页**：采集面板的独立「保存」（会用磁盘旧数据盖掉未保存的闹钟改动）删除，
  采集时间/账号/启用开关并入顶部「保存全部」；闹钟卡从 3 排 9 控件压成 1 行
  （开关/时间/模式/账号/自动发布|仅生成/复制/删除），名称输入框删除
  （它的值会被 `setMode()` 覆盖，看着能改实际改了不算）。采集期间新增「取消采集」按钮（调 `collect:cancel`）。
- **日志页**：「🗑️ 清空」改「🧹 清屏」+ 水位线过滤（以前只清内存 500 行，5 秒后被文件重读顶回来，是假按钮）；
  统计条显示「已清屏 N 行 · 点这里恢复」。两个原生 `alert()` 换成应用内日志/提示。
- **历史页**：卡片右侧新增发布状态（✅ 已发 TKxx / ⚠️ 未确认 / ❌ 失败 / 待发）+ 会话名 + 时间；
  `history:list` 同时返回 `published/confirmOk/publishEnv/publishedAt/failed`。卡片样式改回主题变量。
- **账号页**：行内两个纯图标按钮补文字（抓资料 / 改资料）；顶部「刷新」→「刷新状态」、
  「拉取资料」→「抓全部资料」（一个只读本地状态、一个要开 10 个环境）。
- **日报页**：工具栏图标补文字（刷新 / 推送 TG / 导出 CSV），导出不再是红色（红=失败专用）；
  10 个账号的「一卡三段带进度条」换成一张表（账号/平台/用户名/粉丝/关注/获赞/播放/点赞/评论），
  没采到的仍显示「—」并保留原因；头部补「最近一次 ¥x」（首页最近费用卡的落点）。
- 顺手删掉无人调用的 `ping` IPC（preload + main）。`npm run verify` 499 测试全绿。

- **收尾微调（1.6.24–1.6.31，都是截图验收后现场发现的）**：
  - 日报 KPI 只渲染这天真有数的指标（5 张卡 4 张「—」等于用首屏说"什么都没有"），卡片固定 210px 不拉伸。
  - 账号页：操作列加宽后「最后发布」被按钮压字、邮箱/IP 被截断 →
    操作列 238px、账号列 234px、IP 字号 9.5px，行内「抓资料/改资料」去掉冗余图标（有文字时图标只是重复信息）。
  - 定时页闹钟行：账号框固定 200px，「自动发布 + 复制 + 删除」用 `margin-left:auto` 贴右。
- 每次改完都 `npm run verify`（499 → 0 fail）→ `npm run package` → robocopy → 重启 → `win-shot` 截图比对。

## 1P（v1.6.22）首页「发布」收口成一个入口
- 用户口径：「项目到处都是发布按钮，感觉有点乱」→ 选了方案 B（删重复 + 把待发布卡片挪到最上面）。
- 删掉：生成操作行里的「发布 → 02 号」、顶栏重复的「立即生成」。生成行现在只有 生成/仅视频/仅图文/采集。
- 首页卡片顺序：待发布内容 → 内容生成 → 完成横幅 → 最新生成内容 → 调度进度 → 最近费用 → 数据概览 → 今日产出。
- 主按钮文案统一为 `发布 N 条 → 02 号`（`publishBtnLabel`，主按钮和完成横幅共用），N = `publishPlan.send`。
- `describePublishPlan` 多返回 `send` + 新参数 `eligible`；今天 0 条待发时按钮写「发布 0 条」，
  点它不开空确认卡，只提示「勾上含旧会话 / 或在列表里点要发的那条」。单测 499 全绿。
- 部署 asar 20:48:04；实测确认卡：发到 账号 02（TK02）/ 按顺序发前 1 条…本轮实际发 1 条，含历史日期会话 /
  待发 27 条可发，点取消未发布。
## 1O（v1.6.21）助手也能发"点名的那一条"
- `run_publish` 新增 `pick`（序号/会话键/会话名/标题片段）与 `all`；`resolvePublishSelectors()` 纯函数 + 11 单测。
- `get_pending` 返回带序号的完整队列（与界面一致：含历史日期、新→旧），模型照抄 n 即可。
- 确认卡显示解析后的真实条目；对不上就报错 + 列候选，绝不"那就发第一条"。
- 修 bug：预览上下文作用域里没有 `outDir`，异常被吞 → 确认卡只显示裸序号。
- 助手页加示范提示条「把待发里第 1 条发到 02 号」；实测链路：get_pending(20ms) → 确认卡
  「只发点名的 1 条：第1条《副业新思路…》(2026-10-18/pm_2014) · 发到账号 02」→ 点跳过后日志
  `⏭ 用户跳过了 run_publish`（没真发）。单测 495 全绿，部署 asar 20:05:33。
## 1N（v1.6.20）发布能挑了：勾选哪条发哪条 + 条数可选
- 待发布表格：每行勾选框 + 表头全选（点整行也能勾）；底部「清空勾选 / 已勾选 N 条」，
  按钮变成「发布勾选的 N 条」；勾选时条数下拉变灰。
- 条数下拉从写死「最多 3 条」改成 1 条 / 2 条 / 3 条 / 全部。
- `publish:run` 新增 `pick`（逐条 `date/session`）与 `all`；勾选优先于 includeOld / maxCount。
- 修 bug：确认卡显示「账号 02（未绑定环境）」—— `publishTargetLabel` 没认下拉选项的 `env` 字段。
- 顺序澄清（不随机）：日期倒序 → 同日 pm 先于 am → 同前缀时间倒序。
  实测 28 条待发第 1 条恒为 `2026-10-18/pm_2014`，前 3 条 `pm_2014, pm_1722, am_0900`。
- 单测 484 全绿（publish-request 13 例）；部署 asar 19:46:17。截图 output/ob-72/75.png。
## 1M（v1.6.19）界面上也能选发布账号了
- 首页待发布卡片：「发到」下拉 + 发布前确认卡（发到谁 / 几条 / 待发几条）；顶部「发布」按钮文字带目标号。
- 纯函数 `src/renderer/lib/publish-request.js`（7 单测）：确认卡文案与真正发出的 opts 同源。
- 实证（真实配置）：选默认 → TK01(explicit=false)；选 02 → TK02；选 07 → TK07；选 09 → TK09。
- 单测 478 全绿；部署 asar 19:23:56 / PID 41708。截图 output/ob-41.png（确认卡）、ob-23.png（下拉）。
## 1L（v1.6.18）发错号修好了：生成/发布都能点名账号
- 用户实测：说「TK02 也发布一条视频」→ 生成 + 发布，最后落在 **TK01**（撤不回来）。
- 根因是链路只认 `accounts[0]`（引擎和发布器其实都支持 `--account`，只有手动/助手这条没接）。
- 新增 `electron/lib/publish-target.js`（唯一判定，9 条单测）+ `run_engine.account/autoPublish`
  + `run_publish.account/env`；确认卡永久显示「发到账号 02」，不指定则显示「默认账号 01」。
- 提示词补第 8 条：点名账号必须带 account，**不许先跑再报告发错号**。
- 单测 471 全绿；部署 asar 19:04:48 / PID 6036。
## 1K（v1.6.17）AI 助手：结果看得见 + 「发成功了吗」三态 + 覆盖面补齐 + 会思考
- 用户反馈：「执行结果也不明显，也没有告诉我是否发布成功」「不光发布视频，这个项目所有的它都能执行、
  判断、分析」「说白了就是要像你一样强大」。
- 工具 17 → **22 个**（新增 `get_last_task` / `manage_accounts` / `admin_action` / `get_trend`，
  并把漏定义的 `backup_cookies` 补上）。
- 界面：工具行 = 工具名 + **人话结论** + 耗时（绿/黄/红三色）；推理模型的思维链渲染成可折叠「思考过程」。
- 关键实测：点「刚才那条发出去了吗？」→ `get_last_task ✅ 3ms` → 「✅ 已发布：TK01 · 10:30 ·
  《海外账号运营卡顿？稳定网络是关键》，已确认公开。另外最近 40 分钟内还有两场也已确认发布：am_0915（TK10）、am_0910（TK09）」。
- 单测 461 全绿（新增 `assistant-observe` 8 例、`assistant-coverage` 8 例）。部署 asar 18:44:46 / PID 17656。
- 还没做（下一步建议）：给助手一个**只读诊断脚本白名单**（scripts/_probe-page 这类），
  以及跨会话的「为什么这条没播放」分析；不动红线（无 shell / 无任意文件读写）。
## 1J. v1.6.16（2026-10-19 18:15）AI 助手能自己加闹钟了 + 每天两套 10 个闹钟落地

用户先要求「重新设定 10 个闹钟，一个账号发一个视频，时间从 8:30 和 0:30 开始，间隔 5 分钟」，
助手回答「只能改/启停/删，不能新建」→ 用户直接顶回来：**「我让 AI 新建闹钟都做不了吗，这个级别有点低呀」**。
这是能力缺口，不是话术问题，所以补的是工具。

- **`schedule_action` 新增 `op=create`**（单条 + 批量 `items` ≤10 条，一张确认卡，可「全部执行」）：
  校验顺序 时间 → 账号存在 → 重复（含本批内自撞）→ 才动盘；新建默认启用；
  id 用 `nextJobId()` 发；整笔走 `assistantTxBegin`，所以**撤销能把它删掉**。
  新增纯函数 `normalizeJobTime()`（`8:30`/全角冒号都收，落盘永远 `HH:MM`；超范围一律拒）。
- **实测（截图 asst-05/07/09）**：点提示「加一个 23:50 的闹钟（账号 10）」→ 助手先查账号+定时
  → 确认卡 `新建定时任务：每天 23:50 · 仅视频 · 账号 10` → 点执行 → 回「已加好：#23 · 每天 23:50
  · 仅视频 · 账号 10（TK10 / lewisqzbqlk），默认启用，30 分钟内可撤销。现在共 23 个闹钟，启用 22 个」
  → 点撤销 → 回到 22 个 / 启用 21 个、23:50 消失。账本两行齐全（create + undo）。
- **两套 10 个闹钟已按用户口径落地**（`scripts/set-daily-schedule.mjs`，幂等、带 `--dry-run`、自动备份）：
  上午组 **08:30–09:15 → #1–#10**（账号 01–10），凌晨组 **00:30–01:15 → #12–#19 + 新建 #21/#22**
  （账号 01–10），全部启用 = **每个账号一天发 2 条**；任务 20 → 22 个，启用 11 → 21 个。
  23:16 那个旧任务（账号 02，停用）没动 —— 用户没提，留着让你决定删还是留。
  调度器 18:07:41 热重载，20 个视频闹钟全部重新登记。
- 测试 **445 pass / 0 fail**（+`tests/unit/schedule-create.test.js` 11 条）。

## 1I. v1.6.15（2026-10-19 15:25）定时任务 id 编码统一

用户反馈：「那些长数字是任务 id，不是账号，混在一起容易看乱，编码能统一一下吗」。

- **根因**：老版本新建任务用过 `Date.now()` 当 id，`config/schedule.json` 里同时出现
  `1 / 2 / 102` 和 `1783852240727` 这种 13 位数字；而 `dedupeJobIds` 当时从
  `Math.max(maxId, 100)+1` 发号，等于把时间戳继续沿用下去。
- **新口径**（`src/job-ids.js`，唯一实现）：id = **1~999 的正整数、纯序号、只增不改**；
  重复/非法/超过 999 自动重发号；到 999 回收最小空号，**永不越过四位数**。
  界面（`Schedule.vue`）、主进程（`sanitize.js#dedupeJobIds` 改为它的包装）、迁移脚本共用一份。
- **一次性迁移** `scripts/normalize-schedule-ids.mjs`（带 `--dry-run`、自动备份、逐项校验）：
  20 个任务 → 1–20。发号顺序 = 启用优先 → 内容类优先于采集 → 按时间，于是
  **08:30–09:15 十个视频任务 = #1–#10，正好对应账号 01–10**；10:00 采集 = #11；
  9 个停用的老任务 = #12–#20。迁移**保序**（只改 id 字段），备份在
  `data/backups/schedule-before-id-normalize-2026-10-19T07-18-11.json`。
- **确认卡现在带编号**：`停用定时任务：#8 · 09:05 video · 账号 08`（用户按时间和账号说，
  编号只用来消歧）。
- 实测：迁移后 20 个任务 / 启用 11 个不变，调度器 15:18:12 热重载重新登记全部闹钟；
  重启应用后 id 仍是 1–20（自愈不会倒回去）；助手「把 09:05 那个闹钟关掉」→
  确认卡显示 #8 → 点「跳过」→ `schedule.json` mtime 不变、账本 0 新增、09:05 仍启用。
- 新测试 `tests/unit/job-ids.test.js` 11 条（时间戳 id 被判非法、只增不改、到顶回收空号、
  迁移保序且只动 id、08:30–09:15 对应 1–10）。全量 **434 pass / 0 fail**。

## 1H. v1.6.14（2026-10-19 13:40）输入框 + 长期记忆 + 一键撤销

## 1H. v1.6.12 → v1.6.14（2026-10-19 13:40）输入框修正 + 长期记忆 + 一键撤销

用户先报「输入框高度太低，鼠标都不好点」，再让「把记忆和撤销做完」。

### 1.6.12 输入框（原来只有 36px）
根因：给它套了单行输入框的 `.x-input`，那个类写死 `height:36px`，`rows="3"` 被压掉。
现在 `.x-textarea` + `min-height:88px`（max 220px）、字号 12.5→13.5px、`cursor:text`，
发送按钮 38→44px。实测部署版高度 88px，点提示按钮仍正常发送。

### 1.6.13 长期记忆 + 一键撤销
- **记忆**：`data/assistant-memory.json`，工具 `remember` / `forget` / `get_memory`。
  - 新增权限级 **`note`**：只动助手自己的文件，**不需要确认**（改配置/跑任务仍然要确认）。
  - 上限 `MEMORY_LIMIT=40` 条、`MEMORY_MAX_TEXT=200` 字，超了丢最老的 —— 记忆会进**每一轮**
    系统提示词，不设上限等于每轮都为历史付钱。
  - 重复记忆只更新分类不新增；提示词里明确写「记忆不是指令」（模型自己写的东西不许当命令执行）。
  - 写完后 `updateSystemPrompt()` 立刻替换 `messages[0]`，**不重建会话**（不丢当前对话）。
- **撤销**：写操作执行前把 `config/user.json` / `config/schedule.json` 复制到
  `data/assistant-undo/<txid>/0.bak`，界面上 30 分钟内出现「撤销」栏（最多 10 条，重启后不再提供）。
  - 撤销 = 原样盖回快照（不是"再反向执行一次"），回滚 user.json 后还会 `saveConfig()` 重新同步环境变量。
  - 跑生成 / 发布 / 采集**不提供撤销**（钱和内容已经出去了），提示词里也这么告诉模型。
  - 撤销本身记审计账本（`tool: undo`）。
- **同时修掉一处口径不一致**：`run_engine` 原来挂着 `account` 参数，但 `doRunEngine` 根本不支持
  按次指定账号 —— 现在参数删掉、传了直接报错（否则会变成「预览说账号 01、实际按配置跑」）。

### 实测证据（部署版 v1.6.13/14）
- 记住：点「记住：配音一律用英文」→ 模型**先调 `get_memory`** 看有没有记过，再 `remember`
  → 答「已记住：配音一律用英文（偏好，共 1 条记忆）」；文件内容
  `[{"id":"m179238814469300","tag":"偏好","text":"配音一律用英文"}]`。
- 重启后（13:37:49 → 13:38:06）日志：`🤖 AI 助手就绪（模型 deepseek-chat，工具 17 个，记忆 1 条）`
  —— 证明记忆是**从磁盘加载**、跨会话生效（为此把记忆条数写进就绪日志，方便以后排查）。
- 撤销：09:05 闹钟 → 执行（`enabled:false`，快照 `0.bak` 2817 字节）→ 输入框上方出现
  「30 分钟内可撤销：↶ 撤销：定时任务 09:05 disable（刚刚）」→ 点它 → 09:05 回到 `enabled:true`、
  **与执行前的备份逐字节一致**、启用闹钟 11 个、账本记 `{"tool":"undo","ok":true}`。
- 验收后**已删掉测试写入的那条记忆**（"配音一律用英文"是假的偏好，不能留给用户）。

### 新测试
`assistant-memory.test.js` 12 条（note 级不需要确认、去重、上限丢最老、提示词长度受控、
撤销窗口/已撤销不放行、`describeUndo` 用传入时钟、`run_engine` 不再接受 account）。
全量 **423 pass / 0 fail**。

## 1G. v1.6.11（2026-10-19 13:20）AI 助手（P0 只读问答 + P1 受控写操作）

用户问「能不能加 AI 功能，能完成日常复杂的事，或按我的对话去执行 / 配置」。
选了 **P0+P1 一起做**、入口用 **侧边栏新页面**（不是抽屉）。现在侧栏最后一项就是「AI 助手」。

### 能做什么（14 个工具，白名单）
- 只读（自动执行）：`get_status` / `get_today_publish` / `get_pending` / `get_schedule` /
  `get_accounts` / `get_logs` / `get_cost` / `get_daily_report` / `explain_failures`
- 要确认（弹卡片 → 点「执行」才动）：`update_config` / `schedule_action` / `run_engine` /
  `run_publish` / `run_collect`
- 全是**复用既有 IPC**（`ACTIONS` 登记表，见下），没有为助手另写"怎么发布 / 怎么采集"。

### 实测证据（部署版 v1.6.11，13:09 起）
- 问「今天发了几个？有失败吗？」→ `get_today_publish` 2ms → 答
  **「今天共 10 场：已发 10 条 / 未确认 0 / 失败 0」**，两轮模型调用 931ms + 917ms。
- 问「把 09:05 那个闹钟关掉」→ `get_schedule` 1ms → 弹确认卡
  「停用定时任务：09:05 video · 账号 08」→
  - 点**跳过**：`schedule.json` mtime 没变、09:05 仍 `enabled:true`、账本无执行记录，
    模型回「你拒绝了，所以没有改动，它仍然启用」。
  - 点**执行**：`schedule.json` 13:11:58 写入、09:05 变 `enabled:false`、
    账本记 `{"tool":"schedule_action","level":"write","confirmed":true,"ok":true}`、
    调度器 13:11:59 自动热重载。**验完已把备份逐字节还原**（11 个启用闹钟，与原状一致）。
- 成本：一轮工具对话 ≈ 1900+2800 prompt tokens，约 **¥0.001/轮**（比生成一条视频便宜 10 倍）。

### 改了什么
- 新文件：`electron/lib/assistant-tools.js`（纯逻辑：白名单/分级/校验/预览/脱敏/审计/裁剪/系统提示）、
  `electron/assistant.js`（执行循环，不依赖 electron 所以能假模型单测）、
  `src/renderer/views/Assistant.vue`（聊天 + 工具 chip + 确认卡 + 清空）。
- `electron/main.js`：新增 `handle(channel, fn)` + `ACTIONS` 登记表；`engine:run` / `publish:run` /
  `collect:run` / `accounts:list` / `schedule:save` 改为经它注册（助手按 channel 直接调同一份实现）；
  `report:publishDay` 的 body 抽成 `buildPublishDay(date)` 供助手复用；
  新增 `assistantExec` / `assistantCallModel` / 会话单例 / 4 个 `assistant:*` IPC。
- `electron/preload.js`：`assistantSend/Answer/State/Reset`；`router` + `App.vue` 侧栏加「AI 助手」。
- 新测试 **+34**：`assistant-tools.test.js`(16) / `assistant-loop.test.js`(14) / `assistant-guard.test.js`(4)。
  全部 **411 pass / 0 fail**，`✓ built`，打包后 asar 内已核到助手代码与文案。

### 安全红线（改前端之前必读，`CLAUDE.md` 有同款）
1. 工具 = 白名单，**没有**执行任意命令 / 读写任意文件的工具（单测逐条断言）。
2. 写操作必须人点「执行」；没表态 = 拒绝；**非法配置在校验阶段就拦死，连卡片都不弹**。
3. Key / 密码经 `redactDeep` 脱敏，永不进上下文；每次工具调用写 `data/assistant-ledger.jsonl`。
4. 发布条数夹死 ≤3 条（预览和执行两处都夹）；长任务不 await（起完就返回）。

### 已知边界
- `run_engine` 没有「指定账号」参数：单次引擎运行的账号由配置决定（`doRunEngine` 只接
  `--video-only/--post-only/--topic`），助手不会假装支持。
- 会话按「日期 + 模型 + 版本」重建，改了模型 / 跨天会重开对话（历史不跨天，避免拿旧口径答新数据）。
- 验收时发现 **win-shot 只能点不能打字**：`SendKeys` / 剪贴板粘贴在隐藏会话里都到不了窗口，
  所以界面自动验收只能点页面上的「提示按钮」；要测任意输入得人工敲。
  （为此把 5 个常用问题做成了提示按钮：今天发了几个 / 为什么失败 / 还有几条待发 /
  哪个号掉登录 / 把 09:05 那个闹钟关掉。）

## 1F. v1.6.10（2026-10-19 13:00）模型可选 + 测试连接改稳

用户问「deepseek 模型是最新的吗，会自动升级吗」—— 查出来的根因比问题本身严重。

### 实测（都是拿用户那把 Key 真打的）
- `GET /models` 只列 **`deepseek-flash`** 和 **`deepseek-v4-pro`**；
- 用 `deepseek-chat` 请求，**回包 `model` 字段 = `deepseek-flash`** → 老别名被**静默路由**，
  当天 10 条成片其实全是 flash 出的；
- `deepseek-v4-pro` 是**推理模型**：同一 9 分镜稿 flash 9.6s / 1893 tokens / 正文 1012 字，
  v4-pro 21.9s / 2257 tokens（**1930 是思考**）/ 正文 856 字；max_tokens 给 120、3000 都返回
  **空正文**（`finish_reason=length`），给 8000 才有内容。
- 用户截图里的 `Premature close` 是**瞬时断连**：同一把 Key 连打 5 次全通（0.4~0.9s），
  但老「测试连接」只给 10 秒且不重试，一抖就红，看着像 Key 坏了。

### 改了什么
- `src/engine/config.js`：新增 `readAiOverrides()`，模型/上限优先级
  **数据目录 `config/user.json`（`deepseekModel` / `deepseekMaxTokens`）> 代码目录 `config/default.json` > FALLBACK**；
  新增 `isReasoningModel()` 与 `REASONING_MIN_MAX_TOKENS=8000`（推理模型 + 小上限会 warnOnce 说明会出空稿）。
- `src/engine/cost.js`：`trackDeepSeek(usage, model)` 按**回包真实模型名**记账，`priceForModel()`
  对没有确认单价的模型标 `estimated`（只有 `deepseek-chat` 是确认价，其余按它估算并明说），
  `cost.json` 多写 `models[]` / `estimated`。
- `src/engine/text.js`：空正文的报错带 `model / max_tokens / reasoning_tokens / finish_reason`，
  `finish_reason=length` 时直接提示「预算被用光 → 调大 max_tokens 或换回非推理模型」。
- `electron/lib/ai-error.js`（新）+ 9 单测：401=Key 无效 / 402=余额不足 / 429=限流 / 5xx=服务端 /
  超时 / DNS / **传输中断（明说不是 Key 的问题）**；文案带耗时与重试次数。
- `electron/main.js`：`config:test` 的 deepseek 改 **30 秒 + SDK 重试 1 次**，成功时回显
  **实际模型**与耗时；新增 IPC **`ai:models`**（列表 + 用 1 token 请求探测"实际被路由到哪个模型"）；
  `DEFAULT_CONFIG` 增 `deepseekModel` / `deepseekMaxTokens`；硅基流动也用同一份错误文案 + 耗时。
- `electron/preload.js`：`aiModels()`。
- `src/renderer/views/Config.vue`：AI 卡新增「文案模型」行 —— 下拉（列表来自 `/models`）+「刷新列表」，
  下面一行显示 `请求：X · 实际：Y · 输出上限：N tokens`，**两者不一致就说明被路由了**；
  选到推理模型自动把上限提到 8000。进页面时自动探测一次（只花 1 token）。
- 单测：`ai-error` 9 例 + `model-choice` 5 例（推理模型判定不能把 `deepseek-promote` 当推理模型；
  未知模型单价必须标估算且不能算成 0）。
- 全量 `npm run verify`：**371 条全绿**。

### 已知边界
- 只有 `deepseek-chat` 的单价是确认过的；flash / v4-pro 的费用是**估算**（已在日志和 cost.json 标记）。
- `deepseek-v4-pro` 生成要 20 秒以上、token 翻倍 —— 默认仍用 `deepseek-chat`（现路由到 flash），
  要换由用户在配置页自己选。

### 部署后验收（都实测过）
- 应用内点「测试」→ `DeepSeek 文案 API ✅ 连接成功 · 实际模型 deepseek-flash（请求 deepseek-chat，
  实际由服务端路由到 deepseek-flash）· 0.4s`；
- 点「刷新列表」→ `请求的 deepseek-chat 被服务端路由到 deepseek-flash（0.8s）`，
  标签显示 `deepseek-flash`，下行 `请求：deepseek-chat · 实际：deepseek-flash · 输出上限：4096 tokens`；
- 下拉切到 `deepseek-flash` → 点「保存配置」→ `user.json` mtime 12:57:05 → 12:58:16，
  `deepseekModel='deepseek-flash'`、两个 Key 仍是 35 / 51 字符（掩码没被写进去）、账号 10 个，
  日志 `配置已保存`；
- 全量 `npm run verify`：**377 条全绿**（1.6.9 的 357 + ai-error 9 + model-choice 5 + model-override 6）。

### ⚠️ 本轮最值钱的发现：主进程里不能用 OpenAI SDK
第一次打包测试时，应用内「测试」和「探测实际模型」**都失败**，报的正是用户截图那句
`传输中途断开`（0.6~0.8s）。同一把 Key 在 `node` 里连打 5 次全通、`GET /models`（axios）也通 ——
说明不是 Key 也不是网络，而是 **Electron 主进程里 openai SDK 的 fetch(undici)** 在这台机器上必挂。
改用 axios（`node:https`）后一次就通。引擎跑在独立 node 子进程里，继续用 SDK 没问题。
以后在主进程里发 AI 请求，一律走 `deepSeekChatMain()`（失败会往应用日志写
`DeepSeek 请求失败（第 N 次）：<name> <message>`）。


## 1E. v1.6.9（2026-10-19 12:20）P0 前三件：快照 / 凭据恢复 / 发布护栏 + 失败通知

用户选的是「按建议做 P0 前四件」。全盘审查报告在 `.claude/AUDIT-2026-10-19.md`。

### ① git 快照（先存档再动手）
`4b609ea` `chore: 存档 v1.6.8 快照（1.2.18 → 1.6.8 全部改动）` —— 157 文件、
+24428 / −3638，顺手把被跟踪的 BitBrowser `tmp.db` 移出版本库。**别再 `git checkout -- .`**。

### ② 凭据恢复路径（`src/secrets-backup.js` + 10 个单测）
- 原来只有 cookie 备份，**账号密码 / 邮箱密码 / 2FA 密钥、账号资料、定时表、发布账本全都没备份** ——
  机器坏了只能重新买号重登。现在每天把 5 个文件 + cookie 打成一份
  `backups/secrets/<日期>/secrets.enc`（`safeStorage` DPAPI 加密，tmp+rename，
  **写完解密读回校验**），保留 14 天。
- 启动时 `restoreSecretsIfNeeded()` 只在文件**缺失或损坏**时补，绝不覆盖现有文件。
- `accounts:import` 的老 bug：2FA 密钥解析出来了却**没写进 `env-accounts.json`**（漏了 `totpSecret` 字段），
  等于每次导入都把 2FA 丢了。已修 —— 需要重新丢一次账号 txt 才会落盘（本机 `import/accounts` 是空的）。
- `accounts:backup` 重写：空数组 / 没有 `sessionid` / 0 字节一律拒收，成功才建目录，
  并按环境逐条报 `✅ 备份 TKxx cookies（N 项，X KB）`。
- 已知边界（写进文档）：DPAPI 只对**同一个 Windows 用户**可解，换机器解不开 → 备份仍在，但要人工处理。
- 启动时调用方没传 cookie，所以还会把 **`backups/cookies/<最近日期>/*.json` 并进包**
  （只取最新一天）—— 否则包是自包含不了的：换机照样得重登。实测造一份假 `TK99.json` 后重启，
  日志变成 `🔐 凭据备份 5 个文件 / 18.5 KB + cookie 1 个环境`；删掉再重启回到 5 个文件。
  本机现在**没有任何 cookie 备份**（`backups/cookies/` 不存在），也就是说这个能力首次用之前要先在
  账号页点一次「备份 cookie」，否则包里只有配置文件。

### ③ 发布护栏（`src/output-scan.js`，唯一实现 + 12 个单测）
三份扫描实现规则各不相同，而无人值守走的正是最松的那份（`src/publisher/index.js`：
无 FAILED 拦截、`--all` 全发、不认 `confirmed`、所有条目打到 `accounts[0]`）。
现状实测积压 **57 个未发布会话（14 个带 FAILED，最老 2026-06-18）**，一次 `--all` 就能把两个月的旧内容推出去。
- 新模块口径：**只认当天**（`--any-date` 才放开）、**跳 FAILED**（发布阶段失败的仍重试）、
  跳 `.published`（含 `confirmed:false`，重发会重复）、默认 **每轮 3 条**。
- 三处全部改成调用它：`publisher/index.js` 的 CLI（`--all` 语义收紧为「当天全部」，
  新增 `--account/--any-date`）、`electron/main.js` 的 `publish:pending` 与 `publish:run`。
- 顺带修掉 `publish:pending` 的 `undefined:undefined`（`pm_1430-2` 这类带序号后缀的会话时间解析成空串，不再拼出废话）。
- 界面：待发布列表加「旧 / 待重试 / 失败」标记 + 「含旧会话」勾选框（默认不勾）+「默认只发当天、每轮最多 3 条」提示。

### ④ 「未确认」不再算成功（P0-2）
`publishToTikTok` 点过 Post 但没能确认公开时**不抛错**，于是三处调用方全部记 ✅（今天 0 次，但迟早会踩）。
现在统一：`publisher/index.js` 读到 `confirmed:false` 就计「未确认」（不 `published++`）、
**退出码 3**；`src/index.js`（引擎自动发布）接 `onUnconfirmed` 回调 → 写 `FAILED{published:true}`
（下一轮绝不重发）并返回 3；调度器见到 3 记 `⚠️ … 未确认（不重试、不重发，请到后台核对）`，
界面「调度进度」的 `END_RE` 也加了这条收尾标记。

### ⑤ 失败通知（不接 TG）
`tgBotToken` 一直是空的，而唯一的对外告警只走 TG → **失败时没有任何人会知道**
（2026-10-18 掉登录空跑 24 分钟就是漏在这里）。
- 主进程 `notifyFailure()`：系统 toast（`Notification.isSupported()` 保护 + 10 分钟同消息去重 + 点击聚焦窗口），
  触发点 = 调度器输出里的 `❌ / ⏱️ / ⚠️…未确认 / ⏭️ 跳过`（失败行现在按 `error` 记账，
  所以「错误 N 条」KPI 终于是真的数）+ 手动发布失败。
- 控制台顶部：有错误时弹**红条**（最新一条错误 + 「看日志」跳转 + 关闭；出现新错误会自动复位）。
- 日报页新增「这天发了什么」卡片（IPC `report:publishDay`）：已发 / 失败 / 未确认三个数 +
  当天发过的账号与标题 + 失败明细。实测今天显示 `已发 10 / 失败 0 / 未确认 0`，10 个账号标题全对。
- 仍未做（下一轮）：日报只覆盖"发布侧"，采集侧已有证据 JSON；TG 接通留给用户开口。

**验收**：`npm run verify` **357 条全绿**（+22：secrets-backup 10、output-scan 12）；
`app.asar` 12:12:14，部署版含 `pc-type / 178px / 含旧会话 / 这天发了什么 / XNOWPost 定时任务异常`；
`src/output-scan.js` SHA256 `144B3C1850A0F4FC` 与源码一致；重启后 PID **12784**（12:13:26），
调度器 11 个任务就绪，控制台 v1.6.9、错误 0 条。
用真实数据跑护栏（只读）：
- `node src/publisher/index.js --max 1`（默认口径）→ **当天候选 0 个**，跳过
  `已发布 234 / 旧日期会话 57 / 缺文案 1 / 没有视频或图片 13`，`📭 没有未发布的内容`，退出码 0。
- `--any-date` 才会出现 **57 个**候选（最老 `2026-06-18`），其中 14 个 FAILED 全是
  `stage=自动发布, published=false` → 判为「可重试」；没有任何「视频/合成」阶段的失败混进候选。
- 界面截图：`output/v169-dashboard.png`（v1.6.9 正常）、`output/v169-report2.png`
  （日报「这天发了什么」已发 10 / 失败 0 / 未确认 0，10 个账号标题正确）、
  `output/v169-pending2.png`（待发布 57 项 / 当天 0，带「旧」「待重试」标记 +「含旧会话」默认不勾）。

**下轮建议顺序**（审查报告的 P1）：`spawnSync`→`spawn`（10-18 丢了 2 轮告警的根因）→
采集 0 成功必须非零退出 → `/login` 作为独立失败原因 → 子进程看门狗（`main.js:1821/1960/2056`）→
日志页「清空」假按钮。

## 1D. v1.6.8（2026-10-19 11:37）output 保留 15 天

用户定口径：「15 天」。范围按之前说好的 —— **只清中间件和调试产物，成片/封面/文案一个不动**。

- 新增 `src/output-retention.js`（纯函数 + `tests/unit/output-retention.test.js` 4 例）：
  - `cutoffDate()` / `pickOldDateDirs()`：按**目录名里的日期**判断（不是 mtime，拷过的文件 mtime 不可信），
    严格早于 cutoff 才进清理列表，边界当天保留；`days<=0` = 不清理。
  - `isCleanable()`：只认 `expanded_debug.html` 和 `_video/**`，其它一律 false。
    单测逐条钉住「video.mp4 / 封面.png / 文案.txt / 描述.txt / .published / JSON / 截图都不许动」。
- 主进程启动时跑一次（和日志清理挨着），日志留痕：
  `🧹 清理 15 天前的中间文件 230 个（22 天的目录），释放 136.0 MB（成片/封面/文案都保留）`
- 实测：`output` **1323.2 MB / 2302 文件 → 1187.2 MB / 1945 文件**；
  老目录里 `video.mp4` 242 个、`封面.png` 255 个全部还在；最近 15 天目录里
  22 个 `expanded_debug.html` 原样未动（策略只碰老目录）。
- **踩坑（第一版无效）**：遍历时对"不可清的目录"直接 `continue`，于是 `am_0830/` 根本没进去，
  一个文件都没删、日志也空着 —— 看起来像策略没生效。必须继续往下递归。
- `npm run verify` 335 条全绿；部署后 `src/output-retention.js` 与源码 SHA256 一致
  （`F8A30B52AF3A1468`），`package.json` 1.6.8。


## 1C. v1.6.7（2026-10-19 11:30）「未知弹窗」假告警 + 日志保留

用户点的两件事：把今天 79 条警告里的「未知弹窗点了 not now」3 次收掉；顺带问日志占不占内存。

### ① 那 3 次「未知弹窗」其实是认得的框
真实现场（`output\2026-10-19\am_0845\publish.log`，08:47 那轮）：
```
+ 13.6s  👁️ 未知浮层（不点，只记录）: 「Not now Discard」按钮=[Not now|Discard]
+ 16.9s~24.5s  👁️ 浮层「通用确认」出现 → 立刻点「Got it」 ×4   ← 白等 28 秒
+ 54.0s  🛑 弹窗「放弃作品确认」被拦下不点 / 弹窗文字: discard this post?
+ 54.0s  ⚠️ 未知弹窗 → 点了安全按钮「not now」（not now discard…）
```
同一个框被三层代码分别认成三种东西。根因：**标题块没进浮层集合**，浮层里只剩
「Not now / Discard」两个按钮，而 `dialogs.js` 第二轮的兜底**只认文字签名** →
判成"未知弹窗"。行为是对的（只点了 Not now，没丢作品），但日志骗人，复盘时最误导。

修（只在放行条件上动手，安全边界不变）：
- `dialogs.js` 第二轮兜底加**按钮组合识别**：浮层里同时有「取消类（Not now/Cancel/Stay）」+
  「Discard」→ 就是「放弃作品确认」，记为 `rule: '放弃作品确认'`、`buttonOnly: true`，
  日志写 `✅ 弹窗「放弃作品确认」→ 点了「not now」（标题块没进来，靠「取消类 + Discard」按钮组合认出来的）`。
- `allowDiscard` 只从上层 `allowDiscardDraft` 透传（**只在"上传之前"为 true**），
  其余场景这一层永远只点 Not now —— Discard 依旧拿不到。
- 单测 +2（`tests/unit/dialogs.test.js`）：只有按钮时点 Not now 且**不许再报 unknown**；
  带 `allowDiscardDraft` 时点 Discard。加上原有的反应器用例（`overlay-policy.test.js` 第 17 行
  就是这组真实浮层），三层都有锁。

### ② 日志占不占资源（用户提问，附实测）
| 项 | 实测 | 结论 |
|---|---|---|
| 内存里的日志 | `logBuffer` 硬上限 **500 行** | 不涨，写到文件后不再驻留 |
| 界面渲染 | 分组视图只渲染 **12 行**标题；全部行视图上限 2000 行 | 不卡 |
| 日志磁盘 | 30 个文件 / **2.95 MB**（2026-06-17 起） | 极小，但**以前只写不清** |
| output 目录 | **1323 MB / 2302 文件**（成片视频） | 真正占磁盘的是它 |
| `expanded_debug.html` | 243 个 / **57.5 MB**（每次发布写一份） | 可清，但要先问用户 |

于是加了保留策略 `electron/lib/log-prune.js`（纯函数 + 5 条单测）：
启动时删 **30 天前**的 `app-<日期>.log` / `scheduler-<日期>.log`，其它文件一概不碰
（`days<=0` 视为不清理，防止把刚写的日志删掉）。首次运行实测
**30 个 → 6 个、释放 2.02 MB**，日志留痕 `🧹 清理 30 天前的日志 24 个，释放 2.02 MB`。

`npm run verify` 331 条单测全绿；部署后 `app.asar` 11:24:53，`app.asar.unpacked\src\publisher\dialogs.js`
与源码 SHA256 一致（publisher 走 `asarUnpack`，改完要核对**解包目录**而不是 asar 本体）。


## 1B. v1.6.6（2026-10-19 11:35）运行日志改成「一轮任务一行」

用户看完 v1.6.5 说「没看到」—— 新版确实在跑（截图可证：共 1374 行、有来源标签），
但他看到的那一屏是**最后一次重启打的 11 个闹钟横幅**，观感跟以前一样「还是一堆废话」。
统计一下：今天 1344 行里，重启横幅 172 行（13%），**关键节点只有 21 行**（1.6%）——
真正要看的 21 行埋在 1300 行里，平铺视图解决不了。

改法（用户选的就是这条）：
- 新增 `src/renderer/lib/log-runs.js`（纯函数）：按 `🚀 … 任务开始` 切轮，
  一轮一行显示 `结果 / 耗时 / 账号 / 环境 / 已发几个 / 花费 / 错误·警告数 / 行数`，
  点开才是这一轮的原始行。界面默认就是分组视图，另有「📜 全部行」切回平铺。
- 单测 `tests/unit/log-runs.test.js`（9 例）：切轮、耗时、环境、失败原因、筛选、边界。
- 三个踩到的判定 bug（都已修 + 锁进单测）：
  1. `🗣️ 先做配音（失败则一分钱不花在生图上）...` 只是句子里有"失败" → 10 轮全被标成 ❌ 失败；
  2. `🚫 文案含敏感信息，重写中(1/2)` 被当错误 → 改成警告（它是重写前的拦截，之后成功了）；
  3. **emoji 字符类没 `u` 标志**：`/^[🔶]/` 会拆成 `\uD83D\uDED6`，
     于是所有 `\uD83D` 开头的 emoji（🗣📤📋…）全命中 → 判定串味。
     另外 `''.includes('')` 恒为 true，空消息会被判成 warning。
  修完今天真实错误数 = **0**（之前界面显示 11 条，全是假的）。
- 耗时不能用"轮内最后一行"：下一轮的 `🔐 TKxx 已登录` 预检行会把 2 分半的一轮算成 45 分钟，
  现在取明确的收尾行（`✅ … 完成` / `❌ … 失败`）。
- 环境只认 `🌐 打开指纹环境 TKxx`（`🔐 已登录` 是全部账号的预检，会把 10 个环境都算进每一轮）。
- 分组视图打开时滚到顶部（最新一轮在最上），全部行视图滚到底部（最新一行）。
- 实测：08:30 那轮 `✅ 成功 · 2 分 37 秒 · 账号 01 · TK01 · 已发 1 · ¥0.043 · ⚠️ 6 · 93 行`，
  09:15 那轮 `2 分 43 秒`，10:00 采集 `2 分 43 秒 · ⚠️ 12 · 259 行`。
  截图 `output\shot-175-runs2.png`（分组）、`output\shot-177-expand.png`（点开 259 行细节）。
- `npm run verify` 324 条单测全绿。


## 1A. v1.6.5（2026-10-19 11:05）运行日志：从 18 行变成 1344 行

用户问「运行日志只能看到这几行吗」。**不是**，一共只显示 18 行的真因有两层：

1. 界面默认是「实时」= 主进程**内存里的 logBuffer**（上限 500 行、进程一重启就清零）→
   应用 10:45 才启动，所以只有启动那十几行。
2. 「历史日志」只读 `logs/app-<日期>.log`，**调度器日志 `scheduler-<日期>.log` 从来没人读**
   —— 而真内容全在那里：今天那 1269 行里有 `🚀 任务开始`、`🔐 TK01 已登录`、`💰 token≈¥0.0038`、
   `📅 会话目录`、`🚫 文案含敏感信息，重写中` 等等。

改法：
- 新增 `electron/lib/log-lines.js`（纯函数）：解析两种格式（app 带 `[INFO]`，调度器没有级别）、
  按内容/emoji 判类型（❌→错误、⚠️→警告、✅→成功）、**丢掉 app 里回声调度器的 `⏰` 行**（否则每条两次）、
  两份按时间合并排序。
- `logs:get`（实时）→ 今天 app + 调度器合并后的尾部，**每 5 秒重读一次文件**
  （调度器是另一个进程，主进程不会转发它每一行），并**自动滚到最新一行**。
- `logs:history`（历史）→ 同一天两份合并，最多 6000 行；界面默认渲染最近 2000 行，
  上面有「⬆️ 还有 N 行更早的」按钮，每次再展开 2000 行。
- 界面加了 **来源标签**（`应用`/`调度`）+ **来源筛选** + **📂 打开文件夹**（直接看原始文件）。
- 顺手修一个日期 bug：`writeLogToFile` / `logs:get` / 日志页默认日期都用的
  `new Date().toISOString()`（**UTC**），北京时间 00:00–08:00 会把当天日志写进前一天的文件
  （`autoBackup` 的目录名同病）。调度器早就按本地日期命名，现在两边一致（`localDateStr()` = `sv-SE`）。
- 单测 `tests/unit/log-lines.test.js`（9 例），其中一条专门锁住
  **`🚀 任务开始（超时预算 1800s）` 不许被判成错误**（裸「超时」当错误关键词会把每轮任务开头染红）。
- 实测：10-19 合并 1344 行（调度 1269 + 应用 30 + …）；10-18 = 6342 行原始（应用 3195 / 调度 3147）、
  其中 47 条错误；10-17 = 761 行。截图 `output\shot-172-logs.png`。

> 本文件只写「现状 / 本轮做了什么 / 待办 / 怎么验证」；规则与踩坑原因全在 `CLAUDE.md`（442 行），改动前先读对应章节。

## 0. 一句话现状

TikTok 内容工厂：采集 → AI 生成（文案/图/视频）→ 多环境发布（FoxProfile + Camoufox）+ 闹钟调度。
Electron 43 + Vue 3 桌面应用，10 个指纹环境 TK01–TK10 全部已登录可发布，窗口统一 1292x994 @ 0,0。

- 开发：`npm run dev`｜打包：`npm run package`（产物 `release\win-unpacked`）｜自检：`npm run verify`
- 部署：见第 4 节命令，别只改代码不部署就报「修好了」—— 用户跑的是 `E:\software\XNOWPost`
- 数据：`%APPDATA%\xnowpost\`（`config\user.json`、`config\schedule.json`、`data\*`、`logs\*`）
- 当前自检：check-leaks ✅ / windowsHide 24 处 ✅ / 单测 **302 全绿** / vite build ✅
- ⚠️ **在仓库目录直接跑 CLI 必须带 `XNOWPOST_DATA_DIR`**：`src/paths.js` 在开发模式下把数据目录
  解析成**仓库根**，会读到仓库里那份旧 `config\user.json`（比特时代的 UUID 环境名），
  采集会报「FoxProfile 里没有名为 31bea5b1… 的环境」：
  ```powershell
  $env:XNOWPOST_DATA_DIR = "$env:APPDATA\xnowpost"; node src\collector\index.js --accounts 01,02
  ```
- ⚠️ **启动部署版应用前先清 `ELECTRON_RUN_AS_NODE`**：该变量存在时 `XNOWPost.exe` 会按 node 跑，
  **秒退且退出码 0、日志一个字都不写**（2026-10-19 差点误判成"打包坏了"）：
  ```powershell
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue; Start-Process E:\software\XNOWPost\XNOWPost.exe
  ```
- ⚠️ **git 状态不干净**：HEAD 还停在 `1.2.18`（提交 `ce9737e`），工作区版本已到 `1.6.3`，
  57 个已修改 + 86 个未跟踪文件。**接力时不要 `git checkout -- .` 或 `git stash`**，会丢一周的工作。

## 1. v1.6.2 → v1.6.4（2026-10-19）采集"假成功"真凶 + 日报页看不懂 + 粉丝接入

### 1.0 v1.6.4 追加（10:55）：粉丝接进来了 + 10 个号都列出来了
用户两句话：「要接进来，另外只能看一个账号吗」。之前日报页只显示 1 个号，是因为
`daily_stats` 那天只有账号 01 的行——页面只画"有数据的号"，没数据的号直接消失。

1. **粉丝/关注/获赞接入采集**（`src/collector/scrapers/tiktok-profile.js`）：
   分析页永远不给这三个数（Followers 页对 <100 粉的号也只给 0 + "达到 100 粉解锁"），
   但账号主页资料卡一定给。采集器在同一个环境里**顺路打开 `https://www.tiktok.com/@<用户名>`** 读一遍，
   不额外开窗口。指标键：`followers` / `following` / `total_likes`（主页的"获赞"是累计获赞，
   和分析页的 `likes`（近 7 天视频点赞）不是一回事，**别混用同一个键**）。
2. **只拿到主页数字也要入库并说明**：返回 `{ stats, partial:true }`，日志
   `ℹ️ 0N: 只拿到主页的粉丝/关注/获赞，播放/点赞/评论 TikTok 仍是「--」`；
   证据 JSON 多了 `partial` 字段；日报页顶部显示蓝色提示条（不是黄色失败条）。
3. **日报页列出全部账号**：`report:daily` 多返回 `configAccounts`（配置里的 name/platform/username），
   页面取「有天数据的号 ∪ 配置里的号」，**没采到的号也画一张卡片**写「这天没采到数据」+ 原因。
4. **踩的坑（已写进 CLAUDE.md）**：资料卡是
   `<strong title="Followers" data-e2e="followers-count">0</strong>` ——
   **`title` 是"这是粉丝数"的标签，不是数字**。第一版读 title 拿到 `"Followers"` → 解析失败 →
   三个数全 null → 因为代码只在 `gotProfile>0` 时打日志，所以**一个字都不打**，看着像没执行。
   现在优先 `textContent`，并新增"元素读到了但解析不出数字"的告警（带原始值）。
5. **真机结果**（10:48 那轮，10/10）：
   ```
   👥 主页资料: 粉丝 0 / 关注 0 / 获赞 0        ← 每个号都读到了
   ✅ 01: {"followers":0,"following":0,"total_likes":0} (@ryloclyjdcf)
   ℹ️ 01: 只拿到主页的粉丝/关注/获赞，播放/点赞/评论 TikTok 仍是「--」
   ✅ 数据采集完成（10/10 个账号有数据）   EXITCODE=0
   analytics.db 2026-10-19 = 30 行（10 号 × 3 指标）
   证据 collect-1048.json: ok=true collected=10 insufficient=10 partial=10
   ```
   页面：`output\shot-167-report.png`（黄条变蓝条 + KPI 总粉丝 0 + 01/02/03… 多张卡片）、
   `output\shot-168-scrolled.png`（滚到 04–07，证明 10 个号都在）。
6. **TG 真相（顺手查清，没改）**：`electron/main.js:176` 已经会把配置里的 `tgBotToken` 写进
   `process.env.TG_BOT_TOKEN`，配置页也有那一栏 —— 但**它是空的**，所以定时采集一直报"未配置"。
   仓库 `.env` 里那个 `TG_BOT_TOKEN` 只有 14 个字符（真 token 是 `数字:AA…` 40+ 位），
   CLI 跑采集时会读到它并报 `❌ 日报推送失败: TG 推送失败 404 Not Found`。
   **打包版不读 `.env`**，所以真要推 TG：到「配置 → Telegram Bot Token」填真 token（不是改 .env）。

### 1.1 现场：10:00 采集 10 个号全空，却报 ✅ 完成
`10:00:00 → 10:02:43`（163 秒），10 个号每个都是：
`📋 页面 44 行 … Video views | -- | 0 | (--)` → `📊 TikTok 数据: {}` → `✅ 0N: {"stats":null,"username":""}`
→ 收尾 `✅ 数据采集完成` / `✅ 数据采集 + 日报 完成`，还覆盖了 `collect-meta.json` 的采集时间。
但 `analytics.db` **当天 0 行**（最新 2026-10-18=4 行只有账号 01；最后一个完整日子是 2026-07-22=42 行）。

### 1.2 真凶：空壳对象被当成有效数据（单测已锁死）
`src/collector/index.js` 的 `normalizeResult()` 写的是
`const stats = result && result.stats ? result.stats : result;`
采集器返回 `{stats: null, username: ''}` 时 `result.stats` 为 null（falsy）→ **stats 退回成整个返回对象**
→ `Object.keys().length === 2 > 0` → 判定"有数据"。后果链：每个号记 ✅ → 一个数字也没入库
（值全是 null/''，被 `saveStats` 过滤）→ `allResults.length === 10` 骗过"全军覆没判断"
→ 覆盖采集时间戳 → 日报拿空壳跑一遍 → 界面显示"今天已采集"。
现在：先认包装对象，再要求**至少一个有限数字**（0 是有效数据），否则 null。抽成
`src/collector/result.js`（纯函数）+ `tests/unit/collect-result.test.js`（10 例）。

### 1.3 为什么是「--」：TikTok 真的没给数据，不是选择器坏了
在 TK01 上实测（3 次、含重进页面 + 多等 20s）：指标一直 `--`；页内 `fetch`
`/tiktok/v1/analytics/insights/`（带完整参数）→ insight 82 返回
`{"article_links_ctr":{"message":{"status":9}}}`，类型 1–6 返回 `{}`，HTTP 200；
Followers 页 `Total followers 0` + `Get more insights once you reach 100 followers`；
Content 页 `No top posts`；`data/account-profiles.json` 里 TK01/TK02/TK08 全是
`followers 0 / following 0 / likes 0`。→ 这些号**还没有可统计的数据**。
所以新增 `looksInsufficient()`：五个 KPI 全是 `--` 判「数据不足」，日志分开说，
不再一律报成「页面结构可能已变化」（两者处置完全不同：一个等数据，一个改选择器）。

### 1.4 四个问题都修了
1. **空采集不许报成功**：全空 → 抛错 + **退出码 2**（纯"数据不足"）；调度器 `runWithRetry`
   见到 2 就 `❌ … 失败：数据不足（… 本轮不重试）` 并**不再重试**（否则白开 10 个浏览器窗口跑 2.5 分钟）。
   行内同时含 `❌` 和 `失败`，因为界面「调度进度」用 `/❌\s*.+?失败/` 判断任务已结束。
2. **不再覆盖「已采集」时间戳**：只有真采到数据才写 `collect-meta.json`；每轮都写证据
   `output/<日期>/collect-HHMM.json`（`ok/total/collected/insufficient/failures`）。
3. **username 不再靠抓页面**：Studio 分析页压根不显示 `@handle`（10 个号抓回全是空串），
   新增 `resolveUsername()`：页面 > `data/env-accounts.json` > 配置 `accounts[].username`。
4. **日报页说实话**（用户原话「我有点看不懂」）：
   - 顶部黄条：`今天（2026-10-19）10:30:07 的采集没拿到数据：0/10 个账号有数据` +
     `所以这一页显示的是 2026-10-18（最近一次有数据的一天）的记录`；
   - KPI **「—」≠ 0**：以前没采到的指标也显示 0（总粉丝明明没采到却写 0），现在缺失显示 `—` 并加脚注；
   - 趋势图例**带账号名**（`01 · 播放`）：旧图例是 `tiktok·播放`，8 个号渲染出一排一模一样的 chip；
   - 趋势横轴改成**真实日历近 7 天**（`2026-10-13 ~ 2026-10-19`）+ 缺口断线：旧实现取"最后 7 个
     有数据的日期"，把 07-22 和 10-18（隔 3 个月）等间距连成一条水平线，看着像"这 7 天都是 0"。
5. **TG 没配 ≠ 推送失败**：`daily.js` 用 `isTelegramConfigured()` 分开报（`ℹ️ 只留本地日志`），
   一个数字都没有时干脆不推空日报；主进程手动「推送日报」也不再在没配 token 时记
   `✅ 已推送到 TG`（同一个假成功模式）。

### 1.5 真机验证（v1.6.3，2026-10-19 10:30）
```
📊 采集账号: 01..10  →  每个都是  ℹ️ 数据不足：TikTok 分析页指标显示为「--」
⚠️ 本轮没有任何数据入库，不更新「已采集」时间戳
❌ 采集失败: 全部 10 个账号数据不足（TikTok 分析页只给「--」占位），未获得任何数据
EXITCODE=2
collect-meta 采集前/后 mtime 均 = 10/19/2026 10:02:43   ← 没被覆盖
analytics.db: 2026-10-19 = 0 行，总数仍 729 行        ← 没写脏
camoufox = 0（10 个环境全开全关）
证据：%APPDATA%\xnowpost\output\2026-10-19\collect-1030.json（ok:false, total:10, collected:0, insufficient:10）
截图：output\shot-166-report.png（黄条 + KPI 的「—」+ 带账号名的图例）
```


## 2. v1.6.1 → v1.6.2（2026-10-19）发布前旧草稿「真的丢弃」+ 弹窗误判修复

### 2.1 现场：10 轮全发成功，但 3 轮各白等 28 秒
- 08:30–09:15 每 5 分钟一轮 TK01→TK10，10/10 `.published` + 10/10「审查完成，视频已公开」，
  账本 10 行，花费 $0.33，无 FAILED、无 WARN/ERROR。
- 但 `am_0845 / am_0855 / am_0905` 三轮日志一模一样：点完草稿的「Discard」后
  `Discard this post?` 确认框**没人收**，反应器把它认成「通用确认」→ 对 (1054,424)
  盲点 4 次「Got it」全部落到遮罩上（`page-events.log` 记的点击目标是 `div.TUXModal-overlay`）
  → 白等 27~28 秒，最后由 `handleDialogs` 的"未知弹窗"兜底点了 Not now。

### 2.2 三个根因，都修了
1. `tiktok.js` 点完草稿横幅的「放弃/Discard」后**没有任何后续处理** → 现在紧接着调
   `handleDialogs` 把确认框当场收掉（v1.6.1 先点 Not now；v1.6.2 按用户口径改成点 Discard，
   见 1.3）。
2. `page-sense` 只按"整页浮层文字拼接"判策略，标题块偶尔不进浮层集合时判不出来 →
   新增 `policyFromButtons()`：同一屏同时出现「取消类（Not now/Cancel/Stay）」+「Discard」
   就直接按**放弃作品确认**处理，优先级高于文字判定（检查框是 Cancel+Turn on、AI 标注是
   Not now+Turn on，都不会误入）。
3. 反应器 4 次上限按 `policy.name` 计数 → 一次误判就把整类浮层封死整轮。改成按
   `overlaySignature()`（策略 + 按钮文字）计数。
- 顺带把 `DIALOG_RULES` 的「放弃作品确认」从 `click: [] + blocked`（一个都不点）改成
  **点 Not now**：只记录不点的话遮罩一直挡着页面（CLAUDE.md 的策略表本来写的就是
  Not now / Cancel / Stay，两层实现之前不一致）。`Discard` 依旧被 `DANGER_LABELS` 一票否决。
- 单测：新增 `tests/unit/overlay-policy.test.js`（5 例），`dialogs.test.js` 改 2 例
  （「点 Not now 收掉，Discard 绝不点」「只有 Discard 一个按钮时一个都不点」）。总单测 284 → **290 全绿**。

### 2.3 v1.6.2：旧草稿必须**真丢掉**（用户口径，2026-10-19 09:50）
- 用户原话：「你点 Not now，等于没丢弃呀，下次打开还是会出现呀」「发布的时候里面有草稿，
  不应该是点击 Discard 吗」—— 对。v1.6.1 只解决了"框盖住页面"，草稿本体一直留着。
- 证据（同一环境 TK08 连续两次探针）：只点过 Not now 之后，下次进上传页横幅还在，而且确认框
  点名了上一次的内容 `Your video "发50条视频才87粉？问题不在内容 5..."`。
- 改法：
  1. `handleDialogs` 新增 `allowDiscardDraft` 选项 —— **只**把「放弃作品确认」这条规则的点法
     换成 `discard/放弃`，并把这两个词从这一步的危险词里摘掉；其它规则、未知弹窗路径拿不到 Discard。
  2. `tiktok.js` 在上传**之前**用它点 Discard（此刻页面上还没有我们的视频/文案，丢的是旧草稿）；
     之后回读 `discard this post` 还在 → 退回 Not now 兜底，绝不把框留在页面上。
  3. **反应器抢跑才是"每轮都弹"的真凶**：它认识这个框，每 500ms 一轮先点 Not now，等于把丢弃
     取消掉。给 `startOverlayReactor` 加 `pause()/resume()/isPaused()`，`tiktok.js` 在草稿那一步
     `pause()` → 自己点 Discard → `finally` 里 `resume()`。
- 实测（`scripts/_probe-draft.mjs`，只开上传页不上传，跑完即删脚本）：
  - 第 1 次：`hasBanner:true` → 点横幅 Discard → 确认框 `{"kind":"clicked","rule":"放弃作品确认","clicked":"discard"}`
    → 页面回到 `Select video to upload…`
  - 第 2 次（重新打开）：**`hasBanner:false`** —— 草稿真的没了。
- 单测 +2：`allowDiscardDraft` 时 Discard 被点/Not now 一次都没点；放开开关也不能让
  未知弹窗点到 Discard（仍只点 Got it）。

### 2.4 真机验证（演练模式，不产生作品）
- 复制 `am_0915` 的产物到探针会话 → `XNOWPOST_PUBLISH_DRY_RUN=1 node src/publisher/index.js --env TK08 --max 1`
  （TK08 真有草稿横幅，正好命中现场）。关键 4 行 —— **1.6 秒收掉，不再有 4 次空点**：
  ```
  + 11.8s 🗑️ 丢弃未保存的草稿
  + 12.3s 👁️ 浮层「放弃作品确认」出现 → 立刻点「Not now」
  + 13.4s 🖱️ 点了「Not now」(714,489) → 已生效
  + 13.4s 👁️ 浮层消失: div.TUXModal-overlay「Discard this post?…」
  ```
- 到 Post 前总耗时 **42.9s**；今早同一环境（am_0905）是 **76.7s**，差 **33.8 秒**
  （省掉 27.3 秒空等 + 手机预览浮层被遮罩挡住的时间）。`page-events.log` 里只有一次 `Not now` 点击，
  没有任何落到 `TUXModal-overlay` 上的废点击。
- 演练停在「已到达发布按钮前，不点击」：**没有 `.published`、账本行数没变**，探针目录已删除
  （留着会被下次「发布全部」捡走）；TK08 窗口已关，`camoufox` 0 个。

### 2.5 顺手发现（没改，等排期）
- **`publish:pending` 会把历史未发布会话全列出来**：APPDATA 数据目录里现有 **57 个**没有
  `.published` 的会话（含 2026-10-18 的 15 个、6~7 月的测试内容）。Dashboard 若点「一键发布全部」，
  这些老内容会真的发出去。建议加护栏：只认当天 / 跳过带 `FAILED` 的 / 老会话要显式 `--all`。

## 3. v1.6.0（2026-10-19 凌晨）做完的 5 件事

### 1B.1 账号页「最后发布」列（含历史回填）
- 发布器点完 Post 写两处：会话目录 `.published` + `<数据目录>\data\publish-ledger.jsonl`（追加一行）。
- `src/publish-history.js` 合并账本与老会话（老会话靠 `publish.log` 里的 `🌐 打开指纹环境 TKxx` 反推环境）；
  `confirmed:false` 不算成功。
- 即时刷新：主进程 `fs.watchFile` 盯账本 → `accounts:publishTimesUpdated`；界面另有 6 秒轮询兜底。
- 回填脚本 `scripts/backfill-publish-ledger.mjs`，已回填 11 条（TK03 显示 `—` 是因为那天两轮都 FAILED，事实如此）。
- 单测 `tests/unit/publish-history.test.js`（8 例）。

### 1B.2 批量换头像「误报没保存」→ 改成反复读（延迟 ≠ 失败）
- 事故：4 个号批量换头像，抽屉里 3 个报「头像地址没变（大概率没真正保存）」，其实**全成功了**——
  点完 Save 立刻读主页，TikTok 还没刷新。
- 现在 `src/avatar-verify.js` 定口径：4s/6s/8s 递增复查，最多 **45 秒**；读到变了才算 ✅，
  超时只说「可能只是延迟，稍后核实」，**绝不把延迟说成失败**。`tests/unit/avatar-verify.test.js`（8 例）守这条。

### 1B.3 改完资料界面缩略图还是灰的 → 存「线上那张」
- `data/avatars/<环境>.jpg` 只由资料同步刷新，改资料成功后必须自己下载线上 `img[class*="ImgAvatar"]`
  覆盖过去（TikTok 已裁成 200x200）；拷原图是下策，仅下载失败时回退。
- 账号页缓存 key 改成 `avatarAt`，`avatarAt` 一变就重取；任务 `done` 时自动 `refresh()`，不用手点。

### 1B.4 环境窗口标题带环境名（用户最在意的「分不清哪个是哪个」）
- `scripts/env-title-watch.ps1`：常驻 PowerShell，主进程 `startEnvTitleWatcher()` 拉起
  （`windowsHide: true`，`-ParentPid` 跟应用同生共死），每 2 秒给每个 camoufox 窗口
  `SetWindowTextW` 校正成 `TK04 · TikTok Studio — Camoufox`。
- **为什么不注入页面标题**：Firefox 窗口标题只跟**前台标签页**，而 `/page/evaluate` 打的是 FoxProfile 的
  `_current`（≈`pages[-1]`）；TK04 有两个标签就踩到——注入打到个人主页，标题还是「TikTok Studio」。
  强行 `select` 会切走用户正在看的标签，发布中也危险。
- 实测：SetWindowText 后 9 秒内 Firefox 不覆盖，2 秒一轮足够。

### 1B.5 「开两个窗口」不是 bug
- **一个环境只开一个窗口**。用户看到的两个 = 同时开着 TK04 + TK05。
- 认环境命令（也写进 CLAUDE.md）：
  `Get-CimInstance Win32_Process -Filter "Name='camoufox.exe'"` → CommandLine 里有 `camoufox_data\TKxx` → 取 `MainWindowHandle` 那个。
- 一个环境 `tabs.json` 里存多个 URL = **同一窗口多个标签**，不是多窗口。

## 4. 待办（建议顺序）

**P0 — 下一个对话先做这个**
1. **明天 10:00 看采集任务的状态对不对**（v1.6.3 已把"假成功"改成退出码 2）：调度器日志应当出现
   `❌ 数据采集 + 日报 失败：数据不足（TikTok 分析页只返回「--」占位，本轮不重试）`
   **只出现一次**（不重试、不连开 3 遍浏览器），并且 `data\collect-meta.json` 的 mtime
   **不再**变成当天时间；日报页顶部应显示黄条 + KPI 的「—」。
2. **看下一轮真机发布是否不再卡**（v1.6.1/v1.6.2 修完）：明天 08:30 那轮
   `publish.log` 里应当出现 `✅ 草稿确认框已处理（动作 N 个，点击 1 次）` +
   `✅ 旧草稿已彻底丢弃（确认框点的是 Discard）`，
   并且**不再出现** `浮层「通用确认」出现 → 立刻点「Got it」… 未见变化` 连续 4 次的行。
   如有异常，抓 `page-events.log` + `publish.log`（今天 3 轮出问题的样本在
   `%APPDATA%\xnowpost\output\2026-10-19\am_0845|am_0855|am_0905\`）。
3. **真机回归一次改资料**（唯一「有单测、没真机」的项）：TK08 用一张本地头像跑一次
   `node scripts/tk-profile-edit.mjs --only TK08 --avatar <任意本地 jpg>`（原来那个桌面路径已不存在），
   确认日志出现 `✅ 头像已生效（第 n 次复查，用时 Ns）` + `🖼️ 头像缩略图已更新`，且账号页缩略图自动变新。
4. **账号数据的根问题（不是代码能修的）**：10 个号 `followers 0 / following 0 / likes 0`，
   TikTok Studio 分析页对它们只返回 `--`（<100 粉连粉丝画像都不给）。也就是说
   **采集/日报在当前阶段只能验证"没数据也不撒谎"**，想真有数字得先让这些号跑出播放与粉丝。
   顺便核对：`data/account-profiles.json` 的 0 粉和用户以为的"已经在涨粉"是否一致。

**P1 — 清理与收尾**
5. 删掉 24 个临时脚本（都是调试留的，`scripts/_*`）：`_check-login-state.mjs _check-posts.mjs _diag-edit-profile.mjs
   _diag-save-button.mjs _diag.ps1 _eye-page.mjs _fixup-sense.mjs _grab-avatars.mjs _probe-analytics.mjs _probe-enum.ps1
   _probe-env-title.mjs _probe-page.mjs _probe-sense.mjs _probe-sig.mjs _retry-one.mjs _run-norm.ps1 _sense.mjs
   _timeline.mjs _verify-avatar.mjs _verify-check-gate.mjs _watch-edit-live.ps1 _watch-edit.ps1 _watch-publish.mjs _win-geo.mjs`
   （删除前确认没有 README/CLAUDE.md 引用；`_probe-page.mjs`/`_sense.mjs` 在 CLAUDE.md 里被当排查工具提到，删了要同步改文档）
6. 移除比特浏览器（BitBrowser）遗留代码：`src/collector/browser.js` 等，确认无引用后删除。
   **注意**：仓库根那份旧 `config\user.json` 里还留着比特的 UUID 环境名，CLI 在开发模式下会读到它
   （见第 0 节的 `XNOWPOST_DATA_DIR` 提醒），清理时一并处理。
7. 轮换泄露过风险的凭据；`TG_BOT_TOKEN` 目前没配（Telegram 通知实际不工作，别以为它发了）。
   配好后 `daily.js` 会自动改报 `✅ 日报已推送到 TG`。

**P2 — 界面统一（用户看得出差别，但没催）**
8. History / DailyReport / Logs 三个页面还是旧样式，没对齐 `src/renderer/styles/theme.css`
   （`.x-card / .x-field / .x-btn …`，品牌色只有一个 `--brand: #FF2E5B`）。
   DailyReport 的**信息表达**已在 v1.6.3 改清楚（黄条 / 「—」/ 带账号名图例 / 日历横轴），只剩观感。
9. 图文（图片帖）**永远不发** —— 这是硬规则，别实现也别"顺手试一下"。

## 5. 用户的行事方式（照做省时间）

- 说「开始了，盯」= 让我全程盯浏览器 + 日志 + 截图，事后报过程细节、结果、问题。
- 要真实证据：截图、日志行、文件 mtime、进程列表。**不要猜、不要"应该"**。
- 回答要短、要有数字和时间；admit 不知道比编一个强。
- 版本号必须动（`package.json` 是唯一来源，界面读 `app.getVersion()`）；"没改版本号就重新打包"会被他抓住。
- 他自己会手动开关环境、手动拉资料 —— 事后核对说的是"我手动做了 X"，别当 bug 处理。

## 6. 部署 + 验证（照抄）

```powershell
# 打包部署（四步缺一不可）
Get-Process XNOWPost -ErrorAction SilentlyContinue | ForEach-Object { $_.Kill() }
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm run verify            # check-leaks + windowsHide + 284 单测 + vite build
npm run package           # 产物 release\win-unpacked
robocopy "release\win-unpacked" "E:\software\XNOWPost" /E /NFL /NDL /NJH /NJS /R:2 /W:1
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Start-Process "E:\software\XNOWPost\XNOWPost.exe"

# 界面验收（PrintWindow，Electron 不黑屏）
powershell -ExecutionPolicy Bypass -File scripts\win-shot.ps1 -Out output\shot.png   # 不加 -ExecutionPolicy Bypass 会被「未签名」拦下
powershell -ExecutionPolicy Bypass -File scripts\win-shot.ps1 -ClickX 120 -ClickY 240 -Out output\accounts.png   # 点导航再抓
powershell -ExecutionPolicy Bypass -File scripts\win-shot.ps1 -ScrollX 800 -ScrollY 500 -Wheel -6 -Out output\scrolled.png

# 发布链路演练（不产生真实作品）
$env:XNOWPOST_PUBLISH_DRY_RUN = "1"
node src/publisher/index.js --env TK01 --max 1

# 环境窗口 ↔ 环境名
Get-CimInstance Win32_Process -Filter "Name='camoufox.exe'" | ForEach-Object {
  $e = if ($_.CommandLine -match 'camoufox_data\\(TK\d+)') { $Matches[1] } else { '?' }
  $w = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
  if ($w.MainWindowHandle -ne 0) { "$e → $($w.MainWindowTitle)" }
}
```

## 7. 环境速查

| 项 | 值 |
|---|---|
| FoxProfile API | `http://127.0.0.1:8000/api/v1`（`launch` / `stop` / `browser` / `profiles` / `page/*`） |
| 环境数据 | `E:\software\FoxProfile\camoufox_data\<TKxx>\`（`tabs.json`、`window.json`、`cookies.sqlite`） |
| 正常进程形态 | `flet` 1 + `pythonw` 2（重启只能用 `scripts\restart-foxprofile.ps1`，直接杀会留孤儿 Flet 窗口） |
| 账号资料缓存 | `%APPDATA%\xnowpost\data\account-profiles.json`（`avatarUrl` / `avatarFile` / `avatarAt`） |
| 头像缩略图 | `%APPDATA%\xnowpost\data\avatars\<TKxx>.jpg`（200x200，来源是线上图） |
| 发布账本 | `%APPDATA%\xnowpost\data\publish-ledger.jsonl`（当前 11 行） |
| 会话产物 | `F:\summer\vs-code\xnowpost\output\<日期>\<am_HHMM\|pm_HHMM>\`（`video.mp4` / `文案.txt` / `描述.txt` / `封面.png` / `publish.log`） |
| 打包版 spawn 路径 | `app.asar.unpacked\scripts\...`；`electron-builder.yml` 的 `files` 必须逐个列出可 spawn 的脚本 |

---

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

## v1.2.15 发布 (2026-07-12)
- 版本: 1.2.14 → 1.2.15（minor）
- [v1.2.15 Release](https://github.com/xiasummer740/xnowpost/releases/tag/v1.2.15)

### ✨ 新增
- **系统托盘** — 点击右上角 X 关闭时，窗口最小化到右下角系统栏，后台运行
  - 托盘图标：程序化生成 32×32 绿色渐变圆形 PNG
  - 右键菜单：「显示主窗口」/「退出」（仅选退出才真正关闭）
  - 单击托盘图标恢复窗口显示
  - 调度器定时任务不受影响，窗口隐藏后继续正常运行

## v1.2.16 发布 (2026-07-12)
- 版本: 1.2.15 → 1.2.16（patch）
- [v1.2.16 Release](https://github.com/xiasummer740/xnowpost/releases/tag/v1.2.16)

### 🐛 修复
- **采集任务卡片混在闹钟列表** — 采集面板保存定时采集后，`mode: collect` 的条目出现在闹钟卡片区显示为"📋 未指定账号 → 数据采集 + 日报"
  - 修复：`groupedJobs` 过滤 `mode: collect`，采集任务只在采集面板展示
- **采集面板保存后数据被覆盖** — `saveCollectSchedule()` 不更新本地 `jobs.value`，再点"保存全部"时旧数据覆盖新数据
  - 修复：`saveCollectSchedule()` 同步 `jobs.value = filtered`

## v1.2.18 发布 (2026-07-12)
- 版本: 1.2.17 → 1.2.18（patch）
- [v1.2.18 Release](https://github.com/xiasummer740/xnowpost/releases/tag/v1.2.18)

### 🐛 修复
- **更新小红点不自动出现** — 更新检查只在启动时查一次，之后不发新版也看不到红点
  - 修复：`initUpdater` 加 `setInterval` 每 30 分钟自动检查

## v1.2.17 发布 (2026-07-12)
- 版本: 1.2.16 → 1.2.17（patch）
- [v1.2.17 Release](https://github.com/xiasummer740/xnowpost/releases/tag/v1.2.17)

### ✨ 新增
- **TikTok 发布器自动重试** — 网络断开/环境关闭/超时时自动重试，不再立刻失败
  - `publishWithRetry` 包装函数，最多重试 3 次
  - `isRetryableError` 分类：临时故障可重试，未登录/未配视频不重试
  - 指数退避延迟：10s → 20s → 40s
  - 每次重试打印原因，方便排查

## 本轮完成 (2026-07-12)
- **[系统托盘] v1.2.15** — 点击 X 最小化到右下角系统栏，右键退出才真正关闭
  - 程序化生成 32×32 绿色圆形托盘图标
  - 右键菜单 + 单击恢复窗口，调度器后台正常执行
- **[采集卡片修复] v1.2.16** — 采集面板的定时任务不再在闹钟卡片区重复展示
  - `groupedJobs` 过滤 `mode: collect`
  - 采集面板保存后同步 `jobs.value` 防覆盖
- **[TikTok 发布器重试] v1.2.17** — 发布失败自动重试 3 次，指数退避 10s→20s→40s
  - `isRetryableError` 分类：网络/环境/超时可重试，未登录/没视频不重试
- **[更新小红点] v1.2.18** — 更新检查改为每 30 分钟自动查，不用重启才看到红点

## 下个对话待办

1. **多平台发布扩展** — 小红书/Facebook/Instagram/YouTube/X 的 publisher 模块
2. **TikTok 发布器重构** — 当前 663 行，超规则 300 行上限 2 倍，需拆文件
3. **多平台 scraper URL 补全** — 小红书/Facebook/Instagram/YouTube/X 的 URL 仍是 `#待祥哥提供URL`
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
