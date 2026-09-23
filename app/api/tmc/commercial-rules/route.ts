import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { parsePageParams, paginateInMemory, escapeFilterValue } from '@/app/lib/pagination'
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

// ── /api/tmc/commercial-rules ────────────────────────────────────────────────
// Markup, discount and processing fee. One table, one route, `?kind=` to
// narrow — the three screens are the same screen.
//
// Gated on `manage_commercials` rather than on manage_deal_codes or manage_fops.
// Those decide which negotiated codes and payment methods a client GETS and
// neither changes a number; this one sets what a client is CHARGED, which is a
// different thing to trust somebody with.
// ─────────────────────────────────────────────────────────────────────────────

export const RULE_COLUMNS =
  'id, kind, category_id, airline_code, cabin, rbd_spec, fare_type, ' +
  'calc_type, calc_on, rate, calc_basis, exclude_tax_codes, include_ssr, ' +
  'active, valid_from, valid_to, notes, created_by, created_at, updated_at'

// Declared rather than inferred, and every read of RULE_COLUMNS casts to it.
//
// Supabase derives a row type from the select STRING LITERAL. The constant above
// is a concatenation, which is plain `string` to the compiler, so inference
// gives up and hands back GenericStringError — at which point every property
// access downstream is a type error. The alternative is one unreadable
// 250-character line; stating the shape is more honest anyway, since these
// columns are read by five call sites and the compiler should know them.
export interface CommercialRuleRow {
  id: string
  kind: CommercialKind
  category_id: string
  airline_code: string | null
  cabin: string | null
  rbd_spec: string | null
  fare_type: string
  calc_type: string
  calc_on: string
  rate: number
  calc_basis: string | null
  exclude_tax_codes: string[] | null
  include_ssr: boolean | null
  active: boolean
  valid_from: string | null
  valid_to: string | null
  notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

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

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const auth = await requireTmcPermission(db, user.id, 'manage_commercials')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const query_ = req.nextUrl.searchParams
  const params = parsePageParams(query_)
  const kind = query_.get('kind')
  const categoryId = query_.get('categoryId')
  const status = query_.get('status') as CommercialStatus | null

  let query = service
    .from('commercial_rules')
    .select(RULE_COLUMNS)
    .eq('tmc_id', auth.tmcId)
    .order('created_at', { ascending: false })

  if (kind) query = query.eq('kind', kind)
  if (categoryId) query = query.eq('category_id', categoryId)

  if (params.search) {
    // Escaped before interpolation: PostgREST parses this string, and a comma or
    // parenthesis in the search box would otherwise change the filter's shape
    // rather than being matched literally.
    const safe = escapeFilterValue(params.search)
    if (safe) query = query.or(`airline_code.ilike.%${safe}%,notes.ilike.%${safe}%`)
  }

  const { data: rawRules, error } = await query

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  const rules = (rawRules ?? []) as unknown as CommercialRuleRow[]

  // Status is derived from `active` plus a date window, so it cannot be filtered
  // or paged in SQL without writing that rule a second time as a predicate and
  // having the two drift. Enriched and filtered here, then paged in memory —
  // the same trade the deal code master makes, bounded by rules per TMC.
  const [{ data: categories }, { data: assignments }] = await Promise.all([
    service.from('deal_code_categories').select('id, code, label').eq('tmc_id', auth.tmcId),
    service.from('commercial_rule_assignments').select('rule_id, kind').eq('tmc_id', auth.tmcId),
  ])

  const categoryById = new Map((categories ?? []).map(c => [c.id, c]))

  // How many targets each rule reaches — blast radius before somebody edits
  // something shared.
  const targetCount = new Map<string, number>()
  for (const a of assignments ?? []) {
    targetCount.set(a.rule_id, (targetCount.get(a.rule_id) ?? 0) + 1)
  }

  const enriched = rules.map(r => ({
    ...r,
    categoryCode: categoryById.get(r.category_id)?.code ?? null,
    categoryLabel: categoryById.get(r.category_id)?.label ?? null,
    status: commercialStatus(r),
    targetCount: targetCount.get(r.id) ?? 0,
  }))

  const filtered = status ? enriched.filter(r => r.status === status) : enriched

  return Response.json(paginateInMemory(filtered, params))
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
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
  const { data: category } = await service
    .from('deal_code_categories')
    .select('id')
    .eq('id', body.category_id)
    .eq('tmc_id', auth.tmcId)
    .maybeSingle()

  if (!category) {
    return Response.json({ error: 'Category not found for this TMC' }, { status: 422 })
  }

  const validationError = validateRule(body.kind, body)
  if (validationError) {
    return Response.json({ error: validationError }, { status: 400 })
  }

  const isFee = body.kind === 'processing_fee'

  const { data: rawRule, error } = await service
    .from('commercial_rules')
    .insert({
      tmc_id: auth.tmcId,
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
      created_by: user.id,
    })
    .select(RULE_COLUMNS)
    .single()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  const rule = rawRule as unknown as CommercialRuleRow
  return Response.json({ ok: true, rule: { ...rule, status: commercialStatus(rule), targetCount: 0 } })
}
