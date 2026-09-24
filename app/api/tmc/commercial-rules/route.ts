import { createClient } from '@/utils/supabase/server'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { parsePageParams, paginateInMemory } from '@/app/lib/pagination'
import { commercialStatus, type CommercialStatus } from '@/app/lib/commercials/commercialStatus'
import { validateRbdSpec } from '@/app/lib/fop/rbdSpec'
import { validateAirlineCode } from '@/app/lib/reference/airlineCode'
import {
  isCommercialKind, isCalcOnAllowed,
  CALC_TYPES, FARE_TYPES, CABINS, CALC_BASES,
  KIND_LABELS, CALC_ON_LABELS,
  type CommercialKind, type CalcOn,
} from '@/app/lib/commercials/calcOnByKind'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'
import * as commercials from '@/app/lib/repositories/commercials'
import * as dealCodes from '@/app/lib/repositories/dealCodes'
import { route } from '@/app/lib/http/handler'

// ── /api/tmc/commercial-rules ────────────────────────────────────────────────
// Markup, discount and processing fee. One table, one route, `?kind=` to
// narrow — the three screens are the same screen.
//
// Gated on `manage_commercials` rather than on manage_deal_codes or manage_fops.
// Those decide which negotiated codes and payment methods a client GETS and
// neither changes a number; this one sets what a client is CHARGED, which is a
// different thing to trust somebody with.
// ─────────────────────────────────────────────────────────────────────────────

// The rule row is commercials.RuleRecord, typed from the schema.

export interface RuleBody {
  kind?: string
  category_id?: string
  airline_code?: string | null
  cabin?: string | null
  rbd_spec?: string | null
  fare_type?: string
  calc_type?: string
  calc_on?: string
  rate?: number
  calc_basis?: string | null
  exclude_tax_codes?: string[] | null
  include_ssr?: boolean | null
  valid_from?: string | null
  valid_to?: string | null
  active?: boolean
  notes?: string | null
}

// ── validateRule ─────────────────────────────────────────────────────────────
// Shared by POST here and PATCH in [id]. Returns an error string or null.
//
// Every rule below is ALSO enforced by the database, either by a CHECK or by
// commercial_rules_fee_fields_match_kind. Repeated here so a bad payload comes
// back as a sentence naming the field rather than as a 500 quoting a constraint
// nobody outside the migration has heard of.
// ─────────────────────────────────────────────────────────────────────────────
export function validateRule(kind: CommercialKind, body: RuleBody): string | null {
  if (body.airline_code) {
    // Blank is valid and means "every airline" — unlike a deal code, which must
    // name one.
    const airlineError = validateAirlineCode(body.airline_code)
    if (airlineError) return airlineError
  }

  if (body.cabin && !(CABINS as readonly string[]).includes(body.cabin)) {
    return `Unknown cabin: ${body.cabin}`
  }

  if (body.rbd_spec) {
    const rbdError = validateRbdSpec(body.rbd_spec)
    if (rbdError) return rbdError
  }

  if (body.fare_type !== undefined && !(FARE_TYPES as readonly string[]).includes(body.fare_type)) {
    return `Unknown fare type: ${body.fare_type}`
  }

  if (body.calc_type !== undefined && !(CALC_TYPES as readonly string[]).includes(body.calc_type)) {
    return `Unknown calculation type: ${body.calc_type}`
  }

  if (body.calc_on !== undefined) {
    if (!isCalcOnAllowed(kind, body.calc_on)) {
      const label = CALC_ON_LABELS[body.calc_on as CalcOn] ?? body.calc_on
      return `${label} is not a basis a ${KIND_LABELS[kind].toLowerCase()} can be calculated on`
    }
  }

  if (body.rate !== undefined) {
    if (!Number.isFinite(body.rate) || body.rate < 0) {
      return 'Rate has to be a number and cannot be negative'
    }
    // A percentage over 100 is almost always a fixed amount typed into the wrong
    // field, and at these stakes guessing wrong costs real money either way.
    if (body.calc_type === 'percent' && body.rate > 100) {
      return 'A percentage over 100 — did you mean a fixed amount?'
    }
  }

  // The fee-only fields, matching commercial_rules_fee_fields_match_kind.
  if (kind === 'processing_fee') {
    if (body.calc_basis !== undefined && body.calc_basis !== null &&
        !(CALC_BASES as readonly string[]).includes(body.calc_basis)) {
      return `Unknown calculation basis: ${body.calc_basis}`
    }
  } else if (body.calc_basis || body.exclude_tax_codes || body.include_ssr) {
    return `Calculation basis, excluded taxes and SSR only apply to a processing fee`
  }

  if (body.valid_from && body.valid_to && body.valid_from > body.valid_to) {
    return 'Valid to is before valid from'
  }

  return null
}

