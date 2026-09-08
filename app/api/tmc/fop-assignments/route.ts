import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { parsePageParams, pagedResponse, ilikeAcross, escapeFilterValue } from '@/app/lib/pagination'
import { NextRequest } from 'next/server'

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
// by opening forms of payment one at a time.
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
  const params = parsePageParams(req.nextUrl.searchParams)

  let query = service
    .from('fop_assignments')
    .select(
      'id, fop_id, kind, client_id, client_group_id, bucket_id, is_active, created_at, created_by',
      { count: 'exact' }
    )
    .eq('tmc_id', auth.tmcId)
    .order('created_at', { ascending: false })

  if (fopId) query = query.eq('fop_id', fopId)

  // SEARCH SPANS TWO SIDES OF A JOIN, WHICH POSTGREST CANNOT OR TOGETHER.
  //
  // A mapping is "FOP → target", and someone typing "CBTGROUP" could mean
  // either half. PostgREST's .or() works on ONE resource: a filter on the
  // embedded form of payment is ANDed with the parent's conditions, never
  // ORed. And the target itself lives in whichever of three tables the `kind`
  // says, so there is no single column to match on at all.
  //
  // So the search is resolved to IDS first — the forms of payment whose code or
  // description matches, and the clients, buckets and groups whose name does —
  // and those become one parent-level .or() over four id columns.
  if (params.search) {
    const safe = escapeFilterValue(params.search)
    if (!safe) {
      return Response.json(pagedResponse([], 0, params))
    }

    const [fops, clients, groups, buckets] = await Promise.all([
      service.from('forms_of_payment').select('id')
        .eq('tmc_id', auth.tmcId).or(ilikeAcross(['fop_code', 'label'], safe)!),
      service.from('clients').select('id').eq('tmc_id', auth.tmcId).ilike('name', `%${safe}%`),
      service.from('client_groups').select('id').eq('tmc_id', auth.tmcId).ilike('name', `%${safe}%`),
      service.from('buckets').select('id').eq('tmc_id', auth.tmcId).ilike('name', `%${safe}%`),
    ])

    const clauses: string[] = []
    const add = (column: string, rows: { id: string }[] | null) => {
      if (rows && rows.length) clauses.push(`${column}.in.(${rows.map(r => r.id).join(',')})`)
    }
    add('fop_id', fops.data)
    add('client_id', clients.data)
    add('client_group_id', groups.data)
    add('bucket_id', buckets.data)

    // Nothing anywhere matched the term. Returning an empty page directly rather
    // than building an `in.()` with no values, which PostgREST rejects outright.
    if (clauses.length === 0) {
      return Response.json(pagedResponse([], 0, params))
    }

    query = query.or(clauses.join(','))
  }

  const { data: assignments, error, count } = await query.range(params.from, params.to)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  const rows = assignments ?? []

  // Names resolved only for the rows on THIS page — four small `in` lookups
  // rather than joining every client at the TMC to label ten of them.
  const idsOf = (column: 'client_id' | 'client_group_id' | 'bucket_id') =>
    [...new Set(rows.map(r => r[column]).filter(Boolean) as string[])]

  const fopIds = [...new Set(rows.map(r => r.fop_id))]
  const authorIds = [...new Set(rows.map(r => r.created_by).filter(Boolean) as string[])]

  const pick = <T,>(ids: string[], run: () => PromiseLike<{ data: T[] | null }>) =>
    ids.length ? run() : Promise.resolve({ data: [] as T[] })

  const [fopRows, clientRows, groupRows, bucketRows, authorRows] = await Promise.all([
    pick(fopIds, () => service.from('forms_of_payment').select('id, fop_code, label').in('id', fopIds)),
    pick(idsOf('client_id'), () => service.from('clients').select('id, name').in('id', idsOf('client_id'))),
    pick(idsOf('client_group_id'), () => service.from('client_groups').select('id, name').in('id', idsOf('client_group_id'))),
    pick(idsOf('bucket_id'), () => service.from('buckets').select('id, name').in('id', idsOf('bucket_id'))),
    pick(authorIds, () => service.from('employees').select('id, full_name').in('id', authorIds)),
  ])

  const fopById = new Map((fopRows.data ?? []).map(f => [f.id, f]))
  const targetName = new Map<string, string>([
    ...(clientRows.data ?? []).map(c => [c.id, c.name] as [string, string]),
    ...(groupRows.data ?? []).map(g => [g.id, g.name] as [string, string]),
    ...(bucketRows.data ?? []).map(b => [b.id, b.name] as [string, string]),
  ])
  const authorName = new Map((authorRows.data ?? []).map(e => [e.id, e.full_name]))

  const items = rows.map(r => {
    const targetId = r.client_id ?? r.client_group_id ?? r.bucket_id!
    const fop = fopById.get(r.fop_id)
    return {
      id: r.id,
      fop_id: r.fop_id,
      fop_code: fop?.fop_code ?? null,
      fop_label: fop?.label ?? 'Unknown',
      kind: r.kind as Kind,
      target_id: targetId,
      // A target whose row is gone reads as Unknown rather than blank — a
      // mapping pointing at nothing is a thing an admin needs to see and remove.
      target_name: targetName.get(targetId) ?? 'Unknown',
      is_active: r.is_active,
      created_at: r.created_at,
      created_by_name: r.created_by ? authorName.get(r.created_by) ?? null : null,
    }
  })

  return Response.json(pagedResponse(items, count ?? null, params))
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

// Switch one mapping off without deleting it — the old screen's Is Active
// column. Separate from the form of payment's own active flag: this takes ONE
// client off it while it keeps working for everyone else.
export async function PATCH(req: NextRequest) {
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

  const body: { id?: string; is_active?: boolean } = await req.json()

  if (!body.id || typeof body.is_active !== 'boolean') {
    return Response.json({ error: 'id and is_active are required' }, { status: 400 })
  }

  const { error } = await service
    .from('fop_assignments')
    .update({ is_active: body.is_active })
    .eq('id', body.id)
    .eq('tmc_id', auth.tmcId)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
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
