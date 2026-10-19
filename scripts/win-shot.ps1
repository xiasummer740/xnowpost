# 窗口截图 / 点击工具（验收界面用）
# 用法：
#   powershell -File scripts\win-shot.ps1 -Out output\shot.png
#   powershell -File scripts\win-shot.ps1 -ClickX 100 -ClickY 200      # 窗口内相对坐标
param(
  [string]$Out = "",
  [int]$ClickX = -1,
  [int]$ClickY = -1,
  # 在窗口内滚动：先点 (ScrollX,ScrollY) 把焦点/悬停放到列表上，再滚 N 格（负数向下）
  [int]$ScrollX = -1,
  [int]$ScrollY = -1,
  [int]$Wheel = 0,
  [string]$ProcName = "XNOWPost"
)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

# 把目标窗口真正顶到前台。
# 单靠 SetForegroundWindow 在「刚被浏览器抢过焦点」时会静默失败（Windows 前台锁），
# 结果是点击落到别的窗口上——必须 AttachThreadInput 到当前前台线程再设置。
function Focus-Window([IntPtr]$hwnd) {
  $fg = [Win32]::GetForegroundWindow()
  $fgThread = [Win32]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
  $me = [Win32]::GetCurrentThreadId()
  if ($fgThread -ne $me) { [Win32]::AttachThreadInput($me, $fgThread, $true) | Out-Null }
  [Win32]::ShowWindow($hwnd, 9) | Out-Null          # SW_RESTORE
  [Win32]::BringWindowToTop($hwnd) | Out-Null
  [Win32]::SetForegroundWindow($hwnd) | Out-Null
  if ($fgThread -ne $me) { [Win32]::AttachThreadInput($me, $fgThread, $false) | Out-Null }
  Start-Sleep -Milliseconds 350
}

$procs = Get-Process -Name $ProcName -ErrorAction SilentlyContinue
if (-not $procs) { "❌ 没找到 $ProcName 进程"; exit 1 }

# Electron 一个应用有好几个进程，MainWindowHandle 有时会指向 88x25 的隐藏辅助窗口，
# 直接拿它截图/点击都会落空。这里枚举该进程的全部顶层窗口，取「可见 + 面积最大」的那个。
$pids = ($procs | ForEach-Object { $_.Id }) -join ','
$enumSrc = @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinEnum {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public static List<string> Find(string pidList) {
    var want = new HashSet<string>(pidList.Split(','));
    var found = new List<string>();
    EnumWindows((h, p) => {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (!want.Contains(pid.ToString())) return true;
      if (!IsWindowVisible(h)) return true;
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      int w = r.Right - r.Left, hh = r.Bottom - r.Top;
      if (w < 200 || hh < 200) return true;             // 过滤辅助窗口/提示条
      int len = GetWindowTextLength(h);
      var sb = new StringBuilder(len + 2);
      GetWindowText(h, sb, sb.Capacity);
      found.Add(h.ToInt64() + "|" + w + "|" + hh + "|" + sb.ToString());
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
if (-not ([System.Management.Automation.PSTypeName]'WinEnum').Type) { Add-Type -TypeDefinition $enumSrc }
$wins = [WinEnum]::Find($pids)
if (-not $wins -or $wins.Count -eq 0) { "❌ 没找到 $ProcName 主窗口（$ProcName 界面是不是最小化了？）"; exit 1 }
$best = $wins | ForEach-Object {
  $f = $_ -split '\|', 4
  [pscustomobject]@{ Handle = [IntPtr][int64]$f[0]; W = [int]$f[1]; H = [int]$f[2]; Title = $f[3]; Area = [int]$f[1] * [int]$f[2] }
} | Sort-Object Area -Descending | Select-Object -First 1
$h = $best.Handle
$winTitle = $best.Title

$r = New-Object Win32+RECT
$ok = [Win32]::DwmGetWindowAttribute($h, 9, [ref]$r, 16)
if (-not $ok) { [Win32]::GetWindowRect($h, [ref]$r) | Out-Null }
$w = $r.Right - $r.Left
$hh = $r.Bottom - $r.Top

if ($ClickX -ge 0 -and $ClickY -ge 0) {
  Focus-Window $h
  $sx = $r.Left + $ClickX
  $sy = $r.Top + $ClickY
  [Win32]::SetCursorPos($sx, $sy) | Out-Null
  Start-Sleep -Milliseconds 150
  [Win32]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)   # left down
  Start-Sleep -Milliseconds 60
  [Win32]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)   # left up
  "点击窗口内 ($ClickX,$ClickY) → 屏幕 ($sx,$sy)"
  exit 0
}

# 滚轮：把鼠标移到内容区再滚，滚动完继续截图（带 -Out 时）
if ($Wheel -ne 0 -and $ScrollX -ge 0 -and $ScrollY -ge 0) {
  Focus-Window $h
  [Win32]::SetCursorPos(($r.Left + $ScrollX), ($r.Top + $ScrollY)) | Out-Null
  Start-Sleep -Milliseconds 250
  # 注意：mouse_event 的 dwData 是 UInt32，负数是补码表示
  $delta = if ($Wheel -gt 0) { [uint32]120 } else { [uint32]4294967176 }
  for ($i = 0; $i -lt [Math]::Abs($Wheel); $i++) {
    [Win32]::mouse_event(0x0800, 0, 0, $delta, [IntPtr]::Zero)   # MOUSEEVENTF_WHEEL
    Start-Sleep -Milliseconds 90
  }
  "滚动窗口内 ($ScrollX,$ScrollY) $Wheel 格"
  if ($Out) { Start-Sleep -Milliseconds 600 }
}

if (-not $Out) { "窗口: '$winTitle' 句柄=$h 尺寸=${w}x${hh} 位置=($($r.Left),$($r.Top))"; exit 0 }
if ($w -le 0 -or $hh -le 0) { "❌ 窗口尺寸无效"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[Win32]::PrintWindow($h, $hdc, 2) | Out-Null   # 2 = PW_RENDERFULLCONTENT（Electron 必需）
$g.ReleaseHdc($hdc)
$g.Dispose()
$path = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path (Split-Path -Parent $PSScriptRoot) $Out }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
$bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"已保存 $path （${w}x${hh}）"
