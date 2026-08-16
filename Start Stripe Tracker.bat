@echo off
cd /d "%~dp0"
start "" http://localhost:4700
node server.js
pause
