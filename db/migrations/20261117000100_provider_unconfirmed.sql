-- ── A booking or ticket the airline may or may not have done ─────────────────
-- Problem: airline calls had no time limit; they have one now. When Booking
-- or Ticket gets no answer in time, the airline may still have done it, so
-- the booking is neither failed nor held. Asking again blindly risks a second
-- PNR or a second ticket.
--
-- Change: bookings.provider_unconfirmed (which step went unanswered:
-- 'booking' or 'ticket') and when. While it is set, the next attempt first
-- asks the airline what happened (GetBookingDetails) and records that,
-- instead of booking or ticketing again. Null for every booking until then.
-- Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.bookings add column if not exists provider_unconfirmed text;
alter table public.bookings add column if not exists provider_unconfirmed_at timestamptz;

alter table public.bookings drop constraint if exists bookings_provider_unconfirmed_check;
alter table public.bookings add constraint bookings_provider_unconfirmed_check
  check (provider_unconfirmed is null or provider_unconfirmed in ('booking', 'ticket'));
