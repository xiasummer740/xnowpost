# FoxProfile 守护（XNOWPost 托管用）
#
# 2026-10-28 用户口径：「两个软件结合使用，用起来也比较麻烦，能整合成一个软件吗」
# → XNOWPost 里做「浏览器环境」页，FoxProfile 退成**后台服务**，日常不再出现它的窗口。
#
# 为什么默认 headless：
#   FoxProfile 是 Flet 桌面应用，**点 × = 整个后端退出**（日志 `Session was garbage collected`
#   → `API server shutdown requested`）。2026-10-23 和 2026-10-28 各踩了一次，
#   每次都是 11 个环境全部不可用、定时任务全哑。headless 模式（FOXPROFILE_HEADLESS=1）
#   只跑 API 不开界面，就没东西可关。
#
# 用法：
#   powershell -NoProfile -File scripts\foxprofile-guard.ps1               # 确保后台服务在跑（headless）
#   powershell -NoProfile -File scripts\foxprofile-guard.ps1 -WithUI       # 需要调指纹时用带界面的模式
#   powershell -NoProfile -File scripts\foxprofile-guard.ps1 -Restore      # 把界面窗口恢复到前台
param(
  [switch]$Restore,
  [switch]$WithUI,
  [int]$WaitSeconds = 90
)

$root = 'E:\software\FoxProfile'
$api = 'http://127.0.0.1:8000/api/v1'
$mini = Join-Path $PSScriptRoot 'minimize-foxprofile.ps1'

function Test-Api {
  try { $null = Invoke-RestMethod -Uri "$api/browser" -TimeoutSec 3; return $true } catch { return $false }
}

if ($Restore) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $mini -Restore
  exit 0
}

if (-not (Test-Api)) {
  # 后端已死：这时还活着的 flet 窗口都是**孤儿**（不清就会叠出两个窗口）
  $orphans = @(Get-Process -Name flet -ErrorAction SilentlyContinue)
  if ($orphans.Count -gt 0) {
    foreach ($p in $orphans) { try { $p.Kill() } catch { } }
    Start-Sleep -Seconds 2
    Write-Output "killed-orphan-flet $($orphans.Count)"
  }

  if ($WithUI) {
    $bat = Join-Path $root '启动 FoxProfile.bat'
    if (-not (Test-Path $bat)) { Write-Output "not running, no launcher"; exit 1 }
    Write-Output "starting-ui"
    Start-Process -FilePath $bat -WorkingDirectory $root
  } else {
    $py = Join-Path $root '.venv\Scripts\pythonw.exe'
    if (-not (Test-Path $py)) { Write-Output "not running, no pythonw"; exit 1 }
    Write-Output "starting-headless"
    $env:FOXPROFILE_HEADLESS = '1'                     # 子进程继承这个变量 → 只跑 API
    # ⚠️ 浏览器窗口必须照常开：用户从「环境」页点启动就是要**看见**那个窗口。
    #    FOXPROFILE_HEADLESS 只关 Flet 管理界面，FOXPROFILE_BROWSER_HEADLESS 才关浏览器窗口。
    #    （2026-10-28 踩过：只设了前者，结果 camoufox 带 -headless 启动，桌面上一片安静。）
    $env:FOXPROFILE_BROWSER_HEADLESS = '0'
    # 等浏览器真正可用的上限（秒）。默认 90 秒在高负载/连开多个环境时不够：
    # 超了之后 launch 返回 202「still starting」，调用方拿到一个点不动的浏览器
    # （2026-10-29 14:00 养号 6/11 就是这么废的）。调到 150 秒，配合应用侧
    # launchAndWait 的页面通道探针，双保险。
    $env:FOXPROFILE_LAUNCH_TIMEOUT = '150'
    Start-Process -FilePath $py -ArgumentList 'src\main.py' -WorkingDirectory $root -WindowStyle Hidden
  }

  $ok = $false
  for ($i = 0; $i -lt [math]::Ceiling($WaitSeconds / 2); $i++) {
    Start-Sleep -Seconds 2
    if (Test-Api) { $ok = $true; break }
  }
  if (-not $ok) { Write-Output "started but api timeout"; exit 1 }
  if ($WithUI) { Start-Sleep -Seconds 3 }              # 等窗口建出来再最小化
}

$profiles = 0
try { $profiles = @((Invoke-RestMethod -Uri "$api/profiles" -TimeoutSec 10).profiles).Count } catch { }
$uiWindows = @(Get-Process -Name flet -ErrorAction SilentlyContinue).Count
Write-Output "api-ok profiles=$profiles ui-windows=$uiWindows"

# 带界面模式：窗口收进任务栏（服务不受影响）。headless 模式没有窗口，不用管。
if ($uiWindows -gt 0) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $mini
}
