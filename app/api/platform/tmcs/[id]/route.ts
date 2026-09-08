import { requirePlatformAdmin } from '@/app/lib/permissions/requirePlatformAdmin'
import { inviteTmcAdmin } from '@/app/lib/onboarding/onboardTmc'
import { NextRequest } from 'next/server'

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

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const check = await requirePlatformAdmin()
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  const { service } = check

  const { data: tmc } = await service
    .from('tmcs')
    .select('id, name, status, created_at')
    .eq('id', id)
    .maybeSingle()

  if (!tmc) {
    return Response.json({ error: 'TMC not found' }, { status: 404 })
  }

  // TMC-side staff only. Corporate employees belong to a client, and listing
  // them here would mean this screen showing every traveller on the platform.
  const { data: staff } = await service
    .from('employees')
    .select('id, full_name, email, role, status, created_at')
    .eq('tmc_id', id)
    .in('role', ['tmc_admin', 'tc'])
    .order('role')
    .order('full_name')

  return Response.json({ ok: true, tmc, staff: staff ?? [] })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const check = await requirePlatformAdmin()
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  const { service } = check

  const { data: tmc } = await service.from('tmcs').select('id, name').eq('id', id).maybeSingle()
  if (!tmc) {
    return Response.json({ error: 'TMC not found' }, { status: 404 })
  }

  const { fullName, email } = await req.json()
  const result = await inviteTmcAdmin(service, id, fullName, email)

  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status })
  }

  return Response.json({
    ok: true,
    message: `Invite sent to ${email} for ${tmc.name}.`,
  }, { status: 201 })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const { data: updated, error } = await check.service
    .from('tmcs')
    .update({ status })
    .eq('id', id)
    .select('id, name, status')
    .maybeSingle()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }
  if (!updated) {
    return Response.json({ error: 'TMC not found' }, { status: 404 })
  }

  return Response.json({ ok: true, tmc: updated })
}
