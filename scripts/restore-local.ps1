# ── restore-local.ps1 ────────────────────────────────────────────────────────
# Rebuilds the captured Supabase schema on the local PostgreSQL 18 instance.
#
# This is the proof that capture-schema.ps1 produced something usable. A dump
# that has never been restored is not a backup, it is a file — and the failure
# modes below are exactly the ones that only appear on restore.
#
# IDEMPOTENT: drops and recreates cbt_local each run, so it can be run as often
# as needed while working out the restore errors.
#
# USAGE
#   .\scripts\restore-local.ps1 -LocalPassword "<your local postgres password>"
#   .\scripts\restore-local.ps1 -LocalPassword "..." -WithData
#
# This is the LOCAL PostgreSQL 18 password -- set on THIS machine when it was
# installed. It has nothing to do with Supabase; do not pass Supabase
# credentials here. If PGPASSWORD is already set in the environment,
# -LocalPassword can be omitted.
# ─────────────────────────────────────────────────────────────────────────────

param(
  [string]$Database = "cbt_local",
  [string]$SuperUser = "postgres",
  [string]$OutDir = "schema",
  [switch]$WithData,
  [string]$LocalPassword
)

$ErrorActionPreference = "Stop"

$pgbin = "C:\Program Files\PostgreSQL\18\bin"
if (Test-Path $pgbin) { $env:Path = "$env:Path;$pgbin" }

if (-not (Test-Path "$OutDir/baseline.sql")) {
  Write-Host "$OutDir/baseline.sql not found. Run .\scripts\capture-schema.ps1 first." -ForegroundColor Red
  exit 1
}

if ($LocalPassword) { $env:PGPASSWORD = $LocalPassword }

if (-not $env:PGPASSWORD -and -not $env:PGPASSFILE) {
  Write-Host ""
  Write-Host "No local PostgreSQL password supplied." -ForegroundColor Red
  Write-Host "  .\scripts\restore-local.ps1 -LocalPassword `"<password you set when installing PG18>`""
  Write-Host ""
  exit 1
}

# ── Native-command stderr, handled correctly ─────────────────────────────────
# Every call below used `2>&1 | Out-Null`. Under Windows PowerShell 5.1, piping
# a native executable's stderr through `2>&1` wraps EACH LINE in a
# NativeCommandError -- and with $ErrorActionPreference = "Stop", that is a
# TERMINATING error, even when the command's real exit code is 0. This is
# exactly what killed the previous run: dropping a database that does not
# exist yet makes psql print a harmless NOTICE to stderr, and that NOTICE alone
# stopped the script before it reached the actual schema restore.
#
# The fix used throughout below: redirect stderr to a file with a bare `2>`,
# never `2>&1`, and inspect $LASTEXITCODE explicitly. A NOTICE then stays a
# NOTICE.
function Invoke-Psql {
  param([string]$Label, [string[]]$PsqlArgs, [string]$Sql, [switch]$AllowNotices)

  Write-Host "  $Label ..." -NoNewline
  $errFile = [IO.Path]::GetTempFileName()

  # See the note in capture-schema.ps1: in PowerShell 5.1 ANY stderr
  # redirection of a native command (`2> file` as much as `2>&1`) turns each
  # stderr line into a NativeCommandError, which is terminating under "Stop".
  # psql writes NOTICE and WARNING to stderr as a matter of course, so this has
  # to be relaxed around the call. $LASTEXITCODE is what actually decides.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  if ($Sql) {
    $Sql | & psql @script:psqlBase @PsqlArgs 2> $errFile | Out-Null
  } else {
    & psql @script:psqlBase @PsqlArgs 2> $errFile | Out-Null
  }
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prevEap
  $stderr = Get-Content $errFile -Raw -ErrorAction SilentlyContinue
  Remove-Item $errFile -Force -ErrorAction SilentlyContinue

  # psql's own exit code is the truth, not the presence of stderr output --
  # NOTICE and WARNING lines are normal and expected here.
  if ($code -ne 0) {
    Write-Host " FAILED" -ForegroundColor Red
    if ($stderr) { Write-Host $stderr -ForegroundColor Red }
    exit 1
  }

  Write-Host " ok" -ForegroundColor Green
  if ($stderr -and $AllowNotices) {
    ($stderr.Trim() -split "`n") | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
  }
}

$script:psqlBase = @("-h", "localhost", "-U", $SuperUser, "-v", "ON_ERROR_STOP=1", "-q")

Write-Host ""
Write-Host "Rebuilding $Database on local PostgreSQL 18" -ForegroundColor Cyan
Write-Host ""