export const GET = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_commercials')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const query = req.nextUrl.searchParams
  const params = parsePageParams(query)
  const status = query.get('status') as CommercialStatus | null

  // Status is derived from `active` plus a date window, so it cannot be filtered
  // or paged in SQL without writing that rule a second time as a predicate and
  // having the two drift. Enriched and filtered here, then paged in memory —
  // the same trade the deal code master makes, bounded by rules per TMC.
  const [rules, categories, targetCount] = await Promise.all([
    commercials.listRules(db, auth.tmcId, {
      kind: query.get('kind'),
      categoryId: query.get('categoryId'),
      search: params.search,
    }),
    dealCodes.categoriesForTmc(db, auth.tmcId),
    // How many targets each rule reaches — blast radius before somebody edits
    // something shared.
    commercials.targetCounts(db, auth.tmcId),
  ])

  const categoryById = new Map(categories.map(c => [c.id, c]))

  const enriched = rules.map(r => ({
    ...r,
    categoryCode: categoryById.get(r.category_id)?.code ?? null,
    categoryLabel: categoryById.get(r.category_id)?.label ?? null,
    status: commercialStatus(r),
    targetCount: targetCount.get(r.id) ?? 0,
  }))

  const filtered = status ? enriched.filter(r => r.status === status) : enriched

  return Response.json(paginateInMemory(filtered, params))
})

export const POST = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_commercials')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const body: RuleBody = await req.json()

  if (!body.kind || !isCommercialKind(body.kind)) {
    return Response.json({ error: 'kind must be markup, discount or processing_fee' }, { status: 400 })
  }
  if (!body.category_id) {
    return Response.json({ error: 'A category is required' }, { status: 400 })
  }
  if (body.rate === undefined) {
    return Response.json({ error: 'A rate is required' }, { status: 400 })
  }

  // The category must belong to this TMC, so an id from another tenant cannot be
  // borrowed — the same check loadCategory makes for deal codes.
  if (!(await dealCodes.categoryInTmc(db, body.category_id, auth.tmcId))) {
    return Response.json({ error: 'Category not found for this TMC' }, { status: 422 })
  }

  const validationError = validateRule(body.kind, body)
  if (validationError) {
    return Response.json({ error: validationError }, { status: 400 })
  }

  const isFee = body.kind === 'processing_fee'

  const rule = await commercials.insertRule(db, auth.tmcId, user.id, {
    kind: body.kind,
    category_id: body.category_id,
    airline_code: body.airline_code?.trim().toUpperCase() || null,
    cabin: body.cabin || null,
    rbd_spec: body.rbd_spec?.trim() || null,
    fare_type: body.fare_type ?? 'all',
    calc_type: body.calc_type ?? 'percent',
    calc_on: body.calc_on ?? 'bf',
    rate: body.rate,
    // Present for a fee, NULL for the other two. The database enforces this as
    // well; sending the wrong shape here is a constraint violation, not a
    // silently-ignored field.
    calc_basis: isFee ? (body.calc_basis ?? 'per_transaction') : null,
    exclude_tax_codes: isFee ? (body.exclude_tax_codes ?? []) : null,
    include_ssr: isFee ? (body.include_ssr ?? false) : null,
    valid_from: body.valid_from || null,
    valid_to: body.valid_to || null,
    active: body.active ?? true,
    notes: body.notes?.trim() || null,
  })

  return Response.json({ ok: true, rule: { ...rule, status: commercialStatus(rule), targetCount: 0 } })
})
