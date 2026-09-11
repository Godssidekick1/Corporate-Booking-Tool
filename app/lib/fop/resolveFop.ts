import { matchesAllLegs, rbdSpecBreadth } from './rbdSpec'
import { isUsable, describeFop } from './fopStatus'
import { DEFAULT_PAYMENT_PRIORITY, paymentTypeOfPayer, type PaymentType } from './paymentTypes'

// ── Form of payment resolution ───────────────────────────────────────────────
// Which payment method applies to one booking.
//
// A PURE FUNCTION, mirroring resolveDealCodes, for the same two reasons: it is
// the piece that gets wired to the aggregator later, and overlap between rules
// is normal — a TMC-wide card alongside a branch-specific one is the everyday
// case — so this RANKS rather than rejects.
//
// THREE THINGS IT DOES DIFFERENTLY FROM DEAL CODES
//
//   1. ONE winner, full stop. Deal codes resolve one per (airline, type)
//      because a private fare, a tour code and a tracking code all legitimately
//      apply to the same ticket. You pay one way.
//
//   2. There is a DEFAULT, and it is chosen rather than inferred. An unassigned
//      deal code reaching nobody is safe; a booking that resolves to no payment
//      method at all tells the counsellor nothing. So one form of payment per
//      TMC can carry `is_default` and enters the running for every client,
//      ranked below anything explicitly assigned.
//
//      It used to be that any UNASSIGNED form of payment was the default for its
//      scope. That made adding the first assignment to a card silently remove it
//      as everyone else's fallback — one edit changing how unrelated clients
//      settle. A client that matches nothing is now a visible gap instead.
//
//   3. Fails closed on RBD. matchesAllLegs requires every leg to be in the set,
//      and a missing booking code cannot be shown to be. Falling back to the
//      default is recoverable; applying a card the airline rejects at the
//      counter is not.
// ─────────────────────────────────────────────────────────────────────────────

export type FopAssignmentKind = 'client' | 'client_group' | 'bucket'
export type FopPayer = 'agency' | 'corporate' | 'traveller'

export interface ResolvableFop {
  id: string
  label: string
  fop_type: string
  payer: FopPayer
  card_type: string | null
  last4: string | null
  expiry_month: number | null
  expiry_year: number | null
  branch_id: string | null
  airline_code: string | null
  rbd_spec: string | null
  active: boolean
  // The TMC's chosen fallback. At most one row has it; enforced by a partial
  // unique index rather than trusted from here.
  is_default: boolean
  created_at: string
}

export interface ResolvableFopAssignment {
  fop_id: string
  kind: FopAssignmentKind
  // The bucket's or group's name, for display. Null for a direct assignment.
  via_name?: string | null
}

export interface ResolvedFop {
  fopId: string
  label: string
  description: string
  fopType: string
  payer: FopPayer
  // How it reached this client. 'default' when nothing was assigned and it
  // applied as the fallback for its scope — worth naming, because "nobody chose
  // this, it was simply what was left" is different from a deliberate choice.
  via: string
  // Other candidates that lost, so an admin can see why the one they expected
  // is not in force.
  beat: { label: string; via: string }[]
  // Two candidates the ladder could not separate. Surfaced rather than silently
  // picked: the wrong answer here is a wrongly-settled ticket.
  ambiguous: boolean
}

export interface ResolveFopInput {
  fops: ResolvableFop[]
  // Only the assignments that reach THIS client.
  assignments: ResolvableFopAssignment[]
  // Which payer types this client permits, from Corporate Settings. A candidate
  // whose payer is not in the set drops out before ranking — so switching
  // "agency" off means agency cards stop applying to this client, and resolution
  // falls through to whatever else reaches them.
  //
  // Passed in rather than looked up, because this function is pure by design
  // (the same reason resolveDealCodes is). Omitted entirely means no filter,
  // which keeps every existing caller and every test working unchanged.
  allowedPayers?: Set<FopPayer>
  // The client's preference order over the four payment types, most preferred
  // first, from Corporate Settings. Whose money is a business decision, so it
  // outranks every other test below — see compare().
  //
  // Optional for the same reason allowedPayers is: omitted means the default
  // ordering, which keeps every existing caller and every test working.
  paymentPriority?: PaymentType[]
  // The branch servicing this client. A branch-scoped FOP only applies here.
  branchId?: string | null
  airlineCode?: string | null
  // Every leg's booking code. Empty when resolving "what could apply" rather
  // than a real itinerary.
  legBookingCodes?: (string | null | undefined)[]
  now?: Date
}

// Explicitness of intent, lowest first — the same ladder as deal codes, with
// `default` added at the bottom for the unassigned fallback.
const KIND_RANK: Record<FopAssignmentKind | 'default', number> = {
  client: 0,
  bucket: 1,
  client_group: 2,
  default: 3,
}

interface Candidate {
  fop: ResolvableFop
  kind: FopAssignmentKind | 'default'
  viaName: string | null
}

function describeVia(kind: FopAssignmentKind | 'default', viaName: string | null): string {
  if (kind === 'client') return 'Direct assignment'
  if (kind === 'bucket') return viaName ? `Bucket · ${viaName}` : 'Bucket'
  if (kind === 'client_group') return viaName ? `Client group · ${viaName}` : 'Client group'
  return 'Default'
}

