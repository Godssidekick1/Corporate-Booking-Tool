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