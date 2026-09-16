import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { amadeus, AmadeusError, sanitizeAmadeusDiagnostic } from '@/app/lib/amadeus/client'
import { harvestAirlines } from '@/app/lib/reference/harvestAirlines'
import {
  loadCommercialContext, priceWithContext, type CommercialContext,
} from '@/app/lib/commercials/stampCommercials'
import { round2 } from '@/app/lib/commercials/fareComponents'
import type {
  FlatFlightResult, FareOption, Journey, StopInfo, PenaltyLine,
} from '@/app/lib/book/types'
import type { ItineraryInfo } from '@/app/lib/amadeus/client'
import { NextRequest, after } from 'next/server'

// ── POST /api/book/search ────────────────────────────────────────────
// Real flight search for the booking UI. Any authenticated employee (or TC,
// once CBT search is wired up) can call this — no special permission beyond
// being logged in, since searching doesn't commit to anything.
// ─────────────────────────────────────────────────────────────────────────────

interface SearchBody {
  origin: string
  destination: string
  departDate: string // DD/MM/YYYY, matching Amadeus's expected format
  // Present only for a return trip. The provider has no `returnDate` field —
  // a round trip is expressed as a SECOND SEGMENT whose DepartDate is the
  // return, plus RTF: true. See the searchFlights call below.
  returnDate?: string
  tripType?: 'oneway' | 'return'
  adult?: number
  child?: number
  infant?: number
}

// FlatFlightResult, FareOption, Journey, StopInfo, PenaltyLine and TaxLine used
// to be declared here AND in app/lib/book/types.ts, and the two copies had
// already drifted — this one omitted `legs`, which every page reading the lib
// type believed it had. They are imported now, so there is one definition of
// what a search result is. Nothing outside this file ever imported the copies.

// ── groupIntoJourneys ────────────────────────────────────────────────────────
// Split the provider's flat itinerary list into directions.
//
// `Itineraries.Itinerary[]` is one entry per FLOWN SEGMENT across the whole
// result, with two different index fields on each, and reading the wrong one
// quietly produces nonsense:
//
//   Flight  which direction   "1" = outbound, "2" = return
//   Leg     which hop within  a connecting outbound is Flight 1, Legs 1 and 2
//
// Confirmed against a real round-trip payload: both entries carried
// `"leg": "1"` and differed only by `"flight"`. TotalDuration[] is keyed by
// `flight` for the same reason.
//
// Segments with no Flight value fall into journey 1, which is what a one-way
// response looks like and keeps this total.
function groupIntoJourneys(itineraries: ItineraryInfo[]): Map<number, ItineraryInfo[]> {
  const byJourney = new Map<number, ItineraryInfo[]>()

  for (const segment of itineraries) {
    const journeyNo = Number(segment.Flight) || 1
    const existing = byJourney.get(journeyNo)
    if (existing) existing.push(segment)
    else byJourney.set(journeyNo, [segment])
  }

  return new Map([...byJourney.entries()].sort((a, b) => a[0] - b[0]))
}

// One allowance for a whole direction, or none.
//
// Baggage is filed per flown segment. When a connection's segments disagree —
// 15kg on the first hop, 20kg on the second — there is no single true answer,
// and picking one to display is how a traveller gets surprised at a gate. We
// state the allowance only when the direction speaks with one voice.
function sharedAllowance(segments: ItineraryInfo[], pick: 'CheckIn' | 'Cabin'): string | undefined {
  const values = segments.map(s => s.Baggage?.Allowance?.[pick] || undefined)
  const first = values[0]
  if (!first) return undefined
  return values.every(v => v === first) ? first : undefined
}

