param(
  [double]$Minutes = 25,
  [int]$IntervalSec = 3
)
# 批量改资料时的「眼睛」：定时给浏览器窗口和应用窗口拍照，并把现场事实写进 manifest。
#
# 为什么要两边都拍：
#   · 浏览器窗口 —— 能看到头像裁剪框、保存按钮、页面加载到哪一步（真人视角）；
#   · 应用窗口  —— 「批量改资料」的逐行日志只流进界面右侧抽屉（IPC accounts:progress），
#                  **不写 app 日志**，所以只能从截图里读回来。
#
# 产物：<仓库>/output/watch-edit/<时间戳>/
#   manifest.txt        每行：序号 | 时间 | 说明 | 文件
#   browser-NNN.png     浏览器窗口（标题变化时立刻补一张）
#   app-NNN.png         应用窗口（抽屉日志）
#   edit-shots.json     脚本自己落的失败截图列表（快照）

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$stamp = Get-Date -Format 'HHmmss'
$outDir = Join-Path $repo "output\watch-edit\$stamp"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$manifest = Join-Path $outDir 'manifest.txt'
$shotTool = Join-Path $repo 'scripts\win-shot.ps1'

$appData = $env:APPDATA
$editShotsDir = Join-Path $appData 'xnowpost\output\edit-shots'
$jobDir = Join-Path $appData 'xnowpost\data\edit-jobs'

$startTime = Get-Date
$script:seenShots = @{}
$script:lastJob = ''
$nBrowser = 0
$nApp = 0
$lastTitle = ''
$lastShotAt = [datetime]::MinValue
$seenBrowser = $false
$goneSince = $null
$tick = 0
$deadline = (Get-Date).AddMinutes($Minutes)

function Note([string]$text) {
  $line = "{0} | {1}" -f (Get-Date -Format 'HH:mm:ss'), $text
  Add-Content -Path $manifest -Value $line -Encoding UTF8
  Write-Output $line
}

Note "盯守开始（每 ${IntervalSec}s 一轮，最多 $Minutes 分钟）"
Note "输出目录: $outDir"

while ((Get-Date) -lt $deadline) {
  $tick++
  $now = Get-Date

  # 1) 浏览器窗口
  $bw = @(Get-Process -Name camoufox -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
  if ($bw.Count -gt 0) {
    $seenBrowser = $true
    $goneSince = $null
    $title = ($bw | ForEach-Object { $_.MainWindowTitle }) -join ' || '
    $titleChanged = ($title -ne $lastTitle)
    if ($titleChanged) {
      Note "浏览器标题变化 → $title"
      $lastTitle = $title
    }
    if ($titleChanged -or ($now - $lastShotAt).TotalSeconds -ge 10) {
      $nBrowser++
      $file = Join-Path $outDir ('browser-{0:D3}.png' -f $nBrowser)
      & pwsh -NoProfile -ExecutionPolicy Bypass -File $shotTool -ProcName 'camoufox' -Out $file *> $null
      if (Test-Path $file) {
        $size = [math]::Round((Get-Item $file).Length / 1KB, 0)
        Note ("浏览器截图 #{0}（{1}KB）{2}" -f $nBrowser, $size, $(if ($titleChanged) { ' [标题变化]' } else { '' }))
      } else {
        Note "浏览器截图失败（窗口可能正在重绘）"
      }
      $lastShotAt = $now
    }
  } else {
    if ($seenBrowser -and -not $goneSince) {
      $goneSince = $now
      Note '浏览器窗口消失'
    }
  }

  # 2) 应用窗口（抽屉里的日志）
  if ($tick -eq 1 -or ($tick % 6) -eq 0) {
    $nApp++
    $file = Join-Path $outDir ('app-{0:D3}.png' -f $nApp)
    & pwsh -NoProfile -ExecutionPolicy Bypass -File $shotTool -ProcName 'XNOWPost' -Out $file *> $null
    if (Test-Path $file) { Note ("应用截图 #{0}" -f $nApp) }
  }

  # 3) 脚本自己的失败截图
  if (Test-Path $editShotsDir) {
    $shots = @(Get-ChildItem $editShotsDir -Filter *.png -ErrorAction SilentlyContinue | Sort-Object LastWriteTime)
    $json = $shots | ForEach-Object { "$($_.Name)|$($_.LastWriteTime.ToString('HH:mm:ss'))" }
    Set-Content -Path (Join-Path $outDir 'edit-shots.json') -Value $json -Encoding UTF8
    foreach ($s in $shots) {
      if (-not $script:seenShots) { $script:seenShots = @{} }
      if (-not $script:seenShots.ContainsKey($s.Name)) {
        $script:seenShots[$s.Name] = $true
        if ($s.LastWriteTime -gt $startTime) { Note "脚本记录了一张截图: $($s.Name)" }
      }
    }
  }

  # 4) 任务文件（能看到这次要改哪些环境、头像是什么）
  if (Test-Path $jobDir) {
    $jobs = @(Get-ChildItem $jobDir -Filter 'job-*.json' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
    if ($jobs.Count -and (-not $script:lastJob -or $script:lastJob -ne $jobs[0].Name)) {
      $script:lastJob = $jobs[0].Name
      Note "任务文件: $($jobs[0].Name)（$([math]::Round($jobs[0].Length/1KB,1))KB）"
      try {
        $doc = Get-Content $jobs[0].FullName -Raw | ConvertFrom-Json
        foreach ($j in $doc.jobs) {
          Note ("   目标 {0}: name='{1}' bio='{2}' avatar='{3}'" -f $j.env, $j.name, $j.bio, $j.avatar)
        }
      } catch { Note "   任务文件解析失败: $($_.Exception.Message)" }
    }
  }

  # 5) 结束判断：浏览器消失超过 45 秒且已经拍过东西 → 判定这一轮跑完
  if ($goneSince -and ((Get-Date) - $goneSince).TotalSeconds -ge 45) {
    Note "浏览器已消失 $([int]((Get-Date) - $goneSince).TotalSeconds) 秒，判定结束"
    break
  }

  Start-Sleep -Seconds $IntervalSec
}

Note "盯守结束：浏览器截图 $nBrowser 张，应用截图 $nApp 张"
Note "目录: $outDir"


