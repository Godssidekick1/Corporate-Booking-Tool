# ── Keep CBT running: a scheduled task that starts it at boot ────────────────
# Run once, as Administrator, from the unzipped package folder:
#
#   powershell -ExecutionPolicy Bypass -File deploy\windows\register-task.ps1
#
# Built into Windows (Task Scheduler), so nothing extra to install. The task:
#   - starts deploy\windows\start-server.cmd at boot, before anyone signs in;
#   - restarts it within a minute if it ever stops, without limit;
#   - runs as NETWORK SERVICE (no password, few rights) unless -User says
#     otherwise; that account is given read access to the folder and write
#     access to logs\ only.
# Re-running replaces the task. To stop or start by hand:
#   Stop-ScheduledTask CBT ; Start-ScheduledTask CBT
# ─────────────────────────────────────────────────────────────────────────────

param(
  [string]$AppDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$User = 'NT AUTHORITY\NETWORK SERVICE',
  [string]$TaskName = 'CBT'
)
$ErrorActionPreference = 'Stop'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this as Administrator (it registers a task that starts at boot).'
}
if (-not (Test-Path (Join-Path $AppDir 'server.js'))) { throw "No server.js in $AppDir. Run this from the unzipped package." }
if (-not (Test-Path (Join-Path $AppDir '.env.local'))) { throw "No .env.local in $AppDir. Create it first (docs: DEPLOY.md, Configuration)." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is not on the PATH. Install Node.js 24 LTS first.' }

$logs = Join-Path $AppDir 'logs'
New-Item -ItemType Directory -Force $logs | Out-Null
# Read the app; write only its logs. .env.local holds secrets: readable by the
# service account and Administrators, nobody else.
icacls $AppDir /grant "${User}:(OI)(CI)RX" /T /Q | Out-Null
icacls $logs /grant "${User}:(OI)(CI)M" /T /Q | Out-Null
$envFile = Join-Path $AppDir '.env.local'
icacls $envFile /inheritance:r /grant:r "${User}:R" "BUILTIN\Administrators:F" /Q | Out-Null

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$(Join-Path $AppDir 'deploy\windows\start-server.cmd')`"" -WorkingDirectory $AppDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 9999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType ServiceAccount -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Task '$TaskName' registered and started: $AppDir on http://127.0.0.1:3000 (log: logs\server.log)."
