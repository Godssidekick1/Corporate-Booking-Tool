# Future changes

A running list of agreed work that is not done yet. Newest decisions are
recorded with the item; remove an item once it ships.

The path to production (cancellation, refunds, what we need from others,
the testing phase) is in `go-live-checklist.md`.

## Hardening and scale: what is left (passes of 2026-10-08 and 2026-11-02)

Done in the first pass: `npm run scale` harness and results (docs/scale-results.md);
booking-time lookups fetch only what reaches the client; coverage reports
indexed (21 s -> 0.9 s at 10k clients); reach indexes; restricted `cbt_app`
role, with the test suite running as it (docs/database-roles.md); automated
cross-tenant leak sweep over every route (tests/security); rate limits on
search, coverage, CSV and the public ticket link; verified database TLS when
`DATABASE_CA_CERT` is set. Then (2026-11-02): dependencies with known
advisories updated (next 16.4.3, nodemailer, sharp); security headers on
every response; the sign-in tables answer to the system scope only; every
foreign key indexed (and a test that keeps it so); escalation runs on the
server's own timer, nothing to schedule.

- **A script policy (CSP) with nonces.** The headers set now (next.config.ts)
  forbid framing, plugins and foreign form posts; restricting scripts needs
  a per-request nonce, so every page rendered dynamically. Next.js documents
  it (content-security-policy guide).
- **Switch each environment to the restricted login** and set
  `DATABASE_CA_CERT` (steps in docs/database-roles.md). Until then the code is
  ready but the app still connects as the owner.
- **Coverage rebuild grows with the TMC.** Reads are SQL (16-30 ms at 10k
  clients), but the first read after a change rebuilds the whole TMC's report
  (2.4 s at 10k; the scale budget is 5 s). Past ~20k clients, rebuild only the
  clients a change reaches.
- **TMC dashboard stats ~0.5 s at 10k clients as the app login** (budget
  300 ms; 130 ms on the same data measured alone). The query filters
  `tmc_id = $1` and the policy adds `tmc_id = app_tmc()`; the planner treats
  them as independent and expects 101 clients for 10,009. A maintained
  per-client counts table (like coverage) would make it constant.

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
- **A guest booking is judged by the booker's policy** (decided 2026-10-22:
  kept). "A guest" (not an employee) is recorded against whoever books it.
- **Finance approvals for red verdicts** are possible already: a chain step
  approved by finance, set to "Out of policy only".

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

- **Booking emails per event** (needs production SMTP), including an
  escalation and a fare sent back for re-approval.
- **A guest is what the booker says.** for_guest is the booker's own choice;
  the server cannot tell a guest's name from an employee's. Good enough while
  it is a company preference rather than a control anyone gains by evading.
- **Personal trips are paid by the traveller's card** when the resolver can
  pick one, and only the traveller's own (tested with a created card); no
  demo or template client has a traveller-paid form of payment yet.

## Reports (built 2026-10-22; what is left)

Built: six company reports (/reports: spend, policy compliance, savings,
approvals, trips and budgets, travel patterns; admins and finance, sell side
only) and six TMC reports (/tmc/reports: revenue, client activity, airlines
and deals, desk productivity, compliance across clients, payments; a
counsellor sees their portfolio). Every figure is counted from bookings
already made; each table downloads as CSV (app/lib/reports,
app/lib/repositories/reports.ts).

- **Hotel and car spend** join the reports when hotels and cars are booked.
- **Scheduled reports by email** (a monthly spend summary to finance), once
  production email exists.
- **Savings counts only what the policy recorded.** Lowest-fare misses exist
  where a group sets a lowest-fare window, from 2026-10-20 on; earlier
  bookings show none.
- **Airline names come from the provider,** which calls Air India Express
  (IX) "Air India"; reports show the code beside the name. A maintained
  airline name list would fix it everywhere.

## Before real users

- Production email (SMTP: `SMTP_URL`, `MAIL_FROM`). Until then Vercel needs
  `MAIL_TRANSPORT=log` or invites and resets fail there.
- Independent security review of the sign-in and session layer (agreed gate).

## Operational (one-off)

- Escalation on Vercel (the test site): no long-lived process there, and the
  free plan's cron runs once a day. Escalation does not run on Vercel.
- On the new PostgreSQL server: `npm run migrate`, then `npm run db:app-login`
  so the app connects as the restricted login (docs/database-roles.md).
- `node scripts/load-cities.mjs` on any database whose city list is empty.

## PS-II

- End-sem report: add a "Business logic and configurability" chapter
  (configuration model, policy engine, approval engine, pricing and payment).
