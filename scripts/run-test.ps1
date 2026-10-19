# 从本脚本所在目录推导项目根，不硬编码个人绝对路径
Set-Location (Join-Path $PSScriptRoot '..')
node scripts/test-publish.mjs @args
Read-Host "Press Enter to exit"
