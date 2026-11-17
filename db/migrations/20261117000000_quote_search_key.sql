-- ── The search a quote was priced from ───────────────────────────────────────
-- Problem: the airline's fare rules were fetched inside the price request,
-- which made the fare page wait for them; on the test system they take 7-12 s
-- and mostly missed the 8 s limit. They now have a request of their own
-- (/api/book/fare-rules), asked after the price is shown. That request reads
-- the fare's keys from the saved quote, never from the browser (the rules feed
-- the refund panel's penalty), and the airline's fare-rule call needs the
-- SEARCH's key, which the quote did not keep.
--
-- Change: price_quotes.search_key. Null on quotes priced before this; those
-- simply have no rules to fetch. Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.price_quotes add column if not exists search_key text;
