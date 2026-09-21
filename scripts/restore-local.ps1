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
    # psql's words only -- see the matching note in capture-schema.ps1.
    ($stderr -split "`r?`n") | Where-Object {
      $_ -match '\S' -and
      $_ -notmatch '^\s*(At |\+|\s+\+ (CategoryInfo|FullyQualifiedErrorId))' -and
      $_ -notmatch '^\s*\+\s*~+\s*$'
    } | ForEach-Object { Write-Host ("    " + ($_ -replace '^\s*psql\.exe\s*:\s*', '')) -ForegroundColor DarkGray }
  }
}

$script:psqlBase = @("-h", "localhost", "-U", $SuperUser, "-v", "ON_ERROR_STOP=1", "-q")

# Set on the CONNECTION rather than as a statement. Two reasons this is not
# just a style choice:
#   - a `set` prepended to another statement inside one -c makes psql send both
#     as a single query string, which it wraps in an implicit transaction --
#     fatal for DROP DATABASE, which cannot run inside one;
#   - it applies to every call below without each having to remember.
# WARNING and above still surface; only NOTICE is quietened, and nothing here
# reports on notices -- the restore is triaged by grepping for ERROR.
$env:PGOPTIONS = "-c client_min_messages=warning"

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
# A single statement, deliberately. Putting `set client_min_messages = warning;`
# in front of this inside one -c makes psql send both as ONE query string, which
# it wraps in an implicit transaction -- and DROP DATABASE cannot run inside a
# transaction block. The message level is set per-connection via PGOPTIONS
# above instead, which has no such constraint.
Invoke-Psql "dropping $Database if present" `
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

# ── 3b. A minimal `auth` schema ──────────────────────────────────────────────
# Supabase provides schema `auth`, and the dump depends on it in two ways:
#   - two RLS policies call auth.uid()
#   - two foreign keys reference auth.users(id)
#
# Authentication is deliberately NOT moving in this sprint -- it keeps talking
# to Supabase while the data lives here -- so `auth` does not exist locally and
# both kinds of object failed to restore.
#
# We create the FUNCTION but NOT the users TABLE, and that asymmetry is the
# whole point:
#
#   auth.uid()   -> created, so all 17 RLS policies restore exactly as in
#                   production. Reads a GUC, so once the repository layer
#                   starts issuing SET LOCAL it will return a real value and
#                   the policies become testable locally.
#
#   auth.users   -> deliberately absent, so the two FKs keep failing. That is
#                   the outcome we want: an empty local auth.users would make
#                   every employee row with a non-null auth_user_id fail to
#                   load, and copying real auth.users here would put password
#                   hashes and emails on a dev machine for no benefit.
#                   Supabase stays the source of truth for identity.
$authStub = @"
create schema if not exists auth;

-- Mirrors Supabase's own definition closely enough for policy restore, and
-- reads the same GUC the repository layer will set per transaction.
create or replace function auth.uid() returns uuid
  language sql stable
as `$fn`$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      current_setting('app.current_user_id', true)
    ), ''
  )::uuid
`$fn`$;
"@
Invoke-Psql "creating auth.uid() stub" -PsqlArgs @("-d", $Database) -Sql $authStub

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

# ── 5. The deliberate divergence from production ─────────────────────────────
# TWO foreign keys reach from application data into Supabase's auth schema:
#
#   employees.auth_user_id  -> auth.users(id)  ON DELETE SET NULL
#   platform_admins.user_id -> auth.users(id)  ON DELETE CASCADE
#
# Neither appears in supabase/migrations -- employees.auth_user_id exists only
# in the live database, and is written by application code in five places. It
# was found by dumping the real schema, which is the argument for having done
# that first.
#
# Both stay absent locally. They cannot restore (auth.users does not exist
# here, by design -- see 3b) and they could not be enforced meaningfully anyway
# while identity lives in Supabase. This is the one structural difference
# between cbt_local and production, and it is deliberate.
#
# They come back when GoTrue is self-hosted, which is a separate scheduled task
# before production.
$dropFk = @"
do `$`$
declare
  t text;
  c text;
begin
  foreach t in array array['public.employees', 'public.platform_admins'] loop
    begin
      for c in
        select con.conname
          from pg_constraint con
          join pg_class rel on rel.oid = con.conrelid
          join pg_namespace ns on ns.oid = rel.relnamespace
         where con.contype = 'f'
           and format('%I.%I', ns.nspname, rel.relname) = t
           and con.confrelid::regclass::text like 'auth.%'
      loop
        execute format('alter table %s drop constraint %I', t, c);
      end loop;
    exception when undefined_table then null;
    end;
  end loop;
end `$`$;
"@
Invoke-Psql "ensuring auth.users FKs are absent" -PsqlArgs @("-d", $Database) -Sql $dropFk

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

# ── Did the DATA actually land? ──────────────────────────────────────────────
# "restoring seed.sql ... ok" only says psql exited 0. It does not say rows
# arrived, and the circular foreign key between clients -> branches ->
# employees is exactly the shape that produces a partial load. Counting the
# rows is the only statement that settles it.
if ($WithData) {
  Write-Host ""
  Write-Host "Rows loaded:" -ForegroundColor Cyan
  $counts = @"
select 'tmcs' as t, count(*) from tmcs
union all select 'clients', count(*) from clients
union all select 'employees', count(*) from employees
union all select 'branches', count(*) from branches
union all select 'bookings', count(*) from bookings
union all select 'commercial_rules', count(*) from commercial_rules
union all select 'approvals', count(*) from approvals
order by 1;
"@
  $counts | & psql -h localhost -U $SuperUser -d $Database -P pager=off

  $empty = & psql -h localhost -U $SuperUser -d $Database -t -A -c "select count(*) from employees;"
  if ($empty -eq '0') {
    Write-Host ""
    Write-Host "WARNING: employees is empty. The data did not load." -ForegroundColor Red
    Write-Host "Check that seed.sql exists and is non-empty." -ForegroundColor Red
  }
}

Write-Host ""
Write-Host "Point the app at it with:" -ForegroundColor Cyan
Write-Host "  DATABASE_URL=postgresql://$SuperUser@localhost:5432/$Database"
Write-Host ""
