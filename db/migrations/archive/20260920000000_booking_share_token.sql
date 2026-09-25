-- ============================================================================
-- A share token for the e-ticket
--
-- The ticket is the one page in this product certain to be opened on a phone,
-- at an airport, possibly by someone who is not the traveller — a colleague
-- collecting them, a visa desk, a manager checking a flight time. Today it
-- lives at /book/ticket/[bookingId], which proxy.ts protects, so a scanned QR
-- would land on a login wall.
--
-- WHY A TOKEN AND NOT THE BOOKING ID. The id is already in a URL the traveller
-- has, is referenced in logs and support conversations, and is the primary key
-- of the row. A separate secret means the public view can be revoked by
-- clearing one column without touching the booking, and knowing a booking id
-- never grants access to the ticket.
--
-- WHAT THE PUBLIC VIEW SHOWS is decided in the route, not here: the full
-- itinerary, fare and contact details — it is an itinerary receipt, and a
-- receipt without the money on it is useless for the thing receipts are for —
-- but the passport masked to its last four digits and no date of birth. Those
-- two are what turn a forwarded link into identity fraud, and neither is needed
-- at a gate.
-- ============================================================================

alter table bookings
  add column if not exists share_token text;

-- Partial, because only ticketed bookings get one and NULLs would otherwise
-- collide with each other in a plain unique index.
create unique index if not exists bookings_share_token_key
  on bookings (share_token)
  where share_token is not null;

comment on column bookings.share_token is
  'Unguessable secret for the public e-ticket at /t/[token]. Issued at ticketing. Clearing it revokes the link without altering the booking.';
