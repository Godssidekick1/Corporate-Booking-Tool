# Database roles

The application should not connect as the owner of the tables. Two roles:

| Role | Used by | Can |
|---|---|---|
| owner (e.g. `postgres`) | `npm run migrate` only | everything: create and alter tables, write the migration history |
| `cbt_app` (no login) | the running app, through a login in this role | read and write rows; read the migration history. No DDL, owns nothing, cannot bypass row-level security |

`cbt_app` is created by `20261009000300_app_role.sql`, with an `app_access`
row-level-security policy on every table. The test suite runs as a login in
this role (`cbt_app_test`, re-passworded at random each run), so every test
proves the app works with these privileges.

## Tenant isolation in the database

Since `20261012000000_tenant_policies.sql`, the database itself refuses
another tenant's rows to the app role, whatever the query asks for. Every
query carries three settings (`app/lib/db/context.ts`):

| Setting | Value |
|---|---|
| `app.scope` | `tenant` once someone is signed in; `system` for the few paths that run before (sign-in, password links, the public ticket link, the provisioning hook) and for platform admins; empty otherwise |
| `app.tmc_id` | the caller's TMC |
| `app.client_id` | a corporate user's client; empty for TMC staff |

| Caller | Sees |
|---|---|
| no scope | no tenant rows at all (a forgotten scope fails closed) |
| TMC staff | their TMC's rows and its clients' rows |
| corporate user | their client's rows, and the TMC's shared rows that name no client (masters, templates) |
| system | everything |

A travel counsellor's narrower set of clients is still applied by the code
(`getAccessibleClientIds`); the database draws the line at the TMC.

Shared tables keep an allow-all policy: reference data (airlines, airports,
places) and the sign-in tables (accounts, sessions, tokens, attempts,
platform admins, rate limits), which hold no tenant's rows and are reached
only by `app/lib/auth`. `tests/schema.test.ts` lists them; any other table
whose policy admits everything fails it. `audit_log` also accepts an insert
from any request (events like a sign-in belong to no tenant); reading it is
tenant-scoped.

**The owner bypasses all of this.** Locally the app still connects as the
owner until the restricted login is set up (below), so the policies are
proven by the test suite (`tests/security/rowLevelSecurity.test.ts`) rather
than by the running app. Behind a transaction pooler set
`DB_POOL_MODE=transaction` (automatic on Vercel): the settings are then sent
with every query inside its own transaction.

Every policy is plain equality on the row's own tenant columns
(`20261012000100_tenant_columns.sql`), so the planner can estimate it and use
indexes: client-scoped tables carry a `tmc_id` filled from their client by a
trigger (a value a writer sends is overwritten), and `employees` carries
`tenant_tmc_id` the same way. Each setting is read once per query,
`(select app_tmc())`, not once per row.

A new tenant table needs a scoped `app_access` policy in the same migration,
in the same form: copy it from `20261012000100_tenant_columns.sql` (and give
a client-scoped table the `fill_tmc` trigger).

## Switching an environment over

1. Apply migrations as the owner: `npm run migrate`.
2. As the owner, create the app's login with a strong password, entered by
   whoever runs it (never in the repository):

   ```sql
   create role cbt_app_login login password '<strong password>' in role cbt_app;
   -- A runaway query, or a transaction left open by a crashed request, is cut
   -- off instead of holding one of the pool's few connections until the app
   -- runs out of them. Set on the login, so it holds through any pooler.
   alter role cbt_app_login set statement_timeout = '15s';
   alter role cbt_app_login set idle_in_transaction_session_timeout = '30s';
   ```

   The test suite's login carries the same two limits, so a change that needs
   longer fails the tests first.

3. Point the app at it, and keep the owner for migrations:

   ```
   DATABASE_URL=postgresql://cbt_app_login:<password>@<host>:<port>/<db>
   MIGRATE_DATABASE_URL=postgresql://<owner>:<password>@<host>:<port>/<db>
   ```

   On Vercel only `DATABASE_URL` is needed (migrations are run from a
   developer machine).

4. Check `/api/health` returns 200.

A new table needs an `app_access` policy in the same migration (copy the
`create policy` line from `20261009000300_app_role.sql`); `tests/schema.test.ts`
fails until it has one.

## TLS

Set `DATABASE_CA_CERT` to the database server's CA certificate (PEM; `\n`
escapes are fine) so the app verifies the server it connects to. Without it
the connection is encrypted but unauthenticated, and the boot log says so.
