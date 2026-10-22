import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import { requireTmcPermission, getAccessibleClientIds } from '@/app/lib/permissions/requireTmcPermission'
import type { Scope } from '@/app/lib/repositories/reports'

// ── Who may read reports, and over what ──────────────────────────────────────
//   company   its admins and finance, over their own company only
//   TMC       TMC admins over every client of the TMC; counsellors holding
//             view_reports over their own portfolio. A client filter outside
//             the portfolio is refused, not quietly emptied.
// ─────────────────────────────────────────────────────────────────────────────

type Refusal = { refused: Response }

export async function companyScope(userId: string): Promise<{ scope: Extract<Scope, { side: 'client' }> } | Refusal> {
  const me = await employees.profile(db, userId)
  if (!me || !me.client_id || me.status === 'deactivated' || (me.role !== 'admin' && me.role !== 'finance')) {
    return { refused: Response.json({ error: 'Reports are for your company’s admins and finance' }, { status: 403 }) }
  }
  return { scope: { side: 'client', clientId: me.client_id } }
}

export async function tmcScope(
  userId: string,
  clientId: string | null,
): Promise<{ scope: Extract<Scope, { side: 'tmc' }> } | Refusal> {
  const auth = await requireTmcPermission(db, userId, 'view_reports')
  if (!auth.authorized || !auth.tmcId) {
    return { refused: Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 }) }
  }
  const clientIds = await getAccessibleClientIds(db, userId, auth.role ?? 'tc')
  if (clientId && clientIds !== null && !clientIds.includes(clientId)) {
    return { refused: Response.json({ error: 'No access to this client' }, { status: 403 }) }
  }
  return { scope: { side: 'tmc', tmcId: auth.tmcId, clientIds } }
}
