# 清理环境变量，确保 Electron 窗口正常启动
$env:NODE_OPTIONS = ''
$env:ELECTRON_RUN_AS_NODE = ''

$projectRoot = Split-Path -Parent $PSScriptRoot
$electronExe = Join-Path $projectRoot "node_modules\electron\dist\electron.exe"

Write-Host "🚀 启动 XNOWPost 开发版..."
& $electronExe $projectRoot --use-gl=swiftshader --no-sandbox