# ── 1. Roles Supabase's dump references ──────────────────────────────────────
# A Supabase dump carries GRANT statements aimed at roles that exist only in
# their platform. Even with --no-privileges some references survive (default
# privileges, policy definitions, function owners). Creating them as no-login
# stubs is far simpler than sed-ing the dump, and harmless: nothing can
# authenticate as them.
$roles = @(
  "anon", "authenticated", "service_role", "authenticator",
  "supabase_admin", "supabase_auth_admin", "supabase_storage_admin",
  "dashboard_user", "pgbouncer", "supabase_realtime_admin"
)
$roleSql = ($roles | ForEach-Object {
  "do `$`$ begin if not exists (select from pg_roles where rolname = '$_') then create role $_ nologin noinherit; end if; end `$`$;"
}) -join "`n"
Invoke-Psql "creating Supabase role stubs" -PsqlArgs @("-d", "postgres") -Sql $roleSql

# ── 2. Fresh database ────────────────────────────────────────────────────────
# The drop legitimately prints a NOTICE the first time this ever runs ("database
# does not exist, skipping") -- expected, not a failure. -AllowNotices shows it
# rather than hiding it, so a genuinely unexpected notice is still visible.
Invoke-Psql "dropping $Database if present" -AllowNotices `
  -PsqlArgs @("-d", "postgres", "-c", "drop database if exists $Database with (force);")
Invoke-Psql "creating $Database" `
  -PsqlArgs @("-d", "postgres", "-c", "create database $Database;")

# ── 3. Extensions ────────────────────────────────────────────────────────────
# The schema uses an EXCLUDE ... USING gist constraint for GST period overlap,
# which needs btree_gist. pgcrypto covers gen_random_uuid().
$ext = @(
  "create extension if not exists pgcrypto;",
  "create extension if not exists btree_gist;",
  "create extension if not exists `"uuid-ossp`";"
) -join "`n"
Invoke-Psql "installing extensions" -PsqlArgs @("-d", $Database) -Sql $ext

# ── 4. The schema ────────────────────────────────────────────────────────────
# ON_ERROR_STOP=0, overriding the base for this one call: we want the FULL list
# of what fails, not the first failure -- the errors are the working list for
# restore_notes.md. Everything else in this script keeps ON_ERROR_STOP=1.
Write-Host "  restoring baseline.sql ..." -NoNewline
$errFile = [IO.Path]::GetTempFileName()
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& psql -h localhost -U $SuperUser -v ON_ERROR_STOP=0 -q -d $Database -f "$OutDir/baseline.sql" 2> $errFile | Out-Null
$restoreCode = $LASTEXITCODE
$ErrorActionPreference = $prevEap
$errors = Get-Content $errFile -ErrorAction SilentlyContinue
Remove-Item $errFile -Force -ErrorAction SilentlyContinue
Write-Host " done" -ForegroundColor Green

if ($errors) {
  $real = $errors | Where-Object { $_ -match "ERROR:" }
  if ($real) {
    Write-Host ""
    Write-Host "  $($real.Count) errors during restore (expected on the first run):" -ForegroundColor Yellow
    $real | Select-Object -First 25 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
    if ($real.Count -gt 25) { Write-Host "    ... and $($real.Count - 25) more" -ForegroundColor DarkYellow }
    Write-Host ""
    Write-Host "  Record these in schema/restore_notes.md once triaged." -ForegroundColor DarkYellow
  }
}

# ── 5. The one deliberate divergence from production ─────────────────────────
# platform_admins.user_id references auth.users(id). That is the ONLY hard
# foreign key from application data into Supabase's auth schema — employees.id
# holds the same uuid but has no constraint on it.
#
# Dropping it is what lets the data move to local PostgreSQL while auth keeps
# talking to Supabase, which is the whole reason this sprint does not have to
# touch authentication. Recorded as a migration, not done by hand.
$dropFk = @"
do `$`$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'public.platform_admins'::regclass and contype = 'f';
  if c is not null then
    execute format('alter table public.platform_admins drop constraint %I', c);
  end if;
exception when undefined_table then null;
end `$`$;
"@
Invoke-Psql "dropping platform_admins -> auth.users FK" -PsqlArgs @("-d", $Database) -Sql $dropFk

# ── 6. Data, optionally ──────────────────────────────────────────────────────
if ($WithData) {
  if (Test-Path "$OutDir/seed.sql") {
    Invoke-Psql "restoring seed.sql" -PsqlArgs @("-d", $Database, "-f", "$OutDir/seed.sql")
  } else {
    Write-Host "  seed.sql not present, skipping data" -ForegroundColor DarkYellow
  }
}

# ── 7. What we ended up with ─────────────────────────────────────────────────
Write-Host ""
$summary = @"
select
  (select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE') as tables,
  (select count(*) from pg_constraint where contype='f') as foreign_keys,
  (select count(*) from pg_constraint where contype='c') as check_constraints,
  (select count(*) from pg_indexes where schemaname='public') as indexes,
  (select count(*) from pg_policies where schemaname='public') as rls_policies;
"@
Write-Host "Result:" -ForegroundColor Cyan
$summary | & psql -h localhost -U $SuperUser -d $Database -P pager=off

Write-Host ""
Write-Host "Point the app at it with:" -ForegroundColor Cyan
Write-Host "  DATABASE_URL=postgresql://$SuperUser@localhost:5432/$Database"
Write-Host ""
