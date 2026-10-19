param(
  [int]$X = 25,
  [int]$Y = 23,
  [int]$W = 1292,
  [int]$H = 994,
  [int]$SettleMs = 1200,
  [int]$Attempts = 4
)
# 把所有指纹浏览器窗口统一成标准位置和大小（默认 25,23 1292x994）。
#
# 背景：Camoufox 按指纹里的模拟屏幕开窗。各环境指纹的屏幕统一成 1920x1080 后，
#       窗口默认落在 0,0、大小 1920x1032（所有环境一样，但不是要的那个尺寸）。
#       窗口稳定后 SetWindowPos 一次就能定住（实测页面侧 window.outerWidth 也变成 1292x994）。
#
# 踩过的坑（别再犯）：
#   ① 用 EnumWindows + 委托枚举窗口：PowerShell 里 native 回调的作用域不稳定，
#      同一时刻另一个脚本能命中、这里返回空且不报错。
#   ② 启动瞬间就反复 SetWindowPos：Camoufox 会反制，出现 482x211、高度 65535 的乱数据。
#   ③ 把 PSCustomObject 塞进数组再 foreach：这个环境里会抛类型转换错误。用简单变量即可。

$ErrorActionPreference = 'Continue'

Add-Type -Namespace WN -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
public struct RECT { public int Left, Top, Right, Bottom; }
'@

$SWP = 0x0004 -bor 0x0010   # SWP_NOZORDER | SWP_NOACTIVATE
$script:dbg = @()
function Dbg($m) { if ($env:NWDEBUG -eq "1") { Write-Host ("  DBG " + $m) } }
$SW_RESTORE = 9

Start-Sleep -Milliseconds $SettleMs

$totalFixed = 0
for ($i = 1; $i -le $Attempts; $i++) {
  $fixedThisRound = 0
  $procs = Get-Process -Name 'camoufox' -ErrorAction SilentlyContinue
  if ($null -eq $procs) { Start-Sleep -Milliseconds 700; continue }
  if ($procs -isnot [array]) { $procs = @($procs) }

  foreach ($p in $procs) {
    $mh = $p.MainWindowHandle
    Dbg ("pid " + $p.Id + " handle=" + $mh + " type=" + $mh.GetType().Name + " isZero=" + ($mh -eq 0))
    if ($mh -eq 0 -or $mh -eq $null) { continue }
    $h = [IntPtr]::new([int64]$mh)
    $r = New-Object WN.U+RECT
    if (-not ([WN.U]::GetWindowRect($h, [ref]$r))) { continue }
    $dw = $r.Right - $r.Left
    $dh = $r.Bottom - $r.Top
    $off = ([math]::Abs($r.Left - $X) -gt 2) -or ([math]::Abs($r.Top - $Y) -gt 2) -or ([math]::Abs($dw - $W) -gt 2) -or ([math]::Abs($dh - $H) -gt 2)
    if (-not $off) { continue }
    if ([WN.U]::IsZoomed($h)) { [void][WN.U]::ShowWindow($h, $SW_RESTORE) }
    [void][WN.U]::SetWindowPos($h, [IntPtr]::Zero, $X, $Y, $W, $H, $SWP)
    $fixedThisRound++
  }

  Dbg ("round $i fixed=$fixedThisRound")
  $totalFixed += $fixedThisRound
  if ($fixedThisRound -eq 0) { break }
  Start-Sleep -Milliseconds 700
}

# 汇报最终状态
$lines = @()
$procs = Get-Process -Name 'camoufox' -ErrorAction SilentlyContinue
if ($null -eq $procs) {
  'no-window'
} else {
  if ($procs -isnot [array]) { $procs = @($procs) }
  foreach ($p in $procs) {
    $mh = $p.MainWindowHandle
    if ($mh -eq 0 -or $mh -eq $null) { continue }
    $h = [IntPtr]::new([int64]$mh)
    $r = New-Object WN.U+RECT
    if (-not ([WN.U]::GetWindowRect($h, [ref]$r))) { continue }
    $lines += "$($r.Left),$($r.Top) $($r.Right-$r.Left)x$($r.Bottom-$r.Top)"
  }
  if ($lines.Count -eq 0) { 'no-window' } else { $lines -join ' | ' }
}