// Where this candidate's payment type sits in the client's preference order.
// Anything not in the order sorts last rather than first, so a payment type
// nobody has ranked cannot win by default.
function payerRank(order: PaymentType[], candidate: Candidate): number {
  const index = order.indexOf(paymentTypeOfPayer(candidate.fop.payer))
  return index === -1 ? order.length : index
}

// Negative => a wins. The order of these tests IS the precedence rule.
function makeCompare(order: PaymentType[]) {
  return function compare(a: Candidate, b: Candidate): number {
    // WHOSE MONEY COMES FIRST, ahead of how specifically the card was assigned.
    // "This client pays on their own card, falling back to agency BSP" is a
    // commercial arrangement; whether the card was attached to the client or to
    // a bucket is bookkeeping about how it got here. Before this test existed,
    // a client permitting all three payers settled on whichever card happened to
    // be assigned most specifically — which is to say, by accident.
    const byPayer = payerRank(order, a) - payerRank(order, b)
    if (byPayer !== 0) return byPayer

    const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind]
    if (byKind !== 0) return byKind

    // A branch-specific rule beats a TMC-wide one: the card lodged at this
    // office is the one that settles here.
    const branchRank = (c: Candidate) => (c.fop.branch_id ? 0 : 1)
    const byBranch = branchRank(a) - branchRank(b)
    if (byBranch !== 0) return byBranch

    // Filed against one airline over any airline.
    const airlineRank = (c: Candidate) => (c.fop.airline_code ? 0 : 1)
    const byAirline = airlineRank(a) - airlineRank(b)
    if (byAirline !== 0) return byAirline

    // Narrower class set wins; unrestricted reports Infinity so it sorts last.
    const byRbd = rbdSpecBreadth(a.fop.rbd_spec) - rbdSpecBreadth(b.fop.rbd_spec)
    if (byRbd !== 0) return byRbd

    return b.fop.created_at.localeCompare(a.fop.created_at)
  }
}

function indistinguishable(order: PaymentType[], a: Candidate, b: Candidate): boolean {
  return (
    payerRank(order, a) === payerRank(order, b) &&
    KIND_RANK[a.kind] === KIND_RANK[b.kind] &&
    Boolean(a.fop.branch_id) === Boolean(b.fop.branch_id) &&
    Boolean(a.fop.airline_code) === Boolean(b.fop.airline_code) &&
    rbdSpecBreadth(a.fop.rbd_spec) === rbdSpecBreadth(b.fop.rbd_spec) &&
    a.fop.created_at === b.fop.created_at
  )
}

export function resolveFop(input: ResolveFopInput): ResolvedFop | null {
  const {
    fops,
    assignments,
    allowedPayers,
    paymentPriority = DEFAULT_PAYMENT_PRIORITY,
    branchId = null,
    airlineCode = null,
    legBookingCodes = [],
    now = new Date(),
  } = input

  // An FOP can be assigned more than once (directly and via a bucket, say).
  // Keep the STRONGEST claim per FOP rather than one row per assignment, so the
  // same card does not appear as its own competitor.
  const strongestClaim = new Map<string, Candidate>()

  for (const assignment of assignments) {
    const fop = fops.find(f => f.id === assignment.fop_id)
    if (!fop) continue

    const candidate: Candidate = {
      fop,
      kind: assignment.kind,
      viaName: assignment.via_name ?? null,
    }

    const existing = strongestClaim.get(fop.id)
    if (!existing || KIND_RANK[candidate.kind] < KIND_RANK[existing.kind]) {
      strongestClaim.set(fop.id, candidate)
    }
  }

  // The chosen fallback enters for every client, ranked last. Only this one:
  // a form of payment aimed at somebody else is not a candidate here, and one
  // aimed at nobody is not either — it is simply unused until assigned or
  // marked default.
  for (const fop of fops) {
    if (!fop.is_default) continue
    if (strongestClaim.has(fop.id)) continue
    strongestClaim.set(fop.id, { fop, kind: 'default', viaName: null })
  }

  const eligible = [...strongestClaim.values()].filter(({ fop }) => {
    if (!isUsable(fop, now)) return false

    // The client does not permit this kind of payer. Checked before everything
    // else because it is the bluntest rule here: no amount of branch, airline or
    // class matching makes a disallowed payer applicable.
    if (allowedPayers && !allowedPayers.has(fop.payer)) return false

    // A branch-scoped rule only applies at its branch. A TMC-wide one applies
    // anywhere, including when the client has no branch recorded yet.
    if (fop.branch_id && fop.branch_id !== branchId) return false

    if (fop.airline_code && airlineCode && fop.airline_code.toUpperCase() !== airlineCode.toUpperCase()) {
      return false
    }

    // Only tested against a real itinerary. With no legs in hand this is the
    // "what could apply" view, where a class-restricted rule is still a
    // candidate.
    if (legBookingCodes.length > 0 && !matchesAllLegs(fop.rbd_spec, legBookingCodes)) return false

    return true
  })

  if (eligible.length === 0) return null

  const ranked = [...eligible].sort(makeCompare(paymentPriority))
  const winner = ranked[0]
  const losers = ranked.slice(1)

  return {
    fopId: winner.fop.id,
    label: winner.fop.label,
    description: describeFop(winner.fop),
    fopType: winner.fop.fop_type,
    payer: winner.fop.payer,
    via: describeVia(winner.kind, winner.viaName),
    beat: losers.map(l => ({ label: l.fop.label, via: describeVia(l.kind, l.viaName) })),
    ambiguous: losers.some(l => indistinguishable(paymentPriority, winner, l)),
  }
}
