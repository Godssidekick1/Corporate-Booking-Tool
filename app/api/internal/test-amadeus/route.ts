import { NextRequest } from 'next/server'
import { amadeus } from '@/app/lib/amadeus/client'

// ── Internal-only route ───────────────────────────────────────────────────────
// Verifies the Amadeus client end-to-end. Returns the COMPLETE, UNMODIFIED
// raw response from each step — no field selection, no flattening, no
// renaming. This is a debugging tool: the whole point is seeing exactly
// what Amadeus actually sent, not a curated summary that could hide a
// field we didn't think to look for.
//
// This is deliberately different from /api/book/search, which DOES
// reshape data for the frontend — that's a real API boundary transforming
// a third-party vendor shape into our product's own contract. This route
// has no such purpose; it exists purely to inspect raw API behavior.
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-internal-secret')
  if (!secret || secret !== process.env.INTERNAL_API_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { origin, destination, departDate, resultIndex = '1' } = await req.json()

  if (!origin || !destination || !departDate) {
    return Response.json(
      { error: 'origin, destination, and departDate (DD/MM/YYYY) are required' },
      { status: 400 }
    )
  }

  try {
    // ── Step 1: FlightAvailability — raw response, nothing picked out ────
    const availability = await amadeus.searchFlights({
      segments: [{ Origin: origin, Destination: destination, DepartDate: departDate }],
      adult: 1,
    })

    if (!availability.Availibilities || availability.Availibilities.length === 0) {
      return Response.json({
        ok: false,
        step: 'FlightAvailability',
        error: 'No flights returned — try a different date or route.',
        rawAvailabilityResponse: availability,
      }, { status: 200 })
    }

    const allFlights = availability.Availibilities.flatMap(a => a.Availibility)

    // Not every Availability result is guaranteed to have a live, priceable
    // fare in the sandbox (and can happen in production too — a fare can go
    // stale between search and pricing). Try results in order until one
    // prices successfully, rather than assuming index 1 always works.
    const MAX_ATTEMPTS = Math.min(allFlights.length, 10)
    let pricing = null
    let succeededIndex = -1
    let lastError: unknown = null

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const candidate = allFlights[attempt]
      const candidatePricingInfo = candidate.PricingInfos?.PricingInfo?.[0]
      if (!candidatePricingInfo) continue

      try {
        pricing = await amadeus.pricing(
          availability.Key,
          candidatePricingInfo.Pricingkey,
          candidate.Provider,
          candidate.ItemNo,
          availability.SessionID,
        )
        succeededIndex = attempt
        break
      } catch (err) {
        lastError = err
        continue // try the next result
      }
    }

    if (!pricing) {
      const message = lastError instanceof Error ? lastError.message : 'No priceable fare found among available results'
      return Response.json({
        ok: false,
        step: 'Pricing',
        error: `Tried ${MAX_ATTEMPTS} results, none were priceable. Last error: ${message}`,
        totalResultsFound: allFlights.length,
      }, { status: 200 })
    }

    const selectedFlight = allFlights[succeededIndex]
    const pricingInfo = selectedFlight.PricingInfos!.PricingInfo![0]

    // Every raw response returned in full — nothing summarized, nothing
    // renamed, nothing omitted. This is what Amadeus actually sent.
    return Response.json({
      ok: true,
      selectedIndex: succeededIndex + 1,
      totalResultsFound: allFlights.length,
      attemptsNeeded: succeededIndex + 1,
      rawAvailabilityResponse: availability,
      rawSelectedFlight: selectedFlight,
      rawPricingResponse: pricing,
    }, { status: 200 })

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    const isAmadeusError = err instanceof Error && err.name === 'AmadeusError'
    // If it's our AmadeusError type, it carries the raw failed response too —
    // surface that in full rather than just the message.
    const rawErrorResponse = isAmadeusError ? (err as unknown as { raw?: unknown }).raw : undefined

    return Response.json({
      ok: false,
      error: message,
      type: isAmadeusError ? 'AmadeusError' : 'UnknownError',
      rawErrorResponse,
    }, { status: 500 })
  }
}