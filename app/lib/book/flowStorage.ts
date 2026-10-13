// ── lib/book/flowStorage.ts ───────────────────────────────────────────────────
// Thin, typed wrapper around sessionStorage for the pre-persistence part of
// the booking flow (search → price → passengers). Nothing here survives a
// closed tab, and that's intentional — flight search results and quoted
// fares go stale fast and shouldn't be resurrected days later.
//
// Once /api/book/add-passenger creates a real `bookings` row, the flow
// switches to using bookingId (in the URL) + fetching from the API —
// this module is not used past that point.
// ─────────────────────────────────────────────────────────────────────────────

import type { FlatFlightResult, SelectedSeat } from './types'

const RESULTS_KEY = 'cbt:book:searchResults'
const SEARCH_META_KEY = 'cbt:book:searchMeta'
const PRICED_KEY_PREFIX = 'cbt:book:priced:' // + flightKey
const SEATS_KEY_PREFIX = 'cbt:book:seats:'   // + flightKey
const TRIP_ID_KEY = 'cbt:book:tripId'
const GUEST_BOOKING_KEY = 'cbt:book:isGuestBooking'
const ON_BEHALF_KEY = 'cbt:book:onBehalf'
// Who this tab's flow belongs to: the signed-in employee, set by claim().
const OWNER_KEY = 'cbt:book:owner'

// Booking for someone else (app/lib/book/bookingActor.ts): who, shown on every
// step of the flow and sent to every booking route as travellerId.
export interface OnBehalf {
  // Who chose this traveller. A different person signed in to the same tab
  // must never inherit it (the search page checks; sign-in and sign-out clear).
  bookerId: string
  travellerId: string
  name: string
  clientName: string
  bandCode: string | null
  // 'guidance': the desk at a CBT-only client (a reason for amber or red, no
  // approval chain); 'approvals': the traveller's own chain decides.
  policy: 'guidance' | 'approvals'
  // Where the booker returns to: the desk, or a corporate admin's trips.
  home: '/tmc/book' | '/bookings'
}

export interface SearchMeta {
  origin: string
  destination: string
  departDate: string   // display-formatted, whatever the search page had
  // Present only for a round trip. Carried so an error exit can rebuild the
  // search the traveller actually ran — sending them back to a one-way form
  // after a round-trip search is the kind of small loss that makes people
  // start over in a new tab.
  returnDate?: string
  tripType?: 'oneway' | 'return'
  adult: number
  child: number
  infant: number
}

