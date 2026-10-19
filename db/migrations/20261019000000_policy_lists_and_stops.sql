-- ── Policy: list rules, max stops, and airlines to choose from ──────────────
-- Problem: a policy could hold numbers and yes/no values only, so "never show
-- these airlines", "prefer these" and "only these fare types" had nowhere to
-- live. Stops were a yes/no "connecting flights allowed", which cannot say
-- "one stop at most". And the airline picker read a list built from searches
-- only, so carriers nobody had searched yet could not be chosen.
--
-- Change:
--   * policy_rules.limit_list: a rule may hold a list of codes (airline codes,
--     fare types). Exactly one of limit_value / limit_bool / limit_list.
--   * connecting_flights_allowed becomes max_stops: "allowed" -> no stop limit
--     (3), "not allowed" -> non-stop only (0). Same meaning, in the new form.
--   * airlines: the Indian carriers and common international ones, so the
--     picker is never empty. Searches keep adding the rest as before. The
--     seeded rows carry a fixed date, not the moment the file ran, so every
--     database built from these files holds the same rows.
--
-- Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.policy_rules add column if not exists limit_list text[];

update public.policy_rules
   set limit_key = 'max_stops',
       limit_value = case when limit_bool then 3 else 0 end,
       limit_bool = null
 where limit_key = 'connecting_flights_allowed';

insert into public.airlines (code, name, first_seen_at, last_seen_at)
select code, name, timestamptz '2026-10-19 00:00:00+00', timestamptz '2026-10-19 00:00:00+00' from (values
  ('AI', 'Air India'), ('6E', 'IndiGo'), ('SG', 'SpiceJet'), ('QP', 'Akasa Air'),
  ('IX', 'Air India Express'), ('9I', 'Alliance Air'), ('S5', 'Star Air'), ('IC', 'Fly91'),
  ('EK', 'Emirates'), ('QR', 'Qatar Airways'), ('EY', 'Etihad Airways'), ('SQ', 'Singapore Airlines'),
  ('LH', 'Lufthansa'), ('BA', 'British Airways'), ('AF', 'Air France'), ('KL', 'KLM'),
  ('TK', 'Turkish Airlines'), ('CX', 'Cathay Pacific'), ('TG', 'Thai Airways'), ('MH', 'Malaysia Airlines'),
  ('UL', 'SriLankan Airlines'), ('WY', 'Oman Air'), ('GF', 'Gulf Air'), ('SV', 'Saudia'),
  ('FZ', 'flydubai'), ('G9', 'Air Arabia'), ('KU', 'Kuwait Airways'), ('ET', 'Ethiopian Airlines'),
  ('AC', 'Air Canada'), ('UA', 'United Airlines'), ('AA', 'American Airlines'), ('DL', 'Delta Air Lines'),
  ('VS', 'Virgin Atlantic'), ('NH', 'All Nippon Airways'), ('JL', 'Japan Airlines'), ('QF', 'Qantas'),
  ('AK', 'AirAsia'), ('TR', 'Scoot'), ('LX', 'Swiss'), ('OS', 'Austrian Airlines')
) as seed (code, name)
on conflict (code) do nothing;
