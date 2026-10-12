-- ── Booking on someone's behalf ──────────────────────────────────────────────
-- Problem: a booking recorded one person, and every reader takes
-- bookings.employee_id to be the TRAVELLER (their trips, approvals, policy,
-- stats, the growth indexes, row-level security). Nothing could say who MADE
-- it, so the travel desk and corporate admins had no way to book for someone
-- (docs/future-changes.md, "Product mandates").
--
-- Change:
--   bookings.booked_by     who made it. Defaults to the traveller, so every
--                          existing insert path keeps meaning "booked for
--                          myself". On someone's behalf exactly when
--                          booked_by <> employee_id.
--   bookings.confirmed_by  who pressed Book once it was approved (the booker
--                          or the traveller may).
--   bookings.policy_reason_code / _note
--                          why the desk went ahead with an amber or red fare
--                          at a CBT client, where policy is guidance and no
--                          approval chain runs.
--   price_quotes.priced_by who priced it: only they may turn it into a
--                          booking.
--
-- Removed: bookings.requested_for, its index and the booking_traveller view.
-- requested_for was the schema's first idea of "the traveller", written equal
-- to employee_id everywhere and read by nothing; keeping it beside employee_id
-- would leave two columns that disagree about who travels.
--
-- Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.bookings
  add column if not exists booked_by uuid references public.employees (id) on delete restrict,
  add column if not exists confirmed_by uuid references public.employees (id) on delete restrict,
  add column if not exists policy_reason_code text,
  add column if not exists policy_reason_note text;

update public.bookings set booked_by = employee_id where booked_by is null;

create or replace function public.default_booked_by() returns trigger
language plpgsql as $$
begin
  new.booked_by := coalesce(new.booked_by, new.employee_id);
  return new;
end $$;
drop trigger if exists bookings_default_booked_by on public.bookings;
create trigger bookings_default_booked_by before insert on public.bookings
  for each row execute function public.default_booked_by();

alter table public.bookings alter column booked_by set not null;

alter table public.bookings drop constraint if exists bookings_policy_reason_code_check;
alter table public.bookings add constraint bookings_policy_reason_code_check check (
  policy_reason_code is null or policy_reason_code = any (array[
    'client_instruction', 'no_compliant_option', 'schedule_need', 'lower_total_cost', 'other'])
);
alter table public.bookings drop constraint if exists bookings_policy_reason_note_check;
alter table public.bookings add constraint bookings_policy_reason_note_check check (
  policy_reason_code is distinct from 'other' or length(trim(coalesce(policy_reason_note, ''))) > 0
);

-- "Booked by me": the desk's and an admin's own history, newest first.
create index if not exists bookings_booked_by_recent_idx
  on public.bookings (booked_by, created_at desc);

drop view if exists public.booking_traveller;
drop index if exists public.idx_bookings_req_for;
alter table public.bookings drop column if exists requested_for;

alter table public.price_quotes
  add column if not exists priced_by uuid references public.employees (id) on delete cascade;
update public.price_quotes set priced_by = employee_id where priced_by is null;

create or replace function public.default_priced_by() returns trigger
language plpgsql as $$
begin
  new.priced_by := coalesce(new.priced_by, new.employee_id);
  return new;
end $$;
drop trigger if exists price_quotes_default_priced_by on public.price_quotes;
-- Insert only: a re-price is an upsert that sets priced_by itself
-- (bookings.holdQuote); on update this would keep the previous pricer.
create trigger price_quotes_default_priced_by before insert on public.price_quotes
  for each row execute function public.default_priced_by();

alter table public.price_quotes alter column priced_by set not null;
