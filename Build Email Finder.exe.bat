@echo off
title Build Email Finder.exe
cd /d "%~dp0launcher"

where dotnet >nul 2>&1
if errorlevel 1 (
    echo .NET SDK is required. Install from https://dotnet.microsoft.com/download
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\build.ps1"
if errorlevel 1 (
    echo Build failed.
    pause
    exit /b 1
)

echo.
pause
