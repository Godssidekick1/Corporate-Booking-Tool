import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'

// ── /api/tmc/fop-assignments ─────────────────────────────────────────────────
// Who a form of payment applies to.
//
// Mirrors deal-code-assignments, with one meaning inverted: a form of payment
// with NO row here is the DEFAULT for its scope, not dormant. An unassigned
// deal code reaching nobody is safe; a booking that resolves to no payment
// method at all tells the counsellor nothing.
//
// POST takes an ARRAY of targets so assigning twelve clients is one request.
// ─────────────────────────────────────────────────────────────────────────────

const KINDS = ['client', 'client_group', 'bucket'] as const
type Kind = typeof KINDS[number]

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
  const auth = await requireTmcPermission(service, user.id, 'manage_fops')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const fopId = req.nextUrl.searchParams.get('fopId')

  let query = service
    .from('fop_assignments')
    .select('id, fop_id, kind, client_id, client_group_id, bucket_id, created_at')
    .eq('tmc_id', auth.tmcId)

  if (fopId) query = query.eq('fop_id', fopId)

  const { data: assignments, error } = await query

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, assignments: assignments ?? [] })
}

interface CreateBody {
  fopId: string
  targets: { kind: Kind; id: string }[]
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const auth = await requireTmcPermission(service, user.id, 'manage_fops')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const body: CreateBody = await req.json()

  if (!body.fopId || !Array.isArray(body.targets) || body.targets.length === 0) {
    return Response.json({ error: 'fopId and at least one target are required' }, { status: 400 })
  }

  const { data: fop } = await service
    .from('forms_of_payment')
    .select('id')
    .eq('id', body.fopId)
    .eq('tmc_id', auth.tmcId)
    .maybeSingle()

  if (!fop) {
    return Response.json({ error: 'Form of payment not found' }, { status: 404 })
  }

  // Every target verified against this TMC before anything is written. These are
  // plain FKs, so an id borrowed from another tenant would satisfy the
  // constraint and quietly point another TMC's client at this card.
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
      fop_id: body.fopId,
      kind: target.kind,
      [TARGET_COLUMN[target.kind]]: target.id,
      created_by: user.id,
    })
  }

  // Re-assigning something already assigned is a no-op, not an error: the UI
  // sends the full selection and the partial unique indexes make the duplicate
  // harmless.
  const { error } = await service.from('fop_assignments').upsert(rows, { ignoreDuplicates: true })

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
  const auth = await requireTmcPermission(service, user.id, 'manage_fops')
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
    .from('fop_assignments')
    .delete()
    .eq('id', id)
    .eq('tmc_id', auth.tmcId)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}
