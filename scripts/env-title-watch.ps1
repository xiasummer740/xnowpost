param(
  [int]$IntervalSec = 2,
  [int]$ParentPid = 0
)
# 给每个指纹浏览器窗口的标题打上环境名：`TK04 · TikTok Studio — Camoufox`
#
# 为什么需要：手动开两个环境后，窗口标题/任务栏全是 TikTok 的页面标题，
# 分不清哪个窗口是 TK04、哪个是 TK05（用户 2026-10-19 实测反馈）。
#
# 为什么用 Win32 而不是往页面里注入：
#   · Firefox 的窗口标题 = **当前前台标签页**标题，而 FoxProfile 的 /page/evaluate
#     打到的是它自己的 "current page"，两者不一定同一页（TK04 有两个标签就踩到了：
#     注入了个人主页，窗口标题却还是「TikTok Studio」）；
#   · 想对齐就得调 /page/tabs/{i}/select，那会把用户正在看的标签页切走 —— 不可接受，
#     而且发布/采集进行中切换 current page 有把发布器操作的那页切走的风险。
# 实测：SetWindowTextW 之后 9 秒内 Firefox 不会覆盖（只有换页/换标签才重写），
# 所以每 2 秒校正一次就够。
#
# 映射方式：camoufox 进程命令行里有 `-profile ...\camoufox_data\TK04`，据此认环境；
# 只处理真有主窗口句柄的那个进程（其余是同环境的子进程，没有窗口）。

$ErrorActionPreference = 'Continue'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class XnpTitle {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern bool SetWindowTextW(IntPtr hWnd, string text);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder text, int max);
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);
}
"@

function Get-WindowTitle([IntPtr]$hwnd) {
  $sb = New-Object System.Text.StringBuilder 1024
  [void][XnpTitle]::GetWindowTextW($hwnd, $sb, 1024)
  return $sb.ToString()
}

while ($true) {
  if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
    break   # 应用退了就跟着退
  }

  $seen = @{}
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='camoufox.exe'" -ErrorAction Stop
  } catch {
    $procs = @()
  }

  foreach ($p in $procs) {
    $envName = if ($p.CommandLine -match 'camoufox_data\\(TK\d+)') { $Matches[1] } else { '' }
    if (-not $envName) { continue }
    $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    if (-not $proc -or $proc.MainWindowHandle -eq 0) { continue }
    $hwnd = [IntPtr]$proc.MainWindowHandle
    if ($seen.ContainsKey($hwnd.ToInt64())) { continue }
    $seen[$hwnd.ToInt64()] = $true
    if (-not [XnpTitle]::IsWindow($hwnd)) { continue }

    $cur = Get-WindowTitle $hwnd
    $body = ($cur -replace '^TK\d+\s*·\s*', '').Trim()
    $want = "$envName · $body"
    if ($cur -ne $want) {
      [void][XnpTitle]::SetWindowTextW($hwnd, $want)
    }
  }

  Start-Sleep -Seconds $IntervalSec
}