// ── applyMarkup ──────────────────────────────────────────────────────────────
// Inflate one search result by whatever markup reaches this client, and strip
// every trace of the airline's own figures from it.
//
// THE MARKUP GOES ON THE BASE FARE AS WELL AS THE TOTAL, deliberately. Adding it
// to the total alone would leave base + tax ≠ total, and a traveller who adds up
// the fare breakdown would find an unexplained difference — which is exactly the
// thing that must not be discoverable. Moving base and total together reads as a
// pricier fare, which is what it is meant to look like.
//
// taxLines and fuelSurcharge are REMOVED on the way out. They are airline data
// the browser has no use for, and anything sent is visible in devtools.
function applyMarkup(
  context: CommercialContext,
  result: FlatFlightResult,
  pax: number
): FlatFlightResult {
  function markupFor(option: { baseFare?: number; totalFare?: number; tax?: number; taxLines?: { code: string; amount: number }[]; fuelSurcharge?: number }): number {
    if (context.rules.length === 0) return 0
    if (option.totalFare === undefined || option.baseFare === undefined) return 0

    const { record } = priceWithContext(context, {
      flight: result,
      components: {
        base: option.baseFare,
        otherTax: option.tax ?? 0,
        fuelSurcharge: option.fuelSurcharge ?? 0,
        taxLines: option.taxLines ?? [],
        total: option.totalFare,
      },
      pax,
    })

    // Only the embedded adjustment. Discount and fee are resolved by the same
    // call — they have to be, since markup is calculated on the discounted
    // amount — but neither is applied to a search row.
    return record.adjustments.find(a => a.source === 'markup')?.amount ?? 0
  }

  const fareOptions = result.fareOptions.map(option => {
    const markup = markupFor(option)
    return {
      ...option,
      baseFare: option.baseFare !== undefined ? round2(option.baseFare + markup) : undefined,
      totalFare: option.totalFare !== undefined ? round2(option.totalFare + markup) : undefined,
      taxLines: undefined,
      fuelSurcharge: undefined,
    }
  })

  // The top-level fare fields mirror fareOptions[0], as they already did.
  const primary = fareOptions[0]

  return {
    ...result,
    fareOptions,
    baseFare: primary?.baseFare,
    totalFare: primary?.totalFare,
  }
}

