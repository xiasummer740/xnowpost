$appLog   = "$env:APPDATA\xnowpost\logs\app-2026-10-19.log"
$ledger   = "$env:APPDATA\xnowpost\data\assistant-ledger.jsonl"
function Pos($p) { if (Test-Path $p) { (Get-Item $p).Length } else { 0 } }
$pa = Pos $appLog; $pl = Pos $ledger
"WATCH 起点 app=$pa ledger=$pl"
while ($true) {
  $na = Pos $appLog
  if ($na -gt $pa) {
    $fs = [System.IO.File]::Open($appLog,'Open','Read','ReadWrite')
    $fs.Seek($pa,'Begin') | Out-Null
    $sr = New-Object System.IO.StreamReader($fs)
    $new = $sr.ReadToEnd(); $sr.Close(); $fs.Close()
    $pa = $na
    $new -split "`r?`n" | Where-Object { $_ -match '\S' } | ForEach-Object { "[APP] $_" }
  }
  $nl = Pos $ledger
  if ($nl -gt $pl) {
    $fs2 = [System.IO.File]::Open($ledger,'Open','Read','ReadWrite')
    $fs2.Seek($pl,'Begin') | Out-Null
    $sr2 = New-Object System.IO.StreamReader($fs2)
    $new2 = $sr2.ReadToEnd(); $sr2.Close(); $fs2.Close()
    $pl = $nl
    $new2 -split "`r?`n" | Where-Object { $_ -match '\S' } | ForEach-Object { "[TOOL] $_" }
  }
  Start-Sleep -Milliseconds 1500
}
