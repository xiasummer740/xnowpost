@echo off
rem 从本脚本所在目录推导项目根，不硬编码个人绝对路径
cd /d "%~dp0.."
node scripts/test-publish.mjs %*
pause
