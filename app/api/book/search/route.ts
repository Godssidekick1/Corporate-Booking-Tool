import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { amadeus, AmadeusError, sanitizeAmadeusDiagnostic } from '@/app/lib/amadeus/client'
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
export interface StopInfo {
  code: string
  city: string
  arrivalDateTime: string
  departureDateTime: string | undefined
}

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
  stopCount: number           // 0, 1, 2 — number of stops
  stops: StopInfo[]           // intermediate stop details
  duration: string | undefined
  availableSeats: number | undefined
  checkInBaggageKg: string | undefined
  pricingKey: string | undefined
  currency: string | undefined
  totalFare: number | undefined
  baseFare: number | undefined
  isNdc: boolean | undefined
  refundable: boolean | undefined
}

function isValidTravelDate(value: string): boolean {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value)
  if (!match) return false

  const [, day, month, year] = match.map(Number)
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return false

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return date >= today
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

  const normalizedOrigin = origin.trim().toUpperCase()
  const normalizedDestination = destination.trim().toUpperCase()
  const passengerCounts = [adult, child, infant]
  if (!/^[A-Z]{3}$/.test(normalizedOrigin) || !/^[A-Z]{3}$/.test(normalizedDestination)) {
    return Response.json({ error: 'Origin and destination must be three-letter IATA airport codes.' }, { status: 400 })
  }
  if (normalizedOrigin === normalizedDestination) {
    return Response.json({ error: 'Origin and destination must be different airports.' }, { status: 400 })
  }
  if (!isValidTravelDate(departDate)) {
    return Response.json({ error: 'departDate must be today or a future date in DD/MM/YYYY format.' }, { status: 400 })
  }
  if (!passengerCounts.every(count => Number.isInteger(count) && count >= 0) || adult < 1 || adult + child + infant > 9) {
    return Response.json({ error: 'Passenger counts must be whole numbers with at least one adult and no more than nine travelers.' }, { status: 400 })
  }

  try {
    const availability = await amadeus.searchFlights({
      segments: [{ Origin: normalizedOrigin, Destination: normalizedDestination, DepartDate: departDate }],
      adult, child, infant,
    })

    if (!availability.Availibilities || availability.Availibilities.length === 0) {
  return Response.json({ ok: true, results: [], availabilityKey: null, sessionId: null })
}

    const allFlights = availability.Availibilities.flatMap(a => a.Availibility)

  const results: FlatFlightResult[] = allFlights.map(flight => {
  const itineraries = flight.Itineraries?.Itinerary ?? []
  const firstLeg = itineraries[0]
  const lastLeg = itineraries[itineraries.length - 1]
  const pricingInfo = flight.PricingInfos?.PricingInfo?.[0]
  const fareBreakdown = pricingInfo?.FareBreakDowns?.FareBreakDown?.[0]

  // Stops are intermediate points — all leg destinations except the final one
  const stops = itineraries.slice(0, -1).map(leg => ({
    code: leg.Destination.AirportCode,
    city: leg.Destination.CityName,
    arrivalDateTime: leg.Destination.DateTime,
    departureDateTime: itineraries[itineraries.indexOf(leg) + 1]?.Origin.DateTime,
  }))

  return {
    flightKey: flight.FlightKey,
    provider: flight.Provider,
    isLcc: String(flight.IsLCC) === 'true',
    itemNo: flight.ItemNo ?? '',
    cabin: pricingInfo?.FareInfos?.FareInfo?.[0]?.PaxCabin ?? firstLeg?.Cabin,
    bookingCode: firstLeg?.BookingCode,
    origin: firstLeg?.Origin ? {
      code: firstLeg.Origin.AirportCode,
      name: firstLeg.Origin.AirportName,
      city: firstLeg.Origin.CityName,
      dateTime: firstLeg.Origin.DateTime,
    } : undefined,
    destination: lastLeg?.Destination ? {
      code: lastLeg.Destination.AirportCode,
      name: lastLeg.Destination.AirportName,
      city: lastLeg.Destination.CityName,
      dateTime: lastLeg.Destination.DateTime,
    } : undefined,
    stops,
    airline: firstLeg?.AirLine ? {
      code: firstLeg.AirLine.OperatingCarrier || firstLeg.AirLine.Code,
      name: firstLeg.AirLine.Name,
    } : undefined,
    stopCount: itineraries.length - 1,
    duration: firstLeg?.Duration,
    availableSeats: firstLeg?.AvailableSeats ? parseInt(firstLeg.AvailableSeats) || undefined : undefined,
    checkInBaggageKg: firstLeg?.Baggage?.Allowance?.CheckIn,
    isNdc: pricingInfo?.IsNDC,
    pricingKey: pricingInfo?.Pricingkey,
    currency: pricingInfo?.Currency,
    totalFare: pricingInfo?.Total?.Fare ? Number(pricingInfo.Total.Fare) : undefined,
    baseFare: pricingInfo?.Total?.BaseFare ? Number(pricingInfo.Total.BaseFare) : undefined,
    refundable: fareBreakdown?.Refundable === 'Refundable',
  }
})

    return Response.json({
  ok: true,
  results,
  availabilityKey: availability.Key,
  sessionId: availability.SessionID,   // NEW — needed for Pricing to run under the same session that produced these results
})

  } catch (err) {
    if (err instanceof AmadeusError) {
      console.error('Flight search error', {
        requestId: err.requestId,
        code: err.code,
        category: err.category,
        request: sanitizeAmadeusDiagnostic(err.requestBody),
        raw: sanitizeAmadeusDiagnostic(err.raw),
      })
      return Response.json({
        error: err.message,
        requestId: err.requestId,
        request: sanitizeAmadeusDiagnostic(err.requestBody),
        details: sanitizeAmadeusDiagnostic(err.raw),
      }, { status: 502 })
    }

    console.error('Flight search error:', err)
    return Response.json({ error: 'Flight search failed' }, { status: 500 })
  }
}

