import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission, getAccessibleClientIds } from '@/app/lib/permissions/requireTmcPermission'
import { parsePageParams, paginateInMemory } from '@/app/lib/pagination'
import {
  resolveCommercials,
  type ResolvableRule,
  type ResolvableAssignment,
  type ResolvedRule,
} from '@/app/lib/commercials/resolveCommercials'
import { KIND_LABELS, type CommercialKind } from '@/app/lib/commercials/calcOnByKind'
import { RULE_COLUMNS } from '../route'
import { NextRequest } from 'next/server'

// ── GET /api/tmc/commercial-rules/effective ──────────────────────────────────
// What each client actually ends up with: one row per client, carrying the
// markup, discount and processing fee in force for them.
//
// The OUTCOME of resolution, not a list of rules. It answers the question a TMC
// actually has — "what are we charging Acme?" — which no amount of reading the
// rules table answers, because the answer depends on which rules reach them and
// which of those wins.
//
// IT ALSO FLAGS NEGATIVE MARGIN. We cannot transmit a deal code to the
// aggregator, so the airline does not fund a discount — it comes out of the
// TMC's own margin. A client whose discount exceeds its markup is a loss-making
// arrangement, and this is the only screen where that is visible before the
// bookings arrive.
//
// QUERY PLAN is fixed regardless of client count: four reads, then two. Same
// shape as /api/tmc/deal-codes/effective, and the same caveat — it holds
// comfortably into the low thousands of clients. Beyond that this wants a
// materialised table.
// ─────────────────────────────────────────────────────────────────────────────

interface CoverageRow {
  clientId: string
  clientName: string
  markup: string | null
  markupVia: string | null
  discount: string | null
  discountVia: string | null
  fee: string | null
  feeVia: string | null
  // Percent rates only, and only when both are percentages — comparing a 2%
  // markup against a fixed ₹500 discount needs a fare, which this screen does
  // not have. Null means "cannot be judged from configuration alone".
  netPercent: number | null
  lossMaking: boolean
  ambiguous: boolean
}

