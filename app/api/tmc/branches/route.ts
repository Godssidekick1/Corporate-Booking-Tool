import { createClient } from '@/utils/supabase/server'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { parsePageParams, pagedResponse } from '@/app/lib/pagination'
import { NextRequest } from 'next/server'
import { db, transaction, isConstraint } from '@/app/lib/db'
import * as tmcs from '@/app/lib/repositories/tmcs'
import * as employees from '@/app/lib/repositories/employees'
import { route } from '@/app/lib/http/handler'

// ── /api/tmc/branches ────────────────────────────────────────────────────────
// The TMC's own offices. Paged and searched like every other list; `ids=`
// resolves specific rows so the branch picker on the Users screen can show the
// label of a selection that has fallen out of the current results.
//
// iata_number and office_id are recorded, never routed on: AMADEUS_CLIENT_CODE
// is one env var for the whole application.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_branches')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const params = parsePageParams(req.nextUrl.searchParams)
  const ids = req.nextUrl.searchParams.get('ids')?.split(',').filter(Boolean) ?? []

  const { rows, total } = await tmcs.branches(
    db,
    auth.tmcId,
    ids.length > 0 ? { ids } : { search: params.search, page: params }
  )

  // How many counsellors sit at each. Shown so the consequence of retiring a
  // branch is legible before anyone tries.
  const staffCount = await employees.staffCountsByBranch(db, rows.map(b => b.id))

  return Response.json(
    pagedResponse(
      rows.map(b => ({ ...b, staffCount: staffCount.get(b.id) ?? 0 })),
      total,
      params
    )
  )
})

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

type TextField = Exclude<keyof tmcs.BranchFields, 'name' | 'country' | 'is_head_office' | 'status'>

// Maps a body onto column values. Shared with PATCH so the two cannot normalise
// differently — a GST number uppercased on create but not on edit would produce
// two spellings of the same registration.
export function branchFields(body: BranchBody): tmcs.BranchFields {
  const fields: tmcs.BranchFields = {}

  const text = (key: TextField) => {
    if (body[key] !== undefined) fields[key] = body[key]?.trim() || null
  }
  const upper = (key: TextField) => {
    if (body[key] !== undefined) fields[key] = body[key]?.trim().toUpperCase() || null
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

// Any unique index on branches: (tmc_id, name), or (tmc_id, branch_no).
export const DUPLICATE_BRANCH = { error: 'A branch with that name or number already exists' }

export const POST = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_branches')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }
  const tmcId = auth.tmcId

  const body: BranchBody = await req.json()

  if (!body.name?.trim()) {
    return Response.json({ error: 'Branch name is required' }, { status: 400 })
  }
  if (body.status && !BRANCH_STATUSES.includes(body.status as typeof BRANCH_STATUSES[number])) {
    return Response.json({ error: `Invalid status: ${body.status}` }, { status: 400 })
  }

  try {
    const created = await transaction(async tx => {
      // Clearing the flag elsewhere BEFORE inserting, or the partial unique
      // index rejects the row. In the same transaction, so a rejected insert
      // does not leave the TMC with no head office at all.
      if (body.is_head_office) await tmcs.demoteHeadOffice(tx, tmcId)
      return tmcs.insertBranch(tx, tmcId, user.id, {
        ...branchFields(body),
        status: body.status ?? 'active',
      })
    }, { tenantId: tmcId, userId: user.id })

    return Response.json({ ok: true, branch: { ...created, staffCount: 0 } })
  } catch (err) {
    if (isConstraint(err, 'unique')) return Response.json(DUPLICATE_BRANCH, { status: 409 })
    throw err
  }
})
