@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto missing_node

if not defined XINGJI_OPEN set XINGJI_OPEN=1
node server.mjs
if errorlevel 1 pause
exit /b 0

:missing_node
echo Node.js 18+ is required. Download: https://nodejs.org/
pause
exit /b 1
