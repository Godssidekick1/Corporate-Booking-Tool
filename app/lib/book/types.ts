// ── lib/book/types.ts ──────────────────────────────────────────────────────
// Shared shapes across the booking flow pages. Mirrors exactly what
// /api/book/search returns (see FlatFlightResult there) — kept here so
// price/passengers pages don't redeclare it.
// ─────────────────────────────────────────────────────────────────────────────

// ── Traveler profile (employees.traveler_profile) ────────────────────────────
// One per employee — their own stable, per-person details, filled in once on
// /profile and reused to autofill passenger slot 1 (plus CustomerInfo)
// whenever they book for themselves. Deliberately excludes firstName/lastName
// (employees.full_name is the source of truth). Identity fields mirror
// AddPassengerDetails' PassengerDetail exactly, confirmed against a real
// request body, so no translation layer is needed between this and the
// passenger form. Contact fields mirror CustomerInfo the same way.
//
// This is the corporate record of who this person is and how to reach them —
// when booking for yourself, these fields are locked on the booking page and
// can only be changed here, on /profile, not overridden per-trip.
export interface TravelerProfile {
  title: string                  // "MR" | "MRS" | "MS" | "MSTR" etc — matches PassengerDetail.Title
  gender: string                 // "Male" | "Female"
  dateOfBirth: string            // "DD/MM/YYYY" — matches PassengerDetail.DateOfBirth format
  passportNumber?: string        // optional — only relevant for international travel
  issuingCountry?: string
  nationality?: string
  passportExpiryDate?: string    // "DD/MM/YYYY"
  mealPreference?: string        // matches PassengerDetail.MealCode
  // Contact details — mirrors CustomerInfo exactly, matching format below.
  email?: string
  mobile?: string
  address?: string
  city?: string
  state?: string
  zipCode?: string
}

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

// One filed tax, by code. YQ is conventionally the fuel/insurance surcharge and
// YR the carrier-imposed misc fee — both are surcharges filed in the TAX box
// rather than in the fare, and airlines use them somewhat interchangeably.
// That is exactly why a commercial rule calculating on "BF+YQ" and one
// calculating on "BF+YQ+YR" are different arrangements worth different money.
//
// These arrive from Amadeus on every response (FareBreakDown.Taxes.Tax[]) and
// were discarded at the search/price mapping boundary until commercial rules
// needed them.
export interface TaxLine {
  code: string
  amount: number
}

// One fare option for this flight. Real responses seen so far only ever
// contain one of these per flight, but Amadeus's own shape
// (PricingInfos.PricingInfo) is an array, and production may return more
// than one — rendered as however many actually come back, not assumed to be 1.
export interface FareOption {
  pricingKey: string
  currency?: string
  totalFare?: number
  baseFare?: number
  // The aggregate, from Total.OtherTax. NOT guaranteed to equal
  // totalFare - baseFare: Total.FuelSurcharge is a SIBLING field, so YQ may or
  // may not be counted inside OtherTax. Use taxLines when a rule needs a
  // specific code, never arithmetic on this.
  tax?: number
  // Per-code detail and the fuel surcharge, carried for commercial rules whose
  // CalcOn names a component (bf_yq, bf_yq_yr, yq, yr, other_tax). Optional
  // because not every provider response itemises taxes.
  taxLines?: TaxLine[]
  fuelSurcharge?: number
  isNdc?: boolean
  refundable?: boolean
  fareType?: string
  fareBasis?: string
  mealIncluded?: boolean       // PricingInfo.Meal === "YES" — treated as chargeable/optional unless explicitly "YES"
  // One fare basis per direction. FareInfos.FareInfo[] carries one entry per
  // (journey × paxType); a round trip prices each direction under its own
  // basis code — a real payload showed SK1YXYII outbound and TU1YXRII inbound.
  // Reading FareInfo[0] alone, as this did, displayed the outbound code and
  // silently hid the return's.
  fareBases?: { journeyNo: number; code: string }[]
  changePenalties: PenaltyLine[]
  cancelPenalties: PenaltyLine[]
  // Branded fare tier — the airline's own named fare product for this
  // option (e.g. "ECOVALU" / "ECO VALUE"), distinct from fareType (NRM/etc,
  // an internal refundability class). brandedServices is the perk list,
  // already split from the provider's pipe-delimited string into an array
  // so pages don't need to know about that delimiter. All optional since
  // not every fare/provider returns branded data.
  brandedFareName?: string
  brandedFareDescription?: string
  brandedServices?: string[]
}

