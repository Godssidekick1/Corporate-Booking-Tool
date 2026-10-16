import { requireUser } from '@/app/lib/auth/session'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as clients from '@/app/lib/repositories/clients'
import { route } from '@/app/lib/http/handler'
import { onBehalf, refuse } from '@/app/lib/book/bookingActor'
import { TRIP_CURRENCIES } from '@/app/lib/trips/details'

// ── GET /api/trips/options?travellerId= ─────────────────────────────────────
// What the New trip form offers for one traveller: their company's cost
// centres, the currencies, and whether the company signs trips off. A
// traveller asks for themself; whoever books for them (a colleague who is an
// admin, the travel desk) asks with travellerId, by the same rule as booking
// for them (app/lib/book/bookingActor.ts).
//
// The cost centre list is small (a company has tens, not thousands) and the
// form needs it whole for a dropdown, so it is not paged.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async (req: NextRequest) => {
  const user = await requireUser()
  const travellerId = req.nextUrl.searchParams.get('travellerId')

  let clientId: string | null
  if (travellerId && travellerId !== user.id) {
    const r = await onBehalf(db, user, travellerId)
    if (!r.ok) return refuse(r)
    clientId = r.actor.traveller.client_id
  } else {
    clientId = (await employees.traveller(db, user.id))?.client_id ?? null
  }

  if (!clientId) {
    return Response.json({ error: "Trips belong to a company's travellers" }, { status: 403 })
  }

  const [costCentres, modes] = await Promise.all([
    clients.costCentres(db, clientId),
    clients.approvalModes(db, clientId),
  ])

  return Response.json({
    ok: true,
    costCentres,
    currencies: TRIP_CURRENCIES,
    tripApprovalRequired: modes?.trip_approval_mode === 'on_submit',
  })
})
