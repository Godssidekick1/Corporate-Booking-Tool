import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { parsePageParams, pagedResponse, ilikeAcross } from '@/app/lib/pagination'
import { NextRequest } from 'next/server'

// ── /api/tmc/buckets ─────────────────────────────────────────────────────────
// A bucket is a curated set of CLIENTS.
//
// Deliberately not the same thing as a client group. A client group is the org
// hierarchy a client belongs to — a fact about the client. A bucket is a
// distribution decision someone made on purpose ("Tier 1 corporates", "North
// India desk"), cuts across groups, and exists to be targeted by masters.
//
// Named generically because forms of payment and markup will target the same
// table. Building this as `deal_code_buckets` would mean an identical second
// concept within months.
// ─────────────────────────────────────────────────────────────────────────────

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

  const params = parsePageParams(req.nextUrl.searchParams)
  const ids = req.nextUrl.searchParams.get('ids')?.split(',').filter(Boolean) ?? []

  let query = service
    .from('buckets')
    .select('id, name, code, description, created_at', { count: 'exact' })
    .eq('tmc_id', auth.tmcId)
    .order('name')

  if (ids.length > 0) {
    query = query.in('id', ids)
  } else {
    const filter = ilikeAcross(['name', 'code'], params.search)
    if (filter) query = query.or(filter)
    query = query.range(params.from, params.to)
  }

  const { data: buckets, error, count } = await query

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  const bucketIds = (buckets ?? []).map(b => b.id)

  const [{ data: members }, { data: assignments }] = await Promise.all([
    bucketIds.length
      ? service.from('bucket_clients').select('bucket_id, client_id').in('bucket_id', bucketIds)
      : Promise.resolve({ data: [] }),
    bucketIds.length
      ? service.from('deal_code_assignments').select('bucket_id').in('bucket_id', bucketIds)
      : Promise.resolve({ data: [] }),
  ])

  const clientCount = new Map<string, number>()
  for (const m of members ?? []) {
    clientCount.set(m.bucket_id, (clientCount.get(m.bucket_id) ?? 0) + 1)
  }

  // How many deal codes point at this bucket. Shown so the consequence of
  // adding a client to it is legible before you do it.
  const dealCount = new Map<string, number>()
  for (const a of assignments ?? []) {
    if (!a.bucket_id) continue
    dealCount.set(a.bucket_id, (dealCount.get(a.bucket_id) ?? 0) + 1)
  }

  return Response.json(
    pagedResponse(
      (buckets ?? []).map(b => ({
        ...b,
        clientCount: clientCount.get(b.id) ?? 0,
        dealCodeCount: dealCount.get(b.id) ?? 0,
      })),
      count ?? null,
      params
    )
  )
}

interface CreateBody {
  name: string
  code?: string | null
  description?: string | null
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

  if (!body.name?.trim()) {
    return Response.json({ error: 'Bucket name is required' }, { status: 400 })
  }

  const { data: created, error } = await service
    .from('buckets')
    .insert({
      tmc_id: auth.tmcId,
      name: body.name.trim(),
      code: body.code?.trim().toUpperCase() || null,
      description: body.description?.trim() || null,
      created_by: user.id,
    })
    .select('id, name, code, description, created_at')
    .single()

  if (error) {
    if (error.code === '23505') {
      return Response.json({ error: 'A bucket with that name already exists' }, { status: 409 })
    }
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, bucket: { ...created, clientCount: 0, dealCodeCount: 0 } })
}
