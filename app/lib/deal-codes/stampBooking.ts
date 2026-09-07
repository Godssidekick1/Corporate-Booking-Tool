import { createServiceClient } from '@/utils/supabase/service'
import { resolveDealCodes, describeVia, type ResolvableAssignment } from './resolveDealCodes'
import type { FlatFlightResult } from '@/app/lib/book/types'

type ServiceClient = ReturnType<typeof createServiceClient>

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
  service: ServiceClient,
  clientId: string,
  flight: FlatFlightResult | null
): Promise<StampedDealCode[] | null> {
  try {
    const { data: client } = await service
      .from('clients')
      .select('id, tmc_id, client_group_id')
      .eq('id', clientId)
      .maybeSingle()

    if (!client) return null

    const { data: bucketRows } = await service
      .from('bucket_clients')
      .select('bucket_id')
      .eq('client_id', clientId)

    const bucketIds = (bucketRows ?? []).map(b => b.bucket_id)

    const { data: assignmentRows } = await service
      .from('deal_code_assignments')
      .select('deal_code_id, kind, client_id, client_group_id, bucket_id')
      .eq('tmc_id', client.tmc_id)

    const reaching = (assignmentRows ?? []).filter(a => {
      if (a.kind === 'client') return a.client_id === clientId
      if (a.kind === 'bucket') return a.bucket_id !== null && bucketIds.includes(a.bucket_id)
      return a.client_group_id !== null && a.client_group_id === client.client_group_id
    })

    if (reaching.length === 0) return null

    const dealIds = [...new Set(reaching.map(a => a.deal_code_id))]

    const [{ data: deals }, { data: buckets }, { data: groups }] = await Promise.all([
      service
        .from('deal_codes')
        .select(
          'id, code, code_type, airline_code, flight_spec, active, sales_from, sales_to, travel_from, travel_to, created_at'
        )
        .in('id', dealIds),
      bucketIds.length
        ? service.from('buckets').select('id, name').in('id', bucketIds)
        : Promise.resolve({ data: [] }),
      client.client_group_id
        ? service.from('client_groups').select('id, name').eq('id', client.client_group_id)
        : Promise.resolve({ data: [] }),
    ])

    const bucketName = new Map((buckets ?? []).map(b => [b.id, b.name]))
    const groupName = new Map((groups ?? []).map(g => [g.id, g.name]))

    const assignments: ResolvableAssignment[] = reaching.map(a => ({
      deal_code_id: a.deal_code_id,
      kind: a.kind,
      via_name:
        a.kind === 'bucket'
          ? bucketName.get(a.bucket_id!) ?? null
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
    const legs = flight?.legs ?? []
    const departure = flight?.origin?.dateTime?.slice(0, 10) ?? null
    const bookingDate = new Date().toISOString().slice(0, 10)

    // Falls back to the flight-level airline for a result whose legs were not
    // mapped, so an unmapped payload still resolves on airline alone.
    const runs = legs.length > 0
      ? legs.map(l => ({ airline: l.airlineCode ?? null, flightNumber: l.flightNumber ?? null }))
      : [{ airline: flight?.airline?.code ?? null, flightNumber: null }]

    const stamped: StampedDealCode[] = []
    const seen = new Set<string>()

    for (const run of runs) {
      const resolved = resolveDealCodes({
        deals: deals ?? [],
        assignments,
        airlineCode: run.airline,
        flightNumber: run.flightNumber,
        bookingDate,
        departureDate: departure,
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
