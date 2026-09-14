import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { amadeus, AmadeusError, sanitizeAmadeusDiagnostic } from '@/app/lib/amadeus/client'
import { harvestAirlines } from '@/app/lib/reference/harvestAirlines'
import {
  loadCommercialContext, priceWithContext, type CommercialContext,
} from '@/app/lib/commercials/stampCommercials'
import { round2 } from '@/app/lib/commercials/fareComponents'
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

export interface PenaltyLine {
  paxType: string
  text: string   // free-text as Amadeus sends it, e.g. "INR3000" or "0" — never parsed, just trimmed
}

// See the same type in app/lib/book/types.ts. YQ/YR are surcharges filed in the
// tax box rather than the fare, and a commercial rule calculating on BF+YQ
// needs them itemised.
export interface TaxLine {
  code: string
  amount: number
}

// One fare option for this flight. Today's real responses only ever contain
// one of these per flight (confirmed against UAT), but the underlying
// Amadeus shape (PricingInfos.PricingInfo is an array) supports more than
// one, and production may behave differently — so this is plural and the
// frontend renders however many actually come back, rather than assuming 1.
export interface FareOption {
  pricingKey: string
  currency: string | undefined
  totalFare: number | undefined
  baseFare: number | undefined
  // Total.OtherTax. Not guaranteed to equal totalFare - baseFare, because
  // Total.FuelSurcharge is a sibling field — use taxLines for anything that
  // needs a specific code.
  tax: number | undefined
  taxLines: TaxLine[] | undefined
  fuelSurcharge: number | undefined
  isNdc: boolean | undefined
  refundable: boolean | undefined
  fareType: string | undefined
  fareBasis: string | undefined       // FareInfo.PaxFareBasis for the first (adult) pax entry
  mealIncluded: boolean | undefined   // PricingInfo.Meal === "YES" — treated as chargeable/optional unless explicitly "YES"
  changePenalties: PenaltyLine[]
  cancelPenalties: PenaltyLine[]
  brandedFareName: string | undefined
  brandedFareDescription: string | undefined
  brandedServices: string[] | undefined
}

export interface FlatFlightResult {
  flightKey: string
  provider: string
  isLcc: boolean
  itemNo: string
  cabin: string | undefined
  bookingCode: string | undefined
  origin: { code: string; name: string; city: string; dateTime: string; terminal: string | undefined } | undefined
  destination: { code: string; name: string; city: string; dateTime: string; terminal: string | undefined } | undefined
  airline: { code: string; name: string } | undefined
  stopCount: number           // 0, 1, 2 — number of stops
  stops: StopInfo[]           // intermediate stop details
  duration: string | undefined
  totalDuration: string | undefined // whole-journey duration including layover/ground time between connecting flights, straight from Amadeus's TotalDuration[{flight:"1",text:"HH:MM"}]. Distinct from `duration`, which is only the first leg. Per explicit product guidance, layover time counts toward "how long is this trip" for policy purposes (e.g. long-haul/short-haul cabin checks) — not just airborne time.
  availableSeats: number | undefined
  checkInBaggageKg: string | undefined
  cabinBaggageKg: string | undefined
  fareOptions: FareOption[]
  // Kept for backward compatibility with existing pages/flowStorage that
  // read these directly off the top level — mirrors fareOptions[0].
  pricingKey: string | undefined
  currency: string | undefined
  totalFare: number | undefined
  baseFare: number | undefined
  isNdc: boolean | undefined
  refundable: boolean | undefined
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
  const firstLeg = itineraries[0]
  const lastLeg = itineraries[itineraries.length - 1]
  const allPricingInfos = flight.PricingInfos?.PricingInfo ?? []

  // Stops are intermediate points — all leg destinations except the final one
  const stops = itineraries.slice(0, -1).map(leg => ({
    code: leg.Destination.AirportCode,
    city: leg.Destination.CityName,
    arrivalDateTime: leg.Destination.DateTime,
    departureDateTime: itineraries[itineraries.indexOf(leg) + 1]?.Origin.DateTime,
  }))

