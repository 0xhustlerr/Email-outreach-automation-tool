@echo off
setlocal EnableExtensions
title Cold Outreach Command Center

rem Always run from the folder where this .bat file lives
set "PROJECT_ROOT=%~dp0"
if "%PROJECT_ROOT:~-1%"=="\" set "PROJECT_ROOT=%PROJECT_ROOT:~0,-1%"
cd /d "%PROJECT_ROOT%"

rem Fixed port 3005 — never use 3000 (that breaks other projects on localhost:3000)
set "DEV_PORT=3005"

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js is not installed or not on your PATH.
    echo Install it from https://nodejs.org/ then run this file again.
    pause
    exit /b 1
)

if not exist "%PROJECT_ROOT%\package.json" (
    echo ERROR: package.json not found in:
    echo   %PROJECT_ROOT%
    pause
    exit /b 1
)

findstr /C:"email-auto-sending-automation" "%PROJECT_ROOT%\package.json" >nul 2>&1
if errorlevel 1 (
    echo ERROR: This launcher is not in the email-auto-sending-automation project folder.
    echo   %PROJECT_ROOT%
    pause
    exit /b 1
)

if not exist "%PROJECT_ROOT%\node_modules\" (
    echo Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo npm install failed.
        pause
        exit /b 1
    )
)

echo.
echo Project: %PROJECT_ROOT%
echo Starting on port %DEV_PORT% only (will not use port 3000)
echo Chrome opens at http://127.0.0.1:%DEV_PORT%
echo Close this window to stop the server.
echo.

start "" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%\_wait-and-open-chrome.ps1" -Port %DEV_PORT%

cd /d "%PROJECT_ROOT%"
call npm run dev

pause
