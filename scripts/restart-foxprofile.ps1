param(
  [switch]$Force,          # 有环境在跑也照样重启
  [int]$WaitSeconds = 90
)
# 干净地重启 FoxProfile（指纹浏览器服务）。
#
# 为什么需要这个脚本：直接杀 pythonw 会留下**孤儿的 Flet UI 进程**，
# 任务栏里就多出一个永远转圈加载的空窗口（用户实际看到过两个 FoxProfile 窗口）。
# 正确的顺序：关环境 → 杀 Flet → 杀 pythonw → 杀残留 camoufox → 重新启动 → 等 API 起来 → 核对只剩一个窗口。

$ErrorActionPreference = 'Continue'
$root = 'E:\software\FoxProfile'
$api = 'http://127.0.0.1:8000/api/v1'

function Get-Running {
  try { return @((Invoke-RestMethod -Uri "$api/browser" -TimeoutSec 5).running) } catch { return @() }
}

$running = Get-Running
if ($running.Count -gt 0) {
  if (-not $Force) {
    "  有环境在运行（$($running -join ', ')），加 -Force 才会强制重启。"
    exit 1
  }
  foreach ($e in $running) {
    try { Invoke-RestMethod -Method Post -Uri "$api/browser/$e/stop" -TimeoutSec 60 | Out-Null; "  已关 $e" } catch { "  关闭 $e 失败" }
  }
  Start-Sleep -Seconds 3
}

# 1) 先杀 UI，杀掉后端会让 UI 变孤儿
foreach ($p in (Get-Process -Name flet -ErrorAction SilentlyContinue)) {
  "  结束 Flet UI PID $($p.Id)"
  $p.Kill()
}
Start-Sleep -Seconds 2

# 2) 杀后端（venv 和系统 python 两条链都要杀）
foreach ($p in (Get-Process -Name pythonw -ErrorAction SilentlyContinue)) {
  "  结束 pythonw PID $($p.Id)"
  $p.Kill()
}
Start-Sleep -Seconds 3

# 3) 杀残留浏览器进程（否则会占着 cookie 库，下次启动读登录态失败）
$left = @(Get-Process -Name camoufox -ErrorAction SilentlyContinue)
if ($left.Count -gt 0) {
  foreach ($p in $left) { "  结束残留 camoufox PID $($p.Id)"; $p.Kill() }
  Start-Sleep -Seconds 2
}

# 4) 重新启动
Start-Process -FilePath (Join-Path $root '启动 FoxProfile.bat') -WorkingDirectory $root
"  已启动，等 API..."

$ok = $false
for ($i = 0; $i -lt [math]::Ceiling($WaitSeconds / 2); $i++) {
  Start-Sleep -Seconds 2
  try { $null = Invoke-RestMethod -Uri "$api/browser" -TimeoutSec 3; $ok = $true; break } catch { }
}

if (-not $ok) {
  "  ❌ $WaitSeconds 秒内 API 没起来"
  exit 1
}

$windows = @(Get-Process -Name flet -ErrorAction SilentlyContinue)
"  ✅ API 已恢复（约 $($i * 2)s）  Flet 窗口数: $($windows.Count)"
if ($windows.Count -gt 1) {
  "  ⚠️ 还是多窗口！逐个列出："
  $windows | ForEach-Object { "     PID $($_.Id) 启动 $($_.StartTime.ToString('HH:mm:ss'))" }
  exit 2
}
$profiles = @((Invoke-RestMethod -Uri "$api/profiles" -TimeoutSec 10).profiles)
"  环境数: $($profiles.Count)（$(($profiles | ForEach-Object { $_.name }) -join ', ')）"
