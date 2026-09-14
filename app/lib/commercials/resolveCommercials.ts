import { matchesAllLegs, rbdSpecBreadth } from '@/app/lib/fop/rbdSpec'
import { isApplicable } from './commercialStatus'
import type { CommercialKind, CalcOn, CalcType, FareType, CalcBasis } from './calcOnByKind'

// ── Commercial rule resolution ───────────────────────────────────────────────
// Which markup, which discount and which processing fee apply to one priced
// itinerary for one client.
//
// A PURE FUNCTION, like resolveFop and resolveDealCodes, for the same reasons:
// it decides money, so it has to be testable without a database, and overlap
// between rules is normal — a TMC-wide markup alongside an airline-specific one
// is the everyday case — so this RANKS rather than rejects.
//
// ONE WINNER PER KIND, following resolveFop rather than resolveDealCodes. Deal
// codes resolve one per (airline, type) because a private fare, a tour code and
// a tracking code all legitimately apply to the same ticket. You do not get
// marked up twice.
//
// CATEGORY IS THE NEW DIMENSION. deal_code_categories has existed since the deal
// code master and nothing has ever read it. A booking's category is derivable —
// classifyFlight() gives domestic/international and FlatFlightResult.isLcc gives
// BSP vs LCC — so it becomes a real matching key here rather than a label.
// ─────────────────────────────────────────────────────────────────────────────

export type AssignmentKind = 'client' | 'client_group' | 'bucket'

export interface ResolvableRule {
  id: string
  kind: CommercialKind
  category_id: string
  airline_code: string | null
  cabin: string | null
  rbd_spec: string | null
  fare_type: FareType
  calc_type: CalcType
  calc_on: CalcOn
  rate: number
  calc_basis: CalcBasis | null
  exclude_tax_codes: string[] | null
  include_ssr: boolean | null
  active: boolean
  valid_from: string | null
  valid_to: string | null
  created_at: string
}

export interface ResolvableAssignment {
  rule_id: string
  kind: AssignmentKind
  // The bucket's or group's name, for display. Null for a direct assignment.
  via_name?: string | null
}

export interface ResolveCommercialsInput {
  rules: ResolvableRule[]
  // Only the assignments that reach THIS client.
  assignments: ResolvableAssignment[]

  // The booking being priced. Everything here is optional so the same function
  // serves the "what would this client get" coverage view, where there is no
  // itinerary to test against — an unmatched dimension is permissive there
  // rather than excluding every rule.
  categoryId?: string | null
  airlineCode?: string | null
  cabin?: string | null
  legBookingCodes?: (string | null | undefined)[]
  fareType?: FareType | null
  // ISO date the price is being quoted on. Defaults to today.
  pricedOn?: string

  // Corporate Settings switches. A kind switched off for this client resolves to
  // nothing at all, which is different from having no rule configured and is
  // recorded as such.
  enabledKinds?: Set<CommercialKind>
}

export interface ResolvedRule {
  rule: ResolvableRule
  kind: AssignmentKind
  viaName: string | null
  via: string
  // Other candidates that lost, so an admin can see why the one they expected
  // is not in force.
  beat: { ruleId: string; via: string }[]
  // Two candidates the ladder could not separate. Surfaced rather than silently
  // picked: the wrong answer here is a wrongly-billed booking.
  ambiguous: boolean
}

export interface ResolvedCommercials {
  markup: ResolvedRule | null
  discount: ResolvedRule | null
  processing_fee: ResolvedRule | null
}

// Explicitness of intent, lowest first. Identical to the ladder deal codes and
// forms of payment already use, and deliberately so — a TC who has learned how
// one master decides precedence has learned all of them.
//
// A direct assignment is a deliberate act aimed at one client. Bucket membership
// is deliberate too, but aimed at a set. Client-group membership is an
// organisational fact that happens to imply commercial treatment.
const KIND_RANK: Record<AssignmentKind, number> = {
  client: 0,
  bucket: 1,
  client_group: 2,
}

export function describeVia(kind: AssignmentKind, viaName: string | null): string {
  if (kind === 'client') return 'Direct assignment'
  if (kind === 'bucket') return viaName ? `Bucket · ${viaName}` : 'Bucket'
  return viaName ? `Client group · ${viaName}` : 'Client group'
}

interface Candidate {
  rule: ResolvableRule
  kind: AssignmentKind
  viaName: string | null
}

