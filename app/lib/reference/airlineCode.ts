// ── Airline code ─────────────────────────────────────────────────────────────
// One definition of what a valid airline code looks like.
//
// This regex previously existed in three places — deal-codes/route.ts,
// forms-of-payment/route.ts and deal-codes/csv/route.ts — which is two places
// too many for a rule that decides whether a commercial instrument saves.
//
// IT IS A SHAPE CHECK, NOT A LOOKUP, AND THAT IS DELIBERATE.
// The `airlines` table exists and could be checked against. It must not be:
// it is harvested from search responses, so a carrier nobody has searched yet is
// legitimately absent. Gating on it would make the first deal code for a new
// airline impossible — you could not configure it until it had been flown, and
// nobody would fly it until it was configured.
//
// So this accepts any two alphanumerics. "ZZ" saves. That is the correct
// trade-off: the picker makes the right code easy, and the validator refuses
// only what cannot be an airline code at all.
// ─────────────────────────────────────────────────────────────────────────────

export const AIRLINE_CODE_PATTERN = /^[A-Z0-9]{2}$/

// Canonical form: trimmed and uppercased. Callers store this rather than raw
// input, so a lowercase "ai" and an "AI " both become "AI" and match each other.
export function normaliseAirlineCode(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toUpperCase()
  return trimmed ? trimmed : null
}

// Returns an error message, or null when the value is acceptable. Same shape as
// validateRbdSpec, so route validators read consistently.
//
// An empty value is VALID: on a form of payment a blank airline means "all
// airlines". Callers that genuinely require one check for presence themselves.
export function validateAirlineCode(value: string | null | undefined): string | null {
  const code = normaliseAirlineCode(value)
  if (!code) return null

  if (!AIRLINE_CODE_PATTERN.test(code)) {
    return `"${value}" is not a two-character airline code.`
  }

  return null
}
