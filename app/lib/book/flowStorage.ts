// ── lib/book/flowStorage.ts ───────────────────────────────────────────────────
// Thin, typed wrapper around sessionStorage for the pre-persistence part of
// the booking flow (search → price → passengers). Nothing here survives a
// closed tab, and that's intentional — flight search results and quoted
// fares go stale fast and shouldn't be resurrected days later.
//
// Once /api/book/add-passenger creates a real `bookings` row, the flow
// switches to using bookingId (in the URL) + fetching from Supabase —
// this module is not used past that point.
// ─────────────────────────────────────────────────────────────────────────────

import type { FlatFlightResult, SelectedSeat } from './types'

const RESULTS_KEY = 'cbt:book:searchResults'
const SEARCH_META_KEY = 'cbt:book:searchMeta'
const PRICED_KEY_PREFIX = 'cbt:book:priced:' // + flightKey
const SEATS_KEY_PREFIX = 'cbt:book:seats:'   // + flightKey

export interface SearchMeta {
  origin: string
  destination: string
  departDate: string   // display-formatted, whatever the search page had
  adult: number
  child: number
  infant: number
}

export interface PricedFare {
  flightKey: string
  key: string
  pricingKey: string
  provider: string
  referenceNo: string
  totalFare: number
  baseFare: number
  tax: number
  currency: string
  isRefundable: boolean
  fareType: string
  passengerBreakup: unknown
  isNdc?: boolean
  searchKey?: string
}

function safeGet<T>(key: string): T | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function safeSet(key: string, value: unknown): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    // sessionStorage can throw in private-browsing edge cases or when full —
    // the flow degrades to "go back and search again", not a crash.
  }
}

export const flowStorage = {
  saveSearchResults(results: FlatFlightResult[], meta: SearchMeta, availabilityKey: string | null) {
    safeSet(RESULTS_KEY, { results, availabilityKey })
    safeSet(SEARCH_META_KEY, meta)
  },

  getSearchResults(): { results: FlatFlightResult[]; availabilityKey: string | null } | null {
    return safeGet(RESULTS_KEY)
  },

  getSearchMeta(): SearchMeta | null {
    return safeGet(SEARCH_META_KEY)
  },

  findResultByFlightKey(flightKey: string): FlatFlightResult | null {
    const stored = safeGet<{ results: FlatFlightResult[] }>(RESULTS_KEY)
    return stored?.results.find(r => r.flightKey === flightKey) ?? null
  },

  savePricedFare(fare: PricedFare) {
    safeSet(PRICED_KEY_PREFIX + fare.flightKey, fare)
  },

  getPricedFare(flightKey: string): PricedFare | null {
    return safeGet(PRICED_KEY_PREFIX + flightKey)
  },

  // Selected seats: one array of SelectedSeat (one per leg with a pick) per
  // passenger index. Seat selection is optional — a passenger with no entry
  // here, or an empty array, simply travels without a pre-assigned seat.
  saveSelectedSeats(flightKey: string, seatsByPassenger: Record<number, SelectedSeat[]>) {
    safeSet(SEATS_KEY_PREFIX + flightKey, seatsByPassenger)
  },

  getSelectedSeats(flightKey: string): Record<number, SelectedSeat[]> {
    return safeGet(SEATS_KEY_PREFIX + flightKey) ?? {}
  },
}