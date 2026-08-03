// ── lib/book/types.ts ──────────────────────────────────────────────────────
// Shared shapes across the booking flow pages. Mirrors exactly what
// /api/book/search returns (see FlatFlightResult there) — kept here so
// price/passengers pages don't redeclare it.
// ─────────────────────────────────────────────────────────────────────────────

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
  cabin?: string
  bookingCode?: string
  origin?: { code: string; name: string; city: string; dateTime: string }
  destination?: { code: string; name: string; city: string; dateTime: string }
  airline?: { code: string; name: string }
  stopCount: number
  stops: StopInfo[]
  duration?: string
  availableSeats?: number
  checkInBaggageKg?: string
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