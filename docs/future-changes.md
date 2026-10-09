# Future changes

A running list of agreed work that is not done yet. Newest decisions are
recorded with the item; remove an item once it ships.

## Hardening and scale: what is left (pass of 2026-10-08)

Done in that pass: `npm run scale` harness and results (docs/scale-results.md);
booking-time lookups fetch only what reaches the client; coverage reports
indexed (21 s -> 0.9 s at 10k clients); reach indexes; restricted `cbt_app`
role, with the test suite running as it (docs/database-roles.md); automated
cross-tenant leak sweep over every route (tests/security); rate limits on
search, coverage, CSV and the public ticket link; verified database TLS when
`DATABASE_CA_CERT` is set.

- **Switch each environment to the restricted login** and set
  `DATABASE_CA_CERT` (steps in docs/database-roles.md). Until then the code is
  ready but the app still connects as the owner.
- **Real row-level security policies** (tenant predicates replacing the
  allow-all `app_access` policies), with every request run in a tenant-scoped
  transaction. Planned with the hosting move; the leak sweep guards the gap.
- **Coverage rebuild grows with the TMC.** Reads are SQL (16-30 ms at 10k
  clients), but the first read after a change rebuilds the whole TMC's report
  (2.4 s at 10k; the scale budget is 5 s). Past ~20k clients, rebuild only the
  clients a change reaches.
- **Set the login's timeouts** (`statement_timeout`, idle-in-transaction) when
  creating `cbt_app_login` (docs/database-roles.md).
- **Leak sweep covers GET and DELETE only.** POST / PATCH cross-tenant writes
  are covered by the per-route tests, not swept.

## Employee dashboard (redesign)

- **The "Finish setting up TravelDesk" checklist stays after every step is
  done.** It should disappear once complete (it is shown while the client's
  `setup_completed` is false, which nothing sets when the four steps are
  ticked).
- **The dashboard as a whole should be redesigned** -- the current layout is
  not liked. Gather what each role needs first (traveller, approver, finance,
  corporate admin).
- Small copy issue for the same pass: the empty "Recent bookings" text says
  "your manager will be notified" even to someone with no manager.

## Product mandates (design before building)

- **TMC-side booking.** Travel counsellors and TMC admins book for travellers,
  chiefly at CBT-only clients (whose people cannot self-book). Proposed: show
  the traveller's policy verdict as guidance with a reason code for amber/red,
  approvals per client (off by default for CBT), and record both the
  traveller and who booked.
- **Corporate admins book for colleagues** (e.g. the MD), with their booking
  history. The traveller's policy and approval chain apply, not the booker's.
  Later: named "travel arrangers" (an EA) who are not admins.
- **Finance approvals for red verdicts** -- possible future approval step.

## Before real users

- Production email (SMTP: `SMTP_URL`, `MAIL_FROM`). Until then Vercel needs
  `MAIL_TRANSPORT=log` or invites and resets fail there.
- Independent security review of the sign-in and session layer (agreed gate).
- Move database hosting off Supabase (deferred by the mentor).

## Operational (one-off)

- Run `npm run migrate` (places, no-manager, airports) and then
  `node scripts/load-cities.mjs` on the hosted database. Local is up to date.
- Remove leftover Supabase environment variables on Vercel; rotate the
  database password.

## PS-II

- End-sem report: add a "Business logic and configurability" chapter
  (configuration model, policy engine, approval engine, pricing and payment).
