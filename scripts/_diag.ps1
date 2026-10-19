Write-Output ("  LanguageMode = " + $ExecutionContext.SessionState.LanguageMode)
try {
  Add-Type -Namespace ZT -Name U -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
public struct RECT { public int Left, Top, Right, Bottom; }
"@
  Write-Output "  Add-Type OK"
} catch {
  Write-Output ("  Add-Type 失败: " + $_.Exception.Message)
}
Write-Output ("  类型可用: " + ($null -ne ([System.Management.Automation.PSTypeName]'ZT.U').Type))
$ps = Get-Process -Name camoufox -ErrorAction SilentlyContinue
Write-Output ("  camoufox 进程数: " + $(if ($null -eq $ps) { 0 } else { @($ps).Count }))
foreach ($p in @($ps)) { if ($p.MainWindowHandle -ne 0) { Write-Output ("  有窗口: PID " + $p.Id + " handle " + $p.MainWindowHandle) } }
