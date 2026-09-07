import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { parsePageParams, pagedResponse, ilikeAcross } from '@/app/lib/pagination'
import { NextRequest } from 'next/server'

// ── /api/tmc/branches ────────────────────────────────────────────────────────
// The TMC's own offices. Paged and searched like every other list; `ids=`
// resolves specific rows so the branch picker on the Users screen can show the
// label of a selection that has fallen out of the current results.
//
// iata_number and office_id are recorded, never routed on: AMADEUS_CLIENT_CODE
// is one env var for the whole application.
// ─────────────────────────────────────────────────────────────────────────────

// One unbroken literal on purpose. Concatenating it widens the type from a
// string literal to `string`, and Supabase's client parses the select list at
// the type level — so a joined string silently degrades every row it returns to
// GenericStringError and every field access becomes an error.
export const BRANCH_COLUMNS = 'id, name, branch_no, profit_centre_code, gst_number, gst_name, gst_email, gst_contact, gst_address_1, gst_address_2, country, gst_state, gst_city, gst_zip, iata_number, office_id, is_head_office, status, created_at'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const auth = await requireTmcPermission(service, user.id, 'manage_branches')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const params = parsePageParams(req.nextUrl.searchParams)
  const ids = req.nextUrl.searchParams.get('ids')?.split(',').filter(Boolean) ?? []

  let query = service
    .from('branches')
    .select(BRANCH_COLUMNS, { count: 'exact' })
    .eq('tmc_id', auth.tmcId)
    // Head office first, then alphabetical: it is the one a desk looks for.
    .order('is_head_office', { ascending: false })
    .order('name')

  if (ids.length > 0) {
    query = query.in('id', ids)
  } else {
    const filter = ilikeAcross(['name', 'branch_no', 'gst_city', 'gst_state'], params.search)
    if (filter) query = query.or(filter)
    query = query.range(params.from, params.to)
  }

  const { data: branches, error, count } = await query

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  // How many counsellors sit at each. Shown so the consequence of retiring a
  // branch is legible before anyone tries.
  const branchIds = (branches ?? []).map(b => b.id)
  const staffCount = new Map<string, number>()

  if (branchIds.length > 0) {
    const { data: staff } = await service
      .from('employees')
      .select('branch_id')
      .in('branch_id', branchIds)

    for (const s of staff ?? []) {
      if (!s.branch_id) continue
      staffCount.set(s.branch_id, (staffCount.get(s.branch_id) ?? 0) + 1)
    }
  }

  return Response.json(
    pagedResponse(
      (branches ?? []).map(b => ({ ...b, staffCount: staffCount.get(b.id) ?? 0 })),
      count ?? null,
      params
    )
  )
}

export interface BranchBody {
  name?: string
  branch_no?: string | null
  profit_centre_code?: string | null
  gst_number?: string | null
  gst_name?: string | null
  gst_email?: string | null
  gst_contact?: string | null
  gst_address_1?: string | null
  gst_address_2?: string | null
  country?: string
  gst_state?: string | null
  gst_city?: string | null
  gst_zip?: string | null
  iata_number?: string | null
  office_id?: string | null
  is_head_office?: boolean
  status?: string
}

export const BRANCH_STATUSES = ['active', 'inactive'] as const

// Maps a body onto column values. Shared with PATCH so the two cannot normalise
// differently — a GST number uppercased on create but not on edit would produce
// two spellings of the same registration.
export function branchFields(body: BranchBody): Record<string, unknown> {
  const fields: Record<string, unknown> = {}

  const text = (key: keyof BranchBody, column = key as string) => {
    if (body[key] !== undefined) fields[column] = (body[key] as string | null)?.trim() || null
  }
  const upper = (key: keyof BranchBody, column = key as string) => {
    if (body[key] !== undefined) fields[column] = (body[key] as string | null)?.trim().toUpperCase() || null
  }

  if (body.name !== undefined) fields.name = body.name.trim()
  if (body.country !== undefined) fields.country = body.country.trim() || 'India'
  if (body.is_head_office !== undefined) fields.is_head_office = body.is_head_office

  // Uppercased because these are canonically uppercase and a lowercase copy
  // would not match anything searched for later.
  upper('branch_no')
  upper('gst_number')
  upper('iata_number')
  upper('office_id')

  text('profit_centre_code')
  text('gst_name')
  text('gst_email')
  text('gst_contact')
  text('gst_address_1')
  text('gst_address_2')
  text('gst_state')
  text('gst_city')
  text('gst_zip')

  return fields
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const auth = await requireTmcPermission(service, user.id, 'manage_branches')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const body: BranchBody = await req.json()

  if (!body.name?.trim()) {
    return Response.json({ error: 'Branch name is required' }, { status: 400 })
  }
  if (body.status && !BRANCH_STATUSES.includes(body.status as typeof BRANCH_STATUSES[number])) {
    return Response.json({ error: `Invalid status: ${body.status}` }, { status: 400 })
  }

  // Clearing the flag elsewhere BEFORE inserting, or the partial unique index
  // rejects the row and the admin gets a constraint error instead of a branch.
  if (body.is_head_office) {
    await service
      .from('branches')
      .update({ is_head_office: false })
      .eq('tmc_id', auth.tmcId)
      .eq('is_head_office', true)
  }

  const { data: created, error } = await service
    .from('branches')
    .insert({
      ...branchFields(body),
      tmc_id: auth.tmcId,
      status: body.status ?? 'active',
      created_by: user.id,
    })
    .select(BRANCH_COLUMNS)
    .single()

  if (error) {
    if (error.code === '23505') {
      return Response.json(
        { error: 'A branch with that name or number already exists' },
        { status: 409 }
      )
    }
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, branch: { ...created, staffCount: 0 } })
}
