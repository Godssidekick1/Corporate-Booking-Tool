-- ── What the airline said about a priced fare, held with the quote ────────────
-- Problem: add-passenger judged "refundable fare required" by what the BROWSER
-- said about the fare (isRefundable in the request body), and had no way to
-- judge a cancellation penalty at all: the airline's answer to pricing was
-- shown to the traveller and then forgotten.
--
-- Change: price_quotes.fare_conditions, written by /api/book/price from the
-- airline's own pricing response: { refundable: boolean, cancelPenalties:
-- [{ paxType, text }] }. add-passenger judges from it. Null on quotes priced
-- before this, which expire within the quote hold anyway.
--
-- Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.price_quotes add column if not exists fare_conditions jsonb;
