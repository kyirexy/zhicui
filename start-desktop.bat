@echo off
title Zhicui Desktop Dev Launcher

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-desktop-dev.ps1" %*

if errorlevel 1 (
  echo.
  echo Startup failed. Press any key to close this window.
  pause >nul
)
