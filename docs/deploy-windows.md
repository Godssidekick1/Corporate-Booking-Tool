# Deploying on a Windows server (IIS)

Two steps:

1. **Publish** (on a developer's machine): `npm run release` builds one
   package, a zip, from the last commit. It holds a self-contained Node
   server, its static files, the database migrations and the scripts that
   apply them.
2. **Deploy** (on the server): IIS holds the HTTPS certificate and forwards
   every request to that Node server, which listens on `127.0.0.1:3000` and is
   kept running by a Windows scheduled task.

The server needs **Node.js** and **IIS**. It does not need git, npm access or
the source code.

---

## Part A: Publish (developer's machine)

1. **Commit what is to be deployed.** The package is built from the last
   commit only; uncommitted changes are never shipped (the script says so if
   there are any).
2. **Run the tests**, alone: `CI=true npx vitest run`, then `npm run lint`.
3. **Build the package** for the environment's address. Sign-in needs HTTPS,
   and the address is fixed into the build (links in emails, the ticket QR),
   so each environment gets its own package:

   ```powershell
   $env:NEXT_PUBLIC_APP_URL = "https://cbt-uat.example.com"
   npm run release -- uat
   Remove-Item Env:NEXT_PUBLIC_APP_URL
   ```

   This takes a few minutes: it checks out the last commit in a temporary
   folder, installs exactly what the lockfile says (`npm ci`), builds, and
   assembles `publish\cbt-uat-<date>-<commit>\` plus a `.zip` of it. It
   refuses to finish if the package would carry a `.env` file (secrets) or a
   Windows link (the package would not move to another machine).
   `VERSION.txt` inside says which commit it is and which address it is for.
4. **Copy the zip to the server.** Build on Windows x64, the same as the
   server: the password-hashing module is a native binary built for it.

---

## Part B: Deploy (the IIS server)

### B1. Install once

- **Node.js 24 LTS** (x64). Check: `node -v`.
- **IIS** (the Web Server role), with these two Microsoft modules:
  - **URL Rewrite 2.1**
  - **Application Request Routing (ARR) 3.0**
- **An HTTPS certificate** for the UAT address (from your internal CA or a
  public one), imported into the machine's certificate store.
- **PostgreSQL client tools 18**, only if a database dump is to be restored
  here (`pg_restore`).

Then, as Administrator, from the unzipped package:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\iis\configure-iis.ps1
```

This sets the server-wide ARR options the app needs:
- the proxy on, keeping the browser's Host header;
- a 3-minute timeout (airline booking calls can take 90 seconds);
- no response buffering;
- the client's IP in `X-Forwarded-For` without its port (the app throttles
  sign-in attempts per IP);
- the forwarded headers `web.config` sets.

### B2. The database (first time)

The app needs PostgreSQL 15 or later that the server can reach. Two ways in:

**From a dump** (`cbt-database-YYYY-MM-DD.dump`, PostgreSQL custom format):

```powershell
psql -U postgres -c "create role cbt_app nologin"
psql -U postgres -c "create database cbt"
pg_restore -U postgres -d cbt --no-owner --exit-on-error cbt-database-YYYY-MM-DD.dump
```

`cbt_app` is created first so the dump's grants restore. Sign-in sessions,
pending invite and reset links, and sign-in attempts are not in a dump:
everyone signs in once. Passwords carry over.

**An empty database instead:** with `MIGRATE_DATABASE_URL` set (B4) and a
database that does not exist yet, `node scripts\create-database.mjs` builds it
from `schema\baseline.sql` (the schema plus countries, airports and
airlines). No clients, people or bookings: those come only from a dump.

### B3. Put the files in place

Unzip the package to a folder of its own, for example `C:\apps\cbt\`. Do not
unzip it inside the IIS site's folder. The site needs only `web.config`
(next step); the app's files stay where only the service account reads them.

### B4. Configuration: `.env.local`

Create `.env.local` in the app folder, beside `server.js`. It holds the
secrets. Never email it or commit it.

| Variable | What |
|---|---|
| `MIGRATE_DATABASE_URL` | the database owner, `postgresql://owner:password@host:5432/cbt`: for migrations and setup only |
| `DATABASE_URL` | what the app connects as. Written by `node scripts\create-app-login.mjs` (B5): leave it out at first |
| `DATABASE_CA_CERT` | the database's CA certificate (PEM text on one line, `\n` for line breaks) when the database is on another machine, so it is verified. A database with no TLS: end both URLs with `?sslmode=disable` instead |
| `NEXT_PUBLIC_APP_URL` | the same HTTPS address the package was built for, e.g. `https://cbt-uat.example.com` |
| `PROVIDER_CREDENTIALS_KEY` | 32 random bytes in base64: encrypts the flight provider's password, which is kept in the database. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Keep it safe with the server: without it the saved password cannot be read and must be entered again |
| `INTERNAL_API_SECRET` | a long random string; protects `/api/internal/*` |
| `MAIL_TRANSPORT`, `SMTP_URL`, `MAIL_FROM` | email: `smtp` with `SMTP_URL=smtp://user:pass@host:587` and `MAIL_FROM`; or `log` until SMTP exists (invite and reset links are then written to the server log) |
| `TRUSTED_PROXY_HOPS` | how many proxies stand in front of the app; default 1 (IIS). Set 2 only if another proxy or load balancer adds its own entry in front of IIS |
| `ESCALATION_SWEEP_MINUTES` / `ESCALATION_SWEEP=off` | approval escalation runs inside the server every 5 minutes; change or switch off |

