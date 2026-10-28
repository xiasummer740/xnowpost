# 把 FoxProfile 的界面窗口最小化（服务照常，任务时浏览器会自动打开），或者恢复回来。
# 为什么需要：FoxProfile 没有托盘，点 × 会把整个服务关掉（API 8000 一起停，
# 2026-10-23 用户实际踩到，当晚养号差点全废）。用户口径是"能不能藏起来，跑任务时自动开浏览器就行"
# —— 最小化就是这个效果：UI 收进任务栏，后台 API 线程不受影响。
#
# 用法：
#   powershell -NoProfile -File scripts\minimize-foxprofile.ps1            # 最小化
#   powershell -NoProfile -File scripts\minimize-foxprofile.ps1 -Restore   # 恢复
param([switch]$Restore)

Add-Type -Namespace FoxProfileWin -Name U -MemberDefinition @'
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
'@

$SW_MINIMIZE = 6
$SW_RESTORE = 9

# Flet 桌面客户端的进程名就是 flet.exe，主窗口标题是「FoxProfile」
$wins = @(Get-Process -Name flet -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
if ($wins.Count -eq 0) {
  Write-Output "no foxprofile window"
  exit 0
}

$n = 0
foreach ($w in $wins) {
  if ($Restore) {
    [FoxProfileWin.U]::ShowWindow($w.MainWindowHandle, $SW_RESTORE) | Out-Null
    [FoxProfileWin.U]::SetForegroundWindow($w.MainWindowHandle) | Out-Null
  } else {
    [FoxProfileWin.U]::ShowWindow($w.MainWindowHandle, $SW_MINIMIZE) | Out-Null
  }
  $n++
}
if ($Restore) { Write-Output "restored $n window(s)" } else { Write-Output "minimized $n window(s)" }
