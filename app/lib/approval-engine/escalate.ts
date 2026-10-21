import type { Queryable } from '@/app/lib/db'
import { transaction } from '@/app/lib/db/transaction'
import * as approvals from '@/app/lib/repositories/approvals'
import * as audit from '@/app/lib/repositories/audit'

// ── escalateDueApprovals ─────────────────────────────────────────────────────
// An approval that has waited past its company's limit
// (clients.approval_escalation_hours, stamped on the row as escalates_at when
// it was raised) passes to the approver's own manager: a new pending row on
// the same booking or trip, step and chain, recording where it came from; the
// old row becomes 'escalated' and can no longer be decided. Once per step: the
// new row carries no escalates_at of its own.
//
// Nothing is approved without a person. An approver with no active manager at
// the company (or whose manager is the traveller) keeps the step, and the
// row's escalates_at is cleared so the sweep does not retry it forever.
//
// Run by POST /api/internal/escalate (a scheduler) or `npm run escalate`.
// ─────────────────────────────────────────────────────────────────────────────

export interface EscalationRun {
  escalated: number
  kept: number
}

export async function escalateDueApprovals(db: Queryable, now: Date = new Date()): Promise<EscalationRun> {
  const due = await approvals.dueForEscalation(db, now)
  const run: EscalationRun = { escalated: 0, kept: 0 }

  for (const row of due) {
    await transaction(async tx => {
      // Decided or moved on since it was read: nothing to do.
      if (!(await approvals.claimForEscalation(tx, row.id))) return

      const manager = await approvals.escalationTarget(tx, row)
      if (!manager) {
        run.kept++
        await audit.append(tx, {
          action: 'approval.escalation_kept', entityType: 'approval', entityId: row.id, userId: null,
          clientId: row.client_id, metadata: { approver_id: row.approver_id, why: 'no manager to pass it to' },
        })
        return
      }

      const next = await approvals.escalate(tx, row, manager)
      run.escalated++
      await audit.append(tx, {
        action: 'approval.escalated', entityType: 'approval', entityId: row.id, userId: null,
        clientId: row.client_id, metadata: { from: row.approver_id, to: manager, new_approval_id: next },
      })
    })
  }
  return run
}
