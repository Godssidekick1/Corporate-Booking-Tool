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
#   Preferred -- pass the password separately so it never has to survive being
#   hand-assembled into a URI (a `/` or `#` in the password otherwise breaks
#   parsing before pg_dump ever sees it, since both are reserved URI
#   characters -- confirmed live against this project):
#     .\scripts\capture-schema.ps1 -PgHost "aws-1-ap-northeast-1.pooler.supabase.com" `
#       -PgUser "postgres.<ref>" -PgPassword ".BBa78se/#sYPdn"
#
#   Or supply a pre-built URL if the password is already safe to embed:
#     $env:SUPABASE_DB_URL = "postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
#     .\scripts\capture-schema.ps1
#
# CONNECTION STRING: use the SESSION POOLER, not the "Direct connection" tab.
#   Supabase dashboard -> "Connect" button (top of the project page)
#     -> URI tab -> "Session pooler"  (NOT "Direct connection")
#   Confirmed against this project's actual dashboard -- it is not under
#   Project Settings, despite that being the documented location historically.
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
  [string]$OutDir = "schema",
  # Component form: safer than a hand-assembled URL because the password is
  # percent-encoded with [uri]::EscapeDataString before it ever touches a URI
  # parser. A raw password containing '/', '#', '?', '%', '@' or ':' breaks a
  # naive postgresql://user:pass@host URL -- every one of those characters is a
  # URI delimiter and an unencoded occurrence gets parsed as structure, not
  # data. That is exactly what happened with a password containing '/' and '#':
  # the parser found what it thought was a path boundary and a fragment marker
  # inside the password and split the string there.
  [string]$PgHost,
  [string]$PgUser,
  [string]$PgPassword,
  [string]$PgDatabase = "postgres",
  [int]$PgPort = 5432
)

$ErrorActionPreference = "Stop"

if ($PgHost -and $PgUser -and $PgPassword) {
  $encodedPassword = [uri]::EscapeDataString($PgPassword)
  $encodedUser = [uri]::EscapeDataString($PgUser)
  $DbUrl = "postgresql://${encodedUser}:${encodedPassword}@${PgHost}:${PgPort}/${PgDatabase}"
}

