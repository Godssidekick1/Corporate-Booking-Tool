import { describe, it, expect } from 'vitest'
import { cabinLetter, cabinLabel, CABIN_LABELS } from './cabin'

// ── cabin ────────────────────────────────────────────────────────────────────
// Three vocabularies describe the same thing and none of them agree:
//
//   the UI            "Business"
//   the provider      PaxCabin, observed as "Economy"
//   commercial_rules  a single letter, constrained to 'Y'|'W'|'C'|'F'
//
// A rule carrying a cabin restriction compares its letter against whatever the
// flight reports. Passing the provider's WORD through raw compared 'Y' against
// 'ECONOMY', so every cabin-restricted rule failed to match, always, and
// silently. This module is the single place that conversion happens, and these
// tests are what stop it regressing.
// ─────────────────────────────────────────────────────────────────────────────

describe('cabinLetter', () => {
  it('maps the provider words to rule letters', () => {
    expect(cabinLetter('Economy')).toBe('Y')
    expect(cabinLetter('Premium Economy')).toBe('W')
    expect(cabinLetter('Business')).toBe('C')
    expect(cabinLetter('First')).toBe('F')
  })

  it('is case- and whitespace-insensitive', () => {
    expect(cabinLetter('ECONOMY')).toBe('Y')
    expect(cabinLetter('  business  ')).toBe('C')
  })

  it('passes a letter straight through', () => {
    // So a value already normalised is not re-mapped or lost.
    expect(cabinLetter('Y')).toBe('Y')
    expect(cabinLetter('c')).toBe('C')
  })

  it('returns null on anything unrecognised, so rules fail CLOSED', () => {
    // Applying a cabin-restricted rule to a cabin we could not identify is
    // worse than not applying it.
    expect(cabinLetter('Sleeper')).toBeNull()
    expect(cabinLetter('Z')).toBeNull()
    expect(cabinLetter('')).toBeNull()
    expect(cabinLetter(null)).toBeNull()
    expect(cabinLetter(undefined)).toBeNull()
    expect(cabinLetter('   ')).toBeNull()
  })

  it('round-trips every label it can produce', () => {
    // Guards the pairing between CABIN_LABELS and BY_WORD: a letter added to
    // one and not the other would break here.
    for (const [letter, label] of Object.entries(CABIN_LABELS)) {
      expect(cabinLetter(label)).toBe(letter)
    }
  })
})

describe('cabinLabel', () => {
  it('gives the word form for a known cabin', () => {
    expect(cabinLabel('Y')).toBe('Economy')
    expect(cabinLabel('C')).toBe('Business')
  })

  it('normalises a word to the canonical spelling', () => {
    expect(cabinLabel('business')).toBe('Business')
  })

  it('passes an unrecognised value through rather than blanking it', () => {
    // If the provider starts sending a cabin we have not seen, showing its own
    // word beats showing nothing.
    expect(cabinLabel('Sleeper')).toBe('Sleeper')
  })

  it('returns null only for genuinely absent input', () => {
    expect(cabinLabel(null)).toBeNull()
    expect(cabinLabel('')).toBeNull()
  })
})
