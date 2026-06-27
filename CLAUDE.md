# XNOWPost 项目规则

## CMD 弹窗零容忍
- 所有 `spawn()` / `execSync()` 必须带 `windowsHide: true`
- 启动子进程一律用 `windowsHide: true`，不允许出现任何 CMD 窗口
- 新增任何 spawn/execSync 调用时必须加上此参数
