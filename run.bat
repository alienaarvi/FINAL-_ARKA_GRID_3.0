@echo off
REM ArkaGrid launcher for Windows: double-click or run  run.bat
cd /d "%~dp0"

where py >nul 2>nul || (echo Python is required. Install from python.org & pause & exit /b 1)
where npm >nul 2>nul || (echo Node.js is required for the 3D twin. Install from nodejs.org & pause & exit /b 1)

if not exist node_modules\three (
    echo Installing three.js...
    call npm install --silent
)

if not exist .venv (py -m venv .venv)
call .venv\Scripts\activate.bat
pip install -q -r requirements.txt

python engine_a\anomaly_detection.py --serve --open %*
pause
