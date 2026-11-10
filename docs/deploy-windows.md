# Deploying on a Windows server

What arrives: the code (this folder, without `node_modules`, `.next` or any
`.env` file) and a database dump, `cbt-database-YYYY-MM-DD.dump`
(PostgreSQL custom format, made with PostgreSQL 18's `pg_dump`). Sign-in
sessions, pending invite and reset links, and sign-in attempts are not in the
dump; everyone signs in once. Passwords carry over.

## 1. Install

- **Node.js 24 LTS** (Next.js 16 needs 20.9 or later; built and tested on 24).
  npm comes with it; nothing else is installed globally (Next.js is one of
  the project's packages). `npm ci` downloads the packages, so the server
  needs to reach `registry.npmjs.org` or an npm proxy
  (`npm config set proxy http://…`).
- **PostgreSQL 18**, or at least its client tools: a dump made by
  `pg_dump` 18 restores only with `pg_restore` 18 or later. The server itself
  may be 15 or later.

## 2. Database

```powershell
# As the PostgreSQL superuser. The dump grants table access to cbt_app, the
# restricted role the app is meant to run as (docs/database-roles.md);
# create it first so those grants restore.
psql -U postgres -c "create role cbt_app nologin"
psql -U postgres -c "create database cbt"
pg_restore -U postgres -d cbt --no-owner --exit-on-error cbt-database-YYYY-MM-DD.dump
```

`--exit-on-error` makes any problem stop the restore instead of leaving a
partial copy. To skip the role entirely, use `--no-privileges` instead (the
app then has to connect as the owner).

**An empty database instead of a dump:** with `MIGRATE_DATABASE_URL` naming
the owner and a database that does not exist yet, `npm run db:create` builds
it from `schema/baseline.sql` (the schema, plus countries, regions, airports
and airlines), creates `cbt_app` if needed, and applies any newer migration.
No clients, people or bookings: those come only from a dump.

## 3. Configuration

Create `.env.local` in this folder (or set the same as system environment
variables). Never commit it.

| Variable | What |
|---|---|
| `DATABASE_URL` | `postgresql://user:password@host:5432/cbt` — what the app connects as |
| `MIGRATE_DATABASE_URL` | the owner's URL, for `npm run migrate` and scripts (optional if the same) |
| `DATABASE_CA_CERT` | the database's CA certificate itself (PEM text, on one line with `\n` for the line breaks), when the database is on another machine: the server is then verified. A server with no TLS at all: end both database URLs with `?sslmode=disable` instead |
| `NEXT_PUBLIC_APP_URL` | the site's address, e.g. `https://cbt.example.amadeus.com` (links in emails) |
| `AMADEUS_API_BASE_URL`, `AMADEUS_USERNAME`, `AMADEUS_PASSWORD`, `AMADEUS_CLIENT_CODE` | the flight API account |
| `INTERNAL_API_SECRET` | a long random string; protects `/api/internal/*` (approval escalation) |
| `MAIL_TRANSPORT`, `SMTP_URL`, `MAIL_FROM` | email. `smtp` with `SMTP_URL=smtp://user:pass@host:587` and `MAIL_FROM`; or `log` until SMTP exists (invite and reset links are then printed to the server log) |

Start with `MIGRATE_DATABASE_URL` (the owner) and no `DATABASE_URL`:
`npm run db:app-login` (step 4) creates the app's restricted login and writes
`DATABASE_URL` itself (docs/database-roles.md). Special characters in a
password (`? # / @ : %` and spaces) must be percent-encoded in the URL: `?` is
`%3F`.

## 4. Build and run

```powershell
npm ci
npm run migrate        # applies anything newer than the dump
npm run db:app-login   # once per database: the app's own login, written into DATABASE_URL
npm run build
npm run start -- -p 3000
```

`npm run db:app-login` sets a new password each time it runs. When more than
one machine runs the app against the same database, run it on one and copy
the resulting `DATABASE_URL` to the others; running it again elsewhere locks
out the first.

**Once, after the first start:**
- The dump includes the demo TMC. Its people seeded before 2026-11-05 have
  numbers in their names, which airlines refuse. Run
  `node scripts/demo-tmc.mjs names` once to give them letters-only names.
- Refunds for cancelled tickets are processed under Configurations → Queues
  → Cancellation queues. TMC admins can do it already; give a travel
  counsellor the **Process refunds** permission under Users (TCs).

**Serve it over HTTPS.** The sign-in cookie is `Secure` (the `__Host-`
prefix requires it), so on plain HTTP sign-in works only on `localhost`. Put
IIS (URL Rewrite + Application Request Routing) or another reverse proxy in
front, terminating TLS and forwarding to `http://localhost:3000`, keeping the
`Host` header.

To keep it running after sign-out and across reboots, run `npm run start` as
a Windows service (for example with NSSM, or pm2 with pm2-windows-service).

`GET /api/health` answers when the app and its database are up.

## 5. Nothing to schedule

Approval escalation (a step that waited too long passes to the approver's
manager) runs inside the server: every 5 minutes while it is up, and once
30 seconds after it starts, which catches up on anything that fell due while
it was down. Several servers side by side are safe; each approval is claimed
once.

| Variable | What |
|---|---|
| `ESCALATION_SWEEP_MINUTES` | how often, default 5 |
| `ESCALATION_SWEEP=off` | switch it off, for example when an external scheduler calls `npm run escalate` instead |

## 6. Security headers

Every response carries framing, sniffing, referrer and permissions rules,
and in production `Strict-Transport-Security` for this host (not its
subdomains). Once a browser has seen that header it refuses plain HTTP to
the host for a year, so turn HTTPS on before the first production visit.

## 7. Who can sign in

Real users keep their passwords. The dump also holds the **Demo Scale TMC**
(2,000 fake clients for trying the product at size); its sign-ins and
password are in `demo-logins.txt`, sent separately, never in the code.
`npm run demo:remove` deletes the whole demo TMC when it is no longer wanted.
