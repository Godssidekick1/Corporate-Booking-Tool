console.log('ENV:', {
  BASE_URL: process.env.AMADEUS_API_BASE_URL,
  CLIENT_CODE: process.env.AMADEUS_CLIENT_CODE,
  USERNAME: process.env.AMADEUS_USERNAME,
})

import { NextRequest } from 'next/server'
import { amadeus } from '@/app/lib/amadeus/client'

// ── Internal-only route ───────────────────────────────────────────────────────
// Verifies the Amadeus client end-to-end: Login -> FlightAvailability -> Pricing
// No booking is created. Safe to call repeatedly against UAT.
//
// Postman usage:
//   POST /api/internal/test-amadeus
//   Header: x-internal-secret: <INTERNAL_API_SECRET>
//   Body: {
//     "origin": "DEL",
//     "destination": "BOM",
//     "departDate": "20/10/2026",
//     "resultIndex": "1"          -- optional, defaults to "1"
//   }
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
    // ── Step 1: FlightAvailability ─────────────────────────────────────
    const availability = await amadeus.searchFlights({
      segments: [{ Origin: origin, Destination: destination, DepartDate: departDate }],
      adult: 1,
    })

    if (!availability.Availibilities || availability.Availibilities.length === 0) {
      return Response.json({
        ok: false,
        step: 'FlightAvailability',
        error: 'No flights returned — try a different date or route.',
        raw: availability,
      }, { status: 200 })
    }

    // Real shape (confirmed from a live response): Availibilities is an array
    // of wrapper objects, each holding an `Availibility` array of actual
    // flight results. Flatten before indexing by resultIndex.
    const allFlights = availability.Availibilities.flatMap(a => a.Availibility)

    if (allFlights.length === 0) {
      return Response.json({
        ok: false,
        step: 'FlightAvailability',
        error: 'Availibilities array was non-empty but contained no flights.',
        raw: availability,
      }, { status: 200 })
    }

    const idx = Math.max(0, parseInt(resultIndex, 10) - 1)
    const selectedFlight = allFlights[idx] ?? allFlights[0]

    // A single flight's itinerary and pricing live in separate sub-arrays —
    // itinerary (route/timing) and PricingInfos (fare) are siblings, not
    // one flat object.
    const itinerary = selectedFlight.Itineraries?.Itinerary?.[0]
    const firstSegment = itinerary?.FlightSegments?.[0] // adjust if segments live directly under Itinerary
    const pricingInfo = selectedFlight.PricingInfos?.PricingInfo?.[0]

    if (!itinerary || !pricingInfo) {
      return Response.json({
        ok: false,
        step: 'FlightAvailability',
        error: 'Selected flight is missing Itineraries or PricingInfos — check raw shape.',
        raw: selectedFlight,
      }, { status: 200 })
    }

    // ── Step 2: Pricing ────────────────────────────────────────────────
    const pricing = await amadeus.pricing(
  availability.Key,
  pricingInfo.Pricingkey,
  selectedFlight.Provider,
  String(idx + 1)
)
    

    // ── Return diagnostic summary ──────────────────────────────────────
    return Response.json({
      ok: true,
      steps: {
        availability: {
          totalResults: allFlights.length,
          selectedIndex: idx + 1,
          flight: {
            flightKey: selectedFlight.FlightKey,
            provider: selectedFlight.Provider,
            isLcc: selectedFlight.IsLCC,
            itemNo: selectedFlight.ItemNo,
            journey: itinerary.Journey,
            origin: firstSegment?.Origin,
            destination: firstSegment?.Destination,
            airline: firstSegment?.AirLine,
            cabin: firstSegment?.Cabin,
            bookingCode: firstSegment?.BookingCode,
            stopCount: firstSegment?.StopCount,
            duration: firstSegment?.Duration,
            availableSeats: firstSegment?.AvailableSeats,
            baggage: firstSegment?.Baggage,
          },
          pricingInfo: {
            pricingKey: pricingInfo.Pricingkey,
            currency: pricingInfo.Currency,
            total: pricingInfo.Total,
            fareBreakDowns: pricingInfo.FareBreakDowns,
            penalties: pricingInfo.Penalties,
            fareType: pricingInfo.FareType,
            isNdc: pricingInfo.IsNDC,
          },
        },
        // Raw pricing() response — field names not yet confirmed against a
        // live call, unlike availability above. Treat as provisional until
        // verified the same way Availability was.
        pricing: pricing,
      },
    }, { status: 200 })

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    const isAmadeusError = err instanceof Error && err.name === 'AmadeusError'

    return Response.json({
      ok: false,
      error: message,
      type: isAmadeusError ? 'AmadeusError' : 'UnknownError',
    }, { status: 500 })
  }
}