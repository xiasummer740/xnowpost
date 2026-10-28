# 把某个环境（TK01…）的浏览器窗口最小化。程序自动开的窗口用这个，免得挡屏幕。
# 用法： powershell -NoProfile -File scripts\minimize-env.ps1 -Env TK04
#        powershell -NoProfile -File scripts\minimize-env.ps1 -All
param(
  [string]$Env = '',
  [switch]$All
)

Add-Type -Namespace Win32 -Name User32 -MemberDefinition @'
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
'@ -ErrorAction SilentlyContinue

$SW_MINIMIZE = 6
$targets = @()
if ($All) {
  $targets = Get-CimInstance Win32_Process -Filter "Name='camoufox.exe'" |
    Where-Object { $_.CommandLine -match 'camoufox_data\\' } |
    ForEach-Object {
      $name = if ($_.CommandLine -match 'camoufox_data\\([^\\"]+)') { $Matches[1] } else { '' }
      [pscustomobject]@{ Env = $name; Pid = $_.ProcessId }
    }
} elseif ($Env) {
  $needle = 'camoufox_data\' + $Env   # 有的命令行尾部没有反斜杠，所以只匹配到环境名
  $targets = Get-CimInstance Win32_Process -Filter "Name='camoufox.exe'" |
    Where-Object { $_.CommandLine -and ($_.CommandLine -like ('*' + $needle + '*')) } |
    ForEach-Object { [pscustomobject]@{ Env = $Env; Pid = $_.ProcessId } }
} else {
  Write-Output 'need -Env TK01 or -All'
  exit 1
}

$done = 0
foreach ($t in $targets) {
  $p = Get-Process -Id $t.Pid -ErrorAction SilentlyContinue
  if (-not $p -or $p.MainWindowHandle -eq 0) { continue }
  if ([Win32.User32]::IsIconic($p.MainWindowHandle)) { $done++; continue }
  if ([Win32.User32]::ShowWindow($p.MainWindowHandle, $SW_MINIMIZE)) { $done++ }
}

if ($done -gt 0) { Write-Output "minimized $done window(s)" } else { Write-Output 'no window to minimize' }
