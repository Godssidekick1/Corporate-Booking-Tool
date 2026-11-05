# Go-live checklist (production, for SMEs)

The COO saw the demo on 2026-11-04 and wants the CBT in production and on
the market for SMEs. This is the path there: what we build, what we need
from others, how we test, and what launch means. Tick items off as they
land. Longer-term ideas stay in `future-changes.md`.

## 1. Build: the rest of the flight workflow

Already in `app/lib/amadeus/client.ts` but used by no screen yet:
GetBookingDetails, FareRule.

### Cancellation (built 2026-11-05: `POST /api/book/[bookingId]/cancel`)
- [x] Before the airline has it (pending approval, approved): withdrawn
      here, open approval steps close as "withdrawn"; no provider call
- [x] Held or ticketed: CancelBooking with the booking's ReferenceNo, as
      documented; the answer is recorded on the booking
- [x] Who may cancel: anyone who may act on the booking (traveller,
      booker, desk, corporate admin at a self-booking client). No approval
      (decided 2026-11-05)
- [x] One booking is cancelled once: a double click gets "already in
      progress", never a second provider call
- [x] Audit entry for every cancellation (who, why, from which status)
- [x] "Cancel booking" on the confirm and ticket pages; a cancelled booking
      says when, by whom, why and the charges
- [x] Tests: each case above, each role refused, the provider refusing, and
      the provider cancelling while our save fails (still reported)
- [ ] **Confirm with the provider** (the documentation only shows a held
      booking cancelled at once):
  - [ ] the exact path (we call `Flight/CancelBooking`)
  - [x] a sample answer for a TICKETED booking: tried on the test system
        2026-11-05 (PNR 8PP6M3): "cancelled" at once, no change request,
        refund 0 and charges 0. Still to ask: does production report the
        real refund and charges here, or only later?
  - [ ] every value of `cancelStatus` and `changeRequestStatus`
  - [ ] when the refund settles later: how we learn it (GetBookingDetails?)
  - [ ] cancelling one passenger of several (`ticketIndex`)?
- [ ] Penalty shown before confirming the cancellation, from the fare rules
- [ ] "Cancel" from My trips lists and the desk's booking table (today: on
      the booking's own page)
- [ ] Traveller told by email (needs production email)

### Refunds
The provider's cancel answer already carries the money: `refundedAmount`,
`cancellationCharge`, `serviceTaxOnRAF`. Stored on the booking; a traveller
and the corporate client see the charges and "refund being processed", the
desk sees everything (decided 2026-11-05).
- [ ] A separate refund API? Only if the provider settles ticketed refunds
      apart from the cancel call (see the questions above)
- [ ] **Business decision:** how much goes back to the company. The
      airline's refund only (the TMC keeps its markup and fee), or the sell
      price minus the airline's charges (the TMC returns its markup)? And
      does the TMC charge its own cancellation fee (a commercial rule)?
- [x] Recorded on the booking: provider status, refund, charges, references
- [ ] Money back to the payer (corporate card, agency, traveller's card):
      depends on how payment works (section 2, payment gateway)
- [ ] Reports: refunds and penalties in spend and in TMC revenue/margin
- [ ] Tests: full, partial and no refund; the airline refuses; repeating a
      request does not refund twice

### Smaller pieces
- [ ] Void (cancel a ticket the same day, usually free): if the provider
      offers it
- [ ] Fare rules (refundable? change fee?) shown at price time, before
      booking
- [ ] Booking status kept in step with the airline (GetBookingDetails):
      schedule changes, cancellations made outside the app

## 2. What we need from others

| Need | From | Status |
|---|---|---|
| Updated API documentation: cancel, refund, void (and reissue, if offered), with sample requests and responses | Mentor / provider | cancel received (held booking only); questions in section 1 |
| **Production API credentials** and the provider's go-live approval (any certification tests they require) | Provider | |
| **Production email (SMTP)**: server, account, sender address, and SPF/DKIM on the sending domain | Amadeus IT | |
| Firewall: TCP 5432 from our network to the database server | Mentor | waiting |
| Production server for the app, a **domain name** and its **TLS certificate** (HTTPS) | Amadeus IT | |
| Backups: where they are stored, how long they are kept | Amadeus IT | |
| **Payment gateway** account, if SMEs pay by card (we never store card numbers) | Business / COO | |
| Privacy policy, terms of use, and a data-protection check (India's DPDP Act 2023: we store passport details) | Legal | |
| Who does the security review / penetration test | Mentor / COO | |
| Decision: do SMEs sign up by themselves, or does the TMC onboard each one? | COO | |
| Change the database `postgres` password (it was exposed once in a log) | Mentor | |

## 3. Testing phase

- [ ] Security review of sign-in, sessions and tenant separation, against
      the OWASP Top 10
- [ ] Penetration test on the deployed site
- [ ] Load test at SME volumes (many small clients, peak booking hours)
- [ ] The provider's certification tests, if they require them for
      production access
- [ ] Backup restore drill: restore last night's backup to a spare
      database and sign in to it
- [ ] User acceptance: one or two friendly SMEs book, approve and cancel
      for real

## 4. Launch

- [ ] App on the production server: HTTPS, runs as a Windows service,
      restarts on reboot (`deploy-windows.md`)
- [ ] `NEXT_PUBLIC_APP_URL` set to the real domain; `MAIL_TRANSPORT=smtp`
- [ ] Monitoring: `/api/health` checked every minute, with an alert when
      it fails
- [ ] Nightly backups running, and their success checked
- [ ] Support: who answers users, and how a provider error reference
      reaches the desk
- [ ] Production credentials only on the server, never in a zip or a chat