// One flown segment. Kept per-leg because a connection can carry a different
// carrier, flight number and booking class on each hop, and the rules that read
// them care about all of them:
//
//   - An FOP restricted to certain RBDs only applies if EVERY leg is in the set;
//     matching the first leg alone would apply a card the airline refuses on the
//     second.
//   - A deal code restricted to a flight number range could not be checked at
//     all before this existed, so those deals were stamped with an
//     "unverifiable" flag instead of being matched.
export interface FlightLeg {
  airlineCode?: string
  flightNumber?: string
  // The RBD — the single-letter fare bucket (Y/B/M/H… economy, C/D/J business).
  // Not the cabin: one cabin holds many RBDs at different prices and rules.
  bookingCode?: string
  cabin?: string
}

// ── Journey ──────────────────────────────────────────────────────────────────
// One direction of travel: the outbound, or the return. A journey holds one or
// more flown legs — DEL→BOM is one leg, DEL→BOM→DXB is two.
//
// THE DISCRIMINATOR IS `ItineraryInfo.Flight`, NOT `ItineraryInfo.Leg`, and the
// difference is easy to get backwards. Confirmed against a real round-trip UAT
// payload: both itinerary entries carried `"leg": "1"` and differed by
// `"flight": "1"` (DEL outbound) and `"flight": "2"` (BOM→DEL return).
// `TotalDuration[]` is keyed the same way, by `flight`. So:
//
//   Flight = which direction        1 = outbound, 2 = return
//   Leg    = which hop within it    a connecting outbound is flight 1, legs 1 and 2
//
// Reading `Leg` as the journey would merge a connection's two hops into two
// separate "journeys" and collapse a round trip into one.
export interface Journey {
  journeyNo: number

  origin?: {
    code: string
    name: string
    city: string
    dateTime: string
    terminal?: string
  }

  destination?: {
    code: string
    name: string
    city: string
    dateTime: string
    terminal?: string
  }

  airline?: {
    code: string
    name: string
  }

  // Intermediate points WITHIN this direction only. A round trip's turnaround
  // is not a stop — it is where one journey ends and the next begins. Counting
  // it as a connection is what made a non-stop return read as `stopCount: 1`,
  // which the "Non-stop" filter excluded and the policy engine flagged as a
  // connecting flight.
  stops: StopInfo[]
  stopCount: number

  duration?: string
  totalDuration?: string
  legs: FlightLeg[]
  availableSeats?: number

  // Baggage is filed PER FLOWN SEGMENT in the provider's response
  // (itineraries.itinerary[].baggage.allowance) — there is no baggage node
  // inside pricingInfo, so it cannot vary by fare no matter how many fares a
  // flight carries.
  //
  // Left undefined when a journey's own segments disagree, rather than picking
  // one to show. We can state an allowance the whole direction is bound by, or
  // we can state nothing; guessing which segment the traveller will be judged
  // against is how someone gets charged at a gate.
  checkInBaggageKg?: string
  cabinBaggageKg?: string
}

export interface FlatFlightResult {
  flightKey: string
  provider: string
  isLcc: boolean
  itemNo: string
  cabin?: string
  // The first leg's RBD. Retained because several screens already read it;
  // `legs` is the complete picture and what the rule engines use.
  bookingCode?: string
  legs?: FlightLeg[]

  // Every direction of this result, in order. One entry for a one-way, two for
  // a round trip — the provider returns a round trip as ONE result with ONE
  // combined price, not as a pair of results, so this is the only place the
  // two directions are distinguishable.
  //
  // Everything below that describes a route — origin, destination, stops,
  // stopCount, duration, baggage — is an alias for journeys[0], kept because a
  // dozen screens already read them. New code should read `journeys`.
  journeys: Journey[]

  origin?: {
    code: string
    name: string
    city: string
    dateTime: string
    terminal?: string
  }

  destination?: {
    code: string
    name: string
    city: string
    dateTime: string
    terminal?: string
  }

  airline?: {
    code: string
    name: string
  }

  stopCount: number
  stops: StopInfo[]

  // Alias for journeys[0]. The comment here used to promise an array of
  // per-direction durations while the field was a single string — describing
  // the round-trip shape that did not exist yet. Per-direction durations now
  // live on Journey, where they can actually be held.
  duration?: string
  totalDuration?: string

  availableSeats?: number
  checkInBaggageKg?: string
  cabinBaggageKg?: string
  fareOptions: FareOption[]

  pricingKey?: string
  currency?: string
  totalFare?: number
  baseFare?: number
  isNdc?: boolean
  refundable?: boolean
}

