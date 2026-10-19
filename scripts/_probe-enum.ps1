param([string]$TitleLike = "*Camoufox*")
$ErrorActionPreference = 'Continue'
Add-Type -Namespace T -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder t, int c);
'@
$script:all = New-Object System.Collections.ArrayList
$script:matches = New-Object System.Collections.ArrayList
$script:pattern = $TitleLike
$script:count = 0
$cb = [T.U+EnumWindowsProc]{
  param($h, $l)
  $script:count = $script:count + 1
  if ([T.U]::IsWindowVisible($h)) {
    $len = [T.U]::GetWindowTextLength($h)
    if ($len -gt 0) {
      $sb = New-Object System.Text.StringBuilder ($len + 2)
      [void][T.U]::GetWindowText($h, $sb, $sb.Capacity)
      $t = $sb.ToString()
      [void]$script:all.Add($t)
      if ($t -like $script:pattern) { [void]$script:matches.Add("$h|$t") }
    }
  }
  return $true
}
$ok = [T.U]::EnumWindows($cb, [IntPtr]::Zero)
"  EnumWindows ok=$ok  遍历=$($script:count)  有标题=$($script:all.Count)  命中=$($script:matches.Count)"
$script:matches | ForEach-Object { "  命中: $_" }
$script:all | Where-Object { $_ -like "*amoufox*" } | ForEach-Object { "  标题含 camoufox: $_" }
