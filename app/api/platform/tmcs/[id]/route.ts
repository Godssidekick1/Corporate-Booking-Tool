import { requirePlatformAdmin } from '@/app/lib/permissions/requirePlatformAdmin'
import { inviteTmcAdmin } from '@/app/lib/onboarding/onboardTmc'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'
import * as tmcs from '@/app/lib/repositories/tmcs'
import * as employees from '@/app/lib/repositories/employees'
import { route } from '@/app/lib/http/handler'

// ── /api/platform/tmcs/[id] ──────────────────────────────────────────────────
// GET    one TMC, with its staff list — the detail behind a row on /platform
// POST   invite a further admin to it
// PATCH  change its status (active / inactive)
//
// NO DELETE. A TMC owns clients, bookings and invoices; removing one is not an
// operation a screen should offer, and "inactive" is what retiring one actually
// means. Anything genuinely needing removal is a database job done deliberately.
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_STATUSES = ['active', 'inactive'] as const

type Ctx = { params: Promise<{ id: string }> }

export const GET = route(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const check = await requirePlatformAdmin()
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  const tmc = await tmcs.tmc(db, id)

  if (!tmc) {
    return Response.json({ error: 'TMC not found' }, { status: 404 })
  }

  // TMC-side staff only. Corporate employees belong to a client, and listing
  // them here would mean this screen showing every traveller on the platform.
  const staff = await employees.staffOfTmc(db, id)

  return Response.json({ ok: true, tmc, staff })
})

export const POST = route(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const check = await requirePlatformAdmin()
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  const tmc = await tmcs.tmc(db, id)
  if (!tmc) {
    return Response.json({ error: 'TMC not found' }, { status: 404 })
  }

  const { fullName, email } = await req.json()
  const result = await inviteTmcAdmin(id, fullName, email)

  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status })
  }

  return Response.json({
    ok: true,
    message: `Invite sent to ${email} for ${tmc.name}.`,
  }, { status: 201 })
})

export const PATCH = route(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const check = await requirePlatformAdmin()
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  const { status } = await req.json()

  if (!ALLOWED_STATUSES.includes(status)) {
    return Response.json(
      { error: `Invalid status: ${status}. Must be one of ${ALLOWED_STATUSES.join(', ')}` },
      { status: 400 }
    )
  }

  const updated = await tmcs.setTmcStatus(db, id, status)
  if (!updated) {
    return Response.json({ error: 'TMC not found' }, { status: 404 })
  }

  return Response.json({ ok: true, tmc: updated })
})
