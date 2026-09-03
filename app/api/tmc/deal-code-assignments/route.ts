import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'

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

// Which table backs each kind, so validating a target is one lookup rather than
// three branches repeated at every call site.
const TARGET_TABLE: Record<Kind, string> = {
  client: 'clients',
  client_group: 'client_groups',
  bucket: 'buckets',
}

const TARGET_COLUMN: Record<Kind, string> = {
  client: 'client_id',
  client_group: 'client_group_id',
  bucket: 'bucket_id',
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const auth = await requireTmcPermission(service, user.id, 'manage_deal_codes')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const dealCodeId = req.nextUrl.searchParams.get('dealCodeId')

  let query = service
    .from('deal_code_assignments')
    .select('id, deal_code_id, kind, client_id, client_group_id, bucket_id, created_at')
    .eq('tmc_id', auth.tmcId)

  if (dealCodeId) query = query.eq('deal_code_id', dealCodeId)

  const { data: assignments, error } = await query

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, assignments: assignments ?? [] })
}

interface CreateBody {
  dealCodeId: string
  targets: { kind: Kind; id: string }[]
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const auth = await requireTmcPermission(service, user.id, 'manage_deal_codes')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const body: CreateBody = await req.json()

  if (!body.dealCodeId || !Array.isArray(body.targets) || body.targets.length === 0) {
    return Response.json({ error: 'dealCodeId and at least one target are required' }, { status: 400 })
  }

  const { data: deal } = await service
    .from('deal_codes')
    .select('id')
    .eq('id', body.dealCodeId)
    .eq('tmc_id', auth.tmcId)
    .maybeSingle()

  if (!deal) {
    return Response.json({ error: 'Deal code not found' }, { status: 404 })
  }

  // Every target is verified to belong to this TMC before anything is written.
  // These are plain FKs, so an id borrowed from another tenant would satisfy the
  // constraint and quietly hand another TMC's client a negotiated fare.
  const rows: Record<string, unknown>[] = []

  for (const target of body.targets) {
    if (!KINDS.includes(target.kind)) {
      return Response.json({ error: `Unknown target kind: ${target.kind}` }, { status: 400 })
    }

    const { data: found } = await service
      .from(TARGET_TABLE[target.kind])
      .select('id')
      .eq('id', target.id)
      .eq('tmc_id', auth.tmcId)
      .maybeSingle()

    if (!found) {
      return Response.json(
        { error: `That ${target.kind.replace('_', ' ')} does not belong to your TMC` },
        { status: 422 }
      )
    }

    rows.push({
      tmc_id: auth.tmcId,
      deal_code_id: body.dealCodeId,
      kind: target.kind,
      [TARGET_COLUMN[target.kind]]: target.id,
      created_by: user.id,
    })
  }

  // Re-assigning something already assigned is a no-op, not an error: the UI
  // sends the full selection, and the partial unique indexes make the duplicate
  // harmless. ignoreDuplicates keeps the rest of the batch from failing with it.
  const { error } = await service
    .from('deal_code_assignments')
    .upsert(rows, { ignoreDuplicates: true })

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, assigned: rows.length })
}

export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const auth = await requireTmcPermission(service, user.id, 'manage_deal_codes')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const id = req.nextUrl.searchParams.get('id')
  if (!id) {
    return Response.json({ error: 'id is required' }, { status: 400 })
  }

  // Scoped by tmc_id in the delete itself rather than checked first, so there is
  // no window between the check and the write.
  const { error } = await service
    .from('deal_code_assignments')
    .delete()
    .eq('id', id)
    .eq('tmc_id', auth.tmcId)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}
