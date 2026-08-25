@echo off
title Zhicui Desktop Dev Launcher

where pwsh.exe >nul 2>nul
if not errorlevel 1 (
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-desktop-dev.ps1" %*
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& ([ScriptBlock]::Create([IO.File]::ReadAllText('%~dp0scripts\start-desktop-dev.ps1', [Text.Encoding]::UTF8))) %*"
)

if errorlevel 1 (
  echo.
  echo Startup failed. Press any key to close this window.
  pause >nul
)
