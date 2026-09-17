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
  // Kinds where more than one rule reaches this client under different
  // categories, so which one applies is decided by the flight rather than by
  // configuration. See variesByCategory below.
  variesByCategory: CommercialKind[]
  // Which kinds this client has switched off on their Controls tab.
  //
  // Without this the screen shows a dash, which reads as "no rule configured"
  // and sends a desk hunting through the rules master for something that is
  // already there and already correct. A rule that resolves but is switched off
  // is a different situation with a different fix, and it is one click away —
  // so the row says which it is and the client name links to the switch.
  switchedOff: CommercialKind[]
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

  const ruleById = new Map(rules.map(r => [r.id, r]))

  // ── "It depends on the flight" ─────────────────────────────────────────────
  // This view deliberately resolves with NO itinerary, so every dimension a real
  // booking narrows on — category, airline, cabin, class — is left open and a
  // restricted rule stays a candidate. That is right for "what could this client
  // get", but resolution still returns ONE winner per kind, so a client with a
  // domestic-BSP discount AND a domestic-LCC discount saw one of them printed as
  // though it were the answer, with the other invisible.
  //
  // Both are genuinely in force. Which applies is decided by the flight, and no
  // screen without a flight in front of it can say which. So rather than pick
  // one and imply certainty, the cell says the answer varies.
  //
  // Only CATEGORY is treated this way, not every losing candidate. A broad rule
  // beaten by a narrower one is a real precedence decision the ladder made and
  // the winner is the answer; two rules under different categories are not
  // competing at all, they are covering different journeys.
  function variesByCategory(resolved: ResolvedRule | null): boolean {
    if (!resolved || resolved.beat.length === 0) return false
    const categories = new Set<string>([resolved.rule.category_id])
    for (const loser of resolved.beat) {
      const category = ruleById.get(loser.ruleId)?.category_id
      if (category) categories.add(category)
    }
    return categories.size > 1
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
    if (client.discount_active !== false) enabledKinds.add('discount')
    if (client.processing_fee_active !== false) enabledKinds.add('processing_fee')

    // No itinerary here, deliberately — this is the "what could this client get"
    // view, so every dimension a booking would narrow on is left unset and a
    // restricted rule is still a candidate.
    const resolved = resolveCommercials({ rules, assignments, enabledKinds })

    const markupRate = resolved.markup?.rule.calc_type === 'percent' ? resolved.markup.rule.rate : null
    const discountRate = resolved.discount?.rule.calc_type === 'percent' ? resolved.discount.rule.rate : null

    // ── Only subtract rates that are actually comparable ──────────────────────
    // A FIXED rule cannot be netted against a percentage without a fare, which
    // this screen does not have — the netPercent field says so in its own
    // comment, and the test here used to disagree with it. It was `||`: either
    // rate being a percentage was enough, and the missing side was coerced to 0.
    //
    // That produced a confident FALSE loss warning for the commonest mixed
    // arrangement there is — a fixed ₹500 markup against a 5% discount read as
    // 0% − 5% = −5%, though it is profitable on any fare under ₹10,000. The
    // mirror case was quieter and no better: a percentage markup against a fixed
    // discount reported the markup as the net and ignored the discount entirely,
    // overstating margin on the one screen that exists to show it.
    //
    // A rule that is ABSENT is genuinely 0 and stays comparable — a 4% markup
    // with no discount nets 4%, and a 5% discount with no markup really does net
    // −5%. It is only a fixed AMOUNT that makes the comparison unanswerable.
    const markupBlocks = resolved.markup != null && resolved.markup.rule.calc_type !== 'percent'
    const discountBlocks = resolved.discount != null && resolved.discount.rule.calc_type !== 'percent'

    // ── And they must be percentages OF THE SAME THING ───────────────────────
    // calc_on is the component the rate is charged against, and "20% of BF"
    // against "10% of TF" are not two numbers that can be subtracted. On a fare
    // with base 12,000 and total 15,000 that is a 2,400 markup against a 1,500
    // discount — a real net of 900, or 6% of the total. The column said +10%.
    //
    // Always an OVERSTATEMENT in the common direction, too: a markup is usually
    // filed on the base and a discount on the total, and the base is the smaller
    // number — so the markup's percentage buys less than the discount's gives
    // away, and the one screen that exists to show margin flattered it.
    //
    // Same failure as netting a fixed amount against a percentage, one level
    // down: two quantities that look comparable because they share a unit.
    const differentBasis =
      resolved.markup != null &&
      resolved.discount != null &&
      resolved.markup.rule.calc_on !== resolved.discount.rule.calc_on

    const comparable =
      !markupBlocks && !discountBlocks && !differentBasis &&
      (resolved.markup != null || resolved.discount != null)

    const netPercent = comparable
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
      variesByCategory: ([
        ['markup', resolved.markup],
        ['discount', resolved.discount],
        ['processing_fee', resolved.processing_fee],
      ] as [CommercialKind, ResolvedRule | null][])
        .filter(([, r]) => variesByCategory(r))
        .map(([kind]) => kind),
      switchedOff: (['markup', 'discount', 'processing_fee'] as CommercialKind[])
        .filter(kind => !enabledKinds.has(kind)),
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
