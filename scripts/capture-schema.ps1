# ── capture-schema.ps1 ───────────────────────────────────────────────────────
# Pulls the authoritative schema out of Supabase and into source control.
#
# WHY THIS EXISTS, AND WHY IT RUNS FIRST:
# 14 of the 38 tables this application queries have no CREATE TABLE anywhere in
# supabase/migrations — employees, clients, tmcs, bookings, approvals, trips and
# eight more. The migrations only ALTER them. That means the live Supabase
# database is currently the ONLY complete description of our schema, and a
# dropped project or a mistaken dashboard click loses it with no recovery.
#
# Everything else in the PostgreSQL migration depends on this file existing.
#
# USAGE
#   $env:SUPABASE_DB_URL = "postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
#   .\scripts\capture-schema.ps1
#
# CONNECTION STRING: use the SESSION POOLER, not the "Direct connection" tab.
#   Supabase dashboard -> Project Settings -> Database -> Connection string
#     -> URI tab -> "Session pooler"  (NOT "Direct connection")
#
# WHY: db.<ref>.supabase.co (the direct connection) resolves to IPv6 ONLY
# unless the project has the paid IPv4 add-on -- confirmed against this
# project's own DNS, which returns an AAAA record and no A record. On an
# IPv4-only network pg_dump fails with "could not translate host name", which
# reads like a typo but is actually a routing problem with no fix on our side.
#
# The session pooler (aws-0-<region>.pooler.supabase.com) is IPv4-reachable and
# is still a full session connection -- pg_dump works against it exactly like
# the direct one. Its username is shaped differently: postgres.<project-ref>,
# not a bare postgres.
#
# Do NOT use the "Transaction pooler" (port 6543) here: pg_dump needs a session
# connection and the transaction pooler will refuse it with a protocol error.
# ─────────────────────────────────────────────────────────────────────────────

param(
  [string]$DbUrl = $env:SUPABASE_DB_URL,
  [string]$OutDir = "schema"
)

$ErrorActionPreference = "Stop"

if (-not $DbUrl) {
  Write-Host ""
  Write-Host "SUPABASE_DB_URL is not set." -ForegroundColor Red
  Write-Host ""
  Write-Host "  Supabase dashboard -> Project Settings -> Database"
  Write-Host "    -> Connection string -> URI  (Direct connection, port 5432)"
  Write-Host ""
  Write-Host "  `$env:SUPABASE_DB_URL = `"postgresql://postgres:<password>@db.adotccgyeobowzgdqhmi.supabase.co:5432/postgres`""
  Write-Host ""
  exit 1
}

# pg_dump ships with the PostgreSQL install but is not on PATH by default.
$pgbin = "C:\Program Files\PostgreSQL\18\bin"
if (Test-Path $pgbin) { $env:Path = "$env:Path;$pgbin" }

if (-not (Get-Command pg_dump -ErrorAction SilentlyContinue)) {
  Write-Host "pg_dump not found. Expected it at $pgbin" -ForegroundColor Red
  exit 1
}

# Catch the IPv6-only direct-connection trap before pg_dump does, with a
# message that actually says what's wrong instead of "Name or service not
# known" -- which is what a routing failure looks like, not what it is.
if ($DbUrl -match "@db\.[\w-]+\.supabase\.co") {
  Write-Host ""
  Write-Host "This looks like a DIRECT connection string (db.<ref>.supabase.co)." -ForegroundColor Red
  Write-Host "That host is IPv6-only on most projects and will fail to resolve" -ForegroundColor Red
  Write-Host "from an IPv4-only network." -ForegroundColor Red
  Write-Host ""
  Write-Host "Use the SESSION POOLER string instead:" -ForegroundColor Yellow
  Write-Host "  dashboard -> Project Settings -> Database -> Connection string"
  Write-Host "    -> URI tab -> 'Session pooler'"
  Write-Host ""
  Write-Host "It looks like:"
  Write-Host "  postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
  Write-Host ""
  exit 1
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Invoke-Dump {
  param([string]$Label, [string[]]$Args, [string]$OutFile)

  Write-Host "  $Label ..." -NoNewline
  $sw = [Diagnostics.Stopwatch]::StartNew()

  # stderr is captured separately: pg_dump writes progress there, so merging it
  # into the SQL file would corrupt the dump.
  $errFile = [IO.Path]::GetTempFileName()
  & pg_dump $DbUrl @Args 2> $errFile | Out-File -FilePath $OutFile -Encoding utf8
  $code = $LASTEXITCODE
  $stderr = Get-Content $errFile -Raw
  Remove-Item $errFile -Force

  if ($code -ne 0) {
    Write-Host " FAILED" -ForegroundColor Red
    Write-Host $stderr -ForegroundColor Red
    exit 1
  }

  $kb = [math]::Round((Get-Item $OutFile).Length / 1KB, 1)
  Write-Host (" ok  {0} KB  ({1:n1}s)" -f $kb, $sw.Elapsed.TotalSeconds) -ForegroundColor Green
  if ($stderr) { Write-Host "    note: $($stderr.Trim())" -ForegroundColor DarkYellow }
}

Write-Host ""
Write-Host "Capturing schema from Supabase" -ForegroundColor Cyan
Write-Host ""

# ── 1. The application schema ────────────────────────────────────────────────
# --no-owner / --no-privileges strip the Supabase-internal role grants that
# vanilla PostgreSQL has no roles for. Restoring those verbatim is the single
# most common failure when moving off Supabase.
Invoke-Dump "public schema  " `
  @("--schema-only", "--schema=public", "--no-owner", "--no-privileges") `
  "$OutDir/baseline.sql"

# ── 2. The auth schema ───────────────────────────────────────────────────────
# Captured but NOT restored locally in this sprint. Auth stays on Supabase while
# the data moves, so this is here for the later self-hosted GoTrue step — and so
# that the user table definition is in source control either way.
Invoke-Dump "auth schema    " `
  @("--schema-only", "--schema=auth", "--no-owner", "--no-privileges") `
  "$OutDir/auth_baseline.sql"

# ── 3. The data ──────────────────────────────────────────────────────────────
# NEVER COMMITTED. bookings.traveler_snapshot holds live passenger detail
# including passport numbers; .gitignore excludes it and it stays on this
# machine only.
Invoke-Dump "public data    " `
  @("--data-only", "--schema=public", "--no-owner", "--disable-triggers") `
  "$OutDir/seed.sql"

# ── Inventory ────────────────────────────────────────────────────────────────
$baseline = Get-Content "$OutDir/baseline.sql" -Raw
$tables = [regex]::Matches($baseline, "(?im)^CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?(\w+)") |
  ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique

Write-Host ""
Write-Host "Captured $($tables.Count) tables:" -ForegroundColor Cyan
$tables | ForEach-Object { Write-Host "  $_" }

Write-Host ""
Write-Host "Next:" -ForegroundColor Cyan
Write-Host "  git add schema/baseline.sql schema/auth_baseline.sql"
Write-Host "  .\scripts\restore-local.ps1"
Write-Host ""
