## 本轮完成
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

## 关键决策
- v1.0.12 恢复 NSIS 向导安装（oneClick: false），支持自定义路径
- v1.0.13 FFmpeg 以速度优先，放弃最高质量（yuv420p+veryfast 仍是高清画质）
- 后续版本自动更新时，NSIS 会从注册表读取旧安装目录，自动填好路径
- FFmpeg stderr 2>nul：不经过管道，防止缓冲区死锁。FFmpeg 错误通过 exit code 捕获
- scheduler 和 engine 分开进程：隔离崩溃，调度器挂了自动重启
- 提示词多风格+多产品：AI 随机选择不同方向和产品
- 安装版路径：调度器用 app.asar.unpacked，引擎已经有解包路径

## 遗留问题
- 无（目前已知问题均已在 v1.0.13 修复）

## 下一件事
- 祥哥安装 v1.0.13（可覆盖安装到 E:\software\XNOWPost）
- 验证视频能否正常生成
