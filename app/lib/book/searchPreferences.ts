// ── lib/book/searchPreferences.ts ─────────────────────────────────────────────
// Long-lived (localStorage, not sessionStorage) search preferences — the
// last search someone made, remembered across visits/tabs so a returning
// user doesn't have to re-enter everything. This is deliberately a SEPARATE
// module from flowStorage: flowStorage's whole contract is "dies with the
// tab, since search results/fares go stale fast." This data is the
// opposite — it should survive, since "what did I search last time" stays
// useful for weeks.
//
// Deliberately does NOT remember the departure date — a date from a past
// search is actively wrong for a returning user (it may already be in the
// past), so the date field always defaults to today regardless of history.
// Everything else genuinely is stable across visits: airport pair,
// traveler counts, cabin class.
// ─────────────────────────────────────────────────────────────────────────────

const LAST_ORIGIN_KEY = 'cbt:prefs:lastOrigin'
const LAST_DESTINATION_KEY = 'cbt:prefs:lastDestination'
const LAST_ADULT_KEY = 'cbt:prefs:lastAdult'
const LAST_CHILD_KEY = 'cbt:prefs:lastChild'
const LAST_INFANT_KEY = 'cbt:prefs:lastInfant'
const LAST_CABIN_KEY = 'cbt:prefs:lastCabin'

function safeGetLocal(key: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSetLocal(key: string, value: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // localStorage can throw in private-browsing edge cases or when full —
    // degrades to "no remembered search," not a crash.
  }
}

export interface LastSearch {
  origin: string
  destination: string
  adult: number
  child: number
  infant: number
  cabinPref: 'Economy' | 'Premium Economy' | 'Business' | 'First'
}

export const searchPreferences = {
  saveLastSearch(search: Omit<LastSearch, 'origin' | 'destination'> & { origin: string; destination: string }) {
    if (search.origin) safeSetLocal(LAST_ORIGIN_KEY, search.origin)
    if (search.destination) safeSetLocal(LAST_DESTINATION_KEY, search.destination)
    safeSetLocal(LAST_ADULT_KEY, String(search.adult))
    safeSetLocal(LAST_CHILD_KEY, String(search.child))
    safeSetLocal(LAST_INFANT_KEY, String(search.infant))
    safeSetLocal(LAST_CABIN_KEY, search.cabinPref)
  },

  getLastOrigin(): string | null {
    return safeGetLocal(LAST_ORIGIN_KEY)
  },

  getLastDestination(): string | null {
    return safeGetLocal(LAST_DESTINATION_KEY)
  },

  getLastTravelers(): { adult: number; child: number; infant: number } | null {
    const adult = safeGetLocal(LAST_ADULT_KEY)
    if (adult === null) return null
    return {
      adult: Number(adult) || 1,
      child: Number(safeGetLocal(LAST_CHILD_KEY)) || 0,
      infant: Number(safeGetLocal(LAST_INFANT_KEY)) || 0,
    }
  },

  getLastCabinPref(): LastSearch['cabinPref'] | null {
    const value = safeGetLocal(LAST_CABIN_KEY)
    if (value === 'Economy' || value === 'Premium Economy' || value === 'Business' || value === 'First') return value
    return null
  },

  hasSearchedBefore(): boolean {
    return safeGetLocal(LAST_ORIGIN_KEY) !== null
  },
}