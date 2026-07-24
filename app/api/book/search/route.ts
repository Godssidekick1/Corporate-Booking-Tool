import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { amadeus } from '@/app/lib/amadeus/client'
import { NextRequest } from 'next/server'

// ── POST /api/book/search ────────────────────────────────────────────
// Real flight search for the booking UI. Any authenticated employee (or TC,
// once CBT search is wired up) can call this — no special permission beyond
// being logged in, since searching doesn't commit to anything.
// ─────────────────────────────────────────────────────────────────────────────

interface SearchBody {
  origin: string
  destination: string
  departDate: string // DD/MM/YYYY, matching Amadeus's expected format
  adult?: number
  child?: number
  infant?: number
}

// Flattened, frontend-friendly shape — the raw Amadeus nesting
// (Availibilities -> Availibility -> Itineraries.Itinerary -> FlightSegments)
// is real but awkward to consume directly in React; this route flattens it
// once, server-side, so the page doesn't have to know about that structure.
export interface FlatFlightResult {
  flightKey: string
  provider: string
  isLcc: boolean
  itemNo: string
  cabin: string | undefined
  bookingCode: string | undefined
  origin: { code: string; name: string; city: string; dateTime: string } | undefined
  destination: { code: string; name: string; city: string; dateTime: string } | undefined
  airline: { code: string; name: string } | undefined
  stopCount: number | undefined
  duration: string | undefined
  availableSeats: number | undefined
  baggage: string | undefined
  pricingKey: string | undefined
  currency: string | undefined
  totalFare: number | undefined
  baseFare: number | undefined
  refundable: boolean | undefined
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const { data: employee } = await service
    .from('employees')
    .select('id, company_id')
    .eq('id', user.id)
    .maybeSingle()

  if (!employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  const body: SearchBody = await req.json()
  const { origin, destination, departDate, adult = 1, child = 0, infant = 0 } = body

  if (!origin || !destination || !departDate) {
    return Response.json(
      { error: 'origin, destination, and departDate (DD/MM/YYYY) are required' },
      { status: 400 }
    )
  }

  try {
    const availability = await amadeus.searchFlights({
      segments: [{ Origin: origin.toUpperCase(), Destination: destination.toUpperCase(), DepartDate: departDate }],
      adult, child, infant,
    })

    if (!availability.Availibilities || availability.Availibilities.length === 0) {
      return Response.json({ ok: true, results: [], availabilityKey: null })
    }

    const allFlights = availability.Availibilities.flatMap(a => a.Availibility)

    const results: FlatFlightResult[] = allFlights.map(flight => {
      const itinerary = flight.Itineraries?.Itinerary?.[0]
      const segment = itinerary?.FlightSegments?.[0]
      const pricingInfo = flight.PricingInfos?.PricingInfo?.[0]
      const fareBreakdown = pricingInfo?.FareBreakDowns?.FareBreakDown?.[0]

      return {
        flightKey: flight.FlightKey,
        provider: flight.Provider,
        isLcc: flight.IsLCC,
        itemNo: flight.ItemNo,
        cabin: segment?.Cabin,
        bookingCode: segment?.BookingCode,
        origin: segment?.Origin ? {
          code: segment.Origin.AirportCode, name: segment.Origin.AirportName,
          city: segment.Origin.CityName, dateTime: segment.Origin.DateTime,
        } : undefined,
        destination: segment?.Destination ? {
          code: segment.Destination.AirportCode, name: segment.Destination.AirportName,
          city: segment.Destination.CityName, dateTime: segment.Destination.DateTime,
        } : undefined,
        airline: segment?.AirLine ? { code: segment.AirLine.Code, name: segment.AirLine.Name } : undefined,
        stopCount: segment?.StopCount,
        duration: segment?.Duration,
        availableSeats: segment?.AvailableSeats,
        baggage: segment?.Baggage,
        pricingKey: pricingInfo?.Pricingkey,
        currency: pricingInfo?.Currency,
        totalFare: pricingInfo?.Total?.Fare,
        baseFare: pricingInfo?.Total?.BaseFare,
        refundable: fareBreakdown?.Refundable,
      }
    })

    return Response.json({
      ok: true,
      results,
      availabilityKey: availability.Key,
    })

  } catch (err) {
    console.error('Flight search error:', err)
    const message = err instanceof Error ? err.message : 'Flight search failed'
    return Response.json({ error: message }, { status: 500 })
  }
}