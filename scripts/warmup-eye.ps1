# 养号「用眼睛看」监视器：定时采样 + 定时截图，全程不抢焦点（不打扰正在跑的自动化）。
# 用法： powershell -File scripts\warmup-eye.ps1 -Minutes 60
param(
  [int]$Minutes = 60,
  [int]$EverySec = 20,          # 采样间隔
  [int]$ShotEverySec = 60,      # 截图间隔
  [string]$OutDir = "output\warmup-watch"
)

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$logPath = Join-Path $OutDir 'watch.log'
function W($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  Write-Output $line
}

# 全屏截图（只看得见桌面最上层，仅作兜底证据）
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Cap {
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
}
"@
function Save-Desktop($path) {
  $w = [Cap]::GetSystemMetrics(78)   # SM_CXVIRTUALSCREEN
  $h = [Cap]::GetSystemMetrics(79)
  $x = [Cap]::GetSystemMetrics(76)
  $y = [Cap]::GetSystemMetrics(77)
  if ($w -le 0 -or $h -le 0) { return $false }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h))
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  return $true
}

$base = 'http://127.0.0.1:8000/api/v1'
$deadline = (Get-Date).AddMinutes($Minutes)
$seenBrowser = $false
$seenChild = $false
$idleStreak = 0
$lastShot = [datetime]::MinValue
$shotIdx = 0

W "开始监视（最长 $Minutes 分钟，采样 ${EverySec}s / 截图 ${ShotEverySec}s）"

while ((Get-Date) -lt $deadline) {
  $stamp = Get-Date -Format 'HHmmss'

  # ① 环境列表
  $envs = @()
  try {
    $b = Invoke-RestMethod -Uri "$base/browser" -TimeoutSec 5
    $envs = @($b.running)
  } catch { }

  # ② 养号子进程（注意：它是 node.exe，不是 XNOWPost.exe —— 打包版用 Electron 自带 node 跑脚本）
  $child = Get-CimInstance Win32_Process |
           Where-Object { $_.CommandLine -match 'tk-warmup\.mjs' } | Select-Object -First 1

  # ③ 调度器日志最后一行
  $logFile = "$env:APPDATA\xnowpost\logs\scheduler-$(Get-Date -Format 'yyyy-MM-dd').log"
  $tail = ''
  if (Test-Path $logFile) { $tail = (Get-Content $logFile -Tail 1) -replace '^\[\d{4}-\d\d-\d\d ', '[' }

  if ($child) { $seenChild = $true }
  if ($envs.Count -gt 0) { $seenBrowser = $true; $idleStreak = 0 }
  elseif ($seenBrowser) { $idleStreak++ }

  W ("envs=[{0}] warmup进程={1} | {2}" -f ($envs -join ','), $(if ($child) { "在跑 PID $($child.ProcessId)" } else { '无' }), $tail)

  # ④ 截图：优先拍 camoufox 窗口（PrintWindow，不抢焦点）
  if (((Get-Date) - $lastShot).TotalSeconds -ge $ShotEverySec) {
    $lastShot = Get-Date
    $shotIdx++
    $shot = Join-Path $OutDir ("{0}-{1:d2}-fox.png" -f $stamp, $shotIdx)
    $fox = Get-Process -Name camoufox | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($fox) {
      & powershell -NoProfile -File "scripts\win-shot.ps1" -Out $shot -ProcName camoufox | Out-Null
      W "  截图(浏览器窗口) → $shot"
    } else {
      $desk = Join-Path $OutDir ("{0}-{1:d2}-desk.png" -f $stamp, $shotIdx)
      if (Save-Desktop $desk) { W "  截图(桌面，无浏览器窗口) → $desk" }
    }
  }

  # ⑤ 只有「养号子进程没了」才算结束：账号之间有 45~120 秒随机空档 + 浏览器启动时间，
  #    2026-10-23 15:32 实测 TK02→TK03 空了约 2 分钟 —— 按「N 次没有环境」判会误收工。
  if ($seenChild -and -not $child) { W "养号子进程已退出 → 本轮结束，停止监视"; break }

  Start-Sleep -Seconds $EverySec
}

W "监视结束，共 $shotIdx 张截图"
