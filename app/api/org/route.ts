import { NextRequest } from 'next/server'
import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import { route } from '@/app/lib/http/handler'
import { isUuid } from '@/app/lib/book/bookingActor'
import * as employees from '@/app/lib/repositories/employees'
import * as org from '@/app/lib/repositories/org'
import { visible } from '@/app/lib/org/visible'

// ── GET /api/org?focus=<employeeId> ──────────────────────────────────────────
// One person's place in their company, for the Organization page (after Teams'
// Organization tab and Org Explorer): the person in focus with their direct
// and total report counts, the chain of managers above them to the top, their
// peers (the same manager) and their direct reports. Without focus: oneself.
//
// For a company's own people only, within their own company; anyone else in it
// may be looked at. `myChain` lists the viewer's own managers, so the page can
// highlight them wherever they appear.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async (req: NextRequest) => {
  const user = await requireUser()
  const me = await employees.clientScope(db, user.id)
  if (!me?.client_id) return Response.json({ error: 'The organization chart is for a company’s people' }, { status: 403 })
  const clientId = me.client_id

  const focusId = req.nextUrl.searchParams.get('focus') || user.id
  if (!isUuid(focusId)) return Response.json({ error: 'Person not found' }, { status: 404 })
  const focus = await org.person(db, clientId, focusId)
  if (!focus) return Response.json({ error: 'Person not found' }, { status: 404 })

  const [chain, peerList, reports, total, myChain] = await Promise.all([
    org.managerChain(db, clientId, focus.id),
    org.peers(db, clientId, focus),
    org.directReports(db, clientId, focus.id),
    org.totalReports(db, clientId, focus.id),
    focus.id === user.id ? null : org.managerChain(db, clientId, user.id),
  ])

  const viewer = { id: user.id, role: me.role }
  const show = (p: org.OrgPerson) => visible(p, viewer)
  return Response.json({
    ok: true,
    me: user.id,
    focus: { ...show(focus), totalReports: total },
    // Nearest manager first.
    chain: chain.map(show),
    peers: { people: peerList.rows.map(show), total: peerList.total },
    reports: { people: reports.rows.map(show), total: reports.total },
    // The viewer's own managers (their reporting line), highlighted on the page.
    myChain: (myChain ?? chain).map(p => p.id),
    // Admins see how many have no reporting line (from the whole company).
    ...(me.role === 'admin' ? { unassigned: (await org.search(db, clientId, { unassigned: true, page: { from: 0, to: 0 } })).total } : {}),
  })
})