if (-not $DbUrl) {
  Write-Host ""
  Write-Host "No connection details supplied." -ForegroundColor Red
  Write-Host ""
  Write-Host "  Supabase dashboard -> Connect (top of the project page)"
  Write-Host "    -> URI tab -> Session pooler"
  Write-Host ""
  Write-Host "Preferred (handles special characters in the password safely):"
  Write-Host "  .\scripts\capture-schema.ps1 -PgHost `"aws-0-<region>.pooler.supabase.com`" \`"
  Write-Host "    -PgUser `"postgres.<ref>`" -PgPassword `"<password>`""
  Write-Host ""
  Write-Host "Or, if the password has no /, #, ?, %, @ or : in it:"
  Write-Host "  `$env:SUPABASE_DB_URL = `"postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`""
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
  Write-Host "  dashboard -> 'Connect' button (top of the project page)"
  Write-Host "    -> URI tab -> 'Session pooler'"
  Write-Host ""
  Write-Host "It looks like:"
  Write-Host "  postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
  Write-Host ""
  exit 1
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Invoke-Dump {
  # NOT $Args. `$Args` collides with PowerShell's AUTOMATIC $args variable
  # (case-insensitive) -- naming a parameter that corrupts binding in ways that
  # do not throw an error, so nothing here would have told you it happened. It
  # is exactly what produced three identical 847,937-byte files from three
  # pg_dump invocations with different flags: schema-only public, schema-only
  # auth, and data-only never diverged because the flag array was not reaching
  # pg_dump the way it looked like it would.
  param([string]$Label, [string[]]$PgArgs, [string]$OutFile)

  Write-Host "  $Label ..." -NoNewline
  $sw = [Diagnostics.Stopwatch]::StartNew()

  # ── pg_dump writes the file ITSELF, via --file ─────────────────────────────
  # NOT `| Out-File`. Piping a native command's stdout through PowerShell
  # decodes it using [Console]::OutputEncoding before re-encoding, so on a
  # console that is not UTF-8 (the default on many Windows installs is an OEM
  # code page) every multi-byte character is mangled in transit. This schema is
  # full of em dashes in column comments, and they came back as "ΓÇö" --
  # E2 80 94 read as DOS 437.
  #
  # The corruption is ENVIRONMENT-DEPENDENT, which is worse than consistently
  # broken: the same command produced a clean dump in one shell and a corrupted
  # one in another. Handing the path to pg_dump removes PowerShell from the
  # data path entirely and makes the output identical everywhere.
  #
  # stderr still needs a file, and $ErrorActionPreference still has to drop to
  # Continue around the call: in Windows PowerShell 5.1, redirecting a native
  # command's stderr AT ALL -- `2> file` as much as `2>&1` -- wraps each line in
  # a NativeCommandError, which is terminating under "Stop" even when pg_dump
  # exits 0. pg_dump warns legitimately (circular foreign keys, for one).
  # $LASTEXITCODE is the real verdict.
  $errFile = [IO.Path]::GetTempFileName()
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & pg_dump $DbUrl @PgArgs --file=$OutFile 2> $errFile
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prevEap
  $stderr = Get-Content $errFile -Raw
  Remove-Item $errFile -Force

  if ($code -ne 0) {
    Write-Host " FAILED" -ForegroundColor Red
    Write-Host $stderr -ForegroundColor Red
    exit 1
  }

  $kb = [math]::Round((Get-Item $OutFile).Length / 1KB, 1)
  Write-Host (" ok  {0} KB  ({1:n1}s)" -f $kb, $sw.Elapsed.TotalSeconds) -ForegroundColor Green

  # Show pg_dump's own words, not PowerShell's decoration of them. Even at
  # "Continue", PS 5.1 still writes a formatted NativeCommandError block into
  # the redirected stream -- the "At line:N char:M", the source echo, the
  # CategoryInfo -- which buries the one line that matters.
  if ($stderr) {
    $clean = ($stderr -split "`r?`n") | Where-Object {
      $_ -match '\S' -and
      $_ -notmatch '^\s*(At |\+|\s+\+ (CategoryInfo|FullyQualifiedErrorId))' -and
      $_ -notmatch '^\s*\+\s*~+\s*$'
    } | ForEach-Object { $_ -replace '^\s*pg_dump\.exe\s*:\s*', '' }
    $clean | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
  }
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

# ── Sanity check: no mojibake ────────────────────────────────────────────────
# The schema carries em dashes and arrows in its column comments. If the dump
# ever routes through a non-UTF-8 console again, they arrive as "ΓÇö" / "ΓÇ"
# and the file is quietly wrong. Cheaper to assert than to notice in a diff
# three commits later.
$mojibake = Select-String -LiteralPath "$OutDir/baseline.sql" -Pattern 'ÃÂ|ÃÂ|Ã¢â‚¬|ΓÇ' -SimpleMatch:$false -ErrorAction SilentlyContinue
if ($mojibake) {
  Write-Host ""
  Write-Host "FAILED: the dump contains mis-encoded characters." -ForegroundColor Red
  Write-Host "The file was written through a non-UTF-8 path." -ForegroundColor Red
  $mojibake | Select-Object -First 3 | ForEach-Object { Write-Host "  line $($_.LineNumber): $($_.Line.Trim())" -ForegroundColor DarkYellow }
  Write-Host ""
  exit 1
}

# ── Sanity check: the three dumps must actually differ ──────────────────────
# A schema-only public dump, a schema-only auth dump and a data-only public
# dump can NEVER legitimately be byte-identical. This caught the $Args
# collision above; it stays here so the same class of silent-binding bug can
# never again produce three copies of one file without the script saying so.
$hashes = @("$OutDir/baseline.sql", "$OutDir/auth_baseline.sql", "$OutDir/seed.sql") |
  ForEach-Object { (Get-FileHash $_ -Algorithm SHA256).Hash }
if (($hashes | Sort-Object -Unique).Count -ne 3) {
  Write-Host ""
  Write-Host "FAILED: two or more dumps are byte-identical. That is never" -ForegroundColor Red
  Write-Host "correct for schema-only-public / schema-only-auth / data-only." -ForegroundColor Red
  Write-Host "Something is wrong with how arguments are reaching pg_dump." -ForegroundColor Red
  Write-Host ""
  exit 1
}

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
