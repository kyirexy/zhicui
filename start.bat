@echo off
REM VideoCapsule 本地启动脚本 (Windows)
REM 同时启动抖音连接服务、后端 (FastAPI) 和前端 (Next.js)

echo.
echo  ========================================
echo   🫒 收藏夹榨汁机 VideoCapsule
echo  ========================================
echo.

REM Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Please install Python 3.10+
    pause
    exit /b 1
)

REM Check Node
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node.js 20+
    pause
    exit /b 1
)

REM Check FFmpeg
ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo [WARN] FFmpeg not found. Video processing may not work.
    echo        Install: winget install Gyan.FFmpeg
)

echo [1/4] Checking local Douyin service...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-douyin-sidecar.ps1"
if errorlevel 1 (
    echo [WARN] Local Douyin service could not be started.
    echo        Single-link extraction can still be used.
)

echo [2/4] Installing backend dependencies...
cd /d "%~dp0backend"
pip install -r requirements.txt -q

echo [3/4] Installing frontend dependencies...
cd /d "%~dp0frontend"
call npm install --silent

echo [4/4] Starting services...
echo.
echo  Backend:  http://localhost:8000
echo  Frontend: http://localhost:3000
echo  API Docs: http://localhost:8000/docs
echo.

REM Start backend in new window
start "VideoCapsule Backend" cmd /c "cd /d %~dp0backend && python run.py"

REM Wait for backend to start
timeout /t 3 /nobreak >nul

REM Start frontend in new window
start "VideoCapsule Frontend" cmd /c "cd /d %~dp0frontend && npm run dev"

echo.
echo  Both services started! Press any key to stop.
echo.
pause >nul

REM Cleanup
taskkill /FI "WindowTitle eq VideoCapsule Backend*" /F >nul 2>&1
taskkill /FI "WindowTitle eq VideoCapsule Frontend*" /F >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-douyin-sidecar.ps1" -Stop >nul 2>&1
echo Services stopped.
