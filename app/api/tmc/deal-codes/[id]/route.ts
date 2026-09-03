import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { dealCodeStatus } from '@/app/lib/deal-codes/dealCodeStatus'
import { DEAL_CODE_COLUMNS, loadCategory, validateDealCode } from '../route'
import { NextRequest } from 'next/server'

// ── /api/tmc/deal-codes/[id] ─────────────────────────────────────────────────
// GET     one deal with its assignments resolved to names
// PATCH   edit it
// DELETE  refused while anything is assigned to it
// ─────────────────────────────────────────────────────────────────────────────

async function authorise(userId: string, id: string) {
  const service = createServiceClient()
  const auth = await requireTmcPermission(service, userId, 'manage_deal_codes')

  if (!auth.authorized || !auth.tmcId) {
    return { ok: false as const, service, error: auth.error ?? 'Forbidden', status: auth.status ?? 403 }
  }

  const { data: deal } = await service
    .from('deal_codes')
    .select('id, tmc_id, code')
    .eq('id', id)
    .eq('tmc_id', auth.tmcId)
    .maybeSingle()

  if (!deal) {
    return { ok: false as const, service, error: 'Deal code not found', status: 404 }
  }

  return { ok: true as const, service, tmcId: auth.tmcId, deal }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const check = await authorise(user.id, id)
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  const { service } = check

  const { data: deal } = await service
    .from('deal_codes')
    .select(DEAL_CODE_COLUMNS)
    .eq('id', id)
    .single()

  const { data: assignments } = await service
    .from('deal_code_assignments')
    .select('id, kind, client_id, client_group_id, bucket_id')
    .eq('deal_code_id', id)

  // Names resolved in three small queries rather than a PostgREST embed: this
  // codebase does not rely on embed-alias inference anywhere, and three lookups
  // over a handful of ids is not the bottleneck.
  const clientIds = (assignments ?? []).map(a => a.client_id).filter(Boolean) as string[]
  const groupIds = (assignments ?? []).map(a => a.client_group_id).filter(Boolean) as string[]
  const bucketIds = (assignments ?? []).map(a => a.bucket_id).filter(Boolean) as string[]

  const [{ data: clients }, { data: groups }, { data: buckets }] = await Promise.all([
    clientIds.length
      ? service.from('clients').select('id, name').in('id', clientIds)
      : Promise.resolve({ data: [] }),
    groupIds.length
      ? service.from('client_groups').select('id, name').in('id', groupIds)
      : Promise.resolve({ data: [] }),
    bucketIds.length
      ? service.from('buckets').select('id, name').in('id', bucketIds)
      : Promise.resolve({ data: [] }),
  ])

  const nameOf = new Map<string, string>([
    ...(clients ?? []).map(c => [c.id, c.name] as [string, string]),
    ...(groups ?? []).map(g => [g.id, g.name] as [string, string]),
    ...(buckets ?? []).map(b => [b.id, b.name] as [string, string]),
  ])

  return Response.json({
    ok: true,
    dealCode: { ...deal, status: dealCodeStatus(deal!) },
    assignments: (assignments ?? []).map(a => {
      const targetId = a.client_id ?? a.client_group_id ?? a.bucket_id!
      return { id: a.id, kind: a.kind, targetId, targetName: nameOf.get(targetId) ?? 'Unknown' }
    }),
  })
}

interface UpdateBody {
  category_id?: string
  airline_code?: string
  code?: string
  code_type?: string
  flight_spec?: string | null
  sales_from?: string | null
  sales_to?: string | null
  travel_from?: string | null
  travel_to?: string | null
  active?: boolean
  notes?: string | null
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const check = await authorise(user.id, id)
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  const { service, tmcId } = check
  const body: UpdateBody = await req.json()

  // Validate against whichever category and airline will END UP stored, not
  // just the fields that happened to arrive. Changing category alone can make
  // an existing code type invalid, and changing airline alone can invalidate an
  // existing flight spec.
  const { data: current } = await service
    .from('deal_codes')
    .select('category_id, airline_code, code_type, flight_spec')
    .eq('id', id)
    .single()

  const effectiveCategoryId = body.category_id ?? current!.category_id
  const category = await loadCategory(service, tmcId, effectiveCategoryId)
  if (!category) {
    return Response.json({ error: 'Airline category not found for this TMC' }, { status: 404 })
  }

  const validationError = validateDealCode(
    {
      ...body,
      airline_code: body.airline_code ?? current!.airline_code,
      code_type: body.code_type ?? current!.code_type,
      flight_spec: body.flight_spec !== undefined ? body.flight_spec : current!.flight_spec,
    },
    category.allowedTypes,
    category.code
  )
  if (validationError) {
    return Response.json({ error: validationError }, { status: 400 })
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }

  if (body.category_id !== undefined) update.category_id = body.category_id
  if (body.airline_code !== undefined) update.airline_code = body.airline_code.trim().toUpperCase()
  if (body.code !== undefined) update.code = body.code.trim().toUpperCase()
  if (body.code_type !== undefined) update.code_type = body.code_type
  if (body.flight_spec !== undefined) update.flight_spec = body.flight_spec?.trim() || null
  if (body.sales_from !== undefined) update.sales_from = body.sales_from || null
  if (body.sales_to !== undefined) update.sales_to = body.sales_to || null
  if (body.travel_from !== undefined) update.travel_from = body.travel_from || null
  if (body.travel_to !== undefined) update.travel_to = body.travel_to || null
  if (body.active !== undefined) update.active = body.active
  if (body.notes !== undefined) update.notes = body.notes?.trim() || null

  const { data: updated, error } = await service
    .from('deal_codes')
    .update(update)
    .eq('id', id)
    .select(DEAL_CODE_COLUMNS)
    .single()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, dealCode: { ...updated, status: dealCodeStatus(updated) } })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const check = await authorise(user.id, id)
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  const { service, deal } = check

  // The FK cascades, so deleting would silently remove every assignment with
  // it. Refused instead: unassigning is a decision someone should make
  // deliberately, and a negotiated code that quietly stops applying to forty
  // clients is not a failure anyone notices until a fare comes back wrong.
  const { count } = await service
    .from('deal_code_assignments')
    .select('id', { count: 'exact', head: true })
    .eq('deal_code_id', id)

  if (count && count > 0) {
    return Response.json(
      {
        error: `"${deal.code}" is assigned to ${count} target${count > 1 ? 's' : ''}. Remove the assignments before deleting, or set it inactive to stop it applying.`,
      },
      { status: 409 }
    )
  }

  const { error } = await service.from('deal_codes').delete().eq('id', id)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}
