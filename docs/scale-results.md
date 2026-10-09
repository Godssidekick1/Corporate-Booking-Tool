# Scale results

Measured with `npm run scale` (tests/scale): a throwaway copy of the anonymised
test database, with one TMC grown to the volumes below, every request timed as
the median of 5 runs on a developer laptop (database on the same machine, so
network latency is **not** included: a hosted database adds its round-trip time
to every query).

Volumes: 10,009 clients · 204 client groups · 503 buckets (20,008 memberships)
· 5,003 deal codes with 49,953 assignments · 1,003 forms of payment with 9,993
assignments · 2,005 commercial rules with 19,990 assignments.

## 2026-10-08: booking path, coverage reports, indexes

| What | Before (ms) | After (ms) | Change |
|---|---:|---:|---|
| Deal code coverage (page 1) | 21,510 | 883 | 24x faster |
| Commercial coverage, markup (page 1) | 6,188 | 592 | 10x faster |
| Booking: deal codes for one client | 121 | 5 | 24x faster |
| Booking: commercials for one client | 29 | 2 | 14x faster; loads ~30 rules, not 2,005 |
| Booking: payment method for one client | 13 | 9 | unchanged in substance |
| Clients / buckets / deal codes / FOP lists (page 1) | 8–58 | 8–58 | already paged in SQL |

What changed:

- **Booking path** (every pricing / add-passenger request): asks the database
  for only the assignments that reach the traveller's client
  (`app/lib/db/fragments.ts` `reaching`), and for commercials only the rules
  those assignments name. Before, it read every assignment (and every rule) of
  the TMC and filtered in JavaScript.
- **Indexes**: partial indexes on client / client group / bucket for the three
  assignment tables (`20261009000100_assignment_reach_indexes`). The lookup is
  written as `bucket_id = any(array(...))` so PostgreSQL combines all three
  (0.3 ms vs 6.9 ms for a full scan at 50k rows).
- **Coverage reports**: assignments indexed once by target
  (`app/lib/assignments/reachIndex.ts`) instead of filtered once per client;
  the rule and deal maps the resolvers build are reused across clients instead
  of rebuilt for each. Output is identical (all route snapshots unchanged).

## 2026-10-09: coverage reports stored, searched and paged in SQL

| What | Before (ms) | After (ms) | Budget (ms) |
|---|---:|---:|---:|
| Deal code coverage (page 1) | 883 | 16 | 300 |
| Deal code coverage, search | 883 (every keystroke) | 23 | 300 |
| Commercial coverage, markup (page 1) | 592 | 6 | 300 |
| Commercial coverage, search | 592 (every keystroke) | 30 | 300 |
| 20 coverage searches at once | ~20 x 883, in one process | 121 for all 20 | 1,500 |
| First read after a change (rebuild), deal codes | — | 2,371 | 5,000 |
| First read after a change (rebuild), commercials | — | 1,844 | 5,000 |
| Peak memory of the run | 593 MB | 378 MB | — |

What changed:

- **Stored reports** (`20261010000000_coverage_tables`, `app/lib/coverage`):
  the resolved coverage is kept per TMC and the screens search and page it
  with SQL. It is rebuilt by the same resolvers the booking path uses, only
  when it is out of date: triggers on every source table bump a per-TMC
  counter, and the date it was built for is checked (deals open and close by
  date with nothing written). One builder at a time per TMC (advisory lock).
- **Losers capped** (`20261010000100_coverage_beat_more`): a coverage row
  keeps the five deals its winner most nearly beat and counts the rest. Every
  loser made the report 39 MB at this size and its storing took 4.9 s of a
  6.1 s rebuild; now 4.4 MB and 1.3 s.
- **Budgets**: every measurement has one and `npm run scale` fails when one is
  exceeded.
