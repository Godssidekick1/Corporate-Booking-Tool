# Future changes

A running list of agreed work that is not done yet. Newest decisions are
recorded with the item; remove an item once it ships.

## Next up: hardening and scale (agreed 2026-10-08)

SQL injection is not the risk: every query is parameterised through the `sql`
tagged template (no raw-SQL escape hatch; ESLint keeps the driver inside
repositories). The real gaps, in order:

1. **Measure first.** A script that seeds a large synthetic TMC (about 10k
   clients, 5k deal codes, 50k assignments) and times the heavy endpoints.
2. **Booking-time resolution loads the whole TMC.** `stampBooking`,
   `stampFop`, `stampCommercials` read every assignment of the TMC on each
   price / add-passenger, then filter to one client. Fetch only what reaches
   the client (its id, its group, its buckets) in SQL.
3. **Coverage and lists are computed in memory.** Deal-code and commercial
   coverage, the FOP list and two more endpoints use `paginateInMemory` over
   every client x every assignment. Page clients in SQL, resolve only the page.
4. **Indexes.** Assignment tables have no index leading on `bucket_id`
   (`(rule_id, bucket_id)` etc.); confirm every hot query with EXPLAIN.
5. **Tenant isolation lives only in app code.** The app connects as the table
   owner; RLS is on with no policies. Add a least-privilege app role and real
   policies on `app.current_tenant_id` (already set by `transaction()`), with
   tests that fail when a query forgets the tenant.
6. **DB TLS** verifies nothing (`rejectUnauthorized: false` in `pool.ts`);
   verify the certificate wherever the connection crosses a network.
7. **Rate limits** exist for sign-in only; add them to search / list APIs.

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
