import { db, transaction, type Queryable } from '@/app/lib/db'
import * as coverage from '@/app/lib/repositories/coverage'

// ── Keeping a stored coverage report current ─────────────────────────────────
// A report is current when it was built from the latest change counter (which
// triggers bump on every write to its source tables) AND for today: deals and
// rules open and close by date with nothing being written.
//
// When it is not, the first request rebuilds it inside one transaction:
//   1. take a per-TMC, per-report lock, so concurrent requests build once;
//   2. read the counter BEFORE reading any source rows -- a write that lands
//      after that read bumps the counter past what the rows record, so the
//      report is rebuilt again next time rather than looking current while
//      missing the write;
//   3. replace the rows and record (counter, date) they reflect.
// ─────────────────────────────────────────────────────────────────────────────

// The server's calendar date, as the resolvers' own default is -- so a report
// built "for today" means the same day the booking path would use.
export function todayIso(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

export type Rebuild = (tx: Queryable, builtFrom: number, asOf: string) => Promise<void>

export async function ensureCurrent(tmcId: string, report: coverage.Report, rebuild: Rebuild): Promise<void> {
  const asOf = todayIso()
  const current = (f: coverage.Freshness) => f.builtFrom === f.changes && f.builtOn === asOf

  if (current(await coverage.freshness(db, tmcId, report))) return

  await transaction(async tx => {
    await coverage.lockBuild(tx, tmcId, report)
    // Again under the lock: whoever held it may have just built it.
    const f = await coverage.freshness(tx, tmcId, report)
    if (current(f)) return
    await rebuild(tx, f.changes, asOf)
  }, { tenantId: tmcId })
}
