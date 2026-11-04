# Go-live checklist (production, for SMEs)

The COO saw the demo on 2026-11-04 and wants the CBT in production and on
the market for SMEs. This is the path there: what we build, what we need
from others, how we test, and what launch means. Tick items off as they
land. Longer-term ideas stay in `future-changes.md`.

## 1. Build: the rest of the flight workflow

Waiting on the **updated provider API documentation** (see section 2).
Already in `app/lib/amadeus/client.ts` but used by no screen yet:
GetBookingDetails, CancelBooking, FareRule.

### Cancellation
- [ ] Cancel before ticketing: release the PNR (CancelBooking), and the
      booking becomes cancelled
- [ ] Cancel after ticketing: through void or refund (below), never just
      dropping the PNR
- [ ] Who may cancel: the traveller (own bookings), the person who booked
      it, the TMC desk, the corporate admin. Decide whether a cancellation
      needs approval
- [ ] Penalty shown before confirming, from the fare rules
- [ ] "Cancel" on My trips, on the booking page and for the desk; the
      traveller is told
- [ ] Audit entry for every cancellation (who, when, why)
- [ ] Tests: each role allowed and refused; airline failure; airline
      success but our save fails (the cancellation must not be lost)

### Refunds
- [ ] Refund API (from the documentation): what the airline refunds and
      how it is reported
- [ ] Refund amount: the airline's refund minus the penalty; decide whether
      the TMC charges a cancellation fee (a commercial rule?)
- [ ] Recorded on the booking: refund status, amount, date, reference
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
| Updated API documentation: cancel, refund, void (and reissue, if offered), with sample requests and responses | Mentor / provider | asked |
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
