import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import { route } from '@/app/lib/http/handler'
import * as employees from '@/app/lib/repositories/employees'
import * as dashboard from '@/app/lib/repositories/dashboard'

// ── GET /api/dashboard ───────────────────────────────────────────────────────
// The figures on a corporate user's dashboard, by what they are:
//   everyone           their own travel this year, what is next, what waits
//   approvers          what they decided in the last 30 days, and how fast
//                      (admins, finance, anyone with people reporting to them)
//   admin, finance     the company this month against last, policy outcomes,
//                      and six months of spend
// Sell side only: what the company pays, never the airline's figure.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async () => {
  const user = await requireUser()
  const me = await employees.profile(db, user.id)
  if (!me || !me.client_id || me.role === 'tmc_admin' || me.role === 'tc') {
    return Response.json({ error: 'Only a company’s people have this dashboard' }, { status: 403 })
  }

  const seesCompany = me.role === 'admin' || me.role === 'finance'
  const [mine, approver, company] = await Promise.all([
    dashboard.myTravel(db, me.id),
    seesCompany ? true : employees.hasDirectReports(db, me.id),
    seesCompany ? dashboard.companyFigures(db, me.client_id) : null,
  ])
  const work = approver ? await dashboard.approverWork(db, me.id) : null

  return Response.json({ ok: true, mine, approver: work, company })
})
