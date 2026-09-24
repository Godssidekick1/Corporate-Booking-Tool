import { loadClientGates } from '@/app/lib/clients/clientGates'
import { classifyFlight } from '@/app/lib/rule-engine/classifyTrip'
import {
  resolveCommercials,
  type ResolvableRule,
  type ResolvableAssignment,
  type ResolvedCommercials,
} from './resolveCommercials'
import { composeSellPrice, emptyCommercials, type CommercialsRecord } from './composeSellPrice'
import type { FareComponents } from './fareComponents'
import type { FareType, CommercialKind } from './calcOnByKind'
import type { FlatFlightResult } from '@/app/lib/book/types'
import { cabinLetter } from '@/app/lib/book/cabin'
import type { Queryable } from '@/app/lib/db'
import * as clients from '@/app/lib/repositories/clients'
import * as commercials from '@/app/lib/repositories/commercials'
import * as dealCodes from '@/app/lib/repositories/dealCodes'

// ── stampCommercials ─────────────────────────────────────────────────────────
// Price one itinerary for one client: resolve the rules that reach them, run the
// pipeline, hand back the frozen record.
//
// The impure half. Everything it decides is decided by pure functions
// (resolveCommercials, composeSellPrice); this loads what they need and obeys
// the same two rules stampFop and stampDealCodes obey:
//
//   1. IT CANNOT THROW. A search failing because a markup lookup failed would be
//      an absurd trade. Every path is caught and falls back to the airline fare.
//   2. It reads the client's gates, so a kind switched off in Corporate Settings
//      resolves to nothing.
//
// ONE QUERY FOR THE RULES, not one per kind — the whole reason markup, discount
// and processing fee share a table.
// ─────────────────────────────────────────────────────────────────────────────

// ── categoryCodeForFlight ────────────────────────────────────────────────────
// The booking's own category, derived rather than asked for.
//
// deal_code_categories has existed since the deal code master and nothing has
// ever read it — it labelled a deal and gated which code types could be filed,
// and that was all. It becomes a real matching dimension here, and it can,
// because both halves are already in hand: classifyFlight() gives
// domestic/international and FlatFlightResult.isLcc gives BSP vs LCC.
//
// Matches the four seeded codes exactly. A TMC that has added its own category
// simply will not match on this axis, which is the correct behaviour — a rule
// filed against a category we cannot derive should not apply by accident.
export function categoryCodeForFlight(flight: FlatFlightResult): string {
  const trip = classifyFlight(flight) === 'domestic' ? 'DOM' : 'INT'
  const settlement = flight.isLcc ? 'LCC' : 'BSP'
  return `${trip}AIR${settlement}`
}

// How many sectors a processing fee charged per sector multiplies by. Legs, not
// stops: a DEL-BOM-DXB itinerary is two sectors, and stopCount would say one.
//
// `legs` is flat across every direction, which is what makes this come out
// right for a round trip: DEL-BOM plus BOM-DEL is two flown sectors, and a
// per-sector fee should charge for both.
export function sectorCount(flight: FlatFlightResult | null): number {
  if (!flight) return 1
  if (flight.legs && flight.legs.length > 0) return flight.legs.length

  // Fall back by summing each direction's own stops. `stopCount` is per
  // journey now, so the old flight-level `stopCount + 1` would count the
  // outbound's hops alone and under-charge a round trip by half.
  const journeys = flight.journeys ?? []
  if (journeys.length > 0) {
    return Math.max(1, journeys.reduce((total, j) => total + (j.stopCount ?? 0) + 1, 0))
  }

  return Math.max(1, (flight.stopCount ?? 0) + 1)
}

export interface StampedCommercials {
  record: CommercialsRecord
  resolved: ResolvedCommercials
}

// ── CommercialContext ────────────────────────────────────────────────────────
// Everything needed to price ANY itinerary for one client, loaded once.
//
// This split exists for search. A search returns thirty results and every one of
// them needs a markup; resolving each independently would mean thirty copies of
// the same four queries, plus a category lookup per result. The context is
// loaded once per request and then applied in memory, which is the difference
// between five queries and a hundred and fifty on the most latency-sensitive
// request in the product.
// ─────────────────────────────────────────────────────────────────────────────
export interface CommercialContext {
  rules: ResolvableRule[]
  assignments: ResolvableAssignment[]
  // category CODE -> id, for this TMC. Fetched whole because there are four of
  // them per TMC by default and a lookup per flight would defeat the point.
  categoryIdByCode: Map<string, string>
  enabledKinds: Set<CommercialKind>
}

// An empty context prices everything at the airline fare. Returned by every
// failure path so no caller has to distinguish "no rules" from "could not load".
const EMPTY_CONTEXT: CommercialContext = {
  rules: [],
  assignments: [],
  categoryIdByCode: new Map(),
  enabledKinds: new Set(),
}

