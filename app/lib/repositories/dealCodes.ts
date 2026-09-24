import { sql, many, one, type Queryable } from '@/app/lib/db/sql'
import type { Row } from '@/app/lib/db/types.generated'

// ── Deal codes ───────────────────────────────────────────────────────────────
// Owns: deal_codes, deal_code_assignments, deal_code_categories,
// deal_code_category_types.
//
// A deal code reaches a client in one of three ways (an assignment's `kind`):
// directly, through a bucket the client is in, or through the client's group.
//
// Only the reads the client and bucket screens need live here so far; the deal
// code master itself moves in a later phase.
// ─────────────────────────────────────────────────────────────────────────────

export type DealAssignment = Pick<Row<'deal_code_assignments'>,
  'id' | 'deal_code_id' | 'kind' | 'client_id' | 'client_group_id' | 'bucket_id'>

// Every assignment in the TMC. The caller decides which reach a given client,
// so the rule for "reaches" lives in one place in the domain code.
export async function assignmentsForTmc(db: Queryable, tmcId: string): Promise<DealAssignment[]> {
  return many<DealAssignment>(db, sql`
    select id, deal_code_id, kind, client_id, client_group_id, bucket_id
    from deal_code_assignments where tmc_id = ${tmcId}
    order by id`)
}

export type DealCodeLabel = Pick<Row<'deal_codes'>, 'id' | 'code' | 'code_type' | 'airline_code'>

export async function labels(db: Queryable, dealCodeIds: readonly string[]): Promise<DealCodeLabel[]> {
  if (dealCodeIds.length === 0) return []
  return many<DealCodeLabel>(db, sql`
    select id, code, code_type, airline_code from deal_codes
    where id = any(${[...dealCodeIds]})
    order by airline_code, code, id`)
}

// ═══ Reach through buckets ══════════════════════════════════════════════════

export async function countByBucket(db: Queryable, bucketIds: readonly string[]): Promise<Map<string, number>> {
  if (bucketIds.length === 0) return new Map()
  const rows = await many<{ bucket_id: string; n: number }>(db, sql`
    select bucket_id, count(*)::int as n from deal_code_assignments
    where bucket_id = any(${[...bucketIds]}) group by bucket_id`)
  return new Map(rows.map(r => [r.bucket_id, r.n]))
}

export async function countForBucket(db: Queryable, bucketId: string): Promise<number> {
  return (await one<{ n: number }>(db, sql`
    select count(*)::int as n from deal_code_assignments where bucket_id = ${bucketId}`)).n
}

export async function idsForBucket(db: Queryable, bucketId: string): Promise<string[]> {
  const rows = await many<{ deal_code_id: string }>(db, sql`
    select deal_code_id from deal_code_assignments where bucket_id = ${bucketId} order by deal_code_id`)
  return rows.map(r => r.deal_code_id)
}
