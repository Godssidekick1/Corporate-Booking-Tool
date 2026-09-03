import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { validateFlightSpec } from '@/app/lib/deal-codes/flightSpec'
import { dealCodeStatus, type DealCodeStatus } from '@/app/lib/deal-codes/dealCodeStatus'
import { parsePageParams, paginateInMemory, escapeFilterValue } from '@/app/lib/pagination'
import { NextRequest } from 'next/server'

// ── GET /api/tmc/deal-codes ──────────────────────────────────────────────────
// The TMC's negotiated codes. Filters: search, category, type, status.
//
// Status is DERIVED, never stored — a deal can be `active` and long expired, and
// the screen this replaces shows exactly that as a live checkbox. Because it is
// derived from two date windows it cannot be filtered in SQL without
// reimplementing the rule in a second language, so the status filter is applied
// in memory against the same function the UI renders from. Deal counts per TMC
// are in the hundreds, not millions.
//
// ── POST /api/tmc/deal-codes ─────────────────────────────────────────────────
// Creates one. Validates the code type against the category's matrix, since a
// tour code filed on LCC content has no field to live in.
// ─────────────────────────────────────────────────────────────────────────────

export const CODE_TYPES = ['TC', 'PF', 'DC', 'TR', 'PC'] as const
export type CodeType = typeof CODE_TYPES[number]

// The canonical names. Every screen reads these rather than spelling its own,
// which is how the comps ended up calling TC a "Ticket Code" on one screen and
// DC a "Discount Code" on another.
export const CODE_TYPE_LABELS: Record<CodeType, string> = {
  TC: 'Tour code',
  PF: 'Private fare',
  DC: 'Deal code',
  TR: 'Tracking code',
  PC: 'Promotion code',
}

export interface DealCodeRow {
  id: string
  category_id: string
  airline_code: string
  code: string
  code_type: string
  flight_spec: string | null
  sales_from: string | null
  sales_to: string | null
  travel_from: string | null
  travel_to: string | null
  active: boolean
  notes: string | null
  created_at: string
}

export const DEAL_CODE_COLUMNS =
  'id, category_id, airline_code, code, code_type, flight_spec, sales_from, sales_to, travel_from, travel_to, active, notes, created_by, created_at'

// ── validateDealCode ─────────────────────────────────────────────────────────
// Shared by POST here and PATCH in [id]. Returns an error string or null.
// `allowedTypes` is null when the caller could not resolve the category, which
// is itself an error the caller reports.
// ─────────────────────────────────────────────────────────────────────────────
export function validateDealCode(
  body: {
    airline_code?: string
    code?: string
    code_type?: string
    flight_spec?: string | null
    sales_from?: string | null
    sales_to?: string | null
    travel_from?: string | null
    travel_to?: string | null
  },
  allowedTypes: string[],
  categoryCode: string
): string | null {
  if (body.airline_code !== undefined) {
    const airline = body.airline_code.trim().toUpperCase()
    if (!/^[A-Z0-9]{2}$/.test(airline)) {
      return `"${body.airline_code}" is not a two-character airline code`
    }
  }

  if (body.code !== undefined && !body.code.trim()) {
    return 'Code cannot be empty'
  }

  if (body.code_type !== undefined) {
    if (!CODE_TYPES.includes(body.code_type as CodeType)) {
      return `Unknown code type: ${body.code_type}`
    }
    if (!allowedTypes.includes(body.code_type)) {
      const label = CODE_TYPE_LABELS[body.code_type as CodeType]
      return `${label} is not available for ${categoryCode} content`
    }
  }

  if (body.flight_spec !== undefined && body.airline_code) {
    const flightError = validateFlightSpec(body.flight_spec, body.airline_code)
    if (flightError) return flightError
  }

  // Checked here as well as by the DB constraint so the message names the field
  // rather than surfacing a raw constraint violation as a 500.
  if (body.sales_from && body.sales_to && body.sales_from > body.sales_to) {
    return 'Sales to is before sales from'
  }
  if (body.travel_from && body.travel_to && body.travel_from > body.travel_to) {
    return 'Travel to is before travel from'
  }

  return null
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

  const query_ = req.nextUrl.searchParams
  const params = parsePageParams(query_)
  const categoryId = query_.get('categoryId')
  const codeType = query_.get('type')
  const status = query_.get('status') as DealCodeStatus | null

  let query = service
    .from('deal_codes')
    .select(DEAL_CODE_COLUMNS)
    .eq('tmc_id', auth.tmcId)
    .order('airline_code')
    .order('code')

  if (categoryId) query = query.eq('category_id', categoryId)
  if (codeType) query = query.eq('code_type', codeType)

  if (params.search) {
    // Escaped before interpolation: PostgREST parses this string, and a comma
    // or parenthesis in the search box would otherwise change the filter's
    // structure rather than being matched literally.
    const safe = escapeFilterValue(params.search)
    if (safe) query = query.or(`code.ilike.%${safe}%,airline_code.ilike.%${safe}%`)
  }

  const { data: deals, error } = await query

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  // Status cannot be filtered or paged in SQL — it is derived from `active` plus
  // two date windows, and reimplementing that rule as a SQL predicate would give
  // us two definitions of "expired" that drift. So the rows are enriched and
  // filtered here, then paged in memory.
  //
  // The cost is bounded by deals per TMC, which is hundreds at most: a TMC holds
  // one agreement per airline per type, not one per client. If that ever stops
  // being true, the fix is a stored status column maintained by a trigger.

  const [{ data: categories }, { data: assignments }] = await Promise.all([
    service.from('deal_code_categories').select('id, code, label').eq('tmc_id', auth.tmcId),
    service.from('deal_code_assignments').select('deal_code_id, kind').eq('tmc_id', auth.tmcId),
  ])

  const categoryById = new Map((categories ?? []).map(c => [c.id, c]))

  // How many targets each deal reaches. Blast radius before someone edits
  // something shared, the same reason the policy groups screen shows a count.
  const targetCount = new Map<string, number>()
  for (const a of assignments ?? []) {
    targetCount.set(a.deal_code_id, (targetCount.get(a.deal_code_id) ?? 0) + 1)
  }

  const enriched = (deals ?? []).map(d => ({
    ...d,
    categoryCode: categoryById.get(d.category_id)?.code ?? null,
    categoryLabel: categoryById.get(d.category_id)?.label ?? null,
    status: dealCodeStatus(d),
    targetCount: targetCount.get(d.id) ?? 0,
  }))

  const filtered = status ? enriched.filter(d => d.status === status) : enriched

  return Response.json(paginateInMemory(filtered, params))
}

