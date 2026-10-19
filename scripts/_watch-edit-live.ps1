param(
  [double]$Minutes = 30,
  [int]$SigMs = 400,        # 页面状态轮询间隔（本地 HTTP，很快）
  [int]$AppMs = 900         # 应用窗口截图间隔（像素没变就丢弃）
)
# 改资料 / 发布的「事件驱动眼睛」：不是定时抓，而是**每次变化前后都抓**。
#
# 原理：
#   ① 用 FoxProfile 的 /page/evaluate 每 400ms 取一个"页面指纹"
#      （URL、浮层文字、可见按钮、头像 src、正文长度与哈希、滚动位置）；
#   ② 指纹一变 → 立刻抓一张浏览器窗口（变化后），并把上一张标成这张的「变化前」；
#   ③ 应用窗口每秒抓一张，只有像素哈希变了才保留（抽屉里的日志逐行出现时正好一拍一张）。
#
# 因为每次变化都抓，所以任意两帧之间就是"一次变化"的前后对比。
#
# 产物：output/watch-edit/<时间戳>/
#   manifest.txt     时间 | 事件 | 配对说明
#   browser-NNN.png  浏览器窗口
#   app-NNN.png      应用窗口（内容不同才留）
#   sig.log          每次变化时的页面指纹 JSON（可复盘）

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$stamp = Get-Date -Format 'HHmmss'
$outDir = Join-Path $repo "output\watch-edit\live-$stamp"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$manifest = Join-Path $outDir 'manifest.txt'
$sigLog = Join-Path $outDir 'sig.log'
$shotTool = Join-Path $repo 'scripts\win-shot.ps1'
$api = 'http://127.0.0.1:8000/api/v1'

$pendingShots = @()
$nBrowser = 0
$nApp = 0
$lastSig = ''
$lastBrowserFile = ''
$lastAppHash = ''
$lastAppFile = ''
$lastEnv = ''
$tick = 0
$lastAppAt = [datetime]::MinValue
$lastSigAt = [datetime]::MinValue
$seenBrowser = $false
$goneSince = $null
$deadline = (Get-Date).AddMinutes($Minutes)

function Note([string]$text) {
  $line = "{0} | {1}" -f (Get-Date -Format 'HH:mm:ss.fff'), $text
  Add-Content -Path $manifest -Value $line -Encoding UTF8
  Write-Output $line
}

# 抓图不等待（否则一次抓图 0.5~0.8s 会把 400ms 的轮询拖慢）
function Shot([string]$proc, [string]$file) {
  Start-Process -FilePath 'pwsh' -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $shotTool, '-ProcName', $proc, '-Out', $file
  ) -WindowStyle Hidden | Out-Null
}

$sigScript = @'
(() => {
  const txt = (document.body && document.body.innerText) || '';
  let h = 0;
  for (let i = 0; i < txt.length; i++) { h = (h * 31 + txt.charCodeAt(i)) | 0; }
  const area = (e) => { const r = e.getBoundingClientRect(); return r.width * r.height; };
  const floating = (e) => {
    let n = e;
    for (let i = 0; i < 6 && n; i++) {
      const cs = getComputedStyle(n);
      if (cs.position === 'fixed') return true;
      n = n.parentElement;
    }
    return e.getAttribute('role') === 'dialog';
  };
  const overlays = Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"],div[class*="Modal"],div[class*="modal"],div[class*="Overlay"]'))
    .filter((e) => area(e) > 20000 && floating(e))
    .map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160))
    .filter(Boolean);
  const ava = document.querySelector('img[class*="ImgAvatar"]') || document.querySelector('img[class*="Avatar"]');
  const btns = Array.from(document.querySelectorAll('[role="button"],button,div[class*="Button"]'))
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 24 && r.height > 16 && r.top >= 0 && r.top < window.innerHeight; })
    .map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim())
    .filter((t) => t && t.length < 28);
  return JSON.stringify({
    url: location.pathname + location.search,
    len: txt.length,
    h: h,
    overlays: overlays,
    avatar: (ava && ava.src || '').split('?')[0],
    btns: Array.from(new Set(btns)).slice(0, 18),
    scroll: Math.round(window.scrollY)
  });
})()
'@

Note "事件驱动盯守开始（页面指纹 ${SigMs}ms 一次，应用窗口 ${AppMs}ms 一次，最多 $Minutes 分钟）"
Note "输出目录: $outDir"

