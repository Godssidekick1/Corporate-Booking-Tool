import { createClient } from '@/utils/supabase/server'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'
import * as dealCodes from '@/app/lib/repositories/dealCodes'
import * as clients from '@/app/lib/repositories/clients'
import { route } from '@/app/lib/http/handler'

// ── /api/tmc/deal-code-assignments ───────────────────────────────────────────
// Who a deal reaches. This is the column that used to live on the deal itself,
// and moving it here is what makes "give this to a whole group" one action.
//
// POST takes an ARRAY of targets in one call. The screen this replaces makes
// you repeat a whole form per corporate; assigning twelve clients should be one
// request, not twelve.
//
// DELETE removes one assignment by id.
// ─────────────────────────────────────────────────────────────────────────────

const KINDS = ['client', 'client_group', 'bucket'] as const
type Kind = typeof KINDS[number]

export const GET = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_deal_codes')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const assignments = await dealCodes.assignmentList(db, auth.tmcId, req.nextUrl.searchParams.get('dealCodeId'))

  return Response.json({ ok: true, assignments })
})

interface CreateBody {
  dealCodeId: string
  targets: { kind: Kind; id: string }[]
}

export const POST = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_deal_codes')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const body: CreateBody = await req.json()

  if (!body.dealCodeId || !Array.isArray(body.targets) || body.targets.length === 0) {
    return Response.json({ error: 'dealCodeId and at least one target are required' }, { status: 400 })
  }

  if (!(await dealCodes.dealInTmc(db, body.dealCodeId, auth.tmcId))) {
    return Response.json({ error: 'Deal code not found' }, { status: 404 })
  }

  const unknownKind = body.targets.find(t => !KINDS.includes(t.kind))
  if (unknownKind) {
    return Response.json({ error: `Unknown target kind: ${unknownKind.kind}` }, { status: 400 })
  }

  // Every target is verified to belong to this TMC before anything is written.
  // These are plain FKs, so an id borrowed from another tenant would satisfy the
  // constraint and quietly hand another TMC's client a negotiated fare. One
  // query per kind, where this used to be one per target.
  const ours = await clients.targetIdsInTmc(db, auth.tmcId, body.targets)
  const foreign = body.targets.find(t => !ours.has(clients.targetKey(t.kind, t.id)))
  if (foreign) {
    return Response.json(
      { error: `That ${foreign.kind.replace('_', ' ')} does not belong to your TMC` },
      { status: 422 }
    )
  }

  // Re-assigning something already assigned is a no-op, not an error: the UI
  // sends the full selection, and the partial unique indexes make the duplicate
  // harmless.
  await dealCodes.assign(db, auth.tmcId, body.dealCodeId,
    body.targets.map(t => ({ kind: t.kind, targetId: t.id })), user.id)

  return Response.json({ ok: true, assigned: body.targets.length })
})

export const DELETE = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_deal_codes')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const id = req.nextUrl.searchParams.get('id')
  if (!id) {
    return Response.json({ error: 'id is required' }, { status: 400 })
  }

  // Scoped by tmc_id in the delete itself rather than checked first, so there is
  // no window between the check and the write.
  await dealCodes.unassign(db, id, auth.tmcId)

  return Response.json({ ok: true })
})
