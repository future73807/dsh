@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [proxy] Node.js was not found in PATH.
  echo [proxy] Install Node.js 18 or newer, then run this file again.
  pause
  exit /b 1
)

node --version
node "%~dp0opencode-go-proxy.mjs"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo [proxy] Exited with code %EXIT_CODE%.
  pause
)

exit /b %EXIT_CODE%
