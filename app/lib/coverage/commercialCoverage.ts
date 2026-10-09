import type { Queryable } from '@/app/lib/db'
import * as clients from '@/app/lib/repositories/clients'
import * as commercials from '@/app/lib/repositories/commercials'
import * as coverage from '@/app/lib/repositories/coverage'
import {
  resolveCommercials,
  type ResolvableAssignment,
  type ResolvedRule,
} from '@/app/lib/commercials/resolveCommercials'
import type { CommercialKind } from '@/app/lib/commercials/calcOnByKind'
import { reachIndex } from '@/app/lib/assignments/reachIndex'
import { ensureCurrent } from './freshness'

// ── Commercial coverage ──────────────────────────────────────────────────────
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
// Built by the same resolver the booking path prices with, then stored so the
// screen searches and pages it in SQL (coverage repository).
// ─────────────────────────────────────────────────────────────────────────────

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

// Every client of the TMC, by name.
export async function computeCommercialCoverage(
  db: Queryable, tmcId: string, asOf: string
): Promise<coverage.CommercialCoverageRow[]> {
  // One after another, not Promise.all: `db` is the rebuild's single
  // transaction connection, which runs one query at a time anyway.
  const clientRows = await clients.commercialSwitches(db, tmcId, null)
  const assignmentRows = await commercials.assignmentsForTmc(db, tmcId)
  const rules = await commercials.rulesForTmc(db, tmcId)

  // Names for the `via` labels, read once for the whole TMC rather than per
  // client — the alternative is a query inside the loop below.
  const usedBucketIds = [...new Set(assignmentRows.map(a => a.bucket_id).filter((b): b is string => Boolean(b)))]
  const memberships = await clients.memberships(db, clientRows.map(c => c.id))
  const buckets = await clients.bucketLabels(db, usedBucketIds)
  const groupName = await clients.groupNamesForTmc(db, tmcId)

  const bucketsByClient = new Map<string, string[]>()
  for (const m of memberships) {
    const list = bucketsByClient.get(m.client_id)
    if (list) list.push(m.bucket_id)
    else bucketsByClient.set(m.client_id, [m.bucket_id])
  }

  const ruleById = new Map(rules.map(r => [r.id, r]))

  // Indexed once by target: filtering every assignment for every client was
  // clients x assignments (npm run scale).
  const reachingOf = reachIndex(assignmentRows)

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

  return clientRows.map(client => {
    const reaching = reachingOf(client.id, client.client_group_id, bucketsByClient.get(client.id) ?? [])

    const assignments: ResolvableAssignment[] = reaching.map(a => ({
      rule_id: a.rule_id,
      kind: a.kind as ResolvableAssignment['kind'],
      via_name:
        a.kind === 'bucket'
          ? buckets.get(a.bucket_id!)?.name ?? null
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
    const resolved = resolveCommercials({ rules, assignments, enabledKinds, pricedOn: asOf })

    const markupRate = resolved.markup?.rule.calc_type === 'percent' ? resolved.markup.rule.rate : null
    const discountRate = resolved.discount?.rule.calc_type === 'percent' ? resolved.discount.rule.rate : null

    // ── Only subtract rates that are actually comparable ──────────────────────
    // A FIXED rule cannot be netted against a percentage without a fare, which
    // this screen does not have. It used to be `||`: either rate being a
    // percentage was enough, and the missing side was coerced to 0 — a fixed
    // ₹500 markup against a 5% discount read as a confident −5% loss, though it
    // is profitable on any fare under ₹10,000.
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
      // Which kinds this client has switched off on their Controls tab. Without
      // it the screen shows a dash, which reads as "no rule configured" and
      // sends a desk hunting for something that is already there.
      switchedOff: (['markup', 'discount', 'processing_fee'] as CommercialKind[])
        .filter(kind => !enabledKinds.has(kind)),
    }
  })
}

export function ensureCommercialCoverage(tmcId: string): Promise<void> {
  return ensureCurrent(tmcId, 'commercials', async (tx, builtFrom, asOf) => {
    const rows = await computeCommercialCoverage(tx, tmcId, asOf)
    await coverage.replaceCommercialCoverage(tx, tmcId, rows, builtFrom, asOf)
  })
}
