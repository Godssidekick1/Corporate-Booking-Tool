-- ============================================================================
-- Airlines: a reference list built from what we actually fly
--
-- Deal codes and forms of payment both file against a two-character airline
-- code, typed free-hand into an <input maxLength={2}>. The only validation
-- anywhere is /^[A-Z0-9]{2}$/, so "ZZ" and "99" save cleanly.
--
-- These are commercial instruments. A deal code filed against 6F when 6E was
-- meant does not fail loudly - the negotiated fare simply never applies, on
-- every booking, silently. Same for a form of payment scoped to the wrong
-- carrier. There has been no list to pick from, because none existed in the
-- codebase at all.
--
-- WHY THIS IS HARVESTED, NOT IMPORTED
-- Every Amadeus search response already carries AirlineInfo { Code, Name } for
-- each leg. That is data received under the existing commercial agreement, so
-- filling this table from live responses sidesteps the licensing question that
-- a bulk third-party dataset raises entirely (OpenFlights is ODbL, with
-- share-alike on the database itself).
--
-- It also produces a BETTER list. A bulk import is ~6,000 rows, most of them
-- defunct carriers nobody here will ever trade against. This ends up holding
-- exactly the airlines this TMC actually sells - which is the set a deal code
-- or a form of payment would ever name.
--
-- GLOBAL, NOT TENANT-SCOPED. An airline is a fact about the world, not about a
-- TMC, and two TMCs seeing the same carrier list is correct. There is nothing
-- commercially sensitive here: which airlines exist is public, and who has a
-- deal with whom lives in deal_codes, which is tenant-scoped.
--
-- NOT A WHITELIST. Nothing validates against this table, deliberately - see
-- app/lib/reference/airlineCode.ts. A carrier nobody has searched yet is absent
-- by definition, and gating deal codes on it would make the first booking with a
-- new airline a deadlock: it cannot be configured until it is flown, and it
-- cannot be flown until it is configured.
-- ============================================================================

begin;

create table if not exists airlines (
  -- The IATA designator, uppercase. Two characters in practice, but stored as
  -- text rather than char(2) so a three-character ICAO code or an unusual
  -- designator arriving from the aggregator is recorded rather than truncated.
  code          text primary key,
  name          text not null,
  -- first_seen_at never moves; last_seen_at does. Together they say "this
  -- carrier has been in our results since March and was there yesterday", which
  -- is what tells a stale row from a live one.
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

comment on table airlines is
  'Carriers seen in Amadeus search responses, harvested as searches run. A '
  'suggestion list for the deal code and form of payment editors - NOT a '
  'whitelist, since a carrier nobody has searched yet is legitimately absent.';

comment on column airlines.last_seen_at is
  'Updated every time this carrier appears in a search. A row whose last_seen_at '
  'is months old is a carrier no longer being sold, not a data error.';

-- Search hits both columns: people look up "6E" and "IndiGo" about equally.
-- Plain btree on lower(name) rather than pg_trgm: this table holds tens to low
-- hundreds of rows, where a sequential scan is faster than an index anyway, and
-- adding the extension for it would be cost with no benefit. Revisit only if
-- this ever grows by an order of magnitude.
create index if not exists airlines_name_idx on airlines (lower(name));

-- Deny-by-default, consistent with every other table here: routes reach this
-- through the service-role client after checking authn themselves.
alter table airlines enable row level security;

commit;
