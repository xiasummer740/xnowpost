# 抓「CMD 窗口闪一下」的探测器（开发用，不进安装包）
#
# 用法：
#   pwsh -NoProfile -File scripts\_probe-console-flash.ps1 -Seconds 20
# 输出：任何**可见的**控制台窗口（class = ConsoleWindowClass / CASCADIA_HOSTING_WINDOW_CLASS）
#       连同它属于哪个进程、父进程是谁。看不到输出 = 这 20 秒里一个控制台窗口都没冒出来。
#
# 为什么要 P/Invoke 而不是 Get-Process：conhost.exe 一定会有 MainWindowHandle，
# 但**隐藏**的控制台也有 conhost —— 只有 IsWindowVisible 能分清「用户真的看得见」。
param([int]$Seconds = 20)

Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinProbe {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public static List<string> VisibleConsoles() {
    var found = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256);
      GetClassName(h, sb, 256);
      var cls = sb.ToString();
      if (cls == "ConsoleWindowClass" || cls == "CASCADIA_HOSTING_WINDOW_CLASS" || cls == "PseudoConsoleWindow") {
        uint pid; GetWindowThreadProcessId(h, out pid);
        found.Add(pid.ToString());
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@

$seen = @{}
$end = (Get-Date).AddSeconds($Seconds)
Write-Output ("监听 {0} 秒（可见控制台窗口）… 开始于 {1:HH:mm:ss}" -f $Seconds, (Get-Date))
while ((Get-Date) -lt $end) {
  foreach ($pidStr in [WinProbe]::VisibleConsoles()) {
    if ($seen.ContainsKey($pidStr)) { continue }
    $seen[$pidStr] = $true
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$pidStr" -ErrorAction SilentlyContinue
    $parent = if ($p) { Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue } else { $null }
    $name = if ($p) { $p.Name } else { '?' }
    $pname = if ($parent) { $parent.Name } else { '?' }
    # 关键：打出**窗口属主自己**的命令行，才知道到底是哪个任务/脚本在闪
    $own = if ($p) { $p.CommandLine } else { '' }
    if ($own -and $own.Length -gt 150) { $own = $own.Substring(0, 150) }
    Write-Output ("  ⚠️ {0:HH:mm:ss} 可见控制台  pid={1} {2}  ← 父 {3}" -f (Get-Date), $pidStr, $name, $pname)
    if ($own) { Write-Output ("       命令行: {0}" -f $own) }
  }
  Start-Sleep -Milliseconds 100
}
Write-Output ("完成：共看到 {0} 个可见控制台窗口" -f $seen.Count)
