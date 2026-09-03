// ── Flight restriction specs ─────────────────────────────────────────────────
// A deal can be filed against every flight an airline operates, a handful of
// named flights, or a whole numbered series. One text field covers all three:
//
//   null / ''        every flight
//   "2134"           one flight
//   "138, 139"       a list
//   "800-899"        a range
//   "UK800-UK899, UK102"   carrier prefixes allowed, and checked
//
// The carrier prefix is optional because airlines write their deals both ways.
// Where it is present it is VALIDATED against the deal's own airline rather
// than ignored: "BA138" filed under a deal for AI is a typo somebody needs to
// hear about, and silently matching flight 138 on Air India would apply a
// British Airways fare to the wrong carrier.
//
// Unparseable fragments are dropped rather than throwing, matching parseRankSpec
// in the policy editor — these are parsed live as an admin types, and a
// half-finished "800-" must not blow up the field. validateFlightSpec is the
// separate, strict pass used on save.
// ─────────────────────────────────────────────────────────────────────────────

export interface FlightRange {
  from: number
  to: number
}

// A flight number is 1-4 digits, optionally prefixed by the 2-character IATA
// carrier code (which may itself contain a digit, as in 6E).
const FLIGHT = /^([A-Z0-9]{2})?\s*(\d{1,4})$/i

function parseOne(chunk: string): { carrier: string | null; number: number } | null {
  const match = chunk.trim().match(FLIGHT)
  if (!match) return null

  const number = Number(match[2])
  if (!Number.isInteger(number) || number < 1) return null

  return { carrier: match[1]?.toUpperCase() ?? null, number }
}

// ── parseFlightSpec ──────────────────────────────────────────────────────────
// Text -> normalised, sorted, non-overlapping ranges. Overlaps are merged so
// "100-200, 150-250" and "100-250" produce the same matcher, which keeps
// specificity comparisons (below) honest.
// ─────────────────────────────────────────────────────────────────────────────
export function parseFlightSpec(spec: string | null | undefined): FlightRange[] {
  if (!spec?.trim()) return []

  const ranges: FlightRange[] = []

  for (const chunk of spec.split(',')) {
    if (!chunk.trim()) continue

    // en/em dashes too: these get pasted out of airline emails and Word docs.
    const parts = chunk.split(/[-–—]/)

    if (parts.length === 2) {
      const from = parseOne(parts[0])
      const to = parseOne(parts[1])
      if (!from || !to || from.number > to.number) continue
      ranges.push({ from: from.number, to: to.number })
      continue
    }

    const single = parseOne(chunk)
    if (single) ranges.push({ from: single.number, to: single.number })
  }

  if (ranges.length === 0) return []

  ranges.sort((a, b) => a.from - b.from || a.to - b.to)

  const merged: FlightRange[] = [ranges[0]]
  for (const range of ranges.slice(1)) {
    const last = merged[merged.length - 1]
    // +1 so 100-199 and 200-299 collapse into one contiguous 100-299 rather
    // than staying adjacent-but-separate.
    if (range.from <= last.to + 1) last.to = Math.max(last.to, range.to)
    else merged.push({ ...range })
  }

  return merged
}

// ── validateFlightSpec ───────────────────────────────────────────────────────
// The strict pass, for save. Returns an error string or null.
// ─────────────────────────────────────────────────────────────────────────────
export function validateFlightSpec(
  spec: string | null | undefined,
  airlineCode: string
): string | null {
  if (!spec?.trim()) return null

  const carrier = airlineCode.trim().toUpperCase()

  for (const chunk of spec.split(',')) {
    if (!chunk.trim()) continue

    const parts = chunk.split(/[-–—]/)
    if (parts.length > 2) {
      return `"${chunk.trim()}" is not a flight number or range`
    }

    const parsed = parts.map(parseOne)
    if (parsed.some(p => p === null)) {
      return `"${chunk.trim()}" is not a flight number or range`
    }

    for (const part of parsed) {
      if (part!.carrier && part!.carrier !== carrier) {
        return `"${chunk.trim()}" is for ${part!.carrier}, but this deal is for ${carrier}`
      }
    }

    if (parts.length === 2 && parsed[0]!.number > parsed[1]!.number) {
      return `"${chunk.trim()}" runs backwards`
    }
  }

  return null
}

// ── matchesFlight ────────────────────────────────────────────────────────────
// An empty spec means "any flight" and matches everything — that is the whole
// point of storing null instead of the literal "ALL".
// ─────────────────────────────────────────────────────────────────────────────
export function matchesFlight(spec: string | null | undefined, flightNumber: string | number | null): boolean {
  const ranges = parseFlightSpec(spec)
  if (ranges.length === 0) return true
  if (flightNumber === null || flightNumber === undefined) return false

  const parsed = parseOne(String(flightNumber))
  if (!parsed) return false

  return ranges.some(r => parsed.number >= r.from && parsed.number <= r.to)
}

// How many flight numbers a spec covers. Used only as a tie-break in the
// resolver: between two otherwise equal deals, the one filed against a tighter
// set of flights is the more specific and should win.
//
// An unrestricted spec covers everything, so it is reported as Infinity rather
// than 0 — 0 would sort as the MOST specific and invert the rule.
export function flightSpecBreadth(spec: string | null | undefined): number {
  const ranges = parseFlightSpec(spec)
  if (ranges.length === 0) return Number.POSITIVE_INFINITY
  return ranges.reduce((total, r) => total + (r.to - r.from + 1), 0)
}

// Renders a spec back for display, normalised: "UK800-UK899, 138" reads
// "800-899, 138". Kept here so the list, the editor and the CSV export cannot
// each format it slightly differently.
export function formatFlightSpec(spec: string | null | undefined): string {
  const ranges = parseFlightSpec(spec)
  if (ranges.length === 0) return 'Any'
  return ranges.map(r => (r.from === r.to ? String(r.from) : `${r.from}-${r.to}`)).join(', ')
}
