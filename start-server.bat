@echo off
title PiMobile Server
cd /d %~dp0server
echo ========================================================
echo   PiMobile Server (Port 8787)
echo   Emulator : 10.0.2.2:8787
echo   LAN      : YOUR_LAN_IP:8787  (check with ipconfig)
echo   Tailscale: YOUR_TAILSCALE_IP:8787  (if enabled)
echo ========================================================
echo.
echo Starting server... (first run: npm install)
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
call npm start
pause
