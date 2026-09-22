import type { DbClient } from './client'

// ── Dual run ─────────────────────────────────────────────────────────────────
// Turns "I believe the shim is equivalent" into evidence, across all 537 call
// sites at once, by running the real application against both drivers and
// comparing what they return.
//
// Enabled with DB_DUAL_RUN=1. Off, this module is never constructed.
//
// HOW IT WORKS: the shim exists precisely so that its fluent API matches
// supabase-js. That makes a recording proxy possible -- every method call is
// forwarded to BOTH builders, and awaiting the proxy awaits both and compares.
// No call site knows it is happening.
//
// READS ONLY. A doubled insert would write the row twice, a doubled delete
// would remove rows that the comparison then reports as a divergence, and
// neither is recoverable by a harness. The moment a write method is seen the
// secondary is dropped and only the primary runs -- so a dual run is a
// read-comparison over a normally-behaving application, which is what makes it
// safe to leave on during a QA pass.
//
// DIVERGENCE IS LOGGED, NOT THROWN. The point is to collect a list of
// differences from a full exercise of the product, not to stop at the first
// one. What the app returns is always the primary's answer.
// ─────────────────────────────────────────────────────────────────────────────

const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete'])

export interface Divergence {
  table: string
  chain: string
  kind: 'error' | 'count' | 'length' | 'row'
  detail: string
}

const divergences: Divergence[] = []

export function getDivergences(): readonly Divergence[] {
  return divergences
}

export function clearDivergences(): void {
  divergences.length = 0
}

function record(d: Divergence): void {
  divergences.push(d)
  console.warn(`[dual-run] ${d.kind} divergence on ${d.table}\n  ${d.chain}\n  ${d.detail}`)
}

// ── Comparison ───────────────────────────────────────────────────────────────

// Both drivers are asked to produce the same JSON; comparing the serialised
// form is what the call sites and the browser ultimately see. Key order differs
// between a SELECT list and PostgREST's projection, so keys are sorted first.
function canonical(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return value.map(canonical)
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key])
    }
    return out
  }
  // PostgREST emits a numeric as a JSON number; a driver that produced the
  // string "12.30" for the same column should be reported, but 12.3 and 12.30
  // are the same value and should not be.
  if (typeof value === 'number') return Number(value.toFixed(6))
  return value
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

interface Result {
  data?: unknown
  error?: unknown
  count?: number | null
}

function compare(table: string, chain: string, primary: Result, secondary: Result): void {
  const pErr = Boolean(primary.error)
  const sErr = Boolean(secondary.error)

  if (pErr !== sErr) {
    record({
      table, chain, kind: 'error',
      detail: `pg ${pErr ? 'errored' : 'succeeded'}, postgrest ${sErr ? 'errored' : 'succeeded'}: ` +
        JSON.stringify({ pg: primary.error, postgrest: secondary.error }),
    })
    return
  }
  // Both failed. The messages differ by design -- pg's are PostgreSQL's own --
  // so there is nothing useful to compare past this point.
  if (pErr) return

  if ((primary.count ?? null) !== (secondary.count ?? null)) {
    record({
      table, chain, kind: 'count',
      detail: `pg=${primary.count} postgrest=${secondary.count}`,
    })
  }

  const pRows = primary.data
  const sRows = secondary.data

  if (Array.isArray(pRows) && Array.isArray(sRows) && pRows.length !== sRows.length) {
    record({
      table, chain, kind: 'length',
      detail: `pg=${pRows.length} rows, postgrest=${sRows.length} rows`,
    })
    return
  }

  if (!same(pRows, sRows)) {
    record({
      table, chain, kind: 'row',
      detail:
        `pg=${JSON.stringify(canonical(pRows)).slice(0, 400)}\n  ` +
        `postgrest=${JSON.stringify(canonical(sRows)).slice(0, 400)}`,
    })
  }
}

// ── The proxy ────────────────────────────────────────────────────────────────

// Loosely typed on purpose: this wraps two builders with the same shape but
// unrelated declared types, and its only job is to forward calls verbatim.
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyBuilder = any

function wrap(table: string, primary: AnyBuilder, secondary: AnyBuilder | null, chain: string[]): AnyBuilder {
  return new Proxy({} as AnyBuilder, {
    get(_target, prop: string | symbol) {
      if (prop === 'then') {
        return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => {
          const run = async () => {
            const primaryResult = await primary
            if (!secondary) return primaryResult

            try {
              const secondaryResult = await secondary
              compare(table, chain.join('.'), primaryResult as Result, secondaryResult as Result)
            } catch (err) {
              // A throw from the comparison path must never reach the caller:
              // the app's answer is the primary's, and a broken harness is a
              // harness bug, not an application failure.
              console.warn('[dual-run] secondary threw', err)
            }
            return primaryResult
          }
          return run().then(onFulfilled, onRejected)
        }
      }

      if (typeof prop !== 'string') return undefined

      return (...args: unknown[]) => {
        const next = [...chain, `${prop}(${args.map(summarise).join(', ')})`]
        const p = primary[prop](...args)

        // Once a write appears, the secondary is abandoned for the rest of the
        // chain. It is never executed, so nothing is written twice.
        if (WRITE_METHODS.has(prop)) return wrap(table, p, null, next)

        if (!secondary) return wrap(table, p, null, next)
        return wrap(table, p, secondary[prop](...args), next)
      }
    },
  })
}

function summarise(arg: unknown): string {
  if (typeof arg === 'string') return arg.length > 40 ? `${arg.slice(0, 40)}…` : arg
  if (Array.isArray(arg)) return `[${arg.length}]`
  if (arg && typeof arg === 'object') return '{…}'
  return String(arg)
}

// `secondary` is the supabase-js client; it is not a DbClient and cannot be
// typed as one, which is the whole reason this file is loosely typed.
export function createDualRunClient(primary: DbClient, secondary: AnyBuilder): DbClient {
  return {
    from(table: string) {
      return wrap(table, primary.from(table), secondary.from(table), [`from(${table})`])
    },
  } as DbClient
}
