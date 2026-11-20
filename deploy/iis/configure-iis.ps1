# ── One-off IIS server settings for CBT ──────────────────────────────────────
# Run once per server, as Administrator, after installing the IIS URL Rewrite
# and Application Request Routing (ARR) modules:
#
#   powershell -ExecutionPolicy Bypass -File deploy\iis\configure-iis.ps1
#
# Server-wide (applicationHost.config), so it cannot live in the site's
# web.config:
#   - ARR's proxy on, keeping the browser's Host header (the app's same-origin
#     check compares Origin with Host);
#   - a 3-minute timeout: airline booking and ticketing calls can take 90 s;
#   - no response buffering, so pages stream as the app sends them;
#   - the client's IP added to X-Forwarded-For WITHOUT its port ("1.2.3.4",
#     not "1.2.3.4:5678"): the app reads it for per-IP sign-in throttling;
#   - the two headers web.config sets (X-Forwarded-Proto, X-Forwarded-Host)
#     allowed.
# Safe to run again.
# ─────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = 'Stop'
$appcmd = Join-Path $env:windir 'system32\inetsrv\appcmd.exe'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this as Administrator (it changes server-wide IIS settings).'
}
if (-not (Test-Path $appcmd)) { throw 'IIS is not installed (no appcmd.exe). Install the Web Server (IIS) role first.' }

$modules = & $appcmd list modules
if (-not ($modules -match 'RewriteModule')) { throw 'The IIS URL Rewrite module is not installed. Install it, then run this again.' }
if (-not ($modules -match 'ApplicationRequestRouting')) { throw 'Application Request Routing (ARR) is not installed. Install it, then run this again.' }

& $appcmd set config -section:system.webServer/proxy `
  /enabled:"True" /preserveHostHeader:"True" /reverseRewriteHostInResponseHeaders:"False" `
  /timeout:"00:03:00" /responseBufferLimit:"0" `
  /xForwardedForHeaderName:"X-Forwarded-For" /includePortInXForwardedFor:"False" `
  /commit:apphost | Out-Null

foreach ($name in 'HTTP_X_FORWARDED_PROTO', 'HTTP_X_FORWARDED_HOST') {
  $existing = & $appcmd list config -section:system.webServer/rewrite/allowedServerVariables
  if ($existing -notmatch $name) {
    & $appcmd set config -section:system.webServer/rewrite/allowedServerVariables /+"[name='$name']" /commit:apphost | Out-Null
  }
}

Write-Host 'IIS is set up for CBT: ARR proxy on (Host kept, 3 min timeout, no buffering, client IP without port), forwarded headers allowed.'
