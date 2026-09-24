import { resolveDealCodes, describeVia, type ResolvableAssignment } from './resolveDealCodes'
import type { FlatFlightResult } from '@/app/lib/book/types'
import type { Queryable } from '@/app/lib/db'
import * as clients from '@/app/lib/repositories/clients'
import * as dealCodes from '@/app/lib/repositories/dealCodes'

// ── stampDealCodes ───────────────────────────────────────────────────────────
// Resolves the deal codes that apply to a booking and returns them for storage
// on the bookings row.
//
// WHY THIS IS STORED RATHER THAN DERIVED LATER
// Assignments change. A booking made in March must still show the code that
// applied in March, not whatever resolves when someone opens it in November —
// the same reason fare_breakdown is snapshotted rather than re-priced.
//
// WHY IT IS STORED AT ALL, GIVEN NOTHING IS TRANSMITTED
// The aggregator API has no field to carry a tour code or an account code, so
// this is the only place a counsellor can read what should have been applied,
// and the only basis finance has for reconciling a negotiated rate. When the
// API grows those fields, the value is already resolved here.
//
// NEVER THROWS. A booking must not fail because a deal code could not be worked
// out — the codes are advisory today. Errors return null and the booking
// proceeds without a stamp, exactly as checkBookingAgainstPolicy lets an
// unconfigured policy through rather than blocking.
// ─────────────────────────────────────────────────────────────────────────────

export interface StampedDealCode {
  airline: string
  codeType: string
  code: string
  via: string
  ambiguous: boolean
  // The deal is filed against specific flights, and the booking payload has no
  // flight number to check it against. Whoever applies the code has to confirm
  // it covers this flight.
  flightRestricted: boolean
}

export async function stampDealCodes(
  db: Queryable,
  clientId: string,
  flight: FlatFlightResult | null
): Promise<StampedDealCode[] | null> {
  try {
    const client = await clients.stampProfile(db, clientId)

    if (!client?.tmc_id) return null

    const [bucketIds, assignmentRows] = await Promise.all([
      clients.bucketIdsOfClient(db, clientId),
      dealCodes.assignmentsForTmc(db, client.tmc_id),
    ])

    const reaching = assignmentRows.filter(a => {
      if (a.kind === 'client') return a.client_id === clientId
      if (a.kind === 'bucket') return a.bucket_id !== null && bucketIds.includes(a.bucket_id)
      return a.client_group_id !== null && a.client_group_id === client.client_group_id
    })

    if (reaching.length === 0) return null

    const dealIds = [...new Set(reaching.map(a => a.deal_code_id))]

    const [deals, buckets, groupName] = await Promise.all([
      dealCodes.forResolution(db, dealIds),
      clients.bucketLabels(db, bucketIds),
      clients.groupNames(db, client.client_group_id ? [client.client_group_id] : []),
    ])

    const assignments: ResolvableAssignment[] = reaching.map(a => ({
      deal_code_id: a.deal_code_id,
      kind: a.kind as ResolvableAssignment['kind'],
      via_name:
        a.kind === 'bucket'
          ? buckets.get(a.bucket_id!)?.name ?? null
          : a.kind === 'client_group'
            ? groupName.get(a.client_group_id!) ?? null
            : null,
    }))

    // Per-leg data now exists, so a flight restriction can finally be CHECKED
    // rather than flagged. This previously passed flightNumber: null and marked
    // every restricted deal "unverifiable", because FlatFlightResult carried one
    // airline and no flight number at all.
    //
    // Resolved once per leg, because a connection can be flown by two carriers
    // and each may carry its own negotiated code.
    const bookingDate = new Date().toISOString().slice(0, 10)

    // Each direction is resolved against ITS OWN departure date.
    //
    // This used to take flight.origin.dateTime — the outbound departure — and
    // apply it to every leg. On a round trip that is simply the wrong date for
    // the return, and a deal code whose validity window closes between the two
    // would be stamped on a return flight it does not actually cover.
    const journeys = flight?.journeys ?? []
    const runs: { airline: string | null; flightNumber: string | null; departure: string | null }[] =
      journeys.length > 0
        ? journeys.flatMap(journey => {
            const departure = journey.origin?.dateTime?.slice(0, 10) ?? null
            return journey.legs.length > 0
              ? journey.legs.map(l => ({
                  airline: l.airlineCode ?? null,
                  flightNumber: l.flightNumber ?? null,
                  departure,
                }))
              : [{ airline: journey.airline?.code ?? null, flightNumber: null, departure }]
          })
        // Falls back to the flat leg list, then to the flight-level airline, so
        // a result mapped before journeys existed still resolves on airline
        // alone rather than resolving nothing.
        : (flight?.legs ?? []).length > 0
          ? flight!.legs!.map(l => ({
              airline: l.airlineCode ?? null,
              flightNumber: l.flightNumber ?? null,
              departure: flight?.origin?.dateTime?.slice(0, 10) ?? null,
            }))
          : [{
              airline: flight?.airline?.code ?? null,
              flightNumber: null,
              departure: flight?.origin?.dateTime?.slice(0, 10) ?? null,
            }]

    const stamped: StampedDealCode[] = []
    const seen = new Set<string>()

    for (const run of runs) {
      const resolved = resolveDealCodes({
        deals,
        assignments,
        airlineCode: run.airline,
        flightNumber: run.flightNumber,
        bookingDate,
        departureDate: run.departure,
      })

      for (const r of resolved) {
        // One winner per airline per type across the whole itinerary — two legs
        // on the same carrier must not stamp the same code twice.
        const key = `${r.airline}::${r.codeType}`
        if (seen.has(key)) continue
        seen.add(key)

        stamped.push({
          airline: r.airline,
          codeType: r.codeType,
          code: r.code,
          via: describeVia(r.kind, r.viaName),
          ambiguous: r.ambiguous,
          // Kept in the shape for older stamped rows, but always false now: a
          // flight-restricted deal that survived resolution was matched against
          // a real flight number rather than waved through.
          flightRestricted: false,
        })
      }
    }

    return stamped.length > 0 ? stamped : null
  } catch (error) {
    console.error('[deal-codes] could not resolve for booking', { clientId, error })
    return null
  }
}
