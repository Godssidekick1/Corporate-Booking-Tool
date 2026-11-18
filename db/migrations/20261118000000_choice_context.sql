-- ── What a fare was chosen from ──────────────────────────────────────────────
-- Problem: an approver sees the chosen fare but not what else was on offer,
-- and the search behind it (search_fares) is kept only two hours, far less
-- than an approval waits.
--
-- Change: bookings.choice_context, written once at add-passenger from that
-- search: the chosen fare (name, refundable, its search price), the cheapest
-- fare on the same flight, the cheapest flight on the same route that day,
-- and how many flights were shown. Sell-side figures only (the search's sell
-- estimates), never the airline's. Null when the search was not kept
-- (bookings made before this, or with no search behind them). Safe to apply
-- twice.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.bookings add column if not exists choice_context jsonb;
