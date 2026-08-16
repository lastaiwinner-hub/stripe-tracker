@echo off
title Stripe Tracker - Remote Access
cd /d "%~dp0"

set CF="C:\Program Files (x86)\cloudflared\cloudflared.exe"

echo ============================================
echo  Stripe Tracker + Cloudflare Tunnel
echo ============================================
echo.

if not exist %CF% (
  echo cloudflared is not installed. Run this once in PowerShell:
  echo    winget install --id Cloudflare.cloudflared
  echo.
  pause
  exit /b 1
)

echo Starting the app on port 4700...
start "Stripe Tracker" /min cmd /c "node server.js"

echo Waiting for it to come up...
timeout /t 4 /nobreak >nul

echo.
echo Opening the tunnel. Your link appears below as
echo    https://something-random.trycloudflare.com
echo.
echo Keep this window OPEN - closing it takes the link down
echo and stops Telegram alerts.
echo.

%CF% tunnel --url http://localhost:4700 --no-autoupdate

pause
