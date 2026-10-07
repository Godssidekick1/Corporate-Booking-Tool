# Future changes

A running list of agreed work that is not done yet. Newest decisions are
recorded with the item; remove an item once it ships.

## Next up (fixes)

- **Full airports dataset.** Booking search cannot find many airports, and
  domestic vs international (policy) is decided from the same short list.
  Candidate: OurAirports (public domain), airports with IATA codes.

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

- Run `npm run migrate` and `node scripts/load-cities.mjs` on the hosted
  database; run `npm run migrate` locally to record the two migrations that
  were applied by hand.
- Remove leftover Supabase environment variables on Vercel; rotate the
  database password.

## PS-II

- End-sem report: add a "Business logic and configurability" chapter
  (configuration model, policy engine, approval engine, pricing and payment).