interface CreateBody {
  category_id: string
  airline_code: string
  code: string
  code_type: string
  flight_spec?: string | null
  sales_from?: string | null
  sales_to?: string | null
  travel_from?: string | null
  travel_to?: string | null
  active?: boolean
  notes?: string | null
}

// Resolves a category and the types it permits, scoped to the caller's TMC so a
// category id from another tenant cannot be borrowed.
export async function loadCategory(
  service: ReturnType<typeof createServiceClient>,
  tmcId: string,
  categoryId: string
): Promise<{ code: string; allowedTypes: string[] } | null> {
  const { data: category } = await service
    .from('deal_code_categories')
    .select('id, code')
    .eq('id', categoryId)
    .eq('tmc_id', tmcId)
    .maybeSingle()

  if (!category) return null

  const { data: types } = await service
    .from('deal_code_category_types')
    .select('code_type, allowed')
    .eq('category_id', category.id)

  return {
    code: category.code,
    allowedTypes: (types ?? []).filter(t => t.allowed).map(t => t.code_type),
  }
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

  if (!body.category_id) {
    return Response.json({ error: 'Airline category is required' }, { status: 400 })
  }

  const category = await loadCategory(service, auth.tmcId, body.category_id)
  if (!category) {
    return Response.json({ error: 'Airline category not found for this TMC' }, { status: 404 })
  }

  const validationError = validateDealCode(body, category.allowedTypes, category.code)
  if (validationError) {
    return Response.json({ error: validationError }, { status: 400 })
  }

  const { data: created, error } = await service
    .from('deal_codes')
    .insert({
      tmc_id: auth.tmcId,
      category_id: body.category_id,
      airline_code: body.airline_code.trim().toUpperCase(),
      // Uppercased because negotiated codes are canonically uppercase and a
      // lowercase copy would not match anything searched for later.
      code: body.code.trim().toUpperCase(),
      code_type: body.code_type,
      flight_spec: body.flight_spec?.trim() || null,
      sales_from: body.sales_from || null,
      sales_to: body.sales_to || null,
      travel_from: body.travel_from || null,
      travel_to: body.travel_to || null,
      active: body.active ?? true,
      notes: body.notes?.trim() || null,
      created_by: user.id,
    })
    .select(DEAL_CODE_COLUMNS)
    .single()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({
    ok: true,
    dealCode: { ...created, status: dealCodeStatus(created), targetCount: 0 },
  })
}
