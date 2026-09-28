@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Realm of Embers - playtest server
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 is required. Opening https://nodejs.org ...
  start https://nodejs.org
  pause
  exit /b 1
)
where git >nul 2>nul
if not errorlevel 1 (
  echo Updating to the latest version...
  git pull
)
echo Installing packages...
call npm install --no-audit --no-fund
if errorlevel 1 (
  pause
  exit /b 1
)
node tools\playtest.mjs
pause
