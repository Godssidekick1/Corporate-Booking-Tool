import { sql, many, one, type Queryable } from '@/app/lib/db/sql'
import type { Row } from '@/app/lib/db/types.generated'

// ── Forms of payment ─────────────────────────────────────────────────────────
// Owns: forms_of_payment, fop_assignments, fop_gds_entries, fop_payment_types.
//
// Reaches clients the same three ways deal codes do (client, bucket, client
// group). Only the reads the client and bucket screens need live here so far.
//
// last4 and card details are never selected here -- nothing on these screens
// needs them.
// ─────────────────────────────────────────────────────────────────────────────

export type FopAssignment = Pick<Row<'fop_assignments'>,
  'id' | 'fop_id' | 'kind' | 'client_id' | 'client_group_id' | 'bucket_id' | 'is_active'>

export async function assignmentsForTmc(db: Queryable, tmcId: string): Promise<FopAssignment[]> {
  return many<FopAssignment>(db, sql`
    select id, fop_id, kind, client_id, client_group_id, bucket_id, is_active
    from fop_assignments where tmc_id = ${tmcId}
    order by id`)
}

export type FopLabel = Pick<Row<'forms_of_payment'>, 'id' | 'fop_code' | 'label' | 'payer' | 'fop_type'>

export async function labels(db: Queryable, fopIds: readonly string[]): Promise<FopLabel[]> {
  if (fopIds.length === 0) return []
  return many<FopLabel>(db, sql`
    select id, fop_code, label, payer, fop_type from forms_of_payment
    where id = any(${[...fopIds]})
    order by id`)
}

export async function countForBucket(db: Queryable, bucketId: string): Promise<number> {
  return (await one<{ n: number }>(db, sql`
    select count(*)::int as n from fop_assignments where bucket_id = ${bucketId}`)).n
}
