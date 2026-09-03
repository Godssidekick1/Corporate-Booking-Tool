import { matchesFlight, flightSpecBreadth } from './flightSpec'
import { isSellable } from './dealCodeStatus'

// ── Deal code resolution ─────────────────────────────────────────────────────
// Which negotiated codes apply to one client, for one itinerary, right now.
//
// A PURE FUNCTION, deliberately. Two reasons:
//
//   1. It is the piece that will be wired to the wire. The aggregator API has
//      no field for a tour code or an account code today (searchFlights takes
//      neither, addPassenger carries only Discount), so for now the result is
//      stamped onto the booking for manual GDS entry. When that changes, the
//      call site moves; this does not.
//
//   2. It is a resolution problem, not an integrity one. policy_groups forbids
//      overlap with a trigger that raises; deals overlap by design -- an
//      airline-wide deal alongside a route-specific one is the everyday case --
//      so overlap is settled here by ranking, never by rejecting.
//
// ONE WINNER PER (AIRLINE, CODE TYPE)
// The five types are not alternatives competing for one slot. A private fare
// shapes the search, a tour code prints on the ticket, a tracking code is
// reporting-only; a single booking can carry all three at once. Resolving to
// one winner overall -- which the screen this replaces implies -- would throw
// away two codes the TMC negotiated.
// ─────────────────────────────────────────────────────────────────────────────

export type AssignmentKind = 'client' | 'client_group' | 'bucket'

export interface ResolvableDeal {
  id: string
  code: string
  code_type: string
  airline_code: string
  flight_spec: string | null
  active: boolean
  sales_from: string | null
  sales_to: string | null
  travel_from: string | null
  travel_to: string | null
  created_at: string
}

export interface ResolvableAssignment {
  deal_code_id: string
  kind: AssignmentKind
  // How this assignment reached the client, for display: the bucket's or
  // group's name. Null for a direct client assignment.
  via_name?: string | null
}

export interface ResolutionCandidate {
  deal: ResolvableDeal
  kind: AssignmentKind
  viaName: string | null
}

export interface ResolvedDealCode {
  airline: string
  codeType: string
  code: string
  dealId: string
  kind: AssignmentKind
  viaName: string | null
  // What this beat, most-nearly-won first. Shown so an admin can see why a code
  // they expected is not the one that applied.
  beat: { code: string; kind: AssignmentKind; viaName: string | null }[]
  // Two survivors that the ladder cannot separate. Surfaced rather than hidden,
  // because picking silently between two negotiated fares is the kind of thing
  // that shows up later as an unexplained rate difference.
  ambiguous: boolean
}

export interface ResolveInput {
  deals: ResolvableDeal[]
  assignments: ResolvableAssignment[]
  // Restrict to one itinerary. Omit both to resolve everything that could ever
  // apply to this client, which is what the Effective codes screen shows.
  airlineCode?: string | null
  flightNumber?: string | number | null
  bookingDate?: string
  departureDate?: string | null
}

// Explicitness of intent, lowest first. A direct assignment is a deliberate act
// aimed at one client. Bucket membership is deliberate too, but aimed at a set.
// Client-group membership is an organisational fact -- a client belongs to its
// parent group whether or not anyone was thinking about deal codes -- so it is
// the weakest signal of "this deal is meant for this client".
const KIND_RANK: Record<AssignmentKind, number> = {
  client: 0,
  bucket: 1,
  client_group: 2,
}

function todayIso(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

// ── compareCandidates ────────────────────────────────────────────────────────
// Negative => a wins. The order of these tests IS the precedence rule.
// ─────────────────────────────────────────────────────────────────────────────
function compareCandidates(a: ResolutionCandidate, b: ResolutionCandidate): number {
  const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind]
  if (byKind !== 0) return byKind

  // A deal filed against specific flights beats one filed against the whole
  // airline, and between two restricted deals the tighter set wins.
  // flightSpecBreadth reports an unrestricted spec as Infinity, so this single
  // comparison covers both halves of that rule.
  const byBreadth = flightSpecBreadth(a.deal.flight_spec) - flightSpecBreadth(b.deal.flight_spec)
  if (byBreadth !== 0) return byBreadth

  // Most recently negotiated. Deals get renegotiated annually and the new one
  // is nearly always the intended one.
  return b.deal.created_at.localeCompare(a.deal.created_at)
}

