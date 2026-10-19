/**
 * 查每个环境的**真实窗口几何**（页面侧 outerWidth/screenX + Win32 外框），用来验收"统一窗口大小"。
 *
 *   node scripts/_win-geo.mjs TK05 TK09        # 依次启动→测量→关闭
 *   node scripts/_win-geo.mjs --keep TK05      # 测完不关
 */
import { execFileSync } from 'node:child_process';
import { openFoxPage } from '../src/collector/foxpw.js';
import { closeFoxProfile } from '../src/collector/foxprofile.js';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const envs = args.filter((a) => !a.startsWith('--'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PS = `
Add-Type -Namespace WG -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder t, int c);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
public struct RECT { public int Left, Top, Right, Bottom; }
'@
$out = @()
$cb = [WG.U+EnumWindowsProc]{
  param($h, $l)
  if ([WG.U]::IsWindowVisible($h)) {
    $len = [WG.U]::GetWindowTextLength($h)
    if ($len -gt 0) {
      $sb = New-Object System.Text.StringBuilder ($len + 2)
      [void][WG.U]::GetWindowText($h, $sb, $sb.Capacity)
      $t = $sb.ToString()
      if ($t -like "*Camoufox*") {
        $r = New-Object WG.U+RECT
        [void][WG.U]::GetWindowRect($h, [ref]$r)
        $script:out += "$($r.Left),$($r.Top) $($r.Right-$r.Left)x$($r.Bottom-$r.Top)"
      }
    }
  }
  return $true
}
[void][WG.U]::EnumWindows($cb, [IntPtr]::Zero)
$out -join " | "
`;

function winRects() {
  try {
    return execFileSync('pwsh', ['-NoProfile', '-Command', PS], { windowsHide: true, encoding: 'utf8', timeout: 30000 }).trim();
  } catch (e) {
    return `(取窗口失败: ${e.message.split('\n')[0]})`;
  }
}

for (const env of envs) {
  console.log(`\n==== ${env} ====`);
  let envId = null;
  try {
    const opened = await openFoxPage(env, undefined);
    envId = opened.name;
    const page = opened.page;
    await sleep(3000);
    const geo = await page.evaluate(() => ({
      screenX: window.screenX,
      screenY: window.screenY,
      outerW: window.outerWidth,
      outerH: window.outerHeight,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      dpr: window.devicePixelRatio,
      screen: `${window.screen.width}x${window.screen.height} avail ${window.screen.availWidth}x${window.screen.availHeight}`,
    }));
    console.log(`  页面角度: 位置 ${geo.screenX},${geo.screenY}  外框 ${geo.outerW}x${geo.outerH}  视口 ${geo.innerW}x${geo.innerH}  DPR ${geo.dpr}`);
    console.log(`  屏幕: ${geo.screen}`);
    console.log(`  Win32 窗口: ${winRects()}`);
  } catch (err) {
    console.log(`  ❌ ${(err.message || '').split('\n')[0]}`);
  } finally {
    if (envId && !keep) {
      await closeFoxProfile(envId, undefined).catch(() => {});
      console.log(`  🧹 已关闭 ${envId}`);
      await sleep(1500);
    }
  }
}
