import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import { route } from '@/app/lib/http/handler'

// ── GET /api/settings/bands ──────────────────────────────────────────────────
// The company's own bands (code, label, rank), for the Users screen's invite
// and add forms: a new person goes into one of these, as POST /api/employees
// checks. Read-only: bands are the TMC's to define, since policy follows them.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async () => {
  const user = await requireUser()
  const caller = await employees.clientScope(db, user.id)
  if (!caller) return Response.json({ error: 'Employee record not found' }, { status: 404 })
  if (caller.role !== 'admin') return Response.json({ error: 'Only admins can see the company’s bands' }, { status: 403 })
  const bands = caller.client_id ? await employees.bandsForClient(db, caller.client_id) : []
  return Response.json({ ok: true, bands })
})
