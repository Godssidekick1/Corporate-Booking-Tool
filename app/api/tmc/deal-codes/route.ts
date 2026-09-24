import { createClient } from '@/utils/supabase/server'
import { db } from '@/app/lib/db'
import * as dealCodes from '@/app/lib/repositories/dealCodes'
import { route } from '@/app/lib/http/handler'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { validateFlightSpec } from '@/app/lib/deal-codes/flightSpec'
import { dealCodeStatus, type DealCodeStatus } from '@/app/lib/deal-codes/dealCodeStatus'
import { parsePageParams, paginateInMemory } from '@/app/lib/pagination'
import { validateAirlineCode } from '@/app/lib/reference/airlineCode'
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
    // A deal code MUST name an airline — unlike a form of payment, where blank
    // means "all airlines".
    if (!body.airline_code.trim()) {
      return 'A deal code has to name an airline'
    }
    const airlineError = validateAirlineCode(body.airline_code)
    if (airlineError) return airlineError
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

  const query_ = req.nextUrl.searchParams
  const params = parsePageParams(query_)
  const status = query_.get('status') as DealCodeStatus | null

  // Status cannot be filtered or paged in SQL — it is derived from `active` plus
  // two date windows, and reimplementing that rule as a SQL predicate would give
  // us two definitions of "expired" that drift. So the rows are enriched and
  // filtered here, then paged in memory.
  //
  // The cost is bounded by deals per TMC, which is hundreds at most: a TMC holds
  // one agreement per airline per type, not one per client. If that ever stops
  // being true, the fix is a stored status column maintained by a trigger.
  const [deals, categories, targetCount] = await Promise.all([
    dealCodes.listForTmc(db, auth.tmcId, {
      categoryId: query_.get('categoryId'),
      codeType: query_.get('type'),
      search: params.search,
    }),
    dealCodes.categoriesForTmc(db, auth.tmcId),
    // How many targets each deal reaches. Blast radius before someone edits
    // something shared, the same reason the policy groups screen shows a count.
    dealCodes.targetCounts(db, auth.tmcId),
  ])

  const categoryById = new Map(categories.map(c => [c.id, c]))

  const enriched = deals.map(d => ({
    ...d,
    categoryCode: categoryById.get(d.category_id)?.code ?? null,
    categoryLabel: categoryById.get(d.category_id)?.label ?? null,
    status: dealCodeStatus(d),
    targetCount: targetCount.get(d.id) ?? 0,
  }))

  const filtered = status ? enriched.filter(d => d.status === status) : enriched

  return Response.json(paginateInMemory(filtered, params))
})

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
  tmcId: string,
  categoryId: string
): Promise<{ code: string; allowedTypes: string[] } | null> {
  const category = await dealCodes.categoryOf(db, categoryId, tmcId)
  if (!category) return null
  const allowed = await dealCodes.allowedTypes(db, [category.id])
  return { code: category.code, allowedTypes: allowed.get(category.id) ?? [] }
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

  if (!body.category_id) {
    return Response.json({ error: 'Airline category is required' }, { status: 400 })
  }

  const category = await loadCategory(auth.tmcId, body.category_id)
  if (!category) {
    return Response.json({ error: 'Airline category not found for this TMC' }, { status: 404 })
  }

  const validationError = validateDealCode(body, category.allowedTypes, category.code)
  if (validationError) {
    return Response.json({ error: validationError }, { status: 400 })
  }

  const created = await dealCodes.insertDeal(db, {
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

  return Response.json({
    ok: true,
    dealCode: { ...created, status: dealCodeStatus(created), targetCount: 0 },
  })
})