export async function loadCommercialContext(
  db: Queryable,
  clientId: string | null | undefined
): Promise<CommercialContext> {
  if (!clientId) return EMPTY_CONTEXT

  try {
    const client = await clients.stampProfile(db, clientId)

    if (!client?.tmc_id) return EMPTY_CONTEXT
    const tmcId = client.tmc_id

    const [gates, rules, bucketIds, assignmentRows, categoryIdByCode] = await Promise.all([
      loadClientGates(db, clientId),
      commercials.rulesForTmc(db, tmcId),
      clients.bucketIdsOfClient(db, clientId),
      commercials.assignmentsForTmc(db, tmcId),
      dealCodes.categoryIdsByCode(db, tmcId),
    ])

    if (rules.length === 0) return EMPTY_CONTEXT

    // Which assignments actually reach this client. Same three-branch filter
    // stampFop and stampDealCodes use, kept identical on purpose: three copies
    // that agree are easier to trust than one abstraction nobody reads.
    const reaching = assignmentRows.filter(a => {
      if (a.kind === 'client') return a.client_id === clientId
      if (a.kind === 'bucket') return a.bucket_id !== null && bucketIds.includes(a.bucket_id)
      return a.client_group_id !== null && a.client_group_id === client.client_group_id
    })

    if (reaching.length === 0) return EMPTY_CONTEXT

    // Names only for the routes that actually reached this client — no point
    // fetching every bucket in the TMC to label two of them.
    const usedBucketIds = [...new Set(reaching.map(a => a.bucket_id).filter((b): b is string => Boolean(b)))]

    const [buckets, groupName] = await Promise.all([
      clients.bucketLabels(db, usedBucketIds),
      clients.groupNames(db, client.client_group_id ? [client.client_group_id] : []),
    ])

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

    return {
      rules,
      assignments,
      categoryIdByCode,
      enabledKinds: gates.enabledCommercialKinds,
    }
  } catch (error) {
    // Swallowed on purpose — rule 1 in the header. A booking priced at the
    // airline fare is a lost margin; a booking that cannot be priced at all is
    // a lost sale.
    console.error('[commercials] could not load rules, pricing at the airline fare', {
      clientId,
      error,
    })
    return EMPTY_CONTEXT
  }
}

// ── priceWithContext ─────────────────────────────────────────────────────────
// Price one itinerary against an already-loaded context. No I/O, so it can be
// called thirty times in a loop over search results without thirty round trips.
// ─────────────────────────────────────────────────────────────────────────────

export interface PriceInput {
  flight: FlatFlightResult | null
  components: FareComponents
  pax: number
  // Which fare type this booking is. Null matches rules filed for 'all' only.
  // Nothing in the booking flow chooses one yet; the parameter exists so the
  // engine is not rewritten when it does.
  fareType?: FareType | null
  pricedOn?: string
}

export function priceWithContext(
  context: CommercialContext,
  input: PriceInput
): StampedCommercials {
  const { flight, components, pax, fareType = null, pricedOn } = input

  if (context.rules.length === 0) {
    // An empty trace, not a missing one: no rule reaches this client, so there
    // is nothing that could have matched and nothing to explain.
    return {
      record: emptyCommercials(components),
      resolved: { markup: null, discount: null, processing_fee: null, trace: [] },
    }
  }

  const resolved = resolveCommercials({
    rules: context.rules,
    assignments: context.assignments,
    categoryId: flight ? context.categoryIdByCode.get(categoryCodeForFlight(flight)) ?? null : null,
    airlineCode: flight?.legs?.[0]?.airlineCode ?? flight?.airline?.code ?? null,
    // Converted to the letter our rules store. flight.cabin is the provider's
    // PaxCabin — the WORD "Economy" — while commercial_rules.cabin is
    // constrained to 'Y'|'W'|'C'|'F'. Passing it through raw compared 'Y'
    // against 'ECONOMY', so every rule with a cabin restriction failed to match,
    // always. See app/lib/book/cabin.ts.
    cabin: cabinLetter(flight?.cabin),
    legBookingCodes: (flight?.legs ?? []).map(l => l.bookingCode),
    fareType,
    pricedOn,
    enabledKinds: context.enabledKinds,
  })

  return {
    record: composeSellPrice({ components, resolved, pax, sectors: sectorCount(flight) }),
    resolved,
  }
}

// ── stampCommercials ─────────────────────────────────────────────────────────
// The one-shot form: load and price in a single call. For the paths that price
// exactly one itinerary — /api/book/price, add-passenger, refresh-fare. Search
// uses loadCommercialContext + priceWithContext instead.
// ─────────────────────────────────────────────────────────────────────────────
export async function stampCommercials(
  db: Queryable,
  input: PriceInput & { clientId: string }
): Promise<StampedCommercials> {
  const context = await loadCommercialContext(db, input.clientId)
  return priceWithContext(context, input)
}
