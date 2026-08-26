import type { BandInput } from './onboardCompany'

// ── DEFAULT_BANDS ────────────────────────────────────────────────────────────
// The fallback band ladder, used only by self-registration
// (/api/auth/register-company), where a company signs itself up with no TMC
// attached. There is nobody to define bands in that flow, and a company with
// no bands can't have employees, so it needs a starting point.
//
// TMC-created clients do NOT use this — the TMC defines its client's bands
// explicitly at creation, because a client's band vocabulary is its own
// ("A1", "C", "Band 3") and forcing L1..L5 on everyone was the thing that made
// the policy model feel hardcoded.
//
// Deliberately one shared constant rather than an inline array at each call
// site: the previous copies had already drifted from each other in how the
// most-senior band was identified.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_BANDS: BandInput[] = [
  { code: 'L1', label: 'Junior',    rank: 1 },
  { code: 'L2', label: 'Associate', rank: 2 },
  { code: 'L3', label: 'Senior',    rank: 3 },
  { code: 'L4', label: 'Manager',   rank: 4 },
  { code: 'L5', label: 'Director',  rank: 5 },
]

// ── mostSeniorBand ───────────────────────────────────────────────────────────
// The band a company's own admin goes on. Defined as the highest rank rather
// than a literal code: once a client names its own bands there is no 'L5' to
// look for, and a lookup by code silently returns undefined.
// ─────────────────────────────────────────────────────────────────────────────

export function mostSeniorBand<T extends { rank: number }>(bands: T[]): T | null {
  if (bands.length === 0) return null
  return bands.reduce((highest, b) => (b.rank > highest.rank ? b : highest), bands[0])
}
