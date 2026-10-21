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
- **Sign-in tables are allow-all to the app role** (accounts, sessions,
  tokens). Reached only by `app/lib/auth`, but a policy limiting them to the
  system scope would remove the last tables a tenant request could read
  across tenants. Needs the account-creation paths (which run in a tenant's
  request) to write through the system scope.
- **Coverage rebuild grows with the TMC.** Reads are SQL (16-30 ms at 10k
  clients), but the first read after a change rebuilds the whole TMC's report
  (2.4 s at 10k; the scale budget is 5 s). Past ~20k clients, rebuild only the
  clients a change reaches.
- **38 foreign-key columns have no index** (created_by / updated_by /
  assigned_by / granted_by, approvals.approver_id, bookings.requested_for,
  trips.created_by, price_quotes.employee_id, the assignments' client_id...).
  Deleting a client or an employee checks each of them by scanning the whole
  table; removing the 2,000-client demo that way took 100 s. Index the ones a
  real delete path uses.
- **TMC dashboard stats ~0.5 s at 10k clients as the app login** (budget
  300 ms; 130 ms on the same data measured alone). The query filters
  `tmc_id = $1` and the policy adds `tmc_id = app_tmc()`; the planner treats
  them as independent and expects 101 clients for 10,009. A maintained
  per-client counts table (like coverage) would make it constant.
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

## Booking on someone's behalf (built 2026-10-13; what is left)

Built: the travel desk (TMC admins; counsellors with "Book for travellers")
and corporate admins book for others (app/lib/book/bookingActor.ts,
/tmc/book, "Who's travelling?" on the search page). bookings.employee_id is
the traveller, booked_by the booker. At a CBT-only client the desk books on
policy guidance with a reason code for amber/red and no approval chain;
everywhere else the traveller's own chain decides.

- **Tell the traveller by email** that someone booked for them, once
  production email exists. Today it shows in their trips and dashboard only.
- **Named travel arrangers** (an EA who is not an admin) -- a per-person
  "may book for" list instead of the admin role.
- **A guest booking is judged by the booker's policy.** "A guest" (not an
  employee) is recorded against whoever books it, as before. Decide whether
  guests need a policy of their own.
- **The desk sees the sell price only.** A counsellor could be shown the
  airline fare and the markup while booking; not built.
- **Finance approvals for red verdicts** -- possible future approval step.

## Trips and their sign-off (built 2026-10-16; what is left)

Built: a trip carries what it is for (travel type, billable, cost centre,
currency, budget, project as free text); one trip card, form and page on
every side (app/components/trips); the trip sign-off -- the whole trip,
approved once when every booking in it is booked, by the chain assigned for
"Trip sign-off", switched per client (clients.trip_approval_mode, off by
default). Air approval is unchanged: per booking, at booking time. The desk
plans and submits trips for travellers (/tmc/book, /tmc/trips/[id]).

- **Hotels and cabs inside the sign-off.** When hotels and cabs exist, the
  sign-off should show them and approve the ones not yet approved, then sign
  the trip off -- the approver sees the approved flights as today.
- **A managed project list** per company (picked, not typed) if free text
  proves too loose; trips.project would map onto it.
- **Tell the approver and the traveller by email** when a trip is submitted
  and decided, once production email exists. Today: the approvals queue and
  the trip page.
- **Trip-level reports** (spend against budget by cost centre, billable
  trips) now have the data.

## Policy and booking controls (built 2026-10-19; what is left)

Built: carrier tier, refundable fare, advance booking, max stops and max
journey time are checked; blocked airlines and fare types outside a group's
allowed list are not shown (search) and refused (price, add-passenger);
preferred airlines are marked. Corporate Settings: personal trips, guest
bookings, a reason for out-of-policy fares from everyone, blocking red fares,
the duplicate check; a priced fare is held 30 minutes. Personal trips and guest
bookings need both the company switch and the traveller's policy group
(personal No and guests Yes until a group says otherwise; no policy to check
means the company switch alone).

Then (2026-10-20), the three outcomes:
- **Within policy:** the company decides (Corporate Settings, "Within-policy
  bookings") whether it is approved automatically or sent.
- **Needs approval:** within a fare cap's grace, or a cheaper flight in the
  lowest-fare window. Always sent; never blocked.
- **Out of policy:** beyond grace, or a rule broken.

Also added then: grace per policy group (% or ₹), the approval amounts
removed, and anything sent for approval reaches at least the chain's first
step. Phase 2 too: max layover, max cancellation fee, lowest logical fare,
re-approval when a re-priced fare rises, escalation to the approver's
manager, Personal and Guest tags, and a ticket footer.

- **Schedule the escalation sweep.** `npm run escalate` (or POST
  /api/internal/escalate with `x-internal-secret`) every 15 minutes, from
  Windows Task Scheduler, cron or a Vercel cron job. Until something runs
  it, no approval escalates.
- **Booking emails per event** (needs production SMTP), including an
  escalation and a fare sent back for re-approval.
- **Lowest logical fare compares the outbound departure** of one-way and
  round trips alike. A round trip whose return is far less convenient can
  count as "cheaper nearby".
- **A fare re-priced at booking but still under the threshold** is booked
  at the airline's new price while the booking keeps the approved totals,
  as before this change. Recording the new price there too is a small
  follow-up.
- **Old approval rules** (auto_approve_under, finance_approval_over) stay in
  stored policy versions until a group is saved again. They are not read.
- **A guest is what the booker says.** for_guest is the booker's own choice;
  the server cannot tell a guest's name from an employee's. Good enough while
  it is a company preference rather than a control anyone gains by evading.
- **Personal trips are paid by the traveller's card** when the resolver can
  pick one; no demo or template client has a traveller-paid form of payment
  yet, so that branch is untested against real rows.

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
