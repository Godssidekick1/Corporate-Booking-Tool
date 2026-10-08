-- ── Rate limits for expensive endpoints ──────────────────────────────────────
-- Problem: only sign-in, reset and link checks were throttled (auth_attempts).
-- Flight search spends a paid Amadeus call per request, the coverage reports
-- are the heaviest reads in the app, CSV import/export moves whole tables, and
-- the public ticket link is reachable without signing in. Any of them could
-- be hammered by one user or script.
--
-- Change: one counter per (key, minute). A request increments its counter in a
-- single upsert and is refused once the minute's limit is reached
-- (app/lib/http/rateLimit.ts). Old windows are pruned as it goes.
--   key           what is limited, e.g. 'search:user:<id>', 'ticket:ip:<ip>'
--   window_start  the minute the count belongs to
--
-- Row-level security on, no policies, like every other table. Safe to apply
-- twice (if not exists).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.rate_limits (
  key          text not null,
  window_start timestamptz not null,
  n            integer not null default 1,
  primary key (key, window_start)
);
create index if not exists rate_limits_window_idx on public.rate_limits (window_start);
alter table public.rate_limits enable row level security;
