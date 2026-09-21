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
#   .\scripts\restore-local.ps1            # schema only
#   .\scripts\restore-local.ps1 -WithData  # schema + local seed data
# ─────────────────────────────────────────────────────────────────────────────

param(
  [string]$Database = "cbt_local",
  [string]$SuperUser = "postgres",
  [string]$OutDir = "schema",
  [switch]$WithData
)

$ErrorActionPreference = "Stop"

$pgbin = "C:\Program Files\PostgreSQL\18\bin"
if (Test-Path $pgbin) { $env:Path = "$env:Path;$pgbin" }

if (-not (Test-Path "$OutDir/baseline.sql")) {
  Write-Host "$OutDir/baseline.sql not found. Run .\scripts\capture-schema.ps1 first." -ForegroundColor Red
  exit 1
}

# The local superuser's password. Set PGPASSWORD before running, or rely on a
# pgpass file / trust auth for localhost.
if (-not $env:PGPASSWORD -and -not $env:PGPASSFILE) {
  Write-Host "note: PGPASSWORD is not set; relying on pgpass/trust for localhost" -ForegroundColor DarkYellow
}

$psqlBase = @("-h", "localhost", "-U", $SuperUser, "-v", "ON_ERROR_STOP=0", "-q")

Write-Host ""
Write-Host "Rebuilding $Database on local PostgreSQL 18" -ForegroundColor Cyan
Write-Host ""

# ── 1. Roles Supabase's dump references ──────────────────────────────────────
# A Supabase dump carries GRANT statements aimed at roles that exist only in
# their platform. Even with --no-privileges some references survive (default
# privileges, policy definitions, function owners). Creating them as no-login
# stubs is far simpler than sed-ing the dump, and harmless: nothing can
# authenticate as them.
Write-Host "  creating Supabase role stubs ..." -NoNewline
$roles = @(
  "anon", "authenticated", "service_role", "authenticator",
  "supabase_admin", "supabase_auth_admin", "supabase_storage_admin",
  "dashboard_user", "pgbouncer", "supabase_realtime_admin"
)
$roleSql = ($roles | ForEach-Object {
  "do `$`$ begin if not exists (select from pg_roles where rolname = '$_') then create role $_ nologin noinherit; end if; end `$`$;"
}) -join "`n"
$roleSql | & psql @psqlBase -d postgres 2>&1 | Out-Null
Write-Host " ok" -ForegroundColor Green

# ── 2. Fresh database ────────────────────────────────────────────────────────
Write-Host "  dropping and recreating $Database ..." -NoNewline
& psql @psqlBase -d postgres -c "drop database if exists $Database with (force);" 2>&1 | Out-Null
& psql @psqlBase -d postgres -c "create database $Database;" 2>&1 | Out-Null
Write-Host " ok" -ForegroundColor Green

# ── 3. Extensions ────────────────────────────────────────────────────────────
# The schema uses gen_random_uuid() (pgcrypto/pgvector-era builtin in PG13+,
# but explicit here) and an EXCLUDE ... USING gist constraint for GST period
# overlap, which needs btree_gist.
Write-Host "  installing extensions ..." -NoNewline
$ext = @(
  "create extension if not exists pgcrypto;",
  "create extension if not exists btree_gist;",
  "create extension if not exists `"uuid-ossp`";"
) -join "`n"
$ext | & psql @psqlBase -d $Database 2>&1 | Out-Null
Write-Host " ok" -ForegroundColor Green

# ── 4. The schema ────────────────────────────────────────────────────────────
# ON_ERROR_STOP=0 deliberately: we want the FULL list of what fails, not the
# first failure. The errors are the working list for restore_notes.md.
Write-Host "  restoring baseline.sql ..." -NoNewline
$errFile = [IO.Path]::GetTempFileName()
& psql @psqlBase -d $Database -f "$OutDir/baseline.sql" 2> $errFile | Out-Null
$errors = Get-Content $errFile -ErrorAction SilentlyContinue
Remove-Item $errFile -Force
Write-Host " done" -ForegroundColor Green

if ($errors) {
  $real = $errors | Where-Object { $_ -match "^psql:.*ERROR" }
  if ($real) {
    Write-Host ""
    Write-Host "  $($real.Count) errors during restore:" -ForegroundColor Yellow
    $real | Select-Object -First 25 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
    if ($real.Count -gt 25) { Write-Host "    ... and $($real.Count - 25) more" -ForegroundColor DarkYellow }
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
Write-Host "  dropping platform_admins -> auth.users FK ..." -NoNewline
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
$dropFk | & psql @psqlBase -d $Database 2>&1 | Out-Null
Write-Host " ok" -ForegroundColor Green

# ── 6. Data, optionally ──────────────────────────────────────────────────────
if ($WithData) {
  if (Test-Path "$OutDir/seed.sql") {
    Write-Host "  restoring seed.sql ..." -NoNewline
    & psql @psqlBase -d $Database -f "$OutDir/seed.sql" 2>&1 | Out-Null
    Write-Host " done" -ForegroundColor Green
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
$summary | & psql @psqlBase -d $Database -P pager=off

Write-Host ""
Write-Host "Point the app at it with:" -ForegroundColor Cyan
Write-Host "  DATABASE_URL=postgresql://$SuperUser@localhost:5432/$Database"
Write-Host ""
