import { sql, many, one, type Queryable } from '@/app/lib/db/sql'
import type { Row } from '@/app/lib/db/types.generated'
import type { ResolvableFop } from '@/app/lib/fop/resolveFop'

// ── Forms of payment ─────────────────────────────────────────────────────────
// Owns: forms_of_payment, fop_assignments, fop_gds_entries, fop_payment_types.
//
// Reaches clients the same three ways deal codes do (client, bucket, client
// group). The master's own CRUD moves here in a later phase.
//
// Card fields (last4, expiry) are selected ONLY by forResolution, whose result
// is frozen onto a booking. The screen reads (labels, assignments) never
// select them.
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

// ═══ Resolution ═════════════════════════════════════════════════════════════

// Every form of payment at the TMC, as resolveFop ranks them. The card
// fields ARE read here: the resolved choice is frozen onto the booking with
// its description ("Amex ···· 1111"), which is how a counsellor knows which
// card to charge.
export async function forResolution(db: Queryable, tmcId: string): Promise<ResolvableFop[]> {
  return many<ResolvableFop>(db, sql`
    select id, label, fop_type, payer, card_type, last4, expiry_month, expiry_year, branch_id,
           airline_code, rbd_spec, active, is_default, created_at
    from forms_of_payment where tmc_id = ${tmcId}
    order by created_at, id`)
}
