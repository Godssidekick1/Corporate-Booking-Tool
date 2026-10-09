import type { Queryable } from '@/app/lib/db'
import * as dealCodes from '@/app/lib/repositories/dealCodes'
import * as clients from '@/app/lib/repositories/clients'
import * as coverage from '@/app/lib/repositories/coverage'
import { resolveDealCodes, describeVia, type ResolvableAssignment } from '@/app/lib/deal-codes/resolveDealCodes'
import { reachIndex } from '@/app/lib/assignments/reachIndex'
import { ensureCurrent } from './freshness'

// ── Deal code coverage ───────────────────────────────────────────────────────
// Which code actually applies, for every client, and why: one row per client
// per airline per type, carrying only the winner. Built by the same resolver
// the booking path stamps with, then stored so the screen can search and page
// it in SQL (coverage repository).
// ─────────────────────────────────────────────────────────────────────────────

// How many of the deals a winner beat are kept, closest first. The rest are
// counted: a client reached through two buckets and a group can have dozens,
// and storing them all was most of a 39 MB report at 10,000 clients.
export const BEAT_SHOWN = 5

// Every client of the TMC, in screen order: clients by name, then the
// resolver's own order (airline, code type).
export async function computeDealCoverage(
  db: Queryable, tmcId: string, asOf: string
): Promise<coverage.DealCoverageRow[]> {
  // One after another, not Promise.all: `db` is the rebuild's single
  // transaction connection, which runs one query at a time anyway.
  const clientRows = await clients.coverageClients(db, tmcId, null)
  const assignmentRows = await dealCodes.assignmentsForTmc(db, tmcId)
  if (clientRows.length === 0 || assignmentRows.length === 0) return []

  const dealIds = [...new Set(assignmentRows.map(a => a.deal_code_id))]
  const bucketIds = [...new Set(assignmentRows.map(a => a.bucket_id).filter((b): b is string => Boolean(b)))]

  const deals = await dealCodes.forResolution(db, dealIds)
  const buckets = await clients.bucketLabels(db, bucketIds)
  const groupName = await clients.groupNamesForTmc(db, tmcId)
  const memberships = await clients.memberships(db, clientRows.map(c => c.id))

  // Which buckets each client sits in, built once rather than per client.
  const bucketsByClient = new Map<string, string[]>()
  for (const m of memberships) {
    const list = bucketsByClient.get(m.client_id)
    if (list) list.push(m.bucket_id)
    else bucketsByClient.set(m.client_id, [m.bucket_id])
  }

  // Indexed once by target: filtering every assignment for every client was
  // clients x assignments (21 s at 10,000 x 50,000, npm run scale).
  const reachingOf = reachIndex(assignmentRows)

  const rows: coverage.DealCoverageRow[] = []
  for (const client of clientRows) {
    const reaching = reachingOf(client.id, client.client_group_id, bucketsByClient.get(client.id) ?? [])
    if (reaching.length === 0) continue

    const assignments: ResolvableAssignment[] = reaching.map(a => ({
      deal_code_id: a.deal_code_id,
      kind: a.kind,
      via_name:
        a.kind === 'bucket'
          ? buckets.get(a.bucket_id!)?.name ?? null
          : a.kind === 'client_group'
            ? groupName.get(a.client_group_id!) ?? null
            : null,
    }))

    for (const r of resolveDealCodes({ deals, assignments, bookingDate: asOf })) {
      rows.push({
        clientId: client.id,
        clientName: client.name,
        airline: r.airline,
        codeType: r.codeType,
        code: r.code,
        via: describeVia(r.kind, r.viaName),
        ambiguous: r.ambiguous,
        beat: r.beat.slice(0, BEAT_SHOWN).map(b => ({ code: b.code, via: describeVia(b.kind, b.viaName) })),
        beatMore: Math.max(0, r.beat.length - BEAT_SHOWN),
      })
    }
  }
  return rows
}

export function ensureDealCoverage(tmcId: string): Promise<void> {
  return ensureCurrent(tmcId, 'deal_codes', async (tx, builtFrom, asOf) => {
    const rows = await computeDealCoverage(tx, tmcId, asOf)
    await coverage.replaceDealCoverage(tx, tmcId, rows, builtFrom, asOf)
  })
}
