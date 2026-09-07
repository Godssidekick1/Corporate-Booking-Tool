// ── RBD specs ────────────────────────────────────────────────────────────────
// An RBD (Reservation Booking Designator) is the single letter identifying the
// fare bucket on a ticket: Y/B/M/H/Q/K/L in economy, C/D/J in business, F/A in
// first. It is NOT the cabin — one cabin holds many RBDs at very different
// prices and rules, which is exactly why a payment rule keys on it.
//
// NO RANGES, unlike the flight-number spec next door. RBD letters have no
// ordering: "B-M" would have to mean B, C, D… L, M, which sweeps in classes
// nobody intended. A spec is a plain comma-separated list.
//
// Unparseable fragments are dropped rather than throwing, matching parseRankSpec
// and parseFlightSpec — these are parsed live as an admin types, and a trailing
// comma must not blow up the field. validateRbdSpec is the strict pass on save.
// ─────────────────────────────────────────────────────────────────────────────

// Split on commas, spaces or slashes: airlines write these three ways and
// somebody will paste any of them.
const SEPARATORS = /[,\s/]+/

export function parseRbdSpec(spec: string | null | undefined): string[] {
  if (!spec?.trim()) return []

  const seen = new Set<string>()
  for (const chunk of spec.toUpperCase().split(SEPARATORS)) {
    const letter = chunk.trim()
    if (/^[A-Z]$/.test(letter)) seen.add(letter)
  }

  return [...seen].sort()
}

export function validateRbdSpec(spec: string | null | undefined): string | null {
  if (!spec?.trim()) return null

  for (const chunk of spec.toUpperCase().split(SEPARATORS)) {
    const letter = chunk.trim()
    if (!letter) continue
    if (!/^[A-Z]$/.test(letter)) {
      return `"${chunk.trim()}" is not a booking class — each one is a single letter, like "Y, B, M".`
    }
  }

  if (parseRbdSpec(spec).length === 0) {
    return 'Enter at least one booking class, or leave this blank for any.'
  }

  return null
}

// ── matchesAllLegs ───────────────────────────────────────────────────────────
// EVERY leg must be in the set, not just the first.
//
// This is the whole reason per-leg booking codes were captured. A card an
// airline refuses in L class must not be applied to a DEL-BOM-DXB itinerary
// because the first hop happened to be in Y.
//
// An empty spec means "any class" and matches everything — that is the point of
// storing null rather than a list of every letter.
//
// A leg whose booking code is missing cannot be shown to be in the set, so a
// restricted spec fails closed. For a payment rule that is the right direction:
// falling back to the default form of payment is recoverable, applying a card
// the airline rejects is not.
// ─────────────────────────────────────────────────────────────────────────────
export function matchesAllLegs(
  spec: string | null | undefined,
  legBookingCodes: (string | null | undefined)[]
): boolean {
  const allowed = parseRbdSpec(spec)
  if (allowed.length === 0) return true
  if (legBookingCodes.length === 0) return false

  return legBookingCodes.every(code => {
    const letter = code?.trim().toUpperCase()
    return Boolean(letter) && allowed.includes(letter!)
  })
}

// How many classes a spec covers, for the resolver's tie-break: between two
// otherwise equal rules, the one filed against fewer classes is the more
// specific and wins.
//
// An unrestricted spec is Infinity rather than 0 — 0 would sort as the MOST
// specific and invert the rule.
export function rbdSpecBreadth(spec: string | null | undefined): number {
  const parsed = parseRbdSpec(spec)
  return parsed.length === 0 ? Number.POSITIVE_INFINITY : parsed.length
}

// Normalised for display, so the list, the editor and any export cannot each
// format it differently. "y/b , m" reads "B, M, Y".
export function formatRbdSpec(spec: string | null | undefined): string {
  const parsed = parseRbdSpec(spec)
  return parsed.length === 0 ? 'Any class' : parsed.join(', ')
}
