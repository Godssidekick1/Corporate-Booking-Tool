import { sql, one, exec, type Queryable } from '@/app/lib/db/sql'

// ── rate_limits ──────────────────────────────────────────────────────────────
// Per-minute request counters for the expensive endpoints. What the limits
// are, and what happens at them, is app/lib/http/rateLimit.ts.
// ─────────────────────────────────────────────────────────────────────────────

// Counts one request against `key` in the current minute; returns the count
// including it.
export async function hit(db: Queryable, key: string): Promise<number> {
  return (await one<{ n: number }>(db, sql`
    insert into rate_limits (key, window_start) values (${key}, date_trunc('minute', now()))
    on conflict (key, window_start) do update set n = rate_limits.n + 1
    returning n`)).n
}

export async function prune(db: Queryable): Promise<void> {
  await exec(db, sql`delete from rate_limits where window_start < now() - interval '10 minutes'`)
}