// ── Seat selection ────────────────────────────────────────────────────────────
// One flight leg's worth of seat map data, plus what the traveler picked.
// Mirrors lib/amadeus/client.ts's SeatListDetail/PassengerSeatSelection —
// kept separate here since the frontend only needs a slice of those fields.
//
// Confirmed against a real full-cabin response:
// - ColumnNo is NOT usable as a column position — it's 0 for every real seat
//   in the entire cabin (only becomes 4 on the BLANK aisle-gap filler cell in
//   each row). Column position comes from array order within the row instead.
// - SeatDesignator is already in the exact "22-B" (row-hyphen-letter) form
//   AddPassenger expects for real, selectable seats — no derivation needed.
//   Only "hidden"/inaccessible rows (Assignable: false, Message: "hide",
//   TravelClassCode: "NA") show the numeric junk form ("11", "21"...) instead;
//   those rows aren't real seat picks and should be excluded entirely.
// - SeatStatus (not SeatAvailability, which can misleadingly say "Available"
//   on an occupied seat) is the field that determines selectability:
//   "OPEN" = free/selectable, "OCCUPIED" = taken, "BLANK" = the walking aisle
//   itself (not a seat at all), "NoSeat" = no physical seat at this position
//   (e.g. galley/lavatory). Only OPEN seats are ever clickable.
export interface SeatCell {
  rowNo: number
  seatDesignator: string   // ready-to-use lettered form, e.g. "22-B" — pass straight through to AddPassenger's SeatListDetails
  seatAlignment: string    // "Window" | "Middle" | "Aisle"
  seatStatus: string       // "OPEN" (selectable) | "OCCUPIED" | "BLANK" (aisle, not a seat) | "NoSeat" (no seat here) | other hidden/unavailable values
  seatFee: number
  paid: boolean
  travelClassCode: string
  flightNumber: string
  flightTime: string
  equipment: string
  carrier: string
  group: string
  classOfService: string
  optionalServiceRef: string
  segmentRef: string
  exitSeats: string         // e.g. "EXIT1A" when this row is an exit row, "" otherwise
  hidden: boolean           // true for rows the fare/cabin can't see (Assignable: false, Message: "hide", TravelClassCode: "NA") — excluded from rendering entirely
}

export interface LegSeatMap {
  legIndex: number
  origin: string
  destination: string
  flightNumber: string
  flightTime: string
  columns: number
  rows: number
  available: boolean       // false if the airline/fare simply has no seat map for this leg — flow proceeds without seats
  seats: SeatCell[]
}

// Selected seat per passenger per leg, in the exact shape AddPassenger wants
// back (see PassengerSeatSelection in lib/amadeus/client.ts). Keyed by
// legIndex so the passengers page can group them back into
// PassengerDetails[i].SeatListDetails.
export interface SelectedSeat {
  legIndex: number
  SeatDesignator: string
  SeatFee: string
  FlightNumber: string
  FlightTime: string
  Equipment: string
  SeatAlignment: string
  OptionalServiceRef: string
  Group: string
  ClassOfService: string
  Carrier: string
  Paid: boolean
  SegmentRef: string
}

// ── journeysOf ───────────────────────────────────────────────────────────────
// A result's directions, with a fallback for results stored before `journeys`
// existed.
//
// sessionStorage outlives a deploy: someone mid-flow when this ships has a
// FlatFlightResult in their tab with no journeys array, and the price and
// details pages read it back by flightKey. Rebuilding one journey from the
// top-level aliases keeps that session working instead of blanking the page —
// and it is exactly right for a one-way, which is all those stored results can
// be, since round trip did not exist when they were written.
export function journeysOf(flight: FlatFlightResult): Journey[] {
  if (flight.journeys?.length) return flight.journeys
  return [{
    journeyNo: 1,
    origin: flight.origin,
    destination: flight.destination,
    airline: flight.airline,
    stops: flight.stops ?? [],
    stopCount: flight.stopCount ?? 0,
    duration: flight.duration,
    totalDuration: flight.totalDuration,
    legs: flight.legs ?? [],
    availableSeats: flight.availableSeats,
    checkInBaggageKg: flight.checkInBaggageKg,
    cabinBaggageKg: flight.cabinBaggageKg,
  }]
}

// "Outbound" / "Return" / "Leg 3". Only worth showing when a result actually
// has more than one direction — a one-way needs no label.
export function journeyLabel(journeyNo: number): string {
  if (journeyNo === 1) return 'Outbound'
  if (journeyNo === 2) return 'Return'
  return `Leg ${journeyNo}`
}

export function formatTime(iso: string | undefined) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return '—'
  }
}

export function formatDayLabel(iso: string | undefined) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
  } catch {
    return ''
  }
}