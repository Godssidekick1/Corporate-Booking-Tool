// ── mostSeniorBand ───────────────────────────────────────────────────────────
// The band a client's own admin goes on. Defined as the highest rank rather
// than a literal code: a client names its own bands ("A1", "C", "Band 3"), so
// there is no fixed code like 'L5' to look for, and a lookup by code silently
// returns undefined.
//
// There is no default band ladder any more. The only flow that used one --
// self-registration, where a company signed itself up with no TMC to define
// its bands -- has been removed; every client's bands are defined by its TMC.
// ─────────────────────────────────────────────────────────────────────────────

export function mostSeniorBand<T extends { rank: number }>(bands: T[]): T | null {
  if (bands.length === 0) return null
  return bands.reduce((highest, b) => (b.rank > highest.rank ? b : highest), bands[0])
}
