# Database roles

The application should not connect as the owner of the tables. Two roles:

| Role | Used by | Can |
|---|---|---|
| owner (e.g. `postgres`) | `npm run migrate` only | everything: create and alter tables, write the migration history |
| `cbt_app` (no login) | the running app, through a login in this role | read and write rows; read the migration history. No DDL, owns nothing, cannot bypass row-level security |

`cbt_app` is created by `20261009000300_app_role.sql`, with an `app_access`
row-level-security policy on every table. Today that policy allows all rows;
tenant rules replace it table by table later. The test suite runs as a login
in this role (`cbt_app_test`, re-passworded at random each run), so every
test proves the app works with these privileges.

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
