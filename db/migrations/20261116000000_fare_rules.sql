-- The airline's fare rules (flight/Non-LccFareRule), parsed: per sector, the
-- cancellation and change charges by time window before departure, no-show,
-- and the airline's own notes (app/lib/book/fareRules.ts).
--
-- Fetched when a fare is priced and held on the quote; copied onto the booking
-- when its passengers are added, so the traveller sees them on their booking
-- and the TMC prices a refund's airline penalty from them. Null when the
-- airline gave none (the fare page then says so) and for older bookings,
-- which the TMC may fetch again by PNR.

alter table public.price_quotes add column if not exists fare_rules jsonb;
alter table public.bookings add column if not exists fare_rules jsonb;
