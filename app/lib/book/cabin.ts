// ── Cabin vocabulary ─────────────────────────────────────────────────────────
// Three systems name the same four cabins three different ways, and until this
// module existed they were compared directly against each other:
//
//   The UI       "Economy" | "Premium Economy" | "Business" | "First"
//   The provider PaxCabin, a WORD: "Economy"       — and PreferredClass on the way in
//   Our rules    commercial_rules.cabin, a LETTER: 'Y' | 'W' | 'C' | 'F'
//
// THE BUG THIS FIXES. resolveCommercials compared a rule's cabin against the
// flight's, which is PaxCabin — so it tested 'Y' !== 'ECONOMY' and every
// commercial rule carrying a cabin restriction failed to match. Not "matched
// rarely": never, since the two vocabularies have no value in common. A markup
// or fee filed for economy has never once been applied.
//
// One module converts, so there is a single place to be right about it.
// ─────────────────────────────────────────────────────────────────────────────

export type CabinLetter = 'Y' | 'W' | 'C' | 'F'

export const CABIN_LABELS: Record<CabinLetter, string> = {
  Y: 'Economy',
  W: 'Premium Economy',
  C: 'Business',
  F: 'First',
}

// Every spelling seen or plausible, lowercased. The provider has only ever been
// observed sending "Economy", but a list that covers the obvious neighbours
// costs nothing and fails better than a lookup that returns null on "ECONOMY ".
const BY_WORD: Record<string, CabinLetter> = {
  'economy': 'Y',
  'eco': 'Y',
  'coach': 'Y',
  'premium economy': 'W',
  'premiumeconomy': 'W',
  'premium': 'W',
  'business': 'C',
  'business class': 'C',
  'first': 'F',
  'first class': 'F',
}

// ── cabinLetter ──────────────────────────────────────────────────────────────
// Anything the provider or the UI calls a cabin → the letter our rules store.
//
// Returns null rather than guessing when the value is unrecognised. A rule with
// a cabin restriction then simply does not match, which is the same fail-closed
// direction the RBD spec takes: applying a cabin-restricted rule to a cabin we
// could not identify is worse than not applying it.
export function cabinLetter(value: string | null | undefined): CabinLetter | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null

  // Already a letter — 'Y', 'w', etc.
  const upper = trimmed.toUpperCase()
  if (upper.length === 1 && upper in CABIN_LABELS) return upper as CabinLetter

  return BY_WORD[trimmed.toLowerCase()] ?? null
}

// The word form, for a request field that wants one and for display. Passes an
// unrecognised value through unchanged rather than blanking it — if the provider
// starts sending a cabin we have not seen, showing its own word is better than
// showing nothing.
export function cabinLabel(value: string | null | undefined): string | null {
  if (!value) return null
  const letter = cabinLetter(value)
  return letter ? CABIN_LABELS[letter] : value
}
