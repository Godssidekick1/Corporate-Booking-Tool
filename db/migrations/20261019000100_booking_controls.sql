-- ── Corporate settings: how a company books ──────────────────────────────────
-- Problem: a company could not say "no guest bookings", "always ask why a fare
-- is outside policy", "never book a red fare" or "stop the same trip being
-- booked twice". And "personal bookings allowed" was stored but did nothing:
-- no booking could say it was personal.
--
-- Change, on clients (the same for everyone at the company):
--   * guest_bookings_allowed: whether a booking may be for a guest (someone
--     who is not an employee). On by default: today everyone may.
--   * out_of_policy_reason_required: an amber or red fare needs a reason from
--     whoever books it. The travel desk at a CBT-only client always gave one;
--     this asks everyone else too. Off by default.
--   * out_of_policy_handling: 'approve' (today: the approval chain decides) or
--     'block_red' (a red fare cannot be booked at all).
--   * duplicate_booking_check: 'off' (today), 'warn' (asked to confirm) or
--     'block', when the traveller already holds a live booking on the same
--     route and day.
--
-- And on bookings, what each one was for:
--   * purpose: 'business' (every booking so far) or 'personal'. A personal
--     trip is the traveller's own: not checked against company policy, no
--     approval chain, and only the traveller's own card pays.
--   * for_guest: booked for a guest.
--
-- Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.clients add column if not exists guest_bookings_allowed boolean not null default true;
alter table public.clients add column if not exists out_of_policy_reason_required boolean not null default false;
alter table public.clients add column if not exists out_of_policy_handling text not null default 'approve';
alter table public.clients add column if not exists duplicate_booking_check text not null default 'off';

alter table public.clients drop constraint if exists clients_out_of_policy_handling_check;
alter table public.clients add constraint clients_out_of_policy_handling_check
  check (out_of_policy_handling in ('approve', 'block_red'));

alter table public.clients drop constraint if exists clients_duplicate_booking_check_check;
alter table public.clients add constraint clients_duplicate_booking_check_check
  check (duplicate_booking_check in ('off', 'warn', 'block'));

alter table public.bookings add column if not exists purpose text not null default 'business';
alter table public.bookings add column if not exists for_guest boolean not null default false;

alter table public.bookings drop constraint if exists bookings_purpose_check;
alter table public.bookings add constraint bookings_purpose_check
  check (purpose in ('business', 'personal'));
