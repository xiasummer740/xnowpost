
<h1 align="center">XNOWPost</h1>

<p align="center">
  <strong>内容营销自动化引擎</strong><br>
  AI 驱动 · 一键生成 · 多平台分发
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-33.0-blue?logo=electron" alt="Electron">
  <img src="https://img.shields.io/badge/Vue-3.5-brightgreen?logo=vue.js" alt="Vue">
  <img src="https://img.shields.io/badge/Vite-6.4-purple?logo=vite" alt="Vite">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
</p>

---

## 📖 简介

XNOWPost 是一款面向内容创作者的桌面工具，利用 AI 能力自动完成从选题、文案、配图到发布的全流程。只需输入一个主题，即可在数分钟内产出：

- 🎬 **AI 视频** — 分镜文案 + 语音合成 + 配图 + 自动剪辑
- 🖼️ **图文帖** — 轮播图卡片 + 营销文案
- 📅 **定时发布** — 按计划自动执行内容生产
- 📊 **数据分析** — 内容效果追踪与趋势洞察

## ✨ 功能

### 🎬 视频内容生成
- **AI 文案** — 基于 DeepSeek 生成完整视频脚本（中文+英文）
- **场景配图** — 通过 Kolors 模型逐段生图，支持并发加速
- **语音合成** — 基于 edge-tts 生成中英文配音
- **自动剪辑** — FFmpeg 合成字幕 + 语音 + 图片成完整视频
- **多平台输出** — 支持竖屏（9:16）和横屏（16:9）格式

### 🖼️ 图文内容生成
- **营销文案** — AI 生成中英文营销文案
- **轮播图** — 自动设计 4 张品牌风格卡片（标题 + 要点 + 配图）
- **话题标签** — 自动生成中英文标签

### 📅 定时任务
- 内置 node-cron 调度器，支持多个定时任务
- 可分别设置早间（视频+图文）和晚间（视频）任务
- 自动重试机制

### 📤 渠道推送
- **Telegram** — 自动推送到指定频道或群组
- 支持图文消息和文件上传

### 📊 数据分析
- **每日报告** — 自动生成内容发布日报
- **趋势追踪** — 收集热点话题与趋势数据
- **费用记录** — 记录每次生成的 API 调用费用

### 🤖 内容策略
- 多种营销策略模板（价格钩子、热点追踪、品牌故事等）
- 防注入清洗 — 自动过滤 prompt 注入攻击
- 内容去重 — 避免重复生成相同主题

## 🚀 快速开始

### 安装

从 [Releases](https://github.com/xiasummer740/xnowpost/releases) 下载最新安装包，运行 `XNOWPost Setup x.x.x.exe` 即可。

### 配置

首次使用需要配置 API Key：

| 服务 | 用途 | 获取地址 |
|------|------|----------|
| **DeepSeek** | AI 文案生成 | [platform.deepseek.com](https://platform.deepseek.com) |
| **硅基流动** | AI 图片生成（Kolors） | [cloud.siliconflow.cn](https://cloud.siliconflow.cn) |
| **Telegram Bot** | 频道推送（可选） | [@BotFather](https://t.me/BotFather) |
| **Pexels** | 素材搜索（可选） | [pexels.com/api](https://www.pexels.com/api) |

### 环境依赖

引擎运行需要以下系统工具：

- **FFmpeg** — 视频合成（[下载](https://ffmpeg.org/download.html)）
- **edge-tts** — 语音合成（`pip install edge-tts`）
- **Node.js >= 18** — 引擎运行环境

## 💻 开发

```bash
# 克隆
git clone https://github.com/xiasummer740/xnowpost.git
cd xnowpost

# 安装依赖
npm install

# 开发模式
npm run dev           # 启动 Electron + Vite 热重载

# 仅运行引擎（无 UI）
npm run dev:engine                  # 自动模式（视频+图文）
npm run dev:engine:video            # 仅视频
npm run dev:engine:post             # 仅图文

# 其他工具
npm run collect      # 执行数据采集
npm run report       # 生成日报
npm run test         # 运行单元测试

# 构建打包
npm run build        # 构建前端
npm run package      # 打包为安装程序
```

## 🏗️ 项目结构

```
xnowpost/
├── electron/
│   ├── main.js          # Electron 主进程（窗口管理、IPC、引擎调度）
│   └── preload.js       # 预加载脚本
├── src/
│   ├── index.js         # 引擎入口（CLI 模式）
│   ├── engine/
│   │   ├── text.js      # AI 文案生成（DeepSeek）
│   │   ├── image.js     # AI 图片生成 & 卡片设计（Kolors + @napi-rs/canvas）
│   │   ├── video.js     # 视频合成（FFmpeg + 字幕）
│   │   ├── voice.js     # 语音合成（edge-tts）
│   │   ├── cost.js      # API 费用追踪
│   │   ├── strategy.js  # 营销策略管理
│   │   ├── material.js  # 素材管理
│   │   ├── dedup.js     # 内容去重
│   │   └── tools.js     # 工具函数
│   ├── platforms/
│   │   └── index.js     # 平台适配
│   ├── collector/
│   │   ├── index.js     # 数据采集入口
│   │   ├── browser.js   # Playwright 浏览器控制
│   │   └── scrapers/    # 各平台爬虫
│   ├── analyzer/
│   │   ├── daily.js     # 日报生成
│   │   └── trends.js    # 趋势分析
│   ├── notifier.js      # Telegram 推送
│   ├── organizer.js     # 输出目录管理
│   ├── scheduler.js     # 定时调度器
│   └── renderer/        # Vue 3 前端
│       ├── App.vue
│       ├── views/       # 页面组件
│       ├── router/      # 路由
│       ├── stores/      # Pinia 状态管理
│       └── style.css    # 全局样式
├── config/
│   └── prompts/         # AI 提示词模板
├── dist/                # 前端构建产物
└── release/             # 打包输出
```

## 🛠️ 技术栈

| 层面 | 技术 |
|------|------|
| 桌面框架 | Electron 33 |
| 前端框架 | Vue 3 + Vite 6 |
| UI 组件 | Vant 4 |
| 状态管理 | Pinia |
| AI 文案 | DeepSeek API |
| AI 图片 | SiliconFlow / Kolors |
| 图片合成 | @napi-rs/canvas |
| 视频合成 | FFmpeg |
| 语音合成 | edge-tts |
| 浏览器自动化 | Playwright |
| 数据库 | better-sqlite3 |
| 定时任务 | node-cron |
| HTTP 客户端 | Axios |

## 📝 更新日志

详见 [Releases](https://github.com/xiasummer740/xnowpost/releases)。

## 📄 许可证

[MIT](LICENSE)
