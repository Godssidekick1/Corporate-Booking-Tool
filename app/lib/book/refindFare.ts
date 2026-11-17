import { amadeus, AmadeusError, type FlightResult, type PricingInfo, type PricingResponse } from '@/app/lib/amadeus/client'
import { failureKind } from '@/app/lib/book/providerErrors'
import { cabinLetter, CABIN_LABELS } from '@/app/lib/book/cabin'
import { journeysOf, type FlatFlightResult } from '@/app/lib/book/types'

// ── Finding a booked fare again, in a fresh search ───────────────────────────
// A search's keys live about 25 minutes (app/lib/amadeus/sessionStore.ts); an
// approval waits hours. Re-pricing with the booking's own keys then fails as
// "expired" (seen 2026-11-17), so "Refresh fare" and confirming after a long
// approval could not work. This finds the same fare in a new search:
//
//   1. search the booking's route and date(s), cabin and passenger counts
//   2. the same flight: every segment's carrier and flight number, in order
//   3. the same fare: its brand (ECO VALUE), else its fare basis, else the
//      first fare in the same booking class
//   4. price it, with the new search's keys
//
// The flight or the fare no longer sold is an answer, not an error.
// ─────────────────────────────────────────────────────────────────────────────

export interface RefindTarget {
  itinerary: unknown
  pricing_key: string | null
  traveler_snapshot: unknown
}

export type RefindOutcome =
  | { found: true; pricing: PricingResponse; searchKey: string; pricingKey: string; resultIndex: string; provider: string }
  | { found: false; reason: 'flight_gone' | 'fare_gone' }

const apiDate = (iso: string) => { const [y, m, d] = iso.slice(0, 10).split('-'); return `${d}/${m}/${y}` }
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, '').toUpperCase()

// The flight numbers of every segment, in order: "AI2943", "AI2944".
function bookedNumbers(itin: FlatFlightResult): string[] {
  const legs = journeysOf(itin).flatMap(j => (j as { legs?: { airlineCode?: string; flightNumber?: string }[] }).legs ?? [])
  const all = legs.length ? legs : (itin.legs ?? [])
  return all.map(l => norm(`${l.airlineCode ?? ''}${l.flightNumber ?? ''}`))
}
// Built as the search mapper builds legs (app/api/book/search/route.ts): the
// operating carrier, and AirLine.Identification. NOT `Flight`, which is the
// journey index ("1") and would never match a booked flight number.
const offeredNumbers = (r: FlightResult) => (r.Itineraries?.Itinerary ?? []).map(s =>
  norm(`${s.AirLine?.OperatingCarrier || s.AirLine?.Code || ''}${s.AirLine?.Identification ?? ''}`))

function paxCounts(snapshot: unknown): { adult: number; child: number; infant: number } {
  const pax = ((snapshot as { PassengerDetails?: { PaxType?: string }[] } | null)?.PassengerDetails ?? [])
  const n = (t: string) => pax.filter(p => (p.PaxType ?? 'ADT').toUpperCase() === t).length
  return { adult: Math.max(1, n('ADT')), child: n('CHD'), infant: n('INF') }
}

// The booked fare's identity: brand, fare basis, booking class.
function bookedFare(itin: FlatFlightResult, pricingKey: string | null) {
  const fare = itin.fareOptions?.find(o => o.pricingKey === pricingKey) ?? itin.fareOptions?.[0]
  return {
    brand: norm(fare?.brandedFareName),
    basis: norm(fare?.fareBasis ?? fare?.fareBases?.[0]?.code),
    bookingClass: norm(itin.legs?.[0]?.bookingCode),
  }
}

function sameFare(offered: PricingInfo[], wanted: ReturnType<typeof bookedFare>): PricingInfo | undefined {
  const basisOf = (p: PricingInfo) => norm(p.FareInfos?.FareInfo?.[0]?.PaxFareBasis ?? p.FareInfos?.FareInfo?.[0]?.FareBasis)
  const classOf = (p: PricingInfo) => norm(p.FareInfos?.FareInfo?.[0]?.PaxBookingClass ?? p.FareInfos?.FareInfo?.[0]?.BookingCode)
  if (wanted.brand) {
    const byBrand = offered.find(p => norm(p.BrandedFareName) === wanted.brand)
    if (byBrand) return byBrand
  }
  if (wanted.basis) {
    const byBasis = offered.find(p => basisOf(p) === wanted.basis)
    if (byBasis) return byBasis
  }
  // No brand on either side (low-cost and older fares): the same class.
  if (!wanted.brand && wanted.bookingClass) return offered.find(p => classOf(p) === wanted.bookingClass)
  return undefined
}

export async function refindFare(target: RefindTarget): Promise<RefindOutcome> {
  const itin = target.itinerary as FlatFlightResult | null
  const journeys = itin ? journeysOf(itin) : []
  if (!itin || journeys.length === 0 || journeys.some(j => !j.origin?.code || !j.destination?.code || !j.origin?.dateTime)) {
    return { found: false, reason: 'flight_gone' }
  }
  const letter = cabinLetter(itin.cabin)
  const { adult, child, infant } = paxCounts(target.traveler_snapshot)

  let availability: Awaited<ReturnType<typeof amadeus.searchFlights>>
  try {
    availability = await amadeus.searchFlights({
      segments: journeys.map(j => ({ Origin: j.origin!.code!, Destination: j.destination!.code!, DepartDate: apiDate(j.origin!.dateTime!) })),
      rtf: journeys.length > 1,
      // As the search page sends it: economy as '', other cabins by name.
      preferredClass: letter && letter !== 'Y' ? CABIN_LABELS[letter] : '',
      adult, child, infant,
    })
  } catch (err) {
    if (err instanceof AmadeusError && failureKind(err) === 'no_results') return { found: false, reason: 'flight_gone' }
    throw err
  }

  const wantedNumbers = bookedNumbers(itin).join('|')
  const flight = (availability.Availibilities ?? []).flatMap(a => a.Availibility ?? [])
    .find(r => offeredNumbers(r).join('|') === wantedNumbers)
  if (!flight) return { found: false, reason: 'flight_gone' }

  const fare = sameFare(flight.PricingInfos?.PricingInfo ?? [], bookedFare(itin, target.pricing_key))
  if (!fare) return { found: false, reason: 'fare_gone' }

  const searchKey = (availability as { Key?: string }).Key ?? ''
  const pricing = await amadeus.pricing(searchKey, fare.Pricingkey, flight.Provider, flight.ItemNo)
  return { found: true, pricing, searchKey, pricingKey: fare.Pricingkey, resultIndex: flight.ItemNo, provider: flight.Provider }
}
