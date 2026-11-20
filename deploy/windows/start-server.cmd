@echo off
rem ── Starts CBT's Node server ────────────────────────────────────────────────
rem Listens on 127.0.0.1 only: IIS (deploy\iis\web.config) is the one way in,
rem which is what lets the app trust the client IP the proxy adds.
rem Settings come from .env.local beside server.js (docs/deploy-windows.md).
rem Run by the scheduled task (register-task.ps1); can also be run by hand.

cd /d "%~dp0..\.."
set NODE_ENV=production
set HOSTNAME=127.0.0.1
if "%PORT%"=="" set PORT=3000
if not exist logs mkdir logs
node server.js >> logs\server.log 2>&1
