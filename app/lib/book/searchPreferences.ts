// ── lib/book/searchPreferences.ts ─────────────────────────────────────────────
// Long-lived (localStorage, not sessionStorage) search preferences — the
// last airport pair someone searched, remembered across visits/tabs. This is
// deliberately a SEPARATE module from flowStorage: flowStorage's whole
// contract is "dies with the tab, since search results/fares go stale fast."
// This data is the opposite — it should survive, since "what did I search
// last time" stays useful for weeks.
// ─────────────────────────────────────────────────────────────────────────────

const LAST_ORIGIN_KEY = 'cbt:prefs:lastOrigin'
const LAST_DESTINATION_KEY = 'cbt:prefs:lastDestination'

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
    // degrades to "no remembered airport," not a crash.
  }
}

export const searchPreferences = {
  saveLastSearch(origin: string, destination: string) {
    if (origin) safeSetLocal(LAST_ORIGIN_KEY, origin)
    if (destination) safeSetLocal(LAST_DESTINATION_KEY, destination)
  },

  getLastOrigin(): string | null {
    return safeGetLocal(LAST_ORIGIN_KEY)
  },

  getLastDestination(): string | null {
    return safeGetLocal(LAST_DESTINATION_KEY)
  },

  hasSearchedBefore(): boolean {
    return safeGetLocal(LAST_ORIGIN_KEY) !== null
  },
}