Special characters in a password inside a URL (`? # / @ : %` and spaces)
must be percent-encoded: `?` is `%3F`, `@` is `%40`.

**The flight API account (Amadeus) is not in this file.** A platform admin
enters its base URL, client code, user name and password in the platform
console (`/platform`, "Flight provider"), with "Test the connection" before
saving. The password is stored encrypted with `PROVIDER_CREDENTIALS_KEY` and is
never shown again. Until it is saved there, the app still reads the old
`AMADEUS_API_BASE_URL`, `AMADEUS_CLIENT_CODE`, `AMADEUS_USERNAME` and
`AMADEUS_PASSWORD` lines if present (and logs a warning); delete them once the
console shows "Saved in the database".

### B5. Database migrations and the app's own login

From the app folder:

```powershell
node scripts\migrate.mjs            # applies every migration newer than the database
node scripts\create-app-login.mjs   # once per database: the app's restricted login, written into DATABASE_URL
```

`create-app-login.mjs` sets a new password each time it runs. With more than
one app server on one database, run it on one and copy the resulting
`DATABASE_URL` to the others.

Every release: run `node scripts\migrate.mjs` again **before** starting the
new version. It applies only what is new and refuses an edited migration.

### B6. Start the app and keep it running

As Administrator, from the app folder:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\register-task.ps1
```

This registers a scheduled task, **CBT**, that:
- starts the app at boot, before anyone signs in;
- restarts it within a minute if it ever stops;
- runs as NETWORK SERVICE, which may read the app folder, write only
  `logs\`, and read `.env.local` (no other user can).

The app listens on `http://127.0.0.1:3000` only, so IIS is the one way in.
Its log is `logs\server.log`.

Check it is up, on the server itself:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/health
```

### B7. The IIS site

1. In IIS Manager, add a website, for example **CBT-UAT**:
   - **Physical path:** an empty folder such as `C:\inetpub\cbt-uat\`
     (not the app folder).
   - **Binding:** `https`, port 443, the UAT host name, and the certificate
     from B1. Add an `http` port 80 binding too: `web.config` redirects it to
     HTTPS.
2. Copy `deploy\iis\web.config` from the package into that folder.
3. Set the site's application pool to **No Managed Code**. IIS only forwards
   here; it runs no .NET.

`web.config` sends every request to the app, keeping encoded characters in
addresses intact (flight keys carry them), lets the app's own error
responses through, and redirects plain HTTP to HTTPS.

### B8. Check it end to end

From a browser on the network:

1. `https://<uat-address>/api/health` answers `ok`.
2. `https://<uat-address>/login` shows the sign-in page, on HTTPS with no
   certificate warning.
3. Sign in. Sign-in works only on HTTPS: the browser seals the password before
   sending it, and browsers allow that only on secure pages. A certificate
   warning or plain `http://` means sign-in will say it needs a secure
   connection.
4. Run a search, price a fare and open a booking.

Once, after the first start with a dump that includes the demo TMC:
`node scripts\demo-tmc.mjs names` gives its seeded people letters-only names
(airlines refuse numbers in names). `node scripts\demo-tmc.mjs remove`
deletes the whole demo TMC when it is no longer wanted.

---

## Releasing a new version

1. Publish a new package (Part A).
2. On the server, unzip it to a **new** folder beside the old one, for example
   `C:\apps\cbt-2026-11-25\`, and copy `.env.local` across.
3. `node scripts\migrate.mjs` from the new folder.
4. Point the task at the new folder: run `deploy\windows\register-task.ps1`
   from it (it replaces the task and starts it).
5. Check `/api/health`. To roll back, run the old folder's
   `register-task.ps1`. Migrations only add, so the previous version still
   runs on the newer database.

## Good to know

- **Nothing else to schedule.** Approval escalation runs inside the server
  (every 5 minutes, and 30 seconds after start). Several app servers on one
  database are safe; each approval is claimed once.
- **Security headers.** Every response carries framing, sniffing, referrer and
  permissions rules, and `Strict-Transport-Security` for this host. A browser
  that has seen it refuses plain HTTP to the host for a year, so the site must
  be on HTTPS before its first visit.
- **Sessions.** Signed out after 10 minutes without activity (with a warning a
  minute before), and after 14 days whatever happens.
- **Logs** never carry passwords or passengers' personal details (airline
  requests and failures are redacted). `logs\server.log` grows; archive it from
  time to time.
