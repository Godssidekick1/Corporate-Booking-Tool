-- A domestic round trip booked as two one-way fares: two bookings, linked.
--
-- pair_id is the id of the pair's FIRST booking (the onward), on both rows. The
-- first carries it from the moment it is created (it waits, unsent for
-- approval, for its return); the return is linked to it when its passengers
-- are added. One approval is raised for the pair, on the first booking, and a
-- decision applies to both. Each booking is otherwise its own: priced, booked,
-- ticketed and cancelled on its own.
--
-- A special return fare (the airline's paired fare) is ONE booking, as any
-- combined round trip: no pair_id.

alter table public.bookings
  add column if not exists pair_id uuid references public.bookings (id) on delete set null;

create index if not exists bookings_pair_id_fk_idx on public.bookings (pair_id);