  const fareOptions: FareOption[] = allPricingInfos.map(pricingInfo => {
    const fareBreakdown = pricingInfo.FareBreakDowns?.FareBreakDown?.[0]
    // FareInfo has one entry per (leg × paxType) — the fare basis code is the
    // same across legs/pax types in every sample seen so far, so the first
    // entry's PaxFareBasis is used as this fare option's basis code.
    const fareBasis = pricingInfo.FareInfos?.FareInfo?.[0]?.PaxFareBasis

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
      fareBasis: fareBasis || undefined,  // seen as "" in real responses when not populated
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

  // TotalDuration is a sibling field on the raw FlightResult, distinct from
  // any single leg's Duration — it's the whole journey including
  // layover/ground time between connecting flights. Confirmed shape from a
  // real UAT trace: [{ flight: "1", text: "07:30" }] for a one-way search
  // (this route only ever sends a single segment, so "1" is always the one
  // we want — no round-trip "2" to disambiguate here). Field casing isn't
  // guaranteed consistent with the rest of the API's PascalCase
  // conventions, so this reads defensively across both cases rather than
  // assuming one.
  const totalDurationEntry = flight.TotalDuration?.[0] as Record<string, unknown> | undefined
  const totalDurationText = (totalDurationEntry?.text ?? totalDurationEntry?.Text) as string | undefined

  return {
    flightKey: flight.FlightKey,
    provider: flight.Provider,
    isLcc: String(flight.IsLCC) === 'true',
    itemNo: flight.ItemNo ?? '',
    cabin: allPricingInfos[0]?.FareInfos?.FareInfo?.[0]?.PaxCabin ?? firstLeg?.Cabin,
    bookingCode: firstLeg?.BookingCode,
    // Every leg, not just the first. The FOP resolver needs each leg's RBD (a
    // card the airline refuses in one class must not be applied because the
    // first leg happened to be in another), and the deal-code resolver needs
    // flight numbers, which it previously had no way to see.
    legs: itineraries.map(leg => ({
      airlineCode: leg.AirLine?.OperatingCarrier || leg.AirLine?.Code,
      flightNumber: leg.Flight,
      bookingCode: leg.BookingCode,
      cabin: leg.Cabin,
    })),
    origin: firstLeg?.Origin ? {
      code: firstLeg.Origin.AirportCode,
      name: firstLeg.Origin.AirportName,
      city: firstLeg.Origin.CityName,
      dateTime: firstLeg.Origin.DateTime,
      terminal: firstLeg.Origin.Terminal || undefined,
    } : undefined,
    destination: lastLeg?.Destination ? {
      code: lastLeg.Destination.AirportCode,
      name: lastLeg.Destination.AirportName,
      city: lastLeg.Destination.CityName,
      dateTime: lastLeg.Destination.DateTime,
      terminal: lastLeg.Destination.Terminal || undefined,
    } : undefined,
    stops,
    airline: firstLeg?.AirLine ? {
      code: firstLeg.AirLine.OperatingCarrier || firstLeg.AirLine.Code,
      name: firstLeg.AirLine.Name,
    } : undefined,
    stopCount: itineraries.length - 1,
    duration: firstLeg?.Duration,
    totalDuration: totalDurationText,
    availableSeats: firstLeg?.AvailableSeats ? parseInt(firstLeg.AvailableSeats) || undefined : undefined,
    checkInBaggageKg: firstLeg?.Baggage?.Allowance?.CheckIn,
    cabinBaggageKg: firstLeg?.Baggage?.Allowance?.Cabin || undefined,
    fareOptions,
    // Mirrors fareOptions[0] — kept so existing consumers (flowStorage,
    // price page as it exists today) don't break while Step 2's rebuild
    // is in progress.
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
    const context = await loadCommercialContext(service, employee.client_id)
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