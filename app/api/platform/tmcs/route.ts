import { requirePlatformAdmin } from '@/app/lib/permissions/requirePlatformAdmin'
import { onboardTmc } from '@/app/lib/onboarding/onboardTmc'
import { parsePageParams, pagedResponse, ilikeAcross } from '@/app/lib/pagination'
import { NextRequest } from 'next/server'

// ── /api/platform/tmcs ───────────────────────────────────────────────────────
// GET   every TMC on the platform, with its client, staff and admin counts
// POST  create one and invite its first admin
//
// PLATFORM ADMIN ONLY. This is the surface that creates tenants, so it sits
// above every tenant role — see requirePlatformAdmin for why that is a separate
// table rather than a value on employees.role.
//
// Counts come from head-only queries rather than embedded aggregates: PostgREST
// can return them in one round trip, but the aggregate syntax is exactly the
// kind of thing that silently returns null when a relationship name changes, and
// a dashboard quietly reporting zero clients is worse than three more queries.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const check = await requirePlatformAdmin()
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  const { service } = check
  const params = parsePageParams(req.nextUrl.searchParams)

  let query = service
    .from('tmcs')
    .select('id, name, status, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })

  const filter = ilikeAcross(['name'], params.search)
  if (filter) query = query.or(filter)

  const { data: tmcs, error, count } = await query.range(params.from, params.to)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  const rows = tmcs ?? []

  // Counted per TMC on this page only — ten TMCs means thirty head queries,
  // which is cheap, and it stays cheap because the page size is fixed.
  const items = await Promise.all(rows.map(async tmc => {
    const [clients, staff, admins] = await Promise.all([
      service.from('clients').select('id', { count: 'exact', head: true }).eq('tmc_id', tmc.id),
      service.from('employees').select('id', { count: 'exact', head: true })
        .eq('tmc_id', tmc.id).in('role', ['tmc_admin', 'tc']),
      service.from('employees').select('id', { count: 'exact', head: true })
        .eq('tmc_id', tmc.id).eq('role', 'tmc_admin'),
    ])

    return {
      ...tmc,
      clientCount: clients.count ?? 0,
      staffCount: staff.count ?? 0,
      adminCount: admins.count ?? 0,
    }
  }))

  return Response.json(pagedResponse(items, count ?? null, params))
}

export async function POST(req: NextRequest) {
  const check = await requirePlatformAdmin()
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  const { tmcName, adminEmail, adminName } = await req.json()

  // Same implementation the Postman route calls. The create-and-roll-back
  // sequence lives in one place precisely so these two cannot diverge.
  const result = await onboardTmc(check.service, { tmcName, adminEmail, adminName })

  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status })
  }

  return Response.json({
    ok: true,
    tmcId: result.tmcId,
    message: `"${tmcName}" created. Invite sent to ${adminEmail}.`,
  }, { status: 201 })
}