// True when the ladder genuinely cannot separate two candidates — same kind,
// same breadth, same instant. Not the same as "b lost narrowly".
function indistinguishable(a: ResolutionCandidate, b: ResolutionCandidate): boolean {
  return (
    KIND_RANK[a.kind] === KIND_RANK[b.kind] &&
    flightSpecBreadth(a.deal.flight_spec) === flightSpecBreadth(b.deal.flight_spec) &&
    a.deal.created_at === b.deal.created_at
  )
}

export function resolveDealCodes(input: ResolveInput): ResolvedDealCode[] {
  const {
    deals,
    assignments,
    airlineCode = null,
    flightNumber = null,
    departureDate = null,
  } = input
  const bookingDate = input.bookingDate ?? todayIso()

  const dealsById = new Map(deals.map(d => [d.id, d]))

  // 1. Reach + 2. Live + 3. Match, in one pass.
  //
  // A deal reaching the same client twice (say, directly and via a bucket) is
  // normal. Both are kept as separate candidates so the strongest one wins on
  // kind rather than whichever happened to be read first.
  const candidates: ResolutionCandidate[] = []

  for (const assignment of assignments) {
    const deal = dealsById.get(assignment.deal_code_id)
    if (!deal) continue

    if (airlineCode && deal.airline_code.toUpperCase() !== airlineCode.toUpperCase()) continue
    if (!isSellable(deal, bookingDate, departureDate)) continue
    // Only test the flight when resolving a real itinerary. With no flight in
    // hand, a flight-restricted deal is still potentially applicable and
    // belongs in the "what could this client get" view.
    if (flightNumber !== null && !matchesFlight(deal.flight_spec, flightNumber)) continue

    candidates.push({
      deal,
      kind: assignment.kind,
      viaName: assignment.via_name ?? null,
    })
  }

  // 4 + 5. Group by (airline, type) and rank within each group.
  const groups = new Map<string, ResolutionCandidate[]>()
  for (const candidate of candidates) {
    const key = `${candidate.deal.airline_code.toUpperCase()}::${candidate.deal.code_type}`
    const group = groups.get(key)
    if (group) group.push(candidate)
    else groups.set(key, [candidate])
  }

  const resolved: ResolvedDealCode[] = []

  for (const group of groups.values()) {
    const ranked = [...group].sort(compareCandidates)
    const winner = ranked[0]

    // The same deal can appear twice in one group when it reaches the client by
    // two routes. It did not "beat" itself, so losers are deduped by deal id.
    const losers = ranked.slice(1).filter(c => c.deal.id !== winner.deal.id)

    resolved.push({
      airline: winner.deal.airline_code.toUpperCase(),
      codeType: winner.deal.code_type,
      code: winner.deal.code,
      dealId: winner.deal.id,
      kind: winner.kind,
      viaName: winner.viaName,
      beat: losers.map(l => ({ code: l.deal.code, kind: l.kind, viaName: l.viaName })),
      ambiguous: losers.some(l => indistinguishable(winner, l)),
    })
  }

  return resolved.sort(
    (a, b) => a.airline.localeCompare(b.airline) || a.codeType.localeCompare(b.codeType)
  )
}

// How a winner reached the client, in words. One implementation so the
// Effective codes screen, the client detail panel and the booking stamp cannot
// describe the same thing three different ways.
export function describeVia(kind: AssignmentKind, viaName: string | null): string {
  if (kind === 'client') return 'Direct assignment'
  if (kind === 'bucket') return viaName ? `Bucket · ${viaName}` : 'Bucket'
  return viaName ? `Client group · ${viaName}` : 'Client group'
}