// "26/09/2026" -> "20260926". Lets two DD/MM/YYYY dates be compared with a
// plain string comparison, with no Date parsing and so no timezone in play.
function sortableDate(value: string): string {
  const [day, month, year] = value.split('/')
  return `${year}${month}${day}`
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
    .select('id, client_id')
    .eq('id', user.id)
    .maybeSingle()

  if (!employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  const body: SearchBody = await req.json()
  const { origin, destination, departDate, returnDate, tripType, adult = 1, child = 0, infant = 0 } = body
  // A return date is what makes this a round trip, not the tripType label — the
  // label is what the form last had selected and can disagree with the fields.
  const isReturn = tripType === 'return' && Boolean(returnDate)

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
  if (tripType === 'return' && !returnDate) {
    return Response.json({ error: 'A return date is required for a round trip.' }, { status: 400 })
  }
  if (returnDate) {
    if (!isValidTravelDate(returnDate)) {
      return Response.json({ error: 'returnDate must be today or a future date in DD/MM/YYYY format.' }, { status: 400 })
    }
    // Compared as sortable YYYYMMDD rather than as Date objects, for the same
    // reason dealCodeStatus compares date STRINGS: parsing drags the server's
    // timezone in, and "same day" is a legitimate same-day return.
    if (sortableDate(returnDate) < sortableDate(departDate)) {
      return Response.json({ error: 'The return date cannot be before the departure date.' }, { status: 400 })
    }
  }
  if (!passengerCounts.every(count => Number.isInteger(count) && count >= 0) || adult < 1 || adult + child + infant > 9) {
    return Response.json({ error: 'Passenger counts must be whole numbers with at least one adult and no more than nine travelers.' }, { status: 400 })
  }

  try {
    // A round trip is a second segment flying the route back, plus RTF: true.
    // Both have been supported by the client layer since it was written and
    // never once exercised — no caller had ever set either.
    //
    // RTF asks for a combined return fare rather than two priced-apart
    // one-ways, which is why the response comes back as ONE result carrying one
    // pricingKey for both directions, and why the price and add-passenger
    // routes need no changes to book one.
    // Started BEFORE the provider call and awaited after it, not called in
    // sequence afterwards.
    //
    // Loading the commercial context is five queries, and it depends only on
    // employee.client_id — nothing in the availability response. Running it
    // after the search meant those five round trips were added to the wall
    // clock of the most latency-sensitive request in the product, for no
    // reason: they could have been in flight the whole time the provider was
    // thinking. Overlapping them makes the slower of the two the cost instead
    // of the sum.
    //
    // No floating-promise risk: it is awaited unconditionally below, inside the
    // same try, so a rejection surfaces here like any other. loadCommercialContext
    // does not throw in any case — it returns an empty context on failure.
    const contextPromise = loadCommercialContext(service, employee.client_id)

    const availability = await amadeus.searchFlights({
      segments: isReturn
        ? [
            { Origin: normalizedOrigin, Destination: normalizedDestination, DepartDate: departDate },
            { Origin: normalizedDestination, Destination: normalizedOrigin, DepartDate: returnDate! },
          ]
        : [{ Origin: normalizedOrigin, Destination: normalizedDestination, DepartDate: departDate }],
      rtf: isReturn,
      adult, child, infant,
    })

    if (!availability.Availibilities || availability.Availibilities.length === 0) {
  return Response.json({ ok: true, results: [], availabilityKey: null})
}

    const allFlights = availability.Availibilities.flatMap(a => a.Availibility)

    // Record the carriers in this response so the deal-code and FOP editors have
    // a list to pick from instead of a free-typed two-character box.
    //
    // Scheduled with after(), so it runs once the response has been sent and adds
    // nothing to what the traveller waits for — this is the most latency-
    // sensitive request in the product. harvestAirlines cannot throw.
    //
    // Deliberately reads allFlights, NOT the mapped `results` below: the map
    // keeps only the first leg's carrier, so harvesting from it would miss the
    // operating carrier on every connecting itinerary — which is precisely the
    // long tail worth capturing.
    after(() => harvestAirlines(allFlights))

  const results: FlatFlightResult[] = allFlights.map(flight => {
  const itineraries = flight.Itineraries?.Itinerary ?? []
  const allPricingInfos = flight.PricingInfos?.PricingInfo ?? []

  // ── Journeys ──────────────────────────────────────────────────────────────
  // Split by direction BEFORE anything is derived from the segment list, so
  // that "stops", "duration" and "baggage" all mean the same thing they always
  // did — they are just scoped to one direction now.
  const journeyGroups = [...groupIntoJourneys(itineraries).entries()]

  // Field casing isn't guaranteed consistent with the rest of the API's
  // PascalCase, so both are read. Matched BY JOURNEY rather than taken from
  // index 0 — TotalDuration is [{flight:"1",...},{flight:"2",...}] on a round
  // trip, and taking [0] reported the outbound's duration for the whole trip.
  const durationForJourney = (journeyNo: number): string | undefined => {
    const entries = (flight.TotalDuration ?? []) as Record<string, unknown>[]
    const match = entries.find(e => Number(e.flight ?? e.Flight) === journeyNo) ?? (entries.length === 1 ? entries[0] : undefined)
    return (match?.text ?? match?.Text) as string | undefined
  }

  const journeys: Journey[] = journeyGroups.map(([journeyNo, segments]) => {
    const first = segments[0]
    const last = segments[segments.length - 1]

    // Intermediate points within THIS direction. On a round trip the turnaround
    // is not in here, because it is the boundary between two journeys rather
    // than a connection inside one.
    const stops: StopInfo[] = segments.slice(0, -1).map((segment, i) => ({
      code: segment.Destination.AirportCode,
      city: segment.Destination.CityName,
      arrivalDateTime: segment.Destination.DateTime,
      departureDateTime: segments[i + 1]?.Origin.DateTime,
    }))

    return {
      journeyNo,
      origin: first?.Origin ? {
        code: first.Origin.AirportCode,
        name: first.Origin.AirportName,
        city: first.Origin.CityName,
        dateTime: first.Origin.DateTime,
        terminal: first.Origin.Terminal || undefined,
      } : undefined,
      destination: last?.Destination ? {
        code: last.Destination.AirportCode,
        name: last.Destination.AirportName,
        city: last.Destination.CityName,
        dateTime: last.Destination.DateTime,
        terminal: last.Destination.Terminal || undefined,
      } : undefined,
      airline: first?.AirLine ? {
        code: first.AirLine.OperatingCarrier || first.AirLine.Code,
        name: first.AirLine.Name,
      } : undefined,
      stops,
      stopCount: segments.length - 1,
      duration: first?.Duration,
      totalDuration: durationForJourney(journeyNo),
      // flightNumber comes from AirLine.Identification ("9726"), NOT from
      // ItineraryInfo.Flight. This read `leg.Flight` until the round-trip
      // payload made the distinction visible, and `Flight` is the journey
      // index — so every leg was carrying a flight number of "1", and a
      // deal code restricted to a flight-number range was being matched
      // against "1" instead of against the flight actually being flown.
      legs: segments.map(segment => ({
        airlineCode: segment.AirLine?.OperatingCarrier || segment.AirLine?.Code,
        flightNumber: segment.AirLine?.Identification || undefined,
        bookingCode: segment.BookingCode,
        cabin: segment.Cabin,
      })),
      availableSeats: first?.AvailableSeats ? parseInt(first.AvailableSeats) || undefined : undefined,
      checkInBaggageKg: sharedAllowance(segments, 'CheckIn'),
      cabinBaggageKg: sharedAllowance(segments, 'Cabin'),
    }
  })

  const outbound = journeys[0]

  const fareOptions: FareOption[] = allPricingInfos.map(pricingInfo => {
    const fareBreakdown = pricingInfo.FareBreakDowns?.FareBreakDown?.[0]

    // One basis code per direction. FareInfo has an entry per (journey × pax
    // type); a round trip prices each direction under its own code, and a real
    // payload showed SK1YXYII outbound against TU1YXRII inbound. Reading
    // FareInfo[0] alone showed the outbound and hid the return.
    //
    // Deduplicated by journey because the same code repeats across pax types.
    const fareBases: { journeyNo: number; code: string }[] = []
    for (const info of pricingInfo.FareInfos?.FareInfo ?? []) {
      const code = info.PaxFareBasis
      if (!code) continue
      const journeyNo = Number(info.Flight) || 1
      if (fareBases.some(f => f.journeyNo === journeyNo)) continue
      fareBases.push({ journeyNo, code })
    }
    fareBases.sort((a, b) => a.journeyNo - b.journeyNo)

    const toPenaltyLines = (lines?: { PaxType: string; Type: string; Text: string }[]): PenaltyLine[] =>
      (lines ?? []).map(p => ({ paxType: p.PaxType, text: p.Text.trim() }))

    return {
      pricingKey: pricingInfo.Pricingkey,
      currency: pricingInfo.Currency,
      totalFare: pricingInfo.Total?.Fare ? Number(pricingInfo.Total.Fare) : undefined,
      baseFare: pricingInfo.Total?.BaseFare ? Number(pricingInfo.Total.BaseFare) : undefined,
      tax: pricingInfo.Total?.OtherTax ? Number(pricingInfo.Total.OtherTax) : undefined,
      // Taxes by code, read from the FIRST fare breakdown — the adult entry.
      // Per-pax tax detail is not carried: a commercial rule calculates on the
      // itinerary's components, and the per-passenger split is in
      // passengerBreakup on the price step for anyone who needs it.
      //
      // Amounts arrive as strings, like every other money field from this
      // provider. Coerced exactly once, here.
      taxLines: fareBreakdown?.Taxes?.Tax
        ? fareBreakdown.Taxes.Tax.map(t => ({ code: t.TaxCode, amount: Number(t.Amount) || 0 }))
        : undefined,
      fuelSurcharge: pricingInfo.Total?.FuelSurcharge
        ? Number(pricingInfo.Total.FuelSurcharge)
        : undefined,
      isNdc: pricingInfo.IsNDC,
      refundable: fareBreakdown?.Refundable === 'Refundable',
      fareType: pricingInfo.FareType,
      // The outbound's code, kept because existing screens read it. fareBases
      // is the complete answer and what a round trip needs.
      fareBasis: fareBases[0]?.code,
      fareBases: fareBases.length > 0 ? fareBases : undefined,
      mealIncluded: pricingInfo.Meal === 'YES',
      changePenalties: toPenaltyLines(pricingInfo.Penalties?.ChangePenalty),
      cancelPenalties: toPenaltyLines(pricingInfo.Penalties?.CancelPenalty),
      brandedFareName: pricingInfo.BrandedFareName || undefined,
      brandedFareDescription: pricingInfo.BrandedfareDesc || undefined,
      // Provider sends one pipe-delimited string — split into an array here
      // so pages render a list, not a raw "A|B|C" string. Empty segments
      // (e.g. a stray leading/trailing "|") are dropped.
      brandedServices: pricingInfo.BrandedFareService
        ? pricingInfo.BrandedFareService.split('|').map(s => s.trim()).filter(Boolean)
        : undefined,
    }
  })

  const primaryFare = fareOptions[0]

  return {
    flightKey: flight.FlightKey,
    provider: flight.Provider,
    isLcc: String(flight.IsLCC) === 'true',
    itemNo: flight.ItemNo ?? '',
    cabin: allPricingInfos[0]?.FareInfos?.FareInfo?.[0]?.PaxCabin ?? itineraries[0]?.Cabin,
    bookingCode: itineraries[0]?.BookingCode,
    journeys,
    // Every flown segment across every direction, flat. The FOP resolver needs
    // each leg's RBD (a card the airline refuses in one class must not be
    // applied because the first leg happened to be in another), the deal-code
    // resolver needs flight numbers, and the processing fee counts these as
    // sectors — a round trip is genuinely two sectors, so this staying flat
    // across journeys is what makes the per-sector fee come out right.
    legs: journeys.flatMap(j => j.legs),
    // ── Aliases over journeys[0] ────────────────────────────────────────────
    // A dozen screens read these. They now describe the OUTBOUND rather than
    // the whole result, which is a change in meaning for a round trip and the
    // reason `journeys` exists: `destination` on a return used to resolve to
    // the airport you started from.
    origin: outbound?.origin,
    destination: outbound?.destination,
    airline: outbound?.airline,
    stops: outbound?.stops ?? [],
    stopCount: outbound?.stopCount ?? 0,
    duration: outbound?.duration,
    totalDuration: outbound?.totalDuration,
    availableSeats: outbound?.availableSeats,
    checkInBaggageKg: outbound?.checkInBaggageKg,
    cabinBaggageKg: outbound?.cabinBaggageKg,
    fareOptions,
    // Mirrors fareOptions[0] — kept so existing consumers (flowStorage, the
    // price page) don't break.
    pricingKey: primaryFare?.pricingKey,
    currency: primaryFare?.currency,
    totalFare: primaryFare?.totalFare,
    baseFare: primaryFare?.baseFare,
    isNdc: primaryFare?.isNdc,
    refundable: primaryFare?.refundable,
  }
})

    // ── Markup ───────────────────────────────────────────────────────────────
    // Applied HERE, not at booking, because it must reach the traveller as a
    // more expensive flight rather than as a line item they could identify.
    //
    // The context is loaded ONCE and applied in memory. Resolving per result
    // would be four queries plus a category lookup times thirty results, on the
    // most latency-sensitive request in the product.
    //
    // Discount and processing fee are deliberately NOT applied here. Both depend
    // on passenger and sector counts that belong to a priced itinerary, not to a
    // search row — they appear at /api/book/price, as their own visible lines.
    // applyMarkup runs even when no rule exists, because it also STRIPS the
    // airline tax detail on the way out. Conditioning it on rules would leak
    // taxLines and fuelSurcharge to any client that happens to have no markup —
    // inconsistent, and the browser has no use for either.
    const context = await contextPromise
    const priced = results.map(result => applyMarkup(context, result, adult + child))

    return Response.json({
  ok: true,
  results: priced,
  availabilityKey: availability.Key,
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