// "2% of base fare", "₹250 per sector" — enough to judge an arrangement without
// opening the rule.
function describeRule(resolved: ResolvedRule | null): string | null {
  if (!resolved) return null
  const r = resolved.rule
  const amount = r.calc_type === 'percent' ? `${r.rate}%` : `₹${r.rate}`
  const basis = r.calc_type === 'percent' ? ` of ${r.calc_on.replace(/_/g, '+').toUpperCase()}` : ''
  const per = r.calc_basis === 'per_sector' ? ' per sector' : ''
  return `${amount}${basis}${per}`
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const auth = await requireTmcPermission(service, user.id, 'manage_commercials')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }
  const tmcId = auth.tmcId

  const params = parsePageParams(req.nextUrl.searchParams)
  const kindFilter = req.nextUrl.searchParams.get('kind') as CommercialKind | null

  const accessibleIds = await getAccessibleClientIds(service, user.id, auth.role ?? '')

  let clientQuery = service
    .from('clients')
    .select('id, name, client_group_id, markup_active, discount_active, processing_fee_active')
    .eq('tmc_id', tmcId)
    .order('name')

  if (accessibleIds !== null) {
    if (accessibleIds.length === 0) return Response.json(paginateInMemory([], params))
    clientQuery = clientQuery.in('id', accessibleIds)
  }

  const [{ data: clients }, { data: memberships }, { data: assignmentRows }, { data: ruleRows }] =
    await Promise.all([
      clientQuery,
      service.from('bucket_clients').select('bucket_id, client_id'),
      service
        .from('commercial_rule_assignments')
        .select('rule_id, kind, client_id, client_group_id, bucket_id')
        .eq('tmc_id', tmcId),
      service.from('commercial_rules').select(RULE_COLUMNS).eq('tmc_id', tmcId),
    ])

  const rules = (ruleRows ?? []) as unknown as ResolvableRule[]

  // Names for the `via` labels, read once for the whole TMC rather than per
  // client — the alternative is a query inside the loop below.
  const usedBucketIds = [...new Set((assignmentRows ?? []).map(a => a.bucket_id).filter(Boolean) as string[])]
  const [{ data: buckets }, { data: groups }] = await Promise.all([
    usedBucketIds.length
      ? service.from('buckets').select('id, name').in('id', usedBucketIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    service.from('client_groups').select('id, name').eq('tmc_id', tmcId),
  ])

  const bucketName = new Map((buckets ?? []).map(b => [b.id, b.name]))
  const groupName = new Map((groups ?? []).map(g => [g.id, g.name]))

  const bucketsByClient = new Map<string, string[]>()
  for (const m of memberships ?? []) {
    const list = bucketsByClient.get(m.client_id)
    if (list) list.push(m.bucket_id)
    else bucketsByClient.set(m.client_id, [m.bucket_id])
  }

  const rows: CoverageRow[] = (clients ?? []).map(client => {
    const bucketIds = bucketsByClient.get(client.id) ?? []

    const reaching = (assignmentRows ?? []).filter(a => {
      if (a.kind === 'client') return a.client_id === client.id
      if (a.kind === 'bucket') return a.bucket_id !== null && bucketIds.includes(a.bucket_id)
      return a.client_group_id !== null && a.client_group_id === client.client_group_id
    })

    const assignments: ResolvableAssignment[] = reaching.map(a => ({
      rule_id: a.rule_id,
      kind: a.kind,
      via_name:
        a.kind === 'bucket'
          ? bucketName.get(a.bucket_id!) ?? null
          : a.kind === 'client_group'
            ? groupName.get(a.client_group_id!) ?? null
            : null,
    }))

    // The client's own switches, so the coverage view shows what WOULD apply
    // rather than what is configured — a rule reaching a client who has markup
    // switched off is not in force, and showing it as if it were is how a desk
    // ends up debugging a fare that was never going to move.
    const enabledKinds = new Set<CommercialKind>()
    if (client.markup_active !== false) enabledKinds.add('markup')
    if (client.discount_active === true) enabledKinds.add('discount')
    if (client.processing_fee_active === true) enabledKinds.add('processing_fee')

    // No itinerary here, deliberately — this is the "what could this client get"
    // view, so every dimension a booking would narrow on is left unset and a
    // restricted rule is still a candidate.
    const resolved = resolveCommercials({ rules, assignments, enabledKinds })

    const markupRate = resolved.markup?.rule.calc_type === 'percent' ? resolved.markup.rule.rate : null
    const discountRate = resolved.discount?.rule.calc_type === 'percent' ? resolved.discount.rule.rate : null
    const netPercent =
      markupRate !== null || discountRate !== null
        ? Number(((markupRate ?? 0) - (discountRate ?? 0)).toFixed(4))
        : null

    return {
      clientId: client.id,
      clientName: client.name,
      markup: describeRule(resolved.markup),
      markupVia: resolved.markup?.via ?? null,
      discount: describeRule(resolved.discount),
      discountVia: resolved.discount?.via ?? null,
      fee: describeRule(resolved.processing_fee),
      feeVia: resolved.processing_fee?.via ?? null,
      netPercent,
      // The flag. Only asserted when both sides are percentages and the discount
      // genuinely exceeds the markup — a fixed fee could still make the booking
      // profitable, so this says "the fare itself loses money", not "this client
      // loses money".
      lossMaking: netPercent !== null && netPercent < 0,
      ambiguous: Boolean(
        resolved.markup?.ambiguous ||
        resolved.discount?.ambiguous ||
        resolved.processing_fee?.ambiguous
      ),
    }
  })

  const narrowed = kindFilter
    ? rows.filter(r =>
        kindFilter === 'markup' ? r.markup !== null
        : kindFilter === 'discount' ? r.discount !== null
        : r.fee !== null)
    : rows

  // Search then page, deliberately in that order. Filtering a page of
  // already-resolved rows would silently hide matches on page four.
  const term = params.search.toLowerCase()
  const filtered = term
    ? narrowed.filter(r =>
        [r.clientName, r.markup, r.discount, r.fee, r.markupVia, r.discountVia, r.feeVia]
          .some(v => v?.toLowerCase().includes(term)))
    : narrowed

  return Response.json({
    ...paginateInMemory(filtered, params),
    // Surfaced on the envelope rather than left for the caller to count, so the
    // screen can warn without reading every page.
    lossMakingCount: rows.filter(r => r.lossMaking).length,
    kindLabels: KIND_LABELS,
  })
}
