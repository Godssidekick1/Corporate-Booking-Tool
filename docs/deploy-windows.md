# Deploying on a Windows server

What arrives: the code (this folder, without `node_modules`, `.next` or any
`.env` file) and a database dump, `cbt-database-YYYY-MM-DD.dump`
(PostgreSQL custom format, made with PostgreSQL 18's `pg_dump`). Sign-in
sessions, pending invite and reset links, and sign-in attempts are not in the
dump; everyone signs in once. Passwords carry over.

## 1. Install

- **Node.js 24 LTS** (Next.js 16 needs 20.9 or later; built and tested on 24).
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

## 3. Configuration

Create `.env.local` in this folder (or set the same as system environment
variables). Never commit it.

| Variable | What |
|---|---|
| `DATABASE_URL` | `postgresql://user:password@host:5432/cbt` — what the app connects as |
| `MIGRATE_DATABASE_URL` | the owner's URL, for `npm run migrate` and scripts (optional if the same) |
| `DATABASE_CA_CERT` | path to the database's CA certificate, when the database is on another machine (verified TLS) |
| `NEXT_PUBLIC_APP_URL` | the site's address, e.g. `https://cbt.example.amadeus.com` (links in emails) |
| `AMADEUS_API_BASE_URL`, `AMADEUS_USERNAME`, `AMADEUS_PASSWORD`, `AMADEUS_CLIENT_CODE` | the flight API account |
| `INTERNAL_API_SECRET` | a long random string; protects `/api/internal/*` (approval escalation) |
| `MAIL_TRANSPORT`, `SMTP_URL`, `MAIL_FROM` | email. `smtp` with `SMTP_URL=smtp://user:pass@host:587` and `MAIL_FROM`; or `log` until SMTP exists (invite and reset links are then printed to the server log) |

The restricted login for the app is created by `npm run db:app-login`
(docs/database-roles.md).

## 4. Build and run

```powershell
npm ci
npm run migrate      # applies anything newer than the dump; normally "nothing pending"
npm run build
npm run start -- -p 3000
```

**Serve it over HTTPS.** The sign-in cookie is `Secure` (the `__Host-`
prefix requires it), so on plain HTTP sign-in works only on `localhost`. Put
IIS (URL Rewrite + Application Request Routing) or another reverse proxy in
front, terminating TLS and forwarding to `http://localhost:3000`, keeping the
`Host` header.

To keep it running after sign-out and across reboots, run `npm run start` as
a Windows service (for example with NSSM, or pm2 with pm2-windows-service).

`GET /api/health` answers when the app and its database are up.

## 5. Scheduled job

Approval escalation runs only when something calls it. Every 15 minutes
(Task Scheduler), from this folder:

```powershell
npm run escalate
```

It reads `NEXT_PUBLIC_APP_URL` and `INTERNAL_API_SECRET`.

## 6. Who can sign in

Real users keep their passwords. The dump also holds the **Demo Scale TMC**
(2,000 fake clients for trying the product at size); its sign-ins and
password are in `demo-logins.txt`, sent separately, never in the code.
`npm run demo:remove` deletes the whole demo TMC when it is no longer wanted.