export interface PricedFare {
  flightKey: string
  key: string
  pricingKey: string
  provider: string
  resultIndex: string
  referenceNo: string
  // The FARE line. Any markup reaching this client is already folded into it
  // and cannot be separated out — deliberately. The airline's own figure never
  // reaches the browser at all, so nothing here can be used to derive it.
  totalFare: number
  baseFare: number
  tax: number
  // The commercial lines the traveller sees — discount, processing fee. Signed,
  // so a breakdown renders them without needing to know which are reductions.
  lines?: { source: string; label: string; sign: -1 | 1; amount: number }[]
  // totalFare plus those lines: what they pay before seat fees.
  sellTotal?: number
  currency: string
  isRefundable: boolean
  fareType: string
  // Whether this fare includes a meal (PricingInfo.Meal === 'YES'). Carried
  // forward so the passengers page knows whether a special-meal request is
  // something the airline will actually honour — there is no ancillary purchase
  // flow, so on a meal-less fare the selector is disabled rather than sending a
  // preference nobody will act on.
  mealIncluded?: boolean
  passengerBreakup: unknown
  isNdc?: boolean
  searchKey?: string
  // Branded fare tier for the priced option — see FareOption in
  // lib/book/types.ts for the same fields at the search-results stage.
  brandedFareName?: string
  brandedFareDescription?: string
  brandedServices?: string[]
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

// ── The Confirm → Ticket hand-off ────────────────────────────────────────────
// Set by the confirm page the moment the airline confirms, read and consumed
// once by the ticket page so it can start issuing immediately instead of first
// asking the server for a status it was just told. Deliberately a bare string
// rather than a JSON blob: it is one booking id, and it is read on the critical
// path of the slowest moment in the flow.
//
// Exported from here rather than declared in both pages so the two cannot
// disagree about the key — the failure mode of that is silent and looks exactly
// like the slowness it was meant to remove.
export const JUST_BOOKED_KEY = 'cbt:justBooked'

export interface FlowExits {
  home: { href: string; label: string }
  trips: { href: string; label: string }
}

export const flowStorage = {
  // Not cleared by clearFlow(): searching again is still booking for the same
  // person. Set or cleared where the traveller is chosen.
  setOnBehalf(who: OnBehalf | null) {
    if (who) { safeSet(ON_BEHALF_KEY, who); return }
    if (typeof window === 'undefined') return
    try { window.sessionStorage.removeItem(ON_BEHALF_KEY) } catch { /* as safeSet */ }
  },

  // Only honoured for the account that chose it. Until claim() has named the
  // signed-in person (and sign-in and sign-out wipe the name), there is no
  // booking-for at all: a tab that outlives an account fails closed, to
  // booking for oneself, on every page -- not just the ones that check.
  onBehalf(): OnBehalf | null {
    const who = safeGet<OnBehalf>(ON_BEHALF_KEY)
    const owner = safeGet<string>(OWNER_KEY)
    return who && owner && who.bookerId === owner ? who : null
  },

  // The signed-in employee takes this tab's flow. Someone else's flow -- a
  // search, priced fares, a traveller they were booking for -- is dropped.
  // Called wherever the flow learns who is signed in (/api/me).
  claim(employeeId: string) {
    if (!employeeId) return
    const owner = safeGet<string>(OWNER_KEY)
    const who = safeGet<OnBehalf>(ON_BEHALF_KEY)
    if (owner && owner !== employeeId) flowStorage.clearAll()
    // No owner yet: just signed in (which cleared everything), or a tab from
    // before owners were recorded. Keep the trip just picked, drop a traveller
    // chosen by anyone else.
    else if (who && who.bookerId !== employeeId) flowStorage.setOnBehalf(null)
    safeSet(OWNER_KEY, employeeId)
  },

  // Where the flow's exits go. The travel desk has no dashboard or trips of
  // its own on the corporate side: its home is the desk (/tmc/book). Read at
  // the moment of use (an event handler), or through useFlowExits for render.
  exits(): FlowExits {
    const desk = flowStorage.onBehalf()?.home === '/tmc/book'
    return desk
      ? { home: { href: '/tmc/book', label: 'Travel desk' }, trips: { href: '/tmc/book', label: 'Desk bookings' } }
      : { home: { href: '/dashboard', label: 'Dashboard' }, trips: { href: '/bookings', label: 'My trips' } }
  },

  // The travellerId every booking route takes; undefined = booking for oneself.
  travellerId(): string | undefined {
    return flowStorage.onBehalf()?.travellerId
  },

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

  setTripId(tripId: string | null) {
    if (tripId) safeSet(TRIP_ID_KEY, tripId)
  },

  getTripId(): string | null {
    return safeGet<string>(TRIP_ID_KEY)
  },

  clearTripId() {
    if (typeof window === 'undefined') return
    try {
      window.sessionStorage.removeItem(TRIP_ID_KEY)
    } catch {
      // no-op, matches safeSet's failure handling elsewhere in this file
    }
  },

  // Whether this booking is being made for someone other than the employee
  // themselves (a guest/colleague) rather than the employee traveling.
  // Defaults to false (i.e. "this is me traveling") everywhere it's read,
  // via ?? false at the call site — so passenger-page autofill is safe by
  // default even before any UI actually sets this flag to true. Set from
  // wherever the "booking for a guest" checkbox lives (search page, My
  // trips, etc.) — not owned by this module beyond storage.
  setGuestBooking(isGuest: boolean) {
    safeSet(GUEST_BOOKING_KEY, isGuest)
  },

  isGuestBooking(): boolean {
    return safeGet<boolean>(GUEST_BOOKING_KEY) ?? false
  },

  clearGuestBooking() {
    if (typeof window === 'undefined') return
    try {
      window.sessionStorage.removeItem(GUEST_BOOKING_KEY)
    } catch {
      // no-op, matches safeSet's failure handling elsewhere in this file
    }
  },

  // ── clearFlow ─────────────────────────────────────────────────────────────
  // Everything this flow keeps, for anyone: called on sign-in and sign-out,
  // since a tab outlives an account. Without it the next person to sign in
  // inherited the last one's search, priced fares and -- worst -- whom they
  // were booking for.
  clearAll() {
    if (typeof window === 'undefined') return
    try {
      const store = window.sessionStorage
      for (const key of Object.keys(store)) if (key.startsWith('cbt:book:')) store.removeItem(key)
    } catch {
      // no-op, matches safeSet's failure handling elsewhere in this file
    }
  },

  // Forget the whole in-progress booking. Called when a traveller leaves the
  // flow deliberately — starting a new search, or taking an exit out of an
  // error — rather than when they complete it.
  //
  // NOTHING USED TO CLEAR ANY OF THIS ON ANY ERROR PATH, and two real faults
  // came out of that:
  //
  //   1. tripId was cleared only on the SUCCESS path, immediately before the
  //      push to /book/confirm. A booking that errored out at passenger details
  //      left it behind, so the next, unrelated booking in the same tab
  //      silently attached itself to the previous trip.
  //
  //   2. A stale priced:<flightKey> entry passes the details page's guard on a
  //      fare the server has already expired — which is exactly how the
  //      QUOTE_EXPIRED 409 from add-passenger is reached.
  //
  // Deliberately leaves the search RESULTS and meta alone: someone starting
  // again usually wants the same search back, and those are re-written by the
  // next search anyway. This clears the per-flight state that goes stale and
  // the trip binding that leaks.
  clearFlow() {
    if (typeof window === 'undefined') return
    try {
      const store = window.sessionStorage
      // Every priced fare and seat selection, whichever flights they were for —
      // removing only the current flightKey would leave the others to be
      // matched by a later visit to the same flight.
      const stale = Object.keys(store).filter(
        key => key.startsWith(PRICED_KEY_PREFIX) || key.startsWith(SEATS_KEY_PREFIX)
      )
      for (const key of stale) store.removeItem(key)
      store.removeItem(TRIP_ID_KEY)
      store.removeItem(GUEST_BOOKING_KEY)
    } catch {
      // no-op, matches safeSet's failure handling elsewhere in this file
    }
  },
}