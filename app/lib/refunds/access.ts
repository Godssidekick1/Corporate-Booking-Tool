import type { Queryable } from '@/app/lib/db'
import { requireTmcPermission, getAccessibleClientIds } from '@/app/lib/permissions/requireTmcPermission'

// ── Who may work the cancellation queue ─────────────────────────────────────
// TMC staff with process_refunds (its admins have every permission), within
// their reach: the whole TMC for an admin, a counsellor's own portfolio.
// Another TMC's refund, or a client outside the portfolio, is "not found".
// ─────────────────────────────────────────────────────────────────────────────

export type RefundCaller =
  | { ok: true; tmcId: string; clientIds: string[] | null }
  | { ok: false; status: number; error: string }

export async function refundCaller(db: Queryable, userId: string): Promise<RefundCaller> {
  const check = await requireTmcPermission(db, userId, 'process_refunds')
  if (!check.authorized || !check.tmcId || !check.role) {
    return { ok: false, status: check.status ?? 403, error: check.error ?? 'Forbidden' }
  }
  return { ok: true, tmcId: check.tmcId, clientIds: await getAccessibleClientIds(db, userId, check.role) }
}
