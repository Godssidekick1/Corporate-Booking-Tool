import { sql, maybeOne, type Queryable } from '@/app/lib/db/sql'
import type { Row } from '@/app/lib/db/types.generated'

// ── Approvals ────────────────────────────────────────────────────────────────
// Owns: approvals, approval_chain_templates, approval_tier_approvers,
// employee_default_approval_templates, band_default_approval_templates,
// client_default_approval_templates.
//
// Only the read the traveller's booking page needs lives here so far; the
// approval engine moves in a later phase.
// ─────────────────────────────────────────────────────────────────────────────

export type ApprovalStep = Pick<Row<'approvals'>, 'id' | 'tier' | 'status' | 'reason' | 'decision_note' | 'approver_id'>

// The step a traveller cares about: the highest tier -- the one pending now,
// or the one decided last.
export async function latestForBooking(db: Queryable, bookingId: string): Promise<ApprovalStep | null> {
  return maybeOne<ApprovalStep>(db, sql`
    select id, tier, status, reason, decision_note, approver_id from approvals
    where booking_id = ${bookingId}
    order by tier desc, created_at desc, id
    limit 1`)
}
