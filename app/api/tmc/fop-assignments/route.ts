import { createClient } from '@/utils/supabase/server'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { parsePageParams, pagedResponse } from '@/app/lib/pagination'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'
import * as fops from '@/app/lib/repositories/fop'
import * as clients from '@/app/lib/repositories/clients'
import { route } from '@/app/lib/http/handler'

// ── /api/tmc/fop-assignments ─────────────────────────────────────────────────
// Who a form of payment applies to.
//
// Mirrors deal-code-assignments. A form of payment with no row here reaches
// nobody — the fallback for a client matching nothing is the one flagged
// `is_default`, chosen deliberately, not inferred from an absence of rows.
//
// GET is the MAPPING LIST: every mapping across every form of payment, one flat
// paged table, which is the view the per-FOP editor cannot give you. The
// question it answers is "what is mapped to CBTGROUP" — you cannot answer that
// by opening forms of payment one at a time. Search spans both halves of a
// mapping (the form of payment and the target); see fops.mappings.
//
// POST takes an ARRAY of targets so assigning twelve clients is one request.
// ─────────────────────────────────────────────────────────────────────────────

const KINDS = ['client', 'client_group', 'bucket'] as const
type Kind = typeof KINDS[number]

async function authorise(userId: string) {
  const auth = await requireTmcPermission(db, userId, 'manage_fops')
  if (!auth.authorized || !auth.tmcId) {
    return { ok: false as const, error: auth.error ?? 'Forbidden', status: auth.status ?? 403 }
  }
  return { ok: true as const, tmcId: auth.tmcId }
}

export const GET = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const access = await authorise(user.id)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  const params = parsePageParams(req.nextUrl.searchParams)
  const { rows, total } = await fops.mappings(db, access.tmcId, {
    fopId: req.nextUrl.searchParams.get('fopId'),
    search: params.search,
  }, params)

  return Response.json(pagedResponse(rows, total, params))
})

interface CreateBody {
  fopId: string
  targets: { kind: Kind; id: string }[]
}

export const POST = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const access = await authorise(user.id)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  const body: CreateBody = await req.json()

  if (!body.fopId || !Array.isArray(body.targets) || body.targets.length === 0) {
    return Response.json({ error: 'fopId and at least one target are required' }, { status: 400 })
  }

  if (!(await fops.fopInTmc(db, body.fopId, access.tmcId))) {
    return Response.json({ error: 'Form of payment not found' }, { status: 404 })
  }

  const unknownKind = body.targets.find(t => !KINDS.includes(t.kind))
  if (unknownKind) {
    return Response.json({ error: `Unknown target kind: ${unknownKind.kind}` }, { status: 400 })
  }

  // Every target verified against this TMC before anything is written. These are
  // plain FKs, so an id borrowed from another tenant would satisfy the
  // constraint and quietly point another TMC's client at this card.
  const ours = await clients.targetIdsInTmc(db, access.tmcId, body.targets)
  const foreign = body.targets.find(t => !ours.has(clients.targetKey(t.kind, t.id)))
  if (foreign) {
    return Response.json(
      { error: `That ${foreign.kind.replace('_', ' ')} does not belong to your TMC` },
      { status: 422 }
    )
  }

  // Re-assigning something already assigned is a no-op, not an error: the UI
  // sends the full selection and the partial unique indexes make the duplicate
  // harmless.
  await fops.assign(db, access.tmcId, body.fopId, body.targets.map(t => ({ kind: t.kind, targetId: t.id })), user.id)

  return Response.json({ ok: true, assigned: body.targets.length })
})

// Switch one mapping off without deleting it — the old screen's Is Active
// column. Separate from the form of payment's own active flag: this takes ONE
// client off it while it keeps working for everyone else.
export const PATCH = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const access = await authorise(user.id)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  const body: { id?: string; is_active?: boolean } = await req.json()

  if (!body.id || typeof body.is_active !== 'boolean') {
    return Response.json({ error: 'id and is_active are required' }, { status: 400 })
  }

  await fops.setMappingActive(db, body.id, access.tmcId, body.is_active)

  return Response.json({ ok: true })
})

export const DELETE = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const access = await authorise(user.id)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  const id = req.nextUrl.searchParams.get('id')
  if (!id) {
    return Response.json({ error: 'id is required' }, { status: 400 })
  }

  // Scoped by tmc_id in the delete itself rather than checked first, so there is
  // no window between the check and the write.
  await fops.unassign(db, id, access.tmcId)

  return Response.json({ ok: true })
})