while ((Get-Date) -lt $deadline) {
  $tick++
  $now = Get-Date

  # ── 1) 当前在跑哪个环境 ─────────────────────────────
  $env = ''
  try {
    $b = Invoke-RestMethod -Uri "$api/browser" -TimeoutSec 3
    if ($b -and $b.running -and @($b.running).Count -gt 0) { $env = @($b.running)[0] }
  } catch { }

  if ($env -ne $lastEnv) {
    Note ("环境变化: '{0}' → '{1}'" -f $lastEnv, $env)
    $lastEnv = $env
    $lastSig = ''    # 换环境必须重新抓基准帧
  }

  # ── 2) 页面指纹（只在有环境时）──────────────────────
  if ($env -and ((Get-Date) - $lastSigAt).TotalMilliseconds -ge $SigMs) {
    $lastSigAt = Get-Date
    $sigText = ''
    try {
      $body = @{ script = $sigScript } | ConvertTo-Json -Compress
      $r = Invoke-RestMethod -Method Post -Uri "$api/browser/$env/page/evaluate" -ContentType 'application/json' -Body $body -TimeoutSec 8
      $sigText = [string]$r.result
    } catch {
      $sigText = ''
    }

    if ($sigText) {
      if ($sigText -ne $lastSig) {
        $nBrowser++
        $file = Join-Path $outDir ('browser-{0:D3}.png' -f $nBrowser)
        $pendingShots = @($pendingShots | Where-Object { Test-Path (Join-Path $outDir $_) })
        $critical = ($sigText -match 'overlay|crop|Save|Apply')
        if ($pendingShots.Count -lt 2 -or $critical) {
          Shot 'camoufox' $file
          $pendingShots += ('browser-{0:D3}.png' -f $nBrowser)
        }

        # 变化说明（和上一帧比）
        $diff = @()
        try {
          $cur = $sigText | ConvertFrom-Json
          if ($lastSig) {
            $prv = $lastSig | ConvertFrom-Json
            if ($prv.url -ne $cur.url) { $diff += "URL $($prv.url) → $($cur.url)" }
            if ($prv.avatar -ne $cur.avatar) { $diff += '头像 URL 变了' }
            if ($prv.len -ne $cur.len) { $diff += "正文长度 $($prv.len) → $($cur.len)" }
            $newOv = @($cur.overlays | Where-Object { $prv.overlays -notcontains $_ })
            $goneOv = @($prv.overlays | Where-Object { $cur.overlays -notcontains $_ })
            foreach ($o in $newOv) { $diff += "浮层出现: 「$($o.Substring(0, [Math]::Min(70, $o.Length)))」" }
            foreach ($o in $goneOv) { $diff += "浮层消失: 「$($o.Substring(0, [Math]::Min(70, $o.Length)))」" }
            if ($prv.scroll -ne $cur.scroll) { $diff += "滚动 $($prv.scroll) → $($cur.scroll)" }
            $newBtn = @($cur.btns | Where-Object { $prv.btns -notcontains $_ })
            if ($newBtn.Count) { $diff += "新按钮: " + ($newBtn -join ' / ') }
          } else {
            $diff += '首帧（基准）'
          }
        } catch { $diff += '指纹解析失败' }

        $prevTxt = if ($lastBrowserFile) { "变化前=$lastBrowserFile" } else { '变化前=无' }
        Note ("📸 {0} 变化后=browser-{1:D3}.png  {2}" -f $prevTxt, $nBrowser, ($diff -join '；'))
        Add-Content -Path $sigLog -Value ("{0} #{1} {2}" -f (Get-Date -Format 'HH:mm:ss.fff'), $nBrowser, $sigText) -Encoding UTF8
        $lastBrowserFile = 'browser-{0:D3}.png' -f $nBrowser
        $lastSig = $sigText
      }
    }
  }

  # ── 3) 应用窗口：每秒抓，像素变了才留 ───────────────
  if (((Get-Date) - $lastAppAt).TotalMilliseconds -ge $AppMs) {
    $lastAppAt = Get-Date
    $tmp = Join-Path $outDir '_app-tmp.png'
    & pwsh -NoProfile -ExecutionPolicy Bypass -File $shotTool -ProcName 'XNOWPost' -Out $tmp *> $null
    if (Test-Path $tmp) {
      $hash = (Get-FileHash $tmp -Algorithm SHA256).Hash
      if ($hash -ne $lastAppHash) {
        $nApp++
        $keep = Join-Path $outDir ('app-{0:D3}.png' -f $nApp)
        Move-Item -Force $tmp $keep
        $prevTxt = if ($lastAppFile) { "变化前=$lastAppFile" } else { '变化前=无' }
        Note ("🖥️ {0} 变化后=app-{1:D3}.png（界面像素变化）" -f $prevTxt, $nApp)
        $lastAppHash = $hash
        $lastAppFile = 'app-{0:D3}.png' -f $nApp
      }
    }
  }

  # ── 4) 浏览器窗口是否还在 ───────────────────────────
  $bw = @(Get-Process -Name camoufox -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
  if ($bw.Count -gt 0) { $seenBrowser = $true; $goneSince = $null }
  elseif ($seenBrowser -and -not $goneSince) {
    $goneSince = Get-Date
    Note '浏览器窗口消失'
    $nBrowser++
    Shot 'XNOWPost' (Join-Path $outDir ('browser-{0:D3}.png' -f $nBrowser))   # 收尾再给应用窗口补一张
  }

  if ($goneSince -and ((Get-Date) - $goneSince).TotalSeconds -ge 30) {
    Note "浏览器消失已 30 秒，收工"
    break
  }

  Start-Sleep -Milliseconds 120
}

Note "盯守结束：浏览器帧 $nBrowser 张，应用窗口帧 $nApp 张"
Note "目录: $outDir"