// Negative => a wins. The order of these tests IS the precedence rule.
function compare(a: Candidate, b: Candidate): number {
  const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind]
  if (byKind !== 0) return byKind

  // A rule filed against one airline beats one filed against every airline.
  const airlineRank = (c: Candidate) => (c.rule.airline_code ? 0 : 1)
  const byAirline = airlineRank(a) - airlineRank(b)
  if (byAirline !== 0) return byAirline

  // Then cabin, on the same principle.
  const cabinRank = (c: Candidate) => (c.rule.cabin ? 0 : 1)
  const byCabin = cabinRank(a) - cabinRank(b)
  if (byCabin !== 0) return byCabin

  // Narrower class set wins; unrestricted reports Infinity so it sorts last.
  const byRbd = rbdSpecBreadth(a.rule.rbd_spec) - rbdSpecBreadth(b.rule.rbd_spec)
  if (byRbd !== 0) return byRbd

  // A rule naming one fare type beats one that applies to all of them.
  const fareRank = (c: Candidate) => (c.rule.fare_type === 'all' ? 1 : 0)
  const byFare = fareRank(a) - fareRank(b)
  if (byFare !== 0) return byFare

  // Most recently negotiated. Commercial terms get renegotiated and the new one
  // is nearly always the intended one.
  return b.rule.created_at.localeCompare(a.rule.created_at)
}

function indistinguishable(a: Candidate, b: Candidate): boolean {
  return (
    KIND_RANK[a.kind] === KIND_RANK[b.kind] &&
    Boolean(a.rule.airline_code) === Boolean(b.rule.airline_code) &&
    Boolean(a.rule.cabin) === Boolean(b.rule.cabin) &&
    rbdSpecBreadth(a.rule.rbd_spec) === rbdSpecBreadth(b.rule.rbd_spec) &&
    (a.rule.fare_type === 'all') === (b.rule.fare_type === 'all') &&
    a.rule.created_at === b.rule.created_at
  )
}

export function resolveCommercials(input: ResolveCommercialsInput): ResolvedCommercials {
  const {
    rules,
    assignments,
    categoryId = null,
    airlineCode = null,
    cabin = null,
    legBookingCodes = [],
    fareType = null,
    pricedOn,
    enabledKinds,
  } = input

  // A rule can be assigned more than once (directly and via a bucket, say).
  // Keep the STRONGEST claim per rule rather than one row per assignment, so the
  // same rule does not appear as its own competitor.
  const strongest = new Map<string, Candidate>()

  for (const assignment of assignments) {
    const rule = rules.find(r => r.id === assignment.rule_id)
    if (!rule) continue

    const candidate: Candidate = {
      rule,
      kind: assignment.kind,
      viaName: assignment.via_name ?? null,
    }

    const existing = strongest.get(rule.id)
    if (!existing || KIND_RANK[candidate.kind] < KIND_RANK[existing.kind]) {
      strongest.set(rule.id, candidate)
    }
  }

  const eligible = [...strongest.values()].filter(({ rule }) => {
    if (enabledKinds && !enabledKinds.has(rule.kind)) return false
    if (!isApplicable(rule, pricedOn)) return false

    // Each dimension is tested only when the caller supplied it. With no
    // itinerary in hand this is the "what could this client get" view, where a
    // restricted rule is still potentially applicable and belongs in the answer.
    if (categoryId && rule.category_id !== categoryId) return false

    if (airlineCode && rule.airline_code &&
        rule.airline_code.toUpperCase() !== airlineCode.toUpperCase()) return false

    if (cabin && rule.cabin && rule.cabin.toUpperCase() !== cabin.toUpperCase()) return false

    // Fails closed, like the FOP resolver: matchesAllLegs requires EVERY leg to
    // be in the set, and a missing booking code cannot be shown to be. Charging
    // a class-restricted markup on a class it was never filed for is worse than
    // not charging it.
    if (legBookingCodes.length > 0 && !matchesAllLegs(rule.rbd_spec, legBookingCodes)) return false

    // 'all' matches every fare type; a named one must match exactly.
    if (fareType && rule.fare_type !== 'all' && rule.fare_type !== fareType) return false

    return true
  })

  function winnerFor(kind: CommercialKind): ResolvedRule | null {
    const forKind = eligible.filter(c => c.rule.kind === kind)
    if (forKind.length === 0) return null

    const ranked = [...forKind].sort(compare)
    const winner = ranked[0]
    const losers = ranked.slice(1)

    return {
      rule: winner.rule,
      kind: winner.kind,
      viaName: winner.viaName,
      via: describeVia(winner.kind, winner.viaName),
      beat: losers.map(l => ({ ruleId: l.rule.id, via: describeVia(l.kind, l.viaName) })),
      ambiguous: losers.some(l => indistinguishable(winner, l)),
    }
  }

  return {
    markup: winnerFor('markup'),
    discount: winnerFor('discount'),
    processing_fee: winnerFor('processing_fee'),
  }
}
