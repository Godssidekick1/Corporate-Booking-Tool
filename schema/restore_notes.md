# Restoring the Supabase schema onto local PostgreSQL

What `scripts/restore-local.ps1` has to do that a plain `psql < baseline.sql`
does not, and why. Every item here was found by actually running the restore.

## The schema was not in this repository

`supabase/migrations/` contains 27 files, but **14 of the 38 tables the code
queries have no `CREATE TABLE` in any of them** — `employees`, `clients`,
`tmcs`, `bookings`, `approvals`, `trips` among them. The migrations only
`ALTER` those tables.

The live database was the only complete description of the schema until
`baseline.sql` was captured. Two consequences worth stating plainly:

- **The real schema has 41 tables**, and `baseline.sql` is now the source of
  truth for all of them.
- **Things exist in production that no migration mentions.** The clearest
  example is `employees.auth_user_id`, below. Anything reasoned about by
  reading `supabase/migrations/` alone is reasoning about a partial picture.

## Restore errors, and what each one means

A first run reports five errors. Four are expected and one is noise.

| Error | Verdict |
|---|---|
| `schema "public" already exists` | Noise. `createdb` already made it. |
| `employees_auth_user_id_fkey` → `auth.users` | **Expected.** See below. |
| `platform_admins_user_id_fkey` → `auth.users` | **Expected.** See below. |
| 2 × `CREATE POLICY ... auth.uid()` | **Fixed** by the `auth.uid()` stub. |

## The `auth` schema

Supabase provides a schema called `auth`. Authentication is deliberately NOT
moving in this sprint — the application keeps talking to Supabase for
`/auth/v1/*` while its data lives locally — so `auth` does not exist here.

The dump depends on it two ways, and they are handled differently on purpose.

### `auth.uid()` — created

Two RLS policies call it. The restore script defines a stub:

```sql
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(
    current_setting('request.jwt.claim.sub', true),
    current_setting('app.current_user_id', true)
  ), '')::uuid
$$;
```

With it, **all 17 policies restore exactly as in production**. It reads a GUC,
so once the repository layer starts issuing `SET LOCAL app.current_user_id` per
transaction it returns a real value and the policies become testable locally —
which they are not today against Supabase, because every query goes through the
service role and bypasses RLS entirely.

### `auth.users` — deliberately absent

Two foreign keys reference it:

```
employees.auth_user_id  -> auth.users(id)  ON DELETE SET NULL
platform_admins.user_id -> auth.users(id)  ON DELETE CASCADE
```

Both are dropped locally, and stay dropped. Three reasons:

1. An **empty** local `auth.users` would be worse than none: every `employees`
   row with a non-null `auth_user_id` would fail to load from `seed.sql`.
2. Copying the real `auth.users` here would put password hashes and email
   addresses on a developer machine to satisfy a constraint that buys nothing.
3. While identity lives in Supabase, the constraint cannot be enforced
   meaningfully from this database in any case.

**This is the only structural difference between `cbt_local` and production.**
It reverses when GoTrue is self-hosted — a separate scheduled task before
production, for which `auth_baseline.sql` is already captured.

### `employees.auth_user_id` is not vestigial

Worth flagging, because it is easy to assume otherwise: it appears in **no
migration**, but application code writes it in five places (client and employee
onboarding routes). `employees.id` separately holds the same uuid as the auth
user by convention, with no constraint — so there are two links to identity,
one enforced in the database and one only by convention.

## Circular foreign keys

`pg_dump` warns on the data dump:

```
circular foreign-key constraints among these tables:
  clients, branches, employees
```

`clients → branches → employees → clients`. Two consequences:

- `--disable-triggers` on the data dump is **required**, not optional. It is
  already passed.
- When the repository layer begins wrapping writes in real transactions,
  **insert order across these three tables matters** and cannot be resolved by
  ordering alone — one of the three will always need its FK deferred or filled
  in by a follow-up update.

## PowerShell traps hit on the way

Recorded because both cost real time and neither produces a useful error.

**`$Args` is an automatic variable.** A function parameter named `$Args`
(case-insensitive) corrupts binding silently. It made three `pg_dump`
invocations with different flags produce three byte-identical 847,937-byte
files, with no error at any point. `capture-schema.ps1` now asserts the three
dumps differ by SHA-256 and fails loudly if they do not.

**Any stderr redirection of a native command is dangerous under
`$ErrorActionPreference = "Stop"`.** In Windows PowerShell 5.1 this applies to a
bare `2> file` exactly as much as to `2>&1`: each stderr line becomes a
`NativeCommandError`, which is *terminating* even when the executable exits 0.
A harmless `NOTICE: database "cbt_local" does not exist, skipping` was enough to
kill the whole restore. Both scripts now drop to `Continue` around native calls
and judge success by `$LASTEXITCODE`.

## Result of a clean restore

```
 tables | foreign_keys | check_constraints | indexes | rls_policies
--------+--------------+-------------------+---------+--------------
     41 |          106 |                52 |     148 |           17
```

`foreign_keys` is 106 rather than 108 — the two `auth.users` references above.
`rls_policies` reaches 17 only once the `auth.uid()` stub exists; without it,
15.
